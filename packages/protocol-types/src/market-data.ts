import { checkedSigned, checkedUnsigned, mulDiv, ROUNDING } from './arithmetic.js';
import { MalformedInputError } from './errors.js';
import type { PackageBookLevel, PackageBookSide } from './package-matching.js';

export const MARKET_DATA_METHODOLOGY_VERSION = 1;
const MAX_TRADES = 100_000;
const MAX_CANDLES = 5_000;
const I128_BITS = 128;
const U128_BITS = 128;

/**
 * Every published number states what it is. Only EXECUTABLE values come from firm, direct
 * liquidity; OBSERVED values are recorded trades; INDICATIVE and MODEL_DERIVED values are never
 * executable; FIXTURE values are deterministic local data and never market data.
 */
export const DATA_LABEL = Object.freeze({
  OBSERVED: 1,
  EXECUTABLE: 2,
  INDICATIVE: 3,
  MODEL_DERIVED: 4,
  FIXTURE: 5,
} as const);
export type DataLabel = keyof typeof DATA_LABEL;

export const CANDLE_INTERVAL_MS = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
} as const);
export type CandleInterval = keyof typeof CANDLE_INTERVAL_MS;

export interface TapeTrade {
  readonly timeMs: number;
  readonly priceTicks: bigint;
  readonly quantity: bigint;
}

export interface PackageCandle {
  /** Inclusive bucket start, aligned to the interval in UTC. */
  readonly openTimeMs: number;
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  readonly volume: bigint;
  readonly tradeCount: number;
}

export interface CandleSeries {
  readonly label: DataLabel;
  readonly interval: CandleInterval;
  readonly methodologyVersion: number;
  readonly candles: readonly PackageCandle[];
}

function interval(value: CandleInterval, context: string): number {
  if (!Object.hasOwn(CANDLE_INTERVAL_MS, value)) throw new MalformedInputError(context, `unknown candle interval ${String(value)}`);
  return CANDLE_INTERVAL_MS[value];
}

function time(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new MalformedInputError(context, 'expected nonnegative safe-integer milliseconds');
  return value;
}

function label(value: DataLabel, context: string): DataLabel {
  if (!Object.hasOwn(DATA_LABEL, value)) throw new MalformedInputError(context, `unknown data label ${String(value)}`);
  return value;
}

/**
 * Aggregates trades into OHLCV candles in UTC-aligned buckets. Trades are ordered by time with
 * input order breaking ties, so open and close are deterministic. Empty buckets produce no candle;
 * a chart shows a gap rather than an invented price.
 */
export function aggregateCandles(
  trades: readonly TapeTrade[],
  bucket: CandleInterval,
  dataLabel: DataLabel,
  window?: { readonly fromMs: number; readonly toMs: number },
): CandleSeries {
  const width = interval(bucket, 'aggregateCandles.interval');
  const checkedLabel = label(dataLabel, 'aggregateCandles.label');
  if (checkedLabel === 'EXECUTABLE' || checkedLabel === 'INDICATIVE') {
    throw new MalformedInputError('aggregateCandles.label', 'candles are built from trades; label them OBSERVED, MODEL_DERIVED, or FIXTURE');
  }
  if (!Array.isArray(trades) || trades.length > MAX_TRADES) throw new MalformedInputError('aggregateCandles.trades', `expected at most ${MAX_TRADES} trades`);
  const from = window === undefined ? 0 : time(window.fromMs, 'aggregateCandles.fromMs');
  const to = window === undefined ? Number.MAX_SAFE_INTEGER : time(window.toMs, 'aggregateCandles.toMs');
  if (to <= from) throw new MalformedInputError('aggregateCandles.window', 'window is empty');
  const ordered = trades
    .map((trade, index) => {
      const at = `aggregateCandles.trades[${index}]`;
      if (typeof trade !== 'object' || trade === null) throw new MalformedInputError(at, 'expected an object');
      if (typeof trade.priceTicks !== 'bigint' || typeof trade.quantity !== 'bigint') throw new MalformedInputError(at, 'expected bigint price and quantity');
      const quantity = checkedUnsigned(trade.quantity, U128_BITS, `${at}.quantity`);
      if (quantity === 0n) throw new MalformedInputError(`${at}.quantity`, 'quantity is zero');
      return { timeMs: time(trade.timeMs, `${at}.timeMs`), priceTicks: checkedSigned(trade.priceTicks, I128_BITS, `${at}.priceTicks`), quantity, index };
    })
    .filter((trade) => trade.timeMs >= from && trade.timeMs < to)
    .sort((a, b) => a.timeMs - b.timeMs || a.index - b.index);
  const candles: PackageCandle[] = [];
  for (const trade of ordered) {
    const openTimeMs = trade.timeMs - (trade.timeMs % width);
    const last = candles[candles.length - 1];
    if (last === undefined || last.openTimeMs !== openTimeMs) {
      if (candles.length >= MAX_CANDLES) throw new MalformedInputError('aggregateCandles', `more than ${MAX_CANDLES} candles; narrow the window`);
      candles.push({ openTimeMs, open: trade.priceTicks, high: trade.priceTicks, low: trade.priceTicks, close: trade.priceTicks, volume: trade.quantity, tradeCount: 1 });
      continue;
    }
    candles[candles.length - 1] = {
      openTimeMs,
      open: last.open,
      high: trade.priceTicks > last.high ? trade.priceTicks : last.high,
      low: trade.priceTicks < last.low ? trade.priceTicks : last.low,
      close: trade.priceTicks,
      volume: last.volume + trade.quantity,
      tradeCount: last.tradeCount + 1,
    };
  }
  return Object.freeze({
    label: checkedLabel,
    interval: bucket,
    methodologyVersion: MARKET_DATA_METHODOLOGY_VERSION,
    candles: Object.freeze(candles.map((candle) => Object.freeze(candle))),
  });
}

export interface SizeQuote {
  readonly size: bigint;
  /** Size-weighted average price, rounded against the taker; absent when depth is insufficient. */
  readonly averagePriceTicks?: bigint;
  readonly fillableQuantity: bigint;
  readonly label: DataLabel;
}

export interface ExecutablePackageIndex {
  readonly methodologyVersion: number;
  readonly bestBidTicks?: bigint;
  readonly bestAskTicks?: bigint;
  readonly spreadTicks?: bigint;
  /** Bid and ask at each size from direct liquidity only: EXECUTABLE. */
  readonly executable: { readonly bids: readonly SizeQuote[]; readonly asks: readonly SizeQuote[] };
  /** Bid and ask at each size including implied liquidity: INDICATIVE, never executable. */
  readonly withImplied: { readonly bids: readonly SizeQuote[]; readonly asks: readonly SizeQuote[] };
}

function walk(levels: readonly PackageBookLevel[], side: PackageBookSide, size: bigint, includeImplied: boolean): SizeQuote {
  let remaining = size;
  let notional = 0n;
  for (const level of levels) {
    if (remaining === 0n) break;
    const available = level.directQuantity + (includeImplied ? level.impliedQuantity : 0n);
    const take = available < remaining ? available : remaining;
    notional += take * level.priceTicks;
    remaining -= take;
  }
  const fillable = size - remaining;
  const dataLabel: DataLabel = includeImplied ? 'INDICATIVE' : 'EXECUTABLE';
  if (remaining > 0n) return Object.freeze({ size, fillableQuantity: fillable, label: dataLabel });
  // A taker buying from asks pays the rounded-up average; a taker selling into bids receives the rounded-down one.
  const averagePriceTicks = mulDiv(notional, 1n, size, side === 'ASK' ? ROUNDING.CEIL : ROUNDING.FLOOR, 'executablePackageIndex.average');
  return Object.freeze({ size, averagePriceTicks, fillableQuantity: fillable, label: dataLabel });
}

function orderedLevels(levels: readonly PackageBookLevel[], side: PackageBookSide, context: string): readonly PackageBookLevel[] {
  if (!Array.isArray(levels)) throw new MalformedInputError(context, 'expected an array');
  const checked = levels.map((level, index) => {
    const at = `${context}[${index}]`;
    if (typeof level !== 'object' || level === null) throw new MalformedInputError(at, 'expected an object');
    return {
      priceTicks: checkedSigned(level.priceTicks, I128_BITS, `${at}.priceTicks`),
      directQuantity: checkedUnsigned(level.directQuantity, U128_BITS, `${at}.directQuantity`),
      impliedQuantity: checkedUnsigned(level.impliedQuantity, U128_BITS, `${at}.impliedQuantity`),
    };
  });
  return checked.sort((a, b) => (side === 'BID' ? (a.priceTicks > b.priceTicks ? -1 : 1) : a.priceTicks < b.priceTicks ? -1 : 1));
}

/**
 * The executable package index at requested sizes. Direct liquidity yields EXECUTABLE averages;
 * adding implied liquidity yields a separate INDICATIVE series, so the two are never merged.
 */
export function executablePackageIndex(
  bids: readonly PackageBookLevel[],
  asks: readonly PackageBookLevel[],
  sizes: readonly bigint[],
): ExecutablePackageIndex {
  if (!Array.isArray(sizes) || sizes.length === 0 || sizes.length > 16) throw new MalformedInputError('executablePackageIndex.sizes', 'expected 1 to 16 sizes');
  const checkedSizes = sizes.map((size, index) => {
    const value = checkedUnsigned(size, U128_BITS, `executablePackageIndex.sizes[${index}]`);
    if (value === 0n) throw new MalformedInputError(`executablePackageIndex.sizes[${index}]`, 'size is zero');
    return value;
  });
  const bidLevels = orderedLevels(bids, 'BID', 'executablePackageIndex.bids');
  const askLevels = orderedLevels(asks, 'ASK', 'executablePackageIndex.asks');
  const bestBid = bidLevels.find((level) => level.directQuantity > 0n)?.priceTicks;
  const bestAsk = askLevels.find((level) => level.directQuantity > 0n)?.priceTicks;
  const base = {
    methodologyVersion: MARKET_DATA_METHODOLOGY_VERSION,
    executable: Object.freeze({
      bids: Object.freeze(checkedSizes.map((size) => walk(bidLevels, 'BID', size, false))),
      asks: Object.freeze(checkedSizes.map((size) => walk(askLevels, 'ASK', size, false))),
    }),
    withImplied: Object.freeze({
      bids: Object.freeze(checkedSizes.map((size) => walk(bidLevels, 'BID', size, true))),
      asks: Object.freeze(checkedSizes.map((size) => walk(askLevels, 'ASK', size, true))),
    }),
  };
  return Object.freeze({
    ...base,
    ...(bestBid === undefined ? {} : { bestBidTicks: bestBid }),
    ...(bestAsk === undefined ? {} : { bestAskTicks: bestAsk }),
    ...(bestBid === undefined || bestAsk === undefined ? {} : { spreadTicks: bestAsk - bestBid }),
  });
}
