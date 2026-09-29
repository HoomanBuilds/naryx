"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CHART_INTERVALS,
  type Candle,
  type ChartInterval,
  type ChartSeriesKey,
  type DepthLevel,
  type MarketFeed,
  type TapeTrade,
} from "./market-feed";

const POLL_MS = 3_000;
const TAPE_PAGE = 100;
/** How many tape pages a first load reads; older trades are left to the candles endpoint. */
const INITIAL_TAPE_PAGES = 20;
const MAX_TRADES = 5_000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Decodes the public API's protocol JSON: exact integers arrive tagged as `bigint` and byte
 * strings as `bytes`. Integers are kept exact until the one place they are shown.
 */
function decode(value: Json): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    const tag = value.$naryxType;
    if (tag === "bigint" && typeof value.value === "string") return BigInt(value.value);
    if (tag === "bytes" && typeof value.value === "string") return value.value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]));
  }
  return value;
}

class PublicApiError extends Error {}

async function read(baseUrl: string, path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: "application/json" }, signal, cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new PublicApiError(`${path} answered ${response.status}`);
  const body = decode(JSON.parse(text) as Json);
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new PublicApiError(`${path} is not an object`);
  return body as Record<string, unknown>;
}

function exact(value: unknown, context: string): bigint {
  if (typeof value !== "bigint") throw new PublicApiError(`${context} is not an exact integer`);
  return value;
}

function levels(value: unknown, context: string): DepthLevel[] {
  if (!Array.isArray(value)) throw new PublicApiError(`${context} is not a list`);
  return value.map((entry, index) => {
    const level = entry as Record<string, unknown>;
    return {
      price: Number(exact(level.priceTicks, `${context}[${index}].priceTicks`)),
      direct: Number(exact(level.directQuantity, `${context}[${index}].directQuantity`)),
      implied: Number(exact(level.impliedQuantity, `${context}[${index}].impliedQuantity`)),
    };
  });
}

interface TapePage {
  readonly trades: TapeTrade[];
  readonly nextCursor: number;
}

function tapePage(body: Record<string, unknown>, after: number): TapePage {
  if (!Array.isArray(body.trades) || typeof body.nextCursor !== "number") throw new PublicApiError("tape is malformed");
  let previous = after;
  const trades: TapeTrade[] = [];
  for (const entry of body.trades as Record<string, unknown>[]) {
    const cursor = entry.cursor;
    // Cursors must strictly advance; a server that repeats or reorders trades is not trusted.
    if (typeof cursor !== "number" || cursor <= previous) throw new PublicApiError("tape cursors do not advance");
    previous = cursor;
    const side = entry.takerSide;
    if (side !== "BID" && side !== "ASK") throw new PublicApiError("trade side is malformed");
    const recordedAtMs = entry.recordedAtMs;
    if (typeof recordedAtMs !== "number" || !Array.isArray(entry.fills)) throw new PublicApiError("trade is malformed");
    for (const fill of entry.fills as Record<string, unknown>[]) {
      trades.push({
        id: `${String(entry.allocationHash)}:${String(fill.fillSequence)}`,
        time: Math.floor(recordedAtMs / 1_000),
        price: Number(exact(fill.priceTicks, "fill.priceTicks")),
        size: Number(exact(fill.quantity, "fill.quantity")),
        side,
        source: fill.makerSource === "IMPLIED" ? "IMPLIED" : "DIRECT",
      });
    }
  }
  if (body.nextCursor !== previous) throw new PublicApiError("tape cursor does not follow its last trade");
  return { trades, nextCursor: previous };
}

/** Candles rebuilt from observed trades, one bucket per interval; empty buckets stay empty. */
function candlesFromTrades(trades: readonly TapeTrade[], seconds: number): Candle[] {
  const buckets = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();
  for (const trade of trades) {
    const time = Math.floor(trade.time / seconds) * seconds;
    const bucket = buckets.get(time);
    if (bucket === undefined) {
      buckets.set(time, { open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: trade.size });
    } else {
      bucket.high = Math.max(bucket.high, trade.price);
      bucket.low = Math.min(bucket.low, trade.price);
      bucket.close = trade.price;
      bucket.volume += trade.size;
    }
  }
  return [...buckets.entries()].sort(([left], [right]) => left - right).map(([time, bucket]) => ({ time, ...bucket }));
}

export interface PublicFeedStatus {
  readonly state: "connecting" | "live" | "stale" | "unavailable";
  readonly detail: string;
  readonly updatedAtMs?: number;
}

interface LiveState {
  readonly bids: DepthLevel[];
  readonly asks: DepthLevel[];
  readonly trades: TapeTrade[];
  readonly cursor: number;
  readonly halted: boolean;
  readonly version: number;
}

/**
 * The terminal's market data from the public v1 API: executable package depth and the observed
 * package tape, polled every few seconds. Candles are rebuilt from the observed trades, so the
 * chart shows only what traded. Until the first successful read, and whenever the API has never
 * answered, the fixture feed stays in place under its FIXTURE label; after a failed poll the last
 * observed data stays on screen and the status says it is stale.
 */
export function usePublicMarketFeed(
  baseUrl: string | null,
  packageMarketId: string | null,
  fallback: MarketFeed,
): { readonly feed: MarketFeed; readonly status: PublicFeedStatus | null } {
  const configured = baseUrl !== null && packageMarketId !== null;
  const [live, setLive] = useState<LiveState | null>(null);
  const [status, setStatus] = useState<PublicFeedStatus>({ state: "connecting", detail: "Connecting to the public market API." });

  useEffect(() => {
    if (baseUrl === null || packageMarketId === null) return;
    const base = baseUrl.replace(/\/+$/, "");
    const market = encodeURIComponent(packageMarketId);
    const controller = new AbortController();
    let cursor = 0;
    let trades: TapeTrade[] = [];
    let first = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const depth = await read(base, `/v1/markets/${market}/package-depth`, controller.signal);
        if (depth.packageMarketId !== packageMarketId) throw new PublicApiError("depth is for another market");
        const pages = first ? INITIAL_TAPE_PAGES : 5;
        for (let page = 0; page < pages; page += 1) {
          const body = await read(base, `/v1/markets/${market}/package-tape?after=${cursor}&limit=${TAPE_PAGE}`, controller.signal);
          const next = tapePage(body, cursor);
          trades = [...trades, ...next.trades].slice(-MAX_TRADES);
          cursor = next.nextCursor;
          if (next.trades.length === 0 || (body.trades as unknown[]).length < TAPE_PAGE) break;
        }
        first = false;
        setLive((previous) => ({
          bids: levels(depth.bids, "bids"),
          asks: levels(depth.asks, "asks"),
          trades,
          cursor,
          halted: depth.halted === true,
          version: (previous?.version ?? 0) + 1,
        }));
        setStatus({ state: "live", detail: depth.halted === true ? "Market halted by the exchange." : "Live from the public market API.", updatedAtMs: Date.now() });
      } catch (error) {
        if (controller.signal.aborted) return;
        const detail = error instanceof Error ? error.message : "request failed";
        setStatus((previous) =>
          previous.state === "live" || previous.state === "stale"
            ? { state: "stale", detail: `Last update failed (${detail}); showing the last observed data.`, ...(previous.updatedAtMs === undefined ? {} : { updatedAtMs: previous.updatedAtMs }) }
            : { state: "unavailable", detail: `Public market API unavailable (${detail}); showing fixture data.` },
        );
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [baseUrl, packageMarketId]);

  const feed = useMemo<MarketFeed>(() => {
    if (!configured || live === null) return fallback;
    const candleCache = new Map<ChartInterval, Candle[]>();
    return {
      label: "OBSERVED",
      sourceNote: `Package ${packageMarketId}: executable depth and observed trades from the public market API.`,
      candles(series: ChartSeriesKey, interval: ChartInterval) {
        // Only the package price is published; leg prices are not public market data.
        if (series !== "basis") return [];
        const cached = candleCache.get(interval);
        if (cached !== undefined) return cached;
        const seconds = CHART_INTERVALS.find((entry) => entry.id === interval)?.seconds ?? 60;
        const built = candlesFromTrades(live.trades, seconds);
        candleCache.set(interval, built);
        return built;
      },
      depth() {
        return { bids: live.bids, asks: live.asks, tick: 1 };
      },
      tape() {
        return [...live.trades].reverse().slice(0, 200);
      },
      seriesMeta(series: ChartSeriesKey) {
        if (series === "basis") return { title: "Package price", unit: "ticks", precision: 0 };
        return { title: series === "spot" ? "Spot leg (not published)" : "Perp leg (not published)", unit: "ticks", precision: 0 };
      },
    };
  }, [configured, live, fallback, packageMarketId]);

  return { feed, status: configured ? status : null };
}
