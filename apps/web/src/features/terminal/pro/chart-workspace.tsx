"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { MarketFeed } from "../market-feed";
import type { TerminalPreview, TerminalViewModel } from "../terminal-view-model";
import { handleTablistKeys, usePersistedSetting } from "../persisted-setting";
import { CHART_COLORS } from "./chart-colors";
import { PriceChart } from "./price-chart";
import styles from "./pro.module.css";

type ChartView = "chart" | "depth" | "payoff";

const VIEWS: readonly { id: ChartView; label: string }[] = [
  { id: "chart", label: "Price chart" },
  { id: "depth", label: "Depth" },
  { id: "payoff", label: "Payoff" },
];

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}

function niceTicks(minimum: number, maximum: number, count: number): number[] {
  const span = maximum - minimum;
  if (!(span > 0)) return [minimum];
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? raw;
  const ticks: number[] = [];
  for (let value = Math.ceil(minimum / step) * step; value <= maximum + step * 1e-9; value += step) ticks.push(Number(value.toFixed(10)));
  return ticks;
}

function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

const PLOT = { top: 18, right: 64, bottom: 26, left: 12 };
const DEPTH_TOP = 48;

/**
 * Cumulative package depth. The solid area is direct depth only; the dashed line adds implied
 * depth derived from leg sources, so the two are never blended into one number.
 */
function DepthChart({ feed, unit }: { feed: MarketFeed; unit: string }) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; price: number; side: "bid" | "ask"; direct: number; total: number } | null>(null);
  const model = useMemo(() => {
    const book = feed.depth();
    const accumulate = (levels: typeof book.bids) => {
      let direct = 0;
      let total = 0;
      return levels.map((level) => {
        direct += level.direct;
        total += level.direct + level.implied;
        return { price: level.price, direct, total };
      });
    };
    const bids = accumulate(book.bids);
    const asks = accumulate(book.asks);
    const prices = [...book.bids, ...book.asks].map((level) => level.price);
    const minimum = Math.min(...prices);
    const maximum = Math.max(...prices);
    const peak = Math.max(1, bids.at(-1)?.total ?? 0, asks.at(-1)?.total ?? 0);
    const bestBid = book.bids[0]?.price ?? minimum;
    const bestAsk = book.asks[0]?.price ?? maximum;
    return { bids, asks, minimum, maximum, peak, mid: (bestBid + bestAsk) / 2 };
  }, [feed]);

  const plotWidth = Math.max(0, width - PLOT.left - PLOT.right);
  const plotHeight = Math.max(0, height - DEPTH_TOP - PLOT.bottom);
  const x = (price: number) => PLOT.left + ((price - model.minimum) / (model.maximum - model.minimum || 1)) * plotWidth;
  const y = (size: number) => DEPTH_TOP + plotHeight - (size / (model.peak * 1.08)) * plotHeight;
  const baseline = DEPTH_TOP + plotHeight;

  const stepPath = (points: readonly { price: number; value: number }[], side: "bid" | "ask", close: boolean) => {
    if (points.length === 0) return "";
    const first = points[0];
    if (first === undefined) return "";
    let path = `M${x(first.price).toFixed(1)},${baseline.toFixed(1)}`;
    let previous = 0;
    for (const point of points) {
      path += `L${x(point.price).toFixed(1)},${y(previous).toFixed(1)}L${x(point.price).toFixed(1)},${y(point.value).toFixed(1)}`;
      previous = point.value;
    }
    const edge = side === "bid" ? PLOT.left : PLOT.left + plotWidth;
    path += `L${edge.toFixed(1)},${y(previous).toFixed(1)}`;
    if (close) path += `L${edge.toFixed(1)},${baseline.toFixed(1)}Z`;
    return path;
  };

  const priceTicks = niceTicks(model.minimum, model.maximum, 6);
  const sizeTicks = niceTicks(0, model.peak * 1.08, 4).filter((value) => value > 0);

  function onMove(event: ReactMouseEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer = event.clientX - bounds.left;
    const price = model.minimum + ((pointer - PLOT.left) / (plotWidth || 1)) * (model.maximum - model.minimum);
    const side = price <= model.mid ? "bid" : "ask";
    const levels = side === "bid" ? model.bids : model.asks;
    const reached = side === "bid" ? levels.filter((level) => level.price >= price) : levels.filter((level) => level.price <= price);
    const last = reached.at(-1);
    if (last === undefined || pointer < PLOT.left || pointer > PLOT.left + plotWidth) return setHover(null);
    setHover({ x: x(last.price), price: last.price, side, direct: last.direct, total: last.total });
  }

  // An empty book has no price range to draw; it is said, not plotted.
  const empty = model.bids.length + model.asks.length === 0;

  return (
    <div ref={ref} className={styles.svgHost}>
      {empty ? (
        <div className={styles.chartEmpty} role="status">
          <strong>No package depth</strong>
          <span>{feed.label === "REFERENCE" ? "Package depth is published only by the public market API, which this deployment does not run." : "The package book has no resting orders."}</span>
        </div>
      ) : width > 0 && height > 0 ? (
        <svg width={width} height={height} role="img" aria-label="Cumulative package depth" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {sizeTicks.map((tick) => (
            <g key={`s${tick}`}>
              <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={y(tick)} y2={y(tick)} stroke={CHART_COLORS.grid} />
              <text x={PLOT.left + plotWidth + 8} y={y(tick) + 4} className={styles.axisText}>{compactNumber(tick)}</text>
            </g>
          ))}
          <path d={stepPath(model.bids.map((level) => ({ price: level.price, value: level.direct })), "bid", true)} fill={CHART_COLORS.upFill} stroke={CHART_COLORS.up} strokeWidth={1.5} />
          <path d={stepPath(model.asks.map((level) => ({ price: level.price, value: level.direct })), "ask", true)} fill={CHART_COLORS.downFill} stroke={CHART_COLORS.down} strokeWidth={1.5} />
          <path d={stepPath(model.bids.map((level) => ({ price: level.price, value: level.total })), "bid", false)} fill="none" stroke={CHART_COLORS.implied} strokeDasharray="4 3" strokeWidth={1} />
          <path d={stepPath(model.asks.map((level) => ({ price: level.price, value: level.total })), "ask", false)} fill="none" stroke={CHART_COLORS.implied} strokeDasharray="4 3" strokeWidth={1} />
          <line x1={x(model.mid)} x2={x(model.mid)} y1={DEPTH_TOP - 6} y2={baseline} stroke={CHART_COLORS.crosshair} strokeDasharray="2 3" />
          <text x={x(model.mid)} y={DEPTH_TOP - 12} textAnchor="middle" className={styles.axisTextStrong}>Mid {model.mid.toFixed(2)} {unit}</text>
          <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={baseline} y2={baseline} stroke={CHART_COLORS.border} />
          {priceTicks.map((tick) => (
            <text key={`p${tick}`} x={x(tick)} y={baseline + 16} textAnchor="middle" className={styles.axisText}>{tick.toFixed(1)}</text>
          ))}
          {hover ? (
            <g pointerEvents="none">
              <line x1={hover.x} x2={hover.x} y1={DEPTH_TOP} y2={baseline} stroke={CHART_COLORS.priceLine} strokeDasharray="3 3" />
              <circle cx={hover.x} cy={y(hover.direct)} r={3.5} fill={hover.side === "bid" ? CHART_COLORS.up : CHART_COLORS.down} />
            </g>
          ) : null}
        </svg>
      ) : null}
      {hover ? (
        <div className={styles.depthTooltip} style={{ left: Math.min(Math.max(hover.x + 12, 8), Math.max(8, width - 196)) }}>
          <span>Price</span><strong>{hover.price.toFixed(1)} {unit}</strong>
          <span>Direct cumulative</span><strong>{hover.direct.toLocaleString("en-US")}</strong>
          <span>With implied</span><strong className={styles.impliedCell}>{hover.total.toLocaleString("en-US")}</strong>
        </div>
      ) : null}
      <div className={styles.chartKey}>
        <span><i className={styles.keyBid} />Direct bids</span>
        <span><i className={styles.keyAsk} />Direct asks</span>
        <span><i className={styles.keyImplied} />Direct plus implied</span>
      </div>
    </div>
  );
}

function parseMetric(snapshot: TerminalViewModel, pattern: RegExp): number | null {
  const raw = snapshot.market.metrics.find((entry) => pattern.test(entry.label))?.value;
  if (raw === undefined) return null;
  const parsed = Number(raw.replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Model-derived payoff of entering the package now and exiting at a given basis: size times spot
 * times the basis change, less the previewed fees, with optional funding at the snapshot rate.
 * This is an analytic view, not a quote.
 */
function PayoffChart({ feed, snapshot, preview, size }: { feed: MarketFeed; snapshot: TerminalViewModel; preview: TerminalPreview | null; size: string }) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const [withFunding, setWithFunding] = useState(false);
  const [hoverBasis, setHoverBasis] = useState<number | null>(null);
  const spot = parseMetric(snapshot, /spot/i);
  const fundingRate = parseMetric(snapshot, /funding/i);
  const holdingDays = Number(/(\d+)D$/i.exec(snapshot.market.packageId)?.[1] ?? "30");
  const quantity = Number(size);
  // The latest basis candle, else the snapshot's observed basis; never an assumed zero, which would
  // move break-even and the convergence payoff by the whole basis.
  const observedBasis = useMemo(() => feed.candles("basis", "1m").at(-1)?.close ?? null, [feed]);
  const basisKnown = observedBasis ?? parseMetric(snapshot, /^basis$/i);
  const entryBasis = basisKnown ?? 0;
  const fees = preview ? Number(preview.totalFee.value) : 0;
  const sized = spot !== null && Number.isFinite(quantity) && quantity > 0;
  const valid = sized && basisKnown !== null;
  const notional = valid ? quantity * spot : 0;
  const funding = withFunding && fundingRate !== null ? notional * (fundingRate / 100) * (holdingDays / 365) : 0;
  const pnl = (exitBasis: number) => notional * ((entryBasis - exitBasis) / 10_000) - fees + funding;
  const low = Math.floor((entryBasis - 80) / 10) * 10;
  const high = Math.ceil((entryBasis + 40) / 10) * 10;
  const values = [pnl(low), pnl(high), 0];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const pad = (maximum - minimum) * 0.12 || 1;
  const plotWidth = Math.max(0, width - PLOT.left - PLOT.right);
  const plotHeight = Math.max(0, height - PLOT.top - PLOT.bottom - 8);
  const x = (basis: number) => PLOT.left + ((basis - low) / (high - low)) * plotWidth;
  const y = (value: number) => PLOT.top + plotHeight - ((value - (minimum - pad)) / (maximum - minimum + 2 * pad)) * plotHeight;
  const breakeven = notional > 0 ? entryBasis - ((fees - funding) * 10_000) / notional : entryBasis;
  const converge = pnl(0);
  // Days of funding at the snapshot rate that repay the previewed fees if basis exits where it entered.
  const dailyFunding = fundingRate !== null && fundingRate > 0 ? (notional * fundingRate) / 100 / 365 : 0;
  const paybackDays = valid && dailyFunding > 0 ? fees / dailyFunding : null;
  const zeroY = y(0);
  const basisTicks = niceTicks(low, high, 6);
  const pnlTicks = niceTicks(minimum - pad, maximum + pad, 5);
  const hoverValue = hoverBasis === null ? null : pnl(hoverBasis);

  return (
    <div className={styles.payoffHost}>
      <div className={styles.payoffStats}>
        <div><span>Entry basis</span><strong>{basisKnown === null ? "-" : `${entryBasis.toFixed(1)} bps`}</strong></div>
        <div><span>Notional</span><strong>{valid ? `$${notional.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "-"}</strong></div>
        <div><span>Break-even exit</span><strong>{valid ? `${breakeven.toFixed(1)} bps` : "-"}</strong></div>
        <div title="Days of funding at the current rate that repay the previewed fees, exiting at the entry basis"><span>Fee payback</span><strong>{paybackDays === null ? "-" : `${paybackDays < 10 ? paybackDays.toFixed(1) : Math.round(paybackDays)} days`}</strong></div>
        <div><span>At full convergence</span><strong className={converge >= 0 ? styles.up : styles.down}>{valid ? `${converge >= 0 ? "+" : "-"}$${Math.abs(converge).toFixed(2)}` : "-"}</strong></div>
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={withFunding} disabled={fundingRate === null} onChange={(event) => setWithFunding(event.target.checked)} />
          Funding {fundingRate === null ? "unavailable" : `${fundingRate.toFixed(2)}% for ${holdingDays}D`}
        </label>
        <span className={styles.labelModel} title="Analytic model from snapshot reference values. Not a quote.">MODEL</span>
      </div>
      <div ref={ref} className={styles.svgHost}>
        {width > 0 && height > 0 && valid ? (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Package payoff by exit basis"
            onMouseMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const basis = low + ((event.clientX - bounds.left - PLOT.left) / (plotWidth || 1)) * (high - low);
              setHoverBasis(basis >= low && basis <= high ? basis : null);
            }}
            onMouseLeave={() => setHoverBasis(null)}
          >
            {pnlTicks.map((tick) => (
              <g key={`v${tick}`}>
                <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={y(tick)} y2={y(tick)} stroke={CHART_COLORS.grid} />
                <text x={PLOT.left + plotWidth + 8} y={y(tick) + 4} className={styles.axisText}>{compactNumber(tick)}</text>
              </g>
            ))}
            <defs>
              <clipPath id="payoff-profit"><rect x={PLOT.left} y={PLOT.top} width={plotWidth} height={Math.max(0, zeroY - PLOT.top)} /></clipPath>
              <clipPath id="payoff-loss"><rect x={PLOT.left} y={zeroY} width={plotWidth} height={Math.max(0, PLOT.top + plotHeight - zeroY)} /></clipPath>
            </defs>
            <path d={`M${x(low)},${y(pnl(low))}L${x(high)},${y(pnl(high))}L${x(high)},${zeroY}L${x(low)},${zeroY}Z`} fill={CHART_COLORS.upFill} clipPath="url(#payoff-profit)" />
            <path d={`M${x(low)},${y(pnl(low))}L${x(high)},${y(pnl(high))}L${x(high)},${zeroY}L${x(low)},${zeroY}Z`} fill={CHART_COLORS.downFill} clipPath="url(#payoff-loss)" />
            <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={zeroY} y2={zeroY} stroke={CHART_COLORS.priceLine} strokeWidth={1} />
            <line x1={x(low)} y1={y(pnl(low))} x2={x(high)} y2={y(pnl(high))} stroke={CHART_COLORS.brand} strokeWidth={2} />
            <line x1={x(entryBasis)} x2={x(entryBasis)} y1={PLOT.top} y2={PLOT.top + plotHeight} stroke={CHART_COLORS.crosshair} strokeDasharray="2 3" />
            <text x={x(entryBasis)} y={PLOT.top - 6} textAnchor="middle" className={styles.axisTextStrong}>Entry {entryBasis.toFixed(1)}</text>
            {breakeven >= low && breakeven <= high ? (
              <g>
                <circle cx={x(breakeven)} cy={zeroY} r={3.5} fill={CHART_COLORS.brand} />
                <text x={x(breakeven) + 8} y={zeroY - 8} textAnchor="start" className={styles.axisTextStrong}>Break-even {breakeven.toFixed(1)}</text>
              </g>
            ) : null}
            {basisTicks.map((tick) => (
              <text key={`b${tick}`} x={x(tick)} y={PLOT.top + plotHeight + 20} textAnchor="middle" className={styles.axisText}>{tick.toFixed(0)}</text>
            ))}
            {hoverBasis !== null && hoverValue !== null ? (
              <g pointerEvents="none">
                <line x1={x(hoverBasis)} x2={x(hoverBasis)} y1={PLOT.top} y2={PLOT.top + plotHeight} stroke={CHART_COLORS.priceLine} strokeDasharray="3 3" />
                <circle cx={x(hoverBasis)} cy={y(hoverValue)} r={3.5} fill={hoverValue >= 0 ? CHART_COLORS.up : CHART_COLORS.down} />
              </g>
            ) : null}
          </svg>
        ) : null}
        {!valid ? (
          <div className={styles.chartLoading}>
            {sized ? "The payoff needs an observed basis; none is available for this lane yet." : "Enter a package size to model the payoff."}
          </div>
        ) : null}
        {hoverBasis !== null && hoverValue !== null ? (
          <div className={styles.depthTooltip} style={{ left: Math.min(Math.max(x(hoverBasis) + 12, 8), Math.max(8, width - 196)) }}>
            <span>Exit basis</span><strong>{hoverBasis.toFixed(1)} bps</strong>
            <span>Package PnL</span><strong className={hoverValue >= 0 ? styles.up : styles.down}>{hoverValue >= 0 ? "+" : "-"}${Math.abs(hoverValue).toFixed(2)}</strong>
          </div>
        ) : null}
      </div>
      <p className={styles.chartFootnote}>Exit basis in bps on the horizontal axis; PnL in USDC. Includes previewed fees{withFunding ? " and funding at the snapshot rate" : ", excludes funding"}. Not a quote.</p>
    </div>
  );
}

/** The chart area: price chart, cumulative depth, and a model payoff view of the package. */
export function ChartWorkspace({
  feed,
  snapshot,
  preview,
  size,
}: {
  feed: MarketFeed;
  snapshot: TerminalViewModel;
  preview: TerminalPreview | null;
  size: string;
}) {
  const [view, setView] = usePersistedSetting<ChartView>("chart.view", "chart", VIEWS.map((entry) => entry.id));
  const panelRef = useRef<HTMLElement>(null);
  function toggleFullscreen() {
    const panel = panelRef.current;
    if (panel === null) return;
    if (document.fullscreenElement === panel) void document.exitFullscreen();
    else void panel.requestFullscreen?.().catch(() => undefined);
  }
  return (
    <section ref={panelRef} className={styles.chartPanel} aria-label="Package chart">
      <div className={styles.panelTabs} role="tablist" aria-label="Chart view" onKeyDown={handleTablistKeys}>
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={view === entry.id}
            className={view === entry.id ? styles.tabActive : undefined}
            onClick={() => setView(entry.id)}
          >
            {entry.label}
          </button>
        ))}
        <span className={feed.label === "FIXTURE" ? styles.labelFixture : styles.labelObserved} title={feed.sourceNote}>{feed.label}</span>
        <button type="button" className={styles.iconButton} aria-label="Toggle full screen" title="Full screen" onClick={toggleFullscreen}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M13.5 10v3.5H10M10 2.5h3.5V6M6 13.5H2.5V10" /></svg>
        </button>
      </div>
      <div key={view} className={styles.viewFade}>
        {view === "chart" ? <PriceChart feed={feed} /> : null}
        {view === "depth" ? <div className={styles.chartBody}><DepthChart feed={feed} unit={feed.book?.unit ?? "bps"} /></div> : null}
        {view === "payoff" ? <div className={styles.chartBody}><PayoffChart feed={feed} snapshot={snapshot} preview={preview} size={size} /></div> : null}
      </div>
    </section>
  );
}
