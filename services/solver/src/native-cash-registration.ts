import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { parseProtocolJson, protocolId, stringifyProtocolJson } from '@naryx/protocol-types';
import { getAddress, recoverTypedDataAddress, zeroAddress, type Address, type Hex } from 'viem';
import { nativeCashDataPath } from './native-cash-service.js';

export interface NativeCashRegistrationBinding {
  readonly marketId: string; readonly manifestHash: Hex; readonly chainId: number;
  readonly clearingHouse: Address; readonly governor: Address;
}

const STATES = ['ACTIVE', 'ENTRY_PAUSED', 'EXIT_ONLY', 'ALL_PAUSED', 'DEPRECATED'] as const;
type State = typeof STATES[number];
type RecordRow = { manifest_hash: string; state: 'INACTIVE' | State; target_state: 'INACTIVE' | State; sequence: number; activate_at: number };
const TYPES = { NativeCashActivation: [
  { name: 'marketManifestHash', type: 'bytes32' }, { name: 'challengeId', type: 'bytes32' },
  { name: 'sequence', type: 'uint64' }, { name: 'nextState', type: 'uint8' },
  { name: 'notBefore', type: 'uint64' }, { name: 'validUntil', type: 'uint64' },
] } as const;

export class NativeCashRegistration {
  readonly #db: Database.Database;
  readonly #markets: ReadonlyMap<string, NativeCashRegistrationBinding>;
  readonly #clock: () => number;
  constructor(path: string, bindings: readonly NativeCashRegistrationBinding[], clock: () => number = Date.now) {
    this.#clock = clock;
    this.#markets = new Map(bindings.map(binding => [protocolId(binding.marketId), binding]));
    if (bindings.length < 1 || bindings.length > 8 || this.#markets.size !== bindings.length
      || bindings.some(b => ![84532, 421614].includes(b.chainId) || !/^0x[0-9a-f]{64}$/.test(b.manifestHash)
        || /^0x0{64}$/.test(b.manifestHash) || getAddress(b.governor) === zeroAddress || getAddress(b.clearingHouse) === zeroAddress)) throw new Error('Native cash registration bindings are invalid.');
    this.#db = new Database(nativeCashDataPath(path));
    this.#db.pragma('journal_mode=WAL'); this.#db.pragma('synchronous=FULL'); this.#db.pragma('busy_timeout=5000');
    this.#db.exec(`CREATE TABLE IF NOT EXISTS markets(market_id TEXT PRIMARY KEY,manifest_hash TEXT NOT NULL,
      state TEXT NOT NULL,target_state TEXT NOT NULL,sequence INTEGER NOT NULL,activate_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS challenges(challenge_id TEXT PRIMARY KEY,market_id TEXT NOT NULL,payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS authorizations(challenge_id TEXT PRIMARY KEY,market_id TEXT NOT NULL,payload TEXT NOT NULL,signature TEXT NOT NULL) STRICT;`);
    try {
      for (const binding of bindings) {
        this.#db.prepare('INSERT OR IGNORE INTO markets VALUES(?,?,\'INACTIVE\',\'INACTIVE\',0,0)').run(binding.marketId, binding.manifestHash);
        if (this.#row(binding.marketId).manifest_hash !== binding.manifestHash) throw new Error('Native cash market manifest cannot mutate in place.');
      }
    } catch (error) { this.#db.close(); throw error; }
  }
  close() { this.#db.close(); }
  #now() {
    const value = Math.floor(this.#clock() / 1000);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Native cash registration clock is invalid.');
    return value;
  }
  #row(marketId: string) {
    if (!this.#markets.has(marketId)) throw new Error('Native cash market is unknown.');
    return this.#db.prepare('SELECT * FROM markets WHERE market_id=?').get(marketId) as RecordRow;
  }
  status(marketId: string) {
    const row = this.#row(marketId);
    return { marketId, manifestHash: row.manifest_hash,
      state: this.#now() >= row.activate_at ? row.target_state : row.state,
      pendingState: this.#now() < row.activate_at ? row.target_state : null,
      sequence: row.sequence, activateAt: row.activate_at, enforcement: 'QUOTE_ADMISSION' as const };
  }
  challenge(marketId: string, state: State) {
    if (!STATES.includes(state)) throw new Error('Native cash activation state is invalid.');
    const binding = this.#markets.get(marketId); const row = this.#row(marketId);
    if (binding === undefined) throw new Error('Native cash market is unknown.');
    if (!Number.isSafeInteger(row.sequence) || row.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('Native cash registration sequence is exhausted.');
    if (this.status(marketId).state === 'DEPRECATED' && state !== 'DEPRECATED') throw new Error('Deprecated native cash markets cannot reactivate.');
    const now = this.#now();
    const challengeId = `0x${randomBytes(32).toString('hex')}` as Hex;
    const typedData = { domain: { name: 'Naryx Native Cash Activation', version: '1', chainId: binding.chainId, verifyingContract: binding.clearingHouse },
      types: TYPES, primaryType: 'NativeCashActivation' as const, message: { marketManifestHash: binding.manifestHash, challengeId,
        sequence: BigInt(row.sequence + 1), nextState: STATES.indexOf(state) + 1,
        notBefore: BigInt(state === 'ACTIVE' ? now + 60 : now), validUntil: BigInt(now + 300) } };
    this.#db.prepare('INSERT INTO challenges VALUES(?,?,?)').run(challengeId, marketId, stringifyProtocolJson(typedData));
    return { challengeId, governor: binding.governor, typedData };
  }
  async authorize(marketId: string, challengeId: string, signature: Hex) {
    if (!/^0x[0-9a-f]{64}$/.test(challengeId) || !/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error('Native cash activation signature is malformed.');
    const row = this.#db.prepare('SELECT market_id,payload FROM challenges WHERE challenge_id=?').get(challengeId) as { market_id: string; payload: string } | undefined;
    if (row === undefined || row.market_id !== marketId) throw new Error('Native cash activation challenge is unknown for this market.');
    const binding = this.#markets.get(row.market_id)!;
    const typedData = parseProtocolJson(row.payload) as ReturnType<NativeCashRegistration['challenge']>['typedData'];
    if (getAddress(await recoverTypedDataAddress({ ...typedData, signature })) !== getAddress(binding.governor)) throw new Error('Native cash activation is not signed by its onchain governor.');
    return this.#db.transaction(() => {
      const existing = this.#db.prepare('SELECT signature FROM authorizations WHERE challenge_id=?').get(challengeId) as { signature: string } | undefined;
      if (existing !== undefined) {
        if (existing.signature !== signature) throw new Error('Native cash activation signature conflicts.');
        return this.status(row.market_id);
      }
      const state = this.#row(row.market_id);
      if (typedData.message.sequence !== BigInt(state.sequence + 1) || BigInt(this.#now()) >= typedData.message.validUntil) throw new Error('Native cash activation challenge expired or was superseded.');
      this.#db.prepare('INSERT INTO authorizations VALUES(?,?,?,?)').run(challengeId, row.market_id, row.payload, signature);
      const current = this.status(row.market_id).state;
      const target = STATES[typedData.message.nextState - 1]!;
      if (current === 'DEPRECATED' && target !== 'DEPRECATED') throw new Error('Deprecated native cash markets cannot reactivate.');
      const delayed = target === 'ACTIVE' || current === 'ALL_PAUSED' && target !== 'ALL_PAUSED';
      this.#db.prepare('UPDATE markets SET state=?,target_state=?,sequence=?,activate_at=? WHERE market_id=?')
        .run(current, target, Number(typedData.message.sequence), delayed ? Math.max(this.#now() + 60, Number(typedData.message.notBefore)) : this.#now(), row.market_id);
      return this.status(row.market_id);
    }).immediate();
  }
}
