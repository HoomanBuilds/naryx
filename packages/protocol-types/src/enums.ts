import { MalformedInputError, RangeViolationError } from './errors.js';

export type EnumTable<Name extends string> = Readonly<Record<Name, number>>;

// Discriminant 0 is reserved on every table so an all-zero payload can never decode
// to a valid variant.
export const EXPIRY_UNIT = Object.freeze({
  SOLANA_LAST_VALID_BLOCK_HEIGHT: 1,
  EVM_UNIX_SECONDS: 2,
  HYPERLIQUID_UNIX_MILLISECONDS: 3,
} as const);
export type ExpiryUnit = keyof typeof EXPIRY_UNIT;

export const PACKAGE_KIND = Object.freeze({
  CASH_AND_CARRY_V1: 1,
} as const);
export type PackageKind = keyof typeof PACKAGE_KIND;

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

export const TEMPLATE_REGISTRY_STATE = Object.freeze({
  ACTIVE: 1,
  ENTRY_PAUSED: 2,
  EXIT_ONLY: 3,
  ALL_PAUSED: 4,
  DEPRECATED: 5,
} as const);
export type TemplateRegistryState = keyof typeof TEMPLATE_REGISTRY_STATE;

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
