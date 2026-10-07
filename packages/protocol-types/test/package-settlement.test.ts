import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  emptyPackageBook,
  MalformedInputError,
  matchPackageOrder,
  packageAllocationHash,
  packageMatchingPolicy,
  packageSettlementCommitment,
  packageSettlementCommitmentHash,
  packageSettlementHandoff,
  packageSettlementHandoffHash,
  packageSettlementReadiness,
  packageSettlementReadinessHash,
  packageQuoteExecutionBinding,
  packageQuoteExecutionBindingHash,
  toHex,
  verifyPackageSettlementHandoff,
} from '../src/index.js';

const hash = (byte: string): string => byte.repeat(64);

const commitment = {
  version: 1,
  environment: 'testnet',
  executionClassId: 'sol-carry-atomic-v1',
  packageOrderId: hash('1'),
  strategyOrderHash: hash('2'),
  graphHash: hash('3'),
  participantId: 'participant-a',
  settlementAccount: 'settlement-a',
  quantity: 10n,
  validUntilUnit: 'SOLANA_SLOT' as const,
  validUntilValue: 2_000n,
};

test('settlement commitments bind package and strategy identities', () => {
  const checked = packageSettlementCommitment(commitment);
  assert.equal(checked.quantity, 10n);
  assert.equal(toHex(packageSettlementCommitmentHash(checked)).length, 64);
  assert.throws(() => packageSettlementCommitment({ ...commitment, quantity: 0n }), MalformedInputError);
});

test('settlement handoffs bind every direct fill to a maker commitment', () => {
  const handoff = packageSettlementHandoff({
    version: 1,
    allocationHash: hash('4'),
    executionClassId: commitment.executionClassId,
    takerSettlementCommitmentHash: packageSettlementCommitmentHash(commitment),
    fills: [{
      fillSequence: 1n,
      makerEntryId: hash('5'),
      makerSource: 'DIRECT',
      priceTicks: 100n,
      quantity: 10n,
      makerSettlementCommitmentHash: hash('6'),
    }],
  });
  assert.equal(handoff.fills.length, 1);
  assert.equal(toHex(packageSettlementHandoffHash(handoff)).length, 64);
  const directFill = handoff.fills[0]!;
  assert.throws(
    () => packageSettlementHandoff({
      ...handoff,
      fills: [{
        fillSequence: directFill.fillSequence,
        makerEntryId: directFill.makerEntryId,
        makerSource: directFill.makerSource,
        priceTicks: directFill.priceTicks,
        quantity: directFill.quantity,
      }],
    }),
    MalformedInputError,
  );
});

test('implied fills cannot pretend to have a direct settlement commitment', () => {
  assert.throws(
    () => packageSettlementHandoff({
      version: 1,
      allocationHash: hash('4'),
      executionClassId: commitment.executionClassId,
      takerSettlementCommitmentHash: hash('7'),
      fills: [{
        fillSequence: 1n,
        makerEntryId: hash('8'),
        makerSource: 'IMPLIED',
        priceTicks: 100n,
        quantity: 10n,
        makerSettlementCommitmentHash: hash('9'),
      }],
    }),
    MalformedInputError,
  );
});

test('settlement readiness conserves quantity and canonicalizes allocation evidence', () => {
  const readiness = packageSettlementReadiness({
    version: 1,
    packageOrderId: hash('1'),
    settlementCommitmentHash: hash('2'),
    strategyOrderHash: hash('3'),
    executionClassId: commitment.executionClassId,
    committedQuantity: 10n,
    allocatedQuantity: 10n,
    remainingQuantity: 0n,
    acceptsFurtherMatches: false,
    status: 'READY_FOR_OWNER_AUTHORIZATION',
    allocationHashes: [hash('5'), hash('4')],
  });
  assert.deepEqual(readiness.allocationHashes.map(toHex), [hash('4'), hash('5')]);
  assert.equal(toHex(packageSettlementReadinessHash(readiness)).length, 64);
  assert.throws(
    () => packageSettlementReadiness({
      ...readiness,
      allocatedQuantity: 5n,
      remainingQuantity: 4n,
    }),
    MalformedInputError,
  );
  assert.throws(
    () => packageSettlementReadiness({
      ...readiness,
      status: 'PARTIAL_AUTHORIZATION_REQUIRED',
    }),
    MalformedInputError,
  );
});

test('execution bindings commit the final package market state to one strategy quote', () => {
  const binding = packageQuoteExecutionBinding({
    version: 1,
    packageOrderId: hash('1'),
    settlementReadinessHash: hash('2'),
    strategyOrderHash: hash('3'),
    strategyQuoteHash: hash('4'),
    routeHash: hash('5'),
    executionClassId: commitment.executionClassId,
    solverId: 'solver-a',
    validUntilUnit: 'SOLANA_SLOT',
    validUntilValue: 2_000n,
    solverSignatureScheme: 'ED25519',
    solverVerificationKey: new Uint8Array(32).fill(6),
    signature: new Uint8Array(64).fill(7),
  });
  assert.equal(toHex(packageQuoteExecutionBindingHash(binding)).length, 64);
  assert.notEqual(
    toHex(packageQuoteExecutionBindingHash(binding)),
    toHex(packageQuoteExecutionBindingHash({ ...binding, settlementReadinessHash: hash('8') })),
  );
  assert.throws(() => packageQuoteExecutionBinding({ ...binding, validUntilValue: 0n }), MalformedInputError);
});

test('settlement handoffs reproduce the matched allocation exactly', () => {
  const policy = packageMatchingPolicy({
    matchingPolicyVersion: 1,
    environment: 'testnet',
    executionClassId: commitment.executionClassId,
    allocationRule: 'PRICE_TIME',
    directVersusImpliedPriority: 'DIRECT_FIRST',
    selfMatchPolicy: 'CANCEL_INCOMING',
    commonControlAsSelf: true,
    amendmentPriorityRule: 'RETAIN_ON_SIZE_REDUCTION',
    quantityIncrement: 10n,
    minimumExecutionQuantity: 10n,
    maximumImplicationDepth: 1,
  });
  const maker = {
    orderId: hash('5'),
    executionClassId: commitment.executionClassId,
    side: 'ASK' as const,
    orderType: 'LIMIT' as const,
    timeInForce: 'GTD' as const,
    limitPriceTicks: 100n,
    quantity: 10n,
    minimumQuantity: 10n,
    participantId: 'maker',
    commonControlGroupId: 'maker',
    expiresAtValue: 2_000n,
  };
  const rested = matchPackageOrder(policy, emptyPackageBook(policy), maker, 1_000n);
  if (!rested.accepted) assert.fail('maker was rejected');
  const taker = {
    orderId: hash('6'),
    executionClassId: commitment.executionClassId,
    side: 'BID' as const,
    orderType: 'LIMIT' as const,
    timeInForce: 'IOC' as const,
    limitPriceTicks: 100n,
    quantity: 10n,
    minimumQuantity: 10n,
    participantId: 'taker',
    commonControlGroupId: 'taker',
  };
  const matched = matchPackageOrder(policy, rested.state, taker, 1_000n);
  if (!matched.accepted) assert.fail('taker was rejected');
  const handoff = packageSettlementHandoff({
    version: 1,
    allocationHash: packageAllocationHash(matched.allocation),
    executionClassId: commitment.executionClassId,
    takerSettlementCommitmentHash: hash('7'),
    fills: matched.allocation.fills.map((fill) => ({
      fillSequence: fill.fillSequence,
      makerEntryId: fill.makerEntryId,
      makerSource: fill.makerSource,
      priceTicks: fill.priceTicks,
      quantity: fill.quantity,
      makerSettlementCommitmentHash: hash('8'),
    })),
  });
  verifyPackageSettlementHandoff(matched.allocation, handoff);
  assert.throws(
    () => verifyPackageSettlementHandoff(matched.allocation, {
      ...handoff,
      fills: handoff.fills.map((fill) => ({ ...fill, priceTicks: fill.priceTicks + 1n })),
    }),
    MalformedInputError,
  );
});
