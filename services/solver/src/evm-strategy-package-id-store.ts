import { isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { Hex } from 'viem';
import type { EvmOptionSpreadPackageIdPort } from './evm-option-spread-preparation.js';

const HASH = /^0x[0-9a-f]{64}$/;

function checked(value: Hex, context: string): string {
  if (!HASH.test(value) || value === `0x${'00'.repeat(32)}`) throw new Error(`${context} must be a nonzero lowercase bytes32`);
  return value;
}

export class SqliteEvmStrategyPackageIdStore implements EvmOptionSpreadPackageIdPort {
  readonly #db: Database.Database;

  constructor(path: string) {
    if (!isAbsolute(path) || path === ':memory:') throw new Error('EVM strategy package identity database path must be absolute');
    this.#db = new Database(resolve(path));
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS evm_strategy_package_states (
        state_hash TEXT PRIMARY KEY NOT NULL,
        package_id TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS evm_strategy_package_states_package
        ON evm_strategy_package_states(package_id);
    `);
  }

  async resolvePackageId(expectedStateHash: Hex): Promise<Hex | undefined> {
    const stateHash = checked(expectedStateHash, 'expected state hash');
    const row = this.#db.prepare('SELECT package_id FROM evm_strategy_package_states WHERE state_hash = ?')
      .get(stateHash) as { package_id: string } | undefined;
    if (row === undefined) return undefined;
    return checked(row.package_id as Hex, 'stored package id') as Hex;
  }

  async rememberPackageId(stateHashValue: Hex, packageIdValue: Hex): Promise<void> {
    const stateHash = checked(stateHashValue, 'state hash');
    const packageId = checked(packageIdValue, 'package id');
    const existing = this.#db.prepare('SELECT package_id FROM evm_strategy_package_states WHERE state_hash = ?')
      .get(stateHash) as { package_id: string } | undefined;
    if (existing !== undefined) {
      if (existing.package_id !== packageId) throw new Error('strategy state hash is already bound to another package');
      return;
    }
    this.#db.prepare('INSERT INTO evm_strategy_package_states (state_hash, package_id, recorded_at_ms) VALUES (?, ?, ?)')
      .run(stateHash, packageId, Date.now());
  }

  close(): void {
    this.#db.close();
  }
}
