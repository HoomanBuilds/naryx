import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { LOCAL_ATOMIC_MARKET_CATALOG_V1, localConformanceSlot } from '@naryx/adapter-core';
import { SolanaConformanceAdapter, createBoundedSolanaConnection } from '@naryx/adapter-solana';
import {
  HttpSelectedSolanaAdmissionProvider,
  HttpHyperliquidTestnetCompositeAttemptProvider,
  HttpHyperliquidTestnetTrustedAttemptProvider,
  HttpInternalOrderProvider,
  SolanaExecutionAuthorizationService,
  SqliteAtomicQuoteNonceSource,
  SqliteSolanaExecutionAuthorizationStore,
  SqliteInternalAtomicQuoteStore,
  composeQuoteProviders,
  createInternalAtomicQuoteCoordinator,
  createInternalAtomicQuoteServer,
  createHyperliquidTestnetExecutorServer,
  createHyperliquidTestnetExitQuotePort,
  createLocalAtomicMarketRuntime,
  ArbitrumSepoliaExecutor,
  HttpArbitrumSepoliaAttemptProvider,
  SqliteArbitrumSepoliaExecutionJournal,
  createArbitrumSepoliaExecutorServer,
  createViemArbitrumSepoliaWritePort,
  loadArbitrumSepoliaExecutorConfig,
  loadArbitrumSepoliaKey,
  loadArbitrumSepoliaExitQuotes,
  loadArbitrumSepoliaQuoteRuntime,
  requireArbitrumSepoliaChain,
  loadHyperliquidTestnetAgentSigner,
  loadHyperliquidTestnetExecutorRuntime,
  loadHyperliquidTestnetGeneralizedQuoteLanes,
  loadHyperliquidTestnetQuoteRuntime,
  type LoadedHyperliquidTestnetExecutorRuntime,
  createStrategyPreparationInternalHandler,
  HttpStrategyPackageProvider,
  HyperliquidStrategyPreparationContextResolver,
  loadHyperliquidStrategyPreparationLane,
  StrategyPreparationService,
  createGeneralizedStrategyQuoteInternalHandler,
  GeneralizedStrategyQuoteContextRegistry,
  GeneralizedStrategyQuoteService,
  SqliteGeneralizedStrategyQuoteStore,
  EvmOptionSpreadPreparationContextResolver,
  EvmTreasuryHedgePreparationContextResolver,
  EvmCollateralConversionPreparationContextResolver,
  EvmReverseBasisPreparationContextResolver,
  EvmOptionSpreadProvisioningResolver,
  EvmOptionSpreadProvisioningService,
  createEvmOptionSpreadProvisioningInternalHandler,
  EvmReverseBasisCollateralService,
  createEvmReverseBasisCollateralInternalHandler,
  loadEvmOptionSpreadRuntime,
  loadEvmTreasuryHedgeRuntime,
  loadEvmCollateralConversionRuntime,
  loadEvmReverseBasisRuntime,
  SqliteEvmStrategyPackageIdStore,
  EvmStrategyExecutionAuthorizationService,
  createEvmStrategyExecutionAuthorizationInternalHandler,
  loadEvmStrategySolverKey,
  EvmStrategyExecutionObservationService,
  createEvmOptionSpreadObservationInternalHandler,
  loadSolanaTreasuryHedgeRuntime,
  SolanaTreasuryHedgePreparationContextResolver,
  SqliteSolanaStrategyPackageIdStore,
} from './index.js';
import { loadSolanaLocalEnvironmentRuntime } from './solana-local-environment-runtime.js';
import { withBaseSepoliaQuoteProviders } from './base-sepolia-quote-runtime.js';
import { loadBaseSepoliaSolverRuntime } from './base-sepolia-solver-authorization.js';
import { loadSolanaDevnetSolverRuntime } from './solana-devnet-solver-runtime.js';
import { explicitBoolean, loadSolverProcessConfig, tcpPort } from './solver-process-config.js';

const ED25519_SPKI_PREFIX_BYTES = 12;

function listen(server: Server, listenPort: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(listenPort, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}

function close(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => {
    server.close((error) => error === undefined ? resolveClose() : reject(error));
  });
}

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

function loadSigner(path: string) {
  const privateKey = createPrivateKey(readFileSync(absolutePath(path, 'NARYX_SOLVER_ED25519_KEY_PATH')));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('solver signing key must be Ed25519');
  }
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  if (!(spki instanceof Buffer) || spki.length !== ED25519_SPKI_PREFIX_BYTES + 32) {
    throw new Error('solver Ed25519 public key encoding is invalid');
  }
  const verificationKey = Uint8Array.from(spki.subarray(ED25519_SPKI_PREFIX_BYTES));
  const expected = process.env.NARYX_SOLVER_ED25519_PUBLIC_KEY_HEX;
  if (expected !== undefined
    && (!/^[0-9a-f]{64}$/.test(expected)
      || Buffer.from(verificationKey).toString('hex') !== expected)) {
    throw new Error('solver signing key does not match the configured verification key');
  }
  return Object.freeze({
    scheme: 'ED25519' as const,
    verificationKey,
    signDigest: (digest: Uint8Array) => Uint8Array.from(sign(null, Buffer.from(digest), privateKey)),
  });
}

const config = loadSolverProcessConfig(process.env);
const { host, port: listenPort, apiOrigin } = config;
const executionSigner = loadSigner(config.signerPath);
const store = new SqliteInternalAtomicQuoteStore(config.quoteDbPath);
const manifestRuntime = config.localRuntime.kind === 'MANIFEST_VALIDATED'
  ? await loadSolanaLocalEnvironmentRuntime(config.localRuntime.manifestPath, config.localRuntime.solverId)
  : undefined;
let validatorSlot = manifestRuntime?.initialSlot;
const localNonceSource = new SqliteAtomicQuoteNonceSource(store, 'svm:local');
const localRuntime = manifestRuntime !== undefined
  ? createLocalAtomicMarketRuntime(manifestRuntime.manifest.runtime.catalog, localNonceSource, () => {
    if (validatorSlot === undefined) throw new Error('validator clock is unavailable');
    return validatorSlot;
  })
  : config.localRuntime.kind === 'LOCAL_FIXTURE'
    ? createLocalAtomicMarketRuntime(LOCAL_ATOMIC_MARKET_CATALOG_V1, localNonceSource, localConformanceSlot)
    : undefined;
const hyperliquidQuoteRuntime = loadHyperliquidTestnetQuoteRuntime(process.env, {
  nonceSource: new SqliteAtomicQuoteNonceSource(store, 'hypercore:testnet'),
});
const arbitrumQuoteProviders = loadArbitrumSepoliaQuoteRuntime(process.env, {
  nonceSource: new SqliteAtomicQuoteNonceSource(store, 'eip155:421614'),
});
// Base Sepolia: disabled unless NARYX_BASE_SEPOLIA_QUOTE_ENABLED=true.
const baseSolver = await loadBaseSepoliaSolverRuntime(process.env, {
  nonceSource: new SqliteAtomicQuoteNonceSource(store, 'eip155:84532'),
  quoteVerificationKey: executionSigner.verificationKey,
  apiOrigin,
  reservedPorts: [listenPort],
});
await baseSolver?.listen(host);
const quoteProviders = withBaseSepoliaQuoteProviders(baseSolver?.providers, composeQuoteProviders(
  localRuntime?.providers,
  hyperliquidQuoteRuntime?.providers,
  arbitrumQuoteProviders,
));
const clockRefresh = manifestRuntime === undefined
  ? undefined
  : setInterval(() => {
    void manifestRuntime.readSlot().then((slot) => { validatorSlot = slot; }).catch(() => { validatorSlot = undefined; });
  }, 250);
clockRefresh?.unref();
const orderProvider = new HttpInternalOrderProvider(apiOrigin);
const coordinator = createInternalAtomicQuoteCoordinator({
  orders: orderProvider.get,
  candidates: quoteProviders.candidates,
  terms: quoteProviders.terms,
  signer: executionSigner,
  store,
});
const authorizationStore = config.localRuntime.kind === 'MANIFEST_VALIDATED'
  ? new SqliteSolanaExecutionAuthorizationStore(config.localRuntime.authorizationDbPath)
  : undefined;
const authorization = manifestRuntime === undefined || authorizationStore === undefined
  ? undefined
  : new SolanaExecutionAuthorizationService({
    manifest: manifestRuntime.manifest,
    selectedAdmission: new HttpSelectedSolanaAdmissionProvider(apiOrigin).get,
    compiler: new SolanaConformanceAdapter({
      connection: createBoundedSolanaConnection(manifestRuntime.manifest.rpc.url, 'confirmed'),
      domain: manifestRuntime.manifest.runtime.catalog.domain,
      environment: 'local',
      expectedGenesisHash: manifestRuntime.manifest.rpc.genesisHash,
      executionSignatureProvider: () => { throw new Error('authorization compilation does not request a signature'); },
    }),
    signer: executionSigner,
    store: authorizationStore,
    readSlot: manifestRuntime.readSlot,
  });
// Solana Devnet: disabled unless NARYX_SOLANA_DEVNET_SOLVER_ENABLED=true. FIRM_ONCHAIN quotes for
// svm:devnet orders and the loopback attempt-binding endpoint the API's Devnet runtime calls.
const solanaDevnetSolver = await loadSolanaDevnetSolverRuntime(process.env, {
  nonceSource: new SqliteAtomicQuoteNonceSource(store, 'svm:devnet'),
  apiOrigin,
  reservedPorts: [listenPort],
});
await solanaDevnetSolver?.listen(host);
// Hyperliquid, Base Sepolia, and Arbitrum Sepolia exits are quoted by their runtimes; every other order
// reaches the entry coordinator.
const hyperliquidQuotePort = hyperliquidQuoteRuntime === undefined ? coordinator : createHyperliquidTestnetExitQuotePort({
  exit: hyperliquidQuoteRuntime.exit, orders: orderProvider.get, signer: executionSigner, store,
}, coordinator);
const baseQuotePort = baseSolver?.wrapExit(hyperliquidQuotePort, { orders: orderProvider.get, signer: executionSigner, store }) ?? hyperliquidQuotePort;
// Arbitrum Sepolia EXIT orders are quoted from the owner's open package on chain.
const arbitrumExitQuotes = loadArbitrumSepoliaExitQuotes(process.env, {
  nonceSource: new SqliteAtomicQuoteNonceSource(store, 'eip155:421614'),
  orders: orderProvider.get,
  signer: executionSigner,
  store,
});
const quotePort = arbitrumExitQuotes?.wrap(baseQuotePort) ?? baseQuotePort;
const strategyPreparationPaths = (process.env.NARYX_HYPERLIQUID_STRATEGY_PREPARATION_CONFIGS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '');
const strategyPreparationLanes = strategyPreparationPaths.map(loadHyperliquidStrategyPreparationLane);
const strategyPackageProvider = new HttpStrategyPackageProvider(apiOrigin);
const evmOptionRuntimePath = process.env.NARYX_EVM_OPTION_SPREAD_RUNTIME_CONFIG;
const evmTreasuryRuntimePath = process.env.NARYX_EVM_TREASURY_HEDGE_RUNTIME_CONFIG;
const evmCollateralConversionRuntimePath = process.env.NARYX_EVM_COLLATERAL_CONVERSION_RUNTIME_CONFIG;
const evmReverseBasisRuntimePath = process.env.NARYX_EVM_REVERSE_BASIS_RUNTIME_CONFIG;
const solanaTreasuryRuntimePath = process.env.NARYX_SOLANA_TREASURY_HEDGE_RUNTIME_CONFIG;
const evmRuntimeConfigured = (evmOptionRuntimePath !== undefined && evmOptionRuntimePath !== '')
  || (evmTreasuryRuntimePath !== undefined && evmTreasuryRuntimePath !== '')
  || (evmCollateralConversionRuntimePath !== undefined && evmCollateralConversionRuntimePath !== '')
  || (evmReverseBasisRuntimePath !== undefined && evmReverseBasisRuntimePath !== '');
const evmStrategyPackageIds = !evmRuntimeConfigured
  ? undefined
  : new SqliteEvmStrategyPackageIdStore(config.quoteDbPath);
const evmOptionRuntime = evmOptionRuntimePath === undefined || evmOptionRuntimePath === ''
  ? undefined
  : loadEvmOptionSpreadRuntime(absolutePath(
      evmOptionRuntimePath,
      'NARYX_EVM_OPTION_SPREAD_RUNTIME_CONFIG',
    ), {
      nonceSource: (laneId) => {
        const source = new SqliteAtomicQuoteNonceSource(store, `evm-option:${laneId}`);
        return Object.freeze({ nextNonce: () => source.next() });
      },
      packageIds: evmStrategyPackageIds!,
    });
const evmTreasuryRuntime = evmTreasuryRuntimePath === undefined || evmTreasuryRuntimePath === ''
  ? undefined
  : loadEvmTreasuryHedgeRuntime(absolutePath(
      evmTreasuryRuntimePath,
      'NARYX_EVM_TREASURY_HEDGE_RUNTIME_CONFIG',
    ), {
      nonceSource: (laneId) => {
        const source = new SqliteAtomicQuoteNonceSource(store, `evm-treasury:${laneId}`);
        return Object.freeze({ nextNonce: () => source.next() });
      },
      packageIds: evmStrategyPackageIds!,
    });
const evmCollateralConversionRuntime = evmCollateralConversionRuntimePath === undefined
    || evmCollateralConversionRuntimePath === ''
  ? undefined
  : loadEvmCollateralConversionRuntime(absolutePath(
      evmCollateralConversionRuntimePath,
      'NARYX_EVM_COLLATERAL_CONVERSION_RUNTIME_CONFIG',
    ), {
      nonceSource: (laneId) => {
        const source = new SqliteAtomicQuoteNonceSource(store, `evm-collateral-conversion:${laneId}`);
        return Object.freeze({ nextNonce: () => source.next() });
      },
      packageIds: evmStrategyPackageIds!,
    });
const evmReverseBasisRuntime = evmReverseBasisRuntimePath === undefined || evmReverseBasisRuntimePath === ''
  ? undefined
  : loadEvmReverseBasisRuntime(absolutePath(
      evmReverseBasisRuntimePath,
      'NARYX_EVM_REVERSE_BASIS_RUNTIME_CONFIG',
    ), {
      nonceSource: (laneId) => {
        const source = new SqliteAtomicQuoteNonceSource(store, `evm-reverse-basis:${laneId}`);
        return Object.freeze({ nextNonce: () => source.next() });
      },
      packageIds: evmStrategyPackageIds!,
    });
const solanaStrategyPackageIds = solanaTreasuryRuntimePath === undefined || solanaTreasuryRuntimePath === ''
  ? undefined
  : new SqliteSolanaStrategyPackageIdStore(config.quoteDbPath);
const solanaTreasuryRuntime = solanaTreasuryRuntimePath === undefined || solanaTreasuryRuntimePath === ''
  ? undefined
  : await loadSolanaTreasuryHedgeRuntime(absolutePath(
      solanaTreasuryRuntimePath,
      'NARYX_SOLANA_TREASURY_HEDGE_RUNTIME_CONFIG',
    ), {
      nonceSource: (laneId) => {
        const source = new SqliteAtomicQuoteNonceSource(store, `solana-treasury:${laneId}`);
        return Object.freeze({ nextNonce: () => source.next() });
      },
      packageIds: solanaStrategyPackageIds!,
    });
const hyperliquidPreparationResolver = strategyPreparationLanes.length === 0
  ? undefined
  : new HyperliquidStrategyPreparationContextResolver(strategyPreparationLanes);
const evmOptionPreparationResolver = evmOptionRuntime === undefined
  ? undefined
  : new EvmOptionSpreadPreparationContextResolver(evmOptionRuntime.preparationLanes);
const evmTreasuryPreparationResolver = evmTreasuryRuntime === undefined
  ? undefined
  : new EvmTreasuryHedgePreparationContextResolver(evmTreasuryRuntime.preparationLanes);
const evmCollateralConversionPreparationResolver = evmCollateralConversionRuntime === undefined
  ? undefined
  : new EvmCollateralConversionPreparationContextResolver(evmCollateralConversionRuntime.preparationLanes);
const evmReverseBasisPreparationResolver = evmReverseBasisRuntime === undefined
  ? undefined
  : new EvmReverseBasisPreparationContextResolver(evmReverseBasisRuntime.preparationLanes);
const solanaTreasuryPreparationResolver = solanaTreasuryRuntime === undefined
  ? undefined
  : new SolanaTreasuryHedgePreparationContextResolver(solanaTreasuryRuntime.preparationLanes);
const strategyPreparationResolver = hyperliquidPreparationResolver === undefined
    && evmOptionPreparationResolver === undefined
    && evmTreasuryPreparationResolver === undefined
    && evmCollateralConversionPreparationResolver === undefined
    && evmReverseBasisPreparationResolver === undefined
    && solanaTreasuryPreparationResolver === undefined
  ? undefined
  : Object.freeze({
      resolve: (documents: Parameters<HyperliquidStrategyPreparationContextResolver['resolve']>[0]) => {
        const evmOption = documents.order.templateId === 'option-spread-v1'
          && documents.graph.legs.every((leg) => leg.domain.domainId.startsWith('eip155:'));
        if (evmOption) {
          if (evmOptionPreparationResolver === undefined) throw new Error('EVM option spread preparation is not configured');
          return evmOptionPreparationResolver.resolve(documents);
        }
        const evmTreasury = documents.order.templateId === 'treasury-inventory-hedge-v1'
          && documents.graph.legs.every((leg) => leg.domain.domainId.startsWith('eip155:'));
        if (evmTreasury) {
          if (evmTreasuryPreparationResolver === undefined) throw new Error('EVM treasury hedge preparation is not configured');
          return evmTreasuryPreparationResolver.resolve(documents);
        }
        const solanaTreasury = documents.order.templateId === 'treasury-inventory-hedge-v1'
          && documents.graph.legs.every((leg) => leg.domain.domainId === 'svm:devnet');
        if (solanaTreasury) {
          if (solanaTreasuryPreparationResolver === undefined) {
            throw new Error('Solana treasury hedge preparation is not configured');
          }
          return solanaTreasuryPreparationResolver.resolve(documents);
        }
        const evmCollateralConversion = documents.order.templateId === 'collateral-conversion-hedge-v1'
          && documents.graph.legs.every((leg) => leg.domain.domainId.startsWith('eip155:'));
        if (evmCollateralConversion) {
          if (evmCollateralConversionPreparationResolver === undefined) {
            throw new Error('EVM collateral conversion preparation is not configured');
          }
          return evmCollateralConversionPreparationResolver.resolve(documents);
        }
        const evmReverseBasis = documents.order.templateId === 'reverse-cash-and-carry-v1'
          && documents.graph.legs.every((leg) => leg.domain.domainId.startsWith('eip155:'));
        if (evmReverseBasis) {
          if (evmReverseBasisPreparationResolver === undefined) {
            throw new Error('EVM reverse basis preparation is not configured');
          }
          return evmReverseBasisPreparationResolver.resolve(documents);
        }
        if (hyperliquidPreparationResolver === undefined) throw new Error('Hyperliquid strategy preparation is not configured');
        return hyperliquidPreparationResolver.resolve(documents);
      },
    });
const strategyPreparationService = strategyPreparationResolver === undefined
  ? undefined
  : new StrategyPreparationService(
      strategyPackageProvider,
      strategyPreparationResolver,
    );
const strategyPreparationHandler = strategyPreparationService === undefined
  ? undefined
  : createStrategyPreparationInternalHandler(strategyPreparationService);
const generalizedStrategyLanes = loadHyperliquidTestnetGeneralizedQuoteLanes(
  process.env,
  strategyPreparationLanes,
  { nonceSource: new SqliteAtomicQuoteNonceSource(store, 'hypercore:testnet:generalized') },
);
const allGeneralizedStrategyLanes = Object.freeze([
  ...generalizedStrategyLanes,
  ...(evmOptionRuntime?.quoteLanes ?? []),
  ...(evmTreasuryRuntime?.quoteLanes ?? []),
  ...(evmCollateralConversionRuntime?.quoteLanes ?? []),
  ...(evmReverseBasisRuntime?.quoteLanes ?? []),
  ...(solanaTreasuryRuntime?.quoteLanes ?? []),
]);
const generalizedQuoteStore = allGeneralizedStrategyLanes.length === 0
  ? undefined
  : new SqliteGeneralizedStrategyQuoteStore(config.quoteDbPath);
const generalizedStrategyQuoteHandler = allGeneralizedStrategyLanes.length === 0
  ? undefined
  : createGeneralizedStrategyQuoteInternalHandler(new GeneralizedStrategyQuoteService({
    packages: strategyPackageProvider,
    contexts: new GeneralizedStrategyQuoteContextRegistry(allGeneralizedStrategyLanes),
    signer: executionSigner,
    store: generalizedQuoteStore!,
  }));
const evmPreparationLanes = Object.freeze([
  ...(evmOptionRuntime?.preparationLanes ?? []),
  ...(evmTreasuryRuntime?.preparationLanes ?? []),
  ...(evmCollateralConversionRuntime?.preparationLanes ?? []),
  ...(evmReverseBasisRuntime?.preparationLanes ?? []),
]);
const evmOptionProvisioningHandler = evmPreparationLanes.length === 0
  ? undefined
  : createEvmOptionSpreadProvisioningInternalHandler(new EvmOptionSpreadProvisioningService(
      strategyPackageProvider,
      new EvmOptionSpreadProvisioningResolver(evmPreparationLanes),
    ));
const evmReverseBasisCollateralHandler = evmReverseBasisRuntime === undefined
  ? undefined
  : createEvmReverseBasisCollateralInternalHandler(new EvmReverseBasisCollateralService(
      strategyPackageProvider,
      evmReverseBasisRuntime.preparationLanes,
    ));
const evmStrategyAuthorizationHandler = !evmRuntimeConfigured || strategyPreparationService === undefined
  ? undefined
  : createEvmStrategyExecutionAuthorizationInternalHandler(new EvmStrategyExecutionAuthorizationService({
      packages: strategyPackageProvider,
      preparations: strategyPreparationService,
      solver: loadEvmStrategySolverKey(
        process.env.NARYX_EVM_STRATEGY_SOLVER_KEY_PATH,
        process.env.NARYX_EVM_STRATEGY_SOLVER_ADDRESS,
      ),
    }));
const evmObservationLanes = [...new Map([
  ...(evmOptionRuntime?.observationLanes ?? []),
  ...(evmTreasuryRuntime?.observationLanes ?? []),
  ...(evmCollateralConversionRuntime?.observationLanes ?? []),
  ...(evmReverseBasisRuntime?.observationLanes ?? []),
].map((lane) => [lane.chainId, lane])).values()];
const evmOptionObservationHandler = evmObservationLanes.length === 0 || strategyPreparationService === undefined
  ? undefined
  : createEvmOptionSpreadObservationInternalHandler(new EvmStrategyExecutionObservationService({
      packages: strategyPackageProvider,
      preparations: strategyPreparationService,
      lanes: evmObservationLanes,
    }));
const strategyRouteHandlers = [
  generalizedStrategyQuoteHandler,
  strategyPreparationHandler,
  evmOptionProvisioningHandler,
  evmReverseBasisCollateralHandler,
  evmStrategyAuthorizationHandler,
  evmOptionObservationHandler,
]
  .filter((handler) => handler !== undefined);
const strategyRouteHandler = strategyRouteHandlers.length === 0
  ? undefined
  : async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    for (const handler of strategyRouteHandlers) if (await handler(request, response)) return true;
    return false;
  };
const quoteServer = createInternalAtomicQuoteServer(
  solanaDevnetSolver?.wrap(quotePort) ?? quotePort,
  authorization,
  strategyRouteHandler,
);
const executorEnabled = explicitBoolean(
  process.env.NARYX_HYPERLIQUID_TESTNET_EXECUTOR_ENABLED,
  'NARYX_HYPERLIQUID_TESTNET_EXECUTOR_ENABLED',
);
let executorRuntime: LoadedHyperliquidTestnetExecutorRuntime | undefined;
let executorServer: Server | undefined;
let executorPort: number | undefined;
if (executorEnabled) {
  executorPort = tcpPort(
    process.env.NARYX_HYPERLIQUID_TESTNET_EXECUTOR_PORT,
    'NARYX_HYPERLIQUID_TESTNET_EXECUTOR_PORT',
    8_792,
  );
  if (executorPort === listenPort) {
    throw new Error('Hyperliquid Testnet executor port must differ from the quote port');
  }
  const keyPath = process.env.NARYX_HYPERLIQUID_TESTNET_AGENT_KEY_PATH;
  const expectedAgent = process.env.NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS;
  if (keyPath === undefined || keyPath.length === 0) {
    throw new Error('NARYX_HYPERLIQUID_TESTNET_AGENT_KEY_PATH is required');
  }
  if (expectedAgent === undefined || expectedAgent.length === 0) {
    throw new Error('NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS is required');
  }
  const hyperliquidSigner = loadHyperliquidTestnetAgentSigner(keyPath, expectedAgent);
  executorRuntime = await loadHyperliquidTestnetExecutorRuntime({
    ...process.env,
    NARYX_HYPERLIQUID_TESTNET_EXECUTION_ENABLED: 'true',
  }, {
    attempts: strategyPreparationService === undefined
      ? new HttpHyperliquidTestnetTrustedAttemptProvider({ apiOrigin })
      : new HttpHyperliquidTestnetCompositeAttemptProvider({
          apiOrigin,
          packages: strategyPackageProvider,
          preparations: strategyPreparationService,
        }),
    signer: hyperliquidSigner,
  });
  if (executorRuntime.runtimeFactory === undefined) {
    throw new Error('Hyperliquid Testnet executor runtime is unavailable');
  }
  // The loopback release-lane route is the operator surface of the runtime's journaled lane release.
  executorServer = createHyperliquidTestnetExecutorServer(executorRuntime.runtimeFactory, executorRuntime);
}

// Arbitrum Sepolia async executor: disabled unless explicitly enabled. Only the solver key is loaded,
// from an external file; owners sign reservations in their own wallets. eth_chainId must be 421614
// before any write.
const arbitrumExecutorEnabled = explicitBoolean(
  process.env.NARYX_ARBITRUM_SEPOLIA_EXECUTOR_ENABLED,
  'NARYX_ARBITRUM_SEPOLIA_EXECUTOR_ENABLED',
);
let arbitrumJournal: SqliteArbitrumSepoliaExecutionJournal | undefined;
let arbitrumExecutorServer: Server | undefined;
let arbitrumExecutorPort: number | undefined;
if (arbitrumExecutorEnabled) {
  arbitrumExecutorPort = tcpPort(
    process.env.NARYX_ARBITRUM_SEPOLIA_EXECUTOR_PORT,
    'NARYX_ARBITRUM_SEPOLIA_EXECUTOR_PORT',
    8_793,
  );
  if (arbitrumExecutorPort === listenPort || arbitrumExecutorPort === executorPort) {
    throw new Error('Arbitrum Sepolia executor port must differ from the other solver ports');
  }
  const solverAccount = loadArbitrumSepoliaKey(
    process.env.NARYX_ARBITRUM_SEPOLIA_SOLVER_KEY_PATH ?? '',
    process.env.NARYX_ARBITRUM_SEPOLIA_SOLVER_ADDRESS ?? '',
    'Arbitrum Sepolia solver key',
  );
  const arbitrumChain = createViemArbitrumSepoliaWritePort(
    process.env.NARYX_ARBITRUM_SEPOLIA_RPC_URL ?? '',
    solverAccount,
  );
  await requireArbitrumSepoliaChain(arbitrumChain);
  arbitrumJournal = new SqliteArbitrumSepoliaExecutionJournal(
    process.env.NARYX_ARBITRUM_SEPOLIA_EXECUTOR_DB ?? '',
  );
  arbitrumExecutorServer = createArbitrumSepoliaExecutorServer(new ArbitrumSepoliaExecutor({
    config: loadArbitrumSepoliaExecutorConfig(process.env.NARYX_ARBITRUM_SEPOLIA_EXECUTOR_CONFIG ?? ''),
    attempts: new HttpArbitrumSepoliaAttemptProvider(apiOrigin, executionSigner.verificationKey),
    chain: arbitrumChain,
    journal: arbitrumJournal,
  }));
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (clockRefresh !== undefined) clearInterval(clockRefresh);
  void Promise.allSettled([
    close(quoteServer), close(executorServer), close(arbitrumExecutorServer), baseSolver?.close(),
    solanaDevnetSolver?.close(),
  ]).then((results) => {
    executorRuntime?.close();
    arbitrumJournal?.close();
    store.close();
    generalizedQuoteStore?.close();
    evmStrategyPackageIds?.close();
    solanaStrategyPackageIds?.close();
    authorizationStore?.close();
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      const error = failed.reason;
      process.stderr.write(`Solver shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = 0;
    }
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
try {
  await listen(quoteServer, listenPort, host);
  if (executorServer !== undefined && executorPort !== undefined) {
    await listen(executorServer, executorPort, host);
  }
  if (arbitrumExecutorServer !== undefined && arbitrumExecutorPort !== undefined) {
    await listen(arbitrumExecutorServer, arbitrumExecutorPort, host);
  }
} catch (error) {
  await Promise.allSettled([close(quoteServer), close(executorServer), close(arbitrumExecutorServer)]);
  executorRuntime?.close();
  arbitrumJournal?.close();
  store.close();
  generalizedQuoteStore?.close();
  evmStrategyPackageIds?.close();
  solanaStrategyPackageIds?.close();
  authorizationStore?.close();
  throw error;
}
const hyperliquidQuotes = hyperliquidQuoteRuntime === undefined ? 'DISABLED' : 'TESTNET_LIVE_BOOK';
const arbitrumQuotes = arbitrumQuoteProviders === undefined ? 'DISABLED' : 'SEPOLIA_LIVE_REFERENCE';
const generalizedHyperliquid = generalizedStrategyLanes.length > 0
  ? 'LIVE_TESTNET_QUOTES'
  : strategyPreparationHandler === undefined ? 'DISABLED' : 'PREPARATION_ONLY';
process.stdout.write(`Internal solver listening on http://${host}:${listenPort} `
  + `runtime=${config.localRuntime.kind} hyperliquidTestnetQuotes=${hyperliquidQuotes} `
  + `arbitrumSepoliaQuotes=${arbitrumQuotes} hyperliquidStrategies=${generalizedHyperliquid}\n`);
if (config.localRuntime.kind === 'LOCAL_FIXTURE') {
  process.stdout.write('LOCAL FIXTURE MODE: local quotes use fixed catalog prices and placeholder '
    + `hashes, signed with the configured solver key. Quote database: ${config.quoteDbPath}\n`);
}
if (executorServer !== undefined && executorPort !== undefined) {
  process.stdout.write(`Hyperliquid Testnet executor listening on http://${host}:${executorPort}\n`);
}
if (arbitrumExecutorServer !== undefined && arbitrumExecutorPort !== undefined) {
  process.stdout.write(`Arbitrum Sepolia executor listening on http://${host}:${arbitrumExecutorPort}\n`);
}
