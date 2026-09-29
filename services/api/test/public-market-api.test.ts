import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fromProtocolJson,
  packageAllocationHash,
  packageMatchingPolicy,
  toHex,
  verifyPackageAllocation,
  type PackageAllocation,
  type PackageMatchingPolicy,
} from "@naryx/protocol-types";
import {
  createPrivateTerminalServer,
  createPublicMarketRequestHandler,
  loadPublicMarketRuntime,
  PublicMarketConfigError,
  SqlitePackageExchangeStore,
  type PublicMarketApiOptions,
} from "../src/index.js";
import { CLASS, CLASS_SUPPORT, NOW, SERIES_SUPPORT, id, impliedAsk, order, registerAll } from "./exchange-fixtures.js";

async function withMarket(
  run: (get: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown; text: string }>, store: SqlitePackageExchangeStore) => Promise<void>,
  overrides: Partial<PublicMarketApiOptions> = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "naryx-market-"));
  const store = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  const handler = createPublicMarketRequestHandler({ store, nowValue: () => NOW, rateLimit: { windowMs: 60_000, maxRequests: 1_000 }, ...overrides });
  const server = createServer((request, response) => {
    if (!handler(request, response)) {
      response.statusCode = 418;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const get = async (path: string, init?: RequestInit) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : fromProtocolJson(JSON.parse(text)), text };
  };
  try {
    await run(get, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("depth keeps direct and implied quantity apart within a level", async () => {
  await withMarket(async (get, store) => {
    registerAll(store);
    store.submitOrder(CLASS, order(1), NOW);
    store.addImpliedLiquidity(CLASS, { quote: impliedAsk(1, 1, 501), participantId: "solver-a", commonControlGroupId: "solver", nowValue: NOW });
    const { status, body } = await get(`/v1/market/books/${CLASS}`);
    assert.equal(status, 200);
    const book = body as { halted: boolean; asks: readonly { priceTicks: bigint; directQuantity: bigint; impliedQuantity: bigint }[]; bids: readonly unknown[] };
    assert.equal(book.halted, false);
    assert.deepEqual(book.bids, []);
    assert.deepEqual(book.asks, [{ priceTicks: 100n, directQuantity: 10n, impliedQuantity: 20n }]);
    assert.equal((await get("/v1/market/books/unknown-class")).status, 404);
  });
});

test("the tape pages by cursor and omits participant and taker order identities", async () => {
  await withMarket(async (get, store) => {
    registerAll(store);
    store.submitOrder(CLASS, order(1), NOW);
    store.submitOrder(CLASS, order(2, { side: "BID", timeInForce: "IOC" }), NOW);
    const first = await get(`/v1/market/books/${CLASS}/tape?limit=1`);
    assert.equal(first.status, 200);
    const tape = first.body as { trades: readonly { cursor: number; allocationHash: string; fills: readonly unknown[] }[]; nextCursor: number };
    assert.equal(tape.trades.length, 1);
    for (const hidden of ["maker-1", "maker-2", "group-1", id(1), id(2), "participantId", "consumedSourceKeys"]) {
      assert.equal(first.text.includes(hidden), false, hidden);
    }
    const next = await get(`/v1/market/books/${CLASS}/tape?after=${tape.nextCursor}&limit=1`);
    const page = next.body as { trades: readonly unknown[]; nextCursor: number };
    assert.equal(page.trades.length, 1);
    const rest = await get(`/v1/market/books/${CLASS}/tape?after=${page.nextCursor}`);
    assert.deepEqual((rest.body as { trades: readonly unknown[] }).trades, []);
    assert.equal((await get("/v1/market/books/unknown-class/tape")).status, 404);
  });
});

test("allocation evidence verifies independently against the served policy", async () => {
  await withMarket(async (get, store) => {
    registerAll(store);
    store.submitOrder(CLASS, order(1), NOW);
    store.submitOrder(CLASS, order(2, { side: "BID", timeInForce: "IOC" }), NOW);
    const { status, body } = await get(`/v1/market/allocations/${id(2)}`);
    assert.equal(status, 200);
    const { allocation, matchingPolicy } = body as { allocation: PackageAllocation; matchingPolicy: PackageMatchingPolicy };
    verifyPackageAllocation(packageMatchingPolicy(matchingPolicy), allocation);
    const tape = (await get(`/v1/market/books/${CLASS}/tape`)).body as { trades: readonly { allocationHash: string }[] };
    assert.ok(tape.trades.some((trade) => trade.allocationHash === toHex(packageAllocationHash(allocation))));
    assert.equal((await get(`/v1/market/allocations/${id(77)}`)).status, 404);
  });
});

test("writes, malformed requests, and unknown parameters are refused", async () => {
  await withMarket(async (get, store) => {
    registerAll(store);
    const post = await get(`/v1/market/books/${CLASS}`, { method: "POST" });
    assert.equal(post.status, 405);
    for (const path of [
      `/v1/market/books/${CLASS}?side=BID`,
      `/v1/market/books/${CLASS}/tape?limit=101`,
      `/v1/market/books/${CLASS}/tape?after=-1`,
      `/v1/market/books/${CLASS}/tape?after=1&after=2`,
      "/v1/market/books/bad%20id",
      "/v1/market/allocations/XYZ",
    ]) {
      assert.equal((await get(path)).status, 400, path);
    }
    assert.equal((await get("/v1/market/other")).status, 404);
    assert.equal((await get("/internal/healthz")).status, 418);
  });
});

test("requests are rate limited per client window", async () => {
  let now = 0;
  await withMarket(
    async (get, store) => {
      registerAll(store);
      assert.equal((await get(`/v1/market/books/${CLASS}`)).status, 200);
      assert.equal((await get(`/v1/market/books/${CLASS}`)).status, 200);
      assert.equal((await get(`/v1/market/books/${CLASS}`)).status, 429);
      now = 1_000;
      assert.equal((await get(`/v1/market/books/${CLASS}`)).status, 200);
    },
    { rateLimit: { windowMs: 1_000, maxRequests: 2 }, clockMs: () => now },
  );
});

test("the runtime is off by default and validates its configuration", () => {
  assert.equal(loadPublicMarketRuntime({}), undefined);
  assert.throws(() => loadPublicMarketRuntime({ NARYX_PUBLIC_MARKET_ENABLED: "yes" }), PublicMarketConfigError);
  assert.throws(() => loadPublicMarketRuntime({ NARYX_PUBLIC_MARKET_ENABLED: "true" }), /NARYX_EXCHANGE_DB is required/);
  assert.throws(
    () => loadPublicMarketRuntime({ NARYX_PUBLIC_MARKET_ENABLED: "true", NARYX_EXCHANGE_DB: "relative.db" }),
    /absolute path/,
  );
  const dir = mkdtempSync(join(tmpdir(), "naryx-market-config-"));
  try {
    const manifest = join(dir, "support.json");
    const env = { NARYX_PUBLIC_MARKET_ENABLED: "true", NARYX_EXCHANGE_DB: join(dir, "exchange.sqlite"), NARYX_EXCHANGE_SUPPORT_MANIFEST: manifest };
    writeFileSync(manifest, JSON.stringify({ version: 1, clockUnit: "SOLANA_SLOT", seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT }));
    assert.throws(() => loadPublicMarketRuntime(env), /slot source/);
    writeFileSync(manifest, JSON.stringify({ version: 1, clockUnit: "UNIX_SECONDS", seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT, extra: true }));
    assert.throws(() => loadPublicMarketRuntime(env), /exactly clockUnit/);
    writeFileSync(manifest, JSON.stringify({ version: 1, clockUnit: "UNIX_SECONDS", seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT }));
    assert.throws(() => loadPublicMarketRuntime({ ...env, NARYX_PUBLIC_MARKET_REQUESTS_PER_MINUTE: "0" }), /between 1 and 10000/);
    const runtime = loadPublicMarketRuntime(env);
    assert.ok(runtime);
    assert.equal(runtime.clockUnit, "UNIX_SECONDS");
    assert.equal(runtime.requestsPerMinute, 120);
    runtime.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the private terminal server answers public market routes before its origin policy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-market-mount-"));
  const manifest = join(dir, "support.json");
  writeFileSync(manifest, JSON.stringify({ version: 1, clockUnit: "UNIX_SECONDS", seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT }));
  const runtime = loadPublicMarketRuntime({
    NARYX_PUBLIC_MARKET_ENABLED: "true",
    NARYX_EXCHANGE_DB: join(dir, "exchange.sqlite"),
    NARYX_EXCHANGE_SUPPORT_MANIFEST: manifest,
  });
  assert.ok(runtime);
  const server = createPrivateTerminalServer(
    { host: "127.0.0.1", port: 0, terminalOrigin: null },
    {}, undefined, undefined, {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, runtime.handler,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const book = await fetch(`http://127.0.0.1:${port}/v1/market/books/${CLASS}`, { headers: { Origin: "https://reader.example" } });
    assert.equal(book.status, 404);
    assert.equal(book.headers.get("access-control-allow-origin"), "*");
    const privateRoute = await fetch(`http://127.0.0.1:${port}/internal/healthz`, { headers: { Origin: "https://reader.example" } });
    assert.equal(privateRoute.status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/internal/healthz`)).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
