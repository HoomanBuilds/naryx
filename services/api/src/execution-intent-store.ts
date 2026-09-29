import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import bs58 from "bs58";
import type { DomainRef } from "@naryx/protocol-types";
import type { InternalOrderRecord } from "./internal-order-store.js";
import {
  validateSolverAtomicQuoteResponse,
  type SolverAtomicQuoteResponse,
} from "./solver-quote-client.js";

const HASH = /^[0-9a-f]{64}$/;
const LOCAL_ATTEMPT_ID = /^local-atomic-[0-9a-f]{64}$/;
const BASE_ATTEMPT_ID = /^base-atomic-[0-9a-f]{52}$/;
const ARBITRUM_ATTEMPT_ID = /^arbitrum-async-[0-9a-f]{48}$/;
const BASE_SEPOLIA_DOMAIN_ID = "evm:base-sepolia";
const ARBITRUM_SEPOLIA_DOMAIN_ID = "eip155:421614";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface ExecutionAuthorization {
  readonly orderHash: string;
  readonly owner: string;
  readonly signature: string;
  readonly authorizedAtMs: number;
}

export interface LocalSelectedExecutionAttempt {
  readonly attemptId: string;
  readonly orderHash: string;
  readonly routeHash: string;
  readonly quoteHash: string;
  readonly status: "AUTHORIZED_QUOTE_SELECTED";
  readonly selectedAtMs: number;
}

export interface BaseSelectedExecutionAttempt {
  readonly attemptId: string;
  readonly orderHash: string;
  readonly routeHash: string;
  readonly quoteHash: string;
  readonly status: "BASE_ATOMIC_QUOTE_SELECTED";
  readonly selectedAtMs: number;
  readonly domainId: "evm:base-sepolia";
  readonly domainManifestVersion: number;
  readonly domainManifestHash: string;
}

export interface ArbitrumSelectedExecutionAttempt {
  readonly attemptId: string;
  readonly orderHash: string;
  readonly routeHash: string;
  readonly quoteHash: string;
  readonly status: "ARBITRUM_ASYNC_QUOTE_SELECTED";
  readonly selectedAtMs: number;
  readonly domainId: "eip155:421614";
  readonly domainManifestVersion: number;
  readonly domainManifestHash: string;
}

export type SelectedExecutionAttempt =
  | LocalSelectedExecutionAttempt
  | BaseSelectedExecutionAttempt
  | ArbitrumSelectedExecutionAttempt;

export type ExecutionSelectionKind = "SOLANA_AUTHORIZED" | "BASE_ATOMIC" | "ARBITRUM_ASYNC";

export interface ExecutionIntentStore {
  authorize(order: InternalOrderRecord, signature: string): ExecutionAuthorization;
  getAuthorization(orderHash: string): ExecutionAuthorization | undefined;
  recordQuote(response: SolverAtomicQuoteResponse): void;
  selectQuote(orderHash: string, quoteHash: string): LocalSelectedExecutionAttempt;
  selectQuoteForOrder(
    order: InternalOrderRecord,
    recognizedDomain: DomainRef,
    quoteHash: string,
  ): SelectedExecutionAttempt;
  getAttempt(attemptId: string): SelectedExecutionAttempt | undefined;
  getSelectedQuote(attemptId: string): SolverAtomicQuoteResponse | undefined;
  close(): void;
}

export class ExecutionIntentStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExecutionIntentStoreError";
    this.code = code;
  }
}

let cachedRepositoryRoot: string | undefined;

function repositoryRoot(): string | undefined {
  if (cachedRepositoryRoot !== undefined) return cachedRepositoryRoot;
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      cachedRepositoryRoot = current;
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function databasePath(value: string): string {
  if (!isAbsolute(value) || value === ":memory:") {
    throw new ExecutionIntentStoreError("INVALID_PATH", "Execution intent database path must be absolute.");
  }
  const path = resolve(value);
  const root = repositoryRoot();
  if (root !== undefined && (path === resolve(root) || path.startsWith(resolve(root) + sep))) {
    throw new ExecutionIntentStoreError("INVALID_PATH", "Execution intent database must remain outside the repository.");
  }
  return path;
}

function canonicalSignature(value: string): Uint8Array {
  if (typeof value !== "string") {
    throw new ExecutionIntentStoreError("INVALID_SIGNATURE", "Trader signature must be canonical base58.");
  }
  try {
    const bytes = bs58.decode(value);
    if (bytes.length !== 64 || bs58.encode(bytes) !== value) throw new Error("invalid signature");
    return bytes;
  } catch {
    throw new ExecutionIntentStoreError("INVALID_SIGNATURE", "Trader signature must be canonical base58.");
  }
}

function orderBytes(record: InternalOrderRecord): Uint8Array {
  try {
    const bytes = Buffer.from(record.orderBase64, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== record.orderBase64) throw new Error("invalid bytes");
    return bytes;
  } catch {
    throw new ExecutionIntentStoreError("INVALID_ORDER", "Stored order bytes are invalid.");
  }
}

function verifyAuthorization(record: InternalOrderRecord, signature: Uint8Array): void {
  let publicKeyBytes: Uint8Array;
  try {
    publicKeyBytes = bs58.decode(record.owner);
    if (publicKeyBytes.length !== 32) throw new Error("invalid owner");
  } catch {
    throw new ExecutionIntentStoreError("INVALID_OWNER", "Order owner is not an Ed25519 public key.");
  }
  let valid = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBytes)]),
      format: "der",
      type: "spki",
    });
    valid = verify(null, Buffer.from(orderBytes(record)), publicKey, Buffer.from(signature));
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new ExecutionIntentStoreError("INVALID_SIGNATURE", "Trader signature does not authorize the canonical order.");
  }
}

function attemptId(orderHash: string, routeHash: string, quoteHash: string): string {
  return `local-atomic-${createHash("sha256")
    .update("NARYX/local-execution-attempt/v1", "ascii")
    .update(Buffer.from(orderHash, "hex"))
    .update(Buffer.from(routeHash, "hex"))
    .update(Buffer.from(quoteHash, "hex"))
    .digest("hex")}`;
}

function baseAttemptId(
  order: InternalOrderRecord,
  routeHash: string,
  quoteHash: string,
): string {
  const version = Buffer.alloc(8);
  version.writeBigUInt64BE(BigInt(order.domainManifestVersion));
  const digest = createHash("sha256")
    .update("NARYX/base-atomic-execution-attempt/v1", "ascii")
    .update(Buffer.from(order.domainId, "ascii"))
    .update(version)
    .update(Buffer.from(order.domainManifestHashHex, "hex"))
    .update(Buffer.from(order.orderHashHex, "hex"))
    .update(Buffer.from(routeHash, "hex"))
    .update(Buffer.from(quoteHash, "hex"))
    .digest("hex");
  return `base-atomic-${digest.slice(0, 52)}`;
}

function arbitrumAttemptId(
  order: InternalOrderRecord,
  routeHash: string,
  quoteHash: string,
): string {
  const version = Buffer.alloc(8);
  version.writeBigUInt64BE(BigInt(order.domainManifestVersion));
  const digest = createHash("sha256")
    .update("NARYX/arbitrum-async-execution-attempt/v1", "ascii")
    .update(Buffer.from(order.domainId, "ascii"))
    .update(version)
    .update(Buffer.from(order.domainManifestHashHex, "hex"))
    .update(Buffer.from(order.orderHashHex, "hex"))
    .update(Buffer.from(routeHash, "hex"))
    .update(Buffer.from(quoteHash, "hex"))
    .digest("hex");
  return `arbitrum-async-${digest.slice(0, 48)}`;
}

function domainHashHex(domain: DomainRef): string {
  const hash = Buffer.from(domain.domainManifestHash).toString("hex");
  if (!HASH.test(hash) || /^0+$/.test(hash)) {
    throw new ExecutionIntentStoreError("UNRECOGNIZED_ORDER_DOMAIN", "Recognized domain manifest identity is invalid.");
  }
  return hash;
}

export function executionSelectionKind(
  order: InternalOrderRecord,
  recognizedDomain: DomainRef,
): ExecutionSelectionKind {
  const recognizedHash = domainHashHex(recognizedDomain);
  if (order.domainId !== recognizedDomain.domainId
    || order.domainManifestVersion !== recognizedDomain.domainManifestVersion
    || order.domainManifestHashHex !== recognizedHash) {
    throw new ExecutionIntentStoreError(
      "UNRECOGNIZED_ORDER_DOMAIN",
      "Stored canonical order domain does not match the recognized manifest identity.",
    );
  }
  if (order.domainId === BASE_SEPOLIA_DOMAIN_ID) return "BASE_ATOMIC";
  if (order.domainId === ARBITRUM_SEPOLIA_DOMAIN_ID) return "ARBITRUM_ASYNC";
  if (order.domainId.startsWith("evm:")) {
    throw new ExecutionIntentStoreError(
      "UNSUPPORTED_ORDER_DOMAIN",
      "Only Base Sepolia supports EVM atomic quote selection.",
    );
  }
  return "SOLANA_AUTHORIZED";
}

export class SqliteExecutionIntentStore implements ExecutionIntentStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    const path = databasePath(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS execution_authorizations (
        order_hash TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        signature TEXT NOT NULL,
        authorized_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS solver_quotes (
        quote_hash TEXT PRIMARY KEY,
        order_hash TEXT NOT NULL,
        route_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        UNIQUE (order_hash, quote_hash)
      );
      CREATE TABLE IF NOT EXISTS selected_execution_attempts (
        attempt_id TEXT PRIMARY KEY,
        order_hash TEXT NOT NULL UNIQUE,
        route_hash TEXT NOT NULL,
        quote_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status = 'AUTHORIZED_QUOTE_SELECTED'),
        selected_at_ms INTEGER NOT NULL,
        FOREIGN KEY (order_hash) REFERENCES execution_authorizations(order_hash),
        FOREIGN KEY (quote_hash) REFERENCES solver_quotes(quote_hash)
      );
      CREATE TABLE IF NOT EXISTS selected_base_atomic_attempts (
        attempt_id TEXT PRIMARY KEY,
        order_hash TEXT NOT NULL UNIQUE,
        route_hash TEXT NOT NULL,
        quote_hash TEXT NOT NULL UNIQUE,
        domain_id TEXT NOT NULL CHECK (domain_id = 'evm:base-sepolia'),
        domain_manifest_version INTEGER NOT NULL CHECK (domain_manifest_version > 0),
        domain_manifest_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'BASE_ATOMIC_QUOTE_SELECTED'),
        selected_at_ms INTEGER NOT NULL,
        FOREIGN KEY (quote_hash) REFERENCES solver_quotes(quote_hash)
      );
      CREATE TABLE IF NOT EXISTS selected_arbitrum_async_attempts (
        attempt_id TEXT PRIMARY KEY,
        order_hash TEXT NOT NULL UNIQUE,
        route_hash TEXT NOT NULL,
        quote_hash TEXT NOT NULL UNIQUE,
        domain_id TEXT NOT NULL CHECK (domain_id = 'eip155:421614'),
        domain_manifest_version INTEGER NOT NULL CHECK (domain_manifest_version > 0),
        domain_manifest_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'ARBITRUM_ASYNC_QUOTE_SELECTED'),
        selected_at_ms INTEGER NOT NULL,
        FOREIGN KEY (quote_hash) REFERENCES solver_quotes(quote_hash)
      );
    `);
  }

  authorize(order: InternalOrderRecord, signatureText: string): ExecutionAuthorization {
    if (!HASH.test(order.orderHashHex)) throw new ExecutionIntentStoreError("INVALID_ORDER", "Order hash is invalid.");
    const signature = canonicalSignature(signatureText);
    verifyAuthorization(order, signature);
    const now = Date.now();
    this.#db.prepare(`
      INSERT INTO execution_authorizations (order_hash, owner, signature, authorized_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(order_hash) DO NOTHING
    `).run(order.orderHashHex, order.owner, signatureText, now);
    const stored = this.getAuthorization(order.orderHashHex);
    if (stored === undefined || stored.owner !== order.owner || stored.signature !== signatureText) {
      throw new ExecutionIntentStoreError("AUTHORIZATION_CONFLICT", "Order already has a different authorization.");
    }
    return stored;
  }

  getAuthorization(orderHash: string): ExecutionAuthorization | undefined {
    if (!HASH.test(orderHash)) throw new ExecutionIntentStoreError("INVALID_ORDER_HASH", "Order hash is invalid.");
    const row = this.#db.prepare(`
      SELECT order_hash, owner, signature, authorized_at_ms
      FROM execution_authorizations WHERE order_hash = ?
    `).get(orderHash) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    if (row.order_hash !== orderHash || typeof row.owner !== "string" || typeof row.signature !== "string"
      || typeof row.authorized_at_ms !== "number" || !Number.isSafeInteger(row.authorized_at_ms)) {
      throw new ExecutionIntentStoreError("CORRUPT_ROW", "Stored authorization is invalid.");
    }
    canonicalSignature(row.signature);
    return Object.freeze({
      orderHash,
      owner: row.owner,
      signature: row.signature,
      authorizedAtMs: row.authorized_at_ms,
    });
  }

  recordQuote(response: SolverAtomicQuoteResponse): void {
    validateSolverAtomicQuoteResponse(response, {
      orderHash: response.orderHash,
      idempotencyKey: response.idempotencyKey,
    });
    const now = Date.now();
    const json = JSON.stringify(response);
    this.#db.prepare(`
      INSERT INTO solver_quotes (quote_hash, order_hash, route_hash, response_json, recorded_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(quote_hash) DO NOTHING
    `).run(response.quoteHash, response.orderHash, response.routeHash, json, now);
    const row = this.#db.prepare("SELECT response_json FROM solver_quotes WHERE quote_hash = ?")
      .get(response.quoteHash) as { response_json?: unknown } | undefined;
    if (row === undefined || row.response_json !== json) {
      throw new ExecutionIntentStoreError("QUOTE_CONFLICT", "Quote hash is already bound to different evidence.");
    }
  }

  selectQuote(orderHash: string, quoteHash: string): LocalSelectedExecutionAttempt {
    if (!HASH.test(orderHash) || !HASH.test(quoteHash)) {
      throw new ExecutionIntentStoreError("INVALID_SELECTION", "Order or quote hash is invalid.");
    }
    if (this.getAuthorization(orderHash) === undefined) {
      throw new ExecutionIntentStoreError("AUTHORIZATION_REQUIRED", "Trader authorization is required before quote selection.");
    }
    const quote = this.#db.prepare(`
      SELECT route_hash FROM solver_quotes WHERE quote_hash = ? AND order_hash = ?
    `).get(quoteHash, orderHash) as { route_hash?: unknown } | undefined;
    if (quote === undefined || typeof quote.route_hash !== "string" || !HASH.test(quote.route_hash)) {
      throw new ExecutionIntentStoreError("QUOTE_NOT_FOUND", "Quote is not recorded for this order.");
    }
    const id = attemptId(orderHash, quote.route_hash, quoteHash);
    const now = Date.now();
    this.#db.prepare(`
      INSERT INTO selected_execution_attempts
        (attempt_id, order_hash, route_hash, quote_hash, status, selected_at_ms)
      VALUES (?, ?, ?, ?, 'AUTHORIZED_QUOTE_SELECTED', ?)
      ON CONFLICT(order_hash) DO NOTHING
    `).run(id, orderHash, quote.route_hash, quoteHash, now);
    const stored = this.getAttempt(id);
    if (stored === undefined || stored.status !== "AUTHORIZED_QUOTE_SELECTED") {
      throw new ExecutionIntentStoreError("SELECTION_CONFLICT", "Order already selected a different quote.");
    }
    return stored;
  }

  selectQuoteForOrder(
    order: InternalOrderRecord,
    recognizedDomain: DomainRef,
    quoteHash: string,
  ): SelectedExecutionAttempt {
    const kind = executionSelectionKind(order, recognizedDomain);
    if (kind === "SOLANA_AUTHORIZED") {
      return this.selectQuote(order.orderHashHex, quoteHash);
    }
    if (!HASH.test(order.orderHashHex) || !HASH.test(quoteHash)) {
      throw new ExecutionIntentStoreError("INVALID_SELECTION", "Order or quote hash is invalid.");
    }
    const quote = this.#db.prepare(`
      SELECT route_hash FROM solver_quotes WHERE quote_hash = ? AND order_hash = ?
    `).get(quoteHash, order.orderHashHex) as { route_hash?: unknown } | undefined;
    if (quote === undefined || typeof quote.route_hash !== "string" || !HASH.test(quote.route_hash)) {
      throw new ExecutionIntentStoreError("QUOTE_NOT_FOUND", "Quote is not recorded for this order.");
    }
    const async = kind === "ARBITRUM_ASYNC";
    const id = async
      ? arbitrumAttemptId(order, quote.route_hash, quoteHash)
      : baseAttemptId(order, quote.route_hash, quoteHash);
    const now = Date.now();
    this.#db.prepare(`
      INSERT INTO ${async ? "selected_arbitrum_async_attempts" : "selected_base_atomic_attempts"}
        (attempt_id, order_hash, route_hash, quote_hash, domain_id, domain_manifest_version,
         domain_manifest_hash, status, selected_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_hash) DO NOTHING
    `).run(
      id,
      order.orderHashHex,
      quote.route_hash,
      quoteHash,
      order.domainId,
      order.domainManifestVersion,
      order.domainManifestHashHex,
      async ? "ARBITRUM_ASYNC_QUOTE_SELECTED" : "BASE_ATOMIC_QUOTE_SELECTED",
      now,
    );
    const stored = this.getAttempt(id);
    if (stored === undefined) {
      throw new ExecutionIntentStoreError("SELECTION_CONFLICT", "Order already selected a different quote.");
    }
    return stored;
  }

  getAttempt(id: string): SelectedExecutionAttempt | undefined {
    if (BASE_ATTEMPT_ID.test(id)) return this.#getBaseAttempt(id);
    if (ARBITRUM_ATTEMPT_ID.test(id)) return this.#getArbitrumAttempt(id);
    if (!LOCAL_ATTEMPT_ID.test(id)) throw new ExecutionIntentStoreError("INVALID_ATTEMPT_ID", "Attempt ID is invalid.");
    const row = this.#db.prepare(`
      SELECT attempt_id, order_hash, route_hash, quote_hash, status, selected_at_ms
      FROM selected_execution_attempts WHERE attempt_id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    if (row.attempt_id !== id || typeof row.order_hash !== "string" || !HASH.test(row.order_hash)
      || typeof row.route_hash !== "string" || !HASH.test(row.route_hash)
      || typeof row.quote_hash !== "string" || !HASH.test(row.quote_hash)
      || row.status !== "AUTHORIZED_QUOTE_SELECTED"
      || typeof row.selected_at_ms !== "number" || !Number.isSafeInteger(row.selected_at_ms)) {
      throw new ExecutionIntentStoreError("CORRUPT_ROW", "Stored execution attempt is invalid.");
    }
    return Object.freeze({
      attemptId: id,
      orderHash: row.order_hash,
      routeHash: row.route_hash,
      quoteHash: row.quote_hash,
      status: "AUTHORIZED_QUOTE_SELECTED",
      selectedAtMs: row.selected_at_ms,
    });
  }

  #getBaseAttempt(id: string): BaseSelectedExecutionAttempt | undefined {
    const row = this.#db.prepare(`
      SELECT attempt_id, order_hash, route_hash, quote_hash, domain_id,
        domain_manifest_version, domain_manifest_hash, status, selected_at_ms
      FROM selected_base_atomic_attempts WHERE attempt_id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    if (row.attempt_id !== id || typeof row.order_hash !== "string" || !HASH.test(row.order_hash)
      || typeof row.route_hash !== "string" || !HASH.test(row.route_hash)
      || typeof row.quote_hash !== "string" || !HASH.test(row.quote_hash)
      || row.domain_id !== BASE_SEPOLIA_DOMAIN_ID
      || typeof row.domain_manifest_version !== "number"
      || !Number.isSafeInteger(row.domain_manifest_version) || row.domain_manifest_version < 1
      || typeof row.domain_manifest_hash !== "string" || !HASH.test(row.domain_manifest_hash)
      || /^0+$/.test(row.domain_manifest_hash)
      || row.status !== "BASE_ATOMIC_QUOTE_SELECTED"
      || typeof row.selected_at_ms !== "number" || !Number.isSafeInteger(row.selected_at_ms)) {
      throw new ExecutionIntentStoreError("CORRUPT_ROW", "Stored Base atomic attempt is invalid.");
    }
    return Object.freeze({
      attemptId: id,
      orderHash: row.order_hash,
      routeHash: row.route_hash,
      quoteHash: row.quote_hash,
      status: "BASE_ATOMIC_QUOTE_SELECTED",
      selectedAtMs: row.selected_at_ms,
      domainId: BASE_SEPOLIA_DOMAIN_ID,
      domainManifestVersion: row.domain_manifest_version,
      domainManifestHash: row.domain_manifest_hash,
    });
  }

  #getArbitrumAttempt(id: string): ArbitrumSelectedExecutionAttempt | undefined {
    const row = this.#db.prepare(`
      SELECT attempt_id, order_hash, route_hash, quote_hash, domain_id,
        domain_manifest_version, domain_manifest_hash, status, selected_at_ms
      FROM selected_arbitrum_async_attempts WHERE attempt_id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    if (row.attempt_id !== id || typeof row.order_hash !== "string" || !HASH.test(row.order_hash)
      || typeof row.route_hash !== "string" || !HASH.test(row.route_hash)
      || typeof row.quote_hash !== "string" || !HASH.test(row.quote_hash)
      || row.domain_id !== ARBITRUM_SEPOLIA_DOMAIN_ID
      || typeof row.domain_manifest_version !== "number"
      || !Number.isSafeInteger(row.domain_manifest_version) || row.domain_manifest_version < 1
      || typeof row.domain_manifest_hash !== "string" || !HASH.test(row.domain_manifest_hash)
      || /^0+$/.test(row.domain_manifest_hash)
      || row.status !== "ARBITRUM_ASYNC_QUOTE_SELECTED"
      || typeof row.selected_at_ms !== "number" || !Number.isSafeInteger(row.selected_at_ms)) {
      throw new ExecutionIntentStoreError("CORRUPT_ROW", "Stored Arbitrum async attempt is invalid.");
    }
    return Object.freeze({
      attemptId: id,
      orderHash: row.order_hash,
      routeHash: row.route_hash,
      quoteHash: row.quote_hash,
      status: "ARBITRUM_ASYNC_QUOTE_SELECTED",
      selectedAtMs: row.selected_at_ms,
      domainId: ARBITRUM_SEPOLIA_DOMAIN_ID,
      domainManifestVersion: row.domain_manifest_version,
      domainManifestHash: row.domain_manifest_hash,
    });
  }

  getSelectedQuote(id: string): SolverAtomicQuoteResponse | undefined {
    const attempt = this.getAttempt(id);
    if (attempt === undefined) return undefined;
    const row = this.#db.prepare("SELECT response_json FROM solver_quotes WHERE quote_hash = ?")
      .get(attempt.quoteHash) as { response_json?: unknown } | undefined;
    if (row === undefined || typeof row.response_json !== "string") {
      throw new ExecutionIntentStoreError("CORRUPT_ROW", "Selected quote evidence is missing.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.response_json) as unknown;
    } catch {
      throw new ExecutionIntentStoreError("CORRUPT_ROW", "Selected quote evidence is malformed.");
    }
    return validateSolverAtomicQuoteResponse(parsed, {
      orderHash: attempt.orderHash,
      idempotencyKey: (parsed as { idempotencyKey?: unknown }).idempotencyKey as string,
    });
  }

  close(): void {
    this.#db.close();
  }
}
