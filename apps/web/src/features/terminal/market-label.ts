import type { PublicPackageMarket } from "./public-market-feed";
import { chainOf } from "@/features/brand/chain-icons";

type MarketIdentity = Pick<PublicPackageMarket, "packageMarketId"> & Partial<Pick<PublicPackageMarket, "templateId" | "underlyingRefs" | "domainIds">>;

const ASSET_LABELS: Readonly<Record<string, string>> = {
  So11111111111111111111111111111111111111112: "SOL",
  C1nHUYTHx7rrtsy5fdJ1RkAtaYgQxG9VX7jnCJcpBNBf: "USDC",
  "hypercore:testnet:pobtc": "BTC",
  "hypercore:testnet:usdc": "USDC",
};

export function marketAssetLabel(value: string | null): string {
  if (value === null) return "-";
  const normalized = value.toLowerCase();
  const known = ASSET_LABELS[value] ?? ASSET_LABELS[normalized];
  if (known !== undefined) return known;
  if (normalized.startsWith("asset:naryx-test-usdc:")) return "USDC";
  if (normalized.startsWith("asset:naryx-test-base:")) return "WETH";
  return value.length > 22 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

const STRATEGY_NAMES: readonly [string, string][] = [
  ["cash-and-carry", "Cash and carry"],
  ["reverse-basis", "Reverse basis"],
  ["calendar-spread", "Calendar spread"],
  ["option-spread", "Option spread"],
  ["funding-spread", "Funding spread"],
  ["collateral-conversion", "Collateral conversion"],
  ["treasury-inventory-hedge", "Treasury hedge"],
  ["treasury-hedge", "Treasury hedge"],
  ["delta-rebalance", "Delta rebalance"],
  ["hedge-migration", "Hedge migration"],
];

export function packageMarketUnderlying(market: MarketIdentity): string {
  const reference = market.underlyingRefs?.[0];
  if (reference) {
    const label = marketAssetLabel(reference);
    if (label.length <= 8) return label;
  }
  const identity = market.packageMarketId.toLowerCase();
  if (identity.startsWith("btc-")) return "BTC";
  if (identity.startsWith("solana-")) return "SOL";
  if (identity.startsWith("base-") || identity.startsWith("arbitrum-")) return "WETH";
  return "Market";
}

export function packageMarketName(market: MarketIdentity): string {
  const marketId = market.packageMarketId.toLowerCase();
  const templateId = market.templateId?.toLowerCase() ?? "";
  const strategy = STRATEGY_NAMES.find(([token]) => marketId.includes(token))?.[1]
    ?? STRATEGY_NAMES.find(([token]) => templateId.includes(token))?.[1]
    ?? "Package market";
  return `${packageMarketUnderlying(market)} ${strategy}`;
}

export function packageMarketVariant(market: MarketIdentity): string | null {
  const identity = market.packageMarketId;
  const domain = identity.match(/-domain-(\d+)-/);
  const version = identity.match(/-v(\d+)$/);
  if (domain) return `Series ${domain[1]}${version ? ` v${version[1]}` : ""}`;
  return version ? `Version ${version[1]}` : null;
}

export function packageMarketChainName(market: MarketIdentity): string {
  const candidate = market.domainIds?.[0] ?? market.packageMarketId;
  return chainOf(candidate)?.name ?? (market.packageMarketId.startsWith("btc-") ? "Hyperliquid" : "Other chain");
}
