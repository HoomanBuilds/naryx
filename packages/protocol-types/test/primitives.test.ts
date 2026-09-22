import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ASSET_ATOM_BITS,
  CanonicalWriter,
  EXPIRY_UNIT,
  HASH_BYTE_LENGTH,
  IncompatibleUnitError,
  MalformedInputError,
  RangeViolationError,
  assetAmount,
  assetId,
  compareExpiry,
  encodeExpiry,
  encodeHash32,
  expiry,
  hash32,
  toHex,
} from '../src/index.js';

const DIGEST = '1d235b684fabcd18942b18c62088e969bf7f95c6ba287dc7a6b94dcc1092be0d';

describe('32-byte hash primitive', () => {
  test('accepts hex with and without a prefix', () => {
    assert.equal(toHex(hash32(DIGEST)), DIGEST);
    assert.equal(toHex(hash32(`0x${DIGEST}`)), DIGEST);
  });

  test('accepts exactly 32 bytes', () => {
    assert.equal(hash32(new Uint8Array(HASH_BYTE_LENGTH)).length, 32);
  });

  test('rejects 31 and 33 bytes', () => {
    assert.throws(() => hash32(new Uint8Array(31)), MalformedInputError);
    assert.throws(() => hash32(new Uint8Array(33)), MalformedInputError);
  });

  test('rejects malformed hex', () => {
    assert.throws(() => hash32(DIGEST.slice(1)), MalformedInputError);
    assert.throws(() => hash32(`zz${DIGEST.slice(2)}`), MalformedInputError);
  });

  test('copies its input so a validated hash cannot be mutated through the caller', () => {
    const source = new Uint8Array(HASH_BYTE_LENGTH).fill(1);
    const value = hash32(source);
    source[0] = 0xff;
    assert.equal(toHex(value).startsWith('01'), true);
  });

  test('encodes as raw fixed bytes with no length prefix', () => {
    const writer = new CanonicalWriter();
    encodeHash32(writer, hash32(DIGEST));
    assert.equal(toHex(writer.bytes()), DIGEST);
  });
});

describe('asset identifier', () => {
  test('rejects an empty identifier', () => {
    assert.throws(() => assetId(''), MalformedInputError);
  });

  test('rejects ill-formed utf-16', () => {
    assert.throws(() => assetId('usd\ud83dc'), MalformedInputError);
  });

  test('accepts a canonical domain-qualified identifier', () => {
    assert.equal(assetId('eip155:8453/erc20:0x0000000000000000000000000000000000000000'), 'eip155:8453/erc20:0x0000000000000000000000000000000000000000');
  });
});

describe('asset amount binds identity, decimals, and signed atoms', () => {
  test('accepts a negative atom amount', () => {
    const amount = assetAmount('solana:mainnet-beta/usdc', 6, -1500000n);
    assert.equal(amount.asset, 'solana:mainnet-beta/usdc');
    assert.equal(amount.decimals, 6);
    assert.equal(amount.atoms, -1500000n);
  });

  test('rejects a floating point atom amount', () => {
    assert.throws(
      () => assetAmount('usdc', 6, 1.5 as unknown as bigint),
      MalformedInputError,
    );
    assert.throws(
      () => assetAmount('usdc', 6, 1500000 as unknown as bigint),
      MalformedInputError,
    );
  });

  test('rejects decimals outside u8', () => {
    assert.throws(() => assetAmount('usdc', 256, 1n), RangeViolationError);
    assert.throws(() => assetAmount('usdc', -1, 1n), RangeViolationError);
  });

  test('accepts the signed atom boundaries and rejects one step past each', () => {
    const min = -(1n << BigInt(ASSET_ATOM_BITS - 1));
    const max = (1n << BigInt(ASSET_ATOM_BITS - 1)) - 1n;
    assert.equal(assetAmount('usdc', 6, min).atoms, min);
    assert.equal(assetAmount('usdc', 6, max).atoms, max);
    assert.throws(() => assetAmount('usdc', 6, min - 1n), RangeViolationError);
    assert.throws(() => assetAmount('usdc', 6, max + 1n), RangeViolationError);
  });

  test('is frozen once constructed', () => {
    const amount = assetAmount('usdc', 6, 1n);
    assert.equal(Object.isFrozen(amount), true);
  });
});

describe('expiry is a tagged integer', () => {
  test('encodes the unit discriminant before the value', () => {
    const writer = new CanonicalWriter();
    encodeExpiry(writer, expiry('EVM_UNIX_SECONDS', 1700000000n));
    assert.equal(toHex(writer.bytes()), '02' + (1700000000n).toString(16).padStart(16, '0'));
  });

  test('rejects an unknown unit', () => {
    assert.throws(
      () => expiry('UNIX_NANOSECONDS' as unknown as 'EVM_UNIX_SECONDS', 1n),
      MalformedInputError,
    );
  });

  test('rejects a non-bigint value', () => {
    assert.throws(
      () => expiry('EVM_UNIX_SECONDS', 1700000000 as unknown as bigint),
      MalformedInputError,
    );
  });

  test('rejects a value outside u64', () => {
    assert.throws(() => expiry('EVM_UNIX_SECONDS', -1n), RangeViolationError);
    assert.throws(() => expiry('EVM_UNIX_SECONDS', 1n << 64n), RangeViolationError);
  });
});

describe('expiry comparison requires matching unit tags', () => {
  test('orders values inside one unit', () => {
    const earlier = expiry('HYPERLIQUID_UNIX_MILLISECONDS', 1000n);
    const later = expiry('HYPERLIQUID_UNIX_MILLISECONDS', 1001n);
    assert.equal(compareExpiry(earlier, later), -1);
    assert.equal(compareExpiry(later, earlier), 1);
    assert.equal(compareExpiry(earlier, earlier), 0);
  });

  test('rejects a comparison across units', () => {
    const blockHeight = expiry('SOLANA_LAST_VALID_BLOCK_HEIGHT', 1000n);
    const seconds = expiry('EVM_UNIX_SECONDS', 1000n);
    const milliseconds = expiry('HYPERLIQUID_UNIX_MILLISECONDS', 1000n);
    assert.throws(() => compareExpiry(blockHeight, seconds), IncompatibleUnitError);
    assert.throws(() => compareExpiry(seconds, milliseconds), IncompatibleUnitError);
    assert.throws(() => compareExpiry(milliseconds, blockHeight), IncompatibleUnitError);
  });

  test('every declared unit is comparable with itself only', () => {
    for (const unit of Object.keys(EXPIRY_UNIT) as (keyof typeof EXPIRY_UNIT)[]) {
      assert.equal(compareExpiry(expiry(unit, 5n), expiry(unit, 5n)), 0);
    }
  });
});
