import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../services/solver/package.json'));
const Database = require('better-sqlite3');
const { encodeFunctionData, keccak256, parseAbi, parseTransaction, recoverTransactionAddress } = require('viem');
const abi = parseAbi(['function setAnswer(int256 nextAnswer)']);
export const REFRESH_RESERVATION_WEI = 5_000_000_000_000n;
export const REFRESH_BUDGET_WEI = 1_000_000_000_000_000n;

export class OracleRefreshJournal {
  constructor(path, chainId, oracle, owner) {
    if (!isAbsolute(path) || ![84532, 421614].includes(chainId)
      || !/^0x[0-9a-fA-F]{40}$/.test(oracle) || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
      throw new Error('Oracle refresh journal binding is invalid.');
    }
    this.chainId = chainId; this.oracle = oracle.toLowerCase(); this.owner = owner.toLowerCase();
    this.db = new Database(path);
    this.db.pragma('journal_mode=WAL'); this.db.pragma('synchronous=FULL'); this.db.pragma('busy_timeout=5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY CHECK(id=1),chain_id INTEGER NOT NULL,
      oracle TEXT NOT NULL,owner TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS refreshes(hash TEXT PRIMARY KEY,raw TEXT NOT NULL,answer TEXT NOT NULL,
        round TEXT NOT NULL,updated_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING','CONFIRMED','FAILED')),
        actual_wei TEXT) STRICT;`);
    try {
      this.db.prepare('INSERT OR IGNORE INTO binding VALUES(1,?,?,?)').run(chainId, this.oracle, this.owner);
      const bound = this.db.prepare('SELECT * FROM binding WHERE id=1').get();
      if (bound.chain_id !== chainId || bound.oracle !== this.oracle || bound.owner !== this.owner) {
        throw new Error('Oracle refresh journal binding changed.');
      }
    } catch (error) { this.close(); throw error; }
  }
  close() { this.db.close(); }
  pending() { return this.db.prepare("SELECT * FROM refreshes WHERE status='PENDING'").get(); }
  reserved() { return BigInt(this.db.prepare('SELECT COUNT(*) AS count FROM refreshes').get().count) * REFRESH_RESERVATION_WEI; }
  async reserve({ raw, answer, round, updatedAt }) {
    const tx = parseTransaction(raw);
    if (tx.chainId !== this.chainId || tx.to?.toLowerCase() !== this.oracle || (tx.value ?? 0n) !== 0n
      || tx.type !== 'eip1559' || tx.data !== encodeFunctionData({ abi, functionName: 'setAnswer', args: [answer] })
      || typeof tx.gas !== 'bigint' || typeof tx.maxFeePerGas !== 'bigint'
      || tx.gas <= 0n || tx.maxFeePerGas <= 0n || tx.gas * tx.maxFeePerGas > REFRESH_RESERVATION_WEI / 2n
      || answer <= 0n || round <= 0n || updatedAt <= 0n
      || (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() !== this.owner) {
      throw new Error('Oracle refresh transaction violates its bounds.');
    }
    const hash = keccak256(raw);
    this.db.transaction(() => {
      if (this.pending()) throw new Error('Oracle refresh has an unresolved transaction.');
      if (this.db.prepare("SELECT 1 FROM refreshes WHERE status='FAILED'").get()) throw new Error('Oracle refresh requires review after a failed transaction.');
      if (this.reserved() + REFRESH_RESERVATION_WEI > REFRESH_BUDGET_WEI) throw new Error('Oracle refresh gas budget exhausted.');
      this.db.prepare("INSERT INTO refreshes VALUES(?,?,?,?,?,'PENDING',NULL)")
        .run(hash, raw, answer.toString(), round.toString(), updatedAt.toString());
    }).immediate();
    return this.pending();
  }
  resolve(hash, success, actualWei) {
    if (typeof actualWei !== 'bigint' || actualWei < 0n) throw new Error('Oracle refresh actual gas is invalid.');
    const status = success && actualWei <= REFRESH_RESERVATION_WEI ? 'CONFIRMED' : 'FAILED';
    const result = this.db.prepare("UPDATE refreshes SET status=?,actual_wei=? WHERE hash=? AND status='PENDING'")
      .run(status, actualWei.toString(), hash);
    if (result.changes !== 1) throw new Error('Oracle refresh transaction is not pending.');
    if (status === 'FAILED') throw new Error('Oracle refresh failed or exceeded its gas reservation; review required.');
  }
}
