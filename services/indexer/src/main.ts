import { EvmJsonRpc, evmChainIdOfDomain, runEvmIndexerPass, type EvmIndexerSource } from "./evm-source.js";
import { SqliteReceiptIndex } from "./receipt-index.js";

/**
 * The read-only indexer process. It follows one EVM domain's settlement logs from its configured
 * contracts, and the logs of any performance bond vaults and async bonded coordinators it is given,
 * into the durable receipt index, replaying reorgs from their fork point and advancing confirmation
 * and finality only onto blocks it holds. Every pass first requires every endpoint's eth_chainId to
 * match the domain. It holds no key and sends no transaction.
 */
export function loadEvmIndexerConfig(environment: NodeJS.ProcessEnv): { dbPath: string; intervalMs: number; source: EvmIndexerSource } | undefined {
  const dbPath = environment.NARYX_INDEXER_DB;
  if (dbPath === undefined || dbPath === "") return undefined;
  const fail = (message: string): never => {
    throw new Error(`Indexer configuration: ${message}`);
  };
  if (!dbPath.startsWith("/")) fail("NARYX_INDEXER_DB must be an absolute path");
  const domainId = environment.NARYX_INDEXER_EVM_DOMAIN ?? "";
  try {
    evmChainIdOfDomain(domainId);
  } catch {
    fail("NARYX_INDEXER_EVM_DOMAIN must be a CAIP-2 eip155 chain reference, such as eip155:84532 or eip155:421614");
  }
  const rpcUrls = (environment.NARYX_INDEXER_EVM_RPC_URLS ?? "").split(",").map((value) => value.trim()).filter((value) => value !== "");
  if (rpcUrls.length === 0 || rpcUrls.length > 5 || new Set(rpcUrls).size !== rpcUrls.length) fail("NARYX_INDEXER_EVM_RPC_URLS must list 1 to 5 distinct endpoints");
  const contracts = (environment.NARYX_INDEXER_EVM_CONTRACTS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter((value) => value !== "");
  if (contracts.some((address) => !/^0x[0-9a-f]{40}$/.test(address))) fail("NARYX_INDEXER_EVM_CONTRACTS must list settlement contract addresses");
  const bondVaults = (environment.NARYX_INDEXER_EVM_BOND_VAULTS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter((value) => value !== "");
  if (bondVaults.some((address) => !/^0x[0-9a-f]{40}$/.test(address)) || new Set(bondVaults).size !== bondVaults.length) fail("NARYX_INDEXER_EVM_BOND_VAULTS must list distinct vault addresses");
  const coordinators = (environment.NARYX_INDEXER_EVM_ASYNC_COORDINATORS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter((value) => value !== "");
  if (coordinators.some((address) => !/^0x[0-9a-f]{40}$/.test(address)) || new Set(coordinators).size !== coordinators.length) fail("NARYX_INDEXER_EVM_ASYNC_COORDINATORS must list distinct coordinator addresses");
  if (contracts.length === 0 && coordinators.length === 0) fail("NARYX_INDEXER_EVM_CONTRACTS or NARYX_INDEXER_EVM_ASYNC_COORDINATORS must list at least one contract");
  const startHeight = Number(environment.NARYX_INDEXER_EVM_START_HEIGHT ?? "");
  if (!Number.isSafeInteger(startHeight) || startHeight < 0) fail("NARYX_INDEXER_EVM_START_HEIGHT must be a block height");
  const intervalMs = Number(environment.NARYX_INDEXER_INTERVAL_MS ?? "5000");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) fail("NARYX_INDEXER_INTERVAL_MS must be at least 1000");
  return {
    dbPath,
    intervalMs,
    source: {
      domainId,
      contracts,
      rpcs: rpcUrls.map((url) => new EvmJsonRpc(url)),
      startHeight,
      ...(bondVaults.length === 0 ? {} : { bondVaults }),
      ...(coordinators.length === 0 ? {} : { coordinators }),
    },
  };
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
