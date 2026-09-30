"use client";

import { useEffect, useState } from "react";
import styles from "./pro.module.css";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Row = {
  readonly solverId: string;
  readonly eligibleOrders: number;
  readonly quotedOrders: number;
  readonly coverageBps: number;
  readonly latencyMs?: { readonly median: number; readonly p95: number };
  readonly outcomes: number;
  readonly settledBps: number;
  readonly fadeBps: number;
  readonly recoveredBps: number;
  readonly improvementMedianBps?: number;
  readonly improvementMeasured: number;
  readonly evidence: string;
};

function decode(value: Json): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    if (value.$naryxType === "bigint" && typeof value.value === "string") return value.value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]));
  }
  return value;
}

async function read(base: string, path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, { headers: { Accept: "application/json" }, signal, cache: "no-store" });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return decode((await response.json()) as Json) as Record<string, unknown>;
}

/** The strongest evidence grade each receipt field reached, most common first. */
function evidenceSummary(value: unknown): string {
  if (typeof value !== "object" || value === null) return "-";
  const entries = Object.entries(value as Record<string, unknown>).filter(([, count]) => typeof count === "number" && count > 0) as [string, number][];
  if (entries.length === 0) return "No receipts";
  return entries.sort((left, right) => right[1] - left[1]).map(([grade, count]) => `${grade} ${count}`).join(", ");
}

function row(solverId: string, performance: Record<string, unknown>, quality: Record<string, unknown> | null): Row | null {
  if (performance.label !== "OBSERVED" || performance.solverId !== solverId) return null;
  const coverage = performance.coverage as { eligibleOrders?: unknown; quotedOrders?: unknown; coverageBps?: unknown } | undefined;
  const outcomes = performance.outcomes as { total?: unknown; settledBps?: unknown; fadeBps?: unknown; recoveredBps?: unknown } | undefined;
  if (coverage === undefined || outcomes === undefined || typeof coverage.eligibleOrders !== "number" || typeof outcomes.total !== "number") return null;
  const latency = performance.firstQuoteLatencyMs as { median?: unknown; p95?: unknown } | undefined;
  const improvement = performance.priceImprovementBps as { measured?: unknown; median?: unknown } | undefined;
  return {
    solverId,
    eligibleOrders: coverage.eligibleOrders,
    quotedOrders: Number(coverage.quotedOrders),
    coverageBps: Number(coverage.coverageBps),
    ...(typeof latency?.median === "number" && typeof latency.p95 === "number" ? { latencyMs: { median: latency.median, p95: latency.p95 } } : {}),
    outcomes: outcomes.total,
    settledBps: Number(outcomes.settledBps),
    fadeBps: Number(outcomes.fadeBps),
    recoveredBps: Number(outcomes.recoveredBps),
    ...(typeof improvement?.median === "number" ? { improvementMedianBps: improvement.median } : {}),
    improvementMeasured: typeof improvement?.measured === "number" ? improvement.measured : 0,
    evidence: quality === null ? "-" : evidenceSummary(quality.receiptFieldEvidence),
  };
}

const percent = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
const signedBps = (bps: number) => `${bps > 0 ? "+" : ""}${bps.toLocaleString("en-US")} bps`;

/**
 * Raw solver performance from the public API: coverage of eligible orders, first-quote latency,
 * what became of the orders each solver was selected for, and price improvement against its own
 * quotes, with the evidence grade its receipt fields reached. They are observed dimensions over
 * recorded records, never combined into a ranking or a reputation score.
 */
export function SolverMetrics({ publicApiBaseUrl }: { publicApiBaseUrl: string | null }) {
  const [state, setState] = useState<{ rows: Row[]; methodology: string } | { error: string } | null>(null);

  useEffect(() => {
    if (publicApiBaseUrl === null) return;
    const base = publicApiBaseUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    (async () => {
      try {
        const listed = await read(base, "/v1/solvers", controller.signal);
        const solvers = (Array.isArray(listed.solvers) ? listed.solvers : []) as Record<string, unknown>[];
        const ids = solvers.map((solver) => String(solver.solverId)).filter((id) => /^[A-Za-z0-9._:-]{1,128}$/.test(id)).slice(0, 50);
        const rows = await Promise.all(
          ids.map(async (id) => {
            const [performance, quality] = await Promise.all([
              read(base, `/v1/solvers/${encodeURIComponent(id)}/performance`, controller.signal),
              read(base, `/v1/analytics/execution-quality?solverId=${encodeURIComponent(id)}`, controller.signal).catch(() => null),
            ]);
            return { row: row(id, performance, quality), methodology: typeof performance.methodology === "string" ? performance.methodology : "" };
          }),
        );
        setState({
          rows: rows.map((entry) => entry.row).filter((entry): entry is Row => entry !== null),
          methodology: rows.find((entry) => entry.methodology !== "")?.methodology ?? "",
        });
      } catch (error) {
        if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : "request failed" });
      }
    })();
    return () => controller.abort();
  }, [publicApiBaseUrl]);

  if (publicApiBaseUrl === null) {
    return <p className={styles.metricsEmpty}>Configure the public market API to see record-derived solver performance. Nothing is shown without recorded orders and outcomes.</p>;
  }
  if (state === null) return <p className={styles.metricsEmpty}>Reading recorded solver performance.</p>;
  if ("error" in state) return <p className={styles.metricsEmpty}>Solver performance unavailable ({state.error}).</p>;
  return (
    <div className={styles.metricsTable}>
      <div className={styles.metricsHeader} role="row">
        <span role="columnheader">Solver</span>
        <span role="columnheader" title="Orders in the solver's supported domains that it quoted">Coverage</span>
        <span role="columnheader" title="From an order's receipt to the solver's first quote for it">First quote p50 / p95</span>
        <span role="columnheader" title="Terminal outcomes of orders the solver was selected for">Outcomes</span>
        <span role="columnheader" title="Outcomes with a successful receipt">Settled</span>
        <span role="columnheader" title="Selected orders that ended with no effect">Fade</span>
        <span role="columnheader" title="Outcomes that entered recovery">Recovered</span>
        <span role="columnheader" title="Settled spot amount against the solver's own quote, median">Improvement</span>
        <span className={styles.labelObserved}>OBSERVED</span>
      </div>
      {state.rows.length === 0 ? <p className={styles.metricsEmpty}>No registered solver has recorded performance yet.</p> : null}
      {state.rows.map((entry) => (
        <div key={entry.solverId} className={styles.metricsRow} role="row">
          <span role="cell" className={styles.metricsSolver}>
            <span>{entry.solverId}</span>
            <span className={styles.metricsEvidence} title="Receipt fields by their strongest evidence grade">{entry.evidence}</span>
          </span>
          <span role="cell" title={`${entry.quotedOrders} of ${entry.eligibleOrders} eligible orders`}>
            {entry.eligibleOrders === 0 ? "-" : percent(entry.coverageBps)}
          </span>
          <span role="cell">{entry.latencyMs === undefined ? "-" : `${entry.latencyMs.median.toLocaleString("en-US")} / ${entry.latencyMs.p95.toLocaleString("en-US")} ms`}</span>
          <span role="cell">{entry.outcomes.toLocaleString("en-US")}</span>
          <span role="cell">{entry.outcomes === 0 ? "-" : percent(entry.settledBps)}</span>
          <span role="cell" className={entry.fadeBps > 0 ? styles.metricsWarn : undefined}>{entry.outcomes === 0 ? "-" : percent(entry.fadeBps)}</span>
          <span role="cell">{entry.outcomes === 0 ? "-" : percent(entry.recoveredBps)}</span>
          <span role="cell" title={`${entry.improvementMeasured} settled receipts measured`}>
            {entry.improvementMedianBps === undefined ? "-" : signedBps(entry.improvementMedianBps)}
          </span>
        </div>
      ))}
      {state.methodology !== "" ? <p className={styles.metricsNote}>{state.methodology}</p> : null}
    </div>
  );
}
