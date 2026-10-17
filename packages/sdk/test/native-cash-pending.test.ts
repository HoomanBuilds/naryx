import assert from 'node:assert/strict';
import test from 'node:test';
import { readNativeCashPending, updateNativeCashPending, NATIVE_CASH_PENDING_LIMIT } from '../src/index.js';

const first = { transactionHash: `0x${'aa'.repeat(32)}` as const, requestId: 'entry', action: 'Cash trade', phase: 'SUBMITTED' as const };
test('cash inclusion unlocks sequencing without discarding older receipts awaiting finality', () => {
  let queue = updateNativeCashPending([], first);
  queue = updateNativeCashPending(queue, { ...first, phase: 'INCLUDED' });
  queue = updateNativeCashPending(queue, { ...first, transactionHash: `0x${'bb'.repeat(32)}`, requestId: 'exit' });
  assert.equal(queue.length, 2);
  assert.equal(queue[0]?.phase, 'INCLUDED');
  assert.equal(queue[1]?.phase, 'SUBMITTED');
  assert.deepEqual(readNativeCashPending(JSON.stringify(queue)), queue);
  assert.equal(readNativeCashPending(JSON.stringify({ transactionHash: first.transactionHash, requestId: 'entry', action: 'Cash trade' }))[0]?.phase, 'SUBMITTED');
  assert.throws(() => updateNativeCashPending(queue, { ...first, requestId: 'another-order' }), /identity changed/);
});
test('malformed or full journals fail closed instead of silently losing transactions', () => {
  assert.throws(() => readNativeCashPending('garbage'));
  assert.throws(() => readNativeCashPending(JSON.stringify([first, first])), /duplicates/);
  assert.throws(() => readNativeCashPending(JSON.stringify([{ ...first, phase: 'SETTLED' }])), /invalid/);
  assert.throws(() => readNativeCashPending(JSON.stringify([{ ...first, requestId: 42 }])), /invalid/);
  const full = Array.from({ length: NATIVE_CASH_PENDING_LIMIT }, (_, i) => ({ ...first, transactionHash: `0x${i.toString(16).padStart(64, '0')}` as const }));
  assert.throws(() => updateNativeCashPending(full, first), /Reconcile/);
  assert.equal(updateNativeCashPending(full, { ...full[0]!, phase: 'INCLUDED' }).length, NATIVE_CASH_PENDING_LIMIT);
});
