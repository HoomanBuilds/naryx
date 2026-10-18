"use client";

import { useState } from "react";
import Link from "next/link";
import { encodeFunctionData, getAddress, isAddress, parseAbi } from "viem";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import styles from "./pages.module.css";

const ABI = parseAbi([
  "function proposeOwnerTransfer(address newOwner,uint64 expiresAt)",
  "function acceptOwnerTransfer()",
  "function cancelOwnerTransfer()",
]);
type Context = {
  version: 1; chainId: 84532; strategyId: string; strategyAccount: string; owner: string;
  pendingOwner: string; pendingOwnerExpiresAt: string; chainTimestamp: string; bookOwner: string;
};
type Action = "propose" | "accept" | "cancel";
type Pending = { action: Action; hash: string; account: string; expectedOwner: string };
const shortAddress = (value: string) => `${value.slice(0, 6)}...${value.slice(-4)}`;

function readContext(value: unknown, strategyId: string): Context {
  const c = value as Context | null;
  if (!c || c.version !== 1 || c.chainId !== 84532 || c.strategyId !== strategyId
    || !isAddress(c.strategyAccount) || !isAddress(c.owner) || !isAddress(c.pendingOwner) || !isAddress(c.bookOwner)
    || !/^\d{1,20}$/.test(c.pendingOwnerExpiresAt) || !/^\d{1,20}$/.test(c.chainTimestamp)) {
    throw new Error("The transfer account response is invalid. Nothing was signed.");
  }
  return c;
}

export function BaseStrategyTransfer({ baseUrl, initialStrategyId, onEvidence }: {
  baseUrl: string; initialStrategyId: string; onEvidence(strategyId: string, hash: string): void;
}) {
  const wallet = useEvmWallet();
  const [strategyId, setStrategyId] = useState(initialStrategyId);
  const [recipient, setRecipient] = useState("");
  const [context, setContext] = useState<Context | null>(null);
  const [confirmedScope, setConfirmedScope] = useState(false);
  const [busy, setBusy] = useState<Action | "read" | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState("");
  const [acceptedHash, setAcceptedHash] = useState<string | null>(null);
  const storageKey = `naryx.base-transfer.${strategyId}`;
  const fetchContext = async () => {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(strategyId)) throw new Error("Enter a recorded strategy id.");
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/strategies/${encodeURIComponent(strategyId)}/transfer-context`, { cache: "no-store" });
    if (!response.ok) throw new Error(response.status === 503 ? "Account transfers are not activated on this release." : "This strategy has no supported transferable Base account.");
    const next = readContext(await response.json(), strategyId);
    setContext(next);
    return next;
  };
  const observe = async (sent: Pending) => {
    const receipt = await wallet.waitForReceiptIdentity("base", sent.hash);
    if (receipt.transactionHash !== sent.hash.toLowerCase()) {
      localStorage.removeItem(storageKey); setPending(null);
      throw new Error("The wallet replaced this transaction. No transfer is confirmed here. Refresh the account and inspect the replacement in your wallet.");
    }
    if (!receipt.success) {
      localStorage.removeItem(storageKey); setPending(null);
      throw new Error("The transfer transaction reverted. The account was not transferred.");
    }
    let matched = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const next = await fetchContext();
      if (next.strategyAccount.toLowerCase() !== sent.account.toLowerCase()) throw new Error("The transfer account changed. Check the transaction before continuing.");
      const actualOwner = sent.action === "accept" ? next.owner : next.pendingOwner;
      if (actualOwner.toLowerCase() === sent.expectedOwner.toLowerCase()) { matched = true; break; }
      setNotice("Transaction confirmed. Waiting for the account read to catch up. Do not resubmit.");
      if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 1_500));
    }
    if (!matched) throw new Error("The transaction confirmed, but the account read does not match yet. Check the transaction, then use Check pending transaction without resubmitting.");
    localStorage.removeItem(storageKey); setPending(null);
    if (sent.action === "accept") {
      setAcceptedHash(sent.hash);
      try { localStorage.setItem(`${storageKey}.accepted`, sent.hash); } catch { /* The confirmed hash remains visible when browser storage is unavailable. */ }
      onEvidence(strategyId, sent.hash.slice(2));
      setNotice("Account transfer confirmed. Wait for finality, then reconcile the strategy book below with both owner signatures and this transaction hash.");
    } else setNotice(sent.action === "propose" ? "Proposal confirmed. The incoming owner must connect and accept before it expires." : "Proposal cancelled onchain.");
  };
  const load = async () => {
    setBusy("read"); setNotice("");
    try {
      await fetchContext();
      const accepted = localStorage.getItem(`${storageKey}.accepted`);
      if (accepted && /^0x[0-9a-f]{64}$/i.test(accepted)) setAcceptedHash(accepted);
      const saved = localStorage.getItem(storageKey);
      const sent: Pending | null = pending ?? (saved ? JSON.parse(saved) : null);
      if (sent && ["propose", "accept", "cancel"].includes(sent.action) && /^0x[0-9a-f]{64}$/i.test(sent.hash) && isAddress(sent.account) && isAddress(sent.expectedOwner)) {
        setPending(sent); await observe(sent);
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : "Transfer status is unavailable."); }
    finally { setBusy(null); }
  };
  const send = async (action: Action) => {
    setBusy(action); setNotice("");
    try {
      const fresh = await fetchContext();
      const signer = wallet.account?.toLowerCase();
      if (!wallet.onChain("base")) throw new Error("Switch to Base Sepolia before continuing.");
      if (action === "accept" ? signer !== fresh.pendingOwner.toLowerCase() : signer !== fresh.owner.toLowerCase()) {
        throw new Error("The connected wallet cannot perform this account action.");
      }
      if (action !== "cancel" && !confirmedScope) throw new Error("Review and confirm the whole-account transfer first.");
      let data;
      if (action === "propose") {
        if (!isAddress(recipient) || /^0x0{40}$/i.test(recipient) || [fresh.owner, fresh.strategyAccount].some(a => a.toLowerCase() === recipient.toLowerCase())) {
          throw new Error("Enter a different valid incoming owner address.");
        }
        data = encodeFunctionData({ abi: ABI, functionName: "proposeOwnerTransfer", args: [getAddress(recipient), BigInt(fresh.chainTimestamp) + BigInt(3600)] });
      } else if (action === "accept") {
        if (BigInt(fresh.pendingOwnerExpiresAt) <= BigInt(fresh.chainTimestamp)) throw new Error("This proposal expired. Ask the current owner to propose again.");
        data = encodeFunctionData({ abi: ABI, functionName: "acceptOwnerTransfer" });
      } else data = encodeFunctionData({ abi: ABI, functionName: "cancelOwnerTransfer" });
      const hash = await wallet.sendTransaction("base", { to: fresh.strategyAccount, data, value: "0" });
      const sent = { action, hash, account: fresh.strategyAccount,
        expectedOwner: action === "propose" ? recipient : action === "accept" ? fresh.pendingOwner : "0x0000000000000000000000000000000000000000" };
      setPending(sent);
      try { localStorage.setItem(storageKey, JSON.stringify(sent)); } catch { setNotice("Browser storage is unavailable. Keep this page open until the transaction confirms."); }
      await observe(sent);
    } catch (error) { setNotice(error instanceof Error ? error.message : "The account action failed. Check the transaction before retrying."); }
    finally { setBusy(null); }
  };
  const disabled = busy !== null || pending !== null || wallet.switching;
  const isOwner = context !== null && wallet.account?.toLowerCase() === context.owner.toLowerCase();
  const isIncoming = context !== null && wallet.account?.toLowerCase() === context.pendingOwner.toLowerCase()
    && BigInt(context.pendingOwnerExpiresAt) > BigInt(context.chainTimestamp);
  return <div className={styles.cardBody}>
    <h3>Transfer the underlying Base account</h3>
    <p>This transfers the entire account, including idle tokens, margin and its open package. Existing delegations end. The incoming owner can manage positions and withdraw from this account.</p>
    <label className={styles.field}><span>Recorded strategy id</span><input value={strategyId} disabled={busy !== null || pending !== null} onChange={e => { setStrategyId(e.target.value.trim()); setContext(null); setAcceptedHash(null); setConfirmedScope(false); }} /></label>
    <button type="button" className={styles.ghost} disabled={busy !== null} onClick={() => void load()}>{busy === "read" ? "Checking account..." : pending ? "Check pending transaction" : "Read transfer account"}</button>
    {context ? <>
      <p>Account <a href={`https://sepolia.basescan.org/address/${context.strategyAccount}`} title={context.strategyAccount} target="_blank" rel="noreferrer">{shortAddress(context.strategyAccount)}</a></p>
      <p>Current owner: <a href={`https://sepolia.basescan.org/address/${context.owner}`} title={context.owner} target="_blank" rel="noreferrer">{shortAddress(context.owner)}</a>. Recorded owner: <a href={`https://sepolia.basescan.org/address/${context.bookOwner}`} title={context.bookOwner} target="_blank" rel="noreferrer">{shortAddress(context.bookOwner)}</a>.</p>
      <label className={styles.field}><span>Incoming owner address</span><input value={recipient} disabled={disabled} onChange={e => { setRecipient(e.target.value.trim()); setConfirmedScope(false); }} placeholder="0x..." spellCheck={false} /></label>
      <label><input type="checkbox" checked={confirmedScope} disabled={disabled} onChange={e => setConfirmedScope(e.target.checked)} /> I understand that all assets and positions in this account transfer, not just this strategy-book record.</label>
      {!wallet.account ? wallet.connectors.map(connector => <button type="button" key={connector.uid} className={styles.connect} disabled={wallet.connecting} onClick={() => void wallet.connect(connector)}>Connect {connector.name}</button>)
        : !wallet.onChain("base") ? <button type="button" className={styles.connect} disabled={wallet.switching} onClick={() => void wallet.switchNetwork("base")}>Switch to Base Sepolia</button>
          : <div className={styles.lifecycleActions}>
            {isOwner ? <button type="button" className={styles.connect} disabled={disabled || !confirmedScope} onClick={() => void send("propose")}>{busy === "propose" ? "Proposing transfer..." : "Propose transfer"}</button> : null}
            {isIncoming ? <button type="button" className={styles.connect} disabled={disabled || !confirmedScope} onClick={() => void send("accept")}>{busy === "accept" ? "Accepting transfer..." : "Accept whole account"}</button> : null}
            {isOwner && !/^0x0{40}$/i.test(context.pendingOwner) ? <button type="button" className={styles.ghost} disabled={disabled} onClick={() => void send("cancel")}>{busy === "cancel" ? "Cancelling..." : "Cancel proposal"}</button> : null}
          </div>}
      {isOwner ? <Link className={styles.ghost} href={`/trade?lane=base&template=cash-and-carry-v1&action=EXIT&mode=exit&strategyAccount=${context.strategyAccount}`}>Manage acquired account and exit</Link> : null}
    </> : null}
    {pending ? <p>Submitted: <a href={`https://sepolia.basescan.org/tx/${pending.hash}`} target="_blank" rel="noreferrer">Check transaction</a>. Do not resubmit while confirmation is unknown.</p> : null}
    {acceptedHash ? <p>Book evidence: <a href={`https://sepolia.basescan.org/tx/${acceptedHash}`} title={acceptedHash} target="_blank" rel="noreferrer">{shortAddress(acceptedHash)}</a> <button type="button" className={styles.ghost} onClick={() => void navigator.clipboard.writeText(acceptedHash.slice(2)).catch(() => setNotice("Clipboard is unavailable. Copy the transaction hash from the explorer."))}>Copy hash</button></p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </div>;
}
