import type Database from "better-sqlite3";
import {
  parseProtocolJson,
  positionSnapshotRecord,
  positionSnapshotRecordHash,
  stringifyProtocolJson,
  toHex,
} from "@naryx/protocol-types";
import type { PositionSnapshotRecord, PositionSnapshotRecordInput } from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import { verifyEd25519 } from "./ed25519.js";

export class PositionSnapshotStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PositionSnapshotStoreError";
    this.code = code;
  }
}

const DEFAULT_MAXIMUM_OBSERVATION_SKEW_MS = 300_000;
const MAX_SOURCES_PER_ACCOUNT = 16;
const MAX_ACCOUNTS_PER_RISK_DOMAIN = 500;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS position_snapshots (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  record_hash BLOB NOT NULL UNIQUE,
  strategy_account TEXT NOT NULL,
  source_id TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS position_snapshots_by_account ON position_snapshots(strategy_account, source_id, cursor);
CREATE TABLE IF NOT EXISTS position_snapshot_risk_domains (
  record_hash BLOB NOT NULL REFERENCES position_snapshots(record_hash),
  risk_domain_id TEXT NOT NULL,
  strategy_account TEXT NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY (record_hash, risk_domain_id)
) STRICT;
CREATE INDEX IF NOT EXISTS position_snapshot_risk_domains_by_domain ON position_snapshot_risk_domains(risk_domain_id, strategy_account, source_id);
CREATE TRIGGER IF NOT EXISTS reject_position_snapshot_change BEFORE UPDATE ON position_snapshots BEGIN SELECT RAISE(ABORT, 'position snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_position_snapshot_delete BEFORE DELETE ON position_snapshots BEGIN SELECT RAISE(ABORT, 'position snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_position_domain_change BEFORE UPDATE ON position_snapshot_risk_domains BEGIN SELECT RAISE(ABORT, 'position snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_position_domain_delete BEFORE DELETE ON position_snapshot_risk_domains BEGIN SELECT RAISE(ABORT, 'position snapshots are append-only'); END;
`;

export interface StoredPositionSnapshot {
  readonly record: PositionSnapshotRecord;
  readonly recordHashHex: string;
  readonly recordedAtMs: number;
}

/**
 * Signed, read-only position observations of strategy accounts, one stream per account and
 * source. A snapshot is appended only with a valid Ed25519 signature from a configured position
 * authority over its hash, only when observed within the skew of server time, and only when it
 * is newer than the latest snapshot of its stream. Snapshots grant no authority over positions.
 */
export class SqlitePositionSnapshotStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;
  private readonly authorities: ReadonlyMap<string, Uint8Array>;
  private readonly maximumObservationSkewMs: number;

  constructor(
    dbPath: string,
    options: { readonly authorities: ReadonlyMap<string, Uint8Array>; readonly clock?: () => number; readonly maximumObservationSkewMs?: number },
  ) {
    if (options.authorities.size === 0) throw new PositionSnapshotStoreError("INVALID_CONFIGURATION", "At least one position authority key is required.");
    for (const key of options.authorities.values()) {
      if (!(key instanceof Uint8Array) || key.length !== 32) throw new PositionSnapshotStoreError("INVALID_CONFIGURATION", "Authority keys are 32-byte Ed25519 keys.");
    }
    const skew = options.maximumObservationSkewMs ?? DEFAULT_MAXIMUM_OBSERVATION_SKEW_MS;
    if (!Number.isSafeInteger(skew) || skew < 1_000) throw new PositionSnapshotStoreError("INVALID_CONFIGURATION", "The observation skew must be at least one second.");
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new PositionSnapshotStoreError(code, message));
    this.clock = options.clock ?? Date.now;
    this.authorities = options.authorities;
    this.maximumObservationSkewMs = skew;
  }

  close(): void {
    this.db.close();
  }

  now(): number {
    return this.clock();
  }

  /** Appends the next snapshot of an account's source stream. A repeat of a stored snapshot is idempotent. */
  append(input: PositionSnapshotRecordInput): { readonly recordHashHex: string; readonly replayed: boolean } {
    let record: PositionSnapshotRecord;
    try {
      record = positionSnapshotRecord(input);
    } catch (error) {
      throw new PositionSnapshotStoreError("INVALID_RECORD", `The position snapshot is invalid: ${(error as Error).message}`);
    }
    const hash = positionSnapshotRecordHash(record);
    const key = this.authorities.get(record.authority);
    if (key === undefined) throw new PositionSnapshotStoreError("UNKNOWN_AUTHORITY", "The snapshot names no configured position authority.");
    if (!verifyEd25519(key, hash, record.signature)) throw new PositionSnapshotStoreError("INVALID_SIGNATURE", "The authority signature does not cover this snapshot.");
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM position_snapshots WHERE record_hash = ?").get(hash) !== undefined) {
        return { recordHashHex: toHex(hash), replayed: true };
      }
      const now = BigInt(Math.floor(this.clock()));
      const skew = BigInt(this.maximumObservationSkewMs);
      if (record.observedAtMs > now + skew || record.observedAtMs + skew < now) {
        throw new PositionSnapshotStoreError("OBSERVATION_OUT_OF_WINDOW", "The snapshot's observation time is not within the allowed skew of server time.");
      }
      const latest = this.db
        .prepare("SELECT observed_at_ms FROM position_snapshots WHERE strategy_account = ? AND source_id = ? ORDER BY cursor DESC LIMIT 1")
        .get(record.strategyAccount, record.sourceId) as { observed_at_ms: number } | undefined;
      if (latest !== undefined && BigInt(latest.observed_at_ms) >= record.observedAtMs) {
        throw new PositionSnapshotStoreError("STALE_SNAPSHOT", "A snapshot of this account and source observed at the same time or later is already stored.");
      }
      const sources = this.db.prepare("SELECT COUNT(DISTINCT source_id) AS count FROM position_snapshots WHERE strategy_account = ?").get(record.strategyAccount) as { count: number };
      if (latest === undefined && sources.count >= MAX_SOURCES_PER_ACCOUNT) {
        throw new PositionSnapshotStoreError("SOURCES_FULL", "This account already has the maximum number of position sources.");
      }
      this.db
        .prepare("INSERT INTO position_snapshots (record_hash, strategy_account, source_id, observed_at_ms, record_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?)")
        .run(hash, record.strategyAccount, record.sourceId, Number(record.observedAtMs), stringifyProtocolJson(record), this.clock());
      const domain = this.db.prepare(
        "INSERT OR IGNORE INTO position_snapshot_risk_domains (record_hash, risk_domain_id, strategy_account, source_id) VALUES (?, ?, ?, ?)",
      );
      for (const riskDomainId of new Set(record.positions.map((position) => position.riskDomainId))) {
        domain.run(hash, riskDomainId, record.strategyAccount, record.sourceId);
      }
      return { recordHashHex: toHex(hash), replayed: false };
    }).immediate();
  }

  private decode(row: { record_hash: Uint8Array; record_json: string; recorded_at_ms: number }): StoredPositionSnapshot {
    const record = positionSnapshotRecord(parseProtocolJson(row.record_json) as PositionSnapshotRecordInput);
    if (toHex(positionSnapshotRecordHash(record)) !== toHex(row.record_hash)) {
      throw new PositionSnapshotStoreError("CORRUPT_ROW", "A stored position snapshot does not match its hash.");
    }
    return Object.freeze({ record, recordHashHex: toHex(row.record_hash), recordedAtMs: row.recorded_at_ms });
  }

  private latestFor(strategyAccount: string, sourceId: string): StoredPositionSnapshot | undefined {
    const row = this.db
      .prepare("SELECT record_hash, record_json, recorded_at_ms FROM position_snapshots WHERE strategy_account = ? AND source_id = ? ORDER BY cursor DESC LIMIT 1")
      .get(strategyAccount, sourceId) as { record_hash: Uint8Array; record_json: string; recorded_at_ms: number } | undefined;
    return row === undefined ? undefined : this.decode(row);
  }

  /** The latest snapshot of each source for one account, ordered by source. */
  latest(strategyAccount: string): readonly StoredPositionSnapshot[] {
    const sources = this.db
      .prepare("SELECT DISTINCT source_id FROM position_snapshots WHERE strategy_account = ? ORDER BY source_id LIMIT ?")
      .all(strategyAccount, MAX_SOURCES_PER_ACCOUNT) as { source_id: string }[];
    return Object.freeze(sources.map((row) => this.latestFor(strategyAccount, row.source_id)).filter((entry): entry is StoredPositionSnapshot => entry !== undefined));
  }

  /**
   * The latest snapshot of every account and source that has ever held a position in the risk
   * domain. A latest snapshot that no longer holds one is included, so a closed position shows as
   * closed rather than as its last open state.
   */
  riskDomain(riskDomainId: string): readonly StoredPositionSnapshot[] {
    const streams = this.db
      .prepare("SELECT DISTINCT strategy_account, source_id FROM position_snapshot_risk_domains WHERE risk_domain_id = ? ORDER BY strategy_account, source_id LIMIT ?")
      .all(riskDomainId, MAX_ACCOUNTS_PER_RISK_DOMAIN) as { strategy_account: string; source_id: string }[];
    return Object.freeze(
      streams.map((row) => this.latestFor(row.strategy_account, row.source_id)).filter((entry): entry is StoredPositionSnapshot => entry !== undefined),
    );
  }
}
