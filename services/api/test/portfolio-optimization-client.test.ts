import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitmentHash,
  protocolId,
  stringifyProtocolJson,
  type PortfolioCandidateDecision,
  type PortfolioOptimizationCandidateInput,
  type PortfolioOptimizationDecision,
  type PortfolioOptimizationPolicyInput,
} from '@naryx/protocol-types';
import {
  HttpPortfolioOptimizationClient,
  PortfolioOptimizationClientError,
  type PortfolioDecisionVerifier,
} from '../src/index.js';

const hash = (fill: number) => commitmentHash(new Uint8Array(32).fill(fill));

function candidate(): PortfolioCandidateDecision {
  return Object.freeze({
    candidateId: protocolId('candidate-a'),
    candidateInputHash: hash(1),
    positionSnapshotHash: hash(2),
    collateralSnapshotHash: hash(3),
    routeHash: hash(4),
    executionGraphHash: hash(5),
    unwindRouteHash: hash(6),
    eligible: true,
    rejections: Object.freeze([]),
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

function decision(): PortfolioOptimizationDecision {
  const selected = candidate();
  return Object.freeze({
    advisory: true,
    policyHash: hash(7),
    decisionAtMs: 10n,
    candidates: Object.freeze([selected]),
    selectedCandidateId: selected.candidateId,
    decisionHash: hash(8),
  });
}

const request = Object.freeze({
  policy: {} as PortfolioOptimizationPolicyInput,
  decisionAtMs: 10n,
  candidates: [] as readonly PortfolioOptimizationCandidateInput[],
});

test('portfolio optimization client verifies a matching loopback result', async () => {
  const expected = decision();
  const verifier: PortfolioDecisionVerifier = () => expected;
  let requestUrl = '';
  let requestBody = '';
  const client = new HttpPortfolioOptimizationClient(
    'http://127.0.0.1:8788',
    (async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body);
      return new Response(stringifyProtocolJson({
        decision: expected,
        selectedCandidate: expected.candidates[0],
      }), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    verifier,
  );
  const result = await client.optimize(request);
  assert.equal(requestUrl, 'http://127.0.0.1:8788/internal/portfolio-optimization');
  assert.equal(requestBody, stringifyProtocolJson(request));
  assert.equal(result.selectedCandidate.candidateId, 'candidate-a');
});

test('portfolio optimization client refuses remote origins and mismatched decisions', async () => {
  assert.throws(
    () => new HttpPortfolioOptimizationClient('https://solver.example'),
    (error: unknown) => error instanceof PortfolioOptimizationClientError && error.code === 'INVALID_ENDPOINT',
  );
  const expected = decision();
  const tampered = { ...expected, decisionAtMs: 11n };
  const client = new HttpPortfolioOptimizationClient(
    'http://127.0.0.1:8788',
    (async () => new Response(stringifyProtocolJson({
      decision: tampered,
      selectedCandidate: expected.candidates[0],
    }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
    () => expected,
  );
  await assert.rejects(
    () => client.optimize(request),
    (error: unknown) => error instanceof PortfolioOptimizationClientError && error.code === 'INVALID_RESPONSE',
  );
});
