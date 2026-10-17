"use client";

import { useEffect, useRef, useState } from "react";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import styles from "./trading-terminal.module.css";

type SetupStatus = {
  environment: "TESTNET";
  owner: string;
  stage: "NOT_ENROLLED" | "CHALLENGE" | "PREPARED" | "SUBMITTED" | "APPROVAL_PENDING" | "ACTIVE";
  agentAddress: string | null;
  typedData?: unknown;
  approvalTypedData?: unknown;
};

function reviewedData(value: unknown, owner: string, agentAddress?: string | null) {
  const data = value as { domain?: { name?: string; version?: string; chainId?: number; verifyingContract?: string };
    primaryType?: string; message?: Record<string, unknown> };
  if (data?.domain?.chainId !== 421614 || data.domain.version !== "1" || !data.message) throw new Error("Account setup payload is invalid.");
  if (agentAddress) {
    if (data.domain.name !== "HyperliquidSignTransaction" || data.primaryType !== "HyperliquidTransaction:ApproveAgent"
      || data.domain.verifyingContract !== "0x0000000000000000000000000000000000000000"
      || data.message.hyperliquidChain !== "Testnet" || data.message.agentAddress !== agentAddress
      || data.message.type !== "approveAgent" || data.message.signatureChainId !== "0x66eee") throw new Error("Trading-wallet approval does not match this testnet account.");
  } else if (data.domain.name !== "Naryx Hyperliquid Testnet Enrollment" || data.primaryType !== "Enrollment"
    || data.message.owner !== owner || data.message.environment !== "testnet") throw new Error("Enrollment does not match your connected wallet.");
  return value;
}

export function HyperliquidAccountSetup({ apiOrigin }: { apiOrigin: string | null }) {
  const wallet = useEvmWallet();
  const owner = wallet.account?.toLowerCase() ?? null;
  const currentOwner = useRef(owner);
  useEffect(() => { currentOwner.current = owner; }, [owner]);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endpoint = apiOrigin ? `${apiOrigin.replace(/\/$/, "")}/internal/terminal/hyperliquid-testnet/enrollment` : null;

  useEffect(() => {
    if (!owner || !endpoint) return;
    const controller = new AbortController();
    void fetch(`${endpoint}/status?owner=${owner}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Account setup status is unavailable.");
        const result = await response.json() as SetupStatus;
        if (result.owner !== owner || result.environment !== "TESTNET") throw new Error("Account setup returned the wrong account.");
        if (currentOwner.current === owner) { setStatus(result); setError(null); }
      }).catch(() => { if (!controller.signal.aborted) setError("Account setup is unavailable. Retry shortly."); });
    return () => controller.abort();
  }, [endpoint, owner]);

  if (!owner || !endpoint) return null;
  const active = status?.owner === owner && status.stage === "ACTIVE";
  if (active) return <p className={styles.reviewNotice}>Your Hyperliquid testnet account is enabled. Each trade still checks approval, balances and account policy.</p>;
  const stage = status?.owner === owner ? status.stage : "NOT_ENROLLED";
  const checking = stage === "SUBMITTED" || stage === "APPROVAL_PENDING";
  const needsSwitch = !checking && !wallet.onChain("arbitrum");
  const post = async (action: string, body: Record<string, unknown>) => {
    if (currentOwner.current !== owner) throw new Error("Wallet changed. Restart account setup.");
    const response = await fetch(`${endpoint}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, ...body }), signal: AbortSignal.timeout(40_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? "Account setup could not be verified.");
    if (result.owner !== owner || result.environment !== "TESTNET") throw new Error("Account setup returned the wrong account.");
    if (currentOwner.current === owner) setStatus(result);
    return result as SetupStatus;
  };
  const advance = async () => {
    if (busy) return;
    setError(null); setBusy("Preparing...");
    try {
      if (needsSwitch) { await wallet.switchNetwork("arbitrum"); return; }
      if (checking) { setBusy("Verifying approval..."); await post("confirm", {}); return; }
      const next = await post("challenge", {});
      if (next.stage === "ACTIVE") return;
      if (next.stage === "CHALLENGE") {
        setBusy("Confirm enrollment in wallet...");
        const signature = await wallet.signTypedData("arbitrum", reviewedData(next.typedData, owner));
        await post("prepare", { signature });
      } else if (next.stage === "PREPARED") {
        setBusy("Approve trading wallet...");
        const signature = await wallet.signTypedData("arbitrum", reviewedData(next.approvalTypedData, owner, next.agentAddress));
        await post("confirm", { signature });
      } else await post("confirm", {});
    } catch (cause) {
      if (currentOwner.current === owner) setError(cause instanceof Error ? cause.message : "Account setup failed. Retry verification.");
    } finally { setBusy(null); }
  };
  return <section className={styles.executionReview} aria-label="Hyperliquid account setup">
    <h3>Enable your trading account</h3>
    <p className={styles.reviewNotice}>Your funds stay in your own Hyperliquid Testnet account. Naryx stores an encrypted API key with trading authority, not your wallet key. Venue approval is not a market-specific permission.</p>
    <p className={styles.reviewNotice}>Use Standard accounts with isolated margin for BTC and supported HIP-3 markets. Close existing positions and orders before enrollment. Fund each required testnet market separately.</p>
    {status?.owner === owner && status.agentAddress ? <p className={styles.reviewNotice}>
      API wallet: <button type="button" title={status.agentAddress} onClick={() => void navigator.clipboard.writeText(status.agentAddress!)}>{status.agentAddress.slice(0, 8)}...{status.agentAddress.slice(-6)}</button>
    </p> : null}
    <a href="https://app.hyperliquid-testnet.xyz/trade" target="_blank" rel="noreferrer">Open Hyperliquid Testnet settings</a>
    <button type="button" className={styles.primaryAction} disabled={busy !== null || wallet.awaitingWallet || wallet.switching} onClick={() => void advance()}>
      {busy ?? (needsSwitch ? "Switch to Arbitrum Sepolia" : checking ? "Verify approval" : stage === "PREPARED" ? "Approve trading wallet" : "Sign enrollment")}
    </button>
    {error ? <p className={styles.reviewNotice} role="alert">{error}</p> : null}
  </section>;
}
