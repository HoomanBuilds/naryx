import { absBigInt, checkedSigned, checkedUnsigned, mulDiv, ROUNDING } from './arithmetic.js';
import { compareBytes, toHex } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  PACKAGE_ORDER_TYPE,
  PACKAGE_TIME_IN_FORCE,
  type EnumTable,
  type PackageOrderType,
  type PackageTimeInForce,
} from './enums.js';
import { DuplicateElementError, MalformedInputError, RangeViolationError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type Hash32,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';
import type { ExactSignedRatio } from './strategy-series.js';

export const PACKAGE_MATCHING_POLICY_VERSION = 1;
export const PACKAGE_ALLOCATION_VERSION = 1;
export const PACKAGE_BOOK_CANCELLATION_VERSION = 1;
export const IMPLIED_PACKAGE_QUOTE_VERSION = 1;
// Multi-package implication stays gated until bounded-depth conservation proofs exist.
export const PACKAGE_MATCHING_MAX_IMPLICATION_DEPTH = 1;
export const PACKAGE_IMPLIED_MAX_SOURCES = 16;

const U8_BITS = 8;
const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;

export const PACKAGE_BOOK_SIDE = Object.freeze({
  BID: 1,
  ASK: 2,
} as const);
export type PackageBookSide = keyof typeof PACKAGE_BOOK_SIDE;

export const PACKAGE_LIQUIDITY_SOURCE = Object.freeze({
  DIRECT: 1,
  IMPLIED: 2,
} as const);
export type PackageLiquiditySource = keyof typeof PACKAGE_LIQUIDITY_SOURCE;

export const IMPLICATION_EVIDENCE = Object.freeze({
  INDICATIVE_IMPLIED: 1,
  RESERVATION_BACKED_IMPLIED: 2,
  SOLVER_BACKED_IMPLIED: 3,
} as const);
export type ImplicationEvidence = keyof typeof IMPLICATION_EVIDENCE;

export const MATCHING_ALLOCATION_RULE = Object.freeze({
  PRICE_TIME: 1,
} as const);
export type MatchingAllocationRule = keyof typeof MATCHING_ALLOCATION_RULE;

export const DIRECT_IMPLIED_PRIORITY = Object.freeze({
  DIRECT_FIRST: 1,
} as const);
export type DirectImpliedPriority = keyof typeof DIRECT_IMPLIED_PRIORITY;

export const SELF_MATCH_POLICY = Object.freeze({
  CANCEL_INCOMING: 1,
  CANCEL_RESTING: 2,
  CANCEL_BOTH: 3,
} as const);
export type SelfMatchPolicy = keyof typeof SELF_MATCH_POLICY;

export const AMENDMENT_PRIORITY_RULE = Object.freeze({
  RETAIN_ON_SIZE_REDUCTION: 1,
} as const);
export type AmendmentPriorityRule = keyof typeof AMENDMENT_PRIORITY_RULE;

export type PackageMatchRejection =
  | 'HALTED'
  | 'DUPLICATE_ORDER'
  | 'POST_ONLY_WOULD_CROSS'
  | 'FOK_UNFILLABLE'
  | 'MINIMUM_QUANTITY_UNFILLABLE';

// ------------------------------------------------------------------ policy

export interface PackageMatchingPolicyInput {
  readonly matchingPolicyVersion: number;
  readonly environment: string;
  readonly executionClassId: string;
  readonly allocationRule: MatchingAllocationRule;
  readonly directVersusImpliedPriority: DirectImpliedPriority;
  readonly selfMatchPolicy: SelfMatchPolicy;
  readonly commonControlAsSelf: boolean;
  readonly amendmentPriorityRule: AmendmentPriorityRule;
  readonly quantityIncrement: bigint;
  readonly minimumExecutionQuantity: bigint;
  readonly maximumImplicationDepth: number;
}

export interface PackageMatchingPolicy {
  readonly matchingPolicyVersion: number;
  readonly environment: ProtocolId;
  readonly executionClassId: ProtocolId;
  readonly allocationRule: MatchingAllocationRule;
  readonly directVersusImpliedPriority: DirectImpliedPriority;
  readonly selfMatchPolicy: SelfMatchPolicy;
  readonly commonControlAsSelf: boolean;
  readonly amendmentPriorityRule: AmendmentPriorityRule;
  readonly quantityIncrement: bigint;
  readonly minimumExecutionQuantity: bigint;
  readonly maximumImplicationDepth: number;
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an object');
  }
}

function bigintIn(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  return checkedUnsigned(value, bits, context);
}

function positive(value: bigint, bits: number, context: string): bigint {
  const checked = bigintIn(value, bits, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'value is zero');
  }
  return checked;
}

function signedTicks(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  return checkedSigned(value, I128_BITS, context);
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function bool(value: boolean, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new MalformedInputError(context, 'expected a boolean');
  }
  return value;
}

function multipleOf(value: bigint, increment: bigint, context: string): void {
  if (value % increment !== 0n) {
    throw new MalformedInputError(context, `quantity ${value} is not a multiple of increment ${increment}`);
  }
}

export function packageMatchingPolicy(
  input: PackageMatchingPolicyInput,
  context = 'packageMatchingPolicy',
): PackageMatchingPolicy {
  object(input, context);
  if (typeof input.matchingPolicyVersion !== 'number') {
    throw new MalformedInputError(`${context}.matchingPolicyVersion`, 'expected a number');
  }
  const version = Number(checkedUnsigned(input.matchingPolicyVersion, U32_BITS, `${context}.matchingPolicyVersion`));
  if (version !== PACKAGE_MATCHING_POLICY_VERSION) {
    throw new MalformedInputError(`${context}.matchingPolicyVersion`, `version must equal ${PACKAGE_MATCHING_POLICY_VERSION}`);
  }
  const quantityIncrement = positive(input.quantityIncrement, U128_BITS, `${context}.quantityIncrement`);
  const minimumExecutionQuantity = positive(
    input.minimumExecutionQuantity,
    U128_BITS,
    `${context}.minimumExecutionQuantity`,
  );
  multipleOf(minimumExecutionQuantity, quantityIncrement, `${context}.minimumExecutionQuantity`);
  if (typeof input.maximumImplicationDepth !== 'number') {
    throw new MalformedInputError(`${context}.maximumImplicationDepth`, 'expected a number');
  }
  const maximumImplicationDepth = Number(
    checkedUnsigned(input.maximumImplicationDepth, U8_BITS, `${context}.maximumImplicationDepth`),
  );
  if (maximumImplicationDepth > PACKAGE_MATCHING_MAX_IMPLICATION_DEPTH) {
    throw new RangeViolationError(
      `${context}.maximumImplicationDepth`,
      `implication depth above ${PACKAGE_MATCHING_MAX_IMPLICATION_DEPTH} is not implemented`,
    );
  }
  return Object.freeze({
    matchingPolicyVersion: version,
    environment: protocolId(input.environment, `${context}.environment`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    allocationRule: variant(MATCHING_ALLOCATION_RULE, input.allocationRule, `${context}.allocationRule`),
    directVersusImpliedPriority: variant(
      DIRECT_IMPLIED_PRIORITY,
      input.directVersusImpliedPriority,
      `${context}.directVersusImpliedPriority`,
    ),
    selfMatchPolicy: variant(SELF_MATCH_POLICY, input.selfMatchPolicy, `${context}.selfMatchPolicy`),
    commonControlAsSelf: bool(input.commonControlAsSelf, `${context}.commonControlAsSelf`),
    amendmentPriorityRule: variant(
      AMENDMENT_PRIORITY_RULE,
      input.amendmentPriorityRule,
      `${context}.amendmentPriorityRule`,
    ),
    quantityIncrement,
    minimumExecutionQuantity,
    maximumImplicationDepth,
  });
}

export function encodePackageMatchingPolicy(
  writer: CanonicalWriter,
  value: PackageMatchingPolicy,
  context = 'packageMatchingPolicy',
): void {
  const checked = packageMatchingPolicy(value, context);
  writer.writeU32(checked.matchingPolicyVersion, `${context}.matchingPolicyVersion`);
  encodeProtocolId(writer, checked.environment, `${context}.environment`);
  encodeProtocolId(writer, checked.executionClassId, `${context}.executionClassId`);
  writer.writeEnum(MATCHING_ALLOCATION_RULE, checked.allocationRule, `${context}.allocationRule`);
  writer.writeEnum(
    DIRECT_IMPLIED_PRIORITY,
    checked.directVersusImpliedPriority,
    `${context}.directVersusImpliedPriority`,
  );
  writer.writeEnum(SELF_MATCH_POLICY, checked.selfMatchPolicy, `${context}.selfMatchPolicy`);
  writer.writeBool(checked.commonControlAsSelf, `${context}.commonControlAsSelf`);
  writer.writeEnum(AMENDMENT_PRIORITY_RULE, checked.amendmentPriorityRule, `${context}.amendmentPriorityRule`);
  writer.writeU128(checked.quantityIncrement, `${context}.quantityIncrement`);
  writer.writeU128(checked.minimumExecutionQuantity, `${context}.minimumExecutionQuantity`);
  writer.writeU8(checked.maximumImplicationDepth, `${context}.maximumImplicationDepth`);
}

export function packageMatchingPolicyBytes(value: PackageMatchingPolicy): Uint8Array {
  return canonicalBytes((writer) => encodePackageMatchingPolicy(writer, value));
}

export function packageMatchingPolicyHash(value: PackageMatchingPolicy): ManifestHash {
  return manifestHash(
    domainHash(HASH_DOMAIN.PACKAGE_MATCHING_POLICY, packageMatchingPolicyBytes(value)),
    'packageMatchingPolicyHash',
  );
}

// ------------------------------------------------------------------ implied quotes

export interface ImpliedSourceRef {
  readonly sourceId: ProtocolId;
  readonly sourceVersion: bigint;
  readonly reservationId?: CommitmentHash;
}

export interface ImpliedLegSourceInput {
  readonly sourceId: string;
  readonly sourceVersion: bigint;
  readonly side: PackageBookSide;
  readonly priceTicks: bigint;
  readonly quantity: bigint;
  readonly reservationId?: Uint8Array | string;
}

export interface ImpliedPackageQuoteInput {
  readonly executionClassId: string;
  readonly side: PackageBookSide;
  readonly evidence: ImplicationEvidence;
  readonly legRatios: readonly ExactSignedRatio[];
  readonly legSources: readonly ImpliedLegSourceInput[];
  readonly solverCommitment?: Uint8Array | string;
}

export interface ImpliedPackageQuote {
  readonly entryId: CommitmentHash;
  readonly executionClassId: ProtocolId;
  readonly side: PackageBookSide;
  readonly evidence: ImplicationEvidence;
  readonly priceTicks: bigint;
  readonly quantity: bigint;
  readonly derivationDepth: number;
  readonly sources: readonly ImpliedSourceRef[];
  readonly solverCommitment?: CommitmentHash;
}

function opposite(side: PackageBookSide): PackageBookSide {
  return side === 'BID' ? 'ASK' : 'BID';
}

function checkedRatio(value: ExactSignedRatio, context: string): ExactSignedRatio {
  object(value, context);
  if (typeof value.numerator !== 'bigint' || typeof value.denominator !== 'bigint') {
    throw new MalformedInputError(context, 'expected bigint numerator and denominator');
  }
  checkedSigned(value.numerator, I128_BITS, `${context}.numerator`);
  if (value.numerator === 0n) {
    throw new MalformedInputError(`${context}.numerator`, 'a zero ratio leg carries no exposure');
  }
  positive(value.denominator, U128_BITS, `${context}.denominator`);
  return value;
}

function encodeImpliedSources(writer: CanonicalWriter, sources: readonly ImpliedSourceRef[], context: string): void {
  writer.writeArray(
    sources,
    (element, source) => {
      encodeProtocolId(element, source.sourceId, `${context}.sourceId`);
      element.writeU64(source.sourceVersion, `${context}.sourceVersion`);
      element.writeOptional(source.reservationId, (inner, value) =>
        encodeCommitmentHash(inner, value, `${context}.reservationId`),
      );
    },
    context,
  );
}

/**
 * Derives an implied-in package quote from leg sources. Each leg term rounds against
 * the taker: an implied ask rounds every term up, an implied bid rounds every term down.
 */
export function deriveImpliedPackageQuote(
  policy: PackageMatchingPolicy,
  input: ImpliedPackageQuoteInput,
  context = 'impliedPackageQuote',
): ImpliedPackageQuote {
  const checkedPolicy = packageMatchingPolicy(policy, `${context}.policy`);
  object(input, context);
  const executionClassId = protocolId(input.executionClassId, `${context}.executionClassId`);
  if (executionClassId !== checkedPolicy.executionClassId) {
    throw new MalformedInputError(`${context}.executionClassId`, 'implied quote is outside the policy execution class');
  }
  const side = variant(PACKAGE_BOOK_SIDE, input.side, `${context}.side`);
  const evidence = variant(IMPLICATION_EVIDENCE, input.evidence, `${context}.evidence`);
  if (!Array.isArray(input.legRatios) || !Array.isArray(input.legSources)) {
    throw new MalformedInputError(context, 'expected leg ratio and leg source arrays');
  }
  if (input.legSources.length === 0 || input.legSources.length !== input.legRatios.length) {
    throw new MalformedInputError(`${context}.legSources`, 'every economic leg needs exactly one source');
  }
  if (input.legSources.length > PACKAGE_IMPLIED_MAX_SOURCES) {
    throw new RangeViolationError(`${context}.legSources`, `more than ${PACKAGE_IMPLIED_MAX_SOURCES} sources`);
  }
  const rounding = side === 'ASK' ? ROUNDING.CEIL : ROUNDING.FLOOR;
  let priceTicks = 0n;
  let quantity: bigint | undefined;
  const seen = new Set<string>();
  const sources = input.legSources.map((leg, index) => {
    const legContext = `${context}.legSources[${index}]`;
    object(leg, legContext);
    const ratio = checkedRatio(input.legRatios[index] as ExactSignedRatio, `${context}.legRatios[${index}]`);
    const sourceId = protocolId(leg.sourceId, `${legContext}.sourceId`);
    if (seen.has(sourceId)) {
      throw new DuplicateElementError(`${legContext}.sourceId`, 'one source cannot back two legs');
    }
    seen.add(sourceId);
    // A package ask buys positive-ratio legs from their asks; a package bid sells into their bids.
    const required = ratio.numerator > 0n ? side : opposite(side);
    if (variant(PACKAGE_BOOK_SIDE, leg.side, `${legContext}.side`) !== required) {
      throw new MalformedInputError(`${legContext}.side`, `leg must be sourced from the ${required} side`);
    }
    const legPrice = signedTicks(leg.priceTicks, `${legContext}.priceTicks`);
    const legQuantity = positive(leg.quantity, U128_BITS, `${legContext}.quantity`);
    priceTicks += mulDiv(legPrice, ratio.numerator, ratio.denominator, rounding, `${legContext}.price`);
    const legLimit = mulDiv(legQuantity, ratio.denominator, absBigInt(ratio.numerator), ROUNDING.FLOOR, legContext);
    quantity = quantity === undefined || legLimit < quantity ? legLimit : quantity;
    const reservationId =
      leg.reservationId === undefined ? undefined : commitmentHash(leg.reservationId, `${legContext}.reservationId`);
    if (evidence === 'RESERVATION_BACKED_IMPLIED' && reservationId === undefined) {
      throw new MalformedInputError(`${legContext}.reservationId`, 'reservation-backed implication needs every source reserved');
    }
    return Object.freeze({
      sourceId,
      sourceVersion: bigintIn(leg.sourceVersion, U64_BITS, `${legContext}.sourceVersion`),
      ...(reservationId === undefined ? {} : { reservationId }),
    });
  });
  checkedSigned(priceTicks, I128_BITS, `${context}.priceTicks`);
  const executable = ((quantity as bigint) / checkedPolicy.quantityIncrement) * checkedPolicy.quantityIncrement;
  if (executable === 0n) {
    throw new MalformedInputError(`${context}.quantity`, 'leg sources support no whole package increment');
  }
  const solverCommitment =
    input.solverCommitment === undefined ? undefined : commitmentHash(input.solverCommitment, `${context}.solverCommitment`);
  if ((evidence === 'SOLVER_BACKED_IMPLIED') !== (solverCommitment !== undefined)) {
    throw new MalformedInputError(`${context}.solverCommitment`, 'a solver commitment is required exactly for solver-backed implication');
  }
  const body = {
    executionClassId,
    side,
    evidence,
    priceTicks,
    quantity: executable,
    derivationDepth: 1,
    sources: Object.freeze(sources),
    ...(solverCommitment === undefined ? {} : { solverCommitment }),
  };
  const bytes = canonicalBytes((writer) => {
    writer.writeU32(IMPLIED_PACKAGE_QUOTE_VERSION, `${context}.version`);
    encodeProtocolId(writer, executionClassId, `${context}.executionClassId`);
    writer.writeEnum(PACKAGE_BOOK_SIDE, side, `${context}.side`);
    writer.writeEnum(IMPLICATION_EVIDENCE, evidence, `${context}.evidence`);
    writer.writeI128(priceTicks, `${context}.priceTicks`);
    writer.writeU128(executable, `${context}.quantity`);
    writer.writeU8(body.derivationDepth, `${context}.derivationDepth`);
    encodeImpliedSources(writer, body.sources, `${context}.sources`);
    writer.writeOptional(solverCommitment, (inner, value) =>
      encodeCommitmentHash(inner, value, `${context}.solverCommitment`),
    );
  });
  return Object.freeze({
    entryId: commitmentHash(domainHash(HASH_DOMAIN.IMPLIED_PACKAGE_QUOTE, bytes), `${context}.entryId`),
    ...body,
  });
}

// ------------------------------------------------------------------ book state

export interface PackageBookEntry {
  readonly entryId: CommitmentHash;
  readonly side: PackageBookSide;
  readonly source: PackageLiquiditySource;
  readonly priceTicks: bigint;
  readonly quantity: bigint;
  readonly minimumFillQuantity: bigint;
  readonly sequence: bigint;
  readonly participantId: ProtocolId;
  readonly commonControlGroupId: ProtocolId;
  readonly expiresAtValue?: bigint;
  readonly implied?: {
    readonly evidence: ImplicationEvidence;
    readonly derivationDepth: number;
    readonly sources: readonly ImpliedSourceRef[];
    readonly solverCommitment?: CommitmentHash;
  };
}

export interface PackageBookState {
  readonly executionClassId: ProtocolId;
  readonly matchingPolicyHash: ManifestHash;
  readonly halted: boolean;
  readonly nextSequence: bigint;
  readonly entries: readonly PackageBookEntry[];
  readonly consumedSourceKeys: readonly string[];
}

export function emptyPackageBook(policy: PackageMatchingPolicy): PackageBookState {
  const checked = packageMatchingPolicy(policy);
  return Object.freeze({
    executionClassId: checked.executionClassId,
    matchingPolicyHash: packageMatchingPolicyHash(checked),
    halted: false,
    nextSequence: 1n,
    entries: Object.freeze([]),
    consumedSourceKeys: Object.freeze([]),
  });
}

function checkedEntry(policy: PackageMatchingPolicy, input: PackageBookEntry, context: string): PackageBookEntry {
  object(input, context);
  const source = variant(PACKAGE_LIQUIDITY_SOURCE, input.source, `${context}.source`);
  const quantity = positive(input.quantity, U128_BITS, `${context}.quantity`);
  multipleOf(quantity, policy.quantityIncrement, `${context}.quantity`);
  const minimumFillQuantity = positive(input.minimumFillQuantity, U128_BITS, `${context}.minimumFillQuantity`);
  const expectedMinimum = source === 'IMPLIED' ? quantity : policy.minimumExecutionQuantity;
  if (minimumFillQuantity !== expectedMinimum) {
    throw new MalformedInputError(`${context}.minimumFillQuantity`, 'minimum fill does not match the liquidity source');
  }
  if ((source === 'IMPLIED') !== (input.implied !== undefined)) {
    throw new MalformedInputError(`${context}.implied`, 'implication metadata is required exactly for implied liquidity');
  }
  let implied: PackageBookEntry['implied'];
  if (input.implied !== undefined) {
    const at = `${context}.implied`;
    object(input.implied, at);
    const evidence = variant(IMPLICATION_EVIDENCE, input.implied.evidence, `${at}.evidence`);
    if (evidence === 'INDICATIVE_IMPLIED') {
      throw new MalformedInputError(`${at}.evidence`, 'indicative implication never counts as executable depth');
    }
    if (!Number.isInteger(input.implied.derivationDepth) || input.implied.derivationDepth < 1
      || input.implied.derivationDepth > policy.maximumImplicationDepth) {
      throw new RangeViolationError(`${at}.derivationDepth`, 'implication depth exceeds the matching policy');
    }
    const sources = input.implied.sources;
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > PACKAGE_IMPLIED_MAX_SOURCES) {
      throw new MalformedInputError(`${at}.sources`, 'implied liquidity needs a bounded nonempty source list');
    }
    const seen = new Set<string>();
    const checkedSources = sources.map((source, index) => {
      object(source, `${at}.sources[${index}]`);
      const sourceId = protocolId(source.sourceId, `${at}.sources[${index}].sourceId`);
      if (seen.has(sourceId)) throw new DuplicateElementError(`${at}.sources`, 'duplicate implied source');
      seen.add(sourceId);
      const reservationId = source.reservationId === undefined
        ? undefined
        : commitmentHash(source.reservationId, `${at}.sources[${index}].reservationId`);
      if (evidence === 'RESERVATION_BACKED_IMPLIED' && reservationId === undefined) {
        throw new MalformedInputError(`${at}.sources`, 'reservation-backed implication needs every source reserved');
      }
      return Object.freeze({
        sourceId,
        sourceVersion: bigintIn(source.sourceVersion, U64_BITS, `${at}.sources[${index}].sourceVersion`),
        ...(reservationId === undefined ? {} : { reservationId }),
      });
    });
    const solverCommitment = input.implied.solverCommitment === undefined
      ? undefined
      : commitmentHash(input.implied.solverCommitment, `${at}.solverCommitment`);
    if ((evidence === 'SOLVER_BACKED_IMPLIED') !== (solverCommitment !== undefined)) {
      throw new MalformedInputError(`${at}.solverCommitment`, 'a solver commitment is required exactly for solver-backed implication');
    }
    implied = Object.freeze({
      evidence,
      derivationDepth: input.implied.derivationDepth,
      sources: Object.freeze(checkedSources),
      ...(solverCommitment === undefined ? {} : { solverCommitment }),
    });
  }
  const expiresAtValue =
    input.expiresAtValue === undefined ? undefined : bigintIn(input.expiresAtValue, U64_BITS, `${context}.expiresAtValue`);
  return Object.freeze({
    entryId: commitmentHash(input.entryId, `${context}.entryId`),
    side: variant(PACKAGE_BOOK_SIDE, input.side, `${context}.side`),
    source,
    priceTicks: signedTicks(input.priceTicks, `${context}.priceTicks`),
    quantity,
    minimumFillQuantity,
    sequence: positive(input.sequence, U64_BITS, `${context}.sequence`),
    participantId: protocolId(input.participantId, `${context}.participantId`),
    commonControlGroupId: protocolId(input.commonControlGroupId, `${context}.commonControlGroupId`),
    ...(expiresAtValue === undefined ? {} : { expiresAtValue }),
    ...(implied === undefined ? {} : { implied }),
  });
}

const SOURCE_KEY = /^[0-9a-f]{64}$/;

/** Revalidates book state supplied by a caller or loaded from storage against its policy. */
export function packageBookState(
  policy: PackageMatchingPolicy,
  input: PackageBookState,
  context = 'packageBookState',
): PackageBookState {
  const checked = packageMatchingPolicy(policy, `${context}.policy`);
  object(input, context);
  if (protocolId(input.executionClassId, `${context}.executionClassId`) !== checked.executionClassId) {
    throw new MalformedInputError(`${context}.executionClassId`, 'book belongs to another execution class');
  }
  const matchingPolicyHash = manifestHash(input.matchingPolicyHash, `${context}.matchingPolicyHash`);
  if (compareBytes(matchingPolicyHash, packageMatchingPolicyHash(checked)) !== 0) {
    throw new MalformedInputError(`${context}.matchingPolicyHash`, 'book was opened under another matching policy');
  }
  const nextSequence = positive(input.nextSequence, U64_BITS, `${context}.nextSequence`);
  if (!Array.isArray(input.entries) || !Array.isArray(input.consumedSourceKeys)) {
    throw new MalformedInputError(context, 'expected entry and consumed-source arrays');
  }
  const ids = new Set<string>();
  const sequences = new Set<bigint>();
  const entries = input.entries.map((entry, index) => {
    const checkedEntryValue = checkedEntry(checked, entry, `${context}.entries[${index}]`);
    const id = toHex(checkedEntryValue.entryId);
    if (ids.has(id) || sequences.has(checkedEntryValue.sequence)) {
      throw new DuplicateElementError(`${context}.entries[${index}]`, 'entry id or sequence repeats');
    }
    if (checkedEntryValue.sequence >= nextSequence) {
      throw new MalformedInputError(`${context}.entries[${index}].sequence`, 'entry sequence is not yet assigned');
    }
    ids.add(id);
    sequences.add(checkedEntryValue.sequence);
    return checkedEntryValue;
  });
  const keys = new Set<string>();
  for (const key of input.consumedSourceKeys) {
    if (typeof key !== 'string' || !SOURCE_KEY.test(key) || keys.has(key)) {
      throw new MalformedInputError(`${context}.consumedSourceKeys`, 'consumed source keys must be unique lowercase hashes');
    }
    keys.add(key);
  }
  return Object.freeze({
    executionClassId: checked.executionClassId,
    matchingPolicyHash,
    halted: bool(input.halted, `${context}.halted`),
    nextSequence,
    entries: Object.freeze(entries),
    consumedSourceKeys: Object.freeze([...keys].sort()),
  });
}

function bookFor(
  policy: PackageMatchingPolicy,
  state: PackageBookState,
  context: string,
): { readonly policy: PackageMatchingPolicy; readonly state: PackageBookState } {
  const checked = packageMatchingPolicy(policy, `${context}.policy`);
  return { policy: checked, state: packageBookState(checked, state, `${context}.state`) };
}

function withState(state: PackageBookState, changes: Partial<PackageBookState>): PackageBookState {
  return Object.freeze({
    ...state,
    ...changes,
    entries: Object.freeze([...(changes.entries ?? state.entries)]),
    consumedSourceKeys: Object.freeze([...(changes.consumedSourceKeys ?? state.consumedSourceKeys)].sort()),
  });
}

/** Keys that a filled implied entry consumes: every source reservation, or the solver commitment. */
function consumptionKeys(entry: PackageBookEntry): readonly string[] {
  const implied = entry.implied;
  if (implied === undefined) return [];
  const keys = implied.sources.flatMap((source) =>
    source.reservationId === undefined ? [] : [toHex(source.reservationId)],
  );
  if (implied.solverCommitment !== undefined) keys.push(toHex(implied.solverCommitment));
  return keys.sort();
}

function live(entry: PackageBookEntry, nowValue: bigint): boolean {
  return entry.expiresAtValue === undefined || nowValue < entry.expiresAtValue;
}

export interface ImpliedLiquidityInput {
  readonly quote: ImpliedPackageQuote;
  readonly participantId: string;
  readonly commonControlGroupId: string;
  readonly expiresAtValue?: bigint;
  readonly nowValue: bigint;
}

export function addImpliedLiquidity(
  policy: PackageMatchingPolicy,
  stateInput: PackageBookState,
  input: ImpliedLiquidityInput,
  context = 'addImpliedLiquidity',
): { readonly state: PackageBookState; readonly entry: PackageBookEntry } {
  const { policy: checked, state: book } = bookFor(policy, stateInput, context);
  object(input, context);
  const quote = input.quote;
  object(quote, `${context}.quote`);
  if (quote.executionClassId !== checked.executionClassId) {
    throw new MalformedInputError(`${context}.quote`, 'implied quote is outside the book execution class');
  }
  if (quote.evidence === 'INDICATIVE_IMPLIED') {
    throw new MalformedInputError(`${context}.quote.evidence`, 'indicative implication never counts as executable depth');
  }
  if (quote.derivationDepth < 1 || quote.derivationDepth > checked.maximumImplicationDepth) {
    throw new RangeViolationError(`${context}.quote.derivationDepth`, 'implication depth exceeds the matching policy');
  }
  multipleOf(quote.quantity, checked.quantityIncrement, `${context}.quote.quantity`);
  const nowValue = bigintIn(input.nowValue, U64_BITS, `${context}.nowValue`);
  const expiresAtValue =
    input.expiresAtValue === undefined ? undefined : bigintIn(input.expiresAtValue, U64_BITS, `${context}.expiresAtValue`);
  if (expiresAtValue !== undefined && expiresAtValue <= nowValue) {
    throw new MalformedInputError(`${context}.expiresAtValue`, 'implied liquidity is already expired');
  }
  const entryIds = new Set(book.entries.map((entry) => toHex(entry.entryId)));
  if (entryIds.has(toHex(quote.entryId))) {
    throw new DuplicateElementError(`${context}.quote.entryId`, 'implied quote is already in the book');
  }
  for (const source of quote.sources) {
    // A package entry id as a source would be multi-package implication, which is gated.
    if (entryIds.has(source.sourceId)) {
      throw new MalformedInputError(`${context}.quote.sources`, 'a package entry cannot source another implied package');
    }
  }
  const draft: PackageBookEntry = Object.freeze({
    entryId: quote.entryId,
    side: quote.side,
    source: 'IMPLIED',
    priceTicks: quote.priceTicks,
    quantity: quote.quantity,
    // Source reservations are single-use, so implied liquidity fills all or nothing.
    minimumFillQuantity: quote.quantity,
    sequence: book.nextSequence,
    participantId: protocolId(input.participantId, `${context}.participantId`),
    commonControlGroupId: protocolId(input.commonControlGroupId, `${context}.commonControlGroupId`),
    ...(expiresAtValue === undefined ? {} : { expiresAtValue }),
    implied: Object.freeze({
      evidence: quote.evidence,
      derivationDepth: quote.derivationDepth,
      sources: quote.sources,
      ...(quote.solverCommitment === undefined ? {} : { solverCommitment: quote.solverCommitment }),
    }),
  });
  const consumed = new Set(book.consumedSourceKeys);
  if (consumptionKeys(draft).some((key) => consumed.has(key))) {
    throw new MalformedInputError(`${context}.quote.sources`, 'a source reservation was already consumed');
  }
  // Implied liquidity that would cross a resting order is implied-out, which stays gated.
  if (crosses(draft.side, draft.priceTicks, book.entries.filter((entry) => live(entry, nowValue)))) {
    throw new MalformedInputError(`${context}.quote.priceTicks`, 'implied liquidity cannot cross the book');
  }
  return {
    entry: draft,
    state: withState(book, { entries: [...book.entries, draft], nextSequence: book.nextSequence + 1n }),
  };
}

/** Removes every implied entry built from `sourceId` at any version other than `currentVersion`. */
export function invalidateImpliedSource(
  state: PackageBookState,
  sourceId: string,
  currentVersion: bigint,
  context = 'invalidateImpliedSource',
): { readonly state: PackageBookState; readonly invalidatedEntryIds: readonly CommitmentHash[] } {
  const id = protocolId(sourceId, `${context}.sourceId`);
  const version = bigintIn(currentVersion, U64_BITS, `${context}.currentVersion`);
  const stale = (entry: PackageBookEntry) =>
    entry.implied?.sources.some((source) => source.sourceId === id && source.sourceVersion !== version) === true;
  const invalidatedEntryIds = state.entries.filter(stale).map((entry) => entry.entryId);
  return {
    invalidatedEntryIds: Object.freeze(invalidatedEntryIds),
    state: withState(state, { entries: state.entries.filter((entry) => !stale(entry)) }),
  };
}

export function setPackageBookHalted(state: PackageBookState, halted: boolean): PackageBookState {
  return withState(state, { halted: bool(halted, 'setPackageBookHalted.halted') });
}

export function cancelPackageBookEntry(
  state: PackageBookState,
  entryId: Uint8Array | string,
  participantId: string,
  context = 'cancelPackageBookEntry',
): PackageBookState {
  const id = toHex(commitmentHash(entryId, `${context}.entryId`));
  const entry = state.entries.find((candidate) => toHex(candidate.entryId) === id);
  if (entry === undefined) {
    throw new MalformedInputError(`${context}.entryId`, 'entry is not in the book');
  }
  if (entry.participantId !== protocolId(participantId, `${context}.participantId`)) {
    throw new MalformedInputError(`${context}.participantId`, 'only the entry owner may cancel it');
  }
  return withState(state, { entries: state.entries.filter((candidate) => candidate !== entry) });
}

export interface PackageBookAmendment {
  readonly entryId: Uint8Array | string;
  readonly participantId: string;
  readonly quantity?: bigint;
  readonly priceTicks?: bigint;
}

/** A size reduction keeps time priority; any price change or size increase takes a new sequence. */
export function amendPackageBookEntry(
  policy: PackageMatchingPolicy,
  stateInput: PackageBookState,
  amendment: PackageBookAmendment,
  context = 'amendPackageBookEntry',
): PackageBookState {
  const { policy: checked, state } = bookFor(policy, stateInput, context);
  object(amendment, context);
  const id = toHex(commitmentHash(amendment.entryId, `${context}.entryId`));
  const entry = state.entries.find((candidate) => toHex(candidate.entryId) === id);
  if (entry === undefined) {
    throw new MalformedInputError(`${context}.entryId`, 'entry is not in the book');
  }
  if (entry.participantId !== protocolId(amendment.participantId, `${context}.participantId`)) {
    throw new MalformedInputError(`${context}.participantId`, 'only the entry owner may amend it');
  }
  if (entry.source !== 'DIRECT') {
    throw new MalformedInputError(`${context}.entryId`, 'implied liquidity is re-derived, never amended');
  }
  const quantity =
    amendment.quantity === undefined ? entry.quantity : positive(amendment.quantity, U128_BITS, `${context}.quantity`);
  multipleOf(quantity, checked.quantityIncrement, `${context}.quantity`);
  const priceTicks =
    amendment.priceTicks === undefined ? entry.priceTicks : signedTicks(amendment.priceTicks, `${context}.priceTicks`);
  const keepsPriority = priceTicks === entry.priceTicks && quantity <= entry.quantity;
  if (!keepsPriority && crosses(entry.side, priceTicks, state.entries, entry)) {
    throw new MalformedInputError(`${context}.priceTicks`, 'an amendment cannot cross the book');
  }
  const amended: PackageBookEntry = Object.freeze({
    ...entry,
    quantity,
    priceTicks,
    sequence: keepsPriority ? entry.sequence : state.nextSequence,
  });
  return withState(state, {
    entries: state.entries.map((candidate) => (candidate === entry ? amended : candidate)),
    nextSequence: keepsPriority ? state.nextSequence : state.nextSequence + 1n,
  });
}

// ------------------------------------------------------------------ matching

export interface PackageTakerOrderInput {
  readonly orderId: Uint8Array | string;
  readonly executionClassId: string;
  readonly side: PackageBookSide;
  readonly orderType: PackageOrderType;
  readonly timeInForce: PackageTimeInForce;
  readonly limitPriceTicks: bigint;
  readonly quantity: bigint;
  readonly minimumQuantity: bigint;
  readonly participantId: string;
  readonly commonControlGroupId: string;
  readonly expiresAtValue?: bigint;
  readonly settlementLeaseUntilValue?: bigint;
}

interface CanonicalPackageTakerOrder {
  readonly executionClassId: ProtocolId;
  readonly side: PackageBookSide;
  readonly orderType: PackageOrderType;
  readonly timeInForce: PackageTimeInForce;
  readonly limitPriceTicks: bigint;
  readonly quantity: bigint;
  readonly minimumQuantity: bigint;
  readonly participantId: ProtocolId;
  readonly commonControlGroupId: ProtocolId;
  readonly expiresAtValue?: bigint;
  readonly settlementLeaseUntilValue?: bigint;
}

function canonicalPackageTakerOrder(input: PackageTakerOrderInput, context: string): CanonicalPackageTakerOrder {
  object(input, context);
  const expiresAtValue =
    input.expiresAtValue === undefined ? undefined : bigintIn(input.expiresAtValue, U64_BITS, `${context}.expiresAtValue`);
  const settlementLeaseUntilValue = input.settlementLeaseUntilValue === undefined
    ? undefined
    : bigintIn(input.settlementLeaseUntilValue, U64_BITS, `${context}.settlementLeaseUntilValue`);
  if ((input.timeInForce === 'GTC') !== (settlementLeaseUntilValue !== undefined)) {
    throw new MalformedInputError(
      `${context}.settlementLeaseUntilValue`,
      'a bounded settlement lease is required exactly for good-till-cancelled',
    );
  }
  return Object.freeze({
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    side: variant(PACKAGE_BOOK_SIDE, input.side, `${context}.side`),
    orderType: variant(PACKAGE_ORDER_TYPE, input.orderType, `${context}.orderType`),
    timeInForce: variant(PACKAGE_TIME_IN_FORCE, input.timeInForce, `${context}.timeInForce`),
    limitPriceTicks: signedTicks(input.limitPriceTicks, `${context}.limitPriceTicks`),
    quantity: positive(input.quantity, U128_BITS, `${context}.quantity`),
    minimumQuantity: positive(input.minimumQuantity, U128_BITS, `${context}.minimumQuantity`),
    participantId: protocolId(input.participantId, `${context}.participantId`),
    commonControlGroupId: protocolId(input.commonControlGroupId, `${context}.commonControlGroupId`),
    ...(expiresAtValue === undefined ? {} : { expiresAtValue }),
    ...(settlementLeaseUntilValue === undefined ? {} : { settlementLeaseUntilValue }),
  });
}

export function packageTakerOrderBytes(
  input: PackageTakerOrderInput,
  context = 'packageTakerOrder',
): Uint8Array {
  const order = canonicalPackageTakerOrder(input, context);
  return canonicalBytes((writer) => {
    encodeProtocolId(writer, order.executionClassId, `${context}.executionClassId`);
    writer.writeEnum(PACKAGE_BOOK_SIDE, order.side, `${context}.side`);
    writer.writeEnum(PACKAGE_ORDER_TYPE, order.orderType, `${context}.orderType`);
    writer.writeEnum(PACKAGE_TIME_IN_FORCE, order.timeInForce, `${context}.timeInForce`);
    writer.writeI128(order.limitPriceTicks, `${context}.limitPriceTicks`);
    writer.writeU128(order.quantity, `${context}.quantity`);
    writer.writeU128(order.minimumQuantity, `${context}.minimumQuantity`);
    encodeProtocolId(writer, order.participantId, `${context}.participantId`);
    encodeProtocolId(writer, order.commonControlGroupId, `${context}.commonControlGroupId`);
    writer.writeOptional(order.expiresAtValue, (element, value) =>
      element.writeU64(value, `${context}.expiresAtValue`),
    );
    if (order.timeInForce === 'GTC') {
      writer.writeU64(order.settlementLeaseUntilValue as bigint, `${context}.settlementLeaseUntilValue`);
    }
  });
}

export function packageTakerOrderHash(input: PackageTakerOrderInput): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.PACKAGE_TAKER_ORDER, packageTakerOrderBytes(input)),
    'packageTakerOrderHash',
  );
}

export interface PackageBookCancellationInput {
  readonly version: number;
  readonly executionClassId: string;
  readonly entryId: Uint8Array | string;
  readonly participantId: string;
}

export interface PackageBookCancellation {
  readonly version: 1;
  readonly executionClassId: ProtocolId;
  readonly entryId: CommitmentHash;
  readonly participantId: ProtocolId;
}

export function packageBookCancellation(
  input: PackageBookCancellationInput,
  context = 'packageBookCancellation',
): PackageBookCancellation {
  object(input, context);
  if (input.version !== PACKAGE_BOOK_CANCELLATION_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${PACKAGE_BOOK_CANCELLATION_VERSION}`);
  }
  return Object.freeze({
    version: PACKAGE_BOOK_CANCELLATION_VERSION,
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    entryId: commitmentHash(input.entryId, `${context}.entryId`),
    participantId: protocolId(input.participantId, `${context}.participantId`),
  });
}

export function packageBookCancellationBytes(
  input: PackageBookCancellationInput,
  context = 'packageBookCancellation',
): Uint8Array {
  const cancellation = packageBookCancellation(input, context);
  return canonicalBytes((writer) => {
    writer.writeU32(cancellation.version, `${context}.version`);
    encodeProtocolId(writer, cancellation.executionClassId, `${context}.executionClassId`);
    encodeCommitmentHash(writer, cancellation.entryId, `${context}.entryId`);
    encodeProtocolId(writer, cancellation.participantId, `${context}.participantId`);
  });
}

export function packageBookCancellationHash(input: PackageBookCancellationInput): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.PACKAGE_BOOK_CANCELLATION, packageBookCancellationBytes(input)),
    'packageBookCancellationHash',
  );
}

export interface PackageFill {
  readonly fillSequence: bigint;
  readonly makerEntryId: CommitmentHash;
  readonly makerSource: PackageLiquiditySource;
  readonly makerSequence: bigint;
  readonly makerParticipantId: ProtocolId;
  readonly makerCommonControlGroupId: ProtocolId;
  readonly priceTicks: bigint;
  readonly quantity: bigint;
  readonly consumedSourceKeys: readonly CommitmentHash[];
}

export interface PackageAllocation {
  readonly version: 1;
  readonly environment: ProtocolId;
  readonly executionClassId: ProtocolId;
  readonly matchingPolicyHash: ManifestHash;
  readonly takerOrderId: CommitmentHash;
  /** The taker's identity, bound so self-match prevention can be verified from the evidence. */
  readonly takerParticipantId: ProtocolId;
  readonly takerCommonControlGroupId: ProtocolId;
  readonly takerSide: PackageBookSide;
  readonly takerTimeInForce: PackageTimeInForce;
  readonly takerLimitPriceTicks: bigint;
  readonly requestedQuantity: bigint;
  readonly firstFillSequence: bigint;
  readonly fills: readonly PackageFill[];
  readonly restedQuantity: bigint;
  readonly cancelledQuantity: bigint;
  readonly selfMatchCancelledEntryIds: readonly CommitmentHash[];
  readonly invalidatedEntryIds: readonly CommitmentHash[];
  readonly internalMatchedQuantity: bigint;
  readonly externalImpliedQuantity: bigint;
}

export type PackageMatchResult =
  | {
      readonly accepted: true;
      readonly state: PackageBookState;
      readonly allocation: PackageAllocation;
      readonly expiredEntryIds: readonly CommitmentHash[];
    }
  | {
      readonly accepted: false;
      readonly state: PackageBookState;
      readonly rejection: PackageMatchRejection;
    };

function takerCrosses(side: PackageBookSide, limit: bigint, makerPrice: bigint): boolean {
  return side === 'BID' ? makerPrice <= limit : makerPrice >= limit;
}

function crosses(
  side: PackageBookSide,
  priceTicks: bigint,
  entries: readonly PackageBookEntry[],
  except?: PackageBookEntry,
): boolean {
  return entries.some(
    (entry) => entry !== except && entry.side !== side && takerCrosses(side, priceTicks, entry.priceTicks),
  );
}

function priority(takerSide: PackageBookSide) {
  return (left: PackageBookEntry, right: PackageBookEntry): number => {
    if (left.priceTicks !== right.priceTicks) {
      const better = takerSide === 'BID' ? left.priceTicks < right.priceTicks : left.priceTicks > right.priceTicks;
      return better ? -1 : 1;
    }
    if (left.source !== right.source) return left.source === 'DIRECT' ? -1 : 1;
    return left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0;
  };
}

function selfMatch(
  policy: PackageMatchingPolicy,
  participantId: ProtocolId,
  groupId: ProtocolId,
  entry: PackageBookEntry,
): boolean {
  return (
    entry.participantId === participantId || (policy.commonControlAsSelf && entry.commonControlGroupId === groupId)
  );
}

function checkedTaker(policy: PackageMatchingPolicy, input: PackageTakerOrderInput, nowValue: bigint, context: string) {
  object(input, context);
  const executionClassId = protocolId(input.executionClassId, `${context}.executionClassId`);
  if (executionClassId !== policy.executionClassId) {
    throw new MalformedInputError(`${context}.executionClassId`, 'order is outside the book execution class');
  }
  const orderType = variant(PACKAGE_ORDER_TYPE, input.orderType, `${context}.orderType`);
  if (orderType !== 'LIMIT' && orderType !== 'MARKETABLE_LIMIT' && orderType !== 'POST_ONLY') {
    throw new MalformedInputError(`${context}.orderType`, `${orderType} activates outside the package book`);
  }
  const timeInForce = variant(PACKAGE_TIME_IN_FORCE, input.timeInForce, `${context}.timeInForce`);
  const resting = timeInForce === 'GTC' || timeInForce === 'GTD';
  if (orderType === 'POST_ONLY' && !resting) {
    throw new MalformedInputError(`${context}.timeInForce`, 'post-only orders must be able to rest');
  }
  const quantity = positive(input.quantity, U128_BITS, `${context}.quantity`);
  multipleOf(quantity, policy.quantityIncrement, `${context}.quantity`);
  if (quantity < policy.minimumExecutionQuantity) {
    throw new MalformedInputError(`${context}.quantity`, 'quantity is below the policy minimum execution quantity');
  }
  const minimumQuantity = positive(input.minimumQuantity, U128_BITS, `${context}.minimumQuantity`);
  multipleOf(minimumQuantity, policy.quantityIncrement, `${context}.minimumQuantity`);
  if (minimumQuantity < policy.minimumExecutionQuantity || minimumQuantity > quantity) {
    throw new MalformedInputError(`${context}.minimumQuantity`, 'minimum quantity is outside the policy bounds');
  }
  if (timeInForce === 'FOK' && minimumQuantity !== quantity) {
    throw new MalformedInputError(`${context}.minimumQuantity`, 'fill-or-kill requires the full quantity');
  }
  if (resting && minimumQuantity !== policy.minimumExecutionQuantity) {
    throw new MalformedInputError(`${context}.minimumQuantity`, 'a resting order uses the policy minimum');
  }
  const expiresAtValue =
    input.expiresAtValue === undefined ? undefined : bigintIn(input.expiresAtValue, U64_BITS, `${context}.expiresAtValue`);
  if ((timeInForce === 'GTD') !== (expiresAtValue !== undefined)) {
    throw new MalformedInputError(`${context}.expiresAtValue`, 'an expiry is required exactly for good-till-date');
  }
  if (expiresAtValue !== undefined && expiresAtValue <= nowValue) {
    throw new MalformedInputError(`${context}.expiresAtValue`, 'order is already expired');
  }
  const settlementLeaseUntilValue = input.settlementLeaseUntilValue === undefined
    ? undefined
    : bigintIn(input.settlementLeaseUntilValue, U64_BITS, `${context}.settlementLeaseUntilValue`);
  if ((timeInForce === 'GTC') !== (settlementLeaseUntilValue !== undefined)) {
    throw new MalformedInputError(
      `${context}.settlementLeaseUntilValue`,
      'a bounded settlement lease is required exactly for good-till-cancelled',
    );
  }
  if (settlementLeaseUntilValue !== undefined && settlementLeaseUntilValue <= nowValue) {
    throw new MalformedInputError(`${context}.settlementLeaseUntilValue`, 'settlement lease is already expired');
  }
  return {
    orderId: commitmentHash(input.orderId, `${context}.orderId`),
    side: variant(PACKAGE_BOOK_SIDE, input.side, `${context}.side`),
    orderType,
    timeInForce,
    resting,
    limitPriceTicks: signedTicks(input.limitPriceTicks, `${context}.limitPriceTicks`),
    quantity,
    minimumQuantity,
    participantId: protocolId(input.participantId, `${context}.participantId`),
    commonControlGroupId: protocolId(input.commonControlGroupId, `${context}.commonControlGroupId`),
    ...(expiresAtValue === undefined ? {} : { expiresAtValue }),
    ...(settlementLeaseUntilValue === undefined ? {} : { settlementLeaseUntilValue }),
  };
}

export function matchPackageOrder(
  policy: PackageMatchingPolicy,
  stateInput: PackageBookState,
  input: PackageTakerOrderInput,
  nowValue: bigint,
  context = 'matchPackageOrder',
): PackageMatchResult {
  const { policy: checked, state } = bookFor(policy, stateInput, context);
  const now = bigintIn(nowValue, U64_BITS, `${context}.nowValue`);
  const taker = checkedTaker(checked, input, now, `${context}.order`);
  if (state.halted) return { accepted: false, state, rejection: 'HALTED' };

  const expiredEntryIds = state.entries.filter((entry) => !live(entry, now)).map((entry) => entry.entryId);
  let entries = state.entries.filter((entry) => live(entry, now));
  const activeState = expiredEntryIds.length === 0 ? state : withState(state, { entries });
  const reject = (rejection: PackageMatchRejection): PackageMatchResult => ({ accepted: false, state: activeState, rejection });
  if (entries.some((entry) => compareBytes(entry.entryId, taker.orderId) === 0)) return reject('DUPLICATE_ORDER');
  const crossing = entries
    .filter((entry) => entry.side !== taker.side && takerCrosses(taker.side, taker.limitPriceTicks, entry.priceTicks))
    .sort(priority(taker.side));
  if (taker.orderType === 'POST_ONLY' && crossing.length > 0) return reject('POST_ONLY_WOULD_CROSS');

  const consumed = new Set(state.consumedSourceKeys);
  const removed = new Set<PackageBookEntry>();
  const fills: PackageFill[] = [];
  const selfMatchCancelled: CommitmentHash[] = [];
  const invalidated: CommitmentHash[] = [];
  let sequence = state.nextSequence;
  let remaining = taker.quantity;
  let takerCancelled = false;

  for (const maker of crossing) {
    if (remaining === 0n) break;
    if (removed.has(maker)) continue;
    if (selfMatch(checked, taker.participantId, taker.commonControlGroupId, maker)) {
      if (checked.selfMatchPolicy !== 'CANCEL_INCOMING') {
        removed.add(maker);
        selfMatchCancelled.push(maker.entryId);
      }
      if (checked.selfMatchPolicy !== 'CANCEL_RESTING') {
        takerCancelled = true;
        break;
      }
      continue;
    }
    const keys = consumptionKeys(maker);
    if (keys.some((key) => consumed.has(key))) {
      removed.add(maker);
      invalidated.push(maker.entryId);
      continue;
    }
    const quantity = remaining < maker.quantity ? remaining : maker.quantity;
    const perFillMinimum = maker.minimumFillQuantity < maker.quantity ? maker.minimumFillQuantity : maker.quantity;
    if (quantity < perFillMinimum) continue;
    fills.push(
      Object.freeze({
        fillSequence: sequence,
        makerEntryId: maker.entryId,
        makerSource: maker.source,
        makerSequence: maker.sequence,
        makerParticipantId: maker.participantId,
        makerCommonControlGroupId: maker.commonControlGroupId,
        priceTicks: maker.priceTicks,
        quantity,
        consumedSourceKeys: Object.freeze(keys.map((key) => commitmentHash(key))),
      }),
    );
    sequence += 1n;
    remaining -= quantity;
    if (quantity === maker.quantity) {
      removed.add(maker);
    } else {
      entries = entries.map((entry) => (entry === maker ? Object.freeze({ ...entry, quantity: entry.quantity - quantity }) : entry));
    }
    if (maker.implied !== undefined) {
      for (const key of keys) consumed.add(key);
      // Filling consumed these sources, so every sibling built on them is stale.
      const sourceIds = new Set(maker.implied.sources.map((source) => source.sourceId));
      for (const sibling of entries) {
        if (sibling === maker || removed.has(sibling)) continue;
        if (sibling.implied?.sources.some((source) => sourceIds.has(source.sourceId))) {
          removed.add(sibling);
          invalidated.push(sibling.entryId);
        }
      }
    }
  }

  const filled = taker.quantity - remaining;
  if (taker.timeInForce === 'FOK' && filled !== taker.quantity) return reject('FOK_UNFILLABLE');
  if (!taker.resting && filled < taker.minimumQuantity) return reject('MINIMUM_QUANTITY_UNFILLABLE');

  entries = entries.filter((entry) => !removed.has(entry));

  // The remainder rests only when it cannot lock or cross the book.
  const canRest =
    taker.resting && !takerCancelled && remaining > 0n && !crosses(taker.side, taker.limitPriceTicks, entries);
  const restedQuantity = canRest ? remaining : 0n;
  const cancelledQuantity = remaining - restedQuantity;
  if (canRest) {
    entries = [
      ...entries,
      Object.freeze({
        entryId: taker.orderId,
        side: taker.side,
        source: 'DIRECT' as const,
        priceTicks: taker.limitPriceTicks,
        quantity: remaining,
        minimumFillQuantity: checked.minimumExecutionQuantity,
        sequence,
        participantId: taker.participantId,
        commonControlGroupId: taker.commonControlGroupId,
        ...((taker.expiresAtValue ?? taker.settlementLeaseUntilValue) === undefined
          ? {}
          : { expiresAtValue: taker.expiresAtValue ?? taker.settlementLeaseUntilValue }),
      }),
    ];
    sequence += 1n;
  }
  const directFilled = fills.filter((fill) => fill.makerSource === 'DIRECT').reduce((sum, fill) => sum + fill.quantity, 0n);
  const allocation = packageAllocation({
    version: PACKAGE_ALLOCATION_VERSION,
    environment: checked.environment,
    executionClassId: checked.executionClassId,
    matchingPolicyHash: state.matchingPolicyHash,
    takerOrderId: taker.orderId,
    takerParticipantId: taker.participantId,
    takerCommonControlGroupId: taker.commonControlGroupId,
    takerSide: taker.side,
    takerTimeInForce: taker.timeInForce,
    takerLimitPriceTicks: taker.limitPriceTicks,
    requestedQuantity: taker.quantity,
    firstFillSequence: state.nextSequence,
    fills,
    restedQuantity,
    cancelledQuantity,
    selfMatchCancelledEntryIds: selfMatchCancelled,
    invalidatedEntryIds: invalidated,
    internalMatchedQuantity: directFilled,
    externalImpliedQuantity: filled - directFilled,
  });
  verifyPackageAllocation(checked, allocation);
  return {
    accepted: true,
    allocation,
    expiredEntryIds: Object.freeze(expiredEntryIds),
    state: withState(state, { entries, nextSequence: sequence, consumedSourceKeys: [...consumed] }),
  };
}

// ------------------------------------------------------------------ allocation evidence

function freezeFill(fill: PackageFill, context: string): PackageFill {
  object(fill, context);
  if (!Array.isArray(fill.consumedSourceKeys)) {
    throw new MalformedInputError(`${context}.consumedSourceKeys`, 'expected an array');
  }
  return Object.freeze({
    fillSequence: bigintIn(fill.fillSequence, U64_BITS, `${context}.fillSequence`),
    makerEntryId: commitmentHash(fill.makerEntryId, `${context}.makerEntryId`),
    makerSource: variant(PACKAGE_LIQUIDITY_SOURCE, fill.makerSource, `${context}.makerSource`),
    makerSequence: positive(fill.makerSequence, U64_BITS, `${context}.makerSequence`),
    makerParticipantId: protocolId(fill.makerParticipantId, `${context}.makerParticipantId`),
    makerCommonControlGroupId: protocolId(fill.makerCommonControlGroupId, `${context}.makerCommonControlGroupId`),
    priceTicks: signedTicks(fill.priceTicks, `${context}.priceTicks`),
    quantity: positive(fill.quantity, U128_BITS, `${context}.quantity`),
    consumedSourceKeys: Object.freeze(
      fill.consumedSourceKeys.map((key, index) => commitmentHash(key, `${context}.consumedSourceKeys[${index}]`)),
    ),
  });
}

function hashList(values: readonly Hash32[], context: string): readonly CommitmentHash[] {
  if (!Array.isArray(values)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  return Object.freeze(values.map((value, index) => commitmentHash(value, `${context}[${index}]`)));
}

export function packageAllocation(input: PackageAllocation, context = 'packageAllocation'): PackageAllocation {
  object(input, context);
  if (input.version !== PACKAGE_ALLOCATION_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${PACKAGE_ALLOCATION_VERSION}`);
  }
  if (!Array.isArray(input.fills)) {
    throw new MalformedInputError(`${context}.fills`, 'expected an array');
  }
  return Object.freeze({
    version: PACKAGE_ALLOCATION_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    matchingPolicyHash: manifestHash(input.matchingPolicyHash, `${context}.matchingPolicyHash`),
    takerOrderId: commitmentHash(input.takerOrderId, `${context}.takerOrderId`),
    takerParticipantId: protocolId(input.takerParticipantId, `${context}.takerParticipantId`),
    takerCommonControlGroupId: protocolId(input.takerCommonControlGroupId, `${context}.takerCommonControlGroupId`),
    takerSide: variant(PACKAGE_BOOK_SIDE, input.takerSide, `${context}.takerSide`),
    takerTimeInForce: variant(PACKAGE_TIME_IN_FORCE, input.takerTimeInForce, `${context}.takerTimeInForce`),
    takerLimitPriceTicks: signedTicks(input.takerLimitPriceTicks, `${context}.takerLimitPriceTicks`),
    requestedQuantity: positive(input.requestedQuantity, U128_BITS, `${context}.requestedQuantity`),
    firstFillSequence: positive(input.firstFillSequence, U64_BITS, `${context}.firstFillSequence`),
    fills: Object.freeze(input.fills.map((fill, index) => freezeFill(fill, `${context}.fills[${index}]`))),
    restedQuantity: bigintIn(input.restedQuantity, U128_BITS, `${context}.restedQuantity`),
    cancelledQuantity: bigintIn(input.cancelledQuantity, U128_BITS, `${context}.cancelledQuantity`),
    selfMatchCancelledEntryIds: hashList(input.selfMatchCancelledEntryIds, `${context}.selfMatchCancelledEntryIds`),
    invalidatedEntryIds: hashList(input.invalidatedEntryIds, `${context}.invalidatedEntryIds`),
    internalMatchedQuantity: bigintIn(input.internalMatchedQuantity, U128_BITS, `${context}.internalMatchedQuantity`),
    externalImpliedQuantity: bigintIn(input.externalImpliedQuantity, U128_BITS, `${context}.externalImpliedQuantity`),
  });
}

function fail(context: string, detail: string): never {
  throw new MalformedInputError(context, detail);
}

/**
 * Recomputes every conservation, priority, and single-consumption property of an
 * allocation. A hash over a violating allocation proves nothing, so this runs first.
 */
export function verifyPackageAllocation(
  policy: PackageMatchingPolicy,
  input: PackageAllocation,
  context = 'verifyPackageAllocation',
): void {
  const checkedPolicy = packageMatchingPolicy(policy, `${context}.policy`);
  const allocation = packageAllocation(input, `${context}.allocation`);
  if (allocation.executionClassId !== checkedPolicy.executionClassId || allocation.environment !== checkedPolicy.environment) {
    fail(context, 'allocation is outside the policy environment or execution class');
  }
  if (compareBytes(allocation.matchingPolicyHash, packageMatchingPolicyHash(checkedPolicy)) !== 0) {
    fail(context, 'allocation cites another matching policy');
  }
  const increment = checkedPolicy.quantityIncrement;
  let filled = 0n;
  let direct = 0n;
  const makers = new Set<string>();
  const keys = new Set<string>();
  allocation.fills.forEach((fill, index) => {
    const at = `${context}.fills[${index}]`;
    if (fill.fillSequence !== allocation.firstFillSequence + BigInt(index)) fail(at, 'fill sequence is not contiguous');
    multipleOf(fill.quantity, increment, `${at}.quantity`);
    if (!takerCrosses(allocation.takerSide, allocation.takerLimitPriceTicks, fill.priceTicks)) {
      fail(at, 'fill price violates the taker limit');
    }
    if ((fill.makerSource === 'IMPLIED') !== (fill.consumedSourceKeys.length > 0)) {
      fail(at, 'only implied fills consume source reservations');
    }
    const maker = toHex(fill.makerEntryId);
    if (makers.has(maker) || maker === toHex(allocation.takerOrderId)) fail(at, 'maker entry fills more than once');
    if (fill.makerParticipantId === allocation.takerParticipantId ||
        (checkedPolicy.commonControlAsSelf && fill.makerCommonControlGroupId === allocation.takerCommonControlGroupId)) {
      fail(at, 'a fill matches the taker against itself');
    }
    makers.add(maker);
    for (const key of fill.consumedSourceKeys) {
      const hex = toHex(key);
      if (keys.has(hex)) fail(at, 'a source reservation is consumed twice');
      keys.add(hex);
    }
    const previous = allocation.fills[index - 1];
    if (previous !== undefined) {
      const worse =
        allocation.takerSide === 'BID' ? fill.priceTicks < previous.priceTicks : fill.priceTicks > previous.priceTicks;
      if (worse) fail(at, 'fills violate price priority');
      if (fill.priceTicks === previous.priceTicks) {
        if (previous.makerSource === 'IMPLIED' && fill.makerSource === 'DIRECT') {
          fail(at, 'direct liquidity must fill before implied liquidity at one price');
        }
        if (previous.makerSource === fill.makerSource && fill.makerSequence <= previous.makerSequence) {
          fail(at, 'fills violate time priority');
        }
      }
    }
    filled += fill.quantity;
    if (fill.makerSource === 'DIRECT') direct += fill.quantity;
  });
  for (const id of allocation.selfMatchCancelledEntryIds) {
    if (makers.has(toHex(id))) fail(context, 'a self-match cancelled entry also filled');
  }
  multipleOf(allocation.requestedQuantity, increment, `${context}.requestedQuantity`);
  if (filled + allocation.restedQuantity + allocation.cancelledQuantity !== allocation.requestedQuantity) {
    fail(context, 'requested quantity is not conserved across fills, rest, and cancellation');
  }
  if (direct !== allocation.internalMatchedQuantity || filled - direct !== allocation.externalImpliedQuantity) {
    fail(context, 'internal and external quantities do not partition the fills');
  }
  if (allocation.restedQuantity > 0n && allocation.cancelledQuantity > 0n) {
    fail(context, 'a remainder cannot both rest and cancel');
  }
  const resting = allocation.takerTimeInForce === 'GTC' || allocation.takerTimeInForce === 'GTD';
  if (!resting && allocation.restedQuantity > 0n) fail(context, 'an immediate order cannot rest');
  if (allocation.takerTimeInForce === 'FOK' && filled !== allocation.requestedQuantity) {
    fail(context, 'fill-or-kill allocation is incomplete');
  }
}

function encodeFill(writer: CanonicalWriter, fill: PackageFill, context: string): void {
  writer.writeU64(fill.fillSequence, `${context}.fillSequence`);
  encodeCommitmentHash(writer, fill.makerEntryId, `${context}.makerEntryId`);
  writer.writeEnum(PACKAGE_LIQUIDITY_SOURCE, fill.makerSource, `${context}.makerSource`);
  writer.writeU64(fill.makerSequence, `${context}.makerSequence`);
  encodeProtocolId(writer, fill.makerParticipantId, `${context}.makerParticipantId`);
  encodeProtocolId(writer, fill.makerCommonControlGroupId, `${context}.makerCommonControlGroupId`);
  writer.writeI128(fill.priceTicks, `${context}.priceTicks`);
  writer.writeU128(fill.quantity, `${context}.quantity`);
  writer.writeSet(
    fill.consumedSourceKeys,
    (element, key) => encodeCommitmentHash(element, key, `${context}.consumedSourceKeys`),
    `${context}.consumedSourceKeys`,
  );
}

export function packageAllocationBytes(value: PackageAllocation, context = 'packageAllocation'): Uint8Array {
  const allocation = packageAllocation(value, context);
  return canonicalBytes((writer) => {
    writer.writeU32(allocation.version, `${context}.version`);
    encodeProtocolId(writer, allocation.environment, `${context}.environment`);
    encodeProtocolId(writer, allocation.executionClassId, `${context}.executionClassId`);
    encodeManifestHash(writer, allocation.matchingPolicyHash, `${context}.matchingPolicyHash`);
    encodeCommitmentHash(writer, allocation.takerOrderId, `${context}.takerOrderId`);
    encodeProtocolId(writer, allocation.takerParticipantId, `${context}.takerParticipantId`);
    encodeProtocolId(writer, allocation.takerCommonControlGroupId, `${context}.takerCommonControlGroupId`);
    writer.writeEnum(PACKAGE_BOOK_SIDE, allocation.takerSide, `${context}.takerSide`);
    writer.writeEnum(PACKAGE_TIME_IN_FORCE, allocation.takerTimeInForce, `${context}.takerTimeInForce`);
    writer.writeI128(allocation.takerLimitPriceTicks, `${context}.takerLimitPriceTicks`);
    writer.writeU128(allocation.requestedQuantity, `${context}.requestedQuantity`);
    writer.writeU64(allocation.firstFillSequence, `${context}.firstFillSequence`);
    writer.writeArray(allocation.fills, (element, fill) => encodeFill(element, fill, `${context}.fills`), `${context}.fills`);
    writer.writeU128(allocation.restedQuantity, `${context}.restedQuantity`);
    writer.writeU128(allocation.cancelledQuantity, `${context}.cancelledQuantity`);
    writer.writeArray(
      allocation.selfMatchCancelledEntryIds,
      (element, id) => encodeCommitmentHash(element, id, `${context}.selfMatchCancelledEntryIds`),
      `${context}.selfMatchCancelledEntryIds`,
    );
    writer.writeArray(
      allocation.invalidatedEntryIds,
      (element, id) => encodeCommitmentHash(element, id, `${context}.invalidatedEntryIds`),
      `${context}.invalidatedEntryIds`,
    );
    writer.writeU128(allocation.internalMatchedQuantity, `${context}.internalMatchedQuantity`);
    writer.writeU128(allocation.externalImpliedQuantity, `${context}.externalImpliedQuantity`);
  });
}

export function packageAllocationHash(value: PackageAllocation): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.PACKAGE_ALLOCATION, packageAllocationBytes(value)), 'packageAllocationHash');
}

// ------------------------------------------------------------------ depth view

export interface PackageBookLevel {
  readonly priceTicks: bigint;
  readonly directQuantity: bigint;
  readonly impliedQuantity: bigint;
}

/** Aggregated executable depth; direct and implied quantities are never summed together. */
export function packageBookLevels(
  state: PackageBookState,
  side: PackageBookSide,
  nowValue: bigint,
): readonly PackageBookLevel[] {
  variant(PACKAGE_BOOK_SIDE, side, 'packageBookLevels.side');
  const now = bigintIn(nowValue, U64_BITS, 'packageBookLevels.nowValue');
  const levels = new Map<bigint, { direct: bigint; implied: bigint }>();
  for (const entry of state.entries) {
    if (entry.side !== side || !live(entry, now)) continue;
    const level = levels.get(entry.priceTicks) ?? { direct: 0n, implied: 0n };
    if (entry.source === 'DIRECT') level.direct += entry.quantity;
    else level.implied += entry.quantity;
    levels.set(entry.priceTicks, level);
  }
  return Object.freeze(
    [...levels.entries()]
      .sort(([left], [right]) => (side === 'BID' ? (left > right ? -1 : 1) : left < right ? -1 : 1))
      .map(([priceTicks, level]) =>
        Object.freeze({ priceTicks, directQuantity: level.direct, impliedQuantity: level.implied }),
      ),
  );
}
