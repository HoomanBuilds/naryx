import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adapterRef,
  assetRef,
  domainRef,
  exactPrice,
  exactSignedRate,
} from "@naryx/protocol-types";
import {
  createCanonicalEntryOrder,
  createPrivateTerminalServer,
  SqliteExecutionIntentStore,
  SqliteInternalOrderStore,
  type ActiveOrderContext,
  type ActiveOrderContextProvider,
  type SolverAtomicQuoteRequest,
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

async function listen(server: ReturnType<typeof createPrivateTerminalServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createPrivateTerminalServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test("internal terminal orders create, replay, retrieve, and conflict in one flow", async () => {
  const origin = "http://127.0.0.1:3000";
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: origin };
  const unavailable = createPrivateTerminalServer(config);
  const unavailableUrl = await listen(unavailable);
  try {
    const postUnavailable = await fetch(`${unavailableUrl}/internal/terminal/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        contextId: "test-context-1",
        owner: "owner-1",
        settlementAccount: "strategy-account-1",
        size: "1",
        slippageBps: 10,
        idempotencyKey: "test-order-key-0001",
      }),
    });
    assert.equal(postUnavailable.status, 503);
    assert.deepEqual(await postUnavailable.json(), {
      error: { code: "ORDER_CREATION_UNAVAILABLE", message: "Order creation is unavailable." },
    });
    const getUnavailable = await fetch(
      `${unavailableUrl}/internal/terminal/orders/${"ab".repeat(32)}`,
    );
    assert.equal(getUnavailable.status, 503);
  } finally {
    await close(unavailable);
  }

  const scratch = mkdtempSync(join(tmpdir(), "naryx-api-terminal-orders-"));
  const context = activeContext();
  const provider: ActiveOrderContextProvider = (contextId) =>
    contextId === context.contextId ? context : undefined;
  const store = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  try {
    const quoteRequests: SolverAtomicQuoteRequest[] = [];
    const orderPorts = {
      contexts: provider,
      store,
      clock: { currentClock: async () => 1_000_500n },
    };
    const server = createPrivateTerminalServer(config, {}, orderPorts, undefined, {}, undefined, {
      quote: async (request) => {
        quoteRequests.push(request);
        return {
          version: 1,
          status: "SIGNED",
          idempotencyKey: request.idempotencyKey,
          orderHash: request.orderHash,
          routeHash: "71".repeat(32),
          quoteHash: "72".repeat(32),
          solverSignatureDigest: "73".repeat(32),
          routeBytes: "01",
          solverQuoteBytes: "02",
          route: { orderHash: request.orderHash },
          quote: {
            orderHash: request.orderHash,
            routeHash: "71".repeat(32),
            solverSignatureScheme: "ED25519",
            quoteMode: "EXECUTION_COMMITMENT",
            signature: "74".repeat(64),
          },
        };
      },
    });
    const serverUrl = await listen(server);
    try {
      const body = {
        contextId: "test-context-1",
        owner: "owner-1",
        settlementAccount: "strategy-account-1",
        size: "1",
        slippageBps: 10,
        idempotencyKey: "test-order-key-0001",
      };
      const createdResponse = await fetch(`${serverUrl}/internal/terminal/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      });
      assert.equal(createdResponse.status, 201);
      assert.equal(createdResponse.headers.get("cache-control"), "no-store");
      const created = (await createdResponse.json()) as {
        status: string;
        created: boolean;
        order: { orderHashHex: string; idempotencyKey: string; status: string };
        note: string;
      };
      assert.equal(created.status, "UNSIGNED_CREATED");
      assert.equal(created.created, true);
      assert.match(created.order.orderHashHex, /^[0-9a-f]{64}$/);
      assert.equal(created.order.idempotencyKey, body.idempotencyKey);
      assert.equal(created.order.status, "UNSIGNED_CREATED");
      assert.match(created.note, /trader authorization/i);
      assert.match(created.note, /solver quoting/i);
      assert.deepEqual(JSON.parse(JSON.stringify(created)), created);

      const replayResponse = await fetch(`${serverUrl}/internal/terminal/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      });
      assert.equal(replayResponse.status, 200);
      const replayed = (await replayResponse.json()) as {
        created: boolean;
        order: { orderHashHex: string };
      };
      assert.equal(replayed.created, false);
      assert.equal(replayed.order.orderHashHex, created.order.orderHashHex);

      const retrievedResponse = await fetch(
        `${serverUrl}/internal/terminal/orders/${created.order.orderHashHex}`,
        { headers: { Origin: origin } },
      );
      assert.equal(retrievedResponse.status, 200);
      const retrieved = (await retrievedResponse.json()) as {
        orderHashHex: string;
        idempotencyKey: string;
        nonceDecimal: string;
      };
      assert.equal(retrieved.orderHashHex, created.order.orderHashHex);
      assert.equal(retrieved.idempotencyKey, body.idempotencyKey);

      const solverOrderResponse = await fetch(
        `${serverUrl}/internal/solver/orders/${created.order.orderHashHex}`,
      );
      assert.equal(solverOrderResponse.status, 200);
      const solverOrder = await solverOrderResponse.json() as {
        version: number;
        orderHash: string;
        order: { nonce: { $naryxType: string; value: string } };
      };
      assert.equal(solverOrder.version, 1);
      assert.equal(solverOrder.orderHash, created.order.orderHashHex);
      assert.deepEqual(solverOrder.order.nonce, {
        $naryxType: "bigint",
        value: retrieved.nonceDecimal,
      });

      const quoteResponse = await fetch(
        `${serverUrl}/internal/terminal/orders/${created.order.orderHashHex}/quote`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({ idempotencyKey: "test-quote-key-0001" }),
        },
      );
      assert.equal(quoteResponse.status, 200);
      const quoted = await quoteResponse.json() as { status: string; orderHash: string };
      assert.equal(quoted.status, "SIGNED");
      assert.equal(quoted.orderHash, created.order.orderHashHex);
      assert.deepEqual(quoteRequests, [{
        orderHash: created.order.orderHashHex,
        idempotencyKey: "test-quote-key-0001",
      }]);

      const conflictResponse = await fetch(`${serverUrl}/internal/terminal/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ ...body, size: "2" }),
      });
      assert.equal(conflictResponse.status, 409);
      assert.deepEqual(await conflictResponse.json(), {
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: `Idempotency key "${body.idempotencyKey}" was already used with a different request commitment.`,
        },
      });
    } finally {
      await close(server);
    }
  } finally {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Base Sepolia quote selection is durable and readable before trader permit", async () => {
  const origin = "http://127.0.0.1:3000";
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: origin };
  const scratch = mkdtempSync(join(tmpdir(), "naryx-api-base-selection-"));
  const context = Object.freeze({
    ...activeContext(),
    contextId: "base-sepolia-atomic-v1",
    domain: domainRef("eip155:84532", 1, "81".repeat(32)),
    expiryUnit: "EVM_UNIX_SECONDS" as const,
  });
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
  const orderPorts = {
    contexts: (contextId: string) => contextId === context.contextId ? context : undefined,
    store: orders,
    clock: { currentClock: async () => 1_000_500n },
  };
  const solverQuotePort = {
    quote: async (request: SolverAtomicQuoteRequest) => ({
      version: 1 as const,
      status: "SIGNED" as const,
      idempotencyKey: request.idempotencyKey,
      orderHash: request.orderHash,
      routeHash: "71".repeat(32),
      quoteHash: "72".repeat(32),
      solverSignatureDigest: "73".repeat(32),
      routeBytes: "01",
      solverQuoteBytes: "02",
      route: { orderHash: request.orderHash },
      quote: { orderHash: request.orderHash, routeHash: "71".repeat(32) },
    }),
  };
  const server = createPrivateTerminalServer(
    config,
    {},
    orderPorts,
    undefined,
    {},
    undefined,
    solverQuotePort,
    intents,
  );
  const serverUrl = await listen(server);
  try {
    const createdResponse = await fetch(`${serverUrl}/internal/terminal/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        contextId: context.contextId,
        owner: "0x1111111111111111111111111111111111111111",
        settlementAccount: "0x2222222222222222222222222222222222222222",
        size: "1",
        slippageBps: 10,
        idempotencyKey: "base-order-key-0001",
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { order: { orderHashHex: string } };
    const quoteResponse = await fetch(
      `${serverUrl}/internal/terminal/orders/${created.order.orderHashHex}/quote`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ idempotencyKey: "base-quote-key-0001" }),
      },
    );
    assert.equal(quoteResponse.status, 200);
    const selectedResponse = await fetch(
      `${serverUrl}/internal/terminal/orders/${created.order.orderHashHex}/select`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ quoteHash: "72".repeat(32) }),
      },
    );
    assert.equal(selectedResponse.status, 201);
    const selected = await selectedResponse.json() as {
      status: string;
      attempt: { attemptId: string; status: string; domainId: string };
    };
    assert.equal(selected.status, "BASE_ATOMIC_QUOTE_SELECTED");
    assert.equal(selected.attempt.status, "BASE_ATOMIC_QUOTE_SELECTED");
    assert.equal(selected.attempt.domainId, "eip155:84532");
    assert.match(selected.attempt.attemptId, /^base-atomic-[0-9a-f]{52}$/);

    const readResponse = await fetch(
      `${serverUrl}/internal/terminal/attempts/${selected.attempt.attemptId}`,
      { headers: { Origin: origin } },
    );
    assert.equal(readResponse.status, 200);
    const read = await readResponse.json() as {
      attempt: { attemptId: string; status: string };
      quote: { quoteHash: string };
    };
    assert.equal(read.attempt.attemptId, selected.attempt.attemptId);
    assert.equal(read.attempt.status, "BASE_ATOMIC_QUOTE_SELECTED");
    assert.equal(read.quote.quoteHash, "72".repeat(32));
  } finally {
    await close(server);
    intents.close();
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Arbitrum Sepolia selected attempts are readable by the terminal and the loopback solver", async () => {
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: null };
  const scratch = mkdtempSync(join(tmpdir(), "naryx-api-arbitrum-attempt-"));
  const context = Object.freeze({
    ...activeContext(),
    contextId: "arbitrum-sepolia-async-v1",
    domain: domainRef("eip155:421614", 1, "91".repeat(32)),
    expiryUnit: "EVM_UNIX_SECONDS" as const,
  });
  const contexts = (contextId: string) => contextId === context.contextId ? context : undefined;
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
  const request = {
    contextId: context.contextId,
    owner: "0x1111111111111111111111111111111111111111",
    settlementAccount: "0x2222222222222222222222222222222222222222",
    sizeAtoms: 1_000_000n,
    slippageBps: 10,
    idempotencyKey: "arb-order-key-00001",
    currentClock: 1_000_500n,
  };
  const order = orders.createOrGet({ order: createCanonicalEntryOrder(contexts, request), request }).record;
  intents.recordQuote({
    version: 1,
    status: "SIGNED",
    idempotencyKey: "arb-quote-key-00001",
    orderHash: order.orderHashHex,
    routeHash: "71".repeat(32),
    quoteHash: "72".repeat(32),
    solverSignatureDigest: "73".repeat(32),
    routeBytes: "01",
    solverQuoteBytes: "02",
    route: {},
    quote: {},
  });
  const attempt = intents.selectQuoteForOrder(order, context.domain, "72".repeat(32));
  const server = createPrivateTerminalServer(
    config,
    {},
    { contexts, store: orders, clock: { currentClock: async () => 1_000_500n } },
    undefined,
    {},
    undefined,
    undefined,
    intents,
  );
  const serverUrl = await listen(server);
  try {
    assert.match(attempt.attemptId, /^arbitrum-async-[0-9a-f]{48}$/);
    const terminal = await fetch(`${serverUrl}/internal/terminal/attempts/${attempt.attemptId}`);
    assert.equal(terminal.status, 200);
    const read = await terminal.json() as { attempt: { attemptId: string; status: string }; quote: { quoteHash: string } };
    assert.equal(read.attempt.attemptId, attempt.attemptId);
    assert.equal(read.attempt.status, "ARBITRUM_ASYNC_QUOTE_SELECTED");
    assert.equal(read.quote.quoteHash, "72".repeat(32));

    const solver = await fetch(`${serverUrl}/internal/solver/attempts/${attempt.attemptId}`);
    assert.equal(solver.status, 200);
    const handoff = await solver.json() as { attemptId: string; orderHash: string; quoteHash: string };
    assert.equal(handoff.attemptId, attempt.attemptId);
    assert.equal(handoff.orderHash, order.orderHashHex);
    assert.equal(handoff.quoteHash, "72".repeat(32));

    assert.equal((await fetch(`${serverUrl}/internal/terminal/attempts/arbitrum-async-${"0".repeat(48)}`)).status, 404);
  } finally {
    await close(server);
    intents.close();
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
