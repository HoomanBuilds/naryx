"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { evmConfig } from "./evm-config";
import { SolanaWalletProvider } from "./solana-wallet";
import { WalletModalProvider } from "./wallet-modal";

/**
 * Every wallet the terminal can use, mounted once for all terminal pages so a connection survives
 * moving between Trade, Portfolio, Activity, and Network: wagmi for the EVM account (Base,
 * Arbitrum, Hyperliquid) and the Wallet Standard for Solana.
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } },
  }));
  return (
    <WagmiProvider config={evmConfig}>
      <QueryClientProvider client={queryClient}>
        <SolanaWalletProvider>
          <WalletModalProvider>{children}</WalletModalProvider>
        </SolanaWalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
