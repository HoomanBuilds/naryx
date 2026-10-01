"use client";

import { useEffect, useMemo, useState } from "react";
import { fixtureMarketFeed } from "./market-feed";
import { usePublicMarketFeed } from "./public-market-feed";
import { handleTablistKeys, usePersistedSetting } from "./persisted-setting";
import { ChartWorkspace } from "./pro/chart-workspace";
import { InstrumentBar } from "./pro/instrument-bar";
import { OrderBook } from "./pro/order-book";
import { StatusBar } from "./pro/status-bar";
import { localConformanceTerminalProvider } from "./local-conformance-provider";
import { TerminalMarketUnavailableError, unavailableTerminalSnapshot } from "./private-http-terminal-provider";
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
import { DOMAIN_META, domainHealth, domainLive, useTerminal } from "./shell/terminal-context";
import { EVM_CHAINS, type EvmDomain } from "@/features/wallet/evm-config";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import { shortAddress, useWalletModal } from "@/features/wallet/wallet-modal";
import { AssetIcon, ChainIcon, chainOf } from "@/features/brand/chain-icons";
import styles from "./trading-terminal.module.css";

/** How long a prepared Devnet review stays signable. */
const REVIEW_TTL_MS = 45_000;
const SLIPPAGE_OPTIONS: readonly SlippageBps[] = [5, 10, 25];

const SIZE_PRESETS: readonly string[] = ["10", "50", "100", "250"];

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
        </div>
      ) : null}
      {quote ? <QuoteTerms quote={quote} /> : null}
      {quote ? <QuoteFees quote={quote} /> : null}
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

export type PrimaryAction = Readonly<{
  kind: "connect" | "switch" | "prepare" | "sign" | "hyperliquid" | "none";
  label: string;
  reason: string;
  disabled: boolean;
}>;

function Ticket({
  snapshot,
  selectedDomain,
  mode,
  preview,
  size,
  slippage,
  quoteMode,
  account,
  localFlow,
  localFlowEnabled,
  conformanceMode,
  localCanSignMessage,
  hyperliquidFlow,
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
          {selectedDomain === "hyperliquid" ? "Dedicated testnet account" : account ?? "Not connected"}
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
          <span>{mode === "entry" ? "Maximum quote" : "Minimum output"}</span>
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
    publicApiBaseUrl,
    packageMarketId,
    recordAttempt,
  } = useTerminal();
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [snapshotDomain, setSnapshotDomain] = useState<DomainId>(initialSnapshot.selectedDomain);
  // With a configured service the ticket waits for its preview instead of showing the local one.
  const [preview, setPreview] = useState<TerminalPreview | null>(privateProvider ? null : initialPreview);
  const [mode, setMode] = useState<PackageMode>("entry");
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
  const fixtureFeed = useMemo(() => fixtureMarketFeed(snapshot), [snapshot]);
  const { feed, status: feedStatus } = usePublicMarketFeed(publicApiBaseUrl, packageMarketId, fixtureFeed);
  const wallet = useSolanaWallet();
  const evmWallet = useEvmWallet();
  const walletModal = useWalletModal();
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
      } catch (cause) {
        if (controller.signal.aborted) {
          return;
        }
        if (active) {
          setPreview(null);
          if (privateProvider && !(cause instanceof TerminalMarketUnavailableError)) {
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
  const hyperliquidFlowEnabled = selectedDomain === "hyperliquid" && mode === "entry" &&
    privateProvider !== null && providerConnection === "connected" &&
    runtimeHealth?.hyperliquidTestnet.available === true && executionGateUp &&
    preview?.source === "PRIVATE_TERMINAL_BFF" && quoteMode === "coordinated_limits";
  const evmTarget: EvmDomain | null = selectedDomain === "base" || selectedDomain === "arbitrum" ? selectedDomain : null;
  const evmOnTarget = evmTarget !== null && evmWallet.onChain(evmTarget);
  const nextHyperliquidStep: "create" | "quote" | "select" | "execute" | null = !currentHyperliquidFlow?.context || currentHyperliquidFlow.execution
    ? null
    : !currentHyperliquidFlow.order ? "create"
    : !currentHyperliquidFlow.quote ? "quote"
    : !currentHyperliquidFlow.attempt ? "select"
    : "execute";

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
      return none(
        `${EVM_CHAINS[evmTarget].name} not open`,
        "Package contracts are not deployed on this testnet yet. The package, quotes, and fees shown are a preview.",
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
              : mode !== "entry"
                ? "Exit runs from an open package."
                : quoteMode !== "coordinated_limits"
                  ? "Testnet execution uses coordinated limits."
                  : "A current service preview is required.",
        );
      }
      if (currentHyperliquidFlow?.execution) {
        return none(`Executed: ${currentHyperliquidFlow.execution.status.replace(/_/g, " ").toLowerCase()}`, "The result and its evidence are in the testnet order review below and on the Activity page.");
      }
      if (!currentHyperliquidFlow?.context) {
        return none("Preparing testnet account", currentHyperliquidFlow?.error ?? "Discovering the active Hyperliquid testnet order context.");
      }
      const reason = currentHyperliquidFlow.error;
      if (nextHyperliquidStep === "create") return { kind: "hyperliquid", label: "Create order", reason: reason ?? "Creates the canonical package order for the dedicated testnet account.", disabled: false };
      if (nextHyperliquidStep === "quote") return { kind: "hyperliquid", label: "Request quote", reason: reason ?? "Asks the solver for a signed quote on the whole package.", disabled: false };
      if (nextHyperliquidStep === "select") return { kind: "hyperliquid", label: "Accept quote", reason: reason ?? "Review the signed terms and fees in the testnet order review before accepting.", disabled: false };
      return { kind: "hyperliquid", label: "Execute on testnet", reason: reason ?? "Runs the accepted package on Hyperliquid testnet through the dedicated account gate.", disabled: false };
    }
    if (!privateProvider || providerConnection !== "connected") {
      return { kind: "none", disabled: true, label: "Private service required", reason: "Connect the private terminal service before preparing execution." };
    }
    if (!runtimeHealth?.solanaDevnet.available) {
      return { kind: "none", disabled: true, label: "Devnet runtime unavailable", reason: "The private service is connected, but its Solana Devnet execution runtime is not active." };
    }
    if (!executionGateUp) {
      return { kind: "none", disabled: true, label: "Execution gate offline", reason: "The service's execution safety gate is not configured, so no Devnet transaction can be prepared." };
    }
    if (!wallet.canSignAndSendV0) {
      return { kind: "none", disabled: true, label: "Wallet capability unavailable", reason: "The selected wallet does not advertise Devnet v0 sign-and-send capability." };
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
    if (!currentExecutionReview) {
      return { kind: "prepare", label: "Review transaction", reason: "Builds the exact unsigned Devnet transaction for you to review before signing.", disabled: false };
    }
    if (reviewExpired) {
      return { kind: "prepare", label: "Refresh review", reason: "The review is older than 45 seconds. Refresh it before signing.", disabled: false };
    }
    return { kind: "sign", label: "Sign and submit", reason: "Your wallet shows the exact reviewed Devnet transaction before signing.", disabled: false };
  }, [
    currentExecutionReview,
    currentHyperliquidFlow,
    currentSubmission,
    evmOnTarget,
    evmTarget,
    evmWallet.account,
    evmWallet.switching,
    executionGateUp,
    hyperliquidFlowEnabled,
    mode,
    nextHyperliquidStep,
    preview,
    privateProvider,
    providerConnection,
    quoteMode,
    reviewExpired,
    runtimeHealth,
    selectedDomain,
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
      recordAttempt({ attemptId: preparation.lifecycleAttemptId, domain: "solana", mode, size, flow: "devnet", createdAt: Date.now() });
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
        recordAttempt({ attemptId: attempt.attemptId, domain: "solana", mode, size, flow: "conformance", createdAt: Date.now() });
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
        recordAttempt({ attemptId: attempt.attemptId, domain: "hyperliquid", mode, size, flow: "hyperliquid", createdAt: Date.now() });
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
    else if (primaryAction.kind === "hyperliquid" && nextHyperliquidStep) void handleHyperliquidStep(nextHyperliquidStep);
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
            size={size}
            slippage={slippage}
            quoteMode={quoteMode}
            account={ticketAccount}
            localFlow={currentLocalFlow}
            localFlowEnabled={localFlowEnabled}
            conformanceMode={conformanceMode}
            localCanSignMessage={wallet.canSignMessage}
            hyperliquidFlow={currentHyperliquidFlow}
            executionReview={currentExecutionReview}
            submission={currentSubmission}
            confirming={confirmingInWallet}
            action={{ ...primaryAction, reason: actionReason }}
            actionBusy={executionBusy || currentHyperliquidFlow?.busy != null}
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
