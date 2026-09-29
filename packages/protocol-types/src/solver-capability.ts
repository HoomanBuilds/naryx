import { checkedUnsigned } from './arithmetic.js';
import { compareBytes, toHex } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  EXPIRY_UNIT,
  QUOTE_MODE,
  SOLVER_SIGNATURE_SCHEME,
  type EnumTable,
  type ExpiryUnit,
  type QuoteMode,
  type SolverSignatureScheme,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import {
  assetRef,
  domainRef,
  encodeAssetRef,
  encodeDomainRef,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type AssetRef,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';
import { checkedSignatureMaterial } from './solver-quote.js';

export const SOLVER_CAPABILITY_MANIFEST_VERSION = 1;
export const SOLVER_CAPACITY_RECORD_VERSION = 1;
export const SOLVER_CAPABILITY_MAX_ENTRIES = 64;

const U64_BITS = 64;
const U128_BITS = 128;
const U256_BITS = 256;
const BPS = 10_000n;

export const CAPACITY_EVIDENCE_GRADE = Object.freeze({
  ONCHAIN_RESERVED: 1,
  ONCHAIN_AVAILABLE: 2,
  VENUE_CORROBORATED: 3,
  AUDITOR_ATTESTED: 4,
  OPERATOR_ATTESTED: 5,
  ZK_RELATION_PROVED: 6,
} as const);
export type CapacityEvidenceGrade = keyof typeof CAPACITY_EVIDENCE_GRADE;

// Only objectively reserved or observed onchain capacity may back a firm commitment.
const FIRM_EVIDENCE: ReadonlySet<CapacityEvidenceGrade> = new Set(['ONCHAIN_RESERVED', 'ONCHAIN_AVAILABLE']);

export const SOLVER_QUALIFICATION_STATE = Object.freeze({
  ACTIVE: 1,
  RESTRICTED: 2,
  REDUCE_ONLY: 3,
  QUARANTINED: 4,
} as const);
export type SolverQualificationState = keyof typeof SOLVER_QUALIFICATION_STATE;

// ------------------------------------------------------------------ shared checks

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an object');
  }
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  return checkedUnsigned(value, bits, context);
}

function positive(value: bigint, bits: number, context: string): bigint {
  const checked = unsigned(value, bits, context);
  if (checked === 0n) throw new MalformedInputError(context, 'value is zero');
  return checked;
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function bytes(value: Uint8Array, length: number, context: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new MalformedInputError(context, `expected ${length} bytes`);
  }
  return Uint8Array.from(value);
}

function list<T>(value: readonly T[], context: string, allowEmpty = false): readonly T[] {
  if (!Array.isArray(value)) throw new MalformedInputError(context, 'expected an array');
  if (!allowEmpty && value.length === 0) throw new MalformedInputError(context, 'array is empty');
  if (value.length > SOLVER_CAPABILITY_MAX_ENTRIES) {
    throw new MalformedInputError(context, `more than ${SOLVER_CAPABILITY_MAX_ENTRIES} entries`);
  }
  return value;
}

/** Sorts by canonical element bytes and rejects duplicates, so every set has one encoding. */
function canonicalSet<T>(values: readonly T[], encode: (writer: CanonicalWriter, value: T) => void, context: string): readonly T[] {
  const entries = values
    .map((value) => ({ value, bytes: canonicalBytes((writer) => encode(writer, value)) }))
    .sort((left, right) => compareBytes(left.bytes, right.bytes));
  for (let index = 1; index < entries.length; index += 1) {
    if (compareBytes((entries[index - 1] as { bytes: Uint8Array }).bytes, (entries[index] as { bytes: Uint8Array }).bytes) === 0) {
      throw new DuplicateElementError(context, `duplicate element at sorted index ${index}`);
    }
  }
  return Object.freeze(entries.map((entry) => entry.value));
}

function checkedDomainRef(value: DomainRef, context: string): DomainRef {
  object(value, context);
  return domainRef(value.domainId, value.domainManifestVersion, value.domainManifestHash, context);
}

function checkedAssetRef(value: AssetRef, context: string): AssetRef {
  object(value, context);
  return assetRef(value.assetId, value.assetManifestHash, value.decimals, context);
}

// ------------------------------------------------------------------ capability manifest

export interface SolverQuoteKeyInput {
  readonly keyId: string;
  readonly scheme: SolverSignatureScheme;
  readonly verificationKey: Uint8Array;
  readonly validFromValue: bigint;
  readonly validUntilValue: bigint;
}

export interface SolverRfqKeyInput {
  readonly keyId: string;
  readonly encryptionSuiteId: string;
  readonly publicKey: Uint8Array;
  readonly validFromValue: bigint;
  readonly validUntilValue: bigint;
}

export interface SolverMarketCapInput {
  readonly marketId: string;
  readonly quoteAsset: AssetRef;
  readonly maximumNotionalAtoms: bigint;
}

export interface SolverCapabilityManifestInput {
  readonly manifestVersion: number;
  readonly environment: string;
  readonly solverId: string;
  readonly commonControlGroupId: string;
  readonly operatorIdentityScheme: SolverSignatureScheme;
  readonly operatorIdentityKey: Uint8Array;
  readonly quoteVerificationKeys: readonly SolverQuoteKeyInput[];
  readonly rfqEncryptionKeys: readonly SolverRfqKeyInput[];
  readonly supportedDomains: readonly DomainRef[];
  readonly supportedTemplateIds: readonly string[];
  readonly supportedQuoteModes: readonly QuoteMode[];
  readonly maximumNotionalByMarket: readonly SolverMarketCapInput[];
  readonly rfqEndpoints: readonly string[];
  readonly telemetryEndpoint?: string;
  readonly validityUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly manifestNonce: bigint;
  readonly signature: Uint8Array;
}

export interface SolverCapabilityManifest {
  readonly manifestVersion: number;
  readonly environment: ProtocolId;
  readonly solverId: ProtocolId;
  readonly commonControlGroupId: ProtocolId;
  readonly operatorIdentityScheme: SolverSignatureScheme;
  readonly operatorIdentityKey: Uint8Array;
  readonly quoteVerificationKeys: readonly SolverQuoteKeyInput[];
  readonly rfqEncryptionKeys: readonly SolverRfqKeyInput[];
  readonly supportedDomains: readonly DomainRef[];
  readonly supportedTemplateIds: readonly ProtocolId[];
  readonly supportedQuoteModes: readonly QuoteMode[];
  readonly maximumNotionalByMarket: readonly SolverMarketCapInput[];
  readonly rfqEndpoints: readonly ProtocolId[];
  readonly telemetryEndpoint?: ProtocolId;
  readonly validityUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly manifestNonce: bigint;
  readonly signature: Uint8Array;
}

function keyInterval(from: bigint, until: bigint, context: string): void {
  unsigned(from, U64_BITS, `${context}.validFromValue`);
  unsigned(until, U64_BITS, `${context}.validUntilValue`);
  if (until <= from) throw new MalformedInputError(context, 'key validity interval is empty');
}

/** Two keys for one purpose may never be valid at the same instant, so key choice is unambiguous. */
function rejectOverlap(intervals: readonly { validFromValue: bigint; validUntilValue: bigint }[], context: string): void {
  const sorted = [...intervals].sort((left, right) => (left.validFromValue < right.validFromValue ? -1 : 1));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1] as { validUntilValue: bigint };
    if ((sorted[index] as { validFromValue: bigint }).validFromValue < previous.validUntilValue) {
      throw new MalformedInputError(context, 'key validity intervals overlap for one purpose');
    }
  }
}

function encodeQuoteKey(writer: CanonicalWriter, key: SolverQuoteKeyInput): void {
  encodeProtocolId(writer, key.keyId as ProtocolId, 'quoteKey.keyId');
  writer.writeEnum(SOLVER_SIGNATURE_SCHEME, key.scheme, 'quoteKey.scheme');
  writer.writeByteString(key.verificationKey, 'quoteKey.verificationKey');
  writer.writeU64(key.validFromValue, 'quoteKey.validFromValue');
  writer.writeU64(key.validUntilValue, 'quoteKey.validUntilValue');
}

function encodeRfqKey(writer: CanonicalWriter, key: SolverRfqKeyInput): void {
  encodeProtocolId(writer, key.keyId as ProtocolId, 'rfqKey.keyId');
  encodeProtocolId(writer, key.encryptionSuiteId as ProtocolId, 'rfqKey.encryptionSuiteId');
  writer.writeByteString(key.publicKey, 'rfqKey.publicKey');
  writer.writeU64(key.validFromValue, 'rfqKey.validFromValue');
  writer.writeU64(key.validUntilValue, 'rfqKey.validUntilValue');
}

function encodeMarketCap(writer: CanonicalWriter, cap: SolverMarketCapInput): void {
  encodeProtocolId(writer, cap.marketId as ProtocolId, 'marketCap.marketId');
  encodeAssetRef(writer, cap.quoteAsset);
  writer.writeU128(cap.maximumNotionalAtoms, 'marketCap.maximumNotionalAtoms');
}

export function solverCapabilityManifest(
  input: SolverCapabilityManifestInput,
  context = 'solverCapabilityManifest',
): SolverCapabilityManifest {
  object(input, context);
  if (input.manifestVersion !== SOLVER_CAPABILITY_MANIFEST_VERSION) {
    throw new MalformedInputError(`${context}.manifestVersion`, `version must equal ${SOLVER_CAPABILITY_MANIFEST_VERSION}`);
  }
  const operatorIdentityScheme = variant(SOLVER_SIGNATURE_SCHEME, input.operatorIdentityScheme, `${context}.operatorIdentityScheme`);
  const { verificationKey: operatorIdentityKey, signature } = checkedSignatureMaterial(
    operatorIdentityScheme,
    input.operatorIdentityKey,
    input.signature,
    `${context}.operator`,
  );
  const quoteKeys = list(input.quoteVerificationKeys, `${context}.quoteVerificationKeys`).map((key, index) => {
    const at = `${context}.quoteVerificationKeys[${index}]`;
    object(key, at);
    const scheme = variant(SOLVER_SIGNATURE_SCHEME, key.scheme, `${at}.scheme`);
    const verificationKey = bytes(key.verificationKey, scheme === 'ED25519' ? 32 : 20, `${at}.verificationKey`);
    keyInterval(key.validFromValue, key.validUntilValue, at);
    return Object.freeze({
      keyId: protocolId(key.keyId, `${at}.keyId`),
      scheme,
      verificationKey,
      validFromValue: key.validFromValue,
      validUntilValue: key.validUntilValue,
    });
  });
  rejectOverlap(quoteKeys, `${context}.quoteVerificationKeys`);
  const rfqKeys = list(input.rfqEncryptionKeys, `${context}.rfqEncryptionKeys`, true).map((key, index) => {
    const at = `${context}.rfqEncryptionKeys[${index}]`;
    object(key, at);
    keyInterval(key.validFromValue, key.validUntilValue, at);
    if (!(key.publicKey instanceof Uint8Array) || key.publicKey.length === 0 || key.publicKey.length > 256) {
      throw new MalformedInputError(`${at}.publicKey`, 'expected 1 to 256 bytes');
    }
    return Object.freeze({
      keyId: protocolId(key.keyId, `${at}.keyId`),
      encryptionSuiteId: protocolId(key.encryptionSuiteId, `${at}.encryptionSuiteId`),
      publicKey: Uint8Array.from(key.publicKey),
      validFromValue: key.validFromValue,
      validUntilValue: key.validUntilValue,
    });
  });
  rejectOverlap(rfqKeys, `${context}.rfqEncryptionKeys`);
  const caps = list(input.maximumNotionalByMarket, `${context}.maximumNotionalByMarket`).map((cap, index) => {
    const at = `${context}.maximumNotionalByMarket[${index}]`;
    object(cap, at);
    return Object.freeze({
      marketId: protocolId(cap.marketId, `${at}.marketId`),
      quoteAsset: checkedAssetRef(cap.quoteAsset, `${at}.quoteAsset`),
      maximumNotionalAtoms: positive(cap.maximumNotionalAtoms, U128_BITS, `${at}.maximumNotionalAtoms`),
    });
  });
  if (new Set(caps.map((cap) => cap.marketId)).size !== caps.length) {
    throw new DuplicateElementError(`${context}.maximumNotionalByMarket`, 'one market has two notional caps');
  }
  const manifestNonce = positive(input.manifestNonce, U256_BITS, `${context}.manifestNonce`);
  return Object.freeze({
    manifestVersion: SOLVER_CAPABILITY_MANIFEST_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    solverId: protocolId(input.solverId, `${context}.solverId`),
    commonControlGroupId: protocolId(input.commonControlGroupId, `${context}.commonControlGroupId`),
    operatorIdentityScheme,
    operatorIdentityKey,
    quoteVerificationKeys: canonicalSet(quoteKeys, encodeQuoteKey, `${context}.quoteVerificationKeys`),
    rfqEncryptionKeys: canonicalSet(rfqKeys, encodeRfqKey, `${context}.rfqEncryptionKeys`),
    supportedDomains: canonicalSet(
      list(input.supportedDomains, `${context}.supportedDomains`).map((value, index) =>
        checkedDomainRef(value, `${context}.supportedDomains[${index}]`),
      ),
      encodeDomainRef,
      `${context}.supportedDomains`,
    ),
    supportedTemplateIds: canonicalSet(
      list(input.supportedTemplateIds, `${context}.supportedTemplateIds`).map((value, index) =>
        protocolId(value, `${context}.supportedTemplateIds[${index}]`),
      ),
      (writer, value) => encodeProtocolId(writer, value),
      `${context}.supportedTemplateIds`,
    ),
    supportedQuoteModes: canonicalSet(
      list(input.supportedQuoteModes, `${context}.supportedQuoteModes`).map((value, index) =>
        variant(QUOTE_MODE, value, `${context}.supportedQuoteModes[${index}]`),
      ),
      (writer, value) => writer.writeEnum(QUOTE_MODE, value),
      `${context}.supportedQuoteModes`,
    ),
    maximumNotionalByMarket: canonicalSet(caps, encodeMarketCap, `${context}.maximumNotionalByMarket`),
    rfqEndpoints: canonicalSet(
      list(input.rfqEndpoints, `${context}.rfqEndpoints`).map((value, index) =>
        protocolId(value, `${context}.rfqEndpoints[${index}]`),
      ),
      (writer, value) => encodeProtocolId(writer, value),
      `${context}.rfqEndpoints`,
    ),
    ...(input.telemetryEndpoint === undefined
      ? {}
      : { telemetryEndpoint: protocolId(input.telemetryEndpoint, `${context}.telemetryEndpoint`) }),
    validityUnit: variant(EXPIRY_UNIT, input.validityUnit, `${context}.validityUnit`),
    validUntilValue: unsigned(input.validUntilValue, U64_BITS, `${context}.validUntilValue`),
    manifestNonce,
    signature,
  });
}

/** The unsigned manifest bytes. The operator identity key signs the resulting hash. */
export function unsignedSolverCapabilityManifestBytes(input: SolverCapabilityManifestInput): Uint8Array {
  const manifest = solverCapabilityManifest(input);
  return canonicalBytes((writer) => {
    writer.writeU32(manifest.manifestVersion, 'manifestVersion');
    encodeProtocolId(writer, manifest.environment, 'environment');
    encodeProtocolId(writer, manifest.solverId, 'solverId');
    encodeProtocolId(writer, manifest.commonControlGroupId, 'commonControlGroupId');
    writer.writeEnum(SOLVER_SIGNATURE_SCHEME, manifest.operatorIdentityScheme, 'operatorIdentityScheme');
    writer.writeByteString(manifest.operatorIdentityKey, 'operatorIdentityKey');
    writer.writeArray(manifest.quoteVerificationKeys, encodeQuoteKey, 'quoteVerificationKeys');
    writer.writeArray(manifest.rfqEncryptionKeys, encodeRfqKey, 'rfqEncryptionKeys');
    writer.writeArray(manifest.supportedDomains, encodeDomainRef, 'supportedDomains');
    writer.writeArray(manifest.supportedTemplateIds, (element, value) => encodeProtocolId(element, value), 'supportedTemplateIds');
    writer.writeArray(manifest.supportedQuoteModes, (element, value) => element.writeEnum(QUOTE_MODE, value), 'supportedQuoteModes');
    writer.writeArray(manifest.maximumNotionalByMarket, encodeMarketCap, 'maximumNotionalByMarket');
    writer.writeArray(manifest.rfqEndpoints, (element, value) => encodeProtocolId(element, value), 'rfqEndpoints');
    writer.writeOptional(manifest.telemetryEndpoint, (element, value) => encodeProtocolId(element, value));
    writer.writeEnum(EXPIRY_UNIT, manifest.validityUnit, 'validityUnit');
    writer.writeU64(manifest.validUntilValue, 'validUntilValue');
    writer.writeU256(manifest.manifestNonce, 'manifestNonce');
  });
}

export function solverCapabilityManifestHash(input: SolverCapabilityManifestInput): ManifestHash {
  return manifestHash(
    domainHash(HASH_DOMAIN.SOLVER_CAPABILITY, unsignedSolverCapabilityManifestBytes(input)),
    'solverCapabilityManifestHash',
  );
}

export type SolverAuthorizationRejection =
  | 'ENVIRONMENT_MISMATCH'
  | 'MANIFEST_EXPIRED'
  | 'DOMAIN_UNSUPPORTED'
  | 'TEMPLATE_UNSUPPORTED'
  | 'QUOTE_MODE_UNSUPPORTED'
  | 'MARKET_UNSUPPORTED'
  | 'NOTIONAL_ABOVE_CAPABILITY'
  | 'KEY_UNKNOWN'
  | 'KEY_OUTSIDE_VALIDITY';

export interface SolverQuoteAuthorizationQuery {
  readonly environment: string;
  readonly domain: DomainRef;
  readonly templateId: string;
  readonly quoteMode: QuoteMode;
  readonly marketId: string;
  readonly notionalAtoms: bigint;
  readonly scheme: SolverSignatureScheme;
  readonly verificationKey: Uint8Array;
  readonly atValue: bigint;
}

/**
 * Decides whether a manifest authorizes one quote. The caller must already have verified the
 * operator signature over `solverCapabilityManifestHash`; this function checks scope only.
 */
export function authorizeSolverQuote(
  input: SolverCapabilityManifestInput,
  query: SolverQuoteAuthorizationQuery,
): { readonly authorized: true; readonly keyId: ProtocolId } | { readonly authorized: false; readonly reason: SolverAuthorizationRejection } {
  const manifest = solverCapabilityManifest(input);
  object(query, 'authorizeSolverQuote.query');
  const at = unsigned(query.atValue, U64_BITS, 'authorizeSolverQuote.atValue');
  const reject = (reason: SolverAuthorizationRejection) => ({ authorized: false as const, reason });
  if (manifest.environment !== protocolId(query.environment, 'authorizeSolverQuote.environment')) {
    return reject('ENVIRONMENT_MISMATCH');
  }
  if (at >= manifest.validUntilValue) return reject('MANIFEST_EXPIRED');
  const domain = canonicalBytes((writer) => encodeDomainRef(writer, checkedDomainRef(query.domain, 'authorizeSolverQuote.domain')));
  if (!manifest.supportedDomains.some((value) => compareBytes(canonicalBytes((writer) => encodeDomainRef(writer, value)), domain) === 0)) {
    return reject('DOMAIN_UNSUPPORTED');
  }
  if (!manifest.supportedTemplateIds.includes(protocolId(query.templateId, 'authorizeSolverQuote.templateId'))) {
    return reject('TEMPLATE_UNSUPPORTED');
  }
  if (!manifest.supportedQuoteModes.includes(variant(QUOTE_MODE, query.quoteMode, 'authorizeSolverQuote.quoteMode'))) {
    return reject('QUOTE_MODE_UNSUPPORTED');
  }
  const cap = manifest.maximumNotionalByMarket.find((value) => value.marketId === query.marketId);
  if (cap === undefined) return reject('MARKET_UNSUPPORTED');
  if (unsigned(query.notionalAtoms, U128_BITS, 'authorizeSolverQuote.notionalAtoms') > cap.maximumNotionalAtoms) {
    return reject('NOTIONAL_ABOVE_CAPABILITY');
  }
  const key = manifest.quoteVerificationKeys.find(
    (value) => value.scheme === query.scheme && compareBytes(value.verificationKey, query.verificationKey) === 0,
  );
  if (key === undefined) return reject('KEY_UNKNOWN');
  if (at < key.validFromValue || at >= key.validUntilValue) return reject('KEY_OUTSIDE_VALIDITY');
  return { authorized: true, keyId: key.keyId as ProtocolId };
}

// ------------------------------------------------------------------ capacity

export interface SolverCapacityRecordInput {
  readonly version: number;
  readonly environment: string;
  readonly solverId: string;
  readonly domain: DomainRef;
  readonly asset: AssetRef;
  readonly availableAtoms: bigint;
  readonly maximumConcurrentRecoveryAtoms: bigint;
  readonly evidenceGrade: CapacityEvidenceGrade;
  readonly evidenceCommitment: Uint8Array | string;
  readonly observedAtValue: bigint;
  readonly expiresAtValue: bigint;
}

export interface SolverCapacityRecord {
  readonly version: number;
  readonly environment: ProtocolId;
  readonly solverId: ProtocolId;
  readonly domain: DomainRef;
  readonly asset: AssetRef;
  readonly availableAtoms: bigint;
  readonly maximumConcurrentRecoveryAtoms: bigint;
  readonly evidenceGrade: CapacityEvidenceGrade;
  readonly evidenceCommitment: CommitmentHash;
  readonly observedAtValue: bigint;
  readonly expiresAtValue: bigint;
}

export function solverCapacityRecord(input: SolverCapacityRecordInput, context = 'solverCapacityRecord'): SolverCapacityRecord {
  object(input, context);
  if (input.version !== SOLVER_CAPACITY_RECORD_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${SOLVER_CAPACITY_RECORD_VERSION}`);
  }
  const observedAtValue = unsigned(input.observedAtValue, U64_BITS, `${context}.observedAtValue`);
  const expiresAtValue = unsigned(input.expiresAtValue, U64_BITS, `${context}.expiresAtValue`);
  if (expiresAtValue <= observedAtValue) {
    throw new MalformedInputError(`${context}.expiresAtValue`, 'capacity evidence expires before it was observed');
  }
  return Object.freeze({
    version: SOLVER_CAPACITY_RECORD_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    solverId: protocolId(input.solverId, `${context}.solverId`),
    domain: checkedDomainRef(input.domain, `${context}.domain`),
    asset: checkedAssetRef(input.asset, `${context}.asset`),
    availableAtoms: unsigned(input.availableAtoms, U128_BITS, `${context}.availableAtoms`),
    maximumConcurrentRecoveryAtoms: unsigned(input.maximumConcurrentRecoveryAtoms, U128_BITS, `${context}.maximumConcurrentRecoveryAtoms`),
    evidenceGrade: variant(CAPACITY_EVIDENCE_GRADE, input.evidenceGrade, `${context}.evidenceGrade`),
    evidenceCommitment: commitmentHash(input.evidenceCommitment, `${context}.evidenceCommitment`),
    observedAtValue,
    expiresAtValue,
  });
}

export function solverCapacityRecordHash(input: SolverCapacityRecordInput): CommitmentHash {
  const record = solverCapacityRecord(input);
  const payload = canonicalBytes((writer) => {
    writer.writeU32(record.version, 'version');
    encodeProtocolId(writer, record.environment, 'environment');
    encodeProtocolId(writer, record.solverId, 'solverId');
    encodeDomainRef(writer, record.domain);
    encodeAssetRef(writer, record.asset);
    writer.writeU128(record.availableAtoms, 'availableAtoms');
    writer.writeU128(record.maximumConcurrentRecoveryAtoms, 'maximumConcurrentRecoveryAtoms');
    writer.writeEnum(CAPACITY_EVIDENCE_GRADE, record.evidenceGrade, 'evidenceGrade');
    encodeCommitmentHash(writer, record.evidenceCommitment, 'evidenceCommitment');
    writer.writeU64(record.observedAtValue, 'observedAtValue');
    writer.writeU64(record.expiresAtValue, 'expiresAtValue');
  });
  return commitmentHash(domainHash(HASH_DOMAIN.SOLVER_CAPACITY_RECORD, payload), 'solverCapacityRecordHash');
}

export interface SolverCapacityCommitment {
  readonly commitmentId: CommitmentHash;
  readonly atoms: bigint;
  readonly recoveryAtoms: bigint;
  readonly firm: boolean;
}

export interface SolverCapacityLedger {
  readonly record: SolverCapacityRecord;
  readonly commitments: readonly SolverCapacityCommitment[];
}

export type SolverCapacityRejection =
  | 'RECORD_EXPIRED'
  | 'WIND_DOWN'
  | 'DUPLICATE_COMMITMENT'
  | 'INSUFFICIENT_CAPACITY'
  | 'INSUFFICIENT_RECOVERY_CAPACITY'
  | 'EVIDENCE_TOO_WEAK_FOR_FIRM';

export interface SolverCapacityStatus {
  readonly state: 'ACTIVE' | 'REDUCE_ONLY';
  readonly committedAtoms: bigint;
  readonly committedRecoveryAtoms: bigint;
  readonly remainingAtoms: bigint;
  readonly outstandingCommitmentRoot: CommitmentHash;
}

export function openSolverCapacityLedger(record: SolverCapacityRecordInput): SolverCapacityLedger {
  return Object.freeze({ record: solverCapacityRecord(record), commitments: Object.freeze([]) });
}

function totals(ledger: SolverCapacityLedger): { atoms: bigint; recovery: bigint } {
  return ledger.commitments.reduce(
    (sum, commitment) => ({ atoms: sum.atoms + commitment.atoms, recovery: sum.recovery + commitment.recoveryAtoms }),
    { atoms: 0n, recovery: 0n },
  );
}

/**
 * A capacity claim covers only its evidence scope. When outstanding obligations exceed the
 * current evidence or the evidence expires, the solver winds down: new commitments stop while
 * releases and lifecycle exits continue.
 */
export function solverCapacityStatus(ledger: SolverCapacityLedger, atValue: bigint): SolverCapacityStatus {
  const at = unsigned(atValue, U64_BITS, 'solverCapacityStatus.atValue');
  const { atoms, recovery } = totals(ledger);
  const record = ledger.record;
  const healthy =
    at < record.expiresAtValue && atoms <= record.availableAtoms && recovery <= record.maximumConcurrentRecoveryAtoms;
  const sorted = [...ledger.commitments].sort((left, right) => compareBytes(left.commitmentId, right.commitmentId));
  const root = canonicalBytes((writer) => {
    encodeProtocolId(writer, record.solverId, 'solverId');
    writer.writeArray(sorted, (element, commitment) => {
      encodeCommitmentHash(element, commitment.commitmentId, 'commitmentId');
      element.writeU128(commitment.atoms, 'atoms');
      element.writeU128(commitment.recoveryAtoms, 'recoveryAtoms');
      element.writeBool(commitment.firm, 'firm');
    });
  });
  return Object.freeze({
    state: healthy ? 'ACTIVE' : 'REDUCE_ONLY',
    committedAtoms: atoms,
    committedRecoveryAtoms: recovery,
    remainingAtoms: record.availableAtoms > atoms ? record.availableAtoms - atoms : 0n,
    outstandingCommitmentRoot: commitmentHash(domainHash(HASH_DOMAIN.SOLVER_COMMITMENT_ROOT, root), 'outstandingCommitmentRoot'),
  });
}

export interface SolverCapacityCommitmentInput {
  readonly commitmentId: Uint8Array | string;
  readonly atoms: bigint;
  readonly recoveryAtoms: bigint;
  readonly firm: boolean;
  readonly atValue: bigint;
}

export function commitSolverCapacity(
  ledger: SolverCapacityLedger,
  input: SolverCapacityCommitmentInput,
): { readonly accepted: true; readonly ledger: SolverCapacityLedger } | { readonly accepted: false; readonly rejection: SolverCapacityRejection } {
  object(input, 'commitSolverCapacity');
  const commitmentId = commitmentHash(input.commitmentId, 'commitSolverCapacity.commitmentId');
  const atoms = positive(input.atoms, U128_BITS, 'commitSolverCapacity.atoms');
  const recoveryAtoms = unsigned(input.recoveryAtoms, U128_BITS, 'commitSolverCapacity.recoveryAtoms');
  if (typeof input.firm !== 'boolean') throw new MalformedInputError('commitSolverCapacity.firm', 'expected a boolean');
  const reject = (rejection: SolverCapacityRejection) => ({ accepted: false as const, rejection });
  const status = solverCapacityStatus(ledger, input.atValue);
  if (input.atValue >= ledger.record.expiresAtValue) return reject('RECORD_EXPIRED');
  if (status.state === 'REDUCE_ONLY') return reject('WIND_DOWN');
  if (ledger.commitments.some((value) => compareBytes(value.commitmentId, commitmentId) === 0)) {
    return reject('DUPLICATE_COMMITMENT');
  }
  if (input.firm && !FIRM_EVIDENCE.has(ledger.record.evidenceGrade)) return reject('EVIDENCE_TOO_WEAK_FOR_FIRM');
  if (status.committedAtoms + atoms > ledger.record.availableAtoms) return reject('INSUFFICIENT_CAPACITY');
  if (status.committedRecoveryAtoms + recoveryAtoms > ledger.record.maximumConcurrentRecoveryAtoms) {
    return reject('INSUFFICIENT_RECOVERY_CAPACITY');
  }
  const commitment = Object.freeze({ commitmentId, atoms, recoveryAtoms, firm: input.firm });
  return { accepted: true, ledger: Object.freeze({ record: ledger.record, commitments: Object.freeze([...ledger.commitments, commitment]) }) };
}

/** Terminal settlement or expiry releases a commitment; release stays available during wind-down. */
export function releaseSolverCapacity(ledger: SolverCapacityLedger, commitmentId: Uint8Array | string): SolverCapacityLedger {
  const id = toHex(commitmentHash(commitmentId, 'releaseSolverCapacity.commitmentId'));
  const remaining = ledger.commitments.filter((value) => toHex(value.commitmentId) !== id);
  if (remaining.length === ledger.commitments.length) {
    throw new MalformedInputError('releaseSolverCapacity.commitmentId', 'commitment is not outstanding');
  }
  return Object.freeze({ record: ledger.record, commitments: Object.freeze(remaining) });
}

/** Replaces the evidence behind a ledger. Outstanding commitments carry over and may force wind-down. */
export function refreshSolverCapacity(ledger: SolverCapacityLedger, input: SolverCapacityRecordInput): SolverCapacityLedger {
  const record = solverCapacityRecord(input);
  const previous = ledger.record;
  const sameScope =
    record.environment === previous.environment &&
    record.solverId === previous.solverId &&
    compareBytes(canonicalBytes((writer) => encodeDomainRef(writer, record.domain)), canonicalBytes((writer) => encodeDomainRef(writer, previous.domain))) === 0 &&
    compareBytes(canonicalBytes((writer) => encodeAssetRef(writer, record.asset)), canonicalBytes((writer) => encodeAssetRef(writer, previous.asset))) === 0;
  if (!sameScope) {
    throw new MalformedInputError('refreshSolverCapacity', 'new evidence covers another solver, domain, or asset');
  }
  if (record.observedAtValue <= previous.observedAtValue) {
    throw new MalformedInputError('refreshSolverCapacity.observedAtValue', 'capacity evidence only moves forward');
  }
  return Object.freeze({ record, commitments: ledger.commitments });
}

// ------------------------------------------------------------------ qualification

export interface SolverPerformanceMetrics {
  readonly eligibleRequests: bigint;
  readonly responses: bigint;
  readonly acceptedQuotes: bigint;
  readonly settledAcceptedQuotes: bigint;
  readonly fadedAcceptedQuotes: bigint;
  readonly residualBreaches: bigint;
  readonly disputesLost: bigint;
}

export interface SolverQualificationPolicy {
  readonly minimumSample: bigint;
  readonly minimumCoverageBps: bigint;
  readonly minimumSettlementBps: bigint;
  readonly maximumFadeBps: bigint;
  readonly maximumResidualBreaches: bigint;
  readonly maximumDisputesLost: bigint;
}

export interface SolverQualificationDecision {
  readonly state: SolverQualificationState;
  readonly triggers: readonly string[];
}

function severity(state: SolverQualificationState): number {
  return enumDiscriminant(SOLVER_QUALIFICATION_STATE, state, 'solverQualification.state');
}

/** `numerator / denominator < bps / 10000`, by cross multiplication. */
function belowBps(numerator: bigint, denominator: bigint, bps: bigint): boolean {
  return numerator * BPS < bps * denominator;
}

/**
 * Automatic evaluation can only keep or lower a solver's qualification. Raw metrics are
 * returned as triggers rather than folded into a composite score.
 */
export function evaluateSolverQualification(
  current: SolverQualificationState,
  metrics: SolverPerformanceMetrics,
  policy: SolverQualificationPolicy,
): SolverQualificationDecision {
  severity(current);
  object(metrics, 'solverQualification.metrics');
  object(policy, 'solverQualification.policy');
  for (const [name, value] of Object.entries({ ...metrics, ...policy })) {
    unsigned(value as bigint, U64_BITS, `solverQualification.${name}`);
  }
  for (const name of ['minimumCoverageBps', 'minimumSettlementBps', 'maximumFadeBps'] as const) {
    if (policy[name] > BPS) throw new MalformedInputError(`solverQualification.${name}`, 'basis points exceed 10000');
  }
  if (metrics.responses > metrics.eligibleRequests || metrics.acceptedQuotes > metrics.responses
    || metrics.settledAcceptedQuotes + metrics.fadedAcceptedQuotes > metrics.acceptedQuotes) {
    throw new MalformedInputError('solverQualification.metrics', 'metric counts are inconsistent');
  }
  const triggers: string[] = [];
  let candidate: SolverQualificationState = 'ACTIVE';
  const raise = (state: SolverQualificationState, trigger: string) => {
    triggers.push(trigger);
    if (severity(state) > severity(candidate)) candidate = state;
  };
  if (metrics.disputesLost > policy.maximumDisputesLost) raise('QUARANTINED', 'DISPUTES_LOST');
  if (metrics.residualBreaches > policy.maximumResidualBreaches) raise('QUARANTINED', 'RESIDUAL_BREACHES');
  if (metrics.acceptedQuotes >= policy.minimumSample) {
    if (belowBps(metrics.settledAcceptedQuotes, metrics.acceptedQuotes, policy.minimumSettlementBps)) {
      raise('REDUCE_ONLY', 'SETTLEMENT_RATE');
    }
    if (metrics.fadedAcceptedQuotes * BPS > policy.maximumFadeBps * metrics.acceptedQuotes) {
      raise('RESTRICTED', 'FADE_RATE');
    }
  }
  if (metrics.eligibleRequests >= policy.minimumSample && belowBps(metrics.responses, metrics.eligibleRequests, policy.minimumCoverageBps)) {
    raise('RESTRICTED', 'COVERAGE');
  }
  return Object.freeze({
    state: severity(candidate) > severity(current) ? candidate : current,
    triggers: Object.freeze(triggers),
  });
}

/** Promotion is never automatic: it needs two distinct reviewers and must lower severity. */
export function promoteSolverQualification(
  current: SolverQualificationState,
  target: SolverQualificationState,
  reviewerIds: readonly string[],
): SolverQualificationState {
  if (severity(target) >= severity(current)) {
    throw new MalformedInputError('promoteSolverQualification.target', 'promotion must lower severity');
  }
  if (!Array.isArray(reviewerIds)) throw new MalformedInputError('promoteSolverQualification.reviewerIds', 'expected an array');
  const reviewers = new Set(reviewerIds.map((value) => protocolId(value, 'promoteSolverQualification.reviewerIds')));
  if (reviewers.size < 2) {
    throw new MalformedInputError('promoteSolverQualification.reviewerIds', 'promotion needs two distinct reviewers');
  }
  return target;
}

