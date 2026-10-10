"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { usePersistedFlag, usePersistedSetting } from "../persisted-setting";
import { MarketAlerts } from "../market-alerts";
import { usePublicPackageMarkets, usePublicPackageOpportunities, usePublicSeriesCurve } from "../public-market-feed";
import { useTerminal } from "../shell/terminal-context";
import { PaperTradingLab } from "./paper-trading-lab";
import { StrategyComparison } from "./strategy-comparison";
import { StrategyGraphStudio } from "./strategy-graph-studio";
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
  const [scanSizeInput, setScanSizeInput] = useState("1");
  const [scanSize, setScanSize] = useState(BigInt(1));
  const { opportunities, status: opportunityStatus } = usePublicPackageOpportunities(publicApiBaseUrl, scanSize);
  const [curveSeriesId, setCurveSeriesId] = useState("");
  const [curveSizesInput, setCurveSizesInput] = useState("1,10,100");
  const [curveSizes, setCurveSizes] = useState<readonly bigint[]>([BigInt(1), BigInt(10), BigInt(100)]);
  const [query, setQuery] = useState("");
  const [comparisonIds, setComparisonIds] = useState<readonly string[]>([]);
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
  const seriesIds = useMemo(() => [...new Set(markets.flatMap((market) => market.seriesId === null ? [] : [market.seriesId]))].sort(), [markets]);
  const selectedCurveSeriesId = seriesIds.includes(curveSeriesId) ? curveSeriesId : seriesIds[0] ?? null;
  const { curve, status: curveStatus } = usePublicSeriesCurve(publicApiBaseUrl, selectedCurveSeriesId, curveSizes);
  const validCurveSizes = /^(?:[1-9][0-9]{0,30})(?:,(?:[1-9][0-9]{0,30})){0,15}$/.test(curveSizesInput);

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

      <section className={styles.card} aria-labelledby="opportunity-scanner-title">
        <div className={styles.cardHead}>
          <div>
            <h2 id="opportunity-scanner-title">Executable opportunity scanner</h2>
            <p>{opportunityStatus?.detail ?? "Configure the public market API to scan executable package depth."}</p>
          </div>
          <form
            className={styles.scanControls}
            onSubmit={(event) => {
              event.preventDefault();
              if (!/^[1-9][0-9]*$/.test(scanSizeInput)) return;
              setScanSize(BigInt(scanSizeInput));
            }}
          >
            <label>
              <span>Package size</span>
              <input
                inputMode="numeric"
                pattern="[1-9][0-9]*"
                value={scanSizeInput}
                onChange={(event) => setScanSizeInput(event.target.value)}
                aria-invalid={!/^[1-9][0-9]*$/.test(scanSizeInput)}
              />
            </label>
            <button type="submit" className={styles.ghost} disabled={!/^[1-9][0-9]*$/.test(scanSizeInput)}>Scan depth</button>
          </form>
        </div>
        <div className={styles.evidenceBar}>
          <span className={opportunityStatus?.state === "live" ? styles.pillOk : opportunityStatus?.state === "stale" ? styles.pillWarn : styles.pill}>
            {opportunityStatus?.state === "live" ? "Executable" : opportunityStatus?.state === "stale" ? "Last verified" : "Scanning"}
          </span>
          <p>Direct resting liquidity only. Every shown side can fill the full size. Last trade is observed evidence, not a quote.</p>
        </div>
        {opportunities.length === 0 ? (
          <div className={styles.empty}>
            <strong>No direct book can fill this size</strong>
            <p>Try a smaller package size or wait for firm liquidity. Partial and implied depth are excluded.</p>
          </div>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Package market</th>
                  <th className={styles.num}>Executable bid</th>
                  <th className={styles.num}>Executable ask</th>
                  <th className={styles.num}>Spread at size</th>
                  <th className={styles.num}>Last observed</th>
                  <th aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {opportunities.map((opportunity, index) => (
                  <tr key={opportunity.packageMarketId}>
                    <td className={styles.num}>{index + 1}</td>
                    <td>
                      <span className={styles.cellStack}>
                        <strong className={styles.mono}>{opportunity.packageMarketId}</strong>
                        <small className={styles.cellDetail}>{opportunity.seriesId ?? "Series not published"}</small>
                      </span>
                    </td>
                    <td className={styles.num}>{opportunity.bid?.averagePriceTicks.toString() ?? "-"}</td>
                    <td className={styles.num}>{opportunity.ask?.averagePriceTicks.toString() ?? "-"}</td>
                    <td className={styles.num}>{opportunity.spreadAtSizeTicks?.toString() ?? "One-sided"}</td>
                    <td className={styles.num}>
                      <span className={styles.cellStack}>
                        <strong>{opportunity.lastTrade?.priceTicks.toString() ?? "-"}</strong>
                        <small className={styles.cellDetail}>{opportunity.lastTrade === null ? "No observed trade" : `${opportunity.lastTrade.quantity.toString()} units`}</small>
                      </span>
                    </td>
                    <td>
                      <Link className={styles.ghost} href={`/trade?market=${encodeURIComponent(opportunity.packageMarketId)}`} prefetch={false}>
                        Open book
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <StrategyComparison
        selectedIds={comparisonIds}
        markets={markets}
        opportunities={opportunities}
        size={scanSize}
        remove={(marketId) => setComparisonIds((current) => current.filter((id) => id !== marketId))}
        clear={() => setComparisonIds([])}
      />

      <PaperTradingLab baseUrl={publicApiBaseUrl} opportunities={opportunities} scanSize={scanSize} />

      <StrategyGraphStudio baseUrl={publicApiBaseUrl} />

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
                          <button
                            type="button"
                            className={comparisonIds.includes(market.packageMarketId) ? styles.watching : styles.ghost}
                            aria-pressed={comparisonIds.includes(market.packageMarketId)}
                            disabled={!comparisonIds.includes(market.packageMarketId) && comparisonIds.length >= 4}
                            title={!comparisonIds.includes(market.packageMarketId) && comparisonIds.length >= 4 ? "Remove a compared market before adding another." : undefined}
                            onClick={() => setComparisonIds((current) => current.includes(market.packageMarketId)
                              ? current.filter((id) => id !== market.packageMarketId)
                              : [...current, market.packageMarketId])}
                          >
                            {comparisonIds.includes(market.packageMarketId) ? "Comparing" : "Compare"}
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

      <section className={styles.card} aria-labelledby="series-curve-title">
        <div className={styles.cardHead}>
          <div>
            <h2 id="series-curve-title">Package series curve</h2>
            <p>{curveStatus?.detail ?? "Publish a strategy series to compare its execution classes."}</p>
          </div>
          <form
            className={styles.curveControls}
            onSubmit={(event) => {
              event.preventDefault();
              if (!validCurveSizes) return;
              setCurveSizes(Object.freeze(curveSizesInput.split(",").map((value) => BigInt(value))));
            }}
          >
            <label>
              <span>Economic series</span>
              <select value={selectedCurveSeriesId ?? ""} onChange={(event) => setCurveSeriesId(event.target.value)} disabled={seriesIds.length === 0}>
                {seriesIds.length === 0 ? <option value="">No published series</option> : seriesIds.map((seriesId) => <option key={seriesId} value={seriesId}>{seriesId}</option>)}
              </select>
            </label>
            <label>
              <span>Sizes</span>
              <input value={curveSizesInput} onChange={(event) => setCurveSizesInput(event.target.value.replaceAll(" ", ""))} aria-invalid={!validCurveSizes} />
            </label>
            <button type="submit" className={styles.ghost} disabled={!validCurveSizes || selectedCurveSeriesId === null}>Compare</button>
          </form>
        </div>
        {curve === null ? (
          <div className={styles.empty}>
            <strong>{selectedCurveSeriesId === null ? "No strategy series published" : "Curve is not available"}</strong>
            <p>Open package books under the same economic series to compare executable settlement classes.</p>
          </div>
        ) : (
          <>
            <div className={styles.evidenceBar}>
              <span className={styles.pillOk}>Methodology v{curve.methodologyVersion}</span>
              <p>{human(curve.quoteConvention)} in {curve.quoteAsset}. Direct depth is executable. Premiums measure each active settlement class against the best direct price at the same size. The separate with-implied line is indicative and cannot be submitted as a fill.</p>
            </div>
            <div className={styles.scroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Execution class</th>
                    <th>Settlement</th>
                    <th>Domains</th>
                    {curveSizes.map((size) => <th key={size.toString()} className={styles.num}>Bid / ask at {size.toString()}</th>)}
                    <th className={styles.num}>Last observed</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {curve.points.map((point) => {
                    const premiums = curve.premiumSurface.points.find((entry) => entry.executionClassId === point.executionClassId)?.premiums;
                    return (
                      <tr key={point.executionClassId}>
                        <td className={styles.mono}>{point.executionClassId}</td>
                        <td>{human(point.settlementClass)}</td>
                        <td>{point.domains.join(" + ")}</td>
                        {curveSizes.map((size, index) => (
                          <td key={size.toString()} className={styles.num}>
                            {!point.open ? "-" : (
                              <span className={styles.cellStack}>
                                <strong>{point.bids[index]?.averagePriceTicks.toString() ?? "-"} / {point.asks[index]?.averagePriceTicks.toString() ?? "-"}</strong>
                                <small className={styles.cellDetail}>With implied: {point.impliedBids[index]?.averagePriceTicks.toString() ?? "-"} / {point.impliedAsks[index]?.averagePriceTicks.toString() ?? "-"}</small>
                                <small className={styles.cellDetail}>Bid discount / ask premium: {premiums?.[index]?.bidDiscountTicks?.toString() ?? "-"} / {premiums?.[index]?.askPremiumTicks?.toString() ?? "-"}</small>
                              </span>
                            )}
                          </td>
                        ))}
                        <td className={styles.num}>{point.lastTrade?.priceTicks.toString() ?? "-"}</td>
                        <td><span className={!point.open || point.halted ? styles.pillWarn : styles.pillOk}>{!point.open ? "Closed" : point.halted ? "Halted" : "Open"}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <MarketAlerts markets={markets} />
    </main>
  );
}
