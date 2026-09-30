import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { toHex } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';
import {
  assignInternal,
  adoptObservedBaseline,
  DELEGABLE_AUTHORITY,
  delegateManagement,
  encodeStrategyState,
  exitStrategy,
  mergeStrategies,
  moveLeg,
  novateStrategy,
  rebalanceStrategy,
  resizeStrategy,
  revokeDelegation,
  splitStrategy,
  strategyState,
  type DelegableAuthority,
  type StrategyState,
  type StrategyTransitionContext,
  type StrategyTransitionResult,
} from './strategy-lifecycle.js';
import { requiresSuccessfulReceipt, type PackageReceiptInput } from './terminal-outcome.js';

export const STRATEGY_COMMAND_VERSION = 1;

/**
 * The strategy operations an actor can sign. OPEN through MERGE change accounting, labels, or
 * authority only. ROLL, MIGRATE, REBALANCE, INCREASE, DECREASE, and EXIT record position moves
 * that already settled: each binds the settled package receipts that executed it, and the book
 * accepts it only when those receipts account for the exact per-venue change. NOVATE needs the
 * new owner's consent and verified transfer evidence from every venue holding a leg.
 * ADOPT_BASELINE is the owner's acknowledgement of externally observed quantities.
 */
export const STRATEGY_COMMAND_KIND = Object.freeze({
  OPEN: 1,
  ASSIGN_INTERNAL: 2,
  DELEGATE: 3,
  REVOKE_DELEGATION: 4,
  SPLIT: 5,
  MERGE: 6,
  NOVATE: 7,
  ROLL: 8,
  MIGRATE: 9,
  REBALANCE: 10,
  INCREASE: 11,
  DECREASE: 12,
  EXIT: 13,
  ADOPT_BASELINE: 14,
} as const);
export type StrategyCommandKind = keyof typeof STRATEGY_COMMAND_KIND;

export type StrategyCommandParameters =
  /** Opens a strategy from exactly one settled entry receipt, which no other strategy may claim. */
  | { readonly kind: 'OPEN'; readonly originReceiptHash: Uint8Array | string; readonly state: StrategyState }
  | { readonly kind: 'ASSIGN_INTERNAL'; readonly subaccountId: string }
  | { readonly kind: 'DELEGATE'; readonly delegateId: string; readonly authorities: readonly DelegableAuthority[]; readonly expiresAtValue: bigint }
  | { readonly kind: 'REVOKE_DELEGATION'; readonly delegateId: string }
  | { readonly kind: 'SPLIT'; readonly childStrategyIds: readonly [string, string]; readonly firstShareBps: bigint }
  /** Merges the command's strategy with `otherStrategyId`, binding that strategy's exact state too. */
  | {
    readonly kind: 'MERGE';
    readonly otherStrategyId: string;
    readonly otherExpectedStateVersion: bigint;
    readonly otherExpectedStateHash: Uint8Array | string;
    readonly mergedStrategyId: string;
  }
  /** Transfers the whole strategy; each venue confirmation names the evidence of its transfer. */
  | { readonly kind: 'NOVATE'; readonly newOwnerId: string; readonly venueConfirmations: readonly { readonly venueId: string; readonly evidenceHash: Uint8Array | string }[] }
  | {
    readonly kind: 'ROLL' | 'MIGRATE';
    readonly legId: string;
    readonly newLegId: string;
    readonly newInstrumentId: string;
    readonly newVenueId: string;
    readonly newLotAtoms: bigint;
    readonly executionReceiptHashes: readonly (Uint8Array | string)[];
  }
  | {
    readonly kind: 'REBALANCE';
    readonly targets: readonly { readonly legId: string; readonly signedQuantityAtoms: bigint; readonly maximumChangeAtoms: bigint }[];
    readonly executionReceiptHashes: readonly (Uint8Array | string)[];
  }
  | { readonly kind: 'INCREASE' | 'DECREASE'; readonly changeBps: bigint; readonly executionReceiptHashes: readonly (Uint8Array | string)[] }
  | {
    readonly kind: 'EXIT';
    readonly settlements: readonly { readonly liabilityId: string; readonly settledAtoms: bigint; readonly evidenceHash: Uint8Array | string }[];
    readonly executionReceiptHashes: readonly (Uint8Array | string)[];
  }
  | { readonly kind: 'ADOPT_BASELINE'; readonly observed: readonly { readonly legId: string; readonly signedQuantityAtoms: bigint }[] };

/** Position-moving commands bind 1 to 8 distinct settled receipts. */
export const STRATEGY_MAX_EXECUTION_RECEIPTS = 8;
const MAX_ITEMS = 16;

/**
 * One signed instruction to the strategy book. The actor signs its hash; every command binds the
 * exact prior state version and hash, so a command can never apply to a state its signer did not
 * see, and `atValue` is Unix milliseconds that the book holds within a bounded skew of its clock.
 */
export interface StrategyCommandInput {
  readonly commandVersion: number;
  readonly environment: string;
  readonly strategyId: string;
  readonly actorId: string;
  readonly expectedStateVersion: bigint;
  readonly expectedStateHash: Uint8Array | string;
  readonly atValue: bigint;
  readonly parameters: StrategyCommandParameters;
}

const U64 = 64;
const ZERO_HASH = '00'.repeat(32);

function u64(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, U64, context);
}

function list<T>(values: readonly T[] | undefined, context: string, minimum: number, maximum = MAX_ITEMS): readonly T[] {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) throw new MalformedInputError(context, `expected ${minimum} to ${maximum} entries`);
  return values;
}

/** The bound receipt hashes, validated, distinct, and in ascending order. */
export function strategyExecutionReceiptHashes(parameters: StrategyCommandParameters): readonly CommitmentHash[] {
  if (!('executionReceiptHashes' in parameters)) return Object.freeze([]);
  const hashes = list(parameters.executionReceiptHashes, 'strategyCommand.executionReceiptHashes', 1, STRATEGY_MAX_EXECUTION_RECEIPTS)
    .map((value) => commitmentHash(value, 'strategyCommand.executionReceiptHashes'))
    .sort((left, right) => (toHex(left) < toHex(right) ? -1 : 1));
  for (let i = 1; i < hashes.length; i += 1) {
    if (toHex(hashes[i - 1] as CommitmentHash) === toHex(hashes[i] as CommitmentHash)) throw new DuplicateElementError('strategyCommand.executionReceiptHashes', 'a receipt is bound twice');
  }
  return Object.freeze(hashes);
}

function encodeReceipts(writer: CanonicalWriter, parameters: StrategyCommandParameters): void {
  writer.writeArray(strategyExecutionReceiptHashes(parameters), (inner, hash) => encodeCommitmentHash(inner, hash, 'executionReceiptHash'), 'executionReceiptHashes');
}

function encodeParameters(writer: CanonicalWriter, parameters: StrategyCommandParameters): void {
  if (typeof parameters !== 'object' || parameters === null) throw new MalformedInputError('strategyCommand.parameters', 'expected an object');
  if (!Object.hasOwn(STRATEGY_COMMAND_KIND, parameters.kind)) throw new MalformedInputError('strategyCommand.parameters.kind', 'unknown command');
  writer.writeEnum(STRATEGY_COMMAND_KIND, parameters.kind, 'kind');
  switch (parameters.kind) {
    case 'OPEN':
      encodeCommitmentHash(writer, commitmentHash(parameters.originReceiptHash, 'strategyCommand.originReceiptHash'), 'originReceiptHash');
      encodeStrategyState(writer, parameters.state);
      return;
    case 'ASSIGN_INTERNAL':
      encodeProtocolId(writer, protocolId(parameters.subaccountId, 'strategyCommand.subaccountId'), 'subaccountId');
      return;
    case 'DELEGATE': {
      encodeProtocolId(writer, protocolId(parameters.delegateId, 'strategyCommand.delegateId'), 'delegateId');
      if (!Array.isArray(parameters.authorities) || parameters.authorities.length === 0 || parameters.authorities.length > 4) {
        throw new MalformedInputError('strategyCommand.authorities', 'expected 1 to 4 delegable authorities');
      }
      const sorted = [...new Set<DelegableAuthority>(parameters.authorities)].sort((left, right) => DELEGABLE_AUTHORITY[left] - DELEGABLE_AUTHORITY[right]);
      if (sorted.length !== parameters.authorities.length) throw new MalformedInputError('strategyCommand.authorities', 'authorities repeat');
      writer.writeArray(sorted, (inner, authority) => inner.writeEnum(DELEGABLE_AUTHORITY, authority, 'authority'), 'authorities');
      writer.writeU64(u64(parameters.expiresAtValue, 'strategyCommand.expiresAtValue'), 'expiresAtValue');
      return;
    }
    case 'REVOKE_DELEGATION':
      encodeProtocolId(writer, protocolId(parameters.delegateId, 'strategyCommand.delegateId'), 'delegateId');
      return;
    case 'SPLIT':
      if (!Array.isArray(parameters.childStrategyIds) || parameters.childStrategyIds.length !== 2) {
        throw new MalformedInputError('strategyCommand.childStrategyIds', 'a split names exactly two children');
      }
      for (const child of parameters.childStrategyIds) encodeProtocolId(writer, protocolId(child, 'strategyCommand.childStrategyId'), 'childStrategyId');
      writer.writeU64(u64(parameters.firstShareBps, 'strategyCommand.firstShareBps'), 'firstShareBps');
      return;
    case 'MERGE':
      encodeProtocolId(writer, protocolId(parameters.otherStrategyId, 'strategyCommand.otherStrategyId'), 'otherStrategyId');
      writer.writeU64(u64(parameters.otherExpectedStateVersion, 'strategyCommand.otherExpectedStateVersion'), 'otherExpectedStateVersion');
      encodeCommitmentHash(writer, commitmentHash(parameters.otherExpectedStateHash, 'strategyCommand.otherExpectedStateHash'), 'otherExpectedStateHash');
      encodeProtocolId(writer, protocolId(parameters.mergedStrategyId, 'strategyCommand.mergedStrategyId'), 'mergedStrategyId');
      return;
    case 'NOVATE':
      encodeProtocolId(writer, protocolId(parameters.newOwnerId, 'strategyCommand.newOwnerId'), 'newOwnerId');
      writer.writeArray(list(parameters.venueConfirmations, 'strategyCommand.venueConfirmations', 1), (inner, confirmation) => {
        encodeProtocolId(inner, protocolId(confirmation.venueId, 'strategyCommand.venueConfirmations.venueId'), 'venueId');
        encodeCommitmentHash(inner, commitmentHash(confirmation.evidenceHash, 'strategyCommand.venueConfirmations.evidenceHash'), 'evidenceHash');
      }, 'venueConfirmations');
      return;
    case 'ROLL':
    case 'MIGRATE':
      encodeProtocolId(writer, protocolId(parameters.legId, 'strategyCommand.legId'), 'legId');
      encodeProtocolId(writer, protocolId(parameters.newLegId, 'strategyCommand.newLegId'), 'newLegId');
      encodeProtocolId(writer, protocolId(parameters.newInstrumentId, 'strategyCommand.newInstrumentId'), 'newInstrumentId');
      encodeProtocolId(writer, protocolId(parameters.newVenueId, 'strategyCommand.newVenueId'), 'newVenueId');
      writer.writeU128(checkedUnsigned(parameters.newLotAtoms, 128, 'strategyCommand.newLotAtoms'), 'newLotAtoms');
      encodeReceipts(writer, parameters);
      return;
    case 'REBALANCE':
      writer.writeArray(list(parameters.targets, 'strategyCommand.targets', 1), (inner, target) => {
        encodeProtocolId(inner, protocolId(target.legId, 'strategyCommand.targets.legId'), 'legId');
        inner.writeI128(checkedSigned(target.signedQuantityAtoms, 128, 'strategyCommand.targets.signedQuantityAtoms'), 'signedQuantityAtoms');
        inner.writeU128(checkedUnsigned(target.maximumChangeAtoms, 128, 'strategyCommand.targets.maximumChangeAtoms'), 'maximumChangeAtoms');
      }, 'targets');
      encodeReceipts(writer, parameters);
      return;
    case 'INCREASE':
    case 'DECREASE':
      writer.writeU64(u64(parameters.changeBps, 'strategyCommand.changeBps'), 'changeBps');
      encodeReceipts(writer, parameters);
      return;
    case 'EXIT':
      writer.writeArray(list(parameters.settlements, 'strategyCommand.settlements', 0, MAX_ITEMS * 4), (inner, settlement) => {
        encodeProtocolId(inner, protocolId(settlement.liabilityId, 'strategyCommand.settlements.liabilityId'), 'liabilityId');
        inner.writeU128(checkedUnsigned(settlement.settledAtoms, 128, 'strategyCommand.settlements.settledAtoms'), 'settledAtoms');
        encodeCommitmentHash(inner, commitmentHash(settlement.evidenceHash, 'strategyCommand.settlements.evidenceHash'), 'evidenceHash');
      }, 'settlements');
      encodeReceipts(writer, parameters);
      return;
    case 'ADOPT_BASELINE':
      writer.writeArray(list(parameters.observed, 'strategyCommand.observed', 1), (inner, entry) => {
        encodeProtocolId(inner, protocolId(entry.legId, 'strategyCommand.observed.legId'), 'legId');
        inner.writeI128(checkedSigned(entry.signedQuantityAtoms, 128, 'strategyCommand.observed.signedQuantityAtoms'), 'signedQuantityAtoms');
      }, 'observed');
      return;
  }
}

export function strategyCommandBytes(input: StrategyCommandInput): Uint8Array {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError('strategyCommand', 'expected an object');
  if (input.commandVersion !== STRATEGY_COMMAND_VERSION) throw new MalformedInputError('strategyCommand.commandVersion', `version must equal ${STRATEGY_COMMAND_VERSION}`);
  const open = input.parameters?.kind === 'OPEN';
  // Opening has no prior state: it binds version zero and the zero hash.
  if (open && (input.expectedStateVersion !== 0n || (typeof input.expectedStateHash === 'string' ? input.expectedStateHash !== ZERO_HASH : input.expectedStateHash.some((byte) => byte !== 0)))) {
    throw new MalformedInputError('strategyCommand.expectedState', 'opening a strategy binds version zero and the zero hash');
  }
  return canonicalBytes((writer) => {
    writer.writeU32(STRATEGY_COMMAND_VERSION, 'commandVersion');
    encodeProtocolId(writer, protocolId(input.environment, 'strategyCommand.environment'), 'environment');
    encodeProtocolId(writer, protocolId(input.strategyId, 'strategyCommand.strategyId'), 'strategyId');
    encodeProtocolId(writer, protocolId(input.actorId, 'strategyCommand.actorId'), 'actorId');
    writer.writeU64(u64(input.expectedStateVersion, 'strategyCommand.expectedStateVersion'), 'expectedStateVersion');
    writer.writeFixedBytes(open ? new Uint8Array(32) : commitmentHash(input.expectedStateHash, 'strategyCommand.expectedStateHash'), 32, 'expectedStateHash');
    writer.writeU64(u64(input.atValue, 'strategyCommand.atValue'), 'atValue');
    encodeParameters(writer, input.parameters);
  });
}

export function strategyCommandHash(input: StrategyCommandInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.STRATEGY_COMMAND, strategyCommandBytes(input)), 'strategyCommandHash');
}

export type StrategyCommandOutcome =
  | { readonly kind: 'OPENED'; readonly state: StrategyState }
  | { readonly kind: 'TRANSITIONED'; readonly result: StrategyTransitionResult };

/**
 * What the book verified outside the command itself: owners whose consent signatures over the
 * command hash verified, and venues whose transfer evidence verified. Absent evidence never
 * satisfies a novation.
 */
export interface StrategyCommandEvidence {
  readonly consentingOwnerIds?: readonly string[];
  readonly confirmedVenueIds?: readonly string[];
}

/**
 * Applies one command through the kernel's lifecycle rules. `states` holds the current state of
 * every strategy the command names (the command's own and, for a merge, the other). An OPEN
 * yields the new state, which must name the command's strategy and actor as its owner at version
 * one; every other command returns the kernel's transition result unchanged. Position-moving
 * commands are checked against their settled receipts separately, with `strategyExecutionMatches`.
 */
export function applyStrategyCommand(input: StrategyCommandInput, states: ReadonlyMap<string, StrategyState>, evidence: StrategyCommandEvidence = {}): StrategyCommandOutcome {
  strategyCommandBytes(input);
  const parameters = input.parameters;
  if (parameters.kind === 'OPEN') {
    const state = strategyState(parameters.state, 'strategyCommand.state');
    if (state.strategyId !== input.strategyId || state.ownerId !== input.actorId || state.stateVersion !== 1n || !state.open || state.delegations.length > 0) {
      throw new MalformedInputError('strategyCommand.state', 'an opened strategy is the command\'s own, owned by its signer, open, undelegated, at version one');
    }
    return Object.freeze({ kind: 'OPENED' as const, state });
  }
  const current = states.get(input.strategyId);
  if (current === undefined) throw new MalformedInputError('strategyCommand.strategyId', 'no such strategy');
  const context: StrategyTransitionContext = {
    actorId: input.actorId,
    expectedStateVersion: input.expectedStateVersion,
    expectedStateHash: input.expectedStateHash,
    atValue: input.atValue,
  };
  const transitioned = (result: StrategyTransitionResult) => Object.freeze({ kind: 'TRANSITIONED' as const, result });
  switch (parameters.kind) {
    case 'ASSIGN_INTERNAL':
      return transitioned(assignInternal(current, context, parameters.subaccountId));
    case 'DELEGATE':
      return transitioned(delegateManagement(current, context, { delegateId: parameters.delegateId, authorities: parameters.authorities, expiresAtValue: parameters.expiresAtValue }));
    case 'REVOKE_DELEGATION':
      return transitioned(revokeDelegation(current, context, parameters.delegateId));
    case 'SPLIT':
      return transitioned(splitStrategy(current, context, { childStrategyIds: parameters.childStrategyIds, firstShareBps: parameters.firstShareBps }));
    case 'MERGE': {
      const other = states.get(parameters.otherStrategyId);
      if (other === undefined) throw new MalformedInputError('strategyCommand.otherStrategyId', 'no such strategy');
      return transitioned(
        mergeStrategies(
          current,
          other,
          [context, { actorId: input.actorId, expectedStateVersion: parameters.otherExpectedStateVersion, expectedStateHash: parameters.otherExpectedStateHash, atValue: input.atValue }],
          parameters.mergedStrategyId,
        ),
      );
    }
    case 'NOVATE': {
      // The signer consents by signing; the new owner's consent and every venue's transfer
      // evidence are what the book verified, never what the command claims.
      const confirmed = new Set(evidence.confirmedVenueIds ?? []);
      return transitioned(novateStrategy(current, context, {
        newOwnerId: parameters.newOwnerId,
        consentingOwnerIds: [input.actorId, ...(evidence.consentingOwnerIds ?? [])].slice(0, 4),
        confirmingVenueIds: parameters.venueConfirmations.map((confirmation) => confirmation.venueId).filter((venueId) => confirmed.has(venueId)),
      }));
    }
    case 'ROLL':
    case 'MIGRATE':
      return transitioned(moveLeg(current, context, {
        operation: parameters.kind,
        legId: parameters.legId,
        newLegId: parameters.newLegId,
        newInstrumentId: parameters.newInstrumentId,
        newVenueId: parameters.newVenueId,
        newLotAtoms: parameters.newLotAtoms,
      }));
    case 'REBALANCE':
      return transitioned(rebalanceStrategy(current, context, parameters.targets));
    case 'INCREASE':
    case 'DECREASE':
      return transitioned(resizeStrategy(current, context, { operation: parameters.kind, changeBps: parameters.changeBps }));
    case 'EXIT':
      return transitioned(exitStrategy(current, context, parameters.settlements));
    case 'ADOPT_BASELINE':
      return transitioned(adoptObservedBaseline(current, context, parameters.observed));
  }
}

export type StrategyExecutionMismatch =
  | 'RECEIPT_NOT_SETTLED'
  | 'RECEIPT_OWNER_MISMATCH'
  | 'RECEIPT_MARKET_MISMATCH'
  | 'RECEIPT_ACTION_MISMATCH'
  | 'RECEIPT_SPOT_DELTA_MISSING'
  | 'EXECUTION_MISMATCH';

function venueTotals(entries: readonly (readonly [string, bigint])[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const [venue, delta] of entries) totals.set(venue, (totals.get(venue) ?? 0n) + delta);
  for (const [venue, delta] of [...totals]) if (delta === 0n) totals.delete(venue);
  return totals;
}

/**
 * Whether settled package receipts account exactly for a position-moving transition. Every
 * receipt must be a successful terminal receipt of the strategy's owner; resize and exit receipts
 * must be in the strategy's own market, entries for an increase and exits for a decrease or exit.
 * The receipts' net spot and perpetual deltas, summed per venue, must equal the change in the
 * strategy's legs per venue, exactly. A roll or migration may use any market of the owner, since
 * the receiving instrument can trade elsewhere, but its per-venue totals still must balance.
 */
export function strategyExecutionMatches(
  kind: StrategyCommandKind,
  prior: StrategyState,
  next: StrategyState,
  receipts: readonly PackageReceiptInput[],
): { readonly matches: true } | { readonly matches: false; readonly mismatch: StrategyExecutionMismatch } {
  const fail = (mismatch: StrategyExecutionMismatch) => Object.freeze({ matches: false as const, mismatch });
  if (receipts.length === 0) return fail('EXECUTION_MISMATCH');
  const moves: (readonly [string, bigint])[] = [];
  for (const receipt of receipts) {
    if (!requiresSuccessfulReceipt(receipt.terminalState)) return fail('RECEIPT_NOT_SETTLED');
    if (receipt.owner !== prior.ownerId) return fail('RECEIPT_OWNER_MISMATCH');
    if (kind !== 'ROLL' && kind !== 'MIGRATE' && receipt.packageMarketId !== prior.executionClassId) return fail('RECEIPT_MARKET_MISMATCH');
    if ((kind === 'INCREASE' && receipt.action !== 'ENTRY') || ((kind === 'DECREASE' || kind === 'EXIT') && receipt.action !== 'EXIT')) return fail('RECEIPT_ACTION_MISMATCH');
    if (receipt.netSpotDelta === undefined) return fail('RECEIPT_SPOT_DELTA_MISSING');
    moves.push([receipt.spotVenue, receipt.netSpotDelta], [receipt.perpVenue, receipt.perpPositionDelta]);
  }
  const executed = venueTotals(moves);
  const required = venueTotals([
    ...next.legs.map((leg) => [leg.venueId as string, leg.signedQuantityAtoms] as const),
    ...prior.legs.map((leg) => [leg.venueId as string, -leg.signedQuantityAtoms] as const),
  ]);
  if (executed.size !== required.size || [...required].some(([venue, delta]) => executed.get(venue) !== delta)) return fail('EXECUTION_MISMATCH');
  return Object.freeze({ matches: true as const });
}

/** The strategy ids a command reads: its own and, for a merge, the other. */
export function strategyCommandSubjects(input: StrategyCommandInput): readonly ProtocolId[] {
  const own = protocolId(input.strategyId, 'strategyCommand.strategyId');
  return input.parameters.kind === 'MERGE' ? Object.freeze([own, protocolId(input.parameters.otherStrategyId, 'strategyCommand.otherStrategyId')]) : Object.freeze([own]);
}
