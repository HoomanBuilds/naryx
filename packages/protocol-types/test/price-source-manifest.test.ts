import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  MalformedInputError,
  RangeViolationError,
  duration,
  encodeDuration,
  encodePriceSourceManifest,
  fromHex,
  priceSourceManifest,
  priceSourceManifestBytes,
  priceSourceManifestHash,
  toHex,
  type DomainRef,
  type Duration,
  type DurationUnit,
  type ManifestHash,
  type PriceSourceManifest,
  type PriceSourceManifestInput,
} from '../src/index.js';
import { loadFixture, type PriceSourceManifestFixture } from './fixtures.js';

const fixture = loadFixture<PriceSourceManifestFixture>('price-source-manifest.json');

function fixtureDomain(hash: Uint8Array | string = fixture.domain.domainManifestHash): DomainRef {
  return {
    domainId: fixture.domain.domainId,
    domainManifestVersion: Number(fixture.domain.domainManifestVersion),
    domainManifestHash: hash,
  } as unknown as DomainRef;
}

function fixtureDuration(value = BigInt(fixture.maxStaleness.value)): Duration {
  return {
    unit: fixture.maxStaleness.unit as DurationUnit,
    value,
  };
}

function fixtureInput(
  overrides: Partial<PriceSourceManifestInput> = {},
): PriceSourceManifestInput {
  return {
    manifestVersion: Number(fixture.manifestVersion),
    environment: fixture.environment,
    priceSourceId: fixture.priceSourceId,
    domain: fixtureDomain(fromHex(fixture.domain.domainManifestHash)),
    sourceKind: fixture.sourceKind,
    feedIdentity: fixture.feedIdentity,
    priceDecimals: fixture.priceDecimals,
    priceConvention: fixture.priceConvention,
    maxStaleness: fixtureDuration(),
    fallbackRule: fixture.fallbackRule,
    ...overrides,
  };
}

describe('duration identity', () => {
  test('milliseconds encode as one enum byte followed by a positive u64', () => {
    const writer = new CanonicalWriter();
    encodeDuration(writer, duration('MILLISECONDS', 1500n));
    assert.equal(toHex(writer.bytes()), '0100000000000005dc');
  });

  test('zero, overflow, non-bigint values, and forged units fail closed', () => {
    assert.throws(() => duration('MILLISECONDS', 0n), MalformedInputError);
    assert.throws(() => duration('MILLISECONDS', 1n << 64n), RangeViolationError);
    assert.throws(
      () => duration('MILLISECONDS', 1 as unknown as bigint),
      MalformedInputError,
    );
    assert.throws(
      () => duration('SECONDS' as unknown as DurationUnit, 1n),
      MalformedInputError,
    );

    const writer = new CanonicalWriter();
    assert.throws(
      () => encodeDuration(writer, { unit: 'MILLISECONDS', value: 1 } as unknown as Duration),
      MalformedInputError,
    );
    assert.equal(writer.bytes().length, 0);
  });
});

describe('price source manifest canonical identity', () => {
  test('canonical bytes and domain-separated digest match the golden vector', () => {
    const manifest = priceSourceManifest(fixtureInput());
    assert.equal(manifest.maxStaleness.unit, 'MILLISECONDS');
    assert.equal(manifest.maxStaleness.value, 1500n);
    assert.equal(manifest.fallbackRule, 'no-fallback-v1');
    assert.equal(toHex(priceSourceManifestBytes(manifest)), fixture.canonicalHex);
    assert.equal(toHex(priceSourceManifestHash(manifest)), fixture.digestHex);
  });

  test('a single field mutation produces a different identity', () => {
    const changed = priceSourceManifestHash(
      fixtureInput({ feedIdentity: 'feed-account-v2' }),
    );
    assert.notEqual(toHex(changed), fixture.digestHex);
  });
});

describe('price source manifest validation', () => {
  test('numeric bounds and identity fields fail closed', () => {
    assert.throws(
      () => priceSourceManifest(fixtureInput({ manifestVersion: 0 })),
      MalformedInputError,
    );
    assert.throws(
      () => priceSourceManifest(fixtureInput({ manifestVersion: 0x1_0000_0000 })),
      RangeViolationError,
    );
    assert.throws(
      () => priceSourceManifest(fixtureInput({ priceDecimals: 256 })),
      RangeViolationError,
    );
    assert.throws(
      () => priceSourceManifest(fixtureInput({ maxStaleness: fixtureDuration(0n) })),
      MalformedInputError,
    );
    assert.throws(
      () => priceSourceManifest(fixtureInput({ maxStaleness: fixtureDuration(1n << 64n) })),
      RangeViolationError,
    );
    assert.throws(
      () => priceSourceManifest(fixtureInput({ priceSourceId: '' })),
      MalformedInputError,
    );
    assert.throws(
      () => priceSourceManifest(fixtureInput({ feedIdentity: 'feed-π' })),
      MalformedInputError,
    );
    assert.throws(
      () => priceSourceManifest(fixtureInput({ fallbackRule: '' })),
      MalformedInputError,
    );
  });

  test('forged domain hashes and durations reject before the encoder writes', () => {
    const manifest = priceSourceManifest(fixtureInput());
    const forgedValues: PriceSourceManifest[] = [
      { ...manifest, domain: fixtureDomain() },
      {
        ...manifest,
        maxStaleness: {
          unit: 'MILLISECONDS',
          value: 1500,
        } as unknown as Duration,
      },
    ];

    for (const forged of forgedValues) {
      const writer = new CanonicalWriter();
      assert.throws(() => encodePriceSourceManifest(writer, forged), MalformedInputError);
      assert.equal(writer.bytes().length, 0);
    }
  });

  test('caller mutation cannot change nested identity or later encoding', () => {
    const sourceHash = fromHex(fixture.domain.domainManifestHash) as ManifestHash;
    const manifest = priceSourceManifest(
      fixtureInput({ domain: fixtureDomain(sourceHash), maxStaleness: fixtureDuration() }),
    );
    const before = toHex(priceSourceManifestBytes(manifest));

    sourceHash[0] = 0xff;
    manifest.domain.domainManifestHash[0] = 0xff;

    assert.equal(Object.isFrozen(manifest), true);
    assert.equal(Object.isFrozen(manifest.domain), true);
    assert.equal(Object.isFrozen(manifest.maxStaleness), true);
    assert.equal(toHex(manifest.domain.domainManifestHash), fixture.domain.domainManifestHash);
    assert.equal(toHex(priceSourceManifestBytes(manifest)), before);
  });
});
