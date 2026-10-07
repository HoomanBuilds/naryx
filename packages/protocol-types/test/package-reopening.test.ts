import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  clearPackageReopeningAuction,
  emptyPackageBook,
  packageMatchingPolicy,
  packageReopeningResultHash,
  packageReopeningSnapshotHash,
  queuePackageReopeningOrder,
  setPackageBookHalted,
  toHex,
  verifyPackageReopeningResult,
  type PackageMatchingPolicyInput,
  type PackageTakerOrderInput,
} from '../src/index.js';

const CLASS = 'sol-carry-atomic';
const NOW = 1_000n;
const id = (value: number): string => value.toString(16).padStart(64, '0');
const POLICY: PackageMatchingPolicyInput = {
  matchingPolicyVersion: 1,
  environment: 'testnet',
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

function order(
  n: number,
  side: 'BID' | 'ASK',
  priceTicks: bigint,
  quantity: bigint,
  participantId = `participant-${n}`,
): PackageTakerOrderInput {
  return {
    orderId: id(n),
    executionClassId: CLASS,
    side,
    orderType: 'LIMIT',
    timeInForce: 'GTC',
    limitPriceTicks: priceTicks,
    quantity,
    minimumQuantity: 10n,
    participantId,
    commonControlGroupId: participantId,
    settlementLeaseUntilValue: NOW + 1_000n,
  };
}

function queue(
  state: ReturnType<typeof emptyPackageBook>,
  ...orders: readonly PackageTakerOrderInput[]
) {
  const policy = packageMatchingPolicy(POLICY);
  return orders.reduce(
    (current, next) => queuePackageReopeningOrder(policy, current, next, NOW).state,
    state,
  );
}

describe('package reopening auction', () => {
  test('clears every compatible order at one deterministic uniform price', () => {
    const policy = packageMatchingPolicy(POLICY);
    const opening = queue(
      setPackageBookHalted(emptyPackageBook(policy), true),
      order(1, 'ASK', 95n, 20n),
      order(2, 'ASK', 97n, 10n),
      order(3, 'BID', 105n, 10n),
      order(4, 'BID', 103n, 20n),
    );
    const snapshotHash = packageReopeningSnapshotHash(policy, opening);
    const cleared = clearPackageReopeningAuction(policy, opening, id(900), 100n, NOW);

    assert.equal(toHex(cleared.result.openingSnapshotHash), toHex(snapshotHash));
    assert.equal(cleared.result.clearingPriceTicks, 100n);
    assert.equal(cleared.result.executedQuantity, 30n);
    assert.deepEqual(
      cleared.result.fills.map((fill) => [toHex(fill.bidEntryId), toHex(fill.askEntryId), fill.quantity]),
      [[id(3), id(1), 10n], [id(4), id(1), 10n], [id(4), id(2), 10n]],
    );
    assert.equal(cleared.state.halted, false);
    assert.equal(cleared.state.entries.length, 0);
    assert.equal(toHex(cleared.resultHash), toHex(packageReopeningResultHash(cleared.result)));
    assert.doesNotThrow(() => verifyPackageReopeningResult(policy, opening, id(900), 100n, NOW, cleared.result));
    assert.throws(
      () => verifyPackageReopeningResult(policy, opening, id(900), 100n, NOW, { ...cleared.result, clearingPriceTicks: 101n }),
      MalformedInputError,
    );
  });

  test('applies self-match cancellation before allocating the next participant', () => {
    const policy = packageMatchingPolicy(POLICY);
    const opening = queue(
      setPackageBookHalted(emptyPackageBook(policy), true),
      order(1, 'ASK', 95n, 10n, 'same-owner'),
      order(2, 'BID', 105n, 10n, 'same-owner'),
      order(3, 'BID', 104n, 10n, 'external-owner'),
    );
    const cleared = clearPackageReopeningAuction(policy, opening, id(901), 100n, NOW);
    assert.deepEqual(cleared.result.selfMatchCancelledEntryIds.map(toHex), [id(2)]);
    assert.deepEqual(cleared.result.fills.map((fill) => [toHex(fill.bidEntryId), toHex(fill.askEntryId)]), [[id(3), id(1)]]);
  });

  test('uses self-match prevention to reopen an otherwise self-crossed book', () => {
    const policy = packageMatchingPolicy(POLICY);
    const opening = queue(
      setPackageBookHalted(emptyPackageBook(policy), true),
      order(1, 'ASK', 95n, 10n, 'same-owner'),
      order(2, 'BID', 105n, 10n, 'same-owner'),
    );
    const cleared = clearPackageReopeningAuction(policy, opening, id(902), 100n, NOW);

    assert.equal(cleared.result.executedQuantity, 0n);
    assert.equal(cleared.result.clearingPriceTicks, undefined);
    assert.deepEqual(cleared.result.selfMatchCancelledEntryIds.map(toHex), [id(2)]);
    assert.deepEqual(cleared.state.entries.map((entry) => toHex(entry.entryId)), [id(1)]);
    assert.equal(cleared.state.halted, false);
  });

  test('collection is available only while halted and only for fully restable orders', () => {
    const policy = packageMatchingPolicy(POLICY);
    const open = emptyPackageBook(policy);
    assert.throws(() => queuePackageReopeningOrder(policy, open, order(1, 'BID', 100n, 10n), NOW), MalformedInputError);
    assert.throws(
      () => queuePackageReopeningOrder(
        policy,
        setPackageBookHalted(open, true),
        { ...order(2, 'BID', 100n, 10n), timeInForce: 'IOC', settlementLeaseUntilValue: undefined } as never,
        NOW,
      ),
      MalformedInputError,
    );
  });
});
