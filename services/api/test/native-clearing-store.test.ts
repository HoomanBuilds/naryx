import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assetRef,
  nativeClearingAccount,
  nativeClearingDomainState,
  nativeClearingPolicy,
  versionedManifestRef,
} from '@naryx/protocol-types';
import {
  NativeClearingStoreError,
  SqliteNativeClearingStore,
} from '../src/native-clearing-store.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');

function fixture() {
  const policy = nativeClearingPolicy({
    version: 1,
    clearingDomainId: 'sol-carry-clearing',
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
  return { policy, state };
}

function open(store: SqliteNativeClearingStore, number: number, collateral: bigint) {
  const { policy } = fixture();
  return store.openAccount(policy.clearingDomainId, nativeClearingAccount({
    version: 1,
    policyHash: policy.policyHash,
    accountId: `account-${number}`,
    ownerId: `owner-${number}`,
    collateralQuoteAtoms: collateral,
    cashBalanceQuoteAtoms: 0n,
    positionAtoms: 0n,
    sequence: 0n,
  }, policy));
}

test('native clearing state persists exact matches and rejects stale writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-native-clearing-'));
  const path = join(directory, 'clearing.db');
  try {
    const { policy, state } = fixture();
    let store = new SqliteNativeClearingStore(path, () => 10_000);
    store.registerDomain(policy, state);
    const long = open(store, 1, 5_000n);
    const short = open(store, 2, 5_000n);
    const receipt = store.match({
      clearingDomainId: policy.clearingDomainId,
      expectedStateHash: state.stateHash,
      longAccountId: long.accountId,
      expectedLongAccountHash: long.accountHash,
      shortAccountId: short.accountId,
      expectedShortAccountHash: short.accountHash,
      executionId: 'match-1',
      quantityAtoms: 10n,
      priceTicks: 1_000n,
      markPriceTicks: 1_000n,
      observedAtMs: 10_000n,
      nowMs: 10_000n,
    });
    assert.equal(store.domain(policy.clearingDomainId)?.state.openInterestAtoms, 10n);
    assert.equal(store.account(long.accountId)?.positionAtoms, 10n);
    assert.equal(store.events(policy.clearingDomainId)[0]?.eventHashHex, Buffer.from(receipt.receiptHash).toString('hex'));
    assert.throws(() => store.match({
      clearingDomainId: policy.clearingDomainId,
      expectedStateHash: state.stateHash,
      longAccountId: long.accountId,
      expectedLongAccountHash: long.accountHash,
      shortAccountId: short.accountId,
      expectedShortAccountHash: short.accountHash,
      executionId: 'stale-match',
      quantityAtoms: 10n,
      priceTicks: 1_000n,
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
    const long = open(store, 1, 200n);
    const short = open(store, 2, 5_000n);
    const backstop = open(store, 3, 5_000n);
    store.match({
      clearingDomainId: policy.clearingDomainId,
      expectedStateHash: state.stateHash,
      longAccountId: long.accountId,
      expectedLongAccountHash: long.accountHash,
      shortAccountId: short.accountId,
      expectedShortAccountHash: short.accountHash,
      executionId: 'match-before-default',
      quantityAtoms: 10n,
      priceTicks: 1_000n,
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
