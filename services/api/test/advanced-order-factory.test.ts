import assert from "node:assert/strict";
import test from "node:test";
import {
  assetRef,
  executionScheduleHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  toHex,
  type ExecutionScheduleInput,
  type StrategyPackageOrderInput,
} from "@naryx/protocol-types";
import { AdvancedOrderFactory } from "../src/index.js";

function sourceOrder(): StrategyPackageOrderInput {
  const quote = assetRef("usdc", "32".repeat(32), 6);
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
    economicQuantity: { asset: assetRef("sol", "31".repeat(32), 9), atoms: 100n },
    quoteAsset: quote,
    metricLimits: [],
    maximumServiceFeesByAsset: [],
    maximumVenueFeesByAsset: [],
    maximumNetworkFeesByAsset: [],
    maximumRecoveryCostByAsset: [],
    maximumMarginIncrease: { asset: quote, atoms: 0n },
    maximumResidualValue: { asset: quote, atoms: 0n },
    expiryUnit: "EVM_UNIX_SECONDS",
    expiryValue: 2_000n,
    nonce: 1n,
  };
}

const schedule = (overrides: Partial<ExecutionScheduleInput> = {}): ExecutionScheduleInput => ({
  scheduleVersion: 1,
  kind: "PACKAGE_TWAP",
  timeUnit: "EVM_UNIX_SECONDS",
  startValue: 1_000n,
  sliceInterval: 60n,
  sliceCount: 4,
  aggregateQuantityLimit: 100n,
  maximumSliceQuantity: 25n,
  aggregateLimitPriceTicks: 100n,
  stopRule: "STOP_ON_FIRST_FAILURE",
  ...overrides,
});

test("derives, admits, and registers a bound TWAP from an immediate strategy order", () => {
  const source = strategyPackageOrder(sourceOrder());
  const sourceHash = toHex(strategyPackageOrderHash(source));
  let admitted: StrategyPackageOrderInput | undefined;
  let registeredHash = "";
  const factory = new AdvancedOrderFactory({
    orders: { order: (hash) => hash === sourceHash ? { orderHashHex: sourceHash, graphHashHex: toHex(source.graphHash), order: source, graph: {} as never, recordedAtMs: 1 } : undefined },
    intake: { store: (order, _graph, atSlot) => {
      admitted = order;
      const checked = strategyPackageOrder(order);
      return { version: 1, status: "STORED_FOR_QUOTING", created: true, orderHashHex: toHex(strategyPackageOrderHash(checked)), graphHashHex: toHex(checked.graphHash), currentTime: { unit: checked.expiryUnit, value: atSlot ?? 1_000n }, timeSource: "SERVER", stages: [] };
    } },
    activations: { register: ({ orderHashHex, schedule: boundSchedule }) => {
      registeredHash = orderHashHex;
      if (boundSchedule === undefined) assert.fail("TWAP schedule was not registered");
      const order = strategyPackageOrder(admitted!);
      return { created: true, view: { orderHashHex, order, schedule: boundSchedule, status: "WAITING", progress: { attemptedSlices: 0, failedSlices: 0, executedQuantity: 0n, executedNotionalTicks: 0n }, attempts: [], registeredAtMs: 1, updatedAtMs: 1 } };
    } },
  });

  const result = factory.derive({ sourceOrderHashHex: sourceHash, schedule: schedule() });
  assert.equal(result.order.packageOrderType, "PACKAGE_TWAP");
  assert.equal(toHex(result.order.executionScheduleHash!), toHex(executionScheduleHash(schedule())));
  assert.equal(result.intake.orderHashHex, registeredHash);
});

test("rejects a schedule whose last slice reaches order expiry", () => {
  const source = strategyPackageOrder(sourceOrder());
  const sourceHash = toHex(strategyPackageOrderHash(source));
  const factory = new AdvancedOrderFactory({
    orders: { order: () => ({ orderHashHex: sourceHash, graphHashHex: toHex(source.graphHash), order: source, graph: {} as never, recordedAtMs: 1 }) },
    intake: { store: () => assert.fail("invalid schedule reached intake") },
    activations: { register: () => assert.fail("invalid schedule reached registration") },
  });
  assert.throws(() => factory.derive({ sourceOrderHashHex: sourceHash, schedule: schedule({ startValue: 1_900n, sliceInterval: 50n, sliceCount: 3 }) }), { code: "SCHEDULE_OUTLIVES_ORDER" });
});
