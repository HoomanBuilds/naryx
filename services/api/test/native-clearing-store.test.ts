import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  nativeClearingAccount,
  normalizeNativeClearingAccount,
  applyNativeClearingMatch,
  domainRef,
  nativeClearingExecutionId,
  nativeClearingMatchAuthorization,
  nativeClearingCollateralAuthorization,
  nativeClearingDefaultBid,
  nativeClearingMarkObservation,
  packageSettlementCommitment,
  protocolId,
  toHex,
} from '@naryx/protocol-types';
import {
  NativeClearingStoreError,
  SqliteNativeClearingStore,
} from '../src/native-clearing-store.js';
import {
  actor,
  authorization,
  backstopSigner,
  fixture,
  makerSigner,
  markSigner,
  takerSigner,
} from './native-clearing-fixtures.js';
import type { EvmNativeClearingTransition } from '@naryx/adapter-evm';

test('normalization journals one account sequence without changing domain exposure or reserve', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-clearing-normalize-'));
  const store = new SqliteNativeClearingStore(join(directory, 'clearing.db'), () => 10_000);
  try {
    const { policy, state } = fixture();
    store.registerDomain(policy, state);
    await recordMark(store, 1000n, 1n);
    const before = await open(store, 'account-taker', takerSigner, 5000n);
    const after = normalizeNativeClearingAccount(before, policy);
    const transactionHash = `0x${'88'.repeat(32)}` as const;
    const transition: EvmNativeClearingTransition = { kind: 'NORMALIZE', state, accounts: [after],
      receipt: { policyHash: policy.policyHash, accountId: before.accountId, previousDomainStateHash: state.stateHash,
        previousAccountHash: before.accountHash, resultingAccountHash: after.accountHash, receiptHash: after.accountHash },
      proof: { evidenceGrade: 'FINALIZED_CONTRACT_STATE', scope: 'REGISTERED_ACCOUNTS', domain: domainRef('eip155:84532', 1, '11'.repeat(32)),
        clearingHouse: '0x1111111111111111111111111111111111111111', collateralToken: '0x2222222222222222222222222222222222222222',
        blockNumber: 100n, blockHash: `0x${'55'.repeat(32)}`, tokenBalanceAtoms: 5300n, verifiedCollateralAndReserveAtoms: 5300n,
        verifiedAccountCount: 1, entryPaused: true, transactionHash, logIndex: null, evidenceKind: 'CALL_AND_STATE', executedAtMs: 10_000n } };
    const snapshot = store.backingSnapshot(policy.clearingDomainId);
    assert.throws(() => store.recordFinalizedTransition(policy.clearingDomainId, snapshot, { ...transition,
      receipt: { ...transition.receipt, accountId: protocolId('another-account') } }), { code: 'BACKING_STATE_MISMATCH' });
    assert.equal(store.account(before.accountId)!.sequence, before.sequence);
    store.recordFinalizedTransition(policy.clearingDomainId, snapshot, transition);
    assert.equal(store.account(before.accountId)!.sequence, before.sequence + 1n);
    assert.deepEqual(store.domain(policy.clearingDomainId)!.state, state);
    assert.deepEqual(store.contractTransition(transactionHash), transition);
    assert.equal(store.backingReceipts(policy.clearingDomainId).at(-1)!.action, 'normalizations');
    assert.throws(() => store.recordFinalizedTransition(policy.clearingDomainId, snapshot, transition), { code: 'STALE_BACKING' });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('finalized contract transitions commit balances, replay protection, events and backing evidence together', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-clearing-transition-'));
  const path = join(directory, 'clearing.db');
  const store = new SqliteNativeClearingStore(path, () => 10_000);
  try {
    const { policy, state } = fixture();
    store.registerDomain(policy, state);
    await recordMark(store, 1_000n, 1n);
    const long = await open(store, 'account-taker', takerSigner, 5_000n);
    const short = await open(store, 'account-maker', makerSigner, 5_000n);
    const authorized = nativeClearingMatchAuthorization({ ...authorization(), currentExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS', currentExpiryValue: 10_000n });
    const result = applyNativeClearingMatch({ policy, domainState: state, longAccount: long, shortAccount: short,
      executionId: nativeClearingExecutionId(authorized), quantityAtoms: 10n, priceTicks: 1_000n, markPriceTicks: 1_000n, observedAtMs: 10_000n, nowMs: 10_000n });
    const transactionHash = `0x${'77'.repeat(32)}` as const;
    const transition: EvmNativeClearingTransition = { kind: 'MATCH', state: result.domainState, accounts: [result.longAccount, result.shortAccount],
      receipt: result.receipt, authorizationHash: authorized.authorizationHash, markObservationHash: store.latestMark(policy.clearingDomainId)!.observationHash,
      proof: { evidenceGrade: 'FINALIZED_CONTRACT_STATE', scope: 'REGISTERED_ACCOUNTS', domain: domainRef('eip155:84532', 1, '11'.repeat(32)),
        clearingHouse: '0x1111111111111111111111111111111111111111', collateralToken: '0x2222222222222222222222222222222222222222',
        blockNumber: 100n, blockHash: `0x${'55'.repeat(32)}`, tokenBalanceAtoms: 10_300n, verifiedCollateralAndReserveAtoms: 10_300n,
        verifiedAccountCount: 2, entryPaused: false, transactionHash, logIndex: 0, executedAtMs: 10_000n } };
    const before = store.backingSnapshot(policy.clearingDomainId);
    assert.throws(() => store.recordFinalizedTransition(policy.clearingDomainId, 'null', transition), { code: 'STALE_BACKING' });
    assert.equal(store.contractTransition(transactionHash), undefined);
    const raw = new Database(path);
    try {
      raw.exec("CREATE TRIGGER fail_transition BEFORE INSERT ON native_clearing_contract_transitions BEGIN SELECT RAISE(ABORT, 'transition unavailable'); END;");
      assert.throws(() => store.recordFinalizedTransition(policy.clearingDomainId, before, transition), /transition unavailable/);
      assert.equal(store.account(long.accountId)!.positionAtoms, 0n);
      assert.equal(store.events(policy.clearingDomainId).filter((event) => event.kind === 'MATCH').length, 0);
      raw.exec('DROP TRIGGER fail_transition');
    } finally { raw.close(); }
    store.recordFinalizedTransition(policy.clearingDomainId, before, transition);
    assert.equal(store.account(long.accountId)!.positionAtoms, 10n);
    assert.equal(store.events(policy.clearingDomainId).filter((event) => event.kind === 'MATCH').length, 1);
    assert.equal(store.backingReceipts(policy.clearingDomainId).length, 1);
    assert.deepEqual(store.contractTransition(transactionHash), transition);
    assert.throws(() => store.recordFinalizedTransition(policy.clearingDomainId, before, transition), { code: 'STALE_BACKING' });
    assert.throws(() => store.settleAuthorizedMatch({ authorization: authorization(), expectedStateHash: result.domainState.stateHash,
      expectedLongAccountHash: result.longAccount.accountHash, expectedShortAccountHash: result.shortAccount.accountHash }), { code: 'BACKING_REQUIRED' });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

async function open(
  store: SqliteNativeClearingStore,
  accountId: string,
  owner: typeof takerSigner,
  collateral: bigint,
) {
  const { policy } = fixture();
  const account = store.openAccount(policy.clearingDomainId, nativeClearingAccount({
    version: 1,
    policyHash: policy.policyHash,
    accountId,
    ownerId: actor(owner.address),
    collateralQuoteAtoms: 0n,
    cashBalanceQuoteAtoms: 0n,
    positionAtoms: 0n,
    sequence: 0n,
  }, policy));
  const deposit = {
    version: 1,
    policyHash: policy.policyHash,
    accountId,
    ownerId: account.ownerId,
    expectedAccountHash: account.accountHash,
    expectedAccountSequence: account.sequence,
    collateralDeltaQuoteAtoms: collateral,
    validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    validUntilValue: 100_000n,
  } as const;
  const signature = await owner.signMessage({
    message: { raw: `0x${toHex(nativeClearingCollateralAuthorization(deposit).authorizationHash)}` },
  });
  return store.adjustAuthorizedCollateral({
    authorization: deposit,
    ownerSignature: { scheme: 'EIP191_SECP256K1', signature },
  });
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

test('native clearing state persists exact matches and rejects stale writes and replays', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-native-clearing-'));
  const path = join(directory, 'clearing.db');
  try {
    const { policy, state } = fixture();
    let store = new SqliteNativeClearingStore(path, () => 10_000);
    store.registerDomain(policy, state);
    await recordMark(store, 1_000n, 1n);
    const long = await open(store, 'account-taker', takerSigner, 5_000n);
    const short = await open(store, 'account-maker', makerSigner, 5_000n);
    const receipt = store.settleAuthorizedMatch({
      authorization: authorization(),
      expectedStateHash: state.stateHash,
      expectedLongAccountHash: long.accountHash,
      expectedShortAccountHash: short.accountHash,
    });
    assert.equal(store.domain(policy.clearingDomainId)?.state.openInterestAtoms, 10n);
    assert.equal(store.account(long.accountId)?.positionAtoms, 10n);
    assert.equal(
      store.events(policy.clearingDomainId).find((event) => event.kind === 'MATCH')?.eventHashHex,
      Buffer.from(receipt.receiptHash).toString('hex'),
    );
    assert.throws(() => store.settleAuthorizedMatch({
      authorization: authorization(),
      expectedStateHash: state.stateHash,
      expectedLongAccountHash: long.accountHash,
      expectedShortAccountHash: short.accountHash,
    }), (error: unknown) => error instanceof NativeClearingStoreError && error.code === 'STALE_STATE');
    const replay = () => store.settleAuthorizedMatch({
      authorization: authorization(),
      expectedStateHash: store.domain(policy.clearingDomainId)!.state.stateHash,
      expectedLongAccountHash: store.account(long.accountId)!.accountHash,
      expectedShortAccountHash: store.account(short.accountId)!.accountHash,
    });
    assert.throws(replay, (error: unknown) => error instanceof NativeClearingStoreError && error.code === 'SETTLEMENT_CONFLICT');
    store.close();
    // A database written before settlements were recorded is backfilled from its MATCH events.
    const raw = new Database(path);
    raw.exec('DROP TABLE native_clearing_match_settlements');
    raw.close();
    store = new SqliteNativeClearingStore(path, () => 11_000);
    assert.throws(replay, (error: unknown) => error instanceof NativeClearingStoreError && error.code === 'SETTLEMENT_CONFLICT');
    assert.equal(store.account(short.accountId)?.positionAtoms, -10n);
    assert.equal(store.account(long.accountId)?.positionAtoms, 10n);
    assert.equal(store.events(policy.clearingDomainId).filter((event) => event.kind === 'MATCH').length, 1);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native clearing accounts open unfunded and refuse clocks it cannot read', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-native-genesis-'));
  try {
    const { policy, state } = fixture();
    const store = new SqliteNativeClearingStore(join(directory, 'clearing.db'), () => 10_000);
    store.registerDomain(policy, state);
    assert.throws(() => store.openAccount(policy.clearingDomainId, nativeClearingAccount({
      version: 1,
      policyHash: policy.policyHash,
      accountId: 'account-funded',
      ownerId: actor(takerSigner.address),
      collateralQuoteAtoms: 1n,
      cashBalanceQuoteAtoms: 0n,
      positionAtoms: 0n,
      sequence: 0n,
    }, policy)), (error: unknown) => error instanceof NativeClearingStoreError && error.code === 'INVALID_GENESIS');
    await recordMark(store, 1_000n, 1n);
    const long = await open(store, 'account-taker', takerSigner, 5_000n);
    const short = await open(store, 'account-maker', makerSigner, 5_000n);
    const slotClocked = authorization();
    const slot = (commitment: typeof slotClocked.takerSettlementCommitment) =>
      packageSettlementCommitment({ ...commitment, validUntilUnit: 'SOLANA_SLOT' });
    assert.throws(() => store.settleAuthorizedMatch({
      authorization: {
        ...slotClocked,
        takerSettlementCommitment: slot(slotClocked.takerSettlementCommitment),
        makerSettlementCommitment: slot(slotClocked.makerSettlementCommitment),
      },
      expectedStateHash: state.stateHash,
      expectedLongAccountHash: long.accountHash,
      expectedShortAccountHash: short.accountHash,
    }), (error: unknown) => error instanceof NativeClearingStoreError && error.code === 'UNSUPPORTED_CLOCK');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('default auction transfers exposure and journals reserve loss', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-native-default-'));
  try {
    const { policy, state } = fixture();
    let now = 10_000;
    const store = new SqliteNativeClearingStore(join(directory, 'clearing.db'), () => now);
    store.registerDomain(policy, state);
    await recordMark(store, 1_000n, 1n);
    const long = await open(store, 'account-taker', takerSigner, 200n);
    const short = await open(store, 'account-maker', makerSigner, 5_000n);
    const backstop = await open(store, 'account-backstop', backstopSigner, 5_000n);
    store.settleAuthorizedMatch({
      authorization: authorization(),
      expectedStateHash: store.domain(policy.clearingDomainId)!.state.stateHash,
      expectedLongAccountHash: long.accountHash,
      expectedShortAccountHash: short.accountHash,
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
    now = 10_500;
    const lateBid = store.submitDefaultBid({
      auctionId: auction.auctionId,
      bid: bidInput,
      ownerSignature: { scheme: 'EIP191_SECP256K1', signature: bidSignature },
    });
    now = 11_000;
    await assert.rejects(lateBid, { code: 'AUCTION_CLOSED' });
    assert.equal(store.defaultAuction(auction.auctionId).bids.length, 0);
    now = 10_500;
    await store.submitDefaultBid({
      auctionId: auction.auctionId,
      bid: bidInput,
      ownerSignature: { scheme: 'EIP191_SECP256K1', signature: bidSignature },
    });
    now = 11_000;
    const resolution = store.settleDefaultAuction({
      auctionId: auction.auctionId,
      expectedStateHash: current.state.stateHash,
    });
    assert.equal(resolution.reserveConsumedQuoteAtoms, 300n);
    assert.equal(resolution.uncoveredDeficitQuoteAtoms, 452n);
    assert.equal(store.account(long.accountId)?.positionAtoms, 0n);
    assert.equal(store.account(backstop.accountId)?.positionAtoms, 10n);
    assert.deepEqual(
      store.events(policy.clearingDomainId).map((event) => event.kind),
      ['COLLATERAL', 'COLLATERAL', 'COLLATERAL', 'MATCH', 'DEFAULT'],
    );
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
