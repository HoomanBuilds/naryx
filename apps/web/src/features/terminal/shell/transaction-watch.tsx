"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import { ArbitrumObservationError, type PrivateHttpTerminalProvider } from "../private-http-terminal-provider";
import { INSECURE_CONTEXT_MESSAGE } from "../secure-context";
import { refreshOnReturn, useTicketWatchedKeys } from "../transaction-status";
import { annotateAttempt, attemptsOf, type RecordedAttempt } from "./attempt-index";
import { DOMAIN_META, useTerminal, type TerminalNotice } from "./terminal-context";
import styles from "./shell.module.css";

/** Submitted attempts older than this are left to the Activity page instead of being watched. */
const WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 10_000;
/** A submission the service still cannot find this long after it was recorded is treated as dropped. */
const DROP_WINDOW_MS = 30 * 60 * 1000;
const CLOCK_TICK_MS = 60_000;

type Outcome = Readonly<{ final: boolean; tone: "ok" | "bad" | "info"; label: string }>;

const ARBITRUM_FINAL: ReadonlySet<string> = new Set([
  "EXECUTED", "CANCELLED", "FROZEN", "RECOVERED", "MANUAL_INTERVENTION", "CLOSED", "CONFLICT", "EVIDENCE_MISMATCH",
]);

function lower(state: string): string {
  return state.replace(/_/g, " ").toLowerCase();
}

/** Attempts whose status the service can read from what this browser kept at submission. */
function watchable(attempt: RecordedAttempt): boolean {
  if (attempt.idempotencyKey === undefined || attempt.settled !== undefined) return false;
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
  const dropped = Date.now() - attempt.createdAt > DROP_WINDOW_MS;
  if (attempt.flow === "base") {
    const observation = await provider.observeBaseAtomicExecution({ attemptId: attempt.attemptId, idempotencyKey, transactionHash }, signal);
    if (observation.lifecycle === "NOT_FOUND") {
      return dropped
        ? { final: true, tone: "bad", label: "transaction never reached the chain, so it was dropped. Nothing settled." }
        : { final: false, tone: "info", label: "not seen onchain yet" };
    }
    if (observation.lifecycle === "FINALIZED") return { final: true, tone: "ok", label: "finalized. Both legs settled in one transaction." };
    if (observation.lifecycle === "REVERTED") return { final: true, tone: "bad", label: "reverted, so neither leg settled." };
    if (observation.lifecycle === "EVIDENCE_MISMATCH") return { final: true, tone: "bad", label: "evidence mismatch. The receipt does not match the signed package." };
    return { final: false, tone: "info", label: lower(observation.lifecycle) };
  }
  if (attempt.reclaimed) return { final: true, tone: "bad", label: "funding reclaimed to your wallet. No package was opened." };
  const unreserved: Outcome = dropped
    ? { final: true, tone: "bad", label: "no solver reservation was recorded. Reclaim any funding from Trade after its deadline." }
    : { final: false, tone: "info", label: "waiting for a solver reservation" };
  let observation;
  try {
    observation = await provider.observeArbitrumAsyncExecution({ attemptId: attempt.attemptId, idempotencyKey }, signal);
  } catch (error) {
    // Before a solver reserves the package the service has nothing to observe and answers 502.
    if (attempt.mode === "entry" && error instanceof ArbitrumObservationError && error.status === 502) return unreserved;
    throw error;
  }
  if (attempt.mode === "entry" && observation.lifecycle === "NOT_FOUND") return unreserved;
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

/** The current time, refreshed each minute and whenever the tab comes back into view. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, CLOCK_TICK_MS);
    const stopReturnRefresh = refreshOnReturn(tick);
    return () => {
      window.clearInterval(timer);
      stopReturnRefresh();
    };
  }, []);
  return now;
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
  const now = useClock();
  // Without a secure context the browser has no Web Crypto, so hashing and signing steps would fail.
  useEffect(() => {
    if (window.isSecureContext === false) notify("bad", INSECURE_CONTEXT_MESSAGE);
  }, [notify]);
  // An open Trade ticket polling the same observation key owns it; this watcher resumes when it stops.
  const ticketKeys = useTicketWatchedKeys();
  const owners = [solanaOwner, evmOwner].filter((owner): owner is string => owner !== null);
  const watched = privateProvider === null ? [] : attemptsOf(attempts, owners)
    .filter((attempt) => watchable(attempt) && now - attempt.createdAt < WATCH_WINDOW_MS);
  const ticketOwned = (attempt: RecordedAttempt) => ticketKeys.has(attempt.idempotencyKey ?? "");
  const outcomes = useQueries({
    queries: watched.map((attempt) => ({
      queryKey: ["attempt-outcome", attempt.attemptId, attempt.transactionHash ?? null, attempt.idempotencyKey ?? null,
        attempt.reclaimed ?? false],
      enabled: !ticketOwned(attempt),
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
  const ownedKey = watched.filter(ticketOwned).map((attempt) => attempt.attemptId).join("|");
  useEffect(() => {
    watched.forEach((attempt, index) => {
      // The ticket follows it now; a final read after it lets go is then announced like any other.
      if (ticketOwned(attempt)) {
        if (!seen.current.has(attempt.attemptId)) seen.current.set(attempt.attemptId, false);
        return;
      }
      const outcome = outcomes[index]?.data;
      if (outcome === undefined) return;
      const before = seen.current.get(attempt.attemptId);
      seen.current.set(attempt.attemptId, outcome.final);
      if (outcome.final) annotateAttempt(attempt.attemptId, { settled: outcome.tone === "ok" ? "ok" : "bad" });
      if (before !== false || !outcome.final) return;
      void queryClient.invalidateQueries({ queryKey: ["lifecycle", attempt.attemptId] });
      void queryClient.invalidateQueries({ queryKey: ["owner-packages"] });
      void queryClient.invalidateQueries({ queryKey: ["positions"] });
      // The open ticket already shows its own domain's outcome; a notice would repeat it.
      if (pathname === "/trade" && attempt.domain === selectedDomain) return;
      notify(outcome.tone, `${DOMAIN_META[attempt.domain].network} ${attempt.mode} (size ${attempt.size}): ${outcome.label}`,
        { href: "/activity", label: "View activity" });
    });
    // watched and outcomes are rebuilt each render; outcomeKey and ownedKey capture what changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcomeKey, ownedKey]);

  return null;
}

const NOTICE_DISMISS_MS = 8_000;
const ERROR_NOTICE_DISMISS_MS = 20_000;

/** One notice; it dismisses itself after a while, and the timer pauses while pointed at or focused. */
function NoticeItem({ notice, dismiss }: { notice: TerminalNotice; dismiss(id: number): void }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(() => dismiss(notice.id), notice.tone === "bad" ? ERROR_NOTICE_DISMISS_MS : NOTICE_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [dismiss, held, notice.id, notice.tone]);
  return (
    <div
      className={`${styles.notice} ${notice.tone === "ok" ? styles.noticeOk : notice.tone === "bad" ? styles.noticeBad : ""}`}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <p>
        {notice.text}
        {notice.link ? <Link href={notice.link.href} onClick={() => dismiss(notice.id)}>{notice.link.label}</Link> : null}
      </p>
      <button type="button" className={styles.noticeClose} aria-label="Dismiss notice" onClick={() => dismiss(notice.id)}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

/** The in-app notices, as one polite live region in the shell. */
export function TransactionNotices() {
  const { notices, dismissNotice } = useTerminal();
  return (
    <div className={styles.notices} role="status" aria-live="polite">
      {notices.map((notice) => <NoticeItem key={notice.id} notice={notice} dismiss={dismissNotice} />)}
    </div>
  );
}
