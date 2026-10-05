import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { enumDiscriminant, EXPIRY_UNIT, type EnumTable, type ExpiryUnit } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { packageOrder, type PackageOrderInput } from './package-order.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';

const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;

export const ACTIVATION_CONDITION_VERSION = 1;
export const EXECUTION_SCHEDULE_VERSION = 1;
export const STRATEGY_HEALTH_VERSION = 1;
export const KEEPER_ACTION_VERSION = 1;
export const MAX_SCHEDULE_SLICES = 1_000;
export const MAX_PERMITTED_KEEPERS = 32;

/** What a conditional order or keeper action waits for. */
export const CONDITION_METRIC = Object.freeze({
  TIME: 1,
  PACKAGE_PRICE: 2,
  BASIS: 3,
  FUNDING: 4,
  VOLATILITY: 5,
  INVENTORY: 6,
  MARGIN_HEALTH: 7,
  LIQUIDATION_DISTANCE: 8,
} as const);
export type ConditionMetric = keyof typeof CONDITION_METRIC;

export const CONDITION_COMPARATOR = Object.freeze({ AT_OR_ABOVE: 1, AT_OR_BELOW: 2 } as const);
export type ConditionComparator = keyof typeof CONDITION_COMPARATOR;

export const SCHEDULE_KIND = Object.freeze({ SCHEDULED: 1, PACKAGE_TWAP: 2 } as const);
export type ScheduleKind = keyof typeof SCHEDULE_KIND;

/** What happens to the rest of a schedule after one slice fails to execute. */
export const SCHEDULE_STOP_RULE = Object.freeze({ STOP_ON_FIRST_FAILURE: 1, SKIP_FAILED_SLICE: 2 } as const);
export type ScheduleStopRule = keyof typeof SCHEDULE_STOP_RULE;

export const DEPENDENCY_STATE = Object.freeze({ HEALTHY: 1, DEGRADED: 2, HALTED: 3 } as const);
export type DependencyState = keyof typeof DEPENDENCY_STATE;

export const KEEPER_ACTION_KIND = Object.freeze({
  REBALANCE: 1,
  ROLL: 2,
  SCHEDULED_EXIT: 3,
  FUNDING_SETTLEMENT: 4,
  RECOVERY: 5,
  EMERGENCY_RISK_REDUCTION: 6,
  MIGRATE: 7,
  DECREASE: 8,
  INCREASE: 9,
  PACKAGE_TWAP: 10,
  EMERGENCY_UNWIND: 11,
} as const);
export type KeeperActionKind = keyof typeof KEEPER_ACTION_KIND;

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function signed(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedSigned(value, I128_BITS, context);
}

function positive(value: bigint, bits: number, context: string): bigint {
  const checked = unsigned(value, bits, context);
  if (checked === 0n) throw new MalformedInputError(context, 'expected a positive value');
  return checked;
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function version(value: number, expected: number, context: string): number {
  if (value !== expected) throw new MalformedInputError(context, `version must equal ${expected}`);
  return value;
}

function bool(value: boolean, context: string): boolean {
  if (typeof value !== 'boolean') throw new MalformedInputError(context, 'expected a boolean');
  return value;
}

// ------------------------------------------------------------------ activation condition

/**
 * A versioned activation condition. `threshold` is in the metric's own unit: the time unit for
 * TIME, price ticks for PACKAGE_PRICE and BASIS, parts per million for FUNDING and VOLATILITY,
 * base atoms for INVENTORY, and basis points for MARGIN_HEALTH and LIQUIDATION_DISTANCE.
 */
export interface ActivationConditionInput {
  readonly conditionVersion: number;
  readonly metric: ConditionMetric;
  readonly comparator: ConditionComparator;
  readonly threshold: bigint;
  readonly observationUnit: ExpiryUnit;
  /** The oldest an observation may be, in `observationUnit`, when the condition is evaluated. */
  readonly maximumObservationAge: bigint;
}

export type ActivationCondition = ActivationConditionInput;

export function activationCondition(input: ActivationConditionInput, context = 'activationCondition'): ActivationCondition {
  object(input, context);
  const metric = variant(CONDITION_METRIC, input.metric, `${context}.metric`);
  const comparator = variant(CONDITION_COMPARATOR, input.comparator, `${context}.comparator`);
  const threshold = signed(input.threshold, `${context}.threshold`);
  if (metric === 'TIME' && comparator !== 'AT_OR_ABOVE') {
    throw new MalformedInputError(`${context}.comparator`, 'a time condition can only wait until a time');
  }
  if (metric === 'TIME' && threshold < 0n) throw new MalformedInputError(`${context}.threshold`, 'a time threshold cannot be negative');
  return Object.freeze({
    conditionVersion: version(input.conditionVersion, ACTIVATION_CONDITION_VERSION, `${context}.conditionVersion`),
    metric,
    comparator,
    threshold,
    observationUnit: variant(EXPIRY_UNIT, input.observationUnit, `${context}.observationUnit`),
    maximumObservationAge: unsigned(input.maximumObservationAge, U64_BITS, `${context}.maximumObservationAge`),
  });
}

export function activationConditionBytes(input: ActivationConditionInput): Uint8Array {
  const condition = activationCondition(input);
  return canonicalBytes((writer) => {
    writer.writeU32(condition.conditionVersion, 'conditionVersion');
    writer.writeEnum(CONDITION_METRIC, condition.metric, 'metric');
    writer.writeEnum(CONDITION_COMPARATOR, condition.comparator, 'comparator');
    writer.writeI128(condition.threshold, 'threshold');
    writer.writeEnum(EXPIRY_UNIT, condition.observationUnit, 'observationUnit');
    writer.writeU64(condition.maximumObservationAge, 'maximumObservationAge');
  });
}

/** The hash a package order's `activationConditionHash` and a keeper authorization bind. */
export function activationConditionHash(input: ActivationConditionInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.ACTIVATION_CONDITION, activationConditionBytes(input)), 'activationConditionHash');
}

export interface MetricObservation {
  readonly metric: ConditionMetric;
  readonly value: bigint;
  readonly observedAtValue: bigint;
}

export type ConditionRejection = 'METRIC_UNAVAILABLE' | 'STALE_OBSERVATION' | 'OBSERVATION_FROM_FUTURE' | 'NOT_SATISFIED';

/**
 * Evaluates a condition at `atValue` against the observations supplied. A TIME condition compares
 * `atValue` itself. Any other metric needs a fresh observation of exactly that metric; a missing
 * or stale observation never satisfies a condition.
 */
export function evaluateActivationCondition(
  input: ActivationConditionInput,
  observations: readonly MetricObservation[],
  atValue: bigint,
): { readonly satisfied: true } | { readonly satisfied: false; readonly reason: ConditionRejection } {
  const condition = activationCondition(input);
  const at = unsigned(atValue, U64_BITS, 'evaluateActivationCondition.atValue');
  const reject = (reason: ConditionRejection) => Object.freeze({ satisfied: false as const, reason });
  let value: bigint;
  if (condition.metric === 'TIME') {
    value = at;
  } else {
    if (!Array.isArray(observations)) throw new MalformedInputError('evaluateActivationCondition.observations', 'expected an array');
    const matching = observations.filter((observation) => observation.metric === condition.metric);
    if (matching.length > 1) throw new DuplicateElementError('evaluateActivationCondition.observations', 'a metric is observed twice');
    const observation = matching[0];
    if (observation === undefined) return reject('METRIC_UNAVAILABLE');
    const observedAt = unsigned(observation.observedAtValue, U64_BITS, 'evaluateActivationCondition.observedAtValue');
    if (observedAt > at) return reject('OBSERVATION_FROM_FUTURE');
    if (at - observedAt > condition.maximumObservationAge) return reject('STALE_OBSERVATION');
    value = signed(observation.value, 'evaluateActivationCondition.value');
  }
  const satisfied = condition.comparator === 'AT_OR_ABOVE' ? value >= condition.threshold : value <= condition.threshold;
  return satisfied ? Object.freeze({ satisfied: true as const }) : reject('NOT_SATISFIED');
}

// ------------------------------------------------------------------ execution schedule

/**
 * A versioned schedule. Slice `i` becomes due at `startValue + i * sliceInterval`. A package TWAP
 * additionally carries a signed aggregate limit price every executed slice must respect on
 * average; a plain schedule has none.
 */
export interface ExecutionScheduleInput {
  readonly scheduleVersion: number;
  readonly kind: ScheduleKind;
  readonly timeUnit: ExpiryUnit;
  readonly startValue: bigint;
  readonly sliceInterval: bigint;
  readonly sliceCount: number;
  readonly aggregateQuantityLimit: bigint;
  readonly maximumSliceQuantity: bigint;
  readonly stopRule: ScheduleStopRule;
  readonly aggregateLimitPriceTicks?: bigint;
}

export type ExecutionSchedule = ExecutionScheduleInput;

export function executionSchedule(input: ExecutionScheduleInput, context = 'executionSchedule'): ExecutionSchedule {
  object(input, context);
  const kind = variant(SCHEDULE_KIND, input.kind, `${context}.kind`);
  if (!Number.isSafeInteger(input.sliceCount) || input.sliceCount < 1 || input.sliceCount > MAX_SCHEDULE_SLICES) {
    throw new MalformedInputError(`${context}.sliceCount`, `expected 1 to ${MAX_SCHEDULE_SLICES} slices`);
  }
  const aggregateQuantityLimit = positive(input.aggregateQuantityLimit, U128_BITS, `${context}.aggregateQuantityLimit`);
  const maximumSliceQuantity = positive(input.maximumSliceQuantity, U128_BITS, `${context}.maximumSliceQuantity`);
  if (maximumSliceQuantity > aggregateQuantityLimit) {
    throw new MalformedInputError(`${context}.maximumSliceQuantity`, 'a slice cannot exceed the aggregate limit');
  }
  const startValue = unsigned(input.startValue, U64_BITS, `${context}.startValue`);
  const sliceInterval = positive(input.sliceInterval, U64_BITS, `${context}.sliceInterval`);
  checkedUnsigned(startValue + sliceInterval * BigInt(input.sliceCount - 1), U64_BITS, `${context}.lastSliceValue`);
  if ((kind === 'PACKAGE_TWAP') !== (input.aggregateLimitPriceTicks !== undefined)) {
    throw new MalformedInputError(`${context}.aggregateLimitPriceTicks`, 'a package TWAP, and only a TWAP, carries an aggregate limit price');
  }
  return Object.freeze({
    scheduleVersion: version(input.scheduleVersion, EXECUTION_SCHEDULE_VERSION, `${context}.scheduleVersion`),
    kind,
    timeUnit: variant(EXPIRY_UNIT, input.timeUnit, `${context}.timeUnit`),
    startValue,
    sliceInterval,
    sliceCount: input.sliceCount,
    aggregateQuantityLimit,
    maximumSliceQuantity,
    stopRule: variant(SCHEDULE_STOP_RULE, input.stopRule, `${context}.stopRule`),
    ...(input.aggregateLimitPriceTicks === undefined ? {} : { aggregateLimitPriceTicks: signed(input.aggregateLimitPriceTicks, `${context}.aggregateLimitPriceTicks`) }),
  });
}

export function executionScheduleBytes(input: ExecutionScheduleInput): Uint8Array {
  const schedule = executionSchedule(input);
  return canonicalBytes((writer) => {
    writer.writeU32(schedule.scheduleVersion, 'scheduleVersion');
    writer.writeEnum(SCHEDULE_KIND, schedule.kind, 'kind');
    writer.writeEnum(EXPIRY_UNIT, schedule.timeUnit, 'timeUnit');
    writer.writeU64(schedule.startValue, 'startValue');
    writer.writeU64(schedule.sliceInterval, 'sliceInterval');
    writer.writeU32(schedule.sliceCount, 'sliceCount');
    writer.writeU128(schedule.aggregateQuantityLimit, 'aggregateQuantityLimit');
    writer.writeU128(schedule.maximumSliceQuantity, 'maximumSliceQuantity');
    writer.writeEnum(SCHEDULE_STOP_RULE, schedule.stopRule, 'stopRule');
    writer.writeOptional(schedule.aggregateLimitPriceTicks, (inner, value) => inner.writeI128(value, 'aggregateLimitPriceTicks'), 'aggregateLimitPriceTicks');
  });
}

/** The hash a package order's `executionScheduleHash` binds. */
export function executionScheduleHash(input: ExecutionScheduleInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.EXECUTION_SCHEDULE, executionScheduleBytes(input)), 'executionScheduleHash');
}

export interface ScheduleProgress {
  /** Quantity executed across all slices so far. */
  readonly executedQuantity: bigint;
  /** Notional of the executed quantity in price ticks times quantity, for the TWAP average. */
  readonly executedNotionalTicks: bigint;
  /** Slices already attempted, whether they executed or failed. */
  readonly attemptedSlices: number;
  readonly failedSlices: number;
  /** The window index of the last attempted slice; required once any slice was attempted. */
  readonly lastAttemptedSliceIndex?: number;
}

export type ScheduleSliceRejection = 'NOT_STARTED' | 'NOT_DUE' | 'COMPLETE' | 'STOPPED' | 'EXPIRED';

/**
 * The next slice of a schedule at `atValue`: its index and the most it may execute. A slice is
 * due once its time arrives and stays due until the next slice's time; a missed slice is skipped,
 * never doubled up. The aggregate limit bounds every slice, so the schedule can never exceed it.
 */
export function nextScheduleSlice(
  input: ExecutionScheduleInput,
  progress: ScheduleProgress,
  atValue: bigint,
):
  | { readonly due: true; readonly sliceIndex: number; readonly maximumQuantity: bigint }
  | { readonly due: false; readonly reason: ScheduleSliceRejection } {
  const schedule = executionSchedule(input);
  object(progress, 'nextScheduleSlice.progress');
  const at = unsigned(atValue, U64_BITS, 'nextScheduleSlice.atValue');
  const executed = unsigned(progress.executedQuantity, U128_BITS, 'nextScheduleSlice.executedQuantity');
  const attempted = Number(checkedUnsigned(BigInt(progress.attemptedSlices), U32_BITS, 'nextScheduleSlice.attemptedSlices'));
  const failed = Number(checkedUnsigned(BigInt(progress.failedSlices), U32_BITS, 'nextScheduleSlice.failedSlices'));
  if (failed > attempted || attempted > schedule.sliceCount) throw new MalformedInputError('nextScheduleSlice.progress', 'progress is inconsistent');
  const last =
    progress.lastAttemptedSliceIndex === undefined
      ? undefined
      : Number(checkedUnsigned(BigInt(progress.lastAttemptedSliceIndex), U32_BITS, 'nextScheduleSlice.lastAttemptedSliceIndex'));
  // Each attempt uses its own window, so the attempts fit in the windows up to the last one.
  if ((attempted === 0) !== (last === undefined) || (last !== undefined && (last >= schedule.sliceCount || attempted > last + 1))) {
    throw new MalformedInputError('nextScheduleSlice.lastAttemptedSliceIndex', 'progress is inconsistent');
  }
  if (executed > schedule.aggregateQuantityLimit) throw new MalformedInputError('nextScheduleSlice.executedQuantity', 'executed quantity exceeds the aggregate limit');
  const reject = (reason: ScheduleSliceRejection) => Object.freeze({ due: false as const, reason });
  if (failed > 0 && schedule.stopRule === 'STOP_ON_FIRST_FAILURE') return reject('STOPPED');
  if (executed === schedule.aggregateQuantityLimit || last === schedule.sliceCount - 1) return reject('COMPLETE');
  if (at < schedule.startValue) return reject('NOT_STARTED');
  const elapsedSlice = (at - schedule.startValue) / schedule.sliceInterval;
  if (elapsedSlice >= BigInt(schedule.sliceCount)) return reject('EXPIRED');
  // The due slice is the one whose window contains `at`; a window already attempted is never
  // attempted again, and windows between the last attempt and now were missed.
  if (last !== undefined && BigInt(last) >= elapsedSlice) return reject('NOT_DUE');
  const remaining = schedule.aggregateQuantityLimit - executed;
  return Object.freeze({
    due: true as const,
    sliceIndex: Number(elapsedSlice),
    maximumQuantity: remaining < schedule.maximumSliceQuantity ? remaining : schedule.maximumSliceQuantity,
  });
}

/**
 * Whether a TWAP may execute a slice at `priceTicks` for `quantity` without the running average
 * crossing the signed aggregate limit. `side` is the taker's side: a BID must stay at or below the
 * limit on average, an ASK at or above it.
 */
export function twapSliceWithinLimit(
  input: ExecutionScheduleInput,
  progress: ScheduleProgress,
  side: 'BID' | 'ASK',
  priceTicks: bigint,
  quantity: bigint,
): boolean {
  const schedule = executionSchedule(input);
  if (schedule.aggregateLimitPriceTicks === undefined) throw new MalformedInputError('twapSliceWithinLimit.schedule', 'the schedule is not a package TWAP');
  if (side !== 'BID' && side !== 'ASK') throw new MalformedInputError('twapSliceWithinLimit.side', 'expected BID or ASK');
  const executed = unsigned(progress.executedQuantity, U128_BITS, 'twapSliceWithinLimit.executedQuantity');
  const notional = signed(progress.executedNotionalTicks, 'twapSliceWithinLimit.executedNotionalTicks');
  const size = positive(quantity, U128_BITS, 'twapSliceWithinLimit.quantity');
  const nextNotional = notional + signed(priceTicks, 'twapSliceWithinLimit.priceTicks') * size;
  const limitNotional = schedule.aggregateLimitPriceTicks * (executed + size);
  return side === 'BID' ? nextNotional <= limitNotional : nextNotional >= limitNotional;
}

// ------------------------------------------------------------------ strategy health

/**
 * One observation of a strategy's health, bound to the exact strategy state it describes. Values
 * are exact integers: delta and residual in base atoms, notional and loss in quote atoms, leverage,
 * margin health, and liquidation distance in basis points, funding and volatility in parts per
 * million, and basis in package price ticks.
 */
export interface StrategyHealthSnapshotInput {
  readonly snapshotVersion: number;
  readonly environment: string;
  readonly strategyId: string;
  readonly strategyStateHash: Uint8Array | string;
  readonly observedAtUnit: ExpiryUnit;
  readonly observedAtValue: bigint;
  readonly deltaBaseAtoms: bigint;
  readonly grossNotionalQuoteAtoms: bigint;
  readonly leverageBps: bigint;
  readonly marginHealthBps: bigint;
  /** Absent when no leg can be liquidated. */
  readonly liquidationDistanceBps?: bigint;
  readonly basisTicks: bigint;
  readonly fundingPpm: bigint;
  readonly volatilityPpm: bigint;
  readonly residualBaseAtoms: bigint;
  readonly maximumLossBoundQuoteAtoms: bigint;
  readonly dependencyState: DependencyState;
  readonly recoveryCapacityQuoteAtoms: bigint;
  readonly evidenceHash: Uint8Array | string;
}

export interface StrategyHealthSnapshot extends Omit<StrategyHealthSnapshotInput, 'environment' | 'strategyId' | 'strategyStateHash' | 'evidenceHash'> {
  readonly environment: ProtocolId;
  readonly strategyId: ProtocolId;
  readonly strategyStateHash: CommitmentHash;
  readonly evidenceHash: CommitmentHash;
}

export function strategyHealthSnapshot(input: StrategyHealthSnapshotInput, context = 'strategyHealthSnapshot'): StrategyHealthSnapshot {
  object(input, context);
  return Object.freeze({
    snapshotVersion: version(input.snapshotVersion, STRATEGY_HEALTH_VERSION, `${context}.snapshotVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    strategyId: protocolId(input.strategyId, `${context}.strategyId`),
    strategyStateHash: commitmentHash(input.strategyStateHash, `${context}.strategyStateHash`),
    observedAtUnit: variant(EXPIRY_UNIT, input.observedAtUnit, `${context}.observedAtUnit`),
    observedAtValue: unsigned(input.observedAtValue, U64_BITS, `${context}.observedAtValue`),
    deltaBaseAtoms: signed(input.deltaBaseAtoms, `${context}.deltaBaseAtoms`),
    grossNotionalQuoteAtoms: unsigned(input.grossNotionalQuoteAtoms, U128_BITS, `${context}.grossNotionalQuoteAtoms`),
    leverageBps: unsigned(input.leverageBps, U64_BITS, `${context}.leverageBps`),
    marginHealthBps: unsigned(input.marginHealthBps, U64_BITS, `${context}.marginHealthBps`),
    ...(input.liquidationDistanceBps === undefined
      ? {}
      : { liquidationDistanceBps: unsigned(input.liquidationDistanceBps, U64_BITS, `${context}.liquidationDistanceBps`) }),
    basisTicks: signed(input.basisTicks, `${context}.basisTicks`),
    fundingPpm: signed(input.fundingPpm, `${context}.fundingPpm`),
    volatilityPpm: unsigned(input.volatilityPpm, U64_BITS, `${context}.volatilityPpm`),
    residualBaseAtoms: signed(input.residualBaseAtoms, `${context}.residualBaseAtoms`),
    maximumLossBoundQuoteAtoms: unsigned(input.maximumLossBoundQuoteAtoms, U128_BITS, `${context}.maximumLossBoundQuoteAtoms`),
    dependencyState: variant(DEPENDENCY_STATE, input.dependencyState, `${context}.dependencyState`),
    recoveryCapacityQuoteAtoms: unsigned(input.recoveryCapacityQuoteAtoms, U128_BITS, `${context}.recoveryCapacityQuoteAtoms`),
    evidenceHash: commitmentHash(input.evidenceHash, `${context}.evidenceHash`),
  });
}

export function strategyHealthSnapshotBytes(input: StrategyHealthSnapshotInput): Uint8Array {
  const snapshot = strategyHealthSnapshot(input);
  return canonicalBytes((writer) => {
    writer.writeU32(snapshot.snapshotVersion, 'snapshotVersion');
    encodeProtocolId(writer, snapshot.environment, 'environment');
    encodeProtocolId(writer, snapshot.strategyId, 'strategyId');
    encodeCommitmentHash(writer, snapshot.strategyStateHash, 'strategyStateHash');
    writer.writeEnum(EXPIRY_UNIT, snapshot.observedAtUnit, 'observedAtUnit');
    writer.writeU64(snapshot.observedAtValue, 'observedAtValue');
    writer.writeI128(snapshot.deltaBaseAtoms, 'deltaBaseAtoms');
    writer.writeU128(snapshot.grossNotionalQuoteAtoms, 'grossNotionalQuoteAtoms');
    writer.writeU64(snapshot.leverageBps, 'leverageBps');
    writer.writeU64(snapshot.marginHealthBps, 'marginHealthBps');
    writer.writeOptional(snapshot.liquidationDistanceBps, (inner, value) => inner.writeU64(value, 'liquidationDistanceBps'), 'liquidationDistanceBps');
    writer.writeI128(snapshot.basisTicks, 'basisTicks');
    writer.writeI128(snapshot.fundingPpm, 'fundingPpm');
    writer.writeU64(snapshot.volatilityPpm, 'volatilityPpm');
    writer.writeI128(snapshot.residualBaseAtoms, 'residualBaseAtoms');
    writer.writeU128(snapshot.maximumLossBoundQuoteAtoms, 'maximumLossBoundQuoteAtoms');
    writer.writeEnum(DEPENDENCY_STATE, snapshot.dependencyState, 'dependencyState');
    writer.writeU128(snapshot.recoveryCapacityQuoteAtoms, 'recoveryCapacityQuoteAtoms');
    encodeCommitmentHash(writer, snapshot.evidenceHash, 'evidenceHash');
  });
}

export function strategyHealthSnapshotHash(input: StrategyHealthSnapshotInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.STRATEGY_HEALTH, strategyHealthSnapshotBytes(input)), 'strategyHealthSnapshotHash');
}

/** The condition metrics a health snapshot observes, for `evaluateActivationCondition`. */
export function healthObservations(input: StrategyHealthSnapshotInput): readonly MetricObservation[] {
  const snapshot = strategyHealthSnapshot(input);
  const at = snapshot.observedAtValue;
  return Object.freeze([
    { metric: 'BASIS' as const, value: snapshot.basisTicks, observedAtValue: at },
    { metric: 'FUNDING' as const, value: snapshot.fundingPpm, observedAtValue: at },
    { metric: 'VOLATILITY' as const, value: snapshot.volatilityPpm, observedAtValue: at },
    { metric: 'INVENTORY' as const, value: snapshot.deltaBaseAtoms, observedAtValue: at },
    { metric: 'MARGIN_HEALTH' as const, value: snapshot.marginHealthBps, observedAtValue: at },
    ...(snapshot.liquidationDistanceBps === undefined
      ? []
      : [{ metric: 'LIQUIDATION_DISTANCE' as const, value: snapshot.liquidationDistanceBps, observedAtValue: at }]),
  ].map((observation) => Object.freeze(observation)));
}

export type RiskIncrease = 'LEVERAGE' | 'NOTIONAL' | 'LOSS_BOUND' | 'ABSOLUTE_DELTA' | 'AUTHORITY';

/**
 * The risk-reducing proof: an action is risk-reducing only when the projected state increases none
 * of leverage, gross notional, loss bound, or absolute delta, and grants no new authority. Both
 * snapshots must describe the same strategy.
 */
export function isRiskReducing(
  beforeInput: StrategyHealthSnapshotInput,
  afterInput: StrategyHealthSnapshotInput,
  grantsAuthority: boolean,
): { readonly riskReducing: boolean; readonly increases: readonly RiskIncrease[] } {
  const before = strategyHealthSnapshot(beforeInput, 'isRiskReducing.before');
  const after = strategyHealthSnapshot(afterInput, 'isRiskReducing.after');
  if (before.strategyId !== after.strategyId || before.environment !== after.environment) {
    throw new MalformedInputError('isRiskReducing', 'the snapshots describe different strategies');
  }
  const absolute = (value: bigint) => (value < 0n ? -value : value);
  const increases: RiskIncrease[] = [];
  if (after.leverageBps > before.leverageBps) increases.push('LEVERAGE');
  if (after.grossNotionalQuoteAtoms > before.grossNotionalQuoteAtoms) increases.push('NOTIONAL');
  if (after.maximumLossBoundQuoteAtoms > before.maximumLossBoundQuoteAtoms) increases.push('LOSS_BOUND');
  if (absolute(after.deltaBaseAtoms) > absolute(before.deltaBaseAtoms)) increases.push('ABSOLUTE_DELTA');
  if (bool(grantsAuthority, 'isRiskReducing.grantsAuthority')) increases.push('AUTHORITY');
  return Object.freeze({ riskReducing: increases.length === 0, increases: Object.freeze(increases) });
}

// ------------------------------------------------------------------ keeper action authorization

export interface ResultingRiskBound {
  readonly maximumLeverageBps: bigint;
  readonly maximumGrossNotionalQuoteAtoms: bigint;
  readonly maximumLossBoundQuoteAtoms: bigint;
  readonly maximumAbsoluteDeltaBaseAtoms: bigint;
  readonly minimumMarginHealthBps: bigint;
}

/**
 * The owner-signed authority for one kind of keeper action on one strategy. It binds the template,
 * the lifecycle graph the action must follow, the condition that must hold, the most the action may
 * cost, the risk the result may carry, the reward, and an expiry. An empty keeper set means any
 * keeper may trigger it; a keeper never gains discretion beyond these bounds.
 */
export interface KeeperActionAuthorizationInput {
  readonly authorizationVersion: number;
  readonly environment: string;
  readonly strategyId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly lifecycleGraphHash: Uint8Array | string;
  readonly actionKind: KeeperActionKind;
  readonly conditionHash: Uint8Array | string;
  readonly maximumCostQuoteAtoms: bigint;
  readonly resultingRiskBound: ResultingRiskBound;
  /** When true, every execution must also pass `isRiskReducing`. */
  readonly riskReducing: boolean;
  readonly rewardQuoteAtoms: bigint;
  readonly permittedKeeperIds: readonly string[];
  readonly expiryUnit: ExpiryUnit;
  readonly expiryValue: bigint;
  readonly authorizationNonce: bigint;
}

export interface KeeperActionAuthorization extends Omit<
  KeeperActionAuthorizationInput,
  'environment' | 'strategyId' | 'templateId' | 'packageTemplateManifestHash' | 'lifecycleGraphHash' | 'conditionHash' | 'permittedKeeperIds'
> {
  readonly environment: ProtocolId;
  readonly strategyId: ProtocolId;
  readonly templateId: ProtocolId;
  readonly packageTemplateManifestHash: CommitmentHash;
  readonly lifecycleGraphHash: CommitmentHash;
  readonly conditionHash: CommitmentHash;
  readonly permittedKeeperIds: readonly ProtocolId[];
}

function riskBound(input: ResultingRiskBound, context: string): ResultingRiskBound {
  object(input, context);
  return Object.freeze({
    maximumLeverageBps: unsigned(input.maximumLeverageBps, U64_BITS, `${context}.maximumLeverageBps`),
    maximumGrossNotionalQuoteAtoms: unsigned(input.maximumGrossNotionalQuoteAtoms, U128_BITS, `${context}.maximumGrossNotionalQuoteAtoms`),
    maximumLossBoundQuoteAtoms: unsigned(input.maximumLossBoundQuoteAtoms, U128_BITS, `${context}.maximumLossBoundQuoteAtoms`),
    maximumAbsoluteDeltaBaseAtoms: unsigned(input.maximumAbsoluteDeltaBaseAtoms, U128_BITS, `${context}.maximumAbsoluteDeltaBaseAtoms`),
    minimumMarginHealthBps: unsigned(input.minimumMarginHealthBps, U64_BITS, `${context}.minimumMarginHealthBps`),
  });
}

export function keeperActionAuthorization(input: KeeperActionAuthorizationInput, context = 'keeperActionAuthorization'): KeeperActionAuthorization {
  object(input, context);
  if (!Number.isSafeInteger(input.templateVersion) || input.templateVersion < 1 || input.templateVersion > 0xffff_ffff) {
    throw new MalformedInputError(`${context}.templateVersion`, 'expected a positive u32 version');
  }
  const maximumCostQuoteAtoms = unsigned(input.maximumCostQuoteAtoms, U128_BITS, `${context}.maximumCostQuoteAtoms`);
  const rewardQuoteAtoms = unsigned(input.rewardQuoteAtoms, U128_BITS, `${context}.rewardQuoteAtoms`);
  // The reward is part of what the action costs the strategy, so it can never exceed the cost bound.
  if (rewardQuoteAtoms > maximumCostQuoteAtoms) throw new MalformedInputError(`${context}.rewardQuoteAtoms`, 'the reward exceeds the cost bound');
  if (!Array.isArray(input.permittedKeeperIds) || input.permittedKeeperIds.length > MAX_PERMITTED_KEEPERS) {
    throw new MalformedInputError(`${context}.permittedKeeperIds`, `expected at most ${MAX_PERMITTED_KEEPERS} keepers`);
  }
  const keepers = input.permittedKeeperIds.map((value, index) => protocolId(value, `${context}.permittedKeeperIds[${index}]`)).sort();
  for (let index = 1; index < keepers.length; index += 1) {
    if (keepers[index - 1] === keepers[index]) throw new DuplicateElementError(`${context}.permittedKeeperIds`, 'keepers repeat');
  }
  return Object.freeze({
    authorizationVersion: version(input.authorizationVersion, KEEPER_ACTION_VERSION, `${context}.authorizationVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    strategyId: protocolId(input.strategyId, `${context}.strategyId`),
    templateId: protocolId(input.templateId, `${context}.templateId`),
    templateVersion: input.templateVersion,
    packageTemplateManifestHash: commitmentHash(input.packageTemplateManifestHash, `${context}.packageTemplateManifestHash`),
    lifecycleGraphHash: commitmentHash(input.lifecycleGraphHash, `${context}.lifecycleGraphHash`),
    actionKind: variant(KEEPER_ACTION_KIND, input.actionKind, `${context}.actionKind`),
    conditionHash: commitmentHash(input.conditionHash, `${context}.conditionHash`),
    maximumCostQuoteAtoms,
    resultingRiskBound: riskBound(input.resultingRiskBound, `${context}.resultingRiskBound`),
    riskReducing: bool(input.riskReducing, `${context}.riskReducing`),
    rewardQuoteAtoms,
    permittedKeeperIds: Object.freeze(keepers),
    expiryUnit: variant(EXPIRY_UNIT, input.expiryUnit, `${context}.expiryUnit`),
    expiryValue: unsigned(input.expiryValue, U64_BITS, `${context}.expiryValue`),
    authorizationNonce: unsigned(input.authorizationNonce, U64_BITS, `${context}.authorizationNonce`),
  });
}

function encodeRiskBound(writer: CanonicalWriter, bound: ResultingRiskBound): void {
  writer.writeU64(bound.maximumLeverageBps, 'maximumLeverageBps');
  writer.writeU128(bound.maximumGrossNotionalQuoteAtoms, 'maximumGrossNotionalQuoteAtoms');
  writer.writeU128(bound.maximumLossBoundQuoteAtoms, 'maximumLossBoundQuoteAtoms');
  writer.writeU128(bound.maximumAbsoluteDeltaBaseAtoms, 'maximumAbsoluteDeltaBaseAtoms');
  writer.writeU64(bound.minimumMarginHealthBps, 'minimumMarginHealthBps');
}

/** The bytes the strategy owner signs. */
export function keeperActionAuthorizationBytes(input: KeeperActionAuthorizationInput): Uint8Array {
  const authorization = keeperActionAuthorization(input);
  return canonicalBytes((writer) => {
    writer.writeU32(authorization.authorizationVersion, 'authorizationVersion');
    encodeProtocolId(writer, authorization.environment, 'environment');
    encodeProtocolId(writer, authorization.strategyId, 'strategyId');
    encodeProtocolId(writer, authorization.templateId, 'templateId');
    writer.writeU32(authorization.templateVersion, 'templateVersion');
    encodeCommitmentHash(writer, authorization.packageTemplateManifestHash, 'packageTemplateManifestHash');
    encodeCommitmentHash(writer, authorization.lifecycleGraphHash, 'lifecycleGraphHash');
    writer.writeEnum(KEEPER_ACTION_KIND, authorization.actionKind, 'actionKind');
    encodeCommitmentHash(writer, authorization.conditionHash, 'conditionHash');
    writer.writeU128(authorization.maximumCostQuoteAtoms, 'maximumCostQuoteAtoms');
    encodeRiskBound(writer, authorization.resultingRiskBound);
    writer.writeBool(authorization.riskReducing, 'riskReducing');
    writer.writeU128(authorization.rewardQuoteAtoms, 'rewardQuoteAtoms');
    writer.writeSet(authorization.permittedKeeperIds, (inner, value) => encodeProtocolId(inner, value, 'keeperId'), 'permittedKeeperIds');
    writer.writeEnum(EXPIRY_UNIT, authorization.expiryUnit, 'expiryUnit');
    writer.writeU64(authorization.expiryValue, 'expiryValue');
    writer.writeU64(authorization.authorizationNonce, 'authorizationNonce');
  });
}

export function keeperActionAuthorizationHash(input: KeeperActionAuthorizationInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.KEEPER_ACTION, keeperActionAuthorizationBytes(input)), 'keeperActionAuthorizationHash');
}

export interface KeeperActionRequest {
  readonly keeperId: string;
  /** The lifecycle graph the proposed action follows. */
  readonly lifecycleGraphHash: Uint8Array | string;
  readonly condition: ActivationConditionInput;
  /** The health observed now; it must describe the strategy's current state. */
  readonly before: StrategyHealthSnapshotInput;
  /** The health the action projects after it executes. */
  readonly after: StrategyHealthSnapshotInput;
  /** The strategy state hash the executor holds now, to detect a race with another action. */
  readonly currentStrategyStateHash: Uint8Array | string;
  readonly costQuoteAtoms: bigint;
  readonly rewardQuoteAtoms: bigint;
  readonly grantsAuthority: boolean;
  /** True once the owner took manual control of the strategy; keepers then stand down. */
  readonly manualTakeover: boolean;
  /** True when this authorization's nonce was already consumed by an executed action. */
  readonly nonceConsumed: boolean;
  readonly atValue: bigint;
}

export type KeeperActionRejection =
  | 'EXPIRED'
  | 'MANUAL_TAKEOVER'
  | 'REPLAY'
  | 'KEEPER_NOT_PERMITTED'
  | 'STRATEGY_MISMATCH'
  | 'GRAPH_MISMATCH'
  | 'STATE_CHANGED'
  | 'CONDITION_MISMATCH'
  | 'CONDITION_NOT_MET'
  | 'COST_ABOVE_BOUND'
  | 'REWARD_ABOVE_BOUND'
  | 'RESULTING_RISK_ABOVE_BOUND'
  | 'DEPENDENCY_HALTED'
  | 'NOT_RISK_REDUCING'
  | 'TIME_UNIT_MISMATCH';

/**
 * Decides whether a keeper may execute an authorized action now. Every bound is checked against
 * exact values; nothing a keeper supplies can widen the owner's authorization.
 */
export function authorizeKeeperAction(
  authorizationInput: KeeperActionAuthorizationInput,
  request: KeeperActionRequest,
):
  | { readonly authorized: true; readonly authorizationHash: CommitmentHash; readonly riskIncreases: readonly RiskIncrease[] }
  | { readonly authorized: false; readonly reason: KeeperActionRejection; readonly detail?: readonly RiskIncrease[] } {
  const authorization = keeperActionAuthorization(authorizationInput);
  object(request, 'authorizeKeeperAction.request');
  const reject = (reason: KeeperActionRejection, detail?: readonly RiskIncrease[]) =>
    Object.freeze({ authorized: false as const, reason, ...(detail === undefined ? {} : { detail }) });
  const at = unsigned(request.atValue, U64_BITS, 'authorizeKeeperAction.atValue');
  const before = strategyHealthSnapshot(request.before, 'authorizeKeeperAction.before');
  const after = strategyHealthSnapshot(request.after, 'authorizeKeeperAction.after');
  const keeperId = protocolId(request.keeperId, 'authorizeKeeperAction.keeperId');
  // `atValue` is in the authorization's expiry unit, so every time it is compared with must be too.
  const condition = activationCondition(request.condition, 'authorizeKeeperAction.condition');
  if (
    condition.observationUnit !== authorization.expiryUnit ||
    before.observedAtUnit !== authorization.expiryUnit ||
    after.observedAtUnit !== authorization.expiryUnit
  ) {
    return reject('TIME_UNIT_MISMATCH');
  }
  if (at >= authorization.expiryValue) return reject('EXPIRED');
  if (bool(request.manualTakeover, 'authorizeKeeperAction.manualTakeover')) return reject('MANUAL_TAKEOVER');
  if (bool(request.nonceConsumed, 'authorizeKeeperAction.nonceConsumed')) return reject('REPLAY');
  if (authorization.permittedKeeperIds.length > 0 && !authorization.permittedKeeperIds.includes(keeperId)) return reject('KEEPER_NOT_PERMITTED');
  for (const snapshot of [before, after]) {
    if (snapshot.strategyId !== authorization.strategyId || snapshot.environment !== authorization.environment) return reject('STRATEGY_MISMATCH');
  }
  if (compareBytes(commitmentHash(request.lifecycleGraphHash, 'authorizeKeeperAction.lifecycleGraphHash'), authorization.lifecycleGraphHash) !== 0) {
    return reject('GRAPH_MISMATCH');
  }
  // A health snapshot of any other state, or a state that moved since, is a race the keeper lost.
  if (compareBytes(commitmentHash(request.currentStrategyStateHash, 'authorizeKeeperAction.currentStrategyStateHash'), before.strategyStateHash) !== 0) {
    return reject('STATE_CHANGED');
  }
  if (compareBytes(activationConditionHash(request.condition), authorization.conditionHash) !== 0) return reject('CONDITION_MISMATCH');
  if (!evaluateActivationCondition(request.condition, healthObservations(request.before), at).satisfied) return reject('CONDITION_NOT_MET');
  const cost = unsigned(request.costQuoteAtoms, U128_BITS, 'authorizeKeeperAction.costQuoteAtoms');
  const reward = unsigned(request.rewardQuoteAtoms, U128_BITS, 'authorizeKeeperAction.rewardQuoteAtoms');
  if (reward > authorization.rewardQuoteAtoms) return reject('REWARD_ABOVE_BOUND');
  if (cost + reward > authorization.maximumCostQuoteAtoms) return reject('COST_ABOVE_BOUND');
  const bound = authorization.resultingRiskBound;
  const absoluteDelta = after.deltaBaseAtoms < 0n ? -after.deltaBaseAtoms : after.deltaBaseAtoms;
  if (
    after.leverageBps > bound.maximumLeverageBps ||
    after.grossNotionalQuoteAtoms > bound.maximumGrossNotionalQuoteAtoms ||
    after.maximumLossBoundQuoteAtoms > bound.maximumLossBoundQuoteAtoms ||
    absoluteDelta > bound.maximumAbsoluteDeltaBaseAtoms ||
    after.marginHealthBps < bound.minimumMarginHealthBps
  ) {
    return reject('RESULTING_RISK_ABOVE_BOUND');
  }
  const proof = isRiskReducing(request.before, request.after, request.grantsAuthority);
  if (authorization.riskReducing && !proof.riskReducing) return reject('NOT_RISK_REDUCING', proof.increases);
  // A halted dependency still permits emergency risk reduction and recovery, and nothing else.
  if (
    before.dependencyState === 'HALTED' &&
    authorization.actionKind !== 'EMERGENCY_RISK_REDUCTION' &&
    authorization.actionKind !== 'EMERGENCY_UNWIND' &&
    authorization.actionKind !== 'RECOVERY'
  ) {
    return reject('DEPENDENCY_HALTED');
  }
  return Object.freeze({ authorized: true as const, authorizationHash: keeperActionAuthorizationHash(authorization), riskIncreases: proof.increases });
}

// ------------------------------------------------------------------ package order activation

export type OrderActivationRejection =
  | 'ACTIVATION_NOT_BOUND'
  | 'ACTIVATION_NOT_EXPECTED'
  | 'CONDITION_MISMATCH'
  | 'SCHEDULE_MISMATCH'
  | 'SCHEDULE_ABOVE_ORDER'
  | 'ORDER_EXPIRED'
  | 'TIME_UNIT_MISMATCH'
  | ConditionRejection
  | ScheduleSliceRejection;

export interface OrderActivationEvidence {
  readonly condition?: ActivationConditionInput;
  readonly schedule?: ExecutionScheduleInput;
  readonly observations: readonly MetricObservation[];
  readonly progress?: ScheduleProgress;
  /** Current time in the order's expiry unit. */
  readonly atValue: bigint;
}

/**
 * Decides whether a signed package order may execute now, and how much of it. An immediate order
 * executes in full and may bind neither a condition nor a schedule. A CONDITIONAL order executes in
 * full once the exact condition it binds holds. A SCHEDULED or PACKAGE_TWAP order executes only the
 * due slice of the exact schedule it binds, under its condition when it binds one too. The result
 * is an exact-limit child the package book matches as a plain limit order; nothing is inferred.
 */
export function activatePackageOrder(
  orderInput: PackageOrderInput,
  evidence: OrderActivationEvidence,
):
  | { readonly active: true; readonly maximumQuantityAtoms: bigint; readonly sliceIndex?: number }
  | { readonly active: false; readonly reason: OrderActivationRejection } {
  const order = packageOrder(orderInput);
  object(evidence, 'activatePackageOrder.evidence');
  const reject = (reason: OrderActivationRejection) => Object.freeze({ active: false as const, reason });
  const at = unsigned(evidence.atValue, U64_BITS, 'activatePackageOrder.atValue');
  if (at >= order.expiryValue) return reject('ORDER_EXPIRED');
  const type = order.packageOrderType;
  const immediate = type === 'LIMIT' || type === 'MARKETABLE_LIMIT' || type === 'POST_ONLY';
  if (immediate) {
    if (order.activationConditionHash !== undefined || order.executionScheduleHash !== undefined) return reject('ACTIVATION_NOT_EXPECTED');
    return Object.freeze({ active: true as const, maximumQuantityAtoms: order.quantity.atoms });
  }
  const scheduled = type === 'SCHEDULED' || type === 'PACKAGE_TWAP';
  if ((type === 'CONDITIONAL' && order.activationConditionHash === undefined) || (scheduled && order.executionScheduleHash === undefined)) {
    return reject('ACTIVATION_NOT_BOUND');
  }
  if (type === 'CONDITIONAL' && order.executionScheduleHash !== undefined) return reject('ACTIVATION_NOT_EXPECTED');
  if (order.activationConditionHash !== undefined) {
    if (evidence.condition === undefined || compareBytes(activationConditionHash(evidence.condition), order.activationConditionHash) !== 0) {
      return reject('CONDITION_MISMATCH');
    }
    // `atValue` is in the order's expiry unit; a condition timed in another unit cannot be judged.
    if (activationCondition(evidence.condition).observationUnit !== order.expiryUnit) return reject('TIME_UNIT_MISMATCH');
    const verdict = evaluateActivationCondition(evidence.condition, evidence.observations, at);
    if (!verdict.satisfied) return reject(verdict.reason);
  }
  if (!scheduled) return Object.freeze({ active: true as const, maximumQuantityAtoms: order.quantity.atoms });
  if (evidence.schedule === undefined || compareBytes(executionScheduleHash(evidence.schedule), order.executionScheduleHash as Uint8Array) !== 0) {
    return reject('SCHEDULE_MISMATCH');
  }
  const schedule = executionSchedule(evidence.schedule);
  if (schedule.kind !== type) return reject('SCHEDULE_MISMATCH');
  if (schedule.timeUnit !== order.expiryUnit) return reject('TIME_UNIT_MISMATCH');
  if (schedule.aggregateQuantityLimit > order.quantity.atoms) return reject('SCHEDULE_ABOVE_ORDER');
  if (evidence.progress === undefined) throw new MalformedInputError('activatePackageOrder.progress', 'a scheduled order needs its progress');
  const slice = nextScheduleSlice(schedule, evidence.progress, at);
  if (!slice.due) return reject(slice.reason);
  return Object.freeze({ active: true as const, maximumQuantityAtoms: slice.maximumQuantity, sliceIndex: slice.sliceIndex });
}
