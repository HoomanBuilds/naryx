"use client";

import { useMemo } from "react";
import type { MarketFeed } from "../market-feed";
import type { PublicPackageMarket } from "../public-market-feed";
import type { TerminalViewModel } from "../terminal-view-model";
import { ChainIcon, PairIcon } from "@/features/brand/chain-icons";
import { marketAssetLabel, packageMarketVariant } from "../market-label";
import { MarketSwitcher } from "./market-switcher";
import styles from "./pro.module.css";

// Compact labels for the dense header; the full label stays available as the tooltip.
const SHORT_LABELS: Readonly<Record<string, string>> = {
  "Spot reference": "Spot index",
  "Perp reference": "Perp index",
  "Expected net annualized yield": "Net carry (model)",
  "Funding annualized": "Funding (current)",
  "Liquidity at size": "Depth at size",
  "Settlement class": "Settlement",
};

/**
 * The instrument header: the package identity, last basis with its 24-hour change, range, and
 * the snapshot's reference metrics. Every value keeps its source label.
 */
export function InstrumentBar({
  snapshot,
  feed,
  packageMarketId,
  packageMarkets,
  marketStatus,
  marketState,
  onPackageMarketChange,
}: {
  snapshot: TerminalViewModel;
  feed: MarketFeed;
  packageMarketId: string | null;
  packageMarkets: readonly PublicPackageMarket[];
  marketStatus: string | null;
  marketState: "loading" | "live" | "stale" | "unavailable" | null;
  onPackageMarketChange(packageMarketId: string): void;
}) {
  const missingPublicMarket = marketState !== null && !packageMarkets.some((market) => market.packageMarketId === packageMarketId);
  // Windows are by time, not candle count, so a gap in the history never stretches "24h".
  const stats = useMemo(() => {
    if (missingPublicMarket) return null;
    const hourly = feed.candles("basis", "1h");
    const last = hourly.at(-1);
    if (last === undefined) return null;
    const dayAgo = hourly.findLast((candle) => candle.time <= last.time - 86_400);
    const window = hourly.filter((candle) => candle.time > last.time - 86_400);
    return {
      last: last.close,
      change: dayAgo === undefined ? null : last.close - dayAgo.close,
      high: Math.max(...window.map((candle) => candle.high)),
      low: Math.min(...window.map((candle) => candle.low)),
      volume: window.reduce((sum, candle) => sum + candle.volume, 0),
    };
  }, [feed, missingPublicMarket]);
  const tone = stats === null || stats.change === null || stats.change === 0 ? undefined : stats.change > 0 ? styles.up : styles.down;
  const basisMeta = feed.seriesMeta("basis");
  const { unit, precision, volume: hasVolume } = basisMeta;
  const referencePrice = (basisMeta.label ?? feed.label) === "REFERENCE";
  // The last basis is shown as the headline price, so the snapshot's own basis metric is not repeated.
  const selectedMarket = packageMarkets.find((market) => market.packageMarketId === packageMarketId) ?? null;
  const marketIdentity = packageMarketId ?? snapshot.market.packageId;
  const marketBase = marketAssetLabel(selectedMarket?.underlyingRefs[0] ?? snapshot.market.base);
  const marketQuote = marketAssetLabel(selectedMarket?.quoteAsset ?? snapshot.market.quote);
  const marketVariant = selectedMarket === null ? null : packageMarketVariant(selectedMarket);
  const underlyings = selectedMarket === null
    ? `${marketAssetLabel(snapshot.market.base)}/${marketAssetLabel(snapshot.market.quote)}`
    : `${[...new Set(selectedMarket.underlyingRefs)].map(marketAssetLabel).join(" + ")}/${marketAssetLabel(selectedMarket.quoteAsset ?? snapshot.market.quote)}`;
  const metrics = missingPublicMarket || selectedMarket?.templateId !== null && selectedMarket?.templateId !== undefined
    && selectedMarket.templateId !== "cash-and-carry-v1"
    ? []
    : snapshot.market.metrics.filter((entry) => !/^basis$/i.test(entry.label));
  let priceSource = { tag: "Unavailable", title: marketStatus ?? snapshot.environment.detail };
  if (!missingPublicMarket) {
    if (referencePrice) {
      priceSource = { tag: "Spot/perp index", title: `Observed spot-perp reference, not a traded package price. ${basisMeta.note ?? ""}` };
    } else if (feed.label === "FIXTURE") {
      priceSource = { tag: "Sample data", title: "These values are deterministic samples, not market data." };
    } else if (stats !== null && feed.label === "OBSERVED") {
      priceSource = { tag: "Package trades", title: "Observed package trades from the public market tape." };
    } else if (stats === null) {
      priceSource = { tag: "No trades", title: "No package trade or reference price is available for this market." };
    }
  }

  return (
    <section className={styles.instrumentBar} aria-label="Instrument">
      <div className={styles.instrumentIdentity}>
        {!missingPublicMarket ? <span className={styles.instrumentBadge} aria-hidden="true">
          <PairIcon base={marketBase} quote={marketQuote} size={24} />
          <ChainIcon chain={snapshot.selectedDomain} size={13} className={styles.instrumentChain} />
        </span> : null}
        <div>
          {selectedMarket !== null ? (
            <MarketSwitcher selected={selectedMarket} markets={packageMarkets} onChange={onPackageMarketChange} />
          ) : <strong title={marketStatus ?? marketIdentity}>{missingPublicMarket ? marketState === "loading" ? "Loading markets" : packageMarkets.length > 0 ? "Market details unavailable" : "Markets unavailable" : `${marketBase} ${snapshot.market.strategy.replace(/-v\d+$/, "").replaceAll("-", " ")}`}</strong>}
          {!missingPublicMarket ? <span className={styles.instrumentSub}>
            {marketVariant ? `${marketVariant} / ` : ""}<b>{underlyings}</b>
          </span> : null}
        </div>
        {!missingPublicMarket ? <span
          className={styles.instrumentKind}
          title={selectedMarket?.halted ? "Continuous matching is stopped. Halt evidence and the reopening-auction queue are in the package book section of the ticket strategy tools." : undefined}
        >
          {selectedMarket?.halted ? "Halted" : "Package"}
        </span> : null}
      </div>
      <div className={styles.instrumentPrice}>
        <strong className={tone}>{stats === null ? "-" : stats.last.toFixed(precision)}</strong>
        <span>{referencePrice ? "Index basis · bps" : unit === "bps" ? "Basis · bps" : `Package · ${unit}`}</span>
      </div>
      <dl className={styles.instrumentStats}>
        <div>
          <dt>24h change</dt>
          <dd className={tone}>{stats === null || stats.change === null ? "-" : `${stats.change >= 0 ? "+" : ""}${stats.change.toFixed(precision)} ${unit}`}</dd>
        </div>
        <div>
          <dt>24h high</dt>
          <dd>{stats === null ? "-" : stats.high.toFixed(precision)}</dd>
        </div>
        <div>
          <dt>24h low</dt>
          <dd>{stats === null ? "-" : stats.low.toFixed(precision)}</dd>
        </div>
        <div>
          <dt>24h volume</dt>
          <dd>{stats === null || hasVolume === false ? "-" : Math.round(stats.volume).toLocaleString("en-US")}</dd>
        </div>
        <div className={styles.metricSource} title={priceSource.title}>
          <dt>Price source</dt>
          <dd>{priceSource.tag}</dd>
        </div>
        {metrics.map((entry) => (
          <div key={entry.label} title={entry.detail === undefined ? entry.label : `${entry.label}. ${entry.detail}`}>
            <dt>{SHORT_LABELS[entry.label] ?? entry.label}</dt>
            <dd className={entry.accent === true && !/yield|funding/i.test(entry.label) ? styles.accentValue : undefined}>{entry.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
