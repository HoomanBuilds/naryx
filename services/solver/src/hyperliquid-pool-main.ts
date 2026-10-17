import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { loadHyperliquidPoolRuntime } from './hyperliquid-pool-runtime.js';

const port = Number(process.env.NARYX_HYPERLIQUID_POOL_PORT ?? '8821');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid pool port');
const runtime = await loadHyperliquidPoolRuntime(process.env);
const server = createServer((request, response) => {
  void runtime.controller.handle(request, response).catch(() => response.destroy());
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, '127.0.0.1', () => process.stdout.write(`Dedicated Hyperliquid test pool listening on 127.0.0.1:${port}\n`));
const controller = new AbortController();
const worker = (async () => {
  while (!controller.signal.aborted) {
    if (!runtime.controller.busy()) {
      try {
        const status = await runtime.controller.advance();
        if (status !== 'IDLE') process.stdout.write(JSON.stringify({ event: 'POOL_EPOCH', status }) + '\n');
      } catch { process.stderr.write('Pool epoch unresolved; durable reservations retained.\n'); }
    }
    await setTimeout(2_000, undefined, { signal: controller.signal }).catch(() => {});
  }
})();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  controller.abort();
  server.close(() => { void worker.finally(() => runtime.close()); });
  server.closeIdleConnections();
});
