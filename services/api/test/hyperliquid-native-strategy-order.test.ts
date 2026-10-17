import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from 'node:net';
import Database from "better-sqlite3";
import {
  adapterRef,
  assetAmount,
  assetRef,
  commitmentHash,
  domainRef,
  manifestHash,
  packageGraph,
  packageGraphHash,
  parseProtocolJson,
  protocolId,
  requireStrategyTemplateDefinition,
  strategyPackageOrder,
  strategyPackageOrderHash,
  strategyPackageQuote,
  strategyPackageReceipt,
  strategyPackageReceiptHash,
  strategyExecutionMatches,
  stringifyProtocolJson,
  toHex,
  typedStrategyRouteHash,
  validateStrategyTemplateGraph,
  versionedManifestRef,
  type AdmittedStrategyRoute,
  type PackageGraphInput,
  type StrategyPackageOrderInput,
  type TypedStrategyRoute,
} from "@naryx/protocol-types";
import {
  createPrivateTerminalServer,
  applyNativeStrategyExitReceipt,
  applyNativeStrategyMigrationReceipt,
  applyNativeStrategyRebalanceReceipt,
  applyNativeStrategyTransitionReceipt,
  createHyperliquidNativeStrategyOrderPort,
  HyperliquidNativeStrategyOrderError,
  loadHyperliquidNativeStrategyProfiles,
  nativeStrategyPositionFromEntry,
  prepareStrategyOpen,
  prepareStrategyTransition,
  validateNativeStrategyExit,
  validateNativeStrategyMigration,
  validateNativeStrategyRebalance,
  validateNativeStrategyTransition,
  type HyperliquidNativeStrategyProfile,
} from "../src/index.js";
import type { StrategyOrderIntakePort } from "../src/strategy-order-intake.js";
import { SqliteStrategyPackageStore } from "../src/strategy-package-store.js";
import { HyperliquidTestnetOwnerLedger } from "../src/hyperliquid-testnet-owner-ledger.js";
import {
  attachHyperliquidStrategyExposures,
  createHyperliquidTestnetExecutionGuard,
} from "../src/hyperliquid-testnet-owner-routes.js";
import type { HyperliquidTestnetTerminalExecutionResult } from "../src/hyperliquid-testnet-terminal.js";

const NOW_MS = 1_000_000;
const OWNER = "0x1111111111111111111111111111111111111111";

function profile(
  profileId: string,
  templateId: "external-inventory-hedge-v1" | "perpetual-funding-spread-v1" | "hedge-migration-v1"
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
    nettingPolicyHash: commitmentHash("24".repeat(32)),
    domain: domainRef("hypercore:testnet", 1, "11".repeat(32)),
    settlementAccount: "hypercore-testnet-account",
    baseAsset: assetRef("hypercore:testnet:btc", "31".repeat(32), 5),
    quoteAsset: assetRef("hypercore:testnet:usdc", "32".repeat(32), 6),
    markets: templateId === "external-inventory-hedge-v1"
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

// Hyperliquid receipts are venue-committed; the strategy-book preparation still takes finalized ones.
const committed = (receipt: ReturnType<typeof strategyPackageReceipt>) =>
  strategyPackageReceipt({ ...receipt, finalityStatus: "VENUE_COMMITTED" });

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

test('native strategy HTTP creation returns the exact admitted objects for owner-authorized package liquidity', async () => {
  const options: Parameters<typeof createPrivateTerminalServer> = [{ host: '127.0.0.1', port: 0, terminalOrigin: 'http://localhost:3000' }];
  options[25] = createHyperliquidNativeStrategyOrderPort({ profiles: [profile('btc-treasury-hedge', 'external-inventory-hedge-v1')],
    intake, currentTimeMs: () => NOW_MS });
  const server = createPrivateTerminalServer(...options);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/terminal/strategy-orders/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        profileId: 'btc-treasury-hedge', owner: OWNER, lifecycleAction: 'ENTRY', quantityAtoms: '100000',
        economicQuantityAtoms: '200000', limitPrices: [{ legId: 'treasury-hedge', quoteAtoms: '60001', baseAtoms: '1' }],
        expiryValue: '1020000', nonce: '1',
      }),
    });
    assert.equal(response.status, 200);
    const body = parseProtocolJson(await response.text()) as {
      orderHash: string; graphHash: string; order: StrategyPackageOrderInput; graph: PackageGraphInput;
    };
    assert.equal(toHex(strategyPackageOrderHash(body.order)), body.orderHash);
    assert.equal(toHex(packageGraphHash(body.graph)), body.graphHash);
    assert.equal(body.order.economicQuantity.atoms, 200000n);
    assert.equal(body.order.settlementAccount, OWNER);
    assert.deepEqual(body.graph.strategyAccountRefs, [OWNER]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("loads reviewed profiles and creates treasury entry plus funding exit orders", () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-native-strategy-"));
  const path = join(directory, "profiles.json");
  try {
    writeFileSync(path, stringifyProtocolJson({
      version: 1,
      environment: "testnet",
      profiles: [
        profile("btc-treasury-hedge", "external-inventory-hedge-v1"),
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
    const equivalent = port.create({
      profileId: "btc-treasury-hedge",
      owner: OWNER,
      lifecycleAction: "ENTRY",
      quantityAtoms: "100000",
      economicQuantityAtoms: "200000",
      limitPrices: [{ legId: "treasury-hedge", quoteAtoms: "600010", baseAtoms: "10" }],
      expiryValue: "1020000",
      nonce: "1",
    });
    assert.equal(equivalent.intake.orderHashHex, treasury.intake.orderHashHex);
    assert.equal(equivalent.intake.graphHashHex, treasury.intake.graphHashHex);

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
    assert.equal(toHex(funding.graph.policyHashes.netting), "24".repeat(32));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects requests outside reviewed quantity and expiry bounds", () => {
  const port = createHyperliquidNativeStrategyOrderPort({
    profiles: [profile("btc-treasury-hedge", "external-inventory-hedge-v1")],
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
  const treasuryProfile = profile("btc-treasury-hedge", "external-inventory-hedge-v1");
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
    receipt: committed(entryReceipt),
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
      positionLegId: opened.state.legs[0]!.legId,
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
    committed(rebalanceReceipt),
  );
  const preparedRebalance = prepareStrategyTransition({
    environment: "testnet",
    atValue: BigInt(NOW_MS),
    receiptHashHex: toHex(strategyPackageReceiptHash(rebalanceReceipt)),
    current: opened.state,
    order: rebalance.order,
    graph: rebalance.graph,
    receipt: rebalanceReceipt,
  });
  assert.equal(preparedRebalance.stateHashHex, rebalanced.stateHashHex);
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
      positionLegId: leg.legId === "source-hedge" ? opened.state.legs[0]!.legId : leg.legId,
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
    committed(migrationReceipt),
  );
  const preparedMigration = prepareStrategyTransition({
    environment: "testnet",
    atValue: BigInt(NOW_MS),
    receiptHashHex: toHex(strategyPackageReceiptHash(migrationReceipt)),
    current: opened.state,
    order: migration.order,
    graph: migration.graph,
    receipt: migrationReceipt,
  });
  assert.equal(preparedMigration.stateHashHex, migrated.stateHashHex);
  if (preparedMigration.command.parameters.kind === "APPLY_PACKAGE") {
    assert.deepEqual(
      strategyExecutionMatches(
        "APPLY_PACKAGE",
        opened.state,
        preparedMigration.command.parameters.nextState,
        [migrationReceipt],
        "MIGRATE",
      ),
      { matches: false, mismatch: "EXECUTION_AMBIGUOUS" },
    );
  }
  assert.equal(migrated.status, "OPEN");
  assert.equal(migrated.templateId, "external-inventory-hedge-v1");
  assert.equal(migrated.state.legs.length, 1);
  assert.equal(
    migrated.state.legs[0]?.instrumentId,
    migration.graph.legs.find((leg) => leg.legId === "destination-hedge")?.market.subjectId,
  );
  assert.equal(migrated.state.legs[0]?.signedQuantityAtoms, -100_000n);
});

test("derives an authoritative native state and closes only its exact exit", () => {
  const selectedProfile = profile("btc-treasury-hedge", "external-inventory-hedge-v1");
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
    receipt: committed(receipt(entry, "ENTRY", -100_000n)),
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
  const increaseReceipt = receipt(increase, "INCREASE", -25_000n);
  const preparedIncrease = prepareStrategyTransition({
    environment: "testnet",
    atValue: BigInt(NOW_MS),
    receiptHashHex: toHex(strategyPackageReceiptHash(increaseReceipt)),
    current: opened.state,
    order: increase.order,
    graph: increase.graph,
    receipt: increaseReceipt,
  });
  assert.equal(preparedIncrease.command.parameters.kind, "APPLY_PACKAGE");
  if (preparedIncrease.command.parameters.kind === "APPLY_PACKAGE") {
    assert.equal(preparedIncrease.command.parameters.operation, "INCREASE");
    assert.equal(preparedIncrease.command.parameters.nextState.legs[0]?.signedQuantityAtoms, -125_000n);
  }
  const increased = applyNativeStrategyTransitionReceipt(
    opened,
    increase.order,
    increase.graph,
    committed(increaseReceipt),
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
    committed(receipt(decrease, "DECREASE", 25_000n)),
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
    committed(receipt(exit, "EXIT", 100_000n)),
  );
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.state.open, false);
  assert.equal(closed.state.legs[0]?.signedQuantityAtoms, 0n);
});

test("a HyperCore-only venue-committed receipt is final for a native position; mixed or weaker evidence is not", () => {
  const selectedProfile = profile("btc-eth-funding", "perpetual-funding-spread-v1");
  const port = createHyperliquidNativeStrategyOrderPort({ profiles: [selectedProfile], intake, currentTimeMs: () => NOW_MS });
  const entry = port.create({
    profileId: selectedProfile.profileId,
    owner: OWNER,
    lifecycleAction: "ENTRY",
    quantityAtoms: "100000",
    economicQuantityAtoms: "100000",
    limitPrices: [
      { legId: "funding-long", quoteAtoms: "60001", baseAtoms: "1" },
      { legId: "funding-short", quoteAtoms: "3001", baseAtoms: "1" },
    ],
    expiryValue: "1020000",
    nonce: "21",
  });
  const amount = (atoms: bigint) => assetAmount(selectedProfile.quoteAsset, atoms);
  const otherDomain = domainRef("eip155:421614", 1, "12".repeat(32));
  const receipt = (overrides: Readonly<{
    domains?: readonly ReturnType<typeof domainRef>[];
    legDomain?: ReturnType<typeof domainRef>;
    evidenceGrade?: "VENUE_API_CORROBORATED" | "CONTROLLER_ATTESTED";
    bounded?: boolean;
  }> = {}) => strategyPackageReceipt({
    version: 1, environment: "testnet", domains: overrides.domains ?? [selectedProfile.domain],
    orderHash: strategyPackageOrderHash(entry.order), graphHash: packageGraphHash(entry.graph),
    quoteHash: "81".repeat(32), routeHash: "82".repeat(32), templateId: entry.order.templateId, templateVersion: 1,
    packageTemplateManifestHash: entry.order.packageTemplateManifestHash, seriesId: entry.order.seriesId,
    seriesVersion: 1, seriesManifestHash: entry.order.seriesManifestHash, executionClassId: entry.order.executionClassId,
    executionClassVersion: 1, executionClassManifestHash: entry.order.executionClassManifestHash,
    lifecycleAction: "entry", owner: OWNER, solverId: "solver-a", settlementClass: "BATCHED_IOC_WITH_RECOVERY",
    terminalState: overrides.bounded === true ? "FINALIZED_BOUNDED" : "FINALIZED_COMPLETE",
    quoteAsset: selectedProfile.quoteAsset,
    legOutcomes: entry.graph.legs.map((leg) => ({
      legId: leg.legId, positionLegId: leg.legId, domain: overrides.legDomain ?? selectedProfile.domain,
      status: "EXECUTED" as const, requestedQuantity: assetAmount(selectedProfile.baseAsset, leg.quantityAtoms),
      settledQuantity: assetAmount(selectedProfile.baseAsset, leg.side === "BUY" ? leg.quantityAtoms : -leg.quantityAtoms),
      grossNotional: amount(60_000n), venueFee: amount(1n), residualValue: amount(overrides.bounded === true ? 5n : 0n),
      evidenceGrade: overrides.evidenceGrade ?? "VENUE_API_CORROBORATED", onchainEnforced: false,
      evidenceHash: "83".repeat(32),
    })),
    serviceFee: amount(0n), solverFee: amount(0n), venueFees: amount(2n), networkCost: amount(0n),
    recoveryCost: amount(0n), terminalResidualValue: amount(overrides.bounded === true ? 10n : 0n),
    finalityStatus: "VENUE_COMMITTED", executedAtValue: 1_001_000n, receiptNonce: 21n,
  });
  const open = (value: ReturnType<typeof receipt>) => nativeStrategyPositionFromEntry({
    orderHashHex: toHex(strategyPackageOrderHash(entry.order)), receiptHashHex: "84".repeat(32),
    order: entry.order, graph: entry.graph, receipt: value,
  });
  const opened = open(receipt());
  assert.equal(opened?.status, "OPEN");
  assert.deepEqual(opened?.state.legs.map((leg) => leg.signedQuantityAtoms), entry.graph.legs
    .map((leg) => leg.side === "BUY" ? leg.quantityAtoms : -leg.quantityAtoms));
  for (const refused of [
    receipt({ domains: [selectedProfile.domain, otherDomain] }),
    receipt({ domains: [otherDomain], legDomain: otherDomain }),
    receipt({ evidenceGrade: "CONTROLLER_ATTESTED" }),
    receipt({ bounded: true }),
  ]) {
    assert.throws(() => open(refused), { code: "POSITION_NOT_FINAL" });
  }
});

function nativeExecutions(strategies: SqliteStrategyPackageStore) {
  const selectedProfile = profile("btc-treasury-hedge", "external-inventory-hedge-v1");
  const { baseAsset, quoteAsset, domain } = selectedProfile;
  const port = createHyperliquidNativeStrategyOrderPort({
    profiles: [selectedProfile],
    intake: { store: (order, graph) => ({ ...intake.store(order, graph), ...strategies.registerOrder(order, graph) }) },
    currentTimeMs: () => NOW_MS,
  });
  const amount = (atoms: bigint) => assetAmount(quoteAsset, atoms);
  let nonce = 10n;
  // Admits, selects, and returns the receipt-recording step of one native execution, as any path records it,
  // and the executor's result for the same fill.
  return (lifecycleAction: "ENTRY" | "DECREASE" | "EXIT", quantityAtoms: bigint, economicQuantityAtoms: bigint,
    settledAtoms: bigint, notionalAtoms: bigint, expectedStrategyStateHash?: string) => {
    nonce += 1n;
    const created = port.create({
      profileId: selectedProfile.profileId, owner: OWNER, lifecycleAction,
      quantityAtoms: quantityAtoms.toString(), economicQuantityAtoms: economicQuantityAtoms.toString(),
      limitPrices: [{ legId: "treasury-hedge", quoteAtoms: lifecycleAction === "ENTRY" ? "60001" : "59999", baseAtoms: "1" }],
      expiryValue: "1020000", nonce: nonce.toString(),
      ...(expectedStrategyStateHash === undefined ? {} : { expectedStrategyStateHash }),
    });
    const orderHash = strategyPackageOrderHash(created.order);
    const route: TypedStrategyRoute = {
      version: 1, environment: created.order.environment, orderHash, graphHash: packageGraphHash(created.graph),
      solverId: protocolId("solver-a"), settlementClass: created.order.settlementClass, legs: [],
      domainPlans: [{ domain, executionPlanKind: "HYPERCORE_BATCHED_IOC", legIds: [], stageCount: 1 }],
      routeExpiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS", routeExpiryValue: created.order.expiryValue,
    };
    const quote = strategyPackageQuote({
      version: 1, environment: created.order.environment, domains: [domain], orderHash, graphHash: route.graphHash,
      routeHash: typedStrategyRouteHash(route), templateId: created.order.templateId, templateVersion: created.order.templateVersion,
      packageTemplateManifestHash: created.order.packageTemplateManifestHash, seriesId: created.order.seriesId,
      seriesVersion: created.order.seriesVersion, seriesManifestHash: created.order.seriesManifestHash,
      executionClassId: created.order.executionClassId, executionClassVersion: created.order.executionClassVersion,
      executionClassManifestHash: created.order.executionClassManifestHash, quoteConventionId: created.order.quoteConventionId,
      riskClassId: created.order.riskClassId, solverId: "solver-a", solverCapabilityManifestHash: "15".repeat(32),
      quoteMode: "EXECUTION_COMMITMENT", settlementClass: created.order.settlementClass, quoteAsset,
      metrics: requireStrategyTemplateDefinition(created.order.templateId).metricIds
        .map((metricId) => ({ metricId, value: 0n, scale: 0, unitId: "unit" })),
      legEconomics: [{
        legId: "treasury-hedge", quantity: assetAmount(baseAsset, quantityAtoms), grossNotional: amount(notionalAtoms),
        marginDelta: amount(0n), venueFee: amount(1n), builderFee: amount(0n), residualValue: amount(0n),
      }],
      netPackageOutcome: amount(0n), totalGrossNotional: amount(notionalAtoms), totalMarginDelta: amount(0n),
      totalResidualValue: amount(0n), serviceCharges: [], passThroughCosts: [{ category: "VENUE", amount: amount(1n) }],
      feePolicyVersion: 1, feePolicyManifestHash: "16".repeat(32), validUntilUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
      validUntilValue: created.order.expiryValue, quoteNonce: nonce, solverSignatureScheme: "ED25519",
      solverVerificationKey: new Uint8Array(32).fill(1), signature: new Uint8Array(64).fill(2),
    });
    const { quoteHashHex, routeHashHex } = strategies.registerQuote(
      { order: created.order, graph: created.graph, quote, route } as unknown as AdmittedStrategyRoute,
    );
    strategies.recordOwnerAuthorization(toHex(orderHash), OWNER, `0x${"01".repeat(65)}`);
    const { attemptId } = strategies.selectNativeHyperliquidExecution({
      quoteHashHex, orderHashHex: toHex(orderHash), routeHashHex, idempotencyKey: `native-exposure-${nonce}`,
    });
    const record = () => strategies.recordReceipt(strategyPackageReceipt({
      version: 1, environment: "testnet", domains: [domain], orderHash, graphHash: route.graphHash,
      quoteHash: quoteHashHex, routeHash: routeHashHex, templateId: created.order.templateId,
      templateVersion: created.order.templateVersion, packageTemplateManifestHash: created.order.packageTemplateManifestHash,
      seriesId: created.order.seriesId, seriesVersion: created.order.seriesVersion, seriesManifestHash: created.order.seriesManifestHash,
      executionClassId: created.order.executionClassId, executionClassVersion: created.order.executionClassVersion,
      executionClassManifestHash: created.order.executionClassManifestHash, lifecycleAction, owner: OWNER, solverId: "solver-a",
      settlementClass: "BATCHED_IOC_WITH_RECOVERY", terminalState: "FINALIZED_COMPLETE", quoteAsset,
      legOutcomes: [{
        legId: "treasury-hedge", positionLegId: "treasury-hedge", domain, status: "EXECUTED",
        requestedQuantity: assetAmount(baseAsset, quantityAtoms), settledQuantity: assetAmount(baseAsset, settledAtoms),
        grossNotional: amount(notionalAtoms), venueFee: amount(1n), residualValue: amount(0n),
        evidenceGrade: "VENUE_API_CORROBORATED", onchainEnforced: false, evidenceHash: "53".repeat(32),
      }],
      serviceFee: amount(0n), solverFee: amount(0n), venueFees: amount(1n), networkCost: amount(0n), recoveryCost: amount(0n),
      terminalResidualValue: amount(0n), finalityStatus: "VENUE_COMMITTED", executedAtValue: 1_001_000n, receiptNonce: nonce,
    }));
    const signedPlanned = created.graph.legs[0]!.side === "BUY" ? quantityAtoms : -quantityAtoms;
    const commitment = (byte: string) => `0x${byte.repeat(32)}`;
    const result = {
      attemptId, idempotencyKey: `native-exposure-${nonce}`, domain: "hypercore:testnet", environment: "TESTNET",
      status: "STRATEGY_EXECUTION", packageStatus: "COMPLETED", completedStages: [1],
      stages: [{
        batchStage: 1, submissionStatus: "ACKNOWLEDGED", actionCommitment: commitment("a1"), requestCommitment: commitment("a2"),
        evidence: {
          status: "COMPLETE", outcome: "COMPLETED", reasons: [], observedAtMs: "1001000", rawEvidenceCommitments: [],
          legs: [{
            legId: "treasury-hedge", clientOrderId: `0x${"a3".repeat(16)}`, plannedSignedBaseAtoms: signedPlanned.toString(),
            filledSignedBaseAtoms: settledAtoms.toString(), terminalStatus: "FILLED", openOrderStatus: "NONE", orderId: 1,
            fillCount: 1, grossQuoteAtoms: notionalAtoms.toString(), feeAssetId: quoteAsset.assetId,
            feeAssetDecimals: quoteAsset.decimals, feeAtoms: "1", venueFeeQuoteAtoms: "1", observedAtMs: "1001000",
            evidenceCommitment: commitment("a4"),
          }],
        },
      }],
    } as HyperliquidTestnetTerminalExecutionResult;
    return { attemptId, idempotencyKey: `native-exposure-${nonce}`, record, result };
  };
}

test("native execution analytics count stored receipts once, filter solvers, and exclude legacy wrappers", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-native-analytics-"));
  const strategies = new SqliteStrategyPackageStore(join(scratch, "strategies.db"), { clock: () => NOW_MS });
  try {
    assert.deepEqual(strategies.strategyExecutionQuality(), { total: 0, byTerminalState: {}, legEvidence: {} });
    const entry = nativeExecutions(strategies)("ENTRY", 100_000n, 200_000n, -100_000n, 6_000n);
    entry.record();
    entry.record();
    const expected = { total: 1, byTerminalState: { FINALIZED_COMPLETE: 1 }, legEvidence: { VENUE_API_CORROBORATED: 1 } };
    assert.deepEqual(strategies.strategyExecutionQuality(), expected);
    assert.deepEqual(strategies.strategyExecutionQuality("solver-a"), expected);
    assert.equal(strategies.strategyExecutionQuality("solver-b").total, 0);
    assert.throws(() => strategies.strategyExecutionQuality("invalid solver"));
    const attempt = strategies.nativeStrategyExecutionAttempt(entry.attemptId)!;
    strategies.bindSourceOrder(attempt.orderHashHex, "99".repeat(32));
    assert.deepEqual(strategies.strategyExecutionQuality(), { total: 0, byTerminalState: {}, legEvidence: {} });
  } finally {
    strategies.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the exposure ledger counts a native strategy opened before it and follows reductions recorded on any path", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-native-exposure-"));
  const strategies = new SqliteStrategyPackageStore(join(scratch, "strategies.db"), { clock: () => NOW_MS });
  const ledger = new HyperliquidTestnetOwnerLedger(join(scratch, "execution.db"));
  try {
    const execute = nativeExecutions(strategies);
    const { quoteAsset } = profile("btc-treasury-hedge", "external-inventory-hedge-v1");
    const limits = { maxOpenPackagesPerOwner: 1, maxOpenNotionalQuoteAtoms: 10_000n };
    const reserve = (attemptId: string, owner: string, notionalAtoms: bigint) =>
      ledger.reserveExposure({ attemptId, owner, strategyKey: attemptId, notionalAtoms, newPackage: true, limits });
    const other = "0x2222222222222222222222222222222222222222";

    // The strategy opened before the ledger existed: nothing holds its 6000.
    const entry = execute("ENTRY", 100_000n, 200_000n, -100_000n, 6_000n);
    entry.record();
    const [opened] = strategies.nativeStrategyPositionsByOwner(OWNER);
    assert.equal(opened?.status, "OPEN");
    const lines: string[] = [];
    const attach = (asset = quoteAsset) => attachHyperliquidStrategyExposures({
      ledger, strategies, quoteAsset: asset, log: (line) => lines.push(line),
    });
    // A signed notional outside the cap's quote asset is skipped and reported, not guessed.
    assert.deepEqual(attach({ ...quoteAsset, decimals: 18 }), { backfilled: 0, released: 0, skipped: 1 });
    assert.match(lines[0] ?? "", new RegExp(`skipped ${entry.attemptId}`));
    assert.deepEqual(attach(), { backfilled: 1, released: 0, skipped: 0 });
    // A second startup counts nothing twice: 6000 of 10000 stays held.
    assert.deepEqual(attach(), { backfilled: 0, released: 0, skipped: 0 });
    assert.throws(() => reserve("owner-second", OWNER, 1n), { code: "OWNER_PACKAGE_LIMIT" });
    assert.throws(() => reserve("other-1", other, 4_001n), { code: "OMNIBUS_NOTIONAL_LIMIT" });

    // A decrease recorded outside the execution guard releases a quarter: 6000 keeps 4500.
    const decrease = execute("DECREASE", 25_000n, 50_000n, 25_000n, 1_500n, opened!.stateHashHex);
    decrease.record();
    assert.throws(() => reserve("other-1", other, 5_501n), { code: "OMNIBUS_NOTIONAL_LIMIT" });
    reserve("other-1", other, 5_500n);
    // The guard settling the same attempt afterwards applies nothing more.
    ledger.settleReduction({
      attemptId: decrease.attemptId, strategyKey: opened!.entryOrderHashHex,
      result: { status: "STRATEGY_EXECUTION", packageStatus: "COMPLETED" } as never,
      reducedQuantityAtoms: 50_000n, priorQuantityAtoms: 200_000n,
    });
    assert.throws(() => reserve("third-1", `0x${"33".repeat(20)}`, 1n), { code: "OMNIBUS_NOTIONAL_LIMIT" });

    // An exit recorded outside the guard closes the strategy and releases its slot and notional.
    const [decreased] = strategies.nativeStrategyPositionsByOwner(OWNER);
    execute("EXIT", 75_000n, 150_000n, 75_000n, 4_500n, decreased!.stateHashHex).record();
    assert.equal(strategies.nativeStrategyPositionsByOwner(OWNER)[0]?.status, "CLOSED");
    reserve("owner-second", OWNER, 4_500n);
    // A later startup finds nothing left to release and never revives the closed strategy.
    assert.deepEqual(attach(), { backfilled: 0, released: 0, skipped: 0 });
    assert.throws(() => reserve("third-1", `0x${"33".repeat(20)}`, 1n), { code: "OMNIBUS_NOTIONAL_LIMIT" });
  } finally {
    strategies.close();
    ledger.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("settling a native execution again after its receipt is recorded succeeds and applies nothing twice", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-native-resettle-"));
  const strategies = new SqliteStrategyPackageStore(join(scratch, "strategies.db"), { clock: () => NOW_MS });
  const ledger = new HyperliquidTestnetOwnerLedger(join(scratch, "execution.db"));
  try {
    const execute = nativeExecutions(strategies);
    const { quoteAsset } = profile("btc-treasury-hedge", "external-inventory-hedge-v1");
    const limits = { maxOpenPackagesPerOwner: 5, maxOpenNotionalQuoteAtoms: 10_000n };
    const guard = createHyperliquidTestnetExecutionGuard({
      ledger,
      intents: { getAttempt: () => undefined, getAttemptForOrder: () => undefined, getSelectedQuote: () => undefined },
      orders: { getCanonicalOrderByHash: () => undefined },
      strategyAttempts: strategies,
      strategyReceipts: strategies,
      tradingAccount: "hypercore-testnet-account",
      accountMode: "PER_USER",
      limits,
      quoteAsset,
      spotLotAtoms: 1n,
    });
    const other = "0x2222222222222222222222222222222222222222";
    const reserve = (attemptId: string, notionalAtoms: bigint) =>
      ledger.reserveExposure({ attemptId, owner: other, strategyKey: attemptId, notionalAtoms, newPackage: true, limits });
    // Each execution settles three times: on execution, on a status read, and on a sweep or replay.
    const run = (execution: ReturnType<ReturnType<typeof nativeExecutions>>) => {
      const request = { attemptId: execution.attemptId, idempotencyKey: execution.idempotencyKey };
      guard.admit(request);
      for (let settle = 0; settle < 3; settle += 1) guard.settle(request, execution.result);
    };
    run(execute("ENTRY", 100_000n, 200_000n, -100_000n, 6_000n));
    const [opened] = strategies.nativeStrategyPositionsByOwner(OWNER);
    assert.equal(opened?.status, "OPEN");
    assert.throws(() => reserve("other-1", 4_001n), { code: "OMNIBUS_NOTIONAL_LIMIT" });

    // A quarter closed releases a quarter of 6000 once: 4500 stays held.
    run(execute("DECREASE", 25_000n, 50_000n, 25_000n, 1_500n, opened!.stateHashHex));
    const [decreased] = strategies.nativeStrategyPositionsByOwner(OWNER);
    assert.equal(decreased?.economicQuantityAtoms, 150_000n);
    assert.throws(() => reserve("other-1", 5_501n), { code: "OMNIBUS_NOTIONAL_LIMIT" });
    reserve("other-1", 5_500n);

    run(execute("EXIT", 75_000n, 150_000n, 75_000n, 4_500n, decreased!.stateHashHex));
    assert.equal(strategies.nativeStrategyPositionsByOwner(OWNER)[0]?.status, "CLOSED");
    reserve("other-2", 4_500n);
    assert.throws(() => reserve("other-3", 1n), { code: "OMNIBUS_NOTIONAL_LIMIT" });
  } finally {
    strategies.close();
    ledger.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the exposure backfill counts only the attempt whose quote produced the receipt", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-native-backfill-"));
  const path = join(scratch, "strategies.db");
  const strategies = new SqliteStrategyPackageStore(path, { clock: () => NOW_MS });
  try {
    const entry = nativeExecutions(strategies)("ENTRY", 100_000n, 200_000n, -100_000n, 6_000n);
    entry.record();
    // A database from before one selection per order could hold an earlier no-effect attempt.
    const raw = new Database(path);
    try {
      raw.prepare(`
        INSERT INTO strategy_package_quotes
        SELECT ?, order_hash, ?, solver_id, quote_json, route_json, recorded_at_ms
        FROM strategy_package_quotes WHERE quote_hash = (
          SELECT quote_hash FROM strategy_native_execution_attempts WHERE attempt_id = ?)
      `).run(Buffer.alloc(32, 0xee), Buffer.alloc(32, 0xef), entry.attemptId);
      raw.prepare(`
        INSERT INTO strategy_native_execution_attempts
        SELECT ?, 'stale-native-attempt-key', order_hash, graph_hash, ?, ?, status, selected_at_ms - 1
        FROM strategy_native_execution_attempts WHERE attempt_id = ?
      `).run(`strategy-hl-${"ee".repeat(24)}`, Buffer.alloc(32, 0xee), Buffer.alloc(32, 0xef), entry.attemptId);
    } finally {
      raw.close();
    }
    assert.deepEqual(strategies.nativeStrategyExposures().open.map((row) => row.attemptId), [entry.attemptId]);
  } finally {
    strategies.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
