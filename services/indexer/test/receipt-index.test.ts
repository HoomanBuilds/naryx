import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { attemptOutcome, SqliteReceiptIndex, type ObservedBlock, type ObservedChainEvent } from "../src/index.js";

const SOL = "svm:solana-devnet";
const BASE = "evm:base-sepolia";
const hash = (label: string): string => {
  let value = 0n;
  for (const char of label) value = (value * 131n + BigInt(char.charCodeAt(0))) % (1n << 250n);
  return value.toString(16).padStart(64, "0");
};
const event = (locator: string, kind: ObservedChainEvent["kind"], attemptId = "a1", packageId = "pkg-1"): ObservedChainEvent => ({
  locator,
  packageId,
  attemptId,
  kind,
  evidenceGrade: "CONSENSUS_VERIFIED",
  fieldsHashHex: hash(`fields-${locator}-${kind}`),
});
const at = (height: number, label: string) => ({ height, blockHashHex: hash(label) });
const MAIN = ["g", "b1", "b2", "b3"];
const finality = (index: SqliteReceiptIndex, confirmed: number, finalized: number, labels = MAIN) =>
  index.advanceFinality(SOL, at(confirmed, labels[confirmed] ?? "missing"), at(finalized, labels[finalized] ?? "missing"));
const block = (height: number, label: string, parentLabel: string, events: readonly ObservedChainEvent[] = []): ObservedBlock => ({
  height,
  blockHashHex: hash(label),
  parentHashHex: hash(parentLabel),
  events,
});

function withIndex(run: (index: SqliteReceiptIndex, path: string, reopen: () => SqliteReceiptIndex) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "naryx-indexer-"));
  const path = join(dir, "index.sqlite");
  const opened: SqliteReceiptIndex[] = [];
  const open = () => {
    const index = new SqliteReceiptIndex(path);
    opened.push(index);
    return index;
  };
  try {
    run(open(), path, open);
  } finally {
    for (const index of opened) {
      try {
        index.close();
      } catch {
        // already closed
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function chain(index: SqliteReceiptIndex): void {
  index.ingestBlock(SOL, block(0, "g", "none"));
  index.ingestBlock(SOL, block(1, "b1", "g", [event("tx1:0", "SUBMITTED")]));
  index.ingestBlock(SOL, block(2, "b2", "b1"));
  index.ingestBlock(SOL, block(3, "b3", "b2", [event("tx3:0", "SETTLED")]));
}

test("a settlement is provisional until every contributing block is finalized", () => {
  withIndex((index) => {
    chain(index);
    let record = index.packageRecord("pkg-1");
    assert.deepEqual([record.outcome, record.finality], ["SETTLED", "OBSERVED"]);
    finality(index, 3, 1);
    record = index.packageRecord("pkg-1");
    assert.deepEqual(record.events.map((item) => item.finality), ["FINALIZED", "CONFIRMED"]);
    assert.equal(record.finality, "CONFIRMED");
    finality(index, 3, 3);
    assert.equal(index.packageRecord("pkg-1").finality, "FINALIZED");
    assert.equal(index.packageRecord("pkg-1").weakestEvidenceGrade, "CONSENSUS_VERIFIED");
  });
});

test("a reorg orphans displaced settlement evidence and a return to the old branch restores it", () => {
  withIndex((index) => {
    chain(index);
    assert.deepEqual(index.ingestBlock(SOL, block(3, "b3x", "b2")), { status: "REORGED", orphanedBlocks: 1 });
    assert.equal(index.packageRecord("pkg-1").outcome, "PENDING");
    assert.deepEqual(index.ingestBlock(SOL, block(3, "b3", "b2", [event("tx3:0", "SETTLED")])), { status: "REORGED", orphanedBlocks: 1 });
    assert.equal(index.packageRecord("pkg-1").outcome, "SETTLED");
    assert.deepEqual(index.ingestBlock(SOL, block(2, "b2y", "b1")), { status: "REORGED", orphanedBlocks: 2 });
    assert.equal(index.domainState(SOL)?.tipHeight, 2);
    assert.equal(index.domainState(SOL)?.reorgCount, 3);
    assert.throws(() => index.ingestBlock(SOL, block(4, "b4", "b3")), { code: "PARENT_UNKNOWN" });
  });
});

test("finality names a block hash, so a fork block the index still holds is never finalized", () => {
  withIndex((index) => {
    index.ingestBlock(SOL, block(0, "g", "none"));
    index.ingestBlock(SOL, block(1, "b1", "g"));
    index.ingestBlock(SOL, block(2, "fork2", "b1", [event("txf:0", "SETTLED")]));
    // The chain finalized its real block 2 before the index replayed the reorg away from the fork.
    assert.throws(() => index.advanceFinality(SOL, at(2, "b2"), at(2, "b2")), { code: "FORK_MISMATCH" });
    assert.equal(index.packageRecord("pkg-1").finality, "OBSERVED");
    assert.deepEqual(index.ingestBlock(SOL, block(2, "b2", "b1")), { status: "REORGED", orphanedBlocks: 1 });
    index.advanceFinality(SOL, at(2, "b2"), at(2, "b2"));
    // The abandoned settlement is gone rather than final.
    assert.equal(index.packageRecord("pkg-1").outcome, "UNKNOWN");
  });
});

test("finalized history is never rewritten and finality never moves backward", () => {
  withIndex((index) => {
    chain(index);
    finality(index, 3, 2);
    assert.throws(() => index.ingestBlock(SOL, block(2, "b2z", "b1")), { code: "FINALIZED_CONFLICT" });
    assert.equal(index.packageRecord("pkg-1").outcome, "SETTLED");
    assert.throws(() => finality(index, 3, 1), { code: "FINALITY_REGRESSION" });
    assert.throws(() => finality(index, 9, 3), { code: "UNKNOWN_BLOCK" });
    assert.throws(() => finality(index, 2, 3), { code: "INVALID_INPUT" });
    assert.deepEqual(index.ingestBlock(SOL, block(3, "b3y", "b2")), { status: "REORGED", orphanedBlocks: 1 });
  });
});

test("a repeated block is idempotent and a changed block under a known hash is refused", () => {
  withIndex((index) => {
    chain(index);
    assert.deepEqual(index.ingestBlock(SOL, block(3, "b3", "b2", [event("tx3:0", "SETTLED")])), { status: "DUPLICATE" });
    assert.throws(() => index.ingestBlock(SOL, block(3, "b3", "b2", [event("tx3:0", "REVERTED")])), { code: "BLOCK_CONFLICT" });
    assert.throws(() => index.ingestBlock(SOL, block(4, "b4", "b3", [event("tx:0", "SUBMITTED"), event("tx:0", "SETTLED")])), { code: "INVALID_INPUT" });
  });
});

test("failed attempts are indexed and reported, not only successful ones", () => {
  withIndex((index) => {
    index.ingestBlock(SOL, block(0, "g", "none", [event("tx0:0", "SUBMITTED", "a1"), event("tx0:1", "REVERTED", "a1")]));
    let record = index.packageRecord("pkg-1");
    assert.equal(record.outcome, "FAILED_NO_EFFECT");
    index.ingestBlock(SOL, block(1, "b1", "g", [event("tx1:0", "SUBMITTED", "a2"), event("tx1:1", "SETTLED", "a2")]));
    record = index.packageRecord("pkg-1");
    assert.equal(record.outcome, "SETTLED");
    assert.deepEqual(record.attempts.map((attempt) => [attempt.attemptId, attempt.outcome]), [["a1", "FAILED_NO_EFFECT"], ["a2", "SETTLED"]]);
    index.ingestBlock(SOL, block(2, "b2", "b1", [event("tx2:0", "EXPIRED_NO_EFFECT", "a1", "pkg-2")]));
    assert.equal(index.packageRecord("pkg-2").outcome, "FAILED_NO_EFFECT");
    assert.equal(index.packageRecord("pkg-unknown").outcome, "UNKNOWN");
  });
});

test("a settled leg beside a failed leg is partial exposure until recovery resolves it", () => {
  withIndex((index) => {
    index.ingestBlock(SOL, block(0, "s0", "none", [event("s:0", "SETTLED")]));
    index.ingestBlock(BASE, block(0, "e0", "none", [event("e:0", "REVERTED")]));
    assert.equal(index.packageRecord("pkg-1").outcome, "PARTIAL_EXPOSURE");
    index.ingestBlock(BASE, block(1, "e1", "e0", [event("e:1", "RECOVERY_STARTED")]));
    assert.equal(index.packageRecord("pkg-1").outcome, "IN_RECOVERY");
    index.ingestBlock(BASE, block(2, "e2", "e1", [event("e:2", "RECOVERED")]));
    assert.equal(index.packageRecord("pkg-1").outcome, "RECOVERED");
  });
});

test("double execution and contradictory terminal evidence are surfaced, never resolved", () => {
  withIndex((index) => {
    index.ingestBlock(SOL, block(0, "g", "none", [event("t:0", "SETTLED", "a1"), event("t:1", "SETTLED", "a2")]));
    assert.equal(index.packageRecord("pkg-1").outcome, "CONFLICTING_EVIDENCE");
  });
  assert.equal(attemptOutcome([{ domainId: SOL, kind: "SETTLED" }, { domainId: SOL, kind: "REVERTED" }]), "CONFLICTING_EVIDENCE");
  assert.equal(attemptOutcome([{ domainId: SOL, kind: "SETTLED" }, { domainId: BASE, kind: "SUBMITTED" }]), "PENDING");
});

test("venue fills are committed on arrival, deduplicated, and never silently replaced", () => {
  withIndex((index) => {
    const fill = { fillId: "hl-fill-1", sequence: 77, packageId: "pkg-1", attemptId: "a1", fieldsHashHex: hash("fill") };
    assert.equal(index.ingestVenueFill("hyperliquid:testnet", fill), "APPENDED");
    assert.equal(index.ingestVenueFill("hyperliquid:testnet", fill), "DUPLICATE");
    assert.throws(() => index.ingestVenueFill("hyperliquid:testnet", { ...fill, fieldsHashHex: hash("other") }), { code: "FILL_CONFLICT" });
    index.ingestBlock(SOL, block(0, "g", "none", [event("t:0", "SETTLED")]));
    const record = index.packageRecord("pkg-1");
    assert.equal(record.events.find((item) => item.kind === "VENUE_FILL")?.finality, "FINALIZED");
    assert.equal(record.weakestEvidenceGrade, "VENUE_API_CORROBORATED");
  });
});

test("the record rebuilds identically from the canonical chain after the index is deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-indexer-rebuild-"));
  try {
    const first = new SqliteReceiptIndex(join(dir, "first.sqlite"));
    chain(first);
    first.ingestBlock(SOL, block(3, "b3x", "b2"));
    first.ingestBlock(SOL, block(3, "b3", "b2", [event("tx3:0", "SETTLED")]));
    finality(first, 3, 3);
    const original = first.packageRecord("pkg-1").recordHashHex;
    first.close();
    rmSync(join(dir, "first.sqlite"));
    const rebuilt = new SqliteReceiptIndex(join(dir, "second.sqlite"));
    chain(rebuilt);
    finality(rebuilt, 3, 3);
    assert.equal(rebuilt.packageRecord("pkg-1").recordHashHex, original);
    rebuilt.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexed evidence is append-only and the index path must be absolute", () => {
  withIndex((index, path) => {
    chain(index);
    index.close();
    const raw = new Database(path);
    try {
      assert.throws(() => raw.prepare("DELETE FROM chain_events").run(), /append-only/);
      assert.throws(() => raw.prepare("UPDATE chain_events SET kind = 'REVERTED'").run(), /append-only/);
    } finally {
      raw.close();
    }
  });
  assert.throws(() => new SqliteReceiptIndex("relative.sqlite"), { code: "INVALID_INPUT" });
});
