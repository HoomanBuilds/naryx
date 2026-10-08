import { absBigInt, checkedSigned, checkedUnsigned, mulDiv, ROUNDING } from './arithmetic.js';
import { compareBytes, toHex } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';

export const NETTING_MAX_OBLIGATIONS = 512;
export const NETTING_RESULT_VERSION = 2;
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

export interface NettingQuantityIncrement {
  readonly underlyingId: string;
  readonly quantityIncrementAtoms: bigint;
}

export interface NettingAllocation {
  readonly obligationId: CommitmentHash;
  readonly userId: ProtocolId;
  readonly packageId: ProtocolId;
  readonly underlyingId: ProtocolId;
  readonly signedQuantityAtoms: bigint;
  readonly internalQuantityAtoms: bigint;
  readonly externalQuantityAtoms: bigint;
  readonly sequence: bigint;
}

export interface NettingUnderlyingSummary {
  readonly underlyingId: ProtocolId;
  readonly grossBuyAtoms: bigint;
  readonly grossSellAtoms: bigint;
  readonly internalMatchedAtoms: bigint;
  readonly externalNetAtoms: bigint;
  readonly quantityIncrementAtoms: bigint;
}

export interface NettingResult {
  readonly version: 2;
  readonly allocations: readonly NettingAllocation[];
  readonly underlyings: readonly NettingUnderlyingSummary[];
  readonly proofHash: CommitmentHash;
}

export type NettingResultInput = Omit<NettingResult, 'proofHash'>;

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
export function netObligations(
  obligations: readonly NettingObligation[],
  quantityIncrements: readonly NettingQuantityIncrement[],
): NettingResult {
  requireArray(obligations, 'netObligations.obligations');
  if (obligations.length === 0) throw new MalformedInputError('netObligations.obligations', 'netting batch is empty');
  requireArray(quantityIncrements, 'netObligations.quantityIncrements');
  const increments = quantityIncrements.map((entry, index) => {
    const at = `netObligations.quantityIncrements[${index}]`;
    object(entry, at);
    const increment = unsigned(entry.quantityIncrementAtoms, U128_BITS, `${at}.quantityIncrementAtoms`);
    if (increment === 0n) throw new MalformedInputError(`${at}.quantityIncrementAtoms`, 'increment is zero');
    return Object.freeze({
      underlyingId: protocolId(entry.underlyingId, `${at}.underlyingId`),
      quantityIncrementAtoms: increment,
    });
  }).sort((left, right) => left.underlyingId < right.underlyingId ? -1 : left.underlyingId > right.underlyingId ? 1 : 0);
  if (new Set(increments.map((entry) => entry.underlyingId)).size !== increments.length) {
    throw new DuplicateElementError('netObligations.quantityIncrements', 'underlying ids repeat');
  }
  const incrementByUnderlying = new Map(increments.map((entry) => [entry.underlyingId, entry.quantityIncrementAtoms]));
  const checked: Checked[] = obligations.map((obligation, index) => {
    const at = `netObligations.obligations[${index}]`;
    object(obligation, at);
    const signedQuantityAtoms = signedNonzero(obligation.signedQuantityAtoms, `${at}.signedQuantityAtoms`);
    const underlyingId = protocolId(obligation.underlyingId, `${at}.underlyingId`);
    const increment = incrementByUnderlying.get(underlyingId);
    if (increment === undefined) throw new MalformedInputError(`${at}.underlyingId`, 'underlying has no quantity increment');
    if (signedQuantityAtoms % increment !== 0n) throw new MalformedInputError(`${at}.signedQuantityAtoms`, 'quantity is off the increment lattice');
    return {
      obligationId: commitmentHash(obligation.obligationId, `${at}.obligationId`),
      userId: protocolId(obligation.userId, `${at}.userId`),
      packageId: protocolId(obligation.packageId, `${at}.packageId`),
      underlyingId,
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
  if (underlyings.length !== increments.length || underlyings.some((underlyingId, index) => underlyingId !== increments[index]?.underlyingId)) {
    throw new MalformedInputError('netObligations.quantityIncrements', 'increments must name every netted underlying exactly once');
  }
  const internal = new Map<string, bigint>();
  const summaries = underlyings.map((underlyingId) => {
    const increment = incrementByUnderlying.get(underlyingId) as bigint;
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
      quantityIncrementAtoms: increment,
    });
  });
  const allocations = checked.map((item) => {
    const inside = internal.get(toHex(item.obligationId)) ?? 0n;
    return Object.freeze({
      obligationId: item.obligationId,
      userId: item.userId,
      packageId: item.packageId,
      underlyingId: item.underlyingId,
      signedQuantityAtoms: item.signedQuantityAtoms,
      internalQuantityAtoms: inside,
      externalQuantityAtoms: item.signedQuantityAtoms - inside,
      sequence: item.sequence,
    });
  });
  const result = Object.freeze({
    version: NETTING_RESULT_VERSION,
    allocations: Object.freeze(allocations),
    underlyings: Object.freeze(summaries),
  });
  verifyNetting(result.allocations, result.underlyings);
  return Object.freeze({ ...result, proofHash: nettingResultHash(result) });
}

export function nettingResultHash(input: NettingResultInput): CommitmentHash {
  if (input.version !== NETTING_RESULT_VERSION) {
    throw new MalformedInputError('nettingResult.version', `version must equal ${NETTING_RESULT_VERSION}`);
  }
  verifyNetting(input.allocations, input.underlyings);
  const payload = canonicalBytes((writer) => {
    writer.writeU32(NETTING_RESULT_VERSION, 'version');
    writer.writeArray(input.allocations, (element, allocation) => {
      encodeCommitmentHash(element, allocation.obligationId, 'obligationId');
      encodeProtocolId(element, allocation.userId);
      encodeProtocolId(element, allocation.packageId);
      encodeProtocolId(element, allocation.underlyingId);
      element.writeI128(allocation.signedQuantityAtoms, 'signedQuantityAtoms');
      element.writeI128(allocation.internalQuantityAtoms, 'internalQuantityAtoms');
      element.writeI128(allocation.externalQuantityAtoms, 'externalQuantityAtoms');
      element.writeU64(allocation.sequence, 'sequence');
    });
    writer.writeArray(input.underlyings, (element, summary) => {
      encodeProtocolId(element, summary.underlyingId);
      element.writeU128(summary.grossBuyAtoms, 'grossBuyAtoms');
      element.writeU128(summary.grossSellAtoms, 'grossSellAtoms');
      element.writeU128(summary.internalMatchedAtoms, 'internalMatchedAtoms');
      element.writeI128(summary.externalNetAtoms, 'externalNetAtoms');
      element.writeU128(summary.quantityIncrementAtoms, 'quantityIncrementAtoms');
    });
  });
  return commitmentHash(domainHash(HASH_DOMAIN.NETTING_PROOF, payload), 'nettingProofHash');
}

export function verifyNettingResult(input: NettingResult): void {
  const expected = nettingResultHash(input);
  if (compareBytes(expected, commitmentHash(input.proofHash, 'nettingResult.proofHash')) !== 0) {
    throw new MalformedInputError('nettingResult.proofHash', 'proof hash does not match the netting result');
  }
}

/**
 * Recomputes the conservation equations for a netting result; any violation rejects. Every
 * underlying that appears in an allocation needs exactly one summary, and each summary's gross
 * and matched figures are recomputed from the allocations rather than trusted.
 */
export function verifyNetting(allocations: readonly NettingAllocation[], summaries: readonly NettingUnderlyingSummary[]): void {
  requireArray(allocations, 'verifyNetting.allocations');
  requireArray(summaries, 'verifyNetting.underlyings');
  if (allocations.length === 0) throw new MalformedInputError('verifyNetting.allocations', 'netting batch is empty');
  const checkedAllocations = allocations.map((allocation, index): NettingAllocation => {
    const at = `verifyNetting.allocations[${index}]`;
    object(allocation, at);
    return Object.freeze({
      obligationId: commitmentHash(allocation.obligationId, `${at}.obligationId`),
      userId: protocolId(allocation.userId, `${at}.userId`),
      packageId: protocolId(allocation.packageId, `${at}.packageId`),
      underlyingId: protocolId(allocation.underlyingId, `${at}.underlyingId`),
      signedQuantityAtoms: signedNonzero(allocation.signedQuantityAtoms, `${at}.signedQuantityAtoms`),
      internalQuantityAtoms: checkedSigned(allocation.internalQuantityAtoms, I128_BITS, `${at}.internalQuantityAtoms`),
      externalQuantityAtoms: checkedSigned(allocation.externalQuantityAtoms, I128_BITS, `${at}.externalQuantityAtoms`),
      sequence: unsigned(allocation.sequence, U64_BITS, `${at}.sequence`),
    });
  });
  const sortedAllocations = [...checkedAllocations].sort((left, right) => left.sequence !== right.sequence
    ? left.sequence < right.sequence ? -1 : 1
    : compareBytes(left.obligationId, right.obligationId));
  if (checkedAllocations.some((allocation, index) => allocation.sequence !== sortedAllocations[index]?.sequence
    || compareBytes(allocation.obligationId, sortedAllocations[index]!.obligationId) !== 0)) {
    throw new MalformedInputError('verifyNetting.allocations', 'allocations are not in canonical sequence order');
  }
  if (new Set(checkedAllocations.map((allocation) => toHex(allocation.obligationId))).size !== checkedAllocations.length) {
    throw new DuplicateElementError('verifyNetting.allocations', 'obligation ids repeat');
  }
  if (new Set(checkedAllocations.map((allocation) => allocation.sequence)).size !== checkedAllocations.length) {
    throw new DuplicateElementError('verifyNetting.allocations', 'sequences repeat');
  }
  const checkedSummaries = summaries.map((summary, index): NettingUnderlyingSummary => {
    const at = `verifyNetting.underlyings[${index}]`;
    object(summary, at);
    const quantityIncrementAtoms = unsigned(summary.quantityIncrementAtoms, U128_BITS, `${at}.quantityIncrementAtoms`);
    if (quantityIncrementAtoms === 0n) throw new MalformedInputError(`${at}.quantityIncrementAtoms`, 'increment is zero');
    return Object.freeze({
      underlyingId: protocolId(summary.underlyingId, `${at}.underlyingId`),
      grossBuyAtoms: unsigned(summary.grossBuyAtoms, U128_BITS, `${at}.grossBuyAtoms`),
      grossSellAtoms: unsigned(summary.grossSellAtoms, U128_BITS, `${at}.grossSellAtoms`),
      internalMatchedAtoms: unsigned(summary.internalMatchedAtoms, U128_BITS, `${at}.internalMatchedAtoms`),
      externalNetAtoms: checkedSigned(summary.externalNetAtoms, I128_BITS, `${at}.externalNetAtoms`),
      quantityIncrementAtoms,
    });
  });
  if (checkedSummaries.some((summary, index) => index > 0
    && checkedSummaries[index - 1]!.underlyingId >= summary.underlyingId)) {
    throw new MalformedInputError('verifyNetting.underlyings', 'underlying summaries are not canonically ordered');
  }
  for (const allocation of checkedAllocations) {
    const { signedQuantityAtoms: gross, internalQuantityAtoms: inside, externalQuantityAtoms: outside } = allocation;
    if (inside + outside !== gross) throw new MalformedInputError('verifyNetting', 'an obligation is not conserved');
    if (inside !== 0n && (inside > 0n) !== (gross > 0n)) throw new MalformedInputError('verifyNetting', 'an internal share flips direction');
    if (absBigInt(inside) > absBigInt(gross)) throw new MalformedInputError('verifyNetting', 'an internal share exceeds its obligation');
  }
  const underlyings = new Set<string>(checkedAllocations.map((allocation) => allocation.underlyingId));
  const summarized = new Set<string>();
  for (const summary of checkedSummaries) {
    if (summarized.has(summary.underlyingId)) throw new MalformedInputError('verifyNetting', `underlying ${summary.underlyingId} is summarized twice`);
    summarized.add(summary.underlyingId);
    if (!underlyings.has(summary.underlyingId)) throw new MalformedInputError('verifyNetting', `underlying ${summary.underlyingId} has no allocations`);
  }
  for (const underlyingId of underlyings) {
    if (!summarized.has(underlyingId)) throw new MalformedInputError('verifyNetting', `underlying ${underlyingId} has no summary`);
  }
  for (const summary of checkedSummaries) {
    const lines = checkedAllocations.filter((allocation) => allocation.underlyingId === summary.underlyingId);
    if (lines.some((line) => line.signedQuantityAtoms % summary.quantityIncrementAtoms !== 0n
      || line.internalQuantityAtoms % summary.quantityIncrementAtoms !== 0n
      || line.externalQuantityAtoms % summary.quantityIncrementAtoms !== 0n)) {
      throw new MalformedInputError('verifyNetting', 'an allocation is off the underlying increment lattice');
    }
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
    const buys = lines.filter((line) => line.signedQuantityAtoms > 0n) as readonly Checked[];
    const sells = lines.filter((line) => line.signedQuantityAtoms < 0n) as readonly Checked[];
    const expected = new Map<string, bigint>([
      ...allocateSide(buys, matched, summary.quantityIncrementAtoms),
      ...[...allocateSide(sells, matched, summary.quantityIncrementAtoms)].map(([key, value]) => [key, -value] as const),
    ]);
    if (lines.some((line) => line.internalQuantityAtoms !== (expected.get(toHex(line.obligationId)) ?? 0n))) {
      throw new MalformedInputError('verifyNetting', 'internal crossing does not follow deterministic pro-rata allocation');
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
