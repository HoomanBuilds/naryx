import type Database from "better-sqlite3";
import { openDurableDatabase } from "./durable-sqlite.js";
import {
  InMemoryPreparedEvmTestnetAtomicStore,
  validateEvmTestnetAtomicPreparation,
  type EvmTestnetAtomicPreparationDto,
  type PreparedEvmTestnetAtomicRecord,
  type PreparedEvmTestnetAtomicStore,
} from "./evm-testnet-runtime-ports.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

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
`;

type Row = Readonly<{
  idempotency_key: unknown;
  attempt_id: unknown;
  trader_signature: unknown;
  preparation_json: unknown;
  bound_transaction_hash: unknown;
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

/**
 * Durable prepared Base Sepolia attempts keyed by idempotency key. Each row is revalidated against
 * its request commitment on read, an idempotency key binds one attempt, trader signature, and
 * preparation forever, and a broadcast transaction hash binds once, so observation and replay
 * survive a restart and a conflicting reuse fails closed.
 */
export class SqlitePreparedEvmTestnetAtomicStore implements PreparedEvmTestnetAtomicStore {
  readonly #db: Database.Database;
  readonly #select: Database.Statement;
  readonly #insert: Database.Statement;
  readonly #bind: Database.Statement;

  constructor(dbPath: string) {
    this.#db = openDurableDatabase(
      dbPath,
      SCHEMA_SQL,
      (code, message) => new PreparedEvmTestnetAtomicStoreError(code, message),
    );
    this.#select = this.#db.prepare("SELECT * FROM evm_prepared_atomic_attempts WHERE idempotency_key = ?");
    this.#insert = this.#db.prepare(
      "INSERT INTO evm_prepared_atomic_attempts (idempotency_key, attempt_id, trader_signature, preparation_json, bound_transaction_hash) VALUES (?, ?, ?, ?, NULL)",
    );
    this.#bind = this.#db.prepare(
      "UPDATE evm_prepared_atomic_attempts SET bound_transaction_hash = ? WHERE idempotency_key = ? AND bound_transaction_hash IS NULL",
    );
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

  close(): void {
    this.#db.close();
  }
}
