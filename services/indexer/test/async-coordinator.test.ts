import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  BOND_SLASHED_TOPIC,
  EvmJsonRpc,
  PACKAGE_RELEASED_TOPIC,
  PACKAGE_TRANSITION_TOPIC,
  SqliteReceiptIndex,
  decodeCoordinatorLog,
  runEvmIndexerPass,
  type ObservedBlock,
  type RpcLog,
} from "../src/index.js";

const DOMAIN = "eip155:421614";
const COORDINATOR = `0x${"c0".repeat(20)}`;
const OWNER = `0x${"0a".repeat(20)}`;
const BOND_RECIPIENT = `0x${"5b".repeat(20)}`;
const RESERVE_RECIPIENT = `0x${"7e".repeat(20)}`;
const PACKAGE = "a1".repeat(32);
const STATE = { RESERVED: 1, REQUEST_SUBMITTED: 2, VENUE_PENDING: 3, EXECUTED: 4, CANCELLED: 5, FROZEN: 6, RECOVERY_PENDING: 7, RECOVERED: 8, MANUAL_INTERVENTION: 9, CLOSED: 10 } as const;
const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (address: string) => `${"00".repeat(12)}${address.slice(2)}`;
const quantity = (value: number) => `0x${value.toString(16)}`;
const labelHash = (label: string) => Buffer.from(label).toString("hex").padEnd(64, "0").slice(0, 64);

type Draft = Pick<RpcLog, "topics" | "data">;
const transition = (state: keyof typeof STATE, version: number, packageId = PACKAGE): Draft => ({
  topics: [PACKAGE_TRANSITION_TOPIC, `0x${packageId}`],
  data: `0x${word(STATE[state])}${word(version)}${"e0".repeat(32)}`,
});
const released = (reserveAtoms: number, lossAtoms: number, packageId = PACKAGE): Draft => ({
  topics: [PACKAGE_RELEASED_TOPIC, `0x${packageId}`],
  data: `0x${addressWord(BOND_RECIPIENT)}${addressWord(RESERVE_RECIPIENT)}${word(reserveAtoms)}${addressWord(OWNER)}${word(lossAtoms)}`,
});
const slashed = (bondAtoms: number, packageId = PACKAGE): Draft => ({ topics: [BOND_SLASHED_TOPIC, `0x${packageId}`], data: `0x${word(bondAtoms)}` });
const asLog = (draft: Draft, tx: number, logIndex: number, blockHash = `0x${"00".repeat(32)}`): RpcLog => ({
  ...draft,
  address: COORDINATOR,
  blockNumber: "0x0",
  blockHash,
  transactionHash: `0x${word(tx)}`,
  logIndex: quantity(logIndex),
});
/** A block of coordinator logs, each given with its transaction and block-wide log index. */
const block = (height: number, label: string, parent: string, logs: readonly (readonly [Draft, number, number])[] = []): ObservedBlock => ({
  height,
  blockHashHex: labelHash(label),
  parentHashHex: labelHash(parent),
  events: [],
  coordinatorEvents: logs.map(([draft, tx, logIndex]) => decodeCoordinatorLog(asLog(draft, tx, logIndex), "VENUE_API_CORROBORATED")),
});

function withIndex(run: (index: SqliteReceiptIndex, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "naryx-coordinator-"));
  const path = join(dir, "index.sqlite");
  const index = new SqliteReceiptIndex(path);
  try {
    run(index, path);
  } finally {
    try {
      index.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("coordinator logs decode with every word checked against its declared width", () => {
  const decode = (draft: Draft) => decodeCoordinatorLog(asLog(draft, 1, 3), "CONTROLLER_ATTESTED");
  const executed = decode(transition("EXECUTED", 4));
  assert.deepEqual([executed.type, executed.packageIdHex, executed.locator], ["PACKAGE_TRANSITION", PACKAGE, `0x${word(1)}:3`]);
  assert.deepEqual(executed.fields, { state: "EXECUTED", stateVersion: "4", evidenceHash: "e0".repeat(32) });
  assert.deepEqual(decode(released(900, 100)).fields, { bondRecipient: BOND_RECIPIENT, reserveRecipient: RESERVE_RECIPIENT, reserveAtoms: "900", lossRecipient: OWNER, lossAtoms: "100" });
  assert.deepEqual(decode(slashed(500)).fields, { bondAtoms: "500" });

  const withData = (draft: Draft, data: string) => () => decode({ ...draft, data: `0x${data}` });
  assert.throws(withData(transition("EXECUTED", 4), `${word(0)}${word(1)}${word(0)}`), /not a coordinator state/);
  assert.throws(withData(transition("EXECUTED", 4), `${word(11)}${word(1)}${word(0)}`), /not a coordinator state/);
  assert.throws(withData(transition("EXECUTED", 4), `${word(256)}${word(1)}${word(0)}`), /uint8/);
  assert.throws(withData(transition("EXECUTED", 4), `${word(4)}${word(1n << 64n)}${word(0)}`), /uint64/);
  assert.throws(withData(transition("EXECUTED", 4), `${word(4)}${word(0)}${word(0)}`), /stateVersion is zero/);
  assert.throws(withData(released(1, 1), `${word(1n << 160n)}${released(1, 1).data.slice(66)}`), /not an address/);
  assert.throws(withData(slashed(1), `${word(1)}${word(1)}`), /wrong length/);
  assert.throws(() => decode({ ...slashed(1), topics: [...slashed(1).topics, `0x${word(1)}`] }), /2 topics/);
  assert.throws(() => decode({ ...slashed(1), topics: [`0x${"99".repeat(32)}`, `0x${PACKAGE}`] }), /not an async coordinator log/);
});

test("a coordinator package replays its canonical lifecycle, release, and finality, and a reorg drops orphaned logs", () => {
  withIndex((index, path) => {
    index.ingestBlock(DOMAIN, block(0, "b0", "genesis", [[transition("RESERVED", 1), 1, 0]]));
    index.ingestBlock(DOMAIN, block(1, "b1", "b0", [[transition("REQUEST_SUBMITTED", 2), 2, 0], [transition("VENUE_PENDING", 3), 3, 1]]));
    index.ingestBlock(DOMAIN, block(2, "b2", "b1", [[transition("EXECUTED", 4), 4, 0]]));
    let observed = index.asyncPackage(DOMAIN, COORDINATOR, `0x${PACKAGE}`);
    assert.deepEqual([observed?.status, observed?.state, observed?.stateVersion, observed?.observedFromReservation, observed?.finality], ["OPEN", "EXECUTED", "4", true, "OBSERVED"]);

    // The token transfers between CLOSED and the release are other contracts' logs.
    index.ingestBlock(DOMAIN, block(3, "b3", "b2", [[transition("CLOSED", 5), 5, 0], [released(900, 100), 5, 3]]));
    observed = index.asyncPackage(DOMAIN, COORDINATOR, PACKAGE);
    assert.equal(observed?.status, "RELEASED");
    assert.deepEqual(observed?.release, { bondRecipient: BOND_RECIPIENT, reserveRecipient: RESERVE_RECIPIENT, reserveAtoms: "900", lossRecipient: OWNER, lossAtoms: "100" });
    assert.deepEqual(observed?.transitions.map((entry) => entry.state), ["RESERVED", "REQUEST_SUBMITTED", "VENUE_PENDING", "EXECUTED", "CLOSED"]);
    assert.equal(observed?.evidenceGrade, "VENUE_API_CORROBORATED");
    index.advanceFinality(DOMAIN, { height: 3, blockHashHex: labelHash("b3") }, { height: 2, blockHashHex: labelHash("b2") });
    assert.equal(index.asyncPackage(DOMAIN, COORDINATOR, PACKAGE)?.finality, "CONFIRMED");

    // Block 3 is replaced before it finalizes: the close and release are orphaned with it.
    index.ingestBlock(DOMAIN, block(3, "b3x", "b2"));
    observed = index.asyncPackage(DOMAIN, COORDINATOR, PACKAGE);
    assert.deepEqual([observed?.status, observed?.state, observed?.release], ["OPEN", "EXECUTED", null]);
    assert.equal(index.asyncPackage(DOMAIN, COORDINATOR, "b2".repeat(32)), undefined);

    // A slash is recorded with the MANUAL_INTERVENTION transition of its own transaction.
    const missed = "a2".repeat(32);
    index.ingestBlock(DOMAIN, block(4, "b4", "b3x", [[transition("RESERVED", 1, missed), 6, 0]]));
    index.ingestBlock(DOMAIN, block(5, "b5", "b4", [[transition("MANUAL_INTERVENTION", 2, missed), 7, 0], [slashed(500, missed), 7, 1]]));
    observed = index.asyncPackage(DOMAIN, COORDINATOR, missed);
    assert.deepEqual([observed?.status, observed?.state, observed?.slashedBondAtoms, observed?.violations], ["OPEN", "MANUAL_INTERVENTION", "500", []]);

    index.close();
    const raw = new Database(path);
    try {
      assert.throws(() => raw.prepare("DELETE FROM coordinator_events").run(), /append-only/);
    } finally {
      raw.close();
    }
  });
});

test("coordinator events in an order the coordinator cannot emit mark the package INCONSISTENT", () => {
  withIndex((index) => {
    const disorder = "a3".repeat(32);
    const midLife = "a4".repeat(32);
    const unreleased = "a5".repeat(32);
    index.ingestBlock(DOMAIN, block(0, "c0", "genesis", [
      [transition("RESERVED", 1, disorder), 1, 0],
      [transition("VENUE_PENDING", 3, midLife), 2, 1],
      [transition("EXECUTED", 6, unreleased), 3, 2],
    ]));
    index.ingestBlock(DOMAIN, block(1, "c1", "c0", [
      [transition("EXECUTED", 3, disorder), 4, 0],
      [slashed(500, disorder), 5, 1],
      [released(900, 0, disorder), 6, 2],
      [transition("CLOSED", 4, disorder), 7, 3],
      [transition("EXECUTED", 4, midLife), 8, 4],
      [transition("CLOSED", 7, unreleased), 9, 5],
    ]));
    const observed = index.asyncPackage(DOMAIN, COORDINATOR, disorder);
    assert.equal(observed?.status, "INCONSISTENT");
    const violations = observed?.violations ?? [];
    assert.equal(violations.length, 4);
    assert.match(violations[0] ?? "", /state version 3 does not follow 1/);
    assert.match(violations[1] ?? "", /slash must follow a MANUAL_INTERVENTION transition/);
    assert.match(violations[2] ?? "", /release must follow the CLOSED transition/);
    assert.match(violations[3] ?? "", /after its release/);

    // Indexing that starts mid-life is consistent but says the reservation was not observed.
    const partial = index.asyncPackage(DOMAIN, COORDINATOR, midLife);
    assert.deepEqual([partial?.status, partial?.observedFromReservation], ["OPEN", false]);
    assert.deepEqual(index.asyncPackage(DOMAIN, COORDINATOR, unreleased)?.violations, ["the package closed without a release"]);
  });
});

test("a pass follows an Arbitrum Sepolia coordinator without settlement contracts, and agreeing endpoints corroborate it", async () => {
  const hashOf = (height: number) => `0x${labelHash(`arb:${height}`)}`;
  const blocks = new Map<number, readonly (readonly [Draft, number, number])[]>([
    [1, [[transition("RESERVED", 1), 1, 0]]],
    [2, [[transition("REQUEST_SUBMITTED", 2), 2, 0], [transition("VENUE_PENDING", 3), 3, 4]]],
    [3, [[transition("EXECUTED", 4), 4, 0]]],
    [4, [[transition("CLOSED", 5), 5, 1], [released(1_000, 0), 5, 4]]],
  ]);
  const filters: { address: string[]; topics: string[][] }[] = [];
  const head = 4;
  const fetcher = async (_url: string, init: { body: string }) => {
    const { method, params, id } = JSON.parse(init.body);
    let result: unknown;
    if (method === "eth_chainId") result = quantity(421614);
    else if (method === "eth_blockNumber") result = quantity(head);
    else if (method === "eth_getBlockByNumber") {
      const tag = params[0] as string;
      const height = tag === "finalized" ? 3 : tag === "safe" ? 4 : Number.parseInt(tag.slice(2), 16);
      result = height > head ? null : { number: quantity(height), hash: hashOf(height), parentHash: height === 0 ? `0x${"00".repeat(32)}` : hashOf(height - 1) };
    } else if (method === "eth_getLogs") {
      const filter = params[0] as { blockHash: string; address: string[]; topics: string[][] };
      filters.push(filter);
      const height = [...Array(head + 1).keys()].find((candidate) => hashOf(candidate) === filter.blockHash) ?? -1;
      result = (blocks.get(height) ?? [])
        .map(([draft, tx, logIndex]) => asLog(draft, tx, logIndex, hashOf(height)))
        .filter((log) => filter.address.includes(log.address) && (filter.topics[0] as string[]).includes(log.topics[0] as string));
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
  const dir = mkdtempSync(join(tmpdir(), "naryx-coordinator-pass-"));
  const index = new SqliteReceiptIndex(join(dir, "index.sqlite"));
  try {
    const rpcs = [new EvmJsonRpc("https://arbitrum-sepolia.one.example", fetcher as never), new EvmJsonRpc("https://arbitrum-sepolia.two.example", fetcher as never)];
    const result = await runEvmIndexerPass(index, { domainId: DOMAIN, contracts: [], coordinators: [COORDINATOR], rpcs, startHeight: 0 });
    assert.deepEqual(result, { ingested: 5, reorgs: 0, tip: 4 });
    // With no settlement contracts the pass never sends an unfiltered log query.
    assert.ok(filters.every((filter) => filter.address.length === 1 && filter.address[0] === COORDINATOR));
    const observed = index.asyncPackage(DOMAIN, COORDINATOR, PACKAGE);
    assert.deepEqual([observed?.status, observed?.state, observed?.finality, observed?.evidenceGrade], ["RELEASED", "CLOSED", "CONFIRMED", "VENUE_API_CORROBORATED"]);
    assert.equal(observed?.release?.reserveAtoms, "1000");
  } finally {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
