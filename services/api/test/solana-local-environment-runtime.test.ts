import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSolanaLocalEnvironmentManifestJson,
  parseSolanaLocalEnvironmentManifest,
  validateSolanaLocalRpcSnapshot,
  type SolanaLocalManifestFacts,
} from '@naryx/adapter-core';
import { createLocalAtomicOrderRuntime } from '../src/local-atomic-order-context.js';
import { loadSolanaLocalEnvironmentRuntime } from '../src/solana-local-environment-runtime.js';

const CORE = '8qmA9VuQwAAqQ3F93CAfLNFB3P8M8ygXgvn9xCnZXa2i';
const VENUE = 'ERGvPwyenaZDcAr9cyni7paeXPQ72NKC75ozz1fjCY7y';
const IDENTITY = '11111111111111111111111111111111';

function facts(): SolanaLocalManifestFacts {
  return {
    rpcUrl: 'http://127.0.0.1:8899',
    genesisHash: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
    manifestSlot: 100,
    maximumManifestAgeSlots: 20,
    programs: {
      core: { id: CORE, programDataId: IDENTITY, sha256: '11'.repeat(32) },
      conformanceVenue: { id: VENUE, programDataId: IDENTITY, sha256: '22'.repeat(32) },
    },
    identities: {
      payer: IDENTITY,
      governanceProposer: IDENTITY,
      governanceCanceller: IDENTITY,
      governanceExecutor: IDENTITY,
      governancePauser: IDENTITY,
      venueAdmin: IDENTITY,
      trader: IDENTITY,
      solver: IDENTITY,
      maker: IDENTITY,
      recovery: IDENTITY,
    },
    assets: {
      base: { label: 'BASE', mint: IDENTITY, decimals: 6 },
      quote: { label: 'QUOTE', mint: IDENTITY, decimals: 6 },
    },
    accounts: {
      config: IDENTITY,
      solverRegistry: IDENTITY,
      market: IDENTITY,
      spotBaseVault: IDENTITY,
      spotQuoteVault: IDENTITY,
      perpQuoteVault: IDENTITY,
      position: IDENTITY,
      'trader-base': IDENTITY,
      'trader-quote': IDENTITY,
      'maker-base': IDENTITY,
      'maker-quote': IDENTITY,
      'recovery-base': IDENTITY,
      'recovery-quote': IDENTITY,
    },
    governance: { configDelaySlots: 8, solverActivationSlot: 90, entryActivationSlot: 91, activatedAtSlot: 99 },
    economics: { priceQuoteAtoms: '2', priceBaseAtoms: '1', spotFeeBps: '25', initialMarginBps: '2000', maxSpotBaseAtoms: '10000000', maxPerpBaseAtoms: '10000000' },
    balances: { traderBase: '5000000' },
    limitations: ['Local conformance only.'],
  };
}

test('strict environment parsing derives immutable protocol identities from infrastructure', async () => {
  const raw = createSolanaLocalEnvironmentManifestJson(facts());
  const manifest = parseSolanaLocalEnvironmentManifest(JSON.parse(JSON.stringify(raw)));
  assert.equal(manifest.runtime.catalog.domain.domainId, 'svm:local');
  assert.equal(manifest.runtime.catalog.solver.solverId, IDENTITY);
  assert.equal(manifest.runtime.catalog.programs.core, CORE);

  const runtime = createLocalAtomicOrderRuntime(manifest.runtime.catalog, () => 105n, async () => 106n);
  const context = runtime.contexts(manifest.runtime.catalog.contextId);
  assert.equal(context?.capturedAtClock, 105n);
  assert.equal(await runtime.clock.currentClock(context!), 106n);
});

test('strict environment parsing and RPC validation reject altered trust inputs', () => {
  const raw = createSolanaLocalEnvironmentManifestJson(facts());
  const altered = structuredClone(raw) as Record<string, unknown>;
  (altered.programs as { core: { sha256: string } }).core.sha256 = '33'.repeat(32);
  assert.throws(() => parseSolanaLocalEnvironmentManifest(altered), /canonical identities/);

  const manifest = parseSolanaLocalEnvironmentManifest(raw);
  const snapshot = {
    genesisHash: manifest.rpc.genesisHash,
    slot: 110,
    programs: manifest.programs,
  };
  assert.equal(validateSolanaLocalRpcSnapshot(manifest, snapshot, IDENTITY), 110n);
  assert.throws(() => validateSolanaLocalRpcSnapshot(manifest, { ...snapshot, genesisHash: IDENTITY }, IDENTITY), /genesis/);
  assert.throws(() => validateSolanaLocalRpcSnapshot(manifest, { ...snapshot, slot: 121 }, IDENTITY), /stale/);
  assert.throws(() => validateSolanaLocalRpcSnapshot(manifest, snapshot, CORE), /solver identity/);
});

test('strict environment parsing rejects non-loopback RPC and missing fields', () => {
  const remote = createSolanaLocalEnvironmentManifestJson(facts()) as { rpc: { url: string } };
  remote.rpc.url = 'http://rpc.example.com:8899';
  assert.throws(() => parseSolanaLocalEnvironmentManifest(remote), /loopback/);

  const missing = createSolanaLocalEnvironmentManifestJson(facts()) as { accounts: Record<string, string> };
  delete missing.accounts.market;
  assert.throws(() => parseSolanaLocalEnvironmentManifest(missing), /missing fields/);
});

test('manifest mode requires an explicit absolute external path', async () => {
  await assert.rejects(
    loadSolanaLocalEnvironmentRuntime('environment-manifest.json', IDENTITY),
    /must be absolute/,
  );
});
