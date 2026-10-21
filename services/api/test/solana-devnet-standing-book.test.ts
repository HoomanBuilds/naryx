import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSolanaQuoteLadder, parseSolanaStandingBook } from '../src/solana-devnet-standing-book.js';

const valid = {
  version: 1,
  domainId: 'svm:devnet',
  shard: '3uNeT876Q2KsELwvwxpQKw3cNrfwH2Q2fPxWocKjpVxe',
  seriesManifestHash: '07'.repeat(32),
  finalizedSlot: '100',
  referencePackagePriceAtoms: '10',
  bid: null,
  ask: {
    levelId: '1', referenceOffsetAtoms: '0', remainingCapacityUnits: '100',
    minPackageSizeUnits: '1', maxPackageSizeUnits: '100', expirySlot: '150',
  },
};

test('standing book accepts a current finalized quote without changing integer strings', () => {
  assert.deepEqual(parseSolanaStandingBook(valid), valid);
});

test('standing book rejects expired and malformed quote data', () => {
  assert.throws(() => parseSolanaStandingBook({ ...valid, ask: { ...valid.ask, expirySlot: '100' } }), /malformed/);
  assert.throws(() => parseSolanaStandingBook({ ...valid, ask: { ...valid.ask, remainingCapacityUnits: '0' } }), /malformed/);
  assert.throws(() => parseSolanaStandingBook({ ...valid, seriesManifestHash: '00' }), /malformed/);
});

test('maker quote proxy refuses stale, expired, unbound and duplicated sizes', () => {
  const value = {
    version: 1, domainId: 'svm:devnet', templateId: 'cash-and-carry-v1', pricing: 'INDICATIVE',
    reservation: 'ON_ACCEPT', quantityKind: 'ALTERNATIVE_SIZES', capturedAtMs: 1_000, finalizedSlot: '100',
    seriesManifestHash: '07'.repeat(32), baseMint: valid.shard,
    quoteMint: 'So11111111111111111111111111111111111111112', baseDecimals: 9, quoteDecimals: 6,
    bids: [], asks: [{ levelId: '1', quantityAtoms: '100', basisQuoteAtoms: '-3', feeQuoteAtoms: '1', expirySlot: '150' }],
  };
  assert.deepEqual(parseSolanaQuoteLadder(value, 1_000), value);
  assert.throws(() => parseSolanaQuoteLadder(value, 11_001), /observation/);
  assert.throws(() => parseSolanaQuoteLadder({ ...value, templateId: 'treasury-inventory-hedge-v1' }, 1_000), /identity/);
  assert.throws(() => parseSolanaQuoteLadder({ ...value, asks: [value.asks[0], value.asks[0]] }, 1_000), /levels/);
  assert.throws(() => parseSolanaQuoteLadder({ ...value, asks: [{ ...value.asks[0], expirySlot: '100' }] }, 1_000), /levels/);
  assert.throws(() => parseSolanaQuoteLadder({ ...value, asks: [{ ...value.asks[0], quantityAtoms: '0' }] }, 1_000), /levels/);
});
