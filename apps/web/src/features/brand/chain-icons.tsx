import type { ComponentType, SVGProps } from "react";
import ExchangeHyperliquid from "@web3icons/react/icons/exchanges/ExchangeHyperliquid";
import NetworkArbitrumOne from "@web3icons/react/icons/networks/NetworkArbitrumOne";
import NetworkBase from "@web3icons/react/icons/networks/NetworkBase";
import NetworkSolana from "@web3icons/react/icons/networks/NetworkSolana";
import TokenARB from "@web3icons/react/icons/tokens/TokenARB";
import TokenBTC from "@web3icons/react/icons/tokens/TokenBTC";
import TokenETH from "@web3icons/react/icons/tokens/TokenETH";
import TokenHYPE from "@web3icons/react/icons/tokens/TokenHYPE";
import TokenSOL from "@web3icons/react/icons/tokens/TokenSOL";
import TokenUSDC from "@web3icons/react/icons/tokens/TokenUSDC";
import TokenUSDT from "@web3icons/react/icons/tokens/TokenUSDT";
import WalletMetamask from "@web3icons/react/icons/wallets/WalletMetamask";
import WalletPhantom from "@web3icons/react/icons/wallets/WalletPhantom";

type IconVariant = "branded" | "mono" | "background";
type Web3Icon = ComponentType<Omit<SVGProps<SVGSVGElement>, "ref"> & { size?: number | string; variant?: IconVariant }>;

export type ChainId = "solana" | "base" | "arbitrum" | "hyperliquid";

/** The four execution domains Naryx operates on, in the order the product presents them. */
export const CHAINS: readonly { readonly id: ChainId; readonly name: string; readonly accent: string; readonly Icon: Web3Icon }[] = [
  { id: "solana", name: "Solana", accent: "#14F195", Icon: NetworkSolana },
  { id: "base", name: "Base", accent: "#0052FF", Icon: NetworkBase },
  { id: "arbitrum", name: "Arbitrum", accent: "#28A0F0", Icon: NetworkArbitrumOne },
  { id: "hyperliquid", name: "Hyperliquid", accent: "#50D2C1", Icon: ExchangeHyperliquid },
];

const CHAIN_BY_ID = new Map(CHAINS.map((chain) => [chain.id, chain]));

const ASSETS: Readonly<Record<string, Web3Icon>> = {
  SOL: TokenSOL,
  USDC: TokenUSDC,
  USDT: TokenUSDT,
  ETH: TokenETH,
  WETH: TokenETH,
  BTC: TokenBTC,
  HYPE: TokenHYPE,
  ARB: TokenARB,
};

/** Resolves a domain id, label, or free text such as "Hyperliquid testnet preview" to its chain. */
export function chainOf(text: string | undefined | null): (typeof CHAINS)[number] | undefined {
  if (!text) return undefined;
  const direct = CHAIN_BY_ID.get(text.toLowerCase() as ChainId);
  if (direct) return direct;
  const lower = text.toLowerCase();
  if (/\bhyper(liquid|core|evm)\b/.test(lower)) return CHAIN_BY_ID.get("hyperliquid");
  if (/\barbitrum\b/.test(lower) || /^eip155:(42161|421614)\b/.test(lower)) return CHAIN_BY_ID.get("arbitrum");
  if (/\bbase( sepolia| mainnet)?\b(?! asset)/.test(lower) && !/\bbase (asset|quantity|atoms)\b/.test(lower) || /^eip155:(8453|84532)\b/.test(lower)) return CHAIN_BY_ID.get("base");
  if (/\bsolana\b/.test(lower) || /^svm:/.test(lower)) return CHAIN_BY_ID.get("solana");
  return undefined;
}

export function ChainIcon({
  chain,
  size = 16,
  variant = "branded",
  className,
  title,
}: {
  chain: string;
  size?: number;
  variant?: IconVariant;
  className?: string;
  title?: string;
}) {
  const entry = chainOf(chain);
  if (!entry) return null;
  const { Icon } = entry;
  return (
    <span className={className} title={title ?? entry.name} style={{ display: "inline-flex", flex: "none", lineHeight: 0 }}>
      <Icon size={size} variant={variant} aria-hidden />
    </span>
  );
}

/** A token icon by symbol, or a lettered disc for an asset the icon set does not carry. */
export function AssetIcon({ symbol, size = 16, className }: { symbol: string; size?: number; className?: string }) {
  const key = symbol.toUpperCase().replace(/-PERP$/, "");
  const Icon = ASSETS[key];
  if (Icon) {
    // The filled variant clipped to a disc reads as a token badge at any size and overlaps cleanly.
    return (
      <span className={className} title={symbol} style={{ display: "inline-flex", flex: "none", width: size, height: size, overflow: "hidden", borderRadius: "50%", lineHeight: 0 }}>
        <Icon size={size} variant="background" aria-hidden />
      </span>
    );
  }
  return (
    <span
      className={className}
      title={symbol}
      aria-hidden
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: size,
        height: size,
        flex: "none",
        borderRadius: "50%",
        background: "rgba(255,255,255,0.12)",
        color: "currentColor",
        fontSize: Math.max(8, Math.round(size * 0.5)),
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      {key.slice(0, 1)}
    </span>
  );
}

/** Base over quote, overlapped like a trading pair badge. */
export function PairIcon({ base, quote, size = 20, className }: { base: string; quote: string; size?: number; className?: string }) {
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", flex: "none" }} aria-hidden>
      <AssetIcon symbol={base} size={size} />
      <span style={{ marginLeft: -Math.round(size * 0.32), borderRadius: "50%", boxShadow: "0 0 0 2px var(--pair-ring, #0b0d10)", lineHeight: 0 }}>
        <AssetIcon symbol={quote} size={size} />
      </span>
    </span>
  );
}

export function WalletIcon({ wallet, size = 16 }: { wallet: "phantom" | "metamask"; size?: number }) {
  const Icon = wallet === "phantom" ? WalletPhantom : WalletMetamask;
  return (
    <span style={{ display: "inline-flex", flex: "none", lineHeight: 0 }}>
      <Icon size={size} variant="branded" aria-hidden />
    </span>
  );
}
