import assert from "node:assert/strict";
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
  toHex,
  validateStrategyTemplateGraph,
  versionedManifestRef,
  type PackageGraphInput,
  type StrategyPackageOrderInput,
} from "@naryx/protocol-types";
import {
  createEvmCollateralConversionOrderPort,
  type EvmCollateralConversionProfile,
} from "../src/index.js";
import type { StrategyOrderIntakePort } from "../src/strategy-order-intake.js";

const NOW = 1_000_000;
const OWNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";

function profile(): EvmCollateralConversionProfile {
  const binding = (id: string, byte: string) => Object.freeze({
    adapter: adapterRef({ adapterId: id, adapterManifestVersion: 1, adapterManifestHash: byte.repeat(32) }),
    venue: versionedManifestRef("naryx-evm-conformance", 1, "41".repeat(32)),
    market: versionedManifestRef(id, 1, byte.repeat(32)),
  });
  return Object.freeze({
    profileId: "base-sepolia-collateral-conversion",
    displayName: "Base Sepolia collateral conversion",
    templateId: "collateral-conversion-hedge-v1",
    templateVersion: 1,
    packageTemplateManifestHash: manifestHash("21".repeat(32)),
    seriesId: "ntbase-collateral-conversion",
    seriesVersion: 1,
    seriesManifestHash: manifestHash("22".repeat(32)),
    executionClassId: "evm-atomic-collateral-conversion",
    executionClassVersion: 1,
    executionClassManifestHash: manifestHash("23".repeat(32)),
    chainId: 84_532,
    domain: domainRef("eip155:84532", 1, "11".repeat(32)),
    accountFactory: "0x3333333333333333333333333333333333333333",
    collateralAsset: assetRef("base-sepolia:ntbase", "31".repeat(32), 18),
    quoteAsset: assetRef("base-sepolia:ntquote", "32".repeat(32), 6),
    swap: binding("collateral-swap", "51"),
    collateralTransfer: binding("collateral-transfer", "52"),
    hedge: binding("conversion-hedge", "53"),
    metricLimits: Object.freeze([]),
    bounds: Object.freeze({
      minimumQuantityAtoms: 1_000n,
      maximumQuantityAtoms: 10n ** 18n,
      maximumServiceFeeQuoteAtoms: 10_000n,
      maximumVenueFeeQuoteAtoms: 20_000n,
      maximumNetworkFeeQuoteAtoms: 30_000n,
      maximumMarginIncreaseQuoteAtoms: 1_000_000n,
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
      currentTime: Object.freeze({ unit: graph.expiryUnit, value: BigInt(NOW) }),
      timeSource: "SERVER" as const,
      stages: Object.freeze([]),
    });
  },
});

function request(lifecycleAction: "ENTRY" | "INCREASE" | "DECREASE" | "EXIT") {
  return {
    profileId: profile().profileId,
    owner: OWNER,
    settlementAccount: ACCOUNT,
    lifecycleAction,
    quantityAtoms: "1000000000000000",
    limitSwapPrice: { quoteAtoms: "1000000", baseAtoms: "1000000000000000000" },
    limitHedgePrice: { quoteAtoms: "1000000", baseAtoms: "1000000000000000000" },
    expiryValue: "1000600",
    nonce: lifecycleAction === "ENTRY" ? "1" : "2",
    ...(lifecycleAction === "ENTRY" ? {} : { expectedStrategyStateHash: "61".repeat(32) }),
  };
}

test("creates ordered atomic collateral conversion lifecycle orders", () => {
  const port = createEvmCollateralConversionOrderPort({ profiles: [profile()], intake, currentTimeSeconds: () => NOW });
  const entry = port.create(request("ENTRY"));
  assert.deepEqual(entry.graph.legs.map((leg) => leg.legId), [
    "collateral-swap", "collateral-transfer", "conversion-hedge",
  ]);
  assert.deepEqual(entry.graph.dependencyEdges.map((edge) => [edge.fromLegId, edge.toLegId]), [
    ["collateral-swap", "collateral-transfer"], ["collateral-transfer", "conversion-hedge"],
  ]);
  assert.equal(validateStrategyTemplateGraph(entry.graph).valid, true);

  const increase = port.create(request("INCREASE"));
  assert.equal(increase.graph.legs.find((leg) => leg.legId === "collateral-transfer")?.legFamily, "MARGIN_DEPOSIT");
  assert.equal(increase.graph.legs.find((leg) => leg.legId === "conversion-hedge")?.legFamily, "PERP_INCREASE");
  assert.equal(increase.order.maximumMarginIncrease.atoms, 1_000_000n);
  assert.equal(validateStrategyTemplateGraph(increase.graph).valid, true);

  const decrease = port.create(request("DECREASE"));
  assert.equal(decrease.graph.legs.find((leg) => leg.legId === "collateral-transfer")?.legFamily, "MARGIN_RELEASE");
  assert.equal(decrease.graph.legs.find((leg) => leg.legId === "conversion-hedge")?.legFamily, "PERP_DECREASE");
  assert.equal(decrease.order.maximumMarginIncrease.atoms, 0n);
  assert.equal(validateStrategyTemplateGraph(decrease.graph).valid, true);

  const exit = port.create(request("EXIT"));
  assert.deepEqual(exit.graph.dependencyEdges.map((edge) => [edge.fromLegId, edge.toLegId]), [
    ["collateral-transfer", "collateral-swap"], ["conversion-hedge", "collateral-transfer"],
  ]);
  assert.equal(exit.order.maximumMarginIncrease.atoms, 0n);
  assert.equal(validateStrategyTemplateGraph(exit.graph).valid, true);
});
