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
  loadPrivateTerminalStartupConfig,
  stderrRuntimeFailureReporter,
  type PrivateTerminalRuntimeFactories,
} from "./runtime-composition.js";
import { SqlitePreparedEvmTestnetAtomicStore } from "./evm-testnet-prepared-store.js";
import {
  DurableAttemptScopeResolver,
  TestnetCapExecutionGate,
  loadTestnetExecutionPolicy,
} from "./testnet-execution-policy.js";
import type { ActiveOrderContext } from "./canonical-entry-order.js";
import {
  createBaseSepoliaRuntime,
  createViemBaseSepoliaReadClient,
  loadBaseSepoliaRuntimeManifest,
} from "./base-sepolia-runtime.js";
import {
  createBaseSepoliaOrderRuntime,
  loadBaseSepoliaOrderContextConfig,
  type BaseSepoliaOrderRuntime,
} from "./base-sepolia-order-context.js";
import { createHttpBaseSepoliaSolverAuthorizer } from "./base-sepolia-solver-authorization.js";
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
import {
  HttpSolanaDevnetMarketReadPort,
  createSolanaDevnetOrderRuntime,
  loadSolanaDevnetOrderContextConfig,
  type SolanaDevnetOrderRuntime,
} from "./solana-devnet-order-context.js";
import { withSolanaDevnetFirmQuoteVerification } from "./solana-devnet-firm-quote.js";
import { createSolanaDevnetMarketSource } from "./private-terminal-manifest.js";
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
  createArbitrumSepoliaOrderRuntime,
  createViemArbitrumSepoliaPriceReadPort,
  loadArbitrumSepoliaOrderContextConfig,
  type ArbitrumSepoliaOrderRuntime,
} from "./arbitrum-sepolia-order-context.js";
import {
  HttpArbitrumSepoliaAttemptExecutor,
  withArbitrumSepoliaExecutionHandoff,
} from "./arbitrum-sepolia-executor-client.js";
import { createArbitrumSepoliaOwnerRoutes } from "./arbitrum-sepolia-owner-routes.js";
import { HyperliquidTestnetPriceFeed } from "./hyperliquid-testnet-price-feed.js";
import {
  createBaseSepoliaMarketSource,
  createHyperliquidTestnetMarketSource,
  type TerminalMarketSources,
} from "./private-terminal-manifest.js";
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
const startup = loadPrivateTerminalStartupConfig(process.env, config);
const reportRuntimeFailure = stderrRuntimeFailureReporter();
const publicMarket = loadPublicMarketRuntime();
const orderStore = new SqliteInternalOrderStore(startup.orderDbPath);
const lifecycleStore = new SqlitePackageLifecycleStore(startup.lifecycleDbPath);
const executionIntentStore = new SqliteExecutionIntentStore(startup.executionIntentDbPath);
const manifestRuntime = startup.solanaLocalEnvironmentManifestPath === undefined
  ? undefined
  : await loadSolanaLocalEnvironmentRuntime(
    startup.solanaLocalEnvironmentManifestPath,
    process.env.NARYX_SOLANA_LOCAL_SOLVER_ID ?? "",
  );
const orderRuntime = startup.localAtomicRuntimeMode === "PHASE4_FIXTURE"
  ? createLocalAtomicOrderRuntime()
  : manifestRuntime === undefined
    ? undefined
    : createLocalAtomicOrderRuntime(
      manifestRuntime.manifest.runtime.catalog,
      () => manifestRuntime.initialSlot,
      manifestRuntime.readSlot,
    );
const solverOrigin = process.env.NARYX_SOLVER_INTERNAL_ORIGIN ?? "http://127.0.0.1:8788";
const solverClient = new HttpInternalSolverQuoteClient(solverOrigin);
const localExecutionCoordinator = orderRuntime === undefined
  ? undefined
  : new LocalExecutionCoordinator({
    intents: executionIntentStore,
    orders: orderStore,
    lifecycle: lifecycleStore,
  });
const solanaLocalPreparationStore = startup.solanaLocalPreparationDbPath === undefined
  ? undefined
  : new SqliteSolanaLocalPreparedExecutionStore(startup.solanaLocalPreparationDbPath);
const solanaConnection = manifestRuntime === undefined
  ? undefined
  : new Connection(manifestRuntime.manifest.rpc.url, "confirmed");
const solanaLocalExecution = manifestRuntime === undefined
    || solanaLocalPreparationStore === undefined
    || solanaConnection === undefined
    || localExecutionCoordinator === undefined
  ? undefined
  : new SolanaLocalExecutionService({
    manifest: manifestRuntime.manifest,
    intents: executionIntentStore,
    orders: orderStore,
    authorization: new HttpSolanaLocalExecutionAuthorizationClient(solverOrigin),
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
let basePreparationStore: SqlitePreparedEvmTestnetAtomicStore | undefined;
let baseOrderRuntime: BaseSepoliaOrderRuntime | undefined;
if (process.env.NARYX_BASE_TESTNET_RUNTIME_ENABLED === "true") {
  try {
    const baseManifestPath = absolutePath(
      process.env.NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST ?? "",
      "NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST",
    );
    basePreparationStore = new SqlitePreparedEvmTestnetAtomicStore(absolutePath(
      process.env.NARYX_BASE_SEPOLIA_PREPARATION_DB ?? "",
      "NARYX_BASE_SEPOLIA_PREPARATION_DB",
    ));
    const baseRpcUrl = process.env.NARYX_BASE_SEPOLIA_RPC_URL ?? "";
    const baseManifest = loadBaseSepoliaRuntimeManifest(baseManifestPath);
    const baseClient = createViemBaseSepoliaReadClient(baseRpcUrl);
    baseRuntime = await createBaseSepoliaRuntime({
      manifest: baseManifest,
      intents: executionIntentStore,
      orders: orderStore,
      client: baseClient,
      store: basePreparationStore,
      solverAuthorizer: createHttpBaseSepoliaSolverAuthorizer(
        process.env.NARYX_BASE_SEPOLIA_SOLVER_ORIGIN ?? "http://127.0.0.1:8794",
      ),
    });
    // Base Sepolia entry path: live pool and oracle prices, any wallet through its own factory account.
    baseOrderRuntime = await createBaseSepoliaOrderRuntime({
      config: loadBaseSepoliaOrderContextConfig(absolutePath(
        process.env.NARYX_BASE_SEPOLIA_ORDER_CONTEXT ?? "",
        "NARYX_BASE_SEPOLIA_ORDER_CONTEXT",
      )),
      deployment: baseManifest.deployment,
      port: baseClient,
      orders: orderStore,
    });
    baseOrderRuntime.feed.start();
  } catch (error) {
    baseRuntime = undefined;
    baseOrderRuntime = undefined;
    baseRuntimeError = error;
    reportRuntimeFailure("baseTestnetAtomic", error);
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
    reportRuntimeFailure("solanaDevnet", error);
  }
}
// Solana Devnet entry path: live Pyth SOL/USD order context, per-wallet onboarding reads, the
// test perp terminal market, and FIRM_ONCHAIN quote verification. Disabled unless explicitly enabled.
let solanaDevnetOrderRuntime: SolanaDevnetOrderRuntime | undefined;
if (explicitlyEnabled("NARYX_SOLANA_DEVNET_ORDER_CONTEXT_ENABLED")) {
  try {
    solanaDevnetOrderRuntime = await createSolanaDevnetOrderRuntime({
      manifest: loadSolanaDevnetRuntimeManifest(absolutePath(
        process.env.NARYX_SOLANA_DEVNET_RUNTIME_MANIFEST ?? "",
        "NARYX_SOLANA_DEVNET_RUNTIME_MANIFEST",
      )),
      config: loadSolanaDevnetOrderContextConfig(absolutePath(
        process.env.NARYX_SOLANA_DEVNET_ORDER_CONTEXT ?? "",
        "NARYX_SOLANA_DEVNET_ORDER_CONTEXT",
      )),
      port: new HttpSolanaDevnetMarketReadPort(process.env.NARYX_SOLANA_DEVNET_RPC_URL ?? ""),
    });
    solanaDevnetOrderRuntime.feed.start();
  } catch (error) {
    solanaDevnetOrderRuntime = undefined;
    reportRuntimeFailure("solanaDevnetOrderContext", error);
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
    reportRuntimeFailure("arbitrumTestnetAsync", error);
  }
}
// Arbitrum Sepolia entry path. The order context prices from a live on-chain reference feed and admits
// any wallet trading through its own factory account. The executor handoff makes the gated
// observe-async route advance the solver-held coordinator steps first, and the owner routes let the
// browser wallet sign the reservation itself. All are disabled unless explicitly enabled.
let arbitrumOrderRuntime: ArbitrumSepoliaOrderRuntime | undefined;
if (explicitlyEnabled("NARYX_ARBITRUM_SEPOLIA_ORDER_CONTEXT_ENABLED")) {
  try {
    arbitrumOrderRuntime = await createArbitrumSepoliaOrderRuntime({
      config: loadArbitrumSepoliaOrderContextConfig(absolutePath(
        process.env.NARYX_ARBITRUM_SEPOLIA_ORDER_CONTEXT ?? "",
        "NARYX_ARBITRUM_SEPOLIA_ORDER_CONTEXT",
      )),
      deployment: loadArbitrumSepoliaRuntimeManifest(absolutePath(
        process.env.NARYX_ARBITRUM_SEPOLIA_RUNTIME_MANIFEST ?? "",
        "NARYX_ARBITRUM_SEPOLIA_RUNTIME_MANIFEST",
      )).deployment,
      port: createViemArbitrumSepoliaPriceReadPort(process.env.NARYX_ARBITRUM_SEPOLIA_RPC_URL ?? ""),
    });
    arbitrumOrderRuntime.feed.start();
  } catch (error) {
    reportRuntimeFailure("arbitrumSepoliaOrderContext", error);
  }
}
let arbitrumOwnerRoutes: ReturnType<typeof createArbitrumSepoliaOwnerRoutes> | undefined;
if (arbitrumRuntime !== undefined && explicitlyEnabled("NARYX_ARBITRUM_SEPOLIA_EXECUTOR_CLIENT_ENABLED")) {
  try {
    const arbitrumExecutor = new HttpArbitrumSepoliaAttemptExecutor({
      executorOrigin: process.env.NARYX_ARBITRUM_SEPOLIA_EXECUTOR_ORIGIN ?? "",
    });
    arbitrumRuntime = withArbitrumSepoliaExecutionHandoff(arbitrumRuntime, arbitrumExecutor);
    arbitrumOwnerRoutes = createArbitrumSepoliaOwnerRoutes({
      terminalOrigin: config.terminalOrigin,
      deployment: loadArbitrumSepoliaRuntimeManifest(absolutePath(
        process.env.NARYX_ARBITRUM_SEPOLIA_RUNTIME_MANIFEST ?? "",
        "NARYX_ARBITRUM_SEPOLIA_RUNTIME_MANIFEST",
      )).deployment,
      executor: arbitrumExecutor,
      port: createViemArbitrumSepoliaPriceReadPort(process.env.NARYX_ARBITRUM_SEPOLIA_RPC_URL ?? ""),
      intents: executionIntentStore,
      orders: orderStore,
    });
  } catch (error) {
    arbitrumOwnerRoutes = undefined;
    arbitrumRuntime = undefined;
    arbitrumRuntimeError = error;
    reportRuntimeFailure("arbitrumSepoliaExecutor", error);
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
    reportRuntimeFailure("hyperliquidTestnet", error);
  }
}
let hyperliquidOrderRuntime: ReturnType<typeof createHyperliquidTestnetOrderRuntime> | undefined;
let hyperliquidPriceFeed: HyperliquidTestnetPriceFeed | undefined;
let terminalMarkets: TerminalMarketSources = {};
if (hyperliquidConfig !== undefined) {
  try {
    const priceFeed = new HyperliquidTestnetPriceFeed(hyperliquidConfig);
    hyperliquidOrderRuntime = createHyperliquidTestnetOrderRuntime(hyperliquidConfig, priceFeed);
    terminalMarkets = { hyperliquid: createHyperliquidTestnetMarketSource(hyperliquidConfig, priceFeed) };
    hyperliquidPriceFeed = priceFeed;
    // Not awaited: until a valid snapshot arrives the order context reports itself unknown.
    void priceFeed.start();
  } catch (error) {
    hyperliquidConfigError = error;
    reportRuntimeFailure("hyperliquidTestnetOrderContext", error);
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
    reportRuntimeFailure("hyperliquidTestnetEvidence", error);
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
    reportRuntimeFailure("hyperliquidTestnetExecutor", error);
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
const runtime = composePrivateTerminalRuntime(process.env, factories, reportRuntimeFailure);
type RouteHandler = (request: IncomingMessage, response: ServerResponse) => boolean;
function privateServerRoutes(...handlers: readonly (RouteHandler | undefined)[]): RouteHandler | undefined {
  const present = handlers.filter((handler): handler is RouteHandler => handler !== undefined);
  return present.length === 0 ? undefined : (request, response) => present.some((handler) => handler(request, response));
}
const orderContexts = (contextId: string) =>
  orderRuntime?.contexts(contextId) ?? hyperliquidOrderRuntime?.contexts(contextId)
  ?? arbitrumOrderRuntime?.contexts(contextId) ?? baseOrderRuntime?.contexts(contextId)
  ?? solanaDevnetOrderRuntime?.contexts(contextId);
const orderClock = Object.freeze({
  currentClock: async (context: ActiveOrderContext) => {
    if (arbitrumOrderRuntime !== undefined && context.settlementClass === "ASYNC_BONDED_SOLVER") {
      return arbitrumOrderRuntime.clock.currentClock(context);
    }
    if (baseOrderRuntime !== undefined && context.contextId === baseOrderRuntime.config.contextId) {
      return baseOrderRuntime.clock.currentClock(context);
    }
    if (solanaDevnetOrderRuntime !== undefined && context.contextId === solanaDevnetOrderRuntime.config.contextId) {
      return solanaDevnetOrderRuntime.clock.currentClock(context);
    }
    if (hyperliquidOrderRuntime?.contexts(context.contextId) !== undefined) {
      return hyperliquidOrderRuntime.clock.currentClock(context);
    }
    if (orderRuntime === undefined) throw new Error("No local order context is composed.");
    return orderRuntime.clock.currentClock(context);
  },
});
// Testnet execution approval: automatic within the operator's per-domain caps. Without both the
// policy file and its decision database, every execution handoff stays refused (fail closed).
const executionPolicyFile = process.env.NARYX_EXECUTION_POLICY_FILE;
const executionPolicyDb = process.env.NARYX_EXECUTION_POLICY_DB;
let executionGate: TestnetCapExecutionGate | undefined;
let executionScopes: DurableAttemptScopeResolver | undefined;
if (executionPolicyFile !== undefined || executionPolicyDb !== undefined) {
  if (!executionPolicyFile || !executionPolicyDb) {
    throw new Error("NARYX_EXECUTION_POLICY_FILE and NARYX_EXECUTION_POLICY_DB must be set together.");
  }
  if (startup.localAtomicRuntimeMode === "PHASE4_FIXTURE") {
    throw new Error("The testnet execution policy cannot run alongside NARYX_LOCAL_FIXTURE_MODE.");
  }
  // Validate once at startup; every decision re-reads the file so cap changes apply without a restart.
  loadTestnetExecutionPolicy(executionPolicyFile);
  executionGate = new TestnetCapExecutionGate({
    policy: () => loadTestnetExecutionPolicy(executionPolicyFile),
    databasePath: executionPolicyDb,
  });
  executionScopes = new DurableAttemptScopeResolver(orderStore, executionIntentStore);
}

const server = createPrivateTerminalServer(
  config,
  runtime.solanaDevnet,
  { contexts: orderContexts, store: orderStore, clock: orderClock },
  runtime.hyperliquidTestnet,
  baseOrderRuntime === undefined || runtime.evmTestnet.preparation === undefined
    ? runtime.evmTestnet
    : { ...runtime.evmTestnet, account: baseOrderRuntime.account },
  lifecycleStore,
  solanaDevnetOrderRuntime === undefined ? solverClient : withSolanaDevnetFirmQuoteVerification(solverClient),
  executionIntentStore,
  localExecutionCoordinator,
  runtime.health,
  startup.localAtomicRuntimeMode,
  solanaLocalExecution,
  runtime.hyperliquidTestnetEvidence?.preparation,
  hyperliquidOrderRuntime?.terminalContext,
  executionGate,
  executionScopes,
  // A dedicated public listener keeps the public API off the private terminal server entirely;
  // keeper executor routes are loopback-only and never ride the public listener.
  privateServerRoutes(
    publicMarket?.internalHandler,
    publicMarket?.listener === undefined ? publicMarket?.handler : undefined,
    arbitrumOwnerRoutes,
    solanaDevnetOrderRuntime?.handler,
  ),
  {
    ...terminalMarkets,
    ...(baseOrderRuntime === undefined ? {} : { base: createBaseSepoliaMarketSource(baseOrderRuntime) }),
    ...(solanaDevnetOrderRuntime === undefined ? {} : { solana: createSolanaDevnetMarketSource(solanaDevnetOrderRuntime) }),
  },
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
  hyperliquidPriceFeed?.stop();
  baseOrderRuntime?.feed.stop();
  solanaDevnetOrderRuntime?.feed.stop();
  publicServer?.close();
  server.close(() => {
    orderStore.close();
    lifecycleStore.close();
    executionIntentStore.close();
    solanaLocalPreparationStore?.close();
    basePreparationStore?.close();
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
