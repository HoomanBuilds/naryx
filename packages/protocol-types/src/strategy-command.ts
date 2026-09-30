import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';
import {
  assignInternal,
  DELEGABLE_AUTHORITY,
  delegateManagement,
  encodeStrategyState,
  mergeStrategies,
  revokeDelegation,
  splitStrategy,
  strategyState,
  type DelegableAuthority,
  type StrategyState,
  type StrategyTransitionContext,
  type StrategyTransitionResult,
} from './strategy-lifecycle.js';

export const STRATEGY_COMMAND_VERSION = 1;

/**
 * The strategy operations an actor can sign directly. Each changes accounting, labels, or
 * authority only: no external venue position moves. Operations that move positions (novation,
 * roll, migration, rebalance, resize, exit) are executed as signed package actions instead.
 */
export const STRATEGY_COMMAND_KIND = Object.freeze({
  OPEN: 1,
  ASSIGN_INTERNAL: 2,
  DELEGATE: 3,
  REVOKE_DELEGATION: 4,
  SPLIT: 5,
  MERGE: 6,
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
  };

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
 * Applies one command through the kernel's lifecycle rules. `states` holds the current state of
 * every strategy the command names (the command's own and, for a merge, the other). An OPEN
 * yields the new state, which must name the command's strategy and actor as its owner at version
 * one; every other command returns the kernel's transition result unchanged.
 */
export function applyStrategyCommand(input: StrategyCommandInput, states: ReadonlyMap<string, StrategyState>): StrategyCommandOutcome {
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
  }
}

/** The strategy ids a command reads: its own and, for a merge, the other. */
export function strategyCommandSubjects(input: StrategyCommandInput): readonly ProtocolId[] {
  const own = protocolId(input.strategyId, 'strategyCommand.strategyId');
  return input.parameters.kind === 'MERGE' ? Object.freeze([own, protocolId(input.parameters.otherStrategyId, 'strategyCommand.otherStrategyId')]) : Object.freeze([own]);
}
