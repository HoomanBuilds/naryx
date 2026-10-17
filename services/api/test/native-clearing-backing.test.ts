import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { domainRef, nativeClearingAccount, nativeClearingCollateralAuthorization, nativeClearingDomainState, nativeClearingMarkObservation, toHex } from '@naryx/protocol-types';
import { NativeClearingBackingService } from '../src/native-clearing-backing.js';
import { nativeClearingBackingSnapshot, SqliteNativeClearingStore } from '../src/native-clearing-store.js';
import { fixture, takerSigner, markSigner } from './native-clearing-fixtures.js';

test('clearing funding gate verifies the proposed post-state and refuses unbacked or active clearing', async () => {
  const { policy } = fixture();
  const state = nativeClearingDomainState({ version: 1, policyHash: policy.policyHash, openInterestAtoms: 0n, recoveryReserveQuoteAtoms: 0n, sequence: 0n }, policy);
  const account = nativeClearingAccount({ version: 1, policyHash: policy.policyHash, accountId: 'funding-account', ownerId: takerSigner.address.toLowerCase(), collateralQuoteAtoms: 0n, cashBalanceQuoteAtoms: 0n, positionAtoms: 0n, sequence: 0n }, policy);
  const mark = nativeClearingMarkObservation({ version: 1, policyHash: policy.policyHash, source: policy.markSource, authorityId: policy.markAuthorityId, sourceSequence: 1n, priceTicks: 1_000n, observedAtMs: 10_000n, validUntilMs: 15_000n }, policy);
  const clearing = {
    domain: (id: string) => id === policy.clearingDomainId ? { policy, state } : undefined,
    accounts: () => [account],
    account: (id: string) => id === account.accountId ? account : undefined,
    latestMark: () => mark,
    backingSnapshot: () => nativeClearingBackingSnapshot({ policy, state }, [account], mark),
  };
  let paused = true;
  let verifiedCollateral = 0n;
  let verifiedReserve = 0n;
  const verifier = {
    verify: async (_policy: typeof policy, nextState: typeof state, nextAccounts: readonly typeof account[]) => {
      verifiedCollateral = nextAccounts[0]?.collateralQuoteAtoms ?? 0n;
      verifiedReserve = nextState.recoveryReserveQuoteAtoms;
      return {
        evidenceGrade: 'FINALIZED_CONTRACT_STATE' as const,
        scope: 'REGISTERED_ACCOUNTS' as const,
        domain: domainRef('eip155:84532', 1, '11'.repeat(32)),
        clearingHouse: '0x1111111111111111111111111111111111111111' as const,
        collateralToken: '0x2222222222222222222222222222222222222222' as const,
        blockNumber: 1n, blockHash: `0x${'33'.repeat(32)}` as const,
        tokenBalanceAtoms: 100n, verifiedCollateralAndReserveAtoms: verifiedCollateral + verifiedReserve,
        verifiedAccountCount: nextAccounts.length, entryPaused: paused,
      };
    },
  };
  const service = new NativeClearingBackingService(clearing, new Map([[policy.clearingDomainId, verifier]]), () => 10_000);
  const authorization = nativeClearingCollateralAuthorization({ version: 1, policyHash: policy.policyHash, accountId: account.accountId, ownerId: account.ownerId, expectedAccountHash: account.accountHash, expectedAccountSequence: 0n, collateralDeltaQuoteAtoms: 25n, validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS', validUntilValue: 20_000n });
  await service.verifyMutation('/internal/native-clearing/collateral', { authorization });
  assert.equal(verifiedCollateral, 25n);
  assert.equal(account.collateralQuoteAtoms, 0n);
  await service.verifyMutation('/internal/native-clearing/reserve', { clearingDomainId: policy.clearingDomainId, reserveDeltaQuoteAtoms: 5n });
  assert.equal(verifiedReserve, 5n);
  paused = false;
  await assert.rejects(service.verifyMutation('/internal/native-clearing/collateral', { authorization }), { code: 'BACKING_OPERATION_UNSUPPORTED' });
  await assert.rejects(service.verifyMutation('/internal/native-clearing/matches', {}), { code: 'BACKING_OPERATION_UNSUPPORTED' });
  await assert.rejects(new NativeClearingBackingService(clearing, new Map()).current(policy.clearingDomainId), { code: 'BACKING_UNAVAILABLE' });
  await assert.rejects(service.verifyMutation('/internal/native-clearing/domains', { policy, state: { version: 1, policyHash: policy.policyHash, openInterestAtoms: 0n, recoveryReserveQuoteAtoms: 5n, sequence: 0n } }), { code: 'INVALID_GENESIS' });
});

test('verified funding commits its backing receipt atomically and rejects stale cross-process proofs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-clearing-backing-'));
  const path = join(directory, 'clearing.db');
  const store = new SqliteNativeClearingStore(path, () => 10_000);
  const other = new SqliteNativeClearingStore(path, () => 10_000);
  const raw = new Database(path);
  try {
    const { policy } = fixture();
    const state = nativeClearingDomainState({ version: 1, policyHash: policy.policyHash, openInterestAtoms: 0n, recoveryReserveQuoteAtoms: 0n, sequence: 0n }, policy);
    const service = new NativeClearingBackingService(store, new Map([[policy.clearingDomainId, {
      verify: async (_policy: typeof policy, nextState: typeof state, accounts: readonly ReturnType<typeof nativeClearingAccount>[]) => ({
        evidenceGrade: 'FINALIZED_CONTRACT_STATE' as const, scope: 'REGISTERED_ACCOUNTS' as const,
        domain: domainRef('eip155:84532', 1, '11'.repeat(32)),
        clearingHouse: '0x1111111111111111111111111111111111111111' as const,
        collateralToken: '0x2222222222222222222222222222222222222222' as const,
        blockNumber: 123n, blockHash: `0x${'33'.repeat(32)}` as const,
        tokenBalanceAtoms: 100n,
        verifiedCollateralAndReserveAtoms: accounts.reduce((sum, account) => sum + account.collateralQuoteAtoms, nextState.recoveryReserveQuoteAtoms),
        verifiedAccountCount: accounts.length, entryPaused: true,
      }),
    }]]), () => 10_000);
    const verify = (action: string, body: Record<string, unknown>) => service.verifyMutation(`/internal/native-clearing/${action}`, body);
    store.registerDomain(policy, state, await verify('domains', { policy, state }));
    const account = nativeClearingAccount({ version: 1, policyHash: policy.policyHash, accountId: 'backed-account', ownerId: takerSigner.address.toLowerCase(), collateralQuoteAtoms: 0n, cashBalanceQuoteAtoms: 0n, positionAtoms: 0n, sequence: 0n }, policy);
    store.openAccount(policy.clearingDomainId, account, await verify('accounts', { clearingDomainId: policy.clearingDomainId, account }));
    const observation = nativeClearingMarkObservation({ version: 1, policyHash: policy.policyHash, source: policy.markSource, authorityId: policy.markAuthorityId, sourceSequence: 1n, priceTicks: 1_000n, observedAtMs: 10_000n, validUntilMs: 15_000n }, policy);
    const markBody = { clearingDomainId: policy.clearingDomainId, observation, authorization: {
      scheme: 'EIP191_SECP256K1' as const, signature: await markSigner.signMessage({ message: { raw: `0x${toHex(observation.observationHash)}` } }),
    } };
    await store.recordMark(markBody, await verify('marks', markBody));
    const authorization = nativeClearingCollateralAuthorization({ version: 1, policyHash: policy.policyHash, accountId: account.accountId, ownerId: account.ownerId, expectedAccountHash: account.accountHash, expectedAccountSequence: 0n, collateralDeltaQuoteAtoms: 25n, validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS', validUntilValue: 20_000n });
    const collateral = { authorization, ownerSignature: { scheme: 'EIP191_SECP256K1' as const,
      signature: await takerSigner.signMessage({ message: { raw: `0x${toHex(authorization.authorizationHash)}` } }),
    } };
    await store.adjustAuthorizedCollateral(collateral, await verify('collateral', collateral));
    const reserve = { clearingDomainId: policy.clearingDomainId, expectedStateHash: state.stateHash, reserveDeltaQuoteAtoms: 5n };
    const stale = await verify('reserve', reserve);
    const { accountHash: _accountHash, ...accountInput } = account;
    const secondAccount = nativeClearingAccount({ ...accountInput, accountId: 'second-account' }, policy);
    const secondBacking = await verify('accounts', { clearingDomainId: policy.clearingDomainId, account: secondAccount });
    assert.throws(() => other.openAccount(policy.clearingDomainId, secondAccount), { code: 'BACKING_REQUIRED' });
    other.openAccount(policy.clearingDomainId, secondAccount, secondBacking);
    assert.throws(() => store.adjustReserve(reserve, stale), { code: 'STALE_BACKING' });
    const backing = await verify('reserve', reserve);
    assert.throws(() => store.adjustReserve(reserve, { ...backing, afterSnapshot: 'null' }), { code: 'BACKING_STATE_MISMATCH' });
    assert.equal(store.domain(policy.clearingDomainId)!.state.recoveryReserveQuoteAtoms, 0n);
    assert.equal(store.events(policy.clearingDomainId).length, 1);
    assert.equal(store.backingReceipts(policy.clearingDomainId).length, 5);
    assert.throws(() => store.adjustReserve(reserve, { ...backing, action: 'accounts' }), { code: 'BACKING_STATE_MISMATCH' });
    raw.exec("CREATE TRIGGER fail_backing_receipt BEFORE INSERT ON native_clearing_backing_receipts BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END;");
    assert.throws(() => store.adjustReserve(reserve, backing), /receipt unavailable/);
    assert.equal(store.domain(policy.clearingDomainId)!.state.recoveryReserveQuoteAtoms, 0n);
    assert.equal(store.events(policy.clearingDomainId).length, 1);
    raw.exec('DROP TRIGGER fail_backing_receipt');
    store.adjustReserve(reserve, backing);
    assert.throws(() => store.adjustReserve(reserve, backing), { code: 'STALE_BACKING' });
    const receipts = other.backingReceipts(policy.clearingDomainId);
    assert.deepEqual(receipts.map((receipt) => receipt.action), ['domains', 'accounts', 'marks', 'collateral', 'accounts', 'reserve']);
    assert.equal((receipts[5]!.proof as { blockNumber: bigint }).blockNumber, 123n);
    assert.equal(other.backingReceipts(policy.clearingDomainId, 5, 1).length, 1);
    assert.throws(() => other.backingReceipts(policy.clearingDomainId, -1), { code: 'INVALID_INPUT' });
    assert.throws(() => raw.exec('DELETE FROM native_clearing_backing_receipts'), /durable/);
    assert.throws(() => raw.exec("UPDATE native_clearing_backing_receipts SET action = 'forged'"), /immutable/);
    const reopened = new SqliteNativeClearingStore(path, () => 10_001);
    try {
      assert.deepEqual(reopened.backingReceipts(policy.clearingDomainId), receipts);
    } finally {
      reopened.close();
    }
  } finally {
    raw.close(); other.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
