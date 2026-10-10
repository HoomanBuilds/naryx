import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activationConditionHash,
  assetRef,
  executionScheduleHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  strategySlicePolicy,
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  toHex,
  type ActivationConditionInput,
  type ExecutionScheduleInput,
  type StrategyPackageOrderInput,
  type StrategySlicePolicyCategory,
} from "@naryx/protocol-types";
import { SqliteOrderActivationStore } from "../src/index.js";

const sol = assetRef("sol", "31".repeat(32), 9);
const usdc = assetRef("usdc", "32".repeat(32), 6);

function order(overrides: Partial<StrategyPackageOrderInput> = {}): StrategyPackageOrderInput {
  return {
    version: 1,
    environment: "testnet",
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: "33".repeat(32),
    graphHash: "34".repeat(32),
    seriesId: "sol-carry",
    seriesVersion: 1,
    seriesManifestHash: "35".repeat(32),
    executionClassId: "sol-carry-atomic",
    executionClassVersion: 1,
    executionClassManifestHash: "36".repeat(32),
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.ANNUALIZED_NET_YIELD,
    riskClassId: STRATEGY_RISK_CLASS_ID.DELTA_NEUTRAL_BASIS,
    owner: "owner-1",
    settlementAccount: "strategy-1",
    lifecycleAction: "ENTRY",
    settlementClass: "ATOMIC_POSTCONDITION",
    packageOrderType: "LIMIT",
    packageTimeInForce: "FOK",
    economicQuantity: { asset: sol, atoms: 100n },
    quoteAsset: usdc,
    metricLimits: [],
    maximumServiceFeesByAsset: [],
    maximumVenueFeesByAsset: [],
    maximumNetworkFeesByAsset: [],
    maximumRecoveryCostByAsset: [],
    maximumMarginIncrease: { asset: usdc, atoms: 0n },
    maximumResidualValue: { asset: usdc, atoms: 0n },
    expiryUnit: "EVM_UNIX_SECONDS",
    expiryValue: 2_000n,
    nonce: 1n,
    ...overrides,
  };
}

function source(input: StrategyPackageOrderInput) {
  const checked = strategyPackageOrder(input);
  const orderHashHex = toHex(strategyPackageOrderHash(checked));
  return {
    orderHashHex,
    orders: {
      order: (hash: string) => hash === orderHashHex
        ? { orderHashHex, graphHashHex: toHex(checked.graphHash), order: checked, graph: {} as never, recordedAtMs: 1 }
        : undefined,
    },
  };
}

const schedule = (overrides: Partial<ExecutionScheduleInput> = {}): ExecutionScheduleInput => ({
  scheduleVersion: 1,
  kind: "SCHEDULED",
  timeUnit: "EVM_UNIX_SECONDS",
  startValue: 1_000n,
  sliceInterval: 60n,
  sliceCount: 4,
  aggregateQuantityLimit: 100n,
  maximumSliceQuantity: 25n,
  stopRule: "SKIP_FAILED_SLICE",
  ...overrides,
});

test("scheduled activation persists one exact attempt per due window across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-order-activation-"));
  const executionSchedule = schedule();
  const input = order({ packageOrderType: "SCHEDULED", executionScheduleHash: executionScheduleHash(executionSchedule) });
  const { orderHashHex, orders } = source(input);
  const path = join(dir, "activation.sqlite");
  let now = 10;
  let store = new SqliteOrderActivationStore(path, { orders, clock: () => now++ });
  try {
    assert.equal(store.register({ orderHashHex, schedule: executionSchedule }).created, true);
    const first = store.reserve({ orderHashHex, observations: [], atValue: 1_000n, side: "BID", limitPriceTicks: 100n });
    if (!first.active) assert.fail(first.reason);
    assert.equal(first.attempt.sliceIndex, 0);
    assert.equal(first.attempt.maximumQuantityAtoms, 25n);
    const replay = store.reserve({ orderHashHex, observations: [], atValue: 1_000n, side: "BID", limitPriceTicks: 99n });
    assert.equal(replay.active && replay.replayed, true);
    store.complete({ attemptId: first.attempt.attemptId, outcome: "SUCCEEDED", executedQuantityAtoms: 25n, executionPriceTicks: 99n });
    store.close();

    store = new SqliteOrderActivationStore(path, { orders, clock: () => now++ });
    assert.equal(store.view(orderHashHex)?.progress.executedQuantity, 25n);
    assert.deepEqual(store.reserve({ orderHashHex, observations: [], atValue: 1_030n, side: "BID", limitPriceTicks: 100n }), { active: false, reason: "NOT_DUE" });
    const second = store.reserve({ orderHashHex, observations: [], atValue: 1_060n, side: "BID", limitPriceTicks: 100n });
    if (!second.active) assert.fail(second.reason);
    store.complete({ attemptId: second.attempt.attemptId, outcome: "FAILED", executedQuantityAtoms: 0n, failureReason: "venue unavailable" });
    const third = store.reserve({ orderHashHex, observations: [], atValue: 1_120n, side: "BID", limitPriceTicks: 100n });
    assert.equal(third.active && third.attempt.sliceIndex === 2, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package TWAP reservations and completions preserve the signed aggregate limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-order-twap-"));
  const executionSchedule = schedule({ kind: "PACKAGE_TWAP", sliceCount: 2, maximumSliceQuantity: 50n, aggregateLimitPriceTicks: 100n });
  const input = order({ packageOrderType: "PACKAGE_TWAP", executionScheduleHash: executionScheduleHash(executionSchedule) });
  const { orderHashHex, orders } = source(input);
  const store = new SqliteOrderActivationStore(join(dir, "activation.sqlite"), { orders });
  try {
    store.register({ orderHashHex, schedule: executionSchedule });
    const first = store.reserve({ orderHashHex, observations: [], atValue: 1_000n, side: "BID", limitPriceTicks: 99n });
    if (!first.active) assert.fail(first.reason);
    store.complete({ attemptId: first.attempt.attemptId, outcome: "SUCCEEDED", executedQuantityAtoms: 50n, executionPriceTicks: 99n });
    assert.deepEqual(store.reserve({ orderHashHex, observations: [], atValue: 1_060n, side: "BID", limitPriceTicks: 102n }), { active: false, reason: "TWAP_LIMIT_EXCEEDED" });
    const second = store.reserve({ orderHashHex, observations: [], atValue: 1_060n, side: "BID", limitPriceTicks: 101n });
    if (!second.active) assert.fail(second.reason);
    const completed = store.complete({ attemptId: second.attempt.attemptId, outcome: "SUCCEEDED", executedQuantityAtoms: 50n, executionPriceTicks: 101n });
    assert.equal(completed.view.status, "COMPLETED");
    assert.equal(completed.view.progress.executedNotionalTicks, 10_000n);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conditional activation requires a fresh bound observation and becomes terminal once filled", () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-order-condition-"));
  const condition: ActivationConditionInput = {
    conditionVersion: 1,
    metric: "BASIS",
    comparator: "AT_OR_ABOVE",
    threshold: 50n,
    observationUnit: "EVM_UNIX_SECONDS",
    maximumObservationAge: 30n,
  };
  const input = order({ packageOrderType: "CONDITIONAL", activationConditionHash: activationConditionHash(condition) });
  const { orderHashHex, orders } = source(input);
  const store = new SqliteOrderActivationStore(join(dir, "activation.sqlite"), { orders });
  try {
    store.register({ orderHashHex, condition });
    assert.deepEqual(store.reserve({ orderHashHex, observations: [{ metric: "BASIS", value: 60n, observedAtValue: 960n }], atValue: 1_000n, side: "ASK", limitPriceTicks: 100n }), { active: false, reason: "STALE_OBSERVATION" });
    const attempt = store.reserve({ orderHashHex, observations: [{ metric: "BASIS", value: 60n, observedAtValue: 990n }], atValue: 1_000n, side: "ASK", limitPriceTicks: 100n });
    if (!attempt.active) assert.fail(attempt.reason);
    assert.throws(() => store.cancel(orderHashHex), { code: "ATTEMPT_OUTSTANDING" });
    const completed = store.complete({ attemptId: attempt.attempt.attemptId, outcome: "SUCCEEDED", executedQuantityAtoms: 100n, executionPriceTicks: 101n });
    assert.equal(completed.view.status, "COMPLETED");
    assert.deepEqual(store.reserve({ orderHashHex, observations: [], atValue: 1_001n, side: "ASK", limitPriceTicks: 100n }), { active: false, reason: "COMPLETED" });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an activation attempt durably binds one exact executable child", () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-order-child-"));
  const executionSchedule = schedule();
  const sourceOrder = strategyPackageOrder(order());
  const advancedOrder = strategyPackageOrder(order({
    packageOrderType: "SCHEDULED",
    executionScheduleHash: executionScheduleHash(executionSchedule),
  }));
  const sourceOrderHashHex = toHex(strategyPackageOrderHash(sourceOrder));
  const orderHashHex = toHex(strategyPackageOrderHash(advancedOrder));
  const childGraphHashHex = "43".repeat(32);
  const childOrder = strategyPackageOrder(order({
    graphHash: childGraphHashHex,
    economicQuantity: { asset: sol, atoms: 25n },
    nonce: 2n,
  }));
  const childOrderHashHex = toHex(strategyPackageOrderHash(childOrder));
  const orders = {
    order: (hash: string) => {
      const checked = hash === sourceOrderHashHex ? sourceOrder
        : hash === orderHashHex ? advancedOrder
          : hash === childOrderHashHex ? childOrder : undefined;
      return checked === undefined ? undefined : {
        orderHashHex: hash,
        graphHashHex: toHex(checked.graphHash),
        order: checked,
        graph: { nonce: 1n } as never,
        recordedAtMs: 1,
      };
    },
  };
  const store = new SqliteOrderActivationStore(join(dir, "activation.sqlite"), { orders, clock: () => 10 });
  try {
    const registered = store.register({ orderHashHex, sourceOrderHashHex, schedule: executionSchedule });
    assert.equal(registered.view.sourceOrderHashHex, sourceOrderHashHex);
    const reservation = store.reserve({
      orderHashHex,
      observations: [],
      atValue: 1_000n,
      side: "BID",
      limitPriceTicks: 100n,
    });
    if (!reservation.active) assert.fail(reservation.reason);
    const categories = ["NETTING", "PRIVACY", "SOLVER", "DELIVERY", "RESOURCE", "PORTFOLIO_RISK_LIMITS"] as const;
    const policies = Object.fromEntries(categories.map((category) => [category, strategySlicePolicy({
      policyVersion: 1,
      category,
      parentOrderHash: orderHashHex,
      parentGraphHash: advancedOrder.graphHash,
      parentPolicyHash: "41".repeat(32),
      activationAttemptId: reservation.attempt.attemptId,
      parentEconomicQuantity: 100n,
      childEconomicQuantity: 25n,
      graphNonce: 1n,
    })])) as unknown as Record<StrategySlicePolicyCategory, ReturnType<typeof strategySlicePolicy>>;
    const child = store.bindChild({
      attemptId: reservation.attempt.attemptId,
      childOrderHashHex,
      childGraphHashHex,
      slicePolicies: policies,
    });
    assert.equal(child.replayed, false);
    assert.equal(child.attempt.childOrderHashHex, childOrderHashHex);
    assert.equal(store.bindChild({
      attemptId: reservation.attempt.attemptId,
      childOrderHashHex,
      childGraphHashHex,
      slicePolicies: policies,
    }).replayed, true);
    const completed = store.completeWithEvidence({
      attemptId: reservation.attempt.attemptId,
      outcome: "SUCCEEDED",
      childOrderHashHex,
      packageOrderIdHex: "45".repeat(32),
      allocationHashHex: "46".repeat(32),
      receiptHashHex: "47".repeat(32),
      allocatedQuantityAtoms: 25n,
      allocatedNotionalTicks: 2_475n,
    });
    assert.equal(completed.view.progress.executedNotionalTicks, 2_475n);
    assert.equal(completed.view.attempts[0]?.settlementEvidence?.receiptHashHex, "47".repeat(32));
    assert.equal(store.completeWithEvidence({
      attemptId: reservation.attempt.attemptId,
      outcome: "SUCCEEDED",
      childOrderHashHex,
      packageOrderIdHex: "45".repeat(32),
      allocationHashHex: "46".repeat(32),
      receiptHashHex: "47".repeat(32),
      allocatedQuantityAtoms: 25n,
      allocatedNotionalTicks: 2_475n,
    }).replayed, true);
    assert.throws(() => store.bindChild({
      attemptId: reservation.attempt.attemptId,
      childOrderHashHex: "44".repeat(32),
      childGraphHashHex,
      slicePolicies: policies,
    }), { code: "CHILD_CONFLICT" });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
