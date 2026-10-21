import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, type PackageGraph, type StrategyPackageQuote } from '@naryx/protocol-types';
import { requireMatchedExecutionPrice } from '../src/package-execution-price.js';

function input(side: 'BID' | 'ASK', near: bigint, far: bigint, matched: bigint) {
  const base = assetRef('base', '11'.repeat(32), 18);
  const quoteAsset = assetRef('usdc', '22'.repeat(32), 6);
  const quantity = 5n * 10n ** 15n;
  const roles = ['near-future', 'far-future'];
  const graph = { templateId: 'calendar-spread-v1', legs: roles.map((legId, i) => ({ legId,
    side: (i === 0) === (side === 'BID') ? 'BUY' : 'SELL', quantityAsset: base, quantityAtoms: quantity })) } as unknown as PackageGraph;
  const quote = { quoteAsset, legEconomics: roles.map((legId, i) => ({ legId, quantity: { asset: base, atoms: quantity },
    executionPrice: { baseAsset: base, quoteAsset, baseAtoms: 10n ** 18n, quoteAtoms: i === 0 ? near : far } })) } as unknown as StrategyPackageQuote;
  return { side, quantity, graph, quote, fills: [{ priceTicks: matched, quantity }] };
}

test('matched basket price bounds exact signed execution prices on both sides', () => {
  requireMatchedExecutionPrice(input('BID', 3_000_000_001n, 3_001_000_000n, -999_999n));
  assert.throws(() => requireMatchedExecutionPrice(input('BID', 3_000_000_001n, 3_001_000_000n, -1_000_000n)), /worse/);
  requireMatchedExecutionPrice(input('ASK', 3_000_000_001n, 3_001_000_000n, -1_000_000n));
  assert.throws(() => requireMatchedExecutionPrice(input('ASK', 3_000_000_001n, 3_001_000_000n, -999_998n)), /worse/);
});

test('matched basket rejects direction, quantity and zero denominator mismatches', () => {
  const value = input('BID', 100n, 101n, -1n);
  assert.throws(() => requireMatchedExecutionPrice({ ...value, side: 'ASK' }), /direction/);
  assert.throws(() => requireMatchedExecutionPrice({ ...value, quantity: value.quantity + 1n }), /quantities/);
  const quote = { ...value.quote, legEconomics: value.quote.legEconomics.map(leg => ({ ...leg,
    executionPrice: { ...leg.executionPrice!, baseAtoms: 0n } })) };
  assert.throws(() => requireMatchedExecutionPrice({ ...value, quote }), /direction/);
});
