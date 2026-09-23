import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  EXPIRY_UNIT,
  REGISTRY_STATE,
  type ExpiryUnit,
  type RegistryState,
} from './enums.js';
import { MalformedInputError } from './errors.js';
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

const VERSION_BITS = 32;

export interface PackageTemplateRegistryRecordInput {
  readonly recordVersion: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly registryState: RegistryState;
  readonly activationUnit: ExpiryUnit;
  readonly activationValue: bigint;
  readonly governanceReference: string;
}

export interface PackageTemplateRegistryRecord {
  readonly recordVersion: number;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly templateId: ProtocolId;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: ManifestHash;
  readonly registryState: RegistryState;
  readonly activationUnit: ExpiryUnit;
  readonly activationValue: bigint;
  readonly governanceReference: ProtocolId;
}

function nonzeroU32(value: number, context: string): number {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  const checked = checkedUnsigned(value, VERSION_BITS, context);
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

function frozenRecord(
  recordVersion: number,
  environment: ProtocolId,
  domain: DomainRef,
  templateId: ProtocolId,
  templateVersion: number,
  packageTemplateManifestHash: ManifestHash,
  registryState: RegistryState,
  activationUnit: ExpiryUnit,
  activationValue: bigint,
  governanceReference: ProtocolId,
): PackageTemplateRegistryRecord {
  return Object.freeze({
    recordVersion,
    environment,
    domain,
    templateId,
    templateVersion,
    get packageTemplateManifestHash(): ManifestHash {
      return Uint8Array.from(packageTemplateManifestHash) as ManifestHash;
    },
    registryState,
    activationUnit,
    activationValue,
    governanceReference,
  });
}

export function packageTemplateRegistryRecord(
  input: PackageTemplateRegistryRecordInput,
  context = 'packageTemplateRegistryRecord',
): PackageTemplateRegistryRecord {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(
      context,
      'expected a package template registry record object',
    );
  }

  enumDiscriminant(REGISTRY_STATE, input.registryState, `${context}.registryState`);
  const activation = expiry(
    input.activationUnit,
    input.activationValue,
    `${context}.activation`,
  );

  return frozenRecord(
    nonzeroU32(input.recordVersion, `${context}.recordVersion`),
    protocolId(input.environment, `${context}.environment`),
    canonicalDomainRef(input.domain, `${context}.domain`),
    protocolId(input.templateId, `${context}.templateId`),
    nonzeroU32(input.templateVersion, `${context}.templateVersion`),
    manifestHash(
      input.packageTemplateManifestHash,
      `${context}.packageTemplateManifestHash`,
    ),
    input.registryState,
    activation.unit,
    activation.value,
    protocolId(input.governanceReference, `${context}.governanceReference`),
  );
}

function checkedPackageTemplateRegistryRecord(
  value: PackageTemplateRegistryRecord,
  context: string,
): PackageTemplateRegistryRecord {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(
      context,
      'expected a package template registry record object',
    );
  }
  return packageTemplateRegistryRecord(
    {
      recordVersion: value.recordVersion,
      environment: value.environment,
      domain: value.domain,
      templateId: value.templateId,
      templateVersion: value.templateVersion,
      packageTemplateManifestHash: canonicalManifestHash(
        value.packageTemplateManifestHash,
        `${context}.packageTemplateManifestHash`,
      ),
      registryState: value.registryState,
      activationUnit: value.activationUnit,
      activationValue: value.activationValue,
      governanceReference: value.governanceReference,
    },
    context,
  );
}

export function encodePackageTemplateRegistryRecord(
  writer: CanonicalWriter,
  value: PackageTemplateRegistryRecord,
): void {
  const checked = checkedPackageTemplateRegistryRecord(
    value,
    'packageTemplateRegistryRecord',
  );
  writer.writeU32(
    checked.recordVersion,
    'packageTemplateRegistryRecord.recordVersion',
  );
  encodeProtocolId(
    writer,
    checked.environment,
    'packageTemplateRegistryRecord.environment',
  );
  encodeDomainRef(writer, checked.domain);
  encodeProtocolId(
    writer,
    checked.templateId,
    'packageTemplateRegistryRecord.templateId',
  );
  writer.writeU32(
    checked.templateVersion,
    'packageTemplateRegistryRecord.templateVersion',
  );
  encodeManifestHash(
    writer,
    checked.packageTemplateManifestHash,
    'packageTemplateRegistryRecord.packageTemplateManifestHash',
  );
  writer.writeEnum(
    REGISTRY_STATE,
    checked.registryState,
    'packageTemplateRegistryRecord.registryState',
  );
  writer.writeEnum(
    EXPIRY_UNIT,
    checked.activationUnit,
    'packageTemplateRegistryRecord.activationUnit',
  );
  writer.writeU64(
    checked.activationValue,
    'packageTemplateRegistryRecord.activationValue',
  );
  encodeProtocolId(
    writer,
    checked.governanceReference,
    'packageTemplateRegistryRecord.governanceReference',
  );
}

export function packageTemplateRegistryRecordBytes(
  value: PackageTemplateRegistryRecordInput,
): Uint8Array {
  const checked = packageTemplateRegistryRecord(value, 'packageTemplateRegistryRecord');
  return canonicalBytes((writer) => encodePackageTemplateRegistryRecord(writer, checked));
}

export function packageTemplateRegistryRecordHash(
  value: PackageTemplateRegistryRecordInput,
): Hash32 {
  return domainHash(
    HASH_DOMAIN.PACKAGE_TEMPLATE_REGISTRY_RECORD,
    packageTemplateRegistryRecordBytes(value),
    'packageTemplateRegistryRecordHash',
  );
}
