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
import { NaryxApiError, NaryxEvidenceError, NaryxMarketClient, type FetchLike } from '../src/index.js';

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
  return async (url) => {
    const path = url.replace('https://api.example', '');
    const route = routes[path];
    const status = route === undefined ? 404 : route.status ?? 200;
    const body = route === undefined ? { error: { code: 'NOT_FOUND', message: 'missing' } } : route.body;
    const contentType = route?.contentType ?? 'application/json; charset=utf-8';
    return { status, headers: { get: (name: string) => (name === 'content-type' ? contentType : null) }, text: async () => JSON.stringify(toProtocolJson(body)) };
  };
}

const client = (routes: Parameters<typeof serve>[0]) => new NaryxMarketClient({ baseUrl: 'https://api.example/', fetch: serve(routes) });

describe('market client', () => {
  test('only HTTPS or loopback HTTP endpoints are accepted', () => {
    const fetch = serve({});
    assert.throws(() => new NaryxMarketClient({ baseUrl: 'http://api.example', fetch }), /HTTPS/);
    assert.throws(() => new NaryxMarketClient({ baseUrl: 'https://user@api.example', fetch }), /HTTPS/);
    new NaryxMarketClient({ baseUrl: 'http://127.0.0.1:8787', fetch });
    new NaryxMarketClient({ baseUrl: 'https://api.example/naryx', fetch });
  });

  test('reads depth with direct and implied quantity kept apart', async () => {
    const book = await client({
      [`/v1/market/books/${CLASS}`]: {
        body: {
          executionClassId: CLASS,
          matchingPolicyHash: 'ab'.repeat(32),
          halted: false,
          asOfValue: 1_000n,
          bids: [],
          asks: [{ priceTicks: 100n, directQuantity: 10n, impliedQuantity: 20n }],
        },
      },
    }).getBook(CLASS);
    assert.deepEqual(book.asks, [{ priceTicks: 100n, directQuantity: 10n, impliedQuantity: 20n }]);
    await assert.rejects(client({}).getBook(CLASS), (error: unknown) => error instanceof NaryxApiError && error.status === 404 && error.code === 'NOT_FOUND');
    await assert.rejects(client({ [`/v1/market/books/${CLASS}`]: { body: {}, contentType: 'text/html' } }).getBook(CLASS), NaryxEvidenceError);
  });

  test('rejects a tape whose cursors do not advance', async () => {
    const trade = (cursor: number) => ({ cursor, allocationHash: 'cd'.repeat(32), takerSide: 'BID', recordedAtMs: 5, fills: [] });
    const path = `/v1/market/books/${CLASS}/tape?after=0&limit=50`;
    const page = await client({ [path]: { body: { executionClassId: CLASS, trades: [trade(1), trade(4)], nextCursor: 4 } } }).getTape(CLASS);
    assert.deepEqual(page.trades.map((entry) => entry.cursor), [1, 4]);
    await assert.rejects(client({ [path]: { body: { executionClassId: CLASS, trades: [trade(4), trade(4)], nextCursor: 4 } } }).getTape(CLASS), /strictly increase/);
    await assert.rejects(client({ [path]: { body: { executionClassId: CLASS, trades: [trade(1)], nextCursor: 9 } } }).getTape(CLASS), /does not follow/);
  });

  test('verifies allocation evidence locally and rejects tampering or a substituted policy', async () => {
    const allocation = takerAllocation();
    const path = `/v1/market/allocations/${id(2)}`;
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
      client({ [`/v1/market/allocations/${id(3)}`]: { body: { allocation, matchingPolicy: policy } } }).getVerifiedAllocation(id(3)),
      /another order/,
    );
  });
});
