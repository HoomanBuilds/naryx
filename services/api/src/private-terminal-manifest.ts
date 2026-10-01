import type { HyperliquidTestnetPriceSource } from "./hyperliquid-testnet-price-feed.js";
import type { HyperliquidTestnetRuntimeConfig } from "./hyperliquid-testnet-runtime-client.js";
import type { DomainId, QuoteMode, SlippageBps } from "./terminal-types.js";

// Package identity for the Solana Devnet preparation boundary. It carries no prices: terminal
// snapshot and preview numbers come only from a domain's live TerminalMarketSource.
export const PRIVATE_TERMINAL_PACKAGE_MANIFEST_V1 = Object.freeze({
  version: 1,
  packageId: "SOL-CARRY-30D",
  baseSymbol: "SOL" as const,
  quoteSymbol: "USDC" as const,
  baseDecimals: 6,
  quoteDecimals: 6,
  maximumSizeAtoms: 100_000n * 1_000_000n,
  slippageChoices: [5, 10, 25] as readonly SlippageBps[],
  quoteModes: ["coordinated_limits", "indicative_preview"] as readonly QuoteMode[],
  settlementClass: "COORDINATED_ISOLATED_ACCOUNTS",
});

/**
 * One unsigned observation of a domain's spot and perpetual books. Prices and taker rates are
 * nonnegative decimal strings in quote units per base unit; capturedAtMs is the local receipt time.
 */
export type TerminalMarketObservation = Readonly<{
  spotBid: string;
  spotAsk: string;
  perpBid: string;
  perpAsk: string;
  spotTakerRate: string;
  perpTakerRate: string;
  capturedAtMs: number;
}>;

export type TerminalMarketLeg = Readonly<{ instrument: string; venue: string }>;

export type TerminalMarketDescriptor = Readonly<{
  environment: "TESTNET" | "DEVNET";
  packageId: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  maximumSizeAtoms: bigint;
  maxSlippageBps: number;
  maxStalenessMs: number;
  settlement: Readonly<{ label: string; detail: string }>;
  spot: TerminalMarketLeg;
  perp: TerminalMarketLeg;
}>;

/**
 * The per-domain market boundary behind GET /internal/terminal/snapshot and POST
 * /internal/terminal/preview. A domain without a source answers 503 DOMAIN_MARKET_UNAVAILABLE.
 */
export interface TerminalMarketSource {
  readonly descriptor: TerminalMarketDescriptor;
  latest(): TerminalMarketObservation | undefined;
}

export type TerminalMarketSources = Readonly<Partial<Record<DomainId, TerminalMarketSource>>>;

const SYMBOL = /^[A-Z0-9]{1,12}$/;

function assetSymbol(assetId: string): string {
  const symbol = assetId.slice(assetId.lastIndexOf(":") + 1).toUpperCase();
  if (!SYMBOL.test(symbol)) throw new Error(`Asset ${assetId} has no terminal symbol.`);
  return symbol;
}

export function createHyperliquidTestnetMarketSource(
  config: HyperliquidTestnetRuntimeConfig,
  priceFeed: HyperliquidTestnetPriceSource,
): TerminalMarketSource {
  const order = config.orderContext;
  if (order === undefined) throw new Error("Hyperliquid Testnet order context is missing.");
  const base = assetSymbol(order.baseAsset.assetId);
  const quote = assetSymbol(order.quoteAsset.assetId);
  const descriptor: TerminalMarketDescriptor = Object.freeze({
    environment: "TESTNET",
    packageId: order.contextId,
    baseSymbol: base,
    quoteSymbol: quote,
    baseDecimals: order.baseAsset.decimals,
    quoteDecimals: order.quoteAsset.decimals,
    maximumSizeAtoms: order.maximumQuantityAtoms,
    maxSlippageBps: order.maxSlippageBps,
    maxStalenessMs: Number(order.maxStalenessMs),
    settlement: Object.freeze({ label: "Batched IOC", detail: "Bounded recovery" }),
    spot: Object.freeze({ instrument: `${base} / ${quote}`, venue: "Hyperliquid testnet spot" }),
    perp: Object.freeze({ instrument: `${base}-PERP`, venue: "Hyperliquid testnet perpetual" }),
  });
  return Object.freeze({
    descriptor,
    latest(): TerminalMarketObservation | undefined {
      const snapshot = priceFeed.latest();
      return snapshot === undefined ? undefined : Object.freeze({
        spotBid: snapshot.spot.bid,
        spotAsk: snapshot.spot.ask,
        perpBid: snapshot.perp.bid,
        perpAsk: snapshot.perp.ask,
        spotTakerRate: snapshot.spotTakerRate,
        perpTakerRate: snapshot.perpTakerRate,
        capturedAtMs: snapshot.capturedAtMs,
      });
    },
  });
}
