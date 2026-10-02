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
import {
  reconcilePendingEvmTestnetAtomicOutcomes,
  SqlitePreparedEvmTestnetAtomicStore,
} from "./evm-testnet-prepared-store.js";
import {
  reconcileUnsettledArbitrumSepoliaOutcomes,
  SqliteArbitrumSepoliaOutcomeStore,
} from "./arbitrum-sepolia-outcome-store.js";
import type { OwnerPackageOutcomeReader } from "./terminal-packages.js";
import {
  DurableAttemptScopeResolver,
  TestnetCapExecutionGate,
  loadTestnetExecutionPolicy,
} from "./testnet-execution-policy.js";
import type { ActiveOrderContext } from "./canonical-entry-order.js";
import type { InternalOrderSpotPricePort } from "./terminal-orders.js";
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
import { createBaseSepoliaExitOrderRoutes, createBaseSepoliaExitOrderService } from "./base-sepolia-exit-order.js";
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
import { createSolanaDevnetMarketSource, type TerminalMarketSource } from "./private-terminal-manifest.js";
import { ArbitrumSepoliaMarketFeed, createArbitrumSepoliaMarketSource } from "./arbitrum-sepolia-market-source.js";
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
  hyperliquidTestnetSpotLotAtoms,
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
import { HyperliquidTestnetOwnerLedger } from "./hyperliquid-testnet-owner-ledger.js";
import { createReadCache } from "./read-cache.js";
import {
  createHyperliquidTestnetExecutionGuard,
  createHyperliquidTestnetExitOrderFactory,
  createHyperliquidTestnetOwnerRoutes,
} from "./hyperliquid-testnet-owner-routes.js";
import {
  createReferenceCandleRoutes,
  ReferenceHistoryRecorder,
  SqliteReferenceHistoryStore,
  type ReferenceLane,
} from "./reference-history.js";
import type { DomainId } from "./terminal-types.js";

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

function explicitlyEnabled(name: string): boolean {
  const value = process.env[name] ?? "false";
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false.`);
  return value === "true";
}

/** Runs a reconciliation sweep each minute, never two at once, without holding the process open. */
function everyMinute(sweep: () => Promise<void>): void {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void sweep().catch(() => undefined).finally(() => { running = false; });
  }, 60_000).unref();
}

// Where each lane's reference history legs come from, named as each lane composes its market source.
const referenceSources: Partial<Record<DomainId, Readonly<{ spot: string; perp: string }>>> = {};
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
let baseExitRoutes: ReturnType<typeof createBaseSepoliaExitOrderRoutes> | undefined;
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
    const baseIdentity = baseManifest.deployment.deployment;
    referenceSources.base = {
      spot: `Uniswap V3 pool ${baseIdentity.spot.market.address} slot0 mid, Base Sepolia`,
      perp: `Chainlink round read by Naryx test perp ${baseIdentity.perpetual.market.address} (oracle mid), Base Sepolia`,
    };
    // Base Sepolia exit path: the canonical EXIT order for the owner's open package, read from chain.
    baseExitRoutes = createBaseSepoliaExitOrderRoutes({
      terminalOrigin: config.terminalOrigin,
      service: createBaseSepoliaExitOrderService({
        runtime: baseOrderRuntime,
        deployment: baseManifest.deployment,
        port: baseClient,
        orders: orderStore,
      }),
    });
  } catch (error) {
    baseRuntime = undefined;
    baseOrderRuntime = undefined;
    baseExitRoutes = undefined;
    baseRuntimeError = error;
    reportRuntimeFailure("baseTestnetAtomic", error);
  }
}
// Server-side reconciliation: bound Base transactions without a settled outcome are observed again,
// so a package finalizes, reverts, or expires in its owner's list after the sending browser is gone.
if (baseRuntime?.atomicObservation !== undefined && basePreparationStore !== undefined) {
  const store = basePreparationStore;
  const observation = baseRuntime.atomicObservation;
  everyMinute(() => reconcilePendingEvmTestnetAtomicOutcomes(store, observation));
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
    const solanaManifest = loadSolanaDevnetRuntimeManifest(absolutePath(
      process.env.NARYX_SOLANA_DEVNET_RUNTIME_MANIFEST ?? "",
      "NARYX_SOLANA_DEVNET_RUNTIME_MANIFEST",
    ));
    solanaDevnetOrderRuntime = await createSolanaDevnetOrderRuntime({
      manifest: solanaManifest,
      config: loadSolanaDevnetOrderContextConfig(absolutePath(
        process.env.NARYX_SOLANA_DEVNET_ORDER_CONTEXT ?? "",
        "NARYX_SOLANA_DEVNET_ORDER_CONTEXT",
      )),
      port: new HttpSolanaDevnetMarketReadPort(process.env.NARYX_SOLANA_DEVNET_RPC_URL ?? ""),
      orders: orderStore,
    });
    solanaDevnetOrderRuntime.feed.start();
    // Spot is the solver's inventory quoted around the same oracle, so both mids are the Pyth price.
    const pyth = `Pyth SOL/USD PriceUpdateV2 account ${solanaManifest.testPerp.oracle}`;
    referenceSources.solana = {
      spot: `${pyth} (solver inventory mid), Solana Devnet`,
      perp: `${pyth} (test perp oracle mid), Solana Devnet`,
    };
  } catch (error) {
    solanaDevnetOrderRuntime = undefined;
    reportRuntimeFailure("solanaDevnetOrderContext", error);
  }
}
let arbitrumRuntime: Awaited<ReturnType<typeof createArbitrumSepoliaRuntime>> | undefined;
let arbitrumRuntimeError: unknown;
// The executor client exists before the observation runtime, which reads the solver's exit authorizations.
let arbitrumExecutor: HttpArbitrumSepoliaAttemptExecutor | undefined;
if (process.env.NARYX_ARBITRUM_TESTNET_RUNTIME_ENABLED === "true") {
  try {
    if (explicitlyEnabled("NARYX_ARBITRUM_SEPOLIA_EXECUTOR_CLIENT_ENABLED")) {
      arbitrumExecutor = new HttpArbitrumSepoliaAttemptExecutor({
        executorOrigin: process.env.NARYX_ARBITRUM_SEPOLIA_EXECUTOR_ORIGIN ?? "",
      });
    }
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
      ...(arbitrumExecutor === undefined ? {} : { exitAuthorizations: arbitrumExecutor }),
    });
  } catch (error) {
    arbitrumExecutor = undefined;
    arbitrumRuntimeError = error;
    reportRuntimeFailure("arbitrumTestnetAsync", error);
  }
}
// Arbitrum Sepolia entry path. The order context prices from a live on-chain reference feed and admits
// any wallet trading through its own factory account. The executor handoff makes the gated
// observe-async route advance the solver-held coordinator steps first, and the owner routes let the
// browser wallet sign the reservation itself. All are disabled unless explicitly enabled.
let arbitrumOrderRuntime: ArbitrumSepoliaOrderRuntime | undefined;
let arbitrumMarketSource: TerminalMarketSource | undefined;
if (explicitlyEnabled("NARYX_ARBITRUM_SEPOLIA_ORDER_CONTEXT_ENABLED")) {
  try {
    const config = loadArbitrumSepoliaOrderContextConfig(absolutePath(
      process.env.NARYX_ARBITRUM_SEPOLIA_ORDER_CONTEXT ?? "",
      "NARYX_ARBITRUM_SEPOLIA_ORDER_CONTEXT",
    ));
    const deployment = loadArbitrumSepoliaRuntimeManifest(absolutePath(
      process.env.NARYX_ARBITRUM_SEPOLIA_RUNTIME_MANIFEST ?? "",
      "NARYX_ARBITRUM_SEPOLIA_RUNTIME_MANIFEST",
    )).deployment;
    const port = createViemArbitrumSepoliaPriceReadPort(process.env.NARYX_ARBITRUM_SEPOLIA_RPC_URL ?? "");
    arbitrumOrderRuntime = await createArbitrumSepoliaOrderRuntime({ config, deployment, port });
    arbitrumOrderRuntime.feed.start();
    // The terminal market reads the factory's spot pool and the GMX fee beside the reference feed;
    // until its first read lands, snapshot and preview report the market unavailable.
    try {
      const marketFeed = new ArbitrumSepoliaMarketFeed(deployment, port, config.pollIntervalMs);
      marketFeed.start();
      arbitrumMarketSource = createArbitrumSepoliaMarketSource(config, arbitrumOrderRuntime.feed, marketFeed);
      referenceSources.arbitrum = {
        spot: `Uniswap V3 pool slot0 mid behind the spot port of factory ${deployment.accountFactory.address}, Arbitrum Sepolia`,
        perp: `Chainlink-compatible feed ${config.priceFeed.address} latestRoundData, Arbitrum Sepolia`,
      };
    } catch (error) {
      reportRuntimeFailure("arbitrumSepoliaTerminalMarket", error);
    }
  } catch (error) {
    reportRuntimeFailure("arbitrumSepoliaOrderContext", error);
  }
}
let arbitrumOwnerRoutes: ReturnType<typeof createArbitrumSepoliaOwnerRoutes> | undefined;
let arbitrumOutcomeStore: SqliteArbitrumSepoliaOutcomeStore | undefined;
if (arbitrumRuntime !== undefined && arbitrumExecutor !== undefined) {
  try {
    // Each handoff keeps what it proved on chain, durably, for the owner's package list.
    arbitrumOutcomeStore = new SqliteArbitrumSepoliaOutcomeStore(absolutePath(
      process.env.NARYX_ARBITRUM_SEPOLIA_OUTCOME_DB ?? "",
      "NARYX_ARBITRUM_SEPOLIA_OUTCOME_DB",
    ), { intents: executionIntentStore, orders: orderStore });
    const observation = arbitrumRuntime;
    arbitrumRuntime = withArbitrumSepoliaExecutionHandoff(observation, arbitrumExecutor, arbitrumOutcomeStore);
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
      ...(arbitrumOrderRuntime === undefined ? {} : { exit: { runtime: arbitrumOrderRuntime, orders: orderStore } }),
    });
    // The sweep reads chain state only; the solver still advances an attempt only through the gated handoff.
    const outcomes = arbitrumOutcomeStore;
    everyMinute(() => reconcileUnsettledArbitrumSepoliaOutcomes(outcomes, observation));
  } catch (error) {
    arbitrumOutcomeStore?.close();
    arbitrumOutcomeStore = undefined;
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
    referenceSources.hyperliquid = {
      spot: `Hyperliquid testnet l2Book mid, spot universe index ${hyperliquidConfig.market.spot.universeIndex}`,
      perp: `Hyperliquid testnet l2Book mid, perpetual asset index ${hyperliquidConfig.market.perpetual.assetIndex}`,
    };
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
// Every user's package executes in the one configured trading account; the owner ledger records
// which wallet owns which package and gates entries and exits on the owner's signature.
let hyperliquidOwnerLedger: HyperliquidTestnetOwnerLedger | undefined;
if (hyperliquidRuntimeEnabled && hyperliquidExecutorClientEnabled) {
  try {
    if (process.env.NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT !== "TESTNET") {
      throw new Error("NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT must be TESTNET.");
    }
    const orderContext = hyperliquidConfig?.orderContext;
    if (orderContext === undefined) throw new Error("Hyperliquid Testnet order context is required for execution.");
    const executionDb = absolutePath(
      process.env.NARYX_API_HYPERLIQUID_TESTNET_EXECUTION_DB ?? "",
      "NARYX_API_HYPERLIQUID_TESTNET_EXECUTION_DB",
    );
    hyperliquidOwnerLedger = new HyperliquidTestnetOwnerLedger(executionDb);
    hyperliquidExecutionRuntime = new DurableHyperliquidTestnetTerminalExecutionPort(
      executionDb,
      new HttpHyperliquidTestnetAttemptExecutor({
        executorOrigin: process.env.NARYX_HYPERLIQUID_TESTNET_EXECUTOR_ORIGIN ?? "",
      }),
      createHyperliquidTestnetExecutionGuard({
        ledger: hyperliquidOwnerLedger,
        intents: executionIntentStore,
        orders: orderStore,
        tradingAccount: orderContext.tradingAccount,
        limits: hyperliquidConfig?.omnibus,
        spotLotAtoms: hyperliquidTestnetSpotLotAtoms(hyperliquidConfig!),
      }),
    );
    // Server-side reconciliation: attempts stored with a non-final outcome are re-read from the
    // executor each minute, so a package resolved later (for example after its lane is released)
    // leaves UNRESOLVED without its owner having to poll.
    const executionPort = hyperliquidExecutionRuntime;
    const sweep = setInterval(() => {
      void executionPort.reconcileUnresolved().catch(() => undefined);
    }, 60_000);
    sweep.unref();
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
const hyperliquidOrderContext = hyperliquidConfig?.orderContext;
const hyperliquidOwnerRoutes = hyperliquidOwnerLedger === undefined || hyperliquidOrderContext === undefined
  || hyperliquidExecutionRuntime === undefined
  ? undefined
  : createHyperliquidTestnetOwnerRoutes({
    tradingAccount: hyperliquidOrderContext.tradingAccount,
    maxOpenPackagesPerOwner: hyperliquidConfig?.omnibus?.maxOpenPackagesPerOwner ?? null,
    baseDecimals: hyperliquidOrderContext.baseAsset.decimals,
    quoteDecimals: hyperliquidOrderContext.quoteAsset.decimals,
    ledger: hyperliquidOwnerLedger,
    intents: executionIntentStore,
    orders: orderStore,
    ...(hyperliquidOrderRuntime === undefined || hyperliquidPriceFeed === undefined ? {} : {
      createExitOrder: createHyperliquidTestnetExitOrderFactory({
        config: hyperliquidOrderContext,
        spotLotAtoms: hyperliquidTestnetSpotLotAtoms(hyperliquidConfig!),
        contexts: hyperliquidOrderRuntime.contexts,
        clock: hyperliquidOrderRuntime.clock,
        prices: hyperliquidPriceFeed,
        ledger: hyperliquidOwnerLedger,
        orders: orderStore,
      }),
    }),
    attemptStatus: (request) => hyperliquidExecutionRuntime!.status(request),
  });
/** The public Base account route reads several contracts per request; identical reads within 2s are joined. */
function cachedBaseAccount(port: BaseSepoliaOrderRuntime["account"]): BaseSepoliaOrderRuntime["account"] {
  const cache = createReadCache<Awaited<ReturnType<BaseSepoliaOrderRuntime["account"]["status"]>>>({ ttlMs: 2_000 });
  return Object.freeze({
    status: (request: Parameters<BaseSepoliaOrderRuntime["account"]["status"]>[0]) => cache(
      `${request.owner}|${request.orderHash ?? ""}|${request.marginAtoms}`,
      () => port.status(request),
    ),
  });
}
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
// Lanes that buy spot from a pool price each entry from the pool's executable cost for its size.
const orderSpotPrice: InternalOrderSpotPricePort = Object.freeze({
  entrySpotPrice: async (context: ActiveOrderContext, sizeAtoms: bigint) => {
    if (baseOrderRuntime !== undefined && context.contextId === baseOrderRuntime.config.contextId) {
      return baseOrderRuntime.spotPrice.entrySpotPrice(context, sizeAtoms);
    }
    if (arbitrumOrderRuntime !== undefined && context.contextId === arbitrumOrderRuntime.config.contextId) {
      return arbitrumOrderRuntime.spotPrice.entrySpotPrice(context, sizeAtoms);
    }
    return undefined;
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

const terminalMarketSources: TerminalMarketSources = {
  ...terminalMarkets,
  ...(baseOrderRuntime === undefined ? {} : { base: createBaseSepoliaMarketSource(baseOrderRuntime) }),
  ...(arbitrumMarketSource === undefined ? {} : { arbitrum: arbitrumMarketSource }),
  ...(solanaDevnetOrderRuntime === undefined ? {} : { solana: createSolanaDevnetMarketSource(solanaDevnetOrderRuntime) }),
};
// Reference history: every configured lane's live market source, sampled into a durable store the
// terminal chart reads. On only when its database path is set.
const referenceHistoryPath = process.env.NARYX_REFERENCE_HISTORY_DB;
const referenceHistory = referenceHistoryPath === undefined || referenceHistoryPath === ""
  ? undefined
  : new SqliteReferenceHistoryStore(absolutePath(referenceHistoryPath, "NARYX_REFERENCE_HISTORY_DB"));
const referenceRecorder = referenceHistory === undefined ? undefined : new ReferenceHistoryRecorder(
  referenceHistory,
  Object.entries(terminalMarketSources).flatMap(([domain, source]): ReferenceLane[] => {
    const legs = referenceSources[domain as DomainId];
    return source === undefined || legs === undefined
      ? []
      : [{ domain: domain as DomainId, source, spotSource: legs.spot, perpSource: legs.perp }];
  }),
);
referenceRecorder?.start();

// Each lane's store answers only for its own attempt IDs.
const ownerPackageOutcomes: OwnerPackageOutcomeReader = (attemptId) =>
  basePreparationStore?.attemptOutcome(attemptId) ?? arbitrumOutcomeStore?.attemptOutcome(attemptId);

const server = createPrivateTerminalServer(
  config,
  runtime.solanaDevnet,
  { contexts: orderContexts, store: orderStore, clock: orderClock, spotPrice: orderSpotPrice },
  runtime.hyperliquidTestnet,
  baseOrderRuntime === undefined || runtime.evmTestnet.preparation === undefined
    ? runtime.evmTestnet
    : { ...runtime.evmTestnet, account: cachedBaseAccount(baseOrderRuntime.account) },
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
    baseExitRoutes,
    hyperliquidOwnerRoutes,
    referenceHistory === undefined
      ? undefined
      : createReferenceCandleRoutes({ store: referenceHistory, markets: terminalMarketSources }),
  ),
  terminalMarketSources,
  ownerPackageOutcomes,
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
  referenceRecorder?.stop();
  publicServer?.close();
  server.close(() => {
    orderStore.close();
    lifecycleStore.close();
    executionIntentStore.close();
    solanaLocalPreparationStore?.close();
    basePreparationStore?.close();
    arbitrumOutcomeStore?.close();
    hyperliquidExecutionRuntime?.close();
    hyperliquidOwnerLedger?.close();
    referenceHistory?.close();
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
