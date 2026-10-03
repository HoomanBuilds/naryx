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
  SolanaSignMessage,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignMessageFeature,
} from "@solana/wallet-standard-features";
import bs58 from "bs58";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Solana wallets through the Wallet Standard, the interface every current Solana wallet
 * implements (Phantom, Solflare, Backpack, ...) and the one `@solana/wallet-adapter` wraps.
 * Only Devnet accounts are offered; the chosen wallet is remembered and reconnected silently on
 * the next visit, which never opens a wallet prompt.
 */
const SOLANA_DEVNET_CHAIN = "solana:devnet";
const REMEMBERED_WALLET = "naryx.wallet.solana";
const NO_ACCOUNTS: readonly WalletAccount[] = Object.freeze([]);

export type DevnetWallet = Wallet & {
  features: Wallet["features"] & StandardConnectFeature &
    Partial<SolanaSignAndSendTransactionFeature & SolanaSignMessageFeature &
      StandardDisconnectFeature & StandardEventsFeature>;
};

function isDevnetWallet(wallet: Wallet): wallet is DevnetWallet {
  const connect = wallet.features[StandardConnect];
  return wallet.chains.includes(SOLANA_DEVNET_CHAIN) &&
    typeof connect === "object" && connect !== null &&
    typeof (connect as { connect?: unknown }).connect === "function";
}

function eligibleAccounts(accounts: readonly WalletAccount[]): readonly WalletAccount[] {
  return accounts.filter((account) =>
    account.chains.includes(SOLANA_DEVNET_CHAIN) &&
    (account.features.includes(SolanaSignAndSendTransaction) ||
      account.features.includes(SolanaSignMessage)),
  );
}

function remembered(): string | null {
  try {
    return window.localStorage.getItem(REMEMBERED_WALLET);
  } catch {
    return null;
  }
}

function remember(name: string | null) {
  try {
    if (name === null) window.localStorage.removeItem(REMEMBERED_WALLET);
    else window.localStorage.setItem(REMEMBERED_WALLET, name);
  } catch {
    // Storage can be unavailable (private mode); the session still works, it is just not remembered.
  }
}

export type SolanaWalletSession = {
  wallets: readonly DevnetWallet[];
  selectedWallet: DevnetWallet | null;
  accounts: readonly WalletAccount[];
  selectedAccount: WalletAccount | null;
  connecting: boolean;
  error: string | null;
  canSignAndSendV0: boolean;
  canSignMessage: boolean;
  selectAccount(address: string): void;
  connect(walletName: string): Promise<boolean>;
  disconnect(): Promise<void>;
  signAndSend(transaction: Uint8Array): Promise<string>;
  signMessage(message: Uint8Array): Promise<string>;
};

const SolanaWalletContext = createContext<SolanaWalletSession | null>(null);

export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<readonly DevnetWallet[]>([]);
  const [selectedWalletName, setSelectedWalletName] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<readonly WalletAccount[]>([]);
  const [selectedAccountAddress, setSelectedAccountAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const silentTried = useRef(false);

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

  const applyAccounts = useCallback((next: readonly WalletAccount[]) => {
    const eligible = eligibleAccounts(next);
    setAccounts(eligible);
    setSelectedAccountAddress((current) =>
      eligible.some((account) => account.address === current) ? current : eligible[0]?.address ?? null,
    );
    return eligible;
  }, []);

  // Account switches and revocations inside the wallet flow straight back into the session.
  useEffect(() => {
    if (!selectedWallet) return;
    const events = selectedWallet.features[StandardEvents];
    if (!events) return;
    return events.on("change", (properties) => {
      if (properties.accounts) applyAccounts(properties.accounts);
    });
  }, [applyAccounts, selectedWallet]);

  // Reconnect the remembered wallet without a prompt; a wallet that wants approval stays disconnected.
  useEffect(() => {
    if (silentTried.current || wallets.length === 0) return;
    const name = remembered();
    const wallet = name ? wallets.find((entry) => entry.name === name) : undefined;
    if (!wallet) return;
    silentTried.current = true;
    wallet.features[StandardConnect]
      .connect({ silent: true })
      .then((output) => {
        if (applyAccounts(output.accounts).length > 0) setSelectedWalletName(wallet.name);
      })
      .catch(() => undefined);
  }, [applyAccounts, wallets]);

  const connect = useCallback(async (walletName: string) => {
    const wallet = wallets.find((entry) => entry.name === walletName);
    if (!wallet) return false;
    setConnecting(true);
    setError(null);
    try {
      const output = await wallet.features[StandardConnect].connect();
      const eligible = applyAccounts(output.accounts);
      if (eligible.length === 0) {
        setError(`${wallet.name} did not authorize a Solana Devnet account.`);
        return false;
      }
      setSelectedWalletName(wallet.name);
      remember(wallet.name);
      return true;
    } catch (cause) {
      setError(cause instanceof Error && /reject|denied|cancel/i.test(cause.message) ? "Connection cancelled." : "Wallet connection failed.");
      return false;
    } finally {
      setConnecting(false);
    }
  }, [applyAccounts, wallets]);

  const disconnect = useCallback(async () => {
    const feature = selectedWallet?.features[StandardDisconnect];
    if (feature) await feature.disconnect().catch(() => undefined);
    remember(null);
    setSelectedWalletName(null);
    setAccounts([]);
    setSelectedAccountAddress(null);
    setError(null);
  }, [selectedWallet]);

  const activeAccounts = useMemo(() => (selectedWallet ? accounts : NO_ACCOUNTS), [accounts, selectedWallet]);
  const selectedAccount = activeAccounts.find((account) => account.address === selectedAccountAddress) ?? null;
  const canSignAndSendV0 = Boolean(
    selectedWallet && selectedAccount &&
    selectedWallet.features[SolanaSignAndSendTransaction]?.supportedTransactionVersions.includes(0),
  );
  const canSignMessage = Boolean(
    selectedWallet && selectedAccount &&
    selectedAccount.features.includes(SolanaSignMessage) &&
    selectedWallet.features[SolanaSignMessage],
  );

  const signAndSend = useCallback(async (transaction: Uint8Array) => {
    const sender = selectedWallet?.features[SolanaSignAndSendTransaction];
    if (!selectedWallet || !selectedAccount || !canSignAndSendV0 || !sender) {
      throw new Error("A Wallet Standard account with Devnet v0 signing is required.");
    }
    let output;
    try {
      [output] = await sender.signAndSendTransaction({
        transaction,
        account: selectedAccount,
        chain: SOLANA_DEVNET_CHAIN,
        options: { skipPreflight: false, maxRetries: 3 },
      });
    } catch (cause) {
      // A new wallet has no Devnet SOL for fees and rent; say so instead of the raw simulation error.
      const message = cause instanceof Error ? cause.message : "";
      if (/no record of a prior credit|insufficient (funds|lamports)|insufficient.*fee/i.test(message)) {
        throw new Error("Not enough Devnet SOL for fees. Get some from the Gas link on the Portfolio page, then retry.");
      }
      throw cause;
    }
    if (!output || output.signature.length !== 64) throw new Error("Wallet submission returned an invalid signature.");
    return bs58.encode(output.signature);
  }, [canSignAndSendV0, selectedAccount, selectedWallet]);

  const signMessage = useCallback(async (message: Uint8Array) => {
    const signer = selectedWallet?.features[SolanaSignMessage];
    if (!selectedWallet || !selectedAccount || !canSignMessage || !signer) {
      throw new Error("A Wallet Standard account with Solana message signing is required.");
    }
    const [output] = await signer.signMessage({ message, account: selectedAccount });
    if (!output || output.signature.length !== 64 || !bytesEqual(output.signedMessage, message)) {
      throw new Error("Wallet did not sign the exact canonical order bytes.");
    }
    return bs58.encode(output.signature);
  }, [canSignMessage, selectedAccount, selectedWallet]);

  const value = useMemo<SolanaWalletSession>(() => ({
    wallets,
    selectedWallet,
    accounts: activeAccounts,
    selectedAccount,
    connecting,
    error,
    canSignAndSendV0,
    canSignMessage,
    selectAccount: setSelectedAccountAddress,
    connect,
    disconnect,
    signAndSend,
    signMessage,
  }), [activeAccounts, canSignAndSendV0, canSignMessage, connect, connecting, disconnect, error, selectedAccount, selectedWallet, signAndSend, signMessage, wallets]);

  return <SolanaWalletContext.Provider value={value}>{children}</SolanaWalletContext.Provider>;
}

export function useSolanaWallet(): SolanaWalletSession {
  const session = useContext(SolanaWalletContext);
  if (!session) throw new Error("useSolanaWallet must be used inside SolanaWalletProvider.");
  return session;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
