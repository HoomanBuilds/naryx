const U128_MAX = (1n << 128n) - 1n;

export interface ImpliedBackingUnits {
  readonly commitment: bigint;
  readonly legs: readonly bigint[];
  readonly quantityScale?: bigint;
}

export function impliedBackingAtoms(quantity: bigint, atomsPerScale: bigint, quantityScale = 1n): bigint {
  if ([quantity, atomsPerScale, quantityScale].some(value =>
    typeof value !== "bigint" || value <= 0n || value > U128_MAX)) {
    throw new RangeError("Implied backing quantity, atoms, and scale must be positive u128 values.");
  }
  const atoms = (quantity * atomsPerScale + quantityScale - 1n) / quantityScale;
  if (atoms > U128_MAX) throw new RangeError("Implied backing exceeds u128 atoms.");
  return atoms;
}
