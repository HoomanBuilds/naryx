import { absBigInt, checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes, toHex } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import {
  EXPIRY_UNIT,
  TRADE_SIDE,
  enumDiscriminant,
  type ExpiryUnit,
  type TradeSide,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  NETTING_EXTERNAL_EXECUTION_OUTCOME,
  nettingExternalExecutionIntentHash,
  type NettingExternalExecutionIntent,
  type NettingExternalExecutionOutcome,
} from './netting-execution.js';
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
  encodeProtocolId,
  encodeVersionedManifestRef,
  protocolId,
  versionedManifestRef,
  type AssetRef,
  type DomainRef,
  type ProtocolId,
  type VersionedManifestRef,
} from './primitives.js';

export const CROSS_BATCH_CLEARING_POLICY_VERSION = 1;
export const CROSS_BATCH_CLEARING_PLAN_VERSION = 1;
export const CROSS_BATCH_EXECUTION_INTENT_VERSION = 1;
export const CROSS_BATCH_EXECUTION_EVIDENCE_VERSION = 1;
export const CROSS_BATCH_CLEARING_RECEIPT_VERSION = 1;
export const CROSS_BATCH_MAX_SOURCE_INTENTS = 64;
export const CROSS_BATCH_MAX_SOURCE_BATCHES = 32;

const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const U256_BITS = 256;
const I128_BITS = 128;
const I256_BITS = 256;

export interface CrossBatchClearingPolicyInput {
  readonly version: number;
  readonly policyId: string;
  readonly domain: DomainRef;
  readonly adapter: AdapterRefInput | AdapterRef;
  readonly expiryUnit: ExpiryUnit;
  readonly maximumSourceIntents: number;
  readonly maximumSourceBatches: number;
  readonly maximumExpirySpread: bigint;
}

export interface CrossBatchClearingPolicy {
  readonly version: 1;
  readonly policyId: ProtocolId;
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly expiryUnit: ExpiryUnit;
  readonly maximumSourceIntents: number;
  readonly maximumSourceBatches: number;
  readonly maximumExpirySpread: bigint;
  readonly policyHash: CommitmentHash;
}

export interface CrossBatchSourceAllocation {
  readonly sourceIntentHash: CommitmentHash;
  readonly nettingProofHash: CommitmentHash;
  readonly side: TradeSide;
  readonly quantityAtoms: bigint;
  readonly internalQuantityAtoms: bigint;
  readonly externalQuantityAtoms: bigint;
  readonly internalQuoteDeltaAtoms: bigint;
  readonly maximumFeeQuoteAtoms: bigint;
}

export interface CrossBatchClearingPlan {
  readonly version: 1;
  readonly policyHash: CommitmentHash;
  readonly instrumentId: ProtocolId;
  readonly instrumentHash: CommitmentHash;
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly quantityAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly quantityIncrementAtoms: bigint;
  readonly priceTickQuoteAtoms: bigint;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly internalMatchedQuantityAtoms: bigint;
  readonly internalClearingPriceTicks: bigint;
  readonly externalSide?: TradeSide;
  readonly externalQuantityAtoms: bigint;
  readonly externalLimitPriceTicks?: bigint;
  readonly maximumExternalFeeQuoteAtoms: bigint;
  readonly sources: readonly CrossBatchSourceAllocation[];
  readonly planHash: CommitmentHash;
}

export interface CrossBatchExternalExecutionIntent {
  readonly version: 1;
  readonly intentHash: CommitmentHash;
  readonly clearingPlanHash: CommitmentHash;
  readonly instrumentId: ProtocolId;
  readonly instrumentHash: CommitmentHash;
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly quantityAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly side: TradeSide;
  readonly quantityAtoms: bigint;
  readonly limitPriceTicks: bigint;
  readonly quantityIncrementAtoms: bigint;
  readonly priceTickQuoteAtoms: bigint;
  readonly maximumFeeQuoteAtoms: bigint;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly sourceIntentFeeCaps: readonly {
    readonly sourceIntentHash: CommitmentHash;
    readonly maximumFeeQuoteAtoms: bigint;
  }[];
}

export interface CrossBatchExternalExecutionEvidenceInput {
  readonly version: number;
  readonly intentHash: Uint8Array | string;
  readonly outcome: NettingExternalExecutionOutcome;
  readonly filledSignedQuantityAtoms: bigint;
  readonly grossQuoteAtoms: bigint;
  readonly feeQuoteAtoms: bigint;
  readonly submittedAtUnit: ExpiryUnit;
  readonly submittedAtValue: bigint;
  readonly observedAtUnit: ExpiryUnit;
  readonly observedAtValue: bigint;
  readonly executionReferenceHash: Uint8Array | string;
  readonly authoritativeEvidenceHash: Uint8Array | string;
}

export interface CrossBatchExternalExecutionEvidence extends Omit<
  CrossBatchExternalExecutionEvidenceInput,
  'version' | 'intentHash' | 'executionReferenceHash' | 'authoritativeEvidenceHash'
> {
  readonly version: 1;
  readonly evidenceHash: CommitmentHash;
  readonly intentHash: CommitmentHash;
  readonly executionReferenceHash: CommitmentHash;
  readonly authoritativeEvidenceHash: CommitmentHash;
}

export interface CrossBatchSourceReceipt {
  readonly sourceIntentHash: CommitmentHash;
  readonly nettingProofHash: CommitmentHash;
  readonly side: TradeSide;
  readonly quantityAtoms: bigint;
  readonly internalQuantityAtoms: bigint;
  readonly internalQuoteDeltaAtoms: bigint;
  readonly externalQuantityAtoms: bigint;
  readonly externalGrossQuoteDeltaAtoms: bigint;
  readonly externalFeeQuoteAtoms: bigint;
  readonly totalQuoteDeltaAtoms: bigint;
}

export interface CrossBatchClearingReceipt {
  readonly version: 1;
  readonly receiptHash: CommitmentHash;
  readonly clearingPlanHash: CommitmentHash;
  readonly executionEvidenceHash?: CommitmentHash;
  readonly sources: readonly CrossBatchSourceReceipt[];
}

type PolicyPayload = Omit<CrossBatchClearingPolicy, 'policyHash'>;
type PlanPayload = Omit<CrossBatchClearingPlan, 'planHash'>;
type IntentPayload = Omit<CrossBatchExternalExecutionIntent, 'intentHash'>;
type EvidencePayload = Omit<CrossBatchExternalExecutionEvidence, 'evidenceHash'>;
type ReceiptPayload = Omit<CrossBatchClearingReceipt, 'receiptHash'>;

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function positive(value: bigint, bits: number, context: string): bigint {
  const result = unsigned(value, bits, context);
  if (result === 0n) throw new MalformedInputError(context, 'value is zero');
  return result;
}

function boundedNumber(value: number, maximum: number, context: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new MalformedInputError(context, `expected an integer from 1 to ${maximum}`);
  }
  return value;
}

function version(value: number, expected: number, context: string): 1 {
  if (value !== expected) throw new MalformedInputError(context, `version must equal ${expected}`);
  return 1;
}

function canonicalAsset(value: AssetRef, context: string): AssetRef {
  object(value, context);
  return assetRef(value.assetId, value.assetManifestHash, value.decimals, context);
}

function policyPayload(input: CrossBatchClearingPolicyInput | CrossBatchClearingPolicy): PolicyPayload {
  object(input, 'crossBatchClearingPolicy');
  enumDiscriminant(EXPIRY_UNIT, input.expiryUnit, 'crossBatchClearingPolicy.expiryUnit');
  return Object.freeze({
    version: version(input.version, CROSS_BATCH_CLEARING_POLICY_VERSION, 'crossBatchClearingPolicy.version'),
    policyId: protocolId(input.policyId, 'crossBatchClearingPolicy.policyId'),
    domain: domainRef(
      input.domain.domainId,
      input.domain.domainManifestVersion,
      input.domain.domainManifestHash,
      'crossBatchClearingPolicy.domain',
    ),
    adapter: adapterRef(input.adapter, 'crossBatchClearingPolicy.adapter'),
    expiryUnit: input.expiryUnit,
    maximumSourceIntents: boundedNumber(
      input.maximumSourceIntents,
      CROSS_BATCH_MAX_SOURCE_INTENTS,
      'crossBatchClearingPolicy.maximumSourceIntents',
    ),
    maximumSourceBatches: boundedNumber(
      input.maximumSourceBatches,
      CROSS_BATCH_MAX_SOURCE_BATCHES,
      'crossBatchClearingPolicy.maximumSourceBatches',
    ),
    maximumExpirySpread: unsigned(input.maximumExpirySpread, U64_BITS, 'crossBatchClearingPolicy.maximumExpirySpread'),
  });
}

function policyBytes(input: PolicyPayload): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeProtocolId(writer, input.policyId, 'policyId');
    encodeDomainRef(writer, input.domain);
    encodeAdapterRef(writer, input.adapter);
    writer.writeEnum(EXPIRY_UNIT, input.expiryUnit, 'expiryUnit');
    writer.writeU32(input.maximumSourceIntents, 'maximumSourceIntents');
    writer.writeU32(input.maximumSourceBatches, 'maximumSourceBatches');
    writer.writeU64(input.maximumExpirySpread, 'maximumExpirySpread');
  });
}

export function crossBatchClearingPolicy(
  input: CrossBatchClearingPolicyInput | CrossBatchClearingPolicy,
): CrossBatchClearingPolicy {
  const payload = policyPayload(input);
  const policyHash = commitmentHash(
    domainHash(HASH_DOMAIN.CROSS_BATCH_CLEARING_POLICY, policyBytes(payload)),
    'crossBatchClearingPolicy.policyHash',
  );
  if ('policyHash' in input && compareBytes(commitmentHash(input.policyHash), policyHash) !== 0) {
    throw new MalformedInputError('crossBatchClearingPolicy.policyHash', 'hash does not match policy contents');
  }
  return Object.freeze({ ...payload, policyHash });
}

function routeBytes(intent: NettingExternalExecutionIntent): Uint8Array {
  return canonicalBytes((writer) => {
    encodeProtocolId(writer, intent.instrumentId, 'instrumentId');
    encodeCommitmentHash(writer, intent.instrumentHash, 'instrumentHash');
    encodeDomainRef(writer, intent.domain);
    encodeAdapterRef(writer, intent.adapter);
    encodeVersionedManifestRef(writer, intent.venue);
    encodeVersionedManifestRef(writer, intent.market);
    encodeAssetRef(writer, intent.quantityAsset);
    encodeAssetRef(writer, intent.quoteAsset);
    writer.writeU128(intent.quantityIncrementAtoms, 'quantityIncrementAtoms');
    writer.writeU128(intent.priceTickQuoteAtoms, 'priceTickQuoteAtoms');
  });
}

function sourceIntent(input: NettingExternalExecutionIntent, context: string): NettingExternalExecutionIntent {
  object(input, context);
  const expected = nettingExternalExecutionIntentHash(input);
  if (compareBytes(expected, commitmentHash(input.intentHash, `${context}.intentHash`)) !== 0) {
    throw new MalformedInputError(`${context}.intentHash`, 'hash does not match intent contents');
  }
  return input;
}

function allocateProRata(
  sources: readonly NettingExternalExecutionIntent[],
  matched: bigint,
  increment: bigint,
): Map<string, bigint> {
  const totalUnits = sources.reduce((sum, source) => sum + source.quantityAtoms / increment, 0n);
  const matchedUnits = matched / increment;
  const allocations = new Map<string, bigint>();
  let assignedUnits = 0n;
  for (const source of sources) {
    const sourceUnits = source.quantityAtoms / increment;
    const units = totalUnits === 0n ? 0n : sourceUnits * matchedUnits / totalUnits;
    allocations.set(toHex(source.intentHash), units * increment);
    assignedUnits += units;
  }
  let remainder = matchedUnits - assignedUnits;
  for (const source of [...sources].sort((left, right) => compareBytes(left.intentHash, right.intentHash))) {
    if (remainder === 0n) break;
    const key = toHex(source.intentHash);
    const current = allocations.get(key) as bigint;
    if (current < source.quantityAtoms) {
      allocations.set(key, current + increment);
      remainder -= 1n;
    }
  }
  if (remainder !== 0n) throw new MalformedInputError('crossBatchClearingPlan.sources', 'matched quantity cannot be allocated');
  return allocations;
}

function quoteMagnitude(quantity: bigint, increment: bigint, price: bigint, tick: bigint, context: string): bigint {
  if (quantity % increment !== 0n) throw new MalformedInputError(context, 'quantity is off the increment lattice');
  return checkedUnsigned((quantity / increment) * price * tick, U256_BITS, context);
}

function minimum(values: readonly bigint[], context: string): bigint {
  if (values.length === 0) throw new MalformedInputError(context, 'expected a nonempty value set');
  return values.reduce((result, value) => value < result ? value : result);
}

function maximum(values: readonly bigint[], context: string): bigint {
  if (values.length === 0) throw new MalformedInputError(context, 'expected a nonempty value set');
  return values.reduce((result, value) => value > result ? value : result);
}

function encodeSourceAllocation(writer: Parameters<Parameters<typeof canonicalBytes>[0]>[0], source: CrossBatchSourceAllocation): void {
  encodeCommitmentHash(writer, source.sourceIntentHash, 'sourceIntentHash');
  encodeCommitmentHash(writer, source.nettingProofHash, 'nettingProofHash');
  writer.writeEnum(TRADE_SIDE, source.side, 'side');
  writer.writeU128(source.quantityAtoms, 'quantityAtoms');
  writer.writeU128(source.internalQuantityAtoms, 'internalQuantityAtoms');
  writer.writeU128(source.externalQuantityAtoms, 'externalQuantityAtoms');
  writer.writeI256(source.internalQuoteDeltaAtoms, 'internalQuoteDeltaAtoms');
  writer.writeU256(source.maximumFeeQuoteAtoms, 'maximumFeeQuoteAtoms');
}

function planBytes(input: PlanPayload): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeCommitmentHash(writer, input.policyHash, 'policyHash');
    encodeProtocolId(writer, input.instrumentId, 'instrumentId');
    encodeCommitmentHash(writer, input.instrumentHash, 'instrumentHash');
    encodeDomainRef(writer, input.domain);
    encodeAdapterRef(writer, input.adapter);
    encodeVersionedManifestRef(writer, input.venue);
    encodeVersionedManifestRef(writer, input.market);
    encodeAssetRef(writer, input.quantityAsset);
    encodeAssetRef(writer, input.quoteAsset);
    writer.writeU128(input.quantityIncrementAtoms, 'quantityIncrementAtoms');
    writer.writeU128(input.priceTickQuoteAtoms, 'priceTickQuoteAtoms');
    writer.writeEnum(EXPIRY_UNIT, input.validUntilUnit, 'validUntilUnit');
    writer.writeU64(input.validUntilValue, 'validUntilValue');
    writer.writeU128(input.internalMatchedQuantityAtoms, 'internalMatchedQuantityAtoms');
    writer.writeU128(input.internalClearingPriceTicks, 'internalClearingPriceTicks');
    writer.writeOptional(input.externalSide, (element, value) => element.writeEnum(TRADE_SIDE, value, 'externalSide'), 'externalSide');
    writer.writeU128(input.externalQuantityAtoms, 'externalQuantityAtoms');
    writer.writeOptional(input.externalLimitPriceTicks, (element, value) => element.writeU128(value, 'externalLimitPriceTicks'), 'externalLimitPriceTicks');
    writer.writeU256(input.maximumExternalFeeQuoteAtoms, 'maximumExternalFeeQuoteAtoms');
    writer.writeArray(input.sources, encodeSourceAllocation, 'sources');
  });
}

export function crossBatchClearingPlan(
  sourceInputs: readonly NettingExternalExecutionIntent[],
  policyInput: CrossBatchClearingPolicyInput | CrossBatchClearingPolicy,
): CrossBatchClearingPlan {
  if (!Array.isArray(sourceInputs) || sourceInputs.length < 2) {
    throw new MalformedInputError('crossBatchClearingPlan.sources', 'expected at least two source intents');
  }
  const policy = crossBatchClearingPolicy(policyInput);
  if (sourceInputs.length > policy.maximumSourceIntents) {
    throw new MalformedInputError('crossBatchClearingPlan.sources', 'source count exceeds policy');
  }
  const sources = sourceInputs.map((source, index) => sourceIntent(source, `crossBatchClearingPlan.sources[${index}]`));
  if (new Set(sources.map((source) => toHex(source.intentHash))).size !== sources.length) {
    throw new DuplicateElementError('crossBatchClearingPlan.sources', 'intent hashes repeat');
  }
  const proofCount = new Set(sources.map((source) => toHex(source.nettingProofHash))).size;
  if (proofCount < 2) throw new MalformedInputError('crossBatchClearingPlan.sources', 'sources must span multiple batches');
  if (proofCount > policy.maximumSourceBatches) {
    throw new MalformedInputError('crossBatchClearingPlan.sources', 'batch count exceeds policy');
  }
  const first = sources[0]!;
  const route = toHex(routeBytes(first));
  if (sources.some((source) => toHex(routeBytes(source)) !== route)) {
    throw new MalformedInputError('crossBatchClearingPlan.sources', 'source routes are incompatible');
  }
  const policyRoute = canonicalBytes((writer) => {
    encodeDomainRef(writer, policy.domain);
    encodeAdapterRef(writer, policy.adapter);
  });
  const sourcePolicyRoute = canonicalBytes((writer) => {
    encodeDomainRef(writer, first.domain);
    encodeAdapterRef(writer, first.adapter);
  });
  if (compareBytes(policyRoute, sourcePolicyRoute) !== 0) {
    throw new MalformedInputError('crossBatchClearingPlan.sources', 'source route is not allowed by policy');
  }
  if (sources.some((source) => source.validUntilUnit !== policy.expiryUnit)) {
    throw new MalformedInputError('crossBatchClearingPlan.sources', 'source expiry unit differs from policy');
  }
  const earliestExpiry = minimum(sources.map((source) => source.validUntilValue), 'crossBatchClearingPlan.expiry');
  const latestExpiry = maximum(sources.map((source) => source.validUntilValue), 'crossBatchClearingPlan.expiry');
  if (latestExpiry - earliestExpiry > policy.maximumExpirySpread) {
    throw new MalformedInputError('crossBatchClearingPlan.sources', 'source expiry spread exceeds policy');
  }
  const buys = sources.filter((source) => source.side === 'BUY');
  const sells = sources.filter((source) => source.side === 'SELL');
  if (buys.length === 0 || sells.length === 0) {
    throw new MalformedInputError('crossBatchClearingPlan.sources', 'both trade sides are required');
  }
  const maximumSell = maximum(sells.map((source) => source.limitPriceTicks), 'crossBatchClearingPlan.sellLimits');
  const minimumBuy = minimum(buys.map((source) => source.limitPriceTicks), 'crossBatchClearingPlan.buyLimits');
  if (maximumSell > minimumBuy) {
    throw new MalformedInputError('crossBatchClearingPlan.sources', 'buy and sell limits do not overlap');
  }
  const totalBuy = buys.reduce((sum, source) => sum + source.quantityAtoms, 0n);
  const totalSell = sells.reduce((sum, source) => sum + source.quantityAtoms, 0n);
  const matched = totalBuy < totalSell ? totalBuy : totalSell;
  const clearingPrice = (maximumSell + minimumBuy) / 2n;
  const buyInternal = allocateProRata(buys, matched, first.quantityIncrementAtoms);
  const sellInternal = allocateProRata(sells, matched, first.quantityIncrementAtoms);
  const allocations = sources.map((source): CrossBatchSourceAllocation => {
    const internal = (source.side === 'BUY' ? buyInternal : sellInternal).get(toHex(source.intentHash)) ?? 0n;
    const quote = quoteMagnitude(
      internal,
      first.quantityIncrementAtoms,
      clearingPrice,
      first.priceTickQuoteAtoms,
      'crossBatchClearingPlan.internalQuoteDeltaAtoms',
    );
    return Object.freeze({
      sourceIntentHash: commitmentHash(source.intentHash),
      nettingProofHash: commitmentHash(source.nettingProofHash),
      side: source.side,
      quantityAtoms: source.quantityAtoms,
      internalQuantityAtoms: internal,
      externalQuantityAtoms: source.quantityAtoms - internal,
      internalQuoteDeltaAtoms: source.side === 'BUY' ? -quote : quote,
      maximumFeeQuoteAtoms: source.maximumFeeQuoteAtoms,
    });
  }).sort((left, right) => compareBytes(left.sourceIntentHash, right.sourceIntentHash));
  const externalSources = allocations.filter((source) => source.externalQuantityAtoms > 0n);
  const externalQuantityAtoms = absBigInt(totalBuy - totalSell);
  if (externalSources.some((source) => source.side !== externalSources[0]!.side)) {
    throw new MalformedInputError('crossBatchClearingPlan.sources', 'opposing external residuals remain');
  }
  const externalSide = externalQuantityAtoms === 0n ? undefined : externalSources[0]!.side;
  const sourceByHash = new Map(sources.map((source) => [toHex(source.intentHash), source]));
  const externalLimitPriceTicks = externalSide === undefined
    ? undefined
    : externalSide === 'BUY'
      ? minimum(externalSources.map((source) => sourceByHash.get(toHex(source.sourceIntentHash))!.limitPriceTicks), 'crossBatchClearingPlan.externalBuyLimits')
      : maximum(externalSources.map((source) => sourceByHash.get(toHex(source.sourceIntentHash))!.limitPriceTicks), 'crossBatchClearingPlan.externalSellLimits');
  const maximumExternalFeeQuoteAtoms = checkedUnsigned(
    externalSources.reduce((sum, source) => sum + source.maximumFeeQuoteAtoms, 0n),
    U256_BITS,
    'crossBatchClearingPlan.maximumExternalFeeQuoteAtoms',
  );
  const payload: PlanPayload = Object.freeze({
    version: CROSS_BATCH_CLEARING_PLAN_VERSION,
    policyHash: policy.policyHash,
    instrumentId: protocolId(first.instrumentId),
    instrumentHash: commitmentHash(first.instrumentHash),
    domain: domainRef(first.domain.domainId, first.domain.domainManifestVersion, first.domain.domainManifestHash),
    adapter: adapterRef(first.adapter),
    venue: versionedManifestRef(first.venue.subjectId, first.venue.manifestVersion, first.venue.manifestHash),
    market: versionedManifestRef(first.market.subjectId, first.market.manifestVersion, first.market.manifestHash),
    quantityAsset: canonicalAsset(first.quantityAsset, 'crossBatchClearingPlan.quantityAsset'),
    quoteAsset: canonicalAsset(first.quoteAsset, 'crossBatchClearingPlan.quoteAsset'),
    quantityIncrementAtoms: positive(first.quantityIncrementAtoms, U128_BITS, 'crossBatchClearingPlan.quantityIncrementAtoms'),
    priceTickQuoteAtoms: positive(first.priceTickQuoteAtoms, U128_BITS, 'crossBatchClearingPlan.priceTickQuoteAtoms'),
    validUntilUnit: policy.expiryUnit,
    validUntilValue: earliestExpiry,
    internalMatchedQuantityAtoms: matched,
    internalClearingPriceTicks: clearingPrice,
    ...(externalSide === undefined ? {} : { externalSide }),
    externalQuantityAtoms,
    ...(externalLimitPriceTicks === undefined ? {} : { externalLimitPriceTicks }),
    maximumExternalFeeQuoteAtoms,
    sources: Object.freeze(allocations),
  });
  const planHash = commitmentHash(
    domainHash(HASH_DOMAIN.CROSS_BATCH_CLEARING_PLAN, planBytes(payload)),
    'crossBatchClearingPlan.planHash',
  );
  return Object.freeze({ ...payload, planHash });
}

export function verifyCrossBatchClearingPlan(
  plan: CrossBatchClearingPlan,
  sources: readonly NettingExternalExecutionIntent[],
  policy: CrossBatchClearingPolicyInput | CrossBatchClearingPolicy,
): void {
  const expected = crossBatchClearingPlan(sources, policy);
  if (compareBytes(expected.planHash, commitmentHash(plan.planHash)) !== 0
    || compareBytes(expected.planHash, commitmentHash(domainHash(HASH_DOMAIN.CROSS_BATCH_CLEARING_PLAN, planBytes(plan)))) !== 0) {
    throw new MalformedInputError('crossBatchClearingPlan', 'plan does not follow its sources and policy');
  }
}

function intentBytes(input: IntentPayload): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeCommitmentHash(writer, input.clearingPlanHash, 'clearingPlanHash');
    encodeProtocolId(writer, input.instrumentId, 'instrumentId');
    encodeCommitmentHash(writer, input.instrumentHash, 'instrumentHash');
    encodeDomainRef(writer, input.domain);
    encodeAdapterRef(writer, input.adapter);
    encodeVersionedManifestRef(writer, input.venue);
    encodeVersionedManifestRef(writer, input.market);
    encodeAssetRef(writer, input.quantityAsset);
    encodeAssetRef(writer, input.quoteAsset);
    writer.writeEnum(TRADE_SIDE, input.side, 'side');
    writer.writeU128(input.quantityAtoms, 'quantityAtoms');
    writer.writeU128(input.limitPriceTicks, 'limitPriceTicks');
    writer.writeU128(input.quantityIncrementAtoms, 'quantityIncrementAtoms');
    writer.writeU128(input.priceTickQuoteAtoms, 'priceTickQuoteAtoms');
    writer.writeU256(input.maximumFeeQuoteAtoms, 'maximumFeeQuoteAtoms');
    writer.writeEnum(EXPIRY_UNIT, input.validUntilUnit, 'validUntilUnit');
    writer.writeU64(input.validUntilValue, 'validUntilValue');
    writer.writeArray(input.sourceIntentFeeCaps, (element, cap) => {
      encodeCommitmentHash(element, cap.sourceIntentHash, 'sourceIntentHash');
      element.writeU256(cap.maximumFeeQuoteAtoms, 'maximumFeeQuoteAtoms');
    }, 'sourceIntentFeeCaps');
  });
}

export function crossBatchExternalExecutionIntent(plan: CrossBatchClearingPlan): CrossBatchExternalExecutionIntent {
  if (plan.externalSide === undefined || plan.externalLimitPriceTicks === undefined || plan.externalQuantityAtoms === 0n) {
    throw new MalformedInputError('crossBatchExternalExecutionIntent.plan', 'plan has no external residual');
  }
  const sourceIntentFeeCaps = Object.freeze(plan.sources
    .filter((source) => source.externalQuantityAtoms > 0n)
    .map((source) => Object.freeze({
      sourceIntentHash: source.sourceIntentHash,
      maximumFeeQuoteAtoms: source.maximumFeeQuoteAtoms,
    }))
    .sort((left, right) => compareBytes(left.sourceIntentHash, right.sourceIntentHash)));
  const payload: IntentPayload = Object.freeze({
    version: CROSS_BATCH_EXECUTION_INTENT_VERSION,
    clearingPlanHash: commitmentHash(plan.planHash),
    instrumentId: plan.instrumentId,
    instrumentHash: plan.instrumentHash,
    domain: plan.domain,
    adapter: plan.adapter,
    venue: plan.venue,
    market: plan.market,
    quantityAsset: plan.quantityAsset,
    quoteAsset: plan.quoteAsset,
    side: plan.externalSide,
    quantityAtoms: plan.externalQuantityAtoms,
    limitPriceTicks: plan.externalLimitPriceTicks,
    quantityIncrementAtoms: plan.quantityIncrementAtoms,
    priceTickQuoteAtoms: plan.priceTickQuoteAtoms,
    maximumFeeQuoteAtoms: plan.maximumExternalFeeQuoteAtoms,
    validUntilUnit: plan.validUntilUnit,
    validUntilValue: plan.validUntilValue,
    sourceIntentFeeCaps,
  });
  const intentHash = commitmentHash(
    domainHash(HASH_DOMAIN.CROSS_BATCH_EXECUTION_INTENT, intentBytes(payload)),
    'crossBatchExternalExecutionIntent.intentHash',
  );
  return Object.freeze({ ...payload, intentHash });
}

export function verifyCrossBatchExternalExecutionIntent(
  intent: CrossBatchExternalExecutionIntent,
  plan: CrossBatchClearingPlan,
): void {
  const expected = crossBatchExternalExecutionIntent(plan);
  if (compareBytes(expected.intentHash, commitmentHash(intent.intentHash)) !== 0
    || compareBytes(expected.intentHash, commitmentHash(domainHash(HASH_DOMAIN.CROSS_BATCH_EXECUTION_INTENT, intentBytes(intent)))) !== 0) {
    throw new MalformedInputError('crossBatchExternalExecutionIntent', 'intent does not follow clearing plan');
  }
}

function evidencePayload(
  input: CrossBatchExternalExecutionEvidenceInput | CrossBatchExternalExecutionEvidence,
  intent: CrossBatchExternalExecutionIntent,
): EvidencePayload {
  object(input, 'crossBatchExternalExecutionEvidence');
  enumDiscriminant(NETTING_EXTERNAL_EXECUTION_OUTCOME, input.outcome, 'crossBatchExternalExecutionEvidence.outcome');
  enumDiscriminant(EXPIRY_UNIT, input.submittedAtUnit, 'crossBatchExternalExecutionEvidence.submittedAtUnit');
  enumDiscriminant(EXPIRY_UNIT, input.observedAtUnit, 'crossBatchExternalExecutionEvidence.observedAtUnit');
  if (compareBytes(commitmentHash(input.intentHash), intent.intentHash) !== 0) {
    throw new MalformedInputError('crossBatchExternalExecutionEvidence.intentHash', 'evidence cites another intent');
  }
  const filled = checkedSigned(input.filledSignedQuantityAtoms, I128_BITS, 'crossBatchExternalExecutionEvidence.filledSignedQuantityAtoms');
  const requested = intent.side === 'BUY' ? intent.quantityAtoms : -intent.quantityAtoms;
  if (input.outcome === 'EXACT_FILLED' && filled !== requested) {
    throw new MalformedInputError('crossBatchExternalExecutionEvidence.filledSignedQuantityAtoms', 'exact fill differs from intent');
  }
  if (input.outcome === 'PARTIAL_FILL' && (filled === 0n || (filled > 0n) !== (requested > 0n) || absBigInt(filled) >= intent.quantityAtoms)) {
    throw new MalformedInputError('crossBatchExternalExecutionEvidence.filledSignedQuantityAtoms', 'partial fill is not a strict same-side subset');
  }
  if ((input.outcome === 'NO_FILL' || input.outcome === 'REJECTED') && filled !== 0n) {
    throw new MalformedInputError('crossBatchExternalExecutionEvidence.filledSignedQuantityAtoms', 'unfilled outcome carries quantity');
  }
  const grossQuoteAtoms = unsigned(input.grossQuoteAtoms, U256_BITS, 'crossBatchExternalExecutionEvidence.grossQuoteAtoms');
  if ((filled === 0n) !== (grossQuoteAtoms === 0n)) {
    throw new MalformedInputError('crossBatchExternalExecutionEvidence.grossQuoteAtoms', 'gross quote disagrees with fill quantity');
  }
  const feeQuoteAtoms = unsigned(input.feeQuoteAtoms, U256_BITS, 'crossBatchExternalExecutionEvidence.feeQuoteAtoms');
  if (feeQuoteAtoms > intent.maximumFeeQuoteAtoms) {
    throw new MalformedInputError('crossBatchExternalExecutionEvidence.feeQuoteAtoms', 'fee exceeds intent cap');
  }
  if (filled !== 0n) {
    const limit = quoteMagnitude(absBigInt(filled), intent.quantityIncrementAtoms, intent.limitPriceTicks, intent.priceTickQuoteAtoms, 'crossBatchExternalExecutionEvidence.limitQuoteAtoms');
    if (intent.side === 'BUY' ? grossQuoteAtoms > limit : grossQuoteAtoms < limit) {
      throw new MalformedInputError('crossBatchExternalExecutionEvidence.grossQuoteAtoms', 'fill violates execution limit');
    }
  }
  const submittedAtValue = unsigned(input.submittedAtValue, U64_BITS, 'crossBatchExternalExecutionEvidence.submittedAtValue');
  const observedAtValue = unsigned(input.observedAtValue, U64_BITS, 'crossBatchExternalExecutionEvidence.observedAtValue');
  if (input.submittedAtUnit !== intent.validUntilUnit || input.observedAtUnit !== intent.validUntilUnit) {
    throw new MalformedInputError('crossBatchExternalExecutionEvidence', 'timestamps use another clock');
  }
  if (submittedAtValue >= intent.validUntilValue || observedAtValue < submittedAtValue) {
    throw new MalformedInputError('crossBatchExternalExecutionEvidence', 'timestamps are invalid');
  }
  return Object.freeze({
    version: version(input.version, CROSS_BATCH_EXECUTION_EVIDENCE_VERSION, 'crossBatchExternalExecutionEvidence.version'),
    intentHash: intent.intentHash,
    outcome: input.outcome,
    filledSignedQuantityAtoms: filled,
    grossQuoteAtoms,
    feeQuoteAtoms,
    submittedAtUnit: input.submittedAtUnit,
    submittedAtValue,
    observedAtUnit: input.observedAtUnit,
    observedAtValue,
    executionReferenceHash: commitmentHash(input.executionReferenceHash),
    authoritativeEvidenceHash: commitmentHash(input.authoritativeEvidenceHash),
  });
}

function evidenceBytes(input: EvidencePayload): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeCommitmentHash(writer, input.intentHash, 'intentHash');
    writer.writeEnum(NETTING_EXTERNAL_EXECUTION_OUTCOME, input.outcome, 'outcome');
    writer.writeI128(input.filledSignedQuantityAtoms, 'filledSignedQuantityAtoms');
    writer.writeU256(input.grossQuoteAtoms, 'grossQuoteAtoms');
    writer.writeU256(input.feeQuoteAtoms, 'feeQuoteAtoms');
    writer.writeEnum(EXPIRY_UNIT, input.submittedAtUnit, 'submittedAtUnit');
    writer.writeU64(input.submittedAtValue, 'submittedAtValue');
    writer.writeEnum(EXPIRY_UNIT, input.observedAtUnit, 'observedAtUnit');
    writer.writeU64(input.observedAtValue, 'observedAtValue');
    encodeCommitmentHash(writer, input.executionReferenceHash, 'executionReferenceHash');
    encodeCommitmentHash(writer, input.authoritativeEvidenceHash, 'authoritativeEvidenceHash');
  });
}

export function crossBatchExternalExecutionEvidence(
  input: CrossBatchExternalExecutionEvidenceInput,
  intent: CrossBatchExternalExecutionIntent,
): CrossBatchExternalExecutionEvidence {
  const payload = evidencePayload(input, intent);
  const evidenceHash = commitmentHash(
    domainHash(HASH_DOMAIN.CROSS_BATCH_EXECUTION_EVIDENCE, evidenceBytes(payload)),
    'crossBatchExternalExecutionEvidence.evidenceHash',
  );
  return Object.freeze({ ...payload, evidenceHash });
}

export function verifyCrossBatchExternalExecutionEvidence(
  evidence: CrossBatchExternalExecutionEvidence,
  intent: CrossBatchExternalExecutionIntent,
): void {
  const payload = evidencePayload(evidence, intent);
  const expected = commitmentHash(domainHash(HASH_DOMAIN.CROSS_BATCH_EXECUTION_EVIDENCE, evidenceBytes(payload)));
  if (compareBytes(expected, commitmentHash(evidence.evidenceHash)) !== 0) {
    throw new MalformedInputError('crossBatchExternalExecutionEvidence.evidenceHash', 'hash does not match evidence');
  }
}

function distribute(total: bigint, weights: readonly bigint[]): bigint[] {
  const weightTotal = weights.reduce((sum, value) => sum + value, 0n);
  if (weights.length === 0 || weightTotal === 0n) {
    throw new MalformedInputError('crossBatchClearingReceipt.weights', 'weight total is zero');
  }
  const result = weights.map((weight) => weightTotal === 0n ? 0n : total * weight / weightTotal);
  let assigned = result.reduce((sum, value) => sum + value, 0n);
  for (let index = 0; assigned < total; index = (index + 1) % result.length) {
    result[index] = result[index]! + 1n;
    assigned += 1n;
  }
  return result;
}

function distributeBounded(total: bigint, weights: readonly bigint[], caps: readonly bigint[]): bigint[] {
  if (weights.length === 0 || weights.length !== caps.length) {
    throw new MalformedInputError('crossBatchClearingReceipt.boundedAllocation', 'weights and caps differ');
  }
  if (caps.reduce((sum, value) => sum + value, 0n) < total) {
    throw new MalformedInputError('crossBatchClearingReceipt.boundedAllocation', 'allocation caps are insufficient');
  }
  const result = weights.map(() => 0n);
  let remaining = total;
  let active = weights.map((_, index) => index);
  while (remaining > 0n) {
    const activeWeight = active.reduce((sum, index) => sum + weights[index]!, 0n);
    let assigned = 0n;
    for (const index of active) {
      const room = caps[index]! - result[index]!;
      const proportional = activeWeight === 0n ? 0n : remaining * weights[index]! / activeWeight;
      const share = proportional < room ? proportional : room;
      result[index] = result[index]! + share;
      assigned += share;
    }
    remaining -= assigned;
    active = active.filter((index) => result[index]! < caps[index]!);
    if (remaining === 0n) break;
    if (active.length === 0) {
      throw new MalformedInputError('crossBatchClearingReceipt.boundedAllocation', 'allocation caps are insufficient');
    }
    if (assigned === 0n) {
      const index = active[0]!;
      const room = caps[index]! - result[index]!;
      const share = remaining < room ? remaining : room;
      result[index] = result[index]! + share;
      remaining -= share;
      active = active.filter((candidate) => result[candidate]! < caps[candidate]!);
    }
  }
  return result;
}

function receiptBytes(input: ReceiptPayload): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeCommitmentHash(writer, input.clearingPlanHash, 'clearingPlanHash');
    writer.writeOptional(input.executionEvidenceHash, (element, value) => encodeCommitmentHash(element, value, 'executionEvidenceHash'), 'executionEvidenceHash');
    writer.writeArray(input.sources, (element, source) => {
      encodeCommitmentHash(element, source.sourceIntentHash, 'sourceIntentHash');
      encodeCommitmentHash(element, source.nettingProofHash, 'nettingProofHash');
      element.writeEnum(TRADE_SIDE, source.side, 'side');
      element.writeU128(source.quantityAtoms, 'quantityAtoms');
      element.writeU128(source.internalQuantityAtoms, 'internalQuantityAtoms');
      element.writeI256(source.internalQuoteDeltaAtoms, 'internalQuoteDeltaAtoms');
      element.writeU128(source.externalQuantityAtoms, 'externalQuantityAtoms');
      element.writeI256(source.externalGrossQuoteDeltaAtoms, 'externalGrossQuoteDeltaAtoms');
      element.writeU256(source.externalFeeQuoteAtoms, 'externalFeeQuoteAtoms');
      element.writeI256(source.totalQuoteDeltaAtoms, 'totalQuoteDeltaAtoms');
    }, 'sources');
  });
}

export function crossBatchClearingReceipt(
  plan: CrossBatchClearingPlan,
  intent?: CrossBatchExternalExecutionIntent,
  evidence?: CrossBatchExternalExecutionEvidence,
): CrossBatchClearingReceipt {
  if (plan.externalQuantityAtoms === 0n) {
    if (intent !== undefined || evidence !== undefined) {
      throw new MalformedInputError('crossBatchClearingReceipt', 'fully internal plan cannot carry execution data');
    }
  } else {
    if (intent === undefined || evidence === undefined) {
      throw new MalformedInputError('crossBatchClearingReceipt', 'external plan requires intent and evidence');
    }
    verifyCrossBatchExternalExecutionIntent(intent, plan);
    verifyCrossBatchExternalExecutionEvidence(evidence, intent);
    if (evidence.outcome !== 'EXACT_FILLED') {
      throw new MalformedInputError('crossBatchClearingReceipt.evidence', 'external execution is not exactly filled');
    }
  }
  const externalSources = plan.sources.filter((source) => source.externalQuantityAtoms > 0n);
  const weights = externalSources.map((source) => source.externalQuantityAtoms);
  const allocatedFees = evidence === undefined
    ? []
    : distributeBounded(evidence.feeQuoteAtoms, weights, externalSources.map((source) => source.maximumFeeQuoteAtoms));
  let allocatedGross: bigint[] = [];
  if (evidence !== undefined && intent !== undefined) {
    if (intent.side === 'BUY') {
      const caps = externalSources.map((source) => {
        const sourceIntent = source;
        return quoteMagnitude(sourceIntent.externalQuantityAtoms, plan.quantityIncrementAtoms, intent.limitPriceTicks, plan.priceTickQuoteAtoms, 'crossBatchClearingReceipt.buyLimit');
      });
      allocatedGross = distributeBounded(evidence.grossQuoteAtoms, weights, caps);
    } else {
      const minimums = externalSources.map((source) => quoteMagnitude(
        source.externalQuantityAtoms,
        plan.quantityIncrementAtoms,
        intent.limitPriceTicks,
        plan.priceTickQuoteAtoms,
        'crossBatchClearingReceipt.sellLimit',
      ));
      const minimumTotal = minimums.reduce((sum, value) => sum + value, 0n);
      if (minimumTotal > evidence.grossQuoteAtoms) {
        throw new MalformedInputError('crossBatchClearingReceipt.grossQuoteAtoms', 'seller proceeds violate source limit');
      }
      const surplus = distribute(evidence.grossQuoteAtoms - minimumTotal, weights);
      allocatedGross = minimums.map((value, index) => value + surplus[index]!);
    }
  }
  const externalIndexByHash = new Map(externalSources.map((source, index) => [toHex(source.sourceIntentHash), index]));
  const sources = Object.freeze(plan.sources.map((source): CrossBatchSourceReceipt => {
    const index = externalIndexByHash.get(toHex(source.sourceIntentHash));
    const gross = index === undefined ? 0n : allocatedGross[index]!;
    const externalGrossQuoteDeltaAtoms = source.side === 'BUY' ? -gross : gross;
    const externalFeeQuoteAtoms = index === undefined ? 0n : allocatedFees[index]!;
    return Object.freeze({
      sourceIntentHash: source.sourceIntentHash,
      nettingProofHash: source.nettingProofHash,
      side: source.side,
      quantityAtoms: source.quantityAtoms,
      internalQuantityAtoms: source.internalQuantityAtoms,
      internalQuoteDeltaAtoms: source.internalQuoteDeltaAtoms,
      externalQuantityAtoms: source.externalQuantityAtoms,
      externalGrossQuoteDeltaAtoms,
      externalFeeQuoteAtoms,
      totalQuoteDeltaAtoms: checkedSigned(
        source.internalQuoteDeltaAtoms + externalGrossQuoteDeltaAtoms - externalFeeQuoteAtoms,
        I256_BITS,
        'crossBatchClearingReceipt.totalQuoteDeltaAtoms',
      ),
    });
  }));
  const payload: ReceiptPayload = Object.freeze({
    version: CROSS_BATCH_CLEARING_RECEIPT_VERSION,
    clearingPlanHash: plan.planHash,
    ...(evidence === undefined ? {} : { executionEvidenceHash: evidence.evidenceHash }),
    sources,
  });
  const receiptHash = commitmentHash(
    domainHash(HASH_DOMAIN.CROSS_BATCH_CLEARING_RECEIPT, receiptBytes(payload)),
    'crossBatchClearingReceipt.receiptHash',
  );
  return Object.freeze({ ...payload, receiptHash });
}

export function verifyCrossBatchClearingReceipt(
  receipt: CrossBatchClearingReceipt,
  plan: CrossBatchClearingPlan,
  intent?: CrossBatchExternalExecutionIntent,
  evidence?: CrossBatchExternalExecutionEvidence,
): void {
  const expected = crossBatchClearingReceipt(plan, intent, evidence);
  if (compareBytes(expected.receiptHash, commitmentHash(receipt.receiptHash)) !== 0
    || compareBytes(expected.receiptHash, commitmentHash(domainHash(HASH_DOMAIN.CROSS_BATCH_CLEARING_RECEIPT, receiptBytes(receipt)))) !== 0) {
    throw new MalformedInputError('crossBatchClearingReceipt', 'receipt does not follow plan and execution');
  }
}
