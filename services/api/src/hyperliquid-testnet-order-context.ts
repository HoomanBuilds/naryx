import { exactPrice, type AssetRef, type ExactPrice, type RoundingDirection } from "@naryx/protocol-types";
import type { ActiveOrderContext, ActiveOrderContextProvider } from "./canonical-entry-order.js";
import type { HyperliquidTestnetRuntimeConfig } from "./hyperliquid-testnet-runtime-client.js";
import {
  parseHyperliquidDecimal,
  type HyperliquidTestnetPriceSnapshot,
  type HyperliquidTestnetPriceSource,
} from "./hyperliquid-testnet-price-feed.js";
import type { InternalOrderClockPort } from "./terminal-orders.js";

const BPS_SCALE = 10_000n;

export type HyperliquidTestnetOrderRuntime = Readonly<{
  contexts: ActiveOrderContextProvider;
  clock: InternalOrderClockPort;
  terminalContext: HyperliquidTestnetTerminalContext;
}>;

export type HyperliquidTestnetTerminalContext = Readonly<{
  contextId: string;
  tradingAccount: string;
  domain: Readonly<{
    domainId: string;
    domainManifestVersion: number;
    domainManifestHash: string;
  }>;
  environment: "TESTNET";
  authorizationMode: "CONFIGURED_DEDICATED_TESTNET_ACCOUNT_GATE";
}>;

// Quote units per base unit, as an exact fraction of decimal Hyperliquid prices.
type Fraction = Readonly<{ numerator: bigint; denominator: bigint }>;

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
      maxSlippageBps: order.maxSlippageBps,
      maxVenueFeeAtomsByAsset: order.maxVenueFeeAtomsByAsset,
      maxMarginAddedAtoms: order.maxMarginAddedAtoms,
      maxProtocolFeeAtoms: order.maxProtocolFeeAtoms,
      maxSolverFeeAtoms: order.maxSolverFeeAtoms,
      maxPriorityFeeAtoms: order.maxPriorityFeeAtoms,
      minVenueReserveReturnedAtoms: order.minVenueReserveReturnedAtoms,
      minWalletQuoteBalanceDeltaAtoms: order.minWalletQuoteBalanceDeltaAtoms,
      maxResidualBaseQuantityAtoms: order.maxResidualBaseQuantityAtoms,
      requiredOwner: order.tradingAccount,
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
    authorizationMode: "CONFIGURED_DEDICATED_TESTNET_ACCOUNT_GATE",
  });
  return Object.freeze({ contexts, clock, terminalContext });
}
