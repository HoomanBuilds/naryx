import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Hex } from 'viem';
import { SqliteEvmStrategyPackageIdStore } from '../src/index.js';

const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;

test('durably resolves every strategy state to one stable EVM package', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-evm-package-'));
  const path = join(directory, 'solver.sqlite');
  try {
    const first = new SqliteEvmStrategyPackageIdStore(path);
    await first.rememberPackageId(hash('1'), hash('a'));
    await first.rememberPackageId(hash('1'), hash('a'));
    first.close();

    const reopened = new SqliteEvmStrategyPackageIdStore(path);
    assert.equal(await reopened.resolvePackageId(hash('1')), hash('a'));
    await assert.rejects(() => reopened.rememberPackageId(hash('1'), hash('b')), /another package/);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
