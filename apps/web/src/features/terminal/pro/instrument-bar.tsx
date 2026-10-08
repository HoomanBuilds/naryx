"use client";

import { useMemo } from "react";
import type { MarketFeed } from "../market-feed";
import type { PublicPackageMarket } from "../public-market-feed";
import type { TerminalViewModel } from "../terminal-view-model";
import { ChainIcon, PairIcon } from "@/features/brand/chain-icons";
import styles from "./pro.module.css";

// Compact labels for the dense header; the full label stays available as the tooltip.
const SHORT_LABELS: Readonly<Record<string, string>> = {
  "Spot reference": "Spot ref",
  "Perp reference": "Perp ref",
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
  onPackageMarketChange,
}: {
  snapshot: TerminalViewModel;
  feed: MarketFeed;
  packageMarketId: string | null;
  packageMarkets: readonly PublicPackageMarket[];
  marketStatus: string | null;
  onPackageMarketChange(packageMarketId: string): void;
}) {
  // Windows are by time, not candle count, so a gap in the history never stretches "24h".
  const stats = useMemo(() => {
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
  }, [feed]);
  const tone = stats === null || stats.change === null ? undefined : stats.change >= 0 ? styles.up : styles.down;
  const { unit, precision, volume: hasVolume } = feed.seriesMeta("basis");
  // The last basis is shown as the headline price, so the snapshot's own basis metric is not repeated.
  const selectedMarket = packageMarkets.find((market) => market.packageMarketId === packageMarketId) ?? null;
  const marketIdentity = packageMarketId ?? snapshot.market.packageId;
  const marketBase = selectedMarket?.underlyingRefs[0] ?? snapshot.market.base;
  const marketQuote = selectedMarket?.quoteAsset ?? snapshot.market.quote;
  const marketStrategy = selectedMarket?.templateId ?? snapshot.market.strategy;
  const underlyings = selectedMarket === null
    ? `${snapshot.market.base}/${snapshot.market.quote}`
    : `${[...new Set(selectedMarket.underlyingRefs)].join(" + ")}/${selectedMarket.quoteAsset ?? snapshot.market.quote}`;
  const metrics = selectedMarket?.templateId !== null && selectedMarket?.templateId !== undefined
    && selectedMarket.templateId !== "cash-and-carry-v1"
    ? []
    : snapshot.market.metrics.filter((entry) => !/^basis$/i.test(entry.label));
  // Reference metrics carry the snapshot's evidence grade on screen, and a modeled return is never
  // emphasized as if it were a promised yield.
  const grade = snapshot.environment.evidenceGrade;
  const reference = grade === "FIXTURE_UNATTESTED"
    ? { tag: "FIXTURE", className: styles.labelFixture, title: "These reference values are unattested fixtures, not market data." }
    : grade === "OBSERVED_UNATTESTED"
      ? { tag: "LIVE", className: styles.labelObserved, title: `Observed book prices captured ${snapshot.environment.capturedAt}. Unsigned and unattested.` }
      : { tag: "UNAVAILABLE", className: styles.labelFixture, title: snapshot.environment.detail };

  return (
    <section className={styles.instrumentBar} aria-label="Instrument">
      <div className={styles.instrumentIdentity}>
        <span className={styles.instrumentBadge} aria-hidden="true">
          <PairIcon base={marketBase} quote={marketQuote} size={24} />
          <ChainIcon chain={snapshot.selectedDomain} size={13} className={styles.instrumentChain} />
        </span>
        <div>
          {packageMarkets.length > 0 ? (
            <select
              className={styles.instrumentMarketSelect}
              aria-label="Package market"
              value={marketIdentity}
              title={marketStatus ?? "Select a package market"}
              onChange={(event) => onPackageMarketChange(event.target.value)}
            >
              {packageMarkets.map((market) => (
                <option key={market.packageMarketId} value={market.packageMarketId}>
                  {market.packageMarketId}{market.halted ? " (halted)" : ""}
                </option>
              ))}
            </select>
          ) : <strong title={marketStatus ?? undefined}>{marketIdentity}</strong>}
          <span className={styles.instrumentSub}>
            {marketStrategy} <b>{underlyings}</b>
          </span>
        </div>
        <span className={styles.instrumentKind}>{selectedMarket?.halted ? "Halted" : "Package"}</span>
      </div>
      <div className={styles.instrumentPrice}>
        <strong className={tone}>{stats === null ? "-" : stats.last.toFixed(precision)}</strong>
        <span>{unit === "bps" ? "Basis bps" : `Package ${unit}`}</span>
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
        <div className={styles.metricSource} title={reference.title}>
          <dt>Reference</dt>
          <dd><span className={reference.className}>{reference.tag}</span></dd>
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
