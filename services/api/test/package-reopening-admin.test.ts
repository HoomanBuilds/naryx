import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fromProtocolJson, toProtocolJson } from "@naryx/protocol-types";
import { createPackageReopeningAdminHandler, SqlitePackageExchangeStore } from "../src/index.js";
import { CLASS, CLASS_SUPPORT, NOW, SERIES_SUPPORT, id, order, registerAll, settlement } from "./exchange-fixtures.js";

test("loopback reopening controls publish a snapshot and clear its exact auction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-reopening-admin-"));
  const store = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), {
    seriesSupport: SERIES_SUPPORT,
    executionClassSupport: CLASS_SUPPORT,
  });
  registerAll(store);
  store.setHalted(CLASS, true);
  const ask = order(1, { side: "ASK", limitPriceTicks: 95n });
  const bid = order(2, { side: "BID", limitPriceTicks: 105n });
  store.queueReopeningOrder(CLASS, ask, NOW, settlement(ask));
  store.queueReopeningOrder(CLASS, bid, NOW, settlement(bid));
  const handler = createPackageReopeningAdminHandler({ exchange: store, nowValue: () => NOW });
  const server = createServer((request, response) => {
    if (!handler(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(toProtocolJson(body)),
    });
    const text = await response.text();
    return { status: response.status, body: fromProtocolJson(JSON.parse(text)) };
  };
  try {
    assert.equal((await post(
      "/internal/package-book/reopening/snapshot",
      { executionClassId: CLASS },
      { Origin: "https://example.com" },
    )).status, 403);
    const snapshot = await post("/internal/package-book/reopening/snapshot", { executionClassId: CLASS });
    assert.equal(snapshot.status, 200);
    const openingSnapshotHash = (snapshot.body as { openingSnapshotHash: string }).openingSnapshotHash;
    const cleared = await post("/internal/package-book/reopening/clear", {
      auctionId: id(800),
      executionClassId: CLASS,
      openingSnapshotHash,
      qualificationSnapshotHash: id(900),
      referencePriceTicks: 100n,
    });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.body as { result: { executedQuantity: bigint } }).result.executedQuantity, 10n);
    assert.equal(store.getBook(CLASS)?.halted, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
