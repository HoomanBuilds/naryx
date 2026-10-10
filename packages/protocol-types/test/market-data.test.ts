import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { aggregateCandles, executablePackageIndex, settlementPremiumSurface } from '../src/index.js';

const MIN = 60_000;

describe('candle aggregation', () => {
  const trades = [
    { timeMs: 5 * MIN + 1_000, priceTicks: 101n, quantity: 10n },
    { timeMs: 5 * MIN + 30_000, priceTicks: 99n, quantity: 5n },
    { timeMs: 5 * MIN + 1_000, priceTicks: 100n, quantity: 1n },
    { timeMs: 7 * MIN, priceTicks: 104n, quantity: 2n },
  ];

  test('buckets are UTC aligned, ordered by time with input order breaking ties, and gaps stay empty', () => {
    const series = aggregateCandles(trades, '1m', 'OBSERVED');
    assert.deepEqual(series.candles, [
      { openTimeMs: 5 * MIN, open: 101n, high: 101n, low: 99n, close: 99n, volume: 16n, tradeCount: 3 },
      { openTimeMs: 7 * MIN, open: 104n, high: 104n, low: 104n, close: 104n, volume: 2n, tradeCount: 1 },
    ]);
    const five = aggregateCandles(trades, '5m', 'OBSERVED');
    assert.equal(five.candles.length, 1);
    assert.deepEqual([five.candles[0]?.open, five.candles[0]?.close, five.candles[0]?.high], [101n, 104n, 104n]);
  });

  test('windows are half-open and labels cannot claim executability', () => {
    assert.equal(aggregateCandles(trades, '1m', 'OBSERVED', { fromMs: 6 * MIN, toMs: 7 * MIN }).candles.length, 0);
    assert.equal(aggregateCandles(trades, '1m', 'FIXTURE', { fromMs: 7 * MIN, toMs: 8 * MIN }).candles.length, 1);
    assert.throws(() => aggregateCandles(trades, '1m', 'EXECUTABLE'), /OBSERVED, MODEL_DERIVED, or FIXTURE/);
    assert.throws(() => aggregateCandles(trades, '2m' as never, 'OBSERVED'), /unknown candle interval/);
    assert.throws(() => aggregateCandles([{ timeMs: 1, priceTicks: 1n, quantity: 0n }], '1m', 'OBSERVED'), /quantity is zero/);
  });
});

describe('executable package index', () => {
  const bids = [
    { priceTicks: 98n, directQuantity: 10n, impliedQuantity: 0n },
    { priceTicks: 99n, directQuantity: 5n, impliedQuantity: 20n },
  ];
  const asks = [
    { priceTicks: 102n, directQuantity: 0n, impliedQuantity: 30n },
    { priceTicks: 103n, directQuantity: 10n, impliedQuantity: 0n },
  ];

  test('executable prices use direct liquidity only and round against the taker', () => {
    const index = executablePackageIndex(bids, asks, [10n, 40n]);
    assert.equal(index.bestBidTicks, 99n);
    assert.equal(index.bestAskTicks, 103n);
    assert.equal(index.spreadTicks, 4n);
    assert.deepEqual(index.executable.bids[0], { size: 10n, averagePriceTicks: 98n, fillableQuantity: 10n, label: 'EXECUTABLE' });
    assert.deepEqual(index.executable.asks[0], { size: 10n, averagePriceTicks: 103n, fillableQuantity: 10n, label: 'EXECUTABLE' });
    assert.deepEqual(index.executable.asks[1], { size: 40n, fillableQuantity: 10n, label: 'EXECUTABLE' });
  });

  test('implied liquidity is reported separately as indicative', () => {
    const index = executablePackageIndex(bids, asks, [10n, 40n]);
    assert.deepEqual(index.withImplied.asks[0], { size: 10n, averagePriceTicks: 102n, fillableQuantity: 10n, label: 'INDICATIVE' });
    // 30 at 102 plus 10 at 103 = 4090 / 40 = 102.25, rounded up against the buyer.
    assert.deepEqual(index.withImplied.asks[1], { size: 40n, averagePriceTicks: 103n, fillableQuantity: 40n, label: 'INDICATIVE' });
    // Only 35 units bid in total: a 40-unit sell cannot fill, so no average price is invented.
    assert.deepEqual(index.withImplied.bids[1], { size: 40n, fillableQuantity: 35n, label: 'INDICATIVE' });
    // 25 at 99 is not enough for 30; with 5 more at 98: 2475 + 490 = 2965 / 30 = 98.83, rounded down.
    assert.equal(executablePackageIndex(bids, asks, [30n]).withImplied.bids[0]?.averagePriceTicks, 98n);
    assert.throws(() => executablePackageIndex(bids, asks, [0n]), /size is zero/);
  });
});

describe('settlement premium surface', () => {
  const quote = (size: bigint, averagePriceTicks?: bigint) => ({
    size,
    fillableQuantity: averagePriceTicks === undefined ? 0n : size,
    label: 'EXECUTABLE' as const,
    ...(averagePriceTicks === undefined ? {} : { averagePriceTicks }),
  });

  test('measures each execution class against the best direct price at every size', () => {
    const surface = settlementPremiumSurface([
      { executionClassId: 'atomic', bids: [quote(10n, 99n), quote(20n, 97n)], asks: [quote(10n, 101n), quote(20n)] },
      { executionClassId: 'async', bids: [quote(10n, 98n), quote(20n)], asks: [quote(10n, 103n), quote(20n, 105n)] },
    ], [10n, 20n]);
    assert.deepEqual(surface.references, [
      { size: 10n, bestBidTicks: 99n, bestAskTicks: 101n },
      { size: 20n, bestBidTicks: 97n, bestAskTicks: 105n },
    ]);
    assert.deepEqual(surface.points[0]?.premiums, [
      { size: 10n, bidDiscountTicks: 0n, askPremiumTicks: 0n },
      { size: 20n, bidDiscountTicks: 0n },
    ]);
    assert.deepEqual(surface.points[1]?.premiums, [
      { size: 10n, bidDiscountTicks: 1n, askPremiumTicks: 2n },
      { size: 20n, askPremiumTicks: 0n },
    ]);
  });

  test('rejects indicative or partial prices', () => {
    assert.throws(() => settlementPremiumSurface([
      { executionClassId: 'bad', bids: [{ ...quote(10n, 99n), label: 'INDICATIVE' }], asks: [quote(10n, 101n)] },
    ], [10n]), /direct executable depth/);
    assert.throws(() => settlementPremiumSurface([
      { executionClassId: 'bad', bids: [{ ...quote(10n, 99n), fillableQuantity: 5n }], asks: [quote(10n, 101n)] },
    ], [10n]), /partial depth/);
  });
});
