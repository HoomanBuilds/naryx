import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  deliveryPathEvidence,
  measureExecutionQuality,
  replayRouteDecision,
  routeDecisionHash,
  toHex,
  type DeliveryAttempt,
  type DeliveryPolicy,
  type EligibleRouteSummary,
  type ExecutionObservation,
  type RouteDecisionInput,
} from '../src/index.js';

const hash = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const summary = (fill: number, expectedNetOutcomeAtoms: bigint, feesAtoms: bigint, residualAtoms: bigint): EligibleRouteSummary => ({
  routeHash: hash(fill),
  expectedNetOutcomeAtoms,
  feesAtoms,
  marginAtoms: 500n,
  residualAtoms,
  recoveryBoundAtoms: 20n,
  completionCohortBps: 9_900n,
  deliveryPolicyId: 'private-relay',
  resourceHeadroomBps: 4_000n,
});

const decision: RouteDecisionInput = {
  decisionVersion: 1,
  orderHash: hash(1),
  solverId: 'solver-a',
  stateSnapshots: [
    { domainId: 'svm:solana-devnet', sourceId: 'rpc-a', sequence: 9_001n, receivedAtValue: 95n, stateHash: hash(2) },
    { domainId: 'hyperliquid:testnet', sourceId: 'ws-a', sequence: 77n, receivedAtValue: 90n, stateHash: hash(3) },
  ],
  normalizationPolicyHash: hash(4),
  objective: { kind: 'MAXIMIZE_NET_OUTCOME', maximumResidualAtoms: 50n, maximumStateAgeValue: 50n, maximumSourceSkewValue: 20n },
  eligible: [summary(10, 100n, 5n, 0n), summary(11, 100n, 3n, 10n), summary(12, 90n, 1n, 0n)],
  excluded: [{ routeHash: hash(13), reason: 'STALE_STATE' }],
  selectedRouteHash: hash(11),
  resourcePlanHash: hash(5),
  decisionAtValue: 100n,
  quoteToSubmitBudgetValue: 2n,
};

describe('route-decision replay', () => {
  test('recomputes the declared winner from the bounded evidence', () => {
    const replay = replayRouteDecision(decision);
    assert.equal(replay.valid, true);
    assert.deepEqual(replay.discrepancies, []);
    assert.equal(toHex(replay.recomputedRouteHash as Uint8Array), toHex(hash(11)));
    const reordered = { ...decision, eligible: [...decision.eligible].reverse() };
    assert.equal(toHex(routeDecisionHash(reordered)), toHex(replay.decisionHash));
  });

  test('a different objective selects differently and each objective is bound into the hash', () => {
    const residual = { ...decision, objective: { ...decision.objective, kind: 'MINIMIZE_RESIDUAL' as const } };
    const replay = replayRouteDecision(residual);
    assert.deepEqual(replay.discrepancies, ['SELECTED_NOT_WINNER']);
    assert.equal(toHex(replay.recomputedRouteHash as Uint8Array), toHex(hash(10)));
    assert.notEqual(toHex(replay.selectionObjectiveHash), toHex(replayRouteDecision(decision).selectionObjectiveHash));
    assert.equal(replayRouteDecision({ ...residual, selectedRouteHash: hash(10) }).valid, true);
  });

  test('substituted selection, misclassified candidates, and stale or skewed state are caught', () => {
    assert.deepEqual(replayRouteDecision({ ...decision, selectedRouteHash: hash(10) }).discrepancies, ['SELECTED_NOT_WINNER']);
    assert.deepEqual(replayRouteDecision({ ...decision, selectedRouteHash: hash(13) }).discrepancies, ['SELECTED_NOT_ELIGIBLE']);
    const tight = replayRouteDecision({ ...decision, objective: { ...decision.objective, maximumResidualAtoms: 5n } });
    assert.deepEqual(tight.discrepancies, ['ELIGIBLE_ABOVE_RESIDUAL_LIMIT', 'SELECTED_NOT_WINNER']);
    assert.equal(toHex(tight.recomputedRouteHash as Uint8Array), toHex(hash(10)));
    const snapshot = decision.stateSnapshots[0] as RouteDecisionInput['stateSnapshots'][number];
    assert.deepEqual(replayRouteDecision({ ...decision, stateSnapshots: [{ ...snapshot, receivedAtValue: 40n }] }).discrepancies, ['STATE_TOO_STALE']);
    assert.deepEqual(replayRouteDecision({ ...decision, stateSnapshots: [{ ...snapshot, receivedAtValue: 101n }] }).discrepancies, ['STATE_FROM_FUTURE']);
    assert.deepEqual(
      replayRouteDecision({ ...decision, stateSnapshots: [snapshot, { ...snapshot, sourceId: 'rpc-b', receivedAtValue: 70n }] }).discrepancies,
      ['SOURCE_SKEW_EXCEEDED'],
    );
    assert.deepEqual(replayRouteDecision({ ...decision, eligible: [] }).discrepancies, ['EMPTY_ELIGIBLE_SET', 'SELECTED_NOT_ELIGIBLE']);
  });

  test('a route cannot be both eligible and excluded', () => {
    assert.throws(() => routeDecisionHash({ ...decision, excluded: [{ routeHash: hash(10), reason: 'UNSAFE_RESIDUAL' }] }), /twice/);
    assert.throws(() => routeDecisionHash({ ...decision, stateSnapshots: [] }), /state snapshot/);
  });
});

const observation: ExecutionObservation = {
  orderHash: hash(1),
  side: 'BUY',
  quotedPrice: 10_000n,
  inclusionReferencePrice: 10_010n,
  executionPrice: 10_005n,
  markouts: [
    { horizonValue: 60n, referencePrice: 10_020n },
    { horizonValue: 300n, referencePrice: 9_990n },
  ],
  expectedNetOutcomeAtoms: 1_000n,
  realizedNetOutcomeAtoms: 940n,
  submittedAtValue: 90n,
  includedAtValue: 100n,
  legCompletedAtValues: [100n, 130n, 110n],
  ordering: { sameActorBefore: false, sameActorAfter: false },
  adverseMoveThresholdBps: 5n,
};

describe('execution quality and MEV measurement', () => {
  test('measures movement, slippage, markouts, shortfall, latency, and unhedged time exactly', () => {
    const quality = measureExecutionQuality(observation);
    assert.equal(quality.preInclusionMoveBps, 10n);
    assert.equal(quality.slippageBps, 5n);
    assert.deepEqual(quality.markouts, [
      { horizonValue: 60n, makerAdverseSelectionBps: 15n },
      { horizonValue: 300n, makerAdverseSelectionBps: -14n },
    ]);
    assert.equal(quality.shortfallAtoms, 60n);
    assert.equal(quality.inclusionLatencyValue, 10n);
    assert.equal(quality.timeUnhedgedValue, 30n);
  });

  test('costs round up and improvements never round in the trader favor', () => {
    const tiny = measureExecutionQuality({ ...observation, quotedPrice: 3n, inclusionReferencePrice: 4n, executionPrice: 2n, markouts: [] });
    assert.equal(tiny.preInclusionMoveBps, 3_334n);
    assert.equal(tiny.slippageBps, -3_333n);
    assert.equal(measureExecutionQuality({ ...observation, side: 'SELL' }).preInclusionMoveBps, -10n);
  });

  test('only direct ordering evidence makes an attribution a fact', () => {
    const inferred = measureExecutionQuality(observation);
    assert.deepEqual([inferred.attribution, inferred.confidence, inferred.attributionIsFact], ['ADVERSE_MOVE_UNATTRIBUTED', 'INFERRED', false]);
    const suspicious = measureExecutionQuality({ ...observation, ordering: { sameActorBefore: true, sameActorAfter: true } });
    assert.equal(suspicious.attributionIsFact, false);
    const evidenced = measureExecutionQuality({ ...observation, ordering: { sameActorBefore: true, sameActorAfter: true, evidenceHash: hash(9) } });
    assert.deepEqual([evidenced.attribution, evidenced.confidence, evidenced.attributionIsFact], ['OBSERVED_SANDWICH', 'EVIDENCED', true]);
    assert.equal(measureExecutionQuality({ ...observation, adverseMoveThresholdBps: 50n }).attribution, 'NONE_DETECTED');
    assert.notEqual(toHex(evidenced.measurementHash), toHex(inferred.measurementHash));
  });

  test('malformed observations reject', () => {
    assert.throws(() => measureExecutionQuality({ ...observation, quotedPrice: 0n }), /positive/);
    assert.throws(() => measureExecutionQuality({ ...observation, includedAtValue: 80n }), /precedes submission/);
    assert.throws(() => measureExecutionQuality({ ...observation, markouts: [...observation.markouts].reverse() }), /strictly increase/);
  });
});

describe('delivery-path evidence', () => {
  const policy: DeliveryPolicy = {
    requestedPath: 'PRIVATE_RELAY',
    permittedFallbacks: ['PROTECTED_BUNDLE'],
    maximumInclusionDelayValue: 10n,
    provenProtectedPaths: ['PROTECTED_BUNDLE'],
  };
  const attempt = (attemptId: string, path: DeliveryAttempt['path'], submittedAtValue: bigint, outcome: DeliveryAttempt['outcome'], includedAtValue?: bigint): DeliveryAttempt =>
    includedAtValue === undefined ? { attemptId, path, submittedAtValue, outcome } : { attemptId, path, submittedAtValue, outcome, includedAtValue };

  test('a private relay reduces exposure but is never labeled as proven protection', () => {
    const evidence = deliveryPathEvidence(policy, [attempt('a1', 'PRIVATE_RELAY', 100n, 'INCLUDED', 104n)], 110n);
    assert.deepEqual([evidence.actualPath, evidence.inclusionDelayValue, evidence.fallbackUsed, evidence.mevProtectionLabel], ['PRIVATE_RELAY', 4n, false, 'REDUCED_PUBLIC_EXPOSURE']);
    assert.deepEqual(evidence.violations, []);
  });

  test('a permitted fallback to a domain-proven path earns the protected label', () => {
    const evidence = deliveryPathEvidence(policy, [attempt('a2', 'PROTECTED_BUNDLE', 103n, 'INCLUDED', 108n), attempt('a1', 'PRIVATE_RELAY', 100n, 'DROPPED')], 110n);
    assert.deepEqual([evidence.actualPath, evidence.inclusionDelayValue, evidence.fallbackUsed, evidence.mevProtectionLabel], ['PROTECTED_BUNDLE', 8n, true, 'DOMAIN_PROVEN_PROTECTED']);
  });

  test('unauthorized public fallback, late or double inclusion, and overdue delivery are violations', () => {
    const publicFallback = deliveryPathEvidence(policy, [attempt('a1', 'PRIVATE_RELAY', 100n, 'DROPPED'), attempt('a2', 'PUBLIC_MEMPOOL', 105n, 'INCLUDED', 107n)], 110n);
    assert.deepEqual(publicFallback.violations, ['UNAUTHORIZED_PATH']);
    assert.equal(publicFallback.mevProtectionLabel, 'NONE');
    assert.deepEqual(deliveryPathEvidence(policy, [attempt('a1', 'PRIVATE_RELAY', 100n, 'INCLUDED', 120n)], 130n).violations, ['INCLUSION_LATE']);
    const doubled = deliveryPathEvidence(policy, [attempt('a1', 'PRIVATE_RELAY', 100n, 'INCLUDED', 102n), attempt('a2', 'PROTECTED_BUNDLE', 101n, 'INCLUDED', 103n)], 110n);
    assert.deepEqual(doubled.violations, ['MULTIPLE_INCLUSIONS']);
    assert.notEqual(doubled.mevProtectionLabel, 'DOMAIN_PROVEN_PROTECTED');
    assert.deepEqual(deliveryPathEvidence(policy, [attempt('a1', 'PROTECTED_BUNDLE', 100n, 'INCLUDED', 101n)], 110n).violations, ['FIRST_ATTEMPT_NOT_REQUESTED']);
  });

  test('missing inclusion is only a censorship suspicion, and only after the deadline', () => {
    const pending = [attempt('a1', 'PRIVATE_RELAY', 100n, 'PENDING')];
    assert.equal(deliveryPathEvidence(policy, pending, 105n).censorshipSuspected, false);
    const overdue = deliveryPathEvidence(policy, pending, 115n);
    assert.equal(overdue.censorshipSuspected, true);
    assert.deepEqual(overdue.violations, ['NOT_INCLUDED_PAST_DEADLINE']);
    assert.equal(overdue.actualPath, null);
    assert.throws(() => deliveryPathEvidence(policy, [{ ...attempt('a1', 'PRIVATE_RELAY', 100n, 'DROPPED'), includedAtValue: 101n }], 110n), /only an included attempt/);
  });
});
