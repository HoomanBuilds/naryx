import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import bs58 from "bs58";
import {
  adapterRef,
  assetRef,
  commitmentHash,
  nettingPolicyManifest,
  nettingPolicyManifestHash,
  packageGraphHash,
  packageSettlementCommitment,
  packageSettlementCommitmentBytes,
  packageSettlementCommitmentHash,
  packageSettlementReadiness,
  packageSettlementReadinessHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  domainRef,
  toHex,
  versionedManifestRef,
  type NettingPolicyManifestInput,
  type PackageGraphInput,
  type StrategyPackageOrderInput,
} from "@naryx/protocol-types";
import {
  prepareAuthoritativeNettingBatch,
  type AuthoritativeNettingExchangePort,
  type AuthoritativeNettingStrategyPort,
  type PackageSettlementAuthorizationEvidence,
  type PackageSettlementProgress,
} from "../src/index.js";

const id = (n: number): string => n.toString(16).padStart(64, "0");
const executionClassHash = id(10);
const sol = assetRef("sol", id(11), 9);
const usdc = assetRef("usdc", id(12), 6);
const domain = domainRef("svm:solana-devnet", 1, id(13));
const venue = versionedManifestRef("venue", 1, id(14));
const spotMarket = versionedManifestRef("sol-usdc-spot", 1, id(15));
const perpMarket = versionedManifestRef("sol-usdc-perp", 1, id(16));
const spotAdapter = adapterRef({ adapterId: "spot", adapterManifestVersion: 1, adapterManifestHash: id(17) });
const perpAdapter = adapterRef({ adapterId: "perp", adapterManifestVersion: 1, adapterManifestHash: id(18) });

const policyInput: NettingPolicyManifestInput = {
  schemaVersion: 1,
  manifestVersion: 1,
  nettingPolicyVersion: 2,
  environment: "devnet",
  executionClassId: "sol-basis",
  executionClassVersion: 1,
  executionClassManifestHash: executionClassHash,
  settlementClass: "ATOMIC_POSTCONDITION",
  allocationRule: "PRO_RATA_SEQUENCE",
  externalExecutionMode: "EXACT_NET_ONLY",
  clearingRule: "LIMIT_MIDPOINT_BUYER_FAVOR",
  maximumObligations: 8,
  maximumBatchWindowMilliseconds: 1_000n,
  instruments: [
    {
      instrumentId: "sol-spot",
      domain,
      adapter: spotAdapter,
      venue,
      market: spotMarket,
      quantityAsset: sol,
      quoteAsset: usdc,
      legFamily: "SPOT_SWAP",
      quantityIncrementAtoms: 10n,
      priceTickQuoteAtoms: 1n,
    },
    {
      instrumentId: "sol-perp",
      domain,
      adapter: perpAdapter,
      venue,
      market: perpMarket,
      quantityAsset: sol,
      quoteAsset: usdc,
      legFamily: "PERP_OPEN",
      quantityIncrementAtoms: 10n,
      priceTickQuoteAtoms: 1n,
    },
  ],
};
const policy = nettingPolicyManifest(policyInput);

function ownerKey() {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  return { owner: bs58.encode(der.subarray(der.length - 32)), privateKey: pair.privateKey };
}

function graph(owner: string, reverse: boolean, nonce: bigint): PackageGraphInput {
  const leg = (
    legId: string,
    legFamily: "SPOT_SWAP" | "PERP_OPEN",
    adapter: typeof spotAdapter,
    market: typeof spotMarket,
    side: "BUY" | "SELL",
  ) => ({
    legId,
    legFamily,
    legTypeId: legFamily === "SPOT_SWAP" ? "spot-purchase" : "perp-sale",
    domain,
    adapter,
    venue,
    market,
    assets: [sol, usdc],
    side,
    quantityAsset: sol,
    quantityAtoms: 10n,
    minimumQuantityAtoms: 10n,
    limitPrice: {
      baseAsset: sol,
      quoteAsset: usdc,
      quoteAtoms: side === "BUY" ? 6n : 4n,
      baseAtoms: 5n,
      roundingDirection: side === "BUY" ? "CEIL" as const : "FLOOR" as const,
    },
    maximumFeeQuoteAtoms: 1n,
    preconditionHashes: [],
    postconditionHashes: [],
    timeInForce: "FOK" as const,
    legExpiryValue: 2_000n,
  });
  return {
    graphVersion: 1,
    environment: "devnet",
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: id(20),
    seriesId: "sol-basis-series",
    seriesVersion: 1,
    seriesManifestHash: id(21),
    executionClassId: "sol-basis",
    executionClassVersion: 1,
    executionClassManifestHash: executionClassHash,
    lifecycleAction: "ENTRY",
    owner,
    strategyAccountRefs: ["strategy-account"],
    legs: [
      leg("spot", "SPOT_SWAP", spotAdapter, spotMarket, reverse ? "SELL" : "BUY"),
      leg("perp", "PERP_OPEN", perpAdapter, perpMarket, reverse ? "BUY" : "SELL"),
    ],
    dependencyEdges: [],
    executionGroups: [{ groupId: "atomic", kind: "ALL_OR_NONE", legIds: ["spot", "perp"] }],
    settlementClass: "ATOMIC_POSTCONDITION",
    policyHashes: {
      netting: nettingPolicyManifestHash(policy),
      privacy: id(22),
      solver: id(23),
      delivery: id(24),
      resource: id(25),
      portfolioRiskLimits: id(26),
    },
    recoverySlots: [],
    maximumRecoveryCostQuoteAtoms: 0n,
    expiryUnit: "SOLANA_SLOT",
    packageExpiryValue: 2_000n,
    nonce,
  };
}

function strategyOrder(owner: string, input: PackageGraphInput, nonce: bigint) {
  const order: StrategyPackageOrderInput = {
    version: 1,
    environment: "devnet",
    templateId: input.templateId,
    templateVersion: 1,
    packageTemplateManifestHash: input.packageTemplateManifestHash,
    graphHash: packageGraphHash(input),
    seriesId: input.seriesId,
    seriesVersion: 1,
    seriesManifestHash: input.seriesManifestHash,
    executionClassId: input.executionClassId,
    executionClassVersion: 1,
    executionClassManifestHash: executionClassHash,
    quoteConventionId: "annualized-net-yield-v1",
    riskClassId: "delta-neutral-basis-v1",
    owner,
    settlementAccount: "strategy-account",
    lifecycleAction: "ENTRY",
    settlementClass: "ATOMIC_POSTCONDITION",
    packageOrderType: "LIMIT",
    packageTimeInForce: "FOK",
    economicQuantity: { asset: sol, atoms: 10n },
    quoteAsset: usdc,
    metricLimits: [],
    maximumServiceFeesByAsset: [],
    maximumVenueFeesByAsset: [],
    maximumNetworkFeesByAsset: [],
    maximumRecoveryCostByAsset: [],
    maximumMarginIncrease: { asset: usdc, atoms: 0n },
    maximumResidualValue: { asset: usdc, atoms: 0n },
    expiryUnit: "SOLANA_SLOT",
    expiryValue: 2_000n,
    nonce,
  };
  return strategyPackageOrder(order);
}

test("authoritative netting derives opposite package legs from signed durable state", async () => {
  const records = [ownerKey(), ownerKey()].map((key, index) => {
    const packageOrderId = id(100 + index);
    const graphInput = graph(key.owner, index === 1, BigInt(index + 1));
    const order = strategyOrder(key.owner, graphInput, BigInt(index + 1));
    const orderHash = strategyPackageOrderHash(order);
    const commitment = packageSettlementCommitment({
      version: 1,
      environment: "devnet",
      executionClassId: "sol-basis",
      packageOrderId,
      strategyOrderHash: orderHash,
      graphHash: packageGraphHash(graphInput),
      participantId: key.owner,
      settlementAccount: "strategy-account",
      quantity: 10n,
      validUntilUnit: "SOLANA_SLOT",
      validUntilValue: 2_000n,
    });
    const readiness = packageSettlementReadiness({
      version: 2,
      packageOrderId,
      settlementCommitmentHash: packageSettlementCommitmentHash(commitment),
      strategyOrderHash: orderHash,
      executionClassId: "sol-basis",
      committedQuantity: 10n,
      allocatedQuantity: 10n,
      remainingQuantity: 0n,
      acceptsFurtherMatches: false,
      status: "READY_FOR_OWNER_AUTHORIZATION",
      evidenceRefs: [{ kind: "CONTINUOUS_ALLOCATION", evidenceHash: id(200 + index) }],
    });
    const authorization: PackageSettlementAuthorizationEvidence = {
      packageOrderIdHex: packageOrderId,
      settlementCommitmentHashHex: toHex(packageSettlementCommitmentHash(commitment)),
      participantId: key.owner,
      scheme: "ED25519",
      signature: bs58.encode(sign(null, packageSettlementCommitmentBytes(commitment), key.privateKey)),
      authorizedAtMs: 1_000 + index,
    };
    const progress: PackageSettlementProgress = {
      readiness,
      readinessHashHex: toHex(packageSettlementReadinessHash(readiness)),
      obligations: [{
        evidenceKind: "CONTINUOUS_ALLOCATION",
        evidenceHashHex: id(200 + index),
        fillSequence: BigInt(index + 1),
        role: index === 0 ? "MAKER" : "TAKER",
        counterpartyOrderIdHex: id(101 - index),
        liquiditySource: "DIRECT",
        priceTicks: 100n,
        quantity: 10n,
      }],
    };
    return { packageOrderId, graphInput, order, orderHash, commitment, authorization, progress };
  });
  const byPackage = new Map(records.map((record) => [record.packageOrderId, record]));
  const byOrder = new Map(records.map((record) => [toHex(record.orderHash), record]));
  let recorded = false;
  const exchange: AuthoritativeNettingExchangePort = {
    settlementCommitment: (packageOrderId) => byPackage.get(toHex(commitmentHash(packageOrderId)))?.commitment,
    settlementAuthorization: (packageOrderId) => byPackage.get(toHex(commitmentHash(packageOrderId)))?.authorization,
    settlementProgress: (packageOrderId) => byPackage.get(toHex(commitmentHash(packageOrderId)))?.progress,
    recordPreparedNettingBatch: (input) => {
      recorded = true;
      return {
        replayed: false,
        batch: {
          status: "PREPARED",
          proofHashHex: toHex(input.result.proofHash),
          policy,
          result: input.result,
          packages: input.packages,
          recordedAtMs: 1_100,
        },
      };
    },
    nettingBatch: () => undefined,
  };
  const strategies: AuthoritativeNettingStrategyPort = {
    order: (orderHashHex) => {
      const record = byOrder.get(orderHashHex);
      return record === undefined ? undefined : {
        orderHashHex,
        graphHashHex: toHex(packageGraphHash(record.graphInput)),
        order: record.order,
        graph: record.graphInput,
        recordedAtMs: 900,
      };
    },
  };
  const prepared = await prepareAuthoritativeNettingBatch(exchange, strategies, {
    packageOrderIds: records.map((record) => record.packageOrderId),
    policy: policyInput,
  });
  assert.equal(recorded, true);
  assert.equal(prepared.batch.status, "PREPARED");
  assert.deepEqual(
    prepared.batch.result.underlyings.map((entry) => [entry.instrumentId, entry.internalMatchedAtoms, entry.externalNetAtoms]),
    [["sol-perp", 10n, 0n], ["sol-spot", 10n, 0n]],
  );
  assert.deepEqual(
    prepared.batch.result.underlyings.map((entry) => [entry.instrumentId, entry.internalClearingPriceTicks, entry.internalQuoteAtoms]),
    [["sol-perp", 10n, 10n], ["sol-spot", 10n, 10n]],
  );
});
