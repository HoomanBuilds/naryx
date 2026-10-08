"use client";

import { useCallback, useSyncExternalStore } from "react";

export type RecordedPackageOrder = Readonly<{
  strategyOrderHash: string;
  packageOrderId: string;
  participantId: string;
  createdAt: number;
}>;

const KEY = "naryx.terminal.package-orders";
const CHANGE_EVENT = "naryx-terminal-package-orders";
const LIMIT = 50;
const EMPTY: readonly RecordedPackageOrder[] = Object.freeze([]);
const HASH = /^[0-9a-f]{64}$/;
const PARTICIPANT = /^(?:0x(?!0{40}$)[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

let memory: string | null = null;
let cachedRaw: string | null = null;
let cachedValue: readonly RecordedPackageOrder[] = EMPTY;

function participantKey(participantId: string): string {
  return participantId.startsWith("0x") ? participantId.toLowerCase() : participantId;
}

function valid(value: unknown): value is RecordedPackageOrder {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.strategyOrderHash === "string" && HASH.test(entry.strategyOrderHash)
    && typeof entry.packageOrderId === "string" && HASH.test(entry.packageOrderId)
    && typeof entry.participantId === "string" && PARTICIPANT.test(entry.participantId)
    && typeof entry.createdAt === "number" && Number.isSafeInteger(entry.createdAt) && entry.createdAt >= 0;
}

function raw(): string | null {
  if (memory !== null) return memory;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function snapshot(): readonly RecordedPackageOrder[] {
  const current = raw();
  if (current === cachedRaw) return cachedValue;
  cachedRaw = current;
  try {
    const parsed: unknown = current ? JSON.parse(current) : [];
    cachedValue = Array.isArray(parsed) ? Object.freeze(parsed.filter(valid).slice(0, LIMIT)) : EMPTY;
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

export function packageOrdersOf(
  records: readonly RecordedPackageOrder[],
  participants: readonly string[],
): readonly RecordedPackageOrder[] {
  const allowed = new Set(participants.map(participantKey));
  return records.filter((record) => allowed.has(participantKey(record.participantId)));
}

export function usePackageOrderIndex(): [
  readonly RecordedPackageOrder[],
  (record: RecordedPackageOrder) => void,
] {
  const records = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const record = useCallback((entry: RecordedPackageOrder) => {
    if (!valid(entry)) return;
    const next = [entry, ...snapshot().filter((current) => current.packageOrderId !== entry.packageOrderId)].slice(0, LIMIT);
    const encoded = JSON.stringify(next);
    memory = encoded;
    try {
      window.localStorage.setItem(KEY, encoded);
    } catch {
      // The in-memory index still lets this browser session recover the order.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [records, record];
}
