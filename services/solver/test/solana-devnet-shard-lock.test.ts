import assert from 'node:assert/strict';
import test from 'node:test';
import { withShardWriteLock } from '../src/solana-devnet-firm-quote.js';

test('package book writes for one shard run one at a time, and a failed write never blocks the next', async () => {
  const events: string[] = [];
  const write = (name: string, fail = false) => withShardWriteLock('shard-1', async () => {
    events.push(`start ${name}`);
    await new Promise((done) => setTimeout(done, 5));
    events.push(`end ${name}`);
    if (fail) throw new Error(`${name} failed`);
    return name;
  });
  const results = await Promise.allSettled([write('a'), write('b', true), write('c')]);
  assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  // Another shard is not held behind this one.
  assert.equal(await withShardWriteLock('shard-2', async () => 'free'), 'free');
});
