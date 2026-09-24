import { checkedUnsigned } from './arithmetic.js';
import { bytesEqual } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { enumDiscriminant, SETTLEMENT_CLASS, type SettlementClass } from './enums.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  domainRef,
  encodeDomainRef,
  encodeHash32,
  encodeManifestHash,
  encodeProtocolId,
  hash32,
  manifestHash,
  protocolId,
  type DomainRef,
  type Hash32,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const VERSION_BITS = 32;
const PACKAGE_UNIT_BITS = 128;

export const CASH_CARRY_SERIES_SCHEMA_VERSION = 1;
export const CASH_CARRY_TEMPLATE_ID = 'cash-and-carry-v1';
export const CASH_CARRY_TEMPLATE_VERSION = 1;
export const CASH_CARRY_SETTLEMENT_CLASS = 'ATOMIC_POSTCONDITION';
export const CASH_CARRY_SETTLEMENT_CLASS_VERSION = 1;
export const CASH_CARRY_QUOTE_CONVENTION = 'annualized-net-yield-v1';
export const CASH_CARRY_ENTRY_SIDE = Object.freeze({ ASK: 1 } as const);

export type CashCarryEntrySide = keyof typeof CASH_CARRY_ENTRY_SIDE;

export interface SeriesManifestRefInput {
  readonly subjectIdentity: Uint8Array | string;
  readonly manifestVersion: number;
  readonly manifestHash: Uint8Array | string;
}

export interface SeriesManifestRef {
  readonly subjectIdentity: Hash32;
  readonly manifestVersion: number;
  readonly manifestHash: ManifestHash;
}

export interface CashCarrySeriesIdentityInput {
  readonly domain: DomainRef;
  readonly seriesManifestHash: Uint8Array | string;
  readonly executionClassManifestHash: Uint8Array | string;
}

export interface CashCarrySeriesBindingV1Input extends CashCarrySeriesIdentityInput {
  readonly schemaVersion: number;
  readonly bindingVersion: number;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateManifestHash: Uint8Array | string;
  readonly settlementClass: SettlementClass;
  readonly settlementClassVersion: number;
  readonly baseAsset: SeriesManifestRefInput;
  readonly quoteAsset: SeriesManifestRefInput;
  readonly quoteConvention: string;
  readonly entrySide: CashCarryEntrySide;
  readonly spotBaseAtomsPerPackageUnit: bigint;
  readonly perpQuantityAtomsPerPackageUnit: bigint;
}

export interface CashCarrySeriesBindingV1 {
  readonly schemaVersion: typeof CASH_CARRY_SERIES_SCHEMA_VERSION;
  readonly bindingVersion: number;
  readonly domain: DomainRef;
  readonly seriesManifestHash: ManifestHash;
  readonly executionClassManifestHash: ManifestHash;
  readonly templateId: ProtocolId;
  readonly templateVersion: typeof CASH_CARRY_TEMPLATE_VERSION;
  readonly templateManifestHash: ManifestHash;
  readonly settlementClass: typeof CASH_CARRY_SETTLEMENT_CLASS;
  readonly settlementClassVersion: typeof CASH_CARRY_SETTLEMENT_CLASS_VERSION;
  readonly baseAsset: SeriesManifestRef;
  readonly quoteAsset: SeriesManifestRef;
  readonly quoteConvention: ProtocolId;
  readonly entrySide: 'ASK';
  readonly spotBaseAtomsPerPackageUnit: bigint;
  readonly perpQuantityAtomsPerPackageUnit: bigint;
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

function nonzeroU128(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  const checked = checkedUnsigned(value, PACKAGE_UNIT_BITS, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'package unit quantity is zero');
  }
  return checked;
}

function checkedHash32(value: Uint8Array | string, context: string): Hash32 {
  const checked = hash32(value, context);
  if (checked.every((byte) => byte === 0)) {
    throw new MalformedInputError(context, 'identity hash is all zero');
  }
  return checked;
}

function copiedHash32(value: Hash32): Hash32 {
  return Uint8Array.from(value) as Hash32;
}

function copiedManifestHash(value: ManifestHash): ManifestHash {
  return Uint8Array.from(value) as ManifestHash;
}

function exactVersion(value: number, expected: number, context: string): number {
  const checked = nonzeroU32(value, context);
  if (checked !== expected) {
    throw new MalformedInputError(context, `expected version ${expected}`);
  }
  return checked;
}

function exactProtocolId(value: string, expected: string, context: string): ProtocolId {
  const checked = protocolId(value, context);
  if (checked !== expected) {
    throw new MalformedInputError(context, `expected ${expected}`);
  }
  return checked;
}

function exactDomainRef(value: DomainRef, context: string): DomainRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a domain reference object');
  }
  return domainRef(
    value.domainId,
    value.domainManifestVersion,
    value.domainManifestHash,
    context,
  );
}

export function protocolIdIdentityHash(
  value: string,
  context = 'protocolIdIdentityHash',
): Hash32 {
  const checked = protocolId(value, `${context}.protocolId`);
  return domainHash(
    HASH_DOMAIN.PROTOCOL_ID_IDENTITY,
    canonicalBytes((writer) => encodeProtocolId(writer, checked, `${context}.protocolId`)),
    context,
  );
}

export function domainRefIdentityHash(
  value: DomainRef,
  context = 'domainRefIdentityHash',
): Hash32 {
  const checked = exactDomainRef(value, `${context}.domain`);
  return domainHash(
    HASH_DOMAIN.DOMAIN_REF_IDENTITY,
    canonicalBytes((writer) => encodeDomainRef(writer, checked)),
    context,
  );
}

export function settlementClassIdentityHash(
  settlementClass: SettlementClass,
  settlementClassVersion: number,
  context = 'settlementClassIdentityHash',
): Hash32 {
  enumDiscriminant(SETTLEMENT_CLASS, settlementClass, `${context}.settlementClass`);
  const version = nonzeroU32(settlementClassVersion, `${context}.settlementClassVersion`);
  return domainHash(
    HASH_DOMAIN.SETTLEMENT_CLASS_IDENTITY,
    canonicalBytes((writer) => {
      writer.writeEnum(
        SETTLEMENT_CLASS,
        settlementClass,
        `${context}.settlementClass`,
      );
      writer.writeU32(version, `${context}.settlementClassVersion`);
    }),
    context,
  );
}

function frozenSeriesManifestRef(
  subjectIdentity: Hash32,
  manifestVersion: number,
  manifestHash_: ManifestHash,
): SeriesManifestRef {
  return Object.freeze({
    get subjectIdentity(): Hash32 {
      return copiedHash32(subjectIdentity);
    },
    manifestVersion,
    get manifestHash(): ManifestHash {
      return copiedManifestHash(manifestHash_);
    },
  });
}

export function seriesManifestRef(
  input: SeriesManifestRefInput,
  context = 'seriesManifestRef',
): SeriesManifestRef {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a manifest reference object');
  }
  return frozenSeriesManifestRef(
    checkedHash32(input.subjectIdentity, `${context}.subjectIdentity`),
    nonzeroU32(input.manifestVersion, `${context}.manifestVersion`),
    manifestHash(input.manifestHash, `${context}.manifestHash`),
  );
}

export function encodeSeriesManifestRef(
  writer: CanonicalWriter,
  value: SeriesManifestRef,
): void {
  if (!(value.subjectIdentity instanceof Uint8Array)) {
    throw new MalformedInputError(
      'seriesManifestRef.subjectIdentity',
      'expected 32 canonical bytes',
    );
  }
  if (!(value.manifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(
      'seriesManifestRef.manifestHash',
      'expected 32 canonical bytes',
    );
  }
  const checked = seriesManifestRef(value);
  encodeHash32(writer, checked.subjectIdentity);
  writer.writeU32(checked.manifestVersion, 'seriesManifestRef.manifestVersion');
  encodeManifestHash(writer, checked.manifestHash, 'seriesManifestRef.manifestHash');
}

function checkedIdentity(input: CashCarrySeriesIdentityInput, context: string) {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a series identity object');
  }
  return {
    domain: exactDomainRef(input.domain, `${context}.domain`),
    seriesManifestHash: manifestHash(
      input.seriesManifestHash,
      `${context}.seriesManifestHash`,
    ),
    executionClassManifestHash: manifestHash(
      input.executionClassManifestHash,
      `${context}.executionClassManifestHash`,
    ),
  };
}

export function cashCarrySeriesIdentityKey(
  input: CashCarrySeriesIdentityInput,
): Hash32 {
  const checked = checkedIdentity(input, 'cashCarrySeriesIdentity');
  return domainHash(
    HASH_DOMAIN.CASH_CARRY_SERIES_IDENTITY,
    canonicalBytes((writer) => {
      encodeHash32(writer, domainRefIdentityHash(checked.domain));
      encodeManifestHash(
        writer,
        checked.seriesManifestHash,
        'cashCarrySeriesIdentity.seriesManifestHash',
      );
      encodeManifestHash(
        writer,
        checked.executionClassManifestHash,
        'cashCarrySeriesIdentity.executionClassManifestHash',
      );
    }),
    'cashCarrySeriesIdentityKey',
  );
}

export function cashCarrySeriesBindingV1(
  input: CashCarrySeriesBindingV1Input,
  context = 'cashCarrySeriesBindingV1',
): CashCarrySeriesBindingV1 {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a cash carry series binding object');
  }
  exactVersion(input.schemaVersion, CASH_CARRY_SERIES_SCHEMA_VERSION, `${context}.schemaVersion`);
  const identity = checkedIdentity(input, context);
  const baseAsset = seriesManifestRef(input.baseAsset, `${context}.baseAsset`);
  const quoteAsset = seriesManifestRef(input.quoteAsset, `${context}.quoteAsset`);
  if (bytesEqual(baseAsset.subjectIdentity, quoteAsset.subjectIdentity)) {
    throw new MalformedInputError(context, 'base and quote asset identities are equal');
  }
  if (input.settlementClass !== CASH_CARRY_SETTLEMENT_CLASS) {
    throw new MalformedInputError(
      `${context}.settlementClass`,
      `expected ${CASH_CARRY_SETTLEMENT_CLASS}`,
    );
  }
  enumDiscriminant(SETTLEMENT_CLASS, input.settlementClass, `${context}.settlementClass`);
  if (input.entrySide !== 'ASK') {
    throw new MalformedInputError(`${context}.entrySide`, 'expected ASK');
  }
  const templateManifestHash = manifestHash(
    input.templateManifestHash,
    `${context}.templateManifestHash`,
  );
  return Object.freeze({
    schemaVersion: CASH_CARRY_SERIES_SCHEMA_VERSION,
    bindingVersion: nonzeroU32(input.bindingVersion, `${context}.bindingVersion`),
    domain: identity.domain,
    get seriesManifestHash(): ManifestHash {
      return copiedManifestHash(identity.seriesManifestHash);
    },
    get executionClassManifestHash(): ManifestHash {
      return copiedManifestHash(identity.executionClassManifestHash);
    },
    templateId: exactProtocolId(
      input.templateId,
      CASH_CARRY_TEMPLATE_ID,
      `${context}.templateId`,
    ),
    templateVersion: exactVersion(
      input.templateVersion,
      CASH_CARRY_TEMPLATE_VERSION,
      `${context}.templateVersion`,
    ) as typeof CASH_CARRY_TEMPLATE_VERSION,
    get templateManifestHash(): ManifestHash {
      return copiedManifestHash(templateManifestHash);
    },
    settlementClass: CASH_CARRY_SETTLEMENT_CLASS,
    settlementClassVersion: exactVersion(
      input.settlementClassVersion,
      CASH_CARRY_SETTLEMENT_CLASS_VERSION,
      `${context}.settlementClassVersion`,
    ) as typeof CASH_CARRY_SETTLEMENT_CLASS_VERSION,
    baseAsset,
    quoteAsset,
    quoteConvention: exactProtocolId(
      input.quoteConvention,
      CASH_CARRY_QUOTE_CONVENTION,
      `${context}.quoteConvention`,
    ),
    entrySide: 'ASK',
    spotBaseAtomsPerPackageUnit: nonzeroU128(
      input.spotBaseAtomsPerPackageUnit,
      `${context}.spotBaseAtomsPerPackageUnit`,
    ),
    perpQuantityAtomsPerPackageUnit: nonzeroU128(
      input.perpQuantityAtomsPerPackageUnit,
      `${context}.perpQuantityAtomsPerPackageUnit`,
    ),
  });
}

function checkedBinding(value: CashCarrySeriesBindingV1): CashCarrySeriesBindingV1 {
  const hashes = [
    value.domain?.domainManifestHash,
    value.seriesManifestHash,
    value.executionClassManifestHash,
    value.templateManifestHash,
    value.baseAsset?.subjectIdentity,
    value.baseAsset?.manifestHash,
    value.quoteAsset?.subjectIdentity,
    value.quoteAsset?.manifestHash,
  ];
  if (hashes.some((hash) => !(hash instanceof Uint8Array))) {
    throw new MalformedInputError('cashCarrySeriesBindingV1', 'expected canonical hash bytes');
  }
  return cashCarrySeriesBindingV1(value);
}

export function encodeCashCarrySeriesBindingV1(
  writer: CanonicalWriter,
  value: CashCarrySeriesBindingV1,
): void {
  const checked = checkedBinding(value);
  writer.writeU32(checked.schemaVersion, 'cashCarrySeriesBindingV1.schemaVersion');
  writer.writeU32(checked.bindingVersion, 'cashCarrySeriesBindingV1.bindingVersion');
  encodeHash32(writer, domainRefIdentityHash(checked.domain));
  encodeManifestHash(
    writer,
    checked.seriesManifestHash,
    'cashCarrySeriesBindingV1.seriesManifestHash',
  );
  encodeManifestHash(
    writer,
    checked.executionClassManifestHash,
    'cashCarrySeriesBindingV1.executionClassManifestHash',
  );
  encodeHash32(writer, protocolIdIdentityHash(checked.templateId));
  writer.writeU32(checked.templateVersion, 'cashCarrySeriesBindingV1.templateVersion');
  encodeManifestHash(
    writer,
    checked.templateManifestHash,
    'cashCarrySeriesBindingV1.templateManifestHash',
  );
  encodeHash32(
    writer,
    settlementClassIdentityHash(
      checked.settlementClass,
      checked.settlementClassVersion,
    ),
  );
  encodeSeriesManifestRef(writer, checked.baseAsset);
  encodeSeriesManifestRef(writer, checked.quoteAsset);
  encodeHash32(writer, protocolIdIdentityHash(checked.quoteConvention));
  writer.writeU8(CASH_CARRY_ENTRY_SIDE[checked.entrySide], 'cashCarrySeriesBindingV1.entrySide');
  writer.writeU128(
    checked.spotBaseAtomsPerPackageUnit,
    'cashCarrySeriesBindingV1.spotBaseAtomsPerPackageUnit',
  );
  writer.writeU128(
    checked.perpQuantityAtomsPerPackageUnit,
    'cashCarrySeriesBindingV1.perpQuantityAtomsPerPackageUnit',
  );
}

export function cashCarrySeriesBindingV1Bytes(
  input: CashCarrySeriesBindingV1Input,
): Uint8Array {
  const checked = cashCarrySeriesBindingV1(input);
  return canonicalBytes((writer) => encodeCashCarrySeriesBindingV1(writer, checked));
}

export function cashCarrySeriesBindingV1Hash(
  input: CashCarrySeriesBindingV1Input,
): ManifestHash {
  return manifestHash(
    domainHash(
      HASH_DOMAIN.CASH_CARRY_SERIES_BINDING,
      cashCarrySeriesBindingV1Bytes(input),
      'cashCarrySeriesBindingV1Hash',
    ),
    'cashCarrySeriesBindingV1Hash',
  );
}
