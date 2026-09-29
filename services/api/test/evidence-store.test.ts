import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import {
  adapterRef,
  assetAmount,
  assetRef,
  domainRef,
  evidenceManifestHash,
  exactPrice,
  exactSignedRate,
  fromProtocolJson,
  packageOrderBytes,
  packageReceiptHash,
  toHex,
  toProtocolJson,
  type AcceptedQuoteFeeTerms,
  type EvidenceManifestInput,
  type PackageOrderInput,
  type PackageReceiptInput,
  type TerminalOutcomeInput,
} from "@naryx/protocol-types";
import {
  createCanonicalEntryOrder,
  createPublicApiHandler,
  SqliteEvidenceStore,
  SqlitePackageExchangeStore,
  type ActiveOrderContext,
} from "../src/index.js";
import { CLASS_SUPPORT, NOW, SERIES_SUPPORT } from "./exchange-fixtures.js";

const hash = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const domain = domainRef("svm:testnet", 1, "11".repeat(32));
const sol = assetRef("svm:testnet:sol", "22".repeat(32), 9);
const usdc = assetRef("svm:testnet:usdc", "33".repeat(32), 6);

function context(): ActiveOrderContext {
  return Object.freeze({
    contextId: "evidence-context",
    state: "ACTIVE",
    capturedAtClock: 1_000_000n,
    maxStaleness: 1_000_000n,
    domain,
    environment: "testnet",
    orderVersion: 1,
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: "44".repeat(32),
    baseAsset: sol,
    quoteAsset: usdc,
    spotAdapters: Object.freeze([adapterRef({ adapterId: "spot-adapter-v1", adapterManifestVersion: 1, adapterManifestHash: "55".repeat(32) })]),
    perpAdapters: Object.freeze([adapterRef({ adapterId: "perp-adapter-v1", adapterManifestVersion: 1, adapterManifestHash: "66".repeat(32) })]),
    settlementClass: "ATOMIC_POSTCONDITION",
    expiryUnit: "SOLANA_SLOT",
    expiryTtl: 1_000n,
    spotReferencePrice: exactPrice({ baseAsset: sol, quoteAsset: usdc, quoteAtoms: 3n, baseAtoms: 20n, roundingDirection: "CEIL" }),
    maxEntrySpread: exactSignedRate({ baseAsset: sol, quoteAsset: usdc, quoteAtoms: 1n, baseAtoms: 400n, roundingDirection: "CEIL" }),
    maximumQuantityAtoms: 10_000_000_000n,
    maxSlippageBps: 100,
    maxVenueFeeAtomsByAsset: Object.freeze([]),
    maxMarginAddedAtoms: 20_000_000n,
    maxProtocolFeeAtoms: 100_000n,
    maxSolverFeeAtoms: 100_000n,
    maxPriorityFeeAtoms: 100_000n,
    minVenueReserveReturnedAtoms: 0n,
    minWalletQuoteBalanceDeltaAtoms: 0n,
    maxResidualBaseQuantityAtoms: 0n,
  });
}

function signedOrder(idempotencyKey = "evidence-order-0001") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const owner = bs58.encode(raw);
  const active = context();
  const created = createCanonicalEntryOrder((contextId) => (contextId === active.contextId ? active : undefined), {
    contextId: active.contextId,
    owner,
    settlementAccount: owner,
    sizeAtoms: 1_000_000_000n,
    slippageBps: 10,
    idempotencyKey,
    currentClock: 1_000_500n,
  });
  const signOrder = (order: PackageOrderInput) => bs58.encode(sign(null, Buffer.from(packageOrderBytes(order)), privateKey));
  return { order: created.order as PackageOrderInput, orderHashHex: toHex(created.orderHash), signature: signOrder(created.order), signOrder };
}

function manifest(orderHash: Uint8Array): EvidenceManifestInput {
  return {
    manifestVersion: 1,
    environment: "testnet",
    domain,
    orderHash,
    entries: [
      { sequence: 0n, kind: "ATTEMPT", attemptId: "attempt-1", reference: "attempt-1", contentHash: hash(50), observedAtValue: 10n },
      { sequence: 1n, kind: "CHAIN_TRANSACTION", attemptId: "attempt-1", reference: "tx-1", contentHash: hash(51), observedAtValue: 11n },
    ],
  };
}

const outcomeEvidence = ["evidenceManifestHash", "orderHash", "terminalState"].map((fieldId) => ({ fieldId, grade: "CONSENSUS_VERIFIED" as const, onchainEnforced: true }));

function outcome(orderHash: Uint8Array, overrides: Partial<TerminalOutcomeInput> = {}): TerminalOutcomeInput {
  return {
    outcomeVersion: 1,
    environment: "testnet",
    domain,
    orderHash,
    packageTemplateManifestHash: "44".repeat(32),
    templateRegistryReference: hash(4),
    terminalState: "NO_EFFECT",
    attemptIds: ["attempt-1"],
    responseAvailability: "ABSENT",
    responseAbsenceReason: "chain-event-only",
    authoritativeEvidenceRefs: [hash(51)],
    evidenceManifestHash: evidenceManifestHash(manifest(orderHash)),
    residualValuationApplicability: "NOT_APPLICABLE",
    authorizedResidualValue: { availability: "NOT_APPLICABLE" },
    terminalResidualMark: { availability: "NOT_APPLICABLE" },
    issuerKind: "CONSENSUS_EVENT",
    issuer: "verifier-program",
    fieldEvidence: outcomeEvidence,
    timestampValue: 1_790_000_000_000n,
    ...overrides,
  };
}

function receipt(orderHash: Uint8Array, overrides: Partial<PackageReceiptInput> = {}): PackageReceiptInput {
  return {
    receiptVersion: 1,
    environment: "testnet",
    domain,
    attemptIds: ["attempt-1"],
    orderedActionEvidenceRefs: [hash(51)],
    orderedOrderEvidenceRefs: [],
    orderedFillEvidenceRefs: [],
    transactionIds: ["tx-1"],
    evidenceManifestHash: evidenceManifestHash(manifest(orderHash)),
    orderHash,
    quoteHash: hash(2),
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: "44".repeat(32),
    templateRegistryReference: hash(4),
    solverCapabilityManifestHash: hash(5),
    packageMarketId: "sol-carry",
    owner: "owner",
    solver: "solver-a",
    action: "ENTRY",
    settlementClass: "ATOMIC_POSTCONDITION",
    terminalState: "FINALIZED_COMPLETE",
    quantity: 1_000_000_000n,
    spotVenue: "phoenix",
    perpVenue: "drift",
    spotExecutionPrice: 148_240_000n,
    perpExecutionPrice: 149_070_000n,
    perpPriceEnforcement: "CONTRACT_ENFORCED",
    spotQuoteDelta: -148_240_000n,
    externalQuoteBalanceDelta: -148_240_000n,
    venueWithdrawableQuoteDelta: 0n,
    exitOutcomeSchemaVersion: 1,
    authoritativePreStateRefs: [{ locator: "slot-1", accountKey: "owner", component: "spot-balance", value: 0n, unit: "sol", evidenceHash: hash(54) }],
    authoritativePostStateRefs: [{ locator: "slot-2", accountKey: "owner", component: "spot-balance", value: 1_000_000_000n, unit: "sol", evidenceHash: hash(55) }],
    perpPositionDelta: -1_000_000_000n,
    marginDelta: 20_000_000n,
    matchedPackageNotional: 148_240_000n,
    grossLegNotional: 297_310_000n,
    rawFillFeesByAsset: [assetAmount(usdc, 9_000n)],
    builderFeesByAsset: [],
    normalizedVenueFeesByAsset: [assetAmount(usdc, 9_000n)],
    protocolFee: assetAmount(usdc, 5_000n),
    solverFee: assetAmount(usdc, 10_000n),
    feePolicyVersion: 3,
    feePolicyManifestHash: hash(6),
    maxResidualBaseQuantityObserved: 0n,
    timeUnhedgedMs: 0n,
    recoveryCostByAsset: [],
    recoveryRefundByAsset: [],
    priorityFee: assetAmount(usdc, 5_000n),
    finalityStatus: "FINALIZED",
    fieldEvidence: ["evidenceManifestHash", "orderHash", "protocolFee", "quantity", "quoteHash", "solverFee", "spotExecutionPrice", "terminalState"]
      .map((fieldId) => ({ fieldId, grade: "CONSENSUS_VERIFIED" as const, onchainEnforced: true })),
    timestampValue: 1_790_000_000_000n,
    ...overrides,
  };
}

const terms: AcceptedQuoteFeeTerms = {
  protocolFee: assetAmount(usdc, 5_000n),
  solverFee: assetAmount(usdc, 10_000n),
  feePolicyVersion: 3,
  feePolicyManifestHash: hash(6),
  maxRecoveryCostByAsset: [],
};

function withEvidence(run: (store: SqliteEvidenceStore, dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "naryx-evidence-"));
  const store = new SqliteEvidenceStore(join(dir, "evidence.sqlite"), { clock: () => 1_000 });
  return Promise.resolve(run(store, dir)).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

test("orders enter only with the owner's signature over exact bytes, one order per owner nonce", async () => {
  await withEvidence((store) => {
    const { order, orderHashHex, signature, signOrder } = signedOrder();
    assert.deepEqual(store.submitOrder(order, signature), { orderHashHex, replayed: false });
    assert.deepEqual(store.submitOrder(order, signature), { orderHashHex, replayed: true });
    assert.equal(store.getOrder(orderHashHex)?.owner, order.owner);
    const other = signedOrder("evidence-order-0002");
    assert.throws(() => store.submitOrder(other.order, signature), { code: "INVALID_SIGNATURE" });
    const sameNonce = { ...order, expiryValue: order.expiryValue + 1n };
    assert.throws(() => store.submitOrder(sameNonce, signOrder(sameNonce)), { code: "NONCE_REUSED" });
    assert.throws(() => store.submitOrder({ ...order, owner: "0x1111111111111111111111111111111111111111" }, signature), { code: "UNSUPPORTED_AUTHORIZATION" });
    assert.deepEqual(store.openOrders(0, 10).map((entry) => entry.orderHashHex), [orderHashHex]);
  });
});

test("a terminal outcome is recorded once, with its receipt and fees checked against the accepted quote", async () => {
  await withEvidence((store) => {
    const orderHash = hash(1);
    const successful = outcome(orderHash, {
      terminalState: "FINALIZED_COMPLETE",
      successfulReceiptHash: packageReceiptHash(receipt(orderHash)),
    });
    assert.throws(() => store.recordOutcome({ evidenceManifest: manifest(orderHash), outcome: successful }), { code: "RECEIPT_REQUIRED" });
    const overcharged = receipt(orderHash, { solverFee: assetAmount(usdc, 10_001n) });
    assert.throws(
      () => store.recordOutcome({
        evidenceManifest: manifest(orderHash),
        outcome: { ...successful, successfulReceiptHash: packageReceiptHash(overcharged) },
        receipt: overcharged,
        acceptedQuoteFeeTerms: terms,
      }),
      { code: "FEE_VIOLATION" },
    );
    const recorded = store.recordOutcome({ evidenceManifest: manifest(orderHash), outcome: successful, receipt: receipt(orderHash), acceptedQuoteFeeTerms: terms });
    assert.equal(recorded.receiptHashHex, toHex(packageReceiptHash(receipt(orderHash))));
    assert.equal(store.recordOutcome({ evidenceManifest: manifest(orderHash), outcome: successful, receipt: receipt(orderHash), acceptedQuoteFeeTerms: terms }).replayed, true);
    const differentManifest = { ...manifest(orderHash), entries: manifest(orderHash).entries.slice(0, 1) };
    assert.throws(() => store.recordOutcome({ evidenceManifest: differentManifest, outcome: successful }), { code: "EVIDENCE_MISMATCH" });
    assert.throws(
      () => store.recordOutcome({ evidenceManifest: manifest(hash(9)), outcome: outcome(hash(9)), receipt: receipt(hash(9)) }),
      { code: "RECEIPT_NOT_EXPECTED" },
    );
    const quality = store.executionQuality();
    assert.equal(quality.terminalOutcomes, 1);
    assert.equal(quality.successfulBps, 10_000);
    assert.deepEqual(quality.timeUnhedgedMs, { median: 0n, p95: 0n, max: 0n });
  });
});

test("public routes serve signed orders, recorded outcomes with their hashes, and measured analytics", async () => {
  await withEvidence(async (evidence, dir) => {
    const exchange = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
    const handler = createPublicApiHandler({ exchange, evidence, nowValue: () => NOW, rateLimit: { windowMs: 60_000, maxRequests: 1_000 } });
    const server = createServer((request, response) => {
      if (!handler(request, response)) {
        response.statusCode = 418;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(toProtocolJson(body)) }),
      });
      return { status: response.status, body: fromProtocolJson(JSON.parse(await response.text())) as Record<string, unknown> };
    };
    try {
      const { order, orderHashHex, signature } = signedOrder();
      const submitted = await call("POST", "/v1/orders", { order, authorization: { scheme: "ED25519", signature } });
      assert.equal(submitted.status, 200);
      assert.equal(submitted.body.orderHash ?? submitted.body.orderHashHex, orderHashHex);
      assert.equal((await call("POST", "/v1/orders", { order, authorization: { scheme: "EIP712", signature } })).status, 400);
      const open = await call("GET", `/v1/orders/${orderHashHex}`);
      assert.equal(open.body.status, "OPEN");
      assert.equal((await call("GET", `/v1/receipts/${orderHashHex}`)).status, 404);

      const orderHash = Buffer.from(orderHashHex, "hex");
      evidence.recordOutcome({ evidenceManifest: manifest(orderHash), outcome: outcome(orderHash) });
      const closed = await call("GET", `/v1/orders/${orderHashHex}`);
      assert.equal(closed.body.status, "NO_EFFECT");
      const receipts = await call("GET", `/v1/receipts/${orderHashHex}`);
      assert.equal(receipts.body.terminalState, "NO_EFFECT");
      assert.equal(receipts.body.receipt, undefined);
      assert.equal(receipts.body.evidenceManifestHash, toHex(evidenceManifestHash(manifest(orderHash))));
      const outcomeRead = await call("GET", `/v1/outcomes/${orderHashHex}`);
      assert.equal(outcomeRead.body.terminalState, "NO_EFFECT");
      assert.equal(outcomeRead.body.outcomeHash, receipts.body.outcomeHash);
      assert.equal(outcomeRead.body.receipt, undefined);
      assert.equal((await call("GET", `/v1/outcomes/${"cd".repeat(32)}`)).status, 404);
      const quality = await call("GET", "/v1/analytics/execution-quality");
      assert.equal(quality.body.label, "OBSERVED");
      assert.equal(quality.body.terminalOutcomes, 1);
      assert.equal((await call("GET", "/v1/orders/not-a-hash")).status, 400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      exchange.close();
    }
  });
});
