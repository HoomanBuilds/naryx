import assert from 'node:assert/strict';
import test from 'node:test';
import { zeroHash, type Address, type Hex } from 'viem';
import { compileEvmStrategyProvisioning } from '../src/index.js';

const address = (value: number) => `0x${value.toString(16).padStart(40, '0')}` as Address;
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}` as Hex;

function input(deployed: boolean) {
  return {
    chainId: 84532,
    owner: address(1),
    packageId: hash(1),
    account: {
      factory: { address: address(2), codeHash: hash(2) },
      expectedFactoryCodeHash: hash(2),
      account: { address: address(3), codeHash: deployed ? hash(3) : zeroHash },
      expectedAccountCodeHash: hash(3),
      factoryAccountOfOwner: address(3),
      factoryRecognizesAccount: deployed,
    },
    adapters: [{
      adapterId: 'spot-base-v1',
      factory: { address: address(4), codeHash: hash(4) },
      expectedFactoryCodeHash: hash(4),
      instance: { address: address(5), codeHash: deployed ? hash(5) : zeroHash },
      expectedInstanceCodeHash: hash(5),
      factoryAdapterOfPackage: address(5),
      factoryValidatesInstance: deployed,
    }, {
      adapterId: 'perp-base-v1',
      factory: { address: address(6), codeHash: hash(6) },
      expectedFactoryCodeHash: hash(6),
      instance: { address: address(7), codeHash: deployed ? hash(7) : zeroHash },
      expectedInstanceCodeHash: hash(7),
      factoryAdapterOfPackage: address(7),
      factoryValidatesInstance: deployed,
    }],
  } as const;
}

test('orders account creation before deterministic package adapters', () => {
  const plan = compileEvmStrategyProvisioning(input(false));
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.transactions.map((value) => value.kind), [
    'CREATE_STRATEGY_ACCOUNT',
    'CREATE_PACKAGE_ADAPTER',
    'CREATE_PACKAGE_ADAPTER',
  ]);
  assert.deepEqual(plan.transactions.map((value) => value.expectedAddress), [address(3), address(5), address(7)]);
});

test('returns ready only when every observed deployment is recognized', () => {
  const plan = compileEvmStrategyProvisioning(input(true));
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.transactions, []);
});

test('rejects a factory prediction or deployed code mismatch', () => {
  assert.throws(
    () => compileEvmStrategyProvisioning({
      ...input(true),
      account: { ...input(true).account, factoryAccountOfOwner: address(8) },
    }),
    /predicted another owner account/,
  );
  assert.throws(
    () => compileEvmStrategyProvisioning({
      ...input(true),
      adapters: [{ ...input(true).adapters[0], instance: { address: address(5), codeHash: hash(9) } }],
    }),
    /instance code hash mismatch/,
  );
});
