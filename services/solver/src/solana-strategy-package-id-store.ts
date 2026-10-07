import { isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { SolanaTreasuryHedgePackageIdPort } from './solana-treasury-hedge-preparation.js';

const HASH = /^[0-9a-f]{64}$/;

function checked(value: string, context: string): string {
  if (!HASH.test(value) || /^0{64}$/.test(value)) throw new Error(`${context} must be a nonzero lowercase hash`);
  return value;
}

export class SqliteSolanaStrategyPackageIdStore implements SolanaTreasuryHedgePackageIdPort {
  readonly #db: Database.Database;

  constructor(path: string) {
    if (!isAbsolute(path) || path === ':memory:') {
      throw new Error('Solana strategy package identity database path must be absolute');
    }
    this.#db = new Database(resolve(path));
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS solana_strategy_package_states (
        state_hash TEXT PRIMARY KEY NOT NULL,
        package_id TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS solana_strategy_package_states_package
        ON solana_strategy_package_states(package_id);
    `);
  }

  async resolvePackageId(expectedStateHashHex: string): Promise<string | undefined> {
    const stateHash = checked(expectedStateHashHex, 'expected state hash');
    const row = this.#db.prepare('SELECT package_id FROM solana_strategy_package_states WHERE state_hash = ?')
      .get(stateHash) as { package_id: string } | undefined;
    return row === undefined ? undefined : checked(row.package_id, 'stored package id');
  }

  async rememberPackageId(stateHashHex: string, packageIdHex: string): Promise<void> {
    const stateHash = checked(stateHashHex, 'state hash');
    const packageId = checked(packageIdHex, 'package id');
    const existing = this.#db.prepare('SELECT package_id FROM solana_strategy_package_states WHERE state_hash = ?')
      .get(stateHash) as { package_id: string } | undefined;
    if (existing !== undefined) {
      if (existing.package_id !== packageId) throw new Error('strategy state hash is already bound to another package');
      return;
    }
    this.#db.prepare('INSERT INTO solana_strategy_package_states (state_hash, package_id, recorded_at_ms) VALUES (?, ?, ?)')
      .run(stateHash, packageId, Date.now());
  }

  close(): void {
    this.#db.close();
  }
}
