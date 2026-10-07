import {
  createEvmExactInventoryMaterializer,
  createEvmExactPerpMaterializer,
  structField,
  type EvmExactInventoryLegBounds,
  type EvmExactPerpLegBounds,
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
  readEvmTreasuryHedgeMarketSnapshot,
  type EvmTreasuryHedgePricingInput,
} from './evm-treasury-hedge-quote.js';
import type { EvmOptionSpreadContractIdentity } from './evm-option-spread-quote.js';
import type { EvmOptionSpreadPackageIdPort } from './evm-option-spread-preparation.js';
import { createEvmStrategyDomainCompiler } from './strategy-domain-compilers.js';
import type { StoredStrategyPackageDocuments } from './http-strategy-package-provider.js';
import type { StrategyPreparationContext, StrategyPreparationContextResolver } from './strategy-preparation-service.js';

const INVENTORY_CLASS = 'naryx.evm.inventory-custody-exact';
const PERP_CLASS = 'naryx.evm.perp-exact';
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
  type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'nextNonce', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }],
}, {
  type: 'function', name: 'packageState', stateMutability: 'view', inputs: [{ name: 'packageId', type: 'bytes32' }],
  outputs: [{ name: '', type: 'tuple', components: [
    { name: 'template', type: 'tuple', components: [
      { name: 'templateId', type: 'bytes32' },
      { name: 'templateVersion', type: 'uint32' },
      { name: 'templateManifestHash', type: 'bytes32' },
    ] },
    { name: 'stateHash', type: 'bytes32' },
    { name: 'lastReceiptHash', type: 'bytes32' },
    { name: 'active', type: 'bool' },
  ] }],
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
const ERC20_ABI = [{
  type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;
const PERP_ADAPTER_ABI = [{
  type: 'function', name: 'position', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'tuple', components: [
    { name: 'balance', type: 'int128' },
    { name: 'size', type: 'int128' },
    { name: 'entryNotional', type: 'uint128' },
    { name: 'entrySocialLossIndex', type: 'uint128' },
    { name: 'entryFundingIndex', type: 'int128' },
  ] }],
}] as const satisfies Abi;
const PERP_MARKET_ABI = [{
  type: 'function', name: 'reserveOf', stateMutability: 'view',
  inputs: [{ name: 'trader', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
}, {
  type: 'function', name: 'previewClose', stateMutability: 'view',
  inputs: [{ name: 'trader', type: 'address' }],
  outputs: [{ name: '', type: 'tuple', components: [
    { name: 'exitNotional', type: 'uint256' },
    { name: 'realizedPnl', type: 'int256' },
    { name: 'funding', type: 'int256' },
    { name: 'charged', type: 'uint256' },
    { name: 'payout', type: 'uint256' },
    { name: 'badDebt', type: 'uint256' },
  ] }],
}] as const satisfies Abi;

type AdapterRole = 'inventory-position' | 'treasury-hedge';

export interface EvmTreasuryHedgeAdapterFactoryBinding {
  readonly role: AdapterRole;
  readonly factory: EvmOptionSpreadContractIdentity;
  readonly expectedAdapterCodeHash: Hex;
  readonly maximumGasLimit: bigint;
}

export interface EvmTreasuryHedgePreparationLane {
  readonly environment: 'testnet';
  readonly templateManifest: PackageTemplateManifest;
  readonly activeRegistryRecords: readonly DomainRegistryRecordInput[];
  readonly resourceLimits: readonly DomainResourceLimit[];
  readonly pricing: EvmTreasuryHedgePricingInput;
  readonly accountFactory: EvmOptionSpreadContractIdentity;
  readonly expectedStrategyAccountCodeHash: Hex;
  readonly adapters: readonly [EvmTreasuryHedgeAdapterFactoryBinding, EvmTreasuryHedgeAdapterFactoryBinding];
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

interface AdapterState {
  readonly role: AdapterRole;
  readonly address: Address;
  readonly codeHash: Hex;
  readonly factory: EvmTreasuryHedgeAdapterFactoryBinding;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM treasury hedge preparation refused: ${message}`);
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

function bigintValue(input: unknown, context: string): bigint {
  requireCondition(typeof input === 'bigint', `${context} is invalid`);
  return input;
}

function natural(input: unknown, context: string): bigint {
  const checked = bigintValue(input, context);
  requireCondition(checked >= 0n, `${context} is negative`);
  return checked;
}

function role<T extends { readonly role: AdapterRole }>(values: readonly T[], expected: AdapterRole): T {
  const matches = values.filter((candidate) => candidate.role === expected);
  requireCondition(matches.length === 1, `${expected} binding must appear exactly once`);
  return matches[0]!;
}

function position(raw: unknown): Position {
  return Object.freeze({
    balance: bigintValue(structField(raw, 0, 'balance'), 'position balance'),
    size: bigintValue(structField(raw, 1, 'size'), 'position size'),
    entryNotional: natural(structField(raw, 2, 'entryNotional'), 'entry notional'),
    entrySocialLossIndex: natural(structField(raw, 3, 'entrySocialLossIndex'), 'social loss index'),
    entryFundingIndex: bigintValue(structField(raw, 4, 'entryFundingIndex'), 'funding index'),
  });
}

function positionHash(input: Position): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'tuple', components: [
      { name: 'balance', type: 'int128' },
      { name: 'size', type: 'int128' },
      { name: 'entryNotional', type: 'uint128' },
      { name: 'entrySocialLossIndex', type: 'uint128' },
      { name: 'entryFundingIndex', type: 'int128' },
    ] }],
    [input],
  ));
}

function strategyStateHash(input: Readonly<{
  packageId: Hex;
  account: Address;
  inventoryAdapter: Address;
  inventoryAtoms: bigint;
  hedgeAdapter: Address;
  hedgePosition: Position;
}>): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint256' },
      { type: 'address' },
      { type: 'bytes32' },
    ],
    [input.packageId, input.account, input.inventoryAdapter, input.inventoryAtoms, input.hedgeAdapter, positionHash(input.hedgePosition)],
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
  return documents.quote.serviceCharges.find((candidate) => candidate.category === category)?.amount.atoms ?? 0n;
}

async function readAdapter(
  lane: EvmTreasuryHedgePreparationLane,
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
  requireCondition(factoryCode !== undefined
    && hash(factoryCode, `${roleId} factory code`) === hash(binding.factory.expectedCodeHash, `${roleId} expected factory code`),
  `${roleId} adapter factory code changed`);
  const address = getAddress(String(addressValue));
  const [code, valid] = await Promise.all([
    lane.pricing.chain.codeHash(address),
    lane.pricing.chain.readContract({
      address: factory,
      abi: ADAPTER_FACTORY_ABI,
      functionName: 'validateInstance',
      args: [address, account, packageId],
    }),
  ]);
  requireCondition(code !== undefined && hash(code, `${roleId} adapter code`) === hash(binding.expectedAdapterCodeHash, `${roleId} expected adapter code`)
    && valid === true, `${roleId} adapter is not a reviewed package instance`);
  return Object.freeze({ role: roleId, address, codeHash: hash(code, `${roleId} adapter code`), factory: binding });
}

export class EvmTreasuryHedgePreparationContextResolver implements StrategyPreparationContextResolver {
  readonly #lanes: readonly EvmTreasuryHedgePreparationLane[];

  constructor(lanes: readonly EvmTreasuryHedgePreparationLane[]) {
    requireCondition(lanes.length > 0, 'at least one lane is required');
    this.#lanes = Object.freeze([...lanes]);
  }

  async resolve(documents: StoredStrategyPackageDocuments): Promise<StrategyPreparationContext> {
    const matches = this.#lanes.filter((lane) => lane.environment === documents.order.environment
      && lane.templateManifest.templateId === documents.order.templateId
      && lane.templateManifest.templateVersion === documents.order.templateVersion
      && bytesEqual(packageTemplateManifestHash(lane.templateManifest), documents.order.packageTemplateManifestHash)
      && documents.route.domainPlans.length === 1
      && documents.route.domainPlans[0]!.executionPlanKind === 'EVM_ATOMIC_BATCH'
      && documents.route.domainPlans[0]!.domain.domainId === lane.pricing.domain.domainId
      && bytesEqual(documents.route.domainPlans[0]!.domain.domainManifestHash, lane.pricing.domain.domainManifestHash));
    requireCondition(matches.length === 1, 'package must resolve to exactly one preparation lane');
    const lane = matches[0]!;
    requireCondition(documents.order.settlementClass === 'ATOMIC_POSTCONDITION'
      && documents.order.expiryUnit === 'EVM_UNIX_SECONDS', 'package is not an atomic EVM execution');
    const chain = lane.pricing.chain;
    const [currentTime, chainId] = await Promise.all([chain.latestBlockTimestamp(), chain.chainId()]);
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
      && hash(factoryCode, 'account factory code') === hash(lane.accountFactory.expectedCodeHash, 'expected account factory code'),
    'account factory code changed');
    requireCondition(hash(factoryAccountCodeHash, 'factory account code')
      === hash(lane.expectedStrategyAccountCodeHash, 'expected account code'), 'factory account code identity changed');
    const account = getAddress(String(accountValue));
    requireCondition(account === getAddress(documents.order.settlementAccount), 'settlement account is not the owner factory account');
    const [recognized, accountOwner, accountCode, nonceValue, packageValue, inventoryAdapter, hedgeAdapter] = await Promise.all([
      chain.readContract({ address: accountFactory, abi: ACCOUNT_FACTORY_ABI, functionName: 'isAccount', args: [account] }),
      chain.readContract({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'owner' }),
      chain.codeHash(account),
      chain.readContract({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'nextNonce' }),
      chain.readContract({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'packageState', args: [checkedPackageId] }),
      readAdapter(lane, 'inventory-position', account, checkedPackageId),
      readAdapter(lane, 'treasury-hedge', account, checkedPackageId),
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
    const [inventoryValue, positionValue, reserveValue] = await Promise.all([
      chain.readContract({ address: getAddress(lane.pricing.inventoryToken.address), abi: ERC20_ABI, functionName: 'balanceOf', args: [inventoryAdapter.address] }),
      chain.readContract({ address: hedgeAdapter.address, abi: PERP_ADAPTER_ABI, functionName: 'position' }),
      chain.readContract({ address: getAddress(lane.pricing.market.address), abi: PERP_MARKET_ABI, functionName: 'reserveOf', args: [hedgeAdapter.address] }),
    ]);
    const inventoryAtoms = natural(inventoryValue, 'inventory balance');
    const prePosition = position(positionValue);
    const reserveBefore = natural(reserveValue, 'perpetual reserve');
    const quantity = documents.order.economicQuantity.atoms;
    const opening = documents.order.lifecycleAction === 'ENTRY';
    requireCondition(opening || documents.order.lifecycleAction === 'EXIT'
      || documents.order.lifecycleAction === 'EMERGENCY_UNWIND', 'lifecycle action is unsupported');
    requireCondition(opening
      ? inventoryAtoms === 0n && prePosition.size === 0n && reserveBefore === 0n
      : inventoryAtoms === quantity && prePosition.size === -quantity,
    opening ? 'entry adapters are not flat' : 'exit quantity differs from the open hedge');
    const snapshot = await readEvmTreasuryHedgeMarketSnapshot(lane.pricing, opening ? -quantity : quantity);
    const quotedHedge = documents.quote.legEconomics.find((leg) => leg.legId === 'treasury-hedge');
    requireCondition(quotedHedge?.executionPrice !== undefined
      && quotedHedge.executionPrice.quoteAtoms * 1_000_000_000_000_000_000n
        === snapshot.fillPriceWad * quotedHedge.executionPrice.baseAtoms,
    'current hedge price differs from the signed quote');
    const collateralInAtoms = opening ? quotedHedge.marginDelta.atoms : 0n;
    const collateralBalanceWad = collateralInAtoms * snapshot.collateralScale;
    const postPosition: Position = opening
      ? Object.freeze({
          balance: collateralBalanceWad - snapshot.feeWad,
          size: -quantity,
          entryNotional: snapshot.notionalWad,
          entrySocialLossIndex: 0n,
          entryFundingIndex: snapshot.currentFundingIndex,
        })
      : Object.freeze({ balance: 0n, size: 0n, entryNotional: 0n, entrySocialLossIndex: 0n, entryFundingIndex: 0n });
    let collateralOutAtoms = 0n;
    if (!opening) {
      const closeValue = await chain.readContract({
        address: getAddress(lane.pricing.market.address),
        abi: PERP_MARKET_ABI,
        functionName: 'previewClose',
        args: [hedgeAdapter.address],
      });
      collateralOutAtoms = natural(structField(closeValue, 4, 'payout'), 'close payout') / snapshot.collateralScale;
    }
    const inventoryBounds: EvmExactInventoryLegBounds = Object.freeze({
      legId: 'inventory-position',
      action: opening ? 'LOCK' : 'RELEASE',
      expectedPreInventoryAtoms: inventoryAtoms,
      expectedPostInventoryAtoms: opening ? inventoryAtoms + quantity : inventoryAtoms - quantity,
    });
    const perpBounds: EvmExactPerpLegBounds = Object.freeze({
      legId: 'treasury-hedge',
      expectedPrePositionHash: positionHash(prePosition),
      tradeArgs: tradeArgs(snapshot.expiry, documents.order.expiryValue, opening ? -quantity : quantity, opening ? collateralBalanceWad : 0n),
      expectedPostSizeWad: postPosition.size,
      minimumPostBalanceWad: postPosition.balance,
      maximumPostBalanceWad: postPosition.balance,
      minimumPostEntryNotionalWad: postPosition.entryNotional,
      maximumPostEntryNotionalWad: postPosition.entryNotional,
      expectedReserveBeforeAtoms: reserveBefore,
      minimumReserveAfterAtoms: 0n,
      maximumReserveAfterAtoms: 0n,
      collateralInAtoms,
      collateralOutAtoms: 0n,
      withdrawAll: !opening,
      minimumCollateralOutAtoms: collateralOutAtoms,
      maximumCollateralOutAtoms: collateralOutAtoms,
    });
    const inventoryLeg = documents.graph.legs.find((leg) => leg.legId === 'inventory-position');
    const hedgeLeg = documents.graph.legs.find((leg) => leg.legId === 'treasury-hedge');
    requireCondition(inventoryLeg !== undefined && hedgeLeg !== undefined, 'strategy legs are missing');
    const materializers = Object.freeze([
      createEvmExactInventoryMaterializer({
        binding: {
          domain: lane.pricing.domain,
          adapter: lane.pricing.inventory.adapter,
          venue: lane.pricing.inventory.venue,
          market: lane.pricing.inventory.market,
          legFamily: inventoryLeg.legFamily,
          materializationClassId: INVENTORY_CLASS,
          adapterAddress: inventoryAdapter.address,
          expectedAdapterCodeHash: inventoryAdapter.codeHash,
          maximumGasLimit: inventoryAdapter.factory.maximumGasLimit,
        },
        inventoryAsset: lane.pricing.inventoryAsset,
        bounds: [inventoryBounds],
      }),
      createEvmExactPerpMaterializer({
        binding: {
          domain: lane.pricing.domain,
          adapter: lane.pricing.hedge.adapter,
          venue: lane.pricing.hedge.venue,
          market: lane.pricing.hedge.market,
          legFamily: hedgeLeg.legFamily,
          materializationClassId: PERP_CLASS,
          adapterAddress: hedgeAdapter.address,
          expectedAdapterCodeHash: hedgeAdapter.codeHash,
          maximumGasLimit: hedgeAdapter.factory.maximumGasLimit,
        },
        bounds: [perpBounds],
      }),
    ]);
    const policy = (
      adapter: AdapterState,
      approvalToken: Address | undefined,
      approvalAtoms: bigint,
      grossNotionalAtoms: bigint,
    ): EvmStrategyCallPolicy => Object.freeze({
      legId: adapter.role,
      adapter: Object.freeze({
        subjectId: keccak256(stringToHex(adapter.role === 'inventory-position'
          ? lane.pricing.inventory.adapter.adapterId
          : lane.pricing.hedge.adapter.adapterId)),
        manifestVersion: adapter.role === 'inventory-position'
          ? lane.pricing.inventory.adapter.adapterManifestVersion
          : lane.pricing.hedge.adapter.adapterManifestVersion,
        manifestHash: toHex(adapter.role === 'inventory-position'
          ? lane.pricing.inventory.adapter.adapterManifestHash
          : lane.pricing.hedge.adapter.adapterManifestHash),
      }),
      expectedAdapterAddress: adapter.address,
      expectedAdapterCodeHash: adapter.codeHash,
      riskIncreasing: opening,
      ...(approvalToken === undefined ? {} : { approvalToken }),
      approvalAtoms,
      grossNotionalAtoms,
    });
    const inventoryEconomics = documents.quote.legEconomics.find((leg) => leg.legId === 'inventory-position');
    requireCondition(inventoryEconomics !== undefined, 'quote lacks inventory economics');
    const nextStateHash = opening ? strategyStateHash({
      packageId: checkedPackageId,
      account,
      inventoryAdapter: inventoryAdapter.address,
      inventoryAtoms: quantity,
      hedgeAdapter: hedgeAdapter.address,
      hedgePosition: postPosition,
    }) : undefined;
    if (nextStateHash !== undefined) await lane.packageIds.rememberPackageId?.(nextStateHash, checkedPackageId);
    const deadline = [documents.order.expiryValue, documents.quote.validUntilValue, documents.route.routeExpiryValue]
      .reduce((minimum, candidate) => candidate < minimum ? candidate : minimum);
    requireCondition(currentTime < deadline, 'order, quote, or route expired');
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
        materializers,
      })]),
      bindings: Object.freeze([{
        kind: 'EVM_MULTI_STRATEGY_ACCOUNT' as const,
        domain: lane.pricing.domain,
        account,
        chainId: Number(lane.pricing.chainId),
        solver: getAddress(lane.solver),
        totalGrossNotionalAtoms: inventoryEconomics.grossNotional.atoms + quotedHedge.grossNotional.atoms,
        feePolicyVersion: documents.quote.feePolicyVersion,
        feePolicyManifestHash: toHex(documents.quote.feePolicyManifestHash),
        feeToken: getAddress(lane.pricing.quoteToken.address),
        protocolFeeAtoms: charge(documents, 'PROTOCOL'),
        solverFeeAtoms: charge(documents, 'SOLVER'),
        nonce: natural(nonceValue, 'account nonce'),
        deadline,
        callPolicies: Object.freeze([
          policy(
            inventoryAdapter,
            opening ? getAddress(lane.pricing.inventoryToken.address) : undefined,
            opening ? quantity : 0n,
            inventoryEconomics.grossNotional.atoms,
          ),
          policy(
            hedgeAdapter,
            opening ? getAddress(lane.pricing.quoteToken.address) : undefined,
            collateralInAtoms,
            quotedHedge.grossNotional.atoms,
          ),
        ]),
      }]),
    });
  }
}
