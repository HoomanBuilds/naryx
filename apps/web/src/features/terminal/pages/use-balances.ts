"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, formatUnits } from "viem";
import { useBalance, useReadContracts } from "wagmi";
import { EVM_CHAINS, type EvmDomain } from "@/features/wallet/evm-config";

/**
 * Read-only testnet balances for the connected accounts. Nothing here signs or writes: EVM reads
 * go through the configured testnet transports, Solana through the public Devnet RPC, and
 * Hyperliquid through the testnet info endpoint.
 */

/**
 * The quote asset each deployment settles in, from its runtime manifest. The hosted Base deployment
 * uses Naryx Test USDC; until it is configured, Circle's test USDC is shown. Arbitrum settles in the
 * GMX market's collateral, GMX's own mintable test USDC (USDC.SG).
 */
function evmAddress(value: string | undefined, fallback: `0x${string}`): `0x${string}` {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as `0x${string}`) : fallback;
}
export const EVM_QUOTE_TOKEN: Readonly<Record<EvmDomain, `0x${string}`>> = {
  base: evmAddress(process.env.NEXT_PUBLIC_BASE_SEPOLIA_QUOTE_TOKEN, "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  arbitrum: evmAddress(process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_QUOTE_TOKEN, "0x3253a335E7bFfB4790Aa4C25C4250d206E9b9773"),
};
const SOLANA_DEVNET_RPC = process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com";
const SOLANA_DEVNET_USDC = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(process.env.NEXT_PUBLIC_SOLANA_DEVNET_QUOTE_MINT ?? "")
  ? process.env.NEXT_PUBLIC_SOLANA_DEVNET_QUOTE_MINT as string
  : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const HYPERLIQUID_TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info";

export type Amount = Readonly<{ value: string; symbol: string }> | null;

export type ChainBalance = Readonly<{
  loading: boolean;
  failed: boolean;
  gas: Amount;
  usdc: Amount;
  /** Hyperliquid only: perpetual account equity in USDC. */
  perpEquity?: Amount;
}>;

const IDLE: ChainBalance = { loading: false, failed: false, gas: null, usdc: null };

function decimal(value: bigint, decimals: number) {
  const text = formatUnits(value, decimals);
  const [whole, fraction = ""] = text.split(".");
  const kept = fraction.slice(0, 4).replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
}

function trimDecimal(value: string) {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const kept = fraction.slice(0, 4).replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
}

export function useEvmBalances(account: `0x${string}` | null): Readonly<Record<EvmDomain, ChainBalance>> {
  const enabled = account !== null;
  const base = useBalance({ address: account ?? undefined, chainId: EVM_CHAINS.base.id, query: { enabled } });
  const arbitrum = useBalance({ address: account ?? undefined, chainId: EVM_CHAINS.arbitrum.id, query: { enabled } });
  const usdc = useReadContracts({
    allowFailure: true,
    contracts: account
      ? (["base", "arbitrum"] as const).flatMap((domain) => [
        { address: EVM_QUOTE_TOKEN[domain], abi: erc20Abi, functionName: "balanceOf", args: [account], chainId: EVM_CHAINS[domain].id } as const,
        { address: EVM_QUOTE_TOKEN[domain], abi: erc20Abi, functionName: "decimals", chainId: EVM_CHAINS[domain].id } as const,
      ])
      : [],
    query: { enabled },
  });

  function usdcFor(index: number): Amount {
    const balance = usdc.data?.[index];
    const decimals = usdc.data?.[index + 1];
    if (balance?.status !== "success" || decimals?.status !== "success") return null;
    return { value: decimal(balance.result as bigint, Number(decimals.result)), symbol: "USDC" };
  }

  if (!enabled) return { base: IDLE, arbitrum: IDLE };
  return {
    base: {
      loading: base.isLoading || usdc.isLoading,
      failed: base.isError,
      gas: base.data ? { value: decimal(base.data.value, base.data.decimals), symbol: "ETH" } : null,
      usdc: usdcFor(0),
    },
    arbitrum: {
      loading: arbitrum.isLoading || usdc.isLoading,
      failed: arbitrum.isError,
      gas: arbitrum.data ? { value: decimal(arbitrum.data.value, arbitrum.data.decimals), symbol: "ETH" } : null,
      usdc: usdcFor(2),
    },
  };
}

async function solanaRpc(method: string, params: unknown[], signal: AbortSignal): Promise<unknown> {
  const response = await fetch(SOLANA_DEVNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error("Solana Devnet RPC unavailable.");
  const payload = await response.json() as { result?: unknown; error?: unknown };
  if (payload.error !== undefined || payload.result === undefined) throw new Error("Solana Devnet RPC error.");
  return payload.result;
}

export function useSolanaBalance(address: string | null): ChainBalance {
  const query = useQuery({
    queryKey: ["solana-devnet-balance", address],
    enabled: address !== null,
    queryFn: async ({ signal }) => {
      if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error("Invalid Solana address.");
      const [lamports, tokens] = await Promise.all([
        solanaRpc("getBalance", [address, { commitment: "confirmed" }], signal),
        solanaRpc("getTokenAccountsByOwner", [address, { mint: SOLANA_DEVNET_USDC }, { encoding: "jsonParsed", commitment: "confirmed" }], signal),
      ]);
      const lamportValue = (lamports as { value?: unknown }).value;
      if (typeof lamportValue !== "number" || !Number.isSafeInteger(lamportValue)) throw new Error("Invalid balance.");
      let usdcAtoms = BigInt(0);
      let usdcDecimals = 6;
      for (const entry of ((tokens as { value?: unknown }).value as unknown[] | undefined) ?? []) {
        const amount = (entry as { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: unknown; decimals?: unknown } } } } } })
          .account?.data?.parsed?.info?.tokenAmount;
        if (typeof amount?.amount === "string" && /^\d+$/.test(amount.amount) && typeof amount.decimals === "number") {
          usdcAtoms += BigInt(amount.amount);
          usdcDecimals = amount.decimals;
        }
      }
      return {
        gas: { value: decimal(BigInt(lamportValue), 9), symbol: "SOL" },
        usdc: { value: decimal(usdcAtoms, usdcDecimals), symbol: "USDC" },
      };
    },
  });
  if (address === null) return IDLE;
  return { loading: query.isLoading, failed: query.isError, gas: query.data?.gas ?? null, usdc: query.data?.usdc ?? null };
}

async function hyperliquidInfo(body: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(HYPERLIQUID_TESTNET_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error("Hyperliquid testnet info unavailable.");
  return response.json() as Promise<unknown>;
}

export function useHyperliquidBalance(account: `0x${string}` | null): ChainBalance {
  const query = useQuery({
    queryKey: ["hyperliquid-testnet-balance", account],
    enabled: account !== null,
    queryFn: async ({ signal }) => {
      if (!account) throw new Error("No account.");
      const user = account.toLowerCase();
      const [perp, spot] = await Promise.all([
        hyperliquidInfo({ type: "clearinghouseState", user }, signal),
        hyperliquidInfo({ type: "spotClearinghouseState", user }, signal),
      ]);
      const equity = (perp as { marginSummary?: { accountValue?: unknown } }).marginSummary?.accountValue;
      const balances = (spot as { balances?: unknown }).balances;
      const usdc = Array.isArray(balances)
        ? balances.find((entry): entry is { coin: string; total: string } =>
          typeof entry === "object" && entry !== null && (entry as { coin?: unknown }).coin === "USDC" &&
          typeof (entry as { total?: unknown }).total === "string")
        : undefined;
      const equityText = typeof equity === "string" ? trimDecimal(equity) : null;
      const spotText = usdc ? trimDecimal(usdc.total) : "0";
      return {
        usdc: spotText !== null ? { value: spotText, symbol: "USDC" } : null,
        perpEquity: equityText !== null ? { value: equityText, symbol: "USDC" } : null,
      };
    },
  });
  if (account === null) return IDLE;
  return {
    loading: query.isLoading,
    failed: query.isError,
    gas: null,
    usdc: query.data?.usdc ?? null,
    perpEquity: query.data?.perpEquity ?? null,
  };
}
