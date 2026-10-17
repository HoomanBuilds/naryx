import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetRef,
  adapterRef,
  commitmentHash,
  domainRef,
  manifestHash,
  nativeClearingMatchAuthorization,
  nativeClearingPolicy,
  packageAllocation,
  packageAllocationHash,
  packageMatchingPolicy,
  packageMatchingPolicyHash,
  packageGraph,
  packageGraphHash,
  packageSettlementCommitment,
  packageSettlementCommitmentHash,
  packageSettlementHandoff,
  protocolId,
  versionedManifestRef,
  type PackageLiquiditySource,
  type PackageGraphInput,
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
    markSource: versionedManifestRef('sol-carry-mark', 1, id(4)),
    markAuthorityId: 'mark-authority',
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
    strategyOrderHash: id(22),
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
  assert.notDeepEqual(value.taker.strategyOrderHash, value.maker.strategyOrderHash);
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
  const otherGraph = packageSettlementCommitment({ ...direct.maker, graphHash: id(98) });
  const otherGraphHandoff = packageSettlementHandoff({ ...direct.handoff, fills: [{ ...direct.handoff.fills[0]!, makerSettlementCommitmentHash: packageSettlementCommitmentHash(otherGraph) }] });
  assert.throws(() => nativeClearingMatchAuthorization({ ...direct, handoff: otherGraphHandoff,
    takerSettlementCommitment: direct.taker, makerSettlementCommitment: otherGraph, fillSequence: 1n,
    currentExpiryUnit: 'SOLANA_SLOT', currentExpiryValue: 50n }), /require both original/);
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

function ownerGraph(owner: string, account: string, nonce: bigint): PackageGraphInput {
  const sol = assetRef('sol', id(30), 9);
  return packageGraph({
    graphVersion: 1, environment: 'devnet', templateId: 'carry-v1', templateVersion: 1,
    packageTemplateManifestHash: id(31), seriesId: 'sol-carry', seriesVersion: 1, seriesManifestHash: id(1),
    executionClassId: 'sol-carry-package', executionClassVersion: 1, executionClassManifestHash: id(32),
    lifecycleAction: 'ENTRY', owner, strategyAccountRefs: [account], nonce,
    legs: [{ legId: 'spot', legFamily: 'SPOT_SWAP', legTypeId: 'spot-purchase',
      domain: domainRef('svm:devnet', 1, id(33)),
      adapter: adapterRef({ adapterId: 'spot-adapter', adapterManifestVersion: 1, adapterManifestHash: id(34) }),
      venue: versionedManifestRef('spot', 1, id(35)), market: versionedManifestRef('sol-usdc', 1, id(36)),
      assets: [sol, assetRef('usdc', id(2), 6)], side: 'BUY', quantityAsset: sol,
      quantityAtoms: 10n, minimumQuantityAtoms: 10n, maximumFeeQuoteAtoms: 0n,
      preconditionHashes: [], postconditionHashes: [], timeInForce: 'FOK', legExpiryValue: 100n }],
    dependencyEdges: [], executionGroups: [{ groupId: 'atomic', kind: 'ALL_OR_NONE', legIds: ['spot'] }],
    settlementClass: 'ATOMIC_POSTCONDITION',
    policyHashes: { netting: id(Number(nonce) + 40), privacy: id(41), solver: id(42), delivery: id(43), resource: id(44), portfolioRiskLimits: id(45) },
    recoverySlots: [], maximumRecoveryCostQuoteAtoms: 0n, expiryUnit: 'SOLANA_SLOT', packageExpiryValue: 100n,
  });
}

test('owner-bound graphs clear only when their original witnesses prove identical trading terms', () => {
  const value = fixture();
  const takerGraph = ownerGraph('taker', 'account-taker', 1n);
  const makerGraph = ownerGraph('maker', 'account-maker', 2n);
  const witness = (right: PackageGraphInput = makerGraph) => {
    const taker = packageSettlementCommitment({ ...value.taker, graphHash: packageGraphHash(takerGraph) });
    const maker = packageSettlementCommitment({ ...value.maker, graphHash: packageGraphHash(right) });
    return { ...value, takerGraph, makerGraph: right, takerSettlementCommitment: taker, makerSettlementCommitment: maker,
      handoff: packageSettlementHandoff({ ...value.handoff, takerSettlementCommitmentHash: packageSettlementCommitmentHash(taker),
        fills: [{ ...value.handoff.fills[0]!, makerSettlementCommitmentHash: packageSettlementCommitmentHash(maker) }] }),
      fillSequence: 1n, currentExpiryUnit: 'SOLANA_SLOT' as const, currentExpiryValue: 50n };
  };
  const input = witness();
  assert.notDeepEqual(input.takerSettlementCommitment.graphHash, input.makerSettlementCommitment.graphHash);
  assert.equal(nativeClearingMatchAuthorization(input).quantityAtoms, 10n);
  const { makerGraph: omitted, ...missingWitness } = input;
  assert.ok(omitted);
  assert.throws(() => nativeClearingMatchAuthorization(missingWitness), /require both original/);
  assert.throws(() => nativeClearingMatchAuthorization({ ...input, makerGraph: { ...makerGraph, nonce: 3n } }), /witness differs/);
  assert.throws(() => nativeClearingMatchAuthorization(witness({ ...makerGraph, owner: 'other-owner' })), /witness differs/);
  assert.throws(() => nativeClearingMatchAuthorization(witness({ ...makerGraph, strategyAccountRefs: ['other-account'] })), /witness differs/);
  assert.throws(() => nativeClearingMatchAuthorization(witness({ ...makerGraph, seriesId: 'other-series' })), /witness differs/);
  assert.throws(() => nativeClearingMatchAuthorization(witness({ ...makerGraph,
    legs: [{ ...makerGraph.legs[0]!, quantityAtoms: 20n, minimumQuantityAtoms: 20n }] })), /different package economics/);
  assert.throws(() => nativeClearingMatchAuthorization(witness({ ...makerGraph,
    legs: [{ ...makerGraph.legs[0]!, maximumFeeQuoteAtoms: 1n }] })), /different package economics/);
});
