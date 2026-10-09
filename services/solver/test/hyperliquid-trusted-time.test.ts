import assert from 'node:assert/strict';
import test from 'node:test';
import type { TimeOptions } from '@hapi/sntp';
import {
  HyperliquidTrustedClock,
  type HyperliquidTrustedTimePolicy,
  type HyperliquidTrustedTimeSources,
} from '../src/hyperliquid-trusted-time.js';

const policy: HyperliquidTrustedTimePolicy = {
  ntpHosts: ['time-a.example', 'time-b.example'],
  ntpTimeoutMs: 1_000,
  maximumNtpRoundTripMs: 100,
  maximumSourceSpreadMs: 100,
  maximumLocalClockSkewMs: 100,
  maximumFutureNonceLeadMs: 10_000,
  hyperliquidClockMarket: 'HYPE',
};

function ntp(localTimeMs: number, remoteTimeMs: number, overrides: Partial<TimeOptions> = {}): TimeOptions {
  return {
    isValid: true,
    leapIndicator: 'no-warning',
    version: 4,
    mode: 'server',
    stratum: 'secondary',
    pollInterval: 1_000,
    precision: 1,
    rootDelay: 1,
    rootDispersion: 1,
    referenceId: '127.0.0.1',
    referenceTimestamp: remoteTimeMs - 1,
    originateTimestamp: localTimeMs - 2,
    receiveTimestamp: remoteTimeMs - 1,
    transmitTimestamp: remoteTimeMs,
    d: 10,
    t: remoteTimeMs - localTimeMs,
    receivedLocally: localTimeMs,
    ...overrides,
  };
}

function sources(input: Readonly<{
  local: readonly number[];
  firstNtp: TimeOptions | Error;
  secondNtp: TimeOptions | Error;
  hyperliquidTimeMs: number;
}>): HyperliquidTrustedTimeSources {
  let localRead = 0;
  return {
    currentTimeMs: () => input.local[localRead++]!,
    readNtp: async (host) => {
      const value = host === policy.ntpHosts[0] ? input.firstNtp : input.secondNtp;
      if (value instanceof Error) throw value;
      return value;
    },
    readHyperliquidBookTime: async () => input.hyperliquidTimeMs,
  };
}

test('selects the median of two valid NTP samples and Hyperliquid server time', async () => {
  const clock = new HyperliquidTrustedClock(policy, sources({
    local: [1_000_000, 1_000_020],
    firstNtp: ntp(1_000_000, 1_000_010),
    secondNtp: ntp(1_000_000, 1_000_015),
    hyperliquidTimeMs: 1_000_012,
  }));
  const decision = await clock.decide('attempt-1');
  assert.equal(decision.selectedTimeMs, 1_000_012);
  assert.equal(decision.sourceSpreadMs, 5);
  assert.equal(decision.localClockSkewMs, 8);
  assert.match(decision.decisionHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(decision.samples.map((sample) => sample.sourceKind), [
    'NTP', 'NTP', 'HYPERLIQUID_L2_BOOK',
  ]);
});

test('fails closed on NTP loss, invalid NTP state, source disagreement, and local skew', async () => {
  await assert.rejects(new HyperliquidTrustedClock(policy, sources({
    local: [1_000_000, 1_000_010],
    firstNtp: new Error('unavailable'),
    secondNtp: ntp(1_000_000, 1_000_000),
    hyperliquidTimeMs: 1_000_000,
  })).decide('attempt-1'), /unavailable/);
  await assert.rejects(new HyperliquidTrustedClock(policy, sources({
    local: [1_000_000, 1_000_010],
    firstNtp: ntp(1_000_000, 1_000_000, { leapIndicator: 'alarm' }),
    secondNtp: ntp(1_000_000, 1_000_000),
    hyperliquidTimeMs: 1_000_000,
  })).decide('attempt-1'), /NTP sample.*invalid/);
  await assert.rejects(new HyperliquidTrustedClock(policy, sources({
    local: [1_000_000, 1_000_010],
    firstNtp: ntp(1_000_000, 1_000_000),
    secondNtp: ntp(1_000_000, 1_001_000),
    hyperliquidTimeMs: 1_000_000,
  })).decide('attempt-1'), /sources disagree/);
  await assert.rejects(new HyperliquidTrustedClock(policy, sources({
    local: [2_000_000, 2_000_010],
    firstNtp: ntp(2_000_000, 1_000_000),
    secondNtp: ntp(2_000_000, 1_000_000),
    hyperliquidTimeMs: 1_000_000,
  })).decide('attempt-1'), /local clock differs/);
});
