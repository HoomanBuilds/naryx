import {
  bytesEqual,
  commitmentHash,
  fromProtocolJson,
  packageAllocation,
  packageAllocationHash,
  packageMatchingPolicy,
  packageMatchingPolicyHash,
  toHex,
  verifyPackageAllocation,
  type PackageAllocation,
  type PackageMatchingPolicy,
} from '@naryx/protocol-types';

const MAX_RESPONSE_CHARS = 1_048_576;
const CLASS_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const BASE_URL = /^(https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?)(\/[A-Za-z0-9._~\/-]*)?$/;

/** The minimal fetch surface the client needs, so any runtime or test double can supply it. */
export type FetchLike = (
  url: string,
  init: { readonly method: 'GET'; readonly headers: Readonly<Record<string, string>> },
) => Promise<{ readonly status: number; readonly headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface NaryxMarketClientOptions {
  /** HTTPS, or HTTP only on a loopback host. */
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
}

export class NaryxApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'NaryxApiError';
    this.status = status;
    this.code = code;
  }
}

export class NaryxEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NaryxEvidenceError';
  }
}

export interface PackageBookLevelView {
  readonly priceTicks: bigint;
  /** Resting signed package orders. */
  readonly directQuantity: bigint;
  /** Liquidity derived from leg sources; never merged into direct quantity. */
  readonly impliedQuantity: bigint;
}

export interface PackageBookSnapshot {
  readonly executionClassId: string;
  readonly matchingPolicyHash: string;
  readonly halted: boolean;
  readonly asOfValue: bigint;
  readonly bids: readonly PackageBookLevelView[];
  readonly asks: readonly PackageBookLevelView[];
}

export interface PackageTapeTrade {
  readonly cursor: number;
  readonly allocationHash: string;
  readonly takerSide: 'BID' | 'ASK';
  readonly recordedAtMs: number;
  readonly fills: readonly { readonly fillSequence: bigint; readonly priceTicks: bigint; readonly quantity: bigint; readonly makerSource: string }[];
}

export interface PackageTapePage {
  readonly executionClassId: string;
  readonly trades: readonly PackageTapeTrade[];
  readonly nextCursor: number;
}

export interface VerifiedAllocation {
  readonly allocation: PackageAllocation;
  readonly matchingPolicy: PackageMatchingPolicy;
  readonly allocationHash: string;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new NaryxEvidenceError(`${context} is not an object`);
  return value as Record<string, unknown>;
}

function list(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new NaryxEvidenceError(`${context} is not an array`);
  return value;
}

function big(value: unknown, context: string): bigint {
  if (typeof value !== 'bigint') throw new NaryxEvidenceError(`${context} is not an exact integer`);
  return value;
}

function count(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new NaryxEvidenceError(`${context} is not a count`);
  return value;
}

function levels(value: unknown, context: string): readonly PackageBookLevelView[] {
  return Object.freeze(
    list(value, context).map((entry, index) => {
      const level = record(entry, `${context}[${index}]`);
      return Object.freeze({
        priceTicks: big(level.priceTicks, `${context}[${index}].priceTicks`),
        directQuantity: big(level.directQuantity, `${context}[${index}].directQuantity`),
        impliedQuantity: big(level.impliedQuantity, `${context}[${index}].impliedQuantity`),
      });
    }),
  );
}

/**
 * Read-only client for the public market-data API. It holds no key, signs nothing, and trusts no
 * served evidence: allocations are re-hashed and re-verified locally against the served matching
 * policy, whose hash must equal the one the allocation binds.
 */
export class NaryxMarketClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(options: NaryxMarketClientOptions) {
    if (typeof options !== 'object' || options === null || typeof options.baseUrl !== 'string') {
      throw new TypeError('baseUrl is required');
    }
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (!BASE_URL.test(baseUrl)) throw new TypeError('baseUrl must be HTTPS, or HTTP on a loopback host');
    const supplied = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (typeof supplied !== 'function') throw new TypeError('no fetch implementation is available');
    this.#baseUrl = baseUrl;
    this.#fetch = supplied;
  }

  async #get(path: string): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, { method: 'GET', headers: { Accept: 'application/json' } });
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new NaryxEvidenceError('response is too large');
    if (!contentType.startsWith('application/json')) throw new NaryxEvidenceError('response is not JSON');
    let body: unknown;
    try {
      body = fromProtocolJson(JSON.parse(text));
    } catch {
      throw new NaryxEvidenceError('response is not valid protocol JSON');
    }
    if (response.status !== 200) {
      const error = record(record(body, 'error response').error, 'error');
      throw new NaryxApiError(response.status, String(error.code), String(error.message));
    }
    return body;
  }

  async getBook(executionClassId: string): Promise<PackageBookSnapshot> {
    if (!CLASS_ID.test(executionClassId)) throw new TypeError('invalid execution class id');
    const body = record(await this.#get(`/v1/market/books/${executionClassId}`), 'book');
    if (body.executionClassId !== executionClassId) throw new NaryxEvidenceError('book is for another execution class');
    if (typeof body.halted !== 'boolean' || typeof body.matchingPolicyHash !== 'string' || !HASH_HEX.test(body.matchingPolicyHash)) {
      throw new NaryxEvidenceError('book header is malformed');
    }
    return Object.freeze({
      executionClassId,
      matchingPolicyHash: body.matchingPolicyHash,
      halted: body.halted,
      asOfValue: big(body.asOfValue, 'book.asOfValue'),
      bids: levels(body.bids, 'book.bids'),
      asks: levels(body.asks, 'book.asks'),
    });
  }

  async getTape(executionClassId: string, page: { readonly after?: number; readonly limit?: number } = {}): Promise<PackageTapePage> {
    if (!CLASS_ID.test(executionClassId)) throw new TypeError('invalid execution class id');
    const after = page.after ?? 0;
    const limit = page.limit ?? 50;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('after must be a nonnegative cursor and limit between 1 and 100');
    }
    const body = record(await this.#get(`/v1/market/books/${executionClassId}/tape?after=${after}&limit=${limit}`), 'tape');
    if (body.executionClassId !== executionClassId) throw new NaryxEvidenceError('tape is for another execution class');
    let previous = after;
    const trades = list(body.trades, 'tape.trades').map((entry, index) => {
      const trade = record(entry, `tape.trades[${index}]`);
      const cursor = count(trade.cursor, `tape.trades[${index}].cursor`);
      if (cursor <= previous) throw new NaryxEvidenceError('tape cursors must strictly increase past the requested cursor');
      previous = cursor;
      if (typeof trade.allocationHash !== 'string' || !HASH_HEX.test(trade.allocationHash)) throw new NaryxEvidenceError('trade hash is malformed');
      if (trade.takerSide !== 'BID' && trade.takerSide !== 'ASK') throw new NaryxEvidenceError('trade side is malformed');
      return Object.freeze({
        cursor,
        allocationHash: trade.allocationHash,
        takerSide: trade.takerSide,
        recordedAtMs: count(trade.recordedAtMs, `tape.trades[${index}].recordedAtMs`),
        fills: Object.freeze(
          list(trade.fills, `tape.trades[${index}].fills`).map((value, fillIndex) => {
            const fill = record(value, `tape.trades[${index}].fills[${fillIndex}]`);
            if (typeof fill.makerSource !== 'string') throw new NaryxEvidenceError('fill source is malformed');
            return Object.freeze({
              fillSequence: big(fill.fillSequence, 'fill.fillSequence'),
              priceTicks: big(fill.priceTicks, 'fill.priceTicks'),
              quantity: big(fill.quantity, 'fill.quantity'),
              makerSource: fill.makerSource,
            });
          }),
        ),
      });
    });
    if (trades.length > limit) throw new NaryxEvidenceError('tape returned more trades than requested');
    const nextCursor = count(body.nextCursor, 'tape.nextCursor');
    if (nextCursor !== previous) throw new NaryxEvidenceError('tape cursor does not follow its last trade');
    return Object.freeze({ executionClassId, trades: Object.freeze(trades), nextCursor });
  }

  /** Fetches the allocation for an order the caller submitted and verifies it before returning it. */
  async getVerifiedAllocation(takerOrderId: string): Promise<VerifiedAllocation> {
    if (!HASH_HEX.test(takerOrderId)) throw new TypeError('taker order id must be 32 bytes of lowercase hex');
    const body = record(await this.#get(`/v1/market/allocations/${takerOrderId}`), 'allocation response');
    return verifyAllocationEvidence(takerOrderId, body.allocation, body.matchingPolicy);
  }
}

/**
 * Verifies served allocation evidence without trusting the server: the allocation must belong to
 * the expected order, bind the served policy by hash, and satisfy every matching invariant.
 */
export function verifyAllocationEvidence(takerOrderId: string, allocationInput: unknown, policyInput: unknown): VerifiedAllocation {
  let allocation: PackageAllocation;
  let policy: PackageMatchingPolicy;
  try {
    allocation = packageAllocation(allocationInput as PackageAllocation);
    policy = packageMatchingPolicy(policyInput as PackageMatchingPolicy);
  } catch (error) {
    throw new NaryxEvidenceError(`evidence is malformed: ${(error as Error).message}`);
  }
  if (!bytesEqual(allocation.takerOrderId, commitmentHash(takerOrderId))) throw new NaryxEvidenceError('allocation belongs to another order');
  if (!bytesEqual(packageMatchingPolicyHash(policy), allocation.matchingPolicyHash)) {
    throw new NaryxEvidenceError('served policy is not the policy the allocation binds');
  }
  try {
    verifyPackageAllocation(policy, allocation);
  } catch (error) {
    throw new NaryxEvidenceError(`allocation failed verification: ${(error as Error).message}`);
  }
  return Object.freeze({ allocation, matchingPolicy: policy, allocationHash: toHex(packageAllocationHash(allocation)) });
}
