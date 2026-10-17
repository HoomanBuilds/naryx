import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetRef, domainRef } from '@naryx/protocol-types';
import { HyperliquidPooledCollateralStore, type HyperliquidPoolBinding } from '../src/hyperliquid-pooled-collateral-store.js';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const owner = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const binding: HyperliquidPoolBinding = { version: 1, environment: 'TESTNET',
  domain: domainRef('hypercore:testnet', 1, hash(1)), poolAccount: owner(9), policyHash: hash(2), maximumTotalQuoteAtoms: 1_000n,
  quoteAsset: assetRef('pool-usdc', hash(3), 6), collateralTokenId: `0x${'11'.repeat(16)}`, dedicatedTestOwners: [owner(1), owner(2)] };

function funded(path = ':memory:') {
  const store = new HyperliquidPooledCollateralStore(path, binding);
  for (const n of [1, 2]) {
    store.enroll(owner(n), hash(n + 10));
    store.creditDeposit({ id: `deposit-${n}`, owner: owner(n), receivedQuoteAtoms: 100n, transferHash: hash(n + 20) }, BigInt(n) * 100n);
  }
  return store;
}

const epoch = { id: 'epoch-1', verifiedFlatEquityQuoteAtoms: 200n, reservations: [
  { owner: owner(1), maximumLossQuoteAtoms: 25n, authorizationHash: hash(31) },
  { owner: owner(2), maximumLossQuoteAtoms: 40n, authorizationHash: hash(32) },
] };

test('pooled epochs conserve liabilities, reserve gross owner losses and persist across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-pooled-'));
  const path = join(directory, 'pool.sqlite');
  let store = funded(path);
  try {
    store.reserveEpoch(epoch);
    store.reserveEpoch(epoch);
    store.close();
    store = new HyperliquidPooledCollateralStore(path, binding);
    assert.deepEqual(store.pending(), { id: 'epoch-1', kind: 'EPOCH' });
    assert.throws(() => store.prepareWithdrawal({ id: 'withdraw-1', owner: owner(1), debitQuoteAtoms: 1n,
      authorizationHash: hash(33), verifiedFlatEquityQuoteAtoms: 200n, preparedAtMs: 1_000, expiresAtMs: 2_000 }), /locks the pool/);
    const settlement = { id: 'epoch-1', verifiedFlatEquityQuoteAtoms: 197n, evidenceHash: hash(34), allocations: [
      { owner: owner(1), pnlQuoteAtoms: 12n }, { owner: owner(2), pnlQuoteAtoms: -15n },
    ] };
    store.settleEpoch(settlement);
    store.settleEpoch(settlement);
    assert.equal(store.totalQuoteAtoms(), 197n);
    assert.deepEqual(store.members().map(member => member.balanceQuoteAtoms), [112n, 85n]);
    assert.equal(store.pending(), undefined);
    assert.throws(() => store.settleEpoch({ ...settlement, evidenceHash: hash(35) }), /replay changed/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('invalid allocations roll back every balance and never socialise a loss beyond consent', () => {
  const store = funded();
  try {
    store.reserveEpoch(epoch);
    const baseline = store.members();
    for (const allocations of [
      [{ owner: owner(1), pnlQuoteAtoms: 15n }, { owner: owner(2), pnlQuoteAtoms: -41n }],
      [{ owner: owner(1), pnlQuoteAtoms: 15n }, { owner: owner(2), pnlQuoteAtoms: -14n }],
      [{ owner: owner(1), pnlQuoteAtoms: 0n }, { owner: owner(1), pnlQuoteAtoms: 0n }],
      [{ owner: owner(1), pnlQuoteAtoms: 0n }, { owner: owner(3), pnlQuoteAtoms: 0n }],
    ]) {
      assert.throws(() => store.settleEpoch({ id: epoch.id, allocations, evidenceHash: hash(40), verifiedFlatEquityQuoteAtoms: 200n }));
      assert.deepEqual(store.members(), baseline);
      assert.equal(store.pending()?.kind, 'EPOCH');
    }
  } finally { store.close(); }
});

test('withdrawal uncertainty locks funds across processes and exact confirmation debits only once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-pooled-'));
  const path = join(directory, 'pool.sqlite');
  const store = funded(path);
  const other = new HyperliquidPooledCollateralStore(path, binding);
  try {
    const input = { id: 'withdraw-1', owner: owner(1), debitQuoteAtoms: 100n,
      authorizationHash: hash(41), verifiedFlatEquityQuoteAtoms: 200n, preparedAtMs: 1_000, expiresAtMs: 2_000 };
    store.prepareWithdrawal(input);
    other.prepareWithdrawal(input);
    assert.throws(() => other.reserveEpoch(epoch), /locks the pool/);
    assert.throws(() => other.prepareWithdrawal({ ...input, id: 'withdraw-2' }), /locks the pool/);
    assert.throws(() => other.prepareWithdrawal({ ...input, owner: owner(2) }), /replay changed/);
    assert.throws(() => other.completeWithdrawal({ id: input.id, transferHash: hash(42), verifiedFlatEquityQuoteAtoms: 101n }), /conserve/);
    const confirmation = { id: input.id, transferHash: hash(42), verifiedFlatEquityQuoteAtoms: 100n };
    other.completeWithdrawal(confirmation);
    store.completeWithdrawal(confirmation);
    assert.equal(store.totalQuoteAtoms(), 100n);
    assert.equal(store.members()[0]?.balanceQuoteAtoms, 0n);
    assert.throws(() => store.creditDeposit({ id: 'reused-transfer', owner: owner(2), receivedQuoteAtoms: 100n, transferHash: hash(42) }, 200n), /UNIQUE/);
  } finally { other.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('funding, identity, exact replay and reserve boundaries fail closed', () => {
  const store = funded();
  try {
    assert.throws(() => store.creditDeposit({ id: 'new', owner: owner(3), receivedQuoteAtoms: 1n, transferHash: hash(50) }, 201n), /consented/);
    assert.throws(() => store.creditDeposit({ id: 'new', owner: owner(1), receivedQuoteAtoms: 801n, transferHash: hash(50) }, 1_001n), /cap/);
    assert.throws(() => store.creditDeposit({ id: 'new', owner: owner(1), receivedQuoteAtoms: 0n, transferHash: hash(50) }, 200n), /atoms/);
    assert.throws(() => store.creditDeposit({ id: 'new', owner: owner(1), receivedQuoteAtoms: 1n << 128n, transferHash: hash(50) }, 200n), /atoms/);
    assert.throws(() => store.creditDeposit({ id: 'deposit-1', owner: owner(1), receivedQuoteAtoms: 101n, transferHash: hash(21) }, 301n), /replay/);
    assert.throws(() => store.reserveEpoch({ ...epoch, verifiedFlatEquityQuoteAtoms: 199n }), /liabilities/);
    assert.throws(() => store.reserveEpoch({ ...epoch, reservations: [epoch.reservations[0]!, { ...epoch.reservations[1]!, maximumLossQuoteAtoms: 101n }] }), /funded balance/);
    assert.equal(store.totalQuoteAtoms(), 200n);
    assert.equal(store.pending(), undefined);
    assert.throws(() => new HyperliquidPooledCollateralStore(':memory:', { ...binding, environment: 'MAINNET' as never }), /testnet/);
  } finally { store.close(); }
});

test('profits above the entry cap can settle and withdraw without admitting another epoch', () => {
  const store = funded();
  try {
    store.reserveEpoch(epoch);
    store.settleEpoch({ id: epoch.id, allocations: [{ owner: owner(1), pnlQuoteAtoms: 900n }, { owner: owner(2), pnlQuoteAtoms: 0n }],
      evidenceHash: hash(60), verifiedFlatEquityQuoteAtoms: 1_100n });
    assert.equal(store.totalQuoteAtoms(), 1_100n);
    assert.throws(() => store.reserveEpoch({ ...epoch, id: 'next', verifiedFlatEquityQuoteAtoms: 1_100n }), /entry cap/);
    store.prepareWithdrawal({ id: 'profit-withdrawal', owner: owner(1), debitQuoteAtoms: 900n, authorizationHash: hash(61),
      verifiedFlatEquityQuoteAtoms: 1_100n, preparedAtMs: 1_000, expiresAtMs: 2_000 });
    store.completeWithdrawal({ id: 'profit-withdrawal', transferHash: hash(62), verifiedFlatEquityQuoteAtoms: 200n });
    store.reserveEpoch({ ...epoch, id: 'next' });
    assert.throws(() => store.settleEpoch({ id: 'next', allocations: [{ owner: owner(1), pnlQuoteAtoms: 0n }, { owner: owner(2), pnlQuoteAtoms: 0n }],
      evidenceHash: hash(60), verifiedFlatEquityQuoteAtoms: 200n }), /UNIQUE/);
    assert.equal(store.pending()?.id, 'next');
  } finally { store.close(); }
});
