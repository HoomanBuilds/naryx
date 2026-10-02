"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CHART_INTERVALS,
  type Candle,
  type ChartInterval,
  type ChartSeriesKey,
  type DepthLevel,
  type MarketFeed,
  type SeriesMeta,
  type TapeTrade,
} from "./market-feed";

const POLL_MS = 3_000;
/** While the stream is up, a full read every half minute still catches anything a push missed. */
const STREAM_RESYNC_MS = 30_000;
const STREAM_RETRY_MIN_MS = 2_000;
const STREAM_RETRY_MAX_MS = 30_000;
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

const BOOK_UNIT = { unit: "ticks", precision: 0 } as const;
const PACKAGE_PRICE: SeriesMeta = {
  title: "Package price",
  unit: "ticks",
  precision: 0,
  empty: { title: "No trades in this window", detail: "Candles appear as soon as the package book records a trade." },
};

function unpublishedLeg(series: ChartSeriesKey): SeriesMeta {
  return {
    title: series === "spot" ? "Spot leg (not published)" : "Perp leg (not published)",
    unit: "ticks",
    precision: 0,
    empty: { title: "Leg prices are not published", detail: "The public market API publishes the package price only." },
  };
}

/**
 * The terminal's market data from the public v1 API: executable package depth and the observed
 * package tape, read in full first and then pushed over the API's WebSocket stream, with polling
 * every few seconds whenever the stream is down. Package price candles are rebuilt from the observed
 * trades, so they show only what traded. The spot and perp series, and the basis series until the
 * book records its first trade, come from `reference` under its own label; without one they stay
 * empty. A configured market never shows `fallback`; after a failed poll the last observed data
 * stays on screen and the status says it is stale.
 */
export function usePublicMarketFeed(
  baseUrl: string | null,
  packageMarketId: string | null,
  fallback: MarketFeed,
  reference: MarketFeed | null,
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
    let bids: DepthLevel[] = [];
    let asks: DepthLevel[] = [];
    let halted = false;
    let first = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;
    let streaming = false;
    let reconnectDelayMs = STREAM_RETRY_MIN_MS;

    const publish = (detail: string) => {
      const observed = { bids, asks, trades, cursor, halted };
      setLive((previous) => ({ ...observed, version: (previous?.version ?? 0) + 1 }));
      setStatus({ state: "live", detail: halted ? "Market halted by the exchange." : detail, updatedAtMs: Date.now() });
    };
    const markStale = (error: unknown) => {
      const detail = error instanceof Error ? error.message : "request failed";
      setStatus((previous) =>
        previous.state === "live" || previous.state === "stale"
          ? { state: "stale", detail: `Last update failed (${detail}); showing the last observed data.`, ...(previous.updatedAtMs === undefined ? {} : { updatedAtMs: previous.updatedAtMs }) }
          : { state: "unavailable", detail: `Public market API unavailable (${detail}); no market data is shown.` },
      );
    };
    const schedule = (delayMs: number) => {
      if (timer !== undefined) clearTimeout(timer);
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), delayMs);
    };

    // After the first full read, the stream pushes depth changes and new trades; polling resumes
    // only while the stream is down, and a slow resync keeps even a quiet stream honest.
    const openStream = () => {
      if (controller.signal.aborted || typeof WebSocket === "undefined" || socket !== undefined) return;
      let url: string;
      try {
        const parsed = new URL(`${base}/v1/stream`);
        parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
        url = parsed.toString();
      } catch {
        return;
      }
      const opened = new WebSocket(url);
      socket = opened;
      opened.addEventListener("open", () => {
        opened.send(JSON.stringify({ op: "subscribe", channel: "package-depth", packageMarketId }));
        opened.send(JSON.stringify({ op: "subscribe", channel: "package-tape", packageMarketId, after: cursor }));
      });
      opened.addEventListener("message", (event) => {
        try {
          const message = decode(JSON.parse(String(event.data)) as Json) as Record<string, unknown>;
          if (message.type === "subscribed" && message.channel === "package-tape") {
            streaming = true;
            reconnectDelayMs = STREAM_RETRY_MIN_MS;
            schedule(STREAM_RESYNC_MS);
            publish("Streaming from the public market API.");
            return;
          }
          if (message.packageMarketId !== packageMarketId) return;
          if (message.type === "package-depth") {
            const nextBids = levels(message.bids, "bids");
            const nextAsks = levels(message.asks, "asks");
            bids = nextBids;
            asks = nextAsks;
            halted = message.halted === true;
            publish("Streaming from the public market API.");
          } else if (message.type === "package-tape") {
            const next = tapePage(message, cursor);
            trades = [...trades, ...next.trades].slice(-MAX_TRADES);
            cursor = next.nextCursor;
            publish("Streaming from the public market API.");
          } else if (message.type === "error") {
            throw new PublicApiError(`stream refused: ${String(message.code)}`);
          }
        } catch (error) {
          // A malformed push ends the stream; polling takes over from the last good state.
          markStale(error);
          opened.close();
        }
      });
      opened.addEventListener("close", () => {
        if (socket === opened) socket = undefined;
        const wasStreaming = streaming;
        streaming = false;
        if (controller.signal.aborted) return;
        schedule(wasStreaming ? 0 : POLL_MS);
        setTimeout(openStream, reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, STREAM_RETRY_MAX_MS);
      });
    };

    const poll = async () => {
      try {
        const depth = await read(base, `/v1/markets/${market}/package-depth`, controller.signal);
        if (depth.packageMarketId !== packageMarketId) throw new PublicApiError("depth is for another market");
        // Parse everything before touching state: a malformed response marks the feed stale here,
        // never throws inside a state updater during render.
        const nextBids = levels(depth.bids, "bids");
        const nextAsks = levels(depth.asks, "asks");
        // While the stream is up it owns the tape cursor, so a resync reads depth only.
        const pages = streaming ? 0 : first ? INITIAL_TAPE_PAGES : 5;
        const startCursor = cursor;
        let nextTrades = trades;
        let nextCursor = cursor;
        for (let page = 0; page < pages; page += 1) {
          const body = await read(base, `/v1/markets/${market}/package-tape?after=${nextCursor}&limit=${TAPE_PAGE}`, controller.signal);
          const next = tapePage(body, nextCursor);
          nextTrades = [...nextTrades, ...next.trades].slice(-MAX_TRADES);
          nextCursor = next.nextCursor;
          if (next.trades.length === 0 || (body.trades as unknown[]).length < TAPE_PAGE) break;
        }
        bids = nextBids;
        asks = nextAsks;
        halted = depth.halted === true;
        // A stream push that advanced the tape during this read wins over the read.
        if (cursor === startCursor) {
          trades = nextTrades;
          cursor = nextCursor;
        }
        first = false;
        publish(streaming ? "Streaming from the public market API." : "Live from the public market API.");
        openStream();
      } catch (error) {
        if (controller.signal.aborted) return;
        markStale(error);
      }
      schedule(streaming ? STREAM_RESYNC_MS : POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      socket?.close();
      socket = undefined;
    };
  }, [baseUrl, packageMarketId]);

  const feed = useMemo<MarketFeed>(() => {
    if (!configured) return fallback;
    // Leg prices are not public market data; the reference history fills them under its own label,
    // and fills the basis series too until the package book has a trade.
    const traded = live !== null && live.trades.length > 0;
    const fromReference = (series: ChartSeriesKey) => reference !== null && (series !== "basis" || !traded);
    const referenceMeta = (series: ChartSeriesKey): SeriesMeta | undefined => reference === null
      ? undefined
      : { ...reference.seriesMeta(series), label: reference.label, note: reference.sourceNote };
    const referenceNote = reference === null
      ? ""
      : ` Spot and perp series${traded ? "" : ", and basis until the first package trade,"} are ${reference.label} data. ${reference.sourceNote}`;
    // A configured market never shows fixture data: until the API answers, the book is empty.
    if (live === null) {
      return {
        label: "OBSERVED",
        sourceNote: `Package ${packageMarketId}: waiting for the public market API.${referenceNote}`,
        book: BOOK_UNIT,
        candles: (series: ChartSeriesKey, interval: ChartInterval) => reference?.candles(series, interval) ?? [],
        depth: () => ({ bids: [], asks: [], tick: 1 }),
        tape: () => [],
        seriesMeta: (series: ChartSeriesKey) => referenceMeta(series) ?? (series === "basis" ? PACKAGE_PRICE : unpublishedLeg(series)),
      };
    }
    const candleCache = new Map<ChartInterval, Candle[]>();
    return {
      label: "OBSERVED",
      sourceNote: `Package ${packageMarketId}: executable depth and observed trades from the public market API.${referenceNote}`,
      book: BOOK_UNIT,
      candles(series: ChartSeriesKey, interval: ChartInterval) {
        if (fromReference(series)) return reference?.candles(series, interval) ?? [];
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
        if (fromReference(series)) return referenceMeta(series) ?? PACKAGE_PRICE;
        return series === "basis" ? PACKAGE_PRICE : unpublishedLeg(series);
      },
    };
  }, [configured, live, fallback, packageMarketId, reference]);

  return { feed, status: configured ? status : null };
}
