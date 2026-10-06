import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { parseProtocolJson } from "@naryx/protocol-types";
import {
  createPrivateTerminalServer,
  HyperliquidTestnetRuntimeClientError,
  type HyperliquidTestnetAttemptPreparation,
} from "../src/index.js";
import type { HyperliquidGeneralizedOrderPort } from "../src/hyperliquid-generalized-order.js";

const ATTEMPT_ID = "hypercore-attempt-0001";
const HANDOFF = Object.freeze({
  attemptId: ATTEMPT_ID,
  admission: Object.freeze({ orderHash: new Uint8Array(32).fill(1) }),
  seriesManifestHash: "22".repeat(32),
  executionClassManifestHash: "33".repeat(32),
  market: Object.freeze({}),
  limits: Object.freeze({}),
  selectedAtMs: 1_000,
}) as unknown as HyperliquidTestnetAttemptPreparation;

async function listen(server: ReturnType<typeof createPrivateTerminalServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("private Hyperliquid attempt endpoint returns only the canonical prepared handoff", async (context) => {
  const server = createPrivateTerminalServer(
    { host: "127.0.0.1", port: 0, terminalOrigin: null },
    {}, undefined, undefined, {}, undefined, undefined, undefined, undefined,
    undefined, "PHASE4_FIXTURE", undefined,
    { prepare: (attemptId) => {
      assert.equal(attemptId, ATTEMPT_ID);
      return HANDOFF;
    } },
  );
  context.after(() => server.close());
  const origin = await listen(server);
  const response = await fetch(
    `${origin}/internal/solver/hyperliquid-testnet/attempts/${ATTEMPT_ID}`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    parseProtocolJson(await response.text(), "test.handoff"),
    { version: 1, attempt: HANDOFF },
  );

  const method = await fetch(
    `${origin}/internal/solver/hyperliquid-testnet/attempts/${ATTEMPT_ID}`,
    { method: "POST" },
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET");
});

test("private Hyperliquid attempt endpoint stays unavailable and maps missing attempts", async (context) => {
  const unavailable = createPrivateTerminalServer(
    { host: "127.0.0.1", port: 0, terminalOrigin: null },
  );
  context.after(() => unavailable.close());
  const unavailableOrigin = await listen(unavailable);
  assert.equal((await fetch(
    `${unavailableOrigin}/internal/solver/hyperliquid-testnet/attempts/${ATTEMPT_ID}`,
  )).status, 503);

  const missing = createPrivateTerminalServer(
    { host: "127.0.0.1", port: 0, terminalOrigin: null },
    {}, undefined, undefined, {}, undefined, undefined, undefined, undefined,
    undefined, "PHASE4_FIXTURE", undefined,
    { prepare: () => {
      throw new HyperliquidTestnetRuntimeClientError("ATTEMPT_NOT_FOUND", "missing");
    } },
  );
  context.after(() => missing.close());
  const missingOrigin = await listen(missing);
  assert.equal((await fetch(
    `${missingOrigin}/internal/solver/hyperliquid-testnet/attempts/${ATTEMPT_ID}`,
  )).status, 404);
});

test("private terminal stages a reviewed Hyperliquid order for generalized quoting", async (context) => {
  const sourceOrderHash = "11".repeat(32);
  const orderHash = "22".repeat(32);
  const graphHash = "33".repeat(32);
  const staging: HyperliquidGeneralizedOrderPort = {
    stage: (requested) => {
      assert.equal(requested, sourceOrderHash);
      return {
        sourceOrderHash,
        order: {
          templateId: "cash-and-carry-v1",
          lifecycleAction: "ENTRY",
          seriesId: "btc-cash-carry-usdc",
          executionClassId: "hyperliquid-testnet-batched-ioc",
        },
        graph: {},
        intake: {
          version: 1,
          status: "STORED_FOR_QUOTING",
          created: true,
          orderHashHex: orderHash,
          graphHashHex: graphHash,
          currentTime: { unit: "HYPERLIQUID_UNIX_MILLISECONDS", value: 1n },
          timeSource: "SERVER",
          stages: [],
        },
      } as never;
    },
  };
  const server = createPrivateTerminalServer(
    { host: "127.0.0.1", port: 0, terminalOrigin: null },
    {}, undefined, undefined, {}, undefined, undefined, undefined, undefined,
    undefined, "DISABLED", undefined, undefined, undefined, undefined, undefined,
    undefined, {}, undefined, () => [], undefined, staging,
  );
  context.after(() => server.close());
  const origin = await listen(server);
  const response = await fetch(`${origin}/internal/terminal/strategy-orders/stage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceOrderHash }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    version: 1,
    status: "STORED_FOR_QUOTING",
    created: true,
    sourceOrderHash,
    orderHash,
    graphHash,
    templateId: "cash-and-carry-v1",
    lifecycleAction: "ENTRY",
    seriesId: "btc-cash-carry-usdc",
    executionClassId: "hyperliquid-testnet-batched-ioc",
  });
  assert.equal((await fetch(`${origin}/internal/terminal/strategy-orders/stage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceOrderHash, extra: true }),
  })).status, 400);
});
