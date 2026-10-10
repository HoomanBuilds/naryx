import assert from "node:assert/strict";
import test from "node:test";
import {
  assetRef,
  adapterRef,
  domainRef,
  executionScheduleHash,
  packageGraph,
  packageGraphHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  toHex,
  versionedManifestRef,
  type ExecutionScheduleInput,
  type StrategyPackageOrderInput,
} from "@naryx/protocol-types";
import { AdvancedOrderExecutionFactory, AdvancedOrderFactory } from "../src/index.js";

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

test("prepares a proportional immediate child for a reserved advanced-order attempt", () => {
  const quote = assetRef("usdc", "32".repeat(32), 6);
  const base = assetRef("sol", "31".repeat(32), 9);
  const domain = domainRef("evm:11155111", 1, "41".repeat(32));
  const adapter = adapterRef({ adapterId: "spot-v1", adapterManifestVersion: 1, adapterManifestHash: "42".repeat(32) });
  const venue = versionedManifestRef("venue-1", 1, "43".repeat(32));
  const market = versionedManifestRef("sol-usdc", 1, "44".repeat(32));
  const graph = packageGraph({
    graphVersion: 1,
    environment: "testnet",
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: "33".repeat(32),
    seriesId: "sol-carry",
    seriesVersion: 1,
    seriesManifestHash: "35".repeat(32),
    executionClassId: "sol-carry-atomic",
    executionClassVersion: 1,
    executionClassManifestHash: "36".repeat(32),
    lifecycleAction: "ENTRY",
    owner: "owner-1",
    strategyAccountRefs: ["strategy-1"],
    legs: [{
      legId: "spot",
      legFamily: "SPOT_SWAP",
      legTypeId: "spot-purchase",
      domain,
      adapter,
      venue,
      market,
      assets: [base, quote],
      side: "BUY",
      quantityAsset: base,
      quantityAtoms: 100n,
      minimumQuantityAtoms: 100n,
      limitPrice: { baseAsset: base, quoteAsset: quote, quoteAtoms: 100n, baseAtoms: 1n, roundingDirection: "CEIL" },
      maximumFeeQuoteAtoms: 20n,
      preconditionHashes: [],
      postconditionHashes: [],
      timeInForce: "FOK",
      legExpiryValue: 1_900n,
    }],
    dependencyEdges: [],
    executionGroups: [{ groupId: "atomic", kind: "ALL_OR_NONE", legIds: ["spot"] }],
    settlementClass: "ATOMIC_POSTCONDITION",
    policyHashes: {
      netting: "51".repeat(32), privacy: "52".repeat(32), solver: "53".repeat(32),
      delivery: "54".repeat(32), resource: "55".repeat(32), portfolioRiskLimits: "56".repeat(32),
    },
    recoverySlots: [],
    maximumRecoveryCostQuoteAtoms: 0n,
    expiryUnit: "EVM_UNIX_SECONDS",
    packageExpiryValue: 2_000n,
    nonce: 1n,
  });
  const source = strategyPackageOrder({
    ...sourceOrder(),
    graphHash: packageGraphHash(graph),
    maximumServiceFeesByAsset: [{ asset: quote, maxAtoms: 40n }],
  });
  const sourceHash = toHex(strategyPackageOrderHash(source));
  const parent = strategyPackageOrder({ ...source, packageOrderType: "SCHEDULED", executionScheduleHash: executionScheduleHash(schedule()) });
  const parentHash = toHex(strategyPackageOrderHash(parent));
  const attemptId = "62".repeat(32);
  let boundChildHash = "";
  const factory = new AdvancedOrderExecutionFactory({
    orders: { order: (hash) => hash === sourceHash ? {
      orderHashHex: sourceHash,
      graphHashHex: toHex(packageGraphHash(graph)),
      order: source,
      graph,
      recordedAtMs: 1,
    } : undefined },
    intake: { store: (orderInput, graphInput) => {
      const checkedOrder = strategyPackageOrder(orderInput);
      const checkedGraph = packageGraph(graphInput);
      assert.equal(checkedOrder.economicQuantity.atoms, 25n);
      assert.equal(checkedGraph.legs[0]?.quantityAtoms, 25n);
      assert.equal(checkedOrder.maximumServiceFeesByAsset[0]?.maxAtoms, 10n);
      return {
        version: 1, status: "STORED_FOR_QUOTING", created: true,
        orderHashHex: toHex(strategyPackageOrderHash(checkedOrder)),
        graphHashHex: toHex(packageGraphHash(checkedGraph)),
        currentTime: { unit: "EVM_UNIX_SECONDS", value: 1_000n }, timeSource: "SERVER", stages: [],
      };
    } },
    activations: {
      attempt: (requested) => requested === attemptId ? {
        attemptId, orderHashHex: parentHash, ordinal: 0, sliceIndex: 0, atValue: 1_000n,
        maximumQuantityAtoms: 25n, side: "BID", limitPriceTicks: 99n, status: "RESERVED", reservedAtMs: 1,
      } : undefined,
      view: (requested) => requested === parentHash ? {
        orderHashHex: parentHash, sourceOrderHashHex: sourceHash,
        order: parent,
        schedule: schedule(), status: "WAITING",
        progress: { attemptedSlices: 0, failedSlices: 0, executedQuantity: 0n, executedNotionalTicks: 0n },
        attempts: [], registeredAtMs: 1, updatedAtMs: 1,
      } : undefined,
      bindChild: (binding) => {
        boundChildHash = binding.childOrderHashHex;
        return {
          replayed: false,
          attempt: {
            attemptId, orderHashHex: parentHash, ordinal: 0, sliceIndex: 0, atValue: 1_000n,
            maximumQuantityAtoms: 25n, side: "BID", limitPriceTicks: 99n, status: "RESERVED", reservedAtMs: 1,
          },
        };
      },
    },
  });
  const prepared = factory.prepare({ attemptId });
  assert.equal(prepared.intake.orderHashHex, boundChildHash);
  assert.equal(prepared.packageBookRequest.strategyOrderHash, boundChildHash);
  assert.equal(prepared.packageBookRequest.limitPriceTicks, 99n);
  assert.equal(toHex(prepared.slicePolicies.NETTING.parentOrderHash), parentHash);
});
