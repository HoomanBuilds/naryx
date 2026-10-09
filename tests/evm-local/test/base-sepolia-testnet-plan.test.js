import assert from "node:assert/strict";
import test from "node:test";
import release from "../../../deployments/evm/base-sepolia/release.json" with { type: "json" };
import {
  buildBaseSepoliaEntryPlan,
  buildBaseSepoliaExitPlan,
  failedPostconditionEntryPlan,
} from "../src/base-sepolia-testnet-plan.js";

const common = {
  release,
  strategyAccount: "0x0000000000000000000000000000000000000011",
  solver: "0x0000000000000000000000000000000000000022",
  quantityAtoms: 1_000_000_000_000_000n,
  nonce: 3n,
  deadline: 2_000_000_000n,
  perpExpiry: 4_294_967_295,
};

test("builds rollback, entry, and exact full exit plans", () => {
  const entry = buildBaseSepoliaEntryPlan({
    ...common,
    marginAtoms: 1_000_000n,
    collateralScale: 1_000_000_000_000n,
    takerFeeBps: 5n,
    initialMarginBps: 1_000n,
    oracleMoveAllowanceBps: 100n,
    spotSlippageBps: 200n,
    spotQuoteAtoms: 2_500_000n,
    previewEntryNotionalWad: 2_500_000_000_000_000_000n,
  });
  assert.equal(entry.execution.expectedPostPerpSizeWad, -common.quantityAtoms);
  assert.equal(entry.admission.action, 1);
  assert.equal(entry.execution.packageSizeUnits, 1n);
  const failed = failedPostconditionEntryPlan(entry);
  assert.equal(failed.execution.minimumPostPerpBalanceWad, 0n);
  assert.equal(failed.execution.maximumPostPerpBalanceWad, 0n);

  const exit = buildBaseSepoliaExitPlan({
    ...common,
    nonce: 4n,
    position: { balance: 998_700_000_000_000_000n, size: -common.quantityAtoms, entryNotional: 2_500_000_000_000_000_000n },
    entryReceiptHash: `0x${"44".repeat(32)}`,
    spotSlippageBps: 200n,
    spotQuoteAtoms: 2_490_000n,
  });
  assert.equal(exit.admission.action, 2);
  assert.equal(exit.execution.expectedPostPerpSizeWad, 0n);
  assert.equal(exit.execution.entryReceiptHash, `0x${"44".repeat(32)}`);
});
