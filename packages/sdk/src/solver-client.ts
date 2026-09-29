import {
  encodeUtf8,
  fromProtocolJson,
  packageOrderHash,
  solverRequestDigest,
  toHex,
  toProtocolJson,
  validatePackageOrderProfile,
  type AssetRef,
  type DomainRef,
  type ImpliedPackageQuoteInput,
  type PackageOrder,
  type PackageOrderInput,
  type RoutePayloadInput,
  type SolverQuoteInput,
  type PackageQuoteShardInput,
  type SolverCapabilityManifestInput,
  type SolverCapacityCommitmentInput,
  type SolverCapacityRecordInput,
  type SolverRequestMethod,
} from '@naryx/protocol-types';
import { NaryxApiError, NaryxEvidenceError, type FetchLike } from './client.js';

const BASE_URL = /^(https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?)(\/[A-Za-z0-9._~\/-]*)?$/;
const MAX_RESPONSE_CHARS = 1_048_576;

type WebCrypto = { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> }; getRandomValues<T extends Uint8Array>(array: T): T };

function webCrypto(): WebCrypto {
  const crypto = (globalThis as { crypto?: WebCrypto }).crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') throw new TypeError('Web Crypto is required');
  return crypto;
}

export interface OpenOrderPage {
  readonly orders: readonly { readonly cursor: number; readonly orderHash: string; readonly order: PackageOrder; readonly receivedAtMs: number }[];
  /** Pass back as `after` to continue; unchanged when the page is empty. */
  readonly nextCursor: number;
}

export interface NaryxSolverClientOptions {
  readonly baseUrl: string;
  readonly solverId: string;
  /** The registered quote key id whose private half `sign` uses. */
  readonly keyId: string;
  /**
   * Signs a 32-byte digest with the solver's Ed25519 quote key and returns the 64-byte signature.
   * The key never enters this client; an HSM, a signing service, or a local key can back it.
   */
  readonly sign: (digest: Uint8Array) => Promise<Uint8Array>;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

/**
 * Authenticated client for the solver API. Every request is signed over `solverRequestDigest`
 * with a fresh random nonce and the current time, so the server can reject replays, redirects,
 * and altered bodies. Shard and manifest contents carry their own signatures, which the caller
 * produces the same way.
 */
export class NaryxSolverClient {
  readonly #options: NaryxSolverClientOptions;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(options: NaryxSolverClientOptions) {
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (!BASE_URL.test(baseUrl)) throw new TypeError('baseUrl must be HTTPS, or HTTP on a loopback host');
    if (typeof options.sign !== 'function') throw new TypeError('a signer is required');
    const supplied = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (typeof supplied !== 'function') throw new TypeError('no fetch implementation is available');
    this.#options = options;
    this.#baseUrl = baseUrl;
    this.#fetch = supplied;
  }

  async #call(method: SolverRequestMethod, path: string, body?: unknown, authenticate = true): Promise<Record<string, unknown>> {
    const text = body === undefined ? '' : JSON.stringify(toProtocolJson(body));
    const bytes = encodeUtf8(text);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (text !== '') headers['Content-Type'] = 'application/json';
    if (authenticate) {
      const crypto = webCrypto();
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const timestampMs = BigInt(Math.floor((this.#options.now ?? Date.now)()));
      const bodySha256 = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const digest = solverRequestDigest({ method, pathAndQuery: path, bodySha256, solverId: this.#options.solverId, keyId: this.#options.keyId, timestampMs, nonce });
      const signature = await this.#options.sign(digest);
      if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new TypeError('the signer must return a 64-byte signature');
      headers['X-Naryx-Solver'] = this.#options.solverId;
      headers['X-Naryx-Key'] = this.#options.keyId;
      headers['X-Naryx-Timestamp'] = timestampMs.toString();
      headers['X-Naryx-Nonce'] = nonce;
      headers['X-Naryx-Signature'] = toHex(signature);
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, { method, headers, ...(text === '' ? {} : { body: text }) });
    const payload = await response.text();
    if (payload.length > MAX_RESPONSE_CHARS) throw new NaryxEvidenceError('response is too large');
    let parsed: unknown;
    try {
      parsed = fromProtocolJson(JSON.parse(payload));
    } catch {
      throw new NaryxEvidenceError('response is not valid protocol JSON');
    }
    if (typeof parsed !== 'object' || parsed === null) throw new NaryxEvidenceError('response is not an object');
    const result = parsed as Record<string, unknown>;
    if (response.status !== 200) {
      const error = (result.error ?? {}) as Record<string, unknown>;
      throw new NaryxApiError(response.status, String(error.code), String(error.message));
    }
    return result;
  }

  /** The template id may not contain a dot, so the first dot always splits the two parts. */
  static shardId(shard: Pick<PackageQuoteShardInput, 'templateId' | 'marketGroupId'>): string {
    if (shard.templateId.includes('.')) throw new Error('A quoted template id may not contain a dot.');
    return `${shard.templateId}.${shard.marketGroupId}`;
  }

  /** Registration is authenticated by the operator signature inside the manifest. */
  registerManifest(manifest: SolverCapabilityManifestInput) {
    return this.#call('PUT', '/v1/solver/capability-manifest', { manifest }, false);
  }

  getShard(shardId: string) {
    return this.#call('GET', `/v1/solver/quote-shards/${shardId}`);
  }

  putShard(shard: PackageQuoteShardInput) {
    return this.#call('PUT', `/v1/solver/quote-shards/${NaryxSolverClient.shardId(shard)}`, { shard });
  }

  replaceShard(shard: PackageQuoteShardInput) {
    return this.#call('POST', `/v1/solver/quote-shards/${NaryxSolverClient.shardId(shard)}/replace`, { shard });
  }

  heartbeat(shard: PackageQuoteShardInput) {
    return this.#call('POST', `/v1/solver/quote-shards/${NaryxSolverClient.shardId(shard)}/heartbeat`, { shard });
  }

  cancelAll(shard: PackageQuoteShardInput) {
    return this.#call('POST', `/v1/solver/quote-shards/${NaryxSolverClient.shardId(shard)}/cancel-all`, { shard });
  }

  killSwitch(shard: PackageQuoteShardInput) {
    return this.#call('POST', '/v1/solver/kill-switch', { shardId: NaryxSolverClient.shardId(shard), shard });
  }

  putCapacity(record: SolverCapacityRecordInput) {
    return this.#call('PUT', '/v1/solver/capacity', { record });
  }

  reserve(scope: { readonly domain: DomainRef; readonly asset: AssetRef }, commitment: SolverCapacityCommitmentInput) {
    return this.#call('POST', '/v1/solver/reservations', { ...scope, commitment });
  }

  release(scope: { readonly domain: DomainRef; readonly asset: AssetRef }, commitmentId: string) {
    return this.#call('POST', '/v1/solver/reservations/release', { ...scope, commitmentId });
  }

  /** Posts implied liquidity; the server derives the quote from its sources and binds this solver. */
  postQuote(packageMarketId: string, quote: ImpliedPackageQuoteInput, expiresAtValue?: bigint) {
    return this.#call('POST', '/v1/solver/quotes', { packageMarketId, quote, ...(expiresAtValue === undefined ? {} : { expiresAtValue }) });
  }

  /**
   * Posts up to 16 implied quotes to one book atomically: each is derived from its sources and must
   * be backed by distinct outstanding commitments, or none is posted.
   */
  postQuotes(packageMarketId: string, quotes: readonly { readonly quote: ImpliedPackageQuoteInput; readonly expiresAtValue: bigint }[]) {
    if (!Array.isArray(quotes) || quotes.length === 0 || quotes.length > 16) throw new TypeError('post 1 to 16 quotes');
    return this.#call('POST', '/v1/solver/quotes/batch', { packageMarketId, quotes });
  }

  /**
   * Answers a public order with a quote this solver signed over `solverSignatureDigest`, and the
   * exact route the quote binds. Outside production a reserved quote must be FIRM_SIMULATED.
   */
  postOrderQuote(quote: SolverQuoteInput, route: RoutePayloadInput) {
    return this.#call('POST', '/v1/solver/order-quotes', { quote, route });
  }

  /** This solver's settled receipts for one of its quotes. */
  async settlements(quoteHash: string) {
    if (!/^[0-9a-f]{64}$/.test(quoteHash)) throw new TypeError('quote hash must be 32 bytes of lowercase hex');
    const body = await this.#call('GET', `/v1/solver/settlements/${quoteHash}`);
    if (body.quoteHash !== quoteHash || !Array.isArray(body.settlements)) throw new NaryxEvidenceError('settlement response is for another quote');
    return body;
  }

  /**
   * Envelopes addressed to this solver that are neither acknowledged nor expired. Each carries the
   * sender key's Ed25519 signature over the envelope hash; the relay has checked it, and a solver
   * can check it again against the base58 key in `senderKeyId` before decrypting.
   */
  pendingPrivateRfqs() {
    return this.#call('GET', '/v1/solver/private-rfqs');
  }

  acknowledgePrivateRfq(envelopeHash: string) {
    return this.#call('POST', `/v1/solver/private-rfqs/${envelopeHash}/ack`);
  }

  /** The quote must be encrypted to the envelope's response key; the relay verifies the binding, not the content. */
  respondPrivateRfq(envelopeHash: string, response: { readonly quoteHash: string; readonly quoteOrderHash: string; readonly responseEncryptionKey: Uint8Array; readonly responseCiphertext: Uint8Array }) {
    return this.#call('POST', `/v1/solver/private-rfqs/${envelopeHash}/response`, response);
  }

  commitSealedQuote(auctionHash: string, commitment: string) {
    return this.#call('POST', `/v1/solver/auctions/${auctionHash}/commit`, { commitment });
  }

  revealSealedQuote(auctionHash: string, opening: { readonly quoteHash: string; readonly netOutcomeAtoms: bigint; readonly salt: Uint8Array }) {
    return this.#call('POST', `/v1/solver/auctions/${auctionHash}/reveal`, opening);
  }

  /**
   * Signed public orders without a terminal outcome, oldest first. Every order is validated and
   * re-hashed locally, so a solver never quotes an order whose served hash it has not checked.
   */
  async pollOrders(after = 0): Promise<OpenOrderPage> {
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('after must be a nonnegative cursor');
    const body = await this.#call('GET', `/v1/solver/orders?after=${after}`);
    if (!Array.isArray(body.orders)) throw new NaryxEvidenceError('orders is not an array');
    let previous = after;
    const orders = body.orders.map((entry: unknown, index: number) => {
      const served = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
      const cursor = served.cursor;
      if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor <= previous) throw new NaryxEvidenceError('order cursors must strictly increase past the requested cursor');
      previous = cursor;
      let order: PackageOrder;
      try {
        order = validatePackageOrderProfile(served.order as PackageOrderInput);
      } catch {
        throw new NaryxEvidenceError(`orders[${index}] failed validation`);
      }
      const orderHash = toHex(packageOrderHash(order));
      if (served.orderHash !== orderHash) throw new NaryxEvidenceError(`orders[${index}] does not hash to its served hash`);
      const receivedAtMs = served.receivedAtMs;
      if (typeof receivedAtMs !== 'number' || !Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) throw new NaryxEvidenceError(`orders[${index}] has no receipt time`);
      return Object.freeze({ cursor, orderHash, order, receivedAtMs });
    });
    if (body.nextCursor !== previous) throw new NaryxEvidenceError('the next cursor does not follow the last order');
    return Object.freeze({ orders: Object.freeze(orders), nextCursor: previous });
  }

  cancelQuote(packageMarketId: string, entryId: string) {
    return this.#call('POST', '/v1/solver/quotes/cancel', { packageMarketId, entryId });
  }
}
