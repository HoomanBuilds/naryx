import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  PACKAGE_ACTION,
  QUANTITY_POLICY_CLASS,
  SETTLEMENT_CLASS,
  type EnumTable,
  type PackageAction,
  type QuantityPolicyClass,
  type SettlementClass,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import {
  assetAmount,
  domainRef,
  encodeAssetAmount,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type AssetAmount,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';
import { encodeAscii } from './text.js';

export const EVIDENCE_MANIFEST_VERSION = 1;
export const TERMINAL_OUTCOME_VERSION = 1;
export const PACKAGE_RECEIPT_VERSION = 1;
/** Exit outcome formula version 1: exitQuoteOutcome = externalQuoteBalanceDelta + venueWithdrawableQuoteDelta. */
export const EXIT_OUTCOME_SCHEMA_VERSION = 1;
export const EVIDENCE_MANIFEST_MAX_ENTRIES = 4_096;
export const RECEIPT_MAX_REFERENCES = 1_024;
export const CONTROLLER_SIGNATURE_BYTES = 64;

const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;

// ------------------------------------------------------------------ canonical terminal states

/**
 * The one canonical vocabulary for a package's terminal execution outcome. Lifecycle, keeper,
 * indexer, API, and SDK code map onto these values rather than defining their own.
 */
export const TERMINAL_STATE = Object.freeze({
  FINALIZED_COMPLETE: 1,
  FINALIZED_BOUNDED: 2,
  RECOVERED_COMPLETE: 3,
  RECOVERED_BOUNDED: 4,
  RECOVERED_FLAT: 5,
  MANUAL_INTERVENTION: 6,
  NO_EFFECT: 7,
} as const);
export type TerminalState = keyof typeof TERMINAL_STATE;

/** Execution states that are never terminal: the package stays locked while in any of them. */
export const NONTERMINAL_EXECUTION_STATE = Object.freeze({
  SUBMISSION_PENDING: 1,
  SUBMISSION_UNKNOWN: 2,
  RECONCILING_UNKNOWN: 3,
  RECOVERING: 4,
} as const);
export type NonterminalExecutionState = keyof typeof NONTERMINAL_EXECUTION_STATE;

const SUCCESSFUL_STATES: ReadonlySet<TerminalState> = new Set([
  'FINALIZED_COMPLETE',
  'FINALIZED_BOUNDED',
  'RECOVERED_COMPLETE',
  'RECOVERED_BOUNDED',
]);
const RECOVERED_STATES: ReadonlySet<TerminalState> = new Set(['RECOVERED_COMPLETE', 'RECOVERED_BOUNDED', 'RECOVERED_FLAT']);
const BOUNDED_STATES: ReadonlySet<TerminalState> = new Set(['FINALIZED_BOUNDED', 'RECOVERED_BOUNDED']);
const ZERO_RESIDUAL_STATES: ReadonlySet<TerminalState> = new Set([
  'FINALIZED_COMPLETE',
  'RECOVERED_COMPLETE',
  'RECOVERED_FLAT',
  'NO_EFFECT',
]);

/** Successful outcomes MUST link exactly one successful package receipt. */
export function requiresSuccessfulReceipt(state: TerminalState): boolean {
  enumDiscriminant(TERMINAL_STATE, state, 'terminalState');
  return SUCCESSFUL_STATES.has(state);
}

/** Any outcome that entered recovery is protocol-fee-free and earns no new execution fee. */
export function isRecoveredTerminalState(state: TerminalState): boolean {
  enumDiscriminant(TERMINAL_STATE, state, 'terminalState');
  return RECOVERED_STATES.has(state);
}

/** Bounded outcomes visibly retain a residual and carry both residual valuations. */
export function isBoundedTerminalState(state: TerminalState): boolean {
  enumDiscriminant(TERMINAL_STATE, state, 'terminalState');
  return BOUNDED_STATES.has(state);
}

// ------------------------------------------------------------------ shared validation

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function list<T>(value: readonly T[], context: string, maximum: number, minimum = 0): readonly T[] {
  if (!Array.isArray(value)) throw new MalformedInputError(context, 'expected an array');
  if (value.length > maximum) throw new MalformedInputError(context, `more than ${maximum} entries`);
  if (value.length < minimum) throw new MalformedInputError(context, `fewer than ${minimum} entries`);
  return value;
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function signed(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedSigned(value, I128_BITS, context);
}

function u32(value: number, context: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new MalformedInputError(context, 'expected a u32');
  return value;
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function optional<T, R>(value: T | undefined, context: string, check: (present: T, at: string) => R): R | undefined {
  if (value === undefined) return undefined;
  if (value === null) throw new MalformedInputError(context, 'null is not a canonical absent value');
  return check(value, context);
}

function uniqueIds(values: readonly string[], context: string, minimum = 0): readonly ProtocolId[] {
  const checked = list(values, context, RECEIPT_MAX_REFERENCES, minimum).map((value, index) => protocolId(value, `${context}[${index}]`));
  const seen = new Set<string>();
  for (const value of checked) {
    if (seen.has(value)) throw new DuplicateElementError(context, `${value} appears twice`);
    seen.add(value);
  }
  return Object.freeze(checked);
}

function hashList(values: readonly (Uint8Array | string)[], context: string, minimum = 0): readonly CommitmentHash[] {
  const checked = list(values, context, RECEIPT_MAX_REFERENCES, minimum).map((value, index) => commitmentHash(value, `${context}[${index}]`));
  const sorted = [...checked].sort(compareBytes);
  for (let index = 1; index < sorted.length; index += 1) {
    if (compareBytes(sorted[index - 1] as Uint8Array, sorted[index] as Uint8Array) === 0) {
      throw new DuplicateElementError(context, 'a reference appears twice');
    }
  }
  return Object.freeze(checked);
}

function compareIds(left: string, right: string): number {
  return compareBytes(encodeAscii(left), encodeAscii(right));
}

function encodeOptionalHash(writer: CanonicalWriter, value: CommitmentHash | undefined, context: string): void {
  writer.writeOptional(value, (element, present) => encodeCommitmentHash(element, present, context), context);
}

function encodeIds(writer: CanonicalWriter, values: readonly ProtocolId[], context: string): void {
  writer.writeArray(values, (element, value) => encodeProtocolId(element, value, context), context);
}

function encodeHashes(writer: CanonicalWriter, values: readonly CommitmentHash[], context: string): void {
  writer.writeArray(values, (element, value) => encodeCommitmentHash(element, value, context), context);
}

function checkedDomain(value: DomainRef, context: string): DomainRef {
  object(value, context);
  return domainRef(value.domainId, value.domainManifestVersion, value.domainManifestHash, context);
}

// ------------------------------------------------------------------ per-field evidence

/** Authenticity of one receipt or outcome field. There is deliberately no scalar shortcut. */
export const FIELD_EVIDENCE_GRADE = Object.freeze({
  CONTROLLER_ATTESTED: 1,
  VENUE_API_CORROBORATED: 2,
  CONSENSUS_VERIFIED: 3,
} as const);
export type FieldEvidenceGrade = keyof typeof FIELD_EVIDENCE_GRADE;

export interface FieldEvidenceInput {
  readonly fieldId: string;
  readonly grade: FieldEvidenceGrade;
  readonly onchainEnforced: boolean;
}

export interface FieldEvidence {
  readonly fieldId: ProtocolId;
  readonly grade: FieldEvidenceGrade;
  readonly onchainEnforced: boolean;
}

function fieldEvidence(
  values: readonly FieldEvidenceInput[],
  required: readonly string[],
  context: string,
): readonly FieldEvidence[] {
  const checked = list(values, context, 256, 1).map((entry, index) => {
    const at = `${context}[${index}]`;
    object(entry, at);
    if (typeof entry.onchainEnforced !== 'boolean') throw new MalformedInputError(`${at}.onchainEnforced`, 'expected a boolean');
    return Object.freeze({
      fieldId: protocolId(entry.fieldId, `${at}.fieldId`),
      grade: variant(FIELD_EVIDENCE_GRADE, entry.grade, `${at}.grade`),
      onchainEnforced: entry.onchainEnforced,
    });
  });
  for (let index = 1; index < checked.length; index += 1) {
    const order = compareIds((checked[index - 1] as FieldEvidence).fieldId, (checked[index] as FieldEvidence).fieldId);
    if (order === 0) throw new DuplicateElementError(context, `${(checked[index] as FieldEvidence).fieldId} appears twice`);
    if (order > 0) throw new MalformedInputError(context, 'field evidence must be sorted by canonical fieldId bytes');
  }
  const present = new Set(checked.map((entry) => entry.fieldId as string));
  for (const field of required) {
    if (!present.has(field)) throw new MalformedInputError(context, `missing evidence for required field ${field}`);
  }
  return Object.freeze(checked);
}

// Grades and enforcement serialize as two parallel arrays keyed by fieldId, as specified.
function encodeFieldEvidence(writer: CanonicalWriter, values: readonly FieldEvidence[]): void {
  writer.writeArray(values, (element, entry) => {
    encodeProtocolId(element, entry.fieldId, 'fieldId');
    element.writeEnum(FIELD_EVIDENCE_GRADE, entry.grade, 'grade');
  }, 'fieldEvidenceGrades');
  writer.writeArray(values, (element, entry) => {
    encodeProtocolId(element, entry.fieldId, 'fieldId');
    element.writeBool(entry.onchainEnforced, 'onchainEnforced');
  }, 'fieldOnchainEnforced');
}

// ------------------------------------------------------------------ evidence manifest

export const EVIDENCE_ENTRY_KIND = Object.freeze({
  ATTEMPT: 1,
  OUTBOUND_ACTION: 2,
  RESPONSE_RECEIVED: 3,
  RESPONSE_ABSENT: 4,
  ORDER: 5,
  CANCELLATION: 6,
  FILL: 7,
  RECOVERY_ACTION: 8,
  CHAIN_TRANSACTION: 9,
} as const);
export type EvidenceEntryKind = keyof typeof EVIDENCE_ENTRY_KIND;

export interface EvidenceEntryInput {
  /** Position in the canonical order; entries are numbered 0, 1, 2, ... with no gaps. */
  readonly sequence: bigint;
  readonly kind: EvidenceEntryKind;
  readonly attemptId: string;
  /** Venue or chain identifier: an action hash, order id, fill hash, or transaction id. */
  readonly reference: string;
  /** Hash of the exact stored evidence bytes. */
  readonly contentHash: Uint8Array | string;
  readonly observedAtValue: bigint;
}

export interface EvidenceManifestInput {
  readonly manifestVersion: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly orderHash: Uint8Array | string;
  readonly entries: readonly EvidenceEntryInput[];
}

export interface EvidenceEntry {
  readonly sequence: bigint;
  readonly kind: EvidenceEntryKind;
  readonly attemptId: ProtocolId;
  readonly reference: ProtocolId;
  readonly contentHash: CommitmentHash;
  readonly observedAtValue: bigint;
}

export interface EvidenceManifest {
  readonly manifestVersion: number;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly orderHash: CommitmentHash;
  readonly entries: readonly EvidenceEntry[];
}

/**
 * Validates and freezes a versioned evidence manifest. Every entry names its attempt, the first
 * entry of each attempt is that attempt, the same evidence is never listed twice, and response
 * loss is recorded as an explicit absent marker rather than silently omitted.
 */
export function evidenceManifest(input: EvidenceManifestInput): EvidenceManifest {
  const context = 'evidenceManifest';
  object(input, context);
  if (input.manifestVersion !== EVIDENCE_MANIFEST_VERSION) {
    throw new MalformedInputError(`${context}.manifestVersion`, `version must equal ${EVIDENCE_MANIFEST_VERSION}`);
  }
  const entries = list(input.entries, `${context}.entries`, EVIDENCE_MANIFEST_MAX_ENTRIES, 1).map((entry, index) => {
    const at = `${context}.entries[${index}]`;
    object(entry, at);
    const sequence = unsigned(entry.sequence, U64_BITS, `${at}.sequence`);
    if (sequence !== BigInt(index)) throw new MalformedInputError(`${at}.sequence`, `expected sequence ${index}`);
    return Object.freeze({
      sequence,
      kind: variant(EVIDENCE_ENTRY_KIND, entry.kind, `${at}.kind`),
      attemptId: protocolId(entry.attemptId, `${at}.attemptId`),
      reference: protocolId(entry.reference, `${at}.reference`),
      contentHash: commitmentHash(entry.contentHash, `${at}.contentHash`),
      observedAtValue: unsigned(entry.observedAtValue, U64_BITS, `${at}.observedAtValue`),
    });
  });
  const attempts = new Set<string>();
  const references = new Set<string>();
  const responded = new Map<string, EvidenceEntryKind>();
  for (const [index, entry] of entries.entries()) {
    const at = `${context}.entries[${index}]`;
    if (entry.kind === 'ATTEMPT') {
      if (attempts.has(entry.attemptId)) throw new DuplicateElementError(at, `attempt ${entry.attemptId} is declared twice`);
      if (entry.reference !== entry.attemptId) throw new MalformedInputError(`${at}.reference`, 'an attempt entry references its own attempt id');
      attempts.add(entry.attemptId);
    } else if (!attempts.has(entry.attemptId)) {
      throw new MalformedInputError(`${at}.attemptId`, 'evidence precedes the attempt it belongs to');
    }
    const key = `${entry.kind}:${entry.reference}`;
    if (references.has(key)) throw new DuplicateElementError(at, `${key} is listed twice`);
    references.add(key);
    if (entry.kind === 'RESPONSE_RECEIVED' || entry.kind === 'RESPONSE_ABSENT') {
      const prior = responded.get(entry.attemptId);
      if (prior !== undefined && prior !== entry.kind) {
        throw new MalformedInputError(at, 'an attempt cannot have both a received and an absent response marker');
      }
      responded.set(entry.attemptId, entry.kind);
    }
    const previous = entries[index - 1];
    if (previous !== undefined && entry.observedAtValue < previous.observedAtValue) {
      throw new MalformedInputError(`${at}.observedAtValue`, 'evidence must be ordered by observation time');
    }
  }
  return Object.freeze({
    manifestVersion: EVIDENCE_MANIFEST_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    domain: checkedDomain(input.domain, `${context}.domain`),
    orderHash: commitmentHash(input.orderHash, `${context}.orderHash`),
    entries: Object.freeze(entries),
  });
}

export function evidenceManifestBytes(input: EvidenceManifestInput): Uint8Array {
  const manifest = evidenceManifest(input);
  return canonicalBytes((writer) => {
    writer.writeU32(manifest.manifestVersion, 'manifestVersion');
    encodeProtocolId(writer, manifest.environment, 'environment');
    encodeDomainRef(writer, manifest.domain);
    encodeCommitmentHash(writer, manifest.orderHash, 'orderHash');
    writer.writeArray(manifest.entries, (element, entry) => {
      element.writeU64(entry.sequence, 'sequence');
      element.writeEnum(EVIDENCE_ENTRY_KIND, entry.kind, 'kind');
      encodeProtocolId(element, entry.attemptId, 'attemptId');
      encodeProtocolId(element, entry.reference, 'reference');
      encodeCommitmentHash(element, entry.contentHash, 'contentHash');
      element.writeU64(entry.observedAtValue, 'observedAtValue');
    }, 'entries');
  });
}

export function evidenceManifestHash(input: EvidenceManifestInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.EVIDENCE_MANIFEST, evidenceManifestBytes(input)), 'evidenceManifestHash');
}

// ------------------------------------------------------------------ terminal outcome record

export const AVAILABILITY = Object.freeze({
  NOT_APPLICABLE: 1,
  PRESENT: 2,
  ABSENT: 3,
} as const);
export type Availability = keyof typeof AVAILABILITY;

export const RESPONSE_AVAILABILITY = Object.freeze({
  RECEIVED: 1,
  ABSENT: 2,
} as const);
export type ResponseAvailability = keyof typeof RESPONSE_AVAILABILITY;

export const RESIDUAL_VALUATION_APPLICABILITY = Object.freeze({
  NOT_APPLICABLE: 1,
  HYPERLIQUID_EXACT: 2,
  HYPERLIQUID_BOUNDED: 3,
} as const);
export type ResidualValuationApplicability = keyof typeof RESIDUAL_VALUATION_APPLICABILITY;

export const OUTCOME_ISSUER_KIND = Object.freeze({
  /** An offchain controller that signs the outcome hash. */
  CONTROLLER: 1,
  /** A finalized program or contract event binds the outcome as consensus evidence. */
  CONSENSUS_EVENT: 2,
} as const);
export type OutcomeIssuerKind = keyof typeof OUTCOME_ISSUER_KIND;

export interface ResidualValueInput {
  readonly availability: Availability;
  readonly quoteValue?: bigint;
  readonly evidenceHash?: Uint8Array | string;
  readonly absenceReason?: string;
}

export interface ResidualValue {
  readonly availability: Availability;
  readonly quoteValue?: bigint;
  readonly evidenceHash?: CommitmentHash;
  readonly absenceReason?: ProtocolId;
}

export interface TerminalOutcomeInput {
  readonly outcomeVersion: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly orderHash: Uint8Array | string;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly templateRegistryReference: Uint8Array | string;
  readonly solverCapabilityManifestHash?: Uint8Array | string;
  readonly terminalState: TerminalState;
  readonly attemptIds: readonly string[];
  readonly responseAvailability: ResponseAvailability;
  /** Hash of the initial batch response bytes, present only when a response was received. */
  readonly initialBatchResponseHash?: Uint8Array | string;
  readonly responseAbsenceReason?: string;
  readonly authoritativeEvidenceRefs: readonly (Uint8Array | string)[];
  readonly evidenceManifestHash: Uint8Array | string;
  readonly benchmarkManifestHash?: Uint8Array | string;
  readonly residualValuationApplicability: ResidualValuationApplicability;
  readonly intermediateResidualBaseQuantity?: bigint;
  readonly terminalResidualBaseQuantity?: bigint;
  readonly authorizedResidualValue: ResidualValueInput;
  readonly terminalResidualMark: ResidualValueInput;
  readonly successfulReceiptHash?: Uint8Array | string;
  readonly issuerKind: OutcomeIssuerKind;
  readonly issuer: string;
  readonly fieldEvidence: readonly FieldEvidenceInput[];
  /** Controller signature over the outcome hash; excluded from the hash itself. */
  readonly controllerSignature?: Uint8Array;
  readonly timestampValue: bigint;
}

export interface TerminalOutcomeRecord {
  readonly outcomeVersion: number;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly orderHash: CommitmentHash;
  readonly packageTemplateManifestHash: ManifestHash;
  readonly templateRegistryReference: CommitmentHash;
  readonly solverCapabilityManifestHash?: ManifestHash;
  readonly terminalState: TerminalState;
  readonly attemptIds: readonly ProtocolId[];
  readonly responseAvailability: ResponseAvailability;
  readonly initialBatchResponseHash?: CommitmentHash;
  readonly responseAbsenceReason?: ProtocolId;
  readonly authoritativeEvidenceRefs: readonly CommitmentHash[];
  readonly evidenceManifestHash: CommitmentHash;
  readonly benchmarkManifestHash?: CommitmentHash;
  readonly residualValuationApplicability: ResidualValuationApplicability;
  readonly intermediateResidualBaseQuantity?: bigint;
  readonly terminalResidualBaseQuantity?: bigint;
  readonly authorizedResidualValue: ResidualValue;
  readonly terminalResidualMark: ResidualValue;
  readonly successfulReceiptHash?: CommitmentHash;
  readonly issuerKind: OutcomeIssuerKind;
  readonly issuer: ProtocolId;
  readonly fieldEvidence: readonly FieldEvidence[];
  readonly controllerSignature?: Uint8Array;
  readonly timestampValue: bigint;
}

export const OUTCOME_REQUIRED_FIELDS: readonly string[] = Object.freeze(['evidenceManifestHash', 'orderHash', 'terminalState']);

function residualValue(input: ResidualValueInput, context: string, signedValue: boolean): ResidualValue {
  object(input, context);
  const availability = variant(AVAILABILITY, input.availability, `${context}.availability`);
  const quoteValue = optional(input.quoteValue, `${context}.quoteValue`, (value, at) =>
    signedValue ? signed(value, at) : unsigned(value, U128_BITS, at));
  const evidenceHash = optional(input.evidenceHash, `${context}.evidenceHash`, (value, at) => commitmentHash(value, at));
  const absenceReason = optional(input.absenceReason, `${context}.absenceReason`, (value, at) => protocolId(value, at));
  const present = availability === 'PRESENT';
  if ((quoteValue !== undefined) !== present || (evidenceHash !== undefined) !== present) {
    throw new MalformedInputError(context, 'value and evidence are present exactly when availability is PRESENT');
  }
  if ((absenceReason !== undefined) !== (availability === 'ABSENT')) {
    throw new MalformedInputError(context, 'an absence reason is present exactly when availability is ABSENT');
  }
  return Object.freeze({
    availability,
    ...(quoteValue === undefined ? {} : { quoteValue }),
    ...(evidenceHash === undefined ? {} : { evidenceHash }),
    ...(absenceReason === undefined ? {} : { absenceReason }),
  });
}

/**
 * Validates a terminal outcome against the schema rules: the successful receipt link is present
 * exactly for successful states, response loss is explicit and never fabricated, residual fields
 * follow the valuation applicability, and offchain issuers sign.
 */
export function terminalOutcomeRecord(input: TerminalOutcomeInput): TerminalOutcomeRecord {
  const context = 'terminalOutcome';
  object(input, context);
  if (input.outcomeVersion !== TERMINAL_OUTCOME_VERSION) {
    throw new MalformedInputError(`${context}.outcomeVersion`, `version must equal ${TERMINAL_OUTCOME_VERSION}`);
  }
  const terminalState = variant(TERMINAL_STATE, input.terminalState, `${context}.terminalState`);
  const responseAvailability = variant(RESPONSE_AVAILABILITY, input.responseAvailability, `${context}.responseAvailability`);
  const initialBatchResponseHash = optional(input.initialBatchResponseHash, `${context}.initialBatchResponseHash`, (value, at) => commitmentHash(value, at));
  const responseAbsenceReason = optional(input.responseAbsenceReason, `${context}.responseAbsenceReason`, (value, at) => protocolId(value, at));
  if (responseAvailability === 'RECEIVED' && (initialBatchResponseHash === undefined || responseAbsenceReason !== undefined)) {
    throw new MalformedInputError(`${context}.responseAvailability`, 'a received response carries its hash and no absence reason');
  }
  if (responseAvailability === 'ABSENT' && (initialBatchResponseHash !== undefined || responseAbsenceReason === undefined)) {
    throw new MalformedInputError(`${context}.responseAvailability`, 'an absent response carries a reason and never a fabricated response');
  }

  const applicability = variant(RESIDUAL_VALUATION_APPLICABILITY, input.residualValuationApplicability, `${context}.residualValuationApplicability`);
  const intermediate = optional(input.intermediateResidualBaseQuantity, `${context}.intermediateResidualBaseQuantity`, (value, at) => unsigned(value, U128_BITS, at));
  const terminalResidual = optional(input.terminalResidualBaseQuantity, `${context}.terminalResidualBaseQuantity`, (value, at) => unsigned(value, U128_BITS, at));
  const authorizedResidualValue = residualValue(input.authorizedResidualValue, `${context}.authorizedResidualValue`, false);
  const terminalResidualMark = residualValue(input.terminalResidualMark, `${context}.terminalResidualMark`, true);

  if (applicability === 'NOT_APPLICABLE') {
    if (intermediate !== undefined || terminalResidual !== undefined) {
      throw new MalformedInputError(context, 'atomic outcomes omit residual quantities');
    }
    if (authorizedResidualValue.availability !== 'NOT_APPLICABLE' || terminalResidualMark.availability !== 'NOT_APPLICABLE') {
      throw new MalformedInputError(context, 'atomic outcomes set both residual availability tags to NOT_APPLICABLE');
    }
    if (BOUNDED_STATES.has(terminalState)) throw new MalformedInputError(`${context}.terminalState`, 'a bounded outcome needs bounded residual valuation');
  } else {
    if (intermediate === undefined || terminalResidual === undefined) {
      throw new MalformedInputError(context, 'every Hyperliquid terminal state carries intermediate and terminal residual quantities');
    }
    if (ZERO_RESIDUAL_STATES.has(terminalState)) {
      if (terminalResidual !== 0n) throw new MalformedInputError(`${context}.terminalResidualBaseQuantity`, `${terminalState} requires a canonical zero residual`);
      if (authorizedResidualValue.availability !== 'NOT_APPLICABLE') {
        throw new MalformedInputError(`${context}.authorizedResidualValue`, `${terminalState} has no authorized residual value`);
      }
      if (terminalResidualMark.availability !== 'PRESENT' || terminalResidualMark.quoteValue !== 0n) {
        throw new MalformedInputError(`${context}.terminalResidualMark`, `${terminalState} carries a present canonical zero mark`);
      }
    }
    if (BOUNDED_STATES.has(terminalState)) {
      if (applicability !== 'HYPERLIQUID_BOUNDED') throw new MalformedInputError(`${context}.residualValuationApplicability`, 'bounded success uses bounded valuation');
      if (authorizedResidualValue.availability !== 'PRESENT' || terminalResidualMark.availability !== 'PRESENT') {
        throw new MalformedInputError(context, 'bounded success requires both the authorized value and the current executable mark');
      }
    }
  }

  const successfulReceiptHash = optional(input.successfulReceiptHash, `${context}.successfulReceiptHash`, (value, at) => commitmentHash(value, at));
  if ((successfulReceiptHash !== undefined) !== SUCCESSFUL_STATES.has(terminalState)) {
    throw new MalformedInputError(`${context}.successfulReceiptHash`, `${terminalState} ${SUCCESSFUL_STATES.has(terminalState) ? 'must link' : 'must not link'} a successful receipt`);
  }

  const issuerKind = variant(OUTCOME_ISSUER_KIND, input.issuerKind, `${context}.issuerKind`);
  const signature = input.controllerSignature;
  if (issuerKind === 'CONTROLLER') {
    if (!(signature instanceof Uint8Array) || signature.length !== CONTROLLER_SIGNATURE_BYTES) {
      throw new MalformedInputError(`${context}.controllerSignature`, `an offchain outcome carries a ${CONTROLLER_SIGNATURE_BYTES}-byte controller signature`);
    }
  } else {
    if (signature !== undefined) throw new MalformedInputError(`${context}.controllerSignature`, 'a consensus-bound outcome carries no controller signature');
    if (terminalState !== 'FINALIZED_COMPLETE' && terminalState !== 'NO_EFFECT') {
      throw new MalformedInputError(`${context}.issuerKind`, 'only finalized atomic outcomes may bind consensus evidence instead of a signature');
    }
    if (applicability !== 'NOT_APPLICABLE') throw new MalformedInputError(`${context}.issuerKind`, 'consensus-bound outcomes are atomic');
  }

  const solverCapabilityManifestHash = optional(input.solverCapabilityManifestHash, `${context}.solverCapabilityManifestHash`, (value, at) => manifestHash(value, at));
  const benchmarkManifestHash = optional(input.benchmarkManifestHash, `${context}.benchmarkManifestHash`, (value, at) => commitmentHash(value, at));
  return Object.freeze({
    outcomeVersion: TERMINAL_OUTCOME_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    domain: checkedDomain(input.domain, `${context}.domain`),
    orderHash: commitmentHash(input.orderHash, `${context}.orderHash`),
    packageTemplateManifestHash: manifestHash(input.packageTemplateManifestHash, `${context}.packageTemplateManifestHash`),
    templateRegistryReference: commitmentHash(input.templateRegistryReference, `${context}.templateRegistryReference`),
    ...(solverCapabilityManifestHash === undefined ? {} : { solverCapabilityManifestHash }),
    terminalState,
    attemptIds: uniqueIds(input.attemptIds, `${context}.attemptIds`, 1),
    responseAvailability,
    ...(initialBatchResponseHash === undefined ? {} : { initialBatchResponseHash }),
    ...(responseAbsenceReason === undefined ? {} : { responseAbsenceReason }),
    authoritativeEvidenceRefs: hashList(input.authoritativeEvidenceRefs, `${context}.authoritativeEvidenceRefs`, 1),
    evidenceManifestHash: commitmentHash(input.evidenceManifestHash, `${context}.evidenceManifestHash`),
    ...(benchmarkManifestHash === undefined ? {} : { benchmarkManifestHash }),
    residualValuationApplicability: applicability,
    ...(intermediate === undefined ? {} : { intermediateResidualBaseQuantity: intermediate }),
    ...(terminalResidual === undefined ? {} : { terminalResidualBaseQuantity: terminalResidual }),
    authorizedResidualValue,
    terminalResidualMark,
    ...(successfulReceiptHash === undefined ? {} : { successfulReceiptHash }),
    issuerKind,
    issuer: protocolId(input.issuer, `${context}.issuer`),
    fieldEvidence: fieldEvidence(input.fieldEvidence, OUTCOME_REQUIRED_FIELDS, `${context}.fieldEvidence`),
    ...(signature === undefined ? {} : { controllerSignature: Uint8Array.from(signature) }),
    timestampValue: unsigned(input.timestampValue, U64_BITS, `${context}.timestampValue`),
  });
}

function encodeResidualValue(writer: CanonicalWriter, value: ResidualValue, signedValue: boolean, context: string): void {
  writer.writeEnum(AVAILABILITY, value.availability, `${context}.availability`);
  writer.writeOptional(value.quoteValue, (element, present) => {
    if (signedValue) element.writeI128(present, `${context}.quoteValue`);
    else element.writeU128(present, `${context}.quoteValue`);
  }, `${context}.quoteValue`);
  encodeOptionalHash(writer, value.evidenceHash, `${context}.evidenceHash`);
  writer.writeOptional(value.absenceReason, (element, present) => encodeProtocolId(element, present, `${context}.absenceReason`), `${context}.absenceReason`);
}

/** Canonical bytes of the outcome excluding the controller signature. */
export function terminalOutcomeBytes(input: TerminalOutcomeInput): Uint8Array {
  const record = terminalOutcomeRecord(input);
  return canonicalBytes((writer) => {
    writer.writeU32(record.outcomeVersion, 'outcomeVersion');
    encodeProtocolId(writer, record.environment, 'environment');
    encodeDomainRef(writer, record.domain);
    encodeCommitmentHash(writer, record.orderHash, 'orderHash');
    encodeManifestHash(writer, record.packageTemplateManifestHash, 'packageTemplateManifestHash');
    encodeCommitmentHash(writer, record.templateRegistryReference, 'templateRegistryReference');
    writer.writeOptional(record.solverCapabilityManifestHash, (element, value) => encodeManifestHash(element, value, 'solverCapabilityManifestHash'), 'solverCapabilityManifestHash');
    writer.writeEnum(TERMINAL_STATE, record.terminalState, 'terminalState');
    encodeIds(writer, record.attemptIds, 'attemptIds');
    encodeOptionalHash(writer, record.initialBatchResponseHash, 'initialBatchResponseHash');
    writer.writeEnum(RESPONSE_AVAILABILITY, record.responseAvailability, 'responseAvailability');
    writer.writeOptional(record.responseAbsenceReason, (element, value) => encodeProtocolId(element, value, 'responseAbsenceReason'), 'responseAbsenceReason');
    encodeHashes(writer, record.authoritativeEvidenceRefs, 'authoritativeEvidenceRefs');
    encodeCommitmentHash(writer, record.evidenceManifestHash, 'evidenceManifestHash');
    encodeOptionalHash(writer, record.benchmarkManifestHash, 'benchmarkManifestHash');
    writer.writeEnum(RESIDUAL_VALUATION_APPLICABILITY, record.residualValuationApplicability, 'residualValuationApplicability');
    writer.writeOptional(record.intermediateResidualBaseQuantity, (element, value) => element.writeU128(value, 'intermediateResidualBaseQuantity'), 'intermediateResidualBaseQuantity');
    writer.writeOptional(record.terminalResidualBaseQuantity, (element, value) => element.writeU128(value, 'terminalResidualBaseQuantity'), 'terminalResidualBaseQuantity');
    encodeResidualValue(writer, record.authorizedResidualValue, false, 'authorizedResidualValue');
    encodeResidualValue(writer, record.terminalResidualMark, true, 'terminalResidualMark');
    encodeOptionalHash(writer, record.successfulReceiptHash, 'successfulReceiptHash');
    writer.writeEnum(OUTCOME_ISSUER_KIND, record.issuerKind, 'issuerKind');
    encodeProtocolId(writer, record.issuer, 'issuer');
    encodeFieldEvidence(writer, record.fieldEvidence);
    writer.writeU64(record.timestampValue, 'timestamp');
  });
}

/** outcomeHash = sha256("CON/v1/outcome" || canonicalEncode(record excluding controllerSignature)). */
export function terminalOutcomeHash(input: TerminalOutcomeInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.OUTCOME, terminalOutcomeBytes(input)), 'outcomeHash');
}

// ------------------------------------------------------------------ package receipt

export const PERP_PRICE_ENFORCEMENT = Object.freeze({
  CONTRACT_ENFORCED: 1,
  EVENT_ONLY: 2,
  UNAVAILABLE: 3,
} as const);
export type PerpPriceEnforcement = keyof typeof PERP_PRICE_ENFORCEMENT;

export const FINALITY_STATUS = Object.freeze({
  FINALIZED: 1,
  VENUE_COMMITTED: 2,
} as const);
export type FinalityStatus = keyof typeof FINALITY_STATUS;

export interface AuthoritativeStateRefInput {
  /** Block, slot, or committed-action identifier. */
  readonly locator: string;
  readonly accountKey: string;
  readonly component: string;
  readonly value: bigint;
  readonly unit: string;
  readonly evidenceHash: Uint8Array | string;
}

export interface AuthoritativeStateRef {
  readonly locator: ProtocolId;
  readonly accountKey: ProtocolId;
  readonly component: ProtocolId;
  readonly value: bigint;
  readonly unit: ProtocolId;
  readonly evidenceHash: CommitmentHash;
}

export interface PackageReceiptInput {
  readonly receiptVersion: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly attemptIds: readonly string[];
  readonly orderedActionEvidenceRefs: readonly (Uint8Array | string)[];
  readonly orderedOrderEvidenceRefs: readonly (Uint8Array | string)[];
  readonly orderedFillEvidenceRefs: readonly (Uint8Array | string)[];
  readonly transactionIds: readonly string[];
  readonly evidenceManifestHash: Uint8Array | string;
  readonly benchmarkManifestHash?: Uint8Array | string;
  readonly orderHash: Uint8Array | string;
  readonly quoteHash: Uint8Array | string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly templateRegistryReference: Uint8Array | string;
  readonly solverCapabilityManifestHash: Uint8Array | string;
  readonly packageMarketId: string;
  readonly owner: string;
  readonly solver: string;
  readonly action: PackageAction;
  readonly settlementClass: SettlementClass;
  readonly terminalState: TerminalState;
  readonly quantity: bigint;
  readonly grossSpotQuantity?: bigint;
  readonly netSpotDelta?: bigint;
  readonly baseAssetFees?: bigint;
  readonly quantityPolicy?: QuantityPolicyClass;
  readonly terminalResidualBaseQuantity?: bigint;
  readonly authorizedReferenceResidualQuoteValue?: bigint;
  readonly terminalMarkedResidualQuoteValue?: bigint;
  readonly spotVenue: string;
  readonly perpVenue: string;
  readonly spotExecutionPrice: bigint;
  readonly perpExecutionPrice?: bigint;
  readonly perpPriceEnforcement: PerpPriceEnforcement;
  readonly packageSpread?: bigint;
  readonly spotQuoteDelta: bigint;
  readonly externalQuoteBalanceDelta: bigint;
  readonly venueWithdrawableQuoteDelta: bigint;
  readonly exitQuoteOutcome?: bigint;
  readonly exitOutcomeSchemaVersion: number;
  readonly authoritativePreStateRefs: readonly AuthoritativeStateRefInput[];
  readonly authoritativePostStateRefs: readonly AuthoritativeStateRefInput[];
  readonly perpPositionDelta: bigint;
  readonly marginDelta: bigint;
  readonly matchedPackageNotional: bigint;
  readonly grossLegNotional: bigint;
  readonly rawFillFeesByAsset: readonly AssetAmount[];
  readonly builderFeesByAsset: readonly AssetAmount[];
  readonly normalizedVenueFeesByAsset: readonly AssetAmount[];
  readonly protocolFee: AssetAmount;
  readonly solverFee: AssetAmount;
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Uint8Array | string;
  readonly maxResidualBaseQuantityObserved: bigint;
  readonly authorizedResidualValuationEvidence?: Uint8Array | string;
  readonly terminalResidualMarkEvidence?: Uint8Array | string;
  readonly timeUnhedgedMs: bigint;
  readonly recoveryCostByAsset: readonly AssetAmount[];
  /** Prepaid execution cost that recovery did not consume, refunded to the owner. */
  readonly recoveryRefundByAsset: readonly AssetAmount[];
  readonly priorityFee: AssetAmount;
  readonly finalityStatus: FinalityStatus;
  readonly fieldEvidence: readonly FieldEvidenceInput[];
  readonly timestampValue: bigint;
}

type Checked<T> = { readonly [K in keyof T]: T[K] };

export interface PackageReceipt extends Checked<Omit<PackageReceiptInput,
  | 'environment' | 'domain' | 'attemptIds' | 'orderedActionEvidenceRefs' | 'orderedOrderEvidenceRefs' | 'orderedFillEvidenceRefs'
  | 'transactionIds' | 'evidenceManifestHash' | 'benchmarkManifestHash' | 'orderHash' | 'quoteHash' | 'templateId'
  | 'packageTemplateManifestHash' | 'templateRegistryReference' | 'solverCapabilityManifestHash' | 'packageMarketId' | 'owner'
  | 'solver' | 'spotVenue' | 'perpVenue' | 'authoritativePreStateRefs' | 'authoritativePostStateRefs' | 'feePolicyManifestHash'
  | 'authorizedResidualValuationEvidence' | 'terminalResidualMarkEvidence' | 'fieldEvidence'>> {
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly attemptIds: readonly ProtocolId[];
  readonly orderedActionEvidenceRefs: readonly CommitmentHash[];
  readonly orderedOrderEvidenceRefs: readonly CommitmentHash[];
  readonly orderedFillEvidenceRefs: readonly CommitmentHash[];
  readonly transactionIds: readonly ProtocolId[];
  readonly evidenceManifestHash: CommitmentHash;
  readonly benchmarkManifestHash?: CommitmentHash;
  readonly orderHash: CommitmentHash;
  readonly quoteHash: CommitmentHash;
  readonly templateId: ProtocolId;
  readonly packageTemplateManifestHash: ManifestHash;
  readonly templateRegistryReference: CommitmentHash;
  readonly solverCapabilityManifestHash: ManifestHash;
  readonly packageMarketId: ProtocolId;
  readonly owner: ProtocolId;
  readonly solver: ProtocolId;
  readonly spotVenue: ProtocolId;
  readonly perpVenue: ProtocolId;
  readonly authoritativePreStateRefs: readonly AuthoritativeStateRef[];
  readonly authoritativePostStateRefs: readonly AuthoritativeStateRef[];
  readonly feePolicyManifestHash: ManifestHash;
  readonly authorizedResidualValuationEvidence?: CommitmentHash;
  readonly terminalResidualMarkEvidence?: CommitmentHash;
  readonly fieldEvidence: readonly FieldEvidence[];
}

export const RECEIPT_REQUIRED_FIELDS: readonly string[] = Object.freeze([
  'evidenceManifestHash',
  'orderHash',
  'protocolFee',
  'quantity',
  'quoteHash',
  'solverFee',
  'spotExecutionPrice',
  'terminalState',
]);

function stateRefs(values: readonly AuthoritativeStateRefInput[], context: string): readonly AuthoritativeStateRef[] {
  const refs = list(values, context, RECEIPT_MAX_REFERENCES, 1).map((ref, index) => {
    const at = `${context}[${index}]`;
    object(ref, at);
    return Object.freeze({
      locator: protocolId(ref.locator, `${at}.locator`),
      accountKey: protocolId(ref.accountKey, `${at}.accountKey`),
      component: protocolId(ref.component, `${at}.component`),
      value: signed(ref.value, `${at}.value`),
      unit: protocolId(ref.unit, `${at}.unit`),
      evidenceHash: commitmentHash(ref.evidenceHash, `${at}.evidenceHash`),
    });
  });
  const keys = new Set<string>();
  for (const [index, ref] of refs.entries()) {
    const key = `${ref.locator}|${ref.accountKey}|${ref.component}`;
    if (keys.has(key)) throw new DuplicateElementError(`${context}[${index}]`, 'a state component is referenced twice');
    keys.add(key);
  }
  return Object.freeze(refs);
}

/** Fee vectors are keyed by asset, sorted by canonical asset id bytes, one entry per asset. */
function assetVector(values: readonly AssetAmount[], context: string, nonNegative: boolean): readonly AssetAmount[] {
  const checked = list(values, context, 64).map((value, index) => {
    const at = `${context}[${index}]`;
    object(value, at);
    const amount = assetAmount(value.asset, value.atoms, at);
    if (nonNegative && amount.atoms < 0n) throw new MalformedInputError(`${at}.atoms`, 'expected a non-negative amount');
    return amount;
  });
  for (let index = 1; index < checked.length; index += 1) {
    const order = compareIds((checked[index - 1] as AssetAmount).asset.assetId, (checked[index] as AssetAmount).asset.assetId);
    if (order === 0) throw new DuplicateElementError(context, `${(checked[index] as AssetAmount).asset.assetId} appears twice`);
    if (order > 0) throw new MalformedInputError(context, 'asset amounts must be sorted by canonical asset id bytes');
  }
  return Object.freeze(checked);
}

function nonNegativeAmount(value: AssetAmount, context: string): AssetAmount {
  object(value, context);
  const amount = assetAmount(value.asset, value.atoms, context);
  if (amount.atoms < 0n) throw new MalformedInputError(`${context}.atoms`, 'expected a non-negative amount');
  return amount;
}

/**
 * Validates a successful package receipt. Only successful terminal states produce one; the fee
 * vectors reconcile exactly; recovery is protocol-fee-free; bounded receipts carry both residual
 * valuations; and the exit outcome equals its versioned formula.
 */
export function packageReceipt(input: PackageReceiptInput): PackageReceipt {
  const context = 'packageReceipt';
  object(input, context);
  if (input.receiptVersion !== PACKAGE_RECEIPT_VERSION) {
    throw new MalformedInputError(`${context}.receiptVersion`, `version must equal ${PACKAGE_RECEIPT_VERSION}`);
  }
  const terminalState = variant(TERMINAL_STATE, input.terminalState, `${context}.terminalState`);
  if (!SUCCESSFUL_STATES.has(terminalState)) {
    throw new MalformedInputError(`${context}.terminalState`, `${terminalState} is not a successful outcome and produces no package receipt`);
  }
  const action = variant(PACKAGE_ACTION, input.action, `${context}.action`);
  const settlementClass = variant(SETTLEMENT_CLASS, input.settlementClass, `${context}.settlementClass`);
  const attemptIds = uniqueIds(input.attemptIds, `${context}.attemptIds`, 1);
  const transactionIds = uniqueIds(input.transactionIds, `${context}.transactionIds`, 1);
  if (settlementClass === 'ATOMIC_POSTCONDITION' && (attemptIds.length !== 1 || transactionIds.length !== 1)) {
    throw new MalformedInputError(context, 'atomic receipts use one-element attempt and transaction arrays');
  }

  const optionalU128 = (value: bigint | undefined, name: string) => optional(value, `${context}.${name}`, (present, at) => unsigned(present, U128_BITS, at));
  const optionalI128 = (value: bigint | undefined, name: string) => optional(value, `${context}.${name}`, (present, at) => signed(present, at));
  const optionalHash = (value: Uint8Array | string | undefined, name: string) => optional(value, `${context}.${name}`, (present, at) => commitmentHash(present, at));

  const terminalResidualBaseQuantity = optionalU128(input.terminalResidualBaseQuantity, 'terminalResidualBaseQuantity');
  const authorizedReferenceResidualQuoteValue = optionalU128(input.authorizedReferenceResidualQuoteValue, 'authorizedReferenceResidualQuoteValue');
  const terminalMarkedResidualQuoteValue = optionalI128(input.terminalMarkedResidualQuoteValue, 'terminalMarkedResidualQuoteValue');
  const authorizedResidualValuationEvidence = optionalHash(input.authorizedResidualValuationEvidence, 'authorizedResidualValuationEvidence');
  const terminalResidualMarkEvidence = optionalHash(input.terminalResidualMarkEvidence, 'terminalResidualMarkEvidence');
  const residualFields = [terminalResidualBaseQuantity, authorizedReferenceResidualQuoteValue, terminalMarkedResidualQuoteValue, authorizedResidualValuationEvidence, terminalResidualMarkEvidence];
  if (BOUNDED_STATES.has(terminalState)) {
    if (residualFields.some((field) => field === undefined)) {
      throw new MalformedInputError(context, 'bounded receipts carry the residual quantity, both residual values, and their evidence');
    }
  } else if (residualFields.some((field) => field !== undefined) && terminalResidualBaseQuantity !== 0n) {
    throw new MalformedInputError(context, 'complete receipts carry no residual');
  }

  const perpPriceEnforcement = variant(PERP_PRICE_ENFORCEMENT, input.perpPriceEnforcement, `${context}.perpPriceEnforcement`);
  const perpExecutionPrice = optionalU128(input.perpExecutionPrice, 'perpExecutionPrice');
  const packageSpread = optionalI128(input.packageSpread, 'packageSpread');
  if (perpPriceEnforcement === 'UNAVAILABLE' && (perpExecutionPrice !== undefined || packageSpread !== undefined)) {
    throw new MalformedInputError(`${context}.perpExecutionPrice`, 'without exact close-price evidence the perp price and package spread are absent');
  }
  if (perpPriceEnforcement !== 'UNAVAILABLE' && perpExecutionPrice === undefined) {
    throw new MalformedInputError(`${context}.perpExecutionPrice`, `${perpPriceEnforcement} requires the perp execution price`);
  }

  const exitOutcomeSchemaVersion = u32(input.exitOutcomeSchemaVersion, `${context}.exitOutcomeSchemaVersion`);
  if (exitOutcomeSchemaVersion !== EXIT_OUTCOME_SCHEMA_VERSION) {
    throw new MalformedInputError(`${context}.exitOutcomeSchemaVersion`, `version must equal ${EXIT_OUTCOME_SCHEMA_VERSION}`);
  }
  const externalQuoteBalanceDelta = signed(input.externalQuoteBalanceDelta, `${context}.externalQuoteBalanceDelta`);
  const venueWithdrawableQuoteDelta = signed(input.venueWithdrawableQuoteDelta, `${context}.venueWithdrawableQuoteDelta`);
  const exitQuoteOutcome = optionalI128(input.exitQuoteOutcome, 'exitQuoteOutcome');
  if (action === 'EXIT') {
    if (exitQuoteOutcome === undefined) throw new MalformedInputError(`${context}.exitQuoteOutcome`, 'an exit receipt reports its quote outcome');
    if (exitQuoteOutcome !== externalQuoteBalanceDelta + venueWithdrawableQuoteDelta) {
      throw new MalformedInputError(`${context}.exitQuoteOutcome`, 'the exit outcome must equal external plus venue-withdrawable quote deltas');
    }
  } else if (exitQuoteOutcome !== undefined) {
    throw new MalformedInputError(`${context}.exitQuoteOutcome`, 'an entry receipt has no exit outcome');
  }

  const rawFillFeesByAsset = assetVector(input.rawFillFeesByAsset, `${context}.rawFillFeesByAsset`, false);
  const builderFeesByAsset = assetVector(input.builderFeesByAsset, `${context}.builderFeesByAsset`, false);
  const normalizedVenueFeesByAsset = assetVector(input.normalizedVenueFeesByAsset, `${context}.normalizedVenueFeesByAsset`, false);
  const raw = new Map(rawFillFeesByAsset.map((fee) => [fee.asset.assetId as string, fee.atoms]));
  const builder = new Map(builderFeesByAsset.map((fee) => [fee.asset.assetId as string, fee.atoms]));
  for (const asset of builder.keys()) {
    if (!raw.has(asset)) throw new MalformedInputError(`${context}.builderFeesByAsset`, `builder fee in ${asset} is not a subset of raw fill fees`);
  }
  if (normalizedVenueFeesByAsset.length !== rawFillFeesByAsset.length) {
    throw new MalformedInputError(`${context}.normalizedVenueFeesByAsset`, 'normalized fees list every raw fee asset');
  }
  for (const fee of normalizedVenueFeesByAsset) {
    const rawAtoms = raw.get(fee.asset.assetId);
    if (rawAtoms === undefined || fee.atoms !== rawAtoms - (builder.get(fee.asset.assetId) ?? 0n)) {
      throw new MalformedInputError(`${context}.normalizedVenueFeesByAsset`, `normalized ${fee.asset.assetId} fee must equal raw minus builder`);
    }
  }
  const baseAssetFees = optionalU128(input.baseAssetFees, 'baseAssetFees');

  const protocolFee = nonNegativeAmount(input.protocolFee, `${context}.protocolFee`);
  const solverFee = nonNegativeAmount(input.solverFee, `${context}.solverFee`);
  if (RECOVERED_STATES.has(terminalState) && protocolFee.atoms !== 0n) {
    throw new MalformedInputError(`${context}.protocolFee`, 'a package that entered recovery is protocol-fee-free');
  }

  return Object.freeze({
    receiptVersion: PACKAGE_RECEIPT_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    domain: checkedDomain(input.domain, `${context}.domain`),
    attemptIds,
    orderedActionEvidenceRefs: hashList(input.orderedActionEvidenceRefs, `${context}.orderedActionEvidenceRefs`, 1),
    orderedOrderEvidenceRefs: hashList(input.orderedOrderEvidenceRefs, `${context}.orderedOrderEvidenceRefs`),
    orderedFillEvidenceRefs: hashList(input.orderedFillEvidenceRefs, `${context}.orderedFillEvidenceRefs`),
    transactionIds,
    evidenceManifestHash: commitmentHash(input.evidenceManifestHash, `${context}.evidenceManifestHash`),
    ...(input.benchmarkManifestHash === undefined ? {} : { benchmarkManifestHash: commitmentHash(input.benchmarkManifestHash, `${context}.benchmarkManifestHash`) }),
    orderHash: commitmentHash(input.orderHash, `${context}.orderHash`),
    quoteHash: commitmentHash(input.quoteHash, `${context}.quoteHash`),
    templateId: protocolId(input.templateId, `${context}.templateId`),
    templateVersion: u32(input.templateVersion, `${context}.templateVersion`),
    packageTemplateManifestHash: manifestHash(input.packageTemplateManifestHash, `${context}.packageTemplateManifestHash`),
    templateRegistryReference: commitmentHash(input.templateRegistryReference, `${context}.templateRegistryReference`),
    solverCapabilityManifestHash: manifestHash(input.solverCapabilityManifestHash, `${context}.solverCapabilityManifestHash`),
    packageMarketId: protocolId(input.packageMarketId, `${context}.packageMarketId`),
    owner: protocolId(input.owner, `${context}.owner`),
    solver: protocolId(input.solver, `${context}.solver`),
    action,
    settlementClass,
    terminalState,
    quantity: unsigned(input.quantity, U128_BITS, `${context}.quantity`),
    ...(input.grossSpotQuantity === undefined ? {} : { grossSpotQuantity: unsigned(input.grossSpotQuantity, U128_BITS, `${context}.grossSpotQuantity`) }),
    ...(input.netSpotDelta === undefined ? {} : { netSpotDelta: signed(input.netSpotDelta, `${context}.netSpotDelta`) }),
    ...(baseAssetFees === undefined ? {} : { baseAssetFees }),
    ...(input.quantityPolicy === undefined ? {} : { quantityPolicy: variant(QUANTITY_POLICY_CLASS, input.quantityPolicy, `${context}.quantityPolicy`) }),
    ...(terminalResidualBaseQuantity === undefined ? {} : { terminalResidualBaseQuantity }),
    ...(authorizedReferenceResidualQuoteValue === undefined ? {} : { authorizedReferenceResidualQuoteValue }),
    ...(terminalMarkedResidualQuoteValue === undefined ? {} : { terminalMarkedResidualQuoteValue }),
    spotVenue: protocolId(input.spotVenue, `${context}.spotVenue`),
    perpVenue: protocolId(input.perpVenue, `${context}.perpVenue`),
    spotExecutionPrice: unsigned(input.spotExecutionPrice, U128_BITS, `${context}.spotExecutionPrice`),
    ...(perpExecutionPrice === undefined ? {} : { perpExecutionPrice }),
    perpPriceEnforcement,
    ...(packageSpread === undefined ? {} : { packageSpread }),
    spotQuoteDelta: signed(input.spotQuoteDelta, `${context}.spotQuoteDelta`),
    externalQuoteBalanceDelta,
    venueWithdrawableQuoteDelta,
    ...(exitQuoteOutcome === undefined ? {} : { exitQuoteOutcome }),
    exitOutcomeSchemaVersion,
    authoritativePreStateRefs: stateRefs(input.authoritativePreStateRefs, `${context}.authoritativePreStateRefs`),
    authoritativePostStateRefs: stateRefs(input.authoritativePostStateRefs, `${context}.authoritativePostStateRefs`),
    perpPositionDelta: signed(input.perpPositionDelta, `${context}.perpPositionDelta`),
    marginDelta: signed(input.marginDelta, `${context}.marginDelta`),
    matchedPackageNotional: unsigned(input.matchedPackageNotional, U128_BITS, `${context}.matchedPackageNotional`),
    grossLegNotional: unsigned(input.grossLegNotional, U128_BITS, `${context}.grossLegNotional`),
    rawFillFeesByAsset,
    builderFeesByAsset,
    normalizedVenueFeesByAsset,
    protocolFee,
    solverFee,
    feePolicyVersion: u32(input.feePolicyVersion, `${context}.feePolicyVersion`),
    feePolicyManifestHash: manifestHash(input.feePolicyManifestHash, `${context}.feePolicyManifestHash`),
    maxResidualBaseQuantityObserved: unsigned(input.maxResidualBaseQuantityObserved, U128_BITS, `${context}.maxResidualBaseQuantityObserved`),
    ...(authorizedResidualValuationEvidence === undefined ? {} : { authorizedResidualValuationEvidence }),
    ...(terminalResidualMarkEvidence === undefined ? {} : { terminalResidualMarkEvidence }),
    timeUnhedgedMs: unsigned(input.timeUnhedgedMs, U64_BITS, `${context}.timeUnhedgedMs`),
    recoveryCostByAsset: assetVector(input.recoveryCostByAsset, `${context}.recoveryCostByAsset`, true),
    recoveryRefundByAsset: assetVector(input.recoveryRefundByAsset, `${context}.recoveryRefundByAsset`, true),
    priorityFee: nonNegativeAmount(input.priorityFee, `${context}.priorityFee`),
    finalityStatus: variant(FINALITY_STATUS, input.finalityStatus, `${context}.finalityStatus`),
    fieldEvidence: fieldEvidence(input.fieldEvidence, RECEIPT_REQUIRED_FIELDS, `${context}.fieldEvidence`),
    timestampValue: unsigned(input.timestampValue, U64_BITS, `${context}.timestampValue`),
  });
}

function encodeStateRefs(writer: CanonicalWriter, refs: readonly AuthoritativeStateRef[], context: string): void {
  writer.writeArray(refs, (element, ref) => {
    encodeProtocolId(element, ref.locator, `${context}.locator`);
    encodeProtocolId(element, ref.accountKey, `${context}.accountKey`);
    encodeProtocolId(element, ref.component, `${context}.component`);
    element.writeI128(ref.value, `${context}.value`);
    encodeProtocolId(element, ref.unit, `${context}.unit`);
    encodeCommitmentHash(element, ref.evidenceHash, `${context}.evidenceHash`);
  }, context);
}

function encodeAmounts(writer: CanonicalWriter, values: readonly AssetAmount[], context: string): void {
  writer.writeArray(values, (element, value) => encodeAssetAmount(element, value), context);
}

export function packageReceiptBytes(input: PackageReceiptInput): Uint8Array {
  const receipt = packageReceipt(input);
  const u128 = (writer: CanonicalWriter, value: bigint | undefined, name: string) =>
    writer.writeOptional(value, (element, present) => element.writeU128(present, name), name);
  const i128 = (writer: CanonicalWriter, value: bigint | undefined, name: string) =>
    writer.writeOptional(value, (element, present) => element.writeI128(present, name), name);
  return canonicalBytes((writer) => {
    writer.writeU32(receipt.receiptVersion, 'receiptVersion');
    encodeProtocolId(writer, receipt.environment, 'environment');
    encodeDomainRef(writer, receipt.domain);
    encodeIds(writer, receipt.attemptIds, 'attemptIds');
    encodeHashes(writer, receipt.orderedActionEvidenceRefs, 'orderedActionEvidenceRefs');
    encodeHashes(writer, receipt.orderedOrderEvidenceRefs, 'orderedOrderEvidenceRefs');
    encodeHashes(writer, receipt.orderedFillEvidenceRefs, 'orderedFillEvidenceRefs');
    encodeIds(writer, receipt.transactionIds, 'transactionIds');
    encodeCommitmentHash(writer, receipt.evidenceManifestHash, 'evidenceManifestHash');
    encodeOptionalHash(writer, receipt.benchmarkManifestHash, 'benchmarkManifestHash');
    encodeCommitmentHash(writer, receipt.orderHash, 'orderHash');
    encodeCommitmentHash(writer, receipt.quoteHash, 'quoteHash');
    encodeProtocolId(writer, receipt.templateId, 'templateId');
    writer.writeU32(receipt.templateVersion, 'templateVersion');
    encodeManifestHash(writer, receipt.packageTemplateManifestHash, 'packageTemplateManifestHash');
    encodeCommitmentHash(writer, receipt.templateRegistryReference, 'templateRegistryReference');
    encodeManifestHash(writer, receipt.solverCapabilityManifestHash, 'solverCapabilityManifestHash');
    encodeProtocolId(writer, receipt.packageMarketId, 'packageMarketId');
    encodeProtocolId(writer, receipt.owner, 'owner');
    encodeProtocolId(writer, receipt.solver, 'solver');
    writer.writeEnum(PACKAGE_ACTION, receipt.action, 'action');
    writer.writeEnum(SETTLEMENT_CLASS, receipt.settlementClass, 'settlementClass');
    writer.writeEnum(TERMINAL_STATE, receipt.terminalState, 'terminalState');
    writer.writeU128(receipt.quantity, 'quantity');
    u128(writer, receipt.grossSpotQuantity, 'grossSpotQuantity');
    i128(writer, receipt.netSpotDelta, 'netSpotDelta');
    u128(writer, receipt.baseAssetFees, 'baseAssetFees');
    writer.writeOptional(receipt.quantityPolicy, (element, value) => element.writeEnum(QUANTITY_POLICY_CLASS, value, 'quantityPolicy'), 'quantityPolicy');
    u128(writer, receipt.terminalResidualBaseQuantity, 'terminalResidualBaseQuantity');
    u128(writer, receipt.authorizedReferenceResidualQuoteValue, 'authorizedReferenceResidualQuoteValue');
    i128(writer, receipt.terminalMarkedResidualQuoteValue, 'terminalMarkedResidualQuoteValue');
    encodeProtocolId(writer, receipt.spotVenue, 'spotVenue');
    encodeProtocolId(writer, receipt.perpVenue, 'perpVenue');
    writer.writeU128(receipt.spotExecutionPrice, 'spotExecutionPrice');
    u128(writer, receipt.perpExecutionPrice, 'perpExecutionPrice');
    writer.writeEnum(PERP_PRICE_ENFORCEMENT, receipt.perpPriceEnforcement, 'perpPriceEnforcement');
    i128(writer, receipt.packageSpread, 'packageSpread');
    writer.writeI128(receipt.spotQuoteDelta, 'spotQuoteDelta');
    writer.writeI128(receipt.externalQuoteBalanceDelta, 'externalQuoteBalanceDelta');
    writer.writeI128(receipt.venueWithdrawableQuoteDelta, 'venueWithdrawableQuoteDelta');
    i128(writer, receipt.exitQuoteOutcome, 'exitQuoteOutcome');
    writer.writeU32(receipt.exitOutcomeSchemaVersion, 'exitOutcomeSchemaVersion');
    encodeStateRefs(writer, receipt.authoritativePreStateRefs, 'authoritativePreStateRefs');
    encodeStateRefs(writer, receipt.authoritativePostStateRefs, 'authoritativePostStateRefs');
    writer.writeI128(receipt.perpPositionDelta, 'perpPositionDelta');
    writer.writeI128(receipt.marginDelta, 'marginDelta');
    writer.writeU128(receipt.matchedPackageNotional, 'matchedPackageNotional');
    writer.writeU128(receipt.grossLegNotional, 'grossLegNotional');
    encodeAmounts(writer, receipt.rawFillFeesByAsset, 'rawFillFeesByAsset');
    encodeAmounts(writer, receipt.builderFeesByAsset, 'builderFeesByAsset');
    encodeAmounts(writer, receipt.normalizedVenueFeesByAsset, 'normalizedVenueFeesByAsset');
    encodeAssetAmount(writer, receipt.protocolFee);
    encodeAssetAmount(writer, receipt.solverFee);
    writer.writeU32(receipt.feePolicyVersion, 'feePolicyVersion');
    encodeManifestHash(writer, receipt.feePolicyManifestHash, 'feePolicyManifestHash');
    writer.writeU128(receipt.maxResidualBaseQuantityObserved, 'maxResidualBaseQuantityObserved');
    encodeOptionalHash(writer, receipt.authorizedResidualValuationEvidence, 'authorizedResidualValuationEvidence');
    encodeOptionalHash(writer, receipt.terminalResidualMarkEvidence, 'terminalResidualMarkEvidence');
    writer.writeU64(receipt.timeUnhedgedMs, 'timeUnhedgedMs');
    encodeAmounts(writer, receipt.recoveryCostByAsset, 'recoveryCostByAsset');
    encodeAmounts(writer, receipt.recoveryRefundByAsset, 'recoveryRefundByAsset');
    encodeAssetAmount(writer, receipt.priorityFee);
    writer.writeEnum(FINALITY_STATUS, receipt.finalityStatus, 'finalityStatus');
    encodeFieldEvidence(writer, receipt.fieldEvidence);
    writer.writeU64(receipt.timestampValue, 'timestamp');
  });
}

/** receiptHash = sha256("CON/v1/receipt" || canonicalEncode(full PackageReceipt)). */
export function packageReceiptHash(input: PackageReceiptInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.RECEIPT, packageReceiptBytes(input)), 'receiptHash');
}

// ------------------------------------------------------------------ fee and linkage verification

/** The fee terms fixed when the quote was accepted. */
export interface AcceptedQuoteFeeTerms {
  readonly protocolFee: AssetAmount;
  readonly solverFee: AssetAmount;
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Uint8Array | string;
  /** The order's recovery cost caps, keyed by asset. */
  readonly maxRecoveryCostByAsset: readonly AssetAmount[];
}

export type ReceiptFeeViolation =
  | 'PROTOCOL_FEE_ASSET_MISMATCH'
  | 'PROTOCOL_FEE_EXCEEDS_QUOTE'
  | 'SOLVER_FEE_ASSET_MISMATCH'
  | 'SOLVER_FEE_EXCEEDS_QUOTE'
  | 'FEE_POLICY_VERSION_MISMATCH'
  | 'FEE_POLICY_MANIFEST_MISMATCH'
  | 'RECOVERY_PROTOCOL_FEE_CHARGED'
  | 'RECOVERY_COST_ASSET_UNCAPPED'
  | 'RECOVERY_COST_EXCEEDS_CAP';

export interface ReceiptFeeVerification {
  readonly valid: boolean;
  readonly violations: readonly ReceiptFeeViolation[];
}

function sameAsset(left: AssetAmount, right: AssetAmount): boolean {
  return left.asset.assetId === right.asset.assetId &&
    left.asset.decimals === right.asset.decimals &&
    compareBytes(left.asset.assetManifestHash, right.asset.assetManifestHash) === 0;
}

/**
 * Checks a receipt's charges against the accepted quote: protocol and solver fees at or below the
 * quoted amounts in the quoted assets, the same fee policy version and manifest, no protocol fee
 * after recovery, and recovery cost within the order's per-asset caps.
 */
export function verifyReceiptFees(receiptInput: PackageReceiptInput, terms: AcceptedQuoteFeeTerms): ReceiptFeeVerification {
  const receipt = packageReceipt(receiptInput);
  object(terms, 'acceptedQuoteFeeTerms');
  const quotedProtocol = nonNegativeAmount(terms.protocolFee, 'acceptedQuoteFeeTerms.protocolFee');
  const quotedSolver = nonNegativeAmount(terms.solverFee, 'acceptedQuoteFeeTerms.solverFee');
  const caps = assetVector(terms.maxRecoveryCostByAsset, 'acceptedQuoteFeeTerms.maxRecoveryCostByAsset', true);
  const violations: ReceiptFeeViolation[] = [];
  if (!sameAsset(receipt.protocolFee, quotedProtocol)) violations.push('PROTOCOL_FEE_ASSET_MISMATCH');
  else if (receipt.protocolFee.atoms > quotedProtocol.atoms) violations.push('PROTOCOL_FEE_EXCEEDS_QUOTE');
  if (!sameAsset(receipt.solverFee, quotedSolver)) violations.push('SOLVER_FEE_ASSET_MISMATCH');
  else if (receipt.solverFee.atoms > quotedSolver.atoms) violations.push('SOLVER_FEE_EXCEEDS_QUOTE');
  if (receipt.feePolicyVersion !== u32(terms.feePolicyVersion, 'acceptedQuoteFeeTerms.feePolicyVersion')) violations.push('FEE_POLICY_VERSION_MISMATCH');
  if (compareBytes(receipt.feePolicyManifestHash, manifestHash(terms.feePolicyManifestHash, 'acceptedQuoteFeeTerms.feePolicyManifestHash')) !== 0) {
    violations.push('FEE_POLICY_MANIFEST_MISMATCH');
  }
  if (RECOVERED_STATES.has(receipt.terminalState) && receipt.protocolFee.atoms !== 0n) violations.push('RECOVERY_PROTOCOL_FEE_CHARGED');
  for (const cost of receipt.recoveryCostByAsset) {
    if (cost.atoms === 0n) continue;
    const cap = caps.find((entry) => sameAsset(entry, cost));
    if (cap === undefined) violations.push('RECOVERY_COST_ASSET_UNCAPPED');
    else if (cost.atoms > cap.atoms) violations.push('RECOVERY_COST_EXCEEDS_CAP');
  }
  return Object.freeze({ valid: violations.length === 0, violations: Object.freeze([...new Set(violations)]) });
}

export type OutcomeReceiptLinkViolation =
  | 'RECEIPT_NOT_EXPECTED'
  | 'RECEIPT_HASH_MISMATCH'
  | 'EVIDENCE_MANIFEST_MISMATCH'
  | 'ORDER_MISMATCH'
  | 'TERMINAL_STATE_MISMATCH'
  | 'DOMAIN_MISMATCH'
  | 'ENVIRONMENT_MISMATCH'
  | 'ATTEMPTS_MISMATCH';

/**
 * Checks that an outcome and its successful receipt describe the same package: the outcome links
 * the receipt's hash, and both bind the same evidence manifest without hashing each other.
 */
export function verifyOutcomeReceiptLink(outcomeInput: TerminalOutcomeInput, receiptInput: PackageReceiptInput): {
  readonly valid: boolean;
  readonly violations: readonly OutcomeReceiptLinkViolation[];
} {
  const outcome = terminalOutcomeRecord(outcomeInput);
  const receipt = packageReceipt(receiptInput);
  const violations: OutcomeReceiptLinkViolation[] = [];
  if (outcome.successfulReceiptHash === undefined) violations.push('RECEIPT_NOT_EXPECTED');
  else if (compareBytes(outcome.successfulReceiptHash, packageReceiptHash(receiptInput)) !== 0) violations.push('RECEIPT_HASH_MISMATCH');
  if (compareBytes(outcome.evidenceManifestHash, receipt.evidenceManifestHash) !== 0) violations.push('EVIDENCE_MANIFEST_MISMATCH');
  if (compareBytes(outcome.orderHash, receipt.orderHash) !== 0) violations.push('ORDER_MISMATCH');
  if (outcome.terminalState !== receipt.terminalState) violations.push('TERMINAL_STATE_MISMATCH');
  if (outcome.domain.domainId !== receipt.domain.domainId ||
      outcome.domain.domainManifestVersion !== receipt.domain.domainManifestVersion ||
      compareBytes(outcome.domain.domainManifestHash, receipt.domain.domainManifestHash) !== 0) {
    violations.push('DOMAIN_MISMATCH');
  }
  if (outcome.environment !== receipt.environment) violations.push('ENVIRONMENT_MISMATCH');
  const outcomeAttempts = [...outcome.attemptIds].sort();
  const receiptAttempts = [...receipt.attemptIds].sort();
  if (outcomeAttempts.length !== receiptAttempts.length || outcomeAttempts.some((id, index) => id !== receiptAttempts[index])) {
    violations.push('ATTEMPTS_MISMATCH');
  }
  return Object.freeze({ valid: violations.length === 0, violations: Object.freeze(violations) });
}
