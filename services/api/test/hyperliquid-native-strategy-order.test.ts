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
import {
  applyNativeStrategyExitReceipt,
  applyNativeStrategyMigrationReceipt,
  applyNativeStrategyRebalanceReceipt,
  applyNativeStrategyTransitionReceipt,
  createHyperliquidNativeStrategyOrderPort,
  HyperliquidNativeStrategyOrderError,
  loadHyperliquidNativeStrategyProfiles,
  nativeStrategyPositionFromEntry,
  prepareStrategyOpen,
  validateNativeStrategyExit,
  validateNativeStrategyMigration,
  validateNativeStrategyRebalance,
  validateNativeStrategyTransition,
  type HyperliquidNativeStrategyProfile,
} from "../src/index.js";
import type { StrategyOrderIntakePort } from "../src/strategy-order-intake.js";

const NOW_MS = 1_000_000;
const OWNER = "0x1111111111111111111111111111111111111111";

function profile(
  profileId: string,
  templateId: "treasury-inventory-hedge-v1" | "perpetual-funding-spread-v1" | "hedge-migration-v1"
    | "delta-neutral-rebalance-v1",
): HyperliquidNativeStrategyProfile {
  const market = (
    role: "treasury-hedge" | "funding-long" | "funding-short" | "source-hedge" | "destination-hedge"
      | "perp-adjustment",
    assetId: number,
  ) => ({
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
      : templateId === "perpetual-funding-spread-v1"
        ? [market("funding-long", 3), market("funding-short", 4)]
        : templateId === "hedge-migration-v1"
          ? [market("source-hedge", 3), market("destination-hedge", 4)]
          : [market("perp-adjustment", 3)],
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
        profile("btc-eth-migration", "hedge-migration-v1"),
        profile("btc-delta-rebalance", "delta-neutral-rebalance-v1"),
      ],
    }));
    const port = createHyperliquidNativeStrategyOrderPort({
      profiles: loadHyperliquidNativeStrategyProfiles(path),
      intake,
      currentTimeMs: () => NOW_MS,
    });
    assert.equal(port.profiles().length, 4);
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

test("rebalances and migrates an authoritative native hedge", () => {
  const treasuryProfile = profile("btc-treasury-hedge", "treasury-inventory-hedge-v1");
  const migrationProfile = profile("btc-hedge-migration", "hedge-migration-v1");
  const rebalanceProfile = profile("btc-delta-rebalance", "delta-neutral-rebalance-v1");
  const port = createHyperliquidNativeStrategyOrderPort({
    profiles: [treasuryProfile, migrationProfile, rebalanceProfile],
    intake,
    currentTimeMs: () => NOW_MS,
  });
  const entry = port.create({
    profileId: treasuryProfile.profileId,
    owner: OWNER,
    lifecycleAction: "ENTRY",
    quantityAtoms: "100000",
    economicQuantityAtoms: "200000",
    limitPrices: [{ legId: "treasury-hedge", quoteAtoms: "60001", baseAtoms: "1" }],
    expiryValue: "1020000",
    nonce: "10",
  });
  const entryReceipt = strategyPackageReceipt({
    version: 1,
    environment: "testnet",
    domains: [treasuryProfile.domain],
    orderHash: strategyPackageOrderHash(entry.order),
    graphHash: packageGraphHash(entry.graph),
    quoteHash: "71".repeat(32),
    routeHash: "72".repeat(32),
    templateId: entry.order.templateId,
    templateVersion: 1,
    packageTemplateManifestHash: entry.order.packageTemplateManifestHash,
    seriesId: entry.order.seriesId,
    seriesVersion: 1,
    seriesManifestHash: entry.order.seriesManifestHash,
    executionClassId: entry.order.executionClassId,
    executionClassVersion: 1,
    executionClassManifestHash: entry.order.executionClassManifestHash,
    lifecycleAction: "entry",
    owner: OWNER,
    solverId: "solver-a",
    settlementClass: "BATCHED_IOC_WITH_RECOVERY",
    terminalState: "FINALIZED_COMPLETE",
    quoteAsset: treasuryProfile.quoteAsset,
    legOutcomes: [{
      legId: "treasury-hedge",
      positionLegId: "treasury-hedge",
      domain: treasuryProfile.domain,
      status: "EXECUTED",
      requestedQuantity: assetAmount(treasuryProfile.baseAsset, 100_000n),
      settledQuantity: assetAmount(treasuryProfile.baseAsset, -100_000n),
      grossNotional: assetAmount(treasuryProfile.quoteAsset, 60_000n),
      venueFee: assetAmount(treasuryProfile.quoteAsset, 1n),
      residualValue: assetAmount(treasuryProfile.quoteAsset, 0n),
      evidenceGrade: "VENUE_API_CORROBORATED",
      onchainEnforced: false,
      evidenceHash: "73".repeat(32),
    }],
    serviceFee: assetAmount(treasuryProfile.quoteAsset, 0n),
    solverFee: assetAmount(treasuryProfile.quoteAsset, 0n),
    venueFees: assetAmount(treasuryProfile.quoteAsset, 1n),
    networkCost: assetAmount(treasuryProfile.quoteAsset, 0n),
    recoveryCost: assetAmount(treasuryProfile.quoteAsset, 0n),
    terminalResidualValue: assetAmount(treasuryProfile.quoteAsset, 0n),
    finalityStatus: "FINALIZED",
    executedAtValue: 1_001_000n,
    receiptNonce: 10n,
  });
  const preparedOpen = prepareStrategyOpen({
    environment: "testnet",
    atValue: BigInt(NOW_MS),
    receiptHashHex: toHex(strategyPackageReceiptHash(entryReceipt)),
    order: entry.order,
    graph: entry.graph,
    receipt: entryReceipt,
  });
  assert.equal(preparedOpen.command.parameters.kind, "OPEN");
  assert.equal(preparedOpen.command.actorId, OWNER);
  assert.equal(preparedOpen.command.strategyId, `strategy-${toHex(strategyPackageReceiptHash(entryReceipt))}`);
  if (preparedOpen.command.parameters.kind === "OPEN") {
    assert.equal(preparedOpen.command.parameters.state.legs[0]?.signedQuantityAtoms, -100_000n);
    assert.equal(preparedOpen.command.parameters.state.legs[0]?.venueId, treasuryProfile.markets[0]?.venue.subjectId);
  }
  assert.throws(() => prepareStrategyOpen({
    environment: "testnet",
    atValue: BigInt(NOW_MS),
    receiptHashHex: "ff".repeat(32),
    order: entry.order,
    graph: entry.graph,
    receipt: entryReceipt,
  }), { code: "RECEIPT_MISMATCH" });
  const opened = nativeStrategyPositionFromEntry({
    orderHashHex: toHex(strategyPackageOrderHash(entry.order)),
    receiptHashHex: "74".repeat(32),
    order: entry.order,
    graph: entry.graph,
    receipt: entryReceipt,
  });
  assert.ok(opened);
  const rebalance = port.create({
    profileId: rebalanceProfile.profileId,
    owner: OWNER,
    lifecycleAction: "REBALANCE",
    adjustmentKind: "INCREASE",
    preDeltaAtoms: "100000",
    quantityAtoms: "100000",
    economicQuantityAtoms: "200000",
    limitPrices: [{ legId: "perp-adjustment", quoteAtoms: "60001", baseAtoms: "1" }],
    expiryValue: "1020000",
    nonce: "12",
    expectedStrategyStateHash: opened.stateHashHex,
  });
  assert.deepEqual(rebalance.graph.legs.map((leg) => [leg.legId, leg.legFamily, leg.side]), [
    ["perp-adjustment", "PERP_INCREASE", "SELL"],
  ]);
  validateNativeStrategyRebalance(opened, rebalance.order, rebalance.graph);
  const rebalanceReceipt = strategyPackageReceipt({
    version: 1,
    environment: "testnet",
    domains: [rebalanceProfile.domain],
    orderHash: strategyPackageOrderHash(rebalance.order),
    graphHash: packageGraphHash(rebalance.graph),
    quoteHash: "79".repeat(32),
    routeHash: "7a".repeat(32),
    templateId: rebalance.order.templateId,
    templateVersion: 1,
    packageTemplateManifestHash: rebalance.order.packageTemplateManifestHash,
    seriesId: rebalance.order.seriesId,
    seriesVersion: 1,
    seriesManifestHash: rebalance.order.seriesManifestHash,
    executionClassId: rebalance.order.executionClassId,
    executionClassVersion: 1,
    executionClassManifestHash: rebalance.order.executionClassManifestHash,
    lifecycleAction: "rebalance",
    owner: OWNER,
    solverId: "solver-a",
    settlementClass: "BATCHED_IOC_WITH_RECOVERY",
    terminalState: "FINALIZED_COMPLETE",
    quoteAsset: rebalanceProfile.quoteAsset,
    legOutcomes: [{
      legId: "perp-adjustment",
      positionLegId: "perp-adjustment",
      domain: rebalanceProfile.domain,
      status: "EXECUTED",
      requestedQuantity: assetAmount(rebalanceProfile.baseAsset, 100_000n),
      settledQuantity: assetAmount(rebalanceProfile.baseAsset, -100_000n),
      grossNotional: assetAmount(rebalanceProfile.quoteAsset, 60_000n),
      venueFee: assetAmount(rebalanceProfile.quoteAsset, 1n),
      residualValue: assetAmount(rebalanceProfile.quoteAsset, 0n),
      evidenceGrade: "VENUE_API_CORROBORATED",
      onchainEnforced: false,
      evidenceHash: "7b".repeat(32),
    }],
    serviceFee: assetAmount(rebalanceProfile.quoteAsset, 0n),
    solverFee: assetAmount(rebalanceProfile.quoteAsset, 0n),
    venueFees: assetAmount(rebalanceProfile.quoteAsset, 1n),
    networkCost: assetAmount(rebalanceProfile.quoteAsset, 0n),
    recoveryCost: assetAmount(rebalanceProfile.quoteAsset, 0n),
    terminalResidualValue: assetAmount(rebalanceProfile.quoteAsset, 0n),
    finalityStatus: "FINALIZED",
    executedAtValue: 1_001_050n,
    receiptNonce: 12n,
  });
  const rebalanced = applyNativeStrategyRebalanceReceipt(
    opened,
    rebalance.order,
    rebalance.graph,
    rebalanceReceipt,
  );
  assert.equal(rebalanced.economicQuantityAtoms, 200_000n);
  assert.equal(rebalanced.state.legs[0]?.signedQuantityAtoms, -200_000n);
  const riskIncreasing = port.create({
    profileId: rebalanceProfile.profileId,
    owner: OWNER,
    lifecycleAction: "REBALANCE",
    adjustmentKind: "DECREASE",
    preDeltaAtoms: "100000",
    quantityAtoms: "50000",
    economicQuantityAtoms: "200000",
    limitPrices: [{ legId: "perp-adjustment", quoteAtoms: "60001", baseAtoms: "1" }],
    expiryValue: "1020000",
    nonce: "13",
    expectedStrategyStateHash: opened.stateHashHex,
  });
  assert.throws(
    () => validateNativeStrategyRebalance(opened, riskIncreasing.order, riskIncreasing.graph),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RISK_NOT_REDUCED",
  );
  const migration = port.create({
    profileId: migrationProfile.profileId,
    owner: OWNER,
    lifecycleAction: "MIGRATE",
    quantityAtoms: "100000",
    economicQuantityAtoms: "100000",
    limitPrices: [
      { legId: "source-hedge", quoteAtoms: "60010", baseAtoms: "1" },
      { legId: "destination-hedge", quoteAtoms: "59990", baseAtoms: "1" },
    ],
    expiryValue: "1020000",
    nonce: "11",
    expectedStrategyStateHash: opened.stateHashHex,
  });
  assert.deepEqual(migration.graph.legs.map((leg) => [leg.legId, leg.legFamily, leg.side]), [
    ["destination-hedge", "PERP_OPEN", "SELL"],
    ["source-hedge", "PERP_CLOSE", "BUY"],
  ]);
  validateNativeStrategyMigration(opened, migration.order, migration.graph);
  const migrationReceipt = strategyPackageReceipt({
    version: 1,
    environment: "testnet",
    domains: [migrationProfile.domain],
    orderHash: strategyPackageOrderHash(migration.order),
    graphHash: packageGraphHash(migration.graph),
    quoteHash: "75".repeat(32),
    routeHash: "76".repeat(32),
    templateId: migration.order.templateId,
    templateVersion: 1,
    packageTemplateManifestHash: migration.order.packageTemplateManifestHash,
    seriesId: migration.order.seriesId,
    seriesVersion: 1,
    seriesManifestHash: migration.order.seriesManifestHash,
    executionClassId: migration.order.executionClassId,
    executionClassVersion: 1,
    executionClassManifestHash: migration.order.executionClassManifestHash,
    lifecycleAction: "migrate",
    owner: OWNER,
    solverId: "solver-a",
    settlementClass: "BATCHED_IOC_WITH_RECOVERY",
    terminalState: "FINALIZED_COMPLETE",
    quoteAsset: migrationProfile.quoteAsset,
    legOutcomes: migration.graph.legs.map((leg) => ({
      legId: leg.legId,
      positionLegId: leg.legId,
      domain: migrationProfile.domain,
      status: "EXECUTED" as const,
      requestedQuantity: assetAmount(migrationProfile.baseAsset, 100_000n),
      settledQuantity: assetAmount(
        migrationProfile.baseAsset,
        leg.legId === "source-hedge" ? 100_000n : -100_000n,
      ),
      grossNotional: assetAmount(migrationProfile.quoteAsset, 60_000n),
      venueFee: assetAmount(migrationProfile.quoteAsset, 1n),
      residualValue: assetAmount(migrationProfile.quoteAsset, 0n),
      evidenceGrade: "VENUE_API_CORROBORATED" as const,
      onchainEnforced: false,
      evidenceHash: leg.legId === "source-hedge" ? "77".repeat(32) : "78".repeat(32),
    })),
    serviceFee: assetAmount(migrationProfile.quoteAsset, 0n),
    solverFee: assetAmount(migrationProfile.quoteAsset, 0n),
    venueFees: assetAmount(migrationProfile.quoteAsset, 2n),
    networkCost: assetAmount(migrationProfile.quoteAsset, 0n),
    recoveryCost: assetAmount(migrationProfile.quoteAsset, 0n),
    terminalResidualValue: assetAmount(migrationProfile.quoteAsset, 0n),
    finalityStatus: "FINALIZED",
    executedAtValue: 1_001_100n,
    receiptNonce: 11n,
  });
  const migrated = applyNativeStrategyMigrationReceipt(
    opened,
    migration.order,
    migration.graph,
    migrationReceipt,
  );
  assert.equal(migrated.status, "OPEN");
  assert.equal(migrated.templateId, "treasury-inventory-hedge-v1");
  assert.equal(migrated.state.legs.length, 1);
  assert.equal(
    migrated.state.legs[0]?.instrumentId,
    migration.graph.legs.find((leg) => leg.legId === "destination-hedge")?.market.subjectId,
  );
  assert.equal(migrated.state.legs[0]?.signedQuantityAtoms, -100_000n);
});

test("derives an authoritative native state and closes only its exact exit", () => {
  const selectedProfile = profile("btc-treasury-hedge", "treasury-inventory-hedge-v1");
  const port = createHyperliquidNativeStrategyOrderPort({
    profiles: [selectedProfile],
    intake,
    currentTimeMs: () => NOW_MS,
  });
  const entry = port.create({
    profileId: selectedProfile.profileId,
    owner: OWNER,
    lifecycleAction: "ENTRY",
    quantityAtoms: "100000",
    economicQuantityAtoms: "200000",
    limitPrices: [{ legId: "treasury-hedge", quoteAtoms: "60001", baseAtoms: "1" }],
    expiryValue: "1020000",
    nonce: "3",
  });
  const entryOrderHash = toHex(strategyPackageOrderHash(entry.order));
  const receipt = (
    created: typeof entry,
    lifecycleAction: "ENTRY" | "INCREASE" | "DECREASE" | "EXIT",
    settledAtoms: bigint,
  ) => strategyPackageReceipt({
    version: 1,
    environment: "testnet",
    domains: [selectedProfile.domain],
    orderHash: strategyPackageOrderHash(created.order),
    graphHash: packageGraphHash(created.graph),
    quoteHash: "51".repeat(32),
    routeHash: "52".repeat(32),
    templateId: created.order.templateId,
    templateVersion: created.order.templateVersion,
    packageTemplateManifestHash: created.order.packageTemplateManifestHash,
    seriesId: created.order.seriesId,
    seriesVersion: created.order.seriesVersion,
    seriesManifestHash: created.order.seriesManifestHash,
    executionClassId: created.order.executionClassId,
    executionClassVersion: created.order.executionClassVersion,
    executionClassManifestHash: created.order.executionClassManifestHash,
    lifecycleAction,
    owner: OWNER,
    solverId: "solver-a",
    settlementClass: "BATCHED_IOC_WITH_RECOVERY",
    terminalState: "FINALIZED_COMPLETE",
    quoteAsset: selectedProfile.quoteAsset,
    legOutcomes: [{
      legId: "treasury-hedge",
      positionLegId: "treasury-hedge",
      domain: selectedProfile.domain,
      status: "EXECUTED",
      requestedQuantity: assetAmount(selectedProfile.baseAsset, created.graph.legs[0]!.quantityAtoms),
      settledQuantity: assetAmount(selectedProfile.baseAsset, settledAtoms),
      grossNotional: assetAmount(selectedProfile.quoteAsset, 60_001n),
      venueFee: assetAmount(selectedProfile.quoteAsset, 1n),
      residualValue: assetAmount(selectedProfile.quoteAsset, 0n),
      evidenceGrade: "VENUE_API_CORROBORATED",
      onchainEnforced: false,
      evidenceHash: "53".repeat(32),
    }],
    serviceFee: assetAmount(selectedProfile.quoteAsset, 0n),
    solverFee: assetAmount(selectedProfile.quoteAsset, 0n),
    venueFees: assetAmount(selectedProfile.quoteAsset, 1n),
    networkCost: assetAmount(selectedProfile.quoteAsset, 0n),
    recoveryCost: assetAmount(selectedProfile.quoteAsset, 0n),
    terminalResidualValue: assetAmount(selectedProfile.quoteAsset, 0n),
    finalityStatus: "FINALIZED",
    executedAtValue: 1_001_000n,
    receiptNonce: lifecycleAction === "ENTRY" ? 3n
      : lifecycleAction === "INCREASE" ? 4n : lifecycleAction === "DECREASE" ? 5n : 6n,
  });
  const opened = nativeStrategyPositionFromEntry({
    orderHashHex: entryOrderHash,
    receiptHashHex: "61".repeat(32),
    order: entry.order,
    graph: entry.graph,
    receipt: receipt(entry, "ENTRY", -100_000n),
  });
  assert.ok(opened);
  assert.equal(opened.status, "OPEN");
  assert.equal(opened.state.legs[0]?.signedQuantityAtoms, -100_000n);

  const increase = port.create({
    profileId: selectedProfile.profileId,
    owner: OWNER,
    lifecycleAction: "INCREASE",
    quantityAtoms: "25000",
    economicQuantityAtoms: "50000",
    limitPrices: [{ legId: "treasury-hedge", quoteAtoms: "60001", baseAtoms: "1" }],
    expiryValue: "1020000",
    nonce: "4",
    expectedStrategyStateHash: opened.stateHashHex,
  });
  validateNativeStrategyTransition(opened, increase.order, increase.graph);
  const increased = applyNativeStrategyTransitionReceipt(
    opened,
    increase.order,
    increase.graph,
    receipt(increase, "INCREASE", -25_000n),
  );
  assert.equal(increased.status, "OPEN");
  assert.equal(increased.economicQuantityAtoms, 250_000n);
  assert.equal(increased.state.legs[0]?.signedQuantityAtoms, -125_000n);

  const decrease = port.create({
    profileId: selectedProfile.profileId,
    owner: OWNER,
    lifecycleAction: "DECREASE",
    quantityAtoms: "25000",
    economicQuantityAtoms: "50000",
    limitPrices: [{ legId: "treasury-hedge", quoteAtoms: "59999", baseAtoms: "1" }],
    expiryValue: "1020000",
    nonce: "5",
    expectedStrategyStateHash: increased.stateHashHex,
  });
  validateNativeStrategyTransition(increased, decrease.order, decrease.graph);
  const decreased = applyNativeStrategyTransitionReceipt(
    increased,
    decrease.order,
    decrease.graph,
    receipt(decrease, "DECREASE", 25_000n),
  );
  assert.equal(decreased.status, "OPEN");
  assert.equal(decreased.economicQuantityAtoms, 200_000n);
  assert.equal(decreased.state.legs[0]?.signedQuantityAtoms, -100_000n);

  const exit = port.create({
    profileId: selectedProfile.profileId,
    owner: OWNER,
    lifecycleAction: "EXIT",
    quantityAtoms: "100000",
    economicQuantityAtoms: "200000",
    limitPrices: [{ legId: "treasury-hedge", quoteAtoms: "59999", baseAtoms: "1" }],
    expiryValue: "1020000",
    nonce: "6",
    expectedStrategyStateHash: decreased.stateHashHex,
  });
  validateNativeStrategyExit(decreased, exit.order, exit.graph);
  const exitOrderHash = toHex(strategyPackageOrderHash(exit.order));
  const closed = applyNativeStrategyExitReceipt(
    { ...decreased, status: "EXITING", exitOrderHashHex: exitOrderHash },
    exitOrderHash,
    "62".repeat(32),
    exit.order,
    exit.graph,
    receipt(exit, "EXIT", 100_000n),
  );
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.state.open, false);
  assert.equal(closed.state.legs[0]?.signedQuantityAtoms, 0n);
});
