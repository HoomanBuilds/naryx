import {
  bytesEqual,
  routeHash,
  type ActionCommitmentInput,
  type AdapterRef,
  type AssetAmount,
  type AssetRef,
  type EvidenceRequirementsInput,
  type ExactPrice,
  type ExactSignedRate,
  type Hash32,
  type PackageOrder,
  type RouteAccountBindingInput,
  type RoutePayloadInput,
  type RouteServiceChargeInput,
  type StateConstraintInput,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import type {
  AtomicRouteCandidate,
  AtomicRouteCandidateProvider,
  AtomicRouteDecision,
} from './atomic-route-decision.js';
import type { InternalAtomicQuoteTermsProvider } from './internal-atomic-quote-server.js';
import type { AtomicEntryQuoteTerms } from './signed-atomic-entry-quote.js';

const BPS_SCALE = 10_000n;
const U256_MAX = (1n << 256n) - 1n;

export interface AtomicQuoteNonceSource {
  next(): bigint;
}

export class InMemoryAtomicQuoteNonceSource implements AtomicQuoteNonceSource {
  #next: bigint;

  constructor(firstNonce = 1n) {
    if (firstNonce <= 0n || firstNonce > U256_MAX) {
      throw new Error('firstNonce must be a nonzero u256');
    }
    this.#next = firstNonce;
  }

  next(): bigint {
    const current = this.#next;
    if (current > U256_MAX) throw new Error('quote nonce space is exhausted');
    this.#next = current + 1n;
    return current;
  }
}

export interface ConfiguredAtomicMarketLeg {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly limitPrice: ExactPrice;
  readonly actionSequence: number;
}

export interface ConfiguredAtomicFeeSchedule {
  readonly baseAssetFeeBps: number;
  readonly venueFeeBps: number;
  readonly builderFeeBps: number;
  readonly protocolFeeBps: number;
  readonly solverFeeBps: number;
  readonly priorityFeeQuoteAtoms: bigint;
  readonly builderRecipient: string;
  readonly protocolRecipient: string;
  readonly solverRecipient: string;
  readonly collectionAuthority: string;
  readonly collectionModeId: string;
}

export interface ConfiguredAtomicMarketInput {
  readonly candidateId: string;
  readonly active: boolean;
  readonly capacityBaseAtoms: bigint;
  readonly evidenceGrade: string;
  readonly solverId: string;
  readonly solverCapabilityManifestHash: Uint8Array | string;
  readonly templateRegistryRecordHash: Uint8Array | string;
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Uint8Array | string;
  readonly routeTtl: bigint;
  readonly quoteTtl: bigint;
  readonly currentClock: () => bigint;
  readonly nonceSource: AtomicQuoteNonceSource;
  readonly spot: ConfiguredAtomicMarketLeg;
  readonly perpetual: ConfiguredAtomicMarketLeg;
  readonly entrySpread: ExactSignedRate;
  readonly marginBps: number;
  readonly fees: ConfiguredAtomicFeeSchedule;
  readonly accountBindings: readonly RouteAccountBindingInput[];
  readonly ownerAccountBindingIds: readonly string[];
  readonly settlementAccountBindingIds: readonly string[];
  readonly actions: readonly ActionCommitmentInput[];
  readonly preconditions: readonly StateConstraintInput[];
  readonly postconditions: readonly StateConstraintInput[];
  readonly evidenceRequirements: EvidenceRequirementsInput;
}

export interface ConfiguredAtomicMarketProviders {
  readonly candidates: AtomicRouteCandidateProvider;
  readonly terms: InternalAtomicQuoteTermsProvider;
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

function notional(quantity: bigint, price: ExactPrice): bigint {
  return ceilDiv(quantity * price.quoteAtoms, price.baseAtoms);
}

function fee(amount: bigint, bps: bigint): bigint {
  return ceilDiv(amount * bps, BPS_SCALE);
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function requirePositiveClock(value: bigint, name: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > U256_MAX) {
    throw new Error(`${name} must be a nonzero u256`);
  }
  return value;
}

function requireEntryOrder(order: PackageOrder, input: ConfiguredAtomicMarketInput): void {
  if (order.action !== 'ENTRY' || order.direction !== 'LONG_SPOT_SHORT_PERP') {
    throw new Error('configured atomic market supports long-spot short-perpetual entry only');
  }
  if (order.settlementClass !== 'ATOMIC_POSTCONDITION') {
    throw new Error('configured atomic market requires atomic postcondition settlement');
  }
  if (order.environment !== 'local' || order.expiryUnit !== 'SOLANA_SLOT') {
    throw new Error('configured atomic market is limited to local Solana conformance');
  }
  if (!order.permittedSpotAdapters.some((adapter) => sameAdapter(adapter, input.spot.adapter))
    || !order.permittedPerpAdapters.some((adapter) => sameAdapter(adapter, input.perpetual.adapter))) {
    throw new Error('configured market adapters are not permitted by the order');
  }
  for (const price of [input.spot.limitPrice, input.perpetual.limitPrice]) {
    if (!sameAsset(price.baseAsset, order.quantity.asset)) {
      throw new Error('configured leg base asset does not match the order');
    }
  }
  const quoteAsset = order.maxSpotQuoteIn?.asset;
  if (quoteAsset === undefined
    || !sameAsset(input.spot.limitPrice.quoteAsset, quoteAsset)
    || !sameAsset(input.perpetual.limitPrice.quoteAsset, quoteAsset)
    || !sameAsset(input.entrySpread.baseAsset, order.quantity.asset)
    || !sameAsset(input.entrySpread.quoteAsset, quoteAsset)) {
    throw new Error('configured quote assets do not match the order');
  }
}

function serviceCharge(
  category: 'BUILDER' | 'PROTOCOL' | 'SOLVER',
  asset: AssetRef,
  atoms: bigint,
  recipientIdentity: string,
  input: ConfiguredAtomicMarketInput,
): RouteServiceChargeInput | undefined {
  if (atoms === 0n) return undefined;
  return {
    feeCategory: category,
    asset,
    atoms,
    recipientIdentity,
    collectionAuthority: input.fees.collectionAuthority,
    collectionModeId: input.fees.collectionModeId,
  };
}

function build(
  order: PackageOrder,
  orderHash: Hash32,
  input: ConfiguredAtomicMarketInput,
): Readonly<{
  candidate: AtomicRouteCandidate;
  terms: Omit<AtomicEntryQuoteTerms, 'quoteNonce'>;
}> {
  requireEntryOrder(order, input);
  const now = requirePositiveClock(input.currentClock(), 'currentClock');
  if (now >= order.expiryValue) throw new Error('order is expired');
  const routeTtl = requirePositiveClock(input.routeTtl, 'routeTtl');
  const quoteTtl = requirePositiveClock(input.quoteTtl, 'quoteTtl');
  const routeExpiryValue = min(order.expiryValue, now + min(routeTtl, quoteTtl));
  const validUntilValue = routeExpiryValue;
  if (routeExpiryValue <= now || validUntilValue <= now) {
    throw new Error('configured freshness window is empty');
  }

  const quantity = order.quantity.atoms;
  const quoteAsset = input.spot.limitPrice.quoteAsset;
  const spotNotional = notional(quantity, input.spot.limitPrice);
  const perpNotional = notional(quantity, input.perpetual.limitPrice);
  const baseFeeAtoms = fee(quantity, requireBps(input.fees.baseAssetFeeBps, 'baseAssetFeeBps'));
  if (baseFeeAtoms > quantity) throw new Error('base asset fee exceeds gross quantity');
  const venueFeeAtoms = fee(spotNotional + perpNotional, requireBps(input.fees.venueFeeBps, 'venueFeeBps'));
  const builderFeeAtoms = fee(spotNotional + perpNotional, requireBps(input.fees.builderFeeBps, 'builderFeeBps'));
  const protocolFeeAtoms = fee(spotNotional + perpNotional, requireBps(input.fees.protocolFeeBps, 'protocolFeeBps'));
  const solverFeeAtoms = fee(spotNotional + perpNotional, requireBps(input.fees.solverFeeBps, 'solverFeeBps'));
  const priorityFeeAtoms = input.fees.priorityFeeQuoteAtoms;
  if (priorityFeeAtoms < 0n) throw new Error('priority fee must be nonnegative');
  const marginAtoms = fee(perpNotional, requireBps(input.marginBps, 'marginBps'));
  const totalQuoteFees = venueFeeAtoms + builderFeeAtoms + protocolFeeAtoms
    + solverFeeAtoms + priorityFeeAtoms;
  const charges = [
    serviceCharge('BUILDER', quoteAsset, builderFeeAtoms, input.fees.builderRecipient, input),
    serviceCharge('PROTOCOL', quoteAsset, protocolFeeAtoms, input.fees.protocolRecipient, input),
    serviceCharge('SOLVER', quoteAsset, solverFeeAtoms, input.fees.solverRecipient, input),
  ].filter((charge): charge is RouteServiceChargeInput => charge !== undefined);

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
    quantityPolicyClass: 'EXACT_ATOMIC',
    partialFillPolicy: order.partialFillPolicy,
    settlementClass: order.settlementClass,
    executionPlanKind: 'SVM_ATOMIC_CPI',
    routeExpiryUnit: order.expiryUnit,
    routeExpiryValue,
    feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash,
    accountBindings: input.accountBindings.map((binding) => ({
      ...binding,
      accountIdentity: input.ownerAccountBindingIds.includes(binding.routeBindingId)
        ? order.owner
        : input.settlementAccountBindingIds.includes(binding.routeBindingId)
          ? order.settlementAccount
          : binding.accountIdentity,
      ...(input.ownerAccountBindingIds.includes(binding.routeBindingId)
        ? { authorityIdentity: order.owner }
        : {}),
    })),
    serviceCharges: charges,
    preconditions: input.preconditions,
    legs: [
      {
        legIndex: 0,
        legRole: 'SPOT',
        actionSequence: input.spot.actionSequence,
        adapter: input.spot.adapter,
        venue: input.spot.venue,
        market: input.spot.market,
        baseAsset: order.quantity.asset,
        quoteAsset,
        side: 'BUY',
        quantity: order.quantity,
        limitPrice: input.spot.limitPrice,
        timeInForce: 'FOK',
        reduceOnly: false,
      },
      {
        legIndex: 1,
        legRole: 'PERPETUAL',
        actionSequence: input.perpetual.actionSequence,
        adapter: input.perpetual.adapter,
        venue: input.perpetual.venue,
        market: input.perpetual.market,
        baseAsset: order.quantity.asset,
        quoteAsset,
        side: 'SELL',
        quantity: order.quantity,
        limitPrice: input.perpetual.limitPrice,
        timeInForce: 'FOK',
        reduceOnly: false,
      },
    ],
    actions: input.actions,
    postconditions: input.postconditions,
    evidenceRequirements: input.evidenceRequirements,
  };
  const zeroBase: AssetAmount = { asset: order.quantity.asset, atoms: 0n };
  return Object.freeze({
    candidate: Object.freeze({
      candidateId: input.candidateId,
      active: input.active,
      capacityBaseAtoms: input.capacityBaseAtoms,
      expectedNetPackageOutcomeQuoteAtoms: perpNotional - spotNotional - totalQuoteFees,
      expectedTotalFeesQuoteAtoms: totalQuoteFees,
      evidenceGrade: input.evidenceGrade,
      route,
    }),
    terms: Object.freeze({
      solverId: input.solverId,
      solverCapabilityManifestHash: input.solverCapabilityManifestHash,
      quotedOutcome: { kind: 'ENTRY_SPREAD' as const, entrySpread: input.entrySpread },
      expectedSpotNotional: { asset: quoteAsset, atoms: spotNotional },
      expectedPerpNotional: { asset: quoteAsset, atoms: perpNotional },
      expectedGrossSpotQuantity: order.quantity,
      expectedNetSpotQuantity: { asset: order.quantity.asset, atoms: quantity - baseFeeAtoms },
      expectedBaseAssetFee: { asset: order.quantity.asset, atoms: baseFeeAtoms },
      expectedMarginDelta: { asset: quoteAsset, atoms: marginAtoms },
      expectedRawFillFeesByAsset: venueFeeAtoms === 0n
        ? [zeroBase]
        : [{ asset: quoteAsset, atoms: venueFeeAtoms }],
      expectedBuilderFeesByAsset: builderFeeAtoms === 0n
        ? [zeroBase]
        : [{ asset: quoteAsset, atoms: builderFeeAtoms }],
      expectedNormalizedVenueFeesByAsset: venueFeeAtoms === 0n
        ? [zeroBase]
        : [{ asset: quoteAsset, atoms: venueFeeAtoms }],
      solverFee: { asset: quoteAsset, atoms: solverFeeAtoms },
      protocolFee: { asset: quoteAsset, atoms: protocolFeeAtoms },
      expectedPriorityFee: { asset: quoteAsset, atoms: priorityFeeAtoms },
      maxRecoveryCostAtomsByAsset: [],
      feePolicyVersion: input.feePolicyVersion,
      feePolicyManifestHash: input.feePolicyManifestHash,
      validUntilUnit: order.expiryUnit,
      validUntilValue,
    }),
  });
}

export function createConfiguredAtomicMarketProviders(
  input: ConfiguredAtomicMarketInput,
): ConfiguredAtomicMarketProviders {
  if (input.capacityBaseAtoms < 0n) throw new Error('capacityBaseAtoms must be nonnegative');
  let cached: Readonly<{
    orderHash: Hash32;
    candidate: AtomicRouteCandidate;
    terms: Omit<AtomicEntryQuoteTerms, 'quoteNonce'>;
  }> | undefined;
  const candidates: AtomicRouteCandidateProvider = ({ order, orderHash }) => {
    const created = build(order, orderHash, input);
    cached = { orderHash: Uint8Array.from(orderHash) as Hash32, ...created };
    return [created.candidate];
  };
  const terms: InternalAtomicQuoteTermsProvider = ({ order, decision }: Readonly<{
    order: PackageOrder;
    decision: AtomicRouteDecision;
  }>) => {
    const orderHash = decision.orderHash;
    const prepared = cached !== undefined && bytesEqual(cached.orderHash, orderHash)
      ? cached
      : { orderHash, ...build(order, orderHash, input) };
    if (decision.candidateId !== input.candidateId
      || !bytesEqual(routeHash(prepared.candidate.route), decision.routeHash)) {
      throw new Error('route decision does not match the configured market');
    }
    const quoteNonce = input.nonceSource.next();
    if (quoteNonce <= 0n || quoteNonce > U256_MAX) throw new Error('quote nonce must be a nonzero u256');
    return Object.freeze({ ...prepared.terms, quoteNonce });
  };
  return Object.freeze({ candidates, terms });
}
