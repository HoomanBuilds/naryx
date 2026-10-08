import { absBigInt, checkedSigned, checkedUnsigned, mulDiv, ROUNDING } from './arithmetic.js';
import { compareBytes, toHex } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  verifyNettingExternalExecutionEvidence,
  verifyNettingExternalExecutionIntent,
  type NettingExternalExecutionEvidence,
  type NettingExternalExecutionIntent,
} from './netting-execution.js';
import {
  verifyNettingResultAgainstPolicy,
  type NettingAllocation,
  type NettingResult,
} from './package-netting.js';
import {
  nettingPolicyManifest,
  type NettingPolicyManifest,
  type NettingPolicyManifestInput,
} from './netting-policy-manifest.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  encodeAssetRef,
  encodeProtocolId,
  type AssetRef,
  type ProtocolId,
} from './primitives.js';

export const NETTING_ALLOCATION_RECEIPT_VERSION = 1;
export const NETTING_FINAL_ALLOCATION_RECEIPT_VERSION = 1;

const U32_BITS = 32;
const U256_BITS = 256;
const I128_BITS = 128;
const I256_BITS = 256;

export interface NettingFinalAllocation {
  readonly version: 1;
  readonly allocationReceiptHash: CommitmentHash;
  readonly nettingProofHash: CommitmentHash;
  readonly obligationId: CommitmentHash;
  readonly ownerId: ProtocolId;
  readonly strategyOrderHash: CommitmentHash;
  readonly packageOrderId: CommitmentHash;
  readonly settlementReadinessHash: CommitmentHash;
  readonly legId: ProtocolId;
  readonly instrumentId: ProtocolId;
  readonly instrumentHash: CommitmentHash;
  readonly quoteAsset: AssetRef;
  readonly signedQuantityAtoms: bigint;
  readonly internalQuantityAtoms: bigint;
  readonly internalQuoteDeltaAtoms: bigint;
  readonly externalQuantityAtoms: bigint;
  readonly externalGrossQuoteDeltaAtoms: bigint;
  readonly externalFeeQuoteAtoms: bigint;
  readonly totalQuantityAtoms: bigint;
  readonly totalQuoteDeltaAtoms: bigint;
  readonly externalExecutionEvidenceHash?: CommitmentHash;
}

export interface NettingFinalAllocationReceipt {
  readonly version: 1;
  readonly receiptHash: CommitmentHash;
  readonly nettingProofHash: CommitmentHash;
  readonly nettingPolicyHash: CommitmentHash;
  readonly executionEvidenceHashes: readonly CommitmentHash[];
  readonly allocations: readonly NettingFinalAllocation[];
}

type AllocationPayload = Omit<NettingFinalAllocation, 'allocationReceiptHash'>;
type ReceiptPayload = Omit<NettingFinalAllocationReceipt, 'receiptHash'>;

function version(value: number, expected: number, context: string): 1 {
  if (typeof value !== 'number' || Number(checkedUnsigned(value, U32_BITS, context)) !== expected) {
    throw new MalformedInputError(context, `version must equal ${expected}`);
  }
  return 1;
}

function quoteAtLimit(
  allocation: NettingAllocation,
  quantityIncrementAtoms: bigint,
  priceTickQuoteAtoms: bigint,
): bigint {
  const quantity = absBigInt(allocation.externalQuantityAtoms);
  if (quantity % quantityIncrementAtoms !== 0n) {
    throw new MalformedInputError('nettingSettlementReceipt.externalQuantityAtoms', 'quantity is off the instrument lattice');
  }
  return checkedUnsigned(
    (quantity / quantityIncrementAtoms) * allocation.limitPriceTicks * priceTickQuoteAtoms,
    U256_BITS,
    'nettingSettlementReceipt.limitQuoteAtoms',
  );
}

function allocateUnbounded(total: bigint, weights: readonly bigint[]): bigint[] {
  const weightTotal = weights.reduce((sum, value) => sum + value, 0n);
  if (weightTotal === 0n) throw new MalformedInputError('nettingSettlementReceipt.weights', 'weight total is zero');
  const values = weights.map((weight) => mulDiv(total, weight, weightTotal, ROUNDING.FLOOR));
  let remaining = total - values.reduce((sum, value) => sum + value, 0n);
  for (let index = 0; remaining > 0n; index += 1) {
    values[index % values.length] = values[index % values.length]! + 1n;
    remaining -= 1n;
  }
  return values;
}

function allocateBounded(total: bigint, weights: readonly bigint[], caps: readonly bigint[]): bigint[] {
  if (weights.length === 0 || weights.length !== caps.length) {
    throw new MalformedInputError('nettingSettlementReceipt.boundedAllocation', 'weights and caps differ');
  }
  if (caps.reduce((sum, value) => sum + value, 0n) < total) {
    throw new MalformedInputError('nettingSettlementReceipt.boundedAllocation', 'allocation caps are insufficient');
  }
  const values = weights.map(() => 0n);
  let remaining = total;
  let active = weights.map((_, index) => index);
  while (remaining > 0n) {
    const activeWeight = active.reduce((sum, index) => sum + weights[index]!, 0n);
    let assigned = 0n;
    for (const index of active) {
      const room = caps[index]! - values[index]!;
      const proportional = activeWeight === 0n
        ? 0n
        : mulDiv(remaining, weights[index]!, activeWeight, ROUNDING.FLOOR);
      const share = proportional < room ? proportional : room;
      values[index] = values[index]! + share;
      assigned += share;
    }
    remaining -= assigned;
    active = active.filter((index) => values[index]! < caps[index]!);
    if (remaining === 0n) break;
    if (active.length === 0) {
      throw new MalformedInputError('nettingSettlementReceipt.boundedAllocation', 'allocation caps are insufficient');
    }
    if (assigned === 0n) {
      const index = active[0]!;
      const share = remaining < caps[index]! - values[index]!
        ? remaining
        : caps[index]! - values[index]!;
      values[index] = values[index]! + share;
      remaining -= share;
      active = active.filter((candidate) => values[candidate]! < caps[candidate]!);
    }
  }
  return values;
}

function allocationBytes(input: AllocationPayload): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeCommitmentHash(writer, input.nettingProofHash, 'nettingProofHash');
    encodeCommitmentHash(writer, input.obligationId, 'obligationId');
    encodeProtocolId(writer, input.ownerId, 'ownerId');
    encodeCommitmentHash(writer, input.strategyOrderHash, 'strategyOrderHash');
    encodeCommitmentHash(writer, input.packageOrderId, 'packageOrderId');
    encodeCommitmentHash(writer, input.settlementReadinessHash, 'settlementReadinessHash');
    encodeProtocolId(writer, input.legId, 'legId');
    encodeProtocolId(writer, input.instrumentId, 'instrumentId');
    encodeCommitmentHash(writer, input.instrumentHash, 'instrumentHash');
    encodeAssetRef(writer, input.quoteAsset);
    writer.writeI128(input.signedQuantityAtoms, 'signedQuantityAtoms');
    writer.writeI128(input.internalQuantityAtoms, 'internalQuantityAtoms');
    writer.writeI256(input.internalQuoteDeltaAtoms, 'internalQuoteDeltaAtoms');
    writer.writeI128(input.externalQuantityAtoms, 'externalQuantityAtoms');
    writer.writeI256(input.externalGrossQuoteDeltaAtoms, 'externalGrossQuoteDeltaAtoms');
    writer.writeU256(input.externalFeeQuoteAtoms, 'externalFeeQuoteAtoms');
    writer.writeI128(input.totalQuantityAtoms, 'totalQuantityAtoms');
    writer.writeI256(input.totalQuoteDeltaAtoms, 'totalQuoteDeltaAtoms');
    writer.writeOptional(
      input.externalExecutionEvidenceHash,
      (element, value) => encodeCommitmentHash(element, value, 'externalExecutionEvidenceHash'),
      'externalExecutionEvidenceHash',
    );
  });
}

function checkedAllocation(input: AllocationPayload): AllocationPayload {
  version(input.version, NETTING_ALLOCATION_RECEIPT_VERSION, 'nettingSettlementAllocation.version');
  if (input.totalQuantityAtoms !== input.internalQuantityAtoms + input.externalQuantityAtoms
    || input.totalQuantityAtoms !== input.signedQuantityAtoms) {
    throw new MalformedInputError('nettingSettlementAllocation.totalQuantityAtoms', 'quantity is not conserved');
  }
  if (input.totalQuoteDeltaAtoms
    !== input.internalQuoteDeltaAtoms + input.externalGrossQuoteDeltaAtoms - input.externalFeeQuoteAtoms) {
    throw new MalformedInputError('nettingSettlementAllocation.totalQuoteDeltaAtoms', 'quote value is not conserved');
  }
  if ((input.externalQuantityAtoms === 0n) !== (input.externalExecutionEvidenceHash === undefined)) {
    throw new MalformedInputError('nettingSettlementAllocation.externalExecutionEvidenceHash', 'external evidence presence is inconsistent');
  }
  checkedSigned(input.signedQuantityAtoms, I128_BITS, 'nettingSettlementAllocation.signedQuantityAtoms');
  checkedSigned(input.internalQuantityAtoms, I128_BITS, 'nettingSettlementAllocation.internalQuantityAtoms');
  checkedSigned(input.internalQuoteDeltaAtoms, I256_BITS, 'nettingSettlementAllocation.internalQuoteDeltaAtoms');
  checkedSigned(input.externalQuantityAtoms, I128_BITS, 'nettingSettlementAllocation.externalQuantityAtoms');
  checkedSigned(input.externalGrossQuoteDeltaAtoms, I256_BITS, 'nettingSettlementAllocation.externalGrossQuoteDeltaAtoms');
  checkedUnsigned(input.externalFeeQuoteAtoms, U256_BITS, 'nettingSettlementAllocation.externalFeeQuoteAtoms');
  checkedSigned(input.totalQuantityAtoms, I128_BITS, 'nettingSettlementAllocation.totalQuantityAtoms');
  checkedSigned(input.totalQuoteDeltaAtoms, I256_BITS, 'nettingSettlementAllocation.totalQuoteDeltaAtoms');
  return input;
}

function allocationReceipt(input: AllocationPayload): NettingFinalAllocation {
  const payload = checkedAllocation(input);
  const allocationReceiptHash = commitmentHash(
    domainHash(HASH_DOMAIN.NETTING_ALLOCATION_RECEIPT, allocationBytes(payload)),
    'nettingSettlementAllocation.allocationReceiptHash',
  );
  return Object.freeze({ ...payload, allocationReceiptHash });
}

function receiptBytes(input: ReceiptPayload): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeCommitmentHash(writer, input.nettingProofHash, 'nettingProofHash');
    encodeCommitmentHash(writer, input.nettingPolicyHash, 'nettingPolicyHash');
    writer.writeArray(input.executionEvidenceHashes, (element, value) =>
      encodeCommitmentHash(element, value, 'executionEvidenceHash'), 'executionEvidenceHashes');
    writer.writeArray(input.allocations, (element, value) =>
      encodeCommitmentHash(element, value.allocationReceiptHash, 'allocationReceiptHash'), 'allocations');
  });
}

export function nettingFinalAllocationReceipt(
  result: NettingResult,
  policyInput: NettingPolicyManifestInput | NettingPolicyManifest,
  intents: readonly NettingExternalExecutionIntent[],
  evidence: readonly NettingExternalExecutionEvidence[],
): NettingFinalAllocationReceipt {
  const policy = nettingPolicyManifest(policyInput, 'nettingSettlementReceipt.policy');
  verifyNettingResultAgainstPolicy(result, policy);
  const intentByInstrument = new Map<string, NettingExternalExecutionIntent>();
  const evidenceByIntent = new Map<string, NettingExternalExecutionEvidence>();
  for (const intent of intents) {
    verifyNettingExternalExecutionIntent(intent, result, policy);
    if (intentByInstrument.has(intent.instrumentId)) {
      throw new DuplicateElementError('nettingSettlementReceipt.intents', 'instrument repeats');
    }
    intentByInstrument.set(intent.instrumentId, intent);
  }
  for (const item of evidence) {
    const key = toHex(item.intentHash);
    if (evidenceByIntent.has(key)) {
      throw new DuplicateElementError('nettingSettlementReceipt.evidence', 'intent repeats');
    }
    evidenceByIntent.set(key, item);
  }
  const externalSummaries = result.underlyings.filter((summary) => summary.externalNetAtoms !== 0n);
  if (intents.length !== externalSummaries.length || evidence.length !== externalSummaries.length) {
    throw new MalformedInputError('nettingSettlementReceipt', 'external intent or evidence coverage is incomplete');
  }
  const allocationsById = new Map<string, NettingFinalAllocation>();
  for (const summary of result.underlyings) {
    const lines = result.allocations.filter((allocation) => allocation.instrumentId === summary.instrumentId);
    const instrument = policy.instruments.find((candidate) => candidate.instrumentId === summary.instrumentId)!;
    if (summary.externalNetAtoms === 0n) {
      if (intentByInstrument.has(summary.instrumentId)) {
        throw new MalformedInputError('nettingSettlementReceipt.intents', 'internally cleared instrument has an external intent');
      }
      for (const line of lines) {
        allocationsById.set(toHex(line.obligationId), allocationReceipt({
          version: NETTING_ALLOCATION_RECEIPT_VERSION,
          nettingProofHash: result.proofHash,
          obligationId: line.obligationId,
          ownerId: line.ownerId,
          strategyOrderHash: line.strategyOrderHash,
          packageOrderId: line.packageOrderId,
          settlementReadinessHash: line.settlementReadinessHash,
          legId: line.legId,
          instrumentId: line.instrumentId,
          instrumentHash: line.instrumentHash,
          quoteAsset: instrument.quoteAsset,
          signedQuantityAtoms: line.signedQuantityAtoms,
          internalQuantityAtoms: line.internalQuantityAtoms,
          internalQuoteDeltaAtoms: line.internalQuoteDeltaAtoms,
          externalQuantityAtoms: 0n,
          externalGrossQuoteDeltaAtoms: 0n,
          externalFeeQuoteAtoms: 0n,
          totalQuantityAtoms: line.signedQuantityAtoms,
          totalQuoteDeltaAtoms: line.internalQuoteDeltaAtoms,
        }));
      }
      continue;
    }
    const intent = intentByInstrument.get(summary.instrumentId);
    if (intent === undefined) throw new MalformedInputError('nettingSettlementReceipt.intents', 'external intent is missing');
    const item = evidenceByIntent.get(toHex(intent.intentHash));
    if (item === undefined) throw new MalformedInputError('nettingSettlementReceipt.evidence', 'external evidence is missing');
    verifyNettingExternalExecutionEvidence(item, intent);
    if (item.outcome !== 'EXACT_FILLED') {
      throw new MalformedInputError('nettingSettlementReceipt.evidence', 'external execution is not exactly filled');
    }
    const externalLines = lines.filter((line) => line.externalQuantityAtoms !== 0n);
    const weights = externalLines.map((line) => absBigInt(line.externalQuantityAtoms));
    const sourceCaps = new Map(intent.sourceFeeCaps.map((source) => [toHex(source.obligationId), source.maximumFeeQuoteAtoms]));
    const feeCaps = externalLines.map((line) => {
      const cap = sourceCaps.get(toHex(line.obligationId));
      if (cap === undefined) throw new MalformedInputError('nettingSettlementReceipt.sourceFeeCaps', 'source fee cap is missing');
      return cap;
    });
    const allocatedFees = allocateBounded(item.feeQuoteAtoms, weights, feeCaps);
    let allocatedGross: bigint[];
    if (summary.externalNetAtoms > 0n) {
      allocatedGross = allocateBounded(
        item.grossQuoteAtoms,
        weights,
        externalLines.map((line) => quoteAtLimit(line, summary.quantityIncrementAtoms, summary.priceTickQuoteAtoms)),
      );
    } else {
      const minimums = externalLines.map((line) => quoteAtLimit(
        line,
        summary.quantityIncrementAtoms,
        summary.priceTickQuoteAtoms,
      ));
      const minimumTotal = minimums.reduce((sum, value) => sum + value, 0n);
      if (minimumTotal > item.grossQuoteAtoms) {
        throw new MalformedInputError('nettingSettlementReceipt.grossQuoteAtoms', 'seller proceeds violate a source limit');
      }
      const surplus = allocateUnbounded(item.grossQuoteAtoms - minimumTotal, weights);
      allocatedGross = minimums.map((minimum, index) => minimum + surplus[index]!);
    }
    for (const line of lines) {
      const externalIndex = externalLines.indexOf(line);
      const externalGrossMagnitude = externalIndex < 0 ? 0n : allocatedGross[externalIndex]!;
      const externalGrossQuoteDeltaAtoms = line.externalQuantityAtoms > 0n
        ? -externalGrossMagnitude
        : externalGrossMagnitude;
      const externalFeeQuoteAtoms = externalIndex < 0 ? 0n : allocatedFees[externalIndex]!;
      allocationsById.set(toHex(line.obligationId), allocationReceipt({
        version: NETTING_ALLOCATION_RECEIPT_VERSION,
        nettingProofHash: result.proofHash,
        obligationId: line.obligationId,
        ownerId: line.ownerId,
        strategyOrderHash: line.strategyOrderHash,
        packageOrderId: line.packageOrderId,
        settlementReadinessHash: line.settlementReadinessHash,
        legId: line.legId,
        instrumentId: line.instrumentId,
        instrumentHash: line.instrumentHash,
        quoteAsset: instrument.quoteAsset,
        signedQuantityAtoms: line.signedQuantityAtoms,
        internalQuantityAtoms: line.internalQuantityAtoms,
        internalQuoteDeltaAtoms: line.internalQuoteDeltaAtoms,
        externalQuantityAtoms: line.externalQuantityAtoms,
        externalGrossQuoteDeltaAtoms,
        externalFeeQuoteAtoms,
        totalQuantityAtoms: line.signedQuantityAtoms,
        totalQuoteDeltaAtoms: checkedSigned(
          line.internalQuoteDeltaAtoms + externalGrossQuoteDeltaAtoms - externalFeeQuoteAtoms,
          I256_BITS,
          'nettingSettlementReceipt.totalQuoteDeltaAtoms',
        ),
        ...(externalIndex < 0 ? {} : { externalExecutionEvidenceHash: item.evidenceHash }),
      }));
    }
  }
  const allocations = Object.freeze(result.allocations.map((value) => allocationsById.get(toHex(value.obligationId))!));
  if (allocations.some((value) => value === undefined)) {
    throw new MalformedInputError('nettingSettlementReceipt.allocations', 'allocation receipt is missing');
  }
  const executionEvidenceHashes = Object.freeze(evidence.map((value) => value.evidenceHash).sort(compareBytes));
  const payload = Object.freeze({
    version: NETTING_FINAL_ALLOCATION_RECEIPT_VERSION as 1,
    nettingProofHash: result.proofHash,
    nettingPolicyHash: result.nettingPolicyHash,
    executionEvidenceHashes,
    allocations,
  });
  const receiptHash = commitmentHash(
    domainHash(HASH_DOMAIN.NETTING_FINAL_ALLOCATION_RECEIPT, receiptBytes(payload)),
    'nettingFinalAllocationReceipt.receiptHash',
  );
  return Object.freeze({ ...payload, receiptHash });
}

export function verifyNettingFinalAllocationReceipt(
  receipt: NettingFinalAllocationReceipt,
  result: NettingResult,
  policy: NettingPolicyManifestInput | NettingPolicyManifest,
  intents: readonly NettingExternalExecutionIntent[],
  evidence: readonly NettingExternalExecutionEvidence[],
): void {
  version(receipt.version, NETTING_FINAL_ALLOCATION_RECEIPT_VERSION, 'nettingFinalAllocationReceipt.version');
  const expected = nettingFinalAllocationReceipt(result, policy, intents, evidence);
  if (compareBytes(receipt.receiptHash, expected.receiptHash) !== 0
    || compareBytes(commitmentHash(domainHash(HASH_DOMAIN.NETTING_FINAL_ALLOCATION_RECEIPT, receiptBytes(receipt)), 'nettingFinalAllocationReceipt.receiptHash'), expected.receiptHash) !== 0) {
    throw new MalformedInputError('nettingFinalAllocationReceipt', 'receipt does not follow the netting result and execution evidence');
  }
}
