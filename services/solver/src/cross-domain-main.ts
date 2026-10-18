import { loadCrossDomainRuntime } from './cross-domain-runtime.js';

const runtime = await loadCrossDomainRuntime(process.env);
if (runtime === undefined) throw new Error('Cross-domain runtime is disabled.');
const args = process.argv.slice(2);
if (args.length === 2 && args[0] === '--enqueue') {
  try { process.stdout.write(`${JSON.stringify(await runtime.enqueue(args[1]!))}\n`); }
  finally { runtime.close(); }
} else {
  if (args.length !== 0) { runtime.close(); throw new Error('Usage: cross-domain-main.js [--enqueue /absolute/job.json]'); }
  let stopping = false;
  const interval = setInterval(() => { void runtime.worker.tick().catch(() => {
    process.stderr.write('Cross-domain worker failed; durable account fences remain in place.\n');
  }); }, runtime.pollIntervalMs);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    await runtime.worker.drain();
    runtime.close();
  };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  await runtime.worker.tick();
}
