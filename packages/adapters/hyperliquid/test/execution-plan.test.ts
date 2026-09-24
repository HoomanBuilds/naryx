import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  assetAmount,
  assetRef,
  domainRef,
  exactPrice,
  hash32,
  manifestHash,
  versionedManifestRef,
  type PackageAdmission,
} from '@naryx/protocol-types';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
  HYPERCORE_IOC_ORDER_ACTION_CLASS_ID,
  HyperliquidExecutionPlanner,
} from '../src/index.js';

const domain = domainRef('hypercore:testnet', 1, '11'.repeat(32));
const baseAsset = assetRef('btc', '22'.repeat(32), 8);
const quoteAsset = assetRef('usdc', '33'.repeat(32), 6);
const spotAdapter = adapterRef({
  adapterId: 'hypercore-spot-v1',
  adapterManifestVersion: 1,
  adapterManifestHash: '44'.repeat(32),
});
const perpAdapter = adapterRef({
  adapterId: 'hypercore-perp-v1',
  adapterManifestVersion: 1,
  adapterManifestHash: '55'.repeat(32),
});
const venue = versionedManifestRef('hypercore', 1, '66'.repeat(32));
const spotMarket = versionedManifestRef('btc-usdc-spot', 1, '77'.repeat(32));
const perpMarket = versionedManifestRef('btc-usdc-perp', 1, '88'.repeat(32));
const orderHash = hash32('91'.repeat(32));
const quoteHash = hash32('92'.repeat(32));
const routeHash = hash32('93'.repeat(32));
const templateHash = manifestHash('94'.repeat(32));

function price(quoteAtoms: bigint) {
  return exactPrice({
    baseAsset,
    quoteAsset,
    quoteAtoms,
    baseAtoms: 1n,
    roundingDirection: 'CEIL',
  });
}

function planner(): HyperliquidExecutionPlanner {
  return new HyperliquidExecutionPlanner({
    environment: 'testnet',
    seriesIdentity: {
      domain,
      seriesManifestHash: 'a1'.repeat(32),
      executionClassManifestHash: 'a2'.repeat(32),
    },
    spot: {
      adapter: spotAdapter,
      venue,
      market: spotMarket,
      assetId: 10_007,
      sizeDecimals: 5,
    },
    perpetual: {
      adapter: perpAdapter,
      venue,
      market: perpMarket,
      assetId: 3,
      sizeDecimals: 5,
    },
  });
}

interface AdmissionOptions {
  readonly action?: 'ENTRY' | 'EXIT';
  readonly quantityPolicy?: 'EXACT_NET' | 'BOUNDED_NET';
  readonly grossSpotAtoms?: bigint;
  readonly quantityAtoms?: bigint;
  readonly minNetSpotAtoms?: bigint;
  readonly maxNetSpotAtoms?: bigint;
  readonly terminalBaseCapAtoms?: bigint;
  readonly terminalQuoteCapAtoms?: bigint;
  readonly residualValuationPrice?: ReturnType<typeof price>;
  readonly quoteIdentity?: Uint8Array;
  readonly perpetualLimit?: ReturnType<typeof price>;
}

function admission(options: AdmissionOptions = {}): PackageAdmission {
  const action = options.action ?? 'ENTRY';
  const quantityPolicy = options.quantityPolicy ?? 'EXACT_NET';
  const grossSpotAtoms = options.grossSpotAtoms ?? 10_000n;
  const quantityAtoms = options.quantityAtoms ?? 10_000n;
  const perpetualLimit = options.perpetualLimit ?? price(action === 'ENTRY' ? 600n : 610n);
  const spotLimit = price(action === 'ENTRY' ? 600n : 590n);
  const expectedNetSpot = action === 'ENTRY' ? grossSpotAtoms : -grossSpotAtoms;
  const minNetSpot = quantityPolicy === 'EXACT_NET'
    ? expectedNetSpot
    : options.minNetSpotAtoms ?? expectedNetSpot;
  const maxNetSpot = quantityPolicy === 'EXACT_NET'
    ? expectedNetSpot
    : options.maxNetSpotAtoms ?? expectedNetSpot + 100n;
  const terminalBaseCap = quantityPolicy === 'EXACT_NET' ? 0n : options.terminalBaseCapAtoms ?? 100n;
  const terminalQuoteCap = quantityPolicy === 'EXACT_NET' ? 0n : options.terminalQuoteCapAtoms ?? 60_000n;
  const prePosition = action === 'ENTRY' ? 0n : -20_000n;
  const recoveryDeadline = 1_100n;
  const quoteIdentity = options.quoteIdentity ?? quoteHash;
  const actions = [spotAdapter, perpAdapter].map((adapter, index) => ({
    sequence: index,
    actionClassId: HYPERCORE_IOC_ORDER_ACTION_CLASS_ID,
    legIndex: index,
    adapter,
    targetBindingId: 'hypercore-exchange',
    authorityBindingId: 'api-wallet',
    accountMetas: [],
    payload: {
      codecId: 'hypercore-order-wire-v1',
      templateLength: 1,
      templateHash: hash32(`${index + 1}`.repeat(64)),
      lateBoundFields: [],
    },
  }));
  const legs = [
    {
      legIndex: 0,
      legRole: 'SPOT',
      actionSequence: 0,
      adapter: spotAdapter,
      venue,
      market: spotMarket,
      baseAsset,
      quoteAsset,
      side: action === 'ENTRY' ? 'BUY' : 'SELL',
      quantity: assetAmount(baseAsset, grossSpotAtoms),
      limitPrice: spotLimit,
      timeInForce: 'IOC',
      reduceOnly: false,
    },
    {
      legIndex: 1,
      legRole: 'PERPETUAL',
      actionSequence: 1,
      adapter: perpAdapter,
      venue,
      market: perpMarket,
      baseAsset,
      quoteAsset,
      side: action === 'ENTRY' ? 'SELL' : 'BUY',
      quantity: assetAmount(baseAsset, quantityAtoms),
      limitPrice: perpetualLimit,
      timeInForce: 'IOC',
      reduceOnly: action === 'EXIT',
    },
  ];
  return {
    order: {
      environment: 'testnet',
      domain,
      templateId: 'cash-and-carry-v1',
      templateVersion: 1,
      packageTemplateManifestHash: templateHash,
      direction: 'LONG_SPOT_SHORT_PERP',
      action,
      settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
      packageTimeInForce: 'IOC',
      partialFillPolicy: 'EXACT_ALL_LEGS',
      expiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
      expiryValue: 1_000n,
      quantity: assetAmount(baseAsset, quantityAtoms),
      hyperliquidQuantityPolicy: quantityPolicy,
      hyperliquidGrossSpotQuantity: assetAmount(baseAsset, grossSpotAtoms),
      hyperliquidMinNetSpotDelta: assetAmount(baseAsset, minNetSpot),
      hyperliquidMaxNetSpotDelta: assetAmount(baseAsset, maxNetSpot),
      hyperliquidMaxTerminalResidualBaseQuantity: assetAmount(baseAsset, terminalBaseCap),
      ...(quantityPolicy === 'BOUNDED_NET'
        ? {
            hyperliquidResidualValuationSchemaVersion: 1,
            hyperliquidResidualValuationReferencePrice: options.residualValuationPrice ?? price(600n),
          }
        : {}),
      hyperliquidMaxTerminalResidualQuoteValue: assetAmount(quoteAsset, terminalQuoteCap),
      hyperliquidRecoveryDeadlineValue: recoveryDeadline,
      expectedPrePositionSize: assetAmount(baseAsset, prePosition),
      ...(action === 'ENTRY'
        ? {
            hyperliquidMinPerpSellPrice: perpetualLimit,
            maxSpotQuoteIn: assetAmount(quoteAsset, 6_000_000n),
          }
        : {
            hyperliquidMaxPerpBuyPrice: perpetualLimit,
            minSpotQuoteOut: assetAmount(quoteAsset, 5_000_000n),
          }),
    },
    quote: {
      environment: 'testnet',
      domain,
      orderHash,
      routeHash,
      validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
      validUntilValue: 980n,
      expectedTerminalResidualBaseQuantity: assetAmount(baseAsset, terminalBaseCap),
      expectedTerminalResidualQuoteValue: assetAmount(quoteAsset, terminalQuoteCap),
    },
    route: {
      environment: 'testnet',
      domain,
      orderHash,
      templateId: 'cash-and-carry-v1',
      templateVersion: 1,
      direction: 'LONG_SPOT_SHORT_PERP',
      action,
      quantityPolicyClass: quantityPolicy,
      partialFillPolicy: 'EXACT_ALL_LEGS',
      settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
      executionPlanKind: 'HYPERCORE_BATCHED_IOC',
      routeExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
      routeExpiryValue: 950n,
      legs,
      actions,
      recoveryPlan: {
        policyVersion: 1,
        controllerId: 'hypercore-recovery-controller-v1',
        controllerCodeHash: 'b1'.repeat(32),
        authorityModeId: 'agent-wallet-v1',
        recoveryExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
        maxActionExpiryValue: 1_050n,
        maxTerminalResidual: assetAmount(baseAsset, terminalBaseCap),
        deadlineValue: recoveryDeadline,
        minRecoveryWindowMs: 50n,
        maxRecoveryCostCaps: [{ asset: quoteAsset, maxAtoms: 100_000n }],
        maxAggregateRecoveryLoss: { asset: quoteAsset, atoms: 500_000n },
        maxIntermediateResidual: { asset: baseAsset, atoms: quantityAtoms },
        reconciledStateSchemaHash: 'b2'.repeat(32),
        actionBuilderCodeHash: 'b3'.repeat(32),
        actionSlots: [
          {
            sequence: 0,
            action: 'COMPLETE_SPOT',
            targetLeg: 0,
            adapter: spotAdapter,
            markets: [spotMarket],
            maxQuantity: { asset: baseAsset, atoms: grossSpotAtoms },
            limitPrice: spotLimit,
            reduceOnly: false,
            timeInForce: 'IOC',
          },
          {
            sequence: 1,
            action: 'COMPLETE_PERP',
            targetLeg: 1,
            adapter: perpAdapter,
            markets: [perpMarket],
            maxQuantity: { asset: baseAsset, atoms: quantityAtoms },
            limitPrice: perpetualLimit,
            reduceOnly: action === 'EXIT',
            timeInForce: 'IOC',
          },
          {
            sequence: 2,
            action: 'ROLLBACK_SPOT',
            targetLeg: 0,
            adapter: spotAdapter,
            markets: [spotMarket],
            maxQuantity: { asset: baseAsset, atoms: grossSpotAtoms },
            limitPrice: price(action === 'ENTRY' ? 590n : 610n),
            reduceOnly: false,
            timeInForce: 'IOC',
          },
          {
            sequence: 3,
            action: 'ROLLBACK_PERP',
            targetLeg: 1,
            adapter: perpAdapter,
            markets: [perpMarket],
            maxQuantity: { asset: baseAsset, atoms: quantityAtoms },
            limitPrice: price(action === 'ENTRY' ? 610n : 590n),
            reduceOnly: action === 'ENTRY',
            timeInForce: 'IOC',
          },
        ],
      },
    },
    orderHash,
    quoteHash: quoteIdentity,
    routeHash,
  } as unknown as PackageAdmission;
}

test('compiles one deterministic official-shape batch with separate IOC orders', () => {
  const compiler = planner();
  const first = compiler.compile(admission());
  const second = compiler.compile(admission());

  assert.deepEqual(first, second);
  assert.equal(first.guarantee, HYPERCORE_EXECUTION_GUARANTEE);
  assert.equal(first.requestExpiryMs, 950n);
  assert.equal(first.unsignedRequestFields.expiresAfter, 950);
  assert.deepEqual(first.unsignedRequestFields.action, {
    type: 'order',
    orders: first.legs.map((leg) => leg.order),
    grouping: 'na',
  });
  assert.deepEqual(first.legs.map((leg) => leg.role), ['SPOT', 'PERPETUAL']);
  assert.deepEqual(first.legs.map((leg) => leg.order.t), [
    { limit: { tif: 'Ioc' } },
    { limit: { tif: 'Ioc' } },
  ]);
  assert.deepEqual(first.legs.map((leg) => [leg.order.p, leg.order.s]), [
    ['60000', '0.0001'],
    ['60000', '0.0001'],
  ]);
  assert.match(first.legs[0].clientOrderId, /^0x[0-9a-f]{32}$/);
  assert.match(first.legs[1].clientOrderId, /^0x[0-9a-f]{32}$/);
  assert.notEqual(first.legs[0].clientOrderId, first.legs[1].clientOrderId);
  assert.equal(first.legs[0].market.subjectId, 'btc-usdc-spot');
  assert.equal(first.legs[1].adapter.adapterId, 'hypercore-perp-v1');
  assert.equal(first.signedPerpDeltaAtoms, -10_000n);
  assert.equal(first.signedPerpTargetAtoms, -10_000n);
  assert.equal(first.recoveryPolicy.controllerId, 'hypercore-recovery-controller-v1');
  assert.equal(first.recoveryPolicy.actionBuilderCodeHash[0], 0xb3);
  assert.deepEqual(first.recoveryPolicy.actionSlots.map((slot) => slot.action), [
    'COMPLETE_SPOT', 'COMPLETE_PERP', 'ROLLBACK_SPOT', 'ROLLBACK_PERP',
  ]);
  assert.deepEqual(first.terminalResidualPolicy, {
    kind: 'EXACT_NET',
    netSpotDeltaAtoms: 10_000n,
    maxTerminalResidualBaseAtoms: 0n,
    maxTerminalResidualQuoteAtoms: 0n,
  });
});

test('keeps gross spot size independent and exposes bounded terminal residuals', () => {
  const plan = planner().compile(admission({
    action: 'EXIT',
    quantityPolicy: 'BOUNDED_NET',
    grossSpotAtoms: 9_000n,
    quantityAtoms: 10_000n,
    terminalBaseCapAtoms: 1_100n,
    terminalQuoteCapAtoms: 660_000n,
  }));

  assert.equal(plan.grossSpotQuantityAtoms, 9_000n);
  assert.equal(plan.legs[0].signedBaseDeltaAtoms, -9_000n);
  assert.equal(plan.signedPerpDeltaAtoms, 10_000n);
  assert.equal(plan.prePerpPositionAtoms, -20_000n);
  assert.equal(plan.signedPerpTargetAtoms, -10_000n);
  assert.equal(plan.legs[0].order.s, '0.00009');
  assert.equal(plan.legs[1].order.r, true);
  assert.deepEqual(plan.terminalResidualPolicy, {
    kind: 'BOUNDED_NET',
    minNetSpotDeltaAtoms: -9_000n,
    maxNetSpotDeltaAtoms: -8_900n,
    maxTerminalResidualBaseAtoms: 1_100n,
    residualValuationSchemaVersion: 1,
    residualValuationReferencePrice: price(600n),
    maxTerminalResidualQuoteAtoms: 660_000n,
  });
});

test('rejects either bounded endpoint above the signed residual base cap', () => {
  for (const [endpoint, options] of [
    ['min', { minNetSpotAtoms: 9_899n }],
    ['max', { maxNetSpotAtoms: 10_101n }],
  ] as const) {
    assert.throws(
      () => planner().compile(admission({ quantityPolicy: 'BOUNDED_NET', ...options })),
      new RegExp(`BOUNDED_NET ${endpoint} endpoint exceeds residual base cap`),
    );
  }
});

test('values bounded residuals at the exact price and rounds quote exposure upward', () => {
  const fractionalPrice = exactPrice({
    baseAsset,
    quoteAsset,
    quoteAtoms: 601n,
    baseAtoms: 2n,
    roundingDirection: 'FLOOR',
  });
  for (const [endpoint, interval] of [
    ['min', { minNetSpotAtoms: 9_901n, maxNetSpotAtoms: 10_000n }],
    ['max', { minNetSpotAtoms: 10_000n, maxNetSpotAtoms: 10_099n }],
  ] as const) {
    const bounded = {
      quantityPolicy: 'BOUNDED_NET' as const,
      residualValuationPrice: fractionalPrice,
      ...interval,
    };
    assert.equal(
      planner().compile(admission({ ...bounded, terminalQuoteCapAtoms: 29_750n }))
        .terminalResidualPolicy.maxTerminalResidualQuoteAtoms,
      29_750n,
    );
    assert.throws(
      () => planner().compile(admission({ ...bounded, terminalQuoteCapAtoms: 29_749n })),
      new RegExp(`BOUNDED_NET ${endpoint} endpoint exceeds residual quote cap`),
    );
  }
});

test('binds client order IDs to the exact quote commitment', () => {
  const compiler = planner();
  const first = compiler.compile(admission());
  const second = compiler.compile(admission({ quoteIdentity: hash32('f1'.repeat(32)) }));

  assert.notEqual(first.legs[0].clientOrderId, second.legs[0].clientOrderId);
  assert.notEqual(first.legs[1].clientOrderId, second.legs[1].clientOrderId);
});

test('rejects quantities that cannot be represented without integer rounding', () => {
  assert.throws(
    () => planner().compile(admission({ quantityAtoms: 10_001n })),
    /order size is not aligned to HyperCore size decimals/,
  );
});

test('rejects a route limit that differs from the signed perpetual limit', () => {
  const value = admission();
  const changed = {
    ...value,
    route: {
      ...value.route,
      legs: value.route.legs.map((leg) => leg.legRole === 'PERPETUAL'
        ? { ...leg, limitPrice: price(601n) }
        : leg),
    },
  } as PackageAdmission;

  assert.throws(
    () => planner().compile(changed),
    /route perpetual limit does not equal the signed order limit/,
  );
});
