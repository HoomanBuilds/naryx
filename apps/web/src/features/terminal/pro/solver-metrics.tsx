"use client";

import { useEffect, useState } from "react";
import styles from "./pro.module.css";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Quality = {
  readonly solverId: string;
  readonly terminalOutcomes: number;
  readonly successfulBps: number;
  readonly recoveredBps: number;
  readonly medianUnhedgedMs?: string;
  readonly p95UnhedgedMs?: string;
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

function quality(solverId: string, body: Record<string, unknown>): Quality | null {
  if (body.label !== "OBSERVED" || typeof body.terminalOutcomes !== "number") return null;
  const unhedged = body.timeUnhedgedMs as { median?: string; p95?: string } | undefined;
  return {
    solverId,
    terminalOutcomes: body.terminalOutcomes,
    successfulBps: Number(body.successfulBps),
    recoveredBps: Number(body.recoveredBps),
    ...(unhedged?.median === undefined ? {} : { medianUnhedgedMs: unhedged.median }),
    ...(unhedged?.p95 === undefined ? {} : { p95UnhedgedMs: unhedged.p95 }),
    evidence: evidenceSummary(body.receiptFieldEvidence),
  };
}

const percent = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/**
 * Receipt-derived solver metrics from the public API: terminal outcomes, success and recovery
 * shares, and time unhedged, with the evidence grade the receipt fields reached. They are
 * observed counts over recorded outcomes, not a ranking or a reputation score.
 */
export function SolverMetrics({ publicApiBaseUrl }: { publicApiBaseUrl: string | null }) {
  const [state, setState] = useState<{ rows: Quality[]; methodology: string } | { error: string } | null>(null);

  useEffect(() => {
    if (publicApiBaseUrl === null) return;
    const base = publicApiBaseUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    (async () => {
      try {
        const listed = await read(base, "/v1/solvers", controller.signal);
        const solvers = (Array.isArray(listed.solvers) ? listed.solvers : []) as Record<string, unknown>[];
        const ids = solvers.map((solver) => String(solver.solverId)).filter((id) => /^[A-Za-z0-9._:-]{1,128}$/.test(id)).slice(0, 50);
        const bodies = await Promise.all(ids.map((id) => read(base, `/v1/analytics/execution-quality?solverId=${encodeURIComponent(id)}`, controller.signal)));
        const overall = await read(base, "/v1/analytics/execution-quality", controller.signal);
        const rows = bodies.map((body, index) => quality(ids[index] as string, body)).filter((row): row is Quality => row !== null);
        setState({ rows, methodology: typeof overall.methodology === "string" ? overall.methodology : "" });
      } catch (error) {
        if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : "request failed" });
      }
    })();
    return () => controller.abort();
  }, [publicApiBaseUrl]);

  if (publicApiBaseUrl === null) {
    return <p className={styles.metricsEmpty}>Configure the public market API to see receipt-derived solver metrics. Nothing is shown without recorded outcomes.</p>;
  }
  if (state === null) return <p className={styles.metricsEmpty}>Reading recorded solver outcomes.</p>;
  if ("error" in state) return <p className={styles.metricsEmpty}>Solver metrics unavailable ({state.error}).</p>;
  return (
    <div className={styles.metricsTable}>
      <div className={styles.metricsHeader} role="row">
        <span role="columnheader">Solver</span>
        <span role="columnheader" title="Recorded terminal outcomes">Outcomes</span>
        <span role="columnheader" title="Outcomes with a successful receipt">Completed</span>
        <span role="columnheader" title="Outcomes that entered recovery">Recovered</span>
        <span role="columnheader" title="Time unhedged across successful receipts">Unhedged p50 / p95</span>
        <span role="columnheader" title="Receipt fields by their strongest evidence grade">Evidence</span>
        <span className={styles.labelObserved}>OBSERVED</span>
      </div>
      {state.rows.length === 0 ? <p className={styles.metricsEmpty}>No solver has a recorded terminal outcome yet.</p> : null}
      {state.rows.map((row) => (
        <div key={row.solverId} className={styles.metricsRow} role="row">
          <span role="cell">{row.solverId}</span>
          <span role="cell">{row.terminalOutcomes.toLocaleString("en-US")}</span>
          <span role="cell">{row.terminalOutcomes === 0 ? "-" : percent(row.successfulBps)}</span>
          <span role="cell">{row.terminalOutcomes === 0 ? "-" : percent(row.recoveredBps)}</span>
          <span role="cell">{row.medianUnhedgedMs === undefined ? "-" : `${row.medianUnhedgedMs} / ${row.p95UnhedgedMs ?? "-"} ms`}</span>
          <span role="cell" className={styles.dimCell}>{row.evidence}</span>
        </div>
      ))}
      {state.methodology !== "" ? <p className={styles.metricsNote}>{state.methodology}</p> : null}
    </div>
  );
}
