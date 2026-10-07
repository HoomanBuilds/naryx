import {
  compileEvmPackageCollateralManagement,
  type EvmPackageCollateralAction,
  type EvmPackageCollateralManagementPlan,
} from '@naryx/adapter-evm';
import {
  bytesEqual,
  packageTemplateManifestHash,
  strategyPackageOrderHash,
  type Hash32,
} from '@naryx/protocol-types';
import { bytesToHex, encodeAbiParameters, getAddress, keccak256, stringToHex, zeroHash, type Abi, type Hex } from 'viem';
import type { StrategyPackageProvider, StoredStrategyPackageDocuments } from './http-strategy-package-provider.js';
import type { EvmReverseBasisPreparationLane } from './evm-reverse-basis-preparation.js';

const BPS = 10_000n;
const ACCOUNT_FACTORY_ABI = [{
  type: 'function', name: 'accountOf', stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'isAccount', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bool' }],
}, {
  type: 'function', name: 'accountCodeHash', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }],
}] as const satisfies Abi;
const ACCOUNT_ABI = [{
  type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'nextCollateralNonce', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }],
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
  inputs: [{ name: 'instance', type: 'address' }, { name: 'strategyAccount', type: 'address' },
    { name: 'packageId', type: 'bytes32' }], outputs: [{ name: '', type: 'bool' }],
}] as const satisfies Abi;
const LENDING_ADAPTER_ABI = [{
  type: 'function', name: 'accountData', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'tuple', components: [
    { name: 'totalCollateralBase', type: 'uint256' }, { name: 'totalDebtBase', type: 'uint256' },
    { name: 'availableBorrowsBase', type: 'uint256' }, { name: 'currentLiquidationThreshold', type: 'uint256' },
    { name: 'ltv', type: 'uint256' }, { name: 'healthFactor', type: 'uint256' },
  ] }],
}, {
  type: 'function', name: 'managedCollateralPrincipalAtoms', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;
const TOKEN_ABI = [{
  type: 'function', name: 'allowance', stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;

interface AccountData {
  readonly totalCollateralBase: bigint;
  readonly totalDebtBase: bigint;
  readonly healthFactor: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM reverse basis collateral refused: ${message}`);
}

function hash(value: unknown, context: string): Hex {
  requireCondition(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), `${context} must be bytes32`);
  const normalized = value.toLowerCase() as Hex;
  requireCondition(normalized !== zeroHash, `${context} must be nonzero`);
  return normalized;
}

function tupleField(value: unknown, index: number, context: string): unknown {
  requireCondition(Array.isArray(value) || (typeof value === 'object' && value !== null), `${context} is invalid`);
  return Array.isArray(value) ? value[index] : Object.values(value)[index];
}

function natural(value: unknown, context: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= 0n, `${context} is invalid`);
  return value;
}

function accountData(value: unknown): AccountData {
  return Object.freeze({
    totalCollateralBase: natural(tupleField(value, 0, 'total collateral'), 'total collateral'),
    totalDebtBase: natural(tupleField(value, 1, 'total debt'), 'total debt'),
    healthFactor: natural(tupleField(value, 5, 'health factor'), 'health factor'),
  });
}

function accountDataHash(value: unknown): Hex {
  const data = accountData(value);
  return keccak256(encodeAbiParameters([{ type: 'tuple', components: [
    { name: 'totalCollateralBase', type: 'uint256' }, { name: 'totalDebtBase', type: 'uint256' },
    { name: 'availableBorrowsBase', type: 'uint256' }, { name: 'currentLiquidationThreshold', type: 'uint256' },
    { name: 'ltv', type: 'uint256' }, { name: 'healthFactor', type: 'uint256' },
  ] }], [{
    totalCollateralBase: data.totalCollateralBase,
    totalDebtBase: data.totalDebtBase,
    availableBorrowsBase: natural(tupleField(value, 2, 'available borrows'), 'available borrows'),
    currentLiquidationThreshold: natural(tupleField(value, 3, 'liquidation threshold'), 'liquidation threshold'),
    ltv: natural(tupleField(value, 4, 'ltv'), 'ltv'),
    healthFactor: data.healthFactor,
  }]));
}

function matchingLane(documents: StoredStrategyPackageDocuments, lane: EvmReverseBasisPreparationLane): boolean {
  return documents.order.environment === lane.environment
    && documents.order.templateId === lane.templateManifest.templateId
    && documents.order.templateVersion === lane.templateManifest.templateVersion
    && bytesEqual(documents.order.packageTemplateManifestHash, packageTemplateManifestHash(lane.templateManifest))
    && (documents.order.lifecycleAction === 'ENTRY' || documents.order.lifecycleAction === 'EXIT'
      || documents.order.lifecycleAction === 'EMERGENCY_UNWIND')
    && documents.graph.legs.every((leg) => leg.domain.domainId === lane.pricing.domain.domainId);
}

export class EvmReverseBasisCollateralService {
  readonly #packages: StrategyPackageProvider;
  readonly #lanes: readonly EvmReverseBasisPreparationLane[];

  constructor(packages: StrategyPackageProvider, lanes: readonly EvmReverseBasisPreparationLane[]) {
    requireCondition(lanes.length > 0, 'at least one lane is required');
    this.#packages = packages;
    this.#lanes = Object.freeze([...lanes]);
  }

  async planByQuote(quoteHash: Hash32, action: EvmPackageCollateralAction): Promise<EvmPackageCollateralManagementPlan | undefined> {
    const documents = await this.#packages.getByQuote(quoteHash);
    if (documents === undefined) return undefined;
    requireCondition(action === 'SUPPLY' || action === 'WITHDRAW', 'collateral action is invalid');
    requireCondition(action === 'SUPPLY' ? documents.order.lifecycleAction === 'ENTRY'
      : documents.order.lifecycleAction === 'EXIT' || documents.order.lifecycleAction === 'EMERGENCY_UNWIND',
    'collateral action does not match the quote lifecycle');
    const matches = this.#lanes.filter((lane) => matchingLane(documents, lane));
    requireCondition(matches.length === 1, 'entry quote must resolve to exactly one lane');
    const lane = matches[0]!;
    const chain = lane.pricing.chain;
    requireCondition(await chain.chainId() === lane.pricing.chainId, 'RPC chain identity differs from the lane');
    const owner = getAddress(documents.order.owner);
    const accountFactory = getAddress(lane.accountFactory.address);
    const packageId = documents.order.lifecycleAction === 'ENTRY'
      ? bytesToHex(strategyPackageOrderHash(documents.order))
      : await lane.packageIds.resolvePackageId(bytesToHex(documents.order.expectedStrategyStateHash!));
    requireCondition(packageId !== undefined, 'prior strategy package is unknown');
    const checkedPackageId = hash(packageId, 'package id');
    const lendingBinding = lane.adapters.find((item) => item.role === 'base-borrow');
    requireCondition(lendingBinding !== undefined, 'lending adapter factory is missing');
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
    requireCondition(account === getAddress(documents.order.settlementAccount), 'settlement account differs from the owner account');
    const adapterFactory = getAddress(lendingBinding.factory.address);
    const [accountCode, recognized, accountOwner, adapterFactoryCode, adapterValue] = await Promise.all([
      chain.codeHash(account),
      chain.readContract({ address: accountFactory, abi: ACCOUNT_FACTORY_ABI, functionName: 'isAccount', args: [account] }),
      chain.readContract({ address: account, abi: ACCOUNT_ABI, functionName: 'owner' }),
      chain.codeHash(adapterFactory),
      chain.readContract({ address: adapterFactory, abi: ADAPTER_FACTORY_ABI, functionName: 'adapterOf', args: [account, checkedPackageId] }),
    ]);
    requireCondition(accountCode !== undefined && hash(accountCode, 'account code')
      === hash(lane.expectedStrategyAccountCodeHash, 'expected account code') && recognized === true
      && getAddress(String(accountOwner)) === owner, 'strategy account identity is invalid');
    requireCondition(adapterFactoryCode !== undefined && hash(adapterFactoryCode, 'adapter factory code')
      === hash(lendingBinding.factory.expectedCodeHash, 'expected adapter factory code'), 'adapter factory code changed');
    const adapter = getAddress(String(adapterValue));
    const [adapterCode, valid, nonceValue, packageStateValue, accountDataValue, principalValue, allowanceValue] = await Promise.all([
      chain.codeHash(adapter),
      chain.readContract({ address: adapterFactory, abi: ADAPTER_FACTORY_ABI, functionName: 'validateInstance',
        args: [adapter, account, checkedPackageId] }),
      chain.readContract({ address: account, abi: ACCOUNT_ABI, functionName: 'nextCollateralNonce' }),
      chain.readContract({ address: account, abi: ACCOUNT_ABI, functionName: 'packageState', args: [checkedPackageId] }),
      chain.readContract({ address: adapter, abi: LENDING_ADAPTER_ABI, functionName: 'accountData' }),
      chain.readContract({ address: adapter, abi: LENDING_ADAPTER_ABI, functionName: 'managedCollateralPrincipalAtoms' }),
      chain.readContract({ address: getAddress(lane.pricing.quoteToken.address), abi: TOKEN_ABI,
        functionName: 'allowance', args: [owner, account] }),
    ]);
    requireCondition(adapterCode !== undefined && hash(adapterCode, 'adapter code')
      === hash(lendingBinding.expectedAdapterCodeHash, 'expected adapter code') && valid === true,
    'lending adapter is not the reviewed package instance');
    requireCondition(tupleField(packageStateValue, 3, 'package state') === false, 'package must be inactive');
    const observed = accountData(accountDataValue);
    requireCondition(observed.totalDebtBase === 0n, 'lending adapter still has debt');
    const principalAtoms = natural(principalValue, 'managed collateral principal');
    const lendingEconomics = documents.quote.legEconomics.find((item) => item.legId === 'base-borrow');
    requireCondition(lendingEconomics !== undefined, 'quote does not bind the lending leg');
    const managedAtoms = action === 'SUPPLY' ? lendingEconomics.marginDelta.atoms : principalAtoms;
    requireCondition(managedAtoms > 0n, 'managed lending collateral is zero');
    const quoteScale = 10n ** BigInt(lane.pricing.quoteAsset.decimals);
    const projectedBase = managedAtoms * lane.collateralBaseAtomsPerWholeQuoteToken / quoteScale;
    const tolerance = projectedBase * lane.collateralBaseToleranceBps / BPS;
    const minimumProjectedBase = projectedBase - (tolerance < projectedBase ? tolerance : projectedBase);
    const maximumProjectedBase = projectedBase + tolerance;
    if (action === 'SUPPLY') {
      requireCondition(lendingEconomics.marginDelta.asset.assetId === lane.pricing.quoteAsset.assetId,
        'entry quote does not bind lending collateral');
      requireCondition(observed.totalCollateralBase === 0n && principalAtoms === 0n,
        'lending collateral is already funded');
    } else {
      requireCondition(observed.totalCollateralBase > 0n, 'lending collateral is already withdrawn');
    }
    const now = await chain.latestBlockTimestamp();
    const deadline = now + lane.pricing.routeTtlSeconds;
    return compileEvmPackageCollateralManagement({
      chainId: Number(lane.pricing.chainId),
      owner,
      strategyAccount: account,
      quoteHash: bytesToHex(quoteHash),
      packageId: checkedPackageId,
      templateId: documents.order.templateId,
      templateVersion: documents.order.templateVersion,
      templateManifestHash: bytesToHex(documents.order.packageTemplateManifestHash),
      adapter: Object.freeze({
        subjectId: keccak256(stringToHex(lane.pricing.lending.adapter.adapterId)),
        manifestVersion: lane.pricing.lending.adapter.adapterManifestVersion,
        manifestHash: bytesToHex(lane.pricing.lending.adapter.adapterManifestHash),
      }),
      adapterAddress: adapter,
      assetToken: getAddress(lane.pricing.quoteToken.address),
      action,
      inputAtoms: action === 'SUPPLY' ? managedAtoms : (2n ** 256n) - 1n,
      currentOwnerAllowanceAtoms: natural(allowanceValue, 'owner allowance'),
      expectedPreAccountDataHash: accountDataHash(accountDataValue),
      minimumOutputAtoms: managedAtoms,
      maximumOutputAtoms: action === 'SUPPLY' ? managedAtoms : (2n ** 256n) - 1n,
      minimumPostCollateralBase: action === 'SUPPLY' ? minimumProjectedBase : 0n,
      maximumPostCollateralBase: action === 'SUPPLY' ? maximumProjectedBase : 0n,
      minimumPostHealthFactor: lane.pricing.minimumPostHealthFactor,
      grossNotionalAtoms: managedAtoms,
      gasLimit: lendingBinding.maximumGasLimit,
      nonce: natural(nonceValue, 'collateral nonce'),
      deadline,
    });
  }
}
