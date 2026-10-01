"use client";

import Link from "next/link";
import { AssetIcon, ChainIcon } from "@/features/brand/chain-icons";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import { shortAddress, useWalletModal } from "@/features/wallet/wallet-modal";
import type { DomainId } from "../terminal-view-model";
import { DOMAIN_META, DOMAIN_ORDER, domainHealth, useTerminal } from "../shell/terminal-context";
import { useEvmBalances, useHyperliquidBalance, useSolanaBalance, type Amount, type ChainBalance } from "./use-balances";
import styles from "./pages.module.css";

const POSITION_COLUMNS = ["Package", "Chain", "Mode", "Size", "Cost basis", "Mark", "Exit cost", "PnL", "State"];

/** What each chain's account is and the limits the code enforces on it. Nothing here claims a deployment. */
const ACCOUNT_TERMS: Readonly<Record<DomainId, readonly (readonly [string, string])[]>> = {
  solana: [
    ["Signer", "Your Wallet Standard account signs every package"],
    ["Settlement", "Atomic: every leg settles in one transaction, or none does"],
    ["Review", "The exact transaction is shown before any Devnet signature"],
    ["Deployment", "Solana Devnet program deployment is deferred"],
  ],
  base: [
    ["Strategy account", "NaryxStrategyAccount, one per owner"],
    ["Authority", "Owner signs every package; a delegate may only submit an owner-signed recovery exit"],
    ["Ownership transfer", "Two-step: the new owner must accept"],
    ["Deployment", "Base Sepolia deployment is deferred"],
  ],
  arbitrum: [
    ["Strategy account", "NaryxStrategyAccount, one per owner"],
    ["Settlement", "The solver settles within its window or its bond pays the signed fault amount"],
    ["Ownership transfer", "Two-step: the new owner must accept"],
    ["Deployment", "Arbitrum Sepolia deployment is deferred"],
  ],
  hyperliquid: [
    ["Account mode", "Standard only; unified, default, and portfolio-margin accounts are refused"],
    ["Ledgers", "Spot and perpetual USDC are funded separately"],
    ["Executor", "Trade-only API wallet on a dedicated testnet account; not trustless"],
    ["Recovery", "Bounded by the signed price, deadline, loss, fee, and residual policy"],
  ],
};

function amountText(amount: Amount, balance: ChainBalance, connected: boolean) {
  if (!connected) return <span className={styles.dim}>-</span>;
  if (balance.loading) return <span className={styles.dim}>Loading</span>;
  if (!amount) return <span className={styles.dim}>{balance.failed ? "Unavailable" : "-"}</span>;
  return <>{amount.value} <span className={styles.dim}>{amount.symbol}</span></>;
}

function sumUsdc(amounts: readonly Amount[]): string | null {
  let total = 0;
  let any = false;
  for (const amount of amounts) {
    if (!amount) continue;
    const value = Number(amount.value);
    if (!Number.isFinite(value)) continue;
    total += value;
    any = true;
  }
  return any ? total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;
}

export function PortfolioView() {
  const { selectedDomain, setSelectedDomain, runtimeHealth, healthState, attempts } = useTerminal();
  const solana = useSolanaWallet();
  const evm = useEvmWallet();
  const modal = useWalletModal();
  const solanaAddress = solana.selectedAccount?.address ?? null;
  const evmAddress = evm.account;
  const evmBalances = useEvmBalances(evmAddress);
  const balances: Readonly<Record<DomainId, ChainBalance>> = {
    solana: useSolanaBalance(solanaAddress),
    base: evmBalances.base,
    arbitrum: evmBalances.arbitrum,
    hyperliquid: useHyperliquidBalance(evmAddress),
  };
  const accountFor = (domain: DomainId) => (DOMAIN_META[domain].wallet === "solana" ? solanaAddress : evmAddress);
  const usdcTotal = sumUsdc([
    balances.solana.usdc,
    balances.base.usdc,
    balances.arbitrum.usdc,
    balances.hyperliquid.usdc,
    balances.hyperliquid.perpEquity ?? null,
  ]);
  const connectedCount = (solanaAddress ? 1 : 0) + (evmAddress ? 1 : 0);

  return (
    <main className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1>Portfolio</h1>
          <p>Balances on each test network, open packages, and the accounts that sign for them. Balances are read directly from each network; nothing on this page signs or moves funds.</p>
        </div>
      </div>

      <div className={styles.summary}>
        <div>
          <span>Testnet USDC</span>
          <strong>{usdcTotal !== null ? `$${usdcTotal}` : "-"}</strong>
          <small>Across connected accounts</small>
        </div>
        <div>
          <span>Open packages</span>
          <strong>0</strong>
          <small>None reported by the service</small>
        </div>
        <div>
          <span>Packages started here</span>
          <strong>{attempts.length}</strong>
          <small><Link href="/activity">View activity</Link></small>
        </div>
        <div>
          <span>Accounts connected</span>
          <strong>{connectedCount} of 2</strong>
          <small>Solana and one EVM account</small>
        </div>
      </div>

      <section className={styles.card} aria-labelledby="balances-title">
        <div className={styles.cardHead}>
          <h2 id="balances-title">Balances</h2>
          <p>One row per execution domain.</p>
        </div>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Chain</th>
                <th scope="col">Account</th>
                <th scope="col" className={styles.num}>Gas</th>
                <th scope="col" className={styles.num}>USDC</th>
                <th scope="col">Execution</th>
                <th scope="col"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {DOMAIN_ORDER.map((domain) => {
                const meta = DOMAIN_META[domain];
                const account = accountFor(domain);
                const balance = balances[domain];
                const health = domainHealth(domain, runtimeHealth);
                const live = health?.available === true;
                return (
                  <tr key={domain}>
                    <td>
                      <span className={styles.chainCell}>
                        <ChainIcon chain={domain} size={24} />
                        <span>
                          <strong>{meta.label}</strong>
                          <small>{meta.network}</small>
                        </span>
                      </span>
                    </td>
                    <td className={styles.mono} title={account ?? undefined}>
                      {account ? shortAddress(account, 6, 4) : <span className={styles.dim}>Not connected</span>}
                    </td>
                    <td className={styles.num}>
                      {domain === "hyperliquid"
                        ? <span className={styles.dim} title="HyperCore orders pay no gas">None</span>
                        : amountText(balance.gas, balance, account !== null)}
                    </td>
                    <td className={styles.num}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {account && balance.usdc ? <AssetIcon symbol="USDC" size={14} /> : null}
                        {domain === "hyperliquid" && account && balance.perpEquity
                          ? <span title="Spot balance / perpetual account equity">{balance.usdc?.value ?? "0"} <span className={styles.dim}>spot</span> / {balance.perpEquity.value} <span className={styles.dim}>perp</span></span>
                          : amountText(balance.usdc, balance, account !== null)}
                      </span>
                    </td>
                    <td>
                      <span className={live ? styles.pillOk : styles.pill}>
                        {healthState === "unconfigured" ? "Preview" : live ? "Live" : healthState === "checking" ? "Checking" : "Preview"}
                      </span>
                    </td>
                    <td className={styles.num}>
                      {account ? (
                        <Link className={styles.ghost} href="/trade" onClick={() => setSelectedDomain(domain)}>Trade</Link>
                      ) : (
                        <button type="button" className={styles.ghost} onClick={() => modal.open(meta.wallet)}>Connect</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.card} aria-labelledby="positions-title">
        <div className={styles.cardHead}>
          <h2 id="positions-title">Positions</h2>
          <p>Open packages with their exit cost and recovery state.</p>
        </div>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                {POSITION_COLUMNS.map((column, index) => (
                  <th key={column} scope="col" className={index >= 3 && index <= 7 ? styles.num : undefined}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={POSITION_COLUMNS.length}>
                  <div className={styles.empty}>
                    <strong>No open packages</strong>
                    <p>A package appears here once it is entered and settled, with its cost basis, live exit cost, and recovery state.</p>
                    <Link href="/trade">Open a package</Link>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.card} aria-labelledby="account-terms-title">
        <div className={styles.cardHead}>
          <ChainIcon chain={selectedDomain} size={16} />
          <h2 id="account-terms-title">{DOMAIN_META[selectedDomain].label} account terms</h2>
          <div className={styles.headActions} role="group" aria-label="Chain">
            {DOMAIN_ORDER.map((domain) => (
              <button
                key={domain}
                type="button"
                className={styles.ghost}
                aria-pressed={domain === selectedDomain}
                style={domain === selectedDomain ? { borderColor: "var(--line-strong)", color: "var(--text-primary)" } : undefined}
                onClick={() => setSelectedDomain(domain)}
              >
                {DOMAIN_META[domain].label}
              </button>
            ))}
          </div>
        </div>
        <dl className={`${styles.facts} ${styles.cardBody}`}>
          {ACCOUNT_TERMS[selectedDomain].map(([term, detail]) => (
            <div key={term} style={{ display: "contents" }}>
              <dt>{term}</dt>
              <dd style={{ whiteSpace: "normal", textAlign: "left" }}>{detail}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
