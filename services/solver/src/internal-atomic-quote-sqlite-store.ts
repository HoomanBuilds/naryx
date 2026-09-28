import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  InternalAtomicQuoteError,
  type InternalAtomicQuoteResponse,
  type InternalAtomicQuoteStore,
  type StoredInternalAtomicQuote,
} from './internal-atomic-quote-server.js';

const HASH = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

function repositoryRoot(): string | undefined {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function requirePath(value: string): string {
  if (!isAbsolute(value) || value === ':memory:') throw new Error('quote database path must be absolute');
  const path = resolve(value);
  const root = repositoryRoot();
  if (root !== undefined && (path === root || path.startsWith(resolve(root) + sep))) {
    throw new Error('quote database must remain outside the repository');
  }
  return path;
}

function parseResponse(value: string, key: string, orderHash: string): InternalAtomicQuoteResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('stored quote response is malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('stored quote response is invalid');
  }
  const response = parsed as Record<string, unknown>;
  if (response.version !== 1 || response.status !== 'SIGNED'
    || response.idempotencyKey !== key || response.orderHash !== orderHash
    || typeof response.routeHash !== 'string' || !HASH.test(response.routeHash)
    || typeof response.quoteHash !== 'string' || !HASH.test(response.quoteHash)
    || typeof response.solverSignatureDigest !== 'string' || !HASH.test(response.solverSignatureDigest)
    || typeof response.routeBytes !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(response.routeBytes)
    || typeof response.solverQuoteBytes !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(response.solverQuoteBytes)
    || typeof response.route !== 'object' || response.route === null || Array.isArray(response.route)
    || typeof response.quote !== 'object' || response.quote === null || Array.isArray(response.quote)) {
    throw new Error('stored quote response binding is invalid');
  }
  return parsed as InternalAtomicQuoteResponse;
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error
    && typeof (error as Error & { code?: unknown }).code === 'string'
    && ((error as Error & { code: string }).code).startsWith('SQLITE_CONSTRAINT');
}

export class SqliteInternalAtomicQuoteStore implements InternalAtomicQuoteStore {
  readonly #db: Database.Database;
  readonly #select: Database.Statement;
  readonly #insert: Database.Statement;

  constructor(dbPath: string) {
    const path = requirePath(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS signed_atomic_quotes (
        idempotency_key TEXT PRIMARY KEY,
        order_hash TEXT NOT NULL,
        response_json TEXT NOT NULL
      )
    `);
    this.#select = this.#db.prepare(
      'SELECT order_hash, response_json FROM signed_atomic_quotes WHERE idempotency_key = ?',
    );
    this.#insert = this.#db.prepare(
      'INSERT INTO signed_atomic_quotes (idempotency_key, order_hash, response_json) VALUES (?, ?, ?)',
    );
  }

  get(idempotencyKey: string): StoredInternalAtomicQuote | undefined {
    if (!KEY.test(idempotencyKey)) throw new Error('idempotency key is invalid');
    const row = this.#select.get(idempotencyKey) as {
      order_hash?: unknown;
      response_json?: unknown;
    } | undefined;
    if (row === undefined) return undefined;
    if (typeof row.order_hash !== 'string' || !HASH.test(row.order_hash)
      || typeof row.response_json !== 'string') {
      throw new Error('stored quote row is invalid');
    }
    return Object.freeze({
      orderHash: row.order_hash,
      response: parseResponse(row.response_json, idempotencyKey, row.order_hash),
    });
  }

  save(record: StoredInternalAtomicQuote): StoredInternalAtomicQuote {
    const key = record.response.idempotencyKey;
    if (!KEY.test(key) || !HASH.test(record.orderHash) || record.response.orderHash !== record.orderHash) {
      throw new Error('quote record binding is invalid');
    }
    const responseJson = JSON.stringify(record.response);
    parseResponse(responseJson, key, record.orderHash);
    try {
      this.#insert.run(key, record.orderHash, responseJson);
      return this.get(key) as StoredInternalAtomicQuote;
    } catch (error) {
      if (!isConstraintError(error)) throw error;
      const existing = this.get(key);
      if (existing === undefined || existing.orderHash !== record.orderHash
        || JSON.stringify(existing.response) !== responseJson) {
        throw new InternalAtomicQuoteError(
          'IDEMPOTENCY_CONFLICT',
          'idempotencyKey is already bound to a different quote',
        );
      }
      return existing;
    }
  }

  close(): void {
    this.#db.close();
  }
}
