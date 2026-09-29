"use client";

import { useEffect, useMemo, useState } from "react";
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
  BasisPoint,
  DomainId,
  PackageLeg,
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

const SLIPPAGE_OPTIONS: readonly SlippageBps[] = [5, 10, 25];

function formatCurrency(value: number) {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function sanitizeSize(value: string) {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const [whole, ...decimals] = cleaned.split(".");
  return decimals.length > 0 ? `${whole}.${decimals.join("")}` : whole;
}

function pointsFor(
  points: BasisPoint[],
  key: "spot" | "perp",
  minimum: number,
  range: number,
) {
  return points
    .map((point, index) => {
      const x = 36 + (index / (points.length - 1)) * 648;
      const y = 190 - ((point[key] - minimum) / range) * 140;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function BrandMark() {
  return (
    <span className={styles.brandMark} aria-hidden="true">
      <svg viewBox="0 0 28 28" fill="none">
        <path d="M5 21V7h4.2l9.6 13V7H23v14h-4.2L9.2 8v13H5Z" />
        <path d="M5 24h18" />
      </svg>
    </span>
  );
}

function TopNavigation({
  snapshot,
  selectedDomain,
  providerConnection,
  wallet,
  evmWallet,
  onDomainChange,
}: {
  snapshot: TerminalViewModel;
  selectedDomain: DomainId;
  providerConnection: ProviderConnection;
  wallet: SolanaWalletSession;
  evmWallet: InjectedEvmWalletSession;
  onDomainChange: (domain: DomainId) => void;
}) {
  const providerLabel = providerConnection === "connected"
    ? "Private service connected"
    : providerConnection === "connecting"
      ? "Checking private service"
      : "Local fallback";
  const evmDomain = isEvmDomain(selectedDomain) ? selectedDomain : null;
  const expectedNetwork = evmDomain ? EVM_TESTNETS[evmDomain] : null;
  const evmNetworkMatches = Boolean(
    expectedNetwork && evmWallet.chainId === expectedNetwork.chainId,
  );

  const walletControl = selectedDomain === "solana" ? (
    <div className={styles.walletControl}>
      <select
        aria-label="Solana Devnet wallet"
        value={wallet.selectedWallet?.name ?? ""}
        onChange={(event) => wallet.selectWallet(event.target.value)}
      >
        <option value="">Select wallet</option>
        {wallet.wallets.map((item) => (
          <option key={item.name} value={item.name}>{item.name}</option>
        ))}
      </select>
      {wallet.selectedAccount ? (
        <>
          {wallet.accounts.length > 1 ? (
            <select
              aria-label="Solana Devnet wallet account"
              value={wallet.selectedAccount.address}
              onChange={(event) => wallet.selectAccount(event.target.value)}
            >
              {wallet.accounts.map((account) => (
                <option key={account.address} value={account.address}>
                  {account.label ?? `${account.address.slice(0, 4)}...${account.address.slice(-4)}`}
                </option>
              ))}
            </select>
          ) : null}
          <button type="button" onClick={() => void wallet.disconnect()}>
            Disconnect
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={!wallet.selectedWallet || wallet.connecting}
          onClick={() => void wallet.connect()}
        >
          {wallet.connecting ? "Connecting" : "Connect Devnet"}
        </button>
      )}
    </div>
  ) : evmDomain && expectedNetwork ? (
    <div className={styles.walletControl}>
      {!evmWallet.account ? (
        <button
          type="button"
          disabled={!evmWallet.available || evmWallet.connecting}
          onClick={() => void evmWallet.connect()}
        >
          {evmWallet.connecting ? "Connecting" : "Connect wallet"}
        </button>
      ) : !evmNetworkMatches ? (
        <button
          type="button"
          className={styles.networkMismatch}
          disabled={evmWallet.switching}
          onClick={() => void evmWallet.switchNetwork(evmDomain)}
        >
          {evmWallet.switching ? "Switching" : `Switch to ${expectedNetwork.label}`}
        </button>
      ) : (
        <button type="button" onClick={evmWallet.disconnect}>
          Disconnect
        </button>
      )}
    </div>
  ) : (
    <div className={styles.serviceBadge}>Testnet service</div>
  );

  const sessionStatus = selectedDomain === "solana" ? (
    <>
      <span className={wallet.selectedAccount ? styles.statusDot : styles.offlineDot} />
      <div>
        <span>{wallet.selectedAccount ? "Devnet wallet ready" : "Wallet offline"}</span>
        <small>
          {wallet.selectedAccount
            ? `${wallet.selectedAccount.address.slice(0, 4)}...${wallet.selectedAccount.address.slice(-4)}`
            : wallet.error ?? "Wallet Standard only"}
        </small>
      </div>
    </>
  ) : evmDomain && expectedNetwork ? (
    <>
      <span className={evmWallet.account && evmNetworkMatches ? styles.statusDot : styles.offlineDot} />
      <div>
        <span>
          {!evmWallet.account
            ? "EVM wallet offline"
            : evmNetworkMatches
              ? `${expectedNetwork.label} ready`
              : "Wrong network"}
        </span>
        <small className={evmWallet.error ? styles.walletError : undefined}>
          {evmWallet.error ?? (evmWallet.account
            ? `${evmWallet.account.slice(0, 6)}...${evmWallet.account.slice(-4)}`
            : evmWallet.available
              ? "Manual connection only"
              : "Injected wallet unavailable")}
        </small>
      </div>
    </>
  ) : (
    <>
      <span className={styles.offlineDot} />
      <div>
        <span>No browser wallet</span>
        <small>Hyperliquid testnet service</small>
      </div>
    </>
  );

  return (
    <header className={styles.topNavigation}>
      <div className={styles.brand}>
        <BrandMark />
        <div>
          <strong>Naryx</strong>
          <span>Private terminal</span>
        </div>
      </div>

      <div
        className={styles.environmentBadge}
        title={`${snapshot.environment.title}. ${snapshot.environment.detail} Captured ${snapshot.environment.capturedAt}.`}
      >
        <span className={styles.statusDot} />
        <span>{snapshot.environment.label}</span>
        <small>{providerLabel}</small>
      </div>

      <nav className={styles.domainSelector} aria-label="Execution domain preview">
        {snapshot.domains.map((domain) => (
          <button
            key={domain.id}
            type="button"
            className={
              selectedDomain === domain.id ? styles.domainActive : undefined
            }
            aria-pressed={selectedDomain === domain.id}
            title={`${domain.runtime}. ${domain.state} data.`}
            onClick={() => onDomainChange(domain.id)}
          >
            {domain.label}
          </button>
        ))}
      </nav>

      {walletControl}

      <div className={styles.sessionStatus}>
        {sessionStatus}
      </div>
    </header>
  );
}

function MarketHeader({ snapshot }: { snapshot: TerminalViewModel }) {
  return (
    <section className={styles.marketHeader} aria-label="Package market overview">
      <div className={styles.marketIdentity}>
        <div className={styles.assetMark}>{snapshot.market.base.slice(0, 1)}</div>
        <div>
          <div className={styles.pairLine}>
            <h1>
              {snapshot.market.base}
              <span>/</span>
              {snapshot.market.quote}
            </h1>
            <span className={styles.packageTag}>Package</span>
          </div>
          <p>
            {snapshot.market.strategy} <span>{snapshot.market.packageId}</span>
          </p>
        </div>
      </div>

      <div className={styles.metricsRail}>
        {snapshot.market.metrics.map((metric) => (
          <div className={styles.metric} key={metric.label}>
            <span>{metric.label}</span>
            <strong className={metric.accent ? styles.accentValue : undefined}>
              {metric.value}
            </strong>
            {metric.detail ? <small>{metric.detail}</small> : null}
          </div>
        ))}
      </div>
    </section>
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
  return (
    <section className={styles.readinessPanel} aria-labelledby="readiness-title">
      <div className={styles.readinessHeader}>
        <div>
          <div className={styles.eyebrow}>Execution readiness</div>
          <h2 id="readiness-title">Evidence and promotion boundary</h2>
          <p>Observed controls and evidence only. Missing proof remains unavailable.</p>
        </div>
        <span className={styles.readinessService} role="status">{serviceNote}</span>
      </div>

      <ol className={styles.assuranceRail} aria-label="Environment promotion boundary">
        <li className={localVerified ? styles.assuranceVerified : styles.assuranceUnknown}>
          <span>01</span><div><strong>Local verification</strong><small>{localVerified ? "VERIFIED" : "UNKNOWN"}</small></div>
        </li>
        <li className={styles.assuranceDeferred}>
          <span>02</span><div><strong>Public testnet</strong><small>DEPLOYMENT DEFERRED</small></div>
        </li>
        <li className={styles.assuranceConditional}>
          <span>03</span><div><strong>Pinned fork</strong><small>HARNESS READY, RPC DEPENDENT</small></div>
        </li>
        <li className={styles.assuranceConditional}>
          <span>04</span><div><strong>Mainnet shadow</strong><small>SIGNERLESS READ ONLY</small></div>
        </li>
        <li className={styles.assuranceProhibited}>
          <span>05</span><div><strong>Mainnet writes</strong><small>PROHIBITED</small></div>
        </li>
      </ol>

      <div className={styles.evidenceLedger} aria-label={`${READINESS_FALLBACK[selectedDomain].label} evidence ledger`}>
        <div className={styles.evidenceLedgerTitle}>
          <span>Selected domain evidence</span>
          <strong>{READINESS_FALLBACK[selectedDomain].label}</strong>
        </div>
        <dl>
          <div><dt>Settlement class</dt><dd title={selectedMeta.settlementClass}>{selectedMeta.settlementClass}</dd></div>
          <div><dt>Route evidence</dt><dd>{routeEvidence}</dd></div>
          <div><dt>Funded operation hash</dt><dd>NOT AVAILABLE</dd></div>
          <div><dt>Readiness decision hash</dt><dd>NOT AVAILABLE</dd></div>
          <div><dt>Authority fence</dt><dd>{authorityFence}</dd></div>
          <div><dt>Dependencies</dt><dd title={dependencyStatus}>{dependencyStatus}</dd></div>
          <div><dt>Incident state</dt><dd>UNKNOWN</dd></div>
          <div><dt>Execution</dt><dd>{readinessBlocker(hasService, providerConnection, selectedHealth, selectedDomain)}</dd></div>
        </dl>
      </div>

      <ul className={styles.readinessGrid} aria-label="Domain execution readiness">
        {READINESS_ORDER.map((domain) => {
          const model = snapshot.domains.find((item) => item.id === domain);
          const fallback = READINESS_FALLBACK[domain];
          const meta = READINESS_META[domain];
          const health = readinessHealthFor(domain, runtimeHealth);
          const status = !hasService
            ? "Disabled"
            : !health
              ? providerConnection === "connecting" ? "Checking" : "Unavailable"
              : health.available ? "Available" : "Unavailable";
          const blocker = readinessBlocker(hasService, providerConnection, health, domain);
          const selected = selectedDomain === domain;
          return (
            <li key={domain}>
              <button
                type="button"
                className={selected ? `${styles.readinessCard} ${styles.readinessSelected}` : styles.readinessCard}
                aria-pressed={selected}
                aria-label={`${model?.label ?? fallback.label} domain, ${status}. ${blocker} ${selected ? "Selected." : "Select."}`}
                title={blocker}
                onClick={() => onSelect(domain)}
              >
                <span className={styles.readinessTop}>
                  <strong>{model?.label ?? fallback.label}{selected ? " - Selected" : ""}</strong>
                  <span className={status === "Available" ? styles.readinessAvailable : styles.readinessUnavailable}>
                    <span className={status === "Available" ? styles.statusDot : styles.offlineDot} aria-hidden="true" />
                    {status}
                  </span>
                </span>
                <span className={styles.readinessFacts}>
                  <span><span>Runtime</span><strong>{model?.runtime ?? fallback.runtime}</strong></span>
                  <span><span>Network</span><strong>{meta.testNetwork}</strong></span>
                  <span><span>Mode</span><strong>{meta.executionMode}</strong></span>
                  <span><span>Settlement</span><strong title={meta.settlementClass}>{meta.settlementClass}</strong></span>
                </span>
                <span className={styles.readinessBlocker}>{blocker}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function BasisChart({ snapshot }: { snapshot: TerminalViewModel }) {
  const values = snapshot.chart.points.flatMap((point) => [point.spot, point.perp]);
  const minimum = Math.min(...values) - 0.12;
  const maximum = Math.max(...values) + 0.12;
  const range = maximum - minimum;
  const spotPoints = pointsFor(snapshot.chart.points, "spot", minimum, range);
  const perpPoints = pointsFor(snapshot.chart.points, "perp", minimum, range);
  const areaPoints = `${spotPoints} ${perpPoints.split(" ").reverse().join(" ")}`;

  return (
    <section className={styles.panel} aria-labelledby="basis-chart-title">
      <div className={styles.panelHeader}>
        <div>
          <div className={styles.eyebrow}>Spread monitor</div>
          <h2 id="basis-chart-title">{snapshot.chart.title}</h2>
          <p>{snapshot.chart.subtitle}</p>
        </div>
        <div className={styles.chartLegend} aria-label="Chart legend">
          <span>
            <i className={styles.spotKey} /> Spot
          </span>
          <span>
            <i className={styles.perpKey} /> Perpetual
          </span>
          <span className={styles.timeframe}>1H</span>
        </div>
      </div>

      <div className={styles.chartFrame}>
        <svg
          className={styles.chart}
          viewBox="0 0 720 220"
          role="img"
          aria-labelledby="chart-title chart-description"
        >
          <title id="chart-title">Spot and perpetual reference prices</title>
          <desc id="chart-description">
            Deterministic conformance prices with the perpetual above spot across the
            captured window.
          </desc>
          {[50, 96.7, 143.3, 190].map((y) => (
            <line
              className={styles.gridLine}
              key={y}
              x1="36"
              x2="684"
              y1={y}
              y2={y}
            />
          ))}
          <polygon className={styles.basisArea} points={areaPoints} />
          <polyline className={styles.spotLine} points={spotPoints} />
          <polyline className={styles.perpLine} points={perpPoints} />
          <circle className={styles.spotPoint} cx="684" cy={spotPoints.split(" ").at(-1)?.split(",")[1]} r="4" />
          <circle className={styles.perpPoint} cx="684" cy={perpPoints.split(" ").at(-1)?.split(",")[1]} r="4" />
          <text className={styles.axisLabel} x="36" y="211">
            {snapshot.chart.points.at(0)?.label}
          </text>
          <text className={styles.axisLabel} x="684" y="211" textAnchor="end">
            {snapshot.chart.points.at(-1)?.label}
          </text>
          <text className={styles.axisLabel} x="36" y="39">
            {formatCurrency(maximum)}
          </text>
          <text className={styles.axisLabel} x="36" y="185">
            {formatCurrency(minimum)}
          </text>
        </svg>

        <div className={styles.basisStrip} aria-label="Basis in basis points">
          <div className={styles.basisStripLabel}>
            <span>Basis profile</span>
            <strong>{snapshot.chart.points.at(-1)?.basisBps.toFixed(1)} bps</strong>
          </div>
          <div className={styles.basisBars}>
            {snapshot.chart.points.map((point) => (
              <span
                key={point.label}
                title={`${point.label}: ${point.basisBps.toFixed(1)} bps`}
                style={{ height: `${Math.max(24, point.basisBps)}%` }}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function LegCard({ leg }: { leg: PackageLeg }) {
  return (
    <article className={styles.legCard}>
      <div className={styles.legTopline}>
        <span className={styles.legSequence}>0{leg.sequence}</span>
        <span className={styles.legState}>{leg.state}</span>
      </div>
      <div className={styles.legTitle}>
        <div>
          <span>{leg.action}</span>
          <h3>{leg.instrument}</h3>
        </div>
        <strong>{leg.quantity}</strong>
      </div>
      <p className={styles.legVenue}>{leg.venue}</p>
      <div className={styles.legDetails}>
        <div>
          <span>{leg.limitLabel}</span>
          <strong>{leg.limit}</strong>
        </div>
        <div>
          <span>Dependency</span>
          <strong>{leg.dependency}</strong>
        </div>
      </div>
    </article>
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
    <section className={`${styles.panel} ${styles.sequencePanel}`} aria-labelledby="sequence-title">
      <div className={styles.panelHeader}>
        <div>
          <div className={styles.eyebrow}>Isolated package plan</div>
          <h2 id="sequence-title">{plan.label}</h2>
          <p>{plan.description}</p>
        </div>
        <span className={styles.sequencePolicy}>Fail closed</span>
      </div>
      <div className={styles.legs}>
        <LegCard leg={legs[0]} />
        <div className={styles.dependencyConnector} aria-hidden="true">
          <span />
          <b>then</b>
          <span />
        </div>
        <LegCard leg={legs[1]} />
      </div>
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
  }
  return "-";
}

function quoteAmount(quote: LocalSolverQuote, key: string): string {
  const value = quote.quote[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "-";
  return protocolScalar((value as Record<string, unknown>).atoms);
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
  slippage,
  onStep,
}: {
  flow: HyperliquidFlowState | null;
  enabled: boolean;
  size: string;
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
          <span>Requested size</span><strong>{size} {"BTC"}</strong>
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
          <strong>{preview?.size.value ?? "-"} SOL</strong>
        </div>
        <div>
          <span>Bound</span>
          <strong>{preview ? `$${preview.bound.value}` : "-"}</strong>
        </div>
        <div>
          <span>Fees</span>
          <strong>{preview ? `$${preview.totalFee.value}` : "-"}</strong>
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
  return (
    <aside className={`${styles.panel} ${styles.ticket}`} aria-labelledby="ticket-title">
      <div className={styles.ticketHeader}>
        <div>
          <div className={styles.eyebrow}>Package ticket</div>
          <h2 id="ticket-title">Prepare route</h2>
        </div>
        <span className={styles.previewPill}>Preview</span>
      </div>

      <div className={styles.modeSwitch} aria-label="Package mode">
        {(["entry", "exit"] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={mode === item ? styles.modeActive : undefined}
            aria-pressed={mode === item}
            onClick={() => onModeChange(item)}
          >
            {item === "entry" ? "Entry" : "Exit"}
          </button>
        ))}
      </div>

      <label className={styles.fieldLabel} htmlFor="package-size">
        <span>Package size</span>
        <small>Fixture reference: {snapshot.ticket.defaultSize} SOL</small>
      </label>
      <div className={styles.amountInput}>
        <input
          id="package-size"
          inputMode="decimal"
          autoComplete="off"
          value={size}
          onChange={(event) => onSizeChange(sanitizeSize(event.target.value))}
          aria-describedby="size-context"
        />
        <span>{snapshot.ticket.sizeSymbol}</span>
      </div>
      <p id="size-context" className={styles.fieldContext}>
        Conformance calculation only. No balance has been loaded.
      </p>

      <div className={styles.boundaryRow}>
        <span>{mode === "entry" ? "Maximum quote" : "Minimum output"}</span>
        <div>
          <strong>{preview ? `$${preview.bound.value}` : "Unavailable"}</strong>
          <small>USDC conformance estimate</small>
        </div>
      </div>

      <div className={styles.ticketField}>
        <span>Slippage</span>
        <div className={styles.segmentedControl}>
          {SLIPPAGE_OPTIONS.map((option) => (
            <button
              type="button"
              key={option}
              className={slippage === option ? styles.segmentActive : undefined}
              aria-pressed={slippage === option}
              onClick={() => onSlippageChange(option)}
            >
              {option} bps
            </button>
          ))}
        </div>
      </div>

      <label className={styles.ticketField} htmlFor="quote-mode">
        <span>Quote mode</span>
        <select
          id="quote-mode"
          value={quoteMode}
          onChange={(event) => onQuoteModeChange(event.target.value as QuoteMode)}
        >
          {snapshot.ticket.quoteModes.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
      </label>

      <section className={styles.evidenceBox} aria-labelledby="route-evidence-title">
        <div className={styles.evidenceHeading}>
          <h3 id="route-evidence-title">Route evidence</h3>
          <span>Unverified</span>
        </div>
        {snapshot.ticket.evidence.map((row) => (
          <div className={styles.summaryRow} key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </section>

      {selectedDomain === "hyperliquid" ? (
        <HyperliquidTestnetPanel
          flow={hyperliquidFlow}
          enabled={hyperliquidFlowEnabled}
          size={size}
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

      <section className={styles.feeSummary} aria-labelledby="fee-summary-title">
        <h3 id="fee-summary-title">Fee summary</h3>
        {(preview?.fees ?? []).map((row) => (
          <div className={styles.summaryRow} key={row.label}>
            <span>{row.label}</span>
            <strong>${row.value}</strong>
          </div>
        ))}
        <div className={`${styles.summaryRow} ${styles.totalRow}`}>
          <span>Estimated total</span>
          <strong>{preview ? `$${preview.totalFee.value}` : "Unavailable"}</strong>
        </div>
      </section>

      {executionReview ? (
        <ExecutionReviewPanel
          review={executionReview}
          preview={preview}
          submission={submission}
          confirming={confirming}
          onRetryObservation={onRetryObservation}
        />
      ) : null}

      {selectedDomain !== "hyperliquid" ? <div className={styles.actionArea}>
        <button
          className={styles.secondaryAction}
          type="button"
          disabled={prepareDisabled || actionBusy}
          onClick={onPrepareExecution}
        >
          {executionReview ? "Refresh Devnet review" : "Prepare Devnet review"}
        </button>
        <button
          className={styles.primaryAction}
          type="button"
          disabled={actionDisabled || actionBusy}
          aria-describedby="execution-note"
          onClick={onExecutionAction}
        >
          {confirming ? "Confirm in wallet" : actionBusy ? "Preparing Devnet review" : actionLabel}
        </button>
        <p id="execution-note" role="status">
          {actionReason}
        </p>
      </div> : null}
    </aside>
  );
}

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
}) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("positions");
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

  return (
    <section className={`${styles.panel} ${styles.bottomWorkspace}`} aria-label="Trading workspace">
      <div className={styles.workspaceTabs} role="tablist" aria-label="Account data">
        {snapshot.workspaces.map((workspace) => (
          <button
            id={`tab-${workspace.tab}`}
            key={workspace.tab}
            type="button"
            role="tab"
            aria-selected={activeTab === workspace.tab}
            aria-controls={`panel-${workspace.tab}`}
            className={activeTab === workspace.tab ? styles.workspaceTabActive : undefined}
            onClick={() => setActiveTab(workspace.tab)}
          >
            {workspace.label}
            {workspace.count !== undefined ? <span>{workspace.count}</span> : null}
          </button>
        ))}
        <div className={styles.workspaceStatus}>
          <span className={providerConnection === "connected" ? styles.statusDot : styles.offlineDot} />
          {providerLabel}
        </div>
      </div>

      <div
        id={`panel-${activeWorkspace.tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${activeWorkspace.tab}`}
        className={styles.tableScroller}
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
          <p className={styles.lifecycleUnavailable} role="status">
            Durable lifecycle is temporarily unavailable.
            <button type="button" className={styles.inlineRetry} onClick={onRetryLifecycle}>
              Retry lifecycle
            </button>
          </p>
        ) : null}
        {showReceipts && lifecycleLoading && !lifecycle ? (
          <p className={styles.receiptsNote} role="status">Loading durable lifecycle receipts.</p>
        ) : null}
        {showNetworkEvidence && submission ? (
          <p className={styles.networkEvidence} role="status">
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
        <table className={styles.workspaceTable}>
          <thead>
            <tr>
              {activeWorkspace.columns.map((column) => (
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
                  <td className={styles.receiptsCell} title={receipt.receiptHashHex}>
                    {compact(receipt.receiptHashHex, 10, 8)}
                  </td>
                  <td className={styles.receiptsCell} title={receipt.domain.domainManifestHashHex}>
                    {receipt.domain.domainId}
                  </td>
                  <td className={styles.receiptsCell}>
                    {receipt.priorState ?? "START"} &gt; {receipt.nextState}
                  </td>
                  <td className={`${styles.receiptsCell} ${styles.receiptsCellNumeric}`}>
                    {receipt.revision}
                  </td>
                  <td className={styles.receiptsCell}>{receipt.evidenceGrade}</td>
                  <td className={styles.receiptsCell}>
                    {receipt.onchainEnforced ? "Onchain" : "Controller"}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={activeWorkspace.columns.length}>
                  <div className={styles.emptyState}>
                    <span className={styles.emptyGlyph} aria-hidden="true" />
                    <div>
                      <strong>{activeWorkspace.emptyTitle}</strong>
                      <p>{activeWorkspace.emptyDetail}</p>
                    </div>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function TradingTerminal({
  initialSnapshot,
  initialPreview,
  privateApiBaseUrl,
}: {
  initialSnapshot: TerminalViewModel;
  initialPreview: TerminalPreview;
  privateApiBaseUrl: string | null;
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
    return { disabled: false, label: "Sign and submit on Devnet", reason: "The wallet will show the exact reviewed Devnet transaction before signing." };
  }, [
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
      if (currentExecutionReview && Date.now() - currentExecutionReview.preparedAt > 45_000) {
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

  return (
    <main className={styles.terminalShell}>
      <TopNavigation
        snapshot={snapshot}
        selectedDomain={selectedDomain}
        providerConnection={providerConnection}
        wallet={wallet}
        evmWallet={evmWallet}
        onDomainChange={(domain) => {
          setSelectedDomain(domain);
          if (privateProvider) {
            setProviderConnection("connecting");
          }
        }}
      />
      <div className={styles.domainContext} role="status">
        <span>{selectedDomainModel?.label}</span>
        <span>{selectedDomainModel?.runtime}</span>
        <span>{selectedRuntimeHealth?.available ? "Testnet execution available" : `${selectedDomainModel?.state} data only`}</span>
      </div>
      <MarketHeader snapshot={snapshot} />
      <ExecutionReadiness
        snapshot={snapshot}
        selectedDomain={selectedDomain}
        providerConnection={providerConnection}
        runtimeHealth={runtimeHealth}
        lifecycle={displayedLifecycle}
        hasService={privateProvider !== null}
        onSelect={(domain) => {
          setSelectedDomain(domain);
          if (privateProvider) {
            setProviderConnection("connecting");
          }
        }}
      />
      <div className={styles.contentGrid}>
        <div className={styles.marketWorkspace}>
          <BasisChart snapshot={snapshot} />
          <PackageSequence snapshot={snapshot} mode={mode} preview={preview} />
        </div>
        <Ticket
          snapshot={snapshot}
          selectedDomain={selectedDomain}
          mode={mode}
          preview={preview}
          size={size}
          slippage={slippage}
          quoteMode={quoteMode}
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
      />
    </main>
  );
}
