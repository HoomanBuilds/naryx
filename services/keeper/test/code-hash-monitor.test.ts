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

const verifier: CodeWatchTarget = {
  targetId: 'package-verifier',
  scopeId: scope.scopeId,
  chain: 'EVM',
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
  async readCodeHash() {
    if (hash instanceof Error) throw hash;
    return hash;
  },
});

test('matching code leaves a scope active, and drift or missing code quarantines it with committed evidence', async () => {
  const same = await observeCode([verifier], { EVM: reader(verifier.expectedCodeHash) }, nowMs);
  assert.equal(same[0]?.status, 'MATCH');
  assert.equal(codeDriftTransition(journal(), same, readyDecision, nowMs, 60_000n).state, 'ACTIVE');

  const drift = await observeCode([verifier], { EVM: reader(`0x${'ef'.repeat(32)}`) }, nowMs);
  assert.equal(drift[0]?.status, 'DRIFT');
  const quarantined = codeDriftTransition(journal(), drift, readyDecision, nowMs, 60_000n);
  assert.equal(quarantined.state, 'QUARANTINED');
  assert.equal(quarantined.entryAllowed, false);
  assert.equal(quarantined.exitAllowed, false);
  assert.equal(quarantined.receipts.at(-1)?.trigger, 'CODE_DRIFT');
  // A second pass over an already quarantined scope changes nothing.
  assert.equal(codeDriftTransition(quarantined, drift, readyDecision, nowMs + 1n, 60_000n), quarantined);

  const missing = await observeCode([verifier], { EVM: reader(null) }, nowMs);
  assert.equal(missing[0]?.status, 'MISSING');
  assert.equal(codeDriftTransition(journal(), missing, readyDecision, nowMs, 60_000n).state, 'QUARANTINED');
});

test('an unreadable target is reported but never counted as matching or drifting', async () => {
  const failed = await observeCode([verifier], { EVM: reader(new Error('rpc down')) }, nowMs);
  assert.equal(failed[0]?.status, 'UNREADABLE');
  assert.equal(failed[0]?.detail, 'rpc down');
  assert.equal(codeDriftTransition(journal(), failed, readyDecision, nowMs, 60_000n).state, 'ACTIVE');
  const noReader = await observeCode([{ ...verifier, chain: 'SVM', address: '11111111111111111111111111111111' }], {}, nowMs);
  assert.equal(noReader[0]?.status, 'UNREADABLE');
  // Drift in another scope does not touch this one.
  const elsewhere = await observeCode([{ ...verifier, scopeId: 'other-scope' }], { EVM: reader(`0x${'ef'.repeat(32)}`) }, nowMs);
  assert.equal(codeDriftTransition(journal(), elsewhere, readyDecision, nowMs, 60_000n).state, 'ACTIVE');
});

test('the EVM reader hashes eth_getCode with keccak-256 and ProgramData hashes skip metadata and padding', async () => {
  const code = '0x6080604052';
  const requests: string[] = [];
  const fetchStub = async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body).method);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: code }) };
  };
  const evm = new EvmJsonRpcCodeReader('http://127.0.0.1:8545', fetchStub as never);
  assert.equal(await evm.readCodeHash(verifier), `0x${toHex(keccak_256(Buffer.from('6080604052', 'hex')))}`);
  assert.deepEqual(requests, ['eth_getCode']);

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
      readers: { EVM: reader(`0x${'ef'.repeat(32)}`) },
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

test('the monitor stays off unless configured, and refuses targets it has no RPC to read', () => {
  assert.equal(loadCodeHashMonitorConfig({}, () => '', JSON.parse), undefined);
  const file = { intervalMs: 60_000, evidenceTtlMs: 600_000n, targets: [verifier], journals: [{ journalPath: '/var/lib/naryx/base.json', readinessDecision: readyDecision }] };
  const env = { NARYX_CODE_WATCHLIST: '/etc/naryx/watchlist.json' };
  assert.throws(() => loadCodeHashMonitorConfig(env, () => '', () => file), /NARYX_EVM_RPC_URL/);
  const config = loadCodeHashMonitorConfig({ ...env, NARYX_EVM_RPC_URL: 'http://127.0.0.1:8545' }, () => '', () => file);
  assert.equal(config?.targets.length, 1);
  assert.throws(() => loadCodeHashMonitorConfig(env, () => '', () => ({ ...file, intervalMs: 100 })), /at least 5000/);
  assert.throws(() => loadCodeHashMonitorConfig({ ...env, NARYX_EVM_RPC_URL: 'http://x' }, () => '', () => ({ ...file, journals: [{ journalPath: 'relative.json', readinessDecision: readyDecision }] })), /absolute/);
});
