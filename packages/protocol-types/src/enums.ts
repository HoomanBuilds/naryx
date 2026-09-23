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

export const SETTLEMENT_CLASS = Object.freeze({
  ATOMIC_POSTCONDITION: 1,
  BATCHED_IOC_WITH_RECOVERY: 2,
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
