import assert from "node:assert/strict";
import test from "node:test";
import {
  baseAtomsToSize,
  boundedIocPrice,
  buildCashCarryPlan,
  buildCashCarryRecoverySourcePlan,
} from "../src/hyperliquid-testnet-plan.js";

test("builds bounded live entry and exit plans", () => {
  assert.equal(baseAtomsToSize(20n, 5), "0.0002");
  assert.equal(boundedIocPrice("123450", "BUY"), "123760");
  assert.equal(boundedIocPrice("123450", "SELL"), "123140");
  const entry = buildCashCarryPlan({
    attemptId: "hl-entry-0123456789abcdef",
    action: "ENTRY",
    spotBaseAtoms: 2_000_000n,
    perpetualBaseAtoms: 2_000_000n,
    baseDecimals: 10,
    quoteDecimals: 8,
    spotAssetId: 12072,
    perpetualAssetId: 3,
    spotPrice: "123760",
    perpetualPrice: "123140",
    expiresAtMs: 2_000_000,
  });
  assert.deepEqual(entry.orders.map((order) => [order.stage, order.wire.a, order.wire.b, order.wire.r]), [
    [0, 12072, true, false],
    [1, 3, false, false],
  ]);
  assert.deepEqual(entry.batches.map((batch) => batch.legIds), [["spot"], ["perpetual"]]);
  assert.equal(entry.orders[1].limitPrice.quoteAtoms, 6_157n);
  assert.equal(entry.orders[1].limitPrice.baseAtoms, 5n);

  const recovery = buildCashCarryRecoverySourcePlan({
    strategyPlan: entry,
    seriesManifestHash: "11".repeat(32),
    executionClassManifestHash: "22".repeat(32),
    prePerpetualPositionAtoms: 0n,
    recoveryIdentity: {
      controllerId: "hypercore-recovery-controller-v1",
      controllerCodeHash: "33".repeat(32),
      authorityModeId: "agent-wallet-v1",
      actionBuilderCodeHash: "44".repeat(32),
    },
    rollbackSpotPrice: "122000",
    rollbackPerpetualPrice: "124000",
    recoveryActionExpiryMs: 2_100_000,
    recoveryDeadlineMs: 2_200_000,
  });
  assert.deepEqual(recovery.legs.map((leg) => [leg.role, leg.signedBaseDeltaAtoms]), [
    ["SPOT", 2_000_000n],
    ["PERPETUAL", -2_000_000n],
  ]);
  assert.deepEqual(recovery.recoveryPolicy.actionSlots.map((slot) => slot.action), [
    "COMPLETE_SPOT",
    "COMPLETE_PERP",
    "ROLLBACK_SPOT",
    "ROLLBACK_PERP",
  ]);
  assert.equal(recovery.terminalResidualPolicy.kind, "BOUNDED_NET");
});
