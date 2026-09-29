import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3";
import { protocolId } from "@naryx/protocol-types";
import {
  buildPackageRecord,
  EVIDENCE_GRADE,
  INDEXED_EVENT_KIND,
  type EvidenceGrade,
  type Finality,
  type IndexedEvent,
  type IndexedEventKind,
  type IndexedPackageRecord,
} from "./package-record.js";

const HASH_HEX = /^[0-9a-f]{64}$/;
const LOCATOR = /^[A-Za-z0-9:_.-]{1,160}$/;
const MAX_EVENTS_PER_BLOCK = 4_096;

export class ReceiptIndexError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReceiptIndexError";
    this.code = code;
  }
}

export interface ObservedChainEvent {
  /** Transaction and log position, unique inside the block. */
  readonly locator: string;
  readonly packageId: string;
  readonly attemptId: string;
  readonly kind: IndexedEventKind;
  readonly evidenceGrade: EvidenceGrade;
  readonly fieldsHashHex: string;
}

export interface ObservedBlock {
  readonly height: number;
  readonly blockHashHex: string;
  readonly parentHashHex: string;
  readonly events: readonly ObservedChainEvent[];
}

export interface ObservedVenueFill {
  readonly fillId: string;
  /** The venue's committed sequence for the fill. */
  readonly sequence: number;
  readonly packageId: string;
  readonly attemptId: string;
  readonly fieldsHashHex: string;
}

export type IngestResult =
  | { readonly status: "APPENDED" | "DUPLICATE" }
  | { readonly status: "REORGED"; readonly orphanedBlocks: number };

export interface DomainIndexState {
  readonly domainId: string;
  readonly tipHeight: number | null;
  readonly confirmedHeight: number;
  readonly finalizedHeight: number;
  readonly reorgCount: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS domains (
  domain_id TEXT PRIMARY KEY,
  confirmed_height INTEGER NOT NULL CHECK (confirmed_height >= -1),
  finalized_height INTEGER NOT NULL CHECK (finalized_height >= -1),
  reorg_count INTEGER NOT NULL CHECK (reorg_count >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS blocks (
  domain_id TEXT NOT NULL REFERENCES domains(domain_id),
  block_hash TEXT NOT NULL,
  height INTEGER NOT NULL CHECK (height >= 0),
  parent_hash TEXT NOT NULL,
  content_key TEXT NOT NULL,
  canonical INTEGER NOT NULL CHECK (canonical IN (0, 1)),
  PRIMARY KEY (domain_id, block_hash)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS canonical_block_height ON blocks(domain_id, height) WHERE canonical = 1;
CREATE TABLE IF NOT EXISTS chain_events (
  domain_id TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  locator TEXT NOT NULL,
  package_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidence_grade TEXT NOT NULL,
  fields_hash TEXT NOT NULL,
  PRIMARY KEY (domain_id, block_hash, locator),
  FOREIGN KEY (domain_id, block_hash) REFERENCES blocks(domain_id, block_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS chain_events_package ON chain_events(package_id);
CREATE TABLE IF NOT EXISTS venue_fills (
  domain_id TEXT NOT NULL,
  fill_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  package_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  fields_hash TEXT NOT NULL,
  PRIMARY KEY (domain_id, fill_id)
) STRICT;
CREATE INDEX IF NOT EXISTS venue_fills_package ON venue_fills(package_id);
CREATE TRIGGER IF NOT EXISTS reject_event_change BEFORE UPDATE ON chain_events BEGIN SELECT RAISE(ABORT, 'chain events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_event_delete BEFORE DELETE ON chain_events BEGIN SELECT RAISE(ABORT, 'chain events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_fill_change BEFORE UPDATE ON venue_fills BEGIN SELECT RAISE(ABORT, 'venue fills are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_fill_delete BEFORE DELETE ON venue_fills BEGIN SELECT RAISE(ABORT, 'venue fills are append-only'); END;
`;

function height(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ReceiptIndexError("INVALID_INPUT", `${field} must be a nonnegative safe integer.`);
  return value;
}

function hashHex(value: string, field: string): string {
  if (typeof value !== "string" || !HASH_HEX.test(value)) throw new ReceiptIndexError("INVALID_INPUT", `${field} must be 32 bytes of lowercase hex.`);
  return value;
}

function id(value: string, field: string): string {
  try {
    return protocolId(value, field);
  } catch {
    throw new ReceiptIndexError("INVALID_INPUT", `${field} is not a protocol identifier.`);
  }
}

function checkedEvent(event: ObservedChainEvent, index: number): ObservedChainEvent {
  if (typeof event !== "object" || event === null) throw new ReceiptIndexError("INVALID_INPUT", `Event ${index} is not an object.`);
  if (typeof event.locator !== "string" || !LOCATOR.test(event.locator)) throw new ReceiptIndexError("INVALID_INPUT", `Event ${index} locator is invalid.`);
  if (!Object.hasOwn(INDEXED_EVENT_KIND, event.kind) || event.kind === "VENUE_FILL") {
    throw new ReceiptIndexError("INVALID_INPUT", `Event ${index} kind is not a chain event kind.`);
  }
  if (!Object.hasOwn(EVIDENCE_GRADE, event.evidenceGrade)) throw new ReceiptIndexError("INVALID_INPUT", `Event ${index} evidence grade is unknown.`);
  return {
    locator: event.locator,
    packageId: id(event.packageId, `events[${index}].packageId`),
    attemptId: id(event.attemptId, `events[${index}].attemptId`),
    kind: event.kind,
    evidenceGrade: event.evidenceGrade,
    fieldsHashHex: hashHex(event.fieldsHashHex, `events[${index}].fieldsHashHex`),
  };
}

/**
 * A read-only, durable index of chain events and venue fills. It follows each domain's canonical
 * chain, orphans events on reorganization, advances finality monotonically, and refuses any
 * change below the finalized height, which is raised as a safety fault rather than rewritten.
 * It holds no signer and has no broadcast path.
 */
export class SqliteReceiptIndex {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (typeof dbPath !== "string" || !isAbsolute(dbPath)) throw new ReceiptIndexError("INVALID_INPUT", "Index path must be absolute.");
    const path = resolve(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    try {
      db.pragma("busy_timeout = 5000");
      const mode = db.pragma("journal_mode = WAL", { simple: true });
      db.pragma("synchronous = FULL");
      db.pragma("foreign_keys = ON");
      if (String(mode).toLowerCase() !== "wal" || db.pragma("foreign_keys", { simple: true }) !== 1) {
        throw new ReceiptIndexError("PRAGMA_FAILED", "Durability pragmas were not applied.");
      }
      db.exec(SCHEMA_SQL);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }

  private ensureDomain(domainId: string): { confirmed: number; finalized: number } {
    this.db
      .prepare("INSERT OR IGNORE INTO domains (domain_id, confirmed_height, finalized_height, reorg_count) VALUES (?, -1, -1, 0)")
      .run(domainId);
    const row = this.db.prepare("SELECT confirmed_height, finalized_height FROM domains WHERE domain_id = ?").get(domainId) as {
      confirmed_height: number;
      finalized_height: number;
    };
    return { confirmed: row.confirmed_height, finalized: row.finalized_height };
  }

  /**
   * Ingests one block. A block whose parent is not the canonical block one below is refused, so
   * a source replays a new branch from its fork point. A different block at a canonical height
   * orphans that height and everything above it.
   */
  ingestBlock(domainIdInput: string, block: ObservedBlock): IngestResult {
    const domainId = id(domainIdInput, "domainId");
    if (typeof block !== "object" || block === null) throw new ReceiptIndexError("INVALID_INPUT", "Block is not an object.");
    const at = height(block.height, "height");
    const blockHash = hashHex(block.blockHashHex, "blockHashHex");
    const parentHash = hashHex(block.parentHashHex, "parentHashHex");
    if (!Array.isArray(block.events) || block.events.length > MAX_EVENTS_PER_BLOCK) {
      throw new ReceiptIndexError("INVALID_INPUT", `A block carries at most ${MAX_EVENTS_PER_BLOCK} events.`);
    }
    const events = block.events.map(checkedEvent);
    const locators = new Set(events.map((event) => event.locator));
    if (locators.size !== events.length) throw new ReceiptIndexError("INVALID_INPUT", "Event locators repeat inside the block.");
    const contentKey = JSON.stringify([at, parentHash, [...events].sort((a, b) => (a.locator < b.locator ? -1 : 1))]);

    return this.transaction(() => {
      const { finalized } = this.ensureDomain(domainId);
      const known = this.db
        .prepare("SELECT height, content_key, canonical FROM blocks WHERE domain_id = ? AND block_hash = ?")
        .get(domainId, blockHash) as { height: number; content_key: string; canonical: number } | undefined;
      if (known !== undefined && known.content_key !== contentKey) {
        throw new ReceiptIndexError("BLOCK_CONFLICT", "A known block hash arrived with different content.");
      }
      if (known !== undefined && known.canonical === 1) return { status: "DUPLICATE" as const };
      const tip = this.db
        .prepare("SELECT MAX(height) AS tip FROM blocks WHERE domain_id = ? AND canonical = 1")
        .get(domainId) as { tip: number | null };
      if (tip.tip !== null) {
        const parent = this.db
          .prepare("SELECT block_hash FROM blocks WHERE domain_id = ? AND height = ? AND canonical = 1")
          .get(domainId, at - 1) as { block_hash: string } | undefined;
        if (parent === undefined || parent.block_hash !== parentHash) {
          throw new ReceiptIndexError("PARENT_UNKNOWN", "Block does not extend the canonical chain; replay from the fork point.");
        }
      }
      const displaced = this.db
        .prepare("SELECT COUNT(*) AS count FROM blocks WHERE domain_id = ? AND height >= ? AND canonical = 1")
        .get(domainId, at) as { count: number };
      if (displaced.count > 0 && at <= finalized) {
        throw new ReceiptIndexError("FINALIZED_CONFLICT", "A block conflicts with finalized history; the index refuses to rewrite it.");
      }
      if (displaced.count > 0) {
        this.db.prepare("UPDATE blocks SET canonical = 0 WHERE domain_id = ? AND height >= ? AND canonical = 1").run(domainId, at);
        this.db.prepare("UPDATE domains SET reorg_count = reorg_count + 1 WHERE domain_id = ?").run(domainId);
        this.db
          .prepare("UPDATE domains SET confirmed_height = MIN(confirmed_height, ?) WHERE domain_id = ?")
          .run(at - 1, domainId);
      }
      if (known !== undefined) {
        this.db.prepare("UPDATE blocks SET canonical = 1 WHERE domain_id = ? AND block_hash = ?").run(domainId, blockHash);
      } else {
        this.db
          .prepare("INSERT INTO blocks (domain_id, block_hash, height, parent_hash, content_key, canonical) VALUES (?, ?, ?, ?, ?, 1)")
          .run(domainId, blockHash, at, parentHash, contentKey);
        const insert = this.db.prepare(
          "INSERT INTO chain_events (domain_id, block_hash, locator, package_id, attempt_id, kind, evidence_grade, fields_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const event of events) {
          insert.run(domainId, blockHash, event.locator, event.packageId, event.attemptId, event.kind, event.evidenceGrade, event.fieldsHashHex);
        }
      }
      return displaced.count > 0 ? { status: "REORGED" as const, orphanedBlocks: displaced.count } : { status: "APPENDED" as const };
    });
  }

  /** Moves confirmation and finality forward only, and only onto canonical blocks the index holds. */
  advanceFinality(domainIdInput: string, confirmedHeight: number, finalizedHeight: number): void {
    const domainId = id(domainIdInput, "domainId");
    const confirmed = height(confirmedHeight, "confirmedHeight");
    const finalized = height(finalizedHeight, "finalizedHeight");
    if (finalized > confirmed) throw new ReceiptIndexError("INVALID_INPUT", "Finalized height cannot exceed confirmed height.");
    this.transaction(() => {
      const current = this.ensureDomain(domainId);
      if (finalized < current.finalized) throw new ReceiptIndexError("FINALITY_REGRESSION", "Finalized height cannot move backward.");
      const canonical = this.db
        .prepare("SELECT 1 FROM blocks WHERE domain_id = ? AND height = ? AND canonical = 1")
        .get(domainId, confirmed);
      if (canonical === undefined) throw new ReceiptIndexError("UNKNOWN_BLOCK", "Confirmation must name a canonical block the index holds.");
      this.db
        .prepare("UPDATE domains SET confirmed_height = ?, finalized_height = ? WHERE domain_id = ?")
        .run(Math.max(confirmed, current.confirmed), finalized, domainId);
    });
  }

  /**
   * Records a committed venue fill. The venue reports fills only after commitment, so they are
   * final on arrival. A known fill identifier with different content is refused.
   */
  ingestVenueFill(domainIdInput: string, fill: ObservedVenueFill): "APPENDED" | "DUPLICATE" {
    const domainId = id(domainIdInput, "domainId");
    if (typeof fill !== "object" || fill === null) throw new ReceiptIndexError("INVALID_INPUT", "Fill is not an object.");
    if (typeof fill.fillId !== "string" || !LOCATOR.test(fill.fillId)) throw new ReceiptIndexError("INVALID_INPUT", "Fill identifier is invalid.");
    const sequence = height(fill.sequence, "sequence");
    const packageId = id(fill.packageId, "packageId");
    const attemptId = id(fill.attemptId, "attemptId");
    const fieldsHash = hashHex(fill.fieldsHashHex, "fieldsHashHex");
    return this.transaction(() => {
      this.ensureDomain(domainId);
      const known = this.db
        .prepare("SELECT sequence, package_id, attempt_id, fields_hash FROM venue_fills WHERE domain_id = ? AND fill_id = ?")
        .get(domainId, fill.fillId) as { sequence: number; package_id: string; attempt_id: string; fields_hash: string } | undefined;
      if (known !== undefined) {
        if (known.sequence !== sequence || known.package_id !== packageId || known.attempt_id !== attemptId || known.fields_hash !== fieldsHash) {
          throw new ReceiptIndexError("FILL_CONFLICT", "A known fill arrived with different content.");
        }
        return "DUPLICATE";
      }
      this.db
        .prepare("INSERT INTO venue_fills (domain_id, fill_id, sequence, package_id, attempt_id, fields_hash) VALUES (?, ?, ?, ?, ?, ?)")
        .run(domainId, fill.fillId, sequence, packageId, attemptId, fieldsHash);
      return "APPENDED";
    });
  }

  domainState(domainIdInput: string): DomainIndexState | undefined {
    const domainId = id(domainIdInput, "domainId");
    const row = this.db.prepare("SELECT confirmed_height, finalized_height, reorg_count FROM domains WHERE domain_id = ?").get(domainId) as
      | { confirmed_height: number; finalized_height: number; reorg_count: number }
      | undefined;
    if (row === undefined) return undefined;
    const tip = this.db.prepare("SELECT MAX(height) AS tip FROM blocks WHERE domain_id = ? AND canonical = 1").get(domainId) as { tip: number | null };
    return Object.freeze({
      domainId,
      tipHeight: tip.tip,
      confirmedHeight: row.confirmed_height,
      finalizedHeight: row.finalized_height,
      reorgCount: row.reorg_count,
    });
  }

  /** The normalized package record from canonical chain events and committed venue fills only. */
  packageRecord(packageIdInput: string): IndexedPackageRecord {
    const packageId = id(packageIdInput, "packageId");
    const chain = this.db
      .prepare(
        `SELECT e.domain_id, b.height, e.locator, e.attempt_id, e.kind, e.evidence_grade, e.fields_hash, d.confirmed_height, d.finalized_height
         FROM chain_events e
         JOIN blocks b ON b.domain_id = e.domain_id AND b.block_hash = e.block_hash AND b.canonical = 1
         JOIN domains d ON d.domain_id = e.domain_id
         WHERE e.package_id = ?`,
      )
      .all(packageId) as {
      domain_id: string;
      height: number;
      locator: string;
      attempt_id: string;
      kind: IndexedEventKind;
      evidence_grade: EvidenceGrade;
      fields_hash: string;
      confirmed_height: number;
      finalized_height: number;
    }[];
    const fills = this.db
      .prepare("SELECT domain_id, fill_id, sequence, attempt_id, fields_hash FROM venue_fills WHERE package_id = ?")
      .all(packageId) as { domain_id: string; fill_id: string; sequence: number; attempt_id: string; fields_hash: string }[];
    const events: IndexedEvent[] = [
      ...chain.map((row) => {
        const finality: Finality = row.height <= row.finalized_height ? "FINALIZED" : row.height <= row.confirmed_height ? "CONFIRMED" : "OBSERVED";
        return {
          domainId: row.domain_id,
          height: row.height,
          locator: row.locator,
          packageId,
          attemptId: row.attempt_id,
          kind: row.kind,
          evidenceGrade: row.evidence_grade,
          fieldsHashHex: row.fields_hash,
          finality,
        };
      }),
      ...fills.map((row) => ({
        domainId: row.domain_id,
        height: row.sequence,
        locator: row.fill_id,
        packageId,
        attemptId: row.attempt_id,
        kind: "VENUE_FILL" as const,
        evidenceGrade: "VENUE_API_CORROBORATED" as const,
        fieldsHashHex: row.fields_hash,
        finality: "FINALIZED" as const,
      })),
    ];
    return buildPackageRecord(packageId, events);
  }
}
