import type Database from "better-sqlite3";
import type { ArbitrumSepoliaObservationRecorder } from "./arbitrum-sepolia-executor-client.js";
import { openDurableDatabase } from "./durable-sqlite.js";
import type {
  EvmTestnetAsyncObservationDto,
  EvmTestnetAsyncObservationPort,
  EvmTestnetObserveAsyncRequest,
} from "./evm-testnet-runtime-ports.js";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import type { OwnerPackageOutcome } from "./terminal-packages.js";
import type { SweepCursor } from "./evm-testnet-prepared-store.js";

const ATTEMPT_ID = /^arbitrum-async-[0-9a-f]{48}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const STATE = /^[A-Z_]{1,40}$/;
const ZERO_HASH = `0x${"0".repeat(64)}`;
/** Outcomes after which the chain state of the attempt no longer changes, so the sweep stops observing it. */
const SETTLED: Readonly<Record<"ENTRY" | "EXIT", ReadonlySet<string>>> = {
  ENTRY: new Set(["EXECUTED", "CANCELLED", "RECOVERED", "CLOSED"]),
  EXIT: new Set(["CLOSED", "EXIT_CANCELLED", "EXIT_RECOVERED"]),
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS arbitrum_attempt_outcomes (
  attempt_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('ENTRY', 'EXIT')),
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  settled INTEGER NOT NULL CHECK (settled IN (0, 1)),
  transaction_hash TEXT,
  receipt_hash TEXT,
  observed_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS reject_arbitrum_outcome_delete BEFORE DELETE ON arbitrum_attempt_outcomes
BEGIN SELECT RAISE(ABORT, 'Arbitrum attempt outcomes are durable'); END;
CREATE TRIGGER IF NOT EXISTS reject_arbitrum_outcome_rewrite BEFORE UPDATE ON arbitrum_attempt_outcomes
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.action IS NOT OLD.action OR OLD.settled = 1
BEGIN SELECT RAISE(ABORT, 'a settled Arbitrum attempt outcome never changes'); END;
`;

type Row = Readonly<{
  attempt_id: unknown;
  action: unknown;
  idempotency_key: unknown;
  state: unknown;
  settled: unknown;
  transaction_hash: unknown;
  receipt_hash: unknown;
}>;

type StoredOutcome = Readonly<{
  attemptId: string;
  action: "ENTRY" | "EXIT";
  idempotencyKey: string;
  state: string;
  settled: boolean;
  transactionHash: string | null;
  receiptHash: string | null;
}>;

export class ArbitrumSepoliaOutcomeStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArbitrumSepoliaOutcomeStoreError";
    this.code = code;
  }
}

function nonzero(hash: string | null | undefined): string | null {
  return hash === null || hash === undefined || hash === ZERO_HASH ? null : hash;
}

/**
 * The attempt's state as the chain proved it. An entry reads the coordinator; an exit is observed on
 * its entry package, so it has a state only once the exit controller knows its request. Not found
 * and evidence mismatch prove nothing about the attempt and record nothing.
 */
function outcomeOf(
  action: "ENTRY" | "EXIT",
  observation: EvmTestnetAsyncObservationDto,
): Readonly<{ state: string; receiptHash: string | null }> | undefined {
  if (observation.lifecycle === "NOT_FOUND" || observation.lifecycle === "EVIDENCE_MISMATCH") return undefined;
  if (action === "EXIT") {
    if (observation.exit === null) return undefined;
    return {
      state: observation.exitCompleted ? "CLOSED" : `EXIT_${observation.exit.status}`,
      receiptHash: observation.finalReceipt?.commitment ?? nonzero(observation.exit.evidenceHash),
    };
  }
  return {
    state: observation.lifecycle,
    receiptHash: nonzero(observation.coordinator?.outcomeEvidenceHash) ?? nonzero(observation.entry?.evidenceHash),
  };
}

function decode(row: Row): StoredOutcome {
  const { attempt_id, action, idempotency_key, state, settled, transaction_hash, receipt_hash } = row;
  if (typeof attempt_id !== "string" || !ATTEMPT_ID.test(attempt_id)
    || (action !== "ENTRY" && action !== "EXIT")
    || typeof idempotency_key !== "string" || !ID_PATTERN.test(idempotency_key)
    || typeof state !== "string" || !STATE.test(state)
    || (settled !== 0 && settled !== 1) || (settled === 1) !== SETTLED[action].has(state)
    || (transaction_hash !== null && (typeof transaction_hash !== "string" || !HASH.test(transaction_hash)))
    || (receipt_hash !== null && (typeof receipt_hash !== "string" || !HASH.test(receipt_hash)))) {
    throw new ArbitrumSepoliaOutcomeStoreError("CORRUPT_ROW", "Stored Arbitrum attempt outcome failed revalidation.");
  }
  return Object.freeze({
    attemptId: attempt_id,
    action,
    idempotencyKey: idempotency_key,
    state,
    settled: settled === 1,
    transactionHash: transaction_hash,
    receiptHash: receipt_hash,
  });
}

/**
 * Durable Arbitrum Sepolia attempt outcomes: the latest state each observe-async handoff proved on
 * chain, the receipt reference it carried, and the transaction the solver's journal last confirmed
 * for the attempt. A settled outcome never changes, so a package's result survives a reload, another
 * device, and a restart.
 */
export class SqliteArbitrumSepoliaOutcomeStore implements ArbitrumSepoliaObservationRecorder {
  readonly #db: Database.Database;
  readonly #intents: Pick<ExecutionIntentStore, "getAttempt">;
  readonly #orders: Pick<InternalOrderStore, "getCanonicalOrderByHash">;
  readonly #clock: () => number;
  readonly #select: Database.Statement;
  readonly #upsert: Database.Statement;
  readonly #unsettled: Database.Statement;

  constructor(
    dbPath: string,
    stores: Readonly<{
      intents: Pick<ExecutionIntentStore, "getAttempt">;
      orders: Pick<InternalOrderStore, "getCanonicalOrderByHash">;
    }>,
    clock: () => number = Date.now,
  ) {
    this.#db = openDurableDatabase(
      dbPath,
      SCHEMA_SQL,
      (code, message) => new ArbitrumSepoliaOutcomeStoreError(code, message),
    );
    this.#intents = stores.intents;
    this.#orders = stores.orders;
    this.#clock = clock;
    this.#select = this.#db.prepare("SELECT * FROM arbitrum_attempt_outcomes WHERE attempt_id = ?");
    this.#upsert = this.#db.prepare(`
      INSERT INTO arbitrum_attempt_outcomes
        (attempt_id, action, idempotency_key, state, settled, transaction_hash, receipt_hash, observed_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (attempt_id) DO UPDATE SET
        idempotency_key = excluded.idempotency_key, state = excluded.state, settled = excluded.settled,
        transaction_hash = excluded.transaction_hash, receipt_hash = excluded.receipt_hash,
        observed_at_ms = excluded.observed_at_ms
    `);
    this.#unsettled = this.#db.prepare(
      "SELECT * FROM arbitrum_attempt_outcomes WHERE settled = 0 ORDER BY observed_at_ms, rowid LIMIT ? OFFSET ?",
    );
  }

  record(
    request: EvmTestnetObserveAsyncRequest,
    observation: EvmTestnetAsyncObservationDto,
    transactionHash: string | null,
  ): void {
    const { attemptId, idempotencyKey } = request;
    if (!ATTEMPT_ID.test(attemptId) || !ID_PATTERN.test(idempotencyKey) || observation.attemptId !== attemptId
      || (transactionHash !== null && !HASH.test(transactionHash))) {
      throw new ArbitrumSepoliaOutcomeStoreError("INVALID_OUTCOME", "Arbitrum attempt outcome is malformed.");
    }
    this.#db.transaction(() => {
      const row = this.#select.get(attemptId) as Row | undefined;
      const existing = row === undefined ? undefined : decode(row);
      if (existing?.settled === true) return;
      const action = existing?.action ?? this.#actionOf(attemptId);
      if (action === undefined) return;
      const outcome = outcomeOf(action, observation);
      if (outcome === undefined || !STATE.test(outcome.state)) return;
      this.#upsert.run(
        attemptId,
        action,
        idempotencyKey,
        outcome.state,
        SETTLED[action].has(outcome.state) ? 1 : 0,
        transactionHash ?? existing?.transactionHash ?? null,
        outcome.receiptHash ?? existing?.receiptHash ?? null,
        this.#clock(),
      );
    }).immediate();
  }

  /** The attempt's outcome for its owner's package list; undefined while the chain proved nothing about it. */
  attemptOutcome(attemptId: string): OwnerPackageOutcome | undefined {
    const row = this.#select.get(attemptId) as Row | undefined;
    if (row === undefined) return undefined;
    const outcome = decode(row);
    return Object.freeze({
      state: outcome.state,
      transactionHash: outcome.transactionHash,
      blockNumber: null,
      receiptHash: outcome.receiptHash,
    });
  }

  /** Observed attempts whose chain state can still move, least recently observed first. */
  unsettled(limit: number, offset = 0): readonly EvmTestnetObserveAsyncRequest[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Unsettled outcome limit must be 1 to 100.");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Unsettled outcome offset must be a non-negative integer.");
    return Object.freeze((this.#unsettled.all(limit, offset) as Row[]).map((row) => {
      const outcome = decode(row);
      return Object.freeze({ attemptId: outcome.attemptId, idempotencyKey: outcome.idempotencyKey });
    }));
  }

  close(): void {
    this.#db.close();
  }

  #actionOf(attemptId: string): "ENTRY" | "EXIT" | undefined {
    const attempt = this.#intents.getAttempt(attemptId);
    const action = attempt === undefined ? undefined : this.#orders.getCanonicalOrderByHash(attempt.orderHash)?.action;
    return action === "ENTRY" || action === "EXIT" ? action : undefined;
  }
}

/**
 * Reads the chain state of observed Arbitrum attempts that have not settled, one at a time, through
 * the signerless observation alone: it never advances the solver, so an attempt still progresses
 * only through its owner's gated handoff.
 */
export async function reconcileUnsettledArbitrumSepoliaOutcomes(
  store: Pick<SqliteArbitrumSepoliaOutcomeStore, "unsettled" | "record">,
  observation: EvmTestnetAsyncObservationPort,
  limit = 10,
  cursor: SweepCursor = { offset: 0 },
): Promise<void> {
  // Pages through every unsettled attempt across sweeps, so failing ones cannot starve the rest.
  let page = store.unsettled(limit, cursor.offset);
  if (page.length === 0 && cursor.offset > 0) {
    cursor.offset = 0;
    page = store.unsettled(limit, 0);
  }
  cursor.offset = page.length < limit ? 0 : cursor.offset + limit;
  for (const request of page) {
    try {
      store.record(request, await observation.observe(request), null);
    } catch {
      // A failed observation records nothing; the next sweep retries it.
    }
  }
}
