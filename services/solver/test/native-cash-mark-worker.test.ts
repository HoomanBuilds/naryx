import assert from 'node:assert/strict';
import test from 'node:test';
import { runNativeCashMarkWorker } from '../src/native-cash-mark-worker.js';

test('mark domains advance independently while each domain keeps a single in-flight tick', async () => {
  const controller = new AbortController();
  const held = Promise.withResolvers<void>();
  let slowTicks = 0;
  let fastTicks = 0;
  let active = 0;
  const slow = runNativeCashMarkWorker({ signal: controller.signal, intervalMs: 1,
    tick: async () => { slowTicks++; await held.promise; }, failed: error => { throw error; } });
  const fast = runNativeCashMarkWorker({ signal: controller.signal, intervalMs: 1,
    tick: async () => {
      assert.equal(++active, 1);
      await Promise.resolve();
      active--;
      if (++fastTicks === 3) { controller.abort(); held.resolve(); }
    }, failed: error => { throw error; } });
  await Promise.all([slow, fast]);
  assert.equal(slowTicks, 1);
  assert.equal(fastTicks, 3);
});

test('mark worker reports failures, retries serially and never starts after shutdown', async () => {
  const controller = new AbortController();
  const failure = new Error('RPC unavailable');
  const errors: unknown[] = [];
  let ticks = 0;
  await runNativeCashMarkWorker({ signal: controller.signal, intervalMs: 1,
    tick: async () => { if (++ticks === 1) throw failure; controller.abort(); },
    failed: error => errors.push(error) });
  assert.deepEqual(errors, [failure]);
  assert.equal(ticks, 2);
  await runNativeCashMarkWorker({ signal: controller.signal, tick: async () => { ticks++; }, failed: error => { throw error; } });
  assert.equal(ticks, 2);
  await assert.rejects(runNativeCashMarkWorker({ signal: controller.signal, intervalMs: 0,
    tick: async () => {}, failed: error => { throw error; } }), /interval/);
});
