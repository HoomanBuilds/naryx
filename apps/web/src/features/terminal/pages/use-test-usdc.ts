"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { encodeFunctionData, parseAbi } from "viem";
import { useSimulateContract } from "wagmi";
import { EVM_CHAINS, type EvmDomain } from "@/features/wallet/evm-config";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import { claimSolanaDevnetTestUsdc } from "../solana-devnet-onboarding";
import { useTerminal } from "../shell/terminal-context";
import type { DomainId } from "../terminal-view-model";
import { EVM_QUOTE_TOKEN } from "./use-balances";

/**
 * Free test USDC for the connected wallet. Base settles in Naryx Test USDC and Arbitrum in GMX's
 * test USDC; both expose a public `mint(address,uint256)`, which the wallet calls itself after a
 * simulation shows the configured token accepts it. Solana Devnet claims from the test perp faucet
 * through service-built steps the wallet signs. No key or credential leaves the wallet.
 */

const FAUCET_ABI = parseAbi(["function mint(address recipient, uint256 amount)"]);
/** 10,000 USDC at six decimals: the per-claim Solana faucet bound, and a demo-sized EVM grant. */
const GRANT_ATOMS = BigInt(10_000_000_000);
export const TEST_USDC_GRANT = "10,000";

/** Where each network's gas comes from; the terminal never sends gas. */
export const GAS_FAUCETS: Readonly<Partial<Record<DomainId, Readonly<{ label: string; href: string }>>>> = {
  solana: { label: "Devnet SOL", href: "https://faucet.solana.com" },
  base: { label: "Base Sepolia ETH", href: "https://docs.base.org/base-chain/tools/network-faucets" },
  arbitrum: { label: "Arbitrum Sepolia ETH", href: "https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info#faucet-list" },
};

export type FaucetState = Readonly<{
  /** True once the configured token or mint is known to pay this wallet. */
  available: boolean;
  /** The wallet must change networks first; the action switches instead of minting. */
  needsSwitch: boolean;
  busy: string | null;
  message: string | null;
  error: string | null;
  /** The claim's latest submitted transaction, for its explorer link. */
  hash: string | null;
  claim(): Promise<void>;
}>;

type Progress = Readonly<{ busy: string | null; message: string | null; error: string | null; hash: string | null }>;
const IDLE: Progress = { busy: null, message: null, error: null, hash: null };

/** A claim keeps running after the user leaves Portfolio; its result is then posted as a notice. */
function useNoticeWhenAway() {
  const { notify } = useTerminal();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return useCallback((ok: boolean, text: string) => {
    if (!mounted.current) notify(ok ? "ok" : "bad", text, { href: "/portfolio", label: "View balances" });
  }, [notify]);
}

function useEvmFaucet(domain: EvmDomain): FaucetState {
  const evm = useEvmWallet();
  const queryClient = useQueryClient();
  const noticeWhenAway = useNoticeWhenAway();
  const [progress, setProgress] = useState<Progress>(IDLE);
  const account = evm.account;
  const token = EVM_QUOTE_TOKEN[domain];
  const simulation = useSimulateContract({
    address: token ?? undefined,
    abi: FAUCET_ABI,
    functionName: "mint",
    args: account ? [account, GRANT_ATOMS] : undefined,
    account: account ?? undefined,
    chainId: EVM_CHAINS[domain].id,
    query: { enabled: account !== null && token !== null, retry: false, staleTime: 60_000 },
  });
  const available = account !== null && token !== null && simulation.isSuccess;
  const needsSwitch = available && !evm.onChain(domain);

  const claim = useCallback(async () => {
    if (!account || !token || !available || progress.busy) return;
    if (!evm.onChain(domain)) {
      await evm.switchNetwork(domain);
      return;
    }
    setProgress({ busy: "Confirm in your wallet", message: null, error: null, hash: null });
    let hash: string | null = null;
    try {
      hash = await evm.sendTransaction(domain, {
        to: token,
        data: encodeFunctionData({ abi: FAUCET_ABI, functionName: "mint", args: [account, GRANT_ATOMS] }),
        value: "0",
      });
      setProgress({ busy: `Submitted. Confirming on ${EVM_CHAINS[domain].name}`, message: null, error: null, hash });
      if (!(await evm.waitForReceipt(domain, hash))) throw new Error("The faucet transaction reverted. The wallet may already hold the faucet maximum.");
      await queryClient.invalidateQueries();
      const message = `${TEST_USDC_GRANT} test USDC added on ${EVM_CHAINS[domain].name}.`;
      setProgress({ busy: null, message, error: null, hash });
      noticeWhenAway(true, message);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "The faucet request failed.";
      setProgress({ busy: null, message: null, error, hash });
      if (hash !== null) noticeWhenAway(false, `Test USDC on ${EVM_CHAINS[domain].name}: ${error}`);
    }
  }, [account, available, domain, evm, noticeWhenAway, progress.busy, queryClient, token]);

  return { available, needsSwitch, ...progress, claim };
}

function useSolanaFaucet(): FaucetState {
  const solana = useSolanaWallet();
  const { privateProvider } = useTerminal();
  const queryClient = useQueryClient();
  const noticeWhenAway = useNoticeWhenAway();
  const [progress, setProgress] = useState<Progress>(IDLE);
  const owner = solana.selectedAccount?.address ?? null;
  const status = useQuery({
    queryKey: ["solana-devnet-faucet", owner],
    enabled: owner !== null && privateProvider !== null,
    retry: false,
    staleTime: 60_000,
    queryFn: ({ signal }) => {
      if (!owner || !privateProvider) throw new Error("Not connected.");
      return privateProvider.getSolanaDevnetAccountStatus(owner, "0", signal);
    },
  });
  const available = owner !== null && status.data?.testCollateralFaucet != null && solana.canSignAndSendV0;
  const signAndSend = solana.signAndSend;

  const claim = useCallback(async () => {
    if (!owner || !privateProvider || !available || progress.busy) return;
    setProgress({ busy: "Preparing the claim", message: null, error: null, hash: null });
    let hash: string | null = null;
    try {
      const claimed = await claimSolanaDevnetTestUsdc({
        owner,
        readStatus: (wallet, sizeAtoms, signal, claimTestCollateral) =>
          privateProvider.getSolanaDevnetAccountStatus(wallet, sizeAtoms, signal, claimTestCollateral),
        signAndSend: async (transaction) => {
          hash = await signAndSend(transaction);
          return hash;
        },
        onProgress: (busy) => setProgress({ busy, message: null, error: null, hash }),
      });
      await queryClient.invalidateQueries({ queryKey: ["solana-devnet-balance"] });
      const message = `${TEST_USDC_GRANT} test USDC added on Solana Devnet.`;
      setProgress(claimed
        ? { busy: null, message, error: null, hash }
        : { busy: null, message: null, error: "This wallet already holds the faucet maximum.", hash });
      if (claimed) noticeWhenAway(true, message);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "The faucet request failed.";
      const error = /reject|denied|cancel/i.test(text) ? "Claim cancelled in the wallet." : text;
      setProgress({ busy: null, message: null, error, hash });
      if (hash !== null) noticeWhenAway(false, `Test USDC on Solana Devnet: ${error}`);
    }
  }, [available, noticeWhenAway, owner, privateProvider, progress.busy, queryClient, signAndSend]);

  return { available, needsSwitch: false, ...progress, claim };
}

const UNAVAILABLE: FaucetState = { available: false, needsSwitch: false, ...IDLE, claim: async () => undefined };

export function useTestUsdcFaucets(): Readonly<Record<DomainId, FaucetState>> {
  const solana = useSolanaFaucet();
  const base = useEvmFaucet("base");
  const arbitrum = useEvmFaucet("arbitrum");
  return { solana, base, arbitrum, hyperliquid: UNAVAILABLE };
}
