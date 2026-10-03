import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TerminalMarketObservation, TerminalMarketSource } from "../src/private-terminal-manifest.js";
import {
  createReferenceCandleRoutes,
  parseReferenceCandleQuery,
  REFERENCE_RETENTION_MS,
  ReferenceHistoryRecorder,
  SqliteReferenceHistoryStore,
  type ReferenceLane,
} from "../src/reference-history.js";

// A minute boundary, in milliseconds.
const T0 = 1_790_000_040_000;
const SPOT_SOURCE = "Uniswap V3 pool 0x00000000000000000000000000000000000000aa slot0 mid, Base Sepolia";
const PERP_SOURCE = "Chainlink round read by Naryx test perp 0x00000000000000000000000000000000000000bb (oracle mid), Base Sepolia";

function temporaryStore(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "naryx-reference-history-"));
  return { path: join(directory, "reference-history.db"), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function observed(capturedAtMs: number, spot: readonly [string, string], perp: readonly [string, string]): TerminalMarketObservation {
  return { spotBid: spot[0], spotAsk: spot[1], perpBid: perp[0], perpAsk: perp[1], spotTakerRate: "0", perpTakerRate: "0", capturedAtMs };
}

function lane(latest: () => TerminalMarketObservation | undefined): ReferenceLane {
  const source = { descriptor: { maxStalenessMs: 30_000 }, latest } as unknown as TerminalMarketSource;
  return { domain: "base", source, spotSource: SPOT_SOURCE, perpSource: PERP_SOURCE };
}

test("reference candles hold only recorded fresh samples, keep gaps, and survive a restart", (t) => {
  const { path, cleanup } = temporaryStore();
  t.after(cleanup);
  let store = new SqliteReferenceHistoryStore(path);
  let now = T0;
  let current: TerminalMarketObservation | undefined;
  const recorder = new ReferenceHistoryRecorder(store, [lane(() => current)], { nowMs: () => now, report: () => undefined });
  const tick = (atMs: number, observation: TerminalMarketObservation | undefined) => {
    now = atMs;
    current = observation;
    return recorder.sampleOnce();
  };

  assert.equal(tick(T0, observed(T0, ["100", "100"], ["101", "101"])), 1);
  assert.equal(tick(T0 + 15_000, observed(T0 + 15_000, ["102", "102"], ["101.5", "101.5"])), 1);
  assert.equal(tick(T0 + 30_000, observed(T0 + 30_000, ["98.9", "99.1"], ["99.99", "100.01"])), 1);
  assert.equal(tick(T0 + 45_000, observed(T0 + 45_000, ["100.5", "100.5"], ["100.5", "100.5"])), 1);
  // The same observation again, then stale, unavailable, future-dated, and crossed: nothing is carried forward.
  assert.equal(tick(T0 + 60_000, observed(T0 + 45_000, ["100.5", "100.5"], ["100.5", "100.5"])), 0);
  assert.equal(tick(T0 + 76_000, observed(T0 + 45_000, ["100.5", "100.5"], ["100.5", "100.5"])), 0);
  assert.equal(tick(T0 + 90_000, undefined), 0);
  assert.equal(tick(T0 + 100_000, observed(T0 + 101_000, ["100", "100"], ["100", "100"])), 0);
  assert.equal(tick(T0 + 105_000, observed(T0 + 105_000, ["101", "100"], ["100", "100"])), 0);
  assert.equal(tick(T0 + 120_000, observed(T0 + 120_000, ["103", "103"], ["103", "103"])), 1);

  const read = () => ({
    spot: store.candles({ domain: "base", series: "spot", interval: "1m", limit: 3 }, T0 + 125_000),
    basis: store.candles({ domain: "base", series: "basis", interval: "1m", limit: 3 }, T0 + 125_000),
    other: store.candles({ domain: "solana", series: "spot", interval: "1m", limit: 3 }, T0 + 125_000),
  });
  const before = read();
  const minute = T0 / 1_000;
  assert.equal(before.spot.from, minute);
  assert.equal(before.spot.to, minute + 120);
  // Minute one recorded nothing, so it has no candle.
  assert.deepEqual(before.spot.candles, [
    { time: minute, open: "100", high: "102", low: "99", close: "100.5", samples: 4 },
    { time: minute + 120, open: "103", high: "103", low: "103", close: "103", samples: 1 },
  ]);
  assert.deepEqual(before.spot.sources, [{ leg: "spot", label: SPOT_SOURCE }]);
  assert.equal(before.spot.latestObservedAtMs, T0 + 120_000);
  // Basis truncates toward zero to 0.01 bps: (101.5 - 102) / 102 is -49.0196 bps.
  assert.deepEqual(before.basis.candles, [
    { time: minute, open: "100.00", high: "101.01", low: "-49.01", close: "0.00", samples: 4 },
    { time: minute + 120, open: "0.00", high: "0.00", low: "0.00", close: "0.00", samples: 1 },
  ]);
  assert.deepEqual(before.basis.sources, [{ leg: "spot", label: SPOT_SOURCE }, { leg: "perp", label: PERP_SOURCE }]);
  assert.deepEqual(before.other, { from: minute, to: minute + 120, sources: [], latestObservedAtMs: null, candles: [] });

  store.close();
  store = new SqliteReferenceHistoryStore(path);
  t.after(() => store.close());
  assert.deepEqual(read(), before);
});

test("the recorder prunes samples older than the retention bound", (t) => {
  const { path, cleanup } = temporaryStore();
  t.after(cleanup);
  const store = new SqliteReferenceHistoryStore(path);
  t.after(() => store.close());
  const sample = (observedAtMs: number) => ({
    domain: "base" as const, observedAtMs, spot: "100", perp: "100", basisHundredthsBps: 0, spotSource: SPOT_SOURCE, perpSource: PERP_SOURCE,
  });
  const now = T0 + REFERENCE_RETENTION_MS;
  assert.equal(store.record(sample(T0 - 1)), true);
  assert.equal(store.record(sample(T0)), true);
  assert.equal(store.record(sample(T0)), false);
  new ReferenceHistoryRecorder(store, [], { nowMs: () => now, report: () => undefined }).sampleOnce();
  const kept = store.candles({ domain: "base", series: "spot", interval: "1d", limit: 40 }, now);
  assert.deepEqual(kept.candles.map((candle) => candle.samples), [1]);
  assert.equal(kept.latestObservedAtMs, T0);
});

test("reference candle queries are validated strictly and served only on GET", async (t) => {
  assert.deepEqual(
    parseReferenceCandleQuery(new URLSearchParams("domain=hyperliquid&series=basis&interval=4h")),
    { domain: "hyperliquid", series: "basis", interval: "4h", limit: 300 },
  );
  assert.equal(parseReferenceCandleQuery(new URLSearchParams("interval=1d&limit=1000&series=perp&domain=solana")).limit, 1_000);
  for (const query of [
    "series=spot&interval=1m",
    "domain=ethereum&series=spot&interval=1m",
    "domain=base&series=mark&interval=1m",
    "domain=base&series=spot&interval=2m",
    "domain=base&series=spot&interval=toString",
    "domain=base&series=spot&interval=1m&limit=0",
    "domain=base&series=spot&interval=1m&limit=1001",
    "domain=base&series=spot&interval=1m&limit=010",
    "domain=base&series=spot&interval=1m&limit=1.5",
    "domain=base&domain=base&series=spot&interval=1m",
    "domain=base&series=spot&interval=1m&owner=x",
  ]) {
    assert.throws(() => parseReferenceCandleQuery(new URLSearchParams(query)), { code: "INVALID_QUERY" }, query);
  }

  const handler = createReferenceCandleRoutes({
    store: { candles: () => ({ from: 0, to: 60, sources: [], latestObservedAtMs: null, candles: [] }) },
    nowMs: () => T0,
  });
  const server = createServer((request, response) => {
    if (!handler(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = "/internal/terminal/reference-candles";
  const ok = await fetch(`${origin}${path}?domain=base&series=spot&interval=15m&limit=2`);
  assert.equal(ok.status, 200);
  const body = await ok.json() as Record<string, unknown>;
  assert.equal(body.intervalSeconds, 900);
  assert.equal(body.market, null);
  assert.equal(body.sampleIntervalSeconds, 15);
  assert.equal(typeof body.methodology, "string");
  assert.deepEqual(body.candles, []);
  assert.equal((await fetch(`${origin}${path}?domain=base&series=spot`)).status, 400);
  assert.equal((await fetch(`${origin}${path}?domain=base&series=spot&interval=1m`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${origin}/internal/terminal/reference-candle`)).status, 404);
});

test("candle limits share one read per lane, series, and interval, each response clipped to its window", async (t) => {
  const reads: number[] = [];
  const candle = (time: number) => ({ time, open: "1", high: "1", low: "1", close: "1", samples: 1 });
  const handler = createReferenceCandleRoutes({
    store: {
      candles: (query) => {
        reads.push(query.limit);
        return { from: 3_600 - 999 * 3_600, to: 3_600 * 10, sources: [], latestObservedAtMs: null, candles: [candle(3_600 * 8), candle(3_600 * 9), candle(3_600 * 10)] };
      },
    },
    nowMs: () => T0,
  });
  const server = createServer((request, response) => {
    if (!handler(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (limit: number) =>
    await (await fetch(`${origin}/internal/terminal/reference-candles?domain=base&series=basis&interval=1h&limit=${limit}`)).json() as
      { from: number; candles: { time: number }[] };
  const two = await get(2);
  const all = await get(300);
  // Varying the limit does not force another scan; the one read used the largest limit.
  assert.deepEqual(reads, [1_000]);
  assert.equal(two.from, 3_600 * 9);
  assert.deepEqual(two.candles.map((entry) => entry.time), [3_600 * 9, 3_600 * 10]);
  assert.equal(all.candles.length, 3);
});
