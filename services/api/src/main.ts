import { isAbsolute, resolve } from "node:path";
import { createPrivateTerminalServer, loadPrivateTerminalServerConfig } from "./http-server.js";
import { SqliteInternalOrderStore } from "./internal-order-store.js";
import { createLocalAtomicOrderRuntime } from "./local-atomic-order-context.js";
import { SqlitePackageLifecycleStore } from "./package-lifecycle-store.js";
import { HttpInternalSolverQuoteClient } from "./solver-quote-client.js";

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

const config = loadPrivateTerminalServerConfig();
const orderStore = new SqliteInternalOrderStore(absolutePath(
  process.env.NARYX_API_ORDER_DB ?? "/tmp/naryx-local/api-orders.db",
  "NARYX_API_ORDER_DB",
));
const lifecycleStore = new SqlitePackageLifecycleStore(absolutePath(
  process.env.NARYX_API_LIFECYCLE_DB ?? "/tmp/naryx-local/package-lifecycle.db",
  "NARYX_API_LIFECYCLE_DB",
));
const orderRuntime = createLocalAtomicOrderRuntime();
const solverClient = new HttpInternalSolverQuoteClient(
  process.env.NARYX_SOLVER_INTERNAL_ORIGIN ?? "http://127.0.0.1:8788",
);
const server = createPrivateTerminalServer(
  config,
  {},
  { contexts: orderRuntime.contexts, store: orderStore, clock: orderRuntime.clock },
  undefined,
  {},
  lifecycleStore,
  solverClient,
);

function shutdown(): void {
  server.close(() => {
    orderStore.close();
    lifecycleStore.close();
    process.exitCode = 0;
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `Private terminal service listening on http://${config.host}:${config.port}\n`,
  );
});
