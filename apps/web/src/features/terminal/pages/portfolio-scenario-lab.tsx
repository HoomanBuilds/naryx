"use client";

import { useState } from "react";
import { stressPortfolio } from "@naryx/sdk";
import { formatAtomicAmount } from "../format";
import type { PortfolioIntelligenceRow } from "./use-portfolio-intelligence";
import styles from "./pages.module.css";

const SIGNED_PERCENT = /^-?(?:0|[1-9][0-9]{0,2})$/;
const POSITIVE_PERCENT = /^(?:100|[1-9][0-9]{2}|1000)$/;

function short(value: string): string {
  return value.length > 24 ? `${value.slice(0, 14)}...${value.slice(-7)}` : value;
}

export function PortfolioScenarioLab({ rows }: { rows: readonly PortfolioIntelligenceRow[] }) {
  const withRisk = rows.filter((row) => row.scenarioGroups.length > 0);
  const [strategyId, setStrategyId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [priceShockPercent, setPriceShockPercent] = useState("-20");
  const [closeCostPercent, setCloseCostPercent] = useState("200");
  const [failedDependencies, setFailedDependencies] = useState<readonly string[]>([]);
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
    </section>
  );
}
