import { MalformedInputError, RangeViolationError } from './errors.js';

export type EnumTable<Name extends string> = Readonly<Record<Name, number>>;

// Discriminant 0 is reserved on every table so an all-zero payload can never decode
// to a valid variant.
export const EXPIRY_UNIT = Object.freeze({
  SOLANA_SLOT: 1,
  EVM_UNIX_SECONDS: 2,
  HYPERLIQUID_UNIX_MILLISECONDS: 3,
} as const);
export type ExpiryUnit = keyof typeof EXPIRY_UNIT;

export const DURATION_UNIT = Object.freeze({
  MILLISECONDS: 1,
} as const);
export type DurationUnit = keyof typeof DURATION_UNIT;

export const DIRECTION = Object.freeze({
  LONG_SPOT_SHORT_PERP: 1,
} as const);
export type Direction = keyof typeof DIRECTION;

export const PACKAGE_ACTION = Object.freeze({
  ENTRY: 1,
  EXIT: 2,
} as const);
export type PackageAction = keyof typeof PACKAGE_ACTION;

export const PACKAGE_ORDER_TYPE = Object.freeze({
  LIMIT: 1,
  MARKETABLE_LIMIT: 2,
  POST_ONLY: 3,
  CONDITIONAL: 4,
  SCHEDULED: 5,
  PACKAGE_TWAP: 6,
} as const);
export type PackageOrderType = keyof typeof PACKAGE_ORDER_TYPE;

export const PACKAGE_TIME_IN_FORCE = Object.freeze({
  IOC: 1,
  FOK: 2,
  GTC: 3,
  GTD: 4,
} as const);
export type PackageTimeInForce = keyof typeof PACKAGE_TIME_IN_FORCE;

export const RECOVERY_ACTION = Object.freeze({
  CANCEL_OPEN_ORDERS: 1,
  COMPLETE_SPOT: 2,
  COMPLETE_PERP: 3,
  ROLLBACK_SPOT: 4,
  ROLLBACK_PERP: 5,
} as const);
export type RecoveryAction = keyof typeof RECOVERY_ACTION;

export const SETTLEMENT_CLASS = Object.freeze({
  ATOMIC_POSTCONDITION: 1,
  BATCHED_IOC_WITH_RECOVERY: 2,
  ASYNC_BONDED_SOLVER: 3,
  /** Pre-positioned inventory per domain with coordinated prepare, commit, and compensation; never atomic. */
  CROSS_DOMAIN_PREPOSITIONED: 4,
  /** Automation stopped and authority fenced; only incident-approved actions run. */
  MANUAL_CONTROLLED_RECOVERY: 5,
} as const);
export type SettlementClass = keyof typeof SETTLEMENT_CLASS;

export const QUANTITY_POLICY_CLASS = Object.freeze({
  EXACT_ATOMIC: 1,
  EXACT_NET: 2,
  BOUNDED_NET: 3,
} as const);
export type QuantityPolicyClass = keyof typeof QUANTITY_POLICY_CLASS;

export const PARTIAL_FILL_POLICY = Object.freeze({
  EXACT_ALL_LEGS: 1,
} as const);
export type PartialFillPolicy = keyof typeof PARTIAL_FILL_POLICY;

export const EXECUTION_PLAN_KIND = Object.freeze({
  SVM_ATOMIC_CPI: 1,
  EVM_ATOMIC_BATCH: 2,
  HYPERCORE_BATCHED_IOC: 3,
  EVM_ASYNC_REQUEST: 4,
} as const);
export type ExecutionPlanKind = keyof typeof EXECUTION_PLAN_KIND;

export const ASYNC_BONDED_STATE = Object.freeze({
  RESERVED: 1,
  REQUEST_SUBMITTED: 2,
  VENUE_PENDING: 3,
  EXECUTED: 4,
  CANCELLED: 5,
  FROZEN: 6,
  RECOVERY_PENDING: 7,
  RECOVERED: 8,
  MANUAL_INTERVENTION: 9,
  CLOSED: 10,
} as const);
export type AsyncBondedState = keyof typeof ASYNC_BONDED_STATE;

export const LEG_ROLE = Object.freeze({
  SPOT: 1,
  PERPETUAL: 2,
} as const);
export type LegRole = keyof typeof LEG_ROLE;

export const TRADE_SIDE = Object.freeze({
  BUY: 1,
  SELL: 2,
} as const);
export type TradeSide = keyof typeof TRADE_SIDE;

export const LATE_BOUND_FIELD_KIND = Object.freeze({
  ROUTE_HASH: 1,
  QUOTE_HASH: 2,
  SOLVER_SIGNATURE: 3,
  OWNER_AUTHORIZATION: 4,
} as const);
export type LateBoundFieldKind = keyof typeof LATE_BOUND_FIELD_KIND;

export const COMPARATOR = Object.freeze({
  EQ: 1,
  LTE: 2,
  GTE: 3,
} as const);
export type Comparator = keyof typeof COMPARATOR;

export const STATE_VALUE_KIND = Object.freeze({
  SIGNED_ASSET_AMOUNT: 1,
  UNSIGNED_U256: 2,
  COMMITMENT_HASH: 3,
  PROTOCOL_ID: 4,
  BOOLEAN: 5,
} as const);
export type StateValueKind = keyof typeof STATE_VALUE_KIND;

// Activation state is the same contract for every registry record kind, so one table serves
// the template record and the domain registry record alike.
export const REGISTRY_STATE = Object.freeze({
  ACTIVE: 1,
  ENTRY_PAUSED: 2,
  EXIT_ONLY: 3,
  ALL_PAUSED: 4,
  DEPRECATED: 5,
} as const);
export type RegistryState = keyof typeof REGISTRY_STATE;

export const REGISTRY_RECORD_KIND = Object.freeze({
  ASSET: 1,
  VENUE: 2,
  MARKET: 3,
  ADAPTER: 4,
  PRICE_SOURCE: 5,
  PACKAGE_TEMPLATE: 6,
} as const);
export type RegistryRecordKind = keyof typeof REGISTRY_RECORD_KIND;

export const RISK_LIMIT_KIND = Object.freeze({
  MAX_PACKAGE_NOTIONAL: 1,
  MAX_OPEN_NOTIONAL: 2,
  OUTFLOW_RATE: 3,
} as const);
export type RiskLimitKind = keyof typeof RISK_LIMIT_KIND;

export const FEE_CATEGORY = Object.freeze({
  PROTOCOL: 1,
  SOLVER: 2,
  BUILDER: 3,
} as const);
export type FeeCategory = keyof typeof FEE_CATEGORY;

export const PASS_THROUGH_COST_CATEGORY = Object.freeze({
  VENUE: 1,
  NETWORK: 2,
  RECOVERY: 3,
} as const);
export type PassThroughCostCategory = keyof typeof PASS_THROUGH_COST_CATEGORY;

export const SERVICE_FEE_RATE_BASE = Object.freeze({
  MATCHED_PACKAGE_NOTIONAL: 1,
} as const);
export type ServiceFeeRateBase = keyof typeof SERVICE_FEE_RATE_BASE;

export const ROUNDING_DIRECTION = Object.freeze({
  FLOOR: 1,
  CEIL: 2,
  TOWARD_ZERO: 3,
  AWAY_FROM_ZERO: 4,
} as const);
export type RoundingDirection = keyof typeof ROUNDING_DIRECTION;

export const REFUND_RULE = Object.freeze({
  REFUND_UNUSED_PREPAID_TO_OWNER: 1,
} as const);
export type RefundRule = keyof typeof REFUND_RULE;

export const ADAPTER_IDENTITY_SOURCE = Object.freeze({
  EXACT: 1,
  DOMAIN_CONFIGURATION: 2,
  SIGNED_ORDER: 3,
  SIGNED_ROUTE: 4,
  CLASS_DERIVED: 5,
} as const);
export type AdapterIdentitySource = keyof typeof ADAPTER_IDENTITY_SOURCE;

export const ADAPTER_ACCESS_MODE = Object.freeze({
  OBSERVE: 1,
  MUTATE: 2,
  INVOKE: 3,
  ASSET_DEBIT: 4,
  ASSET_CREDIT: 5,
} as const);
export type AdapterAccessMode = keyof typeof ADAPTER_ACCESS_MODE;

export const ADAPTER_SIGNER_MODE = Object.freeze({
  NONE: 1,
  RUNTIME_SIGNATURE: 2,
  VERIFIED_AUTHORIZATION: 3,
  PROGRAM_DERIVED: 4,
} as const);
export type AdapterSignerMode = keyof typeof ADAPTER_SIGNER_MODE;

export const SOLVER_SIGNATURE_SCHEME = Object.freeze({
  ED25519: 1,
  SECP256K1_RECOVERABLE: 2,
} as const);
export type SolverSignatureScheme = keyof typeof SOLVER_SIGNATURE_SCHEME;

export const QUOTE_MODE = Object.freeze({
  IMPLIED: 1,
  EXECUTION_COMMITMENT: 2,
  FIRM_SIMULATED: 3,
  FIRM_ONCHAIN: 4,
  /** A funded reservation plus a performance bond that pays if the solver fails to honor it. */
  FIRM_BONDED: 5,
} as const);
export type QuoteMode = keyof typeof QUOTE_MODE;

export const QUOTED_OUTCOME_KIND = Object.freeze({
  ENTRY_SPREAD: 1,
  EXIT_QUOTE_OUTCOME: 2,
} as const);
export type QuotedOutcomeKind = keyof typeof QUOTED_OUTCOME_KIND;

export function enumDiscriminant<Name extends string>(
  table: EnumTable<Name>,
  name: Name,
  context = 'enum',
): number {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(table, name)) {
    throw new MalformedInputError(context, `unknown variant ${String(name)}`);
  }
  const discriminant = table[name];
  if (!Number.isInteger(discriminant) || discriminant < 1 || discriminant > 0xff) {
    throw new RangeViolationError(context, `discriminant ${discriminant} outside 1..255`);
  }
  return discriminant;
}
