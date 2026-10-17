import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { parseProtocolJson, protocolId, stringifyProtocolJson } from '@naryx/protocol-types';
import type { EvmNativeCashRangeQuote, observeNativeCashMatch } from '@naryx/adapter-evm';
import { getAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem';

export interface NativeCashMarketPort {
  readonly marketId: string;
  readonly makerOwner: Address;
  quote(input: { owner: Address; accountId: string; side: 'BUY' | 'SELL'; quantityAtoms: bigint;
    authorizationHash: Hex; nowSeconds: bigint; lifetimeSeconds: bigint; spreadBps: number }): Promise<EvmNativeCashRangeQuote>;
  sign(quote: EvmNativeCashRangeQuote): Promise<Hex>;
  verifySignature?(quote: EvmNativeCashRangeQuote, signature: Hex): Promise<boolean>;
  observe(quote: EvmNativeCashRangeQuote, transactionHash: Hex): ReturnType<typeof observeNativeCashMatch>;
}

export interface NativeCashQuoteRequest {
  readonly requestId: string;
  readonly marketId: string;
  readonly owner: Address;
  readonly accountId: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantityAtoms: bigint;
}

export interface NativeCashSignedQuote {
  readonly version: 1;
  readonly requestId: string;
  readonly quote: EvmNativeCashRangeQuote;
  readonly makerSignature: Hex;
}

type Row = { request_id: string; request_json: string; status: 'ISSUING' | 'SIGNED' | 'FAILED'; response_json: string | null };
const SCHEMA = `
CREATE TABLE IF NOT EXISTS native_cash_quotes (
  request_id TEXT PRIMARY KEY, market_id TEXT NOT NULL, owner TEXT NOT NULL,
  request_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ISSUING','SIGNED','FAILED')),
  response_json TEXT, created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS native_cash_quote_leases (
  market_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, expires_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS native_cash_settlements (
  request_id TEXT PRIMARY KEY REFERENCES native_cash_quotes(request_id),
  transaction_hash TEXT NOT NULL UNIQUE, receipt_json TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS native_cash_receipts_no_update BEFORE UPDATE ON native_cash_settlements
  BEGIN SELECT RAISE(ABORT,'native cash receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_cash_receipts_no_delete BEFORE DELETE ON native_cash_settlements
  BEGIN SELECT RAISE(ABORT,'native cash receipts are durable'); END;
`;

export function nativeCashDataPath(value: string) {
  if (!isAbsolute(value) || value === ':memory:') throw new Error('Native cash database requires an absolute durable path.');
  const path = resolve(value);
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, '.git')) && dirname(root) !== root) root = dirname(root);
  if (existsSync(join(root, '.git')) && (path === root || path.startsWith(root + sep))) {
    throw new Error('Native cash database must be outside the repository.');
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return path;
}

export class NativeCashService {
  readonly #db: Database.Database;
  readonly #markets: ReadonlyMap<string, NativeCashMarketPort>;
  readonly #clock: () => number;

  constructor(path: string, markets: readonly NativeCashMarketPort[], clock: () => number = Date.now) {
    if (markets.length < 1 || markets.length > 8 || new Set(markets.map(m => protocolId(m.marketId))).size !== markets.length) {
      throw new Error('Native cash markets must be bounded and unique.');
    }
    this.#markets = new Map(markets.map(m => [m.marketId, m]));
    this.#clock = clock;
    this.#db = new Database(nativeCashDataPath(path));
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');
    this.#db.pragma('busy_timeout = 5000');
    this.#db.pragma('foreign_keys = ON');
    this.#db.exec(SCHEMA);
  }

  close() { this.#db.close(); }

  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Native cash clock is invalid.');
    return now;
  }

  quote(requestId: string): NativeCashSignedQuote | undefined {
    const row = this.#db.prepare('SELECT response_json FROM native_cash_quotes WHERE request_id=? AND status=\'SIGNED\'')
      .get(protocolId(requestId)) as { response_json: string } | undefined;
    return row === undefined ? undefined : parseProtocolJson(row.response_json) as NativeCashSignedQuote;
  }

  async requestQuote(input: NativeCashQuoteRequest): Promise<NativeCashSignedQuote> {
    const request: NativeCashQuoteRequest = { requestId: protocolId(input.requestId), marketId: protocolId(input.marketId),
      owner: getAddress(input.owner), accountId: protocolId(input.accountId), side: input.side, quantityAtoms: input.quantityAtoms };
    if (!['BUY', 'SELL'].includes(request.side) || typeof request.quantityAtoms !== 'bigint'
      || request.quantityAtoms <= 0n || request.quantityAtoms > (1n << 127n) - 1n) throw new Error('Native cash request is invalid.');
    const market = this.#markets.get(request.marketId);
    if (market === undefined) throw new Error('Native cash market is not activated.');
    const requestJson = stringifyProtocolJson(request);
    const stored = () => {
      const row = this.#db.prepare('SELECT * FROM native_cash_quotes WHERE request_id=?').get(request.requestId) as Row | undefined;
      if (row !== undefined) {
        if (row.request_json !== requestJson) throw new Error('Native cash request ID belongs to different terms.');
        if (row.status !== 'SIGNED') throw new Error('Native cash request needs a fresh ID after interrupted or failed issuance.');
        return this.quote(request.requestId)!;
      }
      return undefined;
    };
    const previous = stored();
    if (previous !== undefined) return previous;
    const now = this.#now();
    const quote = await market.quote({ owner: request.owner, accountId: request.accountId, side: request.side,
      quantityAtoms: request.quantityAtoms, authorizationHash: `0x${randomBytes(32).toString('hex')}`,
      nowSeconds: BigInt(Math.floor(now / 1000)), lifetimeSeconds: 20n, spreadBps: 10 });
    if (quote.marketId !== request.marketId || quote.owner !== request.owner || quote.side !== request.side
      || quote.match.quantityAtoms !== request.quantityAtoms || quote.makerOwner !== getAddress(market.makerOwner)) {
      throw new Error('Native cash quote does not match its request.');
    }
    const existing = this.#db.transaction(() => {
      const result = stored(); if (result !== undefined) return result;
      const current = this.#now();
      if (quote.match.expiry * 1000n < BigInt(current + 5000)) throw new Error('Native cash quote expired before issuance.');
      const lease = this.#db.prepare('SELECT request_id,expires_at_ms FROM native_cash_quote_leases WHERE market_id=?')
        .get(request.marketId) as { request_id: string; expires_at_ms: number } | undefined;
      if (lease !== undefined && lease.expires_at_ms > current) {
        const previousQuote = this.quote(lease.request_id)?.quote;
        const makerSequence = quote.side === 'BUY' ? quote.match.shortSequence : quote.match.longSequence;
        const previousSequence = previousQuote?.side === 'BUY' ? previousQuote.match.shortSequence : previousQuote?.match.longSequence;
        if (previousQuote === undefined || previousSequence === undefined || makerSequence <= previousSequence
          || quote.clearingHouse !== previousQuote.clearingHouse || quote.chainId !== previousQuote.chainId
          || quote.makerOwner !== previousQuote.makerOwner || quote.observedBlock.number < previousQuote.observedBlock.number) {
          throw new Error('Native cash maker has an outstanding quote; retry after expiry.');
        }
      }
      this.#db.prepare('INSERT INTO native_cash_quotes VALUES(?,?,?,?,\'ISSUING\',NULL,?)')
        .run(request.requestId, request.marketId, request.owner, requestJson, now);
      this.#db.prepare('INSERT INTO native_cash_quote_leases VALUES(?,?,?) ON CONFLICT(market_id) DO UPDATE SET request_id=excluded.request_id,expires_at_ms=excluded.expires_at_ms')
        .run(request.marketId, request.requestId, current + 60_000);
      return undefined;
    }).immediate();
    if (existing !== undefined) return existing;
    try {
      const makerSignature = await market.sign(quote);
      const verified = market.verifySignature === undefined
        ? getAddress(await recoverTypedDataAddress({ ...quote.typedData, signature: makerSignature })) === getAddress(market.makerOwner)
        : await market.verifySignature(quote, makerSignature);
      if (!verified) {
        throw new Error('Native cash maker signature differs.');
      }
      const result: NativeCashSignedQuote = { version: 1, requestId: request.requestId, quote, makerSignature };
      this.#db.transaction(() => {
        const current = this.#now();
        const lease = this.#db.prepare('SELECT request_id,expires_at_ms FROM native_cash_quote_leases WHERE market_id=?')
          .get(request.marketId) as { request_id: string; expires_at_ms: number };
        if (lease.request_id !== request.requestId || lease.expires_at_ms <= current
          || quote.match.expiry * 1000n < BigInt(current + 5000)) throw new Error('Native cash quote expired during issuance.');
        this.#db.prepare('UPDATE native_cash_quotes SET status=\'SIGNED\',response_json=? WHERE request_id=? AND status=\'ISSUING\'')
          .run(stringifyProtocolJson(result), request.requestId);
        this.#db.prepare('UPDATE native_cash_quote_leases SET expires_at_ms=? WHERE market_id=? AND request_id=?')
          .run(Number(quote.match.expiry * 1000n), request.marketId, request.requestId);
      }).immediate();
      return result;
    } catch (error) {
      this.#db.prepare('UPDATE native_cash_quotes SET status=\'FAILED\' WHERE request_id=? AND status=\'ISSUING\'').run(request.requestId);
      throw error;
    }
  }

  settlement(requestId: string) {
    const row = this.#db.prepare('SELECT receipt_json FROM native_cash_settlements WHERE request_id=?').get(protocolId(requestId)) as { receipt_json: string } | undefined;
    return row === undefined ? undefined : parseProtocolJson(row.receipt_json) as Awaited<ReturnType<typeof observeNativeCashMatch>>;
  }

  trades(marketId: string) {
    if (!this.#markets.has(marketId)) throw new Error('Native cash market is not activated.');
    const rows = this.#db.prepare(`SELECT settlements.receipt_json FROM native_cash_settlements settlements
      JOIN native_cash_quotes quotes ON quotes.request_id=settlements.request_id
      WHERE quotes.market_id=? ORDER BY settlements.recorded_at_ms DESC,settlements.request_id LIMIT 100`)
      .all(marketId) as { receipt_json: string }[];
    return rows.map(row => parseProtocolJson(row.receipt_json) as Awaited<ReturnType<typeof observeNativeCashMatch>>);
  }

  async observe(requestId: string, transactionHash: Hex) {
    if (!/^0x[0-9a-f]{64}$/i.test(transactionHash)) throw new Error('Native cash transaction hash is invalid.');
    const previous = this.settlement(requestId);
    if (previous !== undefined) {
      if (previous.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) throw new Error('Native cash quote already settled in a different transaction.');
      return previous;
    }
    const signed = this.quote(requestId);
    if (signed === undefined) throw new Error('Native cash signed quote was not found.');
    const receipt = await this.#markets.get(signed.quote.marketId)!.observe(signed.quote, transactionHash);
    if (receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase() || receipt.quoteDigest !== signed.quote.digest
      || receipt.marketId !== signed.quote.marketId || receipt.owner !== signed.quote.owner
      || receipt.makerOwner !== signed.quote.makerOwner || receipt.authorizationHash !== signed.quote.match.authorizationHash
      || receipt.quantityAtoms !== signed.quote.match.quantityAtoms || receipt.priceTicks !== signed.quote.match.priceTicks
      || receipt.environment !== 'testnet' || receipt.evidenceGrade !== 'FINALIZED_CONTRACT_RECEIPT') {
      throw new Error('Native cash verified receipt differs from its stored quote.');
    }
    return this.#db.transaction(() => {
      const existing = this.settlement(requestId);
      if (existing !== undefined) {
        if (existing.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) throw new Error('Native cash settlement conflicts.');
        return existing;
      }
      this.#db.prepare('INSERT INTO native_cash_settlements VALUES(?,?,?,?)')
        .run(requestId, transactionHash.toLowerCase(), stringifyProtocolJson(receipt), this.#now());
      return receipt;
    }).immediate();
  }
}
