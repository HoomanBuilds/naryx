import { checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import {
  DIRECTION,
  enumDiscriminant,
  SETTLEMENT_CLASS,
  type Direction,
  type EnumTable,
  type SettlementClass,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  domainRef,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const U32_BITS = 32;

export interface PackageTemplateManifestInput {
  readonly manifestVersion: number;
  readonly environment: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly supportedDomains: readonly DomainRef[];
  readonly orderSchemaHash: Uint8Array | string;
  readonly quoteSchemaHash: Uint8Array | string;
  readonly routeSchemaHash: Uint8Array | string;
  readonly receiptSchemaHash: Uint8Array | string;
  readonly entryCompilerVersion: number;
  readonly exitCompilerVersion: number;
  readonly legCount: number;
  readonly legTypes: readonly string[];
  readonly supportedDirections: readonly Direction[];
  readonly supportedSettlementClasses: readonly SettlementClass[];
  readonly allowedSpotAdapterIds: readonly string[];
  readonly allowedPerpAdapterIds: readonly string[];
  /** Manifest v2 generic adapter set for option, lending, collateral, future, and other implemented leg families. */
  readonly allowedAdapterIds?: readonly string[];
  readonly riskPolicyHash: Uint8Array | string;
}

export interface PackageTemplateManifest {
  readonly manifestVersion: number;
  readonly environment: ProtocolId;
  readonly templateId: ProtocolId;
  readonly templateVersion: number;
  readonly supportedDomains: readonly DomainRef[];
  readonly orderSchemaHash: ManifestHash;
  readonly quoteSchemaHash: ManifestHash;
  readonly routeSchemaHash: ManifestHash;
  readonly receiptSchemaHash: ManifestHash;
  readonly entryCompilerVersion: number;
  readonly exitCompilerVersion: number;
  readonly legCount: number;
  readonly legTypes: readonly ProtocolId[];
  readonly supportedDirections: readonly Direction[];
  readonly supportedSettlementClasses: readonly SettlementClass[];
  readonly allowedSpotAdapterIds: readonly ProtocolId[];
  readonly allowedPerpAdapterIds: readonly ProtocolId[];
  readonly allowedAdapterIds?: readonly ProtocolId[];
  readonly riskPolicyHash: ManifestHash;
}

function nonzeroU32(value: number, context: string): number {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  const checked = checkedUnsigned(value, U32_BITS, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'value is zero');
  }
  return Number(checked);
}

function nonemptyArray<T>(value: readonly T[], context: string): readonly T[] {
  if (!Array.isArray(value)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  if (value.length === 0) {
    throw new MalformedInputError(context, 'set or array is empty');
  }
  return value;
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

function canonicalDomainSet(
  values: readonly DomainRef[],
  context: string,
): readonly DomainRef[] {
  const entries = nonemptyArray(values, context)
    .map((value, index) => {
      const checked = canonicalDomainRef(value, `${context}[${index}]`);
      return {
        value: checked,
        bytes: canonicalBytes((writer) => encodeDomainRef(writer, checked)),
      };
    })
    .sort((left, right) => compareBytes(left.bytes, right.bytes));

  rejectDuplicateEntries(entries, context);
  return Object.freeze(entries.map((entry) => entry.value));
}

interface CanonicalEntry<T> {
  readonly value: T;
  readonly bytes: Uint8Array;
}

function rejectDuplicateEntries<T>(entries: readonly CanonicalEntry<T>[], context: string): void {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1] as CanonicalEntry<T>;
    const current = entries[index] as CanonicalEntry<T>;
    if (compareBytes(previous.bytes, current.bytes) === 0) {
      throw new DuplicateElementError(context, `duplicate canonical element at sorted index ${index}`);
    }
  }
}

function canonicalProtocolIdSet(
  values: readonly string[],
  context: string,
  allowEmpty = false,
): readonly ProtocolId[] {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new MalformedInputError(context, allowEmpty ? 'expected an array' : 'set or array is empty');
  }
  const entries = values
    .map((value, index) => {
      const checked = protocolId(value, `${context}[${index}]`);
      return {
        value: checked,
        bytes: canonicalBytes((writer) => encodeProtocolId(writer, checked, context)),
      };
    })
    .sort((left, right) => compareBytes(left.bytes, right.bytes));

  rejectDuplicateEntries(entries, context);
  return Object.freeze(entries.map((entry) => entry.value));
}

function canonicalEnumSet<Name extends string>(
  values: readonly Name[],
  table: EnumTable<Name>,
  context: string,
): readonly Name[] {
  const entries = nonemptyArray(values, context)
    .map((value, index) => {
      enumDiscriminant(table, value, `${context}[${index}]`);
      return {
        value,
        bytes: canonicalBytes((writer) => writer.writeEnum(table, value, context)),
      };
    })
    .sort((left, right) => compareBytes(left.bytes, right.bytes));

  rejectDuplicateEntries(entries, context);
  return Object.freeze(entries.map((entry) => entry.value));
}

function orderedLegTypes(
  values: readonly string[],
  legCount: number,
  context: string,
): readonly ProtocolId[] {
  const checked = nonemptyArray(values, context);
  if (checked.length !== legCount) {
    throw new MalformedInputError(
      context,
      `expected ${legCount} leg types, received ${checked.length}`,
    );
  }
  return Object.freeze(
    checked.map((value, index) => protocolId(value, `${context}[${index}]`)),
  );
}

function copiedManifestHash(value: ManifestHash): ManifestHash {
  return Uint8Array.from(value) as ManifestHash;
}

export function packageTemplateManifest(
  input: PackageTemplateManifestInput,
  context = 'packageTemplateManifest',
): PackageTemplateManifest {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a package template manifest object');
  }

  const manifestVersion = nonzeroU32(input.manifestVersion, `${context}.manifestVersion`);
  if (manifestVersion !== 1 && manifestVersion !== 2) {
    throw new MalformedInputError(`${context}.manifestVersion`, 'supported manifest versions are 1 and 2');
  }
  const templateVersion = nonzeroU32(input.templateVersion, `${context}.templateVersion`);
  const supportedDomains = canonicalDomainSet(
    input.supportedDomains,
    `${context}.supportedDomains`,
  );
  const orderSchemaHash = manifestHash(input.orderSchemaHash, `${context}.orderSchemaHash`);
  const quoteSchemaHash = manifestHash(input.quoteSchemaHash, `${context}.quoteSchemaHash`);
  const routeSchemaHash = manifestHash(input.routeSchemaHash, `${context}.routeSchemaHash`);
  const receiptSchemaHash = manifestHash(
    input.receiptSchemaHash,
    `${context}.receiptSchemaHash`,
  );
  const entryCompilerVersion = nonzeroU32(
    input.entryCompilerVersion,
    `${context}.entryCompilerVersion`,
  );
  const exitCompilerVersion = nonzeroU32(
    input.exitCompilerVersion,
    `${context}.exitCompilerVersion`,
  );
  const legCount = nonzeroU32(input.legCount, `${context}.legCount`);
  const legTypes = orderedLegTypes(input.legTypes, legCount, `${context}.legTypes`);
  const supportedDirections = canonicalEnumSet(
    input.supportedDirections,
    DIRECTION,
    `${context}.supportedDirections`,
  );
  const supportedSettlementClasses = canonicalEnumSet(
    input.supportedSettlementClasses,
    SETTLEMENT_CLASS,
    `${context}.supportedSettlementClasses`,
  );
  const allowedSpotAdapterIds = canonicalProtocolIdSet(
    input.allowedSpotAdapterIds,
    `${context}.allowedSpotAdapterIds`,
    manifestVersion === 2,
  );
  const allowedPerpAdapterIds = canonicalProtocolIdSet(
    input.allowedPerpAdapterIds,
    `${context}.allowedPerpAdapterIds`,
    manifestVersion === 2,
  );
  const allowedAdapterIds = manifestVersion === 2
    ? canonicalProtocolIdSet(input.allowedAdapterIds ?? [], `${context}.allowedAdapterIds`)
    : undefined;
  if (manifestVersion === 1 && input.allowedAdapterIds !== undefined && input.allowedAdapterIds.length > 0) {
    throw new MalformedInputError(`${context}.allowedAdapterIds`, 'generic adapters require manifest version 2');
  }
  const riskPolicyHash = manifestHash(input.riskPolicyHash, `${context}.riskPolicyHash`);

  return Object.freeze({
    manifestVersion,
    environment: protocolId(input.environment, `${context}.environment`),
    templateId: protocolId(input.templateId, `${context}.templateId`),
    templateVersion,
    supportedDomains,
    get orderSchemaHash(): ManifestHash {
      return copiedManifestHash(orderSchemaHash);
    },
    get quoteSchemaHash(): ManifestHash {
      return copiedManifestHash(quoteSchemaHash);
    },
    get routeSchemaHash(): ManifestHash {
      return copiedManifestHash(routeSchemaHash);
    },
    get receiptSchemaHash(): ManifestHash {
      return copiedManifestHash(receiptSchemaHash);
    },
    entryCompilerVersion,
    exitCompilerVersion,
    legCount,
    legTypes,
    supportedDirections,
    supportedSettlementClasses,
    allowedSpotAdapterIds,
    allowedPerpAdapterIds,
    ...(allowedAdapterIds === undefined ? {} : { allowedAdapterIds }),
    get riskPolicyHash(): ManifestHash {
      return copiedManifestHash(riskPolicyHash);
    },
  });
}

function canonicalManifestHash(value: ManifestHash, context: string): ManifestHash {
  if (!(value instanceof Uint8Array)) {
    throw new MalformedInputError(context, 'expected 32 canonical bytes');
  }
  return manifestHash(value, context);
}

function checkedPackageTemplateManifest(
  value: PackageTemplateManifest,
  context: string,
): PackageTemplateManifest {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a package template manifest object');
  }
  return packageTemplateManifest(
    {
      manifestVersion: value.manifestVersion,
      environment: value.environment,
      templateId: value.templateId,
      templateVersion: value.templateVersion,
      supportedDomains: value.supportedDomains,
      orderSchemaHash: canonicalManifestHash(
        value.orderSchemaHash,
        `${context}.orderSchemaHash`,
      ),
      quoteSchemaHash: canonicalManifestHash(
        value.quoteSchemaHash,
        `${context}.quoteSchemaHash`,
      ),
      routeSchemaHash: canonicalManifestHash(
        value.routeSchemaHash,
        `${context}.routeSchemaHash`,
      ),
      receiptSchemaHash: canonicalManifestHash(
        value.receiptSchemaHash,
        `${context}.receiptSchemaHash`,
      ),
      entryCompilerVersion: value.entryCompilerVersion,
      exitCompilerVersion: value.exitCompilerVersion,
      legCount: value.legCount,
      legTypes: value.legTypes,
      supportedDirections: value.supportedDirections,
      supportedSettlementClasses: value.supportedSettlementClasses,
      allowedSpotAdapterIds: value.allowedSpotAdapterIds,
      allowedPerpAdapterIds: value.allowedPerpAdapterIds,
      ...(value.allowedAdapterIds === undefined ? {} : { allowedAdapterIds: value.allowedAdapterIds }),
      riskPolicyHash: canonicalManifestHash(
        value.riskPolicyHash,
        `${context}.riskPolicyHash`,
      ),
    },
    context,
  );
}

export function encodePackageTemplateManifest(
  writer: CanonicalWriter,
  value: PackageTemplateManifest,
): void {
  const checked = checkedPackageTemplateManifest(value, 'packageTemplateManifest');
  writer.writeU32(checked.manifestVersion, 'packageTemplateManifest.manifestVersion');
  encodeProtocolId(writer, checked.environment, 'packageTemplateManifest.environment');
  encodeProtocolId(writer, checked.templateId, 'packageTemplateManifest.templateId');
  writer.writeU32(checked.templateVersion, 'packageTemplateManifest.templateVersion');
  writer.writeSet(
    checked.supportedDomains,
    (target, domain) => encodeDomainRef(target, domain),
    'packageTemplateManifest.supportedDomains',
  );
  encodeManifestHash(writer, checked.orderSchemaHash, 'packageTemplateManifest.orderSchemaHash');
  encodeManifestHash(writer, checked.quoteSchemaHash, 'packageTemplateManifest.quoteSchemaHash');
  encodeManifestHash(writer, checked.routeSchemaHash, 'packageTemplateManifest.routeSchemaHash');
  encodeManifestHash(
    writer,
    checked.receiptSchemaHash,
    'packageTemplateManifest.receiptSchemaHash',
  );
  writer.writeU32(
    checked.entryCompilerVersion,
    'packageTemplateManifest.entryCompilerVersion',
  );
  writer.writeU32(
    checked.exitCompilerVersion,
    'packageTemplateManifest.exitCompilerVersion',
  );
  writer.writeU32(checked.legCount, 'packageTemplateManifest.legCount');
  writer.writeArray(
    checked.legTypes,
    (target, legType) =>
      encodeProtocolId(target, legType, 'packageTemplateManifest.legTypes.element'),
    'packageTemplateManifest.legTypes',
  );
  writer.writeSet(
    checked.supportedDirections,
    (target, direction) =>
      target.writeEnum(
        DIRECTION,
        direction,
        'packageTemplateManifest.supportedDirections.element',
      ),
    'packageTemplateManifest.supportedDirections',
  );
  writer.writeSet(
    checked.supportedSettlementClasses,
    (target, settlementClass) =>
      target.writeEnum(
        SETTLEMENT_CLASS,
        settlementClass,
        'packageTemplateManifest.supportedSettlementClasses.element',
      ),
    'packageTemplateManifest.supportedSettlementClasses',
  );
  writer.writeSet(
    checked.allowedSpotAdapterIds,
    (target, adapterId) =>
      encodeProtocolId(
        target,
        adapterId,
        'packageTemplateManifest.allowedSpotAdapterIds.element',
      ),
    'packageTemplateManifest.allowedSpotAdapterIds',
  );
  writer.writeSet(
    checked.allowedPerpAdapterIds,
    (target, adapterId) =>
      encodeProtocolId(
        target,
        adapterId,
        'packageTemplateManifest.allowedPerpAdapterIds.element',
      ),
    'packageTemplateManifest.allowedPerpAdapterIds',
  );
  if (checked.manifestVersion === 2) {
    writer.writeSet(
      checked.allowedAdapterIds as readonly ProtocolId[],
      (target, adapterId) =>
        encodeProtocolId(
          target,
          adapterId,
          'packageTemplateManifest.allowedAdapterIds.element',
        ),
      'packageTemplateManifest.allowedAdapterIds',
    );
  }
  encodeManifestHash(writer, checked.riskPolicyHash, 'packageTemplateManifest.riskPolicyHash');
}

export function packageTemplateManifestBytes(
  value: PackageTemplateManifestInput,
): Uint8Array {
  const checked = packageTemplateManifest(value, 'packageTemplateManifest');
  return canonicalBytes((writer) => encodePackageTemplateManifest(writer, checked));
}

export function packageTemplateManifestHash(
  value: PackageTemplateManifestInput,
): ManifestHash {
  return manifestHash(
    domainHash(
      HASH_DOMAIN.PACKAGE_TEMPLATE,
      packageTemplateManifestBytes(value),
      'packageTemplateManifestHash',
    ),
    'packageTemplateManifestHash',
  );
}
