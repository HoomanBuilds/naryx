"use client";

import { useQuery } from "@tanstack/react-query";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import { domainHealth, useTerminal } from "../shell/terminal-context";
import type { DomainId } from "../terminal-view-model";

/**
 * The connected wallets' open packages, one row each, read from each lane's own source of truth:
 * the Base verifier and the Arbitrum adapter on chain, the Solana open-package account, and the
 * Hyperliquid owner ledger. Nothing is kept in the browser, so a package entered on another device
 * appears here too. Sizes are the package's spot leg; notionals are entry values, not marks.
 */
export type OpenPosition = Readonly<{
  key: string;
  domain: DomainId;
  packageId: string;
  size: string;
  entryNotional: string | null;
  state: "Open" | "Entering" | "Exiting" | "Unresolved";
}>;

export type PositionsState = Readonly<{
  positions: readonly OpenPosition[];
  loading: boolean;
  /** Lanes whose read failed; their rows are missing, not empty. */
  unreadable: readonly DomainId[];
}>;

const REFRESH_MS = 15_000;

function units(atoms: bigint | string, decimals: number, maxFraction = 6): string {
  const value = typeof atoms === "bigint" ? atoms : BigInt(atoms);
  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals, digits.length - decimals + maxFraction).replace(/0+$/, "");
  return `${negative ? "-" : ""}${Number(whole).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

function usd(atoms: bigint | string, decimals: number): string {
  return `$${units(atoms, decimals, 2)}`;
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

export function usePositions(): PositionsState {
  const { privateProvider, runtimeHealth } = useTerminal();
  const evm = useEvmWallet().account;
  const solana = useSolanaWallet().selectedAccount?.address ?? null;
  const live = (domain: DomainId) => privateProvider !== null && domainHealth(domain, runtimeHealth)?.available === true;

  const base = useQuery({
    queryKey: ["positions", "base", evm],
    enabled: evm !== null && live("base"),
    refetchInterval: REFRESH_MS,
    queryFn: async ({ signal }): Promise<OpenPosition[]> => {
      const open = (await privateProvider!.getBaseAccountStatus(evm!, {}, signal)).openPackage;
      return open === null ? [] : [{
        key: `base:${open.entryReceiptHash}`,
        domain: "base",
        packageId: shortId(open.entryReceiptHash),
        size: `${units(open.baseQuantityAtoms, 18)} ETH`,
        entryNotional: usd(open.entryPerpNotionalWad, 18),
        state: "Open",
      }];
    },
  });

  const arbitrum = useQuery({
    queryKey: ["positions", "arbitrum", evm],
    enabled: evm !== null && live("arbitrum"),
    refetchInterval: REFRESH_MS,
    queryFn: async ({ signal }): Promise<OpenPosition[]> => {
      const open = (await privateProvider!.getArbitrumAccountStatus(evm!, signal)).openPackage;
      return open === null ? [] : [{
        key: `arbitrum:${open.packageId}`,
        domain: "arbitrum",
        packageId: shortId(open.packageId),
        size: `${units(open.spotBaseAtoms, 18)} ETH`,
        entryNotional: usd(open.positionSizeUsd, 30),
        state: !open.entryExecuted ? "Entering" : open.activeExitRequestKey !== null ? "Exiting" : "Open",
      }];
    },
  });

  const hyperliquid = useQuery({
    queryKey: ["positions", "hyperliquid", evm],
    enabled: evm !== null && live("hyperliquid"),
    refetchInterval: REFRESH_MS,
    queryFn: async ({ signal }): Promise<OpenPosition[]> => {
      const context = await privateProvider!.getHyperliquidTestnetContext(signal);
      const account = await privateProvider!.getHyperliquidAccount(context, evm!, signal);
      return account.packages.filter((entry) => entry.state !== "CLOSED").map((entry) => ({
        key: `hyperliquid:${entry.entryOrderHash}`,
        domain: "hyperliquid",
        packageId: shortId(entry.entryReceiptHash ?? entry.entryOrderHash),
        size: entry.spotQuantityAtoms !== null && account.baseDecimals !== null
          ? units(entry.spotQuantityAtoms, account.baseDecimals) : "-",
        entryNotional: entry.entryNotionalAtoms !== null && account.quoteDecimals !== null
          ? usd(entry.entryNotionalAtoms, account.quoteDecimals) : null,
        state: entry.state === "OPEN" ? "Open" : entry.state === "EXITING" ? "Exiting"
          : entry.state === "PENDING_ENTRY" ? "Entering" : "Unresolved",
      }));
    },
  });

  const solanaQuery = useQuery({
    queryKey: ["positions", "solana", solana],
    enabled: solana !== null && live("solana"),
    refetchInterval: REFRESH_MS,
    queryFn: async ({ signal }): Promise<OpenPosition[]> => {
      const open = (await privateProvider!.getSolanaDevnetAccountStatus(solana!, "0", signal)).openPackage;
      return open === null ? [] : [{
        key: `solana:${solana}`,
        domain: "solana",
        packageId: shortId(solana!),
        size: units(open.spotQuantityAtoms, open.baseDecimals),
        entryNotional: open.entryNotionalAtoms > BigInt(0) ? usd(open.entryNotionalAtoms, open.quoteDecimals) : null,
        state: "Open",
      }];
    },
  });

  const lanes: readonly (readonly [DomainId, typeof base])[] = [
    ["solana", solanaQuery], ["base", base], ["arbitrum", arbitrum], ["hyperliquid", hyperliquid],
  ];
  return {
    positions: lanes.flatMap(([, query]) => query.data ?? []),
    loading: lanes.some(([, query]) => query.isLoading),
    unreadable: lanes.filter(([, query]) => query.isError).map(([domain]) => domain),
  };
}
