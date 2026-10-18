"use client";

import { fromProtocolJson } from "@naryx/sdk";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { shortAddress, useWalletModal } from "@/features/wallet/wallet-modal";
import { useTerminal } from "../shell/terminal-context";
import styles from "./pages.module.css";

type TypedApproval = {
  domain: { chainId: number; verifyingContract: string; name: string; version: string };
  primaryType: string;
  types: Record<string, unknown>;
  message: { executionHash: string; callsHash: string };
};
type Envelope = { account: string; ownerTypedData: TypedApproval;
  execution: { risk: { marginQuoteAtoms: bigint }; fees: { protocolFeeAtoms: bigint; solverFeeAtoms: bigint } } };
type ApprovalView = {
  draftId: string; state: string; planHash: string | null; job?: { status: string };
  draft: { owner: string; plan: { prepareDeadline: bigint; compensationDeadline: bigint };
    execution: { domains: { domain: { domainId: string }; envelope: Envelope }[] };
    lanes: { domainId: string; recovery: Envelope; maximumRecoveryCostQuoteAtoms: bigint }[] };
};

async function request(origin: string, path: string, body?: unknown): Promise<ApprovalView> {
  const response = await fetch(`${origin}/internal/terminal/cross-domain/${path}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store", signal: AbortSignal.timeout(35_000),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(response.status === 404 ? "Preparation not found. Check the identifier."
    : response.status === 503 ? "Cross-chain wallet approval is unavailable."
      : "Approval was not accepted. Refresh the preparation and check your wallet.");
  const value = fromProtocolJson(await response.json()) as ApprovalView;
  if (!/^[0-9a-f]{64}$/.test(value.draftId) || !/^0x[0-9a-fA-F]{40}$/.test(value.draft.owner)
    || !["DRAFT", "RESERVING", "ADMITTED", "RELEASING", "EXPIRED"].includes(value.state)
    || typeof value.draft.plan.prepareDeadline !== "bigint" || typeof value.draft.plan.compensationDeadline !== "bigint"
    || value.draft.execution.domains.length !== 2 || value.draft.lanes.length !== 2) throw new Error("Preparation format is invalid.");
  const domains = new Set(value.draft.execution.domains.map(domain => domain.domain.domainId));
  if (domains.size !== 2 || !domains.has("eip155:84532") || !domains.has("eip155:421614")) throw new Error("Preparation is not on the approved testnets.");
  for (const domain of value.draft.execution.domains) {
    const recovery = value.draft.lanes.filter(lane => lane.domainId === domain.domain.domainId);
    if (recovery.length !== 1) throw new Error("Preparation is missing an exact recovery approval.");
    for (const envelope of [domain.envelope, recovery[0]!.recovery]) {
      const typed = envelope.ownerTypedData;
      if (typed.primaryType !== "OwnerExecution" || typed.domain.name !== "Naryx Multi Strategy Account"
        || typed.domain.version !== "1" || typed.domain.chainId !== Number(domain.domain.domainId.slice(7))
        || typed.domain.verifyingContract.toLowerCase() !== domain.envelope.account.toLowerCase()
        || envelope.account.toLowerCase() !== domain.envelope.account.toLowerCase()) throw new Error("Wallet authorization targets another chain or account.");
    }
  }
  return value;
}

export function CrossDomainApprovals() {
  const { privateApiBaseUrl } = useTerminal();
  const wallet = useEvmWallet();
  const modal = useWalletModal();
  const [identifier, setIdentifier] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [approvals, setApprovals] = useState<Record<string, { draftId: string; owner: string; entry: string; recovery: string }>>({});
  const preparation = useQuery({
    queryKey: ["cross-domain-wallet-approval", privateApiBaseUrl, draftId],
    enabled: privateApiBaseUrl !== null && draftId !== null,
    retry: false, refetchInterval: 10_000,
    queryFn: () => request(privateApiBaseUrl!, `drafts/${draftId}`),
  });
  const value = preparation.data;
  const ownerMatches = value !== undefined && wallet.account?.toLowerCase() === value.draft.owner.toLowerCase();
  const approved = (domainId: string) => {
    const approval = approvals[domainId];
    return ownerMatches && approval?.draftId === draftId && approval.owner === wallet.account?.toLowerCase();
  };
  const allApproved = value !== undefined && value.draft.execution.domains.every(domain => approved(domain.domain.domainId));
  const expired = value !== undefined && value.draft.plan.prepareDeadline <= BigInt(now);
  const run = async (operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Wallet approval failed. Please retry."); }
    finally { lock.current = false; setBusy(false); }
  };
  const sign = (domainId: string) => run(async () => {
    if (!ownerMatches || !value || expired || value.state !== "DRAFT") throw new Error("Connect the preparation owner and refresh before signing.");
    const network = domainId === "eip155:84532" ? "base" : "arbitrum";
    const domain = value.draft.execution.domains.find(domain => domain.domain.domainId === domainId)!;
    const recovery = value.draft.lanes.find(lane => lane.domainId === domainId)!;
    const entry = await wallet.signTypedData(network, domain.envelope.ownerTypedData);
    const recoverySignature = await wallet.signTypedData(network, recovery.recovery.ownerTypedData);
    setApprovals(current => ({ ...current, [domainId]: { draftId: value.draftId, owner: value.draft.owner.toLowerCase(), entry, recovery: recoverySignature } }));
  });
  const submit = () => run(async () => {
    if (!allApproved || !value || !privateApiBaseUrl || expired) throw new Error("Both chains must be approved before the preparation expires.");
    await request(privateApiBaseUrl, "authorize", { draftId: value.draftId,
      signatures: value.draft.execution.domains.map(domain => ({ domainId: domain.domain.domainId,
        entry: approvals[domain.domain.domainId]!.entry, recovery: approvals[domain.domain.domainId]!.recovery })) });
    await preparation.refetch();
  });

  return <section className={styles.card}>
    <div className={styles.cardHead}><h2>Cross-chain approvals</h2><span>Base + Arbitrum testnets</span></div>
    <div className={`${styles.cardBody} ${styles.lifecycleForm}`}>
      <p>Review a solver-prepared package, then approve entry and bounded recovery on each chain. Execution is coordinated, not cross-chain atomic. Inventory must be funded before admission.</p>
      <form className={styles.lifecycleForm} onSubmit={event => { event.preventDefault(); if (/^[0-9a-f]{64}$/.test(identifier)) { setDraftId(identifier); setApprovals({}); setError(null); } }}>
        <label className={styles.field}>Preparation identifier<input value={identifier} maxLength={64} placeholder="Paste the preparation identifier"
          disabled={busy} onChange={event => setIdentifier(event.target.value.trim().toLowerCase())} /></label>
        <button type="submit" className={styles.ghost} disabled={busy || !privateApiBaseUrl || !/^[0-9a-f]{64}$/.test(identifier)}>Review package</button>
      </form>
      {preparation.isFetching && !value && <p role="status">Loading preparation...</p>}
      {(error || preparation.error) && <p role="alert">{error ?? preparation.error?.message}</p>}
      {value && <>
        <p>Owner: <button className={styles.ghost} title={`Copy ${value.draft.owner}`} onClick={() => void run(() => navigator.clipboard.writeText(value.draft.owner))}>{shortAddress(value.draft.owner)}</button></p>
        <p role="status">{value.state === "RESERVING" ? "Approved. Waiting for funded inventory and chain admission."
          : value.state === "ADMITTED" ? `Submitted. Execution status: ${value.job?.status ?? "Pending reconciliation"}.`
            : value.state === "RELEASING" ? "Expired before admission. Unused reservations are being released."
              : expired || value.state === "EXPIRED" ? "This preparation has expired. Request a new package."
                : "Review both chain permissions before submitting."}</p>
        <div className={styles.scroll}><table className={styles.table}><thead><tr><th>Chain</th><th>Margin (quote atoms)</th><th>Service fees (quote atoms)</th><th>Recovery loss cap (quote atoms)</th><th>Approval</th></tr></thead>
          <tbody>{value.draft.execution.domains.map(domain => {
            const network = domain.domain.domainId === "eip155:84532" ? "base" : "arbitrum";
            const recovery = value.draft.lanes.find(lane => lane.domainId === domain.domain.domainId)!;
            const approvedHere = approved(domain.domain.domainId);
            return <tr key={domain.domain.domainId}><td>{network === "base" ? "Base Sepolia" : "Arbitrum Sepolia"}</td>
              <td>{domain.envelope.execution.risk.marginQuoteAtoms.toString()}</td>
              <td>{(domain.envelope.execution.fees.protocolFeeAtoms + domain.envelope.execution.fees.solverFeeAtoms).toString()}</td>
              <td>{recovery.maximumRecoveryCostQuoteAtoms.toString()}</td>
              <td>{!wallet.account ? <button className={styles.connect} onClick={() => modal.open("evm")}>Connect wallet</button>
                : !ownerMatches ? "Connect the owner wallet"
                  : <button className={styles.ghost} disabled={busy || wallet.switching || wallet.awaitingWallet || expired || value.state !== "DRAFT" || approvedHere}
                    onClick={() => { if (wallet.onChain(network)) void sign(domain.domain.domainId); else void run(() => wallet.switchNetwork(network)); }}>
                    {approvedHere ? "Approved" : wallet.onChain(network) ? "Approve entry + recovery" : `Switch to ${network === "base" ? "Base" : "Arbitrum"}`}</button>}</td></tr>;
          })}</tbody></table></div>
        <p>Recovery authorization expires {new Date(Number(value.draft.plan.compensationDeadline) * 1000).toLocaleString()}.</p>
        <button className={styles.connect} disabled={busy || wallet.awaitingWallet || !allApproved || expired || value.state !== "DRAFT"} onClick={() => void submit()}>
          {busy ? "Waiting for approval..." : "Submit approved package"}</button>
        {value.planHash && <details><summary>Execution identifier</summary><code style={{ overflowWrap: "anywhere" }}>{value.planHash}</code></details>}
      </>}
    </div>
  </section>;
}
