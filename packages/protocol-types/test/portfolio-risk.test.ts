import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  assetRef,
  buildExposureGraph,
  estimateCloseCost,
  evaluateMarginOffset,
  normalizedPosition,
  packageCloseCostIndex,
  planCoordinatedDeRisk,
  positionNotional,
  stressPortfolio,
  type MarginOffsetContext,
  type MarginOffsetPolicy,
  type NormalizedPositionInput,
} from '../src/index.js';
import { DOMAIN, USD } from './solver-fixtures.js';

const SOL = assetRef('sol', '55'.repeat(32), 9);
const price = (quoteAtoms: bigint, baseAtoms: bigint) =>
  ({ baseAsset: SOL, quoteAsset: USD, quoteAtoms, baseAtoms, roundingDirection: 'FLOOR' }) as const;
const TEN_SOL = 10_000_000_000n;

function position(snapshotId: string, overrides: Partial<NormalizedPositionInput> = {}): NormalizedPositionInput {
  return {
    adapterVersion: 1,
    snapshotId,
    domain: DOMAIN,
    observedAtMs: 1_000n,
    owner: 'owner-a',
    venueId: 'orca',
    marketId: 'sol-usdc',
    underlyingId: 'sol',
    positionType: 'SPOT',
    quantityBaseAtoms: TEN_SOL,
    markPrice: price(3n, 20n),
    collateralQuoteAtoms: 0n,
    maintenanceRequirementQuoteAtoms: 0n,
    dependencyIds: ['domain:solana', 'venue:orca'],
    riskDomainId: 'sol-carry',
    closeRoutes: [
      { routeId: 'orca-close', executableQuantityAtoms: TEN_SOL, expectedCostQuoteAtoms: 1_000_000n, settlementDelayMs: 400n, authorityHeld: true, atomicGroupId: 'sol-atomic', requiredDependencyIds: ['venue:orca'] },
    ],
    ...overrides,
  };
}

const spot = position('spot');
const perp = position('perp', {
  venueId: 'rise',
  marketId: 'sol-perp',
  positionType: 'PERPETUAL',
  quantityBaseAtoms: -TEN_SOL,
  liquidationPrice: price(9n, 50n),
  maintenanceRequirementQuoteAtoms: 75_000_000n,
  dependencyIds: ['domain:solana', 'oracle:sol', 'venue:rise'],
  closeRoutes: [
    { routeId: 'rise-close', executableQuantityAtoms: TEN_SOL, expectedCostQuoteAtoms: 2_000_000n, settlementDelayMs: 400n, authorityHeld: true, atomicGroupId: 'sol-atomic', requiredDependencyIds: ['oracle:sol', 'venue:rise'] },
  ],
});

describe('normalized positions', () => {
  test('unknown venue fields are reported, never invented', () => {
    const { maintenanceRequirementQuoteAtoms: _omit, ...unknown } = spot;
    assert.deepEqual(normalizedPosition(unknown).unknownFields, ['maintenanceRequirementQuoteAtoms']);
    const { liquidationPrice: _gone, ...noBoundary } = perp;
    assert.deepEqual(normalizedPosition(noBoundary).unknownFields, ['liquidationPrice']);
    assert.throws(() => normalizedPosition(position('flat', { quantityBaseAtoms: 0n })), /not a position/);
    const route = spot.closeRoutes[0] as never;
    assert.throws(() => normalizedPosition(position('dup', { closeRoutes: [route, route] })), /route ids repeat/);
    const eth = assetRef('eth', '66'.repeat(32), 18);
    assert.throws(() => normalizedPosition({ ...perp, liquidationPrice: { ...price(9n, 50n), baseAsset: eth } }), /different assets/);
  });

  test('mark notional rounds away from zero', () => {
    assert.equal(positionNotional(normalizedPosition(spot)), 1_500_000_000n);
    assert.equal(positionNotional(normalizedPosition(position('dust', { quantityBaseAtoms: 1n }))), 1n);
    assert.equal(positionNotional(normalizedPosition(position('dust', { quantityBaseAtoms: -1n }))), -1n);
  });
});

describe('exposure graph', () => {
  test('aggregates common delta and shared dependency concentration', () => {
    const graph = buildExposureGraph([spot, perp], USD);
    assert.deepEqual(graph.byUnderlying.map((line) => [line.key, line.netNotional, line.grossNotional]), [['sol', 0n, 3_000_000_000n]]);
    assert.deepEqual(
      graph.byDependency.map((line) => [line.key, line.grossNotional, line.positionCount]),
      [
        ['domain:solana', 3_000_000_000n, 2],
        ['oracle:sol', 1_500_000_000n, 1],
        ['venue:orca', 1_500_000_000n, 1],
        ['venue:rise', 1_500_000_000n, 1],
      ],
    );
    assert.throws(() => buildExposureGraph([spot], assetRef('usdt', '77'.repeat(32), 6)), /accounting asset/);
    assert.throws(() => buildExposureGraph([spot, spot], USD), /snapshot ids repeat/);
  });
});

describe('close cost and stress', () => {
  const twoRoutes = position('two', {
    closeRoutes: [
      { routeId: 'expensive', executableQuantityAtoms: TEN_SOL, expectedCostQuoteAtoms: 3_000_000n, settlementDelayMs: 900n, authorityHeld: true, requiredDependencyIds: [] },
      { routeId: 'cheap', executableQuantityAtoms: 3_000_000_000n, expectedCostQuoteAtoms: 300_000n, settlementDelayMs: 100n, authorityHeld: true, requiredDependencyIds: ['venue:orca'] },
      { routeId: 'no-authority', executableQuantityAtoms: TEN_SOL, expectedCostQuoteAtoms: 1n, settlementDelayMs: 1n, authorityHeld: false, requiredDependencyIds: [] },
    ],
  });

  test('cheapest usable routes fill first and partial use rounds cost up', () => {
    const estimate = estimateCloseCost(twoRoutes);
    assert.deepEqual([estimate.costQuoteAtoms, estimate.timeToUnwindMs, estimate.complete], [300_000n + 2_100_000n, 900n, true]);
    const failed = estimateCloseCost(twoRoutes, ['venue:orca']);
    assert.equal(failed.costQuoteAtoms, 3_000_000n);
    const blocked = estimateCloseCost(perp, ['oracle:sol']);
    assert.deepEqual([blocked.complete, blocked.closableQuantityAtoms], [false, 0n]);
    assert.equal(estimateCloseCost(spot, [], 15_000n).costQuoteAtoms, 1_500_000n);
    assert.throws(() => estimateCloseCost(spot, [], 9_999n), /cheaper/);
    const index = packageCloseCostIndex([spot, perp]);
    assert.deepEqual([index.costQuoteAtoms, index.complete], [3_000_000n, true]);
  });

  test('a joint shock nets across the hedge and reports what cannot close', () => {
    const scenario = { scenarioId: 'sol-down-10', priceShocksBps: [{ underlyingId: 'sol', shockBps: -1_000n }], closeCostMultiplierBps: 20_000n, failedDependencyIds: ['oracle:sol'] };
    const result = stressPortfolio([spot, perp], scenario, USD);
    assert.equal(result.markPnlQuoteAtoms, 0n);
    assert.equal(result.stressedCloseCostQuoteAtoms, 2_000_000n);
    assert.deepEqual(result.unclosableSnapshotIds, ['perp']);
    assert.equal(result.lossQuoteAtoms, 2_000_000n);
    const unhedged = stressPortfolio([spot], { ...scenario, failedDependencyIds: [] }, USD);
    assert.equal(unhedged.markPnlQuoteAtoms, -150_000_000n);
    assert.equal(unhedged.lossQuoteAtoms, 152_000_000n);
    assert.throws(() => stressPortfolio([spot], { ...scenario, priceShocksBps: [{ underlyingId: 'sol', shockBps: -10_000n }] }, USD), /to or below zero/);
  });
});

describe('conditional margin offsets', () => {
  const policy: MarginOffsetPolicy = {
    riskDomainId: 'sol-carry',
    offsetRateBps: 500n,
    haircutsBps: { basis: 500n, liquidity: 500n, latency: 250n, oracle: 250n, venue: 250n, bridge: 0n, issuer: 0n, recovery: 250n },
    maximumStalenessMs: 5_000n,
    maximumTimeToUnwindMs: 1_000n,
    riskDomainGrossCapQuoteAtoms: 5_000_000_000n,
    requiredRecoveryReserveQuoteAtoms: 10_000_000n,
    absoluteFloorQuoteAtoms: 20_000_000n,
  };
  const context: MarginOffsetContext = { nowMs: 2_000n, reservedRecoveryQuoteAtoms: 10_000_000n, fundedCreditAvailable: false, failedDependencyIds: [] };

  test('a fully controlled hedge earns a haircut offset that stays advisory without funded credit', () => {
    const decision = evaluateMarginOffset([spot, perp], policy, context, USD);
    assert.deepEqual(
      [decision.grossRequirementQuoteAtoms, decision.rawBenefitQuoteAtoms, decision.permittedOffsetQuoteAtoms, decision.resultingRequirementQuoteAtoms, decision.advisory],
      [85_000_000n, 75_000_000n, 60_000_000n, 25_000_000n, true],
    );
    assert.deepEqual(decision.failedConditions, []);
    const noHaircut = { ...policy, haircutsBps: { basis: 0n, liquidity: 0n, latency: 0n, oracle: 0n, venue: 0n, bridge: 0n, issuer: 0n, recovery: 0n } };
    assert.equal(evaluateMarginOffset([spot, perp], noHaircut, { ...context, fundedCreditAvailable: true }, USD).resultingRequirementQuoteAtoms, 20_000_000n);
  });

  test('every failed condition removes the whole offset', () => {
    const failed = (legs: NormalizedPositionInput[], overrides: Partial<MarginOffsetContext> = {}, rules: Partial<MarginOffsetPolicy> = {}) => {
      const decision = evaluateMarginOffset(legs, { ...policy, ...rules }, { ...context, ...overrides }, USD);
      assert.equal(decision.permittedOffsetQuoteAtoms, 0n);
      assert.equal(decision.resultingRequirementQuoteAtoms, decision.grossRequirementQuoteAtoms);
      return decision.failedConditions;
    };
    assert.ok(failed([spot, perp], { nowMs: 7_000n }).includes('STALE_OR_UNKNOWN_STATE'));
    const { maintenanceRequirementQuoteAtoms: _omit, ...unknownSpot } = spot;
    assert.ok(failed([unknownSpot, perp]).includes('STALE_OR_UNKNOWN_STATE'));
    const route = perp.closeRoutes[0] as NonNullable<(typeof perp.closeRoutes)[0]>;
    assert.ok(failed([spot, { ...perp, closeRoutes: [{ ...route, authorityHeld: false }] }]).includes('MISSING_CLOSE_AUTHORITY'));
    assert.deepEqual(failed([spot, { ...perp, closeRoutes: [{ ...route, atomicGroupId: 'other' }] }]), ['NO_SHARED_UNWIND']);
    assert.ok(failed([spot, perp], { failedDependencyIds: ['oracle:sol'] }).includes('FAILED_DEPENDENCY'));
    assert.deepEqual(failed([spot, perp], { reservedRecoveryQuoteAtoms: 9_999_999n }), ['RECOVERY_CAPITAL_NOT_RESERVED']);
    assert.deepEqual(failed([spot, { ...perp, riskDomainId: 'other' }]), ['OUTSIDE_RISK_DOMAIN']);
    assert.deepEqual(failed([spot, perp], {}, { riskDomainGrossCapQuoteAtoms: 2_999_999_999n }), ['RISK_DOMAIN_CAP']);
    assert.deepEqual(failed([spot, perp], {}, { maximumTimeToUnwindMs: 399n }), ['INSUFFICIENT_EXECUTABLE_LIQUIDITY']);
  });
});

describe('coordinated de-risking', () => {
  const policy = { triggerLiquidationDistanceBps: 2_500n, reductionBps: 2_500n };

  test('reduces the leg nearest liquidation with its hedge inside one rollback boundary', () => {
    const plan = planCoordinatedDeRisk([spot, perp], policy, true, ['order-2', 'order-1']);
    assert.deepEqual(plan, [
      { kind: 'CANCEL_RISK_INCREASING_ORDER', orderId: 'order-1' },
      { kind: 'CANCEL_RISK_INCREASING_ORDER', orderId: 'order-2' },
      {
        kind: 'REDUCE_LEGS',
        mode: 'ATOMIC_PAIRED',
        reductions: [
          { snapshotId: 'perp', reduceBaseAtoms: 2_500_000_000n },
          { snapshotId: 'spot', reduceBaseAtoms: 2_500_000_000n },
        ],
      },
      { kind: 'ENTER_REDUCE_ONLY' },
    ]);
    const route = perp.closeRoutes[0] as NonNullable<(typeof perp.closeRoutes)[0]>;
    const split = planCoordinatedDeRisk([spot, { ...perp, closeRoutes: [{ ...route, atomicGroupId: 'rise-only' }] }], policy, true, []);
    assert.equal((split[0] as { mode: string }).mode, 'BOUNDED_PAIRED_UNWIND');
  });

  test('healthy packages only cancel and uncertain state locks for manual recovery', () => {
    assert.deepEqual(planCoordinatedDeRisk([spot, perp], { ...policy, triggerLiquidationDistanceBps: 2_000n }, true, []), []);
    assert.deepEqual(planCoordinatedDeRisk([spot, perp], policy, false, []), [{ kind: 'LOCK_FOR_MANUAL_RECOVERY', reason: 'position state is uncertain' }]);
    const { liquidationPrice: _gone, ...noBoundary } = perp;
    assert.equal(planCoordinatedDeRisk([spot, noBoundary], policy, true, [])[0]?.kind, 'LOCK_FOR_MANUAL_RECOVERY');
    const full = planCoordinatedDeRisk([spot, perp], { ...policy, reductionBps: 10_000n }, true, []);
    assert.deepEqual(
      (full[0] as unknown as { reductions: { reduceBaseAtoms: bigint }[] }).reductions.map((item) => item.reduceBaseAtoms),
      [TEN_SOL, TEN_SOL],
    );
    assert.throws(() => planCoordinatedDeRisk([spot, perp], { ...policy, reductionBps: 0n }, true, []), MalformedInputError);
  });
});
