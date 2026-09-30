"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fixtureMarketFeed } from "./market-feed";
import { usePublicMarketFeed } from "./public-market-feed";
import { SolverMetrics } from "./pro/solver-metrics";
import { handleTablistKeys, usePersistedSetting } from "./persisted-setting";
import { ChartWorkspace } from "./pro/chart-workspace";
import { InstrumentBar } from "./pro/instrument-bar";
import { OrderBook } from "./pro/order-book";
import { StatusBar } from "./pro/status-bar";
import { localConformanceTerminalProvider } from "./local-conformance-provider";
import { PrivateHttpTerminalProvider } from "./private-http-terminal-provider";
import type {
  HyperliquidOrderCreateResponse,
  HyperliquidSelectedAttempt,
  HyperliquidSolverQuote,
  HyperliquidTerminalExecutionResult,
  HyperliquidTestnetContext,
  LocalAuthorization,
  LocalExecutionAction,
  LocalOrderCreateResponse,
  LocalSelectedAttempt,
  LocalSolverQuote,
  PackageLifecycleResponse,
  PrivateTerminalRuntimeHealth,
  RuntimeBoundaryHealth,
  SolanaExecutionObservation,
} from "./private-http-terminal-provider";
import {
  EVM_TESTNETS,
  isEvmDomain,
  useInjectedEvmWallet,
  type InjectedEvmWalletSession,
} from "./injected-evm-wallet";
import {
  useSolanaDevnetWallet,
  type SolanaWalletSession,
} from "./solana-wallet-standard";
import type {
  DomainId,
  PackageMode,
  ProviderConnection,
  QuoteMode,
  SolanaExecutionPreparation,
  SolanaExecutionPreparationInput,
  SlippageBps,
  TerminalPreview,
  TerminalViewModel,
  WorkspaceTab,
} from "./terminal-view-model";
import styles from "./trading-terminal.module.css";

/** How long a prepared Devnet review stays signable. */
const REVIEW_TTL_MS = 45_000;
const SLIPPAGE_OPTIONS: readonly SlippageBps[] = [5, 10, 25];

const SIZE_PRESETS: readonly string[] = ["10", "50", "100", "250"];

type BottomTab = WorkspaceTab | "route" | "readiness" | "solvers";

/**
 * Formats an exact decimal string as dollars with grouping. Digits are never rounded; trailing
 * zeros beyond the cents are trimmed.
 */
function usd(value: string) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return value;
  const [, sign, whole, fraction = ""] = match;
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${sign}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${trimmed}`;
}

/** Trims padded atom decimals in display text: "100.000000 SOL" becomes "100 SOL", "$148.388240" becomes "$148.38824". */
function tidy(text: string) {
  return text.replace(/(\$?)(\d[\d,]*)\.(\d+)/g, (_, dollar: string, whole: string, fraction: string) => {
    const trimmed = fraction.replace(/0+$/, "");
    const kept = dollar ? trimmed.padEnd(2, "0") : trimmed;
    return kept === "" ? `${dollar}${whole}` : `${dollar}${whole}.${kept}`;
  });
}

function sanitizeSize(value: string) {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const [whole, ...decimals] = cleaned.split(".");
  return decimals.length > 0 ? `${whole}.${decimals.join("")}` : whole;
}

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

function shortAddress(value: string, leading = 4, trailing = 4) {
  return `${value.slice(0, leading)}...${value.slice(-trailing)}`;
}

function WalletControl({
  selectedDomain,
  wallet,
  evmWallet,
}: {
  selectedDomain: DomainId;
  wallet: SolanaWalletSession;
  evmWallet: InjectedEvmWalletSession;
}) {
  const evmDomain = isEvmDomain(selectedDomain) ? selectedDomain : null;
  const expectedNetwork = evmDomain ? EVM_TESTNETS[evmDomain] : null;
  const evmNetworkMatches = Boolean(
    expectedNetwork && evmWallet.chainId === expectedNetwork.chainId,
  );

  if (selectedDomain === "solana") {
    if (wallet.selectedAccount) {
      return (
        <div className={styles.walletControl}>
          {wallet.accounts.length > 1 ? (
            <select
              aria-label="Solana Devnet wallet account"
              value={wallet.selectedAccount.address}
              onChange={(event) => wallet.selectAccount(event.target.value)}
            >
              {wallet.accounts.map((account) => (
                <option key={account.address} value={account.address}>
                  {account.label ?? shortAddress(account.address)}
                </option>
              ))}
            </select>
          ) : null}
          <span className={styles.walletAccount} title={wallet.selectedAccount.address}>
            <i className={styles.dotLive} aria-hidden="true" />
            {shortAddress(wallet.selectedAccount.address)}
            <small>Devnet</small>
          </span>
          <button type="button" className={styles.navButton} onClick={() => void wallet.disconnect()}>
            Disconnect
          </button>
        </div>
      );
    }
    return (
      <div className={styles.walletControl}>
        <select
          aria-label="Solana Devnet wallet"
          value={wallet.selectedWallet?.name ?? ""}
          onChange={(event) => wallet.selectWallet(event.target.value)}
          title={wallet.error ?? "Wallet Standard wallets only"}
        >
          <option value="">{wallet.wallets.length === 0 ? "No wallet detected" : "Select wallet"}</option>
          {wallet.wallets.map((item) => (
            <option key={item.name} value={item.name}>{item.name}</option>
          ))}
        </select>
        <button
          type="button"
          className={styles.connectButton}
          disabled={!wallet.selectedWallet || wallet.connecting}
          onClick={() => void wallet.connect()}
        >
          {wallet.connecting ? "Connecting" : "Connect Devnet"}
        </button>
      </div>
    );
  }

  if (evmDomain && expectedNetwork) {
    return (
      <div className={styles.walletControl}>
        {evmWallet.account ? (
          <span
            className={evmNetworkMatches ? styles.walletAccount : `${styles.walletAccount} ${styles.walletWarn}`}
            title={evmWallet.error ?? evmWallet.account}
          >
            <i className={evmNetworkMatches ? styles.dotLive : styles.dotWarn} aria-hidden="true" />
            {shortAddress(evmWallet.account, 6, 4)}
            <small>{evmNetworkMatches ? expectedNetwork.label : "Wrong network"}</small>
          </span>
        ) : null}
        {!evmWallet.account ? (
          <button
            type="button"
            className={styles.connectButton}
            disabled={!evmWallet.available || evmWallet.connecting}
            title={evmWallet.error ?? (evmWallet.available ? "Manual connection only" : "Injected wallet unavailable")}
            onClick={() => void evmWallet.connect()}
          >
            {evmWallet.connecting ? "Connecting" : evmWallet.available ? "Connect wallet" : "No EVM wallet"}
          </button>
        ) : !evmNetworkMatches ? (
          <button
            type="button"
            className={styles.connectButton}
            disabled={evmWallet.switching}
            onClick={() => void evmWallet.switchNetwork(evmDomain)}
          >
            {evmWallet.switching ? "Switching" : `Switch to ${expectedNetwork.label}`}
          </button>
        ) : (
          <button type="button" className={styles.navButton} onClick={evmWallet.disconnect}>
            Disconnect
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={styles.walletControl}>
      <span className={styles.walletAccount} title="Hyperliquid Testnet runs through the configured service account gate. No browser wallet is used.">
        <i className={styles.dotIdle} aria-hidden="true" />
        Service account gate
        <small>No browser wallet</small>
      </span>
    </div>
  );
}

const NAV_VIEWS: readonly { tab: BottomTab; label: string }[] = [
  { tab: "positions", label: "Portfolio" },
  { tab: "receipts", label: "Receipts" },
  { tab: "readiness", label: "Readiness" },
];

function TopNavigation({
  snapshot,
  selectedDomain,
  providerConnection,
  wallet,
  evmWallet,
  onDomainChange,
  onOpenView,
}: {
  snapshot: TerminalViewModel;
  selectedDomain: DomainId;
  providerConnection: ProviderConnection;
  wallet: SolanaWalletSession;
  evmWallet: InjectedEvmWalletSession;
  onDomainChange: (domain: DomainId) => void;
  onOpenView: (tab: BottomTab) => void;
}) {
  const providerLabel = providerConnection === "connected"
    ? "Service connected"
    : providerConnection === "connecting"
      ? "Checking service"
      : "Local fallback";

  return (
    <header className={styles.topNavigation}>
      <Link className={styles.brand} href="/" prefetch={false} aria-label="Naryx home">
        <BrandMark />
        <span className={styles.wordmark}>NARYX</span>
      </Link>

      <nav className={styles.primaryNav} aria-label="Terminal">
        <span className={styles.primaryNavActive} aria-current="page">Trade</span>
        {NAV_VIEWS.map((view) => (
          <button key={view.tab} type="button" onClick={() => onOpenView(view.tab)}>
            {view.label}
          </button>
        ))}
      </nav>

      <div className={styles.navEnd}>
        <div
          className={styles.environmentChip}
          title={`${snapshot.environment.title}. ${snapshot.environment.detail} Captured ${snapshot.environment.capturedAt}.`}
        >
          <i className={providerConnection === "connected" ? styles.dotLive : providerConnection === "connecting" ? styles.dotWarn : styles.dotFixture} aria-hidden="true" />
          <span>{snapshot.environment.label.replace(/_/g, " ")}</span>
          <small>{providerLabel}</small>
        </div>

        <div className={styles.domainSelector} role="group" aria-label="Execution domain">
          {snapshot.domains.map((domain) => (
            <button
              key={domain.id}
              type="button"
              className={selectedDomain === domain.id ? styles.domainActive : undefined}
              aria-pressed={selectedDomain === domain.id}
              title={`${domain.label}: ${domain.runtime}. ${domain.state} data.`}
              onClick={() => onDomainChange(domain.id)}
            >
              <span className={styles.domainGlyph} data-domain={domain.id} aria-hidden="true" />
              {domain.label}
            </button>
          ))}
        </div>

        <WalletControl selectedDomain={selectedDomain} wallet={wallet} evmWallet={evmWallet} />
      </div>
    </header>
  );
}

const READINESS_ORDER: readonly DomainId[] = ["solana", "base", "arbitrum", "hyperliquid"];

const READINESS_META: Record<DomainId, {
  testNetwork: string;
  executionMode: string;
  settlementClass: string;
}> = {
  solana: {
    testNetwork: "Solana Devnet",
    executionMode: "Solana atomic",
    settlementClass: "ATOMIC_POSTCONDITION",
  },
  base: {
    testNetwork: "Base Sepolia",
    executionMode: "Base atomic",
    settlementClass: "ATOMIC_POSTCONDITION",
  },
  arbitrum: {
    testNetwork: "Arbitrum Sepolia",
    executionMode: "Arbitrum bonded async",
    settlementClass: "ASYNC_BONDED_SOLVER",
  },
  hyperliquid: {
    testNetwork: "Hyperliquid testnet",
    executionMode: "Hyperliquid coordinated testnet",
    settlementClass: "BATCHED_IOC_WITH_RECOVERY",
  },
};

const READINESS_FALLBACK: Record<DomainId, { label: string; runtime: string }> = {
  solana: { label: "Solana", runtime: "SVM" },
  base: { label: "Base", runtime: "EVM" },
  arbitrum: { label: "Arbitrum", runtime: "EVM" },
  hyperliquid: { label: "Hyperliquid", runtime: "HyperCore" },
};

function readinessHealthFor(
  domain: DomainId,
  health: PrivateTerminalRuntimeHealth | null,
): RuntimeBoundaryHealth | null {
  if (!health) return null;
  if (domain === "solana") return health.solanaDevnet;
  if (domain === "base") return health.baseTestnetAtomic;
  if (domain === "arbitrum") return health.arbitrumTestnetAsync;
  return health.hyperliquidTestnet;
}

function readinessBlocker(
  hasService: boolean,
  providerConnection: ProviderConnection,
  health: RuntimeBoundaryHealth | null,
  domain: DomainId,
): string {
  if (!hasService) return "Private service not configured. Local fixture data only.";
  if (!health) {
    return providerConnection === "connecting"
      ? "Checking private service health."
      : "Health unavailable. Local fixture data only.";
  }
  if (health.available) {
    if (domain === "solana") return "Ready. Review required before any Devnet signature.";
    if (domain === "hyperliquid") {
      return "Ready. The configured dedicated Testnet account gate is available for explicit review and execution.";
    }
    return "Runtime ready. This ticket executes Solana Devnet only.";
  }
  if (health.reason === "DISABLED_BY_CONFIGURATION") return "Disabled in service config. No testnet execution.";
  if (health.reason === "RUNTIME_FACTORY_NOT_INJECTED") return "Runtime not wired in service. No testnet execution.";
  if (health.reason === "RUNTIME_INITIALIZATION_FAILED") return "Runtime failed to start. No testnet execution.";
  if (health.reason === "REQUIRED_PORTS_MISSING") return "Service ports missing. No testnet execution.";
  return "Runtime unavailable. No testnet execution.";
}

function readinessStatus(
  hasService: boolean,
  providerConnection: ProviderConnection,
  health: RuntimeBoundaryHealth | null,
): "Available" | "Checking" | "Unavailable" | "Disabled" {
  if (!hasService) return "Disabled";
  if (!health) return providerConnection === "connecting" ? "Checking" : "Unavailable";
  return health.available ? "Available" : "Unavailable";
}

function ExecutionReadiness({
  snapshot,
  selectedDomain,
  providerConnection,
  runtimeHealth,
  lifecycle,
  hasService,
  onSelect,
}: {
  snapshot: TerminalViewModel;
  selectedDomain: DomainId;
  providerConnection: ProviderConnection;
  runtimeHealth: PrivateTerminalRuntimeHealth | null;
  lifecycle: PackageLifecycleResponse | null;
  hasService: boolean;
  onSelect: (domain: DomainId) => void;
}) {
  const selectedMeta = READINESS_META[selectedDomain];
  const selectedHealth = readinessHealthFor(selectedDomain, runtimeHealth);
  const latestReceipt = lifecycle?.receipts.at(-1) ?? null;
  const routeEvidence = latestReceipt?.evidenceGrade ?? "NOT AVAILABLE";
  const dependencyStatus = selectedHealth
    ? selectedHealth.available ? "AVAILABLE" : selectedHealth.reason ?? "UNAVAILABLE"
    : "UNKNOWN";
  const authorityFence = runtimeHealth
    ? runtimeHealth.controls.executionReadinessAvailable ? "ENFORCED AT HANDOFF" : "NOT CONFIGURED"
    : "UNKNOWN";
  const localVerified = runtimeHealth !== null &&
    runtimeHealth.controls.localAtomicRuntimeMode === "MANIFEST_VALIDATED" &&
    runtimeHealth.controls.localExecutionAvailable &&
    runtimeHealth.controls.lifecycleReadAvailable &&
    runtimeHealth.controls.solverQuotingAvailable;
  const serviceNote = !hasService
    ? "Local fixture only"
    : !runtimeHealth
      ? providerConnection === "connecting" ? "Checking service" : "Health unavailable"
      : providerConnection === "connected" ? "Service health current" : "Service health stale";
  const stages = [
    { label: "Local verification", state: localVerified ? "VERIFIED" : "UNKNOWN", tone: localVerified ? styles.stageDone : styles.stageUnknown },
    { label: "Public testnet", state: "DEPLOYMENT DEFERRED", tone: styles.stageDeferred },
    { label: "Pinned fork", state: "HARNESS READY, RPC DEPENDENT", tone: styles.stageConditional },
    { label: "Mainnet shadow", state: "SIGNERLESS READ ONLY", tone: styles.stageConditional },
    { label: "Mainnet writes", state: "PROHIBITED", tone: styles.stageProhibited },
  ];
  return (
    <section className={styles.readinessPanel} aria-labelledby="readiness-title">
      <div className={styles.sectionBar}>
        <h2 id="readiness-title">Evidence and promotion boundary</h2>
        <p>Observed controls and evidence only. Missing proof remains unavailable.</p>
        <span className={styles.chipNeutral} role="status">{serviceNote}</span>
      </div>

      <ol className={styles.stageRail} aria-label="Environment promotion boundary">
        {stages.map((stage, index) => (
          <li key={stage.label} className={stage.tone}>
            <span className={styles.stageIndex}>{String(index + 1).padStart(2, "0")}</span>
            <strong>{stage.label}</strong>
            <small>{stage.state}</small>
          </li>
        ))}
      </ol>

      <div className={styles.readinessBody}>
        <div className={styles.tableWrap}>
        <table className={styles.dataTable} aria-label="Domain execution readiness">
          <thead>
            <tr>
              <th scope="col">Domain</th>
              <th scope="col">Runtime</th>
              <th scope="col">Network</th>
              <th scope="col">Mode</th>
              <th scope="col">Settlement class</th>
              <th scope="col">Status</th>
              <th scope="col">Execution</th>
            </tr>
          </thead>
          <tbody>
            {READINESS_ORDER.map((domain) => {
              const model = snapshot.domains.find((item) => item.id === domain);
              const fallback = READINESS_FALLBACK[domain];
              const meta = READINESS_META[domain];
              const health = readinessHealthFor(domain, runtimeHealth);
              const status = readinessStatus(hasService, providerConnection, health);
              const blocker = readinessBlocker(hasService, providerConnection, health, domain);
              const selected = selectedDomain === domain;
              return (
                <tr key={domain} className={selected ? styles.rowSelected : undefined}>
                  <td>
                    <button
                      type="button"
                      className={styles.rowSelect}
                      aria-pressed={selected}
                      aria-label={`${model?.label ?? fallback.label} domain, ${status}. ${blocker} ${selected ? "Selected." : "Select."}`}
                      onClick={() => onSelect(domain)}
                    >
                      <span className={styles.domainGlyph} data-domain={domain} aria-hidden="true" />
                      {model?.label ?? fallback.label}
                    </button>
                  </td>
                  <td>{model?.runtime ?? fallback.runtime}</td>
                  <td>{meta.testNetwork}</td>
                  <td>{meta.executionMode}</td>
                  <td className={styles.monoCell}>{meta.settlementClass}</td>
                  <td>
                    <span className={status === "Available" ? styles.statusOk : styles.statusOff}>
                      <i className={status === "Available" ? styles.dotLive : styles.dotIdle} aria-hidden="true" />
                      {status}
                    </span>
                  </td>
                  <td className={styles.noteCell} title={blocker}>{blocker}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>

        <dl className={styles.ledger} aria-label={`${READINESS_FALLBACK[selectedDomain].label} evidence ledger`}>
          <div className={styles.ledgerTitle}>
            <dt>Selected domain</dt>
            <dd>{READINESS_FALLBACK[selectedDomain].label}</dd>
          </div>
          <div><dt>Settlement class</dt><dd title={selectedMeta.settlementClass}>{selectedMeta.settlementClass}</dd></div>
          <div><dt>Route evidence</dt><dd>{routeEvidence}</dd></div>
          <div><dt>Funded operation hash</dt><dd>NOT AVAILABLE</dd></div>
          <div><dt>Readiness decision hash</dt><dd>NOT AVAILABLE</dd></div>
          <div><dt>Authority fence</dt><dd>{authorityFence}</dd></div>
          <div><dt>Dependencies</dt><dd title={dependencyStatus}>{dependencyStatus}</dd></div>
          <div><dt>Incident state</dt><dd>UNKNOWN</dd></div>
        </dl>
      </div>
    </section>
  );
}

function PackageSequence({
  snapshot,
  mode,
  preview,
}: {
  snapshot: TerminalViewModel;
  mode: PackageMode;
  preview: TerminalPreview | null;
}) {
  const plan = snapshot.plans.find((item) => item.mode === mode) ?? snapshot.plans[0];
  const legs = preview?.mode === mode ? preview.legs : plan.legs;

  return (
    <section className={styles.routePanel} aria-labelledby="sequence-title">
      <div className={styles.sectionBar}>
        <h2 id="sequence-title">{plan.label}</h2>
        <p>{plan.description}</p>
        <span className={styles.chipDanger}>Fail closed</span>
      </div>
      <table className={styles.dataTable}>
        <thead>
          <tr>
            <th scope="col">Leg</th>
            <th scope="col">Action</th>
            <th scope="col">Instrument</th>
            <th scope="col">Venue</th>
            <th scope="col" className={styles.numericColumn}>Quantity</th>
            <th scope="col">Limit</th>
            <th scope="col" className={styles.numericColumn}>Price</th>
            <th scope="col">State</th>
            <th scope="col">Dependency</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((leg) => (
            <tr key={leg.sequence}>
              <td className={styles.monoCell}>{String(leg.sequence).padStart(2, "0")}</td>
              <td className={/buy/i.test(leg.action) ? styles.upText : styles.downText}>{leg.action}</td>
              <td>{leg.instrument}</td>
              <td className={styles.dimCell}>{leg.venue}</td>
              <td className={`${styles.monoCell} ${styles.numericColumn}`}>{tidy(leg.quantity)}</td>
              <td className={styles.dimCell}>{leg.limitLabel}</td>
              <td className={`${styles.monoCell} ${styles.numericColumn}`}>{tidy(leg.limit)}</td>
              <td><span className={styles.chipNeutral}>{leg.state}</span></td>
              <td className={styles.dimCell}>{leg.dependency}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

type ExecutionReview = {
  preparation: SolanaExecutionPreparation;
  preparedAt: number;
  ticketKey: string;
};

type SubmissionState = {
  signature: string;
  idempotencyKey: string;
  ticketKey: string;
  observation: SolanaExecutionObservation | null;
  observationUnavailable: boolean;
  consecutiveFailures: number;
  lastCheckedAt: number | null;
};

type LifecycleViewState = {
  ticketKey: string;
  attemptId: string;
  data: PackageLifecycleResponse | null;
  loading: boolean;
  unavailable: boolean;
};

type LocalFlowState = {
  ticketKey: string;
  order: LocalOrderCreateResponse | null;
  authorization: LocalAuthorization | null;
  quote: LocalSolverQuote | null;
  attempt: LocalSelectedAttempt | null;
  lifecycle: PackageLifecycleResponse | null;
  busy: string | null;
  error: string | null;
};

type HyperliquidFlowState = {
  ticketKey: string;
  context: HyperliquidTestnetContext | null;
  order: HyperliquidOrderCreateResponse | null;
  quote: HyperliquidSolverQuote | null;
  attempt: HyperliquidSelectedAttempt | null;
  execution: HyperliquidTerminalExecutionResult | null;
  busy: string | null;
  error: string | null;
};

const OBSERVATION_POLL_INTERVAL_MS = 4000;
const OBSERVATION_MAX_AUTO_FAILURES = 3;

function isObservationTerminal(observation: SolanaExecutionObservation | null): boolean {
  return observation?.lifecycle === "FINALIZED" ||
    observation?.lifecycle === "FAILED" ||
    observation?.lifecycle === "EXPIRED";
}

function observationNetworkLabel(submission: SubmissionState): string {
  if (submission.observation?.lifecycle === "FINALIZED") return "Finalized";
  if (submission.observation?.lifecycle === "FAILED") return "Failed";
  if (submission.observation?.lifecycle === "EXPIRED") return "Expired";
  if (submission.observationUnavailable) return "Observation unavailable";
  return "Submitted";
}

function observationEvidenceLabel(submission: SubmissionState): string {
  const observation = submission.observation;
  if (!observation) return "No slot observed yet";
  if (observation.lifecycle === "SUBMITTED") {
    return observation.observedSlot === null
      ? "No slot observed yet"
      : `Slot ${observation.observedSlot.toLocaleString()}`;
  }
  if (observation.lifecycle === "FINALIZED") {
    return `Slot ${observation.finalizedSlot.toLocaleString()}`;
  }
  if (observation.lifecycle === "FAILED") {
    return observation.failedSlot === null
      ? `Code ${observation.failureCode}`
      : `Slot ${observation.failedSlot.toLocaleString()} / ${observation.failureCode}`;
  }
  return `Last valid ${observation.lastValidBlockHeight.toLocaleString()} / observed ${observation.observedBlockHeight.toLocaleString()}`;
}

function compact(value: string, leading = 10, trailing = 8) {
  return value.length > leading + trailing + 3
    ? `${value.slice(0, leading)}...${value.slice(-trailing)}`
    : value;
}

function protocolScalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.$naryxType === "bigint" && typeof record.value === "string") return record.value;
    if (record.$naryxType === "bytes" && typeof record.value === "string") return record.value;
  }
  return "-";
}

function quoteAmount(quote: LocalSolverQuote, key: string): string {
  const value = quote.quote[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "-";
  return protocolScalar((value as Record<string, unknown>).atoms);
}

const SETTLEMENT_GUARANTEE: Readonly<Record<string, string>> = {
  ATOMIC_POSTCONDITION: "Every leg settles in one transaction, or none does",
  BATCHED_IOC_WITH_RECOVERY: "Legs execute IOC; a partial state is completed or unwound within the signed recovery bounds",
  ASYNC_BONDED_SOLVER: "The solver settles within its window or its bond pays the signed fault amount",
  CROSS_DOMAIN_PREPOSITIONED: "Per-domain prepare, commit, and compensation; never atomic across chains; not enabled",
  MANUAL_CONTROLLED_RECOVERY: "Automation stopped; only incident-approved actions run",
};

function assetAmountText(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "-";
  const record = value as Record<string, unknown>;
  const asset = record.asset as Record<string, unknown> | undefined;
  return `${protocolScalar(record.atoms)} atoms ${typeof asset?.assetId === "string" ? asset.assetId : ""}`.trim();
}

/**
 * The signed terms a quote and its route bind, read from the exact records the solver signed:
 * template and registry record, settlement class with its guarantee, quantity and partial-fill
 * policy, delivery path, margin, residual, and quote mode. A reservation outside production is
 * labeled FIRM_SIMULATED, never firm.
 */
function QuoteTerms({ quote }: { quote: LocalSolverQuote }) {
  const route = quote.route;
  const settlementClass = protocolScalar(route.settlementClass);
  const quoteMode = protocolScalar(quote.quote.quoteMode);
  const residualBase = quote.quote.expectedTerminalResidualBaseQuantity;
  const residualValue = quote.quote.expectedTerminalResidualQuoteValue;
  return (
    <div className={styles.reviewGrid}>
      <span>Template</span><strong>{protocolScalar(route.templateId)} v{protocolScalar(route.templateVersion)}</strong>
      <span>Registry record</span><strong title={protocolScalar(route.templateRegistryRecordHash)}>{compact(protocolScalar(route.templateRegistryRecordHash))}</strong>
      <span>Settlement class</span><strong>{settlementClass}</strong>
      <span>Guarantee</span><strong>{SETTLEMENT_GUARANTEE[settlementClass] ?? "Unknown settlement class; not executable"}</strong>
      <span>Quantity policy</span><strong>{protocolScalar(route.quantityPolicyClass)}</strong>
      <span>Partial fill</span><strong>{protocolScalar(route.partialFillPolicy)}</strong>
      <span>Delivery</span><strong>Direct to the configured solver, not a public RFQ</strong>
      <span>Quote mode</span><strong>{quoteMode === "FIRM_SIMULATED" ? "FIRM_SIMULATED (non-production reservation)" : quoteMode}</strong>
      <span>Margin change</span><strong>{assetAmountText(quote.quote.expectedMarginDelta)}</strong>
      {residualBase !== undefined ? <><span>Residual base</span><strong>{assetAmountText(residualBase)}</strong></> : null}
      {residualValue !== undefined ? <><span>Residual value</span><strong>{assetAmountText(residualValue)}</strong></> : null}
    </div>
  );
}

function LocalExecutionPanel({
  flow,
  enabled,
  canSignMessage,
  onStep,
}: {
  flow: LocalFlowState | null;
  enabled: boolean;
  canSignMessage: boolean;
  onStep: (step: "create" | "authorize" | "quote" | "select" | LocalExecutionAction) => void;
}) {
  const order = flow?.order?.order ?? null;
  const quote = flow?.quote ?? null;
  const attempt = flow?.attempt ?? null;
  const state = flow?.lifecycle?.attempt.state ?? null;
  const busy = flow?.busy !== null && flow?.busy !== undefined;
  return (
    <section className={styles.executionReview} aria-labelledby="local-execution-title">
      <div className={styles.evidenceHeading}>
        <h3 id="local-execution-title">Local conformance lifecycle</h3>
        <span>{state ?? (attempt ? "SELECTED" : quote ? "QUOTE REVIEW" : order ? "UNSIGNED" : "READY")}</span>
      </div>
      <p className={styles.reviewNotice}>
        Deterministic local controller evidence only. These actions are not onchain transactions and do not prove atomic execution.
      </p>
      {order ? (
        <div className={styles.reviewGrid}>
          <span>Order hash</span><strong title={order.orderHashHex}>{compact(order.orderHashHex, 12, 10)}</strong>
          <span>Canonical bytes</span><strong>{order.orderBytes.length} B</strong>
          <span>Domain</span><strong>{order.domainId}</strong>
          <span>Manifest</span><strong title={order.domainManifestHashHex}>v{order.domainManifestVersion} / {compact(order.domainManifestHashHex)}</strong>
          <span>Nonce</span><strong title={order.nonceDecimal}>{compact(order.nonceDecimal)}</strong>
          <span>Authorization</span><strong>{flow?.authorization ? "Wallet signed exact bytes" : "Required"}</strong>
        </div>
      ) : null}
      {quote ? (
        <div className={styles.reviewGrid}>
          <span>Quote status</span><strong>{quote.status}</strong>
          <span>Solver</span><strong>{protocolScalar(quote.quote.solverId)}</strong>
          <span>Quote mode</span><strong>{protocolScalar(quote.quote.quoteMode)}</strong>
          <span>Valid until</span><strong>{protocolScalar(quote.quote.validUntilValue)} {protocolScalar(quote.quote.validUntilUnit)}</strong>
          <span>Outcome</span><strong>{protocolScalar((quote.quote.quotedOutcome as Record<string, unknown> | undefined)?.kind)}</strong>
          <span>Solver fee atoms</span><strong>{quoteAmount(quote, "solverFee")}</strong>
          <span>Protocol fee atoms</span><strong>{quoteAmount(quote, "protocolFee")}</strong>
          <span>Priority fee atoms</span><strong>{quoteAmount(quote, "expectedPriorityFee")}</strong>
          <span>Quote hash</span><strong title={quote.quoteHash}>{compact(quote.quoteHash, 12, 10)}</strong>
          <span>Route hash</span><strong title={quote.routeHash}>{compact(quote.routeHash, 12, 10)}</strong>
          <span>Solver digest</span><strong title={quote.solverSignatureDigest}>{compact(quote.solverSignatureDigest, 12, 10)}</strong>
          <span>Quote bytes</span><strong>{quote.solverQuoteBytes.length / 2} B</strong>
          <span>Route bytes</span><strong>{quote.routeBytes.length / 2} B</strong>
        </div>
      ) : null}
      {quote ? <QuoteTerms quote={quote} /> : null}
      {attempt ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Selected attempt</span>
          <strong title={attempt.attemptId}>{compact(attempt.attemptId, 18, 12)}</strong>
          <small>{state ? `Authoritative lifecycle head: ${state}.` : "Ready for local preparation."}</small>
        </div>
      ) : null}
      <div className={styles.localActions}>
        <button type="button" className={styles.secondaryAction} disabled={!enabled || busy || Boolean(order)} onClick={() => onStep("create")}>Create canonical order</button>
        <button type="button" className={styles.secondaryAction} disabled={!order || !canSignMessage || busy || Boolean(flow?.authorization)} onClick={() => onStep("authorize")}>Sign and authorize</button>
        <button type="button" className={styles.secondaryAction} disabled={!flow?.authorization || busy || Boolean(quote)} onClick={() => onStep("quote")}>Request signed quote</button>
        <button type="button" className={styles.primaryAction} disabled={!quote || busy || Boolean(attempt)} onClick={() => onStep("select")}>Select reviewed quote</button>
        <button type="button" className={styles.secondaryAction} disabled={!attempt || busy || state !== null} onClick={() => onStep("prepare")}>Prepare local attempt</button>
        <button type="button" className={styles.primaryAction} disabled={!attempt || busy || (state !== "ENTRY_PREPARED" && state !== "PACKAGE_CREATED")} onClick={() => onStep("open")}>Open locally</button>
        <button type="button" className={styles.secondaryAction} disabled={!attempt || busy || (state !== "OPEN" && state !== "ENTRY_SUBMITTED")} onClick={() => onStep("observation-ambiguity")}>Drill observation ambiguity</button>
        <button type="button" className={styles.secondaryAction} disabled={!attempt || busy || state !== "RECOVERY_PENDING"} onClick={() => onStep("controller-recovery")}>Controller recovery</button>
        <button type="button" className={styles.primaryAction} disabled={!attempt || busy || state !== "OPEN"} onClick={() => onStep("close")}>Close / exit locally</button>
      </div>
      <p className={styles.fieldContext} role="status">
        {flow?.error ?? (flow?.busy ? `${flow.busy}.` : canSignMessage
          ? "Each transition is explicit and refreshes the durable authoritative receipt chain."
          : "The selected wallet must advertise SolanaSignMessage to authorize exact order bytes.")}
      </p>
    </section>
  );
}

function HyperliquidTestnetPanel({
  flow,
  enabled,
  size,
  baseSymbol,
  slippage,
  onStep,
}: {
  flow: HyperliquidFlowState | null;
  enabled: boolean;
  size: string;
  /** The ticket's base asset, the unit the size was entered in. */
  baseSymbol: string;
  slippage: SlippageBps;
  onStep: (step: "create" | "quote" | "select" | "execute") => void;
}) {
  const context = flow?.context ?? null;
  const order = flow?.order?.order ?? null;
  const quote = flow?.quote ?? null;
  const attempt = flow?.attempt ?? null;
  const execution = flow?.execution ?? null;
  const busy = flow?.busy !== null && flow?.busy !== undefined;
  const commitments = execution
    ? [
      execution.actionCommitment,
      execution.requestCommitment,
      execution.errorCommitment,
      ...(execution.rawEvidenceCommitments ?? []),
    ].filter((value): value is string => typeof value === "string")
    : [];
  return (
    <section className={styles.executionReview} aria-labelledby="hyperliquid-execution-title">
      <div className={styles.evidenceHeading}>
        <h3 id="hyperliquid-execution-title">Hyperliquid Testnet action flow</h3>
        <span>{execution?.status ?? (attempt ? "SELECTED" : quote ? "QUOTE REVIEW" : order ? "ORDER CREATED" : context ? "GATE READY" : "DISCOVERING")}</span>
      </div>
      <p className={styles.reviewNotice}>
        The configured dedicated Testnet account gate authorizes this flow. No user-wallet authorization or signer is present in the browser.
      </p>
      {context ? (
        <div className={styles.reviewGrid}>
          <span>Account gate</span><strong title={context.tradingAccount}>{compact(context.tradingAccount, 10, 8)}</strong>
          <span>Context</span><strong title={context.contextId}>{context.contextId}</strong>
          <span>Domain</span><strong>{context.domain.domainId}</strong>
          <span>Manifest</span><strong title={context.domain.domainManifestHash}>v{context.domain.domainManifestVersion} / {compact(context.domain.domainManifestHash)}</strong>
          <span>Environment</span><strong>{context.environment}</strong>
          <span>Authorization</span><strong>Dedicated Testnet account gate</strong>
          <span>Requested size</span><strong>{size} {baseSymbol}</strong>
          <span>Slippage limit</span><strong>{slippage} bps</strong>
        </div>
      ) : null}
      {order ? (
        <div className={styles.reviewGrid}>
          <span>Order hash</span><strong title={order.orderHashHex}>{compact(order.orderHashHex, 12, 10)}</strong>
          <span>Canonical bytes</span><strong>{order.orderBytes.length} B</strong>
          <span>Owner</span><strong title={order.owner}>{compact(order.owner, 10, 8)}</strong>
          <span>Settlement account</span><strong title={order.settlementAccount}>{compact(order.settlementAccount, 10, 8)}</strong>
          <span>Order gate</span><strong>Configured account only</strong>
          <span>Solver quote</span><strong>{flow?.order?.solverQuoting}</strong>
        </div>
      ) : null}
      {quote ? (
        <div className={styles.reviewGrid}>
          <span>Quote status</span><strong>{quote.status}</strong>
          <span>Solver</span><strong>{protocolScalar(quote.quote.solverId)}</strong>
          <span>Valid until</span><strong>{protocolScalar(quote.quote.validUntilValue)} ms</strong>
          <span>Quote hash</span><strong title={quote.quoteHash}>{compact(quote.quoteHash, 12, 10)}</strong>
          <span>Route hash</span><strong title={quote.routeHash}>{compact(quote.routeHash, 12, 10)}</strong>
          <span>Solver fee atoms</span><strong>{quoteAmount(quote, "solverFee")}</strong>
          <span>Protocol fee atoms</span><strong>{quoteAmount(quote, "protocolFee")}</strong>
          <span>Recovery cap entries</span><strong>{Array.isArray(quote.quote.maxRecoveryCostAtomsByAsset) ? quote.quote.maxRecoveryCostAtomsByAsset.length : 0}</strong>
        </div>
      ) : null}
      {quote ? <QuoteTerms quote={quote} /> : null}
      {attempt ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Selected Testnet attempt</span>
          <strong title={attempt.attemptId}>{compact(attempt.attemptId, 20, 12)}</strong>
          <small>Quote selection records the dedicated account gate. It is not a browser wallet signature.</small>
        </div>
      ) : null}
      {execution ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Checkpoint and reconciliation</span>
          <strong>{execution.status}{execution.packageStatus ? ` / ${execution.packageStatus}` : ""}</strong>
          <small>
            Submission: {execution.submissionStatus ?? "not submitted or unavailable"}.
            {execution.reasons?.length ? ` Reasons: ${execution.reasons.join(", ")}.` : ""}
          </small>
          {commitments.map((commitment) => (
            <small key={commitment} title={commitment}>Evidence: {compact(commitment, 14, 12)}</small>
          ))}
        </div>
      ) : null}
      <div className={styles.localActions}>
        <button type="button" className={styles.secondaryAction} disabled={!enabled || !context || busy || Boolean(order)} onClick={() => onStep("create")}>Create canonical order</button>
        <button type="button" className={styles.secondaryAction} disabled={!order || busy || Boolean(quote)} onClick={() => onStep("quote")}>Request signed quote</button>
        <button type="button" className={styles.primaryAction} disabled={!quote || busy || Boolean(attempt)} onClick={() => onStep("select")}>Select reviewed quote</button>
        <button type="button" className={styles.primaryAction} disabled={!attempt || busy || Boolean(execution)} onClick={() => onStep("execute")}>Execute on Testnet</button>
      </div>
      <p className={styles.fieldContext} role="status">
        {flow?.error ?? (flow?.busy ? `${flow.busy}.` : !enabled
          ? "Hyperliquid Testnet runtime readiness is required. Execution remains disabled in API configuration by default."
          : context
            ? "Review the configured account and package limits before each explicit action."
            : "Discovering the active Hyperliquid Testnet order context.")}
      </p>
    </section>
  );
}

function preparationFingerprint(preparation: SolanaExecutionPreparation) {
  return JSON.stringify({
    status: preparation.status,
    environment: preparation.environment,
    idempotencyKey: preparation.idempotencyKey,
    domain: preparation.domain,
    domainManifestVersion: preparation.domainManifestVersion,
    domainManifestHash: preparation.domainManifestHash,
    planKind: preparation.planKind,
    messageBase64: preparation.messageBase64,
    transactionBase64: preparation.transactionBase64,
    requiredSignerPubkeys: preparation.requiredSignerPubkeys,
    recentBlockhash: preparation.recentBlockhash,
    blockhashContextSlot: preparation.blockhashContextSlot,
    lastValidBlockHeight: preparation.lastValidBlockHeight,
    lifecycleAttemptId: preparation.lifecycleAttemptId,
    genesisHash: preparation.genesisHash,
    lookupTables: preparation.lookupTables,
    evidence: preparation.evidence,
    requestCommitment: preparation.requestCommitment,
  });
}

function ExecutionReviewPanel({
  review,
  preview,
  submission,
  confirming,
  onRetryObservation,
}: {
  review: ExecutionReview;
  preview: TerminalPreview | null;
  submission: SubmissionState | null;
  confirming: boolean;
  onRetryObservation: () => void;
}) {
  const { preparation } = review;
  const observation = submission?.observation ?? null;
  const unavailable = submission?.observationUnavailable ?? false;
  const badge = !submission
    ? confirming ? "Confirm in wallet" : "Signature required"
    : observation?.lifecycle === "FINALIZED"
      ? "Finalized on Devnet"
      : observation?.lifecycle === "FAILED"
        ? "Failed on Devnet"
        : observation?.lifecycle === "EXPIRED"
          ? "Expired"
          : unavailable
            ? "Observation unavailable"
            : "Submitted";
  return (
    <section className={styles.executionReview} aria-labelledby="execution-review-title">
      <div className={styles.evidenceHeading}>
        <h3 id="execution-review-title">Devnet pre-sign review</h3>
        <span>{badge}</span>
      </div>
      <div className={styles.reviewEconomics}>
        <div>
          <span>Package</span>
          <strong>{preview === null || preview === undefined ? "-" : `${preview.size.value} ${preview.size.symbol}`}</strong>
        </div>
        <div>
          <span>Bound</span>
          <strong>{preview ? usd(preview.bound.value) : "-"}</strong>
        </div>
        <div>
          <span>Fees</span>
          <strong>{preview ? usd(preview.totalFee.value) : "-"}</strong>
        </div>
      </div>
      {(preview?.legs ?? []).map((leg) => (
        <div className={styles.reviewLeg} key={leg.sequence}>
          <span>Leg {leg.sequence} - {leg.action}</span>
          <strong>{leg.quantity} at {leg.venue}</strong>
        </div>
      ))}
      <div className={styles.reviewGrid}>
        <span>Environment</span><strong>Solana Devnet</strong>
        <span>Domain</span><strong>{preparation.domain}</strong>
        <span>Genesis</span><strong title={preparation.genesisHash}>{compact(preparation.genesisHash)}</strong>
        <span>Idempotency</span><strong title={preparation.idempotencyKey}>{compact(preparation.idempotencyKey)}</strong>
        <span>Domain manifest</span>
        <strong title={preparation.domainManifestHash}>
          v{preparation.domainManifestVersion} / {compact(preparation.domainManifestHash)}
        </strong>
        <span>Plan</span><strong>{preparation.planKind}</strong>
        <span>Exact signer</span>
        <strong title={preparation.requiredSignerPubkeys[0]}>
          {compact(preparation.requiredSignerPubkeys[0])}
        </strong>
        <span>Wire evidence</span>
        <strong>
          {preparation.evidence.serializedTransactionBytes} B / {preparation.evidence.resolvedAddressCount} accts
        </strong>
        <span>Compute cap</span>
        <strong>{preparation.evidence.routeComputeUnitLimit.toLocaleString()} CU</strong>
        <span>Last valid block</span>
        <strong>{preparation.lastValidBlockHeight.toLocaleString()}</strong>
        <span>Lifecycle attempt</span>
        <strong title={preparation.lifecycleAttemptId}>
          {compact(preparation.lifecycleAttemptId, 18, 12)}
        </strong>
        <span>Recent blockhash</span>
        <strong title={preparation.recentBlockhash}>{compact(preparation.recentBlockhash)}</strong>
        <span>Blockhash slot</span>
        <strong>{preparation.blockhashContextSlot.toLocaleString()}</strong>
        <span>Lookup tables</span><strong>{preparation.lookupTables.length}</strong>
        <span>Commitment</span>
        <strong title={preparation.requestCommitment}>
          {compact(preparation.requestCommitment, 12, 10)}
        </strong>
      </div>
      <p className={styles.reviewNotice}>
        This review expires after 45 seconds. Submission is not finality and does not mean the package completed.
      </p>
      {!submission && confirming ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Wallet confirmation</span>
          <strong>Confirm in wallet</strong>
          <small>Approve the exact reviewed Devnet transaction in your wallet. Closing the wallet prompt cancels submission.</small>
        </div>
      ) : null}
      {submission && !observation && !unavailable ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Transaction submitted</span>
          <strong title={submission.signature}>{compact(submission.signature, 14, 12)}</strong>
          <small>Waiting for network observation on Solana Devnet. No slot observed yet. Submission is not finality and does not mean the package completed.</small>
        </div>
      ) : null}
      {submission && observation?.lifecycle === "SUBMITTED" && !unavailable ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Transaction submitted</span>
          <strong title={submission.signature}>{compact(submission.signature, 14, 12)}</strong>
          <small>
            {observation.observedSlot === null
              ? "Waiting for network observation on Solana Devnet. No slot observed yet. Submission is not confirmation and does not mean the package completed."
              : `Observed at slot ${observation.observedSlot.toLocaleString()} on Solana Devnet. Waiting for finality. Submission is not confirmation and does not mean the package completed.`}
          </small>
        </div>
      ) : null}
      {submission && observation?.lifecycle === "FINALIZED" ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Finalized on Solana Devnet</span>
          <strong title={submission.signature}>{compact(submission.signature, 14, 12)}</strong>
          <small>
            {`Finalized at slot ${observation.finalizedSlot.toLocaleString()}. Network finality only. This does not mean the package is open, closed, or complete.`}
          </small>
        </div>
      ) : null}
      {submission && observation?.lifecycle === "FAILED" ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Failed on Solana Devnet</span>
          <strong title={submission.signature}>{compact(submission.signature, 14, 12)}</strong>
          <small>
            {observation.failedSlot === null
              ? `Failure code ${observation.failureCode}. No slot reported. The transaction did not finalize.`
              : `Failure code ${observation.failureCode} at slot ${observation.failedSlot.toLocaleString()}. The transaction did not finalize.`}
          </small>
        </div>
      ) : null}
      {submission && observation?.lifecycle === "EXPIRED" ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Expired before finality</span>
          <strong title={submission.signature}>{compact(submission.signature, 14, 12)}</strong>
          <small>
            {`Last valid block height ${observation.lastValidBlockHeight.toLocaleString()}, observed block height ${observation.observedBlockHeight.toLocaleString()}. The transaction did not finalize.`}
          </small>
        </div>
      ) : null}
      {submission && unavailable && !isObservationTerminal(observation) ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Observation unavailable</span>
          <strong title={submission.signature}>{compact(submission.signature, 14, 12)}</strong>
          <small>Observation temporarily unavailable. The transaction was submitted and network state is unknown. Finality is not asserted.</small>
          <button
            type="button"
            className={styles.observationRetry}
            onClick={onRetryObservation}
          >
            Retry observation
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Ticket({
  snapshot,
  selectedDomain,
  mode,
  preview,
  size,
  slippage,
  quoteMode,
  accountLabel,
  localFlow,
  localFlowEnabled,
  localCanSignMessage,
  hyperliquidFlow,
  hyperliquidFlowEnabled,
  executionReview,
  submission,
  confirming,
  actionLabel,
  actionReason,
  actionDisabled,
  actionBusy,
  prepareDisabled,
  onModeChange,
  onSizeChange,
  onSlippageChange,
  onQuoteModeChange,
  onLocalStep,
  onHyperliquidStep,
  onExecutionAction,
  onPrepareExecution,
  onRetryObservation,
}: {
  snapshot: TerminalViewModel;
  selectedDomain: DomainId;
  mode: PackageMode;
  preview: TerminalPreview | null;
  size: string;
  slippage: SlippageBps;
  quoteMode: QuoteMode;
  accountLabel: string;
  localFlow: LocalFlowState | null;
  localFlowEnabled: boolean;
  localCanSignMessage: boolean;
  hyperliquidFlow: HyperliquidFlowState | null;
  hyperliquidFlowEnabled: boolean;
  executionReview: ExecutionReview | null;
  submission: SubmissionState | null;
  confirming: boolean;
  actionLabel: string;
  actionReason: string;
  actionDisabled: boolean;
  actionBusy: boolean;
  prepareDisabled: boolean;
  onModeChange: (mode: PackageMode) => void;
  onSizeChange: (size: string) => void;
  onSlippageChange: (slippage: SlippageBps) => void;
  onQuoteModeChange: (quoteMode: QuoteMode) => void;
  onLocalStep: (step: "create" | "authorize" | "quote" | "select" | LocalExecutionAction) => void;
  onHyperliquidStep: (step: "create" | "quote" | "select" | "execute") => void;
  onExecutionAction: () => void;
  onPrepareExecution: () => void;
  onRetryObservation: () => void;
}) {
  const plan = snapshot.plans.find((item) => item.mode === mode) ?? snapshot.plans[0];
  const legs = preview?.mode === mode ? preview.legs : plan.legs;
  const flowState = selectedDomain === "hyperliquid"
    ? hyperliquidFlow?.execution?.status ?? (hyperliquidFlow?.attempt ? "SELECTED" : hyperliquidFlow?.quote ? "QUOTE REVIEW" : hyperliquidFlow?.order ? "ORDER CREATED" : hyperliquidFlow?.context ? "GATE READY" : "DISCOVERING")
    : localFlow?.lifecycle?.attempt.state ?? (localFlow?.attempt ? "SELECTED" : localFlow?.quote ? "QUOTE REVIEW" : localFlow?.order ? "UNSIGNED" : "READY");

  return (
    <aside className={styles.ticket} aria-labelledby="ticket-title">
      <h2 id="ticket-title" className={styles.visuallyHidden}>Package ticket</h2>

      <div className={styles.sideSwitch} role="group" aria-label="Package mode" data-mode={mode}>
        <span className={styles.sidePill} aria-hidden="true" />
        {(["entry", "exit"] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={mode === item ? (item === "entry" ? styles.sideEntryActive : styles.sideExitActive) : undefined}
            aria-pressed={mode === item}
            onClick={() => onModeChange(item)}
          >
            {item === "entry" ? "Enter package" : "Exit package"}
          </button>
        ))}
      </div>

      <div className={styles.orderTypes} role="group" aria-label="Quote mode">
        {snapshot.ticket.quoteModes.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={quoteMode === item.id}
            className={quoteMode === item.id ? styles.orderTypeActive : undefined}
            onClick={() => onQuoteModeChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <dl className={styles.ticketFacts}>
        <div><dt>Account</dt><dd>{accountLabel}</dd></div>
        <div><dt>Package</dt><dd>{snapshot.market.packageId}</dd></div>
        <div><dt>Evidence</dt><dd className={styles.fixtureText}>{preview?.evidenceGrade ?? snapshot.environment.evidenceGrade}</dd></div>
        <div title="Marketable limit, exact all legs: the only package order policy the initial activation accepts. Every other type, time in force, or partial-fill policy is rejected before authorization.">
          <dt>Order</dt>
          <dd>Marketable limit, {READINESS_META[snapshot.selectedDomain].settlementClass === "ATOMIC_POSTCONDITION" ? "FOK" : "IOC"}, exact</dd>
        </div>
        <div title={SETTLEMENT_GUARANTEE[READINESS_META[snapshot.selectedDomain].settlementClass]}>
          <dt>Settlement</dt>
          <dd>{READINESS_META[snapshot.selectedDomain].settlementClass}</dd>
        </div>
      </dl>

      <div className={styles.sizeBox}>
        <label htmlFor="package-size">Package size</label>
        <input
          id="package-size"
          inputMode="decimal"
          autoComplete="off"
          value={size}
          placeholder="0"
          onChange={(event) => onSizeChange(sanitizeSize(event.target.value))}
          aria-describedby="size-context"
        />
        <div className={styles.sizeMeta}>
          <span className={styles.symbolChip}>{snapshot.ticket.sizeSymbol}</span>
          <span id="size-context">
            <span key={preview?.bound.value ?? "none"} className={styles.flash}>
              {preview ? `${preview.bound.label} ${usd(preview.bound.value)}` : "Bound unavailable"}
            </span>
          </span>
        </div>
      </div>

      <div className={styles.presets} role="group" aria-label="Size presets">
        {SIZE_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={size === preset}
            className={size === preset ? styles.presetActive : undefined}
            onClick={() => onSizeChange(preset)}
          >
            {preset}
          </button>
        ))}
      </div>

      <div className={styles.ticketRow}>
        <span>Slippage tolerance</span>
        <div className={styles.miniSegment} role="group" aria-label="Slippage">
          {SLIPPAGE_OPTIONS.map((option) => (
            <button
              type="button"
              key={option}
              className={slippage === option ? styles.miniSegmentActive : undefined}
              aria-pressed={slippage === option}
              onClick={() => onSlippageChange(option)}
            >
              {option} bps
            </button>
          ))}
        </div>
      </div>

      <ol className={styles.legList} aria-label="Package legs">
        {legs.map((leg) => (
          <li key={leg.sequence}>
            <span className={styles.legIndex}>{leg.sequence}</span>
            <div>
              <strong className={/buy/i.test(leg.action) ? styles.upText : styles.downText}>{leg.action}</strong>
              <small>{leg.instrument} / {leg.venue}</small>
            </div>
            <div className={styles.legNumbers}>
              <strong>{tidy(leg.quantity)}</strong>
              <small title={`${leg.limitLabel} ${leg.limit}`}>{/max/i.test(leg.limitLabel) ? "max" : "min"} {tidy(leg.limit)}</small>
            </div>
          </li>
        ))}
      </ol>

      {selectedDomain !== "hyperliquid" ? (
        <div className={styles.actionArea}>
          <button
            className={styles.primaryCta}
            type="button"
            disabled={actionDisabled || actionBusy}
            aria-describedby="execution-note"
            onClick={onExecutionAction}
          >
            {confirming ? "Confirm in wallet" : actionBusy ? "Preparing Devnet review" : actionLabel}
          </button>
          <button
            className={styles.secondaryCta}
            type="button"
            disabled={prepareDisabled || actionBusy}
            onClick={onPrepareExecution}
          >
            {executionReview ? "Refresh Devnet review" : "Prepare Devnet review"}
          </button>
          <p id="execution-note" role="status">
            {actionReason}
          </p>
        </div>
      ) : null}

      <section className={styles.summaryCard} aria-labelledby="fee-summary-title">
        <h3 id="fee-summary-title" className={styles.visuallyHidden}>Order summary</h3>
        <div className={styles.summaryRow}>
          <span>{mode === "entry" ? "Maximum quote" : "Minimum output"}</span>
          <strong key={preview?.bound.value ?? "none"} className={styles.flash}>{preview ? usd(preview.bound.value) : "Unavailable"}</strong>
        </div>
        {(preview?.fees ?? []).map((row) => (
          <div className={styles.summaryRow} key={row.label}>
            <span>{row.label}</span>
            <strong key={row.value} className={styles.flash}>{usd(row.value)}</strong>
          </div>
        ))}
        <div className={`${styles.summaryRow} ${styles.summaryTotal}`}>
          <span>Estimated fees</span>
          <strong key={preview?.totalFee.value ?? "none"} className={styles.flash}>{preview ? usd(preview.totalFee.value) : "Unavailable"}</strong>
        </div>
        <div className={styles.summaryDivider} />
        {snapshot.ticket.evidence.map((row) => (
          <div className={styles.summaryRow} key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
        <p className={styles.summaryNote}>USDC conformance estimate. No balance has been loaded.</p>
      </section>

      <details
        key={selectedDomain}
        className={styles.flowDetails}
        open={selectedDomain === "hyperliquid"}
      >
        <summary>
          <span>{selectedDomain === "hyperliquid" ? "Hyperliquid Testnet flow" : "Local conformance lifecycle"}</span>
          <span className={styles.chipNeutral}>{flowState}</span>
        </summary>
        {selectedDomain === "hyperliquid" ? (
          <HyperliquidTestnetPanel
            flow={hyperliquidFlow}
            enabled={hyperliquidFlowEnabled}
            size={size}
            baseSymbol={snapshot.market.base}
            slippage={slippage}
            onStep={onHyperliquidStep}
          />
        ) : (
          <LocalExecutionPanel
            flow={localFlow}
            enabled={localFlowEnabled}
            canSignMessage={localCanSignMessage}
            onStep={onLocalStep}
          />
        )}
      </details>

      {executionReview ? (
        <ExecutionReviewPanel
          review={executionReview}
          preview={preview}
          submission={submission}
          confirming={confirming}
          onRetryObservation={onRetryObservation}
        />
      ) : null}
    </aside>
  );
}

// Durable lifecycle receipts are state transitions, not network receipts, so they carry their own
// columns instead of the snapshot's leg, block, and finality headers.
const LIFECYCLE_RECEIPT_COLUMNS: readonly { label: string; numeric?: boolean }[] = [
  { label: "Receipt" },
  { label: "Domain" },
  { label: "Transition" },
  { label: "Revision", numeric: true },
  { label: "Evidence grade" },
  { label: "Enforcement" },
];

function BottomWorkspace({
  snapshot,
  providerConnection,
  submission,
  attemptMode,
  lifecycle,
  lifecycleLoading,
  lifecycleUnavailable,
  onRetryObservation,
  onRetryLifecycle,
  activeTab,
  onTabChange,
  attentionKey,
  routePlan,
  readiness,
  solvers,
}: {
  snapshot: TerminalViewModel;
  providerConnection: ProviderConnection;
  submission: SubmissionState | null;
  attemptMode: PackageMode;
  lifecycle: PackageLifecycleResponse | null;
  lifecycleLoading: boolean;
  lifecycleUnavailable: boolean;
  onRetryObservation: () => void;
  onRetryLifecycle: () => void;
  activeTab: BottomTab;
  onTabChange: (tab: BottomTab) => void;
  attentionKey: number;
  routePlan: ReactNode;
  readiness: ReactNode;
  solvers: ReactNode;
}) {
  const extraPanel = activeTab === "route" ? routePlan : activeTab === "readiness" ? readiness : activeTab === "solvers" ? solvers : null;
  const activeWorkspace =
    snapshot.workspaces.find((workspace) => workspace.tab === activeTab) ??
    snapshot.workspaces[0];
  const providerLabel = providerConnection === "connected"
    ? "Provider connected"
    : providerConnection === "connecting"
      ? "Provider connecting"
      : "Provider disconnected";
  const showReceipts = activeWorkspace.tab === "receipts";
  const showNetworkEvidence = showReceipts && submission !== null;
  const needsRetry = showNetworkEvidence && submission !== null &&
    submission.observationUnavailable && !isObservationTerminal(submission.observation);
  const tabs: readonly { tab: BottomTab; label: string; count?: number }[] = [
    ...snapshot.workspaces.map((workspace) => ({
      tab: workspace.tab,
      label: workspace.label,
      count: workspace.tab === "receipts" && lifecycle ? lifecycle.receipts.length : workspace.count,
    })),
    { tab: "route", label: "Route plan" },
    { tab: "solvers", label: "Solvers" },
    { tab: "readiness", label: "Readiness" },
  ];

  return (
    <section id="terminal-workspace" className={styles.bottomWorkspace} aria-label="Trading workspace">
      {attentionKey > 0 ? <span key={attentionKey} className={styles.attentionRing} aria-hidden="true" /> : null}
      <div className={styles.workspaceTabs} role="tablist" aria-label="Account data" onKeyDown={handleTablistKeys}>
        {tabs.map((entry) => (
          <button
            id={`tab-${entry.tab}`}
            key={entry.tab}
            type="button"
            role="tab"
            aria-selected={activeTab === entry.tab}
            aria-controls={`panel-${entry.tab}`}
            className={activeTab === entry.tab ? styles.workspaceTabActive : undefined}
            onClick={() => onTabChange(entry.tab)}
          >
            {entry.label}
            {entry.count !== undefined ? <span>({entry.count})</span> : null}
          </button>
        ))}
        <div className={styles.workspaceStatus}>
          <i className={providerConnection === "connected" ? styles.dotLive : styles.dotIdle} aria-hidden="true" />
          {providerLabel}
        </div>
      </div>

      {extraPanel !== null ? (
        <div key={activeTab} id={`panel-${activeTab}`} role="tabpanel" aria-labelledby={`tab-${activeTab}`} className={`${styles.tableScroller} ${styles.viewFade}`}>
          {extraPanel}
        </div>
      ) : (
      <div
        key={activeWorkspace.tab}
        id={`panel-${activeWorkspace.tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${activeWorkspace.tab}`}
        className={`${styles.tableScroller} ${styles.viewFade}`}
      >
        {showReceipts && lifecycle ? (
          <div className={styles.lifecycleSummary} role="status">
            <div>
              <span>Lifecycle head</span>
              <strong>{lifecycle.attempt.state}</strong>
            </div>
            <div>
              <span>Revision</span>
              <strong>{lifecycle.attempt.revision}</strong>
            </div>
            <div>
              <span>Attempt</span>
              <strong title={lifecycle.attempt.attemptId}>
                {compact(lifecycle.attempt.attemptId, 16, 10)}
              </strong>
            </div>
            <div>
              <span>Latest receipt</span>
              <strong title={lifecycle.attempt.receiptHashHex}>
                {compact(lifecycle.attempt.receiptHashHex, 12, 10)}
              </strong>
            </div>
          </div>
        ) : null}
        {showReceipts && lifecycleUnavailable ? (
          <p className={styles.inlineNotice} role="status">
            Durable lifecycle is temporarily unavailable.
            <button type="button" className={styles.inlineRetry} onClick={onRetryLifecycle}>
              Retry lifecycle
            </button>
          </p>
        ) : null}
        {showReceipts && lifecycleLoading && !lifecycle ? (
          <p className={styles.inlineNotice} role="status">Loading durable lifecycle receipts.</p>
        ) : null}
        {showNetworkEvidence && submission ? (
          <p className={styles.inlineNotice} role="status">
            <span>
              Network evidence only: {observationNetworkLabel(submission)} on Solana Devnet for the {attemptMode} transaction. {observationEvidenceLabel(submission)}.
            </span>
            {needsRetry ? (
              <button type="button" className={styles.inlineRetry} onClick={onRetryObservation}>
                Retry observation
              </button>
            ) : null}
          </p>
        ) : null}
        <table className={styles.dataTable}>
          <thead>
            <tr>
              {(showReceipts && lifecycle ? LIFECYCLE_RECEIPT_COLUMNS : activeWorkspace.columns).map((column) => (
                <th
                  key={column.label}
                  className={column.numeric ? styles.numericColumn : undefined}
                  scope="col"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {showReceipts && lifecycle ? (
              lifecycle.receipts.map((receipt) => (
                <tr key={receipt.receiptHashHex}>
                  <td className={styles.monoCell} title={receipt.receiptHashHex}>
                    {compact(receipt.receiptHashHex, 10, 8)}
                  </td>
                  <td title={receipt.domain.domainManifestHashHex}>
                    {receipt.domain.domainId}
                  </td>
                  <td className={styles.monoCell}>
                    {receipt.priorState ?? "START"} &gt; {receipt.nextState}
                  </td>
                  <td className={`${styles.monoCell} ${styles.numericColumn}`}>
                    {receipt.revision}
                  </td>
                  <td className={styles.monoCell}>{receipt.evidenceGrade}</td>
                  <td>
                    {receipt.onchainEnforced ? "Onchain" : "Controller"}
                  </td>
                </tr>
              ))
            ) : (
              <tr className={styles.emptyRow}>
                <td colSpan={activeWorkspace.columns.length}>
                  <div className={styles.emptyState}>
                    <strong>{activeWorkspace.emptyTitle}</strong>
                    <p>{activeWorkspace.emptyDetail}</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}
    </section>
  );
}

export function TradingTerminal({
  initialSnapshot,
  initialPreview,
  privateApiBaseUrl,
  publicApiBaseUrl = null,
  packageMarketId = null,
}: {
  initialSnapshot: TerminalViewModel;
  initialPreview: TerminalPreview;
  privateApiBaseUrl: string | null;
  /** The public v1 market API; without it, or until it answers, market data stays labeled FIXTURE. */
  publicApiBaseUrl?: string | null;
  packageMarketId?: string | null;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [preview, setPreview] = useState<TerminalPreview | null>(initialPreview);
  const [selectedDomain, setSelectedDomain] = useState(initialSnapshot.selectedDomain);
  const [mode, setMode] = useState<PackageMode>("entry");
  const [size, setSize] = useState(initialSnapshot.ticket.defaultSize);
  const [slippage, setSlippage] = useState<SlippageBps>(
    initialSnapshot.ticket.defaultSlippageBps,
  );
  const [quoteMode, setQuoteMode] = useState<QuoteMode>("coordinated_limits");
  const [workspaceTab, setWorkspaceTab] = usePersistedSetting<BottomTab>(
    "workspace.tab",
    "positions",
    ["positions", "orders", "history", "receipts", "route", "solvers", "readiness"],
  );
  const [workspaceAttention, setWorkspaceAttention] = useState(0);
  const fixtureFeed = useMemo(() => fixtureMarketFeed(snapshot), [snapshot]);
  const { feed, status: feedStatus } = usePublicMarketFeed(publicApiBaseUrl, packageMarketId, fixtureFeed);
  const wallet = useSolanaDevnetWallet();
  const evmWallet = useInjectedEvmWallet();
  const [localFlow, setLocalFlow] = useState<LocalFlowState | null>(null);
  const [hyperliquidFlow, setHyperliquidFlow] = useState<HyperliquidFlowState | null>(null);
  const [executionReview, setExecutionReview] = useState<ExecutionReview | null>(null);
  const [submission, setSubmission] = useState<SubmissionState | null>(null);
  const [lifecycleView, setLifecycleView] = useState<LifecycleViewState | null>(null);
  const [lifecycleRefresh, setLifecycleRefresh] = useState(0);
  const [executionError, setExecutionError] = useState<{
    ticketKey: string;
    message: string;
  } | null>(null);
  const [executionBusy, setExecutionBusy] = useState(false);
  const [confirmingInWallet, setConfirmingInWallet] = useState(false);
  const [idempotency, setIdempotency] = useState<{
    ticketKey: string;
    key: string;
  } | null>(null);
  const privateProvider = useMemo(() => {
    if (!privateApiBaseUrl) {
      return null;
    }
    try {
      return new PrivateHttpTerminalProvider(privateApiBaseUrl);
    } catch {
      return null;
    }
  }, [privateApiBaseUrl]);
  const [providerConnection, setProviderConnection] = useState<ProviderConnection>(
    privateProvider ? "connecting" : "disconnected",
  );
  const [runtimeHealth, setRuntimeHealth] = useState<PrivateTerminalRuntimeHealth | null>(null);

  const ticketKey = JSON.stringify({
    selectedDomain,
    mode,
    size,
    slippage,
    quoteMode,
    traderPublicKey: wallet.selectedAccount?.address ?? null,
  });

  const currentExecutionReview = executionReview?.ticketKey === ticketKey
    ? executionReview
    : null;
  const currentSubmission = submission?.ticketKey === ticketKey ? submission : null;
  const currentLocalFlow = localFlow?.ticketKey === ticketKey ? localFlow : null;
  const currentHyperliquidFlow = hyperliquidFlow?.ticketKey === ticketKey
    ? hyperliquidFlow
    : null;
  const currentLifecycle = lifecycleView?.ticketKey === ticketKey &&
    lifecycleView.attemptId === currentExecutionReview?.preparation.lifecycleAttemptId
    ? lifecycleView
    : null;
  const currentExecutionError = executionError?.ticketKey === ticketKey
    ? executionError.message
    : null;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function loadSnapshot() {
      if (!privateProvider) {
        const localSnapshot = await localConformanceTerminalProvider.getSnapshot(
          selectedDomain,
        );
        if (active) {
          setSnapshot(localSnapshot);
          setProviderConnection("disconnected");
        }
        return;
      }

      try {
        const serviceSnapshot = await privateProvider.getSnapshot(
          selectedDomain,
          controller.signal,
        );
        if (active) {
          setSnapshot(serviceSnapshot);
          setProviderConnection("connected");
        }
      } catch {
        if (controller.signal.aborted) {
          return;
        }
        const localSnapshot = await localConformanceTerminalProvider.getSnapshot(
          selectedDomain,
        );
        if (active) {
          setSnapshot(localSnapshot);
          setProviderConnection("disconnected");
        }
      }
    }

    void loadSnapshot();
    return () => {
      active = false;
      controller.abort();
    };
  }, [privateProvider, selectedDomain]);

  useEffect(() => {
    if (!privateProvider) return;
    const controller = new AbortController();
    let active = true;
    privateProvider.getRuntimeHealth(controller.signal)
      .then((health) => {
        if (active) setRuntimeHealth(health);
      })
      .catch(() => {
        if (active) setRuntimeHealth(null);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [privateProvider]);

  useEffect(() => {
    if (!privateProvider || selectedDomain !== "hyperliquid" ||
        providerConnection !== "connected" || !runtimeHealth?.hyperliquidTestnet.available) return;
    const controller = new AbortController();
    let active = true;
    privateProvider.getHyperliquidTestnetContext(controller.signal)
      .then((context) => {
        if (!active) return;
        setHyperliquidFlow({
          ticketKey,
          context,
          order: null,
          quote: null,
          attempt: null,
          execution: null,
          busy: null,
          error: null,
        });
      })
      .catch((cause) => {
        if (!active || controller.signal.aborted) return;
        setHyperliquidFlow({
          ticketKey,
          context: null,
          order: null,
          quote: null,
          attempt: null,
          execution: null,
          busy: null,
          error: cause instanceof Error ? cause.message : "Hyperliquid context discovery failed.",
        });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [privateProvider, providerConnection, runtimeHealth?.hyperliquidTestnet.available, selectedDomain, ticketKey]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(async () => {
      const input = {
        domain: selectedDomain,
        mode,
        size,
        slippageBps: slippage,
        quoteMode,
      };
      try {
        const nextPreview = privateProvider
          ? await privateProvider.getPreview(input, controller.signal)
          : await localConformanceTerminalProvider.getPreview(input);
        if (active) {
          setPreview(nextPreview);
          if (privateProvider) {
            setProviderConnection("connected");
          }
        }
      } catch {
        if (controller.signal.aborted) {
          return;
        }
        try {
          const localPreview = await localConformanceTerminalProvider.getPreview(input);
          if (active) {
            setPreview(localPreview);
            setProviderConnection("disconnected");
          }
        } catch {
          if (active) {
            setPreview(null);
          }
        }
      }
    }, 200);

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [mode, privateProvider, quoteMode, selectedDomain, size, slippage]);

  const lifecycleAttemptId = currentExecutionReview?.preparation.lifecycleAttemptId ?? null;
  const lifecycleTicketKey = currentExecutionReview?.ticketKey ?? null;

  useEffect(() => {
    if (!privateProvider || !lifecycleAttemptId || !lifecycleTicketKey) return;
    const provider = privateProvider;
    const attemptId = lifecycleAttemptId;
    const boundTicketKey = lifecycleTicketKey;
    const controller = new AbortController();
    let active = true;
    async function loadLifecycle() {
      try {
        const data = await provider.getPackageLifecycle(attemptId, controller.signal);
        if (!active || controller.signal.aborted) return;
        setLifecycleView({
          ticketKey: boundTicketKey,
          attemptId,
          data,
          loading: false,
          unavailable: false,
        });
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setLifecycleView((previous) => ({
          ticketKey: boundTicketKey,
          attemptId,
          data: previous?.ticketKey === boundTicketKey && previous.attemptId === attemptId
            ? previous.data
            : null,
          loading: false,
          unavailable: true,
        }));
      }
    }
    void loadLifecycle();
    return () => {
      active = false;
      controller.abort();
    };
  }, [lifecycleAttemptId, lifecycleRefresh, lifecycleTicketKey, privateProvider]);

  const selectedDomainModel = useMemo(
    () => snapshot.domains.find((domain) => domain.id === selectedDomain),
    [selectedDomain, snapshot.domains],
  );
  const selectedRuntimeHealth = selectedDomain === "solana"
    ? runtimeHealth?.solanaDevnet
    : selectedDomain === "base"
      ? runtimeHealth?.baseTestnetAtomic
      : selectedDomain === "arbitrum"
        ? runtimeHealth?.arbitrumTestnetAsync
        : runtimeHealth?.hyperliquidTestnet;

  // A reviewed transaction is signable only while its review is fresh; the button says so the
  // moment it lapses instead of failing on click.
  const [expiredReviewAt, setExpiredReviewAt] = useState<number | null>(null);
  useEffect(() => {
    if (!currentExecutionReview) return;
    const preparedAt = currentExecutionReview.preparedAt;
    const timer = setTimeout(() => setExpiredReviewAt(preparedAt), Math.max(0, preparedAt + REVIEW_TTL_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [currentExecutionReview]);
  const reviewExpired = currentExecutionReview !== null && currentExecutionReview !== undefined && expiredReviewAt === currentExecutionReview.preparedAt;

  const actionState = useMemo(() => {
    if (selectedDomain !== "solana") {
      return { disabled: true, label: "Solana Devnet only", reason: "Select Solana to prepare the Devnet execution path." };
    }
    if (!privateProvider || providerConnection !== "connected") {
      return { disabled: true, label: "Private service required", reason: "Connect the private terminal service before preparing execution." };
    }
    if (!runtimeHealth?.solanaDevnet.available) {
      return { disabled: true, label: "Devnet runtime unavailable", reason: "The private service is connected, but its Solana Devnet execution runtime is not active." };
    }
    if (!wallet.selectedAccount) {
      return { disabled: true, label: "Connect Devnet wallet", reason: "Choose a Wallet Standard wallet and authorize a Solana Devnet account." };
    }
    if (!wallet.canSignAndSendV0) {
      return { disabled: true, label: "Wallet capability unavailable", reason: "The selected wallet does not advertise Devnet v0 sign-and-send capability." };
    }
    if (!preview || preview.source !== "PRIVATE_TERMINAL_BFF") {
      return { disabled: true, label: "Executable preview required", reason: "A current private-service package preview is required." };
    }
    if (quoteMode !== "coordinated_limits") {
      return { disabled: true, label: "Coordinated limits required", reason: "Devnet execution requires the coordinated-limits quote mode." };
    }
    if (currentSubmission) {
      const observation = currentSubmission.observation;
      if (observation?.lifecycle === "FINALIZED") {
        return {
          disabled: true,
          label: "Transaction finalized",
          reason: `Finalized on Solana Devnet at slot ${observation.finalizedSlot.toLocaleString()}. Network finality only. This does not mean the package completed.`,
        };
      }
      if (observation?.lifecycle === "FAILED") {
        return {
          disabled: true,
          label: "Transaction failed",
          reason: observation.failedSlot === null
            ? `Failed on Solana Devnet with code ${observation.failureCode}. The transaction did not finalize.`
            : `Failed on Solana Devnet with code ${observation.failureCode} at slot ${observation.failedSlot.toLocaleString()}. The transaction did not finalize.`,
        };
      }
      if (observation?.lifecycle === "EXPIRED") {
        return {
          disabled: true,
          label: "Transaction expired",
          reason: `Expired before finality on Solana Devnet. Last valid block height ${observation.lastValidBlockHeight.toLocaleString()}, observed ${observation.observedBlockHeight.toLocaleString()}. The transaction did not finalize.`,
        };
      }
      if (currentSubmission.observationUnavailable) {
        return { disabled: true, label: "Transaction submitted", reason: "Observation temporarily unavailable. The transaction was submitted and network state is unknown. Use Retry observation." };
      }
      if (observation?.lifecycle === "SUBMITTED" && observation.observedSlot !== null) {
        return { disabled: true, label: "Transaction submitted", reason: `Submitted to Solana Devnet and observed at slot ${observation.observedSlot.toLocaleString()}. Waiting for finality. Submission does not assert package completion.` };
      }
      return { disabled: true, label: "Transaction submitted", reason: "Observation is pending. Submission does not assert finality or package completion." };
    }
    if (!currentExecutionReview) {
      return { disabled: true, label: "Sign and submit on Devnet", reason: "Prepare and review the unsigned Devnet transaction before signing." };
    }
    if (reviewExpired) {
      return { disabled: true, label: "Review expired", reason: "The reviewed Devnet transaction is older than 45 seconds. Prepare a fresh review before signing." };
    }
    return { disabled: false, label: "Sign and submit on Devnet", reason: "The wallet will show the exact reviewed Devnet transaction before signing." };
  }, [
    reviewExpired,
    currentExecutionReview,
    currentSubmission,
    preview,
    privateProvider,
    providerConnection,
    quoteMode,
    selectedDomain,
    runtimeHealth,
    wallet.canSignAndSendV0,
    wallet.selectedAccount,
  ]);

  async function prepareExecution(
    currentIdempotencyKey: string,
  ): Promise<SolanaExecutionPreparation> {
    if (!privateProvider || !wallet.selectedAccount) {
      throw new Error("Private service and Devnet wallet are required.");
    }
    const input: SolanaExecutionPreparationInput = {
      domain: "svm:devnet",
      mode,
      size,
      slippageBps: slippage,
      quoteMode,
      traderPublicKey: wallet.selectedAccount.address,
      idempotencyKey: currentIdempotencyKey,
    };
    return privateProvider.prepareSolanaExecution(input);
  }

  async function handleExecutionAction() {
    if (actionState.disabled || executionBusy) return;
    setExecutionBusy(true);
    setExecutionError(null);
    try {
      if (currentExecutionReview && Date.now() - currentExecutionReview.preparedAt > REVIEW_TTL_MS) {
        setExecutionReview(null);
        setIdempotency(null);
        setExecutionError({ ticketKey, message: "The prior review expired. Prepare a fresh Devnet transaction." });
        return;
      }
      const key = idempotency?.ticketKey === ticketKey ? idempotency.key : crypto.randomUUID();
      if (idempotency?.ticketKey !== ticketKey) setIdempotency({ ticketKey, key });
      const next = await prepareExecution(key);
      if (!currentExecutionReview) throw new Error("Prepare and review the Devnet transaction first.");
      const changed = preparationFingerprint(currentExecutionReview.preparation) !==
        preparationFingerprint(next);
      if (changed) {
        setExecutionReview({ preparation: next, preparedAt: Date.now(), ticketKey });
        setLifecycleView({
          ticketKey,
          attemptId: next.lifecycleAttemptId,
          data: null,
          loading: true,
          unavailable: false,
        });
        setExecutionError({ ticketKey, message: "Execution material changed. Review the refreshed transaction before signing." });
        return;
      }
      setConfirmingInWallet(true);
      try {
        const signature = await wallet.signAndSend(next.transactionBytes);
        setSubmission({
          signature,
          idempotencyKey: key,
          ticketKey,
          observation: null,
          observationUnavailable: false,
          consecutiveFailures: 0,
          lastCheckedAt: null,
        });
      } finally {
        setConfirmingInWallet(false);
      }
    } catch (cause) {
      setExecutionError({
        ticketKey,
        message: cause instanceof Error ? cause.message : "Execution preparation failed.",
      });
    } finally {
      setExecutionBusy(false);
    }
  }

  async function handlePrepareExecution() {
    if (!privateProvider || providerConnection !== "connected" ||
        selectedDomain !== "solana" || !wallet.selectedAccount ||
        !wallet.canSignAndSendV0 || !preview || preview.source !== "PRIVATE_TERMINAL_BFF" ||
        quoteMode !== "coordinated_limits" ||
        currentSubmission || executionBusy) return;
    setExecutionBusy(true);
    setExecutionError(null);
    try {
      const key = currentExecutionReview
        ? crypto.randomUUID()
        : idempotency?.ticketKey === ticketKey
          ? idempotency.key
          : crypto.randomUUID();
      setIdempotency({ ticketKey, key });
      const preparation = await prepareExecution(key);
      setExecutionReview({ preparation, preparedAt: Date.now(), ticketKey });
      setLifecycleView({
        ticketKey,
        attemptId: preparation.lifecycleAttemptId,
        data: null,
        loading: true,
        unavailable: false,
      });
    } catch (cause) {
      setExecutionReview(null);
      setExecutionError({
        ticketKey,
        message: cause instanceof Error ? cause.message : "Execution preparation failed.",
      });
    } finally {
      setExecutionBusy(false);
    }
  }

  const currentObservation = currentSubmission?.observation ?? null;
  const currentObservationTerminal = isObservationTerminal(currentObservation);
  const currentObservationAutoPaused = currentSubmission !== null &&
    currentSubmission.observationUnavailable &&
    currentSubmission.consecutiveFailures >= OBSERVATION_MAX_AUTO_FAILURES &&
    !currentObservationTerminal;
  const observationSignature = currentSubmission?.signature ?? null;
  const observationIdempotencyKey = currentSubmission?.idempotencyKey ?? null;
  const observationTicketKey = currentSubmission?.ticketKey ?? null;

  useEffect(() => {
    if (!privateProvider) return;
    if (!observationSignature || !observationIdempotencyKey || !observationTicketKey) return;
    if (currentObservationTerminal) return;
    if (currentObservationAutoPaused) return;
    const signature = observationSignature;
    const idempotencyKey = observationIdempotencyKey;
    const ticket = observationTicketKey;
    const controller = new AbortController();
    let active = true;
    let inFlight = false;
    async function poll() {
      if (!active || inFlight) return;
      if (!privateProvider) return;
      inFlight = true;
      try {
        const observation = await privateProvider.observeSolanaExecution(
          { idempotencyKey, signature },
          controller.signal,
        );
        if (!active || controller.signal.aborted) return;
        setSubmission((previous) => {
          if (!previous || previous.signature !== signature ||
              previous.ticketKey !== ticket || previous.idempotencyKey !== idempotencyKey) {
            return previous;
          }
          return {
            ...previous,
            observation,
            observationUnavailable: false,
            consecutiveFailures: 0,
            lastCheckedAt: Date.now(),
          };
        });
        setLifecycleView((previous) => previous?.ticketKey === ticket && previous.data
          ? { ...previous, loading: true, unavailable: false }
          : previous);
        setLifecycleRefresh((value) => value + 1);
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setSubmission((previous) => {
          if (!previous || previous.signature !== signature ||
              previous.ticketKey !== ticket || previous.idempotencyKey !== idempotencyKey) {
            return previous;
          }
          return {
            ...previous,
            observationUnavailable: true,
            consecutiveFailures: previous.consecutiveFailures + 1,
            lastCheckedAt: Date.now(),
          };
        });
      } finally {
        inFlight = false;
      }
    }
    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, OBSERVATION_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
      controller.abort();
    };
  }, [
    privateProvider,
    observationSignature,
    observationIdempotencyKey,
    observationTicketKey,
    currentObservationTerminal,
    currentObservationAutoPaused,
  ]);

  function handleRetryObservation() {
    if (!currentSubmission) return;
    if (currentObservationTerminal) return;
    const signature = currentSubmission.signature;
    const ticket = currentSubmission.ticketKey;
    const idempotencyKey = currentSubmission.idempotencyKey;
    setSubmission((previous) => {
      if (!previous || previous.signature !== signature ||
          previous.ticketKey !== ticket || previous.idempotencyKey !== idempotencyKey) {
        return previous;
      }
      return { ...previous, observationUnavailable: false, consecutiveFailures: 0 };
    });
  }

  function handleRetryLifecycle() {
    if (!currentExecutionReview) return;
    setLifecycleView((previous) => previous?.ticketKey === currentExecutionReview.ticketKey
      ? { ...previous, loading: true, unavailable: false }
      : previous);
    setLifecycleRefresh((value) => value + 1);
  }

  async function handleLocalStep(
    step: "create" | "authorize" | "quote" | "select" | LocalExecutionAction,
  ) {
    if (!privateProvider || !wallet.selectedAccount) return;
    const base: LocalFlowState = currentLocalFlow ?? {
      ticketKey,
      order: null,
      authorization: null,
      quote: null,
      attempt: null,
      lifecycle: null,
      busy: null,
      error: null,
    };
    setLocalFlow({ ...base, busy: step, error: null });
    try {
      if (step === "create") {
        const order = await privateProvider.createLocalOrder({
          owner: wallet.selectedAccount.address,
          settlementAccount: wallet.selectedAccount.address,
          size,
          slippageBps: slippage,
          idempotencyKey: crypto.randomUUID(),
        });
        setLocalFlow({ ...base, order, busy: null, error: null });
        return;
      }
      if (!base.order) throw new Error("Create the canonical order first.");
      if (step === "authorize") {
        const signature = await wallet.signMessage(base.order.order.orderBytes);
        const authorization = await privateProvider.authorizeLocalOrder(
          base.order.order,
          signature,
        );
        setLocalFlow({ ...base, authorization, busy: null, error: null });
        return;
      }
      if (!base.authorization) throw new Error("Authorize the canonical order first.");
      if (step === "quote") {
        const quote = await privateProvider.requestLocalQuote(
          base.order.order,
          crypto.randomUUID(),
        );
        setLocalFlow({ ...base, quote, busy: null, error: null });
        return;
      }
      if (!base.quote) throw new Error("Request and review a signed solver quote first.");
      if (step === "select") {
        const attempt = await privateProvider.selectLocalQuote(base.quote);
        setLocalFlow({ ...base, attempt, busy: null, error: null });
        return;
      }
      if (!base.attempt) throw new Error("Select the reviewed quote first.");
      const result = await privateProvider.runLocalExecutionAction(base.attempt, step);
      setLocalFlow({ ...base, lifecycle: result.lifecycle, busy: null, error: null });
    } catch (cause) {
      setLocalFlow({
        ...base,
        busy: null,
        error: cause instanceof Error ? cause.message : "Local execution action failed.",
      });
    }
  }

  async function handleHyperliquidStep(
    step: "create" | "quote" | "select" | "execute",
  ) {
    if (!privateProvider || !currentHyperliquidFlow?.context ||
        !runtimeHealth?.hyperliquidTestnet.available) return;
    const base = currentHyperliquidFlow;
    const context = currentHyperliquidFlow.context;
    setHyperliquidFlow({ ...base, busy: step, error: null });
    try {
      if (step === "create") {
        const order = await privateProvider.createHyperliquidOrder(context, {
          size,
          slippageBps: slippage,
          idempotencyKey: crypto.randomUUID(),
        });
        setHyperliquidFlow({ ...base, order, busy: null, error: null });
        return;
      }
      if (!base.order) throw new Error("Create the Hyperliquid canonical order first.");
      if (step === "quote") {
        const quote = await privateProvider.requestHyperliquidQuote(
          base.order.order,
          crypto.randomUUID(),
        );
        setHyperliquidFlow({ ...base, quote, busy: null, error: null });
        return;
      }
      if (!base.quote) throw new Error("Request and review a signed Hyperliquid quote first.");
      if (step === "select") {
        const attempt = await privateProvider.selectHyperliquidQuote(context, base.quote);
        setHyperliquidFlow({ ...base, attempt, busy: null, error: null });
        return;
      }
      if (!base.attempt) throw new Error("Select the reviewed Hyperliquid quote first.");
      const execution = await privateProvider.executeHyperliquidTestnet(
        base.attempt,
        crypto.randomUUID(),
      );
      setHyperliquidFlow({ ...base, execution, busy: null, error: null });
    } catch (cause) {
      setHyperliquidFlow({
        ...base,
        busy: null,
        error: cause instanceof Error ? cause.message : "Hyperliquid Testnet action failed.",
      });
    }
  }

  const prepareDisabled = selectedDomain !== "solana" || !privateProvider ||
    providerConnection !== "connected" || !wallet.selectedAccount ||
    !runtimeHealth?.solanaDevnet.available ||
    !wallet.canSignAndSendV0 || !preview || preview.source !== "PRIVATE_TERMINAL_BFF" ||
    quoteMode !== "coordinated_limits" ||
    currentSubmission !== null;
  const localFlowEnabled = selectedDomain === "solana" && mode === "entry" &&
    privateProvider !== null && providerConnection === "connected" &&
    wallet.selectedAccount !== null && preview?.source === "PRIVATE_TERMINAL_BFF" &&
    quoteMode === "coordinated_limits";
  const hyperliquidFlowEnabled = selectedDomain === "hyperliquid" && mode === "entry" &&
    privateProvider !== null && providerConnection === "connected" &&
    runtimeHealth?.hyperliquidTestnet.available === true &&
    preview?.source === "PRIVATE_TERMINAL_BFF" && quoteMode === "coordinated_limits";
  const displayedLifecycle = currentLocalFlow?.lifecycle ?? currentLifecycle?.data ?? null;

  const accountLabel = selectedDomain === "solana"
    ? wallet.selectedAccount ? `${wallet.selectedAccount.address.slice(0, 4)}...${wallet.selectedAccount.address.slice(-4)}` : "Wallet not connected"
    : selectedDomain === "hyperliquid"
      ? "Service account gate"
      : evmWallet.account ? `${evmWallet.account.slice(0, 6)}...${evmWallet.account.slice(-4)}` : "Wallet not connected";

  function openView(tab: BottomTab) {
    setWorkspaceTab(tab);
    setWorkspaceAttention((value) => value + 1);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("terminal-workspace")?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }

  function jumpToTicket(nextMode: PackageMode) {
    setMode(nextMode);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("package-ticket")?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  }

  function changeDomain(domain: DomainId) {
    setSelectedDomain(domain);
    if (privateProvider) {
      setProviderConnection("connecting");
    }
  }

  return (
    <div className={styles.terminalShell}>
      <TopNavigation
        snapshot={snapshot}
        selectedDomain={selectedDomain}
        providerConnection={providerConnection}
        wallet={wallet}
        evmWallet={evmWallet}
        onDomainChange={changeDomain}
        onOpenView={openView}
      />
      <main className={styles.terminalGrid}>
        <div className={styles.areaInstrument}>
          <InstrumentBar snapshot={snapshot} feed={feed} />
        </div>
        <div className={styles.areaChart}>
          <ChartWorkspace
            feed={feed}
            snapshot={snapshot}
            preview={preview}
            size={size}
          />
        </div>
        <div className={styles.areaBook}>
          <OrderBook key={feed.label} feed={feed} />
        </div>
        <div id="package-ticket" className={styles.areaTicket}>
          <Ticket
            snapshot={snapshot}
            selectedDomain={selectedDomain}
            mode={mode}
            preview={preview}
            size={size}
            slippage={slippage}
            quoteMode={quoteMode}
            accountLabel={accountLabel}
            localFlow={currentLocalFlow}
            localFlowEnabled={localFlowEnabled}
            localCanSignMessage={wallet.canSignMessage}
            hyperliquidFlow={currentHyperliquidFlow}
            hyperliquidFlowEnabled={hyperliquidFlowEnabled}
            executionReview={currentExecutionReview}
            submission={currentSubmission}
            confirming={confirmingInWallet}
            actionLabel={actionState.label}
            actionReason={confirmingInWallet && !currentSubmission ? "Confirm in wallet. Approve the exact reviewed Devnet transaction." : (currentExecutionError ?? actionState.reason)}
            actionDisabled={actionState.disabled}
            actionBusy={executionBusy}
            prepareDisabled={prepareDisabled}
            onModeChange={setMode}
            onSizeChange={setSize}
            onSlippageChange={setSlippage}
            onQuoteModeChange={setQuoteMode}
            onLocalStep={(step) => void handleLocalStep(step)}
            onHyperliquidStep={(step) => void handleHyperliquidStep(step)}
            onExecutionAction={() => void handleExecutionAction()}
            onPrepareExecution={() => void handlePrepareExecution()}
            onRetryObservation={handleRetryObservation}
          />
        </div>
        <div className={styles.areaBottom}>
          <BottomWorkspace
            snapshot={snapshot}
            providerConnection={providerConnection}
            submission={currentSubmission}
            attemptMode={mode}
            lifecycle={displayedLifecycle}
            lifecycleLoading={currentLocalFlow ? false : currentLifecycle?.loading ?? false}
            lifecycleUnavailable={currentLocalFlow ? false : currentLifecycle?.unavailable ?? false}
            onRetryObservation={handleRetryObservation}
            onRetryLifecycle={handleRetryLifecycle}
            activeTab={workspaceTab}
            onTabChange={setWorkspaceTab}
            attentionKey={workspaceAttention}
            routePlan={<PackageSequence snapshot={snapshot} mode={mode} preview={preview} />}
            readiness={
              <ExecutionReadiness
                snapshot={snapshot}
                selectedDomain={selectedDomain}
                providerConnection={providerConnection}
                runtimeHealth={runtimeHealth}
                lifecycle={displayedLifecycle}
                hasService={privateProvider !== null}
                onSelect={changeDomain}
              />
            }
            solvers={<SolverMetrics publicApiBaseUrl={publicApiBaseUrl} />}
          />
        </div>
      </main>
      <div className={styles.mobileActions} role="group" aria-label="Open package ticket">
        <button type="button" className={styles.mobileEntry} onClick={() => jumpToTicket("entry")}>Enter package</button>
        <button type="button" className={styles.mobileExit} onClick={() => jumpToTicket("exit")}>Exit package</button>
      </div>
      <StatusBar
        snapshot={snapshot}
        providerConnection={providerConnection}
        feedLabel={feed.label}
        feedStatus={feedStatus}
        domainLabel={selectedDomainModel?.label ?? selectedDomain}
        domainNote={selectedRuntimeHealth?.available ? "Testnet execution available" : `${selectedDomainModel?.state ?? "Fixture"} data only`}
      />
    </div>
  );
}
