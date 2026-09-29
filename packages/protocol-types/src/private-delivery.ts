import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { assertUint8Array, compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { enumDiscriminant, EXPIRY_UNIT, type EnumTable, type ExpiryUnit } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import {
  domainRef,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';
import { solverCapabilityManifest, type SolverCapabilityManifestInput } from './solver-capability.js';

export const PRIVATE_RFQ_ENVELOPE_VERSION = 1;
export const SEALED_AUCTION_VERSION = 1;
export const SEALED_AUCTION_MAX_SOLVERS = 64;
export const SEALED_SALT_BYTES = 32;
const MAX_KEY_BYTES = 256;
const U64_BITS = 64;
const I128_BITS = 128;

export const DELIVERY_MODE = Object.freeze({
  PUBLIC_PACKAGE_BOOK: 1,
  PUBLIC_RFQ: 2,
  PRIVATE_DIRECT_RFQ: 3,
  SEALED_BATCH_AUCTION: 4,
} as const);
export type DeliveryMode = keyof typeof DELIVERY_MODE;

export const PRIVATE_DELIVERY_MODES: ReadonlySet<DeliveryMode> = new Set(['PRIVATE_DIRECT_RFQ', 'SEALED_BATCH_AUCTION']);

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

// A non-narrowing check: Array.isArray would widen readonly element types to any.
function requireArray(value: unknown, context: string, maximum: number): void {
  if (!Array.isArray(value)) throw new MalformedInputError(context, 'expected an array');
  if (value.length > maximum) throw new MalformedInputError(context, `more than ${maximum} entries`);
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function bool(value: boolean, context: string): boolean {
  if (typeof value !== 'boolean') throw new MalformedInputError(context, 'expected a boolean');
  return value;
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function idSet(values: readonly string[], context: string, maximum: number, allowEmpty = false): readonly ProtocolId[] {
  requireArray(values, context, maximum);
  if (!allowEmpty && values.length === 0) throw new MalformedInputError(context, 'set is empty');
  const sorted = values.map((value, index) => protocolId(value, `${context}[${index}]`)).sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1] === sorted[index]) throw new DuplicateElementError(context, 'identifiers repeat');
  }
  return Object.freeze(sorted);
}

// ------------------------------------------------------------------ private direct RFQ envelope

export interface PrivateRfqEnvelopeInput {
  readonly envelopeVersion: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly orderHash: Uint8Array | string;
  readonly senderKeyId: string;
  readonly responseEncryptionKey: Uint8Array;
  readonly recipientSolverId: string;
  readonly recipientEncryptionKeyId: string;
  readonly encryptionSuiteId: string;
  readonly ciphertextHash: Uint8Array | string;
  readonly createdAtUnit: ExpiryUnit;
  readonly createdAtValue: bigint;
  readonly expiresAtUnit: ExpiryUnit;
  readonly expiresAtValue: bigint;
  readonly envelopeNonce: bigint;
}

export interface PrivateRfqEnvelope {
  readonly envelopeVersion: number;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly templateId: ProtocolId;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: ManifestHash;
  readonly orderHash: CommitmentHash;
  readonly senderKeyId: ProtocolId;
  readonly responseEncryptionKey: Uint8Array;
  readonly recipientSolverId: ProtocolId;
  readonly recipientEncryptionKeyId: ProtocolId;
  readonly encryptionSuiteId: ProtocolId;
  readonly ciphertextHash: CommitmentHash;
  readonly createdAtUnit: ExpiryUnit;
  readonly createdAtValue: bigint;
  readonly expiresAtUnit: ExpiryUnit;
  readonly expiresAtValue: bigint;
  readonly envelopeNonce: bigint;
}

function templateVersion(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff) throw new MalformedInputError(context, 'expected a positive u32 version');
  return value;
}

function keyBytes(value: Uint8Array, context: string): Uint8Array {
  assertUint8Array(value, context);
  if (value.length === 0 || value.length > MAX_KEY_BYTES) throw new MalformedInputError(context, `key must be 1 to ${MAX_KEY_BYTES} bytes`);
  return Uint8Array.from(value);
}

export function privateRfqEnvelope(input: PrivateRfqEnvelopeInput, context = 'privateRfqEnvelope'): PrivateRfqEnvelope {
  object(input, context);
  if (input.envelopeVersion !== PRIVATE_RFQ_ENVELOPE_VERSION) {
    throw new MalformedInputError(`${context}.envelopeVersion`, `version must equal ${PRIVATE_RFQ_ENVELOPE_VERSION}`);
  }
  object(input.domain, `${context}.domain`);
  const createdAtUnit = variant(EXPIRY_UNIT, input.createdAtUnit, `${context}.createdAtUnit`);
  const expiresAtUnit = variant(EXPIRY_UNIT, input.expiresAtUnit, `${context}.expiresAtUnit`);
  if (createdAtUnit !== expiresAtUnit) throw new MalformedInputError(`${context}.expiresAtUnit`, 'creation and expiry use different units');
  const createdAtValue = unsigned(input.createdAtValue, U64_BITS, `${context}.createdAtValue`);
  const expiresAtValue = unsigned(input.expiresAtValue, U64_BITS, `${context}.expiresAtValue`);
  if (expiresAtValue <= createdAtValue) throw new MalformedInputError(`${context}.expiresAtValue`, 'envelope expires before it is created');
  return Object.freeze({
    envelopeVersion: PRIVATE_RFQ_ENVELOPE_VERSION,
    environment: protocolId(input.environment, `${context}.environment`),
    domain: domainRef(input.domain.domainId, input.domain.domainManifestVersion, input.domain.domainManifestHash, `${context}.domain`),
    templateId: protocolId(input.templateId, `${context}.templateId`),
    templateVersion: templateVersion(input.templateVersion, `${context}.templateVersion`),
    packageTemplateManifestHash: manifestHash(input.packageTemplateManifestHash, `${context}.packageTemplateManifestHash`),
    orderHash: commitmentHash(input.orderHash, `${context}.orderHash`),
    senderKeyId: protocolId(input.senderKeyId, `${context}.senderKeyId`),
    responseEncryptionKey: keyBytes(input.responseEncryptionKey, `${context}.responseEncryptionKey`),
    recipientSolverId: protocolId(input.recipientSolverId, `${context}.recipientSolverId`),
    recipientEncryptionKeyId: protocolId(input.recipientEncryptionKeyId, `${context}.recipientEncryptionKeyId`),
    encryptionSuiteId: protocolId(input.encryptionSuiteId, `${context}.encryptionSuiteId`),
    ciphertextHash: commitmentHash(input.ciphertextHash, `${context}.ciphertextHash`),
    createdAtUnit,
    createdAtValue,
    expiresAtUnit,
    expiresAtValue,
    envelopeNonce: unsigned(input.envelopeNonce, U64_BITS, `${context}.envelopeNonce`),
  });
}

function encodeEnvelopeHeader(writer: CanonicalWriter, envelope: PrivateRfqEnvelope): void {
  writer.writeU32(envelope.envelopeVersion, 'envelopeVersion');
  encodeProtocolId(writer, envelope.environment, 'environment');
  encodeDomainRef(writer, envelope.domain);
  encodeProtocolId(writer, envelope.templateId, 'templateId');
  writer.writeU32(envelope.templateVersion, 'templateVersion');
  encodeManifestHash(writer, envelope.packageTemplateManifestHash, 'packageTemplateManifestHash');
  encodeCommitmentHash(writer, envelope.orderHash, 'orderHash');
  encodeProtocolId(writer, envelope.senderKeyId, 'senderKeyId');
  writer.writeByteString(envelope.responseEncryptionKey, 'responseEncryptionKey');
  encodeProtocolId(writer, envelope.recipientSolverId, 'recipientSolverId');
  encodeProtocolId(writer, envelope.recipientEncryptionKeyId, 'recipientEncryptionKeyId');
  encodeProtocolId(writer, envelope.encryptionSuiteId, 'encryptionSuiteId');
}

function encodeEnvelopeTimes(writer: CanonicalWriter, envelope: PrivateRfqEnvelope): void {
  writer.writeEnum(EXPIRY_UNIT, envelope.createdAtUnit, 'createdAtUnit');
  writer.writeU64(envelope.createdAtValue, 'createdAtValue');
  writer.writeEnum(EXPIRY_UNIT, envelope.expiresAtUnit, 'expiresAtUnit');
  writer.writeU64(envelope.expiresAtValue, 'expiresAtValue');
  writer.writeU64(envelope.envelopeNonce, 'envelopeNonce');
}

/**
 * The associated data the pinned encryption suite authenticates: every envelope field except the
 * ciphertext hash, which the encryption produces. A relay that alters any header field, recipient,
 * expiry, or nonce makes decryption fail. This module performs no cryptography.
 */
export function privateRfqAssociatedData(input: PrivateRfqEnvelopeInput): Uint8Array {
  const envelope = privateRfqEnvelope(input);
  return canonicalBytes((writer) => {
    encodeEnvelopeHeader(writer, envelope);
    encodeEnvelopeTimes(writer, envelope);
  });
}

/** `sha256("CON/v1/private-rfq-envelope" || canonicalEncode(full versioned PrivateRfqEnvelope))`. */
export function privateRfqEnvelopeHash(input: PrivateRfqEnvelopeInput): CommitmentHash {
  const envelope = privateRfqEnvelope(input);
  const bytes = canonicalBytes((writer) => {
    encodeEnvelopeHeader(writer, envelope);
    encodeCommitmentHash(writer, envelope.ciphertextHash, 'ciphertextHash');
    encodeEnvelopeTimes(writer, envelope);
  });
  return commitmentHash(domainHash(HASH_DOMAIN.PRIVATE_RFQ_ENVELOPE, bytes), 'privateRfqEnvelopeHash');
}

export type PrivateRfqRejection =
  | 'ENVIRONMENT_MISMATCH'
  | 'SUITE_NOT_PINNED'
  | 'RECIPIENT_MISMATCH'
  | 'KEY_UNKNOWN'
  | 'KEY_SUITE_MISMATCH'
  | 'KEY_OUTSIDE_VALIDITY'
  | 'NOT_YET_VALID'
  | 'ENVELOPE_EXPIRED'
  | 'REPLAY'
  | 'CIPHERTEXT_MUTATED';

export interface PrivateRfqAdmission {
  readonly environment: string;
  readonly pinnedSuiteIds: readonly string[];
  /** The recipient's capability manifest; the caller has already verified its operator signature. */
  readonly recipientManifest: SolverCapabilityManifestInput;
  readonly atValue: bigint;
  readonly nonceSeen: boolean;
  /** Hash of the ciphertext bytes actually received from the relay. */
  readonly receivedCiphertextHash: Uint8Array | string;
}

/**
 * Admits an encrypted envelope for decryption by its addressed solver. Replay, cross-environment
 * delivery, recipient or key substitution, suite downgrade, expired keys, and ciphertext mutation
 * all reject before any decryption is attempted.
 */
export function admitPrivateRfqEnvelope(
  input: PrivateRfqEnvelopeInput,
  admission: PrivateRfqAdmission,
): { readonly admitted: true; readonly envelopeHash: CommitmentHash } | { readonly admitted: false; readonly reason: PrivateRfqRejection } {
  const envelope = privateRfqEnvelope(input);
  object(admission, 'admitPrivateRfqEnvelope.admission');
  const manifest = solverCapabilityManifest(admission.recipientManifest);
  const at = unsigned(admission.atValue, U64_BITS, 'admitPrivateRfqEnvelope.atValue');
  const pinned = idSet(admission.pinnedSuiteIds, 'admitPrivateRfqEnvelope.pinnedSuiteIds', 16, true);
  const reject = (reason: PrivateRfqRejection) => Object.freeze({ admitted: false as const, reason });
  const environment = protocolId(admission.environment, 'admitPrivateRfqEnvelope.environment');
  if (envelope.environment !== environment || manifest.environment !== environment) return reject('ENVIRONMENT_MISMATCH');
  if (!pinned.includes(envelope.encryptionSuiteId)) return reject('SUITE_NOT_PINNED');
  if (manifest.solverId !== envelope.recipientSolverId) return reject('RECIPIENT_MISMATCH');
  const key = manifest.rfqEncryptionKeys.find((value) => value.keyId === envelope.recipientEncryptionKeyId);
  if (key === undefined) return reject('KEY_UNKNOWN');
  if (key.encryptionSuiteId !== envelope.encryptionSuiteId) return reject('KEY_SUITE_MISMATCH');
  if (at < key.validFromValue || at >= key.validUntilValue) return reject('KEY_OUTSIDE_VALIDITY');
  if (at < envelope.createdAtValue) return reject('NOT_YET_VALID');
  if (at >= envelope.expiresAtValue) return reject('ENVELOPE_EXPIRED');
  if (bool(admission.nonceSeen, 'admitPrivateRfqEnvelope.nonceSeen')) return reject('REPLAY');
  if (compareBytes(commitmentHash(admission.receivedCiphertextHash, 'admitPrivateRfqEnvelope.receivedCiphertextHash'), envelope.ciphertextHash) !== 0) {
    return reject('CIPHERTEXT_MUTATED');
  }
  return Object.freeze({ admitted: true as const, envelopeHash: privateRfqEnvelopeHash(envelope) });
}

export interface PrivateRfqResponseInput {
  readonly envelopeHash: Uint8Array | string;
  readonly solverId: string;
  readonly quoteHash: Uint8Array | string;
  /** The order hash bound inside the solver's signed quote. */
  readonly quoteOrderHash: Uint8Array | string;
  /** The key the response ciphertext was encrypted to. */
  readonly responseEncryptionKey: Uint8Array;
  readonly responseCiphertextHash: Uint8Array | string;
}

export type PrivateRfqResponseRejection = 'ENVELOPE_MISMATCH' | 'RESPONDER_MISMATCH' | 'RESPONSE_KEY_SUBSTITUTED' | 'QUOTE_ORDER_SUBSTITUTED';

/** Binds an encrypted quote response to its envelope, recipient, response key, and order. */
export function verifyPrivateRfqResponse(
  envelopeInput: PrivateRfqEnvelopeInput,
  response: PrivateRfqResponseInput,
): { readonly valid: true; readonly responseHash: CommitmentHash } | { readonly valid: false; readonly reason: PrivateRfqResponseRejection } {
  const envelope = privateRfqEnvelope(envelopeInput);
  object(response, 'verifyPrivateRfqResponse.response');
  const envelopeHash = privateRfqEnvelopeHash(envelope);
  const reject = (reason: PrivateRfqResponseRejection) => Object.freeze({ valid: false as const, reason });
  if (compareBytes(commitmentHash(response.envelopeHash, 'verifyPrivateRfqResponse.envelopeHash'), envelopeHash) !== 0) return reject('ENVELOPE_MISMATCH');
  const solverId = protocolId(response.solverId, 'verifyPrivateRfqResponse.solverId');
  if (solverId !== envelope.recipientSolverId) return reject('RESPONDER_MISMATCH');
  if (compareBytes(keyBytes(response.responseEncryptionKey, 'verifyPrivateRfqResponse.responseEncryptionKey'), envelope.responseEncryptionKey) !== 0) {
    return reject('RESPONSE_KEY_SUBSTITUTED');
  }
  if (compareBytes(commitmentHash(response.quoteOrderHash, 'verifyPrivateRfqResponse.quoteOrderHash'), envelope.orderHash) !== 0) {
    return reject('QUOTE_ORDER_SUBSTITUTED');
  }
  const quoteHash = commitmentHash(response.quoteHash, 'verifyPrivateRfqResponse.quoteHash');
  const ciphertextHash = commitmentHash(response.responseCiphertextHash, 'verifyPrivateRfqResponse.responseCiphertextHash');
  const bytes = canonicalBytes((writer) => {
    encodeCommitmentHash(writer, envelopeHash, 'envelopeHash');
    encodeProtocolId(writer, solverId, 'solverId');
    encodeCommitmentHash(writer, quoteHash, 'quoteHash');
    encodeCommitmentHash(writer, ciphertextHash, 'responseCiphertextHash');
  });
  return Object.freeze({ valid: true as const, responseHash: commitmentHash(domainHash(HASH_DOMAIN.PRIVATE_RFQ_RESPONSE, bytes), 'privateRfqResponseHash') });
}

export interface PrivateDeliveryStatus {
  readonly requestedMode: DeliveryMode;
  readonly pinnedSuiteAvailable: boolean;
  readonly keyDiscoveryAvailable: boolean;
  readonly eligibleSolverIds: readonly string[];
  /** Solvers that acknowledged receipt of their encrypted envelope. */
  readonly acknowledgedSolverIds: readonly string[];
  readonly publicFallbackConsented: boolean;
}

export type PrivateDeliveryOutcome =
  | { readonly outcome: 'DELIVERED'; readonly mode: DeliveryMode; readonly privacyClaim: boolean; readonly acknowledgedCount: number }
  | { readonly outcome: 'PUBLIC_FALLBACK'; readonly mode: 'PUBLIC_RFQ'; readonly privacyClaim: false; readonly label: 'PRIVATE_PATH_UNAVAILABLE' | 'NO_ELIGIBLE_ACKNOWLEDGEMENT' }
  | { readonly outcome: 'NOT_DELIVERED'; readonly privacyClaim: false; readonly reason: 'PRIVATE_PATH_UNAVAILABLE' | 'NO_ELIGIBLE_ACKNOWLEDGEMENT' };

/**
 * Reports what actually happened to a delivery. Private success needs an acknowledgement from an
 * eligible solver. A failed private path never downgrades silently: it falls back to a visibly
 * labeled public RFQ only with the user's consent, and makes no privacy claim when it does.
 */
export function resolvePrivateDelivery(status: PrivateDeliveryStatus): PrivateDeliveryOutcome {
  object(status, 'resolvePrivateDelivery.status');
  const mode = variant(DELIVERY_MODE, status.requestedMode, 'resolvePrivateDelivery.requestedMode');
  const eligible = new Set<string>(idSet(status.eligibleSolverIds, 'resolvePrivateDelivery.eligibleSolverIds', SEALED_AUCTION_MAX_SOLVERS, true));
  const acknowledged = idSet(status.acknowledgedSolverIds, 'resolvePrivateDelivery.acknowledgedSolverIds', SEALED_AUCTION_MAX_SOLVERS, true)
    .filter((id) => eligible.has(id)).length;
  const consent = bool(status.publicFallbackConsented, 'resolvePrivateDelivery.publicFallbackConsented');
  if (!PRIVATE_DELIVERY_MODES.has(mode)) {
    return Object.freeze({ outcome: 'DELIVERED' as const, mode, privacyClaim: false, acknowledgedCount: acknowledged });
  }
  const pathAvailable = bool(status.pinnedSuiteAvailable, 'resolvePrivateDelivery.pinnedSuiteAvailable')
    && bool(status.keyDiscoveryAvailable, 'resolvePrivateDelivery.keyDiscoveryAvailable');
  const failure = !pathAvailable ? ('PRIVATE_PATH_UNAVAILABLE' as const) : acknowledged === 0 ? ('NO_ELIGIBLE_ACKNOWLEDGEMENT' as const) : undefined;
  if (failure === undefined) return Object.freeze({ outcome: 'DELIVERED' as const, mode, privacyClaim: true, acknowledgedCount: acknowledged });
  if (consent) return Object.freeze({ outcome: 'PUBLIC_FALLBACK' as const, mode: 'PUBLIC_RFQ' as const, privacyClaim: false as const, label: failure });
  return Object.freeze({ outcome: 'NOT_DELIVERED' as const, privacyClaim: false as const, reason: failure });
}

// ------------------------------------------------------------------ sealed batch auction

export interface SealedAuctionDefinitionInput {
  readonly version: number;
  readonly auctionId: string;
  readonly environment: string;
  readonly orderHash: Uint8Array | string;
  readonly eligibleSolverIds: readonly string[];
  readonly timeUnit: ExpiryUnit;
  readonly commitDeadlineValue: bigint;
  readonly revealDeadlineValue: bigint;
  readonly settlementDeadlineValue: bigint;
  readonly minimumValidReveals: number;
}

export interface SealedAuctionDefinition {
  readonly version: number;
  readonly auctionId: ProtocolId;
  readonly environment: ProtocolId;
  readonly orderHash: CommitmentHash;
  readonly eligibleSolverIds: readonly ProtocolId[];
  readonly timeUnit: ExpiryUnit;
  readonly commitDeadlineValue: bigint;
  readonly revealDeadlineValue: bigint;
  readonly settlementDeadlineValue: bigint;
  readonly minimumValidReveals: number;
}

export function sealedAuctionDefinition(input: SealedAuctionDefinitionInput, context = 'sealedAuction'): SealedAuctionDefinition {
  object(input, context);
  if (input.version !== SEALED_AUCTION_VERSION) throw new MalformedInputError(`${context}.version`, `version must equal ${SEALED_AUCTION_VERSION}`);
  const eligibleSolverIds = idSet(input.eligibleSolverIds, `${context}.eligibleSolverIds`, SEALED_AUCTION_MAX_SOLVERS);
  const commit = unsigned(input.commitDeadlineValue, U64_BITS, `${context}.commitDeadlineValue`);
  const reveal = unsigned(input.revealDeadlineValue, U64_BITS, `${context}.revealDeadlineValue`);
  const settlement = unsigned(input.settlementDeadlineValue, U64_BITS, `${context}.settlementDeadlineValue`);
  if (!(commit < reveal && reveal < settlement)) {
    throw new MalformedInputError(context, 'deadlines must strictly increase: commit, reveal, settlement');
  }
  const minimum = input.minimumValidReveals;
  if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > eligibleSolverIds.length) {
    throw new MalformedInputError(`${context}.minimumValidReveals`, 'minimum must be between 1 and the eligible solver count');
  }
  return Object.freeze({
    version: SEALED_AUCTION_VERSION,
    auctionId: protocolId(input.auctionId, `${context}.auctionId`),
    environment: protocolId(input.environment, `${context}.environment`),
    orderHash: commitmentHash(input.orderHash, `${context}.orderHash`),
    eligibleSolverIds,
    timeUnit: variant(EXPIRY_UNIT, input.timeUnit, `${context}.timeUnit`),
    commitDeadlineValue: commit,
    revealDeadlineValue: reveal,
    settlementDeadlineValue: settlement,
    minimumValidReveals: minimum,
  });
}

/** Every deadline is inside this hash, so the coordinator cannot extend one participant's window. */
export function sealedAuctionHash(input: SealedAuctionDefinitionInput): CommitmentHash {
  const definition = sealedAuctionDefinition(input);
  const bytes = canonicalBytes((writer) => {
    writer.writeU32(definition.version, 'version');
    encodeProtocolId(writer, definition.auctionId, 'auctionId');
    encodeProtocolId(writer, definition.environment, 'environment');
    encodeCommitmentHash(writer, definition.orderHash, 'orderHash');
    writer.writeArray(definition.eligibleSolverIds, (element, id) => encodeProtocolId(element, id, 'eligibleSolverId'));
    writer.writeEnum(EXPIRY_UNIT, definition.timeUnit, 'timeUnit');
    writer.writeU64(definition.commitDeadlineValue, 'commitDeadlineValue');
    writer.writeU64(definition.revealDeadlineValue, 'revealDeadlineValue');
    writer.writeU64(definition.settlementDeadlineValue, 'settlementDeadlineValue');
    writer.writeU32(definition.minimumValidReveals, 'minimumValidReveals');
  });
  return commitmentHash(domainHash(HASH_DOMAIN.SEALED_AUCTION, bytes), 'sealedAuctionHash');
}

export interface SealedQuoteOpening {
  readonly solverId: string;
  readonly quoteHash: Uint8Array | string;
  /** Fee-complete net package outcome in quote atoms; higher is better for the taker. */
  readonly netOutcomeAtoms: bigint;
  readonly salt: Uint8Array;
}

/** The binding, hiding commitment a solver submits before the commit deadline. */
export function sealedQuoteCommitment(auctionHash: Uint8Array | string, opening: SealedQuoteOpening): CommitmentHash {
  object(opening, 'sealedQuoteCommitment.opening');
  assertUint8Array(opening.salt, 'sealedQuoteCommitment.salt');
  if (opening.salt.length !== SEALED_SALT_BYTES) throw new MalformedInputError('sealedQuoteCommitment.salt', `salt must be ${SEALED_SALT_BYTES} bytes`);
  if (typeof opening.netOutcomeAtoms !== 'bigint') throw new MalformedInputError('sealedQuoteCommitment.netOutcomeAtoms', 'expected a bigint');
  const bytes = canonicalBytes((writer) => {
    encodeCommitmentHash(writer, commitmentHash(auctionHash, 'sealedQuoteCommitment.auctionHash'), 'auctionHash');
    encodeProtocolId(writer, protocolId(opening.solverId, 'sealedQuoteCommitment.solverId'), 'solverId');
    encodeCommitmentHash(writer, commitmentHash(opening.quoteHash, 'sealedQuoteCommitment.quoteHash'), 'quoteHash');
    writer.writeI128(checkedSigned(opening.netOutcomeAtoms, I128_BITS, 'sealedQuoteCommitment.netOutcomeAtoms'), 'netOutcomeAtoms');
    writer.writeFixedBytes(opening.salt, SEALED_SALT_BYTES, 'salt');
  });
  return commitmentHash(domainHash(HASH_DOMAIN.SEALED_COMMITMENT, bytes), 'sealedQuoteCommitment');
}

export type SealedAuctionEvent =
  | { readonly kind: 'COMMIT'; readonly solverId: string; readonly commitment: Uint8Array | string; readonly atValue: bigint }
  | ({ readonly kind: 'REVEAL'; readonly atValue: bigint } & SealedQuoteOpening);

export type SealedAuctionRejection =
  | 'OUT_OF_ORDER'
  | 'AUCTION_CLOSED'
  | 'NOT_ELIGIBLE'
  | 'COMMIT_CLOSED'
  | 'DUPLICATE_COMMIT'
  | 'EARLY_REVEAL'
  | 'REVEAL_CLOSED'
  | 'NO_COMMITMENT'
  | 'DUPLICATE_REVEAL'
  | 'REVEAL_MISMATCH';

interface SealedCommitmentEntry {
  readonly solverId: ProtocolId;
  readonly commitment: CommitmentHash;
}

export interface SealedRevealEntry {
  readonly solverId: ProtocolId;
  readonly commitment: CommitmentHash;
  readonly quoteHash: CommitmentHash;
  readonly netOutcomeAtoms: bigint;
}

export interface SealedAuctionState {
  readonly definition: SealedAuctionDefinition;
  readonly auctionHash: CommitmentHash;
  readonly lastEventAtValue: bigint;
  readonly commitments: readonly SealedCommitmentEntry[];
  readonly reveals: readonly SealedRevealEntry[];
}

export function openSealedAuction(input: SealedAuctionDefinitionInput): SealedAuctionState {
  const definition = sealedAuctionDefinition(input);
  return Object.freeze({ definition, auctionHash: sealedAuctionHash(definition), lastEventAtValue: 0n, commitments: Object.freeze([]), reveals: Object.freeze([]) });
}

/**
 * Applies one coordinator log event. Events must arrive in nondecreasing time. Commits close at the
 * commit deadline for every solver at once; reveals open only after it, so no reveal can inform a
 * later commitment. A rejected event leaves the state unchanged.
 */
export function applySealedAuctionEvent(
  state: SealedAuctionState,
  event: SealedAuctionEvent,
): { readonly accepted: true; readonly state: SealedAuctionState } | { readonly accepted: false; readonly reason: SealedAuctionRejection } {
  object(event, 'sealedAuctionEvent');
  const at = unsigned(event.atValue, U64_BITS, 'sealedAuctionEvent.atValue');
  const reject = (reason: SealedAuctionRejection) => Object.freeze({ accepted: false as const, reason });
  const { definition } = state;
  if (at < state.lastEventAtValue) return reject('OUT_OF_ORDER');
  if (at >= definition.revealDeadlineValue) return reject('AUCTION_CLOSED');
  const solverId = protocolId(event.solverId, 'sealedAuctionEvent.solverId');
  if (!definition.eligibleSolverIds.includes(solverId)) return reject('NOT_ELIGIBLE');
  const committed = state.commitments.find((entry) => entry.solverId === solverId);
  const advance = (changes: Partial<SealedAuctionState>) =>
    Object.freeze({ accepted: true as const, state: Object.freeze({ ...state, ...changes, lastEventAtValue: at }) });
  if (event.kind === 'COMMIT') {
    if (at >= definition.commitDeadlineValue) return reject('COMMIT_CLOSED');
    if (committed !== undefined) return reject('DUPLICATE_COMMIT');
    const entry = Object.freeze({ solverId, commitment: commitmentHash(event.commitment, 'sealedAuctionEvent.commitment') });
    return advance({ commitments: Object.freeze([...state.commitments, entry].sort((a, b) => (a.solverId < b.solverId ? -1 : 1))) });
  }
  if (event.kind !== 'REVEAL') throw new MalformedInputError('sealedAuctionEvent.kind', 'expected COMMIT or REVEAL');
  if (at < definition.commitDeadlineValue) return reject('EARLY_REVEAL');
  if (committed === undefined) return reject('NO_COMMITMENT');
  if (state.reveals.some((entry) => entry.solverId === solverId)) return reject('DUPLICATE_REVEAL');
  if (compareBytes(sealedQuoteCommitment(state.auctionHash, event), committed.commitment) !== 0) return reject('REVEAL_MISMATCH');
  const reveal = Object.freeze({
    solverId,
    commitment: committed.commitment,
    quoteHash: commitmentHash(event.quoteHash, 'sealedAuctionEvent.quoteHash'),
    netOutcomeAtoms: event.netOutcomeAtoms,
  });
  return advance({ reveals: Object.freeze([...state.reveals, reveal].sort((a, b) => (a.solverId < b.solverId ? -1 : 1))) });
}

/** Before close, only the phase and commitment count are public; identities and reveals are withheld. */
export function sealedAuctionPublicView(state: SealedAuctionState, atValue: bigint): { readonly phase: 'COMMIT' | 'REVEAL' | 'CLOSED'; readonly commitmentCount: number } {
  const at = unsigned(atValue, U64_BITS, 'sealedAuctionPublicView.atValue');
  const phase = at < state.definition.commitDeadlineValue ? 'COMMIT' : at < state.definition.revealDeadlineValue ? 'REVEAL' : 'CLOSED';
  return Object.freeze({ phase, commitmentCount: state.commitments.length });
}

export interface SealedAuctionResult {
  readonly auctionHash: CommitmentHash;
  readonly outcome: 'AWARDED' | 'NO_FILL';
  readonly winner?: SealedRevealEntry;
  /** Valid reveals by net outcome, best first; exact ties break by commitment hash. */
  readonly ranked: readonly SealedRevealEntry[];
  /** Committed solvers that never revealed: a recorded fault, excluded from selection. */
  readonly missingRevealSolverIds: readonly ProtocolId[];
  readonly resultHash: CommitmentHash;
}

function rankReveals(reveals: readonly SealedRevealEntry[]): readonly SealedRevealEntry[] {
  return Object.freeze(
    [...reveals].sort((left, right) =>
      left.netOutcomeAtoms !== right.netOutcomeAtoms ? (left.netOutcomeAtoms > right.netOutcomeAtoms ? -1 : 1) : compareBytes(left.commitment, right.commitment),
    ),
  );
}

/**
 * Closes the auction once the reveal deadline has passed, or earlier after the commit deadline when
 * every committed solver has revealed. The result depends only on the log, never on close time, so
 * a restarted coordinator recomputes the same winner and result hash.
 */
export function closeSealedAuction(
  state: SealedAuctionState,
  atValue: bigint,
): { readonly closed: true; readonly result: SealedAuctionResult } | { readonly closed: false; readonly reason: 'COMMIT_WINDOW_OPEN' | 'REVEALS_PENDING' } {
  const at = unsigned(atValue, U64_BITS, 'closeSealedAuction.atValue');
  const { definition } = state;
  if (at < definition.commitDeadlineValue) return Object.freeze({ closed: false as const, reason: 'COMMIT_WINDOW_OPEN' as const });
  if (at < definition.revealDeadlineValue && state.reveals.length < state.commitments.length) {
    return Object.freeze({ closed: false as const, reason: 'REVEALS_PENDING' as const });
  }
  const ranked = rankReveals(state.reveals);
  const revealed = new Set<string>(state.reveals.map((entry) => entry.solverId));
  const missingRevealSolverIds = Object.freeze(state.commitments.filter((entry) => !revealed.has(entry.solverId)).map((entry) => entry.solverId));
  const awarded = ranked.length >= definition.minimumValidReveals;
  const winner = awarded ? ranked[0] : undefined;
  const bytes = canonicalBytes((writer) => {
    encodeCommitmentHash(writer, state.auctionHash, 'auctionHash');
    writer.writeArray(state.commitments, (element, entry) => {
      encodeProtocolId(element, entry.solverId, 'solverId');
      encodeCommitmentHash(element, entry.commitment, 'commitment');
    });
    writer.writeArray(ranked, (element, entry) => {
      encodeProtocolId(element, entry.solverId, 'solverId');
      encodeCommitmentHash(element, entry.quoteHash, 'quoteHash');
      element.writeI128(entry.netOutcomeAtoms, 'netOutcomeAtoms');
    });
    writer.writeArray(missingRevealSolverIds, (element, id) => encodeProtocolId(element, id, 'missingRevealSolverId'));
    writer.writeOptional(winner, (element, entry) => encodeProtocolId(element, entry.solverId, 'winner'), 'winner');
  });
  const base = {
    auctionHash: state.auctionHash,
    outcome: awarded ? ('AWARDED' as const) : ('NO_FILL' as const),
    ranked,
    missingRevealSolverIds,
    resultHash: commitmentHash(domainHash(HASH_DOMAIN.SEALED_AUCTION_RESULT, bytes), 'sealedAuctionResultHash'),
  };
  return Object.freeze({ closed: true as const, result: Object.freeze(winner === undefined ? base : { ...base, winner }) });
}

/** Rebuilds the auction from its durable event log, reporting every rejected event by index. */
export function replaySealedAuction(
  input: SealedAuctionDefinitionInput,
  events: readonly SealedAuctionEvent[],
  closeAtValue: bigint,
): { readonly result: SealedAuctionResult; readonly rejected: readonly { readonly index: number; readonly reason: SealedAuctionRejection }[] } {
  requireArray(events, 'replaySealedAuction.events', SEALED_AUCTION_MAX_SOLVERS * 4);
  let state = openSealedAuction(input);
  const rejected: { index: number; reason: SealedAuctionRejection }[] = [];
  events.forEach((event, index) => {
    const applied = applySealedAuctionEvent(state, event);
    if (applied.accepted) state = applied.state;
    else rejected.push({ index, reason: applied.reason });
  });
  const closed = closeSealedAuction(state, closeAtValue);
  if (!closed.closed) throw new MalformedInputError('replaySealedAuction.closeAtValue', `auction cannot close yet: ${closed.reason}`);
  return Object.freeze({ result: closed.result, rejected: Object.freeze(rejected) });
}

/** Detects a coordinator that reports anything other than the deterministic result of its own log. */
export function verifySealedAuctionResult(
  input: SealedAuctionDefinitionInput,
  events: readonly SealedAuctionEvent[],
  closeAtValue: bigint,
  claimedResultHash: Uint8Array | string,
): boolean {
  const { result } = replaySealedAuction(input, events, closeAtValue);
  return compareBytes(result.resultHash, commitmentHash(claimedResultHash, 'verifySealedAuctionResult.claimedResultHash')) === 0;
}

/**
 * After a winner fails to settle, the award moves to the next valid reveal in rank order, never to
 * an unranked or missing quote, and never after the settlement deadline.
 */
export function sealedAuctionFallback(
  input: SealedAuctionDefinitionInput,
  result: SealedAuctionResult,
  failedSolverIds: readonly string[],
  atValue: bigint,
): { readonly outcome: 'AWARDED'; readonly award: SealedRevealEntry } | { readonly outcome: 'NO_FILL'; readonly reason: 'SETTLEMENT_DEADLINE_PASSED' | 'NO_REMAINING_QUOTE' } {
  const definition = sealedAuctionDefinition(input);
  if (compareBytes(sealedAuctionHash(definition), result.auctionHash) !== 0) {
    throw new MalformedInputError('sealedAuctionFallback.result', 'result belongs to another auction');
  }
  if (unsigned(atValue, U64_BITS, 'sealedAuctionFallback.atValue') >= definition.settlementDeadlineValue) {
    return Object.freeze({ outcome: 'NO_FILL' as const, reason: 'SETTLEMENT_DEADLINE_PASSED' as const });
  }
  if (result.outcome !== 'AWARDED') return Object.freeze({ outcome: 'NO_FILL' as const, reason: 'NO_REMAINING_QUOTE' as const });
  const failed = new Set<string>(idSet(failedSolverIds, 'sealedAuctionFallback.failedSolverIds', SEALED_AUCTION_MAX_SOLVERS));
  const award = result.ranked.find((entry) => !failed.has(entry.solverId));
  return award === undefined
    ? Object.freeze({ outcome: 'NO_FILL' as const, reason: 'NO_REMAINING_QUOTE' as const })
    : Object.freeze({ outcome: 'AWARDED' as const, award });
}
