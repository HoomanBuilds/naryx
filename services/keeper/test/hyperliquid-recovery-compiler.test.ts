import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
  formatHypercoreSize,
  type HypercoreOrderWire,
  type HyperliquidExecutionPlan,
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
  HyperliquidRecoveryCompiler,
  beginHyperliquidReconciliation,
  createHyperliquidPackageAttempt,
  markHyperliquidSubmissionUnknown,
  reconcileHyperliquidPackageAttempt,
  type HyperliquidPackageAttempt,
  type HyperliquidReconciliationSnapshotInput,
} from '../src/index.js';

const nowMs = 1_100n;
const domain = domainRef('hypercore:testnet', 1, '11'.repeat(32));
const baseAsset = assetRef('btc', '12'.repeat(32), 8);
const quoteAsset = assetRef('usdc', '13'.repeat(32), 6);
const spotAdapter = adapterRef({
  adapterId: 'hypercore-spot-v1', adapterManifestVersion: 1,
  adapterManifestHash: '14'.repeat(32),
});
const perpetualAdapter = adapterRef({
  adapterId: 'hypercore-perp-v1', adapterManifestVersion: 1,
  adapterManifestHash: '15'.repeat(32),
});
const venue = versionedManifestRef('hypercore', 1, '16'.repeat(32));
const spotMarket = versionedManifestRef('btc-usdc-spot', 1, '17'.repeat(32));
const perpetualMarket = versionedManifestRef('btc-usdc-perp', 1, '18'.repeat(32));
const controllerCodeHash = manifestHash('19'.repeat(32));
const actionBuilderCodeHash = manifestHash('1a'.repeat(32));
const account = {
  masterAccount: `0x${'21'.repeat(20)}` as const,
  tradingAccount: `0x${'22'.repeat(20)}` as const,
  accountKind: 'SUBACCOUNT' as const,
};
const commitments = {
  seriesManifestHash: manifestHash('31'.repeat(32)),
  executionClassManifestHash: manifestHash('32'.repeat(32)),
  orderHash: hash32('33'.repeat(32)),
  quoteHash: hash32('34'.repeat(32)),
  routeHash: hash32('35'.repeat(32)),
};
const spotClientOrderId = `0x${'41'.repeat(16)}` as const;
const perpetualClientOrderId = `0x${'42'.repeat(16)}` as const;

function price(
  quoteAtoms = 600n,
  baseAtoms = 1n,
  roundingDirection: 'FLOOR' | 'CEIL' = 'CEIL',
) {
  return exactPrice({ baseAsset, quoteAsset, quoteAtoms, baseAtoms, roundingDirection });
}

function wire(
  assetId: number,
  buy: boolean,
  clientOrderId: `0x${string}`,
  reduceOnly: boolean,
): HypercoreOrderWire {
  return {
    a: assetId, b: buy, p: '60000', s: '0.000001', r: reduceOnly,
    t: { limit: { tif: 'Ioc' } }, c: clientOrderId,
  };
}

interface PlanOptions {
  readonly quantityAtoms?: bigint;
  readonly includeComplete?: boolean;
  readonly rollbackSpotPrice?: ReturnType<typeof price>;
  readonly rollbackPerpPrice?: ReturnType<typeof price>;
  readonly rollbackPerpMaximum?: bigint;
  readonly intermediateCap?: bigint;
  readonly rollbackPerpReduceOnly?: boolean;
}

function plan(options: PlanOptions = {}): HyperliquidExecutionPlan {
  const quantityAtoms = options.quantityAtoms ?? 100n;
  const size = formatHypercoreSize(quantityAtoms, baseAsset.decimals, 6);
  const spotOrder = { ...wire(10_007, true, spotClientOrderId, false), s: size };
  const perpetualOrder = { ...wire(3, false, perpetualClientOrderId, false), s: size };
  const slots: Omit<RecoveryActionSlot, 'sequence'>[] = [];
  if (options.includeComplete !== false) {
    slots.push({
      action: 'COMPLETE_PERP', targetLeg: 1, adapter: perpetualAdapter,
      markets: [perpetualMarket], maxQuantity: { asset: baseAsset, atoms: quantityAtoms },
      limitPrice: price(), reduceOnly: false, timeInForce: 'IOC',
    });
  }
  slots.push(
    {
      action: 'ROLLBACK_SPOT', targetLeg: 0, adapter: spotAdapter,
      markets: [spotMarket], maxQuantity: { asset: baseAsset, atoms: quantityAtoms },
      limitPrice: options.rollbackSpotPrice ?? price(590n),
      reduceOnly: false,
      timeInForce: 'IOC',
    },
    {
      action: 'ROLLBACK_PERP', targetLeg: 1, adapter: perpetualAdapter,
      markets: [perpetualMarket],
      maxQuantity: { asset: baseAsset, atoms: options.rollbackPerpMaximum ?? quantityAtoms },
      limitPrice: options.rollbackPerpPrice ?? price(610n),
      reduceOnly: options.rollbackPerpReduceOnly ?? true,
      timeInForce: 'IOC',
    },
  );
  return {
    version: 1,
    guarantee: HYPERCORE_EXECUTION_GUARANTEE,
    domain,
    commitments,
    requestExpiryMs: 1_000n,
    unsignedRequestFields: {
      action: { type: 'order', orders: [spotOrder, perpetualOrder], grouping: 'na' },
      expiresAfter: 1_000,
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
    terminalResidualPolicy: {
      kind: 'EXACT_NET', netSpotDeltaAtoms: quantityAtoms,
      maxTerminalResidualBaseAtoms: 0n, maxTerminalResidualQuoteAtoms: 0n,
    },
    recoveryPolicy: {
      policyVersion: 1,
      controllerId: protocolId('hypercore-recovery-controller-v1'),
      controllerCodeHash,
      authorityModeId: protocolId('agent-wallet-v1'),
      recoveryExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
      maxActionExpiryValue: 1_500n,
      deadlineValue: 2_000n,
      minRecoveryWindowMs: 500n,
      maxRecoveryCostCaps: [{ asset: quoteAsset, maxAtoms: 100n }],
      maxAggregateRecoveryLoss: { asset: quoteAsset, atoms: 1_000n },
      maxIntermediateResidual: { asset: baseAsset, atoms: options.intermediateCap ?? quantityAtoms },
      maxTerminalResidual: { asset: baseAsset, atoms: 0n },
      reconciledStateSchemaHash: manifestHash('51'.repeat(32)),
      actionBuilderCodeHash,
      actionSlots: slots.map((slot, sequence) => ({ ...slot, sequence })),
    },
    recoveryDeadlineMs: 2_000n,
  };
}

function snapshot(
  spotFill: bigint,
  perpetualFill: bigint,
  plannedQuantityAtoms = 100n,
): HyperliquidReconciliationSnapshotInput {
  return {
    source: HYPERCORE_RECONCILIATION_SOURCE,
    domain,
    commitments,
    account,
    evidenceVersion: 7n,
    observedAtMs: nowMs,
    spot: {
      clientOrderId: spotClientOrderId,
      terminalStatus: spotFill === plannedQuantityAtoms ? 'FILLED' : 'PARTIALLY_FILLED_IOC_CANCELLED',
      openOrderStatus: 'NONE',
      filledSignedBaseAtoms: spotFill,
    },
    perpetual: {
      clientOrderId: perpetualClientOrderId,
      terminalStatus: perpetualFill === 0n
        ? 'UNFILLED_IOC_CANCELLED'
        : perpetualFill === -plannedQuantityAtoms ? 'FILLED' : 'PARTIALLY_FILLED_IOC_CANCELLED',
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

function recoveryAttempt(
  spotFill: bigint,
  perpetualFill: bigint,
  options: PlanOptions = {},
): HyperliquidPackageAttempt {
  const quantityAtoms = options.quantityAtoms ?? 100n;
  const initial = beginHyperliquidReconciliation(markHyperliquidSubmissionUnknown(
    createHyperliquidPackageAttempt(plan(options), account),
  ));
  const reconciled = reconcileHyperliquidPackageAttempt(
    initial,
    snapshot(spotFill, perpetualFill, quantityAtoms),
  );
  assert.equal(reconciled.status, 'RECOVERY_REQUIRED');
  return reconciled;
}

function compiler(overrides: Partial<ConstructorParameters<typeof HyperliquidRecoveryCompiler>[0]> = {}) {
  return new HyperliquidRecoveryCompiler({
    environment: 'testnet',
    controllerId: 'hypercore-recovery-controller-v1',
    controllerCodeHash,
    authorityModeId: 'agent-wallet-v1',
    actionBuilderCodeHash,
    ...overrides,
  });
}

function compileInput(attempt: HyperliquidPackageAttempt, overrides: Record<string, unknown> = {}) {
  return {
    attempt,
    nowMs,
    recoverySequence: 0,
    projectedRecoveryCosts: [{ asset: quoteAsset, atoms: 10n }],
    projectedAggregateLoss: { asset: quoteAsset, atoms: 100n },
    ...overrides,
  };
}

test('compiles the signed missing perpetual action and deterministic recovery cloid', () => {
  const attempt = recoveryAttempt(100n, 0n);
  const first = compiler().compile(compileInput(attempt));
  const replay = compiler().compile(compileInput(attempt));

  assert.deepEqual(first, replay);
  assert.equal(first.mode, 'COMPLETE_MISSING_LEG');
  assert.equal(first.orders.length, 1);
  assert.equal(first.orders[0]!.action, 'COMPLETE_PERP');
  assert.equal(first.orders[0]!.signedBaseDeltaAtoms, -100n);
  assert.equal(first.orders[0]!.order.b, false);
  assert.equal(first.orders[0]!.order.r, false);
  assert.equal(first.terminalResidualBaseAtoms, 0n);
  assert.equal(first.unsignedRequestFields.expiresAfter, 1_500);
  assert.match(first.orders[0]!.clientOrderId, /^0x[0-9a-f]{32}$/);
});

test('compiles direction-aware paired rollback when completion is not permitted', () => {
  const result = compiler().compile(compileInput(recoveryAttempt(200n, -100n, {
    includeComplete: false,
    quantityAtoms: 200n,
  })));

  assert.equal(result.mode, 'PAIRED_ROLLBACK');
  assert.deepEqual(result.orders.map((order) => [order.action, order.signedBaseDeltaAtoms,
    order.order.b, order.order.r]), [
    ['ROLLBACK_SPOT', -200n, false, false],
    ['ROLLBACK_PERP', 100n, true, true],
  ]);
  assert.equal(result.terminalResidualBaseAtoms, 0n);
});

test('rejects stale signed recovery timing and wrong runtime identity', () => {
  const attempt = recoveryAttempt(100n, 0n);
  assert.throws(() => compiler().compile(compileInput(attempt, { nowMs: 1_500n })),
    /expiry or deadline is stale/);
  assert.throws(() => compiler({ controllerCodeHash: manifestHash('ff'.repeat(32)) })
    .compile(compileInput(attempt)), /identity mismatch/);
});

test('fails closed on signed price, quantity, residual and cost bounds', async (suite) => {
  await suite.test('buy price cap', () => {
    const attempt = recoveryAttempt(200n, -100n, {
      includeComplete: false,
      quantityAtoms: 200n,
      rollbackPerpPrice: price(600_001n, 1_000n, 'CEIL'),
    });
    assert.throws(() => compiler().compile(compileInput(attempt)), /buy price exceeds signed cap/);
    const sellAttempt = recoveryAttempt(200n, -100n, {
      includeComplete: false,
      quantityAtoms: 200n,
      rollbackSpotPrice: price(600_001n, 1_000n, 'FLOOR'),
    });
    assert.throws(() => compiler().compile(compileInput(sellAttempt)),
      /sell price is below signed minimum/);
  });
  await suite.test('maximum quantity', () => {
    const attempt = recoveryAttempt(200n, -100n, {
      includeComplete: false,
      quantityAtoms: 200n,
      rollbackPerpMaximum: 99n,
    });
    assert.throws(() => compiler().compile(compileInput(attempt)), /quantity exceeds signed maximum/);
  });
  await suite.test('intermediate residual', () => {
    const attempt = recoveryAttempt(200n, -100n, {
      includeComplete: false,
      quantityAtoms: 200n,
      intermediateCap: 99n,
    });
    assert.throws(() => compiler().compile(compileInput(attempt)), /initial recovery residual/);
  });
  await suite.test('recovery cost', () => {
    const attempt = recoveryAttempt(100n, 0n);
    assert.throws(() => compiler().compile(compileInput(attempt, {
      projectedRecoveryCosts: [{ asset: quoteAsset, atoms: 101n }],
    })), /cost exceeds signed cap/);
    assert.throws(() => compiler().compile(compileInput(attempt, {
      projectedAggregateLoss: { asset: quoteAsset, atoms: 1_001n },
    })), /aggregate recovery loss exceeds the available cap/);
  });
});

test('enforces reduce-only policy and refuses position flips at the keeper boundary', () => {
  assert.throws(() => createHyperliquidPackageAttempt(plan({
    includeComplete: false,
    rollbackPerpReduceOnly: false,
  }), account), /rollback-perp reduce-only mismatch/);

  const attempt = recoveryAttempt(200n, -100n, {
    includeComplete: false,
    quantityAtoms: 200n,
  });
  const evidence = attempt.acceptedEvidence!;
  const inconsistent = {
    ...attempt,
    acceptedEvidence: {
      ...evidence,
      observedPerpetualPositionAtoms: -25n,
    },
  } as HyperliquidPackageAttempt;
  assert.throws(() => compiler().compile(compileInput(inconsistent)),
    /obligation does not match accepted evidence|target mismatch|flip/);
});
