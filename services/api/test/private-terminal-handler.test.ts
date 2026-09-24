import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  createPrivateTerminalServer,
  SOLANA_DEVNET_GENESIS_HASH,
  type NormalizedCashCarryExecutionRequest,
  type UnsignedSolanaDevnetMaterializationDto,
} from "../src/index.js";

const TRADER_PUBLIC_KEY = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const RECENT_BLOCKHASH = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const MESSAGE_BASE64 = "gAEAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAAA=";
const TRANSACTION_BASE64 = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAAAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAAA==";

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
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

test("private terminal validates previews and injected Devnet preparation", async () => {
  const origin = "http://127.0.0.1:3000";
  const server = createPrivateTerminalServer({
    host: "127.0.0.1",
    port: 0,
    terminalOrigin: origin,
  });
  const serverUrl = await listen(server);
  const endpoint = `${serverUrl}/internal/terminal/preview`;

  try {
    const unavailable = await fetch(`${serverUrl}/internal/terminal/execution/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        domain: "svm:devnet",
        mode: "entry",
        size: "100.000001",
        slippageBps: 10,
        quoteMode: "coordinated_limits",
        traderPublicKey: TRADER_PUBLIC_KEY,
        idempotencyKey: "test-prepare-0001",
      }),
    });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: {
        code: "EXECUTION_UNAVAILABLE",
        message: "Devnet execution preparation is unavailable.",
      },
    });

    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        domain: "solana",
        mode: "entry",
        size: "100.000001",
        slippageBps: 10,
        quoteMode: "coordinated_limits",
      }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("access-control-allow-origin"), origin);
    const preview = await accepted.json() as {
      source: string;
      executionAvailable: boolean;
      size: { baseAtoms: string };
      bound: { quoteAtoms: string };
      legs: unknown[];
    };
    assert.equal(preview.source, "PRIVATE_TERMINAL_BFF");
    assert.equal(preview.executionAvailable, false);
    assert.equal(preview.size.baseAtoms, "100000001");
    assert.match(preview.bound.quoteAtoms, /^\d+$/);
    assert.equal(preview.legs.length, 2);

    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        domain: "solana",
        mode: "entry",
        size: "100",
        slippageBps: 10,
        quoteMode: "coordinated_limits",
        adapter: "untrusted",
      }),
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {
      error: {
        code: "INVALID_FIELDS",
        message: "Request must contain only domain, mode, size, slippageBps, and quoteMode.",
      },
    });
  } finally {
    await close(server);
  }

  const materialization: UnsignedSolanaDevnetMaterializationDto = {
    domain: "svm:devnet",
    domainManifestVersion: 1,
    domainManifestHash: "11".repeat(32),
    planKind: "TRADER_ENTRY",
    messageBase64: MESSAGE_BASE64,
    transactionBase64: TRANSACTION_BASE64,
    requiredSignerPubkeys: [TRADER_PUBLIC_KEY],
    recentBlockhash: RECENT_BLOCKHASH,
    blockhashContextSlot: 100,
    lastValidBlockHeight: 250,
    genesisHash: SOLANA_DEVNET_GENESIS_HASH,
    lookupTables: [],
    evidence: {
      resolvedAddressCount: 1,
      serializedMessageBytes: 71,
      serializedTransactionBytes: 136,
      packetDataLimit: 1232,
      computeUnitLimit: 200_000,
      computeUnitLimitSource: "EXPLICIT",
      routeComputeUnitLimit: 1_260_000,
    },
    requestCommitment: "22".repeat(32),
  };
  const received: NormalizedCashCarryExecutionRequest[] = [];
  const executionServer = createPrivateTerminalServer({
    host: "127.0.0.1",
    port: 0,
    terminalOrigin: origin,
  }, {
    preparation: {
      prepare: async (request) => {
        received.push(request);
        return materialization;
      },
    },
  });
  const executionUrl = await listen(executionServer);
  try {
    const accepted = await fetch(`${executionUrl}/internal/terminal/execution/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        domain: "svm:devnet",
        mode: "entry",
        size: "100.000001",
        slippageBps: 10,
        quoteMode: "coordinated_limits",
        traderPublicKey: TRADER_PUBLIC_KEY,
        idempotencyKey: "test-prepare-0001",
      }),
    });
    assert.equal(accepted.status, 200);
    const prepared = await accepted.json() as {
      status: string;
      environment: string;
      domain: string;
      planKind: string;
      transactionBase64: string;
      requiredSignerPubkeys: string[];
    };
    assert.equal(prepared.status, "DEVNET_UNSIGNED_REVIEW_REQUIRED");
    assert.equal(prepared.environment, "DEVNET");
    assert.equal(prepared.domain, "svm:devnet");
    assert.equal(prepared.planKind, "TRADER_ENTRY");
    assert.equal(prepared.transactionBase64, TRANSACTION_BASE64);
    assert.deepEqual(prepared.requiredSignerPubkeys, [TRADER_PUBLIC_KEY]);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.sizeAtoms, "100000001");

    const malformed = await fetch(`${executionUrl}/internal/terminal/execution/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        domain: "svm:devnet",
        mode: "entry",
        size: "100.000001",
        slippageBps: 10,
        quoteMode: "coordinated_limits",
        traderPublicKey: TRADER_PUBLIC_KEY,
        idempotencyKey: "test-prepare-0001",
        rpcUrl: "https://example.invalid",
      }),
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      error: {
        code: "INVALID_FIELDS",
        message: "Request must contain only domain, mode, size, slippageBps, quoteMode, traderPublicKey, and idempotencyKey.",
      },
    });
    assert.equal(received.length, 1);
  } finally {
    await close(executionServer);
  }
});
