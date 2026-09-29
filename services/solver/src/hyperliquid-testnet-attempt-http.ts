import { parseProtocolJson } from '@naryx/protocol-types';
import {
  validateHyperliquidTestnetRuntimeAttempt,
  type HyperliquidTestnetTrustedAttemptProvider,
} from './hyperliquid-testnet-executor-http.js';

export const API_HYPERLIQUID_TESTNET_ATTEMPT_PATH =
  '/internal/solver/hyperliquid-testnet/attempts/';

const ATTEMPT_ID = /^[A-Za-z0-9_-]{16,64}$/;
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

export class HttpHyperliquidTestnetTrustedAttemptProvider
implements HyperliquidTestnetTrustedAttemptProvider {
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HyperliquidTestnetAttemptHttpOptions) {
    this.#origin = loopbackOrigin(options.apiOrigin);
    this.#timeoutMs = timeout(options.timeoutMs);
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async resolve(attemptId: string) {
    if (!ATTEMPT_ID.test(attemptId)) throw new Error('attempt ID is invalid');
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#origin}${API_HYPERLIQUID_TESTNET_ATTEMPT_PATH}${attemptId}`,
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
