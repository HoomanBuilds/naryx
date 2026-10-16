import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSolanaStandingBook } from '../src/solana-devnet-standing-book.js';

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
