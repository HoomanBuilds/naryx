import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  MalformedInputError,
  RangeViolationError,
  assetManifest,
  assetManifestBytes,
  assetManifestHash,
  assetRefFromManifest,
  domainRef,
  encodeAssetManifest,
  fromHex,
  toHex,
  type AssetManifest,
  type AssetManifestInput,
} from '../src/index.js';
import { loadFixture, type AssetManifestFixture } from './fixtures.js';

const fixture = loadFixture<AssetManifestFixture>('asset-manifest.json');

function fixtureInput(overrides: Partial<AssetManifestInput> = {}): AssetManifestInput {
  return {
    ...fixture,
    manifestVersion: Number(fixture.manifestVersion),
    domain: domainRef(
      fixture.domain.domainId,
      Number(fixture.domain.domainManifestVersion),
      fixture.domain.domainManifestHash,
    ),
    minimumTransferAtoms: BigInt(fixture.minimumTransferAtoms),
    ...overrides,
  };
}

describe('asset manifest canonical identity', () => {
  test('canonical bytes and domain-separated digest match the golden vector', () => {
    assert.equal(toHex(assetManifestBytes(fixtureInput())), fixture.canonicalHex);
    assert.equal(toHex(assetManifestHash(fixtureInput())), fixture.digestHex);
  });

  test('the derived reference binds asset identity, computed digest, and decimals', () => {
    const reference = assetRefFromManifest(fixtureInput());
    assert.equal(reference.assetId, fixture.assetId);
    assert.equal(toHex(reference.assetManifestHash), fixture.digestHex);
    assert.equal(reference.decimals, fixture.decimals);
  });

  test('a single field mutation produces a different identity', () => {
    const original = toHex(assetManifestHash(fixtureInput()));
    const changed = toHex(
      assetManifestHash(fixtureInput({ minimumTransferAtoms: 2n })),
    );
    assert.notEqual(changed, original);
  });
});

describe('asset manifest validation', () => {
  test('integer bounds and exact runtime types fail closed', () => {
    assert.throws(() => assetManifest(fixtureInput({ manifestVersion: 0 })), MalformedInputError);
    assert.throws(
      () => assetManifest(fixtureInput({ manifestVersion: 0x1_0000_0000 })),
      RangeViolationError,
    );
    assert.throws(
      () => assetManifest(fixtureInput({ decimals: 256 })),
      RangeViolationError,
    );
    assert.throws(
      () => assetManifest(fixtureInput({ decimals: 6n as unknown as number })),
      MalformedInputError,
    );
    assert.throws(
      () => assetManifest(fixtureInput({ minimumTransferAtoms: -1n })),
      RangeViolationError,
    );
    assert.throws(
      () => assetManifest(fixtureInput({ minimumTransferAtoms: 1n << 128n })),
      RangeViolationError,
    );
    assert.throws(
      () =>
        assetManifest(
          fixtureInput({ minimumTransferAtoms: 1 as unknown as bigint }),
        ),
      MalformedInputError,
    );
  });

  test('empty and non-ASCII identifiers fail closed', () => {
    assert.throws(() => assetManifest(fixtureInput({ environment: '' })), MalformedInputError);
    assert.throws(
      () =>
        assetManifest(
          fixtureInput({ assetId: `svm:test-domain-1:usd${String.fromCodePoint(0x03c0)}` }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () => assetManifest(fixtureInput({ transferSemantics: '' })),
      MalformedInputError,
    );
  });

  test('caller mutation cannot change later encoding', () => {
    const domainHash = fromHex(fixture.domain.domainManifestHash);
    const domain = domainRef(
      fixture.domain.domainId,
      Number(fixture.domain.domainManifestVersion),
      domainHash,
    );
    const manifest = assetManifest(fixtureInput({ domain }));
    const before = toHex(assetManifestBytes(manifest));

    domainHash[0] = 0xff;
    domain.domainManifestHash[0] = 0xff;
    manifest.domain.domainManifestHash[0] = 0xff;

    assert.equal(toHex(assetManifestBytes(manifest)), before);
    assert.equal(before, fixture.canonicalHex);
  });

  test('the encoder rejects a forged string hash before writing bytes', () => {
    const writer = new CanonicalWriter();
    const manifest = assetManifest(fixtureInput());
    const forged = {
      ...manifest,
      domain: {
        ...manifest.domain,
        domainManifestHash: fixture.domain.domainManifestHash,
      },
    } as unknown as AssetManifest;

    assert.throws(() => encodeAssetManifest(writer, forged), MalformedInputError);
    assert.equal(writer.bytes().length, 0);
  });
});
