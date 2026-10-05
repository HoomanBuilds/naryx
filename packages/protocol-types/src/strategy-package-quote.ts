import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { assertUint8Array, compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  EXPIRY_UNIT,
  FEE_CATEGORY,
  PASS_THROUGH_COST_CATEGORY,
  QUOTE_MODE,
  SETTLEMENT_CLASS,
  SOLVER_SIGNATURE_SCHEME,
  type ExpiryUnit,
  type FeeCategory,
  type PassThroughCostCategory,
  type QuoteMode,
  type SettlementClass,
  type SolverSignatureScheme,
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
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type AssetAmount,
  type AssetRef,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';
import { requireStrategyTemplateDefinition } from './strategy-template-program.js';

export const STRATEGY_PACKAGE_QUOTE_VERSION = 1;
export const STRATEGY_QUOTE_MAX_LEG_ECONOMICS = 32;
export const STRATEGY_QUOTE_MAX_METRICS = 32;
export const STRATEGY_QUOTE_MAX_CHARGES = 32;
const U8_BITS = 8;
const U32_BITS = 32;
const U64_BITS = 64;
const U256_BITS = 256;
const I128_BITS = 128;
const MAX_SIGNATURE_BYTES = 128;

export interface StrategyQuoteMetricInput {
  readonly metricId: string;
  readonly value: bigint;
  readonly scale: number;
  readonly unitId: string;
}

export interface StrategyQuoteMetric {
  readonly metricId: ProtocolId;
  readonly value: bigint;
  readonly scale: number;
  readonly unitId: ProtocolId;
}

export interface StrategyLegEconomicsInput {
  readonly legId: string;
  readonly quantity: AssetAmount;
  readonly executionPrice?: ExactPriceInput;
  readonly grossNotional: AssetAmount;
  readonly marginDelta: AssetAmount;
  readonly venueFee: AssetAmount;
  readonly builderFee: AssetAmount;
  readonly residualValue: AssetAmount;
}

export interface StrategyLegEconomics {
  readonly legId: ProtocolId;
  readonly quantity: AssetAmount;
  readonly executionPrice?: ExactPrice;
  readonly grossNotional: AssetAmount;
  readonly marginDelta: AssetAmount;
  readonly venueFee: AssetAmount;
  readonly builderFee: AssetAmount;
  readonly residualValue: AssetAmount;
}

export interface StrategyServiceChargeInput {
  readonly category: FeeCategory;
  readonly amount: AssetAmount;
}

export interface StrategyServiceCharge {
  readonly category: FeeCategory;
  readonly amount: AssetAmount;
}

export interface StrategyPassThroughCostInput {
  readonly category: PassThroughCostCategory;
  readonly amount: AssetAmount;
}

export interface StrategyPassThroughCost {
  readonly category: PassThroughCostCategory;
  readonly amount: AssetAmount;
}

export interface StrategyPackageQuoteInput {
  readonly version: number;
  readonly environment: string;
  readonly domains: readonly DomainRef[];
  readonly orderHash: Uint8Array | string;
  readonly graphHash: Uint8Array | string;
  readonly routeHash: Uint8Array | string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly seriesId: string;
  readonly seriesVersion: number;
  readonly seriesManifestHash: Uint8Array | string;
  readonly executionClassId: string;
  readonly executionClassVersion: number;
  readonly executionClassManifestHash: Uint8Array | string;
  readonly quoteConventionId: string;
  readonly riskClassId: string;
  readonly solverId: string;
  readonly solverCapabilityManifestHash: Uint8Array | string;
  readonly quoteMode: QuoteMode;
  readonly settlementClass: SettlementClass;
  readonly quoteAsset: AssetRef;
  readonly metrics: readonly StrategyQuoteMetricInput[];
  readonly legEconomics: readonly StrategyLegEconomicsInput[];
  readonly netPackageOutcome: AssetAmount;
  readonly totalGrossNotional: AssetAmount;
  readonly totalMarginDelta: AssetAmount;
  readonly totalResidualValue: AssetAmount;
  readonly serviceCharges: readonly StrategyServiceChargeInput[];
  readonly passThroughCosts: readonly StrategyPassThroughCostInput[];
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Uint8Array | string;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly reservationId?: Uint8Array | string;
  readonly performanceBondId?: Uint8Array | string;
  readonly quoteNonce: bigint;
  readonly solverSignatureScheme: SolverSignatureScheme;
  readonly solverVerificationKey: Uint8Array;
  readonly signature: Uint8Array;
}

export interface StrategyPackageQuote extends Omit<
  StrategyPackageQuoteInput,
  | 'environment'
  | 'domains'
  | 'orderHash'
  | 'graphHash'
  | 'routeHash'
  | 'templateId'
  | 'packageTemplateManifestHash'
  | 'seriesId'
  | 'seriesManifestHash'
  | 'executionClassId'
  | 'executionClassManifestHash'
  | 'quoteConventionId'
  | 'riskClassId'
  | 'solverId'
  | 'solverCapabilityManifestHash'
  | 'quoteAsset'
  | 'metrics'
  | 'legEconomics'
  | 'netPackageOutcome'
  | 'totalGrossNotional'
  | 'totalMarginDelta'
  | 'totalResidualValue'
  | 'serviceCharges'
  | 'passThroughCosts'
  | 'feePolicyManifestHash'
  | 'reservationId'
  | 'performanceBondId'
  | 'solverVerificationKey'
  | 'signature'
> {
  readonly version: 1;
  readonly environment: ProtocolId;
  readonly domains: readonly DomainRef[];
  readonly orderHash: CommitmentHash;
  readonly graphHash: CommitmentHash;
  readonly routeHash: CommitmentHash;
  readonly templateId: ProtocolId;
  readonly packageTemplateManifestHash: ManifestHash;
  readonly seriesId: ProtocolId;
  readonly seriesManifestHash: ManifestHash;
  readonly executionClassId: ProtocolId;
  readonly executionClassManifestHash: ManifestHash;
  readonly quoteConventionId: ProtocolId;
  readonly riskClassId: ProtocolId;
  readonly solverId: ProtocolId;
  readonly solverCapabilityManifestHash: ManifestHash;
  readonly quoteAsset: AssetRef;
  readonly metrics: readonly StrategyQuoteMetric[];
  readonly legEconomics: readonly StrategyLegEconomics[];
  readonly netPackageOutcome: AssetAmount;
  readonly totalGrossNotional: AssetAmount;
  readonly totalMarginDelta: AssetAmount;
  readonly totalResidualValue: AssetAmount;
  readonly serviceCharges: readonly StrategyServiceCharge[];
  readonly passThroughCosts: readonly StrategyPassThroughCost[];
  readonly feePolicyManifestHash: ManifestHash;
  readonly reservationId?: CommitmentHash;
  readonly performanceBondId?: CommitmentHash;
  readonly solverVerificationKey: Uint8Array;
  readonly signature: Uint8Array;
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && compareBytes(left.assetManifestHash, right.assetManifestHash) === 0;
}

function checkedAsset(value: AssetRef, context: string): AssetRef {
  object(value, context);
  return assetRef(value.assetId, value.assetManifestHash, value.decimals, context);
}

function checkedAmount(value: AssetAmount, context: string): AssetAmount {
  object(value, context);
  return assetAmount(value.asset, value.atoms, context);
}

function quoteAmount(value: AssetAmount, quoteAsset: AssetRef, context: string, nonnegative = false): AssetAmount {
  const checked = checkedAmount(value, context);
  if (!sameAsset(checked.asset, quoteAsset)) throw new MalformedInputError(`${context}.asset`, 'asset must equal the quote asset');
  if (nonnegative && checked.atoms < 0n) throw new MalformedInputError(`${context}.atoms`, 'amount must be nonnegative');
  return checked;
}

function checkedDomains(values: readonly DomainRef[], context: string): readonly DomainRef[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 16) throw new MalformedInputError(context, 'expected 1 to 16 domains');
  const checked = values.map((value, index) => {
    object(value, `${context}[${index}]`);
    return domainRef(value.domainId, value.domainManifestVersion, value.domainManifestHash, `${context}[${index}]`);
  }).sort((left, right) => left.domainId.localeCompare(right.domainId));
  for (let index = 1; index < checked.length; index += 1) {
    if (checked[index - 1]!.domainId === checked[index]!.domainId) throw new DuplicateElementError(context, `domain ${checked[index]!.domainId} appears twice`);
  }
  return Object.freeze(checked);
}

function checkedMetrics(
  values: readonly StrategyQuoteMetricInput[],
  requiredMetricIds: readonly ProtocolId[],
  context: string,
): readonly StrategyQuoteMetric[] {
  if (!Array.isArray(values) || values.length > STRATEGY_QUOTE_MAX_METRICS) throw new MalformedInputError(context, `expected at most ${STRATEGY_QUOTE_MAX_METRICS} metrics`);
  const required = new Set<string>(requiredMetricIds);
  const checked = values.map((value, index) => {
    const at = `${context}[${index}]`;
    object(value, at);
    const metricId = protocolId(value.metricId, `${at}.metricId`);
    if (!required.has(metricId)) throw new MalformedInputError(`${at}.metricId`, 'metric is not declared by the template');
    if (!Number.isInteger(value.scale)) throw new MalformedInputError(`${at}.scale`, 'expected an integer');
    return Object.freeze({
      metricId,
      value: checkedSigned(value.value, I128_BITS, `${at}.value`),
      scale: Number(checkedUnsigned(value.scale, U8_BITS, `${at}.scale`)),
      unitId: protocolId(value.unitId, `${at}.unitId`),
    });
  }).sort((left, right) => left.metricId.localeCompare(right.metricId));
  for (let index = 1; index < checked.length; index += 1) {
    if (checked[index - 1]!.metricId === checked[index]!.metricId) throw new DuplicateElementError(context, `metric ${checked[index]!.metricId} appears twice`);
  }
  if (checked.length !== required.size || checked.some((value) => !required.has(value.metricId))) {
    throw new MalformedInputError(context, 'quote must carry every metric declared by the template exactly once');
  }
  return Object.freeze(checked);
}

function checkedLegEconomics(
  values: readonly StrategyLegEconomicsInput[],
  quoteAsset: AssetRef,
  context: string,
): readonly StrategyLegEconomics[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > STRATEGY_QUOTE_MAX_LEG_ECONOMICS) {
    throw new MalformedInputError(context, `expected 1 to ${STRATEGY_QUOTE_MAX_LEG_ECONOMICS} leg records`);
  }
  const checked = values.map((value, index) => {
    const at = `${context}[${index}]`;
    object(value, at);
    const quantity = checkedAmount(value.quantity, `${at}.quantity`);
    if (quantity.atoms === 0n) throw new MalformedInputError(`${at}.quantity.atoms`, 'quantity is zero');
    const executionPrice = value.executionPrice === undefined ? undefined : exactPrice(value.executionPrice, `${at}.executionPrice`);
    if (executionPrice !== undefined && !sameAsset(executionPrice.quoteAsset, quoteAsset)) throw new MalformedInputError(`${at}.executionPrice.quoteAsset`, 'price must use the quote asset');
    return Object.freeze({
      legId: protocolId(value.legId, `${at}.legId`),
      quantity,
      ...(executionPrice === undefined ? {} : { executionPrice }),
      grossNotional: quoteAmount(value.grossNotional, quoteAsset, `${at}.grossNotional`, true),
      marginDelta: quoteAmount(value.marginDelta, quoteAsset, `${at}.marginDelta`),
      venueFee: quoteAmount(value.venueFee, quoteAsset, `${at}.venueFee`, true),
      builderFee: quoteAmount(value.builderFee, quoteAsset, `${at}.builderFee`, true),
      residualValue: quoteAmount(value.residualValue, quoteAsset, `${at}.residualValue`, true),
    });
  }).sort((left, right) => left.legId.localeCompare(right.legId));
  for (let index = 1; index < checked.length; index += 1) {
    if (checked[index - 1]!.legId === checked[index]!.legId) throw new DuplicateElementError(context, `leg ${checked[index]!.legId} appears twice`);
  }
  return Object.freeze(checked);
}

function checkedCharges<T extends FeeCategory | PassThroughCostCategory>(
  values: readonly { readonly category: T; readonly amount: AssetAmount }[],
  table: Readonly<Record<T, number>>,
  quoteAsset: AssetRef,
  context: string,
): readonly { readonly category: T; readonly amount: AssetAmount }[] {
  if (!Array.isArray(values) || values.length > STRATEGY_QUOTE_MAX_CHARGES) throw new MalformedInputError(context, `expected at most ${STRATEGY_QUOTE_MAX_CHARGES} charges`);
  const checked: { readonly category: T; readonly amount: AssetAmount }[] = values.map((value, index) => {
    const at = `${context}[${index}]`;
    object(value, at);
    enumDiscriminant(table, value.category, `${at}.category`);
    return Object.freeze({ category: value.category, amount: quoteAmount(value.amount, quoteAsset, `${at}.amount`, true) });
  }).sort((left, right) => table[left.category as T] - table[right.category as T]);
  for (let index = 1; index < checked.length; index += 1) {
    if (checked[index - 1]!.category === checked[index]!.category) throw new DuplicateElementError(context, `category ${checked[index]!.category} appears twice`);
  }
  return Object.freeze(checked);
}

function optionalHash(value: Uint8Array | string | undefined, context: string): CommitmentHash | undefined {
  return value === undefined ? undefined : commitmentHash(value, context);
}

export function strategyPackageQuote(
  input: StrategyPackageQuoteInput,
  context = 'strategyPackageQuote',
): StrategyPackageQuote {
  object(input, context);
  if (input.version !== STRATEGY_PACKAGE_QUOTE_VERSION) throw new MalformedInputError(`${context}.version`, `version must equal ${STRATEGY_PACKAGE_QUOTE_VERSION}`);
  const definition = requireStrategyTemplateDefinition(input.templateId);
  if (input.templateVersion !== definition.templateVersion) throw new MalformedInputError(`${context}.templateVersion`, 'unsupported template version');
  const quoteConventionId = protocolId(input.quoteConventionId, `${context}.quoteConventionId`);
  const riskClassId = protocolId(input.riskClassId, `${context}.riskClassId`);
  if (quoteConventionId !== definition.quoteConventionId) throw new MalformedInputError(`${context}.quoteConventionId`, 'quote convention does not match the template');
  if (riskClassId !== definition.riskClassId) throw new MalformedInputError(`${context}.riskClassId`, 'risk class does not match the template');
  enumDiscriminant(QUOTE_MODE, input.quoteMode, `${context}.quoteMode`);
  enumDiscriminant(SETTLEMENT_CLASS, input.settlementClass, `${context}.settlementClass`);
  enumDiscriminant(EXPIRY_UNIT, input.validUntilUnit, `${context}.validUntilUnit`);
  enumDiscriminant(SOLVER_SIGNATURE_SCHEME, input.solverSignatureScheme, `${context}.solverSignatureScheme`);
  const quoteAsset = checkedAsset(input.quoteAsset, `${context}.quoteAsset`);
  const validUntilValue = checkedUnsigned(input.validUntilValue, U64_BITS, `${context}.validUntilValue`);
  const quoteNonce = checkedUnsigned(input.quoteNonce, U256_BITS, `${context}.quoteNonce`);
  const feePolicyVersion = Number(checkedUnsigned(input.feePolicyVersion, U32_BITS, `${context}.feePolicyVersion`));
  const seriesVersion = Number(checkedUnsigned(input.seriesVersion, U32_BITS, `${context}.seriesVersion`));
  const executionClassVersion = Number(checkedUnsigned(input.executionClassVersion, U32_BITS, `${context}.executionClassVersion`));
  if (validUntilValue === 0n || quoteNonce === 0n || feePolicyVersion === 0 || seriesVersion === 0 || executionClassVersion === 0) {
    throw new MalformedInputError(context, 'validity, nonce, and manifest versions must be nonzero');
  }
  assertUint8Array(input.solverVerificationKey, `${context}.solverVerificationKey`);
  assertUint8Array(input.signature, `${context}.signature`);
  if (input.solverVerificationKey.length === 0 || input.solverVerificationKey.length > 128) throw new MalformedInputError(`${context}.solverVerificationKey`, 'verification key length is outside 1 to 128 bytes');
  if (input.signature.length > MAX_SIGNATURE_BYTES) throw new MalformedInputError(`${context}.signature`, `signature exceeds ${MAX_SIGNATURE_BYTES} bytes`);
  const reservationId = optionalHash(input.reservationId, `${context}.reservationId`);
  if ((input.quoteMode === 'FIRM_ONCHAIN' || input.quoteMode === 'FIRM_SIMULATED') !== (reservationId !== undefined)) {
    throw new MalformedInputError(`${context}.reservationId`, 'reservation is required exactly for reserved firm quote modes');
  }
  const performanceBondId = optionalHash(input.performanceBondId, `${context}.performanceBondId`);
  if ((input.quoteMode === 'FIRM_BONDED') !== (performanceBondId !== undefined)) {
    throw new MalformedInputError(`${context}.performanceBondId`, 'performance bond is required exactly for a bonded quote');
  }
  return Object.freeze({
    version: STRATEGY_PACKAGE_QUOTE_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    domains: checkedDomains(input.domains, `${context}.domains`),
    orderHash: commitmentHash(input.orderHash, `${context}.orderHash`),
    graphHash: commitmentHash(input.graphHash, `${context}.graphHash`),
    routeHash: commitmentHash(input.routeHash, `${context}.routeHash`),
    templateId: definition.templateId,
    templateVersion: definition.templateVersion,
    packageTemplateManifestHash: manifestHash(input.packageTemplateManifestHash, `${context}.packageTemplateManifestHash`),
    seriesId: protocolId(input.seriesId, `${context}.seriesId`),
    seriesVersion,
    seriesManifestHash: manifestHash(input.seriesManifestHash, `${context}.seriesManifestHash`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    executionClassVersion,
    executionClassManifestHash: manifestHash(input.executionClassManifestHash, `${context}.executionClassManifestHash`),
    quoteConventionId,
    riskClassId,
    solverId: protocolId(input.solverId, `${context}.solverId`),
    solverCapabilityManifestHash: manifestHash(input.solverCapabilityManifestHash, `${context}.solverCapabilityManifestHash`),
    quoteMode: input.quoteMode,
    settlementClass: input.settlementClass,
    quoteAsset,
    metrics: checkedMetrics(input.metrics, definition.metricIds, `${context}.metrics`),
    legEconomics: checkedLegEconomics(input.legEconomics, quoteAsset, `${context}.legEconomics`),
    netPackageOutcome: quoteAmount(input.netPackageOutcome, quoteAsset, `${context}.netPackageOutcome`),
    totalGrossNotional: quoteAmount(input.totalGrossNotional, quoteAsset, `${context}.totalGrossNotional`, true),
    totalMarginDelta: quoteAmount(input.totalMarginDelta, quoteAsset, `${context}.totalMarginDelta`),
    totalResidualValue: quoteAmount(input.totalResidualValue, quoteAsset, `${context}.totalResidualValue`, true),
    serviceCharges: checkedCharges(input.serviceCharges, FEE_CATEGORY, quoteAsset, `${context}.serviceCharges`) as readonly StrategyServiceCharge[],
    passThroughCosts: checkedCharges(input.passThroughCosts, PASS_THROUGH_COST_CATEGORY, quoteAsset, `${context}.passThroughCosts`) as readonly StrategyPassThroughCost[],
    feePolicyVersion,
    feePolicyManifestHash: manifestHash(input.feePolicyManifestHash, `${context}.feePolicyManifestHash`),
    validUntilUnit: input.validUntilUnit,
    validUntilValue,
    ...(reservationId === undefined ? {} : { reservationId }),
    ...(performanceBondId === undefined ? {} : { performanceBondId }),
    quoteNonce,
    solverSignatureScheme: input.solverSignatureScheme,
    solverVerificationKey: Uint8Array.from(input.solverVerificationKey),
    signature: Uint8Array.from(input.signature),
  });
}

function encodeMetric(writer: CanonicalWriter, value: StrategyQuoteMetric): void {
  encodeProtocolId(writer, value.metricId, 'metricId');
  writer.writeI128(value.value, 'value');
  writer.writeU8(value.scale, 'scale');
  encodeProtocolId(writer, value.unitId, 'unitId');
}

function encodeLegEconomics(writer: CanonicalWriter, value: StrategyLegEconomics): void {
  encodeProtocolId(writer, value.legId, 'legId');
  encodeAssetAmount(writer, value.quantity);
  writer.writeOptional(value.executionPrice, (element, price) => encodeExactPrice(element, price), 'executionPrice');
  encodeAssetAmount(writer, value.grossNotional);
  encodeAssetAmount(writer, value.marginDelta);
  encodeAssetAmount(writer, value.venueFee);
  encodeAssetAmount(writer, value.builderFee);
  encodeAssetAmount(writer, value.residualValue);
}

function encodeServiceCharge(writer: CanonicalWriter, value: StrategyServiceCharge): void {
  writer.writeEnum(FEE_CATEGORY, value.category, 'category');
  encodeAssetAmount(writer, value.amount);
}

function encodePassThroughCost(writer: CanonicalWriter, value: StrategyPassThroughCost): void {
  writer.writeEnum(PASS_THROUGH_COST_CATEGORY, value.category, 'category');
  encodeAssetAmount(writer, value.amount);
}

function encodeOptionalHash(writer: CanonicalWriter, value: CommitmentHash | undefined, context: string): void {
  writer.writeOptional(value, (element, hash) => encodeCommitmentHash(element, hash, context), context);
}

function encodeUnsignedStrategyPackageQuote(writer: CanonicalWriter, value: StrategyPackageQuote): void {
  writer.writeU32(value.version, 'version');
  encodeProtocolId(writer, value.environment, 'environment');
  writer.writeArray(value.domains, (element, domain) => encodeDomainRef(element, domain), 'domains');
  encodeCommitmentHash(writer, value.orderHash, 'orderHash');
  encodeCommitmentHash(writer, value.graphHash, 'graphHash');
  encodeCommitmentHash(writer, value.routeHash, 'routeHash');
  encodeProtocolId(writer, value.templateId, 'templateId');
  writer.writeU32(value.templateVersion, 'templateVersion');
  encodeManifestHash(writer, value.packageTemplateManifestHash, 'packageTemplateManifestHash');
  encodeProtocolId(writer, value.seriesId, 'seriesId');
  writer.writeU32(value.seriesVersion, 'seriesVersion');
  encodeManifestHash(writer, value.seriesManifestHash, 'seriesManifestHash');
  encodeProtocolId(writer, value.executionClassId, 'executionClassId');
  writer.writeU32(value.executionClassVersion, 'executionClassVersion');
  encodeManifestHash(writer, value.executionClassManifestHash, 'executionClassManifestHash');
  encodeProtocolId(writer, value.quoteConventionId, 'quoteConventionId');
  encodeProtocolId(writer, value.riskClassId, 'riskClassId');
  encodeProtocolId(writer, value.solverId, 'solverId');
  encodeManifestHash(writer, value.solverCapabilityManifestHash, 'solverCapabilityManifestHash');
  writer.writeEnum(QUOTE_MODE, value.quoteMode, 'quoteMode');
  writer.writeEnum(SETTLEMENT_CLASS, value.settlementClass, 'settlementClass');
  encodeAssetRef(writer, value.quoteAsset);
  writer.writeArray(value.metrics, encodeMetric, 'metrics');
  writer.writeArray(value.legEconomics, encodeLegEconomics, 'legEconomics');
  encodeAssetAmount(writer, value.netPackageOutcome);
  encodeAssetAmount(writer, value.totalGrossNotional);
  encodeAssetAmount(writer, value.totalMarginDelta);
  encodeAssetAmount(writer, value.totalResidualValue);
  writer.writeArray(value.serviceCharges, encodeServiceCharge, 'serviceCharges');
  writer.writeArray(value.passThroughCosts, encodePassThroughCost, 'passThroughCosts');
  writer.writeU32(value.feePolicyVersion, 'feePolicyVersion');
  encodeManifestHash(writer, value.feePolicyManifestHash, 'feePolicyManifestHash');
  writer.writeEnum(EXPIRY_UNIT, value.validUntilUnit, 'validUntilUnit');
  writer.writeU64(value.validUntilValue, 'validUntilValue');
  encodeOptionalHash(writer, value.reservationId, 'reservationId');
  encodeOptionalHash(writer, value.performanceBondId, 'performanceBondId');
  writer.writeU256(value.quoteNonce, 'quoteNonce');
  writer.writeEnum(SOLVER_SIGNATURE_SCHEME, value.solverSignatureScheme, 'solverSignatureScheme');
  writer.writeByteString(value.solverVerificationKey, 'solverVerificationKey');
}

export function unsignedStrategyPackageQuoteBytes(input: StrategyPackageQuoteInput): Uint8Array {
  const value = strategyPackageQuote(input);
  return canonicalBytes((writer) => encodeUnsignedStrategyPackageQuote(writer, value));
}

export function strategyPackageQuoteBytes(input: StrategyPackageQuoteInput): Uint8Array {
  const value = strategyPackageQuote(input);
  return canonicalBytes((writer) => {
    encodeUnsignedStrategyPackageQuote(writer, value);
    writer.writeByteString(value.signature, 'signature');
  });
}

export function strategyPackageQuoteHash(input: StrategyPackageQuoteInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.STRATEGY_QUOTE, unsignedStrategyPackageQuoteBytes(input)), 'strategyPackageQuoteHash');
}
