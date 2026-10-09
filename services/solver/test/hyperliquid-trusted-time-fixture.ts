import {
  hyperliquidTrustedTimeDecisionHash,
  type HyperliquidTrustedTimeDecision,
  type HyperliquidTrustedTimePort,
} from '../src/hyperliquid-trusted-time.js';

export function trustedTimeDecision(
  selectedTimeMs: number,
  maximumFutureNonceLeadMs = 10_000,
  scope = 'test-operation',
): HyperliquidTrustedTimeDecision {
  const policy = Object.freeze({
    ntpHosts: Object.freeze(['time-a.example', 'time-b.example'] as const),
    ntpTimeoutMs: 1_000,
    maximumNtpRoundTripMs: 100,
    maximumSourceSpreadMs: 100,
    maximumLocalClockSkewMs: 100,
    maximumFutureNonceLeadMs,
    hyperliquidClockMarket: 'HYPE',
  });
  const samples = Object.freeze([
    Object.freeze({ sourceKind: 'NTP' as const, sourceId: policy.ntpHosts[0], remoteTimeMs: selectedTimeMs, roundTripMs: 10 }),
    Object.freeze({ sourceKind: 'NTP' as const, sourceId: policy.ntpHosts[1], remoteTimeMs: selectedTimeMs, roundTripMs: 11 }),
    Object.freeze({ sourceKind: 'HYPERLIQUID_L2_BOOK' as const, sourceId: 'HYPE', remoteTimeMs: selectedTimeMs, roundTripMs: 12 }),
  ] as const);
  const unsigned = Object.freeze({
    version: 1 as const,
    scope,
    observedAtMs: selectedTimeMs,
    selectedTimeMs,
    sourceSpreadMs: 0,
    localClockSkewMs: 0,
    policy,
    samples,
  });
  return Object.freeze({
    ...unsigned,
    decisionHash: hyperliquidTrustedTimeDecisionHash(unsigned),
  });
}

export function trustedTimePort(selectedTimeMs: number): HyperliquidTrustedTimePort {
  let nextTimeMs = selectedTimeMs;
  return Object.freeze({
    decide: async (scope: string) => trustedTimeDecision(nextTimeMs++, 10_000, scope),
  });
}
