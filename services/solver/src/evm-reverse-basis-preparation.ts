import {
  createEvmAaveV3LendingMaterializer,
  createEvmExactPerpMaterializer,
  createEvmExactSpotMaterializer,
  structField,
  type EvmAaveV3LendingLegBounds,
  type EvmExactPerpLegBounds,
  type EvmStrategyCallPolicy,
} from '@naryx/adapter-evm';
import {
  bytesEqual,
  packageTemplateManifestHash,
  strategyPackageOrderHash,
  type AdapterRef,
  type DomainRegistryRecordInput,
  type DomainResourceLimit,
  type Hash32,
  type PackageTemplateManifest,
  type VersionedManifestRef,
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
  readEvmCollateralConversionSpotSnapshot,
  type EvmCollateralConversionPricingInput,
} from './evm-collateral-conversion-quote.js';
import type { StoredStrategyPackageDocuments } from './http-strategy-package-provider.js';
import type { EvmOptionSpreadContractIdentity } from './evm-option-spread-quote.js';
import type { EvmOptionSpreadPackageIdPort } from './evm-option-spread-preparation.js';
import type { EvmReverseBasisPricingInput } from './evm-reverse-basis-quote.js';
import { readEvmTreasuryHedgeMarketSnapshot, type EvmTreasuryHedgePricingInput } from './evm-treasury-hedge-quote.js';
import { createEvmStrategyDomainCompiler } from './strategy-domain-compilers.js';
import type { StrategyPreparationContext, StrategyPreparationContextResolver } from './strategy-preparation-service.js';

const WAD = 10n ** 18n;
const BPS = 10_000n;
const SPOT_CLASS = 'naryx.evm.spot-exact';
const LENDING_CLASS = 'naryx.evm.aave-v3-lending-exact';
const PERP_CLASS = 'naryx.evm.perp-exact';
const ACCOUNT_FACTORY_ABI = [{
  type: 'function', name: 'accountOf', stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'isAccount', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bool' }],
}, {
  type: 'function', name: 'accountCodeHash', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }],
}] as const satisfies Abi;
const STRATEGY_ACCOUNT_ABI = [{
  type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'nextNonce', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }],
}, {
  type: 'function', name: 'packageState', stateMutability: 'view', inputs: [{ name: 'packageId', type: 'bytes32' }],
  outputs: [{ name: '', type: 'tuple', components: [
    { name: 'template', type: 'tuple', components: [
      { name: 'templateId', type: 'bytes32' }, { name: 'templateVersion', type: 'uint32' },
      { name: 'templateManifestHash', type: 'bytes32' },
    ] },
    { name: 'stateHash', type: 'bytes32' }, { name: 'lastReceiptHash', type: 'bytes32' }, { name: 'active', type: 'bool' },
  ] }],
}] as const satisfies Abi;
const ADAPTER_FACTORY_ABI = [{
  type: 'function', name: 'adapterOf', stateMutability: 'view',
  inputs: [{ name: 'strategyAccount', type: 'address' }, { name: 'packageId', type: 'bytes32' }],
  outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'validateInstance', stateMutability: 'view',
  inputs: [{ name: 'instance', type: 'address' }, { name: 'strategyAccount', type: 'address' }, { name: 'packageId', type: 'bytes32' }],
  outputs: [{ name: '', type: 'bool' }],
}] as const satisfies Abi;
const LENDING_ADAPTER_ABI = [{
  type: 'function', name: 'accountData', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'tuple', components: [
    { name: 'totalCollateralBase', type: 'uint256' }, { name: 'totalDebtBase', type: 'uint256' },
    { name: 'availableBorrowsBase', type: 'uint256' }, { name: 'currentLiquidationThreshold', type: 'uint256' },
    { name: 'ltv', type: 'uint256' }, { name: 'healthFactor', type: 'uint256' },
  ] }],
}] as const satisfies Abi;
const PERP_ADAPTER_ABI = [{
  type: 'function', name: 'position', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'tuple', components: [
    { name: 'balance', type: 'int128' }, { name: 'size', type: 'int128' },
    { name: 'entryNotional', type: 'uint128' }, { name: 'entrySocialLossIndex', type: 'uint128' },
    { name: 'entryFundingIndex', type: 'int128' },
  ] }],
}] as const satisfies Abi;
const PERP_MARKET_ABI = [{
  type: 'function', name: 'reserveOf', stateMutability: 'view',
  inputs: [{ name: 'trader', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
}, {
  type: 'function', name: 'previewClose', stateMutability: 'view', inputs: [{ name: 'trader', type: 'address' }],
  outputs: [{ name: '', type: 'tuple', components: [
    { name: 'exitNotional', type: 'uint256' }, { name: 'realizedPnl', type: 'int256' },
    { name: 'funding', type: 'int256' }, { name: 'charged', type: 'uint256' },
    { name: 'payout', type: 'uint256' }, { name: 'badDebt', type: 'uint256' },
  ] }],
}, {
  type: 'function', name: 'previewIncrease', stateMutability: 'view',
  inputs: [
    { name: 'trader', type: 'address' }, { name: 'sizeDelta', type: 'int128' },
    { name: 'balanceWad', type: 'uint256' },
  ],
  outputs: [
    { name: 'post', type: 'tuple', components: [
      { name: 'balance', type: 'int128' }, { name: 'size', type: 'int128' },
      { name: 'entryNotional', type: 'uint128' }, { name: 'entrySocialLossIndex', type: 'uint128' },
      { name: 'entryFundingIndex', type: 'int128' },
    ] },
    { name: 'fillPriceWad', type: 'uint256' }, { name: 'feeWad', type: 'uint256' },
  ],
}, {
  type: 'function', name: 'previewDecrease', stateMutability: 'view',
  inputs: [{ name: 'trader', type: 'address' }, { name: 'sizeDelta', type: 'int128' }],
  outputs: [
    { name: 'post', type: 'tuple', components: [
      { name: 'balance', type: 'int128' }, { name: 'size', type: 'int128' },
      { name: 'entryNotional', type: 'uint128' }, { name: 'entrySocialLossIndex', type: 'uint128' },
      { name: 'entryFundingIndex', type: 'int128' },
    ] },
    { name: 'settlement', type: 'tuple', components: [
      { name: 'exitNotional', type: 'uint256' }, { name: 'realizedPnl', type: 'int256' },
      { name: 'funding', type: 'int256' }, { name: 'charged', type: 'uint256' },
      { name: 'payout', type: 'uint256' }, { name: 'badDebt', type: 'uint256' },
    ] },
  ],
}] as const satisfies Abi;

type AdapterRole = 'base-borrow' | 'spot-sale' | 'perp-purchase';

export interface EvmReverseBasisAdapterFactoryBinding {
  readonly role: AdapterRole;
  readonly factory: EvmOptionSpreadContractIdentity;
  readonly expectedAdapterCodeHash: Hex;
  readonly maximumGasLimit: bigint;
}

export interface EvmReverseBasisPreparationLane {
  readonly environment: 'testnet';
  readonly templateManifest: PackageTemplateManifest;
  readonly activeRegistryRecords: readonly DomainRegistryRecordInput[];
  readonly resourceLimits: readonly DomainResourceLimit[];
  readonly pricing: EvmReverseBasisPricingInput;
  readonly accountFactory: EvmOptionSpreadContractIdentity;
  readonly expectedStrategyAccountCodeHash: Hex;
  readonly adapters: readonly [
    EvmReverseBasisAdapterFactoryBinding,
    EvmReverseBasisAdapterFactoryBinding,
    EvmReverseBasisAdapterFactoryBinding,
  ];
  readonly debtBaseAtomsPerWholeBaseToken: bigint;
  readonly debtBaseToleranceBps: bigint;
  readonly collateralBaseAtomsPerWholeQuoteToken: bigint;
  readonly collateralBaseToleranceBps: bigint;
  readonly solver: Address;
  readonly packageIds: EvmOptionSpreadPackageIdPort;
}

interface Position {
  readonly balance: bigint;
  readonly size: bigint;
  readonly entryNotional: bigint;
  readonly entrySocialLossIndex: bigint;
  readonly entryFundingIndex: bigint;
}

interface AccountData {
  readonly totalCollateralBase: bigint;
  readonly totalDebtBase: bigint;
  readonly availableBorrowsBase: bigint;
  readonly currentLiquidationThreshold: bigint;
  readonly ltv: bigint;
  readonly healthFactor: bigint;
}

interface AdapterState {
  readonly role: AdapterRole;
  readonly address: Address;
  readonly codeHash: Hex;
  readonly factory: EvmReverseBasisAdapterFactoryBinding;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM reverse basis preparation refused: ${message}`);
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

function bigintValue(value: unknown, context: string): bigint {
  requireCondition(typeof value === 'bigint', `${context} is invalid`);
  return value;
}

function natural(value: unknown, context: string): bigint {
  const checked = bigintValue(value, context);
  requireCondition(checked >= 0n, `${context} is negative`);
  return checked;
}

function field(value: unknown, index: number, context: string): bigint {
  return natural(structField(value, index, context), context);
}

function accountData(value: unknown): AccountData {
  return Object.freeze({
    totalCollateralBase: field(value, 0, 'total collateral'),
    totalDebtBase: field(value, 1, 'total debt'),
    availableBorrowsBase: field(value, 2, 'available borrows'),
    currentLiquidationThreshold: field(value, 3, 'liquidation threshold'),
    ltv: field(value, 4, 'ltv'),
    healthFactor: field(value, 5, 'health factor'),
  });
}

function accountDataHash(value: AccountData): Hex {
  return keccak256(encodeAbiParameters([{ type: 'tuple', components: [
    { name: 'totalCollateralBase', type: 'uint256' }, { name: 'totalDebtBase', type: 'uint256' },
    { name: 'availableBorrowsBase', type: 'uint256' }, { name: 'currentLiquidationThreshold', type: 'uint256' },
    { name: 'ltv', type: 'uint256' }, { name: 'healthFactor', type: 'uint256' },
  ] }], [value]));
}

function position(value: unknown): Position {
  return Object.freeze({
    balance: bigintValue(structField(value, 0, 'balance'), 'position balance'),
    size: bigintValue(structField(value, 1, 'size'), 'position size'),
    entryNotional: field(value, 2, 'entry notional'),
    entrySocialLossIndex: field(value, 3, 'social loss index'),
    entryFundingIndex: bigintValue(structField(value, 4, 'funding index'), 'funding index'),
  });
}

function positionHash(value: Position): Hex {
  return keccak256(encodeAbiParameters([{ type: 'tuple', components: [
    { name: 'balance', type: 'int128' }, { name: 'size', type: 'int128' },
    { name: 'entryNotional', type: 'uint128' }, { name: 'entrySocialLossIndex', type: 'uint128' },
    { name: 'entryFundingIndex', type: 'int128' },
  ] }], [value]));
}

function strategyStateHash(input: Readonly<{
  packageId: Hex;
  account: Address;
  adapters: readonly [AdapterState, AdapterState, AdapterState];
  lendingBounds: EvmAaveV3LendingLegBounds;
  hedgePosition: Position;
}>): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address[3]' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [input.packageId, input.account, input.adapters.map((item) => item.address) as [Address, Address, Address],
      keccak256(encodeAbiParameters([
        { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
      ], [input.lendingBounds.minimumPostCollateralBase, input.lendingBounds.maximumPostCollateralBase,
        input.lendingBounds.minimumPostDebtBase, input.lendingBounds.maximumPostDebtBase,
        input.lendingBounds.minimumPostHealthFactor])), positionHash(input.hedgePosition)],
  ));
}

function packedSigned128(value: bigint): bigint {
  requireCondition(value >= -(1n << 127n) && value < (1n << 127n), 'trade value is outside int128');
  return BigInt.asUintN(128, value);
}

function tradeArgs(expiry: bigint, deadline: bigint, sizeDelta: bigint, balanceDelta: bigint): readonly [Hex, Hex] {
  requireCondition(expiry > 0n && expiry <= 0xffff_ffffn && deadline > 0n && deadline <= 0xffff_ffff_ffff_ffffn,
    'trade expiry or deadline is out of range');
  return Object.freeze([
    toHex((deadline << 56n) | expiry, { size: 32 }),
    toHex((packedSigned128(sizeDelta) << 128n) | packedSigned128(balanceDelta), { size: 32 }),
  ]);
}

function charge(documents: StoredStrategyPackageDocuments, category: 'PROTOCOL' | 'SOLVER'): bigint {
  return documents.quote.serviceCharges.find((item) => item.category === category)?.amount.atoms ?? 0n;
}

function role<T extends { readonly role: AdapterRole }>(values: readonly T[], expected: AdapterRole): T {
  const matches = values.filter((item) => item.role === expected);
  requireCondition(matches.length === 1, `${expected} binding must appear exactly once`);
  return matches[0]!;
}

function legBinding(pricing: EvmReverseBasisPricingInput, roleId: AdapterRole): Readonly<{
  adapter: AdapterRef;
  venue: VersionedManifestRef;
  market: VersionedManifestRef;
}> {
  return roleId === 'base-borrow' ? pricing.lending : roleId === 'spot-sale' ? pricing.spot : pricing.hedge;
}

async function readAdapter(
  lane: EvmReverseBasisPreparationLane,
  roleId: AdapterRole,
  account: Address,
  packageId: Hex,
): Promise<AdapterState> {
  const binding = role(lane.adapters, roleId);
  const factory = getAddress(binding.factory.address);
  const [factoryCode, addressValue] = await Promise.all([
    lane.pricing.chain.codeHash(factory),
    lane.pricing.chain.readContract({ address: factory, abi: ADAPTER_FACTORY_ABI, functionName: 'adapterOf', args: [account, packageId] }),
  ]);
  requireCondition(factoryCode !== undefined && hash(factoryCode, `${roleId} factory code`)
    === hash(binding.factory.expectedCodeHash, `${roleId} expected factory code`), `${roleId} adapter factory code changed`);
  const address = getAddress(String(addressValue));
  const [code, valid] = await Promise.all([
    lane.pricing.chain.codeHash(address),
    lane.pricing.chain.readContract({ address: factory, abi: ADAPTER_FACTORY_ABI,
      functionName: 'validateInstance', args: [address, account, packageId] }),
  ]);
  requireCondition(code !== undefined && hash(code, `${roleId} adapter code`)
    === hash(binding.expectedAdapterCodeHash, `${roleId} expected adapter code`) && valid === true,
  `${roleId} adapter is not a reviewed package instance`);
  return Object.freeze({ role: roleId, address, codeHash: hash(code, `${roleId} adapter code`), factory: binding });
}

function spotPricing(input: EvmReverseBasisPricingInput): EvmCollateralConversionPricingInput {
  return Object.freeze({
    chainId: input.chainId, domain: input.domain, collateralAsset: input.baseAsset, quoteAsset: input.quoteAsset,
    collateralToken: input.baseToken, quoteToken: input.quoteToken, spotFactory: input.spotFactory,
    spotPool: input.spotPool, spotQuoter: input.spotQuoter, spotPoolFee: input.spotPoolFee,
    lendingPool: input.lendingPool, oracle: input.oracle, perpetualMarket: input.perpetualMarket,
    swap: input.spot, collateralTransfer: input.lending, hedge: input.hedge,
    minimumPostHealthFactor: input.minimumPostHealthFactor, protocolFeeBps: input.protocolFeeBps,
    solverFeeBps: input.solverFeeBps, networkFeeQuoteAtoms: input.networkFeeQuoteAtoms,
    feePolicyVersion: input.feePolicyVersion, feePolicyManifestHash: input.feePolicyManifestHash,
    routeTtlSeconds: input.routeTtlSeconds, quoteTtlSeconds: input.quoteTtlSeconds,
    chain: input.chain, nonceSource: input.nonceSource,
  });
}

function hedgePricing(input: EvmReverseBasisPricingInput): EvmTreasuryHedgePricingInput {
  return Object.freeze({
    chainId: input.chainId, domain: input.domain, inventoryAsset: input.baseAsset, quoteAsset: input.quoteAsset,
    inventoryToken: input.baseToken, quoteToken: input.quoteToken, oracle: input.oracle,
    market: input.perpetualMarket, inventory: input.spot, hedge: input.hedge,
    protocolFeeBps: input.protocolFeeBps, solverFeeBps: input.solverFeeBps,
    networkFeeQuoteAtoms: input.networkFeeQuoteAtoms, feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash, routeTtlSeconds: input.routeTtlSeconds,
    quoteTtlSeconds: input.quoteTtlSeconds, chain: input.chain, nonceSource: input.nonceSource,
  });
}

export class EvmReverseBasisPreparationContextResolver implements StrategyPreparationContextResolver {
  readonly #lanes: readonly EvmReverseBasisPreparationLane[];

  constructor(lanes: readonly EvmReverseBasisPreparationLane[]) {
    requireCondition(lanes.length > 0, 'at least one lane is required');
    this.#lanes = Object.freeze([...lanes]);
  }

  async resolve(documents: StoredStrategyPackageDocuments): Promise<StrategyPreparationContext> {
    const matches = this.#lanes.filter((lane) => lane.environment === documents.order.environment
      && lane.templateManifest.templateId === documents.order.templateId
      && lane.templateManifest.templateVersion === documents.order.templateVersion
      && bytesEqual(packageTemplateManifestHash(lane.templateManifest), documents.order.packageTemplateManifestHash)
      && documents.route.domainPlans.length === 1 && documents.route.domainPlans[0]!.executionPlanKind === 'EVM_ATOMIC_BATCH'
      && documents.route.domainPlans[0]!.domain.domainId === lane.pricing.domain.domainId
      && bytesEqual(documents.route.domainPlans[0]!.domain.domainManifestHash, lane.pricing.domain.domainManifestHash));
    requireCondition(matches.length === 1, 'package must resolve to exactly one preparation lane');
    const lane = matches[0]!;
    requireCondition(documents.order.settlementClass === 'ATOMIC_POSTCONDITION'
      && documents.order.expiryUnit === 'EVM_UNIX_SECONDS', 'package is not an atomic EVM execution');
    requireCondition(lane.debtBaseAtomsPerWholeBaseToken > 0n && lane.debtBaseToleranceBps <= 1_000n,
      'debt risk configuration is invalid');
    const chain = lane.pricing.chain;
    const [currentTime, chainId] = await Promise.all([chain.latestBlockTimestamp(), chain.chainId()]);
    requireCondition(chainId === lane.pricing.chainId, 'RPC chain identity differs from the lane');
    const packageId = documents.order.lifecycleAction === 'ENTRY'
      ? toHex(strategyPackageOrderHash(documents.order))
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
    requireCondition(factoryCode !== undefined && hash(factoryCode, 'account factory code')
      === hash(lane.accountFactory.expectedCodeHash, 'expected account factory code'), 'account factory code changed');
    requireCondition(hash(factoryAccountCodeHash, 'factory account code')
      === hash(lane.expectedStrategyAccountCodeHash, 'expected account code'), 'factory account code identity changed');
    const account = getAddress(String(accountValue));
    requireCondition(account === getAddress(documents.order.settlementAccount), 'settlement account is not the owner factory account');
    const [recognized, accountOwner, accountCode, nonceValue, packageValue, lendingAdapter, spotAdapter, hedgeAdapter] = await Promise.all([
      chain.readContract({ address: accountFactory, abi: ACCOUNT_FACTORY_ABI, functionName: 'isAccount', args: [account] }),
      chain.readContract({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'owner' }),
      chain.codeHash(account),
      chain.readContract({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'nextNonce' }),
      chain.readContract({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'packageState', args: [checkedPackageId] }),
      readAdapter(lane, 'base-borrow', account, checkedPackageId),
      readAdapter(lane, 'spot-sale', account, checkedPackageId),
      readAdapter(lane, 'perp-purchase', account, checkedPackageId),
    ]);
    requireCondition(recognized === true && getAddress(String(accountOwner)) === owner, 'strategy account ownership is invalid');
    requireCondition(accountCode !== undefined && hash(accountCode, 'strategy account code')
      === hash(lane.expectedStrategyAccountCodeHash, 'expected account code'), 'strategy account code changed');
    const accountStateHash = hash(structField(packageValue, 1, 'stateHash'), 'package state hash', true);
    const accountActive = structField(packageValue, 3, 'active');
    requireCondition(typeof accountActive === 'boolean', 'package active state is invalid');
    if (documents.order.lifecycleAction === 'ENTRY') {
      requireCondition(!accountActive && accountStateHash === zeroHash, 'entry package is already active');
    } else {
      requireCondition(accountActive && accountStateHash === toHex(documents.order.expectedStrategyStateHash!),
        'onchain package state differs from the signed expected state');
    }
    const [lendingValue, positionValue, reserveValue] = await Promise.all([
      chain.readContract({ address: lendingAdapter.address, abi: LENDING_ADAPTER_ABI, functionName: 'accountData' }),
      chain.readContract({ address: hedgeAdapter.address, abi: PERP_ADAPTER_ABI, functionName: 'position' }),
      chain.readContract({ address: getAddress(lane.pricing.perpetualMarket.address), abi: PERP_MARKET_ABI,
        functionName: 'reserveOf', args: [hedgeAdapter.address] }),
    ]);
    const preLending = accountData(lendingValue);
    const prePosition = position(positionValue);
    const reserveBefore = natural(reserveValue, 'perpetual reserve');
    const quantity = documents.order.economicQuantity.atoms;
    const increasing = documents.order.lifecycleAction === 'ENTRY' || documents.order.lifecycleAction === 'INCREASE';
    const decreasing = documents.order.lifecycleAction === 'DECREASE';
    const terminal = documents.order.lifecycleAction === 'EXIT'
      || documents.order.lifecycleAction === 'EMERGENCY_UNWIND';
    requireCondition(increasing || decreasing || terminal, 'lifecycle action is unsupported');
    const baseScale = 10n ** BigInt(lane.pricing.baseAsset.decimals);
    const currentQuantity = prePosition.size > 0n ? prePosition.size : 0n;
    const currentProjectedDebt = currentQuantity * lane.debtBaseAtomsPerWholeBaseToken / baseScale;
    const currentDebtTolerance = currentProjectedDebt * lane.debtBaseToleranceBps / BPS;
    const minimumCurrentDebt = currentProjectedDebt > currentDebtTolerance
      ? currentProjectedDebt - currentDebtTolerance : 0n;
    const maximumCurrentDebt = currentProjectedDebt + currentDebtTolerance;
    const projectedDebtDelta = quantity * lane.debtBaseAtomsPerWholeBaseToken / baseScale;
    const debtDeltaTolerance = projectedDebtDelta * lane.debtBaseToleranceBps / BPS;
    requireCondition(preLending.totalCollateralBase > 0n && preLending.healthFactor >= lane.pricing.minimumPostHealthFactor
      && (documents.order.lifecycleAction === 'ENTRY'
        ? preLending.totalDebtBase === 0n && preLending.availableBorrowsBase >= projectedDebtDelta + debtDeltaTolerance
          && prePosition.size === 0n && reserveBefore === 0n
        : preLending.totalDebtBase >= minimumCurrentDebt && preLending.totalDebtBase <= maximumCurrentDebt
          && currentQuantity > 0n && reserveBefore === 0n),
    documents.order.lifecycleAction === 'ENTRY'
      ? 'entry lending or hedge state is not ready' : 'open reverse basis state is inconsistent');
    requireCondition(!increasing || preLending.availableBorrowsBase >= projectedDebtDelta + debtDeltaTolerance,
      'available borrow capacity is below the requested increase');
    requireCondition(!decreasing || quantity < currentQuantity,
      'decrease quantity must retain an open reverse basis package');
    requireCondition(!terminal || quantity === currentQuantity,
      'terminal quantity differs from the open reverse basis package');
    const sizeDelta = increasing ? quantity : -quantity;
    const [spotSnapshot, derivative] = await Promise.all([
      readEvmCollateralConversionSpotSnapshot(spotPricing(lane.pricing), quantity, !increasing),
      readEvmTreasuryHedgeMarketSnapshot(hedgePricing(lane.pricing), sizeDelta),
    ]);
    const quotedLending = documents.quote.legEconomics.find((leg) => leg.legId === 'base-borrow');
    const quotedSpot = documents.quote.legEconomics.find((leg) => leg.legId === 'spot-sale');
    const quotedHedge = documents.quote.legEconomics.find((leg) => leg.legId === 'perp-purchase');
    requireCondition(quotedLending !== undefined && quotedSpot?.executionPrice !== undefined
      && quotedHedge?.executionPrice !== undefined, 'quote lacks reverse basis economics');
    requireCondition(quotedSpot.executionPrice.quoteAtoms * spotSnapshot.priceBaseAtoms
      === spotSnapshot.priceQuoteAtoms * quotedSpot.executionPrice.baseAtoms,
    'current spot quote differs from the signed quote');
    const quoteScale = 10n ** BigInt(lane.pricing.quoteAsset.decimals);
    requireCondition(quotedHedge.executionPrice.quoteAtoms * baseScale * WAD
      === derivative.fillPriceWad * quoteScale * quotedHedge.executionPrice.baseAtoms,
    'current hedge price differs from the signed quote');
    const marginAtoms = increasing ? quotedHedge.marginDelta.atoms : 0n;
    const marginWad = marginAtoms * derivative.collateralScale;
    let postPosition: Position;
    let collateralOutAtoms = 0n;
    if (documents.order.lifecycleAction === 'ENTRY') {
      postPosition = Object.freeze({
        balance: marginWad - derivative.feeWad,
        size: quantity,
        entryNotional: derivative.notionalWad,
        entrySocialLossIndex: 0n,
        entryFundingIndex: derivative.currentFundingIndex,
      });
    } else if (documents.order.lifecycleAction === 'INCREASE') {
      const value = await chain.readContract({
        address: getAddress(lane.pricing.perpetualMarket.address), abi: PERP_MARKET_ABI,
        functionName: 'previewIncrease', args: [hedgeAdapter.address, sizeDelta, marginWad],
      });
      requireCondition(natural(structField(value, 1, 'fill price'), 'increase fill price') === derivative.fillPriceWad
        && natural(structField(value, 2, 'fee'), 'increase fee') === derivative.feeWad,
      'increase preview differs from the signed quote');
      postPosition = position(structField(value, 0, 'post position'));
    } else if (decreasing) {
      const value = await chain.readContract({
        address: getAddress(lane.pricing.perpetualMarket.address), abi: PERP_MARKET_ABI,
        functionName: 'previewDecrease', args: [hedgeAdapter.address, sizeDelta],
      });
      const settlement = structField(value, 1, 'settlement');
      requireCondition(natural(structField(settlement, 0, 'exit notional'), 'decrease exit notional')
        === derivative.notionalWad, 'decrease preview differs from the signed quote');
      postPosition = position(structField(value, 0, 'post position'));
      collateralOutAtoms = natural(structField(settlement, 4, 'payout'), 'decrease payout')
        / derivative.collateralScale;
    } else {
      const closeValue = await chain.readContract({
        address: getAddress(lane.pricing.perpetualMarket.address), abi: PERP_MARKET_ABI,
        functionName: 'previewClose', args: [hedgeAdapter.address],
      });
      collateralOutAtoms = natural(structField(closeValue, 4, 'payout'), 'close payout') / derivative.collateralScale;
      postPosition = Object.freeze({
        balance: 0n, size: 0n, entryNotional: 0n, entrySocialLossIndex: 0n, entryFundingIndex: 0n,
      });
    }
    const expectedPostDebt = increasing
      ? preLending.totalDebtBase + projectedDebtDelta
      : preLending.totalDebtBase > projectedDebtDelta ? preLending.totalDebtBase - projectedDebtDelta : 0n;
    const minimumPostDebt = terminal ? 0n
      : expectedPostDebt > debtDeltaTolerance ? expectedPostDebt - debtDeltaTolerance : 0n;
    const maximumPostDebt = terminal ? 0n : expectedPostDebt + debtDeltaTolerance;
    const lendingBounds: EvmAaveV3LendingLegBounds = Object.freeze({
      legId: 'base-borrow',
      expectedPreAccountDataHash: accountDataHash(preLending),
      minimumOutputAtoms: quantity,
      maximumOutputAtoms: quantity,
      minimumPostCollateralBase: preLending.totalCollateralBase,
      maximumPostCollateralBase: preLending.totalCollateralBase,
      minimumPostDebtBase: minimumPostDebt,
      maximumPostDebtBase: maximumPostDebt,
      minimumPostHealthFactor: lane.pricing.minimumPostHealthFactor,
    });
    const perpBounds: EvmExactPerpLegBounds = Object.freeze({
      legId: 'perp-purchase', expectedPrePositionHash: positionHash(prePosition),
      tradeArgs: tradeArgs(derivative.expiry, documents.order.expiryValue,
        sizeDelta, increasing ? marginWad : 0n),
      expectedPostSizeWad: postPosition.size, minimumPostBalanceWad: postPosition.balance,
      maximumPostBalanceWad: postPosition.balance, minimumPostEntryNotionalWad: postPosition.entryNotional,
      maximumPostEntryNotionalWad: postPosition.entryNotional, expectedReserveBeforeAtoms: reserveBefore,
      minimumReserveAfterAtoms: 0n, maximumReserveAfterAtoms: 0n, collateralInAtoms: marginAtoms,
      collateralOutAtoms: decreasing ? collateralOutAtoms : 0n, withdrawAll: terminal,
      minimumCollateralOutAtoms: collateralOutAtoms,
      maximumCollateralOutAtoms: collateralOutAtoms,
    });
    const graphLeg = (legId: AdapterRole) => {
      const found = documents.graph.legs.find((item) => item.legId === legId);
      requireCondition(found !== undefined, `${legId} graph leg is missing`);
      return found;
    };
    const materializers = Object.freeze([
      createEvmAaveV3LendingMaterializer({
        binding: { domain: lane.pricing.domain, ...lane.pricing.lending,
          legFamily: graphLeg('base-borrow').legFamily, materializationClassId: LENDING_CLASS,
          adapterAddress: lendingAdapter.address, expectedAdapterCodeHash: lendingAdapter.codeHash,
          maximumGasLimit: lendingAdapter.factory.maximumGasLimit },
        collateralAsset: lane.pricing.quoteAsset, debtAsset: lane.pricing.baseAsset, bounds: [lendingBounds],
      }),
      createEvmExactSpotMaterializer({
        binding: { domain: lane.pricing.domain, ...lane.pricing.spot, legFamily: graphLeg('spot-sale').legFamily,
          materializationClassId: SPOT_CLASS, adapterAddress: spotAdapter.address,
          expectedAdapterCodeHash: spotAdapter.codeHash, maximumGasLimit: spotAdapter.factory.maximumGasLimit },
        baseAsset: lane.pricing.baseAsset, quoteAsset: lane.pricing.quoteAsset,
      }),
      createEvmExactPerpMaterializer({
        binding: { domain: lane.pricing.domain, ...lane.pricing.hedge, legFamily: graphLeg('perp-purchase').legFamily,
          materializationClassId: PERP_CLASS, adapterAddress: hedgeAdapter.address,
          expectedAdapterCodeHash: hedgeAdapter.codeHash, maximumGasLimit: hedgeAdapter.factory.maximumGasLimit },
        bounds: [perpBounds],
      }),
    ]);
    const adapters = [lendingAdapter, spotAdapter, hedgeAdapter] as const;
    const nextStateHash = !terminal
      ? strategyStateHash({ packageId: checkedPackageId, account, adapters, lendingBounds, hedgePosition: postPosition })
      : undefined;
    if (nextStateHash !== undefined) await lane.packageIds.rememberPackageId?.(nextStateHash, checkedPackageId);
    const deadline = [documents.order.expiryValue, documents.quote.validUntilValue, documents.route.routeExpiryValue]
      .reduce((minimum, candidate) => candidate < minimum ? candidate : minimum);
    requireCondition(currentTime < deadline, 'order, quote, or route expired');
    const policy = (adapter: AdapterState, approvalToken: Address | undefined, approvalAtoms: bigint,
      grossNotionalAtoms: bigint): EvmStrategyCallPolicy => {
      const binding = legBinding(lane.pricing, adapter.role);
      return Object.freeze({
        legId: adapter.role,
        adapter: Object.freeze({ subjectId: keccak256(stringToHex(binding.adapter.adapterId)),
          manifestVersion: binding.adapter.adapterManifestVersion, manifestHash: toHex(binding.adapter.adapterManifestHash) }),
        expectedAdapterAddress: adapter.address, expectedAdapterCodeHash: adapter.codeHash,
        riskIncreasing: increasing, ...(approvalToken === undefined ? {} : { approvalToken }),
        approvalAtoms, grossNotionalAtoms,
      });
    };
    const spotLeg = graphLeg('spot-sale');
    const spotApproval = increasing ? quantity : (spotLeg.limitPrice!.quoteAtoms * quantity
      + spotLeg.limitPrice!.baseAtoms - 1n) / spotLeg.limitPrice!.baseAtoms;
    return Object.freeze({
      compileContext: Object.freeze({ templateManifest: lane.templateManifest,
        activeRegistryRecords: lane.activeRegistryRecords, resourceLimits: lane.resourceLimits,
        currentTime: Object.freeze({ unit: 'EVM_UNIX_SECONDS' as const, value: currentTime }) }),
      identity: Object.freeze({ packageId: asHash32(checkedPackageId), templateId: documents.order.templateId,
        templateVersion: documents.order.templateVersion, templateManifestHash: documents.order.packageTemplateManifestHash,
        operation: documents.order.lifecycleAction,
        ...(documents.order.expectedStrategyStateHash === undefined ? {} : { previousStateHash: documents.order.expectedStrategyStateHash }),
        ...(nextStateHash === undefined ? {} : { nextStateHash: asHash32(nextStateHash) }) }),
      compilers: Object.freeze([createEvmStrategyDomainCompiler({ domain: lane.pricing.domain,
        executionPlanKind: 'EVM_ATOMIC_BATCH', strategyAccount: account, materializers })]),
      bindings: Object.freeze([{
        kind: 'EVM_MULTI_STRATEGY_ACCOUNT' as const, domain: lane.pricing.domain, account,
        chainId: Number(lane.pricing.chainId), solver: getAddress(lane.solver),
        totalGrossNotionalAtoms: quotedLending.grossNotional.atoms + quotedSpot.grossNotional.atoms
          + quotedHedge.grossNotional.atoms,
        feePolicyVersion: documents.quote.feePolicyVersion,
        feePolicyManifestHash: toHex(documents.quote.feePolicyManifestHash),
        feeToken: getAddress(lane.pricing.quoteToken.address), protocolFeeAtoms: charge(documents, 'PROTOCOL'),
        solverFeeAtoms: charge(documents, 'SOLVER'), nonce: natural(nonceValue, 'account nonce'), deadline,
        callPolicies: Object.freeze([
          policy(lendingAdapter, increasing ? undefined : getAddress(lane.pricing.baseToken.address),
            increasing ? 0n : quantity, quotedLending.grossNotional.atoms),
          policy(spotAdapter, getAddress(increasing ? lane.pricing.baseToken.address : lane.pricing.quoteToken.address),
            spotApproval, quotedSpot.grossNotional.atoms),
          policy(hedgeAdapter, increasing ? getAddress(lane.pricing.quoteToken.address) : undefined,
            marginAtoms, quotedHedge.grossNotional.atoms),
        ]),
      }]),
    });
  }
}
