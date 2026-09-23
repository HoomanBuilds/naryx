import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ASSET_ATOM_BITS,
  CanonicalWriter,
  EXPIRY_UNIT,
  HASH_BYTE_LENGTH,
  IncompatibleUnitError,
  MalformedInputError,
  PROTOCOL_ID_MAX_BYTES,
  RangeViolationError,
  assetAmount,
  assetId,
  assetRef,
  compareExpiry,
  domainId,
  domainRef,
  encodeAssetAmount,
  encodeAssetRef,
  encodeDomainRef,
  encodeExpiry,
  encodeHash32,
  encodeManifestHash,
  encodeProtocolId,
  encodeVersionedManifestRef,
  expiry,
  hash32,
  manifestHash,
  protocolId,
  toHex,
  versionedManifestRef,
  type AssetAmount,
  type AssetRef,
  type DomainRef,
  type Expiry,
  type ManifestHash,
  type ProtocolId,
  type VersionedManifestRef,
} from '../src/index.js';

const DIGEST = '1d235b684fabcd18942b18c62088e969bf7f95c6ba287dc7a6b94dcc1092be0d';
const ZERO_DIGEST = '00'.repeat(HASH_BYTE_LENGTH);
const ASSET_MANIFEST = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const TEMPLATE_MANIFEST = '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f';
const DOMAIN_MANIFEST = '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f';
const USDC = 'solana:mainnet-beta/usdc';
const CARRY_V1 = 'solana:mainnet-beta:sol-carry-v1';
const BASE_DOMAIN = 'eip155:8453:eth-carry-v1';

const usdc = (): AssetRef => assetRef(USDC, ASSET_MANIFEST, 6);

// Spelled as code units so this file stays ascii and the intended input is unambiguous.
const codeUnits = (...units: number[]): string => String.fromCharCode(...units);
const E_ACUTE = codeUnits(0x00e9);
const COMBINING_ACUTE = codeUnits(0x0301);
const ROCKET = codeUnits(0xd83d, 0xde80);
const LONE_HIGH_SURROGATE = codeUnits(0xd83d);

describe('32-byte hash primitive', () => {
  test('accepts hex with and without a prefix', () => {
    assert.equal(toHex(hash32(DIGEST)), DIGEST);
    assert.equal(toHex(hash32(`0x${DIGEST}`)), DIGEST);
  });

  test('accepts exactly 32 bytes, including the all-zero digest', () => {
    assert.equal(hash32(new Uint8Array(HASH_BYTE_LENGTH)).length, 32);
    assert.equal(toHex(hash32(ZERO_DIGEST)), ZERO_DIGEST);
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

describe('manifest hash refuses the all-zero digest', () => {
  test('accepts a nonzero digest and encodes it as raw fixed bytes', () => {
    const writer = new CanonicalWriter();
    encodeManifestHash(writer, manifestHash(ASSET_MANIFEST));
    assert.equal(toHex(writer.bytes()), ASSET_MANIFEST);
  });

  test('rejects the all-zero digest from hex and from bytes', () => {
    assert.throws(() => manifestHash(ZERO_DIGEST), MalformedInputError);
    assert.throws(() => manifestHash(new Uint8Array(HASH_BYTE_LENGTH)), MalformedInputError);
  });

  test('accepts a digest whose only nonzero byte is the last one', () => {
    const nearlyZero = `${'00'.repeat(HASH_BYTE_LENGTH - 1)}01`;
    assert.equal(toHex(manifestHash(nearlyZero)), nearlyZero);
  });

  test('inherits the 32-byte length rule', () => {
    assert.throws(() => manifestHash(new Uint8Array(31).fill(1)), MalformedInputError);
    assert.throws(() => manifestHash(new Uint8Array(33).fill(1)), MalformedInputError);
  });

  test('a forged all-zero hash writes nothing and fails at the encoder', () => {
    const writer = new CanonicalWriter();
    assert.throws(
      () => encodeManifestHash(writer, new Uint8Array(HASH_BYTE_LENGTH) as ManifestHash),
      MalformedInputError,
    );
    assert.equal(writer.bytes().length, 0);
  });

  test('a hex string is constructor input only and never reaches the wire', () => {
    const forged: unknown[] = [
      ASSET_MANIFEST,
      `0x${ASSET_MANIFEST}`,
      Array.from(manifestHash(ASSET_MANIFEST)),
    ];
    for (const value of forged) {
      const writer = new CanonicalWriter();
      assert.throws(
        () => encodeManifestHash(writer, value as ManifestHash),
        MalformedInputError,
      );
      assert.equal(writer.bytes().length, 0);
    }
  });
});

describe('protocol identifiers are bounded ascii', () => {
  test('accepts one byte and exactly the maximum', () => {
    assert.equal(protocolId('a'), 'a');
    const longest = 'a'.repeat(PROTOCOL_ID_MAX_BYTES);
    assert.equal(protocolId(longest), longest);
  });

  test('rejects empty and one byte past the maximum', () => {
    assert.throws(() => protocolId(''), MalformedInputError);
    assert.throws(() => protocolId('a'.repeat(PROTOCOL_ID_MAX_BYTES + 1)), RangeViolationError);
  });

  test('rejects non-ascii rather than truncating or normalizing it', () => {
    assert.throws(() => protocolId(`usdc${E_ACUTE}`), MalformedInputError);
    assert.throws(() => protocolId(`usdc${COMBINING_ACUTE}`), MalformedInputError);
    assert.throws(() => protocolId(`usdc${ROCKET}`), MalformedInputError);
  });

  test('a short non-ascii identifier fails on the character, not on its byte length', () => {
    assert.throws(() => protocolId(E_ACUTE.repeat(2)), MalformedInputError);
  });

  test('rejects a non-string', () => {
    assert.throws(() => protocolId(42 as unknown as string), MalformedInputError);
    assert.throws(() => protocolId(null as unknown as string), MalformedInputError);
  });

  test('encodes behind a u32 byte-length prefix', () => {
    const writer = new CanonicalWriter();
    encodeProtocolId(writer, protocolId('naryx'));
    assert.equal(toHex(writer.bytes()), '000000056e61727978');
  });

  test('a forged identifier writes nothing and fails at the encoder', () => {
    const forged: unknown[] = ['', 'a'.repeat(PROTOCOL_ID_MAX_BYTES + 1), E_ACUTE, 42];
    for (const value of forged) {
      const writer = new CanonicalWriter();
      assert.throws(() => encodeProtocolId(writer, value as ProtocolId));
      assert.equal(writer.bytes().length, 0);
    }
  });
});

describe('named identifier factories share the protocol identifier rules', () => {
  test('accept a canonical domain-qualified identifier', () => {
    assert.equal(domainId(CARRY_V1), CARRY_V1);
    assert.equal(assetId(USDC), USDC);
    assert.equal(
      assetId('eip155:8453/erc20:0x0000000000000000000000000000000000000000'),
      'eip155:8453/erc20:0x0000000000000000000000000000000000000000',
    );
  });

  test('reject empty, oversized, and ill-formed input', () => {
    assert.throws(() => domainId(''), MalformedInputError);
    assert.throws(() => assetId(''), MalformedInputError);
    assert.throws(() => assetId(`usd${LONE_HIGH_SURROGATE}c`), MalformedInputError);
    assert.throws(() => domainId('a'.repeat(PROTOCOL_ID_MAX_BYTES + 1)), RangeViolationError);
  });
});

describe('versioned manifest reference binds subject, version, and hash', () => {
  test('accepts version one and the u32 maximum', () => {
    assert.equal(versionedManifestRef(CARRY_V1, 1, TEMPLATE_MANIFEST).manifestVersion, 1);
    assert.equal(
      versionedManifestRef(CARRY_V1, 0xffffffff, TEMPLATE_MANIFEST).manifestVersion,
      0xffffffff,
    );
  });

  test('rejects a zero version', () => {
    assert.throws(() => versionedManifestRef(CARRY_V1, 0, TEMPLATE_MANIFEST), MalformedInputError);
  });

  test('rejects a version outside u32 and a non-integer version', () => {
    assert.throws(
      () => versionedManifestRef(CARRY_V1, 0x100000000, TEMPLATE_MANIFEST),
      RangeViolationError,
    );
    assert.throws(() => versionedManifestRef(CARRY_V1, -1, TEMPLATE_MANIFEST), RangeViolationError);
    assert.throws(
      () => versionedManifestRef(CARRY_V1, 1.5, TEMPLATE_MANIFEST),
      MalformedInputError,
    );
  });

  test('rejects an all-zero manifest hash and an empty subject', () => {
    assert.throws(() => versionedManifestRef(CARRY_V1, 1, ZERO_DIGEST), MalformedInputError);
    assert.throws(() => versionedManifestRef('', 1, TEMPLATE_MANIFEST), MalformedInputError);
  });

  test('encodes subject, version, and hash in exactly that order', () => {
    const writer = new CanonicalWriter();
    encodeVersionedManifestRef(writer, versionedManifestRef('naryx', 2, TEMPLATE_MANIFEST));
    assert.equal(toHex(writer.bytes()), `000000056e6172797800000002${TEMPLATE_MANIFEST}`);
  });

  test('is frozen once constructed', () => {
    assert.equal(Object.isFrozen(versionedManifestRef(CARRY_V1, 1, TEMPLATE_MANIFEST)), true);
  });

  test('mutating the hash it hands out changes neither its identity nor its encoding', () => {
    const reference = versionedManifestRef(CARRY_V1, 1, TEMPLATE_MANIFEST);
    const before = new CanonicalWriter();
    encodeVersionedManifestRef(before, reference);
    reference.manifestHash[0] = 0xff;
    const after = new CanonicalWriter();
    encodeVersionedManifestRef(after, reference);
    assert.equal(toHex(reference.manifestHash), TEMPLATE_MANIFEST);
    assert.equal(toHex(after.bytes()), toHex(before.bytes()));
  });
});

describe('domain reference binds chain identity to immutable domain semantics', () => {
  test('encodes domain id, version, and hash in exactly that order', () => {
    const writer = new CanonicalWriter();
    encodeDomainRef(writer, domainRef('naryx', 2, DOMAIN_MANIFEST));
    assert.equal(toHex(writer.bytes()), `000000056e6172797800000002${DOMAIN_MANIFEST}`);
  });

  test('accepts version one and the u32 maximum', () => {
    assert.equal(domainRef(BASE_DOMAIN, 1, DOMAIN_MANIFEST).domainManifestVersion, 1);
    assert.equal(
      domainRef(BASE_DOMAIN, 0xffffffff, DOMAIN_MANIFEST).domainManifestVersion,
      0xffffffff,
    );
  });

  test('rejects a zero, out-of-range, or non-integer version', () => {
    assert.throws(() => domainRef(BASE_DOMAIN, 0, DOMAIN_MANIFEST), MalformedInputError);
    assert.throws(() => domainRef(BASE_DOMAIN, 0x100000000, DOMAIN_MANIFEST), RangeViolationError);
    assert.throws(() => domainRef(BASE_DOMAIN, -1, DOMAIN_MANIFEST), RangeViolationError);
    assert.throws(() => domainRef(BASE_DOMAIN, 1.5, DOMAIN_MANIFEST), MalformedInputError);
  });

  test('rejects an empty, oversized, or non-ascii domain identifier', () => {
    assert.throws(() => domainRef('', 1, DOMAIN_MANIFEST), MalformedInputError);
    assert.throws(
      () => domainRef('a'.repeat(PROTOCOL_ID_MAX_BYTES + 1), 1, DOMAIN_MANIFEST),
      RangeViolationError,
    );
    assert.throws(
      () => domainRef(`eip155:8453:${E_ACUTE}`, 1, DOMAIN_MANIFEST),
      MalformedInputError,
    );
  });

  test('rejects an all-zero domain manifest hash', () => {
    assert.throws(() => domainRef(BASE_DOMAIN, 1, ZERO_DIGEST), MalformedInputError);
  });

  test('mutating the hash it hands out changes neither its identity nor its encoding', () => {
    const reference = domainRef(BASE_DOMAIN, 1, DOMAIN_MANIFEST);
    const before = new CanonicalWriter();
    encodeDomainRef(before, reference);
    reference.domainManifestHash[0] = 0xff;
    const after = new CanonicalWriter();
    encodeDomainRef(after, reference);
    assert.equal(Object.isFrozen(reference), true);
    assert.equal(toHex(reference.domainManifestHash), DOMAIN_MANIFEST);
    assert.equal(toHex(after.bytes()), toHex(before.bytes()));
  });
});

describe('asset reference binds identity, manifest hash, and decimals', () => {
  test('encodes asset id, manifest hash, and decimals in exactly that order', () => {
    const writer = new CanonicalWriter();
    encodeAssetRef(writer, assetRef('naryx', ASSET_MANIFEST, 6));
    assert.equal(toHex(writer.bytes()), `000000056e61727978${ASSET_MANIFEST}06`);
  });

  test('accepts the decimals boundaries and rejects one step past each', () => {
    assert.equal(assetRef(USDC, ASSET_MANIFEST, 0).decimals, 0);
    assert.equal(assetRef(USDC, ASSET_MANIFEST, 255).decimals, 255);
    assert.throws(() => assetRef(USDC, ASSET_MANIFEST, 256), RangeViolationError);
    assert.throws(() => assetRef(USDC, ASSET_MANIFEST, -1), RangeViolationError);
  });

  test('rejects an all-zero asset manifest hash', () => {
    assert.throws(() => assetRef(USDC, ZERO_DIGEST, 6), MalformedInputError);
  });

  test('copies the manifest hash so it cannot be mutated through the caller', () => {
    const source = new Uint8Array(HASH_BYTE_LENGTH).fill(7);
    const reference = assetRef(USDC, source, 6);
    source[0] = 0xff;
    assert.equal(toHex(reference.assetManifestHash).startsWith('07'), true);
  });

  test('is frozen once constructed', () => {
    assert.equal(Object.isFrozen(usdc()), true);
  });

  test('mutating the hash it hands out changes neither its identity nor its encoding', () => {
    const reference = usdc();
    const before = new CanonicalWriter();
    encodeAssetRef(before, reference);
    reference.assetManifestHash[0] = 0xff;
    const after = new CanonicalWriter();
    encodeAssetRef(after, reference);
    assert.equal(toHex(reference.assetManifestHash), ASSET_MANIFEST);
    assert.equal(toHex(after.bytes()), toHex(before.bytes()));
  });
});

describe('asset amount binds the exact registered asset version', () => {
  test('accepts a negative atom amount', () => {
    const amount = assetAmount(usdc(), -1500000n);
    assert.equal(amount.asset.assetId, USDC);
    assert.equal(toHex(amount.asset.assetManifestHash), ASSET_MANIFEST);
    assert.equal(amount.asset.decimals, 6);
    assert.equal(amount.atoms, -1500000n);
  });

  test('rejects a number atom amount rather than coercing it', () => {
    assert.throws(() => assetAmount(usdc(), 1500000 as unknown as bigint), MalformedInputError);
  });

  test('accepts the signed atom boundaries and rejects one step past each', () => {
    const min = -(1n << BigInt(ASSET_ATOM_BITS - 1));
    const max = (1n << BigInt(ASSET_ATOM_BITS - 1)) - 1n;
    assert.equal(assetAmount(usdc(), min).atoms, min);
    assert.equal(assetAmount(usdc(), max).atoms, max);
    assert.throws(() => assetAmount(usdc(), min - 1n), RangeViolationError);
    assert.throws(() => assetAmount(usdc(), max + 1n), RangeViolationError);
  });

  test('two amounts of the same asset under different manifest hashes encode differently', () => {
    const current = new CanonicalWriter();
    const superseded = new CanonicalWriter();
    encodeAssetAmount(current, assetAmount(assetRef(USDC, ASSET_MANIFEST, 6), 1n));
    encodeAssetAmount(superseded, assetAmount(assetRef(USDC, TEMPLATE_MANIFEST, 6), 1n));
    assert.notEqual(toHex(current.bytes()), toHex(superseded.bytes()));
  });

  test('is frozen once constructed', () => {
    assert.equal(Object.isFrozen(assetAmount(usdc(), 1n)), true);
  });

  test('mutation reached through asset cannot change the amount encoding', () => {
    const amount = assetAmount(usdc(), 1n);
    const before = new CanonicalWriter();
    encodeAssetAmount(before, amount);
    amount.asset.assetManifestHash[0] = 0xff;
    const after = new CanonicalWriter();
    encodeAssetAmount(after, amount);
    assert.equal(toHex(amount.asset.assetManifestHash), ASSET_MANIFEST);
    assert.equal(toHex(after.bytes()), toHex(before.bytes()));
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
    const slot = expiry('SOLANA_SLOT', 1000n);
    const seconds = expiry('EVM_UNIX_SECONDS', 1000n);
    const milliseconds = expiry('HYPERLIQUID_UNIX_MILLISECONDS', 1000n);
    assert.throws(() => compareExpiry(slot, seconds), IncompatibleUnitError);
    assert.throws(() => compareExpiry(seconds, milliseconds), IncompatibleUnitError);
    assert.throws(() => compareExpiry(milliseconds, slot), IncompatibleUnitError);
  });

  test('every declared unit is comparable with itself only', () => {
    for (const unit of Object.keys(EXPIRY_UNIT) as (keyof typeof EXPIRY_UNIT)[]) {
      assert.equal(compareExpiry(expiry(unit, 5n), expiry(unit, 5n)), 0);
    }
  });
});

describe('forged runtime objects are revalidated at the encoder boundary', () => {
  const forgedRef = (fields: Record<string, unknown>): AssetRef =>
    ({
      assetId: USDC,
      assetManifestHash: hash32(ASSET_MANIFEST),
      decimals: 6,
      ...fields,
    }) as unknown as AssetRef;

  const forgedAmount = (fields: Record<string, unknown>): AssetAmount =>
    ({ asset: usdc(), atoms: 1n, ...fields }) as unknown as AssetAmount;

  const forgedManifestRef = (fields: Record<string, unknown>): VersionedManifestRef =>
    ({
      subjectId: CARRY_V1,
      manifestVersion: 1,
      manifestHash: hash32(TEMPLATE_MANIFEST),
      ...fields,
    }) as unknown as VersionedManifestRef;

  const forgedDomainRef = (fields: Record<string, unknown>): DomainRef =>
    ({
      domainId: BASE_DOMAIN,
      domainManifestVersion: 1,
      domainManifestHash: hash32(DOMAIN_MANIFEST),
      ...fields,
    }) as unknown as DomainRef;

  const forgedExpiry = (fields: Record<string, unknown>): Expiry =>
    ({ unit: 'EVM_UNIX_SECONDS', value: 1n, ...fields }) as unknown as Expiry;

  test('an empty asset identifier writes nothing and fails', () => {
    const writer = new CanonicalWriter();
    assert.throws(
      () => encodeAssetAmount(writer, forgedAmount({ asset: forgedRef({ assetId: '' }) })),
      MalformedInputError,
    );
    assert.equal(writer.bytes().length, 0);
  });

  test('an ill-formed, non-ascii, oversized, or non-string asset identifier is rejected', () => {
    const identifiers: unknown[] = [
      `usd${LONE_HIGH_SURROGATE}`,
      `usdc${E_ACUTE}`,
      'a'.repeat(PROTOCOL_ID_MAX_BYTES + 1),
      42,
    ];
    for (const forged of identifiers) {
      assert.throws(() =>
        encodeAssetRef(new CanonicalWriter(), forgedRef({ assetId: forged })),
      );
    }
  });

  test('an all-zero or wrong-length asset manifest hash is rejected at encode time', () => {
    const writer = new CanonicalWriter();
    assert.throws(
      () =>
        encodeAssetAmount(
          writer,
          forgedAmount({
            asset: forgedRef({ assetManifestHash: new Uint8Array(HASH_BYTE_LENGTH) }),
          }),
        ),
      MalformedInputError,
    );
    assert.equal(writer.bytes().length, 0);
    assert.throws(
      () =>
        encodeAssetRef(
          new CanonicalWriter(),
          forgedRef({ assetManifestHash: new Uint8Array(31).fill(1) }),
        ),
      MalformedInputError,
    );
  });

  test('decimals outside u8 are rejected at encode time', () => {
    assert.throws(
      () => encodeAssetRef(new CanonicalWriter(), forgedRef({ decimals: 256 })),
      RangeViolationError,
    );
    assert.throws(
      () => encodeAssetRef(new CanonicalWriter(), forgedRef({ decimals: -1 })),
      RangeViolationError,
    );
    assert.throws(
      () => encodeAssetRef(new CanonicalWriter(), forgedRef({ decimals: 1.5 })),
      MalformedInputError,
    );
  });

  test('atoms outside i128 or not a bigint are rejected at encode time', () => {
    const max = (1n << BigInt(ASSET_ATOM_BITS - 1)) - 1n;
    assert.throws(
      () => encodeAssetAmount(new CanonicalWriter(), forgedAmount({ atoms: max + 1n })),
      RangeViolationError,
    );
    assert.throws(
      () => encodeAssetAmount(new CanonicalWriter(), forgedAmount({ atoms: 1 })),
      MalformedInputError,
    );
  });

  test('a non-object asset amount or asset reference is rejected', () => {
    assert.throws(
      () => encodeAssetAmount(new CanonicalWriter(), null as unknown as AssetAmount),
      MalformedInputError,
    );
    assert.throws(
      () => encodeAssetAmount(new CanonicalWriter(), forgedAmount({ asset: USDC })),
      MalformedInputError,
    );
    assert.throws(
      () => encodeAssetRef(new CanonicalWriter(), undefined as unknown as AssetRef),
      MalformedInputError,
    );
  });

  test('a zero or out-of-range manifest version writes nothing and fails', () => {
    for (const version of [0, 0x100000000, -1, 1.5]) {
      const writer = new CanonicalWriter();
      assert.throws(() =>
        encodeVersionedManifestRef(writer, forgedManifestRef({ manifestVersion: version })),
      );
      assert.equal(writer.bytes().length, 0);
    }
  });

  test('a hex string hash on a forged reference writes nothing and fails', () => {
    const assetWriter = new CanonicalWriter();
    assert.throws(
      () => encodeAssetRef(assetWriter, forgedRef({ assetManifestHash: ASSET_MANIFEST })),
      MalformedInputError,
    );
    assert.equal(assetWriter.bytes().length, 0);
    const manifestWriter = new CanonicalWriter();
    assert.throws(
      () =>
        encodeVersionedManifestRef(
          manifestWriter,
          forgedManifestRef({ manifestHash: TEMPLATE_MANIFEST }),
        ),
      MalformedInputError,
    );
    assert.equal(manifestWriter.bytes().length, 0);
  });

  test('an all-zero manifest hash on a reference is rejected at encode time', () => {
    assert.throws(
      () =>
        encodeVersionedManifestRef(
          new CanonicalWriter(),
          forgedManifestRef({ manifestHash: new Uint8Array(HASH_BYTE_LENGTH) }),
        ),
      MalformedInputError,
    );
  });

  test('a forged subject identifier or non-object reference is rejected', () => {
    assert.throws(
      () => encodeVersionedManifestRef(new CanonicalWriter(), forgedManifestRef({ subjectId: '' })),
      MalformedInputError,
    );
    assert.throws(
      () =>
        encodeVersionedManifestRef(
          new CanonicalWriter(),
          forgedManifestRef({ subjectId: 'a'.repeat(PROTOCOL_ID_MAX_BYTES + 1) }),
        ),
      RangeViolationError,
    );
    assert.throws(
      () => encodeVersionedManifestRef(new CanonicalWriter(), null as unknown as VersionedManifestRef),
      MalformedInputError,
    );
  });

  test('a hex string, all-zero, or wrong-length domain manifest hash writes nothing and fails', () => {
    for (const forged of [
      DOMAIN_MANIFEST,
      new Uint8Array(HASH_BYTE_LENGTH),
      new Uint8Array(HASH_BYTE_LENGTH - 1),
    ]) {
      const writer = new CanonicalWriter();
      assert.throws(
        () => encodeDomainRef(writer, forgedDomainRef({ domainManifestHash: forged })),
        MalformedInputError,
      );
      assert.equal(writer.bytes().length, 0);
    }
  });

  test('a zero or out-of-range domain manifest version writes nothing and fails', () => {
    for (const version of [0, 0x100000000, -1, 1.5]) {
      const writer = new CanonicalWriter();
      assert.throws(() =>
        encodeDomainRef(writer, forgedDomainRef({ domainManifestVersion: version })),
      );
      assert.equal(writer.bytes().length, 0);
    }
  });

  test('a forged domain identifier or non-object domain reference writes nothing and fails', () => {
    for (const id of ['', 'a'.repeat(PROTOCOL_ID_MAX_BYTES + 1), ROCKET, 7]) {
      const writer = new CanonicalWriter();
      assert.throws(() => encodeDomainRef(writer, forgedDomainRef({ domainId: id })));
      assert.equal(writer.bytes().length, 0);
    }
    const writer = new CanonicalWriter();
    assert.throws(
      () => encodeDomainRef(writer, null as unknown as DomainRef),
      MalformedInputError,
    );
    assert.equal(writer.bytes().length, 0);
  });

  test('an unknown expiry unit writes nothing and fails', () => {
    const writer = new CanonicalWriter();
    assert.throws(
      () => encodeExpiry(writer, forgedExpiry({ unit: 'UNIX_NANOSECONDS' })),
      MalformedInputError,
    );
    assert.equal(writer.bytes().length, 0);
  });

  test('a non-bigint or out-of-range expiry value is rejected at encode time', () => {
    assert.throws(
      () => encodeExpiry(new CanonicalWriter(), forgedExpiry({ value: 1700000000 })),
      MalformedInputError,
    );
    assert.throws(
      () => encodeExpiry(new CanonicalWriter(), forgedExpiry({ value: 1n << 64n })),
      RangeViolationError,
    );
    assert.throws(
      () => encodeExpiry(new CanonicalWriter(), forgedExpiry({ value: -1n })),
      RangeViolationError,
    );
  });

  test('comparison rejects a forged unit on either side', () => {
    const valid = expiry('EVM_UNIX_SECONDS', 1n);
    assert.throws(
      () => compareExpiry(forgedExpiry({ unit: 'UNIX_NANOSECONDS' }), valid),
      MalformedInputError,
    );
    assert.throws(
      () => compareExpiry(valid, forgedExpiry({ unit: 'UNIX_NANOSECONDS' })),
      MalformedInputError,
    );
    assert.throws(
      () =>
        compareExpiry(
          forgedExpiry({ unit: 'UNIX_NANOSECONDS' }),
          forgedExpiry({ unit: 'UNIX_NANOSECONDS', value: 2n }),
        ),
      MalformedInputError,
    );
  });

  test('comparison rejects a forged value on either side', () => {
    const valid = expiry('EVM_UNIX_SECONDS', 1n);
    assert.throws(() => compareExpiry(forgedExpiry({ value: 1.5 }), valid), MalformedInputError);
    assert.throws(() => compareExpiry(valid, forgedExpiry({ value: 2 })), MalformedInputError);
    assert.throws(
      () => compareExpiry(valid, forgedExpiry({ value: 1n << 64n })),
      RangeViolationError,
    );
  });

  test('a non-object expiry is rejected', () => {
    const valid = expiry('EVM_UNIX_SECONDS', 1n);
    assert.throws(
      () => compareExpiry(null as unknown as Expiry, valid),
      MalformedInputError,
    );
    assert.throws(
      () => encodeExpiry(new CanonicalWriter(), undefined as unknown as Expiry),
      MalformedInputError,
    );
  });
});
