import { HttpTransport, InfoClient, TESTNET_API_URL } from '@nktkas/hyperliquid';
import type {
  L2BookResponse,
  MetaResponse,
  SpotMetaResponse,
  UserFeesResponse,
} from '@nktkas/hyperliquid/api/info';
import type { HyperliquidExecutionPlan } from '@naryx/adapter-hyperliquid';
import type { HyperliquidTestnetRuntimeMarketBinding } from './hyperliquid-testnet-runtime.js';

export const HYPERLIQUID_TESTNET_MARKET_INFO_URL = TESTNET_API_URL;

type Book = Exclude<L2BookResponse, null>;

export interface HyperliquidTestnetMarketSnapshot {
  readonly environment: 'testnet';
  readonly apiUrl: typeof HYPERLIQUID_TESTNET_MARKET_INFO_URL;
  readonly requestedAtMs: number;
  readonly receivedAtMs: number;
  readonly spotMeta: SpotMetaResponse;
  readonly perpetualMeta: MetaResponse;
  readonly spotBook: L2BookResponse;
  readonly perpetualBook: L2BookResponse;
}

export interface HyperliquidTestnetMarketReadPort {
  readonly environment: 'testnet';
  readonly apiUrl: typeof HYPERLIQUID_TESTNET_MARKET_INFO_URL;
  read(spotCoin: string, perpetualCoin: string): Promise<HyperliquidTestnetMarketSnapshot>;
}

export type HyperliquidTestnetUserFeeRates = Pick<UserFeesResponse, 'userCrossRate' | 'userSpotCrossRate'>;

export interface HyperliquidTestnetQuoteMarketReadPort {
  readonly environment: 'testnet';
  readonly apiUrl: typeof HYPERLIQUID_TESTNET_MARKET_INFO_URL;
  l2Book(coin: string): Promise<L2BookResponse>;
  userFees(user: `0x${string}`): Promise<HyperliquidTestnetUserFeeRates>;
}

export interface HyperliquidTestnetPerpetualContext {
  readonly funding: string;
}

export interface HyperliquidTestnetGeneralizedMarketReadPort extends HyperliquidTestnetQuoteMarketReadPort {
  perpetualContext(coin: string): Promise<HyperliquidTestnetPerpetualContext>;
}

export interface HyperliquidTestnetMarketQualificationConfig {
  readonly spotUniverseName: string;
  readonly spotTokenName: string;
  readonly quoteTokenName: string;
  readonly perpetualName: string;
  readonly spotUniverseCanonical: boolean;
  readonly spotTokenCanonical: boolean;
  readonly quoteTokenCanonical: boolean;
  readonly spotTokenId: `0x${string}`;
  readonly quoteTokenId: `0x${string}`;
  readonly spotSizeDecimals: number;
  readonly perpetualSizeDecimals: number;
  readonly maxBookAgeMs: number;
  readonly maxSnapshotSkewMs: number;
  readonly maxReferenceDivergenceBps: number;
  readonly minimumSpotDepth: string;
  readonly minimumPerpetualDepth: string;
}

export interface HyperliquidTestnetMarketQualificationInput {
  readonly plan: HyperliquidExecutionPlan;
  readonly binding: HyperliquidTestnetRuntimeMarketBinding;
}

type Decimal = Readonly<{ atoms: bigint; scale: number }>;

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const NAME = /^[A-Za-z0-9@._:/-]{1,64}$/;
const TOKEN_ID = /^0x[0-9a-f]{32}$/;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Hyperliquid Testnet market preflight failed: ${message}`);
}

function decimal(value: unknown, name: string): Decimal {
  requireCondition(typeof value === 'string' && value.length <= 80,
    `${name} must be a bounded decimal string`);
  const match = DECIMAL.exec(value);
  requireCondition(match !== null, `${name} is malformed`);
  const integer = match[1] as string;
  const fraction = match[2] ?? '';
  return Object.freeze({
    atoms: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  });
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function compare(left: Decimal, right: Decimal): number {
  const scale = Math.max(left.scale, right.scale);
  const normalizedLeft = left.atoms * pow10(scale - left.scale);
  const normalizedRight = right.atoms * pow10(scale - right.scale);
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return Object.freeze({
    atoms: left.atoms * pow10(scale - left.scale) + right.atoms * pow10(scale - right.scale),
    scale,
  });
}

function positiveDecimal(value: string, name: string): Decimal {
  const parsed = decimal(value, name);
  requireCondition(parsed.atoms > 0n, `${name} must be positive`);
  return parsed;
}

function safePositiveInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value)
    && value > 0 && value <= maximum, `${name} is invalid`);
  return value;
}

function safeNonNegativeInteger(value: unknown, name: string, maximum: number): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= maximum, `${name} is invalid`);
  return value;
}

function checkedName(value: unknown, name: string): string {
  requireCondition(typeof value === 'string' && NAME.test(value), `${name} is invalid`);
  return value;
}

function checkedBoolean(value: unknown, name: string): boolean {
  requireCondition(typeof value === 'boolean', `${name} is invalid`);
  return value;
}

function checkedTokenId(value: unknown, name: string): `0x${string}` {
  requireCondition(typeof value === 'string' && TOKEN_ID.test(value), `${name} is invalid`);
  return value as `0x${string}`;
}

function checkedBook(value: L2BookResponse, expectedCoin: string, name: string): Book {
  requireCondition(value !== null && typeof value === 'object', `${name} does not exist`);
  requireCondition(value.coin === expectedCoin, `${name} identity does not match configuration`);
  requireCondition(Number.isSafeInteger(value.time) && value.time > 0, `${name} timestamp is invalid`);
  requireCondition(Array.isArray(value.levels) && value.levels.length === 2,
    `${name} levels are invalid`);
  requireCondition(value.levels[0].length > 0 && value.levels[1].length > 0,
    `${name} must have both bids and asks`);
  for (const [sideIndex, side] of value.levels.entries()) {
    let previousPrice: Decimal | undefined;
    for (const [levelIndex, level] of side.entries()) {
      requireCondition(level !== null && typeof level === 'object',
        `${name} level ${sideIndex}:${levelIndex} is invalid`);
      const price = decimal(level.px, `${name} price`);
      requireCondition(price.atoms > 0n,
        `${name} price must be positive`);
      requireCondition(decimal(level.sz, `${name} size`).atoms > 0n,
        `${name} size must be positive`);
      requireCondition(Number.isSafeInteger(level.n) && level.n > 0,
        `${name} order count is invalid`);
      if (previousPrice !== undefined) {
        requireCondition(sideIndex === 0
          ? compare(previousPrice, price) > 0
          : compare(previousPrice, price) < 0,
        `${name} levels are not strictly price ordered`);
      }
      previousPrice = price;
    }
  }
  return value;
}

function requiredDepth(planOrder: { readonly s: string }, configured: string, name: string): Decimal {
  const planned = positiveDecimal(planOrder.s, `${name} planned quantity`);
  const minimum = positiveDecimal(configured, `${name} configured minimum depth`);
  return compare(planned, minimum) >= 0 ? planned : minimum;
}

function executableDepth(
  book: Book,
  isBuy: boolean,
  limitPrice: string,
  name: string,
): Decimal {
  const limit = positiveDecimal(limitPrice, `${name} limit price`);
  const levels = isBuy ? book.levels[1] : book.levels[0];
  let total: Decimal = Object.freeze({ atoms: 0n, scale: 0 });
  for (const level of levels) {
    const price = positiveDecimal(level.px, `${name} book price`);
    const executable = isBuy ? compare(price, limit) <= 0 : compare(price, limit) >= 0;
    if (executable) total = add(total, positiveDecimal(level.sz, `${name} book size`));
  }
  return total;
}

function midpoint(book: Book, name: string): Decimal {
  const bestBid = book.levels[0][0];
  const bestAsk = book.levels[1][0];
  requireCondition(bestBid !== undefined && bestAsk !== undefined, `${name} is one-sided`);
  const bid = positiveDecimal(bestBid.px, `${name} best bid`);
  const ask = positiveDecimal(bestAsk.px, `${name} best ask`);
  requireCondition(compare(bid, ask) < 0, `${name} book is crossed or locked`);
  return add(bid, ask);
}

function divergenceWithin(left: Decimal, right: Decimal, maxBps: number): boolean {
  const scale = Math.max(left.scale, right.scale);
  const normalizedLeft = left.atoms * pow10(scale - left.scale);
  const normalizedRight = right.atoms * pow10(scale - right.scale);
  const difference = normalizedLeft > normalizedRight
    ? normalizedLeft - normalizedRight
    : normalizedRight - normalizedLeft;
  const reference = normalizedLeft < normalizedRight ? normalizedLeft : normalizedRight;
  return difference * 10_000n <= reference * BigInt(maxBps);
}

function planOrders(plan: HyperliquidExecutionPlan) {
  const spot = plan.legs.find((leg) => leg.role === 'SPOT')?.order;
  const perpetual = plan.legs.find((leg) => leg.role === 'PERPETUAL')?.order;
  requireCondition(spot !== undefined && perpetual !== undefined,
    'compiled plan must contain spot and perpetual orders');
  return { spot, perpetual };
}

export {
  checkedBook as checkedHyperliquidTestnetBook,
  decimal as hyperliquidTestnetDecimal,
};

export class HyperliquidSdkTestnetMarketReadClient
implements HyperliquidTestnetMarketReadPort, HyperliquidTestnetQuoteMarketReadPort {
  readonly environment = 'testnet' as const;
  readonly apiUrl = HYPERLIQUID_TESTNET_MARKET_INFO_URL;
  readonly #client: InfoClient;

  constructor() {
    const transport = new HttpTransport({ isTestnet: true, apiUrl: this.apiUrl });
    requireCondition(transport.isTestnet && transport.apiUrl.toString() === this.apiUrl,
      'Info transport is not pinned to Testnet');
    this.#client = new InfoClient({ transport });
  }

  async read(spotCoin: string, perpetualCoin: string): Promise<HyperliquidTestnetMarketSnapshot> {
    const requestedAtMs = Date.now();
    const [spotMeta, perpetualMeta, spotBook, perpetualBook] = await Promise.all([
      this.#client.spotMeta(),
      this.#client.meta(),
      this.#client.l2Book({ coin: spotCoin }),
      this.#client.l2Book({ coin: perpetualCoin }),
    ]);
    const receivedAtMs = Date.now();
    return Object.freeze({
      environment: this.environment,
      apiUrl: this.apiUrl,
      requestedAtMs,
      receivedAtMs,
      spotMeta,
      perpetualMeta,
      spotBook,
      perpetualBook,
    });
  }

  l2Book(coin: string): Promise<L2BookResponse> {
    return this.#client.l2Book({ coin });
  }

  userFees(user: `0x${string}`): Promise<UserFeesResponse> {
    return this.#client.userFees({ user });
  }

  async perpetualContext(coin: string): Promise<HyperliquidTestnetPerpetualContext> {
    const [meta, contexts] = await this.#client.metaAndAssetCtxs();
    const index = meta.universe.findIndex((asset) => asset.name === coin);
    const context = index < 0 ? undefined : contexts[index];
    requireCondition(context !== undefined && typeof context.funding === 'string',
      `perpetual context ${coin} is unavailable`);
    return Object.freeze({ funding: context.funding });
  }
}

export class HyperliquidTestnetMarketPreflight {
  readonly #reader: HyperliquidTestnetMarketReadPort;
  readonly #config: HyperliquidTestnetMarketQualificationConfig;
  readonly #currentTimeMs: () => number;

  constructor(
    reader: HyperliquidTestnetMarketReadPort,
    config: HyperliquidTestnetMarketQualificationConfig,
    currentTimeMs: () => number = Date.now,
  ) {
    requireCondition(reader?.environment === 'testnet'
      && reader.apiUrl === HYPERLIQUID_TESTNET_MARKET_INFO_URL
      && typeof reader.read === 'function', 'read port is not exact Hyperliquid Testnet');
    this.#reader = reader;
    this.#config = Object.freeze({
      spotUniverseName: checkedName(config.spotUniverseName, 'spotUniverseName'),
      spotTokenName: checkedName(config.spotTokenName, 'spotTokenName'),
      quoteTokenName: checkedName(config.quoteTokenName, 'quoteTokenName'),
      perpetualName: checkedName(config.perpetualName, 'perpetualName'),
      spotUniverseCanonical: checkedBoolean(
        config.spotUniverseCanonical, 'spotUniverseCanonical',
      ),
      spotTokenCanonical: checkedBoolean(config.spotTokenCanonical, 'spotTokenCanonical'),
      quoteTokenCanonical: checkedBoolean(config.quoteTokenCanonical, 'quoteTokenCanonical'),
      spotTokenId: checkedTokenId(config.spotTokenId, 'spotTokenId'),
      quoteTokenId: checkedTokenId(config.quoteTokenId, 'quoteTokenId'),
      spotSizeDecimals: safeNonNegativeInteger(config.spotSizeDecimals, 'spotSizeDecimals', 18),
      perpetualSizeDecimals: safeNonNegativeInteger(
        config.perpetualSizeDecimals, 'perpetualSizeDecimals', 18,
      ),
      maxBookAgeMs: safePositiveInteger(config.maxBookAgeMs, 'maxBookAgeMs'),
      maxSnapshotSkewMs: safePositiveInteger(config.maxSnapshotSkewMs, 'maxSnapshotSkewMs'),
      maxReferenceDivergenceBps: safePositiveInteger(
        config.maxReferenceDivergenceBps, 'maxReferenceDivergenceBps', 10_000,
      ),
      minimumSpotDepth: config.minimumSpotDepth,
      minimumPerpetualDepth: config.minimumPerpetualDepth,
    });
    positiveDecimal(this.#config.minimumSpotDepth, 'minimumSpotDepth');
    positiveDecimal(this.#config.minimumPerpetualDepth, 'minimumPerpetualDepth');
    this.#currentTimeMs = currentTimeMs;
  }

  async qualify(input: HyperliquidTestnetMarketQualificationInput): Promise<void> {
    const binding = input.binding;
    const snapshot = await this.#reader.read(
      this.#config.spotUniverseName, this.#config.perpetualName,
    );
    requireCondition(snapshot.environment === 'testnet'
      && snapshot.apiUrl === HYPERLIQUID_TESTNET_MARKET_INFO_URL,
    'snapshot source is not exact Hyperliquid Testnet');
    requireCondition(Number.isSafeInteger(snapshot.requestedAtMs)
      && Number.isSafeInteger(snapshot.receivedAtMs)
      && snapshot.requestedAtMs > 0
      && snapshot.receivedAtMs >= snapshot.requestedAtMs,
    'snapshot timing is invalid');
    const nowMs = this.#currentTimeMs();
    requireCondition(Number.isSafeInteger(nowMs) && nowMs > 0
      && snapshot.receivedAtMs <= nowMs
      && nowMs - snapshot.receivedAtMs <= this.#config.maxBookAgeMs,
    'snapshot response is stale or future-dated');

    const universe = snapshot.spotMeta.universe.find(
      (candidate) => candidate.index === binding.spotUniverseIndex,
    );
    const spotToken = snapshot.spotMeta.tokens.find(
      (candidate) => candidate.index === binding.spotTokenIndex,
    );
    const quoteToken = snapshot.spotMeta.tokens.find(
      (candidate) => candidate.index === binding.quoteTokenIndex,
    );
    const perpetual = snapshot.perpetualMeta.universe[binding.perpetualAssetIndex];
    requireCondition(universe !== undefined
      && universe.name === this.#config.spotUniverseName
      && universe.tokens[0] === binding.spotTokenIndex
      && universe.tokens[1] === binding.quoteTokenIndex
      && universe.isCanonical === this.#config.spotUniverseCanonical,
    'spot universe identity mismatch');
    requireCondition(spotToken !== undefined
      && spotToken.name === this.#config.spotTokenName
      && spotToken.isCanonical === this.#config.spotTokenCanonical
      && spotToken.tokenId === this.#config.spotTokenId
      && spotToken.szDecimals === this.#config.spotSizeDecimals,
    'spot token identity mismatch');
    requireCondition(quoteToken !== undefined
      && quoteToken.name === this.#config.quoteTokenName
      && quoteToken.isCanonical === this.#config.quoteTokenCanonical
      && quoteToken.tokenId === this.#config.quoteTokenId,
    'quote token identity mismatch');
    requireCondition(snapshot.perpetualMeta.collateralToken === binding.quoteTokenIndex,
      'perpetual collateral token mismatch');
    requireCondition(perpetual !== undefined
      && perpetual.name === this.#config.perpetualName
      && perpetual.isDelisted !== true
      && perpetual.szDecimals === this.#config.perpetualSizeDecimals,
    'perpetual asset identity mismatch');

    const { spot, perpetual: perpetualOrder } = planOrders(input.plan);
    requireCondition(spot.a === 10_000 + binding.spotUniverseIndex,
      'compiled spot asset does not match spot universe');
    requireCondition(perpetualOrder.a === binding.perpetualAssetIndex,
      'compiled perpetual asset does not match perpetual metadata');
    requireCondition(decimal(spot.s, 'spot planned quantity').scale <= spotToken.szDecimals,
      'spot size precision exceeds token metadata');
    requireCondition(decimal(perpetualOrder.s, 'perpetual planned quantity').scale
      <= perpetual.szDecimals, 'perpetual size precision exceeds metadata');

    const spotBook = checkedBook(snapshot.spotBook, this.#config.spotUniverseName, 'spot book');
    const perpetualBook = checkedBook(
      snapshot.perpetualBook, this.#config.perpetualName, 'perpetual book',
    );
    for (const [name, book] of [['spot book', spotBook], ['perpetual book', perpetualBook]] as const) {
      requireCondition(book.time <= snapshot.receivedAtMs
        && snapshot.receivedAtMs - book.time <= this.#config.maxBookAgeMs,
      `${name} is stale or future-dated`);
    }
    requireCondition(Math.abs(spotBook.time - perpetualBook.time)
      <= this.#config.maxSnapshotSkewMs, 'book snapshots exceed maximum skew');

    const spotRequired = requiredDepth(
      spot, this.#config.minimumSpotDepth, 'spot',
    );
    const perpetualRequired = requiredDepth(
      perpetualOrder, this.#config.minimumPerpetualDepth, 'perpetual',
    );
    requireCondition(compare(executableDepth(
      spotBook, spot.b, spot.p, 'spot',
    ), spotRequired) >= 0, 'spot executable depth is insufficient');
    requireCondition(compare(executableDepth(
      perpetualBook, perpetualOrder.b, perpetualOrder.p, 'perpetual',
    ), perpetualRequired) >= 0, 'perpetual executable depth is insufficient');
    requireCondition(divergenceWithin(
      midpoint(spotBook, 'spot'), midpoint(perpetualBook, 'perpetual'),
      this.#config.maxReferenceDivergenceBps,
    ), 'spot-perpetual reference divergence exceeds the configured maximum');
  }
}
