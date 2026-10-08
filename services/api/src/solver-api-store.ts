import type Database from "better-sqlite3";
import {
  admitShardUpdate,
  checkShardSettlement,
  commitSolverCapacity,
  openSolverCapacityLedger,
  packageQuoteShard,
  packageQuoteShardHash,
  parseProtocolJson,
  refreshSolverCapacity,
  releaseSolverCapacity,
  shardFillCommitment,
  solverCapacityRecord,
  solverCapacityStatus,
  stringifyProtocolJson,
  toHex,
} from "@naryx/protocol-types";
import type {
  PackageQuoteShard,
  PackageQuoteShardInput,
  QuoteReferenceStateInput,
  ShardSettlementRejection,
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
CREATE TABLE IF NOT EXISTS shard_fills (
  fill_commitment BLOB PRIMARY KEY,
  solver_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  shard_hash BLOB NOT NULL,
  level_id TEXT NOT NULL,
  size TEXT NOT NULL,
  fill_json TEXT NOT NULL,
  settled_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS shard_fills_by_state ON shard_fills(shard_hash, level_id);
CREATE INDEX IF NOT EXISTS shard_fills_by_shard ON shard_fills(solver_id, shard_id, settled_at_ms);
CREATE TRIGGER IF NOT EXISTS reject_shard_fill_change BEFORE UPDATE ON shard_fills BEGIN SELECT RAISE(ABORT, 'shard fills are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_shard_fill_delete BEFORE DELETE ON shard_fills BEGIN SELECT RAISE(ABORT, 'shard fills are append-only'); END;
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

  /**
   * The controller's settlement of one fill against an offchain shard level. Inside one
   * transaction it reads the solver's current signed shard, re-checks its signature with the
   * caller's verifier (a quote key may have been revoked since the shard was admitted), runs the
   * kernel settlement check with everything this ledger already filled against that exact signed
   * state, and records the fill under its commitment. The same fill settles once; a replay returns
   * the recorded fill, and nothing here trusts the price a caller names.
   */
  settleShardFill(
    solverId: string,
    shardId: string,
    request: {
      readonly boundShardHash: string;
      readonly referenceState: QuoteReferenceStateInput;
      readonly levelId: bigint;
      readonly takerSide: "BUY" | "SELL";
      readonly size: bigint;
      readonly fee: bigint;
      readonly atValue: bigint;
      readonly orderHash: string;
      readonly quoteHash: string;
      readonly routeHash: string;
    },
    verifySignature: (shard: PackageQuoteShard) => boolean,
  ):
    | { readonly settled: true; readonly replayed: boolean; readonly fillCommitmentHex: string; readonly priceTicks: bigint }
    | { readonly settled: false; readonly reason: ShardSettlementRejection | "SHARD_UNKNOWN" | "SIGNATURE_INVALID" } {
    return this.transaction(() => {
      const fillFor = (levelOffset: bigint) => {
        const priceTicks = request.referenceState.referencePriceTicks + levelOffset;
        const fill = {
          shardHash: request.boundShardHash,
          levelId: request.levelId,
          takerSide: request.takerSide,
          size: request.size,
          fee: request.fee,
          priceTicks,
          orderHash: request.orderHash,
          quoteHash: request.quoteHash,
          routeHash: request.routeHash,
        };
        return { fill, priceTicks, commitment: shardFillCommitment(fill) };
      };
      // A settled fill replays even after its solver moved the shard on: it is looked up against
      // the exact signed state it bound, before any check of the current state.
      const boundRow = this.db
        .prepare("SELECT shard_json FROM quote_shard_history WHERE shard_hash = ? AND solver_id = ? AND shard_id = ?")
        .get(Buffer.from(request.boundShardHash, "hex"), solverId, shardId) as { shard_json: string } | undefined;
      const boundLevel = boundRow === undefined
        ? undefined
        : packageQuoteShard(parseProtocolJson(boundRow.shard_json) as PackageQuoteShardInput).quoteLevels.find((entry) => entry.levelId === request.levelId);
      if (boundLevel !== undefined && typeof request.referenceState?.referencePriceTicks === "bigint") {
        const replay = fillFor(boundLevel.referenceOffset);
        if (this.db.prepare("SELECT 1 FROM shard_fills WHERE fill_commitment = ?").get(replay.commitment) !== undefined) {
          return { settled: true as const, replayed: true, fillCommitmentHex: toHex(replay.commitment), priceTicks: replay.priceTicks };
        }
      }
      const shard = this.getShard(solverId, shardId);
      if (shard === undefined) return { settled: false as const, reason: "SHARD_UNKNOWN" as const };
      if (!verifySignature(shard)) return { settled: false as const, reason: "SIGNATURE_INVALID" as const };
      const stateHash = packageQuoteShardHash(shard);
      const filled = this.db.prepare("SELECT level_id, size FROM shard_fills WHERE shard_hash = ?").all(stateHash) as { level_id: string; size: string }[];
      const shardFilledSize = filled.reduce((sum, row) => sum + BigInt(row.size), 0n);
      const levelFilledSize = filled.filter((row) => row.level_id === request.levelId.toString()).reduce((sum, row) => sum + BigInt(row.size), 0n);
      const checked = checkShardSettlement(shard, {
        boundShardHash: request.boundShardHash,
        referenceState: request.referenceState,
        levelId: request.levelId,
        takerSide: request.takerSide,
        size: request.size,
        fee: request.fee,
        atValue: request.atValue,
        levelFilledSize,
        shardFilledSize,
      });
      if (!checked.executable) return { settled: false as const, reason: checked.reason };
      // The check passed, so the bound state is the current one and the price is its committed price.
      const settled = fillFor(checked.priceTicks - request.referenceState.referencePriceTicks);
      this.db
        .prepare("INSERT INTO shard_fills (fill_commitment, solver_id, shard_id, shard_hash, level_id, size, fill_json, settled_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(settled.commitment, solverId, shardId, stateHash, request.levelId.toString(), request.size.toString(), stringifyProtocolJson(settled.fill), this.clock());
      return { settled: true as const, replayed: false, fillCommitmentHex: toHex(settled.commitment), priceTicks: settled.priceTicks };
    });
  }

  /** The fills settled against a solver's shard, newest first, so a maker can reconcile its inventory. */
  shardFills(solverId: string, shardId: string, limit = 100): readonly { readonly fillCommitment: string; readonly shardHash: string; readonly fill: unknown; readonly settledAtMs: number }[] {
    const rows = this.db
      .prepare("SELECT fill_commitment, shard_hash, fill_json, settled_at_ms FROM shard_fills WHERE solver_id = ? AND shard_id = ? ORDER BY settled_at_ms DESC, rowid DESC LIMIT ?")
      .all(solverId, shardId, Math.min(Math.max(1, limit), 500)) as { fill_commitment: Uint8Array; shard_hash: Uint8Array; fill_json: string; settled_at_ms: number }[];
    return rows.map((row) => Object.freeze({ fillCommitment: toHex(row.fill_commitment), shardHash: toHex(row.shard_hash), fill: parseProtocolJson(row.fill_json), settledAtMs: row.settled_at_ms }));
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

  /** Every current quote shard owned by one solver, ordered by its stable shard identity. */
  shardsForSolver(solverId: string): readonly { readonly shardId: string; readonly shard: PackageQuoteShard; readonly shardHashHex: string }[] {
    const rows = this.db
      .prepare("SELECT shard_id, shard_json FROM quote_shards WHERE solver_id = ? ORDER BY shard_id LIMIT 500")
      .all(solverId) as { shard_id: string; shard_json: string }[];
    return Object.freeze(
      rows.map((row) => {
        const shard = packageQuoteShard(parseProtocolJson(row.shard_json) as PackageQuoteShardInput);
        return Object.freeze({ shardId: row.shard_id, shard, shardHashHex: toHex(packageQuoteShardHash(shard)) });
      }),
    );
  }

  /** Fill totals for one exact signed shard state. Historical shard states never contaminate it. */
  shardFillSummary(
    solverId: string,
    shardId: string,
    shardHashHex: string,
  ): Readonly<{
    fillCount: number;
    filledSize: bigint;
    latestFillCommitment: string | null;
    latestSettledAtMs: number | null;
  }> {
    if (!/^[0-9a-f]{64}$/.test(shardHashHex)) {
      throw new SolverApiStoreError("INVALID_SHARD_HASH", "A shard hash must be 32 bytes of lowercase hex.");
    }
    const rows = this.db
      .prepare(
        `SELECT fill_commitment, size, settled_at_ms FROM shard_fills
         WHERE solver_id = ? AND shard_id = ? AND shard_hash = ?
         ORDER BY settled_at_ms DESC, rowid DESC`,
      )
      .all(solverId, shardId, Buffer.from(shardHashHex, "hex")) as {
        fill_commitment: Uint8Array;
        size: string;
        settled_at_ms: number;
      }[];
    return Object.freeze({
      fillCount: rows.length,
      filledSize: rows.reduce((sum, row) => sum + BigInt(row.size), 0n),
      latestFillCommitment: rows[0] === undefined ? null : toHex(rows[0].fill_commitment),
      latestSettledAtMs: rows[0]?.settled_at_ms ?? null,
    });
  }

  /**
   * Every commitment the solver holds in a capacity ledger that is healthy at `atValue`, keyed by
   * lowercase hex id. Commitments in expired or over-committed ledgers back nothing.
   */
  outstandingCommitments(solverId: string, atValue: bigint): ReadonlyMap<string, { readonly firm: boolean; readonly atoms: bigint }> {
    const rows = this.db.prepare("SELECT ledger_json FROM solver_capacity WHERE solver_id = ?").all(solverId) as { ledger_json: string }[];
    const outstanding = new Map<string, { readonly firm: boolean; readonly atoms: bigint }>();
    for (const row of rows) {
      const stored = parseProtocolJson(row.ledger_json) as SolverCapacityLedger;
      const ledger = { record: solverCapacityRecord(stored.record), commitments: stored.commitments };
      if (solverCapacityStatus(ledger, atValue).state !== "ACTIVE") continue;
      for (const commitment of ledger.commitments) outstanding.set(toHex(commitment.commitmentId), { firm: commitment.firm, atoms: commitment.atoms });
    }
    return outstanding;
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
