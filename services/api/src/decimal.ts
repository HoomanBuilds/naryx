export function parseDecimalAtoms(value: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"));
}

export function formatDecimalAtoms(atoms: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = atoms / scale;
  const fraction = (atoms % scale).toString().padStart(decimals, "0");
  return `${whole}.${fraction}`;
}

export function multiplyDivideFloor(value: bigint, multiplier: bigint, divisor: bigint): bigint {
  return value * multiplier / divisor;
}

export function multiplyDivideCeil(value: bigint, multiplier: bigint, divisor: bigint): bigint {
  return (value * multiplier + divisor - 1n) / divisor;
}
