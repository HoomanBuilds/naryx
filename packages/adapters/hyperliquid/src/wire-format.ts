import type { ExactPrice } from '@naryx/protocol-types';

export interface HypercoreFormattedPrice {
  readonly value: string;
  readonly scaled: bigint;
  readonly decimals: number;
}

export function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function divideRounded(
  numerator: bigint,
  denominator: bigint,
  direction: ExactPrice['roundingDirection'],
): bigint {
  if (numerator <= 0n || denominator <= 0n) throw new Error('price ratio must be positive');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n || direction === 'FLOOR' || direction === 'TOWARD_ZERO') return quotient;
  return quotient + 1n;
}

function decimalString(scaled: bigint, decimals: number): string {
  const digits = scaled.toString().padStart(decimals + 1, '0');
  if (decimals === 0) return digits;
  const integer = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
}

function significantFigures(value: string): number {
  if (!value.includes('.')) return 0;
  return value.replace('.', '').replace(/^0+/, '').length;
}

export function formatHypercorePrice(
  price: ExactPrice,
  maxDecimals: number,
): HypercoreFormattedPrice {
  const numerator = price.quoteAtoms * powerOfTen(price.baseAsset.decimals);
  const denominator = price.baseAtoms * powerOfTen(price.quoteAsset.decimals);
  for (let decimals = maxDecimals; decimals >= 0; decimals -= 1) {
    const scaled = divideRounded(
      numerator * powerOfTen(decimals),
      denominator,
      price.roundingDirection,
    );
    if (scaled === 0n) continue;
    const value = decimalString(scaled, decimals);
    if (significantFigures(value) <= 5) return { value, scaled, decimals };
  }
  throw new Error('limit price cannot be represented by HyperCore price rules');
}

export function formatHypercoreSize(
  quantityAtoms: bigint,
  assetDecimals: number,
  sizeDecimals: number,
): string {
  if (quantityAtoms <= 0n) throw new Error('order size must be positive');
  const numerator = quantityAtoms * powerOfTen(sizeDecimals);
  const denominator = powerOfTen(assetDecimals);
  if (numerator % denominator !== 0n) throw new Error('order size is not aligned to HyperCore size decimals');
  const scaled = numerator / denominator;
  if (scaled === 0n) throw new Error('order size rounds to zero');
  return decimalString(scaled, sizeDecimals);
}
