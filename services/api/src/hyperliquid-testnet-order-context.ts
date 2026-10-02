import { exactPrice, type AssetRef, type ExactPrice, type RoundingDirection } from "@naryx/protocol-types";
import type { ActiveOrderContext, ActiveOrderContextProvider } from "./canonical-entry-order.js";
import {
  hyperliquidTestnetLotAtoms,
  type HyperliquidTestnetRuntimeConfig,
} from "./hyperliquid-testnet-runtime-client.js";
import {
  parseHyperliquidDecimal,
  type HyperliquidTestnetPriceSnapshot,
  type HyperliquidTestnetPriceSource,
} from "./hyperliquid-testnet-price-feed.js";
import type { InternalOrderClockPort } from "./terminal-orders.js";

const BPS_SCALE = 10_000n;
/** A package owner is the user's own EVM wallet: lowercase, nonzero. */
export const HYPERLIQUID_TESTNET_OWNER_PATTERN = /^0x(?!0{40}$)[0-9a-f]{40}$/;

export type HyperliquidTestnetOrderRuntime = Readonly<{
  contexts: ActiveOrderContextProvider;
  clock: InternalOrderClockPort;
  terminalContext: HyperliquidTestnetTerminalContext;
}>;

/**
 * Every package is owned by the wallet that signs its authorization and settles in Naryx's single
 * funded Testnet trading account, which executes it on the owner's behalf.
 */
export type HyperliquidTestnetTerminalContext = Readonly<{
  contextId: string;
  tradingAccount: string;
  domain: Readonly<{
    domainId: string;
    domainManifestVersion: number;
    domainManifestHash: string;
  }>;
  environment: "TESTNET";
  authorizationMode: "OWNER_SIGNED_OMNIBUS_ACCOUNT";
  maxOpenPackagesPerOwner: number | null;
}>;

// Quote units per base unit, as an exact fraction of decimal Hyperliquid prices.
type Fraction = Readonly<{ numerator: bigint; denominator: bigint }>;

/** Exit bounds for one package from the live books, rounded against the trader. Integer atoms. */
export type HyperliquidTestnetExitLimits = Readonly<{
  minSpotQuoteOutAtoms: bigint;
  maxPerpBuyPrice: ExactPrice;
  minExitQuoteOutcomeAtoms: bigint;
}>;

export type HyperliquidTestnetLivePrices = Readonly<{
  spotReferencePrice: ExactPrice;
  minPerpSellPrice: ExactPrice;
  residualValuationReferencePrice: ExactPrice;
  maxRecoverySpotBuyPrice: ExactPrice;
  minRecoverySpotSellPrice: ExactPrice;
  minRecoveryPerpSellPrice: ExactPrice;
  maxRecoveryPerpBuyPrice: ExactPrice;
  maxNetSpotShortfallBps: number;
}>;

function gcd(left: bigint, right: bigint): bigint {
  let first = left;
  let second = right;
  while (second !== 0n) [first, second] = [second, first % second];
  return first;
}

function decimalFraction(value: string, name: string): Fraction {
  const parsed = parseHyperliquidDecimal(value, name);
  return { numerator: parsed.digits, denominator: 10n ** BigInt(parsed.scale) };
}

function midpoint(bid: string, ask: string, name: string): Fraction {
  const low = decimalFraction(bid, `${name} bid`);
  const high = decimalFraction(ask, `${name} ask`);
  return {
    numerator: low.numerator * high.denominator + high.numerator * low.denominator,
    denominator: 2n * low.denominator * high.denominator,
  };
}

function scaled(value: Fraction, bps: bigint): Fraction {
  return { numerator: value.numerator * bps, denominator: value.denominator * BPS_SCALE };
}

function atomPrice(
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  value: Fraction,
  roundingDirection: RoundingDirection,
): ExactPrice {
  const quoteAtoms = value.numerator * 10n ** BigInt(quoteAsset.decimals);
  const baseAtoms = value.denominator * 10n ** BigInt(baseAsset.decimals);
  const divisor = gcd(quoteAtoms, baseAtoms);
  return exactPrice({
    baseAsset,
    quoteAsset,
    quoteAtoms: quoteAtoms / divisor,
    baseAtoms: baseAtoms / divisor,
    roundingDirection,
  });
}

// Every bound is exact. The rounding tag is how the adapter, solver, and keeper format it onto the
// HyperCore price grid, and each checks the wire price against the exact bound: a sell floor must
// round its wire price up (CEIL) and a buy cap must round it down (FLOOR) to stay inside the bound.
export function deriveHyperliquidTestnetLivePrices(
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  snapshot: HyperliquidTestnetPriceSnapshot,
  maxSlippageBps: number,
  recoveryBandBps: number,
  feeShortfallSlackBps: number,
): HyperliquidTestnetLivePrices {
  const price = (value: Fraction, direction: RoundingDirection) =>
    atomPrice(baseAsset, quoteAsset, value, direction);
  const band = BigInt(recoveryBandBps);
  const spotMid = midpoint(snapshot.spot.bid, snapshot.spot.ask, "spot");
  const perpMid = midpoint(snapshot.perp.bid, snapshot.perp.ask, "perpetual");
  const spotFee = decimalFraction(snapshot.spotTakerRate, "spotTakerRate");
  const feeBps = (spotFee.numerator * BPS_SCALE + spotFee.denominator - 1n) / spotFee.denominator;
  return Object.freeze({
    spotReferencePrice: price(decimalFraction(snapshot.spot.ask, "spot ask"), "CEIL"),
    minPerpSellPrice: price(
      scaled(decimalFraction(snapshot.perp.bid, "perpetual bid"), BPS_SCALE - BigInt(maxSlippageBps)),
      "CEIL",
    ),
    residualValuationReferencePrice: price(spotMid, "CEIL"),
    maxRecoverySpotBuyPrice: price(scaled(spotMid, BPS_SCALE + band), "FLOOR"),
    minRecoverySpotSellPrice: price(scaled(spotMid, BPS_SCALE - band), "CEIL"),
    minRecoveryPerpSellPrice: price(scaled(perpMid, BPS_SCALE - band), "CEIL"),
    maxRecoveryPerpBuyPrice: price(scaled(perpMid, BPS_SCALE + band), "FLOOR"),
    maxNetSpotShortfallBps: Number(feeBps) + feeShortfallSlackBps,
  });
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The spot leg must return at least the spot bid less the slippage on the package's spot (rounded
 * down); the short is bought back at no more than the perpetual ask plus the slippage. The outcome
 * floor is those proceeds less the spot taker fee, plus the entry notional less the worst-case
 * buy-back notional and its taker fee, every fee rounded up; a negative floor becomes zero.
 */
export function deriveHyperliquidTestnetExitLimits(
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  snapshot: HyperliquidTestnetPriceSnapshot,
  spotQuantityAtoms: bigint,
  perpQuantityAtoms: bigint,
  entryNotionalAtoms: bigint,
  slippageBps: number,
): HyperliquidTestnetExitLimits {
  if (spotQuantityAtoms <= 0n || perpQuantityAtoms <= 0n || entryNotionalAtoms <= 0n
    || !Number.isSafeInteger(slippageBps) || slippageBps < 1 || slippageBps >= 10_000) {
    throw new Error("Hyperliquid exit inputs are invalid.");
  }
  const slippage = BigInt(slippageBps);
  const bid = scaled(decimalFraction(snapshot.spot.bid, "spot bid"), BPS_SCALE - slippage);
  const baseScale = 10n ** BigInt(baseAsset.decimals);
  const quoteScale = 10n ** BigInt(quoteAsset.decimals);
  const minSpotQuoteOutAtoms = (spotQuantityAtoms * bid.numerator * quoteScale) / (bid.denominator * baseScale);
  const ask = scaled(decimalFraction(snapshot.perp.ask, "perpetual ask"), BPS_SCALE + slippage);
  const maxPerpBuyPrice = atomPrice(baseAsset, quoteAsset, ask, "FLOOR");
  const maxCloseNotional = ceilDivide(perpQuantityAtoms * maxPerpBuyPrice.quoteAtoms, maxPerpBuyPrice.baseAtoms);
  const spotFee = decimalFraction(snapshot.spotTakerRate, "spotTakerRate");
  const perpFee = decimalFraction(snapshot.perpTakerRate, "perpTakerRate");
  const outcome = minSpotQuoteOutAtoms
    - ceilDivide(minSpotQuoteOutAtoms * spotFee.numerator, spotFee.denominator)
    + entryNotionalAtoms - maxCloseNotional
    - ceilDivide(maxCloseNotional * perpFee.numerator, perpFee.denominator);
  if (minSpotQuoteOutAtoms <= 0n) throw new Error("Hyperliquid exit spot proceeds floor is zero.");
  return Object.freeze({
    minSpotQuoteOutAtoms,
    maxPerpBuyPrice,
    minExitQuoteOutcomeAtoms: outcome > 0n ? outcome : 0n,
  });
}

export function createHyperliquidTestnetOrderRuntime(
  config: HyperliquidTestnetRuntimeConfig,
  priceFeed: HyperliquidTestnetPriceSource,
  currentTimeMs: () => number = Date.now,
): HyperliquidTestnetOrderRuntime {
  const order = config.orderContext;
  if (order === undefined) throw new Error("Hyperliquid Testnet order context is missing.");
  if (typeof priceFeed?.latest !== "function") throw new Error("Hyperliquid Testnet price feed is missing.");
  const readClock = (): bigint => {
    const value = currentTimeMs();
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Hyperliquid Testnet millisecond clock is invalid.");
    }
    return BigInt(value);
  };
  // A size must fill whole units on both the spot and the perpetual size grids.
  const quantityStepAtoms = hyperliquidTestnetLotAtoms(
    order.baseAsset.decimals,
    Math.min(config.market.spot.sizeDecimals, config.market.perpetual.sizeDecimals),
  );
  let cached: Readonly<{ snapshot: HyperliquidTestnetPriceSnapshot; context: ActiveOrderContext }> | undefined;
  const contexts: ActiveOrderContextProvider = (contextId) => {
    if (contextId !== order.contextId) return undefined;
    const snapshot = priceFeed.latest();
    if (snapshot === undefined || !Number.isSafeInteger(snapshot.capturedAtMs) || snapshot.capturedAtMs <= 0) {
      return undefined;
    }
    if (cached?.snapshot === snapshot) return cached.context;
    const prices = deriveHyperliquidTestnetLivePrices(
      order.baseAsset,
      order.quoteAsset,
      snapshot,
      order.maxSlippageBps,
      order.livePricing.recoveryBandBps,
      order.livePricing.feeShortfallSlackBps,
    );
    const context: ActiveOrderContext = Object.freeze({
      contextId: order.contextId,
      state: "ACTIVE",
      capturedAtClock: BigInt(snapshot.capturedAtMs),
      maxStaleness: order.maxStalenessMs,
      domain: config.domain,
      environment: "testnet",
      orderVersion: order.orderVersion,
      templateId: order.templateId,
      templateVersion: order.templateVersion,
      packageTemplateManifestHash: order.packageTemplateManifestHash,
      baseAsset: order.baseAsset,
      quoteAsset: order.quoteAsset,
      spotAdapters: [order.spotAdapter],
      perpAdapters: [order.perpetualAdapter],
      settlementClass: "BATCHED_IOC_WITH_RECOVERY",
      expiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
      expiryTtl: order.expiryTtlMs,
      spotReferencePrice: prices.spotReferencePrice,
      maxEntrySpread: order.maxEntrySpread,
      maximumQuantityAtoms: order.maximumQuantityAtoms,
      quantityStepAtoms,
      maxSlippageBps: order.maxSlippageBps,
      maxVenueFeeAtomsByAsset: order.maxVenueFeeAtomsByAsset,
      maxMarginAddedAtoms: order.maxMarginAddedAtoms,
      maxProtocolFeeAtoms: order.maxProtocolFeeAtoms,
      maxSolverFeeAtoms: order.maxSolverFeeAtoms,
      maxPriorityFeeAtoms: order.maxPriorityFeeAtoms,
      minVenueReserveReturnedAtoms: order.minVenueReserveReturnedAtoms,
      minWalletQuoteBalanceDeltaAtoms: order.minWalletQuoteBalanceDeltaAtoms,
      maxResidualBaseQuantityAtoms: order.maxResidualBaseQuantityAtoms,
      ownerPattern: HYPERLIQUID_TESTNET_OWNER_PATTERN,
      requiredSettlementAccount: order.tradingAccount,
      hyperliquidQuantityPolicy: "BOUNDED_NET",
      hyperliquidMaxNetSpotShortfallAtoms: order.maxNetSpotShortfallAtoms,
      hyperliquidMaxNetSpotShortfallBps: prices.maxNetSpotShortfallBps,
      hyperliquidMaxNetSpotExcessAtoms: order.maxNetSpotExcessAtoms,
      hyperliquidMaxTerminalResidualBaseQuantityAtoms:
        order.maxTerminalResidualBaseQuantityAtoms,
      hyperliquidMaxTerminalResidualQuoteValueAtoms:
        order.maxTerminalResidualQuoteValueAtoms,
      hyperliquidResidualValuationReferencePrice: prices.residualValuationReferencePrice,
      hyperliquidMinPerpSellPrice: prices.minPerpSellPrice,
      hyperliquidRecoveryExpiryTtl: order.recoveryActionExpiryTtlMs,
      hyperliquidRecoveryDeadlineTtl: order.recoveryDeadlineTtlMs,
      hyperliquidMinRecoveryWindowMs: order.minRecoveryWindowMs,
      maxRecoverySpotBuyPrice: prices.maxRecoverySpotBuyPrice,
      minRecoverySpotSellPrice: prices.minRecoverySpotSellPrice,
      minRecoveryPerpSellPrice: prices.minRecoveryPerpSellPrice,
      maxRecoveryPerpBuyPrice: prices.maxRecoveryPerpBuyPrice,
      maxRecoveryCostAtomsByAsset: order.maxRecoveryCostAtomsByAsset,
      maxAggregateRecoveryLossQuoteAtoms: order.maxAggregateRecoveryLossQuoteAtoms,
      allowedRecoveryActions: Object.freeze([
        "CANCEL_OPEN_ORDERS",
        "COMPLETE_SPOT",
        "COMPLETE_PERP",
        "ROLLBACK_SPOT",
        "ROLLBACK_PERP",
      ] as const),
    });
    cached = Object.freeze({ snapshot, context });
    return context;
  };
  const clock: InternalOrderClockPort = Object.freeze({
    currentClock: async (context: ActiveOrderContext) => {
      if (context.contextId !== order.contextId) {
        throw new Error("Hyperliquid Testnet order context is unknown.");
      }
      return readClock();
    },
  });
  const terminalContext: HyperliquidTestnetTerminalContext = Object.freeze({
    contextId: order.contextId,
    tradingAccount: order.tradingAccount,
    domain: Object.freeze({
      domainId: config.domain.domainId,
      domainManifestVersion: config.domain.domainManifestVersion,
      domainManifestHash: Buffer.from(config.domain.domainManifestHash).toString("hex"),
    }),
    environment: "TESTNET",
    authorizationMode: "OWNER_SIGNED_OMNIBUS_ACCOUNT",
    maxOpenPackagesPerOwner: config.omnibus?.maxOpenPackagesPerOwner ?? null,
  });
  return Object.freeze({ contexts, clock, terminalContext });
}
