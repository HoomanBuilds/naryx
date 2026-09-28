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
  createPrivateTerminalServer,
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
