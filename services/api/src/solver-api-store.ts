import type Database from "better-sqlite3";
import {
  admitShardUpdate,
  commitSolverCapacity,
  openSolverCapacityLedger,
  packageQuoteShard,
  packageQuoteShardHash,
  parseProtocolJson,
  refreshSolverCapacity,
  releaseSolverCapacity,
  solverCapacityRecord,
  solverCapacityStatus,
  stringifyProtocolJson,
  toHex,
} from "@naryx/protocol-types";
import type {
  PackageQuoteShard,
  PackageQuoteShardInput,
  ShardUpdateRejection,
  SolverCapacityCommitmentInput,
  SolverCapacityLedger,
  SolverCapacityRecordInput,
  SolverCapacityRejection,
  SolverCapacityStatus,
} from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";

export class SolverApiStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SolverApiStoreError";
    this.code = code;
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS solver_request_nonces (
  solver_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  seen_at_ms INTEGER NOT NULL,
  PRIMARY KEY (solver_id, nonce)
) STRICT;
CREATE INDEX IF NOT EXISTS solver_request_nonces_by_time ON solver_request_nonces(seen_at_ms);
CREATE TABLE IF NOT EXISTS quote_shards (
  solver_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  market_group_id TEXT NOT NULL,
  shard_hash BLOB NOT NULL,
  shard_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (solver_id, shard_id)
) STRICT;
CREATE INDEX IF NOT EXISTS quote_shards_by_market ON quote_shards(market_group_id);
CREATE TABLE IF NOT EXISTS quote_shard_history (
  shard_hash BLOB PRIMARY KEY,
  solver_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  shard_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS solver_capacity (
  solver_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  ledger_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (solver_id, scope)
) STRICT;
CREATE TRIGGER IF NOT EXISTS reject_shard_history_change BEFORE UPDATE ON quote_shard_history BEGIN SELECT RAISE(ABORT, 'shard history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_shard_history_delete BEFORE DELETE ON quote_shard_history BEGIN SELECT RAISE(ABORT, 'shard history is append-only'); END;
`;

/**
 * A shard's identity inside its solver: the template and market group it quotes. The template id
 * may not contain the separator, so the first dot always splits the two parts unambiguously.
 */
export function shardIdOf(shard: Pick<PackageQuoteShard, "templateId" | "marketGroupId">): string {
  if (shard.templateId.includes(".")) {
    throw new SolverApiStoreError("INVALID_SHARD_ID", "A quoted template id may not contain a dot.");
  }
  return `${shard.templateId}.${shard.marketGroupId}`;
}

// A JSON tuple keeps the scope unambiguous whatever characters the identifiers contain.
function capacityScope(record: SolverCapacityRecordInput): string {
  return JSON.stringify([record.domain.domainId, record.domain.domainManifestVersion, record.asset.assetId]);
}

/**
 * Durable state behind the authenticated solver API: single-use request nonces, each solver's
 * current quote shards with append-only history, and per-scope capacity ledgers. Every mutation
 * runs the kernel rule inside one immediate transaction.
 */
export class SqliteSolverApiStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;

  constructor(dbPath: string, options: { readonly clock?: () => number } = {}) {
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new SolverApiStoreError(code, message));
    this.clock = options.clock ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }

  /** Records a request nonce; returns false when the solver already used it inside the retention window. */
  consumeNonce(solverId: string, nonce: Uint8Array, retentionMs: number): boolean {
    return this.transaction(() => {
      const now = this.clock();
      this.db.prepare("DELETE FROM solver_request_nonces WHERE seen_at_ms < ?").run(now - retentionMs);
      const result = this.db
        .prepare("INSERT OR IGNORE INTO solver_request_nonces (solver_id, nonce, seen_at_ms) VALUES (?, ?, ?)")
        .run(solverId, nonce, now);
      return result.changes === 1;
    });
  }

  /** Admits a signed shard update after the caller verified the signature and the owning solver. */
  admitShard(
    solverId: string,
    next: PackageQuoteShardInput,
  ): { readonly accepted: true; readonly duplicate: boolean; readonly shard: PackageQuoteShard; readonly shardHashHex: string } | { readonly accepted: false; readonly reason: ShardUpdateRejection } {
    const shard = packageQuoteShard(next);
    if (shard.solverId !== solverId) throw new SolverApiStoreError("NOT_OWNER", "A solver can only update its own shards.");
    const shardId = shardIdOf(shard);
    return this.transaction(() => {
      const current = this.getShard(solverId, shardId);
      const result = admitShardUpdate(current, shard);
      if (!result.accepted) return result;
      const hash = packageQuoteShardHash(result.shard);
      if (!result.duplicate) {
        const json = stringifyProtocolJson(result.shard);
        const now = this.clock();
        this.db
          .prepare(
            `INSERT INTO quote_shards (solver_id, shard_id, market_group_id, shard_hash, shard_json, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (solver_id, shard_id) DO UPDATE SET shard_hash = excluded.shard_hash, shard_json = excluded.shard_json, updated_at_ms = excluded.updated_at_ms`,
          )
          .run(solverId, shardId, shard.marketGroupId, hash, json, now);
        this.db
          .prepare("INSERT OR IGNORE INTO quote_shard_history (shard_hash, solver_id, shard_id, shard_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?)")
          .run(hash, solverId, shardId, json, now);
      }
      return { accepted: true as const, duplicate: result.duplicate, shard: result.shard, shardHashHex: toHex(hash) };
    });
  }

  getShard(solverId: string, shardId: string): PackageQuoteShard | undefined {
    const row = this.db.prepare("SELECT shard_json FROM quote_shards WHERE solver_id = ? AND shard_id = ?").get(solverId, shardId) as
      | { shard_json: string }
      | undefined;
    return row === undefined ? undefined : packageQuoteShard(parseProtocolJson(row.shard_json) as PackageQuoteShardInput);
  }

  /** Every solver's current shard for one market group, revalidated. Liveness is judged by the caller. */
  shardsForMarket(marketGroupId: string): readonly { readonly shard: PackageQuoteShard; readonly shardHashHex: string }[] {
    const rows = this.db
      .prepare("SELECT shard_json FROM quote_shards WHERE market_group_id = ? ORDER BY solver_id, shard_id LIMIT 500")
      .all(marketGroupId) as { shard_json: string }[];
    return Object.freeze(
      rows.map((row) => {
        const shard = packageQuoteShard(parseProtocolJson(row.shard_json) as PackageQuoteShardInput);
        return Object.freeze({ shard, shardHashHex: toHex(packageQuoteShardHash(shard)) });
      }),
    );
  }

  private ledger(solverId: string, scope: string): SolverCapacityLedger | undefined {
    const row = this.db.prepare("SELECT ledger_json FROM solver_capacity WHERE solver_id = ? AND scope = ?").get(solverId, scope) as
      | { ledger_json: string }
      | undefined;
    if (row === undefined) return undefined;
    const ledger = parseProtocolJson(row.ledger_json) as SolverCapacityLedger;
    return { record: solverCapacityRecord(ledger.record), commitments: ledger.commitments };
  }

  private writeLedger(solverId: string, scope: string, ledger: SolverCapacityLedger): void {
    this.db
      .prepare(
        `INSERT INTO solver_capacity (solver_id, scope, ledger_json, updated_at_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT (solver_id, scope) DO UPDATE SET ledger_json = excluded.ledger_json, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(solverId, scope, stringifyProtocolJson(ledger), this.clock());
  }

  /** Publishes fresh capacity evidence; outstanding commitments carry over and may force wind-down. */
  putCapacity(solverId: string, record: SolverCapacityRecordInput): void {
    const checked = solverCapacityRecord(record);
    if (checked.solverId !== solverId) throw new SolverApiStoreError("NOT_OWNER", "A solver can only publish its own capacity.");
    const scope = capacityScope(checked);
    this.transaction(() => {
      const current = this.ledger(solverId, scope);
      this.writeLedger(solverId, scope, current === undefined ? openSolverCapacityLedger(checked) : refreshSolverCapacity(current, checked));
    });
  }

  commitCapacity(
    solverId: string,
    record: Pick<SolverCapacityRecordInput, "domain" | "asset">,
    commitment: SolverCapacityCommitmentInput,
  ): { readonly accepted: true; readonly status: SolverCapacityStatus } | { readonly accepted: false; readonly rejection: SolverCapacityRejection | "NO_CAPACITY_EVIDENCE" } {
    const scope = capacityScope(record as SolverCapacityRecordInput);
    return this.transaction(() => {
      const current = this.ledger(solverId, scope);
      if (current === undefined) return { accepted: false as const, rejection: "NO_CAPACITY_EVIDENCE" as const };
      const result = commitSolverCapacity(current, commitment);
      if (!result.accepted) return result;
      this.writeLedger(solverId, scope, result.ledger);
      return { accepted: true as const, status: solverCapacityStatus(result.ledger, commitment.atValue) };
    });
  }

  releaseCapacity(solverId: string, record: Pick<SolverCapacityRecordInput, "domain" | "asset">, commitmentId: Uint8Array | string): void {
    const scope = capacityScope(record as SolverCapacityRecordInput);
    this.transaction(() => {
      const current = this.ledger(solverId, scope);
      if (current === undefined) throw new SolverApiStoreError("NO_CAPACITY_EVIDENCE", "No capacity ledger exists for this scope.");
      this.writeLedger(solverId, scope, releaseSolverCapacity(current, commitmentId));
    });
  }

  /** Every capacity scope of one solver with its status at the given time. */
  capacityStatus(solverId: string, atValue: bigint): readonly { readonly scope: string; readonly record: SolverCapacityLedger["record"]; readonly status: SolverCapacityStatus }[] {
    const rows = this.db.prepare("SELECT scope FROM solver_capacity WHERE solver_id = ? ORDER BY scope").all(solverId) as { scope: string }[];
    return Object.freeze(
      rows.map((row) => {
        const ledger = this.ledger(solverId, row.scope) as SolverCapacityLedger;
        return Object.freeze({ scope: row.scope, record: ledger.record, status: solverCapacityStatus(ledger, atValue) });
      }),
    );
  }
}
