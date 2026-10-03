import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { withArbitrumSepoliaExecutionHandoff } from "../src/arbitrum-sepolia-executor-client.js";
import {
  reconcileUnsettledArbitrumSepoliaOutcomes,
  SqliteArbitrumSepoliaOutcomeStore,
} from "../src/arbitrum-sepolia-outcome-store.js";
import type { EvmTestnetAsyncObservationDto } from "../src/evm-testnet-runtime-ports.js";
import { reconcilePendingEvmTestnetAtomicOutcomes } from "../src/evm-testnet-prepared-store.js";

const hash = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const ZERO = `0x${"0".repeat(64)}`;

function coordinator(outcomeEvidenceHash: string): EvmTestnetAsyncObservationDto["coordinator"] {
  return {
    state: "RESERVED", stateVersion: 2, requestKey: hash(3), outcomeEvidenceHash, recoveryEvidenceHash: ZERO,
    hasVenueOutcome: outcomeEvidenceHash !== ZERO, lastVenueOutcome: 0, recoveryDutyActive: false,
    recoveryActionSubmitted: false, recoveryProven: false, bondSlashed: false, evidenceConflict: false,
  };
}

function observed(
  attemptId: string,
  overrides: Partial<EvmTestnetAsyncObservationDto>,
): EvmTestnetAsyncObservationDto {
  return {
    attemptId, idempotencyKey: "idem-arb-outcome-0000", environment: "TESTNET", domainId: "eip155:421614",
    domainManifestVersion: 1, domainManifestHash: hash(1), chainReference: "421614", packageId: hash(2),
    lifecycle: "NOT_FOUND", evidenceGrade: "none", coordinator: null, entry: null, exit: null, finalReceipt: null,
    exitCompleted: false, reason: null,
    ...overrides,
  };
}

test("Arbitrum outcomes keep what each handoff proved across a restart and never change once settled", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-arbitrum-outcomes-"));
  const dbPath = join(scratch, "arbitrum-outcomes.db");
  const entryId = `arbitrum-async-${"a1".repeat(24)}`;
  const exitId = `arbitrum-async-${"b2".repeat(24)}`;
  const actions = new Map([[entryId, "ENTRY"], [exitId, "EXIT"]]);
  const stores = {
    intents: { getAttempt: (attemptId: string) => (actions.has(attemptId) ? { orderHash: attemptId } : undefined) },
    orders: { getCanonicalOrderByHash: (orderHash: string) => (actions.has(orderHash) ? { action: actions.get(orderHash) } : undefined) },
  } as unknown as ConstructorParameters<typeof SqliteArbitrumSepoliaOutcomeStore>[1];
  let scripted = observed(entryId, {});
  let transactions: { step: string; txHash: string; status: string }[] = [];
  const executor = {
    advance: async (attemptId: string) => ({
      attemptId, status: "IN_FLIGHT" as const, packageId: hash(2), coordinatorState: "RESERVED", requestKey: null, transactions,
    }),
  };
  const chain = { observe: async () => scripted, admit: async () => undefined };
  const entry = { attemptId: entryId, idempotencyKey: "idem-arb-outcome-0001" };
  const exit = { attemptId: exitId, idempotencyKey: "idem-arb-outcome-0002" };
  let store = new SqliteArbitrumSepoliaOutcomeStore(dbPath, stores);
  try {
    let handoff = withArbitrumSepoliaExecutionHandoff(chain, executor, store);
    await handoff.observe(entry);
    assert.equal(store.attemptOutcome(entryId), undefined);

    transactions = [
      { step: "RESERVE", txHash: hash(10), status: "CONFIRMED" },
      { step: "SUBMIT", txHash: hash(11), status: "CONFIRMED" },
      { step: "MARK_PENDING", txHash: hash(12), status: "SENT" },
    ];
    scripted = observed(entryId, { lifecycle: "REQUEST_SUBMITTED", evidenceGrade: "contract-state", coordinator: coordinator(ZERO) });
    await handoff.observe(entry);
    assert.deepEqual(store.attemptOutcome(entryId), {
      state: "REQUEST_SUBMITTED", transactionHash: hash(11), blockNumber: null, receiptHash: null,
    });
    assert.deepEqual(store.unsettled(10), [entry]);

    store.close();
    store = new SqliteArbitrumSepoliaOutcomeStore(dbPath, stores);
    handoff = withArbitrumSepoliaExecutionHandoff(chain, executor, store);
    // The sweep reads the chain alone and keeps the transaction the journal last confirmed.
    scripted = observed(entryId, { lifecycle: "EXECUTED", evidenceGrade: "authenticated-callback-record", coordinator: coordinator(hash(20)) });
    await reconcileUnsettledArbitrumSepoliaOutcomes(store, chain);
    scripted = observed(entryId, { lifecycle: "CLOSED", evidenceGrade: "contract-state", coordinator: coordinator(hash(21)) });
    await handoff.observe(entry);
    assert.deepEqual(store.attemptOutcome(entryId), {
      state: "EXECUTED", transactionHash: hash(11), blockNumber: null, receiptHash: hash(20),
    });
    assert.deepEqual(store.unsettled(10), []);

    // A closed entry records whether it opened the position or GMX cancelled it and the recovery refunded it.
    const entryRequest = (status: "EXECUTED" | "RECOVERED") => ({ status, evidenceHash: hash(24), positionSizeBefore: "0", positionSizeAfter: "0", revision: 2 });
    for (const [attemptId, status] of [[`arbitrum-async-${"c3".repeat(24)}`, "EXECUTED"], [`arbitrum-async-${"d4".repeat(24)}`, "RECOVERED"]] as const) {
      actions.set(attemptId, "ENTRY");
      scripted = observed(attemptId, { lifecycle: "CLOSED", evidenceGrade: "contract-state", coordinator: coordinator(hash(21)), entry: entryRequest(status) });
      await handoff.observe({ attemptId, idempotencyKey: "idem-arb-outcome-0003" });
      assert.equal(store.attemptOutcome(attemptId)?.state, status);
    }

    // An exit is observed on its entry package: the entry's coordinator state is not the exit's outcome.
    transactions = [{ step: "SUBMIT_EXIT", txHash: hash(13), status: "CONFIRMED" }];
    scripted = observed(exitId, { lifecycle: "EXECUTED", evidenceGrade: "authenticated-callback-record", coordinator: coordinator(hash(20)) });
    await handoff.observe(exit);
    assert.equal(store.attemptOutcome(exitId), undefined);
    scripted = observed(exitId, {
      lifecycle: "EXECUTED", evidenceGrade: "authenticated-callback-record", coordinator: coordinator(hash(20)),
      exit: { status: "PENDING", evidenceHash: ZERO, revision: 1, reconciling: false, released: false },
    });
    await handoff.observe(exit);
    assert.equal(store.attemptOutcome(exitId)?.state, "EXIT_PENDING");
    scripted = observed(exitId, {
      lifecycle: "CLOSED", evidenceGrade: "finalized-contract-receipt", coordinator: coordinator(hash(20)),
      exit: { status: "EXECUTED", evidenceHash: hash(22), revision: 2, reconciling: false, released: true },
      finalReceipt: {
        commitment: hash(23), packageId: hash(2), entryRequestKey: hash(3), exitRequestKey: hash(4), recipient: `0x${"33".repeat(20)}`,
        fullCloseSizeUsd: "1000", spotBaseAtoms: "500", spotQuoteAtoms: "600", perpStatus: 2, terminalState: 1,
      },
      exitCompleted: true,
    });
    await handoff.observe(exit);
    assert.deepEqual(store.attemptOutcome(exitId), {
      state: "CLOSED", transactionHash: hash(13), blockNumber: null, receiptHash: hash(23),
    });

    const raw = new Database(dbPath);
    try {
      assert.throws(
        () => raw.prepare("UPDATE arbitrum_attempt_outcomes SET state = 'RESERVED', settled = 0 WHERE attempt_id = ?").run(exitId),
        /never changes/,
      );
    } finally {
      raw.close();
    }
  } finally {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("background sweeps page through every unsettled attempt, so ones that keep failing cannot starve the rest", async () => {
  // 25 attempts whose observation always fails, sorted first because they are never observed.
  const ids = Array.from({ length: 30 }, (_, index) => `attempt-${String(index).padStart(16, "0")}`);
  const failing = new Set(ids.slice(0, 25));
  const visited = new Set<string>();
  const page = (limit: number, offset: number) => ids.slice(offset, offset + limit);
  const arbitrumStore = {
    unsettled: (limit: number, offset = 0) => page(limit, offset).map((attemptId) => ({ attemptId, idempotencyKey: attemptId })),
    record: () => undefined,
  };
  const arbitrumObservation = {
    observe: async (request: { attemptId: string }) => {
      visited.add(request.attemptId);
      if (failing.has(request.attemptId)) throw new Error("observation failed");
      return {} as never;
    },
  };
  const arbitrumCursor = { offset: 0 };
  for (let sweep = 0; sweep < 3; sweep += 1) {
    await reconcileUnsettledArbitrumSepoliaOutcomes(arbitrumStore as never, arbitrumObservation as never, 10, arbitrumCursor);
  }
  assert.equal(visited.size, 30);
  // The next sweep finds the end and starts over at once instead of idling for a minute.
  visited.clear();
  await reconcileUnsettledArbitrumSepoliaOutcomes(arbitrumStore as never, arbitrumObservation as never, 10, arbitrumCursor);
  assert.ok(visited.has(ids[0]!));

  visited.clear();
  const baseStore = {
    pendingObservations: (limit: number, offset = 0) =>
      page(limit, offset).map((attemptId) => ({ attemptId, idempotencyKey: attemptId, transactionHash: "0x" })),
  };
  const baseCursor = { offset: 0 };
  for (let sweep = 0; sweep < 3; sweep += 1) {
    await reconcilePendingEvmTestnetAtomicOutcomes(baseStore as never, arbitrumObservation as never, 10, baseCursor);
  }
  assert.equal(visited.size, 30);
});
