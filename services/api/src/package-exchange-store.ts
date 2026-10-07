import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  addImpliedLiquidity,
  amendPackageBookEntry,
  bytesEqual,
  cancelPackageBookEntry,
  commitmentHash,
  economicStrategySeries,
  economicStrategySeriesBytes,
  economicStrategySeriesHash,
  emptyPackageBook,
  invalidateImpliedSource,
  matchPackageOrder,
  packageAllocation,
  packageAllocationHash,
  packageBookCancellation,
  packageBookCancellationHash,
  packageBookState,
  packageMatchingPolicy,
  packageMatchingPolicyBytes,
  packageMatchingPolicyHash,
  packageSettlementCommitment,
  packageSettlementCommitmentHash,
  packageSettlementHandoff,
  packageSettlementHandoffHash,
  packageSettlementReadiness,
  packageSettlementReadinessHash,
  PACKAGE_SETTLEMENT_MAX_ALLOCATIONS,
  parseProtocolJson,
  protocolId,
  seriesExecutionClass,
  seriesExecutionClassBytes,
  seriesExecutionClassHash,
  setPackageBookHalted,
  stringifyProtocolJson,
  toHex,
  verifyPackageAllocation,
  verifyPackageSettlementHandoff,
} from "@naryx/protocol-types";
import type {
  CommitmentHash,
  EconomicStrategySeries,
  EconomicStrategySeriesInput,
  EconomicStrategySeriesSupportInput,
  ImpliedLiquidityInput,
  PackageAllocation,
  PackageBookAmendment,
  PackageBookEntry,
  PackageBookState,
  PackageMatchingPolicy,
  PackageMatchingPolicyInput,
  PackageMatchRejection,
  PackageSettlementCommitment,
  PackageSettlementCommitmentInput,
  PackageSettlementHandoff,
  PackageSettlementReadiness,
  PackageTakerOrderInput,
  SeriesExecutionClass,
  SeriesExecutionClassInput,
  SeriesExecutionClassSupportInput,
} from "@naryx/protocol-types";

export type ExchangeDocumentKind = "SERIES" | "EXECUTION_CLASS" | "MATCHING_POLICY";

export interface RegisteredExchangeDocument {
  readonly kind: ExchangeDocumentKind;
  readonly subjectId: string;
  readonly subjectVersion: number;
  readonly documentHashHex: string;
  readonly created: boolean;
}

export interface RegisteredStrategySeriesRecord {
  readonly documentHashHex: string;
  readonly document: EconomicStrategySeries;
}

export interface RegisteredExecutionClassRecord {
  readonly documentHashHex: string;
  readonly document: SeriesExecutionClass;
}

export type PackageExchangeSubmitResult =
  | {
      readonly accepted: true;
      readonly replayed: boolean;
      readonly allocation: PackageAllocation;
      readonly allocationHashHex: string;
      readonly settlementCommitmentHashHex: string;
      readonly settlementHandoff?: PackageSettlementHandoff;
      readonly settlementHandoffHashHex?: string;
    }
  | { readonly accepted: false; readonly rejection: PackageMatchRejection };

export interface PackageTapeRecord {
  readonly cursor: number;
  readonly allocation: PackageAllocation;
  readonly allocationHashHex: string;
  readonly recordedAtMs: number;
}

export interface PackageExchangeCancellationResult {
  readonly cancellationHashHex: string;
  readonly replayed: boolean;
}

export interface PackageSettlementObligation {
  readonly allocationHashHex: string;
  readonly fillSequence: bigint;
  readonly role: "TAKER" | "MAKER";
  readonly counterpartyOrderIdHex?: string;
  readonly makerSource: "DIRECT" | "IMPLIED";
  readonly priceTicks: bigint;
  readonly quantity: bigint;
}

export interface PackageSettlementProgress {
  readonly readiness: PackageSettlementReadiness;
  readonly readinessHashHex: string;
  readonly obligations: readonly PackageSettlementObligation[];
}

export const MAX_TAPE_PAGE = 100;

export interface PackageExchangeStoreOptions {
  readonly seriesSupport: EconomicStrategySeriesSupportInput;
  readonly executionClassSupport: SeriesExecutionClassSupportInput;
  readonly clock?: () => number;
}

/** Resting entries one package book may hold, and one participant within it. */
export const MAX_BOOK_ENTRIES = 2_000;
/** Implied entries one batch may add. */
export const MAX_IMPLIED_BATCH = 16;
export const MAX_ENTRIES_PER_PARTICIPANT = 250;

export class PackageExchangeStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PackageExchangeStoreError";
    this.code = code;
  }
}

const BUSY_TIMEOUT_MS = 5_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS exchange_documents (
  document_hash BLOB PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('SERIES', 'EXECUTION_CLASS', 'MATCHING_POLICY')),
  subject_id TEXT NOT NULL,
  subject_version INTEGER NOT NULL CHECK (subject_version > 0),
  canonical_bytes BLOB NOT NULL,
  document_json TEXT NOT NULL,
  UNIQUE (kind, subject_id, subject_version)
) STRICT;
CREATE TABLE IF NOT EXISTS execution_class_bindings (
  class_hash BLOB PRIMARY KEY REFERENCES exchange_documents(document_hash),
  series_hash BLOB NOT NULL REFERENCES exchange_documents(document_hash),
  matching_policy_hash BLOB NOT NULL REFERENCES exchange_documents(document_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS package_books (
  execution_class_id TEXT PRIMARY KEY,
  class_hash BLOB NOT NULL REFERENCES execution_class_bindings(class_hash),
  halted INTEGER NOT NULL CHECK (halted IN (0, 1)),
  next_sequence TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_entries (
  entry_id BLOB PRIMARY KEY,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  entry_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_allocations (
  allocation_hash BLOB PRIMARY KEY,
  taker_order_id BLOB NOT NULL UNIQUE,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  allocation_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_settlement_commitments (
  package_order_id BLOB PRIMARY KEY,
  commitment_hash BLOB NOT NULL UNIQUE,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  strategy_order_hash BLOB NOT NULL,
  participant_id TEXT NOT NULL,
  commitment_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_settlement_handoffs (
  allocation_hash BLOB PRIMARY KEY REFERENCES package_book_allocations(allocation_hash),
  handoff_hash BLOB NOT NULL UNIQUE,
  handoff_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_settlement_obligations (
  allocation_hash BLOB NOT NULL REFERENCES package_book_allocations(allocation_hash),
  fill_index INTEGER NOT NULL CHECK (fill_index >= 0),
  fill_sequence TEXT NOT NULL,
  package_order_id BLOB NOT NULL REFERENCES package_book_settlement_commitments(package_order_id),
  role TEXT NOT NULL CHECK (role IN ('TAKER', 'MAKER')),
  counterparty_order_id BLOB,
  maker_source TEXT NOT NULL CHECK (maker_source IN ('DIRECT', 'IMPLIED')),
  price_ticks TEXT NOT NULL,
  quantity_atoms TEXT NOT NULL,
  PRIMARY KEY (allocation_hash, fill_index, role)
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_cancellations (
  cancellation_hash BLOB PRIMARY KEY,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  entry_id BLOB NOT NULL,
  participant_id TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (execution_class_id, entry_id)
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_consumed_sources (
  source_key BLOB PRIMARY KEY,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  allocation_hash BLOB NOT NULL REFERENCES package_book_allocations(allocation_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS implied_source_versions (
  source_id TEXT PRIMARY KEY,
  current_version TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS reject_exchange_document_change
  BEFORE UPDATE ON exchange_documents
  BEGIN SELECT RAISE(ABORT, 'exchange documents are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_exchange_document_delete
  BEFORE DELETE ON exchange_documents
  BEGIN SELECT RAISE(ABORT, 'exchange documents are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_class_binding_change
  BEFORE UPDATE ON execution_class_bindings
  BEGIN SELECT RAISE(ABORT, 'execution class bindings are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_allocation_change
  BEFORE UPDATE ON package_book_allocations
  BEGIN SELECT RAISE(ABORT, 'package allocations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_allocation_delete
  BEFORE DELETE ON package_book_allocations
  BEGIN SELECT RAISE(ABORT, 'package allocations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_commitment_change
  BEFORE UPDATE ON package_book_settlement_commitments
  BEGIN SELECT RAISE(ABORT, 'package settlement commitments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_commitment_delete
  BEFORE DELETE ON package_book_settlement_commitments
  BEGIN SELECT RAISE(ABORT, 'package settlement commitments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_handoff_change
  BEFORE UPDATE ON package_book_settlement_handoffs
  BEGIN SELECT RAISE(ABORT, 'package settlement handoffs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_handoff_delete
  BEFORE DELETE ON package_book_settlement_handoffs
  BEGIN SELECT RAISE(ABORT, 'package settlement handoffs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_obligation_change
  BEFORE UPDATE ON package_book_settlement_obligations
  BEGIN SELECT RAISE(ABORT, 'package settlement obligations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_obligation_delete
  BEFORE DELETE ON package_book_settlement_obligations
  BEGIN SELECT RAISE(ABORT, 'package settlement obligations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_cancellation_change
  BEFORE UPDATE ON package_book_cancellations
  BEGIN SELECT RAISE(ABORT, 'package cancellations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_cancellation_delete
  BEFORE DELETE ON package_book_cancellations
  BEGIN SELECT RAISE(ABORT, 'package cancellations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_consumed_source_change
  BEFORE UPDATE ON package_book_consumed_sources
  BEGIN SELECT RAISE(ABORT, 'consumed sources are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_consumed_source_delete
  BEFORE DELETE ON package_book_consumed_sources
  BEGIN SELECT RAISE(ABORT, 'consumed sources are append-only'); END;
CREATE INDEX IF NOT EXISTS package_book_allocations_by_time ON package_book_allocations(execution_class_id, recorded_at_ms);
CREATE TABLE IF NOT EXISTS package_book_trades (
  allocation_rowid INTEGER PRIMARY KEY,
  allocation_hash BLOB NOT NULL UNIQUE REFERENCES package_book_allocations(allocation_hash),
  execution_class_id TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS package_book_trades_by_class ON package_book_trades(execution_class_id, allocation_rowid);
CREATE INDEX IF NOT EXISTS package_book_trades_by_time ON package_book_trades(execution_class_id, recorded_at_ms, allocation_rowid);
CREATE TRIGGER IF NOT EXISTS reject_trade_change
  BEFORE UPDATE ON package_book_trades
  BEGIN SELECT RAISE(ABORT, 'package trades are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_trade_delete
  BEFORE DELETE ON package_book_trades
  BEGIN SELECT RAISE(ABORT, 'package trades are append-only'); END;
`;

interface DocumentRow {
  readonly document_hash: unknown;
  readonly canonical_bytes: unknown;
  readonly document_json: unknown;
}

function repositoryRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function requireDatabasePath(dbPath: string): string {
  if (typeof dbPath !== "string" || dbPath.length === 0 || dbPath === ":memory:" || !isAbsolute(dbPath)) {
    throw new PackageExchangeStoreError("INVALID_PATH", "Database path must be an absolute durable file path.");
  }
  const resolved = resolve(dbPath);
  const root = repositoryRoot();
  if (root !== undefined && (resolved === resolve(root) || resolved.startsWith(resolve(root) + sep))) {
    throw new PackageExchangeStoreError("INVALID_PATH", "Database path must remain outside the repository checkout.");
  }
  return resolved;
}

function guarded<T>(code: string, message: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PackageExchangeStoreError) throw error;
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new PackageExchangeStoreError(code, `${message}${detail}`);
  }
}

function hashBytes(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new PackageExchangeStoreError("CORRUPT_ROW", `Stored ${field} is invalid.`);
  }
  return Uint8Array.from(value);
}

function jsonText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PackageExchangeStoreError("CORRUPT_ROW", `Stored ${field} is invalid.`);
  }
  return value;
}

function sequenceText(value: bigint): string {
  return value.toString(10);
}

function storedBigInt(value: unknown, field: string, signed = false): bigint {
  if (typeof value !== "string" || !(signed ? /^-?(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/).test(value)) {
    throw new PackageExchangeStoreError("CORRUPT_ROW", `Stored ${field} is invalid.`);
  }
  return BigInt(value);
}

/**
 * Durable exchange state: immutable series, execution-class, and matching-policy documents
 * plus one package book per execution class. Every mutation runs the protocol matcher inside
 * one immediate transaction, and a global primary key on consumed source keys makes a source
 * reservation single-use even if two books were ever handed the same reservation.
 */
export class SqlitePackageExchangeStore {
  private readonly db: Database.Database;
  private readonly options: PackageExchangeStoreOptions;
  private readonly clock: () => number;

  constructor(dbPath: string, options: PackageExchangeStoreOptions) {
    const resolved = requireDatabasePath(dbPath);
    if (typeof options !== "object" || options === null) {
      throw new PackageExchangeStoreError("INVALID_INPUT", "Store options must name the supported series semantics.");
    }
    this.options = options;
    this.clock = options.clock ?? Date.now;
    mkdirSync(dirname(resolved), { recursive: true });
    const db = new Database(resolved);
    try {
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const journalMode = db.pragma("journal_mode = WAL", { simple: true });
      db.pragma("synchronous = FULL");
      db.pragma("foreign_keys = ON");
      if (String(journalMode).toLowerCase() !== "wal" || db.pragma("foreign_keys", { simple: true }) !== 1) {
        throw new PackageExchangeStoreError("PRAGMA_FAILED", "Durability pragmas were not applied.");
      }
      const indexedTrades = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'package_book_trades'").get() !== undefined;
      db.exec(SCHEMA_SQL);
      // Stores created before trades were indexed index their existing trades once.
      if (!indexedTrades) {
        db.exec(
          `INSERT INTO package_book_trades (allocation_rowid, allocation_hash, execution_class_id, recorded_at_ms)
           SELECT rowid, allocation_hash, execution_class_id, recorded_at_ms FROM package_book_allocations WHERE json_array_length(allocation_json, '$.fills') > 0`,
        );
      }
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- documents

  registerMatchingPolicy(input: PackageMatchingPolicyInput): RegisteredExchangeDocument {
    const policy = guarded("INVALID_INPUT", "Matching policy is invalid.", () => packageMatchingPolicy(input));
    return this.transaction(() =>
      this.insertDocument(
        "MATCHING_POLICY",
        policy.executionClassId,
        policy.matchingPolicyVersion,
        packageMatchingPolicyBytes(policy),
        packageMatchingPolicyHash(policy),
        policy,
      ),
    );
  }

  registerSeries(input: EconomicStrategySeriesInput): RegisteredExchangeDocument {
    const series = guarded("INVALID_INPUT", "Strategy series is invalid.", () =>
      economicStrategySeries(input, this.options.seriesSupport),
    );
    return this.transaction(() =>
      this.insertDocument(
        "SERIES",
        series.seriesId,
        series.seriesVersion,
        economicStrategySeriesBytes(series, this.options.seriesSupport),
        economicStrategySeriesHash(series, this.options.seriesSupport),
        series,
      ),
    );
  }

  registerExecutionClass(input: SeriesExecutionClassInput): RegisteredExchangeDocument {
    const executionClass = guarded("INVALID_INPUT", "Execution class is invalid.", () =>
      seriesExecutionClass(input, this.options.executionClassSupport),
    );
    return this.transaction(() => {
      const series = this.documentByHash("SERIES", executionClass.seriesManifestHash);
      const seriesValue = series === undefined ? undefined : this.loadSeries(series);
      if (
        seriesValue === undefined ||
        seriesValue.seriesId !== executionClass.seriesId ||
        seriesValue.seriesVersion !== executionClass.seriesVersion
      ) {
        throw new PackageExchangeStoreError("UNKNOWN_REFERENCE", "Execution class references an unregistered series.");
      }
      const policyRow = this.documentByHash("MATCHING_POLICY", executionClass.matchingPolicyHash);
      const policy = policyRow === undefined ? undefined : this.loadPolicy(policyRow);
      if (policy === undefined || policy.executionClassId !== executionClass.executionClassId) {
        throw new PackageExchangeStoreError(
          "UNKNOWN_REFERENCE",
          "Execution class references a matching policy that is unregistered or written for another class.",
        );
      }
      const classHash = seriesExecutionClassHash(executionClass, this.options.executionClassSupport);
      const registered = this.insertDocument(
        "EXECUTION_CLASS",
        executionClass.executionClassId,
        executionClass.executionClassVersion,
        seriesExecutionClassBytes(executionClass, this.options.executionClassSupport),
        classHash,
        executionClass,
      );
      if (registered.created) {
        this.db
          .prepare("INSERT INTO execution_class_bindings (class_hash, series_hash, matching_policy_hash) VALUES (?, ?, ?)")
          .run(classHash, executionClass.seriesManifestHash, executionClass.matchingPolicyHash);
      }
      return registered;
    });
  }

  getSeries(seriesId: string, seriesVersion: number): EconomicStrategySeries | undefined {
    const row = this.documentBySubject("SERIES", seriesId, seriesVersion);
    return row === undefined ? undefined : this.loadSeries(row);
  }

  getSeriesRecord(seriesId: string, seriesVersion: number): RegisteredStrategySeriesRecord | undefined {
    const row = this.documentBySubject("SERIES", seriesId, seriesVersion);
    return row === undefined ? undefined : Object.freeze({
      documentHashHex: toHex(hashBytes(row.document_hash, "document_hash")),
      document: this.loadSeries(row),
    });
  }

  getExecutionClass(executionClassId: string, executionClassVersion: number): SeriesExecutionClass | undefined {
    const row = this.documentBySubject("EXECUTION_CLASS", executionClassId, executionClassVersion);
    return row === undefined ? undefined : this.loadExecutionClass(row);
  }

  getExecutionClassRecord(executionClassId: string, executionClassVersion: number): RegisteredExecutionClassRecord | undefined {
    const row = this.documentBySubject("EXECUTION_CLASS", executionClassId, executionClassVersion);
    return row === undefined ? undefined : Object.freeze({
      documentHashHex: toHex(hashBytes(row.document_hash, "document_hash")),
      document: this.loadExecutionClass(row),
    });
  }

  /** Every open book with its halt state, ordered by execution class. */
  listBooks(): readonly { readonly executionClassId: string; readonly halted: boolean }[] {
    const rows = this.db
      .prepare("SELECT execution_class_id, halted FROM package_books ORDER BY execution_class_id LIMIT 500")
      .all() as { execution_class_id: unknown; halted: unknown }[];
    return Object.freeze(rows.map((row) => Object.freeze({ executionClassId: jsonText(row.execution_class_id, "execution_class_id"), halted: row.halted === 1 })));
  }

  /** The highest registered version of every strategy series, revalidated against its hash. */
  listSeries(): readonly EconomicStrategySeries[] {
    return Object.freeze(this.latestSubjects("SERIES").map((row) => this.loadSeries(row)));
  }

  /** The highest version of every execution class bound to one strategy series. */
  listExecutionClasses(seriesId: string): readonly SeriesExecutionClass[] {
    return Object.freeze(
      this.latestSubjects("EXECUTION_CLASS")
        .map((row) => this.loadExecutionClass(row))
        .filter((executionClass) => executionClass.seriesId === seriesId),
    );
  }

  /** Trades recorded in a half-open time window, oldest first, for candle aggregation; resting-only allocations are skipped. */
  allocationsBetween(executionClassId: string, fromMs: number, toMs: number, limit: number): readonly PackageTapeRecord[] {
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs < 0 || toMs <= fromMs || !Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) {
      throw new PackageExchangeStoreError("INVALID_INPUT", "Window must be nonempty and limit between 1 and 50000.");
    }
    if (this.getBook(executionClassId) === undefined) throw new PackageExchangeStoreError("BOOK_NOT_FOUND", "Package book is not open.");
    const rows = this.db
      .prepare(
        `SELECT t.allocation_rowid AS cursor, a.allocation_hash, a.allocation_json, a.recorded_at_ms FROM package_book_trades t
         JOIN package_book_allocations a ON a.allocation_hash = t.allocation_hash
         WHERE t.execution_class_id = ? AND t.recorded_at_ms >= ? AND t.recorded_at_ms < ?
         ORDER BY t.recorded_at_ms, t.allocation_rowid LIMIT ?`,
      )
      .all(executionClassId, fromMs, toMs, limit) as { cursor: unknown; allocation_hash: unknown; allocation_json: unknown; recorded_at_ms: unknown }[];
    return Object.freeze(rows.map((row) => this.tapeRecord(executionClassId, row)));
  }

  private latestSubjects(kind: ExchangeDocumentKind): readonly DocumentRow[] {
    return this.db
      .prepare(
        `SELECT d.document_hash, d.canonical_bytes, d.document_json FROM exchange_documents d
         JOIN (SELECT subject_id, MAX(subject_version) AS version FROM exchange_documents WHERE kind = ? GROUP BY subject_id) m
           ON d.subject_id = m.subject_id AND d.subject_version = m.version
         WHERE d.kind = ? ORDER BY d.subject_id LIMIT 500`,
      )
      .all(kind, kind) as DocumentRow[];
  }

  getMatchingPolicy(policyHash: Uint8Array | string): PackageMatchingPolicy | undefined {
    const row = this.documentByHash("MATCHING_POLICY", commitmentHash(policyHash));
    return row === undefined ? undefined : this.loadPolicy(row);
  }

  // ---------------------------------------------------------------- books

  openBook(executionClassId: string, executionClassVersion: number): PackageBookState {
    return this.transaction(() => {
      const row = this.documentBySubject("EXECUTION_CLASS", executionClassId, executionClassVersion);
      if (row === undefined) {
        throw new PackageExchangeStoreError("UNKNOWN_REFERENCE", "Execution class is not registered.");
      }
      const executionClass = this.loadExecutionClass(row);
      const existing = this.db
        .prepare("SELECT class_hash FROM package_books WHERE execution_class_id = ?")
        .get(executionClass.executionClassId) as { class_hash: unknown } | undefined;
      if (existing !== undefined) {
        if (!bytesEqual(hashBytes(existing.class_hash, "class_hash"), hashBytes(row.document_hash, "document_hash"))) {
          throw new PackageExchangeStoreError("BOOK_CONFLICT", "A book for this execution class runs another class version.");
        }
        return this.loadBook(executionClass.executionClassId);
      }
      const policy = this.policyForClass(executionClass);
      const book = emptyPackageBook(policy);
      this.db
        .prepare("INSERT INTO package_books (execution_class_id, class_hash, halted, next_sequence) VALUES (?, ?, 0, ?)")
        .run(executionClass.executionClassId, hashBytes(row.document_hash, "document_hash"), sequenceText(book.nextSequence));
      return book;
    });
  }

  getBook(executionClassId: string): PackageBookState | undefined {
    const exists = this.db
      .prepare("SELECT 1 FROM package_books WHERE execution_class_id = ?")
      .get(executionClassId);
    return exists === undefined ? undefined : this.loadBook(executionClassId);
  }

  submitOrder(
    executionClassId: string,
    order: PackageTakerOrderInput,
    nowValue: bigint,
    commitmentInput: PackageSettlementCommitmentInput,
  ): PackageExchangeSubmitResult {
    return this.transaction(() => {
      const orderId = guarded("INVALID_INPUT", "Order id is invalid.", () => commitmentHash(order.orderId));
      const commitment = guarded("INVALID_INPUT", "Settlement commitment is invalid.", () =>
        packageSettlementCommitment(commitmentInput),
      );
      const settlementCommitmentHash = packageSettlementCommitmentHash(commitment);
      if (
        commitment.executionClassId !== executionClassId
        || !bytesEqual(commitment.packageOrderId, orderId)
        || commitment.participantId !== order.participantId
        || commitment.quantity !== order.quantity
      ) {
        throw new PackageExchangeStoreError(
          "SETTLEMENT_MISMATCH",
          "The settlement commitment does not bind the submitted package order.",
        );
      }
      if (commitment.validUntilValue <= nowValue) {
        throw new PackageExchangeStoreError("SETTLEMENT_EXPIRED", "The settlement commitment is expired.");
      }
      if (order.timeInForce === "GTC") {
        throw new PackageExchangeStoreError(
          "UNBOUNDED_SETTLEMENT",
          "Executable package-book orders use a bounded settlement commitment and cannot be GTC.",
        );
      }
      if (order.timeInForce === "GTD" && order.expiresAtValue !== commitment.validUntilValue) {
        throw new PackageExchangeStoreError(
          "SETTLEMENT_MISMATCH",
          "The book order and settlement commitment must expire together.",
        );
      }
      const replay = this.db
        .prepare("SELECT allocation_json, execution_class_id FROM package_book_allocations WHERE taker_order_id = ?")
        .get(orderId) as { allocation_json: unknown; execution_class_id: unknown } | undefined;
      if (replay !== undefined) {
        if (replay.execution_class_id !== executionClassId) {
          throw new PackageExchangeStoreError("ORDER_CONFLICT", "Order id was already allocated in another book.");
        }
        const storedCommitment = this.settlementCommitment(orderId);
        if (storedCommitment === undefined || !bytesEqual(packageSettlementCommitmentHash(storedCommitment), settlementCommitmentHash)) {
          throw new PackageExchangeStoreError(
            "ORDER_CONFLICT",
            "Order id was already allocated under another settlement commitment.",
          );
        }
        const allocation = this.decodeAllocation(executionClassId, replay.allocation_json);
        const allocationHashHex = toHex(packageAllocationHash(allocation));
        const handoff = this.settlementHandoff(allocationHashHex);
        return {
          accepted: true,
          replayed: true,
          allocation,
          allocationHashHex,
          settlementCommitmentHashHex: toHex(settlementCommitmentHash),
          ...(handoff === undefined ? {} : {
            settlementHandoff: handoff,
            settlementHandoffHashHex: toHex(packageSettlementHandoffHash(handoff)),
          }),
        };
      }
      const { policy, book } = this.policyAndBook(executionClassId);
      if (commitment.environment !== policy.environment) {
        throw new PackageExchangeStoreError(
          "SETTLEMENT_MISMATCH",
          "The settlement commitment belongs to another environment.",
        );
      }
      const result = guarded("INVALID_INPUT", "Order is invalid.", () => matchPackageOrder(policy, book, order, nowValue));
      if (!result.accepted) return { accepted: false, rejection: result.rejection };
      const allocationHash = packageAllocationHash(result.allocation);
      const recordedAtMs = this.clock();
      this.db.prepare(`
        INSERT INTO package_book_settlement_commitments
          (package_order_id, commitment_hash, execution_class_id, strategy_order_hash,
           participant_id, commitment_json, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId,
        settlementCommitmentHash,
        executionClassId,
        commitment.strategyOrderHash,
        commitment.participantId,
        stringifyProtocolJson(commitment),
        recordedAtMs,
      );
      this.db
        .prepare(
          "INSERT INTO package_book_allocations (allocation_hash, taker_order_id, execution_class_id, allocation_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?)",
        )
        .run(allocationHash, orderId, executionClassId, stringifyProtocolJson(result.allocation), recordedAtMs);
      // Only allocations that filled are trades; resting-only allocations never reach the tape.
      if (result.allocation.fills.length > 0) {
        this.db
          .prepare(
            "INSERT INTO package_book_trades (allocation_rowid, allocation_hash, execution_class_id, recorded_at_ms) SELECT rowid, allocation_hash, execution_class_id, recorded_at_ms FROM package_book_allocations WHERE allocation_hash = ?",
          )
          .run(allocationHash);
      }
      const consume = this.db.prepare(
        "INSERT INTO package_book_consumed_sources (source_key, execution_class_id, allocation_hash) VALUES (?, ?, ?)",
      );
      for (const fill of result.allocation.fills) {
        for (const key of fill.consumedSourceKeys) {
          guarded("SOURCE_ALREADY_CONSUMED", "A source reservation was already consumed.", () =>
            consume.run(key, executionClassId, allocationHash),
          );
        }
      }
      let settlementHandoff: PackageSettlementHandoff | undefined;
      let settlementHandoffHashHex: string | undefined;
      if (result.allocation.fills.length > 0) {
        settlementHandoff = packageSettlementHandoff({
          version: 1,
          allocationHash,
          executionClassId,
          takerSettlementCommitmentHash: settlementCommitmentHash,
          fills: result.allocation.fills.map((fill) => {
            if (fill.makerSource === "IMPLIED") {
              return {
                fillSequence: fill.fillSequence,
                makerEntryId: fill.makerEntryId,
                makerSource: fill.makerSource,
                priceTicks: fill.priceTicks,
                quantity: fill.quantity,
              };
            }
            const makerCommitment = this.settlementCommitment(fill.makerEntryId);
            if (makerCommitment === undefined) {
              throw new PackageExchangeStoreError(
                "UNBACKED_LIQUIDITY",
                "A direct maker entry has no settlement commitment.",
              );
            }
            return {
              fillSequence: fill.fillSequence,
              makerEntryId: fill.makerEntryId,
              makerSource: fill.makerSource,
              priceTicks: fill.priceTicks,
              quantity: fill.quantity,
              makerSettlementCommitmentHash: packageSettlementCommitmentHash(makerCommitment),
            };
          }),
        });
        verifyPackageSettlementHandoff(result.allocation, settlementHandoff);
        const handoffHash = packageSettlementHandoffHash(settlementHandoff);
        settlementHandoffHashHex = toHex(handoffHash);
        this.db.prepare(`
          INSERT INTO package_book_settlement_handoffs
            (allocation_hash, handoff_hash, handoff_json, recorded_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(allocationHash, handoffHash, stringifyProtocolJson(settlementHandoff), recordedAtMs);
        const allocationCount = this.db.prepare(`
          SELECT COUNT(DISTINCT allocation_hash) AS count
          FROM package_book_settlement_obligations
          WHERE package_order_id = ?
        `);
        for (const fill of result.allocation.fills) {
          if (fill.makerSource !== "DIRECT") continue;
          const row = allocationCount.get(fill.makerEntryId) as { count: unknown };
          if (typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
            throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement allocation count is invalid.");
          }
          if (row.count >= PACKAGE_SETTLEMENT_MAX_ALLOCATIONS) {
            throw new PackageExchangeStoreError(
              "SETTLEMENT_ALLOCATION_LIMIT",
              `One package order may participate in at most ${PACKAGE_SETTLEMENT_MAX_ALLOCATIONS} allocations.`,
            );
          }
        }
        const insertObligation = this.db.prepare(`
          INSERT INTO package_book_settlement_obligations
            (allocation_hash, fill_index, fill_sequence, package_order_id, role,
             counterparty_order_id, maker_source, price_ticks, quantity_atoms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        result.allocation.fills.forEach((fill, fillIndex) => {
          insertObligation.run(
            allocationHash,
            fillIndex,
            sequenceText(fill.fillSequence),
            orderId,
            "TAKER",
            fill.makerSource === "DIRECT" ? fill.makerEntryId : null,
            fill.makerSource,
            sequenceText(fill.priceTicks),
            sequenceText(fill.quantity),
          );
          if (fill.makerSource === "DIRECT") {
            insertObligation.run(
              allocationHash,
              fillIndex,
              sequenceText(fill.fillSequence),
              fill.makerEntryId,
              "MAKER",
              orderId,
              fill.makerSource,
              sequenceText(fill.priceTicks),
              sequenceText(fill.quantity),
            );
          }
        });
      }
      this.writeBook(result.state);
      return {
        accepted: true,
        replayed: false,
        allocation: result.allocation,
        allocationHashHex: toHex(allocationHash),
        settlementCommitmentHashHex: toHex(settlementCommitmentHash),
        ...(settlementHandoff === undefined || settlementHandoffHashHex === undefined
          ? {}
          : { settlementHandoff, settlementHandoffHashHex }),
      };
    });
  }

  addImpliedLiquidity(executionClassId: string, input: ImpliedLiquidityInput): PackageBookEntry {
    return this.addImpliedLiquidityBatch(executionClassId, [input])[0] as PackageBookEntry;
  }

  /**
   * Adds several implied entries to one book in a single transaction: every entry is admitted in
   * order against the book as it stands after the previous one, or none is.
   */
  addImpliedLiquidityBatch(executionClassId: string, inputs: readonly ImpliedLiquidityInput[]): readonly PackageBookEntry[] {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_IMPLIED_BATCH) {
      throw new PackageExchangeStoreError("INVALID_INPUT", `A batch holds 1 to ${MAX_IMPLIED_BATCH} implied entries.`);
    }
    return this.transaction(() => {
      const { policy, book } = this.policyAndBook(executionClassId);
      const versions = this.db.prepare("SELECT current_version FROM implied_source_versions WHERE source_id = ?");
      const consumed = this.db.prepare("SELECT 1 FROM package_book_consumed_sources WHERE source_key = ?");
      let state = book;
      const entries: PackageBookEntry[] = [];
      for (const input of inputs) {
        for (const source of input.quote.sources) {
          const row = versions.get(source.sourceId) as { current_version: unknown } | undefined;
          if (row !== undefined && BigInt(jsonText(row.current_version, "current_version")) > source.sourceVersion) {
            throw new PackageExchangeStoreError("STALE_SOURCE", `Implied source ${source.sourceId} was superseded.`);
          }
          if (source.reservationId !== undefined && consumed.get(source.reservationId) !== undefined) {
            throw new PackageExchangeStoreError("SOURCE_ALREADY_CONSUMED", "A source reservation was already consumed.");
          }
        }
        const result = guarded("INVALID_INPUT", "Implied liquidity is invalid.", () => addImpliedLiquidity(policy, state, input));
        state = result.state;
        entries.push(result.entry);
      }
      this.writeBook(state);
      return Object.freeze(entries);
    });
  }

  /** Records a newer leg-source version and removes every implied entry built on an older one. */
  observeSourceVersion(sourceId: string, currentVersion: bigint): readonly CommitmentHash[] {
    return this.transaction(() => {
      const id = guarded("INVALID_INPUT", "Source id is invalid.", () => protocolId(sourceId));
      const row = this.db
        .prepare("SELECT current_version FROM implied_source_versions WHERE source_id = ?")
        .get(id) as { current_version: unknown } | undefined;
      if (row !== undefined && BigInt(jsonText(row.current_version, "current_version")) > currentVersion) {
        throw new PackageExchangeStoreError("STALE_SOURCE", "Source versions only move forward.");
      }
      this.db
        .prepare(
          "INSERT INTO implied_source_versions (source_id, current_version) VALUES (?, ?) ON CONFLICT (source_id) DO UPDATE SET current_version = excluded.current_version",
        )
        .run(id, currentVersion.toString(10));
      const invalidated: CommitmentHash[] = [];
      const books = this.db.prepare("SELECT execution_class_id FROM package_books").all() as { execution_class_id: string }[];
      for (const { execution_class_id: classId } of books) {
        const { book } = this.policyAndBook(classId);
        const result = invalidateImpliedSource(book, id, currentVersion);
        if (result.invalidatedEntryIds.length > 0) {
          this.writeBook(result.state);
          invalidated.push(...result.invalidatedEntryIds);
        }
      }
      return Object.freeze(invalidated);
    });
  }

  cancelEntry(
    executionClassId: string,
    entryId: Uint8Array | string,
    participantId: string,
  ): PackageExchangeCancellationResult {
    return this.transaction(() => {
      const cancellation = guarded("INVALID_INPUT", "Cancellation is invalid.", () =>
        packageBookCancellation({ version: 1, executionClassId, entryId, participantId }),
      );
      const cancellationHash = packageBookCancellationHash(cancellation);
      const existing = this.db
        .prepare("SELECT 1 FROM package_book_cancellations WHERE cancellation_hash = ?")
        .get(cancellationHash);
      if (existing !== undefined) return { cancellationHashHex: toHex(cancellationHash), replayed: true };
      const { book } = this.policyAndBook(executionClassId);
      this.writeBook(
        guarded("INVALID_INPUT", "Cancellation is invalid.", () => cancelPackageBookEntry(book, entryId, participantId)),
      );
      this.db
        .prepare(
          "INSERT INTO package_book_cancellations (cancellation_hash, execution_class_id, entry_id, participant_id, recorded_at_ms) VALUES (?, ?, ?, ?, ?)",
        )
        .run(cancellationHash, cancellation.executionClassId, cancellation.entryId, cancellation.participantId, this.clock());
      return { cancellationHashHex: toHex(cancellationHash), replayed: false };
    });
  }

  amendEntry(executionClassId: string, amendment: PackageBookAmendment): void {
    this.transaction(() => {
      const { policy, book } = this.policyAndBook(executionClassId);
      this.writeBook(
        guarded("INVALID_INPUT", "Amendment is invalid.", () => amendPackageBookEntry(policy, book, amendment)),
      );
    });
  }

  setHalted(executionClassId: string, halted: boolean): void {
    this.transaction(() => {
      const { book } = this.policyAndBook(executionClassId);
      this.writeBook(setPackageBookHalted(book, halted));
    });
  }

  getAllocation(takerOrderId: Uint8Array | string): PackageAllocation | undefined {
    const row = this.db
      .prepare("SELECT allocation_json, execution_class_id FROM package_book_allocations WHERE taker_order_id = ?")
      .get(commitmentHash(takerOrderId)) as { allocation_json: unknown; execution_class_id: unknown } | undefined;
    if (row === undefined) return undefined;
    return this.decodeAllocation(jsonText(row.execution_class_id, "execution_class_id"), row.allocation_json);
  }

  settlementCommitment(packageOrderId: Uint8Array | string): PackageSettlementCommitment | undefined {
    const row = this.db.prepare(`
      SELECT commitment_hash, commitment_json
      FROM package_book_settlement_commitments
      WHERE package_order_id = ?
    `).get(commitmentHash(packageOrderId)) as {
      commitment_hash: unknown;
      commitment_json: unknown;
    } | undefined;
    if (row === undefined) return undefined;
    const commitment = packageSettlementCommitment(
      parseProtocolJson(jsonText(row.commitment_json, "commitment_json")) as PackageSettlementCommitmentInput,
    );
    if (!bytesEqual(packageSettlementCommitmentHash(commitment), hashBytes(row.commitment_hash, "commitment_hash"))) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement commitment does not match its hash.");
    }
    return commitment;
  }

  settlementHandoff(allocationHash: Uint8Array | string): PackageSettlementHandoff | undefined {
    const row = this.db.prepare(`
      SELECT handoff_hash, handoff_json
      FROM package_book_settlement_handoffs
      WHERE allocation_hash = ?
    `).get(commitmentHash(allocationHash)) as {
      handoff_hash: unknown;
      handoff_json: unknown;
    } | undefined;
    if (row === undefined) return undefined;
    const handoff = packageSettlementHandoff(
      parseProtocolJson(jsonText(row.handoff_json, "handoff_json")) as PackageSettlementHandoff,
    );
    if (!bytesEqual(packageSettlementHandoffHash(handoff), hashBytes(row.handoff_hash, "handoff_hash"))) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement handoff does not match its hash.");
    }
    return handoff;
  }

  settlementObligations(packageOrderId: Uint8Array | string): readonly PackageSettlementObligation[] {
    const orderId = commitmentHash(packageOrderId);
    const commitment = this.settlementCommitment(orderId);
    const rows = this.db.prepare(`
      SELECT o.allocation_hash, o.fill_sequence, o.role, o.counterparty_order_id,
             o.maker_source, o.price_ticks, o.quantity_atoms
      FROM package_book_settlement_obligations o
      JOIN package_book_allocations a ON a.allocation_hash = o.allocation_hash
      WHERE o.package_order_id = ?
      ORDER BY a.recorded_at_ms, o.fill_index, o.role
    `).all(orderId) as {
      allocation_hash: unknown;
      fill_sequence: unknown;
      role: unknown;
      counterparty_order_id: unknown;
      maker_source: unknown;
      price_ticks: unknown;
      quantity_atoms: unknown;
    }[];
    const handoffs = new Map<string, PackageSettlementHandoff>();
    const takerOrderIds = new Map<string, string>();
    return Object.freeze(rows.map((row) => {
      if ((row.role !== "TAKER" && row.role !== "MAKER")
        || (row.maker_source !== "DIRECT" && row.maker_source !== "IMPLIED")
        || (row.role === "MAKER" && row.maker_source !== "DIRECT")) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement obligation kind is invalid.");
      }
      const counterparty = row.counterparty_order_id === null
        ? undefined
        : toHex(hashBytes(row.counterparty_order_id, "counterparty_order_id"));
      if ((row.maker_source === "DIRECT") !== (counterparty !== undefined)) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement obligation counterparty is invalid.");
      }
      const allocationHashHex = toHex(hashBytes(row.allocation_hash, "allocation_hash"));
      const fillSequence = storedBigInt(row.fill_sequence, "fill_sequence");
      const priceTicks = storedBigInt(row.price_ticks, "price_ticks", true);
      const quantity = storedBigInt(row.quantity_atoms, "quantity_atoms");
      let handoff = handoffs.get(allocationHashHex);
      if (handoff === undefined) {
        handoff = this.settlementHandoff(allocationHashHex);
        if (handoff === undefined) {
          throw new PackageExchangeStoreError("CORRUPT_ROW", "Settlement obligation lost its handoff.");
        }
        handoffs.set(allocationHashHex, handoff);
      }
      let takerOrderIdHex = takerOrderIds.get(allocationHashHex);
      if (takerOrderIdHex === undefined) {
        const allocationRow = this.db.prepare(
          "SELECT taker_order_id FROM package_book_allocations WHERE allocation_hash = ?",
        ).get(handoff.allocationHash) as { taker_order_id: unknown } | undefined;
        if (allocationRow === undefined) {
          throw new PackageExchangeStoreError("CORRUPT_ROW", "Settlement obligation lost its allocation.");
        }
        takerOrderIdHex = toHex(hashBytes(allocationRow.taker_order_id, "taker_order_id"));
        takerOrderIds.set(allocationHashHex, takerOrderIdHex);
      }
      const fill = handoff.fills.find((candidate) => candidate.fillSequence === fillSequence);
      if (commitment === undefined || fill === undefined
        || fill.makerSource !== row.maker_source
        || fill.priceTicks !== priceTicks
        || fill.quantity !== quantity
        || (row.role === "TAKER" && (!bytesEqual(
          handoff.takerSettlementCommitmentHash,
          packageSettlementCommitmentHash(commitment),
        ) || (fill.makerSource === "DIRECT" && counterparty !== toHex(fill.makerEntryId))))
        || (row.role === "MAKER" && (!bytesEqual(fill.makerEntryId, orderId)
          || counterparty !== takerOrderIdHex
          || fill.makerSettlementCommitmentHash === undefined
          || !bytesEqual(fill.makerSettlementCommitmentHash, packageSettlementCommitmentHash(commitment))))) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement obligation differs from its handoff.");
      }
      return Object.freeze({
        allocationHashHex,
        fillSequence,
        role: row.role,
        ...(counterparty === undefined ? {} : { counterpartyOrderIdHex: counterparty }),
        makerSource: row.maker_source,
        priceTicks,
        quantity,
      });
    }));
  }

  settlementProgress(packageOrderId: Uint8Array | string): PackageSettlementProgress | undefined {
    const orderId = commitmentHash(packageOrderId);
    const commitment = this.settlementCommitment(orderId);
    if (commitment === undefined) return undefined;
    const obligations = this.settlementObligations(orderId);
    const allocatedQuantity = obligations.reduce((sum, obligation) => sum + obligation.quantity, 0n);
    if (allocatedQuantity > commitment.quantity) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Settlement obligations exceed the committed quantity.");
    }
    const remainingQuantity = commitment.quantity - allocatedQuantity;
    const { book } = this.policyAndBook(commitment.executionClassId);
    const acceptsFurtherMatches = book.entries.some((entry) => bytesEqual(entry.entryId, orderId));
    if (remainingQuantity === 0n && acceptsFurtherMatches) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "A fully allocated package order remains in the book.");
    }
    const status = allocatedQuantity === commitment.quantity
      ? "READY_FOR_OWNER_AUTHORIZATION" as const
      : acceptsFurtherMatches
        ? allocatedQuantity === 0n ? "AWAITING_MATCH" as const : "PARTIALLY_ALLOCATED" as const
        : allocatedQuantity === 0n ? "CANCELLED_UNFILLED" as const : "PARTIAL_AUTHORIZATION_REQUIRED" as const;
    const readiness = packageSettlementReadiness({
      version: 1,
      packageOrderId: orderId,
      settlementCommitmentHash: packageSettlementCommitmentHash(commitment),
      strategyOrderHash: commitment.strategyOrderHash,
      executionClassId: commitment.executionClassId,
      committedQuantity: commitment.quantity,
      allocatedQuantity,
      remainingQuantity,
      acceptsFurtherMatches,
      status,
      allocationHashes: [...new Set(obligations.map((obligation) => obligation.allocationHashHex))],
    });
    return Object.freeze({
      readiness,
      readinessHashHex: toHex(packageSettlementReadinessHash(readiness)),
      obligations,
    });
  }

  /**
   * Trades for one book in recorded order after an opaque cursor: allocations with at least one
   * fill. An order that only rested is not a trade and is never listed. The cursor is the storage
   * row order, so a reader resumes exactly where it stopped and never sees a trade twice.
   */
  allocationTape(executionClassId: string, afterCursor: number, limit: number): readonly PackageTapeRecord[] {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TAPE_PAGE) {
      throw new PackageExchangeStoreError("INVALID_INPUT", `Tape cursor must be nonnegative and limit between 1 and ${MAX_TAPE_PAGE}.`);
    }
    if (this.getBook(executionClassId) === undefined) {
      throw new PackageExchangeStoreError("BOOK_NOT_FOUND", "Package book is not open.");
    }
    const rows = this.db
      .prepare(
        `SELECT t.allocation_rowid AS cursor, a.allocation_hash, a.allocation_json, a.recorded_at_ms FROM package_book_trades t
         JOIN package_book_allocations a ON a.allocation_hash = t.allocation_hash
         WHERE t.execution_class_id = ? AND t.allocation_rowid > ? ORDER BY t.allocation_rowid LIMIT ?`,
      )
      .all(executionClassId, afterCursor, limit) as { cursor: unknown; allocation_hash: unknown; allocation_json: unknown; recorded_at_ms: unknown }[];
    return Object.freeze(rows.map((row) => this.tapeRecord(executionClassId, row)));
  }

  /** The most recently recorded allocation of one book, or undefined when it has never traded. */
  latestTrade(executionClassId: string): PackageTapeRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT t.allocation_rowid AS cursor, a.allocation_hash, a.allocation_json, a.recorded_at_ms FROM package_book_trades t
         JOIN package_book_allocations a ON a.allocation_hash = t.allocation_hash
         WHERE t.execution_class_id = ? ORDER BY t.allocation_rowid DESC LIMIT 1`,
      )
      .get(executionClassId) as { cursor: unknown; allocation_hash: unknown; allocation_json: unknown; recorded_at_ms: unknown } | undefined;
    return row === undefined ? undefined : this.tapeRecord(executionClassId, row);
  }

  private tapeRecord(
    executionClassId: string,
    row: { cursor: unknown; allocation_hash: unknown; allocation_json: unknown; recorded_at_ms: unknown },
  ): PackageTapeRecord {
    if (typeof row.cursor !== "number" || typeof row.recorded_at_ms !== "number") {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored tape row is invalid.");
    }
    const allocation = this.decodeAllocation(executionClassId, row.allocation_json);
    const allocationHash = packageAllocationHash(allocation);
    if (!bytesEqual(allocationHash, hashBytes(row.allocation_hash, "allocation_hash"))) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored allocation hash does not match its content.");
    }
    return Object.freeze({ cursor: row.cursor, allocation, allocationHashHex: toHex(allocationHash), recordedAtMs: row.recorded_at_ms });
  }

  // ---------------------------------------------------------------- internals

  private transaction<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }

  private insertDocument(
    kind: ExchangeDocumentKind,
    subjectId: string,
    subjectVersion: number,
    bytes: Uint8Array,
    hash: Uint8Array,
    document: unknown,
  ): RegisteredExchangeDocument {
    const existing = this.documentBySubject(kind, subjectId, subjectVersion);
    const documentHashHex = toHex(hash);
    if (existing !== undefined) {
      // A published version is never reinterpreted: the same identity must carry the same bytes.
      if (!bytesEqual(hashBytes(existing.document_hash, "document_hash"), hash)) {
        throw new PackageExchangeStoreError(
          "DOCUMENT_CONFLICT",
          `${kind} ${subjectId} version ${subjectVersion} is already registered with different content.`,
        );
      }
      return { kind, subjectId, subjectVersion, documentHashHex, created: false };
    }
    this.db
      .prepare(
        "INSERT INTO exchange_documents (document_hash, kind, subject_id, subject_version, canonical_bytes, document_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(hash, kind, subjectId, subjectVersion, bytes, stringifyProtocolJson(document));
    return { kind, subjectId, subjectVersion, documentHashHex, created: true };
  }

  private documentBySubject(kind: ExchangeDocumentKind, subjectId: string, subjectVersion: number): DocumentRow | undefined {
    return this.db
      .prepare(
        "SELECT document_hash, canonical_bytes, document_json FROM exchange_documents WHERE kind = ? AND subject_id = ? AND subject_version = ?",
      )
      .get(kind, subjectId, subjectVersion) as DocumentRow | undefined;
  }

  private documentByHash(kind: ExchangeDocumentKind, hash: Uint8Array): DocumentRow | undefined {
    return this.db
      .prepare("SELECT document_hash, canonical_bytes, document_json FROM exchange_documents WHERE kind = ? AND document_hash = ?")
      .get(kind, hash) as DocumentRow | undefined;
  }

  private verifiedDocument<T>(
    row: DocumentRow,
    build: (value: never) => T,
    bytesOf: (value: T) => Uint8Array,
    hashOf: (value: T) => Uint8Array,
  ): T {
    const value = guarded("CORRUPT_ROW", "Stored exchange document failed validation.", () =>
      build(parseProtocolJson(jsonText(row.document_json, "document_json")) as never),
    );
    if (
      !bytesEqual(bytesOf(value), row.canonical_bytes as Uint8Array) ||
      !bytesEqual(hashOf(value), hashBytes(row.document_hash, "document_hash"))
    ) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored exchange document does not match its canonical hash.");
    }
    return value;
  }

  private loadSeries(row: DocumentRow): EconomicStrategySeries {
    return this.verifiedDocument(
      row,
      (value: EconomicStrategySeriesInput) => economicStrategySeries(value, this.options.seriesSupport),
      (value) => economicStrategySeriesBytes(value, this.options.seriesSupport),
      (value) => economicStrategySeriesHash(value, this.options.seriesSupport),
    );
  }

  private loadExecutionClass(row: DocumentRow): SeriesExecutionClass {
    return this.verifiedDocument(
      row,
      (value: SeriesExecutionClassInput) => seriesExecutionClass(value, this.options.executionClassSupport),
      (value) => seriesExecutionClassBytes(value, this.options.executionClassSupport),
      (value) => seriesExecutionClassHash(value, this.options.executionClassSupport),
    );
  }

  private loadPolicy(row: DocumentRow): PackageMatchingPolicy {
    return this.verifiedDocument(
      row,
      (value: PackageMatchingPolicyInput) => packageMatchingPolicy(value),
      packageMatchingPolicyBytes,
      packageMatchingPolicyHash,
    );
  }

  private policyForClass(executionClass: SeriesExecutionClass): PackageMatchingPolicy {
    const row = this.documentByHash("MATCHING_POLICY", executionClass.matchingPolicyHash);
    if (row === undefined) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Execution class lost its matching policy.");
    }
    return this.loadPolicy(row);
  }

  private policyAndBook(executionClassId: string): { policy: PackageMatchingPolicy; book: PackageBookState } {
    const row = this.db
      .prepare(
        "SELECT d.document_hash, d.canonical_bytes, d.document_json FROM package_books b JOIN exchange_documents d ON d.document_hash = b.class_hash WHERE b.execution_class_id = ?",
      )
      .get(executionClassId) as DocumentRow | undefined;
    if (row === undefined) {
      throw new PackageExchangeStoreError("BOOK_NOT_FOUND", "No package book is open for this execution class.");
    }
    const policy = this.policyForClass(this.loadExecutionClass(row));
    return { policy, book: this.loadBookWith(policy, executionClassId) };
  }

  private loadBook(executionClassId: string): PackageBookState {
    return this.policyAndBook(executionClassId).book;
  }

  private loadBookWith(policy: PackageMatchingPolicy, executionClassId: string): PackageBookState {
    const meta = this.db
      .prepare("SELECT halted, next_sequence FROM package_books WHERE execution_class_id = ?")
      .get(executionClassId) as { halted: unknown; next_sequence: unknown };
    const entries = (
      this.db
        .prepare("SELECT entry_json FROM package_book_entries WHERE execution_class_id = ?")
        .all(executionClassId) as { entry_json: unknown }[]
    ).map((row) => parseProtocolJson(jsonText(row.entry_json, "entry_json")) as PackageBookEntry);
    const consumedSourceKeys = (
      this.db
        .prepare("SELECT source_key FROM package_book_consumed_sources WHERE execution_class_id = ?")
        .all(executionClassId) as { source_key: unknown }[]
    ).map((row) => toHex(hashBytes(row.source_key, "source_key")));
    return guarded("CORRUPT_ROW", "Stored package book failed validation.", () =>
      packageBookState(policy, {
        executionClassId: policy.executionClassId,
        matchingPolicyHash: packageMatchingPolicyHash(policy),
        halted: meta.halted === 1,
        nextSequence: BigInt(jsonText(meta.next_sequence, "next_sequence")),
        entries,
        consumedSourceKeys,
      }),
    );
  }

  /**
   * Writes a book state incrementally: only added, changed, or removed entries touch storage. A
   * mutation that grows the book or one participant past its cap is refused inside the caller's
   * transaction, while cancels and fills are always allowed.
   */
  private writeBook(state: PackageBookState): void {
    const classId = state.executionClassId;
    const stored = new Map<string, string>(
      (this.db.prepare("SELECT entry_id, entry_json FROM package_book_entries WHERE execution_class_id = ?").all(classId) as {
        entry_id: Uint8Array;
        entry_json: string;
      }[]).map((row) => [toHex(row.entry_id), row.entry_json]),
    );
    const participants = (entries: Iterable<{ participantId: string }>) => {
      const counts = new Map<string, number>();
      for (const entry of entries) counts.set(entry.participantId, (counts.get(entry.participantId) ?? 0) + 1);
      return counts;
    };
    const before = participants([...stored.values()].map((json) => ({ participantId: String((JSON.parse(json) as { participantId?: unknown }).participantId) })));
    const after = participants(state.entries);
    if (state.entries.length > MAX_BOOK_ENTRIES && state.entries.length > stored.size) {
      throw new PackageExchangeStoreError("BOOK_FULL", `A package book holds at most ${MAX_BOOK_ENTRIES} entries.`);
    }
    for (const [participantId, count] of after) {
      if (count > MAX_ENTRIES_PER_PARTICIPANT && count > (before.get(participantId) ?? 0)) {
        throw new PackageExchangeStoreError("PARTICIPANT_BOOK_LIMIT", `One participant may hold at most ${MAX_ENTRIES_PER_PARTICIPANT} entries in a book.`);
      }
    }
    this.db
      .prepare("UPDATE package_books SET halted = ?, next_sequence = ? WHERE execution_class_id = ?")
      .run(state.halted ? 1 : 0, sequenceText(state.nextSequence), classId);
    const insert = this.db.prepare(
      "INSERT INTO package_book_entries (entry_id, execution_class_id, entry_json) VALUES (?, ?, ?)",
    );
    const update = this.db.prepare("UPDATE package_book_entries SET entry_json = ? WHERE entry_id = ? AND execution_class_id = ?");
    const remove = this.db.prepare("DELETE FROM package_book_entries WHERE entry_id = ? AND execution_class_id = ?");
    const kept = new Set<string>();
    for (const entry of state.entries) {
      const key = toHex(entry.entryId);
      const json = stringifyProtocolJson(entry);
      kept.add(key);
      const previous = stored.get(key);
      if (previous === undefined) insert.run(entry.entryId, classId, json);
      else if (previous !== json) update.run(json, entry.entryId, classId);
    }
    for (const key of stored.keys()) if (!kept.has(key)) remove.run(Buffer.from(key, "hex"), classId);
  }

  private decodeAllocation(executionClassId: string, json: unknown): PackageAllocation {
    const { policy } = this.policyAndBook(executionClassId);
    return guarded("CORRUPT_ROW", "Stored allocation failed validation.", () => {
      const allocation = packageAllocation(parseProtocolJson(jsonText(json, "allocation_json")) as PackageAllocation);
      verifyPackageAllocation(policy, allocation);
      return allocation;
    });
  }
}
