import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetRef,
  commitmentHash,
  manifestHash,
  nativeClearingMatchAuthorization,
  nativeClearingPolicy,
  packageAllocation,
  packageAllocationHash,
  packageMatchingPolicy,
  packageMatchingPolicyHash,
  packageSettlementCommitment,
  packageSettlementCommitmentHash,
  packageSettlementHandoff,
  protocolId,
  versionedManifestRef,
  type PackageLiquiditySource,
} from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');

function fixture(source: PackageLiquiditySource = 'DIRECT') {
  const matchingPolicy = packageMatchingPolicy({
    matchingPolicyVersion: 1,
    environment: 'devnet',
    executionClassId: 'sol-carry-package',
    allocationRule: 'PRICE_TIME',
    directVersusImpliedPriority: 'DIRECT_FIRST',
    selfMatchPolicy: 'CANCEL_INCOMING',
    commonControlAsSelf: true,
    amendmentPriorityRule: 'RETAIN_ON_SIZE_REDUCTION',
    quantityIncrement: 10n,
    minimumExecutionQuantity: 10n,
    maximumImplicationDepth: 2,
  });
  const policy = nativeClearingPolicy({
    version: 1,
    clearingDomainId: 'sol-carry-clearing',
    environment: matchingPolicy.environment,
    executionClassId: matchingPolicy.executionClassId,
    matchingPolicyHash: packageMatchingPolicyHash(matchingPolicy),
    strategySeries: versionedManifestRef('sol-carry', 1, id(1)),
    riskDomainId: 'sol-carry-isolated-risk',
    accountingAsset: assetRef('usdc', id(2), 6),
    packageQuantityIncrementAtoms: 10n,
    priceTickQuoteAtoms: 1n,
    initialMarginQuoteAtomsPerIncrement: 200n,
    maintenanceMarginQuoteAtomsPerIncrement: 100n,
    maximumPositionAtoms: 1_000n,
    maximumOpenInterestAtoms: 10_000n,
    maximumDefaultTransferDiscountBps: 500n,
    markMaximumStalenessMs: 5_000n,
  });
  const allocation = packageAllocation({
    version: 1,
    environment: matchingPolicy.environment,
    executionClassId: matchingPolicy.executionClassId,
    matchingPolicyHash: manifestHash(packageMatchingPolicyHash(matchingPolicy)),
    takerOrderId: commitmentHash(id(10)),
    takerParticipantId: protocolId('taker'),
    takerCommonControlGroupId: protocolId('taker-group'),
    takerSide: 'BID',
    takerTimeInForce: 'IOC',
    takerLimitPriceTicks: 1_000n,
    requestedQuantity: 10n,
    firstFillSequence: 1n,
    fills: Object.freeze([{
      fillSequence: 1n,
      makerEntryId: commitmentHash(id(11)),
      makerSource: source,
      makerSequence: 1n,
      makerParticipantId: protocolId('maker'),
      makerCommonControlGroupId: protocolId('maker-group'),
      priceTicks: 1_000n,
      quantity: 10n,
      consumedSourceKeys: source === 'DIRECT' ? Object.freeze([]) : Object.freeze([commitmentHash(id(12))]),
    }]),
    restedQuantity: 0n,
    cancelledQuantity: 0n,
    selfMatchCancelledEntryIds: Object.freeze([]),
    invalidatedEntryIds: Object.freeze([]),
    internalMatchedQuantity: source === 'DIRECT' ? 10n : 0n,
    externalImpliedQuantity: source === 'IMPLIED' ? 10n : 0n,
  });
  const taker = packageSettlementCommitment({
    version: 1,
    environment: matchingPolicy.environment,
    executionClassId: matchingPolicy.executionClassId,
    packageOrderId: allocation.takerOrderId,
    strategyOrderHash: id(20),
    graphHash: id(21),
    participantId: 'taker',
    settlementAccount: 'account-taker',
    quantity: 10n,
    validUntilUnit: 'SOLANA_SLOT',
    validUntilValue: 100n,
  });
  const maker = packageSettlementCommitment({
    version: 1,
    environment: matchingPolicy.environment,
    executionClassId: matchingPolicy.executionClassId,
    packageOrderId: allocation.fills[0]!.makerEntryId,
    strategyOrderHash: id(20),
    graphHash: id(21),
    participantId: 'maker',
    settlementAccount: 'account-maker',
    quantity: 10n,
    validUntilUnit: 'SOLANA_SLOT',
    validUntilValue: 90n,
  });
  const handoff = packageSettlementHandoff({
    version: 1,
    allocationHash: packageAllocationHash(allocation),
    executionClassId: matchingPolicy.executionClassId,
    takerSettlementCommitmentHash: packageSettlementCommitmentHash(taker),
    fills: [{
      fillSequence: 1n,
      makerEntryId: allocation.fills[0]!.makerEntryId,
      makerSource: source,
      priceTicks: 1_000n,
      quantity: 10n,
      ...(source === 'DIRECT' ? { makerSettlementCommitmentHash: packageSettlementCommitmentHash(maker) } : {}),
    }],
  });
  return { policy, matchingPolicy, allocation, handoff, taker, maker };
}

test('native clearing authorization derives exact clearing sides from verified package evidence', () => {
  const value = fixture();
  const authorization = nativeClearingMatchAuthorization({
    ...value,
    takerSettlementCommitment: value.taker,
    makerSettlementCommitment: value.maker,
    fillSequence: 1n,
    currentExpiryUnit: 'SOLANA_SLOT',
    currentExpiryValue: 50n,
  });
  assert.equal(authorization.longAccountId, 'account-taker');
  assert.equal(authorization.shortAccountId, 'account-maker');
  assert.equal(authorization.quantityAtoms, 10n);
  assert.equal(authorization.priceTicks, 1_000n);
  assert.equal(authorization.validUntilValue, 90n);
});

test('native clearing authorization rejects implied fills, mismatched commitments, and expiry', () => {
  const implied = fixture('IMPLIED');
  assert.throws(() => nativeClearingMatchAuthorization({
    ...implied,
    takerSettlementCommitment: implied.taker,
    makerSettlementCommitment: implied.maker,
    fillSequence: 1n,
    currentExpiryUnit: 'SOLANA_SLOT',
    currentExpiryValue: 50n,
  }), /requires a direct package fill/);

  const direct = fixture();
  const wrongMaker = packageSettlementCommitment({
    ...direct.maker,
    packageOrderId: id(99),
  });
  const wrongHandoff = packageSettlementHandoff({
    ...direct.handoff,
    fills: [{
      ...direct.handoff.fills[0]!,
      makerSettlementCommitmentHash: packageSettlementCommitmentHash(wrongMaker),
    }],
  });
  assert.throws(() => nativeClearingMatchAuthorization({
    ...direct,
    handoff: wrongHandoff,
    takerSettlementCommitment: direct.taker,
    makerSettlementCommitment: wrongMaker,
    fillSequence: 1n,
    currentExpiryUnit: 'SOLANA_SLOT',
    currentExpiryValue: 50n,
  }), /identity mismatch/);
  assert.throws(() => nativeClearingMatchAuthorization({
    ...direct,
    takerSettlementCommitment: direct.taker,
    makerSettlementCommitment: direct.maker,
    fillSequence: 1n,
    currentExpiryUnit: 'SOLANA_SLOT',
    currentExpiryValue: 90n,
  }), /is expired/);
});
