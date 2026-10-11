"use client";

import { useState } from "react";
import { NaryxApiError, NaryxClient, stressPortfolio, type NormalizedPosition } from "@naryx/sdk";
import { formatAtomicAmount } from "../format";
import type { PortfolioIntelligenceRow } from "./use-portfolio-intelligence";
import styles from "./pages.module.css";

const SIGNED_PERCENT = /^-?(?:0|[1-9][0-9]{0,2})$/;
const POSITIVE_PERCENT = /^(?:100|[1-9][0-9]{2}|1000)$/;
const WHOLE_PERCENT = /^(?:0|[1-9][0-9]?|100)$/;
const CERTAIN_EVIDENCE_MS = BigInt(300_000);

type DeRiskStep = Readonly<{ key: string; title: string; detail: string }>;

function deRiskSteps(actions: readonly unknown[], positions: readonly NormalizedPosition[]): readonly DeRiskStep[] {
  return actions.map((raw, index) => {
    const action = raw as Record<string, unknown> | null;
    const key = `${index}`;
    if (action?.kind === "ENTER_REDUCE_ONLY") return { key, title: "Enter reduce-only", detail: "No risk-increasing order is admitted afterward." };
    if (action?.kind === "LOCK_FOR_MANUAL_RECOVERY" && typeof action.reason === "string") {
      return { key, title: "Lock for manual recovery", detail: action.reason };
    }
    if (action?.kind === "CANCEL_RISK_INCREASING_ORDER" && typeof action.orderId === "string") {
      return { key, title: "Cancel risk-increasing order", detail: action.orderId };
    }
    if (action?.kind === "REDUCE_LEGS" && (action.mode === "ATOMIC_PAIRED" || action.mode === "BOUNDED_PAIRED_UNWIND") && Array.isArray(action.reductions)) {
      const legs = action.reductions.map((entry) => {
        const reduction = entry as Record<string, unknown> | null;
        const position = positions.find((candidate) => candidate.snapshotId === reduction?.snapshotId);
        if (position === undefined || typeof reduction?.reduceBaseAtoms !== "bigint") throw new Error("The de-risk plan names a leg this view does not hold.");
        const base = position.markPrice.baseAsset;
        return `${position.venueId} ${position.marketId} ${formatAtomicAmount(reduction.reduceBaseAtoms, base.decimals, base.assetId.toUpperCase())}`;
      });
      return { key, title: action.mode === "ATOMIC_PAIRED" ? "Reduce legs together (atomic group)" : "Reduce legs in a bounded paired unwind", detail: legs.join("; ") };
    }
    throw new Error("The de-risk plan contains an action this terminal does not recognize, so it is not shown.");
  });
}

function short(value: string): string {
  return value.length > 24 ? `${value.slice(0, 14)}...${value.slice(-7)}` : value;
}

export function PortfolioScenarioLab({ rows, baseUrl }: { rows: readonly PortfolioIntelligenceRow[]; baseUrl: string | null }) {
  const withRisk = rows.filter((row) => row.scenarioGroups.length > 0);
  const [strategyId, setStrategyId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [priceShockPercent, setPriceShockPercent] = useState("-20");
  const [closeCostPercent, setCloseCostPercent] = useState("200");
  const [failedDependencies, setFailedDependencies] = useState<readonly string[]>([]);
  const [triggerPercent, setTriggerPercent] = useState("10");
  const [reductionPercent, setReductionPercent] = useState("25");
  const [deRisk, setDeRisk] = useState<Readonly<{ strategyId: string; steps: readonly DeRiskStep[] }> | null>(null);
  const [deRiskBusy, setDeRiskBusy] = useState(false);
  const [deRiskError, setDeRiskError] = useState<string | null>(null);
  const selected = withRisk.find((row) => row.strategyId === strategyId) ?? withRisk[0] ?? null;
  const group = selected?.scenarioGroups.find((candidate) => candidate.accountingAsset.assetId === assetId)
    ?? selected?.scenarioGroups[0] ?? null;
  const validShock = SIGNED_PERCENT.test(priceShockPercent)
    && Number(priceShockPercent) > -100 && Number(priceShockPercent) <= 500;
  const validCloseCost = POSITIVE_PERCENT.test(closeCostPercent)
    && Number(closeCostPercent) >= 100 && Number(closeCostPercent) <= 1000;
  const result = (() => {
    if (group === null || !validShock || !validCloseCost) return null;
    const shockBps = BigInt(priceShockPercent) * BigInt(100);
    return stressPortfolio(group.positions, {
      scenarioId: "terminal-custom-stress",
      priceShocksBps: group.underlyingIds.map((underlyingId) => ({ underlyingId, shockBps })),
      closeCostMultiplierBps: BigInt(closeCostPercent) * BigInt(100),
      failedDependencyIds: failedDependencies.filter((dependency) => group.dependencyIds.includes(dependency)),
    }, group.accountingAsset);
  })();

  const validTrigger = WHOLE_PERCENT.test(triggerPercent);
  const validReduction = WHOLE_PERCENT.test(reductionPercent) && reductionPercent !== "0";
  // Fresh signed evidence is the only certainty the terminal can attest; anything else asks the planner to lock.
  const stateCertain = selected !== null && selected.riskStatus === "observed"
    && selected.positionAgeMs !== null && selected.positionAgeMs <= CERTAIN_EVIDENCE_MS;

  const validateDeRisk = async () => {
    if (baseUrl === null || selected === null || !validTrigger || !validReduction) return;
    setDeRiskBusy(true);
    setDeRiskError(null);
    setDeRisk(null);
    try {
      const actions = await new NaryxClient({ baseUrl }).validateDeRisk({
        positions: selected.positions,
        policy: { triggerLiquidationDistanceBps: BigInt(triggerPercent) * BigInt(100), reductionBps: BigInt(reductionPercent) * BigInt(100) },
        stateCertain,
      });
      setDeRisk({ strategyId: selected.strategyId, steps: deRiskSteps(actions, selected.positions) });
    } catch (error) {
      setDeRiskError(error instanceof NaryxApiError && error.status === 503
        ? "This service does not validate de-risk plans."
        : error instanceof Error ? error.message : "De-risk validation failed.");
    } finally {
      setDeRiskBusy(false);
    }
  };

  if (withRisk.length === 0) return null;
  const symbol = group?.accountingAsset.assetId.toUpperCase() ?? "QUOTE";
  const decimals = group?.accountingAsset.decimals ?? 0;

  return (
    <section className={styles.card} aria-labelledby="scenario-lab-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="scenario-lab-title">Portfolio scenario lab</h2>
          <p>Replay custom price, liquidity, and dependency shocks against locally verified position snapshots.</p>
        </div>
        <span className={styles.pillWarn}>Modeled, not executable</span>
      </div>
      <div className={`${styles.cardBody} ${styles.scenarioGrid}`}>
        <label className={styles.field}>
          <span>Strategy account</span>
          <select value={selected?.strategyId ?? ""} onChange={(event) => { setStrategyId(event.target.value); setAssetId(""); setFailedDependencies([]); }}>
            {withRisk.map((row) => <option key={row.strategyId} value={row.strategyId}>{short(row.strategyId)}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>Accounting asset</span>
          <select value={group?.accountingAsset.assetId ?? ""} onChange={(event) => { setAssetId(event.target.value); setFailedDependencies([]); }}>
            {selected?.scenarioGroups.map((candidate) => <option key={candidate.accountingAsset.assetId} value={candidate.accountingAsset.assetId}>{candidate.accountingAsset.assetId.toUpperCase()}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>Uniform price shock (%)</span>
          <input inputMode="numeric" value={priceShockPercent} onChange={(event) => setPriceShockPercent(event.target.value)} aria-invalid={!validShock} />
        </label>
        <label className={styles.field}>
          <span>Close-cost multiplier (%)</span>
          <input inputMode="numeric" value={closeCostPercent} onChange={(event) => setCloseCostPercent(event.target.value)} aria-invalid={!validCloseCost} />
        </label>
        {group && group.dependencyIds.length > 0 ? (
          <fieldset className={styles.scenarioDependencies}>
            <legend>Failed dependencies</legend>
            {group.dependencyIds.map((dependency) => (
              <label key={dependency}>
                <input
                  type="checkbox"
                  checked={failedDependencies.includes(dependency)}
                  onChange={(event) => setFailedDependencies(event.target.checked
                    ? [...failedDependencies, dependency]
                    : failedDependencies.filter((candidate) => candidate !== dependency))}
                />
                {dependency}
              </label>
            ))}
          </fieldset>
        ) : null}
      </div>
      {result ? (
        <div className={styles.scenarioResults}>
          <div><span>Marked PnL</span><strong>{formatAtomicAmount(result.markPnlQuoteAtoms, decimals, symbol)}</strong></div>
          <div><span>Stressed close cost</span><strong>{formatAtomicAmount(result.stressedCloseCostQuoteAtoms, decimals, symbol)}</strong></div>
          <div><span>Modeled loss</span><strong>{formatAtomicAmount(result.lossQuoteAtoms, decimals, symbol)}</strong></div>
          <div><span>Unclosable positions</span><strong>{result.unclosableSnapshotIds.length}</strong></div>
          <div className={styles.scenarioWide}>
            <span>Risk-domain attribution</span>
            <strong>{result.pnlByRiskDomain.map((domain) => `${domain.riskDomainId}: ${formatAtomicAmount(domain.pnlQuoteAtoms, decimals, symbol)}`).join("; ") || "No marked exposure"}</strong>
          </div>
        </div>
      ) : (
        <p className={styles.noticeError}>Price shock must be greater than -100% and at most 500%. Close cost must be 100% to 1,000%.</p>
      )}
      {baseUrl !== null && selected !== null ? (
        <div className={`${styles.cardBody} ${styles.lifecycleForm}`}>
          <div className={styles.subhead}>
            <h3>Coordinated de-risk plan</h3>
            <p>The server plans pre-authorized risk reduction for this strategy&apos;s verified positions. The plan is advisory: nothing is signed or submitted.</p>
          </div>
          <div className={styles.scenarioGrid}>
            <label className={styles.field}>
              <span>Trigger: liquidation distance below (%)</span>
              <input inputMode="numeric" value={triggerPercent} onChange={(event) => { setTriggerPercent(event.target.value); setDeRisk(null); }} aria-invalid={!validTrigger} />
            </label>
            <label className={styles.field}>
              <span>Reduce linked legs by (%)</span>
              <input inputMode="numeric" value={reductionPercent} onChange={(event) => { setReductionPercent(event.target.value); setDeRisk(null); }} aria-invalid={!validReduction} />
            </label>
          </div>
          <div className={styles.lifecycleActions}>
            <p>{stateCertain
              ? "Position evidence is signed and under five minutes old, so it is sent as certain state."
              : "Position evidence is missing or older than five minutes, so it is sent as uncertain and the planner can only lock for manual recovery."}{" "}
              Open risk-increasing orders are not known to this page and are not included.</p>
            <button type="button" className={styles.ghost} disabled={deRiskBusy || !validTrigger || !validReduction} onClick={() => void validateDeRisk()}>
              {deRiskBusy ? "Validating" : "Validate de-risk plan"}
            </button>
          </div>
          {!validTrigger || !validReduction ? <p className={styles.noticeError}>Trigger must be 0% to 100% and reduction 1% to 100%, in whole percent.</p> : null}
          {deRiskError ? <p className={styles.noticeError} role="status">{deRiskError}</p> : null}
          {deRisk !== null && deRisk.strategyId === selected.strategyId ? (
            deRisk.steps.length === 0
              ? <p className={styles.noticeOk} role="status">No action: no leg is within the trigger distance of liquidation.</p>
              : (
                <ol className={styles.deRiskSteps} aria-label="Advisory de-risk plan">
                  {deRisk.steps.map((step) => <li key={step.key}><strong>{step.title}</strong> <span>{step.detail}</span></li>)}
                </ol>
              )
          ) : null}
          <p className={styles.evidenceNote}>Portfolio optimization ranks solver route candidates for this account. The terminal does not receive candidate routes yet, so it cannot request an optimization here.</p>
        </div>
      ) : null}
    </section>
  );
}
