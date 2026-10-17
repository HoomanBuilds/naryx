import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, domainRef, nativeClearingAccount, nativeClearingDomainState, nativeClearingPolicy, toHex, versionedManifestRef } from '@naryx/protocol-types';
import { getAddress, keccak256, type Hex } from 'viem';
import { EvmNativeClearingBackingVerifier, evmNativeClearingAccountId, type EvmNativeClearingBackingReadPort } from '../src/native-clearing-backing.js';

const hash = '11'.repeat(32);
const blockHash = `0x${'22'.repeat(32)}` as Hex;
const house = getAddress('0x' + '33'.repeat(20));
const token = getAddress('0x' + '44'.repeat(20));
const owner = getAddress('0x' + '55'.repeat(20));
const code = '0x6000';
const policy = nativeClearingPolicy({
  version: 1, clearingDomainId: 'test-clearing', environment: 'testnet', executionClassId: 'test-package',
  matchingPolicyHash: hash, strategySeries: versionedManifestRef('test-series', 1, hash), riskDomainId: 'test-risk',
  markSource: versionedManifestRef('test-mark', 1, hash), markAuthorityId: owner.toLowerCase(),
  accountingAsset: assetRef('test-usdc', hash, 6), packageQuantityIncrementAtoms: 1n, priceTickQuoteAtoms: 1n,
  initialMarginQuoteAtomsPerIncrement: 10n, maintenanceMarginQuoteAtomsPerIncrement: 5n,
  maximumPositionAtoms: 100n, maximumOpenInterestAtoms: 200n, maximumDefaultTransferDiscountBps: 500n,
  markMaximumStalenessMs: 60_000n,
});
const state = nativeClearingDomainState({ version: 1, policyHash: policy.policyHash, openInterestAtoms: 0n, recoveryReserveQuoteAtoms: 5n, sequence: 1n }, policy);
const account = nativeClearingAccount({ version: 1, policyHash: policy.policyHash, accountId: 'test-account', ownerId: owner.toLowerCase(), collateralQuoteAtoms: 10n, cashBalanceQuoteAtoms: 0n, positionAtoms: 0n, sequence: 1n }, policy);
const binding = { domain: domainRef('eip155:84532', 1, hash), clearingHouse: house, clearingHouseCodeHash: keccak256(code), collateralToken: token, collateralTokenCodeHash: keccak256(code), collateralAsset: policy.accountingAsset };

function reads(overrides: Partial<EvmNativeClearingBackingReadPort> = {}): EvmNativeClearingBackingReadPort {
  const fields: Record<string, unknown> = {
    policyHash: `0x${toHex(policy.policyHash)}`, collateralToken: token, markAuthority: owner,
    packageQuantityIncrementAtoms: 1n, priceTickQuoteAtoms: 1n, initialMarginQuoteAtomsPerIncrement: 10n,
    maintenanceMarginQuoteAtomsPerIncrement: 5n, maximumPositionAtoms: 100n, maximumOpenInterestAtoms: 200n,
    maximumDefaultTransferDiscountBps: 500, markMaximumStalenessSeconds: 60n, openInterestAtoms: 0n,
    recoveryReserveQuoteAtoms: 5n, feeBps: 0, accruedProtocolFees: 0n, entryPaused: true,
    account: { owner, collateralQuoteAtoms: 10n, cashBalanceQuoteAtoms: 0n, positionAtoms: 0n, sequence: 1n },
    balanceOf: 15n, decimals: 6,
  };
  return {
    chainId: async () => 84532n,
    finalizedBlock: async () => ({ number: 42n, hash: blockHash }),
    blockHash: async () => blockHash,
    code: async () => code,
    read: async (request, atBlock) => {
      assert.equal(atBlock, 42n);
      if (request.functionName === 'account') assert.deepEqual(request.args, [evmNativeClearingAccountId(`0x${toHex(policy.policyHash)}`, account.accountId)]);
      return fields[request.functionName];
    },
    ...overrides,
  };
}

test('clearing backing verifies pinned finalized account state and real token coverage', async () => {
  const proof = await new EvmNativeClearingBackingVerifier(binding, reads()).verify(policy, state, [account]);
  assert.equal(proof.evidenceGrade, 'FINALIZED_CONTRACT_STATE');
  assert.equal(proof.scope, 'REGISTERED_ACCOUNTS');
  assert.equal(proof.verifiedCollateralAndReserveAtoms, 15n);
  assert.equal(proof.verifiedAccountCount, 1);
  assert.equal(proof.entryPaused, true);
  const empty = await new EvmNativeClearingBackingVerifier(binding, reads()).verify(policy, state, []);
  assert.equal(empty.verifiedCollateralAndReserveAtoms, 5n);
  assert.notEqual(evmNativeClearingAccountId(`0x${hash}`, 'one'), evmNativeClearingAccountId(`0x${hash}`, 'two'));
  const historical = await new EvmNativeClearingBackingVerifier(binding, reads({ finalizedBlock: async () => ({ number: 100n, hash: blockHash }) }))
    .verify(policy, state, [account], { number: 42n, hash: blockHash });
  assert.equal(historical.blockNumber, 42n);
  await assert.rejects(new EvmNativeClearingBackingVerifier(binding, reads()).verify(policy, state, [account], { number: 43n, hash: blockHash }), /finalized/);
});

test('clearing backing rejects wrong networks, code, policy, funding and reorg evidence', async () => {
  assert.throws(() => new EvmNativeClearingBackingVerifier({ ...binding, domain: domainRef('eip155:1', 1, hash) }, reads()), /Sepolia/);
  await assert.rejects(new EvmNativeClearingBackingVerifier({ ...binding, collateralAsset: assetRef('another-usdc', hash, 6) }, reads()).verify(policy, state, [account]), /accounting asset/);
  const original = reads();
  const variants: Partial<EvmNativeClearingBackingReadPort>[] = [
    { chainId: async () => 1n },
    { code: async () => '0x6001' },
    { blockHash: async () => `0x${hash}` },
    { read: async (request, atBlock) => request.functionName === 'policyHash' ? `0x${hash}` : original.read(request, atBlock) },
    { read: async (request, atBlock) => request.functionName === 'balanceOf' ? 14n : original.read(request, atBlock) },
    { read: async (request, atBlock) => request.functionName === 'feeBps' ? 1 : original.read(request, atBlock) },
    { read: async (request, atBlock) => request.functionName === 'account' ? { owner, collateralQuoteAtoms: 10n, cashBalanceQuoteAtoms: 0n, positionAtoms: 0n, sequence: 2n } : original.read(request, atBlock) },
  ];
  for (const variant of variants) await assert.rejects(new EvmNativeClearingBackingVerifier(binding, reads(variant)).verify(policy, state, [account]));
  await assert.rejects(new EvmNativeClearingBackingVerifier(binding, reads()).verify(policy, state, [account, account]), /unique accounts/);
});

test('cash-settled gains still require token backing before conversion to collateral', async () => {
  const { accountHash, ...source } = account;
  const profitable = nativeClearingAccount({ ...source, cashBalanceQuoteAtoms: 5n }, policy);
  const original = reads();
  const port = (balance: bigint) => reads({ read: async (request, block) => request.functionName === 'account'
    ? { ...profitable, owner } : request.functionName === 'balanceOf' ? balance : original.read(request, block) });
  await assert.rejects(new EvmNativeClearingBackingVerifier(binding, port(19n)).verify(policy, state, [profitable]), /net cash liabilities/);
  assert.equal((await new EvmNativeClearingBackingVerifier(binding, port(20n)).verify(policy, state, [profitable])).tokenBalanceAtoms, 20n);
});
