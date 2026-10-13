import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  bytesEqual,
  parseProtocolJson,
  stringifyProtocolJson,
  type Hash32,
} from '@naryx/protocol-types';
import type { PreparedStrategyExecutionTransport } from './strategy-execution-transport.js';

export interface SolanaStrategyAuthorizationJournal {
  record(prepared: PreparedStrategyExecutionTransport): Promise<void>;
  candidates(quoteHash: Hash32): Promise<readonly PreparedStrategyExecutionTransport[]>;
}

export class SqliteSolanaStrategyAuthorizationJournal implements SolanaStrategyAuthorizationJournal {
  readonly #db: Database.Database;

  constructor(path: string) {
    if (!isAbsolute(path) || path === ':memory:') {
      throw new Error('Solana strategy authorization journal path must be absolute');
    }
    this.#db = new Database(resolve(path));
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS solana_strategy_authorizations (
        quote_hash TEXT NOT NULL,
        prepared_hash TEXT NOT NULL,
        prepared_json TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (quote_hash, prepared_hash)
      ) STRICT;
    `);
  }

  async record(prepared: PreparedStrategyExecutionTransport): Promise<void> {
    const quoteHash = Buffer.from(prepared.quoteHash).toString('hex');
    if (!/^[0-9a-f]{64}$/.test(quoteHash)) throw new Error('prepared quote hash is invalid');
    const serialized = stringifyProtocolJson(prepared);
    const preparedHash = createHash('sha256').update(serialized).digest('hex');
    const existing = this.#db.prepare(`
      SELECT prepared_json FROM solana_strategy_authorizations
      WHERE quote_hash = ? AND prepared_hash = ?
    `).get(quoteHash, preparedHash) as { prepared_json: string } | undefined;
    if (existing !== undefined) {
      if (existing.prepared_json !== serialized) throw new Error('prepared authorization hash collision');
      return;
    }
    this.#db.prepare(`
      INSERT INTO solana_strategy_authorizations (quote_hash, prepared_hash, prepared_json, recorded_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(quoteHash, preparedHash, serialized, Date.now());
  }

  async candidates(quoteHash: Hash32): Promise<readonly PreparedStrategyExecutionTransport[]> {
    const key = Buffer.from(quoteHash).toString('hex');
    const rows = this.#db.prepare(`
      SELECT prepared_json FROM solana_strategy_authorizations
      WHERE quote_hash = ? ORDER BY recorded_at_ms, prepared_hash
    `).all(key) as { prepared_json: string }[];
    return Object.freeze(rows.map((row) => {
      const prepared = parseProtocolJson(row.prepared_json) as PreparedStrategyExecutionTransport;
      if (!bytesEqual(prepared.quoteHash, quoteHash)) throw new Error('stored authorization quote hash mismatch');
      return prepared;
    }));
  }

  close(): void {
    this.#db.close();
  }
}
