import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  MalformedInputError,
  RangeViolationError,
  encodePackageTemplateRegistryRecord,
  fromHex,
  packageTemplateRegistryRecord,
  packageTemplateRegistryRecordBytes,
  packageTemplateRegistryRecordHash,
  toHex,
  type DomainRef,
  type ExpiryUnit,
  type PackageTemplateRegistryRecord,
  type PackageTemplateRegistryRecordInput,
  type RegistryState,
} from '../src/index.js';
import {
  loadFixture,
  type PackageTemplateRegistryRecordFixture,
} from './fixtures.js';

const fixture = loadFixture<PackageTemplateRegistryRecordFixture>(
  'package-template-registry-record.json',
);

function fixtureDomain(hash: Uint8Array | string = fromHex(fixture.domain.domainManifestHash)) {
  return {
    domainId: fixture.domain.domainId,
    domainManifestVersion: Number(fixture.domain.domainManifestVersion),
    domainManifestHash: hash,
  } as unknown as DomainRef;
}

function fixtureInput(
  overrides: Partial<PackageTemplateRegistryRecordInput> = {},
): PackageTemplateRegistryRecordInput {
  return {
    recordVersion: Number(fixture.recordVersion),
    environment: fixture.environment,
    domain: fixtureDomain(),
    templateId: fixture.templateId,
    templateVersion: Number(fixture.templateVersion),
    packageTemplateManifestHash: fixture.packageTemplateManifestHash,
    registryState: fixture.registryState as RegistryState,
    activationUnit: fixture.activationUnit as ExpiryUnit,
    activationValue: BigInt(fixture.activationValue),
    governanceReference: fixture.governanceReference,
    ...overrides,
  };
}

describe('package template registry record canonical identity', () => {
  test('canonical bytes and domain-separated digest match the golden vector', () => {
    const record = packageTemplateRegistryRecord(fixtureInput());

    assert.equal(record.activationValue, 0n);
    assert.equal(toHex(packageTemplateRegistryRecordBytes(record)), fixture.canonicalHex);
    assert.equal(toHex(packageTemplateRegistryRecordHash(record)), fixture.digestHex);
  });

  test('registry state and activation unit discriminants change identity', () => {
    const stateHash = toHex(
      packageTemplateRegistryRecordHash(
        fixtureInput({ registryState: 'ENTRY_PAUSED' }),
      ),
    );
    const unitHash = toHex(
      packageTemplateRegistryRecordHash(
        fixtureInput({ activationUnit: 'EVM_UNIX_SECONDS' }),
      ),
    );

    assert.notEqual(stateHash, fixture.digestHex);
    assert.notEqual(unitHash, fixture.digestHex);
    assert.notEqual(stateHash, unitHash);
  });
});

describe('package template registry record validation', () => {
  test('versions must be nonzero u32 numbers', () => {
    for (const invalid of [
      { recordVersion: 0 },
      { templateVersion: 0 },
    ] satisfies Partial<PackageTemplateRegistryRecordInput>[]) {
      assert.throws(
        () => packageTemplateRegistryRecord(fixtureInput(invalid)),
        MalformedInputError,
      );
    }

    for (const invalid of [
      { recordVersion: 0x1_0000_0000 },
      { templateVersion: 0x1_0000_0000 },
    ] satisfies Partial<PackageTemplateRegistryRecordInput>[]) {
      assert.throws(
        () => packageTemplateRegistryRecord(fixtureInput(invalid)),
        RangeViolationError,
      );
    }

    for (const invalid of [
      { recordVersion: 1n as unknown as number },
      { templateVersion: '1' as unknown as number },
    ] satisfies Partial<PackageTemplateRegistryRecordInput>[]) {
      assert.throws(
        () => packageTemplateRegistryRecord(fixtureInput(invalid)),
        MalformedInputError,
      );
    }
  });

  test('activation uses the exact expiry unit and unsigned u64 value rules', () => {
    assert.throws(
      () =>
        packageTemplateRegistryRecord(
          fixtureInput({ activationValue: 1 as unknown as bigint }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () => packageTemplateRegistryRecord(fixtureInput({ activationValue: -1n })),
      RangeViolationError,
    );
    assert.throws(
      () =>
        packageTemplateRegistryRecord(
          fixtureInput({ activationValue: 1n << 64n }),
        ),
      RangeViolationError,
    );
    assert.throws(
      () =>
        packageTemplateRegistryRecord(
          fixtureInput({ activationUnit: 'UNKNOWN' as ExpiryUnit }),
        ),
      MalformedInputError,
    );
  });

  test('unknown registry states and invalid identifiers fail closed', () => {
    assert.throws(
      () =>
        packageTemplateRegistryRecord(
          fixtureInput({ registryState: 'UNKNOWN' as RegistryState }),
        ),
      MalformedInputError,
    );

    const invalidIdentifiers: Partial<PackageTemplateRegistryRecordInput>[] = [
      { environment: '' },
      { templateId: `template-${String.fromCharCode(0xe9)}` },
      { governanceReference: '' },
      { domain: { ...fixtureDomain(), domainId: '' } as DomainRef },
    ];
    for (const invalid of invalidIdentifiers) {
      assert.throws(
        () => packageTemplateRegistryRecord(fixtureInput(invalid)),
        MalformedInputError,
      );
    }
  });

  test('caller mutation cannot change captured hashes, domain, or later encoding', () => {
    const domainHash = fromHex(fixture.domain.domainManifestHash);
    const templateHash = fromHex(fixture.packageTemplateManifestHash);
    const domain = fixtureDomain(domainHash);
    const record = packageTemplateRegistryRecord(
      fixtureInput({ domain, packageTemplateManifestHash: templateHash }),
    );
    const before = toHex(packageTemplateRegistryRecordBytes(record));

    domainHash[0] = 0xff;
    templateHash[0] = 0xff;
    record.domain.domainManifestHash[0] = 0xff;
    record.packageTemplateManifestHash[0] = 0xff;

    assert.equal(Object.isFrozen(record), true);
    assert.equal(Object.isFrozen(record.domain), true);
    assert.equal(toHex(packageTemplateRegistryRecordBytes(record)), before);
    assert.equal(before, fixture.canonicalHex);
  });

  test('the encoder rejects forged string and all-zero hashes before writing bytes', () => {
    const record = packageTemplateRegistryRecord(fixtureInput());
    const zeroHash = new Uint8Array(32);
    const forgedRecords = [
      {
        ...record,
        packageTemplateManifestHash: fixture.packageTemplateManifestHash,
      },
      {
        ...record,
        packageTemplateManifestHash: zeroHash,
      },
      {
        ...record,
        domain: {
          ...record.domain,
          domainManifestHash: fixture.domain.domainManifestHash,
        },
      },
      {
        ...record,
        domain: {
          ...record.domain,
          domainManifestHash: zeroHash,
        },
      },
    ] as unknown as PackageTemplateRegistryRecord[];

    for (const forged of forgedRecords) {
      const writer = new CanonicalWriter();
      assert.throws(
        () => encodePackageTemplateRegistryRecord(writer, forged),
        MalformedInputError,
      );
      assert.equal(writer.bytes().length, 0);
    }
  });
});
