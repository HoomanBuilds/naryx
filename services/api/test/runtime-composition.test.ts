import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  composePrivateTerminalRuntime,
  createPrivateTerminalServer,
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
  });
  for (const boundary of Object.values(incomplete.health)) {
    assert.deepEqual(boundary, { available: false, reason: "REQUIRED_PORTS_MISSING" });
  }

  const failed = composePrivateTerminalRuntime(ENABLED, {
    solanaDevnet: () => { throw new Error("missing manifest"); },
    evmTestnet: () => { throw new Error("missing deployment"); },
    hyperliquidTestnet: () => { throw new Error("missing signer"); },
  });
  for (const boundary of Object.values(failed.health)) {
    assert.deepEqual(boundary, { available: false, reason: "RUNTIME_INITIALIZATION_FAILED" });
  }

  assert.throws(
    () => composePrivateTerminalRuntime({ NARYX_SOLANA_DEVNET_RUNTIME_ENABLED: "yes" }),
    /must be true or false/,
  );
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
    const body = await response.json() as { runtime: unknown };
    assert.deepEqual(body.runtime, runtime.health);
  } finally {
    await close(server);
  }
});
