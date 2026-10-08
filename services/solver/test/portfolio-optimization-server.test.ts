import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  commitmentHash,
  parseProtocolJson,
  protocolId,
  stringifyProtocolJson,
  type PortfolioCandidateDecision,
  type PortfolioOptimizationDecision,
} from '@naryx/protocol-types';
import {
  createPortfolioOptimizationInternalHandler,
  PortfolioOptimizationServiceError,
} from '../src/index.js';

const hash = (fill: number) => commitmentHash(new Uint8Array(32).fill(fill));

function selectedCandidate(): PortfolioCandidateDecision {
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

function decision(withSelection: boolean): PortfolioOptimizationDecision {
  const candidate = selectedCandidate();
  return Object.freeze({
    advisory: true,
    policyHash: hash(7),
    decisionAtMs: 10n,
    candidates: Object.freeze([candidate]),
    ...(withSelection ? { selectedCandidateId: candidate.candidateId } : {}),
    decisionHash: hash(8),
  });
}

test('portfolio optimization handler permits direct loopback and maps typed failures', async () => {
  const accepted = decision(true);
  const rejected = decision(false);
  const handler = createPortfolioOptimizationInternalHandler({
    decide: (request) => {
      if (request.decisionAtMs === 11n) {
        throw new PortfolioOptimizationServiceError('NO_ELIGIBLE_CANDIDATE', rejected);
      }
      return { decision: accepted, selectedCandidate: accepted.candidates[0]! };
    },
  });
  const server = createServer(async (request, response) => {
    if (!(await handler(request, response))) response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server address is unavailable');
  const url = `http://127.0.0.1:${address.port}/internal/portfolio-optimization`;
  const request = { candidates: [], decisionAtMs: 10n, policy: {} };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringifyProtocolJson(request),
    });
    assert.equal(response.status, 200);
    const result = parseProtocolJson(await response.text()) as { decision: PortfolioOptimizationDecision };
    assert.equal(result.decision.selectedCandidateId, 'candidate-a');
    assert.equal((await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://terminal.example' },
      body: stringifyProtocolJson(request),
    })).status, 403);
    assert.equal((await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringifyProtocolJson({ ...request, decisionAtMs: 11n }),
    })).status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});
