import { checkedSigned, checkedUnsigned, mulDiv, ROUNDING } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { enumDiscriminant, type EnumTable } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';

export const ROUTE_DECISION_VERSION = 1;
export const EXECUTION_INTELLIGENCE_VERSION = 1;
export const ROUTE_DECISION_MAX_CANDIDATES = 64;
export const EXECUTION_QUALITY_MAX_MARKOUTS = 16;
const BPS = 10_000n;
const U64_BITS = 64;
const U128_BITS = 128;
const I128_BITS = 128;

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function requireArray(value: unknown, context: string, maximum: number): void {
  if (!Array.isArray(value)) throw new MalformedInputError(context, 'expected an array');
  if (value.length > maximum) throw new MalformedInputError(context, `more than ${maximum} entries`);
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function signed(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedSigned(value, I128_BITS, context);
}

function bool(value: boolean, context: string): boolean {
  if (typeof value !== 'boolean') throw new MalformedInputError(context, 'expected a boolean');
  return value;
}

function variant<Name extends string>(table: EnumTable<Name>, value: Name, context: string): Name {
  enumDiscriminant(table, value, context);
  return value;
}

function bps(value: bigint, context: string): bigint {
  const checked = unsigned(value, U64_BITS, context);
  if (checked > BPS) throw new MalformedInputError(context, 'basis points exceed 10000');
  return checked;
}

// ------------------------------------------------------------------ route-decision proof

export const ROUTE_EXCLUSION_REASON = Object.freeze({
  STALE_STATE: 1,
  UNSUPPORTED_AUTHORITY: 2,
  INADEQUATE_LIQUIDITY: 3,
  UNSAFE_RESIDUAL: 4,
  UNAVAILABLE_RECOVERY: 5,
  RESOURCE_OVERFLOW: 6,
} as const);
export type RouteExclusionReason = keyof typeof ROUTE_EXCLUSION_REASON;

export const SELECTION_OBJECTIVE = Object.freeze({
  MAXIMIZE_NET_OUTCOME: 1,
  MINIMIZE_RESIDUAL: 2,
} as const);
export type SelectionObjectiveKind = keyof typeof SELECTION_OBJECTIVE;

export interface StateSnapshotRef {
  readonly domainId: string;
  readonly sourceId: string;
  readonly sequence: bigint;
  readonly receivedAtValue: bigint;
  readonly stateHash: Uint8Array | string;
}

export interface SelectionObjective {
  readonly kind: SelectionObjectiveKind;
  readonly maximumResidualAtoms: bigint;
  readonly maximumStateAgeValue: bigint;
  readonly maximumSourceSkewValue: bigint;
}

export interface EligibleRouteSummary {
  readonly routeHash: Uint8Array | string;
  /** Fee-complete net package outcome in quote atoms; higher is better for the user. */
  readonly expectedNetOutcomeAtoms: bigint;
  readonly feesAtoms: bigint;
  readonly marginAtoms: bigint;
  readonly residualAtoms: bigint;
  readonly recoveryBoundAtoms: bigint;
  readonly completionCohortBps: bigint;
  readonly deliveryPolicyId: string;
  readonly resourceHeadroomBps: bigint;
}

export interface ExcludedRouteSummary {
  readonly routeHash: Uint8Array | string;
  readonly reason: RouteExclusionReason;
}

export interface RouteDecisionInput {
  readonly decisionVersion: number;
  readonly orderHash: Uint8Array | string;
  readonly solverId: string;
  readonly stateSnapshots: readonly StateSnapshotRef[];
  readonly normalizationPolicyHash: Uint8Array | string;
  readonly objective: SelectionObjective;
  readonly eligible: readonly EligibleRouteSummary[];
  readonly excluded: readonly ExcludedRouteSummary[];
  readonly selectedRouteHash: Uint8Array | string;
  readonly resourcePlanHash: Uint8Array | string;
  readonly decisionAtValue: bigint;
  readonly quoteToSubmitBudgetValue: bigint;
}

interface CheckedEligible extends Omit<EligibleRouteSummary, 'routeHash' | 'deliveryPolicyId'> {
  readonly routeHash: CommitmentHash;
  readonly deliveryPolicyId: ProtocolId;
}

interface CheckedDecision {
  readonly orderHash: CommitmentHash;
  readonly solverId: ProtocolId;
  readonly snapshots: readonly (Omit<StateSnapshotRef, 'domainId' | 'sourceId' | 'stateHash'> & { domainId: ProtocolId; sourceId: ProtocolId; stateHash: CommitmentHash })[];
  readonly normalizationPolicyHash: CommitmentHash;
  readonly objective: SelectionObjective;
  readonly eligible: readonly CheckedEligible[];
  readonly excluded: readonly { readonly routeHash: CommitmentHash; readonly reason: RouteExclusionReason }[];
  readonly selectedRouteHash: CommitmentHash;
  readonly resourcePlanHash: CommitmentHash;
  readonly decisionAtValue: bigint;
  readonly quoteToSubmitBudgetValue: bigint;
}

function checkedDecision(input: RouteDecisionInput): CheckedDecision {
  const context = 'routeDecision';
  object(input, context);
  if (input.decisionVersion !== ROUTE_DECISION_VERSION) {
    throw new MalformedInputError(`${context}.decisionVersion`, `version must equal ${ROUTE_DECISION_VERSION}`);
  }
  requireArray(input.stateSnapshots, `${context}.stateSnapshots`, ROUTE_DECISION_MAX_CANDIDATES);
  if (input.stateSnapshots.length === 0) throw new MalformedInputError(`${context}.stateSnapshots`, 'a decision needs its state snapshot');
  requireArray(input.eligible, `${context}.eligible`, ROUTE_DECISION_MAX_CANDIDATES);
  requireArray(input.excluded, `${context}.excluded`, ROUTE_DECISION_MAX_CANDIDATES);
  object(input.objective, `${context}.objective`);
  const objective = Object.freeze({
    kind: variant(SELECTION_OBJECTIVE, input.objective.kind, `${context}.objective.kind`),
    maximumResidualAtoms: unsigned(input.objective.maximumResidualAtoms, U128_BITS, `${context}.objective.maximumResidualAtoms`),
    maximumStateAgeValue: unsigned(input.objective.maximumStateAgeValue, U64_BITS, `${context}.objective.maximumStateAgeValue`),
    maximumSourceSkewValue: unsigned(input.objective.maximumSourceSkewValue, U64_BITS, `${context}.objective.maximumSourceSkewValue`),
  });
  const snapshots = input.stateSnapshots.map((snapshot, index) => {
    const at = `${context}.stateSnapshots[${index}]`;
    object(snapshot, at);
    return Object.freeze({
      domainId: protocolId(snapshot.domainId, `${at}.domainId`),
      sourceId: protocolId(snapshot.sourceId, `${at}.sourceId`),
      sequence: unsigned(snapshot.sequence, U64_BITS, `${at}.sequence`),
      receivedAtValue: unsigned(snapshot.receivedAtValue, U64_BITS, `${at}.receivedAtValue`),
      stateHash: commitmentHash(snapshot.stateHash, `${at}.stateHash`),
    });
  });
  const eligible = input.eligible.map((summary, index) => {
    const at = `${context}.eligible[${index}]`;
    object(summary, at);
    return Object.freeze({
      routeHash: commitmentHash(summary.routeHash, `${at}.routeHash`),
      expectedNetOutcomeAtoms: signed(summary.expectedNetOutcomeAtoms, `${at}.expectedNetOutcomeAtoms`),
      feesAtoms: unsigned(summary.feesAtoms, U128_BITS, `${at}.feesAtoms`),
      marginAtoms: unsigned(summary.marginAtoms, U128_BITS, `${at}.marginAtoms`),
      residualAtoms: unsigned(summary.residualAtoms, U128_BITS, `${at}.residualAtoms`),
      recoveryBoundAtoms: unsigned(summary.recoveryBoundAtoms, U128_BITS, `${at}.recoveryBoundAtoms`),
      completionCohortBps: bps(summary.completionCohortBps, `${at}.completionCohortBps`),
      deliveryPolicyId: protocolId(summary.deliveryPolicyId, `${at}.deliveryPolicyId`),
      resourceHeadroomBps: bps(summary.resourceHeadroomBps, `${at}.resourceHeadroomBps`),
    });
  });
  const excluded = input.excluded.map((summary, index) => {
    const at = `${context}.excluded[${index}]`;
    object(summary, at);
    return Object.freeze({
      routeHash: commitmentHash(summary.routeHash, `${at}.routeHash`),
      reason: variant(ROUTE_EXCLUSION_REASON, summary.reason, `${at}.reason`),
    });
  });
  const hashes = [...eligible, ...excluded].map((entry) => entry.routeHash).sort(compareBytes);
  for (let index = 1; index < hashes.length; index += 1) {
    if (compareBytes(hashes[index - 1] as Uint8Array, hashes[index] as Uint8Array) === 0) {
      throw new DuplicateElementError(`${context}.candidates`, 'a route appears twice in the candidate set');
    }
  }
  if (hashes.length === 0) throw new MalformedInputError(`${context}.candidates`, 'the candidate set is empty');
  return Object.freeze({
    orderHash: commitmentHash(input.orderHash, `${context}.orderHash`),
    solverId: protocolId(input.solverId, `${context}.solverId`),
    snapshots: Object.freeze(snapshots),
    normalizationPolicyHash: commitmentHash(input.normalizationPolicyHash, `${context}.normalizationPolicyHash`),
    objective,
    eligible: Object.freeze([...eligible].sort((a, b) => compareBytes(a.routeHash, b.routeHash))),
    excluded: Object.freeze([...excluded].sort((a, b) => compareBytes(a.routeHash, b.routeHash))),
    selectedRouteHash: commitmentHash(input.selectedRouteHash, `${context}.selectedRouteHash`),
    resourcePlanHash: commitmentHash(input.resourcePlanHash, `${context}.resourcePlanHash`),
    decisionAtValue: unsigned(input.decisionAtValue, U64_BITS, `${context}.decisionAtValue`),
    quoteToSubmitBudgetValue: unsigned(input.quoteToSubmitBudgetValue, U64_BITS, `${context}.quoteToSubmitBudgetValue`),
  });
}

function encodeEligible(writer: CanonicalWriter, summary: CheckedEligible): void {
  encodeCommitmentHash(writer, summary.routeHash, 'routeHash');
  writer.writeI128(summary.expectedNetOutcomeAtoms, 'expectedNetOutcomeAtoms');
  writer.writeU128(summary.feesAtoms, 'feesAtoms');
  writer.writeU128(summary.marginAtoms, 'marginAtoms');
  writer.writeU128(summary.residualAtoms, 'residualAtoms');
  writer.writeU128(summary.recoveryBoundAtoms, 'recoveryBoundAtoms');
  writer.writeU64(summary.completionCohortBps, 'completionCohortBps');
  encodeProtocolId(writer, summary.deliveryPolicyId, 'deliveryPolicyId');
  writer.writeU64(summary.resourceHeadroomBps, 'resourceHeadroomBps');
}

function hashes(decision: CheckedDecision): { candidateRouteSetHash: CommitmentHash; selectionObjectiveHash: CommitmentHash; decisionHash: CommitmentHash } {
  const candidateRouteSetHash = commitmentHash(
    domainHash(
      HASH_DOMAIN.ROUTE_CANDIDATE_SET,
      canonicalBytes((writer) => {
        encodeCommitmentHash(writer, decision.orderHash, 'orderHash');
        writer.writeArray(decision.eligible, encodeEligible, 'eligible');
        writer.writeArray(decision.excluded, (element, summary) => {
          encodeCommitmentHash(element, summary.routeHash, 'routeHash');
          element.writeEnum(ROUTE_EXCLUSION_REASON, summary.reason, 'reason');
        }, 'excluded');
      }),
    ),
    'candidateRouteSetHash',
  );
  const selectionObjectiveHash = commitmentHash(
    domainHash(
      HASH_DOMAIN.ROUTE_SELECTION_OBJECTIVE,
      canonicalBytes((writer) => {
        writer.writeEnum(SELECTION_OBJECTIVE, decision.objective.kind, 'kind');
        writer.writeU128(decision.objective.maximumResidualAtoms, 'maximumResidualAtoms');
        writer.writeU64(decision.objective.maximumStateAgeValue, 'maximumStateAgeValue');
        writer.writeU64(decision.objective.maximumSourceSkewValue, 'maximumSourceSkewValue');
      }),
    ),
    'selectionObjectiveHash',
  );
  const decisionHash = commitmentHash(
    domainHash(
      HASH_DOMAIN.ROUTE_DECISION,
      canonicalBytes((writer) => {
        writer.writeU32(ROUTE_DECISION_VERSION, 'decisionVersion');
        encodeCommitmentHash(writer, decision.orderHash, 'orderHash');
        encodeProtocolId(writer, decision.solverId, 'solverId');
        writer.writeArray(decision.snapshots, (element, snapshot) => {
          encodeProtocolId(element, snapshot.domainId, 'domainId');
          encodeProtocolId(element, snapshot.sourceId, 'sourceId');
          element.writeU64(snapshot.sequence, 'sequence');
          element.writeU64(snapshot.receivedAtValue, 'receivedAtValue');
          encodeCommitmentHash(element, snapshot.stateHash, 'stateHash');
        }, 'stateSnapshots');
        encodeCommitmentHash(writer, candidateRouteSetHash, 'candidateRouteSetHash');
        encodeCommitmentHash(writer, decision.normalizationPolicyHash, 'normalizationPolicyHash');
        encodeCommitmentHash(writer, selectionObjectiveHash, 'selectionObjectiveHash');
        encodeCommitmentHash(writer, decision.selectedRouteHash, 'selectedRouteHash');
        encodeCommitmentHash(writer, decision.resourcePlanHash, 'resourcePlanHash');
        writer.writeU64(decision.decisionAtValue, 'decisionAtValue');
        writer.writeU64(decision.quoteToSubmitBudgetValue, 'quoteToSubmitBudgetValue');
      }),
    ),
    'routeDecisionHash',
  );
  return { candidateRouteSetHash, selectionObjectiveHash, decisionHash };
}

export function routeDecisionHash(input: RouteDecisionInput): CommitmentHash {
  return hashes(checkedDecision(input)).decisionHash;
}

export type RouteDecisionDiscrepancy =
  | 'STATE_FROM_FUTURE'
  | 'STATE_TOO_STALE'
  | 'SOURCE_SKEW_EXCEEDED'
  | 'ELIGIBLE_ABOVE_RESIDUAL_LIMIT'
  | 'EMPTY_ELIGIBLE_SET'
  | 'SELECTED_NOT_ELIGIBLE'
  | 'SELECTED_NOT_WINNER';

export interface RouteDecisionReplay {
  readonly valid: boolean;
  readonly discrepancies: readonly RouteDecisionDiscrepancy[];
  readonly recomputedRouteHash?: CommitmentHash;
  readonly candidateRouteSetHash: CommitmentHash;
  readonly selectionObjectiveHash: CommitmentHash;
  readonly decisionHash: CommitmentHash;
}

function compareCandidates(kind: SelectionObjectiveKind): (left: CheckedEligible, right: CheckedEligible) => number {
  const outcome = (left: CheckedEligible, right: CheckedEligible) =>
    left.expectedNetOutcomeAtoms === right.expectedNetOutcomeAtoms ? 0 : left.expectedNetOutcomeAtoms > right.expectedNetOutcomeAtoms ? -1 : 1;
  const ascending = (field: 'feesAtoms' | 'residualAtoms') => (left: CheckedEligible, right: CheckedEligible) =>
    left[field] === right[field] ? 0 : left[field] < right[field] ? -1 : 1;
  const order = kind === 'MAXIMIZE_NET_OUTCOME' ? [outcome, ascending('feesAtoms'), ascending('residualAtoms')] : [ascending('residualAtoms'), outcome, ascending('feesAtoms')];
  return (left, right) => {
    for (const compare of order) {
      const result = compare(left, right);
      if (result !== 0) return result;
    }
    return compareBytes(left.routeHash, right.routeHash);
  };
}

/**
 * Replays a signed route decision from its bounded evidence. It proves only that the declared
 * candidate set was normalized and selected under the declared objective from fresh, consistent
 * state; it never proves that a globally optimal route existed or was found.
 */
export function replayRouteDecision(input: RouteDecisionInput): RouteDecisionReplay {
  const decision = checkedDecision(input);
  const discrepancies: RouteDecisionDiscrepancy[] = [];
  const received = decision.snapshots.map((snapshot) => snapshot.receivedAtValue);
  if (received.some((value) => value > decision.decisionAtValue)) discrepancies.push('STATE_FROM_FUTURE');
  if (received.some((value) => value <= decision.decisionAtValue && decision.decisionAtValue - value > decision.objective.maximumStateAgeValue)) {
    discrepancies.push('STATE_TOO_STALE');
  }
  const newest = received.reduce((a, b) => (a > b ? a : b));
  const oldest = received.reduce((a, b) => (a < b ? a : b));
  if (newest - oldest > decision.objective.maximumSourceSkewValue) discrepancies.push('SOURCE_SKEW_EXCEEDED');
  if (decision.eligible.some((summary) => summary.residualAtoms > decision.objective.maximumResidualAtoms)) {
    discrepancies.push('ELIGIBLE_ABOVE_RESIDUAL_LIMIT');
  }
  const ranked = [...decision.eligible]
    .filter((summary) => summary.residualAtoms <= decision.objective.maximumResidualAtoms)
    .sort(compareCandidates(decision.objective.kind));
  const winner = ranked[0];
  if (winner === undefined) discrepancies.push('EMPTY_ELIGIBLE_SET');
  if (!decision.eligible.some((summary) => compareBytes(summary.routeHash, decision.selectedRouteHash) === 0)) {
    discrepancies.push('SELECTED_NOT_ELIGIBLE');
  } else if (winner !== undefined && compareBytes(winner.routeHash, decision.selectedRouteHash) !== 0) {
    discrepancies.push('SELECTED_NOT_WINNER');
  }
  const base = { valid: discrepancies.length === 0, discrepancies: Object.freeze(discrepancies), ...hashes(decision) };
  return Object.freeze(winner === undefined ? base : { ...base, recomputedRouteHash: winner.routeHash });
}

// ------------------------------------------------------------------ execution quality and MEV

export const MEV_ATTRIBUTION = Object.freeze({
  NONE_DETECTED: 1,
  ADVERSE_MOVE_UNATTRIBUTED: 2,
  OBSERVED_SANDWICH: 3,
} as const);
export type MevAttribution = keyof typeof MEV_ATTRIBUTION;

export const ATTRIBUTION_CONFIDENCE = Object.freeze({
  NONE: 1,
  INFERRED: 2,
  EVIDENCED: 3,
} as const);
export type AttributionConfidence = keyof typeof ATTRIBUTION_CONFIDENCE;

export interface ExecutionObservation {
  readonly orderHash: Uint8Array | string;
  /** The taker's side of the package price: BUY pays the price, SELL receives it. */
  readonly side: 'BUY' | 'SELL';
  /** All prices share one exact scale in quote atoms per package unit and are positive. */
  readonly quotedPrice: bigint;
  readonly inclusionReferencePrice: bigint;
  readonly executionPrice: bigint;
  readonly markouts: readonly { readonly horizonValue: bigint; readonly referencePrice: bigint }[];
  readonly expectedNetOutcomeAtoms: bigint;
  readonly realizedNetOutcomeAtoms: bigint;
  readonly submittedAtValue: bigint;
  readonly includedAtValue: bigint;
  readonly legCompletedAtValues: readonly bigint[];
  /** Same-actor transactions directly around the package action in one ordering unit. */
  readonly ordering: { readonly sameActorBefore: boolean; readonly sameActorAfter: boolean; readonly evidenceHash?: Uint8Array | string };
  readonly adverseMoveThresholdBps: bigint;
}

export interface ExecutionQuality {
  /** Price movement against the taker between quote and inclusion; positive is a cost. */
  readonly preInclusionMoveBps: bigint;
  /** Execution against the quote; positive is a cost, negative is price improvement. */
  readonly slippageBps: bigint;
  /** Post-fill movement in the taker's favor, which is the maker's adverse selection. */
  readonly markouts: readonly { readonly horizonValue: bigint; readonly makerAdverseSelectionBps: bigint }[];
  /** Expected minus realized net outcome; positive means the package did worse than quoted. */
  readonly shortfallAtoms: bigint;
  readonly inclusionLatencyValue: bigint;
  readonly timeUnhedgedValue: bigint;
  readonly attribution: MevAttribution;
  readonly confidence: AttributionConfidence;
  /** Only direct ordering evidence makes an attribution a fact; an inference is never shown as one. */
  readonly attributionIsFact: boolean;
  readonly measurementHash: CommitmentHash;
}

/** Signed movement in basis points, rounded up so a cost is never understated and an improvement never overstated. */
function costBps(sign: bigint, from: bigint, to: bigint): bigint {
  return mulDiv(sign * (to - from), BPS, from, ROUNDING.CEIL, 'costBps');
}

function price(value: bigint, context: string): bigint {
  const checked = unsigned(value, U128_BITS, context);
  if (checked === 0n) throw new MalformedInputError(context, 'price must be positive');
  return checked;
}

export function measureExecutionQuality(observation: ExecutionObservation): ExecutionQuality {
  const context = 'measureExecutionQuality';
  object(observation, context);
  if (observation.side !== 'BUY' && observation.side !== 'SELL') throw new MalformedInputError(`${context}.side`, 'expected BUY or SELL');
  const sign = observation.side === 'BUY' ? 1n : -1n;
  const quoted = price(observation.quotedPrice, `${context}.quotedPrice`);
  const inclusion = price(observation.inclusionReferencePrice, `${context}.inclusionReferencePrice`);
  const execution = price(observation.executionPrice, `${context}.executionPrice`);
  requireArray(observation.markouts, `${context}.markouts`, EXECUTION_QUALITY_MAX_MARKOUTS);
  const markouts = observation.markouts.map((markout, index) => {
    object(markout, `${context}.markouts[${index}]`);
    const horizonValue = unsigned(markout.horizonValue, U64_BITS, `${context}.markouts[${index}].horizonValue`);
    const reference = price(markout.referencePrice, `${context}.markouts[${index}].referencePrice`);
    return Object.freeze({ horizonValue, makerAdverseSelectionBps: costBps(sign, execution, reference) });
  });
  for (let index = 1; index < markouts.length; index += 1) {
    if ((markouts[index - 1] as { horizonValue: bigint }).horizonValue >= (markouts[index] as { horizonValue: bigint }).horizonValue) {
      throw new MalformedInputError(`${context}.markouts`, 'horizons must strictly increase');
    }
  }
  const submitted = unsigned(observation.submittedAtValue, U64_BITS, `${context}.submittedAtValue`);
  const included = unsigned(observation.includedAtValue, U64_BITS, `${context}.includedAtValue`);
  if (included < submitted) throw new MalformedInputError(`${context}.includedAtValue`, 'inclusion precedes submission');
  requireArray(observation.legCompletedAtValues, `${context}.legCompletedAtValues`, 16);
  if (observation.legCompletedAtValues.length === 0) throw new MalformedInputError(`${context}.legCompletedAtValues`, 'no leg completed');
  const completions = observation.legCompletedAtValues.map((value, index) => unsigned(value, U64_BITS, `${context}.legCompletedAtValues[${index}]`));
  const timeUnhedgedValue = completions.reduce((a, b) => (a > b ? a : b)) - completions.reduce((a, b) => (a < b ? a : b));
  const shortfallAtoms = signed(observation.expectedNetOutcomeAtoms, `${context}.expectedNetOutcomeAtoms`) - signed(observation.realizedNetOutcomeAtoms, `${context}.realizedNetOutcomeAtoms`);
  const preInclusionMoveBps = costBps(sign, quoted, inclusion);
  const slippageBps = costBps(sign, quoted, execution);
  const threshold = unsigned(observation.adverseMoveThresholdBps, U64_BITS, `${context}.adverseMoveThresholdBps`);

  object(observation.ordering, `${context}.ordering`);
  const before = bool(observation.ordering.sameActorBefore, `${context}.ordering.sameActorBefore`);
  const after = bool(observation.ordering.sameActorAfter, `${context}.ordering.sameActorAfter`);
  const evidence = observation.ordering.evidenceHash === undefined ? undefined : commitmentHash(observation.ordering.evidenceHash, `${context}.ordering.evidenceHash`);
  let attribution: MevAttribution = 'NONE_DETECTED';
  let confidence: AttributionConfidence = 'NONE';
  if (before && after && evidence !== undefined && preInclusionMoveBps > 0n) {
    attribution = 'OBSERVED_SANDWICH';
    confidence = 'EVIDENCED';
  } else if (preInclusionMoveBps > threshold) {
    attribution = 'ADVERSE_MOVE_UNATTRIBUTED';
    confidence = 'INFERRED';
  }
  const orderHash = commitmentHash(observation.orderHash, `${context}.orderHash`);
  const bytes = canonicalBytes((writer) => {
    encodeCommitmentHash(writer, orderHash, 'orderHash');
    writer.writeI128(preInclusionMoveBps, 'preInclusionMoveBps');
    writer.writeI128(slippageBps, 'slippageBps');
    writer.writeArray(markouts, (element, markout) => {
      element.writeU64(markout.horizonValue, 'horizonValue');
      element.writeI128(markout.makerAdverseSelectionBps, 'makerAdverseSelectionBps');
    });
    writer.writeI128(shortfallAtoms, 'shortfallAtoms');
    writer.writeU64(included - submitted, 'inclusionLatencyValue');
    writer.writeU64(timeUnhedgedValue, 'timeUnhedgedValue');
    writer.writeEnum(MEV_ATTRIBUTION, attribution, 'attribution');
    writer.writeEnum(ATTRIBUTION_CONFIDENCE, confidence, 'confidence');
    writer.writeOptional(evidence, (element, hash) => encodeCommitmentHash(element, hash, 'evidenceHash'), 'evidenceHash');
  });
  return Object.freeze({
    preInclusionMoveBps,
    slippageBps,
    markouts: Object.freeze(markouts),
    shortfallAtoms,
    inclusionLatencyValue: included - submitted,
    timeUnhedgedValue,
    attribution,
    confidence,
    attributionIsFact: confidence === 'EVIDENCED',
    measurementHash: commitmentHash(domainHash(HASH_DOMAIN.EXECUTION_QUALITY, bytes), 'executionQualityHash'),
  });
}

// ------------------------------------------------------------------ delivery-path evidence

export const DELIVERY_PATH = Object.freeze({
  PUBLIC_MEMPOOL: 1,
  PRIVATE_RELAY: 2,
  PROTECTED_BUNDLE: 3,
  SEQUENCER_DIRECT: 4,
  VENUE_API: 5,
} as const);
export type DeliveryPath = keyof typeof DELIVERY_PATH;

export interface DeliveryPolicy {
  readonly requestedPath: DeliveryPath;
  readonly permittedFallbacks: readonly DeliveryPath[];
  readonly maximumInclusionDelayValue: bigint;
  /** Paths whose protected-inclusion behavior is proven for this exact domain. */
  readonly provenProtectedPaths: readonly DeliveryPath[];
}

export interface DeliveryAttempt {
  readonly attemptId: string;
  readonly path: DeliveryPath;
  readonly submittedAtValue: bigint;
  readonly outcome: 'INCLUDED' | 'DROPPED' | 'REJECTED' | 'PENDING';
  readonly includedAtValue?: bigint;
}

export type DeliveryViolation = 'UNAUTHORIZED_PATH' | 'FIRST_ATTEMPT_NOT_REQUESTED' | 'MULTIPLE_INCLUSIONS' | 'INCLUSION_LATE' | 'NOT_INCLUDED_PAST_DEADLINE';

export interface DeliveryEvidence {
  readonly requestedPath: DeliveryPath;
  readonly actualPath: DeliveryPath | null;
  readonly included: boolean;
  readonly inclusionDelayValue: bigint | null;
  readonly fallbackUsed: boolean;
  readonly violations: readonly DeliveryViolation[];
  /** A suspicion only: the action was not included in time. Censorship is never asserted as fact. */
  readonly censorshipSuspected: boolean;
  readonly mevProtectionLabel: 'NONE' | 'REDUCED_PUBLIC_EXPOSURE' | 'DOMAIN_PROVEN_PROTECTED';
  readonly evidenceHash: CommitmentHash;
}

function pathSet(values: readonly DeliveryPath[], context: string): ReadonlySet<DeliveryPath> {
  requireArray(values, context, 8);
  const set = new Set(values.map((value) => variant(DELIVERY_PATH, value, context)));
  if (set.size !== values.length) throw new DuplicateElementError(context, 'paths repeat');
  return set;
}

/**
 * Records the requested and actual delivery path, fallback, inclusion, and timing. Protection is
 * labeled only as strongly as the evidence allows: a private relay reduces public exposure but is
 * never called complete MEV protection, and any public-mempool attempt forfeits the label.
 */
export function deliveryPathEvidence(policy: DeliveryPolicy, attempts: readonly DeliveryAttempt[], observedAtValue: bigint): DeliveryEvidence {
  const context = 'deliveryPathEvidence';
  object(policy, `${context}.policy`);
  const requestedPath = variant(DELIVERY_PATH, policy.requestedPath, `${context}.policy.requestedPath`);
  const fallbacks = pathSet(policy.permittedFallbacks, `${context}.policy.permittedFallbacks`);
  const proven = pathSet(policy.provenProtectedPaths, `${context}.policy.provenProtectedPaths`);
  const maximumDelay = unsigned(policy.maximumInclusionDelayValue, U64_BITS, `${context}.policy.maximumInclusionDelayValue`);
  const observedAt = unsigned(observedAtValue, U64_BITS, `${context}.observedAtValue`);
  requireArray(attempts, `${context}.attempts`, 16);
  if (attempts.length === 0) throw new MalformedInputError(`${context}.attempts`, 'nothing was submitted');
  const ids = new Set<string>();
  const checked = attempts.map((attempt, index) => {
    const at = `${context}.attempts[${index}]`;
    object(attempt, at);
    const attemptId = protocolId(attempt.attemptId, `${at}.attemptId`);
    if (ids.has(attemptId)) throw new DuplicateElementError(`${context}.attempts`, 'attempt identifiers repeat');
    ids.add(attemptId);
    if (!['INCLUDED', 'DROPPED', 'REJECTED', 'PENDING'].includes(attempt.outcome)) throw new MalformedInputError(`${at}.outcome`, 'unknown outcome');
    const submittedAtValue = unsigned(attempt.submittedAtValue, U64_BITS, `${at}.submittedAtValue`);
    let includedAtValue: bigint | undefined;
    if (attempt.outcome === 'INCLUDED') {
      if (attempt.includedAtValue === undefined) throw new MalformedInputError(`${at}.includedAtValue`, 'an included attempt needs its inclusion time');
      includedAtValue = unsigned(attempt.includedAtValue, U64_BITS, `${at}.includedAtValue`);
      if (includedAtValue < submittedAtValue) throw new MalformedInputError(`${at}.includedAtValue`, 'inclusion precedes submission');
    } else if (attempt.includedAtValue !== undefined) {
      throw new MalformedInputError(`${at}.includedAtValue`, 'only an included attempt has an inclusion time');
    }
    return { attemptId, path: variant(DELIVERY_PATH, attempt.path, `${at}.path`), submittedAtValue, outcome: attempt.outcome, includedAtValue };
  }).sort((left, right) => (left.submittedAtValue === right.submittedAtValue ? (left.attemptId < right.attemptId ? -1 : 1) : left.submittedAtValue < right.submittedAtValue ? -1 : 1));
  if (checked.some((attempt) => attempt.submittedAtValue > observedAt || (attempt.includedAtValue !== undefined && attempt.includedAtValue > observedAt))) {
    throw new MalformedInputError(`${context}.observedAtValue`, 'observation precedes an attempt event');
  }

  const first = checked[0] as (typeof checked)[number];
  const violations: DeliveryViolation[] = [];
  if (first.path !== requestedPath) violations.push('FIRST_ATTEMPT_NOT_REQUESTED');
  if (checked.some((attempt) => attempt.path !== requestedPath && !fallbacks.has(attempt.path))) violations.push('UNAUTHORIZED_PATH');
  const inclusions = checked.filter((attempt) => attempt.outcome === 'INCLUDED');
  if (inclusions.length > 1) violations.push('MULTIPLE_INCLUSIONS');
  const inclusion = inclusions[0];
  const inclusionDelayValue = inclusion === undefined ? null : (inclusion.includedAtValue as bigint) - first.submittedAtValue;
  if (inclusionDelayValue !== null && inclusionDelayValue > maximumDelay) violations.push('INCLUSION_LATE');
  const overdue = inclusion === undefined && observedAt >= first.submittedAtValue && observedAt - first.submittedAtValue > maximumDelay;
  if (overdue) violations.push('NOT_INCLUDED_PAST_DEADLINE');
  const touchedPublic = checked.some((attempt) => attempt.path === 'PUBLIC_MEMPOOL');
  const mevProtectionLabel = touchedPublic
    ? ('NONE' as const)
    : inclusion !== undefined && proven.has(inclusion.path) && inclusions.length === 1
      ? ('DOMAIN_PROVEN_PROTECTED' as const)
      : ('REDUCED_PUBLIC_EXPOSURE' as const);
  const actualPath = inclusion === undefined ? null : inclusion.path;
  const fallbackUsed = checked.some((attempt) => attempt.path !== requestedPath);
  const bytes = canonicalBytes((writer) => {
    writer.writeEnum(DELIVERY_PATH, requestedPath, 'requestedPath');
    writer.writeArray(checked, (element, attempt) => {
      encodeProtocolId(element, attempt.attemptId, 'attemptId');
      element.writeEnum(DELIVERY_PATH, attempt.path, 'path');
      element.writeU64(attempt.submittedAtValue, 'submittedAtValue');
      element.writeString(attempt.outcome, 'outcome');
      element.writeOptional(attempt.includedAtValue, (inner, value) => inner.writeU64(value, 'includedAtValue'), 'includedAtValue');
    });
    writer.writeU64(observedAt, 'observedAtValue');
    writer.writeArray(violations, (element, violation) => element.writeString(violation, 'violation'));
    writer.writeString(mevProtectionLabel, 'mevProtectionLabel');
  });
  return Object.freeze({
    requestedPath,
    actualPath,
    included: inclusion !== undefined,
    inclusionDelayValue,
    fallbackUsed,
    violations: Object.freeze(violations),
    censorshipSuspected: overdue,
    mevProtectionLabel,
    evidenceHash: commitmentHash(domainHash(HASH_DOMAIN.DELIVERY_EVIDENCE, bytes), 'deliveryEvidenceHash'),
  });
}

export interface ExecutionIntelligenceInput {
  readonly version: number;
  readonly receiptHash: Uint8Array | string;
  readonly orderHash: Uint8Array | string;
  readonly observerId: string;
  /** Unit shared by submission, inclusion, leg-completion, markout, and observation times. */
  readonly clockUnit: string;
  /** Hash of the exact RPC, venue, trace, or sequencer evidence retained by the observer. */
  readonly observerEvidenceHash: Uint8Array | string;
  readonly observation: ExecutionObservation;
  readonly deliveryPolicy: DeliveryPolicy;
  readonly deliveryAttempts: readonly DeliveryAttempt[];
  readonly observedAtValue: bigint;
}

export interface ExecutionIntelligence {
  readonly version: 1;
  readonly receiptHash: CommitmentHash;
  readonly orderHash: CommitmentHash;
  readonly observerId: ProtocolId;
  readonly clockUnit: ProtocolId;
  readonly observerEvidenceHash: CommitmentHash;
  readonly observation: ExecutionObservation;
  readonly deliveryPolicy: DeliveryPolicy;
  readonly deliveryAttempts: readonly DeliveryAttempt[];
  readonly observedAtValue: bigint;
  readonly quality: ExecutionQuality;
  readonly delivery: DeliveryEvidence;
  readonly recordHash: CommitmentHash;
}

export function executionIntelligence(input: ExecutionIntelligenceInput): ExecutionIntelligence {
  const context = 'executionIntelligence';
  object(input, context);
  if (input.version !== EXECUTION_INTELLIGENCE_VERSION) {
    throw new MalformedInputError(`${context}.version`, `version must equal ${EXECUTION_INTELLIGENCE_VERSION}`);
  }
  const receiptHash = commitmentHash(input.receiptHash, `${context}.receiptHash`);
  const orderHash = commitmentHash(input.orderHash, `${context}.orderHash`);
  const observerId = protocolId(input.observerId, `${context}.observerId`);
  const clockUnit = protocolId(input.clockUnit, `${context}.clockUnit`);
  const observerEvidenceHash = commitmentHash(input.observerEvidenceHash, `${context}.observerEvidenceHash`);
  const quality = measureExecutionQuality(input.observation);
  if (compareBytes(commitmentHash(input.observation.orderHash, `${context}.observation.orderHash`), orderHash) !== 0) {
    throw new MalformedInputError(`${context}.observation.orderHash`, 'observation names another order');
  }
  const delivery = deliveryPathEvidence(input.deliveryPolicy, input.deliveryAttempts, input.observedAtValue);
  const observedAtValue = unsigned(input.observedAtValue, U64_BITS, `${context}.observedAtValue`);
  const permittedFallbacks = [...input.deliveryPolicy.permittedFallbacks]
    .sort((left, right) => DELIVERY_PATH[left] - DELIVERY_PATH[right]);
  const provenProtectedPaths = [...input.deliveryPolicy.provenProtectedPaths]
    .sort((left, right) => DELIVERY_PATH[left] - DELIVERY_PATH[right]);
  const deliveryPolicy = Object.freeze({
    requestedPath: input.deliveryPolicy.requestedPath,
    permittedFallbacks: Object.freeze(permittedFallbacks),
    maximumInclusionDelayValue: input.deliveryPolicy.maximumInclusionDelayValue,
    provenProtectedPaths: Object.freeze(provenProtectedPaths),
  });
  const deliveryAttempts = Object.freeze([...input.deliveryAttempts]
    .sort((left, right) => left.submittedAtValue === right.submittedAtValue
      ? left.attemptId.localeCompare(right.attemptId)
      : left.submittedAtValue < right.submittedAtValue ? -1 : 1));
  const recordHash = commitmentHash(
    domainHash(
      HASH_DOMAIN.EXECUTION_INTELLIGENCE,
      canonicalBytes((writer) => {
        writer.writeU32(EXECUTION_INTELLIGENCE_VERSION, 'version');
        encodeCommitmentHash(writer, receiptHash, 'receiptHash');
        encodeCommitmentHash(writer, orderHash, 'orderHash');
        encodeProtocolId(writer, observerId, 'observerId');
        encodeProtocolId(writer, clockUnit, 'clockUnit');
        encodeCommitmentHash(writer, observerEvidenceHash, 'observerEvidenceHash');
        writer.writeString(input.observation.side, 'side');
        writer.writeU128(input.observation.quotedPrice, 'quotedPrice');
        writer.writeU128(input.observation.inclusionReferencePrice, 'inclusionReferencePrice');
        writer.writeU128(input.observation.executionPrice, 'executionPrice');
        writer.writeArray(input.observation.markouts, (element, markout) => {
          element.writeU64(markout.horizonValue, 'horizonValue');
          element.writeU128(markout.referencePrice, 'referencePrice');
        }, 'markouts');
        writer.writeI128(input.observation.expectedNetOutcomeAtoms, 'expectedNetOutcomeAtoms');
        writer.writeI128(input.observation.realizedNetOutcomeAtoms, 'realizedNetOutcomeAtoms');
        writer.writeU64(input.observation.submittedAtValue, 'submittedAtValue');
        writer.writeU64(input.observation.includedAtValue, 'includedAtValue');
        writer.writeArray(input.observation.legCompletedAtValues, (element, value) => element.writeU64(value, 'completedAtValue'), 'legCompletedAtValues');
        writer.writeBool(input.observation.ordering.sameActorBefore, 'sameActorBefore');
        writer.writeBool(input.observation.ordering.sameActorAfter, 'sameActorAfter');
        writer.writeOptional(input.observation.ordering.evidenceHash, (element, value) => encodeCommitmentHash(element, commitmentHash(value, 'orderingEvidenceHash'), 'orderingEvidenceHash'), 'orderingEvidenceHash');
        writer.writeU64(input.observation.adverseMoveThresholdBps, 'adverseMoveThresholdBps');
        writer.writeEnum(DELIVERY_PATH, deliveryPolicy.requestedPath, 'requestedPath');
        writer.writeArray(deliveryPolicy.permittedFallbacks, (element, value) => element.writeEnum(DELIVERY_PATH, value, 'permittedFallback'), 'permittedFallbacks');
        writer.writeU64(deliveryPolicy.maximumInclusionDelayValue, 'maximumInclusionDelayValue');
        writer.writeArray(deliveryPolicy.provenProtectedPaths, (element, value) => element.writeEnum(DELIVERY_PATH, value, 'provenProtectedPath'), 'provenProtectedPaths');
        writer.writeArray(deliveryAttempts, (element, attempt) => {
          encodeProtocolId(element, protocolId(attempt.attemptId, 'attemptId'), 'attemptId');
          element.writeEnum(DELIVERY_PATH, attempt.path, 'path');
          element.writeU64(attempt.submittedAtValue, 'submittedAtValue');
          element.writeString(attempt.outcome, 'outcome');
          element.writeOptional(attempt.includedAtValue, (inner, value) => inner.writeU64(value, 'includedAtValue'), 'includedAtValue');
        }, 'deliveryAttempts');
        encodeCommitmentHash(writer, quality.measurementHash, 'measurementHash');
        encodeCommitmentHash(writer, delivery.evidenceHash, 'deliveryEvidenceHash');
        writer.writeU64(observedAtValue, 'observedAtValue');
      }),
    ),
    `${context}.recordHash`,
  );
  return Object.freeze({
    version: 1 as const,
    receiptHash,
    orderHash,
    observerId,
    clockUnit,
    observerEvidenceHash,
    observation: input.observation,
    deliveryPolicy,
    deliveryAttempts,
    observedAtValue,
    quality,
    delivery,
    recordHash,
  });
}
