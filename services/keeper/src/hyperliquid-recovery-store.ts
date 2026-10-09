import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import type { HyperliquidRecoverySubmissionJournal } from './hyperliquid-recovery-submission-journal.js';

const SCHEMA_VERSION = 1;
const HASH = /^0x[0-9a-f]{64}$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const MAXIMUM_SNAPSHOT_BYTES = 16 * 1024 * 1024;

interface MetadataRow {
  readonly schema_version: number;
  readonly current_journal_version_decimal: string | null;
  readonly current_snapshot_hash: string | null;
}

interface SnapshotRow {
  readonly journal_version_decimal: string;
  readonly snapshot_hash: string;
  readonly previous_snapshot_hash: string | null;
  readonly journal_json: string;
}

export interface HyperliquidRecoveryJournalSnapshot {
  readonly revision: `0x${string}`;
  readonly journal: HyperliquidRecoverySubmissionJournal;
}

export interface HyperliquidRecoverySqliteStoreOptions {
  readonly databasePath: string;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Hyperliquid recovery store failed: ${message}`);
}

function canonicalVersion(value: bigint, name: string): string {
  requireCondition(typeof value === 'bigint' && value >= 0n, `${name} is invalid`);
  return value.toString();
}

function decodedVersion(value: string, name: string): bigint {
  requireCondition(DECIMAL_INTEGER.test(value), `${name} is not canonical integer text`);
  const decoded = BigInt(value);
  requireCondition(decoded.toString() === value, `${name} is not canonical integer text`);
  return decoded;
}

function hash(value: unknown, name: string): `0x${string}` {
  requireCondition(typeof value === 'string' && HASH.test(value), `${name} is invalid`);
  return value as `0x${string}`;
}

function validateJournal(value: unknown): HyperliquidRecoverySubmissionJournal {
  requireCondition(typeof value === 'object' && value !== null, 'journal is missing');
  const journal = value as Partial<HyperliquidRecoverySubmissionJournal>;
  requireCondition(typeof journal.version === 'bigint' && journal.version >= 0n,
    'journal version is invalid');
  requireCondition(typeof journal.verifierIdentityHash === 'string'
    && HASH.test(journal.verifierIdentityHash), 'verifier identity hash is invalid');
  requireCondition(typeof journal.verifierIdentity === 'object'
    && journal.verifierIdentity !== null, 'verifier identity is missing');
  requireCondition(Array.isArray(journal.agents), 'journal agents are missing');
  return journal as HyperliquidRecoverySubmissionJournal;
}

function snapshotHash(journalJson: string): `0x${string}` {
  return `0x${createHash('sha256').update(journalJson).digest('hex')}`;
}

function decodeSnapshot(row: SnapshotRow): HyperliquidRecoveryJournalSnapshot {
  requireCondition(Buffer.byteLength(row.journal_json) <= MAXIMUM_SNAPSHOT_BYTES,
    'stored journal snapshot exceeds the size limit');
  const journal = validateJournal(parseProtocolJson(row.journal_json));
  requireCondition(stringifyProtocolJson(journal) === row.journal_json,
    'stored journal snapshot is not canonical protocol JSON');
  const revision = hash(row.snapshot_hash, 'stored snapshot hash');
  requireCondition(snapshotHash(row.journal_json) === revision, 'stored snapshot hash differs');
  requireCondition(canonicalVersion(journal.version, 'stored journal version')
    === row.journal_version_decimal, 'stored journal version differs');
  if (row.previous_snapshot_hash !== null) {
    hash(row.previous_snapshot_hash, 'stored previous snapshot hash');
  }
  return Object.freeze({ revision, journal });
}

export class HyperliquidRecoverySqliteStore {
  readonly databasePath: string;
  readonly #database: Database.Database;
  #closed = false;

  constructor(options: HyperliquidRecoverySqliteStoreOptions) {
    requireCondition(typeof options?.databasePath === 'string'
      && options.databasePath.length > 0
      && options.databasePath !== ':memory:'
      && !options.databasePath.startsWith('file:')
      && isAbsolute(options.databasePath),
    'databasePath must be an explicit absolute filesystem path');
    const databasePath = resolve(options.databasePath);
    const projectRelativePath = relative(resolve(process.cwd()), databasePath);
    requireCondition(projectRelativePath === '..'
      || projectRelativePath.startsWith(`..${sep}`)
      || isAbsolute(projectRelativePath),
    'databasePath must be outside the current project directory');
    const parent = dirname(databasePath);
    requireCondition(existsSync(parent) && lstatSync(parent).isDirectory(),
      'database parent directory must already exist');
    if (existsSync(databasePath)) {
      const state = lstatSync(databasePath);
      requireCondition(state.isFile() && !state.isSymbolicLink(),
        'databasePath must be a regular file');
    }
    this.databasePath = databasePath;
    this.#database = new Database(databasePath, { timeout: 5_000 });
    try {
      const journalMode = this.#database.pragma('journal_mode = WAL', { simple: true });
      requireCondition(String(journalMode).toLowerCase() === 'wal',
        'SQLite journal mode is not WAL');
      this.#database.pragma('synchronous = FULL');
      requireCondition(Number(this.#database.pragma('synchronous', { simple: true })) === 2,
        'SQLite synchronous mode is not FULL');
      this.#database.pragma('foreign_keys = ON');
      this.#database.pragma('trusted_schema = OFF');
      this.#database.pragma('fullfsync = ON');
      this.#database.pragma('checkpoint_fullfsync = ON');
      this.#initializeSchema();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  read(): HyperliquidRecoveryJournalSnapshot | null {
    this.#requireOpen();
    const metadata = this.#metadata();
    if (metadata.current_snapshot_hash === null) {
      requireCondition(metadata.current_journal_version_decimal === null,
        'empty journal metadata is inconsistent');
      return null;
    }
    requireCondition(metadata.current_journal_version_decimal !== null,
      'journal metadata version is missing');
    const row = this.#database.prepare<[string], SnapshotRow>(`
      SELECT journal_version_decimal, snapshot_hash, previous_snapshot_hash, journal_json
      FROM hyperliquid_recovery_snapshots
      WHERE snapshot_hash = ?
    `).get(metadata.current_snapshot_hash);
    requireCondition(row !== undefined, 'current journal snapshot is missing');
    const snapshot = decodeSnapshot(row);
    requireCondition(row.journal_version_decimal === metadata.current_journal_version_decimal,
      'current journal version differs from metadata');
    return snapshot;
  }

  persist(
    expectedRevision: `0x${string}` | null,
    journalInput: HyperliquidRecoverySubmissionJournal,
  ): HyperliquidRecoveryJournalSnapshot {
    this.#requireOpen();
    if (expectedRevision !== null) hash(expectedRevision, 'expected revision');
    const journal = validateJournal(journalInput);
    const journalJson = stringifyProtocolJson(journal);
    requireCondition(Buffer.byteLength(journalJson) <= MAXIMUM_SNAPSHOT_BYTES,
      'journal snapshot exceeds the size limit');
    const nextHash = snapshotHash(journalJson);
    const transaction = this.#database.transaction(() => {
      const metadata = this.#metadata();
      requireCondition(metadata.current_snapshot_hash === expectedRevision,
        'snapshot compare-and-set revision differs');
      if (metadata.current_snapshot_hash === nextHash) {
        requireCondition(metadata.current_journal_version_decimal
          === canonicalVersion(journal.version, 'journal version'),
        'same snapshot hash has a different journal version');
        return;
      }
      if (metadata.current_snapshot_hash !== null) {
        const row = this.#database.prepare<[string], SnapshotRow>(`
          SELECT journal_version_decimal, snapshot_hash, previous_snapshot_hash, journal_json
          FROM hyperliquid_recovery_snapshots WHERE snapshot_hash = ?
        `).get(metadata.current_snapshot_hash);
        requireCondition(row !== undefined, 'current journal snapshot is missing');
        const current = decodeSnapshot(row);
        requireCondition(journal.version === current.journal.version + 1n,
          'journal version must advance exactly once');
        requireCondition(journal.verifierIdentityHash === current.journal.verifierIdentityHash,
          'verifier identity cannot change');
      } else {
        requireCondition(journal.version > 0n, 'initial journal must contain a registered agent');
      }
      this.#database.prepare(`
        INSERT INTO hyperliquid_recovery_snapshots (
          journal_version_decimal, snapshot_hash, previous_snapshot_hash,
          journal_json, created_at_ms_decimal
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        canonicalVersion(journal.version, 'journal version'),
        nextHash,
        metadata.current_snapshot_hash,
        journalJson,
        Date.now().toString(),
      );
      const update = metadata.current_snapshot_hash === null
        ? this.#database.prepare(`
            UPDATE hyperliquid_recovery_metadata
            SET current_journal_version_decimal = ?, current_snapshot_hash = ?
            WHERE singleton = 1 AND current_snapshot_hash IS NULL
          `).run(canonicalVersion(journal.version, 'journal version'), nextHash)
        : this.#database.prepare(`
            UPDATE hyperliquid_recovery_metadata
            SET current_journal_version_decimal = ?, current_snapshot_hash = ?
            WHERE singleton = 1 AND current_snapshot_hash = ?
          `).run(
            canonicalVersion(journal.version, 'journal version'),
            nextHash,
            metadata.current_snapshot_hash,
          );
      requireCondition(update.changes === 1, 'journal head compare-and-set failed');
    });
    transaction.immediate();
    const stored = this.read();
    requireCondition(stored !== null && stored.revision === nextHash,
      'journal readback differs from the committed snapshot');
    return stored;
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #initializeSchema(): void {
    const userVersion = Number(this.#database.pragma('user_version', { simple: true }));
    if (userVersion === 0) {
      const existing = this.#database.prepare<[], { readonly count: number }>(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%'
      `).get();
      requireCondition(existing?.count === 0, 'unversioned SQLite schema is not accepted');
      const initialize = this.#database.transaction(() => {
        this.#database.exec(`
          CREATE TABLE hyperliquid_recovery_metadata (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            schema_version INTEGER NOT NULL,
            current_journal_version_decimal TEXT,
            current_snapshot_hash TEXT
          ) STRICT;

          CREATE TABLE hyperliquid_recovery_snapshots (
            journal_version_decimal TEXT PRIMARY KEY,
            snapshot_hash TEXT NOT NULL UNIQUE,
            previous_snapshot_hash TEXT UNIQUE,
            journal_json TEXT NOT NULL,
            created_at_ms_decimal TEXT NOT NULL,
            FOREIGN KEY (previous_snapshot_hash)
              REFERENCES hyperliquid_recovery_snapshots(snapshot_hash)
          ) STRICT;

          CREATE TRIGGER hyperliquid_recovery_snapshot_no_update
          BEFORE UPDATE ON hyperliquid_recovery_snapshots
          BEGIN
            SELECT RAISE(ABORT, 'Hyperliquid recovery snapshots cannot be updated');
          END;

          CREATE TRIGGER hyperliquid_recovery_snapshot_no_delete
          BEFORE DELETE ON hyperliquid_recovery_snapshots
          BEGIN
            SELECT RAISE(ABORT, 'Hyperliquid recovery snapshots cannot be deleted');
          END;
        `);
        this.#database.prepare(`
          INSERT INTO hyperliquid_recovery_metadata (
            singleton, schema_version, current_journal_version_decimal, current_snapshot_hash
          ) VALUES (1, ?, NULL, NULL)
        `).run(SCHEMA_VERSION);
        this.#database.pragma(`user_version = ${SCHEMA_VERSION}`);
      });
      initialize.exclusive();
    } else {
      requireCondition(userVersion === SCHEMA_VERSION,
        `unsupported Hyperliquid recovery schema version ${userVersion}`);
    }
    const metadata = this.#metadata();
    requireCondition(metadata.schema_version === SCHEMA_VERSION,
      'journal metadata schema version differs');
  }

  #metadata(): MetadataRow {
    const row = this.#database.prepare<[], MetadataRow>(`
      SELECT schema_version, current_journal_version_decimal, current_snapshot_hash
      FROM hyperliquid_recovery_metadata WHERE singleton = 1
    `).get();
    requireCondition(row !== undefined, 'journal metadata is missing');
    if (row.current_snapshot_hash !== null) {
      hash(row.current_snapshot_hash, 'current snapshot hash');
      requireCondition(row.current_journal_version_decimal !== null,
        'current journal version is missing');
      decodedVersion(row.current_journal_version_decimal, 'current journal version');
    }
    return row;
  }

  #requireOpen(): void {
    requireCondition(!this.#closed, 'store is closed');
  }
}
