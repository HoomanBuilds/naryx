import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BOND_OPENED_TOPIC,
  BOND_RELEASED_TOPIC,
  CLAIM_DISPUTED_TOPIC,
  CLAIM_FILED_TOPIC,
  CLAIM_PAID_TOPIC,
  CLAIM_RESOLVED_TOPIC,
  EvmJsonRpc,
  SqliteReceiptIndex,
  decodeBondVaultLog,
  runEvmIndexerPass,
  type RpcLog,
} from "../src/index.js";

const SETTLEMENT = `0x${"ab".repeat(20)}`;
const VAULT = `0x${"cd".repeat(20)}`;
const SOLVER = `0x${"51".repeat(20)}`;
const TOKEN = `0x${"70".repeat(20)}`;
const TAKER = `0x${"7a".repeat(20)}`;
const BOND = "b0".repeat(32);
const EVIDENCE_A = "ea".repeat(32);
const EVIDENCE_C = "ec".repeat(32);
const word = (value: bigint | number | boolean) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (address: string) => `${"00".repeat(12)}${address.slice(2)}`;
const quantity = (value: number) => `0x${value.toString(16)}`;
const blockHash = (branch: string, height: number) => `0x${Buffer.from(`${branch}:${height}`).toString("hex").padEnd(64, "0").slice(0, 64)}`;

type Draft = Pick<RpcLog, "topics" | "data">;
const opened = (): Draft => ({
  topics: [BOND_OPENED_TOPIC, `0x${BOND}`, `0x${addressWord(SOLVER)}`, `0x${addressWord(TOKEN)}`],
  data: `0x${word(1_000)}${word(0b110)}${word(600)}${word(100)}${word(5_000)}`,
});
const filed = (evidence: string, fault: number, payout: number): Draft => ({
  topics: [CLAIM_FILED_TOPIC, `0x${BOND}`, `0x${evidence}`],
  data: `0x${word(fault)}${word(payout)}${addressWord(TAKER)}`,
});
const disputed = (evidence: string): Draft => ({ topics: [CLAIM_DISPUTED_TOPIC, `0x${BOND}`, `0x${evidence}`], data: "0x" });
const resolved = (evidence: string, upheld: boolean): Draft => ({ topics: [CLAIM_RESOLVED_TOPIC, `0x${BOND}`, `0x${evidence}`], data: `0x${word(upheld)}` });
const paid = (evidence: string, payout: number): Draft => ({ topics: [CLAIM_PAID_TOPIC, `0x${BOND}`, `0x${evidence}`, `0x${addressWord(TAKER)}`], data: `0x${word(payout)}` });
const released = (returned: number): Draft => ({ topics: [BOND_RELEASED_TOPIC, `0x${BOND}`, `0x${addressWord(SOLVER)}`], data: `0x${word(returned)}` });

/** A chain whose blocks carry vault logs at fixed timestamps, behind a JSON-RPC stub. */
function chain(blocks: ReadonlyMap<number, { readonly timestamp: number; readonly logs: readonly Draft[] }>, head: number) {
  const hashOf = (height: number) => blockHash("main", height);
  const logsAt = (height: number): RpcLog[] =>
    (blocks.get(height)?.logs ?? []).map((draft, logIndex) => ({
      ...draft,
      address: VAULT,
      blockNumber: quantity(height),
      blockHash: hashOf(height),
      transactionHash: `0x${word(height * 100 + logIndex)}`,
      logIndex: quantity(logIndex),
    }));
  return async (_url: string, init: { body: string }) => {
    const { method, params, id } = JSON.parse(init.body);
    let result: unknown;
    if (method === "eth_blockNumber") result = quantity(head);
    else if (method === "eth_getBlockByNumber") {
      const tag = params[0] as string;
      const height = tag === "finalized" ? 1 : tag === "safe" ? 2 : Number.parseInt(tag.slice(2), 16);
      result = height > head
        ? null
        : { number: quantity(height), hash: hashOf(height), parentHash: height === 0 ? `0x${"00".repeat(32)}` : hashOf(height - 1), timestamp: quantity(blocks.get(height)?.timestamp ?? 900 + height) };
    } else if (method === "eth_getLogs") {
      const filter = params[0] as { fromBlock: string; address: string[]; topics: string[][] };
      result = logsAt(Number.parseInt(filter.fromBlock.slice(2), 16)).filter((log) => filter.address.includes(log.address) && (filter.topics[0] as string[]).includes(log.topics[0] as string));
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
}

const LIFECYCLE = new Map([
  [1, { timestamp: 1_000, logs: [opened()] }],
  [2, { timestamp: 1_010, logs: [filed(EVIDENCE_A, 1, 400)] }],
  [3, { timestamp: 1_020, logs: [filed(EVIDENCE_C, 2, 300), disputed(EVIDENCE_C)] }],
  // A dispute resolved against the solver pays in the same transaction; claim A settles after its window.
  [4, { timestamp: 1_200, logs: [resolved(EVIDENCE_C, false), paid(EVIDENCE_C, 300), paid(EVIDENCE_A, 400)] }],
  [5, { timestamp: 5_000, logs: [released(300)] }],
]);

async function indexed(blocks: ReadonlyMap<number, { timestamp: number; logs: readonly Draft[] }>, head: number, run: (index: SqliteReceiptIndex) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "naryx-bond-index-"));
  const index = new SqliteReceiptIndex(join(dir, "index.sqlite"));
  try {
    const source = { domainId: "eip155:84532", contracts: [SETTLEMENT], bondVaults: [VAULT], rpcs: [new EvmJsonRpc("http://127.0.0.1:8545", chain(blocks, head) as never)], startHeight: 0 };
    await runEvmIndexerPass(index, source);
    await run(index);
  } finally {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("vault logs decode word by word and refuse wrong shapes", () => {
  const log = { ...opened(), address: VAULT, transactionHash: `0x${word(7)}`, logIndex: "0x2" };
  const event = decodeBondVaultLog(log, 1_000, "CONTROLLER_ATTESTED");
  assert.equal(event.type, "BOND_OPENED");
  assert.equal(event.bondIdHex, BOND);
  assert.equal(event.locator, `0x${word(7)}:2`);
  assert.deepEqual(event.fields, { solver: SOLVER, asset: TOKEN, bondAtoms: "1000", coveredFaults: 6, maximumPayoutPerClaim: "600", disputeWindow: "100", expiresAt: "5000" });
  assert.throws(() => decodeBondVaultLog({ ...log, data: `0x${word(1)}` }, 1_000, "CONTROLLER_ATTESTED"), /wrong length/);
  assert.throws(() => decodeBondVaultLog({ ...log, data: `0x${word(1_000)}${word(256)}${word(600)}${word(100)}${word(5_000)}` }, 1_000, "CONTROLLER_ATTESTED"), /uint8/);
  assert.throws(() => decodeBondVaultLog({ ...log, topics: [`0x${"99".repeat(32)}`, ...log.topics.slice(1)] }, 1_000, "CONTROLLER_ATTESTED"), /not a bond vault log/);
  const resolution = decodeBondVaultLog({ ...resolved(EVIDENCE_C, true), address: VAULT, transactionHash: `0x${word(8)}`, logIndex: "0x0" }, 1_200, "CONTROLLER_ATTESTED");
  assert.equal(resolution.fields.disputeUpheld, true);
  assert.throws(() => decodeBondVaultLog({ ...resolved(EVIDENCE_C, true), data: `0x${word(2)}`, address: VAULT, transactionHash: `0x${word(8)}`, logIndex: "0x0" }, 1_200, "CONTROLLER_ATTESTED"), /uint1/);
});

test("a bond's canonical vault logs replay through the kernel rules to its exact payouts and remainder", async () => {
  await indexed(LIFECYCLE, 5, (index) => {
    const bond = index.bond("eip155:84532", VAULT, BOND);
    assert.ok(bond !== undefined);
    assert.deepEqual(bond.violations, []);
    assert.equal(bond.status, "RELEASED");
    assert.deepEqual(bond.coveredFaults, ["FAILED_TO_HONOR_FUNDED_RESERVATION", "SUBMITTED_OFF_ROUTE"]);
    assert.equal(bond.paidAtoms, "700");
    assert.equal(bond.returnedAtoms, "300");
    assert.deepEqual(bond.claims.map((claim) => [claim.faultEvidenceHash, claim.state, claim.payoutAtoms, claim.beneficiary]), [
      [EVIDENCE_A, "PAID", "400", TAKER],
      [EVIDENCE_C, "PAID", "300", TAKER],
    ]);
    assert.equal(bond.finality, "OBSERVED", "the release block is above the finalized height");
    assert.equal(bond.evidenceGrade, "CONTROLLER_ATTESTED");
    assert.deepEqual(index.bondsForSolver("eip155:84532", VAULT, SOLVER).map((entry) => entry.bondIdHex), [BOND]);
    assert.deepEqual(index.bondsForSolver("eip155:84532", VAULT, TAKER), []);
  });
});

test("a paid amount, early settlement, or remainder the kernel would not produce marks the bond inconsistent", async () => {
  const wrongPayout = new Map(LIFECYCLE);
  wrongPayout.set(4, { timestamp: 1_200, logs: [resolved(EVIDENCE_C, false), paid(EVIDENCE_C, 300), paid(EVIDENCE_A, 399)] });
  await indexed(wrongPayout, 5, (index) => {
    const bond = index.bond("eip155:84532", VAULT, BOND);
    assert.equal(bond?.status, "INCONSISTENT");
    assert.match(bond?.violations.join("\n") ?? "", /paid amount differs/);
  });
  const early = new Map(LIFECYCLE);
  early.set(4, { timestamp: 1_050, logs: [resolved(EVIDENCE_C, false), paid(EVIDENCE_C, 300), paid(EVIDENCE_A, 400)] });
  await indexed(early, 4, (index) => {
    assert.match(index.bond("eip155:84532", VAULT, BOND)?.violations.join("\n") ?? "", /dispute window is still open/);
  });
  const overReturned = new Map(LIFECYCLE);
  overReturned.set(5, { timestamp: 5_000, logs: [released(301)] });
  await indexed(overReturned, 5, (index) => {
    assert.match(index.bond("eip155:84532", VAULT, BOND)?.violations.join("\n") ?? "", /returned amount differs/);
  });
});

test("a reorged vault log leaves the bond as the canonical chain shows it", () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-bond-reorg-"));
  const index = new SqliteReceiptIndex(join(dir, "index.sqlite"));
  const event = (height: number, logIndex: number, draft: Draft, timestamp: number) =>
    decodeBondVaultLog({ ...draft, address: VAULT, transactionHash: `0x${word(height * 100 + logIndex)}`, logIndex: quantity(logIndex) }, timestamp, "VENUE_API_CORROBORATED");
  const parent = (height: number, branch = "main") => (height === 0 ? "00".repeat(32) : blockHash(branch, height - 1).slice(2));
  try {
    index.ingestBlock("eip155:84532", { height: 0, blockHashHex: blockHash("main", 0).slice(2), parentHashHex: parent(0), events: [] });
    index.ingestBlock("eip155:84532", { height: 1, blockHashHex: blockHash("main", 1).slice(2), parentHashHex: parent(1), events: [], bondEvents: [event(1, 0, opened(), 1_000)] });
    index.ingestBlock("eip155:84532", { height: 2, blockHashHex: blockHash("main", 2).slice(2), parentHashHex: parent(2), events: [], bondEvents: [event(2, 0, filed(EVIDENCE_A, 1, 400), 1_010)] });
    assert.equal(index.bond("eip155:84532", VAULT, BOND)?.claims.length, 1);
    assert.equal(index.bond("eip155:84532", VAULT, BOND)?.encumberedAtoms, "400");
    const reorg = index.ingestBlock("eip155:84532", { height: 2, blockHashHex: blockHash("fork", 2).slice(2), parentHashHex: parent(2), events: [] });
    assert.equal(reorg.status, "REORGED");
    const bond = index.bond("eip155:84532", VAULT, BOND);
    assert.equal(bond?.status, "OPEN");
    assert.equal(bond?.claims.length, 0);
    assert.equal(bond?.evidenceGrade, "VENUE_API_CORROBORATED");
    // A known block hash with different bond content is refused, not rewritten.
    assert.throws(
      () => index.ingestBlock("eip155:84532", { height: 1, blockHashHex: blockHash("main", 1).slice(2), parentHashHex: parent(1), events: [], bondEvents: [] }),
      /different content/,
    );
    assert.equal(index.bond("eip155:84532", VAULT, "ff".repeat(32)), undefined);
  } finally {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
