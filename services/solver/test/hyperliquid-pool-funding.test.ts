import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assetRef, domainRef } from '@naryx/protocol-types';
import { HyperliquidPooledCollateralStore } from '../src/hyperliquid-pooled-collateral-store.js';
import { HyperliquidPoolFundingService, poolConsentTypedData, poolWithdrawalTypedData,
  type HyperliquidPoolFlatEvidence, type HyperliquidPoolTransferEvidence } from '../src/hyperliquid-pool-funding.js';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

function fixture() {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = wallet.address.toLowerCase() as `0x${string}`;
  const pool = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as `0x${string}`;
  let now = 1_000_000;
  const store = new HyperliquidPooledCollateralStore(':memory:', { version: 1, environment: 'TESTNET',
    domain: domainRef('hypercore:testnet', 1, hash(1)), poolAccount: pool, policyHash: hash(2), maximumTotalQuoteAtoms: 100_000_000n,
    quoteAsset: assetRef('pool-usdc', hash(3), 6), collateralTokenId: `0x${'11'.repeat(16)}`, dedicatedTestOwners: [owner] });
  let equity = 19_000_000n;
  let transfer: HyperliquidPoolTransferEvidence = { environment: 'TESTNET', hash: hash(3), source: owner, destination: pool,
    debitedQuoteAtoms: 20_000_000n, receivedQuoteAtoms: 19_000_000n, timeMs: now - 100, nonce: now - 101 };
  let stale = false;
  const service = new HyperliquidPoolFundingService(store, {
    async flat(): Promise<HyperliquidPoolFlatEvidence> {
      return { environment: 'TESTNET', account: pool, equityQuoteAtoms: equity, withdrawableQuoteAtoms: equity,
        requestedAtMs: now - (stale ? 5_001 : 0), observedAtMs: now };
    },
    async transfer() { return transfer; },
  }, () => now);
  return { wallet, owner, pool, store, service, now: () => now,
    advance(ms = 10) { now += ms; }, stale() { stale = true; },
    setEquity(value: bigint) { equity = value; }, setTransfer(value: HyperliquidPoolTransferEvidence) { transfer = value; },
    deposit: { id: 'deposit-1', owner, transferHash: hash(3), transferTimeMs: now - 100 },
    async enroll() { await service.enroll(owner, await wallet.signTypedData(poolConsentTypedData(store.binding, owner))); },
  };
}

test('signed custody consent, net received funding and signed withdrawal reconcile to exact venue cash', async () => {
  const f = fixture();
  try {
    await f.enroll();
    await f.service.creditDeposit(f.deposit);
    await f.service.creditDeposit(f.deposit);
    assert.equal(f.store.totalQuoteAtoms(), 19_000_000n);
    const request = { id: 'withdraw-1', owner: f.owner, debitQuoteAtoms: 19_000_000n, expiresAtMs: f.now() + 1_000 };
    const signature = await f.wallet.signTypedData(poolWithdrawalTypedData(f.store.binding, request));
    assert.equal((await f.service.prepareWithdrawal(request, signature)).status, 'RESERVED_NOT_SUBMITTED');
    assert.equal((await f.service.prepareWithdrawal(request, signature)).status, 'PENDING_DO_NOT_RESUBMIT');
    f.advance();
    f.setEquity(0n);
    f.setTransfer({ environment: 'TESTNET', hash: hash(4), source: f.pool, destination: f.owner,
      debitedQuoteAtoms: 19_000_000n, receivedQuoteAtoms: 19_000_000n, timeMs: f.now(), nonce: f.now() - 1 });
    const completion = { id: request.id, transferHash: hash(4), transferTimeMs: f.now() };
    await f.service.completeWithdrawal(completion);
    await f.service.completeWithdrawal(completion);
    assert.equal(f.store.totalQuoteAtoms(), 0n);
    assert.equal(f.store.pending(), undefined);
    assert.equal((await f.service.prepareWithdrawal(request, signature)).status, 'COMPLETE');
  } finally { f.store.close(); }
});

test('wrong signer, substituted pool and unconsented funding cannot mutate liabilities', async () => {
  const f = fixture();
  try {
    const other = privateKeyToAccount(generatePrivateKey());
    const outsider = other.address.toLowerCase() as `0x${string}`;
    await assert.rejects(f.service.enroll(outsider, await other.signTypedData(poolConsentTypedData(f.store.binding, outsider))), /not eligible/);
    await assert.rejects(f.service.enroll(f.owner, await other.signTypedData(poolConsentTypedData(f.store.binding, f.owner))), /consent/);
    await assert.rejects(f.service.enroll(f.owner, await f.wallet.signTypedData(poolConsentTypedData({ ...f.store.binding,
      poolAccount: other.address.toLowerCase() as `0x${string}` }, f.owner))), /consent/);
    await assert.rejects(f.service.enroll(f.owner, await f.wallet.signTypedData(poolConsentTypedData({ ...f.store.binding,
      maximumTotalQuoteAtoms: 1n }, f.owner))), /consent/);
    await assert.rejects(f.service.creditDeposit(f.deposit), /consented/);
    await f.enroll();
    await f.service.creditDeposit(f.deposit);
    const request = { id: 'withdraw-1', owner: f.owner, debitQuoteAtoms: 1n, expiresAtMs: f.now() + 1_000 };
    await assert.rejects(f.service.prepareWithdrawal(request, await other.signTypedData(poolWithdrawalTypedData(f.store.binding, request))), /owner signature/);
    assert.equal(f.store.pending(), undefined);
  } finally { f.store.close(); }
});

test('a delayed receipt settles after expiry only when its nonce matches the journaled authorized submission', async () => {
  const f = fixture();
  try {
    await f.enroll();
    await f.service.creditDeposit(f.deposit);
    const request = { id: 'late-withdraw', owner: f.owner, debitQuoteAtoms: 19_000_000n, expiresAtMs: f.now() + 100 };
    await f.service.prepareWithdrawal(request, await f.wallet.signTypedData(poolWithdrawalTypedData(f.store.binding, request)));
    const nonce = f.now() + 10;
    f.store.claimWithdrawalSubmission(request.id, nonce, '{}');
    f.advance(200);
    f.setEquity(0n);
    const proof = { environment: 'TESTNET' as const, hash: hash(7), source: f.pool, destination: f.owner,
      debitedQuoteAtoms: 19_000_000n, receivedQuoteAtoms: 19_000_000n, timeMs: f.now(), nonce: nonce + 1 };
    f.setTransfer(proof);
    const completion = { id: request.id, transferHash: proof.hash, transferTimeMs: proof.timeMs };
    await assert.rejects(f.service.completeWithdrawal(completion), /nonce/);
    assert.equal(f.store.totalQuoteAtoms(), 19_000_000n);
    f.setTransfer({ ...proof, nonce });
    await f.service.completeWithdrawal(completion);
    await f.service.completeWithdrawal(completion);
    assert.equal(f.store.totalQuoteAtoms(), 0n);
    assert.equal(f.store.pending(), undefined);
  } finally { f.store.close(); }
});

test('stale backing, unaccounted cash, wrong transfer identity and expired authorizations fail closed', async () => {
  const f = fixture();
  try {
    await f.enroll();
    f.setEquity(20_000_000n);
    await assert.rejects(f.service.creditDeposit(f.deposit), /not fully backed/);
    assert.equal(f.store.totalQuoteAtoms(), 0n);
    assert.equal(f.store.operation(f.deposit.id), undefined);
    f.setEquity(19_000_000n);
    await assert.rejects(f.service.creditDeposit({ ...f.deposit, transferHash: hash(5) }), /bind/);
    f.stale();
    await assert.rejects(f.service.creditDeposit(f.deposit), /fresh/);
    assert.equal(f.store.totalQuoteAtoms(), 0n);
    const request = { id: 'withdraw-1', owner: f.owner, debitQuoteAtoms: 1n, expiresAtMs: f.now() };
    await assert.rejects(f.service.prepareWithdrawal(request, await f.wallet.signTypedData(poolWithdrawalTypedData(f.store.binding, request))), /expired/);
  } finally { f.store.close(); }
});

test('old or wrong-destination withdrawal evidence leaves the entire reservation locked', async () => {
  const f = fixture();
  try {
    await f.enroll();
    await f.service.creditDeposit(f.deposit);
    const request = { id: 'withdraw-1', owner: f.owner, debitQuoteAtoms: 19_000_000n, expiresAtMs: f.now() + 1_000 };
    await f.service.prepareWithdrawal(request, await f.wallet.signTypedData(poolWithdrawalTypedData(f.store.binding, request)));
    await assert.rejects(f.service.completeWithdrawal({ id: request.id, transferHash: hash(6), transferTimeMs: f.now() - 1 }), /window/);
    f.advance();
    f.setTransfer({ environment: 'TESTNET', hash: hash(6), source: f.pool, destination: f.pool,
      debitedQuoteAtoms: 19_000_000n, receivedQuoteAtoms: 19_000_000n, timeMs: f.now(), nonce: f.now() - 1 });
    await assert.rejects(f.service.completeWithdrawal({ id: request.id, transferHash: hash(6), transferTimeMs: f.now() }), /bind/);
    assert.equal(f.store.totalQuoteAtoms(), 19_000_000n);
    assert.equal(f.store.pending()?.kind, 'WITHDRAWAL');
  } finally { f.store.close(); }
});
