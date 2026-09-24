import { checkedUnsigned } from './arithmetic.js';
import { bytesEqual } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  ASYNC_BONDED_STATE,
  enumDiscriminant,
  EXECUTION_PLAN_KIND,
  SETTLEMENT_CLASS,
  type AsyncBondedState,
} from './enums.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  assetRef,
  domainRef,
  encodeAssetRef,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  encodeVersionedManifestRef,
  manifestHash,
  protocolId,
  versionedManifestRef,
  type AssetRef,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
  type VersionedManifestRef,
} from './primitives.js';

const AUTHORIZATION_VERSION = 1;
const TRANSITION_VERSION = 1;
const U32_BITS = 32;
const U64_BITS = 64;
const U256_BITS = 256;

export interface AsyncBoundedAmountInput {
  readonly asset: AssetRef;
  readonly atoms: bigint;
}

export interface AsyncBoundedAmount {
  readonly asset: AssetRef;
  readonly atoms: bigint;
}

export interface AsyncBondedAuthorizationInput {
  readonly version: number;
  readonly domain: DomainRef;
  readonly orderHash: Uint8Array | string;
  readonly quoteHash: Uint8Array | string;
  readonly routeHash: Uint8Array | string;
  readonly seriesBindingHash: Uint8Array | string;
  readonly executionClassManifestHash: Uint8Array | string;
  readonly strategyAccount: string;
  readonly solver: string;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly handler: VersionedManifestRef;
  readonly handlerCodeHash: Uint8Array | string;
  readonly callbackTarget: string;
  readonly requestCommitment: Uint8Array | string;
  readonly reservationId: Uint8Array | string;
  readonly bondId: Uint8Array | string;
  readonly bond: AsyncBoundedAmountInput;
  readonly recoveryReserve: AsyncBoundedAmountInput;
  readonly maxAggregateLoss: AsyncBoundedAmountInput;
  readonly maxIntermediateResidual: AsyncBoundedAmountInput;
  readonly maxTerminalResidual: AsyncBoundedAmountInput;
  readonly submissionDeadline: bigint;
  readonly venueRequestDeadline: bigint;
  readonly recoveryDeadline: bigint;
  readonly slashPolicyHash: Uint8Array | string;
  readonly recoveryPolicyHash: Uint8Array | string;
  readonly evidenceSchemaHash: Uint8Array | string;
}

export interface AsyncBondedAuthorization {
  readonly version: 1;
  readonly domain: DomainRef;
  readonly orderHash: CommitmentHash;
  readonly quoteHash: CommitmentHash;
  readonly routeHash: CommitmentHash;
  readonly seriesBindingHash: ManifestHash;
  readonly executionClassManifestHash: ManifestHash;
  readonly strategyAccount: ProtocolId;
  readonly solver: ProtocolId;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly handler: VersionedManifestRef;
  readonly handlerCodeHash: ManifestHash;
  readonly callbackTarget: ProtocolId;
  readonly requestCommitment: CommitmentHash;
  readonly reservationId: CommitmentHash;
  readonly bondId: CommitmentHash;
  readonly bond: AsyncBoundedAmount;
  readonly recoveryReserve: AsyncBoundedAmount;
  readonly maxAggregateLoss: AsyncBoundedAmount;
  readonly maxIntermediateResidual: AsyncBoundedAmount;
  readonly maxTerminalResidual: AsyncBoundedAmount;
  readonly submissionDeadline: bigint;
  readonly venueRequestDeadline: bigint;
  readonly recoveryDeadline: bigint;
  readonly slashPolicyHash: ManifestHash;
  readonly recoveryPolicyHash: ManifestHash;
  readonly evidenceSchemaHash: ManifestHash;
}

export interface AsyncBondedTransitionInput {
  readonly version: number;
  readonly authorizationHash: Uint8Array | string;
  readonly priorState: AsyncBondedState;
  readonly nextState: AsyncBondedState;
  readonly priorStateVersion: number;
  readonly nextStateVersion: number;
  readonly evidenceHash: Uint8Array | string;
  readonly observedAtUnixSeconds: bigint;
  readonly requestKey?: Uint8Array | string;
  readonly venueTransactionHash?: Uint8Array | string;
  readonly recoveryActionHash?: Uint8Array | string;
}

export interface AsyncBondedTransition {
  readonly version: 1;
  readonly authorizationHash: CommitmentHash;
  readonly priorState: AsyncBondedState;
  readonly nextState: AsyncBondedState;
  readonly priorStateVersion: number;
  readonly nextStateVersion: number;
  readonly evidenceHash: CommitmentHash;
  readonly observedAtUnixSeconds: bigint;
  readonly requestKey?: CommitmentHash;
  readonly venueTransactionHash?: CommitmentHash;
  readonly recoveryActionHash?: CommitmentHash;
}

const states = (...values: AsyncBondedState[]): readonly AsyncBondedState[] => Object.freeze(values);

const ALLOWED_TRANSITIONS: Readonly<Record<AsyncBondedState, readonly AsyncBondedState[]>> = Object.freeze({
  RESERVED: states('REQUEST_SUBMITTED', 'RECOVERY_PENDING', 'MANUAL_INTERVENTION'),
  REQUEST_SUBMITTED: states('VENUE_PENDING', 'EXECUTED', 'CANCELLED', 'FROZEN', 'RECOVERY_PENDING', 'MANUAL_INTERVENTION'),
  VENUE_PENDING: states('EXECUTED', 'CANCELLED', 'FROZEN', 'RECOVERY_PENDING', 'MANUAL_INTERVENTION'),
  EXECUTED: states('RECOVERY_PENDING', 'RECOVERED', 'CLOSED', 'MANUAL_INTERVENTION'),
  CANCELLED: states('RECOVERY_PENDING', 'RECOVERED', 'CLOSED', 'MANUAL_INTERVENTION'),
  FROZEN: states('VENUE_PENDING', 'EXECUTED', 'CANCELLED', 'RECOVERY_PENDING', 'MANUAL_INTERVENTION'),
  RECOVERY_PENDING: states('EXECUTED', 'RECOVERED', 'MANUAL_INTERVENTION'),
  RECOVERED: states('CLOSED', 'MANUAL_INTERVENTION'),
  MANUAL_INTERVENTION: states('RECOVERED', 'CLOSED'),
  CLOSED: states(),
});

function object(value: unknown, context: string): asserts value is object {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an object');
  }
}

function exactVersion(value: number, expected: number, context: string): number {
  if (typeof value !== 'number') throw new MalformedInputError(context, 'expected a number');
  const checked = checkedUnsigned(value, U32_BITS, context);
  if (checked !== BigInt(expected)) {
    throw new MalformedInputError(context, `version must equal ${expected}`);
  }
  return Number(checked);
}

function u64(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, U64_BITS, context);
}

function boundedAmount(
  input: AsyncBoundedAmountInput,
  context: string,
  requireNonzero: boolean,
): AsyncBoundedAmount {
  object(input, context);
  if (typeof input.atoms !== 'bigint') {
    throw new MalformedInputError(`${context}.atoms`, 'expected a bigint');
  }
  const atoms = checkedUnsigned(input.atoms, U256_BITS, `${context}.atoms`);
  if (requireNonzero && atoms === 0n) {
    throw new MalformedInputError(`${context}.atoms`, 'value is zero');
  }
  return Object.freeze({
    asset: assetRef(
      input.asset.assetId,
      input.asset.assetManifestHash,
      input.asset.decimals,
      `${context}.asset`,
    ),
    atoms,
  });
}

function encodeBoundedAmount(
  writer: CanonicalWriter,
  value: AsyncBoundedAmount,
): void {
  encodeAssetRef(writer, value.asset);
  writer.writeU256(value.atoms, 'asyncBoundedAmount.atoms');
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return bytesEqual(
    canonicalBytes((writer) => encodeAssetRef(writer, left)),
    canonicalBytes((writer) => encodeAssetRef(writer, right)),
  );
}

export function asyncBondedAuthorization(
  input: AsyncBondedAuthorizationInput,
  context = 'asyncBondedAuthorization',
): AsyncBondedAuthorization {
  object(input, context);
  exactVersion(input.version, AUTHORIZATION_VERSION, `${context}.version`);
  const domain = domainRef(
    input.domain.domainId,
    input.domain.domainManifestVersion,
    input.domain.domainManifestHash,
    `${context}.domain`,
  );
  const bond = boundedAmount(input.bond, `${context}.bond`, true);
  const recoveryReserve = boundedAmount(
    input.recoveryReserve,
    `${context}.recoveryReserve`,
    true,
  );
  const maxAggregateLoss = boundedAmount(
    input.maxAggregateLoss,
    `${context}.maxAggregateLoss`,
    false,
  );
  const maxIntermediateResidual = boundedAmount(
    input.maxIntermediateResidual,
    `${context}.maxIntermediateResidual`,
    false,
  );
  const maxTerminalResidual = boundedAmount(
    input.maxTerminalResidual,
    `${context}.maxTerminalResidual`,
    false,
  );
  if (!sameAsset(recoveryReserve.asset, maxAggregateLoss.asset)) {
    throw new MalformedInputError(
      `${context}.recoveryReserve.asset`,
      'recovery reserve and loss cap must use the same asset',
    );
  }
  if (recoveryReserve.atoms < maxAggregateLoss.atoms) {
    throw new MalformedInputError(
      `${context}.recoveryReserve.atoms`,
      'recovery reserve is below the aggregate loss cap',
    );
  }
  if (!sameAsset(maxIntermediateResidual.asset, maxTerminalResidual.asset)) {
    throw new MalformedInputError(
      `${context}.maxTerminalResidual.asset`,
      'intermediate and terminal residual caps must use the same asset',
    );
  }
  if (maxTerminalResidual.atoms > maxIntermediateResidual.atoms) {
    throw new MalformedInputError(
      `${context}.maxTerminalResidual.atoms`,
      'terminal residual exceeds intermediate residual',
    );
  }
  const submissionDeadline = u64(input.submissionDeadline, `${context}.submissionDeadline`);
  const venueRequestDeadline = u64(
    input.venueRequestDeadline,
    `${context}.venueRequestDeadline`,
  );
  const recoveryDeadline = u64(input.recoveryDeadline, `${context}.recoveryDeadline`);
  if (
    submissionDeadline === 0n
    || submissionDeadline >= venueRequestDeadline
    || venueRequestDeadline >= recoveryDeadline
  ) {
    throw new MalformedInputError(context, 'deadlines must be nonzero and strictly increasing');
  }
  const orderHash = commitmentHash(input.orderHash, `${context}.orderHash`);
  const quoteHash = commitmentHash(input.quoteHash, `${context}.quoteHash`);
  const routeHash = commitmentHash(input.routeHash, `${context}.routeHash`);
  const seriesBindingHash = manifestHash(
    input.seriesBindingHash,
    `${context}.seriesBindingHash`,
  );
  const executionClassManifestHash = manifestHash(
    input.executionClassManifestHash,
    `${context}.executionClassManifestHash`,
  );
  const handlerCodeHash = manifestHash(input.handlerCodeHash, `${context}.handlerCodeHash`);
  const requestCommitment = commitmentHash(
    input.requestCommitment,
    `${context}.requestCommitment`,
  );
  const reservationId = commitmentHash(input.reservationId, `${context}.reservationId`);
  const bondId = commitmentHash(input.bondId, `${context}.bondId`);
  const slashPolicyHash = manifestHash(input.slashPolicyHash, `${context}.slashPolicyHash`);
  const recoveryPolicyHash = manifestHash(
    input.recoveryPolicyHash,
    `${context}.recoveryPolicyHash`,
  );
  const evidenceSchemaHash = manifestHash(
    input.evidenceSchemaHash,
    `${context}.evidenceSchemaHash`,
  );
  return Object.freeze({
    version: 1 as const,
    domain,
    get orderHash(): CommitmentHash { return commitmentHash(orderHash, `${context}.orderHash`); },
    get quoteHash(): CommitmentHash { return commitmentHash(quoteHash, `${context}.quoteHash`); },
    get routeHash(): CommitmentHash { return commitmentHash(routeHash, `${context}.routeHash`); },
    get seriesBindingHash(): ManifestHash { return manifestHash(seriesBindingHash, `${context}.seriesBindingHash`); },
    get executionClassManifestHash(): ManifestHash { return manifestHash(executionClassManifestHash, `${context}.executionClassManifestHash`); },
    strategyAccount: protocolId(input.strategyAccount, `${context}.strategyAccount`),
    solver: protocolId(input.solver, `${context}.solver`),
    venue: versionedManifestRef(
      input.venue.subjectId,
      input.venue.manifestVersion,
      input.venue.manifestHash,
      `${context}.venue`,
    ),
    market: versionedManifestRef(
      input.market.subjectId,
      input.market.manifestVersion,
      input.market.manifestHash,
      `${context}.market`,
    ),
    handler: versionedManifestRef(
      input.handler.subjectId,
      input.handler.manifestVersion,
      input.handler.manifestHash,
      `${context}.handler`,
    ),
    get handlerCodeHash(): ManifestHash { return manifestHash(handlerCodeHash, `${context}.handlerCodeHash`); },
    callbackTarget: protocolId(input.callbackTarget, `${context}.callbackTarget`),
    get requestCommitment(): CommitmentHash { return commitmentHash(requestCommitment, `${context}.requestCommitment`); },
    get reservationId(): CommitmentHash { return commitmentHash(reservationId, `${context}.reservationId`); },
    get bondId(): CommitmentHash { return commitmentHash(bondId, `${context}.bondId`); },
    bond,
    recoveryReserve,
    maxAggregateLoss,
    maxIntermediateResidual,
    maxTerminalResidual,
    submissionDeadline,
    venueRequestDeadline,
    recoveryDeadline,
    get slashPolicyHash(): ManifestHash { return manifestHash(slashPolicyHash, `${context}.slashPolicyHash`); },
    get recoveryPolicyHash(): ManifestHash { return manifestHash(recoveryPolicyHash, `${context}.recoveryPolicyHash`); },
    get evidenceSchemaHash(): ManifestHash { return manifestHash(evidenceSchemaHash, `${context}.evidenceSchemaHash`); },
  });
}

export function encodeAsyncBondedAuthorization(
  writer: CanonicalWriter,
  input: AsyncBondedAuthorizationInput,
): void {
  const checked = asyncBondedAuthorization(input);
  writer.writeU32(checked.version, 'asyncBondedAuthorization.version');
  encodeDomainRef(writer, checked.domain);
  encodeCommitmentHash(writer, checked.orderHash, 'asyncBondedAuthorization.orderHash');
  encodeCommitmentHash(writer, checked.quoteHash, 'asyncBondedAuthorization.quoteHash');
  encodeCommitmentHash(writer, checked.routeHash, 'asyncBondedAuthorization.routeHash');
  encodeManifestHash(writer, checked.seriesBindingHash, 'asyncBondedAuthorization.seriesBindingHash');
  encodeManifestHash(writer, checked.executionClassManifestHash, 'asyncBondedAuthorization.executionClassManifestHash');
  writer.writeEnum(SETTLEMENT_CLASS, 'ASYNC_BONDED_SOLVER', 'asyncBondedAuthorization.settlementClass');
  writer.writeEnum(EXECUTION_PLAN_KIND, 'EVM_ASYNC_REQUEST', 'asyncBondedAuthorization.executionPlanKind');
  encodeProtocolId(writer, checked.strategyAccount, 'asyncBondedAuthorization.strategyAccount');
  encodeProtocolId(writer, checked.solver, 'asyncBondedAuthorization.solver');
  encodeVersionedManifestRef(writer, checked.venue);
  encodeVersionedManifestRef(writer, checked.market);
  encodeVersionedManifestRef(writer, checked.handler);
  encodeManifestHash(writer, checked.handlerCodeHash, 'asyncBondedAuthorization.handlerCodeHash');
  encodeProtocolId(writer, checked.callbackTarget, 'asyncBondedAuthorization.callbackTarget');
  encodeCommitmentHash(writer, checked.requestCommitment, 'asyncBondedAuthorization.requestCommitment');
  encodeCommitmentHash(writer, checked.reservationId, 'asyncBondedAuthorization.reservationId');
  encodeCommitmentHash(writer, checked.bondId, 'asyncBondedAuthorization.bondId');
  encodeBoundedAmount(writer, checked.bond);
  encodeBoundedAmount(writer, checked.recoveryReserve);
  encodeBoundedAmount(writer, checked.maxAggregateLoss);
  encodeBoundedAmount(writer, checked.maxIntermediateResidual);
  encodeBoundedAmount(writer, checked.maxTerminalResidual);
  writer.writeU64(checked.submissionDeadline, 'asyncBondedAuthorization.submissionDeadline');
  writer.writeU64(checked.venueRequestDeadline, 'asyncBondedAuthorization.venueRequestDeadline');
  writer.writeU64(checked.recoveryDeadline, 'asyncBondedAuthorization.recoveryDeadline');
  encodeManifestHash(writer, checked.slashPolicyHash, 'asyncBondedAuthorization.slashPolicyHash');
  encodeManifestHash(writer, checked.recoveryPolicyHash, 'asyncBondedAuthorization.recoveryPolicyHash');
  encodeManifestHash(writer, checked.evidenceSchemaHash, 'asyncBondedAuthorization.evidenceSchemaHash');
}

export function asyncBondedAuthorizationBytes(
  input: AsyncBondedAuthorizationInput,
): Uint8Array {
  return canonicalBytes((writer) => encodeAsyncBondedAuthorization(writer, input));
}

export function asyncBondedAuthorizationHash(
  input: AsyncBondedAuthorizationInput,
): CommitmentHash {
  return commitmentHash(
    domainHash(
      HASH_DOMAIN.ASYNC_BONDED_AUTHORIZATION,
      asyncBondedAuthorizationBytes(input),
      'asyncBondedAuthorizationHash',
    ),
    'asyncBondedAuthorizationHash',
  );
}

function requiresRequestKey(state: AsyncBondedState): boolean {
  return state === 'REQUEST_SUBMITTED'
    || state === 'VENUE_PENDING'
    || state === 'EXECUTED'
    || state === 'CANCELLED'
    || state === 'FROZEN';
}

function isVenueOutcome(state: AsyncBondedState): boolean {
  return state === 'EXECUTED' || state === 'CANCELLED' || state === 'FROZEN';
}

export function asyncBondedTransition(
  input: AsyncBondedTransitionInput,
  context = 'asyncBondedTransition',
): AsyncBondedTransition {
  object(input, context);
  exactVersion(input.version, TRANSITION_VERSION, `${context}.version`);
  enumDiscriminant(ASYNC_BONDED_STATE, input.priorState, `${context}.priorState`);
  enumDiscriminant(ASYNC_BONDED_STATE, input.nextState, `${context}.nextState`);
  if (!ALLOWED_TRANSITIONS[input.priorState].includes(input.nextState)) {
    throw new MalformedInputError(context, 'state transition is not permitted');
  }
  const priorStateVersion = exactVersionWidth(
    input.priorStateVersion,
    `${context}.priorStateVersion`,
  );
  const nextStateVersion = exactVersionWidth(
    input.nextStateVersion,
    `${context}.nextStateVersion`,
  );
  if (nextStateVersion !== priorStateVersion + 1) {
    throw new MalformedInputError(context, 'state version must increment by one');
  }
  const observedAtUnixSeconds = u64(
    input.observedAtUnixSeconds,
    `${context}.observedAtUnixSeconds`,
  );
  if (observedAtUnixSeconds === 0n) {
    throw new MalformedInputError(`${context}.observedAtUnixSeconds`, 'value is zero');
  }
  const requestKey = input.requestKey === undefined
    ? undefined
    : commitmentHash(input.requestKey, `${context}.requestKey`);
  if (
    (requiresRequestKey(input.priorState) || requiresRequestKey(input.nextState))
    && requestKey === undefined
  ) {
    throw new MalformedInputError(`${context}.requestKey`, 'request key is required');
  }
  const venueTransactionHash = input.venueTransactionHash === undefined
    ? undefined
    : commitmentHash(input.venueTransactionHash, `${context}.venueTransactionHash`);
  if (isVenueOutcome(input.nextState) && venueTransactionHash === undefined) {
    throw new MalformedInputError(
      `${context}.venueTransactionHash`,
      'venue transaction hash is required',
    );
  }
  const recoveryActionHash = input.recoveryActionHash === undefined
    ? undefined
    : commitmentHash(input.recoveryActionHash, `${context}.recoveryActionHash`);
  if (input.nextState === 'RECOVERED' && recoveryActionHash === undefined) {
    throw new MalformedInputError(
      `${context}.recoveryActionHash`,
      'recovery action hash is required',
    );
  }
  const authorizationHash = commitmentHash(
    input.authorizationHash,
    `${context}.authorizationHash`,
  );
  const evidenceHash = commitmentHash(input.evidenceHash, `${context}.evidenceHash`);
  return Object.freeze({
    version: 1 as const,
    get authorizationHash(): CommitmentHash { return commitmentHash(authorizationHash, `${context}.authorizationHash`); },
    priorState: input.priorState,
    nextState: input.nextState,
    priorStateVersion,
    nextStateVersion,
    get evidenceHash(): CommitmentHash { return commitmentHash(evidenceHash, `${context}.evidenceHash`); },
    observedAtUnixSeconds,
    ...(requestKey === undefined
      ? {}
      : { get requestKey(): CommitmentHash { return commitmentHash(requestKey, `${context}.requestKey`); } }),
    ...(venueTransactionHash === undefined
      ? {}
      : { get venueTransactionHash(): CommitmentHash { return commitmentHash(venueTransactionHash, `${context}.venueTransactionHash`); } }),
    ...(recoveryActionHash === undefined
      ? {}
      : { get recoveryActionHash(): CommitmentHash { return commitmentHash(recoveryActionHash, `${context}.recoveryActionHash`); } }),
  });
}

function exactVersionWidth(value: number, context: string): number {
  if (typeof value !== 'number') throw new MalformedInputError(context, 'expected a number');
  return Number(checkedUnsigned(value, U32_BITS, context));
}

export function encodeAsyncBondedTransition(
  writer: CanonicalWriter,
  input: AsyncBondedTransitionInput,
): void {
  const checked = asyncBondedTransition(input);
  writer.writeU32(checked.version, 'asyncBondedTransition.version');
  encodeCommitmentHash(
    writer,
    checked.authorizationHash,
    'asyncBondedTransition.authorizationHash',
  );
  writer.writeEnum(ASYNC_BONDED_STATE, checked.priorState, 'asyncBondedTransition.priorState');
  writer.writeEnum(ASYNC_BONDED_STATE, checked.nextState, 'asyncBondedTransition.nextState');
  writer.writeU32(checked.priorStateVersion, 'asyncBondedTransition.priorStateVersion');
  writer.writeU32(checked.nextStateVersion, 'asyncBondedTransition.nextStateVersion');
  encodeCommitmentHash(writer, checked.evidenceHash, 'asyncBondedTransition.evidenceHash');
  writer.writeU64(checked.observedAtUnixSeconds, 'asyncBondedTransition.observedAtUnixSeconds');
  writer.writeOptional(
    checked.requestKey,
    (target, value) => encodeCommitmentHash(target, value, 'asyncBondedTransition.requestKey'),
    'asyncBondedTransition.requestKey',
  );
  writer.writeOptional(
    checked.venueTransactionHash,
    (target, value) => encodeCommitmentHash(target, value, 'asyncBondedTransition.venueTransactionHash'),
    'asyncBondedTransition.venueTransactionHash',
  );
  writer.writeOptional(
    checked.recoveryActionHash,
    (target, value) => encodeCommitmentHash(target, value, 'asyncBondedTransition.recoveryActionHash'),
    'asyncBondedTransition.recoveryActionHash',
  );
}

export function asyncBondedTransitionBytes(
  input: AsyncBondedTransitionInput,
): Uint8Array {
  return canonicalBytes((writer) => encodeAsyncBondedTransition(writer, input));
}

export function asyncBondedTransitionHash(
  input: AsyncBondedTransitionInput,
): CommitmentHash {
  return commitmentHash(
    domainHash(
      HASH_DOMAIN.ASYNC_BONDED_TRANSITION,
      asyncBondedTransitionBytes(input),
      'asyncBondedTransitionHash',
    ),
    'asyncBondedTransitionHash',
  );
}
