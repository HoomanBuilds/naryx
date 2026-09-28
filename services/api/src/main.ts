import { isAbsolute, resolve } from "node:path";
import { createPrivateTerminalServer, loadPrivateTerminalServerConfig } from "./http-server.js";
import { SqliteInternalOrderStore } from "./internal-order-store.js";
import { createLocalAtomicOrderRuntime } from "./local-atomic-order-context.js";
import { SqlitePackageLifecycleStore } from "./package-lifecycle-store.js";
import { HttpInternalSolverQuoteClient } from "./solver-quote-client.js";
import { SqliteExecutionIntentStore } from "./execution-intent-store.js";
import { LocalExecutionCoordinator } from "./local-execution-coordinator.js";
import { composePrivateTerminalRuntime } from "./runtime-composition.js";
import { loadSolanaLocalEnvironmentRuntime } from "./solana-local-environment-runtime.js";

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
const executionIntentStore = new SqliteExecutionIntentStore(absolutePath(
  process.env.NARYX_API_EXECUTION_INTENT_DB ?? "/tmp/naryx-local/execution-intents.db",
  "NARYX_API_EXECUTION_INTENT_DB",
));
const environmentManifestPath = process.env.NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST;
const manifestRuntime = environmentManifestPath === undefined
  ? undefined
  : await loadSolanaLocalEnvironmentRuntime(
    absolutePath(environmentManifestPath, "NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST"),
    process.env.NARYX_SOLANA_LOCAL_SOLVER_ID ?? "",
  );
const orderRuntime = manifestRuntime === undefined
  ? createLocalAtomicOrderRuntime()
  : createLocalAtomicOrderRuntime(
    manifestRuntime.manifest.runtime.catalog,
    () => manifestRuntime.initialSlot,
    manifestRuntime.readSlot,
  );
const solverClient = new HttpInternalSolverQuoteClient(
  process.env.NARYX_SOLVER_INTERNAL_ORIGIN ?? "http://127.0.0.1:8788",
);
const localExecutionCoordinator = new LocalExecutionCoordinator({
  intents: executionIntentStore,
  orders: orderStore,
  lifecycle: lifecycleStore,
});
const runtime = composePrivateTerminalRuntime();
const server = createPrivateTerminalServer(
  config,
  runtime.solanaDevnet,
  { contexts: orderRuntime.contexts, store: orderStore, clock: orderRuntime.clock },
  runtime.hyperliquidTestnet,
  runtime.evmTestnet,
  lifecycleStore,
  solverClient,
  executionIntentStore,
  localExecutionCoordinator,
  runtime.health,
  manifestRuntime === undefined ? "PHASE4_FIXTURE" : "MANIFEST_VALIDATED",
);

function shutdown(): void {
  server.close(() => {
    orderStore.close();
    lifecycleStore.close();
    executionIntentStore.close();
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
