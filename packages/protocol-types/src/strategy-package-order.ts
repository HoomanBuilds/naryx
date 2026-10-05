import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  COMPARATOR,
  enumDiscriminant,
  EXPIRY_UNIT,
  PACKAGE_ORDER_TYPE,
  PACKAGE_TIME_IN_FORCE,
  SETTLEMENT_CLASS,
  type Comparator,
  type ExpiryUnit,
  type PackageOrderType,
  type PackageTimeInForce,
  type SettlementClass,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  canonicalFeeCaps,
  commitmentHash,
  encodeCommitmentHash,
  encodeFeeCap,
  type CommitmentHash,
  type FeeCap,
  type FeeCapInput,
} from './package-order-primitives.js';
import {
  GRAPH_LIFECYCLE_ACTION,
  type GraphLifecycleAction,
} from './package-graph.js';
import {
  assetAmount,
  assetRef,
  encodeAssetAmount,
  encodeAssetRef,
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type AssetAmount,
  type AssetRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';
import { requireStrategyTemplateDefinition } from './strategy-template-program.js';

export const STRATEGY_PACKAGE_ORDER_VERSION = 1;
export const STRATEGY_ORDER_MAX_METRIC_LIMITS = 32;
const U8_BITS = 8;
const U32_BITS = 32;
const U64_BITS = 64;
const U256_BITS = 256;
const I128_BITS = 128;

export interface StrategyMetricLimitInput {
  readonly metricId: string;
  readonly comparator: Comparator;
  readonly value: bigint;
  readonly scale: number;
  readonly unitId: string;
}

export interface StrategyMetricLimit {
  readonly metricId: ProtocolId;
  readonly comparator: Comparator;
  readonly value: bigint;
  readonly scale: number;
  readonly unitId: ProtocolId;
}

export interface StrategyPackageOrderInput {
  readonly version: number;
  readonly environment: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly graphHash: Uint8Array | string;
  readonly seriesId: string;
  readonly seriesVersion: number;
  readonly seriesManifestHash: Uint8Array | string;
  readonly executionClassId: string;
  readonly executionClassVersion: number;
  readonly executionClassManifestHash: Uint8Array | string;
  readonly quoteConventionId: string;
  readonly riskClassId: string;
  readonly owner: string;
  readonly settlementAccount: string;
  readonly lifecycleAction: GraphLifecycleAction;
  readonly settlementClass: SettlementClass;
  readonly packageOrderType: PackageOrderType;
  readonly packageTimeInForce: PackageTimeInForce;
  readonly economicQuantity: AssetAmount;
  readonly quoteAsset: AssetRef;
  readonly metricLimits: readonly StrategyMetricLimitInput[];
  readonly maximumServiceFeesByAsset: readonly FeeCapInput[];
  readonly maximumVenueFeesByAsset: readonly FeeCapInput[];
  readonly maximumNetworkFeesByAsset: readonly FeeCapInput[];
  readonly maximumRecoveryCostByAsset: readonly FeeCapInput[];
  readonly maximumMarginIncrease: AssetAmount;
  readonly maximumResidualValue: AssetAmount;
  readonly activationConditionHash?: Uint8Array | string;
  readonly executionScheduleHash?: Uint8Array | string;
  readonly expectedStrategyStateHash?: Uint8Array | string;
  readonly entryReceiptHash?: Uint8Array | string;
  readonly expiryUnit: ExpiryUnit;
  readonly expiryValue: bigint;
  readonly nonce: bigint;
}

export interface StrategyPackageOrder extends Omit<
  StrategyPackageOrderInput,
  | 'environment'
  | 'templateId'
  | 'packageTemplateManifestHash'
  | 'graphHash'
  | 'seriesId'
  | 'seriesManifestHash'
  | 'executionClassId'
  | 'executionClassManifestHash'
  | 'quoteConventionId'
  | 'riskClassId'
  | 'owner'
  | 'settlementAccount'
  | 'economicQuantity'
  | 'quoteAsset'
  | 'metricLimits'
  | 'maximumServiceFeesByAsset'
  | 'maximumVenueFeesByAsset'
  | 'maximumNetworkFeesByAsset'
  | 'maximumRecoveryCostByAsset'
  | 'maximumMarginIncrease'
  | 'maximumResidualValue'
  | 'activationConditionHash'
  | 'executionScheduleHash'
  | 'expectedStrategyStateHash'
  | 'entryReceiptHash'
> {
  readonly version: 1;
  readonly environment: ProtocolId;
  readonly templateId: ProtocolId;
  readonly packageTemplateManifestHash: ManifestHash;
  readonly graphHash: CommitmentHash;
  readonly seriesId: ProtocolId;
  readonly seriesManifestHash: ManifestHash;
  readonly executionClassId: ProtocolId;
  readonly executionClassManifestHash: ManifestHash;
  readonly quoteConventionId: ProtocolId;
  readonly riskClassId: ProtocolId;
  readonly owner: ProtocolId;
  readonly settlementAccount: ProtocolId;
  readonly economicQuantity: AssetAmount;
  readonly quoteAsset: AssetRef;
  readonly metricLimits: readonly StrategyMetricLimit[];
  readonly maximumServiceFeesByAsset: readonly FeeCap[];
  readonly maximumVenueFeesByAsset: readonly FeeCap[];
  readonly maximumNetworkFeesByAsset: readonly FeeCap[];
  readonly maximumRecoveryCostByAsset: readonly FeeCap[];
  readonly maximumMarginIncrease: AssetAmount;
  readonly maximumResidualValue: AssetAmount;
  readonly activationConditionHash?: CommitmentHash;
  readonly executionScheduleHash?: CommitmentHash;
  readonly expectedStrategyStateHash?: CommitmentHash;
  readonly entryReceiptHash?: CommitmentHash;
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function nonzeroU32(value: number, context: string): number {
  if (!Number.isInteger(value)) throw new MalformedInputError(context, 'expected an integer');
  const checked = checkedUnsigned(value, U32_BITS, context);
  if (checked === 0n) throw new MalformedInputError(context, 'value is zero');
  return Number(checked);
}

function optionalHash(value: Uint8Array | string | undefined, context: string): CommitmentHash | undefined {
  return value === undefined ? undefined : commitmentHash(value, context);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && compareBytes(left.assetManifestHash, right.assetManifestHash) === 0;
}

function checkedMetricLimits(
  values: readonly StrategyMetricLimitInput[],
  permittedMetricIds: readonly ProtocolId[],
  context: string,
): readonly StrategyMetricLimit[] {
  if (!Array.isArray(values) || values.length > STRATEGY_ORDER_MAX_METRIC_LIMITS) {
    throw new MalformedInputError(context, `expected at most ${STRATEGY_ORDER_MAX_METRIC_LIMITS} metric limits`);
  }
  const permitted = new Set<string>(permittedMetricIds);
  const checked = values.map((value, index) => {
    const at = `${context}[${index}]`;
    object(value, at);
    const metricId = protocolId(value.metricId, `${at}.metricId`);
    if (!permitted.has(metricId)) throw new MalformedInputError(`${at}.metricId`, 'metric is not declared by the template');
    enumDiscriminant(COMPARATOR, value.comparator, `${at}.comparator`);
    if (!Number.isInteger(value.scale)) throw new MalformedInputError(`${at}.scale`, 'expected an integer');
    return Object.freeze({
      metricId,
      comparator: value.comparator,
      value: checkedSigned(value.value, I128_BITS, `${at}.value`),
      scale: Number(checkedUnsigned(value.scale, U8_BITS, `${at}.scale`)),
      unitId: protocolId(value.unitId, `${at}.unitId`),
    });
  }).sort((left, right) => left.metricId.localeCompare(right.metricId));
  for (let index = 1; index < checked.length; index += 1) {
    if (checked[index - 1]!.metricId === checked[index]!.metricId) {
      throw new DuplicateElementError(context, `metric ${checked[index]!.metricId} appears twice`);
    }
  }
  return Object.freeze(checked);
}

function checkedPositiveAmount(value: AssetAmount, context: string): AssetAmount {
  object(value, context);
  const checked = assetAmount(value.asset, value.atoms, context);
  if (checked.atoms <= 0n) throw new MalformedInputError(`${context}.atoms`, 'amount must be positive');
  return checked;
}

function checkedNonnegativeAmount(value: AssetAmount, expectedAsset: AssetRef, context: string): AssetAmount {
  object(value, context);
  const checked = assetAmount(value.asset, value.atoms, context);
  if (!sameAsset(checked.asset, expectedAsset)) throw new MalformedInputError(`${context}.asset`, 'asset must equal the quote asset');
  if (checked.atoms < 0n) throw new MalformedInputError(`${context}.atoms`, 'amount must be nonnegative');
  return checked;
}

export function strategyPackageOrder(
  input: StrategyPackageOrderInput,
  context = 'strategyPackageOrder',
): StrategyPackageOrder {
  object(input, context);
  if (input.version !== STRATEGY_PACKAGE_ORDER_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${STRATEGY_PACKAGE_ORDER_VERSION}`);
  }
  const definition = requireStrategyTemplateDefinition(input.templateId);
  const templateVersion = nonzeroU32(input.templateVersion, `${context}.templateVersion`);
  if (templateVersion !== definition.templateVersion) throw new MalformedInputError(`${context}.templateVersion`, 'unsupported template version');
  const quoteConventionId = protocolId(input.quoteConventionId, `${context}.quoteConventionId`);
  const riskClassId = protocolId(input.riskClassId, `${context}.riskClassId`);
  if (quoteConventionId !== definition.quoteConventionId) throw new MalformedInputError(`${context}.quoteConventionId`, 'quote convention does not match the template');
  if (riskClassId !== definition.riskClassId) throw new MalformedInputError(`${context}.riskClassId`, 'risk class does not match the template');
  enumDiscriminant(GRAPH_LIFECYCLE_ACTION, input.lifecycleAction, `${context}.lifecycleAction`);
  const actionSpec = definition.actionSpecs.find((value) => value.action === input.lifecycleAction);
  if (actionSpec === undefined) throw new MalformedInputError(`${context}.lifecycleAction`, 'action is not supported by the template');
  enumDiscriminant(SETTLEMENT_CLASS, input.settlementClass, `${context}.settlementClass`);
  if (!actionSpec.allowedSettlementClasses.includes(input.settlementClass)) throw new MalformedInputError(`${context}.settlementClass`, 'settlement class is not supported for this action');
  enumDiscriminant(PACKAGE_ORDER_TYPE, input.packageOrderType, `${context}.packageOrderType`);
  enumDiscriminant(PACKAGE_TIME_IN_FORCE, input.packageTimeInForce, `${context}.packageTimeInForce`);
  enumDiscriminant(EXPIRY_UNIT, input.expiryUnit, `${context}.expiryUnit`);
  const quoteAsset = assetRef(input.quoteAsset.assetId, input.quoteAsset.assetManifestHash, input.quoteAsset.decimals, `${context}.quoteAsset`);
  const economicQuantity = checkedPositiveAmount(input.economicQuantity, `${context}.economicQuantity`);
  const maximumMarginIncrease = checkedNonnegativeAmount(input.maximumMarginIncrease, quoteAsset, `${context}.maximumMarginIncrease`);
  const maximumResidualValue = checkedNonnegativeAmount(input.maximumResidualValue, quoteAsset, `${context}.maximumResidualValue`);
  const expiryValue = checkedUnsigned(input.expiryValue, U64_BITS, `${context}.expiryValue`);
  const nonce = checkedUnsigned(input.nonce, U256_BITS, `${context}.nonce`);
  if (expiryValue === 0n || nonce === 0n) throw new MalformedInputError(context, 'expiry and nonce must be nonzero');
  const entryReceiptHash = optionalHash(input.entryReceiptHash, `${context}.entryReceiptHash`);
  if (input.lifecycleAction === 'ENTRY' && entryReceiptHash !== undefined) throw new MalformedInputError(`${context}.entryReceiptHash`, 'entry cannot bind a prior entry receipt');
  if (input.lifecycleAction !== 'ENTRY' && input.expectedStrategyStateHash === undefined) throw new MalformedInputError(`${context}.expectedStrategyStateHash`, 'a lifecycle action after entry binds the expected strategy state');
  return Object.freeze({
    version: STRATEGY_PACKAGE_ORDER_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    templateId: definition.templateId,
    templateVersion,
    packageTemplateManifestHash: manifestHash(input.packageTemplateManifestHash, `${context}.packageTemplateManifestHash`),
    graphHash: commitmentHash(input.graphHash, `${context}.graphHash`),
    seriesId: protocolId(input.seriesId, `${context}.seriesId`),
    seriesVersion: nonzeroU32(input.seriesVersion, `${context}.seriesVersion`),
    seriesManifestHash: manifestHash(input.seriesManifestHash, `${context}.seriesManifestHash`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    executionClassVersion: nonzeroU32(input.executionClassVersion, `${context}.executionClassVersion`),
    executionClassManifestHash: manifestHash(input.executionClassManifestHash, `${context}.executionClassManifestHash`),
    quoteConventionId,
    riskClassId,
    owner: protocolId(input.owner, `${context}.owner`),
    settlementAccount: protocolId(input.settlementAccount, `${context}.settlementAccount`),
    lifecycleAction: input.lifecycleAction,
    settlementClass: input.settlementClass,
    packageOrderType: input.packageOrderType,
    packageTimeInForce: input.packageTimeInForce,
    economicQuantity,
    quoteAsset,
    metricLimits: checkedMetricLimits(input.metricLimits, definition.metricIds, `${context}.metricLimits`),
    maximumServiceFeesByAsset: canonicalFeeCaps(input.maximumServiceFeesByAsset, `${context}.maximumServiceFeesByAsset`),
    maximumVenueFeesByAsset: canonicalFeeCaps(input.maximumVenueFeesByAsset, `${context}.maximumVenueFeesByAsset`),
    maximumNetworkFeesByAsset: canonicalFeeCaps(input.maximumNetworkFeesByAsset, `${context}.maximumNetworkFeesByAsset`),
    maximumRecoveryCostByAsset: canonicalFeeCaps(input.maximumRecoveryCostByAsset, `${context}.maximumRecoveryCostByAsset`),
    maximumMarginIncrease,
    maximumResidualValue,
    ...(input.activationConditionHash === undefined ? {} : { activationConditionHash: commitmentHash(input.activationConditionHash, `${context}.activationConditionHash`) }),
    ...(input.executionScheduleHash === undefined ? {} : { executionScheduleHash: commitmentHash(input.executionScheduleHash, `${context}.executionScheduleHash`) }),
    ...(input.expectedStrategyStateHash === undefined ? {} : { expectedStrategyStateHash: commitmentHash(input.expectedStrategyStateHash, `${context}.expectedStrategyStateHash`) }),
    ...(entryReceiptHash === undefined ? {} : { entryReceiptHash }),
    expiryUnit: input.expiryUnit,
    expiryValue,
    nonce,
  });
}

function encodeOptionalHash(writer: CanonicalWriter, value: CommitmentHash | undefined, context: string): void {
  writer.writeOptional(value, (element, hash) => encodeCommitmentHash(element, hash, context), context);
}

function encodeMetricLimit(writer: CanonicalWriter, value: StrategyMetricLimit): void {
  encodeProtocolId(writer, value.metricId, 'metricId');
  writer.writeEnum(COMPARATOR, value.comparator, 'comparator');
  writer.writeI128(value.value, 'value');
  writer.writeU8(value.scale, 'scale');
  encodeProtocolId(writer, value.unitId, 'unitId');
}

export function strategyPackageOrderBytes(input: StrategyPackageOrderInput): Uint8Array {
  const value = strategyPackageOrder(input);
  return canonicalBytes((writer) => {
    writer.writeU32(value.version, 'version');
    encodeProtocolId(writer, value.environment, 'environment');
    encodeProtocolId(writer, value.templateId, 'templateId');
    writer.writeU32(value.templateVersion, 'templateVersion');
    encodeManifestHash(writer, value.packageTemplateManifestHash, 'packageTemplateManifestHash');
    encodeCommitmentHash(writer, value.graphHash, 'graphHash');
    encodeProtocolId(writer, value.seriesId, 'seriesId');
    writer.writeU32(value.seriesVersion, 'seriesVersion');
    encodeManifestHash(writer, value.seriesManifestHash, 'seriesManifestHash');
    encodeProtocolId(writer, value.executionClassId, 'executionClassId');
    writer.writeU32(value.executionClassVersion, 'executionClassVersion');
    encodeManifestHash(writer, value.executionClassManifestHash, 'executionClassManifestHash');
    encodeProtocolId(writer, value.quoteConventionId, 'quoteConventionId');
    encodeProtocolId(writer, value.riskClassId, 'riskClassId');
    encodeProtocolId(writer, value.owner, 'owner');
    encodeProtocolId(writer, value.settlementAccount, 'settlementAccount');
    writer.writeEnum(GRAPH_LIFECYCLE_ACTION, value.lifecycleAction, 'lifecycleAction');
    writer.writeEnum(SETTLEMENT_CLASS, value.settlementClass, 'settlementClass');
    writer.writeEnum(PACKAGE_ORDER_TYPE, value.packageOrderType, 'packageOrderType');
    writer.writeEnum(PACKAGE_TIME_IN_FORCE, value.packageTimeInForce, 'packageTimeInForce');
    encodeAssetAmount(writer, value.economicQuantity);
    encodeAssetRef(writer, value.quoteAsset);
    writer.writeArray(value.metricLimits, encodeMetricLimit, 'metricLimits');
    writer.writeArray(value.maximumServiceFeesByAsset, encodeFeeCap, 'maximumServiceFeesByAsset');
    writer.writeArray(value.maximumVenueFeesByAsset, encodeFeeCap, 'maximumVenueFeesByAsset');
    writer.writeArray(value.maximumNetworkFeesByAsset, encodeFeeCap, 'maximumNetworkFeesByAsset');
    writer.writeArray(value.maximumRecoveryCostByAsset, encodeFeeCap, 'maximumRecoveryCostByAsset');
    encodeAssetAmount(writer, value.maximumMarginIncrease);
    encodeAssetAmount(writer, value.maximumResidualValue);
    encodeOptionalHash(writer, value.activationConditionHash, 'activationConditionHash');
    encodeOptionalHash(writer, value.executionScheduleHash, 'executionScheduleHash');
    encodeOptionalHash(writer, value.expectedStrategyStateHash, 'expectedStrategyStateHash');
    encodeOptionalHash(writer, value.entryReceiptHash, 'entryReceiptHash');
    writer.writeEnum(EXPIRY_UNIT, value.expiryUnit, 'expiryUnit');
    writer.writeU64(value.expiryValue, 'expiryValue');
    writer.writeU256(value.nonce, 'nonce');
  });
}

export function strategyPackageOrderHash(input: StrategyPackageOrderInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.STRATEGY_ORDER, strategyPackageOrderBytes(input)), 'strategyPackageOrderHash');
}
