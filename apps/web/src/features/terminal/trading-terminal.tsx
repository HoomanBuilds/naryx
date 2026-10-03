"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { encodeFunctionData, erc20Abi, formatEther, parseAbi } from "viem";
import { fixtureMarketFeed } from "./market-feed";
import { usePublicMarketFeed } from "./public-market-feed";
import { useReferenceMarketFeed } from "./reference-market-feed";
import { handleTablistKeys, usePersistedSetting } from "./persisted-setting";
import { ChartWorkspace } from "./pro/chart-workspace";
import { InstrumentBar } from "./pro/instrument-bar";
import { OrderBook } from "./pro/order-book";
import { StatusBar } from "./pro/status-bar";
import { localConformanceTerminalProvider } from "./local-conformance-provider";
import { useArbitrumSepoliaExit } from "./arbitrum-sepolia-exit";
import { ArbitrumObservationError, TerminalMarketUnavailableError, TerminalPreviewRejectedError, unavailableTerminalSnapshot } from "./private-http-terminal-provider";
import type {
  ArbitrumAccountStatus,
  ArbitrumAsyncObservation,
  ArbitrumOrderRecord,
  ArbitrumOwnerAuthorization,
  ArbitrumSelectedAttempt,
  ArbitrumSolverQuote,
  BaseAccountStatus,
  BaseAtomicObservation,
  BaseAtomicPreparation,
  BaseOrderRecord,
  BaseSelectedAttempt,
  BaseSolverQuote,
  HyperliquidAccountStatus,
  HyperliquidAttemptProgress,
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
  SolanaExecutionObservation,
} from "./private-http-terminal-provider";
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
import { DOMAIN_META, EXIT_UNAVAILABLE, domainHealth, domainLive, useTerminal } from "./shell/terminal-context";
import { EVM_CHAINS, type EvmDomain } from "@/features/wallet/evm-config";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import { shortAddress, useWalletModal } from "@/features/wallet/wallet-modal";
import { AssetIcon, ChainIcon, chainOf } from "@/features/brand/chain-icons";
import { solanaDevnetSizeAtoms, solanaDevnetSizeFromAtoms, useSolanaDevnetOnboarding } from "./solana-devnet-onboarding";
import { usePositions } from "./pages/use-positions";
import styles from "./trading-terminal.module.css";

/** How long a prepared Devnet review stays signable. */
const REVIEW_TTL_MS = 45_000;
const SLIPPAGE_OPTIONS: readonly SlippageBps[] = [5, 10, 25];

/** "0.100000000000000000" becomes "0.1"; a whole number is kept as is. */
function trimSize(value: string) {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/**
 * A tenth, a quarter, a half, and all of the lane's default size, rounded down to its decimals, so
 * every preset is denominated in the selected lane's own base asset.
 */
function sizePresets(defaultSize: string): string[] {
  const [whole, fraction = ""] = defaultSize.split(".");
  const scale = BigInt(10) ** BigInt(fraction.length);
  const atoms = BigInt(`${whole}${fraction}`);
  const presets = [10, 4, 2, 1].map((divisor) => {
    const value = atoms / BigInt(divisor);
    const decimals = (value % scale).toString().padStart(fraction.length, "0");
    return trimSize(fraction.length === 0 ? value.toString() : `${value / scale}.${decimals}`);
  });
  return presets.filter((preset, index) => preset !== "0" && presets.indexOf(preset) === index);
}

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
  /** The connected wallet that owns and signs the package; Naryx's testnet account executes it. */
  owner: string | null;
  context: HyperliquidTestnetContext | null;
  /** The wallet's packages in the shared account, from the service ledger (any device). */
  account: HyperliquidAccountStatus | null;
  order: HyperliquidOrderCreateResponse | null;
  quote: HyperliquidSolverQuote | null;
  attempt: HyperliquidSelectedAttempt | null;
  /** One key per handoff, so a retry or a status check never starts a second execution. */
  executeKey: string;
  signed: boolean;
  progress: HyperliquidAttemptProgress | null;
  execution: HyperliquidTerminalExecutionResult | null;
  busy: string | null;
  error: string | null;
};

const HYPERLIQUID_ACTIVE_PACKAGE_STATES = new Set(["PENDING_ENTRY", "OPEN", "EXITING", "UNRESOLVED"]);

function hyperliquidProgressLabel(progress: HyperliquidAttemptProgress | null): string | null {
  if (progress === null) return null;
  if (progress.state === "QUEUED") {
    return progress.queuePosition === 0 ? "Queued, next in line" : `Queued, ${progress.queuePosition} ahead`;
  }
  if (progress.state === "EXECUTING") return "Executing";
  if (progress.state === "UNCERTAIN") return "Awaiting the executor record";
  return null;
}

type BaseFlowState = {
  ticketKey: string;
  /** The connected wallet the factory account belongs to; a different wallet starts over. */
  owner: string;
  account: BaseAccountStatus | null;
  order: BaseOrderRecord | null;
  quote: BaseSolverQuote | null;
  attempt: BaseSelectedAttempt | null;
  /** One key binds the authorization, the prepared call, and its observation. */
  idempotencyKey: string;
  preparation: BaseAtomicPreparation | null;
  transactionHash: string | null;
  observation: BaseAtomicObservation | null;
  /** A wallet setup transaction sent and not yet reflected in the account status. */
  pendingSetup: Readonly<{ kind: string; hash: string; sentAt: number }> | null;
  busy: string | null;
  error: string | null;
};

type BaseStep = "setup" | "create" | "quote" | "select" | "execute" | "withdraw";

const BASE_SETUP_TIMEOUT_MS = 180_000;

function isBaseObservationTerminal(observation: BaseAtomicObservation | null): boolean {
  return observation?.lifecycle === "FINALIZED" || observation?.lifecycle === "REVERTED" ||
    observation?.lifecycle === "EVIDENCE_MISMATCH";
}

function quoteMarginAtoms(quote: BaseSolverQuote | null): string | undefined {
  const margin = quote?.quote.expectedMarginDelta as Record<string, unknown> | undefined;
  const atoms = protocolScalar(margin?.atoms);
  return /^(0|[1-9][0-9]*)$/.test(atoms) ? atoms : undefined;
}

/** Integer atoms as a plain decimal string, the form the ticket and Activity page record sizes in. */
function atomsDecimal(atoms: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(atoms)) return "-";
  const padded = atoms.padStart(decimals + 1, "0");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return `${padded.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

function quoteAtomsText(atoms: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(atoms)) return "-";
  const padded = atoms.padStart(decimals + 1, "0");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return `${padded.slice(0, -decimals)}${fraction ? `.${fraction}` : ""} USDC`;
}

type ArbitrumFlowState = {
  ticketKey: string;
  /** The connected wallet the factory account belongs to; a different wallet starts over. */
  owner: string;
  account: ArbitrumAccountStatus | null;
  /** The account creation transaction sent and not yet reflected in the account status. */
  accountTx: Readonly<{ hash: string; sentAt: number }> | null;
  order: ArbitrumOrderRecord | null;
  quote: ArbitrumSolverQuote | null;
  attempt: ArbitrumSelectedAttempt | null;
  /** One key binds every observation of this attempt. */
  idempotencyKey: string;
  /** The reviewed reservation; `signed` once the service recorded the owner's signature. */
  authorization: ArbitrumOwnerAuthorization | null;
  approveHash: string | null;
  approved: boolean;
  fundHash: string | null;
  funded: boolean;
  reclaimHash: string | null;
  reclaimed: boolean;
  observation: ArbitrumAsyncObservation | null;
  observationNote: string | null;
  busy: string | null;
  error: string | null;
};

type ArbitrumStep = "account" | "create" | "quote" | "select" | "prepare" | "sign" | "approve" | "fund" | "reclaim" | "restart";

/** The Arbitrum Sepolia order context; a live service snapshot names it, otherwise this configured id. */
const ARBITRUM_CONTEXT_ID = /^[A-Za-z0-9:_.-]{1,128}$/.test(process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_CONTEXT_ID ?? "")
  ? process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_CONTEXT_ID as string
  : "arbitrum-sepolia:eth-usdc:gmx";
const ARBITRUM_RECLAIM_ABI = parseAbi(["function reclaimExpiredFunding(bytes32 packageId)"]);
const ARBITRUM_TERMINAL_LIFECYCLES: ReadonlySet<string> = new Set([
  "EXECUTED", "CANCELLED", "FROZEN", "RECOVERED", "MANUAL_INTERVENTION", "CLOSED", "CONFLICT", "EVIDENCE_MISMATCH",
]);

function isArbitrumObservationTerminal(observation: ArbitrumAsyncObservation | null): boolean {
  return observation !== null && ARBITRUM_TERMINAL_LIFECYCLES.has(observation.lifecycle);
}

/** No coordinator reservation exists yet, so funded collateral is still reclaimable after the deadline. */
function isArbitrumUnreserved(observation: ArbitrumAsyncObservation | null): boolean {
  return observation === null || observation.lifecycle === "NOT_FOUND";
}

function unixTimeText(seconds: string): string {
  if (!/^(0|[1-9][0-9]{0,11})$/.test(seconds)) return seconds;
  return new Date(Number(seconds) * 1000).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function remainingText(deadlineSeconds: string, nowMs: number): string {
  const left = Number(deadlineSeconds) - Math.floor(nowMs / 1000);
  if (!Number.isFinite(left) || left <= 0) return "passed";
  const minutes = Math.floor(left / 60);
  return minutes > 0 ? `${minutes}m ${left % 60}s left` : `${left}s left`;
}

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

function assetAmountsText(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "none";
  return value.map(assetAmountText).join(", ");
}

/**
 * Every fee and gas estimate the solver signed, each in its own asset and on the chain the quote
 * names. Amounts in different assets are listed, never summed.
 */
function QuoteFees({ quote }: { quote: LocalSolverQuote }) {
  const terms = quote.quote;
  const domain = terms.domain as Record<string, unknown> | undefined;
  const chain = typeof domain?.domainId === "string" ? domain.domainId : "-";
  return (
    <div className={styles.reviewGrid} aria-label="Fees and gas">
      <span>Fee chain</span><strong>{chain}</strong>
      <span>Venue fees</span><strong>{assetAmountsText(terms.expectedNormalizedVenueFeesByAsset)}</strong>
      <span>Raw fill fees</span><strong>{assetAmountsText(terms.expectedRawFillFeesByAsset)}</strong>
      <span>Builder fees</span><strong>{assetAmountsText(terms.expectedBuilderFeesByAsset)}</strong>
      <span>Base-asset fee</span><strong>{assetAmountText(terms.expectedBaseAssetFee)}</strong>
      <span>Solver fee</span><strong>{assetAmountText(terms.solverFee)}</strong>
      <span>Protocol fee</span><strong>{assetAmountText(terms.protocolFee)}</strong>
      <span>Network fee on {chain}</span><strong>{assetAmountText(terms.expectedPriorityFee)} (priority fee or gas estimate)</strong>
      <span>Recovery cost cap</span><strong>{assetAmountsText(terms.maxRecoveryCostAtomsByAsset)}</strong>
      <span>Fee policy</span><strong title={protocolScalar(terms.feePolicyManifestHash)}>v{protocolScalar(terms.feePolicyVersion)} / {compact(protocolScalar(terms.feePolicyManifestHash))}</strong>
    </div>
  );
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
      <span>Quote mode</span><strong>{quoteMode === "FIRM_SIMULATED" ? "FIRM_SIMULATED (non-production reservation)" : quoteMode === "FIRM_BONDED" ? "FIRM_BONDED (reservation plus performance bond)" : quoteMode}</strong>
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
          <span>Quote hash</span><strong title={quote.quoteHash}>{compact(quote.quoteHash, 12, 10)}</strong>
          <span>Route hash</span><strong title={quote.routeHash}>{compact(quote.routeHash, 12, 10)}</strong>
          <span>Solver digest</span><strong title={quote.solverSignatureDigest}>{compact(quote.solverSignatureDigest, 12, 10)}</strong>
          <span>Quote bytes</span><strong>{quote.solverQuoteBytes.length / 2} B</strong>
          <span>Route bytes</span><strong>{quote.routeBytes.length / 2} B</strong>
        </div>
      ) : null}
      {quote ? <QuoteTerms quote={quote} /> : null}
      {quote ? <QuoteFees quote={quote} /> : null}
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

/** What the Hyperliquid testnet order binds at each step; the ticket's primary action advances it. */
function HyperliquidTestnetPanel({
  flow,
  size,
  baseSymbol,
  slippage,
}: {
  flow: HyperliquidFlowState | null;
  size: string;
  /** The ticket's base asset, the unit the size was entered in. */
  baseSymbol: string;
  slippage: SlippageBps;
}) {
  const context = flow?.context ?? null;
  const order = flow?.order?.order ?? null;
  const quote = flow?.quote ?? null;
  const attempt = flow?.attempt ?? null;
  const execution = flow?.execution ?? null;
  const progress = hyperliquidProgressLabel(flow?.progress ?? null);
  const packages = flow?.account?.packages ?? [];
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
        <span>{execution?.status ?? progress?.toUpperCase() ?? (attempt ? "SELECTED" : quote ? "QUOTE REVIEW" : order ? "ORDER CREATED" : context ? "READY" : "DISCOVERING")}</span>
      </div>
      <p className={styles.reviewNotice}>
        Executed in Naryx&apos;s Hyperliquid testnet account on your behalf. Your wallet owns the package and signs its
        authorization; the shared trading account below holds and settles it, one package at a time.
      </p>
      {context ? (
        <div className={styles.reviewGrid}>
          <span>Owner (your wallet)</span><strong title={flow?.owner ?? undefined}>{flow?.owner ? compact(flow.owner, 10, 8) : "Not connected"}</strong>
          <span>Trading account</span><strong title={context.tradingAccount}>{compact(context.tradingAccount, 10, 8)}</strong>
          <span>Context</span><strong title={context.contextId}>{context.contextId}</strong>
          <span>Domain</span><strong>{context.domain.domainId}</strong>
          <span>Manifest</span><strong title={context.domain.domainManifestHash}>v{context.domain.domainManifestVersion} / {compact(context.domain.domainManifestHash)}</strong>
          <span>Environment</span><strong>{context.environment}</strong>
          <span>Authorization</span><strong>Owner wallet signature</strong>
          <span>Open packages</span><strong>{packages.filter((entry) => HYPERLIQUID_ACTIVE_PACKAGE_STATES.has(entry.state)).length}{context.maxOpenPackagesPerOwner === null ? "" : ` of ${context.maxOpenPackagesPerOwner}`}</strong>
          <span>Requested size</span><strong>{size} {baseSymbol}</strong>
          <span>Slippage limit</span><strong>{slippage} bps</strong>
        </div>
      ) : null}
      {packages.length > 0 ? (
        <div className={styles.reviewGrid}>
          {packages.slice(0, 4).map((entry) => (
            <Fragment key={entry.entryAttemptId}>
              <span title={entry.entryAttemptId}>Package {compact(entry.entryAttemptId, 20, 6)}</span>
              <strong>{entry.state}{entry.perpQuantityAtoms === null ? "" : ` / short ${entry.perpQuantityAtoms} atoms`}</strong>
            </Fragment>
          ))}
        </div>
      ) : null}
      {order ? (
        <div className={styles.reviewGrid}>
          <span>Order hash</span><strong title={order.orderHashHex}>{compact(order.orderHashHex, 12, 10)}</strong>
          <span>Canonical bytes</span><strong>{order.orderBytes.length} B</strong>
          <span>Owner</span><strong title={order.owner}>{compact(order.owner, 10, 8)}</strong>
          <span>Settlement account</span><strong title={order.settlementAccount}>{compact(order.settlementAccount, 10, 8)}</strong>
          <span>Action</span><strong>{flow?.order?.note.startsWith("Exit") ? "Exit the whole package" : "Enter package"}</strong>
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
        </div>
      ) : null}
      {quote ? <QuoteTerms quote={quote} /> : null}
      {quote ? <QuoteFees quote={quote} /> : null}
      {attempt ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Selected Testnet attempt</span>
          <strong title={attempt.attemptId}>{compact(attempt.attemptId, 20, 12)}</strong>
          <small>{flow?.signed ? "Signed by your wallet." : "Your wallet signs the package authorization before execution."}{progress ? ` ${progress}.` : ""}</small>
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

/** The owner's factory account, the signed quote, and the single atomic transaction it settles in. */
function BaseSepoliaPanel({ flow }: { flow: BaseFlowState | null }) {
  const account = flow?.account ?? null;
  const quote = flow?.quote ?? null;
  const observation = flow?.observation ?? null;
  const decimals = account?.quoteDecimals ?? 6;
  const outcome = quote?.quote.quotedOutcome as Record<string, unknown> | undefined;
  const exitOutcome = outcome?.kind === "EXIT_QUOTE_OUTCOME"
    ? protocolScalar((outcome.exitQuoteOutcome as Record<string, unknown> | undefined)?.atoms)
    : null;
  return (
    <section className={styles.executionReview} aria-labelledby="base-execution-title">
      <div className={styles.evidenceHeading}>
        <h3 id="base-execution-title">Base Sepolia package</h3>
        <span>{observation?.lifecycle ?? (flow?.transactionHash ? "SUBMITTED" : flow?.attempt ? "SELECTED" : quote ? "QUOTE REVIEW" : flow?.order ? "ORDER CREATED" : account ? "ACCOUNT READY" : "LOADING")}</span>
      </div>
      <p className={styles.reviewNotice}>
        Testnet only. Your wallet signs every step: account setup transactions, the package permit, and the one transaction that settles both legs or neither.
      </p>
      {account ? (
        <div className={styles.reviewGrid}>
          <span>Strategy account</span><strong title={account.account}>{compact(account.account, 10, 8)}{account.deployed ? "" : " (not created)"}</strong>
          <span>Owner</span><strong title={account.owner}>{compact(account.owner, 10, 8)}</strong>
          <span>Wallet USDC</span><strong>{quoteAtomsText(account.walletQuoteAtoms, decimals)}</strong>
          <span>Account USDC</span><strong>{quoteAtomsText(account.accountQuoteAtoms, decimals)}</strong>
          <span>Perp margin reserve</span><strong>{quoteAtomsText(account.reserveAtoms, decimals)}</strong>
          {flow?.order ? <><span>Spot quote cap</span><strong>{quoteAtomsText(account.requiredSpotQuoteAtoms, decimals)}</strong></> : null}
          {quote ? <><span>Quoted margin</span><strong>{quoteAtomsText(account.requiredMarginAtoms, decimals)}</strong></> : null}
          {account.steps.length > 0 ? <><span>Setup needed</span><strong>{account.steps.map((step) => step.label).join("; ")}</strong></> : null}
          {account.openPackage ? <><span>Open package</span><strong>{atomsDecimal(account.openPackage.baseQuantityAtoms, 18)} base, {account.openPackage.packageSizeUnits} units</strong></> : null}
          {account.openPackage ? <><span>Entry receipt</span><strong title={account.openPackage.entryReceiptHash}>{compact(account.openPackage.entryReceiptHash, 12, 10)}</strong></> : null}
          {exitOutcome ? <><span>Quoted exit outcome</span><strong>{quoteAtomsText(exitOutcome, decimals)}</strong></> : null}
          {account.withdrawals.length > 0 ? <><span>Withdrawals</span><strong>{account.withdrawals.map((step) => step.label).join("; ")}</strong></> : null}
        </div>
      ) : null}
      {flow?.order ? (
        <div className={styles.reviewGrid}>
          <span>Order hash</span><strong title={flow.order.orderHashHex}>{compact(flow.order.orderHashHex, 12, 10)}</strong>
          <span>Settlement account</span><strong title={flow.order.settlementAccount}>{compact(flow.order.settlementAccount, 10, 8)}</strong>
        </div>
      ) : null}
      {quote ? <QuoteTerms quote={quote} /> : null}
      {quote ? <QuoteFees quote={quote} /> : null}
      {flow?.attempt ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Selected attempt</span>
          <strong title={flow.attempt.attemptId}>{compact(flow.attempt.attemptId, 20, 12)}</strong>
        </div>
      ) : null}
      {flow?.transactionHash ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Package transaction</span>
          <strong title={flow.transactionHash}>{compact(flow.transactionHash, 14, 12)}</strong>
          <small>
            {observation
              ? `${observation.lifecycle.replace(/_/g, " ").toLowerCase()}${observation.blockNumber ? ` at block ${observation.blockNumber}` : ""}; evidence ${observation.evidenceGrade}.${observation.reason ? ` ${observation.reason}` : ""}`
              : "Waiting for the first observation."}
          </small>
          {observation?.receiptHash ? <small title={observation.receiptHash}>Receipt: {compact(observation.receiptHash, 14, 12)}</small> : null}
        </div>
      ) : null}
    </section>
  );
}

/** The owner's factory account, the signed quote, the reviewed bonded reservation, and its funding. */
function ArbitrumSepoliaPanel({ flow, nowMs }: { flow: ArbitrumFlowState; nowMs: number }) {
  const account = flow.account;
  const quote = flow.quote;
  const authorization = flow.authorization;
  const observation = flow.observation;
  const funding = authorization?.funding ?? null;
  const transactions: readonly (readonly [string, string | null, boolean])[] = [
    ["Account creation", flow.accountTx?.hash ?? null, account?.deployed === true],
    ["USDC approval", flow.approveHash, flow.approved],
    ["Request funding", flow.fundHash, flow.funded],
    ["Funding reclaim", flow.reclaimHash, flow.reclaimed],
  ];
  return (
    <section className={styles.executionReview} aria-labelledby="arbitrum-execution-title">
      <div className={styles.evidenceHeading}>
        <h3 id="arbitrum-execution-title">Arbitrum Sepolia package</h3>
        <span>{observation?.lifecycle ?? (flow.funded ? "FUNDED" : authorization?.signed ? "SIGNED" : authorization ? "RESERVATION REVIEW" : flow.attempt ? "SELECTED" : quote ? "QUOTE REVIEW" : flow.order ? "ORDER CREATED" : account ? "ACCOUNT READY" : "LOADING")}</span>
      </div>
      <p className={styles.reviewNotice}>
        Testnet only. Your wallet performs every step as a separate, labeled Arbitrum Sepolia action: account creation, the reservation signature, the USDC approval, and the funding transaction that pays the GMX execution fee. A bonded solver then executes asynchronously.
      </p>
      {account ? (
        <div className={styles.reviewGrid}>
          <span>Strategy account</span><strong title={account.account}>{compact(account.account, 10, 8)}{account.deployed ? "" : " (not created)"}</strong>
          <span>Owner</span><strong title={account.owner}>{compact(account.owner, 10, 8)}</strong>
          <span>Account factory</span><strong title={account.accountFactory}>{compact(account.accountFactory, 10, 8)}</strong>
        </div>
      ) : null}
      {flow.order ? (
        <div className={styles.reviewGrid}>
          <span>Order hash</span><strong title={flow.order.orderHashHex}>{compact(flow.order.orderHashHex, 12, 10)}</strong>
          <span>Context</span><strong title={flow.order.contextId}>{flow.order.contextId}</strong>
          <span>Settlement account</span><strong title={flow.order.settlementAccount}>{compact(flow.order.settlementAccount, 10, 8)}</strong>
        </div>
      ) : null}
      {quote ? <QuoteTerms quote={quote} /> : null}
      {quote ? <QuoteFees quote={quote} /> : null}
      {flow.attempt ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Selected attempt</span>
          <strong title={flow.attempt.attemptId}>{compact(flow.attempt.attemptId, 20, 12)}</strong>
        </div>
      ) : null}
      {authorization && funding ? (
        <div className={styles.reviewGrid}>
          <span>Package id</span><strong title={authorization.packageId}>{compact(authorization.packageId, 12, 10)}</strong>
          <span>Reservation</span><strong>{authorization.signed ? "Signed by your wallet" : "Awaiting your signature"}</strong>
          <span>Reservation digest</span><strong title={authorization.digest}>{compact(authorization.digest, 12, 10)}</strong>
          <span>Coordinator</span><strong title={authorization.coordinator}>{compact(authorization.coordinator, 10, 8)}</strong>
          <span>Solver</span><strong title={authorization.summary.solver}>{compact(authorization.summary.solver, 10, 8)}</strong>
          <span>Solver bond</span><strong>{authorization.summary.bondAtoms} atoms</strong>
          <span>Perp size delta (raw USD)</span><strong title={authorization.summary.sizeDeltaUsd}>{compact(authorization.summary.sizeDeltaUsd, 10, 6)}</strong>
          <span>Acceptable price (raw)</span><strong title={authorization.summary.acceptablePrice}>{compact(authorization.summary.acceptablePrice, 10, 6)}</strong>
          <span>Spot base</span><strong>{authorization.summary.spotBaseAtoms} atoms</strong>
          <span>Rollback minimum quote</span><strong>{authorization.summary.rollbackMinQuoteAtoms} atoms</strong>
          <span>Collateral token</span><strong title={funding.token}>{compact(funding.token, 10, 8)}</strong>
          <span>Approve to adapter</span><strong title={funding.spender}>{funding.approveAtoms} atoms to {compact(funding.spender, 8, 6)}</strong>
          <span>Collateral / spot quote</span><strong>{funding.collateralAtoms} / {funding.spotQuoteAtoms} atoms</strong>
          <span>GMX execution fee</span><strong>{formatEther(BigInt(funding.executionFeeWei))} ETH</strong>
          <span>Fund before</span><strong>{unixTimeText(funding.reclaimAfterUnixSeconds)} ({remainingText(funding.reclaimAfterUnixSeconds, nowMs)})</strong>
          <span>Venue deadline</span><strong>{unixTimeText(authorization.summary.venueDeadline)}</strong>
          <span>Recovery deadline</span><strong>{unixTimeText(authorization.summary.recoveryDeadline)}</strong>
        </div>
      ) : null}
      {transactions.filter(([, hash]) => hash !== null).map(([label, hash, confirmed]) => (
        <div className={styles.submissionReceipt} role="status" key={label}>
          <span>{label}</span>
          <strong title={hash ?? undefined}>{compact(hash ?? "", 14, 12)}</strong>
          <small>{confirmed ? "Confirmed on Arbitrum Sepolia." : "Waiting for confirmation."}</small>
        </div>
      ))}
      {flow.funded ? (
        <div className={styles.submissionReceipt} role="status">
          <span>Async execution</span>
          <strong>{observation ? observation.lifecycle.replace(/_/g, " ").toLowerCase() : "pending reservation"}</strong>
          <small>
            {observation
              ? `Evidence ${observation.evidenceGrade}${observation.coordinator ? `; coordinator ${observation.coordinator.state.toLowerCase()} (v${observation.coordinator.stateVersion})` : ""}${observation.entry ? `; entry ${observation.entry.status.toLowerCase()}` : ""}.${observation.reason ? ` ${observation.reason}` : ""}`
              : flow.observationNote ?? "Waiting for the first observation."}
          </small>
        </div>
      ) : null}
    </section>
  );
}

export type PrimaryAction = Readonly<{
  kind: "connect" | "switch" | "prepare" | "sign" | "solana-onboard" | "hyperliquid" | "base" | "arbitrum" | "arbitrum-exit" | "none";
  label: string;
  reason: string;
  disabled: boolean;
}>;

function Ticket({
  snapshot,
  selectedDomain,
  mode,
  preview,
  previewRejection,
  size,
  slippage,
  quoteMode,
  account,
  localFlow,
  localFlowEnabled,
  conformanceMode,
  localCanSignMessage,
  hyperliquidFlow,
  baseFlow,
  arbitrumFlow,
  arbitrumExitPanel,
  nowMs,
  executionReview,
  submission,
  confirming,
  action,
  actionBusy,
  canRefreshReview,
  onModeChange,
  onSizeChange,
  onSlippageChange,
  onQuoteModeChange,
  onLocalStep,
  onPrimaryAction,
  onRefreshReview,
  onRetryObservation,
}: {
  snapshot: TerminalViewModel;
  selectedDomain: DomainId;
  mode: PackageMode;
  preview: TerminalPreview | null;
  /** The service's reason for refusing the ticket's size or slippage, if it did. */
  previewRejection: string | null;
  size: string;
  slippage: SlippageBps;
  quoteMode: QuoteMode;
  account: string | null;
  localFlow: LocalFlowState | null;
  localFlowEnabled: boolean;
  /** The service runs the local Phase 4 fixture runtime; its step-by-step lifecycle is local-only. */
  conformanceMode: boolean;
  localCanSignMessage: boolean;
  hyperliquidFlow: HyperliquidFlowState | null;
  baseFlow: BaseFlowState | null;
  arbitrumFlow: ArbitrumFlowState | null;
  /** The Arbitrum exit review, present only in exit mode. */
  arbitrumExitPanel: ReactNode;
  nowMs: number;
  executionReview: ExecutionReview | null;
  submission: SubmissionState | null;
  confirming: boolean;
  action: PrimaryAction;
  actionBusy: boolean;
  canRefreshReview: boolean;
  onModeChange: (mode: PackageMode) => void;
  onSizeChange: (size: string) => void;
  onSlippageChange: (slippage: SlippageBps) => void;
  onQuoteModeChange: (quoteMode: QuoteMode) => void;
  onLocalStep: (step: "create" | "authorize" | "quote" | "select" | LocalExecutionAction) => void;
  onPrimaryAction: () => void;
  onRefreshReview: () => void;
  onRetryObservation: () => void;
}) {
  const plan = snapshot.plans.find((item) => item.mode === mode) ?? snapshot.plans[0];
  const legs = preview?.mode === mode ? preview.legs : plan.legs;
  const meta = DOMAIN_META[selectedDomain];
  const hyperliquidStage = hyperliquidFlow?.execution
    ? "executed"
    : hyperliquidFlow?.attempt ? "selected" : hyperliquidFlow?.quote ? "quote" : hyperliquidFlow?.order ? "order" : "idle";
  const conformanceState = localFlow?.lifecycle?.attempt.state ??
    (localFlow?.attempt ? "SELECTED" : localFlow?.quote ? "QUOTE REVIEW" : localFlow?.order ? "UNSIGNED" : null);

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

      <div className={styles.ticketRow}>
        <span>Account</span>
        <span className={styles.ticketAccount} title={account ?? undefined}>
          <ChainIcon chain={selectedDomain} size={13} />
          {selectedDomain === "hyperliquid" ? (account ? `${account} via Naryx testnet account` : "Not connected") : account ?? "Not connected"}
        </span>
      </div>

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
          <span className={styles.symbolChip}>
            <AssetIcon symbol={snapshot.ticket.sizeSymbol} size={14} />
            {snapshot.ticket.sizeSymbol}
          </span>
          <span id="size-context">
            <span key={preview?.bound.value ?? "none"} className={styles.flash}>
              {preview ? `${preview.bound.label} ${usd(preview.bound.value)}` : previewRejection ?? "Bound unavailable"}
            </span>
          </span>
        </div>
      </div>

      <div className={styles.presets} role="group" aria-label="Size presets">
        {sizePresets(snapshot.ticket.defaultSize).map((preset) => (
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
            <span className={styles.legMark} title={`Leg ${leg.sequence}: ${leg.instrument} on ${chainOf(leg.venue)?.name ?? leg.venue}`}>
              <AssetIcon symbol={leg.instrument.split(/[\s/-]/)[0] ?? leg.instrument} size={24} />
              <ChainIcon chain={leg.venue} size={12} className={styles.legChain} />
            </span>
            <div>
              <strong className={/buy/i.test(leg.action) ? styles.upText : styles.downText}>
                <span className={styles.legSeq}>{leg.sequence}</span>
                {leg.action}
              </strong>
              <small>{leg.instrument} / {leg.venue}</small>
            </div>
            <div className={styles.legNumbers}>
              <strong>{tidy(leg.quantity)}</strong>
              <small title={`${leg.limitLabel} ${leg.limit}`}>{/max/i.test(leg.limitLabel) ? "max" : "min"} {tidy(leg.limit)}</small>
            </div>
          </li>
        ))}
      </ol>

      <div className={styles.actionArea}>
        <button
          className={action.kind === "connect" || action.kind === "switch" ? styles.connectCta : styles.primaryCta}
          type="button"
          disabled={action.disabled || actionBusy}
          aria-describedby="execution-note"
          onClick={onPrimaryAction}
        >
          {confirming ? "Confirm in wallet" : actionBusy ? "Working" : action.label}
        </button>
        <p id="execution-note" role="status">
          {action.reason}
          {canRefreshReview ? (
            <button type="button" className={styles.inlineRetry} disabled={actionBusy} onClick={onRefreshReview}>
              Refresh review
            </button>
          ) : null}
        </p>
      </div>

      {executionReview ? (
        <ExecutionReviewPanel
          review={executionReview}
          preview={preview}
          submission={submission}
          confirming={confirming}
          onRetryObservation={onRetryObservation}
        />
      ) : null}

      <section className={styles.summaryCard} aria-labelledby="fee-summary-title">
        <h3 id="fee-summary-title" className={styles.visuallyHidden}>Order summary</h3>
        <div className={styles.summaryRow}>
          <span title="Estimated from the current mid price and your slippage. The binding limit is set from the pool's executable quote for this exact size when the order is created.">
            {mode === "entry" ? "Maximum quote (est.)" : "Minimum output (est.)"}
          </span>
          <strong key={preview?.bound.value ?? "none"} className={styles.flash}>{preview ? usd(preview.bound.value) : "Unavailable"}</strong>
        </div>
        <details className={styles.feeDetails}>
          <summary className={styles.summaryRow}>
            <span>Estimated fees</span>
            <strong key={preview?.totalFee.value ?? "none"} className={styles.flash}>{preview ? usd(preview.totalFee.value) : "Unavailable"}</strong>
          </summary>
          {(preview?.fees ?? []).map((row) => (
            <div className={`${styles.summaryRow} ${styles.summaryNested}`} key={row.label}>
              <span>{row.label}</span>
              <strong>{usd(row.value)}</strong>
            </div>
          ))}
        </details>
        <div className={styles.summaryRow} title={SETTLEMENT_GUARANTEE[meta.settlementClass]}>
          <span>Settlement</span>
          <strong>{meta.settlement}</strong>
        </div>
        <div className={styles.summaryRow} title="Marketable limit, exact all legs: the only package order policy the initial activation accepts. Every other type, time in force, or partial-fill policy is rejected before authorization.">
          <span>Order</span>
          <strong>Limit, {meta.settlementClass === "ATOMIC_POSTCONDITION" ? "FOK" : "IOC"}, all legs</strong>
        </div>
      </section>

      <details className={styles.flowDetails}>
        <summary>
          <span>Package details</span>
          <span className={styles.fixtureText}>{preview?.evidenceGrade ?? snapshot.environment.evidenceGrade}</span>
        </summary>
        <dl className={styles.ticketFacts}>
          <div><dt>Package</dt><dd title={snapshot.market.packageId}>{snapshot.market.packageId}</dd></div>
          <div><dt>Settlement class</dt><dd title={SETTLEMENT_GUARANTEE[meta.settlementClass]}>{meta.settlementClass}</dd></div>
          {snapshot.ticket.evidence.map((row) => (
            <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>
          ))}
        </dl>
        <p className={styles.summaryNote}>
          {preview?.evidenceGrade === "OBSERVED_UNATTESTED"
            ? `${preview.bound.symbol} estimate from observed books, captured ${preview.capturedAt}.`
            : preview ? "USDC conformance estimate." : "No live estimate is available."} Balances are on the Portfolio page.
        </p>
      </details>

      {selectedDomain === "hyperliquid" ? (
        <details
          key={`hyperliquid-${hyperliquidStage}`}
          className={styles.flowDetails}
          open={hyperliquidStage === "quote" || hyperliquidStage === "executed"}
        >
          <summary>
            <span>Testnet order review</span>
            <span className={styles.chipNeutral}>{hyperliquidFlow?.execution?.status ?? hyperliquidStage.toUpperCase()}</span>
          </summary>
          <HyperliquidTestnetPanel
            flow={hyperliquidFlow}
            size={size}
            baseSymbol={snapshot.market.base}
            slippage={slippage}
          />
        </details>
      ) : selectedDomain === "base" && baseFlow ? (
        <details className={styles.flowDetails} open={baseFlow.quote !== null}>
          <summary>
            <span>Testnet package review</span>
            <span className={styles.chipNeutral}>{baseFlow.observation?.lifecycle ?? (baseFlow.attempt ? "SELECTED" : baseFlow.quote ? "QUOTE" : baseFlow.order ? "ORDER" : "ACCOUNT")}</span>
          </summary>
          <BaseSepoliaPanel flow={baseFlow} />
        </details>
      ) : selectedDomain === "arbitrum" && arbitrumExitPanel ? (
        arbitrumExitPanel
      ) : selectedDomain === "arbitrum" && arbitrumFlow ? (
        <details className={styles.flowDetails} open={arbitrumFlow.quote !== null}>
          <summary>
            <span>Testnet package review</span>
            <span className={styles.chipNeutral}>{arbitrumFlow.observation?.lifecycle ?? (arbitrumFlow.funded ? "FUNDED" : arbitrumFlow.authorization ? "RESERVATION" : arbitrumFlow.attempt ? "SELECTED" : arbitrumFlow.quote ? "QUOTE" : arbitrumFlow.order ? "ORDER" : "ACCOUNT")}</span>
          </summary>
          <ArbitrumSepoliaPanel flow={arbitrumFlow} nowMs={nowMs} />
        </details>
      ) : selectedDomain === "solana" && conformanceMode ? (
        <details className={styles.flowDetails}>
          <summary>
            <span>Local conformance lifecycle</span>
            <span className={styles.chipNeutral}>{conformanceState ?? "READY"}</span>
          </summary>
          <LocalExecutionPanel
            flow={localFlow}
            enabled={localFlowEnabled}
            canSignMessage={localCanSignMessage}
            onStep={onLocalStep}
          />
        </details>
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
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
}) {
  const activeWorkspace =
    snapshot.workspaces.find((workspace) => workspace.tab === activeTab) ??
    snapshot.workspaces[0];
  const showReceipts = activeWorkspace.tab === "receipts";
  const showNetworkEvidence = showReceipts && submission !== null;
  const needsRetry = showNetworkEvidence && submission !== null &&
    submission.observationUnavailable && !isObservationTerminal(submission.observation);

  return (
    <section id="terminal-workspace" className={styles.bottomWorkspace} aria-label="Orders and positions">
      <div className={styles.workspaceTabs} role="tablist" aria-label="Orders and positions" onKeyDown={handleTablistKeys}>
        {snapshot.workspaces.map((workspace) => {
          const count = workspace.tab === "receipts" && lifecycle ? lifecycle.receipts.length : workspace.count;
          return (
            <button
              id={`tab-${workspace.tab}`}
              key={workspace.tab}
              type="button"
              role="tab"
              aria-selected={activeWorkspace.tab === workspace.tab}
              aria-controls={`panel-${workspace.tab}`}
              className={activeWorkspace.tab === workspace.tab ? styles.workspaceTabActive : undefined}
              onClick={() => onTabChange(workspace.tab)}
            >
              {workspace.label}
              {count !== undefined ? <span>({count})</span> : null}
            </button>
          );
        })}
        <div className={styles.workspaceStatus}>
          <i className={providerConnection === "connected" ? styles.dotLive : styles.dotIdle} aria-hidden="true" />
          {providerConnection === "connected" ? "Service connected" : providerConnection === "connecting" ? "Connecting" : "Local fixture"}
        </div>
      </div>

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
                    <span className={styles.chainCell}>
                      <ChainIcon chain={receipt.domain.domainId} size={14} />
                      {receipt.domain.domainId}
                    </span>
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
    </section>
  );
}

export function TradingTerminal({
  initialSnapshot,
  initialPreview,
}: {
  initialSnapshot: TerminalViewModel;
  initialPreview: TerminalPreview;
}) {
  const {
    selectedDomain,
    privateProvider,
    runtimeHealth,
    privateApiBaseUrl,
    publicApiBaseUrl,
    packageMarketId,
    recordAttempt,
  } = useTerminal();
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [snapshotDomain, setSnapshotDomain] = useState<DomainId>(initialSnapshot.selectedDomain);
  // With a configured service the ticket waits for its preview instead of showing the local one.
  const [preview, setPreview] = useState<TerminalPreview | null>(privateProvider ? null : initialPreview);
  const [previewRejection, setPreviewRejection] = useState<string | null>(null);
  // A preview belongs to the lane it was fetched for: switching lanes clears it at once instead of
  // showing the previous lane's bound and fees until the new lane's preview arrives.
  const [previewDomain, setPreviewDomain] = useState(selectedDomain);
  if (previewDomain !== selectedDomain) {
    setPreviewDomain(selectedDomain);
    setPreview(null);
    setPreviewRejection(null);
  }
  const [mode, setMode] = useState<PackageMode>("entry");
  // Portfolio's Exit button opens this page with ?mode=exit; the page is static, so read it once here.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("mode") !== "exit") return;
    const timer = window.setTimeout(() => setMode("exit"), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const [size, setSize] = useState(initialSnapshot.ticket.defaultSize);
  const [slippage, setSlippage] = useState<SlippageBps>(
    initialSnapshot.ticket.defaultSlippageBps,
  );
  const [quoteMode, setQuoteMode] = useState<QuoteMode>("coordinated_limits");
  const [workspaceTab, setWorkspaceTab] = usePersistedSetting<WorkspaceTab>(
    "workspace.tab",
    "positions",
    ["positions", "orders", "history", "receipts"],
  );
  // With a private API the chart shows its recorded reference history; the fixture is only for the
  // local terminal without one.
  const reference = useReferenceMarketFeed(privateApiBaseUrl, selectedDomain, snapshot.market);
  const fixtureFeed = useMemo(() => fixtureMarketFeed(snapshot), [snapshot]);
  const { feed, status: publicFeedStatus } = usePublicMarketFeed(
    publicApiBaseUrl,
    packageMarketId,
    reference.feed ?? fixtureFeed,
    reference.feed,
  );
  const feedStatus = publicFeedStatus ?? reference.status;
  const wallet = useSolanaWallet();
  const evmWallet = useEvmWallet();
  const walletModal = useWalletModal();
  const [localFlow, setLocalFlow] = useState<LocalFlowState | null>(null);
  const [hyperliquidFlow, setHyperliquidFlow] = useState<HyperliquidFlowState | null>(null);
  const [baseFlow, setBaseFlow] = useState<BaseFlowState | null>(null);
  const [arbitrumFlow, setArbitrumFlow] = useState<ArbitrumFlowState | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
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
  // A Devnet exit closes the whole open package, so its size comes from the service's exit order.
  const [solanaExitSize, setSolanaExitSize] = useState<{ key: string; size: string } | null>(null);
  const [idempotency, setIdempotency] = useState<{
    ticketKey: string;
    key: string;
  } | null>(null);
  const [loadedConnection, setProviderConnection] = useState<ProviderConnection>(
    privateProvider ? "connecting" : "disconnected",
  );
  // A chain switch is "connecting" until the service answers for the new chain.
  const providerConnection: ProviderConnection = privateProvider && snapshotDomain !== selectedDomain
    ? "connecting"
    : loadedConnection;

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
  const hyperliquidOwner = selectedDomain === "hyperliquid" && evmWallet.account ? evmWallet.account.toLowerCase() : null;
  const currentHyperliquidFlow = hyperliquidFlow?.ticketKey === ticketKey && hyperliquidFlow.owner === hyperliquidOwner
    ? hyperliquidFlow
    : null;
  const currentBaseFlow = baseFlow?.ticketKey === ticketKey && baseFlow.owner === evmWallet.account
    ? baseFlow
    : null;
  // An exit closes the whole open package, so on every lane the ticket shows that package's size:
  // Base from its flow's chain read, every lane from the same open-package reads Portfolio shows.
  const baseOpenPackage = currentBaseFlow?.account?.openPackage ?? null;
  const { positions: openPositions } = usePositions();
  const laneOpenPosition = openPositions.find((position) => position.domain === selectedDomain
    && (position.state === "Open" || position.state === "Exiting") && position.exactSize !== null);
  const openPackageExitSize = mode !== "exit" ? null
    : selectedDomain === "base" && baseOpenPackage !== null ? atomsDecimal(baseOpenPackage.baseQuantityAtoms, 18)
      : laneOpenPosition?.exactSize ?? null;
  useEffect(() => {
    if (openPackageExitSize !== null && openPackageExitSize !== size) setSize(openPackageExitSize);
  }, [openPackageExitSize, size]);
  // Once funding is sent the flow outlives ticket edits, so the reclaim path is never lost.
  const currentArbitrumFlow = arbitrumFlow !== null && arbitrumFlow.owner === evmWallet.account &&
    (arbitrumFlow.ticketKey === ticketKey || (selectedDomain === "arbitrum" && arbitrumFlow.fundHash !== null))
    ? arbitrumFlow
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
          setSnapshotDomain(selectedDomain);
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
          setSnapshotDomain(selectedDomain);
          // Each lane sizes in its own base asset, so a newly loaded lane starts from its own default.
          setSize(trimSize(serviceSnapshot.ticket.defaultSize));
          setProviderConnection("connected");
        }
      } catch (cause) {
        if (controller.signal.aborted) {
          return;
        }
        // A configured service that fails shows the domain's market as unavailable; neither fixture
        // data nor another domain's numbers are kept. A 503 market answer keeps the service connected.
        if (active) {
          setSnapshot((previous) => unavailableTerminalSnapshot(previous, selectedDomain));
          setSnapshotDomain(selectedDomain);
          setProviderConnection(cause instanceof TerminalMarketUnavailableError ? "connected" : "disconnected");
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
    if (!privateProvider || selectedDomain !== "hyperliquid" ||
        providerConnection !== "connected" || !runtimeHealth?.hyperliquidTestnet.available) return;
    const controller = new AbortController();
    let active = true;
    const fresh = (
      context: HyperliquidTestnetContext | null,
      account: HyperliquidAccountStatus | null,
      error: string | null,
    ): HyperliquidFlowState => ({
      ticketKey,
      owner: hyperliquidOwner,
      context,
      account,
      order: null,
      quote: null,
      attempt: null,
      executeKey: crypto.randomUUID(),
      signed: false,
      progress: null,
      execution: null,
      busy: null,
      error,
    });
    privateProvider.getHyperliquidTestnetContext(controller.signal)
      .then(async (context) => {
        // The ledger lists the wallet's packages, so an open package can be exited from any device.
        const account = hyperliquidOwner === null ? null
          : await privateProvider.getHyperliquidAccount(context, hyperliquidOwner, controller.signal).catch(() => null);
        if (!active) return;
        setHyperliquidFlow(fresh(context, account, null));
      })
      .catch((cause) => {
        if (!active || controller.signal.aborted) return;
        setHyperliquidFlow(fresh(null, null, cause instanceof Error ? cause.message : "Hyperliquid context discovery failed."));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [hyperliquidOwner, privateProvider, providerConnection, runtimeHealth?.hyperliquidTestnet.available, selectedDomain, ticketKey]);

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
          setPreviewRejection(null);
          if (privateProvider) {
            setProviderConnection("connected");
          }
        }
      } catch (cause) {
        if (controller.signal.aborted) {
          return;
        }
        if (active) {
          setPreview(null);
          // A refused size or slippage is the service answering, so it stays connected and says why.
          const rejected = cause instanceof TerminalPreviewRejectedError;
          setPreviewRejection(rejected ? cause.message : null);
          if (privateProvider && !rejected && !(cause instanceof TerminalMarketUnavailableError)) {
            setProviderConnection("disconnected");
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
  const selectedRuntimeHealth = domainHealth(selectedDomain, runtimeHealth);

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

  const conformanceMode = runtimeHealth?.controls.localAtomicRuntimeMode === "PHASE4_FIXTURE";
  const executionGateUp = runtimeHealth?.controls.executionReadinessAvailable === true;
  const localFlowEnabled = conformanceMode && selectedDomain === "solana" && mode === "entry" &&
    privateProvider !== null && providerConnection === "connected" &&
    wallet.selectedAccount !== null && preview?.source === "PRIVATE_TERMINAL_BFF" &&
    quoteMode === "coordinated_limits";
  // An exit is priced by the service from the live books for the wallet's own open package.
  const hyperliquidFlowEnabled = selectedDomain === "hyperliquid" &&
    privateProvider !== null && providerConnection === "connected" &&
    runtimeHealth?.hyperliquidTestnet.available === true && executionGateUp &&
    (mode === "exit" || preview?.source === "PRIVATE_TERMINAL_BFF") && quoteMode === "coordinated_limits";
  const hyperliquidPackages = currentHyperliquidFlow?.account?.packages ?? [];
  const hyperliquidOpenPackage = hyperliquidPackages.find((entry) => entry.state === "OPEN") ?? null;
  const hyperliquidActivePackages = hyperliquidPackages.filter((entry) => HYPERLIQUID_ACTIVE_PACKAGE_STATES.has(entry.state)).length;
  const hyperliquidLimit = currentHyperliquidFlow?.context?.maxOpenPackagesPerOwner ?? null;
  const evmTarget: EvmDomain | null = selectedDomain === "base" || selectedDomain === "arbitrum" ? selectedDomain : null;
  const evmOnTarget = evmTarget !== null && evmWallet.onChain(evmTarget);
  // A Base exit closes the whole open package read from chain, so it needs no ticket preview.
  const baseFlowEnabled = selectedDomain === "base" &&
    privateProvider !== null && providerConnection === "connected" &&
    runtimeHealth?.baseTestnetAtomic.available === true && executionGateUp &&
    (mode === "exit" || preview?.source === "PRIVATE_TERMINAL_BFF") && quoteMode === "coordinated_limits";
  const baseOwner = baseFlowEnabled && evmTarget === "base" && evmOnTarget ? evmWallet.account : null;
  const baseSetupSteps = currentBaseFlow?.account?.steps ?? [];
  // Once the package is closed, by this exit or an earlier one, only owner withdrawals remain.
  const baseExitClosed = mode === "exit" && currentBaseFlow?.account != null && currentBaseFlow.account.openPackage === null &&
    (!currentBaseFlow.transactionHash || currentBaseFlow.observation?.lifecycle === "FINALIZED");
  const nextBaseStep: BaseStep | null = !currentBaseFlow?.account || currentBaseFlow.pendingSetup
    ? null
    : baseExitClosed ? (currentBaseFlow.account.withdrawals.length > 0 ? "withdraw" : null)
    : currentBaseFlow.transactionHash ? null
    : mode === "exit"
      ? !currentBaseFlow.order ? "create" : !currentBaseFlow.quote ? "quote" : !currentBaseFlow.attempt ? "select" : "execute"
    : baseSetupSteps.some((step) => step.kind === "CREATE_ACCOUNT") ? "setup"
    : !currentBaseFlow.order ? "create"
    : !currentBaseFlow.quote ? "quote"
    : baseSetupSteps.length > 0 ? "setup"
    : !currentBaseFlow.attempt ? "select"
    : "execute";
  const arbitrumFlowEnabled = selectedDomain === "arbitrum" && mode === "entry" &&
    privateProvider !== null && providerConnection === "connected" &&
    domainLive("arbitrum", runtimeHealth) && quoteMode === "coordinated_limits";
  const arbitrumOwner = arbitrumFlowEnabled && evmTarget === "arbitrum" && evmOnTarget ? evmWallet.account : null;
  const arbitrumContextId = snapshotDomain === "arbitrum" && preview?.source === "PRIVATE_TERMINAL_BFF"
    ? snapshot.market.packageId
    : ARBITRUM_CONTEXT_ID;
  const arbitrumExitEnabled = selectedDomain === "arbitrum" && mode === "exit" &&
    privateProvider !== null && providerConnection === "connected" &&
    domainLive("arbitrum", runtimeHealth) && quoteMode === "coordinated_limits";
  const evmSignTypedData = evmWallet.signTypedData;
  const signArbitrumExit = useCallback((typedData: unknown) => evmSignTypedData("arbitrum", typedData), [evmSignTypedData]);
  const recordArbitrumExit = useCallback((attemptId: string, exitSize: string, owner: string) => {
    recordAttempt({ attemptId, owner, domain: "arbitrum", mode: "exit", size: exitSize, flow: "arbitrum", createdAt: Date.now() });
  }, [recordAttempt]);
  const arbitrumExit = useArbitrumSepoliaExit({
    enabled: arbitrumExitEnabled && evmOnTarget,
    owner: evmWallet.account,
    provider: privateProvider,
    contextId: arbitrumContextId,
    slippageBps: slippage,
    signTypedData: signArbitrumExit,
    onSelected: recordArbitrumExit,
  });
  const arbitrumFunding = currentArbitrumFlow?.authorization?.funding ?? null;
  const arbitrumWindowClosed = arbitrumFunding !== null &&
    Math.floor(nowMs / 1000) >= Number(arbitrumFunding.reclaimAfterUnixSeconds);
  const nextArbitrumStep: ArbitrumStep | null = (() => {
    const flow = currentArbitrumFlow;
    if (!flow?.account || flow.accountTx) return null;
    if (!flow.account.deployed) return "account";
    if (!flow.order) return "create";
    if (!flow.quote) return "quote";
    if (!flow.attempt) return "select";
    if (!flow.authorization) return "prepare";
    if (!flow.funded) {
      if (flow.fundHash) return "fund";
      if (arbitrumWindowClosed) return "restart";
      if (!flow.authorization.signed) return "sign";
      return flow.approved ? "fund" : "approve";
    }
    if (flow.reclaimed) return null;
    if (flow.reclaimHash) return "reclaim";
    return arbitrumWindowClosed && isArbitrumUnreserved(flow.observation) ? "reclaim" : null;
  })();
  const nextHyperliquidStep: "create" | "quote" | "select" | "execute" | null = !currentHyperliquidFlow?.context || currentHyperliquidFlow.execution
    ? null
    : !currentHyperliquidFlow.order ? "create"
    : !currentHyperliquidFlow.quote ? "quote"
    : !currentHyperliquidFlow.attempt ? "select"
    : "execute";

  // Devnet entry needs the wallet's own strategy accounts; missing ones are created step by step first.
  const readSolanaDevnetAccount = useCallback((owner: string, sizeAtoms: string, signal?: AbortSignal) => {
    if (!privateProvider) return Promise.reject(new Error("Private service required."));
    return privateProvider.getSolanaDevnetAccountStatus(owner, sizeAtoms, signal);
  }, [privateProvider]);
  const solanaOnboarding = useSolanaDevnetOnboarding({
    enabled: selectedDomain === "solana" && mode === "entry" && privateProvider !== null &&
      providerConnection === "connected" && runtimeHealth?.solanaDevnet.available === true,
    owner: wallet.selectedAccount?.address ?? null,
    sizeAtoms: solanaDevnetSizeAtoms(size),
    readStatus: readSolanaDevnetAccount,
    signAndSend: wallet.signAndSend,
  });

  // One primary action, in the order every venue uses: connect, switch network, then trade.
  const primaryAction = useMemo<PrimaryAction>(() => {
    const none = (label: string, reason: string): PrimaryAction => ({ kind: "none", label, reason, disabled: true });
    if (selectedDomain === "solana" && !wallet.selectedAccount) {
      return { kind: "connect", label: "Connect wallet", reason: "Connect a Solana wallet to review and sign on Devnet.", disabled: false };
    }
    if (evmTarget) {
      if (!evmWallet.account) {
        return { kind: "connect", label: "Connect wallet", reason: `Connect an EVM wallet to trade on ${EVM_CHAINS[evmTarget].name}.`, disabled: false };
      }
      if (!evmOnTarget) {
        return { kind: "switch", label: `Switch to ${EVM_CHAINS[evmTarget].name}`, reason: "Your wallet is on a different network.", disabled: evmWallet.switching };
      }
      if (evmTarget === "base" && baseFlowEnabled) {
        const flow = currentBaseFlow;
        if (!flow?.account) {
          return none("Loading strategy account", flow?.error ?? "Reading your Base Sepolia strategy account from chain.");
        }
        if (flow.pendingSetup) {
          return none("Confirming setup", `Waiting for the ${flow.pendingSetup.kind.replace(/_/g, " ").toLowerCase()} transaction to land on Base Sepolia.`);
        }
        if (nextBaseStep === "withdraw") {
          const withdrawal = flow.account.withdrawals[0];
          if (withdrawal) return { kind: "base", label: withdrawal.label, reason: flow.error ?? "A testnet transaction your wallet signs on your own strategy account to return settled funds after the exit. Nothing trades.", disabled: false };
        }
        if (mode === "exit" && !flow.transactionHash && !flow.account.openPackage) {
          return none("No open package", "This wallet's strategy account has no open package on Base Sepolia, so there is nothing to exit.");
        }
        if (mode === "entry" && !flow.transactionHash && flow.account.openPackage) {
          return none("Package already open", "Your strategy account holds one open package. Exit it before entering another.");
        }
        if (flow.transactionHash) {
          const lifecycle = flow.observation?.lifecycle;
          if (lifecycle === "FINALIZED") return none("Package finalized", "Both legs settled in one finalized Base Sepolia transaction. The receipt is in the package review.");
          if (lifecycle === "REVERTED") return none("Transaction reverted", flow.observation?.reason ?? "The package transaction reverted, so neither leg settled.");
          if (lifecycle === "EVIDENCE_MISMATCH") return none("Evidence mismatch", flow.observation?.reason ?? "The observed receipt does not match the signed package.");
          return none(lifecycle === "CONFIRMED" ? "Confirmed, awaiting finality" : "Transaction submitted", flow.error ?? "Observing the package transaction on Base Sepolia.");
        }
        const reason = flow.error;
        const setup = flow.account.steps[0];
        if (nextBaseStep === "setup" && setup) {
          if (setup.kind === "FUND_ACCOUNT" && !flow.account.fundingCovered) {
            return none("Insufficient testnet USDC", "Your wallet does not hold enough Base Sepolia USDC to fund the strategy account for this package. Claim free test USDC on the Portfolio page.");
          }
          return { kind: "base", label: setup.label, reason: reason ?? "A testnet wallet transaction that sets up your own strategy account. Nothing trades yet.", disabled: false };
        }
        if (nextBaseStep === "create" && mode === "exit") return { kind: "base", label: "Create exit order", reason: reason ?? "Creates the canonical exit order for your open package. Its size, entry receipt, and minimums come from chain.", disabled: false };
        if (nextBaseStep === "create") return { kind: "base", label: "Create order", reason: reason ?? "Creates the canonical package order for your strategy account.", disabled: false };
        if (nextBaseStep === "quote") return { kind: "base", label: "Request quote", reason: reason ?? "Asks the solver for a signed quote priced from the live pool and oracle.", disabled: false };
        if (nextBaseStep === "select") return { kind: "base", label: "Accept quote", reason: reason ?? "Review the signed terms and fees in the package review before accepting.", disabled: false };
        if (nextBaseStep === "execute") return { kind: "base", label: "Sign and submit", reason: reason ?? "Your wallet signs the package permit, then submits the one transaction that settles both legs or neither.", disabled: false };
      }
      if (evmTarget === "arbitrum" && arbitrumExitEnabled) return arbitrumExit.action;
      if (evmTarget === "arbitrum" && arbitrumFlowEnabled) {
        const flow = currentArbitrumFlow;
        if (!flow?.account) {
          return none("Loading strategy account", flow?.error ?? "Reading your Arbitrum Sepolia strategy account from chain.");
        }
        if (flow.accountTx) {
          return none("Confirming account", "Waiting for the account creation transaction to land on Arbitrum Sepolia.");
        }
        const reason = flow.error;
        const funding = flow.authorization?.funding ?? null;
        const deadline = funding ? `Fund before ${unixTimeText(funding.reclaimAfterUnixSeconds)} (${remainingText(funding.reclaimAfterUnixSeconds, nowMs)}).` : "";
        switch (nextArbitrumStep) {
          case "account":
            return { kind: "arbitrum", label: "Create strategy account", reason: reason ?? "Testnet transaction on Arbitrum Sepolia: your wallet calls the account factory to create your own strategy account. Nothing trades yet.", disabled: false };
          case "create":
            return { kind: "arbitrum", label: "Create order", reason: reason ?? "Creates the canonical package order for your strategy account.", disabled: false };
          case "quote":
            return { kind: "arbitrum", label: "Request quote", reason: reason ?? "Asks the bonded solver for a signed quote on the whole package.", disabled: false };
          case "select":
            return { kind: "arbitrum", label: "Accept quote", reason: reason ?? "Review the signed terms and fees in the package review before accepting.", disabled: false };
          case "prepare":
            return { kind: "arbitrum", label: "Review reservation", reason: reason ?? "Prepares the bonded reservation and the exact funding for your review. Nothing is signed or sent.", disabled: false };
          case "sign":
            return { kind: "arbitrum", label: "Sign reservation", reason: reason ?? `Your wallet signs the reviewed reservation (EIP-712 message, no transaction). ${deadline}`, disabled: false };
          case "approve":
            return { kind: "arbitrum", label: flow.approveHash ? "Confirm approval" : "Approve USDC (testnet tx)", reason: reason ?? `Testnet transaction: approve the adapter to pull exactly ${funding?.approveAtoms ?? "-"} token atoms. ${deadline}`, disabled: false };
          case "fund":
            return { kind: "arbitrum", label: flow.fundHash ? "Confirm funding" : "Fund request (testnet tx)", reason: reason ?? `Testnet transaction: the adapter pulls the approved collateral and your wallet pays the ${funding ? formatEther(BigInt(funding.executionFeeWei)) : "-"} ETH GMX execution fee. ${deadline}`, disabled: false };
          case "reclaim":
            return { kind: "arbitrum", label: flow.reclaimHash ? "Confirm reclaim" : "Reclaim funding (testnet tx)", reason: reason ?? "The funding deadline passed without a reservation. This testnet transaction returns your collateral and execution fee from the adapter.", disabled: false };
          case "restart":
            return { kind: "arbitrum", label: "Start a fresh order", reason: reason ?? "The funding window closed before funding, so nothing was pulled from your wallet. Create a fresh order to re-quote.", disabled: false };
          default:
            break;
        }
        if (flow.reclaimed) return none("Funding reclaimed", "The unreserved funding returned to your wallet. Start a new order to trade again.");
        const lifecycle = flow.observation?.lifecycle;
        if (lifecycle === "EXECUTED") return none("Entry executed", "The bonded solver executed the package entry on Arbitrum Sepolia. Evidence is in the package review and on the Activity page.");
        if (lifecycle && isArbitrumObservationTerminal(flow.observation)) {
          return none(`Package ${lifecycle.replace(/_/g, " ").toLowerCase()}`, flow.observation?.reason ?? "The asynchronous package reached a terminal state. Evidence is in the package review.");
        }
        return none(lifecycle ? `Package ${lifecycle.replace(/_/g, " ").toLowerCase()}` : "Funded, awaiting reservation", reason ?? flow.observationNote ?? "Observing the asynchronous package on Arbitrum Sepolia.");
      }
      return none(
        `${EVM_CHAINS[evmTarget].name} not open`,
        evmTarget === "base" && runtimeHealth?.baseTestnetAtomic.available === true
          ? !executionGateUp
            ? "The service's execution safety gate is not configured, so no testnet package can run."
            : mode !== "entry"
              ? "Exit runs from an open package."
              : quoteMode !== "coordinated_limits"
                ? "Testnet execution uses coordinated limits."
                : "A current service preview is required."
          : evmTarget === "arbitrum" && domainLive("arbitrum", runtimeHealth)
            ? quoteMode !== "coordinated_limits"
              ? "Testnet execution uses coordinated limits."
              : "The private terminal service is not connected."
            : "Package contracts are not deployed on this testnet yet. The package, quotes, and fees shown are a preview.",
      );
    }
    if (selectedDomain === "hyperliquid") {
      if (!hyperliquidFlowEnabled) {
        return none(
          "Hyperliquid testnet not open",
          !privateProvider || providerConnection !== "connected"
            ? "Hyperliquid testnet orders need the private terminal service."
            : !runtimeHealth?.hyperliquidTestnet.available
              ? "Hyperliquid testnet execution is disabled in the service configuration."
              : !executionGateUp
                ? "The service's execution safety gate is not configured, so no testnet order can run."
                : quoteMode !== "coordinated_limits"
                  ? "Testnet execution uses coordinated limits."
                  : "A current service preview is required.",
        );
      }
      if (!hyperliquidOwner) {
        return { kind: "connect", label: "Connect wallet", reason: "Connect an EVM wallet. It owns and signs each package; Naryx's Hyperliquid testnet account executes it, so no Hyperliquid funds are needed.", disabled: false };
      }
      const progress = hyperliquidProgressLabel(currentHyperliquidFlow?.progress ?? null);
      if (currentHyperliquidFlow?.busy === "execute" && progress) {
        return none(progress, "Executed in Naryx's Hyperliquid testnet account on your behalf; the account runs one package at a time.");
      }
      if (currentHyperliquidFlow?.execution) {
        const execution = currentHyperliquidFlow.execution;
        const filled = execution.packageStatus === "COMPLETED_EXACT" || execution.packageStatus === "COMPLETED_BOUNDED";
        return none(
          filled ? (mode === "exit" ? "Package exited" : "Package filled") : `Executed: ${execution.status.replace(/_/g, " ").toLowerCase()}`,
          filled && mode === "entry"
            ? "Held for your wallet in Naryx's Hyperliquid testnet account. Switch to Exit package to close it from any device."
            : "The result and its evidence are in the testnet order review below and on the Activity page.",
        );
      }
      if (!currentHyperliquidFlow?.context) {
        return none("Preparing testnet account", currentHyperliquidFlow?.error ?? "Discovering the active Hyperliquid testnet order context.");
      }
      const reason = currentHyperliquidFlow.error;
      if (nextHyperliquidStep === "create" && mode === "exit" && !hyperliquidOpenPackage) {
        return none("No open package", reason ?? "This wallet has no open Hyperliquid testnet package to exit.");
      }
      if (nextHyperliquidStep === "create" && mode === "entry" && hyperliquidLimit !== null && hyperliquidActivePackages >= hyperliquidLimit) {
        return none("Package limit reached", reason ?? "Exit your open Hyperliquid testnet package before entering another.");
      }
      if (nextHyperliquidStep === "create") {
        return mode === "exit"
          ? { kind: "hyperliquid", label: "Create exit order", reason: reason ?? "Prices the exit of your open package from the live books: its exact spot and its exact short.", disabled: false }
          : { kind: "hyperliquid", label: "Create order", reason: reason ?? "Creates the canonical package order owned by your wallet.", disabled: false };
      }
      if (nextHyperliquidStep === "quote") return { kind: "hyperliquid", label: "Request quote", reason: reason ?? "Asks the solver for a signed quote on the whole package.", disabled: false };
      if (nextHyperliquidStep === "select") return { kind: "hyperliquid", label: "Accept quote", reason: reason ?? "Review the signed terms and fees in the testnet order review before accepting.", disabled: false };
      return { kind: "hyperliquid", label: currentHyperliquidFlow.signed ? "Execute on testnet" : "Sign and execute", reason: reason ?? "Your wallet signs the package authorization; Naryx's Hyperliquid testnet account executes it on your behalf.", disabled: false };
    }
    const exitUnavailable = EXIT_UNAVAILABLE[selectedDomain];
    if (mode === "exit" && exitUnavailable !== undefined) return none("Exit not available yet", exitUnavailable);
    if (!privateProvider || providerConnection !== "connected") {
      return { kind: "none", disabled: true, label: "Private service required", reason: "Connect the private terminal service before preparing execution." };
    }
    if (!runtimeHealth?.solanaDevnet.available) {
      return { kind: "none", disabled: true, label: "Devnet runtime unavailable", reason: "The private service is connected, but its Solana Devnet execution runtime is not active." };
    }
    if (!executionGateUp) {
      return { kind: "none", disabled: true, label: "Execution gate offline", reason: "The service's execution safety gate is not configured, so no Devnet transaction can be prepared." };
    }
    if (!wallet.canSignAndSendV0 || !wallet.canSignMessage) {
      return { kind: "none", disabled: true, label: "Wallet capability unavailable", reason: "The selected wallet must advertise Devnet v0 sign-and-send and message signing to authorize the package order." };
    }
    if (!preview || preview.source !== "PRIVATE_TERMINAL_BFF") {
      return { kind: "none", disabled: true, label: "Executable preview required", reason: "A current private-service package preview is required." };
    }
    if (quoteMode !== "coordinated_limits") {
      return { kind: "none", disabled: true, label: "Coordinated limits required", reason: "Devnet execution requires the coordinated-limits quote mode." };
    }
    if (currentSubmission) {
      const observation = currentSubmission.observation;
      if (observation?.lifecycle === "FINALIZED") {
        return {
          kind: "none",
          disabled: true,
          label: "Transaction finalized",
          reason: `Finalized on Solana Devnet at slot ${observation.finalizedSlot.toLocaleString()}. Network finality only. This does not mean the package completed.`,
        };
      }
      if (observation?.lifecycle === "FAILED") {
        return {
          kind: "none",
          disabled: true,
          label: "Transaction failed",
          reason: observation.failedSlot === null
            ? `Failed on Solana Devnet with code ${observation.failureCode}. The transaction did not finalize.`
            : `Failed on Solana Devnet with code ${observation.failureCode} at slot ${observation.failedSlot.toLocaleString()}. The transaction did not finalize.`,
        };
      }
      if (observation?.lifecycle === "EXPIRED") {
        return {
          kind: "none",
          disabled: true,
          label: "Transaction expired",
          reason: `Expired before finality on Solana Devnet. Last valid block height ${observation.lastValidBlockHeight.toLocaleString()}, observed ${observation.observedBlockHeight.toLocaleString()}. The transaction did not finalize.`,
        };
      }
      if (currentSubmission.observationUnavailable) {
        return { kind: "none", disabled: true, label: "Transaction submitted", reason: "Observation temporarily unavailable. The transaction was submitted and network state is unknown. Use Retry observation." };
      }
      if (observation?.lifecycle === "SUBMITTED" && observation.observedSlot !== null) {
        return { kind: "none", disabled: true, label: "Transaction submitted", reason: `Submitted to Solana Devnet and observed at slot ${observation.observedSlot.toLocaleString()}. Waiting for finality. Submission does not assert package completion.` };
      }
      return { kind: "none", disabled: true, label: "Transaction submitted", reason: "Observation is pending. Submission does not assert finality or package completion." };
    }
    if (mode === "entry" && !solanaOnboarding.ready) {
      const remaining = solanaOnboarding.status?.steps.length ?? 0;
      if (solanaOnboarding.busy) {
        return { kind: "solana-onboard", label: solanaOnboarding.busy, reason: "Account setup is in progress. Each step is finalized on Devnet before the next one.", disabled: true };
      }
      if (solanaOnboarding.nextStep) {
        return {
          kind: "solana-onboard",
          label: solanaOnboarding.nextStep.label,
          reason: solanaOnboarding.error ??
            `Account setup, ${remaining} ${remaining === 1 ? "step" : "steps"} left. Your wallet signs one Devnet transaction for your own accounts before the package review.`,
          disabled: false,
        };
      }
      if (solanaOnboarding.error) {
        return { kind: "solana-onboard", label: "Retry account check", reason: solanaOnboarding.error, disabled: false };
      }
      return none("Checking Devnet account", "Reading your strategy, position, and collateral accounts on Devnet.");
    }
    if (!currentExecutionReview) {
      return { kind: "prepare", label: "Review transaction", reason: "Builds the exact unsigned Devnet transaction for you to review before signing.", disabled: false };
    }
    if (reviewExpired) {
      return { kind: "prepare", label: "Refresh review", reason: "The review is older than 45 seconds. Refresh it before signing.", disabled: false };
    }
    return { kind: "sign", label: "Sign and submit", reason: "Your wallet shows the exact reviewed Devnet transaction before signing.", disabled: false };
  }, [
    arbitrumExit.action,
    arbitrumExitEnabled,
    arbitrumFlowEnabled,
    baseFlowEnabled,
    currentArbitrumFlow,
    currentBaseFlow,
    currentExecutionReview,
    currentHyperliquidFlow,
    currentSubmission,
    evmOnTarget,
    evmTarget,
    evmWallet.account,
    evmWallet.switching,
    executionGateUp,
    hyperliquidActivePackages,
    hyperliquidFlowEnabled,
    hyperliquidLimit,
    hyperliquidOpenPackage,
    hyperliquidOwner,
    mode,
    nextArbitrumStep,
    nextBaseStep,
    nextHyperliquidStep,
    nowMs,
    preview,
    privateProvider,
    providerConnection,
    quoteMode,
    reviewExpired,
    runtimeHealth,
    selectedDomain,
    solanaOnboarding.busy,
    solanaOnboarding.error,
    solanaOnboarding.nextStep,
    solanaOnboarding.ready,
    solanaOnboarding.status,
    wallet.canSignAndSendV0,
    wallet.canSignMessage,
    wallet.selectedAccount,
  ]);

  async function prepareExecution(
    currentIdempotencyKey: string,
    exitSize?: string,
  ): Promise<SolanaExecutionPreparation> {
    if (!privateProvider || !wallet.selectedAccount) {
      throw new Error("Private service and Devnet wallet are required.");
    }
    const packageSize = mode === "exit"
      ? exitSize ?? (solanaExitSize?.key === currentIdempotencyKey ? solanaExitSize.size : undefined)
      : size;
    if (packageSize === undefined) throw new Error("Create the Devnet exit order first.");
    const input: SolanaExecutionPreparationInput = {
      domain: "svm:devnet",
      mode,
      size: packageSize,
      slippageBps: slippage,
      quoteMode,
      traderPublicKey: wallet.selectedAccount.address,
      idempotencyKey: currentIdempotencyKey,
    };
    return privateProvider.prepareSolanaExecution(input);
  }

  async function handleExecutionAction() {
    if (primaryAction.kind !== "sign" || executionBusy) return;
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
        selectedDomain !== "solana" || (mode === "exit" && EXIT_UNAVAILABLE.solana !== undefined) || !wallet.selectedAccount ||
        !wallet.canSignAndSendV0 || !wallet.canSignMessage || !preview || preview.source !== "PRIVATE_TERMINAL_BFF" ||
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
      let exitSize: string | undefined;
      if (mode === "entry") {
        const account = solanaOnboarding.status;
        if (!solanaOnboarding.ready || !account || account.owner !== wallet.selectedAccount.address) {
          throw new Error("Finish Devnet account setup before reviewing the transaction.");
        }
        // Durable entry order, wallet authorization over its exact bytes, solver quote, and selection,
        // all under this key so the prepare step finds the order by it.
        await privateProvider.createSolanaDevnetEntryAttempt(
          {
            contextId: account.contextId,
            owner: wallet.selectedAccount.address,
            size,
            slippageBps: slippage,
            idempotencyKey: key,
          },
          wallet.signMessage,
        );
      } else {
        // Exit order, wallet authorization, solver firm bid, and selection, all under this key.
        const exitAttempt = await privateProvider.createSolanaDevnetExitAttempt(
          { owner: wallet.selectedAccount.address, slippageBps: slippage, idempotencyKey: key },
          wallet.signMessage,
        );
        exitSize = solanaDevnetSizeFromAtoms(exitAttempt.quantityAtoms);
        setSolanaExitSize({ key, size: exitSize });
      }
      const preparation = await prepareExecution(key, exitSize);
      setExecutionReview({ preparation, preparedAt: Date.now(), ticketKey });
      // An exit records the size of the package it closes, read from the attempt itself.
      recordAttempt({ attemptId: preparation.lifecycleAttemptId, owner: wallet.selectedAccount.address, domain: "solana", mode, size: exitSize ?? size, flow: "devnet", createdAt: Date.now() });
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
        recordAttempt({ attemptId: attempt.attemptId, owner: wallet.selectedAccount.address, domain: "solana", mode, size, flow: "conformance", createdAt: Date.now() });
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
    if (!privateProvider || !currentHyperliquidFlow?.context || !currentHyperliquidFlow.owner ||
        !runtimeHealth?.hyperliquidTestnet.available) return;
    let base = currentHyperliquidFlow;
    const context = currentHyperliquidFlow.context;
    const owner = currentHyperliquidFlow.owner;
    setHyperliquidFlow({ ...base, busy: step, error: null });
    try {
      if (step === "create") {
        const order = mode === "exit"
          ? await privateProvider.createHyperliquidExitOrder(context, owner, {
            slippageBps: slippage,
            idempotencyKey: crypto.randomUUID(),
          })
          : await privateProvider.createHyperliquidOrder(context, owner, {
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
        recordAttempt({
          attemptId: attempt.attemptId, owner, domain: "hyperliquid", mode,
          size: mode === "exit" ? openPackageExitSize ?? size : size, flow: "hyperliquid", createdAt: Date.now(),
        });
        return;
      }
      if (!base.attempt) throw new Error("Select the reviewed Hyperliquid quote first.");
      const attempt = base.attempt;
      const key = base.executeKey;
      if (!base.signed) {
        const authorization = await privateProvider.prepareHyperliquidAuthorization(attempt);
        const signature = await evmWallet.signChainlessTypedData(authorization.typedData);
        await privateProvider.authorizeHyperliquid(attempt, signature);
        base = { ...base, signed: true };
        setHyperliquidFlow({ ...base, busy: step, error: null });
      }
      const showProgress = (progress: HyperliquidAttemptProgress) => setHyperliquidFlow((previous) =>
        previous?.executeKey === key && previous.busy === "execute" ? { ...previous, progress } : previous);
      // The shared account runs one package at a time, so the handoff can wait in a queue.
      const poll = window.setInterval(() => {
        void privateProvider.getHyperliquidAttemptProgress(attempt, key)
          .then((progress) => { if (progress.state !== "COMPLETED") showProgress(progress); })
          .catch(() => undefined);
      }, 2_000);
      let execution: HyperliquidTerminalExecutionResult;
      try {
        execution = await privateProvider.executeHyperliquidTestnet(attempt, key);
      } catch (cause) {
        // A lost, timed-out, or proxy-cut response is resolved from the executor's durable record by
        // polling; nothing is resubmitted.
        let progress = await privateProvider.getHyperliquidAttemptProgress(attempt, key).catch(() => null);
        for (let waited = 0; waited < 180_000 && (progress?.state === "QUEUED" || progress?.state === "EXECUTING"); waited += 2_000) {
          showProgress(progress);
          await new Promise((resolve) => window.setTimeout(resolve, 2_000));
          progress = await privateProvider.getHyperliquidAttemptProgress(attempt, key).catch(() => progress);
        }
        if (progress?.state !== "COMPLETED") {
          throw progress && progress.state !== "NOT_STARTED"
            ? new Error("The outcome is not recorded yet. Check again shortly; the package is never submitted twice.")
            : cause;
        }
        execution = progress.result;
      } finally {
        window.clearInterval(poll);
      }
      const account = await privateProvider.getHyperliquidAccount(context, owner).catch(() => base.account);
      setHyperliquidFlow({ ...base, account, execution, progress: null, busy: null, error: null });
    } catch (cause) {
      setHyperliquidFlow((previous) => ({
        ...(previous?.executeKey === base.executeKey ? previous : base),
        busy: null,
        error: cause instanceof Error ? cause.message : "Hyperliquid Testnet action failed.",
      }));
    }
  }

  const baseFlowMissing = currentBaseFlow === null;
  useEffect(() => {
    if (!privateProvider || !baseOwner || !baseFlowMissing) return;
    const controller = new AbortController();
    const owner = baseOwner;
    const ticket = ticketKey;
    const fresh = (account: BaseAccountStatus | null, error: string | null): BaseFlowState => ({
      ticketKey: ticket,
      owner,
      account,
      order: null,
      quote: null,
      attempt: null,
      idempotencyKey: crypto.randomUUID(),
      preparation: null,
      transactionHash: null,
      observation: null,
      pendingSetup: null,
      busy: null,
      error,
    });
    privateProvider.getBaseAccountStatus(owner, {}, controller.signal)
      .then((account) => { if (!controller.signal.aborted) setBaseFlow(fresh(account, null)); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setBaseFlow(fresh(null, cause instanceof Error ? cause.message : "Strategy account read failed."));
      });
    return () => controller.abort();
  }, [baseFlowMissing, baseOwner, privateProvider, ticketKey]);

  const basePending = currentBaseFlow?.pendingSetup ?? null;
  const basePollOwner = currentBaseFlow?.owner ?? null;
  const basePollOrderHash = currentBaseFlow?.order?.orderHashHex;
  const basePollMargin = quoteMarginAtoms(currentBaseFlow?.quote ?? null);
  useEffect(() => {
    if (!privateProvider || !basePending || !basePollOwner) return;
    let active = true;
    const timer = window.setInterval(() => {
      void privateProvider.getBaseAccountStatus(basePollOwner, {
        orderHash: basePollOrderHash,
        marginAtoms: basePollMargin,
      }).then((account) => {
        if (!active) return;
        setBaseFlow((current) => {
          if (!current || current.pendingSetup !== basePending) return current;
          const landed = ![...account.steps, ...account.withdrawals].some((step) => step.kind === basePending.kind);
          const timedOut = Date.now() - basePending.sentAt > BASE_SETUP_TIMEOUT_MS;
          if (!landed && !timedOut) return { ...current, account };
          return {
            ...current,
            account,
            pendingSetup: null,
            error: landed ? null : "The setup transaction has not landed yet. Check it in your wallet, then retry.",
          };
        });
      }).catch(() => undefined);
    }, OBSERVATION_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [basePending, basePollMargin, basePollOrderHash, basePollOwner, privateProvider]);

  const baseObservedHash = currentBaseFlow?.transactionHash ?? null;
  const baseObservationDone = isBaseObservationTerminal(currentBaseFlow?.observation ?? null);
  const baseAttemptId = currentBaseFlow?.attempt?.attemptId ?? null;
  const baseIdempotencyKey = currentBaseFlow?.idempotencyKey ?? null;
  useEffect(() => {
    if (!privateProvider || !baseObservedHash || baseObservationDone || !baseAttemptId || !baseIdempotencyKey) return;
    const controller = new AbortController();
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const observation = await privateProvider.observeBaseAtomicExecution({
          attemptId: baseAttemptId,
          idempotencyKey: baseIdempotencyKey,
          transactionHash: baseObservedHash,
        }, controller.signal);
        if (controller.signal.aborted) return;
        setBaseFlow((previous) => previous?.transactionHash === baseObservedHash
          ? { ...previous, observation, error: null }
          : previous);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setBaseFlow((previous) => previous?.transactionHash === baseObservedHash
          ? { ...previous, error: cause instanceof Error ? cause.message : "Observation is temporarily unavailable." }
          : previous);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), OBSERVATION_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [baseAttemptId, baseIdempotencyKey, baseObservationDone, baseObservedHash, privateProvider]);

  // A finalized exit closed the package on chain; read the account again for its withdrawals.
  const baseExitFinalized = mode === "exit" && currentBaseFlow?.observation?.lifecycle === "FINALIZED";
  useEffect(() => {
    if (!privateProvider || !baseExitFinalized || !basePollOwner || !baseObservedHash) return;
    let active = true;
    void privateProvider.getBaseAccountStatus(basePollOwner, {}).then((account) => {
      if (!active) return;
      setBaseFlow((current) => current?.transactionHash === baseObservedHash ? { ...current, account } : current);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [baseExitFinalized, baseObservedHash, basePollOwner, privateProvider]);

  async function handleBaseStep(step: BaseStep) {
    if (!privateProvider || !currentBaseFlow?.account || evmTarget !== "base") return;
    const base = currentBaseFlow;
    const account = currentBaseFlow.account;
    setBaseFlow({ ...base, busy: step, error: null });
    const readAccount = (flow: BaseFlowState) => privateProvider.getBaseAccountStatus(flow.owner, {
      orderHash: flow.order?.orderHashHex,
      marginAtoms: quoteMarginAtoms(flow.quote),
    });
    try {
      if (step === "setup" || step === "withdraw") {
        const setup = step === "setup" ? account.steps[0] : account.withdrawals[0];
        if (!setup) throw new Error("The strategy account needs no setup.");
        const hash = await evmWallet.sendTransaction("base", { to: setup.to, data: setup.data, value: "0" });
        setBaseFlow({ ...base, pendingSetup: { kind: setup.kind, hash, sentAt: Date.now() }, busy: null, error: null });
        return;
      }
      if (step === "create" && mode === "exit") {
        const order = await privateProvider.createBaseExitOrder(account, {
          slippageBps: slippage,
          idempotencyKey: crypto.randomUUID(),
        });
        setBaseFlow({ ...base, order, busy: null, error: null });
        return;
      }
      if (step === "create") {
        const order = await privateProvider.createBaseOrder(account, {
          size,
          slippageBps: slippage,
          idempotencyKey: crypto.randomUUID(),
        });
        setBaseFlow({ ...base, order, busy: null, error: null });
        return;
      }
      if (!base.order) throw new Error("Create the package order first.");
      if (step === "quote") {
        const quote = await privateProvider.requestBaseQuote(base.order, crypto.randomUUID());
        const next = { ...base, quote };
        setBaseFlow({ ...next, account: await readAccount(next), busy: null, error: null });
        return;
      }
      if (!base.quote) throw new Error("Request and review a signed quote first.");
      if (step === "select") {
        const attempt = await privateProvider.selectBaseQuote(base.quote);
        setBaseFlow({ ...base, attempt, busy: null, error: null });
        const recordedSize = mode === "exit" && account.openPackage ? atomsDecimal(account.openPackage.baseQuantityAtoms, 18) : size;
        recordAttempt({ attemptId: attempt.attemptId, owner: base.owner, domain: "base", mode, size: recordedSize, flow: "base", createdAt: Date.now() });
        return;
      }
      if (!base.attempt) throw new Error("Accept the reviewed quote first.");
      const identity = { attemptId: base.attempt.attemptId, idempotencyKey: base.idempotencyKey };
      let preparation = base.preparation;
      if (!preparation) {
        const authorization = await privateProvider.prepareBaseAtomicAuthorization(identity);
        const typed = authorization.typedData;
        // viem expects numeric EIP-712 values; the service sends them as decimal strings.
        const traderSignature = await evmWallet.signTypedData("base", {
          ...typed,
          domain: { ...typed.domain, chainId: Number(typed.domain.chainId) },
          message: { ...typed.message, nonce: BigInt(typed.message.nonce), deadline: BigInt(typed.message.deadline) },
        });
        preparation = await privateProvider.prepareBaseAtomicExecution({ ...identity, traderSignature });
        setBaseFlow({ ...base, preparation, busy: step, error: null });
      }
      const transactionHash = await evmWallet.sendTransaction("base", {
        to: preparation.to,
        data: preparation.data,
        value: "0",
      });
      setBaseFlow({ ...base, preparation, transactionHash, busy: null, error: null });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Base Sepolia action failed.";
      // An expired quote cannot be re-selected for the same order, and a prepared call the network
      // refuses would only revert again if re-sent: start a fresh order instead.
      const restart = step === "execute" && /expired|admission|would revert/i.test(message);
      setBaseFlow((previous) => ({
        ...(previous ?? base),
        ...(restart ? { order: null, quote: null, attempt: null, preparation: null, idempotencyKey: crypto.randomUUID() } : {}),
        busy: null,
        error: restart ? `${message} Create a fresh order to re-quote.` : message,
      }));
    }
  }

  const arbitrumFlowMissing = currentArbitrumFlow === null;
  useEffect(() => {
    if (!privateProvider || !arbitrumOwner || !arbitrumFlowMissing) return;
    const controller = new AbortController();
    const owner = arbitrumOwner;
    const ticket = ticketKey;
    const fresh = (account: ArbitrumAccountStatus | null, error: string | null): ArbitrumFlowState => ({
      ticketKey: ticket,
      owner,
      account,
      accountTx: null,
      order: null,
      quote: null,
      attempt: null,
      idempotencyKey: crypto.randomUUID(),
      authorization: null,
      approveHash: null,
      approved: false,
      fundHash: null,
      funded: false,
      reclaimHash: null,
      reclaimed: false,
      observation: null,
      observationNote: null,
      busy: null,
      error,
    });
    privateProvider.getArbitrumAccountStatus(owner, controller.signal)
      .then((account) => { if (!controller.signal.aborted) setArbitrumFlow(fresh(account, null)); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setArbitrumFlow(fresh(null, cause instanceof Error ? cause.message : "Strategy account read failed."));
      });
    return () => controller.abort();
  }, [arbitrumFlowMissing, arbitrumOwner, privateProvider, ticketKey]);

  // The deadline countdown ticks only while a reviewed reservation is open.
  const arbitrumClockActive = arbitrumFunding !== null && !currentArbitrumFlow?.reclaimed &&
    !isArbitrumObservationTerminal(currentArbitrumFlow?.observation ?? null);
  useEffect(() => {
    if (!arbitrumClockActive) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [arbitrumClockActive]);

  const arbitrumAccountTx = currentArbitrumFlow?.accountTx ?? null;
  const arbitrumPollOwner = currentArbitrumFlow?.owner ?? null;
  useEffect(() => {
    if (!privateProvider || !arbitrumAccountTx || !arbitrumPollOwner) return;
    let active = true;
    const timer = window.setInterval(() => {
      void privateProvider.getArbitrumAccountStatus(arbitrumPollOwner).then((account) => {
        if (!active) return;
        setArbitrumFlow((current) => {
          if (!current || current.accountTx !== arbitrumAccountTx) return current;
          const timedOut = Date.now() - arbitrumAccountTx.sentAt > BASE_SETUP_TIMEOUT_MS;
          if (!account.deployed && !timedOut) return { ...current, account };
          return {
            ...current,
            account,
            accountTx: null,
            error: account.deployed ? null : "The account creation transaction has not landed yet. Check it in your wallet, then retry.",
          };
        });
      }).catch(() => undefined);
    }, OBSERVATION_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [arbitrumAccountTx, arbitrumPollOwner, privateProvider]);

  const arbitrumAttemptId = currentArbitrumFlow?.attempt?.attemptId ?? null;
  const arbitrumIdempotencyKey = currentArbitrumFlow?.idempotencyKey ?? null;
  const arbitrumObserve = currentArbitrumFlow?.funded === true && !currentArbitrumFlow.reclaimed &&
    !isArbitrumObservationTerminal(currentArbitrumFlow.observation);
  useEffect(() => {
    if (!privateProvider || !arbitrumObserve || !arbitrumAttemptId || !arbitrumIdempotencyKey) return;
    const controller = new AbortController();
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const observation = await privateProvider.observeArbitrumAsyncExecution({
          attemptId: arbitrumAttemptId,
          idempotencyKey: arbitrumIdempotencyKey,
        }, controller.signal);
        if (controller.signal.aborted) return;
        setArbitrumFlow((previous) => previous?.attempt?.attemptId === arbitrumAttemptId
          ? { ...previous, observation, observationNote: null, error: null }
          : previous);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setArbitrumFlow((previous) => {
          if (previous?.attempt?.attemptId !== arbitrumAttemptId) return previous;
          // Before the solver reserves the package the service has nothing to observe yet.
          if (cause instanceof ArbitrumObservationError && cause.status === 502 && isArbitrumUnreserved(previous.observation)) {
            return { ...previous, observationNote: "Waiting for the bonded solver to reserve the package.", error: null };
          }
          return { ...previous, error: cause instanceof Error ? cause.message : "Observation is temporarily unavailable." };
        });
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), OBSERVATION_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [arbitrumAttemptId, arbitrumIdempotencyKey, arbitrumObserve, privateProvider]);

  async function handleArbitrumStep(step: ArbitrumStep) {
    if (!privateProvider || !currentArbitrumFlow?.account || evmTarget !== "arbitrum") return;
    const flow = currentArbitrumFlow;
    const account = currentArbitrumFlow.account;
    setArbitrumFlow({ ...flow, busy: step, error: null });
    const done = (next: Partial<ArbitrumFlowState>) => setArbitrumFlow((previous) => ({ ...(previous ?? flow), ...next, busy: null, error: null }));
    try {
      if (step === "account") {
        const call = account.createAccount;
        if (!call) throw new Error("The strategy account already exists.");
        const hash = await evmWallet.sendTransaction("arbitrum", call);
        done({ accountTx: { hash, sentAt: Date.now() } });
        return;
      }
      if (step === "restart") {
        done({ order: null, quote: null, attempt: null, authorization: null, approveHash: null, approved: false, idempotencyKey: crypto.randomUUID() });
        return;
      }
      if (step === "create") {
        const order = await privateProvider.createArbitrumOrder(account, {
          contextId: arbitrumContextId,
          size,
          slippageBps: slippage,
          idempotencyKey: crypto.randomUUID(),
        });
        done({ order });
        return;
      }
      if (!flow.order) throw new Error("Create the package order first.");
      if (step === "quote") {
        done({ quote: await privateProvider.requestArbitrumQuote(flow.order, crypto.randomUUID()) });
        return;
      }
      if (!flow.quote) throw new Error("Request and review a signed quote first.");
      if (step === "select") {
        const attempt = await privateProvider.selectArbitrumQuote(flow.quote);
        done({ attempt });
        recordAttempt({ attemptId: attempt.attemptId, owner: flow.owner, domain: "arbitrum", mode, size, flow: "arbitrum", createdAt: Date.now() });
        return;
      }
      if (!flow.attempt) throw new Error("Accept the reviewed quote first.");
      if (step === "prepare") {
        done({ authorization: await privateProvider.prepareArbitrumOwnerAuthorization(flow.attempt, account) });
        setNowMs(Date.now());
        return;
      }
      const authorization = flow.authorization;
      if (!authorization) throw new Error("Review the reservation first.");
      const funding = authorization.funding;
      const beforeDeadline = () => {
        if (Math.floor(Date.now() / 1000) >= Number(funding.reclaimAfterUnixSeconds)) {
          throw new Error("The funding deadline has passed.");
        }
      };
      if (step === "sign") {
        beforeDeadline();
        const ownerSignature = await evmWallet.signTypedData("arbitrum", authorization.typedData);
        done({ authorization: await privateProvider.authorizeArbitrumOwner(authorization, ownerSignature) });
        return;
      }
      if (step === "approve") {
        if (!authorization.signed) throw new Error("Sign the reservation first.");
        let hash = flow.approveHash;
        if (!hash) {
          beforeDeadline();
          hash = await evmWallet.sendTransaction("arbitrum", {
            to: funding.token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [funding.spender as `0x${string}`, BigInt(funding.approveAtoms)],
            }),
            value: "0",
          });
          setArbitrumFlow((previous) => previous ? { ...previous, approveHash: hash } : previous);
        }
        if (!await evmWallet.waitForReceipt("arbitrum", hash)) {
          done({ approveHash: null, approved: false });
          throw new Error("The approval transaction reverted. Approve again.");
        }
        done({ approveHash: hash, approved: true });
        return;
      }
      if (step === "fund") {
        if (!authorization.signed || !flow.approved) throw new Error("Sign the reservation and approve USDC first.");
        let hash = flow.fundHash;
        if (!hash) {
          beforeDeadline();
          hash = await evmWallet.sendTransaction("arbitrum", funding.fundRequest);
          setArbitrumFlow((previous) => previous ? { ...previous, fundHash: hash } : previous);
        }
        if (!await evmWallet.waitForReceipt("arbitrum", hash)) {
          done({ fundHash: null, funded: false });
          throw new Error("The funding transaction reverted, so nothing was pulled. Fund again before the deadline.");
        }
        done({ fundHash: hash, funded: true });
        return;
      }
      // step === "reclaim": only for funded collateral the solver never reserved.
      if (!flow.funded || !isArbitrumUnreserved(flow.observation)) throw new Error("Nothing is reclaimable for this package.");
      let hash = flow.reclaimHash;
      if (!hash) {
        if (Math.floor(Date.now() / 1000) < Number(funding.reclaimAfterUnixSeconds)) {
          throw new Error("Funding can be reclaimed only after the deadline.");
        }
        hash = await evmWallet.sendTransaction("arbitrum", {
          to: funding.spender,
          data: encodeFunctionData({
            abi: ARBITRUM_RECLAIM_ABI,
            functionName: "reclaimExpiredFunding",
            args: [authorization.packageId as `0x${string}`],
          }),
          value: "0",
        });
        setArbitrumFlow((previous) => previous ? { ...previous, reclaimHash: hash } : previous);
      }
      if (!await evmWallet.waitForReceipt("arbitrum", hash)) {
        done({ reclaimHash: null, reclaimed: false });
        throw new Error("The reclaim transaction reverted. The solver may have reserved the package; check the observation.");
      }
      done({ reclaimHash: hash, reclaimed: true });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Arbitrum Sepolia action failed.";
      // An expired quote cannot be re-selected for the same order: start a fresh order instead.
      const restart = (step === "prepare" || step === "sign") && /expired|admission/i.test(message);
      setArbitrumFlow((previous) => ({
        ...(previous ?? flow),
        ...(restart ? { order: null, quote: null, attempt: null, authorization: null, idempotencyKey: crypto.randomUUID() } : {}),
        busy: null,
        error: restart ? `${message} Create a fresh order to re-quote.` : message,
      }));
    }
  }

  const displayedLifecycle = currentLocalFlow?.lifecycle ?? currentLifecycle?.data ?? null;

  const ticketAccount = selectedDomain === "solana"
    ? wallet.selectedAccount ? shortAddress(wallet.selectedAccount.address, 4, 4) : null
    : evmWallet.account ? shortAddress(evmWallet.account, 6, 4) : null;

  function handlePrimaryAction() {
    if (primaryAction.disabled) return;
    if (primaryAction.kind === "connect") walletModal.open(DOMAIN_META[selectedDomain].wallet);
    else if (primaryAction.kind === "switch" && evmTarget) void evmWallet.switchNetwork(evmTarget);
    else if (primaryAction.kind === "prepare") void handlePrepareExecution();
    else if (primaryAction.kind === "sign") void handleExecutionAction();
    else if (primaryAction.kind === "solana-onboard") void solanaOnboarding.advance();
    else if (primaryAction.kind === "hyperliquid" && nextHyperliquidStep) void handleHyperliquidStep(nextHyperliquidStep);
    else if (primaryAction.kind === "base" && nextBaseStep) void handleBaseStep(nextBaseStep);
    else if (primaryAction.kind === "arbitrum" && nextArbitrumStep) void handleArbitrumStep(nextArbitrumStep);
    else if (primaryAction.kind === "arbitrum-exit") void arbitrumExit.advance();
  }

  function jumpToTicket(nextMode: PackageMode) {
    setMode(nextMode);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("package-ticket")?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  }

  const actionReason = confirmingInWallet && !currentSubmission
    ? "Approve the exact reviewed Devnet transaction in your wallet."
    : currentExecutionError ?? primaryAction.reason;

  return (
    <div className={styles.terminalShell}>
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
            previewRejection={previewRejection}
            size={size}
            slippage={slippage}
            quoteMode={quoteMode}
            account={ticketAccount}
            localFlow={currentLocalFlow}
            localFlowEnabled={localFlowEnabled}
            conformanceMode={conformanceMode}
            localCanSignMessage={wallet.canSignMessage}
            hyperliquidFlow={currentHyperliquidFlow}
            baseFlow={currentBaseFlow}
            arbitrumFlow={currentArbitrumFlow}
            arbitrumExitPanel={arbitrumExitEnabled ? arbitrumExit.panel : null}
            nowMs={nowMs}
            executionReview={currentExecutionReview}
            submission={currentSubmission}
            confirming={confirmingInWallet}
            action={{ ...primaryAction, reason: actionReason }}
            actionBusy={executionBusy || solanaOnboarding.busy !== null || currentHyperliquidFlow?.busy != null || currentBaseFlow?.busy != null || currentArbitrumFlow?.busy != null || arbitrumExit.busy}
            canRefreshReview={primaryAction.kind === "sign" && currentExecutionReview !== null}
            onModeChange={setMode}
            onSizeChange={setSize}
            onSlippageChange={setSlippage}
            onQuoteModeChange={setQuoteMode}
            onLocalStep={(step) => void handleLocalStep(step)}
            onPrimaryAction={handlePrimaryAction}
            onRefreshReview={() => void handlePrepareExecution()}
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
        domainNote={domainLive(selectedDomain, runtimeHealth) ? "Testnet" : selectedRuntimeHealth?.available ? "Execution gate offline" : "Execution off"}
        executionLive={domainLive(selectedDomain, runtimeHealth)}
      />
    </div>
  );
}
