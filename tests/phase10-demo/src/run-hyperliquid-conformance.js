import assert from "node:assert/strict";
import {
  HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS,
  HypercoreLocalConformanceVenue,
  HyperliquidStrategyTestnetRuntime,
} from "../../../services/solver/dist/index.js";

const masterAccount = `0x${"11".repeat(20)}`;
const tradingAccount = `0x${"22".repeat(20)}`;
const agentWallet = `0x${"33".repeat(20)}`;
const account = { masterAccount, tradingAccount, accountKind: "SUBACCOUNT" };

function hash(byte) {
  return new Uint8Array(32).fill(byte);
}

function plan(seed, action) {
  const spotDelta = action === "ENTRY" ? 1_000n : -1_000n;
  const perpDelta = -spotDelta;
  const baseAsset = { assetId: "SOL", decimals: 9, assetManifestHash: hash(10) };
  const quoteAsset = { assetId: "USDC", decimals: 6, assetManifestHash: hash(11) };
  const price = { baseAsset, quoteAsset, quoteAtoms: 20n, baseAtoms: 1n,
    roundingDirection: "CEIL" };
  const clientOrderId = (value) => `0x${value.toString(16).padStart(2, "0").repeat(16)}`;
  const orders = [
    {
      legId: "spot", stage: 0, baseAsset, quoteAsset,
      signedBaseDeltaAtoms: spotDelta, limitPrice: price,
      clientOrderId: clientOrderId(seed),
      wire: { a: 10_007, b: spotDelta > 0n, p: "20", s: "0.000001", r: false,
        t: { limit: { tif: "Ioc" } }, c: clientOrderId(seed) },
    },
    {
      legId: "perp", stage: 0, baseAsset, quoteAsset,
      signedBaseDeltaAtoms: perpDelta, limitPrice: price,
      clientOrderId: clientOrderId(seed + 1),
      wire: { a: 3, b: perpDelta > 0n, p: "20", s: "0.000001", r: action === "EXIT",
        t: { limit: { tif: "Ioc" } }, c: clientOrderId(seed + 1) },
    },
  ];
  return {
    version: 1,
    guarantee: "BATCHED_IOC_WITH_BOUNDED_RECOVERY",
    domain: { domainId: "hypercore:testnet", domainManifestVersion: 1,
      domainManifestHash: hash(1) },
    orderHash: hash(seed + 20),
    graphHash: hash(seed + 30),
    quoteHash: hash(seed + 40),
    routeHash: hash(seed + 50),
    requestExpiryMs: 100_000n,
    orders,
    batches: [{ stage: 0, action: { type: "order", grouping: "na",
      orders: orders.map((order) => order.wire) }, legIds: orders.map((order) => order.legId) }],
    recoveryAuthorizations: orders.map((order) => ({
      legId: order.legId,
      action: "COMPLETE",
      maximumQuantityAtoms: 1_000n,
      maximumCostQuoteAtoms: 20_000n,
    })),
    maximumRecoveryCostQuoteAtoms: 40_000n,
  };
}

function runtime(venue) {
  let nowMs = 1_000;
  return new HyperliquidStrategyTestnetRuntime(venue, venue, venue, {
    account,
    agentWallet,
    signerLeaseId: "local-conformance-solver",
    maxEvidenceAgeMs: 30_000,
    maxSnapshotSkewMs: 5_000,
    maxFillPages: 4,
    evidenceBinding: {
      spotAssetId: 10_007,
      perpetualAssetId: 3,
      baseFeeToken: "SOL",
      quoteFeeToken: "USDC",
    },
    currentTimeMs: () => nowMs++,
  });
}

async function successfulLifecycle() {
  const venue = new HypercoreLocalConformanceVenue();
  const entry = await runtime(venue).execute("conformance-entry-success", plan(1, "ENTRY"));
  const exit = await runtime(venue).execute("conformance-exit-success", plan(3, "EXIT"));
  assert.equal(entry.status, "COMPLETED");
  assert.equal(exit.status, "COMPLETED");
  assert.ok(venue.snapshot().positions.every((position) => position.signedBaseAtoms === 0n));
  return { entry: entry.status, exit: exit.status, final: venue.snapshot() };
}

async function recoveredLifecycle() {
  const venue = new HypercoreLocalConformanceVenue();
  const entryPlan = plan(5, "ENTRY");
  venue.armOneLegNoFill({ attemptId: "conformance-entry-recovery", batchStage: 0,
    legId: "perp" });
  const entry = await runtime(venue).execute("conformance-entry-recovery", entryPlan);
  assert.equal(entry.status, "RECOVERY_REQUIRED");
  const recovery = venue.recover("conformance-entry-recovery", entryPlan);
  assert.equal(recovery.status, "COMPLETED");
  const exit = await runtime(venue).execute("conformance-exit-recovered", plan(7, "EXIT"));
  assert.equal(exit.status, "COMPLETED");
  assert.ok(venue.snapshot().positions.every((position) => position.signedBaseAtoms === 0n));
  return { entry: entry.status, recovery, exit: exit.status, final: venue.snapshot() };
}

const report = {
  evidenceClass: HYPERCORE_LOCAL_CONFORMANCE_EVIDENCE_CLASS,
  environment: "LOCAL_CONFORMANCE",
  networkPolicy: "LOCAL_ONLY_NO_PUBLIC_WRITES",
  successfulLifecycle: await successfulLifecycle(),
  recoveredLifecycle: await recoveredLifecycle(),
};
process.stdout.write(`${JSON.stringify(report, (_, value) =>
  typeof value === "bigint" ? value.toString() : value)}\n`);
