import { absBigInt, checkedSigned, checkedUnsigned, mulDiv, ROUNDING } from './arithmetic.js';
import { bytesEqual, compareBytes, toHex } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { DuplicateElementError, MalformedInputError, RangeViolationError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  PACKAGE_IMPLIED_MAX_SOURCES,
  PACKAGE_MATCHING_MAX_IMPLICATION_DEPTH,
  addImpliedLiquidity,
  impliedPackageQuote,
  packageMatchingPolicy,
  verifyImpliedPackageQuote,
  type ImpliedLiquidityInput,
  type ImpliedPackageQuote,
  type PackageBookEntry,
  type PackageBookSide,
  type PackageBookState,
  type PackageMatchingPolicy,
} from './package-matching.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import {
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';
import { encodeExactSignedRatio, exactSignedRatio, type ExactSignedRatio, type ExactSignedRatioInput } from './strategy-series.js';

export const PACKAGE_IMPLICATION_PROOF_VERSION = 1;
export const PACKAGE_IMPLICATION_MAX_COMPONENTS = 32;
export const PACKAGE_IMPLICATION_MAX_ANCESTORS = 64;

const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;
const U256_BITS = 256;
const I256_BITS = 256;

export interface PackageExposureComponentInput {
  readonly instrumentId: string;
  readonly ratio: ExactSignedRatioInput;
}

export interface PackageSeriesExposureInput {
  readonly seriesId: string;
  readonly seriesVersion: number;
  readonly seriesManifestHash: Uint8Array | string;
  readonly quoteAssetId: string;
  readonly quoteConventionId: string;
  readonly components: readonly PackageExposureComponentInput[];
}

export interface PackageSeriesExposure {
  readonly seriesId: ProtocolId;
  readonly seriesVersion: number;
  readonly seriesManifestHash: ManifestHash;
  readonly quoteAssetId: ProtocolId;
  readonly quoteConventionId: ProtocolId;
  readonly components: readonly {
    readonly instrumentId: ProtocolId;
    readonly ratio: ExactSignedRatio;
  }[];
}

export interface PackageImplicationSourceInput {
  readonly entryId: Uint8Array | string;
  readonly sourceVersion: bigint;
  readonly side: PackageBookSide;
  readonly priceTicks: bigint;
  readonly quantity: bigint;
  readonly derivationDepth: number;
  readonly series: PackageSeriesExposureInput;
  readonly unitsPerTarget: ExactSignedRatioInput;
  readonly reservationId: Uint8Array | string;
  readonly ancestorEntryIds: readonly (Uint8Array | string)[];
}

export interface PackageImplicationSource {
  readonly entryId: CommitmentHash;
  readonly sourceVersion: bigint;
  readonly side: PackageBookSide;
  readonly priceTicks: bigint;
  readonly quantity: bigint;
  readonly derivationDepth: number;
  readonly series: PackageSeriesExposure;
  readonly unitsPerTarget: ExactSignedRatio;
  readonly reservationId: CommitmentHash;
  readonly ancestorEntryIds: readonly CommitmentHash[];
}

export interface PackageImplicationProofInput {
  readonly version: number;
  readonly targetExecutionClassId: string;
  readonly targetSide: PackageBookSide;
  readonly targetSeries: PackageSeriesExposureInput;
  readonly sources: readonly PackageImplicationSourceInput[];
}

export interface PackageImplicationProof {
  readonly version: 1;
  readonly targetExecutionClassId: ProtocolId;
  readonly targetSide: PackageBookSide;
  readonly targetSeries: PackageSeriesExposure;
  readonly sources: readonly PackageImplicationSource[];
  readonly quote: ImpliedPackageQuote;
  readonly proofHash: CommitmentHash;
}

export interface MultiPackageImpliedLiquidityInput {
  readonly proof: PackageImplicationProof;
  readonly participantId: string;
  readonly commonControlGroupId: string;
  readonly expiresAtValue?: bigint;
  readonly nowValue: bigint;
}

interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function gcd(left: bigint, right: bigint): bigint {
  let first = absBigInt(left);
  let second = absBigInt(right);
  while (second !== 0n) {
    const remainder = first % second;
    first = second;
    second = remainder;
  }
  return first;
}

function rational(numerator: bigint, denominator: bigint, context: string): Rational {
  if (denominator === 0n) throw new MalformedInputError(context, 'denominator is zero');
  const sign = denominator < 0n ? -1n : 1n;
  const normalizedNumerator = numerator * sign;
  const normalizedDenominator = denominator * sign;
  if (normalizedNumerator === 0n) return Object.freeze({ numerator: 0n, denominator: 1n });
  const divisor = gcd(normalizedNumerator, normalizedDenominator);
  return Object.freeze({
    numerator: checkedSigned(normalizedNumerator / divisor, I256_BITS, `${context}.numerator`),
    denominator: checkedUnsigned(normalizedDenominator / divisor, U256_BITS, `${context}.denominator`),
  });
}

function multiply(left: Rational, right: Rational, context: string): Rational {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator, context);
}

function add(left: Rational, right: Rational, context: string): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
    context,
  );
}

function seriesExposure(input: PackageSeriesExposureInput, context: string): PackageSeriesExposure {
  object(input, context);
  if (!Number.isInteger(input.seriesVersion)) throw new MalformedInputError(`${context}.seriesVersion`, 'expected an integer');
  const seriesVersion = Number(checkedUnsigned(input.seriesVersion, U32_BITS, `${context}.seriesVersion`));
  if (seriesVersion === 0) throw new MalformedInputError(`${context}.seriesVersion`, 'version is zero');
  if (!Array.isArray(input.components) || input.components.length === 0
    || input.components.length > PACKAGE_IMPLICATION_MAX_COMPONENTS) {
    throw new RangeViolationError(`${context}.components`, 'component count is outside the supported bound');
  }
  const components = input.components.map((component, index) => {
    const at = `${context}.components[${index}]`;
    object(component, at);
    return Object.freeze({
      instrumentId: protocolId(component.instrumentId, `${at}.instrumentId`),
      ratio: exactSignedRatio(component.ratio, `${at}.ratio`),
    });
  }).sort((left, right) => left.instrumentId < right.instrumentId ? -1 : left.instrumentId > right.instrumentId ? 1 : 0);
  for (let index = 1; index < components.length; index += 1) {
    if (components[index - 1]?.instrumentId === components[index]?.instrumentId) {
      throw new DuplicateElementError(`${context}.components`, 'instrument exposure repeats');
    }
  }
  return Object.freeze({
    seriesId: protocolId(input.seriesId, `${context}.seriesId`),
    seriesVersion,
    seriesManifestHash: manifestHash(input.seriesManifestHash, `${context}.seriesManifestHash`),
    quoteAssetId: protocolId(input.quoteAssetId, `${context}.quoteAssetId`),
    quoteConventionId: protocolId(input.quoteConventionId, `${context}.quoteConventionId`),
    components: Object.freeze(components),
  });
}

function encodeSeriesExposure(writer: CanonicalWriter, value: PackageSeriesExposure, context: string): void {
  encodeProtocolId(writer, value.seriesId, `${context}.seriesId`);
  writer.writeU32(value.seriesVersion, `${context}.seriesVersion`);
  encodeManifestHash(writer, value.seriesManifestHash, `${context}.seriesManifestHash`);
  encodeProtocolId(writer, value.quoteAssetId, `${context}.quoteAssetId`);
  encodeProtocolId(writer, value.quoteConventionId, `${context}.quoteConventionId`);
  writer.writeArray(value.components, (target, component) => {
    encodeProtocolId(target, component.instrumentId, `${context}.components.instrumentId`);
    encodeExactSignedRatio(target, component.ratio);
  }, `${context}.components`);
}

function sideFor(targetSide: PackageBookSide, coefficient: ExactSignedRatio): PackageBookSide {
  if (coefficient.numerator > 0n) return targetSide;
  return targetSide === 'BID' ? 'ASK' : 'BID';
}

function sameSeries(left: PackageSeriesExposure, right: PackageSeriesExposure): boolean {
  return left.seriesId === right.seriesId
    && left.seriesVersion === right.seriesVersion
    && bytesEqual(left.seriesManifestHash, right.seriesManifestHash);
}

function sourceValue(input: PackageImplicationSourceInput, context: string): PackageImplicationSource {
  object(input, context);
  if (typeof input.sourceVersion !== 'bigint') throw new MalformedInputError(`${context}.sourceVersion`, 'expected a bigint');
  const sourceVersion = checkedUnsigned(input.sourceVersion, U64_BITS, `${context}.sourceVersion`);
  if (typeof input.priceTicks !== 'bigint') throw new MalformedInputError(`${context}.priceTicks`, 'expected a bigint');
  const priceTicks = checkedSigned(input.priceTicks, I128_BITS, `${context}.priceTicks`);
  if (typeof input.quantity !== 'bigint') throw new MalformedInputError(`${context}.quantity`, 'expected a bigint');
  const quantity = checkedUnsigned(input.quantity, U128_BITS, `${context}.quantity`);
  if (quantity === 0n) throw new MalformedInputError(`${context}.quantity`, 'quantity is zero');
  if (!Number.isInteger(input.derivationDepth) || input.derivationDepth < 0
    || input.derivationDepth >= PACKAGE_MATCHING_MAX_IMPLICATION_DEPTH) {
    throw new RangeViolationError(`${context}.derivationDepth`, 'source derivation depth is outside the supported bound');
  }
  if (!Array.isArray(input.ancestorEntryIds) || input.ancestorEntryIds.length > PACKAGE_IMPLICATION_MAX_ANCESTORS) {
    throw new RangeViolationError(`${context}.ancestorEntryIds`, 'ancestor count is outside the supported bound');
  }
  const entryId = commitmentHash(input.entryId, `${context}.entryId`);
  const ancestors = input.ancestorEntryIds.map((value, index) =>
    commitmentHash(value, `${context}.ancestorEntryIds[${index}]`),
  ).sort(compareBytes);
  const seen = new Set<string>();
  for (const ancestor of ancestors) {
    const key = toHex(ancestor);
    if (key === toHex(entryId)) throw new MalformedInputError(`${context}.ancestorEntryIds`, 'source lineage contains itself');
    if (seen.has(key)) throw new DuplicateElementError(`${context}.ancestorEntryIds`, 'ancestor repeats');
    seen.add(key);
  }
  if ((input.derivationDepth === 0) !== (ancestors.length === 0)) {
    throw new MalformedInputError(`${context}.ancestorEntryIds`, 'only derived sources carry ancestry');
  }
  const side = input.side;
  if (side !== 'BID' && side !== 'ASK') throw new MalformedInputError(`${context}.side`, 'unknown package book side');
  return Object.freeze({
    entryId,
    sourceVersion,
    side,
    priceTicks,
    quantity,
    derivationDepth: input.derivationDepth,
    series: seriesExposure(input.series, `${context}.series`),
    unitsPerTarget: exactSignedRatio(input.unitsPerTarget, `${context}.unitsPerTarget`),
    reservationId: commitmentHash(input.reservationId, `${context}.reservationId`),
    ancestorEntryIds: Object.freeze(ancestors),
  });
}

function encodeSource(writer: CanonicalWriter, source: PackageImplicationSource, context: string): void {
  encodeCommitmentHash(writer, source.entryId, `${context}.entryId`);
  writer.writeU64(source.sourceVersion, `${context}.sourceVersion`);
  writer.writeU8(source.side === 'BID' ? 1 : 2, `${context}.side`);
  writer.writeI128(source.priceTicks, `${context}.priceTicks`);
  writer.writeU128(source.quantity, `${context}.quantity`);
  writer.writeU8(source.derivationDepth, `${context}.derivationDepth`);
  encodeSeriesExposure(writer, source.series, `${context}.series`);
  encodeExactSignedRatio(writer, source.unitsPerTarget);
  encodeCommitmentHash(writer, source.reservationId, `${context}.reservationId`);
  writer.writeArray(source.ancestorEntryIds, (target, value) =>
    encodeCommitmentHash(target, value, `${context}.ancestorEntryIds.entryId`),
  `${context}.ancestorEntryIds`);
}

function exposureMap(series: PackageSeriesExposure): Map<string, Rational> {
  return new Map(series.components.map((component) => [component.instrumentId, component.ratio]));
}

function assertConservation(target: PackageSeriesExposure, sources: readonly PackageImplicationSource[], context: string): void {
  const combined = new Map<string, Rational>();
  for (const source of sources) {
    for (const component of source.series.components) {
      const contribution = multiply(component.ratio, source.unitsPerTarget, `${context}.contribution`);
      const current = combined.get(component.instrumentId) ?? rational(0n, 1n, `${context}.zero`);
      combined.set(component.instrumentId, add(current, contribution, `${context}.sum`));
    }
  }
  for (const [instrumentId, value] of [...combined]) if (value.numerator === 0n) combined.delete(instrumentId);
  const expected = exposureMap(target);
  if (combined.size !== expected.size) throw new MalformedInputError(context, 'source exposures do not conserve the target package');
  for (const [instrumentId, ratio] of expected) {
    const actual = combined.get(instrumentId);
    if (actual === undefined || actual.numerator !== ratio.numerator || actual.denominator !== ratio.denominator) {
      throw new MalformedInputError(context, `source exposure does not conserve instrument ${instrumentId}`);
    }
  }
}

function proofBytes(value: Omit<PackageImplicationProof, 'proofHash'>): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(value.version, 'packageImplicationProof.version');
    encodeProtocolId(writer, value.targetExecutionClassId, 'packageImplicationProof.targetExecutionClassId');
    writer.writeU8(value.targetSide === 'BID' ? 1 : 2, 'packageImplicationProof.targetSide');
    encodeSeriesExposure(writer, value.targetSeries, 'packageImplicationProof.targetSeries');
    writer.writeArray(
      value.sources,
      (target, source) => encodeSource(target, source, 'packageImplicationProof.sources.source'),
      'packageImplicationProof.sources',
    );
    encodeCommitmentHash(writer, value.quote.entryId, 'packageImplicationProof.quoteEntryId');
  });
}

export function derivePackageImplicationProof(
  policyInput: PackageMatchingPolicy,
  input: PackageImplicationProofInput,
  context = 'packageImplicationProof',
): PackageImplicationProof {
  const policy = packageMatchingPolicy(policyInput, `${context}.policy`);
  object(input, context);
  if (input.version !== PACKAGE_IMPLICATION_PROOF_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${PACKAGE_IMPLICATION_PROOF_VERSION}`);
  }
  const targetExecutionClassId = protocolId(input.targetExecutionClassId, `${context}.targetExecutionClassId`);
  if (targetExecutionClassId !== policy.executionClassId) {
    throw new MalformedInputError(`${context}.targetExecutionClassId`, 'target is outside the matching policy');
  }
  if (input.targetSide !== 'BID' && input.targetSide !== 'ASK') {
    throw new MalformedInputError(`${context}.targetSide`, 'unknown package book side');
  }
  const targetSeries = seriesExposure(input.targetSeries, `${context}.targetSeries`);
  if (!Array.isArray(input.sources) || input.sources.length < 2 || input.sources.length > PACKAGE_IMPLIED_MAX_SOURCES) {
    throw new RangeViolationError(`${context}.sources`, 'multi-package implication needs 2 to 16 sources');
  }
  const sources = input.sources.map((source, index) => sourceValue(source, `${context}.sources[${index}]`))
    .sort((left, right) => compareBytes(left.entryId, right.entryId));
  const identities = new Set<string>();
  const reservations = new Set<string>();
  const lineage = new Set<string>();
  for (const source of sources) {
    const identity = toHex(source.entryId);
    const reservation = toHex(source.reservationId);
    if (identities.has(identity)) throw new DuplicateElementError(`${context}.sources`, 'source entry repeats');
    if (lineage.has(identity)) throw new MalformedInputError(`${context}.sources`, 'source graph cycles or reuses liquidity');
    if (reservations.has(reservation)) throw new DuplicateElementError(`${context}.sources`, 'source reservation repeats');
    identities.add(identity);
    reservations.add(reservation);
    if (sameSeries(source.series, targetSeries)) {
      throw new MalformedInputError(`${context}.sources`, 'target-series liquidity is direct, not implied');
    }
    if (source.series.quoteAssetId !== targetSeries.quoteAssetId
      || source.series.quoteConventionId !== targetSeries.quoteConventionId) {
      throw new MalformedInputError(`${context}.sources`, 'source and target quote semantics differ');
    }
    if (source.side !== sideFor(input.targetSide, source.unitsPerTarget)) {
      throw new MalformedInputError(`${context}.sources`, 'source side does not match its signed contribution');
    }
    for (const ancestor of source.ancestorEntryIds) {
      const key = toHex(ancestor);
      if (identities.has(key) || lineage.has(key)) {
        throw new MalformedInputError(`${context}.sources`, 'source graph cycles or reuses liquidity');
      }
      lineage.add(key);
    }
  }
  assertConservation(targetSeries, sources, `${context}.conservation`);
  const derivationDepth = Math.max(...sources.map((source) => source.derivationDepth)) + 1;
  if (derivationDepth > policy.maximumImplicationDepth) {
    throw new RangeViolationError(`${context}.sources`, 'derived depth exceeds the matching policy');
  }
  const rounding = input.targetSide === 'ASK' ? ROUNDING.CEIL : ROUNDING.FLOOR;
  let priceTicks = 0n;
  let quantity: bigint | undefined;
  for (const source of sources) {
    const coefficient = source.unitsPerTarget;
    priceTicks += mulDiv(source.priceTicks, coefficient.numerator, coefficient.denominator, rounding, `${context}.priceTicks`);
    const capacity = mulDiv(source.quantity, coefficient.denominator, absBigInt(coefficient.numerator), ROUNDING.FLOOR, `${context}.quantity`);
    quantity = quantity === undefined || capacity < quantity ? capacity : quantity;
  }
  checkedSigned(priceTicks, I128_BITS, `${context}.priceTicks`);
  const executable = (((quantity as bigint) / policy.quantityIncrement) * policy.quantityIncrement);
  if (executable === 0n) throw new MalformedInputError(`${context}.quantity`, 'sources support no whole target increment');
  const quote = impliedPackageQuote({
    executionClassId: targetExecutionClassId,
    side: input.targetSide,
    evidence: 'RESERVATION_BACKED_IMPLIED',
    priceTicks,
    quantity: executable,
    derivationDepth,
    sources: sources.map((source) => ({
      sourceId: toHex(source.entryId) as ProtocolId,
      sourceVersion: source.sourceVersion,
      reservationId: source.reservationId,
    })),
  }, `${context}.quote`);
  if (lineage.has(toHex(quote.entryId))) {
    throw new MalformedInputError(`${context}.sources`, 'derived entry already exists in its source lineage');
  }
  const body = Object.freeze({
    version: 1 as const,
    targetExecutionClassId,
    targetSide: input.targetSide,
    targetSeries,
    sources: Object.freeze(sources),
    quote,
  });
  return Object.freeze({
    ...body,
    proofHash: commitmentHash(domainHash(HASH_DOMAIN.PACKAGE_IMPLICATION_PROOF, proofBytes(body)), `${context}.proofHash`),
  });
}

export function verifyPackageImplicationProof(
  policy: PackageMatchingPolicy,
  proof: PackageImplicationProof,
  context = 'verifyPackageImplicationProof',
): PackageImplicationProof {
  object(proof, context);
  verifyImpliedPackageQuote(proof.quote, `${context}.quote`);
  const expected = derivePackageImplicationProof(policy, {
    version: proof.version,
    targetExecutionClassId: proof.targetExecutionClassId,
    targetSide: proof.targetSide,
    targetSeries: proof.targetSeries,
    sources: proof.sources,
  }, context);
  if (!bytesEqual(expected.proofHash, commitmentHash(proof.proofHash, `${context}.proofHash`))) {
    throw new MalformedInputError(`${context}.proofHash`, 'proof hash does not bind the implication');
  }
  if (!bytesEqual(expected.quote.entryId, proof.quote.entryId)) {
    throw new MalformedInputError(`${context}.quote`, 'quote does not match the implication proof');
  }
  return expected;
}

export function addMultiPackageImpliedLiquidity(
  policy: PackageMatchingPolicy,
  state: PackageBookState,
  input: MultiPackageImpliedLiquidityInput,
  context = 'addMultiPackageImpliedLiquidity',
): { readonly state: PackageBookState; readonly entry: PackageBookEntry } {
  const proof = verifyPackageImplicationProof(policy, input.proof, `${context}.proof`);
  const admission: ImpliedLiquidityInput = {
    quote: proof.quote,
    participantId: input.participantId,
    commonControlGroupId: input.commonControlGroupId,
    ...(input.expiresAtValue === undefined ? {} : { expiresAtValue: input.expiresAtValue }),
    nowValue: input.nowValue,
  };
  return addImpliedLiquidity(policy, state, admission, context);
}
