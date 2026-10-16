import assert from 'node:assert/strict';
import test from 'node:test';
import { domainRef, nativeClearingAccount, nativeClearingCollateralAuthorization, nativeClearingDomainState, nativeClearingMarkObservation } from '@naryx/protocol-types';
import { NativeClearingBackingService } from '../src/native-clearing-backing.js';
import { fixture, takerSigner } from './native-clearing-fixtures.js';

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
