import { checkedUnsigned } from './arithmetic.js';
import { bytesEqual, toHex } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { enumDiscriminant, EXPIRY_UNIT, type ExpiryUnit } from './enums.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  packageAllocation,
  packageAllocationHash,
  packageMatchingPolicy,
  packageMatchingPolicyHash,
  verifyPackageAllocation,
  type PackageAllocation,
  type PackageMatchingPolicy,
} from './package-matching.js';
import {
  packageSettlementCommitment,
  packageSettlementCommitmentHash,
  packageSettlementHandoff,
  packageSettlementHandoffHash,
  verifyPackageSettlementHandoff,
  type PackageSettlementCommitment,
  type PackageSettlementHandoff,
} from './package-settlement.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  encodeProtocolId,
  protocolId,
  type ProtocolId,
} from './primitives.js';
import {
  nativeClearingPolicy,
  type NativeClearingPolicy,
} from './native-package-clearing.js';

export const NATIVE_CLEARING_MATCH_AUTHORIZATION_VERSION = 1;

const U64_BITS = 64;

export interface NativeClearingMatchAuthorizationInput {
  readonly policy: NativeClearingPolicy;
  readonly matchingPolicy: PackageMatchingPolicy;
  readonly allocation: PackageAllocation;
  readonly handoff: PackageSettlementHandoff;
  readonly takerSettlementCommitment: PackageSettlementCommitment;
  readonly makerSettlementCommitment: PackageSettlementCommitment;
  readonly fillSequence: bigint;
  readonly currentExpiryUnit: ExpiryUnit;
  readonly currentExpiryValue: bigint;
}

export interface NativeClearingMatchAuthorization {
  readonly version: 1;
  readonly authorizationHash: CommitmentHash;
  readonly policyHash: CommitmentHash;
  readonly allocationHash: CommitmentHash;
  readonly handoffHash: CommitmentHash;
  readonly fillSequence: bigint;
  readonly takerOrderId: CommitmentHash;
  readonly makerEntryId: CommitmentHash;
  readonly longAccountId: ProtocolId;
  readonly longParticipantId: ProtocolId;
  readonly longSettlementCommitmentHash: CommitmentHash;
  readonly shortAccountId: ProtocolId;
  readonly shortParticipantId: ProtocolId;
  readonly shortSettlementCommitmentHash: CommitmentHash;
  readonly quantityAtoms: bigint;
  readonly priceTicks: bigint;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
}

function equalHash(left: Uint8Array, right: Uint8Array): boolean {
  return bytesEqual(left, right);
}

function authorizationBytes(
  input: Omit<NativeClearingMatchAuthorization, 'authorizationHash'>,
): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeCommitmentHash(writer, input.policyHash, 'policyHash');
    encodeCommitmentHash(writer, input.allocationHash, 'allocationHash');
    encodeCommitmentHash(writer, input.handoffHash, 'handoffHash');
    writer.writeU64(input.fillSequence, 'fillSequence');
    encodeCommitmentHash(writer, input.takerOrderId, 'takerOrderId');
    encodeCommitmentHash(writer, input.makerEntryId, 'makerEntryId');
    encodeProtocolId(writer, input.longAccountId, 'longAccountId');
    encodeProtocolId(writer, input.longParticipantId, 'longParticipantId');
    encodeCommitmentHash(writer, input.longSettlementCommitmentHash, 'longSettlementCommitmentHash');
    encodeProtocolId(writer, input.shortAccountId, 'shortAccountId');
    encodeProtocolId(writer, input.shortParticipantId, 'shortParticipantId');
    encodeCommitmentHash(writer, input.shortSettlementCommitmentHash, 'shortSettlementCommitmentHash');
    writer.writeU128(input.quantityAtoms, 'quantityAtoms');
    writer.writeU128(input.priceTicks, 'priceTicks');
    writer.writeEnum(EXPIRY_UNIT, input.validUntilUnit, 'validUntilUnit');
    writer.writeU64(input.validUntilValue, 'validUntilValue');
  });
}

export function nativeClearingMatchAuthorization(
  input: NativeClearingMatchAuthorizationInput,
): NativeClearingMatchAuthorization {
  const policy = nativeClearingPolicy(input.policy);
  const matchingPolicy = packageMatchingPolicy(input.matchingPolicy);
  const allocation = packageAllocation(input.allocation);
  const handoff = packageSettlementHandoff(input.handoff);
  const taker = packageSettlementCommitment(input.takerSettlementCommitment);
  const maker = packageSettlementCommitment(input.makerSettlementCommitment);
  const fillSequence = checkedUnsigned(input.fillSequence, U64_BITS, 'nativeClearingMatchAuthorization.fillSequence');
  const currentExpiryValue = checkedUnsigned(
    input.currentExpiryValue,
    U64_BITS,
    'nativeClearingMatchAuthorization.currentExpiryValue',
  );
  enumDiscriminant(EXPIRY_UNIT, input.currentExpiryUnit, 'nativeClearingMatchAuthorization.currentExpiryUnit');

  if (policy.environment !== matchingPolicy.environment
    || policy.executionClassId !== matchingPolicy.executionClassId
    || !equalHash(policy.matchingPolicyHash, packageMatchingPolicyHash(matchingPolicy))) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.policy', 'clearing policy is not bound to the matching policy');
  }
  verifyPackageAllocation(matchingPolicy, allocation, 'nativeClearingMatchAuthorization.allocation');
  verifyPackageSettlementHandoff(allocation, handoff, 'nativeClearingMatchAuthorization.handoff');
  if (allocation.environment !== policy.environment || allocation.executionClassId !== policy.executionClassId) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.allocation', 'allocation is outside the clearing domain');
  }

  const fillIndex = allocation.fills.findIndex((fill) => fill.fillSequence === fillSequence);
  if (fillIndex < 0) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.fillSequence', 'fill does not exist in the allocation');
  }
  const fill = allocation.fills[fillIndex]!;
  const settlementFill = handoff.fills[fillIndex]!;
  if (fill.makerSource !== 'DIRECT' || settlementFill.makerSettlementCommitmentHash === undefined) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.fillSequence', 'native clearing requires a direct package fill');
  }
  if (fill.priceTicks <= 0n || fill.quantity % policy.packageQuantityIncrementAtoms !== 0n) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.fillSequence', 'fill violates the native clearing price or quantity lattice');
  }

  const takerHash = packageSettlementCommitmentHash(taker);
  const makerHash = packageSettlementCommitmentHash(maker);
  if (!equalHash(handoff.takerSettlementCommitmentHash, takerHash)
    || !equalHash(settlementFill.makerSettlementCommitmentHash, makerHash)) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.commitments', 'settlement commitment hash mismatch');
  }
  if (!equalHash(taker.packageOrderId, allocation.takerOrderId)
    || taker.participantId !== allocation.takerParticipantId
    || !equalHash(maker.packageOrderId, fill.makerEntryId)
    || maker.participantId !== fill.makerParticipantId) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.commitments', 'settlement commitment identity mismatch');
  }
  if (taker.environment !== policy.environment || maker.environment !== policy.environment
    || taker.executionClassId !== policy.executionClassId || maker.executionClassId !== policy.executionClassId
    || !equalHash(taker.strategyOrderHash, maker.strategyOrderHash)
    || !equalHash(taker.graphHash, maker.graphHash)) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.commitments', 'settlement commitments describe different package economics');
  }
  if (taker.quantity < fill.quantity || maker.quantity < fill.quantity) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.commitments', 'settlement commitment quantity is below the fill');
  }
  if (taker.settlementAccount === maker.settlementAccount || taker.participantId === maker.participantId) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.commitments', 'self clearing is prohibited');
  }
  if (taker.validUntilUnit !== maker.validUntilUnit || taker.validUntilUnit !== input.currentExpiryUnit) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.commitments', 'settlement commitment clocks differ');
  }
  const validUntilValue = taker.validUntilValue < maker.validUntilValue
    ? taker.validUntilValue
    : maker.validUntilValue;
  if (currentExpiryValue >= validUntilValue) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.commitments', 'settlement commitment is expired');
  }

  const takerIsLong = allocation.takerSide === 'BID';
  const payload = Object.freeze({
    version: NATIVE_CLEARING_MATCH_AUTHORIZATION_VERSION as 1,
    policyHash: policy.policyHash,
    allocationHash: packageAllocationHash(allocation),
    handoffHash: packageSettlementHandoffHash(handoff),
    fillSequence,
    takerOrderId: allocation.takerOrderId,
    makerEntryId: fill.makerEntryId,
    longAccountId: protocolId(takerIsLong ? taker.settlementAccount : maker.settlementAccount),
    longParticipantId: protocolId(takerIsLong ? taker.participantId : maker.participantId),
    longSettlementCommitmentHash: commitmentHash(takerIsLong ? takerHash : makerHash),
    shortAccountId: protocolId(takerIsLong ? maker.settlementAccount : taker.settlementAccount),
    shortParticipantId: protocolId(takerIsLong ? maker.participantId : taker.participantId),
    shortSettlementCommitmentHash: commitmentHash(takerIsLong ? makerHash : takerHash),
    quantityAtoms: fill.quantity,
    priceTicks: fill.priceTicks,
    validUntilUnit: taker.validUntilUnit,
    validUntilValue,
  });
  const authorizationHash = commitmentHash(
    domainHash(HASH_DOMAIN.NATIVE_CLEARING_MATCH_AUTHORIZATION, authorizationBytes(payload)),
    'nativeClearingMatchAuthorization.authorizationHash',
  );
  return Object.freeze({ ...payload, authorizationHash });
}

export function nativeClearingExecutionId(authorization: NativeClearingMatchAuthorization): ProtocolId {
  return protocolId(toHex(authorization.authorizationHash), 'nativeClearingExecutionId');
}
