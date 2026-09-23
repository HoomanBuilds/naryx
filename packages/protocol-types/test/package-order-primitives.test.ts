import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  adapterRef,
  assetRef,
  canonicalAdapterRefs,
  canonicalFeeCaps,
  commitmentHash,
  encodeAdapterRef,
  encodeCommitmentHash,
  encodeExactPrice,
  encodeExactSignedRate,
  encodeFeeCap,
  exactPrice,
  exactSignedRate,
  feeCap,
  toHex,
  type AdapterRef,
  type ExactPrice,
  type ExactSignedRate,
  type FeeCap,
} from '../src/index.js';

const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);
const HASH_C = '33'.repeat(32);
const U128_MAX = (1n << 128n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;

function asset(id: string, hash = HASH_A) {
  return assetRef(id, hash, 6);
}

function price(overrides: Partial<ExactPrice> = {}) {
  return exactPrice({
    baseAsset: asset('asset-base', HASH_A),
    quoteAsset: asset('asset-quote', HASH_B),
    quoteAtoms: 5n,
    baseAtoms: 2n,
    roundingDirection: 'FLOOR',
    ...overrides,
  });
}

function signedRate(overrides: Partial<ExactSignedRate> = {}) {
  return exactSignedRate({
    baseAsset: asset('asset-base', HASH_A),
    quoteAsset: asset('asset-quote', HASH_B),
    quoteAtoms: -5n,
    baseAtoms: 2n,
    roundingDirection: 'CEIL',
    ...overrides,
  });
}

function adapter(id: string, version = 1, hash = HASH_A) {
  return adapterRef({
    adapterId: id,
    adapterManifestVersion: version,
    adapterManifestHash: hash,
  });
}

describe('package order numeric primitives', () => {
  test('commitment hashes are nonzero canonical bytes', () => {
    assert.equal(toHex(commitmentHash(HASH_A)), HASH_A);
    assert.throws(() => commitmentHash('00'.repeat(32)), MalformedInputError);

    const writer = new CanonicalWriter();
    assert.throws(
      () => encodeCommitmentHash(writer, HASH_A as unknown as ReturnType<typeof commitmentHash>),
      MalformedInputError,
    );
    assert.equal(writer.bytes().length, 0);
  });

  test('prices use positive reduced u128 fractions', () => {
    assert.equal(price({ quoteAtoms: U128_MAX, baseAtoms: 1n }).quoteAtoms, U128_MAX);
    assert.throws(() => price({ quoteAtoms: 0n }), MalformedInputError);
    assert.throws(() => price({ baseAtoms: 0n }), MalformedInputError);
    assert.throws(() => price({ quoteAtoms: 6n, baseAtoms: 4n }), MalformedInputError);
    assert.throws(
      () => price({ quoteAtoms: 1 as unknown as bigint }),
      MalformedInputError,
    );
    assert.throws(() => price({ quoteAtoms: 1n << 128n }), RangeViolationError);
  });

  test('signed rates use reduced i128 fractions and canonical zero', () => {
    assert.equal(signedRate({ quoteAtoms: I128_MIN, baseAtoms: 1n }).quoteAtoms, I128_MIN);
    assert.equal(signedRate({ quoteAtoms: I128_MAX, baseAtoms: 1n }).quoteAtoms, I128_MAX);
    assert.equal(signedRate({ quoteAtoms: 0n, baseAtoms: 1n }).quoteAtoms, 0n);
    assert.throws(
      () => signedRate({ quoteAtoms: 0n, baseAtoms: 2n }),
      MalformedInputError,
    );
    assert.throws(
      () => signedRate({ quoteAtoms: -6n, baseAtoms: 4n }),
      MalformedInputError,
    );
    assert.throws(() => signedRate({ quoteAtoms: 1n << 127n }), RangeViolationError);
  });

  test('fee caps preserve signed i128 boundaries', () => {
    assert.equal(feeCap({ asset: asset('asset-a'), maxAtoms: I128_MIN }).maxAtoms, I128_MIN);
    assert.equal(feeCap({ asset: asset('asset-a'), maxAtoms: I128_MAX }).maxAtoms, I128_MAX);
    assert.throws(
      () => feeCap({ asset: asset('asset-a'), maxAtoms: I128_MAX + 1n }),
      RangeViolationError,
    );
  });
});

describe('package order canonical reference lists', () => {
  test('fee caps require complete-asset order and reject duplicate asset keys', () => {
    const first = feeCap({ asset: asset('asset-a', HASH_A), maxAtoms: 10n });
    const second = feeCap({ asset: asset('asset-b', HASH_B), maxAtoms: 20n });
    assert.deepEqual(canonicalFeeCaps([]), []);
    assert.equal(canonicalFeeCaps([first, second]).length, 2);
    assert.throws(() => canonicalFeeCaps([second, first]), MalformedInputError);
    assert.throws(
      () => canonicalFeeCaps([first, feeCap({ asset: asset('asset-a', HASH_A), maxAtoms: 99n })]),
      DuplicateElementError,
    );
  });

  test('adapter references require a nonempty complete-reference set', () => {
    const first = adapter('adapter-a', 1, HASH_A);
    const second = adapter('adapter-b', 2, HASH_B);
    assert.equal(canonicalAdapterRefs([first, second]).length, 2);
    assert.throws(() => canonicalAdapterRefs([]), MalformedInputError);
    assert.throws(() => canonicalAdapterRefs([second, first]), MalformedInputError);
    assert.throws(
      () => canonicalAdapterRefs([first, adapter('adapter-a', 1, HASH_A)]),
      DuplicateElementError,
    );
  });
});

describe('package order primitive encoder validation', () => {
  test('returned hash identities are defensive copies', () => {
    const reference = adapter('adapter-a', 1, HASH_A);
    const before = new CanonicalWriter();
    encodeAdapterRef(before, reference);
    reference.adapterManifestHash[0] = 0xff;
    const after = new CanonicalWriter();
    encodeAdapterRef(after, reference);
    assert.equal(toHex(after.bytes()), toHex(before.bytes()));

    const value = price();
    const priceBefore = new CanonicalWriter();
    encodeExactPrice(priceBefore, value);
    value.baseAsset.assetManifestHash[0] = 0xff;
    const priceAfter = new CanonicalWriter();
    encodeExactPrice(priceAfter, value);
    assert.equal(toHex(priceAfter.bytes()), toHex(priceBefore.bytes()));
  });

  test('encoders reject forged objects before writing', () => {
    const forgedPrice = {
      ...price(),
      baseAsset: {
        ...asset('asset-base', HASH_A),
        assetManifestHash: HASH_A,
      },
    } as unknown as ExactPrice;
    const priceWriter = new CanonicalWriter();
    assert.throws(() => encodeExactPrice(priceWriter, forgedPrice), MalformedInputError);
    assert.equal(priceWriter.bytes().length, 0);

    const forgedRate = {
      ...signedRate(),
      quoteAtoms: 6n,
      baseAtoms: 4n,
    } as ExactSignedRate;
    const rateWriter = new CanonicalWriter();
    assert.throws(() => encodeExactSignedRate(rateWriter, forgedRate), MalformedInputError);
    assert.equal(rateWriter.bytes().length, 0);

    const forgedAdapter = {
      ...adapter('adapter-a'),
      adapterManifestHash: HASH_A,
    } as unknown as AdapterRef;
    const adapterWriter = new CanonicalWriter();
    assert.throws(() => encodeAdapterRef(adapterWriter, forgedAdapter), MalformedInputError);
    assert.equal(adapterWriter.bytes().length, 0);

    const forgedFee = {
      ...feeCap({ asset: asset('asset-a'), maxAtoms: 1n }),
      asset: {
        ...asset('asset-a'),
        decimals: 6n,
      },
    } as unknown as FeeCap;
    const feeWriter = new CanonicalWriter();
    assert.throws(() => encodeFeeCap(feeWriter, forgedFee), MalformedInputError);
    assert.equal(feeWriter.bytes().length, 0);
  });

  test('rounding direction is part of canonical identity', () => {
    const floorWriter = new CanonicalWriter();
    encodeExactPrice(floorWriter, price({ roundingDirection: 'FLOOR' }));
    const ceilWriter = new CanonicalWriter();
    encodeExactPrice(ceilWriter, price({ roundingDirection: 'CEIL' }));
    assert.notEqual(toHex(floorWriter.bytes()), toHex(ceilWriter.bytes()));

    const cap = feeCap({ asset: asset('asset-c', HASH_C), maxAtoms: -1n });
    const capWriter = new CanonicalWriter();
    encodeFeeCap(capWriter, cap);
    assert.ok(capWriter.bytes().length > 0);
  });
});
