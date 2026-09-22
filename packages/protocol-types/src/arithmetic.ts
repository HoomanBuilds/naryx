import {
  DivisionByZeroError,
  MalformedInputError,
  RangeViolationError,
} from './errors.js';

export const ROUNDING = Object.freeze({
  FLOOR: 'FLOOR',
  CEIL: 'CEIL',
  TOWARD_ZERO: 'TOWARD_ZERO',
  AWAY_FROM_ZERO: 'AWAY_FROM_ZERO',
} as const);
export type Rounding = (typeof ROUNDING)[keyof typeof ROUNDING];

export const U32_MAX = 0xffffffff;

export function toBigInt(value: bigint | number, context = 'integer'): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a bigint or a number');
  }
  if (!Number.isFinite(value)) {
    throw new MalformedInputError(context, `not a finite number: ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new MalformedInputError(context, `not an integer: ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeViolationError(context, `outside the safe integer range: ${value}`);
  }
  return BigInt(value);
}

function assertBits(bits: number, context: string): void {
  if (!Number.isInteger(bits) || bits < 1 || bits > 256) {
    throw new MalformedInputError(context, `unsupported width ${bits}`);
  }
}

export function checkedUnsigned(value: bigint | number, bits: number, context = 'unsigned'): bigint {
  assertBits(bits, context);
  const normalized = toBigInt(value, context);
  const max = (1n << BigInt(bits)) - 1n;
  if (normalized < 0n || normalized > max) {
    throw new RangeViolationError(context, `u${bits} value ${normalized} outside 0..${max}`);
  }
  return normalized;
}

export function checkedSigned(value: bigint | number, bits: number, context = 'signed'): bigint {
  assertBits(bits, context);
  const normalized = toBigInt(value, context);
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (normalized < min || normalized > max) {
    throw new RangeViolationError(context, `i${bits} value ${normalized} outside ${min}..${max}`);
  }
  return normalized;
}

export function absBigInt(value: bigint): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError('absBigInt', 'expected a bigint');
  }
  return value < 0n ? -value : value;
}

export function assertU32Length(value: number, context = 'length'): number {
  if (!Number.isInteger(value)) {
    throw new MalformedInputError(context, `not an integer length: ${String(value)}`);
  }
  if (value < 0 || value > U32_MAX) {
    throw new RangeViolationError(context, `length ${value} outside 0..${U32_MAX}`);
  }
  return value;
}

function applyRounding(
  quotient: bigint,
  remainder: bigint,
  negative: boolean,
  rounding: Rounding,
  context: string,
): bigint {
  if (remainder === 0n) return quotient;
  switch (rounding) {
    case ROUNDING.FLOOR:
      return negative ? quotient - 1n : quotient;
    case ROUNDING.CEIL:
      return negative ? quotient : quotient + 1n;
    case ROUNDING.TOWARD_ZERO:
      return quotient;
    case ROUNDING.AWAY_FROM_ZERO:
      return negative ? quotient - 1n : quotient + 1n;
    default:
      throw new MalformedInputError(context, `unknown rounding mode ${String(rounding)}`);
  }
}

export function mulDiv(
  left: bigint,
  right: bigint,
  divisor: bigint,
  rounding: Rounding,
  context = 'mulDiv',
): bigint {
  if (typeof left !== 'bigint' || typeof right !== 'bigint' || typeof divisor !== 'bigint') {
    throw new MalformedInputError(context, 'expected bigint operands');
  }
  if (divisor === 0n) {
    throw new DivisionByZeroError(context, 'divisor is zero');
  }
  const product = left * right;
  const quotient = product / divisor;
  const remainder = product % divisor;
  const negative = (product < 0n) !== (divisor < 0n);
  return applyRounding(quotient, remainder, negative, rounding, context);
}

export function scaleDecimals(
  value: bigint,
  fromDecimals: number,
  toDecimals: number,
  rounding: Rounding,
  context = 'scaleDecimals',
): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint value');
  }
  const from = checkedUnsigned(fromDecimals, 8, `${context}.fromDecimals`);
  const to = checkedUnsigned(toDecimals, 8, `${context}.toDecimals`);
  if (to >= from) {
    return value * 10n ** (to - from);
  }
  const divisor = 10n ** (from - to);
  const quotient = value / divisor;
  const remainder = value % divisor;
  return applyRounding(quotient, remainder, value < 0n, rounding, context);
}
