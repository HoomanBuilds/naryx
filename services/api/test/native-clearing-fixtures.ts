import {
  assetRef,
  commitmentHash,
  manifestHash,
  nativeClearingDomainState,
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
} from '@naryx/protocol-types';
import { privateKeyToAccount } from 'viem/accounts';

export const id = (value: number): string => value.toString(16).padStart(64, '0');
export const markSigner = privateKeyToAccount(`0x${'51'.repeat(32)}`);
export const takerSigner = privateKeyToAccount(`0x${'52'.repeat(32)}`);
export const makerSigner = privateKeyToAccount(`0x${'53'.repeat(32)}`);
export const backstopSigner = privateKeyToAccount(`0x${'54'.repeat(32)}`);
export const actor = (address: string): string => address.toLowerCase();

export function fixture() {
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
    environment: 'devnet',
    executionClassId: 'sol-carry-package',
    matchingPolicyHash: packageMatchingPolicyHash(matchingPolicy),
    strategySeries: versionedManifestRef('sol-carry', 1, id(1)),
    riskDomainId: 'sol-carry-isolated-risk',
    markSource: versionedManifestRef('sol-carry-mark', 1, id(4)),
    markAuthorityId: actor(markSigner.address),
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
  const state = nativeClearingDomainState({
    version: 1,
    policyHash: policy.policyHash,
    openInterestAtoms: 0n,
    recoveryReserveQuoteAtoms: 300n,
    sequence: 0n,
  }, policy);
  return { policy, state, matchingPolicy };
}

export function authorization(
  accountTaker = 'account-taker',
  participantTaker = actor(takerSigner.address),
  accountMaker = 'account-maker',
  participantMaker = actor(makerSigner.address),
) {
  const { policy, matchingPolicy } = fixture();
  const allocation = packageAllocation({
    version: 1,
    environment: matchingPolicy.environment,
    executionClassId: matchingPolicy.executionClassId,
    matchingPolicyHash: manifestHash(packageMatchingPolicyHash(matchingPolicy)),
    takerOrderId: commitmentHash(id(10)),
    takerParticipantId: protocolId(participantTaker),
    takerCommonControlGroupId: protocolId(`${participantTaker}-group`),
    takerSide: 'BID',
    takerTimeInForce: 'IOC',
    takerLimitPriceTicks: 1_000n,
    requestedQuantity: 10n,
    firstFillSequence: 1n,
    fills: Object.freeze([{
      fillSequence: 1n,
      makerEntryId: commitmentHash(id(11)),
      makerSource: 'DIRECT',
      makerSequence: 1n,
      makerParticipantId: protocolId(participantMaker),
      makerCommonControlGroupId: protocolId(`${participantMaker}-group`),
      priceTicks: 1_000n,
      quantity: 10n,
      consumedSourceKeys: Object.freeze([]),
    }]),
    restedQuantity: 0n,
    cancelledQuantity: 0n,
    selfMatchCancelledEntryIds: Object.freeze([]),
    invalidatedEntryIds: Object.freeze([]),
    internalMatchedQuantity: 10n,
    externalImpliedQuantity: 0n,
  });
  const takerSettlementCommitment = packageSettlementCommitment({
    version: 1,
    environment: matchingPolicy.environment,
    executionClassId: matchingPolicy.executionClassId,
    packageOrderId: allocation.takerOrderId,
    strategyOrderHash: id(20),
    graphHash: id(21),
    participantId: participantTaker,
    settlementAccount: accountTaker,
    quantity: 10n,
    validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    validUntilValue: 100_000n,
  });
  const makerSettlementCommitment = packageSettlementCommitment({
    version: 1,
    environment: matchingPolicy.environment,
    executionClassId: matchingPolicy.executionClassId,
    packageOrderId: allocation.fills[0]!.makerEntryId,
    strategyOrderHash: id(20),
    graphHash: id(21),
    participantId: participantMaker,
    settlementAccount: accountMaker,
    quantity: 10n,
    validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    validUntilValue: 100_000n,
  });
  const handoff = packageSettlementHandoff({
    version: 1,
    allocationHash: packageAllocationHash(allocation),
    executionClassId: matchingPolicy.executionClassId,
    takerSettlementCommitmentHash: packageSettlementCommitmentHash(takerSettlementCommitment),
    fills: [{
      fillSequence: 1n,
      makerEntryId: allocation.fills[0]!.makerEntryId,
      makerSource: 'DIRECT',
      priceTicks: 1_000n,
      quantity: 10n,
      makerSettlementCommitmentHash: packageSettlementCommitmentHash(makerSettlementCommitment),
    }],
  });
  return {
    policy,
    matchingPolicy,
    allocation,
    handoff,
    takerSettlementCommitment,
    makerSettlementCommitment,
    fillSequence: 1n,
  };
}
