import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  emptyPackageBook,
  matchPackageOrder,
  packageMatchingPolicy,
  toProtocolJson,
  type PackageAllocation,
  type PackageMatchingPolicyInput,
  type PackageTakerOrderInput,
} from '@naryx/protocol-types';
import { NaryxApiError, NaryxClient, NaryxEvidenceError, candlesFromTape, type FetchLike } from '../src/index.js';

const CLASS = 'solana-atomic-cash-carry-v1';
const POLICY_INPUT: PackageMatchingPolicyInput = {
  matchingPolicyVersion: 1,
  environment: 'local',
  executionClassId: CLASS,
  allocationRule: 'PRICE_TIME',
  directVersusImpliedPriority: 'DIRECT_FIRST',
  selfMatchPolicy: 'CANCEL_INCOMING',
  commonControlAsSelf: true,
  amendmentPriorityRule: 'RETAIN_ON_SIZE_REDUCTION',
  quantityIncrement: 10n,
  minimumExecutionQuantity: 10n,
  maximumImplicationDepth: 1,
};
const policy = packageMatchingPolicy(POLICY_INPUT);
const id = (n: number): string => n.toString(16).padStart(64, '0');
const order = (n: number, overrides: Partial<PackageTakerOrderInput> = {}): PackageTakerOrderInput => ({
  orderId: id(n),
  executionClassId: CLASS,
  side: 'ASK',
  orderType: 'LIMIT',
  timeInForce: 'GTC',
  limitPriceTicks: 100n,
  quantity: 10n,
  minimumQuantity: 10n,
  participantId: `maker-${n}`,
  commonControlGroupId: `group-${n}`,
  ...overrides,
});

function takerAllocation(): PackageAllocation {
  const rested = matchPackageOrder(policy, emptyPackageBook(policy), order(1), 1_000n);
  if (!rested.accepted) assert.fail('resting order rejected');
  const filled = matchPackageOrder(policy, rested.state, order(2, { side: 'BID', timeInForce: 'IOC' }), 1_000n);
  if (!filled.accepted) assert.fail('taker order rejected');
  return filled.allocation;
}

function serve(routes: Record<string, { status?: number; body: unknown; contentType?: string }>): FetchLike {
  return async (url, init) => {
    const path = `${init.method === 'POST' ? 'POST ' : ''}${url.replace('https://api.example', '')}`;
    const route = routes[path];
    const status = route === undefined ? 404 : route.status ?? 200;
    const body = route === undefined ? { error: { code: 'NOT_FOUND', message: 'missing' } } : route.body;
    const contentType = route?.contentType ?? 'application/json; charset=utf-8';
    return { status, headers: { get: (name: string) => (name === 'content-type' ? contentType : null) }, text: async () => JSON.stringify(toProtocolJson(body)) };
  };
}

const client = (routes: Parameters<typeof serve>[0]) => new NaryxClient({ baseUrl: 'https://api.example/', fetch: serve(routes) });

describe('public API client', () => {
  test('only HTTPS or loopback HTTP endpoints are accepted', () => {
    const fetch = serve({});
    assert.throws(() => new NaryxClient({ baseUrl: 'http://api.example', fetch }), /HTTPS/);
    assert.throws(() => new NaryxClient({ baseUrl: 'https://user@api.example', fetch }), /HTTPS/);
    new NaryxClient({ baseUrl: 'http://127.0.0.1:8787', fetch });
    new NaryxClient({ baseUrl: 'https://api.example/naryx', fetch });
  });

  test('reads depth with direct and implied quantity kept apart', async () => {
    const book = await client({
      [`/v1/markets/${CLASS}/package-depth`]: {
        body: {
          packageMarketId: CLASS,
          matchingPolicyHash: 'ab'.repeat(32),
          halted: false,
          asOfValue: 1_000n,
          bids: [],
          asks: [{ priceTicks: 100n, directQuantity: 10n, impliedQuantity: 20n }],
        },
      },
    }).getDepth(CLASS);
    assert.deepEqual(book.asks, [{ priceTicks: 100n, directQuantity: 10n, impliedQuantity: 20n }]);
    await assert.rejects(client({}).getDepth(CLASS), (error: unknown) => error instanceof NaryxApiError && error.status === 404 && error.code === 'NOT_FOUND');
    await assert.rejects(client({ [`/v1/markets/${CLASS}/package-depth`]: { body: {}, contentType: 'text/html' } }).getDepth(CLASS), NaryxEvidenceError);
  });

  test('rejects a tape whose cursors do not advance', async () => {
    const trade = (cursor: number) => ({ cursor, allocationHash: 'cd'.repeat(32), takerSide: 'BID', recordedAtMs: 5, fills: [] });
    const path = `/v1/markets/${CLASS}/package-tape?after=0&limit=50`;
    const page = await client({ [path]: { body: { packageMarketId: CLASS, trades: [trade(1), trade(4)], nextCursor: 4 } } }).getTape(CLASS);
    assert.deepEqual(page.trades.map((entry) => entry.cursor), [1, 4]);
    await assert.rejects(client({ [path]: { body: { packageMarketId: CLASS, trades: [trade(4), trade(4)], nextCursor: 4 } } }).getTape(CLASS), /strictly increase/);
    await assert.rejects(client({ [path]: { body: { packageMarketId: CLASS, trades: [trade(1)], nextCursor: 9 } } }).getTape(CLASS), /does not follow/);
  });

  test('verifies allocation evidence locally and rejects tampering or a substituted policy', async () => {
    const allocation = takerAllocation();
    const path = `/v1/allocations/${id(2)}`;
    const verified = await client({ [path]: { body: { allocation, matchingPolicy: policy } } }).getVerifiedAllocation(id(2));
    assert.equal(verified.allocation.fills.length, 1);
    assert.match(verified.allocationHash, /^[0-9a-f]{64}$/);

    const inflated = { ...allocation, fills: allocation.fills.map((fill) => ({ ...fill, quantity: fill.quantity + 10n })) };
    await assert.rejects(client({ [path]: { body: { allocation: inflated, matchingPolicy: policy } } }).getVerifiedAllocation(id(2)), NaryxEvidenceError);
    const otherPolicy = packageMatchingPolicy({ ...POLICY_INPUT, quantityIncrement: 5n, minimumExecutionQuantity: 5n });
    await assert.rejects(
      client({ [path]: { body: { allocation, matchingPolicy: otherPolicy } } }).getVerifiedAllocation(id(2)),
      /not the policy the allocation binds/,
    );
    await assert.rejects(
      client({ [`/v1/allocations/${id(3)}`]: { body: { allocation, matchingPolicy: policy } } }).getVerifiedAllocation(id(3)),
      /another order/,
    );
  });

  test('candles must be ordered, aligned, and internally consistent', async () => {
    const path = `/v1/markets/${CLASS}/candles?interval=1m`;
    const candle = (openTimeMs: number, open: bigint, high: bigint, low: bigint, close: bigint) => ({ openTimeMs, open, high, low, close, volume: 1n, tradeCount: 1 });
    const serve = (candles: unknown[]) =>
      client({ [path]: { body: { packageMarketId: CLASS, interval: '1m', label: 'OBSERVED', methodologyVersion: 1, fromMs: 0, toMs: 600_000, truncated: false, candles } } });
    const page = await serve([candle(60_000, 100n, 102n, 99n, 101n), candle(180_000, 101n, 101n, 100n, 100n)]).getCandles(CLASS, { interval: '1m' });
    assert.equal(page.candles.length, 2);
    await assert.rejects(serve([candle(61_000, 100n, 100n, 100n, 100n)]).getCandles(CLASS, { interval: '1m' }), /misaligned/);
    await assert.rejects(serve([candle(60_000, 100n, 99n, 98n, 99n)]).getCandles(CLASS, { interval: '1m' }), /range/);
    await assert.rejects(
      client({ [path]: { body: { packageMarketId: CLASS, interval: '1m', label: 'EXECUTABLE', candles: [] } } }).getCandles(CLASS, { interval: '1m' }),
      /OBSERVED/,
    );
    const rebuilt = candlesFromTape(
      [{ cursor: 1, allocationHash: 'ab'.repeat(32), takerSide: 'BID', recordedAtMs: 65_000, fills: [{ fillSequence: 1n, priceTicks: 100n, quantity: 10n, makerSource: 'DIRECT' }] }],
      '1m',
    );
    assert.deepEqual(rebuilt.candles.map((entry) => [entry.openTimeMs, entry.close, entry.volume]), [[60_000, 100n, 10n]]);
  });

  test('a crossed executable market and a server that disagrees with local validation are rejected', async () => {
    const market = (bestBidTicks: bigint, bestAskTicks: bigint) => ({
      markets: [{ packageMarketId: CLASS, halted: false, matchingPolicyHash: 'ab'.repeat(32), bestBidTicks, bestAskTicks, spreadTicks: bestAskTicks - bestBidTicks, label: 'EXECUTABLE' }],
    });
    assert.equal((await client({ '/v1/markets': { body: market(99n, 101n) } }).listMarkets()).length, 1);
    await assert.rejects(client({ '/v1/markets': { body: market(101n, 101n) } }).listMarkets(), /crossed/);
    await assert.rejects(
      client({ 'POST /v1/orders/validate': { body: { valid: true, orderHash: 'cd'.repeat(32) } } }).validateOrder({ version: 99 } as never),
      /disagrees/,
    );
    await assert.rejects(
      client({ 'POST /v1/clearing/simulate': { body: { accepted: true } } }).simulateClearing(CLASS, order(1)),
      /not marked as a simulation/,
    );
  });
});

