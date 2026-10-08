import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adapterRef,
  assetAmount,
  assetRef,
  domainRef,
  manifestHash,
  packageGraph,
  packageGraphHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  strategyPackageReceipt,
  strategyPackageReceiptHash,
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
  SqliteStrategyPackageStore,
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

function request(
  lifecycleAction: "ENTRY" | "INCREASE" | "DECREASE" | "EXIT",
  expectedStrategyStateHash = "61".repeat(32),
) {
  return {
    profileId: profile().profileId,
    owner: OWNER,
    lifecycleAction,
    quantityAtoms: "1000000",
    limitHedgePrice: { quoteAtoms: "100000000", baseAtoms: "1000000000" },
    expiryValue: "1000600",
    nonce: lifecycleAction === "ENTRY" ? "1" : lifecycleAction === "INCREASE" ? "2"
      : lifecycleAction === "DECREASE" ? "3" : "4",
    ...(lifecycleAction === "ENTRY" ? {} : { expectedStrategyStateHash }),
  };
}

test("creates dependency-ordered Solana treasury hedge lifecycle orders", async () => {
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

    const increase = await port.create(request("INCREASE"));
    assert.equal(increase.graph.legs[1]?.legFamily, "PERP_INCREASE");
    assert.equal(increase.graph.dependencyEdges[0]?.fromLegId, "inventory-position");
    assert.equal(increase.order.maximumMarginIncrease.atoms, 1_000_000n);

    const decrease = await port.create(request("DECREASE"));
    assert.equal(decrease.graph.legs.find((leg) => leg.legId === "treasury-hedge")?.legFamily, "PERP_DECREASE");
    assert.equal(decrease.graph.dependencyEdges[0]?.toLegId, "inventory-position");
    assert.equal(decrease.order.maximumMarginIncrease.atoms, 0n);

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

test("persists state-bound Solana resize transitions before the exact exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-solana-position-"));
  const packageStore = new SqliteStrategyPackageStore(join(directory, "strategies.db"), { clock: () => 10 });
  const captured = new Map<string, Readonly<{ order: StrategyPackageOrderInput; graph: PackageGraphInput }>>();
  const storingIntake: StrategyOrderIntakePort = Object.freeze({
    store(orderInput: StrategyPackageOrderInput, graphInput: PackageGraphInput) {
      const stored = packageStore.registerOrder(orderInput, graphInput);
      captured.set(orderInput.lifecycleAction, Object.freeze({ order: orderInput, graph: graphInput }));
      return Object.freeze({
        version: 1 as const,
        status: "STORED_FOR_QUOTING" as const,
        ...stored,
        currentTime: Object.freeze({ unit: "SOLANA_SLOT" as const, value: CURRENT_SLOT }),
        timeSource: "CALLER" as const,
        stages: Object.freeze([]),
      });
    },
  });
  const port = createSolanaTreasuryHedgeOrderPort({
    profiles: [profile()],
    intake: storingIntake,
    currentSlot: async () => CURRENT_SLOT,
  });
  const db = (packageStore as unknown as { db: import("better-sqlite3").Database }).db;
  const seedReceipt = (
    documents: Readonly<{ order: StrategyPackageOrderInput; graph: PackageGraphInput }>,
    byte: number,
  ): string => {
    const order = strategyPackageOrder(documents.order);
    const graph = packageGraph(documents.graph);
    const orderHash = strategyPackageOrderHash(order);
    const graphHash = packageGraphHash(graph);
    const quoteHash = Buffer.alloc(32, byte);
    const routeHash = Buffer.alloc(32, byte + 1);
    const receipt = strategyPackageReceipt({
      version: 1,
      environment: order.environment,
      domains: [profile().domain],
      orderHash,
      graphHash,
      quoteHash,
      routeHash,
      templateId: order.templateId,
      templateVersion: order.templateVersion,
      packageTemplateManifestHash: order.packageTemplateManifestHash,
      seriesId: order.seriesId,
      seriesVersion: order.seriesVersion,
      seriesManifestHash: order.seriesManifestHash,
      executionClassId: order.executionClassId,
      executionClassVersion: order.executionClassVersion,
      executionClassManifestHash: order.executionClassManifestHash,
      lifecycleAction: order.lifecycleAction,
      owner: order.owner,
      solverId: "solver-1",
      settlementClass: order.settlementClass,
      terminalState: "FINALIZED_COMPLETE",
      quoteAsset: order.quoteAsset,
      legOutcomes: graph.legs.map((leg, index) => ({
        legId: leg.legId,
        positionLegId: leg.legId,
        domain: leg.domain,
        status: "EXECUTED" as const,
        requestedQuantity: assetAmount(leg.quantityAsset, leg.quantityAtoms),
        settledQuantity: assetAmount(leg.quantityAsset, leg.side === "SELL" ? -leg.quantityAtoms : leg.quantityAtoms),
        grossNotional: assetAmount(order.quoteAsset, BigInt(index + 1) * 1_000_000n),
        venueFee: assetAmount(order.quoteAsset, BigInt(index + 1) * 100n),
        residualValue: assetAmount(order.quoteAsset, 0n),
        evidenceGrade: "CONSENSUS_VERIFIED" as const,
        onchainEnforced: true,
        evidenceHash: (byte + 2 + index).toString(16).padStart(2, "0").repeat(32),
      })),
      serviceFee: assetAmount(order.quoteAsset, 10n),
      solverFee: assetAmount(order.quoteAsset, 20n),
      venueFees: assetAmount(order.quoteAsset, 300n),
      networkCost: assetAmount(order.quoteAsset, 30n),
      recoveryCost: assetAmount(order.quoteAsset, 40n),
      terminalResidualValue: assetAmount(order.quoteAsset, 0n),
      finalityStatus: "FINALIZED",
      executedAtValue: CURRENT_SLOT,
      receiptNonce: BigInt(byte),
    });
    const receiptHash = strategyPackageReceiptHash(receipt);
    db.prepare(`
      INSERT INTO strategy_package_quotes
        (quote_hash, order_hash, route_hash, solver_id, quote_json, route_json, recorded_at_ms)
      VALUES (?, ?, ?, 'solver-1', '{}', '{}', 10)
    `).run(quoteHash, orderHash, routeHash);
    db.prepare(`
      INSERT INTO strategy_package_receipts
        (receipt_hash, order_hash, quote_hash, route_hash, receipt_json, recorded_at_ms)
      VALUES (?, ?, ?, ?, ?, 10)
    `).run(receiptHash, orderHash, quoteHash, routeHash, stringifyProtocolJson(receipt));
    return toHex(receiptHash);
  };

  try {
    const entry = await port.create(request("ENTRY"));
    const entryDocuments = captured.get("ENTRY");
    assert.ok(entryDocuments);
    const entryReceiptHash = seedReceipt(entryDocuments, 0x71);
    assert.deepEqual(packageStore.ownerReceipts(OWNER, 1), [{
      receiptHashHex: entryReceiptHash,
      orderHashHex: entry.intake.orderHashHex,
      quoteHashHex: "71".repeat(32),
      templateId: profile().templateId,
      lifecycleAction: "ENTRY",
      expectedStrategyStateHashHex: null,
      terminalState: "FINALIZED_COMPLETE",
      finalityStatus: "FINALIZED",
      domainIds: [profile().domain.domainId],
      portfolioEligible: true,
      executionEconomics: {
        quoteAssetId: profile().quoteAsset.assetId,
        quoteAssetDecimals: profile().quoteAsset.decimals,
        grossLegNotionalAtoms: 3_000_000n,
        serviceFeeAtoms: 10n,
        solverFeeAtoms: 20n,
        venueFeeAtoms: 300n,
        networkCostAtoms: 30n,
        recoveryCostAtoms: 40n,
        explicitCostAtoms: 400n,
        terminalResidualValueAtoms: 0n,
      },
      recordedAtMs: 10,
    }]);
    const entryPosition = packageStore.recordSolanaStrategyPosition({
      receiptHashHex: entryReceiptHash,
      packageIdHex: entry.intake.orderHashHex,
      domain: profile().domain,
      account: entry.settlementAccount,
      previousStateHashHex: "00".repeat(32),
      nextStateHashHex: "61".repeat(32),
    });
    assert.equal(entryPosition.status, "OPEN");
    assert.equal(entryPosition.economicQuantityAtoms, 1_000_000n);
    assert.equal(packageStore.solanaStrategyPositionsByOwner(OWNER)[0]?.stateHashHex, "61".repeat(32));

    await port.create(request("INCREASE"));
    const increaseDocuments = captured.get("INCREASE");
    assert.ok(increaseDocuments);
    const increaseReceiptHash = seedReceipt(increaseDocuments, 0x73);
    assert.deepEqual(
      packageStore.ownerReceipts(OWNER).find((receipt) => receipt.receiptHashHex === increaseReceiptHash),
      {
        receiptHashHex: increaseReceiptHash,
        orderHashHex: toHex(strategyPackageOrderHash(strategyPackageOrder(increaseDocuments.order))),
        quoteHashHex: "73".repeat(32),
        templateId: profile().templateId,
        lifecycleAction: "INCREASE",
        expectedStrategyStateHashHex: "61".repeat(32),
        terminalState: "FINALIZED_COMPLETE",
        finalityStatus: "FINALIZED",
        domainIds: [profile().domain.domainId],
        portfolioEligible: true,
        executionEconomics: {
          quoteAssetId: profile().quoteAsset.assetId,
          quoteAssetDecimals: profile().quoteAsset.decimals,
          grossLegNotionalAtoms: 3_000_000n,
          serviceFeeAtoms: 10n,
          solverFeeAtoms: 20n,
          venueFeeAtoms: 300n,
          networkCostAtoms: 30n,
          recoveryCostAtoms: 40n,
          explicitCostAtoms: 400n,
          terminalResidualValueAtoms: 0n,
        },
        recordedAtMs: 10,
      },
    );
    const increased = packageStore.recordSolanaStrategyPosition({
      receiptHashHex: increaseReceiptHash,
      packageIdHex: entry.intake.orderHashHex,
      domain: profile().domain,
      account: entry.settlementAccount,
      previousStateHashHex: "61".repeat(32),
      nextStateHashHex: "62".repeat(32),
    });
    assert.equal(increased.economicQuantityAtoms, 2_000_000n);

    await port.create(request("DECREASE", "62".repeat(32)));
    const decreaseDocuments = captured.get("DECREASE");
    assert.ok(decreaseDocuments);
    const decreaseReceiptHash = seedReceipt(decreaseDocuments, 0x74);
    const decreased = packageStore.recordSolanaStrategyPosition({
      receiptHashHex: decreaseReceiptHash,
      packageIdHex: entry.intake.orderHashHex,
      domain: profile().domain,
      account: entry.settlementAccount,
      previousStateHashHex: "62".repeat(32),
      nextStateHashHex: "63".repeat(32),
    });
    assert.equal(decreased.economicQuantityAtoms, 1_000_000n);

    await port.create(request("EXIT", "63".repeat(32)));
    const exitDocuments = captured.get("EXIT");
    assert.ok(exitDocuments);
    const exitReceiptHash = seedReceipt(exitDocuments, 0x75);
    const closed = packageStore.recordSolanaStrategyPosition({
      receiptHashHex: exitReceiptHash,
      packageIdHex: entry.intake.orderHashHex,
      domain: profile().domain,
      account: entry.settlementAccount,
      previousStateHashHex: "63".repeat(32),
      nextStateHashHex: "00".repeat(32),
    });
    assert.equal(closed.status, "CLOSED");
    assert.equal(closed.economicQuantityAtoms, 0n);
    assert.deepEqual(packageStore.recordSolanaStrategyPosition({
      receiptHashHex: exitReceiptHash,
      packageIdHex: entry.intake.orderHashHex,
      domain: profile().domain,
      account: entry.settlementAccount,
      previousStateHashHex: "63".repeat(32),
      nextStateHashHex: "00".repeat(32),
    }), closed);
  } finally {
    packageStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
