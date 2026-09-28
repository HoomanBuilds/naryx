import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adapterRef,
  assetRef,
  domainRef,
  exactPrice,
  exactSignedRate,
  toHex,
} from "@naryx/protocol-types";
import {
  createCanonicalEntryOrder,
  InternalOrderConflictError,
  InternalOrderStoreError,
  SqliteInternalOrderStore,
  type ActiveOrderContext,
  type ActiveOrderContextProvider,
} from "../src/index.js";

const BASE_HASH = "22".repeat(32);
const QUOTE_HASH = "33".repeat(32);

function activeContext(): ActiveOrderContext {
  const base = assetRef("svm:testnet:sol", BASE_HASH, 9);
  const quote = assetRef("svm:testnet:usdc", QUOTE_HASH, 6);
  return Object.freeze({
    contextId: "test-context-1",
    state: "ACTIVE",
    capturedAtClock: 1_000_000n,
    maxStaleness: 1_000_000n,
    domain: domainRef("svm:testnet", 1, "11".repeat(32)),
    environment: "testnet",
    orderVersion: 1,
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: "44".repeat(32),
    baseAsset: base,
    quoteAsset: quote,
    spotAdapters: Object.freeze([
      adapterRef({
        adapterId: "spot-adapter-v1",
        adapterManifestVersion: 1,
        adapterManifestHash: "55".repeat(32),
      }),
    ]),
    perpAdapters: Object.freeze([
      adapterRef({
        adapterId: "perp-adapter-v1",
        adapterManifestVersion: 1,
        adapterManifestHash: "66".repeat(32),
      }),
    ]),
    settlementClass: "ATOMIC_POSTCONDITION",
    expiryUnit: "SOLANA_SLOT",
    expiryTtl: 1_000n,
    spotReferencePrice: exactPrice({
      baseAsset: base,
      quoteAsset: quote,
      quoteAtoms: 3n,
      baseAtoms: 20n,
      roundingDirection: "CEIL",
    }),
    maxEntrySpread: exactSignedRate({
      baseAsset: base,
      quoteAsset: quote,
      quoteAtoms: 1n,
      baseAtoms: 400n,
      roundingDirection: "CEIL",
    }),
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

test("internal order store persists canonical entry orders across reopen", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-api-orders-"));
  const dbPath = join(scratch, "orders.db");
  const context = activeContext();
  const provider: ActiveOrderContextProvider = (contextId) =>
    contextId === context.contextId ? context : undefined;
  const request = Object.freeze({
    contextId: "test-context-1",
    owner: "owner-1",
    settlementAccount: "strategy-account-1",
    sizeAtoms: 1_000_000_000n,
    slippageBps: 10,
    idempotencyKey: "test-store-key-0001",
    currentClock: 1_000_500n,
  });
  const canonical = createCanonicalEntryOrder(provider, request);
  const store = new SqliteInternalOrderStore(dbPath);
  try {
    const created = store.createOrGet({ order: canonical, request });
    assert.equal(created.created, true);
    assert.equal(created.record.idempotencyKey, request.idempotencyKey);
    assert.equal(created.record.requestCommitmentHex, toHex(canonical.requestCommitment));
    assert.equal(created.record.orderHashHex, toHex(canonical.orderHash));
    assert.deepEqual(
      Buffer.from(created.record.orderBase64, "base64"),
      Buffer.from(canonical.orderBytes),
    );
    assert.equal(created.record.contextId, request.contextId);
    assert.equal(created.record.domainId, canonical.order.domain.domainId);
    assert.equal(created.record.domainManifestVersion, canonical.order.domain.domainManifestVersion);
    assert.equal(
      created.record.domainManifestHashHex,
      toHex(canonical.order.domain.domainManifestHash),
    );
    assert.equal(created.record.owner, request.owner);
    assert.equal(created.record.settlementAccount, request.settlementAccount);
    assert.equal(created.record.nonceDecimal, canonical.order.nonce.toString(10));
    assert.equal(created.record.status, "UNSIGNED_CREATED");
    assert.ok(Number.isSafeInteger(created.record.createdAtMs) && created.record.createdAtMs > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(created.record)), { ...created.record });

    const replayed = store.createOrGet({ order: canonical, request });
    assert.equal(replayed.created, false);
    assert.deepEqual(replayed.record, created.record);

    const conflicting = createCanonicalEntryOrder(provider, {
      ...request,
      sizeAtoms: 2_000_000_000n,
    });
    assert.throws(
      () => store.createOrGet({ order: conflicting, request: { ...request } }),
      (error: unknown) =>
        error instanceof InternalOrderConflictError && error.code === "IDEMPOTENCY_CONFLICT",
    );

    const forgedBytes = Uint8Array.from(canonical.orderBytes);
    forgedBytes[0] = (forgedBytes[0] as number) ^ 0xff;
    assert.throws(
      () =>
        store.createOrGet({
          order: { ...canonical, orderBytes: forgedBytes },
          request: { ...request, idempotencyKey: "test-store-key-0002" },
        }),
      (error: unknown) =>
        error instanceof InternalOrderStoreError && error.code === "INVALID_INPUT",
    );
    assert.equal(store.getByIdempotencyKey("test-store-key-0002"), undefined);

    assert.deepEqual(store.getByIdempotencyKey(request.idempotencyKey), created.record);
    assert.deepEqual(store.getByOrderHash(canonical.orderHash), created.record);
    assert.deepEqual(store.getByOrderHash(toHex(canonical.orderHash)), created.record);
    assert.deepEqual(store.getCanonicalOrderByHash(canonical.orderHash), canonical.order);
  } finally {
    store.close();
  }

  const reopened = new SqliteInternalOrderStore(dbPath);
  try {
    const persisted = reopened.getByIdempotencyKey(request.idempotencyKey);
    assert.deepEqual(persisted, reopened.getByOrderHash(toHex(canonical.orderHash)));
    assert.ok(persisted !== undefined);
    assert.equal(persisted.orderHashHex, toHex(canonical.orderHash));
    assert.equal(persisted.nonceDecimal, canonical.order.nonce.toString(10));
    assert.deepEqual(reopened.getCanonicalOrderByHash(canonical.orderHash), canonical.order);
    const replayed = reopened.createOrGet({ order: canonical, request });
    assert.equal(replayed.created, false);
    assert.deepEqual(replayed.record, persisted);
  } finally {
    reopened.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
