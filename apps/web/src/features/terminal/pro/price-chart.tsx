"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  CandlestickData,
  HistogramData,
  IChartApi,
  ISeriesApi,
  LineData,
  MouseEventParams,
  SeriesType,
  Time,
  UTCTimestamp,
  WhitespaceData,
} from "lightweight-charts";
import {
  CHART_INTERVAL_SETTING,
  CHART_INTERVALS,
  CHART_SERIES_SETTING,
  type Candle,
  type ChartInterval,
  type ChartSeriesKey,
  type MarketFeed,
} from "../market-feed";
import { usePersistedFlag, usePersistedSetting } from "../persisted-setting";
import { CHART_COLORS } from "./chart-colors";
import styles from "./pro.module.css";

type ChartStyle = "candles" | "bars" | "line" | "area";

const CHART_STYLES: readonly { id: ChartStyle; label: string; icon: ReactNode }[] = [
  {
    id: "candles",
    label: "Candles",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.5 1.5v3M4.5 11v3.5M11.5 1.5V5M11.5 12.5v2" />
        <rect x="2.75" y="4.5" width="3.5" height="6.5" rx="0.5" />
        <rect x="9.75" y="5" width="3.5" height="7.5" rx="0.5" className={styles.iconFill} />
      </svg>
    ),
  },
  {
    id: "bars",
    label: "Bars",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.5 2v12M2.5 5h2M4.5 11h2M11.5 3v11M9.5 6h2M11.5 12h2" />
      </svg>
    ),
  },
  {
    id: "line",
    label: "Line",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1.5 12.5 5.5 7l3 3 6-7.5" />
      </svg>
    ),
  },
  {
    id: "area",
    label: "Area",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1.5 12 5.5 6.5l3 3 6-7v12h-13Z" className={styles.iconFill} />
        <path d="M1.5 12 5.5 6.5l3 3 6-7" />
      </svg>
    ),
  },
];

const SERIES: readonly { id: ChartSeriesKey; label: string }[] = [
  { id: "basis", label: "Basis" },
  { id: "spot", label: "Spot" },
  { id: "perp", label: "Perp" },
];

function movingAverage(candles: readonly Candle[], length: number): LineData<Time>[] {
  const points: LineData<Time>[] = [];
  let sum = 0;
  candles.forEach((candle, index) => {
    sum += candle.close;
    if (index >= length) sum -= candles[index - length]?.close ?? 0;
    if (index >= length - 1) points.push({ time: candle.time as UTCTimestamp, value: sum / length });
  });
  return points;
}

function formatValue(value: number, precision: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision });
}

function formatVolume(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(0);
}

interface ChartSeries {
  readonly chart: IChartApi;
  readonly price: ISeriesApi<SeriesType>;
  /** Candles and bars take OHLC points; line and area take close values. */
  readonly ohlc: boolean;
  readonly volume: ISeriesApi<"Histogram"> | undefined;
  readonly averages: readonly { readonly series: ISeriesApi<"Line">; readonly length: number }[];
  byTime: Map<number, Candle>;
}

/** Whitespace slots filled into gaps, beyond which each further gap gets a single slot. */
const MAX_GAP_SLOTS = 2_000;

/**
 * The candles with an empty slot for every missing bucket between them, so a gap in the data
 * reads as a gap on the time axis instead of adjacent bars, and a line or area breaks across it.
 */
function withGaps(candles: readonly Candle[], seconds: number): (Candle | WhitespaceData<Time>)[] {
  const slots: (Candle | WhitespaceData<Time>)[] = [];
  let budget = MAX_GAP_SLOTS;
  let previous: number | undefined;
  for (const candle of candles) {
    if (previous !== undefined && candle.time - previous > seconds) {
      slots.push({ time: (previous + seconds) as UTCTimestamp });
      for (let time = previous + 2 * seconds; time < candle.time && budget > 0; time += seconds, budget -= 1) {
        slots.push({ time: time as UTCTimestamp });
      }
    }
    slots.push(candle);
    previous = candle.time;
  }
  return slots;
}

function applyCandles(target: ChartSeries, candles: readonly Candle[], seconds: number): void {
  const slots = withGaps(candles, seconds);
  const time = (slot: Candle | WhitespaceData<Time>) => slot.time as UTCTimestamp;
  const isCandle = (slot: Candle | WhitespaceData<Time>): slot is Candle => "close" in slot;
  if (target.ohlc) {
    target.price.setData(slots.map((slot): CandlestickData<Time> | WhitespaceData<Time> => isCandle(slot)
      ? { time: time(slot), open: slot.open, high: slot.high, low: slot.low, close: slot.close }
      : { time: time(slot) }));
  } else {
    target.price.setData(slots.map((slot) => isCandle(slot) ? { time: time(slot), value: slot.close } : { time: time(slot) }));
  }
  target.volume?.setData(
    slots.map((slot): HistogramData<Time> | WhitespaceData<Time> => isCandle(slot)
      ? { time: time(slot), value: slot.volume, color: slot.close >= slot.open ? CHART_COLORS.upVolume : CHART_COLORS.downVolume }
      : { time: time(slot) }),
  );
  for (const average of target.averages) average.series.setData(movingAverage(candles, average.length));
  target.byTime = new Map(candles.map((candle) => [candle.time, candle]));
}

interface Legend {
  candle: Candle;
  change: number;
  changePercent: number;
}

/**
 * The price chart: candles, bars, line, or area over six intervals, with volume, two moving
 * averages, a crosshair OHLCV legend, and a watermark whenever the feed is fixture data. It
 * renders only on the client; the canvas library is loaded on mount.
 */
export function PriceChart({ feed }: { feed: MarketFeed }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ChartSeries | null>(null);
  const [interval, setChartInterval] = usePersistedSetting<ChartInterval>(CHART_INTERVAL_SETTING.key, CHART_INTERVAL_SETTING.fallback, CHART_INTERVALS.map((entry) => entry.id));
  const [style, setStyle] = usePersistedSetting<ChartStyle>("chart.style", "candles", CHART_STYLES.map((entry) => entry.id));
  const [seriesKey, setSeriesKey] = usePersistedSetting<ChartSeriesKey>(CHART_SERIES_SETTING.key, CHART_SERIES_SETTING.fallback, SERIES.map((entry) => entry.id));
  const [showVolume, setShowVolume] = usePersistedFlag("chart.volume", true);
  const [showMa20, setShowMa20] = usePersistedFlag("chart.ma20", true);
  const [showMa50, setShowMa50] = usePersistedFlag("chart.ma50", false);
  const [legend, setLegend] = useState<Legend | null>(null);
  const [ready, setReady] = useState(false);

  const candles = useMemo(() => feed.candles(seriesKey, interval), [feed, seriesKey, interval]);
  const candlesRef = useRef<readonly Candle[]>(candles);
  const meta = feed.seriesMeta(seriesKey);
  const hasVolume = meta.volume !== false;
  const seconds = CHART_INTERVALS.find((entry) => entry.id === interval)?.seconds ?? 60;
  const lastLegend = useMemo<Legend | null>(() => {
    const last = candles[candles.length - 1];
    if (last === undefined) return null;
    const change = last.close - last.open;
    return { candle: last, change, changePercent: last.open === 0 ? 0 : (change / Math.abs(last.open)) * 100 };
  }, [candles]);

  // The latest candles for a chart that is still loading; data updates never rebuild the chart.
  useEffect(() => {
    candlesRef.current = candles;
  }, [candles]);

  useEffect(() => {
    let disposed = false;
    let chart: IChartApi | null = null;
    const container = containerRef.current;
    if (container === null) return;
    void import("lightweight-charts").then((library) => {
      if (disposed) return;
      const { createChart, createTextWatermark, CandlestickSeries, BarSeries, LineSeries, AreaSeries, HistogramSeries, CrosshairMode, LineStyle } = library;
      const monoFamily = getComputedStyle(container).getPropertyValue("--font-geist-mono").trim();
      chart = createChart(container, {
        autoSize: true,
        layout: {
          background: { color: CHART_COLORS.background },
          textColor: CHART_COLORS.text,
          fontFamily: `${monoFamily === "" ? "" : `${monoFamily}, `}ui-monospace, SFMono-Regular, Menlo, monospace`,
          fontSize: 11,
          attributionLogo: true,
        },
        grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
        rightPriceScale: { borderColor: CHART_COLORS.border, scaleMargins: { top: 0.1, bottom: showVolume && hasVolume ? 0.22 : 0.08 } },
        timeScale: { borderColor: CHART_COLORS.border, timeVisible: interval !== "1d", secondsVisible: false, rightOffset: 6, barSpacing: 6 },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: CHART_COLORS.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CHART_COLORS.label },
          horzLine: { color: CHART_COLORS.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CHART_COLORS.label },
        },
        localization: { locale: "en-US", priceFormatter: (value: number) => formatValue(value, meta.precision) },
      });
      chartRef.current = chart;
      const priceFormat = { type: "price" as const, precision: meta.precision, minMove: 1 / 10 ** meta.precision };
      let price: ISeriesApi<SeriesType>;
      if (style === "candles") {
        price = chart.addSeries(CandlestickSeries, {
          upColor: CHART_COLORS.up,
          downColor: CHART_COLORS.down,
          borderVisible: false,
          wickUpColor: CHART_COLORS.up,
          wickDownColor: CHART_COLORS.down,
          priceFormat,
        });
      } else if (style === "bars") {
        price = chart.addSeries(BarSeries, { upColor: CHART_COLORS.up, downColor: CHART_COLORS.down, thinBars: false, priceFormat });
      } else if (style === "line") {
        price = chart.addSeries(LineSeries, { color: CHART_COLORS.brand, lineWidth: 2, priceFormat });
      } else {
        price = chart.addSeries(AreaSeries, {
          lineColor: CHART_COLORS.brand,
          topColor: CHART_COLORS.brandFillTop,
          bottomColor: CHART_COLORS.brandFillBottom,
          lineWidth: 2,
          priceFormat,
        });
      }
      let volume: ISeriesApi<"Histogram"> | undefined;
      if (showVolume && hasVolume) {
        volume = chart.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
        volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      }
      const averages: { series: ISeriesApi<"Line">; length: number }[] = [];
      for (const [enabled, length, color] of [[showMa20, 20, CHART_COLORS.ma20], [showMa50, 50, CHART_COLORS.ma50]] as const) {
        if (!enabled) continue;
        averages.push({ series: chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }), length });
      }
      if (feed.label === "FIXTURE") {
        const pane = chart.panes()[0];
        if (pane !== undefined) {
          createTextWatermark(pane, {
            horzAlign: "center",
            vertAlign: "center",
            lines: [
              { text: "FIXTURE DATA", color: CHART_COLORS.watermark, fontSize: 40, fontStyle: "600" },
              { text: "Deterministic model. Not market data.", color: CHART_COLORS.watermark, fontSize: 12 },
            ],
          });
        }
      }
      chart.subscribeCrosshairMove((param: MouseEventParams<Time>) => {
        const candle = typeof param.time === "number" ? seriesRef.current?.byTime.get(param.time) : undefined;
        if (candle === undefined) return setLegend(null);
        const change = candle.close - candle.open;
        setLegend({ candle, change, changePercent: candle.open === 0 ? 0 : (change / Math.abs(candle.open)) * 100 });
      });
      price.applyOptions({ priceLineColor: CHART_COLORS.priceLine, priceLineStyle: LineStyle.Dotted });
      seriesRef.current = { chart, price, ohlc: style === "candles" || style === "bars", volume, averages, byTime: new Map() };
      applyCandles(seriesRef.current, candlesRef.current, seconds);
      chart.timeScale().scrollToRealTime();
      setReady(true);
    });
    return () => {
      disposed = true;
      chart?.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [style, showVolume, hasVolume, showMa20, showMa50, feed.label, interval, seconds, meta.precision]);

  // New candles update the series in place, so zoom, scroll, and the crosshair survive live data.
  useEffect(() => {
    const target = seriesRef.current;
    if (target !== null) applyCandles(target, candles, seconds);
  }, [candles, seconds]);

  const shown = legend ?? lastLegend;
  const tone = shown === null ? undefined : shown.change >= 0 ? styles.up : styles.down;
  const intervalLabel = CHART_INTERVALS.find((entry) => entry.id === interval)?.label ?? interval;

  return (
    <>
      <div className={styles.chartToolbar} role="toolbar" aria-label="Chart controls">
        <div className={styles.intervals} role="group" aria-label="Interval">
          {CHART_INTERVALS.map((entry) => (
            <button key={entry.id} type="button" aria-pressed={interval === entry.id} className={interval === entry.id ? styles.intervalActive : undefined} onClick={() => setChartInterval(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <span className={styles.toolbarDivider} aria-hidden="true" />
        <div className={styles.iconGroup} role="group" aria-label="Chart type">
          {CHART_STYLES.map((entry) => (
            <button key={entry.id} type="button" aria-pressed={style === entry.id} aria-label={entry.label} title={entry.label} className={style === entry.id ? styles.iconActive : undefined} onClick={() => setStyle(entry.id)}>
              {entry.icon}
            </button>
          ))}
        </div>
        <span className={styles.toolbarDivider} aria-hidden="true" />
        <div className={styles.intervals} role="group" aria-label="Series">
          {SERIES.map((entry) => (
            <button key={entry.id} type="button" aria-pressed={seriesKey === entry.id} className={seriesKey === entry.id ? styles.intervalActive : undefined} onClick={() => setSeriesKey(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <span className={styles.toolbarDivider} aria-hidden="true" />
        <details className={styles.menu}>
          <summary>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12.5 6 8l3 2.5 5-6" /><path d="M11 4.5h3v3" /></svg>
            Indicators
          </summary>
          <div className={styles.menuPanel} role="group" aria-label="Indicators">
            <label><input type="checkbox" checked={showVolume} onChange={(event) => setShowVolume(event.target.checked)} /> Volume</label>
            <label><input type="checkbox" checked={showMa20} onChange={(event) => setShowMa20(event.target.checked)} /> <i className={styles.swatchMa20} aria-hidden="true" /> MA 20</label>
            <label><input type="checkbox" checked={showMa50} onChange={(event) => setShowMa50(event.target.checked)} /> <i className={styles.swatchMa50} aria-hidden="true" /> MA 50</label>
          </div>
        </details>
        <div className={styles.toolbarEnd}>
          <button type="button" className={styles.iconButton} aria-label="Fit all bars" title="Fit all bars" onClick={() => chartRef.current?.timeScale().fitContent()}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3v10M14 3v10M4.5 8h7M6.5 6 4.5 8l2 2M9.5 6l2 2-2 2" /></svg>
          </button>
          <button type="button" className={styles.iconButton} aria-label="Scroll to latest" title="Scroll to latest" onClick={() => chartRef.current?.timeScale().scrollToRealTime()}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4l4 4-4 4M8 4l4 4-4 4M14 3v10" /></svg>
          </button>
        </div>
      </div>
      <div className={styles.chartBody}>
        <div className={styles.chartLegend} aria-live="off">
          <span className={styles.legendTitle}>{meta.title} <span>{meta.unit}</span> <span>{intervalLabel}</span></span>
          {meta.label === undefined || meta.label === feed.label ? null : (
            <span className={meta.label === "FIXTURE" ? styles.labelFixture : styles.labelObserved} title={meta.note}>{meta.label}</span>
          )}
          {shown === null ? null : (
            <span className={styles.legendValues}>
              <span>O<b className={tone}>{formatValue(shown.candle.open, meta.precision)}</b></span>
              <span>H<b className={tone}>{formatValue(shown.candle.high, meta.precision)}</b></span>
              <span>L<b className={tone}>{formatValue(shown.candle.low, meta.precision)}</b></span>
              <span>C<b className={tone}>{formatValue(shown.candle.close, meta.precision)}</b></span>
              <b className={tone}>
                {shown.change >= 0 ? "+" : ""}{formatValue(shown.change, meta.precision)} ({shown.changePercent >= 0 ? "+" : ""}{shown.changePercent.toFixed(2)}%)
              </b>
            </span>
          )}
          {showVolume && hasVolume && shown !== null ? <span className={styles.legendValues}><span>Vol<b>{formatVolume(shown.candle.volume)}</b></span></span> : null}
          {showMa20 || showMa50 ? (
            <span className={styles.legendValues}>
              {showMa20 ? <span className={styles.legendMa20}>MA 20</span> : null}
              {showMa50 ? <span className={styles.legendMa50}>MA 50</span> : null}
            </span>
          ) : null}
        </div>
        <div ref={containerRef} className={styles.chartCanvas} />
        {ready && candles.length === 0 ? (
          <div className={styles.chartEmpty} role="status">
            <strong>{meta.empty?.title ?? "No candles in this window"}</strong>
            {meta.empty === undefined ? null : <span>{meta.empty.detail}</span>}
          </div>
        ) : null}
        {ready ? null : (
          <div className={styles.chartSkeleton} role="status" aria-label="Loading chart">
            {Array.from({ length: 28 }, (_, index) => (
              <i key={index} style={{ height: `${28 + ((index * 37) % 46)}%` }} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
