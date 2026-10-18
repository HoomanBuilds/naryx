import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { keccak256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { EvmCrossDomainSubmissionJournal, type CrossDomainSubmission, type CrossDomainSubmissionPort } from '../src/evm-cross-domain-submission-journal.js';

function fixture(t: test.TestContext, budget = 100_000n) {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-cross-domain-'));
  const account = privateKeyToAccount(generatePrivateKey());
  const sent: Hex[] = [];
  const receipts = new Map<Hex, 'SUCCESS' | 'REVERTED'>();
  let chainId = 84532;
  let nonce = 5;
  let loseAcknowledgement = false;
  let signed = 0;
  let signChainId = 84532;
  const port: CrossDomainSubmissionPort = {
    chainId: async () => chainId,
    pendingNonce: async () => nonce,
    sign: async request => {
      signed += 1;
      return account.signTransaction({ type: 'eip1559', chainId: signChainId, nonce: request.nonce,
        to: request.to, data: request.data, gas: request.gas, value: 0n,
        maxFeePerGas: request.maximumFeePerGasWei, maxPriorityFeePerGas: request.maximumFeePerGasWei });
    },
    broadcast: async raw => {
      sent.push(raw);
      nonce += 1;
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('lost acknowledgement'); }
      return keccak256(raw);
    },
    finalized: async hash => receipts.get(hash),
  };
  const config = { path: join(directory, 'journal.sqlite'), chainId: 84532, signer: account.address,
    maximumGasBudgetWei: budget, alreadySpentWei: 0n, port };
  let journal = new EvmCrossDomainSubmissionJournal(config);
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  const request: CrossDomainSubmission = { operationId: `${'a'.repeat(64)}:COMMIT`,
    to: account.address, data: '0x12345678', gas: 21_000n, maximumFeePerGasWei: 1n };
  return { request, port, config, receipts, sent, journal: () => journal, signed: () => signed,
    chain: (value: number) => { chainId = value; },
    signChain: (value: number) => { signChainId = value; },
    loseNextAcknowledgement: () => { loseAcknowledgement = true; },
    restart: () => { journal.close(); journal = new EvmCrossDomainSubmissionJournal(config); } };
}

test('restart after ambiguous broadcast resends identical bytes without another nonce or budget charge', async t => {
  const f = fixture(t, 21_000n);
  f.loseNextAcknowledgement();
  await assert.rejects(f.journal().submit(f.request), /lost acknowledgement/);
  f.restart();
  const hash = await f.journal().submit(f.request);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0], f.sent[1]);
  assert.equal(f.signed(), 1);
  f.receipts.set(hash, 'SUCCESS');
  assert.equal(await f.journal().submit(f.request), hash);
  assert.equal(f.sent.length, 2);
  await assert.rejects(f.journal().submit({ ...f.request, data: '0x12345679' }), /payload changed/);
  await assert.rejects(f.journal().submit({ ...f.request, operationId: `${'b'.repeat(64)}:COMMIT` }), /budget is exhausted/);
});

test('inventory phases share the same durable gas cap and cannot gain capacity on replay', async t => {
  const f = fixture(t, 63_000n);
  assert.equal(f.journal().remainingBudgetWei(), 63_000n);
  for (const [index, phase] of ['APPROVE_INVENTORY', 'RESERVE_INVENTORY', 'FINALIZE_INVENTORY'].entries()) {
    const request = { ...f.request, operationId: `${'a'.repeat(64)}:${phase}` };
    const hash = await f.journal().submit(request);
    f.receipts.set(hash, 'SUCCESS');
    f.restart();
    assert.equal(await f.journal().submit(request), hash);
    assert.equal(f.journal().remainingBudgetWei(), 63_000n - BigInt(index + 1) * 21_000n);
  }
  assert.equal(f.sent.length, 3);
  await assert.rejects(f.journal().submit(f.request), /budget is exhausted/);
});

test('read-only reconciliation preserves unknown submissions and never signs or resends', async t => {
  const f = fixture(t);
  assert.equal(await f.journal().observe(f.request.operationId), undefined);
  assert.equal(f.signed(), 0);
  const hash = await f.journal().submit(f.request);
  f.restart();
  assert.deepEqual(await f.journal().observe(f.request.operationId), { hash, status: 'PENDING' });
  f.receipts.set(hash, 'REVERTED');
  assert.deepEqual(await f.journal().observe(f.request.operationId), { hash, status: 'REVERTED' });
  f.restart();
  assert.deepEqual(await f.journal().observe(f.request.operationId), { hash, status: 'REVERTED' });
  assert.equal(f.sent.length, 1);
  assert.equal(f.signed(), 1);
  f.chain(1);
  await assert.rejects(f.journal().observe(f.request.operationId), /chain identity/);
});

test('concurrent and cross-process submissions cannot reuse a pending signer or its nonce', async t => {
  const f = fixture(t);
  const second = new EvmCrossDomainSubmissionJournal(f.config);
  try {
    const results = await Promise.allSettled([f.journal().submit(f.request),
      second.submit({ ...f.request, operationId: `${'b'.repeat(64)}:COMMIT` })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(String((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason), /unresolved transaction/);
    assert.equal(f.sent.length, 1);
    f.receipts.set(keccak256(f.sent[0]!), 'SUCCESS');
    await f.journal().submit({ ...f.request, operationId: `${'c'.repeat(64)}:COMPENSATE` });
    assert.equal(f.sent.length, 2);
    assert.notEqual(f.sent[0], f.sent[1]);
  } finally { second.close(); }
});

test('terminal reconciliation persists finalized refunds without another submission', async t => {
  const f = fixture(t);
  assert.equal(await f.journal().reconcilePending(), true);
  const request = { ...f.request, operationId: `${'a'.repeat(64)}:RELEASE` };
  const hash = await f.journal().submit(request);
  assert.equal(await f.journal().reconcilePending(), false);
  f.receipts.set(hash, 'SUCCESS');
  f.restart();
  assert.equal(await f.journal().reconcilePending(), true);
  assert.deepEqual(await f.journal().observe(request.operationId), { hash, status: 'SUCCESS' });
  assert.equal(f.sent.length, 1);
  assert.equal(f.signed(), 1);
  f.chain(1);
  await assert.rejects(f.journal().reconcilePending(), /chain identity/);
});

test('reverted operations remain immutable, retain gas accounting, and permit separate recovery', async t => {
  const f = fixture(t, 42_000n);
  const hash = await f.journal().submit(f.request);
  f.receipts.set(hash, 'REVERTED');
  await assert.rejects(f.journal().submit(f.request), /reverted/);
  await f.journal().submit({ ...f.request, operationId: `${'a'.repeat(64)}:COMPENSATE` });
  assert.equal(f.sent.length, 2);
  f.restart();
  await assert.rejects(f.journal().submit(f.request), /reverted/);
});

test('chain, signed payload, budget, and immutable journal identity fail closed', async t => {
  const f = fixture(t);
  f.chain(1);
  await assert.rejects(f.journal().submit(f.request), /RPC chain identity/);
  assert.equal(f.signed(), 0);
  f.chain(84532);
  await assert.rejects(f.journal().submit({ ...f.request, gas: 0n }), /gas bounds/);
  await assert.rejects(f.journal().submit({ ...f.request, maximumFeePerGasWei: 2n ** 256n }), /gas bounds/);
  f.signChain(1);
  await assert.rejects(f.journal().submit(f.request), /differs from the reservation/);
  assert.equal(f.sent.length, 0);
  f.restart();
  f.signChain(84532);
  await f.journal().submit(f.request);
  assert.equal(f.sent.length, 1);
  assert.throws(() => new EvmCrossDomainSubmissionJournal({ ...f.config, maximumGasBudgetWei: 99_999n }), /binding or approved budget changed/);
  assert.throws(() => new EvmCrossDomainSubmissionJournal({ ...f.config, chainId: 1 }), /test chains/);
  assert.throws(() => new EvmCrossDomainSubmissionJournal({ ...f.config, maximumGasBudgetWei: 10_000_000_000_000_001n }), /budget/);
});

test('expired inventory release is distinct from compensation and restart-safe', async t => {
  const f = fixture(t, 63_000n);
  const commit = await f.journal().submit(f.request);
  f.receipts.set(commit, 'SUCCESS');
  const compensate = await f.journal().submit({ ...f.request, operationId: `${'a'.repeat(64)}:COMPENSATE` });
  f.receipts.set(compensate, 'SUCCESS');
  const release = { ...f.request, operationId: `${'a'.repeat(64)}:RELEASE`, data: '0xabcdef12' as Hex };
  const hash = await f.journal().submit(release);
  f.receipts.set(hash, 'SUCCESS');
  f.restart();
  assert.equal(await f.journal().submit(release), hash);
  assert.equal(f.sent.length, 3);
  assert.equal(f.signed(), 3);
  await assert.rejects(f.journal().submit({ ...release, data: '0xabcdef13' }), /payload changed/);
  await assert.rejects(f.journal().submit({ ...release, operationId: `${'a'.repeat(64)}:UNKNOWN` }), /operation identity/);
});
