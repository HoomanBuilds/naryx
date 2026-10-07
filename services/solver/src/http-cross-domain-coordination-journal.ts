import {
  crossDomainPlanHash,
  fromProtocolJson,
  replayCrossDomainCoordination,
  stringifyProtocolJson,
  toHex,
  type CrossDomainEvent,
  type CrossDomainPlanInput,
} from '@naryx/protocol-types';
import type {
  CrossDomainCoordinationJournal,
  CrossDomainCoordinationSnapshot,
} from './cross-domain-execution-coordinator.js';

const MAX_RESPONSE_BYTES = 1_048_576;

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('coordination endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('coordination endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}

async function boundedProtocolJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json' || response.body === null) throw new Error('coordination response must be JSON');
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > MAX_RESPONSE_BYTES)) {
    throw new Error('coordination response is too large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('coordination response is too large');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return fromProtocolJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    throw new Error('coordination response is malformed');
  }
}

export class HttpCrossDomainCoordinationJournal implements CrossDomainCoordinationJournal {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #clockMs: () => number;

  constructor(origin: string, options: Readonly<{ fetch?: typeof fetch; clockMs?: () => number }> = {}) {
    this.#origin = loopbackOrigin(origin);
    this.#fetch = options.fetch ?? fetch;
    this.#clockMs = options.clockMs ?? Date.now;
  }

  async registerPlan(plan: CrossDomainPlanInput): Promise<void> {
    const expectedHash = toHex(crossDomainPlanHash(plan));
    const body = record(await this.#request('POST', '/internal/coordination/plans', { plan }), 'plan registration');
    if (body.planHash !== expectedHash || typeof body.created !== 'boolean') {
      throw new Error('coordination plan registration response is invalid');
    }
  }

  async snapshot(planHash: string): Promise<CrossDomainCoordinationSnapshot> {
    if (!/^[0-9a-f]{64}$/.test(planHash)) throw new Error('coordination plan hash must be lowercase hex');
    const body = record(await this.#request('GET', `/v1/coordinations/${planHash}`), 'coordination snapshot');
    if (body.planHash !== planHash || !Array.isArray(body.events)) throw new Error('coordination snapshot identity is invalid');
    const plan = body.plan as CrossDomainPlanInput;
    const events = Object.freeze(body.events as CrossDomainEvent[]);
    if (toHex(crossDomainPlanHash(plan)) !== planHash) throw new Error('coordination snapshot plan hash is invalid');
    const latest = events.reduce((maximum, event) => event.atValue > maximum ? event.atValue : maximum, 0n);
    const clockMs = this.#clockMs();
    if (!Number.isSafeInteger(clockMs) || clockMs < 0) throw new Error('coordination clock is invalid');
    const now = plan.timeUnit === 'EVM_UNIX_SECONDS'
      ? BigInt(Math.floor(clockMs / 1_000))
      : plan.timeUnit === 'HYPERLIQUID_UNIX_MILLISECONDS'
        ? BigInt(clockMs)
        : latest;
    return Object.freeze({ plan, events, state: replayCrossDomainCoordination(plan, events, now) });
  }

  async appendEvent(planHash: string, event: CrossDomainEvent): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(planHash)) throw new Error('coordination plan hash must be lowercase hex');
    const body = record(await this.#request('POST', '/internal/coordination/events', { planHash, event }), 'event append');
    if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) <= 0) {
      throw new Error('coordination event response is invalid');
    }
  }

  async #request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const response = await this.#fetch(`${this.#origin}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
      ...(body === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: stringifyProtocolJson(body),
      }),
    });
    if (!response.ok) throw new Error(`coordination request failed with HTTP ${response.status}`);
    return boundedProtocolJson(response);
  }
}
