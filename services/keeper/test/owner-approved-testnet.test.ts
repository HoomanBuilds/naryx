import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { Connection, PublicKey } from '@solana/web3.js';
import { domainRef, versionedManifestRef } from '@naryx/protocol-types';
import { SOLANA_DEVNET_GENESIS_HASH } from '../src/chain-identity.js';
import { type DependencyIncidentJournal } from '../src/dependency-incident-engine.js';
import { loadCodeHashMonitorConfig, programDataCodeHash } from '../src/code-hash-monitor.js';
import {
  observeOwnerTestnetRelease, ownerTestnetApprovalMessage, refreshOwnerTestnetJournal,
  validateOwnerTestnetApproval, type OwnerApprovedTestnetRelease,
} from '../src/owner-approved-testnet.js';

const keys = generateKeyPairSync('ed25519');
const approver = new PublicKey(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toBase58();
const programId = new PublicKey(Buffer.alloc(32, 1)).toBase58();
const programData = new PublicKey(Buffer.alloc(32, 2)).toBase58();
const caps = JSON.stringify({ version: 1, domains: [{ domainId: 'svm:devnet',
  maxPrincipalAtomsPerOperation: '5000000000', maxRecoveryLossAtomsPerOperation: '100000000' }] });
const code = Buffer.from('7f454c46010203', 'hex');
const release: OwnerApprovedTestnetRelease = {
  version: 1, policy: 'OWNER_APPROVED_TESTNET', environment: 'devnet', independentlyReviewed: false,
  decisionVersion: 1, genesisHash: SOLANA_DEVNET_GENESIS_HASH,
  scope: { scopeId: 'testnet-test-scope', domain: domainRef('svm:devnet', 6, '11'.repeat(32)),
    template: versionedManifestRef('cash-and-carry-v1', 1, '22'.repeat(32)),
    settlementClass: 'ATOMIC_POSTCONDITION', quoteMode: 'EXECUTION_COMMITMENT', sizeCohort: 'bounded-testnet' },
  releaseHash: `0x${'33'.repeat(32)}`, capPolicySha256: createHash('sha256').update(caps).digest('hex'),
  approvedAtMs: 1000n, expiresAtMs: 601000n, approver,
  programs: [{ programId, programData, upgradeAuthority: approver, deploymentSlot: 10n,
    codeHash: `0x${createHash('sha256').update(code).digest('hex')}` }],
  reconciledExit: { programId, entrySignature: '1'.repeat(88), entrySlot: 11n,
    exitSignature: '2'.repeat(88), exitSlot: 12n },
};
const signed = (r = release) => ({ release: r, signature: sign(null, ownerTestnetApprovalMessage(r), keys.privateKey).toString('hex') });

test('owner approval is bound to devnet, its exact scope, cap file and signature', () => {
  const decision = validateOwnerTestnetApproval(signed(), approver, caps);
  assert.equal(decision.status, 'READY');
  assert.equal(decision.independentlyReviewed, false);
  assert.equal(decision.qualificationPolicy, 'OWNER_APPROVED_TESTNET');
  assert.throws(() => validateOwnerTestnetApproval({ ...signed(), release: { ...release, decisionVersion: 2 } }, approver, caps), /signature/);
  assert.throws(() => validateOwnerTestnetApproval(signed(), programId, caps), /untrusted/);
  assert.throws(() => validateOwnerTestnetApproval(signed(), approver, caps + ' '), /cap policy changed/);
  assert.throws(() => validateOwnerTestnetApproval(signed({ ...release,
    scope: { ...release.scope, domain: domainRef('svm:mainnet', 6, '11'.repeat(32)) } }), approver, caps), /devnet/);
  assert.throws(() => validateOwnerTestnetApproval(signed({ ...release, expiresAtMs: 604801001n }), approver, caps), /seven days/);
  assert.throws(() => validateOwnerTestnetApproval(signed({ ...release, programs: [...release.programs, ...release.programs] }), approver, caps), /repeated/);
  assert.throws(() => validateOwnerTestnetApproval(signed({ ...release, reconciledExit: { ...release.reconciledExit, entrySlot: 10n } }), approver, caps), /funded exit/);
});

test('refresh creates labelled evidence, fences failed observations and never silently restores a quarantine', async () => {
  let current: DependencyIncidentJournal | undefined;
  const store = {
    async load() { if (!current) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return current; },
    async save(value: DependencyIncidentJournal) { current = value; },
  };
  const input = { approval: signed(), trustedApprover: approver, capPolicyText: caps, store, nowMs: 2000n, observe: async () => {} };
  await refreshOwnerTestnetJournal(input);
  assert.equal(current?.state, 'ACTIVE');
  assert.equal(current?.latestEvidence.qualificationPolicy, 'OWNER_APPROVED_TESTNET');
  assert.equal(current?.latestEvidence.validUntilMs, 302000n);
  await assert.rejects(refreshOwnerTestnetJournal({ ...input, nowMs: 3000n, observe: async () => { throw new Error('changed authority'); } }), /quarantined/);
  assert.equal(current?.state, 'QUARANTINED');
  assert.equal(current?.entryAllowed, false);
  assert.equal(current?.exitAllowed, false);
  const fenced = current;
  await refreshOwnerTestnetJournal({ ...input, nowMs: 4000n });
  assert.equal(current, fenced);
  current = undefined;
  await assert.rejects(refreshOwnerTestnetJournal({ ...input, nowMs: release.expiresAtMs }), /unavailable or quarantined/);
  assert.equal(current, undefined);
});

test('observation checks finalized code, authority and funded invocation, without accepting another network', async () => {
  const program = Buffer.alloc(36);
  program.writeUInt32LE(2); new PublicKey(programData).toBuffer().copy(program, 4);
  const data = Buffer.alloc(45 + code.length);
  data.writeUInt32LE(3); data.writeBigUInt64LE(10n, 4); data[12] = 1;
  new PublicKey(approver).toBuffer().copy(data, 13); code.copy(data, 45);
  const owner = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  let genesis = SOLANA_DEVNET_GENESIS_HASH;
  let txError: unknown = null;
  const rpc = {
    async getGenesisHash() { return genesis; },
    async getMultipleAccountsInfoAndContext(_keys: unknown, options: { commitment: string }) {
      assert.equal(options.commitment, 'finalized');
      return { value: [{ executable: true, owner, data: program }, { owner, data }] };
    },
    async getTransaction(signature: string, options: { commitment: string }) {
      assert.equal(options.commitment, 'finalized');
      return { meta: { err: txError }, slot: signature === release.reconciledExit.entrySignature ? 11 : 12,
        transaction: { message: { getAccountKeys: () => ({ get: () => new PublicKey(programId) }), compiledInstructions: [{ programIdIndex: 0 }] } } };
    },
  } as unknown as Connection;
  await observeOwnerTestnetRelease(release, rpc, programDataCodeHash);
  data[13] = data[13]! ^ 1;
  await assert.rejects(observeOwnerTestnetRelease(release, rpc, programDataCodeHash), /authority changed/);
  data[13] = data[13]! ^ 1;
  txError = { instructionError: 1 };
  await assert.rejects(observeOwnerTestnetRelease(release, rpc, programDataCodeHash), /not finalized/);
  genesis = 'mainnet';
  await assert.rejects(observeOwnerTestnetRelease(release, rpc, programDataCodeHash), /not Solana devnet/);
});

test('configuration requires explicit owner policy, pinned approver and the complete approved watchlist', () => {
  const watch = { intervalMs: 60000, evidenceTtlMs: 300000n,
    targets: [{ targetId: 'core', scopeId: release.scope.scopeId, chainRef: 'solana:devnet', address: programData, expectedCodeHash: release.programs[0]!.codeHash }],
    journals: [{ journalPath: '/private/test.json', ownerApproval: signed() }] };
  const env = { NARYX_CODE_WATCHLIST: '/private/watch.json', NARYX_OWNER_TESTNET_APPROVER: approver,
    NARYX_OWNER_TESTNET_CAP_POLICY: '/private/caps.json', NARYX_KEEPER_RPC_URLS: '{"solana:devnet":"https://rpc.example"}' };
  const read = (path: string) => path.endsWith('caps.json') ? caps : 'watch';
  assert.equal(loadCodeHashMonitorConfig(env, read, () => watch)?.journals[0]?.ownerApproval?.trustedApprover, approver);
  assert.throws(() => loadCodeHashMonitorConfig({ ...env, NARYX_OWNER_TESTNET_APPROVER: undefined }, read, () => watch), /pinned approver/);
  assert.throws(() => loadCodeHashMonitorConfig(env, read, () => ({ ...watch, targets: [{ ...watch.targets[0], address: programId }] })), /exact owner-approved/);
  assert.throws(() => loadCodeHashMonitorConfig(env, read, () => ({ ...watch, journals: [{ ...watch.journals[0], readinessDecision: {} }] })), /cannot be combined/);
});
