import bs58 from 'bs58';
import type Database from 'better-sqlite3';
import {
  verifyEvmNettingAllocationObservationBinding,
  type EvmNettingAllocationObservationBinding,
} from '@naryx/adapter-evm';
import {
  verifySolanaNettingAllocationObservationBinding,
  type SolanaNettingAllocationObservationBinding,
} from '@naryx/adapter-solana';
import {
  bytesEqual,
  commitmentHash,
  parseProtocolJson,
  stringifyProtocolJson,
  toHex,
  type NettingAllocationExecutionAuthorization,
} from '@naryx/protocol-types';
import { openDurableDatabase } from './durable-sqlite.js';

const ID = /^[A-Za-z0-9_-]{16,96}$/;
const EVM_TRANSACTION = /^0x[0-9a-f]{64}$/;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS netting_allocation_execution_attempts (
  attempt_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  authorization_hash BLOB NOT NULL,
  runtime_class TEXT NOT NULL CHECK (runtime_class IN ('EVM', 'SVM')),
  binding_json TEXT NOT NULL,
  execution_reference TEXT,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS netting_allocation_attempts_by_authorization
  ON netting_allocation_execution_attempts (authorization_hash, recorded_at_ms, attempt_id);
CREATE TRIGGER IF NOT EXISTS reject_netting_allocation_attempt_delete
  BEFORE DELETE ON netting_allocation_execution_attempts
  BEGIN SELECT RAISE(ABORT, 'netting allocation attempts are durable'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_allocation_attempt_rewrite
  BEFORE UPDATE ON netting_allocation_execution_attempts
  WHEN NEW.attempt_id IS NOT OLD.attempt_id
    OR NEW.idempotency_key IS NOT OLD.idempotency_key
    OR NEW.authorization_hash IS NOT OLD.authorization_hash
    OR NEW.runtime_class IS NOT OLD.runtime_class
    OR NEW.binding_json IS NOT OLD.binding_json
    OR OLD.execution_reference IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'netting allocation attempts bind one execution reference'); END;
`;

export type NettingAllocationAttemptRuntime = 'EVM' | 'SVM';

export type NettingAllocationObservationBinding =
  | Readonly<{ runtimeClass: 'EVM'; binding: EvmNettingAllocationObservationBinding }>
  | Readonly<{ runtimeClass: 'SVM'; binding: SolanaNettingAllocationObservationBinding }>;

export interface NettingAllocationExecutionAttempt {
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly authorizationHashHex: string;
  readonly observation: NettingAllocationObservationBinding;
  readonly executionReference?: string;
  readonly recordedAtMs: number;
}

export class NettingAllocationAttemptStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NettingAllocationAttemptStoreError';
    this.code = code;
  }
}

type Row = Readonly<{
  attempt_id: unknown;
  idempotency_key: unknown;
  authorization_hash: unknown;
  runtime_class: unknown;
  binding_json: unknown;
  execution_reference: unknown;
  recorded_at_ms: unknown;
}>;

function canonicalId(value: string, context: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${context} must use 16 to 96 URL-safe characters`);
  return value;
}

function reference(runtime: NettingAllocationAttemptRuntime, value: string): string {
  if (runtime === 'EVM') {
    if (typeof value !== 'string' || !EVM_TRANSACTION.test(value)) {
      throw new Error('EVM execution reference must be a canonical lowercase transaction hash');
    }
    return value;
  }
  try {
    const decoded = bs58.decode(value);
    if (decoded.length !== 64 || bs58.encode(decoded) !== value) throw new Error('invalid signature');
    return value;
  } catch {
    throw new Error('SVM execution reference must be a canonical transaction signature');
  }
}

function validateBinding(
  observation: NettingAllocationObservationBinding,
  authorization: NettingAllocationExecutionAuthorization,
): void {
  if (observation.runtimeClass === 'EVM') {
    verifyEvmNettingAllocationObservationBinding(observation.binding, authorization);
  } else {
    verifySolanaNettingAllocationObservationBinding(observation.binding, authorization);
  }
}

function decodeBinding(runtime: NettingAllocationAttemptRuntime, value: string): NettingAllocationObservationBinding {
  const binding = parseProtocolJson(value);
  return runtime === 'EVM'
    ? Object.freeze({ runtimeClass: 'EVM' as const, binding: binding as EvmNettingAllocationObservationBinding })
    : Object.freeze({ runtimeClass: 'SVM' as const, binding: binding as SolanaNettingAllocationObservationBinding });
}

function hashBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error('stored authorization hash is invalid');
  return Uint8Array.from(value);
}

export class SqliteNettingAllocationAttemptStore {
  readonly #db: Database.Database;
  readonly #clock: () => number;

  constructor(dbPath: string, clock: () => number = Date.now) {
    this.#db = openDurableDatabase(
      dbPath,
      SCHEMA_SQL,
      (code, message) => new NettingAllocationAttemptStoreError(code, message),
    );
    this.#clock = clock;
  }

  close(): void {
    this.#db.close();
  }

  save(input: Readonly<{
    attemptId: string;
    idempotencyKey: string;
    authorization: NettingAllocationExecutionAuthorization;
    observation: NettingAllocationObservationBinding;
  }>): NettingAllocationExecutionAttempt {
    const attemptId = canonicalId(input.attemptId, 'attempt id');
    const idempotencyKey = canonicalId(input.idempotencyKey, 'idempotency key');
    validateBinding(input.observation, input.authorization);
    const authorizationHash = commitmentHash(input.authorization.authorizationHash);
    const bindingJson = stringifyProtocolJson(input.observation.binding);
    return this.#db.transaction(() => {
      const byAttempt = this.#row('attempt_id', attemptId);
      const byIdempotency = this.#row('idempotency_key', idempotencyKey);
      const existing = byAttempt ?? byIdempotency;
      if (existing !== undefined) {
        const decoded = this.#decode(existing, input.authorization);
        if (decoded.attemptId !== attemptId
          || decoded.idempotencyKey !== idempotencyKey
          || decoded.observation.runtimeClass !== input.observation.runtimeClass
          || stringifyProtocolJson(decoded.observation.binding) !== bindingJson) {
          throw new NettingAllocationAttemptStoreError(
            'IDEMPOTENCY_CONFLICT',
            'Attempt or idempotency key was already used with different execution fields.',
          );
        }
        return decoded;
      }
      const recordedAtMs = this.#clock();
      if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0) throw new Error('attempt clock is invalid');
      this.#db.prepare(`
        INSERT INTO netting_allocation_execution_attempts
          (attempt_id, idempotency_key, authorization_hash, runtime_class, binding_json,
           execution_reference, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, NULL, ?)
      `).run(
        attemptId,
        idempotencyKey,
        authorizationHash,
        input.observation.runtimeClass,
        bindingJson,
        recordedAtMs,
      );
      return Object.freeze({
        attemptId,
        idempotencyKey,
        authorizationHashHex: toHex(authorizationHash),
        observation: input.observation,
        recordedAtMs,
      });
    }).immediate();
  }

  get(
    attemptId: string,
    authorization: NettingAllocationExecutionAuthorization,
  ): NettingAllocationExecutionAttempt | undefined {
    const row = this.#row('attempt_id', canonicalId(attemptId, 'attempt id'));
    return row === undefined ? undefined : this.#decode(row, authorization);
  }

  bindExecutionReference(
    attemptId: string,
    authorization: NettingAllocationExecutionAuthorization,
    executionReference: string,
  ): NettingAllocationExecutionAttempt {
    return this.#db.transaction(() => {
      const existing = this.get(attemptId, authorization);
      if (existing === undefined) {
        throw new NettingAllocationAttemptStoreError('ATTEMPT_NOT_FOUND', 'Netting allocation attempt is not stored.');
      }
      const checked = reference(existing.observation.runtimeClass, executionReference);
      if (existing.executionReference !== undefined) {
        if (existing.executionReference !== checked) {
          throw new NettingAllocationAttemptStoreError(
            'EXECUTION_REFERENCE_CONFLICT',
            'Netting allocation attempt is already bound to another execution reference.',
          );
        }
        return existing;
      }
      try {
        this.#db.prepare(`
          UPDATE netting_allocation_execution_attempts
          SET execution_reference = ?
          WHERE attempt_id = ? AND execution_reference IS NULL
        `).run(checked, existing.attemptId);
      } catch (error) {
        throw new NettingAllocationAttemptStoreError(
          'EXECUTION_REFERENCE_CONFLICT',
          error instanceof Error ? error.message : 'Execution reference conflicts with durable state.',
        );
      }
      return this.get(existing.attemptId, authorization)!;
    }).immediate();
  }

  attemptsForAuthorization(
    authorization: NettingAllocationExecutionAuthorization,
  ): readonly NettingAllocationExecutionAttempt[] {
    const hash = commitmentHash(authorization.authorizationHash);
    const rows = this.#db.prepare(`
      SELECT * FROM netting_allocation_execution_attempts
      WHERE authorization_hash = ?
      ORDER BY recorded_at_ms, attempt_id
    `).all(hash) as Row[];
    return Object.freeze(rows.map((row) => this.#decode(row, authorization)));
  }

  #row(field: 'attempt_id' | 'idempotency_key', value: string): Row | undefined {
    return this.#db.prepare(
      `SELECT * FROM netting_allocation_execution_attempts WHERE ${field} = ?`,
    ).get(value) as Row | undefined;
  }

  #decode(
    row: Row,
    authorization: NettingAllocationExecutionAuthorization,
  ): NettingAllocationExecutionAttempt {
    try {
      if (typeof row.attempt_id !== 'string' || typeof row.idempotency_key !== 'string'
        || (row.runtime_class !== 'EVM' && row.runtime_class !== 'SVM')
        || typeof row.binding_json !== 'string'
        || (row.execution_reference !== null && typeof row.execution_reference !== 'string')
        || typeof row.recorded_at_ms !== 'number' || !Number.isSafeInteger(row.recorded_at_ms)
        || row.recorded_at_ms < 0) throw new Error('malformed row');
      const attemptId = canonicalId(row.attempt_id, 'attempt id');
      const idempotencyKey = canonicalId(row.idempotency_key, 'idempotency key');
      const authorizationHash = hashBytes(row.authorization_hash);
      if (!bytesEqual(authorizationHash, authorization.authorizationHash)) throw new Error('authorization mismatch');
      const observation = decodeBinding(row.runtime_class, row.binding_json);
      validateBinding(observation, authorization);
      if (stringifyProtocolJson(observation.binding) !== row.binding_json) throw new Error('noncanonical binding');
      const executionReference = row.execution_reference === null
        ? undefined
        : reference(row.runtime_class, row.execution_reference);
      return Object.freeze({
        attemptId,
        idempotencyKey,
        authorizationHashHex: toHex(authorizationHash),
        observation,
        ...(executionReference === undefined ? {} : { executionReference }),
        recordedAtMs: row.recorded_at_ms,
      });
    } catch (error) {
      if (error instanceof NettingAllocationAttemptStoreError) throw error;
      throw new NettingAllocationAttemptStoreError(
        'CORRUPT_ROW',
        `Stored netting allocation attempt failed revalidation.${error instanceof Error ? ` ${error.message}` : ''}`,
      );
    }
  }
}
