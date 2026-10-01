import {
  bytesEqual,
  compareBytes,
  packageOrderHash,
  routeHash,
  routePayload,
  routePayloadBytes,
  validatePackageOrderProfile,
} from '@naryx/protocol-types';
import type {
  AdapterRef,
  AssetRef,
  Hash32,
  PackageOrder,
  RoutePayload,
  RoutePayloadInput,
} from '@naryx/protocol-types';

export type AtomicRouteRejectionReason =
  | 'INACTIVE_CANDIDATE'
  | 'INVALID_CANDIDATE'
  | 'INVALID_FEES'
  | 'INSUFFICIENT_CAPACITY'
  | 'ROUTE_MALFORMED'
  | 'ORDER_HASH_MISMATCH'
  | 'ENVIRONMENT_MISMATCH'
  | 'DOMAIN_MISMATCH'
  | 'TEMPLATE_MISMATCH'
  | 'OWNER_MISMATCH'
  | 'SETTLEMENT_ACCOUNT_MISMATCH'
  | 'DIRECTION_MISMATCH'
  | 'ACTION_MISMATCH'
  | 'PARTIAL_FILL_POLICY_MISMATCH'
  | 'SETTLEMENT_CLASS_MISMATCH'
  | 'QUANTITY_MISMATCH'
  | 'EXPIRY_UNIT_MISMATCH'
  | 'ROUTE_EXPIRY_INVALID'
  | 'LEG_SHAPE_MISMATCH'
  | 'ADAPTER_NOT_PERMITTED';

export interface AtomicRouteCandidate {
  readonly candidateId: string;
  readonly active: boolean;
  readonly capacityBaseAtoms: bigint;
  readonly expectedNetPackageOutcomeQuoteAtoms: bigint;
  readonly expectedTotalFeesQuoteAtoms: bigint;
  readonly evidenceGrade: string;
  readonly route: RoutePayloadInput;
}

export type AtomicRouteCandidateProvider = (input: Readonly<{
  order: PackageOrder;
  orderHash: Hash32;
}>) => readonly AtomicRouteCandidate[];

export interface AtomicRouteEligibleDecision {
  readonly candidateId: string;
  readonly status: 'ELIGIBLE';
  readonly reason: null;
  readonly routeHash: Hash32;
  readonly expectedNetPackageOutcomeQuoteAtoms: bigint;
  readonly expectedTotalFeesQuoteAtoms: bigint;
}

export interface AtomicRouteRejectedDecision {
  readonly candidateId: string;
  readonly status: 'REJECTED';
  readonly reason: AtomicRouteRejectionReason;
  readonly routeHash: Hash32 | null;
}

export type AtomicRouteDecisionRecord =
  | AtomicRouteEligibleDecision
  | AtomicRouteRejectedDecision;

export interface AtomicRouteDecision {
  readonly orderHash: Hash32;
  readonly candidateId: string;
  readonly route: RoutePayload;
  readonly routeBytes: Uint8Array;
  readonly routeHash: Hash32;
  readonly expectedNetPackageOutcomeQuoteAtoms: bigint;
  readonly expectedTotalFeesQuoteAtoms: bigint;
  readonly evidenceGrade: string;
  readonly decisions: readonly AtomicRouteDecisionRecord[];
}

export interface AtomicRoutePlanInput {
  readonly order: PackageOrder;
  readonly orderHash: Hash32;
}

export class AtomicRouteDecisionError extends Error {
  readonly code = 'NO_ELIGIBLE_ROUTE' as const;
  readonly decisions: readonly AtomicRouteDecisionRecord[];

  constructor(decisions: readonly AtomicRouteDecisionRecord[]) {
    super('NO_ELIGIBLE_ROUTE: no atomic route candidate is eligible');
    this.name = 'AtomicRouteDecisionError';
    this.decisions = decisions;
  }
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function isPermitted(adapter: AdapterRef, list: readonly AdapterRef[]): boolean {
  return list.some((entry) => sameAdapter(adapter, entry));
}

function rejected(
  candidateId: string,
  reason: AtomicRouteRejectionReason,
  routeHashValue: Hash32 | null,
): AtomicRouteRejectedDecision {
  return Object.freeze({
    candidateId,
    status: 'REJECTED' as const,
    reason,
    routeHash: routeHashValue,
  });
}

function evaluateCandidate(
  raw: unknown,
  index: number,
  order: PackageOrder,
  expectedOrderHash: Hash32,
): (AtomicRouteDecisionRecord & { route?: RoutePayload; routeBytes?: Uint8Array; evidenceGrade?: string }) {
  const fallbackId = `candidate-${index}`;
  if (typeof raw !== 'object' || raw === null) {
    return rejected(fallbackId, 'INVALID_CANDIDATE', null);
  }
  const candidate = raw as Partial<AtomicRouteCandidate>;
  const recordId = typeof candidate.candidateId === 'string'
    && candidate.candidateId.length > 0
    && candidate.candidateId.length <= 128
    ? candidate.candidateId
    : fallbackId;
  if (typeof candidate.candidateId !== 'string'
    || candidate.candidateId.length === 0
    || candidate.candidateId.length > 128) {
    return rejected(recordId, 'INVALID_CANDIDATE', null);
  }
  if (typeof candidate.evidenceGrade !== 'string'
    || candidate.evidenceGrade.length === 0
    || candidate.evidenceGrade.length > 128) {
    return rejected(recordId, 'INVALID_CANDIDATE', null);
  }
  if (typeof candidate.capacityBaseAtoms !== 'bigint' || candidate.capacityBaseAtoms < 0n) {
    return rejected(recordId, 'INVALID_CANDIDATE', null);
  }
  if (typeof candidate.expectedNetPackageOutcomeQuoteAtoms !== 'bigint') {
    return rejected(recordId, 'INVALID_CANDIDATE', null);
  }
  if (typeof candidate.expectedTotalFeesQuoteAtoms !== 'bigint'
    || candidate.expectedTotalFeesQuoteAtoms < 0n) {
    return rejected(recordId, 'INVALID_FEES', null);
  }
  if (typeof candidate.active !== 'boolean') {
    return rejected(recordId, 'INVALID_CANDIDATE', null);
  }
  if (typeof candidate.route !== 'object' || candidate.route === null) {
    return rejected(recordId, 'ROUTE_MALFORMED', null);
  }
  let route: RoutePayload;
  let bytes: Uint8Array;
  let hash: Hash32;
  try {
    route = routePayload(candidate.route);
    bytes = routePayloadBytes(candidate.route);
    hash = routeHash(candidate.route);
  } catch {
    return rejected(recordId, 'ROUTE_MALFORMED', null);
  }
  if (candidate.active !== true) {
    return rejected(recordId, 'INACTIVE_CANDIDATE', hash);
  }
  if (candidate.capacityBaseAtoms < order.quantity.atoms) {
    return rejected(recordId, 'INSUFFICIENT_CAPACITY', hash);
  }
  if (!bytesEqual(route.orderHash, expectedOrderHash)) {
    return rejected(recordId, 'ORDER_HASH_MISMATCH', hash);
  }
  if (route.environment !== order.environment) {
    return rejected(recordId, 'ENVIRONMENT_MISMATCH', hash);
  }
  if (route.domain.domainId !== order.domain.domainId
    || route.domain.domainManifestVersion !== order.domain.domainManifestVersion
    || !bytesEqual(route.domain.domainManifestHash, order.domain.domainManifestHash)) {
    return rejected(recordId, 'DOMAIN_MISMATCH', hash);
  }
  if (route.templateId !== order.templateId
    || route.templateVersion !== order.templateVersion
    || !bytesEqual(route.packageTemplateManifestHash, order.packageTemplateManifestHash)) {
    return rejected(recordId, 'TEMPLATE_MISMATCH', hash);
  }
  if (route.owner !== order.owner) {
    return rejected(recordId, 'OWNER_MISMATCH', hash);
  }
  if (route.settlementAccount !== order.settlementAccount) {
    return rejected(recordId, 'SETTLEMENT_ACCOUNT_MISMATCH', hash);
  }
  if (route.direction !== order.direction) {
    return rejected(recordId, 'DIRECTION_MISMATCH', hash);
  }
  if (route.action !== order.action) {
    return rejected(recordId, 'ACTION_MISMATCH', hash);
  }
  if (route.partialFillPolicy !== order.partialFillPolicy) {
    return rejected(recordId, 'PARTIAL_FILL_POLICY_MISMATCH', hash);
  }
  if (route.settlementClass !== order.settlementClass) {
    return rejected(recordId, 'SETTLEMENT_CLASS_MISMATCH', hash);
  }
  const isHyperliquid = order.settlementClass === 'BATCHED_IOC_WITH_RECOVERY';
  const recovery = route.recoveryPlan;
  if (isHyperliquid
    && (route.executionPlanKind !== 'HYPERCORE_BATCHED_IOC'
      || route.quantityPolicyClass !== order.hyperliquidQuantityPolicy
      || recovery === undefined
      || recovery.recoveryExpiryUnit !== order.hyperliquidRecoveryExpiryUnit
      || recovery.maxActionExpiryValue !== order.hyperliquidMaxRecoveryActionExpiryValue
      || recovery.deadlineValue !== order.hyperliquidRecoveryDeadlineValue
      || recovery.minRecoveryWindowMs !== order.hyperliquidMinRecoveryWindowMs
      || recovery.maxTerminalResidual.atoms
        !== order.hyperliquidMaxTerminalResidualBaseQuantity?.atoms
      || recovery.maxAggregateRecoveryLoss.atoms !== order.maxAggregateRecoveryLossQuote.atoms
      || recovery.maxRecoveryCostCaps.length !== order.maxRecoveryCostAtomsByAsset.length
      || recovery.maxRecoveryCostCaps.some((cap, index) => {
        const signed = order.maxRecoveryCostAtomsByAsset[index];
        return signed === undefined || !sameAsset(cap.asset, signed.asset)
          || cap.maxAtoms !== signed.maxAtoms;
      })
      || recovery.actionSlots.length !== order.allowedRecoveryActions.length
      || recovery.actionSlots.some((slot, index) =>
        slot.action !== order.allowedRecoveryActions[index]))) {
    return rejected(recordId, 'SETTLEMENT_CLASS_MISMATCH', hash);
  }
  const isAsyncEvm = order.settlementClass === 'ASYNC_BONDED_SOLVER';
  if (isAsyncEvm
    && (route.executionPlanKind !== 'EVM_ASYNC_REQUEST'
      || route.quantityPolicyClass !== 'EXACT_NET'
      || recovery === undefined
      || recovery.recoveryExpiryUnit !== 'EVM_UNIX_SECONDS'
      || recovery.maxRecoveryCostCaps.some((cap) => cap.maxAtoms !== 0n)
      || recovery.maxAggregateRecoveryLoss.atoms !== order.maxAggregateRecoveryLossQuote.atoms)) {
    return rejected(recordId, 'SETTLEMENT_CLASS_MISMATCH', hash);
  }
  if (route.routeExpiryUnit !== order.expiryUnit) {
    return rejected(recordId, 'EXPIRY_UNIT_MISMATCH', hash);
  }
  if (route.routeExpiryValue <= 0n || route.routeExpiryValue > order.expiryValue) {
    return rejected(recordId, 'ROUTE_EXPIRY_INVALID', hash);
  }
  if (route.legs.length !== 2) {
    return rejected(recordId, 'LEG_SHAPE_MISMATCH', hash);
  }
  const spot = route.legs.find((leg) => leg.legRole === 'SPOT');
  const perpetual = route.legs.find((leg) => leg.legRole === 'PERPETUAL');
  if (spot === undefined || perpetual === undefined || route.legs.length !== 2) {
    return rejected(recordId, 'LEG_SHAPE_MISMATCH', hash);
  }
  const spotCount = route.legs.filter((leg) => leg.legRole === 'SPOT').length;
  const perpCount = route.legs.filter((leg) => leg.legRole === 'PERPETUAL').length;
  if (spotCount !== 1 || perpCount !== 1) {
    return rejected(recordId, 'LEG_SHAPE_MISMATCH', hash);
  }
  if (spot.side !== 'BUY' || perpetual.side !== 'SELL') {
    return rejected(recordId, 'LEG_SHAPE_MISMATCH', hash);
  }
  const expectedTimeInForce = isHyperliquid ? 'IOC' : 'FOK';
  if (spot.timeInForce !== expectedTimeInForce || perpetual.timeInForce !== expectedTimeInForce) {
    return rejected(recordId, 'LEG_SHAPE_MISMATCH', hash);
  }
  if (spot.reduceOnly !== false || perpetual.reduceOnly !== false) {
    return rejected(recordId, 'LEG_SHAPE_MISMATCH', hash);
  }
  const orderQuote = order.maxSpotQuoteIn?.asset;
  const expectedSpotQuantity = isHyperliquid
    ? order.hyperliquidGrossSpotQuantity?.atoms
    : order.quantity.atoms;
  if (expectedSpotQuantity === undefined
    || spot.quantity.atoms !== expectedSpotQuantity
    || perpetual.quantity.atoms !== order.quantity.atoms
    || !sameAsset(spot.quantity.asset, order.quantity.asset)
    || !sameAsset(perpetual.quantity.asset, order.quantity.asset)
    || orderQuote === undefined
    || !sameAsset(spot.quoteAsset, orderQuote)
    || !sameAsset(perpetual.quoteAsset, orderQuote)) {
    return rejected(recordId, 'QUANTITY_MISMATCH', hash);
  }
  if (!isPermitted(spot.adapter, order.permittedSpotAdapters)
    || !isPermitted(perpetual.adapter, order.permittedPerpAdapters)) {
    return rejected(recordId, 'ADAPTER_NOT_PERMITTED', hash);
  }
  return Object.freeze({
    candidateId: recordId,
    status: 'ELIGIBLE' as const,
    reason: null,
    routeHash: hash,
    expectedNetPackageOutcomeQuoteAtoms: candidate.expectedNetPackageOutcomeQuoteAtoms as bigint,
    expectedTotalFeesQuoteAtoms: candidate.expectedTotalFeesQuoteAtoms as bigint,
    evidenceGrade: candidate.evidenceGrade as string,
    route,
    routeBytes: bytes,
  });
}

export function planAtomicEntryRoute(
  input: AtomicRoutePlanInput,
  provider: AtomicRouteCandidateProvider,
): AtomicRouteDecision {
  if (typeof input !== 'object' || input === null) {
    throw new Error('plan input must be an object');
  }
  if (typeof provider !== 'function') {
    throw new Error('candidate provider must be a function');
  }
  if (!(input.orderHash instanceof Uint8Array) || input.orderHash.length !== 32) {
    throw new Error('order hash must be 32 bytes');
  }
  const validated = validatePackageOrderProfile(
    input.order as unknown as Parameters<typeof validatePackageOrderProfile>[0],
    'packageOrder',
  );
  if (validated.direction !== 'LONG_SPOT_SHORT_PERP'
    || validated.action !== 'ENTRY'
    || (validated.settlementClass !== 'ATOMIC_POSTCONDITION'
      && validated.settlementClass !== 'BATCHED_IOC_WITH_RECOVERY'
      && validated.settlementClass !== 'ASYNC_BONDED_SOLVER')) {
    throw new Error('route decision requires a supported long-spot short-perp ENTRY order');
  }
  const recomputed = packageOrderHash(validated);
  if (!bytesEqual(recomputed, input.orderHash)) {
    throw new Error('order hash does not match the recomputed canonical hash');
  }
  const candidates = provider({ order: validated, orderHash: recomputed });
  if (!Array.isArray(candidates)) {
    throw new Error('candidate provider must return an array');
  }
  const evaluated = candidates.map((candidate, index) =>
    evaluateCandidate(candidate, index, validated, recomputed));
  const decisions: AtomicRouteDecisionRecord[] = evaluated.map((entry) => {
    if (entry.status === 'ELIGIBLE') {
      return Object.freeze({
        candidateId: entry.candidateId,
        status: 'ELIGIBLE' as const,
        reason: null,
        routeHash: entry.routeHash as Hash32,
        expectedNetPackageOutcomeQuoteAtoms: entry.expectedNetPackageOutcomeQuoteAtoms as bigint,
        expectedTotalFeesQuoteAtoms: entry.expectedTotalFeesQuoteAtoms as bigint,
      });
    }
    return entry as AtomicRouteRejectedDecision;
  });
  const frozenDecisions = Object.freeze(decisions) as readonly AtomicRouteDecisionRecord[];
  interface EligibleEntry {
    readonly candidateIndex: number;
    readonly candidateId: string;
    readonly route: RoutePayload;
    readonly routeBytes: Uint8Array;
    readonly routeHash: Hash32;
    readonly expectedNetPackageOutcomeQuoteAtoms: bigint;
    readonly expectedTotalFeesQuoteAtoms: bigint;
    readonly evidenceGrade: string;
  }
  const eligible: EligibleEntry[] = [];
  evaluated.forEach((entry, candidateIndex) => {
    if (entry.status === 'ELIGIBLE'
      && entry.route !== undefined
      && entry.routeBytes !== undefined
      && entry.evidenceGrade !== undefined) {
      eligible.push({
        candidateIndex,
        candidateId: entry.candidateId,
        route: entry.route,
        routeBytes: entry.routeBytes,
        routeHash: entry.routeHash as Hash32,
        expectedNetPackageOutcomeQuoteAtoms: entry.expectedNetPackageOutcomeQuoteAtoms as bigint,
        expectedTotalFeesQuoteAtoms: entry.expectedTotalFeesQuoteAtoms as bigint,
        evidenceGrade: entry.evidenceGrade,
      });
    }
  });
  if (eligible.length === 0) {
    throw new AtomicRouteDecisionError(frozenDecisions);
  }
  const ranked = [...eligible].sort((left, right) => {
    if (left.expectedNetPackageOutcomeQuoteAtoms !== right.expectedNetPackageOutcomeQuoteAtoms) {
      return left.expectedNetPackageOutcomeQuoteAtoms > right.expectedNetPackageOutcomeQuoteAtoms ? -1 : 1;
    }
    if (left.expectedTotalFeesQuoteAtoms !== right.expectedTotalFeesQuoteAtoms) {
      return left.expectedTotalFeesQuoteAtoms < right.expectedTotalFeesQuoteAtoms ? -1 : 1;
    }
    if (left.candidateId !== right.candidateId) {
      return left.candidateId < right.candidateId ? -1 : 1;
    }
    return compareBytes(left.routeHash, right.routeHash);
  });
  const winner = ranked[0] as EligibleEntry;
  return Object.freeze({
    orderHash: recomputed,
    candidateId: winner.candidateId,
    route: winner.route,
    routeBytes: Uint8Array.from(winner.routeBytes),
    routeHash: winner.routeHash,
    expectedNetPackageOutcomeQuoteAtoms: winner.expectedNetPackageOutcomeQuoteAtoms,
    expectedTotalFeesQuoteAtoms: winner.expectedTotalFeesQuoteAtoms,
    evidenceGrade: winner.evidenceGrade,
    decisions: frozenDecisions,
  });
}
