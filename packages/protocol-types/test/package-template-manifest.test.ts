import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  encodePackageTemplateManifest,
  fromHex,
  packageTemplateManifest,
  packageTemplateManifestBytes,
  packageTemplateManifestHash,
  toHex,
  type Direction,
  type DomainRef,
  type PackageTemplateManifest,
  type PackageTemplateManifestInput,
  type SettlementClass,
} from '../src/index.js';
import { loadFixture, type PackageTemplateManifestFixture } from './fixtures.js';

const fixture = loadFixture<PackageTemplateManifestFixture>('package-template-manifest.json');

function fixtureDomain(
  value: PackageTemplateManifestFixture['supportedDomains'][number],
  hash: Uint8Array | string = fromHex(value.domainManifestHash),
): DomainRef {
  return {
    domainId: value.domainId,
    domainManifestVersion: Number(value.domainManifestVersion),
    domainManifestHash: hash,
  } as unknown as DomainRef;
}

function fixtureInput(
  overrides: Partial<PackageTemplateManifestInput> = {},
): PackageTemplateManifestInput {
  return {
    manifestVersion: Number(fixture.manifestVersion),
    environment: fixture.environment,
    templateId: fixture.templateId,
    templateVersion: Number(fixture.templateVersion),
    supportedDomains: fixture.supportedDomains.map((value) => fixtureDomain(value)),
    orderSchemaHash: fixture.orderSchemaHash,
    quoteSchemaHash: fixture.quoteSchemaHash,
    routeSchemaHash: fixture.routeSchemaHash,
    receiptSchemaHash: fixture.receiptSchemaHash,
    entryCompilerVersion: Number(fixture.entryCompilerVersion),
    exitCompilerVersion: Number(fixture.exitCompilerVersion),
    legCount: Number(fixture.legCount),
    legTypes: fixture.legTypes,
    supportedDirections: fixture.supportedDirections as Direction[],
    supportedSettlementClasses: fixture.supportedSettlementClasses as SettlementClass[],
    allowedSpotAdapterIds: fixture.allowedSpotAdapterIds,
    allowedPerpAdapterIds: fixture.allowedPerpAdapterIds,
    riskPolicyHash: fixture.riskPolicyHash,
    ...overrides,
  };
}

describe('package template manifest canonical identity', () => {
  test('canonical bytes and domain-separated digest match the golden vector', () => {
    const manifest = packageTemplateManifest(fixtureInput());

    assert.deepEqual(
      manifest.supportedDomains.map((value) => value.domainId),
      ['evm:test-domain-2', 'svm:test-domain-1'],
    );
    assert.deepEqual(manifest.legTypes, ['spot-purchase', 'perp-sale']);
    assert.deepEqual(manifest.supportedSettlementClasses, [
      'ATOMIC_POSTCONDITION',
      'BATCHED_IOC_WITH_RECOVERY',
    ]);
    assert.deepEqual(manifest.allowedSpotAdapterIds, ['spot-a', 'spot-adapter-beta']);
    assert.deepEqual(manifest.allowedPerpAdapterIds, ['perp-a', 'perp-adapter-beta']);
    assert.equal(toHex(packageTemplateManifestBytes(fixtureInput())), fixture.canonicalHex);
    assert.equal(toHex(packageTemplateManifestHash(fixtureInput())), fixture.digestHex);
  });

  test('sets sort by canonical bytes and reject exact duplicates', () => {
    const input = fixtureInput();
    const permuted = fixtureInput({
      supportedDomains: [...input.supportedDomains].reverse(),
      supportedDirections: [...input.supportedDirections].reverse(),
      supportedSettlementClasses: [...input.supportedSettlementClasses].reverse(),
      allowedSpotAdapterIds: [...input.allowedSpotAdapterIds].reverse(),
      allowedPerpAdapterIds: [...input.allowedPerpAdapterIds].reverse(),
    });
    assert.equal(
      toHex(packageTemplateManifestBytes(permuted)),
      toHex(packageTemplateManifestBytes(input)),
    );

    const domain = input.supportedDomains[0] as DomainRef;
    const duplicateCases: Partial<PackageTemplateManifestInput>[] = [
      { supportedDomains: [domain, domain] },
      { supportedDirections: ['LONG_SPOT_SHORT_PERP', 'LONG_SPOT_SHORT_PERP'] },
      {
        supportedSettlementClasses: [
          'ATOMIC_POSTCONDITION',
          'ATOMIC_POSTCONDITION',
        ],
      },
      { allowedSpotAdapterIds: ['spot-a', 'spot-a'] },
      { allowedPerpAdapterIds: ['perp-a', 'perp-a'] },
    ];
    for (const duplicate of duplicateCases) {
      assert.throws(
        () => packageTemplateManifest(fixtureInput(duplicate)),
        DuplicateElementError,
      );
    }
  });

  test('leg order changes identity and leg count must match', () => {
    const reversed = packageTemplateManifestHash(
      fixtureInput({ legTypes: [...fixture.legTypes].reverse() }),
    );
    assert.notEqual(toHex(reversed), fixture.digestHex);
    assert.throws(
      () => packageTemplateManifest(fixtureInput({ legCount: 1 })),
      MalformedInputError,
    );
    assert.throws(
      () => packageTemplateManifest(fixtureInput({ legTypes: [] })),
      MalformedInputError,
    );
  });
});

describe('package template manifest validation', () => {
  test('versions, required sets, and enum variants fail closed', () => {
    const zeroVersionCases: Partial<PackageTemplateManifestInput>[] = [
      { manifestVersion: 0 },
      { templateVersion: 0 },
      { entryCompilerVersion: 0 },
      { exitCompilerVersion: 0 },
      { legCount: 0 },
    ];
    for (const invalid of zeroVersionCases) {
      assert.throws(() => packageTemplateManifest(fixtureInput(invalid)), MalformedInputError);
    }
    assert.throws(
      () => packageTemplateManifest(fixtureInput({ templateVersion: 0x1_0000_0000 })),
      RangeViolationError,
    );

    const emptySetCases: Partial<PackageTemplateManifestInput>[] = [
      { supportedDomains: [] },
      { supportedDirections: [] },
      { supportedSettlementClasses: [] },
      { allowedSpotAdapterIds: [] },
      { allowedPerpAdapterIds: [] },
    ];
    for (const invalid of emptySetCases) {
      assert.throws(() => packageTemplateManifest(fixtureInput(invalid)), MalformedInputError);
    }

    assert.throws(
      () =>
        packageTemplateManifest(
          fixtureInput({ supportedDirections: ['UNKNOWN'] as unknown as Direction[] }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        packageTemplateManifest(
          fixtureInput({
            supportedSettlementClasses: ['UNKNOWN'] as unknown as SettlementClass[],
          }),
        ),
      MalformedInputError,
    );
  });

  test('caller mutation cannot change captured hashes, domains, arrays, or later encoding', () => {
    const schemaHashes = [
      fromHex(fixture.orderSchemaHash),
      fromHex(fixture.quoteSchemaHash),
      fromHex(fixture.routeSchemaHash),
      fromHex(fixture.receiptSchemaHash),
      fromHex(fixture.riskPolicyHash),
    ];
    const firstDomainFixture = fixture.supportedDomains[0] as PackageTemplateManifestFixture[
      'supportedDomains'
    ][number];
    const secondDomainFixture = fixture.supportedDomains[1] as PackageTemplateManifestFixture[
      'supportedDomains'
    ][number];
    const firstDomainHash = fromHex(firstDomainFixture.domainManifestHash);
    const domains = [
      fixtureDomain(firstDomainFixture, firstDomainHash),
      fixtureDomain(secondDomainFixture),
    ];
    const legTypes = [...fixture.legTypes];
    const manifest = packageTemplateManifest(
      fixtureInput({
        supportedDomains: domains,
        orderSchemaHash: schemaHashes[0] as Uint8Array,
        quoteSchemaHash: schemaHashes[1] as Uint8Array,
        routeSchemaHash: schemaHashes[2] as Uint8Array,
        receiptSchemaHash: schemaHashes[3] as Uint8Array,
        legTypes,
        riskPolicyHash: schemaHashes[4] as Uint8Array,
      }),
    );
    const before = toHex(packageTemplateManifestBytes(manifest));

    for (const hash of schemaHashes) hash[0] = 0xff;
    firstDomainHash[0] = 0xff;
    domains[0] = domains[1] as DomainRef;
    legTypes[0] = 'changed-leg';
    manifest.orderSchemaHash[0] = 0xff;
    manifest.riskPolicyHash[0] = 0xff;
    (manifest.supportedDomains[0] as DomainRef).domainManifestHash[0] = 0xff;

    assert.equal(Object.isFrozen(manifest), true);
    assert.equal(Object.isFrozen(manifest.supportedDomains), true);
    assert.equal(Object.isFrozen(manifest.supportedDomains[0]), true);
    assert.equal(Object.isFrozen(manifest.legTypes), true);
    assert.throws(
      () =>
        (manifest.allowedSpotAdapterIds as unknown as string[]).push('another-adapter'),
      TypeError,
    );
    assert.equal(toHex(packageTemplateManifestBytes(manifest)), before);
    assert.equal(before, fixture.canonicalHex);
  });

  test('the encoder rejects forged string hashes before writing any bytes', () => {
    const manifest = packageTemplateManifest(fixtureInput());
    const hashFields = [
      'orderSchemaHash',
      'quoteSchemaHash',
      'routeSchemaHash',
      'receiptSchemaHash',
      'riskPolicyHash',
    ] as const;
    for (const field of hashFields) {
      const writer = new CanonicalWriter();
      const forged = {
        ...manifest,
        [field]: fixture[field],
      } as unknown as PackageTemplateManifest;
      assert.throws(() => encodePackageTemplateManifest(writer, forged), MalformedInputError);
      assert.equal(writer.bytes().length, 0);
    }

    const writer = new CanonicalWriter();
    const domain = manifest.supportedDomains[0] as DomainRef;
    const domainHash = (fixture.supportedDomains[0] as PackageTemplateManifestFixture[
      'supportedDomains'
    ][number]).domainManifestHash;
    const forged = {
      ...manifest,
      supportedDomains: [
        {
          ...domain,
          domainManifestHash: domainHash,
        },
        ...manifest.supportedDomains.slice(1),
      ],
    } as unknown as PackageTemplateManifest;
    assert.throws(() => encodePackageTemplateManifest(writer, forged), MalformedInputError);
    assert.equal(writer.bytes().length, 0);
  });
});
