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
  const [creating, setCreating] = useState(false);
  const [closingDomain, setClosingDomain] = useState<string | null>(null);
  const [closeStatus, setCloseStatus] = useState<Record<string, string>>({});
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [approvals, setApprovals] = useState<Record<string, { draftId: string; owner: string; entry: string; recovery: string }>>({});
  const market = useQuery({
    queryKey: ["cross-domain-calendar-market", privateApiBaseUrl], enabled: privateApiBaseUrl !== null, retry: false, staleTime: 60_000, refetchInterval: 60_000,
    queryFn: async () => {
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/cross-domain/market`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Canonical calendar preparation is unavailable.");
      const value = await response.json() as { marketId: string; owner: string; preparationAccount: string; executionBudgetAvailable: boolean };
      if (value.marketId !== "base-arbitrum-calendar-v1" || !/^0x[0-9a-fA-F]{40}$/.test(value.owner)
        || !/^0x[0-9a-fA-F]{40}$/.test(value.preparationAccount)
        || typeof value.executionBudgetAvailable !== "boolean") throw new Error("Market configuration is invalid.");
      return value;
    },
  });
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
  const create = () => run(async () => {
    if (!market.data?.executionBudgetAvailable || !privateApiBaseUrl || !wallet.account
      || wallet.account.toLowerCase() !== market.data.owner.toLowerCase()) throw new Error("Connect the funded test account to prepare this market.");
    setCreating(true);
    try {
      const input = { owner: wallet.account, marketId: market.data.marketId, requestId: crypto.randomUUID(),
        expiresAt: String(Math.floor(Date.now() / 1_000) + 240) };
      const signature = await wallet.signTypedData("base", {
        domain: { name: "Naryx Cross-chain Preparation", version: "1", chainId: 84532, verifyingContract: market.data.preparationAccount },
        primaryType: "PrepareCalendar", types: { PrepareCalendar: [
          { name: "owner", type: "address" }, { name: "marketId", type: "string" },
          { name: "requestId", type: "string" }, { name: "expiresAt", type: "uint256" },
        ] }, message: input,
      });
      const created = await request(privateApiBaseUrl, "prepare", { ...input, signature });
      setIdentifier(created.draftId); setDraftId(created.draftId); setApprovals({});
    } finally { setCreating(false); }
  });
  const close = (domainId: string) => run(async () => {
    if (!value || !privateApiBaseUrl || !ownerMatches || value.job?.status !== "TERMINAL") throw new Error("Wait for coordinator reconciliation before closing.");
    const network = domainId === "eip155:84532" ? "base" : "arbitrum";
    const expected = value.draft.execution.domains.find(d => d.domain.domainId === domainId)!.envelope.account;
    const call = async (signature?: string) => {
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/cross-domain/exit`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(35_000),
        body: JSON.stringify({ draftId: value.draftId, domainId, ...(signature ? { signature } : {}) }),
      });
      if (!response.ok) throw new Error("Close preparation was refused. Refresh the package and check its current state.");
      return fromProtocolJson(await response.json()) as { state: string; domainId: string; envelope?: Envelope;
        transaction?: { to: string; data: string; value: string } };
    };
    setClosingDomain(domainId);
    try {
      const pendingKey = `naryx:calendar-close:${value.draftId}:${domainId}`;
      const pendingHash = sessionStorage.getItem(pendingKey);
      if (pendingHash && /^0x[0-9a-f]{64}$/i.test(pendingHash)) {
        if (!await wallet.waitForReceipt(network, pendingHash)) {
          sessionStorage.removeItem(pendingKey); throw new Error("The previous close reverted. Refresh before preparing a new approval.");
        }
        const reconciled = await call();
        const flat = reconciled.state === "CLOSED" || reconciled.state === "FLAT";
        if (flat) sessionStorage.removeItem(pendingKey);
        setCloseStatus(current => ({ ...current, [`${value.draftId}:${domainId}`]: flat ? "Confirmed flat" : "Finalized reconciliation is pending. No new transaction was sent." }));
        return;
      }
      const prepared = await call();
      if (prepared.state === "CLOSED" || prepared.state === "FLAT") {
        setCloseStatus(current => ({ ...current, [`${value.draftId}:${domainId}`]: "Confirmed flat" })); return;
      }
      const typed = prepared.envelope?.ownerTypedData;
      if (prepared.domainId !== domainId || prepared.state !== "PREPARED" || !typed
        || typed.primaryType !== "OwnerExecution" || typed.domain.chainId !== Number(domainId.slice(7))
        || typed.domain.verifyingContract.toLowerCase() !== expected.toLowerCase()) throw new Error("Close approval targets another account or chain.");
      const signed = await wallet.signTypedData(network, typed);
      const ready = await call(signed);
      if (ready.state !== "READY" || ready.domainId !== domainId || !ready.transaction
        || ready.transaction.to.toLowerCase() !== expected.toLowerCase() || ready.transaction.value !== "0") throw new Error("Close transaction is invalid.");
      const transactionHash = await wallet.sendTransaction(network, ready.transaction);
      sessionStorage.setItem(pendingKey, transactionHash);
      setCloseStatus(current => ({ ...current, [`${value.draftId}:${domainId}`]: "Submitted. Waiting for confirmation." }));
      if (!await wallet.waitForReceipt(network, transactionHash)) {
        sessionStorage.removeItem(pendingKey); throw new Error("Close transaction reverted. No successful close was recorded.");
      }
      const reconciled = await call();
      if (reconciled.state === "CLOSED" || reconciled.state === "FLAT") sessionStorage.removeItem(pendingKey);
      setCloseStatus(current => ({ ...current, [`${value.draftId}:${domainId}`]: reconciled.state === "CLOSED" || reconciled.state === "FLAT"
        ? "Confirmed flat" : "Transaction mined. Finalized position reconciliation is pending; refresh before retrying." }));
    } finally { setClosingDomain(null); }
  });

  return <section className={styles.card}>
    <div className={styles.cardHead}><h2>Cross-chain approvals</h2><span>Base + Arbitrum testnets</span></div>
    <div className={`${styles.cardBody} ${styles.lifecycleForm}`}>
      <p>Prepare a package, then approve entry and bounded recovery on each chain. Execution is coordinated, not cross-chain atomic.</p>
      {market.data && <div className={styles.lifecycleForm}>
        <p>Calendar spread: buy the near future on Base and sell the far future on Arbitrum. The funded test cohort uses 0.0001 base units and 1 mock USDC collateral per chain, with a maximum recovery loss of 0.10 mock USDC per chain. Mock tokens have no cash value.</p>
        <p>Preparation only signs a request. No trade is sent until all four execution approvals are submitted. Existing solver inventory is reserved within its testnet gas budget.</p>
        {!market.data.executionBudgetAvailable && <p role="status">New entries are paused until the worker gas allowances cover entry and full recovery.</p>}
        {!wallet.account ? <button className={styles.ghost} disabled={busy} onClick={() => modal.open()}>Connect wallet</button>
          : wallet.account.toLowerCase() !== market.data.owner.toLowerCase() ? <p>This market is limited to its funded test account.</p>
            : !wallet.onChain("base") ? <button className={styles.ghost} disabled={busy || wallet.switching}
              onClick={() => void wallet.switchNetwork("base")}>Switch to Base Sepolia</button>
            : <button className={styles.ghost} disabled={busy || !market.data.executionBudgetAvailable || (value !== undefined && !expired && value.state !== "EXPIRED")}
              onClick={() => void create()}>{creating ? "Preparing calendar spread..." : "Prepare calendar spread"}</button>}
      </div>}
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
      {value?.job?.status === "TERMINAL" && ownerMatches && <div className={styles.lifecycleForm}>
        <p>Close remaining positions after settlement. Each chain closes separately through your wallet and retains the original minimum recovery return. A close can be refused if losses exceed that bound.</p>
        {value.draft.execution.domains.map(domain => {
          const id = domain.domain.domainId;
          const network = id === "eip155:84532" ? "base" : "arbitrum";
          return <div key={id}>
            {!wallet.onChain(network) ? <button className={styles.ghost} disabled={busy || wallet.switching}
              onClick={() => void wallet.switchNetwork(network)}>Switch to {network === "base" ? "Base" : "Arbitrum"} Sepolia</button>
              : <button className={styles.ghost} disabled={busy} onClick={() => void close(id)}>
                {closingDomain === id ? "Closing and reconciling..." : `Close ${network === "base" ? "Base" : "Arbitrum"} position`}</button>}
            {closeStatus[`${value.draftId}:${id}`] && <p role="status">{closeStatus[`${value.draftId}:${id}`]}</p>}
          </div>;
        })}
      </div>}
    </div>
  </section>;
}
