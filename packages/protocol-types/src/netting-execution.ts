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
  verifyNettingResultAgainstPolicy,
  type NettingResult,
} from './package-netting.js';
import {
  adapterRef,
  commitmentHash,
  encodeAdapterRef,
  encodeCommitmentHash,
  type AdapterRef,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  nettingPolicyManifest,
  nettingPolicyManifestHash,
  type NettingPolicyManifest,
  type NettingPolicyManifestInput,
} from './netting-policy-manifest.js';
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

export const NETTING_EXTERNAL_EXECUTION_INTENT_VERSION = 1;
export const NETTING_EXTERNAL_EXECUTION_EVIDENCE_VERSION = 1;

const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const U256_BITS = 256;
const I128_BITS = 128;

export const NETTING_EXTERNAL_EXECUTION_OUTCOME = Object.freeze({
  EXACT_FILLED: 1,
  PARTIAL_FILL: 2,
  NO_FILL: 3,
  REJECTED: 4,
} as const);
export type NettingExternalExecutionOutcome = keyof typeof NETTING_EXTERNAL_EXECUTION_OUTCOME;

export interface NettingExternalExecutionIntentParameters {
  readonly instrumentId: string;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly sourceFeeCaps: readonly NettingExternalExecutionSourceFeeCapInput[];
}

export interface NettingExternalExecutionSourceFeeCapInput {
  readonly obligationId: Uint8Array | string;
  readonly maximumFeeQuoteAtoms: bigint;
}

export interface NettingExternalExecutionSourceFeeCap {
  readonly obligationId: CommitmentHash;
  readonly maximumFeeQuoteAtoms: bigint;
}

export interface NettingExternalExecutionIntent {
  readonly version: 1;
  readonly intentHash: CommitmentHash;
  readonly nettingProofHash: CommitmentHash;
  readonly nettingPolicyHash: CommitmentHash;
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
  readonly sourceFeeCaps: readonly NettingExternalExecutionSourceFeeCap[];
}

export interface NettingExternalExecutionEvidenceInput {
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

export interface NettingExternalExecutionEvidence extends Omit<
  NettingExternalExecutionEvidenceInput,
  'version' | 'intentHash' | 'executionReferenceHash' | 'authoritativeEvidenceHash'
> {
  readonly version: 1;
  readonly evidenceHash: CommitmentHash;
  readonly intentHash: CommitmentHash;
  readonly executionReferenceHash: CommitmentHash;
  readonly authoritativeEvidenceHash: CommitmentHash;
}

type IntentPayload = Omit<NettingExternalExecutionIntent, 'intentHash'>;
type EvidencePayload = Omit<NettingExternalExecutionEvidence, 'evidenceHash'>;

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function version(value: number, expected: number, context: string): 1 {
  if (typeof value !== 'number' || Number(checkedUnsigned(value, U32_BITS, context)) !== expected) {
    throw new MalformedInputError(context, `version must equal ${expected}`);
  }
  return 1;
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

function canonicalAsset(value: AssetRef, context: string): AssetRef {
  object(value, context);
  return assetRef(value.assetId, value.assetManifestHash, value.decimals, context);
}

function checkedIntent(input: IntentPayload, context: string): IntentPayload {
  object(input, context);
  enumDiscriminant(TRADE_SIDE, input.side, `${context}.side`);
  enumDiscriminant(EXPIRY_UNIT, input.validUntilUnit, `${context}.validUntilUnit`);
  const sourceFeeCaps = input.sourceFeeCaps
    .map((value, index) => Object.freeze({
      obligationId: commitmentHash(value.obligationId, `${context}.sourceFeeCaps[${index}].obligationId`),
      maximumFeeQuoteAtoms: unsigned(value.maximumFeeQuoteAtoms, U256_BITS, `${context}.sourceFeeCaps[${index}].maximumFeeQuoteAtoms`),
    }))
    .sort((left, right) => compareBytes(left.obligationId, right.obligationId));
  if (sourceFeeCaps.length === 0) throw new MalformedInputError(`${context}.sourceFeeCaps`, 'expected a nonempty array');
  if (new Set(sourceFeeCaps.map((value) => toHex(value.obligationId))).size !== sourceFeeCaps.length) {
    throw new DuplicateElementError(`${context}.sourceFeeCaps`, 'obligation ids repeat');
  }
  const maximumFeeQuoteAtoms = unsigned(input.maximumFeeQuoteAtoms, U256_BITS, `${context}.maximumFeeQuoteAtoms`);
  const sourceMaximumFeeQuoteAtoms = checkedUnsigned(
    sourceFeeCaps.reduce((total, value) => total + value.maximumFeeQuoteAtoms, 0n),
    U256_BITS,
    `${context}.sourceMaximumFeeQuoteAtoms`,
  );
  if (maximumFeeQuoteAtoms !== sourceMaximumFeeQuoteAtoms) {
    throw new MalformedInputError(`${context}.maximumFeeQuoteAtoms`, 'fee cap differs from the source obligation caps');
  }
  return Object.freeze({
    version: version(input.version, NETTING_EXTERNAL_EXECUTION_INTENT_VERSION, `${context}.version`),
    nettingProofHash: commitmentHash(input.nettingProofHash, `${context}.nettingProofHash`),
    nettingPolicyHash: commitmentHash(input.nettingPolicyHash, `${context}.nettingPolicyHash`),
    instrumentId: protocolId(input.instrumentId, `${context}.instrumentId`),
    instrumentHash: commitmentHash(input.instrumentHash, `${context}.instrumentHash`),
    domain: domainRef(input.domain.domainId, input.domain.domainManifestVersion, input.domain.domainManifestHash, `${context}.domain`),
    adapter: adapterRef(input.adapter, `${context}.adapter`),
    venue: versionedManifestRef(input.venue.subjectId, input.venue.manifestVersion, input.venue.manifestHash, `${context}.venue`),
    market: versionedManifestRef(input.market.subjectId, input.market.manifestVersion, input.market.manifestHash, `${context}.market`),
    quantityAsset: canonicalAsset(input.quantityAsset, `${context}.quantityAsset`),
    quoteAsset: canonicalAsset(input.quoteAsset, `${context}.quoteAsset`),
    side: input.side,
    quantityAtoms: positive(input.quantityAtoms, U128_BITS, `${context}.quantityAtoms`),
    limitPriceTicks: positive(input.limitPriceTicks, U128_BITS, `${context}.limitPriceTicks`),
    quantityIncrementAtoms: positive(input.quantityIncrementAtoms, U128_BITS, `${context}.quantityIncrementAtoms`),
    priceTickQuoteAtoms: positive(input.priceTickQuoteAtoms, U128_BITS, `${context}.priceTickQuoteAtoms`),
    maximumFeeQuoteAtoms,
    validUntilUnit: input.validUntilUnit,
    validUntilValue: positive(input.validUntilValue, U64_BITS, `${context}.validUntilValue`),
    sourceFeeCaps: Object.freeze(sourceFeeCaps),
  });
}

function encodeIntent(input: IntentPayload): Uint8Array {
  const value = checkedIntent(input, 'nettingExternalExecutionIntent');
  return canonicalBytes((writer) => {
    writer.writeU32(value.version, 'version');
    encodeCommitmentHash(writer, value.nettingProofHash, 'nettingProofHash');
    encodeCommitmentHash(writer, value.nettingPolicyHash, 'nettingPolicyHash');
    encodeProtocolId(writer, value.instrumentId, 'instrumentId');
    encodeCommitmentHash(writer, value.instrumentHash, 'instrumentHash');
    encodeDomainRef(writer, value.domain);
    encodeAdapterRef(writer, value.adapter);
    encodeVersionedManifestRef(writer, value.venue);
    encodeVersionedManifestRef(writer, value.market);
    encodeAssetRef(writer, value.quantityAsset);
    encodeAssetRef(writer, value.quoteAsset);
    writer.writeEnum(TRADE_SIDE, value.side, 'side');
    writer.writeU128(value.quantityAtoms, 'quantityAtoms');
    writer.writeU128(value.limitPriceTicks, 'limitPriceTicks');
    writer.writeU128(value.quantityIncrementAtoms, 'quantityIncrementAtoms');
    writer.writeU128(value.priceTickQuoteAtoms, 'priceTickQuoteAtoms');
    writer.writeU256(value.maximumFeeQuoteAtoms, 'maximumFeeQuoteAtoms');
    writer.writeEnum(EXPIRY_UNIT, value.validUntilUnit, 'validUntilUnit');
    writer.writeU64(value.validUntilValue, 'validUntilValue');
    writer.writeArray(value.sourceFeeCaps, (element, source) => {
      encodeCommitmentHash(element, source.obligationId, 'obligationId');
      element.writeU256(source.maximumFeeQuoteAtoms, 'maximumFeeQuoteAtoms');
    }, 'sourceFeeCaps');
  });
}

export function nettingExternalExecutionIntentHash(input: IntentPayload): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.NETTING_EXTERNAL_EXECUTION_INTENT, encodeIntent(input)),
    'nettingExternalExecutionIntentHash',
  );
}

export function nettingExternalExecutionIntent(
  result: NettingResult,
  policyInput: NettingPolicyManifestInput | NettingPolicyManifest,
  parameters: NettingExternalExecutionIntentParameters,
): NettingExternalExecutionIntent {
  const policy = nettingPolicyManifest(policyInput, 'nettingExternalExecutionIntent.policy');
  verifyNettingResultAgainstPolicy(result, policy);
  const instrumentId = protocolId(parameters.instrumentId, 'nettingExternalExecutionIntent.instrumentId');
  const instrument = policy.instruments.find((value) => value.instrumentId === instrumentId);
  const summary = result.underlyings.find((value) => value.instrumentId === instrumentId);
  if (instrument === undefined || summary === undefined) {
    throw new MalformedInputError('nettingExternalExecutionIntent.instrumentId', 'instrument is not in the netting result and policy');
  }
  if (summary.externalNetAtoms === 0n || summary.externalLimitPriceTicks === undefined) {
    throw new MalformedInputError('nettingExternalExecutionIntent.instrumentId', 'instrument has no external residual');
  }
  const sourceObligationIds = result.allocations
    .filter((value) => value.instrumentId === instrumentId && value.externalQuantityAtoms !== 0n)
    .map((value) => value.obligationId)
    .sort(compareBytes);
  const sourceFeeCaps = parameters.sourceFeeCaps
    .map((value) => Object.freeze({
      obligationId: commitmentHash(value.obligationId, 'nettingExternalExecutionIntent.sourceFeeCaps.obligationId'),
      maximumFeeQuoteAtoms: unsigned(value.maximumFeeQuoteAtoms, U256_BITS, 'nettingExternalExecutionIntent.sourceFeeCaps.maximumFeeQuoteAtoms'),
    }))
    .sort((left, right) => compareBytes(left.obligationId, right.obligationId));
  if (
    sourceFeeCaps.length !== sourceObligationIds.length
    || sourceFeeCaps.some((value, index) => compareBytes(value.obligationId, sourceObligationIds[index]!) !== 0)
  ) {
    throw new MalformedInputError('nettingExternalExecutionIntent.sourceFeeCaps', 'fee caps do not cover the exact external obligations');
  }
  const maximumFeeQuoteAtoms = checkedUnsigned(
    sourceFeeCaps.reduce((total, value) => total + value.maximumFeeQuoteAtoms, 0n),
    U256_BITS,
    'nettingExternalExecutionIntent.maximumFeeQuoteAtoms',
  );
  const payload = checkedIntent({
    version: NETTING_EXTERNAL_EXECUTION_INTENT_VERSION,
    nettingProofHash: result.proofHash,
    nettingPolicyHash: commitmentHash(nettingPolicyManifestHash(policy), 'nettingExternalExecutionIntent.nettingPolicyHash'),
    instrumentId,
    instrumentHash: instrument.instrumentHash,
    domain: instrument.domain,
    adapter: instrument.adapter,
    venue: instrument.venue,
    market: instrument.market,
    quantityAsset: instrument.quantityAsset,
    quoteAsset: instrument.quoteAsset,
    side: summary.externalNetAtoms > 0n ? 'BUY' : 'SELL',
    quantityAtoms: absBigInt(summary.externalNetAtoms),
    limitPriceTicks: summary.externalLimitPriceTicks,
    quantityIncrementAtoms: instrument.quantityIncrementAtoms,
    priceTickQuoteAtoms: instrument.priceTickQuoteAtoms,
    maximumFeeQuoteAtoms,
    validUntilUnit: parameters.validUntilUnit,
    validUntilValue: parameters.validUntilValue,
    sourceFeeCaps,
  }, 'nettingExternalExecutionIntent');
  return Object.freeze({ ...payload, intentHash: nettingExternalExecutionIntentHash(payload) });
}

export function verifyNettingExternalExecutionIntent(
  intent: NettingExternalExecutionIntent,
  result: NettingResult,
  policy: NettingPolicyManifestInput | NettingPolicyManifest,
): void {
  const expected = nettingExternalExecutionIntent(result, policy, {
    instrumentId: intent.instrumentId,
    validUntilUnit: intent.validUntilUnit,
    validUntilValue: intent.validUntilValue,
    sourceFeeCaps: intent.sourceFeeCaps,
  });
  if (compareBytes(expected.intentHash, commitmentHash(intent.intentHash, 'nettingExternalExecutionIntent.intentHash')) !== 0
    || compareBytes(nettingExternalExecutionIntentHash(intent), expected.intentHash) !== 0) {
    throw new MalformedInputError('nettingExternalExecutionIntent', 'intent does not follow the netting result and policy');
  }
}

function checkedEvidence(
  input: NettingExternalExecutionEvidenceInput | NettingExternalExecutionEvidence,
  intent: NettingExternalExecutionIntent,
  context: string,
): EvidencePayload {
  object(input, context);
  const outcome = input.outcome;
  enumDiscriminant(NETTING_EXTERNAL_EXECUTION_OUTCOME, outcome, `${context}.outcome`);
  enumDiscriminant(EXPIRY_UNIT, input.submittedAtUnit, `${context}.submittedAtUnit`);
  enumDiscriminant(EXPIRY_UNIT, input.observedAtUnit, `${context}.observedAtUnit`);
  const submittedAtValue = unsigned(input.submittedAtValue, U64_BITS, `${context}.submittedAtValue`);
  const observedAtValue = unsigned(input.observedAtValue, U64_BITS, `${context}.observedAtValue`);
  const filledSignedQuantityAtoms = checkedSigned(input.filledSignedQuantityAtoms, I128_BITS, `${context}.filledSignedQuantityAtoms`);
  const grossQuoteAtoms = unsigned(input.grossQuoteAtoms, U256_BITS, `${context}.grossQuoteAtoms`);
  const feeQuoteAtoms = unsigned(input.feeQuoteAtoms, U256_BITS, `${context}.feeQuoteAtoms`);
  if (compareBytes(commitmentHash(input.intentHash, `${context}.intentHash`), intent.intentHash) !== 0) {
    throw new MalformedInputError(`${context}.intentHash`, 'evidence cites another execution intent');
  }
  if (input.submittedAtUnit !== intent.validUntilUnit || input.observedAtUnit !== intent.validUntilUnit) {
    throw new MalformedInputError(context, 'execution timestamps use another clock');
  }
  if (submittedAtValue >= intent.validUntilValue) throw new MalformedInputError(`${context}.submittedAtValue`, 'execution was submitted after expiry');
  if (observedAtValue < submittedAtValue) throw new MalformedInputError(`${context}.observedAtValue`, 'observation predates submission');
  const requestedSigned = intent.side === 'BUY' ? intent.quantityAtoms : -intent.quantityAtoms;
  if (outcome === 'EXACT_FILLED' && filledSignedQuantityAtoms !== requestedSigned) {
    throw new MalformedInputError(`${context}.filledSignedQuantityAtoms`, 'exact fill differs from the execution intent');
  }
  if (outcome === 'PARTIAL_FILL' && (
    filledSignedQuantityAtoms === 0n
    || (filledSignedQuantityAtoms > 0n) !== (requestedSigned > 0n)
    || absBigInt(filledSignedQuantityAtoms) >= intent.quantityAtoms
  )) {
    throw new MalformedInputError(`${context}.filledSignedQuantityAtoms`, 'partial fill is not a strict same-side subset');
  }
  if ((outcome === 'NO_FILL' || outcome === 'REJECTED') && filledSignedQuantityAtoms !== 0n) {
    throw new MalformedInputError(`${context}.filledSignedQuantityAtoms`, 'an unfilled outcome carries filled quantity');
  }
  if ((filledSignedQuantityAtoms === 0n) !== (grossQuoteAtoms === 0n)) {
    throw new MalformedInputError(`${context}.grossQuoteAtoms`, 'gross quote amount disagrees with filled quantity');
  }
  if (feeQuoteAtoms > intent.maximumFeeQuoteAtoms) throw new MalformedInputError(`${context}.feeQuoteAtoms`, 'fee exceeds the execution intent');
  if (filledSignedQuantityAtoms !== 0n) {
    const magnitude = absBigInt(filledSignedQuantityAtoms);
    if (magnitude % intent.quantityIncrementAtoms !== 0n) {
      throw new MalformedInputError(`${context}.filledSignedQuantityAtoms`, 'fill is off the quantity lattice');
    }
    const limitQuoteAtoms = checkedUnsigned(
      (magnitude / intent.quantityIncrementAtoms) * intent.limitPriceTicks * intent.priceTickQuoteAtoms,
      U256_BITS,
      `${context}.limitQuoteAtoms`,
    );
    if (intent.side === 'BUY' ? grossQuoteAtoms > limitQuoteAtoms : grossQuoteAtoms < limitQuoteAtoms) {
      throw new MalformedInputError(`${context}.grossQuoteAtoms`, 'fill violates the execution price limit');
    }
  }
  return Object.freeze({
    version: version(input.version, NETTING_EXTERNAL_EXECUTION_EVIDENCE_VERSION, `${context}.version`),
    intentHash: intent.intentHash,
    outcome,
    filledSignedQuantityAtoms,
    grossQuoteAtoms,
    feeQuoteAtoms,
    submittedAtUnit: input.submittedAtUnit,
    submittedAtValue,
    observedAtUnit: input.observedAtUnit,
    observedAtValue,
    executionReferenceHash: commitmentHash(input.executionReferenceHash, `${context}.executionReferenceHash`),
    authoritativeEvidenceHash: commitmentHash(input.authoritativeEvidenceHash, `${context}.authoritativeEvidenceHash`),
  });
}

function evidencePayloadBytes(input: EvidencePayload): Uint8Array {
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

export function nettingExternalExecutionEvidence(
  input: NettingExternalExecutionEvidenceInput,
  intent: NettingExternalExecutionIntent,
): NettingExternalExecutionEvidence {
  const payload = checkedEvidence(input, intent, 'nettingExternalExecutionEvidence');
  const evidenceHash = commitmentHash(
    domainHash(HASH_DOMAIN.NETTING_EXTERNAL_EXECUTION_EVIDENCE, evidencePayloadBytes(payload)),
    'nettingExternalExecutionEvidenceHash',
  );
  return Object.freeze({ ...payload, evidenceHash });
}

export function verifyNettingExternalExecutionEvidence(
  evidence: NettingExternalExecutionEvidence,
  intent: NettingExternalExecutionIntent,
): void {
  const payload = checkedEvidence(evidence, intent, 'nettingExternalExecutionEvidence');
  const expected = commitmentHash(
    domainHash(HASH_DOMAIN.NETTING_EXTERNAL_EXECUTION_EVIDENCE, evidencePayloadBytes(payload)),
    'nettingExternalExecutionEvidenceHash',
  );
  if (compareBytes(expected, commitmentHash(evidence.evidenceHash, 'nettingExternalExecutionEvidence.evidenceHash')) !== 0) {
    throw new MalformedInputError('nettingExternalExecutionEvidence.evidenceHash', 'evidence hash does not match its contents');
  }
}
