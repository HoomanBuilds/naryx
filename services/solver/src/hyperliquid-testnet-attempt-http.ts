import {
  bytesEqual,
  commitmentHash,
  parseProtocolJson,
  toHex,
} from '@naryx/protocol-types';
import {
  validateHyperliquidTestnetRuntimeAttempt,
  type HyperliquidTestnetAttemptHandoff,
  type HyperliquidTestnetTrustedAttemptProvider,
} from './hyperliquid-testnet-executor-http.js';
import type {
  StrategyPackageProvider,
} from './http-strategy-package-provider.js';
import type { StrategyPreparationService } from './strategy-preparation-service.js';

export const API_HYPERLIQUID_TESTNET_ATTEMPT_PATH =
  '/internal/solver/hyperliquid-testnet/attempts/';
export const API_HYPERLIQUID_TESTNET_SOURCE_ATTEMPT_PATH =
  '/internal/solver/hyperliquid-testnet/source-attempts/';

const ATTEMPT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const STRATEGY_ATTEMPT_ID = /^strategy-hl-[0-9a-f]{48}$/;
const SOURCE_ATTEMPT_ID = /^hyperliquid-testnet-[0-9a-f]{48}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 262_144;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

export interface HyperliquidTestnetAttemptHttpOptions {
  readonly apiOrigin: string;
  readonly timeoutMs?: number;
  readonly fetchImplementation?: typeof fetch;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('attempt API origin must be an absolute URL');
  }
  if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)
    || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('attempt API origin must be a loopback HTTP origin');
  }
  return url.origin;
}

function timeout(value: number | undefined): number {
  const checked = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(checked) || checked < 1 || checked > MAX_TIMEOUT_MS) {
    throw new Error('attempt API timeout must be a bounded positive integer');
  }
  return checked;
}

async function boundedProtocolJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json' || response.body === null) {
    throw new Error('attempt API response is invalid');
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null
    && (!/^\d+$/.test(statedLength) || Number(statedLength) > MAX_RESPONSE_BYTES)) {
    throw new Error('attempt API response is too large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('attempt API response is too large');
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parseProtocolJson(text, 'solver.hyperliquidTestnet.attempt');
  } catch {
    throw new Error('attempt API response is malformed');
  }
}

function exactEnvelope(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('attempt API response must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'attempt' || keys[1] !== 'version'
    || record.version !== 1) {
    throw new Error('attempt API response fields are invalid');
  }
  return record.attempt;
}

class HttpHyperliquidTestnetAttemptProvider implements HyperliquidTestnetTrustedAttemptProvider {
  readonly #origin: string;
  readonly #path: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HyperliquidTestnetAttemptHttpOptions, path: string) {
    this.#origin = loopbackOrigin(options.apiOrigin);
    this.#path = path;
    this.#timeoutMs = timeout(options.timeoutMs);
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async resolve(attemptId: string) {
    if (!ATTEMPT_ID.test(attemptId)) throw new Error('attempt ID is invalid');
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#origin}${this.#path}${attemptId}`,
        {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch {
      throw new Error('attempt API request failed');
    }
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`attempt API request failed with HTTP ${response.status}`);
    return validateHyperliquidTestnetRuntimeAttempt(
      attemptId,
      exactEnvelope(await boundedProtocolJson(response)),
    );
  }
}

export class HttpHyperliquidTestnetTrustedAttemptProvider
extends HttpHyperliquidTestnetAttemptProvider {
  constructor(options: HyperliquidTestnetAttemptHttpOptions) {
    super(options, API_HYPERLIQUID_TESTNET_ATTEMPT_PATH);
  }
}

export class HttpHyperliquidTestnetSelectedSourceProvider
extends HttpHyperliquidTestnetAttemptProvider {
  constructor(options: HyperliquidTestnetAttemptHttpOptions) {
    super(options, API_HYPERLIQUID_TESTNET_SOURCE_ATTEMPT_PATH);
  }
}

type StrategyAttemptMetadata = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  orderHashHex: string;
  graphHashHex: string;
  quoteHashHex: string;
  routeHashHex: string;
  sourceOrderHashHex: string;
  status: 'HYPERLIQUID_TESTNET_QUOTE_SELECTED';
  selectedAtMs: number;
}>;

type NativeStrategyAttemptMetadata = Omit<StrategyAttemptMetadata, 'sourceOrderHashHex'>;

type NativeStrategyAsset = Readonly<{
  assetId: string;
  decimals: number;
  assetManifestHashHex: string;
}>;

type NativeStrategyRuntime = Readonly<{
  domainId: 'hypercore:testnet';
  domainManifestVersion: number;
  domainManifestHashHex: string;
  seriesManifestHash: string;
  executionClassManifestHash: string;
  baseAsset: NativeStrategyAsset;
  quoteAsset: NativeStrategyAsset;
  market: HyperliquidTestnetAttemptHandoff['market'];
  limits: HyperliquidTestnetAttemptHandoff['limits'];
}>;

function nativeAsset(value: unknown, name: string): NativeStrategyAsset {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`native strategy ${name} asset is invalid`);
  }
  const asset = value as Record<string, unknown>;
  if (Object.keys(asset).sort().join(',') !== 'assetId,assetManifestHashHex,decimals'
    || typeof asset.assetId !== 'string' || asset.assetId.length < 1 || asset.assetId.length > 128
    || !Number.isSafeInteger(asset.decimals) || Number(asset.decimals) < 0 || Number(asset.decimals) > 18
    || typeof asset.assetManifestHashHex !== 'string' || !HASH.test(asset.assetManifestHashHex)
    || /^0+$/.test(asset.assetManifestHashHex)) {
    throw new Error(`native strategy ${name} asset is invalid`);
  }
  return Object.freeze(asset as unknown as NativeStrategyAsset);
}

type StrategyAttemptMetadataEnvelope =
  | Readonly<{
    version: 1;
    attempt: StrategyAttemptMetadata;
    sourceAttemptId: string;
  }>
  | Readonly<{
    version: 2;
    attempt: NativeStrategyAttemptMetadata;
    runtime: NativeStrategyRuntime;
  }>;

function nativeRuntime(value: unknown): NativeStrategyRuntime {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('native strategy runtime must be an object');
  }
  const runtime = value as Record<string, unknown>;
  const runtimeKeys = [
    'baseAsset', 'domainId', 'domainManifestHashHex', 'domainManifestVersion',
    'executionClassManifestHash', 'limits', 'market', 'quoteAsset', 'seriesManifestHash',
  ];
  const keys = Object.keys(runtime).sort();
  if (keys.length !== runtimeKeys.length || keys.some((key, index) => key !== runtimeKeys[index])
    || runtime.domainId !== 'hypercore:testnet'
    || !Number.isSafeInteger(runtime.domainManifestVersion)
    || Number(runtime.domainManifestVersion) <= 0) {
    throw new Error('native strategy runtime identity is invalid');
  }
  for (const field of ['domainManifestHashHex', 'seriesManifestHash', 'executionClassManifestHash'] as const) {
    if (typeof runtime[field] !== 'string' || !HASH.test(runtime[field]) || /^0+$/.test(runtime[field])) {
      throw new Error('native strategy runtime commitment is invalid');
    }
  }
  if (typeof runtime.market !== 'object' || runtime.market === null || Array.isArray(runtime.market)
    || typeof runtime.limits !== 'object' || runtime.limits === null || Array.isArray(runtime.limits)) {
    throw new Error('native strategy runtime market or limits are invalid');
  }
  const market = runtime.market as Record<string, unknown>;
  if (Object.keys(market).sort().join(',') !== 'perpetual,quoteTokenIndex,spot'
    || !Number.isSafeInteger(market.quoteTokenIndex)
    || Number(market.quoteTokenIndex) < 0
    || typeof market.spot !== 'object' || market.spot === null || Array.isArray(market.spot)
    || typeof market.perpetual !== 'object' || market.perpetual === null || Array.isArray(market.perpetual)) {
    throw new Error('native strategy runtime market is invalid');
  }
  const checkedLeg = (legValue: unknown, kind: 'spot' | 'perpetual') => {
    const leg = legValue as Record<string, unknown>;
    const extra = kind === 'spot' ? 'tokenIndex,universeIndex' : 'assetIndex';
    const expected = `adapterId,adapterManifestHash,adapterManifestVersion,assetId,${extra},marketId,marketManifestHash,marketManifestVersion,sizeDecimals,venueId,venueManifestHash,venueManifestVersion`
      .split(',').sort();
    const legKeys = Object.keys(leg).sort();
    if (legKeys.length !== expected.length || legKeys.some((key, index) => key !== expected[index])) {
      throw new Error(`native strategy ${kind} market fields are invalid`);
    }
    for (const field of ['adapterId', 'venueId', 'marketId'] as const) {
      if (typeof leg[field] !== 'string' || leg[field].length < 1 || leg[field].length > 128) {
        throw new Error(`native strategy ${kind} market identity is invalid`);
      }
    }
    for (const field of ['adapterManifestHash', 'venueManifestHash', 'marketManifestHash'] as const) {
      if (typeof leg[field] !== 'string' || !HASH.test(leg[field]) || /^0+$/.test(leg[field])) {
        throw new Error(`native strategy ${kind} market commitment is invalid`);
      }
    }
    for (const field of ['adapterManifestVersion', 'venueManifestVersion', 'marketManifestVersion', 'assetId', 'sizeDecimals'] as const) {
      if (!Number.isSafeInteger(leg[field]) || Number(leg[field]) < 0) {
        throw new Error(`native strategy ${kind} market number is invalid`);
      }
    }
    const indexFields = kind === 'spot' ? ['tokenIndex', 'universeIndex'] : ['assetIndex'];
    for (const field of indexFields) {
      if (!Number.isSafeInteger(leg[field]) || Number(leg[field]) < 0) {
        throw new Error(`native strategy ${kind} market index is invalid`);
      }
    }
  };
  checkedLeg(market.spot, 'spot');
  checkedLeg(market.perpetual, 'perpetual');
  const limits = runtime.limits as Record<string, unknown>;
  if (Object.keys(limits).sort().join(',') !== 'maxEvidenceAgeMs,maxFillPages,maxSnapshotSkewMs'
    || Object.values(limits).some((item) => !Number.isSafeInteger(item) || Number(item) <= 0)) {
    throw new Error('native strategy runtime limits are invalid');
  }
  return Object.freeze({
    ...runtime,
    baseAsset: nativeAsset(runtime.baseAsset, 'base'),
    quoteAsset: nativeAsset(runtime.quoteAsset, 'quote'),
  } as unknown as NativeStrategyRuntime);
}

function sameNativeAsset(
  actual: Readonly<{ assetId: string; decimals: number; assetManifestHash: Uint8Array }>,
  expected: NativeStrategyAsset,
): boolean {
  return actual.assetId === expected.assetId
    && actual.decimals === expected.decimals
    && toHex(actual.assetManifestHash) === expected.assetManifestHashHex;
}

function strategyMetadata(value: unknown, expectedAttemptId: string): StrategyAttemptMetadataEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('strategy attempt response must be an object');
  }
  const envelope = value as Record<string, unknown>;
  const envelopeKeys = Object.keys(envelope).sort();
  const legacy = envelope.version === 1;
  const native = envelope.version === 2;
  const expectedEnvelopeKeys = legacy
    ? ['attempt', 'sourceAttemptId', 'version']
    : ['attempt', 'runtime', 'version'];
  if ((!legacy && !native)
    || envelopeKeys.length !== expectedEnvelopeKeys.length
    || envelopeKeys.some((key, index) => key !== expectedEnvelopeKeys[index])
    || (legacy && (typeof envelope.sourceAttemptId !== 'string'
      || !SOURCE_ATTEMPT_ID.test(envelope.sourceAttemptId)))
    || typeof envelope.attempt !== 'object' || envelope.attempt === null
    || Array.isArray(envelope.attempt)) {
    throw new Error('strategy attempt response fields are invalid');
  }
  const attempt = envelope.attempt as Record<string, unknown>;
  const expectedKeys = [...[
    'attemptId', 'graphHashHex', 'idempotencyKey', 'orderHashHex', 'quoteHashHex',
    'routeHashHex', 'selectedAtMs', 'status',
  ], ...(legacy ? ['sourceOrderHashHex'] : [])].sort();
  const keys = Object.keys(attempt).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
    || attempt.attemptId !== expectedAttemptId
    || typeof attempt.idempotencyKey !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(attempt.idempotencyKey)
    || attempt.status !== 'HYPERLIQUID_TESTNET_QUOTE_SELECTED'
    || !Number.isSafeInteger(attempt.selectedAtMs) || Number(attempt.selectedAtMs) <= 0) {
    throw new Error('strategy attempt identity is invalid');
  }
  for (const field of ['orderHashHex', 'graphHashHex', 'quoteHashHex', 'routeHashHex'] as const) {
    if (typeof attempt[field] !== 'string' || !HASH.test(attempt[field])) {
      throw new Error('strategy attempt commitment is invalid');
    }
  }
  if (legacy) {
    if (typeof attempt.sourceOrderHashHex !== 'string' || !HASH.test(attempt.sourceOrderHashHex)) {
      throw new Error('strategy source commitment is invalid');
    }
    return Object.freeze({
      version: 1 as const,
      attempt: Object.freeze(attempt as unknown as StrategyAttemptMetadata),
      sourceAttemptId: envelope.sourceAttemptId as string,
    });
  }
  const runtime = nativeRuntime(envelope.runtime);
  return Object.freeze({
    version: 2 as const,
    attempt: Object.freeze(attempt as unknown as NativeStrategyAttemptMetadata),
    runtime,
  });
}

export interface HyperliquidTestnetCompositeAttemptOptions extends HyperliquidTestnetAttemptHttpOptions {
  readonly packages: StrategyPackageProvider;
  readonly preparations: Pick<StrategyPreparationService, 'prepareDocuments'>;
  readonly liveAttempts?: HyperliquidTestnetTrustedAttemptProvider;
  readonly sourceAttempts?: HyperliquidTestnetTrustedAttemptProvider;
}

export class HttpHyperliquidTestnetCompositeAttemptProvider
implements HyperliquidTestnetTrustedAttemptProvider {
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #packages: StrategyPackageProvider;
  readonly #preparations: Pick<StrategyPreparationService, 'prepareDocuments'>;
  readonly #liveAttempts: HyperliquidTestnetTrustedAttemptProvider;
  readonly #sourceAttempts: HyperliquidTestnetTrustedAttemptProvider;

  constructor(options: HyperliquidTestnetCompositeAttemptOptions) {
    this.#origin = loopbackOrigin(options.apiOrigin);
    this.#timeoutMs = timeout(options.timeoutMs);
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#packages = options.packages;
    this.#preparations = options.preparations;
    this.#liveAttempts = options.liveAttempts ?? new HttpHyperliquidTestnetTrustedAttemptProvider(options);
    this.#sourceAttempts = options.sourceAttempts ?? new HttpHyperliquidTestnetSelectedSourceProvider(options);
  }

  async resolve(attemptId: string): Promise<HyperliquidTestnetAttemptHandoff | undefined> {
    if (!STRATEGY_ATTEMPT_ID.test(attemptId)) return this.#liveAttempts.resolve(attemptId);
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#origin}/internal/solver/hyperliquid-testnet/strategy-attempts/${attemptId}`,
        { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs) },
      );
    } catch {
      throw new Error('strategy attempt API request failed');
    }
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`strategy attempt API request failed with HTTP ${response.status}`);
    const metadata = strategyMetadata(await boundedProtocolJson(response), attemptId);
    const documents = await this.#packages.getByQuote(commitmentHash(metadata.attempt.quoteHashHex));
    if (documents === undefined
      || documents.orderHashHex !== metadata.attempt.orderHashHex
      || documents.graphHashHex !== metadata.attempt.graphHashHex
      || documents.quoteHashHex !== metadata.attempt.quoteHashHex
      || documents.routeHashHex !== metadata.attempt.routeHashHex) {
      throw new Error('strategy attempt commitments do not match stored documents');
    }
    const prepared = await this.#preparations.prepareDocuments(documents);
    if (!bytesEqual(prepared.orderHash, commitmentHash(metadata.attempt.orderHashHex))
      || !bytesEqual(prepared.graphHash, commitmentHash(metadata.attempt.graphHashHex))
      || !bytesEqual(prepared.quoteHash, commitmentHash(metadata.attempt.quoteHashHex))
      || !bytesEqual(prepared.routeHash, commitmentHash(metadata.attempt.routeHashHex))
      || prepared.domains.length !== 1 || prepared.domains[0]?.kind !== 'HYPERCORE_EXECUTOR') {
      throw new Error('prepared strategy execution does not match the selected attempt');
    }
    if (metadata.version === 2) {
      const plan = prepared.domains[0].plan;
      const runtime = metadata.runtime;
      const baseDecimals = new Set(plan.orders.map((order) => order.baseAsset.decimals));
      const requiredUntilMs = [
        documents.order.expiryValue,
        documents.quote.validUntilValue,
        documents.route.routeExpiryValue,
        plan.requestExpiryMs,
      ].reduce((maximum, value) => value > maximum ? value : maximum, 0n);
      if (documents.order.expiryUnit !== 'HYPERLIQUID_UNIX_MILLISECONDS'
        || documents.quote.validUntilUnit !== 'HYPERLIQUID_UNIX_MILLISECONDS'
        || documents.route.routeExpiryUnit !== 'HYPERLIQUID_UNIX_MILLISECONDS'
        || plan.domain.domainId !== runtime.domainId
        || plan.domain.domainManifestVersion !== runtime.domainManifestVersion
        || toHex(plan.domain.domainManifestHash) !== runtime.domainManifestHashHex
        || toHex(documents.order.seriesManifestHash) !== runtime.seriesManifestHash
        || toHex(documents.order.executionClassManifestHash) !== runtime.executionClassManifestHash
        || baseDecimals.size !== 1
        || plan.orders.some((order) => !sameNativeAsset(order.baseAsset, runtime.baseAsset)
          || !sameNativeAsset(order.quoteAsset, runtime.quoteAsset))) {
        throw new Error('native strategy runtime does not match the prepared package');
      }
      return validateHyperliquidTestnetRuntimeAttempt(attemptId, Object.freeze({
        attemptId,
        authority: Object.freeze({
          requiredUntilMs,
          baseAssetDecimals: runtime.baseAsset.decimals,
        }),
        seriesManifestHash: runtime.seriesManifestHash,
        executionClassManifestHash: runtime.executionClassManifestHash,
        market: runtime.market,
        limits: runtime.limits,
        selectedAtMs: metadata.attempt.selectedAtMs,
        strategy: Object.freeze({
          graphHash: prepared.graphHash,
          plan,
        }),
      }));
    }
    const source = await this.#sourceAttempts.resolve(metadata.sourceAttemptId);
    if (source === undefined) throw new Error('strategy source attempt was not found');
    if (!('admission' in source)
      || toHex(source.admission.orderHash) !== metadata.attempt.sourceOrderHashHex) {
      throw new Error('strategy source attempt does not match source evidence');
    }
    return validateHyperliquidTestnetRuntimeAttempt(attemptId, Object.freeze({
      ...source,
      attemptId,
      selectedAtMs: metadata.attempt.selectedAtMs,
      strategy: Object.freeze({
        sourceAttemptId: metadata.sourceAttemptId,
        graphHash: prepared.graphHash,
        plan: prepared.domains[0].plan,
      }),
    }));
  }
}
