"use client";

import Link from "next/link";
import { NaryxClient, toHex, type PackageBookParticipantOrderView } from "@naryx/sdk";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ChainIcon } from "@/features/brand/chain-icons";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import type { OwnerPackageEntry, PackageLifecycleResponse, PackageLifecycleState } from "../private-http-terminal-provider";
import { DOMAIN_META, useTerminal } from "../shell/terminal-context";
import { attemptsOf, type RecordedAttempt } from "../shell/attempt-index";
import { packageOrdersOf, usePackageOrderIndex } from "../shell/package-order-index";
import {
  activationKind,
  nextActivation,
  useActivationOwners,
  useCancelOrderActivation,
  useOwnerOrderActivations,
  useRevealOrderActivationDetails,
} from "../advanced-order-activations";
import { ReadState, publicClient, readFailure } from "./public-read";
import { TransactionLink } from "../transaction-status";
import styles from "./pages.module.css";

const FLOW_LABEL: Readonly<Record<RecordedAttempt["flow"], string>> = {
  devnet: "Devnet execution",
  conformance: "Local conformance",
  hyperliquid: "Hyperliquid testnet",
  base: "Base Sepolia",
  arbitrum: "Arbitrum Sepolia",
};

const TERMINAL_LIFECYCLE_STATES: ReadonlySet<PackageLifecycleState> = new Set(["CLOSED", "FAILED", "EXPIRED", "CANCELLED"]);

function compact(value: string, leading = 10, trailing = 6) {
  return value.length > leading + trailing + 3 ? `${value.slice(0, leading)}...${value.slice(-trailing)}` : value;
}

function time(ms: number) {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function stateText(state: string) {
  return state.replace(/_/g, " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
}

function statePill(state: string) {
  if (/COMPLETE|FINAL|SETTLED|EXECUTED|CLOSED|^OPEN/.test(state)) return styles.pillOk;
  if (/FAIL|REJECT|ABORT|EXPIRED|RECOVERY|REVERT|CANCEL|CONFLICT|MISMATCH|FROZEN|MANUAL|UNRESOLVED/.test(state)) return styles.pillBad;
  return styles.pill;
}

type StrategyReceiptHistoryRow = Readonly<{
  receiptHash: string;
  orderHash: string;
  quoteHash: string;
  templateId: string;
  lifecycleAction: string;
  expectedStateHash: string | null;
  terminalState: string;
  finalityStatus: string;
  domainIds: readonly string[];
  portfolioEligible: boolean;
  executionEvidence: Readonly<{
    routeHash: string;
    solverId: string;
    settlementClass: string;
    legCount: number;
    onchainEnforcedLegCount: number;
    evidenceGrades: readonly string[];
  }>;
  executionEconomics: Readonly<{
    quoteAssetId: string;
    quoteAssetDecimals: number;
    grossLegNotionalAtoms: bigint;
    serviceFeeAtoms: bigint;
    solverFeeAtoms: bigint;
    venueFeeAtoms: bigint;
    networkCostAtoms: bigint;
    recoveryCostAtoms: bigint;
    explicitCostAtoms: bigint;
    terminalResidualValueAtoms: bigint;
  }>;
  recordedAtMs: number;
}>;

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${context} is malformed.`);
  return value as Record<string, unknown>;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.$naryxType === "bigint" && typeof record.value === "string") return BigInt(record.value);
    if (record.$naryxType === "bytes" && typeof record.value === "string") return record.value;
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, decode(entry)]));
  }
  return value;
}

function exactAtoms(value: unknown, context: string): bigint {
  if (typeof value !== "bigint" || value < BigInt(0)) throw new Error(`${context} is malformed.`);
  return value;
}

function receiptEconomics(value: unknown, context: string): StrategyReceiptHistoryRow["executionEconomics"] {
  const economics = object(value, context);
  if (typeof economics.quoteAssetId !== "string"
    || !/^[\x20-\x7E]{1,128}$/.test(economics.quoteAssetId)
    || typeof economics.quoteAssetDecimals !== "number"
    || !Number.isSafeInteger(economics.quoteAssetDecimals)
    || economics.quoteAssetDecimals < 0
    || economics.quoteAssetDecimals > 255) {
    throw new Error(`${context} quote asset is malformed.`);
  }
  const parsed = Object.freeze({
    quoteAssetId: economics.quoteAssetId,
    quoteAssetDecimals: economics.quoteAssetDecimals,
    grossLegNotionalAtoms: exactAtoms(economics.grossLegNotionalAtoms, `${context} gross leg notional`),
    serviceFeeAtoms: exactAtoms(economics.serviceFeeAtoms, `${context} service fee`),
    solverFeeAtoms: exactAtoms(economics.solverFeeAtoms, `${context} solver fee`),
    venueFeeAtoms: exactAtoms(economics.venueFeeAtoms, `${context} venue fee`),
    networkCostAtoms: exactAtoms(economics.networkCostAtoms, `${context} network cost`),
    recoveryCostAtoms: exactAtoms(economics.recoveryCostAtoms, `${context} recovery cost`),
    explicitCostAtoms: exactAtoms(economics.explicitCostAtoms, `${context} explicit cost`),
    terminalResidualValueAtoms: exactAtoms(economics.terminalResidualValueAtoms, `${context} residual value`),
  });
  if (parsed.explicitCostAtoms !== parsed.serviceFeeAtoms + parsed.solverFeeAtoms + parsed.venueFeeAtoms
    + parsed.networkCostAtoms + parsed.recoveryCostAtoms) {
    throw new Error(`${context} explicit cost does not equal its components.`);
  }
  return parsed;
}

function receiptEvidence(value: unknown, context: string): StrategyReceiptHistoryRow["executionEvidence"] {
  const evidence = object(value, context);
  if (typeof evidence.routeHashHex !== "string" || !/^[0-9a-f]{64}$/.test(evidence.routeHashHex)
    || typeof evidence.solverId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(evidence.solverId)
    || typeof evidence.settlementClass !== "string" || !/^[A-Z_]{1,64}$/.test(evidence.settlementClass)
    || typeof evidence.legCount !== "number" || !Number.isSafeInteger(evidence.legCount) || evidence.legCount < 1 || evidence.legCount > 64
    || typeof evidence.onchainEnforcedLegCount !== "number" || !Number.isSafeInteger(evidence.onchainEnforcedLegCount)
    || evidence.onchainEnforcedLegCount < 0 || evidence.onchainEnforcedLegCount > evidence.legCount
    || !Array.isArray(evidence.evidenceGrades) || evidence.evidenceGrades.length < 1
    || new Set(evidence.evidenceGrades).size !== evidence.evidenceGrades.length
    || !evidence.evidenceGrades.every((grade) => grade === "CONTROLLER_ATTESTED" || grade === "VENUE_API_CORROBORATED" || grade === "CONSENSUS_VERIFIED")) {
    throw new Error(`${context} is malformed.`);
  }
  return Object.freeze({
    routeHash: evidence.routeHashHex,
    solverId: evidence.solverId,
    settlementClass: evidence.settlementClass,
    legCount: evidence.legCount,
    onchainEnforcedLegCount: evidence.onchainEnforcedLegCount,
    evidenceGrades: Object.freeze(evidence.evidenceGrades as string[]),
  });
}

function strategyReceiptHistory(value: unknown, owner: string): readonly StrategyReceiptHistoryRow[] {
  const root = object(decode(value), "Strategy receipt history");
  const expectedOwner = owner.startsWith("0x") ? owner.toLowerCase() : owner;
  if (root.version !== 1 || root.ownerId !== expectedOwner || !Array.isArray(root.receipts)) {
    throw new Error("Strategy receipt history is bound to another owner.");
  }
  return Object.freeze(root.receipts.map((entry, index) => {
    const receipt = object(entry, `Strategy receipt ${index}`);
    const hashes = [receipt.receiptHashHex, receipt.orderHashHex, receipt.quoteHashHex];
    if (!hashes.every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))
      || typeof receipt.templateId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(receipt.templateId)
      || typeof receipt.lifecycleAction !== "string" || !/^[A-Z_]{1,32}$/.test(receipt.lifecycleAction)
      || (receipt.expectedStrategyStateHashHex !== null
        && (typeof receipt.expectedStrategyStateHashHex !== "string" || !/^[0-9a-f]{64}$/.test(receipt.expectedStrategyStateHashHex)))
      || typeof receipt.terminalState !== "string" || !/^[A-Z_]{1,40}$/.test(receipt.terminalState)
      || typeof receipt.finalityStatus !== "string" || !/^[A-Z_]{1,24}$/.test(receipt.finalityStatus)
      || !Array.isArray(receipt.domainIds)
      || !receipt.domainIds.every((domainId) => typeof domainId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(domainId))
      || typeof receipt.portfolioEligible !== "boolean"
      || typeof receipt.recordedAtMs !== "number" || !Number.isSafeInteger(receipt.recordedAtMs) || receipt.recordedAtMs < 0) {
      throw new Error(`Strategy receipt ${index} is malformed.`);
    }
    return Object.freeze({
      receiptHash: receipt.receiptHashHex as string,
      orderHash: receipt.orderHashHex as string,
      quoteHash: receipt.quoteHashHex as string,
      templateId: receipt.templateId,
      lifecycleAction: receipt.lifecycleAction,
      expectedStateHash: receipt.expectedStrategyStateHashHex as string | null,
      terminalState: receipt.terminalState,
      finalityStatus: receipt.finalityStatus,
      domainIds: Object.freeze(receipt.domainIds as string[]),
      portfolioEligible: receipt.portfolioEligible,
      executionEvidence: receiptEvidence(receipt.executionEvidence, `Strategy receipt ${index} evidence`),
      executionEconomics: receiptEconomics(receipt.executionEconomics, `Strategy receipt ${index} economics`),
      recordedAtMs: receipt.recordedAtMs,
    });
  }));
}

async function ownerStrategyReceipts(baseUrl: string, owner: string, signal: AbortSignal) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/owners/${encodeURIComponent(owner)}/strategy-receipts?limit=50`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error(`Strategy receipt history answered ${response.status}.`);
  return strategyReceiptHistory(await response.json(), owner);
}

/** Lifecycle reads cover Solana Devnet and local conformance attempts. */
function readable(attempt: Pick<RecordedAttempt, "flow">) {
  return attempt.flow === "devnet" || attempt.flow === "conformance";
}

/** Base and Arbitrum attempts carry the outcome the service observed on chain. */
function observed(attempt: Pick<RecordedAttempt, "flow">) {
  return attempt.flow === "base" || attempt.flow === "arbitrum";
}

const DOMAIN_OF: Readonly<Record<string, Readonly<{ domain: RecordedAttempt["domain"]; flow: RecordedAttempt["flow"] }>>> = {
  "svm:devnet": { domain: "solana", flow: "devnet" },
  "eip155:84532": { domain: "base", flow: "base" },
  "eip155:421614": { domain: "arbitrum", flow: "arbitrum" },
  "hypercore:testnet": { domain: "hyperliquid", flow: "hyperliquid" },
};

function decimalSize(atoms: string, decimals: number): string {
  const padded = atoms.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "").slice(0, 6);
  return fraction ? `${whole}.${fraction}` : whole;
}

function exactAmount(atoms: bigint, decimals: number, symbol: string): string {
  const negative = atoms < BigInt(0);
  const digits = (negative ? -atoms : atoms).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "").slice(0, 6);
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""} ${symbol.toUpperCase()}`;
}

function csvCell(value: string | number | bigint): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportStrategyReceipts(receipts: readonly StrategyReceiptHistoryRow[]) {
  const headings = [
    "recorded_at_utc", "receipt_hash", "order_hash", "quote_hash", "route_hash", "template_id",
    "lifecycle_action", "domains", "settlement_class", "solver_id", "terminal_state", "finality_status",
    "quote_asset", "quote_decimals", "gross_leg_notional_atoms", "service_fee_atoms", "solver_fee_atoms",
    "venue_fee_atoms", "network_cost_atoms", "recovery_cost_atoms", "explicit_cost_atoms",
    "terminal_residual_value_atoms", "onchain_enforced_legs", "total_legs", "evidence_grades",
  ];
  const rows = receipts.map((receipt) => {
    const economics = receipt.executionEconomics;
    const evidence = receipt.executionEvidence;
    return [
      new Date(receipt.recordedAtMs).toISOString(), receipt.receiptHash, receipt.orderHash, receipt.quoteHash,
      evidence.routeHash, receipt.templateId, receipt.lifecycleAction, receipt.domainIds.join("|"),
      evidence.settlementClass, evidence.solverId, receipt.terminalState, receipt.finalityStatus,
      economics.quoteAssetId, economics.quoteAssetDecimals, economics.grossLegNotionalAtoms,
      economics.serviceFeeAtoms, economics.solverFeeAtoms, economics.venueFeeAtoms, economics.networkCostAtoms,
      economics.recoveryCostAtoms, economics.explicitCostAtoms, economics.terminalResidualValueAtoms,
      evidence.onchainEnforcedLegCount, evidence.legCount, evidence.evidenceGrades.join("|"),
    ].map(csvCell).join(",");
  });
  const blob = new Blob([[headings.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `naryx-strategy-receipts-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/** A package the service recorded for a connected wallet, as an Activity row with its service state and evidence. */
type Row = Omit<RecordedAttempt, "transactionHash"> & Readonly<{
  listed?: true;
  /** The package's order hash, which recovery incidents and coordination plans bind. */
  orderHash?: string;
  serviceState?: string | null;
  transactionHash?: string | null;
  blockNumber?: string | null;
  receiptHash?: string | null;
}>;

function fromService(entry: OwnerPackageEntry, owner: string): Row | null {
  const lane = DOMAIN_OF[entry.domainId];
  if (lane === undefined || entry.attemptId === null) return null;
  return {
    attemptId: entry.attemptId,
    owner,
    domain: lane.domain,
    flow: lane.flow,
    mode: entry.action === "EXIT" ? "exit" : "entry",
    size: decimalSize(entry.quantityAtoms, entry.quantityDecimals),
    createdAt: entry.createdAtMs,
    listed: true,
    orderHash: entry.orderHash,
    serviceState: entry.state,
    transactionHash: entry.transactionHash,
    blockNumber: entry.blockNumber,
    receiptHash: entry.receiptHash,
  };
}

/** A package-book order as the service lists it, or this browser's record of one the service did not list. */
type BookOrderRow = Readonly<{
  packageOrderId: string;
  strategyOrderHash: string;
  participantId: string;
  recordedAt: number;
  service: PackageBookParticipantOrderView | null;
}>;

const RECOVERY_STATES = /RECOVERY|MANUAL|UNRESOLVED|FROZEN|COMPENSAT/;
const HEX_HASH = /^[0-9a-f]{64}$/;
const INCIDENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function bytesHex(value: Uint8Array | string): string {
  return typeof value === "string" ? value.toLowerCase() : toHex(value);
}

/**
 * Read-only status of a manual recovery incident or a cross-domain coordination for one package.
 * The package record does not name either, so the trader enters the id the operator gave them; a
 * record that binds another order hash is refused.
 */
function RecoveryCoordinationLookup({ orderHash, publicApiBaseUrl, inRecovery }: {
  orderHash: string;
  publicApiBaseUrl: string | null;
  inRecovery: boolean;
}) {
  const [incidentInput, setIncidentInput] = useState("");
  const [planInput, setPlanInput] = useState("");
  const [lookup, setLookup] = useState<Readonly<{ incidentId: string | null; planHash: string | null }>>({ incidentId: null, planHash: null });
  const incident = useQuery({
    queryKey: ["recovery-incident", publicApiBaseUrl, lookup.incidentId, orderHash],
    enabled: publicApiBaseUrl !== null && lookup.incidentId !== null,
    retry: false,
    queryFn: async () => {
      const client = publicClient(publicApiBaseUrl);
      if (client === null || lookup.incidentId === null) throw new Error("The public API is not configured.");
      const view = await client.getRecoveryIncident(lookup.incidentId);
      if (bytesHex(view.incident.orderHash) !== orderHash) throw new Error("This incident is for another package and is not shown.");
      return view;
    },
  });
  const coordination = useQuery({
    queryKey: ["coordination", publicApiBaseUrl, lookup.planHash, orderHash],
    enabled: publicApiBaseUrl !== null && lookup.planHash !== null,
    retry: false,
    queryFn: async () => {
      const client = publicClient(publicApiBaseUrl);
      if (client === null || lookup.planHash === null) throw new Error("The public API is not configured.");
      const view = await client.getCoordination(lookup.planHash);
      if (bytesHex(view.plan.orderHash) !== orderHash) throw new Error("This coordination is for another package and is not shown.");
      return view;
    },
  });
  return (
    <div className={styles.lifecycleForm}>
      <p className={styles.readNote}>
        {inRecovery
          ? "This package is in recovery. Enter the incident id or coordination plan hash the operator published to read its verified status. Reading it changes nothing."
          : "Recovery and cross-domain coordination status, read only, by the incident id or plan hash the operator published."}
      </p>
      {publicApiBaseUrl === null ? <p className={styles.readNote}>The public API is not configured, so recovery and coordination status cannot be read.</p> : (
        <div className={styles.lifecycleGrid}>
          <label className={styles.field}>
            Recovery incident id
            <input value={incidentInput} autoComplete="off" onChange={(event) => setIncidentInput(event.target.value.trim())} />
          </label>
          <label className={styles.field}>
            Coordination plan hash
            <input value={planInput} autoComplete="off" placeholder="64 hex characters" onChange={(event) => setPlanInput(event.target.value.trim().toLowerCase())} />
          </label>
          <button
            type="button"
            className={styles.ghost}
            disabled={!INCIDENT_ID.test(incidentInput) && !HEX_HASH.test(planInput)}
            onClick={() => setLookup({
              incidentId: INCIDENT_ID.test(incidentInput) ? incidentInput : null,
              planHash: HEX_HASH.test(planInput) ? planInput : null,
            })}
          >
            Read status
          </button>
        </div>
      )}
      {lookup.incidentId !== null ? (
        <ReadState query={incident} subject="The recovery incident">
          {(view) => (
            <dl className={styles.facts}>
              <dt>Incident</dt><dd className={styles.mono} title={view.incidentHash}>{view.incident.incidentId}</dd>
              <dt>Phase</dt><dd>{stateText(view.state.phase)}</dd>
              <dt>Approval quorum</dt><dd>{view.incident.approvalQuorum} of {view.incident.approverIds.length}</dd>
              <dt>Approved actions</dt><dd>{view.state.approvedActions.length}</dd>
              <dt>Executed actions</dt><dd>{view.state.executedActions.length}</dd>
              <dt>Automation refused</dt><dd>{view.state.refusedAutomatedActions}</dd>
              <dt>Violations</dt><dd>{view.state.violations.length === 0 ? "None" : view.state.violations.join("; ")}</dd>
              <dt>Verification</dt><dd>Incident hash, approver signatures, and phase replayed locally</dd>
            </dl>
          )}
        </ReadState>
      ) : null}
      {lookup.planHash !== null ? (
        <ReadState query={coordination} subject="The coordination">
          {(view) => (
            <dl className={styles.facts}>
              <dt>Plan</dt><dd className={styles.mono} title={view.state.planHash}>{compact(view.state.planHash, 12, 8)}</dd>
              <dt>Phase</dt><dd>{stateText(view.state.phase)}</dd>
              {view.state.terminalState ? <><dt>Terminal state</dt><dd>{stateText(view.state.terminalState)}</dd></> : null}
              <dt>Domains</dt>
              <dd>{Object.entries(view.state.domains).map(([domainId, status]) => `${domainId}: ${stateText(status)}`).join("; ")}</dd>
              <dt>Interim exposure</dt><dd className={styles.mono}>{view.state.interimExposureQuoteAtoms.toString()} quote atoms</dd>
              <dt>Next actions</dt>
              <dd>{view.state.nextActions.length === 0 ? "None" : view.state.nextActions.map((action) =>
                action.kind === "ESCALATE" ? `Escalate: ${action.reason}` : `${stateText(action.kind)} ${action.domainId}`).join("; ")}</dd>
              <dt>Violations</dt><dd>{view.state.violations.length === 0 ? "None" : view.state.violations.join("; ")}</dd>
              <dt>Verification</dt><dd>Plan hash checked and coordination replayed locally from its evidence</dd>
            </dl>
          )}
        </ReadState>
      ) : null}
    </div>
  );
}

/** The SDK-verified settlement allocation of one package-book order; nothing is shown unverified. */
function VerifiedAllocationFacts({ publicApiBaseUrl, packageOrderId }: { publicApiBaseUrl: string | null; packageOrderId: string }) {
  const allocation = useQuery({
    queryKey: ["verified-allocation", publicApiBaseUrl, packageOrderId],
    enabled: publicApiBaseUrl !== null,
    retry: false,
    queryFn: () => {
      const client = publicClient(publicApiBaseUrl);
      if (client === null) throw new Error("The public API is not configured.");
      return client.getVerifiedAllocation(packageOrderId);
    },
  });
  if (publicApiBaseUrl === null) return <p className={styles.readNote}>The public API is not configured, so allocations cannot be read.</p>;
  return (
    <ReadState query={allocation} subject="The verified allocation">
      {(view) => {
        const filled = view.allocation.fills.reduce((sum, fill) => sum + fill.quantity, BigInt(0));
        return (
          <dl className={styles.facts}>
            <dt>Allocation</dt><dd className={styles.mono} title={view.allocationHash}>{compact(view.allocationHash, 12, 8)}</dd>
            <dt>Filled</dt><dd className={styles.mono}>{filled.toString()} of {view.allocation.requestedQuantity.toString()}</dd>
            <dt>Resting</dt><dd className={styles.mono}>{view.allocation.restedQuantity.toString()}</dd>
            <dt>Cancelled</dt><dd className={styles.mono}>{view.allocation.cancelledQuantity.toString()}</dd>
            <dt>Direct / implied</dt><dd className={styles.mono}>{view.allocation.internalMatchedQuantity.toString()} / {view.allocation.externalImpliedQuantity.toString()}</dd>
            <dt>Fills</dt>
            <dd>{view.allocation.fills.length === 0 ? "None" : view.allocation.fills.map((fill) =>
              `${fill.quantity.toString()} at ${fill.priceTicks.toString()} ticks (${fill.makerSource.toLowerCase()})`).join("; ")}</dd>
            <dt>Settlement commitment</dt><dd className={styles.mono} title={view.settlementCommitmentHash}>{compact(view.settlementCommitmentHash, 12, 8)}</dd>
            <dt>Settlement handoff</dt><dd className={styles.mono}>{view.settlementHandoffHash ? compact(view.settlementHandoffHash, 12, 8) : "None yet"}</dd>
            <dt>Verification</dt><dd>Allocation, matching policy, settlement commitment, and handoff verified by the SDK</dd>
          </dl>
        );
      }}
    </ReadState>
  );
}

export function ActivityView() {
  const { attempts: localAttempts, privateProvider, publicApiBaseUrl, clearAttempts } = useTerminal();
  const [openId, setOpenId] = useState<string | null>(null);
  const [proofReceiptHash, setProofReceiptHash] = useState<string | null>(null);
  const [allocationOrderId, setAllocationOrderId] = useState<string | null>(null);
  const [packageOrderRecords, recordPackageOrder] = usePackageOrderIndex();
  const solanaOwner = useSolanaWallet().selectedAccount?.address ?? null;
  const evmOwner = useEvmWallet().account;
  const owners = [solanaOwner, evmOwner].filter((owner): owner is string => owner !== null);
  // The service's record follows the wallet across devices; this browser's list adds the connected
  // wallets' attempts the service did not list. One row per attempt, newest first.
  const ownerQueries = useQueries({
    queries: owners.map((owner) => ({
      queryKey: ["owner-packages", owner],
      enabled: privateProvider !== null,
      refetchInterval: 30_000,
      // Returning to the tab shows packages that settled meanwhile without a manual refresh.
      refetchOnWindowFocus: true,
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        if (!privateProvider) throw new Error("Private service not configured.");
        return privateProvider.listOwnerPackages(owner, signal);
      },
    })),
  });
  const serviceRows = ownerQueries.flatMap((query, index) => {
    const owner = owners[index];
    return owner === undefined ? [] : (query.data ?? []).flatMap((entry) => fromService(entry, owner) ?? []);
  });
  const strategyReceiptQueries = useQueries({
    queries: owners.map((owner) => ({
      queryKey: ["owner-strategy-receipts", publicApiBaseUrl, owner],
      enabled: publicApiBaseUrl !== null,
      refetchInterval: 30_000,
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        if (publicApiBaseUrl === null) throw new Error("Public API not configured.");
        return ownerStrategyReceipts(publicApiBaseUrl, owner, signal);
      },
    })),
  });
  const strategyReceipts = [...new Map(
    strategyReceiptQueries.flatMap((query) => query.data ?? []).map((receipt) => [receipt.receiptHash, receipt]),
  ).values()].sort((left, right) => right.recordedAtMs - left.recordedAtMs);
  const strategyReceiptsLoading = strategyReceiptQueries.some((query) => query.isLoading);
  const strategyReceiptsUnavailable = strategyReceiptQueries.some((query) => query.isError);
  const proofReceipt = strategyReceipts.find((receipt) => receipt.receiptHash === proofReceiptHash) ?? null;
  const strategyProof = useQuery({
    queryKey: ["strategy-receipt-proof", publicApiBaseUrl, proofReceipt?.receiptHash],
    enabled: publicApiBaseUrl !== null && proofReceipt !== null,
    retry: false,
    queryFn: async () => {
      if (publicApiBaseUrl === null || proofReceipt === null) throw new Error("No strategy receipt is selected.");
      const proof = await new NaryxClient({ baseUrl: publicApiBaseUrl }).getStrategyReceiptProof(proofReceipt.receiptHash);
      if (proof.orderHash !== proofReceipt.orderHash || proof.quoteHash !== proofReceipt.quoteHash
        || proof.routeHash !== proofReceipt.executionEvidence.routeHash
        || proof.quote.solverId !== proofReceipt.executionEvidence.solverId
        || proof.route.settlementClass !== proofReceipt.executionEvidence.settlementClass
        || proof.receipt.terminalState !== proofReceipt.terminalState
        || proof.receipt.finalityStatus !== proofReceipt.finalityStatus
        || proof.receipt.serviceFee.atoms !== proofReceipt.executionEconomics.serviceFeeAtoms
        || proof.receipt.solverFee.atoms !== proofReceipt.executionEconomics.solverFeeAtoms
        || proof.receipt.venueFees.atoms !== proofReceipt.executionEconomics.venueFeeAtoms
        || proof.receipt.networkCost.atoms !== proofReceipt.executionEconomics.networkCostAtoms
        || proof.receipt.recoveryCost.atoms !== proofReceipt.executionEconomics.recoveryCostAtoms
        || proof.receipt.terminalResidualValue.atoms !== proofReceipt.executionEconomics.terminalResidualValueAtoms) {
        throw new Error("The selected summary does not match its terminal receipt proof.");
      }
      return proof;
    },
  });
  const serviceKey = JSON.stringify(serviceRows);
  const ownersKey = owners.join(",");
  const attempts: readonly Row[] = useMemo(() => {
    const byId = new Map<string, Row>();
    for (const row of serviceRows) byId.set(row.attemptId, row);
    for (const attempt of attemptsOf(localAttempts, owners)) if (!byId.has(attempt.attemptId)) byId.set(attempt.attemptId, attempt);
    return [...byId.values()].sort((left, right) => right.createdAt - left.createdAt);
    // serviceRows and owners are rebuilt each render; their content is captured by serviceKey and ownersKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localAttempts, serviceKey, ownersKey]);
  // What a Base or Arbitrum row the service did not list can say about its state.
  const unlisted = privateProvider === null || ownerQueries.some((query) => query.isError) ? "Unavailable"
    : ownerQueries.some((query) => query.isPending) ? "Loading"
      : "Not observed";
  const lifecycles = useQueries({
    queries: attempts.map((attempt) => ({
      queryKey: ["lifecycle", attempt.attemptId],
      enabled: privateProvider !== null && readable(attempt),
      refetchInterval: (query: { state: { data?: PackageLifecycleResponse } }) =>
        query.state.data !== undefined && TERMINAL_LIFECYCLE_STATES.has(query.state.data.attempt.state) ? false : 15_000,
      refetchOnWindowFocus: (query: { state: { data?: PackageLifecycleResponse } }) =>
        query.state.data === undefined || !TERMINAL_LIFECYCLE_STATES.has(query.state.data.attempt.state),
      queryFn: ({ signal }: { signal: AbortSignal }): Promise<PackageLifecycleResponse> => {
        if (!privateProvider) throw new Error("Private service not configured.");
        return privateProvider.getPackageLifecycle(attempt.attemptId, signal);
      },
    })),
  });
  const openIndex = attempts.findIndex((attempt) => attempt.attemptId === openId);
  const openAttempt = openIndex >= 0 ? attempts[openIndex] : undefined;
  const openLifecycle = openIndex >= 0 ? lifecycles[openIndex]?.data ?? null : null;
  const openState = openAttempt === undefined ? null
    : (readable(openAttempt) ? openLifecycle?.attempt.state ?? null : openAttempt.serviceState ?? null);
  const packageOrders = packageOrdersOf(packageOrderRecords, owners);
  // Strategy orders, activations, and package-book participants bind the lowercase EVM address.
  const participants = useActivationOwners();
  const advanced = useOwnerOrderActivations(participants);
  const advancedCancel = useCancelOrderActivation();
  const advancedReveal = useRevealOrderActivationDetails();
  const participantQueries = useQueries({
    queries: participants.map((participantId) => ({
      queryKey: ["participant-package-orders", publicApiBaseUrl, participantId],
      enabled: publicApiBaseUrl !== null,
      retry: false,
      refetchInterval: 30_000,
      queryFn: () => {
        const client = publicClient(publicApiBaseUrl);
        if (client === null) throw new Error("The public API is not configured.");
        return client.getParticipantPackageOrders(participantId);
      },
    })),
  });
  const listedParticipants = new Set(participants.filter((_participant, index) => participantQueries[index]?.isSuccess === true));
  const serviceBookRows: BookOrderRow[] = participantQueries.flatMap((query, index) => {
    const participantId = participants[index];
    return participantId === undefined ? [] : (query.data?.orders ?? []).map((order) => ({
      packageOrderId: order.packageOrderId,
      strategyOrderHash: order.strategyOrderHash,
      participantId,
      recordedAt: order.recordedAtMs,
      service: order,
    }));
  });
  const listedOrderIds = new Set(serviceBookRows.map((row) => row.packageOrderId));
  const bookRows: readonly BookOrderRow[] = [
    ...serviceBookRows,
    ...packageOrders.filter((order) => !listedOrderIds.has(order.packageOrderId)).map((order) => ({
      packageOrderId: order.packageOrderId,
      strategyOrderHash: order.strategyOrderHash,
      participantId: order.participantId,
      recordedAt: order.createdAt,
      service: null,
    })),
  ].sort((left, right) => right.recordedAt - left.recordedAt);
  const bookFailures = [...new Set(participantQueries.flatMap((query) => query.isError
    ? [readFailure(query.error, "The package book order list")] : []))];
  const bookLoading = publicApiBaseUrl !== null && participantQueries.some((query) => query.isPending);

  return (
    <main className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1>Activity</h1>
          <p>Every package your connected wallets started, on any device, with its durable state and the receipts the service recorded for it.</p>
        </div>
        {attempts.length > 0 ? (
          <div className={styles.headActions}>
            <button
              type="button"
              className={styles.ghost}
              title="Removes this browser's record only; packages the service lists for your wallets stay."
              onClick={() => { setOpenId(null); setProofReceiptHash(null); clearAttempts(owners); }}
            >
              Clear local list
            </button>
          </div>
        ) : null}
      </div>

      {privateProvider === null && attempts.length > 0 ? (
        <p className={styles.notice}>The private terminal service is not configured, so lifecycle state cannot be read. The list below is this browser&apos;s record only.</p>
      ) : null}

      <section className={styles.card} aria-labelledby="strategy-receipts-title">
        <div className={styles.cardHead}>
          <div>
            <h2 id="strategy-receipts-title">Canonical strategy receipts</h2>
            <p>Final package economics and evidence, indexed from the connected wallet&apos;s durable strategy orders.</p>
          </div>
          <button type="button" className={styles.ghost} disabled={strategyReceipts.length === 0} onClick={() => exportStrategyReceipts(strategyReceipts)}>
            Export exact CSV
          </button>
        </div>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Recorded</th>
                <th scope="col">Template</th>
                <th scope="col">Action</th>
                <th scope="col">Domains</th>
                <th scope="col">Execution</th>
                <th scope="col" className={styles.num}>Leg notional</th>
                <th scope="col" className={styles.num}>Explicit cost</th>
                <th scope="col">Outcome</th>
                <th scope="col">Receipt</th>
                <th scope="col"><span className="sr-only">Receipt actions</span></th>
              </tr>
            </thead>
            <tbody>
              {strategyReceipts.length === 0 ? (
                <tr>
                  <td colSpan={10}>
                    <div className={styles.empty}>
                      <strong>{owners.length === 0
                        ? "Connect a wallet"
                        : publicApiBaseUrl === null
                          ? "Strategy receipts not connected"
                          : strategyReceiptsLoading
                          ? "Loading strategy receipts"
                          : strategyReceiptsUnavailable
                            ? "Strategy receipts unavailable"
                            : "No strategy receipts yet"}</strong>
                      <p>{owners.length === 0
                        ? "Connect a Solana or EVM wallet to load its canonical strategy receipt history."
                        : publicApiBaseUrl === null
                        ? "The public evidence service is not configured for this deployment, so receipt history cannot be read."
                        : strategyReceiptsUnavailable
                        ? "The public evidence service could not return the connected wallet's receipt history."
                        : "A finalized package execution appears here and can be recorded or applied in Portfolio."}</p>
                    </div>
                  </td>
                </tr>
              ) : strategyReceipts.map((receipt) => {
                const portfolioHref = !receipt.portfolioEligible
                  ? null
                  : receipt.lifecycleAction === "ENTRY"
                    ? `/portfolio?receipt=${encodeURIComponent(receipt.receiptHash)}`
                    : receipt.expectedStateHash === null
                      ? null
                      : `/portfolio?receipt=${encodeURIComponent(receipt.receiptHash)}&state=${encodeURIComponent(receipt.expectedStateHash)}`;
                return (
                  <tr key={receipt.receiptHash}>
                    <td className={styles.mono}>{time(receipt.recordedAtMs)}</td>
                    <td>{receipt.templateId}</td>
                    <td>{stateText(receipt.lifecycleAction)}</td>
                    <td className={styles.dim}>{receipt.domainIds.join(", ")}</td>
                    <td title={`${stateText(receipt.executionEvidence.settlementClass)}; route ${receipt.executionEvidence.routeHash}; evidence ${receipt.executionEvidence.evidenceGrades.map(stateText).join(", ")}`}>
                      <strong>{receipt.executionEvidence.solverId}</strong>
                      <small className={styles.cellDetail}>{receipt.executionEvidence.onchainEnforcedLegCount}/{receipt.executionEvidence.legCount} legs onchain-enforced</small>
                      <small className={styles.cellDetail}>Route {compact(receipt.executionEvidence.routeHash, 8, 6)}</small>
                    </td>
                    <td className={styles.num} title="Sum of every execution leg's observed gross notional. This is not package notional or PnL.">
                      {exactAmount(receipt.executionEconomics.grossLegNotionalAtoms, receipt.executionEconomics.quoteAssetDecimals, receipt.executionEconomics.quoteAssetId)}
                    </td>
                    <td
                      className={styles.num}
                      title={`Service ${exactAmount(receipt.executionEconomics.serviceFeeAtoms, receipt.executionEconomics.quoteAssetDecimals, receipt.executionEconomics.quoteAssetId)}; solver ${exactAmount(receipt.executionEconomics.solverFeeAtoms, receipt.executionEconomics.quoteAssetDecimals, receipt.executionEconomics.quoteAssetId)}; venue ${exactAmount(receipt.executionEconomics.venueFeeAtoms, receipt.executionEconomics.quoteAssetDecimals, receipt.executionEconomics.quoteAssetId)}; network ${exactAmount(receipt.executionEconomics.networkCostAtoms, receipt.executionEconomics.quoteAssetDecimals, receipt.executionEconomics.quoteAssetId)}; recovery ${exactAmount(receipt.executionEconomics.recoveryCostAtoms, receipt.executionEconomics.quoteAssetDecimals, receipt.executionEconomics.quoteAssetId)}; residual ${exactAmount(receipt.executionEconomics.terminalResidualValueAtoms, receipt.executionEconomics.quoteAssetDecimals, receipt.executionEconomics.quoteAssetId)}`}
                    >
                      {exactAmount(receipt.executionEconomics.explicitCostAtoms, receipt.executionEconomics.quoteAssetDecimals, receipt.executionEconomics.quoteAssetId)}
                    </td>
                    <td><span className={statePill(receipt.terminalState)}>{stateText(receipt.terminalState)}</span></td>
                    <td className={styles.mono} title={receipt.receiptHash}>{compact(receipt.receiptHash, 12, 8)}</td>
                    <td>
                      <span className={styles.rowActions}>
                        <button
                          type="button"
                          className={styles.ghost}
                          onClick={() => setProofReceiptHash((current) => current === receipt.receiptHash ? null : receipt.receiptHash)}
                        >
                          {proofReceiptHash === receipt.receiptHash ? "Hide proof" : "Verify receipt"}
                        </button>
                        {portfolioHref ? <Link href={portfolioHref}>{receipt.lifecycleAction === "ENTRY" ? "Record" : "Apply"}</Link> : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {proofReceipt !== null ? (
          <div className={styles.cardBody}>
            {strategyProof.isPending ? <p className={styles.notice}>Recomputing the terminal receipt, order, graph, quote, route, and signature locally.</p> : null}
            {strategyProof.isError ? <p className={styles.noticeError}>{strategyProof.error.message}</p> : null}
            {strategyProof.data ? (
              <>
                <p className={strategyProof.data.signatureVerified ? styles.noticeOk : styles.notice}>
                  {strategyProof.data.signatureVerified
                    ? "Receipt, fees, order, graph, quote, route, cross-links, and the embedded quote-key signature verified locally."
                    : "Receipt, fees, order, graph, quote, route, and cross-links verified locally. This runtime could not verify Ed25519."}
                </p>
                <dl className={styles.facts}>
                  <dt>Receipt</dt><dd className={styles.mono} title={strategyProof.data.receiptHash}>{compact(strategyProof.data.receiptHash, 12, 8)}</dd>
                  <dt>Order</dt><dd className={styles.mono} title={strategyProof.data.orderHash}>{compact(strategyProof.data.orderHash, 12, 8)}</dd>
                  <dt>Graph</dt><dd className={styles.mono} title={strategyProof.data.graphHash}>{compact(strategyProof.data.graphHash, 12, 8)}</dd>
                  <dt>Quote</dt><dd className={styles.mono} title={strategyProof.data.quoteHash}>{compact(strategyProof.data.quoteHash, 12, 8)}</dd>
                  <dt>Route</dt><dd className={styles.mono} title={strategyProof.data.routeHash}>{compact(strategyProof.data.routeHash, 12, 8)}</dd>
                  <dt>Solver</dt><dd>{strategyProof.data.quote.solverId}</dd>
                  <dt>Settlement</dt><dd>{stateText(strategyProof.data.route.settlementClass)}</dd>
                  <dt>Terminal state</dt><dd>{stateText(strategyProof.data.receipt.terminalState)}</dd>
                  <dt>Finality</dt><dd>{stateText(strategyProof.data.receipt.finalityStatus)}</dd>
                  <dt>Route expiry</dt><dd className={styles.mono}>{strategyProof.data.route.routeExpiryValue.toString()} {stateText(strategyProof.data.route.routeExpiryUnit)}</dd>
                  <dt>Domain plans</dt>
                  <dd>{strategyProof.data.route.domainPlans.map((plan) => `${plan.domain.domainId}: ${stateText(plan.executionPlanKind)} (${plan.legIds.length} legs, ${plan.stageCount} stages)`).join("; ")}</dd>
                  {strategyProof.data.executionIntelligence ? (
                    <>
                      <dt>Delivery path</dt><dd>{strategyProof.data.executionIntelligence.intelligence.delivery.actualPath === null
                        ? "Not included"
                        : stateText(strategyProof.data.executionIntelligence.intelligence.delivery.actualPath)}</dd>
                      <dt>MEV protection</dt><dd>{stateText(strategyProof.data.executionIntelligence.intelligence.delivery.mevProtectionLabel)}</dd>
                      <dt>Pre-inclusion move</dt><dd className={styles.mono}>{strategyProof.data.executionIntelligence.intelligence.quality.preInclusionMoveBps.toString()} bps</dd>
                      <dt>Package slippage</dt><dd className={styles.mono}>{strategyProof.data.executionIntelligence.intelligence.quality.slippageBps.toString()} bps</dd>
                      <dt>Outcome shortfall</dt><dd className={styles.mono}>{strategyProof.data.executionIntelligence.intelligence.quality.shortfallAtoms.toString()} quote atoms</dd>
                      <dt>Inclusion latency</dt><dd className={styles.mono}>{strategyProof.data.executionIntelligence.intelligence.quality.inclusionLatencyValue.toString()} {strategyProof.data.executionIntelligence.intelligence.clockUnit}</dd>
                      <dt>Time unhedged</dt><dd className={styles.mono}>{strategyProof.data.executionIntelligence.intelligence.quality.timeUnhedgedValue.toString()} {strategyProof.data.executionIntelligence.intelligence.clockUnit}</dd>
                      <dt>MEV attribution</dt><dd>{stateText(strategyProof.data.executionIntelligence.intelligence.quality.attribution)} ({strategyProof.data.executionIntelligence.intelligence.quality.attributionIsFact ? "evidenced fact" : "not asserted as fact"})</dd>
                      <dt>Observer</dt><dd>{strategyProof.data.executionIntelligence.intelligence.observerId}</dd>
                    </>
                  ) : null}
                </dl>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className={styles.card} aria-labelledby="packages-title">
        <div className={styles.cardHead}>
          <h2 id="packages-title">Packages</h2>
          <p>Select a package to see its receipts.</p>
        </div>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Chain</th>
                <th scope="col">Side</th>
                <th scope="col" className={styles.num}>Size</th>
                <th scope="col">Path</th>
                <th scope="col">State</th>
                <th scope="col" className={styles.num}>Revision</th>
                <th scope="col">Attempt</th>
              </tr>
            </thead>
            <tbody>
              {attempts.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className={styles.empty}>
                      <strong>No packages yet</strong>
                      <p>Packages you prepare or run from the Trade page appear here with their lifecycle state and receipts.</p>
                      <Link href="/trade">Go to Trade</Link>
                    </div>
                  </td>
                </tr>
              ) : attempts.map((attempt, index) => {
                const query = lifecycles[index];
                const lifecycle = query?.data ?? null;
                const open = attempt.attemptId === openId;
                const recorded = readable(attempt) ? lifecycle?.attempt.state ?? null : attempt.serviceState ?? null;
                const state = recorded !== null ? stateText(recorded)
                  : readable(attempt)
                    ? privateProvider === null || query?.isError ? "Unavailable" : "Loading"
                    : observed(attempt) ? (attempt.listed ? "Not observed" : unlisted)
                      : "See ticket";
                return (
                  <tr
                    key={attempt.attemptId}
                    className={open ? `${styles.rowButton} ${styles.rowOpen}` : styles.rowButton}
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : attempt.attemptId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenId(open ? null : attempt.attemptId);
                      }
                    }}
                  >
                    <td className={styles.mono}>{time(attempt.createdAt)}</td>
                    <td>
                      <span className={styles.chainCell}>
                        <ChainIcon chain={attempt.domain} size={16} />
                        {DOMAIN_META[attempt.domain].label}
                      </span>
                    </td>
                    <td style={{ color: attempt.mode === "entry" ? "var(--up)" : "var(--down)" }}>{attempt.mode === "entry" ? "Enter" : "Exit"}</td>
                    <td className={styles.num}>{attempt.size}</td>
                    <td className={styles.dim}>{FLOW_LABEL[attempt.flow]}</td>
                    <td>
                      {readable(attempt) || observed(attempt) || recorded !== null ? (
                        <span className={recorded !== null ? statePill(recorded) : styles.pill}>{state}</span>
                      ) : (
                        <Link href="/trade" className={styles.pill} onClick={(event) => event.stopPropagation()}>{state}</Link>
                      )}
                    </td>
                    <td className={styles.num}>{lifecycle?.attempt.revision ?? "-"}</td>
                    <td className={styles.mono} title={attempt.attemptId}>{compact(attempt.attemptId, 14, 6)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {openId !== null ? (
        <section className={styles.card} aria-labelledby="receipts-title">
          <div className={styles.cardHead}>
            <h2 id="receipts-title">Receipts</h2>
            <p className={styles.mono} title={openId}>{compact(openId, 18, 8)}</p>
          </div>
          <div className={styles.cardBody}>
            {openAttempt?.flow === "devnet" && openAttempt.transactionHash ? (
              <p className={styles.dim} style={{ fontSize: 12.5 }}>
                Devnet transaction: <TransactionLink domain="solana" hash={openAttempt.transactionHash}>{compact(openAttempt.transactionHash, 12, 8)}</TransactionLink>
              </p>
            ) : null}
            {openAttempt !== undefined && observed(openAttempt) ? (
              openAttempt.serviceState ? (
                <dl className={styles.facts}>
                  <dt>State</dt>
                  <dd>{stateText(openAttempt.serviceState)}</dd>
                  <dt>Transaction</dt>
                  <dd className={styles.mono}>
                    {openAttempt.transactionHash ? (
                      <TransactionLink domain={openAttempt.domain} hash={openAttempt.transactionHash}>
                        {compact(openAttempt.transactionHash, 12, 8)}
                      </TransactionLink>
                    ) : "-"}
                  </dd>
                  <dt>Block</dt>
                  <dd className={styles.mono}>{openAttempt.blockNumber ?? "-"}</dd>
                  <dt>Package receipt</dt>
                  <dd className={styles.mono} title={openAttempt.receiptHash ?? undefined}>
                    {openAttempt.receiptHash ? compact(openAttempt.receiptHash, 12, 8) : "-"}
                  </dd>
                </dl>
              ) : (
                <p className={styles.dim} style={{ fontSize: 12.5 }}>
                  {openAttempt.listed
                    ? "The service has not observed a transaction for this package on chain, so it has no state or receipt."
                    : "The service did not list this package, so its on-chain state cannot be shown here."}
                  {openAttempt.transactionHash ? (
                    <> Submitted transaction: <TransactionLink domain={openAttempt.domain} hash={openAttempt.transactionHash}>{compact(openAttempt.transactionHash, 12, 8)}</TransactionLink>.</>
                  ) : null}
                </p>
              )
            ) : openLifecycle && openLifecycle.receipts.length > 0 ? (
              <ol className={styles.timeline}>
                {openLifecycle.receipts.map((receipt) => (
                  <li key={receipt.receiptHashHex}>
                    <i aria-hidden="true" />
                    <strong>{receipt.priorState ? `${stateText(receipt.priorState)} > ` : ""}{stateText(receipt.nextState)}</strong>
                    <span>rev {receipt.revision}</span>
                    <small>
                      {receipt.domain.domainId} / {receipt.evidenceGrade} / {receipt.onchainEnforced ? "onchain enforced" : "controller recorded"} / <span title={receipt.receiptHashHex}>{compact(receipt.receiptHashHex, 12, 8)}</span>
                    </small>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={styles.dim} style={{ fontSize: 12.5 }}>
                {openAttempt !== undefined && !readable(openAttempt)
                  ? `${FLOW_LABEL[openAttempt.flow]} attempts report their execution in the Trade ticket; the lifecycle read covers Solana and local conformance attempts.`
                  : privateProvider === null
                    ? "Receipts need the private terminal service."
                    : "No receipts recorded yet."}
              </p>
            )}
            {openAttempt?.orderHash !== undefined ? (
              <RecoveryCoordinationLookup
                key={openAttempt.attemptId}
                orderHash={openAttempt.orderHash}
                publicApiBaseUrl={publicApiBaseUrl}
                inRecovery={openState !== null && RECOVERY_STATES.test(openState)}
              />
            ) : openState !== null && RECOVERY_STATES.test(openState) ? (
              <p className={styles.readNote}>This browser&apos;s record of the package has no order hash, so recovery and coordination status cannot be bound to it here.</p>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className={styles.card} aria-labelledby="advanced-orders-title">
        <div className={styles.cardHead}>
          <div>
            <h2 id="advanced-orders-title">Advanced orders</h2>
            <p>Conditional, scheduled, and TWAP orders the connected wallets own: every waiting order plus the most recent finished ones. Trigger and schedule terms stay private until the owner signs a one-time read. Cancelling needs the owner&apos;s signature.</p>
            {advancedReveal.state !== null && advancedReveal.state.phase !== "busy" ? (
              <p className={styles.readNote} role={advancedReveal.state.phase === "error" ? "alert" : "status"}>{advancedReveal.state.text}</p>
            ) : null}
          </div>
          <button
            type="button"
            className={styles.ghost}
            disabled={advancedReveal.busy || advanced.activations.length === 0}
            onClick={() => void advancedReveal.reveal(participants)}
          >
            {advancedReveal.busy ? (advancedReveal.awaitingWallet ? "Confirm in your wallet" : "Reading") : "Show full terms"}
          </button>
        </div>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Created</th>
                <th scope="col">Kind</th>
                <th scope="col">Source order</th>
                <th scope="col">State</th>
                <th scope="col" className={styles.num}>Filled / remaining</th>
                <th scope="col">Next activation</th>
                <th scope="col"><span className="sr-only">Advanced order actions</span></th>
              </tr>
            </thead>
            <tbody>
              {advanced.activations.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className={styles.empty}>
                      <strong>{participants.length === 0
                        ? "Connect a wallet"
                        : !advanced.configured
                          ? "Advanced orders not connected"
                          : advanced.loading
                            ? "Loading advanced orders"
                            : advanced.errors.length > 0
                              ? "Advanced orders unavailable"
                              : "No advanced orders yet"}</strong>
                      <p>{participants.length === 0
                        ? "Connect a Solana or EVM wallet to list the advanced orders it owns."
                        : !advanced.configured
                          ? "The private terminal service is not configured, so advanced orders cannot be read."
                          : advanced.errors.length > 0
                            ? advanced.errors.join(" ")
                            : "Create a conditional, scheduled, or TWAP order from a strategy order on the Trade page."}</p>
                    </div>
                  </td>
                </tr>
              ) : advanced.activations.map((activation) => {
                const current = advancedCancel.state?.orderHash === activation.orderHash ? advancedCancel.state : null;
                return (
                  <tr key={activation.orderHash}>
                    <td className={styles.mono}>{time(activation.registeredAtMs)}</td>
                    <td title={activation.orderHash}>
                      {activationKind(activation)}
                      <small className={styles.cellDetail}>{compact(activation.orderHash, 8, 6)}</small>
                    </td>
                    <td className={styles.mono} title={activation.sourceOrderHash ?? undefined}>
                      {activation.sourceOrderHash === null ? "-" : compact(activation.sourceOrderHash, 10, 6)}
                    </td>
                    <td>
                      <span className={statePill(activation.status)}>{stateText(activation.status)}</span>
                      {activation.failedSlices !== null && activation.failedSlices > 0
                        ? <small className={styles.cellDetail}>{activation.failedSlices} of {activation.attemptedSlices} slices failed</small> : null}
                    </td>
                    <td className={styles.num} title="Quantity in asset atoms">
                      {activation.executedAtoms.toString()} / {(activation.quantityAtoms - activation.executedAtoms).toString()}
                    </td>
                    <td className={styles.dim}>{nextActivation(activation)}</td>
                    <td>
                      {activation.status === "WAITING" ? (
                        <button
                          type="button"
                          className={styles.ghost}
                          disabled={advancedCancel.busy || activation.attemptReserved}
                          title={activation.attemptReserved ? "A slice is executing; cancel after it settles." : undefined}
                          onClick={() => void advancedCancel.cancel(activation)}
                        >
                          {current?.phase === "busy" ? (advancedCancel.awaitingWallet ? "Confirm in your wallet" : "Cancelling") : "Cancel"}
                        </button>
                      ) : null}
                      {current !== null && current.phase !== "busy" ? (
                        <small className={styles.cellDetail} role={current.phase === "error" ? "alert" : "status"}>{current.text}</small>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {advanced.activations.length > 0 && advanced.errors.length > 0 ? (
          <div className={styles.cardBody}>
            {advanced.errors.map((message) => <p key={message} className={styles.readNote}>{message}</p>)}
          </div>
        ) : null}
      </section>

      {participants.length > 0 || bookRows.length > 0 ? (
        <section className={styles.card} aria-labelledby="package-book-orders-title">
          <div className={styles.cardHead}>
            <div>
              <h2 id="package-book-orders-title">Package book orders</h2>
              <p>The connected wallets&apos; package-book orders as the service lists them: every resting order plus the most recent closed ones, with this browser&apos;s records the service did not list. Select one to verify its settlement allocation.</p>
            </div>
          </div>
          {publicApiBaseUrl === null || bookFailures.length > 0 ? (
            <div className={styles.cardBody}>
              {publicApiBaseUrl === null
                ? <p className={styles.readNote}>The public API is not configured, so only this browser&apos;s record of submitted orders is shown.</p>
                : bookFailures.map((message) => <p key={message} className={styles.readNote}>{message} Only this browser&apos;s record is shown for that wallet.</p>)}
            </div>
          ) : null}
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Recorded</th>
                  <th scope="col">Market</th>
                  <th scope="col">Side</th>
                  <th scope="col" className={styles.num}>Price (ticks)</th>
                  <th scope="col" className={styles.num}>Quantity</th>
                  <th scope="col" className={styles.num}>Filled</th>
                  <th scope="col" className={styles.num}>Remaining</th>
                  <th scope="col">State</th>
                  <th scope="col" className={styles.num} title="In the package market's clock unit">Expiry</th>
                  <th scope="col">Package order</th>
                  <th scope="col"><span className="sr-only">Order actions</span></th>
                </tr>
              </thead>
              <tbody>
                {bookRows.length === 0 ? (
                  <tr>
                    <td colSpan={11}>
                      <div className={styles.empty}>
                        <strong>{bookLoading ? "Loading package book orders" : "No package book orders yet"}</strong>
                        <p>Orders the connected wallets submit to a package book appear here with their fills and state.</p>
                      </div>
                    </td>
                  </tr>
                ) : bookRows.map((row) => {
                  const order = row.service;
                  return (
                    <tr key={row.packageOrderId}>
                      <td className={styles.mono}>{time(row.recordedAt)}</td>
                      <td>{order?.packageMarketId ?? "-"}</td>
                      <td style={order?.side ? { color: order.side === "BID" ? "var(--up)" : "var(--down)" } : undefined}>
                        {order?.side === "BID" ? "Bid" : order?.side === "ASK" ? "Ask" : "-"}
                      </td>
                      <td className={styles.num}>{order?.priceTicks?.toString() ?? "-"}</td>
                      <td className={styles.num}>{order?.quantity.toString() ?? "-"}</td>
                      <td className={styles.num}>{order?.filledQuantity.toString() ?? "-"}</td>
                      <td className={styles.num}>{order?.remainingQuantity.toString() ?? "-"}</td>
                      <td>
                        {order !== null ? (
                          <span className={statePill(order.state)}>{stateText(order.state)}</span>
                        ) : (
                          <span
                            className={styles.pill}
                            title={listedParticipants.has(row.participantId)
                              ? "This browser recorded the order; the service list for this wallet did not include it."
                              : "This browser recorded the order; the service list for this wallet could not be read."}
                          >
                            {listedParticipants.has(row.participantId) ? "Not listed" : "Local record"}
                          </span>
                        )}
                      </td>
                      <td className={styles.num}>{order?.expiresAtValue?.toString() ?? "-"}</td>
                      <td className={styles.mono} title={`Package order ${row.packageOrderId}; strategy order ${row.strategyOrderHash}`}>
                        {compact(row.packageOrderId, 12, 8)}
                        <small className={styles.cellDetail}>Strategy {compact(row.strategyOrderHash, 8, 6)}</small>
                      </td>
                      <td>
                        <span className={styles.rowActions}>
                          <button
                            type="button"
                            className={styles.ghost}
                            onClick={() => setAllocationOrderId((current) => current === row.packageOrderId ? null : row.packageOrderId)}
                          >
                            {allocationOrderId === row.packageOrderId ? "Hide allocation" : "Verify allocation"}
                          </button>
                          {order?.state === "OPEN" ? (
                            <Link
                              href="/trade"
                              title="Adds this order to Recent package order in the Trade ticket's strategy panel, where it can be amended or cancelled."
                              onClick={() => recordPackageOrder({
                                strategyOrderHash: row.strategyOrderHash,
                                packageOrderId: row.packageOrderId,
                                participantId: row.participantId,
                                createdAt: row.recordedAt,
                              })}
                            >
                              Amend or cancel
                            </Link>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {allocationOrderId !== null && bookRows.some((row) => row.packageOrderId === allocationOrderId) ? (
            <div className={styles.cardBody}>
              <VerifiedAllocationFacts publicApiBaseUrl={publicApiBaseUrl} packageOrderId={allocationOrderId} />
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
