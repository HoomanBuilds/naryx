import { time as readSntpTime, type TimeOptions } from '@hapi/sntp';
import {
  hyperliquidTrustedTimeDecisionHash,
  requireHyperliquidTrustedTimeDecision as validateHyperliquidTrustedTimeDecision,
  type HyperliquidTrustedTimeDecision,
  type HyperliquidTrustedTimePolicy,
  type HyperliquidTrustedTimeSample,
} from '@naryx/adapter-hyperliquid';
import {
  HYPERLIQUID_TESTNET_MARKET_INFO_URL,
  type HyperliquidTestnetMarketReadPort,
} from './hyperliquid-testnet-market-preflight.js';

const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const MARKET = /^[A-Za-z0-9@._:/-]{1,64}$/;
const SCOPE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

export {
  hyperliquidTrustedTimeDecisionHash,
  hyperliquidTrustedTimeDecisionJson,
  type HyperliquidTrustedTimeDecision,
  type HyperliquidTrustedTimePolicy,
  type HyperliquidTrustedTimeSample,
} from '@naryx/adapter-hyperliquid';

export interface HyperliquidTrustedTimePort {
  decide(scope: string): Promise<HyperliquidTrustedTimeDecision>;
}

export interface HyperliquidTrustedTimeSources {
  readonly readNtp: (host: string, timeoutMs: number) => Promise<TimeOptions>;
  readonly readHyperliquidBookTime: (market: string) => Promise<number>;
  readonly currentTimeMs: () => number;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  requireCondition(value !== undefined && value.length > 0, `${name} is required`);
  return value;
}

function environmentInteger(environment: NodeJS.ProcessEnv, name: string, maximum: number): number {
  const value = requiredEnvironment(environment, name);
  requireCondition(/^[1-9][0-9]*$/.test(value), `${name} must be a positive integer`);
  return positiveInteger(Number(value), name, maximum);
}

export function hyperliquidTrustedTimePolicyFromEnvironment(
  environment: NodeJS.ProcessEnv,
): HyperliquidTrustedTimePolicy {
  return normalizedPolicy({
    ntpHosts: [
      requiredEnvironment(environment, 'NARYX_HYPERLIQUID_TESTNET_NTP_HOST_1'),
      requiredEnvironment(environment, 'NARYX_HYPERLIQUID_TESTNET_NTP_HOST_2'),
    ],
    ntpTimeoutMs: environmentInteger(
      environment, 'NARYX_HYPERLIQUID_TESTNET_NTP_TIMEOUT_MS', 30_000,
    ),
    maximumNtpRoundTripMs: environmentInteger(
      environment, 'NARYX_HYPERLIQUID_TESTNET_MAX_NTP_ROUND_TRIP_MS', 30_000,
    ),
    maximumSourceSpreadMs: environmentInteger(
      environment, 'NARYX_HYPERLIQUID_TESTNET_MAX_TIME_SOURCE_SPREAD_MS', 60_000,
    ),
    maximumLocalClockSkewMs: environmentInteger(
      environment, 'NARYX_HYPERLIQUID_TESTNET_MAX_LOCAL_CLOCK_SKEW_MS', 60_000,
    ),
    maximumFutureNonceLeadMs: environmentInteger(
      environment, 'NARYX_HYPERLIQUID_TESTNET_MAX_FUTURE_NONCE_LEAD_MS', 86_400_000,
    ),
    hyperliquidClockMarket: requiredEnvironment(
      environment, 'NARYX_HYPERLIQUID_TESTNET_CLOCK_MARKET',
    ),
  });
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Hyperliquid trusted time failed: ${message}`);
}

function positiveInteger(value: number, name: string, maximum: number): number {
  requireCondition(Number.isSafeInteger(value) && value > 0 && value <= maximum,
    `${name} must be a bounded positive integer`);
  return value;
}

function checkedTime(value: number, name: string): number {
  requireCondition(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`);
  return value;
}

function normalizedPolicy(value: HyperliquidTrustedTimePolicy): HyperliquidTrustedTimePolicy {
  const ntpHosts = value.ntpHosts.map((host) => host.trim().toLowerCase());
  requireCondition(ntpHosts.length === 2 && ntpHosts.every((host) => HOST.test(host))
    && ntpHosts[0] !== ntpHosts[1], 'two distinct NTP hosts are required');
  requireCondition(MARKET.test(value.hyperliquidClockMarket), 'clock market is invalid');
  return Object.freeze({
    ntpHosts: Object.freeze([ntpHosts[0]!, ntpHosts[1]!] as const),
    ntpTimeoutMs: positiveInteger(value.ntpTimeoutMs, 'ntpTimeoutMs', 30_000),
    maximumNtpRoundTripMs: positiveInteger(
      value.maximumNtpRoundTripMs, 'maximumNtpRoundTripMs', 30_000,
    ),
    maximumSourceSpreadMs: positiveInteger(
      value.maximumSourceSpreadMs, 'maximumSourceSpreadMs', 60_000,
    ),
    maximumLocalClockSkewMs: positiveInteger(
      value.maximumLocalClockSkewMs, 'maximumLocalClockSkewMs', 60_000,
    ),
    maximumFutureNonceLeadMs: positiveInteger(
      value.maximumFutureNonceLeadMs, 'maximumFutureNonceLeadMs', 86_400_000,
    ),
    hyperliquidClockMarket: value.hyperliquidClockMarket,
  });
}

function ntpSample(host: string, value: TimeOptions, maximumRoundTripMs: number): HyperliquidTrustedTimeSample {
  requireCondition(value.isValid && value.mode === 'server'
    && (value.stratum === 'primary' || value.stratum === 'secondary')
    && value.leapIndicator !== 'alarm', `NTP sample from ${host} is invalid`);
  requireCondition(Number.isFinite(value.d) && value.d >= 0 && value.d <= maximumRoundTripMs,
    `NTP round trip from ${host} exceeds policy`);
  requireCondition(Number.isFinite(value.t) && Number.isFinite(value.receivedLocally),
    `NTP timestamps from ${host} are invalid`);
  return Object.freeze({
    sourceKind: 'NTP',
    sourceId: host,
    remoteTimeMs: checkedTime(Math.round(value.receivedLocally + value.t), `${host} time`),
    roundTripMs: Math.round(value.d),
  });
}

export class HyperliquidTrustedClock implements HyperliquidTrustedTimePort {
  readonly #policy: HyperliquidTrustedTimePolicy;
  readonly #sources: HyperliquidTrustedTimeSources;

  constructor(policy: HyperliquidTrustedTimePolicy, sources: HyperliquidTrustedTimeSources) {
    requireCondition(typeof sources?.readNtp === 'function'
      && typeof sources.readHyperliquidBookTime === 'function'
      && typeof sources.currentTimeMs === 'function', 'complete time sources are required');
    this.#policy = normalizedPolicy(policy);
    this.#sources = sources;
  }

  async decide(scope: string): Promise<HyperliquidTrustedTimeDecision> {
    requireCondition(SCOPE.test(scope), 'decision scope is invalid');
    const requestedAtMs = checkedTime(this.#sources.currentTimeMs(), 'local request time');
    const [firstNtp, secondNtp, hyperliquidTime] = await Promise.all([
      this.#sources.readNtp(this.#policy.ntpHosts[0], this.#policy.ntpTimeoutMs),
      this.#sources.readNtp(this.#policy.ntpHosts[1], this.#policy.ntpTimeoutMs),
      this.#sources.readHyperliquidBookTime(this.#policy.hyperliquidClockMarket),
    ]);
    const observedAtMs = checkedTime(this.#sources.currentTimeMs(), 'local observation time');
    requireCondition(observedAtMs >= requestedAtMs, 'local clock moved backwards during sampling');
    const samples = Object.freeze([
      ntpSample(this.#policy.ntpHosts[0], firstNtp, this.#policy.maximumNtpRoundTripMs),
      ntpSample(this.#policy.ntpHosts[1], secondNtp, this.#policy.maximumNtpRoundTripMs),
      Object.freeze({
        sourceKind: 'HYPERLIQUID_L2_BOOK' as const,
        sourceId: this.#policy.hyperliquidClockMarket,
        remoteTimeMs: checkedTime(hyperliquidTime, 'Hyperliquid book time'),
        roundTripMs: observedAtMs - requestedAtMs,
      }),
    ] as const);
    const orderedTimes = samples.map((sample) => sample.remoteTimeMs).sort((left, right) => left - right);
    const selectedTimeMs = orderedTimes[1]!;
    const sourceSpreadMs = orderedTimes[2]! - orderedTimes[0]!;
    const localClockSkewMs = Math.abs(observedAtMs - selectedTimeMs);
    requireCondition(sourceSpreadMs <= this.#policy.maximumSourceSpreadMs,
      'trusted sources disagree beyond policy');
    requireCondition(localClockSkewMs <= this.#policy.maximumLocalClockSkewMs,
      'local clock differs from trusted time beyond policy');
    const unsigned = Object.freeze({
      version: 1 as const,
      scope,
      observedAtMs,
      selectedTimeMs,
      sourceSpreadMs,
      localClockSkewMs,
      policy: this.#policy,
      samples,
    });
    return validateHyperliquidTrustedTimeDecision(Object.freeze({
      ...unsigned,
      decisionHash: hyperliquidTrustedTimeDecisionHash(unsigned),
    }));
  }
}

export function createHyperliquidTrustedTimeSources(
  reader: HyperliquidTestnetMarketReadPort,
  currentTimeMs: () => number = Date.now,
): HyperliquidTrustedTimeSources {
  requireCondition(reader.environment === 'testnet'
    && reader.apiUrl === HYPERLIQUID_TESTNET_MARKET_INFO_URL
    && typeof reader.l2Book === 'function',
    'exact Hyperliquid Testnet l2Book reader is required');
  return Object.freeze({
    readNtp: (host: string, timeoutMs: number) => readSntpTime({ host, port: 123, timeout: timeoutMs }),
    async readHyperliquidBookTime(market: string): Promise<number> {
      const book = await reader.l2Book!(market);
      requireCondition(book !== null, `Hyperliquid clock market ${market} is unavailable`);
      return checkedTime(book.time, 'Hyperliquid book time');
    },
    currentTimeMs,
  });
}
