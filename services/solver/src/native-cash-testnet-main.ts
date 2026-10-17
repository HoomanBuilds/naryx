import { createServer } from 'node:http';
import { createNativeCashTestnetHandler, loadNativeCashTestnetRuntime } from './native-cash-testnet-runtime.js';
import { setTimeout } from 'node:timers/promises';

const port = Number(process.env.NARYX_NATIVE_CASH_TESTNET_PORT ?? '8820');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Native cash port is invalid.');
const runtime = await loadNativeCashTestnetRuntime(process.env);
const handler = createNativeCashTestnetHandler(runtime);
const server = createServer((request, response) => {
  void handler(request, response).catch(() => { response.destroy(); });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, '127.0.0.1', () => process.stdout.write(`Native cash testnet service listening on 127.0.0.1:${port}\n`));
const controller = new AbortController();
const reconciliation = (async () => {
  while (!controller.signal.aborted) {
    try {
      const result = await runtime.service.reconcilePending();
      if (result.checked > 0) process.stdout.write(JSON.stringify({ event: 'NATIVE_CASH_FINALITY', ...result }) + '\n');
    } catch { process.stderr.write('Native cash finality reconciliation failed; pending records retained.\n'); }
    await setTimeout(30_000, undefined, { signal: controller.signal }).catch(() => {});
  }
})();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  controller.abort();
  server.close(() => { void reconciliation.finally(() => { runtime.service.close(); runtime.registration.close(); }); });
  server.closeIdleConnections();
});
