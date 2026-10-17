import { createServer } from 'node:http';
import { createNativeCashTestnetHandler, loadNativeCashTestnetRuntime } from './native-cash-testnet-runtime.js';

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
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  server.close(() => { runtime.service.close(); });
  server.closeIdleConnections();
});
