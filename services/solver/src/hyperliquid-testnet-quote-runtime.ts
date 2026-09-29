import {
  adapterRef,
  bytesEqual,
  domainRef,
  exactPrice,
  exactSignedRate,
  manifestHash,
  routeHash,
  versionedManifestRef,
  type ActionCommitmentInput,
  type AdapterRef,
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
import type {
  AtomicRouteCandidate,
  AtomicRouteCandidateProvider,
  AtomicRouteDecision,
} from './atomic-route-decision.js';
import type { AtomicQuoteNonceSource } from './configured-atomic-market.js';
import type { InternalAtomicQuoteTermsProvider } from './internal-atomic-quote-server.js';
import type { AtomicEntryQuoteTerms } from './signed-atomic-entry-quote.js';

const BPS_SCALE = 10_000n;
const U256_MAX = (1n << 256n) - 1n;

export interface HyperliquidTestnetQuoteLeg {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly limitPrice: ExactPrice;
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
  readonly currentTimeMs: () => bigint;
  readonly nonceSource: AtomicQuoteNonceSource;
  readonly spot: HyperliquidTestnetQuoteLeg;
  readonly perpetual: HyperliquidTestnetQuoteLeg;
  readonly entrySpread: ExactSignedRate;
  readonly accountBindings: readonly RouteAccountBindingInput[];
  readonly preconditions: RoutePayloadInput['preconditions'];
  readonly postconditions: RoutePayloadInput['postconditions'];
  readonly evidenceRequirements: EvidenceRequirementsInput;
  readonly recovery: HyperliquidTestnetRecoveryIdentity;
}

export interface HyperliquidTestnetQuoteRuntime {
  readonly providers: Readonly<{
    candidates: AtomicRouteCandidateProvider;
    terms: InternalAtomicQuoteTermsProvider;
  }>;
}

function validateConfiguration(input: HyperliquidTestnetQuoteRuntimeInput): void {
  try {
    if (!input.enabled
      || input.domain.domainId !== 'hypercore:testnet'
      || input.capacityBaseAtoms <= 0n
      || typeof input.currentTimeMs !== 'function'
      || typeof input.nonceSource?.next !== 'function'
      || input.accountBindings.length === 0
      || input.spot.action.sequence !== 0
      || input.perpetual.action.sequence !== 1
      || !sameAdapter(input.spot.action.adapter!, input.spot.adapter)
      || !sameAdapter(input.perpetual.action.adapter!, input.perpetual.adapter)
      || input.recovery.controllerId.length === 0
      || input.recovery.authorityModeId.length === 0) {
      throw new Error('missing required configuration');
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
    for (const leg of [input.spot, input.perpetual]) {
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
      exactPrice(leg.limitPrice);
    }
    exactSignedRate(input.entrySpread);
    requirePositive(input.routeTtlMs, 'routeTtlMs');
    requirePositive(input.quoteTtlMs, 'quoteTtlMs');
    requireBps(input.marginBps, 'marginBps');
  } catch {
    throw new Error('Hyperliquid Testnet quote runtime configuration is incomplete or invalid');
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
  return (numerator + denominator - 1n) / denominator;
}

function notional(quantity: bigint, price: ExactPrice): bigint {
  return ceilDiv(quantity * price.quoteAtoms, price.baseAtoms);
}

function recoverySlot(
  action: RecoveryAction,
  sequence: number,
  order: PackageOrder,
  input: HyperliquidTestnetQuoteRuntimeInput,
): RecoveryActionSlotInput {
  const spot = input.spot;
  const perpetual = input.perpetual;
  if (action === 'CANCEL_OPEN_ORDERS') {
    return { sequence, action, targetLeg: 1, adapter: perpetual.adapter, markets: [perpetual.market] };
  }
  if (action === 'COMPLETE_SPOT') {
    return {
      sequence, action, targetLeg: 0, adapter: spot.adapter, markets: [spot.market],
      maxQuantity: order.hyperliquidGrossSpotQuantity!, limitPrice: order.maxRecoverySpotBuyPrice!,
      reduceOnly: false, timeInForce: 'IOC',
    };
  }
  if (action === 'COMPLETE_PERP') {
    return {
      sequence, action, targetLeg: 1, adapter: perpetual.adapter, markets: [perpetual.market],
      maxQuantity: order.quantity, limitPrice: order.minRecoveryPerpSellPrice!,
      reduceOnly: false, timeInForce: 'IOC',
    };
  }
  if (action === 'ROLLBACK_SPOT') {
    return {
      sequence, action, targetLeg: 0, adapter: spot.adapter, markets: [spot.market],
      maxQuantity: order.hyperliquidGrossSpotQuantity!, limitPrice: order.minRecoverySpotSellPrice!,
      reduceOnly: false, timeInForce: 'IOC',
    };
  }
  return {
    sequence, action, targetLeg: 1, adapter: perpetual.adapter, markets: [perpetual.market],
    maxQuantity: order.quantity, limitPrice: order.maxRecoveryPerpBuyPrice!,
    reduceOnly: true, timeInForce: 'IOC',
  };
}

function requireOrder(order: PackageOrder, input: HyperliquidTestnetQuoteRuntimeInput): void {
  if (!input.enabled) throw new Error('Hyperliquid Testnet quote runtime is disabled');
  if (order.environment !== 'testnet'
    || order.domain.domainId !== 'hypercore:testnet'
    || order.expiryUnit !== 'HYPERLIQUID_UNIX_MILLISECONDS'
    || order.settlementClass !== 'BATCHED_IOC_WITH_RECOVERY'
    || order.action !== 'ENTRY'
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
  const quoteAsset = order.maxSpotQuoteIn?.asset;
  if (quoteAsset === undefined
    || !sameAsset(input.spot.limitPrice.baseAsset, order.quantity.asset)
    || !sameAsset(input.perpetual.limitPrice.baseAsset, order.quantity.asset)
    || !sameAsset(input.spot.limitPrice.quoteAsset, quoteAsset)
    || !sameAsset(input.perpetual.limitPrice.quoteAsset, quoteAsset)) {
    throw new Error('configured Hyperliquid market assets do not match the order');
  }
  if (input.perpetual.limitPrice.quoteAtoms * order.hyperliquidMinPerpSellPrice!.baseAtoms
    < order.hyperliquidMinPerpSellPrice!.quoteAtoms * input.perpetual.limitPrice.baseAtoms) {
    throw new Error('configured perpetual price is below the signed order limit');
  }
}

function build(order: PackageOrder, orderHash: Hash32, input: HyperliquidTestnetQuoteRuntimeInput) {
  requireOrder(order, input);
  const now = requirePositive(input.currentTimeMs(), 'currentTimeMs');
  if (now >= order.expiryValue) throw new Error('order is expired');
  const routeExpiryValue = [
    order.expiryValue,
    now + requirePositive(input.routeTtlMs, 'routeTtlMs'),
    now + requirePositive(input.quoteTtlMs, 'quoteTtlMs'),
  ].reduce((left, right) => left < right ? left : right);
  if (routeExpiryValue <= now) throw new Error('configured freshness window is empty');

  const grossSpot = order.hyperliquidGrossSpotQuantity!;
  const quoteAsset = order.maxSpotQuoteIn!.asset;
  const spotNotional = notional(grossSpot.atoms, input.spot.limitPrice);
  const perpNotional = notional(order.quantity.atoms, input.perpetual.limitPrice);
  if (spotNotional > order.maxSpotQuoteIn!.atoms) throw new Error('configured spot price exceeds the order cap');
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
        limitPrice: input.spot.limitPrice, timeInForce: 'IOC', reduceOnly: false,
      },
      {
        legIndex: 1, legRole: 'PERPETUAL', actionSequence: input.perpetual.action.sequence,
        adapter: input.perpetual.adapter, venue: input.perpetual.venue, market: input.perpetual.market,
        baseAsset: order.quantity.asset, quoteAsset, side: 'SELL', quantity: order.quantity,
        limitPrice: input.perpetual.limitPrice, timeInForce: 'IOC', reduceOnly: false,
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
  const zeroBase = { asset: order.quantity.asset, atoms: 0n };
  const candidate: AtomicRouteCandidate = Object.freeze({
    candidateId: input.candidateId,
    active: true,
    capacityBaseAtoms: input.capacityBaseAtoms,
    expectedNetPackageOutcomeQuoteAtoms: perpNotional - spotNotional,
    expectedTotalFeesQuoteAtoms: 0n,
    evidenceGrade: 'HYPERLIQUID_TESTNET_REFERENCE',
    route,
  });
  const terms: Omit<AtomicEntryQuoteTerms, 'quoteNonce'> = Object.freeze({
    solverId: input.solverId,
    solverCapabilityManifestHash: input.solverCapabilityManifestHash,
    quotedOutcome: { kind: 'ENTRY_SPREAD' as const, entrySpread: input.entrySpread },
    expectedSpotNotional: { asset: quoteAsset, atoms: spotNotional },
    expectedPerpNotional: { asset: quoteAsset, atoms: perpNotional },
    expectedGrossSpotQuantity: grossSpot,
    expectedNetSpotQuantity: order.hyperliquidMinNetSpotDelta!,
    expectedBaseAssetFee: zeroBase,
    expectedTerminalResidualBaseQuantity: order.hyperliquidMaxTerminalResidualBaseQuantity!,
    expectedTerminalResidualQuoteValue: order.hyperliquidMaxTerminalResidualQuoteValue!,
    expectedMarginDelta: { asset: quoteAsset, atoms: marginAtoms },
    expectedRawFillFeesByAsset: [zeroBase],
    expectedBuilderFeesByAsset: [zeroBase],
    expectedNormalizedVenueFeesByAsset: [zeroBase],
    solverFee: { asset: quoteAsset, atoms: 0n },
    protocolFee: { asset: quoteAsset, atoms: 0n },
    expectedPriorityFee: { asset: quoteAsset, atoms: 0n },
    maxRecoveryCostAtomsByAsset: order.maxRecoveryCostAtomsByAsset,
    feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash,
    validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    validUntilValue: routeExpiryValue,
  });
  return Object.freeze({ candidate, terms });
}

export function createHyperliquidTestnetQuoteRuntime(
  input: HyperliquidTestnetQuoteRuntimeInput,
): HyperliquidTestnetQuoteRuntime {
  if (!input.enabled) throw new Error('Hyperliquid Testnet quote runtime is disabled');
  validateConfiguration(input);
  let cached: ReturnType<typeof build> | undefined;
  let cachedOrderHash: Hash32 | undefined;
  const candidates: AtomicRouteCandidateProvider = ({ order, orderHash }) => {
    const created = build(order, orderHash, input);
    cached = created;
    cachedOrderHash = Uint8Array.from(orderHash) as Hash32;
    return [created.candidate];
  };
  const terms: InternalAtomicQuoteTermsProvider = ({ order, decision }: Readonly<{
    order: PackageOrder;
    decision: AtomicRouteDecision;
  }>) => {
    const prepared = cached !== undefined && cachedOrderHash !== undefined
      && bytesEqual(cachedOrderHash, decision.orderHash)
      ? cached
      : build(order, decision.orderHash, input);
    if (decision.candidateId !== input.candidateId
      || !bytesEqual(routeHash(prepared.candidate.route), decision.routeHash)) {
      throw new Error('route decision does not match the configured Hyperliquid Testnet market');
    }
    const quoteNonce = input.nonceSource.next();
    if (quoteNonce <= 0n || quoteNonce > U256_MAX) throw new Error('quote nonce must be a nonzero u256');
    return Object.freeze({ ...prepared.terms, quoteNonce });
  };
  return Object.freeze({ providers: Object.freeze({ candidates, terms }) });
}

export function composeQuoteProviders(
  local: HyperliquidTestnetQuoteRuntime['providers'],
  hyperliquid?: HyperliquidTestnetQuoteRuntime['providers'],
): HyperliquidTestnetQuoteRuntime['providers'] {
  const select = (order: PackageOrder) => {
    if (order.environment === 'local' && order.domain.domainId === 'svm:local') return local;
    if (order.environment === 'testnet' && order.domain.domainId === 'hypercore:testnet'
      && hyperliquid !== undefined) return hyperliquid;
    throw new Error('no quote runtime is configured for the order domain');
  };
  return Object.freeze({
    candidates: (value) => select(value.order).candidates(value),
    terms: (value) => select(value.order).terms(value),
  });
}
