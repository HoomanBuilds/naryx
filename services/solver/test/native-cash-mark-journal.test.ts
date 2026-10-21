import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { keccak256 } from 'viem';
import { NATIVE_CASH_MARK_GAS_CAP_WEI, NativeCashMarkJournal, nativeCashMarkGasCapWei, nativeCashMarkTransaction } from '../src/native-cash-mark-journal.js';

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

test('a reverted mark can be retried with a new transaction without releasing either gas reservation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-cash-mark-retry-'));
  const path = join(dir, 'marks.sqlite');
  const initial = [{ chainId: 84532, reservedWei: NATIVE_CASH_MARK_GAS_CAP_WEI - 70n }];
  let journal = new NativeCashMarkJournal(path, initial);
  const failed = nativeCashMarkTransaction(84532, '0x0102', 30n);
  const retry = nativeCashMarkTransaction(84532, '0x0103', 40n);
  try {
    journal.reserve(failed);
    journal.resolve(failed.hash, false);
    journal.close();
    journal = new NativeCashMarkJournal(path, initial);
    journal.reserve(retry);
    assert.deepEqual(journal.pending(84532), retry);
    assert.equal(journal.reserved(84532), NATIVE_CASH_MARK_GAS_CAP_WEI);
    journal.resolve(retry.hash, true);
    assert.throws(() => journal.reserve(nativeCashMarkTransaction(84532, '0x0104', 1n)), /exhausted/);
    assert.equal(journal.reserved(84532), NATIVE_CASH_MARK_GAS_CAP_WEI);
  } finally { journal.close(); rmSync(dir, { recursive: true }); }
});

test('mark gas overrides are exact, bounded and testnet-only', () => {
  assert.equal(nativeCashMarkGasCapWei(84532), NATIVE_CASH_MARK_GAS_CAP_WEI);
  assert.equal(nativeCashMarkGasCapWei(421614, '100000000000000000'), 100000000000000000n);
  for (const value of ['', '0', '-1', '1.5', ' 1', '01', '100000000000000001']) {
    assert.throws(() => nativeCashMarkGasCapWei(421614, value), /cap/);
  }
  assert.throws(() => nativeCashMarkGasCapWei(42161, '100'), /invalid/);
});

test('approved per-chain increases preserve previous spending and pending work across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-cash-mark-budget-'));
  const path = join(dir, 'marks.sqlite');
  const baseline = [{ chainId: 84532, reservedWei: 0n }, { chainId: 421614, reservedWei: NATIVE_CASH_MARK_GAS_CAP_WEI }];
  const raised = baseline.map(entry => entry.chainId === 421614
    ? { ...entry, maximumGasBudgetWei: NATIVE_CASH_MARK_GAS_CAP_WEI + 100n } : entry);
  let journal = new NativeCashMarkJournal(path, baseline);
  const tx = nativeCashMarkTransaction(421614, '0x0102', 100n);
  try {
    assert.throws(() => journal.reserve(tx), /exhausted/);
    journal.close(); journal = new NativeCashMarkJournal(path, raised);
    assert.equal(journal.cap(84532), NATIVE_CASH_MARK_GAS_CAP_WEI);
    assert.equal(journal.reserved(421614), NATIVE_CASH_MARK_GAS_CAP_WEI);
    journal.reserve(tx);
    journal.close(); journal = new NativeCashMarkJournal(path, raised);
    assert.deepEqual(journal.pending(421614), tx);
    journal.resolve(tx.hash, false);
    assert.throws(() => journal.reserve(nativeCashMarkTransaction(421614, '0x0103', 1n)), /exhausted/);
    assert.equal(journal.reserved(421614), NATIVE_CASH_MARK_GAS_CAP_WEI + 100n);
    assert.throws(() => new NativeCashMarkJournal(path, baseline), /existing commitments/);
  } finally { journal.close(); rmSync(dir, { recursive: true }); }
});
