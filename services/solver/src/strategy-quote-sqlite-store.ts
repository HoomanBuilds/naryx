import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  bytesEqual,
  parseProtocolJson,
  strategyPackageQuote,
  strategyPackageQuoteHash,
  stringifyProtocolJson,
  toHex,
  typedStrategyRouteHash,
  type StrategyPackageQuoteInput,
  type TypedStrategyRoute,
} from '@naryx/protocol-types';
import {
  GeneralizedStrategyQuoteError,
  type GeneralizedStrategyQuoteResponse,
  type GeneralizedStrategyQuoteStore,
  type StoredGeneralizedStrategyQuote,
} from './strategy-quote-service.js';

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
  if (!isAbsolute(value) || value === ':memory:') throw new Error('strategy quote database path must be absolute');
  const path = resolve(value);
  const root = repositoryRoot();
  if (root !== undefined && (path === root || path.startsWith(resolve(root) + sep))) {
    throw new Error('strategy quote database must remain outside the repository');
  }
  return path;
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error
    && typeof (error as Error & { code?: unknown }).code === 'string'
    && ((error as Error & { code: string }).code).startsWith('SQLITE_CONSTRAINT');
}

function parseResponse(value: string, key: string, orderHash: string): GeneralizedStrategyQuoteResponse {
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(value);
  } catch {
    throw new Error('stored strategy quote response is malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('stored strategy quote response is invalid');
  }
  const response = parsed as Record<string, unknown>;
  const keys = Object.keys(response).sort();
  const expected = ['graphHash', 'idempotencyKey', 'orderHash', 'quote', 'quoteHash', 'route', 'routeHash', 'status', 'version'];
  if (keys.length !== expected.length || keys.some((field, index) => field !== expected[index])
    || response.version !== 1 || response.status !== 'SIGNED'
    || response.idempotencyKey !== key || response.orderHash !== orderHash
    || typeof response.graphHash !== 'string' || !HASH.test(response.graphHash)
    || typeof response.routeHash !== 'string' || !HASH.test(response.routeHash)
    || typeof response.quoteHash !== 'string' || !HASH.test(response.quoteHash)
    || typeof response.route !== 'object' || response.route === null || Array.isArray(response.route)
    || typeof response.quote !== 'object' || response.quote === null || Array.isArray(response.quote)) {
    throw new Error('stored strategy quote response binding is invalid');
  }
  const route = response.route as unknown as TypedStrategyRoute;
  const quote = strategyPackageQuote(response.quote as StrategyPackageQuoteInput, 'storedStrategyQuote.quote');
  let routeHash: string;
  try {
    routeHash = toHex(typedStrategyRouteHash(route));
  } catch {
    throw new Error('stored strategy quote route is invalid');
  }
  const quoteHash = toHex(strategyPackageQuoteHash(quote));
  if (route.version !== 1
    || routeHash !== response.routeHash || quoteHash !== response.quoteHash
    || toHex(route.orderHash) !== orderHash || toHex(quote.orderHash) !== orderHash
    || toHex(route.graphHash) !== response.graphHash || toHex(quote.graphHash) !== response.graphHash
    || !bytesEqual(quote.routeHash, typedStrategyRouteHash(route))
    || quote.environment !== route.environment
    || quote.solverId !== route.solverId
    || quote.settlementClass !== route.settlementClass) {
    throw new Error('stored strategy quote commitments are mismatched');
  }
  return Object.freeze({
    version: 1,
    status: 'SIGNED',
    idempotencyKey: key,
    orderHash,
    graphHash: response.graphHash,
    routeHash,
    quoteHash,
    route,
    quote,
  });
}

export class SqliteGeneralizedStrategyQuoteStore implements GeneralizedStrategyQuoteStore {
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
      CREATE TABLE IF NOT EXISTS signed_strategy_quotes (
        idempotency_key TEXT PRIMARY KEY,
        order_hash TEXT NOT NULL,
        response_json TEXT NOT NULL
      )
    `);
    this.#select = this.#db.prepare(
      'SELECT order_hash, response_json FROM signed_strategy_quotes WHERE idempotency_key = ?',
    );
    this.#insert = this.#db.prepare(
      'INSERT INTO signed_strategy_quotes (idempotency_key, order_hash, response_json) VALUES (?, ?, ?)',
    );
  }

  get(idempotencyKey: string): StoredGeneralizedStrategyQuote | undefined {
    if (!KEY.test(idempotencyKey)) throw new Error('idempotency key is invalid');
    const row = this.#select.get(idempotencyKey) as { order_hash?: unknown; response_json?: unknown } | undefined;
    if (row === undefined) return undefined;
    if (typeof row.order_hash !== 'string' || !HASH.test(row.order_hash) || typeof row.response_json !== 'string') {
      throw new Error('stored strategy quote row is invalid');
    }
    return Object.freeze({
      orderHash: row.order_hash,
      response: parseResponse(row.response_json, idempotencyKey, row.order_hash),
    });
  }

  save(record: StoredGeneralizedStrategyQuote): StoredGeneralizedStrategyQuote {
    const key = record.response.idempotencyKey;
    if (!KEY.test(key) || !HASH.test(record.orderHash) || record.response.orderHash !== record.orderHash) {
      throw new Error('strategy quote record binding is invalid');
    }
    const responseJson = stringifyProtocolJson(record.response);
    parseResponse(responseJson, key, record.orderHash);
    try {
      this.#insert.run(key, record.orderHash, responseJson);
      return this.get(key) as StoredGeneralizedStrategyQuote;
    } catch (error) {
      if (!isConstraintError(error)) throw error;
      const existing = this.get(key);
      if (existing === undefined || existing.orderHash !== record.orderHash
        || stringifyProtocolJson(existing.response) !== responseJson) {
        throw new GeneralizedStrategyQuoteError(
          'IDEMPOTENCY_CONFLICT',
          'idempotency key is already bound to a different strategy quote',
        );
      }
      return existing;
    }
  }

  close(): void {
    this.#db.close();
  }
}
