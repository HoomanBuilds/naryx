import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { bytesEqual, fromHex, packageOrderBytes, packageOrderHash, parseProtocolJson, stringifyProtocolJson, toHex, validatePackageOrderProfile } from "@naryx/protocol-types";
import type { PackageOrder, PackageOrderInput } from "@naryx/protocol-types";
import type {
  CanonicalEntryOrder,
  CanonicalEntryRequest,
} from "./canonical-entry-order.js";

export type InternalOrderStatus = "UNSIGNED_CREATED";

export interface InternalOrderRecord {
  readonly idempotencyKey: string;
  readonly requestCommitmentHex: string;
  readonly orderHashHex: string;
  readonly orderBase64: string;
  readonly contextId: string;
  readonly domainId: string;
  readonly domainManifestVersion: number;
  readonly domainManifestHashHex: string;
  readonly owner: string;
  readonly settlementAccount: string;
  readonly nonceDecimal: string;
  readonly status: InternalOrderStatus;
  readonly createdAtMs: number;
}

export interface InternalOrderInput {
  readonly order: CanonicalEntryOrder;
  readonly request: CanonicalEntryRequest;
}

export interface InternalOrderCreateResult {
  readonly record: InternalOrderRecord;
  readonly created: boolean;
}

export interface InternalOrderStore {
  createOrGet(input: InternalOrderInput): InternalOrderCreateResult;
  getByOrderHash(orderHash: Uint8Array | string): InternalOrderRecord | undefined;
  getByIdempotencyKey(idempotencyKey: string): InternalOrderRecord | undefined;
  getCanonicalOrderByHash(orderHash: Uint8Array | string): PackageOrder | undefined;
  close(): void;
}

export class InternalOrderStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InternalOrderStoreError";
    this.code = code;
  }
}

export class InternalOrderConflictError extends InternalOrderStoreError {
  constructor(idempotencyKey: string) {
    super(
      "IDEMPOTENCY_CONFLICT",
      `Idempotency key "${idempotencyKey}" was already used with a different request commitment.`,
    );
    this.name = "InternalOrderConflictError";
  }
}

const SCHEMA_VERSION = 2;
const BUSY_TIMEOUT_MS = 5_000;
const HASH_BYTES = 32;
const ORDER_STATUS: InternalOrderStatus = "UNSIGNED_CREATED";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;
const NONCE_PATTERN = /^[0-9]+$/;
const U256_MAX = (1n << 256n) - 1n;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS internal_orders (
  idempotency_key TEXT PRIMARY KEY,
  request_commitment BLOB NOT NULL UNIQUE,
  order_hash BLOB NOT NULL UNIQUE,
  order_bytes BLOB NOT NULL,
  order_json TEXT,
  context_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  domain_manifest_version INTEGER NOT NULL,
  domain_manifest_hash BLOB NOT NULL,
  owner TEXT NOT NULL,
  settlement_account TEXT NOT NULL,
  nonce_decimal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'UNSIGNED_CREATED'),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (domain_id, domain_manifest_version, domain_manifest_hash, nonce_decimal)
);
`;

interface OrderRow {
  readonly idempotency_key: unknown;
  readonly request_commitment: unknown;
  readonly order_hash: unknown;
  readonly order_bytes: unknown;
  readonly order_json: unknown;
  readonly context_id: unknown;
  readonly domain_id: unknown;
  readonly domain_manifest_version: unknown;
  readonly domain_manifest_hash: unknown;
  readonly owner: unknown;
  readonly settlement_account: unknown;
  readonly nonce_decimal: unknown;
  readonly status: unknown;
  readonly created_at_ms: unknown;
}

interface ParsedOrderInput {
  readonly idempotencyKey: string;
  readonly requestCommitment: Uint8Array;
  readonly requestCommitmentHex: string;
  readonly orderHash: Uint8Array;
  readonly orderHashHex: string;
  readonly orderBytes: Uint8Array;
  readonly orderJson: string;
  readonly contextId: string;
  readonly domainId: string;
  readonly domainManifestVersion: number;
  readonly domainManifestHash: Uint8Array;
  readonly domainManifestHashHex: string;
  readonly owner: string;
  readonly settlementAccount: string;
  readonly nonceDecimal: string;
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
    throw new InternalOrderStoreError("INVALID_PATH", "Database path must be a nonempty string.");
  }
  if (dbPath === ":memory:") {
    throw new InternalOrderStoreError(
      "INVALID_PATH",
      "Memory databases are not durable; provide an explicit file path.",
    );
  }
  if (!isAbsolute(dbPath)) {
    throw new InternalOrderStoreError("INVALID_PATH", "Database path must be absolute.");
  }
  const resolved = resolve(dbPath);
  const root = repositoryRoot();
  if (root !== undefined) {
    const normalizedRoot = resolve(root);
    if (resolved === normalizedRoot || resolved.startsWith(normalizedRoot + sep)) {
      throw new InternalOrderStoreError(
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

function requireHashBytes(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new InternalOrderStoreError("INVALID_INPUT", `${field} must be ${HASH_BYTES} bytes.`);
  }
  return Uint8Array.from(value);
}

function requireOwnerString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new InternalOrderStoreError("INVALID_INPUT", `${field} is invalid.`);
  }
  return value;
}

function parseStoreInput(input: InternalOrderInput): ParsedOrderInput {
  if (!isRecord(input)) {
    throw new InternalOrderStoreError("INVALID_INPUT", "Store input must be an object.");
  }
  const { order, request } = input;
  if (!isRecord(order) || !isRecord(request)) {
    throw new InternalOrderStoreError("INVALID_INPUT", "Store input must carry an order and a request.");
  }
  if (typeof request.contextId !== "string" || !CONTEXT_ID_PATTERN.test(request.contextId)) {
    throw new InternalOrderStoreError("INVALID_INPUT", "Request context ID is invalid.");
  }
  if (typeof request.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)) {
    throw new InternalOrderStoreError("INVALID_INPUT", "Request idempotency key is invalid.");
  }
  const requestCommitment = requireHashBytes(order.requestCommitment, "order.requestCommitment");
  const orderHash = requireHashBytes(order.orderHash, "order.orderHash");
  if (!(order.orderBytes instanceof Uint8Array) || order.orderBytes.length === 0) {
    throw new InternalOrderStoreError("INVALID_INPUT", "order.orderBytes must be nonempty bytes.");
  }
  const orderBytes = Uint8Array.from(order.orderBytes);
  if (!isRecord(order.order)) {
    throw new InternalOrderStoreError("INVALID_INPUT", "order.order must be an object.");
  }
  let validatedOrder: PackageOrderInput;
  try {
    validatedOrder = validatePackageOrderProfile(order.order as unknown as PackageOrderInput, "order.order");
  } catch {
    throw new InternalOrderStoreError("INVALID_INPUT", "order.order failed profile validation.");
  }
  if (!bytesEqual(packageOrderBytes(validatedOrder), orderBytes) ||
      !bytesEqual(packageOrderHash(validatedOrder), orderHash)) {
    throw new InternalOrderStoreError(
      "INVALID_INPUT",
      "order.orderBytes and order.orderHash must match the validated order.",
    );
  }
  const domain = order.order.domain;
  if (!isRecord(domain)) {
    throw new InternalOrderStoreError("INVALID_INPUT", "order domain must be an object.");
  }
  if (typeof domain.domainId !== "string" || domain.domainId.length === 0 || domain.domainId.length > 128) {
    throw new InternalOrderStoreError("INVALID_INPUT", "order domain ID is invalid.");
  }
  if (!Number.isSafeInteger(domain.domainManifestVersion) ||
      (domain.domainManifestVersion as number) < 1) {
    throw new InternalOrderStoreError("INVALID_INPUT", "order domain manifest version is invalid.");
  }
  if (!(domain.domainManifestHash instanceof Uint8Array) ||
      domain.domainManifestHash.length !== HASH_BYTES ||
      domain.domainManifestHash.every((byte) => byte === 0)) {
    throw new InternalOrderStoreError("INVALID_INPUT", "order domain manifest hash is invalid.");
  }
  const owner = requireOwnerString(order.order.owner, "order.owner");
  const settlementAccount = requireOwnerString(order.order.settlementAccount, "order.settlementAccount");
  if (request.owner !== owner || request.settlementAccount !== settlementAccount) {
    throw new InternalOrderStoreError(
      "INVALID_INPUT",
      "Request owner and settlement account must match the canonical order.",
    );
  }
  if (typeof order.order.nonce !== "bigint" || order.order.nonce <= 0n || order.order.nonce > U256_MAX) {
    throw new InternalOrderStoreError("INVALID_INPUT", "order nonce is invalid.");
  }
  return {
    idempotencyKey: request.idempotencyKey,
    requestCommitment,
    requestCommitmentHex: toHex(requestCommitment),
    orderHash,
    orderHashHex: toHex(orderHash),
    orderBytes,
    orderJson: stringifyProtocolJson(validatedOrder, "order.order"),
    contextId: request.contextId,
    domainId: domain.domainId,
    domainManifestVersion: domain.domainManifestVersion as number,
    domainManifestHash: Uint8Array.from(domain.domainManifestHash),
    domainManifestHashHex: toHex(domain.domainManifestHash),
    owner,
    settlementAccount,
    nonceDecimal: (order.order.nonce as bigint).toString(10),
  };
}

function normalizeHashInput(value: Uint8Array | string, field: string): Uint8Array {
  if (typeof value === "string") {
    try {
      const bytes = fromHex(value, field);
      if (bytes.length !== HASH_BYTES) {
        throw new InternalOrderStoreError("INVALID_HASH", `${field} must be ${HASH_BYTES} bytes.`);
      }
      return bytes;
    } catch (error) {
      if (error instanceof InternalOrderStoreError) {
        throw error;
      }
      throw new InternalOrderStoreError("INVALID_HASH", `${field} is not valid hex.`);
    }
  }
  return requireHashBytes(value, field);
}

function rowToRecord(row: OrderRow): InternalOrderRecord {
  if (typeof row.idempotency_key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(row.idempotency_key)) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored idempotency key is invalid.");
  }
  if (!(row.request_commitment instanceof Uint8Array) || row.request_commitment.length !== HASH_BYTES ||
      row.request_commitment.every((byte) => byte === 0)) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored request commitment is invalid.");
  }
  if (!(row.order_hash instanceof Uint8Array) || row.order_hash.length !== HASH_BYTES ||
      row.order_hash.every((byte) => byte === 0)) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored order hash is invalid.");
  }
  if (!(row.order_bytes instanceof Uint8Array) || row.order_bytes.length === 0) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored order bytes are invalid.");
  }
  if (typeof row.context_id !== "string" || !CONTEXT_ID_PATTERN.test(row.context_id)) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored context ID is invalid.");
  }
  if (typeof row.domain_id !== "string" || row.domain_id.length === 0 || row.domain_id.length > 128) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored domain ID is invalid.");
  }
  if (!Number.isSafeInteger(row.domain_manifest_version) ||
      (row.domain_manifest_version as number) < 1) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored domain manifest version is invalid.");
  }
  if (!(row.domain_manifest_hash instanceof Uint8Array) ||
      row.domain_manifest_hash.length !== HASH_BYTES ||
      row.domain_manifest_hash.every((byte) => byte === 0)) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored domain manifest hash is invalid.");
  }
  if (typeof row.owner !== "string" || row.owner.length === 0 || row.owner.length > 128) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored owner is invalid.");
  }
  if (typeof row.settlement_account !== "string" ||
      row.settlement_account.length === 0 ||
      row.settlement_account.length > 128) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored settlement account is invalid.");
  }
  if (typeof row.nonce_decimal !== "string" || !NONCE_PATTERN.test(row.nonce_decimal)) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored nonce is invalid.");
  }
  const nonce = BigInt(row.nonce_decimal);
  if (nonce <= 0n || nonce > U256_MAX) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored nonce is out of range.");
  }
  if (row.status !== ORDER_STATUS) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored order status is invalid.");
  }
  if (!Number.isSafeInteger(row.created_at_ms) || (row.created_at_ms as number) <= 0) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored creation timestamp is invalid.");
  }
  return Object.freeze({
    idempotencyKey: row.idempotency_key,
    requestCommitmentHex: toHex(row.request_commitment),
    orderHashHex: toHex(row.order_hash),
    orderBase64: Buffer.from(row.order_bytes).toString("base64"),
    contextId: row.context_id,
    domainId: row.domain_id,
    domainManifestVersion: row.domain_manifest_version as number,
    domainManifestHashHex: toHex(row.domain_manifest_hash),
    owner: row.owner,
    settlementAccount: row.settlement_account,
    nonceDecimal: row.nonce_decimal,
    status: ORDER_STATUS,
    createdAtMs: row.created_at_ms as number,
  });
}

function rowToCanonicalOrder(row: OrderRow): PackageOrder {
  if (typeof row.order_json !== "string" || row.order_json.length === 0) {
    throw new InternalOrderStoreError(
      "ORDER_DOCUMENT_UNAVAILABLE",
      "Stored order predates canonical document persistence and must be replayed before quoting.",
    );
  }
  let order: PackageOrder;
  try {
    order = validatePackageOrderProfile(
      parseProtocolJson(row.order_json, "storedOrder") as PackageOrderInput,
      "storedOrder",
    );
  } catch {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored canonical order document is invalid.");
  }
  if (!(row.order_hash instanceof Uint8Array) || !(row.order_bytes instanceof Uint8Array)
    || !bytesEqual(packageOrderHash(order), row.order_hash)
    || !bytesEqual(packageOrderBytes(order), row.order_bytes)) {
    throw new InternalOrderStoreError("CORRUPT_ROW", "Stored canonical order document binding is invalid.");
  }
  return order;
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as unknown as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

export class SqliteInternalOrderStore implements InternalOrderStore {
  private readonly db: Database.Database;
  private readonly selectByKey: Database.Statement;
  private readonly selectByHash: Database.Statement;
  private readonly insertOrder: Database.Statement;
  private readonly updateOrderJson: Database.Statement;
  private readonly createOrGetTxn: (parsed: ParsedOrderInput) => InternalOrderCreateResult;

  constructor(dbPath: string) {
    const resolved = requireDatabasePath(dbPath);
    mkdirSync(dirname(resolved), { recursive: true });
    const db = new Database(resolved);
    try {
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const journalMode = db.pragma("journal_mode = WAL", { simple: true });
      if (typeof journalMode !== "string" || journalMode.toLowerCase() !== "wal") {
        throw new InternalOrderStoreError(
          "PRAGMA_FAILED",
          "WAL journal mode is unavailable for the order database.",
        );
      }
      db.pragma("synchronous = FULL");
      db.pragma("foreign_keys = ON");
      if (db.pragma("synchronous", { simple: true }) !== 2 ||
          db.pragma("foreign_keys", { simple: true }) !== 1) {
        throw new InternalOrderStoreError(
          "PRAGMA_FAILED",
          "Durability pragmas were not applied to the order database.",
        );
      }
      db.exec(SCHEMA_SQL);
      const userVersion = db.pragma("user_version", { simple: true });
      if (userVersion === 0) {
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (userVersion === 1) {
        const columns = db.prepare("PRAGMA table_info(internal_orders)").all() as Array<{ name?: unknown }>;
        if (!columns.some((column) => column.name === "order_json")) {
          db.exec("ALTER TABLE internal_orders ADD COLUMN order_json TEXT");
        }
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (userVersion !== SCHEMA_VERSION) {
        throw new InternalOrderStoreError(
          "SCHEMA_MISMATCH",
          `Order database schema version ${String(userVersion)} is unsupported.`,
        );
      }
      this.db = db;
      this.selectByKey = db.prepare("SELECT * FROM internal_orders WHERE idempotency_key = ?");
      this.selectByHash = db.prepare("SELECT * FROM internal_orders WHERE order_hash = ?");
      this.updateOrderJson = db.prepare(
        "UPDATE internal_orders SET order_json = ? WHERE idempotency_key = ? AND order_json IS NULL",
      );
      this.insertOrder = db.prepare(
        "INSERT INTO internal_orders (idempotency_key, request_commitment, order_hash, order_bytes, order_json, context_id, domain_id, domain_manifest_version, domain_manifest_hash, owner, settlement_account, nonce_decimal, status, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      this.createOrGetTxn = db.transaction((parsed: ParsedOrderInput): InternalOrderCreateResult => {
        const existing = this.selectByKey.get(parsed.idempotencyKey) as OrderRow | undefined;
        if (existing !== undefined) {
          const record = rowToRecord(existing);
          if (record.requestCommitmentHex !== parsed.requestCommitmentHex) {
            throw new InternalOrderConflictError(parsed.idempotencyKey);
          }
          if (existing.order_json === null) {
            this.updateOrderJson.run(parsed.orderJson, parsed.idempotencyKey);
          }
          const refreshed = this.selectByKey.get(parsed.idempotencyKey) as OrderRow;
          rowToCanonicalOrder(refreshed);
          return Object.freeze({ record: rowToRecord(refreshed), created: false });
        }
        const createdAtMs = Date.now();
        if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0) {
          throw new InternalOrderStoreError("INVALID_TIMESTAMP", "Creation timestamp is invalid.");
        }
        try {
          this.insertOrder.run(
            parsed.idempotencyKey,
            Buffer.from(parsed.requestCommitment),
            Buffer.from(parsed.orderHash),
            Buffer.from(parsed.orderBytes),
            parsed.orderJson,
            parsed.contextId,
            parsed.domainId,
            parsed.domainManifestVersion,
            Buffer.from(parsed.domainManifestHash),
            parsed.owner,
            parsed.settlementAccount,
            parsed.nonceDecimal,
            ORDER_STATUS,
            createdAtMs,
          );
        } catch (error) {
          if (isConstraintError(error)) {
            const raced = this.selectByKey.get(parsed.idempotencyKey) as OrderRow | undefined;
            if (raced !== undefined) {
              const record = rowToRecord(raced);
              if (record.requestCommitmentHex !== parsed.requestCommitmentHex) {
                throw new InternalOrderConflictError(parsed.idempotencyKey);
              }
              return Object.freeze({ record, created: false });
            }
            throw new InternalOrderStoreError(
              "DUPLICATE_ORDER",
              "Order identity is already stored under a different idempotency key.",
            );
          }
          throw error;
        }
        const record: InternalOrderRecord = Object.freeze({
          idempotencyKey: parsed.idempotencyKey,
          requestCommitmentHex: parsed.requestCommitmentHex,
          orderHashHex: parsed.orderHashHex,
          orderBase64: Buffer.from(parsed.orderBytes).toString("base64"),
          contextId: parsed.contextId,
          domainId: parsed.domainId,
          domainManifestVersion: parsed.domainManifestVersion,
          domainManifestHashHex: parsed.domainManifestHashHex,
          owner: parsed.owner,
          settlementAccount: parsed.settlementAccount,
          nonceDecimal: parsed.nonceDecimal,
          status: ORDER_STATUS,
          createdAtMs,
        });
        return Object.freeze({ record, created: true });
      });
    } catch (error) {
      db.close();
      throw error;
    }
  }

  createOrGet(input: InternalOrderInput): InternalOrderCreateResult {
    return this.createOrGetTxn(parseStoreInput(input));
  }

  getByOrderHash(orderHash: Uint8Array | string): InternalOrderRecord | undefined {
    const bytes = normalizeHashInput(orderHash, "orderHash");
    const row = this.selectByHash.get(Buffer.from(bytes)) as OrderRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  getByIdempotencyKey(idempotencyKey: string): InternalOrderRecord | undefined {
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new InternalOrderStoreError("INVALID_KEY", "Idempotency key is invalid.");
    }
    const row = this.selectByKey.get(idempotencyKey) as OrderRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  getCanonicalOrderByHash(orderHash: Uint8Array | string): PackageOrder | undefined {
    const bytes = normalizeHashInput(orderHash, "orderHash");
    const row = this.selectByHash.get(Buffer.from(bytes)) as OrderRow | undefined;
    return row === undefined ? undefined : rowToCanonicalOrder(row);
  }

  close(): void {
    this.db.close();
  }
}
