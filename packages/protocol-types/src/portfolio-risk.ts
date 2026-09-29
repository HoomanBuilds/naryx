import { absBigInt, checkedSigned, checkedUnsigned, mulDiv, ROUNDING } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { enumDiscriminant, type EnumTable } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { exactPrice, type ExactPrice } from './package-order-primitives.js';
import {
  domainRef,
  encodeAssetRef,
  protocolId,
  type AssetRef,
  type DomainRef,
  type ProtocolId,
} from './primitives.js';

export const NORMALIZED_POSITION_VERSION = 1;
export const PORTFOLIO_MAX_POSITIONS = 256;
const BPS = 10_000n;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;

export const POSITION_TYPE = Object.freeze({
  SPOT: 1,
  PERPETUAL: 2,
} as const);
export type PositionType = keyof typeof POSITION_TYPE;

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function requireArray(value: unknown, context: string, maximum = PORTFOLIO_MAX_POSITIONS): void {
  if (!Array.isArray(value)) throw new MalformedInputError(context, 'expected an array');
  if (value.length > maximum) throw new MalformedInputError(context, `more than ${maximum} entries`);
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function signed(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedSigned(value, I128_BITS, context);
}

function bps(value: bigint, context: string): bigint {
  const checked = unsigned(value, U64_BITS, context);
  if (checked > BPS) throw new MalformedInputError(context, 'basis points exceed 10000');
  return checked;
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function idSet(values: readonly string[], context: string): readonly ProtocolId[] {
  requireArray(values, context, 64);
  const ids = values.map((value, index) => protocolId(value, `${context}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new DuplicateElementError(context, 'identifiers repeat');
  return Object.freeze([...ids].sort());
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return compareBytes(canonicalBytes((w) => encodeAssetRef(w, left)), canonicalBytes((w) => encodeAssetRef(w, right))) === 0;
}

// ------------------------------------------------------------------ normalized positions

export interface CloseRouteInput {
  readonly routeId: string;
  readonly executableQuantityAtoms: bigint;
  readonly expectedCostQuoteAtoms: bigint;
  readonly settlementDelayMs: bigint;
  readonly authorityHeld: boolean;
  /** Routes on different legs that share one rollback boundary carry the same group id. */
  readonly atomicGroupId?: string;
  readonly requiredDependencyIds: readonly string[];
}

export interface NormalizedPositionInput {
  readonly adapterVersion: number;
  readonly snapshotId: string;
  readonly domain: DomainRef;
  readonly observedAtMs: bigint;
  readonly owner: string;
  readonly venueId: string;
  readonly marketId: string;
  readonly underlyingId: string;
  readonly positionType: PositionType;
  readonly quantityBaseAtoms: bigint;
  readonly markPrice: ExactPrice;
  readonly liquidationPrice?: ExactPrice;
  readonly collateralQuoteAtoms?: bigint;
  readonly maintenanceRequirementQuoteAtoms?: bigint;
  readonly dependencyIds: readonly string[];
  readonly riskDomainId: string;
  readonly closeRoutes: readonly CloseRouteInput[];
}

export interface NormalizedPosition extends NormalizedPositionInput {
  readonly snapshotId: ProtocolId;
  readonly owner: ProtocolId;
  readonly underlyingId: ProtocolId;
  readonly dependencyIds: readonly ProtocolId[];
  readonly riskDomainId: ProtocolId;
  /** Fields the venue did not expose. They are reported, never invented. */
  readonly unknownFields: readonly string[];
}

/** Validates a read-only adapter snapshot. Normalizing a position grants no authority over it. */
export function normalizedPosition(input: NormalizedPositionInput, context = 'normalizedPosition'): NormalizedPosition {
  object(input, context);
  if (input.adapterVersion !== NORMALIZED_POSITION_VERSION) {
    throw new MalformedInputError(`${context}.adapterVersion`, `version must equal ${NORMALIZED_POSITION_VERSION}`);
  }
  const quantityBaseAtoms = signed(input.quantityBaseAtoms, `${context}.quantityBaseAtoms`);
  if (quantityBaseAtoms === 0n) throw new MalformedInputError(`${context}.quantityBaseAtoms`, 'a flat position is not a position');
  const markPrice = exactPrice(input.markPrice, `${context}.markPrice`);
  const liquidationPrice = input.liquidationPrice === undefined ? undefined : exactPrice(input.liquidationPrice, `${context}.liquidationPrice`);
  if (liquidationPrice !== undefined && (!sameAsset(liquidationPrice.baseAsset, markPrice.baseAsset) || !sameAsset(liquidationPrice.quoteAsset, markPrice.quoteAsset))) {
    throw new MalformedInputError(`${context}.liquidationPrice`, 'liquidation and mark prices use different assets');
  }
  requireArray(input.closeRoutes, `${context}.closeRoutes`, 32);
  const routes = input.closeRoutes.map((route, index) => {
    const at = `${context}.closeRoutes[${index}]`;
    object(route, at);
    if (typeof route.authorityHeld !== 'boolean') throw new MalformedInputError(`${at}.authorityHeld`, 'expected a boolean');
    return Object.freeze({
      routeId: protocolId(route.routeId, `${at}.routeId`),
      executableQuantityAtoms: unsigned(route.executableQuantityAtoms, U128_BITS, `${at}.executableQuantityAtoms`),
      expectedCostQuoteAtoms: unsigned(route.expectedCostQuoteAtoms, U128_BITS, `${at}.expectedCostQuoteAtoms`),
      settlementDelayMs: unsigned(route.settlementDelayMs, U64_BITS, `${at}.settlementDelayMs`),
      authorityHeld: route.authorityHeld,
      ...(route.atomicGroupId === undefined ? {} : { atomicGroupId: protocolId(route.atomicGroupId, `${at}.atomicGroupId`) }),
      requiredDependencyIds: idSet(route.requiredDependencyIds, `${at}.requiredDependencyIds`),
    });
  });
  if (new Set(routes.map((route) => route.routeId)).size !== routes.length) {
    throw new DuplicateElementError(`${context}.closeRoutes`, 'route ids repeat');
  }
  const unknownFields: string[] = [];
  const optional = (value: bigint | undefined, name: string): bigint | undefined => {
    if (value === undefined) {
      unknownFields.push(name);
      return undefined;
    }
    return unsigned(value, U128_BITS, `${context}.${name}`);
  };
  const collateralQuoteAtoms = optional(input.collateralQuoteAtoms, 'collateralQuoteAtoms');
  const maintenanceRequirementQuoteAtoms = optional(input.maintenanceRequirementQuoteAtoms, 'maintenanceRequirementQuoteAtoms');
  const positionType = variant(POSITION_TYPE, input.positionType, `${context}.positionType`);
  if (positionType === 'PERPETUAL' && liquidationPrice === undefined) unknownFields.push('liquidationPrice');
  return Object.freeze({
    adapterVersion: NORMALIZED_POSITION_VERSION,
    snapshotId: protocolId(input.snapshotId, `${context}.snapshotId`),
    domain: domainRef(input.domain.domainId, input.domain.domainManifestVersion, input.domain.domainManifestHash, `${context}.domain`),
    observedAtMs: unsigned(input.observedAtMs, U64_BITS, `${context}.observedAtMs`),
    owner: protocolId(input.owner, `${context}.owner`),
    venueId: protocolId(input.venueId, `${context}.venueId`),
    marketId: protocolId(input.marketId, `${context}.marketId`),
    underlyingId: protocolId(input.underlyingId, `${context}.underlyingId`),
    positionType,
    quantityBaseAtoms,
    markPrice,
    ...(liquidationPrice === undefined ? {} : { liquidationPrice }),
    ...(collateralQuoteAtoms === undefined ? {} : { collateralQuoteAtoms }),
    ...(maintenanceRequirementQuoteAtoms === undefined ? {} : { maintenanceRequirementQuoteAtoms }),
    dependencyIds: idSet(input.dependencyIds, `${context}.dependencyIds`),
    riskDomainId: protocolId(input.riskDomainId, `${context}.riskDomainId`),
    closeRoutes: Object.freeze(routes),
    unknownFields: Object.freeze(unknownFields),
  });
}

function positions(inputs: readonly NormalizedPositionInput[], accountingAsset: AssetRef, context: string): readonly NormalizedPosition[] {
  requireArray(inputs, context);
  const checked = inputs.map((input, index) => normalizedPosition(input, `${context}[${index}]`));
  if (new Set(checked.map((position) => position.snapshotId)).size !== checked.length) {
    throw new DuplicateElementError(context, 'snapshot ids repeat');
  }
  for (const position of checked) {
    // Aggregation never converts between quote assets implicitly.
    if (!sameAsset(position.markPrice.quoteAsset, accountingAsset)) {
      throw new MalformedInputError(context, `position ${position.snapshotId} is not marked in the accounting asset`);
    }
  }
  return checked;
}

/** Signed mark notional in quote atoms, rounded away from zero so exposure is never understated. */
export function positionNotional(position: NormalizedPosition): bigint {
  return mulDiv(position.quantityBaseAtoms, position.markPrice.quoteAtoms, position.markPrice.baseAtoms, ROUNDING.AWAY_FROM_ZERO);
}

// ------------------------------------------------------------------ exposure graph

export interface ExposureLine {
  readonly key: ProtocolId;
  readonly netNotional: bigint;
  readonly grossNotional: bigint;
  readonly positionCount: number;
}

export interface ExposureGraph {
  readonly byUnderlying: readonly ExposureLine[];
  readonly byDependency: readonly ExposureLine[];
  readonly byRiskDomain: readonly ExposureLine[];
  readonly unknownFields: readonly { readonly snapshotId: ProtocolId; readonly field: string }[];
}

function aggregate(entries: readonly { key: ProtocolId; notional: bigint }[]): readonly ExposureLine[] {
  const lines = new Map<ProtocolId, { net: bigint; gross: bigint; count: number }>();
  for (const { key, notional } of entries) {
    const line = lines.get(key) ?? { net: 0n, gross: 0n, count: 0 };
    line.net += notional;
    line.gross += absBigInt(notional);
    line.count += 1;
    lines.set(key, line);
  }
  return Object.freeze(
    [...lines.entries()]
      .sort(([left, a], [right, b]) => (a.gross !== b.gross ? (a.gross > b.gross ? -1 : 1) : left < right ? -1 : 1))
      .map(([key, line]) => Object.freeze({ key, netNotional: line.net, grossNotional: line.gross, positionCount: line.count })),
  );
}

/**
 * Cross-template exposure: common delta per underlying, and concentration per shared dependency
 * (venue, oracle, bridge, issuer, solver, domain) and per risk domain. Dependencies are read from
 * the snapshot; the graph never assumes two venues are independent.
 */
export function buildExposureGraph(inputs: readonly NormalizedPositionInput[], accountingAsset: AssetRef): ExposureGraph {
  const checked = positions(inputs, accountingAsset, 'buildExposureGraph.positions');
  const priced = checked.map((position) => ({ position, notional: positionNotional(position) }));
  return Object.freeze({
    byUnderlying: aggregate(priced.map(({ position, notional }) => ({ key: position.underlyingId, notional }))),
    byDependency: aggregate(
      priced.flatMap(({ position, notional }) => position.dependencyIds.map((key) => ({ key, notional }))),
    ),
    byRiskDomain: aggregate(priced.map(({ position, notional }) => ({ key: position.riskDomainId, notional }))),
    unknownFields: Object.freeze(
      checked.flatMap((position) => position.unknownFields.map((field) => Object.freeze({ snapshotId: position.snapshotId, field }))),
    ),
  });
}

// ------------------------------------------------------------------ close cost

export interface CloseCostEstimate {
  readonly snapshotId: ProtocolId;
  readonly closableQuantityAtoms: bigint;
  readonly costQuoteAtoms: bigint;
  readonly timeToUnwindMs: bigint;
  readonly complete: boolean;
}

/**
 * Walks the cheapest usable close routes until the position is covered. A route is usable only
 * when the clearing account holds its authority and none of its dependencies has failed. Partial
 * use of a route costs its proportional share, rounded up.
 */
export function estimateCloseCost(
  input: NormalizedPositionInput,
  failedDependencyIds: readonly string[] = [],
  costMultiplierBps = BPS,
): CloseCostEstimate {
  const position = normalizedPosition(input, 'estimateCloseCost.position');
  const failed = new Set<string>(idSet(failedDependencyIds, 'estimateCloseCost.failedDependencyIds'));
  const multiplier = unsigned(costMultiplierBps, U64_BITS, 'estimateCloseCost.costMultiplierBps');
  if (multiplier < BPS) throw new MalformedInputError('estimateCloseCost.costMultiplierBps', 'stress cannot make closing cheaper');
  const usable = position.closeRoutes
    .filter((route) => route.authorityHeld && route.executableQuantityAtoms > 0n && !route.requiredDependencyIds.some((id) => failed.has(id)))
    .sort((left, right) => {
      const a = left.expectedCostQuoteAtoms * right.executableQuantityAtoms;
      const b = right.expectedCostQuoteAtoms * left.executableQuantityAtoms;
      return a !== b ? (a < b ? -1 : 1) : left.routeId < right.routeId ? -1 : 1;
    });
  let remaining = absBigInt(position.quantityBaseAtoms);
  let cost = 0n;
  let delay = 0n;
  for (const route of usable) {
    if (remaining === 0n) break;
    const used = route.executableQuantityAtoms < remaining ? route.executableQuantityAtoms : remaining;
    cost += mulDiv(route.expectedCostQuoteAtoms, used, route.executableQuantityAtoms, ROUNDING.CEIL);
    if (route.settlementDelayMs > delay) delay = route.settlementDelayMs;
    remaining -= used;
  }
  return Object.freeze({
    snapshotId: position.snapshotId,
    closableQuantityAtoms: absBigInt(position.quantityBaseAtoms) - remaining,
    costQuoteAtoms: mulDiv(cost, multiplier, BPS, ROUNDING.CEIL),
    timeToUnwindMs: delay,
    complete: remaining === 0n,
  });
}

export interface PackageCloseCostIndex {
  readonly costQuoteAtoms: bigint;
  readonly timeToUnwindMs: bigint;
  readonly complete: boolean;
  readonly legs: readonly CloseCostEstimate[];
}

/** The executable cost to close every leg of a package now; incomplete when any leg cannot close. */
export function packageCloseCostIndex(inputs: readonly NormalizedPositionInput[], failedDependencyIds: readonly string[] = []): PackageCloseCostIndex {
  requireArray(inputs, 'packageCloseCostIndex.positions');
  const legs = inputs.map((input) => estimateCloseCost(input, failedDependencyIds));
  return Object.freeze({
    costQuoteAtoms: legs.reduce((sum, leg) => sum + leg.costQuoteAtoms, 0n),
    timeToUnwindMs: legs.reduce((max, leg) => (leg.timeToUnwindMs > max ? leg.timeToUnwindMs : max), 0n),
    complete: legs.every((leg) => leg.complete),
    legs: Object.freeze(legs),
  });
}

// ------------------------------------------------------------------ stress

export interface StressScenario {
  readonly scenarioId: string;
  readonly priceShocksBps: readonly { readonly underlyingId: string; readonly shockBps: bigint }[];
  readonly closeCostMultiplierBps: bigint;
  readonly failedDependencyIds: readonly string[];
}

export interface StressResult {
  readonly scenarioId: ProtocolId;
  readonly markPnlQuoteAtoms: bigint;
  readonly stressedCloseCostQuoteAtoms: bigint;
  readonly lossQuoteAtoms: bigint;
  readonly pnlByRiskDomain: readonly { readonly riskDomainId: ProtocolId; readonly pnlQuoteAtoms: bigint }[];
  readonly unclosableSnapshotIds: readonly ProtocolId[];
}

/**
 * Joint price, liquidity, and dependency shock. Every term rounds against the portfolio, and a
 * position that cannot close under the scenario is reported rather than assigned a made-up cost.
 */
export function stressPortfolio(
  inputs: readonly NormalizedPositionInput[],
  scenario: StressScenario,
  accountingAsset: AssetRef,
): StressResult {
  const checked = positions(inputs, accountingAsset, 'stressPortfolio.positions');
  object(scenario, 'stressPortfolio.scenario');
  requireArray(scenario.priceShocksBps, 'stressPortfolio.scenario.priceShocksBps', 64);
  const shocks = new Map<ProtocolId, bigint>();
  for (const [index, shock] of scenario.priceShocksBps.entries()) {
    const at = `stressPortfolio.scenario.priceShocksBps[${index}]`;
    const id = protocolId(shock.underlyingId, `${at}.underlyingId`);
    if (shocks.has(id)) throw new DuplicateElementError(at, 'underlying shocked twice');
    const value = checkedSigned(shock.shockBps, U64_BITS, `${at}.shockBps`);
    if (value <= -BPS) throw new MalformedInputError(`${at}.shockBps`, 'a price cannot fall to or below zero');
    shocks.set(id, value);
  }
  let pnl = 0n;
  let closeCost = 0n;
  const byDomain = new Map<ProtocolId, bigint>();
  const unclosable: ProtocolId[] = [];
  for (const position of checked) {
    const change = mulDiv(positionNotional(position), shocks.get(position.underlyingId) ?? 0n, BPS, ROUNDING.FLOOR);
    pnl += change;
    byDomain.set(position.riskDomainId, (byDomain.get(position.riskDomainId) ?? 0n) + change);
    const estimate = estimateCloseCost(position, scenario.failedDependencyIds, scenario.closeCostMultiplierBps);
    closeCost += estimate.costQuoteAtoms;
    if (!estimate.complete) unclosable.push(position.snapshotId);
  }
  return Object.freeze({
    scenarioId: protocolId(scenario.scenarioId, 'stressPortfolio.scenario.scenarioId'),
    markPnlQuoteAtoms: pnl,
    stressedCloseCostQuoteAtoms: closeCost,
    lossQuoteAtoms: (pnl < 0n ? -pnl : 0n) + closeCost,
    pnlByRiskDomain: Object.freeze(
      [...byDomain.entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([riskDomainId, pnlQuoteAtoms]) => Object.freeze({ riskDomainId, pnlQuoteAtoms })),
    ),
    unclosableSnapshotIds: Object.freeze(unclosable.sort()),
  });
}

// ------------------------------------------------------------------ conditional margin offsets

export interface MarginOffsetPolicy {
  readonly riskDomainId: string;
  readonly offsetRateBps: bigint;
  readonly haircutsBps: {
    readonly basis: bigint;
    readonly liquidity: bigint;
    readonly latency: bigint;
    readonly oracle: bigint;
    readonly venue: bigint;
    readonly bridge: bigint;
    readonly issuer: bigint;
    readonly recovery: bigint;
  };
  readonly maximumStalenessMs: bigint;
  readonly maximumTimeToUnwindMs: bigint;
  readonly riskDomainGrossCapQuoteAtoms: bigint;
  readonly requiredRecoveryReserveQuoteAtoms: bigint;
  readonly absoluteFloorQuoteAtoms: bigint;
}

export interface MarginOffsetContext {
  readonly nowMs: bigint;
  readonly reservedRecoveryQuoteAtoms: bigint;
  readonly fundedCreditAvailable: boolean;
  readonly failedDependencyIds: readonly string[];
}

export type MarginOffsetCondition =
  | 'STALE_OR_UNKNOWN_STATE'
  | 'MISSING_CLOSE_AUTHORITY'
  | 'NO_SHARED_UNWIND'
  | 'INSUFFICIENT_EXECUTABLE_LIQUIDITY'
  | 'FAILED_DEPENDENCY'
  | 'RECOVERY_CAPITAL_NOT_RESERVED'
  | 'OUTSIDE_RISK_DOMAIN'
  | 'RISK_DOMAIN_CAP';

export interface MarginOffsetDecision {
  readonly grossRequirementQuoteAtoms: bigint;
  readonly rawBenefitQuoteAtoms: bigint;
  readonly permittedOffsetQuoteAtoms: bigint;
  readonly resultingRequirementQuoteAtoms: bigint;
  /** True unless a funded credit provider accepts the offset; an advisory offset changes no venue requirement. */
  readonly advisory: boolean;
  readonly failedConditions: readonly MarginOffsetCondition[];
}

/**
 * The requirement starts at the sum of venue-local requirements plus the recovery reserve. An
 * offset applies only when every control, unwind, liquidity, dependency, capital, and cap
 * condition holds; any failure removes it entirely. Historical correlation never enters.
 */
export function evaluateMarginOffset(
  inputs: readonly NormalizedPositionInput[],
  policy: MarginOffsetPolicy,
  context: MarginOffsetContext,
  accountingAsset: AssetRef,
): MarginOffsetDecision {
  const legs = positions(inputs, accountingAsset, 'evaluateMarginOffset.positions');
  if (legs.length < 2) throw new MalformedInputError('evaluateMarginOffset.positions', 'an offset needs at least two legs');
  object(policy, 'evaluateMarginOffset.policy');
  object(context, 'evaluateMarginOffset.context');
  const riskDomainId = protocolId(policy.riskDomainId, 'evaluateMarginOffset.policy.riskDomainId');
  const haircut = Object.entries(policy.haircutsBps).reduce((sum, [name, value]) => sum + bps(value, `evaluateMarginOffset.policy.haircutsBps.${name}`), 0n);
  const now = unsigned(context.nowMs, U64_BITS, 'evaluateMarginOffset.context.nowMs');
  const failed = new Set(idSet(context.failedDependencyIds, 'evaluateMarginOffset.context.failedDependencyIds'));
  const floor = unsigned(policy.absoluteFloorQuoteAtoms, U128_BITS, 'evaluateMarginOffset.policy.absoluteFloorQuoteAtoms');
  const reserveRequired = unsigned(policy.requiredRecoveryReserveQuoteAtoms, U128_BITS, 'evaluateMarginOffset.policy.requiredRecoveryReserveQuoteAtoms');
  const conditions = new Set<MarginOffsetCondition>();

  let venueRequirements = 0n;
  let gross = 0n;
  for (const leg of legs) {
    if (leg.maintenanceRequirementQuoteAtoms === undefined || now - leg.observedAtMs > policy.maximumStalenessMs || leg.observedAtMs > now) {
      conditions.add('STALE_OR_UNKNOWN_STATE');
    }
    venueRequirements += leg.maintenanceRequirementQuoteAtoms ?? 0n;
    gross += absBigInt(positionNotional(leg));
    if (!leg.closeRoutes.some((route) => route.authorityHeld)) conditions.add('MISSING_CLOSE_AUTHORITY');
    if (leg.dependencyIds.some((id) => failed.has(id))) conditions.add('FAILED_DEPENDENCY');
    if (leg.riskDomainId !== riskDomainId) conditions.add('OUTSIDE_RISK_DOMAIN');
    const close = estimateCloseCost(leg, [...failed]);
    if (!close.complete || close.timeToUnwindMs > policy.maximumTimeToUnwindMs) conditions.add('INSUFFICIENT_EXECUTABLE_LIQUIDITY');
  }
  // One tested unwind: every leg must be fully closable inside one shared rollback boundary.
  const groups = legs.map(
    (leg) =>
      new Set(
        leg.closeRoutes
          .filter((route) => route.authorityHeld && route.atomicGroupId !== undefined && route.executableQuantityAtoms >= absBigInt(leg.quantityBaseAtoms))
          .map((route) => route.atomicGroupId as ProtocolId),
      ),
  );
  if (![...(groups[0] ?? [])].some((group) => groups.every((set) => set.has(group)))) conditions.add('NO_SHARED_UNWIND');
  if (unsigned(context.reservedRecoveryQuoteAtoms, U128_BITS, 'evaluateMarginOffset.context.reservedRecoveryQuoteAtoms') < reserveRequired) {
    conditions.add('RECOVERY_CAPITAL_NOT_RESERVED');
  }
  if (gross > unsigned(policy.riskDomainGrossCapQuoteAtoms, U128_BITS, 'evaluateMarginOffset.policy.riskDomainGrossCapQuoteAtoms')) {
    conditions.add('RISK_DOMAIN_CAP');
  }

  const byUnderlying = new Map<ProtocolId, { long: bigint; short: bigint }>();
  for (const leg of legs) {
    const notional = positionNotional(leg);
    const line = byUnderlying.get(leg.underlyingId) ?? { long: 0n, short: 0n };
    if (notional > 0n) line.long += notional;
    else line.short -= notional;
    byUnderlying.set(leg.underlyingId, line);
  }
  const hedged = [...byUnderlying.values()].reduce((sum, line) => sum + (line.long < line.short ? line.long : line.short), 0n);
  const rawBenefit = mulDiv(hedged, bps(policy.offsetRateBps, 'evaluateMarginOffset.policy.offsetRateBps'), BPS, ROUNDING.FLOOR);
  const grossRequirement = venueRequirements + reserveRequired;
  const haircutBenefit = haircut >= BPS ? 0n : mulDiv(rawBenefit, BPS - haircut, BPS, ROUNDING.FLOOR);
  const headroom = grossRequirement > floor ? grossRequirement - floor : 0n;
  const permitted = conditions.size > 0 ? 0n : haircutBenefit < headroom ? haircutBenefit : headroom;
  if (typeof context.fundedCreditAvailable !== 'boolean') {
    throw new MalformedInputError('evaluateMarginOffset.context.fundedCreditAvailable', 'expected a boolean');
  }
  return Object.freeze({
    grossRequirementQuoteAtoms: grossRequirement,
    rawBenefitQuoteAtoms: rawBenefit,
    permittedOffsetQuoteAtoms: permitted,
    // The offset is capped at the headroom above the floor, so the result never drops below it.
    resultingRequirementQuoteAtoms: grossRequirement - permitted,
    advisory: !context.fundedCreditAvailable,
    failedConditions: Object.freeze([...conditions].sort()),
  });
}

// ------------------------------------------------------------------ coordinated de-risking

export type DeRiskAction =
  | { readonly kind: 'LOCK_FOR_MANUAL_RECOVERY'; readonly reason: string }
  | { readonly kind: 'CANCEL_RISK_INCREASING_ORDER'; readonly orderId: ProtocolId }
  | {
      readonly kind: 'REDUCE_LEGS';
      readonly mode: 'ATOMIC_PAIRED' | 'BOUNDED_PAIRED_UNWIND';
      readonly reductions: readonly { readonly snapshotId: ProtocolId; readonly reduceBaseAtoms: bigint }[];
    }
  | { readonly kind: 'ENTER_REDUCE_ONLY' };

export interface DeRiskPolicy {
  readonly triggerLiquidationDistanceBps: bigint;
  readonly reductionBps: bigint;
}

function liquidationDistanceBps(position: NormalizedPosition): bigint | undefined {
  const liquidation = position.liquidationPrice;
  if (liquidation === undefined) return undefined;
  const mark = position.markPrice;
  // |mark - liquidation| / mark, compared exactly over a common denominator.
  const markScaled = mark.quoteAtoms * liquidation.baseAtoms;
  const liquidationScaled = liquidation.quoteAtoms * mark.baseAtoms;
  return mulDiv(absBigInt(markScaled - liquidationScaled), BPS, markScaled, ROUNDING.FLOOR);
}

/**
 * Plans pre-authorized risk reduction. It never claims control of a venue's native liquidation:
 * it cancels risk-increasing orders, reduces the leg nearest liquidation together with its linked
 * hedges by the same fraction, and falls back to manual recovery whenever state is uncertain.
 * Every reduction is in the closing direction and never exceeds the open quantity.
 */
export function planCoordinatedDeRisk(
  inputs: readonly NormalizedPositionInput[],
  policy: DeRiskPolicy,
  stateCertain: boolean,
  openRiskIncreasingOrderIds: readonly string[],
): readonly DeRiskAction[] {
  requireArray(inputs, 'planCoordinatedDeRisk.positions');
  const legs = inputs.map((input, index) => normalizedPosition(input, `planCoordinatedDeRisk.positions[${index}]`));
  object(policy, 'planCoordinatedDeRisk.policy');
  const trigger = bps(policy.triggerLiquidationDistanceBps, 'planCoordinatedDeRisk.policy.triggerLiquidationDistanceBps');
  const reduction = bps(policy.reductionBps, 'planCoordinatedDeRisk.policy.reductionBps');
  if (reduction === 0n) throw new MalformedInputError('planCoordinatedDeRisk.policy.reductionBps', 'a reduction must reduce');
  if (typeof stateCertain !== 'boolean') throw new MalformedInputError('planCoordinatedDeRisk.stateCertain', 'expected a boolean');
  const cancels = idSet(openRiskIncreasingOrderIds, 'planCoordinatedDeRisk.openRiskIncreasingOrderIds').map(
    (orderId): DeRiskAction => Object.freeze({ kind: 'CANCEL_RISK_INCREASING_ORDER', orderId }),
  );
  const unknownPerp = legs.find((leg) => leg.positionType === 'PERPETUAL' && leg.liquidationPrice === undefined);
  if (!stateCertain || unknownPerp !== undefined) {
    const reason = stateCertain ? `liquidation boundary unknown for ${unknownPerp?.snapshotId}` : 'position state is uncertain';
    return Object.freeze([...cancels, Object.freeze({ kind: 'LOCK_FOR_MANUAL_RECOVERY' as const, reason })]);
  }
  const at = legs
    .map((leg) => ({ leg, distance: liquidationDistanceBps(leg) }))
    .filter((item): item is { leg: NormalizedPosition; distance: bigint } => item.distance !== undefined && item.distance < trigger)
    .sort((left, right) => (left.distance !== right.distance ? (left.distance < right.distance ? -1 : 1) : left.leg.snapshotId < right.leg.snapshotId ? -1 : 1))[0];
  if (at === undefined) return Object.freeze(cancels);
  const direction = at.leg.quantityBaseAtoms > 0n;
  // Linked hedges: the opposite-direction legs on the same underlying.
  const linked = legs.filter((leg) => leg.underlyingId === at.leg.underlyingId && leg !== at.leg && leg.quantityBaseAtoms > 0n !== direction);
  const reduced = [at.leg, ...linked];
  const reductions = reduced
    .map((leg) => {
      const open = absBigInt(leg.quantityBaseAtoms);
      const amount = mulDiv(open, reduction, BPS, ROUNDING.CEIL);
      return Object.freeze({ snapshotId: leg.snapshotId, reduceBaseAtoms: amount > open ? open : amount });
    })
    .sort((left, right) => (left.snapshotId < right.snapshotId ? -1 : 1));
  const sharedGroup = [...new Set(reduced.flatMap((leg) => leg.closeRoutes.filter((route) => route.authorityHeld).map((route) => route.atomicGroupId)))]
    .filter((group): group is ProtocolId => group !== undefined)
    .some((group) => reduced.every((leg) => leg.closeRoutes.some((route) => route.authorityHeld && route.atomicGroupId === group)));
  return Object.freeze([
    ...cancels,
    Object.freeze({ kind: 'REDUCE_LEGS' as const, mode: sharedGroup ? ('ATOMIC_PAIRED' as const) : ('BOUNDED_PAIRED_UNWIND' as const), reductions: Object.freeze(reductions) }),
    Object.freeze({ kind: 'ENTER_REDUCE_ONLY' as const }),
  ]);
}
