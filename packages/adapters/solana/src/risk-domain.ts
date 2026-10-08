import anchor from '@coral-xyz/anchor';

const { BN } = anchor;
const U32_MAX = (1n << 32n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export interface SolanaRiskDomainSeriesRef {
  readonly seriesId: Uint8Array;
  readonly manifestVersion: number;
  readonly manifestHash: Uint8Array;
}

export interface SolanaCashCarryRiskArgs {
  readonly riskDomainId: Uint8Array;
  readonly riskPolicyVersion: number;
  readonly riskSeriesIndex: number;
  readonly riskNetQuoteAtoms: bigint;
  readonly riskMarginQuoteAtoms: bigint;
  readonly riskRecoveryReserveQuoteAtoms: bigint;
  readonly riskObservationAgeMs: bigint;
  readonly riskTimeToUnwindMs: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hash32(value: Uint8Array, name: string): Uint8Array {
  requireCondition(value instanceof Uint8Array && value.length === 32, `${name} must be 32 bytes`);
  requireCondition(value.some((byte) => byte !== 0), `${name} must be nonzero`);
  return value;
}

function unsigned(value: bigint, maximum: bigint, name: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= 0n && value <= maximum, `${name} is out of range`);
  return value;
}

function bigEndian(value: bigint, byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let remaining = value;
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

export function validateSolanaCashCarryRiskArgs(
  args: SolanaCashCarryRiskArgs & Readonly<{ packageNotionalAtoms: bigint }>,
): void {
  hash32(args.riskDomainId, 'risk domain id');
  requireCondition(
    Number.isInteger(args.riskPolicyVersion)
      && args.riskPolicyVersion > 0
      && BigInt(args.riskPolicyVersion) <= U32_MAX,
    'risk policy version is out of range',
  );
  requireCondition(
    Number.isInteger(args.riskSeriesIndex) && args.riskSeriesIndex >= 0 && args.riskSeriesIndex <= 255,
    'risk series index is out of range',
  );
  unsigned(args.riskNetQuoteAtoms, U128_MAX, 'risk net exposure');
  unsigned(args.riskMarginQuoteAtoms, U128_MAX, 'risk margin');
  unsigned(args.riskRecoveryReserveQuoteAtoms, U128_MAX, 'risk recovery reserve');
  unsigned(args.riskObservationAgeMs, U64_MAX, 'risk observation age');
  unsigned(args.riskTimeToUnwindMs, U64_MAX, 'risk time to unwind');
  unsigned(args.packageNotionalAtoms, U64_MAX, 'package notional');
}

export function borshRiskArgs(args: SolanaCashCarryRiskArgs) {
  return {
    risk_domain_id: Array.from(args.riskDomainId),
    risk_policy_version: args.riskPolicyVersion,
    risk_series_index: args.riskSeriesIndex,
    risk_net_quote_atoms: new BN(args.riskNetQuoteAtoms.toString()),
    risk_margin_quote_atoms: new BN(args.riskMarginQuoteAtoms.toString()),
    risk_recovery_reserve_quote_atoms: new BN(args.riskRecoveryReserveQuoteAtoms.toString()),
    risk_observation_age_ms: new BN(args.riskObservationAgeMs.toString()),
    risk_time_to_unwind_ms: new BN(args.riskTimeToUnwindMs.toString()),
  };
}

export function riskDigestParts(args: SolanaCashCarryRiskArgs): readonly Uint8Array[] {
  return [
    args.riskDomainId,
    bigEndian(BigInt(args.riskPolicyVersion), 4),
    Uint8Array.of(args.riskSeriesIndex),
    bigEndian(args.riskNetQuoteAtoms, 16),
    bigEndian(args.riskMarginQuoteAtoms, 16),
    bigEndian(args.riskRecoveryReserveQuoteAtoms, 16),
    bigEndian(args.riskObservationAgeMs, 8),
    bigEndian(args.riskTimeToUnwindMs, 8),
  ];
}
