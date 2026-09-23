import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  MalformedInputError,
  RangeViolationError,
  encodeVenueManifest,
  fromHex,
  toHex,
  venueManifest,
  venueManifestBytes,
  venueManifestHash,
  type DomainRef,
  type ManifestHash,
  type VenueManifest,
  type VenueManifestInput,
} from '../src/index.js';
import { loadFixture, type VenueManifestFixture } from './fixtures.js';

const fixture = loadFixture<VenueManifestFixture>('venue-manifest.json');

const MARKET_SPECIFIC_FIELDS = [
  'marketId',
  'marketIdentity',
  'baseAssetId',
  'quoteAssetId',
  'baseLotSize',
  'priceTick',
  'minimumNotional',
  'permittedPriceSources',
] as const;

type MarketSpecificField = (typeof MARKET_SPECIFIC_FIELDS)[number];
type AssertNever<T extends never> = T;
type VenueManifestHasNoMarketSpecificFields = AssertNever<
  Extract<keyof VenueManifest | keyof VenueManifestInput, MarketSpecificField>
>;

function fixtureDomain(hash: Uint8Array | string = fixture.domain.domainManifestHash): DomainRef {
  return {
    domainId: fixture.domain.domainId,
    domainManifestVersion: Number(fixture.domain.domainManifestVersion),
    domainManifestHash: hash,
  } as unknown as DomainRef;
}

function fixtureInput(overrides: Partial<VenueManifestInput> = {}): VenueManifestInput {
  return {
    manifestVersion: Number(fixture.manifestVersion),
    environment: fixture.environment,
    venueId: fixture.venueId,
    domain: fixtureDomain(fromHex(fixture.domain.domainManifestHash)),
    venueKind: fixture.venueKind,
    protocolIdentity: fixture.protocolIdentity,
    codeIdentity: fixture.codeIdentity,
    authorityIdentity: fixture.authorityIdentity,
    ...overrides,
  };
}

describe('venue manifest canonical identity', () => {
  test('canonical bytes and domain-separated digest match the golden vector', () => {
    assert.equal(toHex(venueManifestBytes(fixtureInput())), fixture.canonicalHex);
    assert.equal(toHex(venueManifestHash(fixtureInput())), fixture.digestHex);
  });

  test('a single field mutation produces a different identity', () => {
    const changed = venueManifestHash(
      fixtureInput({ authorityIdentity: 'governance-authority-v2' }),
    );
    assert.notEqual(toHex(changed), fixture.digestHex);
  });

  test('market-specific fields are absent and do not enter the identity', () => {
    const withMarketFields = {
      ...fixtureInput(),
      marketId: 'market-1',
      marketIdentity: 'market-identity-1',
      baseAssetId: 'asset-1',
      quoteAssetId: 'asset-2',
      baseLotSize: 1,
      priceTick: 1,
      minimumNotional: 1,
      permittedPriceSources: ['price-source-1'],
    };
    const manifest = venueManifest(withMarketFields);

    assert.equal(toHex(venueManifestHash(withMarketFields)), fixture.digestHex);
    for (const field of MARKET_SPECIFIC_FIELDS) {
      assert.equal(Object.hasOwn(manifest, field), false);
    }
  });
});

describe('venue manifest validation', () => {
  test('the manifest version is a nonzero u32', () => {
    assert.throws(() => venueManifest(fixtureInput({ manifestVersion: 0 })), MalformedInputError);
    assert.throws(
      () => venueManifest(fixtureInput({ manifestVersion: 0x1_0000_0000 })),
      RangeViolationError,
    );
    assert.throws(
      () => venueManifest(fixtureInput({ manifestVersion: 1n as unknown as number })),
      MalformedInputError,
    );
    assert.throws(
      () => venueManifest(null as unknown as VenueManifestInput),
      MalformedInputError,
    );
  });

  test('identifiers are nonempty bounded ascii', () => {
    assert.throws(() => venueManifest(fixtureInput({ venueId: '' })), MalformedInputError);
    assert.throws(
      () =>
        venueManifest(
          fixtureInput({ protocolIdentity: `protocol-${String.fromCharCode(0x03c0)}` }),
        ),
      MalformedInputError,
    );
  });

  test('invalid and forged domain reference hashes fail closed before encoding', () => {
    assert.throws(
      () => venueManifest(fixtureInput({ domain: fixtureDomain(new Uint8Array(32)) })),
      MalformedInputError,
    );
    assert.throws(
      () => venueManifest(fixtureInput({ domain: fixtureDomain(new Uint8Array(31).fill(1)) })),
      MalformedInputError,
    );
    assert.throws(
      () => venueManifest(fixtureInput({ domain: fixtureDomain() })),
      MalformedInputError,
    );

    const writer = new CanonicalWriter();
    const forged = {
      ...venueManifest(fixtureInput()),
      domain: fixtureDomain(),
    } as VenueManifest;
    assert.throws(() => encodeVenueManifest(writer, forged), MalformedInputError);
    assert.equal(writer.bytes().length, 0);
  });

  test('caller mutation cannot change the nested domain identity or later encoding', () => {
    const sourceHash = fromHex(fixture.domain.domainManifestHash) as ManifestHash;
    const manifest = venueManifest(fixtureInput({ domain: fixtureDomain(sourceHash) }));
    const before = toHex(venueManifestBytes(manifest));

    sourceHash[0] = 0xff;
    manifest.domain.domainManifestHash[0] = 0xff;

    assert.equal(Object.isFrozen(manifest), true);
    assert.equal(Object.isFrozen(manifest.domain), true);
    assert.equal(toHex(manifest.domain.domainManifestHash), fixture.domain.domainManifestHash);
    assert.equal(toHex(venueManifestBytes(manifest)), before);
  });

  test('mutating a returned digest cannot change a later digest', () => {
    const digest = venueManifestHash(fixtureInput());
    digest[0] = 0xff;
    assert.equal(toHex(venueManifestHash(fixtureInput())), fixture.digestHex);
  });
});
