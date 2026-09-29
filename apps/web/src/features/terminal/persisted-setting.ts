"use client";

import { useCallback, useSyncExternalStore, type KeyboardEvent } from "react";

const CHANGE_EVENT = "naryx-terminal-setting";
const PREFIX = "naryx.terminal.";

// Settings survive in memory even when browser storage is blocked, so a choice still sticks for
// the session instead of snapping back to the default.
const memory = new Map<string, string>();

function read(key: string): string | null {
  const remembered = memory.get(key);
  if (remembered !== undefined) return remembered;
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

/**
 * A per-viewer display preference such as a chart interval or the open workspace tab. Only values
 * in `allowed` are honored, so a stale or edited stored value falls back to the default. The
 * server render always uses the default, which keeps hydration deterministic.
 */
export function usePersistedSetting<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): [T, (value: T) => void] {
  const raw = useSyncExternalStore(subscribe, () => read(key), () => null);
  const value = raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const update = useCallback((next: T) => {
    memory.set(key, next);
    try {
      window.localStorage.setItem(PREFIX + key, next);
    } catch {
      // Storage can be unavailable in private windows; the in-memory copy still applies.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, [key]);
  return [value, update];
}

/** Boolean variant stored as "1" or "0". */
export function usePersistedFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [raw, setRaw] = usePersistedSetting<"1" | "0">(key, fallback ? "1" : "0", ["1", "0"]);
  const update = useCallback((next: boolean) => setRaw(next ? "1" : "0"), [setRaw]);
  return [raw === "1", update];
}

/**
 * Arrow-key navigation for a tablist: Left and Right move to the neighbouring tab, Home and End
 * jump to the ends, and the newly focused tab is activated.
 */
export function handleTablistKeys(event: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const current = tabs.indexOf(document.activeElement as HTMLElement);
  if (current === -1 || tabs.length === 0) return;
  event.preventDefault();
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.focus();
  tabs[next]?.click();
}
