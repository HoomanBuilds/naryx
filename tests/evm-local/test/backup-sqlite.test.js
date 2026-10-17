import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, statSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const Database = createRequire(new URL('../../../services/api/package.json', import.meta.url))('better-sqlite3');
const script = new URL('../../../deployments/aws/backup-sqlite.mjs', import.meta.url);

test('online backup captures WAL-backed databases regardless of suffix without following links', () => {
  const root = mkdtempSync(join(tmpdir(), 'naryx-backup-test-'));
  const source = join(root, 'source'), target = join(root, 'backup');
  mkdirSync(source);
  const handles = [];
  try {
    for (const name of ['store.db', 'quotes.sqlite', 'quotes.sqlite.registrations']) {
      const db = new Database(join(source, name)); handles.push(db);
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE records (value INTEGER); INSERT INTO records VALUES (17)');
    }
    writeFileSync(join(source, 'journal.json'), '{"pending":[]}');
    writeFileSync(join(source, 'ignored.txt'), 'not a database');
    symlinkSync(source, join(source, 'loop'));
    symlinkSync(join(source, 'journal.json'), join(source, 'alias.json'));
    execFileSync(process.execPath, [script.pathname, source, target]);
    for (const name of ['ignored.txt', 'alias.json', 'loop', 'quotes.sqlite-wal']) assert.equal(existsSync(join(target, name)), false);
    for (const name of ['store.db', 'quotes.sqlite', 'quotes.sqlite.registrations']) {
      const copy = new Database(join(target, name), { readonly: true, fileMustExist: true });
      try { assert.deepEqual(copy.prepare('SELECT value FROM records').all(), [{ value: 17 }]); }
      finally { copy.close(); }
      assert.equal(statSync(join(target, name)).mode & 0o077, 0);
    }
    assert.ok(existsSync(join(target, 'journal.json')));
  } finally { for (const db of handles) db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('online backup rejects a destination inside its own input tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'naryx-backup-boundary-'));
  try {
    const result = spawnSync(process.execPath, [script.pathname, root, join(root, 'nested')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the data directory/);
    assert.equal(existsSync(join(root, 'nested')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
