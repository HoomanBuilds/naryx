import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { LOCAL_ATOMIC_MARKET_CATALOG_V1 } from '@naryx/adapter-core';
import { SolanaConformanceAdapter } from '@naryx/adapter-solana';
import { Connection } from '@solana/web3.js';
import {
  HttpSelectedSolanaAdmissionProvider,
  HttpInternalOrderProvider,
  SolanaExecutionAuthorizationService,
  SqliteSolanaExecutionAuthorizationStore,
  SqliteInternalAtomicQuoteStore,
  createInternalAtomicQuoteCoordinator,
  createInternalAtomicQuoteServer,
  createLocalAtomicMarketRuntime,
} from './index.js';
import { loadSolanaLocalEnvironmentRuntime } from './solana-local-environment-runtime.js';

const ED25519_SPKI_PREFIX_BYTES = 12;

function loopbackHost(value: string): string {
  if (value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value)) return value;
  throw new Error('NARYX_SOLVER_HOST must be loopback');
}

function port(value: string | undefined): number {
  if (value === undefined) return 8_788;
  if (!/^\d{1,5}$/.test(value)) throw new Error('NARYX_SOLVER_PORT must be a TCP port');
  const parsed = Number(value);
  if (parsed < 1 || parsed > 65_535) throw new Error('NARYX_SOLVER_PORT must be a TCP port');
  return parsed;
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

const host = loopbackHost(process.env.NARYX_SOLVER_HOST ?? '127.0.0.1');
const listenPort = port(process.env.NARYX_SOLVER_PORT);
const quoteDbPath = absolutePath(
  process.env.NARYX_SOLVER_QUOTE_DB ?? '/tmp/naryx-local/solver-quotes.db',
  'NARYX_SOLVER_QUOTE_DB',
);
const apiOrigin = process.env.NARYX_API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:8787';
const signerPath = process.env.NARYX_SOLVER_ED25519_KEY_PATH;
if (signerPath === undefined || signerPath.length === 0) {
  throw new Error('NARYX_SOLVER_ED25519_KEY_PATH is required');
}

const environmentManifestPath = process.env.NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST;
const executionSigner = loadSigner(signerPath);
const manifestRuntime = environmentManifestPath === undefined
  ? undefined
  : await loadSolanaLocalEnvironmentRuntime(
    absolutePath(environmentManifestPath, 'NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST'),
    process.env.NARYX_SOLANA_LOCAL_SOLVER_ID ?? '',
  );
let validatorSlot = manifestRuntime?.initialSlot;
const runtime = createLocalAtomicMarketRuntime(
  manifestRuntime?.manifest.runtime.catalog ?? LOCAL_ATOMIC_MARKET_CATALOG_V1,
  undefined,
  manifestRuntime === undefined
    ? undefined
    : () => {
      if (validatorSlot === undefined) throw new Error('validator clock is unavailable');
      return validatorSlot;
    },
);
const clockRefresh = manifestRuntime === undefined
  ? undefined
  : setInterval(() => {
    void manifestRuntime.readSlot().then((slot) => { validatorSlot = slot; }).catch(() => { validatorSlot = undefined; });
  }, 250);
clockRefresh?.unref();
const orderProvider = new HttpInternalOrderProvider(apiOrigin);
const store = new SqliteInternalAtomicQuoteStore(quoteDbPath);
const coordinator = createInternalAtomicQuoteCoordinator({
  orders: orderProvider.get,
  candidates: runtime.providers.candidates,
  terms: runtime.providers.terms,
  signer: executionSigner,
  store,
});
const authorizationStore = manifestRuntime === undefined
  ? undefined
  : new SqliteSolanaExecutionAuthorizationStore(absolutePath(
    process.env.NARYX_SOLVER_SOLANA_AUTHORIZATION_DB ?? '/tmp/naryx-local/solver-solana-authorizations.db',
    'NARYX_SOLVER_SOLANA_AUTHORIZATION_DB',
  ));
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
const server = createInternalAtomicQuoteServer(coordinator, authorization);

function shutdown(): void {
  if (clockRefresh !== undefined) clearInterval(clockRefresh);
  server.close(() => {
    store.close();
    authorizationStore?.close();
    process.exitCode = 0;
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.listen(listenPort, host, () => {
  const mode = manifestRuntime === undefined ? 'PHASE4_FIXTURE' : 'MANIFEST_VALIDATED';
  process.stdout.write(`Internal solver listening on http://${host}:${listenPort} runtime=${mode}\n`);
});
