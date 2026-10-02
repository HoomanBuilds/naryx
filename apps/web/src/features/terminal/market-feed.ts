import type { TerminalViewModel } from "./terminal-view-model";

export type ChartInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type ChartSeriesKey = "basis" | "spot" | "perp";
/**
 * FIXTURE is deterministic local data, OBSERVED is the public package book and tape, and REFERENCE
 * is the private API's recorded samples of each lane's live spot and perp references.
 */
export type FeedLabel = "FIXTURE" | "OBSERVED" | "REFERENCE";

export const CHART_INTERVALS: readonly { id: ChartInterval; label: string; seconds: number }[] = [
  { id: "1m", label: "1m", seconds: 60 },
  { id: "5m", label: "5m", seconds: 300 },
  { id: "15m", label: "15m", seconds: 900 },
  { id: "1h", label: "1H", seconds: 3_600 },
  { id: "4h", label: "4H", seconds: 14_400 },
  { id: "1d", label: "1D", seconds: 86_400 },
];
export const CHART_SERIES: readonly ChartSeriesKey[] = ["basis", "spot", "perp"];
/** The chart's persisted selection; a feed that fetches per series reads the same settings. */
export const CHART_INTERVAL_SETTING = { key: "chart.interval", fallback: "15m" } as const;
export const CHART_SERIES_SETTING = { key: "chart.series", fallback: "basis" } as const;

export interface Candle {
  /** Bucket open time in UTC seconds. */
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface DepthLevel {
  readonly price: number;
  /** Resting signed package orders. */
  readonly direct: number;
  /** Derived from leg sources; never merged into direct size. */
  readonly implied: number;
}

export interface TapeTrade {
  readonly id: string;
  readonly time: number;
  readonly price: number;
  readonly size: number;
  /** The taker's side: BID lifted the ask, ASK hit the bid. */
  readonly side: "BID" | "ASK";
  readonly source: "DIRECT" | "IMPLIED";
}

export interface SeriesMeta {
  readonly title: string;
  readonly unit: string;
  readonly precision: number;
  /** Set when this series comes from a different source than the feed's own label. */
  readonly label?: FeedLabel;
  readonly note?: string;
  /** False when the candles carry no volume. */
  readonly volume?: boolean;
  /** What the chart says when the series has no candles in the window. */
  readonly empty?: { readonly title: string; readonly detail: string };
}

export interface MarketFeed {
  /** FIXTURE data is deterministic local data and is never presented as market data. */
  readonly label: FeedLabel;
  readonly sourceNote: string;
  /** Unit and precision of depth and tape prices when they differ from the basis series. */
  readonly book?: { readonly unit: string; readonly precision: number };
  candles(series: ChartSeriesKey, interval: ChartInterval): readonly Candle[];
  depth(): { readonly bids: readonly DepthLevel[]; readonly asks: readonly DepthLevel[]; readonly tick: number };
  tape(): readonly TapeTrade[];
  seriesMeta(series: ChartSeriesKey): SeriesMeta;
}

const CANDLE_COUNT = 320;

/** A small, fast, seedable generator so every render of the fixture is identical. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seedFrom(text: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value.replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : fallback;
}

function metric(snapshot: TerminalViewModel, pattern: RegExp): string | undefined {
  return snapshot.market.metrics.find((entry) => pattern.test(entry.label))?.value;
}

interface PathPoint {
  spot: number;
  perp: number;
}

/**
 * Builds a deterministic spot and perpetual path that ends exactly at the snapshot's reference
 * prices. Spot follows a random walk scaled to the interval; basis mean-reverts around the
 * reference basis. Intrabar sub-steps give every candle a real high and low.
 */
function buildPath(snapshot: TerminalViewModel, interval: ChartInterval): { times: number[]; bars: PathPoint[][] } {
  const spotReference = parseNumber(metric(snapshot, /spot/i), 148.24);
  const perpReference = parseNumber(metric(snapshot, /perp/i), spotReference * 1.0056);
  const basisReference = (perpReference / spotReference - 1) * 10_000;
  const seconds = CHART_INTERVALS.find((entry) => entry.id === interval)?.seconds ?? 3_600;
  const anchorMs = Date.parse(snapshot.environment.capturedAt);
  const anchor = Math.floor((Number.isFinite(anchorMs) ? anchorMs : Date.UTC(2026, 0, 1)) / 1_000 / seconds) * seconds;
  const random = mulberry32(seedFrom(`${snapshot.market.packageId}:${interval}`));
  const steps = 6;
  const spotVolPerBar = 0.72 * Math.sqrt(seconds / 31_536_000);
  // Basis is an Ornstein-Uhlenbeck process around the reference with a slow regime drift, scaled
  // so each interval shows a plausible stationary range rather than bar-to-bar noise.
  const stationaryBps = Math.min(16, 1.2 + 2.2 * Math.log2(1 + seconds / 300));
  const reversion = 0.02;
  const basisStep = stationaryBps * 0.028;
  const regimeAmplitude = stationaryBps * 0.6;
  const regimePhase = random() * Math.PI * 2;
  const ripplePhase = random() * Math.PI * 2;
  const bars: PathPoint[][] = [];
  let logSpot = 0;
  let basis = basisReference;
  for (let bar = 0; bar < CANDLE_COUNT; bar += 1) {
    const points: PathPoint[] = [];
    for (let step = 0; step < steps; step += 1) {
      const progress = (bar * steps + step) / (CANDLE_COUNT * steps);
      const regime = basisReference +
        regimeAmplitude * Math.sin(regimePhase + progress * Math.PI * 3.2) +
        regimeAmplitude * 0.35 * Math.sin(ripplePhase + progress * Math.PI * 17);
      logSpot += (spotVolPerBar / Math.sqrt(steps)) * gaussian(random);
      basis += reversion * (regime - basis) + basisStep * gaussian(random);
      points.push({ spot: logSpot, perp: basis });
    }
    bars.push(points);
  }
  // Shift the walk so the final close equals the reference prices exactly.
  const last = bars[bars.length - 1]?.[steps - 1] ?? { spot: 0, perp: basisReference };
  const spotShift = Math.log(spotReference) - last.spot;
  const basisShift = basisReference - last.perp;
  const shaped = bars.map((points) =>
    points.map((point) => {
      const spot = Math.exp(point.spot + spotShift);
      const perpBasis = point.perp + basisShift;
      return { spot, perp: spot * (1 + perpBasis / 10_000) };
    }),
  );
  const times = shaped.map((_, index) => anchor - (CANDLE_COUNT - 1 - index) * seconds);
  return { times, bars: shaped };
}

function toCandles(times: number[], bars: PathPoint[][], pick: (point: PathPoint) => number, random: () => number, volumeScale: number): Candle[] {
  let previousClose: number | undefined;
  return bars.map((points, index) => {
    const values = points.map(pick);
    const open = previousClose ?? values[0] ?? 0;
    const close = values[values.length - 1] ?? open;
    previousClose = close;
    const high = Math.max(open, ...values);
    const low = Math.min(open, ...values);
    const volume = volumeScale * Math.exp(0.6 * gaussian(random)) * (1 + Math.abs(close - open) / Math.max(Math.abs(open), 1e-9) * 40);
    return { time: times[index] ?? 0, open, high, low, close, volume };
  });
}

/**
 * Deterministic local market data for the conformance terminal. Every surface that shows it must
 * carry the FIXTURE label; none of these numbers are market observations.
 */
export function fixtureMarketFeed(snapshot: TerminalViewModel): MarketFeed {
  const cache = new Map<string, Candle[]>();
  const series = (key: ChartSeriesKey, interval: ChartInterval): Candle[] => {
    const cacheKey = `${key}:${interval}`;
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const { times, bars } = buildPath(snapshot, interval);
    const random = mulberry32(seedFrom(`${snapshot.market.packageId}:${interval}:${key}:volume`));
    const pick = key === "spot"
      ? (point: PathPoint) => point.spot
      : key === "perp"
        ? (point: PathPoint) => point.perp
        : (point: PathPoint) => (point.perp / point.spot - 1) * 10_000;
    const candles = toCandles(times, bars, pick, random, key === "basis" ? 180 : 2_400);
    cache.set(cacheKey, candles);
    return candles;
  };

  const depth = () => {
    const closes = series("basis", "1m");
    const mid = closes[closes.length - 1]?.close ?? 56;
    const tick = 0.5;
    const random = mulberry32(seedFrom(`${snapshot.market.packageId}:depth`));
    // Centre the direct book on the last basis so the book mid matches the chart's last price.
    const centre = Math.round(mid / tick) * tick;
    const bestBid = centre - tick;
    const bestAsk = centre + tick;
    const ladder = (start: number, direction: 1 | -1): DepthLevel[] =>
      Array.from({ length: 16 }, (_, index) => {
        const direct = index % 5 === 3 ? 0 : Math.round((20 + index * 9) * (0.5 + random()) / 10) * 10;
        const implied = index % 3 === 1 ? Math.round((30 + index * 6) * random() / 10) * 10 : 0;
        return { price: start + direction * index * tick, direct, implied };
      }).filter((level) => level.direct + level.implied > 0);
    return { bids: ladder(bestBid, -1), asks: ladder(bestAsk, 1), tick };
  };

  const tape = () => {
    const candles = series("basis", "1m");
    const random = mulberry32(seedFrom(`${snapshot.market.packageId}:tape`));
    const trades: TapeTrade[] = [];
    for (let index = candles.length - 1; index >= 0 && trades.length < 60; index -= 1) {
      const candle = candles[index];
      if (candle === undefined) break;
      const count = 1 + Math.floor(random() * 2);
      for (let fill = 0; fill < count; fill += 1) {
        const side = random() > 0.5 ? "BID" : "ASK";
        trades.push({
          id: `${candle.time}-${fill}`,
          time: candle.time + Math.floor(random() * 59),
          price: Math.round((candle.low + (candle.high - candle.low) * random()) * 2) / 2,
          size: Math.round((10 + random() * 90) / 10) * 10,
          side,
          source: random() > 0.75 ? "IMPLIED" : "DIRECT",
        });
      }
    }
    return trades.sort((left, right) => right.time - left.time);
  };

  return {
    label: "FIXTURE",
    sourceNote: "Deterministic fixture model anchored to the conformance snapshot. Not market data.",
    candles: series,
    depth,
    tape,
    seriesMeta(key) {
      const empty = { title: "No candles in this window", detail: "The fixture has no candles for this interval." };
      if (key === "basis") return { title: `${snapshot.market.packageId} basis`, unit: "bps", precision: 1, empty };
      if (key === "spot") return { title: `${snapshot.market.base} spot reference`, unit: snapshot.market.quote, precision: 3, empty };
      return { title: `${snapshot.market.base} perpetual reference`, unit: snapshot.market.quote, precision: 3, empty };
    },
  };
}
