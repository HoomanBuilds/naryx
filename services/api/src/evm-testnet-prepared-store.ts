import type Database from "better-sqlite3";
import { openDurableDatabase } from "./durable-sqlite.js";
import {
  InMemoryPreparedEvmTestnetAtomicStore,
  validateEvmTestnetAtomicPreparation,
  type EvmTestnetAtomicObservationPort,
  type EvmTestnetAtomicOutcome,
  type EvmTestnetAtomicOutcomeState,
  type EvmTestnetAtomicPreparationDto,
  type PreparedEvmTestnetAtomicRecord,
  type PreparedEvmTestnetAtomicStore,
} from "./evm-testnet-runtime-ports.js";
import type { OwnerPackageOutcome } from "./terminal-packages.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const BLOCK_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const OUTCOME_STATES: readonly string[] = ["PENDING", "EXPIRED", "REVERTED", "FINALIZED"];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS evm_prepared_atomic_attempts (
  idempotency_key TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  trader_signature TEXT NOT NULL,
  preparation_json TEXT NOT NULL,
  bound_transaction_hash TEXT
) STRICT;
CREATE TRIGGER IF NOT EXISTS reject_evm_prepared_atomic_delete BEFORE DELETE ON evm_prepared_atomic_attempts
BEGIN SELECT RAISE(ABORT, 'prepared EVM attempts are durable'); END;
CREATE TRIGGER IF NOT EXISTS reject_evm_prepared_atomic_rewrite BEFORE UPDATE ON evm_prepared_atomic_attempts
WHEN NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.trader_signature IS NOT OLD.trader_signature
  OR NEW.preparation_json IS NOT OLD.preparation_json
  OR OLD.bound_transaction_hash IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'prepared EVM attempts bind a transaction once'); END;
CREATE TABLE IF NOT EXISTS evm_atomic_attempt_outcomes (
  idempotency_key TEXT PRIMARY KEY REFERENCES evm_prepared_atomic_attempts(idempotency_key),
  attempt_id TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'EXPIRED', 'REVERTED', 'FINALIZED')),
  block_number TEXT,
  receipt_hash TEXT,
  observed_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_evm_atomic_outcomes_attempt ON evm_atomic_attempt_outcomes (attempt_id);
CREATE TRIGGER IF NOT EXISTS reject_evm_atomic_outcome_unbound BEFORE INSERT ON evm_atomic_attempt_outcomes
WHEN NOT EXISTS (
  SELECT 1 FROM evm_prepared_atomic_attempts
  WHERE idempotency_key = NEW.idempotency_key AND attempt_id = NEW.attempt_id
    AND bound_transaction_hash = NEW.transaction_hash
)
BEGIN SELECT RAISE(ABORT, 'EVM attempt outcomes record only the bound transaction'); END;
CREATE TRIGGER IF NOT EXISTS reject_evm_atomic_outcome_delete BEFORE DELETE ON evm_atomic_attempt_outcomes
BEGIN SELECT RAISE(ABORT, 'EVM attempt outcomes are durable'); END;
CREATE TRIGGER IF NOT EXISTS reject_evm_atomic_outcome_rewrite BEFORE UPDATE ON evm_atomic_attempt_outcomes
WHEN NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.transaction_hash IS NOT OLD.transaction_hash
  OR OLD.state IN ('REVERTED', 'FINALIZED')
  OR (OLD.state = 'EXPIRED' AND NEW.state NOT IN ('REVERTED', 'FINALIZED'))
BEGIN SELECT RAISE(ABORT, 'a settled EVM attempt outcome never changes'); END;
`;

type Row = Readonly<{
  idempotency_key: unknown;
  attempt_id: unknown;
  trader_signature: unknown;
  preparation_json: unknown;
  bound_transaction_hash: unknown;
}>;

type OutcomeRow = Readonly<{
  idempotency_key: unknown;
  attempt_id: unknown;
  transaction_hash: unknown;
  state: unknown;
  block_number: unknown;
  receipt_hash: unknown;
}>;

/** A bound transaction the sweep observes again: no outcome recorded yet, or still PENDING. */
export type PendingEvmTestnetAtomicObservation = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  transactionHash: string;
}>;

export class PreparedEvmTestnetAtomicStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PreparedEvmTestnetAtomicStoreError";
    this.code = code;
  }
}

function sameRecord(left: PreparedEvmTestnetAtomicRecord, right: PreparedEvmTestnetAtomicRecord): boolean {
  return left.attemptId === right.attemptId
    && left.idempotencyKey === right.idempotencyKey
    && left.traderSignature === right.traderSignature
    && JSON.stringify(left.preparation) === JSON.stringify(right.preparation);
}

function decode(row: Row): PreparedEvmTestnetAtomicRecord {
  try {
    if (typeof row.idempotency_key !== "string" || typeof row.attempt_id !== "string"
      || typeof row.trader_signature !== "string" || typeof row.preparation_json !== "string"
      || (row.bound_transaction_hash !== null && typeof row.bound_transaction_hash !== "string")) {
      throw new Error("malformed row");
    }
    const request = {
      attemptId: row.attempt_id,
      idempotencyKey: row.idempotency_key,
      traderSignature: row.trader_signature,
    };
    const preparation = validateEvmTestnetAtomicPreparation(JSON.parse(row.preparation_json) as unknown, request);
    const validator = new InMemoryPreparedEvmTestnetAtomicStore();
    const record = validator.save(request.attemptId, request.idempotencyKey, request.traderSignature, preparation);
    if (record.traderSignature !== row.trader_signature
      || JSON.stringify(record.preparation) !== row.preparation_json) {
      throw new Error("non-canonical row");
    }
    return row.bound_transaction_hash === null
      ? record
      : validator.bindTransactionHash(request.idempotencyKey, row.bound_transaction_hash);
  } catch {
    throw new PreparedEvmTestnetAtomicStoreError("CORRUPT_ROW", "Stored EVM prepared attempt failed revalidation.");
  }
}

function validOutcome(outcome: EvmTestnetAtomicOutcome): boolean {
  const { state, blockNumber, receiptHash } = outcome;
  return typeof outcome.attemptId === "string" && ID_PATTERN.test(outcome.attemptId)
    && typeof outcome.idempotencyKey === "string" && ID_PATTERN.test(outcome.idempotencyKey)
    && typeof outcome.transactionHash === "string" && HASH_PATTERN.test(outcome.transactionHash)
    && OUTCOME_STATES.includes(state)
    && (blockNumber === null || (typeof blockNumber === "string" && BLOCK_PATTERN.test(blockNumber)))
    && (receiptHash === null || (typeof receiptHash === "string" && HASH_PATTERN.test(receiptHash)))
    && (state !== "FINALIZED" || (blockNumber !== null && receiptHash !== null))
    && (state !== "REVERTED" || (blockNumber !== null && receiptHash === null))
    && (state !== "EXPIRED" || (blockNumber === null && receiptHash === null));
}

function decodeOutcome(row: OutcomeRow): EvmTestnetAtomicOutcome {
  const outcome = {
    attemptId: row.attempt_id,
    idempotencyKey: row.idempotency_key,
    transactionHash: row.transaction_hash,
    state: row.state,
    blockNumber: row.block_number,
    receiptHash: row.receipt_hash,
  } as EvmTestnetAtomicOutcome;
  if (!validOutcome(outcome)) {
    throw new PreparedEvmTestnetAtomicStoreError("CORRUPT_ROW", "Stored EVM attempt outcome failed revalidation.");
  }
  return Object.freeze(outcome);
}

/** Whether a new observation replaces the recorded one: a receipt outranks its absence, and a receipt is never replaced. */
function supersedes(recorded: EvmTestnetAtomicOutcomeState, next: EvmTestnetAtomicOutcomeState): boolean {
  if (recorded === "PENDING") return true;
  return recorded === "EXPIRED" && (next === "REVERTED" || next === "FINALIZED");
}

/**
 * Durable prepared Base Sepolia attempts keyed by idempotency key. Each row is revalidated against
 * its request commitment on read, an idempotency key binds one attempt, trader signature, and
 * preparation forever, and a broadcast transaction hash binds once, so observation and replay
 * survive a restart and a conflicting reuse fails closed. Beside each bound transaction it keeps
 * what the latest observation proved about it, so a package's outcome survives a reload and a restart.
 */
export class SqlitePreparedEvmTestnetAtomicStore implements PreparedEvmTestnetAtomicStore {
  readonly #db: Database.Database;
  readonly #clock: () => number;
  readonly #select: Database.Statement;
  readonly #insert: Database.Statement;
  readonly #bind: Database.Statement;
  readonly #selectOutcome: Database.Statement;
  readonly #upsertOutcome: Database.Statement;
  readonly #attemptOutcome: Database.Statement;
  readonly #pending: Database.Statement;

  constructor(dbPath: string, clock: () => number = Date.now) {
    this.#db = openDurableDatabase(
      dbPath,
      SCHEMA_SQL,
      (code, message) => new PreparedEvmTestnetAtomicStoreError(code, message),
    );
    this.#clock = clock;
    this.#select = this.#db.prepare("SELECT * FROM evm_prepared_atomic_attempts WHERE idempotency_key = ?");
    this.#insert = this.#db.prepare(
      "INSERT INTO evm_prepared_atomic_attempts (idempotency_key, attempt_id, trader_signature, preparation_json, bound_transaction_hash) VALUES (?, ?, ?, ?, NULL)",
    );
    this.#bind = this.#db.prepare(
      "UPDATE evm_prepared_atomic_attempts SET bound_transaction_hash = ? WHERE idempotency_key = ? AND bound_transaction_hash IS NULL",
    );
    this.#selectOutcome = this.#db.prepare("SELECT * FROM evm_atomic_attempt_outcomes WHERE idempotency_key = ?");
    this.#upsertOutcome = this.#db.prepare(`
      INSERT INTO evm_atomic_attempt_outcomes
        (idempotency_key, attempt_id, transaction_hash, state, block_number, receipt_hash, observed_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (idempotency_key) DO UPDATE SET
        state = excluded.state, block_number = excluded.block_number,
        receipt_hash = excluded.receipt_hash, observed_at_ms = excluded.observed_at_ms
    `);
    // A finalized transaction is the attempt's outcome; otherwise its latest observed transaction is.
    this.#attemptOutcome = this.#db.prepare(`
      SELECT * FROM evm_atomic_attempt_outcomes WHERE attempt_id = ?
      ORDER BY state = 'FINALIZED' DESC, observed_at_ms DESC, rowid DESC LIMIT 1
    `);
    this.#pending = this.#db.prepare(`
      SELECT p.idempotency_key, p.attempt_id, p.bound_transaction_hash
      FROM evm_prepared_atomic_attempts p
      LEFT JOIN evm_atomic_attempt_outcomes o ON o.idempotency_key = p.idempotency_key
      WHERE p.bound_transaction_hash IS NOT NULL AND (o.state IS NULL OR o.state = 'PENDING')
      ORDER BY COALESCE(o.observed_at_ms, 0), p.rowid LIMIT ? OFFSET ?
    `);
  }

  get(idempotencyKey: string): PreparedEvmTestnetAtomicRecord | undefined {
    if (typeof idempotencyKey !== "string" || !ID_PATTERN.test(idempotencyKey)) {
      throw new Error("Idempotency key must use 16 to 64 URL-safe characters.");
    }
    const row = this.#select.get(idempotencyKey) as Row | undefined;
    if (row === undefined) return undefined;
    const record = decode(row);
    if (record.idempotencyKey !== idempotencyKey) {
      throw new PreparedEvmTestnetAtomicStoreError("CORRUPT_ROW", "Stored EVM prepared attempt key binding is corrupt.");
    }
    return record;
  }

  save(
    attemptId: string,
    idempotencyKey: string,
    traderSignature: string,
    preparation: EvmTestnetAtomicPreparationDto,
  ): PreparedEvmTestnetAtomicRecord {
    const candidate = new InMemoryPreparedEvmTestnetAtomicStore().save(
      attemptId,
      idempotencyKey,
      traderSignature,
      validateEvmTestnetAtomicPreparation(preparation, { attemptId, idempotencyKey, traderSignature }),
    );
    return this.#db.transaction(() => {
      const existing = this.get(idempotencyKey);
      if (existing !== undefined) {
        if (!sameRecord(existing, candidate)) {
          throw new PreparedEvmTestnetAtomicStoreError(
            "IDEMPOTENCY_CONFLICT",
            `Idempotency key "${idempotencyKey}" was already used with different attempt fields.`,
          );
        }
        return existing;
      }
      this.#insert.run(
        candidate.idempotencyKey,
        candidate.attemptId,
        candidate.traderSignature,
        JSON.stringify(candidate.preparation),
      );
      return candidate;
    }).immediate();
  }

  bindTransactionHash(idempotencyKey: string, transactionHash: string): PreparedEvmTestnetAtomicRecord {
    return this.#db.transaction(() => {
      const existing = this.get(idempotencyKey);
      if (existing === undefined) {
        throw new PreparedEvmTestnetAtomicStoreError("UNKNOWN_IDEMPOTENCY_KEY", `Unknown idempotency key "${idempotencyKey}".`);
      }
      const validator = new InMemoryPreparedEvmTestnetAtomicStore();
      validator.save(existing.attemptId, existing.idempotencyKey, existing.traderSignature, existing.preparation);
      const bound = validator.bindTransactionHash(idempotencyKey, transactionHash);
      if (existing.boundTransactionHash !== undefined) {
        if (existing.boundTransactionHash !== bound.boundTransactionHash) {
          throw new PreparedEvmTestnetAtomicStoreError(
            "TRANSACTION_CONFLICT",
            `Idempotency key "${idempotencyKey}" is already bound to a different transaction.`,
          );
        }
        return existing;
      }
      if (this.#bind.run(bound.boundTransactionHash, idempotencyKey).changes !== 1) {
        throw new PreparedEvmTestnetAtomicStoreError("TRANSACTION_CONFLICT", "Prepared EVM attempt transaction binding raced.");
      }
      return bound;
    }).immediate();
  }

  recordOutcome(outcome: EvmTestnetAtomicOutcome): void {
    if (!validOutcome(outcome)) {
      throw new PreparedEvmTestnetAtomicStoreError("INVALID_OUTCOME", "EVM attempt outcome is malformed.");
    }
    this.#db.transaction(() => {
      const prepared = this.get(outcome.idempotencyKey);
      if (prepared === undefined || prepared.attemptId !== outcome.attemptId
        || prepared.boundTransactionHash !== outcome.transactionHash) {
        throw new PreparedEvmTestnetAtomicStoreError("OUTCOME_UNBOUND", "EVM attempt outcome is not for the bound transaction.");
      }
      const row = this.#selectOutcome.get(outcome.idempotencyKey) as OutcomeRow | undefined;
      if (row !== undefined && !supersedes(decodeOutcome(row).state, outcome.state)) return;
      this.#upsertOutcome.run(
        outcome.idempotencyKey,
        outcome.attemptId,
        outcome.transactionHash,
        outcome.state,
        outcome.blockNumber,
        outcome.receiptHash,
        this.#clock(),
      );
    }).immediate();
  }

  /** The attempt's outcome for its owner's package list; undefined while none of its transactions was observed. */
  attemptOutcome(attemptId: string): OwnerPackageOutcome | undefined {
    const row = this.#attemptOutcome.get(attemptId) as OutcomeRow | undefined;
    if (row === undefined) return undefined;
    const outcome = decodeOutcome(row);
    return Object.freeze({
      state: outcome.state,
      transactionHash: outcome.transactionHash,
      blockNumber: outcome.blockNumber,
      receiptHash: outcome.receiptHash,
    });
  }

  /** Bound transactions without a settled outcome, least recently observed first. */
  pendingObservations(limit: number, offset = 0): readonly PendingEvmTestnetAtomicObservation[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Pending observation limit must be 1 to 100.");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Pending observation offset must be a non-negative integer.");
    const rows = this.#pending.all(limit, offset) as { idempotency_key: string; attempt_id: string; bound_transaction_hash: string }[];
    return Object.freeze(rows.map((row) => Object.freeze({
      attemptId: row.attempt_id,
      idempotencyKey: row.idempotency_key,
      transactionHash: row.bound_transaction_hash,
    })));
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Observes bound Base transactions without a settled outcome again, one at a time, so a package
 * finalizes, reverts, or expires in its owner's list after the browser that sent it is gone.
 */
/** Where a background sweep resumes; it wraps to the start after a short page. */
export type SweepCursor = { offset: number };

export async function reconcilePendingEvmTestnetAtomicOutcomes(
  store: Pick<SqlitePreparedEvmTestnetAtomicStore, "pendingObservations">,
  observation: EvmTestnetAtomicObservationPort,
  limit = 10,
  cursor: SweepCursor = { offset: 0 },
): Promise<void> {
  // Pages through every pending attempt across sweeps, so attempts whose observation keeps
  // failing (they stay least recently observed) cannot starve the rest.
  let page = store.pendingObservations(limit, cursor.offset);
  if (page.length === 0 && cursor.offset > 0) {
    cursor.offset = 0;
    page = store.pendingObservations(limit, 0);
  }
  cursor.offset = page.length < limit ? 0 : cursor.offset + limit;
  for (const pending of page) {
    try {
      await observation.observe(pending);
    } catch {
      // A failed observation records nothing; the next sweep retries it.
    }
  }
}
