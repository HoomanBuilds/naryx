import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvmJsonRpc, PACKAGE_EXECUTED_TOPIC, PACKAGE_VERIFIED_TOPIC, SqliteReceiptIndex, decodeSettlementLog, evmChainIdOfDomain, runEvmIndexerPass, type RpcLog } from "../src/index.js";

const CONTRACT = `0x${"ab".repeat(20)}`;
const hash = (label: string, height: number) => `0x${Buffer.from(`${label}:${height}`).toString("hex").padEnd(64, "0").slice(0, 64)}`;
const quantity = (value: number) => `0x${value.toString(16)}`;
const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");

function verifiedLog(blockHash: string, height: number, receipt: string, recovery: boolean, logIndex = 0): RpcLog {
  return {
    address: CONTRACT,
    topics: [PACKAGE_VERIFIED_TOPIC, `0x${receipt.repeat(32)}`, `0x${"00".repeat(12)}${"11".repeat(20)}`, `0x${word(1)}`],
    data: `0x${word(0x22)}${word(recovery ? 1 : 0)}${word(1_000n)}${word(150_000n)}${"33".repeat(32)}${"44".repeat(32)}`,
    blockNumber: quantity(height),
    blockHash,
    transactionHash: `0x${receipt.repeat(16)}${"ee".repeat(16)}`,
    logIndex: quantity(logIndex),
  };
}

/** An in-memory chain behind a JSON-RPC stub, with a branch that can be swapped for a reorg. */
function chain(chainId = 84532) {
  let branch = "main";
  let head = 5;
  const blockHash = (height: number) => (height <= 3 ? hash("main", height) : hash(branch, height));
  const logs = new Map<string, RpcLog[]>();
  const fetcher = async (_url: string, init: { body: string }) => {
    const { method, params, id } = JSON.parse(init.body);
    let result: unknown;
    if (method === "eth_chainId") result = quantity(chainId);
    else if (method === "eth_blockNumber") result = quantity(head);
    else if (method === "eth_getBlockByNumber") {
      const tag = params[0] as string;
      const height = tag === "finalized" ? 2 : tag === "safe" ? 3 : Number.parseInt(tag.slice(2), 16);
      result = height > head ? null : { number: quantity(height), hash: blockHash(height), parentHash: height === 0 ? `0x${"00".repeat(32)}` : blockHash(height - 1) };
    } else if (method === "eth_getLogs") {
      result = logs.get(params[0].blockHash as string) ?? [];
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
  return {
    fetcher,
    setBranch(name: string) {
      branch = name;
    },
    setHead(height: number) {
      head = height;
    },
    addLog(height: number, receipt: string, recovery = false) {
      const at = blockHash(height);
      logs.set(at, [...(logs.get(at) ?? []), verifiedLog(at, height, receipt, recovery)]);
    },
  };
}

test("settlement logs decode into indexed events bound to their exact topics and data", () => {
  const event = decodeSettlementLog(verifiedLog(hash("main", 4), 4, "5a", false), "CONTROLLER_ATTESTED");
  assert.equal(event.kind, "SETTLED");
  assert.equal(event.packageId, `evm-receipt:${"5a".repeat(32)}`);
  assert.equal(decodeSettlementLog(verifiedLog(hash("main", 4), 4, "5a", true), "CONTROLLER_ATTESTED").kind, "RECOVERED");
  const executed = { ...verifiedLog(hash("main", 4), 4, "5b", false), topics: [PACKAGE_EXECUTED_TOPIC, `0x${"5b".repeat(32)}`, `0x${"00".repeat(32)}`, `0x${word(2)}`], data: `0x${word(0x22)}${word(0)}${word(7)}${word(8)}` };
  assert.equal(decodeSettlementLog(executed, "CONTROLLER_ATTESTED").kind, "SETTLED");
  assert.throws(() => decodeSettlementLog({ ...executed, data: `0x${word(1)}` }, "CONTROLLER_ATTESTED"), /wrong length/);
  assert.throws(() => decodeSettlementLog({ ...executed, topics: [`0x${"99".repeat(32)}`, ...executed.topics.slice(1)] }, "CONTROLLER_ATTESTED"), /not a settlement log/);
  const badFlag = verifiedLog(hash("main", 4), 4, "5a", false);
  assert.throws(() => decodeSettlementLog({ ...badFlag, data: `0x${word(0x22)}${word(2)}${badFlag.data.slice(130)}` }, "CONTROLLER_ATTESTED"), /boolean/);
});

test("a pass follows the chain, replays a reorg from its fork point, and finalizes only held blocks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-evm-index-"));
  const index = new SqliteReceiptIndex(join(dir, "index.sqlite"));
  const stub = chain();
  stub.addLog(4, "5a");
  const source = { domainId: "eip155:84532", contracts: [CONTRACT], rpcs: [new EvmJsonRpc("http://127.0.0.1:8545", stub.fetcher as never)], startHeight: 0 };
  try {
    const first = await runEvmIndexerPass(index, source);
    assert.deepEqual(first, { ingested: 6, reorgs: 0, tip: 5 });
    const state = index.domainState("eip155:84532");
    assert.equal(state?.finalizedHeight, 2);
    assert.equal(state?.confirmedHeight, 3);

    // Blocks 4 and 5 are replaced by another branch; the pass steps back to the fork and replays.
    stub.setBranch("fork");
    stub.addLog(5, "5c", true);
    stub.setHead(6);
    const second = await runEvmIndexerPass(index, source);
    assert.equal(second.reorgs, 1);
    assert.equal(second.tip, 6);
    assert.equal(index.domainState("eip155:84532")?.reorgCount, 1);
  } finally {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("independent endpoints must agree before their view is graded as corroborated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-evm-index-"));
  const index = new SqliteReceiptIndex(join(dir, "index.sqlite"));
  const honest = chain();
  const lying = chain();
  lying.setBranch("forged");
  try {
    const source = { domainId: "eip155:84532", contracts: [CONTRACT], rpcs: [new EvmJsonRpc("http://127.0.0.1:8545", honest.fetcher as never), new EvmJsonRpc("http://127.0.0.1:8546", lying.fetcher as never)], startHeight: 0 };
    await assert.rejects(runEvmIndexerPass(index, source), /disagree about block 4/);
    assert.throws(() => new EvmJsonRpc("http://example.com"), /https or loopback/);
  } finally {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every endpoint must report the domain's chain id before anything is indexed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-evm-index-"));
  const index = new SqliteReceiptIndex(join(dir, "index.sqlite"));
  const base = chain(84532);
  base.addLog(4, "5a");
  // A second "Base Sepolia" URL that actually serves Arbitrum Sepolia.
  const arbitrum = chain(421614);
  try {
    const rpcs = [new EvmJsonRpc("http://127.0.0.1:8545", base.fetcher as never), new EvmJsonRpc("http://127.0.0.1:8546", arbitrum.fetcher as never)];
    await assert.rejects(runEvmIndexerPass(index, { domainId: "eip155:84532", contracts: [CONTRACT], rpcs, startHeight: 0 }), /RPC endpoint 2 serves eip155:421614, not eip155:84532/);
    assert.equal(index.domainState("eip155:84532"), undefined);
    await assert.rejects(runEvmIndexerPass(index, { domainId: "base-sepolia", contracts: [CONTRACT], rpcs: [rpcs[0] as EvmJsonRpc], startHeight: 0 }), /CAIP-2 eip155/);
    assert.equal(evmChainIdOfDomain("eip155:421614"), 421614n);
    assert.throws(() => evmChainIdOfDomain("eip155:0"), /CAIP-2/);
    assert.throws(() => new EvmJsonRpc("http://localhost.example.com"), /https or loopback/);
    assert.equal((await runEvmIndexerPass(index, { domainId: "eip155:84532", contracts: [CONTRACT], rpcs: [rpcs[0] as EvmJsonRpc], startHeight: 0 })).tip, 5);
  } finally {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
