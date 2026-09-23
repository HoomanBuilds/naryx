import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  domainRef,
  encodeMarketManifest,
  fromHex,
  marketManifest,
  marketManifestBytes,
  marketManifestHash,
  toHex,
  type MarketManifest,
  type MarketManifestInput,
} from '../src/index.js';
import { loadFixture, type MarketManifestFixture } from './fixtures.js';

const fixture = loadFixture<MarketManifestFixture>('market-manifest.json');
const U128_MAX = (1n << 128n) - 1n;

function fixtureInput(overrides: Partial<MarketManifestInput> = {}): MarketManifestInput {
  return {
    manifestVersion: Number(fixture.manifestVersion),
    environment: fixture.environment,
    marketId: fixture.marketId,
    domain: domainRef(
      fixture.domain.domainId,
      Number(fixture.domain.domainManifestVersion),
      fixture.domain.domainManifestHash,
    ),
    venueId: fixture.venueId,
    venueManifestHash: fixture.venueManifestHash,
    marketIdentity: fixture.marketIdentity,
    instrumentKind: fixture.instrumentKind,
    baseAssetId: fixture.baseAssetId,
    baseAssetManifestHash: fixture.baseAssetManifestHash,
    quoteAssetId: fixture.quoteAssetId,
    quoteAssetManifestHash: fixture.quoteAssetManifestHash,
    baseLotSize: {
      ...fixture.baseLotSize,
      atoms: BigInt(fixture.baseLotSize.atoms),
    },
    priceTick: {
      ...fixture.priceTick,
      quoteAtoms: BigInt(fixture.priceTick.quoteAtoms),
      baseLotCount: BigInt(fixture.priceTick.baseLotCount),
    },
    minimumNotional: {
      ...fixture.minimumNotional,
      atoms: BigInt(fixture.minimumNotional.atoms),
    },
    contractMultiplier: {
      ...fixture.contractMultiplier,
      numerator: BigInt(fixture.contractMultiplier.numerator),
      denominator: BigInt(fixture.contractMultiplier.denominator),
    },
    permittedPriceSources: fixture.permittedPriceSources.map((source) => ({ ...source })),
    ...overrides,
  };
}

describe('market manifest canonical identity', () => {
  test('canonical bytes and domain-separated digest match the golden vector', () => {
    assert.equal(toHex(marketManifestBytes(fixtureInput())), fixture.canonicalHex);
    assert.equal(toHex(marketManifestHash(fixtureInput())), fixture.digestHex);
  });

  test('price sources sort by full canonical tuple and reject exact duplicates', () => {
    const reversed = [...fixture.permittedPriceSources].reverse();
    const canonical = marketManifest(fixtureInput({ permittedPriceSources: reversed }));

    assert.deepEqual(
      canonical.permittedPriceSources.map((source) => source.priceSourceId),
      fixture.permittedPriceSources.map((source) => source.priceSourceId),
    );
    assert.equal(toHex(marketManifestBytes(fixtureInput({ permittedPriceSources: reversed }))), fixture.canonicalHex);
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({
            permittedPriceSources: [
              fixture.permittedPriceSources[0]!,
              fixture.permittedPriceSources[0]!,
            ],
          }),
      ),
      DuplicateElementError,
    );
    assert.throws(
      () => marketManifest(fixtureInput({ permittedPriceSources: [] })),
      MalformedInputError,
    );
  });

  test('a single identity field mutation produces a different digest', () => {
    assert.notEqual(
      toHex(marketManifestHash(fixtureInput({ marketIdentity: 'market-account-v2' }))),
      fixture.digestHex,
    );
  });
});

describe('market manifest exact units and consistency', () => {
  test('u32, u8, and u128 boundaries require their exact runtime types', () => {
    const boundary = marketManifest(
      fixtureInput({
        baseLotSize: { ...fixtureInput().baseLotSize, atoms: U128_MAX },
        minimumNotional: { ...fixtureInput().minimumNotional, atoms: 0n },
        contractMultiplier: {
          ...fixtureInput().contractMultiplier,
          numerator: U128_MAX,
          denominator: 1n,
        },
      }),
    );
    assert.equal(boundary.baseLotSize.atoms, U128_MAX);
    assert.equal(boundary.minimumNotional.atoms, 0n);

    assert.throws(() => marketManifest(fixtureInput({ manifestVersion: 0 })), MalformedInputError);
    assert.throws(
      () => marketManifest(fixtureInput({ manifestVersion: 0x1_0000_0000 })),
      RangeViolationError,
    );
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({ baseLotSize: { ...fixtureInput().baseLotSize, atoms: 0n } }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({ priceTick: { ...fixtureInput().priceTick, quoteAtoms: 1n << 128n } }),
        ),
      RangeViolationError,
    );
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({
            minimumNotional: { ...fixtureInput().minimumNotional, atoms: -1n },
          }),
        ),
      RangeViolationError,
    );
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({
            priceTick: {
              ...fixtureInput().priceTick,
              baseLotCount: 1 as unknown as bigint,
            },
          }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({
            priceTick: {
              ...fixtureInput().priceTick,
              quoteDecimals: 6n as unknown as number,
            },
          }),
        ),
      MalformedInputError,
    );
  });

  test('the contract multiplier is positive and reduced', () => {
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({
            contractMultiplier: {
              ...fixtureInput().contractMultiplier,
              numerator: 2n,
              denominator: 4n,
            },
          }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({
            contractMultiplier: {
              ...fixtureInput().contractMultiplier,
              denominator: 0n,
            },
          }),
        ),
      MalformedInputError,
    );
  });

  test('nested unit identities and quote decimals must match top-level assets', () => {
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({
            baseLotSize: { ...fixtureInput().baseLotSize, baseAssetId: 'other-asset' },
          }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({
            baseLotSize: {
              ...fixtureInput().baseLotSize,
              baseAssetManifestHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({
            priceTick: { ...fixtureInput().priceTick, quoteAssetId: 'other-asset' },
          }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({
            minimumNotional: {
              ...fixtureInput().minimumNotional,
              quoteAssetManifestHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        marketManifest(
          fixtureInput({
            minimumNotional: { ...fixtureInput().minimumNotional, quoteDecimals: 5 },
          }),
        ),
      MalformedInputError,
    );
  });
});

describe('market manifest defensive encoding', () => {
  test('hash, nested object, and array mutation cannot change later encoding', () => {
    const venueHash = fromHex(fixture.venueManifestHash);
    const baseHash = fromHex(fixture.baseAssetManifestHash);
    const quoteHash = fromHex(fixture.quoteAssetManifestHash);
    const sourceHash = fromHex(fixture.permittedPriceSources[0]!.priceSourceManifestHash);
    const sources = [
      {
        priceSourceId: fixture.permittedPriceSources[0]!.priceSourceId,
        priceSourceManifestHash: sourceHash,
      },
      fixture.permittedPriceSources[1]!,
    ];
    const manifest = marketManifest(
      fixtureInput({
        venueManifestHash: venueHash,
        baseAssetManifestHash: baseHash,
        quoteAssetManifestHash: quoteHash,
        baseLotSize: {
          ...fixtureInput().baseLotSize,
          baseAssetManifestHash: baseHash,
        },
        priceTick: {
          ...fixtureInput().priceTick,
          quoteAssetManifestHash: quoteHash,
        },
        minimumNotional: {
          ...fixtureInput().minimumNotional,
          quoteAssetManifestHash: quoteHash,
        },
        permittedPriceSources: sources,
      }),
    );
    const before = toHex(marketManifestBytes(manifest));

    venueHash[0] = 0xff;
    baseHash[0] = 0xff;
    quoteHash[0] = 0xff;
    sourceHash[0] = 0xff;
    manifest.baseLotSize.baseAssetManifestHash[0] = 0xff;
    manifest.permittedPriceSources[0]!.priceSourceManifestHash[0] = 0xff;
    sources.pop();

    assert.equal(Object.isFrozen(manifest), true);
    assert.equal(Object.isFrozen(manifest.baseLotSize), true);
    assert.equal(Object.isFrozen(manifest.priceTick), true);
    assert.equal(Object.isFrozen(manifest.minimumNotional), true);
    assert.equal(Object.isFrozen(manifest.contractMultiplier), true);
    assert.equal(Object.isFrozen(manifest.permittedPriceSources), true);
    assert.equal(toHex(marketManifestBytes(manifest)), before);

    const digest = marketManifestHash(manifest);
    digest[0] = 0xff;
    assert.equal(toHex(marketManifestHash(manifest)), fixture.digestHex);
  });

  test('forged string and all-zero hashes fail before any byte is written', () => {
    const manifest = marketManifest(fixtureInput());
    const stringWriter = new CanonicalWriter();
    const forgedString = {
      ...manifest,
      venueManifestHash: fixture.venueManifestHash,
    } as unknown as MarketManifest;
    assert.throws(
      () => encodeMarketManifest(stringWriter, forgedString),
      MalformedInputError,
    );
    assert.equal(stringWriter.bytes().length, 0);

    const zeroWriter = new CanonicalWriter();
    const forgedZero = {
      ...manifest,
      baseLotSize: {
        ...manifest.baseLotSize,
        baseAssetManifestHash: new Uint8Array(32),
      },
    } as MarketManifest;
    assert.throws(() => encodeMarketManifest(zeroWriter, forgedZero), MalformedInputError);
    assert.equal(zeroWriter.bytes().length, 0);
  });
});
