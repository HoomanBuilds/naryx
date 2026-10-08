import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PortfolioCandidateDecision,
  PortfolioOptimizationCandidateInput,
  PortfolioOptimizationDecision,
  PortfolioOptimizationPolicyInput,
} from '@naryx/protocol-types';
import { commitmentHash, protocolId } from '@naryx/protocol-types';
import {
  PortfolioOptimizationService,
  PortfolioOptimizationServiceError,
  type PortfolioOptimizer,
} from '../src/index.js';

const hash = (fill: number) => commitmentHash(new Uint8Array(32).fill(fill));

function candidate(candidateId: string, eligible: boolean): PortfolioCandidateDecision {
  const rejections = eligible ? [] as const : ['INACTIVE'] as const;
  return Object.freeze({
    candidateId: protocolId(candidateId),
    candidateInputHash: hash(1),
    positionSnapshotHash: hash(2),
    collateralSnapshotHash: hash(3),
    routeHash: hash(4),
    executionGraphHash: hash(5),
    unwindRouteHash: hash(6),
    eligible,
    rejections,
    metrics: Object.freeze({
      netOutcomeQuoteAtoms: 1n,
      totalCostQuoteAtoms: 2n,
      requiredCollateralQuoteAtoms: 3n,
      effectiveCollateralQuoteAtoms: 4n,
      maximumStressLossQuoteAtoms: 5n,
      timeToUnwindMs: 6n,
      solverConcentrationBps: 7n,
    }),
  });
}

function decision(selectedCandidateId?: string, selectedEligible = true): PortfolioOptimizationDecision {
  const candidates = [candidate('candidate-a', selectedEligible)];
  return Object.freeze({
    advisory: true,
    policyHash: hash(7),
    decisionAtMs: 10n,
    candidates,
    ...(selectedCandidateId === undefined ? {} : { selectedCandidateId: protocolId(selectedCandidateId) }),
    decisionHash: hash(8),
  });
}

const request = Object.freeze({
  policy: {} as PortfolioOptimizationPolicyInput,
  decisionAtMs: 10n,
  candidates: [] as readonly PortfolioOptimizationCandidateInput[],
});

test('returns the exact eligible candidate selected by the protocol optimizer', () => {
  let received: readonly unknown[] | undefined;
  const optimizer: PortfolioOptimizer = (policy, decisionAtMs, candidates) => {
    received = [policy, decisionAtMs, candidates];
    return decision('candidate-a');
  };
  const result = new PortfolioOptimizationService(optimizer).decide(request);
  assert.deepEqual(received, [request.policy, request.decisionAtMs, request.candidates]);
  assert.equal(result.selectedCandidate.candidateId, 'candidate-a');
  assert.equal(result.selectedCandidate.eligible, true);
  assert.equal(result.decision.advisory, true);
});

test('fails closed when there is no eligible selection or the optimizer returns an invalid winner', () => {
  assert.throws(
    () => new PortfolioOptimizationService(() => decision()).decide(request),
    (error: unknown) => {
      assert.ok(error instanceof PortfolioOptimizationServiceError);
      assert.equal(error.code, 'NO_ELIGIBLE_CANDIDATE');
      return true;
    },
  );
  assert.throws(
    () => new PortfolioOptimizationService(() => decision('candidate-a', false)).decide(request),
    (error: unknown) => {
      assert.ok(error instanceof PortfolioOptimizationServiceError);
      assert.equal(error.code, 'INVALID_OPTIMIZER_DECISION');
      return true;
    },
  );
  assert.throws(
    () => new PortfolioOptimizationService(() => decision('missing')).decide(request),
    (error: unknown) => {
      assert.ok(error instanceof PortfolioOptimizationServiceError);
      assert.equal(error.code, 'INVALID_OPTIMIZER_DECISION');
      return true;
    },
  );
});
