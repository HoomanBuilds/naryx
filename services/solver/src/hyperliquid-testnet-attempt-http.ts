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

function strategyMetadata(value: unknown, expectedAttemptId: string): Readonly<{
  attempt: StrategyAttemptMetadata;
  sourceAttemptId: string;
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('strategy attempt response must be an object');
  }
  const envelope = value as Record<string, unknown>;
  const envelopeKeys = Object.keys(envelope).sort();
  if (envelopeKeys.length !== 3 || envelopeKeys[0] !== 'attempt'
    || envelopeKeys[1] !== 'sourceAttemptId' || envelopeKeys[2] !== 'version'
    || envelope.version !== 1 || typeof envelope.sourceAttemptId !== 'string'
    || !SOURCE_ATTEMPT_ID.test(envelope.sourceAttemptId)
    || typeof envelope.attempt !== 'object' || envelope.attempt === null
    || Array.isArray(envelope.attempt)) {
    throw new Error('strategy attempt response fields are invalid');
  }
  const attempt = envelope.attempt as Record<string, unknown>;
  const expectedKeys = [
    'attemptId', 'graphHashHex', 'idempotencyKey', 'orderHashHex', 'quoteHashHex',
    'routeHashHex', 'selectedAtMs', 'sourceOrderHashHex', 'status',
  ];
  const keys = Object.keys(attempt).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
    || attempt.attemptId !== expectedAttemptId
    || typeof attempt.idempotencyKey !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(attempt.idempotencyKey)
    || attempt.status !== 'HYPERLIQUID_TESTNET_QUOTE_SELECTED'
    || !Number.isSafeInteger(attempt.selectedAtMs) || Number(attempt.selectedAtMs) <= 0) {
    throw new Error('strategy attempt identity is invalid');
  }
  for (const field of ['orderHashHex', 'graphHashHex', 'quoteHashHex', 'routeHashHex', 'sourceOrderHashHex'] as const) {
    if (typeof attempt[field] !== 'string' || !HASH.test(attempt[field])) {
      throw new Error('strategy attempt commitment is invalid');
    }
  }
  return Object.freeze({
    attempt: Object.freeze(attempt as unknown as StrategyAttemptMetadata),
    sourceAttemptId: envelope.sourceAttemptId,
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
    const source = await this.#sourceAttempts.resolve(metadata.sourceAttemptId);
    if (source === undefined) throw new Error('strategy source attempt was not found');
    const documents = await this.#packages.getByQuote(commitmentHash(metadata.attempt.quoteHashHex));
    if (documents === undefined
      || documents.orderHashHex !== metadata.attempt.orderHashHex
      || documents.graphHashHex !== metadata.attempt.graphHashHex
      || documents.quoteHashHex !== metadata.attempt.quoteHashHex
      || documents.routeHashHex !== metadata.attempt.routeHashHex
      || toHex(source.admission.orderHash) !== metadata.attempt.sourceOrderHashHex) {
      throw new Error('strategy attempt commitments do not match stored documents or source evidence');
    }
    const prepared = await this.#preparations.prepareDocuments(documents);
    if (!bytesEqual(prepared.orderHash, commitmentHash(metadata.attempt.orderHashHex))
      || !bytesEqual(prepared.graphHash, commitmentHash(metadata.attempt.graphHashHex))
      || !bytesEqual(prepared.quoteHash, commitmentHash(metadata.attempt.quoteHashHex))
      || !bytesEqual(prepared.routeHash, commitmentHash(metadata.attempt.routeHashHex))
      || prepared.domains.length !== 1 || prepared.domains[0]?.kind !== 'HYPERCORE_EXECUTOR') {
      throw new Error('prepared strategy execution does not match the selected attempt');
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
