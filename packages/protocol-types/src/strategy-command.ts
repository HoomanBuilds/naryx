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
  applyPackageStateTransition,
  DELEGABLE_AUTHORITY,
  delegateManagement,
  encodeStrategyState,
  exitStrategy,
  emergencyUnwindStrategy,
  mergeStrategies,
  moveLeg,
  moveStrategyLegs,
  novateStrategy,
  rebalanceStrategy,
  resizeStrategy,
  revokeDelegation,
  splitStrategy,
  STRATEGY_OPERATION,
  strategyState,
  type DelegableAuthority,
  type StrategyState,
  type StrategyPackageTransitionOperation,
  type StrategyTransitionContext,
  type StrategyTransitionResult,
} from './strategy-lifecycle.js';
import { requiresSuccessfulReceipt, type PackageReceiptInput } from './terminal-outcome.js';
import { strategyPackageReceipt, type StrategyPackageReceiptInput } from './strategy-package-receipt.js';

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
  ROLL_PACKAGE: 15,
  MIGRATE_PACKAGE: 16,
  EMERGENCY_UNWIND: 17,
  APPLY_PACKAGE: 18,
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
  | {
    readonly kind: 'ROLL_PACKAGE' | 'MIGRATE_PACKAGE';
    readonly moves: readonly {
      readonly legId: string;
      readonly newLegId: string;
      readonly newInstrumentId: string;
      readonly newVenueId: string;
      readonly newLotAtoms: bigint;
    }[];
    readonly executionReceiptHashes: readonly (Uint8Array | string)[];
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
    readonly kind: 'EMERGENCY_UNWIND';
    readonly settlements: readonly { readonly liabilityId: string; readonly settledAtoms: bigint; readonly evidenceHash: Uint8Array | string }[];
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
  | {
    readonly kind: 'APPLY_PACKAGE';
    readonly operation: StrategyPackageTransitionOperation;
    readonly nextState: StrategyState;
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
      if (!Array.isArray(parameters.authorities) || parameters.authorities.length === 0 || parameters.authorities.length > 5) {
        throw new MalformedInputError('strategyCommand.authorities', 'expected 1 to 5 delegable authorities');
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
    case 'ROLL_PACKAGE':
    case 'MIGRATE_PACKAGE':
      writer.writeArray(list(parameters.moves, 'strategyCommand.moves', 1), (inner, move) => {
        encodeProtocolId(inner, protocolId(move.legId, 'strategyCommand.moves.legId'), 'legId');
        encodeProtocolId(inner, protocolId(move.newLegId, 'strategyCommand.moves.newLegId'), 'newLegId');
        encodeProtocolId(inner, protocolId(move.newInstrumentId, 'strategyCommand.moves.newInstrumentId'), 'newInstrumentId');
        encodeProtocolId(inner, protocolId(move.newVenueId, 'strategyCommand.moves.newVenueId'), 'newVenueId');
        inner.writeU128(checkedUnsigned(move.newLotAtoms, 128, 'strategyCommand.moves.newLotAtoms'), 'newLotAtoms');
      }, 'moves');
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
    case 'EMERGENCY_UNWIND':
      writer.writeArray(list(parameters.settlements, 'strategyCommand.settlements', 0, MAX_ITEMS * 4), (inner, settlement) => {
        encodeProtocolId(inner, protocolId(settlement.liabilityId, 'strategyCommand.settlements.liabilityId'), 'liabilityId');
        inner.writeU128(checkedUnsigned(settlement.settledAtoms, 128, 'strategyCommand.settlements.settledAtoms'), 'settledAtoms');
        encodeCommitmentHash(inner, commitmentHash(settlement.evidenceHash, 'strategyCommand.settlements.evidenceHash'), 'evidenceHash');
      }, 'settlements');
      encodeReceipts(writer, parameters);
      return;
    case 'APPLY_PACKAGE':
      writer.writeEnum(STRATEGY_OPERATION, parameters.operation, 'operation');
      encodeStrategyState(writer, parameters.nextState);
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
    case 'ROLL_PACKAGE':
    case 'MIGRATE_PACKAGE':
      return transitioned(moveStrategyLegs(current, context, parameters.kind === 'ROLL_PACKAGE' ? 'ROLL' : 'MIGRATE', parameters.moves));
    case 'REBALANCE':
      return transitioned(rebalanceStrategy(current, context, parameters.targets));
    case 'INCREASE':
    case 'DECREASE':
      return transitioned(resizeStrategy(current, context, { operation: parameters.kind, changeBps: parameters.changeBps }));
    case 'EXIT':
      return transitioned(exitStrategy(current, context, parameters.settlements));
    case 'EMERGENCY_UNWIND':
      return transitioned(emergencyUnwindStrategy(current, context, parameters.settlements));
    case 'APPLY_PACKAGE':
      return transitioned(applyPackageStateTransition(current, context, parameters.operation, parameters.nextState));
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
  | 'EXECUTION_AMBIGUOUS'
  | 'EXECUTION_MISMATCH';

function venueTotals(entries: readonly (readonly [string, bigint])[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const [venue, delta] of entries) totals.set(venue, (totals.get(venue) ?? 0n) + delta);
  for (const [venue, delta] of [...totals]) if (delta === 0n) totals.delete(venue);
  return totals;
}

function sameTotals(left: Map<string, bigint>, right: Map<string, bigint>): boolean {
  return left.size === right.size && [...right].every(([venue, delta]) => left.get(venue) === delta);
}

export type StrategyExecutionReceiptInput = PackageReceiptInput | StrategyPackageReceiptInput;

function isStrategyPackageReceipt(receipt: StrategyExecutionReceiptInput): receipt is StrategyPackageReceiptInput {
  return 'legOutcomes' in receipt;
}

function stateLegDelta(prior: StrategyState, next: StrategyState): Map<string, bigint> {
  return venueTotals([
    ...next.legs.map((leg) => [leg.legId as string, leg.signedQuantityAtoms] as const),
    ...prior.legs.map((leg) => [leg.legId as string, -leg.signedQuantityAtoms] as const),
  ]);
}

interface LiabilityDelta {
  readonly assetId: string;
  readonly atoms: bigint;
}

function stateLiabilityDelta(prior: StrategyState, next: StrategyState): Map<string, LiabilityDelta> {
  const totals = new Map<string, LiabilityDelta>();
  for (const liability of prior.liabilities) totals.set(liability.liabilityId, { assetId: liability.assetId, atoms: -liability.atoms });
  for (const liability of next.liabilities) {
    const current = totals.get(liability.liabilityId);
    if (current !== undefined && current.assetId !== liability.assetId) throw new MalformedInputError('strategyExecution.next.liabilities', 'a liability identity changed asset');
    totals.set(liability.liabilityId, { assetId: liability.assetId, atoms: (current?.atoms ?? 0n) + liability.atoms });
  }
  for (const [liabilityId, delta] of totals) if (delta.atoms === 0n) totals.delete(liabilityId);
  return totals;
}

function sameLiabilityTotals(left: Map<string, LiabilityDelta>, right: Map<string, LiabilityDelta>): boolean {
  return left.size === right.size && [...right].every(([liabilityId, delta]) => {
    const executed = left.get(liabilityId);
    return executed?.assetId === delta.assetId && executed.atoms === delta.atoms;
  });
}

function genericExecutionMatches(
  kind: StrategyCommandKind | StrategyPackageTransitionOperation,
  prior: StrategyState,
  next: StrategyState,
  receipts: readonly StrategyPackageReceiptInput[],
): { readonly matches: true } | { readonly matches: false; readonly mismatch: StrategyExecutionMismatch } {
  const fail = (mismatch: StrategyExecutionMismatch) => Object.freeze({ matches: false as const, mismatch });
  const expectedAction = kind === 'ROLL_PACKAGE'
    ? 'roll'
    : kind === 'MIGRATE_PACKAGE'
      ? 'migrate'
      : kind.toLowerCase().replaceAll('_', '-');
  const executed: (readonly [string, bigint])[] = [];
  const liabilities = new Map<string, LiabilityDelta>();
  for (const input of receipts) {
    const receipt = strategyPackageReceipt(input);
    if (!requiresSuccessfulReceipt(receipt.terminalState)) return fail('RECEIPT_NOT_SETTLED');
    if (receipt.owner !== prior.ownerId) return fail('RECEIPT_OWNER_MISMATCH');
    if (receipt.seriesId !== prior.seriesId || receipt.executionClassId !== prior.executionClassId) return fail('RECEIPT_MARKET_MISMATCH');
    if (receipt.lifecycleAction !== expectedAction) return fail('RECEIPT_ACTION_MISMATCH');
    for (const outcome of receipt.legOutcomes) {
      if (outcome.positionLegId !== undefined && outcome.settledQuantity.atoms !== 0n) {
        executed.push([outcome.positionLegId, outcome.settledQuantity.atoms]);
      }
      if (outcome.liabilityId !== undefined && outcome.settledQuantity.atoms !== 0n) {
        const current = liabilities.get(outcome.liabilityId);
        if (current !== undefined && current.assetId !== outcome.settledQuantity.asset.assetId) return fail('EXECUTION_AMBIGUOUS');
        liabilities.set(outcome.liabilityId, {
          assetId: outcome.settledQuantity.asset.assetId,
          atoms: (current?.atoms ?? 0n) + outcome.settledQuantity.atoms,
        });
      }
    }
  }
  for (const [liabilityId, delta] of liabilities) if (delta.atoms === 0n) liabilities.delete(liabilityId);
  return sameTotals(venueTotals(executed), stateLegDelta(prior, next)) && sameLiabilityTotals(liabilities, stateLiabilityDelta(prior, next))
    ? Object.freeze({ matches: true as const })
    : fail('EXECUTION_MISMATCH');
}

/**
 * Whether settled package receipts account exactly for a position-moving transition. Every
 * receipt must be a successful terminal receipt of the strategy's owner, with its spot and
 * perpetual legs on different venues, and every strategy leg must sit on its own venue, so a
 * venue's delta names exactly one leg; anything else is ambiguous and refused. Resize and exit
 * receipts are in the strategy's own market, entries for an increase and exits for a decrease or
 * exit, and their net deltas summed per venue must equal the change in the legs per venue. A roll
 * or migration must show exits in the strategy's market that close exactly the moved leg and
 * entries, in any market, that open exactly its replacement; nothing else may move.
 */
export function strategyExecutionMatches(
  kind: StrategyCommandKind,
  prior: StrategyState,
  next: StrategyState,
  receipts: readonly StrategyExecutionReceiptInput[],
  packageOperation?: StrategyPackageTransitionOperation,
): { readonly matches: true } | { readonly matches: false; readonly mismatch: StrategyExecutionMismatch } {
  const fail = (mismatch: StrategyExecutionMismatch) => Object.freeze({ matches: false as const, mismatch });
  if (receipts.length === 0) return fail('EXECUTION_MISMATCH');
  const genericCount = receipts.filter(isStrategyPackageReceipt).length;
  if (genericCount !== 0 && genericCount !== receipts.length) return fail('EXECUTION_AMBIGUOUS');
  if (genericCount === receipts.length) {
    return genericExecutionMatches(packageOperation ?? kind, prior, next, receipts as readonly StrategyPackageReceiptInput[]);
  }
  if (kind === 'APPLY_PACKAGE' || kind === 'ROLL_PACKAGE' || kind === 'MIGRATE_PACKAGE' || kind === 'EMERGENCY_UNWIND') {
    return fail('EXECUTION_AMBIGUOUS');
  }
  const legacyReceipts = receipts as readonly PackageReceiptInput[];
  const moving = kind === 'ROLL' || kind === 'MIGRATE';
  const distinctVenues = (state: StrategyState) => new Set(state.legs.map((leg) => leg.venueId)).size === state.legs.length;
  if (!distinctVenues(prior) || !distinctVenues(next)) return fail('EXECUTION_AMBIGUOUS');
  const moves = { ENTRY: [] as (readonly [string, bigint])[], EXIT: [] as (readonly [string, bigint])[] };
  for (const receipt of legacyReceipts) {
    if (!requiresSuccessfulReceipt(receipt.terminalState)) return fail('RECEIPT_NOT_SETTLED');
    if (receipt.owner !== prior.ownerId) return fail('RECEIPT_OWNER_MISMATCH');
    if (receipt.spotVenue === receipt.perpVenue) return fail('EXECUTION_AMBIGUOUS');
    const inStrategyMarket = receipt.packageMarketId === prior.executionClassId;
    if ((!moving || receipt.action === 'EXIT') && !inStrategyMarket) return fail('RECEIPT_MARKET_MISMATCH');
    if ((kind === 'INCREASE' && receipt.action !== 'ENTRY') || ((kind === 'DECREASE' || kind === 'EXIT') && receipt.action !== 'EXIT')) return fail('RECEIPT_ACTION_MISMATCH');
    if (receipt.netSpotDelta === undefined) return fail('RECEIPT_SPOT_DELTA_MISSING');
    moves[receipt.action].push([receipt.spotVenue, receipt.netSpotDelta], [receipt.perpVenue, receipt.perpPositionDelta]);
  }
  if (moving) {
    const nextIds = new Set(next.legs.map((leg) => leg.legId as string));
    const priorIds = new Set(prior.legs.map((leg) => leg.legId as string));
    const closed = prior.legs.find((leg) => !nextIds.has(leg.legId));
    const opened = next.legs.find((leg) => !priorIds.has(leg.legId));
    if (closed === undefined || opened === undefined) return fail('EXECUTION_MISMATCH');
    const exits = venueTotals(moves.EXIT);
    const entries = venueTotals(moves.ENTRY);
    if (!sameTotals(exits, new Map([[closed.venueId as string, -closed.signedQuantityAtoms]])) || !sameTotals(entries, new Map([[opened.venueId as string, opened.signedQuantityAtoms]]))) {
      return fail('EXECUTION_MISMATCH');
    }
    return Object.freeze({ matches: true as const });
  }
  const executed = venueTotals([...moves.ENTRY, ...moves.EXIT]);
  const required = venueTotals([
    ...next.legs.map((leg) => [leg.venueId as string, leg.signedQuantityAtoms] as const),
    ...prior.legs.map((leg) => [leg.venueId as string, -leg.signedQuantityAtoms] as const),
  ]);
  if (!sameTotals(executed, required)) return fail('EXECUTION_MISMATCH');
  return Object.freeze({ matches: true as const });
}

/** The strategy ids a command reads: its own and, for a merge, the other. */
export function strategyCommandSubjects(input: StrategyCommandInput): readonly ProtocolId[] {
  const own = protocolId(input.strategyId, 'strategyCommand.strategyId');
  return input.parameters.kind === 'MERGE' ? Object.freeze([own, protocolId(input.parameters.otherStrategyId, 'strategyCommand.otherStrategyId')]) : Object.freeze([own]);
}
