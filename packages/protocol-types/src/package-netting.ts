import { absBigInt, checkedSigned, checkedUnsigned, mulDiv, ROUNDING } from './arithmetic.js';
import { compareBytes, toHex } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  NETTING_POLICY_MAX_OBLIGATIONS,
  nettingPolicyManifest,
  nettingPolicyManifestHash,
  type NettingInstrumentPolicy,
  type NettingPolicyManifest,
  type NettingPolicyManifestInput,
} from './netting-policy-manifest.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';

export const NETTING_MAX_OBLIGATIONS = NETTING_POLICY_MAX_OBLIGATIONS;
export const NETTING_RESULT_VERSION = 4;
const U64_BITS = 64;
const U128_BITS = 128;
const U256_BITS = 256;
const I128_BITS = 128;
const I256_BITS = 256;

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

export interface NettingObligationInput {
  readonly ownerId: string;
  readonly strategyOrderHash: Uint8Array | string;
  readonly packageOrderId: Uint8Array | string;
  readonly settlementReadinessHash: Uint8Array | string;
  readonly legId: string;
  readonly instrumentId: string;
  readonly signedQuantityAtoms: bigint;
  readonly limitPriceTicks: bigint;
  readonly sequence: bigint;
}

export interface NettingObligation {
  readonly obligationId: CommitmentHash;
  readonly nettingPolicyHash: CommitmentHash;
  readonly ownerId: ProtocolId;
  readonly strategyOrderHash: CommitmentHash;
  readonly packageOrderId: CommitmentHash;
  readonly settlementReadinessHash: CommitmentHash;
  readonly legId: ProtocolId;
  readonly instrumentId: ProtocolId;
  readonly instrumentHash: CommitmentHash;
  readonly signedQuantityAtoms: bigint;
  readonly limitPriceTicks: bigint;
  readonly sequence: bigint;
}

export interface NettingAllocation {
  readonly obligationId: CommitmentHash;
  readonly nettingPolicyHash: CommitmentHash;
  readonly ownerId: ProtocolId;
  readonly strategyOrderHash: CommitmentHash;
  readonly packageOrderId: CommitmentHash;
  readonly settlementReadinessHash: CommitmentHash;
  readonly legId: ProtocolId;
  readonly instrumentId: ProtocolId;
  readonly instrumentHash: CommitmentHash;
  readonly signedQuantityAtoms: bigint;
  readonly limitPriceTicks: bigint;
  readonly internalQuantityAtoms: bigint;
  readonly internalQuoteDeltaAtoms: bigint;
  readonly externalQuantityAtoms: bigint;
  readonly sequence: bigint;
}

export interface NettingUnderlyingSummary {
  readonly instrumentId: ProtocolId;
  readonly instrumentHash: CommitmentHash;
  readonly grossBuyAtoms: bigint;
  readonly grossSellAtoms: bigint;
  readonly internalMatchedAtoms: bigint;
  readonly externalNetAtoms: bigint;
  readonly quantityIncrementAtoms: bigint;
  readonly priceTickQuoteAtoms: bigint;
  readonly internalClearingPriceTicks?: bigint;
  readonly externalLimitPriceTicks?: bigint;
  readonly internalQuoteAtoms: bigint;
}

export interface NettingResult {
  readonly version: 4;
  readonly nettingPolicyHash: CommitmentHash;
  readonly allocations: readonly NettingAllocation[];
  readonly underlyings: readonly NettingUnderlyingSummary[];
  readonly proofHash: CommitmentHash;
}

export type NettingResultInput = Omit<NettingResult, 'proofHash'>;

type Checked = {
  obligationId: CommitmentHash;
  nettingPolicyHash: CommitmentHash;
  ownerId: ProtocolId;
  strategyOrderHash: CommitmentHash;
  packageOrderId: CommitmentHash;
  settlementReadinessHash: CommitmentHash;
  legId: ProtocolId;
  instrumentId: ProtocolId;
  instrumentHash: CommitmentHash;
  signedQuantityAtoms: bigint;
  limitPriceTicks: bigint;
  sequence: bigint;
};

function nettingObligationPayload(
  obligation: Omit<NettingObligation, 'obligationId'>,
): Uint8Array {
  return canonicalBytes((writer) => {
    encodeCommitmentHash(writer, obligation.nettingPolicyHash, 'nettingPolicyHash');
    encodeProtocolId(writer, obligation.ownerId, 'ownerId');
    encodeCommitmentHash(writer, obligation.strategyOrderHash, 'strategyOrderHash');
    encodeCommitmentHash(writer, obligation.packageOrderId, 'packageOrderId');
    encodeCommitmentHash(writer, obligation.settlementReadinessHash, 'settlementReadinessHash');
    encodeProtocolId(writer, obligation.legId, 'legId');
    encodeProtocolId(writer, obligation.instrumentId, 'instrumentId');
    encodeCommitmentHash(writer, obligation.instrumentHash, 'instrumentHash');
    writer.writeI128(obligation.signedQuantityAtoms, 'signedQuantityAtoms');
    writer.writeU128(obligation.limitPriceTicks, 'limitPriceTicks');
    writer.writeU64(obligation.sequence, 'sequence');
  });
}

function obligationHash(obligation: Omit<NettingObligation, 'obligationId'>): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.NETTING_OBLIGATION, nettingObligationPayload(obligation)),
    'nettingObligationHash',
  );
}

export function nettingObligation(
  input: NettingObligationInput,
  policyInput: NettingPolicyManifestInput | NettingPolicyManifest,
  context = 'nettingObligation',
): NettingObligation {
  object(input, context);
  const policy = nettingPolicyManifest(policyInput, `${context}.policy`);
  const instrumentId = protocolId(input.instrumentId, `${context}.instrumentId`);
  const instrument = policy.instruments.find((candidate) => candidate.instrumentId === instrumentId);
  if (instrument === undefined) {
    throw new MalformedInputError(`${context}.instrumentId`, 'instrument is not permitted by the netting policy');
  }
  const signedQuantityAtoms = signedNonzero(input.signedQuantityAtoms, `${context}.signedQuantityAtoms`);
  if (signedQuantityAtoms % instrument.quantityIncrementAtoms !== 0n) {
    throw new MalformedInputError(`${context}.signedQuantityAtoms`, 'quantity is off the instrument increment lattice');
  }
  const limitPriceTicks = unsigned(input.limitPriceTicks, U128_BITS, `${context}.limitPriceTicks`);
  if (limitPriceTicks === 0n) throw new MalformedInputError(`${context}.limitPriceTicks`, 'price is zero');
  const checked = Object.freeze({
    nettingPolicyHash: commitmentHash(nettingPolicyManifestHash(policy), `${context}.nettingPolicyHash`),
    ownerId: protocolId(input.ownerId, `${context}.ownerId`),
    strategyOrderHash: commitmentHash(input.strategyOrderHash, `${context}.strategyOrderHash`),
    packageOrderId: commitmentHash(input.packageOrderId, `${context}.packageOrderId`),
    settlementReadinessHash: commitmentHash(input.settlementReadinessHash, `${context}.settlementReadinessHash`),
    legId: protocolId(input.legId, `${context}.legId`),
    instrumentId,
    instrumentHash: instrument.instrumentHash,
    signedQuantityAtoms,
    limitPriceTicks,
    sequence: unsigned(input.sequence, U64_BITS, `${context}.sequence`),
  });
  return Object.freeze({ obligationId: obligationHash(checked), ...checked });
}

function minimum(values: readonly bigint[], context: string): bigint {
  if (values.length === 0) throw new MalformedInputError(context, 'expected a nonempty value set');
  return values.reduce((lowest, value) => value < lowest ? value : lowest);
}

function maximum(values: readonly bigint[], context: string): bigint {
  if (values.length === 0) throw new MalformedInputError(context, 'expected a nonempty value set');
  return values.reduce((highest, value) => value > highest ? value : highest);
}

function quoteAtomsForQuantity(
  quantityAtoms: bigint,
  quantityIncrementAtoms: bigint,
  priceTicks: bigint,
  priceTickQuoteAtoms: bigint,
  context: string,
): bigint {
  const magnitude = absBigInt(quantityAtoms);
  if (magnitude % quantityIncrementAtoms !== 0n) {
    throw new MalformedInputError(context, 'quantity is off the instrument increment lattice');
  }
  return checkedSigned(
    (magnitude / quantityIncrementAtoms) * priceTicks * priceTickQuoteAtoms,
    I256_BITS,
    context,
  );
}

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
  obligations: readonly NettingObligationInput[],
  policyInput: NettingPolicyManifestInput | NettingPolicyManifest,
): NettingResult {
  requireArray(obligations, 'netObligations.obligations');
  if (obligations.length === 0) throw new MalformedInputError('netObligations.obligations', 'netting batch is empty');
  const policy = nettingPolicyManifest(policyInput, 'netObligations.policy');
  if (obligations.length > policy.maximumObligations) {
    throw new MalformedInputError('netObligations.obligations', 'batch exceeds the netting policy maximum');
  }
  const policyHash = commitmentHash(nettingPolicyManifestHash(policy), 'netObligations.nettingPolicyHash');
  const instrumentById = new Map(policy.instruments.map((instrument) => [instrument.instrumentId, instrument]));
  const checked: Checked[] = obligations.map((obligation, index) =>
    nettingObligation(obligation, policy, `netObligations.obligations[${index}]`),
  );
  checked.sort((left, right) => (left.sequence !== right.sequence ? (left.sequence < right.sequence ? -1 : 1) : compareBytes(left.obligationId, right.obligationId)));
  const ids = new Set(checked.map((item) => toHex(item.obligationId)));
  if (ids.size !== checked.length) throw new DuplicateElementError('netObligations.obligations', 'obligation ids repeat');
  if (new Set(checked.map((item) => item.sequence)).size !== checked.length) {
    throw new DuplicateElementError('netObligations.obligations', 'sequences repeat');
  }

  const underlyings = [...new Set(checked.map((item) => item.instrumentId))].sort();
  const internal = new Map<string, bigint>();
  const summaries = underlyings.map((instrumentId) => {
    const instrument = instrumentById.get(instrumentId) as NettingInstrumentPolicy;
    const increment = instrument.quantityIncrementAtoms;
    const buys = checked.filter((item) => item.instrumentId === instrumentId && item.signedQuantityAtoms > 0n);
    const sells = checked.filter((item) => item.instrumentId === instrumentId && item.signedQuantityAtoms < 0n);
    const grossBuy = buys.reduce((sum, item) => sum + item.signedQuantityAtoms, 0n);
    const grossSell = sells.reduce((sum, item) => sum - item.signedQuantityAtoms, 0n);
    const matched = grossBuy < grossSell ? grossBuy : grossSell;
    let internalClearingPriceTicks: bigint | undefined;
    if (matched > 0n) {
      const maximumSellLimit = maximum(sells.map((item) => item.limitPriceTicks), 'netObligations.sellLimits');
      const minimumBuyLimit = minimum(buys.map((item) => item.limitPriceTicks), 'netObligations.buyLimits');
      if (maximumSellLimit > minimumBuyLimit) {
        throw new MalformedInputError('netObligations.limitPriceTicks', 'buy and sell limits do not overlap');
      }
      internalClearingPriceTicks = (maximumSellLimit + minimumBuyLimit) / 2n;
    }
    for (const [key, value] of allocateSide(buys, matched, increment)) internal.set(key, value);
    for (const [key, value] of allocateSide(sells, matched, increment)) internal.set(key, -value);
    const externalNetAtoms = grossBuy - grossSell;
    const externallyRouted = [...buys, ...sells].filter((item) => (
      item.signedQuantityAtoms - (internal.get(toHex(item.obligationId)) ?? 0n)
    ) !== 0n);
    const externalLimitPriceTicks = externalNetAtoms > 0n
      ? minimum(externallyRouted.map((item) => item.limitPriceTicks), 'netObligations.externalBuyLimits')
      : externalNetAtoms < 0n
        ? maximum(externallyRouted.map((item) => item.limitPriceTicks), 'netObligations.externalSellLimits')
        : undefined;
    const internalQuoteAtoms = internalClearingPriceTicks === undefined
      ? 0n
      : quoteAtomsForQuantity(
        matched,
        increment,
        internalClearingPriceTicks,
        instrument.priceTickQuoteAtoms,
        'netObligations.internalQuoteAtoms',
      );
    return Object.freeze({
      instrumentId,
      instrumentHash: instrument.instrumentHash,
      grossBuyAtoms: grossBuy,
      grossSellAtoms: grossSell,
      internalMatchedAtoms: matched,
      externalNetAtoms,
      quantityIncrementAtoms: increment,
      priceTickQuoteAtoms: instrument.priceTickQuoteAtoms,
      ...(internalClearingPriceTicks === undefined ? {} : { internalClearingPriceTicks }),
      ...(externalLimitPriceTicks === undefined ? {} : { externalLimitPriceTicks }),
      internalQuoteAtoms,
    });
  });
  const summaryByInstrument = new Map(summaries.map((summary) => [summary.instrumentId, summary]));
  const allocations = checked.map((item) => {
    const inside = internal.get(toHex(item.obligationId)) ?? 0n;
    const summary = summaryByInstrument.get(item.instrumentId) as NettingUnderlyingSummary;
    const quoteMagnitude = inside === 0n
      ? 0n
      : quoteAtomsForQuantity(
        inside,
        summary.quantityIncrementAtoms,
        summary.internalClearingPriceTicks as bigint,
        summary.priceTickQuoteAtoms,
        'netObligations.internalQuoteDeltaAtoms',
      );
    return Object.freeze({
      obligationId: item.obligationId,
      nettingPolicyHash: item.nettingPolicyHash,
      ownerId: item.ownerId,
      strategyOrderHash: item.strategyOrderHash,
      packageOrderId: item.packageOrderId,
      settlementReadinessHash: item.settlementReadinessHash,
      legId: item.legId,
      instrumentId: item.instrumentId,
      instrumentHash: item.instrumentHash,
      signedQuantityAtoms: item.signedQuantityAtoms,
      limitPriceTicks: item.limitPriceTicks,
      internalQuantityAtoms: inside,
      internalQuoteDeltaAtoms: inside > 0n ? -quoteMagnitude : quoteMagnitude,
      externalQuantityAtoms: item.signedQuantityAtoms - inside,
      sequence: item.sequence,
    });
  });
  const result = Object.freeze({
    version: NETTING_RESULT_VERSION,
    nettingPolicyHash: policyHash,
    allocations: Object.freeze(allocations),
    underlyings: Object.freeze(summaries),
  });
  verifyNetting(result.nettingPolicyHash, result.allocations, result.underlyings);
  return Object.freeze({ ...result, proofHash: nettingResultHash(result) });
}

export function nettingResultHash(input: NettingResultInput): CommitmentHash {
  if (input.version !== NETTING_RESULT_VERSION) {
    throw new MalformedInputError('nettingResult.version', `version must equal ${NETTING_RESULT_VERSION}`);
  }
  const policyHash = commitmentHash(input.nettingPolicyHash, 'nettingResult.nettingPolicyHash');
  verifyNetting(policyHash, input.allocations, input.underlyings);
  const payload = canonicalBytes((writer) => {
    writer.writeU32(NETTING_RESULT_VERSION, 'version');
    encodeCommitmentHash(writer, policyHash, 'nettingPolicyHash');
    writer.writeArray(input.allocations, (element, allocation) => {
      encodeCommitmentHash(element, allocation.obligationId, 'obligationId');
      encodeCommitmentHash(element, allocation.nettingPolicyHash, 'allocation.nettingPolicyHash');
      encodeProtocolId(element, allocation.ownerId);
      encodeCommitmentHash(element, allocation.strategyOrderHash, 'strategyOrderHash');
      encodeCommitmentHash(element, allocation.packageOrderId, 'packageOrderId');
      encodeCommitmentHash(element, allocation.settlementReadinessHash, 'settlementReadinessHash');
      encodeProtocolId(element, allocation.legId);
      encodeProtocolId(element, allocation.instrumentId);
      encodeCommitmentHash(element, allocation.instrumentHash, 'instrumentHash');
      element.writeI128(allocation.signedQuantityAtoms, 'signedQuantityAtoms');
      element.writeU128(allocation.limitPriceTicks, 'limitPriceTicks');
      element.writeI128(allocation.internalQuantityAtoms, 'internalQuantityAtoms');
      element.writeI256(allocation.internalQuoteDeltaAtoms, 'internalQuoteDeltaAtoms');
      element.writeI128(allocation.externalQuantityAtoms, 'externalQuantityAtoms');
      element.writeU64(allocation.sequence, 'sequence');
    });
    writer.writeArray(input.underlyings, (element, summary) => {
      encodeProtocolId(element, summary.instrumentId);
      encodeCommitmentHash(element, summary.instrumentHash, 'instrumentHash');
      element.writeU128(summary.grossBuyAtoms, 'grossBuyAtoms');
      element.writeU128(summary.grossSellAtoms, 'grossSellAtoms');
      element.writeU128(summary.internalMatchedAtoms, 'internalMatchedAtoms');
      element.writeI128(summary.externalNetAtoms, 'externalNetAtoms');
      element.writeU128(summary.quantityIncrementAtoms, 'quantityIncrementAtoms');
      element.writeU128(summary.priceTickQuoteAtoms, 'priceTickQuoteAtoms');
      element.writeOptional(summary.internalClearingPriceTicks, (inner, value) => inner.writeU128(value, 'internalClearingPriceTicks'), 'internalClearingPriceTicks');
      element.writeOptional(summary.externalLimitPriceTicks, (inner, value) => inner.writeU128(value, 'externalLimitPriceTicks'), 'externalLimitPriceTicks');
      element.writeU256(summary.internalQuoteAtoms, 'internalQuoteAtoms');
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

export function verifyNettingResultAgainstPolicy(
  input: NettingResult,
  policyInput: NettingPolicyManifestInput | NettingPolicyManifest,
): void {
  verifyNettingResult(input);
  const policy = nettingPolicyManifest(policyInput, 'verifyNettingResultAgainstPolicy.policy');
  const policyHash = commitmentHash(nettingPolicyManifestHash(policy), 'verifyNettingResultAgainstPolicy.nettingPolicyHash');
  if (compareBytes(input.nettingPolicyHash, policyHash) !== 0) {
    throw new MalformedInputError('nettingResult.nettingPolicyHash', 'result cites another netting policy');
  }
  if (input.allocations.length > policy.maximumObligations) {
    throw new MalformedInputError('nettingResult.allocations', 'batch exceeds the netting policy maximum');
  }
  const instrumentById = new Map(policy.instruments.map((instrument) => [instrument.instrumentId, instrument]));
  for (const summary of input.underlyings) {
    const instrument = instrumentById.get(summary.instrumentId);
    if (instrument === undefined || compareBytes(instrument.instrumentHash, summary.instrumentHash) !== 0) {
      throw new MalformedInputError('nettingResult.underlyings', 'result contains an instrument outside the netting policy');
    }
    if (instrument.quantityIncrementAtoms !== summary.quantityIncrementAtoms) {
      throw new MalformedInputError('nettingResult.underlyings', 'result uses another instrument quantity increment');
    }
    if (instrument.priceTickQuoteAtoms !== summary.priceTickQuoteAtoms) {
      throw new MalformedInputError('nettingResult.underlyings', 'result uses another instrument price tick');
    }
  }
}

/**
 * Recomputes the conservation equations for a netting result; any violation rejects. Every
 * underlying that appears in an allocation needs exactly one summary, and each summary's gross
 * and matched figures are recomputed from the allocations rather than trusted.
 */
export function verifyNetting(
  nettingPolicyHashInput: Uint8Array | string,
  allocations: readonly NettingAllocation[],
  summaries: readonly NettingUnderlyingSummary[],
): void {
  const nettingPolicyHash = commitmentHash(nettingPolicyHashInput, 'verifyNetting.nettingPolicyHash');
  requireArray(allocations, 'verifyNetting.allocations');
  requireArray(summaries, 'verifyNetting.underlyings');
  if (allocations.length === 0) throw new MalformedInputError('verifyNetting.allocations', 'netting batch is empty');
  const checkedAllocations = allocations.map((allocation, index): NettingAllocation => {
    const at = `verifyNetting.allocations[${index}]`;
    object(allocation, at);
    const checked = Object.freeze({
      nettingPolicyHash: commitmentHash(allocation.nettingPolicyHash, `${at}.nettingPolicyHash`),
      obligationId: commitmentHash(allocation.obligationId, `${at}.obligationId`),
      ownerId: protocolId(allocation.ownerId, `${at}.ownerId`),
      strategyOrderHash: commitmentHash(allocation.strategyOrderHash, `${at}.strategyOrderHash`),
      packageOrderId: commitmentHash(allocation.packageOrderId, `${at}.packageOrderId`),
      settlementReadinessHash: commitmentHash(allocation.settlementReadinessHash, `${at}.settlementReadinessHash`),
      legId: protocolId(allocation.legId, `${at}.legId`),
      instrumentId: protocolId(allocation.instrumentId, `${at}.instrumentId`),
      instrumentHash: commitmentHash(allocation.instrumentHash, `${at}.instrumentHash`),
      signedQuantityAtoms: signedNonzero(allocation.signedQuantityAtoms, `${at}.signedQuantityAtoms`),
      limitPriceTicks: unsigned(allocation.limitPriceTicks, U128_BITS, `${at}.limitPriceTicks`),
      internalQuantityAtoms: checkedSigned(allocation.internalQuantityAtoms, I128_BITS, `${at}.internalQuantityAtoms`),
      internalQuoteDeltaAtoms: checkedSigned(allocation.internalQuoteDeltaAtoms, I256_BITS, `${at}.internalQuoteDeltaAtoms`),
      externalQuantityAtoms: checkedSigned(allocation.externalQuantityAtoms, I128_BITS, `${at}.externalQuantityAtoms`),
      sequence: unsigned(allocation.sequence, U64_BITS, `${at}.sequence`),
    });
    if (checked.limitPriceTicks === 0n) throw new MalformedInputError(`${at}.limitPriceTicks`, 'price is zero');
    if (compareBytes(checked.nettingPolicyHash, nettingPolicyHash) !== 0) {
      throw new MalformedInputError(`${at}.nettingPolicyHash`, 'allocation cites another netting policy');
    }
    const identity = {
      nettingPolicyHash: checked.nettingPolicyHash,
      ownerId: checked.ownerId,
      strategyOrderHash: checked.strategyOrderHash,
      packageOrderId: checked.packageOrderId,
      settlementReadinessHash: checked.settlementReadinessHash,
      legId: checked.legId,
      instrumentId: checked.instrumentId,
      instrumentHash: checked.instrumentHash,
      signedQuantityAtoms: checked.signedQuantityAtoms,
      limitPriceTicks: checked.limitPriceTicks,
      sequence: checked.sequence,
    };
    if (compareBytes(checked.obligationId, obligationHash(identity)) !== 0) {
      throw new MalformedInputError(`${at}.obligationId`, 'obligation id does not match its signed source identity');
    }
    return checked;
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
    const priceTickQuoteAtoms = unsigned(summary.priceTickQuoteAtoms, U128_BITS, `${at}.priceTickQuoteAtoms`);
    if (priceTickQuoteAtoms === 0n) throw new MalformedInputError(`${at}.priceTickQuoteAtoms`, 'price tick is zero');
    const internalClearingPriceTicks = summary.internalClearingPriceTicks === undefined
      ? undefined
      : unsigned(summary.internalClearingPriceTicks, U128_BITS, `${at}.internalClearingPriceTicks`);
    const externalLimitPriceTicks = summary.externalLimitPriceTicks === undefined
      ? undefined
      : unsigned(summary.externalLimitPriceTicks, U128_BITS, `${at}.externalLimitPriceTicks`);
    if (internalClearingPriceTicks === 0n) throw new MalformedInputError(`${at}.internalClearingPriceTicks`, 'price is zero');
    if (externalLimitPriceTicks === 0n) throw new MalformedInputError(`${at}.externalLimitPriceTicks`, 'price is zero');
    return Object.freeze({
      instrumentId: protocolId(summary.instrumentId, `${at}.instrumentId`),
      instrumentHash: commitmentHash(summary.instrumentHash, `${at}.instrumentHash`),
      grossBuyAtoms: unsigned(summary.grossBuyAtoms, U128_BITS, `${at}.grossBuyAtoms`),
      grossSellAtoms: unsigned(summary.grossSellAtoms, U128_BITS, `${at}.grossSellAtoms`),
      internalMatchedAtoms: unsigned(summary.internalMatchedAtoms, U128_BITS, `${at}.internalMatchedAtoms`),
      externalNetAtoms: checkedSigned(summary.externalNetAtoms, I128_BITS, `${at}.externalNetAtoms`),
      quantityIncrementAtoms,
      priceTickQuoteAtoms,
      ...(internalClearingPriceTicks === undefined ? {} : { internalClearingPriceTicks }),
      ...(externalLimitPriceTicks === undefined ? {} : { externalLimitPriceTicks }),
      internalQuoteAtoms: unsigned(summary.internalQuoteAtoms, U256_BITS, `${at}.internalQuoteAtoms`),
    });
  });
  if (checkedSummaries.some((summary, index) => index > 0
    && checkedSummaries[index - 1]!.instrumentId >= summary.instrumentId)) {
    throw new MalformedInputError('verifyNetting.underlyings', 'instrument summaries are not canonically ordered');
  }
  for (const allocation of checkedAllocations) {
    const { signedQuantityAtoms: gross, internalQuantityAtoms: inside, externalQuantityAtoms: outside } = allocation;
    if (inside + outside !== gross) throw new MalformedInputError('verifyNetting', 'an obligation is not conserved');
    if (inside !== 0n && (inside > 0n) !== (gross > 0n)) throw new MalformedInputError('verifyNetting', 'an internal share flips direction');
    if (absBigInt(inside) > absBigInt(gross)) throw new MalformedInputError('verifyNetting', 'an internal share exceeds its obligation');
    if (inside === 0n && allocation.internalQuoteDeltaAtoms !== 0n) throw new MalformedInputError('verifyNetting', 'an unnetted obligation has an internal quote transfer');
    if (inside > 0n && allocation.internalQuoteDeltaAtoms >= 0n) throw new MalformedInputError('verifyNetting', 'an internal buyer does not pay quote asset');
    if (inside < 0n && allocation.internalQuoteDeltaAtoms <= 0n) throw new MalformedInputError('verifyNetting', 'an internal seller does not receive quote asset');
  }
  const underlyings = new Set<string>(checkedAllocations.map((allocation) => allocation.instrumentId));
  const summarized = new Set<string>();
  for (const summary of checkedSummaries) {
    if (summarized.has(summary.instrumentId)) throw new MalformedInputError('verifyNetting', `instrument ${summary.instrumentId} is summarized twice`);
    summarized.add(summary.instrumentId);
    if (!underlyings.has(summary.instrumentId)) throw new MalformedInputError('verifyNetting', `instrument ${summary.instrumentId} has no allocations`);
  }
  for (const instrumentId of underlyings) {
    if (!summarized.has(instrumentId)) throw new MalformedInputError('verifyNetting', `instrument ${instrumentId} has no summary`);
  }
  for (const summary of checkedSummaries) {
    const lines = checkedAllocations.filter((allocation) => allocation.instrumentId === summary.instrumentId);
    if (lines.some((line) => compareBytes(line.instrumentHash, summary.instrumentHash) !== 0)) {
      throw new MalformedInputError('verifyNetting', 'an allocation cites another instrument identity');
    }
    if (lines.some((line) => line.signedQuantityAtoms % summary.quantityIncrementAtoms !== 0n
      || line.internalQuantityAtoms % summary.quantityIncrementAtoms !== 0n
      || line.externalQuantityAtoms % summary.quantityIncrementAtoms !== 0n)) {
      throw new MalformedInputError('verifyNetting', 'an allocation is off the instrument increment lattice');
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
    let expectedClearingPriceTicks: bigint | undefined;
    if (matched > 0n) {
      const maximumSellLimit = maximum(lines.filter((line) => line.signedQuantityAtoms < 0n).map((line) => line.limitPriceTicks), 'verifyNetting.sellLimits');
      const minimumBuyLimit = minimum(lines.filter((line) => line.signedQuantityAtoms > 0n).map((line) => line.limitPriceTicks), 'verifyNetting.buyLimits');
      if (maximumSellLimit > minimumBuyLimit) throw new MalformedInputError('verifyNetting', 'buy and sell limits do not overlap');
      expectedClearingPriceTicks = (maximumSellLimit + minimumBuyLimit) / 2n;
    }
    if (summary.internalClearingPriceTicks !== expectedClearingPriceTicks) {
      throw new MalformedInputError('verifyNetting', 'internal clearing price does not follow the signed limits');
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
    const externalLines = lines.filter((line) => line.externalQuantityAtoms !== 0n);
    const expectedExternalLimitPriceTicks = external > 0n
      ? minimum(externalLines.map((line) => line.limitPriceTicks), 'verifyNetting.externalBuyLimits')
      : external < 0n
        ? maximum(externalLines.map((line) => line.limitPriceTicks), 'verifyNetting.externalSellLimits')
        : undefined;
    if (summary.externalLimitPriceTicks !== expectedExternalLimitPriceTicks) {
      throw new MalformedInputError('verifyNetting', 'external execution limit does not follow the remaining obligations');
    }
    const internalQuoteAtoms = expectedClearingPriceTicks === undefined
      ? 0n
      : quoteAtomsForQuantity(
        matched,
        summary.quantityIncrementAtoms,
        expectedClearingPriceTicks,
        summary.priceTickQuoteAtoms,
        'verifyNetting.internalQuoteAtoms',
      );
    if (summary.internalQuoteAtoms !== internalQuoteAtoms) {
      throw new MalformedInputError('verifyNetting', 'internal quote total does not follow the clearing price');
    }
    const quoteDelta = lines.reduce((sum, line) => sum + line.internalQuoteDeltaAtoms, 0n);
    if (quoteDelta !== 0n) throw new MalformedInputError('verifyNetting', 'internal quote transfers are unbalanced');
    for (const line of lines) {
      const expectedMagnitude = line.internalQuantityAtoms === 0n || expectedClearingPriceTicks === undefined
        ? 0n
        : quoteAtomsForQuantity(
          line.internalQuantityAtoms,
          summary.quantityIncrementAtoms,
          expectedClearingPriceTicks,
          summary.priceTickQuoteAtoms,
          'verifyNetting.internalQuoteDeltaAtoms',
        );
      const expectedDelta = line.internalQuantityAtoms > 0n ? -expectedMagnitude : expectedMagnitude;
      if (line.internalQuoteDeltaAtoms !== expectedDelta) {
        throw new MalformedInputError('verifyNetting', 'an internal quote transfer does not follow the clearing price');
      }
      if (expectedClearingPriceTicks !== undefined && line.internalQuantityAtoms > 0n && expectedClearingPriceTicks > line.limitPriceTicks) {
        throw new MalformedInputError('verifyNetting', 'internal clearing price exceeds a buyer limit');
      }
      if (expectedClearingPriceTicks !== undefined && line.internalQuantityAtoms < 0n && expectedClearingPriceTicks < line.limitPriceTicks) {
        throw new MalformedInputError('verifyNetting', 'internal clearing price is below a seller limit');
      }
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
