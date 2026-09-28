import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import {
  SqliteExecutionIntentStore,
  SqliteInternalOrderStore,
  createCanonicalEntryOrder,
  createLocalAtomicOrderRuntime,
  type SolverAtomicQuoteResponse,
} from "../src/index.js";

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
    assert.match(attempt.attemptId, /^local-atomic-[0-9a-f]{64}$/);
    assert.equal(attempt.status, "AUTHORIZED_QUOTE_SELECTED");
    intents.close();
    intents = new SqliteExecutionIntentStore(intentDb);
    assert.deepEqual(intents.getAttempt(attempt.attemptId), attempt);
    assert.deepEqual(intents.getSelectedQuote(attempt.attemptId), quote);
  } finally {
    intents.close();
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
