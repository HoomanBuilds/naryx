import assert from "node:assert/strict";
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
  createCanonicalExitOrder,
  createLocalAtomicOrderRuntime,
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

test("canonical entry builds atomic order and rejects inactive context", () => {
  const context = activeContext();
  const provider: ActiveOrderContextProvider = (contextId) =>
    contextId === context.contextId ? context : undefined;
  const request = Object.freeze({
    contextId: "test-context-1",
    owner: "owner-1",
    settlementAccount: "strategy-account-1",
    sizeAtoms: 1_000_000_000n,
    slippageBps: 10,
    idempotencyKey: "test-entry-key-0001",
    currentClock: 1_000_500n,
  });
  const first = createCanonicalEntryOrder(provider, request);
  assert.equal(first.order.action, "ENTRY");
  assert.equal(first.order.settlementClass, "ATOMIC_POSTCONDITION");
  assert.equal(first.order.quantity.atoms, 1_000_000_000n);
  assert.equal(first.order.expiryValue, 1_001_500n);
  assert.ok(first.order.maxSpotQuoteIn !== undefined && first.order.maxSpotQuoteIn.atoms > 0n);
  assert.ok(first.orderBytes instanceof Uint8Array && first.orderBytes.length > 0);
  assert.equal(first.orderHash.length, 32);
  assert.equal(first.requestCommitment.length, 32);
  assert.ok(first.order.nonce > 0n && first.order.nonce <= 0xffff_ffff_ffff_ffffn);
  const second = createCanonicalEntryOrder(provider, request);
  assert.equal(toHex(second.orderHash), toHex(first.orderHash));
  assert.equal(toHex(second.requestCommitment), toHex(first.requestCommitment));
  assert.equal(second.order.nonce, first.order.nonce);
  const clockRetry = createCanonicalEntryOrder(provider, { ...request, currentClock: 1_000_600n });
  assert.equal(toHex(clockRetry.requestCommitment), toHex(first.requestCommitment));
  assert.equal(clockRetry.order.nonce, first.order.nonce);
  assert.equal(clockRetry.order.expiryValue, 1_001_600n);
  assert.notEqual(toHex(clockRetry.orderHash), toHex(first.orderHash));
  const resized = createCanonicalEntryOrder(provider, { ...request, sizeAtoms: 2_000_000_000n });
  assert.notEqual(toHex(resized.requestCommitment), toHex(first.requestCommitment));

  const paused: ActiveOrderContext = Object.freeze({ ...context, state: "ALL_PAUSED" });
  const pausedProvider: ActiveOrderContextProvider = (contextId) =>
    contextId === paused.contextId ? paused : undefined;
  assert.throws(() => createCanonicalEntryOrder(pausedProvider, request), /not active/);
});

test("canonical exit binds the entry receipt and exact authoritative position", () => {
  const context = activeContext();
  const provider: ActiveOrderContextProvider = (contextId) =>
    contextId === context.contextId ? context : undefined;
  const exit = createCanonicalExitOrder(provider, {
    contextId: context.contextId,
    owner: "owner-1",
    settlementAccount: "strategy-account-1",
    entryReceiptHash: new Uint8Array(32).fill(7),
    positionSizeAtoms: 1_000_000_000n,
    positionEntryNotionalAtoms: 150_000_000n,
    minSpotQuoteOutAtoms: 140_000_000n,
    minExitQuoteOutcomeAtoms: 140_000_000n,
    idempotencyKey: "test-exit-key-00001",
    currentClock: 1_000_500n,
  });
  assert.equal(exit.order.action, "EXIT");
  assert.equal(exit.order.expectedPrePositionSize.atoms, -1_000_000_000n);
  assert.equal(exit.order.expectedPrePositionEntryNotional.atoms, 150_000_000n);
  assert.equal(exit.order.minSpotQuoteOut?.atoms, 140_000_000n);
  assert.equal(exit.order.maxResidualBaseQuantity.atoms, 0n);
  assert.ok(exit.order.nonce > 0n && exit.order.nonce <= 0xffff_ffff_ffff_ffffn);
  assert.deepEqual(exit.order.entryReceiptHash, new Uint8Array(32).fill(7));
});

test("shared local catalog produces active order and clock ports", async () => {
  const runtime = createLocalAtomicOrderRuntime(undefined, () => 5_000n);
  const context = runtime.contexts("local:svm:sol-carry-v1");
  assert.ok(context !== undefined);
  assert.equal(context.environment, "local");
  assert.equal(context.domain.domainId, "svm:local");
  assert.equal(context.spotAdapters[0]?.adapterId, "solana-conformance-v1");
  assert.equal(await runtime.clock.currentClock(context), 5_000n);
  assert.equal(runtime.contexts("unknown"), undefined);
});
