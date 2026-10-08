import assert from "node:assert/strict";
import test from "node:test";
import { assetAmount, assetRef, commitmentHash, executionIntelligence } from "@naryx/protocol-types";
import {
  validateStrategyExecutionIntelligence,
  validateStrategyReceiptEconomics,
} from "../src/strategy-package-store.js";

const usdc = assetRef("usdc", "11".repeat(32), 6);
const amount = (atoms: bigint) => assetAmount(usdc, atoms);

const order: Parameters<typeof validateStrategyReceiptEconomics>[0] = {
  maximumServiceFeesByAsset: [{ asset: usdc, maxAtoms: 10n }],
  maximumVenueFeesByAsset: [{ asset: usdc, maxAtoms: 3n }],
  maximumNetworkFeesByAsset: [{ asset: usdc, maxAtoms: 4n }],
  maximumRecoveryCostByAsset: [{ asset: usdc, maxAtoms: 5n }],
  maximumResidualValue: amount(6n),
};

const quote: Parameters<typeof validateStrategyReceiptEconomics>[1] = {
  serviceCharges: [
    { category: "PROTOCOL", amount: amount(2n) },
    { category: "SOLVER", amount: amount(3n) },
  ],
  passThroughCosts: [
    { category: "VENUE", amount: amount(3n) },
    { category: "NETWORK", amount: amount(4n) },
  ],
};

const receipt: Parameters<typeof validateStrategyReceiptEconomics>[2] = {
  quoteAsset: usdc,
  serviceFee: amount(2n),
  solverFee: amount(3n),
  venueFees: amount(3n),
  networkCost: amount(4n),
  recoveryCost: amount(5n),
  terminalResidualValue: amount(6n),
};

test("terminal strategy receipt economics stay within the accepted quote and signed caps", () => {
  assert.doesNotThrow(() => validateStrategyReceiptEconomics(order, quote, receipt));
  assert.throws(
    () => validateStrategyReceiptEconomics(order, quote, { ...receipt, solverFee: amount(4n) }),
    /solver fee exceeds the accepted quote/,
  );
  assert.throws(
    () => validateStrategyReceiptEconomics(order, quote, { ...receipt, recoveryCost: amount(6n) }),
    /recovery cost exceeds the signed order cap/,
  );
  assert.throws(
    () => validateStrategyReceiptEconomics(order, quote, { ...receipt, terminalResidualValue: amount(7n) }),
    /residual exceeds the signed order cap/,
  );
});

const hash = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const executionReceipt: Parameters<typeof validateStrategyExecutionIntelligence>[0] = {
  orderHash: commitmentHash(hash(1)),
  terminalState: "FINALIZED_COMPLETE",
  legOutcomes: [{}, {}] as unknown as Parameters<typeof validateStrategyExecutionIntelligence>[0]["legOutcomes"],
};

const executionQuote: Parameters<typeof validateStrategyExecutionIntelligence>[1] = {
  netPackageOutcome: amount(1_000n),
};

const intelligence = executionIntelligence({
  version: 1,
  receiptHash: hash(2),
  orderHash: executionReceipt.orderHash,
  observerId: "observer-a",
  clockUnit: "milliseconds",
  observerEvidenceHash: hash(3),
  observation: {
    orderHash: executionReceipt.orderHash,
    side: "BUY",
    quotedPrice: 10_000n,
    inclusionReferencePrice: 10_010n,
    executionPrice: 10_005n,
    markouts: [],
    expectedNetOutcomeAtoms: 1_000n,
    realizedNetOutcomeAtoms: 940n,
    submittedAtValue: 90n,
    includedAtValue: 100n,
    legCompletedAtValues: [100n, 110n],
    ordering: { sameActorBefore: false, sameActorAfter: false },
    adverseMoveThresholdBps: 5n,
  },
  deliveryPolicy: {
    requestedPath: "PRIVATE_RELAY",
    permittedFallbacks: [],
    maximumInclusionDelayValue: 20n,
    provenProtectedPaths: [],
  },
  deliveryAttempts: [{
    attemptId: "attempt-a",
    path: "PRIVATE_RELAY",
    submittedAtValue: 90n,
    outcome: "INCLUDED",
    includedAtValue: 100n,
  }],
  observedAtValue: 120n,
});

test("execution intelligence stays bound to the completed receipt and accepted quote", () => {
  assert.doesNotThrow(() => validateStrategyExecutionIntelligence(executionReceipt, executionQuote, intelligence));
  assert.throws(
    () => validateStrategyExecutionIntelligence(executionReceipt, { netPackageOutcome: amount(999n) }, intelligence),
    /selected quote's expected net outcome/,
  );
  assert.throws(
    () => validateStrategyExecutionIntelligence({ ...executionReceipt, legOutcomes: [{}] as unknown as typeof executionReceipt.legOutcomes }, executionQuote, intelligence),
    /one completion time per receipt leg/,
  );
  assert.throws(
    () => validateStrategyExecutionIntelligence({ ...executionReceipt, terminalState: "NO_EFFECT" }, executionQuote, intelligence),
    /requires a successful receipt/,
  );
});
