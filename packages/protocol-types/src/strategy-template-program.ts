import { protocolId, type ProtocolId } from './primitives.js';
import {
  packageGraph,
  type GraphLegSide,
  type GraphLifecycleAction,
  type LegFamily,
  type PackageGraphInput,
} from './package-graph.js';
import {
  SETTLEMENT_CLASS,
  type SettlementClass,
} from './enums.js';
import { MalformedInputError } from './errors.js';

export const STRATEGY_TEMPLATE_PROGRAM_VERSION = 1;

export const STRATEGY_TEMPLATE_ID = Object.freeze({
  CASH_AND_CARRY: 'cash-and-carry-v1',
  REVERSE_CASH_AND_CARRY: 'reverse-cash-and-carry-v1',
  PERPETUAL_FUNDING_SPREAD: 'perpetual-funding-spread-v1',
  HEDGE_MIGRATION: 'hedge-migration-v1',
  DELTA_NEUTRAL_REBALANCE: 'delta-neutral-rebalance-v1',
  TREASURY_INVENTORY_HEDGE: 'treasury-inventory-hedge-v1',
  CALENDAR_SPREAD: 'calendar-spread-v1',
  OPTION_SPREAD: 'option-spread-v1',
  COLLATERAL_CONVERSION_HEDGE: 'collateral-conversion-hedge-v1',
  FIXED_RATE_REFINANCE: 'fixed-rate-refinance-v1',
  SOL_STRUCTURED_HEDGE: 'sol-structured-hedge-v1',
  SESSION_AWARE_TOKENIZED_ASSET: 'session-aware-tokenized-asset-v1',
} as const);

export type StrategyTemplateId = (typeof STRATEGY_TEMPLATE_ID)[keyof typeof STRATEGY_TEMPLATE_ID];

export const STRATEGY_QUOTE_CONVENTION_ID = Object.freeze({
  ANNUALIZED_NET_YIELD: 'annualized-net-yield-v1',
  FUNDING_DIFFERENTIAL: 'funding-differential-v1',
  MIGRATION_COST: 'migration-cost-v1',
  DELTA_DEVIATION: 'delta-deviation-v1',
  HEDGE_COST: 'hedge-cost-v1',
  FORWARD_BASIS: 'forward-basis-v1',
  NET_PREMIUM_AND_GREEKS: 'net-premium-greeks-v1',
  CONVERSION_HEDGE_COST: 'conversion-hedge-cost-v1',
  EFFECTIVE_FINANCING_RATE: 'effective-financing-rate-v1',
  STRUCTURED_PAYOFF: 'structured-payoff-v1',
  SESSION_ADJUSTED_BASIS: 'session-adjusted-basis-v1',
} as const);

export const STRATEGY_RISK_CLASS_ID = Object.freeze({
  DELTA_NEUTRAL_BASIS: 'delta-neutral-basis-v1',
  BORROWED_BASIS: 'borrowed-basis-v1',
  FUNDING_SPREAD: 'funding-spread-v1',
  MIGRATION: 'hedge-migration-v1',
  REBALANCE: 'delta-rebalance-v1',
  TREASURY_HEDGE: 'treasury-hedge-v1',
  CALENDAR: 'calendar-spread-v1',
  OPTIONS: 'options-defined-risk-v1',
  COLLATERAL: 'collateral-conversion-v1',
  REFINANCE: 'fixed-rate-refinance-v1',
  STRUCTURED_HEDGE: 'structured-hedge-v1',
  SESSION_BOUND: 'session-bound-asset-v1',
} as const);

export interface StrategyTemplateLegRule {
  readonly legTypeId: ProtocolId;
  readonly allowedFamilies: readonly LegFamily[];
  readonly allowedSides: readonly GraphLegSide[];
  readonly minimumCount: number;
  readonly maximumCount: number;
}

export interface StrategyTemplateActionSpec {
  readonly action: GraphLifecycleAction;
  readonly minimumLegs: number;
  readonly maximumLegs: number;
  readonly allowedSettlementClasses: readonly SettlementClass[];
  readonly legRules: readonly StrategyTemplateLegRule[];
}

export interface StrategyTemplateDefinition {
  readonly programVersion: 1;
  readonly templateId: ProtocolId;
  readonly templateVersion: 1;
  readonly displayName: string;
  readonly quoteConventionId: ProtocolId;
  readonly riskClassId: ProtocolId;
  readonly lifecycleConventionId: ProtocolId;
  readonly metricIds: readonly ProtocolId[];
  readonly actionSpecs: readonly StrategyTemplateActionSpec[];
}

export type StrategyTemplateGraphRejection =
  | 'TEMPLATE_UNSUPPORTED'
  | 'TEMPLATE_VERSION_UNSUPPORTED'
  | 'ACTION_UNSUPPORTED'
  | 'SETTLEMENT_CLASS_UNSUPPORTED'
  | 'LEG_COUNT_OUT_OF_RANGE'
  | 'LEG_TYPE_UNSUPPORTED'
  | 'LEG_FAMILY_UNSUPPORTED'
  | 'LEG_SIDE_UNSUPPORTED'
  | 'LEG_ROLE_COUNT_INVALID';

export type StrategyTemplateGraphValidation =
  | Readonly<{ valid: true; definition: StrategyTemplateDefinition; actionSpec: StrategyTemplateActionSpec }>
  | Readonly<{ valid: false; reasons: readonly StrategyTemplateGraphRejection[] }>;

const ATOMIC_AND_RECOVERABLE = Object.freeze([
  'ATOMIC_POSTCONDITION',
  'BATCHED_IOC_WITH_RECOVERY',
  'ASYNC_BONDED_SOLVER',
] as const satisfies readonly SettlementClass[]);

const RECOVERABLE = Object.freeze([
  'BATCHED_IOC_WITH_RECOVERY',
  'ASYNC_BONDED_SOLVER',
  'CROSS_DOMAIN_PREPOSITIONED',
] as const satisfies readonly SettlementClass[]);

const ALL_SETTLEMENT_CLASSES = Object.freeze(
  Object.keys(SETTLEMENT_CLASS) as SettlementClass[],
);

const BUY_SELL = Object.freeze(['BUY', 'SELL'] as const satisfies readonly GraphLegSide[]);
const NONE = Object.freeze(['NONE'] as const satisfies readonly GraphLegSide[]);

function rule(
  legTypeId: string,
  allowedFamilies: readonly LegFamily[],
  allowedSides: readonly GraphLegSide[],
  minimumCount = 1,
  maximumCount = 1,
): StrategyTemplateLegRule {
  return Object.freeze({
    legTypeId: protocolId(legTypeId, 'strategyTemplate.legTypeId'),
    allowedFamilies: Object.freeze([...allowedFamilies]),
    allowedSides: Object.freeze([...allowedSides]),
    minimumCount,
    maximumCount,
  });
}

function action(
  lifecycleAction: GraphLifecycleAction,
  minimumLegs: number,
  maximumLegs: number,
  legRules: readonly StrategyTemplateLegRule[],
  allowedSettlementClasses: readonly SettlementClass[] = ATOMIC_AND_RECOVERABLE,
): StrategyTemplateActionSpec {
  return Object.freeze({
    action: lifecycleAction,
    minimumLegs,
    maximumLegs,
    allowedSettlementClasses: Object.freeze([...allowedSettlementClasses]),
    legRules: Object.freeze([...legRules]),
  });
}

function definition(input: Omit<StrategyTemplateDefinition, 'programVersion' | 'templateVersion' | 'templateId' | 'quoteConventionId' | 'riskClassId' | 'lifecycleConventionId' | 'metricIds'> & Readonly<{
  templateId: string;
  quoteConventionId: string;
  riskClassId: string;
  lifecycleConventionId: string;
  metricIds: readonly string[];
}>): StrategyTemplateDefinition {
  return Object.freeze({
    programVersion: STRATEGY_TEMPLATE_PROGRAM_VERSION,
    templateId: protocolId(input.templateId, 'strategyTemplate.templateId'),
    templateVersion: 1,
    displayName: input.displayName,
    quoteConventionId: protocolId(input.quoteConventionId, 'strategyTemplate.quoteConventionId'),
    riskClassId: protocolId(input.riskClassId, 'strategyTemplate.riskClassId'),
    lifecycleConventionId: protocolId(input.lifecycleConventionId, 'strategyTemplate.lifecycleConventionId'),
    metricIds: Object.freeze(input.metricIds.map((value) => protocolId(value, 'strategyTemplate.metricId'))),
    actionSpecs: Object.freeze([...input.actionSpecs]),
  });
}

const CASH_ENTRY = Object.freeze([
  rule('spot-purchase', ['SPOT_SWAP'], ['BUY']),
  rule('perp-sale', ['PERP_OPEN'], ['SELL']),
]);
const CASH_EXIT = Object.freeze([
  rule('spot-purchase', ['SPOT_SWAP'], ['SELL']),
  rule('perp-sale', ['PERP_CLOSE'], ['BUY']),
]);

const DEFINITIONS: readonly StrategyTemplateDefinition[] = Object.freeze([
  definition({
    templateId: STRATEGY_TEMPLATE_ID.CASH_AND_CARRY,
    displayName: 'Cash and carry',
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.ANNUALIZED_NET_YIELD,
    riskClassId: STRATEGY_RISK_CLASS_ID.DELTA_NEUTRAL_BASIS,
    lifecycleConventionId: 'paired-basis-lifecycle-v1',
    metricIds: ['entry-basis-bps', 'net-annualized-yield-ppm', 'expected-funding-atoms', 'capital-required-atoms', 'break-even-duration-ms', 'exit-basis-bps'],
    actionSpecs: [
      action('ENTRY', 2, 2, CASH_ENTRY),
      action('INCREASE', 2, 2, CASH_ENTRY),
      action('DECREASE', 2, 2, CASH_EXIT),
      action('EXIT', 2, 2, CASH_EXIT),
      action('REBALANCE', 1, 2, [
        rule('spot-purchase', ['SPOT_SWAP'], BUY_SELL, 0, 1),
        rule('perp-sale', ['PERP_INCREASE', 'PERP_DECREASE'], BUY_SELL, 0, 1),
      ]),
      action('ROLL', 2, 2, [
        rule('perp-sale-close', ['PERP_CLOSE'], ['BUY']),
        rule('perp-sale-open', ['PERP_OPEN'], ['SELL']),
      ], RECOVERABLE),
      action('MIGRATE', 2, 2, [
        rule('perp-sale-close', ['PERP_CLOSE'], ['BUY']),
        rule('perp-sale-open', ['PERP_OPEN'], ['SELL']),
      ], RECOVERABLE),
      action('EMERGENCY_UNWIND', 1, 2, [
        rule('spot-purchase', ['SPOT_SWAP'], ['SELL'], 0, 1),
        rule('perp-sale', ['PERP_CLOSE'], ['BUY'], 0, 1),
      ], ALL_SETTLEMENT_CLASSES),
    ],
  }),
  definition({
    templateId: STRATEGY_TEMPLATE_ID.REVERSE_CASH_AND_CARRY,
    displayName: 'Reverse cash and carry',
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.ANNUALIZED_NET_YIELD,
    riskClassId: STRATEGY_RISK_CLASS_ID.BORROWED_BASIS,
    lifecycleConventionId: 'borrowed-basis-lifecycle-v1',
    metricIds: ['entry-basis-bps', 'net-annualized-yield-ppm', 'borrow-cost-atoms', 'capital-required-atoms', 'break-even-duration-ms', 'exit-basis-bps'],
    actionSpecs: [
      action('ENTRY', 3, 3, [
        rule('base-borrow', ['BORROW'], NONE),
        rule('spot-sale', ['SPOT_SWAP'], ['SELL']),
        rule('perp-purchase', ['PERP_OPEN'], ['BUY']),
      ], ATOMIC_AND_RECOVERABLE),
      action('INCREASE', 3, 3, [
        rule('base-borrow', ['BORROW'], NONE),
        rule('spot-sale', ['SPOT_SWAP'], ['SELL']),
        rule('perp-purchase', ['PERP_INCREASE'], ['BUY']),
      ], ATOMIC_AND_RECOVERABLE),
      action('DECREASE', 3, 3, [
        rule('base-borrow', ['REPAY'], NONE),
        rule('spot-sale', ['SPOT_SWAP'], ['BUY']),
        rule('perp-purchase', ['PERP_DECREASE'], ['SELL']),
      ], ATOMIC_AND_RECOVERABLE),
      action('EXIT', 3, 3, [
        rule('base-borrow', ['REPAY'], NONE),
        rule('spot-sale', ['SPOT_SWAP'], ['BUY']),
        rule('perp-purchase', ['PERP_CLOSE'], ['SELL']),
      ], ATOMIC_AND_RECOVERABLE),
      action('REBALANCE', 1, 3, [
        rule('base-borrow', ['BORROW', 'REPAY'], NONE, 0, 1),
        rule('spot-sale', ['SPOT_SWAP'], BUY_SELL, 0, 1),
        rule('perp-purchase', ['PERP_INCREASE', 'PERP_DECREASE'], BUY_SELL, 0, 1),
      ], ATOMIC_AND_RECOVERABLE),
      action('ROLL', 2, 2, [
        rule('perp-purchase-close', ['PERP_CLOSE'], ['SELL']),
        rule('perp-purchase-open', ['PERP_OPEN'], ['BUY']),
      ], RECOVERABLE),
      action('MIGRATE', 2, 2, [
        rule('perp-purchase-close', ['PERP_CLOSE'], ['SELL']),
        rule('perp-purchase-open', ['PERP_OPEN'], ['BUY']),
      ], RECOVERABLE),
      action('EMERGENCY_UNWIND', 2, 3, [
        rule('base-borrow', ['REPAY'], NONE, 0, 1),
        rule('spot-sale', ['SPOT_SWAP'], ['BUY'], 0, 1),
        rule('perp-purchase', ['PERP_CLOSE'], ['SELL'], 0, 1),
      ], ALL_SETTLEMENT_CLASSES),
    ],
  }),
  definition({
    templateId: STRATEGY_TEMPLATE_ID.PERPETUAL_FUNDING_SPREAD,
    displayName: 'Perpetual funding spread',
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.FUNDING_DIFFERENTIAL,
    riskClassId: STRATEGY_RISK_CLASS_ID.FUNDING_SPREAD,
    lifecycleConventionId: 'paired-perpetual-lifecycle-v1',
    metricIds: ['net-funding-differential-ppm', 'expected-holding-duration-ms', 'reversal-threshold-ppm', 'minimum-liquidation-distance-bps', 'total-margin-atoms'],
    actionSpecs: [
      action('ENTRY', 2, 2, [rule('funding-long', ['PERP_OPEN'], ['BUY']), rule('funding-short', ['PERP_OPEN'], ['SELL'])], RECOVERABLE),
      action('INCREASE', 2, 2, [rule('funding-long', ['PERP_INCREASE'], ['BUY']), rule('funding-short', ['PERP_INCREASE'], ['SELL'])], RECOVERABLE),
      action('DECREASE', 2, 2, [rule('funding-long', ['PERP_DECREASE'], ['SELL']), rule('funding-short', ['PERP_DECREASE'], ['BUY'])], RECOVERABLE),
      action('EXIT', 2, 2, [rule('funding-long', ['PERP_CLOSE'], ['SELL']), rule('funding-short', ['PERP_CLOSE'], ['BUY'])], RECOVERABLE),
      action('REBALANCE', 1, 2, [rule('funding-long', ['PERP_INCREASE', 'PERP_DECREASE'], BUY_SELL, 0, 1), rule('funding-short', ['PERP_INCREASE', 'PERP_DECREASE'], BUY_SELL, 0, 1)], RECOVERABLE),
      action('MIGRATE', 2, 4, [
        rule('funding-close', ['PERP_CLOSE'], BUY_SELL, 1, 2),
        rule('funding-open', ['PERP_OPEN'], BUY_SELL, 1, 2),
      ], RECOVERABLE),
      action('EMERGENCY_UNWIND', 1, 2, [rule('funding-long', ['PERP_CLOSE'], ['SELL'], 0, 1), rule('funding-short', ['PERP_CLOSE'], ['BUY'], 0, 1)], ALL_SETTLEMENT_CLASSES),
    ],
  }),
  definition({
    templateId: STRATEGY_TEMPLATE_ID.HEDGE_MIGRATION,
    displayName: 'Hedge migration',
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.MIGRATION_COST,
    riskClassId: STRATEGY_RISK_CLASS_ID.MIGRATION,
    lifecycleConventionId: 'perpetual-migration-lifecycle-v1',
    metricIds: ['migration-cost-atoms', 'overlap-duration-ms', 'maximum-interim-delta-atoms', 'source-close-price-ticks', 'destination-open-price-ticks'],
    actionSpecs: [
      action('MIGRATE', 2, 2, [rule('source-hedge', ['PERP_CLOSE'], BUY_SELL), rule('destination-hedge', ['PERP_OPEN'], BUY_SELL)], RECOVERABLE),
      action('EMERGENCY_UNWIND', 1, 2, [rule('source-hedge', ['PERP_CLOSE'], BUY_SELL, 0, 1), rule('destination-hedge', ['PERP_CLOSE'], BUY_SELL, 0, 1)], ALL_SETTLEMENT_CLASSES),
    ],
  }),
  definition({
    templateId: STRATEGY_TEMPLATE_ID.DELTA_NEUTRAL_REBALANCE,
    displayName: 'Delta neutral rebalance',
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.DELTA_DEVIATION,
    riskClassId: STRATEGY_RISK_CLASS_ID.REBALANCE,
    lifecycleConventionId: 'delta-band-lifecycle-v1',
    metricIds: ['pre-delta-atoms', 'post-delta-atoms', 'rebalance-cost-atoms', 'maximum-slippage-atoms', 'post-liquidation-distance-bps'],
    actionSpecs: [
      action('REBALANCE', 1, 16, [
        rule('spot-adjustment', ['SPOT_SWAP', 'INVENTORY_TRANSFER'], BUY_SELL, 0, 8),
        rule('perp-adjustment', ['PERP_INCREASE', 'PERP_DECREASE'], BUY_SELL, 0, 8),
      ], RECOVERABLE),
      action('EMERGENCY_UNWIND', 1, 16, [
        rule('spot-adjustment', ['SPOT_SWAP'], BUY_SELL, 0, 8),
        rule('perp-adjustment', ['PERP_CLOSE', 'PERP_DECREASE'], BUY_SELL, 0, 8),
      ], ALL_SETTLEMENT_CLASSES),
    ],
  }),
  definition({
    templateId: STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE,
    displayName: 'Treasury inventory hedge',
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.HEDGE_COST,
    riskClassId: STRATEGY_RISK_CLASS_ID.TREASURY_HEDGE,
    lifecycleConventionId: 'inventory-hedge-lifecycle-v1',
    metricIds: ['hedged-inventory-atoms', 'hedge-ratio-ppm', 'hedge-cost-atoms', 'maximum-loss-atoms', 'liquidation-distance-bps'],
    actionSpecs: [
      action('ENTRY', 1, 2, [rule('inventory-position', ['INVENTORY_TRANSFER'], NONE, 0, 1), rule('treasury-hedge', ['PERP_OPEN', 'FUTURE_OPEN', 'OPTION_BUY'], BUY_SELL)], ATOMIC_AND_RECOVERABLE),
      action('INCREASE', 1, 2, [rule('inventory-position', ['INVENTORY_TRANSFER'], NONE, 0, 1), rule('treasury-hedge', ['PERP_INCREASE', 'FUTURE_OPEN', 'OPTION_BUY'], BUY_SELL)], ATOMIC_AND_RECOVERABLE),
      action('DECREASE', 1, 2, [rule('inventory-position', ['INVENTORY_TRANSFER'], NONE, 0, 1), rule('treasury-hedge', ['PERP_DECREASE', 'FUTURE_CLOSE', 'OPTION_SELL'], BUY_SELL)], ATOMIC_AND_RECOVERABLE),
      action('EXIT', 1, 2, [rule('inventory-position', ['INVENTORY_TRANSFER'], NONE, 0, 1), rule('treasury-hedge', ['PERP_CLOSE', 'FUTURE_CLOSE', 'OPTION_SELL', 'OPTION_EXERCISE', 'OPTION_CASH_SETTLE'], BUY_SELL)], ATOMIC_AND_RECOVERABLE),
      action('REBALANCE', 1, 2, [rule('inventory-position', ['INVENTORY_TRANSFER'], NONE, 0, 1), rule('treasury-hedge', ['PERP_INCREASE', 'PERP_DECREASE', 'FUTURE_ROLL', 'OPTION_BUY', 'OPTION_SELL'], BUY_SELL)], ATOMIC_AND_RECOVERABLE),
      action('ROLL', 2, 2, [rule('treasury-hedge-close', ['PERP_CLOSE', 'FUTURE_CLOSE', 'OPTION_SELL', 'OPTION_CASH_SETTLE'], BUY_SELL), rule('treasury-hedge-open', ['PERP_OPEN', 'FUTURE_OPEN', 'OPTION_BUY'], BUY_SELL)], RECOVERABLE),
      action('EMERGENCY_UNWIND', 1, 2, [rule('inventory-position', ['INVENTORY_TRANSFER'], NONE, 0, 1), rule('treasury-hedge', ['PERP_CLOSE', 'FUTURE_CLOSE', 'OPTION_SELL', 'OPTION_EXERCISE', 'OPTION_CASH_SETTLE'], BUY_SELL)], ALL_SETTLEMENT_CLASSES),
    ],
  }),
  definition({
    templateId: STRATEGY_TEMPLATE_ID.CALENDAR_SPREAD,
    displayName: 'Calendar spread',
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.FORWARD_BASIS,
    riskClassId: STRATEGY_RISK_CLASS_ID.CALENDAR,
    lifecycleConventionId: 'calendar-roll-lifecycle-v1',
    metricIds: ['calendar-spread-ticks', 'annualized-roll-yield-ppm', 'near-maturity-ms', 'far-maturity-ms', 'net-margin-atoms'],
    actionSpecs: [
      action('ENTRY', 2, 2, [rule('near-future', ['FUTURE_OPEN'], BUY_SELL), rule('far-future', ['FUTURE_OPEN'], BUY_SELL)], RECOVERABLE),
      action('INCREASE', 2, 2, [rule('near-future', ['FUTURE_OPEN'], BUY_SELL), rule('far-future', ['FUTURE_OPEN'], BUY_SELL)], RECOVERABLE),
      action('DECREASE', 2, 2, [rule('near-future', ['FUTURE_CLOSE'], BUY_SELL), rule('far-future', ['FUTURE_CLOSE'], BUY_SELL)], RECOVERABLE),
      action('EXIT', 2, 2, [rule('near-future', ['FUTURE_CLOSE'], BUY_SELL), rule('far-future', ['FUTURE_CLOSE'], BUY_SELL)], RECOVERABLE),
      action('REBALANCE', 1, 2, [rule('near-future', ['FUTURE_OPEN', 'FUTURE_CLOSE'], BUY_SELL, 0, 1), rule('far-future', ['FUTURE_OPEN', 'FUTURE_CLOSE'], BUY_SELL, 0, 1)], RECOVERABLE),
      action('ROLL', 2, 3, [rule('near-future', ['FUTURE_CLOSE', 'FUTURE_ROLL'], BUY_SELL), rule('far-future', ['FUTURE_CLOSE', 'FUTURE_ROLL'], BUY_SELL, 0, 1), rule('next-future', ['FUTURE_OPEN'], BUY_SELL)], RECOVERABLE),
      action('EMERGENCY_UNWIND', 1, 2, [rule('near-future', ['FUTURE_CLOSE'], BUY_SELL, 0, 1), rule('far-future', ['FUTURE_CLOSE'], BUY_SELL, 0, 1)], ALL_SETTLEMENT_CLASSES),
    ],
  }),
  definition({
    templateId: STRATEGY_TEMPLATE_ID.OPTION_SPREAD,
    displayName: 'Option spread',
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.NET_PREMIUM_AND_GREEKS,
    riskClassId: STRATEGY_RISK_CLASS_ID.OPTIONS,
    lifecycleConventionId: 'defined-risk-option-lifecycle-v1',
    metricIds: ['net-premium-atoms', 'delta-ppm', 'gamma-ppm', 'vega-ppm', 'theta-ppm', 'maximum-profit-atoms', 'maximum-loss-atoms', 'implied-volatility-ppm', 'volatility-spread-ppm'],
    actionSpecs: [
      action('ENTRY', 2, 8, [rule('option-long', ['OPTION_BUY'], ['BUY'], 1, 4), rule('option-short', ['OPTION_SELL', 'OPTION_MINT'], ['SELL'], 1, 4)], ATOMIC_AND_RECOVERABLE),
      action('INCREASE', 1, 8, [rule('option-long', ['OPTION_BUY'], ['BUY'], 0, 4), rule('option-short', ['OPTION_SELL', 'OPTION_MINT'], ['SELL'], 0, 4)], ATOMIC_AND_RECOVERABLE),
      action('DECREASE', 1, 8, [rule('option-long', ['OPTION_SELL', 'OPTION_EXERCISE', 'OPTION_CASH_SETTLE'], BUY_SELL, 0, 4), rule('option-short', ['OPTION_BUY', 'OPTION_CASH_SETTLE'], BUY_SELL, 0, 4)], ATOMIC_AND_RECOVERABLE),
      action('EXIT', 1, 8, [rule('option-long', ['OPTION_SELL', 'OPTION_EXERCISE', 'OPTION_CASH_SETTLE'], BUY_SELL, 0, 4), rule('option-short', ['OPTION_BUY', 'OPTION_CASH_SETTLE'], BUY_SELL, 0, 4)], ATOMIC_AND_RECOVERABLE),
      action('ROLL', 3, 16, [rule('option-close', ['OPTION_BUY', 'OPTION_SELL', 'OPTION_CASH_SETTLE'], BUY_SELL, 1, 8), rule('option-open', ['OPTION_BUY', 'OPTION_SELL', 'OPTION_MINT'], BUY_SELL, 2, 8)], ATOMIC_AND_RECOVERABLE),
      action('REBALANCE', 1, 4, [rule('delta-hedge', ['SPOT_SWAP', 'PERP_INCREASE', 'PERP_DECREASE'], BUY_SELL, 1, 4)], ATOMIC_AND_RECOVERABLE),
      action('MIGRATE', 2, 16, [rule('option-close', ['OPTION_BUY', 'OPTION_SELL', 'OPTION_CASH_SETTLE'], BUY_SELL, 1, 8), rule('option-open', ['OPTION_BUY', 'OPTION_SELL', 'OPTION_MINT'], BUY_SELL, 1, 8)], ATOMIC_AND_RECOVERABLE),
      action('EMERGENCY_UNWIND', 1, 8, [rule('option-long', ['OPTION_SELL', 'OPTION_EXERCISE', 'OPTION_CASH_SETTLE'], BUY_SELL, 0, 4), rule('option-short', ['OPTION_BUY', 'OPTION_CASH_SETTLE'], BUY_SELL, 0, 4)], ALL_SETTLEMENT_CLASSES),
    ],
  }),
  definition({
    templateId: STRATEGY_TEMPLATE_ID.COLLATERAL_CONVERSION_HEDGE,
    displayName: 'Collateral conversion and hedge',
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.CONVERSION_HEDGE_COST,
    riskClassId: STRATEGY_RISK_CLASS_ID.COLLATERAL,
    lifecycleConventionId: 'collateral-conversion-lifecycle-v1',
    metricIds: ['conversion-output-atoms', 'hedge-notional-atoms', 'net-conversion-cost-atoms', 'post-margin-health-bps', 'maximum-interim-delta-atoms'],
    actionSpecs: [
      action('ENTRY', 3, 3, [rule('collateral-swap', ['SPOT_SWAP'], BUY_SELL), rule('collateral-transfer', ['COLLATERAL_TRANSFER', 'MARGIN_DEPOSIT'], NONE), rule('conversion-hedge', ['PERP_OPEN'], BUY_SELL)], ATOMIC_AND_RECOVERABLE),
      action('INCREASE', 2, 3, [rule('collateral-swap', ['SPOT_SWAP'], BUY_SELL, 0, 1), rule('collateral-transfer', ['COLLATERAL_TRANSFER', 'MARGIN_DEPOSIT'], NONE), rule('conversion-hedge', ['PERP_INCREASE'], BUY_SELL)], ATOMIC_AND_RECOVERABLE),
      action('DECREASE', 2, 3, [rule('collateral-swap', ['SPOT_SWAP'], BUY_SELL, 0, 1), rule('collateral-transfer', ['MARGIN_RELEASE', 'COLLATERAL_TRANSFER'], NONE), rule('conversion-hedge', ['PERP_DECREASE'], BUY_SELL)], ATOMIC_AND_RECOVERABLE),
      action('EXIT', 3, 3, [rule('collateral-swap', ['SPOT_SWAP'], BUY_SELL), rule('collateral-transfer', ['MARGIN_RELEASE', 'COLLATERAL_TRANSFER'], NONE), rule('conversion-hedge', ['PERP_CLOSE'], BUY_SELL)], ATOMIC_AND_RECOVERABLE),
      action('REBALANCE', 1, 3, [rule('collateral-swap', ['SPOT_SWAP'], BUY_SELL, 0, 1), rule('collateral-transfer', ['COLLATERAL_TRANSFER', 'MARGIN_DEPOSIT', 'MARGIN_RELEASE'], NONE, 0, 1), rule('conversion-hedge', ['PERP_INCREASE', 'PERP_DECREASE'], BUY_SELL, 0, 1)], ATOMIC_AND_RECOVERABLE),
      action('MIGRATE', 4, 5, [rule('source-release', ['MARGIN_RELEASE', 'COLLATERAL_TRANSFER'], NONE), rule('collateral-swap', ['SPOT_SWAP'], BUY_SELL, 0, 1), rule('destination-deposit', ['COLLATERAL_TRANSFER', 'MARGIN_DEPOSIT'], NONE), rule('source-hedge', ['PERP_CLOSE'], BUY_SELL), rule('destination-hedge', ['PERP_OPEN'], BUY_SELL, 0, 1)], RECOVERABLE),
      action('EMERGENCY_UNWIND', 1, 3, [rule('collateral-swap', ['SPOT_SWAP'], BUY_SELL, 0, 1), rule('collateral-transfer', ['MARGIN_RELEASE', 'COLLATERAL_TRANSFER'], NONE, 0, 1), rule('conversion-hedge', ['PERP_CLOSE'], BUY_SELL, 0, 1)], ALL_SETTLEMENT_CLASSES),
    ],
  }),
  definition({
    templateId: STRATEGY_TEMPLATE_ID.FIXED_RATE_REFINANCE,
    displayName: 'Fixed rate refinance',
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.EFFECTIVE_FINANCING_RATE,
    riskClassId: STRATEGY_RISK_CLASS_ID.REFINANCE,
    lifecycleConventionId: 'refinance-lifecycle-v1',
    metricIds: ['effective-financing-rate-ppm', 'maturity-ms', 'total-refinancing-cost-atoms', 'collateral-required-atoms', 'break-even-duration-ms'],
    actionSpecs: [
      action('MIGRATE', 3, 5, [rule('old-debt-repay', ['REPAY'], NONE), rule('old-collateral-release', ['WITHDRAW', 'MARGIN_RELEASE', 'COLLATERAL_TRANSFER'], NONE, 0, 1), rule('new-collateral-deposit', ['LEND', 'MARGIN_DEPOSIT', 'COLLATERAL_TRANSFER'], NONE, 0, 1), rule('new-fixed-borrow', ['BORROW'], NONE), rule('currency-conversion', ['SPOT_SWAP'], BUY_SELL, 0, 1)], RECOVERABLE),
      action('EXIT', 2, 3, [rule('new-fixed-borrow', ['REPAY'], NONE), rule('new-collateral-deposit', ['WITHDRAW', 'MARGIN_RELEASE', 'COLLATERAL_TRANSFER'], NONE), rule('currency-conversion', ['SPOT_SWAP'], BUY_SELL, 0, 1)], RECOVERABLE),
      action('EMERGENCY_UNWIND', 1, 3, [rule('new-fixed-borrow', ['REPAY'], NONE, 0, 1), rule('new-collateral-deposit', ['WITHDRAW', 'MARGIN_RELEASE', 'COLLATERAL_TRANSFER'], NONE, 0, 1), rule('currency-conversion', ['SPOT_SWAP'], BUY_SELL, 0, 1)], ALL_SETTLEMENT_CLASSES),
    ],
  }),
  definition({
    templateId: STRATEGY_TEMPLATE_ID.SOL_STRUCTURED_HEDGE,
    displayName: 'SOL structured hedge',
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.STRUCTURED_PAYOFF,
    riskClassId: STRATEGY_RISK_CLASS_ID.STRUCTURED_HEDGE,
    lifecycleConventionId: 'structured-hedge-lifecycle-v1',
    metricIds: ['net-premium-atoms', 'protected-notional-atoms', 'downside-floor-ticks', 'upside-cap-ticks', 'delta-ppm', 'maximum-loss-atoms'],
    actionSpecs: [
      action('ENTRY', 2, 8, [rule('option-protection', ['OPTION_BUY', 'OPTION_SELL', 'OPTION_MINT'], BUY_SELL, 1, 6), rule('delta-overlay', ['SPOT_SWAP', 'PERP_OPEN'], BUY_SELL, 0, 2)], RECOVERABLE),
      action('INCREASE', 1, 8, [rule('option-protection', ['OPTION_BUY', 'OPTION_SELL', 'OPTION_MINT'], BUY_SELL, 0, 6), rule('delta-overlay', ['SPOT_SWAP', 'PERP_INCREASE'], BUY_SELL, 0, 2)], RECOVERABLE),
      action('DECREASE', 1, 8, [rule('option-protection', ['OPTION_BUY', 'OPTION_SELL', 'OPTION_CASH_SETTLE'], BUY_SELL, 0, 6), rule('delta-overlay', ['SPOT_SWAP', 'PERP_DECREASE'], BUY_SELL, 0, 2)], RECOVERABLE),
      action('EXIT', 1, 8, [rule('option-protection', ['OPTION_BUY', 'OPTION_SELL', 'OPTION_EXERCISE', 'OPTION_CASH_SETTLE'], BUY_SELL, 1, 6), rule('delta-overlay', ['SPOT_SWAP', 'PERP_CLOSE'], BUY_SELL, 0, 2)], RECOVERABLE),
      action('REBALANCE', 1, 4, [rule('delta-overlay', ['SPOT_SWAP', 'PERP_INCREASE', 'PERP_DECREASE'], BUY_SELL, 1, 4)], RECOVERABLE),
      action('ROLL', 2, 12, [rule('option-close', ['OPTION_BUY', 'OPTION_SELL', 'OPTION_CASH_SETTLE'], BUY_SELL, 1, 6), rule('option-open', ['OPTION_BUY', 'OPTION_SELL', 'OPTION_MINT'], BUY_SELL, 1, 6)], RECOVERABLE),
      action('EMERGENCY_UNWIND', 1, 8, [rule('option-protection', ['OPTION_BUY', 'OPTION_SELL', 'OPTION_EXERCISE', 'OPTION_CASH_SETTLE'], BUY_SELL, 0, 6), rule('delta-overlay', ['SPOT_SWAP', 'PERP_CLOSE'], BUY_SELL, 0, 2)], ALL_SETTLEMENT_CLASSES),
    ],
  }),
  definition({
    templateId: STRATEGY_TEMPLATE_ID.SESSION_AWARE_TOKENIZED_ASSET,
    displayName: 'Session aware tokenized asset package',
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.SESSION_ADJUSTED_BASIS,
    riskClassId: STRATEGY_RISK_CLASS_ID.SESSION_BOUND,
    lifecycleConventionId: 'session-aware-lifecycle-v1',
    metricIds: ['session-state-code', 'reference-price-ticks', 'session-risk-premium-bps', 'hedged-notional-atoms', 'maximum-gap-loss-atoms', 'next-session-boundary-ms'],
    actionSpecs: [
      action('ENTRY', 2, 3, [rule('tokenized-asset', ['SPOT_SWAP', 'INVENTORY_TRANSFER'], BUY_SELL), rule('session-hedge', ['PERP_OPEN', 'FUTURE_OPEN', 'OPTION_BUY'], BUY_SELL), rule('margin-funding', ['MARGIN_DEPOSIT'], NONE, 0, 1)], RECOVERABLE),
      action('INCREASE', 2, 3, [rule('tokenized-asset', ['SPOT_SWAP', 'INVENTORY_TRANSFER'], BUY_SELL), rule('session-hedge', ['PERP_INCREASE', 'FUTURE_OPEN', 'OPTION_BUY'], BUY_SELL), rule('margin-funding', ['MARGIN_DEPOSIT'], NONE, 0, 1)], RECOVERABLE),
      action('DECREASE', 2, 3, [rule('tokenized-asset', ['SPOT_SWAP', 'INVENTORY_TRANSFER'], BUY_SELL), rule('session-hedge', ['PERP_DECREASE', 'FUTURE_CLOSE', 'OPTION_SELL', 'OPTION_CASH_SETTLE'], BUY_SELL), rule('margin-funding', ['MARGIN_RELEASE'], NONE, 0, 1)], RECOVERABLE),
      action('EXIT', 2, 3, [rule('tokenized-asset', ['SPOT_SWAP', 'INVENTORY_TRANSFER'], BUY_SELL), rule('session-hedge', ['PERP_CLOSE', 'FUTURE_CLOSE', 'OPTION_SELL', 'OPTION_CASH_SETTLE'], BUY_SELL), rule('margin-funding', ['MARGIN_RELEASE'], NONE, 0, 1)], RECOVERABLE),
      action('REBALANCE', 1, 3, [rule('tokenized-asset', ['SPOT_SWAP', 'INVENTORY_TRANSFER'], BUY_SELL, 0, 1), rule('session-hedge', ['PERP_INCREASE', 'PERP_DECREASE', 'FUTURE_ROLL', 'OPTION_BUY', 'OPTION_SELL'], BUY_SELL, 1, 2)], RECOVERABLE),
      action('ROLL', 2, 4, [rule('session-hedge-close', ['PERP_CLOSE', 'FUTURE_CLOSE', 'OPTION_SELL', 'OPTION_CASH_SETTLE'], BUY_SELL), rule('session-hedge-open', ['PERP_OPEN', 'FUTURE_OPEN', 'OPTION_BUY'], BUY_SELL), rule('margin-funding', ['MARGIN_DEPOSIT', 'MARGIN_RELEASE'], NONE, 0, 2)], RECOVERABLE),
      action('MIGRATE', 2, 5, [rule('tokenized-asset', ['SPOT_SWAP', 'INVENTORY_TRANSFER'], BUY_SELL, 0, 1), rule('session-hedge-close', ['PERP_CLOSE', 'FUTURE_CLOSE', 'OPTION_SELL', 'OPTION_CASH_SETTLE'], BUY_SELL), rule('session-hedge-open', ['PERP_OPEN', 'FUTURE_OPEN', 'OPTION_BUY'], BUY_SELL), rule('margin-funding', ['MARGIN_DEPOSIT', 'MARGIN_RELEASE'], NONE, 0, 2)], RECOVERABLE),
      action('EMERGENCY_UNWIND', 1, 3, [rule('tokenized-asset', ['SPOT_SWAP', 'INVENTORY_TRANSFER'], BUY_SELL, 0, 1), rule('session-hedge', ['PERP_CLOSE', 'FUTURE_CLOSE', 'OPTION_SELL', 'OPTION_CASH_SETTLE'], BUY_SELL, 0, 1), rule('margin-funding', ['MARGIN_RELEASE'], NONE, 0, 1)], ALL_SETTLEMENT_CLASSES),
    ],
  }),
]);

const BY_ID = new Map<string, StrategyTemplateDefinition>(
  DEFINITIONS.map((value) => [value.templateId, value]),
);

export function strategyTemplateDefinitions(): readonly StrategyTemplateDefinition[] {
  return DEFINITIONS;
}

export function strategyTemplateDefinition(templateId: string): StrategyTemplateDefinition | undefined {
  return BY_ID.get(templateId);
}

export function requireStrategyTemplateDefinition(templateId: string): StrategyTemplateDefinition {
  const checked = protocolId(templateId, 'strategyTemplateDefinition.templateId');
  const found = BY_ID.get(checked);
  if (found === undefined) {
    throw new MalformedInputError('strategyTemplateDefinition.templateId', `unsupported template ${checked}`);
  }
  return found;
}

export function validateStrategyTemplateGraph(input: PackageGraphInput): StrategyTemplateGraphValidation {
  const graph = packageGraph(input, 'validateStrategyTemplateGraph.graph');
  const found = BY_ID.get(graph.templateId);
  if (found === undefined) {
    return Object.freeze({ valid: false as const, reasons: Object.freeze(['TEMPLATE_UNSUPPORTED'] as const) });
  }
  const reasons = new Set<StrategyTemplateGraphRejection>();
  if (graph.templateVersion !== found.templateVersion) reasons.add('TEMPLATE_VERSION_UNSUPPORTED');
  const spec = found.actionSpecs.find((candidate) => candidate.action === graph.lifecycleAction);
  if (spec === undefined) {
    reasons.add('ACTION_UNSUPPORTED');
    return Object.freeze({ valid: false as const, reasons: Object.freeze([...reasons]) });
  }
  if (!spec.allowedSettlementClasses.includes(graph.settlementClass)) reasons.add('SETTLEMENT_CLASS_UNSUPPORTED');
  if (graph.legs.length < spec.minimumLegs || graph.legs.length > spec.maximumLegs) reasons.add('LEG_COUNT_OUT_OF_RANGE');
  const rules = new Map(spec.legRules.map((value) => [value.legTypeId, value]));
  const counts = new Map<string, number>();
  for (const leg of graph.legs) {
    const legRule = rules.get(leg.legTypeId);
    if (legRule === undefined) {
      reasons.add('LEG_TYPE_UNSUPPORTED');
      continue;
    }
    counts.set(leg.legTypeId, (counts.get(leg.legTypeId) ?? 0) + 1);
    if (!legRule.allowedFamilies.includes(leg.legFamily)) reasons.add('LEG_FAMILY_UNSUPPORTED');
    if (!legRule.allowedSides.includes(leg.side)) reasons.add('LEG_SIDE_UNSUPPORTED');
  }
  for (const legRule of spec.legRules) {
    const count = counts.get(legRule.legTypeId) ?? 0;
    if (count < legRule.minimumCount || count > legRule.maximumCount) reasons.add('LEG_ROLE_COUNT_INVALID');
  }
  if (reasons.size > 0) {
    return Object.freeze({ valid: false as const, reasons: Object.freeze([...reasons].sort()) });
  }
  return Object.freeze({ valid: true as const, definition: found, actionSpec: spec });
}
