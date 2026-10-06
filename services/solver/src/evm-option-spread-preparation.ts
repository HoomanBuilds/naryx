import {
  createEvmPremiaV3OptionMaterializer,
  structField,
  type EvmPremiaV3OptionLegBounds,
  type EvmStrategyCallPolicy,
} from '@naryx/adapter-evm';
import {
  bytesEqual,
  packageTemplateManifestHash,
  strategyPackageOrderHash,
  type DomainRegistryRecordInput,
  type DomainResourceLimit,
  type Hash32,
  type PackageTemplateManifest,
} from '@naryx/protocol-types';
import {
  encodeAbiParameters,
  getAddress,
  hexToBytes,
  keccak256,
  stringToHex,
  toHex,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import {
  readEvmOptionPoolSnapshot,
  type EvmOptionSpreadContractIdentity,
  type EvmOptionSpreadPoolBinding,
  type EvmOptionSpreadPricingInput,
  type EvmOptionSpreadReadPort,
  type EvmOptionSpreadRole,
} from './evm-option-spread-quote.js';
import { createEvmStrategyDomainCompiler } from './strategy-domain-compilers.js';
import type { StoredStrategyPackageDocuments } from './http-strategy-package-provider.js';
import type {
  StrategyPreparationContext,
  StrategyPreparationContextResolver,
} from './strategy-preparation-service.js';

const BPS = 10_000n;
const OPTION_MATERIALIZATION_CLASS = 'naryx.evm.premia-v3-option-exact';
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
const STRATEGY_ACCOUNT_ABI = [{
  type: 'function', name: 'owner', stateMutability: 'view',
  inputs: [], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'nextNonce', stateMutability: 'view',
  inputs: [], outputs: [{ name: '', type: 'uint256' }],
}, {
  type: 'function', name: 'packageState', stateMutability: 'view',
  inputs: [{ name: 'packageId', type: 'bytes32' }],
  outputs: [{
    name: '', type: 'tuple', components: [
      { name: 'template', type: 'tuple', components: [
        { name: 'templateId', type: 'bytes32' },
        { name: 'templateVersion', type: 'uint32' },
        { name: 'templateManifestHash', type: 'bytes32' },
      ] },
      { name: 'stateHash', type: 'bytes32' },
      { name: 'lastReceiptHash', type: 'bytes32' },
      { name: 'active', type: 'bool' },
    ],
  }],
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
const OPTION_POSITION_ABI = [{
  type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }, { name: 'tokenId', type: 'uint256' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;

export interface EvmOptionSpreadAdapterFactoryBinding {
  readonly role: EvmOptionSpreadRole;
  readonly factory: EvmOptionSpreadContractIdentity;
  readonly expectedAdapterCodeHash: Hex;
  readonly maximumGasLimit: bigint;
}

export interface EvmOptionSpreadPackageIdPort {
  resolvePackageId(expectedStateHash: Hex): Promise<Hex | undefined>;
}

export interface EvmOptionSpreadPreparationLane {
  readonly environment: 'testnet';
  readonly templateManifest: PackageTemplateManifest;
  readonly activeRegistryRecords: readonly DomainRegistryRecordInput[];
  readonly resourceLimits: readonly DomainResourceLimit[];
  readonly pricing: EvmOptionSpreadPricingInput;
  readonly accountFactory: EvmOptionSpreadContractIdentity;
  readonly expectedStrategyAccountCodeHash: Hex;
  readonly adapters: readonly [EvmOptionSpreadAdapterFactoryBinding, EvmOptionSpreadAdapterFactoryBinding];
  readonly solver: Address;
  readonly packageIds: EvmOptionSpreadPackageIdPort;
}

interface AccountPackageState {
  readonly stateHash: Hex;
  readonly active: boolean;
}

interface AdapterState {
  readonly role: EvmOptionSpreadRole;
  readonly address: Address;
  readonly codeHash: Hex;
  readonly longs: bigint;
  readonly shorts: bigint;
  readonly factory: EvmOptionSpreadAdapterFactoryBinding;
  readonly pool: EvmOptionSpreadPoolBinding;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM option spread preparation refused: ${message}`);
}

function hash(value: unknown, context: string, allowZero = false): Hex {
  requireCondition(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), `${context} must be bytes32`);
  const normalized = value.toLowerCase() as Hex;
  requireCondition(allowZero || normalized !== zeroHash, `${context} must be nonzero`);
  return normalized;
}

function asHash32(value: Hex): Hash32 {
  return hexToBytes(hash(value, 'hash')) as Hash32;
}

function role<T extends { readonly role: EvmOptionSpreadRole }>(
  values: readonly T[],
  expected: EvmOptionSpreadRole,
): T {
  const matches = values.filter((value) => value.role === expected);
  requireCondition(matches.length === 1, `${expected} binding must appear exactly once`);
  return matches[0]!;
}

function checkedBigInt(value: unknown, context: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= 0n, `${context} is invalid`);
  return value;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function quotePremium(
  basePremium: bigint,
  pricing: EvmOptionSpreadPricingInput,
  rounding: 'FLOOR' | 'CEIL',
): bigint {
  const numerator = basePremium * pricing.referencePriceQuoteAtomsPerWholeBase;
  const denominator = 10n ** BigInt(pricing.baseAsset.decimals);
  return rounding === 'CEIL' ? ceilDiv(numerator, denominator) : numerator / denominator;
}

function charge(documents: StoredStrategyPackageDocuments, category: 'PROTOCOL' | 'SOLVER'): bigint {
  return documents.quote.serviceCharges.find((candidate) => candidate.category === category)?.amount.atoms ?? 0n;
}

function positionStateHash(input: Readonly<{
  packageId: Hex;
  account: Address;
  longPool: Address;
  shortPool: Address;
  longQuantity: bigint;
  shortQuantity: bigint;
}>): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'address' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint256' },
      { type: 'uint256' },
    ],
    [input.packageId, input.account, input.longPool, input.shortPool, input.longQuantity, input.shortQuantity],
  ));
}

async function readAccountState(
  chain: EvmOptionSpreadReadPort,
  account: Address,
  packageId: Hex,
): Promise<Readonly<{ nonce: bigint; packageState: AccountPackageState }>> {
  const [nonceValue, packageValue] = await Promise.all([
    chain.readContract({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'nextNonce' }),
    chain.readContract({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'packageState', args: [packageId] }),
  ]);
  const stateHash = hash(structField(packageValue, 1, 'stateHash'), 'package state hash', true);
  const active = structField(packageValue, 3, 'active');
  requireCondition(typeof active === 'boolean', 'package active state is invalid');
  return Object.freeze({
    nonce: checkedBigInt(nonceValue, 'account nonce'),
    packageState: Object.freeze({ stateHash, active }),
  });
}

async function readAdapterState(
  lane: EvmOptionSpreadPreparationLane,
  roleId: EvmOptionSpreadRole,
  account: Address,
  packageId: Hex,
): Promise<AdapterState> {
  const chain = lane.pricing.chain;
  const factory = role(lane.adapters, roleId);
  const pool = role(lane.pricing.pools, roleId);
  const [factoryCode, addressValue] = await Promise.all([
    chain.codeHash(getAddress(factory.factory.address)),
    chain.readContract({
      address: getAddress(factory.factory.address),
      abi: ADAPTER_FACTORY_ABI,
      functionName: 'adapterOf',
      args: [account, packageId],
    }),
  ]);
  requireCondition(factoryCode !== undefined
    && hash(factoryCode, `${roleId} factory code hash`) === hash(factory.factory.expectedCodeHash, `${roleId} expected factory code hash`),
  `${roleId} adapter factory code changed`);
  const address = getAddress(String(addressValue));
  const [codeHashValue, validValue, longsValue, shortsValue] = await Promise.all([
    chain.codeHash(address),
    chain.readContract({
      address: getAddress(factory.factory.address),
      abi: ADAPTER_FACTORY_ABI,
      functionName: 'validateInstance',
      args: [address, account, packageId],
    }),
    chain.readContract({ address: getAddress(pool.pool.address), abi: OPTION_POSITION_ABI, functionName: 'balanceOf', args: [address, 1n] }),
    chain.readContract({ address: getAddress(pool.pool.address), abi: OPTION_POSITION_ABI, functionName: 'balanceOf', args: [address, 0n] }),
  ]);
  requireCondition(codeHashValue !== undefined
    && hash(codeHashValue, `${roleId} adapter code hash`) === hash(factory.expectedAdapterCodeHash, `${roleId} expected adapter code hash`),
  `${roleId} adapter is not provisioned with reviewed code`);
  requireCondition(validValue === true, `${roleId} adapter factory rejects the package instance`);
  return Object.freeze({
    role: roleId,
    address,
    codeHash: hash(codeHashValue, `${roleId} adapter code hash`),
    longs: checkedBigInt(longsValue, `${roleId} longs`),
    shorts: checkedBigInt(shortsValue, `${roleId} shorts`),
    factory,
    pool,
  });
}

function materializer(
  documents: StoredStrategyPackageDocuments,
  lane: EvmOptionSpreadPreparationLane,
  adapter: AdapterState,
  bounds: EvmPremiaV3OptionLegBounds,
) {
  const leg = documents.graph.legs.find((candidate) => candidate.legId === adapter.role);
  requireCondition(leg !== undefined, `${adapter.role} graph leg is missing`);
  return createEvmPremiaV3OptionMaterializer({
    binding: {
      domain: lane.pricing.domain,
      adapter: adapter.pool.adapter,
      venue: adapter.pool.venue,
      market: adapter.pool.market,
      legFamily: leg.legFamily,
      materializationClassId: OPTION_MATERIALIZATION_CLASS,
      adapterAddress: adapter.address,
      expectedAdapterCodeHash: adapter.codeHash,
      maximumGasLimit: adapter.factory.maximumGasLimit,
    },
    bounds: [bounds],
  });
}

export class EvmOptionSpreadPreparationContextResolver implements StrategyPreparationContextResolver {
  readonly #lanes: readonly EvmOptionSpreadPreparationLane[];

  constructor(lanes: readonly EvmOptionSpreadPreparationLane[]) {
    requireCondition(lanes.length > 0, 'at least one lane is required');
    this.#lanes = Object.freeze([...lanes]);
  }

  async resolve(documents: StoredStrategyPackageDocuments): Promise<StrategyPreparationContext> {
    const laneMatches = this.#lanes.filter((lane) =>
      lane.environment === documents.order.environment
      && lane.templateManifest.templateId === documents.order.templateId
      && lane.templateManifest.templateVersion === documents.order.templateVersion
      && bytesEqual(packageTemplateManifestHash(lane.templateManifest), documents.order.packageTemplateManifestHash)
      && documents.route.domainPlans.length === 1
      && documents.route.domainPlans[0]!.executionPlanKind === 'EVM_ATOMIC_BATCH'
      && documents.route.domainPlans[0]!.domain.domainId === lane.pricing.domain.domainId
      && bytesEqual(documents.route.domainPlans[0]!.domain.domainManifestHash, lane.pricing.domain.domainManifestHash));
    requireCondition(laneMatches.length === 1, 'package must resolve to exactly one preparation lane');
    const lane = laneMatches[0]!;
    requireCondition(documents.order.settlementClass === 'ATOMIC_POSTCONDITION'
      && documents.order.expiryUnit === 'EVM_UNIX_SECONDS', 'package is not an atomic EVM execution');
    const chain = lane.pricing.chain;
    const currentTime = await chain.latestBlockTimestamp();
    const chainId = await chain.chainId();
    requireCondition(chainId === lane.pricing.chainId, 'RPC chain identity differs from the lane');
    const orderHash = strategyPackageOrderHash(documents.order);
    const packageId = documents.order.lifecycleAction === 'ENTRY'
      ? toHex(orderHash)
      : await lane.packageIds.resolvePackageId(toHex(documents.order.expectedStrategyStateHash!));
    requireCondition(packageId !== undefined, 'prior strategy package is unknown');
    const checkedPackageId = hash(packageId, 'package id');
    const accountFactory = getAddress(lane.accountFactory.address);
    const owner = getAddress(documents.order.owner);
    const [factoryCode, accountValue, factoryAccountCodeHash] = await Promise.all([
      chain.codeHash(accountFactory),
      chain.readContract({ address: accountFactory, abi: ACCOUNT_FACTORY_ABI, functionName: 'accountOf', args: [owner] }),
      chain.readContract({ address: accountFactory, abi: ACCOUNT_FACTORY_ABI, functionName: 'accountCodeHash' }),
    ]);
    requireCondition(factoryCode !== undefined
      && hash(factoryCode, 'account factory code hash') === hash(lane.accountFactory.expectedCodeHash, 'expected account factory code hash'),
    'account factory code changed');
    requireCondition(hash(factoryAccountCodeHash, 'factory account code hash')
      === hash(lane.expectedStrategyAccountCodeHash, 'expected strategy account code hash'), 'factory account code identity changed');
    const account = getAddress(String(accountValue));
    requireCondition(account === getAddress(documents.order.settlementAccount), 'order settlement account is not the owner factory account');
    const [recognized, accountOwner, accountCode, accountState, longAdapter, shortAdapter, longPool, shortPool] = await Promise.all([
      chain.readContract({ address: accountFactory, abi: ACCOUNT_FACTORY_ABI, functionName: 'isAccount', args: [account] }),
      chain.readContract({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'owner' }),
      chain.codeHash(account),
      readAccountState(chain, account, checkedPackageId),
      readAdapterState(lane, 'option-long', account, checkedPackageId),
      readAdapterState(lane, 'option-short', account, checkedPackageId),
      readEvmOptionPoolSnapshot(lane.pricing, role(lane.pricing.pools, 'option-long')),
      readEvmOptionPoolSnapshot(lane.pricing, role(lane.pricing.pools, 'option-short')),
    ]);
    requireCondition(recognized === true && getAddress(String(accountOwner)) === owner, 'strategy account owner or factory recognition is invalid');
    requireCondition(accountCode !== undefined
      && hash(accountCode, 'strategy account code hash') === hash(lane.expectedStrategyAccountCodeHash, 'expected strategy account code hash'),
    'strategy account code changed');
    if (documents.order.lifecycleAction === 'ENTRY') {
      requireCondition(!accountState.packageState.active && accountState.packageState.stateHash === zeroHash,
        'entry package identity is already active');
    } else {
      const expectedState = toHex(documents.order.expectedStrategyStateHash!);
      requireCondition(accountState.packageState.active && accountState.packageState.stateHash === expectedState,
        'onchain package state differs from the signed expected state');
    }
    requireCondition(longAdapter.shorts === 0n && shortAdapter.longs === 0n, 'option adapter positions have the wrong side');
    const quantity = documents.order.economicQuantity.atoms;
    const opening = documents.order.lifecycleAction === 'ENTRY' || documents.order.lifecycleAction === 'INCREASE';
    const terminal = documents.order.lifecycleAction === 'EXIT' || documents.order.lifecycleAction === 'EMERGENCY_UNWIND';
    const decreasing = documents.order.lifecycleAction === 'DECREASE' || terminal;
    requireCondition(opening || decreasing, 'lifecycle action is unsupported');
    if (documents.order.lifecycleAction === 'ENTRY') {
      requireCondition(longAdapter.longs === 0n && shortAdapter.shorts === 0n, 'entry adapters already carry positions');
    } else {
      requireCondition(longAdapter.longs > 0n && longAdapter.longs === shortAdapter.shorts, 'open spread positions are unbalanced');
    }
    if (decreasing) {
      requireCondition(quantity <= longAdapter.longs, 'decrease exceeds the open spread');
      requireCondition(terminal ? quantity === longAdapter.longs : quantity < longAdapter.longs,
        terminal ? 'terminal action must close the entire spread' : 'decrease must leave an open spread');
    }
    const longPremium = ceilDiv(quantity * longPool.premiumBps, BPS);
    const shortPremium = ceilDiv(quantity * shortPool.premiumBps, BPS);
    const longPost = opening ? longAdapter.longs + quantity : longAdapter.longs - quantity;
    const shortPost = opening ? shortAdapter.shorts + quantity : shortAdapter.shorts - quantity;
    const longDelta = opening ? -longPremium : longPremium;
    const shortDelta = opening ? shortPremium - quantity : quantity - shortPremium;
    const longQuotePremium = quotePremium(longPremium, lane.pricing, opening ? 'CEIL' : 'FLOOR');
    const shortQuotePremium = quotePremium(shortPremium, lane.pricing, opening ? 'FLOOR' : 'CEIL');
    const quotedLong = documents.quote.legEconomics.find((leg) => leg.legId === 'option-long');
    const quotedShort = documents.quote.legEconomics.find((leg) => leg.legId === 'option-short');
    requireCondition(quotedLong?.executionPrice !== undefined && quotedShort?.executionPrice !== undefined,
      'quote lacks exact option execution prices');
    requireCondition(quotedLong.executionPrice.quoteAtoms * quantity === longQuotePremium * quotedLong.executionPrice.baseAtoms
      && quotedShort.executionPrice.quoteAtoms * quantity === shortQuotePremium * quotedShort.executionPrice.baseAtoms,
    'current pool premiums differ from the signed quote');
    const longBounds: EvmPremiaV3OptionLegBounds = Object.freeze({
      legId: 'option-long',
      premiumLimit: longPremium,
      maximumInputAtoms: opening ? longPremium : 0n,
      expectedPreLongs: longAdapter.longs,
      expectedPreShorts: 0n,
      expectedPostLongs: longPost,
      expectedPostShorts: 0n,
      minimumAccountTokenDelta: longDelta,
      maximumAccountTokenDelta: longDelta,
    });
    const shortBounds: EvmPremiaV3OptionLegBounds = Object.freeze({
      legId: 'option-short',
      premiumLimit: shortPremium,
      maximumInputAtoms: opening ? quantity : shortPremium,
      expectedPreLongs: 0n,
      expectedPreShorts: shortAdapter.shorts,
      expectedPostLongs: 0n,
      expectedPostShorts: shortPost,
      minimumAccountTokenDelta: shortDelta,
      maximumAccountTokenDelta: shortDelta,
    });
    const longNotional = quotedLong.grossNotional.atoms;
    const shortNotional = quotedShort.grossNotional.atoms;
    const policy = (
      adapter: AdapterState,
      approvalAtoms: bigint,
      grossNotionalAtoms: bigint,
    ): EvmStrategyCallPolicy => Object.freeze({
      legId: adapter.role,
      adapter: Object.freeze({
        subjectId: keccak256(stringToHex(adapter.pool.adapter.adapterId)),
        manifestVersion: adapter.pool.adapter.adapterManifestVersion,
        manifestHash: toHex(adapter.pool.adapter.adapterManifestHash),
      }),
      expectedAdapterAddress: adapter.address,
      expectedAdapterCodeHash: adapter.codeHash,
      riskIncreasing: opening,
      ...(approvalAtoms === 0n ? {} : { approvalToken: getAddress(lane.pricing.baseToken.address) }),
      approvalAtoms,
      grossNotionalAtoms,
    });
    const nextStateHash = terminal ? undefined : positionStateHash({
      packageId: checkedPackageId,
      account,
      longPool: longPool.pool,
      shortPool: shortPool.pool,
      longQuantity: longPost,
      shortQuantity: shortPost,
    });
    const deadline = [documents.order.expiryValue, documents.quote.validUntilValue, documents.route.routeExpiryValue]
      .reduce((minimum, value) => value < minimum ? value : minimum);
    requireCondition(currentTime < deadline, 'order, quote, or route has expired');
    return Object.freeze({
      compileContext: Object.freeze({
        templateManifest: lane.templateManifest,
        activeRegistryRecords: lane.activeRegistryRecords,
        resourceLimits: lane.resourceLimits,
        currentTime: Object.freeze({ unit: 'EVM_UNIX_SECONDS' as const, value: currentTime }),
      }),
      identity: Object.freeze({
        packageId: asHash32(checkedPackageId),
        templateId: documents.order.templateId,
        templateVersion: documents.order.templateVersion,
        templateManifestHash: documents.order.packageTemplateManifestHash,
        operation: documents.order.lifecycleAction,
        ...(documents.order.expectedStrategyStateHash === undefined
          ? {}
          : { previousStateHash: documents.order.expectedStrategyStateHash }),
        ...(nextStateHash === undefined ? {} : { nextStateHash: asHash32(nextStateHash) }),
      }),
      compilers: Object.freeze([createEvmStrategyDomainCompiler({
        domain: lane.pricing.domain,
        executionPlanKind: 'EVM_ATOMIC_BATCH',
        strategyAccount: account,
        materializers: Object.freeze([
          materializer(documents, lane, longAdapter, longBounds),
          materializer(documents, lane, shortAdapter, shortBounds),
        ]),
      })]),
      bindings: Object.freeze([{
        kind: 'EVM_MULTI_STRATEGY_ACCOUNT' as const,
        domain: lane.pricing.domain,
        account,
        chainId: Number(lane.pricing.chainId),
        solver: getAddress(lane.solver),
        totalGrossNotionalAtoms: longNotional + shortNotional,
        feePolicyVersion: documents.quote.feePolicyVersion,
        feePolicyManifestHash: toHex(documents.quote.feePolicyManifestHash),
        feeToken: getAddress(lane.pricing.quoteToken.address),
        protocolFeeAtoms: charge(documents, 'PROTOCOL'),
        solverFeeAtoms: charge(documents, 'SOLVER'),
        nonce: accountState.nonce,
        deadline,
        callPolicies: Object.freeze([
          policy(longAdapter, opening ? longPremium : 0n, longNotional),
          policy(shortAdapter, opening ? quantity : shortPremium, shortNotional),
        ]),
      }]),
    });
  }
}
