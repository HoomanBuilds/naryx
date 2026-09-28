import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  assertPackageLifecycleTransition,
  bytesEqual,
  enumDiscriminant,
  fromHex,
  isTerminalPackageLifecycleState,
  PACKAGE_LIFECYCLE_STATE,
  packageLifecycleEventIntent,
  packageLifecycleEventIntentCommitment,
  packageLifecycleReceipt,
  packageLifecycleReceiptHash,
  protocolId,
  toHex,
} from "@naryx/protocol-types";
import type {
  CommitmentHash,
  PackageLifecycleEventIntentInput,
  PackageLifecycleReceipt,
  PackageLifecycleState,
} from "@naryx/protocol-types";

export interface PackageLifecycleAttempt {
  readonly attemptId: string;
  readonly packageId: string;
  readonly packageCommitmentHex: string;
  readonly revision: bigint;
  readonly state: PackageLifecycleState;
  readonly receiptHashHex: string;
  readonly eventId: string;
  readonly observedAtUnixMilliseconds: bigint;
}

export interface PackageLifecycleRecordResult {
  readonly receipt: PackageLifecycleReceipt;
  readonly created: boolean;
}

export interface PackageLifecycleStore {
  recordEvent(intent: PackageLifecycleEventIntentInput): PackageLifecycleRecordResult;
  getAttempt(attemptId: string): PackageLifecycleAttempt | undefined;
  getReceiptByEventId(eventId: string): PackageLifecycleReceipt | undefined;
  listReceipts(
    attemptId: string,
    afterRevision: bigint,
    limit: number,
  ): readonly PackageLifecycleReceipt[];
  close(): void;
}

export type PackageLifecycleClock = () => bigint;

export interface PackageLifecycleStoreOptions {
  readonly clock?: PackageLifecycleClock;
}

export class PackageLifecycleStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PackageLifecycleStoreError";
    this.code = code;
  }
}

export class PackageLifecycleEventConflictError extends PackageLifecycleStoreError {
  constructor(eventId: string) {
    super(
      "EVENT_ID_CONFLICT",
      `Event ID "${eventId}" was already recorded with a different intent commitment.`,
    );
    this.name = "PackageLifecycleEventConflictError";
  }
}

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const HASH_BYTES = 32;
const MAX_LIST_LIMIT = 100;
const U64_MAX = (1n << 64n) - 1n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS package_lifecycle_events (
  event_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  prior_state TEXT,
  previous_receipt_hash BLOB,
  next_state TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  domain_id TEXT NOT NULL,
  domain_manifest_version INTEGER NOT NULL,
  domain_manifest_hash BLOB NOT NULL,
  settlement_class TEXT NOT NULL,
  package_id TEXT NOT NULL,
  package_commitment BLOB NOT NULL,
  evidence_grade TEXT NOT NULL,
  onchain_enforced INTEGER NOT NULL CHECK (onchain_enforced IN (0, 1)),
  evidence_source_id TEXT NOT NULL,
  evidence_source_version INTEGER NOT NULL,
  evidence_source_hash BLOB NOT NULL,
  evidence_commitment BLOB NOT NULL,
  intent_commitment BLOB NOT NULL,
  receipt_hash BLOB NOT NULL UNIQUE,
  UNIQUE (attempt_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_attempt_revision
  ON package_lifecycle_events (attempt_id, revision);
CREATE TABLE IF NOT EXISTS package_lifecycle_heads (
  attempt_id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  package_commitment BLOB NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  receipt_hash BLOB NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  observed_at_ms INTEGER NOT NULL,
  FOREIGN KEY (event_id) REFERENCES package_lifecycle_events(event_id)
);
CREATE TRIGGER IF NOT EXISTS reject_lifecycle_event_update
  BEFORE UPDATE ON package_lifecycle_events
  BEGIN
    SELECT RAISE(ABORT, 'package lifecycle events are append-only');
  END;
CREATE TRIGGER IF NOT EXISTS reject_lifecycle_event_delete
  BEFORE DELETE ON package_lifecycle_events
  BEGIN
    SELECT RAISE(ABORT, 'package lifecycle events are append-only');
  END;
`;

interface EventRow {
  readonly event_id: unknown;
  readonly attempt_id: unknown;
  readonly revision: unknown;
  readonly prior_state: unknown;
  readonly previous_receipt_hash: unknown;
  readonly next_state: unknown;
  readonly observed_at_ms: unknown;
  readonly domain_id: unknown;
  readonly domain_manifest_version: unknown;
  readonly domain_manifest_hash: unknown;
  readonly settlement_class: unknown;
  readonly package_id: unknown;
  readonly package_commitment: unknown;
  readonly evidence_grade: unknown;
  readonly onchain_enforced: unknown;
  readonly evidence_source_id: unknown;
  readonly evidence_source_version: unknown;
  readonly evidence_source_hash: unknown;
  readonly evidence_commitment: unknown;
  readonly intent_commitment: unknown;
  readonly receipt_hash: unknown;
}

interface HeadRow {
  readonly attempt_id: unknown;
  readonly package_id: unknown;
  readonly package_commitment: unknown;
  readonly revision: unknown;
  readonly state: unknown;
  readonly receipt_hash: unknown;
  readonly event_id: unknown;
  readonly observed_at_ms: unknown;
}

let cachedRepositoryRoot: string | undefined;
let repositoryRootResolved = false;

function repositoryRoot(): string | undefined {
  if (repositoryRootResolved) {
    return cachedRepositoryRoot;
  }
  repositoryRootResolved = true;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      cachedRepositoryRoot = dir;
      return cachedRepositoryRoot;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function requireDatabasePath(dbPath: string): string {
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    throw new PackageLifecycleStoreError("INVALID_PATH", "Database path must be a nonempty string.");
  }
  if (dbPath === ":memory:") {
    throw new PackageLifecycleStoreError(
      "INVALID_PATH",
      "Memory databases are not durable; provide an explicit file path.",
    );
  }
  if (!isAbsolute(dbPath)) {
    throw new PackageLifecycleStoreError("INVALID_PATH", "Database path must be absolute.");
  }
  const resolved = resolve(dbPath);
  const root = repositoryRoot();
  if (root !== undefined) {
    const normalizedRoot = resolve(root);
    if (resolved === normalizedRoot || resolved.startsWith(normalizedRoot + sep)) {
      throw new PackageLifecycleStoreError(
        "INVALID_PATH",
        "Database path must remain outside the repository checkout.",
      );
    }
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireIdString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new PackageLifecycleStoreError("INVALID_INPUT", `${field} is invalid.`);
  }
  return value;
}

function requireHashBytes(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", `Stored ${field} is invalid.`);
  }
  return Uint8Array.from(value);
}

function requireNonzeroHash(value: unknown, field: string): Uint8Array {
  const bytes = requireHashBytes(value, field);
  if (bytes.every((byte) => byte === 0)) {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", `Stored ${field} is all zero.`);
  }
  return bytes;
}

function toSafeNumber(value: bigint, field: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new PackageLifecycleStoreError(
      "INVALID_INPUT",
      `${field} is outside the storable safe-integer range.`,
    );
  }
  return Number(value);
}

function fromStorageInteger(value: unknown, field: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", `Stored ${field} is invalid.`);
  }
  return BigInt(value);
}

function fromStorageRevision(value: unknown): bigint {
  return fromStorageInteger(value, "revision");
}

function fromStorageTimestamp(value: unknown): bigint {
  return fromStorageInteger(value, "observed_at_ms");
}

function requireVersionNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", `Stored ${field} is invalid.`);
  }
  return value;
}

function normalizeHashInput(value: Uint8Array | string, field: string): Uint8Array {
  if (typeof value === "string") {
    try {
      const bytes = fromHex(value, field);
      if (bytes.length !== HASH_BYTES) {
        throw new PackageLifecycleStoreError("INVALID_HASH", `${field} must be ${HASH_BYTES} bytes.`);
      }
      return bytes;
    } catch (error) {
      if (error instanceof PackageLifecycleStoreError) {
        throw error;
      }
      throw new PackageLifecycleStoreError("INVALID_HASH", `${field} is not valid hex.`);
    }
  }
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new PackageLifecycleStoreError("INVALID_HASH", `${field} must be ${HASH_BYTES} bytes.`);
  }
  return Uint8Array.from(value);
}

function rowToReceipt(row: EventRow): PackageLifecycleReceipt {
  const eventId = requireIdString(row.event_id, "event_id");
  const attemptId = requireIdString(row.attempt_id, "attempt_id");
  const packageId = requireIdString(row.package_id, "package_id");
  const domainId = requireIdString(row.domain_id, "domain_id");
  const evidenceSourceId = requireIdString(row.evidence_source_id, "evidence_source_id");
  const revision = fromStorageRevision(row.revision);
  const observedAt = fromStorageTimestamp(row.observed_at_ms);
  const domainManifestVersion = requireVersionNumber(row.domain_manifest_version, "domain_manifest_version");
  const evidenceSourceVersion = requireVersionNumber(row.evidence_source_version, "evidence_source_version");
  const domainManifestHash = requireNonzeroHash(row.domain_manifest_hash, "domain_manifest_hash");
  const packageCommitment = requireNonzeroHash(row.package_commitment, "package_commitment");
  const evidenceSourceHash = requireNonzeroHash(row.evidence_source_hash, "evidence_source_hash");
  const evidenceCommitment = requireNonzeroHash(row.evidence_commitment, "evidence_commitment");
  const intentCommitment = requireNonzeroHash(row.intent_commitment, "intent_commitment");
  const receiptHash = requireNonzeroHash(row.receipt_hash, "receipt_hash");
  if (typeof row.next_state !== "string" || row.next_state.length === 0) {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", "Stored next_state is invalid.");
  }
  if (typeof row.settlement_class !== "string" || row.settlement_class.length === 0) {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", "Stored settlement_class is invalid.");
  }
  if (typeof row.evidence_grade !== "string" || row.evidence_grade.length === 0) {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", "Stored evidence_grade is invalid.");
  }
  if (row.onchain_enforced !== 0 && row.onchain_enforced !== 1) {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", "Stored onchain_enforced is invalid.");
  }
  let priorState: PackageLifecycleState | undefined;
  if (row.prior_state !== null) {
    if (typeof row.prior_state !== "string" || row.prior_state.length === 0) {
      throw new PackageLifecycleStoreError("CORRUPT_ROW", "Stored prior_state is invalid.");
    }
    priorState = row.prior_state as PackageLifecycleState;
  }
  let previousReceiptHash: Uint8Array | undefined;
  if (row.previous_receipt_hash !== null) {
    previousReceiptHash = requireNonzeroHash(row.previous_receipt_hash, "previous_receipt_hash");
  }
  if ((priorState === undefined) !== (previousReceiptHash === undefined)) {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", "Stored receipt chain linkage is invalid.");
  }
  let receipt: PackageLifecycleReceipt;
  try {
    const input: Record<string, unknown> = {
      version: 1,
      domain: {
        domainId,
        domainManifestVersion,
        domainManifestHash,
      },
      settlementClass: row.settlement_class,
      packageId,
      packageCommitment,
      attemptId,
      eventId,
      revision,
      nextState: row.next_state,
      observedAtUnixMilliseconds: observedAt,
      evidenceGrade: row.evidence_grade,
      onchainEnforced: row.onchain_enforced === 1,
      evidenceSource: {
        subjectId: evidenceSourceId,
        manifestVersion: evidenceSourceVersion,
        manifestHash: evidenceSourceHash,
      },
      evidenceCommitment,
    };
    if (priorState !== undefined) {
      input["priorState"] = priorState;
    }
    if (previousReceiptHash !== undefined) {
      input["previousReceiptHash"] = previousReceiptHash;
    }
    receipt = packageLifecycleReceipt(
      input as unknown as Parameters<typeof packageLifecycleReceipt>[0],
      "storedReceipt",
    );
  } catch {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", "Stored receipt failed validation.");
  }
  const recomputed = packageLifecycleReceiptHash(receipt);
  if (!bytesEqual(recomputed, receiptHash)) {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", "Stored receipt hash does not match.");
  }
  const expectedRevision = revision - 1n;
  try {
    const intent = packageLifecycleEventIntent(
      {
        version: 1,
        domain: receipt.domain,
        settlementClass: receipt.settlementClass,
        packageId: receipt.packageId,
        packageCommitment: receipt.packageCommitment,
        attemptId: receipt.attemptId,
        eventId: receipt.eventId,
        expectedRevision,
        nextState: receipt.nextState,
        evidenceGrade: receipt.evidenceGrade,
        onchainEnforced: receipt.onchainEnforced,
        evidenceSource: receipt.evidenceSource,
        evidenceCommitment: receipt.evidenceCommitment,
      },
      "storedIntent",
    );
    if (!bytesEqual(packageLifecycleEventIntentCommitment(intent), intentCommitment)) {
      throw new PackageLifecycleStoreError("CORRUPT_ROW", "Stored intent commitment does not match.");
    }
  } catch (error) {
    if (error instanceof PackageLifecycleStoreError) {
      throw error;
    }
    throw new PackageLifecycleStoreError("CORRUPT_ROW", "Stored intent failed validation.");
  }
  return receipt;
}

function requireHeadId(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", `Stored ${field} is invalid.`);
  }
  try {
    return protocolId(value, field);
  } catch {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", `Stored ${field} is invalid.`);
  }
}

function requireHeadState(value: unknown): PackageLifecycleState {
  if (typeof value !== "string") {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", "Stored head state is invalid.");
  }
  try {
    enumDiscriminant(PACKAGE_LIFECYCLE_STATE, value as PackageLifecycleState, "headState");
  } catch {
    throw new PackageLifecycleStoreError("CORRUPT_ROW", "Stored head state is invalid.");
  }
  return value as PackageLifecycleState;
}

function rowToHead(row: HeadRow): PackageLifecycleAttempt {
  const attemptId = requireHeadId(row.attempt_id, "attempt_id");
  const packageId = requireHeadId(row.package_id, "package_id");
  const eventId = requireHeadId(row.event_id, "event_id");
  const packageCommitment = requireNonzeroHash(row.package_commitment, "package_commitment");
  const receiptHash = requireNonzeroHash(row.receipt_hash, "receipt_hash");
  const revision = fromStorageRevision(row.revision);
  const observedAt = fromStorageTimestamp(row.observed_at_ms);
  const state = requireHeadState(row.state);
  return Object.freeze({
    attemptId,
    packageId,
    packageCommitmentHex: toHex(packageCommitment),
    revision,
    state,
    receiptHashHex: toHex(receiptHash),
    eventId,
    observedAtUnixMilliseconds: observedAt,
  });
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as unknown as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

function defaultClock(): bigint {
  return BigInt(Date.now());
}

function requireClockValue(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > U64_MAX) {
    throw new PackageLifecycleStoreError("INVALID_TIMESTAMP", "Lifecycle clock value is invalid.");
  }
  if (value > MAX_SAFE_BIGINT) {
    throw new PackageLifecycleStoreError(
      "INVALID_TIMESTAMP",
      "Lifecycle clock value is outside the storable range.",
    );
  }
  return value;
}

export class SqlitePackageLifecycleStore implements PackageLifecycleStore {
  private readonly db: Database.Database;
  private readonly clock: PackageLifecycleClock;
  private readonly selectEventById: Database.Statement;
  private readonly selectHeadByAttempt: Database.Statement;
  private readonly selectByAttemptAfter: Database.Statement;
  private readonly insertEvent: Database.Statement;
  private readonly upsertHead: Database.Statement;
  private readonly recordTxn: (intent: PackageLifecycleEventIntentInput) => PackageLifecycleRecordResult;

  private verifiedHead(row: HeadRow): PackageLifecycleAttempt {
    const head = rowToHead(row);
    const eventRow = this.selectEventById.get(head.eventId) as EventRow | undefined;
    if (eventRow === undefined) {
      throw new PackageLifecycleStoreError("CORRUPT_ROW", "Head event is missing.");
    }
    const receipt = rowToReceipt(eventRow);
    const receiptHash = packageLifecycleReceiptHash(receipt);
    if (
      receipt.attemptId !== head.attemptId ||
      receipt.packageId !== head.packageId ||
      toHex(receipt.packageCommitment) !== head.packageCommitmentHex ||
      receipt.revision !== head.revision ||
      receipt.nextState !== head.state ||
      toHex(receiptHash) !== head.receiptHashHex ||
      receipt.eventId !== head.eventId ||
      receipt.observedAtUnixMilliseconds !== head.observedAtUnixMilliseconds
    ) {
      throw new PackageLifecycleStoreError("CORRUPT_ROW", "Head does not match its event.");
    }
    return head;
  }

  constructor(dbPath: string, options?: PackageLifecycleStoreOptions) {
    const resolved = requireDatabasePath(dbPath);
    if (options !== undefined && (typeof options !== "object" || options === null)) {
      throw new PackageLifecycleStoreError("INVALID_INPUT", "Store options must be an object.");
    }
    const clock: PackageLifecycleClock = options?.clock ?? defaultClock;
    if (typeof clock !== "function") {
      throw new PackageLifecycleStoreError("INVALID_INPUT", "Lifecycle clock must be a function.");
    }
    mkdirSync(dirname(resolved), { recursive: true });
    const db = new Database(resolved);
    try {
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const journalMode = db.pragma("journal_mode = WAL", { simple: true });
      if (typeof journalMode !== "string" || journalMode.toLowerCase() !== "wal") {
        throw new PackageLifecycleStoreError(
          "PRAGMA_FAILED",
          "WAL journal mode is unavailable for the lifecycle database.",
        );
      }
      db.pragma("synchronous = FULL");
      db.pragma("foreign_keys = ON");
      if (db.pragma("synchronous", { simple: true }) !== 2 ||
          db.pragma("foreign_keys", { simple: true }) !== 1) {
        throw new PackageLifecycleStoreError(
          "PRAGMA_FAILED",
          "Durability pragmas were not applied to the lifecycle database.",
        );
      }
      db.exec(SCHEMA_SQL);
      const userVersion = db.pragma("user_version", { simple: true });
      if (userVersion === 0) {
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (userVersion !== SCHEMA_VERSION) {
        throw new PackageLifecycleStoreError(
          "SCHEMA_MISMATCH",
          `Lifecycle database schema version ${String(userVersion)} is unsupported.`,
        );
      }
      this.db = db;
      this.clock = clock;
      this.selectEventById = db.prepare("SELECT * FROM package_lifecycle_events WHERE event_id = ?");
      this.selectHeadByAttempt = db.prepare("SELECT * FROM package_lifecycle_heads WHERE attempt_id = ?");
      this.selectByAttemptAfter = db.prepare(
        "SELECT * FROM package_lifecycle_events WHERE attempt_id = ? AND revision > ? ORDER BY revision ASC LIMIT ?",
      );
      this.insertEvent = db.prepare(
        "INSERT INTO package_lifecycle_events (event_id, attempt_id, revision, prior_state, previous_receipt_hash, next_state, observed_at_ms, domain_id, domain_manifest_version, domain_manifest_hash, settlement_class, package_id, package_commitment, evidence_grade, onchain_enforced, evidence_source_id, evidence_source_version, evidence_source_hash, evidence_commitment, intent_commitment, receipt_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      this.upsertHead = db.prepare(
        "INSERT INTO package_lifecycle_heads (attempt_id, package_id, package_commitment, revision, state, receipt_hash, event_id, observed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET package_id = excluded.package_id, package_commitment = excluded.package_commitment, revision = excluded.revision, state = excluded.state, receipt_hash = excluded.receipt_hash, event_id = excluded.event_id, observed_at_ms = excluded.observed_at_ms",
      );
      this.recordTxn = db.transaction((intentInput: PackageLifecycleEventIntentInput): PackageLifecycleRecordResult => {
        let intent;
        try {
          intent = packageLifecycleEventIntent(intentInput, "lifecycleIntent");
        } catch {
          throw new PackageLifecycleStoreError("INVALID_INPUT", "Lifecycle intent failed validation.");
        }
        const intentCommitment = packageLifecycleEventIntentCommitment(intent);
        const existing = this.selectEventById.get(intent.eventId) as EventRow | undefined;
        if (existing !== undefined) {
          const receipt = rowToReceipt(existing);
          const storedIntent = existing.intent_commitment;
          if (!(storedIntent instanceof Uint8Array) || !bytesEqual(Uint8Array.from(storedIntent), intentCommitment)) {
            throw new PackageLifecycleEventConflictError(intent.eventId);
          }
          return Object.freeze({ receipt, created: false });
        }
        const headRow = this.selectHeadByAttempt.get(intent.attemptId) as HeadRow | undefined;
        let revision: bigint;
        let priorState: PackageLifecycleState | undefined;
        let previousHash: CommitmentHash | undefined;
        if (headRow === undefined) {
          if (intent.expectedRevision !== 0n) {
            throw new PackageLifecycleStoreError(
              "INVALID_REVISION",
              "First event for an attempt must carry expected revision zero.",
            );
          }
          if (intent.nextState !== "PACKAGE_CREATED") {
            throw new PackageLifecycleStoreError(
              "INVALID_TRANSITION",
              "First event for an attempt must move to PACKAGE_CREATED.",
            );
          }
          revision = 1n;
        } else {
          const head = this.verifiedHead(headRow);
          if (head.packageId !== intent.packageId ||
              head.packageCommitmentHex !== toHex(intent.packageCommitment)) {
            throw new PackageLifecycleStoreError(
              "PACKAGE_MISMATCH",
              "Package binding is immutable within an attempt.",
            );
          }
          if (intent.expectedRevision !== head.revision) {
            throw new PackageLifecycleStoreError(
              "STALE_REVISION",
              "Expected revision does not match the attempt head.",
            );
          }
          if (isTerminalPackageLifecycleState(head.state)) {
            throw new PackageLifecycleStoreError(
              "TERMINAL_STATE",
              "No event can be appended after a terminal state.",
            );
          }
          try {
            assertPackageLifecycleTransition(head.state, intent.nextState, "lifecycleTransition");
          } catch {
            throw new PackageLifecycleStoreError(
              "INVALID_TRANSITION",
              `Transition from ${head.state} to ${intent.nextState} is not permitted.`,
            );
          }
          revision = head.revision + 1n;
          if (revision > U64_MAX) {
            throw new PackageLifecycleStoreError("INVALID_REVISION", "Revision overflow.");
          }
          priorState = head.state;
          previousHash = normalizeHashInput(head.receiptHashHex, "previousReceiptHash") as CommitmentHash;
        }
        const observedAt = requireClockValue(this.clock());
        let receipt: PackageLifecycleReceipt;
        try {
          const receiptInput: Record<string, unknown> = {
            version: 1,
            domain: intent.domain,
            settlementClass: intent.settlementClass,
            packageId: intent.packageId,
            packageCommitment: intent.packageCommitment,
            attemptId: intent.attemptId,
            eventId: intent.eventId,
            revision,
            nextState: intent.nextState,
            observedAtUnixMilliseconds: observedAt,
            evidenceGrade: intent.evidenceGrade,
            onchainEnforced: intent.onchainEnforced,
            evidenceSource: intent.evidenceSource,
            evidenceCommitment: intent.evidenceCommitment,
          };
          if (priorState !== undefined) {
            receiptInput["priorState"] = priorState;
          }
          if (previousHash !== undefined) {
            receiptInput["previousReceiptHash"] = previousHash;
          }
          receipt = packageLifecycleReceipt(
            receiptInput as unknown as Parameters<typeof packageLifecycleReceipt>[0],
            "lifecycleReceipt",
          );
        } catch (error) {
          if (error instanceof PackageLifecycleStoreError) {
            throw error;
          }
          throw new PackageLifecycleStoreError("INVALID_INPUT", "Lifecycle receipt failed validation.");
        }
        const receiptHash = packageLifecycleReceiptHash(receipt);
        const revisionNumber = toSafeNumber(revision, "revision");
        const observedNumber = toSafeNumber(observedAt, "observedAtUnixMilliseconds");
        try {
          this.insertEvent.run(
            intent.eventId,
            intent.attemptId,
            revisionNumber,
            priorState ?? null,
            previousHash === undefined ? null : Buffer.from(previousHash),
            intent.nextState,
            observedNumber,
            intent.domain.domainId,
            intent.domain.domainManifestVersion,
            Buffer.from(intent.domain.domainManifestHash),
            intent.settlementClass,
            intent.packageId,
            Buffer.from(intent.packageCommitment),
            intent.evidenceGrade,
            intent.onchainEnforced ? 1 : 0,
            intent.evidenceSource.subjectId,
            intent.evidenceSource.manifestVersion,
            Buffer.from(intent.evidenceSource.manifestHash),
            Buffer.from(intent.evidenceCommitment),
            Buffer.from(intentCommitment),
            Buffer.from(receiptHash),
          );
          this.upsertHead.run(
            intent.attemptId,
            intent.packageId,
            Buffer.from(intent.packageCommitment),
            revisionNumber,
            intent.nextState,
            Buffer.from(receiptHash),
            intent.eventId,
            observedNumber,
          );
        } catch (error) {
          if (isConstraintError(error)) {
            const raced = this.selectEventById.get(intent.eventId) as EventRow | undefined;
            if (raced !== undefined) {
              const receipt = rowToReceipt(raced);
              const storedIntent = raced.intent_commitment;
              if (!(storedIntent instanceof Uint8Array) ||
                  !bytesEqual(Uint8Array.from(storedIntent), intentCommitment)) {
                throw new PackageLifecycleEventConflictError(intent.eventId);
              }
              return Object.freeze({ receipt, created: false });
            }
            throw new PackageLifecycleStoreError(
              "STALE_REVISION",
              "Concurrent append changed the attempt head.",
            );
          }
          throw error;
        }
        return Object.freeze({ receipt, created: true });
      });
    } catch (error) {
      db.close();
      throw error;
    }
  }

  recordEvent(intent: PackageLifecycleEventIntentInput): PackageLifecycleRecordResult {
    if (!isRecord(intent)) {
      throw new PackageLifecycleStoreError("INVALID_INPUT", "Lifecycle intent must be an object.");
    }
    return this.recordTxn(intent);
  }

  getAttempt(attemptId: string): PackageLifecycleAttempt | undefined {
    requireIdString(attemptId, "attemptId");
    const row = this.selectHeadByAttempt.get(attemptId) as HeadRow | undefined;
    return row === undefined ? undefined : this.verifiedHead(row);
  }

  getReceiptByEventId(eventId: string): PackageLifecycleReceipt | undefined {
    requireIdString(eventId, "eventId");
    const row = this.selectEventById.get(eventId) as EventRow | undefined;
    return row === undefined ? undefined : rowToReceipt(row);
  }

  listReceipts(
    attemptId: string,
    afterRevision: bigint,
    limit: number,
  ): readonly PackageLifecycleReceipt[] {
    requireIdString(attemptId, "attemptId");
    if (typeof afterRevision !== "bigint" || afterRevision < 0n || afterRevision > U64_MAX) {
      throw new PackageLifecycleStoreError("INVALID_INPUT", "Cursor revision is invalid.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new PackageLifecycleStoreError("INVALID_INPUT", `Limit must be within 1..${MAX_LIST_LIMIT}.`);
    }
    if (afterRevision > MAX_SAFE_BIGINT) {
      return Object.freeze([]);
    }
    const rows = this.selectByAttemptAfter.all(
      attemptId,
      Number(afterRevision),
      limit,
    ) as EventRow[];
    return Object.freeze(rows.map((row) => rowToReceipt(row)));
  }

  close(): void {
    this.db.close();
  }
}
