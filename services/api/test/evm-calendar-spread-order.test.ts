import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adapterRef,
  assetRef,
  domainRef,
  manifestHash,
  packageGraph,
  packageGraphHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  stringifyProtocolJson,
  toHex,
  validateStrategyTemplateGraph,
  versionedManifestRef,
  type PackageGraphInput,
  type StrategyPackageOrderInput,
} from "@naryx/protocol-types";
import {
  AdvancedOrderExecutionFactory,
  AdvancedOrderFactory,
  createEvmCalendarSpreadOrderPort,
  EvmCalendarSpreadOrderError,
  loadEvmCalendarSpreadProfiles,
  SqliteOrderActivationStore,
  type EvmCalendarSpreadProfile,
} from "../src/index.js";
import type { StrategyOrderIntakePort } from "../src/strategy-order-intake.js";
import type { StoredStrategyPackageOrder } from "../src/strategy-package-store.js";

const NOW_SECONDS = 1_000_000;
const OWNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";

function profile(): EvmCalendarSpreadProfile {
  const market = (role: "near-future" | "far-future", maturity: bigint, byte: string) => Object.freeze({
    role,
    adapter: adapterRef({
      adapterId: `base-calendar-${role}`,
      adapterManifestVersion: 1,
      adapterManifestHash: byte.repeat(32),
    }),
    venue: versionedManifestRef("naryx-evm-conformance-futures", 1, "41".repeat(32)),
    market: versionedManifestRef(`ntbase-${role}`, 1, byte.repeat(32)),
    maturity,
  });
  return Object.freeze({
    profileId: "base-sepolia-ntbase-calendar",
    displayName: "ntBASE calendar spread",
    templateId: "calendar-spread-v1",
    templateVersion: 1,
    packageTemplateManifestHash: manifestHash("21".repeat(32)),
    seriesId: "ntbase-calendar-series",
    seriesVersion: 1,
    seriesManifestHash: manifestHash("22".repeat(32)),
    executionClassId: "base-sepolia-calendar-atomic",
    executionClassVersion: 1,
    executionClassManifestHash: manifestHash("23".repeat(32)),
    chainId: 84_532,
    domain: domainRef("eip155:84532", 1, "11".repeat(32)),
    accountFactory: "0x3333333333333333333333333333333333333333",
    baseAsset: assetRef("base-sepolia:ntbase", "31".repeat(32), 18),
    quoteAsset: assetRef("base-sepolia:ntquote", "32".repeat(32), 6),
    markets: Object.freeze([
      market("near-future", 2_000_000n, "51"),
      market("far-future", 3_000_000n, "52"),
    ] as const),
    metricLimits: Object.freeze([]),
    bounds: Object.freeze({
      minimumQuantityAtoms: 1_000n,
      maximumQuantityAtoms: 1_000_000_000_000_000_000n,
      maximumServiceFeeQuoteAtoms: 10_000n,
      maximumVenueFeeQuoteAtoms: 20_000n,
      maximumNetworkFeeQuoteAtoms: 30_000n,
      maximumMarginIncreaseQuoteAtoms: 50_000_000n,
      maximumExpiryTtlSeconds: 3_600n,
    }),
  });
}

const intake: StrategyOrderIntakePort = Object.freeze({
  store(orderInput: StrategyPackageOrderInput, graphInput: PackageGraphInput) {
    const order = strategyPackageOrder(orderInput);
    const graph = packageGraph(graphInput);
    return Object.freeze({
      version: 1 as const,
      status: "STORED_FOR_QUOTING" as const,
      created: true,
      orderHashHex: toHex(strategyPackageOrderHash(order)),
      graphHashHex: toHex(packageGraphHash(graph)),
      currentTime: Object.freeze({ unit: graph.expiryUnit, value: BigInt(NOW_SECONDS) }),
      timeSource: "SERVER" as const,
      stages: Object.freeze([]),
    });
  },
});

function request(lifecycleAction: "ENTRY" | "INCREASE" | "DECREASE" | "EXIT") {
  const increasing = lifecycleAction === "ENTRY" || lifecycleAction === "INCREASE";
  return {
    profileId: "base-sepolia-ntbase-calendar",
    owner: OWNER,
    settlementAccount: ACCOUNT,
    lifecycleAction,
    quantityAtoms: "1000000000000000",
    limitPrices: [
      { legId: "near-future", quoteAtoms: increasing ? "101" : "97", baseAtoms: "1000000000000" },
      { legId: "far-future", quoteAtoms: increasing ? "103" : "107", baseAtoms: "1000000000000" },
    ],
    expiryValue: "1000600",
    nonce: lifecycleAction === "ENTRY" ? "1" : "2",
    ...(lifecycleAction === "ENTRY" ? {} : { expectedStrategyStateHash: "61".repeat(32) }),
  };
}

test("loads a reviewed calendar profile and creates atomic entry and exit orders", () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-evm-calendar-"));
  const path = join(directory, "profiles.json");
  try {
    writeFileSync(path, stringifyProtocolJson({ version: 1, environment: "testnet", profiles: [profile()] }));
    const port = createEvmCalendarSpreadOrderPort({
      profiles: loadEvmCalendarSpreadProfiles(path),
      intake,
      currentTimeSeconds: () => NOW_SECONDS,
    });
    const entry = port.create(request("ENTRY"));
    const scaled = request("ENTRY");
    scaled.limitPrices = scaled.limitPrices.map((limit) => ({
      ...limit,
      quoteAtoms: String(BigInt(limit.quoteAtoms) * 10n),
      baseAtoms: String(BigInt(limit.baseAtoms) * 10n),
    }));
    const equivalent = port.create(scaled);
    assert.equal(equivalent.intake.orderHashHex, entry.intake.orderHashHex);
    assert.equal(equivalent.intake.graphHashHex, entry.intake.graphHashHex);
    assert.deepEqual(entry.graph.legs.map((leg) => [leg.legId, leg.legFamily, leg.side]), [
      ["far-future", "FUTURE_OPEN", "SELL"],
      ["near-future", "FUTURE_OPEN", "BUY"],
    ]);
    assert.equal(entry.graph.executionGroups[0]?.kind, "ALL_OR_NONE");
    assert.equal(entry.order.settlementClass, "ATOMIC_POSTCONDITION");
    assert.equal(entry.order.packageTimeInForce, "FOK");
    assert.equal(validateStrategyTemplateGraph(entry.graph).valid, true);

    const exit = port.create(request("EXIT"));
    assert.deepEqual(exit.graph.legs.map((leg) => [leg.legId, leg.legFamily, leg.side]), [
      ["far-future", "FUTURE_CLOSE", "BUY"],
      ["near-future", "FUTURE_CLOSE", "SELL"],
    ]);
    assert.equal(exit.order.maximumMarginIncrease.atoms, 0n);
    assert.equal(validateStrategyTemplateGraph(exit.graph).valid, true);

    const increase = port.create(request("INCREASE"));
    assert.deepEqual(increase.graph.legs.map((leg) => [leg.legFamily, leg.side]), [
      ["FUTURE_OPEN", "SELL"],
      ["FUTURE_OPEN", "BUY"],
    ]);
    assert.equal(increase.order.maximumMarginIncrease.atoms, 50_000_000n);

    const decrease = port.create(request("DECREASE"));
    assert.deepEqual(decrease.graph.legs.map((leg) => [leg.legFamily, leg.side]), [
      ["FUTURE_CLOSE", "BUY"],
      ["FUTURE_CLOSE", "SELL"],
    ]);
    assert.equal(decrease.order.maximumMarginIncrease.atoms, 0n);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a calendar exit without the exact prior state", () => {
  const port = createEvmCalendarSpreadOrderPort({
    profiles: [profile()],
    intake,
    currentTimeSeconds: () => NOW_SECONDS,
  });
  const invalid = { ...request("EXIT") } as Record<string, unknown>;
  delete invalid.expectedStrategyStateHash;
  assert.throws(() => port.create(invalid), (error: unknown) =>
    error instanceof EvmCalendarSpreadOrderError && error.code === "INVALID_REQUEST");
});

test("derives and prepares an exact calendar slice from the native order builder", () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-calendar-activation-"));
  const stored = new Map<string, StoredStrategyPackageOrder>();
  const orders = { order: (hash: string) => stored.get(hash) };
  const storingIntake: StrategyOrderIntakePort = {
    store(orderInput, graphInput, atSlot) {
      const result = intake.store(orderInput, graphInput, atSlot);
      stored.set(result.orderHashHex, {
        orderHashHex: result.orderHashHex,
        graphHashHex: result.graphHashHex,
        order: strategyPackageOrder(orderInput),
        graph: packageGraph(graphInput),
        recordedAtMs: NOW_SECONDS * 1_000,
      });
      return result;
    },
  };
  const activations = new SqliteOrderActivationStore(join(directory, "activation.sqlite"), { orders });
  try {
    const source = createEvmCalendarSpreadOrderPort({
      profiles: [profile()], intake: storingIntake, currentTimeSeconds: () => NOW_SECONDS,
    }).create(request("ENTRY"));
    const quantity = source.order.economicQuantity.atoms;
    const derived = new AdvancedOrderFactory({ orders, intake: storingIntake, activations }).derive({
      sourceOrderHashHex: source.intake.orderHashHex,
      schedule: {
        scheduleVersion: 1, kind: "PACKAGE_TWAP", timeUnit: "EVM_UNIX_SECONDS",
        startValue: BigInt(NOW_SECONDS), sliceInterval: 30n, sliceCount: 2,
        aggregateQuantityLimit: quantity, maximumSliceQuantity: quantity / 2n,
        aggregateLimitPriceTicks: 100n, stopRule: "STOP_ON_FIRST_FAILURE",
      },
    });
    const reserved = activations.reserve({
      orderHashHex: derived.intake.orderHashHex, observations: [],
      atValue: BigInt(NOW_SECONDS), side: "BID", limitPriceTicks: 99n,
    });
    assert.equal(reserved.active, true);
    if (!reserved.active) assert.fail("calendar schedule did not activate");
    const prepared = new AdvancedOrderExecutionFactory({ orders, intake: storingIntake, activations })
      .prepare({ attemptId: reserved.attempt.attemptId });
    assert.equal(prepared.order.packageTimeInForce, "FOK");
    assert.equal(prepared.order.economicQuantity.atoms, quantity / 2n);
    assert.ok(prepared.graph.legs.every((leg) =>
      leg.quantityAtoms === quantity / 2n && leg.minimumQuantityAtoms === leg.quantityAtoms));
    assert.equal(prepared.graph.executionGroups[0]?.kind, "ALL_OR_NONE");
    assert.equal(validateStrategyTemplateGraph(prepared.graph).valid, true);
  } finally {
    activations.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
