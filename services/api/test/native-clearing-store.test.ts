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
import {
  NativeClearingStoreError,
  SqliteNativeClearingStore,
} from '../src/native-clearing-store.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');

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
  participantTaker = 'taker',
  accountMaker = 'account-maker',
  participantMaker = 'maker',
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

test('native clearing state persists exact matches and rejects stale writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-native-clearing-'));
  const path = join(directory, 'clearing.db');
  try {
    const { policy, state } = fixture();
    let store = new SqliteNativeClearingStore(path, () => 10_000);
    store.registerDomain(policy, state);
    const long = open(store, 'account-taker', 'taker', 5_000n);
    const short = open(store, 'account-maker', 'maker', 5_000n);
    const receipt = store.settleAuthorizedMatch({
      authorization: authorization(),
      expectedStateHash: state.stateHash,
      expectedLongAccountHash: long.accountHash,
      expectedShortAccountHash: short.accountHash,
      markPriceTicks: 1_000n,
      observedAtMs: 10_000n,
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
      markPriceTicks: 1_000n,
      observedAtMs: 10_000n,
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

test('default resolution atomically transfers exposure and journals reserve loss', () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-native-default-'));
  try {
    const { policy, state } = fixture();
    const store = new SqliteNativeClearingStore(join(directory, 'clearing.db'), () => 10_000);
    store.registerDomain(policy, state);
    const long = open(store, 'account-taker', 'taker', 200n);
    const short = open(store, 'account-maker', 'maker', 5_000n);
    const backstop = open(store, 'account-backstop', 'backstop', 5_000n);
    store.settleAuthorizedMatch({
      authorization: authorization(),
      expectedStateHash: state.stateHash,
      expectedLongAccountHash: long.accountHash,
      expectedShortAccountHash: short.accountHash,
      markPriceTicks: 1_000n,
      observedAtMs: 10_000n,
      nowMs: 10_000n,
    });
    const current = store.domain(policy.clearingDomainId)!;
    const defaulted = store.account(long.accountId)!;
    const currentBackstop = store.account(backstop.accountId)!;
    const resolution = store.resolveDefault({
      clearingDomainId: policy.clearingDomainId,
      expectedStateHash: current.state.stateHash,
      defaultedAccountId: defaulted.accountId,
      expectedDefaultedAccountHash: defaulted.accountHash,
      backstopAccountId: currentBackstop.accountId,
      expectedBackstopAccountHash: currentBackstop.accountHash,
      resolutionId: 'default-1',
      transferPriceTicks: 48n,
      markPriceTicks: 50n,
      observedAtMs: 10_000n,
      nowMs: 10_000n,
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
