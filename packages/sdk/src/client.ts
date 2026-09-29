import {
  aggregateCandles,
  bytesEqual,
  CANDLE_INTERVAL_MS,
  commitmentHash,
  fromProtocolJson,
  packageAllocation,
  packageAllocationHash,
  packageMatchingPolicy,
  packageMatchingPolicyHash,
  packageOrderHash,
  ProtocolError,
  replayRouteDecision,
  toHex,
  toProtocolJson,
  validatePackageOrderProfile,
  verifyPackageAllocation,
  verifySealedAuctionResult,
  type CandleInterval,
  type CandleSeries,
  type ExecutablePackageIndex,
  type PackageAllocation,
  type PackageMatchingPolicy,
  type PackageOrderInput,
  type PackageTakerOrderInput,
  type PrivateRfqEnvelopeInput,
  type SealedAuctionDefinitionInput,
  type SealedAuctionEvent,
  type RfqDecision,
  type RfqRequest,
  type RfqResponse,
  type RfqSolverCapacity,
  type RouteDecisionInput,
  type RouteDecisionReplay,
} from '@naryx/protocol-types';

const MAX_RESPONSE_CHARS = 2_097_152;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const BASE_URL = /^(https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?)(\/[A-Za-z0-9._~\/-]*)?$/;

/** The minimal fetch surface the client needs, so any runtime or test double can supply it. */
export type FetchLike = (
  url: string,
  init: { readonly method: 'GET' | 'POST' | 'PUT'; readonly headers: Readonly<Record<string, string>>; readonly body?: string },
) => Promise<{ readonly status: number; readonly headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface NaryxClientOptions {
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

export interface PackageDepth {
  readonly packageMarketId: string;
  readonly matchingPolicyHash: string;
  readonly halted: boolean;
  readonly asOfValue: bigint;
  readonly bids: readonly PackageBookLevelView[];
  readonly asks: readonly PackageBookLevelView[];
}

export interface PackageMarketSummary {
  readonly packageMarketId: string;
  readonly halted: boolean;
  readonly matchingPolicyHash: string;
  readonly bestBidTicks?: bigint;
  readonly bestAskTicks?: bigint;
  readonly spreadTicks?: bigint;
  readonly label: 'EXECUTABLE';
}

export interface PackageTapeTrade {
  readonly cursor: number;
  readonly allocationHash: string;
  readonly takerSide: 'BID' | 'ASK';
  readonly recordedAtMs: number;
  readonly fills: readonly { readonly fillSequence: bigint; readonly priceTicks: bigint; readonly quantity: bigint; readonly makerSource: string }[];
}

export interface PackageTapePage {
  readonly packageMarketId: string;
  readonly trades: readonly PackageTapeTrade[];
  readonly nextCursor: number;
}

export interface CandlePage extends CandleSeries {
  readonly packageMarketId: string;
  readonly fromMs: number;
  readonly toMs: number;
  /** True when the server hit its trade cap; narrow the window for a complete series. */
  readonly truncated: boolean;
}

export interface VerifiedAllocation {
  readonly allocation: PackageAllocation;
  readonly matchingPolicy: PackageMatchingPolicy;
  readonly allocationHash: string;
}

export interface RegisteredDocumentView<T = unknown> {
  readonly kind: string;
  readonly subjectId: string;
  readonly subjectVersion: number;
  readonly environment: string;
  readonly documentHashHex: string;
  readonly registeredAtMs: number;
  readonly document: T;
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

function optionalBig(value: unknown, context: string): bigint | undefined {
  return value === undefined ? undefined : big(value, context);
}

function count(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new NaryxEvidenceError(`${context} is not a count`);
  return value;
}

function hashHex(value: unknown, context: string): string {
  if (typeof value !== 'string' || !HASH_HEX.test(value)) throw new NaryxEvidenceError(`${context} is not a 32-byte hash`);
  return value;
}

function checkId(value: string, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`invalid ${name}`);
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

function documents<T>(value: unknown, context: string): readonly RegisteredDocumentView<T>[] {
  return Object.freeze(
    list(value, context).map((entry, index) => {
      const document = record(entry, `${context}[${index}]`);
      if (typeof document.subjectId !== 'string' || typeof document.kind !== 'string') throw new NaryxEvidenceError(`${context}[${index}] is malformed`);
      hashHex(document.documentHashHex, `${context}[${index}].documentHashHex`);
      return document as unknown as RegisteredDocumentView<T>;
    }),
  );
}

/**
 * Client for the public Naryx v1 API. It holds no key and signs nothing. It never trusts served
 * evidence it can check: allocations are re-hashed and re-verified against the policy they bind,
 * order validation and route-decision replay are recomputed locally and must agree with the
 * server, and candle series are rebuilt from the tape on request.
 */
export class NaryxClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(options: NaryxClientOptions) {
    if (typeof options !== 'object' || options === null || typeof options.baseUrl !== 'string') throw new TypeError('baseUrl is required');
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (!BASE_URL.test(baseUrl)) throw new TypeError('baseUrl must be HTTPS, or HTTP on a loopback host');
    const supplied = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (typeof supplied !== 'function') throw new TypeError('no fetch implementation is available');
    this.#baseUrl = baseUrl;
    this.#fetch = supplied;
  }

  async #request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const init = body === undefined
      ? { method, headers: { Accept: 'application/json' } }
      : { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(toProtocolJson(body)) };
    const response = await this.#fetch(`${this.#baseUrl}${path}`, init);
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new NaryxEvidenceError('response is too large');
    if (!contentType.startsWith('application/json')) throw new NaryxEvidenceError('response is not JSON');
    let parsed: unknown;
    try {
      parsed = fromProtocolJson(JSON.parse(text));
    } catch {
      throw new NaryxEvidenceError('response is not valid protocol JSON');
    }
    if (response.status !== 200) {
      const error = record(record(parsed, 'error response').error, 'error');
      throw new NaryxApiError(response.status, String(error.code), String(error.message));
    }
    return parsed;
  }

  // ---------------------------------------------------------------- registries

  async listDomains(): Promise<readonly RegisteredDocumentView[]> {
    return documents(record(await this.#request('GET', '/v1/domains'), 'domains').domains, 'domains');
  }

  async listInstruments(): Promise<readonly RegisteredDocumentView[]> {
    return documents(record(await this.#request('GET', '/v1/instruments'), 'instruments').instruments, 'instruments');
  }

  async listPackageTemplates(): Promise<readonly RegisteredDocumentView[]> {
    return documents(record(await this.#request('GET', '/v1/package-templates'), 'templates').templates, 'templates');
  }

  async getPackageTemplate(templateId: string, templateVersion: number): Promise<RegisteredDocumentView> {
    if (!Number.isSafeInteger(templateVersion) || templateVersion < 1) throw new TypeError('invalid template version');
    const [document] = documents([await this.#request('GET', `/v1/package-templates/${checkId(templateId, 'template id')}/${templateVersion}`)], 'template');
    return document as RegisteredDocumentView;
  }

  async listSolvers(): Promise<readonly Record<string, unknown>[]> {
    return list(record(await this.#request('GET', '/v1/solvers'), 'solvers').solvers, 'solvers').map((entry, index) => record(entry, `solvers[${index}]`));
  }

  async getSolver(solverId: string): Promise<Record<string, unknown>> {
    const solver = record(await this.#request('GET', `/v1/solvers/${checkId(solverId, 'solver id')}`), 'solver');
    if (solver.solverId !== solverId) throw new NaryxEvidenceError('solver response is for another solver');
    hashHex(solver.manifestHash, 'solver.manifestHash');
    return solver;
  }

  async listStrategySeries(): Promise<readonly Record<string, unknown>[]> {
    return list(record(await this.#request('GET', '/v1/strategy-series'), 'series').series, 'series').map((entry, index) => record(entry, `series[${index}]`));
  }

  async listExecutionClasses(seriesId: string): Promise<readonly Record<string, unknown>[]> {
    const body = record(await this.#request('GET', `/v1/strategy-series/${checkId(seriesId, 'series id')}/execution-classes`), 'execution classes');
    return list(body.executionClasses, 'executionClasses').map((entry, index) => {
      const executionClass = record(entry, `executionClasses[${index}]`);
      if (executionClass.seriesId !== seriesId) throw new NaryxEvidenceError('an execution class belongs to another series');
      return executionClass;
    });
  }

  // ---------------------------------------------------------------- package markets

  async listMarkets(): Promise<readonly PackageMarketSummary[]> {
    const body = record(await this.#request('GET', '/v1/markets'), 'markets');
    return Object.freeze(
      list(body.markets, 'markets').map((entry, index) => {
        const market = record(entry, `markets[${index}]`);
        if (typeof market.packageMarketId !== 'string' || typeof market.halted !== 'boolean' || market.label !== 'EXECUTABLE') {
          throw new NaryxEvidenceError(`markets[${index}] is malformed`);
        }
        const bestBidTicks = optionalBig(market.bestBidTicks, 'bestBidTicks');
        const bestAskTicks = optionalBig(market.bestAskTicks, 'bestAskTicks');
        if (bestBidTicks !== undefined && bestAskTicks !== undefined && bestBidTicks >= bestAskTicks) {
          throw new NaryxEvidenceError(`markets[${index}] reports a crossed executable book`);
        }
        const spreadTicks = optionalBig(market.spreadTicks, 'spreadTicks');
        return Object.freeze({
          packageMarketId: market.packageMarketId,
          halted: market.halted,
          matchingPolicyHash: hashHex(market.matchingPolicyHash, 'matchingPolicyHash'),
          label: 'EXECUTABLE' as const,
          ...(bestBidTicks === undefined ? {} : { bestBidTicks }),
          ...(bestAskTicks === undefined ? {} : { bestAskTicks }),
          ...(spreadTicks === undefined ? {} : { spreadTicks }),
        });
      }),
    );
  }

  async getDepth(packageMarketId: string): Promise<PackageDepth> {
    checkId(packageMarketId, 'package market id');
    const body = record(await this.#request('GET', `/v1/markets/${packageMarketId}/package-depth`), 'depth');
    if (body.packageMarketId !== packageMarketId) throw new NaryxEvidenceError('depth is for another market');
    if (typeof body.halted !== 'boolean') throw new NaryxEvidenceError('depth header is malformed');
    return Object.freeze({
      packageMarketId,
      matchingPolicyHash: hashHex(body.matchingPolicyHash, 'matchingPolicyHash'),
      halted: body.halted,
      asOfValue: big(body.asOfValue, 'asOfValue'),
      bids: levels(body.bids, 'bids'),
      asks: levels(body.asks, 'asks'),
    });
  }

  async getTape(packageMarketId: string, page: { readonly after?: number; readonly limit?: number } = {}): Promise<PackageTapePage> {
    checkId(packageMarketId, 'package market id');
    const after = page.after ?? 0;
    const limit = page.limit ?? 50;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('after must be a nonnegative cursor and limit between 1 and 100');
    }
    const body = record(await this.#request('GET', `/v1/markets/${packageMarketId}/package-tape?after=${after}&limit=${limit}`), 'tape');
    if (body.packageMarketId !== packageMarketId) throw new NaryxEvidenceError('tape is for another market');
    let previous = after;
    const trades = list(body.trades, 'tape.trades').map((entry, index) => {
      const trade = record(entry, `tape.trades[${index}]`);
      const cursor = count(trade.cursor, `tape.trades[${index}].cursor`);
      if (cursor <= previous) throw new NaryxEvidenceError('tape cursors must strictly increase past the requested cursor');
      previous = cursor;
      if (trade.takerSide !== 'BID' && trade.takerSide !== 'ASK') throw new NaryxEvidenceError('trade side is malformed');
      return Object.freeze({
        cursor,
        allocationHash: hashHex(trade.allocationHash, 'trade.allocationHash'),
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
    return Object.freeze({ packageMarketId, trades: Object.freeze(trades), nextCursor });
  }

  async getCandles(packageMarketId: string, query: { readonly interval: CandleInterval; readonly fromMs?: number; readonly toMs?: number }): Promise<CandlePage> {
    checkId(packageMarketId, 'package market id');
    if (!Object.hasOwn(CANDLE_INTERVAL_MS, query.interval)) throw new TypeError('unknown candle interval');
    const params = [`interval=${query.interval}`];
    for (const [name, value] of [['from', query.fromMs], ['to', query.toMs]] as const) {
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be nonnegative milliseconds`);
      params.push(`${name}=${value}`);
    }
    const body = record(await this.#request('GET', `/v1/markets/${packageMarketId}/candles?${params.join('&')}`), 'candles');
    if (body.packageMarketId !== packageMarketId || body.interval !== query.interval) throw new NaryxEvidenceError('candles are for another market or interval');
    if (body.label !== 'OBSERVED') throw new NaryxEvidenceError('public candles must be labeled OBSERVED');
    let previousOpen = -1;
    const candles = list(body.candles, 'candles').map((entry, index) => {
      const candle = record(entry, `candles[${index}]`);
      const openTimeMs = count(candle.openTimeMs, 'openTimeMs');
      if (openTimeMs <= previousOpen || openTimeMs % CANDLE_INTERVAL_MS[query.interval] !== 0) throw new NaryxEvidenceError('candles are unordered or misaligned');
      previousOpen = openTimeMs;
      const open = big(candle.open, 'open');
      const high = big(candle.high, 'high');
      const low = big(candle.low, 'low');
      const close = big(candle.close, 'close');
      if (high < open || high < close || low > open || low > close) throw new NaryxEvidenceError('candle range does not contain open and close');
      return Object.freeze({ openTimeMs, open, high, low, close, volume: big(candle.volume, 'volume'), tradeCount: count(candle.tradeCount, 'tradeCount') });
    });
    return Object.freeze({
      packageMarketId,
      label: 'OBSERVED' as const,
      interval: query.interval,
      methodologyVersion: count(body.methodologyVersion, 'methodologyVersion'),
      fromMs: count(body.fromMs, 'fromMs'),
      toMs: count(body.toMs, 'toMs'),
      truncated: body.truncated === true,
      candles: Object.freeze(candles),
    });
  }

  async getIndex(packageMarketId: string, sizes: readonly bigint[]): Promise<ExecutablePackageIndex & { readonly asOfValue: bigint }> {
    checkId(packageMarketId, 'package market id');
    if (sizes.length === 0 || sizes.length > 16 || sizes.some((size) => typeof size !== 'bigint' || size <= 0n)) throw new TypeError('sizes must be 1 to 16 positive integers');
    const body = record(await this.#request('GET', `/v1/markets/${packageMarketId}/index?sizes=${sizes.join(',')}`), 'index');
    const executable = record(body.executable, 'index.executable');
    for (const side of ['bids', 'asks'] as const) {
      for (const quote of list(executable[side], `index.executable.${side}`)) {
        if (record(quote, 'quote').label !== 'EXECUTABLE') throw new NaryxEvidenceError('executable index entries must be labeled EXECUTABLE');
      }
    }
    return body as unknown as ExecutablePackageIndex & { readonly asOfValue: bigint };
  }

  /** Live solver shard quotes for a market, each with its quote mode and settlement class. */
  async getMarketQuotes(packageMarketId: string): Promise<readonly Record<string, unknown>[]> {
    checkId(packageMarketId, 'package market id');
    const body = record(await this.#request('GET', `/v1/markets/${packageMarketId}/quotes`), 'quotes');
    const modes = new Set(['IMPLIED', 'EXECUTION_COMMITMENT', 'FIRM_SIMULATED', 'FIRM_ONCHAIN']);
    return list(body.quotes, 'quotes').map((entry, index) => {
      const quote = record(entry, `quotes[${index}]`);
      if (typeof quote.quoteMode !== 'string' || !modes.has(quote.quoteMode)) throw new NaryxEvidenceError('every quote must carry a known quote mode');
      return quote;
    });
  }

  async getSolverCapacity(solverId: string): Promise<Record<string, unknown>> {
    const body = record(await this.#request('GET', `/v1/solvers/${checkId(solverId, 'solver id')}/capacity`), 'capacity');
    if (body.solverId !== solverId) throw new NaryxEvidenceError('capacity is for another solver');
    return body;
  }

  async getImpliedProvenance(packageMarketId: string): Promise<readonly Record<string, unknown>[]> {
    checkId(packageMarketId, 'package market id');
    const body = record(await this.#request('GET', `/v1/package-book/${packageMarketId}/implied-provenance`), 'provenance');
    return list(body.implied, 'implied').map((entry, index) => record(entry, `implied[${index}]`));
  }

  /** Fetches the allocation for an order the caller submitted and verifies it before returning it. */
  async getVerifiedAllocation(takerOrderId: string): Promise<VerifiedAllocation> {
    if (!HASH_HEX.test(takerOrderId)) throw new TypeError('taker order id must be 32 bytes of lowercase hex');
    const body = record(await this.#request('GET', `/v1/allocations/${takerOrderId}`), 'allocation response');
    return verifyAllocationEvidence(takerOrderId, body.allocation, body.matchingPolicy);
  }

  // ---------------------------------------------------------------- private delivery

  /**
   * Submits envelopes the caller encrypted with the pinned suite. The relay stores ciphertext and
   * canonical metadata only; being stored is not being delivered.
   */
  async submitPrivateRfq(envelopes: readonly { readonly envelope: PrivateRfqEnvelopeInput; readonly ciphertext: Uint8Array }[]): Promise<readonly Record<string, unknown>[]> {
    if (envelopes.length === 0 || envelopes.length > 16) throw new TypeError('submit 1 to 16 envelopes');
    return list(record(await this.#request('POST', '/v1/rfqs/private', { envelopes }), 'rfq').results, 'results').map((entry, index) => record(entry, `results[${index}]`));
  }

  /** Delivery counts only once the recipient acknowledged; the response is ciphertext for the taker. */
  async getPrivateRfqStatus(envelopeHash: string): Promise<{ readonly acknowledged: boolean; readonly response?: unknown }> {
    const body = record(await this.#request('GET', `/v1/rfqs/private/${hashHex(envelopeHash, 'envelope hash')}`), 'rfq status');
    if (body.envelopeHash !== envelopeHash || typeof body.acknowledged !== 'boolean') throw new NaryxEvidenceError('rfq status is malformed');
    return Object.freeze({ acknowledged: body.acknowledged, ...(body.response === undefined ? {} : { response: body.response }) });
  }

  async createSealedAuction(definition: SealedAuctionDefinitionInput): Promise<string> {
    return hashHex(record(await this.#request('POST', '/v1/auctions/sealed', { definition }), 'auction').auctionHashHex, 'auctionHashHex');
  }

  /**
   * Reads an auction. Before close only the phase and commitment count are public. After close
   * the result is recomputed locally from the published event log and must match exactly.
   */
  async getSealedAuction(auctionHash: string): Promise<Record<string, unknown>> {
    const body = record(await this.#request('GET', `/v1/auctions/sealed/${hashHex(auctionHash, 'auction hash')}`), 'auction');
    if (body.phase !== 'CLOSED') return body;
    const definition = body.definition as SealedAuctionDefinitionInput;
    const result = record(body.result, 'auction.result');
    const events = list(body.events, 'auction.events') as readonly SealedAuctionEvent[];
    let matches = false;
    try {
      matches = verifySealedAuctionResult(definition, events, definition.revealDeadlineValue, result.resultHash as Uint8Array);
    } catch {
      matches = false;
    }
    if (!matches) throw new NaryxEvidenceError('the published auction result does not replay from its event log');
    return body;
  }

  // ---------------------------------------------------------------- computation

  /** Validates an order on the server and locally; the two verdicts and hashes must agree. */
  async validateOrder(order: PackageOrderInput): Promise<{ readonly valid: true; readonly orderHash: string } | { readonly valid: false; readonly code: string; readonly detail: string }> {
    let local: { valid: true; orderHash: string } | { valid: false; code: string; detail: string };
    try {
      local = { valid: true, orderHash: toHex(packageOrderHash(validatePackageOrderProfile(order))) };
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      local = { valid: false, code: error.code, detail: error.detail };
    }
    const remote = record(await this.#request('POST', '/v1/orders/validate', { order }), 'validation');
    if (remote.valid !== local.valid || (local.valid && remote.orderHash !== local.orderHash)) {
      throw new NaryxEvidenceError('server order validation disagrees with local validation');
    }
    return Object.freeze(local);
  }

  /** Replays a route decision on the server and locally; the verdicts and hashes must agree. */
  async replayRouteDecision(decision: RouteDecisionInput): Promise<RouteDecisionReplay> {
    const local = replayRouteDecision(decision);
    const remote = record(await this.#request('POST', '/v1/routes/replay-decision', { decision }), 'replay');
    const remoteHash = remote.decisionHash instanceof Uint8Array ? toHex(remote.decisionHash) : undefined;
    if (remote.valid !== local.valid || remoteHash !== toHex(local.decisionHash)) {
      throw new NaryxEvidenceError('server route replay disagrees with local replay');
    }
    return local;
  }

  async compareRoutes(request: RfqRequest, responses: readonly RfqResponse[], capacities: readonly RfqSolverCapacity[] = []): Promise<RfqDecision> {
    return (await this.#request('POST', '/v1/routes/compare', { request, responses, capacities })) as RfqDecision;
  }

  /** Simulates an order against the current book; nothing is submitted, reserved, or persisted. */
  async simulateClearing(packageMarketId: string, order: PackageTakerOrderInput): Promise<Record<string, unknown>> {
    const body = record(await this.#request('POST', '/v1/clearing/simulate', { packageMarketId: checkId(packageMarketId, 'package market id'), order }), 'simulation');
    if (body.simulated !== true) throw new NaryxEvidenceError('clearing response is not marked as a simulation');
    return body;
  }

  async validateDeRisk(input: { readonly positions: readonly unknown[]; readonly policy: unknown; readonly stateCertain: boolean; readonly openRiskIncreasingOrderIds?: readonly string[] }): Promise<readonly unknown[]> {
    return list(record(await this.#request('POST', '/v1/de-risk/validate', input), 'de-risk').actions, 'actions');
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

/** Rebuilds observed candles from tape pages, so an integrator can check a served series. */
export function candlesFromTape(trades: readonly PackageTapeTrade[], interval: CandleInterval, window?: { readonly fromMs: number; readonly toMs: number }): CandleSeries {
  return aggregateCandles(
    trades.flatMap((trade) => trade.fills.map((fill) => ({ timeMs: trade.recordedAtMs, priceTicks: fill.priceTicks, quantity: fill.quantity }))),
    interval,
    'OBSERVED',
    window,
  );
}
