import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, buildExposureGraph, domainRef, normalizedPosition, positionNotional } from '@naryx/protocol-types';
import {
  decimalToAtoms,
  normalizeHyperliquidPerpPositions,
  normalizeHyperliquidSpotBalances,
  type HyperliquidSnapshotContext,
} from '../src/index.js';

const domain = domainRef('hypercore:testnet', 1, '11'.repeat(32));
const btc = assetRef('btc', '22'.repeat(32), 8);
const usdc = assetRef('usdc', '33'.repeat(32), 6);
const context: HyperliquidSnapshotContext = {
  domain,
  owner: 'strategy-account-1',
  quoteAsset: usdc,
  snapshotPrefix: 'hl-2026-09-30',
  bindings: [
    {
      coin: 'BTC',
      venueId: 'hypercore',
      marketId: 'btc-perp',
      underlyingId: 'btc',
      baseAsset: btc,
      riskDomainId: 'hypercore-cross',
      dependencyIds: ['hypercore-l1'],
      closeRoutes: [{ routeId: 'ioc-close', executableQuantityAtoms: 50_000_000n, expectedCostQuoteAtoms: 12_000n, settlementDelayMs: 1_000n, authorityHeld: true, requiredDependencyIds: ['hypercore-l1'] }],
    },
  ],
};

test('decimals convert exactly and refuse digits the atoms cannot hold', () => {
  assert.equal(decimalToAtoms('-0.5', 8, 'x'), -50_000_000n);
  assert.equal(decimalToAtoms('61234.50', 6, 'x'), 61_234_500_000n);
  assert.equal(decimalToAtoms('1.1234567800', 8, 'x'), 112_345_678n);
  assert.throws(() => decimalToAtoms('0.1234567', 6, 'x'), /more than 6 fractional digits/);
  assert.throws(() => decimalToAtoms('1e5', 6, 'x'), /decimal string/);
});

test('a HyperCore short perp normalizes to an exact mark, liquidation price, and margin, and unknowns stay unknown', () => {
  const snapshot = normalizeHyperliquidPerpPositions(
    {
      time: 1_790_000_000_000,
      assetPositions: [
        { position: { coin: 'BTC', szi: '-0.5', positionValue: '30617.25', liquidationPx: '75000.0', marginUsed: '3061.725' } },
        { position: { coin: 'DOGE', szi: '100', positionValue: '12.5', liquidationPx: null, marginUsed: '1.25' } },
        { position: { coin: 'BTC-FLAT', szi: '0', positionValue: '0', liquidationPx: null, marginUsed: '0' } },
      ],
    },
    context,
  );
  assert.deepEqual(snapshot.unmappedCoins, ['BTC-FLAT', 'DOGE']);
  assert.equal(snapshot.positions.length, 1);
  const position = normalizedPosition(snapshot.positions[0]!);
  assert.equal(position.quantityBaseAtoms, -50_000_000n);
  // 30617.25 USDC over 0.5 BTC is 61234.50 per BTC.
  assert.equal(positionNotional(position), -30_617_250_000n);
  assert.equal(position.liquidationPrice?.quoteAtoms, 750n);
  assert.equal(position.liquidationPrice?.baseAtoms, 1n);
  assert.equal(position.collateralQuoteAtoms, 3_061_725_000n);
  assert.deepEqual(position.unknownFields, ['maintenanceRequirementQuoteAtoms']);
  assert.deepEqual(buildExposureGraph(snapshot.positions, usdc).byRiskDomain.map((line) => line.key), ['hypercore-cross']);
});

test('spot balances are marked only at a supplied mid, and a coin bound twice is refused', () => {
  const snapshot = normalizeHyperliquidSpotBalances(
    { balances: [{ coin: 'BTC', total: '0.5' }, { coin: 'USDC', total: '1000' }] },
    { BTC: '61000' },
    1_790_000_000_000,
    context,
  );
  assert.deepEqual(snapshot.unmappedCoins, ['USDC']);
  assert.equal(positionNotional(normalizedPosition(snapshot.positions[0]!)), 30_500_000_000n);
  assert.throws(() => normalizeHyperliquidSpotBalances({ balances: [] }, {}, 1, { ...context, bindings: [...context.bindings, ...context.bindings] }), /bound twice/);
});
