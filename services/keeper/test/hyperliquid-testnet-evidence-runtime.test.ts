import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type {
  ClearinghouseStateResponse,
  MetaResponse,
  OpenOrdersResponse,
  OrderStatusResponse,
  SpotClearinghouseStateResponse,
  SpotMetaResponse,
  UserFillsByTimeResponse,
  UserRoleResponse,
} from '@nktkas/hyperliquid/api/info';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
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
} from '@naryx/protocol-types';
import {
  HYPERLIQUID_TESTNET_INFO_URL,
  HyperliquidAuthoritativeEvidenceCollector,
  HYPERLIQUID_TESTNET_EVIDENCE_RECONCILIATION_COLLECTOR,
  HyperliquidTestnetEvidenceRuntime,
  NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME,
  type HyperliquidEvidenceMarketBinding,
  type HyperliquidEvidenceWindow,
  type HyperliquidInfoEnvelope,
  type HyperliquidInfoRequestIdentity,
  type HyperliquidTestnetEvidenceRuntimeState,
  type HyperliquidTestnetSubmissionHandoff,
} from '../src/index.js';

const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'12'.repeat(20)}` as const;
const spotCloid = `0x${'21'.repeat(16)}` as const;
const perpCloid = `0x${'22'.repeat(16)}` as const;
const account = { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' as const };
const binding: HyperliquidEvidenceMarketBinding = {
  spotUniverseIndex: 7,
  spotTokenIndex: 1,
  perpetualAssetIndex: 3,
  quoteTokenIndex: 0,
};
const checkpointWindow: HyperliquidEvidenceWindow = {
  startTimeMs: 900, endTimeMs: 1_000, nowMs: 1_000,
  maxEvidenceAgeMs: 500, maxSnapshotSkewMs: 100,
};
const evidenceWindow: HyperliquidEvidenceWindow = {
  startTimeMs: 1_000, endTimeMs: 10_000, nowMs: 10_000,
  maxEvidenceAgeMs: 9_000, maxSnapshotSkewMs: 100,
};

const domain = domainRef('hypercore:testnet', 1, '41'.repeat(32));
const baseAsset = assetRef('ubtc', '31'.repeat(32), 8);
const quoteAsset = assetRef('usdc', '32'.repeat(32), 8);
const spotAdapter = adapterRef({
  adapterId: 'hypercore-spot-v1', adapterManifestVersion: 1, adapterManifestHash: '71'.repeat(32),
});
const perpAdapter = adapterRef({
  adapterId: 'hypercore-perp-v1', adapterManifestVersion: 1, adapterManifestHash: '72'.repeat(32),
});
const venue = versionedManifestRef('hypercore', 1, '73'.repeat(32));
const spotMarket = versionedManifestRef('btc-usdc-spot', 1, '74'.repeat(32));
const perpMarket = versionedManifestRef('btc-usdc-perp', 1, '75'.repeat(32));
const limitPrice = exactPrice({
  baseAsset, quoteAsset, baseAtoms: 1n, quoteAtoms: 600n, roundingDirection: 'CEIL',
});

function wire(clientOrderId: `0x${string}`, asset: number, isBuy: boolean): HypercoreOrderWire {
  return {
    a: asset, b: isBuy, p: '60000', s: '0.000001', r: false,
    t: { limit: { tif: 'Ioc' } }, c: clientOrderId,
  };
}

function executionPlan(): HyperliquidExecutionPlan {
  const spotOrder = wire(spotCloid, 10_007, true);
  const perpOrder = wire(perpCloid, 3, false);
  return {
    version: 1,
    guarantee: HYPERCORE_EXECUTION_GUARANTEE,
    domain,
    commitments: {
      seriesManifestHash: manifestHash('42'.repeat(32)),
      executionClassManifestHash: manifestHash('43'.repeat(32)),
      orderHash: hash32('44'.repeat(32)),
      quoteHash: hash32('45'.repeat(32)),
      routeHash: hash32('46'.repeat(32)),
    },
    requestExpiryMs: 5_000n,
    unsignedRequestFields: {
      action: { type: 'order', orders: [spotOrder, perpOrder], grouping: 'na' },
      expiresAfter: 5_000,
    },
    legs: [
      {
        role: 'SPOT', legIndex: 0, adapter: spotAdapter, venue, market: spotMarket,
        baseAsset, quoteAsset, side: 'BUY', quantityAtoms: 100n,
        sizeDecimals: 8, maxPriceDecimals: 0, signedBaseDeltaAtoms: 100n,
        clientOrderId: spotCloid, order: spotOrder,
      },
      {
        role: 'PERPETUAL', legIndex: 1, adapter: perpAdapter, venue, market: perpMarket,
        baseAsset, quoteAsset, side: 'SELL', quantityAtoms: 100n,
        sizeDecimals: 6, maxPriceDecimals: 0, signedBaseDeltaAtoms: -100n,
        clientOrderId: perpCloid, order: perpOrder,
      },
    ],
    grossSpotQuantityAtoms: 100n,
    prePerpPositionAtoms: 0n,
    signedPerpDeltaAtoms: -100n,
    signedPerpTargetAtoms: -100n,
    terminalResidualPolicy: {
      kind: 'EXACT_NET', netSpotDeltaAtoms: 100n,
      maxTerminalResidualBaseAtoms: 0n, maxTerminalResidualQuoteAtoms: 0n,
    },
    recoveryPolicy: {
      policyVersion: 1,
      controllerId: protocolId('hypercore-recovery-controller-v1'),
      controllerCodeHash: manifestHash('76'.repeat(32)),
      authorityModeId: protocolId('agent-wallet-v1'),
      recoveryExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
      maxActionExpiryValue: 15_000n,
      deadlineValue: 20_000n,
      minRecoveryWindowMs: 500n,
      maxRecoveryCostCaps: [{ asset: quoteAsset, maxAtoms: 100n }],
      maxAggregateRecoveryLoss: { asset: quoteAsset, atoms: 1_000n },
      maxIntermediateResidual: { asset: baseAsset, atoms: 100n },
      maxTerminalResidual: { asset: baseAsset, atoms: 0n },
      reconciledStateSchemaHash: manifestHash('77'.repeat(32)),
      actionBuilderCodeHash: manifestHash('78'.repeat(32)),
      actionSlots: [
        {
          sequence: 0, action: 'COMPLETE_PERP', targetLeg: 1,
          adapter: perpAdapter, markets: [perpMarket],
          maxQuantity: { asset: baseAsset, atoms: 100n },
          limitPrice, reduceOnly: false, timeInForce: 'IOC',
        },
      ],
    },
    recoveryDeadlineMs: 20_000n,
  };
}

function orderStatus(
  cloid: `0x${string}`,
  oid: number,
  coin: string,
  side: 'A' | 'B',
  status: 'filled' | 'canceled' = 'filled',
): OrderStatusResponse {
  return {
    status: 'order',
    order: {
      status,
      statusTimestamp: 5_100,
      order: {
        coin, side, limitPx: '60000', sz: status === 'filled' ? '0.000001' : '0.0000005',
        oid, timestamp: 4_000, origSz: '0.000001', triggerCondition: 'N/A',
        isTrigger: false, triggerPx: '0', children: [], isPositionTpsl: false,
        reduceOnly: false, orderType: 'Limit', tif: 'Ioc', cloid,
      },
    },
  } as OrderStatusResponse;
}

function fill(
  cloid: `0x${string}`,
  oid: number,
  tid: number,
  coin: string,
  side: 'A' | 'B',
): UserFillsByTimeResponse[number] {
  return {
    cloid, coin, px: '60000.25', sz: '0.000001', side, time: 5_000,
    startPosition: '0', dir: side === 'B' ? 'Buy' : 'Sell', closedPnl: '0',
    hash: `0x${'51'.repeat(32)}`, oid, crossed: true, fee: '0.00000001',
    tid, feeToken: 'USDC', twapId: null,
  };
}

class FixtureClient {
  readonly environment = 'testnet' as const;
  readonly apiUrl = HYPERLIQUID_TESTNET_INFO_URL;
  stamp = 1_000;
  spotTotal = '1';
  perpetualSize = '0';
  fills: UserFillsByTimeResponse = [];
  open: OpenOrdersResponse = [];
  role: UserRoleResponse = { role: 'subAccount', data: { master: masterAccount } };
  readonly statuses = new Map<string, OrderStatusResponse>();

  #envelope<T>(request: HyperliquidInfoRequestIdentity, payload: T): HyperliquidInfoEnvelope<T> {
    return {
      environment: 'testnet', apiUrl: HYPERLIQUID_TESTNET_INFO_URL, request,
      requestedAtMs: this.stamp - 1, receivedAtMs: this.stamp, payload,
    };
  }

  userRole(user: `0x${string}`): Promise<HyperliquidInfoEnvelope<UserRoleResponse>> {
    return Promise.resolve(this.#envelope({ operation: 'userRole', user }, this.role));
  }

  spotMeta(): Promise<HyperliquidInfoEnvelope<SpotMetaResponse>> {
    const payload: SpotMetaResponse = {
      universe: [{ tokens: [1, 0], name: '@7', index: 7, isCanonical: true }],
      tokens: [
        { name: 'USDC', szDecimals: 8, weiDecimals: 8, index: 0,
          tokenId: `0x${'01'.repeat(16)}`, isCanonical: true, evmContract: null,
          fullName: 'USD Coin', deployerTradingFeeShare: '0' },
        { name: 'UBTC', szDecimals: 8, weiDecimals: 8, index: 1,
          tokenId: `0x${'02'.repeat(16)}`, isCanonical: true, evmContract: null,
          fullName: 'Bitcoin', deployerTradingFeeShare: '0' },
      ],
    };
    return Promise.resolve(this.#envelope({ operation: 'spotMeta' }, payload));
  }

  meta(): Promise<HyperliquidInfoEnvelope<MetaResponse>> {
    const universe = ['ETH', 'SOL', 'HYPE', 'BTC'].map((name) => ({
      name, szDecimals: 6, maxLeverage: 50, marginTableId: 1,
    }));
    return Promise.resolve(this.#envelope({ operation: 'meta' }, {
      universe, marginTables: [], collateralToken: 0,
    }));
  }

  spotClearinghouseState(user: `0x${string}`):
    Promise<HyperliquidInfoEnvelope<SpotClearinghouseStateResponse>> {
    const payload = { balances: [{
      coin: 'UBTC', token: 1, total: this.spotTotal, hold: '0', entryNtl: '0',
    }] } as SpotClearinghouseStateResponse;
    return Promise.resolve(this.#envelope({ operation: 'spotClearinghouseState', user }, payload));
  }

  clearinghouseState(user: `0x${string}`):
    Promise<HyperliquidInfoEnvelope<ClearinghouseStateResponse>> {
    const position = {
      coin: 'BTC', szi: this.perpetualSize, leverage: { type: 'cross' as const, value: 1 },
      entryPx: '60000', positionValue: '0', unrealizedPnl: '0', returnOnEquity: '0',
      liquidationPx: null, marginUsed: '0', maxLeverage: 50,
      cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' },
    };
    const summary = { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0' };
    const payload = {
      marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: '0',
      withdrawable: '100', assetPositions: this.perpetualSize === '0'
        ? [] : [{ type: 'oneWay' as const, position }], time: this.stamp,
    } as ClearinghouseStateResponse;
    return Promise.resolve(this.#envelope({ operation: 'clearinghouseState', user }, payload));
  }

  openOrders(user: `0x${string}`): Promise<HyperliquidInfoEnvelope<OpenOrdersResponse>> {
    return Promise.resolve(this.#envelope({ operation: 'openOrders', user }, this.open));
  }

  orderStatus(user: `0x${string}`, cloid: `0x${string}`):
    Promise<HyperliquidInfoEnvelope<OrderStatusResponse>> {
    const payload = this.statuses.get(cloid) ?? { status: 'unknownOid' as const };
    return Promise.resolve(this.#envelope({ operation: 'orderStatus', user, cloid }, payload));
  }

  userFillsByTime(user: `0x${string}`, startTimeMs: number, endTimeMs: number):
    Promise<HyperliquidInfoEnvelope<UserFillsByTimeResponse>> {
    return Promise.resolve(this.#envelope(
      { operation: 'userFillsByTime', user, startTimeMs, endTimeMs }, this.fills,
    ));
  }
}

class CountingCollector extends HyperliquidAuthoritativeEvidenceCollector {
  collectCalls = 0;
  captureCalls = 0;

  override captureCheckpoint(
    ...args: Parameters<HyperliquidAuthoritativeEvidenceCollector['captureCheckpoint']>
  ): ReturnType<HyperliquidAuthoritativeEvidenceCollector['captureCheckpoint']> {
    this.captureCalls += 1;
    return super.captureCheckpoint(...args);
  }

  override collectPackage(
    ...args: Parameters<HyperliquidAuthoritativeEvidenceCollector['collectPackage']>
  ): ReturnType<HyperliquidAuthoritativeEvidenceCollector['collectPackage']> {
    this.collectCalls += 1;
    return super.collectPackage(...args);
  }
}

const PREPARED_ATTEMPT_ID = 'attempt-1';

function expectedActionHash(plan: HyperliquidExecutionPlan): `0x${string}` {
  const action = plan.unsignedRequestFields.action;
  return `0x${createHash('sha256').update(JSON.stringify([
    NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME,
    action.type,
    action.orders.map((order) => [
      order.a, order.b, order.p, order.s, order.r, order.t.limit.tif, order.c.toLowerCase(),
    ]),
    action.grouping,
  ])).digest('hex')}` as `0x${string}`;
}

function differentActionHash(valid: `0x${string}`): `0x${string}` {
  const last = valid.slice(-1);
  const replacement = last === '0' ? '1' : '0';
  return `${valid.slice(0, -1)}${replacement}` as `0x${string}`;
}

function handoff(attemptId: string, actionHash: `0x${string}`): HyperliquidTestnetSubmissionHandoff {
  return {
    collector: HYPERLIQUID_TESTNET_EVIDENCE_RECONCILIATION_COLLECTOR,
    attemptId,
    account,
    actionHash,
    actionCommitmentScheme: NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME,
    requestCommitment: `0x${'bb'.repeat(32)}`,
    durableRevision: 'rev-1',
    spotClientOrderId: spotCloid,
    perpetualClientOrderId: perpCloid,
  };
}

function configureExact(client: FixtureClient): void {
  client.statuses.set(spotCloid, orderStatus(spotCloid, 1, '@7', 'B'));
  client.statuses.set(perpCloid, orderStatus(perpCloid, 2, 'BTC', 'A'));
  client.fills = [fill(spotCloid, 1, 10, '@7', 'B'), fill(perpCloid, 2, 10, 'BTC', 'A')];
  client.spotTotal = '1.000001';
  client.perpetualSize = '-0.000001';
}

async function preparedState(
  attemptId: string = PREPARED_ATTEMPT_ID,
): Promise<{
  client: FixtureClient;
  collector: CountingCollector;
  state: HyperliquidTestnetEvidenceRuntimeState;
}> {
  const client = new FixtureClient();
  const collector = new CountingCollector(client);
  const runtime = new HyperliquidTestnetEvidenceRuntime(collector);
  const plan = executionPlan();
  const result = await runtime.prepare({
    attemptId, plan, account, binding, window: checkpointWindow,
  });
  assert.equal(result.status, 'PREPARED');
  assert.equal(result.state.attempt.status, 'PLANNED');
  assert.equal(result.state.attemptId, attemptId);
  assert.equal(result.state.actionHash, expectedActionHash(plan));
  return { client, collector, state: result.state };
}

test('checkpoint to validated handoff to complete evidence reaches a terminal reducer result', async () => {
  const { client, collector, state } = await preparedState();
  assert.equal(collector.captureCalls, 1);
  assert.equal(collector.collectCalls, 0);
  assert.notEqual(state.actionHash, `0x${'aa'.repeat(32)}`);
  client.stamp = 9_950;
  configureExact(client);
  const runtime = new HyperliquidTestnetEvidenceRuntime(collector);
  const result = await runtime.reconcile(
    state, handoff(state.attemptId, state.actionHash), binding, evidenceWindow,
  );
  assert.equal(collector.collectCalls, 1);
  assert.equal(result.status, 'RECONCILED');
  assert.equal(result.attempt.status, 'COMPLETED_EXACT');
  assert.equal(result.attempt.acceptedEvidence?.netSpotDeltaAtoms, 100n);
  assert.equal(result.accountObservation.netSpotBalanceDeltaAtoms, 100n);
  assert.equal(result.accountObservation.perpetualPositionDeltaAtoms, -100n);
  assert.equal(result.observedFills.length, 2);
  assert.equal(result.observedFills[0]?.signedBaseAtoms, 100n);
  assert.equal(result.observedFills[1]?.signedBaseAtoms, -100n);
  assert.ok(result.rawResponseCommitments.length > 0);
});

test('incomplete checkpoint evidence is preserved fail closed', async () => {
  const client = new FixtureClient();
  client.role = { role: 'subAccount', data: { master: `0x${'99'.repeat(20)}` } };
  const runtime = new HyperliquidTestnetEvidenceRuntime(
    new HyperliquidAuthoritativeEvidenceCollector(client),
  );
  const result = await runtime.prepare({
    attemptId: PREPARED_ATTEMPT_ID, plan: executionPlan(), account, binding, window: checkpointWindow,
  });
  assert.equal(result.status, 'CHECKPOINT_INCOMPLETE');
  assert.ok(result.reasons.includes('ACCOUNT_IDENTITY_MISMATCH'));
  assert.ok(result.rawResponseCommitments.length > 0);
});

test('handoff and binding mismatch rejects before any evidence read', async () => {
  const cases: ReadonlyArray<readonly [
    string,
    (valid: HyperliquidTestnetSubmissionHandoff) => HyperliquidTestnetSubmissionHandoff,
    HyperliquidEvidenceMarketBinding,
    string,
  ]> = [
    ['collector', (valid) => ({ ...valid, collector: 'WRONG_COLLECTOR' as never }), binding, 'UNKNOWN_COLLECTOR'],
    ['scheme', (valid) => ({ ...valid, actionCommitmentScheme: 'WRONG_SCHEME' as never }), binding, 'UNSUPPORTED_COMMITMENT_SCHEME'],
    ['attempt id', (valid) => ({ ...valid, attemptId: 'bad id!' }), binding, 'INVALID_ATTEMPT_ID'],
    ['attempt id mismatch', (valid) => ({ ...valid, attemptId: 'attempt-2' }), binding, 'ATTEMPT_ID_MISMATCH'],
    ['durable revision', (valid) => ({ ...valid, durableRevision: '' }), binding, 'INVALID_DURABLE_REVISION'],
    ['action hash', (valid) => ({ ...valid, actionHash: '0x123' as `0x${string}` }), binding, 'INVALID_ACTION_HASH'],
    ['action hash mismatch', (valid) => ({
      ...valid, actionHash: differentActionHash(valid.actionHash),
    }), binding, 'ACTION_HASH_MISMATCH'],
    ['request commitment', (valid) => ({ ...valid, requestCommitment: '0xZZ' as `0x${string}` }), binding, 'INVALID_REQUEST_COMMITMENT'],
    ['account', (valid) => ({
      ...valid,
      account: { ...account, tradingAccount: `0x${'99'.repeat(20)}` as `0x${string}` },
    }), binding, 'ACCOUNT_MISMATCH'],
    ['client order id', (valid) => ({
      ...valid, spotClientOrderId: `0x${'99'.repeat(16)}` as `0x${string}`,
    }), binding, 'CLIENT_ORDER_ID_MISMATCH'],
    ['binding', (valid) => valid, { ...binding, perpetualAssetIndex: 9 }, 'MARKET_BINDING_MISMATCH'],
  ];
  for (const [name, tamper, tamperedBinding, expectedReason] of cases) {
    const { collector, state } = await preparedState();
    const runtime = new HyperliquidTestnetEvidenceRuntime(collector);
    const result = await runtime.reconcile(
      state, tamper(handoff(state.attemptId, state.actionHash)), tamperedBinding, evidenceWindow,
    );
    assert.equal(result.status, 'HANDOFF_REJECTED', name);
    if (result.status === 'HANDOFF_REJECTED') {
      assert.equal(result.reason, expectedReason, name);
    }
    assert.equal(collector.collectCalls, 0, name);
  }
});

test('malformed preparation attempt ID rejects before any checkpoint read', async () => {
  const client = new FixtureClient();
  const collector = new CountingCollector(client);
  const runtime = new HyperliquidTestnetEvidenceRuntime(collector);
  await assert.rejects(() => runtime.prepare({
    attemptId: 'bad id!', plan: executionPlan(), account, binding, window: checkpointWindow,
  }));
  assert.equal(collector.captureCalls, 0);
  assert.equal(collector.collectCalls, 0);
});

test('incomplete post-submission evidence keeps reconciling with preserved reasons', async () => {
  const { client, collector, state } = await preparedState();
  client.stamp = 9_950;
  configureExact(client);
  const duplicateStatus = orderStatus(spotCloid, 1, '@7', 'B');
  const duplicate = duplicateStatus.status === 'order' ? duplicateStatus.order.order : undefined;
  assert.ok(duplicate !== undefined);
  client.open = [duplicate, duplicate] as unknown as OpenOrdersResponse;
  const runtime = new HyperliquidTestnetEvidenceRuntime(collector);
  const result = await runtime.reconcile(
    state, handoff(state.attemptId, state.actionHash), binding, evidenceWindow,
  );
  assert.equal(result.status, 'EVIDENCE_INCOMPLETE');
  assert.equal(result.attempt.status, 'RECONCILING');
  assert.ok(result.reasons.includes('AMBIGUOUS_CLOID'));
  assert.ok(result.rawResponseCommitments.length > 0);
});
