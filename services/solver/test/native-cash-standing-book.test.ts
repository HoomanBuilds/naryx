import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeCashMarkUpdating } from '@naryx/adapter-evm';
import { createNativeCashStandingBookReader, NativeCashBookReadTimeout } from '../src/native-cash-standing-book.js';

test('standing book coalesces in-flight refresh reads but never caches an executable result', async () => {
  let calls = 0;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const read = createNativeCashStandingBookReader(async () => {
    if (++calls === 1) throw new NativeCashMarkUpdating();
    return { block: calls };
  }, () => waiting);
  const first = read(), second = read();
  assert.equal(first, second);
  release();
  assert.deepEqual(await first, { block: 2 });
  assert.deepEqual(await read(), { block: 3 });
});

test('standing book bounds retries and preserves hard failures without fallback liquidity', async () => {
  let calls = 0, waits = 0;
  let failure: Error = new NativeCashMarkUpdating();
  const read = createNativeCashStandingBookReader(async () => { calls++; throw failure; }, async () => { waits++; });
  await assert.rejects(read(), NativeCashMarkUpdating);
  assert.equal(calls, 5); assert.equal(waits, 4);
  failure = new Error('wrong chain');
  await assert.rejects(read(), error => error === failure);
  assert.equal(calls, 6); assert.equal(waits, 4);
});

test('a stalled read expires for every caller and never retries or returns its late result', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const lateError of [false, true]) {
    let finish!: (value: number) => void, fail!: (error: unknown) => void, calls = 0;
    const stalled = new Promise<number>((resolve, reject) => { finish = resolve; fail = reject; });
    const read = createNativeCashStandingBookReader(() => { calls++; return stalled; });
    const first = read(); assert.equal(first, read());
    const rejected = assert.rejects(first, NativeCashBookReadTimeout);
    context.mock.timers.tick(8_000);
    await rejected;
    if (lateError) fail(new NativeCashMarkUpdating()); else finish(1);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(calls, 1);
  }
});
