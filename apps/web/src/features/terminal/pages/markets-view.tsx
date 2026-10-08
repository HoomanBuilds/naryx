"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { usePublicPackageMarkets } from "../public-market-feed";
import { useTerminal } from "../shell/terminal-context";
import styles from "./pages.module.css";

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
  const normalized = query.trim().toLowerCase();
  const visible = useMemo(() => markets.filter((market) => normalized === "" || [
    market.packageMarketId,
    market.seriesId,
    market.templateId,
    market.quoteAsset,
    market.settlementClass,
    ...market.underlyingRefs,
    ...market.domainIds,
  ].some((value) => value?.toLowerCase().includes(normalized))), [markets, normalized]);
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
                        <Link
                          className={styles.ghost}
                          href={`/trade?market=${encodeURIComponent(market.packageMarketId)}`}
                          prefetch={false}
                        >
                          Open book
                        </Link>
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
