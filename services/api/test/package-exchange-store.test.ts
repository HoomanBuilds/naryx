import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  packageMatchingPolicy,
  packageMatchingPolicyHash,
  toHex,
  verifyPackageAllocation,
} from "@naryx/protocol-types";
import { PackageExchangeStoreError, SqlitePackageExchangeStore } from "../src/index.js";
import { MAX_ENTRIES_PER_PARTICIPANT } from "../src/package-exchange-store.js";
import {
  CLASS,
  CLASS_SUPPORT,
  NOW,
  POLICY,
  SERIES,
  SERIES_SUPPORT,
  executionClass,
  id,
  impliedAsk,
  order,
  registerAll,
  withStore,
} from "./exchange-fixtures.js";

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

test("only filled allocations are trades, and a store opened before trades were indexed indexes them once", () => {
  withStore((store, path) => {
    registerAll(store);
    store.submitOrder(CLASS, order(1), NOW);
    store.submitOrder(CLASS, order(2, { side: "BID", timeInForce: "IOC" }), NOW);
    store.submitOrder(CLASS, order(3), NOW);
    const tape = store.allocationTape(CLASS, 0, 10);
    assert.deepEqual(tape.map((entry) => entry.cursor), [2]);
    assert.equal(store.latestTrade(CLASS)?.cursor, 2);
    const raw = new Database(path);
    try {
      raw.exec("DROP TABLE package_book_trades");
    } finally {
      raw.close();
    }
    const reopened = new SqlitePackageExchangeStore(path, { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
    try {
      assert.deepEqual(reopened.allocationTape(CLASS, 0, 10).map((entry) => entry.allocationHashHex), tape.map((entry) => entry.allocationHashHex));
      assert.equal(reopened.latestTrade(CLASS)?.allocationHashHex, tape[0]?.allocationHashHex);
    } finally {
      reopened.close();
    }
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
    const cancellation = store.cancelEntry(CLASS, id(1), "maker-1");
    assert.equal(cancellation.replayed, false);
    assert.equal(store.cancelEntry(CLASS, id(1), "maker-1").replayed, true);
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

test("one participant cannot grow a book past its entry cap, but can always cancel", () => {
  withStore((store) => {
    registerAll(store);
    const resting = (n: number) => order(n, { participantId: "flooder", commonControlGroupId: "flood", limitPriceTicks: 100n + BigInt(n) });
    for (let n = 1; n <= MAX_ENTRIES_PER_PARTICIPANT; n += 1) {
      const result = store.submitOrder(CLASS, resting(n), NOW);
      assert.equal(result.accepted, true);
    }
    assert.throws(() => store.submitOrder(CLASS, resting(MAX_ENTRIES_PER_PARTICIPANT + 1), NOW), { code: "PARTICIPANT_BOOK_LIMIT" });
    assert.equal(store.getBook(CLASS)?.entries.length, MAX_ENTRIES_PER_PARTICIPANT);
    store.cancelEntry(CLASS, id(1), "flooder");
    assert.equal(store.getBook(CLASS)?.entries.length, MAX_ENTRIES_PER_PARTICIPANT - 1);
    assert.equal(store.submitOrder(CLASS, order(9_999, { limitPriceTicks: 100n }), NOW).accepted, true);
  });
});
