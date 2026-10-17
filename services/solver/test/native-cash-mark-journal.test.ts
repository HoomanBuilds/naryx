import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { keccak256 } from 'viem';
import { NATIVE_CASH_MARK_GAS_CAP_WEI, NativeCashMarkJournal } from '../src/native-cash-mark-journal.js';

test('cash mark journal survives restart without releasing pending commitments or resetting the gas budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-cash-mark-'));
  const path = join(dir, 'marks.sqlite');
  const initial = [{ chainId: 84532, reservedWei: NATIVE_CASH_MARK_GAS_CAP_WEI - 100n }];
  let journal = new NativeCashMarkJournal(path, initial);
  const transaction = { id: 'range:1', chainId: 84532, hash: keccak256('0x0102'), raw: '0x0102', costWei: 100n };
  try {
    journal.reserve(transaction); journal.close(); journal = new NativeCashMarkJournal(path, initial);
    assert.deepEqual(journal.pending(84532), transaction);
    assert.equal(journal.reserved(84532), NATIVE_CASH_MARK_GAS_CAP_WEI);
    assert.throws(() => journal.reserve({ ...transaction, id: 'range:2' }), /unresolved/);
    journal.resolve(transaction.hash, false);
    assert.equal(journal.pending(84532), undefined);
    assert.equal(journal.reserved(84532), NATIVE_CASH_MARK_GAS_CAP_WEI);
    assert.throws(() => journal.resolve(transaction.hash, true), /not pending/);
    assert.throws(() => journal.reserve({ ...transaction, id: 'range:2', costWei: 1n }), /exhausted/);
  } finally { journal.close(); rmSync(dir, { recursive: true }); }
});

test('cash mark journal refuses unknown networks, changed raw transaction hashes and reused journal IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-cash-mark-'));
  const path = join(dir, 'marks.sqlite');
  assert.throws(() => new NativeCashMarkJournal(path, [{ chainId: 8453, reservedWei: 0n }]), /invalid/);
  const journal = new NativeCashMarkJournal(path, [{ chainId: 84532, reservedWei: 0n }]);
  const transaction = { id: 'range:1', chainId: 84532, hash: keccak256('0x0102'), raw: '0x0102', costWei: 100n };
  try {
    assert.throws(() => journal.reserve({ ...transaction, raw: '0x0103' }), /invalid/);
    assert.throws(() => journal.reserve({ ...transaction, chainId: 1 }), /unknown/);
    journal.reserve(transaction); journal.resolve(transaction.hash, true);
    assert.throws(() => journal.reserve(transaction));
    assert.equal(journal.reserved(84532), 100n);
  } finally { journal.close(); rmSync(dir, { recursive: true }); }
});
