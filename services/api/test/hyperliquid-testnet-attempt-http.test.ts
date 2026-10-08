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
    }, prepareSelectedSource: () => HANDOFF },
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

  const sourceAttemptId = `hyperliquid-testnet-${"11".repeat(24)}`;
  const sourceResponse = await fetch(
    `${origin}/internal/solver/hyperliquid-testnet/source-attempts/${sourceAttemptId}`,
  );
  assert.equal(sourceResponse.status, 200);
  assert.deepEqual(
    parseProtocolJson(await sourceResponse.text(), "test.sourceHandoff"),
    { version: 1, attempt: HANDOFF },
  );
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
    }, prepareSelectedSource: () => {
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
  const domainManifestHash = new Uint8Array(32).fill(4);
  const packageTemplateManifestHash = new Uint8Array(32).fill(5);
  const domain = {
    domainId: "hypercore:testnet",
    domainManifestVersion: 1,
    domainManifestHash,
  };
  const staging: HyperliquidGeneralizedOrderPort = {
    stage: (requested) => {
      assert.equal(requested, sourceOrderHash);
      return {
        sourceOrderHash,
        order: {
          environment: "TESTNET",
          templateId: "cash-and-carry-v1",
          templateVersion: 1,
          packageTemplateManifestHash,
          lifecycleAction: "ENTRY",
          seriesId: "btc-cash-carry-usdc",
          executionClassId: "hyperliquid-testnet-batched-ioc",
          expiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
          expiryValue: 120_000n,
        },
        graph: { legs: [{ domain }] },
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
    rfqContext: {
      environment: "TESTNET",
      domain: {
        domainId: "hypercore:testnet",
        domainManifestVersion: 1,
        domainManifestHash: "04".repeat(32),
      },
      templateId: "cash-and-carry-v1",
      templateVersion: 1,
      packageTemplateManifestHash: "05".repeat(32),
      expiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
      expiryValue: "120000",
    },
  });
  assert.equal((await fetch(`${origin}/internal/terminal/strategy-orders/stage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceOrderHash, extra: true }),
  })).status, 400);
});

test("private terminal selects exactly the reviewed generalized Hyperliquid quote", async (context) => {
  const nativeOwner = "0x1111111111111111111111111111111111111111";
  const sourceOrderHash = "11".repeat(32);
  const orderHash = "22".repeat(32);
  const quoteHash = "33".repeat(32);
  const routeHash = "44".repeat(32);
  const attemptId = `strategy-hl-${"55".repeat(24)}`;
  const sourceAttemptId = `hyperliquid-testnet-${"77".repeat(24)}`;
  const idempotencyKey = "strategy-selection-0001";
  const sourceAttempt = {
    attemptId: sourceAttemptId,
    orderHash: sourceOrderHash,
    routeHash: "88".repeat(32),
    quoteHash: "99".repeat(32),
    status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED",
    selectedAtMs: 900,
    domainId: "hypercore:testnet",
    domainManifestVersion: 1,
    domainManifestHash: "aa".repeat(32),
  } as const;
  const selectedAttempt = {
    attemptId,
    idempotencyKey,
    orderHashHex: orderHash,
    graphHashHex: "66".repeat(32),
    quoteHashHex: quoteHash,
    routeHashHex: routeHash,
    sourceOrderHashHex: sourceOrderHash,
    status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED",
    selectedAtMs: 1_000,
  } as const;
  const nativeAttempt = {
    attemptId: `strategy-hl-${"56".repeat(24)}`,
    idempotencyKey: "strategy-selection-0002",
    orderHashHex: orderHash,
    graphHashHex: "66".repeat(32),
    quoteHashHex: quoteHash,
    routeHashHex: routeHash,
    status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED",
    selectedAtMs: 1_001,
  } as const;
  const server = createPrivateTerminalServer(
    { host: "127.0.0.1", port: 0, terminalOrigin: null },
    {}, undefined, undefined, {}, undefined, undefined, {
      getAttemptForOrder: (requested: string) => {
        assert.equal(requested, sourceOrderHash);
        return sourceAttempt;
      },
    } as never, undefined,
    undefined, "DISABLED", undefined, undefined, undefined, undefined, undefined,
    undefined, {}, undefined, () => [], undefined, undefined, {
      selectHyperliquidExecution: (request) => {
        assert.deepEqual(request, {
          quoteHashHex: quoteHash,
          orderHashHex: orderHash,
          routeHashHex: routeHash,
          sourceOrderHashHex: sourceOrderHash,
          idempotencyKey,
        });
        return selectedAttempt;
      },
      strategyExecutionAttempt: (requested) => requested === attemptId ? selectedAttempt : undefined,
      selectNativeHyperliquidExecution: (request) => {
        assert.deepEqual(request, {
          quoteHashHex: quoteHash,
          orderHashHex: orderHash,
          routeHashHex: routeHash,
          idempotencyKey: nativeAttempt.idempotencyKey,
        });
        return nativeAttempt;
      },
      nativeStrategyExecutionAttempt: (requested) => requested === nativeAttempt.attemptId ? nativeAttempt : undefined,
      anyStrategyExecutionAttempt: (requested) => requested === nativeAttempt.attemptId
        ? nativeAttempt : requested === attemptId ? selectedAttempt : undefined,
      nativeStrategyPositionsByOwner: (requested) => {
        assert.equal(requested, nativeOwner);
        return [{
          strategyId: "native-hl-position",
          owner: nativeOwner,
          templateId: "treasury-inventory-hedge-v1",
          economicQuantityAtoms: 200_000n,
          entryOrderHashHex: "12".repeat(32),
          entryReceiptHashHex: "13".repeat(32),
          stateHashHex: "14".repeat(32),
          state: { ownerId: nativeOwner, stateVersion: 1n },
          status: "OPEN",
          recordedAtMs: 1_000,
          updatedAtMs: 1_000,
        }] as never;
      },
      quotes: (requested) => {
        assert.equal(requested, orderHash);
        return [{
          quoteHashHex: quoteHash,
          routeHashHex: routeHash,
          quote: {
            version: 1,
            solverId: "solver-a",
            netPackageOutcome: { atoms: 42n },
          },
          route: {},
          recordedAtMs: 1_002,
        }] as never;
      },
    },
  );
  context.after(() => server.close());
  const origin = await listen(server);
  const response = await fetch(`${origin}/internal/terminal/strategy-executions/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderHash, quoteHash, routeHash, sourceOrderHash, idempotencyKey }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    version: 1,
    ...selectedAttempt,
  });
  const metadata = await fetch(`${origin}/internal/solver/hyperliquid-testnet/strategy-attempts/${attemptId}`);
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), { version: 1, attempt: selectedAttempt, sourceAttemptId });
  const native = await fetch(`${origin}/internal/terminal/strategy-executions/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderHash,
      quoteHash,
      routeHash,
      idempotencyKey: nativeAttempt.idempotencyKey,
    }),
  });
  assert.equal(native.status, 200);
  assert.deepEqual(await native.json(), { version: 2, ...nativeAttempt });
  const positions = await fetch(`${origin}/internal/terminal/native-strategies?owner=${nativeOwner}`);
  assert.equal(positions.status, 200);
  assert.deepEqual(parseProtocolJson(await positions.text()), {
    version: 1,
    owner: nativeOwner,
    positions: [{
      strategyId: "native-hl-position",
      owner: nativeOwner,
      templateId: "treasury-inventory-hedge-v1",
      economicQuantityAtoms: 200_000n,
      entryOrderHashHex: "12".repeat(32),
      entryReceiptHashHex: "13".repeat(32),
      stateHashHex: "14".repeat(32),
      state: { ownerId: nativeOwner, stateVersion: 1n },
      status: "OPEN",
      recordedAtMs: 1_000,
      updatedAtMs: 1_000,
    }],
  });
  assert.equal((await fetch(`${origin}/internal/terminal/native-strategies?owner=${nativeOwner}&extra=1`)).status, 400);
  const quoteHistory = await fetch(`${origin}/internal/terminal/strategy-orders/${orderHash}/quotes`);
  assert.equal(quoteHistory.status, 200);
  assert.deepEqual(parseProtocolJson(await quoteHistory.text()), {
    version: 1,
    orderHash,
    quotes: [{
      quoteHashHex: quoteHash,
      routeHashHex: routeHash,
      quote: {
        version: 1,
        solverId: "solver-a",
        netPackageOutcome: { atoms: 42n },
      },
      recordedAtMs: 1_002,
    }],
  });
  assert.equal((await fetch(`${origin}/internal/terminal/strategy-orders/${orderHash}/quotes?other=1`)).status, 400);
  assert.equal((await fetch(`${origin}/internal/terminal/strategy-executions/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderHash, quoteHash, routeHash, sourceOrderHash, idempotencyKey, extra: true }),
  })).status, 400);
});

test("private terminal rejects generalized selection without a selected Hyperliquid source", async (context) => {
  const sourceOrderHash = "11".repeat(32);
  const server = createPrivateTerminalServer(
    { host: "127.0.0.1", port: 0, terminalOrigin: null },
    {}, undefined, undefined, {}, undefined, undefined, {
      getAttemptForOrder: () => undefined,
    } as never, undefined,
    undefined, "DISABLED", undefined, undefined, undefined, undefined, undefined,
    undefined, {}, undefined, () => [], undefined, undefined, {
      selectHyperliquidExecution: () => {
        throw new Error("selection must not be reached");
      },
      strategyExecutionAttempt: () => undefined,
      selectNativeHyperliquidExecution: () => { throw new Error("native selection must not be reached"); },
      nativeStrategyExecutionAttempt: () => undefined,
      anyStrategyExecutionAttempt: () => undefined,
    },
  );
  context.after(() => server.close());
  const origin = await listen(server);
  const response = await fetch(`${origin}/internal/terminal/strategy-executions/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderHash: "22".repeat(32),
      quoteHash: "33".repeat(32),
      routeHash: "44".repeat(32),
      sourceOrderHash,
      idempotencyKey: "strategy-selection-0002",
    }),
  });
  assert.equal(response.status, 409);
  const body = await response.json() as { readonly error: { readonly code: string } };
  assert.equal(body.error.code, "SOURCE_ATTEMPT_REQUIRED");
});

test("private terminal prepares and records exact strategy order authorization", async (context) => {
  const orderHash = "22".repeat(32);
  const signature = `0x${"33".repeat(65)}`;
  const owner = "0x4444444444444444444444444444444444444444";
  const typedData = {
    domain: { name: "Naryx Strategy Package Testnet", version: "1" },
    types: { StrategyPackageAuthorization: [{ name: "orderHash", type: "bytes32" }] },
    primaryType: "StrategyPackageAuthorization",
    message: { orderHash: `0x${orderHash}` },
  } as const;
  const server = createPrivateTerminalServer(
    { host: "127.0.0.1", port: 0, terminalOrigin: null },
    {}, undefined, undefined, {}, undefined, undefined, undefined, undefined,
    undefined, "DISABLED", undefined, undefined, undefined, undefined, undefined,
    undefined, {}, undefined, () => [], undefined, undefined, undefined, {
      prepare: (requested) => {
        assert.equal(requested, orderHash);
        return { version: 1, status: "UNSIGNED_STRATEGY_ORDER", orderHash, owner, typedData: typedData as never };
      },
      authorize: async (requested, submittedSignature) => {
        assert.equal(requested, orderHash);
        assert.equal(submittedSignature, signature);
        return {
          version: 1,
          status: "OWNER_AUTHORIZED",
          created: true,
          authorization: {
            orderHashHex: orderHash,
            owner,
            scheme: "EIP712_SECP256K1",
            signature,
            authorizedAtMs: 1_000,
          },
        };
      },
    },
  );
  context.after(() => server.close());
  const origin = await listen(server);
  const challenge = await fetch(`${origin}/internal/terminal/strategy-orders/authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderHash }),
  });
  assert.equal(challenge.status, 200);
  assert.deepEqual(await challenge.json(), {
    version: 1,
    status: "UNSIGNED_STRATEGY_ORDER",
    orderHash,
    owner,
    typedData,
  });
  const authorization = await fetch(`${origin}/internal/terminal/strategy-orders/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderHash, signature }),
  });
  assert.equal(authorization.status, 200);
  assert.equal((await authorization.json() as { status: string }).status, "OWNER_AUTHORIZED");
});
