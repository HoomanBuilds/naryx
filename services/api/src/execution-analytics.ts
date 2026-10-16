import type { TerminalState } from "@naryx/protocol-types";
import type { ExecutionQualitySummary, SolverPerformanceSummary } from "./evidence-store.js";
import type { SqliteStrategyPackageStore } from "./strategy-package-store.js";

type NativeQuality = ReturnType<SqliteStrategyPackageStore["strategyExecutionQuality"]>;

const methodology = " Outcomes also include native strategy receipts without a legacy source-order binding. "
  + "Coverage, latency, price improvement, time unhedged, and receipt-field evidence remain legacy-only; native evidence is counted separately per leg.";

function outcomes(legacy: Readonly<Record<TerminalState, number>>, native?: NativeQuality) {
  const states = Object.fromEntries(Object.entries(legacy).map(([state, count]) =>
    [state, count + (native?.byTerminalState[state as TerminalState] ?? 0)])) as Record<TerminalState, number>;
  const total = Object.values(states).reduce((sum, count) => sum + count, 0);
  const bps = (count: number) => total === 0 ? 0 : Number(BigInt(count) * 10_000n / BigInt(total));
  return {
    total,
    byTerminalState: Object.freeze(states),
    settledBps: bps(states.FINALIZED_COMPLETE + states.FINALIZED_BOUNDED + states.RECOVERED_COMPLETE + states.RECOVERED_BOUNDED),
    recoveredBps: bps(states.RECOVERED_COMPLETE + states.RECOVERED_BOUNDED + states.RECOVERED_FLAT),
    fadeBps: bps(states.NO_EFFECT),
    boundedResidualBps: bps(states.FINALIZED_BOUNDED + states.RECOVERED_BOUNDED),
    manualInterventionBps: bps(states.MANUAL_INTERVENTION),
  };
}

export function combinedExecutionQuality(legacy: ExecutionQualitySummary, native?: NativeQuality) {
  const combined = outcomes(legacy.byTerminalState, native);
  return {
    ...legacy,
    methodology: legacy.methodology + methodology,
    terminalOutcomes: combined.total,
    byTerminalState: combined.byTerminalState,
    successfulBps: combined.settledBps,
    recoveredBps: combined.recoveredBps,
    nativeStrategyReceipts: native?.total ?? 0,
    strategyLegEvidence: native?.legEvidence ?? {},
  };
}

export function combinedSolverPerformance(legacy: SolverPerformanceSummary, native?: NativeQuality) {
  return {
    ...legacy,
    methodology: legacy.methodology + methodology,
    outcomes: outcomes(legacy.outcomes.byTerminalState, native),
    nativeStrategyReceipts: native?.total ?? 0,
  };
}
