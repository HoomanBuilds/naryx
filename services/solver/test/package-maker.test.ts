import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assetRef, domainRef } from '@naryx/protocol-types';
import { PackageMaker, PackageMakerJournal, type PackageMakerGateway, type PackageMakerSnapshot } from '../src/package-maker.js';

const domain = domainRef('eip155:84532', 1, '11'.repeat(32));
const asset = assetRef('test-usdc', '22'.repeat(32), 6);
const snapshot = (version: bigint): PackageMakerSnapshot => ({
  bookNow: 100n,
  capacity: { version: 1, environment: 'testnet', solverId: 'maker', domain, asset,
    availableAtoms: 1_000n, maximumConcurrentRecoveryAtoms: 0n, evidenceGrade: 'ONCHAIN_AVAILABLE',
    evidenceCommitment: '33'.repeat(32), observedAtValue: 100_000n, expiresAtValue: 200_000n },
  quotes: [{ key: 'ask', backingAtoms: 10n, quote: { executionClassId: 'calendar', side: 'ASK',
    legRatios: [{ numerator: 1n, denominator: 1n }, { numerator: -1n, denominator: 1n }],
    legSources: [{ sourceId: 'maker:near', sourceVersion: version, side: 'ASK', priceTicks: 102n, quantity: 1n },
      { sourceId: 'maker:far', sourceVersion: version, side: 'BID', priceTicks: 100n, quantity: 1n }] } }],
});

test('maker invalidates before refresh and reconciles consumed backing after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-package-maker-'));
  const events: string[] = [];
  const held = new Set<string>();
  let settled = false;
  let unavailable = false;
  let crash = true;
  const gateway: PackageMakerGateway = {
    invalidate: async (source, version) => { events.push(`${source}:${version}`); },
    capacity: async () => { events.push('capacity'); },
    reserve: async (_scope, id) => { held.add(id); events.push('reserve'); },
    release: async (_scope, id) => { events.push('release'); if (!settled) return false; held.delete(id); return true; },
    publish: async () => { events.push('publish'); if (crash) { crash = false; throw new Error('lost response'); } },
  };
  let journal = new PackageMakerJournal(join(directory, 'maker.db'));
  const maker = () => new PackageMaker({ marketId: 'calendar', solverId: 'maker',
    sourceIds: ['maker:near', 'maker:far'], binding: { domain, asset }, quoteLifetime: 30n, journal, gateway,
    read: async version => { if (unavailable) throw new Error('stale source'); return snapshot(version); } });
  try {
    await assert.rejects(maker().tick(), /lost response/);
    assert.equal(held.size, 1);
    journal.close();
    journal = new PackageMakerJournal(join(directory, 'maker.db'));
    await maker().tick();
    assert.equal(held.size, 2);
    assert.deepEqual(events.slice(5, 9), ['maker:near:2', 'maker:far:2', 'release', 'capacity']);
    settled = true;
    unavailable = true;
    await assert.rejects(maker().tick(), /stale source/);
    assert.equal(events.at(-1), 'maker:far:3');
    unavailable = false;
    await maker().tick();
    assert.equal(held.size, 1);
    settled = true;
    gateway.publish = async () => { throw new Error('publication failed'); };
    await assert.rejects(maker().tick(), /publication failed/);
    assert.equal(held.size, 1);
    for (const hold of journal.pending('calendar')) { await gateway.release(hold.scope, hold.id); journal.state(hold.id, 'RELEASED'); }
    assert.equal(held.size, 0);
    assert.equal(journal.pending('calendar').length, 0);
    assert.throws(() => new PackageMaker({ marketId: 'calendar', solverId: 'maker', sourceIds: ['maker:near'],
      binding: { changed: true }, quoteLifetime: 30n, journal, gateway, read: async version => snapshot(version) }), /binding changed/);
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('maker refuses non-testnet capacity before publishing or reserving', async () => {
  const journal = new PackageMakerJournal(':memory:');
  let writes = 0;
  const gateway: PackageMakerGateway = { invalidate: async () => {}, release: async () => true,
    capacity: async () => { writes++; }, reserve: async () => { writes++; }, publish: async () => { writes++; } };
  try {
    const maker = new PackageMaker({ marketId: 'calendar', solverId: 'maker', sourceIds: ['maker:near', 'maker:far'],
      binding: {}, quoteLifetime: 30n, journal, gateway, read: async version => {
        const value = snapshot(version);
        return { ...value, capacity: { ...value.capacity, environment: 'mainnet' } };
      } });
    await assert.rejects(maker.tick(), /invalid testnet snapshot/);
    assert.equal(writes, 0);
  } finally { journal.close(); }
});
