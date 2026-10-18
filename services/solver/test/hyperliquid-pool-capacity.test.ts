import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, domainRef } from '@naryx/protocol-types';
import { HyperliquidPooledCollateralStore, type HyperliquidPoolBinding } from '../src/hyperliquid-pooled-collateral-store.js';
import { poolBindingHash, poolConsentTypedData } from '../src/hyperliquid-pool-funding.js';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const owner = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const binding: HyperliquidPoolBinding = { version: 3, environment: 'TESTNET',
  domain: domainRef('hypercore:testnet', 1, hash(1)), poolAccount: owner(9), policyHash: hash(2),
  maximumTotalQuoteAtoms: 2_000_000_000n, maximumOwnerQuoteAtoms: 1_000_000_000n,
  quoteAsset: assetRef('pool-usdc', hash(3), 6), collateralTokenId: `0x${'11'.repeat(16)}`, dedicatedTestOwners: [] };

test('public capacity enforces both exact boundaries without partial credits or replay inflation', () => {
  const store = new HyperliquidPooledCollateralStore(':memory:', binding);
  try {
    for (const n of [1, 2, 3]) store.enroll(owner(n), hash(n + 10));
    const first = { id: 'first', owner: owner(1), receivedQuoteAtoms: 1_000_000_000n, transferHash: hash(21) };
    store.creditDeposit(first, 1_000_000_000n);
    store.creditDeposit(first, 0n);
    assert.throws(() => store.creditDeposit({ ...first, id: 'over-owner', receivedQuoteAtoms: 1n, transferHash: hash(22) },
      1_000_000_001n), /owner funding cap/);
    assert.equal(store.operation('over-owner'), undefined);
    store.creditDeposit({ ...first, id: 'second', owner: owner(2), transferHash: hash(22) }, 2_000_000_000n);
    assert.throws(() => store.creditDeposit({ ...first, id: 'over-pool', owner: owner(3), receivedQuoteAtoms: 1n,
      transferHash: hash(23) }, 2_000_000_001n), /pool funding cap/);
    assert.equal(store.totalQuoteAtoms(), 2_000_000_000n);
    assert.equal(store.operation('over-pool'), undefined);
  } finally { store.close(); }
});

test('profits above public caps settle and withdraw while new owner risk stays bounded', () => {
  const store = new HyperliquidPooledCollateralStore(':memory:', binding);
  try {
    for (const n of [1, 2]) {
      store.enroll(owner(n), hash(n + 10));
      store.creditDeposit({ id: `deposit-${n}`, owner: owner(n), receivedQuoteAtoms: 1_000_000_000n,
        transferHash: hash(n + 20) }, BigInt(n) * 1_000_000_000n);
    }
    const reservations = [1, 2].map(n => ({ owner: owner(n), maximumLossQuoteAtoms: 1_000_000_000n, authorizationHash: hash(n + 30) }));
    store.reserveEpoch({ id: 'epoch', reservations, verifiedFlatEquityQuoteAtoms: 2_000_000_000n });
    store.settleEpoch({ id: 'epoch', allocations: [{ owner: owner(1), pnlQuoteAtoms: 1n }, { owner: owner(2), pnlQuoteAtoms: -1n }],
      verifiedFlatEquityQuoteAtoms: 2_000_000_000n, evidenceHash: hash(40) });
    assert.throws(() => store.reserveEpoch({ id: 'over-risk', verifiedFlatEquityQuoteAtoms: 2_000_000_000n,
      reservations: [{ ...reservations[0]!, maximumLossQuoteAtoms: 1_000_000_001n },
        { ...reservations[1]!, maximumLossQuoteAtoms: 999_999_999n }] }), /risk cap/);
    store.prepareWithdrawal({ id: 'withdraw', owner: owner(1), debitQuoteAtoms: 1_000_000_001n, authorizationHash: hash(41),
      verifiedFlatEquityQuoteAtoms: 2_000_000_000n, preparedAtMs: 1_000, expiresAtMs: 2_000 });
    store.completeWithdrawal({ id: 'withdraw', transferHash: hash(42), verifiedFlatEquityQuoteAtoms: 999_999_999n });
    assert.equal(store.members()[0]!.balanceQuoteAtoms, 0n);
  } finally { store.close(); }
});

test('capacity policy rejects missing, invalid and overflowing bounds and binds owner consent', () => {
  for (const maximumOwnerQuoteAtoms of [undefined, 0n, -1n, 2_000_000_001n, 1n << 128n]) {
    assert.throws(() => new HyperliquidPooledCollateralStore(':memory:', { ...binding, maximumOwnerQuoteAtoms: maximumOwnerQuoteAtoms! }));
  }
  assert.throws(() => new HyperliquidPooledCollateralStore(':memory:', { ...binding, maximumTotalQuoteAtoms: 1n << 128n }));
  assert.throws(() => new HyperliquidPooledCollateralStore(':memory:', { ...binding, version: 2 }), /version 3/);
  assert.notEqual(poolBindingHash(binding), poolBindingHash({ ...binding, maximumOwnerQuoteAtoms: 999_999_999n }));
  assert.notEqual(poolBindingHash(binding), poolBindingHash({ ...binding, maximumTotalQuoteAtoms: 2_000_000_001n }));
  assert.equal(poolConsentTypedData(binding, owner(1)).message.custodyMode, 'CUSTODIAL_TESTNET_POOL_V3');
});
