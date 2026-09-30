import { createHash } from "node:crypto";
import type { EvidenceGrade, IndexedEventKind } from "./package-record.js";
import type { FinalityCheckpoint, ObservedBlock, ObservedChainEvent, SqliteReceiptIndex } from "./receipt-index.js";

/** keccak256("PackageVerified(bytes32,address,uint8,address,bool,uint256,uint256,bytes32,bytes32)") */
export const PACKAGE_VERIFIED_TOPIC = "0x7d4bf77eca9a7ed43dff1ec60f0b276560304beacc9bcc533979873371694e6c";
/** keccak256("PackageExecuted(bytes32,address,uint8,address,bool,uint256,uint256)") */
export const PACKAGE_EXECUTED_TOPIC = "0x35bce0f4060b2fcf5d50ac374aec87723512a4a6bf9ed1bf63d20be7356de9ed";

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
/** A block range read in one `eth_getLogs` call; kept small so a public endpoint answers it. */
const MAX_BLOCKS_PER_PASS = 50;

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RpcBlock {
  readonly number: string;
  readonly hash: string;
  readonly parentHash: string;
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
    if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)/.test(url)) throw new Error("RPC URLs must be https or loopback http");
    this.url = url;
    this.#fetch = fetcher;
  }

  async #call(method: "eth_blockNumber" | "eth_getBlockByNumber" | "eth_getLogs", params: readonly unknown[]): Promise<unknown> {
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

  async logs(fromBlock: number, toBlock: number, addresses: readonly string[], topics: readonly string[]): Promise<readonly RpcLog[]> {
    const result = await this.#call("eth_getLogs", [{ fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`, address: addresses, topics: [topics] }]);
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

export interface EvmIndexerSource {
  readonly domainId: string;
  readonly contracts: readonly string[];
  /** One endpoint, or several independent ones that must agree. */
  readonly rpcs: readonly EvmJsonRpc[];
  readonly startHeight: number;
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
      const logs = (await rpc.logs(height, height, source.contracts, [PACKAGE_VERIFIED_TOPIC, PACKAGE_EXECUTED_TOPIC]))
        .filter((log) => log.removed !== true && log.blockHash.toLowerCase() === block.hash.toLowerCase());
      return { block, events: logs.map((log) => decodeSettlementLog(log, grade)).sort((a, b) => (a.locator < b.locator ? -1 : 1)) };
    }),
  );
  if (views.some((view) => view === null)) return null;
  const [first, ...rest] = views as { block: RpcBlock; events: ObservedChainEvent[] }[];
  if (first === undefined) return null;
  for (const view of rest) {
    if (view.block.hash !== first.block.hash || view.block.parentHash !== first.block.parentHash || JSON.stringify(view.events) !== JSON.stringify(first.events)) {
      throw new Error(`endpoints disagree about block ${height}`);
    }
  }
  return { height, blockHashHex: first.block.hash.slice(2).toLowerCase(), parentHashHex: first.block.parentHash.slice(2).toLowerCase(), events: first.events };
}

/**
 * One indexing pass: follow the chain from the index tip toward the endpoint's head, replaying
 * from the fork point whenever a block does not extend the canonical chain, then advance
 * confirmation to the endpoint's safe block and finality to its finalized block when the index
 * holds them.
 */
export async function runEvmIndexerPass(index: SqliteReceiptIndex, source: EvmIndexerSource): Promise<{ readonly ingested: number; readonly reorgs: number; readonly tip: number | null }> {
  const primary = source.rpcs[0];
  if (primary === undefined) throw new Error("an EVM source needs at least one RPC endpoint");
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
