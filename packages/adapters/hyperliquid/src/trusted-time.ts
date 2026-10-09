import { createHash } from 'node:crypto';

const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const MARKET = /^[A-Za-z0-9@._:/-]{1,64}$/;
const SCOPE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

export interface HyperliquidTrustedTimePolicy {
  readonly ntpHosts: readonly [string, string];
  readonly ntpTimeoutMs: number;
  readonly maximumNtpRoundTripMs: number;
  readonly maximumSourceSpreadMs: number;
  readonly maximumLocalClockSkewMs: number;
  readonly maximumFutureNonceLeadMs: number;
  readonly hyperliquidClockMarket: string;
}

export interface HyperliquidTrustedTimeSample {
  readonly sourceKind: 'NTP' | 'HYPERLIQUID_L2_BOOK';
  readonly sourceId: string;
  readonly remoteTimeMs: number;
  readonly roundTripMs: number;
}

export interface HyperliquidTrustedTimeDecision {
  readonly version: 1;
  readonly scope: string;
  readonly observedAtMs: number;
  readonly selectedTimeMs: number;
  readonly sourceSpreadMs: number;
  readonly localClockSkewMs: number;
  readonly policy: HyperliquidTrustedTimePolicy;
  readonly samples: readonly [
    HyperliquidTrustedTimeSample,
    HyperliquidTrustedTimeSample,
    HyperliquidTrustedTimeSample,
  ];
  readonly decisionHash: `0x${string}`;
}

export interface HyperliquidTrustedTimeDecisionInput {
  readonly scope: string;
  readonly observedAtMs: number;
  readonly policy: HyperliquidTrustedTimePolicy;
  readonly samples: readonly [
    HyperliquidTrustedTimeSample,
    HyperliquidTrustedTimeSample,
    HyperliquidTrustedTimeSample,
  ];
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Hyperliquid trusted time failed: ${message}`);
}

function safeInteger(value: number, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  requireCondition(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${name} is outside its integer bounds`);
  return value;
}

function canonicalDecision(value: Omit<HyperliquidTrustedTimeDecision, 'decisionHash'>): string {
  return JSON.stringify([
    value.version,
    value.scope,
    value.observedAtMs,
    value.selectedTimeMs,
    value.sourceSpreadMs,
    value.localClockSkewMs,
    [
      value.policy.ntpHosts[0], value.policy.ntpHosts[1], value.policy.ntpTimeoutMs,
      value.policy.maximumNtpRoundTripMs, value.policy.maximumSourceSpreadMs,
      value.policy.maximumLocalClockSkewMs, value.policy.maximumFutureNonceLeadMs,
      value.policy.hyperliquidClockMarket,
    ],
    value.samples.map((sample) => [
      sample.sourceKind, sample.sourceId, sample.remoteTimeMs, sample.roundTripMs,
    ]),
  ]);
}

export function hyperliquidTrustedTimeDecisionHash(
  value: Omit<HyperliquidTrustedTimeDecision, 'decisionHash'>,
): `0x${string}` {
  return `0x${createHash('sha256').update(canonicalDecision(value)).digest('hex')}`;
}

export function hyperliquidTrustedTimeDecisionJson(value: HyperliquidTrustedTimeDecision): string {
  const encoded = canonicalDecision(value);
  requireCondition(value.decisionHash
    === `0x${createHash('sha256').update(encoded).digest('hex')}`,
  'trusted time decision hash does not match its contents');
  return encoded;
}

export function createHyperliquidTrustedTimeDecision(
  input: HyperliquidTrustedTimeDecisionInput,
): HyperliquidTrustedTimeDecision {
  const policy = structuredClone(input.policy);
  const samples = structuredClone(input.samples);
  const orderedTimes = samples.map((sample) => sample.remoteTimeMs)
    .sort((left, right) => left - right);
  const selectedTimeMs = orderedTimes[1]!;
  const unsigned = Object.freeze({
    version: 1 as const,
    scope: input.scope,
    observedAtMs: input.observedAtMs,
    selectedTimeMs,
    sourceSpreadMs: orderedTimes[2]! - orderedTimes[0]!,
    localClockSkewMs: Math.abs(input.observedAtMs - selectedTimeMs),
    policy: Object.freeze(policy),
    samples: Object.freeze(samples) as HyperliquidTrustedTimeDecision['samples'],
  });
  return requireHyperliquidTrustedTimeDecision(Object.freeze({
    ...unsigned,
    decisionHash: hyperliquidTrustedTimeDecisionHash(unsigned),
  }));
}

export function requireHyperliquidTrustedTimeDecision(
  value: HyperliquidTrustedTimeDecision,
  expectedScope?: string,
): HyperliquidTrustedTimeDecision {
  requireCondition(value.version === 1 && SCOPE.test(value.scope), 'decision identity is invalid');
  if (expectedScope !== undefined) {
    requireCondition(value.scope === expectedScope, 'decision scope differs');
  }
  safeInteger(value.observedAtMs, 'observedAtMs', 1);
  safeInteger(value.selectedTimeMs, 'selectedTimeMs', 1);
  safeInteger(value.sourceSpreadMs, 'sourceSpreadMs', 0);
  safeInteger(value.localClockSkewMs, 'localClockSkewMs', 0);
  const policy = value.policy;
  requireCondition(Array.isArray(policy.ntpHosts) && policy.ntpHosts.length === 2
    && policy.ntpHosts.every((host) => HOST.test(host))
    && policy.ntpHosts[0] !== policy.ntpHosts[1], 'NTP hosts are invalid');
  safeInteger(policy.ntpTimeoutMs, 'ntpTimeoutMs', 1, 30_000);
  safeInteger(policy.maximumNtpRoundTripMs, 'maximumNtpRoundTripMs', 1, 30_000);
  safeInteger(policy.maximumSourceSpreadMs, 'maximumSourceSpreadMs', 1, 60_000);
  safeInteger(policy.maximumLocalClockSkewMs, 'maximumLocalClockSkewMs', 1, 60_000);
  safeInteger(policy.maximumFutureNonceLeadMs, 'maximumFutureNonceLeadMs', 1, 86_400_000);
  requireCondition(MARKET.test(policy.hyperliquidClockMarket), 'clock market is invalid');
  requireCondition(Array.isArray(value.samples) && value.samples.length === 3,
    'exactly three time samples are required');
  for (const [index, sample] of value.samples.entries()) {
    const expectedKind = index < 2 ? 'NTP' : 'HYPERLIQUID_L2_BOOK';
    const expectedId = index < 2 ? policy.ntpHosts[index] : policy.hyperliquidClockMarket;
    requireCondition(sample.sourceKind === expectedKind && sample.sourceId === expectedId,
      `sample ${index} identity is invalid`);
    safeInteger(sample.remoteTimeMs, `samples[${index}].remoteTimeMs`, 1);
    safeInteger(sample.roundTripMs, `samples[${index}].roundTripMs`, 0, 60_000);
    if (sample.sourceKind === 'NTP') {
      requireCondition(sample.roundTripMs <= policy.maximumNtpRoundTripMs,
        `sample ${index} exceeds the NTP round-trip policy`);
    }
  }
  const times = value.samples.map((sample) => sample.remoteTimeMs)
    .sort((left, right) => left - right);
  requireCondition(value.selectedTimeMs === times[1], 'selected time is not the sample median');
  requireCondition(value.sourceSpreadMs === times[2]! - times[0]!,
    'source spread differs from the samples');
  requireCondition(value.localClockSkewMs === Math.abs(value.observedAtMs - value.selectedTimeMs),
    'local clock skew differs from the samples');
  requireCondition(value.sourceSpreadMs <= policy.maximumSourceSpreadMs,
    'trusted sources disagree beyond policy');
  requireCondition(value.localClockSkewMs <= policy.maximumLocalClockSkewMs,
    'local clock differs from trusted time beyond policy');
  hyperliquidTrustedTimeDecisionJson(value);
  return value;
}

export function allocateHyperliquidTrustedNonce(
  trustedTimeMs: bigint,
  previousNonce: bigint,
  maximumFutureNonceLeadMs: bigint,
): bigint {
  requireCondition(trustedTimeMs > 0n && previousNonce >= 0n && maximumFutureNonceLeadMs > 0n,
    'trusted nonce inputs are invalid');
  requireCondition(previousNonce <= trustedTimeMs + maximumFutureNonceLeadMs,
    'durable nonce is beyond trusted time policy; fresh agent replacement is required');
  const nonce = trustedTimeMs > previousNonce ? trustedTimeMs : previousNonce + 1n;
  requireCondition(nonce <= BigInt(Number.MAX_SAFE_INTEGER),
    'allocated nonce must fit a safe integer');
  return nonce;
}
