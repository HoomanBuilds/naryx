"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fromProtocolJson, toProtocolJson, testPoolConfig, testPoolRequest, testPoolConsent,
  testPoolWithdrawal, verifyTestPoolChallenge, type TestPoolConfig } from "@naryx/sdk";
import { formatUnits, parseUnits } from "viem";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { shortAddress, useWalletModal } from "@/features/wallet/wallet-modal";
import styles from "./pages.module.css";
import cash from "./native-cash.module.css";

type Member = { owner: string; enrolled: boolean; balanceQuoteAtoms: bigint; poolBusy: boolean; observedAtMs: number;
  operations: { id: string; kind: string; state: string }[] };

async function request(baseUrl: string, command: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/hyperliquid-pool/${command}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toProtocolJson(body)),
    cache: "no-store", signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(response.status === 409
    ? "This request was refused. Check account access, balances and pending operations before retrying."
    : "Pool service is unavailable. Refresh your balance before sending another request.");
  return fromProtocolJson(await response.json());
}

export function HyperliquidTestPool({ baseUrl }: { baseUrl: string | null }) {
  const query = useQuery({ queryKey: ["test-pool-config", baseUrl], enabled: baseUrl !== null, retry: false,
    staleTime: 60_000, queryFn: async () => testPoolConfig(await request(baseUrl!, "config", {})) });
  if (!baseUrl || !query.data) return null;
  return <PoolAccount key={`${baseUrl}:${query.data.bindingHash}`} baseUrl={baseUrl} config={query.data} />;
}

function PoolAccount({ baseUrl, config }: { baseUrl: string; config: TestPoolConfig }) {
  const wallet = useEvmWallet();
  const modal = useWalletModal();
  const owner = wallet.account?.toLowerCase() as `0x${string}` | undefined;
  const activeOwner = useRef(owner);
  useEffect(() => { activeOwner.current = owner; return () => { activeOwner.current = undefined; }; }, [owner]);
  const [member, setMember] = useState<Member | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [transferHash, setTransferHash] = useState("");
  const [transferTime, setTransferTime] = useState("");
  const [epochPayload, setEpochPayload] = useState("");
  const lock = useRef(false);
  const account = member?.owner === owner ? member : null;
  const disabled = busy !== null || wallet.awaitingWallet || wallet.switching;
  const guard = () => {
    if (!owner || activeOwner.current !== owner) throw new Error("Wallet changed. Restart this request with your current account.");
  };
  const signedRequest = async (action: string, payload: unknown) => {
    if (!owner) throw new Error("Connect your wallet first.");
    guard();
    const body = { owner, action, payload, expiresAtMs: Date.now() + 120_000 };
    const expected = testPoolRequest(config, owner, action, payload, body.expiresAtMs);
    const challenge = await request(baseUrl, "challenge", body);
    guard();
    verifyTestPoolChallenge(expected, challenge);
    const signature = await wallet.signTypedData("arbitrum", challenge);
    guard();
    return request(baseUrl, "execute", { ...body, signature });
  };
  const refresh = async () => {
    const next = await signedRequest("member", {}) as Member;
    guard();
    if (next.owner !== owner || typeof next.balanceQuoteAtoms !== "bigint" || !Array.isArray(next.operations)) {
      throw new Error("Pool returned an unexpected account. No balance was accepted.");
    }
    setMember(next);
  };
  const run = async (label: string, action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(label); setMessage(null);
    try {
      if (!owner) { modal.open(); return; }
      if (!wallet.onChain("arbitrum")) { await wallet.switchNetwork("arbitrum"); return; }
      await action();
    } catch (error) {
      setMessage(error instanceof Error && /cancel|reject|denied/i.test(error.message)
        ? "Cancelled in your wallet. Refresh to check any previously submitted operation."
        : error instanceof Error ? error.message : "Request failed. Refresh before retrying.");
    } finally { lock.current = false; setBusy(null); }
  };
  const withdrawal = async () => {
    if (!owner || !/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,6})?$/.test(amount)) throw new Error("Enter a positive test USDC amount with at most six decimals.");
    const debitQuoteAtoms = parseUnits(amount, 6);
    if (!account || debitQuoteAtoms <= BigInt(0) || debitQuoteAtoms > account.balanceQuoteAtoms) throw new Error("Amount exceeds your last verified pool balance.");
    const body = { id: `withdraw-${crypto.randomUUID()}`, owner, debitQuoteAtoms, expiresAtMs: Date.now() + 600_000 };
    const challenge = await request(baseUrl, "withdrawal-challenge", { request: body });
    guard();
    verifyTestPoolChallenge(testPoolWithdrawal(config, body), challenge);
    const signature = await wallet.signTypedData("arbitrum", challenge);
    guard();
    await request(baseUrl, "withdrawal", { request: body, signature });
    const result = await signedRequest("withdrawal-submit", { id: body.id }) as { status: string };
    setMessage(`Withdrawal ${result.status.toLowerCase().replaceAll("_", " ")}. It is not complete until venue receipts reconcile.`);
    await refresh();
  };
  const proof = () => {
    if (!/^0x[0-9a-f]{64}$/.test(transferHash) || !/^[1-9][0-9]{0,15}$/.test(transferTime)
      || !Number.isSafeInteger(Number(transferTime))) throw new Error("Enter the testnet transfer hash and its timestamp in milliseconds.");
    return { transferHash, transferTimeMs: Number(transferTime) };
  };
  return <section className={styles.card} aria-labelledby="test-pool-title">
    <div className={styles.cardHead}><h2 id="test-pool-title">Shared test pool</h2><span>Hyperliquid Testnet</span></div>
    <div className={cash.body}>
      <p className={cash.terms}>{config.custody === "CUSTODIAL_TESTNET_POOL_V2" ? "Open testnet enrollment with signed custody consent." : "Optional custodial mode for approved test wallets."} Naryx controls the pooled account; your balance is a claim in its ledger, not a separate venue position. Your normal trading account is unchanged. Do not send real funds. Pooled trading requires separately signed mandates from all participating owners.</p>
      <dl className={cash.metrics}>
        <div><dt>Pool account</dt><dd><button type="button" title={config.poolAccount} onClick={() => void navigator.clipboard.writeText(config.poolAccount).catch(() => setMessage("Could not copy the pool address."))}>{shortAddress(config.poolAccount)}</button></dd></div>
        <div><dt>Pool cap</dt><dd>{formatUnits(config.maximumTotalQuoteAtoms, 6)} test USDC</dd></div>
        <div><dt>Your last verified balance</dt><dd>{account ? `${formatUnits(account.balanceQuoteAtoms, 6)} test USDC` : "Sign to view"}</dd></div>
        <div><dt>Account status</dt><dd>{account ? account.poolBusy ? "Operation in progress" : account.enrolled ? "Enrolled" : "Consent required" : "Not verified"}</dd></div>
      </dl>
      <div className={cash.controls}>
        <button type="button" className={styles.actionBtn} disabled={disabled} onClick={() => void run("Verifying account...", refresh)}>{busy === "Verifying account..." ? busy : !owner ? "Connect wallet" : !wallet.onChain("arbitrum") ? "Switch to Arbitrum Sepolia" : "Sign to refresh balance"}</button>
        {account && !account.enrolled ? <button type="button" className={styles.actionBtn} disabled={disabled} onClick={() => void run("Confirming custody consent...", async () => {
          const challenge = await request(baseUrl, "consent", { owner });
          guard();
          verifyTestPoolChallenge(testPoolConsent(config, owner!), challenge);
          const signature = await wallet.signTypedData("arbitrum", challenge);
          guard();
          await request(baseUrl, "enroll", { owner, signature }); await refresh();
        })}>Review custody consent</button> : null}
      </div>
      {account?.enrolled ? <>
        <div className={cash.controls}>
          <label>Withdraw to your connected wallet<span className={cash.input}><input aria-label="Pool withdrawal amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /><span>test USDC</span></span></label>
          <button type="button" className={styles.actionBtn} disabled={disabled || account.poolBusy || account.balanceQuoteAtoms === BigInt(0)} onClick={() => void run("Authorizing withdrawal...", withdrawal)}>Review withdrawal</button>
        </div>
        <details className={cash.review}><summary>Reconcile a testnet transfer</summary>
          <p className={cash.terms}>Use the Hyperliquid Testnet transfer record. Deposits are credited only after both venue ledgers match. Check the pool cap before sending test funds. Pending withdrawals lock new pool operations until reconciled.</p>
          <div className={cash.controls}>
            <label>Transfer hash<input value={transferHash} onChange={event => setTransferHash(event.target.value.trim().toLowerCase())} placeholder="0x..." /></label>
            <label>Transfer timestamp (ms)<input inputMode="numeric" value={transferTime} onChange={event => setTransferTime(event.target.value.trim())} /></label>
            <button type="button" className={styles.actionBtn} disabled={disabled || account.poolBusy} onClick={() => void run("Reconciling deposit...", async () => {
              const value = proof(); await signedRequest("deposit", { id: `deposit-${value.transferHash}`, ...value }); await refresh(); setMessage("Deposit reconciled to venue backing.");
            })}>Verify deposit</button>
          </div>
          {account.operations.filter(item => item.kind === "WITHDRAWAL" && item.state === "PENDING").map(item => <div key={item.id} className={cash.controls}>
            <span title={item.id}>{item.id.slice(0, 18)}...</span>
            <button type="button" className={styles.actionBtn} disabled={disabled} onClick={() => void run("Checking withdrawal...", async () => {
              const result = await signedRequest("withdrawal-submit", { id: item.id }) as { status: string };
              setMessage(result.status.toLowerCase().replaceAll("_", " ")); await refresh();
            })}>Resume authorized withdrawal</button>
            <button type="button" className={styles.actionBtn} disabled={disabled} onClick={() => void run("Reconciling withdrawal...", async () => {
              await signedRequest("withdrawal-complete", { id: item.id, ...proof() }); await refresh(); setMessage("Withdrawal reconciled.");
            })}>Verify receipt</button>
            <button type="button" className={styles.actionBtn} disabled={disabled} onClick={() => void run("Checking expiry...", async () => {
              await signedRequest("withdrawal-release", { id: item.id }); await refresh(); setMessage("Expired, unsubmitted withdrawal released.");
            })}>Release expired request</button>
          </div>)}
        </details>
        {config.custody === "CUSTODIAL_TESTNET_POOL_V2" && <details className={cash.review}><summary>Submit a signed pooled strategy</summary>
          <p className={cash.terms}>Import a protocol-encoded epoch plan and all owner authorizations. The plan must include two funded traders and a consenting recovery sponsor. Every participant signs the exact plan and their loss and fee limits. Naryx reconciles and closes the epoch automatically; this does not authorize future trades.</p>
          <textarea aria-label="Signed pooled strategy" value={epochPayload} maxLength={262144} rows={5}
            onChange={event => setEpochPayload(event.target.value)} placeholder={'{"plan": {...}, "authorizations": [...]}'} />
          <button type="button" className={styles.actionBtn} disabled={disabled || account.poolBusy || !epochPayload.trim()}
            onClick={() => void run("Submitting signed strategy...", async () => {
              const payload = fromProtocolJson(JSON.parse(epochPayload)) as { plan?: { mandates?: { owner: string }[] }; authorizations?: unknown[] };
              if (!payload.plan?.mandates?.some(mandate => mandate.owner === owner) || !Array.isArray(payload.authorizations)) throw new Error("Import a fully authorized plan that includes your wallet.");
              const result = await request(baseUrl, "epoch-submit", payload) as { status: string; operationId: string };
              setMessage(`Strategy ${result.operationId} authorized. Execution and close are pending venue reconciliation.`);
              await refresh();
            })}>Submit owner-authorized strategy</button>
        </details>}
      </> : null}
      {busy ? <p role="status">{busy}</p> : null}
      {message ? <p role="status">{message}</p> : null}
    </div>
  </section>;
}
