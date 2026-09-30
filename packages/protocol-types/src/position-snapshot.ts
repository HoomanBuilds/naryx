import { assertUint8Array, compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, encodeExactPrice, type CommitmentHash } from './package-order-primitives.js';
import {
  NORMALIZED_POSITION_VERSION,
  normalizedPosition,
  PORTFOLIO_MAX_POSITIONS,
  POSITION_TYPE,
  type NormalizedPosition,
  type NormalizedPositionInput,
} from './portfolio-risk.js';
import { encodeDomainRef, encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';

export const POSITION_SNAPSHOT_RECORD_VERSION = 1;
const MAX_UNMAPPED = 64;
const MAX_SIGNATURE_BYTES = 128;

/**
 * One signed, read-only observation of a strategy account's positions from one source. The
 * authority signs the record hash; the signature proves who published the observation, not that
 * the venue reported it, so the record also binds the hash of the raw source response.
 */
export interface PositionSnapshotRecordInput {
  readonly recordVersion: number;
  readonly environment: string;
  readonly strategyAccount: string;
  readonly sourceId: string;
  readonly observedAtMs: bigint;
  readonly positions: readonly NormalizedPositionInput[];
  /** Instruments the account holds that the source could not map; they are excluded from risk, and said so. */
  readonly unmappedInstruments: readonly string[];
  readonly sourceEvidenceHash: Uint8Array | string;
  readonly authority: string;
  readonly signature: Uint8Array;
}

export interface PositionSnapshotRecord {
  readonly recordVersion: number;
  readonly environment: ProtocolId;
  readonly strategyAccount: ProtocolId;
  readonly sourceId: ProtocolId;
  readonly observedAtMs: bigint;
  /** Sorted by snapshot id, so one observation has one encoding. */
  readonly positions: readonly NormalizedPosition[];
  readonly unmappedInstruments: readonly ProtocolId[];
  readonly sourceEvidenceHash: CommitmentHash;
  readonly authority: ProtocolId;
  readonly signature: Uint8Array;
}

function encodePosition(writer: CanonicalWriter, position: NormalizedPosition): void {
  writer.writeU32(position.adapterVersion, 'adapterVersion');
  encodeProtocolId(writer, position.snapshotId, 'snapshotId');
  encodeDomainRef(writer, position.domain);
  writer.writeU64(position.observedAtMs, 'observedAtMs');
  encodeProtocolId(writer, position.owner, 'owner');
  encodeProtocolId(writer, protocolId(position.venueId), 'venueId');
  encodeProtocolId(writer, protocolId(position.marketId), 'marketId');
  encodeProtocolId(writer, position.underlyingId, 'underlyingId');
  writer.writeEnum(POSITION_TYPE, position.positionType, 'positionType');
  writer.writeI128(position.quantityBaseAtoms, 'quantityBaseAtoms');
  encodeExactPrice(writer, position.markPrice);
  writer.writeOptional(position.liquidationPrice, (inner, value) => encodeExactPrice(inner, value), 'liquidationPrice');
  writer.writeOptional(position.collateralQuoteAtoms, (inner, value) => inner.writeU128(value, 'collateralQuoteAtoms'), 'collateralQuoteAtoms');
  writer.writeOptional(
    position.maintenanceRequirementQuoteAtoms,
    (inner, value) => inner.writeU128(value, 'maintenanceRequirementQuoteAtoms'),
    'maintenanceRequirementQuoteAtoms',
  );
  writer.writeArray(position.dependencyIds, (inner, value) => encodeProtocolId(inner, value, 'dependencyId'), 'dependencyIds');
  encodeProtocolId(writer, position.riskDomainId, 'riskDomainId');
  writer.writeArray(
    position.closeRoutes,
    (inner, route) => {
      encodeProtocolId(inner, protocolId(route.routeId), 'routeId');
      inner.writeU128(route.executableQuantityAtoms, 'executableQuantityAtoms');
      inner.writeU128(route.expectedCostQuoteAtoms, 'expectedCostQuoteAtoms');
      inner.writeU64(route.settlementDelayMs, 'settlementDelayMs');
      inner.writeBool(route.authorityHeld, 'authorityHeld');
      inner.writeOptional(route.atomicGroupId, (group, value) => encodeProtocolId(group, protocolId(value), 'atomicGroupId'), 'atomicGroupId');
      inner.writeArray(route.requiredDependencyIds, (dependency, value) => encodeProtocolId(dependency, protocolId(value), 'requiredDependencyId'), 'requiredDependencyIds');
    },
    'closeRoutes',
  );
}

export function positionSnapshotRecord(input: PositionSnapshotRecordInput, context = 'positionSnapshotRecord'): PositionSnapshotRecord {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError(context, 'expected an object');
  if (input.recordVersion !== POSITION_SNAPSHOT_RECORD_VERSION) {
    throw new MalformedInputError(`${context}.recordVersion`, `version must equal ${POSITION_SNAPSHOT_RECORD_VERSION}`);
  }
  const strategyAccount = protocolId(input.strategyAccount, `${context}.strategyAccount`);
  if (typeof input.observedAtMs !== 'bigint' || input.observedAtMs < 0n || input.observedAtMs >= 1n << 64n) {
    throw new MalformedInputError(`${context}.observedAtMs`, 'expected a u64 millisecond time');
  }
  if (!Array.isArray(input.positions) || input.positions.length > PORTFOLIO_MAX_POSITIONS) {
    throw new MalformedInputError(`${context}.positions`, `expected at most ${PORTFOLIO_MAX_POSITIONS} positions`);
  }
  const positions = input.positions
    .map((position, index) => normalizedPosition(position, `${context}.positions[${index}]`))
    .sort((left, right) => (left.snapshotId < right.snapshotId ? -1 : left.snapshotId > right.snapshotId ? 1 : 0));
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index] as NormalizedPosition;
    if (position.adapterVersion !== NORMALIZED_POSITION_VERSION) throw new MalformedInputError(`${context}.positions`, 'unsupported adapter version');
    if (position.owner !== strategyAccount) throw new MalformedInputError(`${context}.positions`, `position ${position.snapshotId} belongs to another account`);
    if (position.observedAtMs > input.observedAtMs) throw new MalformedInputError(`${context}.positions`, `position ${position.snapshotId} was observed after the snapshot`);
    if (index > 0 && (positions[index - 1] as NormalizedPosition).snapshotId === position.snapshotId) {
      throw new DuplicateElementError(`${context}.positions`, 'snapshot ids repeat');
    }
  }
  if (!Array.isArray(input.unmappedInstruments) || input.unmappedInstruments.length > MAX_UNMAPPED) {
    throw new MalformedInputError(`${context}.unmappedInstruments`, `expected at most ${MAX_UNMAPPED} instruments`);
  }
  const unmapped = input.unmappedInstruments.map((value, index) => protocolId(value, `${context}.unmappedInstruments[${index}]`)).sort();
  if (new Set(unmapped).size !== unmapped.length) throw new DuplicateElementError(`${context}.unmappedInstruments`, 'instruments repeat');
  assertUint8Array(input.signature, `${context}.signature`);
  if (input.signature.length > MAX_SIGNATURE_BYTES) throw new MalformedInputError(`${context}.signature`, 'signature is too long');
  return Object.freeze({
    recordVersion: POSITION_SNAPSHOT_RECORD_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    strategyAccount,
    sourceId: protocolId(input.sourceId, `${context}.sourceId`),
    observedAtMs: input.observedAtMs,
    positions: Object.freeze(positions),
    unmappedInstruments: Object.freeze(unmapped),
    sourceEvidenceHash: commitmentHash(input.sourceEvidenceHash, `${context}.sourceEvidenceHash`),
    authority: protocolId(input.authority, `${context}.authority`),
    signature: Uint8Array.from(input.signature),
  });
}

/** Every record field except the signature, which signs this hash. */
export function positionSnapshotRecordBytes(input: PositionSnapshotRecordInput): Uint8Array {
  const record = positionSnapshotRecord(input);
  return canonicalBytes((writer) => {
    writer.writeU32(record.recordVersion, 'recordVersion');
    encodeProtocolId(writer, record.environment, 'environment');
    encodeProtocolId(writer, record.strategyAccount, 'strategyAccount');
    encodeProtocolId(writer, record.sourceId, 'sourceId');
    writer.writeU64(record.observedAtMs, 'observedAtMs');
    writer.writeArray(record.positions, encodePosition, 'positions');
    writer.writeArray(record.unmappedInstruments, (inner, value) => encodeProtocolId(inner, value, 'unmappedInstrument'), 'unmappedInstruments');
    encodeCommitmentHash(writer, record.sourceEvidenceHash, 'sourceEvidenceHash');
    encodeProtocolId(writer, record.authority, 'authority');
  });
}

export function positionSnapshotRecordHash(input: PositionSnapshotRecordInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.POSITION_SNAPSHOT, positionSnapshotRecordBytes(input)), 'positionSnapshotRecordHash');
}

/** True when two records carry the same observation, whatever order their positions arrived in. */
export function samePositionSnapshot(left: PositionSnapshotRecordInput, right: PositionSnapshotRecordInput): boolean {
  return compareBytes(positionSnapshotRecordHash(left), positionSnapshotRecordHash(right)) === 0;
}
