import { absBigInt, checkedSigned, checkedUnsigned, mulDiv } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  DIRECTION,
  enumDiscriminant,
  EXPIRY_UNIT,
  QUANTITY_POLICY_CLASS,
  SETTLEMENT_CLASS,
  type Direction,
  type EnumTable,
  type ExpiryUnit,
  type QuantityPolicyClass,
  type SettlementClass,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  encodeExactPrice,
  exactPrice,
  type CommitmentHash,
  type ExactPrice,
  type ExactPriceInput,
} from './package-order-primitives.js';
import {
  assetAmount,
  assetRef,
  domainRef,
  encodeAssetAmount,
  encodeAssetRef,
  encodeDomainRef,
  encodeProtocolId,
  encodeVersionedManifestRef,
  protocolId,
  versionedManifestRef,
  type AssetAmount,
  type AssetRef,
  type DomainRef,
  type ProtocolId,
  type VersionedManifestRef,
} from './primitives.js';

const U8_BITS = 8;
const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;
const BPS = 10_000n;

export const BENCHMARK_MANIFEST_VERSION = 1;
export const BENCHMARK_ARM_RECORD_VERSION = 1;
export const BENCHMARK_PAIR_RECORD_VERSION = 1;
export const COST_LEDGER_VERSION = 1;
export const MAX_COST_LEDGER_ENTRIES = 256;
export const MAX_TOP_UP_ATTEMPTS = 10_000;

/** A reference price is either the midpoint or the executable side the benchmark direction trades. */
export const PRICE_CONVENTION = Object.freeze({ MIDPOINT: 1, DIRECTION_EXECUTABLE_SIDE: 2 } as const);
export type PriceConvention = keyof typeof PRICE_CONVENTION;

/** Exactly one ledger mode values every cost of both arms of one pair. */
export const COST_LEDGER_MODE = Object.freeze({ GROSS_CASHFLOW_LEDGER: 1, NET_STATE_DELTA_LEDGER: 2 } as const);
export type CostLedgerMode = keyof typeof COST_LEDGER_MODE;

export const BENCHMARK_ARM = Object.freeze({ PACKAGE: 1, SEQUENTIAL: 2 } as const);
export type BenchmarkArm = keyof typeof BENCHMARK_ARM;

export const MINIMUM_ALLOCATION_WEIGHT_BASIS = Object.freeze({ REQUESTED_NOTIONAL: 1, EQUAL_ATTEMPT: 2 } as const);
export type MinimumAllocationWeightBasis = keyof typeof MINIMUM_ALLOCATION_WEIGHT_BASIS;

export const COST_COMPONENT_KIND = Object.freeze({
  GROSS_FILL: 1,
  STATE_DELTA: 2,
  VENUE_FEE: 3,
  BUILDER_FEE: 4,
  PROTOCOL_FEE: 5,
  SOLVER_FEE: 6,
  PROFESSIONAL_EXECUTION_FEE: 7,
  GAS: 8,
  PRIORITY_FEE: 9,
  RECOVERY_COST: 10,
  RECOVERY_REFUND: 11,
  RESIDUAL: 12,
  REBATE: 13,
  GROSS_UP: 14,
} as const);
export type CostComponentKind = keyof typeof COST_COMPONENT_KIND;

/** Where a cost sits: added separately, or already inside a valued net state delta. */
export const COST_EMBEDDING = Object.freeze({ SEPARATE: 1, EMBEDDED_IN_STATE_DELTA: 2 } as const);
export type CostEmbedding = keyof typeof COST_EMBEDDING;

const NONNEGATIVE_COSTS: ReadonlySet<CostComponentKind> = new Set([
  'BUILDER_FEE',
  'PROTOCOL_FEE',
  'SOLVER_FEE',
  'PROFESSIONAL_EXECUTION_FEE',
  'GAS',
  'PRIORITY_FEE',
  'RECOVERY_COST',
]);
const NONPOSITIVE_COSTS: ReadonlySet<CostComponentKind> = new Set(['REBATE', 'RECOVERY_REFUND']);
/** The charges Naryx and its solvers earn: the one recognized service charge of an arm. */
const SERVICE_CHARGE_KINDS: ReadonlySet<CostComponentKind> = new Set([
  'BUILDER_FEE',
  'PROTOCOL_FEE',
  'SOLVER_FEE',
  'PROFESSIONAL_EXECUTION_FEE',
]);

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function signed(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedSigned(value, I128_BITS, context);
}

function positive(value: bigint, bits: number, context: string): bigint {
  const checked = unsigned(value, bits, context);
  if (checked === 0n) throw new MalformedInputError(context, 'expected a positive value');
  return checked;
}

function small(value: number, bits: number, context: string): number {
  if (!Number.isSafeInteger(value)) throw new MalformedInputError(context, 'expected an integer');
  return Number(checkedUnsigned(BigInt(value), bits, context));
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function version(value: number, expected: number, context: string): number {
  if (value !== expected) throw new MalformedInputError(context, `version must equal ${expected}`);
  return value;
}

function checkedAsset(value: AssetRef, context: string): AssetRef {
  object(value, context);
  return assetRef(value.assetId, value.assetManifestHash, value.decimals, context);
}

function checkedDomain(value: DomainRef, context: string): DomainRef {
  object(value, context);
  return domainRef(value.domainId, value.domainManifestVersion, value.domainManifestHash, context);
}

function checkedManifestRef(value: VersionedManifestRef, context: string): VersionedManifestRef {
  object(value, context);
  return versionedManifestRef(value.subjectId, value.manifestVersion, value.manifestHash, context);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId && left.decimals === right.decimals && compareBytes(left.assetManifestHash, right.assetManifestHash) === 0;
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return (
    left.domainId === right.domainId &&
    left.domainManifestVersion === right.domainManifestVersion &&
    compareBytes(left.domainManifestHash, right.domainManifestHash) === 0
  );
}

function sameHash(left: Uint8Array, right: Uint8Array): boolean {
  return compareBytes(left, right) === 0;
}

// ------------------------------------------------------------------ fee promotion cohort

export interface FeePromotionCohortInput {
  readonly domain: DomainRef;
  readonly direction: Direction;
  readonly quantityPolicyClass: QuantityPolicyClass;
  readonly settlementClass: SettlementClass;
  readonly accountModeClass: string;
}

/**
 * The strict cohort a fee may be promoted for. Materially different account modes are different
 * cohorts, and no aggregate over cohorts can authorize a fee for any one of them.
 */
export function feePromotionCohortKey(input: FeePromotionCohortInput): CommitmentHash {
  object(input, 'feePromotionCohortKey');
  const domain = checkedDomain(input.domain, 'feePromotionCohortKey.domain');
  const bytes = canonicalBytes((writer) => {
    encodeDomainRef(writer, domain);
    writer.writeEnum(DIRECTION, variant(DIRECTION, input.direction, 'feePromotionCohortKey.direction'), 'direction');
    writer.writeEnum(QUANTITY_POLICY_CLASS, variant(QUANTITY_POLICY_CLASS, input.quantityPolicyClass, 'feePromotionCohortKey.quantityPolicyClass'), 'quantityPolicyClass');
    writer.writeEnum(SETTLEMENT_CLASS, variant(SETTLEMENT_CLASS, input.settlementClass, 'feePromotionCohortKey.settlementClass'), 'settlementClass');
    encodeProtocolId(writer, protocolId(input.accountModeClass, 'feePromotionCohortKey.accountModeClass'), 'accountModeClass');
  });
  return commitmentHash(domainHash(HASH_DOMAIN.FEE_PROMOTION_COHORT, bytes), 'feePromotionCohortKey');
}

// ------------------------------------------------------------------ benchmark manifest

/**
 * Everything an economic comparison fixes before either arm's outcome is known. Source,
 * observation, side, freshness, fallback, multiplier, decimals, evidence, horizon, ledger mode,
 * estimator, eligibility, outcome treatment, baseline selection and candidates, the selected
 * baseline, and the freeze itself are immutable for the pair.
 */
export interface BenchmarkManifestInput {
  readonly version: number;
  readonly environment: string;
  readonly pairId: string;
  readonly feePromotionCohortKey: Uint8Array | string;
  readonly domain: DomainRef;
  readonly direction: Direction;
  readonly quantityPolicyClass: QuantityPolicyClass;
  readonly settlementClass: SettlementClass;
  readonly accountModeClass: string;
  /** Signed base quantity in the package base asset; the denominator uses its absolute value. */
  readonly requestedBaseQuantity: AssetAmount;
  readonly referencePrice: ExactPriceInput;
  readonly priceSource: VersionedManifestRef;
  readonly sourceMarket: VersionedManifestRef;
  readonly quoteCurrency: AssetRef;
  readonly contractMultiplier: bigint;
  readonly priceDecimals: number;
  readonly priceConvention: PriceConvention;
  readonly observedAtUnit: ExpiryUnit;
  readonly observedAtValue: bigint;
  readonly blockOrCommittedStateRef?: Uint8Array | string;
  readonly maxStaleness: bigint;
  readonly fallbackRule: string;
  readonly evidenceRef: Uint8Array | string;
  readonly valuationHorizonRule: string;
  readonly costLedgerMode: CostLedgerMode;
  readonly estimatorVersion: number;
  readonly eligibilityPolicyHash: Uint8Array | string;
  readonly outcomeTreatmentPolicyHash: Uint8Array | string;
  readonly baselineSelectionPolicyHash: Uint8Array | string;
  readonly baselineChallengerSetHash: Uint8Array | string;
  readonly baselineExecutionPolicyHash: Uint8Array | string;
  readonly buyerWorkflowEvidenceRef?: Uint8Array | string;
  /** Present, with both allocation fields, whenever a monthly minimum can affect the pair. */
  readonly customerMonthId?: string;
  readonly minimumAllocationRuleVersion?: number;
  readonly minimumAllocationWeightBasis?: MinimumAllocationWeightBasis;
  readonly frozenAtUnit: ExpiryUnit;
  readonly frozenAtValue: bigint;
  readonly freezeCommitRef: Uint8Array | string;
}

export interface BenchmarkManifest {
  readonly version: number;
  readonly environment: ProtocolId;
  readonly pairId: ProtocolId;
  readonly feePromotionCohortKey: CommitmentHash;
  readonly domain: DomainRef;
  readonly direction: Direction;
  readonly quantityPolicyClass: QuantityPolicyClass;
  readonly settlementClass: SettlementClass;
  readonly accountModeClass: ProtocolId;
  readonly requestedBaseQuantity: AssetAmount;
  readonly referencePrice: ExactPrice;
  readonly priceSource: VersionedManifestRef;
  readonly sourceMarket: VersionedManifestRef;
  readonly quoteCurrency: AssetRef;
  readonly contractMultiplier: bigint;
  readonly priceDecimals: number;
  readonly priceConvention: PriceConvention;
  readonly observedAtUnit: ExpiryUnit;
  readonly observedAtValue: bigint;
  readonly blockOrCommittedStateRef?: CommitmentHash;
  readonly maxStaleness: bigint;
  readonly fallbackRule: ProtocolId;
  readonly evidenceRef: CommitmentHash;
  readonly valuationHorizonRule: ProtocolId;
  readonly costLedgerMode: CostLedgerMode;
  readonly estimatorVersion: number;
  readonly eligibilityPolicyHash: CommitmentHash;
  readonly outcomeTreatmentPolicyHash: CommitmentHash;
  readonly baselineSelectionPolicyHash: CommitmentHash;
  readonly baselineChallengerSetHash: CommitmentHash;
  readonly baselineExecutionPolicyHash: CommitmentHash;
  readonly buyerWorkflowEvidenceRef?: CommitmentHash;
  readonly customerMonthId?: ProtocolId;
  readonly minimumAllocationRuleVersion?: number;
  readonly minimumAllocationWeightBasis?: MinimumAllocationWeightBasis;
  readonly frozenAtUnit: ExpiryUnit;
  readonly frozenAtValue: bigint;
  readonly freezeCommitRef: CommitmentHash;
}

function optionalHash(value: Uint8Array | string | undefined, context: string): CommitmentHash | undefined {
  return value === undefined ? undefined : commitmentHash(value, context);
}

export function benchmarkManifest(input: BenchmarkManifestInput, context = 'benchmarkManifest'): BenchmarkManifest {
  object(input, context);
  const domain = checkedDomain(input.domain, `${context}.domain`);
  const direction = variant(DIRECTION, input.direction, `${context}.direction`);
  const quantityPolicyClass = variant(QUANTITY_POLICY_CLASS, input.quantityPolicyClass, `${context}.quantityPolicyClass`);
  const settlementClass = variant(SETTLEMENT_CLASS, input.settlementClass, `${context}.settlementClass`);
  const accountModeClass = protocolId(input.accountModeClass, `${context}.accountModeClass`);
  const cohort = commitmentHash(input.feePromotionCohortKey, `${context}.feePromotionCohortKey`);
  if (!sameHash(cohort, feePromotionCohortKey({ domain, direction, quantityPolicyClass, settlementClass, accountModeClass }))) {
    throw new MalformedInputError(`${context}.feePromotionCohortKey`, 'the cohort key does not match the domain, direction, policy, settlement, and account mode');
  }
  object(input.requestedBaseQuantity, `${context}.requestedBaseQuantity`);
  const quantity = assetAmount(input.requestedBaseQuantity.asset, input.requestedBaseQuantity.atoms, `${context}.requestedBaseQuantity`);
  if (quantity.atoms === 0n) throw new MalformedInputError(`${context}.requestedBaseQuantity`, 'the requested quantity cannot be zero');
  const price = exactPrice(input.referencePrice, `${context}.referencePrice`);
  if (!sameAsset(quantity.asset, price.baseAsset)) throw new MalformedInputError(`${context}.referencePrice`, 'the reference price is not for the requested base asset');
  const quoteCurrency = checkedAsset(input.quoteCurrency, `${context}.quoteCurrency`);
  if (!sameAsset(quoteCurrency, price.quoteAsset)) throw new MalformedInputError(`${context}.quoteCurrency`, 'the quote currency is not the reference price quote asset');
  const observedAtUnit = variant(EXPIRY_UNIT, input.observedAtUnit, `${context}.observedAtUnit`);
  const observedAtValue = unsigned(input.observedAtValue, U64_BITS, `${context}.observedAtValue`);
  const frozenAtUnit = variant(EXPIRY_UNIT, input.frozenAtUnit, `${context}.frozenAtUnit`);
  const frozenAtValue = unsigned(input.frozenAtValue, U64_BITS, `${context}.frozenAtValue`);
  if (observedAtUnit === frozenAtUnit && observedAtValue > frozenAtValue) {
    throw new MalformedInputError(`${context}.observedAtValue`, 'the reference cannot be observed after the freeze');
  }
  const monthFields = [input.customerMonthId, input.minimumAllocationRuleVersion, input.minimumAllocationWeightBasis].filter((value) => value !== undefined).length;
  if (monthFields !== 0 && monthFields !== 3) {
    throw new MalformedInputError(`${context}.customerMonthId`, 'a customer month freezes its allocation rule version and weight basis with it');
  }
  const buyerWorkflowEvidenceRef = optionalHash(input.buyerWorkflowEvidenceRef, `${context}.buyerWorkflowEvidenceRef`);
  const blockOrCommittedStateRef = optionalHash(input.blockOrCommittedStateRef, `${context}.blockOrCommittedStateRef`);
  return Object.freeze({
    version: version(input.version, BENCHMARK_MANIFEST_VERSION, `${context}.version`),
    environment: protocolId(input.environment, `${context}.environment`),
    pairId: protocolId(input.pairId, `${context}.pairId`),
    feePromotionCohortKey: cohort,
    domain,
    direction,
    quantityPolicyClass,
    settlementClass,
    accountModeClass,
    requestedBaseQuantity: quantity,
    referencePrice: price,
    priceSource: checkedManifestRef(input.priceSource, `${context}.priceSource`),
    sourceMarket: checkedManifestRef(input.sourceMarket, `${context}.sourceMarket`),
    quoteCurrency,
    contractMultiplier: positive(input.contractMultiplier, U64_BITS, `${context}.contractMultiplier`),
    priceDecimals: small(input.priceDecimals, U8_BITS, `${context}.priceDecimals`),
    priceConvention: variant(PRICE_CONVENTION, input.priceConvention, `${context}.priceConvention`),
    observedAtUnit,
    observedAtValue,
    ...(blockOrCommittedStateRef === undefined ? {} : { blockOrCommittedStateRef }),
    maxStaleness: unsigned(input.maxStaleness, U64_BITS, `${context}.maxStaleness`),
    fallbackRule: protocolId(input.fallbackRule, `${context}.fallbackRule`),
    evidenceRef: commitmentHash(input.evidenceRef, `${context}.evidenceRef`),
    valuationHorizonRule: protocolId(input.valuationHorizonRule, `${context}.valuationHorizonRule`),
    costLedgerMode: variant(COST_LEDGER_MODE, input.costLedgerMode, `${context}.costLedgerMode`),
    estimatorVersion: small(input.estimatorVersion, U32_BITS, `${context}.estimatorVersion`),
    eligibilityPolicyHash: commitmentHash(input.eligibilityPolicyHash, `${context}.eligibilityPolicyHash`),
    outcomeTreatmentPolicyHash: commitmentHash(input.outcomeTreatmentPolicyHash, `${context}.outcomeTreatmentPolicyHash`),
    baselineSelectionPolicyHash: commitmentHash(input.baselineSelectionPolicyHash, `${context}.baselineSelectionPolicyHash`),
    baselineChallengerSetHash: commitmentHash(input.baselineChallengerSetHash, `${context}.baselineChallengerSetHash`),
    baselineExecutionPolicyHash: commitmentHash(input.baselineExecutionPolicyHash, `${context}.baselineExecutionPolicyHash`),
    ...(buyerWorkflowEvidenceRef === undefined ? {} : { buyerWorkflowEvidenceRef }),
    ...(input.customerMonthId === undefined
      ? {}
      : {
          customerMonthId: protocolId(input.customerMonthId, `${context}.customerMonthId`),
          minimumAllocationRuleVersion: small(input.minimumAllocationRuleVersion as number, U32_BITS, `${context}.minimumAllocationRuleVersion`),
          minimumAllocationWeightBasis: variant(
            MINIMUM_ALLOCATION_WEIGHT_BASIS,
            input.minimumAllocationWeightBasis as MinimumAllocationWeightBasis,
            `${context}.minimumAllocationWeightBasis`,
          ),
        }),
    frozenAtUnit,
    frozenAtValue,
    freezeCommitRef: commitmentHash(input.freezeCommitRef, `${context}.freezeCommitRef`),
  });
}

export function benchmarkManifestBytes(input: BenchmarkManifestInput): Uint8Array {
  const manifest = benchmarkManifest(input);
  return canonicalBytes((writer) => {
    writer.writeU32(manifest.version, 'version');
    encodeProtocolId(writer, manifest.environment, 'environment');
    encodeProtocolId(writer, manifest.pairId, 'pairId');
    encodeCommitmentHash(writer, manifest.feePromotionCohortKey, 'feePromotionCohortKey');
    encodeDomainRef(writer, manifest.domain);
    writer.writeEnum(DIRECTION, manifest.direction, 'direction');
    writer.writeEnum(QUANTITY_POLICY_CLASS, manifest.quantityPolicyClass, 'quantityPolicyClass');
    writer.writeEnum(SETTLEMENT_CLASS, manifest.settlementClass, 'settlementClass');
    encodeProtocolId(writer, manifest.accountModeClass, 'accountModeClass');
    encodeAssetAmount(writer, manifest.requestedBaseQuantity);
    encodeExactPrice(writer, manifest.referencePrice);
    encodeVersionedManifestRef(writer, manifest.priceSource);
    encodeVersionedManifestRef(writer, manifest.sourceMarket);
    encodeAssetRef(writer, manifest.quoteCurrency);
    writer.writeU64(manifest.contractMultiplier, 'contractMultiplier');
    writer.writeU8(manifest.priceDecimals, 'priceDecimals');
    writer.writeEnum(PRICE_CONVENTION, manifest.priceConvention, 'priceConvention');
    writer.writeEnum(EXPIRY_UNIT, manifest.observedAtUnit, 'observedAtUnit');
    writer.writeU64(manifest.observedAtValue, 'observedAtValue');
    writer.writeOptional(manifest.blockOrCommittedStateRef, (inner, value) => encodeCommitmentHash(inner, value, 'blockOrCommittedStateRef'), 'blockOrCommittedStateRef');
    writer.writeU64(manifest.maxStaleness, 'maxStaleness');
    encodeProtocolId(writer, manifest.fallbackRule, 'fallbackRule');
    encodeCommitmentHash(writer, manifest.evidenceRef, 'evidenceRef');
    encodeProtocolId(writer, manifest.valuationHorizonRule, 'valuationHorizonRule');
    writer.writeEnum(COST_LEDGER_MODE, manifest.costLedgerMode, 'costLedgerMode');
    writer.writeU32(manifest.estimatorVersion, 'estimatorVersion');
    encodeCommitmentHash(writer, manifest.eligibilityPolicyHash, 'eligibilityPolicyHash');
    encodeCommitmentHash(writer, manifest.outcomeTreatmentPolicyHash, 'outcomeTreatmentPolicyHash');
    encodeCommitmentHash(writer, manifest.baselineSelectionPolicyHash, 'baselineSelectionPolicyHash');
    encodeCommitmentHash(writer, manifest.baselineChallengerSetHash, 'baselineChallengerSetHash');
    encodeCommitmentHash(writer, manifest.baselineExecutionPolicyHash, 'baselineExecutionPolicyHash');
    writer.writeOptional(manifest.buyerWorkflowEvidenceRef, (inner, value) => encodeCommitmentHash(inner, value, 'buyerWorkflowEvidenceRef'), 'buyerWorkflowEvidenceRef');
    writer.writeOptional(manifest.customerMonthId, (inner, value) => encodeProtocolId(inner, value, 'customerMonthId'), 'customerMonthId');
    writer.writeOptional(manifest.minimumAllocationRuleVersion, (inner, value) => inner.writeU32(value, 'minimumAllocationRuleVersion'), 'minimumAllocationRuleVersion');
    writer.writeOptional(
      manifest.minimumAllocationWeightBasis,
      (inner, value) => inner.writeEnum(MINIMUM_ALLOCATION_WEIGHT_BASIS, value, 'minimumAllocationWeightBasis'),
      'minimumAllocationWeightBasis',
    );
    writer.writeEnum(EXPIRY_UNIT, manifest.frozenAtUnit, 'frozenAtUnit');
    writer.writeU64(manifest.frozenAtValue, 'frozenAtValue');
    encodeCommitmentHash(writer, manifest.freezeCommitRef, 'freezeCommitRef');
  });
}

export function benchmarkManifestHash(input: BenchmarkManifestInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.BENCHMARK_MANIFEST, benchmarkManifestBytes(input)), 'benchmarkManifestHash');
}

/**
 * The comparison denominator: `abs(requestedBaseQuantity) * referencePrice * contractMultiplier`
 * in quote atoms of the bound quote currency, rounded as the reference price declares.
 */
export function benchmarkNotionalDenominator(input: BenchmarkManifestInput): AssetAmount {
  const manifest = benchmarkManifest(input);
  const price = manifest.referencePrice;
  const atoms = mulDiv(
    absBigInt(manifest.requestedBaseQuantity.atoms) * manifest.contractMultiplier,
    price.quoteAtoms,
    price.baseAtoms,
    price.roundingDirection,
    'benchmarkNotionalDenominator',
  );
  return assetAmount(manifest.quoteCurrency, atoms, 'benchmarkNotionalDenominator');
}

/**
 * Whether the frozen reference is fresh at the freeze. A stale primary is usable only through the
 * fallback the manifest froze; without a fresh fallback observation the pair stays unresolved.
 */
export function benchmarkReferenceFresh(input: BenchmarkManifestInput): boolean {
  const manifest = benchmarkManifest(input);
  if (manifest.observedAtUnit !== manifest.frozenAtUnit) return false;
  return manifest.frozenAtValue - manifest.observedAtValue <= manifest.maxStaleness;
}

// ------------------------------------------------------------------ arm and pair records

export interface BenchmarkArmRecordInput {
  readonly armRecordVersion: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly pairId: string;
  readonly benchmarkManifestHash: Uint8Array | string;
  readonly arm: BenchmarkArm;
  /** The terminal outcome of the package arm, or the export of the sequential arm. */
  readonly outcomeOrExportHash: Uint8Array | string;
}

export interface BenchmarkArmRecord {
  readonly armRecordVersion: number;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly pairId: ProtocolId;
  readonly benchmarkManifestHash: CommitmentHash;
  readonly arm: BenchmarkArm;
  readonly outcomeOrExportHash: CommitmentHash;
}

export function benchmarkArmRecord(input: BenchmarkArmRecordInput, context = 'benchmarkArmRecord'): BenchmarkArmRecord {
  object(input, context);
  return Object.freeze({
    armRecordVersion: version(input.armRecordVersion, BENCHMARK_ARM_RECORD_VERSION, `${context}.armRecordVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    domain: checkedDomain(input.domain, `${context}.domain`),
    pairId: protocolId(input.pairId, `${context}.pairId`),
    benchmarkManifestHash: commitmentHash(input.benchmarkManifestHash, `${context}.benchmarkManifestHash`),
    arm: variant(BENCHMARK_ARM, input.arm, `${context}.arm`),
    outcomeOrExportHash: commitmentHash(input.outcomeOrExportHash, `${context}.outcomeOrExportHash`),
  });
}

export function benchmarkArmRecordBytes(input: BenchmarkArmRecordInput): Uint8Array {
  const record = benchmarkArmRecord(input);
  return canonicalBytes((writer) => {
    writer.writeU32(record.armRecordVersion, 'armRecordVersion');
    encodeProtocolId(writer, record.environment, 'environment');
    encodeDomainRef(writer, record.domain);
    encodeProtocolId(writer, record.pairId, 'pairId');
    encodeCommitmentHash(writer, record.benchmarkManifestHash, 'benchmarkManifestHash');
    writer.writeEnum(BENCHMARK_ARM, record.arm, 'arm');
    encodeCommitmentHash(writer, record.outcomeOrExportHash, 'outcomeOrExportHash');
  });
}

export function benchmarkArmRecordHash(input: BenchmarkArmRecordInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.BENCHMARK_ARM, benchmarkArmRecordBytes(input)), 'benchmarkArmRecordHash');
}

export interface BenchmarkPairRecordInput {
  readonly pairRecordVersion: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly pairId: string;
  readonly benchmarkManifestHash: Uint8Array | string;
  readonly frozenAtUnit: ExpiryUnit;
  readonly frozenAtValue: bigint;
  readonly freezeCommitRef: Uint8Array | string;
  readonly packageArmRecordHash: Uint8Array | string;
  readonly sequentialArmRecordHash: Uint8Array | string;
}

export interface BenchmarkPairRecord {
  readonly pairRecordVersion: number;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly pairId: ProtocolId;
  readonly benchmarkManifestHash: CommitmentHash;
  readonly frozenAtUnit: ExpiryUnit;
  readonly frozenAtValue: bigint;
  readonly freezeCommitRef: CommitmentHash;
  readonly packageArmRecordHash: CommitmentHash;
  readonly sequentialArmRecordHash: CommitmentHash;
}

export function benchmarkPairRecord(input: BenchmarkPairRecordInput, context = 'benchmarkPairRecord'): BenchmarkPairRecord {
  object(input, context);
  const packageArmRecordHash = commitmentHash(input.packageArmRecordHash, `${context}.packageArmRecordHash`);
  const sequentialArmRecordHash = commitmentHash(input.sequentialArmRecordHash, `${context}.sequentialArmRecordHash`);
  if (sameHash(packageArmRecordHash, sequentialArmRecordHash)) {
    throw new DuplicateElementError(`${context}.sequentialArmRecordHash`, 'the two arms cannot be one record');
  }
  return Object.freeze({
    pairRecordVersion: version(input.pairRecordVersion, BENCHMARK_PAIR_RECORD_VERSION, `${context}.pairRecordVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    domain: checkedDomain(input.domain, `${context}.domain`),
    pairId: protocolId(input.pairId, `${context}.pairId`),
    benchmarkManifestHash: commitmentHash(input.benchmarkManifestHash, `${context}.benchmarkManifestHash`),
    frozenAtUnit: variant(EXPIRY_UNIT, input.frozenAtUnit, `${context}.frozenAtUnit`),
    frozenAtValue: unsigned(input.frozenAtValue, U64_BITS, `${context}.frozenAtValue`),
    freezeCommitRef: commitmentHash(input.freezeCommitRef, `${context}.freezeCommitRef`),
    packageArmRecordHash,
    sequentialArmRecordHash,
  });
}

export function benchmarkPairRecordBytes(input: BenchmarkPairRecordInput): Uint8Array {
  const record = benchmarkPairRecord(input);
  return canonicalBytes((writer) => {
    writer.writeU32(record.pairRecordVersion, 'pairRecordVersion');
    encodeProtocolId(writer, record.environment, 'environment');
    encodeDomainRef(writer, record.domain);
    encodeProtocolId(writer, record.pairId, 'pairId');
    encodeCommitmentHash(writer, record.benchmarkManifestHash, 'benchmarkManifestHash');
    writer.writeEnum(EXPIRY_UNIT, record.frozenAtUnit, 'frozenAtUnit');
    writer.writeU64(record.frozenAtValue, 'frozenAtValue');
    encodeCommitmentHash(writer, record.freezeCommitRef, 'freezeCommitRef');
    encodeCommitmentHash(writer, record.packageArmRecordHash, 'packageArmRecordHash');
    encodeCommitmentHash(writer, record.sequentialArmRecordHash, 'sequentialArmRecordHash');
  });
}

export function benchmarkPairRecordHash(input: BenchmarkPairRecordInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.BENCHMARK_PAIR, benchmarkPairRecordBytes(input)), 'benchmarkPairRecordHash');
}

export type BenchmarkIneligibility =
  | 'MANIFEST_HASH_MISMATCH'
  | 'ENVIRONMENT_MISMATCH'
  | 'DOMAIN_MISMATCH'
  | 'PAIR_ID_MISMATCH'
  | 'FREEZE_MISMATCH'
  | 'ARM_MISSING'
  | 'ARM_HASH_MISMATCH'
  | 'ARM_ROLE_MISMATCH'
  | 'MISSING_PRE_OUTCOME_COMMITMENT'
  | 'COMMITTED_AFTER_OUTCOME'
  | 'POLICY_CHANGED';

export interface BenchmarkPairEvidence {
  readonly manifest: BenchmarkManifestInput;
  readonly pair: BenchmarkPairRecordInput;
  readonly packageArm?: BenchmarkArmRecordInput;
  readonly sequentialArm?: BenchmarkArmRecordInput;
  /** When `freezeCommitRef` was published, in the manifest's freeze unit; absent when unproven. */
  readonly freezePublishedAtValue?: bigint;
  /** When the first arm outcome became available, in the manifest's freeze unit. */
  readonly firstOutcomeAtValue?: bigint;
  /** The estimator and policies the evaluation actually applies. */
  readonly evaluation: {
    readonly estimatorVersion: number;
    readonly eligibilityPolicyHash: Uint8Array | string;
    readonly outcomeTreatmentPolicyHash: Uint8Array | string;
  };
  /** True when a fresh fallback observation permitted by the manifest's fallback rule exists. */
  readonly freshFallbackObserved: boolean;
}

/**
 * Whether a finalized pair may count toward fee promotion. Every binding must hold: both arm
 * records and the pair bind the exact manifest hash, environment, and domain; the pair carries
 * both arm-record hashes; the manifest was published before either outcome existed; and the
 * evaluation uses the frozen estimator and policies. Any failure makes the pair ineligible. A
 * stale reference without a fresh permitted fallback leaves an otherwise sound pair unresolved.
 */
export function verifyBenchmarkPair(
  evidence: BenchmarkPairEvidence,
):
  | { readonly status: 'ELIGIBLE' }
  | { readonly status: 'UNRESOLVED'; readonly reason: 'REFERENCE_STALE' }
  | { readonly status: 'INELIGIBLE'; readonly reasons: readonly BenchmarkIneligibility[] } {
  object(evidence, 'verifyBenchmarkPair.evidence');
  const manifest = benchmarkManifest(evidence.manifest, 'verifyBenchmarkPair.manifest');
  const manifestHash = benchmarkManifestHash(evidence.manifest);
  const pair = benchmarkPairRecord(evidence.pair, 'verifyBenchmarkPair.pair');
  const reasons = new Set<BenchmarkIneligibility>();
  const binds = (record: { environment: ProtocolId; domain: DomainRef; pairId: ProtocolId; benchmarkManifestHash: CommitmentHash }) => {
    if (!sameHash(record.benchmarkManifestHash, manifestHash)) reasons.add('MANIFEST_HASH_MISMATCH');
    if (record.environment !== manifest.environment) reasons.add('ENVIRONMENT_MISMATCH');
    if (!sameDomain(record.domain, manifest.domain)) reasons.add('DOMAIN_MISMATCH');
    if (record.pairId !== manifest.pairId) reasons.add('PAIR_ID_MISMATCH');
  };
  binds(pair);
  if (
    pair.frozenAtUnit !== manifest.frozenAtUnit ||
    pair.frozenAtValue !== manifest.frozenAtValue ||
    !sameHash(pair.freezeCommitRef, manifest.freezeCommitRef)
  ) {
    reasons.add('FREEZE_MISMATCH');
  }
  const arms: readonly [BenchmarkArm, BenchmarkArmRecordInput | undefined, CommitmentHash][] = [
    ['PACKAGE', evidence.packageArm, pair.packageArmRecordHash],
    ['SEQUENTIAL', evidence.sequentialArm, pair.sequentialArmRecordHash],
  ];
  for (const [role, input, bound] of arms) {
    if (input === undefined) {
      reasons.add('ARM_MISSING');
      continue;
    }
    const arm = benchmarkArmRecord(input, `verifyBenchmarkPair.${role.toLowerCase()}Arm`);
    binds(arm);
    if (arm.arm !== role) reasons.add('ARM_ROLE_MISMATCH');
    if (!sameHash(benchmarkArmRecordHash(arm), bound)) reasons.add('ARM_HASH_MISMATCH');
  }
  if (evidence.freezePublishedAtValue === undefined || evidence.firstOutcomeAtValue === undefined) {
    reasons.add('MISSING_PRE_OUTCOME_COMMITMENT');
  } else {
    const published = unsigned(evidence.freezePublishedAtValue, U64_BITS, 'verifyBenchmarkPair.freezePublishedAtValue');
    const firstOutcome = unsigned(evidence.firstOutcomeAtValue, U64_BITS, 'verifyBenchmarkPair.firstOutcomeAtValue');
    if (published < manifest.frozenAtValue || published >= firstOutcome) reasons.add('COMMITTED_AFTER_OUTCOME');
  }
  object(evidence.evaluation, 'verifyBenchmarkPair.evaluation');
  if (
    evidence.evaluation.estimatorVersion !== manifest.estimatorVersion ||
    !sameHash(commitmentHash(evidence.evaluation.eligibilityPolicyHash, 'verifyBenchmarkPair.evaluation.eligibilityPolicyHash'), manifest.eligibilityPolicyHash) ||
    !sameHash(commitmentHash(evidence.evaluation.outcomeTreatmentPolicyHash, 'verifyBenchmarkPair.evaluation.outcomeTreatmentPolicyHash'), manifest.outcomeTreatmentPolicyHash)
  ) {
    reasons.add('POLICY_CHANGED');
  }
  if (reasons.size > 0) return Object.freeze({ status: 'INELIGIBLE' as const, reasons: Object.freeze([...reasons].sort()) });
  if (typeof evidence.freshFallbackObserved !== 'boolean') throw new MalformedInputError('verifyBenchmarkPair.freshFallbackObserved', 'expected a boolean');
  if (!benchmarkReferenceFresh(evidence.manifest) && !evidence.freshFallbackObserved) {
    return Object.freeze({ status: 'UNRESOLVED' as const, reason: 'REFERENCE_STALE' as const });
  }
  return Object.freeze({ status: 'ELIGIBLE' as const });
}

// ------------------------------------------------------------------ cost ledger

/**
 * One cost component valued in the ledger's quote asset. A positive `quoteValueAtoms` is a cost to
 * the trader and a negative one a credit; `amount` keeps the component in its own asset, so a
 * base-token fee stays a base-token fee with its valuation beside it.
 */
export interface CostLedgerEntryInput {
  readonly componentId: string;
  readonly kind: CostComponentKind;
  readonly amount: AssetAmount;
  readonly quoteValueAtoms: bigint;
  readonly embedding: CostEmbedding;
  readonly serviceCharge: boolean;
}

export interface CostLedgerInput {
  readonly ledgerVersion: number;
  readonly mode: CostLedgerMode;
  readonly quoteAsset: AssetRef;
  readonly entries: readonly CostLedgerEntryInput[];
}

export interface CostLedgerTotals {
  /** Every component the ledger counts, exactly once. */
  readonly totalCostQuoteAtoms: bigint;
  /** The one recognized service charge, whether counted separately or embedded. */
  readonly serviceChargeQuoteAtoms: bigint;
  /** Components recorded as already inside a state delta and therefore never added again. */
  readonly embeddedQuoteAtoms: bigint;
}

/**
 * Totals one arm's cost ledger. A gross cashflow ledger reconstructs gross fills and adds every
 * cost separately; a net state delta ledger starts from valued net state deltas and adds only
 * costs not already embedded in them. Neither mode can count one component twice.
 */
export function costLedgerTotals(input: CostLedgerInput, context = 'costLedger'): CostLedgerTotals {
  object(input, context);
  version(input.ledgerVersion, COST_LEDGER_VERSION, `${context}.ledgerVersion`);
  const mode = variant(COST_LEDGER_MODE, input.mode, `${context}.mode`);
  checkedAsset(input.quoteAsset, `${context}.quoteAsset`);
  if (!Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > MAX_COST_LEDGER_ENTRIES) {
    throw new MalformedInputError(`${context}.entries`, `expected 1 to ${MAX_COST_LEDGER_ENTRIES} entries`);
  }
  const base = mode === 'GROSS_CASHFLOW_LEDGER' ? 'GROSS_FILL' : 'STATE_DELTA';
  const other = mode === 'GROSS_CASHFLOW_LEDGER' ? 'STATE_DELTA' : 'GROSS_FILL';
  const seen = new Set<string>();
  let total = 0n;
  let service = 0n;
  let embedded = 0n;
  let bases = 0;
  input.entries.forEach((entry, index) => {
    const at = `${context}.entries[${index}]`;
    object(entry, at);
    const componentId = protocolId(entry.componentId, `${at}.componentId`);
    if (seen.has(componentId)) throw new DuplicateElementError(`${at}.componentId`, 'a component is recorded twice');
    seen.add(componentId);
    const kind = variant(COST_COMPONENT_KIND, entry.kind, `${at}.kind`);
    object(entry.amount, `${at}.amount`);
    assetAmount(entry.amount.asset, entry.amount.atoms, `${at}.amount`);
    const value = signed(entry.quoteValueAtoms, `${at}.quoteValueAtoms`);
    const embedding = variant(COST_EMBEDDING, entry.embedding, `${at}.embedding`);
    if (typeof entry.serviceCharge !== 'boolean') throw new MalformedInputError(`${at}.serviceCharge`, 'expected a boolean');
    if (kind === other) throw new MalformedInputError(`${at}.kind`, `a ${mode} does not record ${other}`);
    if (NONNEGATIVE_COSTS.has(kind) && value < 0n) throw new MalformedInputError(`${at}.quoteValueAtoms`, `${kind} is a cost and cannot be negative`);
    if (NONPOSITIVE_COSTS.has(kind) && value > 0n) throw new MalformedInputError(`${at}.quoteValueAtoms`, `${kind} is a credit and cannot be positive`);
    if (entry.serviceCharge && !SERVICE_CHARGE_KINDS.has(kind)) throw new MalformedInputError(`${at}.serviceCharge`, `${kind} is not a service charge`);
    if (embedding === 'EMBEDDED_IN_STATE_DELTA' && (mode === 'GROSS_CASHFLOW_LEDGER' || kind === 'STATE_DELTA')) {
      throw new MalformedInputError(`${at}.embedding`, 'only a cost inside a net state delta can be embedded');
    }
    if (kind === base) bases += 1;
    if (embedding === 'SEPARATE') total += value;
    else embedded += value;
    if (entry.serviceCharge) service += value;
  });
  if (bases === 0) throw new MalformedInputError(`${context}.entries`, `a ${mode} starts from at least one ${base}`);
  return Object.freeze({
    totalCostQuoteAtoms: checkedSigned(total, I128_BITS, `${context}.totalCostQuoteAtoms`),
    serviceChargeQuoteAtoms: checkedSigned(service, I128_BITS, `${context}.serviceChargeQuoteAtoms`),
    embeddedQuoteAtoms: checkedSigned(embedded, I128_BITS, `${context}.embeddedQuoteAtoms`),
  });
}

export interface BenchmarkComparison {
  readonly denominator: AssetAmount;
  /** After-charge improvement of the package arm over the sequential arm; positive is better. */
  readonly netImprovementQuoteAtoms: bigint;
  /** The net improvement with the package arm's one recognized service charge removed. */
  readonly grossImprovementQuoteAtoms: bigint;
  /** Improvements in basis points of the denominator, rounded toward negative infinity. */
  readonly netImprovementBps: bigint;
  readonly grossImprovementBps: bigint;
}

/** Compares both arms of one pair in the one ledger mode and quote currency the manifest froze. */
export function compareBenchmarkArms(
  manifestInput: BenchmarkManifestInput,
  packageLedger: CostLedgerInput,
  sequentialLedger: CostLedgerInput,
): BenchmarkComparison {
  const manifest = benchmarkManifest(manifestInput, 'compareBenchmarkArms.manifest');
  for (const [name, ledger] of [['packageLedger', packageLedger], ['sequentialLedger', sequentialLedger]] as const) {
    object(ledger, `compareBenchmarkArms.${name}`);
    if (ledger.mode !== manifest.costLedgerMode) throw new MalformedInputError(`compareBenchmarkArms.${name}.mode`, 'the ledger mode differs from the frozen mode');
    if (!sameAsset(checkedAsset(ledger.quoteAsset, `compareBenchmarkArms.${name}.quoteAsset`), manifest.quoteCurrency)) {
      throw new MalformedInputError(`compareBenchmarkArms.${name}.quoteAsset`, 'the ledger is valued in another quote currency');
    }
  }
  const packageTotals = costLedgerTotals(packageLedger, 'compareBenchmarkArms.packageLedger');
  const sequentialTotals = costLedgerTotals(sequentialLedger, 'compareBenchmarkArms.sequentialLedger');
  const denominator = benchmarkNotionalDenominator(manifestInput);
  if (denominator.atoms === 0n) throw new MalformedInputError('compareBenchmarkArms.denominator', 'the benchmark notional rounds to zero');
  const net = sequentialTotals.totalCostQuoteAtoms - packageTotals.totalCostQuoteAtoms;
  const gross = net + packageTotals.serviceChargeQuoteAtoms;
  return Object.freeze({
    denominator,
    netImprovementQuoteAtoms: net,
    grossImprovementQuoteAtoms: gross,
    netImprovementBps: mulDiv(net, BPS, denominator.atoms, 'FLOOR', 'compareBenchmarkArms.netImprovementBps'),
    grossImprovementBps: mulDiv(gross, BPS, denominator.atoms, 'FLOOR', 'compareBenchmarkArms.grossImprovementBps'),
  });
}

// ------------------------------------------------------------------ minimum top-up

/** `max(0, M - E - Bc)`: what a monthly minimum still charges after execution revenue and builder credit. */
export function minimumTopUp(input: {
  readonly monthlyMinimumQuoteAtoms: bigint;
  readonly executionRevenueQuoteAtoms: bigint;
  readonly builderCreditQuoteAtoms: bigint;
}): bigint {
  object(input, 'minimumTopUp');
  const minimum = unsigned(input.monthlyMinimumQuoteAtoms, U128_BITS, 'minimumTopUp.monthlyMinimumQuoteAtoms');
  const execution = unsigned(input.executionRevenueQuoteAtoms, U128_BITS, 'minimumTopUp.executionRevenueQuoteAtoms');
  const credit = unsigned(input.builderCreditQuoteAtoms, U128_BITS, 'minimumTopUp.builderCreditQuoteAtoms');
  const remaining = minimum - execution - credit;
  return remaining > 0n ? remaining : 0n;
}

/** `E + B + minimumTopUp`: the customer's service revenue for the month. */
export function customerServiceRevenue(input: {
  readonly executionRevenueQuoteAtoms: bigint;
  readonly builderRevenueQuoteAtoms: bigint;
  readonly minimumTopUpQuoteAtoms: bigint;
}): bigint {
  object(input, 'customerServiceRevenue');
  return (
    unsigned(input.executionRevenueQuoteAtoms, U128_BITS, 'customerServiceRevenue.executionRevenueQuoteAtoms') +
    unsigned(input.builderRevenueQuoteAtoms, U128_BITS, 'customerServiceRevenue.builderRevenueQuoteAtoms') +
    unsigned(input.minimumTopUpQuoteAtoms, U128_BITS, 'customerServiceRevenue.minimumTopUpQuoteAtoms')
  );
}

export interface TopUpAttempt {
  readonly attemptId: string;
  /** The attempt's frozen benchmark notional; failed and unresolved attempts keep theirs. */
  readonly requestedNotionalQuoteAtoms: bigint;
}

/**
 * Allocates a final monthly top-up across every eligible attempt of the month, failures and
 * unresolved attempts included, by requested notional or by equal weight. The allocation is exact
 * and deterministic: floor shares first, then one atom each to the largest remainders, ties by
 * attempt id. The shares always sum to the top-up.
 */
export function allocateMinimumTopUp(
  topUpQuoteAtoms: bigint,
  attempts: readonly TopUpAttempt[],
  basis: MinimumAllocationWeightBasis,
): readonly { readonly attemptId: ProtocolId; readonly quoteAtoms: bigint }[] {
  const topUp = unsigned(topUpQuoteAtoms, U128_BITS, 'allocateMinimumTopUp.topUpQuoteAtoms');
  const weightBasis = variant(MINIMUM_ALLOCATION_WEIGHT_BASIS, basis, 'allocateMinimumTopUp.basis');
  if (!Array.isArray(attempts) || attempts.length === 0 || attempts.length > MAX_TOP_UP_ATTEMPTS) {
    throw new MalformedInputError('allocateMinimumTopUp.attempts', `expected 1 to ${MAX_TOP_UP_ATTEMPTS} eligible attempts`);
  }
  const seen = new Set<string>();
  const weighted = attempts.map((attempt, index) => {
    const at = `allocateMinimumTopUp.attempts[${index}]`;
    object(attempt, at);
    const attemptId = protocolId(attempt.attemptId, `${at}.attemptId`);
    if (seen.has(attemptId)) throw new DuplicateElementError(`${at}.attemptId`, 'an attempt is listed twice');
    seen.add(attemptId);
    const notional = unsigned(attempt.requestedNotionalQuoteAtoms, U128_BITS, `${at}.requestedNotionalQuoteAtoms`);
    return { attemptId, weight: weightBasis === 'EQUAL_ATTEMPT' ? 1n : notional };
  });
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0n);
  if (totalWeight === 0n) throw new MalformedInputError('allocateMinimumTopUp.attempts', 'the attempts carry no allocation weight');
  const shares = weighted.map((entry) => ({ attemptId: entry.attemptId, quoteAtoms: (topUp * entry.weight) / totalWeight, remainder: (topUp * entry.weight) % totalWeight }));
  let leftover = topUp - shares.reduce((sum, share) => sum + share.quoteAtoms, 0n);
  const order = [...shares].sort((left, right) =>
    left.remainder === right.remainder ? (left.attemptId < right.attemptId ? -1 : left.attemptId > right.attemptId ? 1 : 0) : left.remainder > right.remainder ? -1 : 1,
  );
  for (const share of order) {
    if (leftover === 0n) break;
    share.quoteAtoms += 1n;
    leftover -= 1n;
  }
  return Object.freeze(shares.map((share) => Object.freeze({ attemptId: share.attemptId, quoteAtoms: share.quoteAtoms })));
}
