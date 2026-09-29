import { absBigInt, checkedSigned, checkedUnsigned, mulDiv, ROUNDING } from './arithmetic.js';
import { compareBytes, toHex } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';

export const NETTING_MAX_OBLIGATIONS = 512;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function requireArray(value: unknown, context: string): void {
  if (!Array.isArray(value)) throw new MalformedInputError(context, 'expected an array');
  if (value.length > NETTING_MAX_OBLIGATIONS) throw new MalformedInputError(context, `more than ${NETTING_MAX_OBLIGATIONS} entries`);
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function signedNonzero(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  const checked = checkedSigned(value, I128_BITS, context);
  if (checked === 0n) throw new MalformedInputError(context, 'quantity is zero');
  return checked;
}

// ------------------------------------------------------------------ package compression

export interface PackageLegQuantity {
  readonly instrumentId: string;
  readonly signedQuantityAtoms: bigint;
}

export interface CompressedPackage {
  readonly original: readonly { readonly instrumentId: ProtocolId; readonly signedQuantityAtoms: bigint }[];
  readonly compressed: readonly { readonly instrumentId: ProtocolId; readonly signedQuantityAtoms: bigint }[];
}

/**
 * Cancels redundant legs on one instrument inside a single package. The original graph is kept
 * beside the compressed one so the receipt can show both, and each instrument's signed total is
 * conserved exactly.
 */
export function compressPackageLegs(legs: readonly PackageLegQuantity[]): CompressedPackage {
  requireArray(legs, 'compressPackageLegs.legs');
  const original = legs.map((leg, index) => {
    object(leg, `compressPackageLegs.legs[${index}]`);
    return Object.freeze({
      instrumentId: protocolId(leg.instrumentId, `compressPackageLegs.legs[${index}].instrumentId`),
      signedQuantityAtoms: signedNonzero(leg.signedQuantityAtoms, `compressPackageLegs.legs[${index}].signedQuantityAtoms`),
    });
  });
  const totals = new Map<ProtocolId, bigint>();
  for (const leg of original) totals.set(leg.instrumentId, (totals.get(leg.instrumentId) ?? 0n) + leg.signedQuantityAtoms);
  const compressed = [...totals.entries()]
    .filter(([, quantity]) => quantity !== 0n)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([instrumentId, quantity]) => Object.freeze({ instrumentId, signedQuantityAtoms: checkedSigned(quantity, I128_BITS, 'compressPackageLegs.total') }));
  return Object.freeze({ original: Object.freeze(original), compressed: Object.freeze(compressed) });
}

// ------------------------------------------------------------------ cross-user netting

export interface NettingObligation {
  readonly obligationId: Uint8Array | string;
  readonly userId: string;
  readonly packageId: string;
  readonly underlyingId: string;
  readonly signedQuantityAtoms: bigint;
  readonly sequence: bigint;
}

export interface NettingAllocation {
  readonly obligationId: CommitmentHash;
  readonly userId: ProtocolId;
  readonly underlyingId: ProtocolId;
  readonly signedQuantityAtoms: bigint;
  readonly internalQuantityAtoms: bigint;
  readonly externalQuantityAtoms: bigint;
}

export interface NettingUnderlyingSummary {
  readonly underlyingId: ProtocolId;
  readonly grossBuyAtoms: bigint;
  readonly grossSellAtoms: bigint;
  readonly internalMatchedAtoms: bigint;
  readonly externalNetAtoms: bigint;
}

export interface NettingResult {
  readonly allocations: readonly NettingAllocation[];
  readonly underlyings: readonly NettingUnderlyingSummary[];
  readonly proofHash: CommitmentHash;
}

type Checked = {
  obligationId: CommitmentHash;
  userId: ProtocolId;
  packageId: ProtocolId;
  underlyingId: ProtocolId;
  signedQuantityAtoms: bigint;
  sequence: bigint;
};

/**
 * Splits `matched` across one side in increments: floor pro-rata first, then any leftover
 * increments one at a time in sequence order. Deterministic and never above an obligation's size.
 */
function allocateSide(side: readonly Checked[], matched: bigint, increment: bigint): Map<string, bigint> {
  const total = side.reduce((sum, item) => sum + absBigInt(item.signedQuantityAtoms), 0n);
  const result = new Map<string, bigint>();
  let assigned = 0n;
  for (const item of side) {
    const size = absBigInt(item.signedQuantityAtoms);
    const share = total === 0n ? 0n : (mulDiv(size, matched, total, ROUNDING.FLOOR) / increment) * increment;
    result.set(toHex(item.obligationId), share);
    assigned += share;
  }
  let leftover = matched - assigned;
  while (leftover > 0n) {
    let progressed = false;
    for (const item of side) {
      if (leftover === 0n) break;
      const key = toHex(item.obligationId);
      const current = result.get(key) as bigint;
      if (current + increment <= absBigInt(item.signedQuantityAtoms)) {
        result.set(key, current + increment);
        leftover -= increment;
        progressed = true;
      }
    }
    if (!progressed) throw new MalformedInputError('netObligations', 'matched quantity cannot be allocated in increments');
  }
  return result;
}

/**
 * Crosses opposite obligations on each underlying and leaves only the net for external venues.
 * Each obligation keeps its own identity, sign, and bound: its internal share never exceeds it,
 * and `gross = internal + external` holds per obligation, per side, and per underlying.
 */
export function netObligations(obligations: readonly NettingObligation[], quantityIncrement: bigint): NettingResult {
  requireArray(obligations, 'netObligations.obligations');
  const increment = unsigned(quantityIncrement, U128_BITS, 'netObligations.quantityIncrement');
  if (increment === 0n) throw new MalformedInputError('netObligations.quantityIncrement', 'increment is zero');
  const checked: Checked[] = obligations.map((obligation, index) => {
    const at = `netObligations.obligations[${index}]`;
    object(obligation, at);
    const signedQuantityAtoms = signedNonzero(obligation.signedQuantityAtoms, `${at}.signedQuantityAtoms`);
    if (signedQuantityAtoms % increment !== 0n) throw new MalformedInputError(`${at}.signedQuantityAtoms`, 'quantity is off the increment lattice');
    return {
      obligationId: commitmentHash(obligation.obligationId, `${at}.obligationId`),
      userId: protocolId(obligation.userId, `${at}.userId`),
      packageId: protocolId(obligation.packageId, `${at}.packageId`),
      underlyingId: protocolId(obligation.underlyingId, `${at}.underlyingId`),
      signedQuantityAtoms,
      sequence: unsigned(obligation.sequence, U64_BITS, `${at}.sequence`),
    };
  });
  checked.sort((left, right) => (left.sequence !== right.sequence ? (left.sequence < right.sequence ? -1 : 1) : compareBytes(left.obligationId, right.obligationId)));
  const ids = new Set(checked.map((item) => toHex(item.obligationId)));
  if (ids.size !== checked.length) throw new DuplicateElementError('netObligations.obligations', 'obligation ids repeat');
  if (new Set(checked.map((item) => item.sequence)).size !== checked.length) {
    throw new DuplicateElementError('netObligations.obligations', 'sequences repeat');
  }

  const underlyings = [...new Set(checked.map((item) => item.underlyingId))].sort();
  const internal = new Map<string, bigint>();
  const summaries = underlyings.map((underlyingId) => {
    const buys = checked.filter((item) => item.underlyingId === underlyingId && item.signedQuantityAtoms > 0n);
    const sells = checked.filter((item) => item.underlyingId === underlyingId && item.signedQuantityAtoms < 0n);
    const grossBuy = buys.reduce((sum, item) => sum + item.signedQuantityAtoms, 0n);
    const grossSell = sells.reduce((sum, item) => sum - item.signedQuantityAtoms, 0n);
    const matched = grossBuy < grossSell ? grossBuy : grossSell;
    for (const [key, value] of allocateSide(buys, matched, increment)) internal.set(key, value);
    for (const [key, value] of allocateSide(sells, matched, increment)) internal.set(key, -value);
    return Object.freeze({
      underlyingId,
      grossBuyAtoms: grossBuy,
      grossSellAtoms: grossSell,
      internalMatchedAtoms: matched,
      externalNetAtoms: grossBuy - grossSell,
    });
  });
  const allocations = checked.map((item) => {
    const inside = internal.get(toHex(item.obligationId)) ?? 0n;
    return Object.freeze({
      obligationId: item.obligationId,
      userId: item.userId,
      underlyingId: item.underlyingId,
      signedQuantityAtoms: item.signedQuantityAtoms,
      internalQuantityAtoms: inside,
      externalQuantityAtoms: item.signedQuantityAtoms - inside,
    });
  });
  verifyNetting(allocations, summaries);
  const payload = canonicalBytes((writer) => {
    writer.writeArray(allocations, (element, allocation) => {
      encodeCommitmentHash(element, allocation.obligationId, 'obligationId');
      encodeProtocolId(element, allocation.userId);
      encodeProtocolId(element, allocation.underlyingId);
      element.writeI128(allocation.signedQuantityAtoms, 'signedQuantityAtoms');
      element.writeI128(allocation.internalQuantityAtoms, 'internalQuantityAtoms');
      element.writeI128(allocation.externalQuantityAtoms, 'externalQuantityAtoms');
    });
    writer.writeArray(summaries, (element, summary) => {
      encodeProtocolId(element, summary.underlyingId);
      element.writeU128(summary.grossBuyAtoms, 'grossBuyAtoms');
      element.writeU128(summary.grossSellAtoms, 'grossSellAtoms');
      element.writeU128(summary.internalMatchedAtoms, 'internalMatchedAtoms');
      element.writeI128(summary.externalNetAtoms, 'externalNetAtoms');
    });
  });
  return Object.freeze({
    allocations: Object.freeze(allocations),
    underlyings: Object.freeze(summaries),
    proofHash: commitmentHash(domainHash(HASH_DOMAIN.NETTING_PROOF, payload), 'nettingProofHash'),
  });
}

/**
 * Recomputes the conservation equations for a netting result; any violation rejects. Every
 * underlying that appears in an allocation needs exactly one summary, and each summary's gross
 * and matched figures are recomputed from the allocations rather than trusted.
 */
export function verifyNetting(allocations: readonly NettingAllocation[], summaries: readonly NettingUnderlyingSummary[]): void {
  for (const allocation of allocations) {
    const { signedQuantityAtoms: gross, internalQuantityAtoms: inside, externalQuantityAtoms: outside } = allocation;
    if (inside + outside !== gross) throw new MalformedInputError('verifyNetting', 'an obligation is not conserved');
    if (inside !== 0n && (inside > 0n) !== (gross > 0n)) throw new MalformedInputError('verifyNetting', 'an internal share flips direction');
    if (absBigInt(inside) > absBigInt(gross)) throw new MalformedInputError('verifyNetting', 'an internal share exceeds its obligation');
  }
  const underlyings = new Set<string>(allocations.map((allocation) => allocation.underlyingId));
  const summarized = new Set<string>();
  for (const summary of summaries) {
    if (summarized.has(summary.underlyingId)) throw new MalformedInputError('verifyNetting', `underlying ${summary.underlyingId} is summarized twice`);
    summarized.add(summary.underlyingId);
    if (!underlyings.has(summary.underlyingId)) throw new MalformedInputError('verifyNetting', `underlying ${summary.underlyingId} has no allocations`);
  }
  for (const underlyingId of underlyings) {
    if (!summarized.has(underlyingId)) throw new MalformedInputError('verifyNetting', `underlying ${underlyingId} has no summary`);
  }
  for (const summary of summaries) {
    const lines = allocations.filter((allocation) => allocation.underlyingId === summary.underlyingId);
    const grossBuy = lines.filter((line) => line.signedQuantityAtoms > 0n).reduce((sum, line) => sum + line.signedQuantityAtoms, 0n);
    const grossSell = lines.filter((line) => line.signedQuantityAtoms < 0n).reduce((sum, line) => sum - line.signedQuantityAtoms, 0n);
    const matched = grossBuy < grossSell ? grossBuy : grossSell;
    if (summary.grossBuyAtoms !== grossBuy || summary.grossSellAtoms !== grossSell || summary.internalMatchedAtoms !== matched) {
      throw new MalformedInputError('verifyNetting', 'gross or matched quantities do not follow from the allocations');
    }
    const buyInside = lines.filter((line) => line.internalQuantityAtoms > 0n).reduce((sum, line) => sum + line.internalQuantityAtoms, 0n);
    const sellInside = lines.filter((line) => line.internalQuantityAtoms < 0n).reduce((sum, line) => sum - line.internalQuantityAtoms, 0n);
    const external = lines.reduce((sum, line) => sum + line.externalQuantityAtoms, 0n);
    if (buyInside !== matched || sellInside !== matched) {
      throw new MalformedInputError('verifyNetting', 'internal crossing is unbalanced');
    }
    if (external !== summary.externalNetAtoms || grossBuy - grossSell !== summary.externalNetAtoms) {
      throw new MalformedInputError('verifyNetting', 'external net does not equal the gross imbalance');
    }
  }
}

// ------------------------------------------------------------------ isolated recovery capital

export interface RecoveryReserveDomain {
  readonly riskDomainId: ProtocolId;
  readonly capitalAtoms: bigint;
  readonly claims: readonly { readonly claimId: CommitmentHash; readonly atoms: bigint }[];
}

export interface RecoveryReserveLedger {
  readonly domains: readonly RecoveryReserveDomain[];
}

export const EMPTY_RECOVERY_RESERVE: RecoveryReserveLedger = Object.freeze({ domains: Object.freeze([]) });

function domainOf(ledger: RecoveryReserveLedger, riskDomainId: string, context: string): { index: number; domain: RecoveryReserveDomain } {
  const id = protocolId(riskDomainId, `${context}.riskDomainId`);
  const index = ledger.domains.findIndex((domain) => domain.riskDomainId === id);
  if (index < 0) throw new MalformedInputError(`${context}.riskDomainId`, 'risk domain has no recovery reserve');
  return { index, domain: ledger.domains[index] as RecoveryReserveDomain };
}

function replaceDomain(ledger: RecoveryReserveLedger, index: number, domain: RecoveryReserveDomain): RecoveryReserveLedger {
  return Object.freeze({ domains: Object.freeze(ledger.domains.map((value, position) => (position === index ? Object.freeze(domain) : value))) });
}

function encumbered(domain: RecoveryReserveDomain): bigint {
  return domain.claims.reduce((sum, claim) => sum + claim.atoms, 0n);
}

export function fundRecoveryReserve(ledger: RecoveryReserveLedger, riskDomainId: string, atoms: bigint): RecoveryReserveLedger {
  const id = protocolId(riskDomainId, 'fundRecoveryReserve.riskDomainId');
  const amount = unsigned(atoms, U128_BITS, 'fundRecoveryReserve.atoms');
  if (amount === 0n) throw new MalformedInputError('fundRecoveryReserve.atoms', 'funding is zero');
  const index = ledger.domains.findIndex((domain) => domain.riskDomainId === id);
  if (index < 0) {
    return Object.freeze({
      domains: Object.freeze([...ledger.domains, Object.freeze({ riskDomainId: id, capitalAtoms: amount, claims: Object.freeze([]) })]),
    });
  }
  const domain = ledger.domains[index] as RecoveryReserveDomain;
  return replaceDomain(ledger, index, { ...domain, capitalAtoms: unsigned(domain.capitalAtoms + amount, U128_BITS, 'fundRecoveryReserve.capital') });
}

/**
 * Encumbers recovery capital inside one risk domain only. A failure in one domain can never draw
 * on another domain's reserve, so an unfunded claim rejects instead of borrowing.
 */
export function reserveRecoveryCapital(
  ledger: RecoveryReserveLedger,
  riskDomainId: string,
  claimId: Uint8Array | string,
  atoms: bigint,
): RecoveryReserveLedger {
  const { index, domain } = domainOf(ledger, riskDomainId, 'reserveRecoveryCapital');
  const id = commitmentHash(claimId, 'reserveRecoveryCapital.claimId');
  const amount = unsigned(atoms, U128_BITS, 'reserveRecoveryCapital.atoms');
  if (amount === 0n) throw new MalformedInputError('reserveRecoveryCapital.atoms', 'claim is zero');
  if (ledger.domains.some((value) => value.claims.some((claim) => compareBytes(claim.claimId, id) === 0))) {
    throw new DuplicateElementError('reserveRecoveryCapital.claimId', 'claim id is already reserved');
  }
  if (encumbered(domain) + amount > domain.capitalAtoms) {
    throw new MalformedInputError('reserveRecoveryCapital.atoms', 'the risk domain reserve is insufficient');
  }
  return replaceDomain(ledger, index, { ...domain, claims: Object.freeze([...domain.claims, Object.freeze({ claimId: id, atoms: amount })]) });
}

/** Releases an unused claim, or consumes it: consumption also removes the capital it used. */
export function settleRecoveryClaim(
  ledger: RecoveryReserveLedger,
  riskDomainId: string,
  claimId: Uint8Array | string,
  consumedAtoms: bigint,
): RecoveryReserveLedger {
  const { index, domain } = domainOf(ledger, riskDomainId, 'settleRecoveryClaim');
  const id = toHex(commitmentHash(claimId, 'settleRecoveryClaim.claimId'));
  const claim = domain.claims.find((value) => toHex(value.claimId) === id);
  if (claim === undefined) throw new MalformedInputError('settleRecoveryClaim.claimId', 'claim is not reserved in this risk domain');
  const consumed = unsigned(consumedAtoms, U128_BITS, 'settleRecoveryClaim.consumedAtoms');
  if (consumed > claim.atoms) throw new MalformedInputError('settleRecoveryClaim.consumedAtoms', 'consumption exceeds the reserved claim');
  return replaceDomain(ledger, index, {
    ...domain,
    capitalAtoms: domain.capitalAtoms - consumed,
    claims: Object.freeze(domain.claims.filter((value) => value !== claim)),
  });
}

export function recoveryReserveAvailable(ledger: RecoveryReserveLedger, riskDomainId: string): bigint {
  const { domain } = domainOf(ledger, riskDomainId, 'recoveryReserveAvailable');
  return domain.capitalAtoms - encumbered(domain);
}
