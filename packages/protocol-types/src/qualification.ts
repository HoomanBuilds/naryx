import { checkedUnsigned } from './arithmetic.js';
import { assertUint8Array, compareBytes } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { enumDiscriminant, EXPIRY_UNIT, type EnumTable, type ExpiryUnit } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { domainRef, encodeDomainRef, encodeProtocolId, protocolId, type DomainRef, type ProtocolId } from './primitives.js';

const U64_BITS = 64;
const U128_BITS = 128;
const MAX_EVIDENCE_REFS = 32;
const MAX_TRIGGER_CODES = 16;
const MAX_REVIEWERS = 8;
const MAX_SIGNATURE_BYTES = 128;

export const QUALIFICATION_RECORD_VERSION = 1;

/** Qualification is kept separately for every one of these objects. */
export const QUALIFICATION_OBJECT_TYPE = Object.freeze({
  INSTRUMENT: 1,
  VENUE: 2,
  ADAPTER: 3,
  TEMPLATE: 4,
  SETTLEMENT_CLASS: 5,
  DELIVERY_PATH: 6,
  SOLVER: 7,
  EXECUTION_CLASS: 8,
} as const);
export type QualificationObjectType = keyof typeof QUALIFICATION_OBJECT_TYPE;

/** Ordered by severity: a higher discriminant permits strictly less. */
export const QUALIFICATION_STATE = Object.freeze({
  ACTIVE: 1,
  RESTRICTED: 2,
  REDUCE_ONLY: 3,
  EXIT_ONLY: 4,
  QUARANTINED: 5,
} as const);
export type QualificationState = keyof typeof QUALIFICATION_STATE;

/** An automated monitor may only tighten; a reviewed activation may also loosen. */
export const QUALIFICATION_AUTHORITY_KIND = Object.freeze({ AUTOMATED_MONITOR: 1, REVIEWED_ACTIVATION: 2 } as const);
export type QualificationAuthorityKind = keyof typeof QUALIFICATION_AUTHORITY_KIND;

export interface QualificationLimits {
  readonly maximumNotionalQuoteAtoms: bigint;
  readonly maximumOpenPackages: number;
}

export interface QualificationRecordInput {
  readonly recordVersion: number;
  readonly environment: string;
  readonly objectType: QualificationObjectType;
  readonly objectId: string;
  readonly domain: DomainRef;
  readonly state: QualificationState;
  readonly effectiveLimits: QualificationLimits;
  readonly evidenceRefs: readonly (Uint8Array | string)[];
  readonly triggerCodes: readonly string[];
  readonly timeUnit: ExpiryUnit;
  readonly observedAtValue: bigint;
  readonly effectiveAtValue: bigint;
  readonly expiresAtValue?: bigint;
  readonly previousRecordHash?: Uint8Array | string;
  readonly authorityKind: QualificationAuthorityKind;
  /** The key id of the authority that signs the record hash. */
  readonly authority: string;
  /** Distinct reviewers; required, at least two, for a reviewed activation, and absent otherwise. */
  readonly reviewerIds: readonly string[];
  /** The authority's signature over `qualificationRecordHash`; excluded from the hash. */
  readonly signature: Uint8Array;
}

export interface QualificationRecord {
  readonly recordVersion: number;
  readonly environment: ProtocolId;
  readonly objectType: QualificationObjectType;
  readonly objectId: ProtocolId;
  readonly domain: DomainRef;
  readonly state: QualificationState;
  readonly effectiveLimits: QualificationLimits;
  readonly evidenceRefs: readonly CommitmentHash[];
  readonly triggerCodes: readonly ProtocolId[];
  readonly timeUnit: ExpiryUnit;
  readonly observedAtValue: bigint;
  readonly effectiveAtValue: bigint;
  readonly expiresAtValue?: bigint;
  readonly previousRecordHash?: CommitmentHash;
  readonly authorityKind: QualificationAuthorityKind;
  readonly authority: ProtocolId;
  readonly reviewerIds: readonly ProtocolId[];
  readonly signature: Uint8Array;
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function sortedIds(values: readonly string[], maximum: number, context: string): readonly ProtocolId[] {
  if (!Array.isArray(values) || values.length > maximum) throw new MalformedInputError(context, `expected at most ${maximum} entries`);
  const ids = values.map((value, index) => protocolId(value, `${context}[${index}]`)).sort();
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1] === ids[index]) throw new DuplicateElementError(context, 'entries repeat');
  }
  return Object.freeze(ids);
}

function sortedHashes(values: readonly (Uint8Array | string)[], context: string): readonly CommitmentHash[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_EVIDENCE_REFS) {
    throw new MalformedInputError(context, `expected 1 to ${MAX_EVIDENCE_REFS} evidence references`);
  }
  const hashes = values.map((value, index) => commitmentHash(value, `${context}[${index}]`)).sort(compareBytes);
  for (let index = 1; index < hashes.length; index += 1) {
    if (compareBytes(hashes[index - 1] as Uint8Array, hashes[index] as Uint8Array) === 0) throw new DuplicateElementError(context, 'evidence repeats');
  }
  return Object.freeze(hashes);
}

export function qualificationSeverity(state: QualificationState): number {
  return enumDiscriminant(QUALIFICATION_STATE, state, 'qualificationSeverity.state');
}

export function qualificationRecord(input: QualificationRecordInput, context = 'qualificationRecord'): QualificationRecord {
  object(input, context);
  if (input.recordVersion !== QUALIFICATION_RECORD_VERSION) {
    throw new MalformedInputError(`${context}.recordVersion`, `version must equal ${QUALIFICATION_RECORD_VERSION}`);
  }
  object(input.domain, `${context}.domain`);
  object(input.effectiveLimits, `${context}.effectiveLimits`);
  const maximumOpenPackages = input.effectiveLimits.maximumOpenPackages;
  if (!Number.isSafeInteger(maximumOpenPackages) || maximumOpenPackages < 0 || maximumOpenPackages > 0xffff_ffff) {
    throw new MalformedInputError(`${context}.effectiveLimits.maximumOpenPackages`, 'expected a u32');
  }
  const observedAtValue = unsigned(input.observedAtValue, U64_BITS, `${context}.observedAtValue`);
  const effectiveAtValue = unsigned(input.effectiveAtValue, U64_BITS, `${context}.effectiveAtValue`);
  if (effectiveAtValue < observedAtValue) throw new MalformedInputError(`${context}.effectiveAtValue`, 'a record cannot take effect before it was observed');
  const expiresAtValue = input.expiresAtValue === undefined ? undefined : unsigned(input.expiresAtValue, U64_BITS, `${context}.expiresAtValue`);
  if (expiresAtValue !== undefined && expiresAtValue <= effectiveAtValue) throw new MalformedInputError(`${context}.expiresAtValue`, 'a record must expire after it takes effect');
  const authorityKind = variant(QUALIFICATION_AUTHORITY_KIND, input.authorityKind, `${context}.authorityKind`);
  const reviewerIds = sortedIds(input.reviewerIds, MAX_REVIEWERS, `${context}.reviewerIds`);
  if (authorityKind === 'REVIEWED_ACTIVATION' ? reviewerIds.length < 2 : reviewerIds.length !== 0) {
    throw new MalformedInputError(`${context}.reviewerIds`, 'a reviewed activation needs two distinct reviewers, and a monitor names none');
  }
  assertUint8Array(input.signature, `${context}.signature`);
  if (input.signature.length > MAX_SIGNATURE_BYTES) throw new MalformedInputError(`${context}.signature`, 'signature is too long');
  return Object.freeze({
    recordVersion: QUALIFICATION_RECORD_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    objectType: variant(QUALIFICATION_OBJECT_TYPE, input.objectType, `${context}.objectType`),
    objectId: protocolId(input.objectId, `${context}.objectId`),
    domain: domainRef(input.domain.domainId, input.domain.domainManifestVersion, input.domain.domainManifestHash, `${context}.domain`),
    state: variant(QUALIFICATION_STATE, input.state, `${context}.state`),
    effectiveLimits: Object.freeze({
      maximumNotionalQuoteAtoms: unsigned(input.effectiveLimits.maximumNotionalQuoteAtoms, U128_BITS, `${context}.effectiveLimits.maximumNotionalQuoteAtoms`),
      maximumOpenPackages,
    }),
    evidenceRefs: sortedHashes(input.evidenceRefs, `${context}.evidenceRefs`),
    triggerCodes: sortedIds(input.triggerCodes, MAX_TRIGGER_CODES, `${context}.triggerCodes`),
    timeUnit: variant(EXPIRY_UNIT, input.timeUnit, `${context}.timeUnit`),
    observedAtValue,
    effectiveAtValue,
    ...(expiresAtValue === undefined ? {} : { expiresAtValue }),
    ...(input.previousRecordHash === undefined ? {} : { previousRecordHash: commitmentHash(input.previousRecordHash, `${context}.previousRecordHash`) }),
    authorityKind,
    authority: protocolId(input.authority, `${context}.authority`),
    reviewerIds,
    signature: Uint8Array.from(input.signature),
  });
}

/** Every record field except the signature, which signs this hash. */
export function qualificationRecordBytes(input: QualificationRecordInput): Uint8Array {
  const record = qualificationRecord(input);
  return canonicalBytes((writer) => {
    writer.writeU32(record.recordVersion, 'recordVersion');
    encodeProtocolId(writer, record.environment, 'environment');
    writer.writeEnum(QUALIFICATION_OBJECT_TYPE, record.objectType, 'objectType');
    encodeProtocolId(writer, record.objectId, 'objectId');
    encodeDomainRef(writer, record.domain);
    writer.writeEnum(QUALIFICATION_STATE, record.state, 'state');
    writer.writeU128(record.effectiveLimits.maximumNotionalQuoteAtoms, 'maximumNotionalQuoteAtoms');
    writer.writeU32(record.effectiveLimits.maximumOpenPackages, 'maximumOpenPackages');
    writer.writeArray(record.evidenceRefs, (inner, value) => encodeCommitmentHash(inner, value, 'evidenceRef'), 'evidenceRefs');
    writer.writeArray(record.triggerCodes, (inner, value) => encodeProtocolId(inner, value, 'triggerCode'), 'triggerCodes');
    writer.writeEnum(EXPIRY_UNIT, record.timeUnit, 'timeUnit');
    writer.writeU64(record.observedAtValue, 'observedAtValue');
    writer.writeU64(record.effectiveAtValue, 'effectiveAtValue');
    writer.writeOptional(record.expiresAtValue, (inner, value) => inner.writeU64(value, 'expiresAtValue'), 'expiresAtValue');
    writer.writeOptional(record.previousRecordHash, (inner, value) => encodeCommitmentHash(inner, value, 'previousRecordHash'), 'previousRecordHash');
    writer.writeEnum(QUALIFICATION_AUTHORITY_KIND, record.authorityKind, 'authorityKind');
    encodeProtocolId(writer, record.authority, 'authority');
    writer.writeArray(record.reviewerIds, (inner, value) => encodeProtocolId(inner, value, 'reviewerId'), 'reviewerIds');
  });
}

export function qualificationRecordHash(input: QualificationRecordInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.QUALIFICATION_RECORD, qualificationRecordBytes(input)), 'qualificationRecordHash');
}

export type QualificationAppendRejection =
  | 'OBJECT_MISMATCH'
  | 'CHAIN_BROKEN'
  | 'TIME_REGRESSED'
  | 'MONITOR_CANNOT_LOOSEN'
  | 'ACTIVATION_TOO_EARLY';

/** True when `next` permits more than `previous`: a lower severity or any higher limit. */
function loosens(previous: QualificationRecord, next: QualificationRecord): boolean {
  return (
    qualificationSeverity(next.state) < qualificationSeverity(previous.state) ||
    next.effectiveLimits.maximumNotionalQuoteAtoms > previous.effectiveLimits.maximumNotionalQuoteAtoms ||
    next.effectiveLimits.maximumOpenPackages > previous.effectiveLimits.maximumOpenPackages
  );
}

/** The index of the record governing at `at`: the latest appended record already in effect. */
function governingIndex(records: readonly QualificationRecord[], at: bigint): number | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if ((records[index] as QualificationRecord).effectiveAtValue <= at) return index;
  }
  return undefined;
}

/**
 * Checks that `next` may be appended to an object's history. Records chain by hash and are
 * observed in order. The latest appended record in effect governs, so `next` governs from its
 * effective time onward over the record governing then and every record still pending after it.
 * An automated monitor may keep or tighten against all of those at once, even ahead of a pending
 * reviewed change; anything that loosens against any of them, and any record taking effect before
 * any record governs, must be a reviewed activation taking effect no earlier than
 * `minimumActivationDelay` after it was observed.
 */
export function checkQualificationAppend(
  history: readonly QualificationRecordInput[],
  nextInput: QualificationRecordInput,
  minimumActivationDelay: bigint,
): { readonly accepted: true; readonly recordHash: CommitmentHash } | { readonly accepted: false; readonly reason: QualificationAppendRejection } {
  if (!Array.isArray(history)) throw new MalformedInputError('checkQualificationAppend.history', 'expected an array');
  const delay = unsigned(minimumActivationDelay, U64_BITS, 'checkQualificationAppend.minimumActivationDelay');
  const next = qualificationRecord(nextInput, 'checkQualificationAppend.next');
  const reject = (reason: QualificationAppendRejection) => Object.freeze({ accepted: false as const, reason });
  const reviewedInTime = next.authorityKind === 'REVIEWED_ACTIVATION' && next.effectiveAtValue - next.observedAtValue >= delay;
  const requireReview = () => {
    if (next.authorityKind !== 'REVIEWED_ACTIVATION') return reject('MONITOR_CANNOT_LOOSEN');
    if (!reviewedInTime) return reject('ACTIVATION_TOO_EARLY');
    return undefined;
  };
  const accept = () => Object.freeze({ accepted: true as const, recordHash: qualificationRecordHash(next) });
  if (history.length === 0) {
    if (next.previousRecordHash !== undefined) return reject('CHAIN_BROKEN');
    return requireReview() ?? accept();
  }
  const records = history.map((entry) => qualificationRecord(entry, 'checkQualificationAppend.history'));
  const last = records[records.length - 1] as QualificationRecord;
  if (
    last.environment !== next.environment ||
    last.objectType !== next.objectType ||
    last.objectId !== next.objectId ||
    last.domain.domainId !== next.domain.domainId ||
    last.timeUnit !== next.timeUnit
  ) {
    return reject('OBJECT_MISMATCH');
  }
  if (next.previousRecordHash === undefined || compareBytes(next.previousRecordHash, qualificationRecordHash(last)) !== 0) return reject('CHAIN_BROKEN');
  if (next.observedAtValue < last.observedAtValue) return reject('TIME_REGRESSED');
  const governing = governingIndex(records, next.effectiveAtValue);
  // Before any record governs, the object is unqualified, and anything at all loosens that.
  if (governing === undefined) return requireReview() ?? accept();
  if (records.slice(governing).some((record) => loosens(record, next))) return requireReview() ?? accept();
  return accept();
}

/** Verifies a whole history from its first record; returns the index of the first bad record, if any. */
export function verifyQualificationHistory(
  history: readonly QualificationRecordInput[],
  minimumActivationDelay: bigint,
): { readonly valid: true } | { readonly valid: false; readonly index: number; readonly reason: QualificationAppendRejection } {
  if (!Array.isArray(history)) throw new MalformedInputError('verifyQualificationHistory.history', 'expected an array');
  for (let index = 0; index < history.length; index += 1) {
    const verdict = checkQualificationAppend(history.slice(0, index), history[index] as QualificationRecordInput, minimumActivationDelay);
    if (!verdict.accepted) return Object.freeze({ valid: false as const, index, reason: verdict.reason });
  }
  return Object.freeze({ valid: true as const });
}

export type QualificationUnavailable = 'NO_RECORD' | 'NOT_YET_EFFECTIVE' | 'EXPIRED';

/**
 * The record that governs an object at `atValue`: the latest appended record already in effect.
 * Append rules make it at least as strict as every earlier record it overrides unless a reviewed
 * activation loosened it. When that record has expired, nothing governs and execution must treat
 * the object as unqualified.
 */
export function currentQualification(
  history: readonly QualificationRecordInput[],
  atValue: bigint,
): { readonly current: QualificationRecord; readonly index: number } | { readonly unavailable: QualificationUnavailable } {
  if (!Array.isArray(history)) throw new MalformedInputError('currentQualification.history', 'expected an array');
  const at = unsigned(atValue, U64_BITS, 'currentQualification.atValue');
  if (history.length === 0) return Object.freeze({ unavailable: 'NO_RECORD' as const });
  const records = history.map((entry) => qualificationRecord(entry, 'currentQualification.history'));
  const index = governingIndex(records, at);
  if (index === undefined) return Object.freeze({ unavailable: 'NOT_YET_EFFECTIVE' as const });
  const record = records[index] as QualificationRecord;
  if (record.expiresAtValue !== undefined && at >= record.expiresAtValue) return Object.freeze({ unavailable: 'EXPIRED' as const });
  return Object.freeze({ current: record, index });
}
