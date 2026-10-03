"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CHART_INTERVAL_SETTING,
  CHART_INTERVALS,
  CHART_SERIES,
  CHART_SERIES_SETTING,
  type Candle,
  type ChartInterval,
  type ChartSeriesKey,
  type MarketFeed,
  type SeriesMeta,
} from "./market-feed";
import { usePersistedSetting } from "./persisted-setting";
import type { PublicFeedStatus } from "./public-market-feed";
import { DOMAIN_META } from "./shell/terminal-context";
import type { DomainId } from "./terminal-view-model";

/** The service records a sample every 15 seconds; reading as often keeps the last candle current. */
const POLL_MS = 15_000;
const LIMIT = 300;
/** A newest sample older than this means the lane's source is not fresh, so nothing is being recorded. */
const STALE_AFTER_MS = 90_000;
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

type Leg = "spot" | "perp";

interface ReferenceSeries {
  readonly candles: readonly Candle[];
  readonly sources: readonly { readonly leg: Leg; readonly label: string }[];
  readonly market: { readonly base: string; readonly quote: string } | null;
  readonly methodology: string;
  readonly latestObservedAtMs: number | null;
}

interface ReferenceState {
  readonly domain: DomainId;
  readonly data: ReadonlyMap<string, ReferenceSeries>;
  readonly failure: { readonly message: string; readonly permanent: boolean } | null;
  readonly updatedAtMs: number | null;
}

class ReferenceUnavailable extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimal(value: unknown, context: string): number {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${context} is not a decimal`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${context} is out of range`);
  return parsed;
}

/** Strictly checks one response: it must answer exactly the request, in strictly ascending buckets. */
function parseSeries(body: unknown, domain: DomainId, series: ChartSeriesKey, interval: ChartInterval, seconds: number): ReferenceSeries {
  if (!isRecord(body) || body.version !== 1 || body.domain !== domain || body.series !== series ||
      body.interval !== interval || body.intervalSeconds !== seconds || typeof body.methodology !== "string" ||
      !Array.isArray(body.candles) || !Array.isArray(body.sources)) {
    throw new Error("reference candles are malformed");
  }
  let previous = -Infinity;
  const candles = body.candles.map((entry: unknown, index): Candle => {
    if (!isRecord(entry) || typeof entry.time !== "number" || !Number.isSafeInteger(entry.time) ||
        entry.time % seconds !== 0 || entry.time <= previous) {
      throw new Error(`candle ${index} is out of order`);
    }
    previous = entry.time;
    const open = decimal(entry.open, `candle ${index} open`);
    const high = decimal(entry.high, `candle ${index} high`);
    const low = decimal(entry.low, `candle ${index} low`);
    const close = decimal(entry.close, `candle ${index} close`);
    if (high < Math.max(open, close) || low > Math.min(open, close)) throw new Error(`candle ${index} is inconsistent`);
    return { time: entry.time, open, high, low, close, volume: 0 };
  });
  const sources = body.sources.map((entry: unknown) => {
    if (!isRecord(entry) || (entry.leg !== "spot" && entry.leg !== "perp") || typeof entry.label !== "string") {
      throw new Error("reference source is malformed");
    }
    return { leg: entry.leg as Leg, label: entry.label };
  });
  const market = body.market;
  if (market !== null && (!isRecord(market) || typeof market.base !== "string" || typeof market.quote !== "string")) {
    throw new Error("reference market is malformed");
  }
  const latest = body.latestObservedAtMs;
  if (latest !== null && (typeof latest !== "number" || !Number.isSafeInteger(latest))) {
    throw new Error("reference latest observation is malformed");
  }
  return {
    candles,
    sources,
    market: market === null ? null : { base: market.base as string, quote: market.quote as string },
    methodology: body.methodology,
    latestObservedAtMs: latest,
  };
}

function utcTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function pricePrecision(value: number | undefined): number {
  if (value === undefined || value >= 1_000) return 2;
  if (value >= 10) return 3;
  return value >= 1 ? 4 : 6;
}

/**
 * The private API's reference history for the selected lane: candles built by the service from
 * samples of the lane's live spot and perp references, labelled REFERENCE with each leg's source and
 * the sampling methodology. It reads the chart's selected series and interval plus the hourly and
 * one-minute basis the instrument bar and payoff view use. Empty buckets stay empty, and it has no
 * package depth or tape. Without a private API it is null.
 */
export function useReferenceMarketFeed(
  baseUrl: string | null,
  domain: DomainId,
  fallbackMarket: { readonly base: string; readonly quote: string },
): { readonly feed: MarketFeed | null; readonly status: PublicFeedStatus | null } {
  const [chartInterval] = usePersistedSetting<ChartInterval>(
    CHART_INTERVAL_SETTING.key,
    CHART_INTERVAL_SETTING.fallback,
    CHART_INTERVALS.map((entry) => entry.id),
  );
  const [chartSeries] = usePersistedSetting<ChartSeriesKey>(CHART_SERIES_SETTING.key, CHART_SERIES_SETTING.fallback, CHART_SERIES);
  const wanted = [...new Set([`${chartSeries}:${chartInterval}`, "basis:1h", "basis:1m"])].sort().join(",");
  const [state, setState] = useState<ReferenceState | null>(null);

  useEffect(() => {
    if (baseUrl === null) return;
    const base = baseUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requests = wanted.split(",").map((key) => {
      const [series, interval] = key.split(":") as [ChartSeriesKey, ChartInterval];
      return { key, series, interval, seconds: CHART_INTERVALS.find((entry) => entry.id === interval)?.seconds ?? 60 };
    });
    const poll = async () => {
      let permanent = false;
      try {
        const results = await Promise.all(requests.map(async ({ key, series, interval, seconds }) => {
          const query = new URLSearchParams({ domain, series, interval, limit: String(LIMIT) });
          const response = await fetch(`${base}/internal/terminal/reference-candles?${query}`, {
            method: "GET",
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: controller.signal,
          });
          if (response.status === 404) throw new ReferenceUnavailable("this service does not record reference history");
          if (!response.ok) throw new Error(`reference candles answered ${response.status}`);
          return [key, parseSeries(await response.json() as unknown, domain, series, interval, seconds)] as const;
        }));
        const updatedAtMs = Date.now();
        setState((previous) => ({
          domain,
          data: new Map([...(previous?.domain === domain ? previous.data : []), ...results]),
          failure: null,
          updatedAtMs,
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        permanent = error instanceof ReferenceUnavailable;
        const message = error instanceof Error ? error.message : "request failed";
        setState((previous) => previous?.domain === domain
          ? { ...previous, failure: { message, permanent } }
          : { domain, data: new Map(), failure: { message, permanent }, updatedAtMs: null });
      }
      if (!controller.signal.aborted && !permanent) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [baseUrl, domain, wanted]);

  const current = state !== null && state.domain === domain ? state : null;
  const status = useMemo<PublicFeedStatus | null>(() => {
    if (baseUrl === null) return null;
    if (current === null) return { state: "connecting", detail: "Loading reference history from the private terminal API." };
    const latest = [...current.data.values()].reduce<number | null>(
      (newest, entry) => entry.latestObservedAtMs === null ? newest : Math.max(newest ?? 0, entry.latestObservedAtMs),
      null,
    );
    const updated = current.updatedAtMs === null ? {} : { updatedAtMs: current.updatedAtMs };
    if (current.failure !== null) {
      return current.failure.permanent || current.data.size === 0
        ? { state: "unavailable", detail: `Reference history unavailable (${current.failure.message}); no market data is shown.` }
        : { state: "stale", detail: `Last update failed (${current.failure.message}); showing the last reference history.`, ...updated };
    }
    if (latest === null) return { state: "unavailable", detail: "No reference sample has been recorded for this lane yet.", ...updated };
    if (current.updatedAtMs !== null && current.updatedAtMs - latest > STALE_AFTER_MS) {
      return { state: "stale", detail: `Newest reference sample ${utcTime(latest)}; the lane's market source is not fresh, so nothing is being recorded.`, ...updated };
    }
    return { state: "live", detail: `Reference history from the private terminal API, newest sample ${utcTime(latest)}.`, ...updated };
  }, [baseUrl, current]);

  const feed = useMemo<MarketFeed | null>(() => {
    if (baseUrl === null || status === null) return null;
    const entries = current === null ? [] : [...current.data.entries()];
    const market = entries.find(([, entry]) => entry.market !== null)?.[1].market ?? fallbackMarket;
    const sources = new Map<string, Leg>();
    for (const [, entry] of entries) for (const source of entry.sources) sources.set(`${source.leg}:${source.label}`, source.leg);
    const methodology = entries[0]?.[1].methodology;
    const network = DOMAIN_META[domain].network;
    const sourceNote = methodology === undefined
      ? `${network} reference history. ${status.detail}`
      : [
        `${network} reference history.`,
        ...[...sources.keys()].map((key) => `${key.startsWith("spot:") ? "Spot" : "Perp"}: ${key.slice(5)}.`),
        methodology,
      ].join(" ");
    const empty = {
      title: "No reference samples in this window",
      detail: status.state === "connecting" || status.state === "unavailable"
        ? status.detail
        : "The service records a sample every 15 seconds while this lane's market source is fresh; none landed in this window.",
    };
    const lastClose = (series: ChartSeriesKey) =>
      entries.find(([key, entry]) => key.startsWith(`${series}:`) && entry.candles.length > 0)?.[1].candles.at(-1)?.close;
    return {
      label: "REFERENCE",
      sourceNote,
      candles: (series, interval) => current?.data.get(`${series}:${interval}`)?.candles ?? [],
      depth: () => ({ bids: [], asks: [], tick: 1 }),
      tape: () => [],
      seriesMeta(series): SeriesMeta {
        if (series === "basis") return { title: `${market.base} perp minus spot basis`, unit: "bps", precision: 2, volume: false, empty };
        return {
          title: `${market.base} ${series === "spot" ? "spot" : "perpetual"} reference`,
          unit: market.quote,
          precision: pricePrecision(lastClose(series)),
          volume: false,
          empty,
        };
      },
    };
  }, [baseUrl, current, domain, fallbackMarket, status]);

  return { feed, status };
}
