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
} as const);
export type StrategyOperation = keyof typeof STRATEGY_OPERATION;

/** The only operations an owner can delegate. None of them can move ownership or add risk. */
export const DELEGABLE_AUTHORITY = Object.freeze({
  REBALANCE: 1,
  ROLL: 2,
  DECREASE: 3,
  EXIT: 4,
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
      return Object.freeze({
        liabilityId: protocolId(liability.liabilityId, `${at}.liabilityId`),
        kind: variant(LIABILITY_KIND, liability.kind, `${at}.kind`),
        assetId: protocolId(liability.assetId, `${at}.assetId`),
        atoms: unsigned(liability.atoms, U128_BITS, `${at}.atoms`),
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
      requireArray(delegation.authorities, `${at}.authorities`, 4);
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
  const firstLiabilities = state.liabilities.map((liability) => ({ ...liability, atoms: (liability.atoms * share) / BPS }));
  const secondLiabilities = state.liabilities.map((liability, index) => ({ ...liability, atoms: liability.atoms - (firstLiabilities[index] as StrategyLiability).atoms }));
  const child = (strategyId: ProtocolId, legs: StrategyLeg[], liabilities: StrategyLiability[]) =>
    strategyState({ ...state, strategyId, legs, liabilities, delegations: [], stateVersion: 1n });
  return accept('SPLIT', context, [state], [child(firstId, firstLegs, firstLiabilities), child(secondId, secondLegs, secondLiabilities)], false);
}

function sameTerms(left: StrategyState, right: StrategyState): boolean {
  const legKey = (leg: StrategyLeg) => [leg.legId, leg.underlyingId, leg.instrumentId, leg.venueId, leg.lotAtoms, leg.ratioNumerator, leg.ratioDenominator].join('|');
  const liabilityKey = (liability: StrategyLiability) => [liability.liabilityId, liability.kind, liability.assetId, liability.transferable].join('|');
  return (
    left.ownerId === right.ownerId &&
    left.subaccountId === right.subaccountId &&
    left.seriesId === right.seriesId &&
    left.executionClassId === right.executionClassId &&
    left.venuePositionsTransferable === right.venuePositionsTransferable &&
    left.legalTransferRestricted === right.legalTransferRestricted &&
    left.legs.map(legKey).join(';') === right.legs.map(legKey).join(';') &&
    left.liabilities.map(liabilityKey).join(';') === right.liabilities.map(liabilityKey).join(';')
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
  return accept(resize.operation, context, [state], [next(state, { legs })], true);
}

/** Closes every leg together and settles every liability. A closed strategy accepts no further operation. */
export function exitStrategy(input: StrategyState, context: StrategyTransitionContext): StrategyTransitionResult {
  const state = strategyState(input);
  const failure = authorize(state, context, 'EXIT');
  if (failure !== undefined) return reject(failure);
  const legs = state.legs.map((leg) => ({ ...leg, signedQuantityAtoms: 0n }));
  return accept('EXIT', context, [state], [next(state, { open: false, legs, liabilities: [], delegations: [] })], true);
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
