import { createConfig, http, injected } from "wagmi";
import { arbitrumSepolia, baseSepolia } from "viem/chains";

/**
 * EVM wallets for Base, Arbitrum, and Hyperliquid. Only the two public testnets are configured,
 * so a wallet can never be asked to switch to, or sign for, a mainnet chain from this app.
 * EIP-6963 discovery lists every installed wallet (MetaMask, Rabby, Coinbase, Phantom EVM...)
 * as its own connector instead of whichever one won the race for `window.ethereum`; the plain
 * injected connector remains as a fallback for wallets that only expose `window.ethereum`.
 */
export const evmConfig = createConfig({
  chains: [baseSepolia, arbitrumSepolia],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: true,
  // Dedicated RPC endpoints when configured; the chains' public endpoints otherwise.
  transports: {
    [baseSepolia.id]: http(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || undefined),
    [arbitrumSepolia.id]: http(process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL || undefined),
  },
  ssr: true,
});

export const EVM_CHAINS = {
  base: baseSepolia,
  arbitrum: arbitrumSepolia,
} as const;

export type EvmDomain = keyof typeof EVM_CHAINS;

declare module "wagmi" {
  interface Register {
    config: typeof evmConfig;
  }
}
