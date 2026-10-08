"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AssetIcon, ChainIcon } from "@/features/brand/chain-icons";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import { shortAddress, useWalletModal } from "@/features/wallet/wallet-modal";
import type { DomainId } from "../terminal-view-model";
import { DOMAIN_META, DOMAIN_ORDER, EXIT_UNAVAILABLE, domainLive, useTerminal } from "../shell/terminal-context";
import { attemptsOf } from "../shell/attempt-index";
import { useEvmBalances, useHyperliquidBalance, useSolanaBalance, type Amount, type ChainBalance } from "./use-balances";
import { formatAtomicAmount, formatScaledInteger } from "../format";
import { usePortfolioIntelligence } from "./use-portfolio-intelligence";
import { StrategyEntryManager, StrategyLifecycleManager } from "./strategy-lifecycle-manager";
import { usePositions } from "./use-positions";
import { GAS_FAUCETS, TEST_USDC_GRANT, useTestUsdcFaucets } from "./use-test-usdc";
import styles from "./pages.module.css";

const POSITION_COLUMNS = ["Package", "Chain", "Size", "Entry notional", "State", ""];
const INTELLIGENCE_COLUMNS = ["Strategy account", "Position evidence", "Available collateral", "Risk domains", "Freshness"];

/** What each chain's account is and the limits the code enforces on it. Nothing here claims a deployment. */
const ACCOUNT_TERMS: Readonly<Record<DomainId, readonly (readonly [string, string])[]>> = {
  solana: [
    ["Signer", "Your Wallet Standard account signs every package"],
    ["Settlement", "Atomic: every leg settles in one transaction, or none does"],
    ["Review", "The exact transaction is shown before any Devnet signature"],
    ["Spot venue", "Firm solver inventory reservation on Solana Devnet"],
    ["Perp venue", "Naryx test perpetual market on Solana Devnet, priced from Pyth"],
    ["Quote asset", "Naryx test USDC (free claim on this page)"],
  ],
  base: [
    ["Strategy account", "NaryxStrategyAccount, one per owner"],
    ["Authority", "Owner signs every package; a delegate may only submit an owner-signed recovery exit"],
    ["Ownership transfer", "Two-step: the new owner must accept"],
    ["Spot venue", "Uniswap V3 on Base Sepolia (WETH / test USDC pool)"],
    ["Perp venue", "Naryx test perpetual market on Base Sepolia, priced from Chainlink; not a third-party exchange"],
    ["Quote asset", "Naryx Test USDC (free claim on this page)"],
  ],
  arbitrum: [
    ["Strategy account", "GMX V2 isolated account, one per owner"],
    ["Settlement", "The solver settles within its window or its bond pays the signed fault amount"],
    ["Ownership transfer", "Two-step: the new owner must accept"],
    ["Spot venue", "Uniswap V3 on Arbitrum Sepolia (WETH / USDC.SG pool)"],
    ["Perp venue", "GMX V2 on Arbitrum Sepolia"],
    ["Quote asset", "GMX test USDC (USDC.SG), the GMX market's collateral; free claim on this page"],
  ],
  hyperliquid: [
    ["Account mode", "Standard only; unified, default, and portfolio-margin accounts are refused"],
    ["Ledgers", "Spot and perpetual USDC are funded separately"],
    ["Executor", "Trade-only API wallet on Naryx's shared testnet account, executing for your wallet; not trustless"],
    ["Recovery", "Bounded by the signed price, deadline, loss, fee, and residual policy"],
    ["Venue", "Hyperliquid testnet spot and perpetuals (HyperCore)"],
    ["Quote asset", "Hyperliquid testnet USDC held by the service's testnet account"],
  ],
};

function amountText(amount: Amount, balance: ChainBalance, connected: boolean, quote = false) {
  if (!connected) return <span className={styles.dim}>-</span>;
  if (quote && balance.quoteUnconfigured) return <span className={styles.dim} title="This deployment has not set its quote token">Not configured</span>;
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

function shortId(value: string): string {
  return value.length > 22 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value;
}

function ageText(value: bigint): string {
  if (value < BigInt(1_000)) return "Now";
  if (value < BigInt(60_000)) return `${value / BigInt(1_000)} s`;
  if (value < BigInt(3_600_000)) return `${value / BigInt(60_000)} min`;
  if (value < BigInt(86_400_000)) return `${value / BigInt(3_600_000)} h`;
  return `${value / BigInt(86_400_000)} d`;
}

export function PortfolioView() {
  const { selectedDomain, setSelectedDomain, runtimeHealth, healthState, attempts, publicApiBaseUrl } = useTerminal();
  const router = useRouter();
  const { positions, loading: positionsLoading, unreadable } = usePositions();
  const solana = useSolanaWallet();
  const evm = useEvmWallet();
  const modal = useWalletModal();
  const solanaAddress = solana.selectedAccount?.address ?? null;
  const evmAddress = evm.account;
  const intelligence = usePortfolioIntelligence(publicApiBaseUrl, [solanaAddress, evmAddress]);
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
  const faucets = useTestUsdcFaucets();
  const faucetNotices = DOMAIN_ORDER.flatMap((domain) => {
    const faucet = faucets[domain];
    const text = faucet.busy ?? faucet.error ?? faucet.message;
    return text ? [{ domain, text, error: faucet.error !== null && faucet.busy === null }] : [];
  });

  return (
    <main className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1>Portfolio</h1>
          <p>Balances on each test network, open packages, and the accounts that sign for them. Balances are read directly from each network. The only signature this page asks for is a free test USDC claim, from your own wallet.</p>
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
          <strong>{positionsLoading && positions.length === 0 ? "-" : positions.length}</strong>
          <small>{unreadable.length > 0 ? "Some networks could not be read" : "Read from each network"}</small>
        </div>
        <div>
          <span>Packages started here</span>
          <strong>{attemptsOf(attempts, [solanaAddress, evmAddress].filter((owner): owner is string => owner !== null)).length}</strong>
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
          <p>One row per execution domain. Test USDC is free: each claim adds {TEST_USDC_GRANT}. Gas comes from each network&apos;s faucet.</p>
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
                const live = domainLive(domain, runtimeHealth);
                const faucet = faucets[domain];
                const gasFaucet = GAS_FAUCETS[domain];
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
                          : amountText(balance.usdc, balance, account !== null, true)}
                      </span>
                    </td>
                    <td>
                      <span className={live ? styles.pillOk : styles.pill}>
                        {healthState === "unconfigured" ? "Preview" : live ? "Live" : healthState === "checking" ? "Checking" : "Preview"}
                      </span>
                    </td>
                    <td className={styles.num}>
                      {account ? (
                        <span className={styles.rowActions}>
                          {gasFaucet ? (
                            <a className={styles.ghost} href={gasFaucet.href} target="_blank" rel="noopener noreferrer" title={`Get ${gasFaucet.label} for gas`}>Gas</a>
                          ) : null}
                          {faucet.available ? (
                            <button
                              type="button"
                              className={styles.ghost}
                              disabled={faucet.busy !== null}
                              aria-busy={faucet.busy !== null}
                              onClick={() => void faucet.claim()}
                            >
                              {faucet.busy !== null ? "Claiming" : faucet.needsSwitch ? `Switch to ${meta.network}` : "Get test USDC"}
                            </button>
                          ) : null}
                          <Link className={styles.ghost} href="/trade" onClick={() => setSelectedDomain(domain)}>Trade</Link>
                        </span>
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
        {faucetNotices.length > 0 ? (
          <div className={styles.cardBody} role="status" aria-live="polite">
            {faucetNotices.map((notice) => (
              <p key={notice.domain} className={notice.error ? styles.noticeError : styles.noticeOk}>
                {DOMAIN_META[notice.domain].label}: {notice.text}
              </p>
            ))}
          </div>
        ) : null}
      </section>

      <section className={styles.card} aria-labelledby="positions-title">
        <div className={styles.cardHead}>
          <h2 id="positions-title">Positions</h2>
          <p>Open packages of the connected wallets, read from each chain, so they follow the wallet across devices.</p>
        </div>
        {unreadable.length > 0 ? (
          <p className={styles.noticeError} role="status">
            Could not read open packages on {unreadable.map((domain) => DOMAIN_META[domain].label).join(", ")}. Retrying.
          </p>
        ) : null}
        {DOMAIN_ORDER.filter((domain) => EXIT_UNAVAILABLE[domain] !== undefined
          && positions.some((position) => position.domain === domain && position.state === "Open")).map((domain) => (
          <p key={domain} className={styles.notice} role="status">{EXIT_UNAVAILABLE[domain]}</p>
        ))}
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                {POSITION_COLUMNS.map((column, index) => (
                  <th key={column || "action"} scope="col" className={index >= 2 && index <= 3 ? styles.num : undefined}>
                    {column || <span className="sr-only">Action</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={POSITION_COLUMNS.length}>
                    <div className={styles.empty}>
                      <strong>{positionsLoading ? "Reading open packages" : "No open packages"}</strong>
                      <p>A package appears here once it is entered, with its size, entry notional, and state. Connect the wallet that owns it.</p>
                      <Link href="/trade">Open a package</Link>
                    </div>
                  </td>
                </tr>
              ) : positions.map((position) => (
                <tr key={position.key}>
                  <td className={styles.mono}>{position.packageId}</td>
                  <td>
                    <span className={styles.chainCell}>
                      <ChainIcon chain={position.domain} size={20} />
                      <span>
                        <strong>{DOMAIN_META[position.domain].label}</strong>
                        <small>{DOMAIN_META[position.domain].network}</small>
                      </span>
                    </span>
                  </td>
                  <td className={styles.num}>{position.size}</td>
                  <td className={styles.num}>{position.entryNotional ?? <span className={styles.dim}>-</span>}</td>
                  <td>
                    <span className={position.state === "Open" ? styles.pillOk : position.state === "Unresolved" ? styles.pillBad : styles.pillWarn}>
                      {position.state}
                    </span>
                  </td>
                  <td className={styles.num}>
                    {position.state === "Open" && EXIT_UNAVAILABLE[position.domain] !== undefined ? (
                      <span className={styles.dim} title={EXIT_UNAVAILABLE[position.domain]}>Exit not available yet</span>
                    ) : position.state === "Open" ? (
                      <button
                        type="button"
                        className={styles.ghost}
                        aria-label={`Exit the ${DOMAIN_META[position.domain].network} package ${position.packageId}`}
                        onClick={() => {
                          setSelectedDomain(position.domain);
                          router.push("/trade?mode=exit");
                        }}
                      >
                        Exit
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.card} aria-labelledby="portfolio-intelligence-title">
        <div className={styles.cardHead}>
          <h2 id="portfolio-intelligence-title">Clearing intelligence</h2>
          <p>Signed position and collateral observations used for package comparison. An observation proves its configured publisher, not the venue itself.</p>
        </div>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                {INTELLIGENCE_COLUMNS.map((column, index) => (
                  <th key={column} scope="col" className={index === 2 ? styles.num : undefined}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {intelligence.rows.length === 0 ? (
                <tr>
                  <td colSpan={INTELLIGENCE_COLUMNS.length}>
                    <div className={styles.empty}>
                      <strong>{intelligence.loading ? "Reading signed portfolio state" : intelligence.unavailable ? "Signed portfolio state unavailable" : !intelligence.configured ? "Public portfolio API not configured" : connectedCount === 0 ? "Connect a wallet" : "No signed strategy state yet"}</strong>
                      <p>{intelligence.unavailable
                        ? "The last request failed, so no position or collateral amount is inferred."
                        : "Open strategy accounts appear here after configured observation authorities publish their current state."}</p>
                    </div>
                  </td>
                </tr>
              ) : intelligence.rows.map((row) => {
                const ages = [row.positionAgeMs, ...row.collateral.map((source) => source.ageMs)].filter((age): age is bigint => age !== null);
                const oldest = ages.reduce<bigint | null>((current, age) => current === null || age > current ? age : current, null);
                const stale = oldest !== null && oldest > BigInt(300_000);
                const riskDomains = [...new Set(row.collateral.map((source) => source.riskDomainId))].sort();
                return (
                  <tr key={row.strategyId}>
                    <td className={styles.mono} title={row.strategyId}>{shortId(row.strategyId)}</td>
                    <td>
                      <strong>{row.positionCount}</strong> <span className={styles.dim}>positions</span>
                      <small className={styles.cellDetail}>{row.positionSources} signed source{row.positionSources === 1 ? "" : "s"}</small>
                    </td>
                    <td className={styles.num}>
                      {row.collateral.length === 0 ? <span className={styles.dim}>No observation</span> : (
                        <span className={styles.cellStack}>
                          {row.collateral.map((source) => (
                            <span key={`${source.sourceId}:${source.assetId}:${source.riskDomainId}`} title={`${source.sourceId}; ${source.mode}; ${formatScaledInteger(source.haircutBps, 2, "%")} haircut`}>
                              {formatAtomicAmount(source.availableAtoms, source.decimals, source.assetId.toUpperCase())}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td>
                      {riskDomains.length === 0 ? <span className={styles.dim}>-</span> : (
                        <span className={styles.cellStack}>{riskDomains.map((domain) => <span key={domain}>{domain}</span>)}</span>
                      )}
                    </td>
                    <td>
                      <span className={oldest === null ? styles.pill : stale ? styles.pillWarn : styles.pillOk}>
                        {oldest === null ? "Missing" : stale ? `Stale ${ageText(oldest)}` : `Observed ${ageText(oldest)}`}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {publicApiBaseUrl !== null && connectedCount > 0 ? (
        <StrategyEntryManager baseUrl={publicApiBaseUrl} refresh={intelligence.refresh} />
      ) : null}

      {publicApiBaseUrl !== null && intelligence.rows.length > 0 ? (
        <StrategyLifecycleManager baseUrl={publicApiBaseUrl} strategies={intelligence.rows} refresh={intelligence.refresh} />
      ) : null}

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
