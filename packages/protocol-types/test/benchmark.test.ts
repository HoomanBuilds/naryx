import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  allocateMinimumTopUp,
  assetAmount,
  assetRef,
  benchmarkArmRecordHash,
  benchmarkManifestHash,
  benchmarkNotionalDenominator,
  benchmarkPairRecordHash,
  compareBenchmarkArms,
  costLedgerTotals,
  customerServiceRevenue,
  domainRef,
  feePromotionCohortKey,
  minimumTopUp,
  toHex,
  verifyBenchmarkPair,
  versionedManifestRef,
  type BenchmarkArmRecordInput,
  type BenchmarkManifestInput,
  type BenchmarkPairEvidence,
  type BenchmarkPairRecordInput,
  type CostLedgerEntryInput,
  type CostLedgerInput,
} from '../src/index.js';

const golden = JSON.parse(readFileSync(new URL('../../fixtures/benchmark-records.json', import.meta.url), 'utf8')) as Record<string, string>;

const sol = assetRef('sol', '11'.repeat(32), 9);
const usdc = assetRef('usdc', '22'.repeat(32), 6);
const domain = domainRef('svm:testnet', 1, '33'.repeat(32));
const cohort = { domain, direction: 'LONG_SPOT_SHORT_PERP' as const, quantityPolicyClass: 'EXACT_ATOMIC' as const, settlementClass: 'ATOMIC_POSTCONDITION' as const, accountModeClass: 'cross-margin-v1' };

function manifest(overrides: Partial<BenchmarkManifestInput> = {}): BenchmarkManifestInput {
  return {
    version: 1,
    environment: 'testnet',
    pairId: 'pair-0001',
    feePromotionCohortKey: feePromotionCohortKey(cohort),
    ...cohort,
    // 2 SOL at 150 USDC each: 300 USDC of benchmark notional.
    requestedBaseQuantity: assetAmount(sol, 2_000_000_000n),
    referencePrice: { baseAsset: sol, quoteAsset: usdc, quoteAtoms: 3n, baseAtoms: 20n, roundingDirection: 'FLOOR' },
    priceSource: versionedManifestRef('pyth-sol-usd', 1, '44'.repeat(32)),
    sourceMarket: versionedManifestRef('phoenix-sol-usdc', 1, '45'.repeat(32)),
    quoteCurrency: usdc,
    contractMultiplier: 1n,
    priceDecimals: 6,
    priceConvention: 'DIRECTION_EXECUTABLE_SIDE',
    observedAtUnit: 'SOLANA_SLOT',
    observedAtValue: 1_000n,
    maxStaleness: 25n,
    fallbackRule: 'next-fresh-slot-or-unresolved',
    evidenceRef: '46'.repeat(32),
    valuationHorizonRule: 'terminal-plus-60s',
    costLedgerMode: 'NET_STATE_DELTA_LEDGER',
    estimatorVersion: 1,
    eligibilityPolicyHash: '47'.repeat(32),
    outcomeTreatmentPolicyHash: '48'.repeat(32),
    baselineSelectionPolicyHash: '49'.repeat(32),
    baselineChallengerSetHash: '4a'.repeat(32),
    baselineExecutionPolicyHash: '4b'.repeat(32),
    frozenAtUnit: 'SOLANA_SLOT',
    frozenAtValue: 1_010n,
    freezeCommitRef: '4c'.repeat(32),
    ...overrides,
  };
}

function arm(role: 'PACKAGE' | 'SEQUENTIAL', overrides: Partial<BenchmarkArmRecordInput> = {}): BenchmarkArmRecordInput {
  return {
    armRecordVersion: 1,
    environment: 'testnet',
    domain,
    pairId: 'pair-0001',
    benchmarkManifestHash: benchmarkManifestHash(manifest()),
    arm: role,
    outcomeOrExportHash: role === 'PACKAGE' ? '51'.repeat(32) : '52'.repeat(32),
    ...overrides,
  };
}

function pair(overrides: Partial<BenchmarkPairRecordInput> = {}): BenchmarkPairRecordInput {
  return {
    pairRecordVersion: 1,
    environment: 'testnet',
    domain,
    pairId: 'pair-0001',
    benchmarkManifestHash: benchmarkManifestHash(manifest()),
    frozenAtUnit: 'SOLANA_SLOT',
    frozenAtValue: 1_010n,
    freezeCommitRef: '4c'.repeat(32),
    packageArmRecordHash: benchmarkArmRecordHash(arm('PACKAGE')),
    sequentialArmRecordHash: benchmarkArmRecordHash(arm('SEQUENTIAL')),
    ...overrides,
  };
}

type EvidenceChange = { [K in keyof BenchmarkPairEvidence]?: BenchmarkPairEvidence[K] | undefined };

function evidence(overrides: EvidenceChange = {}): BenchmarkPairEvidence {
  const built: Record<string, unknown> = {
    manifest: manifest(),
    pair: pair(),
    packageArm: arm('PACKAGE'),
    sequentialArm: arm('SEQUENTIAL'),
    freezePublishedAtValue: 1_011n,
    firstOutcomeAtValue: 1_050n,
    evaluation: { estimatorVersion: 1, eligibilityPolicyHash: '47'.repeat(32), outcomeTreatmentPolicyHash: '48'.repeat(32) },
    freshFallbackObserved: false,
    ...overrides,
  };
  for (const key of Object.keys(built)) if (built[key] === undefined) delete built[key];
  return built as unknown as BenchmarkPairEvidence;
}

const entry = (componentId: string, kind: CostLedgerEntryInput['kind'], quoteValueAtoms: bigint, overrides: Partial<CostLedgerEntryInput> = {}): CostLedgerEntryInput => ({
  componentId,
  kind,
  amount: assetAmount(usdc, quoteValueAtoms),
  quoteValueAtoms,
  embedding: 'SEPARATE',
  serviceCharge: false,
  ...overrides,
});

const ledger = (entries: CostLedgerEntryInput[], mode: CostLedgerInput['mode'] = 'NET_STATE_DELTA_LEDGER'): CostLedgerInput => ({ ledgerVersion: 1, mode, quoteAsset: usdc, entries });

describe('benchmark records', () => {
  test('the three benchmark hashes and the cohort key match their golden vectors', () => {
    assert.equal(toHex(feePromotionCohortKey(cohort)), golden.feePromotionCohortKey);
    assert.equal(toHex(benchmarkManifestHash(manifest())), golden.benchmarkManifestHash);
    assert.equal(toHex(benchmarkArmRecordHash(arm('PACKAGE'))), golden.packageArmRecordHash);
    assert.equal(toHex(benchmarkArmRecordHash(arm('SEQUENTIAL'))), golden.sequentialArmRecordHash);
    assert.equal(toHex(benchmarkPairRecordHash(pair())), golden.benchmarkPairRecordHash);
  });

  test('every frozen manifest field is bound, and the cohort key must match its fields', () => {
    const base = toHex(benchmarkManifestHash(manifest()));
    for (const changed of [
      { maxStaleness: 26n },
      { priceConvention: 'MIDPOINT' as const },
      { costLedgerMode: 'GROSS_CASHFLOW_LEDGER' as const },
      { baselineChallengerSetHash: '5a'.repeat(32) },
      { buyerWorkflowEvidenceRef: '5b'.repeat(32) },
      { customerMonthId: 'org-a-2026-09', minimumAllocationRuleVersion: 1, minimumAllocationWeightBasis: 'EQUAL_ATTEMPT' as const },
    ]) {
      assert.notEqual(toHex(benchmarkManifestHash(manifest(changed))), base);
    }
    assert.throws(() => benchmarkManifestHash(manifest({ accountModeClass: 'isolated-margin-v1' })), /cohort key does not match/);
    assert.throws(() => benchmarkManifestHash(manifest({ customerMonthId: 'org-a-2026-09' })), /allocation rule version and weight basis/);
    assert.throws(() => benchmarkManifestHash(manifest({ observedAtValue: 1_011n })), /observed after the freeze/);
    assert.throws(() => benchmarkManifestHash(manifest({ requestedBaseQuantity: assetAmount(sol, 0n) })), /cannot be zero/);
    assert.throws(() => benchmarkManifestHash(manifest({ quoteCurrency: sol })), /quote currency/);
  });

  test('the denominator is abs(quantity) times price times multiplier in quote atoms', () => {
    assert.equal(benchmarkNotionalDenominator(manifest()).atoms, 300_000_000n);
    assert.equal(benchmarkNotionalDenominator(manifest({ requestedBaseQuantity: assetAmount(sol, -2_000_000_000n) })).atoms, 300_000_000n);
    assert.equal(benchmarkNotionalDenominator(manifest({ contractMultiplier: 10n })).atoms, 3_000_000_000n);
  });
});

describe('benchmark pair eligibility', () => {
  test('a pair frozen before outcomes, with both arms bound, is eligible', () => {
    assert.deepEqual(verifyBenchmarkPair(evidence()), { status: 'ELIGIBLE' });
  });

  test('every broken binding makes the pair ineligible for fee promotion', () => {
    const cases: [EvidenceChange, string][] = [
      [{ packageArm: undefined }, 'ARM_MISSING'],
      [{ packageArm: arm('PACKAGE', { outcomeOrExportHash: '5c'.repeat(32) }) }, 'ARM_HASH_MISMATCH'],
      [{ packageArm: arm('SEQUENTIAL', { outcomeOrExportHash: '51'.repeat(32) }) }, 'ARM_ROLE_MISMATCH'],
      [{ sequentialArm: arm('SEQUENTIAL', { environment: 'mainnet' }) }, 'ENVIRONMENT_MISMATCH'],
      [{ sequentialArm: arm('SEQUENTIAL', { domain: domainRef('svm:testnet', 2, '33'.repeat(32)) }) }, 'DOMAIN_MISMATCH'],
      [{ pair: pair({ benchmarkManifestHash: '5d'.repeat(32) }) }, 'MANIFEST_HASH_MISMATCH'],
      [{ pair: pair({ freezeCommitRef: '5e'.repeat(32) }) }, 'FREEZE_MISMATCH'],
      [{ freezePublishedAtValue: undefined }, 'MISSING_PRE_OUTCOME_COMMITMENT'],
      [{ freezePublishedAtValue: 1_050n }, 'COMMITTED_AFTER_OUTCOME'],
      [{ evaluation: { estimatorVersion: 2, eligibilityPolicyHash: '47'.repeat(32), outcomeTreatmentPolicyHash: '48'.repeat(32) } }, 'POLICY_CHANGED'],
    ];
    for (const [change, reason] of cases) {
      const verdict = verifyBenchmarkPair(evidence(change));
      assert.equal(verdict.status, 'INELIGIBLE', reason);
      assert.ok(verdict.status === 'INELIGIBLE' && verdict.reasons.includes(reason as never), `${reason}: ${JSON.stringify(verdict)}`);
    }
  });

  test('a stale reference leaves the pair unresolved unless a permitted fresh fallback exists', () => {
    const stale = manifest({ observedAtValue: 980n });
    const bound = { benchmarkManifestHash: benchmarkManifestHash(stale) };
    const staleEvidence = evidence({
      manifest: stale,
      packageArm: arm('PACKAGE', bound),
      sequentialArm: arm('SEQUENTIAL', bound),
      pair: pair({ ...bound, packageArmRecordHash: benchmarkArmRecordHash(arm('PACKAGE', bound)), sequentialArmRecordHash: benchmarkArmRecordHash(arm('SEQUENTIAL', bound)) }),
    });
    assert.deepEqual(verifyBenchmarkPair(staleEvidence), { status: 'UNRESOLVED', reason: 'REFERENCE_STALE' });
    assert.deepEqual(verifyBenchmarkPair({ ...staleEvidence, freshFallbackObserved: true }), { status: 'ELIGIBLE' });
  });
});

describe('cost ledgers count every cost exactly once', () => {
  test('quote-token fees, base-token fees, builder partitioning, and negative rebates in a gross ledger', () => {
    const totals = costLedgerTotals(ledger([
      entry('spot-fill', 'GROSS_FILL', 150_000_000n),
      entry('perp-fill', 'GROSS_FILL', -149_000_000n),
      entry('venue-fee', 'VENUE_FEE', 30_000n),
      // A base-token fee stays in SOL with its USDC valuation beside it.
      entry('base-fee', 'VENUE_FEE', 15_000n, { amount: assetAmount(sol, 100_000n) }),
      entry('builder-fee', 'BUILDER_FEE', 10_000n, { serviceCharge: true }),
      entry('protocol-fee', 'PROTOCOL_FEE', 20_000n, { serviceCharge: true }),
      entry('maker-rebate', 'REBATE', -5_000n),
    ], 'GROSS_CASHFLOW_LEDGER'));
    assert.deepEqual(totals, { totalCostQuoteAtoms: 1_070_000n, serviceChargeQuoteAtoms: 30_000n, embeddedQuoteAtoms: 0n });
    assert.throws(() => costLedgerTotals(ledger([entry('delta', 'STATE_DELTA', 1n)], 'GROSS_CASHFLOW_LEDGER')), /does not record STATE_DELTA/);
    assert.throws(() => costLedgerTotals(ledger([entry('fill', 'GROSS_FILL', 1n), entry('fee', 'VENUE_FEE', 1n, { embedding: 'EMBEDDED_IN_STATE_DELTA' })], 'GROSS_CASHFLOW_LEDGER')), /only a cost inside a net state delta/);
  });

  test('a net ledger never adds an embedded base-token fee, gross-up, or residual a second time', () => {
    const totals = costLedgerTotals(ledger([
      entry('net-delta', 'STATE_DELTA', 1_000_000n),
      entry('embedded-base-fee', 'VENUE_FEE', 15_000n, { amount: assetAmount(sol, 100_000n), embedding: 'EMBEDDED_IN_STATE_DELTA' }),
      entry('exact-net-gross-up', 'GROSS_UP', 15_000n, { embedding: 'EMBEDDED_IN_STATE_DELTA' }),
      entry('bounded-residual', 'RESIDUAL', 2_000n, { embedding: 'EMBEDDED_IN_STATE_DELTA' }),
      entry('solver-fee', 'SOLVER_FEE', 25_000n, { serviceCharge: true }),
      entry('gas', 'GAS', 3_000n),
      entry('recovery-refund', 'RECOVERY_REFUND', -1_000n),
    ]));
    assert.deepEqual(totals, { totalCostQuoteAtoms: 1_027_000n, serviceChargeQuoteAtoms: 25_000n, embeddedQuoteAtoms: 32_000n });
  });

  test('duplicates, wrong signs, and misclassified service charges are refused', () => {
    assert.throws(() => costLedgerTotals(ledger([entry('delta', 'STATE_DELTA', 1n), entry('delta', 'GAS', 1n)])), /recorded twice/);
    assert.throws(() => costLedgerTotals(ledger([entry('delta', 'STATE_DELTA', 1n), entry('fee', 'PROTOCOL_FEE', -1n)])), /cannot be negative/);
    assert.throws(() => costLedgerTotals(ledger([entry('delta', 'STATE_DELTA', 1n), entry('rebate', 'REBATE', 1n)])), /cannot be positive/);
    assert.throws(() => costLedgerTotals(ledger([entry('delta', 'STATE_DELTA', 1n), entry('gas', 'GAS', 1n, { serviceCharge: true })])), /not a service charge/);
    assert.throws(() => costLedgerTotals(ledger([entry('gas', 'GAS', 1n)])), /starts from at least one STATE_DELTA/);
  });

  test('both arms compare in the frozen mode and currency, net and gross of the service charge', () => {
    const packageLedger = ledger([entry('delta', 'STATE_DELTA', 1_000_000n), entry('solver-fee', 'SOLVER_FEE', 30_000n, { serviceCharge: true })]);
    const sequentialLedger = ledger([entry('delta', 'STATE_DELTA', 1_095_000n)]);
    const comparison = compareBenchmarkArms(manifest(), packageLedger, sequentialLedger);
    assert.equal(comparison.denominator.atoms, 300_000_000n);
    assert.equal(comparison.netImprovementQuoteAtoms, 65_000n);
    assert.equal(comparison.grossImprovementQuoteAtoms, 95_000n);
    assert.equal(comparison.netImprovementBps, 2n);
    assert.equal(comparison.grossImprovementBps, 3n);
    // A worse package arm rounds its claim down, never toward zero.
    assert.equal(compareBenchmarkArms(manifest(), sequentialLedger, packageLedger).netImprovementBps, -3n);
    assert.throws(() => compareBenchmarkArms(manifest(), { ...packageLedger, mode: 'GROSS_CASHFLOW_LEDGER' }, sequentialLedger), /differs from the frozen mode/);
    assert.throws(() => compareBenchmarkArms(manifest(), { ...packageLedger, quoteAsset: sol }, sequentialLedger), /another quote currency/);
  });
});

describe('monthly minimum', () => {
  test('the top-up is what the minimum still charges after execution revenue and builder credit', () => {
    assert.equal(minimumTopUp({ monthlyMinimumQuoteAtoms: 1_000n, executionRevenueQuoteAtoms: 300n, builderCreditQuoteAtoms: 200n }), 500n);
    assert.equal(minimumTopUp({ monthlyMinimumQuoteAtoms: 1_000n, executionRevenueQuoteAtoms: 900n, builderCreditQuoteAtoms: 200n }), 0n);
    assert.equal(customerServiceRevenue({ executionRevenueQuoteAtoms: 300n, builderRevenueQuoteAtoms: 250n, minimumTopUpQuoteAtoms: 500n }), 1_050n);
  });

  test('the top-up is allocated exactly and deterministically across every eligible attempt', () => {
    const attempts = [
      { attemptId: 'attempt-c', requestedNotionalQuoteAtoms: 1n },
      { attemptId: 'attempt-a', requestedNotionalQuoteAtoms: 1n },
      { attemptId: 'attempt-b', requestedNotionalQuoteAtoms: 1n },
    ];
    // 100 over three equal weights: the extra atom goes to the lowest id.
    assert.deepEqual(allocateMinimumTopUp(100n, attempts, 'EQUAL_ATTEMPT').map((share) => [share.attemptId, share.quoteAtoms]), [
      ['attempt-c', 33n],
      ['attempt-a', 34n],
      ['attempt-b', 33n],
    ]);
    const byNotional = allocateMinimumTopUp(1_000n, [
      { attemptId: 'filled', requestedNotionalQuoteAtoms: 700n },
      { attemptId: 'failed', requestedNotionalQuoteAtoms: 200n },
      { attemptId: 'unresolved', requestedNotionalQuoteAtoms: 100n },
    ], 'REQUESTED_NOTIONAL');
    assert.deepEqual(byNotional.map((share) => share.quoteAtoms), [700n, 200n, 100n]);
    assert.throws(() => allocateMinimumTopUp(1n, [], 'EQUAL_ATTEMPT'), /eligible attempts/);
    assert.throws(() => allocateMinimumTopUp(1n, [attempts[0], attempts[0]] as never, 'EQUAL_ATTEMPT'), /listed twice/);
    assert.throws(() => allocateMinimumTopUp(1n, [{ attemptId: 'zero', requestedNotionalQuoteAtoms: 0n }], 'REQUESTED_NOTIONAL'), /no allocation weight/);
  });
});
