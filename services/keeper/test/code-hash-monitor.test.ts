import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { domainRef, manifestHash, protocolId, toHex, versionedManifestRef, type ReadinessDecision } from '@naryx/protocol-types';
import {
  DependencyIncidentFileStore,
  EvmJsonRpcCodeReader,
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_BETA_GENESIS_HASH,
  SolanaRpcProgramDataReader,
  codeDriftTransition,
  createDependencyIncidentJournal,
  dependencyScopeHash,
  observeCode,
  loadCodeHashMonitorConfig,
  programDataCodeHash,
  runCodeHashPass,
  type CodeReader,
  type CodeWatchTarget,
  type DependencyScopeInput,
} from '../src/index.js';

const nowMs = 2_000_000n;
const scope: DependencyScopeInput = {
  scopeId: 'base-sepolia-cash-carry-small',
  domain: domainRef('eip155:84532', 1, '11'.repeat(32)),
  template: versionedManifestRef('cash-carry-v1', 1, '12'.repeat(32)),
  settlementClass: 'ATOMIC_POSTCONDITION',
  quoteMode: 'EXECUTION_COMMITMENT',
  sizeCohort: 'small',
};
const readyDecision = {
  schemaVersion: 1,
  decisionVersion: 3,
  environment: protocolId('testnet'),
  releaseHash: manifestHash('24'.repeat(32)),
  evaluatedAt: { unit: 'HYPERLIQUID_UNIX_MILLISECONDS', value: nowMs },
  authorityInventoryHash: manifestHash('20'.repeat(32)),
  capPolicyHash: manifestHash('21'.repeat(32)),
  fundedOperationHashes: [manifestHash('22'.repeat(32))],
  findingSummaryHash: manifestHash('23'.repeat(32)),
  evidence: [],
  status: 'READY',
} as ReadinessDecision;

const BASE_SEPOLIA = 'eip155:84532';
const ARBITRUM_SEPOLIA = 'eip155:421614';
const verifier: CodeWatchTarget = {
  targetId: 'package-verifier',
  scopeId: scope.scopeId,
  chainRef: BASE_SEPOLIA,
  address: `0x${'ab'.repeat(20)}`,
  expectedCodeHash: `0x${'cd'.repeat(32)}`,
};

function journal() {
  return createDependencyIncidentJournal(
    scope,
    {
      scopeHash: dependencyScopeHash(scope),
      readinessDecision: readyDecision,
      readinessDecisionCommitment: '31'.repeat(32),
      evidenceCommitment: '32'.repeat(32),
      observedAtMs: nowMs - 10n,
      validUntilMs: nowMs + 10_000n,
      exitSafe: true,
    },
    nowMs - 5n,
  );
}

const reader = (hash: `0x${string}` | null | Error): CodeReader => ({
  async verifyChainIdentity() {},
  async readCodeHash() {
    if (hash instanceof Error) throw hash;
    return hash;
  },
});

test('matching code leaves a scope active, and drift or missing code quarantines it with committed evidence', async () => {
  const same = await observeCode([verifier], { [BASE_SEPOLIA]: reader(verifier.expectedCodeHash) }, nowMs);
  assert.equal(same[0]?.status, 'MATCH');
  assert.equal(codeDriftTransition(journal(), same, readyDecision, nowMs, 60_000n).state, 'ACTIVE');

  const drift = await observeCode([verifier], { [BASE_SEPOLIA]: reader(`0x${'ef'.repeat(32)}`) }, nowMs);
  assert.equal(drift[0]?.status, 'DRIFT');
  const quarantined = codeDriftTransition(journal(), drift, readyDecision, nowMs, 60_000n);
  assert.equal(quarantined.state, 'QUARANTINED');
  assert.equal(quarantined.entryAllowed, false);
  assert.equal(quarantined.exitAllowed, false);
  assert.equal(quarantined.receipts.at(-1)?.trigger, 'CODE_DRIFT');
  // A second pass over an already quarantined scope changes nothing.
  assert.equal(codeDriftTransition(quarantined, drift, readyDecision, nowMs + 1n, 60_000n), quarantined);

  const missing = await observeCode([verifier], { [BASE_SEPOLIA]: reader(null) }, nowMs);
  assert.equal(missing[0]?.status, 'MISSING');
  assert.equal(codeDriftTransition(journal(), missing, readyDecision, nowMs, 60_000n).state, 'QUARANTINED');
});

test('an unreadable target is reported but never counted as matching or drifting', async () => {
  const failed = await observeCode([verifier], { [BASE_SEPOLIA]: reader(new Error('rpc down')) }, nowMs);
  assert.equal(failed[0]?.status, 'UNREADABLE');
  assert.equal(failed[0]?.detail, 'rpc down');
  assert.equal(codeDriftTransition(journal(), failed, readyDecision, nowMs, 60_000n).state, 'ACTIVE');
  const noReader = await observeCode([{ ...verifier, chainRef: 'solana:devnet', address: '11111111111111111111111111111111' }], {}, nowMs);
  assert.equal(noReader[0]?.status, 'UNREADABLE');
  // Drift in another scope does not touch this one.
  const elsewhere = await observeCode([{ ...verifier, scopeId: 'other-scope' }], { [BASE_SEPOLIA]: reader(`0x${'ef'.repeat(32)}`) }, nowMs);
  assert.equal(codeDriftTransition(journal(), elsewhere, readyDecision, nowMs, 60_000n).state, 'ACTIVE');
});

test('the EVM reader hashes eth_getCode with keccak-256 and ProgramData hashes skip metadata and padding', async () => {
  const code = '0x6080604052';
  const requests: string[] = [];
  const fetchStub = async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body).method);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: code }) };
  };
  const evm = new EvmJsonRpcCodeReader(BASE_SEPOLIA, 'http://127.0.0.1:8545', fetchStub as never);
  assert.equal(await evm.readCodeHash(verifier), `0x${toHex(keccak_256(Buffer.from('6080604052', 'hex')))}`);
  assert.deepEqual(requests, ['eth_getCode']);
  await assert.rejects(evm.readCodeHash({ ...verifier, chainRef: ARBITRUM_SEPOLIA }), /another chain/);

  const executable = Buffer.from('7f454c46deadbeef', 'hex');
  const data = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.alloc(41), executable, Buffer.alloc(16)]);
  assert.equal(programDataCodeHash(data), `0x${createHash('sha256').update(executable).digest('hex')}`);
  assert.equal(programDataCodeHash(Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.alloc(41)])), null);
  assert.throws(() => programDataCodeHash(Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.alloc(60, 1)])), /not upgradeable-loader ProgramData/);
});

test('a monitoring pass persists the quarantine to the scope journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'naryx-code-monitor-'));
  try {
    const store = new DependencyIncidentFileStore(join(dir, 'journal.json'));
    await store.save(journal());
    const observations = await runCodeHashPass({
      targets: [verifier],
      readers: { [BASE_SEPOLIA]: reader(`0x${'ef'.repeat(32)}`) },
      journals: [{ store, readinessDecision: readyDecision }],
      nowMs,
      evidenceTtlMs: 60_000n,
    });
    assert.equal(observations[0]?.status, 'DRIFT');
    assert.equal((await store.load()).state, 'QUARANTINED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the monitor stays off unless configured, and needs a per-chain RPC URL for every target chain', () => {
  assert.equal(loadCodeHashMonitorConfig({}, () => '', JSON.parse), undefined);
  const arbitrumVerifier = { ...verifier, targetId: 'arbitrum-coordinator', chainRef: ARBITRUM_SEPOLIA };
  const file = { intervalMs: 60_000, evidenceTtlMs: 600_000n, targets: [verifier, arbitrumVerifier], journals: [{ journalPath: '/var/lib/naryx/base.json', readinessDecision: readyDecision }] };
  const env = { NARYX_CODE_WATCHLIST: '/etc/naryx/watchlist.json' };
  const urls = (map: Record<string, string>) => ({ ...env, NARYX_KEEPER_RPC_URLS: JSON.stringify(map) });
  // The old single EVM URL is not read; Base Sepolia and Arbitrum Sepolia each need their own.
  assert.throws(() => loadCodeHashMonitorConfig({ ...env, NARYX_EVM_RPC_URL: 'https://rpc.example' }, () => '', () => file), /eip155:84532 need its RPC URL in NARYX_KEEPER_RPC_URLS/);
  assert.throws(() => loadCodeHashMonitorConfig(urls({ [BASE_SEPOLIA]: 'https://base.example' }), () => '', () => file), /eip155:421614/);
  const config = loadCodeHashMonitorConfig(urls({ [BASE_SEPOLIA]: 'https://base.example/v2/key', [ARBITRUM_SEPOLIA]: 'https://arb.example/v2/key', 'solana:devnet': 'https://sol.example' }), () => '', () => file);
  assert.deepEqual([...(config?.rpcUrls ?? [])], [[BASE_SEPOLIA, 'https://base.example/v2/key'], [ARBITRUM_SEPOLIA, 'https://arb.example/v2/key']]);
  assert.throws(() => loadCodeHashMonitorConfig(urls({ [BASE_SEPOLIA]: 'http://rpc.example', [ARBITRUM_SEPOLIA]: 'https://arb.example' }), () => '', () => file), /https, or http to a loopback host/);
  assert.throws(() => loadCodeHashMonitorConfig(urls({ 'base-sepolia': 'https://base.example' }), () => '', () => file), /not eip155/);
  // A malformed map never echoes its contents, which may hold provider keys.
  assert.throws(() => loadCodeHashMonitorConfig({ ...env, NARYX_KEEPER_RPC_URLS: '{"eip155:84532":"https://x/secret-key"' }, () => '', () => file), (error: Error) => !error.message.includes('secret-key'));
  assert.throws(() => loadCodeHashMonitorConfig(env, () => '', () => ({ ...file, targets: [{ ...verifier, chainRef: undefined }] })), /chain reference/);
  assert.throws(() => loadCodeHashMonitorConfig(env, () => '', () => ({ ...file, intervalMs: 100 })), /at least 5000/);
  assert.throws(() => loadCodeHashMonitorConfig(env, () => '', () => ({ ...file, journals: [{ journalPath: 'relative.json', readinessDecision: readyDecision }] })), /absolute/);
});

/** A JSON-RPC endpoint stub that answers chain identity and code reads and records every method. */
function endpoint(answers: Record<string, unknown>) {
  const methods: string[] = [];
  const fetchStub = async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body) as { method: string };
    methods.push(method);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: answers[method] }) };
  };
  return { methods, fetch: fetchStub as never };
}

test('Base Sepolia and Arbitrum Sepolia are watched together, each endpoint proving its chain id before any code read', async () => {
  const code = '0x6080604052';
  const base = endpoint({ eth_chainId: '0x14a34', eth_getCode: code });
  const arbitrum = endpoint({ eth_chainId: '0x66eee', eth_getCode: code });
  const expected = `0x${toHex(keccak_256(Buffer.from('6080604052', 'hex')))}` as const;
  const targets = [
    { ...verifier, expectedCodeHash: expected },
    { ...verifier, targetId: 'base-shard', address: `0x${'ac'.repeat(20)}`, expectedCodeHash: expected },
    { ...verifier, targetId: 'arbitrum-coordinator', chainRef: ARBITRUM_SEPOLIA, expectedCodeHash: expected },
  ];
  const readers = { [BASE_SEPOLIA]: new EvmJsonRpcCodeReader(BASE_SEPOLIA, 'https://base.example', base.fetch), [ARBITRUM_SEPOLIA]: new EvmJsonRpcCodeReader(ARBITRUM_SEPOLIA, 'https://arb.example', arbitrum.fetch) };
  const observed = await observeCode(targets, readers, nowMs);
  assert.deepEqual(observed.map((entry) => [entry.targetId, entry.chainRef, entry.status]), [
    ['package-verifier', BASE_SEPOLIA, 'MATCH'],
    ['base-shard', BASE_SEPOLIA, 'MATCH'],
    ['arbitrum-coordinator', ARBITRUM_SEPOLIA, 'MATCH'],
  ]);
  // Identity is proven once per chain per pass, and always before that chain's first code read.
  assert.deepEqual(base.methods, ['eth_chainId', 'eth_getCode', 'eth_getCode']);
  assert.deepEqual(arbitrum.methods, ['eth_chainId', 'eth_getCode']);
});

test('an endpoint serving another chain is RPC_IDENTITY_MISMATCH, reads no code, and never quarantines the scope', async () => {
  // The Base Sepolia URL actually points at Arbitrum Sepolia, which has no code at the address.
  const misrouted = endpoint({ eth_chainId: '0x66eee', eth_getCode: '0x' });
  const observed = await observeCode([verifier], { [BASE_SEPOLIA]: new EvmJsonRpcCodeReader(BASE_SEPOLIA, 'https://base.example', misrouted.fetch) }, nowMs);
  assert.equal(observed[0]?.status, 'RPC_IDENTITY_MISMATCH');
  assert.match(observed[0]?.detail ?? '', /configured for eip155:84532 serves eip155:421614/);
  assert.deepEqual(misrouted.methods, ['eth_chainId']);
  assert.equal(codeDriftTransition(journal(), observed, readyDecision, nowMs, 60_000n).state, 'ACTIVE');

  // A malformed identity answer is UNREADABLE, never a match and never a mismatch.
  const garbled = endpoint({ eth_chainId: 84532 });
  const unreadable = await observeCode([verifier], { [BASE_SEPOLIA]: new EvmJsonRpcCodeReader(BASE_SEPOLIA, 'https://base.example', garbled.fetch) }, nowMs);
  assert.equal(unreadable[0]?.status, 'UNREADABLE');

  // Solana Devnet is proven by its genesis hash; a mainnet-beta endpoint is refused before getAccountInfo.
  const program = { ...verifier, targetId: 'naryx-core', chainRef: 'solana:devnet', address: '11111111111111111111111111111111' };
  const mainnet = endpoint({ getGenesisHash: SOLANA_MAINNET_BETA_GENESIS_HASH, getAccountInfo: { value: null } });
  const wrongCluster = await observeCode([program], { 'solana:devnet': new SolanaRpcProgramDataReader('solana:devnet', 'https://sol.example', mainnet.fetch) }, nowMs);
  assert.equal(wrongCluster[0]?.status, 'RPC_IDENTITY_MISMATCH');
  assert.deepEqual(mainnet.methods, ['getGenesisHash']);
  const devnet = endpoint({ getGenesisHash: SOLANA_DEVNET_GENESIS_HASH, getAccountInfo: { value: null } });
  const missing = await observeCode([program], { 'solana:devnet': new SolanaRpcProgramDataReader('solana:devnet', 'https://sol.example', devnet.fetch) }, nowMs);
  assert.equal(missing[0]?.status, 'MISSING');
  assert.deepEqual(devnet.methods, ['getGenesisHash', 'getAccountInfo']);
  assert.throws(() => new SolanaRpcProgramDataReader(BASE_SEPOLIA, 'https://sol.example'), /not an SVM chain/);
});
