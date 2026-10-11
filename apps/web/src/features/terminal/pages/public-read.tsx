"use client";

import { NaryxApiError, NaryxClient, NaryxEvidenceError, toHex } from "@naryx/sdk";
import type { UseQueryResult } from "@tanstack/react-query";
import styles from "./pages.module.css";

/** A public API client, or null when the SDK refuses the configured base URL. */
export function publicClient(baseUrl: string | null): NaryxClient | null {
  if (baseUrl === null) return null;
  try {
    return new NaryxClient({ baseUrl });
  } catch {
    return null;
  }
}

/** Plain copy for a failed public read. Unpublished and unconfigured are normal states, not faults. */
export function readFailure(error: unknown, subject: string): string {
  if (error instanceof NaryxApiError) {
    if (error.status === 404) return `${subject} is not published on this server.`;
    if (error.status === 503) return `${subject} is not configured on this server.`;
    return `${subject} is unavailable (${error.status} ${error.code}).`;
  }
  if (error instanceof NaryxEvidenceError) return `${subject} failed verification and is not shown (${error.message}).`;
  return `${subject} is unavailable (${error instanceof Error ? error.message : "request failed"}).`;
}

export function compact(value: string, head = 10, tail = 6): string {
  return value.length > head + tail + 3 ? `${value.slice(0, head)}...${value.slice(-tail)}` : value;
}

/** One protocol value as display text: exact integers stay exact and bytes show as hex. */
export function shown(value: unknown): string {
  if (value === undefined || value === null) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") return value.toString();
  if (value instanceof Uint8Array) return toHex(value);
  if (Array.isArray(value)) return value.length === 0 ? "None" : value.map(shown).join(", ");
  return payload(value);
}

/** Pretty protocol JSON for a read-only document view. */
export function payload(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (
    typeof entry === "bigint" ? entry.toString() : entry instanceof Uint8Array ? toHex(entry) : entry
  ), 2);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)
    ? value as Record<string, unknown>
    : null;
}

/** Loading, failure, and empty copy for one lazily read panel; renders children only with data. */
export function ReadState<T>({ query, subject, empty, children }: {
  query: UseQueryResult<T>;
  subject: string;
  empty?: (data: T) => string | null;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) return <p className={styles.readNote}>Reading {subject.toLowerCase()}.</p>;
  if (query.isError) return <p className={styles.readNote}>{readFailure(query.error, subject)}</p>;
  const emptyText = empty?.(query.data) ?? null;
  if (emptyText !== null) return <p className={styles.readNote}>{emptyText}</p>;
  return <>{children(query.data)}</>;
}
