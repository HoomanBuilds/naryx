import {
  encodeFunctionData,
  getAddress,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';

const ACCOUNT_FACTORY_ABI = [{
  type: 'function',
  name: 'create',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'owner', type: 'address' }],
  outputs: [{ name: 'account', type: 'address' }],
}] as const;

const ADAPTER_FACTORY_ABI = [{
  type: 'function',
  name: 'create',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'strategyAccount', type: 'address' }, { name: 'packageId', type: 'bytes32' }],
  outputs: [{ name: 'instance', type: 'address' }],
}] as const;

export interface EvmObservedContract {
  readonly address: Address;
  readonly codeHash: Hex;
}

export interface EvmStrategyAccountProvisioningSnapshot {
  readonly factory: EvmObservedContract;
  readonly expectedFactoryCodeHash: Hex;
  readonly account: EvmObservedContract;
  readonly expectedAccountCodeHash: Hex;
  readonly factoryAccountOfOwner: Address;
  readonly factoryRecognizesAccount: boolean;
}

export interface EvmStrategyAdapterProvisioningSnapshot {
  readonly adapterId: string;
  readonly factory: EvmObservedContract;
  readonly expectedFactoryCodeHash: Hex;
  readonly instance: EvmObservedContract;
  readonly expectedInstanceCodeHash: Hex;
  readonly factoryAdapterOfPackage: Address;
  readonly factoryValidatesInstance: boolean;
}

export interface EvmProvisioningTransaction {
  readonly kind: 'CREATE_STRATEGY_ACCOUNT' | 'CREATE_PACKAGE_ADAPTER';
  readonly to: Address;
  readonly data: Hex;
  readonly value: 0n;
  readonly expectedAddress: Address;
  readonly expectedCodeHash: Hex;
  readonly adapterId?: string;
}

export interface EvmStrategyProvisioningPlan {
  readonly version: 1;
  readonly chainId: number;
  readonly owner: Address;
  readonly packageId: Hex;
  readonly strategyAccount: Address;
  readonly transactions: readonly EvmProvisioningTransaction[];
  readonly ready: boolean;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkedHash(value: Hex, context: string, allowZero = false): Hex {
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(value), `${context} must be bytes32`);
  const normalized = value.toLowerCase() as Hex;
  requireCondition(allowZero || normalized !== zeroHash, `${context} must be nonzero`);
  return normalized;
}

function checkedObserved(value: EvmObservedContract, context: string): EvmObservedContract {
  const address = getAddress(value.address);
  requireCondition(address !== zeroAddress, `${context} address is zero`);
  return Object.freeze({ address, codeHash: checkedHash(value.codeHash, `${context} code hash`, true) });
}

export function compileEvmStrategyProvisioning(input: Readonly<{
  chainId: number;
  owner: Address;
  packageId: Hex;
  account: EvmStrategyAccountProvisioningSnapshot;
  adapters: readonly EvmStrategyAdapterProvisioningSnapshot[];
}>): EvmStrategyProvisioningPlan {
  requireCondition(Number.isSafeInteger(input.chainId) && input.chainId > 0, 'chain id is invalid');
  const owner = getAddress(input.owner);
  requireCondition(owner !== zeroAddress, 'owner is zero');
  const packageId = checkedHash(input.packageId, 'package id');
  const accountFactory = checkedObserved(input.account.factory, 'account factory');
  const account = checkedObserved(input.account.account, 'strategy account');
  const expectedAccountFactoryCodeHash = checkedHash(input.account.expectedFactoryCodeHash, 'expected account factory code hash');
  const expectedAccountCodeHash = checkedHash(input.account.expectedAccountCodeHash, 'expected account code hash');
  requireCondition(accountFactory.codeHash === expectedAccountFactoryCodeHash, 'account factory code hash mismatch');
  requireCondition(getAddress(input.account.factoryAccountOfOwner) === account.address, 'account factory predicted another owner account');

  const accountDeployed = account.codeHash !== zeroHash;
  if (accountDeployed) {
    requireCondition(account.codeHash === expectedAccountCodeHash, 'strategy account code hash mismatch');
    requireCondition(input.account.factoryRecognizesAccount, 'account factory does not recognize the strategy account');
  } else {
    requireCondition(!input.account.factoryRecognizesAccount, 'account factory recognizes an account without code');
  }

  const transactions: EvmProvisioningTransaction[] = [];
  if (!accountDeployed) {
    transactions.push(Object.freeze({
      kind: 'CREATE_STRATEGY_ACCOUNT',
      to: accountFactory.address,
      data: encodeFunctionData({ abi: ACCOUNT_FACTORY_ABI, functionName: 'create', args: [owner] }),
      value: 0n,
      expectedAddress: account.address,
      expectedCodeHash: expectedAccountCodeHash,
    }));
  }

  const adapterIds = new Set<string>();
  const factoryAddresses = new Set<string>();
  const instanceAddresses = new Set<string>();
  for (const candidate of input.adapters) {
    requireCondition(/^[A-Za-z0-9._:-]{1,128}$/.test(candidate.adapterId), 'adapter id is invalid');
    requireCondition(!adapterIds.has(candidate.adapterId), `adapter ${candidate.adapterId} is repeated`);
    adapterIds.add(candidate.adapterId);
    const factory = checkedObserved(candidate.factory, `adapter ${candidate.adapterId} factory`);
    const instance = checkedObserved(candidate.instance, `adapter ${candidate.adapterId} instance`);
    const expectedFactoryCodeHash = checkedHash(candidate.expectedFactoryCodeHash, `adapter ${candidate.adapterId} expected factory code hash`);
    const expectedInstanceCodeHash = checkedHash(candidate.expectedInstanceCodeHash, `adapter ${candidate.adapterId} expected instance code hash`);
    requireCondition(factory.codeHash === expectedFactoryCodeHash, `adapter ${candidate.adapterId} factory code hash mismatch`);
    requireCondition(!factoryAddresses.has(factory.address), `adapter factory ${factory.address} is repeated`);
    requireCondition(!instanceAddresses.has(instance.address), `adapter instance ${instance.address} is repeated`);
    factoryAddresses.add(factory.address);
    instanceAddresses.add(instance.address);
    requireCondition(
      getAddress(candidate.factoryAdapterOfPackage) === instance.address,
      `adapter ${candidate.adapterId} factory predicted another package instance`,
    );
    const deployed = instance.codeHash !== zeroHash;
    if (deployed) {
      requireCondition(instance.codeHash === expectedInstanceCodeHash, `adapter ${candidate.adapterId} instance code hash mismatch`);
      requireCondition(candidate.factoryValidatesInstance, `adapter ${candidate.adapterId} factory rejects its deployed instance`);
      continue;
    }
    requireCondition(!candidate.factoryValidatesInstance, `adapter ${candidate.adapterId} factory validates an instance without code`);
    transactions.push(Object.freeze({
      kind: 'CREATE_PACKAGE_ADAPTER',
      to: factory.address,
      data: encodeFunctionData({
        abi: ADAPTER_FACTORY_ABI,
        functionName: 'create',
        args: [account.address, packageId],
      }),
      value: 0n,
      expectedAddress: instance.address,
      expectedCodeHash: expectedInstanceCodeHash,
      adapterId: candidate.adapterId,
    }));
  }

  return Object.freeze({
    version: 1,
    chainId: input.chainId,
    owner,
    packageId,
    strategyAccount: account.address,
    transactions: Object.freeze(transactions),
    ready: transactions.length === 0,
  });
}
