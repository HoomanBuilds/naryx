import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, protocolId, assetAmount, type PackageGraph, type StrategyPackageQuote } from '@naryx/protocol-types';
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

test('treasury inventory is marked once and collateral transfers are not priced as purchases', () => {
  const value = input('BID', 2000_000_000n, 1999_000_000n, 1_000_000n);
  const roles = ['inventory-position', 'treasury-hedge'].map(value => protocolId(value));
  const graph = { ...value.graph, templateId: protocolId('treasury-inventory-hedge-v1'), legs: value.graph.legs.map((l, i) => ({ ...l,
    legId: roles[i]!, side: i === 0 ? 'NONE' as const : 'SELL' as const })) };
  const quote = { ...value.quote, legEconomics: value.quote.legEconomics.map((l, i) => {
    const { executionPrice, ...rest } = l;
    return { ...rest, legId: roles[i]!, grossNotional: assetAmount(value.quote.quoteAsset, 10_000_000n),
      ...(i === 0 ? {} : { executionPrice: executionPrice! }) };
  }) };
  requireMatchedExecutionPrice({ ...value, graph, quote });
  assert.throws(() => requireMatchedExecutionPrice({ ...value, graph, quote, fills: [{ quantity: value.quantity, priceTicks: 999_999n }] }), /worse/);
  const converted = { ...graph, templateId: protocolId('collateral-conversion-hedge-v1'), legs: [
    { ...graph.legs[0]!, legId: protocolId('collateral-swap'), side: 'BUY' as const },
    { ...graph.legs[0]!, legId: protocolId('collateral-transfer') },
    { ...graph.legs[1]!, legId: protocolId('conversion-hedge') },
  ] };
  const convertedQuote = { ...quote, legEconomics: [
    { ...value.quote.legEconomics[0]!, legId: protocolId('collateral-swap') },
    { ...quote.legEconomics[0]!, legId: protocolId('collateral-transfer') },
    { ...quote.legEconomics[1]!, legId: protocolId('conversion-hedge') },
  ] };
  requireMatchedExecutionPrice({ ...value, graph: converted, quote: convertedQuote });
  assert.throws(() => requireMatchedExecutionPrice({ ...value, graph: converted, quote: { ...convertedQuote,
    legEconomics: convertedQuote.legEconomics.map((l, i) => i === 1 ? { ...l, executionPrice: value.quote.legEconomics[0]!.executionPrice! } : l) } }), /transfer/);
});
