import assert from "node:assert/strict";
import test from "node:test";
import {
  assetAmount,
  assetRef,
  domainRef,
  strategyState,
  strategyStateHash,
  versionedManifestRef,
} from "@naryx/protocol-types";
import {
  buildHyperliquidStrategyPackageReceipt,
  type StoredStrategyPackageAdmission,
} from "../src/index.js";
import type { HyperliquidTestnetTerminalExecutionResult } from "../src/hyperliquid-testnet-terminal.js";

type ReconciledResult = Extract<HyperliquidTestnetTerminalExecutionResult, { readonly status: "RECONCILED" }>;
type StrategyResult = Extract<HyperliquidTestnetTerminalExecutionResult, { readonly status: "STRATEGY_EXECUTION" }>;

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

test("lifecycle receipts preserve the canonical identity of an existing position", () => {
  const priorState = strategyState({
    version: 1,
    strategyId: "strategy-1",
    ownerId: "0x1111111111111111111111111111111111111111",
    subaccountId: "hypercore-testnet-account",
    seriesId: "btc-cash-carry-usdc",
    executionClassId: "hyperliquid-testnet-batched-ioc",
    open: true,
    stateVersion: 1n,
    legs: [{
      legId: "canonical-spot-position",
      underlyingId: base.assetId,
      instrumentId: "btc-spot-market",
      venueId: "hypercore-spot",
      signedQuantityAtoms: 100n,
      lotAtoms: 1n,
      ratioNumerator: 1n,
      ratioDenominator: 1n,
    }],
    liabilities: [],
    delegations: [],
    venuePositionsTransferable: false,
    legalTransferRestricted: false,
  });
  const source = admission();
  const lifecycleAdmission = {
    ...source,
    order: {
      ...source.order,
      lifecycleAction: "MIGRATE",
      expectedStrategyStateHash: strategyStateHash(priorState),
    },
    graph: {
      ...source.graph,
      legs: source.graph.legs.map((leg) => ({
        ...leg,
        venue: versionedManifestRef(leg.legId === "spot" ? "hypercore-spot" : "hypercore-perps", 1, leg.legId === "spot" ? "61".repeat(32) : "62".repeat(32)),
        market: versionedManifestRef(leg.legId === "spot" ? "btc-spot-market" : "btc-perp-market", 1, leg.legId === "spot" ? "63".repeat(32) : "64".repeat(32)),
      })),
    },
  } as unknown as StoredStrategyPackageAdmission;
  const result = completed();
  const receipt = buildHyperliquidStrategyPackageReceipt({
    attemptId: result.attemptId,
    admission: lifecycleAdmission,
    result,
    priorState,
  })!;
  assert.equal(receipt.legOutcomes.find((leg) => leg.legId === "spot")?.positionLegId, "canonical-spot-position");
  assert.equal(receipt.legOutcomes.find((leg) => leg.legId === "perp")?.positionLegId, "perp");
});

test("multi-stage generalized evidence builds one deterministic N-leg receipt", () => {
  const source = admission();
  const generalized = {
    ...source,
    graph: {
      ...source.graph,
      legs: [...source.graph.legs, {
        legId: "perp-close",
        legFamily: "PERP_CLOSE",
        side: "BUY",
        domain,
        quantityAsset: base,
        quantityAtoms: 40n,
        minimumQuantityAtoms: 40n,
        maximumFeeQuoteAtoms: 10n,
      }],
    },
    quote: {
      ...source.quote,
      passThroughCosts: [{ category: "VENUE", amount: assetAmount(quote, 40n) }],
    },
  } as unknown as StoredStrategyPackageAdmission;
  const leg = (
    legId: string,
    clientOrderId: string,
    planned: string,
    gross: string,
    feeAssetId: string,
    feeAssetDecimals: number,
    feeAtoms: string,
    venueFeeQuoteAtoms: string,
    evidenceByte: string,
  ) => ({
    legId,
    clientOrderId,
    plannedSignedBaseAtoms: planned,
    filledSignedBaseAtoms: planned,
    terminalStatus: "FILLED" as const,
    openOrderStatus: "NONE" as const,
    orderId: Number.parseInt(evidenceByte, 16),
    fillCount: 1,
    grossQuoteAtoms: gross,
    feeAssetId,
    feeAssetDecimals,
    feeAtoms,
    venueFeeQuoteAtoms,
    observedAtMs: "1000100",
    evidenceCommitment: `0x${evidenceByte.repeat(32)}`,
  });
  const result: StrategyResult = {
    attemptId: `strategy-hl-${"51".repeat(24)}`,
    idempotencyKey: "strategy-receipt-test-0002",
    domain: "hypercore:testnet",
    environment: "TESTNET",
    status: "STRATEGY_EXECUTION",
    packageStatus: "COMPLETED",
    completedStages: [0, 1],
    stages: [{
      batchStage: 0,
      submissionStatus: "ACKNOWLEDGED",
      actionCommitment: `0x${"52".repeat(32)}`,
      requestCommitment: `0x${"53".repeat(32)}`,
      evidence: {
        status: "COMPLETE",
        outcome: "COMPLETED",
        reasons: [],
        observedAtMs: "1000200",
        legs: [
          leg("spot", `0x${"54".repeat(16)}`, "100", "60000000", base.assetId, base.decimals, "1", "10", "55"),
          leg("perp", `0x${"56".repeat(16)}`, "-100", "60000000", quote.assetId, quote.decimals, "20", "20", "57"),
        ],
        rawEvidenceCommitments: [`0x${"58".repeat(32)}`],
      },
    }, {
      batchStage: 1,
      submissionStatus: "ACKNOWLEDGED",
      actionCommitment: `0x${"59".repeat(32)}`,
      requestCommitment: `0x${"5a".repeat(32)}`,
      evidence: {
        status: "COMPLETE",
        outcome: "COMPLETED",
        reasons: [],
        observedAtMs: "1000300",
        legs: [
          leg("perp-close", `0x${"5b".repeat(16)}`, "40", "24000000", quote.assetId, quote.decimals, "5", "5", "5c"),
        ],
        rawEvidenceCommitments: [`0x${"5d".repeat(32)}`],
      },
    }],
  };
  const receipt = buildHyperliquidStrategyPackageReceipt({
    attemptId: result.attemptId,
    admission: generalized,
    result,
  })!;
  assert.equal(receipt.terminalState, "FINALIZED_COMPLETE");
  assert.equal(receipt.executedAtValue, 1_000_300n);
  assert.equal(receipt.venueFees.atoms, 35n);
  assert.equal(receipt.legOutcomes.length, 3);
});
