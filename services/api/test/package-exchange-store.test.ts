import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  deriveImpliedPackageQuote,
  domainRef,
  duration,
  economicStrategySeriesHash,
  packageMatchingPolicy,
  packageMatchingPolicyHash,
  toHex,
  verifyPackageAllocation,
} from "@naryx/protocol-types";
import type {
  EconomicStrategySeriesInput,
  PackageMatchingPolicyInput,
  PackageTakerOrderInput,
  SeriesExecutionClassInput,
} from "@naryx/protocol-types";
import { PackageExchangeStoreError, SqlitePackageExchangeStore } from "../src/index.js";

const CLASS = "solana-atomic-cash-carry-v1";
const NOW = 1_000n;
const SERIES_SUPPORT = {
  supportedTemplateIds: ["cash-and-carry-v1"],
  supportedQuoteConventionIds: ["annualized-net-yield-v1"],
  supportedRiskClassIds: ["delta-neutral-basis-v1"],
  supportedLifecycleConventionIds: ["rolling-evaluation-window-v1"],
};
const CLASS_SUPPORT = {
  supportedVenueClassIds: ["svm-spot-amm-v1", "svm-perp-clob-v1"],
  supportedCollateralModeIds: ["isolated-prefunded-v1"],
  supportedSettlementClasses: ["ATOMIC_POSTCONDITION"] as const,
  supportedFirmnessClassIds: ["firm-inventory-reservation-v1"],
};
const POLICY: PackageMatchingPolicyInput = {
  matchingPolicyVersion: 1,
  environment: "local",
  executionClassId: CLASS,
  allocationRule: "PRICE_TIME",
  directVersusImpliedPriority: "DIRECT_FIRST",
  selfMatchPolicy: "CANCEL_INCOMING",
  commonControlAsSelf: true,
  amendmentPriorityRule: "RETAIN_ON_SIZE_REDUCTION",
  quantityIncrement: 10n,
  minimumExecutionQuantity: 10n,
  maximumImplicationDepth: 1,
};
const SERIES: EconomicStrategySeriesInput = {
  seriesVersion: 1,
  seriesId: "sol-cash-carry-30d-usdc-v1",
  templateId: "cash-and-carry-v1",
  templateVersion: 1,
  templateManifestHash: "11".repeat(32),
  underlyingRefs: ["sol", "sol"],
  quoteAsset: "usd",
  economicLegRatios: [
    { numerator: 1n, denominator: 1n },
    { numerator: -1n, denominator: 1n },
  ],
  maturityOrEvaluationWindow: duration("MILLISECONDS", 2_592_000_000n),
  quoteConvention: "annualized-net-yield-v1",
  riskClass: "delta-neutral-basis-v1",
  lifecycleConvention: "rolling-evaluation-window-v1",
};

const id = (n: number): string => n.toString(16).padStart(64, "0");

function executionClass(overrides: Partial<SeriesExecutionClassInput> = {}): SeriesExecutionClassInput {
  return {
    executionClassVersion: 1,
    executionClassId: CLASS,
    seriesId: SERIES.seriesId,
    seriesVersion: 1,
    seriesManifestHash: economicStrategySeriesHash(SERIES, SERIES_SUPPORT),
    domains: [domainRef("svm:solana-devnet", 1, "22".repeat(32))],
    venueClasses: ["svm-perp-clob-v1", "svm-spot-amm-v1"],
    collateralMode: "isolated-prefunded-v1",
    settlementClass: "ATOMIC_POSTCONDITION",
    firmnessClass: "firm-inventory-reservation-v1",
    deliveryPolicyHash: "44".repeat(32),
    recoveryPolicyHash: "55".repeat(32),
    matchingPolicyHash: packageMatchingPolicyHash(packageMatchingPolicy(POLICY)),
    ...overrides,
  };
}

function order(n: number, overrides: Partial<PackageTakerOrderInput> = {}): PackageTakerOrderInput {
  return {
    orderId: id(n),
    executionClassId: CLASS,
    side: "ASK",
    orderType: "LIMIT",
    timeInForce: "GTC",
    limitPriceTicks: 100n,
    quantity: 10n,
    minimumQuantity: 10n,
    participantId: `maker-${n}`,
    commonControlGroupId: `group-${n}`,
    ...overrides,
  };
}

function impliedAsk(spot: number, perp: number, spotReservation: number) {
  return deriveImpliedPackageQuote(packageMatchingPolicy(POLICY), {
    executionClassId: CLASS,
    side: "ASK",
    evidence: "RESERVATION_BACKED_IMPLIED",
    legRatios: SERIES.economicLegRatios,
    legSources: [
      { sourceId: `spot-${spot}`, sourceVersion: 1n, side: "ASK", priceTicks: 1_100n, quantity: 20n, reservationId: id(spotReservation) },
      { sourceId: `perp-${perp}`, sourceVersion: 1n, side: "BID", priceTicks: 1_000n, quantity: 20n, reservationId: id(900 + perp) },
    ],
  });
}

function withStore(run: (store: SqlitePackageExchangeStore, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "naryx-exchange-"));
  const path = join(dir, "exchange.sqlite");
  const store = new SqlitePackageExchangeStore(path, { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  try {
    run(store, path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function registerAll(store: SqlitePackageExchangeStore): void {
  store.registerMatchingPolicy(POLICY);
  store.registerSeries(SERIES);
  store.registerExecutionClass(executionClass());
  store.openBook(CLASS, 1);
}

test("series, classes, and policies are immutable once registered", () => {
  withStore((store) => {
    assert.throws(() => store.registerExecutionClass(executionClass()), { code: "UNKNOWN_REFERENCE" });
    assert.equal(store.registerSeries(SERIES).created, true);
    assert.throws(() => store.registerExecutionClass(executionClass()), { code: "UNKNOWN_REFERENCE" });
    assert.equal(store.registerMatchingPolicy(POLICY).created, true);
    const registered = store.registerExecutionClass(executionClass());
    assert.equal(registered.created, true);
    assert.equal(store.registerSeries(SERIES).created, false);
    assert.throws(() => store.registerSeries({ ...SERIES, quoteAsset: "usdc" }), { code: "DOCUMENT_CONFLICT" });
    assert.throws(() => store.registerMatchingPolicy({ ...POLICY, quantityIncrement: 5n, minimumExecutionQuantity: 5n }), {
      code: "DOCUMENT_CONFLICT",
    });
    assert.equal(store.getSeries(SERIES.seriesId, 1)?.quoteAsset, "usd");
    assert.equal(store.getExecutionClass(CLASS, 1)?.executionClassId, CLASS);
  });
});

test("a class cannot bind a matching policy written for another class", () => {
  withStore((store) => {
    store.registerSeries(SERIES);
    const other = { ...POLICY, executionClassId: "other-class" };
    store.registerMatchingPolicy(other);
    assert.throws(
      () => store.registerExecutionClass(executionClass({ matchingPolicyHash: packageMatchingPolicyHash(packageMatchingPolicy(other)) })),
      { code: "UNKNOWN_REFERENCE" },
    );
  });
});

test("orders match durably and replay returns the recorded allocation", () => {
  withStore((store) => {
    registerAll(store);
    const rested = store.submitOrder(CLASS, order(1), NOW);
    assert.equal(rested.accepted && rested.allocation.restedQuantity, 10n);
    const taker = order(2, { side: "BID", timeInForce: "IOC" });
    const filled = store.submitOrder(CLASS, taker, NOW);
    assert.equal(filled.accepted && filled.replayed, false);
    const replay = store.submitOrder(CLASS, taker, NOW);
    assert.equal(replay.accepted && replay.replayed, true);
    assert.equal(replay.accepted && replay.allocationHashHex, filled.accepted && filled.allocationHashHex);
    assert.equal(store.getBook(CLASS)?.entries.length, 0);
    const stored = store.getAllocation(id(2));
    assert.ok(stored);
    verifyPackageAllocation(packageMatchingPolicy(POLICY), stored);
    const rejected = store.submitOrder(CLASS, order(3, { side: "BID", timeInForce: "IOC" }), NOW);
    assert.deepEqual(rejected, { accepted: false, rejection: "MINIMUM_QUANTITY_UNFILLABLE" });
  });
});

test("a consumed source reservation cannot back new implied liquidity", () => {
  withStore((store) => {
    registerAll(store);
    store.addImpliedLiquidity(CLASS, { quote: impliedAsk(1, 1, 501), participantId: "solver-a", commonControlGroupId: "solver", nowValue: NOW });
    const fill = store.submitOrder(CLASS, order(9, { side: "BID", quantity: 20n, timeInForce: "IOC" }), NOW);
    assert.equal(fill.accepted && fill.allocation.externalImpliedQuantity, 20n);
    assert.throws(
      () => store.addImpliedLiquidity(CLASS, { quote: impliedAsk(2, 2, 501), participantId: "solver-a", commonControlGroupId: "solver", nowValue: NOW }),
      { code: "SOURCE_ALREADY_CONSUMED" },
    );
  });
});

test("a newer source version invalidates stale implied liquidity and blocks its return", () => {
  withStore((store) => {
    registerAll(store);
    const quote = impliedAsk(1, 1, 501);
    store.addImpliedLiquidity(CLASS, { quote, participantId: "solver-a", commonControlGroupId: "solver", nowValue: NOW });
    assert.deepEqual(store.observeSourceVersion("spot-1", 2n).map(toHex), [toHex(quote.entryId)]);
    assert.equal(store.getBook(CLASS)?.entries.length, 0);
    assert.throws(
      () => store.addImpliedLiquidity(CLASS, { quote, participantId: "solver-a", commonControlGroupId: "solver", nowValue: NOW }),
      { code: "STALE_SOURCE" },
    );
    assert.throws(() => store.observeSourceVersion("spot-1", 1n), { code: "STALE_SOURCE" });
  });
});

test("cancellation authority, halts, and amendments persist", () => {
  withStore((store) => {
    registerAll(store);
    store.submitOrder(CLASS, order(1, { quantity: 30n }), NOW);
    assert.throws(() => store.cancelEntry(CLASS, id(1), "intruder"), { code: "INVALID_INPUT" });
    store.amendEntry(CLASS, { entryId: id(1), participantId: "maker-1", quantity: 20n });
    assert.equal(store.getBook(CLASS)?.entries[0]?.quantity, 20n);
    store.setHalted(CLASS, true);
    assert.deepEqual(store.submitOrder(CLASS, order(2, { side: "BID" }), NOW), { accepted: false, rejection: "HALTED" });
    store.setHalted(CLASS, false);
    store.cancelEntry(CLASS, id(1), "maker-1");
    assert.equal(store.getBook(CLASS)?.entries.length, 0);
  });
});

test("tampered stored state fails closed", () => {
  withStore((store, path) => {
    registerAll(store);
    store.submitOrder(CLASS, order(1), NOW);
    const raw = new Database(path);
    try {
      raw.prepare("UPDATE package_book_entries SET entry_json = replace(entry_json, '\"10\"', '\"15\"')").run();
      assert.throws(() => raw.prepare("DELETE FROM exchange_documents").run(), /immutable/);
    } finally {
      raw.close();
    }
    assert.throws(() => store.getBook(CLASS), (error: unknown) => error instanceof PackageExchangeStoreError && error.code === "CORRUPT_ROW");
  });
});

test("database paths must be absolute and outside the repository", () => {
  const options = { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT };
  assert.throws(() => new SqlitePackageExchangeStore(":memory:", options), { code: "INVALID_PATH" });
  assert.throws(() => new SqlitePackageExchangeStore("relative.sqlite", options), { code: "INVALID_PATH" });
  assert.throws(() => new SqlitePackageExchangeStore(join(process.cwd(), "exchange.sqlite"), options), { code: "INVALID_PATH" });
});
