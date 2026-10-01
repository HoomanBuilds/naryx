import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import { domainRef } from "@naryx/protocol-types";
import {
  SqliteExecutionIntentStore,
  SqliteInternalOrderStore,
  createCanonicalEntryOrder,
  createLocalAtomicOrderRuntime,
  type SolverAtomicQuoteResponse,
  type ActiveOrderContext,
  type InternalOrderRecord,
} from "../src/index.js";

function createOrder(
  orders: SqliteInternalOrderStore,
  context: ActiveOrderContext,
  key: string,
): InternalOrderRecord {
  const canonical = createCanonicalEntryOrder(
    (contextId) => contextId === context.contextId ? context : undefined,
    {
      contextId: context.contextId,
      owner: "0x1111111111111111111111111111111111111111",
      settlementAccount: "0x2222222222222222222222222222222222222222",
      sizeAtoms: 1_000_000n,
      slippageBps: 10,
      idempotencyKey: key,
      currentClock: 5_000n,
    },
  );
  return orders.createOrGet({
    order: canonical,
    request: {
      contextId: context.contextId,
      owner: "0x1111111111111111111111111111111111111111",
      settlementAccount: "0x2222222222222222222222222222222222222222",
      sizeAtoms: 1_000_000n,
      slippageBps: 10,
      idempotencyKey: key,
      currentClock: 5_000n,
    },
  }).record;
}

function quoteFor(orderHash: string, suffix: string): SolverAtomicQuoteResponse {
  return {
    version: 1,
    status: "SIGNED",
    idempotencyKey: `intent-quote-key-${suffix}`,
    orderHash,
    routeHash: suffix.repeat(64),
    quoteHash: String(Number(suffix) + 1).repeat(64),
    solverSignatureDigest: String(Number(suffix) + 2).repeat(64),
    routeBytes: "01",
    solverQuoteBytes: "02",
    route: {},
    quote: {},
  };
}

test("durably binds trader authorization and selected quote into one attempt", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-execution-intent-"));
  const orderDb = join(scratch, "orders.db");
  const intentDb = join(scratch, "intents.db");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const owner = bs58.encode(spki.subarray(spki.length - 32));
  const runtime = createLocalAtomicOrderRuntime(undefined, () => 5_000n);
  const canonical = createCanonicalEntryOrder(runtime.contexts, {
    contextId: runtime.catalog.contextId,
    owner,
    settlementAccount: runtime.catalog.programs.core,
    sizeAtoms: 1_000_000n,
    slippageBps: 10,
    idempotencyKey: "intent-order-key-0001",
    currentClock: 5_000n,
  });
  const orders = new SqliteInternalOrderStore(orderDb);
  const created = orders.createOrGet({
    order: canonical,
    request: {
      contextId: runtime.catalog.contextId,
      owner,
      settlementAccount: runtime.catalog.programs.core,
      sizeAtoms: 1_000_000n,
      slippageBps: 10,
      idempotencyKey: "intent-order-key-0001",
      currentClock: 5_000n,
    },
  }).record;
  const signature = bs58.encode(sign(null, Buffer.from(canonical.orderBytes), privateKey));
  const quote: SolverAtomicQuoteResponse = {
    version: 1,
    status: "SIGNED",
    idempotencyKey: "intent-quote-key-0001",
    orderHash: created.orderHashHex,
    routeHash: "71".repeat(32),
    quoteHash: "72".repeat(32),
    solverSignatureDigest: "73".repeat(32),
    routeBytes: "01",
    solverQuoteBytes: "02",
    route: {},
    quote: {},
  };
  let intents = new SqliteExecutionIntentStore(intentDb);
  try {
    assert.throws(() => intents.selectQuote(created.orderHashHex, quote.quoteHash), /authorization/i);
    assert.throws(() => intents.authorize(created, bs58.encode(new Uint8Array(64))), /does not authorize/);
    assert.equal(intents.authorize(created, signature).orderHash, created.orderHashHex);
    intents.recordQuote(quote);
    const attempt = intents.selectQuote(created.orderHashHex, quote.quoteHash);
    const expectedAttemptId = `local-atomic-${createHash("sha256")
      .update("NARYX/local-execution-attempt/v1", "ascii")
      .update(Buffer.from(created.orderHashHex, "hex"))
      .update(Buffer.from(quote.routeHash, "hex"))
      .update(Buffer.from(quote.quoteHash, "hex"))
      .digest("hex")}`;
    assert.equal(attempt.attemptId, expectedAttemptId);
    assert.equal(attempt.status, "AUTHORIZED_QUOTE_SELECTED");
    intents.close();
    intents = new SqliteExecutionIntentStore(intentDb);
    assert.deepEqual(intents.getAttempt(attempt.attemptId), attempt);
    assert.deepEqual(intents.getAttemptForOrder(created.orderHashHex), attempt);
    assert.deepEqual(intents.getSelectedQuote(attempt.attemptId), quote);
  } finally {
    intents.close();
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("durably selects a Base Sepolia quote before trader permit authorization", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-base-selection-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const local = createLocalAtomicOrderRuntime(undefined, () => 5_000n);
  const localContext = local.contexts(local.catalog.contextId)!;
  const baseContext = Object.freeze({
    ...localContext,
    contextId: "base-sepolia-atomic-v1",
    domain: domainRef("eip155:84532", 1, "81".repeat(32)),
    environment: "testnet",
    expiryUnit: "EVM_UNIX_SECONDS" as const,
  });
  const baseOrder = createOrder(orders, baseContext, "base-order-key-0001");
  const firstQuote = quoteFor(baseOrder.orderHashHex, "3");
  const conflictingQuote = quoteFor(baseOrder.orderHashHex, "6");
  let intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
  try {
    intents.recordQuote(firstQuote);
    intents.recordQuote(conflictingQuote);
    const attempt = intents.selectQuoteForOrder(baseOrder, baseContext.domain, firstQuote.quoteHash);
    assert.match(attempt.attemptId, /^base-atomic-[0-9a-f]{52}$/);
    assert.equal(attempt.status, "BASE_ATOMIC_QUOTE_SELECTED");
    assert.equal(attempt.domainId, "eip155:84532");
    assert.equal(attempt.domainManifestVersion, 1);
    assert.equal(attempt.domainManifestHash, "81".repeat(32));
    assert.deepEqual(
      intents.selectQuoteForOrder(baseOrder, baseContext.domain, firstQuote.quoteHash),
      attempt,
    );
    assert.throws(
      () => intents.selectQuoteForOrder(baseOrder, baseContext.domain, conflictingQuote.quoteHash),
      /different quote/i,
    );
    intents.close();
    intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
    assert.deepEqual(intents.getAttempt(attempt.attemptId), attempt);
    assert.deepEqual(intents.getSelectedQuote(attempt.attemptId), firstQuote);
  } finally {
    intents.close();
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("durably selects Arbitrum Sepolia async quotes and rejects domain mismatches", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-domain-selection-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const local = createLocalAtomicOrderRuntime(undefined, () => 5_000n);
  const localContext = local.contexts(local.catalog.contextId)!;
  const solanaOrder = createOrder(orders, localContext, "solana-order-key-001");
  const arbitrumContext = Object.freeze({
    ...localContext,
    contextId: "arbitrum-sepolia-atomic-v1",
    domain: domainRef("eip155:421614", 1, "91".repeat(32)),
    environment: "testnet",
    expiryUnit: "EVM_UNIX_SECONDS" as const,
  });
  const arbitrumOrder = createOrder(orders, arbitrumContext, "arb-order-key-00001");
  const intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
  try {
    const solanaQuote = quoteFor(solanaOrder.orderHashHex, "4");
    const arbitrumQuote = quoteFor(arbitrumOrder.orderHashHex, "7");
    intents.recordQuote(solanaQuote);
    intents.recordQuote(arbitrumQuote);
    assert.throws(
      () => intents.selectQuoteForOrder(solanaOrder, localContext.domain, solanaQuote.quoteHash),
      /authorization is required/i,
    );
    const attempt = intents.selectQuoteForOrder(
      arbitrumOrder,
      arbitrumContext.domain,
      arbitrumQuote.quoteHash,
    );
    assert.match(attempt.attemptId, /^arbitrum-async-[0-9a-f]{48}$/);
    assert.equal(attempt.status, "ARBITRUM_ASYNC_QUOTE_SELECTED");
    assert.deepEqual(intents.getAttempt(attempt.attemptId), attempt);
    assert.deepEqual(intents.getSelectedQuote(attempt.attemptId), arbitrumQuote);
    assert.throws(
      () => intents.selectQuoteForOrder(
        arbitrumOrder,
        domainRef("eip155:421614", 1, "92".repeat(32)),
        arbitrumQuote.quoteHash,
      ),
      /recognized manifest identity/i,
    );
  } finally {
    intents.close();
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
