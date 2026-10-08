import { checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { enumDiscriminant, SETTLEMENT_CLASS, type SettlementClass } from './enums.js';
import { DuplicateElementError, MalformedInputError, RangeViolationError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  assetRef,
  domainRef,
  encodeAssetRef,
  encodeDomainRef,
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

export const RISK_DOMAIN_MANIFEST_SCHEMA_VERSION = 1;
export const RISK_DOMAIN_MAX_ELIGIBLE_DOMAINS = 16;
export const RISK_DOMAIN_MAX_ELIGIBLE_SERIES = 64;
export const RISK_DOMAIN_MAX_DEPENDENCY_LIMITS = 128;

const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const BPS = 10_000n;
const MAXIMUM_LEVERAGE_BPS = 1_000_000n;

export interface RiskDomainHaircutsInput {
  readonly basis: bigint;
  readonly liquidity: bigint;
  readonly latency: bigint;
  readonly oracle: bigint;
  readonly venue: bigint;
  readonly bridge: bigint;
  readonly issuer: bigint;
  readonly recovery: bigint;
}

export interface RiskDomainDependencyLimitInput {
  readonly dependencyId: string;
  readonly maximumGrossQuoteAtoms: bigint;
}

export interface RiskDomainDependencyLimit {
  readonly dependencyId: ProtocolId;
  readonly maximumGrossQuoteAtoms: bigint;
}

export interface RiskDomainManifestInput {
  readonly schemaVersion: number;
  readonly manifestVersion: number;
  readonly environment: string;
  readonly riskDomainId: string;
  readonly accountingAsset: AssetRef;
  readonly eligibleDomains: readonly DomainRef[];
  readonly eligibleSeries: readonly VersionedManifestRef[];
  readonly settlementClasses: readonly SettlementClass[];
  readonly grossCapQuoteAtoms: bigint;
  readonly netCapQuoteAtoms: bigint;
  readonly minimumMarginFloorQuoteAtoms: bigint;
  readonly maximumLeverageBps: bigint;
  readonly maximumStalenessMs: bigint;
  readonly maximumTimeToUnwindMs: bigint;
  readonly requiredRecoveryReserveQuoteAtoms: bigint;
  readonly haircutsBps: RiskDomainHaircutsInput;
  readonly dependencyLimits: readonly RiskDomainDependencyLimitInput[];
}

export interface RiskDomainManifest extends Omit<RiskDomainManifestInput,
  'schemaVersion' | 'environment' | 'riskDomainId' | 'accountingAsset' | 'eligibleDomains' |
  'eligibleSeries' | 'settlementClasses' | 'dependencyLimits'> {
  readonly schemaVersion: 1;
  readonly environment: ProtocolId;
  readonly riskDomainId: ProtocolId;
  readonly accountingAsset: AssetRef;
  readonly eligibleDomains: readonly DomainRef[];
  readonly eligibleSeries: readonly VersionedManifestRef[];
  readonly settlementClasses: readonly SettlementClass[];
  readonly dependencyLimits: readonly RiskDomainDependencyLimit[];
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an object');
  }
}

function fixedVersion(value: number, expected: number, context: string): 1 {
  if (typeof value !== 'number') throw new MalformedInputError(context, 'expected a number');
  const checked = Number(checkedUnsigned(value, U32_BITS, context));
  if (checked !== expected) throw new MalformedInputError(context, `version must equal ${expected}`);
  return 1;
}

function nonzeroVersion(value: number, context: string): number {
  if (typeof value !== 'number') throw new MalformedInputError(context, 'expected a number');
  const checked = Number(checkedUnsigned(value, U32_BITS, context));
  if (checked === 0) throw new MalformedInputError(context, 'version is zero');
  return checked;
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function positive(value: bigint, bits: number, context: string): bigint {
  const checked = unsigned(value, bits, context);
  if (checked === 0n) throw new MalformedInputError(context, 'value is zero');
  return checked;
}

function bounded<T>(values: readonly T[], maximum: number, context: string): readonly T[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new MalformedInputError(context, 'expected a nonempty array');
  }
  if (values.length > maximum) throw new RangeViolationError(context, `more than ${maximum} entries`);
  return values;
}

function canonicalSet<T>(
  values: readonly T[],
  encode: (writer: CanonicalWriter, value: T) => void,
  context: string,
): readonly T[] {
  const entries = values
    .map((value) => ({ value, bytes: canonicalBytes((writer) => encode(writer, value)) }))
    .sort((left, right) => compareBytes(left.bytes, right.bytes));
  for (let index = 1; index < entries.length; index += 1) {
    if (compareBytes(entries[index - 1]!.bytes, entries[index]!.bytes) === 0) {
      throw new DuplicateElementError(context, `duplicate element at sorted index ${index}`);
    }
  }
  return Object.freeze(entries.map((entry) => entry.value));
}

function checkedAsset(value: AssetRef, context: string): AssetRef {
  object(value, context);
  return assetRef(value.assetId, value.assetManifestHash, value.decimals, context);
}

function checkedDomain(value: DomainRef, context: string): DomainRef {
  object(value, context);
  return domainRef(value.domainId, value.domainManifestVersion, value.domainManifestHash, context);
}

function checkedSeries(value: VersionedManifestRef, context: string): VersionedManifestRef {
  object(value, context);
  return versionedManifestRef(value.subjectId, value.manifestVersion, value.manifestHash, context);
}

const HAIRCUT_KEYS = ['basis', 'bridge', 'issuer', 'latency', 'liquidity', 'oracle', 'recovery', 'venue'] as const;

function checkedHaircuts(value: RiskDomainHaircutsInput, context: string): RiskDomainHaircutsInput {
  object(value, context);
  const keys = Object.keys(value).sort();
  if (keys.length !== HAIRCUT_KEYS.length || keys.some((key, index) => key !== HAIRCUT_KEYS[index])) {
    throw new MalformedInputError(context, `expected exactly ${HAIRCUT_KEYS.join(', ')}`);
  }
  const checked = {
    basis: unsigned(value.basis, U64_BITS, `${context}.basis`),
    liquidity: unsigned(value.liquidity, U64_BITS, `${context}.liquidity`),
    latency: unsigned(value.latency, U64_BITS, `${context}.latency`),
    oracle: unsigned(value.oracle, U64_BITS, `${context}.oracle`),
    venue: unsigned(value.venue, U64_BITS, `${context}.venue`),
    bridge: unsigned(value.bridge, U64_BITS, `${context}.bridge`),
    issuer: unsigned(value.issuer, U64_BITS, `${context}.issuer`),
    recovery: unsigned(value.recovery, U64_BITS, `${context}.recovery`),
  } as const;
  const total = Object.values(checked).reduce((sum, amount) => sum + amount, 0n);
  if (Object.values(checked).some((amount) => amount > BPS) || total > BPS) {
    throw new RangeViolationError(context, 'haircuts exceed 10000 basis points');
  }
  return Object.freeze(checked);
}

function encodeHaircuts(writer: CanonicalWriter, value: RiskDomainHaircutsInput, context: string): void {
  writer.writeU64(value.basis, `${context}.basis`);
  writer.writeU64(value.liquidity, `${context}.liquidity`);
  writer.writeU64(value.latency, `${context}.latency`);
  writer.writeU64(value.oracle, `${context}.oracle`);
  writer.writeU64(value.venue, `${context}.venue`);
  writer.writeU64(value.bridge, `${context}.bridge`);
  writer.writeU64(value.issuer, `${context}.issuer`);
  writer.writeU64(value.recovery, `${context}.recovery`);
}

function encodeDependencyLimit(writer: CanonicalWriter, value: RiskDomainDependencyLimit, context: string): void {
  encodeProtocolId(writer, value.dependencyId, `${context}.dependencyId`);
  writer.writeU128(value.maximumGrossQuoteAtoms, `${context}.maximumGrossQuoteAtoms`);
}

export function riskDomainManifest(
  input: RiskDomainManifestInput,
  context = 'riskDomainManifest',
): RiskDomainManifest {
  object(input, context);
  const grossCapQuoteAtoms = positive(input.grossCapQuoteAtoms, U128_BITS, `${context}.grossCapQuoteAtoms`);
  const netCapQuoteAtoms = positive(input.netCapQuoteAtoms, U128_BITS, `${context}.netCapQuoteAtoms`);
  const minimumMarginFloorQuoteAtoms = positive(
    input.minimumMarginFloorQuoteAtoms,
    U128_BITS,
    `${context}.minimumMarginFloorQuoteAtoms`,
  );
  if (netCapQuoteAtoms > grossCapQuoteAtoms) {
    throw new MalformedInputError(`${context}.netCapQuoteAtoms`, 'net cap exceeds gross cap');
  }
  if (minimumMarginFloorQuoteAtoms > grossCapQuoteAtoms) {
    throw new MalformedInputError(`${context}.minimumMarginFloorQuoteAtoms`, 'margin floor exceeds gross cap');
  }
  const maximumLeverageBps = positive(input.maximumLeverageBps, U64_BITS, `${context}.maximumLeverageBps`);
  if (maximumLeverageBps > MAXIMUM_LEVERAGE_BPS) {
    throw new RangeViolationError(`${context}.maximumLeverageBps`, 'leverage exceeds 100x');
  }
  const domains = bounded(input.eligibleDomains, RISK_DOMAIN_MAX_ELIGIBLE_DOMAINS, `${context}.eligibleDomains`)
    .map((value, index) => checkedDomain(value, `${context}.eligibleDomains[${index}]`));
  const series = bounded(input.eligibleSeries, RISK_DOMAIN_MAX_ELIGIBLE_SERIES, `${context}.eligibleSeries`)
    .map((value, index) => checkedSeries(value, `${context}.eligibleSeries[${index}]`));
  const settlementClasses = bounded(
    input.settlementClasses,
    Object.keys(SETTLEMENT_CLASS).length,
    `${context}.settlementClasses`,
  ).map((value, index) => {
    enumDiscriminant(SETTLEMENT_CLASS, value, `${context}.settlementClasses[${index}]`);
    return value;
  });
  const dependencyLimits = bounded(
    input.dependencyLimits,
    RISK_DOMAIN_MAX_DEPENDENCY_LIMITS,
    `${context}.dependencyLimits`,
  ).map((value, index) => {
    const at = `${context}.dependencyLimits[${index}]`;
    object(value, at);
    const maximumGrossQuoteAtoms = positive(value.maximumGrossQuoteAtoms, U128_BITS, `${at}.maximumGrossQuoteAtoms`);
    if (maximumGrossQuoteAtoms > grossCapQuoteAtoms) {
      throw new MalformedInputError(`${at}.maximumGrossQuoteAtoms`, 'dependency cap exceeds risk-domain gross cap');
    }
    return Object.freeze({
      dependencyId: protocolId(value.dependencyId, `${at}.dependencyId`),
      maximumGrossQuoteAtoms,
    });
  });
  return Object.freeze({
    schemaVersion: fixedVersion(input.schemaVersion, RISK_DOMAIN_MANIFEST_SCHEMA_VERSION, `${context}.schemaVersion`),
    manifestVersion: nonzeroVersion(input.manifestVersion, `${context}.manifestVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    riskDomainId: protocolId(input.riskDomainId, `${context}.riskDomainId`),
    accountingAsset: checkedAsset(input.accountingAsset, `${context}.accountingAsset`),
    eligibleDomains: canonicalSet(domains, encodeDomainRef, `${context}.eligibleDomains`),
    eligibleSeries: canonicalSet(series, encodeVersionedManifestRef, `${context}.eligibleSeries`),
    settlementClasses: canonicalSet(
      settlementClasses,
      (writer, value) => writer.writeEnum(SETTLEMENT_CLASS, value, 'settlementClass'),
      `${context}.settlementClasses`,
    ),
    grossCapQuoteAtoms,
    netCapQuoteAtoms,
    minimumMarginFloorQuoteAtoms,
    maximumLeverageBps,
    maximumStalenessMs: positive(input.maximumStalenessMs, U64_BITS, `${context}.maximumStalenessMs`),
    maximumTimeToUnwindMs: positive(input.maximumTimeToUnwindMs, U64_BITS, `${context}.maximumTimeToUnwindMs`),
    requiredRecoveryReserveQuoteAtoms: positive(
      input.requiredRecoveryReserveQuoteAtoms,
      U128_BITS,
      `${context}.requiredRecoveryReserveQuoteAtoms`,
    ),
    haircutsBps: checkedHaircuts(input.haircutsBps, `${context}.haircutsBps`),
    dependencyLimits: canonicalSet(
      dependencyLimits,
      (writer, value) => encodeDependencyLimit(writer, value, 'dependencyLimit'),
      `${context}.dependencyLimits`,
    ),
  });
}

export function encodeRiskDomainManifest(
  writer: CanonicalWriter,
  input: RiskDomainManifestInput,
  context = 'riskDomainManifest',
): void {
  const value = riskDomainManifest(input, context);
  writer.writeU32(value.schemaVersion, `${context}.schemaVersion`);
  writer.writeU32(value.manifestVersion, `${context}.manifestVersion`);
  encodeProtocolId(writer, value.environment, `${context}.environment`);
  encodeProtocolId(writer, value.riskDomainId, `${context}.riskDomainId`);
  encodeAssetRef(writer, value.accountingAsset);
  writer.writeArray(value.eligibleDomains, encodeDomainRef, `${context}.eligibleDomains`);
  writer.writeArray(value.eligibleSeries, encodeVersionedManifestRef, `${context}.eligibleSeries`);
  writer.writeArray(
    value.settlementClasses,
    (element, settlementClass) => element.writeEnum(SETTLEMENT_CLASS, settlementClass, 'settlementClass'),
    `${context}.settlementClasses`,
  );
  writer.writeU128(value.grossCapQuoteAtoms, `${context}.grossCapQuoteAtoms`);
  writer.writeU128(value.netCapQuoteAtoms, `${context}.netCapQuoteAtoms`);
  writer.writeU128(value.minimumMarginFloorQuoteAtoms, `${context}.minimumMarginFloorQuoteAtoms`);
  writer.writeU64(value.maximumLeverageBps, `${context}.maximumLeverageBps`);
  writer.writeU64(value.maximumStalenessMs, `${context}.maximumStalenessMs`);
  writer.writeU64(value.maximumTimeToUnwindMs, `${context}.maximumTimeToUnwindMs`);
  writer.writeU128(value.requiredRecoveryReserveQuoteAtoms, `${context}.requiredRecoveryReserveQuoteAtoms`);
  encodeHaircuts(writer, value.haircutsBps, `${context}.haircutsBps`);
  writer.writeArray(
    value.dependencyLimits,
    (element, dependencyLimit) => encodeDependencyLimit(element, dependencyLimit, 'dependencyLimit'),
    `${context}.dependencyLimits`,
  );
}

export function riskDomainManifestBytes(input: RiskDomainManifestInput): Uint8Array {
  return canonicalBytes((writer) => encodeRiskDomainManifest(writer, input));
}

export function riskDomainManifestHash(input: RiskDomainManifestInput): ManifestHash {
  return manifestHash(
    domainHash(HASH_DOMAIN.RISK_DOMAIN_MANIFEST, riskDomainManifestBytes(input)),
    'riskDomainManifestHash',
  );
}
