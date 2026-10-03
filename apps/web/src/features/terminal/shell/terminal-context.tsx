"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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
};

export const DOMAIN_ORDER: readonly DomainId[] = ["solana", "base", "arbitrum", "hyperliquid"];

/** Each domain's public test network, runtime, and settlement class, as the product presents them. */
export const DOMAIN_META: Readonly<Record<DomainId, {
  label: string;
  network: string;
  runtime: string;
  wallet: "solana" | "evm";
  settlementClass: "ATOMIC_POSTCONDITION" | "ASYNC_BONDED_SOLVER" | "BATCHED_IOC_WITH_RECOVERY";
  settlement: string;
  executionMode: string;
}>> = {
  solana: { label: "Solana", network: "Solana Devnet", runtime: "SVM", wallet: "solana", settlementClass: "ATOMIC_POSTCONDITION", settlement: "Atomic", executionMode: "Solana atomic" },
  base: { label: "Base", network: "Base Sepolia", runtime: "EVM", wallet: "evm", settlementClass: "ATOMIC_POSTCONDITION", settlement: "Atomic", executionMode: "Base atomic" },
  arbitrum: { label: "Arbitrum", network: "Arbitrum Sepolia", runtime: "EVM", wallet: "evm", settlementClass: "ASYNC_BONDED_SOLVER", settlement: "Bonded async", executionMode: "Arbitrum bonded async" },
  hyperliquid: { label: "Hyperliquid", network: "Hyperliquid testnet", runtime: "HyperCore", wallet: "evm", settlementClass: "BATCHED_IOC_WITH_RECOVERY", settlement: "IOC with recovery", executionMode: "Hyperliquid coordinated testnet" },
};

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
  return health !== null && health.controls.executionReadinessAvailable && domainHealth(domain, health)?.available === true;
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
  const [attempts, recordAttempt, clearAttempts] = useAttemptIndex();

  useEffect(() => {
    if (!privateProvider) return;
    const controller = new AbortController();
    privateProvider.getRuntimeHealth(controller.signal)
      .then((value) => setHealth({ value, state: "ok" }))
      .catch(() => {
        if (!controller.signal.aborted) setHealth({ value: null, state: "unavailable" });
      });
    return () => controller.abort();
  }, [healthRequest, privateProvider]);

  // A first visit opens on a lane that executes: when the viewer has never picked a lane and the
  // default is not live, the first live lane is shown. That pick is derived, never saved, so a viewer
  // who never chose moves on to another live lane if it goes down; a saved choice always wins.
  // Health is unknown during the server render and the first client render, so both use the default.
  const healthValue = health.value;
  const selectedDomain = healthValue === null || hasPersistedSetting("domain") || domainLive(storedDomain, healthValue)
    ? storedDomain
    : DOMAIN_ORDER.find((domain) => domainLive(domain, healthValue)) ?? storedDomain;

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
  }), [attempts, clearAttempts, health, packageMarketId, privateApiBaseUrl, privateProvider, publicApiBaseUrl, recordAttempt, refreshHealth, selectedDomain, setSelectedDomain]);

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminal(): TerminalContextValue {
  const value = useContext(TerminalContext);
  if (!value) throw new Error("useTerminal must be used inside TerminalProvider.");
  return value;
}
