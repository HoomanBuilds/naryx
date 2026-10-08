import type Database from "better-sqlite3";
import {
  collateralSnapshot,
  collateralSnapshotHash,
  parseProtocolJson,
  stringifyProtocolJson,
  toHex,
} from "@naryx/protocol-types";
import type { CollateralSnapshot, CollateralSnapshotInput } from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import { verifyEd25519 } from "./ed25519.js";

export class CollateralSnapshotStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CollateralSnapshotStoreError";
    this.code = code;
  }
}

const DEFAULT_MAXIMUM_OBSERVATION_SKEW_MS = 300_000;
const MAX_STREAMS_PER_ACCOUNT = 64;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS collateral_snapshots (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  record_hash BLOB NOT NULL UNIQUE,
  environment TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  authority TEXT NOT NULL,
  strategy_account TEXT NOT NULL,
  source_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_manifest_hash BLOB NOT NULL,
  risk_domain_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (environment, authority, snapshot_id)
) STRICT;
CREATE INDEX IF NOT EXISTS collateral_snapshots_by_account ON collateral_snapshots(
  strategy_account, source_id, asset_id, asset_manifest_hash, risk_domain_id, mode, cursor
);
CREATE TRIGGER IF NOT EXISTS reject_collateral_snapshot_change BEFORE UPDATE ON collateral_snapshots BEGIN SELECT RAISE(ABORT, 'collateral snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_collateral_snapshot_delete BEFORE DELETE ON collateral_snapshots BEGIN SELECT RAISE(ABORT, 'collateral snapshots are append-only'); END;
`;

export interface StoredCollateralSnapshot {
  readonly record: CollateralSnapshot;
  readonly recordHashHex: string;
  readonly recordedAtMs: number;
}

export class SqliteCollateralSnapshotStore {
  private readonly db: Database.Database;
  private readonly environment: string;
  private readonly clock: () => number;
  private readonly authorities: ReadonlyMap<string, Uint8Array>;
  private readonly maximumObservationSkewMs: number;

  constructor(
    dbPath: string,
    options: {
      readonly environment: string;
      readonly authorities: ReadonlyMap<string, Uint8Array>;
      readonly clock?: () => number;
      readonly maximumObservationSkewMs?: number;
    },
  ) {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(options.environment)) {
      throw new CollateralSnapshotStoreError("INVALID_CONFIGURATION", "The collateral environment is invalid.");
    }
    if (options.environment.toLowerCase().includes("mainnet")) {
      throw new CollateralSnapshotStoreError("INVALID_CONFIGURATION", "Collateral snapshot writes are disabled for mainnet environments.");
    }
    if (options.authorities.size === 0) {
      throw new CollateralSnapshotStoreError("INVALID_CONFIGURATION", "At least one collateral authority key is required.");
    }
    for (const key of options.authorities.values()) {
      if (!(key instanceof Uint8Array) || key.length !== 32) {
        throw new CollateralSnapshotStoreError("INVALID_CONFIGURATION", "Authority keys are 32-byte Ed25519 keys.");
      }
    }
    const skew = options.maximumObservationSkewMs ?? DEFAULT_MAXIMUM_OBSERVATION_SKEW_MS;
    if (!Number.isSafeInteger(skew) || skew < 1_000) {
      throw new CollateralSnapshotStoreError("INVALID_CONFIGURATION", "The observation skew must be at least one second.");
    }
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new CollateralSnapshotStoreError(code, message));
    this.environment = options.environment;
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

  append(input: CollateralSnapshotInput): { readonly recordHashHex: string; readonly replayed: boolean } {
    let record: CollateralSnapshot;
    try {
      record = collateralSnapshot(input);
    } catch (error) {
      throw new CollateralSnapshotStoreError("INVALID_RECORD", `The collateral snapshot is invalid: ${(error as Error).message}`);
    }
    if (record.environment !== this.environment) {
      throw new CollateralSnapshotStoreError("WRONG_ENVIRONMENT", "The collateral snapshot belongs to another environment.");
    }
    const hash = collateralSnapshotHash(record);
    const key = this.authorities.get(record.authority);
    if (key === undefined) {
      throw new CollateralSnapshotStoreError("UNKNOWN_AUTHORITY", "The snapshot names no configured collateral authority.");
    }
    if (!verifyEd25519(key, hash, record.signature)) {
      throw new CollateralSnapshotStoreError("INVALID_SIGNATURE", "The authority signature does not cover this collateral snapshot.");
    }
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM collateral_snapshots WHERE record_hash = ?").get(hash) !== undefined) {
        return { recordHashHex: toHex(hash), replayed: true };
      }
      const existingId = this.db
        .prepare("SELECT 1 FROM collateral_snapshots WHERE environment = ? AND authority = ? AND snapshot_id = ?")
        .get(record.environment, record.authority, record.snapshotId);
      if (existingId !== undefined) {
        throw new CollateralSnapshotStoreError("SNAPSHOT_ID_CONFLICT", "This authority already used the collateral snapshot id for different content.");
      }
      const now = BigInt(Math.floor(this.clock()));
      const skew = BigInt(this.maximumObservationSkewMs);
      if (record.observedAtMs > now + skew || record.observedAtMs + skew < now) {
        throw new CollateralSnapshotStoreError("OBSERVATION_OUT_OF_WINDOW", "The snapshot's observation time is not within the allowed skew of server time.");
      }
      const streamValues = [
        record.strategyAccount,
        record.sourceId,
        record.asset.assetId,
        record.asset.assetManifestHash,
        record.riskDomainId,
        record.mode,
      ] as const;
      const latest = this.db.prepare(`
        SELECT observed_at_ms FROM collateral_snapshots
        WHERE strategy_account = ? AND source_id = ? AND asset_id = ? AND asset_manifest_hash = ?
          AND risk_domain_id = ? AND mode = ?
        ORDER BY cursor DESC LIMIT 1
      `).get(...streamValues) as { observed_at_ms: number } | undefined;
      if (latest !== undefined && BigInt(latest.observed_at_ms) >= record.observedAtMs) {
        throw new CollateralSnapshotStoreError("STALE_SNAPSHOT", "A snapshot of this collateral stream observed at the same time or later is already stored.");
      }
      const streams = this.db.prepare(`
        SELECT COUNT(*) AS count FROM (
          SELECT 1 FROM collateral_snapshots WHERE strategy_account = ?
          GROUP BY source_id, asset_id, asset_manifest_hash, risk_domain_id, mode
        )
      `).get(record.strategyAccount) as { count: number };
      if (latest === undefined && streams.count >= MAX_STREAMS_PER_ACCOUNT) {
        throw new CollateralSnapshotStoreError("STREAMS_FULL", "This account already has the maximum number of collateral streams.");
      }
      this.db.prepare(`
        INSERT INTO collateral_snapshots (
          record_hash, environment, snapshot_id, authority, strategy_account, source_id,
          asset_id, asset_manifest_hash, risk_domain_id, mode, observed_at_ms, record_json, recorded_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        hash,
        record.environment,
        record.snapshotId,
        record.authority,
        record.strategyAccount,
        record.sourceId,
        record.asset.assetId,
        record.asset.assetManifestHash,
        record.riskDomainId,
        record.mode,
        Number(record.observedAtMs),
        stringifyProtocolJson(record),
        this.clock(),
      );
      return { recordHashHex: toHex(hash), replayed: false };
    }).immediate();
  }

  private decode(row: { record_hash: Uint8Array; record_json: string; recorded_at_ms: number }): StoredCollateralSnapshot {
    const record = collateralSnapshot(parseProtocolJson(row.record_json) as CollateralSnapshotInput);
    if (record.environment !== this.environment || toHex(collateralSnapshotHash(record)) !== toHex(row.record_hash)) {
      throw new CollateralSnapshotStoreError("CORRUPT_ROW", "A stored collateral snapshot does not match its environment or hash.");
    }
    return Object.freeze({ record, recordHashHex: toHex(row.record_hash), recordedAtMs: row.recorded_at_ms });
  }

  latest(strategyAccount: string): readonly StoredCollateralSnapshot[] {
    const rows = this.db.prepare(`
      SELECT snapshot.record_hash, snapshot.record_json, snapshot.recorded_at_ms
      FROM collateral_snapshots AS snapshot
      JOIN (
        SELECT MAX(cursor) AS cursor FROM collateral_snapshots
        WHERE strategy_account = ?
        GROUP BY source_id, asset_id, asset_manifest_hash, risk_domain_id, mode
      ) AS latest ON latest.cursor = snapshot.cursor
      ORDER BY snapshot.source_id, snapshot.asset_id, snapshot.risk_domain_id, snapshot.mode
      LIMIT ?
    `).all(strategyAccount, MAX_STREAMS_PER_ACCOUNT) as {
      record_hash: Uint8Array;
      record_json: string;
      recorded_at_ms: number;
    }[];
    return Object.freeze(rows.map((row) => this.decode(row)));
  }
}
