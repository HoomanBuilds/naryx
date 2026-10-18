import assert from 'node:assert/strict';
import test from 'node:test';
import { solanaDevnetStandingBook } from '../src/solana-devnet-standing-book.js';
import { QUOTE_MODE_FIRM_ONCHAIN, QUOTE_SIDE_ASK, QUOTE_SIDE_BID } from '../src/solana-devnet-wire.js';

const hash = new Uint8Array(32).fill(7);
const shard = '3uNeT876Q2KsELwvwxpQKw3cNrfwH2Q2fPxWocKjpVxe';
const config = {
  accounts: { packageBookShard: shard },
  series: { seriesManifestHash: hash, settlementClassIdentityHash: hash, spotBaseAtomsPerPackageUnit: 1n },
  maxQuantityAtoms: 100n, levelCapacityUnits: 100n, inventorySpreadBps: 0, spotBaseLotAtoms: 1n, perpLimitToleranceBps: 0,
} as Parameters<typeof solanaDevnetStandingBook>[1];

function state() {
  const base = {
    slotIndex: 0, settlementClassIdentityHash: hash, reservationPolicyHash: hash,
    referenceOffset: 0n, levelId: 1n, epoch: 2n, levelSequence: 1n,
    minPackageSizeUnits: 1n, maxPackageSizeUnits: 100n, maxFeeAtoms: 0n,
    expirySlot: 150n, remainingCapacity: 100n, active: true,
    side: QUOTE_SIDE_ASK, quoteMode: QUOTE_MODE_FIRM_ONCHAIN,
  };
  return {
    slot: 100n,
    availableInventory: { baseAtoms: 100n, quoteAtoms: 1_000n },
    market: { baseLotAtoms: 1n, maxPositionLots: 100n, impactUnitLots: 1n, maxSlippageBps: 100, halfSpreadBps: 0, impactBpsPerUnit: 0, quoteTickAtomsPerBaseLot: 1n },
    marketMinimumNotionals: { spot: 1n, perpetual: 1n },
    oraclePricePerLot: 10n,
    shard: { killed: false, heartbeatExpirySlot: 200n, epoch: 2n, referencePackagePrice: 10n, seriesManifestHash: hash },
    reservationClass: { policyHash: hash },
    levels: [base],
  } as unknown as Parameters<typeof solanaDevnetStandingBook>[0];
}

test('standing book exposes one eligible level per side without summing refreshed levels', () => {
  const current = state();
  const ask = current.levels[0]!;
  const book = solanaDevnetStandingBook({
    ...current,
    levels: [ask, { ...ask, slotIndex: 1, levelId: 2n, expirySlot: 160n, remainingCapacity: 70n },
      { ...ask, slotIndex: 2, levelId: 3n, side: QUOTE_SIDE_BID, referenceOffset: -2n, remainingCapacity: 40n }],
  }, config);
  assert.equal(book.ask?.levelId, '2');
  assert.equal(book.ask?.remainingCapacityUnits, '70');
  assert.equal(book.bid?.remainingCapacityUnits, '40');
  assert.equal(book.seriesManifestHash, '07'.repeat(32));
});

test('standing book clips capacity to available inventory and removes unfunded sides', () => {
  const current = state();
  const ask = current.levels[0]!;
  const book = solanaDevnetStandingBook({
    ...current, availableInventory: { baseAtoms: 3n, quoteAtoms: 0n },
    levels: [ask, { ...ask, slotIndex: 1, levelId: 2n, side: QUOTE_SIDE_BID }],
  }, config);
  assert.equal(book.ask?.remainingCapacityUnits, '3');
  assert.equal(book.ask?.maxPackageSizeUnits, '3');
  assert.equal(book.bid, null);
  assert.equal(solanaDevnetStandingBook({ ...current, availableInventory: { baseAtoms: 0n, quoteAtoms: 0n } }, config).ask, null);
});

test('standing book excludes expired, mismatched and paused levels', () => {
  const current = state();
  const ask = current.levels[0]!;
  const book = solanaDevnetStandingBook({
    ...current,
    levels: [{ ...ask, expirySlot: 100n }, { ...ask, slotIndex: 1, reservationPolicyHash: new Uint8Array(32) }],
  }, config);
  assert.equal(book.ask, null);
  assert.equal(solanaDevnetStandingBook({ ...current, shard: { ...current.shard, killed: true } }, config).ask, null);
  assert.throws(() => solanaDevnetStandingBook({ ...current, shard: {
    ...current.shard, seriesManifestHash: new Uint8Array(32),
  } }, config), /series does not match/);
});
