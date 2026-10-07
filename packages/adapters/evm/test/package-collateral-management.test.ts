import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress, type Hex } from 'viem';
import { compileEvmPackageCollateralManagement } from '../src/package-collateral-management.js';

const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`);
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;

function input() {
  return {
    chainId: 84_532,
    owner: address('1'),
    strategyAccount: address('2'),
    quoteHash: hash('3'),
    packageId: hash('4'),
    templateId: 'reverse-cash-and-carry-v1',
    templateVersion: 1,
    templateManifestHash: hash('5'),
    adapter: { subjectId: hash('6'), manifestVersion: 1, manifestHash: hash('7') },
    adapterAddress: address('8'),
    assetToken: address('9'),
    action: 'SUPPLY' as const,
    inputAtoms: 150_000_000n,
    currentOwnerAllowanceAtoms: 0n,
    expectedPreAccountDataHash: hash('a'),
    minimumOutputAtoms: 150_000_000n,
    maximumOutputAtoms: 150_000_000n,
    minimumPostCollateralBase: 148_500_000n,
    maximumPostCollateralBase: 151_500_000n,
    minimumPostHealthFactor: 2n * 10n ** 18n,
    grossNotionalAtoms: 150_000_000n,
    gasLimit: 600_000n,
    nonce: 0n,
    deadline: 2_000_000_000n,
  };
}

test('compiles exact approval and owner collateral management transactions', () => {
  const plan = compileEvmPackageCollateralManagement(input());
  assert.equal(plan.quoteHash, hash('3'));
  assert.equal(plan.minimumOutputAtoms, 150_000_000n);
  assert.deepEqual(plan.transactions.map((transaction) => transaction.kind), [
    'APPROVE_COLLATERAL',
    'MANAGE_PACKAGE_COLLATERAL',
  ]);
  assert.equal(plan.transactions[0]?.to, address('9'));
  assert.equal(plan.transactions[1]?.to, address('2'));
});

test('binds withdrawal to its quote and emits no token approval', () => {
  const candidate = input();
  const plan = compileEvmPackageCollateralManagement({
    ...candidate,
    quoteHash: hash('b'),
    action: 'WITHDRAW',
    inputAtoms: (2n ** 256n) - 1n,
    maximumOutputAtoms: (2n ** 256n) - 1n,
  });
  assert.equal(plan.quoteHash, hash('b'));
  assert.deepEqual(plan.transactions.map((transaction) => transaction.kind), ['MANAGE_PACKAGE_COLLATERAL']);
  assert.notEqual(plan.intentHash, compileEvmPackageCollateralManagement(candidate).intentHash);
});
