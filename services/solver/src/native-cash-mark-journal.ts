import Database from 'better-sqlite3';
import { keccak256, type Hex } from 'viem';
import { nativeCashDataPath } from './native-cash-service.js';

export const NATIVE_CASH_MARK_GAS_CAP_WEI = 9_000_000_000_000_000n;
const MAXIMUM_TESTNET_MARK_GAS_CAP_WEI = 100_000_000_000_000_000n;

export function nativeCashMarkGasCapWei(chainId: number, value?: string): bigint {
  if (![84532, 421614].includes(chainId) || (value !== undefined && !/^[1-9][0-9]{0,17}$/.test(value))) {
    throw new Error('Native cash mark gas cap is invalid.');
  }
  const cap = value === undefined ? NATIVE_CASH_MARK_GAS_CAP_WEI : BigInt(value);
  if (cap > MAXIMUM_TESTNET_MARK_GAS_CAP_WEI) throw new Error('Native cash mark gas cap exceeds the testnet bound.');
  return cap;
}
export interface NativeCashMarkTransaction {
  readonly id: string; readonly chainId: number; readonly hash: string; readonly raw: string; readonly costWei: bigint;
}

export function nativeCashMarkTransaction(chainId: number, raw: Hex, costWei: bigint): NativeCashMarkTransaction {
  const hash = keccak256(raw);
  return { id: hash, chainId, hash, raw, costWei };
}

export class NativeCashMarkJournal {
  readonly #db: Database.Database;
  readonly #caps = new Map<number, bigint>();
  constructor(path: string, initial: readonly { chainId: number; reservedWei: bigint; maximumGasBudgetWei?: bigint }[]) {
    this.#db = new Database(nativeCashDataPath(path));
    this.#db.pragma('journal_mode=WAL'); this.#db.pragma('synchronous=FULL'); this.#db.pragma('busy_timeout=5000');
    this.#db.exec(`CREATE TABLE IF NOT EXISTS budgets(chain_id INTEGER PRIMARY KEY,reserved_wei TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY,chain_id INTEGER NOT NULL,hash TEXT NOT NULL UNIQUE,
        raw TEXT NOT NULL,cost_wei TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING','MINED','REVERTED'))) STRICT;`);
    try {
      for (const entry of initial) {
        const cap = nativeCashMarkGasCapWei(entry.chainId, entry.maximumGasBudgetWei?.toString());
        if (![84532, 421614].includes(entry.chainId) || typeof entry.reservedWei !== 'bigint'
          || this.#caps.has(entry.chainId) || entry.reservedWei < 0n || entry.reservedWei > cap) throw new Error('Native cash mark budget is invalid.');
        this.#caps.set(entry.chainId, cap);
        this.#db.prepare('INSERT OR IGNORE INTO budgets VALUES(?,?)').run(entry.chainId, entry.reservedWei.toString());
        if (this.reserved(entry.chainId) < entry.reservedWei) throw new Error('Native cash mark budget changed outside its journal.');
        if (this.reserved(entry.chainId) > cap) throw new Error('Native cash mark gas cap is below its existing commitments.');
      }
    } catch (error) { this.#db.close(); throw error; }
  }
  close() { this.#db.close(); }
  cap(chainId: number) {
    const cap = this.#caps.get(chainId);
    if (cap === undefined) throw new Error('Native cash mark chain budget is unknown.');
    return cap;
  }
  reserved(chainId: number) {
    const row = this.#db.prepare('SELECT reserved_wei FROM budgets WHERE chain_id=?').get(chainId) as { reserved_wei: string } | undefined;
    if (row === undefined) throw new Error('Native cash mark chain budget is unknown.');
    return BigInt(row.reserved_wei);
  }
  pending(chainId: number): NativeCashMarkTransaction | undefined {
    const row = this.#db.prepare('SELECT * FROM transactions WHERE chain_id=? AND status=\'PENDING\' ORDER BY rowid LIMIT 1')
      .get(chainId) as { id: string; chain_id: number; hash: string; raw: string; cost_wei: string } | undefined;
    return row === undefined ? undefined : { id: row.id, chainId: row.chain_id, hash: row.hash, raw: row.raw, costWei: BigInt(row.cost_wei) };
  }
  reserve(transaction: NativeCashMarkTransaction) {
    if (!/^0x[0-9a-f]{64}$/.test(transaction.hash) || !/^0x[0-9a-f]+$/.test(transaction.raw)
      || keccak256(transaction.raw as Hex) !== transaction.hash
      || typeof transaction.costWei !== 'bigint' || transaction.costWei <= 0n) throw new Error('Native cash mark transaction is invalid.');
    this.#db.transaction(() => {
      if (this.pending(transaction.chainId) !== undefined) throw new Error('Native cash mark chain has an unresolved transaction.');
      const next = this.reserved(transaction.chainId) + transaction.costWei;
      if (next > this.cap(transaction.chainId)) throw new Error('Approved native cash test gas budget is exhausted.');
      this.#db.prepare('INSERT INTO transactions VALUES(?,?,?,?,?,\'PENDING\')')
        .run(transaction.id, transaction.chainId, transaction.hash, transaction.raw, transaction.costWei.toString());
      this.#db.prepare('UPDATE budgets SET reserved_wei=? WHERE chain_id=?').run(next.toString(), transaction.chainId);
    }).immediate();
  }
  resolve(hash: string, success: boolean) {
    const result = this.#db.prepare('UPDATE transactions SET status=? WHERE hash=? AND status=\'PENDING\'')
      .run(success ? 'MINED' : 'REVERTED', hash);
    if (result.changes !== 1) throw new Error('Native cash mark transaction is not pending.');
  }
}
