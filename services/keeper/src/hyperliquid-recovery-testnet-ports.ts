import { createHash } from 'node:crypto';
import { time as readSntpTime, type TimeOptions } from '@hapi/sntp';
import {
  HttpTransport,
  InfoClient,
  TESTNET_API_URL,
  type IRequestTransport,
} from '@nktkas/hyperliquid';
import {
  order,
  type OrderSuccessResponse,
} from '@nktkas/hyperliquid/api/exchange';
import { getWalletAddress, type AbstractWallet } from '@nktkas/hyperliquid/signing';
import {
  createHyperliquidTrustedTimeDecision,
  type HyperliquidTrustedTimeDecision,
  type HyperliquidTrustedTimePolicy,
  type HyperliquidTrustedTimeSample,
} from '@naryx/adapter-hyperliquid';
import {
  HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL,
  type HyperliquidRecoveryTestnetSubmitter,
  type HyperliquidRecoveryTrustedTimePort,
} from './hyperliquid-recovery-testnet-runtime.js';

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const MARKET = /^[A-Za-z0-9@._:/-]{1,64}$/;
const SCOPE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

export const HYPERLIQUID_RECOVERY_SIGNER_SCOPE =
  'SERVER_SIDE_HYPERLIQUID_TESTNET_RECOVERY_AGENT';

export type HyperliquidRecoverySigner = AbstractWallet & Readonly<{
  signerScope: typeof HYPERLIQUID_RECOVERY_SIGNER_SCOPE;
}>;

export interface HyperliquidRecoveryTestnetExchangeTransport
extends IRequestTransport<'exchange'> {
  readonly isTestnet: true;
  readonly apiUrl: typeof HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL;
}

export interface HyperliquidRecoveryClockReader {
  readonly environment: 'testnet';
  readonly apiUrl: typeof HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL;
  l2BookTime(market: string): Promise<number>;
}

export interface HyperliquidRecoveryTrustedTimeSources {
  readonly readNtp: (host: string, timeoutMs: number) => Promise<TimeOptions>;
  readonly readHyperliquidBookTime: (market: string) => Promise<number>;
  readonly currentTimeMs: () => number;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Hyperliquid recovery Testnet port failed: ${message}`);
}

function boundedInteger(value: number, name: string, maximum: number): number {
  requireCondition(Number.isSafeInteger(value) && value > 0 && value <= maximum,
    `${name} must be a bounded positive integer`);
  return value;
}

function checkedTime(value: number, name: string): number {
  requireCondition(Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive safe integer`);
  return value;
}

function normalizedPolicy(value: HyperliquidTrustedTimePolicy): HyperliquidTrustedTimePolicy {
  const ntpHosts = value.ntpHosts.map((host) => host.trim().toLowerCase());
  requireCondition(ntpHosts.length === 2
    && ntpHosts.every((host) => HOST.test(host))
    && ntpHosts[0] !== ntpHosts[1], 'two distinct NTP hosts are required');
  requireCondition(MARKET.test(value.hyperliquidClockMarket), 'clock market is invalid');
  return Object.freeze({
    ntpHosts: Object.freeze([ntpHosts[0]!, ntpHosts[1]!] as const),
    ntpTimeoutMs: boundedInteger(value.ntpTimeoutMs, 'ntpTimeoutMs', 30_000),
    maximumNtpRoundTripMs: boundedInteger(
      value.maximumNtpRoundTripMs,
      'maximumNtpRoundTripMs',
      30_000,
    ),
    maximumSourceSpreadMs: boundedInteger(
      value.maximumSourceSpreadMs,
      'maximumSourceSpreadMs',
      60_000,
    ),
    maximumLocalClockSkewMs: boundedInteger(
      value.maximumLocalClockSkewMs,
      'maximumLocalClockSkewMs',
      60_000,
    ),
    maximumFutureNonceLeadMs: boundedInteger(
      value.maximumFutureNonceLeadMs,
      'maximumFutureNonceLeadMs',
      86_400_000,
    ),
    hyperliquidClockMarket: value.hyperliquidClockMarket,
  });
}

function ntpSample(
  host: string,
  value: TimeOptions,
  maximumRoundTripMs: number,
): HyperliquidTrustedTimeSample {
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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function responseCommitment(response: OrderSuccessResponse): `0x${string}` {
  return `0x${createHash('sha256')
    .update(JSON.stringify(stableValue(response)))
    .digest('hex')}`;
}

function requireTestnetTransport(
  transport: HyperliquidRecoveryTestnetExchangeTransport,
): void {
  requireCondition(transport.isTestnet
    && transport.apiUrl === HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL,
  'exchange transport is not pinned to Hyperliquid Testnet');
}

export class HyperliquidRecoveryTestnetHttpTransport
implements HyperliquidRecoveryTestnetExchangeTransport {
  readonly isTestnet = true as const;
  readonly apiUrl = HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL;
  readonly #transport: HttpTransport;

  constructor() {
    this.#transport = new HttpTransport({ isTestnet: true, apiUrl: TESTNET_API_URL });
    requireTestnetTransport(this);
  }

  request<T>(endpoint: 'exchange', payload: unknown, signal?: AbortSignal): Promise<T> {
    requireTestnetTransport(this);
    requireCondition(endpoint === 'exchange', 'only the exchange endpoint is available');
    return this.#transport.request<T>('exchange', payload, signal);
  }
}

export class HyperliquidSdkRecoveryTestnetSubmitter
implements HyperliquidRecoveryTestnetSubmitter {
  readonly environment = 'testnet' as const;
  readonly apiUrl = HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL;
  readonly #signer: HyperliquidRecoverySigner;
  readonly #transport: HyperliquidRecoveryTestnetExchangeTransport;

  constructor(
    signer: HyperliquidRecoverySigner,
    transport: HyperliquidRecoveryTestnetExchangeTransport =
      new HyperliquidRecoveryTestnetHttpTransport(),
  ) {
    requireCondition(signer.signerScope === HYPERLIQUID_RECOVERY_SIGNER_SCOPE,
      'a scoped Hyperliquid Testnet recovery signer is required');
    requireTestnetTransport(transport);
    this.#signer = signer;
    this.#transport = transport;
  }

  async signerAddress(): Promise<`0x${string}`> {
    const signerAddress = (await getWalletAddress(this.#signer)).toLowerCase();
    requireCondition(ADDRESS.test(signerAddress), 'signer address is invalid');
    return signerAddress as `0x${string}`;
  }

  async submit(input: Parameters<HyperliquidRecoveryTestnetSubmitter['submit']>[0]):
    Promise<Readonly<{ acknowledgementId: string }>> {
    requireCondition(input.nonce > 0n && input.nonce <= MAX_SAFE_INTEGER
      && input.expiresAfterMs > 0n && input.expiresAfterMs <= MAX_SAFE_INTEGER,
    'nonce and expiry must be positive safe integers');
    requireTestnetTransport(this.#transport);
    const options = input.vaultAddress === null
      ? { expiresAfter: Number(input.expiresAfterMs) }
      : { expiresAfter: Number(input.expiresAfterMs), vaultAddress: input.vaultAddress };
    const response = await order({
      transport: this.#transport as IRequestTransport,
      wallet: this.#signer,
      nonceManager: async () => Number(input.nonce),
    }, {
      orders: [...input.action.orders],
      grouping: input.action.grouping,
    }, options);
    return Object.freeze({ acknowledgementId: responseCommitment(response) });
  }
}

export class HyperliquidSdkRecoveryClockReader implements HyperliquidRecoveryClockReader {
  readonly environment = 'testnet' as const;
  readonly apiUrl = HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL;
  readonly #client: InfoClient;

  constructor() {
    const transport = new HttpTransport({ isTestnet: true, apiUrl: TESTNET_API_URL });
    requireCondition(transport.isTestnet
      && transport.apiUrl.toString() === HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL,
    'Info transport is not pinned to Hyperliquid Testnet');
    this.#client = new InfoClient({ transport });
  }

  async l2BookTime(market: string): Promise<number> {
    requireCondition(MARKET.test(market), 'clock market is invalid');
    const book = await this.#client.l2Book({ coin: market });
    requireCondition(book !== null, `Hyperliquid clock market ${market} is unavailable`);
    return checkedTime(book.time, 'Hyperliquid book time');
  }
}

export function createHyperliquidRecoveryTrustedTimeSources(
  reader: HyperliquidRecoveryClockReader,
  currentTimeMs: () => number = Date.now,
): HyperliquidRecoveryTrustedTimeSources {
  requireCondition(reader.environment === 'testnet'
    && reader.apiUrl === HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL
    && typeof reader.l2BookTime === 'function',
  'exact Hyperliquid Testnet clock reader is required');
  return Object.freeze({
    readNtp: (host: string, timeoutMs: number) => readSntpTime({
      host,
      port: 123,
      timeout: timeoutMs,
    }),
    readHyperliquidBookTime: (market: string) => reader.l2BookTime(market),
    currentTimeMs,
  });
}

export class HyperliquidRecoveryTrustedClock implements HyperliquidRecoveryTrustedTimePort {
  readonly #policy: HyperliquidTrustedTimePolicy;
  readonly #sources: HyperliquidRecoveryTrustedTimeSources;

  constructor(
    policy: HyperliquidTrustedTimePolicy,
    sources: HyperliquidRecoveryTrustedTimeSources,
  ) {
    requireCondition(typeof sources?.readNtp === 'function'
      && typeof sources.readHyperliquidBookTime === 'function'
      && typeof sources.currentTimeMs === 'function', 'complete trusted time sources are required');
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
    requireCondition(observedAtMs >= requestedAtMs,
      'local clock moved backwards during trusted time sampling');
    return createHyperliquidTrustedTimeDecision({
      scope,
      observedAtMs,
      policy: this.#policy,
      samples: Object.freeze([
        ntpSample(this.#policy.ntpHosts[0], firstNtp, this.#policy.maximumNtpRoundTripMs),
        ntpSample(this.#policy.ntpHosts[1], secondNtp, this.#policy.maximumNtpRoundTripMs),
        Object.freeze({
          sourceKind: 'HYPERLIQUID_L2_BOOK' as const,
          sourceId: this.#policy.hyperliquidClockMarket,
          remoteTimeMs: checkedTime(hyperliquidTime, 'Hyperliquid book time'),
          roundTripMs: observedAtMs - requestedAtMs,
        }),
      ]),
    });
  }
}
