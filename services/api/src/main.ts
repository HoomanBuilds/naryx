import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { createPrivateTerminalServer, loadPrivateTerminalServerConfig } from "./http-server.js";
import { loadPublicMarketRuntime } from "./public-market-runtime.js";
import { SqliteInternalOrderStore } from "./internal-order-store.js";
import { createLocalAtomicOrderRuntime } from "./local-atomic-order-context.js";
import { SqlitePackageLifecycleStore } from "./package-lifecycle-store.js";
import { HttpInternalSolverQuoteClient } from "./solver-quote-client.js";
import { SqliteExecutionIntentStore } from "./execution-intent-store.js";
import { LocalExecutionCoordinator } from "./local-execution-coordinator.js";
import {
  composePrivateTerminalRuntime,
  type PrivateTerminalRuntimeFactories,
} from "./runtime-composition.js";
import {
  createBaseSepoliaRuntime,
  createViemBaseSepoliaReadClient,
  loadBaseSepoliaRuntimeManifest,
} from "./base-sepolia-runtime.js";
import {
  createArbitrumSepoliaRuntime,
  createViemArbitrumSepoliaReadClient,
  loadArbitrumSepoliaRuntimeManifest,
} from "./arbitrum-sepolia-runtime-client.js";
import {
  createSolanaDevnetRuntime,
  HttpSolanaDevnetBindingSource,
  loadSolanaDevnetRuntimeManifest,
} from "./solana-devnet-runtime.js";
import { loadSolanaLocalEnvironmentRuntime } from "./solana-local-environment-runtime.js";
import { SolanaConformanceAdapter } from "@naryx/adapter-solana";
import { Connection } from "@solana/web3.js";
import {
  ConnectionSolanaLocalExecutionRpc,
  HttpSolanaLocalExecutionAuthorizationClient,
  SolanaLocalExecutionService,
  SqliteSolanaLocalPreparedExecutionStore,
} from "./solana-local-execution.js";
import {
  createHyperliquidTestnetEvidenceRuntime,
  loadHyperliquidTestnetRuntimeConfig,
  type HyperliquidTestnetRuntimeConfig,
} from "./hyperliquid-testnet-runtime-client.js";
import { createHyperliquidTestnetOrderRuntime } from "./hyperliquid-testnet-order-context.js";
import {
  DurableHyperliquidTestnetTerminalExecutionPort,
  HttpHyperliquidTestnetAttemptExecutor,
} from "./hyperliquid-testnet-terminal-execution.js";

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

function explicitlyEnabled(name: string): boolean {
  const value = process.env[name] ?? "false";
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false.`);
  return value === "true";
}

const config = loadPrivateTerminalServerConfig();
const publicMarket = loadPublicMarketRuntime();
const orderStore = new SqliteInternalOrderStore(absolutePath(
  process.env.NARYX_API_ORDER_DB ?? "/tmp/naryx-local/api-orders.db",
  "NARYX_API_ORDER_DB",
));
const lifecycleStore = new SqlitePackageLifecycleStore(absolutePath(
  process.env.NARYX_API_LIFECYCLE_DB ?? "/tmp/naryx-local/package-lifecycle.db",
  "NARYX_API_LIFECYCLE_DB",
));
const executionIntentStore = new SqliteExecutionIntentStore(absolutePath(
  process.env.NARYX_API_EXECUTION_INTENT_DB ?? "/tmp/naryx-local/execution-intents.db",
  "NARYX_API_EXECUTION_INTENT_DB",
));
const environmentManifestPath = process.env.NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST;
const manifestRuntime = environmentManifestPath === undefined
  ? undefined
  : await loadSolanaLocalEnvironmentRuntime(
    absolutePath(environmentManifestPath, "NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST"),
    process.env.NARYX_SOLANA_LOCAL_SOLVER_ID ?? "",
  );
const orderRuntime = manifestRuntime === undefined
  ? createLocalAtomicOrderRuntime()
  : createLocalAtomicOrderRuntime(
    manifestRuntime.manifest.runtime.catalog,
    () => manifestRuntime.initialSlot,
    manifestRuntime.readSlot,
  );
const solverClient = new HttpInternalSolverQuoteClient(
  process.env.NARYX_SOLVER_INTERNAL_ORIGIN ?? "http://127.0.0.1:8788",
);
const localExecutionCoordinator = new LocalExecutionCoordinator({
  intents: executionIntentStore,
  orders: orderStore,
  lifecycle: lifecycleStore,
});
const solanaLocalPreparationStore = manifestRuntime === undefined
  ? undefined
  : new SqliteSolanaLocalPreparedExecutionStore(absolutePath(
    process.env.NARYX_API_SOLANA_LOCAL_PREPARATION_DB ?? "/tmp/naryx-local/api-solana-preparations.db",
    "NARYX_API_SOLANA_LOCAL_PREPARATION_DB",
  ));
const solanaConnection = manifestRuntime === undefined
  ? undefined
  : new Connection(manifestRuntime.manifest.rpc.url, "confirmed");
const solanaLocalExecution = manifestRuntime === undefined
    || solanaLocalPreparationStore === undefined
    || solanaConnection === undefined
  ? undefined
  : new SolanaLocalExecutionService({
    manifest: manifestRuntime.manifest,
    intents: executionIntentStore,
    orders: orderStore,
    authorization: new HttpSolanaLocalExecutionAuthorizationClient(
      process.env.NARYX_SOLVER_INTERNAL_ORIGIN ?? "http://127.0.0.1:8788",
    ),
    adapter: new SolanaConformanceAdapter({
      connection: solanaConnection,
      domain: manifestRuntime.manifest.runtime.catalog.domain,
      environment: "local",
      expectedGenesisHash: manifestRuntime.manifest.rpc.genesisHash,
      executionSignatureProvider: () => { throw new Error("API cannot sign solver execution authorization."); },
    }),
    rpc: new ConnectionSolanaLocalExecutionRpc(solanaConnection),
    store: solanaLocalPreparationStore,
    lifecycle: localExecutionCoordinator,
    validateLive: manifestRuntime.validateLive,
  });
let baseRuntime: Awaited<ReturnType<typeof createBaseSepoliaRuntime>> | undefined;
let baseRuntimeError: unknown;
if (process.env.NARYX_BASE_TESTNET_RUNTIME_ENABLED === "true") {
  try {
    const baseManifestPath = absolutePath(
      process.env.NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST ?? "",
      "NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST",
    );
    const baseRpcUrl = process.env.NARYX_BASE_SEPOLIA_RPC_URL ?? "";
    baseRuntime = await createBaseSepoliaRuntime({
      manifest: loadBaseSepoliaRuntimeManifest(baseManifestPath),
      intents: executionIntentStore,
      orders: orderStore,
      client: createViemBaseSepoliaReadClient(baseRpcUrl),
    });
  } catch (error) {
    baseRuntimeError = error;
  }
}
let solanaDevnetRuntime: Awaited<ReturnType<typeof createSolanaDevnetRuntime>> | undefined;
let solanaDevnetRuntimeError: unknown;
if (process.env.NARYX_SOLANA_DEVNET_RUNTIME_ENABLED === "true") {
  try {
    const solanaDevnetManifestPath = absolutePath(
      process.env.NARYX_SOLANA_DEVNET_RUNTIME_MANIFEST ?? "",
      "NARYX_SOLANA_DEVNET_RUNTIME_MANIFEST",
    );
    const solanaDevnetRpcUrl = process.env.NARYX_SOLANA_DEVNET_RPC_URL ?? "";
    solanaDevnetRuntime = await createSolanaDevnetRuntime({
      manifest: loadSolanaDevnetRuntimeManifest(solanaDevnetManifestPath),
      rpcUrl: solanaDevnetRpcUrl,
      preparedStorePath: absolutePath(
        process.env.NARYX_SOLANA_DEVNET_PREPARATION_DB ?? "",
        "NARYX_SOLANA_DEVNET_PREPARATION_DB",
      ),
      intents: executionIntentStore,
      orders: orderStore,
      lifecycle: lifecycleStore,
      bindings: new HttpSolanaDevnetBindingSource(
        process.env.NARYX_SOLANA_DEVNET_BINDING_ORIGIN ?? "",
      ),
    });
  } catch (error) {
    solanaDevnetRuntimeError = error;
  }
}
let arbitrumRuntime: Awaited<ReturnType<typeof createArbitrumSepoliaRuntime>> | undefined;
let arbitrumRuntimeError: unknown;
if (process.env.NARYX_ARBITRUM_TESTNET_RUNTIME_ENABLED === "true") {
  try {
    const arbitrumManifestPath = absolutePath(
      process.env.NARYX_ARBITRUM_SEPOLIA_RUNTIME_MANIFEST ?? "",
      "NARYX_ARBITRUM_SEPOLIA_RUNTIME_MANIFEST",
    );
    const arbitrumRpcUrl = process.env.NARYX_ARBITRUM_SEPOLIA_RPC_URL ?? "";
    arbitrumRuntime = await createArbitrumSepoliaRuntime({
      manifest: loadArbitrumSepoliaRuntimeManifest(arbitrumManifestPath),
      intents: executionIntentStore,
      orders: orderStore,
      client: createViemArbitrumSepoliaReadClient(arbitrumRpcUrl),
    });
  } catch (error) {
    arbitrumRuntimeError = error;
  }
}
const hyperliquidRuntimeEnabled = process.env.NARYX_HYPERLIQUID_TESTNET_RUNTIME_ENABLED === "true";
const hyperliquidEvidenceEnabled = explicitlyEnabled(
  "NARYX_HYPERLIQUID_TESTNET_EVIDENCE_ENABLED",
);
const hyperliquidExecutorClientEnabled = explicitlyEnabled(
  "NARYX_HYPERLIQUID_TESTNET_EXECUTOR_CLIENT_ENABLED",
);
let hyperliquidConfig: HyperliquidTestnetRuntimeConfig | undefined;
let hyperliquidConfigError: unknown;
if (hyperliquidRuntimeEnabled) {
  try {
    if (process.env.NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT !== "TESTNET") {
      throw new Error("NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT must be TESTNET.");
    }
    hyperliquidConfig = loadHyperliquidTestnetRuntimeConfig(absolutePath(
      process.env.NARYX_HYPERLIQUID_TESTNET_RUNTIME_CONFIG ?? "",
      "NARYX_HYPERLIQUID_TESTNET_RUNTIME_CONFIG",
    ));
  } catch (error) {
    hyperliquidConfigError = error;
  }
}
let hyperliquidOrderRuntime: ReturnType<typeof createHyperliquidTestnetOrderRuntime> | undefined;
if (hyperliquidConfig !== undefined) {
  try {
    hyperliquidOrderRuntime = createHyperliquidTestnetOrderRuntime(hyperliquidConfig);
  } catch (error) {
    hyperliquidConfigError = error;
  }
}
let hyperliquidEvidenceRuntime: ReturnType<typeof createHyperliquidTestnetEvidenceRuntime> | undefined;
let hyperliquidEvidenceRuntimeError: unknown;
if (hyperliquidRuntimeEnabled && hyperliquidEvidenceEnabled) {
  try {
    if (hyperliquidConfigError !== undefined) throw hyperliquidConfigError;
    if (hyperliquidConfig === undefined) throw new Error("Hyperliquid Testnet runtime config is unavailable.");
    hyperliquidEvidenceRuntime = createHyperliquidTestnetEvidenceRuntime({
      ...hyperliquidConfig,
      intents: executionIntentStore,
      orders: orderStore,
      currentTimeMs: Date.now,
    }, {
      solverOrigin: process.env.NARYX_HYPERLIQUID_TESTNET_EVIDENCE_ORIGIN ?? "",
    });
  } catch (error) {
    hyperliquidEvidenceRuntimeError = error;
  }
}
let hyperliquidExecutionRuntime: DurableHyperliquidTestnetTerminalExecutionPort | undefined;
let hyperliquidExecutionRuntimeError: unknown;
if (hyperliquidRuntimeEnabled && hyperliquidExecutorClientEnabled) {
  try {
    if (process.env.NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT !== "TESTNET") {
      throw new Error("NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT must be TESTNET.");
    }
    hyperliquidExecutionRuntime = new DurableHyperliquidTestnetTerminalExecutionPort(
      absolutePath(
        process.env.NARYX_API_HYPERLIQUID_TESTNET_EXECUTION_DB ?? "",
        "NARYX_API_HYPERLIQUID_TESTNET_EXECUTION_DB",
      ),
      new HttpHyperliquidTestnetAttemptExecutor({
        executorOrigin: process.env.NARYX_HYPERLIQUID_TESTNET_EXECUTOR_ORIGIN ?? "",
      }),
    );
  } catch (error) {
    hyperliquidExecutionRuntimeError = error;
  }
}
const factories: PrivateTerminalRuntimeFactories = {
      ...(solanaDevnetRuntime !== undefined || solanaDevnetRuntimeError !== undefined ? {
      solanaDevnet: () => {
        if (solanaDevnetRuntimeError !== undefined) throw solanaDevnetRuntimeError;
        if (solanaDevnetRuntime === undefined) throw new Error("Solana Devnet runtime is unavailable.");
        return solanaDevnetRuntime;
      },
      } : {}),
      ...(baseRuntime !== undefined || baseRuntimeError !== undefined ? {
      evmTestnet: () => {
        if (baseRuntimeError !== undefined) throw baseRuntimeError;
        if (baseRuntime === undefined) throw new Error("Base Sepolia runtime is unavailable.");
        return baseRuntime;
      },
      } : {}),
      ...(arbitrumRuntime !== undefined || arbitrumRuntimeError !== undefined ? {
      arbitrumTestnetAsync: () => {
        if (arbitrumRuntimeError !== undefined) throw arbitrumRuntimeError;
        if (arbitrumRuntime === undefined) throw new Error("Arbitrum Sepolia runtime is unavailable.");
        return arbitrumRuntime;
      },
      } : {}),
      ...(hyperliquidEvidenceEnabled ? {
        hyperliquidTestnetEvidence: () => {
          if (hyperliquidEvidenceRuntimeError !== undefined) throw hyperliquidEvidenceRuntimeError;
          if (hyperliquidEvidenceRuntime === undefined) {
            throw new Error("Hyperliquid Testnet evidence runtime is unavailable.");
          }
          return hyperliquidEvidenceRuntime;
        },
      } : {}),
      ...(hyperliquidExecutorClientEnabled ? {
        hyperliquidTestnet: () => {
          if (hyperliquidExecutionRuntimeError !== undefined) throw hyperliquidExecutionRuntimeError;
          if (hyperliquidExecutionRuntime === undefined) {
            throw new Error("Hyperliquid Testnet executor client is unavailable.");
          }
          return hyperliquidExecutionRuntime;
        },
      } : {}),
    };
const runtime = composePrivateTerminalRuntime(process.env, factories);
type RouteHandler = (request: IncomingMessage, response: ServerResponse) => boolean;
function privateServerRoutes(...handlers: readonly (RouteHandler | undefined)[]): RouteHandler | undefined {
  const present = handlers.filter((handler): handler is RouteHandler => handler !== undefined);
  return present.length === 0 ? undefined : (request, response) => present.some((handler) => handler(request, response));
}
const orderContexts = (contextId: string) =>
  orderRuntime.contexts(contextId) ?? hyperliquidOrderRuntime?.contexts(contextId);
const orderClock = Object.freeze({
  currentClock: async (context: Parameters<typeof orderRuntime.clock.currentClock>[0]) => {
    const hyperliquidContext = hyperliquidOrderRuntime?.contexts(context.contextId);
    return hyperliquidContext === undefined
      ? orderRuntime.clock.currentClock(context)
      : hyperliquidOrderRuntime!.clock.currentClock(context);
  },
});
const server = createPrivateTerminalServer(
  config,
  runtime.solanaDevnet,
  { contexts: orderContexts, store: orderStore, clock: orderClock },
  runtime.hyperliquidTestnet,
  runtime.evmTestnet,
  lifecycleStore,
  solverClient,
  executionIntentStore,
  localExecutionCoordinator,
  runtime.health,
  manifestRuntime === undefined ? "PHASE4_FIXTURE" : "MANIFEST_VALIDATED",
  solanaLocalExecution,
  runtime.hyperliquidTestnetEvidence?.preparation,
  hyperliquidOrderRuntime?.terminalContext,
  undefined,
  undefined,
  // A dedicated public listener keeps the public API off the private terminal server entirely;
  // keeper executor routes are loopback-only and never ride the public listener.
  privateServerRoutes(publicMarket?.internalHandler, publicMarket?.listener === undefined ? publicMarket?.handler : undefined),
);

const publicServer = publicMarket?.listener === undefined
  ? undefined
  : createServer((request, response) => {
    if (publicMarket.handler(request, response)) return;
    response.statusCode = 404;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Unknown public API route." } }));
  });
// Public market data streams over WebSocket on whichever server carries the public API.
const streamHost = publicServer ?? (publicMarket === undefined ? undefined : server);
streamHost?.on("upgrade", (request, socket, head) => {
  if (publicMarket?.upgrade(request, socket, head) !== true) socket.destroy();
});
if (publicServer !== undefined && publicMarket?.listener !== undefined) {
  const { host, port } = publicMarket.listener;
  publicServer.listen(port, host, () => {
    process.stdout.write(`Naryx public API listening on ${host}:${port}\n`);
  });
}

function shutdown(): void {
  publicServer?.close();
  server.close(() => {
    orderStore.close();
    lifecycleStore.close();
    executionIntentStore.close();
    solanaLocalPreparationStore?.close();
    hyperliquidExecutionRuntime?.close();
    publicMarket?.close();
    process.exitCode = 0;
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `Private terminal service listening on http://${config.host}:${config.port}\n`,
  );
});
