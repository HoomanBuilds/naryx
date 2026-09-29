import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { assertUint8Array, compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  EXPIRY_UNIT,
  QUOTE_MODE,
  SETTLEMENT_CLASS,
  type EnumTable,
  type ExpiryUnit,
  type QuoteMode,
  type SettlementClass,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { PACKAGE_BOOK_SIDE, type PackageBookSide } from './package-matching.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { domainRef, encodeDomainRef, encodeProtocolId, protocolId, type DomainRef, type ProtocolId } from './primitives.js';

export const QUOTE_SHARD_VERSION = 1;
export const QUOTE_SHARD_MAX_LEVELS = 64;
const MAX_SIGNATURE_BYTES = 128;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;

export const KILL_SWITCH_STATE = Object.freeze({ INACTIVE: 1, ACTIVE: 2 } as const);
export type KillSwitchState = keyof typeof KILL_SWITCH_STATE;

export const RESERVATION_POLICY = Object.freeze({
  NONE: 1,
  RESERVE_ON_ACCEPT: 2,
  PRE_RESERVED: 3,
} as const);
export type ReservationPolicy = keyof typeof RESERVATION_POLICY;

export interface PackageQuoteLevel {
  readonly levelId: bigint;
  readonly direction: PackageBookSide;
  readonly size: bigint;
  /** Signed ticks from the shard's reference state; one reference update reprices every level. */
  readonly referenceOffset: bigint;
  readonly maximumFee: bigint;
  readonly settlementClass: SettlementClass;
  readonly quoteMode: QuoteMode;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly reservationPolicy: ReservationPolicy;
}

export interface PackageQuoteShardInput {
  readonly shardVersion: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly solverId: string;
  readonly templateId: string;
  readonly marketGroupId: string;
  readonly referenceStateHash: Uint8Array | string;
  readonly referenceSequence: bigint;
  readonly quoteLevels: readonly PackageQuoteLevel[];
  readonly inventoryCap: bigint;
  readonly reservedCapacity: bigint;
  readonly heartbeatExpiry: bigint;
  readonly shardSequence: bigint;
  readonly killSwitchState: KillSwitchState;
  readonly signature: Uint8Array;
}

export interface PackageQuoteShard extends Omit<PackageQuoteShardInput, 'environment' | 'solverId' | 'templateId' | 'marketGroupId' | 'referenceStateHash'> {
  readonly environment: ProtocolId;
  readonly solverId: ProtocolId;
  readonly templateId: ProtocolId;
  readonly marketGroupId: ProtocolId;
  readonly referenceStateHash: CommitmentHash;
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function checkedLevel(level: PackageQuoteLevel, context: string): PackageQuoteLevel {
  object(level, context);
  const size = unsigned(level.size, U128_BITS, `${context}.size`);
  if (size === 0n) throw new MalformedInputError(`${context}.size`, 'level size is zero');
  if (typeof level.referenceOffset !== 'bigint') throw new MalformedInputError(`${context}.referenceOffset`, 'expected a bigint');
  return Object.freeze({
    levelId: unsigned(level.levelId, U64_BITS, `${context}.levelId`),
    direction: variant(PACKAGE_BOOK_SIDE, level.direction, `${context}.direction`),
    size,
    referenceOffset: checkedSigned(level.referenceOffset, I128_BITS, `${context}.referenceOffset`),
    maximumFee: unsigned(level.maximumFee, U128_BITS, `${context}.maximumFee`),
    settlementClass: variant(SETTLEMENT_CLASS, level.settlementClass, `${context}.settlementClass`),
    quoteMode: variant(QUOTE_MODE, level.quoteMode, `${context}.quoteMode`),
    validUntilUnit: variant(EXPIRY_UNIT, level.validUntilUnit, `${context}.validUntilUnit`),
    validUntilValue: unsigned(level.validUntilValue, U64_BITS, `${context}.validUntilValue`),
    reservationPolicy: variant(RESERVATION_POLICY, level.reservationPolicy, `${context}.reservationPolicy`),
  });
}

export function packageQuoteShard(input: PackageQuoteShardInput, context = 'packageQuoteShard'): PackageQuoteShard {
  object(input, context);
  if (input.shardVersion !== QUOTE_SHARD_VERSION) throw new MalformedInputError(`${context}.shardVersion`, `version must equal ${QUOTE_SHARD_VERSION}`);
  if (!Array.isArray(input.quoteLevels) || input.quoteLevels.length > QUOTE_SHARD_MAX_LEVELS) {
    throw new MalformedInputError(`${context}.quoteLevels`, `expected at most ${QUOTE_SHARD_MAX_LEVELS} levels`);
  }
  const levels = input.quoteLevels.map((level, index) => checkedLevel(level, `${context}.quoteLevels[${index}]`)).sort((a, b) => (a.levelId < b.levelId ? -1 : 1));
  for (let index = 1; index < levels.length; index += 1) {
    if ((levels[index - 1] as PackageQuoteLevel).levelId === (levels[index] as PackageQuoteLevel).levelId) {
      throw new DuplicateElementError(`${context}.quoteLevels`, 'level ids repeat');
    }
  }
  const bids = levels.filter((level) => level.direction === 'BID').map((level) => level.referenceOffset);
  const asks = levels.filter((level) => level.direction === 'ASK').map((level) => level.referenceOffset);
  // Offsets share one reference, so a self-crossing shard would cross at every reference state.
  if (bids.length > 0 && asks.length > 0 && bids.reduce((a, b) => (a > b ? a : b)) >= asks.reduce((a, b) => (a < b ? a : b))) {
    throw new MalformedInputError(`${context}.quoteLevels`, 'the shard crosses itself');
  }
  const inventoryCap = unsigned(input.inventoryCap, U128_BITS, `${context}.inventoryCap`);
  const reservedCapacity = unsigned(input.reservedCapacity, U128_BITS, `${context}.reservedCapacity`);
  if (reservedCapacity > inventoryCap) throw new MalformedInputError(`${context}.reservedCapacity`, 'reserved capacity exceeds the inventory cap');
  object(input.domain, `${context}.domain`);
  assertUint8Array(input.signature, `${context}.signature`);
  if (input.signature.length > MAX_SIGNATURE_BYTES) throw new MalformedInputError(`${context}.signature`, 'signature is too long');
  return Object.freeze({
    shardVersion: QUOTE_SHARD_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    domain: domainRef(input.domain.domainId, input.domain.domainManifestVersion, input.domain.domainManifestHash, `${context}.domain`),
    solverId: protocolId(input.solverId, `${context}.solverId`),
    templateId: protocolId(input.templateId, `${context}.templateId`),
    marketGroupId: protocolId(input.marketGroupId, `${context}.marketGroupId`),
    referenceStateHash: commitmentHash(input.referenceStateHash, `${context}.referenceStateHash`),
    referenceSequence: unsigned(input.referenceSequence, U64_BITS, `${context}.referenceSequence`),
    quoteLevels: Object.freeze(levels),
    inventoryCap,
    reservedCapacity,
    heartbeatExpiry: unsigned(input.heartbeatExpiry, U64_BITS, `${context}.heartbeatExpiry`),
    shardSequence: unsigned(input.shardSequence, U64_BITS, `${context}.shardSequence`),
    killSwitchState: variant(KILL_SWITCH_STATE, input.killSwitchState, `${context}.killSwitchState`),
    signature: Uint8Array.from(input.signature),
  });
}

function encodeLevel(writer: CanonicalWriter, level: PackageQuoteLevel): void {
  writer.writeU64(level.levelId, 'levelId');
  writer.writeEnum(PACKAGE_BOOK_SIDE, level.direction, 'direction');
  writer.writeU128(level.size, 'size');
  writer.writeI128(level.referenceOffset, 'referenceOffset');
  writer.writeU128(level.maximumFee, 'maximumFee');
  writer.writeEnum(SETTLEMENT_CLASS, level.settlementClass, 'settlementClass');
  writer.writeEnum(QUOTE_MODE, level.quoteMode, 'quoteMode');
  writer.writeEnum(EXPIRY_UNIT, level.validUntilUnit, 'validUntilUnit');
  writer.writeU64(level.validUntilValue, 'validUntilValue');
  writer.writeEnum(RESERVATION_POLICY, level.reservationPolicy, 'reservationPolicy');
}

/** The bytes the solver's quote key signs: every shard field except the signature. */
export function unsignedPackageQuoteShardBytes(input: PackageQuoteShardInput): Uint8Array {
  const shard = packageQuoteShard(input);
  return canonicalBytes((writer) => {
    writer.writeU32(shard.shardVersion, 'shardVersion');
    encodeProtocolId(writer, shard.environment, 'environment');
    encodeDomainRef(writer, shard.domain);
    encodeProtocolId(writer, shard.solverId, 'solverId');
    encodeProtocolId(writer, shard.templateId, 'templateId');
    encodeProtocolId(writer, shard.marketGroupId, 'marketGroupId');
    encodeCommitmentHash(writer, shard.referenceStateHash, 'referenceStateHash');
    writer.writeU64(shard.referenceSequence, 'referenceSequence');
    writer.writeArray(shard.quoteLevels, encodeLevel, 'quoteLevels');
    writer.writeU128(shard.inventoryCap, 'inventoryCap');
    writer.writeU128(shard.reservedCapacity, 'reservedCapacity');
    writer.writeU64(shard.heartbeatExpiry, 'heartbeatExpiry');
    writer.writeU64(shard.shardSequence, 'shardSequence');
    writer.writeEnum(KILL_SWITCH_STATE, shard.killSwitchState, 'killSwitchState');
  });
}

export function packageQuoteShardHash(input: PackageQuoteShardInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.PACKAGE_QUOTE_SHARD, unsignedPackageQuoteShardBytes(input)), 'packageQuoteShardHash');
}

// ------------------------------------------------------------------ reference state

export const QUOTE_REFERENCE_STATE_VERSION = 1;

/** What a shard's levels are offsets from: spot-perpetual basis, a funding curve, or volatility. */
export const QUOTE_REFERENCE_KIND = Object.freeze({ BASIS: 1, FUNDING_CURVE: 2, VOLATILITY: 3 } as const);
export type QuoteReferenceKind = keyof typeof QUOTE_REFERENCE_KIND;

/**
 * One versioned reference observation. Its hash is the `referenceStateHash` a shard signs, so the
 * reference price a level settles against is the one the solver committed to, never a value the
 * settling party supplies.
 */
export interface QuoteReferenceStateInput {
  readonly referenceVersion: number;
  readonly environment: string;
  readonly marketGroupId: string;
  readonly referenceKind: QuoteReferenceKind;
  readonly referenceSequence: bigint;
  /** The reference value in the levels' price ticks; level prices are this plus their offsets. */
  readonly referencePriceTicks: bigint;
  /** Commitment to the source observations the reference value was derived from. */
  readonly sourceEvidenceHash: Uint8Array | string;
  readonly observedAtUnit: ExpiryUnit;
  readonly observedAtValue: bigint;
}

export interface QuoteReferenceState {
  readonly referenceVersion: number;
  readonly environment: ProtocolId;
  readonly marketGroupId: ProtocolId;
  readonly referenceKind: QuoteReferenceKind;
  readonly referenceSequence: bigint;
  readonly referencePriceTicks: bigint;
  readonly sourceEvidenceHash: CommitmentHash;
  readonly observedAtUnit: ExpiryUnit;
  readonly observedAtValue: bigint;
}

export function quoteReferenceState(input: QuoteReferenceStateInput, context = 'quoteReferenceState'): QuoteReferenceState {
  object(input, context);
  if (input.referenceVersion !== QUOTE_REFERENCE_STATE_VERSION) {
    throw new MalformedInputError(`${context}.referenceVersion`, `version must equal ${QUOTE_REFERENCE_STATE_VERSION}`);
  }
  if (typeof input.referencePriceTicks !== 'bigint') throw new MalformedInputError(`${context}.referencePriceTicks`, 'expected a bigint');
  return Object.freeze({
    referenceVersion: QUOTE_REFERENCE_STATE_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    marketGroupId: protocolId(input.marketGroupId, `${context}.marketGroupId`),
    referenceKind: variant(QUOTE_REFERENCE_KIND, input.referenceKind, `${context}.referenceKind`),
    referenceSequence: unsigned(input.referenceSequence, U64_BITS, `${context}.referenceSequence`),
    referencePriceTicks: checkedSigned(input.referencePriceTicks, I128_BITS, `${context}.referencePriceTicks`),
    sourceEvidenceHash: commitmentHash(input.sourceEvidenceHash, `${context}.sourceEvidenceHash`),
    observedAtUnit: variant(EXPIRY_UNIT, input.observedAtUnit, `${context}.observedAtUnit`),
    observedAtValue: unsigned(input.observedAtValue, U64_BITS, `${context}.observedAtValue`),
  });
}

export function quoteReferenceStateBytes(input: QuoteReferenceStateInput): Uint8Array {
  const state = quoteReferenceState(input);
  return canonicalBytes((writer) => {
    writer.writeU32(state.referenceVersion, 'referenceVersion');
    encodeProtocolId(writer, state.environment, 'environment');
    encodeProtocolId(writer, state.marketGroupId, 'marketGroupId');
    writer.writeEnum(QUOTE_REFERENCE_KIND, state.referenceKind, 'referenceKind');
    writer.writeU64(state.referenceSequence, 'referenceSequence');
    writer.writeI128(state.referencePriceTicks, 'referencePriceTicks');
    encodeCommitmentHash(writer, state.sourceEvidenceHash, 'sourceEvidenceHash');
    writer.writeEnum(EXPIRY_UNIT, state.observedAtUnit, 'observedAtUnit');
    writer.writeU64(state.observedAtValue, 'observedAtValue');
  });
}

/** `sha256("CON/v1/quote-reference-state" || canonicalEncode(QuoteReferenceState))`. */
export function quoteReferenceStateHash(input: QuoteReferenceStateInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.QUOTE_REFERENCE_STATE, quoteReferenceStateBytes(input)), 'quoteReferenceStateHash');
}

/** True when the reference state is the one the shard is signed over, in its environment and market group. */
function referenceBindsShard(shard: PackageQuoteShard, state: QuoteReferenceState, stateHash: CommitmentHash): boolean {
  return (
    state.environment === shard.environment &&
    state.marketGroupId === shard.marketGroupId &&
    state.referenceSequence === shard.referenceSequence &&
    compareBytes(stateHash, shard.referenceStateHash) === 0
  );
}

// ------------------------------------------------------------------ maker operations

export type ShardOperation =
  | { readonly op: 'PLACE'; readonly level: PackageQuoteLevel }
  | { readonly op: 'REPLACE'; readonly level: PackageQuoteLevel }
  | { readonly op: 'CANCEL'; readonly levelId: bigint }
  | { readonly op: 'CANCEL_ALL' };

/**
 * Applies one batch of place, replace, cancel, and cancel-all operations in order and returns the
 * next unsigned shard at the next sequence, for the solver to sign. Placing an existing level or
 * replacing or cancelling a missing one rejects the whole batch.
 */
export function prepareShardBatch(input: PackageQuoteShardInput, operations: readonly ShardOperation[]): PackageQuoteShardInput {
  const shard = packageQuoteShard(input);
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > QUOTE_SHARD_MAX_LEVELS) {
    throw new MalformedInputError('prepareShardBatch.operations', 'expected a bounded nonempty batch');
  }
  const levels = new Map<bigint, PackageQuoteLevel>(shard.quoteLevels.map((level) => [level.levelId, level]));
  operations.forEach((operation, index) => {
    const context = `prepareShardBatch.operations[${index}]`;
    object(operation, context);
    if (operation.op === 'CANCEL_ALL') {
      levels.clear();
    } else if (operation.op === 'CANCEL') {
      if (!levels.delete(unsigned(operation.levelId, U64_BITS, `${context}.levelId`))) throw new MalformedInputError(context, 'no such level to cancel');
    } else if (operation.op === 'PLACE' || operation.op === 'REPLACE') {
      const level = checkedLevel(operation.level, `${context}.level`);
      if (operation.op === 'PLACE' && levels.has(level.levelId)) throw new MalformedInputError(context, 'level already exists; replace it instead');
      if (operation.op === 'REPLACE' && !levels.has(level.levelId)) throw new MalformedInputError(context, 'no such level to replace');
      levels.set(level.levelId, level);
    } else {
      throw new MalformedInputError(context, 'unknown shard operation');
    }
  });
  return nextShard(shard, { quoteLevels: [...levels.values()] });
}

function nextShard(shard: PackageQuoteShard, changes: Partial<PackageQuoteShardInput>): PackageQuoteShardInput {
  const next = { ...shard, ...changes, shardSequence: shard.shardSequence + 1n, signature: new Uint8Array(0) };
  packageQuoteShard(next);
  return next;
}

/**
 * Moves every level to a new reference state in one update; offsets are unchanged. The state must
 * be for the shard's environment and market group and must advance the reference sequence.
 */
export function prepareShardReprice(input: PackageQuoteShardInput, referenceStateInput: QuoteReferenceStateInput): PackageQuoteShardInput {
  const shard = packageQuoteShard(input);
  const state = quoteReferenceState(referenceStateInput, 'prepareShardReprice.referenceState');
  if (state.environment !== shard.environment || state.marketGroupId !== shard.marketGroupId) {
    throw new MalformedInputError('prepareShardReprice.referenceState', 'reference state is for another environment or market group');
  }
  if (state.referenceSequence <= shard.referenceSequence) {
    throw new MalformedInputError('prepareShardReprice.referenceSequence', 'reference sequence must increase');
  }
  return nextShard(shard, { referenceStateHash: quoteReferenceStateHash(state), referenceSequence: state.referenceSequence });
}

export function prepareShardHeartbeat(input: PackageQuoteShardInput, heartbeatExpiry: bigint): PackageQuoteShardInput {
  const shard = packageQuoteShard(input);
  if (unsigned(heartbeatExpiry, U64_BITS, 'prepareShardHeartbeat.heartbeatExpiry') <= shard.heartbeatExpiry) {
    throw new MalformedInputError('prepareShardHeartbeat.heartbeatExpiry', 'a heartbeat must extend the shard');
  }
  return nextShard(shard, { heartbeatExpiry });
}

/** Activates or clears the kill switch. It halts the whole shard and grants no authority over positions. */
export function prepareShardKillSwitch(input: PackageQuoteShardInput, state: KillSwitchState): PackageQuoteShardInput {
  const shard = packageQuoteShard(input);
  variant(KILL_SWITCH_STATE, state, 'prepareShardKillSwitch.state');
  return nextShard(shard, { killSwitchState: state });
}

export type ShardUpdateRejection = 'IDENTITY_CHANGED' | 'SEQUENCE_NOT_INCREASING' | 'SEQUENCE_REUSED' | 'REFERENCE_REGRESSED';

/**
 * Admits a signed shard update after the caller has verified its signature with the solver's
 * quote key. Only the owning solver's shard identity may change, the sequence must advance, and
 * a repeated update is idempotent while a different update at a used sequence is a replay.
 */
export function admitShardUpdate(
  currentInput: PackageQuoteShardInput | undefined,
  nextInput: PackageQuoteShardInput,
): { readonly accepted: true; readonly duplicate: boolean; readonly shard: PackageQuoteShard } | { readonly accepted: false; readonly reason: ShardUpdateRejection } {
  const next = packageQuoteShard(nextInput);
  if (currentInput === undefined) return Object.freeze({ accepted: true as const, duplicate: false, shard: next });
  const current = packageQuoteShard(currentInput);
  const reject = (reason: ShardUpdateRejection) => Object.freeze({ accepted: false as const, reason });
  // Compared field by field: identifiers are arbitrary ASCII, so a joined key could collide.
  const sameIdentity =
    current.environment === next.environment &&
    current.domain.domainId === next.domain.domainId &&
    current.domain.domainManifestVersion === next.domain.domainManifestVersion &&
    current.solverId === next.solverId &&
    current.templateId === next.templateId &&
    current.marketGroupId === next.marketGroupId;
  if (!sameIdentity || compareBytes(current.domain.domainManifestHash, next.domain.domainManifestHash) !== 0) {
    return reject('IDENTITY_CHANGED');
  }
  if (next.shardSequence === current.shardSequence) {
    return compareBytes(packageQuoteShardHash(next), packageQuoteShardHash(current)) === 0
      ? Object.freeze({ accepted: true as const, duplicate: true, shard: current })
      : reject('SEQUENCE_REUSED');
  }
  if (next.shardSequence < current.shardSequence) return reject('SEQUENCE_NOT_INCREASING');
  if (next.referenceSequence < current.referenceSequence) return reject('REFERENCE_REGRESSED');
  return Object.freeze({ accepted: true as const, duplicate: false, shard: next });
}

export interface ShardSettlementRequest {
  readonly boundShardHash: Uint8Array | string;
  /** The full reference state; it must hash to the shard's signed `referenceStateHash`. */
  readonly referenceState: QuoteReferenceStateInput;
  readonly levelId: bigint;
  /** The taker's side: a BUY may only lift an ASK level and a SELL may only hit a BID level. */
  readonly takerSide: 'BUY' | 'SELL';
  readonly size: bigint;
  readonly fee: bigint;
  readonly atValue: bigint;
}

export type ShardSettlementRejection =
  | 'SHARD_CHANGED'
  | 'KILL_SWITCH_ACTIVE'
  | 'STALE_HEARTBEAT'
  | 'REFERENCE_CHANGED'
  | 'LEVEL_UNKNOWN'
  | 'SIDE_MISMATCH'
  | 'LEVEL_EXPIRED'
  | 'SIZE_ABOVE_LEVEL'
  | 'FEE_ABOVE_MAXIMUM'
  | 'CAPACITY_UNAVAILABLE';

/**
 * The settlement-time check: the exact shard, reference, level, size, fee, heartbeat, kill switch,
 * and capacity must all hold. The executable price is the committed reference price plus the level
 * offset; a reference state that does not hash to the shard's signed reference is refused.
 */
export function checkShardSettlement(
  input: PackageQuoteShardInput,
  request: ShardSettlementRequest,
): { readonly executable: true; readonly priceTicks: bigint; readonly direction: PackageBookSide; readonly quoteMode: QuoteMode } | { readonly executable: false; readonly reason: ShardSettlementRejection } {
  const shard = packageQuoteShard(input);
  object(request, 'checkShardSettlement.request');
  const reject = (reason: ShardSettlementRejection) => Object.freeze({ executable: false as const, reason });
  const at = unsigned(request.atValue, U64_BITS, 'checkShardSettlement.atValue');
  if (compareBytes(commitmentHash(request.boundShardHash, 'checkShardSettlement.boundShardHash'), packageQuoteShardHash(shard)) !== 0) return reject('SHARD_CHANGED');
  if (shard.killSwitchState === 'ACTIVE') return reject('KILL_SWITCH_ACTIVE');
  if (at >= shard.heartbeatExpiry) return reject('STALE_HEARTBEAT');
  const reference = quoteReferenceState(request.referenceState, 'checkShardSettlement.referenceState');
  if (!referenceBindsShard(shard, reference, quoteReferenceStateHash(reference))) return reject('REFERENCE_CHANGED');
  const level = shard.quoteLevels.find((value) => value.levelId === unsigned(request.levelId, U64_BITS, 'checkShardSettlement.levelId'));
  if (level === undefined) return reject('LEVEL_UNKNOWN');
  if (request.takerSide !== 'BUY' && request.takerSide !== 'SELL') throw new MalformedInputError('checkShardSettlement.takerSide', 'expected BUY or SELL');
  if (level.direction !== (request.takerSide === 'BUY' ? 'ASK' : 'BID')) return reject('SIDE_MISMATCH');
  if (at >= level.validUntilValue) return reject('LEVEL_EXPIRED');
  const size = unsigned(request.size, U128_BITS, 'checkShardSettlement.size');
  if (size === 0n || size > level.size) return reject('SIZE_ABOVE_LEVEL');
  if (unsigned(request.fee, U128_BITS, 'checkShardSettlement.fee') > level.maximumFee) return reject('FEE_ABOVE_MAXIMUM');
  if (shard.reservedCapacity + size > shard.inventoryCap) return reject('CAPACITY_UNAVAILABLE');
  return Object.freeze({
    executable: true as const,
    // The price comes from the committed reference state, never from the settling party.
    priceTicks: checkedSigned(reference.referencePriceTicks + level.referenceOffset, I128_BITS, 'checkShardSettlement.priceTicks'),
    direction: level.direction,
    quoteMode: level.quoteMode,
  });
}
