"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { usePersistedFlag, usePersistedSetting } from "../persisted-setting";
import { usePublicPackageMarkets } from "../public-market-feed";
import { useTerminal } from "../shell/terminal-context";
import styles from "./pages.module.css";

const WATCHLIST_KEY = "naryx.terminal.market-watchlist.v1";
const WATCHLIST_EVENT = "naryx-market-watchlist";
const EMPTY_WATCHLIST: readonly string[] = Object.freeze([]);
const MARKET_ID = /^[A-Za-z0-9._:-]{1,128}$/;
let memoryWatchlist: string | null = null;
let cachedWatchlistValue: string | null | undefined;
let cachedWatchlist: readonly string[] = EMPTY_WATCHLIST;

type MarketSort = "market" | "spread" | "ask";

function watchlistValue() {
  try {
    return window.localStorage.getItem(WATCHLIST_KEY) ?? memoryWatchlist;
  } catch {
    return memoryWatchlist;
  }
}

function watchlistSnapshot(): readonly string[] {
  const value = watchlistValue();
  if (value === cachedWatchlistValue) return cachedWatchlist;
  cachedWatchlistValue = value;
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    cachedWatchlist = Array.isArray(parsed)
      ? Object.freeze([...new Set(parsed.filter((entry): entry is string => typeof entry === "string" && MARKET_ID.test(entry)))].slice(0, 100))
      : EMPTY_WATCHLIST;
  } catch {
    cachedWatchlist = EMPTY_WATCHLIST;
  }
  return cachedWatchlist;
}

function subscribeWatchlist(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(WATCHLIST_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(WATCHLIST_EVENT, callback);
  };
}

function writeWatchlist(value: readonly string[]) {
  memoryWatchlist = JSON.stringify(value.slice(0, 100));
  try {
    window.localStorage.setItem(WATCHLIST_KEY, memoryWatchlist);
  } catch {
    // The current page still keeps the watchlist when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(WATCHLIST_EVENT));
}

function compareExact(left: bigint | null, right: bigint | null) {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function marketState(halted: boolean, bid: bigint | null, ask: bigint | null) {
  if (halted) return { label: "Halted", className: styles.pillBad };
  if (bid !== null || ask !== null) return { label: "Executable", className: styles.pillOk };
  return { label: "Open, no depth", className: styles.pillWarn };
}

function human(value: string | null): string {
  return value === null ? "Not published" : value.replaceAll("_", " ").replaceAll("-", " ");
}

export function MarketsView() {
  const { publicApiBaseUrl } = useTerminal();
  const { markets, status } = usePublicPackageMarkets(publicApiBaseUrl);
  const [query, setQuery] = useState("");
  const watchlist = useSyncExternalStore(subscribeWatchlist, watchlistSnapshot, () => EMPTY_WATCHLIST);
  const [watchedOnly, setWatchedOnly] = usePersistedFlag("markets.watchedOnly", false);
  const [sort, setSort] = usePersistedSetting<MarketSort>("markets.sort", "market", ["market", "spread", "ask"]);
  const watched = useMemo(() => new Set(watchlist), [watchlist]);
  const normalized = query.trim().toLowerCase();
  const visible = useMemo(() => markets
    .filter((market) => (!watchedOnly || watched.has(market.packageMarketId)) && (normalized === "" || [
      market.packageMarketId,
      market.seriesId,
      market.templateId,
      market.quoteAsset,
      market.settlementClass,
      ...market.underlyingRefs,
      ...market.domainIds,
    ].some((value) => value?.toLowerCase().includes(normalized))))
    .sort((left, right) => {
      const watchOrder = Number(watched.has(right.packageMarketId)) - Number(watched.has(left.packageMarketId));
      if (watchOrder !== 0) return watchOrder;
      const priceOrder = sort === "spread"
        ? compareExact(left.spreadTicks, right.spreadTicks)
        : sort === "ask" ? compareExact(left.bestAskTicks, right.bestAskTicks) : 0;
      return priceOrder !== 0 ? priceOrder : left.packageMarketId.localeCompare(right.packageMarketId);
    }), [markets, normalized, sort, watched, watchedOnly]);
  const executable = markets.filter((market) => !market.halted && (market.bestBidTicks !== null || market.bestAskTicks !== null)).length;
  const domains = new Set(markets.flatMap((market) => market.domainIds)).size;
  const templates = new Set(markets.flatMap((market) => market.templateId === null ? [] : [market.templateId])).size;

  return (
    <main className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1>Markets</h1>
          <p>Discover native package markets, inspect executable package prices, and open the complete strategy book. Search stays in this browser.</p>
        </div>
        <span className={status?.state === "live" ? styles.pillOk : status?.state === "stale" ? styles.pillWarn : styles.pill}>
          {status?.state === "live" ? "Live catalogue" : status?.state === "stale" ? "Stale catalogue" : "Catalogue unavailable"}
        </span>
      </div>

      <section className={styles.summary} aria-label="Package market summary">
        <div><span>Open markets</span><strong>{markets.length}</strong><small>Native package books</small></div>
        <div><span>With executable depth</span><strong>{executable}</strong><small>At least one quoted side</small></div>
        <div><span>Strategy templates</span><strong>{templates}</strong><small>Published economic series</small></div>
        <div><span>Execution domains</span><strong>{domains}</strong><small>Across active catalogue entries</small></div>
      </section>

      <section className={styles.card} aria-labelledby="market-list-title">
        <div className={styles.cardHead}>
          <div>
            <h2 id="market-list-title">Package exchange</h2>
            <p>{status?.detail ?? "Configure the public market API to discover package markets."}</p>
          </div>
          <div className={styles.marketTools}>
            <label>
              <span className={styles.visuallyHidden}>Sort package markets</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as MarketSort)}>
                <option value="market">Sort by market</option>
                <option value="spread">Tightest spread</option>
                <option value="ask">Lowest ask</option>
              </select>
            </label>
            <label className={styles.watchFilter}>
              <input type="checkbox" checked={watchedOnly} onChange={(event) => setWatchedOnly(event.target.checked)} />
              Watched only ({watchlist.length})
            </label>
            <label className={styles.marketSearch}>
              <span className={styles.visuallyHidden}>Search package markets</span>
              <input
                type="search"
                value={query}
                placeholder="Search market, asset, chain"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
        </div>
        {visible.length === 0 ? (
          <div className={styles.empty}>
            <strong>{markets.length === 0 ? "No package markets published" : "No markets match this search"}</strong>
            <p>{markets.length === 0 ? "The exchange catalogue has not published an open package book yet." : "Try a market id, template, underlying, quote asset, or domain."}</p>
          </div>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Package market</th>
                  <th>Strategy</th>
                  <th>Domains</th>
                  <th className={styles.num}>Best bid</th>
                  <th className={styles.num}>Best ask</th>
                  <th className={styles.num}>Spread</th>
                  <th>Status</th>
                  <th aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {visible.map((market) => {
                  const state = marketState(market.halted, market.bestBidTicks, market.bestAskTicks);
                  return (
                    <tr key={market.packageMarketId}>
                      <td>
                        <span className={styles.cellStack}>
                          <strong className={styles.mono}>{market.packageMarketId}</strong>
                          <small className={styles.cellDetail}>{market.seriesId ?? "Series metadata unavailable"}</small>
                        </span>
                      </td>
                      <td>
                        <span className={styles.cellStack}>
                          <strong>{human(market.templateId)}</strong>
                          <small className={styles.cellDetail}>
                            {market.underlyingRefs.length === 0 ? "Assets unavailable" : market.underlyingRefs.join(" + ")} / {market.quoteAsset ?? "quote unavailable"}
                          </small>
                        </span>
                      </td>
                      <td>
                        <span className={styles.cellStack}>
                          <strong>{market.domainIds.length === 0 ? "Not published" : market.domainIds.join(" + ")}</strong>
                          <small className={styles.cellDetail}>{human(market.settlementClass)}</small>
                        </span>
                      </td>
                      <td className={styles.num}>{market.bestBidTicks?.toString() ?? "-"}</td>
                      <td className={styles.num}>{market.bestAskTicks?.toString() ?? "-"}</td>
                      <td className={styles.num}>{market.spreadTicks?.toString() ?? "-"}</td>
                      <td><span className={state.className}>{state.label}</span></td>
                      <td>
                        <div className={styles.rowActions}>
                          <button
                            type="button"
                            className={watched.has(market.packageMarketId) ? styles.watching : styles.ghost}
                            aria-pressed={watched.has(market.packageMarketId)}
                            onClick={() => writeWatchlist(watched.has(market.packageMarketId)
                              ? watchlist.filter((marketId) => marketId !== market.packageMarketId)
                              : [market.packageMarketId, ...watchlist])}
                          >
                            {watched.has(market.packageMarketId) ? "Watching" : "Watch"}
                          </button>
                          <Link
                            className={styles.ghost}
                            href={`/trade?market=${encodeURIComponent(market.packageMarketId)}`}
                            prefetch={false}
                          >
                            Open book
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
