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
import type { HyperliquidStrategyExecutionPlan } from '@naryx/adapter-hyperliquid';
import { assetRef, domainRef, hash32, manifestHash } from '@naryx/protocol-types';
import {
  HYPERLIQUID_TESTNET_INFO_URL,
  HyperliquidAuthoritativeEvidenceCollector,
  HyperliquidSdkTestnetReadClient,
  HyperliquidStrategyAuthoritativeEvidenceCollector,
  type HyperliquidEvidenceMarketBinding,
  type HyperliquidEvidenceWindow,
  type HyperliquidInfoEnvelope,
  type HyperliquidInfoRequestIdentity,
  type HyperliquidPackageAttempt,
  type HyperliquidRecoveryAttempt,
  type HyperliquidTestnetReadClient,
} from '../src/index.js';

const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'12'.repeat(20)}` as const;
const spotCloid = `0x${'21'.repeat(16)}` as const;
const perpCloid = `0x${'22'.repeat(16)}` as const;
const recoveryCloid = `0x${'23'.repeat(16)}` as const;
const baseAsset = assetRef('ubtc', '31'.repeat(32), 8);
const quoteAsset = assetRef('usdc', '32'.repeat(32), 8);
const account = { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' as const };
const binding: HyperliquidEvidenceMarketBinding = {
  spotUniverseIndex: 7,
  spotTokenIndex: 1,
  perpetualAssetIndex: 3,
  quoteTokenIndex: 0,
};

function packageAttempt(): HyperliquidPackageAttempt {
  return {
    version: 1,
    status: 'RECONCILING',
    account,
    reasons: [],
    acceptedEvidence: null,
    lockEvidence: null,
    recoveryObligation: null,
    plan: {
      domain: domainRef('hypercore:testnet', 1, '41'.repeat(32)),
      commitments: {
        seriesManifestHash: manifestHash('42'.repeat(32)),
        executionClassManifestHash: manifestHash('43'.repeat(32)),
        orderHash: hash32('44'.repeat(32)),
        quoteHash: hash32('45'.repeat(32)),
        routeHash: hash32('46'.repeat(32)),
      },
      legs: [
        {
          role: 'SPOT', clientOrderId: spotCloid, signedBaseDeltaAtoms: 100n,
          baseAsset, quoteAsset, sizeDecimals: 8, order: { a: 10_007 },
        },
        {
          role: 'PERPETUAL', clientOrderId: perpCloid, signedBaseDeltaAtoms: -100n,
          baseAsset, quoteAsset, sizeDecimals: 6, order: { a: 3 },
        },
      ],
      spotClientOrderId: spotCloid,
      perpetualClientOrderId: perpCloid,
      prePerpetualPositionAtoms: 0n,
      perpetualPositionTargetAtoms: -100n,
    },
  } as unknown as HyperliquidPackageAttempt;
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
  size = '0.000001',
  feeToken = 'USDC',
): UserFillsByTimeResponse[number] {
  return {
    cloid, coin, px: '60000.25', sz: size, side, time: 5_000,
    startPosition: '0', dir: side === 'B' ? 'Buy' : 'Sell', closedPnl: '0',
    hash: `0x${'51'.repeat(32)}`, oid, crossed: true, fee: '0.00000001',
    tid, feeToken, twapId: null,
  };
}

class FixtureClient implements HyperliquidTestnetReadClient {
  readonly environment = 'testnet' as const;
  readonly apiUrl = HYPERLIQUID_TESTNET_INFO_URL;
  stamp = 1_000;
  spotTotal = '1';
  perpetualSize = '0';
  fills: UserFillsByTimeResponse = [];
  fillReader: ((startTimeMs: number, endTimeMs: number) => UserFillsByTimeResponse) | null = null;
  open: OpenOrdersResponse = [];
  role: UserRoleResponse = { role: 'subAccount', data: { master: masterAccount } };
  quoteTokenName = 'USDC';
  spotSizeDecimals = 8;
  readonly statuses = new Map<string, OrderStatusResponse>();
  readonly queriedCloids: string[] = [];

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
        { name: this.quoteTokenName, szDecimals: 8, weiDecimals: 8, index: 0,
          tokenId: `0x${'01'.repeat(16)}`, isCanonical: true, evmContract: null,
          fullName: 'USD Coin', deployerTradingFeeShare: '0' },
        { name: 'UBTC', szDecimals: this.spotSizeDecimals, weiDecimals: 8, index: 1,
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
    this.queriedCloids.push(cloid);
    const payload = this.statuses.get(cloid) ?? { status: 'unknownOid' as const };
    return Promise.resolve(this.#envelope({ operation: 'orderStatus', user, cloid }, payload));
  }

  userFillsByTime(user: `0x${string}`, startTimeMs: number, endTimeMs: number):
    Promise<HyperliquidInfoEnvelope<UserFillsByTimeResponse>> {
    return Promise.resolve(this.#envelope(
      { operation: 'userFillsByTime', user, startTimeMs, endTimeMs },
      this.fillReader?.(startTimeMs, endTimeMs) ?? this.fills,
    ));
  }
}

const checkpointWindow: HyperliquidEvidenceWindow = {
  startTimeMs: 900, endTimeMs: 1_000, nowMs: 1_000,
  maxEvidenceAgeMs: 500, maxSnapshotSkewMs: 100,
};
const evidenceWindow: HyperliquidEvidenceWindow = {
  startTimeMs: 1_000, endTimeMs: 10_000, nowMs: 10_000,
  maxEvidenceAgeMs: 9_000, maxSnapshotSkewMs: 100,
};

async function checkpoint(client: FixtureClient) {
  const result = await new HyperliquidAuthoritativeEvidenceCollector(client)
    .captureCheckpoint(packageAttempt(), binding, checkpointWindow);
  assert.equal(result.status, 'COMPLETE');
  return result.checkpoint;
}

function configureExact(client: FixtureClient): void {
  client.statuses.set(spotCloid, orderStatus(spotCloid, 1, '@7', 'B'));
  client.statuses.set(perpCloid, orderStatus(perpCloid, 2, 'BTC', 'A'));
  client.fills = [fill(spotCloid, 1, 10, '@7', 'B'), fill(perpCloid, 2, 10, 'BTC', 'A')];
  client.spotTotal = '1.000001';
  client.perpetualSize = '-0.000001';
}

test('collects exact package evidence from independent cloid and account reads', async () => {
  const client = new FixtureClient();
  const before = await checkpoint(client);
  client.stamp = 9_950;
  configureExact(client);
  const result = await new HyperliquidAuthoritativeEvidenceCollector(client)
    .collectPackage(packageAttempt(), before, binding, evidenceWindow);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(client.queriedCloids, [spotCloid, perpCloid]);
  assert.equal(result.input.netSpotDeltaAtoms, 100n);
  assert.equal(result.input.perpetualPositionDeltaAtoms, -100n);
  assert.equal(result.input.spot.terminalStatus, 'FILLED');
  assert.equal(result.input.fees[0]!.amountAtoms, 2n);
  assert.deepEqual(result.observedFills[0]!.price, { coefficient: 6_000_025n, scale: 2 });
  assert.ok(result.rawResponseCommitments.every((value) => /^0x[0-9a-f]{64}$/.test(value.sha256)));
});

test('collects a one-leg partial IOC without inventing a full fill', async () => {
  const client = new FixtureClient();
  const before = await checkpoint(client);
  client.stamp = 9_950;
  configureExact(client);
  client.statuses.set(spotCloid, orderStatus(spotCloid, 1, '@7', 'B', 'canceled'));
  client.fills = [fill(spotCloid, 1, 10, '@7', 'B', '0.0000005'), fill(perpCloid, 2, 11, 'BTC', 'A')];
  client.spotTotal = '1.0000005';
  const result = await new HyperliquidAuthoritativeEvidenceCollector(client)
    .collectPackage(packageAttempt(), before, binding, evidenceWindow);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.input.spot.terminalStatus, 'PARTIALLY_FILLED_IOC_CANCELLED');
  assert.equal(result.input.spot.filledSignedBaseAtoms, 50n);
});

test('collects recovery fills but withholds reducer input when aggregate loss is unavailable', async () => {
  const client = new FixtureClient();
  const source = packageAttempt();
  const before = await checkpoint(client);
  client.stamp = 9_950;
  client.statuses.set(recoveryCloid, orderStatus(recoveryCloid, 3, 'BTC', 'B'));
  client.fills = [fill(recoveryCloid, 3, 12, 'BTC', 'B')];
  client.perpetualSize = '0.000001';
  const recovery = {
    sourceAttempt: source,
    plan: {
      account,
      orders: [{ role: 'PERPETUAL', clientOrderId: recoveryCloid,
        signedBaseDeltaAtoms: 100n, order: { a: 3 } }],
    },
  } as unknown as HyperliquidRecoveryAttempt;
  const result = await new HyperliquidAuthoritativeEvidenceCollector(client)
    .collectRecovery(recovery, before, binding, evidenceWindow);
  assert.equal(result.status, 'INCOMPLETE');
  assert.ok(result.reasons.includes('AGGREGATE_RECOVERY_LOSS_UNAVAILABLE'));
  assert.equal(result.input, null);
  assert.equal(result.observedFills[0]!.clientOrderId, recoveryCloid);
  assert.equal(result.accountObservation!.observedPerpetualPositionAtoms, 100n);
});

test('rejects duplicate open-order evidence for an exact cloid', async () => {
  const client = new FixtureClient();
  const before = await checkpoint(client);
  client.stamp = 9_950;
  configureExact(client);
  const duplicateStatus = orderStatus(spotCloid, 1, '@7', 'B');
  const duplicate = duplicateStatus.status === 'order' ? duplicateStatus.order.order : undefined;
  assert.ok(duplicate !== undefined);
  client.open = [duplicate, duplicate] as unknown as OpenOrdersResponse;
  const result = await new HyperliquidAuthoritativeEvidenceCollector(client)
    .collectPackage(packageAttempt(), before, binding, evidenceWindow);
  assert.equal(result.status, 'INCOMPLETE');
  assert.ok(result.reasons.includes('AMBIGUOUS_CLOID'));
});

test('rejects uncertain fee-token evidence and unresolved pagination', async () => {
  const feeClient = new FixtureClient();
  const beforeFee = await checkpoint(feeClient);
  feeClient.stamp = 9_950;
  configureExact(feeClient);
  feeClient.fills = [fill(spotCloid, 1, 10, '@7', 'B', '0.000001', 'HYPE'),
    fill(perpCloid, 2, 11, 'BTC', 'A')];
  const feeResult = await new HyperliquidAuthoritativeEvidenceCollector(feeClient)
    .collectPackage(packageAttempt(), beforeFee, binding, evidenceWindow);
  assert.equal(feeResult.status, 'INCOMPLETE');
  assert.ok(feeResult.reasons.includes('UNCERTAIN_FEE_EVIDENCE'));

  const pageClient = new FixtureClient();
  const beforePage = await checkpoint(pageClient);
  pageClient.stamp = 9_950;
  configureExact(pageClient);
  pageClient.fills = Array.from({ length: 2_000 }, (_, index) =>
    fill(spotCloid, 1, index + 1, '@7', 'B'));
  const pageResult = await new HyperliquidAuthoritativeEvidenceCollector(pageClient)
    .collectPackage(packageAttempt(), beforePage, binding, evidenceWindow);
  assert.equal(pageResult.status, 'INCOMPLETE');
  assert.ok(pageResult.reasons.includes('INCOMPLETE_PAGINATION'));
});

test('proves an inclusive full-page boundary before advancing the fill cursor', async () => {
  const client = new FixtureClient();
  const before = await checkpoint(client);
  client.stamp = 9_950;
  configureExact(client);
  const unrelated = Array.from({ length: 1_999 }, (_, index) => ({
    ...fill(`0x${'88'.repeat(16)}`, 999, index + 100, 'ETH', 'B'),
    time: 4_000,
  }));
  const spotFill = fill(spotCloid, 1, 10, '@7', 'B');
  const perpFill = { ...fill(perpCloid, 2, 11, 'BTC', 'A'), time: 6_000 };
  client.fillReader = (startTimeMs, endTimeMs) => {
    if (startTimeMs === 1_000 && endTimeMs === 10_000) return [...unrelated, spotFill];
    if (startTimeMs === 5_000 && endTimeMs === 5_000) return [spotFill];
    if (startTimeMs === 5_001 && endTimeMs === 10_000) return [perpFill];
    return [];
  };
  const result = await new HyperliquidAuthoritativeEvidenceCollector(client)
    .collectPackage(packageAttempt(), before, binding, evidenceWindow);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.observedFills.length, 2);
  assert.equal(result.input.spot.filledSignedBaseAtoms, 100n);
  assert.equal(result.input.perpetual.filledSignedBaseAtoms, -100n);
});

test('rejects stale snapshots and a trading account with the wrong master', async () => {
  const staleClient = new FixtureClient();
  const before = await checkpoint(staleClient);
  staleClient.stamp = 100;
  configureExact(staleClient);
  const stale = await new HyperliquidAuthoritativeEvidenceCollector(staleClient)
    .collectPackage(packageAttempt(), before, binding, evidenceWindow);
  assert.equal(stale.status, 'INCOMPLETE');
  assert.ok(stale.reasons.includes('STALE_OR_MIXED_SNAPSHOT'));

  const wrongMasterClient = new FixtureClient();
  wrongMasterClient.role = { role: 'subAccount', data: { master: `0x${'99'.repeat(20)}` } };
  const wrongMaster = await new HyperliquidAuthoritativeEvidenceCollector(wrongMasterClient)
    .captureCheckpoint(packageAttempt(), binding, checkpointWindow);
  assert.equal(wrongMaster.status, 'INCOMPLETE');
  assert.ok(wrongMaster.reasons.includes('ACCOUNT_IDENTITY_MISMATCH'));
});

test('rejects same-decimal quote identity and compiled precision metadata mismatches', async () => {
  const wrongQuoteClient = new FixtureClient();
  wrongQuoteClient.quoteTokenName = 'USDT';
  const wrongQuote = await new HyperliquidAuthoritativeEvidenceCollector(wrongQuoteClient)
    .captureCheckpoint(packageAttempt(), binding, checkpointWindow);
  assert.equal(wrongQuote.status, 'INCOMPLETE');
  assert.ok(wrongQuote.reasons.includes('UNKNOWN_ASSET_OR_MARKET'));

  const wrongPrecisionClient = new FixtureClient();
  wrongPrecisionClient.spotSizeDecimals = 7;
  const wrongPrecision = await new HyperliquidAuthoritativeEvidenceCollector(wrongPrecisionClient)
    .captureCheckpoint(packageAttempt(), binding, checkpointWindow);
  assert.equal(wrongPrecision.status, 'INCOMPLETE');
  assert.ok(wrongPrecision.reasons.includes('UNKNOWN_ASSET_OR_MARKET'));
});

test('pins the concrete SDK client to the exact testnet Info environment', () => {
  const client = new HyperliquidSdkTestnetReadClient();
  assert.equal(client.environment, 'testnet');
  assert.equal(client.apiUrl, 'https://api.hyperliquid-testnet.xyz');
  assert.equal('exchange' in client, false);
  assert.equal('sign' in client, false);
});

test('accounts for a spot buy fee charged in the base token at the token precision', async () => {
  const client = new FixtureClient();
  const before = await checkpoint(client);
  client.stamp = 9_950;
  configureExact(client);
  client.fills = [fill(spotCloid, 1, 10, '@7', 'B', '0.000001', 'UBTC'),
    fill(perpCloid, 2, 11, 'BTC', 'A')];
  client.spotTotal = '1.00000099';
  const result = await new HyperliquidAuthoritativeEvidenceCollector(client)
    .collectPackage(packageAttempt(), before, binding, evidenceWindow);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.input.spot.filledSignedBaseAtoms, 100n);
  assert.equal(result.input.netSpotDeltaAtoms, 99n);
  assert.deepEqual(result.input.fees.map((fee) => [fee.assetId, fee.amountAtoms]),
    [['usdc', 1n], ['ubtc', 1n]]);

  // A base-token fee on the perpetual leg is not a known HyperCore fee path.
  const perpClient = new FixtureClient();
  const perpBefore = await checkpoint(perpClient);
  perpClient.stamp = 9_950;
  configureExact(perpClient);
  perpClient.fills = [fill(spotCloid, 1, 10, '@7', 'B'),
    fill(perpCloid, 2, 11, 'BTC', 'A', '0.000001', 'UBTC')];
  const perpResult = await new HyperliquidAuthoritativeEvidenceCollector(perpClient)
    .collectPackage(packageAttempt(), perpBefore, binding, evidenceWindow);
  assert.equal(perpResult.status, 'INCOMPLETE');
  assert.ok(perpResult.reasons.includes('UNCERTAIN_FEE_EVIDENCE'));
});

function strategyEvidenceFixture(partial = false, additionalPerpetual = false): Readonly<{
  client: FixtureClient;
  request: Parameters<HyperliquidStrategyAuthoritativeEvidenceCollector['collect']>[0];
}> {
  const client = new FixtureClient();
  client.stamp = 9_950;
  const cloids = [spotCloid, perpCloid, recoveryCloid];
  const coins = ['@7', 'BTC', additionalPerpetual ? 'xyz:BTC' : '@7'];
  const sides = ['B', 'A', 'B'] as const;
  const wires = cloids.map((cloid, index) => ({
    a: index === 1 ? 3 : additionalPerpetual && index === 2 ? 110_000 : 10_007,
    b: sides[index] === 'B',
    p: '60000',
    s: '0.000001',
    r: false,
    t: { limit: { tif: 'Ioc' as const } },
    c: cloid,
  }));
  const orders = wires.map((wire, index) => ({
    legId: `leg-${index}`,
    stage: 0,
    baseAsset,
    quoteAsset,
    signedBaseDeltaAtoms: sides[index] === 'B' ? 100n : -100n,
    clientOrderId: wire.c,
    wire,
  }));
  const actionHash = `0x${createHash('sha256').update(JSON.stringify([
    'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1',
    'order',
    wires.map((wire) => [wire.a, wire.b, wire.p, wire.s, wire.r, wire.t.limit.tif, wire.c]),
    'na',
  ])).digest('hex')}` as const;
  const plan = {
    version: 1,
    guarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY',
    domain: domainRef('hypercore:testnet', 1, '71'.repeat(32)),
    orderHash: hash32('72'.repeat(32)),
    graphHash: hash32('73'.repeat(32)),
    quoteHash: hash32('74'.repeat(32)),
    routeHash: hash32('75'.repeat(32)),
    requestExpiryMs: 11_000n,
    orders,
    batches: [{ stage: 0, action: { type: 'order', grouping: 'na', orders: wires },
      legIds: orders.map((order) => order.legId) }],
    recoveryAuthorizations: [],
    maximumRecoveryCostQuoteAtoms: 0n,
  } as unknown as HyperliquidStrategyExecutionPlan;
  cloids.forEach((cloid, index) => client.statuses.set(cloid,
    orderStatus(cloid, index + 1, coins[index]!, sides[index]!, partial && index === 2 ? 'canceled' : 'filled')));
  client.fills = cloids.map((cloid, index) => fill(
    cloid,
    index + 1,
    index + 10,
    coins[index]!,
    sides[index]!,
    partial && index === 2 ? '0.0000005' : '0.000001',
    index === 1 || additionalPerpetual && index === 2 ? 'USDC' : 'UBTC',
  ));
  return Object.freeze({
    client,
    request: Object.freeze({
      attemptId: 'strategy-attempt-1',
      batchStage: 0,
      account,
      binding: {
        spotAssetId: 10_007,
        perpetualAssetId: 3,
        additionalPerpetualAssetIds: additionalPerpetual ? [110_000] : [],
        baseFeeToken: 'UBTC',
        quoteFeeToken: 'USDC',
      },
      actionHash,
      requestCommitment: `0x${'76'.repeat(32)}` as const,
      durableRevision: 'sqlite-strategy-v1:1',
      legIds: orders.map((order) => order.legId),
      clientOrderIds: cloids,
      plan,
      window: evidenceWindow,
    }),
  });
}

test('classifies complete and partial generalized HyperCore packages from authoritative fills', async () => {
  const complete = strategyEvidenceFixture();
  const completeResult = await new HyperliquidStrategyAuthoritativeEvidenceCollector(complete.client)
    .collect(complete.request);
  assert.equal(completeResult.status, 'COMPLETE');
  assert.equal(completeResult.outcome, 'COMPLETED');
  assert.deepEqual(completeResult.legs.map((leg) => leg.filledSignedBaseAtoms), [100n, -100n, 100n]);
  assert.deepEqual(completeResult.legs.map((leg) => leg.grossQuoteAtoms),
    [6_000_025n, 6_000_025n, 6_000_025n]);
  assert.deepEqual(completeResult.legs.map((leg) => leg.venueFeeQuoteAtoms),
    [60_001n, 1n, 60_001n]);

  const partial = strategyEvidenceFixture(true);
  const partialResult = await new HyperliquidStrategyAuthoritativeEvidenceCollector(partial.client)
    .collect(partial.request);
  assert.equal(partialResult.status, 'COMPLETE');
  assert.equal(partialResult.outcome, 'RECOVERY_REQUIRED');
  assert.deepEqual(partialResult.reasons, ['PARTIAL_PACKAGE_FILL']);
  assert.equal(partialResult.legs[2]?.grossQuoteAtoms, 3_000_013n);
});

test('reconciles a bound HIP-3 perpetual leg in a generalized package', async () => {
  const fixture = strategyEvidenceFixture(false, true);
  const result = await new HyperliquidStrategyAuthoritativeEvidenceCollector(fixture.client)
    .collect(fixture.request);

  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.outcome, 'COMPLETED');
  assert.equal(result.legs[2]?.legId, 'leg-2');
  assert.equal(result.legs[2]?.feeAssetId, 'usdc');
  assert.equal(result.legs[2]?.venueFeeQuoteAtoms, 1n);
});
