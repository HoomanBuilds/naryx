import { checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  EXPIRY_UNIT,
  REGISTRY_RECORD_KIND,
  REGISTRY_STATE,
  SETTLEMENT_CLASS,
  type ExpiryUnit,
  type RegistryRecordKind,
  type RegistryState,
  type SettlementClass,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  domainRef,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  expiry,
  manifestHash,
  protocolId,
  type DomainRef,
  type Hash32,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';
import {
  canonicalPackageTemplateRefs,
  canonicalRiskLimits,
  encodePackageTemplateRef,
  encodeRiskLimit,
  packageTemplateRef,
  riskLimit,
  type PackageTemplateRef,
  type PackageTemplateRefInput,
  type RiskLimit,
  type RiskLimitInput,
} from './registry-primitives.js';

const U32_BITS = 32;

export interface DomainRegistryRecordInput {
  readonly recordVersion: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly recordKind: RegistryRecordKind;
  readonly subjectId: string;
  readonly subjectManifestVersion: number;
  readonly subjectManifestHash: Uint8Array | string;
  readonly registryState: RegistryState;
  readonly riskLimits: readonly RiskLimitInput[];
  readonly allowedTemplates: readonly PackageTemplateRefInput[];
  readonly allowedSettlementClasses: readonly SettlementClass[];
  readonly activationUnit: ExpiryUnit;
  readonly activationValue: bigint;
  readonly governanceReference: string;
}

export interface DomainRegistryRecord {
  readonly recordVersion: number;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly recordKind: Exclude<RegistryRecordKind, 'PACKAGE_TEMPLATE'>;
  readonly subjectId: ProtocolId;
  readonly subjectManifestVersion: number;
  readonly subjectManifestHash: ManifestHash;
  readonly registryState: RegistryState;
  readonly riskLimits: readonly RiskLimit[];
  readonly allowedTemplates: readonly PackageTemplateRef[];
  readonly allowedSettlementClasses: readonly SettlementClass[];
  readonly activationUnit: ExpiryUnit;
  readonly activationValue: bigint;
  readonly governanceReference: ProtocolId;
}

function nonzeroU32(value: number, context: string): number {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  const checked = checkedUnsigned(value, U32_BITS, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'version is zero');
  }
  return Number(checked);
}

function canonicalDomainRef(value: DomainRef, context: string): DomainRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a domain reference object');
  }
  if (!(value.domainManifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(
      `${context}.domainManifestHash`,
      'expected 32 canonical bytes',
    );
  }
  return domainRef(
    value.domainId,
    value.domainManifestVersion,
    value.domainManifestHash,
    context,
  );
}

function canonicalManifestHash(value: ManifestHash, context: string): ManifestHash {
  if (!(value instanceof Uint8Array)) {
    throw new MalformedInputError(context, 'expected 32 canonical bytes');
  }
  return manifestHash(value, context);
}

function generalRecordKind(
  value: RegistryRecordKind,
  context: string,
): Exclude<RegistryRecordKind, 'PACKAGE_TEMPLATE'> {
  enumDiscriminant(REGISTRY_RECORD_KIND, value, context);
  if (value === 'PACKAGE_TEMPLATE') {
    throw new MalformedInputError(
      context,
      'package templates require PackageTemplateRegistryRecord',
    );
  }
  return value;
}

function canonicalSettlementClasses(
  values: readonly SettlementClass[],
  context: string,
): readonly SettlementClass[] {
  if (!Array.isArray(values)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  const entries = values.map((value, index) => {
    enumDiscriminant(SETTLEMENT_CLASS, value, `${context}[${index}]`);
    return {
      value,
      key: canonicalBytes((writer) =>
        writer.writeEnum(SETTLEMENT_CLASS, value, `${context}[${index}]`),
      ),
    };
  });
  for (let index = 1; index < entries.length; index += 1) {
    const relation = compareBytes(entries[index - 1]!.key, entries[index]!.key);
    if (relation === 0) {
      throw new DuplicateElementError(context, `duplicate settlement class at index ${index}`);
    }
    if (relation > 0) {
      throw new MalformedInputError(context, `noncanonical ordering at index ${index}`);
    }
  }
  return Object.freeze(entries.map((entry) => entry.value));
}

interface ValidatedRecord {
  readonly recordVersion: number;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly recordKind: Exclude<RegistryRecordKind, 'PACKAGE_TEMPLATE'>;
  readonly subjectId: ProtocolId;
  readonly subjectManifestVersion: number;
  readonly subjectManifestHash: ManifestHash;
  readonly registryState: RegistryState;
  readonly riskLimits: readonly RiskLimit[];
  readonly allowedTemplates: readonly PackageTemplateRef[];
  readonly allowedSettlementClasses: readonly SettlementClass[];
  readonly activationUnit: ExpiryUnit;
  readonly activationValue: bigint;
  readonly governanceReference: ProtocolId;
}

function frozenRecord(value: ValidatedRecord): DomainRegistryRecord {
  const capturedHash = Uint8Array.from(value.subjectManifestHash) as ManifestHash;
  return Object.freeze({
    recordVersion: value.recordVersion,
    environment: value.environment,
    domain: value.domain,
    recordKind: value.recordKind,
    subjectId: value.subjectId,
    subjectManifestVersion: value.subjectManifestVersion,
    get subjectManifestHash(): ManifestHash {
      return Uint8Array.from(capturedHash) as ManifestHash;
    },
    registryState: value.registryState,
    riskLimits: value.riskLimits,
    allowedTemplates: value.allowedTemplates,
    allowedSettlementClasses: value.allowedSettlementClasses,
    activationUnit: value.activationUnit,
    activationValue: value.activationValue,
    governanceReference: value.governanceReference,
  });
}

export function domainRegistryRecord(
  input: DomainRegistryRecordInput,
  context = 'domainRegistryRecord',
): DomainRegistryRecord {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a domain registry record object');
  }
  if (!Array.isArray(input.riskLimits)) {
    throw new MalformedInputError(`${context}.riskLimits`, 'expected an array');
  }
  if (!Array.isArray(input.allowedTemplates)) {
    throw new MalformedInputError(`${context}.allowedTemplates`, 'expected an array');
  }

  enumDiscriminant(REGISTRY_STATE, input.registryState, `${context}.registryState`);
  const activation = expiry(
    input.activationUnit,
    input.activationValue,
    `${context}.activation`,
  );
  const riskLimits = canonicalRiskLimits(
    input.riskLimits.map((value, index) =>
      riskLimit(value, `${context}.riskLimits[${index}]`),
    ),
    `${context}.riskLimits`,
  );
  const allowedTemplates = canonicalPackageTemplateRefs(
    input.allowedTemplates.map((value, index) =>
      packageTemplateRef(value, `${context}.allowedTemplates[${index}]`),
    ),
    `${context}.allowedTemplates`,
  );

  return frozenRecord({
    recordVersion: nonzeroU32(input.recordVersion, `${context}.recordVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    domain: canonicalDomainRef(input.domain, `${context}.domain`),
    recordKind: generalRecordKind(input.recordKind, `${context}.recordKind`),
    subjectId: protocolId(input.subjectId, `${context}.subjectId`),
    subjectManifestVersion: nonzeroU32(
      input.subjectManifestVersion,
      `${context}.subjectManifestVersion`,
    ),
    subjectManifestHash: manifestHash(
      input.subjectManifestHash,
      `${context}.subjectManifestHash`,
    ),
    registryState: input.registryState,
    riskLimits,
    allowedTemplates,
    allowedSettlementClasses: canonicalSettlementClasses(
      input.allowedSettlementClasses,
      `${context}.allowedSettlementClasses`,
    ),
    activationUnit: activation.unit,
    activationValue: activation.value,
    governanceReference: protocolId(
      input.governanceReference,
      `${context}.governanceReference`,
    ),
  });
}

function checkedDomainRegistryRecord(
  value: DomainRegistryRecord,
  context: string,
): DomainRegistryRecord {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a domain registry record object');
  }
  enumDiscriminant(REGISTRY_STATE, value.registryState, `${context}.registryState`);
  const activation = expiry(
    value.activationUnit,
    value.activationValue,
    `${context}.activation`,
  );

  return frozenRecord({
    recordVersion: nonzeroU32(value.recordVersion, `${context}.recordVersion`),
    environment: protocolId(value.environment, `${context}.environment`),
    domain: canonicalDomainRef(value.domain, `${context}.domain`),
    recordKind: generalRecordKind(value.recordKind, `${context}.recordKind`),
    subjectId: protocolId(value.subjectId, `${context}.subjectId`),
    subjectManifestVersion: nonzeroU32(
      value.subjectManifestVersion,
      `${context}.subjectManifestVersion`,
    ),
    subjectManifestHash: canonicalManifestHash(
      value.subjectManifestHash,
      `${context}.subjectManifestHash`,
    ),
    registryState: value.registryState,
    riskLimits: canonicalRiskLimits(value.riskLimits, `${context}.riskLimits`),
    allowedTemplates: canonicalPackageTemplateRefs(
      value.allowedTemplates,
      `${context}.allowedTemplates`,
    ),
    allowedSettlementClasses: canonicalSettlementClasses(
      value.allowedSettlementClasses,
      `${context}.allowedSettlementClasses`,
    ),
    activationUnit: activation.unit,
    activationValue: activation.value,
    governanceReference: protocolId(
      value.governanceReference,
      `${context}.governanceReference`,
    ),
  });
}

export function encodeDomainRegistryRecord(
  writer: CanonicalWriter,
  value: DomainRegistryRecord,
): void {
  const checked = checkedDomainRegistryRecord(value, 'domainRegistryRecord');
  writer.writeU32(checked.recordVersion, 'domainRegistryRecord.recordVersion');
  encodeProtocolId(writer, checked.environment, 'domainRegistryRecord.environment');
  encodeDomainRef(writer, checked.domain);
  writer.writeEnum(
    REGISTRY_RECORD_KIND,
    checked.recordKind,
    'domainRegistryRecord.recordKind',
  );
  encodeProtocolId(writer, checked.subjectId, 'domainRegistryRecord.subjectId');
  writer.writeU32(
    checked.subjectManifestVersion,
    'domainRegistryRecord.subjectManifestVersion',
  );
  encodeManifestHash(
    writer,
    checked.subjectManifestHash,
    'domainRegistryRecord.subjectManifestHash',
  );
  writer.writeEnum(
    REGISTRY_STATE,
    checked.registryState,
    'domainRegistryRecord.registryState',
  );
  writer.writeArray(
    checked.riskLimits,
    (target, limit) => encodeRiskLimit(target, limit),
    'domainRegistryRecord.riskLimits',
  );
  writer.writeArray(
    checked.allowedTemplates,
    (target, template) => encodePackageTemplateRef(target, template),
    'domainRegistryRecord.allowedTemplates',
  );
  writer.writeArray(
    checked.allowedSettlementClasses,
    (target, settlementClass) =>
      target.writeEnum(
        SETTLEMENT_CLASS,
        settlementClass,
        'domainRegistryRecord.allowedSettlementClasses.element',
      ),
    'domainRegistryRecord.allowedSettlementClasses',
  );
  writer.writeEnum(
    EXPIRY_UNIT,
    checked.activationUnit,
    'domainRegistryRecord.activationUnit',
  );
  writer.writeU64(checked.activationValue, 'domainRegistryRecord.activationValue');
  encodeProtocolId(
    writer,
    checked.governanceReference,
    'domainRegistryRecord.governanceReference',
  );
}

export function domainRegistryRecordBytes(
  value: DomainRegistryRecordInput,
): Uint8Array {
  const checked = domainRegistryRecord(value, 'domainRegistryRecord');
  return canonicalBytes((writer) => encodeDomainRegistryRecord(writer, checked));
}

export function domainRegistryRecordHash(
  value: DomainRegistryRecordInput,
): Hash32 {
  return domainHash(
    HASH_DOMAIN.DOMAIN_REGISTRY_RECORD,
    domainRegistryRecordBytes(value),
    'domainRegistryRecordHash',
  );
}
