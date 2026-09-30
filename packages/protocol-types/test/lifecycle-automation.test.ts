import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  activatePackageOrder,
  activationConditionHash,
  authorizeKeeperAction,
  evaluateActivationCondition,
  executionScheduleHash,
  isRiskReducing,
  keeperActionAuthorizationHash,
  nextScheduleSlice,
  strategyHealthSnapshotHash,
  toHex,
  twapSliceWithinLimit,
  type ActivationConditionInput,
  type ExecutionScheduleInput,
  type KeeperActionAuthorizationInput,
  type KeeperActionRequest,
  type StrategyHealthSnapshotInput,
} from '../src/index.js';
import { atomicInput } from './order-fixtures.js';

const condition = (overrides: Partial<ActivationConditionInput> = {}): ActivationConditionInput => ({
  conditionVersion: 1,
  metric: 'BASIS',
  comparator: 'AT_OR_ABOVE',
  threshold: 50n,
  observationUnit: 'EVM_UNIX_SECONDS',
  maximumObservationAge: 30n,
  ...overrides,
});

const schedule = (overrides: Partial<ExecutionScheduleInput> = {}): ExecutionScheduleInput => ({
  scheduleVersion: 1,
  kind: 'SCHEDULED',
  timeUnit: 'EVM_UNIX_SECONDS',
  startValue: 1_000n,
  sliceInterval: 60n,
  sliceCount: 4,
  aggregateQuantityLimit: 100n,
  maximumSliceQuantity: 30n,
  stopRule: 'STOP_ON_FIRST_FAILURE',
  ...overrides,
});

const health = (overrides: Partial<StrategyHealthSnapshotInput> = {}): StrategyHealthSnapshotInput => ({
  snapshotVersion: 1,
  environment: 'testnet',
  strategyId: 'strategy-1',
  strategyStateHash: '51'.repeat(32),
  observedAtUnit: 'EVM_UNIX_SECONDS',
  observedAtValue: 1_000n,
  deltaBaseAtoms: -40n,
  grossNotionalQuoteAtoms: 10_000n,
  leverageBps: 30_000n,
  marginHealthBps: 2_500n,
  liquidationDistanceBps: 1_800n,
  basisTicks: 60n,
  fundingPpm: 120n,
  volatilityPpm: 450_000n,
  residualBaseAtoms: 0n,
  maximumLossBoundQuoteAtoms: 900n,
  dependencyState: 'HEALTHY',
  recoveryCapacityQuoteAtoms: 5_000n,
  evidenceHash: '52'.repeat(32),
  ...overrides,
});

const authorization = (overrides: Partial<KeeperActionAuthorizationInput> = {}): KeeperActionAuthorizationInput => ({
  authorizationVersion: 1,
  environment: 'testnet',
  strategyId: 'strategy-1',
  templateId: 'cash-and-carry-v1',
  templateVersion: 1,
  packageTemplateManifestHash: '44'.repeat(32),
  lifecycleGraphHash: '61'.repeat(32),
  actionKind: 'REBALANCE',
  conditionHash: activationConditionHash(condition()),
  maximumCostQuoteAtoms: 100n,
  resultingRiskBound: {
    maximumLeverageBps: 30_000n,
    maximumGrossNotionalQuoteAtoms: 10_000n,
    maximumLossBoundQuoteAtoms: 900n,
    maximumAbsoluteDeltaBaseAtoms: 40n,
    minimumMarginHealthBps: 2_000n,
  },
  riskReducing: true,
  rewardQuoteAtoms: 10n,
  permittedKeeperIds: [],
  expiryUnit: 'EVM_UNIX_SECONDS',
  expiryValue: 2_000n,
  authorizationNonce: 7n,
  ...overrides,
});

const request = (overrides: Partial<KeeperActionRequest> = {}): KeeperActionRequest => ({
  keeperId: 'keeper-1',
  lifecycleGraphHash: '61'.repeat(32),
  condition: condition(),
  before: health(),
  after: health({ deltaBaseAtoms: -10n, grossNotionalQuoteAtoms: 8_000n, leverageBps: 24_000n, maximumLossBoundQuoteAtoms: 700n }),
  currentStrategyStateHash: '51'.repeat(32),
  costQuoteAtoms: 80n,
  rewardQuoteAtoms: 10n,
  grantsAuthority: false,
  manualTakeover: false,
  nonceConsumed: false,
  atValue: 1_010n,
  ...overrides,
});

describe('activation conditions', () => {
  test('a condition holds only on a fresh observation of its own metric', () => {
    const observed = [{ metric: 'BASIS' as const, value: 60n, observedAtValue: 1_000n }];
    assert.deepEqual(evaluateActivationCondition(condition(), observed, 1_030n), { satisfied: true });
    assert.deepEqual(evaluateActivationCondition(condition(), observed, 1_031n), { satisfied: false, reason: 'STALE_OBSERVATION' });
    assert.deepEqual(evaluateActivationCondition(condition(), observed, 999n), { satisfied: false, reason: 'OBSERVATION_FROM_FUTURE' });
    assert.deepEqual(evaluateActivationCondition(condition({ metric: 'FUNDING' }), observed, 1_000n), { satisfied: false, reason: 'METRIC_UNAVAILABLE' });
    assert.deepEqual(evaluateActivationCondition(condition({ threshold: 61n }), observed, 1_000n), { satisfied: false, reason: 'NOT_SATISFIED' });
    assert.deepEqual(evaluateActivationCondition(condition({ comparator: 'AT_OR_BELOW', threshold: 60n }), observed, 1_000n), { satisfied: true });
    assert.throws(() => evaluateActivationCondition(condition(), [...observed, ...observed], 1_000n), /observed twice/);
  });

  test('a time condition waits on the clock and only forward', () => {
    const time = condition({ metric: 'TIME', threshold: 1_500n });
    assert.deepEqual(evaluateActivationCondition(time, [], 1_499n), { satisfied: false, reason: 'NOT_SATISFIED' });
    assert.deepEqual(evaluateActivationCondition(time, [], 1_500n), { satisfied: true });
    assert.throws(() => activationConditionHash(condition({ metric: 'TIME', comparator: 'AT_OR_BELOW' })), /only wait until a time/);
  });

  test('every field of a condition is bound by its hash', () => {
    const base = toHex(activationConditionHash(condition()));
    for (const changed of [{ threshold: 51n }, { comparator: 'AT_OR_BELOW' as const }, { maximumObservationAge: 31n }, { metric: 'FUNDING' as const }]) {
      assert.notEqual(toHex(activationConditionHash(condition(changed))), base);
    }
  });
});

describe('execution schedules', () => {
  const progress = (executedQuantity: bigint, attemptedSlices: number, failedSlices = 0, lastAttemptedSliceIndex = attemptedSlices - 1) => ({
    executedQuantity,
    executedNotionalTicks: 0n,
    attemptedSlices,
    failedSlices,
    ...(attemptedSlices === 0 ? {} : { lastAttemptedSliceIndex }),
  });

  test('slices come due in order, are capped by the aggregate limit, and are never doubled', () => {
    assert.deepEqual(nextScheduleSlice(schedule(), progress(0n, 0), 999n), { due: false, reason: 'NOT_STARTED' });
    assert.deepEqual(nextScheduleSlice(schedule(), progress(0n, 0), 1_000n), { due: true, sliceIndex: 0, maximumQuantity: 30n });
    assert.deepEqual(nextScheduleSlice(schedule(), progress(30n, 1), 1_059n), { due: false, reason: 'NOT_DUE' });
    // A missed slice is skipped: at the third window only the third slice is due.
    assert.deepEqual(nextScheduleSlice(schedule(), progress(30n, 1), 1_120n), { due: true, sliceIndex: 2, maximumQuantity: 30n });
    assert.deepEqual(nextScheduleSlice(schedule(), progress(90n, 3), 1_180n), { due: true, sliceIndex: 3, maximumQuantity: 10n });
    assert.deepEqual(nextScheduleSlice(schedule(), progress(100n, 3), 1_180n), { due: false, reason: 'COMPLETE' });
    assert.deepEqual(nextScheduleSlice(schedule(), progress(60n, 2), 1_240n), { due: false, reason: 'EXPIRED' });
    assert.throws(() => nextScheduleSlice(schedule(), progress(101n, 3), 1_180n), /exceeds the aggregate limit/);
  });

  test('a window already attempted stays attempted after earlier windows were missed', () => {
    // Slice 0 ran, slice 1 was missed, slice 2 ran at 1120: the rest of window 2 is not due again.
    assert.deepEqual(nextScheduleSlice(schedule(), progress(60n, 2, 0, 2), 1_125n), { due: false, reason: 'NOT_DUE' });
    assert.deepEqual(nextScheduleSlice(schedule(), progress(60n, 2, 0, 2), 1_180n), { due: true, sliceIndex: 3, maximumQuantity: 30n });
    // An attempt in the last window completes the schedule even when earlier windows were missed.
    assert.deepEqual(nextScheduleSlice(schedule(), progress(30n, 1, 0, 3), 1_181n), { due: false, reason: 'COMPLETE' });
    assert.throws(() => nextScheduleSlice(schedule(), { executedQuantity: 30n, executedNotionalTicks: 0n, attemptedSlices: 1, failedSlices: 0 }, 1_060n), /inconsistent/);
    assert.throws(() => nextScheduleSlice(schedule(), progress(60n, 3, 0, 1), 1_180n), /inconsistent/);
    assert.throws(() => nextScheduleSlice(schedule(), progress(60n, 1, 0, 4), 1_180n), /inconsistent/);
  });

  test('the stop rule decides what one failed slice does to the rest', () => {
    assert.deepEqual(nextScheduleSlice(schedule(), progress(0n, 1, 1), 1_060n), { due: false, reason: 'STOPPED' });
    assert.deepEqual(nextScheduleSlice(schedule({ stopRule: 'SKIP_FAILED_SLICE' }), progress(0n, 1, 1), 1_060n), { due: true, sliceIndex: 1, maximumQuantity: 30n });
  });

  test('a package TWAP keeps its running average inside the signed limit', () => {
    const twap = schedule({ kind: 'PACKAGE_TWAP', aggregateLimitPriceTicks: 100n });
    const filled = { executedQuantity: 30n, executedNotionalTicks: 30n * 98n, attemptedSlices: 1, failedSlices: 0, lastAttemptedSliceIndex: 0 };
    assert.equal(twapSliceWithinLimit(twap, filled, 'BID', 102n, 30n), true);
    assert.equal(twapSliceWithinLimit(twap, filled, 'BID', 103n, 30n), false);
    assert.equal(twapSliceWithinLimit(twap, filled, 'ASK', 102n, 30n), true);
    assert.throws(() => executionScheduleHash(schedule({ aggregateLimitPriceTicks: 100n })), /only a TWAP/);
    assert.throws(() => executionScheduleHash(schedule({ kind: 'PACKAGE_TWAP' })), /only a TWAP/);
    assert.throws(() => executionScheduleHash(schedule({ maximumSliceQuantity: 101n })), /cannot exceed the aggregate/);
  });
});

describe('package order activation', () => {
  const observed = [{ metric: 'BASIS' as const, value: 60n, observedAtValue: 1_000n }];
  const orderAt = (overrides: Parameters<typeof atomicInput>[0]) => atomicInput(overrides);
  // The atomic fixture expires in Solana slots, so its condition and schedule are timed in slots.
  const slotCondition = (overrides: Partial<ActivationConditionInput> = {}) => condition({ observationUnit: 'SOLANA_SLOT', ...overrides });
  const slotSchedule = (overrides: Partial<ExecutionScheduleInput> = {}) => schedule({ timeUnit: 'SOLANA_SLOT', ...overrides });

  test('an immediate order binds no activation and executes in full', () => {
    const order = orderAt({ packageOrderType: 'LIMIT' });
    const full = activatePackageOrder(order, { observations: [], atValue: 1n });
    assert.equal(full.active, true);
    assert.deepEqual(activatePackageOrder(orderAt({ packageOrderType: 'LIMIT', activationConditionHash: activationConditionHash(slotCondition()) }), { observations: [], atValue: 1n }), {
      active: false,
      reason: 'ACTIVATION_NOT_EXPECTED',
    });
  });

  test('a conditional order executes only under the exact condition it signed', () => {
    const order = orderAt({ packageOrderType: 'CONDITIONAL', activationConditionHash: activationConditionHash(slotCondition()) });
    assert.equal(activatePackageOrder(order, { condition: slotCondition(), observations: observed, atValue: 1_000n }).active, true);
    assert.deepEqual(activatePackageOrder(order, { condition: slotCondition({ threshold: 10n }), observations: observed, atValue: 1_000n }), { active: false, reason: 'CONDITION_MISMATCH' });
    assert.deepEqual(activatePackageOrder(order, { condition: slotCondition(), observations: [], atValue: 1_000n }), { active: false, reason: 'METRIC_UNAVAILABLE' });
    assert.deepEqual(activatePackageOrder(orderAt({ packageOrderType: 'CONDITIONAL' }), { observations: [], atValue: 1_000n }), { active: false, reason: 'ACTIVATION_NOT_BOUND' });
  });

  test('a scheduled order executes only the due slice of the schedule it signed, within its quantity', () => {
    const quantity = atomicInput().quantity;
    const bounded = slotSchedule({ aggregateQuantityLimit: quantity.atoms, maximumSliceQuantity: quantity.atoms / 4n });
    const order = orderAt({ packageOrderType: 'SCHEDULED', executionScheduleHash: executionScheduleHash(bounded) });
    const progress = { executedQuantity: 0n, executedNotionalTicks: 0n, attemptedSlices: 0, failedSlices: 0 };
    assert.deepEqual(activatePackageOrder(order, { schedule: bounded, progress, observations: [], atValue: 1_000n }), {
      active: true,
      maximumQuantityAtoms: quantity.atoms / 4n,
      sliceIndex: 0,
    });
    const tooLarge = slotSchedule({ aggregateQuantityLimit: quantity.atoms + 1n, maximumSliceQuantity: 1n });
    assert.deepEqual(
      activatePackageOrder(orderAt({ packageOrderType: 'SCHEDULED', executionScheduleHash: executionScheduleHash(tooLarge) }), { schedule: tooLarge, progress, observations: [], atValue: 1_000n }),
      { active: false, reason: 'SCHEDULE_ABOVE_ORDER' },
    );
    const twap = orderAt({ packageOrderType: 'PACKAGE_TWAP', executionScheduleHash: executionScheduleHash(bounded) });
    assert.deepEqual(activatePackageOrder(twap, { schedule: bounded, progress, observations: [], atValue: 1_000n }), { active: false, reason: 'SCHEDULE_MISMATCH' });
    assert.deepEqual(activatePackageOrder(order, { schedule: bounded, progress, observations: [], atValue: atomicInput().expiryValue }), { active: false, reason: 'ORDER_EXPIRED' });
  });

  test('a condition or schedule timed in another unit than the order never activates it', () => {
    const secondsCondition = condition({ metric: 'TIME', threshold: 1_000n });
    const conditional = orderAt({ packageOrderType: 'CONDITIONAL', activationConditionHash: activationConditionHash(secondsCondition) });
    assert.deepEqual(activatePackageOrder(conditional, { condition: secondsCondition, observations: [], atValue: 1_000n }), { active: false, reason: 'TIME_UNIT_MISMATCH' });
    const secondsSchedule = schedule({ aggregateQuantityLimit: 1n, maximumSliceQuantity: 1n });
    const scheduled = orderAt({ packageOrderType: 'SCHEDULED', executionScheduleHash: executionScheduleHash(secondsSchedule) });
    const progress = { executedQuantity: 0n, executedNotionalTicks: 0n, attemptedSlices: 0, failedSlices: 0 };
    assert.deepEqual(activatePackageOrder(scheduled, { schedule: secondsSchedule, progress, observations: [], atValue: 1_000n }), { active: false, reason: 'TIME_UNIT_MISMATCH' });
  });
});

describe('strategy health and keeper actions', () => {
  test('the risk-reducing proof rejects any increase in leverage, notional, loss, delta, or authority', () => {
    assert.deepEqual(isRiskReducing(health(), request().after, false), { riskReducing: true, increases: [] });
    assert.deepEqual(
      isRiskReducing(health(), health({ leverageBps: 30_001n, grossNotionalQuoteAtoms: 10_001n, maximumLossBoundQuoteAtoms: 901n, deltaBaseAtoms: 41n }), true).increases,
      ['LEVERAGE', 'NOTIONAL', 'LOSS_BOUND', 'ABSOLUTE_DELTA', 'AUTHORITY'],
    );
    assert.throws(() => isRiskReducing(health(), health({ strategyId: 'strategy-2' }), false), /different strategies/);
    assert.notEqual(toHex(strategyHealthSnapshotHash(health())), toHex(strategyHealthSnapshotHash(health({ basisTicks: 61n }))));
  });

  test('an authorized risk-reducing rebalance executes and every bound rejects', () => {
    const granted = authorizeKeeperAction(authorization(), request());
    assert.equal(granted.authorized, true);
    if (granted.authorized) assert.equal(toHex(granted.authorizationHash), toHex(keeperActionAuthorizationHash(authorization())));
    const cases: [Partial<KeeperActionAuthorizationInput>, Partial<KeeperActionRequest>, string][] = [
      [{}, { atValue: 2_000n }, 'EXPIRED'],
      [{}, { manualTakeover: true }, 'MANUAL_TAKEOVER'],
      [{}, { nonceConsumed: true }, 'REPLAY'],
      [{ permittedKeeperIds: ['keeper-2'] }, {}, 'KEEPER_NOT_PERMITTED'],
      [{}, { before: health({ strategyId: 'strategy-2' }) }, 'STRATEGY_MISMATCH'],
      [{}, { lifecycleGraphHash: '62'.repeat(32) }, 'GRAPH_MISMATCH'],
      [{}, { currentStrategyStateHash: '53'.repeat(32) }, 'STATE_CHANGED'],
      [{}, { condition: condition({ threshold: 49n }) }, 'CONDITION_MISMATCH'],
      [{}, { before: health({ basisTicks: 49n }) }, 'CONDITION_NOT_MET'],
      [{}, { rewardQuoteAtoms: 11n }, 'REWARD_ABOVE_BOUND'],
      [{}, { costQuoteAtoms: 91n }, 'COST_ABOVE_BOUND'],
      [{}, { after: health({ marginHealthBps: 1_999n, deltaBaseAtoms: -10n }) }, 'RESULTING_RISK_ABOVE_BOUND'],
      [{}, { grantsAuthority: true }, 'NOT_RISK_REDUCING'],
      [{}, { before: health({ dependencyState: 'HALTED' }) }, 'DEPENDENCY_HALTED'],
      [{}, { before: health({ observedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS' }) }, 'TIME_UNIT_MISMATCH'],
      [{}, { after: health({ observedAtUnit: 'SOLANA_SLOT' }) }, 'TIME_UNIT_MISMATCH'],
      [{ expiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS' }, {}, 'TIME_UNIT_MISMATCH'],
    ];
    for (const [authorizationChange, requestChange, reason] of cases) {
      const verdict = authorizeKeeperAction(authorization(authorizationChange), request(requestChange));
      assert.equal(verdict.authorized ? 'AUTHORIZED' : verdict.reason, reason, reason);
    }
  });

  test('a halted dependency still allows emergency risk reduction, and a reward cannot exceed the cost bound', () => {
    const emergency = authorization({ actionKind: 'EMERGENCY_RISK_REDUCTION' });
    assert.equal(authorizeKeeperAction(emergency, request({ before: health({ dependencyState: 'HALTED' }) })).authorized, true);
    assert.throws(() => keeperActionAuthorizationHash(authorization({ rewardQuoteAtoms: 101n })), /reward exceeds the cost bound/);
    assert.throws(() => keeperActionAuthorizationHash(authorization({ permittedKeeperIds: ['keeper-1', 'keeper-1'] })), /keepers repeat/);
  });

  test('a non-risk-reducing authorization still enforces its resulting risk bound', () => {
    const neutral = authorization({ riskReducing: false, resultingRiskBound: { ...authorization().resultingRiskBound, maximumLeverageBps: 32_000n } });
    const growing = request({ after: health({ leverageBps: 31_000n }) });
    const verdict = authorizeKeeperAction(neutral, growing);
    assert.equal(verdict.authorized, true);
    if (verdict.authorized) assert.deepEqual(verdict.riskIncreases, ['LEVERAGE']);
    assert.equal(authorizeKeeperAction(neutral, request({ after: health({ leverageBps: 32_001n }) })).authorized, false);
  });
});
