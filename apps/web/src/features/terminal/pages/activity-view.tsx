"use client";

import Link from "next/link";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { ChainIcon } from "@/features/brand/chain-icons";
import type { PackageLifecycleResponse } from "../private-http-terminal-provider";
import { DOMAIN_META, useTerminal } from "../shell/terminal-context";
import type { RecordedAttempt } from "../shell/attempt-index";
import styles from "./pages.module.css";

const FLOW_LABEL: Readonly<Record<RecordedAttempt["flow"], string>> = {
  devnet: "Devnet execution",
  conformance: "Local conformance",
  hyperliquid: "Hyperliquid testnet",
  base: "Base Sepolia",
  arbitrum: "Arbitrum Sepolia",
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
  if (/COMPLETE|FINAL|SETTLED/.test(state)) return styles.pillOk;
  if (/FAIL|REJECT|ABORT|EXPIRED|RECOVERY/.test(state)) return styles.pillBad;
  return styles.pill;
}

/** Lifecycle reads cover Solana Devnet and local conformance attempts; Hyperliquid, Base, and Arbitrum attempts report in the ticket. */
function readable(attempt: RecordedAttempt) {
  return attempt.flow !== "hyperliquid" && attempt.flow !== "base" && attempt.flow !== "arbitrum";
}

export function ActivityView() {
  const { attempts, privateProvider, clearAttempts } = useTerminal();
  const [openId, setOpenId] = useState<string | null>(null);
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
  const openLifecycle = openIndex >= 0 ? lifecycles[openIndex]?.data ?? null : null;

  return (
    <main className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1>Activity</h1>
          <p>Every package this browser started, with its durable lifecycle state and the receipt chain the service recorded for it.</p>
        </div>
        {attempts.length > 0 ? (
          <div className={styles.headActions}>
            <button type="button" className={styles.ghost} onClick={() => { setOpenId(null); clearAttempts(); }}>
              Clear list
            </button>
          </div>
        ) : null}
      </div>

      {privateProvider === null && attempts.length > 0 ? (
        <p className={styles.notice}>The private terminal service is not configured, so lifecycle state cannot be read. The list below is this browser&apos;s record only.</p>
      ) : null}

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
                const state = !readable(attempt)
                  ? "See ticket"
                  : lifecycle ? stateText(lifecycle.attempt.state)
                  : privateProvider === null ? "Unavailable"
                  : query?.isError ? "Unavailable" : "Loading";
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
                      {readable(attempt) ? (
                        <span className={lifecycle ? statePill(lifecycle.attempt.state) : styles.pill}>{state}</span>
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
            {openLifecycle && openLifecycle.receipts.length > 0 ? (
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
                {openIndex >= 0 && !readable(attempts[openIndex])
                  ? `${FLOW_LABEL[attempts[openIndex].flow]} attempts report their execution in the Trade ticket; the lifecycle read covers Solana and local conformance attempts.`
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
