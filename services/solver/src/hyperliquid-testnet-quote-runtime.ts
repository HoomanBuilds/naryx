import {
  compareHypercoreWirePriceToExact,
  formatHypercorePrice,
  formatHypercoreSize,
  type HypercoreFormattedPrice,
} from '@naryx/adapter-hyperliquid';
import {
  adapterRef,
  assetRef,
  bytesEqual,
  canonicalBytes,
  compareBytes,
  domainRef,
  encodeAssetRef,
  exactPrice,
  exactSignedRate,
  manifestHash,
  routeHash,
  versionedManifestRef,
  type ActionCommitmentInput,
  type AdapterRef,
  type AssetAmount,
  type AssetRef,
  type DomainRef,
  type EvidenceRequirementsInput,
  type ExactPrice,
  type ExactSignedRate,
  type Hash32,
  type PackageOrder,
  type RecoveryAction,
  type RecoveryActionSlotInput,
  type RouteAccountBindingInput,
  type RoutePayloadInput,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import type { AtomicRouteCandidate, AtomicRouteDecision } from './atomic-route-decision.js';
import type { AtomicQuoteNonceSource } from './configured-atomic-market.js';
import {
  HYPERLIQUID_TESTNET_MARKET_INFO_URL,
  checkedHyperliquidTestnetBook,
  hyperliquidTestnetDecimal,
  type HyperliquidTestnetQuoteMarketReadPort,
} from './hyperliquid-testnet-market-preflight.js';
import type {
  InternalAtomicQuoteCandidateProvider,
  InternalAtomicQuoteTermsProvider,
} from './internal-atomic-quote-server.js';
import type { AtomicEntryQuoteTerms, Ed25519AtomicQuoteSigner } from './signed-atomic-entry-quote.js';
import {
  signHyperliquidTestnetExitQuote,
  type SignedHyperliquidTestnetExitQuote,
} from './hyperliquid-testnet-exit-quote.js';

const BPS_SCALE = 10_000n;
const U256_MAX = (1n << 256n) - 1n;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const MAX_PREPARED_QUOTES = 64;

export interface HyperliquidTestnetQuoteLeg {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  /** Exact l2Book coin identity, for example the spot universe name or the perpetual name. */
  readonly coin: string;
  readonly sizeDecimals: number;
  readonly action: ActionCommitmentInput;
}

export interface HyperliquidTestnetRecoveryIdentity {
  readonly policyVersion: number;
  readonly controllerId: string;
  readonly controllerCodeHash: Uint8Array | string;
  readonly authorityModeId: string;
  readonly reconciledStateSchemaHash: Uint8Array | string;
  readonly actionBuilderCodeHash: Uint8Array | string;
}

export interface HyperliquidTestnetQuoteRuntimeInput {
  readonly enabled: boolean;
  readonly domain: DomainRef;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly templateRegistryRecordHash: Uint8Array | string;
  readonly candidateId: string;
  readonly capacityBaseAtoms: bigint;
  readonly solverId: string;
  readonly solverCapabilityManifestHash: Uint8Array | string;
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Uint8Array | string;
  readonly routeTtlMs: bigint;
  readonly quoteTtlMs: bigint;
  readonly marginBps: number;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly maxBookAgeMs: number;
  readonly maxBookSpreadBps: number;
  readonly tradingAccount: `0x${string}`;
  readonly market: HyperliquidTestnetQuoteMarketReadPort;
  readonly currentTimeMs: () => bigint;
  readonly nonceSource: AtomicQuoteNonceSource;
  readonly spot: HyperliquidTestnetQuoteLeg;
  readonly perpetual: HyperliquidTestnetQuoteLeg;
  readonly accountBindings: readonly RouteAccountBindingInput[];
  readonly preconditions: RoutePayloadInput['preconditions'];
  readonly postconditions: RoutePayloadInput['postconditions'];
  readonly evidenceRequirements: EvidenceRequirementsInput;
  readonly recovery: HyperliquidTestnetRecoveryIdentity;
}

export interface QuoteProviders {
  readonly candidates: InternalAtomicQuoteCandidateProvider;
  readonly terms: InternalAtomicQuoteTermsProvider;
}

/** Signs a complete-package EXIT quote for one package of the omnibus account. */
export type HyperliquidTestnetExitQuoter = (input: Readonly<{
  order: PackageOrder;
  orderHash: Hash32;
  signer: Ed25519AtomicQuoteSigner;
}>) => Promise<SignedHyperliquidTestnetExitQuote>;

export interface HyperliquidTestnetQuoteRuntime {
  readonly providers: QuoteProviders;
  readonly exit: HyperliquidTestnetExitQuoter;
}

function validateConfiguration(input: HyperliquidTestnetQuoteRuntimeInput): void {
  try {
    if (!input.enabled
      || input.domain.domainId !== 'hypercore:testnet'
      || input.capacityBaseAtoms <= 0n
      || typeof input.currentTimeMs !== 'function'
      || typeof input.nonceSource?.next !== 'function'
      || input.market?.environment !== 'testnet'
      || input.market.apiUrl !== HYPERLIQUID_TESTNET_MARKET_INFO_URL
      || typeof input.market.l2Book !== 'function'
      || typeof input.market.userFees !== 'function'
      || typeof input.tradingAccount !== 'string'
      || !ADDRESS.test(input.tradingAccount)
      || !Number.isSafeInteger(input.maxBookAgeMs)
      || input.maxBookAgeMs <= 0
      || input.accountBindings.length === 0
      || input.spot.action.sequence !== 0
      || input.perpetual.action.sequence !== 1
      || input.recovery.controllerId.length === 0
      || input.recovery.authorityModeId.length === 0) {
      throw new Error('missing required configuration');
    }
    if (!sameAdapter(input.spot.action.adapter!, input.spot.adapter)
      || !sameAdapter(input.perpetual.action.adapter!, input.perpetual.adapter)) {
      throw new Error('each leg action must name exactly that leg adapter');
    }
    domainRef(
      input.domain.domainId,
      input.domain.domainManifestVersion,
      input.domain.domainManifestHash,
    );
    manifestHash(input.packageTemplateManifestHash);
    manifestHash(input.templateRegistryRecordHash);
    manifestHash(input.solverCapabilityManifestHash);
    manifestHash(input.feePolicyManifestHash);
    manifestHash(input.recovery.controllerCodeHash);
    manifestHash(input.recovery.reconciledStateSchemaHash);
    manifestHash(input.recovery.actionBuilderCodeHash);
    const base = assetRef(
      input.baseAsset.assetId, input.baseAsset.assetManifestHash, input.baseAsset.decimals,
    );
    const quote = assetRef(
      input.quoteAsset.assetId, input.quoteAsset.assetManifestHash, input.quoteAsset.decimals,
    );
    if (sameAsset(base, quote)) throw new Error('base and quote assets must differ');
    for (const [leg, maximumDecimals] of [[input.spot, 8], [input.perpetual, 6]] as const) {
      if (typeof leg.coin !== 'string' || !/^[A-Za-z0-9@._:/-]{1,64}$/.test(leg.coin)
        || !Number.isSafeInteger(leg.sizeDecimals) || leg.sizeDecimals < 0
        || leg.sizeDecimals > maximumDecimals) {
        throw new Error('leg market identity is invalid');
      }
      adapterRef(leg.adapter);
      versionedManifestRef(
        leg.venue.subjectId,
        leg.venue.manifestVersion,
        leg.venue.manifestHash,
      );
      versionedManifestRef(
        leg.market.subjectId,
        leg.market.manifestVersion,
        leg.market.manifestHash,
      );
    }
    requirePositive(input.routeTtlMs, 'routeTtlMs');
    requirePositive(input.quoteTtlMs, 'quoteTtlMs');
    requireBps(input.marginBps, 'marginBps');
    requireBps(input.maxBookSpreadBps, 'maxBookSpreadBps');
  } catch (error) {
    throw new Error(`Hyperliquid Testnet quote runtime configuration is incomplete or invalid: ${
      error instanceof Error ? error.message : 'invalid value'}`);
  }
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function requirePositive(value: bigint, name: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > U256_MAX) {
    throw new Error(`${name} must be a nonzero u256`);
  }
  return value;
}

function requireBps(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${name} must be an integer from 0 through 10000`);
  }
  return BigInt(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('invalid unsigned division');
  return (numerator + denominator - 1n) / denominator;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

type Decimal = ReturnType<typeof hyperliquidTestnetDecimal>;
type Book = ReturnType<typeof checkedHyperliquidTestnetBook>;

/** An exact nonnegative rational amount of quote atoms. */
interface QuoteValue {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function compareDecimals(left: Decimal, right: Decimal): number {
  const scale = Math.max(left.scale, right.scale);
  const normalizedLeft = left.atoms * pow10(scale - left.scale);
  const normalizedRight = right.atoms * pow10(scale - right.scale);
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function reducedPrice(base: AssetRef, quote: AssetRef, quoteAtoms: bigint, baseAtoms: bigint): ExactPrice {
  const divisor = gcd(quoteAtoms, baseAtoms);
  return exactPrice({
    baseAsset: base, quoteAsset: quote, quoteAtoms: quoteAtoms / divisor, baseAtoms: baseAtoms / divisor,
    roundingDirection: 'FLOOR',
  });
}

// A user fee rate is a nonnegative decimal fraction strictly below one. A missing or malformed
// rate never defaults to zero.
function feeRate(value: unknown, name: string): Readonly<{ numerator: bigint; denominator: bigint }> {
  if (typeof value !== 'string') throw new Error(`${name} is unavailable`);
  const parsed = hyperliquidTestnetDecimal(value, name);
  const denominator = pow10(parsed.scale);
  if (parsed.atoms >= denominator) throw new Error(`${name} must be below one`);
  return Object.freeze({ numerator: parsed.atoms, denominator });
}

function liveBook(
  value: Awaited<ReturnType<HyperliquidTestnetQuoteMarketReadPort['l2Book']>>,
  coin: string,
  name: string,
  now: bigint,
  input: HyperliquidTestnetQuoteRuntimeInput,
): Book {
  const book = checkedHyperliquidTestnetBook(value, coin, name);
  const time = BigInt(book.time);
  if (time > now || now - time > BigInt(input.maxBookAgeMs)) {
    throw new Error(`${name} is stale or future-dated`);
  }
  const bid = hyperliquidTestnetDecimal(book.levels[0][0]!.px, `${name} best bid`);
  const ask = hyperliquidTestnetDecimal(book.levels[1][0]!.px, `${name} best ask`);
  if (compareDecimals(bid, ask) >= 0) throw new Error(`${name} is crossed or locked`);
  const scale = Math.max(bid.scale, ask.scale);
  const bidAtoms = bid.atoms * pow10(scale - bid.scale);
  const askAtoms = ask.atoms * pow10(scale - ask.scale);
  if ((askAtoms - bidAtoms) * BPS_SCALE > bidAtoms * BigInt(input.maxBookSpreadBps)) {
    throw new Error(`${name} bid-ask spread exceeds the configured cap`);
  }
  return book;
}

/**
 * Takes the side-appropriate levels in book order until the base quantity is filled. Levels beyond
 * the wire limit price are never counted, and a book that cannot fill the whole quantity fails.
 */
function sweep(
  book: Book,
  side: 'BUY' | 'SELL',
  quantityAtoms: bigint,
  limit: HypercoreFormattedPrice,
  base: AssetRef,
  quote: AssetRef,
  name: string,
): QuoteValue {
  const limitDecimal = Object.freeze({ atoms: limit.scaled, scale: limit.decimals });
  const levels = side === 'BUY' ? book.levels[1] : book.levels[0];
  const fills: Array<Readonly<{ atoms: bigint; price: Decimal }>> = [];
  let remaining = quantityAtoms;
  let scale = 0;
  for (const level of levels) {
    if (remaining === 0n) break;
    const price = hyperliquidTestnetDecimal(level.px, `${name} price`);
    const relation = compareDecimals(price, limitDecimal);
    if (side === 'BUY' ? relation > 0 : relation < 0) break;
    const size = hyperliquidTestnetDecimal(level.sz, `${name} size`);
    // Book size finer than one base atom cannot be counted as available.
    const available = size.scale <= base.decimals
      ? size.atoms * pow10(base.decimals - size.scale)
      : size.atoms / pow10(size.scale - base.decimals);
    const taken = available < remaining ? available : remaining;
    if (taken === 0n) continue;
    fills.push(Object.freeze({ atoms: taken, price }));
    remaining -= taken;
    scale = Math.max(scale, price.scale);
  }
  if (remaining !== 0n) {
    throw new Error(`${name} cannot fill the requested size within the signed limit`);
  }
  let total = 0n;
  for (const fill of fills) total += fill.atoms * fill.price.atoms * pow10(scale - fill.price.scale);
  return Object.freeze({
    numerator: total * pow10(quote.decimals),
    denominator: pow10(scale + base.decimals),
  });
}

function entrySpread(
  base: AssetRef,
  quote: AssetRef,
  spotNotional: bigint,
  grossSpotAtoms: bigint,
  perpNotional: bigint,
  perpAtoms: bigint,
): ExactSignedRate {
  // entrySpread = spot notional / gross spot quantity - perpetual notional / perpetual quantity.
  const numerator = spotNotional * perpAtoms - perpNotional * grossSpotAtoms;
  const denominator = grossSpotAtoms * perpAtoms;
  const divisor = numerator === 0n ? denominator : gcd(numerator, denominator);
  return exactSignedRate({
    baseAsset: base, quoteAsset: quote,
    quoteAtoms: numerator / divisor, baseAtoms: denominator / divisor,
    roundingDirection: 'CEIL',
  });
}

function canonicalAmounts(amounts: readonly AssetAmount[]): readonly AssetAmount[] {
  const key = (asset: AssetRef) => canonicalBytes((writer) => encodeAssetRef(writer, asset));
  return Object.freeze([...amounts].sort((left, right) => compareBytes(key(left.asset), key(right.asset))));
}

function recoverySlot(
  action: RecoveryAction,
  sequence: number,
  order: PackageOrder,
  input: HyperliquidTestnetQuoteRuntimeInput,
): RecoveryActionSlotInput {
  const spot = input.spot;
  const perpetual = input.perpetual;
  // An exit sells spot and buys the short back, so completing and rolling back trade the opposite
  // sides of an entry; only the perpetual buy-back is reduce-only.
  const exit = order.action === 'EXIT';
  if (action === 'CANCEL_OPEN_ORDERS') {
    return { sequence, action, targetLeg: 1, adapter: perpetual.adapter, markets: [perpetual.market] };
  }
  if (action === 'COMPLETE_SPOT' || action === 'ROLLBACK_SPOT') {
    const buys = (action === 'COMPLETE_SPOT') !== exit;
    return {
      sequence, action, targetLeg: 0, adapter: spot.adapter, markets: [spot.market],
      maxQuantity: order.hyperliquidGrossSpotQuantity!,
      limitPrice: buys ? order.maxRecoverySpotBuyPrice! : order.minRecoverySpotSellPrice!,
      reduceOnly: false, timeInForce: 'IOC',
    };
  }
  const buys = (action === 'COMPLETE_PERP') === exit;
  return {
    sequence, action, targetLeg: 1, adapter: perpetual.adapter, markets: [perpetual.market],
    maxQuantity: order.quantity,
    limitPrice: buys ? order.maxRecoveryPerpBuyPrice! : order.minRecoveryPerpSellPrice!,
    reduceOnly: buys, timeInForce: 'IOC',
  };
}

function requireOrder(
  order: PackageOrder,
  input: HyperliquidTestnetQuoteRuntimeInput,
  action: PackageOrder['action'] = 'ENTRY',
): void {
  if (!input.enabled) throw new Error('Hyperliquid Testnet quote runtime is disabled');
  if (order.environment !== 'testnet'
    || order.domain.domainId !== 'hypercore:testnet'
    || order.expiryUnit !== 'HYPERLIQUID_UNIX_MILLISECONDS'
    || order.settlementClass !== 'BATCHED_IOC_WITH_RECOVERY'
    || order.action !== action
    || !sameDomain(order.domain, input.domain)) {
    throw new Error('order is outside the configured Hyperliquid Testnet quote domain');
  }
  if (order.templateId !== input.templateId
    || order.templateVersion !== input.templateVersion
    || !bytesEqual(
      order.packageTemplateManifestHash,
      manifestHash(input.packageTemplateManifestHash, 'packageTemplateManifestHash'),
    )) {
    throw new Error('order package template does not match the configured manifest');
  }
  if (!order.permittedSpotAdapters.some((adapter) => sameAdapter(adapter, input.spot.adapter))
    || !order.permittedPerpAdapters.some((adapter) => sameAdapter(adapter, input.perpetual.adapter))) {
    throw new Error('configured Hyperliquid adapters are not permitted by the order');
  }
  const quoteAsset = action === 'ENTRY' ? order.maxSpotQuoteIn?.asset : order.minSpotQuoteOut?.asset;
  const perpLimit = action === 'ENTRY' ? order.hyperliquidMinPerpSellPrice : order.hyperliquidMaxPerpBuyPrice;
  if (quoteAsset === undefined || perpLimit === undefined
    || !sameAsset(input.baseAsset, order.quantity.asset)
    || !sameAsset(input.quoteAsset, quoteAsset)
    || !sameAsset(perpLimit.baseAsset, input.baseAsset)
    || !sameAsset(perpLimit.quoteAsset, input.quoteAsset)) {
    throw new Error('configured Hyperliquid market assets do not match the order');
  }
}

async function build(order: PackageOrder, orderHash: Hash32, input: HyperliquidTestnetQuoteRuntimeInput) {
  requireOrder(order, input);
  const base = input.baseAsset;
  const quoteAsset = input.quoteAsset;
  const grossSpot = order.hyperliquidGrossSpotQuantity!;
  formatHypercoreSize(grossSpot.atoms, base.decimals, input.spot.sizeDecimals);
  formatHypercoreSize(order.quantity.atoms, base.decimals, input.perpetual.sizeDecimals);

  // Each IOC limit is the trader's signed bound: the spot cap divided by the gross spot quantity,
  // and the exact signed minimum perpetual sell price. The book sweep prices the expected fill.
  const spotBound = reducedPrice(base, quoteAsset, order.maxSpotQuoteIn!.atoms, grossSpot.atoms);
  const spotWire = formatHypercorePrice(spotBound, 8 - input.spot.sizeDecimals);
  const spotLimit = reducedPrice(
    base, quoteAsset,
    spotWire.scaled * pow10(quoteAsset.decimals), pow10(spotWire.decimals + base.decimals),
  );
  const perpLimit = order.hyperliquidMinPerpSellPrice!;
  const perpWire = formatHypercorePrice(perpLimit, 6 - input.perpetual.sizeDecimals);
  if (compareHypercoreWirePriceToExact(perpWire, perpLimit) < 0) {
    throw new Error('signed perpetual limit is not representable as a HyperCore sell limit');
  }

  const [spotBookValue, perpBookValue, fees] = await Promise.all([
    input.market.l2Book(input.spot.coin),
    input.market.l2Book(input.perpetual.coin),
    input.market.userFees(input.tradingAccount),
  ]);
  const now = requirePositive(input.currentTimeMs(), 'currentTimeMs');
  if (now >= order.expiryValue) throw new Error('order is expired');
  const spotBook = liveBook(spotBookValue, input.spot.coin, 'spot book', now, input);
  const perpBook = liveBook(perpBookValue, input.perpetual.coin, 'perpetual book', now, input);
  const spotFeeRate = feeRate(fees?.userSpotCrossRate, 'userSpotCrossRate');
  const perpFeeRate = feeRate(fees?.userCrossRate, 'userCrossRate');

  const quoteTtl = requirePositive(input.quoteTtlMs, 'quoteTtlMs');
  // The initial action expiry (the route expiry) must end strictly before both the package expiry
  // and the quote validity, so the quote always outlives the action it prices.
  const routeExpiryValue = [
    order.expiryValue - 1n,
    now + requirePositive(input.routeTtlMs, 'routeTtlMs'),
    now + quoteTtl - 1n,
  ].reduce((left, right) => left < right ? left : right);
  if (routeExpiryValue <= now) throw new Error('configured freshness window is empty');
  const quoteValidUntilValue = order.expiryValue < now + quoteTtl ? order.expiryValue : now + quoteTtl;

  const spotCost = sweep(spotBook, 'BUY', grossSpot.atoms, spotWire, base, quoteAsset, 'spot book');
  const perpProceeds = sweep(
    perpBook, 'SELL', order.quantity.atoms, perpWire, base, quoteAsset, 'perpetual book',
  );
  // Expected amounts round against the trader: spot cost and every fee up, perpetual proceeds down.
  const spotNotional = ceilDiv(spotCost.numerator, spotCost.denominator);
  const perpNotional = perpProceeds.numerator / perpProceeds.denominator;
  if (spotNotional > order.maxSpotQuoteIn!.atoms) throw new Error('spot sweep exceeds the order cap');
  if (perpNotional <= 0n) throw new Error('perpetual sweep notional is zero');
  // HyperCore charges a spot buy's taker fee in the received base asset.
  const baseFeeAtoms = ceilDiv(grossSpot.atoms * spotFeeRate.numerator, spotFeeRate.denominator);
  const perpFeeAtoms = ceilDiv(
    perpProceeds.numerator * perpFeeRate.numerator,
    perpProceeds.denominator * perpFeeRate.denominator,
  );
  const netSpotAtoms = grossSpot.atoms - baseFeeAtoms;
  if (netSpotAtoms < order.hyperliquidMinNetSpotDelta!.atoms
    || netSpotAtoms > order.hyperliquidMaxNetSpotDelta!.atoms) {
    throw new Error('net spot quantity after the base-asset fee is outside the signed interval');
  }
  const residualAtoms = netSpotAtoms - order.quantity.atoms;
  const absoluteResidual = residualAtoms < 0n ? -residualAtoms : residualAtoms;
  const valuation = order.hyperliquidResidualValuationReferencePrice;
  if (absoluteResidual !== 0n && valuation === undefined) {
    throw new Error('a nonzero residual requires the signed residual valuation price');
  }
  const residualQuoteAtoms = absoluteResidual === 0n
    ? 0n
    : ceilDiv(absoluteResidual * valuation!.quoteAtoms, valuation!.baseAtoms);
  if (absoluteResidual > order.hyperliquidMaxTerminalResidualBaseQuantity!.atoms
    || residualQuoteAtoms > order.hyperliquidMaxTerminalResidualQuoteValue!.atoms) {
    throw new Error('expected terminal residual exceeds the signed caps');
  }
  const baseFeeQuoteAtoms = ceilDiv(
    baseFeeAtoms * spotCost.numerator,
    spotCost.denominator * grossSpot.atoms,
  );
  const marginAtoms = ceilDiv(perpNotional * requireBps(input.marginBps, 'marginBps'), BPS_SCALE);
  const route: RoutePayloadInput = {
    version: 1,
    environment: order.environment,
    domain: order.domain,
    orderHash,
    templateId: order.templateId,
    templateVersion: order.templateVersion,
    packageTemplateManifestHash: order.packageTemplateManifestHash,
    templateRegistryRecordHash: input.templateRegistryRecordHash,
    owner: order.owner,
    settlementAccount: order.settlementAccount,
    solver: input.solverId,
    direction: order.direction,
    action: order.action,
    quantityPolicyClass: order.hyperliquidQuantityPolicy!,
    partialFillPolicy: order.partialFillPolicy,
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    executionPlanKind: 'HYPERCORE_BATCHED_IOC',
    routeExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    routeExpiryValue,
    feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash,
    accountBindings: input.accountBindings,
    serviceCharges: [],
    preconditions: input.preconditions,
    legs: [
      {
        legIndex: 0, legRole: 'SPOT', actionSequence: input.spot.action.sequence,
        adapter: input.spot.adapter, venue: input.spot.venue, market: input.spot.market,
        baseAsset: order.quantity.asset, quoteAsset, side: 'BUY', quantity: grossSpot,
        limitPrice: spotLimit, timeInForce: 'IOC', reduceOnly: false,
      },
      {
        legIndex: 1, legRole: 'PERPETUAL', actionSequence: input.perpetual.action.sequence,
        adapter: input.perpetual.adapter, venue: input.perpetual.venue, market: input.perpetual.market,
        baseAsset: order.quantity.asset, quoteAsset, side: 'SELL', quantity: order.quantity,
        limitPrice: perpLimit, timeInForce: 'IOC', reduceOnly: false,
      },
    ],
    actions: [input.spot.action, input.perpetual.action],
    postconditions: input.postconditions,
    evidenceRequirements: input.evidenceRequirements,
    recoveryPlan: {
      ...input.recovery,
      recoveryExpiryUnit: order.hyperliquidRecoveryExpiryUnit!,
      maxActionExpiryValue: order.hyperliquidMaxRecoveryActionExpiryValue!,
      deadlineValue: order.hyperliquidRecoveryDeadlineValue!,
      minRecoveryWindowMs: order.hyperliquidMinRecoveryWindowMs!,
      maxRecoveryCostCaps: order.maxRecoveryCostAtomsByAsset,
      maxAggregateRecoveryLoss: order.maxAggregateRecoveryLossQuote,
      maxIntermediateResidual: order.quantity,
      maxTerminalResidual: order.hyperliquidMaxTerminalResidualBaseQuantity!,
      actionSlots: order.allowedRecoveryActions.map((action, sequence) =>
        recoverySlot(action, sequence, order, input)),
    },
  };
  const candidate: AtomicRouteCandidate = Object.freeze({
    candidateId: input.candidateId,
    active: true,
    capacityBaseAtoms: input.capacityBaseAtoms,
    expectedNetPackageOutcomeQuoteAtoms: perpNotional - spotNotional - perpFeeAtoms,
    expectedTotalFeesQuoteAtoms: perpFeeAtoms + baseFeeQuoteAtoms,
    evidenceGrade: 'HYPERLIQUID_TESTNET_REFERENCE',
    route,
  });
  // No builder is attached to Naryx Hyperliquid orders, so builder fees are zero and the raw fill
  // fee equals the normalized venue fee for each asset.
  const venueFees = canonicalAmounts([
    { asset: base, atoms: baseFeeAtoms },
    { asset: quoteAsset, atoms: perpFeeAtoms },
  ]);
  const builderFees = venueFees.map((fee) => Object.freeze({ asset: fee.asset, atoms: 0n }));
  const terms: Omit<AtomicEntryQuoteTerms, 'quoteNonce'> = Object.freeze({
    solverId: input.solverId,
    solverCapabilityManifestHash: input.solverCapabilityManifestHash,
    quotedOutcome: {
      kind: 'ENTRY_SPREAD' as const,
      entrySpread: entrySpread(
        base, quoteAsset, spotNotional, grossSpot.atoms, perpNotional, order.quantity.atoms,
      ),
    },
    expectedSpotNotional: { asset: quoteAsset, atoms: spotNotional },
    expectedPerpNotional: { asset: quoteAsset, atoms: perpNotional },
    expectedGrossSpotQuantity: grossSpot,
    expectedNetSpotQuantity: { asset: base, atoms: netSpotAtoms },
    expectedBaseAssetFee: { asset: base, atoms: baseFeeAtoms },
    expectedTerminalResidualBaseQuantity: { asset: base, atoms: absoluteResidual },
    expectedTerminalResidualQuoteValue: { asset: quoteAsset, atoms: residualQuoteAtoms },
    expectedMarginDelta: { asset: quoteAsset, atoms: marginAtoms },
    expectedRawFillFeesByAsset: venueFees,
    expectedBuilderFeesByAsset: builderFees,
    expectedNormalizedVenueFeesByAsset: venueFees,
    solverFee: { asset: quoteAsset, atoms: 0n },
    protocolFee: { asset: quoteAsset, atoms: 0n },
    expectedPriorityFee: { asset: quoteAsset, atoms: 0n },
    maxRecoveryCostAtomsByAsset: order.maxRecoveryCostAtomsByAsset,
    feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash,
    validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    validUntilValue: quoteValidUntilValue,
  });
  return Object.freeze({ candidate, terms });
}

/**
 * Prices a complete-package exit of one package held in the omnibus account: sell exactly the
 * package's spot and buy back exactly its short, both IOC at the trader's signed limits.
 */
export async function buildHyperliquidTestnetExit(
  order: PackageOrder,
  orderHash: Hash32,
  input: HyperliquidTestnetQuoteRuntimeInput,
): Promise<Readonly<{ route: RoutePayloadInput; terms: Omit<AtomicEntryQuoteTerms, 'quoteNonce'> }>> {
  requireOrder(order, input, 'EXIT');
  const base = input.baseAsset;
  const quoteAsset = input.quoteAsset;
  const grossSpot = order.hyperliquidGrossSpotQuantity!;
  const minSpotQuoteOut = order.minSpotQuoteOut!;
  const minOutcome = order.minExitQuoteOutcome!;
  formatHypercoreSize(grossSpot.atoms, base.decimals, input.spot.sizeDecimals);
  formatHypercoreSize(order.quantity.atoms, base.decimals, input.perpetual.sizeDecimals);
  if (minSpotQuoteOut.atoms <= 0n) throw new Error('exit order needs a positive spot proceeds floor');

  // The spot sell floor is the signed minimum proceeds over the gross spot sold, rounded up onto
  // the wire; the perpetual buy-back cap is the exact signed maximum, which must not round up.
  const divisor = gcd(minSpotQuoteOut.atoms, grossSpot.atoms);
  const spotWire = formatHypercorePrice(exactPrice({
    baseAsset: base, quoteAsset,
    quoteAtoms: minSpotQuoteOut.atoms / divisor, baseAtoms: grossSpot.atoms / divisor,
    roundingDirection: 'CEIL',
  }), 8 - input.spot.sizeDecimals);
  const spotLimit = reducedPrice(
    base, quoteAsset,
    spotWire.scaled * pow10(quoteAsset.decimals), pow10(spotWire.decimals + base.decimals),
  );
  const perpLimit = order.hyperliquidMaxPerpBuyPrice!;
  const perpWire = formatHypercorePrice(perpLimit, 6 - input.perpetual.sizeDecimals);
  if (compareHypercoreWirePriceToExact(perpWire, perpLimit) > 0) {
    throw new Error('signed perpetual limit is not representable as a HyperCore buy limit');
  }

  const [spotBookValue, perpBookValue, fees] = await Promise.all([
    input.market.l2Book(input.spot.coin),
    input.market.l2Book(input.perpetual.coin),
    input.market.userFees(input.tradingAccount),
  ]);
  const now = requirePositive(input.currentTimeMs(), 'currentTimeMs');
  if (now >= order.expiryValue) throw new Error('order is expired');
  const spotBook = liveBook(spotBookValue, input.spot.coin, 'spot book', now, input);
  const perpBook = liveBook(perpBookValue, input.perpetual.coin, 'perpetual book', now, input);
  const spotFeeRate = feeRate(fees?.userSpotCrossRate, 'userSpotCrossRate');
  const perpFeeRate = feeRate(fees?.userCrossRate, 'userCrossRate');
  const quoteTtl = requirePositive(input.quoteTtlMs, 'quoteTtlMs');
  const routeExpiryValue = [
    order.expiryValue - 1n,
    now + requirePositive(input.routeTtlMs, 'routeTtlMs'),
    now + quoteTtl - 1n,
  ].reduce((left, right) => left < right ? left : right);
  if (routeExpiryValue <= now) throw new Error('configured freshness window is empty');
  const quoteValidUntilValue = order.expiryValue < now + quoteTtl ? order.expiryValue : now + quoteTtl;

  const spotProceeds = sweep(spotBook, 'SELL', grossSpot.atoms, spotWire, base, quoteAsset, 'spot book');
  const perpCost = sweep(perpBook, 'BUY', order.quantity.atoms, perpWire, base, quoteAsset, 'perpetual book');
  // Against the trader: proceeds round down, the buy-back cost and every fee round up. HyperCore
  // charges a spot sell's taker fee in the received quote asset, so the base delta is exact.
  const spotNotional = spotProceeds.numerator / spotProceeds.denominator;
  const perpNotional = ceilDiv(perpCost.numerator, perpCost.denominator);
  if (spotNotional < minSpotQuoteOut.atoms) throw new Error('spot sweep is below the signed proceeds floor');
  const spotFeeAtoms = ceilDiv(
    spotProceeds.numerator * spotFeeRate.numerator,
    spotProceeds.denominator * spotFeeRate.denominator,
  );
  const perpFeeAtoms = ceilDiv(
    perpCost.numerator * perpFeeRate.numerator,
    perpCost.denominator * perpFeeRate.denominator,
  );
  const netSpotAtoms = -grossSpot.atoms;
  if (netSpotAtoms < order.hyperliquidMinNetSpotDelta!.atoms
    || netSpotAtoms > order.hyperliquidMaxNetSpotDelta!.atoms) {
    throw new Error('exit net spot quantity is outside the signed interval');
  }
  const residualAtoms = netSpotAtoms + order.quantity.atoms;
  const absoluteResidual = residualAtoms < 0n ? -residualAtoms : residualAtoms;
  const valuation = order.hyperliquidResidualValuationReferencePrice;
  if (absoluteResidual !== 0n && valuation === undefined) {
    throw new Error('a nonzero residual requires the signed residual valuation price');
  }
  const residualQuoteAtoms = absoluteResidual === 0n
    ? 0n
    : ceilDiv(absoluteResidual * valuation!.quoteAtoms, valuation!.baseAtoms);
  if (absoluteResidual > order.hyperliquidMaxTerminalResidualBaseQuantity!.atoms
    || residualQuoteAtoms > order.hyperliquidMaxTerminalResidualQuoteValue!.atoms) {
    throw new Error('expected terminal residual exceeds the signed caps');
  }
  // exitQuoteOutcome v1: spot proceeds less the spot fee, plus the short's entry notional less the
  // buy-back notional and its fee.
  const outcome = spotNotional - spotFeeAtoms
    + order.expectedPrePositionEntryNotional.atoms - perpNotional - perpFeeAtoms;
  if (outcome < minOutcome.atoms) throw new Error('exit outcome is below the signed minimum');
  const route: RoutePayloadInput = {
    version: 1,
    environment: order.environment,
    domain: order.domain,
    orderHash,
    templateId: order.templateId,
    templateVersion: order.templateVersion,
    packageTemplateManifestHash: order.packageTemplateManifestHash,
    templateRegistryRecordHash: input.templateRegistryRecordHash,
    owner: order.owner,
    settlementAccount: order.settlementAccount,
    solver: input.solverId,
    direction: order.direction,
    action: order.action,
    quantityPolicyClass: order.hyperliquidQuantityPolicy!,
    partialFillPolicy: order.partialFillPolicy,
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    executionPlanKind: 'HYPERCORE_BATCHED_IOC',
    routeExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    routeExpiryValue,
    feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash,
    accountBindings: input.accountBindings,
    serviceCharges: [],
    preconditions: input.preconditions,
    legs: [
      {
        legIndex: 0, legRole: 'SPOT', actionSequence: input.spot.action.sequence,
        adapter: input.spot.adapter, venue: input.spot.venue, market: input.spot.market,
        baseAsset: order.quantity.asset, quoteAsset, side: 'SELL', quantity: grossSpot,
        limitPrice: spotLimit, timeInForce: 'IOC', reduceOnly: false,
      },
      {
        legIndex: 1, legRole: 'PERPETUAL', actionSequence: input.perpetual.action.sequence,
        adapter: input.perpetual.adapter, venue: input.perpetual.venue, market: input.perpetual.market,
        baseAsset: order.quantity.asset, quoteAsset, side: 'BUY', quantity: order.quantity,
        limitPrice: perpLimit, timeInForce: 'IOC', reduceOnly: true,
      },
    ],
    actions: [input.spot.action, input.perpetual.action],
    postconditions: input.postconditions,
    evidenceRequirements: input.evidenceRequirements,
    recoveryPlan: {
      ...input.recovery,
      recoveryExpiryUnit: order.hyperliquidRecoveryExpiryUnit!,
      maxActionExpiryValue: order.hyperliquidMaxRecoveryActionExpiryValue!,
      deadlineValue: order.hyperliquidRecoveryDeadlineValue!,
      minRecoveryWindowMs: order.hyperliquidMinRecoveryWindowMs!,
      maxRecoveryCostCaps: order.maxRecoveryCostAtomsByAsset,
      maxAggregateRecoveryLoss: order.maxAggregateRecoveryLossQuote,
      maxIntermediateResidual: order.quantity,
      maxTerminalResidual: order.hyperliquidMaxTerminalResidualBaseQuantity!,
      actionSlots: order.allowedRecoveryActions.map((action, sequence) =>
        recoverySlot(action, sequence, order, input)),
    },
  };
  // Every exit fee is charged in the quote asset, so the base-asset fee is zero; no builder is attached.
  const venueFees = canonicalAmounts([
    { asset: base, atoms: 0n },
    { asset: quoteAsset, atoms: spotFeeAtoms + perpFeeAtoms },
  ]);
  const terms: Omit<AtomicEntryQuoteTerms, 'quoteNonce'> = Object.freeze({
    solverId: input.solverId,
    solverCapabilityManifestHash: input.solverCapabilityManifestHash,
    quotedOutcome: {
      kind: 'EXIT_QUOTE_OUTCOME' as const,
      exitQuoteOutcome: { asset: quoteAsset, atoms: outcome },
    },
    expectedSpotNotional: { asset: quoteAsset, atoms: spotNotional },
    expectedPerpNotional: { asset: quoteAsset, atoms: perpNotional },
    expectedGrossSpotQuantity: grossSpot,
    expectedNetSpotQuantity: { asset: base, atoms: netSpotAtoms },
    expectedBaseAssetFee: { asset: base, atoms: 0n },
    expectedTerminalResidualBaseQuantity: { asset: base, atoms: absoluteResidual },
    expectedTerminalResidualQuoteValue: { asset: quoteAsset, atoms: residualQuoteAtoms },
    expectedMarginDelta: { asset: quoteAsset, atoms: 0n },
    expectedRawFillFeesByAsset: venueFees,
    expectedBuilderFeesByAsset: venueFees.map((fee) => Object.freeze({ asset: fee.asset, atoms: 0n })),
    expectedNormalizedVenueFeesByAsset: venueFees,
    solverFee: { asset: quoteAsset, atoms: 0n },
    protocolFee: { asset: quoteAsset, atoms: 0n },
    expectedPriorityFee: { asset: quoteAsset, atoms: 0n },
    maxRecoveryCostAtomsByAsset: order.maxRecoveryCostAtomsByAsset,
    feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash,
    validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    validUntilValue: quoteValidUntilValue,
  });
  return Object.freeze({ route, terms });
}

export function createHyperliquidTestnetQuoteRuntime(
  input: HyperliquidTestnetQuoteRuntimeInput,
): HyperliquidTestnetQuoteRuntime {
  if (!input.enabled) throw new Error('Hyperliquid Testnet quote runtime is disabled');
  validateConfiguration(input);
  // Terms are taken from the same market snapshot that produced the selected candidate. A missing
  // or superseded snapshot fails closed instead of re-reading the market.
  const prepared = new Map<string, Awaited<ReturnType<typeof build>>>();
  const key = (orderHash: Hash32) => Buffer.from(orderHash).toString('hex');
  const candidates: InternalAtomicQuoteCandidateProvider = async ({ order, orderHash }) => {
    const created = await build(order, orderHash, input);
    prepared.delete(key(orderHash));
    prepared.set(key(orderHash), created);
    while (prepared.size > MAX_PREPARED_QUOTES) prepared.delete(prepared.keys().next().value!);
    return [created.candidate];
  };
  const terms: InternalAtomicQuoteTermsProvider = ({ decision }: Readonly<{
    order: PackageOrder;
    decision: AtomicRouteDecision;
  }>) => {
    const created = prepared.get(key(decision.orderHash));
    if (created === undefined) throw new Error('no live Hyperliquid Testnet quote was prepared for the order');
    if (decision.candidateId !== input.candidateId
      || !bytesEqual(routeHash(created.candidate.route), decision.routeHash)
      || decision.expectedNetPackageOutcomeQuoteAtoms
        !== created.candidate.expectedNetPackageOutcomeQuoteAtoms
      || decision.expectedTotalFeesQuoteAtoms !== created.candidate.expectedTotalFeesQuoteAtoms) {
      throw new Error('route decision does not match the prepared Hyperliquid Testnet quote');
    }
    prepared.delete(key(decision.orderHash));
    const quoteNonce = input.nonceSource.next();
    if (quoteNonce <= 0n || quoteNonce > U256_MAX) throw new Error('quote nonce must be a nonzero u256');
    return Object.freeze({ ...created.terms, quoteNonce });
  };
  const exit: HyperliquidTestnetExitQuoter = async ({ order, orderHash, signer }) => {
    const built = await buildHyperliquidTestnetExit(order, orderHash, input);
    const quoteNonce = input.nonceSource.next();
    if (quoteNonce <= 0n || quoteNonce > U256_MAX) throw new Error('quote nonce must be a nonzero u256');
    return signHyperliquidTestnetExitQuote({
      order, orderHash, route: built.route, terms: { ...built.terms, quoteNonce }, signer,
    });
  };
  return Object.freeze({ providers: Object.freeze({ candidates, terms }), exit });
}

export function composeQuoteProviders(
  local: QuoteProviders | undefined,
  hyperliquid?: QuoteProviders,
  arbitrum?: QuoteProviders,
): QuoteProviders {
  const select = (order: PackageOrder) => {
    if (order.environment === 'local' && order.domain.domainId === 'svm:local'
      && local !== undefined) return local;
    if (order.environment === 'testnet' && order.domain.domainId === 'hypercore:testnet'
      && hyperliquid !== undefined) return hyperliquid;
    if (order.environment === 'testnet' && order.domain.domainId === 'eip155:421614'
      && arbitrum !== undefined) return arbitrum;
    throw new Error('no quote runtime is configured for the order domain');
  };
  const providers: QuoteProviders = {
    candidates: (value) => select(value.order).candidates(value),
    terms: (value) => select(value.order).terms(value),
  };
  return Object.freeze(providers);
}
