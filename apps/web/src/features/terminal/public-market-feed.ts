"use client";

import { useEffect, useMemo, useState } from "react";
import bs58 from "bs58";
import {
  NaryxApiError,
  NaryxClient,
  NaryxEvidenceError,
  settlementPremiumSurface,
  type SettlementPremiumSurface,
  type VerifiedMarketCatalogue,
} from "@naryx/sdk";
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
const MARKET_POLL_MS = 15_000;
/** The server caches its catalogue for about a minute; a book it has not listed yet triggers an earlier read. */
const CATALOGUE_REFRESH_MS = 60_000;

function catalogueTrust(): { readonly authorities: ReadonlyMap<string, Uint8Array> | null; readonly error: string | null } {
  const authority = process.env.NEXT_PUBLIC_NARYX_CATALOGUE_AUTHORITY?.trim() ?? "";
  const encodedKey = process.env.NEXT_PUBLIC_NARYX_CATALOGUE_PUBLIC_KEY?.trim() ?? "";
  if (authority.length === 0 && encodedKey.length === 0) {
    return { authorities: null, error: "Catalogue trust is not configured; markets show without series metadata." };
  }
  if (authority.length === 0 || encodedKey.length === 0) {
    return { authorities: null, error: "Catalogue trust configuration is incomplete; markets show without series metadata." };
  }
  try {
    const publicKey = bs58.decode(encodedKey);
    if (publicKey.length !== 32) throw new Error("the public key is not 32 bytes");
    return { authorities: new Map([[authority, publicKey]]), error: null };
  } catch {
    return { authorities: null, error: "Catalogue trust configuration is malformed; markets show without series metadata." };
  }
}

const CATALOGUE_TRUST = catalogueTrust();

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

class PublicApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

async function read(baseUrl: string, path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: "application/json" }, signal, cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new PublicApiError(`${path} answered ${response.status}`, response.status);
  const body = decode(JSON.parse(text) as Json);
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new PublicApiError(`${path} is not an object`);
  return body as Record<string, unknown>;
}

export interface PublicPackageMarket {
  readonly packageMarketId: string;
  readonly seriesId: string | null;
  readonly templateId: string | null;
  readonly underlyingRefs: readonly string[];
  readonly quoteAsset: string | null;
  readonly settlementClass: string | null;
  readonly domainIds: readonly string[];
  readonly halted: boolean;
  readonly bestBidTicks: bigint | null;
  readonly bestAskTicks: bigint | null;
  readonly spreadTicks: bigint | null;
}

export interface PublicMarketCatalogueStatus {
  readonly state: "loading" | "live" | "stale" | "unavailable";
  readonly detail: string;
}

/** The catalogue only enriches listed books after its hash and pinned authority signature verify. */
export interface PublicCatalogueVerification {
  readonly state: "loading" | "verified" | "rejected" | "unavailable";
  readonly detail: string;
}

export interface PublicSizeQuote {
  readonly size: bigint;
  readonly averagePriceTicks: bigint;
  readonly fillableQuantity: bigint;
}

export interface PublicObservedTrade {
  readonly priceTicks: bigint;
  readonly quantity: bigint;
  readonly recordedAtMs: number;
}

export interface PublicPackageOpportunity {
  readonly packageMarketId: string;
  readonly seriesId: string | null;
  readonly bid: PublicSizeQuote | null;
  readonly ask: PublicSizeQuote | null;
  readonly spreadAtSizeTicks: bigint | null;
  readonly lastTrade: PublicObservedTrade | null;
}

export interface PublicSeriesCurvePoint {
  readonly executionClassId: string;
  readonly settlementClass: string;
  readonly domains: readonly string[];
  readonly open: boolean;
  readonly halted: boolean;
  readonly bids: readonly (PublicSizeQuote | null)[];
  readonly asks: readonly (PublicSizeQuote | null)[];
  readonly impliedBids: readonly (PublicSizeQuote | null)[];
  readonly impliedAsks: readonly (PublicSizeQuote | null)[];
  readonly lastTrade: PublicObservedTrade | null;
}

export interface PublicSeriesCurve {
  readonly seriesId: string;
  readonly quoteAsset: string;
  readonly quoteConvention: string;
  readonly methodologyVersion: number;
  readonly premiumSurface: SettlementPremiumSurface;
  readonly points: readonly PublicSeriesCurvePoint[];
}

function sameExact(left: unknown, right: unknown): boolean {
  if (typeof left !== typeof right) return false;
  if (left === null || right === null || typeof left !== "object") return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => sameExact(entry, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => (
    key === rightKeys[index] && sameExact(leftRecord[key], rightRecord[key])
  ));
}

function requiredText(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) throw new PublicApiError(`${context} is not a nonempty string`);
  return value;
}

function textList(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value)) throw new PublicApiError(`${context} is not a list`);
  const entries = value.map((entry, index) => requiredText(entry, `${context}[${index}]`));
  if (new Set(entries).size !== entries.length) throw new PublicApiError(`${context} contains duplicates`);
  return Object.freeze(entries);
}

/** Fills catalogue metadata into listed books; a listed book the catalogue omits keeps its live row unenriched. */
function enrichMarkets(markets: readonly PublicPackageMarket[], catalogue: VerifiedMarketCatalogue | null): readonly PublicPackageMarket[] {
  if (catalogue === null) return markets;
  const entries = new Map<string, VerifiedMarketCatalogue["catalogue"]["entries"][number]>(catalogue.catalogue.entries.map((entry) => [entry.packageMarketId, entry]));
  return Object.freeze(markets.map((market) => {
    const entry = entries.get(market.packageMarketId);
    if (entry === undefined) return market;
    // Halt state and prices stay from the live market list; the catalogue can lag it.
    return Object.freeze({
      ...market,
      seriesId: entry.seriesId,
      templateId: entry.templateId,
      underlyingRefs: Object.freeze([...entry.underlyingRefs]),
      quoteAsset: entry.quoteAsset,
      settlementClass: entry.settlementClass,
      domainIds: Object.freeze([...entry.domainIds]),
    });
  }));
}

function catalogueFailure(error: unknown): PublicCatalogueVerification {
  if (error instanceof NaryxApiError) {
    return error.status === 503 || error.status === 404
      ? { state: "unavailable", detail: "No catalogue authority is configured on this server, so markets show without series metadata." }
      : { state: "unavailable", detail: `Catalogue unavailable (${error.status} ${error.code}); markets show without series metadata.` };
  }
  if (error instanceof NaryxEvidenceError) {
    return { state: "rejected", detail: `Catalogue failed verification (${error.message}); markets show without series metadata.` };
  }
  return { state: "unavailable", detail: `Catalogue unavailable (${error instanceof Error ? error.message : "request failed"}); markets show without series metadata.` };
}

function openMarkets(body: Record<string, unknown>): readonly PublicPackageMarket[] {
  if (!Array.isArray(body.markets)) throw new PublicApiError("markets are malformed");
  const markets = body.markets.map((candidate, index): PublicPackageMarket => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new PublicApiError(`markets[${index}] is malformed`);
    }
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.halted !== "boolean") throw new PublicApiError(`markets[${index}].halted is malformed`);
    const optionalExact = (key: "bestBidTicks" | "bestAskTicks" | "spreadTicks") =>
      entry[key] === undefined ? null : exact(entry[key], `markets[${index}].${key}`);
    return Object.freeze({
      packageMarketId: requiredText(entry.packageMarketId, `markets[${index}].packageMarketId`),
      seriesId: null,
      templateId: null,
      underlyingRefs: Object.freeze([]),
      quoteAsset: null,
      settlementClass: null,
      domainIds: Object.freeze([]),
      halted: entry.halted,
      bestBidTicks: optionalExact("bestBidTicks"),
      bestAskTicks: optionalExact("bestAskTicks"),
      spreadTicks: optionalExact("spreadTicks"),
    });
  });
  if (new Set(markets.map((market) => market.packageMarketId)).size !== markets.length) {
    throw new PublicApiError("market list repeats a package market");
  }
  return Object.freeze(markets.sort((left, right) => left.packageMarketId.localeCompare(right.packageMarketId)));
}

/**
 * Discovers the exchange's package markets without sending a search query or trading intent. The
 * list is always the live /v1/markets answer; the verified catalogue only adds series metadata.
 */
export function usePublicPackageMarkets(baseUrl: string | null): {
  readonly markets: readonly PublicPackageMarket[];
  readonly status: PublicMarketCatalogueStatus | null;
  readonly catalogue: PublicCatalogueVerification | null;
} {
  const [markets, setMarkets] = useState<readonly PublicPackageMarket[]>([]);
  const [status, setStatus] = useState<PublicMarketCatalogueStatus>({ state: "loading", detail: "Loading package markets." });
  const [catalogueStatus, setCatalogueStatus] = useState<PublicCatalogueVerification>({ state: "loading", detail: "Reading the market catalogue." });

  useEffect(() => {
    if (baseUrl === null) return;
    const base = baseUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    let client: NaryxClient | null = null;
    try {
      client = new NaryxClient({ baseUrl: base });
    } catch {
      // The SDK refuses a non-HTTPS remote URL; the raw market list still loads without enrichment.
    }
    let catalogue: VerifiedMarketCatalogue | null = null;
    let verification: PublicCatalogueVerification = { state: "loading", detail: "Reading the market catalogue." };
    let catalogueReadAtMs: number | null = null;
    let uncoveredAtRead = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const uncovered = (summaries: readonly PublicPackageMarket[]) => {
      const covered = new Set<string>(catalogue?.catalogue.entries.map((entry) => entry.packageMarketId) ?? []);
      return summaries.flatMap((market) => covered.has(market.packageMarketId) ? [] : [market.packageMarketId]).join(",");
    };
    const refreshCatalogue = async (summaries: readonly PublicPackageMarket[]) => {
      const unexpired = catalogue !== null && catalogue.catalogue.expiresAtMs > BigInt(Date.now());
      const fresh = catalogueReadAtMs !== null && Date.now() - catalogueReadAtMs < CATALOGUE_REFRESH_MS && (catalogue === null || unexpired);
      if (fresh && uncovered(summaries) === uncoveredAtRead) return;
      if (CATALOGUE_TRUST.authorities === null) {
        catalogue = null;
        verification = { state: "unavailable", detail: CATALOGUE_TRUST.error ?? "Catalogue trust is unavailable; markets show without series metadata." };
      } else if (client === null) {
        catalogue = null;
        verification = { state: "unavailable", detail: "The SDK requires an HTTPS public API, so the catalogue cannot be verified and markets show without series metadata." };
      } else {
        try {
          const next = await client.getCatalogue({ trustedAuthorities: CATALOGUE_TRUST.authorities, environment: "testnet" });
          if (!next.signatureVerified) throw new NaryxEvidenceError("the catalogue authority is not trusted by this terminal");
          catalogue = next.current ? next : null;
          verification = next.current
            ? { state: "verified", detail: `Catalogue ${next.catalogueHash.slice(0, 12)} hash and authority signature verified in this browser.` }
            : { state: "rejected", detail: "The served catalogue has expired; markets show without series metadata." };
        } catch (error) {
          if (controller.signal.aborted) return;
          // A transient read failure keeps the last verified, unexpired catalogue; a failed check never does.
          if (!unexpired || error instanceof NaryxEvidenceError) {
            catalogue = null;
            verification = catalogueFailure(error);
          }
        }
      }
      catalogueReadAtMs = Date.now();
      uncoveredAtRead = uncovered(summaries);
    };

    const poll = async () => {
      try {
        const summaries = openMarkets(await read(base, "/v1/markets", controller.signal));
        await refreshCatalogue(summaries);
        if (controller.signal.aborted) return;
        const next = enrichMarkets(summaries, catalogue);
        setMarkets(next);
        setCatalogueStatus(verification);
        setStatus({
          state: "live",
          detail: `${next.length} package market${next.length === 1 ? "" : "s"} available.${verification.state === "verified" ? "" : ` ${verification.detail}`}`,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const detail = error instanceof Error ? error.message : "request failed";
        setStatus((current) => current.state === "live" || current.state === "stale"
          ? { state: "stale", detail: `Market refresh failed (${detail}); showing the last market list.` }
          : { state: "unavailable", detail: `Package markets unavailable (${detail}).` });
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), MARKET_POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [baseUrl]);

  return { markets, status: baseUrl === null ? null : status, catalogue: baseUrl === null ? null : catalogueStatus };
}

function executableQuote(value: unknown, size: bigint, context: string): PublicSizeQuote {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PublicApiError(`${context} is malformed`);
  const quote = value as Record<string, unknown>;
  if (quote.label !== "EXECUTABLE") throw new PublicApiError(`${context} is not executable`);
  const quoteSize = exact(quote.size, `${context}.size`);
  const fillableQuantity = exact(quote.fillableQuantity, `${context}.fillableQuantity`);
  const averagePriceTicks = exact(quote.averagePriceTicks, `${context}.averagePriceTicks`);
  if (quoteSize !== size || fillableQuantity !== size) throw new PublicApiError(`${context} cannot fill the requested size`);
  return Object.freeze({ size, averagePriceTicks, fillableQuantity });
}

function observedTrade(value: unknown, context: string): PublicObservedTrade {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PublicApiError(`${context} is malformed`);
  const trade = value as Record<string, unknown>;
  if (trade.label !== "OBSERVED") throw new PublicApiError(`${context} is not observed evidence`);
  const quantity = exact(trade.quantity, `${context}.quantity`);
  if (quantity <= BigInt(0) || typeof trade.recordedAtMs !== "number" || !Number.isSafeInteger(trade.recordedAtMs) || trade.recordedAtMs < 0) {
    throw new PublicApiError(`${context} is malformed`);
  }
  return Object.freeze({
    priceTicks: exact(trade.priceTicks, `${context}.priceTicks`),
    quantity,
    recordedAtMs: trade.recordedAtMs,
  });
}

function packageOpportunities(body: Record<string, unknown>, size: bigint): readonly PublicPackageOpportunity[] {
  if (body.label !== "EXECUTABLE" || exact(body.size, "opportunities.size") !== size) {
    throw new PublicApiError("opportunity feed is not executable at the requested size");
  }
  exact(body.asOfValue, "opportunities.asOfValue");
  if (!Array.isArray(body.opportunities)) throw new PublicApiError("opportunities are malformed");
  let previousSpread: bigint | null = null;
  let oneSidedStarted = false;
  const opportunities = body.opportunities.map((candidate, index): PublicPackageOpportunity => {
    const context = `opportunities[${index}]`;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new PublicApiError(`${context} is malformed`);
    const entry = candidate as Record<string, unknown>;
    const bid = entry.bid === undefined ? null : executableQuote(entry.bid, size, `${context}.bid`);
    const ask = entry.ask === undefined ? null : executableQuote(entry.ask, size, `${context}.ask`);
    if (bid === null && ask === null) throw new PublicApiError(`${context} has no executable side`);
    const expectedSpread = bid !== null && ask !== null ? ask.averagePriceTicks - bid.averagePriceTicks : null;
    const spread = entry.spreadAtSizeTicks === undefined ? null : exact(entry.spreadAtSizeTicks, `${context}.spreadAtSizeTicks`);
    if (spread !== expectedSpread) throw new PublicApiError(`${context} spread does not equal ask minus bid`);
    if (spread === null) oneSidedStarted = true;
    else if (oneSidedStarted || (previousSpread !== null && spread < previousSpread)) throw new PublicApiError("opportunities are not ordered by executable spread");
    if (spread !== null) previousSpread = spread;
    return Object.freeze({
      packageMarketId: requiredText(entry.packageMarketId, `${context}.packageMarketId`),
      seriesId: entry.seriesId === undefined ? null : requiredText(entry.seriesId, `${context}.seriesId`),
      bid,
      ask,
      spreadAtSizeTicks: spread,
      lastTrade: entry.lastTrade === undefined ? null : observedTrade(entry.lastTrade, `${context}.lastTrade`),
    });
  });
  if (new Set(opportunities.map((entry) => entry.packageMarketId)).size !== opportunities.length) {
    throw new PublicApiError("opportunity feed repeats a package market");
  }
  return Object.freeze(opportunities);
}

/** Finds books whose direct resting liquidity can fill the full requested package size. */
export function usePublicPackageOpportunities(baseUrl: string | null, size: bigint | null): {
  readonly opportunities: readonly PublicPackageOpportunity[];
  readonly status: PublicMarketCatalogueStatus | null;
} {
  const [opportunities, setOpportunities] = useState<readonly PublicPackageOpportunity[]>([]);
  const [status, setStatus] = useState<PublicMarketCatalogueStatus>({ state: "loading", detail: "Scanning executable depth." });
  const [resultSize, setResultSize] = useState<bigint | null>(null);

  useEffect(() => {
    if (baseUrl === null || size === null || size <= BigInt(0)) return;
    const base = baseUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = packageOpportunities(await read(base, `/v1/opportunities?size=${size.toString()}`, controller.signal), size);
        setOpportunities(next);
        setStatus({ state: "live", detail: `${next.length} market${next.length === 1 ? "" : "s"} can fill ${size.toString()} package unit${size === BigInt(1) ? "" : "s"}.` });
        setResultSize(size);
      } catch (error) {
        if (controller.signal.aborted) return;
        const detail = error instanceof Error ? error.message : "request failed";
        setStatus({ state: "unavailable", detail: `Opportunity scan failed (${detail}); any visible result is the last verified scan.` });
        setResultSize(size);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 10_000);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [baseUrl, size]);

  if (baseUrl === null || size === null) return { opportunities: Object.freeze([]), status: null };
  if (resultSize !== size) {
    return {
      opportunities: Object.freeze([]),
      status: { state: "loading", detail: `Scanning direct depth for ${size.toString()} package unit${size === BigInt(1) ? "" : "s"}.` },
    };
  }
  return { opportunities, status };
}

function curveQuotes(value: unknown, sizes: readonly bigint[], label: "EXECUTABLE" | "INDICATIVE", context: string): readonly (PublicSizeQuote | null)[] {
  if (!Array.isArray(value) || value.length !== sizes.length) throw new PublicApiError(`${context} does not answer every size`);
  return Object.freeze(value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new PublicApiError(`${context}[${index}] is malformed`);
    const quote = candidate as Record<string, unknown>;
    if (quote.label !== label || exact(quote.size, `${context}[${index}].size`) !== sizes[index]) {
      throw new PublicApiError(`${context}[${index}] has the wrong evidence label or size`);
    }
    const fillableQuantity = exact(quote.fillableQuantity, `${context}[${index}].fillableQuantity`);
    if (fillableQuantity > sizes[index]!) throw new PublicApiError(`${context}[${index}] overstates fillable depth`);
    if (quote.averagePriceTicks === undefined) {
      if (fillableQuantity === sizes[index]) throw new PublicApiError(`${context}[${index}] omits a fillable price`);
      return null;
    }
    const averagePriceTicks = exact(quote.averagePriceTicks, `${context}[${index}].averagePriceTicks`);
    if (fillableQuantity !== sizes[index]) throw new PublicApiError(`${context}[${index}] prices partial depth`);
    return Object.freeze({ size: sizes[index]!, averagePriceTicks, fillableQuantity });
  }));
}

function seriesCurve(body: Record<string, unknown>, seriesId: string, sizes: readonly bigint[]): PublicSeriesCurve {
  if (body.seriesId !== seriesId || typeof body.quoteAsset !== "string" || typeof body.quoteConvention !== "string" ||
      typeof body.methodologyVersion !== "number" || !Number.isSafeInteger(body.methodologyVersion) || body.methodologyVersion < 1 ||
      !Array.isArray(body.points)) throw new PublicApiError("series curve is malformed");
  exact(body.asOfValue, "curve.asOfValue");
  const points = body.points.map((candidate, index): PublicSeriesCurvePoint => {
    const context = `curve.points[${index}]`;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new PublicApiError(`${context} is malformed`);
    const point = candidate as Record<string, unknown>;
    if (typeof point.open !== "boolean") throw new PublicApiError(`${context}.open is malformed`);
    const common = {
      executionClassId: requiredText(point.executionClassId, `${context}.executionClassId`),
      settlementClass: requiredText(point.settlementClass, `${context}.settlementClass`),
      domains: textList(point.domains, `${context}.domains`),
    };
    if (!point.open) {
      if (point.executable !== undefined || point.indicativeWithImplied !== undefined || point.lastTrade !== undefined || point.halted !== undefined) throw new PublicApiError(`${context} is closed but carries market data`);
      return Object.freeze({ ...common, open: false, halted: false, bids: Object.freeze([]), asks: Object.freeze([]), impliedBids: Object.freeze([]), impliedAsks: Object.freeze([]), lastTrade: null });
    }
    if (typeof point.halted !== "boolean") throw new PublicApiError(`${context}.halted is malformed`);
    if (point.halted) {
      if (point.executable !== undefined || point.indicativeWithImplied !== undefined) throw new PublicApiError(`${context} is halted but carries executable depth`);
      return Object.freeze({ ...common, open: true, halted: true, bids: Object.freeze([]), asks: Object.freeze([]), impliedBids: Object.freeze([]), impliedAsks: Object.freeze([]), lastTrade: point.lastTrade === undefined ? null : observedTrade(point.lastTrade, `${context}.lastTrade`) });
    }
    if (point.executable === null || typeof point.executable !== "object" || Array.isArray(point.executable)) {
      throw new PublicApiError(`${context} is malformed`);
    }
    const executable = point.executable as Record<string, unknown>;
    const indicative = point.indicativeWithImplied;
    if (indicative === null || typeof indicative !== "object" || Array.isArray(indicative)) {
      throw new PublicApiError(`${context}.indicativeWithImplied is malformed`);
    }
    const withImplied = indicative as Record<string, unknown>;
    return Object.freeze({
      ...common,
      open: true,
      halted: point.halted,
      bids: curveQuotes(executable.bids, sizes, "EXECUTABLE", `${context}.bids`),
      asks: curveQuotes(executable.asks, sizes, "EXECUTABLE", `${context}.asks`),
      impliedBids: curveQuotes(withImplied.bids, sizes, "INDICATIVE", `${context}.impliedBids`),
      impliedAsks: curveQuotes(withImplied.asks, sizes, "INDICATIVE", `${context}.impliedAsks`),
      lastTrade: point.lastTrade === undefined ? null : observedTrade(point.lastTrade, `${context}.lastTrade`),
    });
  });
  if (new Set(points.map((point) => point.executionClassId)).size !== points.length) throw new PublicApiError("series curve repeats an execution class");
  const premiumSurface = settlementPremiumSurface(
    points.flatMap((point) => !point.open || point.halted ? [] : [{
      executionClassId: point.executionClassId,
      bids: sizes.map((size, index) => ({
        size,
        fillableQuantity: point.bids[index] === null ? BigInt(0) : size,
        label: "EXECUTABLE" as const,
        ...(point.bids[index] === null ? {} : { averagePriceTicks: point.bids[index]!.averagePriceTicks }),
      })),
      asks: sizes.map((size, index) => ({
        size,
        fillableQuantity: point.asks[index] === null ? BigInt(0) : size,
        label: "EXECUTABLE" as const,
        ...(point.asks[index] === null ? {} : { averagePriceTicks: point.asks[index]!.averagePriceTicks }),
      })),
    }]),
    sizes,
  );
  if (!sameExact(body.premiumSurface, premiumSurface)) throw new PublicApiError("settlement premium surface differs from executable depth");
  return Object.freeze({
    seriesId,
    quoteAsset: body.quoteAsset,
    quoteConvention: body.quoteConvention,
    methodologyVersion: body.methodologyVersion,
    premiumSurface,
    points: Object.freeze(points),
  });
}

/** Compares executable size curves across every settlement class of one economic series. */
export function usePublicSeriesCurve(baseUrl: string | null, seriesId: string | null, sizes: readonly bigint[]): {
  readonly curve: PublicSeriesCurve | null;
  readonly status: PublicMarketCatalogueStatus | null;
} {
  const [result, setResult] = useState<Readonly<{ key: string; curve: PublicSeriesCurve }> | null>(null);
  const [failure, setFailure] = useState<Readonly<{ key: string; detail: string }> | null>(null);
  const sizesKey = sizes.map((size) => size.toString()).join(",");
  const requestKey = `${seriesId ?? ""}:${sizesKey}`;

  useEffect(() => {
    if (baseUrl === null || seriesId === null || sizes.length === 0) return;
    const base = baseUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    void read(base, `/v1/curves/${encodeURIComponent(seriesId)}?sizes=${sizesKey}`, controller.signal)
      .then((body) => setResult({ key: requestKey, curve: seriesCurve(body, seriesId, sizes) }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure({ key: requestKey, detail: error instanceof Error ? error.message : "request failed" });
      });
    return () => controller.abort();
  }, [baseUrl, requestKey, seriesId, sizes, sizesKey]);

  if (baseUrl === null || seriesId === null) return { curve: null, status: null };
  if (result?.key === requestKey) return { curve: result.curve, status: { state: "live", detail: `${result.curve.points.length} execution class${result.curve.points.length === 1 ? "" : "es"} compared.` } };
  if (failure?.key === requestKey) return { curve: null, status: { state: "unavailable", detail: `Series curve unavailable (${failure.detail}).` } };
  return { curve: null, status: { state: "loading", detail: "Loading executable series curve." } };
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
  readonly halted?: boolean;
}

interface LiveState {
  readonly packageMarketId: string;
  readonly bids: DepthLevel[];
  readonly asks: DepthLevel[];
  readonly trades: TapeTrade[];
  readonly cursor: number;
  readonly halted: boolean;
  readonly version: number;
}

const BOOK_UNIT = { unit: "ticks", precision: 0 } as const;
const CONNECTING: PublicFeedStatus = { state: "connecting", detail: "Connecting to the public market API." };
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
  const configured = baseUrl !== null;
  const [observedLive, setLive] = useState<LiveState | null>(null);
  const [observedStatus, setStatus] = useState<{ packageMarketId: string; status: PublicFeedStatus } | null>(null);
  // Another market's book and status are never shown while the selected one loads.
  const live = observedLive?.packageMarketId === packageMarketId ? observedLive : null;
  const status = observedStatus?.packageMarketId === packageMarketId ? observedStatus.status : CONNECTING;

  useEffect(() => {
    if (baseUrl === null || packageMarketId === null) return;
    const marketId = packageMarketId;
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
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let depthRevision = 0;
    let polling = false;

    const publish = (detail: string) => {
      if (controller.signal.aborted) return;
      const observed = { packageMarketId: marketId, bids, asks, trades, cursor, halted };
      setLive((previous) => ({ ...observed, version: (previous?.version ?? 0) + 1 }));
      setStatus({
        packageMarketId: marketId,
        status: { state: "live", detail: halted ? "Market halted by the exchange." : detail, updatedAtMs: Date.now(), halted },
      });
    };
    const markStale = (error: unknown) => {
      const detail = error instanceof Error ? error.message : "request failed";
      setStatus((observed) => {
        const previous = observed?.packageMarketId === marketId ? observed.status : CONNECTING;
        return {
          packageMarketId: marketId,
          status: previous.state === "live" || previous.state === "stale"
            ? { ...previous, state: "stale", detail: `Last update failed (${detail}); showing the last observed data.` }
            : { state: "unavailable", detail: `Public market API unavailable (${detail}); no market data is shown.` },
        };
      });
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
      let failed = false;
      socket = opened;
      opened.addEventListener("open", () => {
        if (controller.signal.aborted || socket !== opened || failed) return;
        opened.send(JSON.stringify({ op: "subscribe", channel: "package-depth", packageMarketId }));
        opened.send(JSON.stringify({ op: "subscribe", channel: "package-tape", packageMarketId, after: cursor }));
      });
      opened.addEventListener("message", (event) => {
        if (controller.signal.aborted || socket !== opened || failed) return;
        try {
          const message = decode(JSON.parse(String(event.data)) as Json) as Record<string, unknown>;
          if (message.type === "error" && (message.packageMarketId === undefined || message.packageMarketId === packageMarketId)) {
            throw new PublicApiError(`stream refused: ${String(message.code)}`);
          }
          if (message.packageMarketId !== packageMarketId) return;
          if (message.type === "subscribed" && message.channel === "package-tape") {
            streaming = true;
            reconnectDelayMs = STREAM_RETRY_MIN_MS;
            schedule(STREAM_RESYNC_MS);
            publish("Streaming from the public market API.");
            return;
          }
          if (message.type === "package-depth") {
            const nextBids = levels(message.bids, "bids");
            const nextAsks = levels(message.asks, "asks");
            bids = nextBids;
            asks = nextAsks;
            halted = message.halted === true;
            depthRevision += 1;
            publish("Streaming from the public market API.");
          } else if (message.type === "package-tape") {
            const next = tapePage(message, cursor);
            trades = [...trades, ...next.trades].slice(-MAX_TRADES);
            cursor = next.nextCursor;
            publish("Streaming from the public market API.");
          }
        } catch (error) {
          // A malformed push ends the stream; polling takes over from the last good state.
          failed = true;
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
        reconnectTimer = setTimeout(openStream, reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, STREAM_RETRY_MAX_MS);
      });
    };

    const poll = async () => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      const startDepthRevision = depthRevision;
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
        if (controller.signal.aborted) return;
        if (depthRevision === startDepthRevision) {
          bids = nextBids;
          asks = nextAsks;
          halted = depth.halted === true;
        }
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
      } finally {
        polling = false;
      }
      schedule(streaming ? STREAM_RESYNC_MS : POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
      socket = undefined;
    };
  }, [baseUrl, packageMarketId]);

  const feed = useMemo<MarketFeed>(() => {
    if (!configured) return fallback;
    if (packageMarketId === null) {
      return {
        label: "UNAVAILABLE",
        sourceNote: "No published package market is selected. Market data is not shown.",
        book: BOOK_UNIT,
        candles: () => [],
        depth: () => ({ bids: [], asks: [], tick: 1 }),
        tape: () => [],
        seriesMeta: (series: ChartSeriesKey) => series === "basis" ? PACKAGE_PRICE : unpublishedLeg(series),
      };
    }
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
      const hasReference = reference !== null && reference.candles("basis", "15m").length > 0;
      return {
        label: hasReference ? "REFERENCE" : "UNAVAILABLE",
        sourceNote: `Package ${packageMarketId}: ${status.detail}${referenceNote}`,
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
      sourceNote: `Package ${packageMarketId}: ${status.detail}${referenceNote}`,
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
  }, [configured, live, fallback, packageMarketId, reference, status]);

  return { feed, status: !configured ? null : packageMarketId === null
    ? { state: "unavailable", detail: "No published package market is selected." }
    : status };
}
