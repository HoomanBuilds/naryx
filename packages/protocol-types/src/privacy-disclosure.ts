import { checkedUnsigned } from './arithmetic.js';
import { assertUint8Array, compareBytes } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { enumDiscriminant, type EnumTable } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { DELIVERY_MODE, PRIVATE_DELIVERY_MODES, type DeliveryMode } from './private-delivery.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';

export const DISCLOSURE_SALT_BYTES = 32;
export const DISCLOSURE_MAX_FIELDS = 64;
const MAX_FIELD_BYTES = 4_096;
const U64_BITS = 64;

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function requireArray(value: unknown, context: string, maximum: number): void {
  if (!Array.isArray(value)) throw new MalformedInputError(context, 'expected an array');
  if (value.length > maximum) throw new MalformedInputError(context, `more than ${maximum} entries`);
}

function bool(value: boolean, context: string): boolean {
  if (typeof value !== 'boolean') throw new MalformedInputError(context, 'expected a boolean');
  return value;
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

// ------------------------------------------------------------------ visibility matrix

export const VISIBILITY_SUBJECT = Object.freeze({
  ORDER_CONTENTS: 1,
  TRADE_DIRECTION: 2,
  DISCOVERY_QUERIES: 3,
  SELECTED_SOLVER_SET: 4,
  SOLVER_QUOTES: 5,
  NETWORK_METADATA: 6,
  WALLET_IDENTITY: 7,
  COLLATERAL: 8,
  VENUE_POSITIONS: 9,
  ENRICHED_RECEIPT: 10,
} as const);
export type VisibilitySubject = keyof typeof VISIBILITY_SUBJECT;

export const PRIVACY_OBSERVER = Object.freeze({
  RELAY: 1,
  SELECTED_SOLVERS: 2,
  UNSELECTED_SOLVERS: 3,
  PUBLIC: 4,
} as const);
export type PrivacyObserver = keyof typeof PRIVACY_OBSERVER;

export const VISIBILITY = Object.freeze({
  HIDDEN: 1,
  METADATA_ONLY: 2,
  DELAYED: 3,
  VISIBLE: 4,
} as const);
export type Visibility = keyof typeof VISIBILITY;

export const DISCOVERY_MODE = Object.freeze({
  LOCAL_CATALOGUE: 1,
  PADDED_RELAY_QUERY: 2,
  DIRECT_RELAY_QUERY: 3,
} as const);
export type DiscoveryMode = keyof typeof DISCOVERY_MODE;

export const PRIVACY_CLAIM = Object.freeze({
  CONTENT_CONFIDENTIALITY: 1,
  SOLVER_QUOTE_SECRECY: 2,
  TRAFFIC_PRIVACY: 3,
  SOLVER_SET_HIDING: 4,
  DISCOVERY_PRIVACY: 5,
} as const);
export type PrivacyClaim = keyof typeof PRIVACY_CLAIM;

export const LEAKAGE_CHANNEL = Object.freeze({
  SIZE: 1,
  TIMING: 2,
  SENDER: 3,
  SOLVER_SELECTION: 4,
  DIRECTION: 5,
  DISCOVERY_INTENT: 6,
  NETWORK_ORIGIN: 7,
  PUBLIC_SETTLEMENT: 8,
  DOWNGRADE: 9,
} as const);
export type LeakageChannel = keyof typeof LEAKAGE_CHANNEL;

export const LEAKAGE_SEVERITY = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3 } as const);
export type LeakageSeverity = keyof typeof LEAKAGE_SEVERITY;

export interface PrivacyConfiguration {
  readonly requestedMode: DeliveryMode;
  readonly discoveryMode: DiscoveryMode;
  /** False when the pinned suite or key discovery is unavailable; a private request then runs as public RFQ. */
  readonly privatePathAvailable: boolean;
  readonly transportHidesNetworkOrigin: boolean;
  readonly transportPadsCiphertext: boolean;
  readonly transportHidesSolverSet: boolean;
  readonly takerIdentity: 'ANONYMOUS' | 'DISCLOSED';
  /** Solvers quote both sides so the taker's direction is not revealed before selection. */
  readonly blindTwoWay: boolean;
  readonly enrichedReceiptDelayValue: bigint;
}

export interface VisibilityCell {
  readonly subject: VisibilitySubject;
  readonly observer: PrivacyObserver;
  readonly preTrade: Visibility;
  readonly postTrade: Visibility;
}

export interface LeakageItem {
  readonly channel: LeakageChannel;
  readonly observer: PrivacyObserver;
  readonly severity: LeakageSeverity;
}

export interface PrivacyProfile {
  readonly requestedMode: DeliveryMode;
  readonly effectiveMode: DeliveryMode;
  readonly downgraded: boolean;
  readonly matrix: readonly VisibilityCell[];
  readonly leakage: readonly LeakageItem[];
  readonly claims: readonly PrivacyClaim[];
  readonly profileHash: CommitmentHash;
}

type Row = Readonly<Record<PrivacyObserver, readonly [Visibility, Visibility]>>;

function row(relay: readonly [Visibility, Visibility], selected: readonly [Visibility, Visibility], unselected: readonly [Visibility, Visibility], open: readonly [Visibility, Visibility]): Row {
  return { RELAY: relay, SELECTED_SOLVERS: selected, UNSELECTED_SOLVERS: unselected, PUBLIC: open };
}

/**
 * Derives the exact pre-trade and post-trade visibility of every subject to every observer, the
 * metadata that still leaks, and the only privacy labels the interface may show. Settlement runs on
 * a public domain, so wallet, collateral, venue positions, and executed legs are always public after
 * the trade; no post-trade privacy is ever claimed.
 */
export function privacyProfile(config: PrivacyConfiguration): PrivacyProfile {
  object(config, 'privacyProfile.config');
  const requestedMode = variant(DELIVERY_MODE, config.requestedMode, 'privacyProfile.requestedMode');
  const discoveryMode = variant(DISCOVERY_MODE, config.discoveryMode, 'privacyProfile.discoveryMode');
  const pathAvailable = bool(config.privatePathAvailable, 'privacyProfile.privatePathAvailable');
  const hidesOrigin = bool(config.transportHidesNetworkOrigin, 'privacyProfile.transportHidesNetworkOrigin');
  const pads = bool(config.transportPadsCiphertext, 'privacyProfile.transportPadsCiphertext');
  const hidesSet = bool(config.transportHidesSolverSet, 'privacyProfile.transportHidesSolverSet');
  const blind = bool(config.blindTwoWay, 'privacyProfile.blindTwoWay');
  if (config.takerIdentity !== 'ANONYMOUS' && config.takerIdentity !== 'DISCLOSED') {
    throw new MalformedInputError('privacyProfile.takerIdentity', 'expected ANONYMOUS or DISCLOSED');
  }
  const anonymous = config.takerIdentity === 'ANONYMOUS';
  if (typeof config.enrichedReceiptDelayValue !== 'bigint') throw new MalformedInputError('privacyProfile.enrichedReceiptDelayValue', 'expected a bigint');
  const delay = checkedUnsigned(config.enrichedReceiptDelayValue, U64_BITS, 'privacyProfile.enrichedReceiptDelayValue');

  const downgraded = PRIVATE_DELIVERY_MODES.has(requestedMode) && !pathAvailable;
  const effectiveMode: DeliveryMode = downgraded ? 'PUBLIC_RFQ' : requestedMode;
  const isPrivate = PRIVATE_DELIVERY_MODES.has(effectiveMode);
  const sealed = effectiveMode === 'SEALED_BATCH_AUCTION';

  const V: Visibility = 'VISIBLE';
  const H: Visibility = 'HIDDEN';
  const M: Visibility = 'METADATA_ONLY';
  const receiptPublic: Visibility = delay > 0n ? 'DELAYED' : 'VISIBLE';
  const discovery: Visibility = discoveryMode === 'LOCAL_CATALOGUE' ? H : discoveryMode === 'PADDED_RELAY_QUERY' ? M : V;
  const walletPre: Visibility = isPrivate ? H : V;

  const rows: Readonly<Record<VisibilitySubject, Row>> = {
    ORDER_CONTENTS: isPrivate ? row([M, V], [V, V], [H, V], [H, V]) : row([V, V], [V, V], [V, V], [V, V]),
    TRADE_DIRECTION: isPrivate ? row([H, V], [blind ? H : V, V], [H, V], [H, V]) : row([V, V], [V, V], [V, V], [V, V]),
    DISCOVERY_QUERIES: row([discovery, discovery], [H, H], [H, H], [H, H]),
    SELECTED_SOLVER_SET: isPrivate ? row([hidesSet ? H : V, hidesSet ? H : V], [hidesSet ? H : M, M], [H, H], [H, M]) : row([V, V], [V, V], [V, V], [V, V]),
    SOLVER_QUOTES: sealed
      ? row([M, V], [H, V], [H, H], [H, M])
      : isPrivate
        ? row([M, M], [H, H], [H, H], [H, M])
        : effectiveMode === 'PUBLIC_RFQ'
          ? row([V, V], [M, M], [H, H], [H, M])
          : row([V, V], [V, V], [V, V], [V, V]),
    NETWORK_METADATA: row([hidesOrigin ? M : V, hidesOrigin ? M : V], [M, M], [H, H], [isPrivate ? H : M, M]),
    WALLET_IDENTITY: row([V, V], [anonymous && isPrivate ? H : V, V], [walletPre, V], [walletPre, V]),
    COLLATERAL: row([walletPre, V], [anonymous && isPrivate ? H : V, V], [walletPre, V], [walletPre, V]),
    VENUE_POSITIONS: row([walletPre, V], [anonymous && isPrivate ? H : V, V], [walletPre, V], [walletPre, V]),
    ENRICHED_RECEIPT: row([H, receiptPublic], [H, V], [H, receiptPublic], [H, receiptPublic]),
  };
  const matrix = Object.freeze(
    (Object.keys(VISIBILITY_SUBJECT) as VisibilitySubject[]).flatMap((subject) =>
      (Object.keys(PRIVACY_OBSERVER) as PrivacyObserver[]).map((observer) => {
        const [preTrade, postTrade] = rows[subject][observer];
        return Object.freeze({ subject, observer, preTrade, postTrade });
      }),
    ),
  );

  const leakage: LeakageItem[] = [];
  const leak = (channel: LeakageChannel, observer: PrivacyObserver, severity: LeakageSeverity) => leakage.push(Object.freeze({ channel, observer, severity }));
  if (isPrivate) {
    leak('SIZE', 'RELAY', pads ? 'LOW' : 'MEDIUM');
    leak('TIMING', 'RELAY', 'MEDIUM');
    leak('SENDER', 'RELAY', 'MEDIUM');
    if (!anonymous) leak('SENDER', 'SELECTED_SOLVERS', 'MEDIUM');
    if (!hidesSet) leak('SOLVER_SELECTION', 'RELAY', 'MEDIUM');
    if (!blind) leak('DIRECTION', 'SELECTED_SOLVERS', 'MEDIUM');
  } else {
    leak('SIZE', 'PUBLIC', 'HIGH');
    leak('TIMING', 'PUBLIC', 'HIGH');
    leak('SENDER', 'PUBLIC', 'HIGH');
    leak('DIRECTION', 'PUBLIC', 'HIGH');
  }
  if (discoveryMode !== 'LOCAL_CATALOGUE') leak('DISCOVERY_INTENT', 'RELAY', discoveryMode === 'PADDED_RELAY_QUERY' ? 'LOW' : 'HIGH');
  if (!hidesOrigin) leak('NETWORK_ORIGIN', 'RELAY', 'MEDIUM');
  leak('PUBLIC_SETTLEMENT', 'PUBLIC', 'HIGH');
  if (downgraded) leak('DOWNGRADE', 'PUBLIC', 'HIGH');

  const claims: PrivacyClaim[] = [];
  if (isPrivate) claims.push('CONTENT_CONFIDENTIALITY');
  if (sealed) claims.push('SOLVER_QUOTE_SECRECY');
  if (isPrivate && hidesOrigin && pads) claims.push('TRAFFIC_PRIVACY');
  if (isPrivate && hidesSet) claims.push('SOLVER_SET_HIDING');
  if (discoveryMode === 'LOCAL_CATALOGUE') claims.push('DISCOVERY_PRIVACY');

  const bytes = canonicalBytes((writer) => {
    writer.writeEnum(DELIVERY_MODE, requestedMode, 'requestedMode');
    writer.writeEnum(DELIVERY_MODE, effectiveMode, 'effectiveMode');
    writer.writeEnum(DISCOVERY_MODE, discoveryMode, 'discoveryMode');
    for (const flag of [pathAvailable, hidesOrigin, pads, hidesSet, anonymous, blind]) writer.writeBool(flag);
    writer.writeU64(delay, 'enrichedReceiptDelayValue');
    writer.writeArray(matrix, (element, cell) => {
      element.writeEnum(VISIBILITY_SUBJECT, cell.subject);
      element.writeEnum(PRIVACY_OBSERVER, cell.observer);
      element.writeEnum(VISIBILITY, cell.preTrade);
      element.writeEnum(VISIBILITY, cell.postTrade);
    });
    writer.writeArray(leakage, (element, item) => {
      element.writeEnum(LEAKAGE_CHANNEL, item.channel);
      element.writeEnum(PRIVACY_OBSERVER, item.observer);
      element.writeEnum(LEAKAGE_SEVERITY, item.severity);
    });
    writer.writeArray(claims, (element, claim) => element.writeEnum(PRIVACY_CLAIM, claim));
  });
  return Object.freeze({
    requestedMode,
    effectiveMode,
    downgraded,
    matrix,
    leakage: Object.freeze(leakage),
    claims: Object.freeze(claims),
    profileHash: commitmentHash(domainHash(HASH_DOMAIN.PRIVACY_PROFILE, bytes), 'privacyProfileHash'),
  });
}

/** Pads a relay query or ciphertext to the next power-of-two bucket so exact size does not leak. */
export function paddedLength(byteLength: number, minimumBucket: number): number {
  for (const [value, name] of [[byteLength, 'byteLength'], [minimumBucket, 'minimumBucket']] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new MalformedInputError(`paddedLength.${name}`, 'expected a nonnegative integer');
  }
  if (minimumBucket === 0 || (minimumBucket & (minimumBucket - 1)) !== 0) {
    throw new MalformedInputError('paddedLength.minimumBucket', 'bucket must be a power of two');
  }
  let bucket = minimumBucket;
  while (bucket < byteLength) {
    bucket *= 2;
    if (!Number.isSafeInteger(bucket)) throw new MalformedInputError('paddedLength.byteLength', 'length exceeds the padding range');
  }
  return bucket;
}

// ------------------------------------------------------------------ selective disclosure

export interface DisclosureFieldInput {
  readonly name: string;
  readonly value: Uint8Array;
  /** Fresh random bytes per field, so a withheld low-entropy value cannot be guessed from its leaf. */
  readonly salt: Uint8Array;
}

export interface DisclosureField {
  readonly name: ProtocolId;
  readonly value: Uint8Array;
  readonly salt: Uint8Array;
  readonly leaf: CommitmentHash;
}

export interface DisclosureRecord {
  readonly recordId: ProtocolId;
  readonly fields: readonly DisclosureField[];
  readonly root: CommitmentHash;
}

export interface SelectiveDisclosure {
  readonly recordId: ProtocolId;
  readonly revealed: readonly { readonly name: ProtocolId; readonly value: Uint8Array; readonly salt: Uint8Array }[];
  readonly withheld: readonly { readonly name: ProtocolId; readonly leaf: CommitmentHash }[];
}

function fieldLeaf(recordId: ProtocolId, name: ProtocolId, value: Uint8Array, salt: Uint8Array, context: string): CommitmentHash {
  assertUint8Array(value, `${context}.value`);
  assertUint8Array(salt, `${context}.salt`);
  if (value.length > MAX_FIELD_BYTES) throw new MalformedInputError(`${context}.value`, `field exceeds ${MAX_FIELD_BYTES} bytes`);
  if (salt.length !== DISCLOSURE_SALT_BYTES) throw new MalformedInputError(`${context}.salt`, `salt must be ${DISCLOSURE_SALT_BYTES} bytes`);
  const bytes = canonicalBytes((writer) => {
    encodeProtocolId(writer, recordId, 'recordId');
    encodeProtocolId(writer, name, 'name');
    writer.writeFixedBytes(salt, DISCLOSURE_SALT_BYTES, 'salt');
    writer.writeByteString(value, 'value');
  });
  return commitmentHash(domainHash(HASH_DOMAIN.DISCLOSURE_FIELD, bytes), context);
}

function disclosureRoot(recordId: ProtocolId, leaves: readonly { readonly name: ProtocolId; readonly leaf: CommitmentHash }[]): CommitmentHash {
  const sorted = [...leaves].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (let index = 1; index < sorted.length; index += 1) {
    if ((sorted[index - 1] as { name: string }).name === (sorted[index] as { name: string }).name) {
      throw new DuplicateElementError('disclosure.fields', 'field names repeat');
    }
  }
  const bytes = canonicalBytes((writer) => {
    encodeProtocolId(writer, recordId, 'recordId');
    writer.writeArray(sorted, (element, entry) => {
      encodeProtocolId(element, entry.name, 'name');
      encodeCommitmentHash(element, entry.leaf, 'leaf');
    });
  });
  return commitmentHash(domainHash(HASH_DOMAIN.DISCLOSURE_ROOT, bytes), 'disclosureRoot');
}

/** Commits every field of a receipt or report so any subset can later be disclosed and verified. */
export function commitDisclosureRecord(recordId: string, fields: readonly DisclosureFieldInput[]): DisclosureRecord {
  const id = protocolId(recordId, 'commitDisclosureRecord.recordId');
  requireArray(fields, 'commitDisclosureRecord.fields', DISCLOSURE_MAX_FIELDS);
  if (fields.length === 0) throw new MalformedInputError('commitDisclosureRecord.fields', 'a record needs a field');
  const committed = fields.map((field, index) => {
    const at = `commitDisclosureRecord.fields[${index}]`;
    object(field, at);
    const name = protocolId(field.name, `${at}.name`);
    const leaf = fieldLeaf(id, name, field.value, field.salt, at);
    return Object.freeze({ name, value: Uint8Array.from(field.value), salt: Uint8Array.from(field.salt), leaf });
  });
  const root = disclosureRoot(id, committed);
  return Object.freeze({ recordId: id, fields: Object.freeze([...committed].sort((a, b) => (a.name < b.name ? -1 : 1))), root });
}

/** Reveals only the named fields; every other field is represented by its salted leaf alone. */
export function discloseFields(record: DisclosureRecord, names: readonly string[]): SelectiveDisclosure {
  requireArray(names, 'discloseFields.names', DISCLOSURE_MAX_FIELDS);
  const wanted = new Set<string>(names.map((name) => protocolId(name, 'discloseFields.names')));
  for (const name of wanted) {
    if (!record.fields.some((field) => field.name === name)) throw new MalformedInputError('discloseFields.names', `no field ${name}`);
  }
  return Object.freeze({
    recordId: record.recordId,
    revealed: Object.freeze(record.fields.filter((field) => wanted.has(field.name)).map((field) => Object.freeze({ name: field.name, value: Uint8Array.from(field.value), salt: Uint8Array.from(field.salt) }))),
    withheld: Object.freeze(record.fields.filter((field) => !wanted.has(field.name)).map((field) => Object.freeze({ name: field.name, leaf: field.leaf }))),
  });
}

/** Verifies a disclosure against the committed root and returns the revealed values by name. */
export function verifySelectiveDisclosure(expectedRoot: Uint8Array | string, disclosure: SelectiveDisclosure): ReadonlyMap<string, Uint8Array> {
  object(disclosure, 'verifySelectiveDisclosure.disclosure');
  const recordId = protocolId(disclosure.recordId, 'verifySelectiveDisclosure.recordId');
  requireArray(disclosure.revealed, 'verifySelectiveDisclosure.revealed', DISCLOSURE_MAX_FIELDS);
  requireArray(disclosure.withheld, 'verifySelectiveDisclosure.withheld', DISCLOSURE_MAX_FIELDS);
  const revealed = disclosure.revealed.map((field, index) => {
    const at = `verifySelectiveDisclosure.revealed[${index}]`;
    object(field, at);
    const name = protocolId(field.name, `${at}.name`);
    return { name, value: field.value, leaf: fieldLeaf(recordId, name, field.value, field.salt, at) };
  });
  const withheld = disclosure.withheld.map((field, index) => {
    object(field, `verifySelectiveDisclosure.withheld[${index}]`);
    return { name: protocolId(field.name, `verifySelectiveDisclosure.withheld[${index}].name`), leaf: commitmentHash(field.leaf, `verifySelectiveDisclosure.withheld[${index}].leaf`) };
  });
  const root = disclosureRoot(recordId, [...revealed, ...withheld]);
  if (compareBytes(root, commitmentHash(expectedRoot, 'verifySelectiveDisclosure.expectedRoot')) !== 0) {
    throw new MalformedInputError('verifySelectiveDisclosure', 'disclosure does not match the committed root');
  }
  return new Map(revealed.map((field) => [field.name, Uint8Array.from(field.value)]));
}

export const DISCLOSURE_AUDIENCE = Object.freeze({
  COUNTERPARTY: 1,
  AUDITOR: 2,
  PUBLIC: 3,
} as const);
export type DisclosureAudience = keyof typeof DISCLOSURE_AUDIENCE;

export interface DisclosureRule {
  readonly audience: DisclosureAudience;
  readonly fieldNames: readonly string[];
  /** Time after record creation before the audience may receive these fields. */
  readonly delayValue: bigint;
}

/**
 * Lists the fields an audience may receive now. A delay postpones protocol-enriched data only; it
 * cannot hide a transaction or position already public on the settlement domain.
 */
export function permittedDisclosureFields(
  rules: readonly DisclosureRule[],
  audience: DisclosureAudience,
  createdAtValue: bigint,
  atValue: bigint,
): readonly ProtocolId[] {
  requireArray(rules, 'permittedDisclosureFields.rules', DISCLOSURE_MAX_FIELDS);
  variant(DISCLOSURE_AUDIENCE, audience, 'permittedDisclosureFields.audience');
  const created = checkedUnsigned(createdAtValue, U64_BITS, 'permittedDisclosureFields.createdAtValue');
  const at = checkedUnsigned(atValue, U64_BITS, 'permittedDisclosureFields.atValue');
  const permitted = new Set<ProtocolId>();
  rules.forEach((rule, index) => {
    const context = `permittedDisclosureFields.rules[${index}]`;
    object(rule, context);
    variant(DISCLOSURE_AUDIENCE, rule.audience, `${context}.audience`);
    requireArray(rule.fieldNames, `${context}.fieldNames`, DISCLOSURE_MAX_FIELDS);
    const delay = checkedUnsigned(rule.delayValue, U64_BITS, `${context}.delayValue`);
    if (rule.audience === audience && at >= created + delay) {
      for (const name of rule.fieldNames) permitted.add(protocolId(name, `${context}.fieldNames`));
    }
  });
  return Object.freeze([...permitted].sort());
}
