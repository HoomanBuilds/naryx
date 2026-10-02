/**
 * Joins identical public chain reads: a read for the same key within `ttlMs`, or while one is in
 * flight, shares its result. Account routes are unauthenticated and the terminal polls them, so
 * this keeps many users (or one flooding client) from multiplying RPC calls. A failed read is
 * dropped at once so the next request retries. At most `maxKeys` entries are kept.
 */
export function createReadCache<T>(options: Readonly<{ ttlMs: number; maxKeys?: number; clockMs?: () => number }>) {
  const { ttlMs } = options;
  const maxKeys = options.maxKeys ?? 5_000;
  const clockMs = options.clockMs ?? Date.now;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxKeys) || maxKeys < 1) {
    throw new Error("Read cache bounds must be positive integers.");
  }
  const entries = new Map<string, Readonly<{ atMs: number; value: Promise<T> }>>();
  return (key: string, read: () => Promise<T>): Promise<T> => {
    const now = clockMs();
    const hit = entries.get(key);
    if (hit !== undefined && now - hit.atMs < ttlMs) return hit.value;
    if (entries.size >= maxKeys) {
      for (const [entryKey, entry] of entries) if (now - entry.atMs >= ttlMs) entries.delete(entryKey);
      if (entries.size >= maxKeys) entries.clear();
    }
    const value = read();
    entries.set(key, { atMs: now, value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}
