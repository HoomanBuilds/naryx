const ASSET_LABELS: Readonly<Record<string, string>> = {
  So11111111111111111111111111111111111111112: "SOL",
  C1nHUYTHx7rrtsy5fdJ1RkAtaYgQxG9VX7jnCJcpBNBf: "USDC",
  "hypercore:testnet:pobtc": "BTC",
  "hypercore:testnet:usdc": "USDC",
};

export function marketAssetLabel(value: string | null): string {
  if (value === null) return "-";
  const known = ASSET_LABELS[value];
  if (known !== undefined) return known;
  if (value.startsWith("asset:naryx-test-usdc:")) return "USDC";
  if (value.startsWith("asset:naryx-test-base:")) return "WETH";
  return value.length > 22 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}
