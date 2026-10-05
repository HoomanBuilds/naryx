import { absBigInt, checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { enumDiscriminant, type EnumTable } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';

export const STRATEGY_STATE_VERSION = 1;
export const STRATEGY_MAX_LEGS = 16;
const BPS = 10_000n;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;

export const STRATEGY_OPERATION = Object.freeze({
  ASSIGN_INTERNAL: 1,
  DELEGATE: 2,
  REVOKE_DELEGATION: 3,
  SPLIT: 4,
  MERGE: 5,
  NOVATE: 6,
  ROLL: 7,
  MIGRATE: 8,
  REBALANCE: 9,
  INCREASE: 10,
  DECREASE: 11,
  EXIT: 12,
  ADOPT_BASELINE: 13,
  EMERGENCY_UNWIND: 14,
} as const);
export type StrategyOperation = keyof typeof STRATEGY_OPERATION;

/** The only operations an owner can delegate. None of them can move ownership or add risk. */
export const DELEGABLE_AUTHORITY = Object.freeze({
  REBALANCE: 1,
  ROLL: 2,
  DECREASE: 3,
  EXIT: 4,
  EMERGENCY_UNWIND: 5,
} as const);
export type DelegableAuthority = keyof typeof DELEGABLE_AUTHORITY;

export const LIABILITY_KIND = Object.freeze({
  MARGIN_LOAN: 1,
  BORROW: 2,
  RECOVERY_OBLIGATION: 3,
} as const);
export type LiabilityKind = keyof typeof LIABILITY_KIND;

export type StrategyRejection =
  | 'STALE_STATE'
  | 'STRATEGY_CLOSED'
  | 'UNAUTHORIZED'
  | 'DELEGATION_EXPIRED'
  | 'TERMS_DIFFER'
  | 'SPLIT_TOO_SMALL'
  | 'CHANGE_BELOW_LOT'
  | 'RATIO_BROKEN'
  | 'CHANGE_EXCEEDS_BOUND'
  | 'DIRECTION_FLIP'
  | 'NOT_TRANSFERABLE'
  | 'CONSENT_MISSING'
  | 'VENUE_CONFIRMATION_MISSING';

// ------------------------------------------------------------------ state

export interface StrategyLeg {
  readonly legId: string;
  readonly underlyingId: string;
  readonly instrumentId: string;
  readonly venueId: string;
  readonly signedQuantityAtoms: bigint;
  readonly lotAtoms: bigint;
  readonly ratioNumerator: bigint;
  readonly ratioDenominator: bigint;
}

export interface StrategyLiability {
  readonly liabilityId: string;
  readonly kind: LiabilityKind;
  readonly assetId: string;
  readonly atoms: bigint;
  readonly transferable: boolean;
}

export interface StrategyDelegation {
  readonly delegateId: string;
  readonly authorities: readonly DelegableAuthority[];
  readonly expiresAtValue: bigint;
}

export interface StrategyState {
  readonly version: number;
  readonly strategyId: string;
  readonly ownerId: string;
  readonly subaccountId: string;
  readonly seriesId: string;
  readonly executionClassId: string;
  readonly open: boolean;
  readonly stateVersion: bigint;
  readonly legs: readonly StrategyLeg[];
  readonly liabilities: readonly StrategyLiability[];
  readonly delegations: readonly StrategyDelegation[];
  /** Whether every underlying venue position and collateral claim can legally move owners. */
  readonly venuePositionsTransferable: boolean;
  readonly legalTransferRestricted: boolean;
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function requireArray(value: unknown, context: string, maximum: number): void {
  if (!Array.isArray(value)) throw new MalformedInputError(context, 'expected an array');
  if (value.length > maximum) throw new MalformedInputError(context, `more than ${maximum} entries`);
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function signed(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedSigned(value, I128_BITS, context);
}

function bool(value: boolean, context: string): boolean {
  if (typeof value !== 'boolean') throw new MalformedInputError(context, 'expected a boolean');
  return value;
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function byId<T>(values: readonly T[], id: (value: T) => string, context: string): readonly T[] {
  const sorted = [...values].sort((left, right) => (id(left) < id(right) ? -1 : id(left) > id(right) ? 1 : 0));
  for (let index = 1; index < sorted.length; index += 1) {
    if (id(sorted[index - 1] as T) === id(sorted[index] as T)) throw new DuplicateElementError(context, 'identifiers repeat');
  }
  return Object.freeze(sorted);
}

function checkedLeg(leg: StrategyLeg, open: boolean, context: string): StrategyLeg {
  object(leg, context);
  const lotAtoms = unsigned(leg.lotAtoms, U128_BITS, `${context}.lotAtoms`);
  if (lotAtoms === 0n) throw new MalformedInputError(`${context}.lotAtoms`, 'lot is zero');
  const signedQuantityAtoms = signed(leg.signedQuantityAtoms, `${context}.signedQuantityAtoms`);
  if (signedQuantityAtoms % lotAtoms !== 0n) throw new MalformedInputError(`${context}.signedQuantityAtoms`, 'quantity is off the lot lattice');
  if (open && signedQuantityAtoms === 0n) throw new MalformedInputError(`${context}.signedQuantityAtoms`, 'an open leg cannot be flat');
  if (!open && signedQuantityAtoms !== 0n) throw new MalformedInputError(`${context}.signedQuantityAtoms`, 'a closed strategy keeps no exposure');
  const ratioNumerator = signed(leg.ratioNumerator, `${context}.ratioNumerator`);
  const ratioDenominator = unsigned(leg.ratioDenominator, U128_BITS, `${context}.ratioDenominator`);
  if (ratioNumerator === 0n || ratioDenominator === 0n) throw new MalformedInputError(`${context}.ratio`, 'ratio is zero');
  if (open && (signedQuantityAtoms > 0n) !== (ratioNumerator > 0n)) {
    throw new MalformedInputError(`${context}.signedQuantityAtoms`, 'leg direction disagrees with the series ratio');
  }
  return Object.freeze({
    legId: protocolId(leg.legId, `${context}.legId`),
    underlyingId: protocolId(leg.underlyingId, `${context}.underlyingId`),
    instrumentId: protocolId(leg.instrumentId, `${context}.instrumentId`),
    venueId: protocolId(leg.venueId, `${context}.venueId`),
    signedQuantityAtoms,
    lotAtoms,
    ratioNumerator,
    ratioDenominator,
  });
}

export function strategyState(input: StrategyState, context = 'strategyState'): StrategyState {
  object(input, context);
  if (input.version !== STRATEGY_STATE_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${STRATEGY_STATE_VERSION}`);
  }
  const open = bool(input.open, `${context}.open`);
  requireArray(input.legs, `${context}.legs`, STRATEGY_MAX_LEGS);
  if (input.legs.length === 0) throw new MalformedInputError(`${context}.legs`, 'a strategy needs a leg');
  requireArray(input.liabilities, `${context}.liabilities`, 32);
  requireArray(input.delegations, `${context}.delegations`, 32);
  const legs = byId(input.legs.map((leg, index) => checkedLeg(leg, open, `${context}.legs[${index}]`)), (leg) => leg.legId, `${context}.legs`);
  const liabilities = byId(
    input.liabilities.map((liability, index) => {
      const at = `${context}.liabilities[${index}]`;
      object(liability, at);
      const atoms = unsigned(liability.atoms, U128_BITS, `${at}.atoms`);
      if (atoms === 0n) throw new MalformedInputError(`${at}.atoms`, 'a liability cannot be zero');
      return Object.freeze({
        liabilityId: protocolId(liability.liabilityId, `${at}.liabilityId`),
        kind: variant(LIABILITY_KIND, liability.kind, `${at}.kind`),
        assetId: protocolId(liability.assetId, `${at}.assetId`),
        atoms,
        transferable: bool(liability.transferable, `${at}.transferable`),
      });
    }),
    (liability) => liability.liabilityId,
    `${context}.liabilities`,
  );
  const delegations = byId(
    input.delegations.map((delegation, index) => {
      const at = `${context}.delegations[${index}]`;
      object(delegation, at);
      requireArray(delegation.authorities, `${at}.authorities`, 5);
      const authorities = [...new Set(delegation.authorities.map((value) => variant(DELEGABLE_AUTHORITY, value, `${at}.authorities`)))];
      if (authorities.length === 0 || authorities.length !== delegation.authorities.length) {
        throw new MalformedInputError(`${at}.authorities`, 'authorities must be a nonempty set');
      }
      return Object.freeze({
        delegateId: protocolId(delegation.delegateId, `${at}.delegateId`),
        authorities: Object.freeze(authorities.sort((a, b) => DELEGABLE_AUTHORITY[a] - DELEGABLE_AUTHORITY[b])),
        expiresAtValue: unsigned(delegation.expiresAtValue, U64_BITS, `${at}.expiresAtValue`),
      });
    }),
    (delegation) => delegation.delegateId,
    `${context}.delegations`,
  );
  const ownerId = protocolId(input.ownerId, `${context}.ownerId`);
  if (delegations.some((delegation) => delegation.delegateId === ownerId)) {
    throw new MalformedInputError(`${context}.delegations`, 'the owner cannot be its own delegate');
  }
  const stateVersion = unsigned(input.stateVersion, U64_BITS, `${context}.stateVersion`);
  if (stateVersion === 0n) throw new MalformedInputError(`${context}.stateVersion`, 'state version is zero');
  return Object.freeze({
    version: STRATEGY_STATE_VERSION,
    strategyId: protocolId(input.strategyId, `${context}.strategyId`),
    ownerId,
    subaccountId: protocolId(input.subaccountId, `${context}.subaccountId`),
    seriesId: protocolId(input.seriesId, `${context}.seriesId`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    open,
    stateVersion,
    legs,
    liabilities,
    delegations,
    venuePositionsTransferable: bool(input.venuePositionsTransferable, `${context}.venuePositionsTransferable`),
    legalTransferRestricted: bool(input.legalTransferRestricted, `${context}.legalTransferRestricted`),
  });
}

/** Writes a validated strategy state exactly as its hash commits to it. */
export function encodeStrategyState(writer: CanonicalWriter, state: StrategyState): void {
  encodeState(writer, strategyState(state));
}

function encodeState(writer: CanonicalWriter, state: StrategyState): void {
  writer.writeU32(state.version, 'version');
  for (const id of [state.strategyId, state.ownerId, state.subaccountId, state.seriesId, state.executionClassId]) {
    encodeProtocolId(writer, id as ProtocolId);
  }
  writer.writeBool(state.open, 'open');
  writer.writeU64(state.stateVersion, 'stateVersion');
  writer.writeArray(state.legs, (element, leg) => {
    for (const id of [leg.legId, leg.underlyingId, leg.instrumentId, leg.venueId]) encodeProtocolId(element, id as ProtocolId);
    element.writeI128(leg.signedQuantityAtoms, 'signedQuantityAtoms');
    element.writeU128(leg.lotAtoms, 'lotAtoms');
    element.writeI128(leg.ratioNumerator, 'ratioNumerator');
    element.writeU128(leg.ratioDenominator, 'ratioDenominator');
  });
  writer.writeArray(state.liabilities, (element, liability) => {
    encodeProtocolId(element, liability.liabilityId as ProtocolId);
    element.writeEnum(LIABILITY_KIND, liability.kind, 'kind');
    encodeProtocolId(element, liability.assetId as ProtocolId);
    element.writeU128(liability.atoms, 'atoms');
    element.writeBool(liability.transferable, 'transferable');
  });
  writer.writeArray(state.delegations, (element, delegation) => {
    encodeProtocolId(element, delegation.delegateId as ProtocolId);
    element.writeArray(delegation.authorities, (inner, authority) => inner.writeEnum(DELEGABLE_AUTHORITY, authority));
    element.writeU64(delegation.expiresAtValue, 'expiresAtValue');
  });
  writer.writeBool(state.venuePositionsTransferable, 'venuePositionsTransferable');
  writer.writeBool(state.legalTransferRestricted, 'legalTransferRestricted');
}

export function strategyStateHash(input: StrategyState): CommitmentHash {
  const state = strategyState(input);
  return commitmentHash(domainHash(HASH_DOMAIN.STRATEGY_STATE, canonicalBytes((writer) => encodeState(writer, state))), 'strategyStateHash');
}

// ------------------------------------------------------------------ transitions

export interface StrategyTransitionContext {
  readonly actorId: string;
  readonly expectedStateVersion: bigint;
  readonly expectedStateHash: Uint8Array | string;
  readonly atValue: bigint;
}

export interface StrategyTransitionReceipt {
  readonly operation: StrategyOperation;
  readonly actorId: ProtocolId;
  readonly priorStateHashes: readonly CommitmentHash[];
  readonly nextStateHashes: readonly CommitmentHash[];
  readonly atValue: bigint;
  /** An internal operation changes labels and accounting only; no external venue position moved. */
  readonly externalPositionsMoved: boolean;
  /** Liabilities settled by an exit, with their evidence; empty for every other operation. */
  readonly liabilitySettlements: readonly { readonly liabilityId: ProtocolId; readonly settledAtoms: bigint; readonly evidenceHash: CommitmentHash }[];
  readonly receiptHash: CommitmentHash;
}

export type StrategyTransitionResult =
  | { readonly accepted: true; readonly states: readonly StrategyState[]; readonly receipt: StrategyTransitionReceipt }
  | { readonly accepted: false; readonly rejection: StrategyRejection; readonly remedy?: 'EXIT_AND_REENTER' | 'ADOPT_BASELINE' };

const OWNER_ONLY: ReadonlySet<StrategyOperation> = new Set([
  'ASSIGN_INTERNAL', 'DELEGATE', 'REVOKE_DELEGATION', 'SPLIT', 'MERGE', 'NOVATE', 'MIGRATE', 'INCREASE', 'ADOPT_BASELINE',
]);

function reject(rejection: StrategyRejection, remedy?: 'EXIT_AND_REENTER' | 'ADOPT_BASELINE'): StrategyTransitionResult {
  return Object.freeze(remedy === undefined ? { accepted: false as const, rejection } : { accepted: false as const, rejection, remedy });
}

/**
 * Every transition binds the exact prior state. A stale version or hash rejects, which is how an
 * external position change invalidates delegated automation until the owner adopts the new baseline.
 */
function authorize(state: StrategyState, context: StrategyTransitionContext, operation: StrategyOperation): StrategyRejection | undefined {
  object(context, 'strategyTransition.context');
  const at = unsigned(context.atValue, U64_BITS, 'strategyTransition.context.atValue');
  if (unsigned(context.expectedStateVersion, U64_BITS, 'strategyTransition.context.expectedStateVersion') !== state.stateVersion
    || compareBytes(commitmentHash(context.expectedStateHash, 'strategyTransition.context.expectedStateHash'), strategyStateHash(state)) !== 0) {
    return 'STALE_STATE';
  }
  if (!state.open) return 'STRATEGY_CLOSED';
  const actor = protocolId(context.actorId, 'strategyTransition.context.actorId');
  if (actor === state.ownerId) return undefined;
  if (OWNER_ONLY.has(operation)) return 'UNAUTHORIZED';
  const delegation = state.delegations.find((value) => value.delegateId === actor);
  if (delegation === undefined || !delegation.authorities.includes(operation as DelegableAuthority)) return 'UNAUTHORIZED';
  if (at >= delegation.expiresAtValue) return 'DELEGATION_EXPIRED';
  return undefined;
}

function next(state: StrategyState, changes: Partial<StrategyState>): StrategyState {
  return strategyState({ ...state, ...changes, stateVersion: state.stateVersion + 1n });
}

function accept(
  operation: StrategyOperation,
  context: StrategyTransitionContext,
  prior: readonly StrategyState[],
  states: readonly StrategyState[],
  externalPositionsMoved: boolean,
  liabilitySettlements: readonly { readonly liabilityId: ProtocolId; readonly settledAtoms: bigint; readonly evidenceHash: CommitmentHash }[] = [],
): StrategyTransitionResult {
  const priorStateHashes = Object.freeze(prior.map(strategyStateHash));
  const nextStateHashes = Object.freeze(states.map(strategyStateHash));
  const actorId = protocolId(context.actorId);
  const payload = canonicalBytes((writer) => {
    writer.writeEnum(STRATEGY_OPERATION, operation, 'operation');
    encodeProtocolId(writer, actorId);
    writer.writeArray(priorStateHashes, (element, hash) => encodeCommitmentHash(element, hash, 'priorStateHash'));
    writer.writeArray(nextStateHashes, (element, hash) => encodeCommitmentHash(element, hash, 'nextStateHash'));
    writer.writeU64(context.atValue, 'atValue');
    writer.writeBool(externalPositionsMoved, 'externalPositionsMoved');
    if (operation === 'EXIT' || operation === 'EMERGENCY_UNWIND') {
      writer.writeArray(liabilitySettlements, (element, settlement) => {
        encodeProtocolId(element, settlement.liabilityId, 'liabilityId');
        element.writeU128(settlement.settledAtoms, 'settledAtoms');
        encodeCommitmentHash(element, settlement.evidenceHash, 'evidenceHash');
      }, 'liabilitySettlements');
    }
  });
  return Object.freeze({
    accepted: true as const,
    states: Object.freeze(states),
    receipt: Object.freeze({
      operation,
      actorId,
      priorStateHashes,
      nextStateHashes,
      atValue: context.atValue,
      externalPositionsMoved,
      liabilitySettlements: Object.freeze([...liabilitySettlements]),
      receiptHash: commitmentHash(domainHash(HASH_DOMAIN.STRATEGY_TRANSITION, payload), 'strategyTransitionReceipt'),
    }),
  });
}

/** Legs hold the series ratio exactly: q_i / r_i is equal for every leg, by cross multiplication. */
function ratioHolds(legs: readonly StrategyLeg[]): boolean {
  const first = legs[0] as StrategyLeg;
  return legs.every(
    (leg) =>
      leg.signedQuantityAtoms * first.ratioNumerator * leg.ratioDenominator ===
      first.signedQuantityAtoms * leg.ratioNumerator * first.ratioDenominator,
  );
}

/** Changes the organization subaccount label. No external position moves and no liability changes. */
export function assignInternal(input: StrategyState, context: StrategyTransitionContext, subaccountId: string): StrategyTransitionResult {
  const state = strategyState(input);
  const failure = authorize(state, context, 'ASSIGN_INTERNAL');
  if (failure !== undefined) return reject(failure);
  return accept('ASSIGN_INTERNAL', context, [state], [next(state, { subaccountId: protocolId(subaccountId, 'assignInternal.subaccountId') })], false);
}

export function delegateManagement(input: StrategyState, context: StrategyTransitionContext, delegation: StrategyDelegation): StrategyTransitionResult {
  const state = strategyState(input);
  const failure = authorize(state, context, 'DELEGATE');
  if (failure !== undefined) return reject(failure);
  object(delegation, 'delegateManagement.delegation');
  if (unsigned(delegation.expiresAtValue, U64_BITS, 'delegateManagement.expiresAtValue') <= context.atValue) {
    throw new MalformedInputError('delegateManagement.expiresAtValue', 'a delegation must expire in the future');
  }
  const delegateId = protocolId(delegation.delegateId, 'delegateManagement.delegateId');
  const delegations = [...state.delegations.filter((value) => value.delegateId !== delegateId), delegation];
  return accept('DELEGATE', context, [state], [next(state, { delegations })], false);
}

export function revokeDelegation(input: StrategyState, context: StrategyTransitionContext, delegateId: string): StrategyTransitionResult {
  const state = strategyState(input);
  const failure = authorize(state, context, 'REVOKE_DELEGATION');
  if (failure !== undefined) return reject(failure);
  const id = protocolId(delegateId, 'revokeDelegation.delegateId');
  if (!state.delegations.some((value) => value.delegateId === id)) {
    throw new MalformedInputError('revokeDelegation.delegateId', 'no such delegation');
  }
  return accept('REVOKE_DELEGATION', context, [state], [next(state, { delegations: state.delegations.filter((value) => value.delegateId !== id) })], false);
}

/**
 * Splits one strategy into two with identical owner and terms. Every leg and liability is
 * conserved exactly: the first child takes the lot-floored share, the second the remainder.
 * Delegations do not carry over; each child starts undelegated.
 */
export function splitStrategy(
  input: StrategyState,
  context: StrategyTransitionContext,
  split: { readonly childStrategyIds: readonly [string, string]; readonly firstShareBps: bigint },
): StrategyTransitionResult {
  const state = strategyState(input);
  const failure = authorize(state, context, 'SPLIT');
  if (failure !== undefined) return reject(failure);
  object(split, 'splitStrategy.split');
  const share = unsigned(split.firstShareBps, U64_BITS, 'splitStrategy.firstShareBps');
  if (share === 0n || share >= BPS) throw new MalformedInputError('splitStrategy.firstShareBps', 'share must be strictly between 0 and 10000');
  const [firstId, secondId] = split.childStrategyIds.map((id) => protocolId(id, 'splitStrategy.childStrategyIds')) as [ProtocolId, ProtocolId];
  if (firstId === secondId || firstId === state.strategyId || secondId === state.strategyId) {
    throw new MalformedInputError('splitStrategy.childStrategyIds', 'children need two new distinct identities');
  }
  const firstLegs = state.legs.map((leg) => ({ ...leg, signedQuantityAtoms: ((leg.signedQuantityAtoms * share) / BPS / leg.lotAtoms) * leg.lotAtoms }));
  const secondLegs = state.legs.map((leg, index) => ({ ...leg, signedQuantityAtoms: leg.signedQuantityAtoms - (firstLegs[index] as StrategyLeg).signedQuantityAtoms }));
  if ([...firstLegs, ...secondLegs].some((leg) => leg.signedQuantityAtoms === 0n)) return reject('SPLIT_TOO_SMALL');
  if (!ratioHolds(firstLegs) || !ratioHolds(secondLegs)) return reject('RATIO_BROKEN');
  // Liabilities follow the realized exposure split, not the nominal share, so lot flooring on the
  // legs cannot leave one child carrying debt for exposure it does not hold.
  const realizedNumerator = absBigInt((firstLegs[0] as StrategyLeg).signedQuantityAtoms);
  const realizedDenominator = absBigInt((state.legs[0] as StrategyLeg).signedQuantityAtoms);
  const firstLiabilities = state.liabilities.map((liability) => ({ ...liability, atoms: (liability.atoms * realizedNumerator) / realizedDenominator }));
  const secondLiabilities = state.liabilities.map((liability, index) => ({ ...liability, atoms: liability.atoms - (firstLiabilities[index] as StrategyLiability).atoms }));
  const child = (strategyId: ProtocolId, legs: StrategyLeg[], liabilities: StrategyLiability[]) =>
    strategyState({ ...state, strategyId, legs, liabilities, delegations: [], stateVersion: 1n });
  return accept('SPLIT', context, [state], [child(firstId, firstLegs, firstLiabilities), child(secondId, secondLegs, secondLiabilities)], false);
}

function sameTerms(left: StrategyState, right: StrategyState): boolean {
  // Compared field by field: identifiers are arbitrary ASCII, so joined strings could collide.
  const sameLeg = (a: StrategyLeg, b: StrategyLeg) =>
    a.legId === b.legId && a.underlyingId === b.underlyingId && a.instrumentId === b.instrumentId &&
    a.venueId === b.venueId && a.lotAtoms === b.lotAtoms && a.ratioNumerator === b.ratioNumerator &&
    a.ratioDenominator === b.ratioDenominator;
  const sameLiability = (a: StrategyLiability, b: StrategyLiability) =>
    a.liabilityId === b.liabilityId && a.kind === b.kind && a.assetId === b.assetId && a.transferable === b.transferable;
  return (
    left.ownerId === right.ownerId &&
    left.subaccountId === right.subaccountId &&
    left.seriesId === right.seriesId &&
    left.executionClassId === right.executionClassId &&
    left.venuePositionsTransferable === right.venuePositionsTransferable &&
    left.legalTransferRestricted === right.legalTransferRestricted &&
    left.legs.length === right.legs.length &&
    left.legs.every((leg, index) => sameLeg(leg, right.legs[index] as StrategyLeg)) &&
    left.liabilities.length === right.liabilities.length &&
    left.liabilities.every((liability, index) => sameLiability(liability, right.liabilities[index] as StrategyLiability))
  );
}

/** Merges two strategies only when owner, instruments, collateral, and liability terms are identical. */
export function mergeStrategies(
  firstInput: StrategyState,
  secondInput: StrategyState,
  contexts: readonly [StrategyTransitionContext, StrategyTransitionContext],
  mergedStrategyId: string,
): StrategyTransitionResult {
  const first = strategyState(firstInput);
  const second = strategyState(secondInput);
  const failure = authorize(first, contexts[0], 'MERGE') ?? authorize(second, contexts[1], 'MERGE');
  if (failure !== undefined) return reject(failure);
  if (protocolId(contexts[0].actorId) !== protocolId(contexts[1].actorId) || first.strategyId === second.strategyId) {
    throw new MalformedInputError('mergeStrategies.contexts', 'one owner merges two distinct strategies');
  }
  if (!sameTerms(first, second)) return reject('TERMS_DIFFER');
  const legs = first.legs.map((leg, index) => ({ ...leg, signedQuantityAtoms: leg.signedQuantityAtoms + (second.legs[index] as StrategyLeg).signedQuantityAtoms }));
  const liabilities = first.liabilities.map((liability, index) => ({ ...liability, atoms: liability.atoms + (second.liabilities[index] as StrategyLiability).atoms }));
  const merged = strategyState({
    ...first,
    strategyId: protocolId(mergedStrategyId, 'mergeStrategies.mergedStrategyId'),
    legs,
    liabilities,
    delegations: [],
    stateVersion: 1n,
  });
  return accept('MERGE', contexts[0], [first, second], [merged], false);
}

/**
 * Novation is never a metadata edit. It needs transferable venue positions and liabilities, no
 * legal restriction, consent from both owners, and a confirmation from every venue holding a leg.
 * Otherwise the only honest path is an exit and a re-entry, and the rejection says so.
 */
export function novateStrategy(
  input: StrategyState,
  context: StrategyTransitionContext,
  novation: { readonly newOwnerId: string; readonly consentingOwnerIds: readonly string[]; readonly confirmingVenueIds: readonly string[] },
): StrategyTransitionResult {
  const state = strategyState(input);
  const failure = authorize(state, context, 'NOVATE');
  if (failure !== undefined) return reject(failure);
  object(novation, 'novateStrategy.novation');
  const newOwnerId = protocolId(novation.newOwnerId, 'novateStrategy.newOwnerId');
  if (newOwnerId === state.ownerId) throw new MalformedInputError('novateStrategy.newOwnerId', 'novation needs a new owner');
  if (!state.venuePositionsTransferable || state.legalTransferRestricted || state.liabilities.some((liability) => !liability.transferable)) {
    return reject('NOT_TRANSFERABLE', 'EXIT_AND_REENTER');
  }
  requireArray(novation.consentingOwnerIds, 'novateStrategy.consentingOwnerIds', 4);
  requireArray(novation.confirmingVenueIds, 'novateStrategy.confirmingVenueIds', STRATEGY_MAX_LEGS);
  const consents = new Set<string>(novation.consentingOwnerIds.map((id) => protocolId(id, 'novateStrategy.consentingOwnerIds')));
  if (!consents.has(state.ownerId) || !consents.has(newOwnerId)) return reject('CONSENT_MISSING');
  const confirmations = new Set<string>(novation.confirmingVenueIds.map((id) => protocolId(id, 'novateStrategy.confirmingVenueIds')));
  if (state.legs.some((leg) => !confirmations.has(leg.venueId))) return reject('VENUE_CONFIRMATION_MISSING');
  return accept('NOVATE', context, [state], [next(state, { ownerId: newOwnerId, delegations: [] })], true);
}

/**
 * Moves one leg's exact signed exposure onto a new instrument on the same underlying. A roll stays
 * on its venue and may be delegated; a migration changes venue and is owner-only.
 */
export function moveLeg(
  input: StrategyState,
  context: StrategyTransitionContext,
  move: { readonly operation: 'ROLL' | 'MIGRATE'; readonly legId: string; readonly newLegId: string; readonly newInstrumentId: string; readonly newVenueId: string; readonly newLotAtoms: bigint },
): StrategyTransitionResult {
  const state = strategyState(input);
  object(move, 'moveLeg.move');
  if (move.operation !== 'ROLL' && move.operation !== 'MIGRATE') throw new MalformedInputError('moveLeg.operation', 'expected ROLL or MIGRATE');
  const failure = authorize(state, context, move.operation);
  if (failure !== undefined) return reject(failure);
  const legId = protocolId(move.legId, 'moveLeg.legId');
  const leg = state.legs.find((value) => value.legId === legId);
  if (leg === undefined) throw new MalformedInputError('moveLeg.legId', 'no such leg');
  const newVenueId = protocolId(move.newVenueId, 'moveLeg.newVenueId');
  const newInstrumentId = protocolId(move.newInstrumentId, 'moveLeg.newInstrumentId');
  if (move.operation === 'ROLL' && newVenueId !== leg.venueId) throw new MalformedInputError('moveLeg.newVenueId', 'a roll stays on its venue');
  if (newInstrumentId === leg.instrumentId && newVenueId === leg.venueId) throw new MalformedInputError('moveLeg', 'the leg would not move');
  const newLotAtoms = unsigned(move.newLotAtoms, U128_BITS, 'moveLeg.newLotAtoms');
  if (newLotAtoms === 0n || leg.signedQuantityAtoms % newLotAtoms !== 0n) {
    throw new MalformedInputError('moveLeg.newLotAtoms', 'the exposure does not fit the new lot lattice');
  }
  const moved = { ...leg, legId: protocolId(move.newLegId, 'moveLeg.newLegId'), instrumentId: newInstrumentId, venueId: newVenueId, lotAtoms: newLotAtoms };
  return accept(move.operation, context, [state], [next(state, { legs: state.legs.map((value) => (value === leg ? moved : value)) })], true);
}

export interface StrategyLegMove {
  readonly legId: string;
  readonly newLegId: string;
  readonly newInstrumentId: string;
  readonly newVenueId: string;
  readonly newLotAtoms: bigint;
}

/** Moves several legs as one strategy transition, which is required for calendar and option rolls. */
export function moveStrategyLegs(
  input: StrategyState,
  context: StrategyTransitionContext,
  operation: 'ROLL' | 'MIGRATE',
  moves: readonly StrategyLegMove[],
): StrategyTransitionResult {
  const state = strategyState(input);
  const failure = authorize(state, context, operation);
  if (failure !== undefined) return reject(failure);
  requireArray(moves, 'moveStrategyLegs.moves', STRATEGY_MAX_LEGS);
  if (moves.length === 0) throw new MalformedInputError('moveStrategyLegs.moves', 'at least one leg must move');
  const sourceIds = new Set<string>();
  const destinationIds = new Set<string>();
  const replacements = new Map<string, StrategyLeg>();
  for (const [index, move] of moves.entries()) {
    const at = `moveStrategyLegs.moves[${index}]`;
    object(move, at);
    const legId = protocolId(move.legId, `${at}.legId`);
    const newLegId = protocolId(move.newLegId, `${at}.newLegId`);
    if (sourceIds.has(legId) || destinationIds.has(newLegId)) throw new DuplicateElementError(at, 'a source or destination leg repeats');
    sourceIds.add(legId);
    destinationIds.add(newLegId);
    const leg = state.legs.find((value) => value.legId === legId);
    if (leg === undefined) throw new MalformedInputError(`${at}.legId`, 'no such leg');
    const newVenueId = protocolId(move.newVenueId, `${at}.newVenueId`);
    const newInstrumentId = protocolId(move.newInstrumentId, `${at}.newInstrumentId`);
    if (operation === 'ROLL' && newVenueId !== leg.venueId) throw new MalformedInputError(`${at}.newVenueId`, 'a roll stays on its venue');
    if (newVenueId === leg.venueId && newInstrumentId === leg.instrumentId) throw new MalformedInputError(at, 'the leg would not move');
    const newLotAtoms = unsigned(move.newLotAtoms, U128_BITS, `${at}.newLotAtoms`);
    if (newLotAtoms === 0n || leg.signedQuantityAtoms % newLotAtoms !== 0n) throw new MalformedInputError(`${at}.newLotAtoms`, 'the exposure does not fit the new lot lattice');
    replacements.set(legId, { ...leg, legId: newLegId, instrumentId: newInstrumentId, venueId: newVenueId, lotAtoms: newLotAtoms });
  }
  const unchangedIds = new Set(state.legs.filter((leg) => !sourceIds.has(leg.legId)).map((leg) => leg.legId));
  if ([...destinationIds].some((legId) => unchangedIds.has(legId))) throw new DuplicateElementError('moveStrategyLegs.moves', 'a destination collides with an unchanged leg');
  const legs = state.legs.map((leg) => replacements.get(leg.legId) ?? leg);
  return accept(operation, context, [state], [next(state, { legs })], true);
}

/** Resets leg quantities to targets that keep the series ratio, each direction, and a per-leg change bound. */
export function rebalanceStrategy(
  input: StrategyState,
  context: StrategyTransitionContext,
  targets: readonly { readonly legId: string; readonly signedQuantityAtoms: bigint; readonly maximumChangeAtoms: bigint }[],
): StrategyTransitionResult {
  const state = strategyState(input);
  const failure = authorize(state, context, 'REBALANCE');
  if (failure !== undefined) return reject(failure);
  requireArray(targets, 'rebalanceStrategy.targets', STRATEGY_MAX_LEGS);
  if (targets.length !== state.legs.length) throw new MalformedInputError('rebalanceStrategy.targets', 'every leg needs a target');
  const legs: StrategyLeg[] = [];
  for (const leg of state.legs) {
    const target = targets.find((value) => protocolId(value.legId, 'rebalanceStrategy.legId') === leg.legId);
    if (target === undefined) throw new MalformedInputError('rebalanceStrategy.targets', `no target for ${leg.legId}`);
    const quantity = signed(target.signedQuantityAtoms, 'rebalanceStrategy.signedQuantityAtoms');
    if (quantity === 0n || (quantity > 0n) !== (leg.signedQuantityAtoms > 0n)) return reject('DIRECTION_FLIP');
    if (absBigInt(quantity - leg.signedQuantityAtoms) > unsigned(target.maximumChangeAtoms, U128_BITS, 'rebalanceStrategy.maximumChangeAtoms')) {
      return reject('CHANGE_EXCEEDS_BOUND');
    }
    if (quantity % leg.lotAtoms !== 0n) throw new MalformedInputError('rebalanceStrategy.signedQuantityAtoms', 'target is off the lot lattice');
    legs.push({ ...leg, signedQuantityAtoms: quantity });
  }
  if (!ratioHolds(legs)) return reject('RATIO_BROKEN');
  // The change bound is supplied with the request, so it cannot limit a delegate. Growing gross
  // exposure is an INCREASE, which only the owner may authorize.
  const gross = (values: readonly StrategyLeg[]) => values.reduce((sum, leg) => sum + absBigInt(leg.signedQuantityAtoms), 0n);
  if (protocolId(context.actorId) !== state.ownerId && gross(legs) > gross(state.legs)) return reject('UNAUTHORIZED');
  return accept('REBALANCE', context, [state], [next(state, { legs })], true);
}

/**
 * Scales every leg by the same basis-point change. A decrease can be delegated because it only
 * reduces exposure; an increase adds risk and needs the owner. The series ratio must hold exactly.
 */
export function resizeStrategy(
  input: StrategyState,
  context: StrategyTransitionContext,
  resize: { readonly operation: 'INCREASE' | 'DECREASE'; readonly changeBps: bigint },
): StrategyTransitionResult {
  const state = strategyState(input);
  object(resize, 'resizeStrategy.resize');
  if (resize.operation !== 'INCREASE' && resize.operation !== 'DECREASE') throw new MalformedInputError('resizeStrategy.operation', 'expected INCREASE or DECREASE');
  const failure = authorize(state, context, resize.operation);
  if (failure !== undefined) return reject(failure);
  const change = unsigned(resize.changeBps, U64_BITS, 'resizeStrategy.changeBps');
  if (change === 0n || (resize.operation === 'DECREASE' && change >= BPS)) {
    throw new MalformedInputError('resizeStrategy.changeBps', 'a decrease is between 0 and 10000; use exit to close');
  }
  const legs = state.legs.map((leg) => {
    const delta = ((leg.signedQuantityAtoms * change) / BPS / leg.lotAtoms) * leg.lotAtoms;
    return { ...leg, signedQuantityAtoms: resize.operation === 'INCREASE' ? leg.signedQuantityAtoms + delta : leg.signedQuantityAtoms - delta };
  });
  if (legs.some((leg, index) => leg.signedQuantityAtoms === (state.legs[index] as StrategyLeg).signedQuantityAtoms)) return reject('CHANGE_BELOW_LOT');
  if (!ratioHolds(legs)) return reject('RATIO_BROKEN');
  const liabilities = state.liabilities.map((liability) => {
    const product = liability.atoms * change;
    const delta = resize.operation === 'INCREASE' ? (product + BPS - 1n) / BPS : product / BPS;
    return { ...liability, atoms: resize.operation === 'INCREASE' ? liability.atoms + delta : liability.atoms - delta };
  });
  return accept(resize.operation, context, [state], [next(state, { legs, liabilities })], true);
}

export type StrategyPackageTransitionOperation = 'ROLL' | 'MIGRATE' | 'REBALANCE' | 'INCREASE' | 'DECREASE' | 'EXIT' | 'EMERGENCY_UNWIND';

function sameLegIdentity(left: StrategyLeg, right: StrategyLeg): boolean {
  return left.legId === right.legId && left.underlyingId === right.underlyingId && left.instrumentId === right.instrumentId
    && left.venueId === right.venueId && left.lotAtoms === right.lotAtoms && left.ratioNumerator === right.ratioNumerator
    && left.ratioDenominator === right.ratioDenominator;
}

function sameLiabilityIdentity(left: StrategyLiability, right: StrategyLiability): boolean {
  return left.liabilityId === right.liabilityId && left.kind === right.kind && left.assetId === right.assetId && left.transferable === right.transferable;
}

function sameIdentitySet<T>(left: readonly T[], right: readonly T[], same: (a: T, b: T) => boolean): boolean {
  return left.length === right.length && left.every((value, index) => same(value, right[index] as T));
}

function sameRollExposureSet(left: readonly StrategyLeg[], right: readonly StrategyLeg[]): boolean {
  if (left.length !== right.length) return false;
  const matched = new Set<number>();
  return left.every((leg) => {
    const index = right.findIndex((candidate, candidateIndex) => !matched.has(candidateIndex)
      && candidate.underlyingId === leg.underlyingId
      && candidate.venueId === leg.venueId
      && candidate.signedQuantityAtoms === leg.signedQuantityAtoms
      && candidate.ratioNumerator === leg.ratioNumerator
      && candidate.ratioDenominator === leg.ratioDenominator);
    if (index === -1) return false;
    matched.add(index);
    return true;
  });
}

function grossExposure(state: StrategyState): bigint {
  return state.legs.reduce((sum, leg) => sum + absBigInt(leg.signedQuantityAtoms), 0n);
}

function liabilityIncreased(prior: StrategyState, candidate: StrategyState): boolean {
  return candidate.liabilities.some((liability) => {
    const previous = prior.liabilities.find((value) => value.liabilityId === liability.liabilityId);
    return previous === undefined || previous.assetId !== liability.assetId || liability.atoms > previous.atoms;
  });
}

/** Applies a complete receipt-bound package state after its external venue actions have settled. */
export function applyPackageStateTransition(
  input: StrategyState,
  context: StrategyTransitionContext,
  operation: StrategyPackageTransitionOperation,
  nextInput: StrategyState,
): StrategyTransitionResult {
  const state = strategyState(input);
  if (!['ROLL', 'MIGRATE', 'REBALANCE', 'INCREASE', 'DECREASE', 'EXIT', 'EMERGENCY_UNWIND'].includes(operation)) {
    throw new MalformedInputError('applyPackageStateTransition.operation', 'unsupported package transition');
  }
  const failure = authorize(state, context, operation);
  if (failure !== undefined) return reject(failure);
  const candidate = strategyState(nextInput, 'applyPackageStateTransition.nextState');
  for (const leg of candidate.legs) {
    const prior = state.legs.find((value) => value.legId === leg.legId);
    if (prior !== undefined && !sameLegIdentity(prior, leg)) {
      throw new MalformedInputError('applyPackageStateTransition.nextState.legs', 'changed leg terms require a new leg identity');
    }
  }
  for (const liability of candidate.liabilities) {
    const prior = state.liabilities.find((value) => value.liabilityId === liability.liabilityId);
    if (prior !== undefined && !sameLiabilityIdentity(prior, liability)) {
      throw new MalformedInputError('applyPackageStateTransition.nextState.liabilities', 'changed liability terms require a new liability identity');
    }
  }
  if (
    candidate.strategyId !== state.strategyId || candidate.ownerId !== state.ownerId || candidate.subaccountId !== state.subaccountId
    || candidate.seriesId !== state.seriesId || candidate.executionClassId !== state.executionClassId
    || candidate.venuePositionsTransferable !== state.venuePositionsTransferable
    || candidate.legalTransferRestricted !== state.legalTransferRestricted
    || candidate.stateVersion !== state.stateVersion + 1n
  ) {
    throw new MalformedInputError('applyPackageStateTransition.nextState', 'package execution cannot change strategy identity, ownership, terms, or skip a state version');
  }
  if (operation === 'EXIT' || operation === 'EMERGENCY_UNWIND') {
    if (candidate.open) throw new MalformedInputError('applyPackageStateTransition.nextState.open', 'an unwind must close the strategy');
    if (candidate.legs.some((leg) => leg.signedQuantityAtoms !== 0n)) throw new MalformedInputError('applyPackageStateTransition.nextState.legs', 'an unwind must flatten every strategy leg');
    if (candidate.delegations.length !== 0) throw new MalformedInputError('applyPackageStateTransition.nextState.delegations', 'a closed strategy keeps no delegation');
    if (candidate.liabilities.some((liability) => {
      const prior = state.liabilities.find((value) => value.liabilityId === liability.liabilityId);
      return prior === undefined || !sameLiabilityIdentity(prior, liability) || liability.atoms > prior.atoms;
    })) {
      return reject('UNAUTHORIZED');
    }
  } else if (!candidate.open) {
    throw new MalformedInputError('applyPackageStateTransition.nextState.open', 'only an exit or emergency unwind may close the strategy');
  } else if (
    candidate.delegations.length !== state.delegations.length
    || candidate.delegations.some((delegation, index) => {
      const prior = state.delegations[index];
      return prior === undefined || delegation.delegateId !== prior.delegateId || delegation.expiresAtValue !== prior.expiresAtValue
        || delegation.authorities.length !== prior.authorities.length
        || delegation.authorities.some((authority, authorityIndex) => authority !== prior.authorities[authorityIndex]);
    })
  ) {
    throw new MalformedInputError('applyPackageStateTransition.nextState.delegations', 'package execution cannot change delegations');
  }
  if (operation === 'REBALANCE' || operation === 'INCREASE' || operation === 'DECREASE') {
    if (!sameIdentitySet(state.legs, candidate.legs, sameLegIdentity) || !sameIdentitySet(state.liabilities, candidate.liabilities, sameLiabilityIdentity)) {
      throw new MalformedInputError('applyPackageStateTransition.nextState', 'this operation may change quantities but not position or liability identities');
    }
  }
  if (operation === 'ROLL') {
    if (!sameRollExposureSet(state.legs, candidate.legs) || !sameIdentitySet(state.liabilities, candidate.liabilities, sameLiabilityIdentity)) {
      throw new MalformedInputError('applyPackageStateTransition.nextState', 'a roll preserves leg count and liability identities');
    }
    if (state.liabilities.some((liability, index) => liability.atoms !== candidate.liabilities[index]?.atoms)) {
      throw new MalformedInputError('applyPackageStateTransition.nextState.liabilities', 'a roll cannot change liabilities');
    }
  }
  if (operation === 'INCREASE' && grossExposure(candidate) <= grossExposure(state)) return reject('CHANGE_BELOW_LOT');
  if (operation === 'DECREASE' && grossExposure(candidate) >= grossExposure(state)) return reject('CHANGE_BELOW_LOT');
  if (operation === 'DECREASE' && liabilityIncreased(state, candidate)) return reject('UNAUTHORIZED');
  const actor = protocolId(context.actorId, 'applyPackageStateTransition.context.actorId');
  if (actor !== state.ownerId && (grossExposure(candidate) > grossExposure(state) || liabilityIncreased(state, candidate))) {
    return reject('UNAUTHORIZED');
  }
  return accept(operation, context, [state], [candidate], true);
}

export interface LiabilitySettlement {
  readonly liabilityId: string;
  readonly settledAtoms: bigint;
  /** Hash of the repayment or release evidence. */
  readonly evidenceHash: Uint8Array | string;
}

/**
 * Closes every leg together. A liability is removed only when a settlement for its full amount,
 * with evidence, is supplied; anything unsettled stays on the closed strategy as an open
 * liability rather than disappearing. A closed strategy accepts no further operation.
 */
export function exitStrategy(
  input: StrategyState,
  context: StrategyTransitionContext,
  settlements: readonly LiabilitySettlement[] = [],
): StrategyTransitionResult {
  const state = strategyState(input);
  const failure = authorize(state, context, 'EXIT');
  if (failure !== undefined) return reject(failure);
  requireArray(settlements, 'exitStrategy.settlements', STRATEGY_MAX_LEGS * 4);
  const settled = new Map<string, { liabilityId: ProtocolId; settledAtoms: bigint; evidenceHash: CommitmentHash }>();
  for (const [index, settlement] of settlements.entries()) {
    const at = `exitStrategy.settlements[${index}]`;
    object(settlement, at);
    const liabilityId = protocolId(settlement.liabilityId, `${at}.liabilityId`);
    const liability = state.liabilities.find((value) => value.liabilityId === liabilityId);
    if (liability === undefined) throw new MalformedInputError(`${at}.liabilityId`, 'no such liability');
    if (settled.has(liabilityId)) throw new MalformedInputError(`${at}.liabilityId`, 'a liability is settled twice');
    const settledAtoms = unsigned(settlement.settledAtoms, U128_BITS, `${at}.settledAtoms`);
    if (settledAtoms !== liability.atoms) throw new MalformedInputError(`${at}.settledAtoms`, 'a settlement covers the full liability');
    settled.set(liabilityId, { liabilityId, settledAtoms, evidenceHash: commitmentHash(settlement.evidenceHash, `${at}.evidenceHash`) });
  }
  const legs = state.legs.map((leg) => ({ ...leg, signedQuantityAtoms: 0n }));
  const liabilities = state.liabilities.filter((liability) => !settled.has(liability.liabilityId));
  const ordered = state.liabilities.flatMap((liability) => settled.get(liability.liabilityId) ?? []);
  return accept('EXIT', context, [state], [next(state, { open: false, legs, liabilities, delegations: [] })], true, ordered);
}

/** A pre-authorized emergency path closes every position under a distinct auditable operation. */
export function emergencyUnwindStrategy(
  input: StrategyState,
  context: StrategyTransitionContext,
  settlements: readonly LiabilitySettlement[] = [],
): StrategyTransitionResult {
  const state = strategyState(input);
  const failure = authorize(state, context, 'EMERGENCY_UNWIND');
  if (failure !== undefined) return reject(failure);
  requireArray(settlements, 'emergencyUnwindStrategy.settlements', STRATEGY_MAX_LEGS * 4);
  const settled = new Map<string, { liabilityId: ProtocolId; settledAtoms: bigint; evidenceHash: CommitmentHash }>();
  for (const [index, settlement] of settlements.entries()) {
    const at = `emergencyUnwindStrategy.settlements[${index}]`;
    object(settlement, at);
    const liabilityId = protocolId(settlement.liabilityId, `${at}.liabilityId`);
    const liability = state.liabilities.find((value) => value.liabilityId === liabilityId);
    if (liability === undefined) throw new MalformedInputError(`${at}.liabilityId`, 'no such liability');
    if (settled.has(liabilityId)) throw new MalformedInputError(`${at}.liabilityId`, 'a liability is settled twice');
    const settledAtoms = unsigned(settlement.settledAtoms, U128_BITS, `${at}.settledAtoms`);
    if (settledAtoms !== liability.atoms) throw new MalformedInputError(`${at}.settledAtoms`, 'a settlement covers the full liability');
    settled.set(liabilityId, { liabilityId, settledAtoms, evidenceHash: commitmentHash(settlement.evidenceHash, `${at}.evidenceHash`) });
  }
  const legs = state.legs.map((leg) => ({ ...leg, signedQuantityAtoms: 0n }));
  const liabilities = state.liabilities.filter((liability) => !settled.has(liability.liabilityId));
  const ordered = state.liabilities.flatMap((liability) => settled.get(liability.liabilityId) ?? []);
  return accept('EMERGENCY_UNWIND', context, [state], [next(state, { open: false, legs, liabilities, delegations: [] })], true, ordered);
}

/**
 * Adopts externally observed leg quantities as the new baseline. Only the owner can do this, and
 * the version bump invalidates every transition prepared against the old state.
 */
export function adoptObservedBaseline(
  input: StrategyState,
  context: StrategyTransitionContext,
  observed: readonly { readonly legId: string; readonly signedQuantityAtoms: bigint }[],
): StrategyTransitionResult {
  const state = strategyState(input);
  const failure = authorize(state, context, 'ADOPT_BASELINE');
  if (failure !== undefined) return reject(failure);
  requireArray(observed, 'adoptObservedBaseline.observed', STRATEGY_MAX_LEGS);
  if (observed.length !== state.legs.length) throw new MalformedInputError('adoptObservedBaseline.observed', 'every leg needs an observation');
  const legs = state.legs.map((leg) => {
    const value = observed.find((item) => protocolId(item.legId, 'adoptObservedBaseline.legId') === leg.legId);
    if (value === undefined) throw new MalformedInputError('adoptObservedBaseline.observed', `no observation for ${leg.legId}`);
    return { ...leg, signedQuantityAtoms: signed(value.signedQuantityAtoms, 'adoptObservedBaseline.signedQuantityAtoms') };
  });
  return accept('ADOPT_BASELINE', context, [state], [next(state, { legs })], false);
}

/** True when observed venue state no longer matches the strategy, so automation must stop. */
export function strategyDiverges(input: StrategyState, observed: readonly { readonly legId: string; readonly signedQuantityAtoms: bigint }[]): boolean {
  const state = strategyState(input);
  requireArray(observed, 'strategyDiverges.observed', STRATEGY_MAX_LEGS);
  return (
    observed.length !== state.legs.length ||
    state.legs.some((leg) => observed.find((item) => item.legId === leg.legId)?.signedQuantityAtoms !== leg.signedQuantityAtoms)
  );
}
