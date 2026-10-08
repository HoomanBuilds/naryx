import { checkedUnsigned } from './arithmetic.js';
import { compareBytes, toHex } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  SETTLEMENT_CLASS,
  type EnumTable,
  type SettlementClass,
} from './enums.js';
import { DuplicateElementError, MalformedInputError, RangeViolationError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  LEG_FAMILY,
  type LegFamily,
} from './package-graph.js';
import {
  adapterRef,
  commitmentHash,
  encodeAdapterRef,
  encodeCommitmentHash,
  type AdapterRef,
  type AdapterRefInput,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  assetRef,
  domainRef,
  encodeAssetRef,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  encodeVersionedManifestRef,
  manifestHash,
  protocolId,
  versionedManifestRef,
  type AssetRef,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
  type VersionedManifestRef,
} from './primitives.js';

export const NETTING_POLICY_SCHEMA_VERSION = 1;
export const NETTING_POLICY_VERSION = 2;
export const NETTING_POLICY_MAX_INSTRUMENTS = 512;
export const NETTING_POLICY_MAX_OBLIGATIONS = 512;

const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;

export const NETTING_ALLOCATION_RULE = Object.freeze({
  PRO_RATA_SEQUENCE: 1,
} as const);
export type NettingAllocationRule = keyof typeof NETTING_ALLOCATION_RULE;

export const NETTING_EXTERNAL_EXECUTION_MODE = Object.freeze({
  EXACT_NET_ONLY: 1,
} as const);
export type NettingExternalExecutionMode = keyof typeof NETTING_EXTERNAL_EXECUTION_MODE;

export const NETTING_CLEARING_RULE = Object.freeze({
  LIMIT_MIDPOINT_BUYER_FAVOR: 1,
} as const);
export type NettingClearingRule = keyof typeof NETTING_CLEARING_RULE;

export interface NettingInstrumentPolicyInput {
  readonly instrumentId: string;
  readonly domain: DomainRef;
  readonly adapter: AdapterRefInput;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly quantityAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly legFamily: LegFamily;
  readonly quantityIncrementAtoms: bigint;
  readonly priceTickQuoteAtoms: bigint;
}

export interface NettingInstrumentPolicy {
  readonly instrumentId: ProtocolId;
  readonly instrumentHash: CommitmentHash;
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly quantityAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly legFamily: LegFamily;
  readonly quantityIncrementAtoms: bigint;
  readonly priceTickQuoteAtoms: bigint;
}

export interface NettingPolicyManifestInput {
  readonly schemaVersion: number;
  readonly manifestVersion: number;
  readonly nettingPolicyVersion: number;
  readonly environment: string;
  readonly executionClassId: string;
  readonly executionClassVersion: number;
  readonly executionClassManifestHash: Uint8Array | string;
  readonly settlementClass: SettlementClass;
  readonly allocationRule: NettingAllocationRule;
  readonly externalExecutionMode: NettingExternalExecutionMode;
  readonly clearingRule: NettingClearingRule;
  readonly maximumObligations: number;
  readonly maximumBatchWindowMilliseconds: bigint;
  readonly instruments: readonly NettingInstrumentPolicyInput[];
}

export interface NettingPolicyManifest {
  readonly schemaVersion: 1;
  readonly manifestVersion: number;
  readonly nettingPolicyVersion: 2;
  readonly environment: ProtocolId;
  readonly executionClassId: ProtocolId;
  readonly executionClassVersion: number;
  readonly executionClassManifestHash: ManifestHash;
  readonly settlementClass: SettlementClass;
  readonly allocationRule: NettingAllocationRule;
  readonly externalExecutionMode: NettingExternalExecutionMode;
  readonly clearingRule: NettingClearingRule;
  readonly maximumObligations: number;
  readonly maximumBatchWindowMilliseconds: bigint;
  readonly instruments: readonly NettingInstrumentPolicy[];
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an object');
  }
}

function fixedVersion<const Version extends number>(value: number, expected: Version, context: string): Version {
  if (typeof value !== 'number') throw new MalformedInputError(context, 'expected a number');
  const checked = Number(checkedUnsigned(value, U32_BITS, context));
  if (checked !== expected) throw new MalformedInputError(context, `version must equal ${expected}`);
  return expected;
}

function nonzeroVersion(value: number, context: string): number {
  if (typeof value !== 'number') throw new MalformedInputError(context, 'expected a number');
  const checked = Number(checkedUnsigned(value, U32_BITS, context));
  if (checked === 0) throw new MalformedInputError(context, 'version is zero');
  return checked;
}

function positive(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  const checked = checkedUnsigned(value, bits, context);
  if (checked === 0n) throw new MalformedInputError(context, 'value is zero');
  return checked;
}

function boundedCount(value: number, maximum: number, context: string): number {
  if (typeof value !== 'number') throw new MalformedInputError(context, 'expected a number');
  const checked = Number(checkedUnsigned(value, U32_BITS, context));
  if (checked === 0) throw new MalformedInputError(context, 'value is zero');
  if (checked > maximum) throw new RangeViolationError(context, `value exceeds ${maximum}`);
  return checked;
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function canonicalDomain(value: DomainRef, context: string): DomainRef {
  object(value, context);
  return domainRef(value.domainId, value.domainManifestVersion, value.domainManifestHash, context);
}

function canonicalManifestRef(value: VersionedManifestRef, context: string): VersionedManifestRef {
  object(value, context);
  return versionedManifestRef(value.subjectId, value.manifestVersion, value.manifestHash, context);
}

function canonicalAsset(value: AssetRef, context: string): AssetRef {
  object(value, context);
  return assetRef(value.assetId, value.assetManifestHash, value.decimals, context);
}

interface CheckedInstrumentIdentity {
  readonly instrumentId: ProtocolId;
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly quantityAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly legFamily: LegFamily;
}

function checkedInstrumentIdentity(
  input: NettingInstrumentPolicyInput | NettingInstrumentPolicy,
  context: string,
): CheckedInstrumentIdentity {
  object(input, context);
  return Object.freeze({
    instrumentId: protocolId(input.instrumentId, `${context}.instrumentId`),
    domain: canonicalDomain(input.domain, `${context}.domain`),
    adapter: adapterRef(input.adapter, `${context}.adapter`),
    venue: canonicalManifestRef(input.venue, `${context}.venue`),
    market: canonicalManifestRef(input.market, `${context}.market`),
    quantityAsset: canonicalAsset(input.quantityAsset, `${context}.quantityAsset`),
    quoteAsset: canonicalAsset(input.quoteAsset, `${context}.quoteAsset`),
    legFamily: variant(LEG_FAMILY, input.legFamily, `${context}.legFamily`),
  });
}

function encodeInstrumentIdentity(
  writer: CanonicalWriter,
  value: CheckedInstrumentIdentity,
  context: string,
): void {
  encodeProtocolId(writer, value.instrumentId, `${context}.instrumentId`);
  encodeDomainRef(writer, value.domain);
  encodeAdapterRef(writer, value.adapter);
  encodeVersionedManifestRef(writer, value.venue);
  encodeVersionedManifestRef(writer, value.market);
  encodeAssetRef(writer, value.quantityAsset);
  encodeAssetRef(writer, value.quoteAsset);
  writer.writeEnum(LEG_FAMILY, value.legFamily, `${context}.legFamily`);
}

export function nettingInstrumentHash(
  input: NettingInstrumentPolicyInput | NettingInstrumentPolicy,
): CommitmentHash {
  const checked = checkedInstrumentIdentity(input, 'nettingInstrument');
  const payload = canonicalBytes((writer) => encodeInstrumentIdentity(writer, checked, 'nettingInstrument'));
  return commitmentHash(domainHash(HASH_DOMAIN.NETTING_INSTRUMENT, payload), 'nettingInstrumentHash');
}

function nettingInstrumentPolicy(
  input: NettingInstrumentPolicyInput | NettingInstrumentPolicy,
  context: string,
): NettingInstrumentPolicy {
  const identity = checkedInstrumentIdentity(input, context);
  const quantityIncrementAtoms = positive(
    input.quantityIncrementAtoms,
    U128_BITS,
    `${context}.quantityIncrementAtoms`,
  );
  const priceTickQuoteAtoms = positive(
    input.priceTickQuoteAtoms,
    U128_BITS,
    `${context}.priceTickQuoteAtoms`,
  );
  const instrumentHash = nettingInstrumentHash(input);
  if ('instrumentHash' in input && compareBytes(commitmentHash(input.instrumentHash, `${context}.instrumentHash`), instrumentHash) !== 0) {
    throw new MalformedInputError(`${context}.instrumentHash`, 'hash does not match the instrument identity');
  }
  return Object.freeze({ ...identity, instrumentHash, quantityIncrementAtoms, priceTickQuoteAtoms });
}

function encodeNettingInstrumentPolicy(
  writer: CanonicalWriter,
  value: NettingInstrumentPolicy,
  context: string,
): void {
  const checked = nettingInstrumentPolicy(value, context);
  encodeInstrumentIdentity(writer, checked, context);
  encodeCommitmentHash(writer, checked.instrumentHash, `${context}.instrumentHash`);
  writer.writeU128(checked.quantityIncrementAtoms, `${context}.quantityIncrementAtoms`);
  writer.writeU128(checked.priceTickQuoteAtoms, `${context}.priceTickQuoteAtoms`);
}

export function nettingPolicyManifest(
  input: NettingPolicyManifestInput | NettingPolicyManifest,
  context = 'nettingPolicyManifest',
): NettingPolicyManifest {
  object(input, context);
  if (!Array.isArray(input.instruments) || input.instruments.length === 0) {
    throw new MalformedInputError(`${context}.instruments`, 'expected a nonempty array');
  }
  if (input.instruments.length > NETTING_POLICY_MAX_INSTRUMENTS) {
    throw new RangeViolationError(`${context}.instruments`, `more than ${NETTING_POLICY_MAX_INSTRUMENTS} instruments`);
  }
  const instruments = input.instruments
    .map((instrument, index) => nettingInstrumentPolicy(instrument, `${context}.instruments[${index}]`))
    .sort((left, right) => left.instrumentId < right.instrumentId ? -1 : left.instrumentId > right.instrumentId ? 1 : 0);
  if (new Set(instruments.map((instrument) => instrument.instrumentId)).size !== instruments.length) {
    throw new DuplicateElementError(`${context}.instruments`, 'instrument ids repeat');
  }
  if (new Set(instruments.map((instrument) => toHex(instrument.instrumentHash))).size !== instruments.length) {
    throw new DuplicateElementError(`${context}.instruments`, 'instrument identities repeat');
  }
  return Object.freeze({
    schemaVersion: fixedVersion(input.schemaVersion, NETTING_POLICY_SCHEMA_VERSION, `${context}.schemaVersion`),
    manifestVersion: nonzeroVersion(input.manifestVersion, `${context}.manifestVersion`),
    nettingPolicyVersion: fixedVersion(input.nettingPolicyVersion, NETTING_POLICY_VERSION, `${context}.nettingPolicyVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    executionClassVersion: nonzeroVersion(input.executionClassVersion, `${context}.executionClassVersion`),
    executionClassManifestHash: manifestHash(input.executionClassManifestHash, `${context}.executionClassManifestHash`),
    settlementClass: variant(SETTLEMENT_CLASS, input.settlementClass, `${context}.settlementClass`),
    allocationRule: variant(NETTING_ALLOCATION_RULE, input.allocationRule, `${context}.allocationRule`),
    externalExecutionMode: variant(
      NETTING_EXTERNAL_EXECUTION_MODE,
      input.externalExecutionMode,
      `${context}.externalExecutionMode`,
    ),
    clearingRule: variant(NETTING_CLEARING_RULE, input.clearingRule, `${context}.clearingRule`),
    maximumObligations: boundedCount(
      input.maximumObligations,
      NETTING_POLICY_MAX_OBLIGATIONS,
      `${context}.maximumObligations`,
    ),
    maximumBatchWindowMilliseconds: positive(
      input.maximumBatchWindowMilliseconds,
      U64_BITS,
      `${context}.maximumBatchWindowMilliseconds`,
    ),
    instruments: Object.freeze(instruments),
  });
}

export function encodeNettingPolicyManifest(
  writer: CanonicalWriter,
  input: NettingPolicyManifestInput | NettingPolicyManifest,
  context = 'nettingPolicyManifest',
): void {
  const checked = nettingPolicyManifest(input, context);
  writer.writeU32(checked.schemaVersion, `${context}.schemaVersion`);
  writer.writeU32(checked.manifestVersion, `${context}.manifestVersion`);
  writer.writeU32(checked.nettingPolicyVersion, `${context}.nettingPolicyVersion`);
  encodeProtocolId(writer, checked.environment, `${context}.environment`);
  encodeProtocolId(writer, checked.executionClassId, `${context}.executionClassId`);
  writer.writeU32(checked.executionClassVersion, `${context}.executionClassVersion`);
  encodeManifestHash(writer, checked.executionClassManifestHash, `${context}.executionClassManifestHash`);
  writer.writeEnum(SETTLEMENT_CLASS, checked.settlementClass, `${context}.settlementClass`);
  writer.writeEnum(NETTING_ALLOCATION_RULE, checked.allocationRule, `${context}.allocationRule`);
  writer.writeEnum(
    NETTING_EXTERNAL_EXECUTION_MODE,
    checked.externalExecutionMode,
    `${context}.externalExecutionMode`,
  );
  writer.writeEnum(NETTING_CLEARING_RULE, checked.clearingRule, `${context}.clearingRule`);
  writer.writeU32(checked.maximumObligations, `${context}.maximumObligations`);
  writer.writeU64(checked.maximumBatchWindowMilliseconds, `${context}.maximumBatchWindowMilliseconds`);
  writer.writeArray(
    checked.instruments,
    (element, instrument) => encodeNettingInstrumentPolicy(element, instrument, `${context}.instruments.element`),
    `${context}.instruments`,
  );
}

export function nettingPolicyManifestBytes(
  input: NettingPolicyManifestInput | NettingPolicyManifest,
): Uint8Array {
  return canonicalBytes((writer) => encodeNettingPolicyManifest(writer, input));
}

export function nettingPolicyManifestHash(
  input: NettingPolicyManifestInput | NettingPolicyManifest,
): ManifestHash {
  return manifestHash(
    domainHash(HASH_DOMAIN.NETTING_POLICY, nettingPolicyManifestBytes(input)),
    'nettingPolicyManifestHash',
  );
}
