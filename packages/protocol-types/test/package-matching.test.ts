import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  RangeViolationError,
  addImpliedLiquidity,
  amendPackageBookEntry,
  cancelPackageBookEntry,
  deriveImpliedPackageQuote,
  emptyPackageBook,
  invalidateImpliedSource,
  matchPackageOrder,
  packageAllocationHash,
  packageBookLevels,
  packageBookCancellationBytes,
  packageBookCancellationHash,
  packageBookState,
  packageMatchingPolicy,
  packageMatchingPolicyBytes,
  packageMatchingPolicyHash,
  packageTakerOrderBytes,
  packageTakerOrderHash,
  setPackageBookHalted,
  toHex,
  verifyPackageAllocation,
  type PackageAllocation,
  type PackageBookState,
  type PackageMatchResult,
  type PackageMatchingPolicyInput,
  type PackageTakerOrderInput,
} from '../src/index.js';
import { loadFixture } from './fixtures.js';

const CLASS = 'sol-carry-atomic-v1';
const NOW = 1_000n;

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
const CARRY = [
  { numerator: 1n, denominator: 1n },
  { numerator: -1n, denominator: 1n },
];

function order(n: number, overrides: Partial<PackageTakerOrderInput> = {}): PackageTakerOrderInput {
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
      ? { settlementLeaseUntilValue: overrides.settlementLeaseUntilValue ?? NOW + 1_000n }
      : {}),
    ...overrides,
  };
}

function accepted(result: PackageMatchResult) {
  assert.equal(result.accepted, true, result.accepted ? '' : result.rejection);
  if (!result.accepted) throw new Error('unreachable');
  return result;
}

function rest(state: PackageBookState, ...orders: PackageTakerOrderInput[]): PackageBookState {
  return orders.reduce((book, input) => accepted(matchPackageOrder(policy, book, input, NOW)).state, state);
}

function amendmentFor(
  book: PackageBookState,
  entryId: string,
  changes: { readonly participantId?: string; readonly quantity?: bigint; readonly priceTicks?: bigint },
) {
  const entry = book.entries.find((candidate) => toHex(candidate.entryId) === entryId);
  if (entry === undefined) throw new Error('test entry is missing');
  return {
    version: 1,
    executionClassId: CLASS,
    entryId,
    participantId: changes.participantId ?? entry.participantId,
    expectedQuantity: entry.quantity,
    expectedPriceTicks: entry.priceTicks,
    ...(changes.quantity === undefined ? {} : { quantity: changes.quantity }),
    ...(changes.priceTicks === undefined ? {} : { priceTicks: changes.priceTicks }),
  } as const;
}

function impliedAsk(spot: number, perp: number, overrides: { quantity?: bigint; spotPrice?: bigint } = {}) {
  return deriveImpliedPackageQuote(policy, {
    executionClassId: CLASS,
    side: 'ASK',
    evidence: 'RESERVATION_BACKED_IMPLIED',
    legRatios: CARRY,
    legSources: [
      { sourceId: `spot-${spot}`, sourceVersion: 1n, side: 'ASK', priceTicks: overrides.spotPrice ?? 1_100n, quantity: overrides.quantity ?? 20n, reservationId: id(500 + spot) },
      { sourceId: `perp-${perp}`, sourceVersion: 1n, side: 'BID', priceTicks: 1_000n, quantity: 40n, reservationId: id(600 + perp) },
    ],
  });
}

function withImplied(state: PackageBookState, quote = impliedAsk(1, 1)): PackageBookState {
  return addImpliedLiquidity(policy, state, {
    quote,
    participantId: 'solver-a',
    commonControlGroupId: 'solver-group',
    nowValue: NOW,
  }).state;
}

describe('package matching policy', () => {
  test('canonical bytes and hash match the committed golden vector', () => {
    const fixture = loadFixture<{ bytesHex: string; hashHex: string }>('package-matching-policy.json');
    assert.equal(toHex(packageMatchingPolicyBytes(policy)), fixture.bytesHex);
    assert.equal(toHex(packageMatchingPolicyHash(policy)), fixture.hashHex);
  });

  test('unimplemented or inconsistent policies fail closed', () => {
    assert.equal(packageMatchingPolicy({ ...POLICY_INPUT, maximumImplicationDepth: 2 }).maximumImplicationDepth, 2);
    assert.throws(() => packageMatchingPolicy({ ...POLICY_INPUT, maximumImplicationDepth: 5 }), RangeViolationError);
    assert.throws(() => packageMatchingPolicy({ ...POLICY_INPUT, minimumExecutionQuantity: 15n }), MalformedInputError);
    assert.throws(() => packageMatchingPolicy({ ...POLICY_INPUT, quantityIncrement: 0n }), MalformedInputError);
    assert.throws(() => packageMatchingPolicy({ ...POLICY_INPUT, matchingPolicyVersion: 2 }), MalformedInputError);
    assert.throws(
      () => packageMatchingPolicy({ ...POLICY_INPUT, allocationRule: 'PRO_RATA' as never }),
      MalformedInputError,
    );
  });

  test('a book opened under one policy rejects another', () => {
    const other = packageMatchingPolicy({ ...POLICY_INPUT, selfMatchPolicy: 'CANCEL_BOTH' });
    assert.throws(() => matchPackageOrder(other, emptyPackageBook(policy), order(1), NOW), MalformedInputError);
  });
});

describe('package taker order authorization', () => {
  test('the order id is derived from every signed matching field', () => {
    const input = order(1);
    const hash = packageTakerOrderHash(input);
    assert.equal(hash.length, 32);
    assert.ok(packageTakerOrderBytes(input).length > 0);
    assert.notEqual(toHex(hash), toHex(packageTakerOrderHash({ ...input, quantity: 20n })));
    assert.notEqual(toHex(hash), toHex(packageTakerOrderHash({ ...input, participantId: 'another-maker' })));
    assert.notEqual(toHex(hash), toHex(packageTakerOrderHash({ ...input, settlementLeaseUntilValue: NOW + 2_000n })));
    assert.equal(toHex(hash), toHex(packageTakerOrderHash({ ...input, orderId: id(99) })));
  });

  test('GTC authorization requires a bounded settlement lease', () => {
    const withoutLease = { ...order(1) };
    delete withoutLease.settlementLeaseUntilValue;
    assert.throws(() => packageTakerOrderHash(withoutLease), MalformedInputError);
    assert.throws(
      () => packageTakerOrderHash(order(1, { timeInForce: 'IOC', settlementLeaseUntilValue: NOW + 1_000n })),
      MalformedInputError,
    );
    assert.throws(
      () => matchPackageOrder(policy, emptyPackageBook(policy), order(1, { settlementLeaseUntilValue: NOW }), NOW),
      MalformedInputError,
    );
  });

  test('cancellation authorization binds the market, entry, and participant', () => {
    const cancellation = { version: 1, executionClassId: CLASS, entryId: id(1), participantId: 'maker-1' };
    const hash = packageBookCancellationHash(cancellation);
    assert.ok(packageBookCancellationBytes(cancellation).length > 0);
    assert.notEqual(toHex(hash), toHex(packageBookCancellationHash({ ...cancellation, entryId: id(2) })));
    assert.notEqual(toHex(hash), toHex(packageBookCancellationHash({ ...cancellation, participantId: 'maker-2' })));
  });
});

describe('price-time priority and partial fills', () => {
  test('best price fills first, then time, at the resting price', () => {
    const book = rest(
      emptyPackageBook(policy),
      order(1, { limitPriceTicks: 105n }),
      order(2, { limitPriceTicks: 100n }),
      order(3, { limitPriceTicks: 100n }),
    );
    const result = accepted(
      matchPackageOrder(policy, book, order(9, { side: 'BID', limitPriceTicks: 110n, quantity: 30n, timeInForce: 'IOC', minimumQuantity: 10n }), NOW),
    );
    assert.deepEqual(
      result.allocation.fills.map((fill) => [toHex(fill.makerEntryId), fill.priceTicks, fill.makerSequence]),
      [
        [id(2), 100n, 2n],
        [id(3), 100n, 3n],
        [id(1), 105n, 1n],
      ],
    );
    assert.equal(result.allocation.internalMatchedQuantity, 30n);
    assert.equal(result.state.entries.length, 0);
    assert.equal(toHex(packageAllocationHash(result.allocation)), toHex(packageAllocationHash(result.allocation)));
  });

  test('a partial maker fill keeps its remainder and time priority', () => {
    const book = rest(emptyPackageBook(policy), order(1, { quantity: 50n }));
    const result = accepted(
      matchPackageOrder(policy, book, order(2, { side: 'BID', quantity: 20n, timeInForce: 'IOC' }), NOW),
    );
    assert.equal(result.allocation.fills[0]?.quantity, 20n);
    assert.deepEqual(
      result.state.entries.map((entry) => [entry.quantity, entry.sequence]),
      [[30n, 1n]],
    );
  });

  test('a GTC remainder rests at its limit and an IOC remainder cancels', () => {
    const book = rest(emptyPackageBook(policy), order(1, { quantity: 10n }));
    const gtc = accepted(matchPackageOrder(policy, book, order(2, { side: 'BID', quantity: 30n }), NOW));
    assert.equal(gtc.allocation.restedQuantity, 20n);
    assert.equal(gtc.state.entries[0]?.priceTicks, 100n);
    assert.equal(gtc.state.entries[0]?.expiresAtValue, NOW + 1_000n);
    const ioc = accepted(
      matchPackageOrder(policy, book, order(3, { side: 'BID', quantity: 30n, timeInForce: 'IOC' }), NOW),
    );
    assert.equal(ioc.allocation.cancelledQuantity, 20n);
    assert.equal(ioc.state.entries.length, 0);
  });

  test('fill-or-kill and minimum quantity reject without touching the book', () => {
    const book = rest(emptyPackageBook(policy), order(1, { quantity: 10n }));
    const fok = matchPackageOrder(
      policy,
      book,
      order(2, { side: 'BID', quantity: 20n, minimumQuantity: 20n, timeInForce: 'FOK' }),
      NOW,
    );
    assert.deepEqual([fok.accepted, fok.accepted ? '' : fok.rejection, fok.state], [false, 'FOK_UNFILLABLE', book]);
    const ioc = matchPackageOrder(
      policy,
      book,
      order(3, { side: 'BID', quantity: 20n, minimumQuantity: 20n, timeInForce: 'IOC' }),
      NOW,
    );
    assert.equal(ioc.accepted ? '' : ioc.rejection, 'MINIMUM_QUANTITY_UNFILLABLE');
  });

  test('order shape outside the policy is rejected', () => {
    const book = emptyPackageBook(policy);
    assert.throws(() => matchPackageOrder(policy, book, order(1, { quantity: 15n }), NOW), MalformedInputError);
    assert.throws(() => matchPackageOrder(policy, book, order(1, { minimumQuantity: 20n, quantity: 20n }), NOW), MalformedInputError);
    assert.throws(() => matchPackageOrder(policy, book, order(1, { timeInForce: 'FOK', quantity: 20n }), NOW), MalformedInputError);
    assert.throws(() => matchPackageOrder(policy, book, order(1, { orderType: 'CONDITIONAL' }), NOW), MalformedInputError);
    assert.throws(() => matchPackageOrder(policy, book, order(1, { executionClassId: 'other' }), NOW), MalformedInputError);
  });

  test('post-only rejects a crossing order and rests a passive one', () => {
    const book = rest(emptyPackageBook(policy), order(1));
    const crossing = matchPackageOrder(policy, book, order(2, { side: 'BID', orderType: 'POST_ONLY' }), NOW);
    assert.equal(crossing.accepted ? '' : crossing.rejection, 'POST_ONLY_WOULD_CROSS');
    const passive = accepted(
      matchPackageOrder(policy, book, order(3, { side: 'BID', orderType: 'POST_ONLY', limitPriceTicks: 99n }), NOW),
    );
    assert.equal(passive.allocation.restedQuantity, 10n);
  });

  test('halted books, duplicate orders, and expired entries', () => {
    const book = rest(emptyPackageBook(policy), order(1, { timeInForce: 'GTD', expiresAtValue: NOW + 5n }));
    const halted = matchPackageOrder(policy, setPackageBookHalted(book, true), order(2, { side: 'BID' }), NOW);
    assert.equal(halted.accepted ? '' : halted.rejection, 'HALTED');
    const duplicate = matchPackageOrder(policy, book, order(1, { side: 'BID' }), NOW);
    assert.equal(duplicate.accepted ? '' : duplicate.rejection, 'DUPLICATE_ORDER');
    const later = accepted(matchPackageOrder(policy, book, order(3, { side: 'BID' }), NOW + 5n));
    assert.deepEqual(later.expiredEntryIds.map(toHex), [id(1)]);
    assert.equal(later.allocation.fills.length, 0);
    assert.deepEqual(later.state.entries.map((entry) => toHex(entry.entryId)), [id(3)]);
  });
});

describe('self-match and common-control prevention', () => {
  const book = () => rest(emptyPackageBook(policy), order(1, { participantId: 'desk', limitPriceTicks: 99n }), order(2));
  const taker = (quantity: bigint) => order(9, { side: 'BID', quantity, participantId: 'desk' });

  test('cancel incoming stops matching and keeps the resting order', () => {
    const result = accepted(matchPackageOrder(policy, book(), taker(20n), NOW));
    assert.equal(result.allocation.fills.length, 0);
    assert.equal(result.allocation.cancelledQuantity, 20n);
    assert.equal(result.state.entries.length, 2);
  });

  test('cancel resting removes the own order and keeps matching', () => {
    const resting = packageMatchingPolicy({ ...POLICY_INPUT, selfMatchPolicy: 'CANCEL_RESTING' });
    let state = emptyPackageBook(resting);
    state = accepted(matchPackageOrder(resting, state, order(1, { participantId: 'desk', limitPriceTicks: 99n }), NOW)).state;
    state = accepted(matchPackageOrder(resting, state, order(2), NOW)).state;
    const result = accepted(matchPackageOrder(resting, state, taker(10n), NOW));
    assert.deepEqual(result.allocation.selfMatchCancelledEntryIds.map(toHex), [id(1)]);
    assert.deepEqual(result.allocation.fills.map((fill) => toHex(fill.makerEntryId)), [id(2)]);
    assert.equal(result.state.entries.length, 0);
  });

  test('a shared control group counts as self only when the policy says so', () => {
    const grouped = order(9, { side: 'BID', participantId: 'other', commonControlGroupId: 'group-2' });
    const book2 = rest(emptyPackageBook(policy), order(2));
    assert.equal(accepted(matchPackageOrder(policy, book2, grouped, NOW)).allocation.fills.length, 0);
    const open = packageMatchingPolicy({ ...POLICY_INPUT, commonControlAsSelf: false });
    let state = emptyPackageBook(open);
    state = accepted(matchPackageOrder(open, state, order(2), NOW)).state;
    assert.equal(accepted(matchPackageOrder(open, state, grouped, NOW)).allocation.fills.length, 1);
  });
});

describe('implied liquidity', () => {
  test('derivation rounds every leg against the taker and floors depth to the increment', () => {
    const third = [{ numerator: 1n, denominator: 3n }];
    const derive = (side: 'ASK' | 'BID') =>
      deriveImpliedPackageQuote(policy, {
        executionClassId: CLASS,
        side,
        evidence: 'SOLVER_BACKED_IMPLIED',
        legRatios: third,
        legSources: [{ sourceId: 'spot-1', sourceVersion: 1n, side, priceTicks: 10n, quantity: 11n }],
        solverCommitment: id(77),
      });
    assert.equal(derive('ASK').priceTicks, 4n);
    assert.equal(derive('BID').priceTicks, 3n);
    assert.equal(derive('ASK').quantity, 30n);
    assert.equal(impliedAsk(1, 1).priceTicks, 100n);
    assert.equal(impliedAsk(1, 1).quantity, 20n);
  });

  test('derivation rejects wrong sides, missing backing, and zero depth', () => {
    const base = {
      executionClassId: CLASS,
      side: 'ASK' as const,
      evidence: 'RESERVATION_BACKED_IMPLIED' as const,
      legRatios: CARRY,
    };
    const spot = { sourceId: 'spot-1', sourceVersion: 1n, side: 'ASK' as const, priceTicks: 1n, quantity: 10n, reservationId: id(1) };
    const perp = { sourceId: 'perp-1', sourceVersion: 1n, side: 'BID' as const, priceTicks: 1n, quantity: 10n, reservationId: id(2) };
    assert.throws(() => deriveImpliedPackageQuote(policy, { ...base, legSources: [spot, { ...perp, side: 'ASK' }] }), MalformedInputError);
    const { reservationId: _omitted, ...unreserved } = perp;
    assert.throws(() => deriveImpliedPackageQuote(policy, { ...base, legSources: [spot, unreserved] }), MalformedInputError);
    assert.throws(() => deriveImpliedPackageQuote(policy, { ...base, legSources: [spot, { ...perp, quantity: 9n }] }), MalformedInputError);
    assert.throws(() => deriveImpliedPackageQuote(policy, { ...base, legSources: [spot, { ...perp, sourceId: 'spot-1' }] }));
    assert.throws(
      () => deriveImpliedPackageQuote(policy, { ...base, evidence: 'SOLVER_BACKED_IMPLIED', legSources: [spot, perp] }),
      MalformedInputError,
    );
  });

  test('direct liquidity fills before implied liquidity at one price', () => {
    const book = rest(withImplied(emptyPackageBook(policy)), order(1));
    const result = accepted(
      matchPackageOrder(policy, book, order(9, { side: 'BID', quantity: 30n, timeInForce: 'IOC' }), NOW),
    );
    assert.deepEqual(result.allocation.fills.map((fill) => fill.makerSource), ['DIRECT', 'IMPLIED']);
    assert.equal(result.allocation.internalMatchedQuantity, 10n);
    assert.equal(result.allocation.externalImpliedQuantity, 20n);
    assert.equal(result.allocation.fills[1]?.consumedSourceKeys.length, 2);
  });

  test('implied liquidity fills whole or not at all', () => {
    const book = withImplied(emptyPackageBook(policy));
    const result = accepted(matchPackageOrder(policy, book, order(9, { side: 'BID', quantity: 10n }), NOW));
    assert.equal(result.allocation.fills.length, 0);
    assert.equal(result.allocation.cancelledQuantity, 10n);
    assert.equal(result.state.entries.length, 1);
  });

  test('a consumed source is spent once and invalidates every sibling built on it', () => {
    let book = withImplied(emptyPackageBook(policy), impliedAsk(1, 1));
    book = withImplied(book, impliedAsk(1, 2, { spotPrice: 1_101n }));
    const result = accepted(
      matchPackageOrder(policy, book, order(9, { side: 'BID', quantity: 20n, limitPriceTicks: 110n, timeInForce: 'IOC' }), NOW),
    );
    assert.equal(result.allocation.fills.length, 1);
    assert.equal(result.allocation.invalidatedEntryIds.length, 1);
    assert.equal(result.state.entries.length, 0);
    assert.equal(result.state.consumedSourceKeys.length, 2);
    assert.throws(() => withImplied(result.state, impliedAsk(1, 3)), /already consumed/);
  });

  test('a source version change invalidates stale descendants only', () => {
    let book = withImplied(emptyPackageBook(policy), impliedAsk(1, 1));
    book = withImplied(book, impliedAsk(2, 2, { spotPrice: 1_102n }));
    const { state, invalidatedEntryIds } = invalidateImpliedSource(book, 'spot-1', 2n);
    assert.equal(invalidatedEntryIds.length, 1);
    assert.equal(toHex(invalidatedEntryIds[0] as Uint8Array), toHex(impliedAsk(1, 1).entryId));
    assert.equal(state.entries.length, 1);
    assert.equal(invalidateImpliedSource(state, 'spot-2', 1n).invalidatedEntryIds.length, 0);
  });

  test('admission rejects indicative, crossing, duplicate, and self-derived implication', () => {
    const indicative = deriveImpliedPackageQuote(policy, {
      executionClassId: CLASS,
      side: 'ASK',
      evidence: 'INDICATIVE_IMPLIED',
      legRatios: CARRY,
      legSources: [
        { sourceId: 'spot-1', sourceVersion: 1n, side: 'ASK', priceTicks: 1_100n, quantity: 20n },
        { sourceId: 'perp-1', sourceVersion: 1n, side: 'BID', priceTicks: 1_000n, quantity: 20n },
      ],
    });
    assert.throws(() => withImplied(emptyPackageBook(policy), indicative), /never counts as executable/);
    const withBid = rest(emptyPackageBook(policy), order(1, { side: 'BID', limitPriceTicks: 100n }));
    assert.throws(() => withImplied(withBid), /cannot cross the book/);
    const once = withImplied(emptyPackageBook(policy));
    assert.throws(() => withImplied(once), /already in the book/);
    const resting = rest(emptyPackageBook(policy), order(1, { limitPriceTicks: 500n }));
    const selfDerived = deriveImpliedPackageQuote(policy, {
      executionClassId: CLASS,
      side: 'ASK',
      evidence: 'SOLVER_BACKED_IMPLIED',
      legRatios: [{ numerator: 1n, denominator: 1n }],
      legSources: [{ sourceId: id(1), sourceVersion: 1n, side: 'ASK', priceTicks: 600n, quantity: 10n }],
      solverCommitment: id(88),
    });
    assert.throws(() => withImplied(resting, selfDerived), /cannot source another implied package/);
  });

  test('admission rejects an implied quote whose identity was forged', () => {
    const quote = impliedAsk(1, 1);
    assert.throws(
      () => withImplied(emptyPackageBook(policy), { ...quote, priceTicks: quote.priceTicks + 1n }),
      /entry id does not bind/,
    );
  });
});

describe('book state validation', () => {
  test('loaded state must match its policy and every entry invariant', () => {
    const book = withImplied(rest(emptyPackageBook(policy), order(1, { limitPriceTicks: 90n })));
    assert.deepEqual(packageBookState(policy, book), book);
    const [direct, implied] = book.entries as [never, never];
    const broken = (change: Partial<PackageBookState>) => () => packageBookState(policy, { ...book, ...change });
    assert.throws(broken({ entries: [direct, direct] }), /repeats/);
    assert.throws(broken({ nextSequence: 2n }), /not yet assigned/);
    assert.throws(broken({ entries: [{ ...(direct as object), minimumFillQuantity: 20n } as never] }), /minimum fill/);
    assert.throws(broken({ entries: [{ ...(direct as object), source: 'IMPLIED' } as never] }), /implication metadata/);
    const indicative = { ...(implied as { implied: object }).implied, evidence: 'INDICATIVE_IMPLIED' };
    assert.throws(broken({ entries: [{ ...(implied as object), implied: indicative } as never] }), /never counts/);
    assert.throws(broken({ consumedSourceKeys: ['AB'.repeat(32)] }), /lowercase/);
    assert.throws(broken({ matchingPolicyHash: id(3) as never }), /another matching policy/);
  });
});

describe('amendment and cancellation authority', () => {
  test('a size reduction keeps priority while a price change or increase loses it', () => {
    const book = rest(emptyPackageBook(policy), order(1, { quantity: 30n }), order(2, { limitPriceTicks: 101n }));
    const reduced = amendPackageBookEntry(policy, book, amendmentFor(book, id(1), { quantity: 20n }));
    assert.equal(reduced.entries.find((entry) => toHex(entry.entryId) === id(1))?.sequence, 1n);
    const repriced = amendPackageBookEntry(policy, book, amendmentFor(book, id(1), { priceTicks: 102n }));
    assert.equal(repriced.entries.find((entry) => toHex(entry.entryId) === id(1))?.sequence, 3n);
    const increased = amendPackageBookEntry(policy, book, amendmentFor(book, id(1), { quantity: 40n }));
    assert.equal(increased.entries.find((entry) => toHex(entry.entryId) === id(1))?.sequence, 3n);
  });

  test('only the owner may amend or cancel, and implied entries are never amended', () => {
    const book = withImplied(rest(emptyPackageBook(policy), order(1, { limitPriceTicks: 90n })));
    assert.throws(() => cancelPackageBookEntry(book, id(1), 'someone-else'), /only the entry owner/);
    assert.throws(() => amendPackageBookEntry(policy, book, amendmentFor(book, id(1), { participantId: 'x', quantity: 20n })), /only the entry owner/);
    assert.equal(cancelPackageBookEntry(book, id(1), 'maker-1').entries.length, 1);
    const implied = toHex(impliedAsk(1, 1).entryId);
    assert.throws(() => amendPackageBookEntry(policy, book, amendmentFor(book, implied, { quantity: 10n })), /never amended/);
  });

  test('an amendment cannot cross the book', () => {
    const book = rest(emptyPackageBook(policy), order(1, { side: 'BID', limitPriceTicks: 90n }), order(2));
    assert.throws(
      () => amendPackageBookEntry(policy, book, amendmentFor(book, id(1), { priceTicks: 100n })),
      /cannot cross/,
    );
  });
});

describe('allocation evidence', () => {
  const book = rest(withImplied(emptyPackageBook(policy)), order(1), order(2, { limitPriceTicks: 101n }));
  const { allocation } = accepted(
    matchPackageOrder(policy, book, order(9, { side: 'BID', quantity: 40n, limitPriceTicks: 101n, timeInForce: 'IOC' }), NOW),
  );
  const tamper = (change: (value: PackageAllocation) => PackageAllocation) => () =>
    verifyPackageAllocation(policy, change(allocation));

  test('a genuine allocation verifies', () => {
    verifyPackageAllocation(policy, allocation);
    assert.equal(allocation.fills.length, 3);
  });

  test('the taker identity is bound, so a self-match fill cannot verify', () => {
    const [first, ...rest] = allocation.fills as [PackageAllocation['fills'][number], ...PackageAllocation['fills']];
    assert.throws(tamper((value) => ({ ...value, fills: [{ ...first, makerParticipantId: value.takerParticipantId }, ...rest] })), /against itself/);
    if (policy.commonControlAsSelf) {
      assert.throws(
        tamper((value) => ({ ...value, fills: [{ ...first, makerCommonControlGroupId: value.takerCommonControlGroupId }, ...rest] })),
        /against itself/,
      );
    }
    assert.notEqual(toHex(packageAllocationHash(allocation)), toHex(packageAllocationHash({ ...allocation, takerParticipantId: 'someone-else' as PackageAllocation['takerParticipantId'] })));
  });

  test('conservation, priority, and single consumption tampering is rejected', () => {
    const [first, second, third] = allocation.fills as [never, never, never];
    assert.throws(tamper((value) => ({ ...value, cancelledQuantity: 10n })), /not conserved/);
    assert.throws(tamper((value) => ({ ...value, internalMatchedQuantity: 30n })), /partition/);
    assert.throws(
      tamper((value) => ({
        ...value,
        fills: [
          { ...(second as object), fillSequence: value.firstFillSequence } as never,
          { ...(first as object), fillSequence: value.firstFillSequence + 1n } as never,
          third,
        ],
      })),
      /direct liquidity must fill before implied/,
    );
    assert.throws(
      tamper((value) => ({
        ...value,
        fills: [first, second, { ...(third as object), consumedSourceKeys: (second as { consumedSourceKeys: unknown }).consumedSourceKeys, makerSource: 'IMPLIED' } as never],
      })),
      /consumed twice/,
    );
    assert.throws(tamper((value) => ({ ...value, takerLimitPriceTicks: 100n })), /taker limit/);
    assert.throws(tamper((value) => ({ ...value, matchingPolicyHash: id(5) as never })), /another matching policy/);
  });
});

describe('seeded invariant run', () => {
  test('every step conserves quantity and leaves the book uncrossed', () => {
    let seed = 42n;
    const next = (modulus: bigint): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      return (seed >> 33n) % modulus;
    };
    let book = emptyPackageBook(policy);
    for (let step = 1; step <= 300; step += 1) {
      const makerQuantityBefore = book.entries.reduce((sum, entry) => sum + entry.quantity, 0n);
      const quantity = (next(5n) + 1n) * 10n;
      const tif = next(3n) === 1n ? 'IOC' : 'GTC';
      const result = matchPackageOrder(
        policy,
        book,
        order(step, {
          side: next(2n) === 0n ? 'BID' : 'ASK',
          limitPriceTicks: 95n + next(11n),
          quantity,
          timeInForce: tif,
          participantId: `p-${next(6n)}`,
          commonControlGroupId: `g-${next(6n)}`,
        }),
        NOW,
      );
      if (!result.accepted) continue;
      const { allocation, state } = result;
      verifyPackageAllocation(policy, allocation);
      const filled = allocation.fills.reduce((sum, fill) => sum + fill.quantity, 0n);
      const removedBySelfMatch = book.entries
        .filter((entry) => allocation.selfMatchCancelledEntryIds.some((cancelled) => toHex(cancelled) === toHex(entry.entryId)))
        .reduce((sum, entry) => sum + entry.quantity, 0n);
      const makerQuantityAfter = state.entries.reduce((sum, entry) => sum + entry.quantity, 0n);
      assert.equal(makerQuantityAfter, makerQuantityBefore - filled - removedBySelfMatch + allocation.restedQuantity);
      const bestBid = packageBookLevels(state, 'BID', NOW)[0]?.priceTicks;
      const bestAsk = packageBookLevels(state, 'ASK', NOW)[0]?.priceTicks;
      if (bestBid !== undefined && bestAsk !== undefined) assert.equal(bestBid < bestAsk, true);
      book = state;
    }
  });
});
