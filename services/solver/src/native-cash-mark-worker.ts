import { setTimeout } from 'node:timers/promises';

export async function runNativeCashMarkWorker(input: {
  signal: AbortSignal;
  tick: () => Promise<void>;
  failed: (error: unknown) => void;
  intervalMs?: number;
}) {
  const intervalMs = input.intervalMs ?? 2_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 30_000) {
    throw new Error('Native cash mark polling interval is invalid.');
  }
  while (!input.signal.aborted) {
    try { await input.tick(); } catch (error) { input.failed(error); }
    if (input.signal.aborted) break;
    try { await setTimeout(intervalMs, undefined, { signal: input.signal }); }
    catch (error) { if (!input.signal.aborted) throw error; }
  }
}
