import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { MalformedInputError } from './errors.js';
import type { StrategyQuoteMetricInput } from './strategy-package-quote.js';
import { STRATEGY_TEMPLATE_ID, type StrategyTemplateId } from './strategy-template-program.js';

const I128_BITS = 128;
const U128_BITS = 128;
const BPS = 10_000n;
const PPM = 1_000_000n;
const YEAR_MS = 31_536_000_000n;

const UNIT = Object.freeze({
  ATOMS: 'quote-atoms',
  BASE_ATOMS: 'base-atoms',
  BPS: 'basis-points',
  PPM: 'parts-per-million',
  MS: 'milliseconds',
  TICKS: 'price-ticks',
  CODE: 'enumeration-code',
} as const);

function positive(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  const checked = checkedUnsigned(value, U128_BITS, context);
  if (checked === 0n) throw new MalformedInputError(context, 'value is zero');
  return checked;
}

function nonnegative(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, U128_BITS, context);
}

function signed(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedSigned(value, I128_BITS, context);
}

function ratio(numerator: bigint, multiplier: bigint, denominator: bigint, context: string): bigint {
  if (denominator <= 0n) throw new MalformedInputError(context, 'denominator must be positive');
  return checkedSigned((numerator * multiplier) / denominator, I128_BITS, context);
}

function metric(metricId: string, value: bigint, unitId: string, scale = 0): StrategyQuoteMetricInput {
  return Object.freeze({ metricId, value: signed(value, metricId), scale, unitId });
}

export interface BasisPackageEconomicsInput {
  readonly templateId: typeof STRATEGY_TEMPLATE_ID.CASH_AND_CARRY | typeof STRATEGY_TEMPLATE_ID.REVERSE_CASH_AND_CARRY;
  readonly spotNotionalAtoms: bigint;
  readonly derivativeNotionalAtoms: bigint;
  readonly expectedFundingAtoms: bigint;
  readonly borrowCostAtoms: bigint;
  readonly totalFeesAtoms: bigint;
  readonly capitalRequiredAtoms: bigint;
  readonly holdingDurationMs: bigint;
  readonly exitBasisBps: bigint;
}

export function basisPackageMetrics(input: BasisPackageEconomicsInput): readonly StrategyQuoteMetricInput[] {
  const spot = positive(input.spotNotionalAtoms, 'basisPackageMetrics.spotNotionalAtoms');
  const derivative = positive(input.derivativeNotionalAtoms, 'basisPackageMetrics.derivativeNotionalAtoms');
  const funding = signed(input.expectedFundingAtoms, 'basisPackageMetrics.expectedFundingAtoms');
  const borrow = nonnegative(input.borrowCostAtoms, 'basisPackageMetrics.borrowCostAtoms');
  const fees = nonnegative(input.totalFeesAtoms, 'basisPackageMetrics.totalFeesAtoms');
  const capital = positive(input.capitalRequiredAtoms, 'basisPackageMetrics.capitalRequiredAtoms');
  const duration = positive(input.holdingDurationMs, 'basisPackageMetrics.holdingDurationMs');
  const spread = input.templateId === STRATEGY_TEMPLATE_ID.CASH_AND_CARRY ? derivative - spot : spot - derivative;
  const net = spread + funding - borrow - fees;
  const annualized = ratio(net * YEAR_MS, PPM, capital * duration, 'basisPackageMetrics.netAnnualizedYield');
  const grossCarry = spread + funding - borrow;
  const breakEven = grossCarry > 0n ? (fees * duration) / grossCarry : 0n;
  const common = [
    metric('entry-basis-bps', ratio(spread, BPS, spot, 'basisPackageMetrics.entryBasis'), UNIT.BPS),
    metric('net-annualized-yield-ppm', annualized, UNIT.PPM),
  ];
  if (input.templateId === STRATEGY_TEMPLATE_ID.CASH_AND_CARRY) {
    return Object.freeze([
      ...common,
      metric('expected-funding-atoms', funding, UNIT.ATOMS),
      metric('capital-required-atoms', capital, UNIT.ATOMS),
      metric('break-even-duration-ms', breakEven, UNIT.MS),
      metric('exit-basis-bps', input.exitBasisBps, UNIT.BPS),
    ]);
  }
  return Object.freeze([
    ...common,
    metric('borrow-cost-atoms', borrow, UNIT.ATOMS),
    metric('capital-required-atoms', capital, UNIT.ATOMS),
    metric('break-even-duration-ms', breakEven, UNIT.MS),
    metric('exit-basis-bps', input.exitBasisBps, UNIT.BPS),
  ]);
}

export interface FundingSpreadEconomicsInput {
  readonly longFundingPpm: bigint;
  readonly shortFundingPpm: bigint;
  readonly expectedHoldingDurationMs: bigint;
  readonly reversalThresholdPpm: bigint;
  readonly longLiquidationDistanceBps: bigint;
  readonly shortLiquidationDistanceBps: bigint;
  readonly totalMarginAtoms: bigint;
}

export function fundingSpreadMetrics(input: FundingSpreadEconomicsInput): readonly StrategyQuoteMetricInput[] {
  const long = signed(input.longFundingPpm, 'fundingSpreadMetrics.longFundingPpm');
  const short = signed(input.shortFundingPpm, 'fundingSpreadMetrics.shortFundingPpm');
  const minimumDistance = input.longLiquidationDistanceBps < input.shortLiquidationDistanceBps
    ? input.longLiquidationDistanceBps
    : input.shortLiquidationDistanceBps;
  return Object.freeze([
    metric('net-funding-differential-ppm', short - long, UNIT.PPM),
    metric('expected-holding-duration-ms', positive(input.expectedHoldingDurationMs, 'fundingSpreadMetrics.expectedHoldingDurationMs'), UNIT.MS),
    metric('reversal-threshold-ppm', input.reversalThresholdPpm, UNIT.PPM),
    metric('minimum-liquidation-distance-bps', minimumDistance, UNIT.BPS),
    metric('total-margin-atoms', nonnegative(input.totalMarginAtoms, 'fundingSpreadMetrics.totalMarginAtoms'), UNIT.ATOMS),
  ]);
}

export interface MigrationEconomicsInput {
  readonly sourceCloseCostAtoms: bigint;
  readonly destinationOpenCostAtoms: bigint;
  readonly feesAtoms: bigint;
  readonly overlapDurationMs: bigint;
  readonly maximumInterimDeltaAtoms: bigint;
  readonly sourceClosePriceTicks: bigint;
  readonly destinationOpenPriceTicks: bigint;
}

export function hedgeMigrationMetrics(input: MigrationEconomicsInput): readonly StrategyQuoteMetricInput[] {
  const cost = nonnegative(input.sourceCloseCostAtoms, 'hedgeMigrationMetrics.sourceCloseCostAtoms')
    + nonnegative(input.destinationOpenCostAtoms, 'hedgeMigrationMetrics.destinationOpenCostAtoms')
    + nonnegative(input.feesAtoms, 'hedgeMigrationMetrics.feesAtoms');
  return Object.freeze([
    metric('migration-cost-atoms', cost, UNIT.ATOMS),
    metric('overlap-duration-ms', nonnegative(input.overlapDurationMs, 'hedgeMigrationMetrics.overlapDurationMs'), UNIT.MS),
    metric('maximum-interim-delta-atoms', input.maximumInterimDeltaAtoms, UNIT.BASE_ATOMS),
    metric('source-close-price-ticks', input.sourceClosePriceTicks, UNIT.TICKS),
    metric('destination-open-price-ticks', input.destinationOpenPriceTicks, UNIT.TICKS),
  ]);
}

export interface RebalanceEconomicsInput {
  readonly preDeltaAtoms: bigint;
  readonly postDeltaAtoms: bigint;
  readonly rebalanceCostAtoms: bigint;
  readonly maximumSlippageAtoms: bigint;
  readonly postLiquidationDistanceBps: bigint;
}

export function deltaNeutralRebalanceMetrics(input: RebalanceEconomicsInput): readonly StrategyQuoteMetricInput[] {
  return Object.freeze([
    metric('pre-delta-atoms', input.preDeltaAtoms, UNIT.BASE_ATOMS),
    metric('post-delta-atoms', input.postDeltaAtoms, UNIT.BASE_ATOMS),
    metric('rebalance-cost-atoms', nonnegative(input.rebalanceCostAtoms, 'deltaNeutralRebalanceMetrics.rebalanceCostAtoms'), UNIT.ATOMS),
    metric('maximum-slippage-atoms', nonnegative(input.maximumSlippageAtoms, 'deltaNeutralRebalanceMetrics.maximumSlippageAtoms'), UNIT.ATOMS),
    metric('post-liquidation-distance-bps', input.postLiquidationDistanceBps, UNIT.BPS),
  ]);
}

export interface TreasuryHedgeEconomicsInput {
  readonly inventoryAtoms: bigint;
  readonly hedgeAtoms: bigint;
  readonly hedgeCostAtoms: bigint;
  readonly maximumLossAtoms: bigint;
  readonly liquidationDistanceBps: bigint;
}

export function treasuryInventoryHedgeMetrics(input: TreasuryHedgeEconomicsInput): readonly StrategyQuoteMetricInput[] {
  const inventory = positive(input.inventoryAtoms, 'treasuryInventoryHedgeMetrics.inventoryAtoms');
  const hedge = signed(input.hedgeAtoms, 'treasuryInventoryHedgeMetrics.hedgeAtoms');
  return Object.freeze([
    metric('hedged-inventory-atoms', inventory, UNIT.BASE_ATOMS),
    metric('hedge-ratio-ppm', ratio(hedge, PPM, inventory, 'treasuryInventoryHedgeMetrics.hedgeRatio'), UNIT.PPM),
    metric('hedge-cost-atoms', nonnegative(input.hedgeCostAtoms, 'treasuryInventoryHedgeMetrics.hedgeCostAtoms'), UNIT.ATOMS),
    metric('maximum-loss-atoms', nonnegative(input.maximumLossAtoms, 'treasuryInventoryHedgeMetrics.maximumLossAtoms'), UNIT.ATOMS),
    metric('liquidation-distance-bps', input.liquidationDistanceBps, UNIT.BPS),
  ]);
}

export interface CalendarSpreadEconomicsInput {
  readonly nearPriceTicks: bigint;
  readonly farPriceTicks: bigint;
  readonly nearMaturityMs: bigint;
  readonly farMaturityMs: bigint;
  readonly netMarginAtoms: bigint;
}

export function calendarSpreadMetrics(input: CalendarSpreadEconomicsInput): readonly StrategyQuoteMetricInput[] {
  const nearMaturity = positive(input.nearMaturityMs, 'calendarSpreadMetrics.nearMaturityMs');
  const farMaturity = positive(input.farMaturityMs, 'calendarSpreadMetrics.farMaturityMs');
  if (farMaturity <= nearMaturity) throw new MalformedInputError('calendarSpreadMetrics.farMaturityMs', 'far maturity must follow near maturity');
  const nearPrice = positive(input.nearPriceTicks, 'calendarSpreadMetrics.nearPriceTicks');
  const spread = signed(input.farPriceTicks, 'calendarSpreadMetrics.farPriceTicks') - nearPrice;
  const annualized = ratio(spread * YEAR_MS, PPM, nearPrice * (farMaturity - nearMaturity), 'calendarSpreadMetrics.annualizedRollYield');
  return Object.freeze([
    metric('calendar-spread-ticks', spread, UNIT.TICKS),
    metric('annualized-roll-yield-ppm', annualized, UNIT.PPM),
    metric('near-maturity-ms', nearMaturity, UNIT.MS),
    metric('far-maturity-ms', farMaturity, UNIT.MS),
    metric('net-margin-atoms', input.netMarginAtoms, UNIT.ATOMS),
  ]);
}

export interface OptionSpreadEconomicsInput {
  readonly netPremiumAtoms: bigint;
  readonly deltaPpm: bigint;
  readonly gammaPpm: bigint;
  readonly vegaPpm: bigint;
  readonly thetaPpm: bigint;
  readonly maximumProfitAtoms: bigint;
  readonly maximumLossAtoms: bigint;
  readonly impliedVolatilityPpm: bigint;
  readonly volatilitySpreadPpm: bigint;
}

export function optionSpreadMetrics(input: OptionSpreadEconomicsInput): readonly StrategyQuoteMetricInput[] {
  return Object.freeze([
    metric('net-premium-atoms', input.netPremiumAtoms, UNIT.ATOMS),
    metric('delta-ppm', input.deltaPpm, UNIT.PPM),
    metric('gamma-ppm', input.gammaPpm, UNIT.PPM),
    metric('vega-ppm', input.vegaPpm, UNIT.PPM),
    metric('theta-ppm', input.thetaPpm, UNIT.PPM),
    metric('maximum-profit-atoms', input.maximumProfitAtoms, UNIT.ATOMS),
    metric('maximum-loss-atoms', nonnegative(input.maximumLossAtoms, 'optionSpreadMetrics.maximumLossAtoms'), UNIT.ATOMS),
    metric('implied-volatility-ppm', input.impliedVolatilityPpm, UNIT.PPM),
    metric('volatility-spread-ppm', input.volatilitySpreadPpm, UNIT.PPM),
  ]);
}

export interface CollateralConversionEconomicsInput {
  readonly conversionOutputAtoms: bigint;
  readonly hedgeNotionalAtoms: bigint;
  readonly conversionCostAtoms: bigint;
  readonly hedgeCostAtoms: bigint;
  readonly postMarginHealthBps: bigint;
  readonly maximumInterimDeltaAtoms: bigint;
}

export function collateralConversionMetrics(input: CollateralConversionEconomicsInput): readonly StrategyQuoteMetricInput[] {
  return Object.freeze([
    metric('conversion-output-atoms', nonnegative(input.conversionOutputAtoms, 'collateralConversionMetrics.conversionOutputAtoms'), UNIT.BASE_ATOMS),
    metric('hedge-notional-atoms', nonnegative(input.hedgeNotionalAtoms, 'collateralConversionMetrics.hedgeNotionalAtoms'), UNIT.ATOMS),
    metric('net-conversion-cost-atoms', nonnegative(input.conversionCostAtoms, 'collateralConversionMetrics.conversionCostAtoms') + nonnegative(input.hedgeCostAtoms, 'collateralConversionMetrics.hedgeCostAtoms'), UNIT.ATOMS),
    metric('post-margin-health-bps', input.postMarginHealthBps, UNIT.BPS),
    metric('maximum-interim-delta-atoms', input.maximumInterimDeltaAtoms, UNIT.BASE_ATOMS),
  ]);
}

export interface FixedRateRefinanceEconomicsInput {
  readonly principalAtoms: bigint;
  readonly interestAtoms: bigint;
  readonly feesAtoms: bigint;
  readonly maturityMs: bigint;
  readonly collateralRequiredAtoms: bigint;
  readonly existingAnnualizedRatePpm: bigint;
}

export function fixedRateRefinanceMetrics(input: FixedRateRefinanceEconomicsInput): readonly StrategyQuoteMetricInput[] {
  const principal = positive(input.principalAtoms, 'fixedRateRefinanceMetrics.principalAtoms');
  const interest = nonnegative(input.interestAtoms, 'fixedRateRefinanceMetrics.interestAtoms');
  const fees = nonnegative(input.feesAtoms, 'fixedRateRefinanceMetrics.feesAtoms');
  const maturity = positive(input.maturityMs, 'fixedRateRefinanceMetrics.maturityMs');
  const totalCost = interest + fees;
  const effectiveRate = ratio(totalCost * YEAR_MS, PPM, principal * maturity, 'fixedRateRefinanceMetrics.effectiveRate');
  const savingsPpm = signed(input.existingAnnualizedRatePpm, 'fixedRateRefinanceMetrics.existingAnnualizedRatePpm') - effectiveRate;
  const breakEven = savingsPpm > 0n ? ratio(fees, PPM * YEAR_MS, principal * savingsPpm, 'fixedRateRefinanceMetrics.breakEven') : 0n;
  return Object.freeze([
    metric('effective-financing-rate-ppm', effectiveRate, UNIT.PPM),
    metric('maturity-ms', maturity, UNIT.MS),
    metric('total-refinancing-cost-atoms', totalCost, UNIT.ATOMS),
    metric('collateral-required-atoms', nonnegative(input.collateralRequiredAtoms, 'fixedRateRefinanceMetrics.collateralRequiredAtoms'), UNIT.ATOMS),
    metric('break-even-duration-ms', breakEven, UNIT.MS),
  ]);
}

export interface StructuredHedgeEconomicsInput {
  readonly netPremiumAtoms: bigint;
  readonly protectedNotionalAtoms: bigint;
  readonly downsideFloorTicks: bigint;
  readonly upsideCapTicks: bigint;
  readonly deltaPpm: bigint;
  readonly maximumLossAtoms: bigint;
}

export function structuredHedgeMetrics(input: StructuredHedgeEconomicsInput): readonly StrategyQuoteMetricInput[] {
  return Object.freeze([
    metric('net-premium-atoms', input.netPremiumAtoms, UNIT.ATOMS),
    metric('protected-notional-atoms', nonnegative(input.protectedNotionalAtoms, 'structuredHedgeMetrics.protectedNotionalAtoms'), UNIT.ATOMS),
    metric('downside-floor-ticks', input.downsideFloorTicks, UNIT.TICKS),
    metric('upside-cap-ticks', input.upsideCapTicks, UNIT.TICKS),
    metric('delta-ppm', input.deltaPpm, UNIT.PPM),
    metric('maximum-loss-atoms', nonnegative(input.maximumLossAtoms, 'structuredHedgeMetrics.maximumLossAtoms'), UNIT.ATOMS),
  ]);
}

export interface SessionAwareEconomicsInput {
  readonly sessionStateCode: bigint;
  readonly referencePriceTicks: bigint;
  readonly sessionRiskPremiumBps: bigint;
  readonly hedgedNotionalAtoms: bigint;
  readonly maximumGapLossAtoms: bigint;
  readonly nextSessionBoundaryMs: bigint;
}

export function sessionAwareTokenizedAssetMetrics(input: SessionAwareEconomicsInput): readonly StrategyQuoteMetricInput[] {
  return Object.freeze([
    metric('session-state-code', input.sessionStateCode, UNIT.CODE),
    metric('reference-price-ticks', input.referencePriceTicks, UNIT.TICKS),
    metric('session-risk-premium-bps', input.sessionRiskPremiumBps, UNIT.BPS),
    metric('hedged-notional-atoms', nonnegative(input.hedgedNotionalAtoms, 'sessionAwareTokenizedAssetMetrics.hedgedNotionalAtoms'), UNIT.ATOMS),
    metric('maximum-gap-loss-atoms', nonnegative(input.maximumGapLossAtoms, 'sessionAwareTokenizedAssetMetrics.maximumGapLossAtoms'), UNIT.ATOMS),
    metric('next-session-boundary-ms', nonnegative(input.nextSessionBoundaryMs, 'sessionAwareTokenizedAssetMetrics.nextSessionBoundaryMs'), UNIT.MS),
  ]);
}

export type StrategyEconomicsInput =
  | BasisPackageEconomicsInput
  | Readonly<{ templateId: typeof STRATEGY_TEMPLATE_ID.PERPETUAL_FUNDING_SPREAD; values: FundingSpreadEconomicsInput }>
  | Readonly<{ templateId: typeof STRATEGY_TEMPLATE_ID.HEDGE_MIGRATION; values: MigrationEconomicsInput }>
  | Readonly<{ templateId: typeof STRATEGY_TEMPLATE_ID.DELTA_NEUTRAL_REBALANCE; values: RebalanceEconomicsInput }>
  | Readonly<{ templateId: typeof STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE; values: TreasuryHedgeEconomicsInput }>
  | Readonly<{ templateId: typeof STRATEGY_TEMPLATE_ID.CALENDAR_SPREAD; values: CalendarSpreadEconomicsInput }>
  | Readonly<{ templateId: typeof STRATEGY_TEMPLATE_ID.OPTION_SPREAD; values: OptionSpreadEconomicsInput }>
  | Readonly<{ templateId: typeof STRATEGY_TEMPLATE_ID.COLLATERAL_CONVERSION_HEDGE; values: CollateralConversionEconomicsInput }>
  | Readonly<{ templateId: typeof STRATEGY_TEMPLATE_ID.FIXED_RATE_REFINANCE; values: FixedRateRefinanceEconomicsInput }>
  | Readonly<{ templateId: typeof STRATEGY_TEMPLATE_ID.SOL_STRUCTURED_HEDGE; values: StructuredHedgeEconomicsInput }>
  | Readonly<{ templateId: typeof STRATEGY_TEMPLATE_ID.SESSION_AWARE_TOKENIZED_ASSET; values: SessionAwareEconomicsInput }>;

export function strategyEconomicsMetrics(input: StrategyEconomicsInput): readonly StrategyQuoteMetricInput[] {
  switch (input.templateId) {
    case STRATEGY_TEMPLATE_ID.CASH_AND_CARRY:
    case STRATEGY_TEMPLATE_ID.REVERSE_CASH_AND_CARRY:
      return basisPackageMetrics(input);
    case STRATEGY_TEMPLATE_ID.PERPETUAL_FUNDING_SPREAD:
      return fundingSpreadMetrics(input.values);
    case STRATEGY_TEMPLATE_ID.HEDGE_MIGRATION:
      return hedgeMigrationMetrics(input.values);
    case STRATEGY_TEMPLATE_ID.DELTA_NEUTRAL_REBALANCE:
      return deltaNeutralRebalanceMetrics(input.values);
    case STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE:
      return treasuryInventoryHedgeMetrics(input.values);
    case STRATEGY_TEMPLATE_ID.CALENDAR_SPREAD:
      return calendarSpreadMetrics(input.values);
    case STRATEGY_TEMPLATE_ID.OPTION_SPREAD:
      return optionSpreadMetrics(input.values);
    case STRATEGY_TEMPLATE_ID.COLLATERAL_CONVERSION_HEDGE:
      return collateralConversionMetrics(input.values);
    case STRATEGY_TEMPLATE_ID.FIXED_RATE_REFINANCE:
      return fixedRateRefinanceMetrics(input.values);
    case STRATEGY_TEMPLATE_ID.SOL_STRUCTURED_HEDGE:
      return structuredHedgeMetrics(input.values);
    case STRATEGY_TEMPLATE_ID.SESSION_AWARE_TOKENIZED_ASSET:
      return sessionAwareTokenizedAssetMetrics(input.values);
  }
}

export function isImplementedStrategyTemplateId(value: string): value is StrategyTemplateId {
  return Object.values(STRATEGY_TEMPLATE_ID).includes(value as StrategyTemplateId);
}
