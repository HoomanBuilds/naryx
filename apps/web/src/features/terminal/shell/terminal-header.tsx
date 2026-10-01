"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ChainIcon } from "@/features/brand/chain-icons";
import { EVM_CHAINS } from "@/features/wallet/evm-config";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import { shortAddress, useWalletModal } from "@/features/wallet/wallet-modal";
import type { DomainId } from "../terminal-view-model";
import { DOMAIN_META, DOMAIN_ORDER, domainLive, useTerminal } from "./terminal-context";
import styles from "./shell.module.css";

const NAV: readonly { href: "/trade" | "/portfolio" | "/activity" | "/network"; label: string }[] = [
  { href: "/trade", label: "Trade" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/activity", label: "Activity" },
  { href: "/network", label: "Network" },
];

function BrandMark() {
  return (
    <span className={styles.brandMark} aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <rect width="24" height="24" rx="5" />
        <path d="M7.4 6h3.1l1.5 2.6L13.5 6h3.1l-3.1 5.9L16.8 18h-3.1L12 15l-1.7 3H7.2l3.3-6.1Z" />
      </svg>
    </span>
  );
}

function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 12 12" aria-hidden="true">
      <path d="m3 4.5 3 3 3-3" />
    </svg>
  );
}

/** The execution domain picker: one chain at a time, like a venue's network switcher. */
function NetworkMenu() {
  const { selectedDomain, setSelectedDomain, runtimeHealth, healthState } = useTerminal();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const meta = DOMAIN_META[selectedDomain];

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function choose(domain: DomainId) {
    setSelectedDomain(domain);
    setOpen(false);
  }

  return (
    <div ref={root} className={styles.networkMenu}>
      <button
        type="button"
        className={styles.networkButton}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Execution domain: ${meta.label}, ${meta.network}`}
        onClick={() => setOpen((value) => !value)}
      >
        <ChainIcon chain={selectedDomain} size={18} />
        <span className={styles.networkText}>
          <strong>{meta.label}</strong>
          <small>{meta.network}</small>
        </span>
        <Chevron />
      </button>
      {open ? (
        <ul id={listId} className={styles.networkList} role="listbox" aria-label="Execution domain">
          {DOMAIN_ORDER.map((domain) => {
            const item = DOMAIN_META[domain];
            const status = healthState === "unconfigured"
              ? "Preview"
              : domainLive(domain, runtimeHealth) ? "Live" : healthState === "checking" ? "Checking" : "Off";
            return (
              <li key={domain} role="option" aria-selected={domain === selectedDomain}>
                <button type="button" onClick={() => choose(domain)} className={domain === selectedDomain ? styles.networkOptionOn : undefined}>
                  <ChainIcon chain={domain} size={22} />
                  <span className={styles.networkText}>
                    <strong>{item.label}</strong>
                    <small>{item.network} / {item.settlement}</small>
                  </span>
                  <span className={status === "Live" ? styles.statusLive : styles.statusMuted}>{status}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Connect, or the account that signs on the selected chain, like every venue's header button. */
function WalletButton() {
  const { selectedDomain } = useTerminal();
  const modal = useWalletModal();
  const solana = useSolanaWallet();
  const evm = useEvmWallet();
  const family = DOMAIN_META[selectedDomain].wallet;
  const solanaAddress = solana.selectedAccount?.address ?? null;
  const evmAddress = evm.account;
  const address = family === "solana" ? solanaAddress : evmAddress;
  const otherConnected = family === "solana" ? evmAddress !== null : solanaAddress !== null;
  const evmTarget = selectedDomain === "base" || selectedDomain === "arbitrum" ? selectedDomain : null;
  const wrongNetwork = family === "evm" && evmAddress !== null && evmTarget !== null && !evm.onChain(evmTarget);

  if (!address) {
    return (
      <button type="button" className={styles.connectButton} onClick={() => modal.open(family)}>
        {otherConnected ? `Connect ${family === "solana" ? "Solana" : "EVM"} wallet` : "Connect wallet"}
      </button>
    );
  }

  return (
    <div className={styles.walletGroup}>
      {wrongNetwork && evmTarget ? (
        <button
          type="button"
          className={styles.wrongNetwork}
          disabled={evm.switching}
          onClick={() => void evm.switchNetwork(evmTarget)}
        >
          {evm.switching ? "Switching" : `Switch to ${EVM_CHAINS[evmTarget].name}`}
        </button>
      ) : null}
      <button
        type="button"
        className={styles.accountButton}
        aria-label={`Wallets. ${family === "solana" ? "Solana" : "EVM"} account ${address}`}
        onClick={() => modal.open(family)}
      >
        <span className={styles.accountChains} aria-hidden="true">
          {solanaAddress ? <ChainIcon chain="solana" size={14} /> : null}
          {evmAddress ? <ChainIcon chain={family === "evm" ? selectedDomain : "base"} size={14} /> : null}
        </span>
        <span className={styles.accountAddress}>{shortAddress(address, family === "solana" ? 4 : 6, 4)}</span>
        <i className={wrongNetwork ? styles.dotWarn : styles.dotLive} aria-hidden="true" />
      </button>
    </div>
  );
}

export function TerminalHeader() {
  const pathname = usePathname();
  return (
    <header className={styles.header}>
      <Link className={styles.brand} href="/" prefetch={false} aria-label="Naryx home">
        <BrandMark />
        <span className={styles.wordmark}>NARYX</span>
      </Link>
      <nav className={styles.nav} aria-label="Terminal">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={active ? styles.navActive : undefined}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className={styles.headerEnd}>
        <NetworkMenu />
        <WalletButton />
      </div>
    </header>
  );
}
