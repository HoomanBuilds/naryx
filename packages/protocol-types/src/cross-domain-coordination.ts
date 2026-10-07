import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes } from './encoding.js';
import { enumDiscriminant, EXPIRY_UNIT, type ExpiryUnit } from './enums.js';
import type { TerminalState } from './terminal-outcome.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { domainRef, encodeDomainRef, encodeProtocolId, protocolId, type DomainRef, type ProtocolId } from './primitives.js';
import { bytesEqual, toHex } from './bytes.js';

export const CROSS_DOMAIN_PLAN_VERSION = 1;
export const CROSS_DOMAIN_COMPENSATION_ACTION_VERSION = 1;
export const CROSS_DOMAIN_COMPENSATION_KIND = Object.freeze({
  RELEASE_RESERVED_INVENTORY: 1,
  CANCEL_PENDING_EXECUTION: 2,
  REVERSE_FILLED_LEGS: 3,
} as const);
export type CrossDomainCompensationKind = keyof typeof CROSS_DOMAIN_COMPENSATION_KIND;
const MAX_DOMAINS = 8;
const U64 = 64;
const U128 = 128;

/** Finality an event carries; only FINALIZED evidence counts toward the commit and abort rules. */
export type CrossDomainFinality = 'OBSERVED' | 'CONFIRMED' | 'FINALIZED';

export interface CrossDomainLegInput {
  readonly domain: DomainRef;
  readonly legIds: readonly string[];
  /** The solver's pre-positioned inventory reservation on this domain. */
  readonly inventoryReservationId: Uint8Array | string;
  /** Exposure while this domain is prepared and the package is not yet committed everywhere. */
  readonly interimExposureQuoteAtoms: bigint;
  /** The pre-committed action that releases or reverses this domain if the package aborts. */
  readonly compensationActionHash: Uint8Array | string;
}

/**
 * A `CROSS_DOMAIN_PREPOSITIONED` package: a solver holds inventory on every domain and a
 * coordinator drives prepare, commit, expiry, and compensation. No bridge is in the user's
 * critical path, and no step is ever described as cross-chain atomic.
 */
export interface CrossDomainPlanInput {
  readonly planVersion: number;
  readonly environment: string;
  readonly orderHash: Uint8Array | string;
  readonly quoteHash: Uint8Array | string;
  readonly routeHash: Uint8Array | string;
  readonly timeUnit: ExpiryUnit;
  readonly prepareDeadline: bigint;
  readonly commitDeadline: bigint;
  readonly compensationDeadline: bigint;
  /** Bound on simultaneous interim exposure; the sum over all domains must stay within it. */
  readonly maximumInterimExposureQuoteAtoms: bigint;
  readonly legs: readonly CrossDomainLegInput[];
}

export interface CrossDomainPlan {
  readonly planVersion: 1;
  readonly environment: ProtocolId;
  readonly orderHash: CommitmentHash;
  readonly quoteHash: CommitmentHash;
  readonly routeHash: CommitmentHash;
  readonly timeUnit: ExpiryUnit;
  readonly prepareDeadline: bigint;
  readonly commitDeadline: bigint;
  readonly compensationDeadline: bigint;
  readonly maximumInterimExposureQuoteAtoms: bigint;
  /** Sorted by domain id. */
  readonly legs: readonly {
    readonly domain: DomainRef;
    readonly legIds: readonly ProtocolId[];
    readonly inventoryReservationId: CommitmentHash;
    readonly interimExposureQuoteAtoms: bigint;
    readonly compensationActionHash: CommitmentHash;
  }[];
}

export interface CrossDomainCompensationActionInput {
  readonly actionVersion: number;
  readonly environment: string;
  readonly orderHash: Uint8Array | string;
  readonly quoteHash: Uint8Array | string;
  readonly routeHash: Uint8Array | string;
  readonly domain: DomainRef;
  readonly legIds: readonly string[];
  readonly inventoryReservationId: Uint8Array | string;
  readonly actionKind: CrossDomainCompensationKind;
  readonly executorClassId: string;
  readonly executorClassVersion: number;
  readonly executorClassManifestHash: Uint8Array | string;
  readonly actionPayloadHash: Uint8Array | string;
  readonly maximumCostQuoteAtoms: bigint;
  readonly expiryUnit: ExpiryUnit;
  readonly expiryValue: bigint;
}

export interface CrossDomainCompensationAction {
  readonly actionVersion: 1;
  readonly environment: ProtocolId;
  readonly orderHash: CommitmentHash;
  readonly quoteHash: CommitmentHash;
  readonly routeHash: CommitmentHash;
  readonly domain: DomainRef;
  readonly legIds: readonly ProtocolId[];
  readonly inventoryReservationId: CommitmentHash;
  readonly actionKind: CrossDomainCompensationKind;
  readonly executorClassId: ProtocolId;
  readonly executorClassVersion: number;
  readonly executorClassManifestHash: CommitmentHash;
  readonly actionPayloadHash: CommitmentHash;
  readonly maximumCostQuoteAtoms: bigint;
  readonly expiryUnit: ExpiryUnit;
  readonly expiryValue: bigint;
}

export interface CrossDomainExecutionBundleInput {
  readonly plan: CrossDomainPlanInput;
  readonly compensations: readonly CrossDomainCompensationActionInput[];
}

export interface CrossDomainExecutionBundle {
  readonly plan: CrossDomainPlan;
  readonly compensations: readonly CrossDomainCompensationAction[];
}

function u(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

export function crossDomainPlan(input: CrossDomainPlanInput, context = 'crossDomainPlan'): CrossDomainPlan {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError(context, 'expected an object');
  if (input.planVersion !== CROSS_DOMAIN_PLAN_VERSION) throw new MalformedInputError(`${context}.planVersion`, `version must equal ${CROSS_DOMAIN_PLAN_VERSION}`);
  enumDiscriminant(EXPIRY_UNIT, input.timeUnit, `${context}.timeUnit`);
  const prepareDeadline = u(input.prepareDeadline, U64, `${context}.prepareDeadline`);
  const commitDeadline = u(input.commitDeadline, U64, `${context}.commitDeadline`);
  if (commitDeadline <= prepareDeadline) throw new MalformedInputError(`${context}.commitDeadline`, 'commit must end after prepare');
  const compensationDeadline = u(input.compensationDeadline, U64, `${context}.compensationDeadline`);
  if (compensationDeadline <= commitDeadline) throw new MalformedInputError(`${context}.compensationDeadline`, 'compensation must end after commit');
  if (!Array.isArray(input.legs) || input.legs.length < 2 || input.legs.length > MAX_DOMAINS) {
    throw new MalformedInputError(`${context}.legs`, `a cross-domain package spans 2 to ${MAX_DOMAINS} domains`);
  }
  const legs = input.legs
    .map((leg, index) => {
      const at = `${context}.legs[${index}]`;
      if (typeof leg !== 'object' || leg === null) throw new MalformedInputError(at, 'expected an object');
      if (!Array.isArray(leg.legIds) || leg.legIds.length === 0 || leg.legIds.length > 16) throw new MalformedInputError(`${at}.legIds`, 'expected 1 to 16 legs');
      const legIds = leg.legIds.map((id: string) => protocolId(id, `${at}.legIds`)).sort();
      for (let i = 1; i < legIds.length; i += 1) if (legIds[i - 1] === legIds[i]) throw new DuplicateElementError(`${at}.legIds`, 'legs repeat');
      return Object.freeze({
        domain: domainRef(leg.domain.domainId, leg.domain.domainManifestVersion, leg.domain.domainManifestHash, `${at}.domain`),
        legIds: Object.freeze(legIds),
        inventoryReservationId: commitmentHash(leg.inventoryReservationId, `${at}.inventoryReservationId`),
        interimExposureQuoteAtoms: u(leg.interimExposureQuoteAtoms, U128, `${at}.interimExposureQuoteAtoms`),
        compensationActionHash: commitmentHash(leg.compensationActionHash, `${at}.compensationActionHash`),
      });
    })
    .sort((a, b) => (a.domain.domainId < b.domain.domainId ? -1 : a.domain.domainId > b.domain.domainId ? 1 : 0));
  for (let i = 1; i < legs.length; i += 1) {
    if ((legs[i - 1] as (typeof legs)[number]).domain.domainId === (legs[i] as (typeof legs)[number]).domain.domainId) throw new DuplicateElementError(`${context}.legs`, 'a domain appears twice');
  }
  const allLegIds = legs.flatMap((leg) => leg.legIds);
  if (new Set(allLegIds).size !== allLegIds.length) throw new DuplicateElementError(`${context}.legs`, 'a leg is placed on two domains');
  const maximum = u(input.maximumInterimExposureQuoteAtoms, U128, `${context}.maximumInterimExposureQuoteAtoms`);
  const total = legs.reduce((sum, leg) => sum + leg.interimExposureQuoteAtoms, 0n);
  if (total > maximum) throw new MalformedInputError(`${context}.maximumInterimExposureQuoteAtoms`, 'every domain prepared at once would exceed the interim exposure bound');
  return Object.freeze({
    planVersion: 1 as const,
    environment: protocolId(input.environment, `${context}.environment`),
    orderHash: commitmentHash(input.orderHash, `${context}.orderHash`),
    quoteHash: commitmentHash(input.quoteHash, `${context}.quoteHash`),
    routeHash: commitmentHash(input.routeHash, `${context}.routeHash`),
    timeUnit: input.timeUnit,
    prepareDeadline,
    commitDeadline,
    compensationDeadline,
    maximumInterimExposureQuoteAtoms: maximum,
    legs: Object.freeze(legs),
  });
}

export function crossDomainPlanHash(input: CrossDomainPlanInput): CommitmentHash {
  const plan = crossDomainPlan(input);
  const bytes = canonicalBytes((writer) => {
    writer.writeU32(plan.planVersion, 'planVersion');
    encodeProtocolId(writer, plan.environment, 'environment');
    encodeCommitmentHash(writer, plan.orderHash, 'orderHash');
    encodeCommitmentHash(writer, plan.quoteHash, 'quoteHash');
    encodeCommitmentHash(writer, plan.routeHash, 'routeHash');
    writer.writeEnum(EXPIRY_UNIT, plan.timeUnit, 'timeUnit');
    writer.writeU64(plan.prepareDeadline, 'prepareDeadline');
    writer.writeU64(plan.commitDeadline, 'commitDeadline');
    writer.writeU64(plan.compensationDeadline, 'compensationDeadline');
    writer.writeU128(plan.maximumInterimExposureQuoteAtoms, 'maximumInterimExposureQuoteAtoms');
    writer.writeArray(plan.legs, (inner, leg) => {
      encodeDomainRef(inner, leg.domain);
      inner.writeArray(leg.legIds, (w, id) => encodeProtocolId(w, id, 'legId'), 'legIds');
      encodeCommitmentHash(inner, leg.inventoryReservationId, 'inventoryReservationId');
      inner.writeU128(leg.interimExposureQuoteAtoms, 'interimExposureQuoteAtoms');
      encodeCommitmentHash(inner, leg.compensationActionHash, 'compensationActionHash');
    }, 'legs');
  });
  return commitmentHash(domainHash(HASH_DOMAIN.CROSS_DOMAIN_PLAN, bytes), 'crossDomainPlanHash');
}

export function crossDomainCompensationAction(
  input: CrossDomainCompensationActionInput,
  context = 'crossDomainCompensationAction',
): CrossDomainCompensationAction {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError(context, 'expected an object');
  if (input.actionVersion !== CROSS_DOMAIN_COMPENSATION_ACTION_VERSION) {
    throw new MalformedInputError(`${context}.actionVersion`, `version must equal ${CROSS_DOMAIN_COMPENSATION_ACTION_VERSION}`);
  }
  if (!Array.isArray(input.legIds) || input.legIds.length === 0 || input.legIds.length > 16) {
    throw new MalformedInputError(`${context}.legIds`, 'expected 1 to 16 legs');
  }
  const legIds = input.legIds.map((value) => protocolId(value, `${context}.legIds`)).sort();
  for (let index = 1; index < legIds.length; index += 1) {
    if (legIds[index - 1] === legIds[index]) throw new DuplicateElementError(`${context}.legIds`, 'legs repeat');
  }
  enumDiscriminant(CROSS_DOMAIN_COMPENSATION_KIND, input.actionKind, `${context}.actionKind`);
  enumDiscriminant(EXPIRY_UNIT, input.expiryUnit, `${context}.expiryUnit`);
  const executorClassVersion = Number(input.executorClassVersion);
  if (!Number.isSafeInteger(executorClassVersion) || executorClassVersion <= 0 || executorClassVersion > 0xffff_ffff) {
    throw new MalformedInputError(`${context}.executorClassVersion`, 'expected a positive u32');
  }
  return Object.freeze({
    actionVersion: 1 as const,
    environment: protocolId(input.environment, `${context}.environment`),
    orderHash: commitmentHash(input.orderHash, `${context}.orderHash`),
    quoteHash: commitmentHash(input.quoteHash, `${context}.quoteHash`),
    routeHash: commitmentHash(input.routeHash, `${context}.routeHash`),
    domain: domainRef(input.domain.domainId, input.domain.domainManifestVersion, input.domain.domainManifestHash, `${context}.domain`),
    legIds: Object.freeze(legIds),
    inventoryReservationId: commitmentHash(input.inventoryReservationId, `${context}.inventoryReservationId`),
    actionKind: input.actionKind,
    executorClassId: protocolId(input.executorClassId, `${context}.executorClassId`),
    executorClassVersion,
    executorClassManifestHash: commitmentHash(input.executorClassManifestHash, `${context}.executorClassManifestHash`),
    actionPayloadHash: commitmentHash(input.actionPayloadHash, `${context}.actionPayloadHash`),
    maximumCostQuoteAtoms: u(input.maximumCostQuoteAtoms, U128, `${context}.maximumCostQuoteAtoms`),
    expiryUnit: input.expiryUnit,
    expiryValue: u(input.expiryValue, U64, `${context}.expiryValue`),
  });
}

export function crossDomainCompensationActionHash(input: CrossDomainCompensationActionInput): CommitmentHash {
  const action = crossDomainCompensationAction(input);
  const bytes = canonicalBytes((writer) => {
    writer.writeU32(action.actionVersion, 'actionVersion');
    encodeProtocolId(writer, action.environment, 'environment');
    encodeCommitmentHash(writer, action.orderHash, 'orderHash');
    encodeCommitmentHash(writer, action.quoteHash, 'quoteHash');
    encodeCommitmentHash(writer, action.routeHash, 'routeHash');
    encodeDomainRef(writer, action.domain);
    writer.writeArray(action.legIds, (inner, legId) => encodeProtocolId(inner, legId, 'legId'), 'legIds');
    encodeCommitmentHash(writer, action.inventoryReservationId, 'inventoryReservationId');
    writer.writeEnum(CROSS_DOMAIN_COMPENSATION_KIND, action.actionKind, 'actionKind');
    encodeProtocolId(writer, action.executorClassId, 'executorClassId');
    writer.writeU32(action.executorClassVersion, 'executorClassVersion');
    encodeCommitmentHash(writer, action.executorClassManifestHash, 'executorClassManifestHash');
    encodeCommitmentHash(writer, action.actionPayloadHash, 'actionPayloadHash');
    writer.writeU128(action.maximumCostQuoteAtoms, 'maximumCostQuoteAtoms');
    writer.writeEnum(EXPIRY_UNIT, action.expiryUnit, 'expiryUnit');
    writer.writeU64(action.expiryValue, 'expiryValue');
  });
  return commitmentHash(domainHash(HASH_DOMAIN.CROSS_DOMAIN_COMPENSATION, bytes), 'crossDomainCompensationActionHash');
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

export function crossDomainExecutionBundle(
  input: CrossDomainExecutionBundleInput,
  context = 'crossDomainExecutionBundle',
): CrossDomainExecutionBundle {
  if (typeof input !== 'object' || input === null || !Array.isArray(input.compensations)) {
    throw new MalformedInputError(context, 'expected a plan and compensation actions');
  }
  const plan = crossDomainPlan(input.plan, `${context}.plan`);
  if (input.compensations.length !== plan.legs.length) {
    throw new MalformedInputError(`${context}.compensations`, 'every domain requires one compensation action');
  }
  const compensations = input.compensations
    .map((value, index) => crossDomainCompensationAction(value, `${context}.compensations[${index}]`))
    .sort((left, right) => left.domain.domainId.localeCompare(right.domain.domainId));
  for (const leg of plan.legs) {
    const matches = compensations.filter((action) => sameDomain(action.domain, leg.domain));
    if (matches.length !== 1) throw new MalformedInputError(`${context}.compensations`, `domain ${leg.domain.domainId} must have exactly one action`);
    const action = matches[0]!;
    if (action.environment !== plan.environment || !bytesEqual(action.orderHash, plan.orderHash)
      || !bytesEqual(action.quoteHash, plan.quoteHash) || !bytesEqual(action.routeHash, plan.routeHash)) {
      throw new MalformedInputError(`${context}.compensations`, `action for ${leg.domain.domainId} binds another package`);
    }
    if (action.legIds.length !== leg.legIds.length || action.legIds.some((legId, index) => legId !== leg.legIds[index])
      || !bytesEqual(action.inventoryReservationId, leg.inventoryReservationId)) {
      throw new MalformedInputError(`${context}.compensations`, `action for ${leg.domain.domainId} binds another reservation or leg set`);
    }
    if (action.expiryUnit !== plan.timeUnit || action.expiryValue !== plan.compensationDeadline) {
      throw new MalformedInputError(`${context}.compensations`, `action for ${leg.domain.domainId} has another compensation window`);
    }
    if (!bytesEqual(crossDomainCompensationActionHash(action), leg.compensationActionHash)) {
      throw new MalformedInputError(`${context}.compensations`, `action for ${leg.domain.domainId} does not match its plan commitment`);
    }
  }
  return Object.freeze({ plan, compensations: Object.freeze(compensations) });
}

export type CrossDomainEvent =
  | { readonly kind: 'PREPARED' | 'COMMITTED' | 'COMPENSATED'; readonly domainId: string; readonly evidenceHash: Uint8Array | string; readonly finality: CrossDomainFinality; readonly atValue: bigint }
  | { readonly kind: 'PREPARE_FAILED'; readonly domainId: string; readonly evidenceHash: Uint8Array | string; readonly atValue: bigint };

export type CrossDomainDomainStatus = 'PENDING' | 'PREPARING' | 'PREPARED' | 'FAILED' | 'COMMITTING' | 'COMMITTED' | 'COMPENSATING' | 'COMPENSATED';
export type CrossDomainPhase = 'PREPARING' | 'COMMITTING' | 'COMMITTED' | 'ABORTING' | 'ABORTED' | 'FENCED';
export type CrossDomainAction =
  | { readonly kind: 'PREPARE' | 'COMMIT' | 'COMPENSATE' | 'AWAIT_FINALITY'; readonly domainId: string }
  | { readonly kind: 'ESCALATE'; readonly reason: string };

export interface CrossDomainCoordination {
  readonly planHash: string;
  readonly phase: CrossDomainPhase;
  readonly domains: Readonly<Record<string, CrossDomainDomainStatus>>;
  /** Interim exposure of domains prepared but not yet committed or compensated. */
  readonly interimExposureQuoteAtoms: bigint;
  readonly terminalState?: TerminalState;
  readonly nextActions: readonly CrossDomainAction[];
  readonly violations: readonly string[];
}

/**
 * Replays a coordination from its plan and ordered per-domain evidence, so a coordinator that
 * crashed recomputes exactly where it was and what it must do next. The commit rule: every domain
 * prepared with FINALIZED evidence no later than the prepare deadline. Any failure or expiry
 * before that aborts, and every prepared domain is compensated with its pre-signed action. After
 * the commit decision every domain must commit; a commit deadline passed, conflicting evidence
 * for one domain, commit and compensation mixed, or time running backward fences the package for
 * manual controlled recovery. Terminal precedence: fenced over everything, then committed
 * everywhere (FINALIZED_COMPLETE), then aborted with compensations (RECOVERED_FLAT) or aborted
 * with nothing prepared (NO_EFFECT).
 */
export function replayCrossDomainCoordination(planInput: CrossDomainPlanInput, events: readonly CrossDomainEvent[], nowValue: bigint): CrossDomainCoordination {
  const plan = crossDomainPlan(planInput);
  const now = u(nowValue, U64, 'replayCrossDomainCoordination.nowValue');
  const status = new Map<string, CrossDomainDomainStatus>(plan.legs.map((leg) => [leg.domain.domainId, 'PENDING']));
  const seen = new Map<string, string>();
  const violations: string[] = [];
  let phase = 'PREPARING' as CrossDomainPhase;
  let lastAt = 0n;
  let anyPrepared = false;
  const fence = (reason: string) => {
    violations.push(reason);
    phase = 'FENCED';
  };
  if (!Array.isArray(events) || events.length > 16 * MAX_DOMAINS) throw new MalformedInputError('replayCrossDomainCoordination.events', 'too many events');
  for (const [index, event] of events.entries()) {
    if (phase === 'FENCED') break;
    const at = u(event.atValue, U64, `events[${index}].atValue`);
    if (at < lastAt) {
      fence(`events[${index}] runs backward in time`);
      break;
    }
    lastAt = at;
    const current = status.get(event.domainId);
    if (current === undefined) {
      fence(`events[${index}] names a domain outside the plan`);
      break;
    }
    const evidence = toHex(commitmentHash(event.evidenceHash, `events[${index}].evidenceHash`));
    const key = `${event.kind}/${event.domainId}`;
    const earlier = seen.get(key);
    if (earlier !== undefined && earlier !== evidence) {
      fence(`conflicting ${event.kind} evidence for ${event.domainId}`);
      break;
    }
    seen.set(key, evidence);
    const finalized = event.kind === 'PREPARE_FAILED' || event.finality === 'FINALIZED';
    switch (event.kind) {
      case 'PREPARED':
        if (phase !== 'PREPARING' && phase !== 'ABORTING') { fence(`${event.domainId} prepared after ${phase}`); break; }
        if (current !== 'PENDING' && current !== 'PREPARING') { fence(`${event.domainId} prepared from ${current}`); break; }
        if (at > plan.prepareDeadline && phase === 'PREPARING') { violations.push(`${event.domainId} prepared after the prepare deadline`); phase = 'ABORTING'; }
        status.set(event.domainId, finalized ? 'PREPARED' : 'PREPARING');
        anyPrepared = true;
        break;
      case 'PREPARE_FAILED':
        // A domain seen preparing, prepared, or compensating cannot also have failed to prepare:
        // overwriting it would skip the compensation of inventory it may hold.
        if (current !== 'PENDING' && current !== 'FAILED') { fence(`${event.domainId} failed to prepare after ${current}`); break; }
        status.set(event.domainId, 'FAILED');
        if (phase === 'PREPARING') phase = 'ABORTING';
        else if (phase === 'COMMITTING') fence(`${event.domainId} failed after the commit decision`);
        break;
      case 'COMMITTED':
        if (phase !== 'COMMITTING' && phase !== 'COMMITTED') { fence(`${event.domainId} committed without a commit decision`); break; }
        if (at > plan.commitDeadline) { fence(`${event.domainId} committed after the commit deadline`); break; }
        status.set(event.domainId, finalized ? 'COMMITTED' : 'COMMITTING');
        break;
      case 'COMPENSATED':
        if (phase !== 'ABORTING' && phase !== 'ABORTED') { fence(`${event.domainId} compensated outside an abort`); break; }
        if (current !== 'PREPARED' && current !== 'PREPARING' && current !== 'COMPENSATING') { fence(`${event.domainId} compensated from ${current}`); break; }
        if (at > plan.compensationDeadline) { fence(`${event.domainId} compensated after the compensation deadline`); break; }
        status.set(event.domainId, finalized ? 'COMPENSATED' : 'COMPENSATING');
        break;
      default:
        fence(`events[${index}] has an unknown kind`);
    }
    if (phase === 'PREPARING' && [...status.values()].every((value) => value === 'PREPARED')) phase = 'COMMITTING';
    if (phase === 'COMMITTING' && [...status.values()].every((value) => value === 'COMMITTED')) phase = 'COMMITTED';
    if (phase === 'ABORTING' && [...status.values()].every((value) => value === 'PENDING' || value === 'FAILED' || value === 'COMPENSATED')) phase = 'ABORTED';
  }
  // Deadlines judged at `now`.
  if (phase === 'PREPARING' && now > plan.prepareDeadline) {
    phase = [...status.values()].some((value) => value === 'PREPARED' || value === 'PREPARING') ? 'ABORTING' : 'ABORTED';
  }
  if (phase === 'COMMITTING' && now > plan.commitDeadline) fence('the commit deadline passed before every domain committed');
  if (phase === 'ABORTING' && now > plan.compensationDeadline) fence('the compensation deadline passed before every prepared domain was compensated');

  const interim = plan.legs
    .filter((leg) => ['PREPARING', 'PREPARED', 'COMMITTING', 'COMPENSATING'].includes(status.get(leg.domain.domainId) as string))
    .reduce((sum, leg) => sum + leg.interimExposureQuoteAtoms, 0n);
  if (interim > plan.maximumInterimExposureQuoteAtoms && phase !== 'FENCED') fence('interim exposure exceeds the plan bound');

  const nextActions: CrossDomainAction[] = [];
  for (const leg of plan.legs) {
    const id = leg.domain.domainId;
    const value = status.get(id) as CrossDomainDomainStatus;
    if (phase === 'PREPARING' && value === 'PENDING') nextActions.push({ kind: 'PREPARE', domainId: id });
    else if (phase === 'COMMITTING' && value === 'PREPARED') nextActions.push({ kind: 'COMMIT', domainId: id });
    // A preparing domain that never finalized is compensated too; waiting is not enough once aborting.
    else if (phase === 'ABORTING' && (value === 'PREPARED' || value === 'PREPARING')) nextActions.push({ kind: 'COMPENSATE', domainId: id });
    else if ((phase === 'PREPARING' || phase === 'COMMITTING' || phase === 'ABORTING') && (value === 'PREPARING' || value === 'COMMITTING' || value === 'COMPENSATING')) {
      nextActions.push({ kind: 'AWAIT_FINALITY', domainId: id });
    }
  }
  if (phase === 'FENCED') nextActions.push({ kind: 'ESCALATE', reason: violations[violations.length - 1] ?? 'fenced' });
  const terminalState: TerminalState | undefined =
    phase === 'FENCED' ? 'MANUAL_INTERVENTION' : phase === 'COMMITTED' ? 'FINALIZED_COMPLETE' : phase === 'ABORTED' ? (anyPrepared ? 'RECOVERED_FLAT' : 'NO_EFFECT') : undefined;
  return Object.freeze({
    planHash: toHex(crossDomainPlanHash(planInput)),
    phase,
    domains: Object.freeze(Object.fromEntries(status)),
    interimExposureQuoteAtoms: interim,
    ...(terminalState === undefined ? {} : { terminalState }),
    nextActions: Object.freeze(nextActions),
    violations: Object.freeze(violations),
  });
}
