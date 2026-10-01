"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { DomainId, PackageMode } from "../terminal-view-model";

/**
 * The packages this browser has started, newest first. The private lifecycle API reads one attempt
 * at a time, so the Activity page needs to know which attempts to ask about. Only identifiers and
 * ticket parameters are kept; lifecycle state always comes from the service.
 */
export type RecordedAttempt = Readonly<{
  attemptId: string;
  domain: DomainId;
  mode: PackageMode;
  size: string;
  flow: "devnet" | "conformance" | "hyperliquid" | "base" | "arbitrum";
  createdAt: number;
}>;

const KEY = "naryx.terminal.attempts";
const CHANGE_EVENT = "naryx-terminal-attempts";
const LIMIT = 50;
const EMPTY: readonly RecordedAttempt[] = Object.freeze([]);
const DOMAINS: readonly string[] = ["solana", "base", "arbitrum", "hyperliquid"];
const FLOWS: readonly string[] = ["devnet", "conformance", "hyperliquid", "base", "arbitrum"];

let memory: string | null = null;
let cachedRaw: string | null = null;
let cachedValue: readonly RecordedAttempt[] = EMPTY;

function isAttempt(value: unknown): value is RecordedAttempt {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.attemptId === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(entry.attemptId) &&
    typeof entry.domain === "string" && DOMAINS.includes(entry.domain) &&
    (entry.mode === "entry" || entry.mode === "exit") &&
    typeof entry.size === "string" && /^\d{1,9}(?:\.\d{1,6})?$/.test(entry.size) &&
    typeof entry.flow === "string" && FLOWS.includes(entry.flow) &&
    typeof entry.createdAt === "number" && Number.isSafeInteger(entry.createdAt);
}

function readRaw(): string | null {
  if (memory !== null) return memory;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function snapshot(): readonly RecordedAttempt[] {
  const raw = readRaw();
  if (raw === cachedRaw) return cachedValue;
  cachedRaw = raw;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cachedValue = Array.isArray(parsed) ? Object.freeze(parsed.filter(isAttempt).slice(0, LIMIT)) : EMPTY;
  } catch {
    cachedValue = EMPTY;
  }
  return cachedValue;
}

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

export function useAttemptIndex(): [readonly RecordedAttempt[], (attempt: RecordedAttempt) => void, () => void] {
  const attempts = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const record = useCallback((attempt: RecordedAttempt) => {
    if (!isAttempt(attempt)) return;
    const next = [attempt, ...snapshot().filter((entry) => entry.attemptId !== attempt.attemptId)].slice(0, LIMIT);
    const raw = JSON.stringify(next);
    memory = raw;
    try {
      window.localStorage.setItem(KEY, raw);
    } catch {
      // Storage can be unavailable; the in-memory copy keeps this session's list.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  const clear = useCallback(() => {
    memory = "[]";
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // Nothing stored.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [attempts, record, clear];
}
