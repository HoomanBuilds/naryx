import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  packageMatchingPolicy,
  packageMatchingPolicyHash,
  packageReopeningSnapshotHash,
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
  settlement,
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
    const maker = order(1);
    const rested = store.submitOrder(CLASS, maker, NOW, settlement(maker));
    assert.equal(rested.accepted && rested.allocation.restedQuantity, 10n);
    const taker = order(2, { side: "BID", timeInForce: "IOC" });
    const filled = store.submitOrder(CLASS, taker, NOW, settlement(taker));
    assert.equal(filled.accepted && filled.replayed, false);
    const replay = store.submitOrder(CLASS, taker, NOW, settlement(taker));
    assert.equal(replay.accepted && replay.replayed, true);
    assert.equal(replay.accepted && replay.allocationHashHex, filled.accepted && filled.allocationHashHex);
    assert.equal(store.getBook(CLASS)?.entries.length, 0);
    const stored = store.getAllocation(id(2));
    assert.ok(stored);
    verifyPackageAllocation(packageMatchingPolicy(POLICY), stored);
    for (const packageOrderId of [maker.orderId, taker.orderId]) {
      const progress = store.settlementProgress(packageOrderId);
      assert.equal(progress?.readiness.status, "READY_FOR_OWNER_AUTHORIZATION");
      assert.deepEqual(
        [progress?.readiness.committedQuantity, progress?.readiness.allocatedQuantity, progress?.readiness.remainingQuantity],
        [10n, 10n, 0n],
      );
      assert.equal(progress?.obligations.length, 1);
    }
    const rejectedOrder = order(3, { side: "BID", timeInForce: "IOC" });
    const rejected = store.submitOrder(CLASS, rejectedOrder, NOW, settlement(rejectedOrder));
    assert.deepEqual(rejected, { accepted: false, rejection: "MINIMUM_QUANTITY_UNFILLABLE" });
  });
});

test("GTC orders expire with their signed settlement lease", () => {
  withStore((store) => {
    registerAll(store);
    const maker = order(1, { timeInForce: "GTC" });
    const accepted = store.submitOrder(CLASS, maker, NOW, settlement(maker));
    assert.equal(accepted.accepted, true);
    assert.equal(store.getBook(CLASS)?.entries[0]?.expiresAtValue, maker.settlementLeaseUntilValue);

    const mismatched = order(2, { timeInForce: "GTC" });
    assert.throws(
      () => store.submitOrder(CLASS, mismatched, NOW, settlement(mismatched, { validUntilValue: 1_999n })),
      { code: "SETTLEMENT_MISMATCH" },
    );

    const afterLease = order(3, { side: "BID", timeInForce: "IOC" });
    const result = store.submitOrder(CLASS, afterLease, 2_000n, settlement(afterLease, { validUntilValue: 2_001n }));
    assert.deepEqual(result, { accepted: false, rejection: "MINIMUM_QUANTITY_UNFILLABLE" });
    assert.equal(store.getBook(CLASS)?.entries.length, 0);
  });
});

test("halted books queue settlement-backed orders and clear them at one reopening price", () => {
  withStore((store) => {
    registerAll(store);
    store.setHalted(CLASS, true);
    const ask = order(1, { side: "ASK", limitPriceTicks: 95n });
    const bid = order(2, { side: "BID", limitPriceTicks: 105n });
    assert.equal(store.queueReopeningOrder(CLASS, ask, NOW, settlement(ask)).replayed, false);
    assert.equal(store.queueReopeningOrder(CLASS, bid, NOW, settlement(bid)).replayed, false);
    assert.equal(store.queueReopeningOrder(CLASS, bid, NOW, settlement(bid)).replayed, true);

    const policy = packageMatchingPolicy(POLICY);
    const opening = store.getBook(CLASS)!;
    const openingSnapshotHash = packageReopeningSnapshotHash(policy, opening);
    const cleared = store.clearReopeningAuction(CLASS, id(800), openingSnapshotHash, id(900), 100n, NOW);

    assert.equal(cleared.replayed, false);
    assert.equal(cleared.result.clearingPriceTicks, 100n);
    assert.equal(cleared.result.executedQuantity, 10n);
    assert.equal(cleared.settlementHandoff?.fills.length, 1);
    assert.equal(store.getBook(CLASS)?.halted, false);
    assert.equal(store.getBook(CLASS)?.entries.length, 0);
    for (const [packageOrder, role] of [[ask, "ASK"], [bid, "BID"]] as const) {
      const progress = store.settlementProgress(packageOrder.orderId)!;
      assert.equal(progress.readiness.status, "READY_FOR_OWNER_AUTHORIZATION");
      assert.deepEqual(
        progress.readiness.evidenceRefs.map((reference) => reference.kind),
        ["REOPENING_RESULT"],
      );
      assert.equal(progress.obligations[0]?.role, role);
      assert.equal(progress.obligations[0]?.liquiditySource, "DIRECT");
    }
    assert.equal(
      store.clearReopeningAuction(CLASS, id(800), openingSnapshotHash, id(900), 100n, NOW).replayed,
      true,
    );
  });
});

test("partial settlement obligations require new authorization after the order closes", () => {
  withStore((store) => {
    registerAll(store);
    const maker = order(1, { quantity: 30n });
    store.submitOrder(CLASS, maker, NOW, settlement(maker));
    const taker = order(2, { side: "BID", timeInForce: "IOC" });
    store.submitOrder(CLASS, taker, NOW, settlement(taker));

    let progress = store.settlementProgress(maker.orderId);
    assert.equal(progress?.readiness.status, "PARTIALLY_ALLOCATED");
    assert.deepEqual(
      [progress?.readiness.allocatedQuantity, progress?.readiness.remainingQuantity, progress?.readiness.acceptsFurtherMatches],
      [10n, 20n, true],
    );

    store.cancelEntry(CLASS, maker.orderId, maker.participantId);
    progress = store.settlementProgress(maker.orderId);
    assert.equal(progress?.readiness.status, "PARTIAL_AUTHORIZATION_REQUIRED");
    assert.deepEqual(
      [progress?.readiness.allocatedQuantity, progress?.readiness.remainingQuantity, progress?.readiness.acceptsFurtherMatches],
      [10n, 20n, false],
    );

    const untouched = order(3, { limitPriceTicks: 110n });
    store.submitOrder(CLASS, untouched, NOW, settlement(untouched));
    store.cancelEntry(CLASS, untouched.orderId, untouched.participantId);
    assert.equal(store.settlementProgress(untouched.orderId)?.readiness.status, "CANCELLED_UNFILLED");
  });
});

test("only filled allocations are trades, and a store opened before trades were indexed indexes them once", () => {
  withStore((store, path) => {
    registerAll(store);
    const firstMaker = order(1);
    const firstTaker = order(2, { side: "BID", timeInForce: "IOC" });
    const secondMaker = order(3);
    store.submitOrder(CLASS, firstMaker, NOW, settlement(firstMaker));
    store.submitOrder(CLASS, firstTaker, NOW, settlement(firstTaker));
    store.submitOrder(CLASS, secondMaker, NOW, settlement(secondMaker));
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
    const taker = order(9, { side: "BID", quantity: 20n, timeInForce: "IOC" });
    const fill = store.submitOrder(CLASS, taker, NOW, settlement(taker));
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
    const maker = order(1, { quantity: 30n });
    store.submitOrder(CLASS, maker, NOW, settlement(maker));
    assert.throws(() => store.cancelEntry(CLASS, id(1), "intruder"), { code: "INVALID_INPUT" });
    const amendment = {
      version: 1,
      executionClassId: CLASS,
      entryId: id(1),
      participantId: "maker-1",
      expectedQuantity: 30n,
      expectedPriceTicks: 100n,
      quantity: 20n,
    } as const;
    assert.equal(store.amendEntry(amendment).replayed, false);
    assert.equal(store.amendEntry(amendment).replayed, true);
    assert.equal(store.getBook(CLASS)?.entries[0]?.quantity, 20n);
    assert.throws(() => store.amendEntry({ ...amendment, quantity: 10n }), { code: "INVALID_INPUT" });
    assert.throws(() => store.amendEntry({
      ...amendment,
      expectedQuantity: 20n,
      quantity: 40n,
    }), { code: "INVALID_INPUT" });
    store.setHalted(CLASS, true);
    const blocked = order(2, { side: "BID" });
    assert.deepEqual(store.submitOrder(CLASS, blocked, NOW, settlement(blocked)), { accepted: false, rejection: "HALTED" });
    store.setHalted(CLASS, false);
    const cancellation = store.cancelEntry(CLASS, id(1), "maker-1");
    assert.equal(cancellation.replayed, false);
    assert.equal(store.cancelEntry(CLASS, id(1), "maker-1").replayed, true);
    assert.equal(store.getBook(CLASS)?.entries.length, 0);

    const partialMaker = order(3, { quantity: 30n });
    const partialTaker = order(4, { side: "BID", timeInForce: "IOC" });
    store.submitOrder(CLASS, partialMaker, NOW, settlement(partialMaker));
    store.submitOrder(CLASS, partialTaker, NOW, settlement(partialTaker));
    assert.equal(store.getBook(CLASS)?.entries[0]?.quantity, 20n);
    assert.throws(() => store.amendEntry({
      version: 1,
      executionClassId: CLASS,
      entryId: partialMaker.orderId,
      participantId: partialMaker.participantId,
      expectedQuantity: 20n,
      expectedPriceTicks: partialMaker.limitPriceTicks,
      quantity: 30n,
    }), { code: "INVALID_INPUT" });
  });
});

test("tampered stored state fails closed", () => {
  withStore((store, path) => {
    registerAll(store);
    const maker = order(1);
    store.submitOrder(CLASS, maker, NOW, settlement(maker));
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
      const packageOrder = resting(n);
      const result = store.submitOrder(CLASS, packageOrder, NOW, settlement(packageOrder));
      assert.equal(result.accepted, true);
    }
    const overflow = resting(MAX_ENTRIES_PER_PARTICIPANT + 1);
    assert.throws(() => store.submitOrder(CLASS, overflow, NOW, settlement(overflow)), { code: "PARTICIPANT_BOOK_LIMIT" });
    assert.equal(store.getBook(CLASS)?.entries.length, MAX_ENTRIES_PER_PARTICIPANT);
    store.cancelEntry(CLASS, id(1), "flooder");
    assert.equal(store.getBook(CLASS)?.entries.length, MAX_ENTRIES_PER_PARTICIPANT - 1);
    const replacement = order(9_999, { limitPriceTicks: 100n });
    assert.equal(store.submitOrder(CLASS, replacement, NOW, settlement(replacement)).accepted, true);
  });
});
