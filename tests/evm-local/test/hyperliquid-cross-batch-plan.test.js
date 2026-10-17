import assert from 'node:assert/strict';
import test from 'node:test';
import { crossBatchEntryLimit, crossBatchEntryMarkets, requireCrossBatchExitLiquidity } from '../src/run-hyperliquid-cross-batch.mjs';

test('entry refuses a venue whose closing side has no depth near its oracle', () => {
  assert.doesNotThrow(() => requireCrossBatchExitLiquidity([{ px: '105', sz: '0.0002' }], true, '100', 2_000_000n));
  assert.throws(() => requireCrossBatchExitLiquidity([{ px: '105.00000001', sz: '0.0002' }], true, '100', 2_000_000n));
  assert.doesNotThrow(() => requireCrossBatchExitLiquidity([{ px: '95', sz: '0.0002' }], false, '100', 2_000_000n));
  assert.throws(() => requireCrossBatchExitLiquidity([{ px: '94.99', sz: '1' }], false, '100', 2_000_000n));
  assert.throws(() => requireCrossBatchExitLiquidity([], true, '100', 1n));
});

test('opposing funding packages swap venues without reversing the template long and short roles', () => {
  const markets = [{ role: 'funding-long', entrySide: 'BUY', coin: 'BTC', market: 'default' },
    { role: 'funding-short', entrySide: 'SELL', coin: 'sekaw:BTC', market: 'sekaw' }];
  assert.deepEqual(crossBatchEntryMarkets(markets, false), markets);
  assert.deepEqual(crossBatchEntryMarkets(markets, true).map(({ role, entrySide, coin }) => ({ role, entrySide, coin })),
    [{ role: 'funding-long', entrySide: 'BUY', coin: 'sekaw:BTC' },
      { role: 'funding-short', entrySide: 'SELL', coin: 'BTC' }]);
  assert.equal(markets[0].coin, 'BTC');
  assert.throws(() => crossBatchEntryMarkets([], true));
});

test('cross-batch limits use exact rounding and require actual depth inside the price bound', () => {
  assert.equal(crossBatchEntryLimit([{ px: '100', sz: '0.0008' }], 'BUY', 8_000_000n), 10_100_000_000n);
  assert.equal(crossBatchEntryLimit([{ px: '100', sz: '0.0008' }], 'SELL', 8_000_000n), 9_900_000_000n);
  assert.equal(crossBatchEntryLimit([{ px: '0.00000001', sz: '1' }], 'BUY', 1n), 2n);
  assert.throws(() => crossBatchEntryLimit([{ px: '0.00000001', sz: '1' }], 'SELL', 1n));
  assert.throws(() => crossBatchEntryLimit([{ px: '100', sz: '0.0002' }, { px: '102', sz: '1' }], 'BUY', 8_000_000n), /Insufficient/);
  assert.throws(() => crossBatchEntryLimit([], 'BUY', 1n));
  assert.throws(() => crossBatchEntryLimit([{ px: '100', sz: '1' }], 'BUY', 0n));
});
