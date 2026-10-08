import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DuplicateElementError,
  MalformedInputError,
  assetRef,
  collateralSnapshotHash,
  optimizePortfolio,
  portfolioOptimizationPolicyHash,
  toHex,
  type CollateralSnapshotInput,
  type MarginOffsetContext,
  type MarginOffsetPolicy,
  type NormalizedPositionInput,
  type PortfolioOptimizationCandidateInput,
  type PortfolioOptimizationPolicyInput,
  type PositionSnapshotRecordInput,
} from '../src/index.js';
import { DOMAIN, USD } from './solver-fixtures.js';

const SOL = assetRef('sol', '55'.repeat(32), 9);
const DECISION_AT_MS = 3_000n;
const OBJECTIVES = [
  'MAXIMIZE_NET_OUTCOME',
  'MINIMIZE_REQUIRED_COLLATERAL',
  'MINIMIZE_STRESS_LOSS',
  'MINIMIZE_TIME_TO_UNWIND',
  'MINIMIZE_TOTAL_COST',
] as const;

const price = (quoteAtoms: bigint, baseAtoms: bigint) => ({
  baseAsset: SOL,
  quoteAsset: USD,
  quoteAtoms,
  baseAtoms,
  roundingDirection: 'FLOOR' as const,
});

function position(snapshotId: string, overrides: Partial<NormalizedPositionInput> = {}): NormalizedPositionInput {
  return {
    adapterVersion: 1,
    snapshotId,
    domain: DOMAIN,
    observedAtMs: 2_000n,
    owner: 'strategy-a',
    venueId: 'orca',
    marketId: 'sol-usdc',
    underlyingId: 'sol',
    positionType: 'SPOT',
    quantityBaseAtoms: 1_000_000_000n,
    markPrice: price(1n, 10n),
    collateralQuoteAtoms: 0n,
    maintenanceRequirementQuoteAtoms: 0n,
    dependencyIds: ['domain:solana', 'venue:orca'],
    riskDomainId: 'sol-carry',
    closeRoutes: [{
      routeId: `${snapshotId}-close`,
      executableQuantityAtoms: 1_000_000_000n,
      expectedCostQuoteAtoms: 1_000_000n,
      settlementDelayMs: 500n,
      authorityHeld: true,
      atomicGroupId: 'sol-atomic',
      requiredDependencyIds: [],
    }],
    ...overrides,
  };
}

function positionSnapshot(overrides: Partial<PositionSnapshotRecordInput> = {}): PositionSnapshotRecordInput {
  return {
    recordVersion: 1,
    environment: 'testnet',
    strategyAccount: 'strategy-a',
    sourceId: 'position-source',
    observedAtMs: 2_000n,
    positions: [
      position('spot'),
      position('perp', {
        venueId: 'rise',
        marketId: 'sol-perp',
        positionType: 'PERPETUAL',
        quantityBaseAtoms: -1_000_000_000n,
        liquidationPrice: price(3n, 20n),
        maintenanceRequirementQuoteAtoms: 10_000_000n,
        dependencyIds: ['domain:solana', 'oracle:sol', 'venue:rise'],
      }),
    ],
    unmappedInstruments: [],
    sourceEvidenceHash: '61'.repeat(32),
    authority: 'risk-oracle',
    signature: new Uint8Array(64).fill(7),
    ...overrides,
  };
}

function collateral(overrides: Partial<CollateralSnapshotInput> = {}): CollateralSnapshotInput {
  return {
    version: 1,
    snapshotId: 'collateral-a',
    sourceId: 'collateral-source',
    strategyAccount: 'strategy-a',
    owner: 'owner-a',
    authority: 'risk-oracle',
    observedAtMs: 2_200n,
    asset: USD,
    riskDomainId: 'sol-carry',
    mode: 'ISOLATED',
    ownAvailableQuoteAtoms: 10_000_000n,
    borrowAvailableQuoteAtoms: 5_000_000n,
    requestedBorrowQuoteAtoms: 0n,
    borrowCostQuoteAtoms: 0n,
    haircutBps: 1_000n,
    withdrawalDelayMs: 500n,
    inventoryEligible: true,
    withdrawalAllowed: true,
    sourceEvidenceHash: '62'.repeat(32),
    signature: new Uint8Array(64).fill(8),
    ...overrides,
  };
}

function policy(overrides: Partial<PortfolioOptimizationPolicyInput> = {}): PortfolioOptimizationPolicyInput {
  return {
    version: 1,
    policyId: 'portfolio-policy',
    policyVersion: 1,
    environment: 'testnet',
    owner: 'owner-a',
    accountingAsset: USD,
    allowedSnapshotAuthorities: ['risk-oracle'],
    allowedCollateralAssetIds: ['usdc'],
    allowedCollateralModes: ['ISOLATED'],
    allowedRiskDomainIds: ['sol-carry'],
    objectivePriority: OBJECTIVES,
    maximumStateAgeMs: 5_000n,
    maximumSourceSkewMs: 1_000n,
    maximumWithdrawalDelayMs: 1_000n,
    maximumTimeToUnwindMs: 1_000n,
    maximumStressLossQuoteAtoms: 20_000_000n,
    maximumRequiredCollateralQuoteAtoms: 20_000_000n,
    maximumTotalCostQuoteAtoms: 2_000_000n,
    maximumBorrowQuoteAtoms: 5_000_000n,
    maximumBorrowCostQuoteAtoms: 500_000n,
    maximumSolverConcentrationBps: 5_000n,
    minimumRecoveryReserveQuoteAtoms: 2_000_000n,
    allowBorrow: false,
    ...overrides,
  };
}

const marginPolicy: MarginOffsetPolicy = {
  riskDomainId: 'sol-carry',
  offsetRateBps: 5_000n,
  haircutsBps: { basis: 0n, liquidity: 0n, latency: 0n, oracle: 0n, venue: 0n, bridge: 0n, issuer: 0n, recovery: 0n },
  maximumStalenessMs: 5_000n,
  maximumTimeToUnwindMs: 1_000n,
  riskDomainGrossCapQuoteAtoms: 500_000_000n,
  requiredRecoveryReserveQuoteAtoms: 2_000_000n,
  absoluteFloorQuoteAtoms: 5_000_000n,
};

const marginContext: MarginOffsetContext = {
  nowMs: DECISION_AT_MS,
  reservedRecoveryQuoteAtoms: 2_000_000n,
  fundedCreditAvailable: true,
  failedDependencyIds: [],
};

function candidate(
  candidateId: string,
  expectedGrossOutcomeQuoteAtoms: bigint,
  overrides: Partial<PortfolioOptimizationCandidateInput> = {},
): PortfolioOptimizationCandidateInput {
  const fill = candidateId === 'candidate-a' ? 'aa' : 'bb';
  return {
    candidateId,
    active: true,
    authorityVerified: true,
    positionSnapshot: positionSnapshot(),
    collateralSnapshot: collateral({ snapshotId: `${candidateId}-collateral` }),
    routeHash: fill.repeat(32),
    executionGraphHash: 'cc'.repeat(32),
    unwindRouteHash: 'dd'.repeat(32),
    solverId: 'solver-a',
    solverConcentrationBps: 2_000n,
    expectedGrossOutcomeQuoteAtoms,
    expectedFeesQuoteAtoms: 500_000n,
    expectedGasQuoteAtoms: 100_000n,
    expectedFundingCostQuoteAtoms: 100_000n,
    expectedRebatesQuoteAtoms: 0n,
    marginOffsetPolicy: marginPolicy,
    marginOffsetContext: marginContext,
    stressScenarios: [{
      scenarioId: 'sol-up-10',
      priceShocksBps: [{ underlyingId: 'sol', shockBps: 1_000n }],
      closeCostMultiplierBps: 10_000n,
      failedDependencyIds: [],
    }],
    ...overrides,
  };
}

describe('portfolio optimization inputs', () => {
  test('policy set order and collateral signatures do not change signed payload hashes', () => {
    const firstPolicy = policy({
      allowedSnapshotAuthorities: ['risk-oracle', 'backup-oracle'],
      allowedCollateralAssetIds: ['usdc', 'usdt'],
      allowedCollateralModes: ['PORTFOLIO_MARGIN', 'ISOLATED'],
      allowedRiskDomainIds: ['sol-carry', 'btc-carry'],
    });
    const secondPolicy = policy({
      allowedSnapshotAuthorities: ['backup-oracle', 'risk-oracle'],
      allowedCollateralAssetIds: ['usdt', 'usdc'],
      allowedCollateralModes: ['ISOLATED', 'PORTFOLIO_MARGIN'],
      allowedRiskDomainIds: ['btc-carry', 'sol-carry'],
    });
    assert.equal(toHex(portfolioOptimizationPolicyHash(firstPolicy)), toHex(portfolioOptimizationPolicyHash(secondPolicy)));
    assert.equal(
      toHex(collateralSnapshotHash(collateral())),
      toHex(collateralSnapshotHash(collateral({ signature: new Uint8Array(64).fill(9) }))),
    );
    assert.notEqual(
      toHex(collateralSnapshotHash(collateral())),
      toHex(collateralSnapshotHash(collateral({ sourceEvidenceHash: '63'.repeat(32) }))),
    );
  });

  test('duplicate objectives and candidate ids fail closed', () => {
    assert.throws(() => portfolioOptimizationPolicyHash(policy({
      objectivePriority: [
        'MAXIMIZE_NET_OUTCOME',
        'MINIMIZE_REQUIRED_COLLATERAL',
        'MINIMIZE_STRESS_LOSS',
        'MINIMIZE_TIME_TO_UNWIND',
        'MAXIMIZE_NET_OUTCOME',
      ],
    })), DuplicateElementError);
    const repeated = candidate('candidate-a', 2_000_000n);
    assert.throws(() => optimizePortfolio(policy(), DECISION_AT_MS, [repeated, repeated]), DuplicateElementError);
    assert.throws(() => optimizePortfolio(policy(), DECISION_AT_MS, [candidate('candidate-a', 2_000_000n, {
      marginOffsetContext: { ...marginContext, nowMs: DECISION_AT_MS + 1n },
    })]), MalformedInputError);
  });
});

describe('deterministic portfolio optimization', () => {
  test('selects the strongest eligible package independent of candidate input order', () => {
    const weaker = candidate('candidate-a', 2_000_000n);
    const stronger = candidate('candidate-b', 3_000_000n);
    const first = optimizePortfolio(policy(), DECISION_AT_MS, [weaker, stronger]);
    const second = optimizePortfolio(policy(), DECISION_AT_MS, [stronger, weaker]);
    assert.equal(first.advisory, true);
    assert.equal(first.selectedCandidateId, 'candidate-b');
    assert.deepEqual(first.candidates.map((value) => value.candidateId), ['candidate-a', 'candidate-b']);
    assert.deepEqual(first.candidates.map((value) => value.eligible), [true, true]);
    assert.equal(first.candidates[0]?.metrics.requiredCollateralQuoteAtoms, 5_700_000n);
    assert.equal(first.candidates[0]?.metrics.effectiveCollateralQuoteAtoms, 9_000_000n);
    assert.equal(toHex(first.decisionHash), toHex(second.decisionHash));

    const tiedB = candidate('candidate-b', 2_000_000n, { routeHash: 'aa'.repeat(32) });
    const tiedFirst = optimizePortfolio(policy(), DECISION_AT_MS, [tiedB, weaker]);
    const tiedSecond = optimizePortfolio(policy(), DECISION_AT_MS, [weaker, tiedB]);
    assert.equal(tiedFirst.selectedCandidateId, 'candidate-a');
    assert.equal(toHex(tiedFirst.decisionHash), toHex(tiedSecond.decisionHash));
  });

  test('rejects stale, unauthorized, undercollateralized, borrowed, and cross-domain candidates', () => {
    const stalePositions = [
      position('spot', { observedAtMs: 0n }),
      position('perp', {
        observedAtMs: 0n,
        venueId: 'rise',
        marketId: 'sol-perp',
        positionType: 'PERPETUAL',
        quantityBaseAtoms: -1_000_000_000n,
        liquidationPrice: price(3n, 20n),
        maintenanceRequirementQuoteAtoms: 10_000_000n,
        dependencyIds: ['domain:solana', 'oracle:sol', 'venue:rise'],
        riskDomainId: 'other-risk-domain',
      }),
    ];
    const unsafe = candidate('candidate-a', 2_000_000n, {
      authorityVerified: false,
      positionSnapshot: positionSnapshot({ observedAtMs: 0n, positions: stalePositions }),
      collateralSnapshot: collateral({
        observedAtMs: 0n,
        ownAvailableQuoteAtoms: 1n,
        borrowAvailableQuoteAtoms: 1n,
        requestedBorrowQuoteAtoms: 1n,
      }),
    });
    const result = optimizePortfolio(policy(), 6_000n, [{
      ...unsafe,
      marginOffsetContext: { ...marginContext, nowMs: 6_000n },
    }]);
    assert.equal(result.selectedCandidateId, undefined);
    assert.equal(result.candidates[0]?.eligible, false);
    assert.deepEqual(result.candidates[0]?.rejections, [
      'STALE_STATE',
      'AUTHORITY_UNVERIFIED',
      'RISK_DOMAIN_MISMATCH',
      'BORROW_UNAVAILABLE',
      'INSUFFICIENT_COLLATERAL',
      'POSITION_STATE_INCOMPLETE',
    ]);
  });
});
