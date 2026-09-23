import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  domainRegistryRecord,
  domainRegistryRecordBytes,
  domainRegistryRecordHash,
  encodeDomainRegistryRecord,
  fromHex,
  toHex,
  type DomainRef,
  type DomainRegistryRecord,
  type DomainRegistryRecordInput,
  type DurationUnit,
  type ExpiryUnit,
  type RegistryRecordKind,
  type RegistryState,
  type RiskLimitInput,
  type SettlementClass,
} from '../src/index.js';
import { loadFixture, type DomainRegistryRecordFixture } from './fixtures.js';

const fixture = loadFixture<DomainRegistryRecordFixture>('domain-registry-record.json');

function fixtureDomain(hash: Uint8Array | string = fromHex(fixture.domain.domainManifestHash)) {
  return {
    domainId: fixture.domain.domainId,
    domainManifestVersion: Number(fixture.domain.domainManifestVersion),
    domainManifestHash: hash,
  } as unknown as DomainRef;
}

function fixtureRiskLimits(): RiskLimitInput[] {
  return fixture.riskLimits.map((limit) => ({
    limitKind: limit.limitKind as RiskLimitInput['limitKind'],
    assetId: limit.assetId,
    assetManifestHash: limit.assetManifestHash,
    decimals: limit.decimals,
    maxAtoms: BigInt(limit.maxAtoms),
    ...(limit.windowUnit === undefined
      ? {}
      : { windowUnit: limit.windowUnit as DurationUnit }),
    ...(limit.windowValue === undefined
      ? {}
      : { windowValue: BigInt(limit.windowValue) }),
  }));
}

function fixtureInput(
  overrides: Partial<DomainRegistryRecordInput> = {},
): DomainRegistryRecordInput {
  return {
    recordVersion: Number(fixture.recordVersion),
    environment: fixture.environment,
    domain: fixtureDomain(),
    recordKind: fixture.recordKind as RegistryRecordKind,
    subjectId: fixture.subjectId,
    subjectManifestVersion: Number(fixture.subjectManifestVersion),
    subjectManifestHash: fixture.subjectManifestHash,
    registryState: fixture.registryState as RegistryState,
    riskLimits: fixtureRiskLimits(),
    allowedTemplates: fixture.allowedTemplates.map((template) => ({
      templateId: template.templateId,
      templateVersion: Number(template.templateVersion),
      packageTemplateManifestHash: template.packageTemplateManifestHash,
    })),
    allowedSettlementClasses:
      fixture.allowedSettlementClasses as SettlementClass[],
    activationUnit: fixture.activationUnit as ExpiryUnit,
    activationValue: BigInt(fixture.activationValue),
    governanceReference: fixture.governanceReference,
    ...overrides,
  };
}

describe('domain registry record canonical identity', () => {
  test('canonical bytes and domain-separated digest match the golden vector', () => {
    const record = domainRegistryRecord(fixtureInput());

    assert.equal(record.activationValue, 0n);
    assert.equal(toHex(domainRegistryRecordBytes(record)), fixture.canonicalHex);
    assert.equal(toHex(domainRegistryRecordHash(record)), fixture.digestHex);
  });

  test('constructor captures every mutable hash and list input', () => {
    const domainHash = fromHex(fixture.domain.domainManifestHash);
    const subjectHash = fromHex(fixture.subjectManifestHash);
    const assetHash = fromHex(fixture.riskLimits[0]!.assetManifestHash);
    const templateHash = fromHex(
      fixture.allowedTemplates[0]!.packageTemplateManifestHash,
    );
    const riskLimits = fixtureRiskLimits();
    riskLimits[0] = { ...riskLimits[0]!, assetManifestHash: assetHash };
    const allowedTemplates = [
      {
        ...fixture.allowedTemplates[0]!,
        templateVersion: Number(fixture.allowedTemplates[0]!.templateVersion),
        packageTemplateManifestHash: templateHash,
      },
    ];
    const record = domainRegistryRecord(
      fixtureInput({
        domain: fixtureDomain(domainHash),
        subjectManifestHash: subjectHash,
        riskLimits,
        allowedTemplates,
      }),
    );
    const before = toHex(domainRegistryRecordBytes(record));

    domainHash[0] = 0xff;
    subjectHash[0] = 0xff;
    assetHash[0] = 0xff;
    templateHash[0] = 0xff;
    riskLimits.reverse();
    allowedTemplates.length = 0;
    record.domain.domainManifestHash[0] = 0xff;
    record.subjectManifestHash[0] = 0xff;
    record.riskLimits[0]!.assetManifestHash[0] = 0xff;
    record.allowedTemplates[0]!.packageTemplateManifestHash[0] = 0xff;

    assert.equal(Object.isFrozen(record), true);
    assert.equal(Object.isFrozen(record.riskLimits), true);
    assert.equal(Object.isFrozen(record.allowedTemplates), true);
    assert.equal(toHex(domainRegistryRecordBytes(record)), before);
  });
});

describe('domain registry record validation', () => {
  test('versions are nonzero u32 and activation is an unsigned u64 expiry', () => {
    for (const invalid of [
      { recordVersion: 0 },
      { subjectManifestVersion: 0 },
    ] satisfies Partial<DomainRegistryRecordInput>[]) {
      assert.throws(() => domainRegistryRecord(fixtureInput(invalid)), MalformedInputError);
    }
    for (const invalid of [
      { recordVersion: 0x1_0000_0000 },
      { subjectManifestVersion: 0x1_0000_0000 },
    ] satisfies Partial<DomainRegistryRecordInput>[]) {
      assert.throws(() => domainRegistryRecord(fixtureInput(invalid)), RangeViolationError);
    }
    assert.throws(
      () =>
        domainRegistryRecord(
          fixtureInput({ activationValue: 1 as unknown as bigint }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () => domainRegistryRecord(fixtureInput({ activationValue: -1n })),
      RangeViolationError,
    );
    assert.throws(
      () => domainRegistryRecord(fixtureInput({ activationValue: 1n << 64n })),
      RangeViolationError,
    );
    assert.throws(
      () =>
        domainRegistryRecord(
          fixtureInput({ activationUnit: 'UNKNOWN' as ExpiryUnit }),
        ),
      MalformedInputError,
    );
  });

  test('the general record rejects reserved and unknown record kinds', () => {
    assert.throws(
      () =>
        domainRegistryRecord(fixtureInput({ recordKind: 'PACKAGE_TEMPLATE' })),
      MalformedInputError,
    );
    assert.throws(
      () =>
        domainRegistryRecord(
          fixtureInput({ recordKind: 'UNKNOWN' as RegistryRecordKind }),
        ),
      MalformedInputError,
    );
  });

  test('every policy list must already be canonical and duplicate-free', () => {
    const limits = fixtureRiskLimits();
    assert.throws(
      () => domainRegistryRecord(fixtureInput({ riskLimits: [...limits].reverse() })),
      MalformedInputError,
    );
    assert.throws(
      () =>
        domainRegistryRecord(
          fixtureInput({
            riskLimits: [limits[0]!, { ...limits[0]!, maxAtoms: 1n }],
          }),
        ),
      DuplicateElementError,
    );

    const firstTemplate = fixtureInput().allowedTemplates[0]!;
    const secondTemplate = {
      ...firstTemplate,
      templateVersion: 2,
      packageTemplateManifestHash: '66'.repeat(32),
    };
    assert.throws(
      () =>
        domainRegistryRecord(
          fixtureInput({ allowedTemplates: [secondTemplate, firstTemplate] }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        domainRegistryRecord(
          fixtureInput({ allowedTemplates: [firstTemplate, firstTemplate] }),
        ),
      DuplicateElementError,
    );

    assert.throws(
      () =>
        domainRegistryRecord(
          fixtureInput({
            allowedSettlementClasses: [
              'BATCHED_IOC_WITH_RECOVERY',
              'ATOMIC_POSTCONDITION',
            ],
          }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        domainRegistryRecord(
          fixtureInput({
            allowedSettlementClasses: [
              'ATOMIC_POSTCONDITION',
              'ATOMIC_POSTCONDITION',
            ],
          }),
        ),
      DuplicateElementError,
    );

    const empty = domainRegistryRecord(
      fixtureInput({
        riskLimits: [],
        allowedTemplates: [],
        allowedSettlementClasses: [],
      }),
    );
    assert.equal(empty.riskLimits.length, 0);
    assert.equal(empty.allowedTemplates.length, 0);
    assert.equal(empty.allowedSettlementClasses.length, 0);
  });

  test('the encoder rejects forged string and all-zero hashes before writing', () => {
    const record = domainRegistryRecord(fixtureInput());
    const zeroHash = new Uint8Array(32);
    const forgedRecords = [
      { ...record, subjectManifestHash: fixture.subjectManifestHash },
      { ...record, subjectManifestHash: zeroHash },
      {
        ...record,
        domain: {
          ...record.domain,
          domainManifestHash: fixture.domain.domainManifestHash,
        },
      },
      {
        ...record,
        domain: { ...record.domain, domainManifestHash: zeroHash },
      },
      {
        ...record,
        riskLimits: [
          {
            ...record.riskLimits[0]!,
            assetManifestHash: fixture.riskLimits[0]!.assetManifestHash,
          },
          record.riskLimits[1]!,
        ],
      },
      {
        ...record,
        allowedTemplates: [
          {
            ...record.allowedTemplates[0]!,
            packageTemplateManifestHash:
              fixture.allowedTemplates[0]!.packageTemplateManifestHash,
          },
        ],
      },
    ] as unknown as DomainRegistryRecord[];

    for (const forged of forgedRecords) {
      const writer = new CanonicalWriter();
      assert.throws(
        () => encodeDomainRegistryRecord(writer, forged),
        MalformedInputError,
      );
      assert.equal(writer.bytes().length, 0);
    }
  });
});
