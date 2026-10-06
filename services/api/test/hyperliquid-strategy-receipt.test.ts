import assert from "node:assert/strict";
import test from "node:test";
import { assetAmount, assetRef, domainRef } from "@naryx/protocol-types";
import {
  buildHyperliquidStrategyPackageReceipt,
  type StoredStrategyPackageAdmission,
} from "../src/index.js";
import type { HyperliquidTestnetTerminalExecutionResult } from "../src/hyperliquid-testnet-terminal.js";

type ReconciledResult = Extract<HyperliquidTestnetTerminalExecutionResult, { readonly status: "RECONCILED" }>;

const base = assetRef("hypercore:testnet:btc", "11".repeat(32), 5);
const quote = assetRef("hypercore:testnet:usdc", "12".repeat(32), 6);
const domain = domainRef("hypercore:testnet", 1, "13".repeat(32));

function admission(): StoredStrategyPackageAdmission {
  return {
    orderHashHex: "21".repeat(32),
    graphHashHex: "22".repeat(32),
    quoteHashHex: "23".repeat(32),
    routeHashHex: "24".repeat(32),
    order: {
      environment: "testnet",
      templateId: "cash-and-carry-v1",
      templateVersion: 1,
      packageTemplateManifestHash: Uint8Array.from({ length: 32 }, () => 0x31),
      seriesId: "btc-cash-carry-usdc",
      seriesVersion: 1,
      seriesManifestHash: Uint8Array.from({ length: 32 }, () => 0x32),
      executionClassId: "hyperliquid-testnet-batched-ioc",
      executionClassVersion: 1,
      executionClassManifestHash: Uint8Array.from({ length: 32 }, () => 0x33),
      lifecycleAction: "ENTRY",
      owner: "0x1111111111111111111111111111111111111111",
      settlementClass: "BATCHED_IOC_WITH_RECOVERY",
      quoteAsset: quote,
      maximumResidualValue: assetAmount(quote, 100n),
    },
    graph: {
      legs: [{
        legId: "spot",
        legFamily: "SPOT_SWAP",
        side: "BUY",
        domain,
        quantityAsset: base,
        quantityAtoms: 100n,
        minimumQuantityAtoms: 90n,
        maximumFeeQuoteAtoms: 25n,
      }, {
        legId: "perp",
        legFamily: "PERP_OPEN",
        side: "SELL",
        domain,
        quantityAsset: base,
        quantityAtoms: 100n,
        minimumQuantityAtoms: 90n,
        maximumFeeQuoteAtoms: 25n,
      }],
    },
    quote: {
      domains: [domain],
      solverId: "solver-hypercore-testnet-v1",
      passThroughCosts: [{ category: "VENUE", amount: assetAmount(quote, 35n) }],
    },
    route: { domainPlans: [{ domain }] },
    recordedAtMs: 1,
  } as unknown as StoredStrategyPackageAdmission;
}

function completed(): ReconciledResult {
  return {
    attemptId: `strategy-hl-${"41".repeat(24)}`,
    idempotencyKey: "strategy-receipt-test-0001",
    domain: "hypercore:testnet",
    environment: "TESTNET",
    status: "RECONCILED",
    submissionStatus: "ACKNOWLEDGED",
    packageStatus: "COMPLETED_BOUNDED",
    reasons: [],
    actionCommitment: `0x${"42".repeat(32)}`,
    requestCommitment: `0x${"43".repeat(32)}`,
    rawEvidenceCommitments: [],
    observedNetSpotDeltaAtoms: "100",
    observedPerpetualDeltaAtoms: "-99",
    executionEvidence: {
      evidenceVersion: "1",
      observedAtMs: "1000000",
      terminalResidualBaseAtoms: "1",
      terminalResidualQuoteAtoms: "50",
      legs: [{
        legId: "spot",
        role: "SPOT",
        clientOrderId: `0x${"44".repeat(16)}`,
        requestedSignedBaseAtoms: "100",
        filledSignedBaseAtoms: "100",
        grossQuoteAtoms: "60000000",
        feeAssetId: base.assetId,
        feeAssetDecimals: base.decimals,
        feeAtoms: "1",
        venueFeeQuoteAtoms: "10",
        evidenceCommitment: `0x${"45".repeat(32)}`,
      }, {
        legId: "perp",
        role: "PERPETUAL",
        clientOrderId: `0x${"46".repeat(16)}`,
        requestedSignedBaseAtoms: "-100",
        filledSignedBaseAtoms: "-99",
        grossQuoteAtoms: "59400000",
        feeAssetId: quote.assetId,
        feeAssetDecimals: quote.decimals,
        feeAtoms: "20",
        venueFeeQuoteAtoms: "20",
        evidenceCommitment: `0x${"47".repeat(32)}`,
      }],
    },
  };
}

test("authoritative Hyperliquid evidence builds a deterministic bounded strategy receipt", () => {
  const input = {
    attemptId: `strategy-hl-${"41".repeat(24)}`,
    admission: admission(),
    result: completed(),
  };
  const receipt = buildHyperliquidStrategyPackageReceipt(input)!;
  const repeated = buildHyperliquidStrategyPackageReceipt(input)!;
  assert.equal(receipt.terminalState, "FINALIZED_BOUNDED");
  assert.equal(receipt.finalityStatus, "VENUE_COMMITTED");
  assert.equal(receipt.venueFees.atoms, 30n);
  assert.equal(receipt.terminalResidualValue.atoms, 50n);
  assert.equal(receipt.receiptNonce, repeated.receiptNonce);
  assert.deepEqual(receipt.legOutcomes.map((leg) => [leg.legId, leg.settledQuantity.atoms]), [
    ["perp", -99n],
    ["spot", 100n],
  ]);
});

test("receipt construction fails closed on missing or mismatched evidence", () => {
  const result = completed();
  assert.equal(buildHyperliquidStrategyPackageReceipt({
    attemptId: result.attemptId,
    admission: admission(),
    result: { ...result, packageStatus: "MANUAL_INTERVENTION" },
  }), undefined);
  assert.throws(() => buildHyperliquidStrategyPackageReceipt({
    attemptId: result.attemptId,
    admission: admission(),
    result: {
      ...result,
      executionEvidence: {
        ...result.executionEvidence!,
        legs: [{ ...result.executionEvidence!.legs[0], requestedSignedBaseAtoms: "99" }, result.executionEvidence!.legs[1]],
      },
    },
  }), { code: "QUANTITY_MISMATCH" });
});
