import { createHash } from 'node:crypto';
import {
  CASH_CARRY_TEMPLATE_ID,
  CASH_CARRY_TEMPLATE_VERSION,
  adapterRef,
  bytesEqual,
  domainRef,
  manifestHash,
  recoveryPlan,
  versionedManifestRef,
  type AdapterRef,
  type AssetRef,
  type CashCarrySeriesIdentityInput,
  type DomainRef,
  type ExactPrice,
  type Hash32,
  type LegExecution,
  type ManifestHash,
  type PackageAdmission,
  type RecoveryPlan,
  type TradeSide,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import {
  formatHypercorePrice,
  formatHypercoreSize,
  powerOfTen,
  type HypercoreFormattedPrice,
} from './wire-format.js';

export * from './strategy-planner.js';
export {
  formatHypercorePrice,
  formatHypercoreSize,
  type HypercoreFormattedPrice,
} from './wire-format.js';

const U32_MAX = 0xffff_ffff;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const CLIENT_ORDER_ID_DOMAIN = 'naryx/hypercore/client-order-id/v1';

export const HYPERCORE_IOC_ORDER_ACTION_CLASS_ID = 'hypercore-ioc-order-v1';
export const HYPERCORE_EXECUTION_GUARANTEE = 'BATCHED_IOC_WITH_BOUNDED_RECOVERY';

export interface HyperliquidMarketBindingInput {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly assetId: number;
  readonly sizeDecimals: number;
}

export interface HyperliquidExecutionPlannerOptions {
  readonly environment: 'testnet';
  readonly seriesIdentity: CashCarrySeriesIdentityInput;
  readonly spot: HyperliquidMarketBindingInput;
  readonly perpetual: HyperliquidMarketBindingInput;
}

export interface HyperliquidCompileOptions {
  /**
   * The trading account's live perpetual position, read by the executor under its lane lock. An
   * omnibus account holds other packages, so the account target is this position plus this
   * package's own delta. Absent, the order's signed pre-position is the account position.
   */
  readonly accountPrePerpPositionAtoms?: bigint;
}

export interface HypercoreOrderWire {
  readonly a: number;
  readonly b: boolean;
  readonly p: string;
  readonly s: string;
  readonly r: boolean;
  readonly t: Readonly<{ readonly limit: Readonly<{ readonly tif: 'Ioc' }> }>;
  readonly c: `0x${string}`;
}

export interface HypercoreBatchedOrderAction {
  readonly type: 'order';
  readonly orders: readonly [HypercoreOrderWire, HypercoreOrderWire];
  readonly grouping: 'na';
}

export interface HypercoreUnsignedRequestFields {
  readonly action: HypercoreBatchedOrderAction;
  readonly expiresAfter: number;
}

export interface HyperliquidPlanCommitments {
  readonly seriesManifestHash: ManifestHash;
  readonly executionClassManifestHash: ManifestHash;
  readonly orderHash: Hash32;
  readonly quoteHash: Hash32;
  readonly routeHash: Hash32;
}

export interface HyperliquidPlannedLeg {
  readonly role: 'SPOT' | 'PERPETUAL';
  readonly legIndex: number;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly side: TradeSide;
  readonly quantityAtoms: bigint;
  readonly sizeDecimals: number;
  readonly maxPriceDecimals: number;
  readonly signedBaseDeltaAtoms: bigint;
  readonly clientOrderId: `0x${string}`;
  readonly order: HypercoreOrderWire;
}

export type HyperliquidTerminalResidualPolicy =
  | Readonly<{
      kind: 'EXACT_NET';
      netSpotDeltaAtoms: bigint;
      maxTerminalResidualBaseAtoms: 0n;
      maxTerminalResidualQuoteAtoms: 0n;
    }>
  | Readonly<{
      kind: 'BOUNDED_NET';
      minNetSpotDeltaAtoms: bigint;
      maxNetSpotDeltaAtoms: bigint;
      maxTerminalResidualBaseAtoms: bigint;
      residualValuationSchemaVersion: number;
      residualValuationReferencePrice: ExactPrice;
      maxTerminalResidualQuoteAtoms: bigint;
    }>;

export interface HyperliquidExecutionPlan {
  readonly version: 1;
  readonly guarantee: typeof HYPERCORE_EXECUTION_GUARANTEE;
  readonly domain: DomainRef;
  readonly commitments: HyperliquidPlanCommitments;
  readonly requestExpiryMs: bigint;
  readonly unsignedRequestFields: HypercoreUnsignedRequestFields;
  readonly legs: readonly [HyperliquidPlannedLeg, HyperliquidPlannedLeg];
  readonly grossSpotQuantityAtoms: bigint;
  readonly prePerpPositionAtoms: bigint;
  readonly signedPerpDeltaAtoms: bigint;
  readonly signedPerpTargetAtoms: bigint;
  readonly terminalResidualPolicy: HyperliquidTerminalResidualPolicy;
  readonly recoveryPolicy: RecoveryPlan;
  readonly recoveryDeadlineMs: bigint;
}

interface HyperliquidMarketBinding {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly assetId: number;
  readonly sizeDecimals: number;
  readonly maxPriceDecimals: number;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkedU32(value: number, name: string): number {
  requireCondition(Number.isInteger(value) && value >= 0 && value <= U32_MAX, `${name} must fit u32`);
  return value;
}

function checkedDecimals(value: number, maximum: number, name: string): number {
  requireCondition(Number.isInteger(value) && value >= 0 && value <= maximum, `${name} must be between 0 and ${maximum}`);
  return value;
}

function normalizedMarket(
  input: HyperliquidMarketBindingInput,
  role: 'spot' | 'perpetual',
): HyperliquidMarketBinding {
  const maximumDecimals = role === 'spot' ? 8 : 6;
  const sizeDecimals = checkedDecimals(input.sizeDecimals, maximumDecimals, `${role}.sizeDecimals`);
  return Object.freeze({
    adapter: adapterRef({
      adapterId: input.adapter.adapterId,
      adapterManifestVersion: input.adapter.adapterManifestVersion,
      adapterManifestHash: input.adapter.adapterManifestHash,
    }, `${role}.adapter`),
    venue: versionedManifestRef(
      input.venue.subjectId,
      input.venue.manifestVersion,
      input.venue.manifestHash,
      `${role}.venue`,
    ),
    market: versionedManifestRef(
      input.market.subjectId,
      input.market.manifestVersion,
      input.market.manifestHash,
      `${role}.market`,
    ),
    assetId: checkedU32(input.assetId, `${role}.assetId`),
    sizeDecimals,
    maxPriceDecimals: maximumDecimals - sizeDecimals,
  });
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameManifestRef(left: VersionedManifestRef, right: VersionedManifestRef): boolean {
  return left.subjectId === right.subjectId
    && left.manifestVersion === right.manifestVersion
    && bytesEqual(left.manifestHash, right.manifestHash);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function samePrice(left: ExactPrice, right: ExactPrice): boolean {
  return left.baseAsset.assetId === right.baseAsset.assetId
    && left.baseAsset.decimals === right.baseAsset.decimals
    && bytesEqual(left.baseAsset.assetManifestHash, right.baseAsset.assetManifestHash)
    && left.quoteAsset.assetId === right.quoteAsset.assetId
    && left.quoteAsset.decimals === right.quoteAsset.decimals
    && bytesEqual(left.quoteAsset.assetManifestHash, right.quoteAsset.assetManifestHash)
    && left.quoteAtoms === right.quoteAtoms
    && left.baseAtoms === right.baseAtoms
    && left.roundingDirection === right.roundingDirection;
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function checkedHash(value: Hash32, name: string): Hash32 {
  requireCondition(value instanceof Uint8Array && value.length === 32, `${name} must be 32 bytes`);
  return Uint8Array.from(value) as Hash32;
}

function requireHash(actual: Uint8Array, expected: Uint8Array, name: string): void {
  requireCondition(bytesEqual(actual, expected), `${name} mismatch`);
}

function encodedPart(value: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function u32Bytes(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function clientOrderId(
  domain: DomainRef,
  seriesManifestHash: ManifestHash,
  executionClassManifestHash: ManifestHash,
  admission: PackageAdmission,
  role: 'SPOT' | 'PERPETUAL',
  assetId: number,
): `0x${string}` {
  const digest = createHash('sha256');
  for (const part of [
    Buffer.from(CLIENT_ORDER_ID_DOMAIN, 'ascii'),
    Buffer.from(domain.domainId, 'ascii'),
    u32Bytes(domain.domainManifestVersion),
    domain.domainManifestHash,
    seriesManifestHash,
    executionClassManifestHash,
    admission.orderHash,
    admission.quoteHash,
    admission.routeHash,
    Buffer.from(role, 'ascii'),
    u32Bytes(assetId),
  ]) {
    digest.update(encodedPart(part));
  }
  return `0x${digest.digest().subarray(0, 16).toString('hex')}`;
}

function requireLegBinding(
  leg: LegExecution,
  binding: HyperliquidMarketBinding,
  role: 'SPOT' | 'PERPETUAL',
): void {
  requireCondition(leg.legRole === role, `${role} leg role mismatch`);
  requireCondition(sameAdapter(leg.adapter, binding.adapter), `${role} adapter mismatch`);
  requireCondition(sameManifestRef(leg.venue, binding.venue), `${role} venue mismatch`);
  requireCondition(sameManifestRef(leg.market, binding.market), `${role} market mismatch`);
  requireCondition(leg.timeInForce === 'IOC', `${role} leg must use IOC`);
}

// The route expiry is the exact initial expiresAfter. Validity intervals are half-open, so it must
// be strictly earlier than both the package expiry and the selected quote's validity.
function requestExpiry(admission: PackageAdmission): bigint {
  const initial = admission.route.routeExpiryValue;
  requireCondition(initial > 0n && initial <= MAX_SAFE_INTEGER, 'request expiry must be a positive safe millisecond integer');
  requireCondition(initial < admission.order.expiryValue, 'initial action expiry must be strictly before the package expiry');
  requireCondition(initial < admission.quote.validUntilValue, 'initial action expiry must be strictly before the quote validity');
  return initial;
}

export function hypercoreQuoteAtomsAtWirePrice(
  baseAtoms: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  price: HypercoreFormattedPrice,
  roundUp: boolean,
): bigint {
  const numerator = baseAtoms * price.scaled * powerOfTen(quoteDecimals);
  const denominator = powerOfTen(baseDecimals + price.decimals);
  const quotient = numerator / denominator;
  return roundUp && numerator % denominator !== 0n ? quotient + 1n : quotient;
}

export function compareHypercoreWirePriceToExact(
  wire: HypercoreFormattedPrice,
  exact: ExactPrice,
): number {
  const left = wire.scaled
    * exact.baseAtoms
    * powerOfTen(exact.quoteAsset.decimals);
  const right = exact.quoteAtoms
    * powerOfTen(exact.baseAsset.decimals + wire.decimals);
  return left < right ? -1 : left > right ? 1 : 0;
}

function terminalResidualPolicy(
  admission: PackageAdmission,
  signedPerpDeltaAtoms: bigint,
): HyperliquidTerminalResidualPolicy {
  const { order, quote, route } = admission;
  const recovery = route.recoveryPlan;
  requireCondition(recovery !== undefined, 'HyperCore route requires a recovery plan');
  const min = order.hyperliquidMinNetSpotDelta;
  const max = order.hyperliquidMaxNetSpotDelta;
  const baseCap = order.hyperliquidMaxTerminalResidualBaseQuantity;
  const quoteCap = order.hyperliquidMaxTerminalResidualQuoteValue;
  const quotedBase = quote.expectedTerminalResidualBaseQuantity;
  const quotedQuote = quote.expectedTerminalResidualQuoteValue;
  requireCondition(min !== undefined && max !== undefined, 'signed net spot interval is missing');
  requireCondition(baseCap !== undefined && quoteCap !== undefined, 'signed terminal residual caps are missing');
  requireCondition(quotedBase !== undefined && quotedQuote !== undefined, 'quoted terminal residual is missing');
  requireCondition(recovery.maxTerminalResidual.atoms === baseCap.atoms, 'recovery terminal residual cap mismatch');
  requireCondition(quotedBase.atoms >= 0n && quotedBase.atoms <= baseCap.atoms, 'quoted base residual exceeds the signed cap');
  requireCondition(quotedQuote.atoms >= 0n && quotedQuote.atoms <= quoteCap.atoms, 'quoted residual value exceeds the signed cap');

  if (order.hyperliquidQuantityPolicy === 'EXACT_NET') {
    requireCondition(min.atoms === max.atoms, 'EXACT_NET requires one net spot delta');
    requireCondition(baseCap.atoms === 0n && quoteCap.atoms === 0n, 'EXACT_NET requires zero terminal residual');
    return Object.freeze({
      kind: 'EXACT_NET',
      netSpotDeltaAtoms: min.atoms,
      maxTerminalResidualBaseAtoms: 0n,
      maxTerminalResidualQuoteAtoms: 0n,
    });
  }

  requireCondition(order.hyperliquidQuantityPolicy === 'BOUNDED_NET', 'unsupported Hyperliquid quantity policy');
  const valuationVersion = order.hyperliquidResidualValuationSchemaVersion;
  const valuationPrice = order.hyperliquidResidualValuationReferencePrice;
  requireCondition(valuationVersion !== undefined && valuationPrice !== undefined, 'BOUNDED_NET valuation is missing');
  requireCondition(min.atoms <= max.atoms, 'BOUNDED_NET interval is descending');
  requireCondition(valuationVersion === 1, 'BOUNDED_NET valuation schema is unsupported');
  requireCondition(
    sameAsset(valuationPrice.baseAsset, baseCap.asset)
      && sameAsset(valuationPrice.quoteAsset, quoteCap.asset),
    'BOUNDED_NET valuation assets mismatch residual caps',
  );
  requireCondition(valuationPrice.quoteAtoms > 0n && valuationPrice.baseAtoms > 0n, 'BOUNDED_NET valuation price must be positive');
  for (const [endpoint, netSpotDeltaAtoms] of [['min', min.atoms], ['max', max.atoms]] as const) {
    const residual = netSpotDeltaAtoms + signedPerpDeltaAtoms;
    const absoluteResidual = residual < 0n ? -residual : residual;
    requireCondition(absoluteResidual <= baseCap.atoms, `BOUNDED_NET ${endpoint} endpoint exceeds residual base cap`);
    const numerator = absoluteResidual * valuationPrice.quoteAtoms;
    // A residual cap rounds exposure upward regardless of the price's execution rounding direction.
    const quoteValue = numerator / valuationPrice.baseAtoms
      + (numerator % valuationPrice.baseAtoms === 0n ? 0n : 1n);
    requireCondition(quoteValue <= quoteCap.atoms, `BOUNDED_NET ${endpoint} endpoint exceeds residual quote cap`);
  }
  return Object.freeze({
    kind: 'BOUNDED_NET',
    minNetSpotDeltaAtoms: min.atoms,
    maxNetSpotDeltaAtoms: max.atoms,
    maxTerminalResidualBaseAtoms: baseCap.atoms,
    residualValuationSchemaVersion: valuationVersion,
    residualValuationReferencePrice: valuationPrice,
    maxTerminalResidualQuoteAtoms: quoteCap.atoms,
  });
}

export class HyperliquidExecutionPlanner {
  readonly #environment: 'testnet';
  readonly #domain: DomainRef;
  readonly #seriesManifestHash: ManifestHash;
  readonly #executionClassManifestHash: ManifestHash;
  readonly #spot: HyperliquidMarketBinding;
  readonly #perpetual: HyperliquidMarketBinding;

  constructor(options: HyperliquidExecutionPlannerOptions) {
    requireCondition(options.environment === 'testnet', 'only Hyperliquid testnet planning is enabled');
    this.#environment = options.environment;
    this.#domain = domainRef(
      options.seriesIdentity.domain.domainId,
      options.seriesIdentity.domain.domainManifestVersion,
      options.seriesIdentity.domain.domainManifestHash,
      'seriesIdentity.domain',
    );
    requireCondition(this.#domain.domainId.startsWith('hypercore:'), 'domain must use the HyperCore namespace');
    this.#seriesManifestHash = manifestHash(
      options.seriesIdentity.seriesManifestHash,
      'seriesIdentity.seriesManifestHash',
    );
    this.#executionClassManifestHash = manifestHash(
      options.seriesIdentity.executionClassManifestHash,
      'seriesIdentity.executionClassManifestHash',
    );
    this.#spot = normalizedMarket(options.spot, 'spot');
    this.#perpetual = normalizedMarket(options.perpetual, 'perpetual');
    requireCondition(
      this.#spot.assetId !== this.#perpetual.assetId,
      'spot and perpetual HyperCore asset IDs must differ',
    );
  }

  compile(admission: PackageAdmission, options: HyperliquidCompileOptions = {}): HyperliquidExecutionPlan {
    const { order, quote, route } = admission;
    const accountPre = options.accountPrePerpPositionAtoms;
    requireCondition(accountPre === undefined || typeof accountPre === 'bigint', 'account pre-position must be integer atoms');
    requireCondition(
      order.environment === this.#environment
        && quote.environment === this.#environment
        && route.environment === this.#environment,
      'package environment is unsupported',
    );
    requireCondition(
      sameDomain(order.domain, this.#domain)
        && sameDomain(quote.domain, this.#domain)
        && sameDomain(route.domain, this.#domain),
      'package domain is unsupported',
    );
    requireCondition(
      order.templateId === CASH_CARRY_TEMPLATE_ID
        && order.templateVersion === CASH_CARRY_TEMPLATE_VERSION
        && route.templateId === order.templateId
        && route.templateVersion === order.templateVersion,
      'cash-and-carry template is required',
    );
    requireCondition(order.direction === 'LONG_SPOT_SHORT_PERP' && route.direction === order.direction, 'direction is unsupported');
    requireCondition(order.action === route.action, 'package action mismatch');
    requireCondition(order.settlementClass === 'BATCHED_IOC_WITH_RECOVERY' && route.settlementClass === order.settlementClass, 'bounded-recovery settlement is required');
    requireCondition(route.executionPlanKind === 'HYPERCORE_BATCHED_IOC', 'HyperCore batched IOC route is required');
    requireCondition(order.packageTimeInForce === 'IOC' && order.partialFillPolicy === 'EXACT_ALL_LEGS' && route.partialFillPolicy === order.partialFillPolicy, 'IOC exact-all-legs policy is required');
    requireCondition(
      order.expiryUnit === 'HYPERLIQUID_UNIX_MILLISECONDS'
        && quote.validUntilUnit === order.expiryUnit
        && route.routeExpiryUnit === order.expiryUnit,
      'HyperCore millisecond expiry is required',
    );
    requireHash(route.orderHash, admission.orderHash, 'route order hash');
    requireHash(quote.orderHash, admission.orderHash, 'quote order hash');
    requireHash(quote.routeHash, admission.routeHash, 'quote route hash');

    const spotLeg = route.legs.find((leg) => leg.legRole === 'SPOT');
    const perpetualLeg = route.legs.find((leg) => leg.legRole === 'PERPETUAL');
    requireCondition(spotLeg !== undefined && perpetualLeg !== undefined, 'one spot and one perpetual leg are required');
    requireLegBinding(spotLeg, this.#spot, 'SPOT');
    requireLegBinding(perpetualLeg, this.#perpetual, 'PERPETUAL');
    const entry = order.action === 'ENTRY';
    requireCondition(spotLeg.side === (entry ? 'BUY' : 'SELL'), 'spot side mismatch');
    requireCondition(perpetualLeg.side === (entry ? 'SELL' : 'BUY'), 'perpetual side mismatch');
    requireCondition(!spotLeg.reduceOnly, 'spot order cannot be reduce-only');
    requireCondition(perpetualLeg.reduceOnly === !entry, 'perpetual reduce-only mismatch');
    requireCondition(spotLeg.actionSequence !== perpetualLeg.actionSequence, 'spot and perpetual actions must be separate');
    requireCondition(route.actions.length === 2, 'route must commit exactly two HyperCore order actions');
    for (const leg of [spotLeg, perpetualLeg]) {
      const action = route.actions[leg.actionSequence];
      requireCondition(action !== undefined, `${leg.legRole} action is missing`);
      requireCondition(action.actionClassId === HYPERCORE_IOC_ORDER_ACTION_CLASS_ID, `${leg.legRole} action class is unsupported`);
      requireCondition(action.legIndex === leg.legIndex, `${leg.legRole} action leg binding mismatch`);
      requireCondition(action.adapter !== undefined && sameAdapter(action.adapter, leg.adapter), `${leg.legRole} action adapter mismatch`);
    }

    const grossSpot = order.hyperliquidGrossSpotQuantity;
    requireCondition(grossSpot !== undefined && grossSpot.atoms > 0n, 'gross spot quantity is missing');
    requireCondition(spotLeg.quantity.atoms === grossSpot.atoms, 'gross spot quantity mismatch');
    requireCondition(perpetualLeg.quantity.atoms === order.quantity.atoms, 'exact perpetual quantity mismatch');
    const signedPerpDeltaAtoms = order.action === 'ENTRY' ? -order.quantity.atoms : order.quantity.atoms;
    const prePerpPositionAtoms = accountPre ?? order.expectedPrePositionSize.atoms;
    const signedPerpTargetAtoms = prePerpPositionAtoms + signedPerpDeltaAtoms;
    requireCondition(order.action === 'ENTRY' || signedPerpTargetAtoms <= 0n, 'reduce-only exit would cross the zero perp position');

    const signedPerpPrice = order.action === 'ENTRY'
      ? order.hyperliquidMinPerpSellPrice
      : order.hyperliquidMaxPerpBuyPrice;
    requireCondition(signedPerpPrice !== undefined, 'signed perpetual limit is missing');
    requireCondition(samePrice(perpetualLeg.limitPrice, signedPerpPrice), 'route perpetual limit does not equal the signed order limit');

    const spotPrice = formatHypercorePrice(spotLeg.limitPrice, this.#spot.maxPriceDecimals);
    const perpetualPrice = formatHypercorePrice(perpetualLeg.limitPrice, this.#perpetual.maxPriceDecimals);
    const perpetualLimitRelation = compareHypercoreWirePriceToExact(perpetualPrice, signedPerpPrice);
    requireCondition(
      entry ? perpetualLimitRelation >= 0 : perpetualLimitRelation <= 0,
      'wire perpetual price violates the signed limit',
    );
    const spotSize = formatHypercoreSize(spotLeg.quantity.atoms, spotLeg.baseAsset.decimals, this.#spot.sizeDecimals);
    const perpetualSize = formatHypercoreSize(perpetualLeg.quantity.atoms, perpetualLeg.baseAsset.decimals, this.#perpetual.sizeDecimals);
    const spotNotional = hypercoreQuoteAtomsAtWirePrice(
      spotLeg.quantity.atoms,
      spotLeg.baseAsset.decimals,
      spotLeg.quoteAsset.decimals,
      spotPrice,
      order.action === 'ENTRY',
    );
    if (order.action === 'ENTRY') {
      requireCondition(order.maxSpotQuoteIn !== undefined && spotNotional <= order.maxSpotQuoteIn.atoms, 'wire spot limit exceeds the signed quote cap');
    } else {
      requireCondition(order.minSpotQuoteOut !== undefined && spotNotional >= order.minSpotQuoteOut.atoms, 'wire spot limit is below the signed quote floor');
    }

    const spotClientOrderId = clientOrderId(
      this.#domain,
      this.#seriesManifestHash,
      this.#executionClassManifestHash,
      admission,
      'SPOT',
      this.#spot.assetId,
    );
    const perpetualClientOrderId = clientOrderId(
      this.#domain,
      this.#seriesManifestHash,
      this.#executionClassManifestHash,
      admission,
      'PERPETUAL',
      this.#perpetual.assetId,
    );
    const spotOrder = Object.freeze({
      a: this.#spot.assetId,
      b: spotLeg.side === 'BUY',
      p: spotPrice.value,
      s: spotSize,
      r: spotLeg.reduceOnly,
      t: Object.freeze({ limit: Object.freeze({ tif: 'Ioc' as const }) }),
      c: spotClientOrderId,
    });
    const perpetualOrder = Object.freeze({
      a: this.#perpetual.assetId,
      b: perpetualLeg.side === 'BUY',
      p: perpetualPrice.value,
      s: perpetualSize,
      r: perpetualLeg.reduceOnly,
      t: Object.freeze({ limit: Object.freeze({ tif: 'Ioc' as const }) }),
      c: perpetualClientOrderId,
    });
    const orderedLegs = [
      Object.freeze({
        role: 'SPOT' as const,
        legIndex: spotLeg.legIndex,
        adapter: spotLeg.adapter,
        venue: spotLeg.venue,
        market: spotLeg.market,
        baseAsset: spotLeg.baseAsset,
        quoteAsset: spotLeg.quoteAsset,
        side: spotLeg.side,
        quantityAtoms: spotLeg.quantity.atoms,
        sizeDecimals: this.#spot.sizeDecimals,
        maxPriceDecimals: this.#spot.maxPriceDecimals,
        signedBaseDeltaAtoms: order.action === 'ENTRY' ? grossSpot.atoms : -grossSpot.atoms,
        clientOrderId: spotClientOrderId,
        order: spotOrder,
        actionSequence: spotLeg.actionSequence,
      }),
      Object.freeze({
        role: 'PERPETUAL' as const,
        legIndex: perpetualLeg.legIndex,
        adapter: perpetualLeg.adapter,
        venue: perpetualLeg.venue,
        market: perpetualLeg.market,
        baseAsset: perpetualLeg.baseAsset,
        quoteAsset: perpetualLeg.quoteAsset,
        side: perpetualLeg.side,
        quantityAtoms: perpetualLeg.quantity.atoms,
        sizeDecimals: this.#perpetual.sizeDecimals,
        maxPriceDecimals: this.#perpetual.maxPriceDecimals,
        signedBaseDeltaAtoms: signedPerpDeltaAtoms,
        clientOrderId: perpetualClientOrderId,
        order: perpetualOrder,
        actionSequence: perpetualLeg.actionSequence,
      }),
    ].sort((left, right) => left.actionSequence - right.actionSequence);
    const first = orderedLegs[0];
    const second = orderedLegs[1];
    requireCondition(first !== undefined && second !== undefined, 'two planned legs are required');
    const legs: readonly [HyperliquidPlannedLeg, HyperliquidPlannedLeg] = Object.freeze([
      Object.freeze({
        role: first.role,
        legIndex: first.legIndex,
        adapter: first.adapter,
        venue: first.venue,
        market: first.market,
        baseAsset: first.baseAsset,
        quoteAsset: first.quoteAsset,
        side: first.side,
        quantityAtoms: first.quantityAtoms,
        sizeDecimals: first.sizeDecimals,
        maxPriceDecimals: first.maxPriceDecimals,
        signedBaseDeltaAtoms: first.signedBaseDeltaAtoms,
        clientOrderId: first.clientOrderId,
        order: first.order,
      }),
      Object.freeze({
        role: second.role,
        legIndex: second.legIndex,
        adapter: second.adapter,
        venue: second.venue,
        market: second.market,
        baseAsset: second.baseAsset,
        quoteAsset: second.quoteAsset,
        side: second.side,
        quantityAtoms: second.quantityAtoms,
        sizeDecimals: second.sizeDecimals,
        maxPriceDecimals: second.maxPriceDecimals,
        signedBaseDeltaAtoms: second.signedBaseDeltaAtoms,
        clientOrderId: second.clientOrderId,
        order: second.order,
      }),
    ]);
    const orders: readonly [HypercoreOrderWire, HypercoreOrderWire] = Object.freeze([
      legs[0].order,
      legs[1].order,
    ]);
    const action: HypercoreBatchedOrderAction = Object.freeze({
      type: 'order',
      orders,
      grouping: 'na',
    });
    const expiry = requestExpiry(admission);
    const recovery = route.recoveryPlan;
    requireCondition(recovery !== undefined, 'HyperCore route requires bounded recovery');
    requireCondition(recovery.deadlineValue === order.hyperliquidRecoveryDeadlineValue, 'recovery deadline mismatch');

    return Object.freeze({
      version: 1,
      guarantee: HYPERCORE_EXECUTION_GUARANTEE,
      domain: this.#domain,
      commitments: Object.freeze({
        seriesManifestHash: manifestHash(this.#seriesManifestHash),
        executionClassManifestHash: manifestHash(this.#executionClassManifestHash),
        orderHash: checkedHash(admission.orderHash, 'orderHash'),
        quoteHash: checkedHash(admission.quoteHash, 'quoteHash'),
        routeHash: checkedHash(admission.routeHash, 'routeHash'),
      }),
      requestExpiryMs: expiry,
      unsignedRequestFields: Object.freeze({
        action,
        expiresAfter: Number(expiry),
      }),
      legs,
      grossSpotQuantityAtoms: grossSpot.atoms,
      prePerpPositionAtoms,
      signedPerpDeltaAtoms,
      signedPerpTargetAtoms,
      terminalResidualPolicy: terminalResidualPolicy(admission, signedPerpDeltaAtoms),
      recoveryPolicy: recoveryPlan(recovery),
      recoveryDeadlineMs: recovery.deadlineValue,
    });
  }
}

export {
  decimalToAtoms,
  normalizeHyperliquidPerpPositions,
  normalizeHyperliquidSpotBalances,
  type HyperliquidClearinghouseStateLike,
  type HyperliquidPositionBinding,
  type HyperliquidPositionSnapshot,
  type HyperliquidSnapshotContext,
  type HyperliquidSpotClearinghouseStateLike,
} from './position-adapter.js';
