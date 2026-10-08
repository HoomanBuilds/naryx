import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes, toHex } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { enumDiscriminant, EXPIRY_UNIT, type ExpiryUnit } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  verifyNettingFinalAllocationReceipt,
  type NettingFinalAllocation,
  type NettingFinalAllocationReceipt,
} from './netting-settlement.js';
import type {
  NettingExternalExecutionEvidence,
  NettingExternalExecutionIntent,
} from './netting-execution.js';
import {
  nettingPolicyManifest,
  type NettingInstrumentPolicy,
  type NettingPolicyManifest,
  type NettingPolicyManifestInput,
} from './netting-policy-manifest.js';
import type { NettingResult } from './package-netting.js';
import type { LegFamily } from './package-graph.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  encodeAssetRef,
  encodeDomainRef,
  encodeProtocolId,
  protocolId,
  type AssetRef,
  type DomainRef,
  type ProtocolId,
} from './primitives.js';

export const NETTING_ALLOCATION_SETTLEMENT_EVIDENCE_VERSION = 1;
export const NETTING_SETTLEMENT_COMPLETION_RECEIPT_VERSION = 1;

export const NETTING_SETTLEMENT_STATE_KIND = Object.freeze({
  ASSET_BALANCE: 1,
  DERIVATIVE_POSITION: 2,
  CREDIT_POSITION: 3,
} as const);
export type NettingSettlementStateKind = keyof typeof NETTING_SETTLEMENT_STATE_KIND;

const U32_BITS = 32;
const U64_BITS = 64;
const I128_BITS = 128;
const I256_BITS = 256;

export interface NettingAllocationSettlementEvidenceInput {
  readonly version: number;
  readonly finalAllocationReceiptHash: Uint8Array | string;
  readonly allocationReceiptHash: Uint8Array | string;
  readonly settlementAccount: string;
  readonly settledQuantityAtoms: bigint;
  readonly settledQuoteDeltaAtoms: bigint;
  readonly observedAtUnit: ExpiryUnit;
  readonly observedAtValue: bigint;
  readonly settlementReferenceHash: Uint8Array | string;
  readonly authoritativeEvidenceHash: Uint8Array | string;
}

export interface NettingAllocationSettlementEvidence {
  readonly version: 1;
  readonly evidenceHash: CommitmentHash;
  readonly finalAllocationReceiptHash: CommitmentHash;
  readonly allocationReceiptHash: CommitmentHash;
  readonly nettingProofHash: CommitmentHash;
  readonly obligationId: CommitmentHash;
  readonly packageOrderId: CommitmentHash;
  readonly ownerId: ProtocolId;
  readonly settlementAccount: ProtocolId;
  readonly instrumentId: ProtocolId;
  readonly instrumentHash: CommitmentHash;
  readonly domain: DomainRef;
  readonly quantityAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly stateKind: NettingSettlementStateKind;
  readonly settledQuantityAtoms: bigint;
  readonly settledQuoteDeltaAtoms: bigint;
  readonly observedAtUnit: ExpiryUnit;
  readonly observedAtValue: bigint;
  readonly settlementReferenceHash: CommitmentHash;
  readonly authoritativeEvidenceHash: CommitmentHash;
}

export interface NettingSettlementCompletionReceipt {
  readonly version: 1;
  readonly receiptHash: CommitmentHash;
  readonly finalAllocationReceiptHash: CommitmentHash;
  readonly nettingProofHash: CommitmentHash;
  readonly settlementEvidenceHashes: readonly CommitmentHash[];
}

type EvidencePayload = Omit<NettingAllocationSettlementEvidence, 'evidenceHash'>;
type CompletionPayload = Omit<NettingSettlementCompletionReceipt, 'receiptHash'>;

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function version(value: number, expected: number, context: string): 1 {
  if (typeof value !== 'number' || Number(checkedUnsigned(value, U32_BITS, context)) !== expected) {
    throw new MalformedInputError(context, `version must equal ${expected}`);
  }
  return 1;
}

function settlementStateKind(legFamily: LegFamily): NettingSettlementStateKind {
  if (legFamily === 'LEND' || legFamily === 'BORROW' || legFamily === 'REPAY' || legFamily === 'WITHDRAW') {
    return 'CREDIT_POSITION';
  }
  if (
    legFamily === 'PERP_OPEN'
    || legFamily === 'PERP_CLOSE'
    || legFamily === 'PERP_INCREASE'
    || legFamily === 'PERP_DECREASE'
    || legFamily === 'PERP_MIGRATE'
    || legFamily === 'FUTURE_OPEN'
    || legFamily === 'FUTURE_CLOSE'
    || legFamily === 'FUTURE_ROLL'
    || legFamily === 'OPTION_BUY'
    || legFamily === 'OPTION_SELL'
    || legFamily === 'OPTION_MINT'
    || legFamily === 'OPTION_EXERCISE'
  ) {
    return 'DERIVATIVE_POSITION';
  }
  return 'ASSET_BALANCE';
}

function findAllocation(
  receipt: NettingFinalAllocationReceipt,
  allocationReceiptHash: Uint8Array | string,
): NettingFinalAllocation {
  const hash = commitmentHash(allocationReceiptHash, 'nettingAllocationSettlementEvidence.allocationReceiptHash');
  const allocation = receipt.allocations.find((candidate) => compareBytes(candidate.allocationReceiptHash, hash) === 0);
  if (allocation === undefined) {
    throw new MalformedInputError(
      'nettingAllocationSettlementEvidence.allocationReceiptHash',
      'allocation is not in the final allocation receipt',
    );
  }
  return allocation;
}

function findInstrument(
  policy: NettingPolicyManifest,
  allocation: NettingFinalAllocation,
): NettingInstrumentPolicy {
  const instrument = policy.instruments.find((candidate) => candidate.instrumentId === allocation.instrumentId);
  if (instrument === undefined || compareBytes(instrument.instrumentHash, allocation.instrumentHash) !== 0) {
    throw new MalformedInputError(
      'nettingAllocationSettlementEvidence.instrumentId',
      'allocation instrument is not in the netting policy',
    );
  }
  return instrument;
}

function verifyFinalReceipt(
  receipt: NettingFinalAllocationReceipt,
  result: NettingResult,
  policy: NettingPolicyManifestInput | NettingPolicyManifest,
  intents: readonly NettingExternalExecutionIntent[],
  externalEvidence: readonly NettingExternalExecutionEvidence[],
): NettingPolicyManifest {
  verifyNettingFinalAllocationReceipt(receipt, result, policy, intents, externalEvidence);
  return nettingPolicyManifest(policy, 'nettingAllocationSettlementEvidence.policy');
}

function checkedEvidence(
  input: NettingAllocationSettlementEvidenceInput | NettingAllocationSettlementEvidence,
  receipt: NettingFinalAllocationReceipt,
  policy: NettingPolicyManifest,
  context: string,
): EvidencePayload {
  object(input, context);
  const allocation = findAllocation(receipt, input.allocationReceiptHash);
  const instrument = findInstrument(policy, allocation);
  const finalAllocationReceiptHash = commitmentHash(input.finalAllocationReceiptHash, `${context}.finalAllocationReceiptHash`);
  if (compareBytes(finalAllocationReceiptHash, receipt.receiptHash) !== 0) {
    throw new MalformedInputError(`${context}.finalAllocationReceiptHash`, 'evidence cites another final allocation receipt');
  }
  if (input.settledQuantityAtoms !== allocation.totalQuantityAtoms) {
    throw new MalformedInputError(`${context}.settledQuantityAtoms`, 'observed quantity differs from the final allocation');
  }
  if (input.settledQuoteDeltaAtoms !== allocation.totalQuoteDeltaAtoms) {
    throw new MalformedInputError(`${context}.settledQuoteDeltaAtoms`, 'observed quote delta differs from the final allocation');
  }
  enumDiscriminant(EXPIRY_UNIT, input.observedAtUnit, `${context}.observedAtUnit`);
  const observedAtValue = checkedUnsigned(input.observedAtValue, U64_BITS, `${context}.observedAtValue`);
  if (observedAtValue === 0n) throw new MalformedInputError(`${context}.observedAtValue`, 'observation time is zero');
  return Object.freeze({
    version: version(input.version, NETTING_ALLOCATION_SETTLEMENT_EVIDENCE_VERSION, `${context}.version`),
    finalAllocationReceiptHash,
    allocationReceiptHash: allocation.allocationReceiptHash,
    nettingProofHash: receipt.nettingProofHash,
    obligationId: allocation.obligationId,
    packageOrderId: allocation.packageOrderId,
    ownerId: allocation.ownerId,
    settlementAccount: protocolId(input.settlementAccount, `${context}.settlementAccount`),
    instrumentId: allocation.instrumentId,
    instrumentHash: allocation.instrumentHash,
    domain: instrument.domain,
    quantityAsset: instrument.quantityAsset,
    quoteAsset: instrument.quoteAsset,
    stateKind: settlementStateKind(instrument.legFamily),
    settledQuantityAtoms: checkedSigned(input.settledQuantityAtoms, I128_BITS, `${context}.settledQuantityAtoms`),
    settledQuoteDeltaAtoms: checkedSigned(input.settledQuoteDeltaAtoms, I256_BITS, `${context}.settledQuoteDeltaAtoms`),
    observedAtUnit: input.observedAtUnit,
    observedAtValue,
    settlementReferenceHash: commitmentHash(input.settlementReferenceHash, `${context}.settlementReferenceHash`),
    authoritativeEvidenceHash: commitmentHash(input.authoritativeEvidenceHash, `${context}.authoritativeEvidenceHash`),
  });
}

function evidenceBytes(input: EvidencePayload): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeCommitmentHash(writer, input.finalAllocationReceiptHash, 'finalAllocationReceiptHash');
    encodeCommitmentHash(writer, input.allocationReceiptHash, 'allocationReceiptHash');
    encodeCommitmentHash(writer, input.nettingProofHash, 'nettingProofHash');
    encodeCommitmentHash(writer, input.obligationId, 'obligationId');
    encodeCommitmentHash(writer, input.packageOrderId, 'packageOrderId');
    encodeProtocolId(writer, input.ownerId, 'ownerId');
    encodeProtocolId(writer, input.settlementAccount, 'settlementAccount');
    encodeProtocolId(writer, input.instrumentId, 'instrumentId');
    encodeCommitmentHash(writer, input.instrumentHash, 'instrumentHash');
    encodeDomainRef(writer, input.domain);
    encodeAssetRef(writer, input.quantityAsset);
    encodeAssetRef(writer, input.quoteAsset);
    writer.writeEnum(NETTING_SETTLEMENT_STATE_KIND, input.stateKind, 'stateKind');
    writer.writeI128(input.settledQuantityAtoms, 'settledQuantityAtoms');
    writer.writeI256(input.settledQuoteDeltaAtoms, 'settledQuoteDeltaAtoms');
    writer.writeEnum(EXPIRY_UNIT, input.observedAtUnit, 'observedAtUnit');
    writer.writeU64(input.observedAtValue, 'observedAtValue');
    encodeCommitmentHash(writer, input.settlementReferenceHash, 'settlementReferenceHash');
    encodeCommitmentHash(writer, input.authoritativeEvidenceHash, 'authoritativeEvidenceHash');
  });
}

export function nettingAllocationSettlementEvidence(
  input: NettingAllocationSettlementEvidenceInput,
  receipt: NettingFinalAllocationReceipt,
  result: NettingResult,
  policyInput: NettingPolicyManifestInput | NettingPolicyManifest,
  intents: readonly NettingExternalExecutionIntent[],
  externalEvidence: readonly NettingExternalExecutionEvidence[],
): NettingAllocationSettlementEvidence {
  const policy = verifyFinalReceipt(receipt, result, policyInput, intents, externalEvidence);
  const payload = checkedEvidence(input, receipt, policy, 'nettingAllocationSettlementEvidence');
  const evidenceHash = commitmentHash(
    domainHash(HASH_DOMAIN.NETTING_ALLOCATION_SETTLEMENT_EVIDENCE, evidenceBytes(payload)),
    'nettingAllocationSettlementEvidence.evidenceHash',
  );
  return Object.freeze({ ...payload, evidenceHash });
}

export function verifyNettingAllocationSettlementEvidence(
  evidence: NettingAllocationSettlementEvidence,
  receipt: NettingFinalAllocationReceipt,
  result: NettingResult,
  policyInput: NettingPolicyManifestInput | NettingPolicyManifest,
  intents: readonly NettingExternalExecutionIntent[],
  externalEvidence: readonly NettingExternalExecutionEvidence[],
): void {
  const policy = verifyFinalReceipt(receipt, result, policyInput, intents, externalEvidence);
  const payload = checkedEvidence(evidence, receipt, policy, 'nettingAllocationSettlementEvidence');
  const expected = commitmentHash(
    domainHash(HASH_DOMAIN.NETTING_ALLOCATION_SETTLEMENT_EVIDENCE, evidenceBytes(payload)),
    'nettingAllocationSettlementEvidence.evidenceHash',
  );
  if (compareBytes(expected, commitmentHash(evidence.evidenceHash, 'nettingAllocationSettlementEvidence.evidenceHash')) !== 0) {
    throw new MalformedInputError('nettingAllocationSettlementEvidence.evidenceHash', 'evidence hash does not match its contents');
  }
}

function completionBytes(input: CompletionPayload): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeCommitmentHash(writer, input.finalAllocationReceiptHash, 'finalAllocationReceiptHash');
    encodeCommitmentHash(writer, input.nettingProofHash, 'nettingProofHash');
    writer.writeArray(input.settlementEvidenceHashes, (element, value) =>
      encodeCommitmentHash(element, value, 'settlementEvidenceHash'), 'settlementEvidenceHashes');
  });
}

function completionPayload(
  receipt: NettingFinalAllocationReceipt,
  settlementEvidence: readonly NettingAllocationSettlementEvidence[],
  result: NettingResult,
  policyInput: NettingPolicyManifestInput | NettingPolicyManifest,
  intents: readonly NettingExternalExecutionIntent[],
  externalEvidence: readonly NettingExternalExecutionEvidence[],
): CompletionPayload {
  verifyFinalReceipt(receipt, result, policyInput, intents, externalEvidence);
  if (settlementEvidence.length !== receipt.allocations.length) {
    throw new MalformedInputError('nettingSettlementCompletionReceipt.settlementEvidence', 'settlement evidence coverage is incomplete');
  }
  const evidenceByAllocation = new Map<string, NettingAllocationSettlementEvidence>();
  for (const evidence of settlementEvidence) {
    verifyNettingAllocationSettlementEvidence(evidence, receipt, result, policyInput, intents, externalEvidence);
    const allocationKey = toHex(evidence.allocationReceiptHash);
    if (evidenceByAllocation.has(allocationKey)) {
      throw new DuplicateElementError('nettingSettlementCompletionReceipt.settlementEvidence', 'allocation repeats');
    }
    evidenceByAllocation.set(allocationKey, evidence);
  }
  const ordered = receipt.allocations.map((allocation) => {
    const evidence = evidenceByAllocation.get(toHex(allocation.allocationReceiptHash));
    if (evidence === undefined) {
      throw new MalformedInputError('nettingSettlementCompletionReceipt.settlementEvidence', 'allocation settlement evidence is missing');
    }
    return evidence.evidenceHash;
  });
  return Object.freeze({
    version: NETTING_SETTLEMENT_COMPLETION_RECEIPT_VERSION as 1,
    finalAllocationReceiptHash: receipt.receiptHash,
    nettingProofHash: receipt.nettingProofHash,
    settlementEvidenceHashes: Object.freeze(ordered),
  });
}

export function nettingSettlementCompletionReceipt(
  receipt: NettingFinalAllocationReceipt,
  settlementEvidence: readonly NettingAllocationSettlementEvidence[],
  result: NettingResult,
  policy: NettingPolicyManifestInput | NettingPolicyManifest,
  intents: readonly NettingExternalExecutionIntent[],
  externalEvidence: readonly NettingExternalExecutionEvidence[],
): NettingSettlementCompletionReceipt {
  const payload = completionPayload(receipt, settlementEvidence, result, policy, intents, externalEvidence);
  const receiptHash = commitmentHash(
    domainHash(HASH_DOMAIN.NETTING_SETTLEMENT_COMPLETION_RECEIPT, completionBytes(payload)),
    'nettingSettlementCompletionReceipt.receiptHash',
  );
  return Object.freeze({ ...payload, receiptHash });
}

export function verifyNettingSettlementCompletionReceipt(
  completion: NettingSettlementCompletionReceipt,
  receipt: NettingFinalAllocationReceipt,
  settlementEvidence: readonly NettingAllocationSettlementEvidence[],
  result: NettingResult,
  policy: NettingPolicyManifestInput | NettingPolicyManifest,
  intents: readonly NettingExternalExecutionIntent[],
  externalEvidence: readonly NettingExternalExecutionEvidence[],
): void {
  version(completion.version, NETTING_SETTLEMENT_COMPLETION_RECEIPT_VERSION, 'nettingSettlementCompletionReceipt.version');
  const payload = completionPayload(receipt, settlementEvidence, result, policy, intents, externalEvidence);
  const expected = commitmentHash(
    domainHash(HASH_DOMAIN.NETTING_SETTLEMENT_COMPLETION_RECEIPT, completionBytes(payload)),
    'nettingSettlementCompletionReceipt.receiptHash',
  );
  if (
    compareBytes(expected, commitmentHash(completion.receiptHash, 'nettingSettlementCompletionReceipt.receiptHash')) !== 0
    || compareBytes(completion.finalAllocationReceiptHash, payload.finalAllocationReceiptHash) !== 0
    || compareBytes(completion.nettingProofHash, payload.nettingProofHash) !== 0
    || completion.settlementEvidenceHashes.length !== payload.settlementEvidenceHashes.length
    || completion.settlementEvidenceHashes.some((hash, index) => compareBytes(hash, payload.settlementEvidenceHashes[index]!) !== 0)
  ) {
    throw new MalformedInputError('nettingSettlementCompletionReceipt', 'completion receipt does not cover the final allocations');
  }
}
