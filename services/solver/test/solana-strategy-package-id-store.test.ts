import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteSolanaStrategyPackageIdStore } from '../src/index.js';

test('durably resolves one Solana strategy state to its package', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'naryx-solana-state-')), 'states.db');
  const stateHash = '11'.repeat(32);
  const packageId = '22'.repeat(32);
  const first = new SqliteSolanaStrategyPackageIdStore(path);
  await first.rememberPackageId(stateHash, packageId);
  await first.rememberPackageId(stateHash, packageId);
  first.close();

  const reopened = new SqliteSolanaStrategyPackageIdStore(path);
  assert.equal(await reopened.resolvePackageId(stateHash), packageId);
  await assert.rejects(reopened.rememberPackageId(stateHash, '33'.repeat(32)), /already bound/);
  reopened.close();
});
