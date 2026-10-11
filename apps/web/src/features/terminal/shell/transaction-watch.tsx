"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import type { PrivateHttpTerminalProvider } from "../private-http-terminal-provider";
import { attemptsOf, type RecordedAttempt } from "./attempt-index";
import { DOMAIN_META, useTerminal } from "./terminal-context";
import styles from "./shell.module.css";

/** Submitted attempts older than this are left to the Activity page instead of being watched. */
const WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 10_000;

type Outcome = Readonly<{ final: boolean; tone: "ok" | "bad" | "info"; label: string }>;

const ARBITRUM_FINAL: ReadonlySet<string> = new Set([
  "EXECUTED", "CANCELLED", "FROZEN", "RECOVERED", "MANUAL_INTERVENTION", "CLOSED", "CONFLICT", "EVIDENCE_MISMATCH",
]);

function lower(state: string): string {
  return state.replace(/_/g, " ").toLowerCase();
}

/** Attempts whose status the service can read from what this browser kept at submission. */
function watchable(attempt: RecordedAttempt): boolean {
  if (attempt.idempotencyKey === undefined) return false;
  if (attempt.flow === "devnet" || attempt.flow === "base") return attempt.transactionHash !== undefined;
  return attempt.flow === "arbitrum";
}

/** The same status reads the Trade ticket polls, so a reload or another page resumes them. */
async function readOutcome(provider: PrivateHttpTerminalProvider, attempt: RecordedAttempt, signal: AbortSignal): Promise<Outcome> {
  const idempotencyKey = attempt.idempotencyKey ?? "";
  const transactionHash = attempt.transactionHash ?? "";
  if (attempt.flow === "devnet") {
    const { lifecycle } = await provider.observeSolanaExecution({ idempotencyKey, signature: transactionHash }, signal);
    if (lifecycle === "FINALIZED") return { final: true, tone: "ok", label: "transaction finalized. That is network finality; the package state is on Activity." };
    if (lifecycle === "FAILED") return { final: true, tone: "bad", label: "transaction failed and did not finalize." };
    if (lifecycle === "EXPIRED") return { final: true, tone: "bad", label: "transaction expired before finality." };
    return { final: false, tone: "info", label: "submitted" };
  }
  if (attempt.flow === "base") {
    const observation = await provider.observeBaseAtomicExecution({ attemptId: attempt.attemptId, idempotencyKey, transactionHash }, signal);
    if (observation.lifecycle === "FINALIZED") return { final: true, tone: "ok", label: "finalized. Both legs settled in one transaction." };
    if (observation.lifecycle === "REVERTED") return { final: true, tone: "bad", label: "reverted, so neither leg settled." };
    if (observation.lifecycle === "EVIDENCE_MISMATCH") return { final: true, tone: "bad", label: "evidence mismatch. The receipt does not match the signed package." };
    return { final: false, tone: "info", label: lower(observation.lifecycle) };
  }
  const observation = await provider.observeArbitrumAsyncExecution({ attemptId: attempt.attemptId, idempotencyKey }, signal);
  if (attempt.mode === "exit") {
    const status = observation.exit?.status;
    if (observation.exitCompleted) return { final: true, tone: "ok", label: "package closed with its final receipt." };
    if (status === "CANCELLED" || status === "RECOVERED") return { final: true, tone: "bad", label: "GMX did not execute the close. The package is still open." };
    if (status === "CONFLICT" || observation.lifecycle === "CONFLICT" || observation.lifecycle === "EVIDENCE_MISMATCH") {
      return { final: true, tone: "bad", label: "exit needs recovery. The evidence conflicts." };
    }
    return { final: false, tone: "info", label: status ? lower(status) : "submitted" };
  }
  if (!ARBITRUM_FINAL.has(observation.lifecycle)) return { final: false, tone: "info", label: lower(observation.lifecycle) };
  const entry = observation.entry?.status;
  if (observation.lifecycle === "EXECUTED" || (observation.lifecycle === "CLOSED" && entry === "EXECUTED")) {
    return { final: true, tone: "ok", label: "entry executed. The package is open." };
  }
  if ((observation.lifecycle === "CLOSED" || observation.lifecycle === "RECOVERED") && (entry === "CANCELLED" || entry === "RECOVERED")) {
    return { final: true, tone: "bad", label: "GMX cancelled the entry. No package is open." };
  }
  return { final: true, tone: "bad", label: `package ${lower(observation.lifecycle)}.` };
}

/**
 * Keeps submitted transactions this browser recorded up to date on every terminal page: it resumes
 * their status reads after a reload, polls while they are in flight, reads again when the tab comes
 * back into view, stops once each is final, and posts a notice when one settles.
 */
export function TransactionWatch() {
  const { attempts, privateProvider, notify, selectedDomain } = useTerminal();
  const pathname = usePathname();
  const solanaOwner = useSolanaWallet().selectedAccount?.address ?? null;
  const evmOwner = useEvmWallet().account;
  const queryClient = useQueryClient();
  const owners = [solanaOwner, evmOwner].filter((owner): owner is string => owner !== null);
  const [startedAt] = useState(() => Date.now());
  const watched = privateProvider === null ? [] : attemptsOf(attempts, owners)
    .filter((attempt) => watchable(attempt) && startedAt - attempt.createdAt < WATCH_WINDOW_MS);
  const outcomes = useQueries({
    queries: watched.map((attempt) => ({
      queryKey: ["attempt-outcome", attempt.attemptId, attempt.transactionHash ?? null, attempt.idempotencyKey ?? null],
      staleTime: 0,
      // An Arbitrum package the solver has not reserved yet reads as an error; it is checked less often.
      refetchInterval: (query: { state: { data?: Outcome; status: string } }) => query.state.data?.final ? false
        : query.state.status === "error" ? 3 * POLL_INTERVAL_MS : POLL_INTERVAL_MS,
      refetchOnWindowFocus: (query: { state: { data?: Outcome } }) => query.state.data?.final ? false : "always" as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        if (privateProvider === null) throw new Error("Private service not configured.");
        return readOutcome(privateProvider, attempt, signal);
      },
    })),
  });

  // Only a change seen in this session is announced, so a reload never replays settled outcomes.
  const seen = useRef(new Map<string, boolean>());
  const outcomeKey = outcomes.map((query) => `${query.data?.final ?? ""}:${query.data?.label ?? ""}`).join("|");
  useEffect(() => {
    watched.forEach((attempt, index) => {
      const outcome = outcomes[index]?.data;
      if (outcome === undefined) return;
      const before = seen.current.get(attempt.attemptId);
      seen.current.set(attempt.attemptId, outcome.final);
      if (before !== false || !outcome.final) return;
      void queryClient.invalidateQueries({ queryKey: ["lifecycle", attempt.attemptId] });
      void queryClient.invalidateQueries({ queryKey: ["owner-packages"] });
      void queryClient.invalidateQueries({ queryKey: ["positions"] });
      // The open ticket already shows its own domain's outcome; a notice would repeat it.
      if (pathname === "/trade" && attempt.domain === selectedDomain) return;
      notify(outcome.tone, `${DOMAIN_META[attempt.domain].network} ${attempt.mode} (size ${attempt.size}): ${outcome.label}`,
        { href: "/activity", label: "View activity" });
    });
    // watched and outcomes are rebuilt each render; outcomeKey captures what changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcomeKey]);

  return null;
}

/** The in-app notices, as one polite live region in the shell. */
export function TransactionNotices() {
  const { notices, dismissNotice } = useTerminal();
  return (
    <div className={styles.notices} role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`${styles.notice} ${notice.tone === "ok" ? styles.noticeOk : notice.tone === "bad" ? styles.noticeBad : ""}`}>
          <p>
            {notice.text}
            {notice.link ? <Link href={notice.link.href} onClick={() => dismissNotice(notice.id)}>{notice.link.label}</Link> : null}
          </p>
          <button type="button" className={styles.noticeClose} aria-label="Dismiss notice" onClick={() => dismissNotice(notice.id)}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
}
