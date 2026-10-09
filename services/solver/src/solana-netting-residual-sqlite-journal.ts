import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bs58 from 'bs58';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type {
  SolanaNettingResidualEvidence,
  SolanaTestPerpNettingResidualPlan,
} from '@naryx/adapter-solana';
import {
  parseProtocolJson,
  stringifyProtocolJson,
  toHex,
} from '@naryx/protocol-types';
import type {
  SolanaNettingResidualAttempt,
  SolanaNettingResidualIntentStatus,
  SolanaNettingResidualJournalPort,
  SolanaNettingResidualSubmission,
  SolanaNettingResidualSubmissionStatus,
} from './solana-netting-residual-runtime.js';

const HASH = /^[0-9a-f]{64}$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface IntentRow {
  readonly intent_hash: string;
  readonly status: string;
  readonly plan_json: string;
  readonly evidence_json: string | null;
}

interface SubmissionRow {
  readonly intent_hash: string;
  readonly attempt_number: number;
  readonly status: string;
  readonly raw_transaction_base64: string;
  readonly signature: string;
  readonly recent_blockhash: string;
  readonly last_valid_block_height: string;
  readonly signed_at_slot: string;
  readonly submitted_at_slot: string | null;
  readonly expired_at_block_height: string | null;
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

function integerText(value: bigint, name: string, positive = false): string {
  requireCondition(typeof value === 'bigint' && (positive ? value > 0n : value >= 0n),
    `${name} is invalid`);
  return value.toString();
}

function parseInteger(value: string | null, name: string, positive = false): bigint | undefined {
  if (value === null) return undefined;
  requireCondition(INTEGER.test(value), `${name} is not canonical integer text`);
  const parsed = BigInt(value);
  requireCondition(parsed.toString() === value && (positive ? parsed > 0n : parsed >= 0n),
    `${name} is invalid`);
  return parsed;
}

function canonicalKey(value: string, name: string): string {
  try {
    const checked = new PublicKey(value);
    requireCondition(checked.toBase58() === value, `${name} is not canonical`);
    return value;
  } catch {
    throw new Error(`${name} is not a Solana public key`);
  }
}

function canonicalSignature(value: string): string {
  try {
    const decoded = bs58.decode(value);
    requireCondition(decoded.length === 64 && bs58.encode(decoded) === value,
      'signature is not canonical');
    return value;
  } catch {
    throw new Error('signature is not canonical base58');
  }
}

function canonicalBlockhash(value: string): string {
  try {
    const decoded = bs58.decode(value);
    requireCondition(decoded.length === 32 && bs58.encode(decoded) === value,
      'recent blockhash is not canonical');
    return value;
  } catch {
    throw new Error('recent blockhash is not canonical base58');
  }
}

function rawTransaction(value: string): string {
  requireCondition(typeof value === 'string' && value.length > 0 && BASE64.test(value),
    'raw Solana transaction is not base64');
  const decoded = Buffer.from(value, 'base64');
  requireCondition(decoded.length > 0 && decoded.toString('base64') === value,
    'raw Solana transaction is not canonical base64');
  return value;
}

function planJson(plan: SolanaTestPerpNettingResidualPlan): string {
  requireCondition(plan.version === 1
    && plan.guarantee === 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_RECEIPT',
  'Solana residual plan shape is invalid');
  const instruction = plan.instruction;
  const wire = {
    ...plan,
    instruction: {
      programId: instruction.programId.toBase58(),
      accounts: instruction.keys.map((account) => ({
        pubkey: account.pubkey.toBase58(),
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      })),
      dataBase64: instruction.data.toString('base64'),
    },
  };
  return stringifyProtocolJson(wire);
}

function decodePlan(value: string): SolanaTestPerpNettingResidualPlan {
  const decoded = parseProtocolJson(value) as Omit<SolanaTestPerpNettingResidualPlan, 'instruction'> & {
    readonly instruction: Readonly<{
      programId: string;
      accounts: readonly Readonly<{ pubkey: string; isSigner: boolean; isWritable: boolean }>[];
      dataBase64: string;
    }>;
  };
  requireCondition(decoded.version === 1
    && decoded.guarantee === 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_RECEIPT'
    && Array.isArray(decoded.instruction.accounts)
    && decoded.instruction.accounts.length > 0,
  'stored Solana residual plan is invalid');
  const instruction = new TransactionInstruction({
    programId: new PublicKey(canonicalKey(decoded.instruction.programId, 'stored instruction program')),
    keys: decoded.instruction.accounts.map((account) => ({
      pubkey: new PublicKey(canonicalKey(account.pubkey, 'stored instruction account')),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(rawTransaction(decoded.instruction.dataBase64), 'base64'),
  });
  const plan = Object.freeze({ ...decoded, instruction });
  requireCondition(planJson(plan) === value, 'stored Solana residual plan is not canonical');
  return plan;
}

function evidenceJson(evidence: SolanaNettingResidualEvidence): string {
  requireCondition(evidence.version === 1, 'Solana residual evidence version is invalid');
  return stringifyProtocolJson(evidence);
}

function decodeEvidence(value: string): SolanaNettingResidualEvidence {
  const decoded = parseProtocolJson(value) as SolanaNettingResidualEvidence;
  requireCondition(decoded.version === 1, 'stored Solana residual evidence version is invalid');
  return Object.freeze(decoded);
}

export class SolanaNettingResidualSqliteJournal implements SolanaNettingResidualJournalPort {
  readonly databasePath: string;
  readonly #database: Database.Database;
  #closed = false;

  constructor(databasePathInput: string) {
    requireCondition(typeof databasePathInput === 'string' && databasePathInput !== ':memory:'
      && !databasePathInput.startsWith('file:') && isAbsolute(databasePathInput),
    'Solana residual journal path must be an explicit absolute filesystem path');
    const databasePath = resolve(databasePathInput);
    const root = repositoryRoot();
    requireCondition(root === undefined || (databasePath !== root && !databasePath.startsWith(`${root}${sep}`)),
      'Solana residual journal must remain outside the repository');
    this.databasePath = databasePath;
    this.#database = new Database(databasePath, { timeout: 5_000 });
    try {
      const journalMode = this.#database.pragma('journal_mode = WAL', { simple: true });
      requireCondition(String(journalMode).toLowerCase() === 'wal', 'Solana residual journal mode is not WAL');
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

  async read(intentHashInput: string): Promise<SolanaNettingResidualAttempt | null> {
    this.#requireOpen();
    const row = this.#intentRow(intentHash(intentHashInput));
    return row === undefined ? null : this.#decode(row);
  }

  async prepare(input: Readonly<{
    intentHash: string;
    plan: SolanaTestPerpNettingResidualPlan;
  }>): Promise<SolanaNettingResidualAttempt> {
    this.#requireOpen();
    const hash = intentHash(input.intentHash);
    const serializedPlan = planJson(input.plan);
    const transaction = this.#database.transaction(() => {
      const existing = this.#intentRow(hash);
      if (existing !== undefined) {
        requireCondition(existing.plan_json === serializedPlan,
          'Solana residual replay changed its immutable plan');
        return;
      }
      const active = this.#database.prepare<[], { readonly count: number }>(`
        SELECT COUNT(*) AS count FROM solana_netting_residual_intents WHERE status != 'TERMINAL'
      `).get();
      requireCondition(active?.count === 0, 'another Solana residual transaction is unresolved');
      this.#database.prepare(`
        INSERT INTO solana_netting_residual_intents (intent_hash, status, plan_json)
        VALUES (?, 'PREPARED', ?)
      `).run(hash, serializedPlan);
    });
    transaction.immediate();
    return this.#required(hash);
  }

  async recordSigned(input: Readonly<{
    intentHash: string;
    rawTransactionBase64: string;
    signature: string;
    recentBlockhash: string;
    lastValidBlockHeight: bigint;
    signedAtSlot: bigint;
  }>): Promise<SolanaNettingResidualAttempt> {
    this.#requireOpen();
    const hash = intentHash(input.intentHash);
    const raw = rawTransaction(input.rawTransactionBase64);
    const signature = canonicalSignature(input.signature);
    const blockhash = canonicalBlockhash(input.recentBlockhash);
    const lastValid = integerText(input.lastValidBlockHeight, 'last valid block height', true);
    const signedAt = integerText(input.signedAtSlot, 'signed slot', true);
    const transaction = this.#database.transaction(() => {
      const existing = this.#required(hash);
      const active = existing.submissions.find((submission) => submission.status !== 'EXPIRED');
      if (active !== undefined) {
        requireCondition(active.status === 'SIGNED'
          && active.rawTransactionBase64 === raw
          && active.signature === signature
          && active.recentBlockhash === blockhash
          && active.lastValidBlockHeight === input.lastValidBlockHeight
          && active.signedAtSlot === input.signedAtSlot,
        'Solana residual signed replay differs from durable state');
        return;
      }
      requireCondition(existing.status === 'PREPARED',
        'only a prepared Solana residual can be signed');
      const attemptNumber = existing.submissions.length + 1;
      this.#database.prepare(`
        INSERT INTO solana_netting_residual_submissions (
          intent_hash, attempt_number, status, raw_transaction_base64, signature,
          recent_blockhash, last_valid_block_height, signed_at_slot
        ) VALUES (?, ?, 'SIGNED', ?, ?, ?, ?, ?)
      `).run(hash, attemptNumber, raw, signature, blockhash, lastValid, signedAt);
      const changed = this.#database.prepare(`
        UPDATE solana_netting_residual_intents SET status = 'ACTIVE'
        WHERE intent_hash = ? AND status = 'PREPARED'
      `).run(hash);
      requireCondition(changed.changes === 1, 'Solana residual signing transition lost compare-and-set');
    });
    transaction.immediate();
    return this.#required(hash);
  }

  async recordSubmitted(input: Readonly<{
    intentHash: string;
    signature: string;
    submittedAtSlot: bigint;
  }>): Promise<SolanaNettingResidualAttempt> {
    this.#requireOpen();
    const hash = intentHash(input.intentHash);
    const signature = canonicalSignature(input.signature);
    const submittedAt = integerText(input.submittedAtSlot, 'submitted slot', true);
    const transaction = this.#database.transaction(() => {
      const row = this.#submissionBySignature(hash, signature);
      requireCondition(row !== undefined, 'Solana residual signed submission was not found');
      if (row.status !== 'SIGNED') {
        requireCondition(row.status === 'SUBMITTED' && row.submitted_at_slot === submittedAt,
          'Solana residual submission replay differs from durable state');
        return;
      }
      const changed = this.#database.prepare(`
        UPDATE solana_netting_residual_submissions
        SET status = 'SUBMITTED', submitted_at_slot = ?
        WHERE intent_hash = ? AND signature = ? AND status = 'SIGNED'
      `).run(submittedAt, hash, signature);
      requireCondition(changed.changes === 1, 'Solana residual submission transition lost compare-and-set');
    });
    transaction.immediate();
    return this.#required(hash);
  }

  async recordExpired(input: Readonly<{
    intentHash: string;
    signature: string;
    expiredAtBlockHeight: bigint;
  }>): Promise<SolanaNettingResidualAttempt> {
    this.#requireOpen();
    const hash = intentHash(input.intentHash);
    const signature = canonicalSignature(input.signature);
    const expiredAt = integerText(input.expiredAtBlockHeight, 'expired block height', true);
    const transaction = this.#database.transaction(() => {
      const row = this.#submissionBySignature(hash, signature);
      requireCondition(row !== undefined, 'Solana residual submitted transaction was not found');
      if (row.status === 'EXPIRED') {
        requireCondition(row.expired_at_block_height === expiredAt,
          'Solana residual expiration replay differs from durable state');
        return;
      }
      requireCondition(row.status === 'SUBMITTED'
        && BigInt(expiredAt) > BigInt(row.last_valid_block_height),
      'only an expired submitted Solana transaction can be retried');
      const changed = this.#database.prepare(`
        UPDATE solana_netting_residual_submissions
        SET status = 'EXPIRED', expired_at_block_height = ?
        WHERE intent_hash = ? AND signature = ? AND status = 'SUBMITTED'
      `).run(expiredAt, hash, signature);
      requireCondition(changed.changes === 1, 'Solana residual expiration transition lost compare-and-set');
      const reset = this.#database.prepare(`
        UPDATE solana_netting_residual_intents SET status = 'PREPARED'
        WHERE intent_hash = ? AND status = 'ACTIVE'
      `).run(hash);
      requireCondition(reset.changes === 1, 'Solana residual retry transition lost compare-and-set');
    });
    transaction.immediate();
    return this.#required(hash);
  }

  async recordTerminal(input: Readonly<{
    intentHash: string;
    evidence: SolanaNettingResidualEvidence;
  }>): Promise<SolanaNettingResidualAttempt> {
    this.#requireOpen();
    const hash = intentHash(input.intentHash);
    requireCondition(toHex(input.evidence.intentHash) === hash,
      'Solana residual evidence cites another intent');
    const serializedEvidence = evidenceJson(input.evidence);
    const transaction = this.#database.transaction(() => {
      const existing = this.#required(hash);
      if (existing.status === 'TERMINAL') {
        requireCondition(existing.evidence !== undefined
          && evidenceJson(existing.evidence) === serializedEvidence,
        'Solana residual terminal replay differs from durable evidence');
        return;
      }
      const latest = existing.submissions.at(-1);
      requireCondition(latest !== undefined
        && (latest.status === 'SUBMITTED' || latest.status === 'EXPIRED'),
      'only an observed Solana residual can become terminal');
      const changed = this.#database.prepare(`
        UPDATE solana_netting_residual_intents SET status = 'TERMINAL', evidence_json = ?
        WHERE intent_hash = ? AND status != 'TERMINAL'
      `).run(serializedEvidence, hash);
      requireCondition(changed.changes === 1, 'Solana residual terminal transition lost compare-and-set');
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
      CREATE TABLE IF NOT EXISTS solana_netting_residual_intents (
        intent_hash TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('PREPARED', 'ACTIVE', 'TERMINAL')),
        plan_json TEXT NOT NULL,
        evidence_json TEXT,
        CHECK ((status = 'TERMINAL') = (evidence_json IS NOT NULL))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS solana_netting_residual_submissions (
        intent_hash TEXT NOT NULL REFERENCES solana_netting_residual_intents(intent_hash),
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        status TEXT NOT NULL CHECK (status IN ('SIGNED', 'SUBMITTED', 'EXPIRED')),
        raw_transaction_base64 TEXT NOT NULL,
        signature TEXT NOT NULL UNIQUE,
        recent_blockhash TEXT NOT NULL,
        last_valid_block_height TEXT NOT NULL,
        signed_at_slot TEXT NOT NULL,
        submitted_at_slot TEXT,
        expired_at_block_height TEXT,
        PRIMARY KEY (intent_hash, attempt_number),
        CHECK ((status = 'SIGNED') = (submitted_at_slot IS NULL)),
        CHECK ((status = 'EXPIRED') = (expired_at_block_height IS NOT NULL))
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS solana_netting_residual_one_active_intent
      ON solana_netting_residual_intents ((1)) WHERE status != 'TERMINAL';

      CREATE UNIQUE INDEX IF NOT EXISTS solana_netting_residual_one_active_submission
      ON solana_netting_residual_submissions (intent_hash) WHERE status != 'EXPIRED';

      CREATE TRIGGER IF NOT EXISTS solana_netting_residual_intent_no_delete
      BEFORE DELETE ON solana_netting_residual_intents
      BEGIN SELECT RAISE(ABORT, 'Solana residual intents cannot be deleted'); END;

      CREATE TRIGGER IF NOT EXISTS solana_netting_residual_submission_no_delete
      BEFORE DELETE ON solana_netting_residual_submissions
      BEGIN SELECT RAISE(ABORT, 'Solana residual submissions cannot be deleted'); END;

      CREATE TRIGGER IF NOT EXISTS solana_netting_residual_intent_immutable
      BEFORE UPDATE ON solana_netting_residual_intents
      WHEN NEW.intent_hash != OLD.intent_hash OR NEW.plan_json != OLD.plan_json
        OR (OLD.evidence_json IS NOT NULL AND NEW.evidence_json != OLD.evidence_json)
      BEGIN SELECT RAISE(ABORT, 'Solana residual intent binding cannot change'); END;

      CREATE TRIGGER IF NOT EXISTS solana_netting_residual_submission_immutable
      BEFORE UPDATE ON solana_netting_residual_submissions
      WHEN NEW.intent_hash != OLD.intent_hash OR NEW.attempt_number != OLD.attempt_number
        OR NEW.raw_transaction_base64 != OLD.raw_transaction_base64
        OR NEW.signature != OLD.signature OR NEW.recent_blockhash != OLD.recent_blockhash
        OR NEW.last_valid_block_height != OLD.last_valid_block_height
        OR NEW.signed_at_slot != OLD.signed_at_slot
        OR (OLD.submitted_at_slot IS NOT NULL AND NEW.submitted_at_slot != OLD.submitted_at_slot)
        OR (OLD.expired_at_block_height IS NOT NULL AND NEW.expired_at_block_height != OLD.expired_at_block_height)
      BEGIN SELECT RAISE(ABORT, 'Solana residual submission binding cannot change'); END;

      CREATE TRIGGER IF NOT EXISTS solana_netting_residual_submission_forward_only
      BEFORE UPDATE OF status ON solana_netting_residual_submissions
      WHEN NOT (
        (OLD.status = 'SIGNED' AND NEW.status = 'SUBMITTED')
        OR (OLD.status = 'SUBMITTED' AND NEW.status = 'EXPIRED')
      )
      BEGIN SELECT RAISE(ABORT, 'Solana residual submission status moves forward only'); END;
    `);
  }

  #intentRow(hash: string): IntentRow | undefined {
    return this.#database.prepare<[string], IntentRow>(`
      SELECT * FROM solana_netting_residual_intents WHERE intent_hash = ?
    `).get(hash);
  }

  #submissionRows(hash: string): readonly SubmissionRow[] {
    return this.#database.prepare<[string], SubmissionRow>(`
      SELECT * FROM solana_netting_residual_submissions
      WHERE intent_hash = ? ORDER BY attempt_number ASC
    `).all(hash);
  }

  #submissionBySignature(hash: string, signature: string): SubmissionRow | undefined {
    return this.#database.prepare<[string, string], SubmissionRow>(`
      SELECT * FROM solana_netting_residual_submissions
      WHERE intent_hash = ? AND signature = ?
    `).get(hash, signature);
  }

  #required(hash: string): SolanaNettingResidualAttempt {
    const row = this.#intentRow(hash);
    requireCondition(row !== undefined, 'Solana residual intent was not found');
    return this.#decode(row);
  }

  #decode(row: IntentRow): SolanaNettingResidualAttempt {
    const status = row.status;
    requireCondition(status === 'PREPARED' || status === 'ACTIVE' || status === 'TERMINAL',
      'stored Solana residual intent status is invalid');
    const submissions = this.#submissionRows(row.intent_hash).map((submission): SolanaNettingResidualSubmission => {
      requireCondition(submission.status === 'SIGNED' || submission.status === 'SUBMITTED'
        || submission.status === 'EXPIRED', 'stored Solana submission status is invalid');
      const submittedAtSlot = parseInteger(submission.submitted_at_slot, 'stored submitted slot', true);
      const expiredAtBlockHeight = parseInteger(
        submission.expired_at_block_height,
        'stored expired block height',
        true,
      );
      return Object.freeze({
        attemptNumber: submission.attempt_number,
        status: submission.status as SolanaNettingResidualSubmissionStatus,
        rawTransactionBase64: rawTransaction(submission.raw_transaction_base64),
        signature: canonicalSignature(submission.signature),
        recentBlockhash: canonicalBlockhash(submission.recent_blockhash),
        lastValidBlockHeight: parseInteger(
          submission.last_valid_block_height,
          'stored last valid block height',
          true,
        )!,
        signedAtSlot: parseInteger(submission.signed_at_slot, 'stored signed slot', true)!,
        ...(submittedAtSlot === undefined ? {} : { submittedAtSlot }),
        ...(expiredAtBlockHeight === undefined ? {} : { expiredAtBlockHeight }),
      });
    });
    return Object.freeze({
      intentHash: intentHash(row.intent_hash),
      status: status as SolanaNettingResidualIntentStatus,
      plan: decodePlan(row.plan_json),
      submissions: Object.freeze(submissions),
      ...(row.evidence_json === null ? {} : { evidence: decodeEvidence(row.evidence_json) }),
    });
  }

  #requireOpen(): void {
    requireCondition(!this.#closed, 'Solana residual journal is closed');
  }
}
