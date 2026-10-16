import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { combinedExecutionQuality, combinedSolverPerformance } from "../src/execution-analytics.js";
import { SqliteEvidenceStore } from "../src/evidence-store.js";

test("combined analytics recompute exact outcome rates without inventing legacy measurements", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-execution-analytics-"));
  const store = new SqliteEvidenceStore(join(scratch, "evidence.db"));
  try {
    const legacy = store.executionQuality();
    const native = {
      total: 3,
      byTerminalState: { FINALIZED_COMPLETE: 1, RECOVERED_BOUNDED: 1, NO_EFFECT: 1 } as const,
      legEvidence: { CONSENSUS_VERIFIED: 2, VENUE_API_CORROBORATED: 1 },
    };
    const quality = combinedExecutionQuality(legacy, native);
    assert.equal(quality.terminalOutcomes, 3);
    assert.equal(quality.successfulBps, 6_666);
    assert.equal(quality.recoveredBps, 3_333);
    assert.equal(quality.nativeStrategyReceipts, 3);
    assert.equal(quality.timeUnhedgedMs, undefined);
    assert.deepEqual(quality.receiptFieldEvidence, {});
    assert.deepEqual(quality.strategyLegEvidence, native.legEvidence);
    const performance = combinedSolverPerformance(store.solverPerformance("solver-a", []), native);
    assert.equal(performance.outcomes.total, 3);
    assert.equal(performance.outcomes.fadeBps, 3_333);
    assert.equal(performance.outcomes.boundedResidualBps, 3_333);
    assert.equal(performance.firstQuoteLatencyMs, undefined);
    assert.equal(performance.priceImprovementBps, undefined);
    assert.equal(performance.coverage.eligibleOrders, 0);
    const mixed = combinedExecutionQuality({ ...legacy, terminalOutcomes: 1,
      byTerminalState: { ...legacy.byTerminalState, MANUAL_INTERVENTION: 1 } }, native);
    assert.equal(mixed.terminalOutcomes, 4);
    assert.equal(mixed.successfulBps, 5_000);
    assert.equal(mixed.recoveredBps, 2_500);
    assert.equal(combinedExecutionQuality(legacy).successfulBps, 0);
    assert.match(quality.methodology, /legacy-only/);
  } finally {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
