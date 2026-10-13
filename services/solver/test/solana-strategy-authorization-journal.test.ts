import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Hash32 } from '@naryx/protocol-types';
import { SqliteSolanaStrategyAuthorizationJournal } from '../src/solana-strategy-authorization-journal.js';
import type { PreparedStrategyExecutionTransport } from '../src/strategy-execution-transport.js';

test('retains distinct authorized snapshots across process restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-solana-authorizations-'));
  const path = join(directory, 'quotes.db');
  const quoteHash = new Uint8Array(32).fill(1) as Hash32;
  const first = { version: 1, quoteHash, routeHash: new Uint8Array(32).fill(2) } as unknown as PreparedStrategyExecutionTransport;
  const second = { version: 1, quoteHash, routeHash: new Uint8Array(32).fill(3) } as unknown as PreparedStrategyExecutionTransport;
  try {
    const writer = new SqliteSolanaStrategyAuthorizationJournal(path);
    await writer.record(first);
    await writer.record(first);
    await writer.record(second);
    writer.close();
    const reader = new SqliteSolanaStrategyAuthorizationJournal(path);
    const candidates = await reader.candidates(quoteHash);
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((candidate) => Buffer.from(candidate.routeHash).toString('hex')).sort(),
      [Buffer.from(first.routeHash).toString('hex'), Buffer.from(second.routeHash).toString('hex')]);
    assert.equal((await reader.candidates(new Uint8Array(32).fill(4) as Hash32)).length, 0);
    reader.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
