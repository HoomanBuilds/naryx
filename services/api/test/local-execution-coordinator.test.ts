import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import {
  createCanonicalEntryOrder,
  createLocalAtomicOrderRuntime,
  createPrivateTerminalServer,
  LocalExecutionCoordinator,
  LocalExecutionCoordinatorError,
  SqliteExecutionIntentStore,
  SqliteInternalOrderStore,
  SqlitePackageLifecycleStore,
  type ExecutionIntentStore,
  type SolverAtomicQuoteResponse,
} from "../src/index.js";

function fixture(scratch: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const owner = bs58.encode(spki.subarray(spki.length - 32));
  const runtime = createLocalAtomicOrderRuntime(undefined, () => 5_000n);
  const request = {
    contextId: runtime.catalog.contextId,
    owner,
    settlementAccount: runtime.catalog.programs.core,
    sizeAtoms: 1_000_000n,
    slippageBps: 10,
    idempotencyKey: "execution-order-key-0001",
    currentClock: 5_000n,
  };
  const canonical = createCanonicalEntryOrder(runtime.contexts, request);
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const record = orders.createOrGet({ order: canonical, request }).record;
  const intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
  intents.authorize(
    record,
    bs58.encode(sign(null, Buffer.from(canonical.orderBytes), privateKey)),
  );
  const quote: SolverAtomicQuoteResponse = {
    version: 1,
    status: "SIGNED",
    idempotencyKey: "execution-quote-key-0001",
    orderHash: record.orderHashHex,
    routeHash: "71".repeat(32),
    quoteHash: "72".repeat(32),
    solverSignatureDigest: "73".repeat(32),
    routeBytes: "01",
    solverQuoteBytes: "02",
    route: {},
    quote: {},
  };
  intents.recordQuote(quote);
  const attempt = intents.selectQuote(record.orderHashHex, quote.quoteHash);
  let timestamp = 10_000n;
  const lifecyclePath = join(scratch, "lifecycle.db");
  const lifecycle = new SqlitePackageLifecycleStore(lifecyclePath, {
    clock: () => timestamp++,
  });
  const coordinator = new LocalExecutionCoordinator({ intents, orders, lifecycle });
  return { attempt, coordinator, intents, lifecycle, lifecyclePath, orders };
}

async function listen(server: ReturnType<typeof createPrivateTerminalServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: ReturnType<typeof createPrivateTerminalServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

test("durably coordinates the deterministic local lifecycle including recovery", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-local-execution-"));
  const setup = fixture(scratch);
  let lifecycle = setup.lifecycle;
  try {
    const prepared = setup.coordinator.prepare(setup.attempt.attemptId);
    assert.equal(prepared.state, "ENTRY_PREPARED");
    assert.deepEqual(prepared.receipts.map((receipt) => receipt.nextState), [
      "PACKAGE_CREATED",
      "ENTRY_PREPARED",
    ]);

    lifecycle.close();
    lifecycle = new SqlitePackageLifecycleStore(setup.lifecyclePath, { clock: () => 20_000n });
    const coordinator = new LocalExecutionCoordinator({
      intents: setup.intents,
      orders: setup.orders,
      lifecycle,
    });
    const opened = coordinator.open(setup.attempt.attemptId);
    assert.deepEqual(opened.receipts.map((receipt) => receipt.nextState), [
      "PACKAGE_CREATED",
      "ENTRY_PREPARED",
      "ENTRY_SUBMITTED",
      "ENTRY_CONFIRMED",
      "OPEN",
    ]);
    const ambiguous = coordinator.recordObservationAmbiguity(setup.attempt.attemptId);
    assert.equal(ambiguous.state, "RECOVERY_PENDING");
    assert.equal(ambiguous.receipts.at(-1)?.onchainEnforced, false);
    assert.equal(ambiguous.receipts.at(-1)?.evidenceGrade, "LOCAL_RECORDED");
    assert.equal(coordinator.recoverController(setup.attempt.attemptId).state, "OPEN");
    const completed = coordinator.close(setup.attempt.attemptId);
    assert.equal(completed.state, "CLOSED");
    assert.deepEqual(completed.receipts.slice(-3).map((receipt) => receipt.nextState), [
      "EXIT_REQUESTED",
      "EXIT_SUBMITTED",
      "CLOSED",
    ]);
    assert.deepEqual(coordinator.close(setup.attempt.attemptId), completed);
    assert.equal(coordinator.recordObservationAmbiguity(setup.attempt.attemptId).state, "CLOSED");
    assert.equal(coordinator.recoverController(setup.attempt.attemptId).state, "CLOSED");
  } finally {
    lifecycle.close();
    setup.intents.close();
    setup.orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("advances a submitted manifest execution only from bound consensus evidence", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-local-consensus-execution-"));
  const setup = fixture(scratch);
  try {
    setup.coordinator.prepare(setup.attempt.attemptId);
    setup.coordinator.submit(setup.attempt.attemptId);
    const evidence = new Uint8Array(32).fill(9);
    const opened = setup.coordinator.recordConsensusOpen(setup.attempt.attemptId, evidence);
    assert.equal(opened.state, "OPEN");
    assert.deepEqual(opened.receipts.slice(-2).map((receipt) => ({
      state: receipt.nextState,
      grade: receipt.evidenceGrade,
      onchain: receipt.onchainEnforced,
    })), [
      { state: "ENTRY_CONFIRMED", grade: "CONSENSUS_VERIFIED", onchain: true },
      { state: "OPEN", grade: "CONSENSUS_VERIFIED", onchain: true },
    ]);
    assert.deepEqual(setup.coordinator.recordConsensusOpen(setup.attempt.attemptId, evidence), opened);
    assert.throws(
      () => setup.coordinator.recordConsensusOpen(setup.attempt.attemptId, new Uint8Array(32).fill(8)),
      (error: unknown) => error instanceof LocalExecutionCoordinatorError
        && error.code === "ATTEMPT_BINDING_MISMATCH",
    );
  } finally {
    setup.lifecycle.close();
    setup.intents.close();
    setup.orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("fails closed without an authorized selected attempt and serves narrow actions", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-local-execution-http-"));
  const setup = fixture(scratch);
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: null };
  const server = createPrivateTerminalServer(
    config,
    {},
    undefined,
    undefined,
    {},
    setup.lifecycle,
    undefined,
    setup.intents,
    setup.coordinator,
  );
  const origin = await listen(server);
  try {
    assert.throws(
      () => setup.coordinator.prepare(`local-atomic-${"00".repeat(32)}`),
      (error: unknown) => error instanceof LocalExecutionCoordinatorError
        && error.code === "ATTEMPT_NOT_FOUND",
    );
    const mismatchedIntents: ExecutionIntentStore = {
      authorize: setup.intents.authorize.bind(setup.intents),
      getAuthorization: setup.intents.getAuthorization.bind(setup.intents),
      recordQuote: setup.intents.recordQuote.bind(setup.intents),
      selectQuote: setup.intents.selectQuote.bind(setup.intents),
      getAttempt: setup.intents.getAttempt.bind(setup.intents),
      getSelectedQuote: (attemptId) => {
        const quote = setup.intents.getSelectedQuote(attemptId);
        return quote === undefined ? undefined : { ...quote, routeHash: "99".repeat(32) };
      },
      close: () => undefined,
    };
    const mismatched = new LocalExecutionCoordinator({
      intents: mismatchedIntents,
      orders: setup.orders,
      lifecycle: setup.lifecycle,
    });
    assert.throws(
      () => mismatched.prepare(setup.attempt.attemptId),
      (error: unknown) => error instanceof LocalExecutionCoordinatorError
        && error.code === "ATTEMPT_BINDING_MISMATCH",
    );
    const opened = await fetch(
      `${origin}/internal/terminal/attempts/${setup.attempt.attemptId}/open`,
      { method: "POST" },
    );
    assert.equal(opened.status, 200);
    const body = await opened.json() as {
      action: string;
      state: string;
      receipts: Array<{ revision: { $naryxType: string; value: string }; nextState: string }>;
    };
    assert.equal(body.action, "open");
    assert.equal(body.state, "OPEN");
    assert.equal(body.receipts.length, 5);
    assert.deepEqual(body.receipts[4]?.revision, { $naryxType: "bigint", value: "5" });
    assert.equal(body.receipts[4]?.nextState, "OPEN");

    const method = await fetch(
      `${origin}/internal/terminal/attempts/${setup.attempt.attemptId}/close`,
    );
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "POST, OPTIONS");
  } finally {
    await close(server);
    setup.lifecycle.close();
    setup.intents.close();
    setup.orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
