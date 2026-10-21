import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { parseProtocolJson, stringifyProtocolJson, type AssetRef, type DomainRef,
  type ImpliedPackageQuoteInput, type SolverCapacityRecordInput } from '@naryx/protocol-types';
import { HttpMakerShardGateway } from './maker-control.js';

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
  publish(marketId: string, quotes: readonly Readonly<{ quote: ImpliedPackageQuoteInput; expiresAtValue: bigint }>[]): Promise<void>;
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
  async publish(marketId: string, quotes: readonly Readonly<{ quote: ImpliedPackageQuoteInput; expiresAtValue: bigint }>[]) {
    const response = await this.request('POST', '/v1/solver/quotes/batch', { packageMarketId: marketId, quotes });
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
      || input.sourceIds.length < 1 || input.sourceIds.length > 32
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
      for (const sourceId of this.#sources) await gateway.invalidate(sourceId, version);
      for (const hold of journal.pending(marketId)) {
        journal.state(hold.id, await gateway.release(hold.scope, hold.id) ? 'RELEASED' : 'ALLOCATED');
      }
      if (snapshot.capacity.environment !== 'testnet' || snapshot.capacity.solverId !== this.input.solverId
        || snapshot.capacity.evidenceGrade !== 'ONCHAIN_AVAILABLE' || snapshot.quotes.length < 1
        || snapshot.quotes.length > 16 || snapshot.bookNow <= 0n
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
      await gateway.publish(marketId, quotes);
      return { status: 'PUBLISHED', quotes: quotes.length };
    } finally { this.#running = false; }
  }
}
