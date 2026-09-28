import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { packageOrderHash, toProtocolJson, validatePackageOrderProfile } from '@naryx/protocol-types';
import type { Hash32, PackageOrder, ProtocolJsonValue } from '@naryx/protocol-types';
import {
  planAtomicEntryRoute,
  type AtomicRouteCandidateProvider,
  type AtomicRouteDecision,
} from './atomic-route-decision.js';
import {
  signAtomicEntryQuote,
  type AtomicEntryQuoteTerms,
  type Ed25519AtomicQuoteSigner,
} from './signed-atomic-entry-quote.js';
import {
  SolanaExecutionAuthorizationError,
  type SolanaExecutionAuthorizationPort,
} from './solana-execution-authorization.js';

const MAX_BODY_BYTES = 4_096;
const HASH_HEX = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export interface InternalAtomicQuoteRequest {
  readonly orderHash: string;
  readonly idempotencyKey: string;
}

export interface InternalAtomicQuoteResponse {
  readonly version: 1;
  readonly status: 'SIGNED';
  readonly idempotencyKey: string;
  readonly orderHash: string;
  readonly routeHash: string;
  readonly quoteHash: string;
  readonly solverSignatureDigest: string;
  readonly routeBytes: string;
  readonly solverQuoteBytes: string;
  readonly route: ProtocolJsonValue;
  readonly quote: ProtocolJsonValue;
}

export type InternalAtomicQuoteOrderProvider = (
  orderHash: Hash32,
) => PackageOrder | undefined | Promise<PackageOrder | undefined>;

export type InternalAtomicQuoteTermsProvider = (input: Readonly<{
  order: PackageOrder;
  decision: AtomicRouteDecision;
}>) => AtomicEntryQuoteTerms | Promise<AtomicEntryQuoteTerms>;

export interface InternalAtomicQuoteDependencies {
  readonly orders: InternalAtomicQuoteOrderProvider;
  readonly candidates: AtomicRouteCandidateProvider;
  readonly terms: InternalAtomicQuoteTermsProvider;
  readonly signer: Ed25519AtomicQuoteSigner;
  readonly store?: InternalAtomicQuoteStore;
}

export interface StoredInternalAtomicQuote {
  readonly orderHash: string;
  readonly response: InternalAtomicQuoteResponse;
}

export interface InternalAtomicQuoteStore {
  get(idempotencyKey: string): StoredInternalAtomicQuote | undefined;
  save(record: StoredInternalAtomicQuote): StoredInternalAtomicQuote;
}

export interface InternalAtomicQuotePort {
  quote(request: InternalAtomicQuoteRequest): Promise<InternalAtomicQuoteResponse>;
}

export class InternalAtomicQuoteError extends Error {
  readonly code: 'INVALID_REQUEST' | 'ORDER_NOT_FOUND' | 'ORDER_HASH_MISMATCH' | 'IDEMPOTENCY_CONFLICT';

  constructor(code: InternalAtomicQuoteError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'InternalAtomicQuoteError';
    this.code = code;
  }
}

export class InMemoryInternalAtomicQuoteStore implements InternalAtomicQuoteStore {
  readonly #records = new Map<string, StoredInternalAtomicQuote>();

  get(idempotencyKey: string): StoredInternalAtomicQuote | undefined {
    return this.#records.get(idempotencyKey);
  }

  save(record: StoredInternalAtomicQuote): StoredInternalAtomicQuote {
    const key = record.response.idempotencyKey;
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (existing.orderHash !== record.orderHash
        || JSON.stringify(existing.response) !== JSON.stringify(record.response)) {
        throw new InternalAtomicQuoteError(
          'IDEMPOTENCY_CONFLICT',
          'idempotencyKey is already bound to a different quote',
        );
      }
      return existing;
    }
    const stored = Object.freeze({ orderHash: record.orderHash, response: record.response });
    this.#records.set(key, stored);
    return stored;
  }
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function hashBytes(value: string): Hash32 {
  if (!HASH_HEX.test(value)) {
    throw new InternalAtomicQuoteError('INVALID_REQUEST', 'orderHash must be 32 lowercase hex bytes');
  }
  return Uint8Array.from(Buffer.from(value, 'hex')) as Hash32;
}

function parseRequest(value: unknown): InternalAtomicQuoteRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InternalAtomicQuoteError('INVALID_REQUEST', 'request must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'idempotencyKey' || keys[1] !== 'orderHash') {
    throw new InternalAtomicQuoteError(
      'INVALID_REQUEST',
      'request must contain only idempotencyKey and orderHash',
    );
  }
  if (typeof record.orderHash !== 'string' || !HASH_HEX.test(record.orderHash)) {
    throw new InternalAtomicQuoteError('INVALID_REQUEST', 'orderHash must be 32 lowercase hex bytes');
  }
  if (typeof record.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(record.idempotencyKey)) {
    throw new InternalAtomicQuoteError('INVALID_REQUEST', 'idempotencyKey is invalid');
  }
  return Object.freeze({ orderHash: record.orderHash, idempotencyKey: record.idempotencyKey });
}

export function createInternalAtomicQuoteCoordinator(
  dependencies: InternalAtomicQuoteDependencies,
): InternalAtomicQuotePort {
  const store = dependencies.store ?? new InMemoryInternalAtomicQuoteStore();
  const pending = new Map<string, Readonly<{
    orderHash: string;
    promise: Promise<InternalAtomicQuoteResponse>;
  }>>();

  return Object.freeze({
    async quote(rawRequest: InternalAtomicQuoteRequest): Promise<InternalAtomicQuoteResponse> {
      const request = parseRequest(rawRequest);
      const prior = store.get(request.idempotencyKey);
      if (prior !== undefined) {
        if (prior.orderHash !== request.orderHash) {
          throw new InternalAtomicQuoteError(
            'IDEMPOTENCY_CONFLICT',
            'idempotencyKey is already bound to a different order',
          );
        }
        return prior.response;
      }
      const active = pending.get(request.idempotencyKey);
      if (active !== undefined) {
        if (active.orderHash !== request.orderHash) {
          throw new InternalAtomicQuoteError(
            'IDEMPOTENCY_CONFLICT',
            'idempotencyKey is already bound to a different order',
          );
        }
        return active.promise;
      }

      const task = (async () => {
        const requestedHash = hashBytes(request.orderHash);
        const suppliedOrder = await dependencies.orders(requestedHash);
        if (suppliedOrder === undefined) {
          throw new InternalAtomicQuoteError('ORDER_NOT_FOUND', 'order was not found');
        }
        const order = validatePackageOrderProfile(suppliedOrder, 'packageOrder');
        const computedOrderHash = packageOrderHash(order);
        if (hex(computedOrderHash) !== request.orderHash) {
          throw new InternalAtomicQuoteError(
            'ORDER_HASH_MISMATCH',
            'stored order does not match the requested hash',
          );
        }
        const decision = planAtomicEntryRoute(
          { order, orderHash: computedOrderHash },
          dependencies.candidates,
        );
        const terms = await dependencies.terms({ order, decision });
        const signed = await signAtomicEntryQuote({
          order,
          decision,
          terms,
          signer: dependencies.signer,
        });
        return Object.freeze({
          version: 1 as const,
          status: 'SIGNED' as const,
          idempotencyKey: request.idempotencyKey,
          orderHash: request.orderHash,
          routeHash: hex(decision.routeHash),
          quoteHash: hex(signed.quoteHash),
          solverSignatureDigest: hex(signed.solverSignatureDigest),
          routeBytes: hex(decision.routeBytes),
          solverQuoteBytes: hex(signed.solverQuoteBytes),
          route: toProtocolJson(decision.route, 'route'),
          quote: toProtocolJson(signed.quote, 'quote'),
        });
      })();
      pending.set(request.idempotencyKey, { orderHash: request.orderHash, promise: task });
      try {
        const response = await task;
        return store.save({ orderHash: request.orderHash, response }).response;
      } finally {
        pending.delete(request.idempotencyKey);
      }
    },
  });
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === '::1') return true;
  const candidate = address?.startsWith('::ffff:') === true ? address.slice(7) : address;
  if (candidate === undefined) return false;
  const octets = candidate.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const number = Number(octet);
    return number >= 0 && number <= 255;
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(body));
}

function reject(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json') {
    throw new InternalAtomicQuoteError('INVALID_REQUEST', 'Content-Type must be application/json');
  }
  const statedLength = request.headers['content-length'];
  if (statedLength !== undefined
    && (!/^\d+$/.test(statedLength) || Number(statedLength) > MAX_BODY_BYTES)) {
    throw new InternalAtomicQuoteError('INVALID_REQUEST', 'request body is too large');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) {
      throw new InternalAtomicQuoteError('INVALID_REQUEST', 'request body is too large');
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new InternalAtomicQuoteError('INVALID_REQUEST', 'request body must contain valid JSON');
  }
}

export function createInternalAtomicQuoteRequestHandler(
  port: InternalAtomicQuotePort,
  authorization?: SolanaExecutionAuthorizationPort,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      reject(response, 403, 'LOOPBACK_REQUIRED', 'internal quote access is loopback-only');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    if (url.pathname === '/internal/solana/execution-authorizations' && url.search === '') {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        reject(response, 405, 'METHOD_NOT_ALLOWED', 'only POST is allowed');
        return;
      }
      if (authorization === undefined) {
        reject(response, 503, 'AUTHORIZATION_UNAVAILABLE', 'Solana execution authorization is unavailable');
        return;
      }
      try {
        const value = await readJson(request);
        sendJson(response, 200, await authorization.authorize(value as { attemptId: string }));
      } catch (error) {
        if (error instanceof SolanaExecutionAuthorizationError) {
          const status = error.code === 'ATTEMPT_NOT_FOUND' ? 404
            : error.code === 'NONCE_REPLAY' ? 409 : 400;
          reject(response, status, error.code, error.message);
          return;
        }
        reject(response, 502, 'AUTHORIZATION_FAILED', 'Solana execution authorization failed closed');
      }
      return;
    }
    if (url.pathname !== '/internal/quotes/atomic-entry' || url.search !== '') {
      reject(response, 404, 'NOT_FOUND', 'internal route was not found');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      reject(response, 405, 'METHOD_NOT_ALLOWED', 'only POST is allowed');
      return;
    }
    try {
      const parsed = parseRequest(await readJson(request));
      sendJson(response, 200, await port.quote(parsed));
    } catch (error) {
      if (error instanceof InternalAtomicQuoteError) {
        const status = error.code === 'ORDER_NOT_FOUND'
          ? 404
          : error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400;
        reject(response, status, error.code, error.message);
        return;
      }
      reject(response, 502, 'QUOTE_FAILED', 'atomic entry quote failed closed');
    }
  };
}

export function createInternalAtomicQuoteServer(
  port: InternalAtomicQuotePort,
  authorization?: SolanaExecutionAuthorizationPort,
) {
  return createServer(createInternalAtomicQuoteRequestHandler(port, authorization));
}
