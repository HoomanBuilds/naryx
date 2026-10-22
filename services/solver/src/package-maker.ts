import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { parseProtocolJson, stringifyProtocolJson, type AssetRef, type DomainRef,
  type ImpliedPackageQuoteInput, type SolverCapacityRecordInput } from '@naryx/protocol-types';
import { HttpMakerShardGateway } from './maker-control.js';

export const PACKAGE_MAKER_LEVELS = 16;

export async function readMakerLevels<T>(quantities: readonly bigint[], read: (quantity: bigint) => Promise<T>): Promise<T[]> {
  const values: T[] = [];
  for (let i = 0; i < quantities.length; i += 2) values.push(...await Promise.all(quantities.slice(i, i + 2).map(read)));
  return values;
}

export function makerPriceTicks(price: bigint, side: 'BID' | 'ASK', level: number): bigint {
  if (price < 0n || !Number.isInteger(level) || level < 0 || level >= PACKAGE_MAKER_LEVELS) {
    throw new Error('Maker price or level is invalid.');
  }
  const buffer = BigInt(level + 1);
  return side === 'ASK' ? (price * (10_000n + buffer) + 9_999n) / 10_000n
    : price * (10_000n - buffer) / 10_000n;
}

export interface PackageMakerSnapshot {
  readonly capacity: SolverCapacityRecordInput;
  readonly bookNow: bigint;
  readonly quotes: readonly Readonly<{
    key: string;
    backingAtoms: bigint;
    quote: Omit<ImpliedPackageQuoteInput, 'solverCommitment' | 'evidence'>;
  }>[];
}

export interface PackageMakerGateway {
  invalidate(sourceId: string, version: bigint): Promise<void>;
  capacity(record: SolverCapacityRecordInput): Promise<void>;
  reserve(scope: Readonly<{ domain: DomainRef; asset: AssetRef }>, id: string, atoms: bigint): Promise<void>;
  release(scope: Readonly<{ domain: DomainRef; asset: AssetRef }>, id: string): Promise<boolean>;
  publish(marketId: string, quotes: readonly Readonly<{ quote: ImpliedPackageQuoteInput; expiresAtValue: bigint }>[],
    replaceSources?: readonly Readonly<{ sourceId: string; sourceVersion: bigint }>[]): Promise<void>;
}

export class HttpPackageMakerGateway extends HttpMakerShardGateway implements PackageMakerGateway {
  async invalidate(sourceId: string, version: bigint) {
    await this.request('PUT', `/v1/solver/sources/${sourceId}/version`, { sourceVersion: version });
  }
  async capacity(record: SolverCapacityRecordInput) { await this.request('PUT', '/v1/solver/capacity', { record }); }
  async reserve(scope: Readonly<{ domain: DomainRef; asset: AssetRef }>, id: string, atoms: bigint) {
    await this.request('POST', '/v1/solver/reservations', { ...scope,
      commitment: { commitmentId: id, atoms, recoveryAtoms: 0n, firm: true } });
  }
  async release(scope: Readonly<{ domain: DomainRef; asset: AssetRef }>, id: string) {
    try {
      await this.request('POST', '/v1/solver/reservations/release', { ...scope, commitmentId: id });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('BACKING_IN_USE:')) return false;
      throw error;
    }
  }
  async publish(marketId: string, quotes: readonly Readonly<{ quote: ImpliedPackageQuoteInput; expiresAtValue: bigint }>[],
    replaceSources?: readonly Readonly<{ sourceId: string; sourceVersion: bigint }>[]) {
    const response = await this.request('POST', '/v1/solver/quotes/batch', { packageMarketId: marketId, quotes, replaceSources });
    if (!Array.isArray(response.entries) || response.entries.length !== quotes.length) {
      throw new Error('Package maker publication response differs from the submitted batch.');
    }
  }
}

export class PackageMakerJournal {
  readonly #db: Database.Database;
  constructor(path: string) {
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS package_maker_bindings (
        market_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, source_version TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS package_maker_holds (
        commitment_id TEXT PRIMARY KEY, market_id TEXT NOT NULL, scope_json TEXT NOT NULL,
        atoms TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('PENDING','HELD','ALLOCATED','RELEASED'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS package_maker_holds_market_state ON package_maker_holds (market_id, state);
      CREATE TABLE IF NOT EXISTS package_maker_release_totals (
        market_id TEXT NOT NULL, scope_json TEXT NOT NULL, released_count TEXT NOT NULL, released_atoms TEXT NOT NULL,
        PRIMARY KEY (market_id, scope_json)
      ) STRICT;
    `);
  }
  bind(marketId: string, binding: unknown) {
    const encoded = stringifyProtocolJson(binding);
    this.#db.prepare('INSERT OR IGNORE INTO package_maker_bindings VALUES (?, ?, ?)').run(marketId, encoded, '0');
    const current = this.#db.prepare('SELECT binding_json FROM package_maker_bindings WHERE market_id=?')
      .get(marketId) as { binding_json: string };
    if (current.binding_json !== encoded) throw new Error('Package maker journal binding changed; retire previous commitments first.');
  }
  nextVersion(marketId: string): bigint {
    return this.#db.transaction(() => {
      const row = this.#db.prepare('SELECT source_version FROM package_maker_bindings WHERE market_id=?')
        .get(marketId) as { source_version: string } | undefined;
      if (row === undefined) throw new Error('Package maker market is not bound.');
      const next = BigInt(row.source_version) + 1n;
      this.#db.prepare('UPDATE package_maker_bindings SET source_version=? WHERE market_id=?').run(String(next), marketId);
      return next;
    }).immediate();
  }
  pending(marketId: string) {
    return (this.#db.prepare("SELECT commitment_id,scope_json FROM package_maker_holds WHERE market_id=? AND state IN ('PENDING','HELD','ALLOCATED')")
      .all(marketId) as { commitment_id: string; scope_json: string }[])
      .map(row => ({ id: row.commitment_id, scope: parseProtocolJson(row.scope_json) as { domain: DomainRef; asset: AssetRef } }));
  }
  prepare(marketId: string, scope: Readonly<{ domain: DomainRef; asset: AssetRef }>, atoms: bigint) {
    const id = randomBytes(32).toString('hex');
    this.#db.prepare("INSERT INTO package_maker_holds VALUES (?, ?, ?, ?, 'PENDING')")
      .run(id, marketId, stringifyProtocolJson(scope), String(atoms));
    return id;
  }
  state(id: string, state: 'HELD' | 'ALLOCATED' | 'RELEASED') {
    if (this.#db.prepare('UPDATE package_maker_holds SET state=? WHERE commitment_id=?').run(state, id).changes !== 1) {
      throw new Error('Package maker commitment disappeared.');
    }
  }
  compactReleased(marketId: string): number {
    return this.#db.transaction(() => {
      const rows = this.#db.prepare("SELECT commitment_id,scope_json,atoms FROM package_maker_holds WHERE market_id=? AND state='RELEASED' ORDER BY rowid DESC LIMIT 1024 OFFSET 256")
        .all(marketId) as { commitment_id: string; scope_json: string; atoms: string }[];
      const groups = new Map<string, { count: bigint; atoms: bigint }>();
      for (const row of rows) {
        const group = groups.get(row.scope_json) ?? { count: 0n, atoms: 0n };
        group.count++; group.atoms += BigInt(row.atoms); groups.set(row.scope_json, group);
      }
      for (const [scope, sum] of groups) {
        const old = this.#db.prepare('SELECT released_count,released_atoms FROM package_maker_release_totals WHERE market_id=? AND scope_json=?')
          .get(marketId, scope) as { released_count: string; released_atoms: string } | undefined;
        this.#db.prepare('INSERT INTO package_maker_release_totals VALUES (?,?,?,?) ON CONFLICT (market_id,scope_json) DO UPDATE SET released_count=excluded.released_count,released_atoms=excluded.released_atoms')
          .run(marketId, scope, String(sum.count + BigInt(old?.released_count ?? '0')), String(sum.atoms + BigInt(old?.released_atoms ?? '0')));
      }
      const remove = this.#db.prepare("DELETE FROM package_maker_holds WHERE commitment_id=? AND state='RELEASED'");
      for (const row of rows) remove.run(row.commitment_id);
      return rows.length;
    }).immediate();
  }
  close() { this.#db.close(); }
}

export class PackageMaker {
  #running = false;
  readonly #sources: readonly string[];
  private readonly input: Readonly<{
    marketId: string;
    solverId: string;
    sourceIds: readonly string[];
    binding: unknown;
    quoteLifetime: bigint;
    journal: PackageMakerJournal;
    gateway: PackageMakerGateway;
    read: (sourceVersion: bigint) => Promise<PackageMakerSnapshot>;
  }>;
  constructor(input: PackageMaker['input']) {
    this.input = input;
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.marketId) || input.quoteLifetime <= 0n
      || input.sourceIds.length < 1 || input.sourceIds.length > PACKAGE_MAKER_LEVELS * 3
      || new Set(input.sourceIds).size !== input.sourceIds.length
      || input.sourceIds.some(id => !/^[A-Za-z0-9._:-]{1,128}$/.test(id) || !id.startsWith(`${input.solverId}:`))) {
      throw new Error('Package maker policy is invalid.');
    }
    this.#sources = Object.freeze([...input.sourceIds]);
    input.journal.bind(input.marketId, { solverId: input.solverId, sources: this.#sources, binding: input.binding });
  }
  async tick(): Promise<Readonly<{ status: 'BUSY' | 'PUBLISHED'; quotes: number }>> {
    if (this.#running) return { status: 'BUSY', quotes: 0 };
    this.#running = true;
    const { journal, gateway, marketId } = this.input;
    try {
      const version = journal.nextVersion(marketId);
      let snapshot: PackageMakerSnapshot;
      try { snapshot = await this.input.read(version); }
      catch (error) {
        for (const sourceId of this.#sources) await gateway.invalidate(sourceId, version);
        throw error;
      }
      const previous = journal.pending(marketId);
      for (const hold of previous) if (await gateway.release(hold.scope, hold.id)) journal.state(hold.id, 'RELEASED');
      if (snapshot.capacity.environment !== 'testnet' || snapshot.capacity.solverId !== this.input.solverId
        || snapshot.capacity.evidenceGrade !== 'ONCHAIN_AVAILABLE' || snapshot.quotes.length < 1
        || snapshot.quotes.length > PACKAGE_MAKER_LEVELS * 2 || snapshot.bookNow <= 0n
        || new Set(snapshot.quotes.map(quote => quote.key)).size !== snapshot.quotes.length) {
        throw new Error('Package maker returned an invalid testnet snapshot.');
      }
      for (const item of snapshot.quotes) {
        if (item.backingAtoms <= 0n || item.quote.executionClassId !== marketId
          || item.quote.legSources.some(source => !this.#sources.includes(source.sourceId) || source.sourceVersion !== version)) {
          throw new Error('Package maker source or backing differs from its policy.');
        }
      }
      await gateway.capacity(snapshot.capacity);
      const scope = { domain: snapshot.capacity.domain, asset: snapshot.capacity.asset };
      const quotes: { quote: ImpliedPackageQuoteInput; expiresAtValue: bigint }[] = [];
      for (const item of snapshot.quotes) {
        const id = journal.prepare(marketId, scope, item.backingAtoms);
        await gateway.reserve(scope, id, item.backingAtoms);
        journal.state(id, 'HELD');
        quotes.push({ quote: { ...item.quote, evidence: 'SOLVER_BACKED_IMPLIED', solverCommitment: id },
          expiresAtValue: snapshot.bookNow + this.input.quoteLifetime });
      }
      await gateway.publish(marketId, quotes, this.#sources.map(sourceId => ({ sourceId, sourceVersion: version })));
      for (const hold of journal.pending(marketId).filter(hold => previous.some(old => old.id === hold.id))) {
        journal.state(hold.id, await gateway.release(hold.scope, hold.id) ? 'RELEASED' : 'ALLOCATED');
      }
      journal.compactReleased(marketId);
      return { status: 'PUBLISHED', quotes: quotes.length };
    } finally { this.#running = false; }
  }
}
