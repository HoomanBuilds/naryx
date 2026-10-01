import { formatDecimalAtoms, parseDecimalAtoms } from "./decimal.js";
import type {
  TerminalMarketDescriptor,
  TerminalMarketObservation,
  TerminalMarketSources,
} from "./private-terminal-manifest.js";
import {
  isDomainId,
  isPackageMode,
  isQuoteMode,
  isSlippageBps,
  type DomainId,
  type PreviewLeg,
  type PreviewRequest,
  type PreviewResponse,
} from "./terminal-types.js";

const REQUEST_KEYS = ["domain", "mode", "quoteMode", "size", "slippageBps"] as const;
const SIZE_PATTERN = /^(?:0|[1-9]\d{0,5})(?:\.(\d{1,18}))?$/;
const OBSERVED_DECIMAL = /^(0|[1-9]\d{0,19})(?:\.(\d{1,18}))?$/;
const BPS_SCALE = 10_000n;

export class PreviewValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PreviewValidationError";
    this.code = code;
  }
}

export type TerminalMarketUnavailableCode =
  | "DOMAIN_MARKET_UNAVAILABLE"
  | "SNAPSHOT_UNAVAILABLE"
  | "PREVIEW_UNAVAILABLE";

export class TerminalMarketUnavailableError extends Error {
  readonly code: TerminalMarketUnavailableCode;

  constructor(code: TerminalMarketUnavailableCode, message: string) {
    super(message);
    this.name = "TerminalMarketUnavailableError";
    this.code = code;
  }
}

export type TerminalMarketContext = Readonly<{
  sources: TerminalMarketSources;
  nowMs: number;
  executionAvailable: (domain: DomainId) => boolean;
}>;

// An exact decimal: digits / 10^scale.
export type ObservedDecimal = Readonly<{ digits: bigint; scale: number }>;
type Decimal = ObservedDecimal;

export type ObservedMarket = Readonly<{
  spotBid: Decimal;
  spotAsk: Decimal;
  perpBid: Decimal;
  perpAsk: Decimal;
  spotTakerRate: Decimal;
  perpTakerRate: Decimal;
  capturedAtMs: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePreviewRequest(value: unknown): PreviewRequest {
  if (!isRecord(value)) {
    throw new PreviewValidationError("INVALID_BODY", "Request body must be a JSON object.");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== REQUEST_KEYS.length ||
      !REQUEST_KEYS.every((key, index) => keys[index] === key)) {
    throw new PreviewValidationError(
      "INVALID_FIELDS",
      "Request must contain only domain, mode, size, slippageBps, and quoteMode.",
    );
  }
  if (!isDomainId(value.domain)) {
    throw new PreviewValidationError("INVALID_DOMAIN", "Domain is not supported.");
  }
  if (!isPackageMode(value.mode)) {
    throw new PreviewValidationError("INVALID_MODE", "Mode must be entry or exit.");
  }
  if (typeof value.size !== "string" || !SIZE_PATTERN.test(value.size) || !/[1-9]/.test(value.size)) {
    throw new PreviewValidationError("INVALID_SIZE", "Size must be a positive decimal string.");
  }
  if (!isSlippageBps(value.slippageBps)) {
    throw new PreviewValidationError("INVALID_SLIPPAGE", "Slippage choice is not supported.");
  }
  if (!isQuoteMode(value.quoteMode)) {
    throw new PreviewValidationError("INVALID_QUOTE_MODE", "Quote mode is not supported.");
  }
  return {
    domain: value.domain,
    mode: value.mode,
    size: value.size,
    slippageBps: value.slippageBps,
    quoteMode: value.quoteMode,
  };
}

function observedDecimal(value: unknown): Decimal | undefined {
  if (typeof value !== "string") return undefined;
  const match = OBSERVED_DECIMAL.exec(value);
  if (match === null) return undefined;
  const fraction = match[2] ?? "";
  return { digits: BigInt(`${match[1] as string}${fraction}`), scale: fraction.length };
}

function aligned(left: Decimal, right: Decimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.digits * 10n ** BigInt(scale - left.scale),
    right.digits * 10n ** BigInt(scale - right.scale),
    scale,
  ];
}

function book(bidText: string, askText: string): [Decimal, Decimal] | undefined {
  const bid = observedDecimal(bidText);
  const ask = observedDecimal(askText);
  if (bid === undefined || ask === undefined || bid.digits === 0n) return undefined;
  const [low, high] = aligned(bid, ask);
  return low < high ? [bid, ask] : undefined;
}

function takerRate(text: string): Decimal | undefined {
  const rate = observedDecimal(text);
  return rate !== undefined && rate.digits < 10n ** BigInt(rate.scale) ? rate : undefined;
}

/**
 * Returns the domain's latest observation only when it is well formed and no older than the
 * source's maxStalenessMs; a missing source, a stale, future-dated, crossed, or malformed
 * observation fails closed with a 503 code instead of numbers.
 */
export function resolveTerminalMarket(
  domain: DomainId,
  context: TerminalMarketContext,
  staleCode: "SNAPSHOT_UNAVAILABLE" | "PREVIEW_UNAVAILABLE",
): Readonly<{ descriptor: TerminalMarketDescriptor; market: ObservedMarket }> {
  const source = context.sources[domain];
  if (source === undefined) {
    throw new TerminalMarketUnavailableError(
      "DOMAIN_MARKET_UNAVAILABLE",
      "No live market source is configured for this domain.",
    );
  }
  const market = observedMarket(source.descriptor, source.latest(), context.nowMs);
  if (market === undefined) {
    throw new TerminalMarketUnavailableError(staleCode, "No fresh market observation is available.");
  }
  return { descriptor: source.descriptor, market };
}

export function observedMarket(
  descriptor: TerminalMarketDescriptor,
  observation: TerminalMarketObservation | undefined,
  nowMs: number,
): ObservedMarket | undefined {
  if (observation === undefined || !Number.isSafeInteger(nowMs)) return undefined;
  const capturedAtMs = observation.capturedAtMs;
  if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs <= 0 || capturedAtMs > nowMs ||
      nowMs - capturedAtMs > descriptor.maxStalenessMs) {
    return undefined;
  }
  const spot = book(observation.spotBid, observation.spotAsk);
  const perp = book(observation.perpBid, observation.perpAsk);
  const spotTakerRate = takerRate(observation.spotTakerRate);
  const perpTakerRate = takerRate(observation.perpTakerRate);
  if (spot === undefined || perp === undefined || spotTakerRate === undefined ||
      perpTakerRate === undefined) {
    return undefined;
  }
  return {
    spotBid: spot[0], spotAsk: spot[1], perpBid: perp[0], perpAsk: perp[1],
    spotTakerRate, perpTakerRate, capturedAtMs,
  };
}

export function midpoint(bid: Decimal, ask: Decimal): Decimal {
  const [low, high, scale] = aligned(bid, ask);
  return { digits: (low + high) * 5n, scale: scale + 1 };
}

function withBps(value: Decimal, bps: bigint): Decimal {
  return { digits: value.digits * bps, scale: value.scale + 4 };
}

// Exact: trailing zeros are trimmed down to two fractional digits, never rounded.
export function formatExact(value: Decimal, minimumScale = 2): string {
  let { digits, scale } = value;
  while (scale > minimumScale && digits % 10n === 0n) {
    digits /= 10n;
    scale -= 1;
  }
  if (scale < minimumScale) {
    digits *= 10n ** BigInt(minimumScale - scale);
    scale = minimumScale;
  }
  return scale === 0 ? digits.toString() : formatDecimalAtoms(digits, scale);
}

function divide(numerator: bigint, denominator: bigint, roundUp: boolean): bigint {
  return roundUp ? (numerator + denominator - 1n) / denominator : numerator / denominator;
}

// Quote atoms for sizeAtoms base atoms at an exact price, times an optional exact rate.
function quoteAtoms(
  descriptor: TerminalMarketDescriptor,
  sizeAtoms: bigint,
  price: Decimal,
  roundUp: boolean,
  rate: Decimal = { digits: 1n, scale: 0 },
): bigint {
  const numerator = sizeAtoms * price.digits * rate.digits * 10n ** BigInt(descriptor.quoteDecimals);
  const denominator = 10n ** BigInt(descriptor.baseDecimals + price.scale + rate.scale);
  return divide(numerator, denominator, roundUp);
}

export function quotePrice(descriptor: TerminalMarketDescriptor, value: Decimal): string {
  const text = formatExact(value);
  return descriptor.quoteSymbol === "USDC" || descriptor.quoteSymbol === "USD"
    ? `$${text}`
    : `${text} ${descriptor.quoteSymbol}`;
}

function sizeAtomsFor(descriptor: TerminalMarketDescriptor, request: PreviewRequest): bigint {
  const fraction = request.size.split(".")[1] ?? "";
  if (fraction.length > descriptor.baseDecimals) {
    throw new PreviewValidationError(
      "INVALID_SIZE",
      `Size must have at most ${descriptor.baseDecimals} decimal places for this market.`,
    );
  }
  const sizeAtoms = parseDecimalAtoms(request.size, descriptor.baseDecimals);
  if (sizeAtoms <= 0n || sizeAtoms > descriptor.maximumSizeAtoms) {
    throw new PreviewValidationError("INVALID_SIZE", "Size is outside the supported range.");
  }
  if (request.slippageBps > descriptor.maxSlippageBps) {
    throw new PreviewValidationError("INVALID_SLIPPAGE", "Slippage exceeds the market maximum.");
  }
  return sizeAtoms;
}

function legs(
  descriptor: TerminalMarketDescriptor,
  market: ObservedMarket,
  mode: PreviewRequest["mode"],
  quantity: string,
  slippageBps: bigint,
): PreviewLeg[] {
  const spot = { instrument: descriptor.spot.instrument, venue: descriptor.spot.venue };
  const perp = { instrument: descriptor.perp.instrument, venue: descriptor.perp.venue };
  if (mode === "entry") {
    return [
      {
        sequence: 1, action: "Buy spot", ...spot, quantity,
        limitLabel: "Maximum price",
        limit: quotePrice(descriptor, withBps(market.spotAsk, BPS_SCALE + slippageBps)),
        state: "Preview ready", dependency: "First leg",
      },
      {
        sequence: 2, action: "Short perpetual", ...perp, quantity,
        limitLabel: "Minimum entry",
        limit: quotePrice(descriptor, withBps(market.perpBid, BPS_SCALE - slippageBps)),
        state: "Awaiting leg 1", dependency: "Requires accepted spot receipt",
      },
    ];
  }
  return [
    {
      sequence: 1, action: "Buy to close", ...perp, quantity,
      limitLabel: "Maximum close",
      limit: quotePrice(descriptor, withBps(market.perpAsk, BPS_SCALE + slippageBps)),
      state: "Preview ready", dependency: "First leg",
    },
    {
      sequence: 2, action: "Sell spot", ...spot, quantity,
      limitLabel: "Minimum output",
      limit: quotePrice(descriptor, withBps(market.spotBid, BPS_SCALE - slippageBps)),
      state: "Awaiting leg 1", dependency: "Requires accepted perp close",
    },
  ];
}

/**
 * Preview math over one fresh observation. The entry bound is the canonical order's
 * maxSpotQuoteIn: ceil(size * spot ask * (10000 + slippage) / 10000) in quote atoms. The exit bound
 * is floor(size * spot bid * (10000 - slippage) / 10000). Fees are each leg's notional at the
 * touch price times the observed taker rate, rounded up.
 */
export function previewFromMarket(
  request: PreviewRequest,
  descriptor: TerminalMarketDescriptor,
  market: ObservedMarket,
  executionAvailable: boolean,
): PreviewResponse {
  const sizeAtoms = sizeAtomsFor(descriptor, request);
  const normalizedSize = formatDecimalAtoms(sizeAtoms, descriptor.baseDecimals);
  const slippageBps = BigInt(request.slippageBps);
  const entry = request.mode === "entry";
  const spotPrice = entry ? market.spotAsk : market.spotBid;
  const perpPrice = entry ? market.perpBid : market.perpAsk;
  const spotFee = quoteAtoms(descriptor, sizeAtoms, spotPrice, true, market.spotTakerRate);
  const perpFee = quoteAtoms(descriptor, sizeAtoms, perpPrice, true, market.perpTakerRate);
  const display = (atoms: bigint) => formatDecimalAtoms(atoms, descriptor.quoteDecimals);
  const fees = [
    { label: "Spot taker fee", amountAtoms: spotFee.toString(), value: display(spotFee) },
    { label: "Perp taker fee", amountAtoms: perpFee.toString(), value: display(perpFee) },
  ];
  const totalFeeAtoms = spotFee + perpFee;
  const boundAtoms = entry
    ? quoteAtoms(descriptor, sizeAtoms, withBps(market.spotAsk, BPS_SCALE + slippageBps), true)
    : quoteAtoms(descriptor, sizeAtoms, withBps(market.spotBid, BPS_SCALE - slippageBps), false);

  return {
    source: "PRIVATE_TERMINAL_BFF",
    environment: descriptor.environment,
    capturedAt: new Date(market.capturedAtMs).toISOString(),
    evidenceGrade: "OBSERVED_UNATTESTED",
    executionAvailable,
    domain: request.domain,
    mode: request.mode,
    quoteMode: request.quoteMode,
    size: {
      baseAtoms: sizeAtoms.toString(),
      value: normalizedSize,
      symbol: descriptor.baseSymbol,
    },
    bound: {
      label: entry ? "Maximum quote" : "Minimum output",
      quoteAtoms: boundAtoms.toString(),
      value: display(boundAtoms),
      symbol: descriptor.quoteSymbol,
    },
    fees,
    totalFee: {
      amountAtoms: totalFeeAtoms.toString(),
      value: display(totalFeeAtoms),
      symbol: descriptor.quoteSymbol,
    },
    legs: legs(descriptor, market, request.mode, `${normalizedSize} ${descriptor.baseSymbol}`, slippageBps),
    action: {
      available: false,
      reason: "A preview is not executable; testnet execution runs through the canonical order flow.",
    },
  };
}

export function createTerminalPreview(
  request: PreviewRequest,
  context: TerminalMarketContext,
): PreviewResponse {
  const { descriptor, market } = resolveTerminalMarket(request.domain, context, "PREVIEW_UNAVAILABLE");
  return previewFromMarket(request, descriptor, market, context.executionAvailable(request.domain));
}
