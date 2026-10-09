import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
  formatHypercoreSize,
  hyperliquidTrustedTimeDecisionHash,
  type HypercoreOrderWire,
  type HyperliquidExecutionPlan,
  type HyperliquidTrustedTimeDecision,
} from '@naryx/adapter-hyperliquid';
import {
  adapterRef,
  assetRef,
  domainRef,
  exactPrice,
  hash32,
  manifestHash,
  protocolId,
  versionedManifestRef,
  type RecoveryActionSlot,
} from '@naryx/protocol-types';
import {
  HYPERCORE_RECONCILIATION_SOURCE,
  HYPERCORE_RECOVERY_RECONCILIATION_SOURCE,
  HyperliquidRecoveryCompiler,
  HyperliquidRecoverySqliteStore,
  HyperliquidRecoveryTestnetController,
  HyperliquidRecoveryTestnetRuntime,
  HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL,
  acknowledgeHyperliquidRecoverySubmission,
  beginHyperliquidReconciliation,
  beginHyperliquidRecoverySubmissionReconciliation,
  completeHyperliquidRecoverySubmissionReconciliation,
  confirmHyperliquidRecoveryDurableRecord,
  createHyperliquidPackageAttempt,
  createHyperliquidRecoveryAttempt,
  createHyperliquidRecoverySubmissionJournal,
  fenceHyperliquidRecoveryAgent,
  hyperliquidRecoveryReconciliationHandoff,
  initializeHyperliquidRecoveryJournal,
  markHyperliquidRecoverySubmittedUnknown,
  markHyperliquidSubmissionUnknown,
  prepareHyperliquidRecoverySubmission,
  reconcileHyperliquidPackageAttempt,
  reconcileHyperliquidRecovery,
  recoveryIssuesSuccessfulReceipt,
  registerHyperliquidRecoveryAgent,
  type HyperliquidPackageAttempt,
  type HyperliquidReconciliationSnapshotInput,
  type HyperliquidRecoveryExecutionPlan,
  type HyperliquidRecoveryReconciliationSnapshotInput,
  type HyperliquidRecoverySubmissionJournal,
} from '../src/index.js';

const nowMs = 1_000_000n;
const domain = domainRef('hypercore:testnet', 1, '11'.repeat(32));
const otherDomain = domainRef('hypercore:testnet', 2, '12'.repeat(32));
const baseAsset = assetRef('btc', '21'.repeat(32), 8);
const quoteAsset = assetRef('usdc', '22'.repeat(32), 6);
const spotAdapter = adapterRef({
  adapterId: 'hypercore-spot-v1', adapterManifestVersion: 1,
  adapterManifestHash: '31'.repeat(32),
});
const perpetualAdapter = adapterRef({
  adapterId: 'hypercore-perp-v1', adapterManifestVersion: 1,
  adapterManifestHash: '32'.repeat(32),
});
const venue = versionedManifestRef('hypercore', 1, '33'.repeat(32));
const spotMarket = versionedManifestRef('btc-usdc-spot', 1, '34'.repeat(32));
const perpetualMarket = versionedManifestRef('btc-usdc-perp', 1, '35'.repeat(32));
const controllerCodeHash = manifestHash('41'.repeat(32));
const actionBuilderCodeHash = manifestHash('42'.repeat(32));
const reconciledStateSchemaHash = manifestHash('43'.repeat(32));
const commitments = {
  seriesManifestHash: manifestHash('51'.repeat(32)),
  executionClassManifestHash: manifestHash('52'.repeat(32)),
  orderHash: hash32('53'.repeat(32)),
  quoteHash: hash32('54'.repeat(32)),
  routeHash: hash32('55'.repeat(32)),
};
const secondCommitments = {
  ...commitments,
  orderHash: hash32('56'.repeat(32)),
  quoteHash: hash32('57'.repeat(32)),
  routeHash: hash32('58'.repeat(32)),
};
const account = {
  masterAccount: `0x${'61'.repeat(20)}` as const,
  tradingAccount: `0x${'62'.repeat(20)}` as const,
  accountKind: 'SUBACCOUNT' as const,
};
const recoveryAgent = `0x${'63'.repeat(20)}` as const;
const spotClientOrderId = `0x${'71'.repeat(16)}` as const;
const perpetualClientOrderId = `0x${'72'.repeat(16)}` as const;
const identity = {
  environment: 'testnet' as const,
  controllerId: 'hypercore-recovery-controller-v1',
  controllerCodeHash,
  authorityModeId: 'agent-wallet-v1',
  actionBuilderCodeHash,
};

function price() {
  return exactPrice({
    baseAsset,
    quoteAsset,
    baseAtoms: 1n,
    quoteAtoms: 600n,
    roundingDirection: 'CEIL',
  });
}

function wire(
  assetId: number,
  buy: boolean,
  clientOrderId: `0x${string}`,
  reduceOnly: boolean,
): HypercoreOrderWire {
  return {
    a: assetId,
    b: buy,
    p: '60000',
    s: '0.000001',
    r: reduceOnly,
    t: { limit: { tif: 'Ioc' } },
    c: clientOrderId,
  };
}

interface PlanOptions {
  readonly quantityAtoms?: bigint;
  readonly planCommitments?: typeof commitments;
  readonly kind?: 'EXACT_NET' | 'BOUNDED_NET';
  readonly includeCompletePerp?: boolean;
  readonly intermediateCap?: bigint;
  readonly boundedMinimum?: bigint;
  readonly boundedMaximum?: bigint;
  readonly boundedBaseCap?: bigint;
  readonly boundedQuoteCap?: bigint;
  readonly boundedValuationBaseAtoms?: bigint;
  readonly boundedValuationQuoteAtoms?: bigint;
}

function plan(options: PlanOptions = {}): HyperliquidExecutionPlan {
  const quantityAtoms = options.quantityAtoms ?? 100n;
  const size = formatHypercoreSize(quantityAtoms, baseAsset.decimals, 6);
  const spotOrder = { ...wire(10_007, true, spotClientOrderId, false), s: size };
  const perpetualOrder = { ...wire(3, false, perpetualClientOrderId, false), s: size };
  const slots: Omit<RecoveryActionSlot, 'sequence'>[] = [];
  if (options.includeCompletePerp !== false) {
    slots.push({
      action: 'COMPLETE_PERP', targetLeg: 1, adapter: perpetualAdapter,
      markets: [perpetualMarket], maxQuantity: { asset: baseAsset, atoms: quantityAtoms },
      limitPrice: price(), reduceOnly: false, timeInForce: 'IOC',
    });
  }
  slots.push(
    {
      action: 'COMPLETE_SPOT', targetLeg: 0, adapter: spotAdapter,
      markets: [spotMarket], maxQuantity: { asset: baseAsset, atoms: quantityAtoms },
      limitPrice: price(), reduceOnly: false, timeInForce: 'IOC',
    },
    {
      action: 'ROLLBACK_SPOT', targetLeg: 0, adapter: spotAdapter,
      markets: [spotMarket], maxQuantity: { asset: baseAsset, atoms: quantityAtoms },
      limitPrice: price(), reduceOnly: false, timeInForce: 'IOC',
    },
    {
      action: 'ROLLBACK_PERP', targetLeg: 1, adapter: perpetualAdapter,
      markets: [perpetualMarket], maxQuantity: { asset: baseAsset, atoms: quantityAtoms },
      limitPrice: price(), reduceOnly: true, timeInForce: 'IOC',
    },
  );
  const kind = options.kind ?? 'EXACT_NET';
  const boundedBaseCap = options.boundedBaseCap ?? 5n;
  return {
    version: 1,
    guarantee: HYPERCORE_EXECUTION_GUARANTEE,
    domain,
    commitments: options.planCommitments ?? commitments,
    requestExpiryMs: nowMs - 100n,
    unsignedRequestFields: {
      action: { type: 'order', orders: [spotOrder, perpetualOrder], grouping: 'na' },
      expiresAfter: Number(nowMs - 100n),
    },
    legs: [
      {
        legId: 'spot', role: 'SPOT', legIndex: 0, adapter: spotAdapter, venue, market: spotMarket,
        baseAsset, quoteAsset, side: 'BUY', quantityAtoms,
        sizeDecimals: 6, maxPriceDecimals: 2, signedBaseDeltaAtoms: quantityAtoms,
        clientOrderId: spotClientOrderId, order: spotOrder,
      },
      {
        legId: 'perpetual', role: 'PERPETUAL', legIndex: 1, adapter: perpetualAdapter, venue,
        market: perpetualMarket, baseAsset, quoteAsset, side: 'SELL', quantityAtoms,
        sizeDecimals: 6, maxPriceDecimals: 0, signedBaseDeltaAtoms: -quantityAtoms,
        clientOrderId: perpetualClientOrderId, order: perpetualOrder,
      },
    ],
    grossSpotQuantityAtoms: quantityAtoms,
    prePerpPositionAtoms: 0n,
    signedPerpDeltaAtoms: -quantityAtoms,
    signedPerpTargetAtoms: -quantityAtoms,
    terminalResidualPolicy: kind === 'EXACT_NET'
      ? {
          kind: 'EXACT_NET', netSpotDeltaAtoms: quantityAtoms,
          maxTerminalResidualBaseAtoms: 0n, maxTerminalResidualQuoteAtoms: 0n,
        }
      : {
          kind: 'BOUNDED_NET',
          minNetSpotDeltaAtoms: options.boundedMinimum ?? 95n,
          maxNetSpotDeltaAtoms: options.boundedMaximum ?? 105n,
          maxTerminalResidualBaseAtoms: boundedBaseCap,
          residualValuationSchemaVersion: 1,
          residualValuationReferencePrice: exactPrice({
            baseAsset,
            quoteAsset,
            baseAtoms: options.boundedValuationBaseAtoms ?? 1n,
            quoteAtoms: options.boundedValuationQuoteAtoms ?? 600n,
            roundingDirection: 'CEIL',
          }),
          maxTerminalResidualQuoteAtoms: options.boundedQuoteCap ?? 3_000n,
        },
    recoveryPolicy: {
      policyVersion: 1,
      controllerId: protocolId(identity.controllerId),
      controllerCodeHash,
      authorityModeId: protocolId(identity.authorityModeId),
      recoveryExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
      maxActionExpiryValue: nowMs + 500n,
      deadlineValue: nowMs + 1_000n,
      minRecoveryWindowMs: 500n,
      maxRecoveryCostCaps: [{ asset: quoteAsset, maxAtoms: 100n }],
      maxAggregateRecoveryLoss: { asset: quoteAsset, atoms: 1_000n },
      maxIntermediateResidual: { asset: baseAsset, atoms: options.intermediateCap ?? 100n },
      maxTerminalResidual: { asset: baseAsset, atoms: kind === 'EXACT_NET' ? 0n : boundedBaseCap },
      reconciledStateSchemaHash,
      actionBuilderCodeHash,
      actionSlots: slots.map((slot, sequence) => ({ ...slot, sequence })),
    },
    recoveryDeadlineMs: nowMs + 1_000n,
  };
}

function sourceSnapshot(
  spotFill: bigint,
  perpetualFill: bigint,
  plannedQuantityAtoms: bigint,
  planCommitments: typeof commitments,
): HyperliquidReconciliationSnapshotInput {
  return {
    source: HYPERCORE_RECONCILIATION_SOURCE,
    domain,
    commitments: planCommitments,
    account,
    evidenceVersion: 7n,
    observedAtMs: nowMs,
    spot: {
      clientOrderId: spotClientOrderId,
      terminalStatus: spotFill === plannedQuantityAtoms
        ? 'FILLED'
        : spotFill === 0n ? 'UNFILLED_IOC_CANCELLED' : 'PARTIALLY_FILLED_IOC_CANCELLED',
      openOrderStatus: 'NONE',
      filledSignedBaseAtoms: spotFill,
    },
    perpetual: {
      clientOrderId: perpetualClientOrderId,
      terminalStatus: perpetualFill === -plannedQuantityAtoms
        ? 'FILLED'
        : perpetualFill === 0n ? 'UNFILLED_IOC_CANCELLED' : 'PARTIALLY_FILLED_IOC_CANCELLED',
      openOrderStatus: 'NONE',
      filledSignedBaseAtoms: perpetualFill,
    },
    netSpotDeltaAtoms: spotFill,
    perpetualPositionDeltaAtoms: perpetualFill,
    observedPerpetualPositionAtoms: perpetualFill,
    perpetualPositionTargetAtoms: -plannedQuantityAtoms,
    feeEvidenceComplete: true,
    fees: [],
  };
}

function sourceAttempt(
  spotFill: bigint,
  perpetualFill: bigint,
  options: PlanOptions = {},
): HyperliquidPackageAttempt {
  const started = beginHyperliquidReconciliation(markHyperliquidSubmissionUnknown(
    createHyperliquidPackageAttempt(plan(options), account),
  ));
  const reconciled = reconcileHyperliquidPackageAttempt(
    started,
    sourceSnapshot(
      spotFill,
      perpetualFill,
      options.quantityAtoms ?? 100n,
      options.planCommitments ?? commitments,
    ),
  );
  assert.equal(reconciled.status, 'RECOVERY_REQUIRED');
  return reconciled;
}

function recoveryPlan(
  source: HyperliquidPackageAttempt,
  recoverySequence = 0,
): HyperliquidRecoveryExecutionPlan {
  return new HyperliquidRecoveryCompiler(identity).compile({
    attempt: source,
    nowMs,
    recoverySequence,
    projectedRecoveryCosts: [{ asset: quoteAsset, atoms: 10n }],
    projectedAggregateLoss: { asset: quoteAsset, atoms: 100n },
  });
}

function recoveryEvidence(
  source: HyperliquidPackageAttempt,
  compiled: HyperliquidRecoveryExecutionPlan,
  fills = compiled.orders.map((order) => order.signedBaseDeltaAtoms),
  overrides: Partial<HyperliquidRecoveryReconciliationSnapshotInput> = {},
): HyperliquidRecoveryReconciliationSnapshotInput {
  const recoverySpot = compiled.orders.reduce((total, order, index) =>
    total + (order.role === 'SPOT' ? fills[index]! : 0n), 0n);
  const recoveryPerpetual = compiled.orders.reduce((total, order, index) =>
    total + (order.role === 'PERPETUAL' ? fills[index]! : 0n), 0n);
  const sourceEvidence = source.acceptedEvidence!;
  const perpetualPositionDeltaAtoms = sourceEvidence.perpetualPositionDeltaAtoms
    + recoveryPerpetual;
  return {
    source: HYPERCORE_RECOVERY_RECONCILIATION_SOURCE,
    domain: compiled.domain,
    commitments: compiled.commitments,
    account,
    reconciledStateSchemaHash,
    sourceEvidenceVersion: compiled.sourceEvidenceVersion,
    recoverySequence: compiled.recoverySequence,
    evidenceVersion: compiled.sourceEvidenceVersion + 1n,
    observedAtMs: nowMs + 10n,
    recoveryOrders: compiled.orders.map((order, index) => {
      const fill = fills[index]!;
      return {
        clientOrderId: order.clientOrderId,
        terminalStatus: fill === order.signedBaseDeltaAtoms
          ? 'FILLED'
          : fill === 0n ? 'UNFILLED_IOC_CANCELLED' : 'PARTIALLY_FILLED_IOC_CANCELLED',
        openOrderStatus: 'NONE',
        filledSignedBaseAtoms: fill,
      };
    }),
    netSpotBalanceDeltaAtoms: sourceEvidence.netSpotDeltaAtoms + recoverySpot,
    perpetualPositionDeltaAtoms,
    observedPerpetualPositionAtoms: source.plan.prePerpetualPositionAtoms
      + perpetualPositionDeltaAtoms,
    perpetualPositionTargetAtoms: compiled.mode === 'PAIRED_ROLLBACK'
      ? source.plan.prePerpetualPositionAtoms
      : source.plan.perpetualPositionTargetAtoms,
    costEvidenceComplete: true,
    fees: [{ asset: quoteAsset, amountAtoms: 2n, evidenceStatus: 'CONFIRMED' }],
    actualRecoveryCosts: [{
      asset: quoteAsset, amountAtoms: 10n, evidenceStatus: 'CONFIRMED',
    }],
    actualAggregateLoss: {
      asset: quoteAsset, amountAtoms: 100n, evidenceStatus: 'CONFIRMED',
    },
    ...overrides,
  };
}

function recoveryAttempt(source: HyperliquidPackageAttempt, compiled: HyperliquidRecoveryExecutionPlan) {
  return createHyperliquidRecoveryAttempt(source, compiled, identity, nowMs);
}

test('keeper compiles the recovery plan before handing it to submission', async () => {
  const source = sourceAttempt(100n, 0n);
  const submitted: HyperliquidRecoveryExecutionPlan[] = [];
  const controller = new HyperliquidRecoveryTestnetController({
    compiler: new HyperliquidRecoveryCompiler(identity),
    trustedTime: { decide: async (scope) => trustedTimeDecision(scope) },
    runtime: {
      execute: async (input) => {
        submitted.push(input.plan);
        return {
          status: 'RECONCILIATION_REQUIRED',
          handoff: { recoveryAttemptId: input.recoveryAttemptId },
          errorCommitment: null,
        } as never;
      },
    },
  });
  const result = await controller.compileAndExecute({
    recoveryAttemptId: 'controller-recovery-attempt-1',
    sourceAttempt: source,
    recoverySequence: 0,
    projectedRecoveryCosts: [{ asset: quoteAsset, atoms: 10n }],
    projectedAggregateLoss: { asset: quoteAsset, atoms: 100n },
  });
  assert.equal(submitted.length, 1);
  assert.strictEqual(submitted[0], result.plan);
  assert.equal(result.plan.mode, 'COMPLETE_MISSING_LEG');
  assert.equal(result.submission.status, 'RECONCILIATION_REQUIRED');
});

test('reconciles exact completion from authoritative actual evidence', () => {
  const source = sourceAttempt(100n, 0n);
  const compiled = recoveryPlan(source);
  const result = reconcileHyperliquidRecovery(
    recoveryAttempt(source, compiled),
    recoveryEvidence(source, compiled),
  );
  assert.equal(result.status, 'RECOVERED_COMPLETE');
  assert.equal(recoveryIssuesSuccessfulReceipt(result.status), true);
  assert.equal(result.acceptedEvidence!.perpetualPositionDeltaAtoms, -100n);
  assert.equal(result.acceptedEvidence!.actualRecoveryCosts[0]!.amountAtoms, 10n);
});

test('reconciles bounded completion with upward quote residual rounding', () => {
  const source = sourceAttempt(0n, -100n, {
    kind: 'BOUNDED_NET',
    boundedMinimum: 99n,
    boundedMaximum: 100n,
    boundedBaseCap: 1n,
    boundedQuoteCap: 1n,
    boundedValuationBaseAtoms: 3n,
    boundedValuationQuoteAtoms: 1n,
  });
  const compiled = recoveryPlan(source);
  assert.equal(compiled.orders[0]!.role, 'SPOT');
  const result = reconcileHyperliquidRecovery(
    recoveryAttempt(source, compiled),
    recoveryEvidence(source, compiled, [99n]),
  );
  assert.equal(result.status, 'RECOVERED_BOUNDED');
  assert.equal(result.acceptedEvidence!.netSpotBalanceDeltaAtoms, 99n);
});

test('paired rollback restores the pre-package spot and perpetual state exactly', () => {
  const source = sourceAttempt(200n, -100n, {
    quantityAtoms: 200n,
    includeCompletePerp: false,
    intermediateCap: 200n,
  });
  const compiled = recoveryPlan(source);
  assert.equal(compiled.mode, 'PAIRED_ROLLBACK');
  const result = reconcileHyperliquidRecovery(
    recoveryAttempt(source, compiled),
    recoveryEvidence(source, compiled),
  );
  assert.equal(result.status, 'RECOVERED_FLAT');
  assert.equal(recoveryIssuesSuccessfulReceipt(result.status), false);
  assert.equal(result.acceptedEvidence!.netSpotBalanceDeltaAtoms, 0n);
  assert.equal(result.acceptedEvidence!.perpetualPositionDeltaAtoms, 0n);
  assert.equal(result.acceptedEvidence!.observedPerpetualPositionAtoms, 0n);
});

test('emits another signed recovery obligation only while actions and bounds remain available', () => {
  const source = sourceAttempt(100n, 0n);
  const compiled = recoveryPlan(source);
  const result = reconcileHyperliquidRecovery(
    recoveryAttempt(source, compiled),
    recoveryEvidence(source, compiled, [-50n]),
  );
  assert.equal(result.status, 'RECOVERY_REQUIRED');
  assert.equal(result.nextRecoveryObligation!.recoverySequence, 1);
  assert.deepEqual(result.nextRecoveryObligation!.actions.map((action) => [
    action.action,
    action.signedBaseDeltaAtoms,
  ]), [['COMPLETE_PERP', -50n]]);
  assert.equal(result.nextRecoveryObligation!.remainingRecoveryCostCaps[0]!.atoms, 90n);
  assert.equal(result.nextRecoveryObligation!.remainingAggregateLoss.atoms, 900n);
});

test('locks cost, loss, and conservative intermediate residual breaches', async (suite) => {
  const source = sourceAttempt(100n, 0n);
  const compiled = recoveryPlan(source);
  await suite.test('actual cost cap', () => {
    const result = reconcileHyperliquidRecovery(
      recoveryAttempt(source, compiled),
      recoveryEvidence(source, compiled, undefined, {
        actualRecoveryCosts: [{
          asset: quoteAsset, amountAtoms: 101n, evidenceStatus: 'CONFIRMED',
        }],
      }),
    );
    assert.equal(result.status, 'MANUAL_INTERVENTION');
    assert.deepEqual(result.reasons, ['RECOVERY_COST_CAP_BREACH']);
  });
  await suite.test('actual aggregate loss', () => {
    const result = reconcileHyperliquidRecovery(
      recoveryAttempt(source, compiled),
      recoveryEvidence(source, compiled, undefined, {
        actualAggregateLoss: {
          asset: quoteAsset, amountAtoms: 1_001n, evidenceStatus: 'CONFIRMED',
        },
      }),
    );
    assert.equal(result.status, 'MANUAL_INTERVENTION');
    assert.deepEqual(result.reasons, ['AGGREGATE_LOSS_CAP_BREACH']);
  });
  await suite.test('non-atomic intermediate residual', () => {
    const rollbackSource = sourceAttempt(200n, -100n, {
      quantityAtoms: 200n,
      includeCompletePerp: false,
      intermediateCap: 100n,
    });
    const rollback = recoveryPlan(rollbackSource);
    const result = reconcileHyperliquidRecovery(
      recoveryAttempt(rollbackSource, rollback),
      recoveryEvidence(rollbackSource, rollback),
    );
    assert.equal(result.status, 'MANUAL_INTERVENTION');
    assert.deepEqual(result.reasons, ['INTERMEDIATE_RESIDUAL_BREACH']);
  });
});

test('locks open or unknown recovery orders and uncertain cost evidence', () => {
  const source = sourceAttempt(100n, 0n);
  const compiled = recoveryPlan(source);
  const base = recoveryEvidence(source, compiled);
  const open = reconcileHyperliquidRecovery(recoveryAttempt(source, compiled), {
    ...base,
    recoveryOrders: [{ ...base.recoveryOrders[0]!, openOrderStatus: 'OPEN' }],
  });
  assert.equal(open.status, 'MANUAL_INTERVENTION');
  assert.deepEqual(open.reasons, ['OPEN_OR_UNCERTAIN_RECOVERY_ORDER']);
  const uncertain = reconcileHyperliquidRecovery(recoveryAttempt(source, compiled), {
    ...base,
    costEvidenceComplete: false,
  });
  assert.equal(uncertain.status, 'MANUAL_INTERVENTION');
  assert.deepEqual(uncertain.reasons, ['UNCERTAIN_COST_EVIDENCE']);
});

test('rejects untrusted recovery plans with wrong binding, cloid, or order semantics', () => {
  const source = sourceAttempt(100n, 0n);
  const compiled = recoveryPlan(source);
  assert.throws(() => createHyperliquidRecoveryAttempt(source, {
    ...compiled,
    domain: otherDomain,
  }, identity, nowMs), /domain, commitment, or account mismatch/);
  assert.throws(() => createHyperliquidRecoveryAttempt(source, {
    ...compiled,
    controllerCodeHash: manifestHash('ff'.repeat(32)),
  }, identity, nowMs), /identity mismatch/);
  const changedOrder = {
    ...compiled.orders[0]!,
    clientOrderId: `0x${'ff'.repeat(16)}` as const,
    order: {
      ...compiled.orders[0]!.order,
      c: `0x${'ff'.repeat(16)}` as const,
    },
  };
  assert.throws(() => createHyperliquidRecoveryAttempt(source, {
    ...compiled,
    orders: [changedOrder],
    unsignedRequestFields: {
      ...compiled.unsignedRequestFields,
      action: { ...compiled.unsignedRequestFields.action, orders: [changedOrder.order] },
    },
  }, identity, nowMs), /client order ID mismatch/);
  const reversed = {
    ...compiled.orders[0]!,
    order: { ...compiled.orders[0]!.order, b: true },
  };
  assert.throws(() => createHyperliquidRecoveryAttempt(source, {
    ...compiled,
    orders: [reversed],
    unsignedRequestFields: {
      ...compiled.unsignedRequestFields,
      action: { ...compiled.unsignedRequestFields.action, orders: [reversed.order] },
    },
  }, identity, nowMs), /wire order fields/);
});

test('locks wrong authoritative identity including account, commitment, and recovery cloid', () => {
  const source = sourceAttempt(100n, 0n);
  const compiled = recoveryPlan(source);
  const base = recoveryEvidence(source, compiled);
  const cases: readonly HyperliquidRecoveryReconciliationSnapshotInput[] = [
    { ...base, domain: otherDomain },
    { ...base, account: { ...account, tradingAccount: `0x${'64'.repeat(20)}` } },
    { ...base, commitments: { ...commitments, routeHash: hash32('ff'.repeat(32)) } },
    { ...base, recoveryOrders: [{
      ...base.recoveryOrders[0]!, clientOrderId: `0x${'ff'.repeat(16)}`,
    }] },
  ];
  for (const evidence of cases) {
    const result = reconcileHyperliquidRecovery(recoveryAttempt(source, compiled), evidence);
    assert.equal(result.status, 'MANUAL_INTERVENTION');
    assert.deepEqual(result.reasons, ['IDENTITY_MISMATCH']);
  }
});

test('keeps duplicate and late matching evidence idempotent and locks conflicts', () => {
  const source = sourceAttempt(100n, 0n);
  const compiled = recoveryPlan(source);
  const evidence = recoveryEvidence(source, compiled);
  const completed = reconcileHyperliquidRecovery(recoveryAttempt(source, compiled), evidence);
  assert.strictEqual(reconcileHyperliquidRecovery(completed, evidence), completed);
  assert.strictEqual(reconcileHyperliquidRecovery(completed, {
    ...evidence,
    evidenceVersion: evidence.evidenceVersion + 1n,
    observedAtMs: evidence.observedAtMs + 1n,
  }), completed);
  const conflicting = reconcileHyperliquidRecovery(completed, {
    ...evidence,
    evidenceVersion: evidence.evidenceVersion + 2n,
    observedAtMs: evidence.observedAtMs + 2n,
    fees: [{ asset: quoteAsset, amountAtoms: 3n, evidenceStatus: 'CONFIRMED' }],
  });
  assert.equal(conflicting.status, 'MANUAL_INTERVENTION');
  assert.deepEqual(conflicting.reasons, ['CONFLICTING_TERMINAL_EVIDENCE']);
  assert.strictEqual(reconcileHyperliquidRecovery(conflicting, {
    ...evidence,
    evidenceVersion: evidence.evidenceVersion + 3n,
    observedAtMs: evidence.observedAtMs + 3n,
  }), conflicting);
});

function registeredJournal(): HyperliquidRecoverySubmissionJournal {
  return registerHyperliquidRecoveryAgent(createHyperliquidRecoverySubmissionJournal(identity), {
    expectedVersion: 0n,
    agentWallet: recoveryAgent,
    signerLeaseId: 'recovery-process-1',
  });
}

function trustedTimeDecision(
  scope: string,
  selectedTimeMs = Number(nowMs),
  maximumFutureNonceLeadMs = 10_000,
): HyperliquidTrustedTimeDecision {
  const unsigned = {
    version: 1 as const,
    scope,
    observedAtMs: selectedTimeMs,
    selectedTimeMs,
    sourceSpreadMs: 2,
    localClockSkewMs: 0,
    policy: {
      ntpHosts: ['time.google.com', 'time.cloudflare.com'] as const,
      ntpTimeoutMs: 2_000,
      maximumNtpRoundTripMs: 500,
      maximumSourceSpreadMs: 10_000,
      maximumLocalClockSkewMs: 2_000,
      maximumFutureNonceLeadMs,
      hyperliquidClockMarket: 'HYPE',
    },
    samples: [
      { sourceKind: 'NTP' as const, sourceId: 'time.google.com', remoteTimeMs: selectedTimeMs - 1, roundTripMs: 10 },
      { sourceKind: 'NTP' as const, sourceId: 'time.cloudflare.com', remoteTimeMs: selectedTimeMs, roundTripMs: 11 },
      { sourceKind: 'HYPERLIQUID_L2_BOOK' as const, sourceId: 'HYPE', remoteTimeMs: selectedTimeMs + 1, roundTripMs: 12 },
    ] as const,
  };
  return Object.freeze({ ...unsigned, decisionHash: hyperliquidTrustedTimeDecisionHash(unsigned) });
}

function preparedJournal(
  journal: HyperliquidRecoverySubmissionJournal,
  source: HyperliquidPackageAttempt,
  compiled: HyperliquidRecoveryExecutionPlan,
  recoveryAttemptId = 'recovery-attempt-1',
  selectedTimeMs = Number(nowMs),
  maximumFutureNonceLeadMs = 10_000,
) {
  return prepareHyperliquidRecoverySubmission(journal, {
    expectedVersion: journal.version,
    recoveryAttemptId,
    agentWallet: recoveryAgent,
    signerLeaseId: 'recovery-process-1',
    sourceAttempt: source,
    plan: compiled,
    trustedTimeDecision: trustedTimeDecision(
      recoveryAttemptId,
      selectedTimeMs,
      maximumFutureNonceLeadMs,
    ),
    vaultAddress: account.tradingAccount,
  });
}

test('requires durable write-ahead confirmation and survives restart into reconciliation', () => {
  const source = sourceAttempt(100n, 0n);
  const compiled = recoveryPlan(source);
  const prepared = preparedJournal(registeredJournal(), source, compiled);
  const record = prepared.agents[0]!.attempts[0]!;
  assert.equal(record.nonce, nowMs);
  assert.equal(record.trustedTimeDecision.scope, record.recoveryAttemptId);
  assert.equal(record.submissionTimeDecision, null);
  assert.throws(() => markHyperliquidRecoverySubmittedUnknown(prepared, {
    expectedVersion: prepared.version,
    recoveryAttemptId: record.recoveryAttemptId,
    trustedTimeDecision: trustedTimeDecision(`${record.recoveryAttemptId}:submit`),
  }), /cannot follow/);
  assert.throws(() => hyperliquidRecoveryReconciliationHandoff(
    prepared,
    record.recoveryAttemptId,
  ), /unconfirmed/);
  const durable = confirmHyperliquidRecoveryDurableRecord(prepared, {
    expectedVersion: prepared.version,
    recoveryAttemptId: record.recoveryAttemptId,
    recordHash: record.recordHash,
    durableRevision: 'recovery-store-rev-1',
  });
  const restarted = structuredClone(durable);
  const handoff = hyperliquidRecoveryReconciliationHandoff(
    restarted,
    record.recoveryAttemptId,
  );
  assert.equal(handoff.attempt.status, 'RECONCILING');
  assert.equal(handoff.trustedTimeDecisionHash, record.trustedTimeDecision.decisionHash);
  assert.equal(handoff.submissionTimeDecisionHash, null);
  assert.deepEqual(handoff.clientOrderIds, compiled.orders.map((order) => order.clientOrderId));
  const submitted = markHyperliquidRecoverySubmittedUnknown(restarted, {
    expectedVersion: restarted.version,
    recoveryAttemptId: record.recoveryAttemptId,
    trustedTimeDecision: trustedTimeDecision(`${record.recoveryAttemptId}:submit`),
  });
  assert.equal(submitted.agents[0]!.attempts[0]!.status, 'SUBMITTED_UNKNOWN');
  assert.equal(hyperliquidRecoveryReconciliationHandoff(
    submitted,
    record.recoveryAttemptId,
  ).submissionTimeDecisionHash, submitted.agents[0]!.attempts[0]!
    .submissionTimeDecision!.decisionHash);
});

test('enforces CAS, monotonic nonce and sequence fencing, and permanent retirement', () => {
  const source = sourceAttempt(100n, 0n);
  const firstPlan = recoveryPlan(source, 0);
  const initial = registeredJournal();
  const first = preparedJournal(initial, source, firstPlan);
  assert.throws(() => prepareHyperliquidRecoverySubmission(first, {
    expectedVersion: initial.version,
    recoveryAttemptId: 'recovery-attempt-2',
    agentWallet: recoveryAgent,
    signerLeaseId: 'recovery-process-1',
    sourceAttempt: source,
    plan: recoveryPlan(source, 1),
    trustedTimeDecision: trustedTimeDecision('recovery-attempt-2'),
    vaultAddress: account.tradingAccount,
  }), /compare-and-set/);
  const durable = confirmHyperliquidRecoveryDurableRecord(first, {
    expectedVersion: first.version,
    recoveryAttemptId: 'recovery-attempt-1',
    recordHash: first.agents[0]!.attempts[0]!.recordHash,
    durableRevision: 'recovery-store-rev-2',
  });
  const submitted = markHyperliquidRecoverySubmittedUnknown(durable, {
    expectedVersion: durable.version,
    recoveryAttemptId: 'recovery-attempt-1',
    trustedTimeDecision: trustedTimeDecision('recovery-attempt-1:submit'),
  });
  const acknowledged = acknowledgeHyperliquidRecoverySubmission(submitted, {
    expectedVersion: submitted.version,
    recoveryAttemptId: 'recovery-attempt-1',
    acknowledgementId: 'recovery-ack-1',
  });
  const reconciling = beginHyperliquidRecoverySubmissionReconciliation(acknowledged, {
    expectedVersion: acknowledged.version,
    recoveryAttemptId: 'recovery-attempt-1',
  });
  const retired = fenceHyperliquidRecoveryAgent(reconciling, {
    expectedVersion: reconciling.version,
    agentWallet: recoveryAgent,
    signerLeaseId: 'recovery-process-1',
    disposition: 'RETIRED',
  });
  assert.equal(retired.agents[0]!.attempts[0]!.status, 'RECONCILING');
  assert.equal(retired.agents[0]!.attempts[0]!.acknowledgementId, 'recovery-ack-1');
  assert.equal(hyperliquidRecoveryReconciliationHandoff(
    retired,
    'recovery-attempt-1',
  ).attempt.status, 'RECONCILING');
  assert.throws(() => registerHyperliquidRecoveryAgent(retired, {
    expectedVersion: retired.version,
    agentWallet: recoveryAgent,
    signerLeaseId: 'recovery-process-2',
  }), /already registered, fenced, or retired/);
  assert.throws(() => preparedJournal(
    retired,
    source,
    recoveryPlan(source, 1),
    'recovery-attempt-2',
    Number(nowMs + 2n),
  ), /fenced or retired/);
});

test('scopes recovery sequence fencing to each package lineage', () => {
  const firstSource = sourceAttempt(100n, 0n);
  const secondSource = sourceAttempt(100n, 0n, { planCommitments: secondCommitments });
  const initial = registeredJournal();
  const first = preparedJournal(
    initial,
    firstSource,
    recoveryPlan(firstSource, 1),
    'recovery-attempt-lineage-1',
    Number(nowMs + 1n),
  );
  const second = preparedJournal(
    first,
    secondSource,
    recoveryPlan(secondSource, 1),
    'recovery-attempt-lineage-2',
    Number(nowMs + 2n),
  );
  assert.equal(second.agents[0]!.recoveryLineages.length, 2);
  assert.deepEqual(second.agents[0]!.recoveryLineages.map(
    (lineage) => lineage.highestReservedRecoverySequence,
  ), [1, 1]);
});

test('refuses a restored future nonce instead of resetting the recovery agent', () => {
  const firstSource = sourceAttempt(100n, 0n);
  const secondSource = sourceAttempt(100n, 0n, { planCommitments: secondCommitments });
  const first = preparedJournal(
    registeredJournal(),
    firstSource,
    recoveryPlan(firstSource, 1),
    'future-recovery-attempt',
    Number(nowMs + 101n),
    100,
  );
  assert.throws(() => preparedJournal(
    first,
    secondSource,
    recoveryPlan(secondSource, 1),
    'current-recovery-attempt',
    Number(nowMs),
    100,
  ), /fresh agent replacement is required/);
});

test('refuses recovery submission after trusted time moves behind its durable nonce', () => {
  const source = sourceAttempt(100n, 0n);
  const prepared = preparedJournal(
    registeredJournal(),
    source,
    recoveryPlan(source),
    'clock-skew-recovery',
    Number(nowMs),
    100,
  );
  const record = prepared.agents[0]!.attempts[0]!;
  const durable = confirmHyperliquidRecoveryDurableRecord(prepared, {
    expectedVersion: prepared.version,
    recoveryAttemptId: record.recoveryAttemptId,
    recordHash: record.recordHash,
    durableRevision: 'clock-skew-revision',
  });
  assert.throws(() => markHyperliquidRecoverySubmittedUnknown(durable, {
    expectedVersion: durable.version,
    recoveryAttemptId: record.recoveryAttemptId,
    trustedTimeDecision: trustedTimeDecision(
      `${record.recoveryAttemptId}:submit`,
      Number(nowMs - 101n),
      100,
    ),
  }), /fresh agent replacement is required/);
});

test('refuses a second recovery action while an earlier one for the package is unresolved', () => {
  const secondAgent = `0x${'64'.repeat(20)}` as const;
  const source = sourceAttempt(100n, 0n);
  const firstPlan = recoveryPlan(source, 0);
  const withSecondAgent = registerHyperliquidRecoveryAgent(registeredJournal(), {
    expectedVersion: 1n,
    agentWallet: secondAgent,
    signerLeaseId: 'recovery-process-2',
  });
  const prepared = preparedJournal(withSecondAgent, source, firstPlan);
  const durable = confirmHyperliquidRecoveryDurableRecord(prepared, {
    expectedVersion: prepared.version,
    recoveryAttemptId: 'recovery-attempt-1',
    recordHash: prepared.agents[0]!.attempts[0]!.recordHash,
    durableRevision: 'recovery-store-rev-3',
  });
  const unknown = markHyperliquidRecoverySubmittedUnknown(durable, {
    expectedVersion: durable.version,
    recoveryAttemptId: 'recovery-attempt-1',
    trustedTimeDecision: trustedTimeDecision('recovery-attempt-1:submit'),
  });
  const prepareSecond = (journal: HyperliquidRecoverySubmissionJournal, plan: HyperliquidRecoveryExecutionPlan) =>
    prepareHyperliquidRecoverySubmission(journal, {
      expectedVersion: journal.version,
      recoveryAttemptId: 'recovery-attempt-2',
      agentWallet: secondAgent,
      signerLeaseId: 'recovery-process-2',
      sourceAttempt: source,
      plan,
      trustedTimeDecision: trustedTimeDecision('recovery-attempt-2'),
      vaultAddress: account.tradingAccount,
    });

  // The first response was lost: a second full action on another wallet could double the fill.
  assert.throws(() => prepareSecond(unknown, recoveryPlan(source, 1)), /not yet reconciled/);

  const reconciling = beginHyperliquidRecoverySubmissionReconciliation(unknown, {
    expectedVersion: unknown.version,
    recoveryAttemptId: 'recovery-attempt-1',
  });
  assert.throws(() => prepareSecond(reconciling, recoveryPlan(source, 1)), /not yet reconciled/);

  const partial = reconcileHyperliquidRecovery(recoveryAttempt(source, firstPlan), recoveryEvidence(source, firstPlan, [-50n]));
  assert.equal(partial.status, 'RECOVERY_REQUIRED');
  const reconciled = completeHyperliquidRecoverySubmissionReconciliation(reconciling, {
    expectedVersion: reconciling.version,
    recoveryAttemptId: 'recovery-attempt-1',
    reconciledAttempt: partial,
  });
  const record = reconciled.agents[0]!.attempts[0]!;
  assert.equal(record.status, 'RECONCILED');
  assert.equal(record.reconciledEvidenceVersion, partial.acceptedEvidence!.evidenceVersion);
  assert.equal(completeHyperliquidRecoverySubmissionReconciliation(reconciled, {
    expectedVersion: reconciled.version,
    recoveryAttemptId: 'recovery-attempt-1',
    reconciledAttempt: partial,
  }), reconciled);

  // A follow-up compiled from evidence older than the reconciled recovery is refused.
  assert.throws(() => prepareSecond(reconciled, recoveryPlan(source, 1)), /latest reconciled evidence/);

  const complete = reconcileHyperliquidRecovery(recoveryAttempt(source, firstPlan), recoveryEvidence(source, firstPlan));
  const terminal = completeHyperliquidRecoverySubmissionReconciliation(reconciling, {
    expectedVersion: reconciling.version,
    recoveryAttemptId: 'recovery-attempt-1',
    reconciledAttempt: complete,
  });
  assert.equal(terminal.agents[0]!.attempts[0]!.reconciledOutcome, 'RECOVERED_COMPLETE');
  assert.throws(() => prepareSecond(terminal, recoveryPlan(source, 1)), /terminal or manual outcome/);
});

test('persists a recovery action before one exact Hyperliquid Testnet submission', async (suite) => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-hyperliquid-recovery-'));
  suite.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'recovery.sqlite');
  const store = new HyperliquidRecoverySqliteStore({ databasePath });
  initializeHyperliquidRecoveryJournal({
    store,
    verifierIdentity: identity,
    agentWallet: recoveryAgent,
    signerLeaseId: 'recovery-process-1',
  });
  const source = sourceAttempt(100n, 0n);
  const compiled = recoveryPlan(source);
  const submissions: unknown[] = [];
  const runtime = new HyperliquidRecoveryTestnetRuntime({
    store,
    trustedTime: { decide: async (scope) => trustedTimeDecision(scope) },
    submitter: {
      environment: 'testnet',
      apiUrl: HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL,
      signerAddress: async () => recoveryAgent,
      submit: async (submission) => {
        submissions.push(structuredClone(submission));
        return { acknowledgementId: 'recovery-acknowledgement-1' };
      },
    },
    agentWallet: recoveryAgent,
    signerLeaseId: 'recovery-process-1',
    vaultAddress: account.tradingAccount,
  });
  const completed = await runtime.execute({
    recoveryAttemptId: 'runtime-recovery-attempt-1',
    sourceAttempt: source,
    plan: compiled,
  });
  assert.equal(completed.status, 'ACKNOWLEDGED');
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0], {
    action: compiled.unsignedRequestFields.action,
    nonce: nowMs,
    expiresAfterMs: compiled.actionExpiryMs,
    vaultAddress: account.tradingAccount,
  });
  store.close();

  const restartedStore = new HyperliquidRecoverySqliteStore({ databasePath });
  const restarted = new HyperliquidRecoveryTestnetRuntime({
    store: restartedStore,
    trustedTime: { decide: async (scope) => trustedTimeDecision(scope) },
    submitter: {
      environment: 'testnet',
      apiUrl: HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL,
      signerAddress: async () => recoveryAgent,
      submit: async (submission) => {
        submissions.push(structuredClone(submission));
        return { acknowledgementId: 'unexpected-replay' };
      },
    },
    agentWallet: recoveryAgent,
    signerLeaseId: 'recovery-process-1',
    vaultAddress: account.tradingAccount,
  });
  const resumed = await restarted.execute({
    recoveryAttemptId: 'runtime-recovery-attempt-1',
    sourceAttempt: source,
    plan: compiled,
  });
  assert.equal(resumed.status, 'RECONCILIATION_REQUIRED');
  assert.equal(submissions.length, 1);
  restartedStore.close();
});

test('keeps an ambiguous recovery submission durable and never blindly retries it', async (suite) => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-hyperliquid-recovery-'));
  suite.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'recovery.sqlite');
  const store = new HyperliquidRecoverySqliteStore({ databasePath });
  initializeHyperliquidRecoveryJournal({
    store,
    verifierIdentity: identity,
    agentWallet: recoveryAgent,
    signerLeaseId: 'recovery-process-1',
  });
  const source = sourceAttempt(100n, 0n);
  const compiled = recoveryPlan(source);
  let submissionCount = 0;
  const submitter = {
    environment: 'testnet' as const,
    apiUrl: HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL as typeof HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL,
    signerAddress: async () => recoveryAgent,
    submit: async () => {
      submissionCount += 1;
      throw new Error('response lost after submission');
    },
  };
  const runtime = new HyperliquidRecoveryTestnetRuntime({
    store,
    trustedTime: { decide: async (scope) => trustedTimeDecision(scope) },
    submitter,
    agentWallet: recoveryAgent,
    signerLeaseId: 'recovery-process-1',
    vaultAddress: account.tradingAccount,
  });
  const first = await runtime.execute({
    recoveryAttemptId: 'runtime-recovery-attempt-2',
    sourceAttempt: source,
    plan: compiled,
  });
  assert.equal(first.status, 'SUBMISSION_AMBIGUOUS');
  assert.match(first.errorCommitment!, /^0x[0-9a-f]{64}$/);
  assert.equal(store.read()!.journal.agents[0]!.attempts[0]!.status, 'SUBMITTED_UNKNOWN');
  store.close();

  const restartedStore = new HyperliquidRecoverySqliteStore({ databasePath });
  const restarted = new HyperliquidRecoveryTestnetRuntime({
    store: restartedStore,
    trustedTime: { decide: async (scope) => trustedTimeDecision(scope) },
    submitter,
    agentWallet: recoveryAgent,
    signerLeaseId: 'recovery-process-1',
    vaultAddress: account.tradingAccount,
  });
  const second = await restarted.execute({
    recoveryAttemptId: 'runtime-recovery-attempt-2',
    sourceAttempt: source,
    plan: compiled,
  });
  assert.equal(second.status, 'RECONCILIATION_REQUIRED');
  assert.equal(submissionCount, 1);
  restartedStore.close();
});

test('serializes recovery journal writers with an append-only SQLite CAS', (suite) => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-hyperliquid-recovery-'));
  suite.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'recovery.sqlite');
  const firstStore = new HyperliquidRecoverySqliteStore({ databasePath });
  initializeHyperliquidRecoveryJournal({
    store: firstStore,
    verifierIdentity: identity,
    agentWallet: recoveryAgent,
    signerLeaseId: 'recovery-process-1',
  });
  const secondStore = new HyperliquidRecoverySqliteStore({ databasePath });
  const firstSnapshot = firstStore.read()!;
  const staleSnapshot = secondStore.read()!;
  const firstUpdate = registerHyperliquidRecoveryAgent(firstSnapshot.journal, {
    expectedVersion: firstSnapshot.journal.version,
    agentWallet: `0x${'64'.repeat(20)}`,
    signerLeaseId: 'recovery-process-2',
  });
  const staleUpdate = registerHyperliquidRecoveryAgent(staleSnapshot.journal, {
    expectedVersion: staleSnapshot.journal.version,
    agentWallet: `0x${'65'.repeat(20)}`,
    signerLeaseId: 'recovery-process-3',
  });
  firstStore.persist(firstSnapshot.revision, firstUpdate);
  assert.throws(() => secondStore.persist(staleSnapshot.revision, staleUpdate),
    /compare-and-set revision differs/);
  assert.equal(firstStore.read()!.journal.agents.length, 2);
  secondStore.close();
  firstStore.close();
});
