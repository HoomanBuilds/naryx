import { createQuoteAutomation, type QuoteAutomationAction, type QuoteAutomationOptions } from './maker-automation.js';

export interface QuoteAutomationWorkerOptions extends QuoteAutomationOptions {
  readonly environment: 'local' | 'devnet' | 'testnet';
  readonly checkpointStore: NonNullable<QuoteAutomationOptions['checkpointStore']>;
  readonly refreshLevels: NonNullable<QuoteAutomationOptions['refreshLevels']>;
  readonly assertBacking: NonNullable<QuoteAutomationOptions['assertBacking']>;
  readonly intervalMs: number;
  readonly signal: AbortSignal;
  readonly onTick?: (actions: readonly QuoteAutomationAction[]) => void | Promise<void>;
}

function wait(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, intervalMs);
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function runQuoteAutomationWorker(options: QuoteAutomationWorkerOptions): Promise<Readonly<{
  reason: 'ABORTED' | 'HALTED';
  ticks: number;
}>> {
  if (!['local', 'devnet', 'testnet'].includes(options.environment)
    || !Number.isSafeInteger(options.intervalMs) || options.intervalMs < 100 || options.intervalMs > 60_000
    || typeof options.assertBacking !== 'function' || typeof options.refreshLevels !== 'function'
    || typeof options.checkpointStore?.load !== 'function' || typeof options.checkpointStore.save !== 'function') {
    throw new TypeError('maker worker requires a non-mainnet environment, durable checkpoints, backing checks, fresh quotes and a 100-60000ms interval');
  }
  const automation = createQuoteAutomation({ ...options, expectedEnvironment: options.environment });
  let ticks = 0;
  try {
    while (!options.signal.aborted) {
      const actions = await automation.tick();
      ticks += 1;
      await options.onTick?.(actions);
      if (actions.some((action) => action.kind === 'HALTED' || action.kind === 'KILLED')) {
        return Object.freeze({ reason: 'HALTED', ticks });
      }
      await wait(options.intervalMs, options.signal);
    }
  } catch (error) {
    try { await automation.halt(); }
    catch (haltError) { throw new AggregateError([error, haltError], 'maker worker failed and halt could not be confirmed'); }
    throw error;
  }
  await options.onTick?.(await automation.halt());
  return Object.freeze({ reason: 'ABORTED', ticks });
}
