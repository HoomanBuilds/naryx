import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  commitmentHash,
  fromProtocolJson,
  parseProtocolJson,
  sealedAuctionDefinition,
  sealedAuctionHash,
  sealedQuoteCommitment,
  solverRequestDigest,
  stringifyProtocolJson,
  toHex,
  toProtocolJson,
  type ExpiryUnit,
  type SealedAuctionDefinition,
  type SealedAuctionDefinitionInput,
} from '@naryx/protocol-types';

const HASH = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RESPONSE_BYTES = 1_048_576;

export interface EligibleSealedAuction {
  readonly cursor: number;
  readonly auctionHash: string;
  readonly definition: SealedAuctionDefinition;
  readonly createdAtMs: number;
}

export interface EligibleSealedAuctionPage {
  readonly auctions: readonly EligibleSealedAuction[];
  readonly nextCursor: number;
}

export interface SealedAuctionRelayPort {
  poll(after: number): Promise<EligibleSealedAuctionPage>;
  commit(auctionHash: string, commitment: string): Promise<void>;
  reveal(auctionHash: string, opening: Readonly<{
    quoteHash: string;
    netOutcomeAtoms: bigint;
    salt: Uint8Array;
  }>): Promise<void>;
  view(auctionHash: string): Promise<Readonly<{
    phase: 'COMMIT' | 'REVEAL' | 'CLOSED';
    outcome?: 'AWARDED' | 'NO_FILL';
    winner?: Readonly<{ solverId: string; quoteHash: string }>;
  }>>;
  finalizeAward(auctionHash: string, quoteHash: string): Promise<void>;
}

export interface SealedAuctionQuoteTerms {
  readonly quoteHash: string;
  readonly orderHash: string;
  readonly environment: string;
  readonly solverId: string;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly netOutcomeAtoms: bigint;
}

export interface SealedAuctionQuotePort {
  quote(input: Readonly<{ orderHash: string; idempotencyKey: string }>): Promise<SealedAuctionQuoteTerms>;
}

export interface SealedAuctionSigner {
  signDigest(digest: Uint8Array): Uint8Array;
}

export class SealedAuctionRelayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SealedAuctionRelayError';
    this.status = status;
    this.code = code;
  }
}

function loopbackOrigin(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('sealed auction relay origin must be loopback HTTP');
  }
  return url.origin;
}

async function boundedProtocolJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('sealed auction relay response is too large');
  let value: unknown;
  try {
    value = fromProtocolJson(JSON.parse(text));
  } catch {
    throw new Error('sealed auction relay response is malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('sealed auction relay response must be an object');
  }
  return value as Record<string, unknown>;
}

export class HttpSealedAuctionRelay implements SealedAuctionRelayPort {
  readonly #origin: string;
  readonly #solverId: string;
  readonly #keyId: string;
  readonly #signer: SealedAuctionSigner;
  readonly #fetch: typeof fetch;
  readonly #clockMs: () => number;

  constructor(input: Readonly<{
    origin: string;
    solverId: string;
    keyId: string;
    signer: SealedAuctionSigner;
    fetch?: typeof fetch;
    clockMs?: () => number;
  }>) {
    this.#origin = loopbackOrigin(input.origin);
    if (!IDENTIFIER.test(input.solverId) || !IDENTIFIER.test(input.keyId)) {
      throw new Error('sealed auction solver and key identifiers are invalid');
    }
    this.#solverId = input.solverId;
    this.#keyId = input.keyId;
    this.#signer = input.signer;
    this.#fetch = input.fetch ?? fetch;
    this.#clockMs = input.clockMs ?? Date.now;
  }

  async #call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    const text = body === undefined ? '' : JSON.stringify(toProtocolJson(body));
    const timestampMs = BigInt(Math.floor(this.#clockMs()));
    const nonce = randomBytes(32).toString('hex');
    const digest = solverRequestDigest({
      method,
      pathAndQuery: path,
      bodySha256: new Uint8Array(createHash('sha256').update(text).digest()),
      solverId: this.#solverId,
      keyId: this.#keyId,
      timestampMs,
      nonce,
    });
    const signature = this.#signer.signDigest(digest);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) {
      throw new Error('sealed auction signer must return a 64-byte signature');
    }
    const response = await this.#fetch(`${this.#origin}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
      headers: {
        Accept: 'application/json',
        ...(text === '' ? {} : { 'Content-Type': 'application/json' }),
        'X-Naryx-Solver': this.#solverId,
        'X-Naryx-Key': this.#keyId,
        'X-Naryx-Timestamp': timestampMs.toString(),
        'X-Naryx-Nonce': nonce,
        'X-Naryx-Signature': toHex(signature),
      },
      ...(text === '' ? {} : { body: text }),
    });
    const parsed = await boundedProtocolJson(response);
    if (!response.ok) {
      const error = typeof parsed.error === 'object' && parsed.error !== null
        ? parsed.error as Record<string, unknown>
        : {};
      throw new SealedAuctionRelayError(response.status, String(error.code ?? 'RELAY_ERROR'), String(error.message ?? 'sealed auction relay rejected the request'));
    }
    return parsed;
  }

  async poll(after: number): Promise<EligibleSealedAuctionPage> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('sealed auction cursor is invalid');
    const body = await this.#call('GET', `/v1/solver/auctions?after=${after}`);
    if (!Array.isArray(body.auctions)) throw new Error('sealed auction relay did not return auctions');
    let previous = after;
    const auctions = body.auctions.map((value, index) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`sealed auction ${index} is invalid`);
      }
      const entry = value as Record<string, unknown>;
      if (typeof entry.cursor !== 'number' || !Number.isSafeInteger(entry.cursor) || entry.cursor <= previous
        || typeof entry.auctionHash !== 'string' || !HASH.test(entry.auctionHash)
        || typeof entry.createdAtMs !== 'number' || !Number.isSafeInteger(entry.createdAtMs) || entry.createdAtMs < 0) {
        throw new Error(`sealed auction ${index} fields are invalid`);
      }
      previous = entry.cursor;
      const definition = sealedAuctionDefinition(entry.definition as SealedAuctionDefinitionInput);
      if (toHex(sealedAuctionHash(definition)) !== entry.auctionHash
        || !definition.eligibleSolverIds.some((solverId) => solverId === this.#solverId)) {
        throw new Error(`sealed auction ${index} binding is invalid`);
      }
      return Object.freeze({ cursor: entry.cursor, auctionHash: entry.auctionHash, definition, createdAtMs: entry.createdAtMs });
    });
    if (typeof body.nextCursor !== 'number' || !Number.isSafeInteger(body.nextCursor) || body.nextCursor < previous) {
      throw new Error('sealed auction next cursor is invalid');
    }
    return Object.freeze({ auctions: Object.freeze(auctions), nextCursor: body.nextCursor });
  }

  async commit(auctionHash: string, commitment: string): Promise<void> {
    if (!HASH.test(auctionHash) || !HASH.test(commitment)) throw new Error('sealed auction commitment is invalid');
    await this.#call('POST', `/v1/solver/auctions/${auctionHash}/commit`, { commitment });
  }

  async reveal(auctionHash: string, opening: Readonly<{ quoteHash: string; netOutcomeAtoms: bigint; salt: Uint8Array }>): Promise<void> {
    if (!HASH.test(auctionHash) || !HASH.test(opening.quoteHash) || opening.salt.length !== 32) {
      throw new Error('sealed auction opening is invalid');
    }
    await this.#call('POST', `/v1/solver/auctions/${auctionHash}/reveal`, opening);
  }

  async view(auctionHash: string): Promise<Readonly<{
    phase: 'COMMIT' | 'REVEAL' | 'CLOSED';
    outcome?: 'AWARDED' | 'NO_FILL';
    winner?: Readonly<{ solverId: string; quoteHash: string }>;
  }>> {
    if (!HASH.test(auctionHash)) throw new Error('sealed auction hash is invalid');
    const body = await this.#call('GET', `/v1/auctions/sealed/${auctionHash}`);
    if (body.phase !== 'COMMIT' && body.phase !== 'REVEAL' && body.phase !== 'CLOSED') {
      throw new Error('sealed auction view phase is invalid');
    }
    const definition = sealedAuctionDefinition(body.definition as SealedAuctionDefinitionInput);
    if (toHex(sealedAuctionHash(definition)) !== auctionHash) throw new Error('sealed auction view binding is invalid');
    if (body.phase !== 'CLOSED') return Object.freeze({ phase: body.phase });
    if (typeof body.result !== 'object' || body.result === null || Array.isArray(body.result)) {
      throw new Error('sealed auction result is invalid');
    }
    const result = body.result as Record<string, unknown>;
    if (result.outcome === 'NO_FILL') return Object.freeze({ phase: 'CLOSED' as const, outcome: 'NO_FILL' as const });
    if (result.outcome !== 'AWARDED' || typeof result.winner !== 'object' || result.winner === null || Array.isArray(result.winner)) {
      throw new Error('sealed auction award is invalid');
    }
    const winner = result.winner as Record<string, unknown>;
    let winnerQuoteHash: string;
    try {
      winnerQuoteHash = toHex(commitmentHash(winner.quoteHash as Uint8Array | string, 'sealedAuction.winner.quoteHash'));
    } catch {
      throw new Error('sealed auction winner is invalid');
    }
    if (typeof winner.solverId !== 'string' || !IDENTIFIER.test(winner.solverId) || !HASH.test(winnerQuoteHash)) {
      throw new Error('sealed auction winner is invalid');
    }
    return Object.freeze({
      phase: 'CLOSED' as const,
      outcome: 'AWARDED' as const,
      winner: Object.freeze({ solverId: winner.solverId, quoteHash: winnerQuoteHash }),
    });
  }

  async finalizeAward(auctionHash: string, quoteHash: string): Promise<void> {
    if (!HASH.test(auctionHash) || !HASH.test(quoteHash)) throw new Error('sealed auction award is invalid');
    const body = await this.#call('POST', `/v1/auctions/sealed/${auctionHash}/award`, {});
    if (body.auctionHash !== auctionHash || body.quoteHash !== quoteHash || body.awardSolverId !== this.#solverId) {
      throw new Error('sealed auction finalized another award');
    }
  }
}

type AuctionStatus = 'DISCOVERED' | 'OPENING_READY' | 'COMMITTED' | 'REVEALED' | 'MISSED_COMMIT' | 'MISSED_REVEAL';

interface AuctionRow {
  readonly auction_hash: string;
  readonly cursor: number;
  readonly definition_json: string;
  readonly quote_hash: string | null;
  readonly net_outcome_atoms: string | null;
  readonly salt: Uint8Array | null;
  readonly status: AuctionStatus;
  readonly award_state: 'PENDING' | 'FINALIZED' | 'NOT_AWARDED';
  readonly last_error: string | null;
}

export interface SealedAuctionJournalRecord {
  readonly auctionHash: string;
  readonly cursor: number;
  readonly definition: SealedAuctionDefinition;
  readonly quoteHash?: string;
  readonly netOutcomeAtoms?: bigint;
  readonly salt?: Uint8Array;
  readonly status: AuctionStatus;
  readonly awardState: 'PENDING' | 'FINALIZED' | 'NOT_AWARDED';
  readonly lastError?: string;
}

function repositoryRoot(): string | undefined {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function databasePath(value: string): string {
  if (!isAbsolute(value) || value === ':memory:') throw new Error('sealed auction journal path must be absolute');
  const path = resolve(value);
  const root = repositoryRoot();
  if (root !== undefined && (path === root || path.startsWith(resolve(root) + sep))) {
    throw new Error('sealed auction journal must remain outside the repository');
  }
  return path;
}

function decodeRow(row: AuctionRow): SealedAuctionJournalRecord {
  const definition = sealedAuctionDefinition(parseProtocolJson(row.definition_json) as SealedAuctionDefinitionInput);
  if (toHex(sealedAuctionHash(definition)) !== row.auction_hash) throw new Error('sealed auction journal hash mismatch');
  const hasOpening = row.quote_hash !== null || row.net_outcome_atoms !== null || row.salt !== null;
  if (hasOpening && (row.quote_hash === null || !HASH.test(row.quote_hash)
    || row.net_outcome_atoms === null || !/^-?(0|[1-9]\d*)$/.test(row.net_outcome_atoms)
    || row.salt === null || row.salt.length !== 32)) {
    throw new Error('sealed auction journal opening is invalid');
  }
  if (['OPENING_READY', 'COMMITTED', 'REVEALED', 'MISSED_REVEAL'].includes(row.status) && !hasOpening) {
    throw new Error('sealed auction journal status has no opening');
  }
  return Object.freeze({
    auctionHash: row.auction_hash,
    cursor: row.cursor,
    definition,
    ...(row.quote_hash === null ? {} : {
      quoteHash: row.quote_hash,
      netOutcomeAtoms: BigInt(row.net_outcome_atoms as string),
      salt: Uint8Array.from(row.salt as Uint8Array),
    }),
    status: row.status,
    awardState: row.award_state,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  });
}

export class SqliteSealedAuctionJournal {
  readonly #db: Database.Database;

  constructor(pathInput: string) {
    const path = databasePath(pathInput);
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');
    this.#db.pragma('trusted_schema = OFF');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sealed_auction_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cursor INTEGER NOT NULL CHECK (cursor >= 0)
      ) STRICT;
      INSERT OR IGNORE INTO sealed_auction_cursor (singleton, cursor) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS sealed_auction_participation (
        auction_hash TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL UNIQUE,
        definition_json TEXT NOT NULL,
        quote_hash TEXT,
        net_outcome_atoms TEXT,
        salt BLOB,
        status TEXT NOT NULL CHECK (status IN ('DISCOVERED','OPENING_READY','COMMITTED','REVEALED','MISSED_COMMIT','MISSED_REVEAL')),
        award_state TEXT NOT NULL DEFAULT 'PENDING' CHECK (award_state IN ('PENDING','FINALIZED','NOT_AWARDED')),
        last_error TEXT,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    const columns = this.#db.prepare('PRAGMA table_info(sealed_auction_participation)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'award_state')) {
      this.#db.exec("ALTER TABLE sealed_auction_participation ADD COLUMN award_state TEXT NOT NULL DEFAULT 'PENDING' CHECK (award_state IN ('PENDING','FINALIZED','NOT_AWARDED'))");
    }
  }

  cursor(): number {
    const row = this.#db.prepare('SELECT cursor FROM sealed_auction_cursor WHERE singleton = 1').get() as { cursor: number };
    return row.cursor;
  }

  discover(page: EligibleSealedAuctionPage, nowMs: number): void {
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < this.cursor()) throw new Error('sealed auction page cursor regressed');
    this.#db.transaction(() => {
      const insert = this.#db.prepare(
        `INSERT OR IGNORE INTO sealed_auction_participation
         (auction_hash, cursor, definition_json, status, updated_at_ms) VALUES (?, ?, ?, 'DISCOVERED', ?)`,
      );
      for (const auction of page.auctions) {
        if (toHex(sealedAuctionHash(auction.definition)) !== auction.auctionHash) throw new Error('sealed auction page hash mismatch');
        insert.run(auction.auctionHash, auction.cursor, stringifyProtocolJson(auction.definition), nowMs);
        const existing = this.get(auction.auctionHash);
        if (existing === undefined || existing.cursor !== auction.cursor
          || stringifyProtocolJson(existing.definition) !== stringifyProtocolJson(auction.definition)) {
          throw new Error('sealed auction page conflicts with the journal');
        }
      }
      this.#db.prepare('UPDATE sealed_auction_cursor SET cursor = ? WHERE singleton = 1').run(page.nextCursor);
    })();
  }

  get(auctionHash: string): SealedAuctionJournalRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM sealed_auction_participation WHERE auction_hash = ?').get(auctionHash) as AuctionRow | undefined;
    return row === undefined ? undefined : decodeRow(row);
  }

  active(): readonly SealedAuctionJournalRecord[] {
    const rows = this.#db.prepare(
      "SELECT * FROM sealed_auction_participation WHERE status IN ('DISCOVERED','OPENING_READY','COMMITTED') OR (status = 'REVEALED' AND award_state = 'PENDING') ORDER BY cursor",
    ).all() as AuctionRow[];
    return Object.freeze(rows.map(decodeRow));
  }

  saveOpening(auctionHash: string, quoteHash: string, netOutcomeAtoms: bigint, salt: Uint8Array, nowMs: number): void {
    if (!HASH.test(quoteHash) || salt.length !== 32) throw new Error('sealed auction opening is invalid');
    const existing = this.get(auctionHash);
    if (existing === undefined) throw new Error('sealed auction is not journaled');
    if (existing.status !== 'DISCOVERED') {
      if (existing.quoteHash === quoteHash && existing.netOutcomeAtoms === netOutcomeAtoms
        && existing.salt !== undefined && Buffer.from(existing.salt).equals(Buffer.from(salt))) return;
      throw new Error('sealed auction opening conflicts with the journal');
    }
    this.#db.prepare(
      `UPDATE sealed_auction_participation
       SET quote_hash = ?, net_outcome_atoms = ?, salt = ?, status = 'OPENING_READY', last_error = NULL, updated_at_ms = ?
       WHERE auction_hash = ? AND status = 'DISCOVERED'`,
    ).run(quoteHash, netOutcomeAtoms.toString(), Buffer.from(salt), nowMs, auctionHash);
  }

  mark(auctionHash: string, from: AuctionStatus, to: AuctionStatus, nowMs: number): void {
    const result = this.#db.prepare(
      'UPDATE sealed_auction_participation SET status = ?, last_error = NULL, updated_at_ms = ? WHERE auction_hash = ? AND status = ?',
    ).run(to, nowMs, auctionHash, from);
    if (result.changes !== 1 && this.get(auctionHash)?.status !== to) throw new Error('sealed auction journal transition failed');
  }

  markAward(auctionHash: string, state: 'FINALIZED' | 'NOT_AWARDED', nowMs: number): void {
    const result = this.#db.prepare(
      "UPDATE sealed_auction_participation SET award_state = ?, last_error = NULL, updated_at_ms = ? WHERE auction_hash = ? AND status = 'REVEALED' AND award_state = 'PENDING'",
    ).run(state, nowMs, auctionHash);
    if (result.changes !== 1 && this.get(auctionHash)?.awardState !== state) {
      throw new Error('sealed auction award transition failed');
    }
  }

  recordError(auctionHash: string, error: unknown, nowMs: number): void {
    const message = error instanceof Error ? error.message : 'unknown sealed auction error';
    this.#db.prepare(
      'UPDATE sealed_auction_participation SET last_error = ?, updated_at_ms = ? WHERE auction_hash = ?',
    ).run(message.slice(0, 1_024), nowMs, auctionHash);
  }

  close(): void {
    this.#db.close();
  }
}

function currentValue(unit: ExpiryUnit, nowMs: number): bigint {
  if (unit === 'EVM_UNIX_SECONDS') return BigInt(Math.floor(nowMs / 1_000));
  if (unit === 'HYPERLIQUID_UNIX_MILLISECONDS') return BigInt(nowMs);
  throw new Error('sealed auction participant does not support slot-timed auctions');
}

export class SealedAuctionParticipant {
  readonly #solverId: string;
  readonly #relay: SealedAuctionRelayPort;
  readonly #quotes: SealedAuctionQuotePort;
  readonly #journal: SqliteSealedAuctionJournal;
  readonly #clockMs: () => number;
  readonly #salt: () => Uint8Array;
  #running = false;

  constructor(input: Readonly<{
    solverId: string;
    relay: SealedAuctionRelayPort;
    quotes: SealedAuctionQuotePort;
    journal: SqliteSealedAuctionJournal;
    clockMs?: () => number;
    salt?: () => Uint8Array;
  }>) {
    if (!IDENTIFIER.test(input.solverId)) throw new Error('sealed auction solver id is invalid');
    this.#solverId = input.solverId;
    this.#relay = input.relay;
    this.#quotes = input.quotes;
    this.#journal = input.journal;
    this.#clockMs = input.clockMs ?? Date.now;
    this.#salt = input.salt ?? (() => new Uint8Array(randomBytes(32)));
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        const before = this.#journal.cursor();
        const page = await this.#relay.poll(before);
        this.#journal.discover(page, this.#clockMs());
        if (page.nextCursor === before) break;
      }
      for (const record of this.#journal.active()) await this.#advance(record);
    } finally {
      this.#running = false;
    }
  }

  start(intervalMs = 1_000, onError: (error: unknown) => void = () => undefined): () => void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) throw new Error('sealed auction poll interval is invalid');
    const run = () => { void this.tick().catch(onError); };
    run();
    const timer = setInterval(run, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async #advance(initial: SealedAuctionJournalRecord): Promise<void> {
    let record = initial;
    const nowMs = this.#clockMs();
    const now = currentValue(record.definition.timeUnit, nowMs);
    try {
      if (!record.definition.eligibleSolverIds.some((solverId) => solverId === this.#solverId)) {
        throw new Error('sealed auction is not addressed to this solver');
      }
      if (record.status === 'DISCOVERED') {
        if (now >= record.definition.commitDeadlineValue) {
          this.#journal.mark(record.auctionHash, 'DISCOVERED', 'MISSED_COMMIT', nowMs);
          return;
        }
        const orderHash = toHex(record.definition.orderHash);
        const quote = await this.#quotes.quote({
          orderHash,
          idempotencyKey: `sealed-auction.${record.auctionHash}`,
        });
        if (!HASH.test(quote.quoteHash) || quote.orderHash !== orderHash
          || quote.environment !== record.definition.environment || quote.solverId !== this.#solverId
          || quote.validUntilUnit !== record.definition.timeUnit
          || quote.validUntilValue < record.definition.settlementDeadlineValue) {
          throw new Error('sealed auction quote does not cover the auction settlement window');
        }
        const salt = this.#salt();
        if (!(salt instanceof Uint8Array) || salt.length !== 32) throw new Error('sealed auction salt source must return 32 bytes');
        this.#journal.saveOpening(record.auctionHash, quote.quoteHash, quote.netOutcomeAtoms, salt, nowMs);
        record = this.#journal.get(record.auctionHash) as SealedAuctionJournalRecord;
      }
      if (record.status === 'OPENING_READY') {
        const commitNowMs = this.#clockMs();
        const commitNow = currentValue(record.definition.timeUnit, commitNowMs);
        if (commitNow >= record.definition.commitDeadlineValue) {
          this.#journal.mark(record.auctionHash, 'OPENING_READY', 'MISSED_COMMIT', commitNowMs);
          return;
        }
        const commitment = sealedQuoteCommitment(record.auctionHash, {
          solverId: this.#solverId,
          quoteHash: record.quoteHash as string,
          netOutcomeAtoms: record.netOutcomeAtoms as bigint,
          salt: record.salt as Uint8Array,
        });
        await this.#relay.commit(record.auctionHash, toHex(commitment));
        this.#journal.mark(record.auctionHash, 'OPENING_READY', 'COMMITTED', this.#clockMs());
        record = this.#journal.get(record.auctionHash) as SealedAuctionJournalRecord;
      }
      if (record.status === 'COMMITTED') {
        const revealNowMs = this.#clockMs();
        const revealNow = currentValue(record.definition.timeUnit, revealNowMs);
        if (revealNow < record.definition.commitDeadlineValue) return;
        if (revealNow >= record.definition.revealDeadlineValue) {
          this.#journal.mark(record.auctionHash, 'COMMITTED', 'MISSED_REVEAL', revealNowMs);
          return;
        }
        await this.#relay.reveal(record.auctionHash, {
          quoteHash: record.quoteHash as string,
          netOutcomeAtoms: record.netOutcomeAtoms as bigint,
          salt: record.salt as Uint8Array,
        });
        this.#journal.mark(record.auctionHash, 'COMMITTED', 'REVEALED', this.#clockMs());
        record = this.#journal.get(record.auctionHash) as SealedAuctionJournalRecord;
      }
      if (record.status !== 'REVEALED' || record.awardState !== 'PENDING') return;
      const view = await this.#relay.view(record.auctionHash);
      if (view.phase !== 'CLOSED') return;
      if (view.outcome !== 'AWARDED' || view.winner?.solverId !== this.#solverId) {
        this.#journal.markAward(record.auctionHash, 'NOT_AWARDED', this.#clockMs());
        return;
      }
      if (view.winner.quoteHash !== record.quoteHash) throw new Error('sealed auction award changed the committed quote');
      const quote = await this.#quotes.quote({
        orderHash: toHex(record.definition.orderHash),
        idempotencyKey: `sealed-auction.${record.auctionHash}`,
      });
      if (quote.quoteHash !== record.quoteHash) throw new Error('sealed auction quote replay changed');
      await this.#relay.finalizeAward(record.auctionHash, quote.quoteHash);
      this.#journal.markAward(record.auctionHash, 'FINALIZED', this.#clockMs());
    } catch (error) {
      this.#journal.recordError(record.auctionHash, error, this.#clockMs());
    }
  }
}
