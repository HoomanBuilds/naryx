"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useConfig, useConnect, useConnection, useConnectors, useDisconnect, useSendTransaction, useSignTypedData, useSwitchChain } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import type { Connector } from "wagmi";
import { EVM_CHAINS, type EvmDomain } from "./evm-config";

export type EvmWalletSession = {
  /** Installed EVM wallets, one entry per wallet. */
  connectors: readonly Connector[];
  account: `0x${string}` | null;
  chainId: number | null;
  connector: Connector | null;
  connecting: boolean;
  switching: boolean;
  error: string | null;
  connect(connector: Connector): Promise<boolean>;
  disconnect(): Promise<void>;
  /** Base and Arbitrum need their own testnet; Hyperliquid accepts the account on any chain. */
  onChain(domain: EvmDomain): boolean;
  switchNetwork(domain: EvmDomain): Promise<void>;
  signTypedData(domain: EvmDomain, typedData: unknown): Promise<string>;
  /**
   * Signs typed data that binds no chain id, such as a Hyperliquid testnet package authorization,
   * from whatever network the wallet is on.
   */
  signChainlessTypedData(typedData: unknown): Promise<string>;
  /** `value` is decimal wei; only a reviewed call (such as a venue execution fee) carries a nonzero value. */
  sendTransaction(domain: EvmDomain, transaction: Readonly<{ to: string; data: string; value: string }>): Promise<string>;
  /** Waits for the transaction's receipt on the domain's testnet; true when it succeeded. */
  waitForReceipt(domain: EvmDomain, hash: string): Promise<boolean>;
};

/** A ceiling on any wallet-sent value: testnet execution fees are far below 0.1 ETH. */
const MAX_TRANSACTION_VALUE_WEI = BigInt("100000000000000000");
const RECEIPT_TIMEOUT_MS = 180_000;

const noSubscription = () => () => undefined;

/** Whether any extension injected `window.ethereum`; the generic connector is useless without one. */
function useInjectedProvider() {
  return useSyncExternalStore(
    noSubscription,
    () => typeof (window as { ethereum?: unknown }).ethereum === "object",
    () => false,
  );
}

function walletError(cause: unknown, action: "connect" | "switch" | "sign" | "submit"): string {
  const name = typeof cause === "object" && cause !== null && "name" in cause ? String(cause.name) : "";
  const message = cause instanceof Error ? cause.message : "";
  if (name === "UserRejectedRequestError" || /reject|denied|cancel/i.test(message)) {
    return action === "connect" ? "Connection cancelled." : action === "switch" ? "Network change cancelled." : action === "sign" ? "Signature cancelled." : "Transaction cancelled.";
  }
  if (/already pending|already processing/i.test(message)) return "A wallet request is already open. Check your wallet.";
  // A new wallet has no testnet ETH; say so instead of a generic failure.
  if (name === "InsufficientFundsError" || /insufficient funds|exceeds the balance|gas required exceeds/i.test(message)) {
    return "Not enough testnet ETH for gas on this network. Get some from the Gas link on the Portfolio page, then retry.";
  }
  if (action === "switch") return "Network change failed. Switch networks in your wallet.";
  return action === "connect" ? "Wallet connection failed." : action === "sign" ? "Wallet could not sign the package authorization." : "Wallet could not submit the testnet transaction.";
}

/**
 * The EVM wallet session on wagmi: discovered wallets, the connected account and chain, testnet
 * switching, and the two signing paths the terminal uses. The terminal never holds a key; every
 * signature is requested from the user's own wallet on a configured testnet.
 */
export function useEvmWallet(): EvmWalletSession {
  const config = useConfig();
  const connection = useConnection();
  const allConnectors = useConnectors();
  const connectMutation = useConnect();
  const disconnectMutation = useDisconnect();
  const switchMutation = useSwitchChain();
  const typedDataMutation = useSignTypedData();
  const transactionMutation = useSendTransaction();
  const [error, setError] = useState<string | null>(null);

  const injectedPresent = useInjectedProvider();
  // EIP-6963 wallets announce themselves; the generic injected entry is kept only when none did
  // and something is actually injected.
  const connectors = useMemo(() => {
    const discovered = allConnectors.filter((connector) => connector.id !== "injected");
    if (discovered.length > 0) return discovered;
    return injectedPresent ? allConnectors : [];
  }, [allConnectors, injectedPresent]);

  const account = connection.isConnected && connection.address ? connection.address : null;
  const chainId = connection.isConnected ? connection.chainId ?? null : null;

  const connect = useCallback(async (connector: Connector) => {
    setError(null);
    try {
      await connectMutation.mutateAsync({ connector });
      return true;
    } catch (cause) {
      setError(walletError(cause, "connect"));
      return false;
    }
  }, [connectMutation]);

  const disconnect = useCallback(async () => {
    setError(null);
    await disconnectMutation.mutateAsync().catch(() => undefined);
  }, [disconnectMutation]);

  const onChain = useCallback((domain: EvmDomain) => chainId === EVM_CHAINS[domain].id, [chainId]);

  const switchNetwork = useCallback(async (domain: EvmDomain) => {
    setError(null);
    try {
      await switchMutation.mutateAsync({ chainId: EVM_CHAINS[domain].id });
    } catch (cause) {
      setError(walletError(cause, "switch"));
    }
  }, [switchMutation]);

  const requireReady = useCallback((domain: EvmDomain) => {
    if (!account) throw new Error("Connect your EVM wallet before continuing.");
    if (chainId !== EVM_CHAINS[domain].id) throw new Error(`Switch to ${EVM_CHAINS[domain].name} before continuing.`);
    return account;
  }, [account, chainId]);

  const signWith = useCallback(async (typedData: unknown) => {
    const data = typedData as { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
    // viem derives the EIP712Domain type itself, so the explicit entry is dropped.
    const { EIP712Domain: _domainType, ...types } = data.types;
    void _domainType;
    try {
      const signature = await typedDataMutation.mutateAsync({
        domain: data.domain,
        types,
        primaryType: data.primaryType,
        message: data.message,
      } as unknown as Parameters<typeof typedDataMutation.mutateAsync>[0]);
      if (!/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error("Wallet returned an invalid package signature.");
      return signature.toLowerCase();
    } catch (cause) {
      const message = cause instanceof Error && cause.message.startsWith("Wallet returned") ? cause.message : walletError(cause, "sign");
      setError(message);
      throw new Error(message);
    }
  }, [typedDataMutation]);

  const signTypedData = useCallback(async (domain: EvmDomain, typedData: unknown) => {
    requireReady(domain);
    return signWith(typedData);
  }, [requireReady, signWith]);

  const signChainlessTypedData = useCallback(async (typedData: unknown) => {
    if (!account) throw new Error("Connect your EVM wallet before continuing.");
    const data = typedData as { domain?: Record<string, unknown> };
    if (data.domain === undefined || "chainId" in data.domain) throw new Error("Typed data must not bind a chain.");
    return signWith(typedData);
  }, [account, signWith]);

  const sendTransaction = useCallback(async (domain: EvmDomain, transaction: Readonly<{ to: string; data: string; value: string }>) => {
    requireReady(domain);
    if (!/^0x[0-9a-f]{40}$/i.test(transaction.to) || !/^0x(?:[0-9a-f]{2})+$/i.test(transaction.data) ||
        !/^(0|[1-9][0-9]{0,30})$/.test(transaction.value) || BigInt(transaction.value) > MAX_TRANSACTION_VALUE_WEI) {
      throw new Error("Prepared transaction is invalid.");
    }
    try {
      const hash = await transactionMutation.mutateAsync({
        chainId: EVM_CHAINS[domain].id,
        to: transaction.to as `0x${string}`,
        data: transaction.data as `0x${string}`,
        value: BigInt(transaction.value),
      });
      return hash.toLowerCase();
    } catch (cause) {
      const message = walletError(cause, "submit");
      setError(message);
      throw new Error(message);
    }
  }, [requireReady, transactionMutation]);

  const waitForReceipt = useCallback(async (domain: EvmDomain, hash: string) => {
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error("Transaction hash is invalid.");
    try {
      const receipt = await waitForTransactionReceipt(config, {
        chainId: EVM_CHAINS[domain].id,
        hash: hash as `0x${string}`,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      return receipt.status === "success";
    } catch {
      throw new Error(`The transaction has not confirmed on ${EVM_CHAINS[domain].name} yet. Check it in your wallet, then retry.`);
    }
  }, [config]);

  return {
    connectors,
    account,
    chainId,
    connector: connection.isConnected ? connection.connector ?? null : null,
    connecting: connectMutation.isPending || connection.status === "connecting" || connection.status === "reconnecting",
    switching: switchMutation.isPending,
    error,
    connect,
    disconnect,
    onChain,
    switchNetwork,
    signTypedData,
    signChainlessTypedData,
    sendTransaction,
    waitForReceipt,
  };
}
