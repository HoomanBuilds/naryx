import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteEvmStrategyAuthorizationJournal } from '../src/evm-strategy-authorization-journal.js';
import type { PreparedStrategyExecutionTransport } from '../src/strategy-execution-transport.js';
import type { Hash32 } from '@naryx/protocol-types';

test('EVM authorization snapshots survive restart and refuse quote rebinding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-evm-authorizations-'));
  const path = join(directory, 'authorizations.db');
  const quoteHash = new Uint8Array(32).fill(1) as Hash32;
  const prepared = { version: 1, quoteHash, domains: [{ kind: 'EVM_MULTI_STRATEGY_ACCOUNT' }] } as unknown as PreparedStrategyExecutionTransport;
  let journal = new SqliteEvmStrategyAuthorizationJournal(path);
  try {
    assert.equal(await journal.get(quoteHash), undefined);
    await journal.record(prepared);
    await journal.record(prepared);
    await assert.rejects(journal.record({ ...prepared, routeHash: new Uint8Array(32).fill(2) }), /another prepared execution/);
    journal.close();
    journal = new SqliteEvmStrategyAuthorizationJournal(path);
    assert.deepEqual(await journal.get(quoteHash), prepared);
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
