"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { hasPersistedSetting, usePersistedSetting } from "../persisted-setting";
import {
  PrivateHttpTerminalProvider,
  type PrivateTerminalRuntimeHealth,
  type RuntimeBoundaryHealth,
} from "../private-http-terminal-provider";
import type { DomainId } from "../terminal-view-model";
import { useAttemptIndex, type RecordedAttempt } from "./attempt-index";

export type TerminalServiceConfig = Readonly<{
  privateApiBaseUrl: string | null;
  publicApiBaseUrl: string | null;
  packageMarketId: string | null;
}>;

export type HealthState = "unconfigured" | "checking" | "ok" | "unavailable";

/** A short in-app notice about a transaction that settled while its page was not in view. */
export type TerminalNotice = Readonly<{
  id: number;
  tone: "ok" | "bad" | "info";
  text: string;
  link?: Readonly<{ href: "/activity" | "/portfolio"; label: string }>;
}>;

type TerminalContextValue = TerminalServiceConfig & {
  selectedDomain: DomainId;
  setSelectedDomain(domain: DomainId): void;
  privateProvider: PrivateHttpTerminalProvider | null;
  runtimeHealth: PrivateTerminalRuntimeHealth | null;
  healthState: HealthState;
  refreshHealth(): void;
  attempts: readonly RecordedAttempt[];
  recordAttempt(attempt: RecordedAttempt): void;
  /** Removes the given wallets' local attempts from this browser's list. */
  clearAttempts(owners: readonly string[]): void;
  notices: readonly TerminalNotice[];
  notify(tone: TerminalNotice["tone"], text: string, link?: TerminalNotice["link"]): void;
  dismissNotice(id: number): void;
};

const NOTICE_LIMIT = 3;
const HEALTH_POLL_MS = 20_000;
const HEALTH_STALE_MS = 60_000;

function healthKey(value: PrivateTerminalRuntimeHealth): string {
  return JSON.stringify(value, (_key, entry: unknown) => typeof entry === "bigint" ? entry.toString() : entry);
}
let noticeId = 0;

export const DOMAIN_ORDER: readonly DomainId[] = ["solana", "base", "arbitrum", "hyperliquid"];

/** Each domain's public test network, runtime, and settlement class, as the product presents them. */
export const DOMAIN_META: Readonly<Record<DomainId, {
  label: string;
  network: string;
  runtime: string;
  domainId: string;
  wallet: "solana" | "evm";
  settlementClass: "ATOMIC_POSTCONDITION" | "ASYNC_BONDED_SOLVER" | "BATCHED_IOC_WITH_RECOVERY";
  settlement: string;
  executionMode: string;
}>> = {
  solana: { label: "Solana", network: "Solana Devnet", runtime: "SVM", domainId: "svm:devnet", wallet: "solana", settlementClass: "ATOMIC_POSTCONDITION", settlement: "Atomic", executionMode: "Solana atomic" },
  base: { label: "Base", network: "Base Sepolia", runtime: "EVM", domainId: "eip155:84532", wallet: "evm", settlementClass: "ATOMIC_POSTCONDITION", settlement: "Atomic", executionMode: "Base atomic" },
  arbitrum: { label: "Arbitrum", network: "Arbitrum Sepolia", runtime: "EVM", domainId: "eip155:421614", wallet: "evm", settlementClass: "ASYNC_BONDED_SOLVER", settlement: "Bonded async", executionMode: "Arbitrum bonded async" },
  hyperliquid: { label: "Hyperliquid", network: "Hyperliquid testnet", runtime: "HyperCore", domainId: "hypercore:testnet", wallet: "evm", settlementClass: "BATCHED_IOC_WITH_RECOVERY", settlement: "IOC with recovery", executionMode: "Hyperliquid coordinated testnet" },
};

/** Lanes whose open packages the product cannot exit yet, with the reason shown in place of an exit. */
export const EXIT_UNAVAILABLE: Readonly<Partial<Record<DomainId, string>>> = {};

export function domainHealth(domain: DomainId, health: PrivateTerminalRuntimeHealth | null): RuntimeBoundaryHealth | null {
  if (!health) return null;
  if (domain === "solana") return health.solanaDevnet;
  if (domain === "base") return health.baseTestnetAtomic;
  if (domain === "arbitrum") return health.arbitrumTestnetAsync;
  return health.hyperliquidTestnet;
}

/**
 * A domain executes for real only when its testnet runtime is up and the service's execution
 * readiness gate is composed; without the gate every execution handoff is refused.
 */
export function domainLive(domain: DomainId, health: PrivateTerminalRuntimeHealth | null): boolean {
  if (health === null || !health.controls.executionReadinessAvailable || domainHealth(domain, health)?.available !== true) {
    return false;
  }
  return health.executionReadiness === null || health.executionReadiness.domains.some((entry) =>
    entry.domainId === DOMAIN_META[domain].domainId);
}

/** A lane whose live market the service serves, for previews and quotes, whether or not it executes. */
export function domainQuoting(domain: DomainId, health: PrivateTerminalRuntimeHealth | null): boolean {
  return health?.markets[domain] === "LIVE";
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

export function TerminalProvider({ config, children }: { config: TerminalServiceConfig; children: ReactNode }) {
  const [storedDomain, setSelectedDomain] = usePersistedSetting<DomainId>("domain", "solana", DOMAIN_ORDER);
  const privateProvider = useMemo(() => {
    if (!config.privateApiBaseUrl) return null;
    try {
      return new PrivateHttpTerminalProvider(config.privateApiBaseUrl);
    } catch {
      return null;
    }
  }, [config.privateApiBaseUrl]);
  const [health, setHealth] = useState<{ value: PrivateTerminalRuntimeHealth | null; state: HealthState }>(
    { value: null, state: privateProvider ? "checking" : "unconfigured" },
  );
  const [healthRequest, setHealthRequest] = useState(0);
  const lastHealthOkAt = useRef(0);
  const [attempts, recordAttempt, clearAttempts] = useAttemptIndex();
  const [notices, setNotices] = useState<readonly TerminalNotice[]>([]);
  const notify = useCallback((tone: TerminalNotice["tone"], text: string, link?: TerminalNotice["link"]) => {
    noticeId += 1;
    const notice = { id: noticeId, tone, text, link };
    setNotices((current) => [...current.filter((entry) => entry.text !== text), notice].slice(-NOTICE_LIMIT));
  }, []);
  const dismissNotice = useCallback((id: number) => {
    setNotices((current) => current.filter((entry) => entry.id !== id));
  }, []);

  useEffect(() => {
    if (!privateProvider) return;
    const controller = new AbortController();
    let inFlight = false;
    const poll = () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      privateProvider.getRuntimeHealth(controller.signal)
        .then((value) => {
          lastHealthOkAt.current = Date.now();
          // Keep the previous object when nothing changed so consumers do not re-render every poll.
          setHealth((current) => current.state === "ok" && current.value !== null
            && healthKey(current.value) === healthKey(value) ? current : { value, state: "ok" });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          // A transient failure keeps the last good reading for a bounded window, then fails closed.
          setHealth((current) => current.value !== null && Date.now() - lastHealthOkAt.current < HEALTH_STALE_MS
            ? (current.state === "ok" ? current : { ...current, state: "ok" })
            : { value: null, state: "unavailable" });
        })
        .finally(() => { inFlight = false; });
    };
    poll();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") poll();
    }, HEALTH_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [healthRequest, privateProvider]);

  // A first visit opens on a lane that executes: when the viewer has never picked a lane and the
  // default is not live, the first live lane is shown; with none, the first lane with a live market.
  // That pick is derived, never saved, so a viewer who never chose moves on to another live lane if it
  // goes down; a saved choice always wins. Health is unknown during the server render and the first
  // client render, so both use the default.
  const healthValue = health.value;
  const firstLive = DOMAIN_ORDER.find((domain) => domainLive(domain, healthValue));
  const selectedDomain = healthValue === null || hasPersistedSetting("domain") || domainLive(storedDomain, healthValue)
    ? storedDomain
    : firstLive ?? (domainQuoting(storedDomain, healthValue)
      ? storedDomain
      : DOMAIN_ORDER.find((domain) => domainQuoting(domain, healthValue)) ?? storedDomain);

  const refreshHealth = useCallback(() => {
    if (!privateProvider) return;
    setHealth((current) => ({ ...current, state: "checking" }));
    setHealthRequest((value) => value + 1);
  }, [privateProvider]);

  const { privateApiBaseUrl, publicApiBaseUrl, packageMarketId } = config;
  const value = useMemo<TerminalContextValue>(() => ({
    privateApiBaseUrl,
    publicApiBaseUrl,
    packageMarketId,
    selectedDomain,
    setSelectedDomain,
    privateProvider,
    runtimeHealth: health.value,
    healthState: privateProvider ? health.state : "unconfigured",
    refreshHealth,
    attempts,
    recordAttempt,
    clearAttempts,
    notices,
    notify,
    dismissNotice,
  }), [attempts, clearAttempts, dismissNotice, health, notices, notify, packageMarketId, privateApiBaseUrl, privateProvider, publicApiBaseUrl, recordAttempt, refreshHealth, selectedDomain, setSelectedDomain]);

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminal(): TerminalContextValue {
  const value = useContext(TerminalContext);
  if (!value) throw new Error("useTerminal must be used inside TerminalProvider.");
  return value;
}
