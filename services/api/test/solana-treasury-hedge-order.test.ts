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
import { PublicKey } from "@solana/web3.js";
import {
  createSolanaTreasuryHedgeOrderPort,
  loadSolanaTreasuryHedgeProfiles,
  type SolanaTreasuryHedgeProfile,
} from "../src/index.js";
import type { StrategyOrderIntakePort } from "../src/strategy-order-intake.js";

const CURRENT_SLOT = 1_000_000n;
const OWNER = new PublicKey(new Uint8Array(32).fill(11)).toBase58();
const MULTI_STRATEGY_PROGRAM = new PublicKey(new Uint8Array(32).fill(12)).toBase58();

function profile(): SolanaTreasuryHedgeProfile {
  const binding = (id: string, byte: string) => Object.freeze({
    adapter: adapterRef({ adapterId: id, adapterManifestVersion: 1, adapterManifestHash: byte.repeat(32) }),
    venue: versionedManifestRef("naryx-solana-devnet", 1, "41".repeat(32)),
    market: versionedManifestRef(id, 1, byte.repeat(32)),
  });
  return Object.freeze({
    profileId: "solana-devnet-treasury-hedge",
    displayName: "Solana Devnet treasury hedge",
    templateId: "treasury-inventory-hedge-v1",
    templateVersion: 1,
    packageTemplateManifestHash: manifestHash("21".repeat(32)),
    seriesId: "solana-treasury-hedge",
    seriesVersion: 1,
    seriesManifestHash: manifestHash("22".repeat(32)),
    executionClassId: "solana-atomic-treasury-hedge",
    executionClassVersion: 1,
    executionClassManifestHash: manifestHash("23".repeat(32)),
    domain: domainRef("svm:devnet", 1, "11".repeat(32)),
    multiStrategyProgramId: MULTI_STRATEGY_PROGRAM,
    inventoryAsset: assetRef(new PublicKey(new Uint8Array(32).fill(13)).toBase58(), "31".repeat(32), 9),
    quoteAsset: assetRef(new PublicKey(new Uint8Array(32).fill(14)).toBase58(), "32".repeat(32), 6),
    inventory: binding("inventory-position", "51"),
    hedge: binding("treasury-hedge", "52"),
    metricLimits: Object.freeze([]),
    bounds: Object.freeze({
      minimumQuantityAtoms: 1_000n,
      maximumQuantityAtoms: 1_000_000_000n,
      maximumServiceFeeQuoteAtoms: 10_000n,
      maximumVenueFeeQuoteAtoms: 20_000n,
      maximumNetworkFeeQuoteAtoms: 30_000n,
      maximumMarginIncreaseQuoteAtoms: 1_000_000n,
      maximumExpiryTtlSlots: 1_000n,
    }),
  });
}

const intake: StrategyOrderIntakePort = Object.freeze({
  store(orderInput: StrategyPackageOrderInput, graphInput: PackageGraphInput, atSlot?: bigint) {
    const order = strategyPackageOrder(orderInput);
    const graph = packageGraph(graphInput);
    assert.equal(atSlot, CURRENT_SLOT);
    return Object.freeze({
      version: 1 as const,
      status: "STORED_FOR_QUOTING" as const,
      created: true,
      orderHashHex: toHex(strategyPackageOrderHash(order)),
      graphHashHex: toHex(packageGraphHash(graph)),
      currentTime: Object.freeze({ unit: graph.expiryUnit, value: CURRENT_SLOT }),
      timeSource: "CALLER" as const,
      stages: Object.freeze([]),
    });
  },
});

function request(lifecycleAction: "ENTRY" | "EXIT") {
  return {
    profileId: profile().profileId,
    owner: OWNER,
    lifecycleAction,
    quantityAtoms: "1000000",
    limitHedgePrice: { quoteAtoms: "100000000", baseAtoms: "1000000000" },
    expiryValue: "1000600",
    nonce: lifecycleAction === "ENTRY" ? "1" : "2",
    ...(lifecycleAction === "ENTRY" ? {} : { expectedStrategyStateHash: "61".repeat(32) }),
  };
}

test("creates dependency-ordered Solana treasury hedge entry and exit orders", async () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-solana-treasury-"));
  const path = join(directory, "profiles.json");
  try {
    writeFileSync(path, stringifyProtocolJson({ version: 1, environment: "devnet", profiles: [profile()] }));
    const port = createSolanaTreasuryHedgeOrderPort({
      profiles: loadSolanaTreasuryHedgeProfiles(path),
      intake,
      currentSlot: async () => CURRENT_SLOT,
    });
    const entry = await port.create(request("ENTRY"));
    assert.equal(entry.graph.dependencyEdges[0]?.fromLegId, "inventory-position");
    assert.equal(entry.graph.dependencyEdges[0]?.toLegId, "treasury-hedge");
    assert.equal(entry.order.settlementAccount, entry.settlementAccount);
    assert.equal(entry.order.maximumMarginIncrease.atoms, 1_000_000n);
    assert.equal(validateStrategyTemplateGraph(entry.graph).valid, true);

    const exit = await port.create(request("EXIT"));
    assert.equal(exit.graph.dependencyEdges[0]?.fromLegId, "treasury-hedge");
    assert.equal(exit.graph.dependencyEdges[0]?.toLegId, "inventory-position");
    assert.equal(exit.order.maximumMarginIncrease.atoms, 0n);
    assert.equal(validateStrategyTemplateGraph(exit.graph).valid, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects stale expiry and a forged lifecycle state", async () => {
  const port = createSolanaTreasuryHedgeOrderPort({
    profiles: [profile()],
    intake,
    currentSlot: async () => CURRENT_SLOT,
  });
  await assert.rejects(
    port.create({ ...request("ENTRY"), expiryValue: CURRENT_SLOT.toString() }),
    /quantity or expiry is outside/,
  );
  await assert.rejects(
    port.create({ ...request("EXIT"), expectedStrategyStateHash: undefined }),
    /requires the exact expected strategy state hash/,
  );
});
