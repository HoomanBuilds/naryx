import assert from "node:assert/strict";
import test from "node:test";
import { assetAmount, assetRef } from "@naryx/protocol-types";
import { validateStrategyReceiptEconomics } from "../src/strategy-package-store.js";

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
