import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assetRef,
  commitmentHash,
  manifestHash,
  nativeClearingAccount,
  nativeClearingDefaultBid,
  nativeClearingDomainState,
  nativeClearingMarkObservation,
  nativeClearingPolicy,
  packageAllocation,
  packageAllocationHash,
  packageMatchingPolicy,
  packageMatchingPolicyHash,
  packageSettlementCommitment,
  packageSettlementCommitmentHash,
  packageSettlementHandoff,
  protocolId,
  toHex,
  versionedManifestRef,
} from '@naryx/protocol-types';
import { privateKeyToAccount } from 'viem/accounts';
import {
  NativeClearingStoreError,
  SqliteNativeClearingStore,
} from '../src/native-clearing-store.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const markSigner = privateKeyToAccount(`0x${'51'.repeat(32)}`);
const takerSigner = privateKeyToAccount(`0x${'52'.repeat(32)}`);
const makerSigner = privateKeyToAccount(`0x${'53'.repeat(32)}`);
const backstopSigner = privateKeyToAccount(`0x${'54'.repeat(32)}`);
const actor = (address: string): string => address.toLowerCase();

function fixture() {
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

function open(
  store: SqliteNativeClearingStore,
  accountId: string,
  participantId: string,
  collateral: bigint,
) {
  const { policy } = fixture();
  return store.openAccount(policy.clearingDomainId, nativeClearingAccount({
    version: 1,
    policyHash: policy.policyHash,
    accountId,
    ownerId: participantId,
    collateralQuoteAtoms: collateral,
    cashBalanceQuoteAtoms: 0n,
    positionAtoms: 0n,
    sequence: 0n,
  }, policy));
}

function authorization(
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
    validUntilUnit: 'SOLANA_SLOT',
    validUntilValue: 100n,
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
    validUntilUnit: 'SOLANA_SLOT',
    validUntilValue: 100n,
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
    currentExpiryUnit: 'SOLANA_SLOT' as const,
    currentExpiryValue: 50n,
  };
}

async function recordMark(
  store: SqliteNativeClearingStore,
  priceTicks: bigint,
  sourceSequence: bigint,
  observedAtMs = 10_000n,
) {
  const { policy } = fixture();
  const input = {
    version: 1,
    policyHash: policy.policyHash,
    source: policy.markSource,
    authorityId: policy.markAuthorityId,
    sourceSequence,
    priceTicks,
    observedAtMs,
    validUntilMs: observedAtMs + policy.markMaximumStalenessMs,
  } as const;
  const observation = nativeClearingMarkObservation(input, policy);
  const signature = await markSigner.signMessage({ message: { raw: `0x${toHex(observation.observationHash)}` } });
  return store.recordMark({
    clearingDomainId: policy.clearingDomainId,
    observation: input,
    authorization: { scheme: 'EIP191_SECP256K1', signature },
  });
}

test('native clearing state persists exact matches and rejects stale writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-native-clearing-'));
  const path = join(directory, 'clearing.db');
  try {
    const { policy, state } = fixture();
    let store = new SqliteNativeClearingStore(path, () => 10_000);
    store.registerDomain(policy, state);
    await recordMark(store, 1_000n, 1n);
    const long = open(store, 'account-taker', actor(takerSigner.address), 5_000n);
    const short = open(store, 'account-maker', actor(makerSigner.address), 5_000n);
    const receipt = store.settleAuthorizedMatch({
      authorization: authorization(),
      expectedStateHash: state.stateHash,
      expectedLongAccountHash: long.accountHash,
      expectedShortAccountHash: short.accountHash,
      nowMs: 10_000n,
    });
    assert.equal(store.domain(policy.clearingDomainId)?.state.openInterestAtoms, 10n);
    assert.equal(store.account(long.accountId)?.positionAtoms, 10n);
    assert.equal(store.events(policy.clearingDomainId)[0]?.eventHashHex, Buffer.from(receipt.receiptHash).toString('hex'));
    assert.throws(() => store.settleAuthorizedMatch({
      authorization: authorization(),
      expectedStateHash: state.stateHash,
      expectedLongAccountHash: long.accountHash,
      expectedShortAccountHash: short.accountHash,
      nowMs: 10_000n,
    }), (error: unknown) => error instanceof NativeClearingStoreError && error.code === 'STALE_STATE');
    store.close();
    store = new SqliteNativeClearingStore(path, () => 11_000);
    assert.equal(store.account(short.accountId)?.positionAtoms, -10n);
    assert.equal(store.events(policy.clearingDomainId).length, 1);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('default auction transfers exposure and journals reserve loss', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-native-default-'));
  try {
    const { policy, state } = fixture();
    const store = new SqliteNativeClearingStore(join(directory, 'clearing.db'), () => 10_000);
    store.registerDomain(policy, state);
    await recordMark(store, 1_000n, 1n);
    const long = open(store, 'account-taker', actor(takerSigner.address), 200n);
    const short = open(store, 'account-maker', actor(makerSigner.address), 5_000n);
    const backstop = open(store, 'account-backstop', actor(backstopSigner.address), 5_000n);
    store.settleAuthorizedMatch({
      authorization: authorization(),
      expectedStateHash: state.stateHash,
      expectedLongAccountHash: long.accountHash,
      expectedShortAccountHash: short.accountHash,
      nowMs: 10_000n,
    });
    await recordMark(store, 50n, 2n);
    const current = store.domain(policy.clearingDomainId)!;
    const defaulted = store.account(long.accountId)!;
    const auction = store.openDefaultAuction({
      clearingDomainId: policy.clearingDomainId,
      defaultedAccountId: defaulted.accountId,
      expectedDefaultedAccountHash: defaulted.accountHash,
      auctionId: 'default-1',
      bidsCloseAtMs: 11_000n,
      nowMs: 10_000n,
    });
    const bidInput = {
      version: 1,
      auctionHash: auction.auctionHash,
      backstopAccountId: backstop.accountId,
      backstopAccountHash: backstop.accountHash,
      backstopOwnerId: backstop.ownerId,
      transferPriceTicks: 48n,
      nonce: backstop.sequence,
      validUntilMs: 12_000n,
    } as const;
    const bid = nativeClearingDefaultBid(bidInput, auction);
    const bidSignature = await backstopSigner.signMessage({ message: { raw: `0x${toHex(bid.bidHash)}` } });
    await store.submitDefaultBid({
      auctionId: auction.auctionId,
      bid: bidInput,
      ownerSignature: { scheme: 'EIP191_SECP256K1', signature: bidSignature },
      nowMs: 10_500n,
    });
    const resolution = store.settleDefaultAuction({
      auctionId: auction.auctionId,
      expectedStateHash: current.state.stateHash,
      nowMs: 11_000n,
    });
    assert.equal(resolution.reserveConsumedQuoteAtoms, 300n);
    assert.equal(resolution.uncoveredDeficitQuoteAtoms, 452n);
    assert.equal(store.account(long.accountId)?.positionAtoms, 0n);
    assert.equal(store.account(backstop.accountId)?.positionAtoms, 10n);
    assert.deepEqual(store.events(policy.clearingDomainId).map((event) => event.kind), ['MATCH', 'DEFAULT']);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
