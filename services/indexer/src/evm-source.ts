import { createHash } from "node:crypto";
import type { EvidenceGrade, IndexedEventKind } from "./package-record.js";
import { BOND_VAULT_TOPICS, decodeBondVaultLog, type ObservedBondEvent } from "./bond-vault.js";
import { COORDINATOR_TOPICS, decodeCoordinatorLog, type ObservedCoordinatorEvent } from "./async-coordinator.js";
import type { FinalityCheckpoint, ObservedBlock, ObservedChainEvent, SqliteReceiptIndex } from "./receipt-index.js";

/** keccak256("PackageVerified(bytes32,address,uint8,address,bool,uint256,uint256,bytes32,bytes32)") */
export const PACKAGE_VERIFIED_TOPIC = "0x7d4bf77eca9a7ed43dff1ec60f0b276560304beacc9bcc533979873371694e6c";
/** keccak256("PackageExecuted(bytes32,address,uint8,address,bool,uint256,uint256)") */
export const PACKAGE_EXECUTED_TOPIC = "0x35bce0f4060b2fcf5d50ac374aec87723512a4a6bf9ed1bf63d20be7356de9ed";

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const EIP155_DOMAIN = /^eip155:([1-9][0-9]{0,18})$/;
/** A block range read in one `eth_getLogs` call; kept small so a public endpoint answers it. */
const MAX_BLOCKS_PER_PASS = 50;

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RpcBlock {
  readonly number: string;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp?: string;
}

export interface RpcLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: string;
  readonly removed?: boolean;
}

/** One read-only JSON-RPC endpoint. It holds no key and sends no transaction. */
export class EvmJsonRpc {
  readonly url: string;
  readonly #fetch: Fetch;
  #id = 0;

  constructor(url: string, fetcher: Fetch = fetch as unknown as Fetch) {
    if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?(\/|$))/.test(url)) throw new Error("RPC URLs must be https or loopback http");
    this.url = url;
    this.#fetch = fetcher;
  }

  async #call(method: "eth_chainId" | "eth_blockNumber" | "eth_getBlockByNumber" | "eth_getLogs", params: readonly unknown[]): Promise<unknown> {
    this.#id += 1;
    const response = await this.#fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.#id, method, params }),
    });
    if (!response.ok) throw new Error(`${method} answered HTTP ${response.status}`);
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error !== undefined) throw new Error(`${method} failed: ${String(body.error.message ?? "unknown error")}`);
    return body.result;
  }

  /** The chain id the endpoint reports; the chain data that proves which chain it serves. */
  async chainId(): Promise<bigint> {
    const value = await this.#call("eth_chainId", []);
    if (typeof value !== "string" || !QUANTITY.test(value)) throw new Error("chainId is not a hex quantity");
    return BigInt(value);
  }

  async blockNumber(): Promise<number> {
    return quantity(await this.#call("eth_blockNumber", []), "blockNumber");
  }

  async block(tag: number | "safe" | "finalized"): Promise<RpcBlock | null> {
    const result = await this.#call("eth_getBlockByNumber", [typeof tag === "number" ? `0x${tag.toString(16)}` : tag, false]);
    if (result === null) return null;
    const block = result as RpcBlock;
    if (typeof block !== "object" || !HEX32.test(String(block.hash)) || !HEX32.test(String(block.parentHash))) throw new Error("block response is malformed");
    quantity(block.number, "block.number");
    return block;
  }

  /**
   * Logs of a height range, or of exactly one block when `blockHash` is given (EIP-234): a
   * backend that has not imported that block then errors instead of answering with no logs.
   */
  async logs(fromBlock: number, toBlock: number, addresses: readonly string[], topics: readonly string[], blockHash?: string): Promise<readonly RpcLog[]> {
    const range = blockHash === undefined ? { fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` } : { blockHash };
    const result = await this.#call("eth_getLogs", [{ ...range, address: addresses, topics: [topics] }]);
    if (!Array.isArray(result)) throw new Error("logs response is not a list");
    return result as RpcLog[];
  }
}

function quantity(value: unknown, context: string): number {
  if (typeof value !== "string" || !QUANTITY.test(value)) throw new Error(`${context} is not a hex quantity`);
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${context} is out of range`);
  return parsed;
}

function word(data: string, index: number): string {
  return data.slice(2 + index * 64, 2 + (index + 1) * 64);
}

/**
 * Decodes one verifier or executor settlement log into an indexed chain event. The receipt hash is
 * the package identity and the transaction hash the attempt; the fields hash commits to the exact
 * log topics and data. A recovery settlement is indexed as RECOVERED, any other as SETTLED.
 */
export function decodeSettlementLog(log: RpcLog, evidenceGrade: EvidenceGrade): ObservedChainEvent {
  const topics = log.topics.map((topic) => topic.toLowerCase());
  const data = log.data.toLowerCase();
  if (!/^0x([0-9a-f]{64})*$/.test(data)) throw new Error("log data is not whole words");
  if (topics.length !== 4 || !topics.every((topic) => HEX32.test(topic))) throw new Error("a settlement log carries four topics");
  const signature = topics[0];
  // PackageVerified carries solver, recovery, base, quote, intent, and fill words; PackageExecuted solver, recovery, quantity, and quote.
  const words = signature === PACKAGE_VERIFIED_TOPIC ? 6 : signature === PACKAGE_EXECUTED_TOPIC ? 4 : -1;
  if (words < 0) throw new Error("not a settlement log");
  if ((data.length - 2) / 64 !== words) throw new Error("settlement log data has the wrong length");
  const recoveryWord = word(data, 1);
  if (!/^0{63}[01]$/.test(recoveryWord)) throw new Error("recovery flag is not a boolean");
  const transactionHash = log.transactionHash.toLowerCase();
  if (!HEX32.test(transactionHash) || !ADDRESS.test(log.address.toLowerCase())) throw new Error("log identity is malformed");
  const kind: IndexedEventKind = recoveryWord.endsWith("1") ? "RECOVERED" : "SETTLED";
  const fieldsHashHex = createHash("sha256").update(Buffer.from([...topics, data].map((part) => part.slice(2)).join(""), "hex")).digest("hex");
  return Object.freeze({
    locator: `${transactionHash}:${quantity(log.logIndex, "logIndex")}`,
    packageId: `evm-receipt:${(topics[1] as string).slice(2)}`,
    attemptId: `evm-tx:${transactionHash.slice(2)}`,
    kind,
    evidenceGrade,
    fieldsHashHex,
  });
}

/** The chain id of a CAIP-2 eip155 domain such as `eip155:84532`; any other domain is refused. */
export function evmChainIdOfDomain(domainId: string): bigint {
  const match = typeof domainId === "string" ? EIP155_DOMAIN.exec(domainId) : null;
  if (match === null) throw new Error("an EVM domain must be a CAIP-2 eip155 chain reference such as eip155:84532");
  return BigInt(match[1] as string);
}

/**
 * Every endpoint must report the domain's chain id, so a mislabeled URL can never feed another
 * chain's blocks into this domain. Endpoints are named by position: a URL may carry a provider key.
 */
export async function verifyChainIds(source: EvmIndexerSource): Promise<void> {
  const expected = evmChainIdOfDomain(source.domainId);
  const reported = await Promise.all(source.rpcs.map((rpc) => rpc.chainId()));
  for (const [position, chainId] of reported.entries()) {
    if (chainId !== expected) throw new Error(`RPC endpoint ${position + 1} serves eip155:${chainId}, not ${source.domainId}`);
  }
}

export interface EvmIndexerSource {
  /** A CAIP-2 eip155 chain reference, for example `eip155:84532` or `eip155:421614`. */
  readonly domainId: string;
  /** Settlement contracts emitting PackageVerified or PackageExecuted; may be empty when only coordinators are followed. */
  readonly contracts: readonly string[];
  /** One endpoint, or several independent ones that must agree. */
  readonly rpcs: readonly EvmJsonRpc[];
  readonly startHeight: number;
  /** Performance bond vaults whose logs are indexed alongside settlement logs. */
  readonly bondVaults?: readonly string[];
  /** AsyncBondedPackageCoordinator contracts whose package lifecycle logs are indexed. */
  readonly coordinators?: readonly string[];
}

/**
 * Reads one block from every endpoint and requires them to agree on its hash, parent, and
 * settlement logs. One endpoint reports what it saw (CONTROLLER_ATTESTED); two or more agreeing
 * independent endpoints corroborate it (VENUE_API_CORROBORATED). Nothing here claims consensus
 * verification, which needs a light client.
 */
export async function readBlock(source: EvmIndexerSource, height: number): Promise<ObservedBlock | null> {
  const grade: EvidenceGrade = source.rpcs.length >= 2 ? "VENUE_API_CORROBORATED" : "CONTROLLER_ATTESTED";
  const views = await Promise.all(
    source.rpcs.map(async (rpc) => {
      const block = await rpc.block(height);
      if (block === null) return null;
      // Logs are read for this exact block hash; a log from any other block means the endpoint is
      // on another view of the chain, so the read fails and retries rather than dropping events.
      const inBlock = (log: RpcLog) => {
        if (log.removed === true) return false;
        if (log.blockHash.toLowerCase() !== block.hash.toLowerCase()) throw new Error(`logs for height ${height} came from another block`);
        return true;
      };
      // An empty address list would match every contract's logs, so no list means no query.
      const logs = source.contracts.length === 0 ? [] : (await rpc.logs(height, height, source.contracts, [PACKAGE_VERIFIED_TOPIC, PACKAGE_EXECUTED_TOPIC], block.hash)).filter(inBlock);
      let bondEvents: ObservedBondEvent[] = [];
      if (source.bondVaults !== undefined && source.bondVaults.length > 0) {
        const bondLogs = (await rpc.logs(height, height, source.bondVaults, BOND_VAULT_TOPICS, block.hash)).filter(inBlock);
        if (bondLogs.length > 0) {
          // Claim times are block times, so a vault log is unusable without its block's timestamp.
          const timestamp = quantity(block.timestamp, "block.timestamp");
          bondEvents = bondLogs.map((log) => decodeBondVaultLog(log, timestamp, grade)).sort((a, b) => (a.locator < b.locator ? -1 : 1));
        }
      }
      let coordinatorEvents: ObservedCoordinatorEvent[] = [];
      if (source.coordinators !== undefined && source.coordinators.length > 0) {
        coordinatorEvents = (await rpc.logs(height, height, source.coordinators, COORDINATOR_TOPICS, block.hash))
          .filter(inBlock)
          .map((log) => decodeCoordinatorLog(log, grade))
          .sort((a, b) => (a.locator < b.locator ? -1 : 1));
      }
      return { block, events: logs.map((log) => decodeSettlementLog(log, grade)).sort((a, b) => (a.locator < b.locator ? -1 : 1)), bondEvents, coordinatorEvents };
    }),
  );
  if (views.some((view) => view === null)) return null;
  const [first, ...rest] = views as { block: RpcBlock; events: ObservedChainEvent[]; bondEvents: ObservedBondEvent[]; coordinatorEvents: ObservedCoordinatorEvent[] }[];
  if (first === undefined) return null;
  for (const view of rest) {
    if (
      view.block.hash !== first.block.hash ||
      view.block.parentHash !== first.block.parentHash ||
      JSON.stringify(view.events) !== JSON.stringify(first.events) ||
      JSON.stringify(view.bondEvents) !== JSON.stringify(first.bondEvents) ||
      JSON.stringify(view.coordinatorEvents) !== JSON.stringify(first.coordinatorEvents)
    ) {
      throw new Error(`endpoints disagree about block ${height}`);
    }
  }
  return {
    height,
    blockHashHex: first.block.hash.slice(2).toLowerCase(),
    parentHashHex: first.block.parentHash.slice(2).toLowerCase(),
    events: first.events,
    ...(first.bondEvents.length === 0 ? {} : { bondEvents: first.bondEvents }),
    ...(first.coordinatorEvents.length === 0 ? {} : { coordinatorEvents: first.coordinatorEvents }),
  };
}

/**
 * One indexing pass: prove every endpoint serves the domain's chain, follow the chain from the
 * index tip toward the endpoint's head, replaying from the fork point whenever a block does not
 * extend the canonical chain, then advance confirmation to the endpoint's safe block and finality
 * to its finalized block when the index holds them.
 */
export async function runEvmIndexerPass(index: SqliteReceiptIndex, source: EvmIndexerSource): Promise<{ readonly ingested: number; readonly reorgs: number; readonly tip: number | null }> {
  const primary = source.rpcs[0];
  if (primary === undefined) throw new Error("an EVM source needs at least one RPC endpoint");
  await verifyChainIds(source);
  const head = await primary.blockNumber();
  const state = index.domainState(source.domainId);
  const tipHeight = state?.tipHeight ?? null;
  let next = tipHeight === null ? source.startHeight : tipHeight + 1;
  let ingested = 0;
  let reorgs = 0;
  let steps = 0;
  while (next <= head && steps < MAX_BLOCKS_PER_PASS) {
    steps += 1;
    const block = await readBlock(source, next);
    if (block === null) break;
    try {
      const result = index.ingestBlock(source.domainId, block);
      if (result.status === "REORGED") reorgs += 1;
      if (result.status !== "DUPLICATE") ingested += 1;
      next += 1;
    } catch (error) {
      // The endpoint followed another branch: step back until a block extends what the index holds.
      if ((error as { code?: string }).code === "PARENT_UNKNOWN" && next > source.startHeight) {
        next -= 1;
        continue;
      }
      throw error;
    }
  }
  const checkpoint = async (tag: "safe" | "finalized"): Promise<FinalityCheckpoint | undefined> => {
    const block = await primary.block(tag).catch(() => null);
    if (block === null) return undefined;
    return { height: Number.parseInt(block.number.slice(2), 16), blockHashHex: block.hash.slice(2).toLowerCase() };
  };
  const [safe, finalized] = await Promise.all([checkpoint("safe"), checkpoint("finalized")]);
  const tip = index.domainState(source.domainId)?.tipHeight ?? null;
  if (safe !== undefined && finalized !== undefined && tip !== null && safe.height <= tip && finalized.height <= safe.height && finalized.height >= source.startHeight) {
    try {
      index.advanceFinality(source.domainId, safe, finalized);
    } catch (error) {
      // A checkpoint on a branch the index has not replayed yet waits for the next pass.
      if ((error as { code?: string }).code !== "FORK_MISMATCH" && (error as { code?: string }).code !== "UNKNOWN_BLOCK") throw error;
    }
  }
  return { ingested, reorgs, tip };
}
