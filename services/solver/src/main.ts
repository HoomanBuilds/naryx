import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import type { Server } from 'node:http';
import { LOCAL_ATOMIC_MARKET_CATALOG_V1, localConformanceSlot } from '@naryx/adapter-core';
import { SolanaConformanceAdapter } from '@naryx/adapter-solana';
import { Connection } from '@solana/web3.js';
import {
  HttpSelectedSolanaAdmissionProvider,
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
  createLocalAtomicMarketRuntime,
  loadHyperliquidTestnetAgentSigner,
  loadHyperliquidTestnetExecutorRuntime,
  loadHyperliquidTestnetQuoteRuntime,
  type LoadedHyperliquidTestnetExecutorRuntime,
} from './index.js';
import { loadSolanaLocalEnvironmentRuntime } from './solana-local-environment-runtime.js';
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
const quoteProviders = composeQuoteProviders(localRuntime?.providers, hyperliquidQuoteRuntime?.providers);
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
      connection: new Connection(manifestRuntime.manifest.rpc.url, 'confirmed'),
      domain: manifestRuntime.manifest.runtime.catalog.domain,
      environment: 'local',
      expectedGenesisHash: manifestRuntime.manifest.rpc.genesisHash,
      executionSignatureProvider: () => { throw new Error('authorization compilation does not request a signature'); },
    }),
    signer: executionSigner,
    store: authorizationStore,
    readSlot: manifestRuntime.readSlot,
  });
const quoteServer = createInternalAtomicQuoteServer(coordinator, authorization);
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
    attempts: new HttpHyperliquidTestnetTrustedAttemptProvider({ apiOrigin }),
    signer: hyperliquidSigner,
  });
  if (executorRuntime.runtimeFactory === undefined) {
    throw new Error('Hyperliquid Testnet executor runtime is unavailable');
  }
  executorServer = createHyperliquidTestnetExecutorServer(executorRuntime.runtimeFactory);
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (clockRefresh !== undefined) clearInterval(clockRefresh);
  void Promise.allSettled([close(quoteServer), close(executorServer)]).then((results) => {
    executorRuntime?.close();
    store.close();
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
} catch (error) {
  await Promise.allSettled([close(quoteServer), close(executorServer)]);
  executorRuntime?.close();
  store.close();
  authorizationStore?.close();
  throw error;
}
const hyperliquidQuotes = hyperliquidQuoteRuntime === undefined ? 'DISABLED' : 'TESTNET_LIVE_BOOK';
process.stdout.write(`Internal solver listening on http://${host}:${listenPort} `
  + `runtime=${config.localRuntime.kind} hyperliquidTestnetQuotes=${hyperliquidQuotes}\n`);
if (config.localRuntime.kind === 'LOCAL_FIXTURE') {
  process.stdout.write('LOCAL FIXTURE MODE: local quotes use fixed catalog prices and placeholder '
    + `hashes, signed with the configured solver key. Quote database: ${config.quoteDbPath}\n`);
}
if (executorServer !== undefined && executorPort !== undefined) {
  process.stdout.write(`Hyperliquid Testnet executor listening on http://${host}:${executorPort}\n`);
}
