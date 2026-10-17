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
  nativeClearingAccount,
  nativeClearingPolicy,
  type NativeClearingAccount,
  type NativeClearingPolicy,
} from './native-package-clearing.js';
import { packageGraph, packageGraphHash, type PackageGraphInput } from './package-graph.js';

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
  readonly takerGraph?: PackageGraphInput;
  readonly makerGraph?: PackageGraphInput;
  readonly takerClearingAccount?: NativeClearingAccount;
  readonly makerClearingAccount?: NativeClearingAccount;
}

function verifyEconomicUnit(
  input: NativeClearingMatchAuthorizationInput,
  policy: NativeClearingPolicy,
  taker: PackageSettlementCommitment,
  maker: PackageSettlementCommitment,
): void {
  if (input.takerGraph === undefined && input.makerGraph === undefined && equalHash(taker.graphHash, maker.graphHash)) {
    return;
  }
  if (input.takerGraph === undefined || input.makerGraph === undefined) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.graphs', 'different owner graphs require both original economic-unit witnesses');
  }
  const graphs = [packageGraph(input.takerGraph), packageGraph(input.makerGraph)];
  for (const [index, commitment] of [taker, maker].entries()) {
    const graph = graphs[index]!;
    if (!equalHash(packageGraphHash(graph), commitment.graphHash) || graph.owner !== commitment.participantId
      || graph.strategyAccountRefs.length !== 1 || graph.strategyAccountRefs[0] !== commitment.settlementAccount
      || graph.environment !== policy.environment || graph.executionClassId !== policy.executionClassId
      || graph.seriesId !== policy.strategySeries.subjectId || graph.seriesVersion !== policy.strategySeries.manifestVersion
      || !equalHash(graph.seriesManifestHash, policy.strategySeries.manifestHash)
      || graph.settlementClass !== 'ATOMIC_POSTCONDITION' || graph.recoverySlots.length !== 0
      || graph.expiryUnit !== commitment.validUntilUnit || graph.packageExpiryValue < commitment.validUntilValue) {
      throw new MalformedInputError('nativeClearingMatchAuthorization.graphs', 'economic-unit witness differs from its signed owner, series or clearing class');
    }
  }
  const neutralHash = commitmentHash(new Uint8Array(32).fill(1));
  const unitHash = (graph: ReturnType<typeof packageGraph>) => packageGraphHash({ ...graph,
    owner: 'native-clearing-economic-unit', strategyAccountRefs: ['native-clearing-economic-unit'], nonce: 0n,
    policyHashes: { netting: neutralHash, privacy: neutralHash, solver: neutralHash, delivery: neutralHash, resource: neutralHash, portfolioRiskLimits: neutralHash },
  });
  if (!equalHash(unitHash(graphs[0]!), unitHash(graphs[1]!))) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.graphs', 'different package economics');
  }
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
    || taker.executionClassId !== policy.executionClassId || maker.executionClassId !== policy.executionClassId) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.commitments', 'settlement commitments describe different package economics');
  }
  verifyEconomicUnit(input, policy, taker, maker);
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

  if ((input.takerClearingAccount === undefined) !== (input.makerClearingAccount === undefined)) {
    throw new MalformedInputError('nativeClearingMatchAuthorization.accounts', 'both native clearing account bindings are required');
  }
  let takerAccountId = taker.settlementAccount;
  let makerAccountId = maker.settlementAccount;
  if (input.takerClearingAccount !== undefined && input.makerClearingAccount !== undefined) {
    const takerAccount = nativeClearingAccount(input.takerClearingAccount, policy);
    const makerAccount = nativeClearingAccount(input.makerClearingAccount, policy);
    if (takerAccount.ownerId !== taker.participantId || makerAccount.ownerId !== maker.participantId
      || takerAccount.accountId === makerAccount.accountId) {
      throw new MalformedInputError('nativeClearingMatchAuthorization.accounts', 'native clearing accounts differ from the consenting package owners');
    }
    takerAccountId = takerAccount.accountId;
    makerAccountId = makerAccount.accountId;
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
    longAccountId: protocolId(takerIsLong ? takerAccountId : makerAccountId),
    longParticipantId: protocolId(takerIsLong ? taker.participantId : maker.participantId),
    longSettlementCommitmentHash: commitmentHash(takerIsLong ? takerHash : makerHash),
    shortAccountId: protocolId(takerIsLong ? makerAccountId : takerAccountId),
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
