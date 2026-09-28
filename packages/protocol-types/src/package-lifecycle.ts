import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  SETTLEMENT_CLASS,
  type SettlementClass,
} from './enums.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  domainRef,
  encodeDomainRef,
  encodeProtocolId,
  encodeVersionedManifestRef,
  protocolId,
  versionedManifestRef,
  type DomainRef,
  type ProtocolId,
  type VersionedManifestRef,
} from './primitives.js';

export const PACKAGE_LIFECYCLE_VERSION = 1;

const U32_BITS = 32;
const U64_BITS = 64;

export const PACKAGE_LIFECYCLE_STATE = Object.freeze({
  PACKAGE_CREATED: 1,
  ENTRY_PREPARED: 2,
  ENTRY_SUBMITTED: 3,
  ENTRY_CONFIRMED: 4,
  OPEN: 5,
  EXIT_REQUESTED: 6,
  EXIT_SUBMITTED: 7,
  RECOVERY_PENDING: 8,
  MANUAL_INTERVENTION: 9,
  CLOSED: 10,
  FAILED: 11,
  EXPIRED: 12,
  CANCELLED: 13,
} as const);
export type PackageLifecycleState = keyof typeof PACKAGE_LIFECYCLE_STATE;

export const PACKAGE_EVIDENCE_GRADE = Object.freeze({
  LOCAL_RECORDED: 1,
  CONTROLLER_ATTESTED: 2,
  VENUE_CORROBORATED: 3,
  CONSENSUS_VERIFIED: 4,
} as const);
export type PackageEvidenceGrade = keyof typeof PACKAGE_EVIDENCE_GRADE;

const TERMINAL_STATES: ReadonlySet<PackageLifecycleState> = new Set([
  'CLOSED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
]);

function states(...values: PackageLifecycleState[]): readonly PackageLifecycleState[] {
  return Object.freeze(values);
}

const ALLOWED_TRANSITIONS: Readonly<Record<PackageLifecycleState, readonly PackageLifecycleState[]>> =
  Object.freeze({
    PACKAGE_CREATED: states(
      'ENTRY_PREPARED',
      'RECOVERY_PENDING',
      'MANUAL_INTERVENTION',
      'FAILED',
      'EXPIRED',
      'CANCELLED',
    ),
    ENTRY_PREPARED: states(
      'ENTRY_SUBMITTED',
      'RECOVERY_PENDING',
      'MANUAL_INTERVENTION',
      'FAILED',
      'EXPIRED',
      'CANCELLED',
    ),
    ENTRY_SUBMITTED: states(
      'ENTRY_CONFIRMED',
      'RECOVERY_PENDING',
      'MANUAL_INTERVENTION',
      'FAILED',
      'EXPIRED',
      'CANCELLED',
    ),
    ENTRY_CONFIRMED: states('OPEN', 'RECOVERY_PENDING', 'MANUAL_INTERVENTION', 'FAILED'),
    OPEN: states(
      'EXIT_REQUESTED',
      'RECOVERY_PENDING',
      'MANUAL_INTERVENTION',
      'FAILED',
      'EXPIRED',
    ),
    EXIT_REQUESTED: states(
      'EXIT_SUBMITTED',
      'RECOVERY_PENDING',
      'MANUAL_INTERVENTION',
      'FAILED',
      'CANCELLED',
    ),
    EXIT_SUBMITTED: states('CLOSED', 'RECOVERY_PENDING', 'MANUAL_INTERVENTION', 'FAILED'),
    RECOVERY_PENDING: states(
      'OPEN',
      'EXIT_REQUESTED',
      'MANUAL_INTERVENTION',
      'CLOSED',
      'FAILED',
    ),
    MANUAL_INTERVENTION: states(
      'RECOVERY_PENDING',
      'OPEN',
      'EXIT_REQUESTED',
      'CLOSED',
      'FAILED',
      'EXPIRED',
      'CANCELLED',
    ),
    CLOSED: states(),
    FAILED: states(),
    EXPIRED: states(),
    CANCELLED: states(),
  });

export function isTerminalPackageLifecycleState(state: PackageLifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

export function assertPackageLifecycleTransition(
  prior: PackageLifecycleState | undefined,
  next: PackageLifecycleState,
  context = 'lifecycleTransition',
): void {
  enumDiscriminant(PACKAGE_LIFECYCLE_STATE, next, `${context}.nextState`);
  if (prior === undefined) {
    if (next !== 'PACKAGE_CREATED') {
      throw new MalformedInputError(context, 'initial state must be PACKAGE_CREATED');
    }
    return;
  }
  enumDiscriminant(PACKAGE_LIFECYCLE_STATE, prior, `${context}.priorState`);
  if (isTerminalPackageLifecycleState(prior)) {
    throw new MalformedInputError(context, 'terminal state has no outgoing transition');
  }
  if (!ALLOWED_TRANSITIONS[prior].includes(next)) {
    throw new MalformedInputError(
      context,
      `transition from ${prior} to ${next} is not permitted`,
    );
  }
}

export interface PackageLifecycleEventIntentInput {
  readonly version: number;
  readonly domain: DomainRef;
  readonly settlementClass: SettlementClass;
  readonly packageId: string;
  readonly packageCommitment: Uint8Array | string;
  readonly attemptId: string;
  readonly eventId: string;
  readonly expectedRevision: bigint;
  readonly nextState: PackageLifecycleState;
  readonly evidenceGrade: PackageEvidenceGrade;
  readonly onchainEnforced: boolean;
  readonly evidenceSource: VersionedManifestRef;
  readonly evidenceCommitment: Uint8Array | string;
}

export interface PackageLifecycleEventIntent {
  readonly version: 1;
  readonly domain: DomainRef;
  readonly settlementClass: SettlementClass;
  readonly packageId: ProtocolId;
  readonly packageCommitment: CommitmentHash;
  readonly attemptId: ProtocolId;
  readonly eventId: ProtocolId;
  readonly expectedRevision: bigint;
  readonly nextState: PackageLifecycleState;
  readonly evidenceGrade: PackageEvidenceGrade;
  readonly onchainEnforced: boolean;
  readonly evidenceSource: VersionedManifestRef;
  readonly evidenceCommitment: CommitmentHash;
}

export interface PackageLifecycleReceiptInput {
  readonly version: number;
  readonly domain: DomainRef;
  readonly settlementClass: SettlementClass;
  readonly packageId: string;
  readonly packageCommitment: Uint8Array | string;
  readonly attemptId: string;
  readonly eventId: string;
  readonly revision: bigint;
  readonly priorState?: PackageLifecycleState;
  readonly previousReceiptHash?: Uint8Array | string;
  readonly nextState: PackageLifecycleState;
  readonly observedAtUnixMilliseconds: bigint;
  readonly evidenceGrade: PackageEvidenceGrade;
  readonly onchainEnforced: boolean;
  readonly evidenceSource: VersionedManifestRef;
  readonly evidenceCommitment: Uint8Array | string;
}

export interface PackageLifecycleReceipt {
  readonly version: 1;
  readonly domain: DomainRef;
  readonly settlementClass: SettlementClass;
  readonly packageId: ProtocolId;
  readonly packageCommitment: CommitmentHash;
  readonly attemptId: ProtocolId;
  readonly eventId: ProtocolId;
  readonly revision: bigint;
  readonly priorState?: PackageLifecycleState;
  readonly previousReceiptHash?: CommitmentHash;
  readonly nextState: PackageLifecycleState;
  readonly observedAtUnixMilliseconds: bigint;
  readonly evidenceGrade: PackageEvidenceGrade;
  readonly onchainEnforced: boolean;
  readonly evidenceSource: VersionedManifestRef;
  readonly evidenceCommitment: CommitmentHash;
}

function exactVersion(value: number, context: string): 1 {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  const checked = checkedUnsigned(value, U32_BITS, context);
  if (checked !== BigInt(PACKAGE_LIFECYCLE_VERSION)) {
    throw new MalformedInputError(context, `version must equal ${PACKAGE_LIFECYCLE_VERSION}`);
  }
  return PACKAGE_LIFECYCLE_VERSION;
}

function checkedDomain(value: DomainRef, context: string): DomainRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a domain reference object');
  }
  if (!(value.domainManifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(
      `${context}.domainManifestHash`,
      'expected 32 canonical bytes',
    );
  }
  return domainRef(
    value.domainId,
    value.domainManifestVersion,
    value.domainManifestHash,
    context,
  );
}

function checkedEvidenceSource(value: VersionedManifestRef, context: string): VersionedManifestRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an evidence source object');
  }
  if (!(value.manifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(
      `${context}.manifestHash`,
      'expected 32 canonical bytes',
    );
  }
  return versionedManifestRef(
    value.subjectId,
    value.manifestVersion,
    value.manifestHash,
    context,
  );
}

function u64(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  return checkedUnsigned(value, U64_BITS, context);
}

function expectedRevisionChecked(value: bigint, context: string): bigint {
  return u64(value, context);
}

function revisionChecked(value: bigint, context: string): bigint {
  const checked = u64(value, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'revision is zero');
  }
  return checked;
}

function observedAtChecked(value: bigint, context: string): bigint {
  const checked = u64(value, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'observed-at timestamp is zero');
  }
  return checked;
}

function onchainChecked(value: boolean, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new MalformedInputError(context, 'expected a boolean');
  }
  return value;
}

function sharedFields(
  input: PackageLifecycleEventIntentInput | PackageLifecycleReceiptInput,
  context: string,
): {
  domain: DomainRef;
  settlementClass: SettlementClass;
  packageId: ProtocolId;
  packageCommitment: CommitmentHash;
  attemptId: ProtocolId;
  eventId: ProtocolId;
  nextState: PackageLifecycleState;
  evidenceGrade: PackageEvidenceGrade;
  onchainEnforced: boolean;
  evidenceSource: VersionedManifestRef;
  evidenceCommitment: CommitmentHash;
} {
  enumDiscriminant(SETTLEMENT_CLASS, input.settlementClass, `${context}.settlementClass`);
  enumDiscriminant(
    PACKAGE_LIFECYCLE_STATE,
    input.nextState,
    `${context}.nextState`,
  );
  enumDiscriminant(
    PACKAGE_EVIDENCE_GRADE,
    input.evidenceGrade,
    `${context}.evidenceGrade`,
  );
  const packageCommitment = commitmentHash(
    input.packageCommitment,
    `${context}.packageCommitment`,
  );
  const evidenceCommitment = commitmentHash(
    input.evidenceCommitment,
    `${context}.evidenceCommitment`,
  );
  return {
    domain: checkedDomain(input.domain, `${context}.domain`),
    settlementClass: input.settlementClass,
    packageId: protocolId(input.packageId, `${context}.packageId`),
    packageCommitment,
    attemptId: protocolId(input.attemptId, `${context}.attemptId`),
    eventId: protocolId(input.eventId, `${context}.eventId`),
    nextState: input.nextState,
    evidenceGrade: input.evidenceGrade,
    onchainEnforced: onchainChecked(input.onchainEnforced, `${context}.onchainEnforced`),
    evidenceSource: checkedEvidenceSource(
      input.evidenceSource,
      `${context}.evidenceSource`,
    ),
    evidenceCommitment,
  };
}

function frozenIntent(
  shared: ReturnType<typeof sharedFields>,
  expectedRevision: bigint,
): PackageLifecycleEventIntent {
  const packageCommitment = Uint8Array.from(shared.packageCommitment) as CommitmentHash;
  const evidenceCommitment = Uint8Array.from(shared.evidenceCommitment) as CommitmentHash;
  return Object.freeze({
    version: 1 as const,
    domain: shared.domain,
    settlementClass: shared.settlementClass,
    packageId: shared.packageId,
    get packageCommitment(): CommitmentHash {
      return Uint8Array.from(packageCommitment) as CommitmentHash;
    },
    attemptId: shared.attemptId,
    eventId: shared.eventId,
    expectedRevision,
    nextState: shared.nextState,
    evidenceGrade: shared.evidenceGrade,
    onchainEnforced: shared.onchainEnforced,
    evidenceSource: shared.evidenceSource,
    get evidenceCommitment(): CommitmentHash {
      return Uint8Array.from(evidenceCommitment) as CommitmentHash;
    },
  });
}

export function packageLifecycleEventIntent(
  input: PackageLifecycleEventIntentInput,
  context = 'packageLifecycleEventIntent',
): PackageLifecycleEventIntent {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a lifecycle intent object');
  }
  exactVersion(input.version, `${context}.version`);
  const shared = sharedFields(input, context);
  const expectedRevision = expectedRevisionChecked(
    input.expectedRevision,
    `${context}.expectedRevision`,
  );
  if (expectedRevision === 0n && shared.nextState !== 'PACKAGE_CREATED') {
    throw new MalformedInputError(
      context,
      'initial intent must move to PACKAGE_CREATED',
    );
  }
  if (expectedRevision > 0n && shared.nextState === 'PACKAGE_CREATED') {
    throw new MalformedInputError(
      context,
      'PACKAGE_CREATED is valid only as the initial state',
    );
  }
  return frozenIntent(shared, expectedRevision);
}

function frozenReceipt(
  shared: ReturnType<typeof sharedFields>,
  revision: bigint,
  priorState: PackageLifecycleState | undefined,
  previousReceiptHash: CommitmentHash | undefined,
  observedAtUnixMilliseconds: bigint,
): PackageLifecycleReceipt {
  const packageCommitment = Uint8Array.from(shared.packageCommitment) as CommitmentHash;
  const evidenceCommitment = Uint8Array.from(shared.evidenceCommitment) as CommitmentHash;
  const previous =
    previousReceiptHash === undefined
      ? undefined
      : (Uint8Array.from(previousReceiptHash) as CommitmentHash);
  const value: Record<string, unknown> = {
    version: 1 as const,
    domain: shared.domain,
    settlementClass: shared.settlementClass,
    packageId: shared.packageId,
    attemptId: shared.attemptId,
    eventId: shared.eventId,
    revision,
    nextState: shared.nextState,
    observedAtUnixMilliseconds,
    evidenceGrade: shared.evidenceGrade,
    onchainEnforced: shared.onchainEnforced,
    evidenceSource: shared.evidenceSource,
  };
  Object.defineProperty(value, 'packageCommitment', {
    enumerable: true,
    get(): CommitmentHash {
      return Uint8Array.from(packageCommitment) as CommitmentHash;
    },
  });
  Object.defineProperty(value, 'evidenceCommitment', {
    enumerable: true,
    get(): CommitmentHash {
      return Uint8Array.from(evidenceCommitment) as CommitmentHash;
    },
  });
  if (priorState !== undefined) {
    Object.defineProperty(value, 'priorState', {
      enumerable: true,
      value: priorState,
    });
  }
  if (previous !== undefined) {
    Object.defineProperty(value, 'previousReceiptHash', {
      enumerable: true,
      get(): CommitmentHash {
        return Uint8Array.from(previous) as CommitmentHash;
      },
    });
  }
  return Object.freeze(value) as unknown as PackageLifecycleReceipt;
}

export function packageLifecycleReceipt(
  input: PackageLifecycleReceiptInput,
  context = 'packageLifecycleReceipt',
): PackageLifecycleReceipt {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a lifecycle receipt object');
  }
  exactVersion(input.version, `${context}.version`);
  const shared = sharedFields(input, context);
  const revision = revisionChecked(input.revision, `${context}.revision`);
  const observedAtUnixMilliseconds = observedAtChecked(
    input.observedAtUnixMilliseconds,
    `${context}.observedAtUnixMilliseconds`,
  );
  if (revision === 1n) {
    if (input.priorState !== undefined) {
      throw new MalformedInputError(`${context}.priorState`, 'initial receipt has no prior state');
    }
    if (input.previousReceiptHash !== undefined) {
      throw new MalformedInputError(
        `${context}.previousReceiptHash`,
        'initial receipt has no previous hash',
      );
    }
    assertPackageLifecycleTransition(undefined, shared.nextState, context);
    return frozenReceipt(shared, revision, undefined, undefined, observedAtUnixMilliseconds);
  }
  if (input.priorState === undefined) {
    throw new MalformedInputError(`${context}.priorState`, 'prior state is required');
  }
  if (input.previousReceiptHash === undefined) {
    throw new MalformedInputError(
      `${context}.previousReceiptHash`,
      'previous receipt hash is required',
    );
  }
  enumDiscriminant(
    PACKAGE_LIFECYCLE_STATE,
    input.priorState,
    `${context}.priorState`,
  );
  const previousReceiptHash = commitmentHash(
    input.previousReceiptHash,
    `${context}.previousReceiptHash`,
  );
  assertPackageLifecycleTransition(input.priorState, shared.nextState, context);
  return frozenReceipt(
    shared,
    revision,
    input.priorState,
    previousReceiptHash,
    observedAtUnixMilliseconds,
  );
}

function revalidateIntent(value: PackageLifecycleEventIntent): PackageLifecycleEventIntent {
  if (
    !(value.packageCommitment instanceof Uint8Array) ||
    !(value.evidenceCommitment instanceof Uint8Array)
  ) {
    throw new MalformedInputError('packageLifecycleEventIntent', 'expected canonical hash bytes');
  }
  return packageLifecycleEventIntent(value, 'packageLifecycleEventIntent');
}

function revalidateReceipt(value: PackageLifecycleReceipt): PackageLifecycleReceipt {
  if (
    !(value.packageCommitment instanceof Uint8Array) ||
    !(value.evidenceCommitment instanceof Uint8Array) ||
    (value.previousReceiptHash !== undefined && !(value.previousReceiptHash instanceof Uint8Array))
  ) {
    throw new MalformedInputError('packageLifecycleReceipt', 'expected canonical hash bytes');
  }
  return packageLifecycleReceipt(value, 'packageLifecycleReceipt');
}

export function encodePackageLifecycleEventIntent(
  writer: CanonicalWriter,
  value: PackageLifecycleEventIntent,
): void {
  const checked = revalidateIntent(value);
  writer.writeU32(checked.version, 'packageLifecycleEventIntent.version');
  encodeDomainRef(writer, checked.domain);
  writer.writeEnum(
    SETTLEMENT_CLASS,
    checked.settlementClass,
    'packageLifecycleEventIntent.settlementClass',
  );
  encodeProtocolId(writer, checked.packageId, 'packageLifecycleEventIntent.packageId');
  encodeCommitmentHash(
    writer,
    checked.packageCommitment,
    'packageLifecycleEventIntent.packageCommitment',
  );
  encodeProtocolId(writer, checked.attemptId, 'packageLifecycleEventIntent.attemptId');
  encodeProtocolId(writer, checked.eventId, 'packageLifecycleEventIntent.eventId');
  writer.writeU64(checked.expectedRevision, 'packageLifecycleEventIntent.expectedRevision');
  writer.writeEnum(
    PACKAGE_LIFECYCLE_STATE,
    checked.nextState,
    'packageLifecycleEventIntent.nextState',
  );
  writer.writeEnum(
    PACKAGE_EVIDENCE_GRADE,
    checked.evidenceGrade,
    'packageLifecycleEventIntent.evidenceGrade',
  );
  writer.writeBool(checked.onchainEnforced, 'packageLifecycleEventIntent.onchainEnforced');
  encodeVersionedManifestRef(writer, checked.evidenceSource);
  encodeCommitmentHash(
    writer,
    checked.evidenceCommitment,
    'packageLifecycleEventIntent.evidenceCommitment',
  );
}

export function encodePackageLifecycleReceipt(
  writer: CanonicalWriter,
  value: PackageLifecycleReceipt,
): void {
  const checked = revalidateReceipt(value);
  writer.writeU32(checked.version, 'packageLifecycleReceipt.version');
  encodeDomainRef(writer, checked.domain);
  writer.writeEnum(
    SETTLEMENT_CLASS,
    checked.settlementClass,
    'packageLifecycleReceipt.settlementClass',
  );
  encodeProtocolId(writer, checked.packageId, 'packageLifecycleReceipt.packageId');
  encodeCommitmentHash(
    writer,
    checked.packageCommitment,
    'packageLifecycleReceipt.packageCommitment',
  );
  encodeProtocolId(writer, checked.attemptId, 'packageLifecycleReceipt.attemptId');
  encodeProtocolId(writer, checked.eventId, 'packageLifecycleReceipt.eventId');
  writer.writeU64(checked.revision, 'packageLifecycleReceipt.revision');
  writer.writeOptional(
    checked.priorState,
    (target, state) =>
      target.writeEnum(
        PACKAGE_LIFECYCLE_STATE,
        state,
        'packageLifecycleReceipt.priorState.value',
      ),
    'packageLifecycleReceipt.priorState',
  );
  writer.writeOptional(
    checked.previousReceiptHash,
    (target, value) =>
      encodeCommitmentHash(target, value, 'packageLifecycleReceipt.previousReceiptHash.value'),
    'packageLifecycleReceipt.previousReceiptHash',
  );
  writer.writeEnum(
    PACKAGE_LIFECYCLE_STATE,
    checked.nextState,
    'packageLifecycleReceipt.nextState',
  );
  writer.writeU64(
    checked.observedAtUnixMilliseconds,
    'packageLifecycleReceipt.observedAtUnixMilliseconds',
  );
  writer.writeEnum(
    PACKAGE_EVIDENCE_GRADE,
    checked.evidenceGrade,
    'packageLifecycleReceipt.evidenceGrade',
  );
  writer.writeBool(checked.onchainEnforced, 'packageLifecycleReceipt.onchainEnforced');
  encodeVersionedManifestRef(writer, checked.evidenceSource);
  encodeCommitmentHash(
    writer,
    checked.evidenceCommitment,
    'packageLifecycleReceipt.evidenceCommitment',
  );
}

export function packageLifecycleEventIntentBytes(
  input: PackageLifecycleEventIntentInput,
): Uint8Array {
  const checked = packageLifecycleEventIntent(input, 'packageLifecycleEventIntent');
  return canonicalBytes((writer) => encodePackageLifecycleEventIntent(writer, checked));
}

export function packageLifecycleEventIntentCommitment(
  input: PackageLifecycleEventIntentInput,
): CommitmentHash {
  return commitmentHash(
    domainHash(
      HASH_DOMAIN.PACKAGE_LIFECYCLE_INTENT,
      packageLifecycleEventIntentBytes(input),
      'packageLifecycleEventIntentCommitment',
    ),
    'packageLifecycleEventIntentCommitment',
  );
}

export function packageLifecycleReceiptBytes(input: PackageLifecycleReceiptInput): Uint8Array {
  const checked = packageLifecycleReceipt(input, 'packageLifecycleReceipt');
  return canonicalBytes((writer) => encodePackageLifecycleReceipt(writer, checked));
}

export function packageLifecycleReceiptHash(
  input: PackageLifecycleReceiptInput,
): CommitmentHash {
  return commitmentHash(
    domainHash(
      HASH_DOMAIN.PACKAGE_LIFECYCLE_RECEIPT,
      packageLifecycleReceiptBytes(input),
      'packageLifecycleReceiptHash',
    ),
    'packageLifecycleReceiptHash',
  );
}
