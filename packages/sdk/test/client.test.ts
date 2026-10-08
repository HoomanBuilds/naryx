import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  clearPackageReopeningAuction,
  emptyPackageBook,
  matchPackageOrder,
  netObligations,
  packageAllocationHash,
  packageBookAmendmentBytes,
  packageBookAmendmentHash,
  packageBookCancellationBytes,
  packageBookCancellationHash,
  packageSettlementCommitment,
  packageSettlementCommitmentBytes,
  packageSettlementCommitmentHash,
  packageSettlementHandoff,
  packageSettlementHandoffHash,
  packageSettlementReadiness,
  packageSettlementReadinessHash,
  packageMatchingPolicy,
  packageReopeningResultHash,
  packageReopeningSettlementHandoff,
  packageReopeningSettlementHandoffHash,
  packageTakerOrderHash,
  queuePackageReopeningOrder,
  setPackageBookHalted,
  toHex,
  toProtocolJson,
  type PackageAllocation,
  type PackageMatchingPolicyInput,
  type PackageTakerOrderInput,
} from '@naryx/protocol-types';
import { NaryxApiError, NaryxClient, NaryxEvidenceError, base58Encode, candlesFromTape, type FetchLike } from '../src/index.js';

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
const order = (n: number, overrides: Partial<PackageTakerOrderInput> = {}): PackageTakerOrderInput => {
  const timeInForce = overrides.timeInForce ?? 'GTC';
  return {
    orderId: id(n),
    executionClassId: CLASS,
    side: 'ASK',
    orderType: 'LIMIT',
    timeInForce,
    limitPriceTicks: 100n,
    quantity: 10n,
    minimumQuantity: 10n,
    participantId: `maker-${n}`,
    commonControlGroupId: `group-${n}`,
    ...(timeInForce === 'GTC'
      ? { settlementLeaseUntilValue: overrides.settlementLeaseUntilValue ?? 2_000n }
      : {}),
    ...overrides,
  };
};

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
    const settlementCommitment = packageSettlementCommitment({
      version: 1,
      environment: allocation.environment,
      executionClassId: allocation.executionClassId,
      packageOrderId: id(2),
      strategyOrderHash: id(7_001),
      graphHash: id(7_002),
      participantId: allocation.takerParticipantId,
      settlementAccount: 'settlement-account',
      quantity: allocation.requestedQuantity,
      validUntilUnit: 'SOLANA_SLOT',
      validUntilValue: 2_000n,
    });
    const settlementHandoff = packageSettlementHandoff({
      version: 1,
      allocationHash: packageAllocationHash(allocation),
      executionClassId: allocation.executionClassId,
      takerSettlementCommitmentHash: packageSettlementCommitmentHash(settlementCommitment),
      fills: allocation.fills.map((fill) => ({
        fillSequence: fill.fillSequence,
        makerEntryId: fill.makerEntryId,
        makerSource: fill.makerSource,
        priceTicks: fill.priceTicks,
        quantity: fill.quantity,
        makerSettlementCommitmentHash: id(7_003),
      })),
    });
    const evidenceBody = {
      allocation,
      allocationHash: toHex(packageAllocationHash(allocation)),
      matchingPolicy: policy,
      settlementCommitment,
      settlementCommitmentHash: toHex(packageSettlementCommitmentHash(settlementCommitment)),
      settlementHandoff,
      settlementHandoffHash: toHex(packageSettlementHandoffHash(settlementHandoff)),
    };
    const verified = await client({ [path]: { body: evidenceBody } }).getVerifiedAllocation(id(2));
    assert.equal(verified.allocation.fills.length, 1);
    assert.match(verified.allocationHash, /^[0-9a-f]{64}$/);
    assert.equal(verified.settlementHandoffHash, evidenceBody.settlementHandoffHash);

    const inflated = { ...allocation, fills: allocation.fills.map((fill) => ({ ...fill, quantity: fill.quantity + 10n })) };
    await assert.rejects(client({ [path]: { body: { ...evidenceBody, allocation: inflated } } }).getVerifiedAllocation(id(2)), NaryxEvidenceError);
    const otherPolicy = packageMatchingPolicy({ ...POLICY_INPUT, quantityIncrement: 5n, minimumExecutionQuantity: 5n });
    await assert.rejects(
      client({ [path]: { body: { ...evidenceBody, matchingPolicy: otherPolicy } } }).getVerifiedAllocation(id(2)),
      /not the policy the allocation binds/,
    );
    await assert.rejects(
      client({ [`/v1/allocations/${id(3)}`]: { body: evidenceBody } }).getVerifiedAllocation(id(3)),
      /another order/,
    );
    await assert.rejects(
      client({ [path]: { body: { ...evidenceBody, settlementHandoff: { ...settlementHandoff, fills: settlementHandoff.fills.map((fill) => ({ ...fill, priceTicks: fill.priceTicks + 1n })) } } } })
        .getVerifiedAllocation(id(2)),
      NaryxEvidenceError,
    );
  });

  test('verifies package settlement readiness and rejects inconsistent obligations', async () => {
    const orderId = id(2);
    const allocationHashHex = id(4);
    const readiness = packageSettlementReadiness({
      version: 2,
      packageOrderId: orderId,
      settlementCommitmentHash: id(5),
      strategyOrderHash: id(6),
      executionClassId: CLASS,
      committedQuantity: 10n,
      allocatedQuantity: 10n,
      remainingQuantity: 0n,
      acceptsFurtherMatches: false,
      status: 'READY_FOR_OWNER_AUTHORIZATION',
      evidenceRefs: [{ kind: 'CONTINUOUS_ALLOCATION', evidenceHash: allocationHashHex }],
    });
    const path = `/v1/package-book/orders/${orderId}/settlement-readiness`;
    const obligation = {
      evidenceKind: 'CONTINUOUS_ALLOCATION',
      evidenceHashHex: allocationHashHex,
      fillSequence: 1n,
      role: 'TAKER',
      counterpartyOrderIdHex: id(1),
      liquiditySource: 'DIRECT',
      priceTicks: 100n,
      quantity: 10n,
    };
    const body = {
      readiness,
      readinessHashHex: toHex(packageSettlementReadinessHash(readiness)),
      obligations: [obligation],
    };
    const progress = await client({ [path]: { body } }).getPackageSettlementProgress(orderId);
    assert.equal(progress.readiness.status, 'READY_FOR_OWNER_AUTHORIZATION');
    assert.equal(progress.readinessHash, body.readinessHashHex);
    await assert.rejects(
      client({ [path]: { body: { ...body, obligations: [{ ...obligation, quantity: 9n }] } } })
        .getPackageSettlementProgress(orderId),
      NaryxEvidenceError,
    );

    const reopeningOrderId = id(7);
    const reopeningResultHash = id(8);
    const reopeningReadiness = packageSettlementReadiness({
      ...readiness,
      packageOrderId: reopeningOrderId,
      evidenceRefs: [{ kind: 'REOPENING_RESULT', evidenceHash: reopeningResultHash }],
    });
    const reopeningPath = `/v1/package-book/orders/${reopeningOrderId}/settlement-readiness`;
    const reopeningProgress = await client({
      [reopeningPath]: {
        body: {
          readiness: reopeningReadiness,
          readinessHashHex: toHex(packageSettlementReadinessHash(reopeningReadiness)),
          obligations: [{
            evidenceKind: 'REOPENING_RESULT',
            evidenceHashHex: reopeningResultHash,
            fillSequence: 2n,
            role: 'BID',
            counterpartyOrderIdHex: id(9),
            liquiditySource: 'DIRECT',
            priceTicks: 101n,
            quantity: 10n,
          }],
        },
      },
    }).getPackageSettlementProgress(reopeningOrderId);
    assert.equal(reopeningProgress.obligations[0]?.role, 'BID');
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
    const obligations = [
      { obligationId: id(91), userId: 'alice', packageId: 'package-a', underlyingId: 'sol', signedQuantityAtoms: 30n, sequence: 1n },
      { obligationId: id(92), userId: 'bob', packageId: 'package-b', underlyingId: 'sol', signedQuantityAtoms: -20n, sequence: 2n },
    ];
    const quantityIncrements = [{ underlyingId: 'sol', quantityIncrementAtoms: 10n }];
    const netting = netObligations(obligations, quantityIncrements);
    assert.equal(
      (await client({ 'POST /v1/netting/simulate': { body: { simulated: true, result: netting } } })
        .simulateNetting(obligations, quantityIncrements)).underlyings[0]?.externalNetAtoms,
      10n,
    );
    await assert.rejects(
      client({ 'POST /v1/netting/simulate': { body: { simulated: true, result: { ...netting, allocations: netting.allocations.slice(1) } } } })
        .simulateNetting(obligations, quantityIncrements),
      /verification/,
    );
  });

  test('submits a signed native package-book order and verifies returned allocation evidence', async () => {
    const keys = generateKeyPairSync('ed25519');
    const participantId = base58Encode(new Uint8Array((keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)));
    const draft = {
      executionClassId: CLASS,
      side: 'BID' as const,
      orderType: 'LIMIT' as const,
      timeInForce: 'IOC' as const,
      limitPriceTicks: 100n,
      quantity: 10n,
      minimumQuantity: 10n,
      participantId,
      commonControlGroupId: participantId,
    };
    const provisional = { ...draft, orderId: '00'.repeat(32) };
    const orderId = toHex(packageTakerOrderHash(provisional));
    const submitted = { ...draft, orderId };
    const settlementDraft = {
      environment: 'local',
      strategyOrderHash: id(7_001),
      graphHash: id(7_002),
      settlementAccount: 'solana-settlement-account',
      validUntilUnit: 'SOLANA_SLOT' as const,
      validUntilValue: 2_000n,
    };
    const settlementCommitment = packageSettlementCommitment({
      version: 1,
      ...settlementDraft,
      executionClassId: CLASS,
      packageOrderId: orderId,
      participantId,
      quantity: submitted.quantity,
    });
    const settlementCommitmentHash = toHex(packageSettlementCommitmentHash(settlementCommitment));
    const rested = matchPackageOrder(policy, emptyPackageBook(policy), order(1), 1_000n);
    if (!rested.accepted) assert.fail('resting order rejected');
    const matched = matchPackageOrder(policy, rested.state, submitted, 1_000n);
    if (!matched.accepted) assert.fail('package order rejected');
    const allocationHash = toHex(packageAllocationHash(matched.allocation));
    const settlementHandoff = packageSettlementHandoff({
      version: 1,
      allocationHash,
      executionClassId: CLASS,
      takerSettlementCommitmentHash: settlementCommitmentHash,
      fills: matched.allocation.fills.map((fill) => ({
        fillSequence: fill.fillSequence,
        makerEntryId: fill.makerEntryId,
        makerSource: fill.makerSource,
        priceTicks: fill.priceTicks,
        quantity: fill.quantity,
        makerSettlementCommitmentHash: id(7_003),
      })),
    });
    const settlementHandoffHash = toHex(packageSettlementHandoffHash(settlementHandoff));
    let signedBytes: Uint8Array | undefined;
    const result = await client({
      'POST /v1/package-book/orders': {
        body: {
          accepted: true,
          packageMarketId: CLASS,
          orderId,
          replayed: false,
          allocation: matched.allocation,
          allocationHash,
          settlementCommitmentHash,
          settlementHandoff,
          settlementHandoffHash,
          matchingPolicy: policy,
        },
      },
    }).submitPackageBookOrder(draft, settlementDraft, async (bytes) => {
      signedBytes = bytes;
      return new Uint8Array(sign(null, bytes, keys.privateKey));
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(signedBytes, packageSettlementCommitmentBytes(settlementCommitment));
    if (result.accepted) assert.equal(result.evidence.allocationHash, allocationHash);

    const cancellation = { version: 1, executionClassId: CLASS, entryId: orderId, participantId };
    const cancellationHash = toHex(packageBookCancellationHash(cancellation));
    let cancellationBytes: Uint8Array | undefined;
    const cancelled = await client({
      'POST /v1/package-book/cancellations': {
        body: { cancelled: true, packageMarketId: CLASS, entryId: orderId, cancellationHash, replayed: false },
      },
    }).cancelPackageBookOrder(CLASS, orderId, participantId, async (bytes) => {
      cancellationBytes = bytes;
      return new Uint8Array(sign(null, bytes, keys.privateKey));
    });
    assert.equal(cancelled.cancellationHash, cancellationHash);
    assert.deepEqual(cancellationBytes, packageBookCancellationBytes(cancellation));

    const reopeningDraft = {
      ...draft,
      timeInForce: 'GTC' as const,
      settlementLeaseUntilValue: 2_000n,
    };
    const reopeningProvisional = { ...reopeningDraft, orderId: '00'.repeat(32) };
    const reopeningOrderId = toHex(packageTakerOrderHash(reopeningProvisional));
    const reopeningOrder = { ...reopeningDraft, orderId: reopeningOrderId };
    const reopeningCommitment = packageSettlementCommitment({
      version: 1,
      ...settlementDraft,
      executionClassId: CLASS,
      packageOrderId: reopeningOrderId,
      participantId,
      quantity: reopeningOrder.quantity,
    });
    const admission = queuePackageReopeningOrder(
      policy,
      setPackageBookHalted(emptyPackageBook(policy), true),
      reopeningOrder,
      1_000n,
    );
    let reopeningSignedBytes: Uint8Array | undefined;
    const queued = await client({
      'POST /v1/package-book/reopening/orders': {
        body: {
          accepted: true,
          queuedForReopening: true,
          packageMarketId: CLASS,
          orderId: reopeningOrderId,
          replayed: false,
          entry: admission.entry,
          settlementCommitmentHash: toHex(packageSettlementCommitmentHash(reopeningCommitment)),
        },
      },
    }).submitPackageReopeningOrder(reopeningDraft, settlementDraft, async (bytes) => {
      reopeningSignedBytes = bytes;
      return new Uint8Array(sign(null, bytes, keys.privateKey));
    });
    assert.equal(queued.queuedForReopening, true);
    assert.deepEqual(reopeningSignedBytes, packageSettlementCommitmentBytes(reopeningCommitment));

    const amendment = {
      version: 1,
      executionClassId: CLASS,
      entryId: reopeningOrderId,
      participantId,
      expectedQuantity: reopeningOrder.quantity,
      expectedPriceTicks: reopeningOrder.limitPriceTicks,
      priceTicks: 99n,
    } as const;
    let amendmentSignedBytes: Uint8Array | undefined;
    const amendmentHash = toHex(packageBookAmendmentHash(amendment));
    const amended = await client({
      'POST /v1/package-book/amendments': {
        body: {
          amended: true,
          packageMarketId: CLASS,
          entryId: reopeningOrderId,
          amendmentHash,
          replayed: false,
          entry: { ...admission.entry, priceTicks: 99n },
        },
      },
    }).amendPackageBookOrder(amendment, async (bytes) => {
      amendmentSignedBytes = bytes;
      return new Uint8Array(sign(null, bytes, keys.privateKey));
    });
    assert.equal(amended.amendmentHash, amendmentHash);
    assert.deepEqual(amendmentSignedBytes, packageBookAmendmentBytes(amendment));

    await assert.rejects(
      client({ 'POST /v1/package-book/orders': { body: { accepted: true, packageMarketId: CLASS, orderId, replayed: false, allocation: matched.allocation, allocationHash: 'ff'.repeat(32), settlementCommitmentHash, matchingPolicy: policy } } })
        .submitPackageBookOrder(draft, settlementDraft, async (bytes) => new Uint8Array(sign(null, bytes, keys.privateKey))),
      /allocation hash is inconsistent/,
    );
  });

  test('verifies package reopening result and settlement evidence', async () => {
    let opening = setPackageBookHalted(emptyPackageBook(policy), true);
    opening = queuePackageReopeningOrder(policy, opening, order(1, { limitPriceTicks: 95n }), 1_000n).state;
    opening = queuePackageReopeningOrder(
      policy,
      opening,
      order(2, { side: 'BID', limitPriceTicks: 105n }),
      1_000n,
    ).state;
    const cleared = clearPackageReopeningAuction(policy, opening, id(800), id(900), 100n, 1_000n);
    const resultHash = toHex(packageReopeningResultHash(cleared.result));
    const settlementHandoff = packageReopeningSettlementHandoff({
      version: 1,
      reopeningResultHash: resultHash,
      executionClassId: CLASS,
      fills: cleared.result.fills.map((fill, index) => ({
        fillSequence: fill.fillSequence,
        bidEntryId: fill.bidEntryId,
        askEntryId: fill.askEntryId,
        bidSettlementCommitmentHash: id(100 + index),
        askSettlementCommitmentHash: id(200 + index),
        priceTicks: cleared.result.clearingPriceTicks!,
        quantity: fill.quantity,
      })),
    });
    const settlementHandoffHash = toHex(packageReopeningSettlementHandoffHash(settlementHandoff));
    const path = `/v1/package-book/reopenings/${resultHash}`;
    const verified = await client({
      [path]: {
        body: {
          result: cleared.result,
          resultHash,
          settlementHandoff,
          settlementHandoffHash,
        },
      },
    }).getPackageReopening(resultHash);
    assert.equal(verified.resultHash, resultHash);
    assert.equal(verified.settlementHandoffHash, settlementHandoffHash);
    await assert.rejects(
      client({ [path]: { body: { result: cleared.result, resultHash } } }).getPackageReopening(resultHash),
      /handoff presence is inconsistent/,
    );
  });

  test('a closed sealed auction must replay from its published events', async () => {
    const { openSealedAuction, sealedAuctionHash, sealedQuoteCommitment, replaySealedAuction } = await import('@naryx/protocol-types');
    const definition = {
      version: 1, auctionId: 'a-1', environment: 'local', orderHash: '55'.repeat(32), eligibleSolverIds: ['solver-a', 'solver-b'], timeUnit: 'EVM_UNIX_SECONDS' as const,
      commitDeadlineValue: 100n, revealDeadlineValue: 200n, settlementDeadlineValue: 300n, minimumValidReveals: 1,
    };
    const hash = sealedAuctionHash(definition);
    const opening = (solverId: string, net: bigint, fill: number) => ({ solverId, quoteHash: new Uint8Array(32).fill(fill), netOutcomeAtoms: net, salt: new Uint8Array(32).fill(fill + 1) });
    const events = [
      { kind: 'COMMIT' as const, solverId: 'solver-a', commitment: sealedQuoteCommitment(hash, opening('solver-a', 10n, 1)), atValue: 10n },
      { kind: 'COMMIT' as const, solverId: 'solver-b', commitment: sealedQuoteCommitment(hash, opening('solver-b', 20n, 2)), atValue: 11n },
      { kind: 'REVEAL' as const, ...opening('solver-a', 10n, 1), atValue: 110n },
      { kind: 'REVEAL' as const, ...opening('solver-b', 20n, 2), atValue: 111n },
    ];
    const { result } = replaySealedAuction(definition, events, 200n);
    assert.equal(openSealedAuction(definition).commitments.length, 0);
    const path = `/v1/auctions/sealed/${toHexString(hash)}`;
    const honest = await client({ [path]: { body: { phase: 'CLOSED', definition, result, events } } }).getSealedAuction(toHexString(hash));
    assert.equal(honest.phase, 'CLOSED');
    const swapped = { ...result, winner: result.ranked[1] };
    const forgedHash = replaySealedAuction(definition, events.slice(0, 3), 200n).result.resultHash;
    await assert.rejects(client({ [path]: { body: { phase: 'CLOSED', definition, result: { ...swapped, resultHash: forgedHash }, events } } }).getSealedAuction(toHexString(hash)), /does not replay/);

    // An honest hash with a swapped winner returns the replayed winner, never the served one.
    const relabeled = await client({ [path]: { body: { phase: 'CLOSED', definition, result: swapped, events } } }).getSealedAuction(toHexString(hash));
    assert.equal((relabeled.result as typeof result).winner?.solverId, result.winner?.solverId);

    // Another auction's full data served for this hash is refused, in any phase.
    const other = { ...definition, auctionId: 'a-2' };
    await assert.rejects(client({ [path]: { body: { phase: 'CLOSED', definition: other, result, events } } }).getSealedAuction(toHexString(hash)), /does not hash to the requested auction/);
    await assert.rejects(client({ [path]: { body: { phase: 'COMMIT', definition: other, commitmentCount: 0 } } }).getSealedAuction(toHexString(hash)), /does not hash to the requested auction/);
  });
});

function toHexString(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
