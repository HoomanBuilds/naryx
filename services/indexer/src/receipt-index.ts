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
import { replayBondEvents, type BondEventType, type ObservedBond, type ObservedBondEvent } from "./bond-vault.js";
import { replayCoordinatorEvents, type CoordinatorEventType, type ObservedAsyncPackage, type ObservedCoordinatorEvent } from "./async-coordinator.js";

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
  /** Decoded performance bond vault logs in this block, when the source follows a vault. */
  readonly bondEvents?: readonly ObservedBondEvent[];
  /** Decoded async bonded coordinator logs in this block, when the source follows a coordinator. */
  readonly coordinatorEvents?: readonly ObservedCoordinatorEvent[];
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
CREATE TABLE IF NOT EXISTS bond_events (
  domain_id TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  locator TEXT NOT NULL,
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  vault TEXT NOT NULL,
  bond_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  at_value TEXT NOT NULL,
  evidence_grade TEXT NOT NULL,
  fields TEXT NOT NULL,
  PRIMARY KEY (domain_id, block_hash, locator),
  FOREIGN KEY (domain_id, block_hash) REFERENCES blocks(domain_id, block_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS bond_events_bond ON bond_events(domain_id, vault, bond_id);
CREATE TABLE IF NOT EXISTS coordinator_events (
  domain_id TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  locator TEXT NOT NULL,
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  coordinator TEXT NOT NULL,
  package_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  evidence_grade TEXT NOT NULL,
  fields TEXT NOT NULL,
  PRIMARY KEY (domain_id, block_hash, locator),
  FOREIGN KEY (domain_id, block_hash) REFERENCES blocks(domain_id, block_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS coordinator_events_package ON coordinator_events(domain_id, coordinator, package_id);
CREATE TRIGGER IF NOT EXISTS reject_coordinator_event_change BEFORE UPDATE ON coordinator_events BEGIN SELECT RAISE(ABORT, 'coordinator events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_coordinator_event_delete BEFORE DELETE ON coordinator_events BEGIN SELECT RAISE(ABORT, 'coordinator events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_bond_event_change BEFORE UPDATE ON bond_events BEGIN SELECT RAISE(ABORT, 'bond events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_bond_event_delete BEFORE DELETE ON bond_events BEGIN SELECT RAISE(ABORT, 'bond events are append-only'); END;
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

const BOND_EVENT_TYPES: ReadonlySet<BondEventType> = new Set(["BOND_OPENED", "CLAIM_FILED", "CLAIM_DISPUTED", "CLAIM_RESOLVED", "CLAIM_PAID", "BOND_RELEASED"]);

function checkedBondEvent(event: ObservedBondEvent, index: number): ObservedBondEvent & { readonly logIndex: number } {
  if (typeof event !== "object" || event === null) throw new ReceiptIndexError("INVALID_INPUT", `Bond event ${index} is not an object.`);
  const match = typeof event.locator === "string" ? /^0x[0-9a-f]{64}:(\d{1,9})$/.exec(event.locator) : null;
  if (match === null) throw new ReceiptIndexError("INVALID_INPUT", `Bond event ${index} locator is invalid.`);
  if (!BOND_EVENT_TYPES.has(event.type)) throw new ReceiptIndexError("INVALID_INPUT", `Bond event ${index} type is unknown.`);
  if (!Object.hasOwn(EVIDENCE_GRADE, event.evidenceGrade)) throw new ReceiptIndexError("INVALID_INPUT", `Bond event ${index} evidence grade is unknown.`);
  if (typeof event.vault !== "string" || !/^0x[0-9a-f]{40}$/.test(event.vault)) throw new ReceiptIndexError("INVALID_INPUT", `Bond event ${index} vault is invalid.`);
  if (typeof event.atValue !== "string" || !/^(0|[1-9]\d{0,19})$/.test(event.atValue)) throw new ReceiptIndexError("INVALID_INPUT", `Bond event ${index} time is invalid.`);
  if (typeof event.fields !== "object" || event.fields === null) throw new ReceiptIndexError("INVALID_INPUT", `Bond event ${index} fields are missing.`);
  return {
    locator: event.locator,
    logIndex: Number(match[1]),
    vault: event.vault,
    bondIdHex: hashHex(event.bondIdHex, `bondEvents[${index}].bondIdHex`),
    type: event.type,
    atValue: event.atValue,
    evidenceGrade: event.evidenceGrade,
    fields: event.fields,
  };
}

const COORDINATOR_EVENT_TYPES: ReadonlySet<CoordinatorEventType> = new Set(["PACKAGE_TRANSITION", "PACKAGE_RELEASED", "BOND_SLASHED"]);

function checkedCoordinatorEvent(event: ObservedCoordinatorEvent, index: number): ObservedCoordinatorEvent & { readonly logIndex: number } {
  if (typeof event !== "object" || event === null) throw new ReceiptIndexError("INVALID_INPUT", `Coordinator event ${index} is not an object.`);
  const match = typeof event.locator === "string" ? /^0x[0-9a-f]{64}:(\d{1,9})$/.exec(event.locator) : null;
  if (match === null) throw new ReceiptIndexError("INVALID_INPUT", `Coordinator event ${index} locator is invalid.`);
  if (!COORDINATOR_EVENT_TYPES.has(event.type)) throw new ReceiptIndexError("INVALID_INPUT", `Coordinator event ${index} type is unknown.`);
  if (!Object.hasOwn(EVIDENCE_GRADE, event.evidenceGrade)) throw new ReceiptIndexError("INVALID_INPUT", `Coordinator event ${index} evidence grade is unknown.`);
  if (typeof event.coordinator !== "string" || !/^0x[0-9a-f]{40}$/.test(event.coordinator)) throw new ReceiptIndexError("INVALID_INPUT", `Coordinator event ${index} coordinator is invalid.`);
  if (typeof event.fields !== "object" || event.fields === null || !Object.values(event.fields).every((value) => typeof value === "string")) {
    throw new ReceiptIndexError("INVALID_INPUT", `Coordinator event ${index} fields are invalid.`);
  }
  return {
    locator: event.locator,
    logIndex: Number(match[1]),
    coordinator: event.coordinator,
    packageIdHex: hashHex(event.packageIdHex, `coordinatorEvents[${index}].packageIdHex`),
    type: event.type,
    evidenceGrade: event.evidenceGrade,
    fields: event.fields,
  };
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
/** A finality checkpoint: the height and the block hash the chain reports at that height. */
export interface FinalityCheckpoint {
  readonly height: number;
  readonly blockHashHex: string;
}

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
    if (block.bondEvents !== undefined && (!Array.isArray(block.bondEvents) || block.bondEvents.length > MAX_EVENTS_PER_BLOCK)) {
      throw new ReceiptIndexError("INVALID_INPUT", `A block carries at most ${MAX_EVENTS_PER_BLOCK} bond events.`);
    }
    const bondEvents = (block.bondEvents ?? []).map(checkedBondEvent);
    if (new Set(bondEvents.map((event) => event.locator)).size !== bondEvents.length) {
      throw new ReceiptIndexError("INVALID_INPUT", "Bond event locators repeat inside the block.");
    }
    if (block.coordinatorEvents !== undefined && (!Array.isArray(block.coordinatorEvents) || block.coordinatorEvents.length > MAX_EVENTS_PER_BLOCK)) {
      throw new ReceiptIndexError("INVALID_INPUT", `A block carries at most ${MAX_EVENTS_PER_BLOCK} coordinator events.`);
    }
    const coordinatorEvents = (block.coordinatorEvents ?? []).map(checkedCoordinatorEvent);
    if (new Set(coordinatorEvents.map((event) => event.locator)).size !== coordinatorEvents.length) {
      throw new ReceiptIndexError("INVALID_INPUT", "Coordinator event locators repeat inside the block.");
    }
    // Bond and coordinator events join the content key only when present, so blocks indexed before
    // them keep their keys; the key's length tells the shapes apart.
    const byLocator = (a: { locator: string }, b: { locator: string }) => (a.locator < b.locator ? -1 : 1);
    const sortedEvents = [...events].sort(byLocator);
    const contentKey = JSON.stringify(
      coordinatorEvents.length > 0
        ? [at, parentHash, sortedEvents, [...bondEvents].sort(byLocator), [...coordinatorEvents].sort(byLocator)]
        : bondEvents.length === 0
          ? [at, parentHash, sortedEvents]
          : [at, parentHash, sortedEvents, [...bondEvents].sort(byLocator)],
    );

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
        const insertBond = this.db.prepare(
          "INSERT INTO bond_events (domain_id, block_hash, locator, log_index, vault, bond_id, event_type, at_value, evidence_grade, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const event of bondEvents) {
          insertBond.run(domainId, blockHash, event.locator, event.logIndex, event.vault, event.bondIdHex, event.type, event.atValue, event.evidenceGrade, JSON.stringify(event.fields));
        }
        const insertCoordinator = this.db.prepare(
          "INSERT INTO coordinator_events (domain_id, block_hash, locator, log_index, coordinator, package_id, event_type, evidence_grade, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const event of coordinatorEvents) {
          insertCoordinator.run(domainId, blockHash, event.locator, event.logIndex, event.coordinator, event.packageIdHex, event.type, event.evidenceGrade, JSON.stringify(event.fields));
        }
      }
      return displaced.count > 0 ? { status: "REORGED" as const, orphanedBlocks: displaced.count } : { status: "APPENDED" as const };
    });
  }

  /**
   * Moves confirmation and finality forward only. Each checkpoint names both a height and the block
   * hash the chain reports there, and the index must hold exactly that block as canonical at that
   * height, so a stale fork block can never be finalized before the reorg is replayed.
   */
  advanceFinality(domainIdInput: string, confirmedCheckpoint: FinalityCheckpoint, finalizedCheckpoint: FinalityCheckpoint): void {
    const domainId = id(domainIdInput, "domainId");
    if (typeof confirmedCheckpoint !== "object" || confirmedCheckpoint === null || typeof finalizedCheckpoint !== "object" || finalizedCheckpoint === null) {
      throw new ReceiptIndexError("INVALID_INPUT", "Finality checkpoints must name a height and block hash.");
    }
    const confirmed = height(confirmedCheckpoint.height, "confirmedHeight");
    const finalized = height(finalizedCheckpoint.height, "finalizedHeight");
    const confirmedHash = hashHex(confirmedCheckpoint.blockHashHex, "confirmedBlockHashHex");
    const finalizedHash = hashHex(finalizedCheckpoint.blockHashHex, "finalizedBlockHashHex");
    if (finalized > confirmed) throw new ReceiptIndexError("INVALID_INPUT", "Finalized height cannot exceed confirmed height.");
    this.transaction(() => {
      const current = this.ensureDomain(domainId);
      if (finalized < current.finalized) throw new ReceiptIndexError("FINALITY_REGRESSION", "Finalized height cannot move backward.");
      const canonicalAt = this.db.prepare("SELECT block_hash FROM blocks WHERE domain_id = ? AND height = ? AND canonical = 1");
      const heldConfirmed = canonicalAt.get(domainId, confirmed) as { block_hash: string } | undefined;
      if (heldConfirmed === undefined) throw new ReceiptIndexError("UNKNOWN_BLOCK", "Confirmation must name a canonical block the index holds.");
      if (heldConfirmed.block_hash !== confirmedHash) {
        throw new ReceiptIndexError("FORK_MISMATCH", "The confirmed block is not the one the index holds; replay the reorg first.");
      }
      const heldFinalized = canonicalAt.get(domainId, finalized) as { block_hash: string } | undefined;
      if (heldFinalized === undefined || heldFinalized.block_hash !== finalizedHash) {
        throw new ReceiptIndexError("FORK_MISMATCH", "The finalized block is not the one the index holds; replay the reorg first.");
      }
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

  /**
   * One performance bond as its vault's canonical logs show it, replayed through the kernel's bond
   * rules. Finality is the weakest of its events; undefined when the index holds no event for it.
   */
  bond(domainIdInput: string, vaultInput: string, bondIdHexInput: string): ObservedBond | undefined {
    const domainId = id(domainIdInput, "domainId");
    const vault = String(vaultInput).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(vault)) throw new ReceiptIndexError("INVALID_INPUT", "vault must be a 20-byte hex address.");
    const bondId = hashHex(String(bondIdHexInput).toLowerCase().replace(/^0x/, ""), "bondIdHex");
    const rows = this.db
      .prepare(
        `SELECT e.locator, e.log_index, e.vault, e.bond_id, e.event_type, e.at_value, e.evidence_grade, e.fields, b.height, d.confirmed_height, d.finalized_height
         FROM bond_events e
         JOIN blocks b ON b.domain_id = e.domain_id AND b.block_hash = e.block_hash AND b.canonical = 1
         JOIN domains d ON d.domain_id = e.domain_id
         WHERE e.domain_id = ? AND e.vault = ? AND e.bond_id = ?
         ORDER BY b.height ASC, e.log_index ASC`,
      )
      .all(domainId, vault, bondId) as {
      locator: string;
      log_index: number;
      vault: string;
      bond_id: string;
      event_type: BondEventType;
      at_value: string;
      evidence_grade: EvidenceGrade;
      fields: string;
      height: number;
      confirmed_height: number;
      finalized_height: number;
    }[];
    if (rows.length === 0) return undefined;
    const events = rows.map((row) => ({
      locator: row.locator,
      vault: row.vault,
      bondIdHex: row.bond_id,
      type: row.event_type,
      atValue: row.at_value,
      evidenceGrade: row.evidence_grade,
      fields: JSON.parse(row.fields) as Record<string, string | number | boolean>,
      height: row.height,
    }));
    const last = rows[rows.length - 1] as (typeof rows)[number];
    const finality: Finality = last.height <= last.finalized_height ? "FINALIZED" : last.height <= last.confirmed_height ? "CONFIRMED" : "OBSERVED";
    return replayBondEvents(events, finality);
  }

  /**
   * One async bonded coordinator package as its canonical logs show it, replayed in chain order.
   * Finality is the weakest of its events; undefined when the index holds no event for it.
   */
  asyncPackage(domainIdInput: string, coordinatorInput: string, packageIdHexInput: string): ObservedAsyncPackage | undefined {
    const domainId = id(domainIdInput, "domainId");
    const coordinator = String(coordinatorInput).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(coordinator)) throw new ReceiptIndexError("INVALID_INPUT", "coordinator must be a 20-byte hex address.");
    const packageId = hashHex(String(packageIdHexInput).toLowerCase().replace(/^0x/, ""), "packageIdHex");
    const rows = this.db
      .prepare(
        `SELECT e.locator, e.coordinator, e.package_id, e.event_type, e.evidence_grade, e.fields, b.height, d.confirmed_height, d.finalized_height
         FROM coordinator_events e
         JOIN blocks b ON b.domain_id = e.domain_id AND b.block_hash = e.block_hash AND b.canonical = 1
         JOIN domains d ON d.domain_id = e.domain_id
         WHERE e.domain_id = ? AND e.coordinator = ? AND e.package_id = ?
         ORDER BY b.height ASC, e.log_index ASC`,
      )
      .all(domainId, coordinator, packageId) as {
      locator: string;
      coordinator: string;
      package_id: string;
      event_type: CoordinatorEventType;
      evidence_grade: EvidenceGrade;
      fields: string;
      height: number;
      confirmed_height: number;
      finalized_height: number;
    }[];
    if (rows.length === 0) return undefined;
    const last = rows[rows.length - 1] as (typeof rows)[number];
    const finality: Finality = last.height <= last.finalized_height ? "FINALIZED" : last.height <= last.confirmed_height ? "CONFIRMED" : "OBSERVED";
    return replayCoordinatorEvents(
      rows.map((row) => ({
        locator: row.locator,
        coordinator: row.coordinator,
        packageIdHex: row.package_id,
        type: row.event_type,
        evidenceGrade: row.evidence_grade,
        fields: JSON.parse(row.fields) as Record<string, string>,
        height: row.height,
      })),
      finality,
    );
  }

  /** The bonds a vault holds for one solver address, each replayed as `bond` does. */
  bondsForSolver(domainIdInput: string, vaultInput: string, solverInput: string): readonly ObservedBond[] {
    const domainId = id(domainIdInput, "domainId");
    const vault = String(vaultInput).toLowerCase();
    const solver = String(solverInput).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(vault) || !/^0x[0-9a-f]{40}$/.test(solver)) throw new ReceiptIndexError("INVALID_INPUT", "vault and solver must be 20-byte hex addresses.");
    const ids = this.db
      .prepare(
        `SELECT DISTINCT e.bond_id FROM bond_events e
         JOIN blocks b ON b.domain_id = e.domain_id AND b.block_hash = e.block_hash AND b.canonical = 1
         WHERE e.domain_id = ? AND e.vault = ? AND e.event_type = 'BOND_OPENED' AND json_extract(e.fields, '$.solver') = ?
         ORDER BY e.bond_id LIMIT 256`,
      )
      .all(domainId, vault, solver) as { bond_id: string }[];
    return Object.freeze(ids.map((row) => this.bond(domainId, vault, row.bond_id)).filter((bond): bond is ObservedBond => bond !== undefined));
  }

  /** Packages with a canonical chain event in the height range, in id order, at most `limit`. */
  packageIdsInRange(domainIdInput: string, fromHeight: number, toHeight: number, limit = 10_000): readonly string[] {
    const domainId = id(domainIdInput, "domainId");
    const from = height(fromHeight, "fromHeight");
    const to = height(toHeight, "toHeight");
    if (to < from) throw new ReceiptIndexError("INVALID_INPUT", "The height range is empty.");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.package_id FROM chain_events e
         JOIN blocks b ON b.domain_id = e.domain_id AND b.block_hash = e.block_hash AND b.canonical = 1
         WHERE e.domain_id = ? AND b.height BETWEEN ? AND ? ORDER BY e.package_id LIMIT ?`,
      )
      .all(domainId, from, to, Math.min(Math.max(1, limit), 10_000)) as { package_id: string }[];
    return rows.map((row) => row.package_id);
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
