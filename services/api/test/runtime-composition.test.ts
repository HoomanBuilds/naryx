import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  composePrivateTerminalRuntime,
  createPrivateTerminalServer,
  loadPrivateTerminalStartupConfig,
  privateTerminalHealthSummary,
  runtimeFailureMessage,
  type EvmTestnetTerminalPorts,
  type HyperliquidTestnetEvidenceRuntime,
  type HyperliquidTestnetTerminalExecutionPort,
  type PrivateTerminalExecutionPorts,
} from "../src/index.js";

const ENABLED = {
  NARYX_SOLANA_DEVNET_RUNTIME_ENABLED: "true",
  NARYX_BASE_TESTNET_RUNTIME_ENABLED: "true",
  NARYX_ARBITRUM_TESTNET_RUNTIME_ENABLED: "true",
  NARYX_HYPERLIQUID_TESTNET_RUNTIME_ENABLED: "true",
  NARYX_HYPERLIQUID_TESTNET_EXECUTOR_CLIENT_ENABLED: "true",
  NARYX_HYPERLIQUID_TESTNET_EVIDENCE_ENABLED: "true",
};

const solanaPorts = {
  preparation: { prepare: async () => ({}) },
  observation: { observe: async () => ({}) },
} as unknown as PrivateTerminalExecutionPorts;
const evmPorts = {
  authorization: { prepare: async () => ({}) },
  preparation: { prepare: async () => ({}) },
  atomicObservation: { observe: async () => ({}) },
  asyncObservation: { observe: async () => ({}) },
} as unknown as EvmTestnetTerminalPorts;
const hyperliquidPort = {
  execute: async () => ({}),
} as unknown as HyperliquidTestnetTerminalExecutionPort;

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

test("runtime composition exposes only explicitly enabled complete boundaries", () => {
  let disabledCalls = 0;
  const disabled = composePrivateTerminalRuntime({}, {
    solanaDevnet: () => {
      disabledCalls += 1;
      return solanaPorts;
    },
  });
  assert.equal(disabledCalls, 0);
  assert.deepEqual(disabled.solanaDevnet, {});
  assert.deepEqual(disabled.health.solanaDevnet, {
    available: false,
    reason: "DISABLED_BY_CONFIGURATION",
  });

  let evmCalls = 0;
  const enabled = composePrivateTerminalRuntime(ENABLED, {
    solanaDevnet: () => solanaPorts,
    evmTestnet: () => {
      evmCalls += 1;
      return evmPorts;
    },
    hyperliquidTestnet: () => hyperliquidPort,
    hyperliquidTestnetEvidence: () => ({
      preparation: { prepare: () => ({}) },
      evidence: { prepare: async () => ({}), reconcile: async () => ({}) },
      readiness: {
        preparationAvailable: true,
        evidenceReconciliationAvailable: true,
        executionSubmissionAvailable: false,
        executionSubmissionReason: "SOLVER_EXECUTOR_BOUNDARY_NOT_AVAILABLE",
      },
    }) as unknown as HyperliquidTestnetEvidenceRuntime,
  });
  assert.equal(evmCalls, 1);
  assert.equal(enabled.solanaDevnet.preparation, solanaPorts.preparation);
  assert.equal(enabled.solanaDevnet.observation, solanaPorts.observation);
  assert.equal(enabled.evmTestnet.authorization, evmPorts.authorization);
  assert.equal(enabled.evmTestnet.preparation, evmPorts.preparation);
  assert.equal(enabled.evmTestnet.atomicObservation, evmPorts.atomicObservation);
  assert.equal(enabled.evmTestnet.asyncObservation, evmPorts.asyncObservation);
  assert.equal(enabled.hyperliquidTestnet, hyperliquidPort);
  assert.equal(enabled.hyperliquidTestnetEvidence?.readiness.executionSubmissionAvailable, false);
  assert.deepEqual(enabled.health, {
    solanaDevnet: { available: true, reason: null },
    baseTestnetAtomic: { available: true, reason: null },
    arbitrumTestnetAsync: { available: true, reason: null },
    hyperliquidTestnet: { available: true, reason: null },
  });
  assert.deepEqual(privateTerminalHealthSummary(enabled.health, "DISABLED"), { status: "ready", environment: "TESTNET" });
});

test("runtime composition fails closed when external prerequisites are absent or invalid", () => {
  const absent = composePrivateTerminalRuntime(ENABLED);
  assert.deepEqual(absent.solanaDevnet, {});
  assert.deepEqual(absent.evmTestnet, {});
  assert.equal(absent.hyperliquidTestnet, undefined);
  assert.equal(absent.hyperliquidTestnetEvidence, undefined);
  for (const boundary of Object.values(absent.health)) {
    assert.deepEqual(boundary, {
      available: false,
      reason: "RUNTIME_FACTORY_NOT_INJECTED",
    });
  }

  const incomplete = composePrivateTerminalRuntime(ENABLED, {
    solanaDevnet: () => ({ preparation: solanaPorts.preparation! }),
    evmTestnet: () => ({ preparation: evmPorts.preparation! }),
    hyperliquidTestnet: () => ({}) as HyperliquidTestnetTerminalExecutionPort,
    hyperliquidTestnetEvidence: () => ({}) as HyperliquidTestnetEvidenceRuntime,
  });
  for (const boundary of Object.values(incomplete.health)) {
    assert.deepEqual(boundary, { available: false, reason: "REQUIRED_PORTS_MISSING" });
  }

  const logged: string[] = [];
  const failed = composePrivateTerminalRuntime(ENABLED, {
    solanaDevnet: () => { throw new Error("missing manifest"); },
    evmTestnet: () => {
      throw new Error("RPC https://base-sepolia.example/v2/rpc-secret failed with api_key=key-secret\nRequest body: {}");
    },
    hyperliquidTestnet: () => { throw new Error("missing signer"); },
    hyperliquidTestnetEvidence: () => { throw new Error("missing evidence runtime"); },
  }, (runtime, error) => logged.push(`${runtime}: ${runtimeFailureMessage(error)}`));
  for (const boundary of Object.values(failed.health)) {
    assert.deepEqual(boundary, { available: false, reason: "RUNTIME_INITIALIZATION_FAILED" });
  }
  assert.deepEqual(logged, [
    "solanaDevnet: missing manifest",
    "evmTestnet: RPC [redacted-url] failed with api_key=[redacted]",
    "hyperliquidTestnet: missing signer",
  ]);

  assert.throws(
    () => composePrivateTerminalRuntime({ NARYX_SOLANA_DEVNET_RUNTIME_ENABLED: "yes" }),
    /must be true or false/,
  );
});

test("a quotes-only Hyperliquid lane reports execution disabled by configuration and its market freshness", () => {
  const quotesOnly = composePrivateTerminalRuntime({
    NARYX_HYPERLIQUID_TESTNET_RUNTIME_ENABLED: "true",
    NARYX_HYPERLIQUID_TESTNET_EXECUTOR_CLIENT_ENABLED: "false",
    NARYX_HYPERLIQUID_TESTNET_EVIDENCE_ENABLED: "false",
  });
  assert.deepEqual(quotesOnly.health.hyperliquidTestnet, { available: false, reason: "DISABLED_BY_CONFIGURATION" });
  assert.deepEqual(privateTerminalHealthSummary(quotesOnly.health, "DISABLED", [true]), { status: "ready", environment: "TESTNET" });
  assert.deepEqual(privateTerminalHealthSummary(quotesOnly.health, "DISABLED", [false]), { status: "degraded", environment: "TESTNET" });
  assert.deepEqual(privateTerminalHealthSummary(quotesOnly.health, "DISABLED"), { status: "unconfigured", environment: "UNCONFIGURED" });
});

test("private service health reports runtime composition reasons", async () => {
  const runtime = composePrivateTerminalRuntime({
    NARYX_SOLANA_DEVNET_RUNTIME_ENABLED: "true",
    NARYX_BASE_TESTNET_RUNTIME_ENABLED: "false",
    NARYX_ARBITRUM_TESTNET_RUNTIME_ENABLED: "true",
    NARYX_HYPERLIQUID_TESTNET_RUNTIME_ENABLED: "true",
  });
  const server = createPrivateTerminalServer(
    { host: "127.0.0.1", port: 0, terminalOrigin: null },
    runtime.solanaDevnet,
    undefined,
    runtime.hyperliquidTestnet,
    runtime.evmTestnet,
    undefined,
    undefined,
    undefined,
    undefined,
    runtime.health,
  );
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/internal/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json() as { runtime: unknown; status: string; environment: string; localAtomicRuntimeMode: string };
    assert.deepEqual(body.runtime, runtime.health);
    assert.equal(body.status, "degraded");
    assert.equal(body.environment, "TESTNET");
    assert.equal(body.localAtomicRuntimeMode, "DISABLED");
  } finally {
    await close(server);
  }
});

test("startup composes fixtures only on a loopback opt-in and requires durable stores otherwise", () => {
  const loopback = { host: "127.0.0.1" };
  const stores = {
    NARYX_API_ORDER_DB: "/var/lib/naryx/orders.db",
    NARYX_API_LIFECYCLE_DB: "/var/lib/naryx/lifecycle.db",
    NARYX_API_EXECUTION_INTENT_DB: "/var/lib/naryx/intents.db",
  };
  assert.throws(() => loadPrivateTerminalStartupConfig({}, loopback), /NARYX_API_ORDER_DB is required unless NARYX_LOCAL_FIXTURE_MODE=true/);
  assert.throws(
    () => loadPrivateTerminalStartupConfig({ ...stores, NARYX_API_EXECUTION_INTENT_DB: "" }, loopback),
    /NARYX_API_EXECUTION_INTENT_DB is required/,
  );
  assert.deepEqual(loadPrivateTerminalStartupConfig(stores, loopback), {
    localAtomicRuntimeMode: "DISABLED",
    orderDbPath: stores.NARYX_API_ORDER_DB,
    lifecycleDbPath: stores.NARYX_API_LIFECYCLE_DB,
    executionIntentDbPath: stores.NARYX_API_EXECUTION_INTENT_DB,
    solanaLocalEnvironmentManifestPath: undefined,
    solanaLocalPreparationDbPath: undefined,
  });
  assert.throws(
    () => loadPrivateTerminalStartupConfig({ ...stores, NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST: "/etc/naryx/local.json" }, loopback),
    /NARYX_API_SOLANA_LOCAL_PREPARATION_DB is required with NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST/,
  );

  const fixture = loadPrivateTerminalStartupConfig({ NARYX_LOCAL_FIXTURE_MODE: "true" }, loopback);
  assert.equal(fixture.localAtomicRuntimeMode, "PHASE4_FIXTURE");
  assert.equal(fixture.orderDbPath, "/tmp/naryx-local/api-orders.db");
  assert.throws(() => loadPrivateTerminalStartupConfig({ NARYX_LOCAL_FIXTURE_MODE: "yes" }, loopback), /must be true or false/);
  assert.throws(
    () => loadPrivateTerminalStartupConfig({ NARYX_LOCAL_FIXTURE_MODE: "true" }, { host: "0.0.0.0" }),
    /requires a loopback NARYX_API_HOST/,
  );
  assert.throws(
    () => loadPrivateTerminalStartupConfig({ NARYX_LOCAL_FIXTURE_MODE: "true", NARYX_BASE_TESTNET_RUNTIME_ENABLED: "true" }, loopback),
    /cannot be combined with NARYX_BASE_TESTNET_RUNTIME_ENABLED=true/,
  );
  assert.throws(
    () => loadPrivateTerminalStartupConfig({
      NARYX_LOCAL_FIXTURE_MODE: "true",
      NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST: "/etc/naryx/local.json",
    }, loopback),
    /cannot be combined with NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST/,
  );
});
