import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type {
  EvmNettingResidualEvidence,
  EvmTestPerpNettingResidualPlan,
} from '@naryx/adapter-evm';
import {
  parseProtocolJson,
  stringifyProtocolJson,
  toHex,
} from '@naryx/protocol-types';
import type { Hex } from 'viem';
import type {
  EvmNettingResidualAttempt,
  EvmNettingResidualAttemptStatus,
  EvmNettingResidualJournalPort,
} from './evm-netting-residual-runtime.js';

const HASH = /^[0-9a-f]{64}$/;
const PREFIXED_HASH = /^0x[0-9a-f]{64}$/;
const RAW_TRANSACTION = /^0x(?:[0-9a-f]{2})+$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;

interface AttemptRow {
  readonly intent_hash: string;
  readonly status: string;
  readonly plan_json: string;
  readonly raw_transaction: string | null;
  readonly transaction_hash: string | null;
  readonly transaction_nonce: string | null;
  readonly signed_at_seconds: string | null;
  readonly submitted_at_seconds: string | null;
  readonly evidence_json: string | null;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function repositoryRoot(): string | undefined {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function intentHash(value: string): string {
  requireCondition(HASH.test(value), 'intent hash must be lowercase 32-byte hex without a prefix');
  return value;
}

function prefixedHash(value: Hex, name: string): Hex {
  const normalized = value.toLowerCase() as Hex;
  requireCondition(PREFIXED_HASH.test(normalized), `${name} must be a 32-byte hash`);
  return normalized;
}

function rawTransaction(value: Hex): Hex {
  const normalized = value.toLowerCase() as Hex;
  requireCondition(RAW_TRANSACTION.test(normalized), 'raw transaction must be nonempty even-length hex');
  return normalized;
}

function uintText(value: bigint, name: string): string {
  requireCondition(typeof value === 'bigint' && value >= 0n, `${name} must be nonnegative`);
  return value.toString();
}

function positiveText(value: bigint, name: string): string {
  requireCondition(typeof value === 'bigint' && value > 0n, `${name} must be positive`);
  return value.toString();
}

function parseUint(value: string | null, name: string, positive = false): bigint | undefined {
  if (value === null) return undefined;
  requireCondition(INTEGER.test(value), `${name} is not canonical integer text`);
  const parsed = BigInt(value);
  requireCondition(parsed.toString() === value && (positive ? parsed > 0n : parsed >= 0n), `${name} is invalid`);
  return parsed;
}

function planJson(plan: EvmTestPerpNettingResidualPlan): string {
  requireCondition(plan.version === 1 && plan.guarantee === 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_EVENT',
    'EVM residual plan shape is invalid');
  const hash = toHex(plan.intentHash);
  requireCondition(plan.executionId.toLowerCase() === `0x${hash}`, 'EVM residual plan execution id differs from intent');
  return stringifyProtocolJson(plan);
}

function decodePlan(value: string): EvmTestPerpNettingResidualPlan {
  const decoded = parseProtocolJson(value) as EvmTestPerpNettingResidualPlan;
  planJson(decoded);
  return Object.freeze(decoded);
}

function evidenceJson(evidence: EvmNettingResidualEvidence): string {
  requireCondition(evidence.version === 1, 'EVM residual evidence version is invalid');
  return stringifyProtocolJson(evidence);
}

function decodeEvidence(value: string): EvmNettingResidualEvidence {
  const decoded = parseProtocolJson(value) as EvmNettingResidualEvidence;
  requireCondition(decoded.version === 1, 'stored EVM residual evidence version is invalid');
  return Object.freeze(decoded);
}

export class EvmNettingResidualSqliteJournal implements EvmNettingResidualJournalPort {
  readonly databasePath: string;
  readonly #database: Database.Database;
  #closed = false;

  constructor(databasePathInput: string) {
    requireCondition(typeof databasePathInput === 'string' && databasePathInput !== ':memory:'
      && !databasePathInput.startsWith('file:') && isAbsolute(databasePathInput),
    'EVM residual journal path must be an explicit absolute filesystem path');
    const databasePath = resolve(databasePathInput);
    const root = repositoryRoot();
    requireCondition(root === undefined || (databasePath !== root && !databasePath.startsWith(`${root}${sep}`)),
      'EVM residual journal must remain outside the repository');
    this.databasePath = databasePath;
    this.#database = new Database(databasePath, { timeout: 5_000 });
    try {
      const journalMode = this.#database.pragma('journal_mode = WAL', { simple: true });
      requireCondition(String(journalMode).toLowerCase() === 'wal', 'EVM residual journal mode is not WAL');
      this.#database.pragma('synchronous = FULL');
      this.#database.pragma('foreign_keys = ON');
      this.#database.pragma('trusted_schema = OFF');
      this.#initialize();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  async read(intentHashInput: string): Promise<EvmNettingResidualAttempt | null> {
    this.#requireOpen();
    const row = this.#row(intentHash(intentHashInput));
    return row === undefined ? null : this.#decode(row);
  }

  async prepare(input: Readonly<{
    intentHash: string;
    plan: EvmTestPerpNettingResidualPlan;
  }>): Promise<EvmNettingResidualAttempt> {
    this.#requireOpen();
    const hash = intentHash(input.intentHash);
    const serializedPlan = planJson(input.plan);
    const transaction = this.#database.transaction(() => {
      const existing = this.#row(hash);
      if (existing !== undefined) {
        requireCondition(existing.plan_json === serializedPlan, 'EVM residual replay changed its immutable plan');
        return;
      }
      const active = this.#database.prepare<[], { readonly count: number }>(`
        SELECT COUNT(*) AS count FROM evm_netting_residual_attempts WHERE status != 'TERMINAL'
      `).get();
      requireCondition(active?.count === 0, 'another EVM residual transaction is unresolved');
      this.#database.prepare(`
        INSERT INTO evm_netting_residual_attempts (intent_hash, status, plan_json)
        VALUES (?, 'PREPARED', ?)
      `).run(hash, serializedPlan);
    });
    transaction.immediate();
    return this.#required(hash);
  }

  async recordSigned(input: Readonly<{
    intentHash: string;
    rawTransaction: Hex;
    transactionHash: Hex;
    transactionNonce: bigint;
    signedAtSeconds: bigint;
  }>): Promise<EvmNettingResidualAttempt> {
    this.#requireOpen();
    const hash = intentHash(input.intentHash);
    const raw = rawTransaction(input.rawTransaction);
    const transactionHash = prefixedHash(input.transactionHash, 'transaction hash');
    const nonce = uintText(input.transactionNonce, 'transaction nonce');
    const signedAt = positiveText(input.signedAtSeconds, 'signed time');
    const transaction = this.#database.transaction(() => {
      const existing = this.#required(hash);
      if (existing.status !== 'PREPARED') {
        requireCondition(existing.rawTransaction === raw
          && existing.transactionHash?.toLowerCase() === transactionHash
          && existing.transactionNonce === input.transactionNonce
          && existing.signedAtSeconds === input.signedAtSeconds,
        'EVM residual signed replay differs from durable state');
        return;
      }
      const changed = this.#database.prepare(`
        UPDATE evm_netting_residual_attempts
        SET status = 'SIGNED', raw_transaction = ?, transaction_hash = ?, transaction_nonce = ?, signed_at_seconds = ?
        WHERE intent_hash = ? AND status = 'PREPARED'
      `).run(raw, transactionHash, nonce, signedAt, hash);
      requireCondition(changed.changes === 1, 'EVM residual signing transition lost compare-and-set');
    });
    transaction.immediate();
    return this.#required(hash);
  }

  async recordSubmitted(input: Readonly<{
    intentHash: string;
    transactionHash: Hex;
    submittedAtSeconds: bigint;
  }>): Promise<EvmNettingResidualAttempt> {
    this.#requireOpen();
    const hash = intentHash(input.intentHash);
    const transactionHash = prefixedHash(input.transactionHash, 'transaction hash');
    const submittedAt = positiveText(input.submittedAtSeconds, 'submitted time');
    const transaction = this.#database.transaction(() => {
      const existing = this.#required(hash);
      requireCondition(existing.transactionHash?.toLowerCase() === transactionHash,
        'EVM residual submission transaction hash differs from durable state');
      if (existing.status !== 'SIGNED') {
        requireCondition(existing.submittedAtSeconds === input.submittedAtSeconds,
          'EVM residual submission replay differs from durable state');
        return;
      }
      const changed = this.#database.prepare(`
        UPDATE evm_netting_residual_attempts
        SET status = 'SUBMITTED', submitted_at_seconds = ?
        WHERE intent_hash = ? AND status = 'SIGNED'
      `).run(submittedAt, hash);
      requireCondition(changed.changes === 1, 'EVM residual submission transition lost compare-and-set');
    });
    transaction.immediate();
    return this.#required(hash);
  }

  async recordTerminal(input: Readonly<{
    intentHash: string;
    evidence: EvmNettingResidualEvidence;
  }>): Promise<EvmNettingResidualAttempt> {
    this.#requireOpen();
    const hash = intentHash(input.intentHash);
    requireCondition(toHex(input.evidence.intentHash) === hash,
      'EVM residual evidence cites another intent');
    const serializedEvidence = evidenceJson(input.evidence);
    const transaction = this.#database.transaction(() => {
      const existing = this.#required(hash);
      if (existing.status === 'TERMINAL') {
        requireCondition(existing.evidence !== undefined
          && evidenceJson(existing.evidence) === serializedEvidence,
        'EVM residual terminal replay differs from durable evidence');
        return;
      }
      requireCondition(existing.status === 'SUBMITTED', 'only a submitted EVM residual can become terminal');
      const changed = this.#database.prepare(`
        UPDATE evm_netting_residual_attempts SET status = 'TERMINAL', evidence_json = ?
        WHERE intent_hash = ? AND status = 'SUBMITTED'
      `).run(serializedEvidence, hash);
      requireCondition(changed.changes === 1, 'EVM residual terminal transition lost compare-and-set');
    });
    transaction.immediate();
    return this.#required(hash);
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #initialize(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS evm_netting_residual_attempts (
        intent_hash TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('PREPARED', 'SIGNED', 'SUBMITTED', 'TERMINAL')),
        plan_json TEXT NOT NULL,
        raw_transaction TEXT,
        transaction_hash TEXT UNIQUE,
        transaction_nonce TEXT,
        signed_at_seconds TEXT,
        submitted_at_seconds TEXT,
        evidence_json TEXT,
        CHECK ((status = 'PREPARED') = (raw_transaction IS NULL)),
        CHECK ((status IN ('PREPARED', 'SIGNED')) = (submitted_at_seconds IS NULL)),
        CHECK ((status = 'TERMINAL') = (evidence_json IS NOT NULL))
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS evm_netting_residual_one_active
      ON evm_netting_residual_attempts ((1)) WHERE status != 'TERMINAL';

      CREATE TRIGGER IF NOT EXISTS evm_netting_residual_no_delete
      BEFORE DELETE ON evm_netting_residual_attempts
      BEGIN SELECT RAISE(ABORT, 'EVM residual attempts cannot be deleted'); END;

      CREATE TRIGGER IF NOT EXISTS evm_netting_residual_immutable_binding
      BEFORE UPDATE ON evm_netting_residual_attempts
      WHEN NEW.intent_hash != OLD.intent_hash OR NEW.plan_json != OLD.plan_json
        OR (OLD.raw_transaction IS NOT NULL AND NEW.raw_transaction != OLD.raw_transaction)
        OR (OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash != OLD.transaction_hash)
        OR (OLD.transaction_nonce IS NOT NULL AND NEW.transaction_nonce != OLD.transaction_nonce)
        OR (OLD.signed_at_seconds IS NOT NULL AND NEW.signed_at_seconds != OLD.signed_at_seconds)
        OR (OLD.submitted_at_seconds IS NOT NULL AND NEW.submitted_at_seconds != OLD.submitted_at_seconds)
        OR (OLD.evidence_json IS NOT NULL AND NEW.evidence_json != OLD.evidence_json)
      BEGIN SELECT RAISE(ABORT, 'EVM residual immutable binding cannot change'); END;

      CREATE TRIGGER IF NOT EXISTS evm_netting_residual_forward_only
      BEFORE UPDATE OF status ON evm_netting_residual_attempts
      WHEN NOT (
        (OLD.status = 'PREPARED' AND NEW.status = 'SIGNED')
        OR (OLD.status = 'SIGNED' AND NEW.status = 'SUBMITTED')
        OR (OLD.status = 'SUBMITTED' AND NEW.status = 'TERMINAL')
      )
      BEGIN SELECT RAISE(ABORT, 'EVM residual status moves forward only'); END;
    `);
  }

  #row(hash: string): AttemptRow | undefined {
    return this.#database.prepare<[string], AttemptRow>(`
      SELECT * FROM evm_netting_residual_attempts WHERE intent_hash = ?
    `).get(hash);
  }

  #required(hash: string): EvmNettingResidualAttempt {
    const row = this.#row(hash);
    requireCondition(row !== undefined, 'EVM residual attempt was not found');
    return this.#decode(row);
  }

  #decode(row: AttemptRow): EvmNettingResidualAttempt {
    const status = row.status;
    requireCondition(status === 'PREPARED' || status === 'SIGNED'
      || status === 'SUBMITTED' || status === 'TERMINAL', 'stored EVM residual status is invalid');
    const checkedStatus = status as EvmNettingResidualAttemptStatus;
    const base = {
      intentHash: intentHash(row.intent_hash),
      status: checkedStatus,
      plan: decodePlan(row.plan_json),
    };
    const transactionNonce = parseUint(row.transaction_nonce, 'stored transaction nonce');
    const signedAtSeconds = parseUint(row.signed_at_seconds, 'stored signed time', true);
    const submittedAtSeconds = parseUint(row.submitted_at_seconds, 'stored submitted time', true);
    return Object.freeze({
      ...base,
      ...(row.raw_transaction === null ? {} : { rawTransaction: rawTransaction(row.raw_transaction as Hex) }),
      ...(row.transaction_hash === null ? {} : { transactionHash: prefixedHash(row.transaction_hash as Hex, 'stored transaction hash') }),
      ...(transactionNonce === undefined ? {} : { transactionNonce }),
      ...(signedAtSeconds === undefined ? {} : { signedAtSeconds }),
      ...(submittedAtSeconds === undefined ? {} : { submittedAtSeconds }),
      ...(row.evidence_json === null ? {} : { evidence: decodeEvidence(row.evidence_json) }),
    });
  }

  #requireOpen(): void {
    requireCondition(!this.#closed, 'EVM residual journal is closed');
  }
}
