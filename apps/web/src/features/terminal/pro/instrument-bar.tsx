"use client";

import { useMemo } from "react";
import type { MarketFeed } from "../market-feed";
import type { TerminalViewModel } from "../terminal-view-model";
import styles from "./pro.module.css";

// Compact labels for the dense header; the full label stays available as the tooltip.
const SHORT_LABELS: Readonly<Record<string, string>> = {
  "Spot reference": "Spot ref",
  "Perp reference": "Perp ref",
  "Expected net annualized yield": "Net yield (model)",
  "Funding annualized": "Funding APR",
  "Liquidity at size": "Depth at size",
  "Settlement class": "Settlement",
};

/**
 * The instrument header: the package identity, last basis with its 24-hour change, range, and
 * the snapshot's reference metrics. Every value keeps its source label.
 */
export function InstrumentBar({ snapshot, feed }: { snapshot: TerminalViewModel; feed: MarketFeed }) {
  const stats = useMemo(() => {
    const hourly = feed.candles("basis", "1h");
    const last = hourly[hourly.length - 1];
    const dayAgo = hourly[hourly.length - 25];
    const window = hourly.slice(-24);
    if (last === undefined || dayAgo === undefined || window.length === 0) return null;
    return {
      last: last.close,
      change: last.close - dayAgo.close,
      high: Math.max(...window.map((candle) => candle.high)),
      low: Math.min(...window.map((candle) => candle.low)),
      volume: window.reduce((sum, candle) => sum + candle.volume, 0),
    };
  }, [feed]);
  const tone = stats === null ? undefined : stats.change >= 0 ? styles.up : styles.down;
  const { unit, precision } = feed.seriesMeta("basis");
  // The last basis is shown as the headline price, so the snapshot's own basis metric is not repeated.
  const metrics = snapshot.market.metrics.filter((entry) => !/^basis$/i.test(entry.label));

  return (
    <section className={styles.instrumentBar} aria-label="Instrument">
      <div className={styles.instrumentIdentity}>
        <span className={styles.instrumentBadge} aria-hidden="true">
          <svg viewBox="0 0 18 18">
            <rect x="2" y="3" width="5" height="12" rx="1" className={styles.badgeLong} />
            <rect x="11" y="3" width="5" height="12" rx="1" className={styles.badgeShort} />
            <path d="M7 9h4" className={styles.badgeLink} />
          </svg>
        </span>
        <div>
          <strong>{snapshot.market.packageId}</strong>
          <span className={styles.instrumentSub}>
            {snapshot.market.strategy} <b>{snapshot.market.base}/{snapshot.market.quote}</b>
          </span>
        </div>
        <span className={styles.instrumentKind}>Package</span>
      </div>
      <div className={styles.instrumentPrice}>
        <strong className={tone}>{stats === null ? "-" : stats.last.toFixed(precision)}</strong>
        <span>{unit === "bps" ? "Basis bps" : `Package ${unit}`}</span>
      </div>
      <dl className={styles.instrumentStats}>
        <div>
          <dt>24h change</dt>
          <dd className={tone}>{stats === null ? "-" : `${stats.change >= 0 ? "+" : ""}${stats.change.toFixed(precision)} ${unit}`}</dd>
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
          <dd>{stats === null ? "-" : Math.round(stats.volume).toLocaleString("en-US")}</dd>
        </div>
        {metrics.map((entry) => (
          <div key={entry.label} title={entry.detail === undefined ? entry.label : `${entry.label}. ${entry.detail}`}>
            <dt>{SHORT_LABELS[entry.label] ?? entry.label}</dt>
            <dd className={entry.accent ? styles.accentValue : undefined}>{entry.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
