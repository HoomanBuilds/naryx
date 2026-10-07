import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  STRATEGY_TEMPLATE_ID,
  assetAmount,
  assetRef,
  domainRef,
  strategyEconomicsMetrics,
  strategyPackageReceipt,
  requireStrategyTemplateDefinition,
  strategyTemplateDefinitions,
  type StrategyEconomicsInput,
  type StrategyPackageReceiptInput,
} from '../src/index.js';

const economics: readonly StrategyEconomicsInput[] = [
  { templateId: STRATEGY_TEMPLATE_ID.CASH_AND_CARRY, spotNotionalAtoms: 1_000n, derivativeNotionalAtoms: 1_100n, expectedFundingAtoms: 20n, borrowCostAtoms: 0n, totalFeesAtoms: 5n, capitalRequiredAtoms: 500n, holdingDurationMs: 86_400_000n, exitBasisBps: 10n },
  { templateId: STRATEGY_TEMPLATE_ID.REVERSE_CASH_AND_CARRY, spotNotionalAtoms: 1_100n, derivativeNotionalAtoms: 1_000n, expectedFundingAtoms: 20n, borrowCostAtoms: 5n, totalFeesAtoms: 5n, capitalRequiredAtoms: 500n, holdingDurationMs: 86_400_000n, exitBasisBps: 10n },
  { templateId: STRATEGY_TEMPLATE_ID.PERPETUAL_FUNDING_SPREAD, values: { longFundingPpm: 100n, shortFundingPpm: 300n, expectedHoldingDurationMs: 86_400_000n, reversalThresholdPpm: 50n, longLiquidationDistanceBps: 2_000n, shortLiquidationDistanceBps: 1_500n, totalMarginAtoms: 500n } },
  { templateId: STRATEGY_TEMPLATE_ID.HEDGE_MIGRATION, values: { sourceCloseCostAtoms: 5n, destinationOpenCostAtoms: 6n, feesAtoms: 2n, overlapDurationMs: 1_000n, maximumInterimDeltaAtoms: 10n, sourceClosePriceTicks: 100n, destinationOpenPriceTicks: 101n } },
  { templateId: STRATEGY_TEMPLATE_ID.DELTA_NEUTRAL_REBALANCE, values: { preDeltaAtoms: 20n, postDeltaAtoms: 1n, rebalanceCostAtoms: 2n, maximumSlippageAtoms: 1n, postLiquidationDistanceBps: 2_000n } },
  { templateId: STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE, values: { inventoryAtoms: 1_000n, hedgeAtoms: -800n, hedgeCostAtoms: 5n, maximumLossAtoms: 100n, liquidationDistanceBps: 2_000n } },
  { templateId: STRATEGY_TEMPLATE_ID.CALENDAR_SPREAD, values: { nearPriceTicks: 100n, farPriceTicks: 110n, nearMaturityMs: 86_400_000n, farMaturityMs: 172_800_000n, netMarginAtoms: 50n } },
  { templateId: STRATEGY_TEMPLATE_ID.OPTION_SPREAD, values: { netPremiumAtoms: 10n, deltaPpm: 100n, gammaPpm: 20n, vegaPpm: 30n, thetaPpm: -5n, maximumProfitAtoms: 100n, maximumLossAtoms: 50n, impliedVolatilityPpm: 500_000n, volatilitySpreadPpm: 20_000n } },
  { templateId: STRATEGY_TEMPLATE_ID.COLLATERAL_CONVERSION_HEDGE, values: { conversionOutputAtoms: 1_000n, hedgeNotionalAtoms: 900n, conversionCostAtoms: 4n, hedgeCostAtoms: 3n, postMarginHealthBps: 15_000n, maximumInterimDeltaAtoms: 20n } },
  { templateId: STRATEGY_TEMPLATE_ID.FIXED_RATE_REFINANCE, values: { principalAtoms: 1_000n, interestAtoms: 50n, feesAtoms: 5n, maturityMs: 31_536_000_000n, collateralRequiredAtoms: 1_500n, existingAnnualizedRatePpm: 100_000n } },
  { templateId: STRATEGY_TEMPLATE_ID.SOL_STRUCTURED_HEDGE, values: { netPremiumAtoms: 10n, protectedNotionalAtoms: 1_000n, downsideFloorTicks: 80n, upsideCapTicks: 120n, deltaPpm: 500_000n, maximumLossAtoms: 100n } },
  { templateId: STRATEGY_TEMPLATE_ID.SESSION_AWARE_TOKENIZED_ASSET, values: { sessionStateCode: 1n, referencePriceTicks: 100n, sessionRiskPremiumBps: 50n, hedgedNotionalAtoms: 1_000n, maximumGapLossAtoms: 100n, nextSessionBoundaryMs: 86_400_000n } },
];

describe('strategy template program', () => {
  test('every declared template has executable economics and lifecycle rules', () => {
    const definitions = strategyTemplateDefinitions();
    assert.equal(definitions.length, Object.keys(STRATEGY_TEMPLATE_ID).length);
    assert.equal(new Set(definitions.map((definition) => definition.templateId)).size, definitions.length);
    for (const input of economics) {
      const definition = definitions.find((candidate) => candidate.templateId === input.templateId);
      assert.ok(definition);
      assert.ok(definition.actionSpecs.length > 0);
      assert.deepEqual(
        strategyEconomicsMetrics(input).map((metric) => metric.metricId).sort(),
        [...definition.metricIds].sort(),
      );
    }
  });

  test('same-domain hedge templates admit atomic lifecycle execution', () => {
    const treasury = requireStrategyTemplateDefinition(STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE);
    const treasuryExit = treasury.actionSpecs.find((action) => action.action === 'EXIT');
    assert.ok(treasuryExit?.allowedSettlementClasses.includes('ATOMIC_POSTCONDITION'));
    assert.equal(treasuryExit?.maximumLegs, 2);
    assert.equal(treasuryExit?.legRules.find((rule) => rule.legTypeId === 'inventory-position')?.minimumCount, 0);

    const conversion = requireStrategyTemplateDefinition(STRATEGY_TEMPLATE_ID.COLLATERAL_CONVERSION_HEDGE);
    for (const action of ['ENTRY', 'INCREASE', 'DECREASE', 'EXIT', 'REBALANCE'] as const) {
      assert.ok(conversion.actionSpecs.find((spec) => spec.action === action)?.allowedSettlementClasses.includes('ATOMIC_POSTCONDITION'));
    }
  });
});

const usdc = assetRef('usdc', '11'.repeat(32), 6);
const domain = domainRef('evm:base-sepolia', 1, '22'.repeat(32));
const amount = (atoms: bigint) => assetAmount(usdc, atoms);
const receipt = (): StrategyPackageReceiptInput => ({
  version: 1,
  environment: 'testnet',
  domains: [domain],
  orderHash: '31'.repeat(32),
  graphHash: '32'.repeat(32),
  quoteHash: '33'.repeat(32),
  routeHash: '34'.repeat(32),
  templateId: STRATEGY_TEMPLATE_ID.FIXED_RATE_REFINANCE,
  templateVersion: 1,
  packageTemplateManifestHash: '35'.repeat(32),
  seriesId: 'usdc-refinance-series',
  seriesVersion: 1,
  seriesManifestHash: '36'.repeat(32),
  executionClassId: 'base-refinance-class',
  executionClassVersion: 1,
  executionClassManifestHash: '37'.repeat(32),
  lifecycleAction: 'MIGRATE',
  owner: 'owner',
  solverId: 'solver',
  settlementClass: 'ASYNC_BONDED_SOLVER',
  terminalState: 'FINALIZED_COMPLETE',
  quoteAsset: usdc,
  legOutcomes: [{
    legId: 'repay-floating-loan',
    liabilityId: 'floating-loan',
    domain,
    status: 'EXECUTED',
    requestedQuantity: amount(-1_000n),
    settledQuantity: amount(-1_000n),
    grossNotional: amount(1_000n),
    venueFee: amount(1n),
    residualValue: amount(0n),
    evidenceGrade: 'CONSENSUS_VERIFIED',
    onchainEnforced: true,
    evidenceHash: '38'.repeat(32),
  }],
  serviceFee: amount(2n),
  solverFee: amount(3n),
  venueFees: amount(1n),
  networkCost: amount(1n),
  recoveryCost: amount(0n),
  terminalResidualValue: amount(0n),
  finalityStatus: 'FINALIZED',
  executedAtValue: 1n,
  receiptNonce: 1n,
});

describe('strategy package receipts', () => {
  test('liability changes are explicit and cannot also mutate a position', () => {
    const parsed = strategyPackageReceipt(receipt());
    assert.equal(parsed.legOutcomes[0]?.liabilityId, 'floating-loan');
    assert.throws(() => strategyPackageReceipt({
      ...receipt(),
      legOutcomes: [{ ...receipt().legOutcomes[0]!, positionLegId: 'spot-position' }],
    }), /cannot change both a position and a liability/);
  });
});
