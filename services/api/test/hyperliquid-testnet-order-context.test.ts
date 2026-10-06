import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adapterRef,
  assetRef,
  domainRef,
  exactSignedRate,
  packageGraphHash,
  strategyPackageOrderHash,
  stringifyProtocolJson,
  toHex,
  validateStrategyTemplateGraph,
  type PackageGraphInput,
  type StrategyPackageOrderInput,
} from "@naryx/protocol-types";
import {
  HYPERLIQUID_TESTNET_INFO_URL,
  HyperliquidTestnetPriceFeed,
  InternalOrderCoordinator,
  SqliteExecutionIntentStore,
  SqliteInternalOrderStore,
  SqliteStrategyPackageStore,
  createFetchHyperliquidTestnetInfoPort,
  createHyperliquidTestnetOrderRuntime,
  loadHyperliquidTestnetRuntimeConfig,
  type HyperliquidTestnetInfoPort,
  type HyperliquidTestnetInfoRequest,
  type HyperliquidTestnetRuntimeConfig,
  type SolverAtomicQuoteResponse,
} from "../src/index.js";
import { HyperliquidTestnetOwnerLedger } from "../src/hyperliquid-testnet-owner-ledger.js";
import { createHyperliquidTestnetExitOrderFactory } from "../src/hyperliquid-testnet-owner-routes.js";
import { hyperliquidTestnetBookFills } from "../src/hyperliquid-testnet-order-context.js";
import { createHyperliquidGeneralizedOrderPort } from "../src/hyperliquid-generalized-order.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const CONTEXT_ID = "hyperliquid:testnet:btc-carry-v1";
const START_MS = 1_000_000;
const MAX_STALENESS_MS = 5_000;

function hashesAsHex(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(hashesAsHex);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, hashesAsHex(entry)]));
  }
  return value;
}

function config(baseDecimals = 5): HyperliquidTestnetRuntimeConfig {
  const baseAsset = assetRef("hypercore:testnet:btc", "31".repeat(32), baseDecimals);
  const quoteAsset = assetRef("hypercore:testnet:usdc", "32".repeat(32), 6);
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
      contextId: CONTEXT_ID,
      tradingAccount: ACCOUNT,
      orderVersion: 1,
      templateId: "cash-and-carry-v1",
      templateVersion: 1,
      packageTemplateManifestHash: "21".repeat(32),
      baseAsset,
      quoteAsset,
      spotAdapter: adapterRef({ adapterId: "hypercore-spot-v1", adapterManifestVersion: 1, adapterManifestHash: "41".repeat(32) }),
      perpetualAdapter: adapterRef({ adapterId: "hypercore-perpetual-v1", adapterManifestVersion: 1, adapterManifestHash: "51".repeat(32) }),
      maxStalenessMs: BigInt(MAX_STALENESS_MS),
      expiryTtlMs: 5_000n,
      recoveryActionExpiryTtlMs: 7_000n,
      recoveryDeadlineTtlMs: 10_000n,
      minRecoveryWindowMs: 5_000n,
      livePricing: {
        refreshIntervalMs: 2_000,
        maxBookAgeMs: 1_000,
        maxBookSpreadBps: 50,
        recoveryBandBps: 200,
        feeShortfallSlackBps: 1,
      },
      maxEntrySpread: exactSignedRate({ baseAsset, quoteAsset, baseAtoms: 1n, quoteAtoms: 1n, roundingDirection: "CEIL" }),
      maximumQuantityAtoms: 10_000_000n,
      maxSlippageBps: 50,
      maxNetSpotShortfallAtoms: 10n,
      maxNetSpotExcessAtoms: 0n,
      maxTerminalResidualBaseQuantityAtoms: 100n,
      maxTerminalResidualQuoteValueAtoms: 100_000_000n,
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

type FakeMarket = {
  now: number;
  spot: { bid: string; ask: string };
  perp: { bid: string; ask: string };
  bookAgeMs: number;
  fees: Record<string, unknown>;
  failing: boolean;
  requests: HyperliquidTestnetInfoRequest[];
  reports: string[];
};

function fakeMarket(): FakeMarket {
  return {
    now: START_MS,
    spot: { bid: "60000.5", ask: "60001" },
    perp: { bid: "60010", ask: "60011.5" },
    bookAgeMs: 10,
    fees: { userSpotCrossRate: "0.00035", userCrossRate: "0.00045" },
    failing: false,
    requests: [],
    reports: [],
  };
}

function book(market: FakeMarket, coin: string, top: { bid: string; ask: string }) {
  return {
    coin,
    time: market.now - market.bookAgeMs,
    levels: [
      [{ px: top.bid, sz: "1.5", n: 2 }, { px: "1", sz: "9", n: 1 }],
      [{ px: top.ask, sz: "2", n: 1 }, { px: "99999", sz: "9", n: 1 }],
    ],
  };
}

function infoPort(market: FakeMarket): HyperliquidTestnetInfoPort {
  return {
    async info(request) {
      market.requests.push(request);
      if (market.failing) throw new Error("connect ECONNREFUSED");
      if (request.type === "meta") {
        return { universe: [{ name: "ETH" }, { name: "SOL" }, { name: "OLD", isDelisted: true }, { name: "BTC" }] };
      }
      if (request.type === "spotMeta") {
        return { universe: [{ name: "@100", tokens: [6, 0], index: 100 }, { name: "@101", tokens: [7, 0], index: 101 }] };
      }
      if (request.type === "l2Book") {
        return request.coin === "@101" ? book(market, "@101", market.spot) : book(market, request.coin, market.perp);
      }
      assert.equal(request.user, ACCOUNT);
      return market.fees;
    },
  };
}

function priceFeed(market: FakeMarket, runtimeConfig = config()): HyperliquidTestnetPriceFeed {
  return new HyperliquidTestnetPriceFeed(runtimeConfig, {
    info: infoPort(market),
    currentTimeMs: () => market.now,
    report: (message) => market.reports.push(message),
  });
}

async function withOrders(run: (orders: SqliteInternalOrderStore) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-order-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  try {
    await run(orders);
  } finally {
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

const orderRequest = (size: string, idempotencyKey: string) => ({
  contextId: CONTEXT_ID,
  owner: ACCOUNT,
  settlementAccount: ACCOUNT,
  size,
  slippageBps: 25,
  idempotencyKey,
});

test("Hyperliquid Testnet context prices orders from the live snapshot for any owner wallet in the trading account", async () => {
  const market = fakeMarket();
  const feed = priceFeed(market);
  assert.equal(await feed.refresh(), true);
  assert.deepEqual(market.requests.map((request) => request.type === "l2Book" ? request.coin : request.type), [
    "meta", "spotMeta", "@101", "BTC", "userFees",
  ]);
  const runtime = createHyperliquidTestnetOrderRuntime(config(), feed, () => market.now);
  assert.deepEqual(runtime.terminalContext, {
    contextId: CONTEXT_ID,
    tradingAccount: ACCOUNT,
    domain: {
      domainId: "hypercore:testnet",
      domainManifestVersion: 1,
      domainManifestHash: "11".repeat(32),
    },
    environment: "TESTNET",
    authorizationMode: "OWNER_SIGNED_OMNIBUS_ACCOUNT",
    maxOpenPackagesPerOwner: null,
  });
  const context = runtime.contexts(CONTEXT_ID)!;
  assert.equal(context.capturedAtClock, BigInt(START_MS));
  assert.equal(runtime.contexts(CONTEXT_ID), context);
  // Base atoms carry 5 decimals and quote atoms 6, so one base atom at 60001 costs 600010 quote atoms.
  const ratio = (price: { quoteAtoms: bigint; baseAtoms: bigint; roundingDirection: string } | undefined) =>
    [price?.quoteAtoms, price?.baseAtoms, price?.roundingDirection];
  assert.deepEqual(ratio(context.spotReferencePrice), [600_010n, 1n, "CEIL"]);
  assert.deepEqual(ratio(context.hyperliquidMinPerpSellPrice), [1_194_199n, 2n, "CEIL"]);
  assert.deepEqual(ratio(context.hyperliquidResidualValuationReferencePrice), [1_200_015n, 2n, "CEIL"]);
  assert.deepEqual(ratio(context.maxRecoverySpotBuyPrice), [12_240_153n, 20n, "FLOOR"]);
  assert.deepEqual(ratio(context.minRecoverySpotSellPrice), [11_760_147n, 20n, "CEIL"]);
  assert.deepEqual(ratio(context.minRecoveryPerpSellPrice), [11_762_107n, 20n, "CEIL"]);
  assert.deepEqual(ratio(context.maxRecoveryPerpBuyPrice), [12_242_193n, 20n, "FLOOR"]);
  // ceil(0.00035 * 10000) = 4 bps plus 1 bps of slack.
  assert.equal(context.hyperliquidMaxNetSpotShortfallBps, 5);

  await withOrders(async (orders) => {
    const coordinator = new InternalOrderCoordinator({ contexts: runtime.contexts, clock: runtime.clock, store: orders });
    const created = await coordinator.createOrder(orderRequest("1.00001", "hyper-order-key-0001"));
    const order = orders.getCanonicalOrderByHash(created.record.orderHashHex)!;
    assert.equal(order.domain.domainId, "hypercore:testnet");
    assert.equal(order.settlementClass, "BATCHED_IOC_WITH_RECOVERY");
    assert.equal(order.expiryUnit, "HYPERLIQUID_UNIX_MILLISECONDS");
    assert.equal(order.packageTimeInForce, "IOC");
    assert.equal(order.hyperliquidQuantityPolicy, "BOUNDED_NET");
    assert.equal(order.maxSpotQuoteIn?.atoms, 60_151_604_011n);
    assert.deepEqual(ratio(order.hyperliquidMinPerpSellPrice), [1_194_199n, 2n, "CEIL"]);
    assert.deepEqual(ratio(order.maxRecoveryPerpBuyPrice), [12_242_193n, 20n, "FLOOR"]);
    // Shortfall = ceil(100001 * 5 / 10000) + 10 = 61 atoms, covering the 36-atom base-asset taker fee.
    assert.equal(order.hyperliquidMinNetSpotDelta?.atoms, 99_940n);
    assert.equal(order.hyperliquidMaxNetSpotDelta?.atoms, 100_001n);
    const feeAtoms = (100_001n * 35n + 99_999n) / 100_000n;
    assert.ok(100_001n - order.hyperliquidMinNetSpotDelta!.atoms >= feeAtoms);
    // A solver quote lists that base-asset fee, so the order signs a base-asset venue fee cap too: the
    // fee part of the shortfall, ceil(100001 * 5 / 10000) = 51 atoms, beside the configured quote cap.
    assert.deepEqual(order.maxVenueFeeAtomsByAsset.map((cap) => [cap.asset.assetId, cap.maxAtoms]), [
      ["hypercore:testnet:btc", 51n], ["hypercore:testnet:usdc", 10_000n],
    ]);
    assert.ok(51n >= feeAtoms);
    assert.deepEqual(order.allowedRecoveryActions, [
      "CANCEL_OPEN_ORDERS", "COMPLETE_SPOT", "COMPLETE_PERP", "ROLLBACK_SPOT", "ROLLBACK_PERP",
    ]);
    await assert.rejects(
      coordinator.createOrder(orderRequest("0.00001", "hyper-order-key-0002")),
      /shortfall cannot exceed package quantity/,
    );
    // The owner is the user's own wallet; settlement stays in the configured trading account.
    const owned = await coordinator.createOrder({
      ...orderRequest("1", "hyper-order-key-0003"),
      owner: "0x2222222222222222222222222222222222222222",
    });
    assert.equal(owned.record.owner, "0x2222222222222222222222222222222222222222");
    assert.equal(owned.record.settlementAccount, ACCOUNT);
    await assert.rejects(
      coordinator.createOrder({
        ...orderRequest("1", "hyper-order-key-0004"),
        owner: "0x2222222222222222222222222222222222222222",
        settlementAccount: "0x2222222222222222222222222222222222222222",
      }),
      /configured hosted account/,
    );
    await assert.rejects(
      coordinator.createOrder({ ...orderRequest("1", "hyper-order-key-0005"), owner: `0x${"AB".repeat(20)}` }),
      /not a valid wallet/,
    );
  });
});

test("an entry size the live books cannot fill within its limits is refused before anything is signed", async () => {
  const market = fakeMarket();
  const feed = priceFeed(market);
  assert.equal(await feed.refresh(), true);
  const runtime = createHyperliquidTestnetOrderRuntime(config(), feed, () => market.now);
  const insufficient = (error: unknown) => error instanceof Error
    && (error as { code?: string }).code === "INSUFFICIENT_LIQUIDITY" && /Nothing was signed/.test(error.message);
  await withOrders(async (orders) => {
    const coordinator = new InternalOrderCoordinator({
      contexts: runtime.contexts, clock: runtime.clock, store: orders, spotPrice: runtime.spotPrice,
    });
    // The perpetual bids hold 1.5 at 60010 above the signed floor (60010 less 50 bps); the next bid is below it.
    assert.equal((await coordinator.createOrder(orderRequest("1.5", "hyper-depth-key-0001"))).created, true);
    await assert.rejects(coordinator.createOrder(orderRequest("1.50001", "hyper-depth-key-0002")), insufficient);
  });
  // The spot asks hold 2 at 60001 within the ask plus 25 bps; the 99999 level is outside the cap.
  const { spot } = feed.latest()!;
  const cap = (price: { numerator: bigint; denominator: bigint }) => price.numerator * 10_000n <= 60_001n * 10_025n * price.denominator;
  assert.equal(hyperliquidTestnetBookFills(spot.asks, 200_000n, 5, cap), true);
  assert.equal(hyperliquidTestnetBookFills(spot.asks, 200_001n, 5, cap), false);
  // Book size finer than one base atom is not counted.
  assert.equal(hyperliquidTestnetBookFills([{ px: "1", sz: "0.000019" }], 2n, 5, () => true), false);
  assert.equal(hyperliquidTestnetBookFills([{ px: "1", sz: "0.000019" }], 1n, 5, () => true), true);
});

test("Hyperliquid Testnet context is unknown until a valid snapshot arrives", async () => {
  const market = fakeMarket();
  market.spot = { bid: "60002", ask: "60001" };
  const feed = priceFeed(market);
  const runtime = createHyperliquidTestnetOrderRuntime(config(), feed, () => market.now);
  assert.equal(runtime.contexts(CONTEXT_ID), undefined);
  assert.equal(await feed.refresh(), false);
  assert.equal(feed.latest(), undefined);
  await withOrders(async (orders) => {
    const coordinator = new InternalOrderCoordinator({ contexts: runtime.contexts, clock: runtime.clock, store: orders });
    await assert.rejects(coordinator.createOrder(orderRequest("1", "hyper-unknown-key-01")), /Order context is unknown/);
  });
});

test("Hyperliquid Testnet price feed rejects crossed, locked, wide, stale, and future books and bad fees", async () => {
  const cases: Array<[string, (market: FakeMarket) => void, RegExp]> = [
    ["crossed", (market) => { market.spot = { bid: "60002", ask: "60001" }; }, /spot book is crossed or locked/],
    ["locked", (market) => { market.perp = { bid: "60010", ask: "60010" }; }, /perpetual book is crossed or locked/],
    // A 301 spread on a 60000 bid is 50.17 bps, just above the 50 bps cap.
    ["wide", (market) => { market.spot = { bid: "60000", ask: "60301" }; }, /spot book bid-ask spread exceeds/],
    ["stale", (market) => { market.bookAgeMs = 1_001; }, /stale or future-dated/],
    ["future", (market) => { market.bookAgeMs = -1; }, /stale or future-dated/],
    ["malformed", (market) => { market.perp = { bid: "6e4", ask: "60011" }; }, /perpetual book price is malformed/],
    ["fee", (market) => { market.fees = { userSpotCrossRate: "0.01", userCrossRate: "0.00045" }; },
      /userSpotCrossRate is outside the accepted fee range/],
    ["missing fee", (market) => { market.fees = { userSpotCrossRate: "0.0007" }; }, /userCrossRate is not a bounded decimal/],
  ];
  for (const [name, mutate, expected] of cases) {
    const market = fakeMarket();
    mutate(market);
    const feed = priceFeed(market);
    assert.equal(await feed.refresh(), false, name);
    assert.equal(feed.latest(), undefined, name);
    assert.equal(market.reports.length, 1, name);
    assert.match(market.reports[0]!, expected, name);
  }
  const edge = fakeMarket();
  edge.spot = { bid: "60000", ask: "60300" };
  assert.equal(await priceFeed(edge).refresh(), true, "a spread of exactly 50 bps is accepted");
});

test("a failed refresh keeps the last snapshot, reports once, and staleness then rejects orders", async () => {
  const market = fakeMarket();
  const feed = priceFeed(market);
  assert.equal(await feed.refresh(), true);
  const snapshot = feed.latest();
  const runtime = createHyperliquidTestnetOrderRuntime(config(), feed, () => market.now);
  await withOrders(async (orders) => {
    const coordinator = new InternalOrderCoordinator({ contexts: runtime.contexts, clock: runtime.clock, store: orders });
    market.now = START_MS + MAX_STALENESS_MS;
    await coordinator.createOrder(orderRequest("1", "hyper-stale-key-0001"));

    market.failing = true;
    market.now = START_MS + MAX_STALENESS_MS + 1;
    assert.equal(await feed.refresh(), false);
    assert.equal(await feed.refresh(), false);
    assert.equal(feed.latest(), snapshot);
    assert.deepEqual(market.reports, ["refresh failed, keeping the previous snapshot: info request failed"]);
    await assert.rejects(coordinator.createOrder(orderRequest("1", "hyper-stale-key-0002")), /Order context is stale/);

    market.failing = false;
    assert.equal(await feed.refresh(), true);
    assert.equal(market.reports[1], "refresh recovered");
    await coordinator.createOrder(orderRequest("1", "hyper-stale-key-0003"));
  });
});

test("Hyperliquid Testnet price feed refreshes on its interval until stopped", async () => {
  const market = fakeMarket();
  const fast = config();
  const feed = priceFeed(market, {
    ...fast,
    orderContext: { ...fast.orderContext!, livePricing: { ...fast.orderContext!.livePricing, refreshIntervalMs: 5 } },
  });
  assert.equal(await feed.start(), true);
  const bookRequests = () => market.requests.filter((request) => request.type === "l2Book").length;
  for (let attempt = 0; attempt < 200 && bookRequests() < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  feed.stop();
  assert.ok(bookRequests() >= 4);
  assert.equal(market.requests.filter((request) => request.type === "meta").length, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const settled = bookRequests();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(bookRequests(), settled);
});

test("default info port posts only to the pinned Testnet endpoint without credentials", async () => {
  const calls: Array<[string, RequestInit]> = [];
  const respond = (body: string, headers: Record<string, string>) => async (url: string | URL | Request, init?: RequestInit) => {
    calls.push([String(url), init!]);
    return new Response(body, { status: 200, headers });
  };
  const port = createFetchHyperliquidTestnetInfoPort({
    fetchImplementation: respond("{\"coin\":\"BTC\"}", { "content-type": "application/json" }) as typeof fetch,
  });
  assert.deepEqual(await port.info({ type: "l2Book", coin: "BTC" }), { coin: "BTC" });
  assert.equal(calls[0]![0], HYPERLIQUID_TESTNET_INFO_URL);
  assert.equal(HYPERLIQUID_TESTNET_INFO_URL, "https://api.hyperliquid-testnet.xyz/info");
  assert.equal(calls[0]![1].method, "POST");
  assert.equal(calls[0]![1].credentials, "omit");
  assert.equal(calls[0]![1].redirect, "error");
  assert.equal(calls[0]![1].body, "{\"type\":\"l2Book\",\"coin\":\"BTC\"}");
  const oversized = createFetchHyperliquidTestnetInfoPort({
    fetchImplementation: respond(" ".repeat(300 * 1024), { "content-type": "application/json" }) as typeof fetch,
  });
  await assert.rejects(oversized.info({ type: "userFees", user: ACCOUNT }), /too large/);
  const html = createFetchHyperliquidTestnetInfoPort({
    fetchImplementation: respond("{}", { "content-type": "text/html" }) as typeof fetch,
  });
  await assert.rejects(html.info({ type: "meta" }), /info response is invalid/);
});

test("strict Hyperliquid runtime config loads live pricing and rejects static prices and unsafe bounds", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-order-config-"));
  const path = join(scratch, "runtime.json");
  const write = (orderContext: Record<string, unknown>) => {
    writeFileSync(path, stringifyProtocolJson(hashesAsHex({
      version: 1,
      environment: "TESTNET",
      ...config(),
      orderContext: { ...config().orderContext, ...orderContext },
    })));
  };
  try {
    write({});
    const loaded = loadHyperliquidTestnetRuntimeConfig(path);
    assert.equal(loaded.orderContext?.tradingAccount, ACCOUNT);
    assert.equal(loaded.orderContext?.spotAdapter.adapterId, loaded.market.spot.adapterId);
    assert.deepEqual(loaded.orderContext?.livePricing, config().orderContext!.livePricing);
    const { orderContext: _orderContext, ...incomplete } = loaded;
    assert.throws(
      () => createHyperliquidTestnetOrderRuntime(incomplete, { latest: () => undefined }),
      /order context is missing/,
    );

    const legacyPrice = {
      baseAsset: config().orderContext!.baseAsset,
      quoteAsset: config().orderContext!.quoteAsset,
      baseAtoms: 1n,
      quoteAtoms: 600_010n,
      roundingDirection: "CEIL",
    };
    for (const field of [
      "spotReferencePrice", "minPerpSellPrice", "residualValuationReferencePrice",
      "maxRecoverySpotBuyPrice", "minRecoverySpotSellPrice", "minRecoveryPerpSellPrice",
      "maxRecoveryPerpBuyPrice",
    ]) {
      write({ [field]: legacyPrice });
      assert.throws(() => loadHyperliquidTestnetRuntimeConfig(path), /orderContext fields are invalid/, field);
    }
    const pricing = config().orderContext!.livePricing;
    for (const [livePricing, expected] of [
      [{ ...pricing, refreshIntervalMs: 1_999 }, /refreshIntervalMs is out of range/],
      [{ ...pricing, recoveryBandBps: 0 }, /recoveryBandBps is out of range/],
      [{ ...pricing, maxBookSpreadBps: 1_001 }, /maxBookSpreadBps is out of range/],
      [{ ...pricing, extra: 1 }, /livePricing fields are invalid/],
    ] as const) {
      write({ livePricing });
      assert.throws(() => loadHyperliquidTestnetRuntimeConfig(path), expected);
    }
    write({ maxStalenessMs: 2_000n });
    assert.throws(() => loadHyperliquidTestnetRuntimeConfig(path), /order bounds are inconsistent/);
    write({ maxSlippageBps: 10_000 });
    assert.throws(() => loadHyperliquidTestnetRuntimeConfig(path), /order bounds are inconsistent/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a selected Hyperliquid package stages one typed strategy order with exact venue bindings", async () => {
  const market = fakeMarket();
  const runtimeConfig = config();
  const feed = priceFeed(market, runtimeConfig);
  assert.equal(await feed.refresh(), true);
  const runtime = createHyperliquidTestnetOrderRuntime(runtimeConfig, feed, () => market.now);
  await withOrders(async (orders) => {
    const strategyScratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-strategy-source-"));
    const strategyStore = new SqliteStrategyPackageStore(join(strategyScratch, "strategies.db"), { clock: () => market.now });
    try {
    const coordinator = new InternalOrderCoordinator({ contexts: runtime.contexts, clock: runtime.clock, store: orders });
    const created = await coordinator.createOrder(orderRequest("1", "hyper-generalized-order-0001"));
    let captured: Readonly<{ order: StrategyPackageOrderInput; graph: PackageGraphInput }> | undefined;
    const port = createHyperliquidGeneralizedOrderPort({
      config: runtimeConfig,
      profile: {
        seriesId: "btc-cash-carry-usdc",
        seriesVersion: 1,
        executionClassId: "hyperliquid-testnet-batched-ioc",
        executionClassVersion: 1,
      },
      orders,
      intents: {
        getAttemptForOrder: (orderHash) => orderHash === created.record.orderHashHex ? ({} as never) : undefined,
        getAuthorization: () => undefined,
      },
      intake: {
        store: (order, graph) => {
          captured = { order, graph };
          const stored = strategyStore.registerOrder(order, graph);
          return {
            version: 1,
            status: "STORED_FOR_QUOTING",
            ...stored,
            currentTime: { unit: "HYPERLIQUID_UNIX_MILLISECONDS", value: BigInt(market.now) },
            timeSource: "SERVER",
            stages: [],
          };
        },
      },
      sources: strategyStore,
    });
    const staged = port.stage(created.record.orderHashHex);
    assert.equal(staged.intake.status, "STORED_FOR_QUOTING");
    assert.equal(validateStrategyTemplateGraph(staged.graph).valid, true);
    assert.equal(captured?.graph.settlementClass, "BATCHED_IOC_WITH_RECOVERY");
    assert.deepEqual(captured?.graph.legs.map((leg) => [leg.legId, leg.adapter.adapterId, leg.market.subjectId]), [
      ["perp", "hypercore-perpetual-v1", "perp-btc-usdc"],
      ["spot", "hypercore-spot-v1", "spot-btc-usdc"],
    ]);
    assert.deepEqual(staged.graph.recoverySlots.map((slot) => [slot.legId, slot.action]), [
      ["perp", "COMPLETE"],
      ["spot", "COMPLETE"],
    ]);
    assert.equal(staged.intake.orderHashHex, toHex(strategyPackageOrderHash(staged.order)));
    assert.equal(staged.intake.graphHashHex, toHex(packageGraphHash(staged.graph)));
    assert.deepEqual(strategyStore.sourceBinding(staged.intake.orderHashHex), {
      orderHashHex: staged.intake.orderHashHex,
      sourceOrderHashHex: created.record.orderHashHex,
      recordedAtMs: market.now,
    });
    assert.equal(port.stage(created.record.orderHashHex).intake.created, false);
    assert.throws(
      () => strategyStore.bindSourceOrder(staged.intake.orderHashHex, "ff".repeat(32)),
      { code: "SOURCE_CONFLICT" },
    );
    const unreviewed = createHyperliquidGeneralizedOrderPort({
      config: runtimeConfig,
      profile: {
        seriesId: "btc-cash-carry-usdc",
        seriesVersion: 1,
        executionClassId: "hyperliquid-testnet-batched-ioc",
        executionClassVersion: 1,
      },
      orders,
      intents: { getAttemptForOrder: () => undefined, getAuthorization: () => undefined },
      intake: { store: () => { throw new Error("intake must not run"); } },
      sources: { bindSourceOrder: () => { throw new Error("source binding must not run"); } },
    });
    assert.throws(() => unreviewed.stage(created.record.orderHashHex), { code: "SOURCE_ORDER_NOT_REVIEWED" });
    } finally {
      strategyStore.close();
      rmSync(strategyScratch, { recursive: true, force: true });
    }
  });
});

test("Hyperliquid Testnet selection uses its own durable attempt identity without Solana authorization", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-selection-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
  const runtimeConfig = config();
  const market = fakeMarket();
  const feed = priceFeed(market, runtimeConfig);
  assert.equal(await feed.refresh(), true);
  const runtime = createHyperliquidTestnetOrderRuntime(runtimeConfig, feed, () => market.now);
  const coordinator = new InternalOrderCoordinator({ contexts: runtime.contexts, clock: runtime.clock, store: orders });
  try {
    const created = await coordinator.createOrder(orderRequest("1", "hyper-select-key-001"));
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

test("a Hyperliquid exit sells exactly the owner's package spot and buys back exactly its short, priced against the trader", async () => {
  const market = fakeMarket();
  const feed = priceFeed(market);
  assert.equal(await feed.refresh(), true);
  const runtimeConfig = config();
  const runtime = createHyperliquidTestnetOrderRuntime(runtimeConfig, feed, () => market.now);
  const owner = "0x2222222222222222222222222222222222222222";
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-exit-"));
  const ledger = new HyperliquidTestnetOwnerLedger(join(scratch, "execution.db"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  try {
    const limits = { maxOpenPackagesPerOwner: 1, maxOpenNotionalQuoteAtoms: 10n ** 12n };
    ledger.reserveEntry({ attemptId: "entry-owner-0001", owner, orderHash: "0e".repeat(32), notionalAtoms: 1n, limits });
    // One BTC short; the spot buy paid its 35-atom fee in base, so the package holds 0.99965 BTC.
    const hash = `0x${"dd".repeat(32)}`;
    ledger.settleEntry("entry-owner-0001", {
      attemptId: "entry-owner-0001", idempotencyKey: "idem-0123456789ABCD", domain: "hypercore:testnet",
      environment: "TESTNET", status: "RECONCILED", submissionStatus: "ACKNOWLEDGED", packageStatus: "COMPLETED_BOUNDED",
      reasons: [], actionCommitment: hash, requestCommitment: hash, rawEvidenceCommitments: [],
      observedNetSpotDeltaAtoms: "99965", observedPerpetualDeltaAtoms: "-100000",
    }, 60_010_000_000n);
    const exit = createHyperliquidTestnetExitOrderFactory({
      config: runtimeConfig.orderContext!, spotLotAtoms: 1n, contexts: runtime.contexts, clock: runtime.clock,
      prices: feed, ledger, orders,
    });
    await assert.rejects(
      exit({ owner: "0x3333333333333333333333333333333333333333", slippageBps: 25, idempotencyKey: "hyper-exit-key-0000" }),
      /no open Hyperliquid testnet package/,
    );
    const created = await exit({ owner, slippageBps: 25, idempotencyKey: "hyper-exit-key-0001" });
    const order = orders.getCanonicalOrderByHash(created.record.orderHashHex)!;
    assert.equal(order.action, "EXIT");
    assert.equal(order.owner, owner);
    assert.equal(order.settlementAccount, ACCOUNT);
    assert.equal(order.packageTimeInForce, "IOC");
    assert.equal(order.quantity.atoms, 100_000n);
    assert.equal(order.hyperliquidGrossSpotQuantity?.atoms, 99_965n);
    assert.equal(order.hyperliquidMinNetSpotDelta?.atoms, -99_965n);
    assert.equal(order.hyperliquidMaxNetSpotDelta?.atoms, -99_965n);
    assert.equal(order.expectedPreStrategySpotQuantity?.atoms, 99_965n);
    assert.equal(order.expectedPrePositionSize.atoms, -100_000n);
    assert.equal(Buffer.from(order.entryReceiptHash!).toString("hex"), ledger.openPackage(owner)?.entryReceiptHash);
    // 0.99965 BTC at the 60000.5 bid less 25 bps is 59829.5510754375 USDC, rounded down.
    assert.equal(order.minSpotQuoteOut?.atoms, 59_829_551_075n);
    // The buy-back cap is the 60011.5 ask plus 25 bps, rounded down as a buy limit.
    const cap = order.hyperliquidMaxPerpBuyPrice!;
    assert.deepEqual([cap.quoteAtoms, cap.baseAtoms, cap.roundingDirection], [48_129_223n, 80n, "FLOOR"]);
    // Proceeds less the 0.035% spot fee, plus the entry notional, less the capped buy-back and its 0.045% fee.
    assert.equal(order.minExitQuoteOutcome?.atoms, 59_630_009_294n);
    assert.equal(ledger.openPackage(owner)?.exitOrderHash, created.record.orderHashHex);
  } finally {
    orders.close();
    ledger.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a base asset at its token precision sizes entries in whole lots and exits leave sub-lot fee dust", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-wei-"));
  const path = join(scratch, "runtime.json");
  const write = (baseDecimals: number) => writeFileSync(path, stringifyProtocolJson(hashesAsHex({
    version: 1, environment: "TESTNET", ...config(baseDecimals),
  })));
  // Base decimals may be finer than both size grids (spotMeta weiDecimals), never coarser.
  write(8);
  assert.equal(loadHyperliquidTestnetRuntimeConfig(path).orderContext?.baseAsset.decimals, 8);
  write(4);
  assert.throws(() => loadHyperliquidTestnetRuntimeConfig(path), /does not match configured market metadata/);

  const base = config(8);
  const runtimeConfig: HyperliquidTestnetRuntimeConfig = {
    ...base,
    orderContext: { ...base.orderContext!, maxTerminalResidualBaseQuantityAtoms: 100_000n },
  };
  const market = fakeMarket();
  const feed = priceFeed(market, runtimeConfig);
  assert.equal(await feed.refresh(), true);
  const runtime = createHyperliquidTestnetOrderRuntime(runtimeConfig, feed, () => market.now);
  assert.equal(runtime.contexts(CONTEXT_ID)?.quantityStepAtoms, 1_000n);
  const owner = "0x2222222222222222222222222222222222222222";
  const ledger = new HyperliquidTestnetOwnerLedger(join(scratch, "execution.db"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  try {
    const coordinator = new InternalOrderCoordinator({ contexts: runtime.contexts, clock: runtime.clock, store: orders });
    await assert.rejects(
      coordinator.createOrder({ ...orderRequest("0.05000001", "hyper-wei-key-00001"), owner }),
      /whole number of venue lots/,
    );
    const limits = { maxOpenPackagesPerOwner: 1, maxOpenNotionalQuoteAtoms: 10n ** 12n };
    ledger.reserveEntry({ attemptId: "entry-owner-0002", owner, orderHash: "0f".repeat(32), notionalAtoms: 1n, limits });
    // The spot buy paid its fee in base at full precision: 0.99965123 BTC against a 1 BTC short.
    const hash = `0x${"dd".repeat(32)}`;
    ledger.settleEntry("entry-owner-0002", {
      attemptId: "entry-owner-0002", idempotencyKey: "idem-0123456789ABCD", domain: "hypercore:testnet",
      environment: "TESTNET", status: "RECONCILED", submissionStatus: "ACKNOWLEDGED", packageStatus: "COMPLETED_BOUNDED",
      reasons: [], actionCommitment: hash, requestCommitment: hash, rawEvidenceCommitments: [],
      observedNetSpotDeltaAtoms: "99965123", observedPerpetualDeltaAtoms: "-100000000",
    }, 60_010_000_000n);
    const exit = createHyperliquidTestnetExitOrderFactory({
      config: runtimeConfig.orderContext!, spotLotAtoms: 1_000n, contexts: runtime.contexts, clock: runtime.clock,
      prices: feed, ledger, orders,
    });
    const created = await exit({ owner, slippageBps: 25, idempotencyKey: "hyper-wei-exit-0001" });
    const order = orders.getCanonicalOrderByHash(created.record.orderHashHex)!;
    // The sell is floored to the 0.00001 spot lot; 123 atoms of dust stay in the trading account.
    assert.equal(order.hyperliquidGrossSpotQuantity?.atoms, 99_965_000n);
    assert.equal(order.hyperliquidMinNetSpotDelta?.atoms, -99_965_000n);
    assert.equal(order.hyperliquidMaxNetSpotDelta?.atoms, -99_965_000n);
    assert.equal(order.expectedPreStrategySpotQuantity?.atoms, 99_965_123n);
    assert.equal(order.quantity.atoms, 100_000_000n);
    const terms = {
      owner, orderHash: created.record.orderHashHex, perpQuantityAtoms: 100_000_000n, spotLotAtoms: 1_000n,
      entryReceiptHash: ledger.openPackage(owner)!.entryReceiptHash!,
    };
    assert.throws(() => ledger.beginExit("exit-wei-0001", { ...terms, grossSpotQuantityAtoms: 99_965_123n }),
      /does not close exactly/);
    ledger.beginExit("exit-wei-0001", { ...terms, grossSpotQuantityAtoms: 99_965_000n });
    assert.equal(ledger.packages(owner)[0]?.exitSpotQuantityAtoms, 99_965_000n);
  } finally {
    orders.close();
    ledger.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
