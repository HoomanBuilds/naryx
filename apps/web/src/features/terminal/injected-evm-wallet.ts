"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DomainId } from "./terminal-view-model";

type Eip1193RequestArguments = {
  method: string;
  params?: readonly unknown[] | object;
};

type Eip1193Provider = {
  request(args: Eip1193RequestArguments): Promise<unknown>;
  on?(event: "accountsChanged" | "chainChanged", listener: (value: unknown) => void): void;
  removeListener?(event: "accountsChanged" | "chainChanged", listener: (value: unknown) => void): void;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export type EvmDomain = "base" | "arbitrum";

export const EVM_TESTNETS: Record<EvmDomain, { chainId: number; chainIdHex: string; label: string }> = {
  base: {
    chainId: 84532,
    chainIdHex: "0x14a34",
    label: "Base Sepolia",
  },
  arbitrum: {
    chainId: 421614,
    chainIdHex: "0x66eee",
    label: "Arbitrum Sepolia",
  },
};

export type InjectedEvmWalletSession = {
  available: boolean;
  account: string | null;
  chainId: number | null;
  connecting: boolean;
  switching: boolean;
  error: string | null;
  connect(): Promise<void>;
  disconnect(): void;
  switchNetwork(domain: EvmDomain): Promise<void>;
  signTypedData(domain: EvmDomain, typedData: unknown): Promise<string>;
  sendTransaction(
    domain: EvmDomain,
    transaction: Readonly<{ to: string; data: string; value: "0" }>,
  ): Promise<string>;
};

function providerErrorCode(cause: unknown) {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return null;
  return typeof cause.code === "number" ? cause.code : null;
}

function friendlyWalletError(
  cause: unknown,
  action: "connect" | "switch" | "sign" | "submit",
) {
  const code = providerErrorCode(cause);
  if (code === 4001) {
    if (action === "connect") return "Wallet connection cancelled.";
    if (action === "switch") return "Network change cancelled.";
    return action === "sign" ? "Signature cancelled." : "Transaction cancelled.";
  }
  if (code === -32002) return "A wallet request is already open. Check your wallet.";
  if (code === 4902) return "This testnet is not configured in your wallet.";
  if (action === "connect") return "Wallet connection failed. Please try again.";
  if (action === "switch") return "Network change failed. Please switch networks in your wallet.";
  return action === "sign"
    ? "Wallet could not sign the package authorization."
    : "Wallet could not submit the testnet transaction.";
}

function parseChainId(value: unknown) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function firstAccount(value: unknown) {
  if (!Array.isArray(value)) return null;
  const account = value.find((item): item is string =>
    typeof item === "string" && /^0x[0-9a-f]{40}$/i.test(item),
  );
  return account ?? null;
}

export function isEvmDomain(domain: DomainId): domain is EvmDomain {
  return domain === "base" || domain === "arbitrum";
}

export function useInjectedEvmWallet(): InjectedEvmWalletSession {
  const [available] = useState(() =>
    typeof window !== "undefined" && Boolean(window.ethereum),
  );
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionActive = useRef(false);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on) return;

    const handleAccountsChanged = (value: unknown) => {
      if (!sessionActive.current) return;
      setAccount(firstAccount(value));
      setError(null);
    };
    const handleChainChanged = (value: unknown) => {
      if (!sessionActive.current) return;
      setChainId(parseChainId(value));
      setError(null);
    };

    provider.on("accountsChanged", handleAccountsChanged);
    provider.on("chainChanged", handleChainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
    };
  }, []);

  const connect = useCallback(async () => {
    const provider = window.ethereum;
    if (!provider) {
      setError("Install an injected EVM wallet to connect.");
      return;
    }

    setConnecting(true);
    setError(null);
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const nextAccount = firstAccount(accounts);
      if (!nextAccount) {
        setError("No EVM account was authorized.");
        return;
      }
      const currentChain = await provider.request({ method: "eth_chainId" });
      sessionActive.current = true;
      setAccount(nextAccount);
      setChainId(parseChainId(currentChain));
    } catch (cause) {
      setError(friendlyWalletError(cause, "connect"));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    sessionActive.current = false;
    setAccount(null);
    setChainId(null);
    setError(null);
  }, []);

  const switchNetwork = useCallback(async (domain: EvmDomain) => {
    const provider = window.ethereum;
    if (!provider || !sessionActive.current) {
      setError("Connect your EVM wallet before changing networks.");
      return;
    }

    setSwitching(true);
    setError(null);
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: EVM_TESTNETS[domain].chainIdHex }],
      });
      const currentChain = await provider.request({ method: "eth_chainId" });
      setChainId(parseChainId(currentChain));
    } catch (cause) {
      setError(friendlyWalletError(cause, "switch"));
    } finally {
      setSwitching(false);
    }
  }, []);

  const requireReadyProvider = useCallback((domain: EvmDomain) => {
    const provider = window.ethereum;
    if (!provider || !sessionActive.current || !account) {
      throw new Error("Connect your EVM wallet before continuing.");
    }
    if (chainId !== EVM_TESTNETS[domain].chainId) {
      throw new Error(`Switch to ${EVM_TESTNETS[domain].label} before continuing.`);
    }
    return { provider, account };
  }, [account, chainId]);

  const signTypedData = useCallback(async (domain: EvmDomain, typedData: unknown) => {
    const ready = requireReadyProvider(domain);
    setError(null);
    try {
      const result = await ready.provider.request({
        method: "eth_signTypedData_v4",
        params: [ready.account, JSON.stringify(typedData)],
      });
      if (typeof result !== "string" || !/^0x[0-9a-f]{130}$/i.test(result)) {
        throw new Error("Wallet returned an invalid package signature.");
      }
      return result.toLowerCase();
    } catch (cause) {
      const message = cause instanceof Error && cause.message.startsWith("Wallet returned")
        ? cause.message
        : friendlyWalletError(cause, "sign");
      setError(message);
      throw new Error(message);
    }
  }, [requireReadyProvider]);

  const sendTransaction = useCallback(async (
    domain: EvmDomain,
    transaction: Readonly<{ to: string; data: string; value: "0" }>,
  ) => {
    const ready = requireReadyProvider(domain);
    if (!/^0x[0-9a-f]{40}$/i.test(transaction.to) ||
        !/^0x(?:[0-9a-f]{2})+$/i.test(transaction.data) || transaction.value !== "0") {
      throw new Error("Prepared transaction is invalid.");
    }
    setError(null);
    try {
      const result = await ready.provider.request({
        method: "eth_sendTransaction",
        params: [{
          from: ready.account,
          to: transaction.to,
          data: transaction.data,
          value: "0x0",
        }],
      });
      if (typeof result !== "string" || !/^0x[0-9a-f]{64}$/i.test(result) || /^0x0+$/.test(result)) {
        throw new Error("Wallet returned an invalid transaction hash.");
      }
      return result.toLowerCase();
    } catch (cause) {
      const message = cause instanceof Error && cause.message.startsWith("Wallet returned")
        ? cause.message
        : friendlyWalletError(cause, "submit");
      setError(message);
      throw new Error(message);
    }
  }, [requireReadyProvider]);

  return {
    available,
    account,
    chainId,
    connecting,
    switching,
    error,
    connect,
    disconnect,
    switchNetwork,
    signTypedData,
    sendTransaction,
  };
}
