import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adapterRef,
  assetRef,
  domainRef,
  exactPrice,
  exactSignedRate,
  stringifyProtocolJson,
} from "@naryx/protocol-types";
import {
  InternalOrderCoordinator,
  SqliteExecutionIntentStore,
  SqliteInternalOrderStore,
  createHyperliquidTestnetOrderRuntime,
  loadHyperliquidTestnetRuntimeConfig,
  type HyperliquidTestnetRuntimeConfig,
  type SolverAtomicQuoteResponse,
} from "../src/index.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";

function hashesAsHex(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(hashesAsHex);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, hashesAsHex(entry)]));
  }
  return value;
}

function config(): HyperliquidTestnetRuntimeConfig {
  const baseAsset = assetRef("hypercore:testnet:btc", "31".repeat(32), 5);
  const quoteAsset = assetRef("hypercore:testnet:usdc", "32".repeat(32), 6);
  const price = (quoteAtoms: bigint) => exactPrice({
    baseAsset,
    quoteAsset,
    baseAtoms: 1n,
    quoteAtoms,
    roundingDirection: "CEIL",
  });
  return {
    domain: domainRef("hypercore:testnet", 1, "11".repeat(32)),
    seriesManifestHash: "12".repeat(32),
    executionClassManifestHash: "13".repeat(32),
    solverId: "solver-hypercore-testnet-v1",
    solverVerificationKey: "14".repeat(32),
    market: {
      spot: {
        adapterId: "hypercore-spot-v1", adapterManifestVersion: 1,
        adapterManifestHash: "41".repeat(32), venueId: "hypercore-testnet",
        venueManifestVersion: 1, venueManifestHash: "42".repeat(32),
        marketId: "spot-btc-usdc", marketManifestVersion: 1,
        marketManifestHash: "43".repeat(32), assetId: 101, sizeDecimals: 5,
        universeIndex: 101, tokenIndex: 7,
      },
      perpetual: {
        adapterId: "hypercore-perpetual-v1", adapterManifestVersion: 1,
        adapterManifestHash: "51".repeat(32), venueId: "hypercore-testnet",
        venueManifestVersion: 1, venueManifestHash: "52".repeat(32),
        marketId: "perp-btc-usdc", marketManifestVersion: 1,
        marketManifestHash: "53".repeat(32), assetId: 3, sizeDecimals: 5,
        assetIndex: 3,
      },
      quoteTokenIndex: 0,
    },
    bounds: { maxEvidenceAgeMs: 5_000, maxSnapshotSkewMs: 1_000, maxFillPages: 4 },
    orderContext: {
      contextId: "hyperliquid:testnet:btc-carry-v1",
      tradingAccount: ACCOUNT,
      orderVersion: 1,
      templateId: "cash-and-carry-v1",
      templateVersion: 1,
      packageTemplateManifestHash: "21".repeat(32),
      baseAsset,
      quoteAsset,
      spotAdapter: adapterRef({ adapterId: "hypercore-spot-v1", adapterManifestVersion: 1, adapterManifestHash: "41".repeat(32) }),
      perpetualAdapter: adapterRef({ adapterId: "hypercore-perpetual-v1", adapterManifestVersion: 1, adapterManifestHash: "51".repeat(32) }),
      maxStalenessMs: 100n,
      expiryTtlMs: 5_000n,
      recoveryActionExpiryTtlMs: 7_000n,
      recoveryDeadlineTtlMs: 10_000n,
      minRecoveryWindowMs: 5_000n,
      spotReferencePrice: price(60_001n),
      maxEntrySpread: exactSignedRate({ baseAsset, quoteAsset, baseAtoms: 1n, quoteAtoms: 1n, roundingDirection: "CEIL" }),
      minPerpSellPrice: price(59_001n),
      maxRecoverySpotBuyPrice: price(62_001n),
      minRecoverySpotSellPrice: price(58_001n),
      minRecoveryPerpSellPrice: price(58_001n),
      maxRecoveryPerpBuyPrice: price(62_001n),
      maximumQuantityAtoms: 10_000_000n,
      maxSlippageBps: 50,
      maxNetSpotShortfallAtoms: 10n,
      maxNetSpotExcessAtoms: 0n,
      maxTerminalResidualBaseQuantityAtoms: 10n,
      maxTerminalResidualQuoteValueAtoms: 1_000n,
      residualValuationReferencePrice: price(60_001n),
      maxVenueFeeAtomsByAsset: [{ asset: quoteAsset, maxAtoms: 10_000n }],
      maxMarginAddedAtoms: 100_000_000n,
      maxProtocolFeeAtoms: 10_000n,
      maxSolverFeeAtoms: 20_000n,
      maxPriorityFeeAtoms: 0n,
      minVenueReserveReturnedAtoms: 0n,
      minWalletQuoteBalanceDeltaAtoms: 0n,
      maxResidualBaseQuantityAtoms: 10n,
      maxRecoveryCostAtomsByAsset: [{ asset: quoteAsset, maxAtoms: 50_000n }],
      maxAggregateRecoveryLossQuoteAtoms: 100_000n,
    },
  };
}

test("Hyperliquid Testnet context creates bounded canonical orders and rejects arbitrary accounts", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-order-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const runtime = createHyperliquidTestnetOrderRuntime(config(), () => 1_000_000);
  const coordinator = new InternalOrderCoordinator({ contexts: runtime.contexts, clock: runtime.clock, store: orders });
  const request = {
    contextId: "hyperliquid:testnet:btc-carry-v1",
    owner: ACCOUNT,
    settlementAccount: ACCOUNT,
    size: "1.00000",
    slippageBps: 25,
    idempotencyKey: "hyper-order-key-0001",
  };
  try {
    const created = await coordinator.createOrder(request);
    const order = orders.getCanonicalOrderByHash(created.record.orderHashHex)!;
    assert.equal(order.domain.domainId, "hypercore:testnet");
    assert.equal(order.settlementClass, "BATCHED_IOC_WITH_RECOVERY");
    assert.equal(order.expiryUnit, "HYPERLIQUID_UNIX_MILLISECONDS");
    assert.equal(order.packageTimeInForce, "IOC");
    assert.equal(order.hyperliquidQuantityPolicy, "BOUNDED_NET");
    assert.equal(order.hyperliquidMinNetSpotDelta?.atoms, 99_990n);
    assert.equal(order.hyperliquidMaxNetSpotDelta?.atoms, 100_000n);
    assert.equal(order.hyperliquidMaxTerminalResidualBaseQuantity?.atoms, 10n);
    assert.deepEqual(order.allowedRecoveryActions, [
      "CANCEL_OPEN_ORDERS", "COMPLETE_SPOT", "COMPLETE_PERP", "ROLLBACK_SPOT", "ROLLBACK_PERP",
    ]);
    await assert.rejects(
      coordinator.createOrder({ ...request, owner: "0x2222222222222222222222222222222222222222", idempotencyKey: "hyper-order-key-0002" }),
      /configured hosted account/,
    );
  } finally {
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("strict Hyperliquid runtime config loads the bound order context and rejects incomplete input", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-order-config-"));
  const path = join(scratch, "runtime.json");
  try {
    writeFileSync(path, stringifyProtocolJson(hashesAsHex({
      version: 1,
      environment: "TESTNET",
      ...config(),
    })));
    const loaded = loadHyperliquidTestnetRuntimeConfig(path);
    assert.equal(loaded.orderContext?.tradingAccount, ACCOUNT);
    assert.equal(loaded.orderContext?.spotAdapter.adapterId, loaded.market.spot.adapterId);
    const { orderContext: _orderContext, ...incomplete } = loaded;
    assert.throws(
      () => createHyperliquidTestnetOrderRuntime(incomplete),
      /order context is missing/,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Hyperliquid Testnet selection uses its own durable attempt identity without Solana authorization", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-selection-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
  const runtimeConfig = config();
  const runtime = createHyperliquidTestnetOrderRuntime(runtimeConfig, () => 1_000_000);
  const coordinator = new InternalOrderCoordinator({ contexts: runtime.contexts, clock: runtime.clock, store: orders });
  try {
    const created = await coordinator.createOrder({
      contextId: "hyperliquid:testnet:btc-carry-v1", owner: ACCOUNT, settlementAccount: ACCOUNT,
      size: "1", slippageBps: 25, idempotencyKey: "hyper-select-key-001",
    });
    const quote: SolverAtomicQuoteResponse = {
      version: 1, status: "SIGNED", idempotencyKey: "hyper-quote-key-0001",
      orderHash: created.record.orderHashHex, routeHash: "61".repeat(32), quoteHash: "62".repeat(32),
      solverSignatureDigest: "63".repeat(32), routeBytes: "01", solverQuoteBytes: "02",
      route: {}, quote: {},
    };
    intents.recordQuote(quote);
    const attempt = intents.selectQuoteForOrder(created.record, runtimeConfig.domain, quote.quoteHash);
    assert.match(attempt.attemptId, /^hyperliquid-testnet-[0-9a-f]{48}$/);
    assert.equal(attempt.status, "HYPERLIQUID_TESTNET_QUOTE_SELECTED");
    assert.deepEqual(intents.getAttempt(attempt.attemptId), attempt);
  } finally {
    intents.close();
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
