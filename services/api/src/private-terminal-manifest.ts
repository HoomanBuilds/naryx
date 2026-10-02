import { baseSepoliaSpotAsk, type BaseSepoliaOrderRuntime } from "./base-sepolia-order-context.js";
import type { HyperliquidTestnetPriceSource } from "./hyperliquid-testnet-price-feed.js";
import type { HyperliquidTestnetRuntimeConfig } from "./hyperliquid-testnet-runtime-client.js";
import type { DomainId, QuoteMode, SlippageBps } from "./terminal-types.js";
import type { SolanaDevnetOrderRuntime } from "./solana-devnet-order-context.js";

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

/**
 * The display symbol of an asset id: its last colon-separated segment, upper-cased. An operator-chosen
 * id without a plain symbol segment shows the fallback; without one it is refused.
 */
export function terminalAssetSymbol(assetId: string, fallback?: string): string {
  const symbol = assetId.slice(assetId.lastIndexOf(":") + 1).toUpperCase();
  if (SYMBOL.test(symbol)) return symbol;
  if (fallback !== undefined) return fallback;
  throw new Error(`Asset ${assetId} has no terminal symbol.`);
}

export function createHyperliquidTestnetMarketSource(
  config: HyperliquidTestnetRuntimeConfig,
  priceFeed: HyperliquidTestnetPriceSource,
): TerminalMarketSource {
  const order = config.orderContext;
  if (order === undefined) throw new Error("Hyperliquid Testnet order context is missing.");
  const base = terminalAssetSymbol(order.baseAsset.assetId);
  const quote = terminalAssetSymbol(order.quoteAsset.assetId);
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

const DISPLAY_DIGITS = 8;

/** A nonnegative ratio as a decimal string, truncated to eight fractional digits. */
export function decimalString(numerator: bigint, denominator: bigint): string {
  const scale = 10n ** BigInt(DISPLAY_DIGITS);
  const scaled = (numerator * scale) / denominator;
  const fraction = (scaled % scale).toString().padStart(DISPLAY_DIGITS, "0").replace(/0+$/, "");
  return fraction.length === 0 ? (scaled / scale).toString() : `${scaled / scale}.${fraction}`;
}

/**
 * Base Sepolia: spot is the Uniswap V3 pool mid with the pool fee as the taker rate (the configured
 * spot port swaps there); the perpetual is the test market's Chainlink price with its half spread
 * and taker fee. Every value comes from the live feed, never from the manifest.
 */
export function createBaseSepoliaMarketSource(
  runtime: Pick<BaseSepoliaOrderRuntime, "config" | "feed">,
): TerminalMarketSource {
  const { config, feed } = runtime;
  const base = terminalAssetSymbol(config.baseAsset.assetId, "WETH");
  const quote = terminalAssetSymbol(config.quoteAsset.assetId, "USDC");
  const descriptor: TerminalMarketDescriptor = Object.freeze({
    environment: "TESTNET",
    packageId: config.contextId,
    baseSymbol: base,
    quoteSymbol: quote,
    baseDecimals: config.baseAsset.decimals,
    quoteDecimals: config.quoteAsset.decimals,
    maximumSizeAtoms: config.maximumQuantityAtoms,
    maxSlippageBps: config.maxSlippageBps,
    maxStalenessMs: Number(config.maxStalenessSeconds) * 1_000,
    settlement: Object.freeze({ label: "Atomic postcondition", detail: "One transaction, verifier-checked" }),
    spot: Object.freeze({ instrument: `${base} / ${quote}`, venue: "Uniswap V3 on Base Sepolia" }),
    perp: Object.freeze({ instrument: `${base}-PERP`, venue: "Naryx test perpetual (Chainlink-priced)" }),
  });
  const unitScale = 10n ** BigInt(config.baseAsset.decimals - config.quoteAsset.decimals);
  return Object.freeze({
    descriptor,
    latest(): TerminalMarketObservation | undefined {
      const snapshot = feed.latest();
      if (snapshot === undefined) return undefined;
      const mid = baseSepoliaSpotAsk(config.baseAsset, config.quoteAsset, { ...snapshot, poolFee: 0n });
      const spot = decimalString(mid.quoteAtoms * unitScale, mid.baseAtoms);
      const oracleScale = 10n ** BigInt(snapshot.oracleDecimals) * 10_000n;
      return Object.freeze({
        spotBid: spot,
        spotAsk: spot,
        perpBid: decimalString(snapshot.oracleAnswer * (10_000n - snapshot.halfSpreadBps), oracleScale),
        perpAsk: decimalString(snapshot.oracleAnswer * (10_000n + snapshot.halfSpreadBps), oracleScale),
        spotTakerRate: decimalString(snapshot.poolFee, 1_000_000n),
        perpTakerRate: decimalString(snapshot.takerFeeBps, 10_000n),
        capturedAtMs: snapshot.observedAtMs,
      });
    },
  });
}

/**
 * Solana Devnet: the perpetual is the Naryx test perp priced from the live Pyth SOL/USD
 * PriceUpdateV2 account with its half spread and taker fee; spot is the solver's firm inventory,
 * quoted at the same oracle plus the configured inventory spread. Every value comes from the live
 * finalized read, never from the manifest.
 */
export function createSolanaDevnetMarketSource(
  runtime: Pick<SolanaDevnetOrderRuntime, "config" | "feed">,
): TerminalMarketSource {
  const { config, feed } = runtime;
  // Solana asset ids are mint addresses, so the symbols come from the package identity.
  const base = PRIVATE_TERMINAL_PACKAGE_MANIFEST_V1.baseSymbol;
  const quote = PRIVATE_TERMINAL_PACKAGE_MANIFEST_V1.quoteSymbol;
  const descriptor: TerminalMarketDescriptor = Object.freeze({
    environment: "DEVNET",
    packageId: config.contextId,
    baseSymbol: base,
    quoteSymbol: quote,
    baseDecimals: config.baseAsset.decimals,
    quoteDecimals: config.quoteAsset.decimals,
    maximumSizeAtoms: config.maximumQuantityAtoms,
    maxSlippageBps: config.maxSlippageBps,
    // About 0.4 seconds per slot; the order context itself enforces staleness in slots.
    maxStalenessMs: Number(config.maxStalenessSlots) * 400,
    settlement: Object.freeze({ label: "Atomic postcondition", detail: "Firm reservation, one transaction" }),
    spot: Object.freeze({ instrument: `${base} / ${quote}`, venue: "Naryx solver inventory on Solana Devnet" }),
    perp: Object.freeze({ instrument: `${base}-PERP`, venue: "Naryx test perpetual (Pyth-priced)" }),
  });
  return Object.freeze({
    descriptor,
    latest(): TerminalMarketObservation | undefined {
      const snapshot = feed.latest();
      if (snapshot === undefined) return undefined;
      // Quote units per base unit = price per lot * 10^baseDecimals / (lot atoms * 10^quoteDecimals).
      const numerator = snapshot.oraclePricePerLot * 10n ** BigInt(config.baseAsset.decimals);
      const denominator = snapshot.market.baseLotAtoms * 10n ** BigInt(config.quoteAsset.decimals) * 10_000n;
      const at = (bps: number) => decimalString(numerator * BigInt(10_000 + bps), denominator);
      const halfSpread = snapshot.market.halfSpreadBps;
      return Object.freeze({
        spotBid: at(-config.inventorySpreadBps),
        spotAsk: at(config.inventorySpreadBps),
        perpBid: at(-halfSpread),
        perpAsk: at(halfSpread),
        spotTakerRate: "0",
        perpTakerRate: decimalString(BigInt(snapshot.market.takerFeeBps), 10_000n),
        capturedAtMs: snapshot.observedAtMs,
      });
    },
  });
}
