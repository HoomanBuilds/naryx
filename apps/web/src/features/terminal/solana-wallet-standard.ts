"use client";

import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import {
  SolanaSignAndSendTransaction,
  type SolanaSignAndSendTransactionFeature,
} from "@solana/wallet-standard-features";
import bs58 from "bs58";
import { useCallback, useEffect, useMemo, useState } from "react";

const SOLANA_DEVNET_CHAIN = "solana:devnet";

type DevnetWallet = Wallet & {
  features: Wallet["features"] & StandardConnectFeature & SolanaSignAndSendTransactionFeature &
    Partial<StandardDisconnectFeature & StandardEventsFeature>;
};

function isDevnetWallet(wallet: Wallet): wallet is DevnetWallet {
  const connect = wallet.features[StandardConnect];
  const sender = wallet.features[SolanaSignAndSendTransaction];
  return wallet.chains.includes(SOLANA_DEVNET_CHAIN) &&
    typeof connect === "object" && connect !== null &&
    typeof (connect as { connect?: unknown }).connect === "function" &&
    typeof sender === "object" && sender !== null &&
    typeof (sender as { signAndSendTransaction?: unknown }).signAndSendTransaction === "function";
}

function eligibleAccounts(accounts: readonly WalletAccount[]): readonly WalletAccount[] {
  return accounts.filter((account) =>
    account.chains.includes(SOLANA_DEVNET_CHAIN) &&
    account.features.includes(SolanaSignAndSendTransaction),
  );
}

export type SolanaWalletSession = {
  wallets: readonly DevnetWallet[];
  selectedWallet: DevnetWallet | null;
  accounts: readonly WalletAccount[];
  selectedAccount: WalletAccount | null;
  connecting: boolean;
  error: string | null;
  canSignAndSendV0: boolean;
  selectWallet(name: string): void;
  selectAccount(address: string): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  signAndSend(transaction: Uint8Array): Promise<string>;
};

export function useSolanaDevnetWallet(): SolanaWalletSession {
  const [wallets, setWallets] = useState<readonly DevnetWallet[]>([]);
  const [selectedWalletName, setSelectedWalletName] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<readonly WalletAccount[]>([]);
  const [selectedAccountAddress, setSelectedAccountAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const registry = getWallets();
    const refresh = () => setWallets(registry.get().filter(isDevnetWallet));
    refresh();
    const offRegister = registry.on("register", refresh);
    const offUnregister = registry.on("unregister", refresh);
    return () => {
      offRegister();
      offUnregister();
    };
  }, []);

  const selectedWallet = useMemo(
    () => wallets.find((wallet) => wallet.name === selectedWalletName) ?? null,
    [selectedWalletName, wallets],
  );

  useEffect(() => {
    if (!selectedWallet) return;
    const updateAccounts = (next: readonly WalletAccount[]) => {
      const eligible = eligibleAccounts(next);
      setAccounts(eligible);
      setSelectedAccountAddress((current) =>
        eligible.some((account) => account.address === current)
          ? current
          : eligible[0]?.address ?? null,
      );
    };
    const events = selectedWallet.features[StandardEvents];
    if (!events) return;
    return events.on("change", (properties) => {
      if (properties.accounts) updateAccounts(properties.accounts);
    });
  }, [selectedWallet]);

  const activeAccounts = selectedWallet ? accounts : [];
  const selectedAccount = activeAccounts.find(
    (account) => account.address === selectedAccountAddress,
  ) ?? null;
  const canSignAndSendV0 = Boolean(
    selectedWallet && selectedAccount &&
    selectedWallet.features[SolanaSignAndSendTransaction].supportedTransactionVersions.includes(0),
  );

  const selectWallet = useCallback((name: string) => {
    const nextWallet = wallets.find((wallet) => wallet.name === name) ?? null;
    const nextAccounts = nextWallet ? eligibleAccounts(nextWallet.accounts) : [];
    setSelectedWalletName(name === "" ? null : name);
    setAccounts(nextAccounts);
    setSelectedAccountAddress(nextAccounts[0]?.address ?? null);
    setError(null);
  }, [wallets]);

  const connect = useCallback(async () => {
    if (!selectedWallet) return;
    setConnecting(true);
    setError(null);
    try {
      const output = await selectedWallet.features[StandardConnect].connect();
      const next = eligibleAccounts(output.accounts);
      setAccounts(next);
      setSelectedAccountAddress(next[0]?.address ?? null);
      if (next.length === 0) {
        throw new Error("The wallet did not authorize a Solana Devnet signing account.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection failed.");
    } finally {
      setConnecting(false);
    }
  }, [selectedWallet]);

  const disconnect = useCallback(async () => {
    if (selectedWallet) {
      const feature = selectedWallet.features[StandardDisconnect];
      if (feature) await feature.disconnect();
    }
    setAccounts([]);
    setSelectedAccountAddress(null);
    setError(null);
  }, [selectedWallet]);

  const signAndSend = useCallback(async (transaction: Uint8Array) => {
    if (!selectedWallet || !selectedAccount || !canSignAndSendV0) {
      throw new Error("A Wallet Standard account with Devnet v0 signing is required.");
    }
    const [output] = await selectedWallet.features[SolanaSignAndSendTransaction]
      .signAndSendTransaction({
        transaction,
        account: selectedAccount,
        chain: SOLANA_DEVNET_CHAIN,
        options: {
          skipPreflight: false,
          maxRetries: 3,
        },
      });
    if (!output || output.signature.length !== 64) {
      throw new Error("Wallet submission returned an invalid signature.");
    }
    return bs58.encode(output.signature);
  }, [canSignAndSendV0, selectedAccount, selectedWallet]);

  return {
    wallets,
    selectedWallet,
    accounts: activeAccounts,
    selectedAccount,
    connecting,
    error,
    canSignAndSendV0,
    selectWallet,
    selectAccount: setSelectedAccountAddress,
    connect,
    disconnect,
    signAndSend,
  };
}
