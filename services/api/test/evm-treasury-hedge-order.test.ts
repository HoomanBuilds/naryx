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
  createEvmTreasuryHedgeOrderPort,
  loadEvmTreasuryHedgeProfiles,
  type EvmTreasuryHedgeProfile,
} from "../src/index.js";
import type { StrategyOrderIntakePort } from "../src/strategy-order-intake.js";

const NOW = 1_000_000;
const OWNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";

function profile(): EvmTreasuryHedgeProfile {
  const binding = (id: string, byte: string) => Object.freeze({
    adapter: adapterRef({ adapterId: id, adapterManifestVersion: 1, adapterManifestHash: byte.repeat(32) }),
    venue: versionedManifestRef("naryx-evm-conformance", 1, "41".repeat(32)),
    market: versionedManifestRef(id, 1, byte.repeat(32)),
  });
  return Object.freeze({
    profileId: "base-sepolia-treasury-hedge",
    displayName: "Base Sepolia treasury hedge",
    templateId: "treasury-inventory-hedge-v1",
    templateVersion: 1,
    packageTemplateManifestHash: manifestHash("21".repeat(32)),
    seriesId: "ntbase-treasury-hedge",
    seriesVersion: 1,
    seriesManifestHash: manifestHash("22".repeat(32)),
    executionClassId: "evm-atomic-treasury-hedge",
    executionClassVersion: 1,
    executionClassManifestHash: manifestHash("23".repeat(32)),
    chainId: 84_532,
    domain: domainRef("eip155:84532", 1, "11".repeat(32)),
    accountFactory: "0x3333333333333333333333333333333333333333",
    inventoryAsset: assetRef("base-sepolia:ntbase", "31".repeat(32), 18),
    quoteAsset: assetRef("base-sepolia:ntquote", "32".repeat(32), 6),
    inventory: binding("inventory-position", "51"),
    hedge: binding("treasury-hedge", "52"),
    metricLimits: Object.freeze([]),
    bounds: Object.freeze({
      minimumQuantityAtoms: 1_000n,
      maximumQuantityAtoms: 1_000_000_000_000_000_000n,
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
    limitHedgePrice: { quoteAtoms: "1000000", baseAtoms: "1000000000000000000" },
    expiryValue: "1000600",
    nonce: lifecycleAction === "ENTRY" ? "1" : "2",
    ...(lifecycleAction === "ENTRY" ? {} : { expectedStrategyStateHash: "61".repeat(32) }),
  };
}

test("creates dependency-ordered atomic treasury hedge lifecycle orders", () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-evm-treasury-"));
  const path = join(directory, "profiles.json");
  try {
    writeFileSync(path, stringifyProtocolJson({ version: 1, environment: "testnet", profiles: [profile()] }));
    const port = createEvmTreasuryHedgeOrderPort({
      profiles: loadEvmTreasuryHedgeProfiles(path),
      intake,
      currentTimeSeconds: () => NOW,
    });
    const entry = port.create(request("ENTRY"));
    assert.equal(entry.graph.dependencyEdges[0]?.fromLegId, "inventory-position");
    assert.equal(entry.graph.dependencyEdges[0]?.toLegId, "treasury-hedge");
    assert.equal(entry.order.maximumMarginIncrease.atoms, 1_000_000n);
    assert.equal(validateStrategyTemplateGraph(entry.graph).valid, true);

    const increase = port.create(request("INCREASE"));
    assert.equal(increase.graph.legs[1]?.legFamily, "PERP_INCREASE");
    assert.equal(increase.graph.dependencyEdges[0]?.fromLegId, "inventory-position");
    assert.equal(increase.order.maximumMarginIncrease.atoms, 1_000_000n);
    assert.equal(validateStrategyTemplateGraph(increase.graph).valid, true);

    const decrease = port.create(request("DECREASE"));
    assert.equal(decrease.graph.legs.find((leg) => leg.legId === "treasury-hedge")?.legFamily, "PERP_DECREASE");
    assert.equal(decrease.graph.dependencyEdges[0]?.fromLegId, "treasury-hedge");
    assert.equal(decrease.order.maximumMarginIncrease.atoms, 0n);
    assert.equal(validateStrategyTemplateGraph(decrease.graph).valid, true);

    const exit = port.create(request("EXIT"));
    assert.equal(exit.graph.dependencyEdges[0]?.fromLegId, "treasury-hedge");
    assert.equal(exit.graph.dependencyEdges[0]?.toLegId, "inventory-position");
    assert.equal(exit.order.maximumMarginIncrease.atoms, 0n);
    assert.equal(validateStrategyTemplateGraph(exit.graph).valid, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
