import assert from 'node:assert/strict';
import test from 'node:test';
import { callOptionAnalytics, callSpreadAnalytics } from '../src/option-analytics.js';

test('derives executable call spread volatility and normalized Greeks', () => {
  const long = callOptionAnalytics({
    spot: 2_000,
    strike: 2_000,
    premium: 200,
    secondsToMaturity: 1_000,
  });
  const spread = callSpreadAnalytics({
    spot: 2_000,
    longStrike: 2_000,
    shortStrike: 2_500,
    longPremium: 200,
    shortPremium: 100,
    secondsToMaturity: 1_000,
    direction: 1,
  });
  assert.ok(long.impliedVolatilityPpm > 40_000_000n);
  assert.ok(long.deltaPpm > 500_000n && long.deltaPpm < 600_000n);
  assert.ok(spread.impliedVolatilityPpm > 40_000_000n);
  assert.ok(spread.deltaPpm > 0n);
  assert.notEqual(spread.gammaPpm, 0n);
  assert.notEqual(spread.vegaPpm, 0n);
  assert.notEqual(spread.thetaPpm, 0n);
  assert.notEqual(spread.volatilitySpreadPpm, 0n);
  const closing = callSpreadAnalytics({
    spot: 2_000,
    longStrike: 2_000,
    shortStrike: 2_500,
    longPremium: 200,
    shortPremium: 100,
    secondsToMaturity: 1_000,
    direction: -1,
  });
  assert.equal(closing.deltaPpm, -spread.deltaPpm);
  assert.equal(closing.thetaPpm, -spread.thetaPpm);
  assert.equal(closing.impliedVolatilityPpm, spread.impliedVolatilityPpm);
  assert.equal(closing.volatilitySpreadPpm, spread.volatilitySpreadPpm);
});

test('rejects premiums outside zero-carry no-arbitrage bounds', () => {
  assert.throws(() => callOptionAnalytics({
    spot: 100,
    strike: 80,
    premium: 10,
    secondsToMaturity: 86_400,
  }), /no-arbitrage/);
  assert.throws(() => callOptionAnalytics({
    spot: 100,
    strike: 120,
    premium: 100,
    secondsToMaturity: 86_400,
  }), /no-arbitrage/);
});
