"use client";

import Link from "next/link";
import type { PublicPackageMarket, PublicPackageOpportunity } from "../public-market-feed";
import styles from "./pages.module.css";

function text(value: string | null): string {
  return value === null ? "Not published" : value.replaceAll("_", " ").replaceAll("-", " ");
}

export function StrategyComparison({
  selectedIds,
  markets,
  opportunities,
  size,
  remove,
  clear,
}: {
  selectedIds: readonly string[];
  markets: readonly PublicPackageMarket[];
  opportunities: readonly PublicPackageOpportunity[];
  size: bigint;
  remove(marketId: string): void;
  clear(): void;
}) {
  if (selectedIds.length === 0) return null;
  const byMarket = new Map(markets.map((market) => [market.packageMarketId, market]));
  const byOpportunity = new Map(opportunities.map((opportunity) => [opportunity.packageMarketId, opportunity]));
  const selected = selectedIds.flatMap((marketId) => {
    const market = byMarket.get(marketId);
    return market === undefined ? [] : [{ market, opportunity: byOpportunity.get(marketId) ?? null }];
  });

  return (
    <section className={styles.card} aria-labelledby="strategy-comparison-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="strategy-comparison-title">Package comparison</h2>
          <p>Compare up to four strategy markets at the same requested size. Missing depth stays missing and observed trades are never treated as quotes.</p>
        </div>
        <button type="button" className={styles.ghost} onClick={clear}>Clear comparison</button>
      </div>
      {selected.length < 2 ? (
        <div className={styles.empty}><strong>Add another package market</strong><p>Select Compare beside a second market to inspect execution terms side by side.</p></div>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead><tr><th>Package</th><th>Strategy</th><th>Settlement</th><th>Domains</th><th className={styles.num}>Bid at {size.toString()}</th><th className={styles.num}>Ask at {size.toString()}</th><th className={styles.num}>Spread</th><th className={styles.num}>Last observed</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {selected.map(({ market, opportunity }) => (
                <tr key={market.packageMarketId}>
                  <td><span className={styles.cellStack}><strong className={styles.mono}>{market.packageMarketId}</strong><small className={styles.cellDetail}>{market.seriesId ?? "Series not published"}</small></span></td>
                  <td><span className={styles.cellStack}><strong>{text(market.templateId)}</strong><small className={styles.cellDetail}>{market.underlyingRefs.join(" + ") || "Assets not published"}</small></span></td>
                  <td>{text(market.settlementClass)}</td>
                  <td>{market.domainIds.join(" + ") || "Not published"}</td>
                  <td className={styles.num}>{opportunity?.bid?.averagePriceTicks.toString() ?? "Not fillable"}</td>
                  <td className={styles.num}>{opportunity?.ask?.averagePriceTicks.toString() ?? "Not fillable"}</td>
                  <td className={styles.num}>{opportunity?.spreadAtSizeTicks?.toString() ?? "-"}</td>
                  <td className={styles.num}>{opportunity?.lastTrade?.priceTicks.toString() ?? "-"}</td>
                  <td><div className={styles.rowActions}><Link className={styles.ghost} href={`/trade?market=${encodeURIComponent(market.packageMarketId)}`} prefetch={false}>Open</Link><button type="button" className={styles.ghost} onClick={() => remove(market.packageMarketId)}>Remove</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.notice}>Evidence: direct executable depth at the selected scan size. No modeled return, yield, or risk score is used.</p>
    </section>
  );
}
