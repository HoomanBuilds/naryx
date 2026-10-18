import { loadCrossDomainRuntime } from './cross-domain-runtime.js';
import { createCrossDomainServer } from './cross-domain-server.js';

const runtime = await loadCrossDomainRuntime(process.env);
if (runtime === undefined) throw new Error('Cross-domain runtime is disabled.');
const args = process.argv.slice(2);
if (args.length === 2 && args[0] === '--enqueue') {
  try { process.stdout.write(`${JSON.stringify(await runtime.enqueue(args[1]!))}\n`); }
  finally { runtime.close(); }
} else {
  if (args.length !== 0) { runtime.close(); throw new Error('Usage: cross-domain-main.js [--enqueue /absolute/job.json]'); }
  const port = process.env.NARYX_CROSS_DOMAIN_PORT;
  if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535)) {
    runtime.close(); throw new Error('Invalid cross-domain loopback port.');
  }
  const server = port === undefined ? undefined : createCrossDomainServer(runtime);
  if (server !== undefined) await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  let stopping = false;
  let polling: Promise<void> | undefined;
  const tick = () => {
    if (polling !== undefined) return polling;
    polling = (async () => {
      try { await runtime.walletApprovals?.tick(); }
      catch { process.stderr.write('Cross-domain wallet approval is pending; execution worker continues.\n'); }
      await runtime.worker.tick();
    })().finally(() => { polling = undefined; });
    return polling;
  };
  const interval = setInterval(() => { void tick().catch(() => {
    process.stderr.write('Cross-domain worker failed; durable account fences remain in place.\n');
  }); }, runtime.pollIntervalMs);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    if (server !== undefined) await new Promise<void>(resolve => server.close(() => resolve()));
    await polling?.catch(() => {});
    await runtime.worker.drain();
    runtime.close();
  };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  await tick();
}
