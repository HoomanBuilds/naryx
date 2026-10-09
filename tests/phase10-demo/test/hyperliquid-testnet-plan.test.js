import assert from "node:assert/strict";
import test from "node:test";
import {
  baseAtomsToSize,
  boundedIocPrice,
  buildCashCarryPlan,
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
});
