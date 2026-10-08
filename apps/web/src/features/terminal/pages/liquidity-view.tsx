"use client";

import { useCallback, useEffect, useState } from "react";
import { useTerminal } from "../shell/terminal-context";
import type {
  MakerOperationsSnapshot,
  MakerShardView,
} from "../private-http-terminal-provider";
import styles from "./pages.module.css";

type LoadState = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  snapshot: MakerOperationsSnapshot | null;
}>;

function number(value: bigint): string {
  return value.toLocaleString("en-US");
}

function percent(value: bigint): string {
  const whole = value / BigInt(100);
  const fraction = value % BigInt(100);
  return `${whole}.${fraction.toString().padStart(2, "0")}%`;
}

function statusClass(state: MakerShardView["state"] | "ACTIVE" | "REDUCE_ONLY"): string {
  if (state === "LIVE" || state === "ACTIVE") return styles.pillOk;
  if (state === "EMPTY") return styles.pill;
  return state === "REDUCE_ONLY" || state === "HEARTBEAT_EXPIRED" || state === "CAPACITY_EXHAUSTED"
    ? styles.pillWarn
    : styles.pillBad;
}

function short(value: string): string {
  return value.length > 24 ? `${value.slice(0, 14)}...${value.slice(-6)}` : value;
}

export function LiquidityView() {
  const { privateProvider } = useTerminal();
  const [request, setRequest] = useState(0);
  const [load, setLoad] = useState<LoadState>({ status: "idle", snapshot: null });
  const refresh = useCallback(() => {
    setLoad((current) => ({ status: "loading", snapshot: current.snapshot }));
    setRequest((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!privateProvider) return;
    const controller = new AbortController();
    privateProvider.getMakerOperations(controller.signal)
      .then((snapshot) => setLoad({ status: "ready", snapshot }))
      .catch(() => {
        if (!controller.signal.aborted) setLoad((current) => ({ status: "error", snapshot: current.snapshot }));
      });
    return () => controller.abort();
  }, [privateProvider, request]);

  const snapshot = load.snapshot;
  const levels = snapshot?.shards.flatMap((shard) => shard.quoteLevels.map((level) => ({ shard, level }))) ?? [];
  const loading = load.status === "idle" || load.status === "loading";
  const unavailable = privateProvider === null || load.status === "error";

  return (
    <main className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1>Liquidity operations</h1>
          <p>Current signed quote shards, firm inventory utilization, fills, and capacity evidence for the configured Naryx solver.</p>
        </div>
        <div className={styles.headActions}>
          <button type="button" className={styles.ghost} onClick={refresh} disabled={loading || privateProvider === null}>
            {privateProvider === null ? "Unavailable" : loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {snapshot ? (
        <section className={styles.summary} aria-label="Maker summary">
          <div><span>Live quote shards</span><strong>{snapshot.summary.liveShardCount}/{snapshot.summary.shardCount}</strong><small>{snapshot.solverId}</small></div>
          <div><span>Quoted levels</span><strong>{snapshot.summary.quotedLevelCount}</strong><small>Signed package bids and asks</small></div>
          <div><span>Active capacity scopes</span><strong>{snapshot.summary.activeCapacityScopeCount}/{snapshot.summary.capacityScopeCount}</strong><small>Fresh capital evidence</small></div>
          <div><span>Operational alerts</span><strong>{snapshot.summary.alertCount}</strong><small>Shard and capacity controls</small></div>
        </section>
      ) : null}

      {unavailable && !snapshot ? (
        <section className={styles.card}>
          <div className={styles.empty}>
            <strong>Maker operations are not configured</strong>
            <p>Enable the solver API and bind NARYX_MAKER_SOLVER_ID in the private service. No signing key is exposed to this browser.</p>
          </div>
        </section>
      ) : null}

      {snapshot ? (
        <>
          <section className={styles.card} aria-labelledby="quote-shards-title">
            <div className={styles.cardHead}>
              <h2 id="quote-shards-title">Quote shards</h2>
              <p>One independently sequenced market-maker book per strategy market.</p>
              <span className={styles.pill}>As of {snapshot.asOfValue.toString()}</span>
            </div>
            <div className={styles.scroll}>
              <table className={styles.table}>
                <thead><tr><th>Market</th><th>Domain</th><th>Status</th><th className={styles.num}>Levels</th><th className={styles.num}>Utilization</th><th className={styles.num}>Current fills</th><th className={styles.num}>Sequence</th></tr></thead>
                <tbody>
                  {snapshot.shards.map((shard) => (
                    <tr key={shard.shardHash}>
                      <td><span className={styles.cellStack}><strong>{shard.marketGroupId}</strong><small className={styles.cellDetail}>{shard.templateId}</small></span></td>
                      <td><span className={styles.cellStack}><span>{shard.domainId}</span><small className={styles.cellDetail}>{shard.environment}</small></span></td>
                      <td><span className={statusClass(shard.state)}>{shard.state.replaceAll("_", " ")}</span></td>
                      <td className={styles.num}>{shard.activeQuoteLevelCount}<small className={styles.cellDetail}>{shard.quoteLevels.length} signed</small></td>
                      <td className={styles.num} title={`${number(shard.reservedCapacity)} reserved of ${number(shard.inventoryCap)}`}>{percent(shard.utilizationBps)}</td>
                      <td className={styles.num}>{shard.fillCount}<small className={styles.cellDetail}>{number(shard.filledSize)} units</small></td>
                      <td className={styles.num}>{shard.shardSequence.toString()}<small className={styles.cellDetail}>ref {shard.referenceSequence.toString()}</small></td>
                    </tr>
                  ))}
                  {snapshot.shards.length === 0 ? <tr><td colSpan={7}><div className={styles.empty}><strong>No quote shards</strong><p>This solver has not published a package market yet.</p></div></td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="quote-ladders-title">
            <div className={styles.cardHead}>
              <h2 id="quote-ladders-title">Quote ladders</h2>
              <p>Parametric levels priced as signed offsets from each shard reference.</p>
            </div>
            <div className={styles.scroll}>
              <table className={styles.table}>
                <thead><tr><th>Market</th><th>Side</th><th className={styles.num}>Size</th><th className={styles.num}>Reference offset</th><th className={styles.num}>Maximum fee</th><th>Firmness</th><th>Reservation</th></tr></thead>
                <tbody>
                  {levels.map(({ shard, level }) => (
                    <tr key={`${shard.shardHash}:${level.levelId}`}>
                      <td>{shard.marketGroupId}<small className={styles.cellDetail}>level {level.levelId.toString()}</small></td>
                      <td><span className={level.direction === "BID" ? styles.pillOk : styles.pillWarn}>{level.direction}</span></td>
                      <td className={styles.num}>{number(level.size)}</td>
                      <td className={styles.num}>{level.referenceOffset > BigInt(0) ? "+" : ""}{number(level.referenceOffset)}</td>
                      <td className={styles.num}>{number(level.maximumFee)}</td>
                      <td>{level.quoteMode}<small className={styles.cellDetail}>{level.settlementClass}</small></td>
                      <td>{level.reservationPolicy}<small className={styles.cellDetail}>until {level.validUntilValue.toString()}</small></td>
                    </tr>
                  ))}
                  {levels.length === 0 ? <tr><td colSpan={7}><div className={styles.empty}><strong>No active levels</strong><p>Publish a signed quote shard to populate the ladder.</p></div></td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="capacity-title">
            <div className={styles.cardHead}>
              <h2 id="capacity-title">Capital and recovery capacity</h2>
              <p>Evidence-backed limits after outstanding firm commitments.</p>
            </div>
            <div className={styles.scroll}>
              <table className={styles.table}>
                <thead><tr><th>Scope</th><th>Asset</th><th>Status</th><th className={styles.num}>Available</th><th className={styles.num}>Committed</th><th className={styles.num}>Remaining</th><th>Evidence</th></tr></thead>
                <tbody>
                  {snapshot.capacities.map((capacity) => (
                    <tr key={capacity.scope}>
                      <td className={styles.mono} title={capacity.scope}>{short(capacity.scope)}<small className={styles.cellDetail}>{capacity.domainId}</small></td>
                      <td>{capacity.assetId}<small className={styles.cellDetail}>{capacity.decimals} decimals</small></td>
                      <td><span className={statusClass(capacity.state)}>{capacity.state.replaceAll("_", " ")}</span></td>
                      <td className={styles.num}>{number(capacity.availableAtoms)}</td>
                      <td className={styles.num}>{number(capacity.committedAtoms)}<small className={styles.cellDetail}>{number(capacity.committedRecoveryAtoms)} recovery</small></td>
                      <td className={styles.num}>{number(capacity.remainingAtoms)}</td>
                      <td>{capacity.evidenceGrade}<small className={styles.cellDetail}>until {capacity.expiresAtValue.toString()}</small></td>
                    </tr>
                  ))}
                  {snapshot.capacities.length === 0 ? <tr><td colSpan={7}><div className={styles.empty}><strong>No capacity evidence</strong><p>The solver cannot make evidence-backed firm commitments until it publishes a capacity record.</p></div></td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>

          <p className={styles.notice}>This surface is read only. Quote and capacity signatures stay in the solver process, and operational changes continue through the authenticated solver API.</p>
        </>
      ) : null}
    </main>
  );
}
