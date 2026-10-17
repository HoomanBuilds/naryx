import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, domainRef } from '@naryx/protocol-types';
import { HyperliquidPooledCollateralStore } from '../src/hyperliquid-pooled-collateral-store.js';
import { HyperliquidPoolWithdrawalService } from '../src/hyperliquid-pool-withdrawal.js';
import type { HyperliquidPoolFundingReadPort } from '../src/hyperliquid-pool-funding.js';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const owner = `0x${'11'.repeat(20)}` as const;
const pool = `0x${'22'.repeat(20)}` as const;

function fixture() {
  const store = new HyperliquidPooledCollateralStore(':memory:', { version: 1, environment: 'TESTNET',
    domain: domainRef('hypercore:testnet', 1, hash(1)), poolAccount: pool, policyHash: hash(2), maximumTotalQuoteAtoms: 100n,
    quoteAsset: assetRef('pool-usdc', hash(3), 6), collateralTokenId: `0x${'11'.repeat(16)}`, dedicatedTestOwners: [owner] });
  store.enroll(owner, hash(4));
  store.creditDeposit({ id: 'deposit', owner, receivedQuoteAtoms: 100n, transferHash: hash(5) }, 100n);
  store.prepareWithdrawal({ id: 'withdraw', owner, debitQuoteAtoms: 100n, authorizationHash: hash(6),
    verifiedFlatEquityQuoteAtoms: 100n, preparedAtMs: 1_000, expiresAtMs: 2_000 });
  const reads: HyperliquidPoolFundingReadPort = {
    async flat() { return { environment: 'TESTNET', account: pool, equityQuoteAtoms: 100n,
      withdrawableQuoteAtoms: 100n, requestedAtMs: 1_001, observedAtMs: 1_001 }; },
    async transfer() { throw new Error('unexpected transfer read'); },
  };
  return { store, reads };
}

test('withdrawal is journaled before send, concurrent dispatch cannot duplicate it and acknowledgement is not settlement', async () => {
  const f = fixture();
  try {
    let sends = 0;
    const transport = { async send(action: { source: string; destination: string; debitQuoteAtoms: bigint; nonce: number }) {
      sends++;
      assert.equal(f.store.withdrawalSubmission('withdraw')?.state, 'SUBMITTED_UNKNOWN');
      assert.equal(action.source, pool); assert.equal(action.destination, owner); assert.equal(action.debitQuoteAtoms, 100n);
    } };
    const first = new HyperliquidPoolWithdrawalService(f.store, f.reads, transport, () => 1_010);
    const second = new HyperliquidPoolWithdrawalService(f.store, f.reads, transport, () => 1_011);
    const outcomes = await Promise.all([first.submit('withdraw'), second.submit('withdraw')]);
    assert.equal(sends, 1);
    assert.ok(outcomes.includes('ACKNOWLEDGED_AWAITING_EVIDENCE'));
    assert.equal(f.store.totalQuoteAtoms(), 100n);
    assert.equal(f.store.pending()?.kind, 'WITHDRAWAL');
    assert.equal(await second.submit('withdraw'), 'ACKNOWLEDGED_AWAITING_EVIDENCE');
    assert.equal(sends, 1);
  } finally { f.store.close(); }
});

test('lost response remains locked and reconstructing the withdrawal service never resubmits', async () => {
  const f = fixture();
  try {
    let sends = 0;
    const transport = { async send() { sends++; throw new Error('response lost'); } };
    assert.equal(await new HyperliquidPoolWithdrawalService(f.store, f.reads, transport, () => 1_010).submit('withdraw'), 'UNKNOWN_DO_NOT_RESUBMIT');
    assert.equal(await new HyperliquidPoolWithdrawalService(f.store, f.reads, transport, () => 1_011).submit('withdraw'), 'UNKNOWN_DO_NOT_RESUBMIT');
    assert.equal(sends, 1);
    assert.equal(f.store.totalQuoteAtoms(), 100n);
  } finally { f.store.close(); }
});

test('expired owner authority and mismatched backing never call the signing transport', async () => {
  const f = fixture();
  try {
    const transport = { async send() { assert.fail('must not sign or broadcast'); } };
    await assert.rejects(new HyperliquidPoolWithdrawalService(f.store, f.reads, transport, () => 2_001).submit('withdraw'), /authority/);
    const reads: HyperliquidPoolFundingReadPort = { ...f.reads,
      async flat() { return { ...await f.reads.flat(pool), equityQuoteAtoms: 99n }; } };
    await assert.rejects(new HyperliquidPoolWithdrawalService(f.store, reads, transport, () => 1_010).submit('withdraw'), /backing/);
    assert.equal(f.store.withdrawalSubmission('withdraw'), undefined);
  } finally { f.store.close(); }
});

test('only expired withdrawals never claimed for signing can release their lock', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.releaseExpiredUnsubmittedWithdrawal('withdraw', 2_000, 100n), /expired/);
    assert.throws(() => f.store.releaseExpiredUnsubmittedWithdrawal('withdraw', 2_001, 99n), /backing/);
    f.store.releaseExpiredUnsubmittedWithdrawal('withdraw', 2_001, 100n);
    f.store.releaseExpiredUnsubmittedWithdrawal('withdraw', 2_002, 100n);
    assert.equal(f.store.pending(), undefined);
    assert.equal(f.store.totalQuoteAtoms(), 100n);
    assert.equal(f.store.operation('withdraw')?.state, 'CANCELLED');
    await assert.rejects(new HyperliquidPoolWithdrawalService(f.store, f.reads,
      { async send() { assert.fail('cancelled authorization must not send'); } }, () => 1_010).submit('withdraw'), /cancelled/);
    assert.throws(() => f.store.completeWithdrawal({ id: 'withdraw', transferHash: hash(9), verifiedFlatEquityQuoteAtoms: 0n }), /cancelled/);
  } finally { f.store.close(); }
  const claimed = fixture();
  try {
    claimed.store.claimWithdrawalSubmission('withdraw', 1_001, '{}');
    assert.throws(() => claimed.store.releaseExpiredUnsubmittedWithdrawal('withdraw', 2_001, 100n), /reconciliation/);
    assert.equal(claimed.store.pending()?.id, 'withdraw');
  } finally { claimed.store.close(); }
});
