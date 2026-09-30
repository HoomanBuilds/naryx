import { EvmJsonRpc, runEvmIndexerPass, type EvmIndexerSource } from "./evm-source.js";
import { SqliteReceiptIndex } from "./receipt-index.js";

/**
 * The read-only indexer process. It follows one EVM domain's settlement logs from its configured
 * contracts into the durable receipt index, replaying reorgs from their fork point and advancing
 * confirmation and finality only onto blocks it holds. It holds no key and sends no transaction.
 */
export function loadEvmIndexerConfig(environment: NodeJS.ProcessEnv): { dbPath: string; intervalMs: number; source: EvmIndexerSource } | undefined {
  const dbPath = environment.NARYX_INDEXER_DB;
  if (dbPath === undefined || dbPath === "") return undefined;
  const fail = (message: string): never => {
    throw new Error(`Indexer configuration: ${message}`);
  };
  if (!dbPath.startsWith("/")) fail("NARYX_INDEXER_DB must be an absolute path");
  const domainId = environment.NARYX_INDEXER_EVM_DOMAIN ?? "";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(domainId)) fail("NARYX_INDEXER_EVM_DOMAIN must name the domain");
  const rpcUrls = (environment.NARYX_INDEXER_EVM_RPC_URLS ?? "").split(",").map((value) => value.trim()).filter((value) => value !== "");
  if (rpcUrls.length === 0 || rpcUrls.length > 5 || new Set(rpcUrls).size !== rpcUrls.length) fail("NARYX_INDEXER_EVM_RPC_URLS must list 1 to 5 distinct endpoints");
  const contracts = (environment.NARYX_INDEXER_EVM_CONTRACTS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter((value) => value !== "");
  if (contracts.length === 0 || contracts.some((address) => !/^0x[0-9a-f]{40}$/.test(address))) fail("NARYX_INDEXER_EVM_CONTRACTS must list settlement contract addresses");
  const startHeight = Number(environment.NARYX_INDEXER_EVM_START_HEIGHT ?? "");
  if (!Number.isSafeInteger(startHeight) || startHeight < 0) fail("NARYX_INDEXER_EVM_START_HEIGHT must be a block height");
  const intervalMs = Number(environment.NARYX_INDEXER_INTERVAL_MS ?? "5000");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) fail("NARYX_INDEXER_INTERVAL_MS must be at least 1000");
  return { dbPath, intervalMs, source: { domainId, contracts, rpcs: rpcUrls.map((url) => new EvmJsonRpc(url)), startHeight } };
}

const config = loadEvmIndexerConfig(process.env);
if (config === undefined) {
  process.stdout.write("Indexer is off: set NARYX_INDEXER_DB and the NARYX_INDEXER_EVM_* variables to follow a domain.\n");
} else {
  const index = new SqliteReceiptIndex(config.dbPath);
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runEvmIndexerPass(index, config.source);
      if (result.ingested > 0 || result.reorgs > 0) process.stdout.write(`Indexed ${result.ingested} blocks (${result.reorgs} reorgs), tip ${result.tip}\n`);
    } catch (error) {
      process.stderr.write(`Indexer pass failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    } finally {
      running = false;
    }
  };
  void pass();
  const timer = setInterval(() => void pass(), config.intervalMs);
  const shutdown = () => {
    clearInterval(timer);
    index.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
