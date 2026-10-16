import { isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { bytesEqual, parseProtocolJson, stringifyProtocolJson, type Hash32 } from '@naryx/protocol-types';
import type { PreparedStrategyExecutionTransport } from './strategy-execution-transport.js';

export interface EvmStrategyAuthorizationJournal {
  get(quoteHash: Hash32): Promise<PreparedStrategyExecutionTransport | undefined>;
  record(prepared: PreparedStrategyExecutionTransport): Promise<void>;
}

export class SqliteEvmStrategyAuthorizationJournal implements EvmStrategyAuthorizationJournal {
  readonly #db: Database.Database;

  constructor(path: string) {
    if (!isAbsolute(path) || path === ':memory:') throw new Error('EVM authorization journal requires an absolute durable path.');
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');
    this.#db.exec(`CREATE TABLE IF NOT EXISTS evm_strategy_authorizations (
      quote_hash TEXT PRIMARY KEY,
      prepared_json TEXT NOT NULL
    ) STRICT`);
  }

  async get(quoteHash: Hash32): Promise<PreparedStrategyExecutionTransport | undefined> {
    const row = this.#db.prepare('SELECT prepared_json FROM evm_strategy_authorizations WHERE quote_hash = ?')
      .get(Buffer.from(quoteHash).toString('hex')) as { prepared_json: string } | undefined;
    if (row === undefined) return undefined;
    const prepared = parseProtocolJson(row.prepared_json) as PreparedStrategyExecutionTransport;
    if (prepared.version !== 1 || !bytesEqual(prepared.quoteHash, quoteHash)) throw new Error('Stored EVM authorization quote mismatch.');
    return prepared;
  }

  async record(prepared: PreparedStrategyExecutionTransport): Promise<void> {
    const hash = Buffer.from(prepared.quoteHash).toString('hex');
    if (!/^[0-9a-f]{64}$/.test(hash) || prepared.version !== 1
      || !prepared.domains.some((domain) => domain.kind === 'EVM_MULTI_STRATEGY_ACCOUNT')) {
      throw new Error('Invalid prepared EVM authorization.');
    }
    const json = stringifyProtocolJson(prepared);
    this.#db.transaction(() => {
      this.#db.prepare('INSERT OR IGNORE INTO evm_strategy_authorizations VALUES (?, ?)').run(hash, json);
      const row = this.#db.prepare('SELECT prepared_json FROM evm_strategy_authorizations WHERE quote_hash = ?')
        .get(hash) as { prepared_json: string };
      if (row.prepared_json !== json) throw new Error('EVM quote already authorizes another prepared execution.');
    })();
  }

  close(): void { this.#db.close(); }
}
