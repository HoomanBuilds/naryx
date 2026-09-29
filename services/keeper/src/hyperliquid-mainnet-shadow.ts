import { createHash } from 'node:crypto';
import { HttpTransport, InfoClient, MAINNET_API_URL } from '@nktkas/hyperliquid';
import type {
  L2BookResponse,
  MetaAndAssetCtxsResponse,
  SpotMetaAndAssetCtxsResponse,
  UserFeesResponse,
} from '@nktkas/hyperliquid/api/info';

export const HYPERLIQUID_MAINNET_INFO_URL = MAINNET_API_URL;

const PUBLIC_FEE_SCHEDULE_ACCOUNT = `0x${'00'.repeat(20)}` as const;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const SIGNED_DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const TOKEN_ID_PATTERN = /^0x[0-9a-f]{32}$/;
const NAME_PATTERN = /^[A-Za-z0-9@._:/-]{1,64}$/;

type Book = Exclude<L2BookResponse, null>;

interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export interface HyperliquidMainnetShadowSnapshot {
  readonly environment: 'mainnet';
  readonly apiUrl: typeof HYPERLIQUID_MAINNET_INFO_URL;
  readonly requestedAtMs: number;
  readonly receivedAtMs: number;
  readonly spot: SpotMetaAndAssetCtxsResponse;
  readonly perpetual: MetaAndAssetCtxsResponse;
  readonly spotBook: L2BookResponse;
  readonly perpetualBook: L2BookResponse;
  readonly feeSchedule: UserFeesResponse['feeSchedule'];
}

export interface HyperliquidMainnetShadowReadPort {
  readonly environment: 'mainnet';
  readonly apiUrl: typeof HYPERLIQUID_MAINNET_INFO_URL;
  read(spotCoin: string, perpetualCoin: string): Promise<HyperliquidMainnetShadowSnapshot>;
}

export interface HyperliquidMainnetShadowConfig {
  readonly spotUniverseIndex: number;
  readonly spotUniverseName: string;
  readonly spotUniverseCanonical: boolean;
  readonly spotTokenIndex: number;
  readonly spotTokenName: string;
  readonly spotTokenId: `0x${string}`;
  readonly spotTokenCanonical: boolean;
  readonly quoteTokenIndex: number;
  readonly quoteTokenName: string;
  readonly quoteTokenId: `0x${string}`;
  readonly quoteTokenCanonical: boolean;
  readonly perpetualAssetIndex: number;
  readonly perpetualName: string;
  readonly spotSizeDecimals: number;
  readonly perpetualSizeDecimals: number;
  readonly quoteDecimals: number;
  readonly baseQuantity: string;
  readonly minimumOpenInterest: string;
  readonly maxEntryCostQuoteAtoms: bigint;
  readonly maxBookAgeMs: number;
  readonly maxSnapshotSkewMs: number;
  readonly maxMarkOracleDivergenceBps: number;
}

export interface HyperliquidMainnetShadowEvidence {
  readonly version: 1;
  readonly environment: 'mainnet';
  readonly apiUrl: typeof HYPERLIQUID_MAINNET_INFO_URL;
  readonly observedAtMs: number;
  readonly sourceCommitmentSha256: `0x${string}`;
  readonly market: Readonly<{
    spotUniverseIndex: number;
    spotUniverseName: string;
    spotTokenIndex: number;
    spotTokenId: `0x${string}`;
    quoteTokenIndex: number;
    quoteTokenId: `0x${string}`;
    perpetualAssetIndex: number;
    perpetualName: string;
  }>;
  readonly marketState: Readonly<{
    spotMarkPrice: string;
    perpetualMarkPrice: string;
    perpetualOraclePrice: string;
    perpetualFundingRate: string;
    perpetualOpenInterest: string;
  }>;
  readonly feeSchedule: Readonly<{
    spotTakerRate: string;
    perpetualTakerRate: string;
    scheduleCommitmentSha256: `0x${string}`;
  }>;
  readonly economics: Readonly<{
    baseQuantityAtoms: bigint;
    spotCostQuoteAtoms: bigint;
    perpetualProceedsQuoteAtoms: bigint;
    spotFeeQuoteAtoms: bigint;
    perpetualFeeQuoteAtoms: bigint;
    entryCostQuoteAtoms: bigint;
    maxEntryCostQuoteAtoms: bigint;
  }>;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Hyperliquid mainnet shadow rejected: ${message}`);
}

function checkedInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  requireCondition(Number.isSafeInteger(value) && value >= 0 && value <= maximum,
    `${name} is invalid`);
  return value;
}

function checkedPositiveInteger(value: number, name: string): number {
  requireCondition(Number.isSafeInteger(value) && value > 0, `${name} is invalid`);
  return value;
}

function checkedName(value: string, name: string): string {
  requireCondition(NAME_PATTERN.test(value), `${name} is invalid`);
  return value;
}

function checkedTokenId(value: `0x${string}`, name: string): `0x${string}` {
  requireCondition(TOKEN_ID_PATTERN.test(value), `${name} is invalid`);
  return value;
}

function parseDecimal(value: unknown, name: string, signed = false): Decimal {
  requireCondition(typeof value === 'string' && value.length <= 80, `${name} is not bounded`);
  const pattern = signed ? SIGNED_DECIMAL_PATTERN : DECIMAL_PATTERN;
  const match = pattern.exec(value);
  requireCondition(match !== null, `${name} is malformed`);
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${integer}${fraction}`) * (negative ? -1n : 1n);
  return Object.freeze({ coefficient, scale: fraction.length });
}

function positiveDecimal(value: unknown, name: string): Decimal {
  const parsed = parseDecimal(value, name);
  requireCondition(parsed.coefficient > 0n, `${name} must be positive`);
  return parsed;
}

function pow10(value: number): bigint {
  return 10n ** BigInt(value);
}

function compare(left: Decimal, right: Decimal): number {
  const scale = Math.max(left.scale, right.scale);
  const a = left.coefficient * pow10(scale - left.scale);
  const b = right.coefficient * pow10(scale - right.scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

function toAtoms(value: Decimal, decimals: number, name: string): bigint {
  requireCondition(value.scale <= decimals, `${name} precision exceeds configured decimals`);
  return value.coefficient * pow10(decimals - value.scale);
}

function divideUp(numerator: bigint, denominator: bigint): bigint {
  requireCondition(numerator >= 0n && denominator > 0n, 'rounded division inputs are invalid');
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function quoteAtomsForFill(
  price: Decimal,
  baseAtoms: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  roundUp: boolean,
): bigint {
  const numerator = price.coefficient * baseAtoms * pow10(quoteDecimals);
  const denominator = pow10(price.scale + baseDecimals);
  return roundUp ? divideUp(numerator, denominator) : numerator / denominator;
}

function rateFee(notionalAtoms: bigint, rate: Decimal): bigint {
  requireCondition(rate.coefficient >= 0n, 'taker fee rate must not be negative');
  return divideUp(notionalAtoms * rate.coefficient, pow10(rate.scale));
}

function sha256(value: unknown): `0x${string}` {
  return `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function checkedBook(value: L2BookResponse, expectedCoin: string, name: string): Book {
  requireCondition(value !== null, `${name} does not exist`);
  requireCondition(value.coin === expectedCoin, `${name} identity mismatch`);
  requireCondition(Number.isSafeInteger(value.time) && value.time > 0, `${name} time is invalid`);
  requireCondition(value.levels[0].length > 0 && value.levels[1].length > 0,
    `${name} must be two-sided`);
  for (const [sideIndex, levels] of value.levels.entries()) {
    let previous: Decimal | undefined;
    for (const level of levels) {
      const price = positiveDecimal(level.px, `${name} price`);
      positiveDecimal(level.sz, `${name} size`);
      requireCondition(Number.isSafeInteger(level.n) && level.n > 0,
        `${name} order count is invalid`);
      if (previous !== undefined) {
        requireCondition(sideIndex === 0 ? compare(previous, price) > 0 : compare(previous, price) < 0,
          `${name} levels are not strictly ordered`);
      }
      previous = price;
    }
  }
  const bid = positiveDecimal(value.levels[0][0]?.px, `${name} best bid`);
  const ask = positiveDecimal(value.levels[1][0]?.px, `${name} best ask`);
  requireCondition(compare(bid, ask) < 0, `${name} is crossed or locked`);
  return value;
}

function sweepQuoteAtoms(
  levels: Book['levels'][number],
  requiredBaseAtoms: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  roundUp: boolean,
  name: string,
): bigint {
  let remaining = requiredBaseAtoms;
  let quoteAtoms = 0n;
  for (const level of levels) {
    if (remaining === 0n) break;
    const available = toAtoms(positiveDecimal(level.sz, `${name} size`), baseDecimals, `${name} size`);
    const consumed = available < remaining ? available : remaining;
    quoteAtoms += quoteAtomsForFill(
      positiveDecimal(level.px, `${name} price`), consumed, baseDecimals, quoteDecimals, roundUp,
    );
    remaining -= consumed;
  }
  requireCondition(remaining === 0n, `${name} executable depth is insufficient`);
  return quoteAtoms;
}

function withinBps(left: Decimal, right: Decimal, maxBps: number): boolean {
  const scale = Math.max(left.scale, right.scale);
  const a = left.coefficient * pow10(scale - left.scale);
  const b = right.coefficient * pow10(scale - right.scale);
  const difference = a > b ? a - b : b - a;
  const reference = a < b ? a : b;
  return difference * 10_000n <= reference * BigInt(maxBps);
}

export class HyperliquidSdkMainnetShadowReader implements HyperliquidMainnetShadowReadPort {
  readonly environment = 'mainnet' as const;
  readonly apiUrl = HYPERLIQUID_MAINNET_INFO_URL;
  readonly #client: InfoClient;

  constructor() {
    const transport = new HttpTransport({ isTestnet: false, apiUrl: MAINNET_API_URL });
    requireCondition(!transport.isTestnet && transport.apiUrl.toString() === MAINNET_API_URL,
      'Info transport is not pinned to official mainnet');
    this.#client = new InfoClient({ transport });
  }

  async read(spotCoin: string, perpetualCoin: string): Promise<HyperliquidMainnetShadowSnapshot> {
    const requestedAtMs = Date.now();
    const [spot, perpetual, spotBook, perpetualBook, fees] = await Promise.all([
      this.#client.spotMetaAndAssetCtxs(),
      this.#client.metaAndAssetCtxs(),
      this.#client.l2Book({ coin: spotCoin }),
      this.#client.l2Book({ coin: perpetualCoin }),
      this.#client.userFees({ user: PUBLIC_FEE_SCHEDULE_ACCOUNT }),
    ]);
    const receivedAtMs = Date.now();
    return Object.freeze({
      environment: this.environment,
      apiUrl: this.apiUrl,
      requestedAtMs,
      receivedAtMs,
      spot,
      perpetual,
      spotBook,
      perpetualBook,
      feeSchedule: fees.feeSchedule,
    });
  }
}

export class HyperliquidMainnetShadowReader {
  readonly #reader: HyperliquidMainnetShadowReadPort;
  readonly #config: HyperliquidMainnetShadowConfig;
  readonly #nowMs: () => number;

  constructor(
    reader: HyperliquidMainnetShadowReadPort,
    config: HyperliquidMainnetShadowConfig,
    nowMs: () => number = Date.now,
  ) {
    requireCondition(reader.environment === 'mainnet'
      && reader.apiUrl === HYPERLIQUID_MAINNET_INFO_URL
      && typeof reader.read === 'function', 'read port is not exact official mainnet');
    this.#reader = reader;
    this.#config = Object.freeze({
      ...config,
      spotUniverseIndex: checkedInteger(config.spotUniverseIndex, 'spotUniverseIndex'),
      spotUniverseName: checkedName(config.spotUniverseName, 'spotUniverseName'),
      spotTokenIndex: checkedInteger(config.spotTokenIndex, 'spotTokenIndex'),
      spotTokenName: checkedName(config.spotTokenName, 'spotTokenName'),
      spotTokenId: checkedTokenId(config.spotTokenId, 'spotTokenId'),
      quoteTokenIndex: checkedInteger(config.quoteTokenIndex, 'quoteTokenIndex'),
      quoteTokenName: checkedName(config.quoteTokenName, 'quoteTokenName'),
      quoteTokenId: checkedTokenId(config.quoteTokenId, 'quoteTokenId'),
      perpetualAssetIndex: checkedInteger(config.perpetualAssetIndex, 'perpetualAssetIndex'),
      perpetualName: checkedName(config.perpetualName, 'perpetualName'),
      spotSizeDecimals: checkedInteger(config.spotSizeDecimals, 'spotSizeDecimals', 18),
      perpetualSizeDecimals: checkedInteger(config.perpetualSizeDecimals, 'perpetualSizeDecimals', 18),
      quoteDecimals: checkedInteger(config.quoteDecimals, 'quoteDecimals', 18),
      maxBookAgeMs: checkedPositiveInteger(config.maxBookAgeMs, 'maxBookAgeMs'),
      maxSnapshotSkewMs: checkedPositiveInteger(config.maxSnapshotSkewMs, 'maxSnapshotSkewMs'),
      maxMarkOracleDivergenceBps: checkedInteger(
        config.maxMarkOracleDivergenceBps, 'maxMarkOracleDivergenceBps', 10_000,
      ),
    });
    requireCondition(config.maxEntryCostQuoteAtoms >= 0n, 'maxEntryCostQuoteAtoms is invalid');
    positiveDecimal(config.baseQuantity, 'baseQuantity');
    positiveDecimal(config.minimumOpenInterest, 'minimumOpenInterest');
    this.#nowMs = nowMs;
  }

  async observe(): Promise<HyperliquidMainnetShadowEvidence> {
    const config = this.#config;
    const snapshot = await this.#reader.read(config.spotUniverseName, config.perpetualName);
    requireCondition(snapshot.environment === 'mainnet'
      && snapshot.apiUrl === HYPERLIQUID_MAINNET_INFO_URL,
    'snapshot source is not exact official mainnet');
    requireCondition(Number.isSafeInteger(snapshot.requestedAtMs)
      && Number.isSafeInteger(snapshot.receivedAtMs)
      && snapshot.requestedAtMs > 0
      && snapshot.receivedAtMs >= snapshot.requestedAtMs,
    'snapshot timing is invalid');
    const nowMs = this.#nowMs();
    requireCondition(Number.isSafeInteger(nowMs) && nowMs >= snapshot.receivedAtMs
      && nowMs - snapshot.receivedAtMs <= config.maxBookAgeMs,
    'snapshot is stale or future-dated');

    const [spotMeta, spotContexts] = snapshot.spot;
    const [perpetualMeta, perpetualContexts] = snapshot.perpetual;
    const universe = spotMeta.universe.find((value) => value.index === config.spotUniverseIndex);
    const spotToken = spotMeta.tokens.find((value) => value.index === config.spotTokenIndex);
    const quoteToken = spotMeta.tokens.find((value) => value.index === config.quoteTokenIndex);
    const matchingSpotContexts = spotContexts.filter(
      (value) => value.coin === config.spotUniverseName,
    );
    const spotContext = matchingSpotContexts[0];
    const perpetual = perpetualMeta.universe[config.perpetualAssetIndex];
    const perpetualContext = perpetualContexts[config.perpetualAssetIndex];
    requireCondition(universe !== undefined
      && universe.name === config.spotUniverseName
      && universe.tokens[0] === config.spotTokenIndex
      && universe.tokens[1] === config.quoteTokenIndex
      && universe.isCanonical === config.spotUniverseCanonical,
    'spot universe identity mismatch');
    requireCondition(spotToken !== undefined
      && spotToken.name === config.spotTokenName
      && spotToken.tokenId === config.spotTokenId
      && spotToken.isCanonical === config.spotTokenCanonical
      && spotToken.szDecimals === config.spotSizeDecimals,
    'spot token identity mismatch');
    requireCondition(quoteToken !== undefined
      && quoteToken.name === config.quoteTokenName
      && quoteToken.tokenId === config.quoteTokenId
      && quoteToken.isCanonical === config.quoteTokenCanonical
      && quoteToken.weiDecimals === config.quoteDecimals,
    'quote token identity mismatch');
    requireCondition(perpetualMeta.collateralToken === config.quoteTokenIndex,
      'perpetual collateral token mismatch');
    requireCondition(perpetual !== undefined
      && perpetual.name === config.perpetualName
      && perpetual.szDecimals === config.perpetualSizeDecimals
      && perpetual.isDelisted !== true,
    'perpetual market identity mismatch');
    requireCondition(spotContext !== undefined && matchingSpotContexts.length === 1,
      'spot context identity mismatch');
    requireCondition(perpetualContext !== undefined, 'perpetual context is missing');

    const spotMark = positiveDecimal(spotContext.markPx, 'spot mark price');
    const perpetualMark = positiveDecimal(perpetualContext.markPx, 'perpetual mark price');
    const oracle = positiveDecimal(perpetualContext.oraclePx, 'perpetual oracle price');
    parseDecimal(perpetualContext.funding, 'perpetual funding rate', true);
    const openInterest = positiveDecimal(perpetualContext.openInterest, 'perpetual open interest');
    requireCondition(compare(openInterest, positiveDecimal(
      config.minimumOpenInterest, 'minimumOpenInterest',
    )) >= 0, 'perpetual open interest is below the configured minimum');
    requireCondition(withinBps(perpetualMark, oracle, config.maxMarkOracleDivergenceBps),
      'perpetual mark and oracle divergence exceeds the configured maximum');

    const spotBook = checkedBook(snapshot.spotBook, config.spotUniverseName, 'spot book');
    const perpetualBook = checkedBook(
      snapshot.perpetualBook, config.perpetualName, 'perpetual book',
    );
    for (const [name, book] of [['spot book', spotBook], ['perpetual book', perpetualBook]] as const) {
      requireCondition(book.time <= snapshot.receivedAtMs
        && snapshot.receivedAtMs - book.time <= config.maxBookAgeMs,
      `${name} is stale or future-dated`);
    }
    requireCondition(Math.abs(spotBook.time - perpetualBook.time) <= config.maxSnapshotSkewMs,
      'book timestamps exceed maximum skew');

    const quantity = positiveDecimal(config.baseQuantity, 'baseQuantity');
    const spotQuantityAtoms = toAtoms(quantity, config.spotSizeDecimals, 'baseQuantity');
    const perpetualQuantityAtoms = toAtoms(quantity, config.perpetualSizeDecimals, 'baseQuantity');
    requireCondition(spotQuantityAtoms * pow10(config.perpetualSizeDecimals)
      === perpetualQuantityAtoms * pow10(config.spotSizeDecimals),
    'spot and perpetual quantities are not economically equal');
    const spotCost = sweepQuoteAtoms(
      spotBook.levels[1], spotQuantityAtoms, config.spotSizeDecimals,
      config.quoteDecimals, true, 'spot asks',
    );
    const perpetualProceeds = sweepQuoteAtoms(
      perpetualBook.levels[0], perpetualQuantityAtoms, config.perpetualSizeDecimals,
      config.quoteDecimals, false, 'perpetual bids',
    );
    const spotFeeRate = parseDecimal(snapshot.feeSchedule.spotCross, 'spot taker fee rate');
    const perpetualFeeRate = parseDecimal(snapshot.feeSchedule.cross, 'perpetual taker fee rate');
    const spotFee = rateFee(spotCost, spotFeeRate);
    const perpetualFee = rateFee(perpetualProceeds, perpetualFeeRate);
    const entryCost = spotCost + spotFee + perpetualFee - perpetualProceeds;
    requireCondition(entryCost <= config.maxEntryCostQuoteAtoms,
      'executable package economics exceed the configured entry-cost bound');

    const scheduleCommitment = sha256(snapshot.feeSchedule);
    const sourceCommitment = sha256({
      environment: snapshot.environment,
      apiUrl: snapshot.apiUrl,
      requestedAtMs: snapshot.requestedAtMs,
      receivedAtMs: snapshot.receivedAtMs,
      spot: snapshot.spot,
      perpetual: snapshot.perpetual,
      spotBook: snapshot.spotBook,
      perpetualBook: snapshot.perpetualBook,
      feeSchedule: snapshot.feeSchedule,
    });
    return Object.freeze({
      version: 1,
      environment: 'mainnet',
      apiUrl: HYPERLIQUID_MAINNET_INFO_URL,
      observedAtMs: snapshot.receivedAtMs,
      sourceCommitmentSha256: sourceCommitment,
      market: Object.freeze({
        spotUniverseIndex: config.spotUniverseIndex,
        spotUniverseName: config.spotUniverseName,
        spotTokenIndex: config.spotTokenIndex,
        spotTokenId: config.spotTokenId,
        quoteTokenIndex: config.quoteTokenIndex,
        quoteTokenId: config.quoteTokenId,
        perpetualAssetIndex: config.perpetualAssetIndex,
        perpetualName: config.perpetualName,
      }),
      marketState: Object.freeze({
        spotMarkPrice: spotContext.markPx,
        perpetualMarkPrice: perpetualContext.markPx,
        perpetualOraclePrice: perpetualContext.oraclePx,
        perpetualFundingRate: perpetualContext.funding,
        perpetualOpenInterest: perpetualContext.openInterest,
      }),
      feeSchedule: Object.freeze({
        spotTakerRate: snapshot.feeSchedule.spotCross,
        perpetualTakerRate: snapshot.feeSchedule.cross,
        scheduleCommitmentSha256: scheduleCommitment,
      }),
      economics: Object.freeze({
        baseQuantityAtoms: spotQuantityAtoms,
        spotCostQuoteAtoms: spotCost,
        perpetualProceedsQuoteAtoms: perpetualProceeds,
        spotFeeQuoteAtoms: spotFee,
        perpetualFeeQuoteAtoms: perpetualFee,
        entryCostQuoteAtoms: entryCost,
        maxEntryCostQuoteAtoms: config.maxEntryCostQuoteAtoms,
      }),
    });
  }
}
