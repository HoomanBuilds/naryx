import {
  compileEvmStrategyProvisioning,
  type EvmStrategyProvisioningPlan,
} from '@naryx/adapter-evm';
import {
  bytesEqual,
  strategyPackageOrderHash,
  toHex,
  type AdapterRef,
  type DomainRef,
  type Hash32,
} from '@naryx/protocol-types';
import {
  getAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import type {
  StoredStrategyPackageOrderDocuments,
  StrategyPackageOrderProvider,
} from './http-strategy-package-provider.js';
import type {
  EvmOptionSpreadPreparationLane,
} from './evm-option-spread-preparation.js';
import type { EvmTreasuryHedgePreparationLane } from './evm-treasury-hedge-preparation.js';

const ACCOUNT_FACTORY_ABI = [{
  type: 'function', name: 'accountOf', stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'isAccount', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bool' }],
}, {
  type: 'function', name: 'accountCodeHash', stateMutability: 'view',
  inputs: [], outputs: [{ name: '', type: 'bytes32' }],
}] as const satisfies Abi;

const ADAPTER_FACTORY_ABI = [{
  type: 'function', name: 'adapterOf', stateMutability: 'view',
  inputs: [{ name: 'strategyAccount', type: 'address' }, { name: 'packageId', type: 'bytes32' }],
  outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'validateInstance', stateMutability: 'view',
  inputs: [
    { name: 'instance', type: 'address' },
    { name: 'strategyAccount', type: 'address' },
    { name: 'packageId', type: 'bytes32' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}] as const satisfies Abi;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM option spread provisioning refused: ${message}`);
}

function checkedHash(value: unknown, context: string): Hex {
  requireCondition(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), `${context} must be bytes32`);
  return value.toLowerCase() as Hex;
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

type EvmStrategyProvisioningLane = EvmOptionSpreadPreparationLane | EvmTreasuryHedgePreparationLane;

function legBindings(lane: EvmStrategyProvisioningLane): readonly Readonly<{ role: string; adapter: AdapterRef }>[] {
  return 'pools' in lane.pricing
    ? lane.pricing.pools.map((pool) => Object.freeze({ role: pool.role, adapter: pool.adapter }))
    : Object.freeze([
        Object.freeze({ role: 'inventory-position', adapter: lane.pricing.inventory.adapter }),
        Object.freeze({ role: 'treasury-hedge', adapter: lane.pricing.hedge.adapter }),
      ]);
}

function matchesLane(documents: StoredStrategyPackageOrderDocuments, lane: EvmStrategyProvisioningLane): boolean {
  const bindings = legBindings(lane);
  if (documents.order.environment !== lane.environment
    || documents.order.templateId !== lane.templateManifest.templateId
    || documents.order.templateVersion !== lane.templateManifest.templateVersion
    || documents.order.lifecycleAction !== 'ENTRY'
    || documents.graph.legs.length !== bindings.length) return false;
  return bindings.every((binding) => {
    const leg = documents.graph.legs.find((candidate) => candidate.legId === binding.role);
    return leg !== undefined && sameDomain(leg.domain, lane.pricing.domain) && sameAdapter(leg.adapter, binding.adapter);
  });
}

export class EvmOptionSpreadProvisioningResolver {
  readonly #lanes: readonly EvmStrategyProvisioningLane[];

  constructor(lanes: readonly EvmStrategyProvisioningLane[]) {
    requireCondition(lanes.length > 0, 'at least one lane is required');
    this.#lanes = Object.freeze([...lanes]);
  }

  async resolveAccount(input: Readonly<{ chainId: number; factory: Address; owner: Address }>): Promise<Readonly<{
    chainId: number;
    factory: Address;
    owner: Address;
    account: Address;
    deployed: boolean;
  }>> {
    const factory = getAddress(input.factory);
    const owner = getAddress(input.owner);
    const matches = this.#lanes.filter((lane) => Number(lane.pricing.chainId) === input.chainId
      && getAddress(lane.accountFactory.address) === factory);
    requireCondition(matches.length === 1, 'account request must resolve to exactly one lane');
    const lane = matches[0]!;
    const chain = lane.pricing.chain;
    requireCondition(await chain.chainId() === lane.pricing.chainId, 'RPC chain identity differs from the lane');
    const [factoryCode, accountValue, factoryAccountCodeHash] = await Promise.all([
      chain.codeHash(factory),
      chain.readContract({ address: factory, abi: ACCOUNT_FACTORY_ABI, functionName: 'accountOf', args: [owner] }),
      chain.readContract({ address: factory, abi: ACCOUNT_FACTORY_ABI, functionName: 'accountCodeHash' }),
    ]);
    requireCondition(factoryCode !== undefined
      && checkedHash(factoryCode, 'account factory code hash') === checkedHash(lane.accountFactory.expectedCodeHash, 'expected factory code hash'),
    'account factory code changed');
    requireCondition(checkedHash(factoryAccountCodeHash, 'factory account code hash')
      === checkedHash(lane.expectedStrategyAccountCodeHash, 'expected account code hash'), 'factory account code identity changed');
    const account = getAddress(String(accountValue));
    const accountCode = await chain.codeHash(account);
    if (accountCode !== undefined) {
      requireCondition(checkedHash(accountCode, 'strategy account code hash')
        === checkedHash(lane.expectedStrategyAccountCodeHash, 'expected account code hash'), 'strategy account code changed');
    }
    return Object.freeze({ chainId: input.chainId, factory, owner, account, deployed: accountCode !== undefined });
  }

  async resolve(documents: StoredStrategyPackageOrderDocuments): Promise<EvmStrategyProvisioningPlan> {
    const matches = this.#lanes.filter((lane) => matchesLane(documents, lane));
    requireCondition(matches.length === 1, 'entry order must resolve to exactly one lane');
    const lane = matches[0]!;
    const chain = lane.pricing.chain;
    requireCondition(await chain.chainId() === lane.pricing.chainId, 'RPC chain identity differs from the lane');
    const owner = getAddress(documents.order.owner);
    const packageId = `0x${toHex(strategyPackageOrderHash(documents.order))}` as Hex;
    const accountFactory = getAddress(lane.accountFactory.address);
    const [factoryCode, accountValue, factoryAccountCodeHash] = await Promise.all([
      chain.codeHash(accountFactory),
      chain.readContract({ address: accountFactory, abi: ACCOUNT_FACTORY_ABI, functionName: 'accountOf', args: [owner] }),
      chain.readContract({ address: accountFactory, abi: ACCOUNT_FACTORY_ABI, functionName: 'accountCodeHash' }),
    ]);
    requireCondition(factoryCode !== undefined, 'account factory has no code');
    requireCondition(checkedHash(factoryAccountCodeHash, 'factory account code hash')
      === checkedHash(lane.expectedStrategyAccountCodeHash, 'expected account code hash'), 'factory account code identity changed');
    const account = getAddress(String(accountValue));
    requireCondition(account === getAddress(documents.order.settlementAccount), 'order settlement account is not the predicted owner account');
    const [accountCode, accountRecognized] = await Promise.all([
      chain.codeHash(account),
      chain.readContract({ address: accountFactory, abi: ACCOUNT_FACTORY_ABI, functionName: 'isAccount', args: [account] }),
    ]);
    requireCondition(typeof accountRecognized === 'boolean', 'account factory recognition is invalid');
    const adapters = await Promise.all(lane.adapters.map(async (binding) => {
      const factory = getAddress(binding.factory.address);
      const [factoryCodeValue, adapterValue] = await Promise.all([
        chain.codeHash(factory),
        chain.readContract({
          address: factory,
          abi: ADAPTER_FACTORY_ABI,
          functionName: 'adapterOf',
          args: [account, packageId],
        }),
      ]);
      requireCondition(factoryCodeValue !== undefined, `${binding.role} adapter factory has no code`);
      const adapter = getAddress(String(adapterValue));
      const [adapterCode, valid] = await Promise.all([
        chain.codeHash(adapter),
        chain.readContract({
          address: factory,
          abi: ADAPTER_FACTORY_ABI,
          functionName: 'validateInstance',
          args: [adapter, account, packageId],
        }),
      ]);
      requireCondition(typeof valid === 'boolean', `${binding.role} adapter validation is invalid`);
      return Object.freeze({
        adapterId: binding.role,
        factory: Object.freeze({ address: factory, codeHash: factoryCodeValue }),
        expectedFactoryCodeHash: binding.factory.expectedCodeHash,
        instance: Object.freeze({ address: adapter, codeHash: adapterCode ?? zeroHash }),
        expectedInstanceCodeHash: binding.expectedAdapterCodeHash,
        factoryAdapterOfPackage: adapter,
        factoryValidatesInstance: valid,
      });
    }));
    return compileEvmStrategyProvisioning({
      chainId: Number(lane.pricing.chainId),
      owner,
      packageId,
      account: {
        factory: { address: accountFactory, codeHash: factoryCode },
        expectedFactoryCodeHash: lane.accountFactory.expectedCodeHash,
        account: { address: account, codeHash: accountCode ?? zeroHash },
        expectedAccountCodeHash: lane.expectedStrategyAccountCodeHash,
        factoryAccountOfOwner: account,
        factoryRecognizesAccount: accountRecognized,
      },
      adapters,
    });
  }
}

export class EvmOptionSpreadProvisioningService {
  readonly #packages: StrategyPackageOrderProvider;
  readonly #resolver: EvmOptionSpreadProvisioningResolver;

  constructor(packages: StrategyPackageOrderProvider, resolver: EvmOptionSpreadProvisioningResolver) {
    this.#packages = packages;
    this.#resolver = resolver;
  }

  async provisionByOrder(orderHash: Hash32): Promise<EvmStrategyProvisioningPlan | undefined> {
    const documents = await this.#packages.getByOrder(orderHash);
    return documents === undefined ? undefined : this.#resolver.resolve(documents);
  }

  resolveAccount(input: Readonly<{ chainId: number; factory: Address; owner: Address }>) {
    return this.#resolver.resolveAccount(input);
  }
}
