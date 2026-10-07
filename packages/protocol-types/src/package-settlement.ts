import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { bytesEqual, compareBytes, toHex } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { enumDiscriminant, EXPIRY_UNIT, type ExpiryUnit } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  PACKAGE_LIQUIDITY_SOURCE,
  packageAllocation,
  packageAllocationHash,
  type PackageAllocation,
  type PackageLiquiditySource,
} from './package-matching.js';
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

export const PACKAGE_SETTLEMENT_COMMITMENT_VERSION = 1;
export const PACKAGE_SETTLEMENT_HANDOFF_VERSION = 1;
export const PACKAGE_SETTLEMENT_READINESS_VERSION = 2;
export const PACKAGE_SETTLEMENT_MAX_FILLS = 2_000;
export const PACKAGE_SETTLEMENT_MAX_EVIDENCE = 4_096;
export const PACKAGE_SETTLEMENT_MAX_ALLOCATIONS = PACKAGE_SETTLEMENT_MAX_EVIDENCE;

export const PACKAGE_SETTLEMENT_EVIDENCE_KIND = Object.freeze({
  CONTINUOUS_ALLOCATION: 1,
  REOPENING_RESULT: 2,
} as const);
export type PackageSettlementEvidenceKind = keyof typeof PACKAGE_SETTLEMENT_EVIDENCE_KIND;

export const PACKAGE_SETTLEMENT_READINESS_STATUS = Object.freeze({
  AWAITING_MATCH: 1,
  PARTIALLY_ALLOCATED: 2,
  PARTIAL_AUTHORIZATION_REQUIRED: 3,
  READY_FOR_OWNER_AUTHORIZATION: 4,
  CANCELLED_UNFILLED: 5,
} as const);
export type PackageSettlementReadinessStatus = keyof typeof PACKAGE_SETTLEMENT_READINESS_STATUS;

const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;

export interface PackageSettlementCommitmentInput {
  readonly version: number;
  readonly environment: string;
  readonly executionClassId: string;
  readonly packageOrderId: Uint8Array | string;
  readonly strategyOrderHash: Uint8Array | string;
  readonly graphHash: Uint8Array | string;
  readonly participantId: string;
  readonly settlementAccount: string;
  readonly quantity: bigint;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
}

export interface PackageSettlementCommitment extends Omit<
  PackageSettlementCommitmentInput,
  | 'environment'
  | 'executionClassId'
  | 'packageOrderId'
  | 'strategyOrderHash'
  | 'graphHash'
  | 'participantId'
  | 'settlementAccount'
> {
  readonly version: 1;
  readonly environment: ProtocolId;
  readonly executionClassId: ProtocolId;
  readonly packageOrderId: CommitmentHash;
  readonly strategyOrderHash: CommitmentHash;
  readonly graphHash: CommitmentHash;
  readonly participantId: ProtocolId;
  readonly settlementAccount: ProtocolId;
}

export interface PackageSettlementFillInput {
  readonly fillSequence: bigint;
  readonly makerEntryId: Uint8Array | string;
  readonly makerSource: PackageLiquiditySource;
  readonly priceTicks: bigint;
  readonly quantity: bigint;
  readonly makerSettlementCommitmentHash?: Uint8Array | string;
}

export interface PackageSettlementFill extends Omit<
  PackageSettlementFillInput,
  'makerEntryId' | 'makerSettlementCommitmentHash'
> {
  readonly makerEntryId: CommitmentHash;
  readonly makerSettlementCommitmentHash?: CommitmentHash;
}

export interface PackageSettlementHandoffInput {
  readonly version: number;
  readonly allocationHash: Uint8Array | string;
  readonly executionClassId: string;
  readonly takerSettlementCommitmentHash: Uint8Array | string;
  readonly fills: readonly PackageSettlementFillInput[];
}

export interface PackageSettlementHandoff extends Omit<
  PackageSettlementHandoffInput,
  'allocationHash' | 'executionClassId' | 'takerSettlementCommitmentHash' | 'fills'
> {
  readonly version: 1;
  readonly allocationHash: CommitmentHash;
  readonly executionClassId: ProtocolId;
  readonly takerSettlementCommitmentHash: CommitmentHash;
  readonly fills: readonly PackageSettlementFill[];
}

export interface PackageSettlementReadinessInput {
  readonly version: number;
  readonly packageOrderId: Uint8Array | string;
  readonly settlementCommitmentHash: Uint8Array | string;
  readonly strategyOrderHash: Uint8Array | string;
  readonly executionClassId: string;
  readonly committedQuantity: bigint;
  readonly allocatedQuantity: bigint;
  readonly remainingQuantity: bigint;
  readonly acceptsFurtherMatches: boolean;
  readonly status: PackageSettlementReadinessStatus;
  readonly evidenceRefs: readonly PackageSettlementEvidenceRefInput[];
}

export interface PackageSettlementReadiness extends Omit<
  PackageSettlementReadinessInput,
  'packageOrderId' | 'settlementCommitmentHash' | 'strategyOrderHash' | 'executionClassId' | 'evidenceRefs'
> {
  readonly version: 2;
  readonly packageOrderId: CommitmentHash;
  readonly settlementCommitmentHash: CommitmentHash;
  readonly strategyOrderHash: CommitmentHash;
  readonly executionClassId: ProtocolId;
  readonly evidenceRefs: readonly PackageSettlementEvidenceRef[];
}

export interface PackageSettlementEvidenceRefInput {
  readonly kind: PackageSettlementEvidenceKind;
  readonly evidenceHash: Uint8Array | string;
}

export interface PackageSettlementEvidenceRef {
  readonly kind: PackageSettlementEvidenceKind;
  readonly evidenceHash: CommitmentHash;
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an object');
  }
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function version(value: number, expected: number, context: string): number {
  if (typeof value !== 'number') throw new MalformedInputError(context, 'expected a number');
  const checked = Number(checkedUnsigned(value, U32_BITS, context));
  if (checked !== expected) throw new MalformedInputError(context, `version must equal ${expected}`);
  return checked;
}

export function packageSettlementCommitment(
  input: PackageSettlementCommitmentInput,
  context = 'packageSettlementCommitment',
): PackageSettlementCommitment {
  object(input, context);
  version(input.version, PACKAGE_SETTLEMENT_COMMITMENT_VERSION, `${context}.version`);
  const quantity = unsigned(input.quantity, U128_BITS, `${context}.quantity`);
  const validUntilValue = unsigned(input.validUntilValue, U64_BITS, `${context}.validUntilValue`);
  if (quantity === 0n) throw new MalformedInputError(`${context}.quantity`, 'quantity is zero');
  if (validUntilValue === 0n) throw new MalformedInputError(`${context}.validUntilValue`, 'expiry is zero');
  enumDiscriminant(EXPIRY_UNIT, input.validUntilUnit, `${context}.validUntilUnit`);
  return Object.freeze({
    version: PACKAGE_SETTLEMENT_COMMITMENT_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    packageOrderId: commitmentHash(input.packageOrderId, `${context}.packageOrderId`),
    strategyOrderHash: commitmentHash(input.strategyOrderHash, `${context}.strategyOrderHash`),
    graphHash: commitmentHash(input.graphHash, `${context}.graphHash`),
    participantId: protocolId(input.participantId, `${context}.participantId`),
    settlementAccount: protocolId(input.settlementAccount, `${context}.settlementAccount`),
    quantity,
    validUntilUnit: input.validUntilUnit,
    validUntilValue,
  });
}

export function packageSettlementCommitmentBytes(
  input: PackageSettlementCommitmentInput,
  context = 'packageSettlementCommitment',
): Uint8Array {
  const commitment = packageSettlementCommitment(input, context);
  return canonicalBytes((writer) => {
    writer.writeU32(commitment.version, `${context}.version`);
    encodeProtocolId(writer, commitment.environment, `${context}.environment`);
    encodeProtocolId(writer, commitment.executionClassId, `${context}.executionClassId`);
    encodeCommitmentHash(writer, commitment.packageOrderId, `${context}.packageOrderId`);
    encodeCommitmentHash(writer, commitment.strategyOrderHash, `${context}.strategyOrderHash`);
    encodeCommitmentHash(writer, commitment.graphHash, `${context}.graphHash`);
    encodeProtocolId(writer, commitment.participantId, `${context}.participantId`);
    encodeProtocolId(writer, commitment.settlementAccount, `${context}.settlementAccount`);
    writer.writeU128(commitment.quantity, `${context}.quantity`);
    writer.writeEnum(EXPIRY_UNIT, commitment.validUntilUnit, `${context}.validUntilUnit`);
    writer.writeU64(commitment.validUntilValue, `${context}.validUntilValue`);
  });
}

export function packageSettlementCommitmentHash(
  input: PackageSettlementCommitmentInput,
): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.PACKAGE_SETTLEMENT_COMMITMENT, packageSettlementCommitmentBytes(input)),
    'packageSettlementCommitmentHash',
  );
}

function settlementFill(input: PackageSettlementFillInput, context: string): PackageSettlementFill {
  object(input, context);
  enumDiscriminant(PACKAGE_LIQUIDITY_SOURCE, input.makerSource, `${context}.makerSource`);
  if (typeof input.priceTicks !== 'bigint') throw new MalformedInputError(`${context}.priceTicks`, 'expected a bigint');
  const priceTicks = checkedSigned(input.priceTicks, I128_BITS, `${context}.priceTicks`);
  const quantity = unsigned(input.quantity, U128_BITS, `${context}.quantity`);
  if (quantity === 0n) throw new MalformedInputError(`${context}.quantity`, 'quantity is zero');
  const makerSettlementCommitmentHash = input.makerSettlementCommitmentHash === undefined
    ? undefined
    : commitmentHash(input.makerSettlementCommitmentHash, `${context}.makerSettlementCommitmentHash`);
  if ((input.makerSource === 'DIRECT') !== (makerSettlementCommitmentHash !== undefined)) {
    throw new MalformedInputError(
      `${context}.makerSettlementCommitmentHash`,
      'a direct fill requires one settlement commitment and an implied fill must not carry one',
    );
  }
  return Object.freeze({
    fillSequence: unsigned(input.fillSequence, U64_BITS, `${context}.fillSequence`),
    makerEntryId: commitmentHash(input.makerEntryId, `${context}.makerEntryId`),
    makerSource: input.makerSource,
    priceTicks,
    quantity,
    ...(makerSettlementCommitmentHash === undefined ? {} : { makerSettlementCommitmentHash }),
  });
}

function encodeSettlementFill(writer: CanonicalWriter, value: PackageSettlementFill, context: string): void {
  writer.writeU64(value.fillSequence, `${context}.fillSequence`);
  encodeCommitmentHash(writer, value.makerEntryId, `${context}.makerEntryId`);
  writer.writeEnum(PACKAGE_LIQUIDITY_SOURCE, value.makerSource, `${context}.makerSource`);
  writer.writeI128(value.priceTicks, `${context}.priceTicks`);
  writer.writeU128(value.quantity, `${context}.quantity`);
  writer.writeOptional(
    value.makerSettlementCommitmentHash,
    (element, hash) => encodeCommitmentHash(element, hash, `${context}.makerSettlementCommitmentHash`),
    `${context}.makerSettlementCommitmentHash`,
  );
}

export function packageSettlementHandoff(
  input: PackageSettlementHandoffInput,
  context = 'packageSettlementHandoff',
): PackageSettlementHandoff {
  object(input, context);
  version(input.version, PACKAGE_SETTLEMENT_HANDOFF_VERSION, `${context}.version`);
  if (!Array.isArray(input.fills) || input.fills.length === 0 || input.fills.length > PACKAGE_SETTLEMENT_MAX_FILLS) {
    throw new MalformedInputError(`${context}.fills`, `expected 1 to ${PACKAGE_SETTLEMENT_MAX_FILLS} fills`);
  }
  const fills = input.fills.map((fill, index) => settlementFill(fill, `${context}.fills[${index}]`));
  const entryIds = new Set<string>();
  for (const fill of fills) {
    const key = toHex(fill.makerEntryId);
    if (entryIds.has(key)) throw new DuplicateElementError(`${context}.fills`, 'maker entry repeats');
    entryIds.add(key);
  }
  return Object.freeze({
    version: PACKAGE_SETTLEMENT_HANDOFF_VERSION,
    allocationHash: commitmentHash(input.allocationHash, `${context}.allocationHash`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    takerSettlementCommitmentHash: commitmentHash(
      input.takerSettlementCommitmentHash,
      `${context}.takerSettlementCommitmentHash`,
    ),
    fills: Object.freeze(fills),
  });
}

export function packageSettlementHandoffBytes(
  input: PackageSettlementHandoffInput,
  context = 'packageSettlementHandoff',
): Uint8Array {
  const handoff = packageSettlementHandoff(input, context);
  return canonicalBytes((writer) => {
    writer.writeU32(handoff.version, `${context}.version`);
    encodeCommitmentHash(writer, handoff.allocationHash, `${context}.allocationHash`);
    encodeProtocolId(writer, handoff.executionClassId, `${context}.executionClassId`);
    encodeCommitmentHash(
      writer,
      handoff.takerSettlementCommitmentHash,
      `${context}.takerSettlementCommitmentHash`,
    );
    writer.writeArray(
      handoff.fills,
      (element, fill) => encodeSettlementFill(element, fill, `${context}.fills`),
      `${context}.fills`,
    );
  });
}

export function packageSettlementHandoffHash(input: PackageSettlementHandoffInput): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.PACKAGE_SETTLEMENT_HANDOFF, packageSettlementHandoffBytes(input)),
    'packageSettlementHandoffHash',
  );
}

export function packageSettlementReadiness(
  input: PackageSettlementReadinessInput,
  context = 'packageSettlementReadiness',
): PackageSettlementReadiness {
  object(input, context);
  version(input.version, PACKAGE_SETTLEMENT_READINESS_VERSION, `${context}.version`);
  if (typeof input.acceptsFurtherMatches !== 'boolean') {
    throw new MalformedInputError(`${context}.acceptsFurtherMatches`, 'expected a boolean');
  }
  enumDiscriminant(PACKAGE_SETTLEMENT_READINESS_STATUS, input.status, `${context}.status`);
  const committedQuantity = unsigned(input.committedQuantity, U128_BITS, `${context}.committedQuantity`);
  const allocatedQuantity = unsigned(input.allocatedQuantity, U128_BITS, `${context}.allocatedQuantity`);
  const remainingQuantity = unsigned(input.remainingQuantity, U128_BITS, `${context}.remainingQuantity`);
  if (committedQuantity === 0n || allocatedQuantity + remainingQuantity !== committedQuantity) {
    throw new MalformedInputError(context, 'settlement quantities do not conserve the commitment');
  }
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > PACKAGE_SETTLEMENT_MAX_EVIDENCE) {
    throw new MalformedInputError(
      `${context}.evidenceRefs`,
      `expected at most ${PACKAGE_SETTLEMENT_MAX_EVIDENCE} settlement evidence references`,
    );
  }
  const evidenceRefs = (input.evidenceRefs as readonly PackageSettlementEvidenceRefInput[])
    .map((reference, index) => {
      object(reference, `${context}.evidenceRefs[${index}]`);
      enumDiscriminant(PACKAGE_SETTLEMENT_EVIDENCE_KIND, reference.kind, `${context}.evidenceRefs[${index}].kind`);
      return Object.freeze({
        kind: reference.kind,
        evidenceHash: commitmentHash(reference.evidenceHash, `${context}.evidenceRefs[${index}].evidenceHash`),
      });
    })
    .sort((left, right) => {
      const kind = PACKAGE_SETTLEMENT_EVIDENCE_KIND[left.kind] - PACKAGE_SETTLEMENT_EVIDENCE_KIND[right.kind];
      return kind === 0 ? compareBytes(left.evidenceHash, right.evidenceHash) : kind;
    });
  for (let index = 1; index < evidenceRefs.length; index += 1) {
    const previous = evidenceRefs[index - 1]!;
    const current = evidenceRefs[index]!;
    if (previous.kind === current.kind && bytesEqual(previous.evidenceHash, current.evidenceHash)) {
      throw new DuplicateElementError(`${context}.evidenceRefs`, 'settlement evidence repeats');
    }
  }
  if ((allocatedQuantity === 0n) !== (evidenceRefs.length === 0)) {
    throw new MalformedInputError(`${context}.evidenceRefs`, 'settlement evidence and allocated quantity disagree');
  }
  const stateValid =
    (input.status === 'AWAITING_MATCH' && allocatedQuantity === 0n && remainingQuantity > 0n && input.acceptsFurtherMatches)
    || (input.status === 'PARTIALLY_ALLOCATED' && allocatedQuantity > 0n && remainingQuantity > 0n && input.acceptsFurtherMatches)
    || (input.status === 'PARTIAL_AUTHORIZATION_REQUIRED' && allocatedQuantity > 0n && remainingQuantity > 0n && !input.acceptsFurtherMatches)
    || (input.status === 'READY_FOR_OWNER_AUTHORIZATION' && allocatedQuantity === committedQuantity && remainingQuantity === 0n && !input.acceptsFurtherMatches)
    || (input.status === 'CANCELLED_UNFILLED' && allocatedQuantity === 0n && remainingQuantity === committedQuantity && !input.acceptsFurtherMatches);
  if (!stateValid) throw new MalformedInputError(`${context}.status`, 'status does not match settlement progress');
  return Object.freeze({
    version: PACKAGE_SETTLEMENT_READINESS_VERSION,
    packageOrderId: commitmentHash(input.packageOrderId, `${context}.packageOrderId`),
    settlementCommitmentHash: commitmentHash(input.settlementCommitmentHash, `${context}.settlementCommitmentHash`),
    strategyOrderHash: commitmentHash(input.strategyOrderHash, `${context}.strategyOrderHash`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    committedQuantity,
    allocatedQuantity,
    remainingQuantity,
    acceptsFurtherMatches: input.acceptsFurtherMatches,
    status: input.status,
    evidenceRefs: Object.freeze(evidenceRefs),
  });
}

export function packageSettlementReadinessBytes(
  input: PackageSettlementReadinessInput,
  context = 'packageSettlementReadiness',
): Uint8Array {
  const readiness = packageSettlementReadiness(input, context);
  return canonicalBytes((writer) => {
    writer.writeU32(readiness.version, `${context}.version`);
    encodeCommitmentHash(writer, readiness.packageOrderId, `${context}.packageOrderId`);
    encodeCommitmentHash(writer, readiness.settlementCommitmentHash, `${context}.settlementCommitmentHash`);
    encodeCommitmentHash(writer, readiness.strategyOrderHash, `${context}.strategyOrderHash`);
    encodeProtocolId(writer, readiness.executionClassId, `${context}.executionClassId`);
    writer.writeU128(readiness.committedQuantity, `${context}.committedQuantity`);
    writer.writeU128(readiness.allocatedQuantity, `${context}.allocatedQuantity`);
    writer.writeU128(readiness.remainingQuantity, `${context}.remainingQuantity`);
    writer.writeBool(readiness.acceptsFurtherMatches, `${context}.acceptsFurtherMatches`);
    writer.writeEnum(PACKAGE_SETTLEMENT_READINESS_STATUS, readiness.status, `${context}.status`);
    writer.writeArray(readiness.evidenceRefs, (element, reference) => {
      element.writeEnum(PACKAGE_SETTLEMENT_EVIDENCE_KIND, reference.kind, `${context}.evidenceRefs.kind`);
      encodeCommitmentHash(element, reference.evidenceHash, `${context}.evidenceRefs.evidenceHash`);
    }, `${context}.evidenceRefs`);
  });
}

export function packageSettlementReadinessHash(input: PackageSettlementReadinessInput): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.PACKAGE_SETTLEMENT_READINESS, packageSettlementReadinessBytes(input)),
    'packageSettlementReadinessHash',
  );
}

export function verifyPackageSettlementHandoff(
  allocationInput: PackageAllocation,
  handoffInput: PackageSettlementHandoffInput,
  context = 'verifyPackageSettlementHandoff',
): void {
  const allocation = packageAllocation(allocationInput, `${context}.allocation`);
  const handoff = packageSettlementHandoff(handoffInput, `${context}.handoff`);
  if (!bytesEqual(handoff.allocationHash, packageAllocationHash(allocation))) {
    throw new MalformedInputError(context, 'handoff cites another allocation');
  }
  if (handoff.executionClassId !== allocation.executionClassId) {
    throw new MalformedInputError(context, 'handoff cites another execution class');
  }
  if (handoff.fills.length !== allocation.fills.length) {
    throw new MalformedInputError(context, 'handoff fill count differs from the allocation');
  }
  for (let index = 0; index < allocation.fills.length; index += 1) {
    const fill = allocation.fills[index]!;
    const binding = handoff.fills[index]!;
    if (
      fill.fillSequence !== binding.fillSequence
      || !bytesEqual(fill.makerEntryId, binding.makerEntryId)
      || fill.makerSource !== binding.makerSource
      || fill.priceTicks !== binding.priceTicks
      || fill.quantity !== binding.quantity
    ) {
      throw new MalformedInputError(`${context}.fills[${index}]`, 'handoff fill differs from the allocation');
    }
  }
}
