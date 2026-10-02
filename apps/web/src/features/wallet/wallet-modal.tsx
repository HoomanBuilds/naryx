"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Connector } from "wagmi";
import { ChainIcon, WalletIcon, type KnownWallet } from "@/features/brand/chain-icons";
import { EVM_CHAINS, type EvmDomain } from "./evm-config";
import { useEvmWallet } from "./evm-wallet";
import { useSolanaWallet } from "./solana-wallet";
import styles from "./wallet.module.css";

export type WalletSection = "solana" | "evm";

type WalletModalApi = {
  open(section?: WalletSection): void;
  close(): void;
};

const WalletModalContext = createContext<WalletModalApi | null>(null);

export function useWalletModal(): WalletModalApi {
  const api = useContext(WalletModalContext);
  if (!api) throw new Error("useWalletModal must be used inside WalletModalProvider.");
  return api;
}

export function WalletModalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; section: WalletSection | null }>({ open: false, section: null });
  const api = useMemo<WalletModalApi>(() => ({
    open: (section) => setState({ open: true, section: section ?? null }),
    close: () => setState((current) => ({ ...current, open: false })),
  }), []);
  return (
    <WalletModalContext.Provider value={api}>
      {children}
      <WalletModal open={state.open} section={state.section} onClose={api.close} />
    </WalletModalContext.Provider>
  );
}

export function shortAddress(value: string, leading = 4, trailing = 4) {
  return value.length <= leading + trailing + 3 ? value : `${value.slice(0, leading)}...${value.slice(-trailing)}`;
}

const SOLANA_INSTALL: readonly { wallet: KnownWallet; name: string; href: string }[] = [
  { wallet: "phantom", name: "Phantom", href: "https://phantom.com/download" },
  { wallet: "solflare", name: "Solflare", href: "https://solflare.com/download" },
  { wallet: "backpack", name: "Backpack", href: "https://backpack.app/downloads" },
];

const EVM_INSTALL: readonly { wallet: KnownWallet; name: string; href: string }[] = [
  { wallet: "metamask", name: "MetaMask", href: "https://metamask.io/download" },
  { wallet: "rabby", name: "Rabby", href: "https://rabby.io" },
  { wallet: "coinbase", name: "Coinbase Wallet", href: "https://www.coinbase.com/wallet/downloads" },
];

/** A wallet's own icon as announced through the Wallet Standard or EIP-6963. */
function AnnouncedIcon({ src, name, size = 28 }: { src: string | undefined; name: string; size?: number }) {
  if (src && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(src)) {
    // Announced icons are data URIs; an img element renders them without executing anything.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={styles.walletLogo} src={src} alt="" width={size} height={size} />;
  }
  return (
    <span className={styles.walletLogoFallback} style={{ width: size, height: size }} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={styles.iconButton}
      aria-label={copied ? "Address copied" : "Copy address"}
      title={copied ? "Copied" : "Copy address"}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined);
      }}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" /></svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M3 10.5V4.5A1.5 1.5 0 0 1 4.5 3h6" /></svg>
      )}
    </button>
  );
}

function InstallList({ entries }: { entries: readonly { wallet: KnownWallet; name: string; href: string }[] }) {
  return (
    <div className={styles.installList}>
      <p>No wallet detected in this browser. Install one, then reload.</p>
      <ul>
        {entries.map((entry) => (
          <li key={entry.wallet}>
            <a href={entry.href} target="_blank" rel="noopener noreferrer">
              <WalletIcon wallet={entry.wallet} size={22} />
              <span>{entry.name}</span>
              <small>Install</small>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SolanaSection({ highlighted }: { highlighted: boolean }) {
  const solana = useSolanaWallet();
  const [pending, setPending] = useState<string | null>(null);
  const account = solana.selectedAccount;

  return (
    <section className={highlighted ? `${styles.section} ${styles.sectionFocus}` : styles.section} aria-labelledby="wallet-solana-title">
      <div className={styles.sectionHead}>
        <ChainIcon chain="solana" size={18} />
        <h3 id="wallet-solana-title">Solana</h3>
        <span className={styles.networkTag}>Devnet</span>
      </div>

      {account && solana.selectedWallet ? (
        <div className={styles.accountCard}>
          <AnnouncedIcon src={solana.selectedWallet.icon} name={solana.selectedWallet.name} size={32} />
          <div className={styles.accountText}>
            <strong title={account.address}>{shortAddress(account.address, 6, 6)}</strong>
            <small>
              <i className={styles.dotOk} aria-hidden="true" />
              {solana.selectedWallet.name} on Solana Devnet
            </small>
          </div>
          <CopyButton value={account.address} />
          <button type="button" className={styles.textButton} onClick={() => void solana.disconnect()}>
            Disconnect
          </button>
          {solana.accounts.length > 1 ? (
            <label className={styles.accountSelect}>
              <span>Account</span>
              <select value={account.address} onChange={(event) => solana.selectAccount(event.target.value)}>
                {solana.accounts.map((entry) => (
                  <option key={entry.address} value={entry.address}>
                    {entry.label ? `${entry.label} (${shortAddress(entry.address)})` : shortAddress(entry.address, 6, 6)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : solana.wallets.length === 0 ? (
        <InstallList entries={SOLANA_INSTALL} />
      ) : (
        <ul className={styles.walletList}>
          {solana.wallets.map((wallet) => {
            const busy = solana.connecting && pending === wallet.name;
            return (
              <li key={wallet.name}>
                <button
                  type="button"
                  className={styles.walletRow}
                  disabled={solana.connecting}
                  onClick={async () => {
                    setPending(wallet.name);
                    await solana.connect(wallet.name);
                    setPending(null);
                  }}
                >
                  <AnnouncedIcon src={wallet.icon} name={wallet.name} />
                  <span>{wallet.name}</span>
                  <small>{busy ? "Approve in wallet" : "Detected"}</small>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {solana.error ? <p className={styles.error} role="alert">{solana.error}</p> : null}
    </section>
  );
}

function connectorLabel(connector: Connector) {
  return connector.id === "injected" ? "Browser wallet" : connector.name;
}

function EvmSection({ highlighted }: { highlighted: boolean }) {
  const evm = useEvmWallet();
  const [pending, setPending] = useState<string | null>(null);
  const domains = Object.keys(EVM_CHAINS) as EvmDomain[];
  const activeDomain = domains.find((domain) => evm.onChain(domain)) ?? null;

  return (
    <section className={highlighted ? `${styles.section} ${styles.sectionFocus}` : styles.section} aria-labelledby="wallet-evm-title">
      <div className={styles.sectionHead}>
        <span className={styles.iconStack} aria-hidden="true">
          <ChainIcon chain="base" size={18} />
          <ChainIcon chain="arbitrum" size={18} />
          <ChainIcon chain="hyperliquid" size={18} />
        </span>
        <h3 id="wallet-evm-title">Base, Arbitrum, Hyperliquid</h3>
        <span className={styles.networkTag}>EVM testnets</span>
      </div>

      {evm.account && evm.connector ? (
        <div className={styles.accountCard}>
          <AnnouncedIcon src={evm.connector.icon} name={connectorLabel(evm.connector)} size={32} />
          <div className={styles.accountText}>
            <strong title={evm.account}>{shortAddress(evm.account, 6, 4)}</strong>
            <small>
              <i className={activeDomain ? styles.dotOk : styles.dotWarn} aria-hidden="true" />
              {connectorLabel(evm.connector)} on {activeDomain ? EVM_CHAINS[activeDomain].name : "another network"}
            </small>
          </div>
          <CopyButton value={evm.account} />
          <button type="button" className={styles.textButton} onClick={() => void evm.disconnect()}>
            Disconnect
          </button>
          <div className={styles.networkSwitch} role="group" aria-label="EVM test network">
            {domains.map((domain) => {
              const on = evm.onChain(domain);
              return (
                <button
                  key={domain}
                  type="button"
                  aria-pressed={on}
                  className={on ? styles.networkOn : undefined}
                  disabled={evm.switching || on}
                  onClick={() => void evm.switchNetwork(domain)}
                >
                  <ChainIcon chain={domain} size={14} />
                  {EVM_CHAINS[domain].name}
                </button>
              );
            })}
          </div>
        </div>
      ) : evm.connectors.length === 0 ? (
        <InstallList entries={EVM_INSTALL} />
      ) : (
        <ul className={styles.walletList}>
          {evm.connectors.map((connector) => {
            const busy = evm.connecting && pending === connector.uid;
            return (
              <li key={connector.uid}>
                <button
                  type="button"
                  className={styles.walletRow}
                  disabled={evm.connecting}
                  onClick={async () => {
                    setPending(connector.uid);
                    await evm.connect(connector);
                    setPending(null);
                  }}
                >
                  <AnnouncedIcon src={connector.icon} name={connectorLabel(connector)} />
                  <span>{connectorLabel(connector)}</span>
                  <small>{busy ? "Approve in wallet" : "Detected"}</small>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className={styles.sectionNote}>
        One EVM account covers all three. Hyperliquid accounts are EVM addresses; its testnet packages are owned and signed by your wallet and executed in Naryx&apos;s shared testnet account on your behalf.
      </p>
      {evm.error ? <p className={styles.error} role="alert">{evm.error}</p> : null}
    </section>
  );
}

function WalletModal({ open, section, onClose }: { open: boolean; section: WalletSection | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const handleBackdrop = useCallback((event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose();
  }, [onClose]);

  return (
    <dialog ref={dialog} className={styles.modal} aria-labelledby="wallet-modal-title" onClose={onClose} onClick={handleBackdrop}>
      {open ? (
        <div className={styles.modalBody}>
          <header className={styles.modalHead}>
            <h2 id="wallet-modal-title">Wallets</h2>
            <button type="button" className={styles.iconButton} aria-label="Close" onClick={onClose}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
            </button>
          </header>
          <p className={styles.modalLead}>
            Naryx connects to test networks only. Keys never leave your wallet, and every signature is shown there first.
          </p>
          {section === "evm" ? (
            <>
              <EvmSection highlighted />
              <SolanaSection highlighted={false} />
            </>
          ) : (
            <>
              <SolanaSection highlighted={section === "solana"} />
              <EvmSection highlighted={false} />
            </>
          )}
        </div>
      ) : null}
    </dialog>
  );
}
