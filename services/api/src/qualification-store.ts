import type Database from "better-sqlite3";
import {
  checkQualificationAppend,
  currentQualification,
  parseProtocolJson,
  qualificationRecord,
  qualificationRecordHash,
  stringifyProtocolJson,
  toHex,
} from "@naryx/protocol-types";
import type {
  QualificationObjectType,
  QualificationRecord,
  QualificationRecordInput,
  QualificationUnavailable,
} from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import { verifyEd25519 } from "./ed25519.js";

export class QualificationStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "QualificationStoreError";
    this.code = code;
  }
}

const MAX_HISTORY = 500;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS qualification_records (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  record_hash BLOB NOT NULL UNIQUE,
  record_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS qualification_records_by_object ON qualification_records(object_type, object_id, cursor);
CREATE TRIGGER IF NOT EXISTS reject_qualification_change BEFORE UPDATE ON qualification_records BEGIN SELECT RAISE(ABORT, 'qualification records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_qualification_delete BEFORE DELETE ON qualification_records BEGIN SELECT RAISE(ABORT, 'qualification records are append-only'); END;
`;

export interface StoredQualificationRecord {
  readonly record: QualificationRecord;
  readonly recordHashHex: string;
  readonly recordedAtMs: number;
}

/**
 * The append-only qualification history of every instrument, venue, adapter, template, settlement
 * class, delivery path, solver, and execution class. A record is appended only with a valid
 * Ed25519 signature from a configured authority over its hash, and only when the kernel accepts it
 * as the next link of that object's chain: monitors tighten at once, and anything that loosens is
 * a reviewed activation taking effect no earlier than the activation delay.
 */
export class SqliteQualificationStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;
  private readonly authorities: ReadonlyMap<string, Uint8Array>;
  private readonly minimumActivationDelay: bigint;

  constructor(
    dbPath: string,
    options: { readonly authorities: ReadonlyMap<string, Uint8Array>; readonly minimumActivationDelay: bigint; readonly clock?: () => number },
  ) {
    if (options.authorities.size === 0) throw new QualificationStoreError("INVALID_CONFIGURATION", "At least one qualification authority key is required.");
    for (const key of options.authorities.values()) {
      if (!(key instanceof Uint8Array) || key.length !== 32) throw new QualificationStoreError("INVALID_CONFIGURATION", "Authority keys are 32-byte Ed25519 keys.");
    }
    if (typeof options.minimumActivationDelay !== "bigint" || options.minimumActivationDelay < 0n) {
      throw new QualificationStoreError("INVALID_CONFIGURATION", "The activation delay must be a nonnegative integer.");
    }
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new QualificationStoreError(code, message));
    this.clock = options.clock ?? Date.now;
    this.authorities = options.authorities;
    this.minimumActivationDelay = options.minimumActivationDelay;
  }

  close(): void {
    this.db.close();
  }

  private rawHistory(objectType: string, objectId: string): QualificationRecordInput[] {
    const rows = this.db
      .prepare("SELECT record_hash, record_json FROM qualification_records WHERE object_type = ? AND object_id = ? ORDER BY cursor LIMIT ?")
      .all(objectType, objectId, MAX_HISTORY) as { record_hash: Uint8Array; record_json: string }[];
    return rows.map((row) => {
      const input = parseProtocolJson(row.record_json) as QualificationRecordInput;
      // Stored records are re-hashed on every read; a modified row is reported, never served.
      if (toHex(qualificationRecordHash(input)) !== toHex(row.record_hash)) {
        throw new QualificationStoreError("CORRUPT_ROW", "A stored qualification record does not match its hash.");
      }
      return input;
    });
  }

  /** Appends the next record of an object's history. A repeat of the latest record is idempotent. */
  append(input: QualificationRecordInput): { readonly recordHashHex: string; readonly replayed: boolean } {
    let record: QualificationRecord;
    try {
      record = qualificationRecord(input);
    } catch (error) {
      throw new QualificationStoreError("INVALID_RECORD", `The qualification record is invalid: ${(error as Error).message}`);
    }
    const hash = qualificationRecordHash(record);
    const key = this.authorities.get(record.authority);
    if (key === undefined) throw new QualificationStoreError("UNKNOWN_AUTHORITY", "The record names no configured qualification authority.");
    if (!verifyEd25519(key, hash, record.signature)) throw new QualificationStoreError("INVALID_SIGNATURE", "The authority signature does not cover this record.");
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT 1 FROM qualification_records WHERE record_hash = ?").get(hash);
      if (existing !== undefined) return { recordHashHex: toHex(hash), replayed: true };
      const history = this.rawHistory(record.objectType, record.objectId);
      if (history.length >= MAX_HISTORY) throw new QualificationStoreError("HISTORY_FULL", "This object's qualification history is full.");
      const verdict = checkQualificationAppend(history, record, this.minimumActivationDelay);
      if (!verdict.accepted) throw new QualificationStoreError(verdict.reason, `The record cannot follow this object's history: ${verdict.reason}.`);
      this.db
        .prepare("INSERT INTO qualification_records (object_type, object_id, record_hash, record_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?)")
        .run(record.objectType, record.objectId, hash, stringifyProtocolJson(record), this.clock());
      return { recordHashHex: toHex(hash), replayed: false };
    }).immediate();
  }

  history(objectType: QualificationObjectType, objectId: string): readonly StoredQualificationRecord[] {
    const rows = this.db
      .prepare("SELECT record_hash, record_json, recorded_at_ms FROM qualification_records WHERE object_type = ? AND object_id = ? ORDER BY cursor LIMIT ?")
      .all(objectType, objectId, MAX_HISTORY) as { record_hash: Uint8Array; record_json: string; recorded_at_ms: number }[];
    return Object.freeze(
      rows.map((row) => {
        const record = qualificationRecord(parseProtocolJson(row.record_json) as QualificationRecordInput);
        if (toHex(qualificationRecordHash(record)) !== toHex(row.record_hash)) {
          throw new QualificationStoreError("CORRUPT_ROW", "A stored qualification record does not match its hash.");
        }
        return Object.freeze({ record, recordHashHex: toHex(row.record_hash), recordedAtMs: row.recorded_at_ms });
      }),
    );
  }

  /** The record governing an object now, in its own time unit, or why none does. */
  current(
    objectType: QualificationObjectType,
    objectId: string,
    nowIn: (unit: string) => bigint | undefined,
  ): { readonly current: StoredQualificationRecord; readonly asOfValue: bigint } | { readonly unavailable: QualificationUnavailable | "TIME_UNIT_UNSUPPORTED" } {
    const history = this.history(objectType, objectId);
    const last = history[history.length - 1];
    if (last === undefined) return { unavailable: "NO_RECORD" };
    const now = nowIn(last.record.timeUnit);
    if (now === undefined) return { unavailable: "TIME_UNIT_UNSUPPORTED" };
    const verdict = currentQualification(history.map((entry) => entry.record), now);
    if ("unavailable" in verdict) return { unavailable: verdict.unavailable };
    return { current: history[verdict.index] as StoredQualificationRecord, asOfValue: now };
  }
}
