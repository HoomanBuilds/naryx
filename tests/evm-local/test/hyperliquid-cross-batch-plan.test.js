import assert from 'node:assert/strict';
import test from 'node:test';
import { crossBatchEntryLimit } from '../src/run-hyperliquid-cross-batch.mjs';

test('cross-batch limits use exact rounding and require actual depth inside the price bound', () => {
  assert.equal(crossBatchEntryLimit([{ px: '100', sz: '0.0008' }], 'BUY', 8_000_000n), 10_100_000_000n);
  assert.equal(crossBatchEntryLimit([{ px: '100', sz: '0.0008' }], 'SELL', 8_000_000n), 9_900_000_000n);
  assert.equal(crossBatchEntryLimit([{ px: '0.00000001', sz: '1' }], 'BUY', 1n), 2n);
  assert.throws(() => crossBatchEntryLimit([{ px: '0.00000001', sz: '1' }], 'SELL', 1n));
  assert.throws(() => crossBatchEntryLimit([{ px: '100', sz: '0.0002' }, { px: '102', sz: '1' }], 'BUY', 8_000_000n), /Insufficient/);
  assert.throws(() => crossBatchEntryLimit([], 'BUY', 1n));
  assert.throws(() => crossBatchEntryLimit([{ px: '100', sz: '1' }], 'BUY', 0n));
});
