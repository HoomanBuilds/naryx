"use client";

import Link from "next/link";
import { NaryxClient } from "@naryx/sdk";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ChainIcon } from "@/features/brand/chain-icons";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import type { OwnerPackageEntry, PackageLifecycleResponse } from "../private-http-terminal-provider";
import { DOMAIN_META, useTerminal } from "../shell/terminal-context";
import { attemptsOf, type RecordedAttempt } from "../shell/attempt-index";
import styles from "./pages.module.css";

const FLOW_LABEL: Readonly<Record<RecordedAttempt["flow"], string>> = {
  devnet: "Devnet execution",
  conformance: "Local conformance",
  hyperliquid: "Hyperliquid testnet",
  base: "Base Sepolia",
  arbitrum: "Arbitrum Sepolia",
};

/** Public block explorers for the EVM test networks whose outcomes the service records. */
const EXPLORER_TX: Readonly<Partial<Record<RecordedAttempt["domain"], string>>> = {
  base: "https://sepolia.basescan.org/tx/",
  arbitrum: "https://sepolia.arbiscan.io/tx/",
};

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
function readable(attempt: RecordedAttempt) {
  return attempt.flow === "devnet" || attempt.flow === "conformance";
}

/** Base and Arbitrum attempts carry the outcome the service observed on chain. */
function observed(attempt: RecordedAttempt) {
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

/** A package the service recorded for a connected wallet, as an Activity row with its service state and evidence. */
type Row = RecordedAttempt & Readonly<{
  listed?: true;
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
    serviceState: entry.state,
    transactionHash: entry.transactionHash,
    blockNumber: entry.blockNumber,
    receiptHash: entry.receiptHash,
  };
}

export function ActivityView() {
  const { attempts: localAttempts, privateProvider, publicApiBaseUrl, clearAttempts } = useTerminal();
  const [openId, setOpenId] = useState<string | null>(null);
  const [proofReceiptHash, setProofReceiptHash] = useState<string | null>(null);
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
  const strategyReceiptsLoading = strategyReceiptQueries.some((query) => query.isPending);
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
      refetchInterval: 15_000,
      queryFn: ({ signal }: { signal: AbortSignal }): Promise<PackageLifecycleResponse> => {
        if (!privateProvider) throw new Error("Private service not configured.");
        return privateProvider.getPackageLifecycle(attempt.attemptId, signal);
      },
    })),
  });
  const openIndex = attempts.findIndex((attempt) => attempt.attemptId === openId);
  const openAttempt = openIndex >= 0 ? attempts[openIndex] : undefined;
  const openLifecycle = openIndex >= 0 ? lifecycles[openIndex]?.data ?? null : null;
  const explorer = openAttempt === undefined ? undefined : EXPLORER_TX[openAttempt.domain];

  return (
    <main className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1>Activity</h1>
          <p>Every package your connected wallets started, on any device, with its durable state and the receipts the service recorded for it.</p>
        </div>
        {attempts.length > 0 ? (
          <div className={styles.headActions}>
            <button type="button" className={styles.ghost} onClick={() => { setOpenId(null); setProofReceiptHash(null); clearAttempts(owners); }}>
              Clear list
            </button>
          </div>
        ) : null}
      </div>

      {privateProvider === null && attempts.length > 0 ? (
        <p className={styles.notice}>The private terminal service is not configured, so lifecycle state cannot be read. The list below is this browser&apos;s record only.</p>
      ) : null}

      <section className={styles.card} aria-labelledby="strategy-receipts-title">
        <div className={styles.cardHead}>
          <h2 id="strategy-receipts-title">Canonical strategy receipts</h2>
          <p>Final package economics and evidence, indexed from the connected wallet&apos;s durable strategy orders.</p>
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
                        : strategyReceiptsLoading
                          ? "Loading strategy receipts"
                          : strategyReceiptsUnavailable
                            ? "Strategy receipts unavailable"
                            : "No strategy receipts yet"}</strong>
                      <p>{owners.length === 0
                        ? "Connect a Solana or EVM wallet to load its canonical strategy receipt history."
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
            {openAttempt !== undefined && observed(openAttempt) ? (
              openAttempt.serviceState ? (
                <dl className={styles.facts}>
                  <dt>State</dt>
                  <dd>{stateText(openAttempt.serviceState)}</dd>
                  <dt>Transaction</dt>
                  <dd className={styles.mono}>
                    {openAttempt.transactionHash && explorer ? (
                      <a href={`${explorer}${openAttempt.transactionHash}`} target="_blank" rel="noopener noreferrer" title={openAttempt.transactionHash}>
                        {compact(openAttempt.transactionHash, 12, 8)}
                      </a>
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
          </div>
        </section>
      ) : null}
    </main>
  );
}
