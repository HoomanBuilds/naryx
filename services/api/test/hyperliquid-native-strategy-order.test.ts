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
  createHyperliquidNativeStrategyOrderPort,
  HyperliquidNativeStrategyOrderError,
  loadHyperliquidNativeStrategyProfiles,
  type HyperliquidNativeStrategyProfile,
} from "../src/index.js";
import type { StrategyOrderIntakePort } from "../src/strategy-order-intake.js";

const NOW_MS = 1_000_000;
const OWNER = "0x1111111111111111111111111111111111111111";

function profile(
  profileId: string,
  templateId: "treasury-inventory-hedge-v1" | "perpetual-funding-spread-v1",
): HyperliquidNativeStrategyProfile {
  const market = (role: "treasury-hedge" | "funding-long" | "funding-short", assetId: number) => ({
    role,
    entrySide: role === "funding-long" ? "BUY" as const : "SELL" as const,
    adapter: adapterRef({
      adapterId: "hypercore-perpetual-v1",
      adapterManifestVersion: 1,
      adapterManifestHash: "41".repeat(32),
    }),
    venue: versionedManifestRef("hypercore-testnet", 1, "42".repeat(32)),
    market: versionedManifestRef(`hypercore-perp-${assetId}`, 1, assetId.toString(16).padStart(2, "0").repeat(32)),
    coin: assetId === 3 ? "BTC" : "ETH",
    assetId,
    sizeDecimals: 3,
    maximumPriceDecimals: 2,
  });
  return Object.freeze({
    profileId,
    displayName: profileId,
    templateId,
    templateVersion: 1,
    packageTemplateManifestHash: manifestHash("21".repeat(32)),
    seriesId: `${profileId}-series`,
    seriesVersion: 1,
    seriesManifestHash: manifestHash("22".repeat(32)),
    executionClassId: `${profileId}-execution`,
    executionClassVersion: 1,
    executionClassManifestHash: manifestHash("23".repeat(32)),
    domain: domainRef("hypercore:testnet", 1, "11".repeat(32)),
    settlementAccount: "hypercore-testnet-account",
    baseAsset: assetRef("hypercore:testnet:btc", "31".repeat(32), 5),
    quoteAsset: assetRef("hypercore:testnet:usdc", "32".repeat(32), 6),
    markets: templateId === "treasury-inventory-hedge-v1"
      ? [market("treasury-hedge", 3)]
      : [market("funding-long", 3), market("funding-short", 4)],
    metricLimits: [],
    bounds: Object.freeze({
      minimumQuantityAtoms: 100n,
      maximumQuantityAtoms: 10_000_000n,
      maximumEconomicQuantityAtoms: 20_000_000n,
      maximumServiceFeeQuoteAtoms: 10_000n,
      maximumVenueFeeQuoteAtoms: 20_000n,
      maximumRecoveryCostQuoteAtoms: 30_000n,
      maximumAggregateRecoveryLossQuoteAtoms: 60_000n,
      maximumMarginIncreaseQuoteAtoms: 5_000_000n,
      maximumResidualValueQuoteAtoms: 25_000n,
      maximumExpiryTtlMs: 60_000n,
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
      currentTime: Object.freeze({ unit: graph.expiryUnit, value: BigInt(NOW_MS) }),
      timeSource: "SERVER" as const,
      stages: Object.freeze([]),
    });
  },
});

test("loads reviewed profiles and creates treasury entry plus funding exit orders", () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-native-strategy-"));
  const path = join(directory, "profiles.json");
  try {
    writeFileSync(path, stringifyProtocolJson({
      version: 1,
      environment: "testnet",
      profiles: [
        profile("btc-treasury-hedge", "treasury-inventory-hedge-v1"),
        profile("btc-eth-funding", "perpetual-funding-spread-v1"),
      ],
    }));
    const port = createHyperliquidNativeStrategyOrderPort({
      profiles: loadHyperliquidNativeStrategyProfiles(path),
      intake,
      currentTimeMs: () => NOW_MS,
    });
    const treasury = port.create({
      profileId: "btc-treasury-hedge",
      owner: OWNER,
      lifecycleAction: "ENTRY",
      quantityAtoms: "100000",
      economicQuantityAtoms: "200000",
      limitPrices: [{ legId: "treasury-hedge", quoteAtoms: "60001", baseAtoms: "1" }],
      expiryValue: "1020000",
      nonce: "1",
    });
    const treasuryLeg = treasury.graph.legs[0];
    assert.ok(treasuryLeg?.limitPrice);
    assert.equal(treasuryLeg.legFamily, "PERP_OPEN");
    assert.equal(treasuryLeg.side, "SELL");
    assert.equal(treasuryLeg.limitPrice.roundingDirection, "CEIL");
    assert.equal(validateStrategyTemplateGraph(treasury.graph).valid, true);

    const funding = port.create({
      profileId: "btc-eth-funding",
      owner: OWNER,
      lifecycleAction: "EXIT",
      quantityAtoms: "100000",
      economicQuantityAtoms: "100000",
      limitPrices: [
        { legId: "funding-long", quoteAtoms: "60001", baseAtoms: "1" },
        { legId: "funding-short", quoteAtoms: "3001", baseAtoms: "1" },
      ],
      expiryValue: "1020000",
      nonce: "2",
      expectedStrategyStateHash: "33".repeat(32),
    });
    assert.deepEqual(funding.graph.legs.map((leg) => [leg.legFamily, leg.side, leg.limitPrice?.roundingDirection]), [
      ["PERP_CLOSE", "SELL", "CEIL"],
      ["PERP_CLOSE", "BUY", "FLOOR"],
    ]);
    assert.equal(validateStrategyTemplateGraph(funding.graph).valid, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects requests outside reviewed quantity and expiry bounds", () => {
  const port = createHyperliquidNativeStrategyOrderPort({
    profiles: [profile("btc-treasury-hedge", "treasury-inventory-hedge-v1")],
    intake,
    currentTimeMs: () => NOW_MS,
  });
  assert.throws(() => port.create({
    profileId: "btc-treasury-hedge",
    owner: OWNER,
    lifecycleAction: "ENTRY",
    quantityAtoms: "10000001",
    economicQuantityAtoms: "10000001",
    limitPrices: [{ legId: "treasury-hedge", quoteAtoms: "60001", baseAtoms: "1" }],
    expiryValue: "1004000",
    nonce: "1",
  }), (error: unknown) => error instanceof HyperliquidNativeStrategyOrderError && error.code === "LIMIT_EXCEEDED");
});
