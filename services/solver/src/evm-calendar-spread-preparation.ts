import {
  createEvmExactFutureMaterializer,
  structField,
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
  readEvmCalendarFutureSnapshot,
  type EvmCalendarSpreadLegBinding,
  type EvmCalendarSpreadPricingInput,
  type EvmCalendarSpreadRole,
  type EvmCalendarFutureSnapshot,
} from './evm-calendar-spread-quote.js';
import type { EvmOptionSpreadContractIdentity } from './evm-option-spread-quote.js';
import { createEvmStrategyDomainCompiler } from './strategy-domain-compilers.js';
import type { StoredStrategyPackageDocuments } from './http-strategy-package-provider.js';
import type {
  StrategyPreparationContext,
  StrategyPreparationContextResolver,
} from './strategy-preparation-service.js';

const FUTURE_MATERIALIZATION_CLASS = 'naryx.evm.future-exact';
const WAD = 1_000_000_000_000_000_000n;
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
const FUTURE_ADAPTER_ABI = [{
  type: 'function', name: 'position', stateMutability: 'view', inputs: [], outputs: [{
    name: '', type: 'tuple', components: [
      { name: 'balance', type: 'int128' },
      { name: 'size', type: 'int128' },
      { name: 'entryNotional', type: 'uint128' },
      { name: 'entrySocialLossIndex', type: 'uint128' },
      { name: 'entryFundingIndex', type: 'int128' },
    ],
  }],
}] as const satisfies Abi;
const FUTURE_MARKET_ABI = [{
  type: 'function', name: 'reserveOf', stateMutability: 'view',
  inputs: [{ name: 'trader', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
}, {
  type: 'function', name: 'previewClose', stateMutability: 'view',
  inputs: [{ name: 'trader', type: 'address' }], outputs: [{
    name: '', type: 'tuple', components: [
      { name: 'exitNotional', type: 'uint256' },
      { name: 'realizedPnl', type: 'int256' },
      { name: 'funding', type: 'int256' },
      { name: 'fee', type: 'uint256' },
      { name: 'payout', type: 'uint256' },
    ],
  }],
}] as const satisfies Abi;

export interface EvmCalendarSpreadAdapterFactoryBinding {
  readonly role: EvmCalendarSpreadRole;
  readonly factory: EvmOptionSpreadContractIdentity;
  readonly expectedAdapterCodeHash: Hex;
  readonly maximumGasLimit: bigint;
}

export interface EvmCalendarSpreadPackageIdPort {
  resolvePackageId(expectedStateHash: Hex): Promise<Hex | undefined>;
  rememberPackageId?(stateHash: Hex, packageId: Hex): Promise<void>;
}

export interface EvmCalendarSpreadPreparationLane {
  readonly environment: 'testnet';
  readonly templateManifest: PackageTemplateManifest;
  readonly activeRegistryRecords: readonly DomainRegistryRecordInput[];
  readonly resourceLimits: readonly DomainResourceLimit[];
  readonly pricing: EvmCalendarSpreadPricingInput;
  readonly accountFactory: EvmOptionSpreadContractIdentity;
  readonly expectedStrategyAccountCodeHash: Hex;
  readonly adapters: readonly [EvmCalendarSpreadAdapterFactoryBinding, EvmCalendarSpreadAdapterFactoryBinding];
  readonly solver: Address;
  readonly packageIds: EvmCalendarSpreadPackageIdPort;
}

interface Position {
  readonly balance: bigint;
  readonly size: bigint;
  readonly entryNotional: bigint;
  readonly entrySocialLossIndex: bigint;
  readonly entryFundingIndex: bigint;
}

interface AdapterState {
  readonly role: EvmCalendarSpreadRole;
  readonly address: Address;
  readonly codeHash: Hex;
  readonly factory: EvmCalendarSpreadAdapterFactoryBinding;
  readonly market: EvmCalendarSpreadLegBinding;
  readonly position: Position;
  readonly reserveAtoms: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM calendar spread preparation refused: ${message}`);
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

function role<T extends { readonly role: EvmCalendarSpreadRole }>(values: readonly T[], expected: EvmCalendarSpreadRole): T {
  const matches = values.filter((value) => value.role === expected);
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
  nearAdapter: Address;
  nearPosition: Position;
  farAdapter: Address;
  farPosition: Position;
}>): Hex {
  return keccak256(encodeAbiParameters(
    ['bytes32', 'address', 'address', 'bytes32', 'address', 'bytes32'].map((type) => ({ type })),
    [
      input.packageId,
      input.account,
      input.nearAdapter,
      positionHash(input.nearPosition),
      input.farAdapter,
      positionHash(input.farPosition),
    ],
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
  lane: EvmCalendarSpreadPreparationLane,
  roleId: EvmCalendarSpreadRole,
  account: Address,
  packageId: Hex,
): Promise<AdapterState> {
  const factoryBinding = role(lane.adapters, roleId);
  const marketBinding = role(lane.pricing.markets, roleId);
  const factory = getAddress(factoryBinding.factory.address);
  const [factoryCode, addressValue] = await Promise.all([
    lane.pricing.chain.codeHash(factory),
    lane.pricing.chain.readContract({
      address: factory,
      abi: ADAPTER_FACTORY_ABI,
      functionName: 'adapterOf',
      args: [account, packageId],
    }),
  ]);
  requireCondition(factoryCode !== undefined
    && hash(factoryCode, `${roleId} factory code`) === hash(factoryBinding.factory.expectedCodeHash, `${roleId} expected factory code`),
  `${roleId} adapter factory code changed`);
  const address = getAddress(String(addressValue));
  const market = getAddress(marketBinding.contract.address);
  const [code, valid, positionValue, reserveValue] = await Promise.all([
    lane.pricing.chain.codeHash(address),
    lane.pricing.chain.readContract({
      address: factory,
      abi: ADAPTER_FACTORY_ABI,
      functionName: 'validateInstance',
      args: [address, account, packageId],
    }),
    lane.pricing.chain.readContract({ address, abi: FUTURE_ADAPTER_ABI, functionName: 'position' }),
    lane.pricing.chain.readContract({ address: market, abi: FUTURE_MARKET_ABI, functionName: 'reserveOf', args: [address] }),
  ]);
  requireCondition(code !== undefined
    && hash(code, `${roleId} adapter code`) === hash(factoryBinding.expectedAdapterCodeHash, `${roleId} expected adapter code`)
    && valid === true, `${roleId} adapter is not a reviewed package instance`);
  return Object.freeze({
    role: roleId,
    address,
    codeHash: hash(code, `${roleId} adapter code`),
    factory: factoryBinding,
    market: marketBinding,
    position: position(positionValue),
    reserveAtoms: natural(reserveValue, `${roleId} reserve`),
  });
}

function zeroPosition(): Position {
  return Object.freeze({
    balance: 0n,
    size: 0n,
    entryNotional: 0n,
    entrySocialLossIndex: 0n,
    entryFundingIndex: 0n,
  });
}

function postOpenPosition(snapshot: EvmCalendarFutureSnapshot, size: bigint, collateralAtoms: bigint): Position {
  return Object.freeze({
    balance: collateralAtoms * snapshot.collateralScale - snapshot.feeWad,
    size,
    entryNotional: snapshot.notionalWad,
    entrySocialLossIndex: 0n,
    entryFundingIndex: snapshot.currentFundingIndex,
  });
}

async function closePayout(
  lane: EvmCalendarSpreadPreparationLane,
  adapter: AdapterState,
  snapshot: EvmCalendarFutureSnapshot,
): Promise<bigint> {
  const value = await lane.pricing.chain.readContract({
    address: getAddress(adapter.market.contract.address),
    abi: FUTURE_MARKET_ABI,
    functionName: 'previewClose',
    args: [adapter.address],
  });
  return natural(structField(value, 4, 'payout'), `${adapter.role} close payout`) / snapshot.collateralScale;
}

export class EvmCalendarSpreadPreparationContextResolver implements StrategyPreparationContextResolver {
  readonly #lanes: readonly EvmCalendarSpreadPreparationLane[];

  constructor(lanes: readonly EvmCalendarSpreadPreparationLane[]) {
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
    const opening = documents.order.lifecycleAction === 'ENTRY';
    const closing = documents.order.lifecycleAction === 'EXIT' || documents.order.lifecycleAction === 'EMERGENCY_UNWIND';
    requireCondition((opening || closing) && documents.order.settlementClass === 'ATOMIC_POSTCONDITION'
      && documents.order.expiryUnit === 'EVM_UNIX_SECONDS', 'package is not a supported atomic EVM calendar execution');
    const chain = lane.pricing.chain;
    const [currentTime, chainId] = await Promise.all([chain.latestBlockTimestamp(), chain.chainId()]);
    requireCondition(chainId === lane.pricing.chainId, 'RPC chain identity differs from the lane');
    const orderHash = strategyPackageOrderHash(documents.order);
    const packageId = opening
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
    const [recognized, accountOwner, accountCode, nonceValue, packageValue, nearAdapter, farAdapter] = await Promise.all([
      chain.readContract({ address: accountFactory, abi: ACCOUNT_FACTORY_ABI, functionName: 'isAccount', args: [account] }),
      chain.readContract({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'owner' }),
      chain.codeHash(account),
      chain.readContract({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'nextNonce' }),
      chain.readContract({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'packageState', args: [checkedPackageId] }),
      readAdapter(lane, 'near-future', account, checkedPackageId),
      readAdapter(lane, 'far-future', account, checkedPackageId),
    ]);
    requireCondition(recognized === true && getAddress(String(accountOwner)) === owner, 'strategy account ownership is invalid');
    requireCondition(accountCode !== undefined && hash(accountCode, 'strategy account code')
      === hash(lane.expectedStrategyAccountCodeHash, 'expected account code'), 'strategy account code changed');
    const accountStateHash = hash(structField(packageValue, 1, 'stateHash'), 'package state hash', true);
    const accountActive = structField(packageValue, 3, 'active');
    requireCondition(typeof accountActive === 'boolean', 'package active state is invalid');
    if (opening) requireCondition(!accountActive && accountStateHash === zeroHash, 'entry package is already active');
    else requireCondition(accountActive && accountStateHash === toHex(documents.order.expectedStrategyStateHash!),
      'onchain package state differs from the signed expected state');

    const quantity = documents.order.economicQuantity.atoms;
    const nearLeg = documents.graph.legs.find((leg) => leg.legId === 'near-future');
    const farLeg = documents.graph.legs.find((leg) => leg.legId === 'far-future');
    requireCondition(nearLeg !== undefined && farLeg !== undefined && nearLeg.side !== 'NONE' && farLeg.side !== 'NONE',
      'calendar future legs are missing');
    const nearTarget = nearLeg.side === 'BUY' ? quantity : -quantity;
    const farTarget = farLeg.side === 'BUY' ? quantity : -quantity;
    requireCondition(opening
      ? nearAdapter.position.size === 0n && farAdapter.position.size === 0n
        && nearAdapter.reserveAtoms === 0n && farAdapter.reserveAtoms === 0n
      : nearAdapter.position.size === -nearTarget && farAdapter.position.size === -farTarget,
    opening ? 'entry adapters are not flat' : 'exit sides do not close the open calendar positions');
    const [nearSnapshot, farSnapshot] = await Promise.all([
      readEvmCalendarFutureSnapshot(lane.pricing, nearAdapter.market, opening ? nearTarget : -nearAdapter.position.size),
      readEvmCalendarFutureSnapshot(lane.pricing, farAdapter.market, opening ? farTarget : -farAdapter.position.size),
    ]);
    const deadline = [documents.order.expiryValue, documents.quote.validUntilValue, documents.route.routeExpiryValue]
      .reduce((minimum, candidate) => candidate < minimum ? candidate : minimum);
    requireCondition(currentTime < deadline, 'order, quote, or route expired');

    const makeBounds = async (
      adapter: AdapterState,
      snapshot: EvmCalendarFutureSnapshot,
      target: bigint,
    ): Promise<Readonly<{ bounds: EvmExactPerpLegBounds; post: Position; collateralIn: bigint }>> => {
      const economics = documents.quote.legEconomics.find((leg) => leg.legId === adapter.role);
      requireCondition(economics?.executionPrice !== undefined, `${adapter.role} quote economics are missing`);
      const quoteScale = 10n ** BigInt(lane.pricing.quoteAsset.decimals);
      const baseScale = 10n ** BigInt(lane.pricing.baseAsset.decimals);
      requireCondition(economics.executionPrice.quoteAtoms * WAD * baseScale
        === snapshot.fillPriceWad * economics.executionPrice.baseAtoms * quoteScale,
      `${adapter.role} current price differs from the signed quote`);
      const collateralIn = opening ? economics.marginDelta.atoms : 0n;
      const post = opening ? postOpenPosition(snapshot, target, collateralIn) : zeroPosition();
      const payout = opening ? 0n : await closePayout(lane, adapter, snapshot);
      return Object.freeze({
        collateralIn,
        post,
        bounds: Object.freeze({
          legId: adapter.role,
          expectedPrePositionHash: positionHash(adapter.position),
          tradeArgs: tradeArgs(snapshot.expiry, deadline, opening ? target : -adapter.position.size, opening ? collateralIn * snapshot.collateralScale : 0n),
          expectedPostSizeWad: post.size,
          minimumPostBalanceWad: post.balance,
          maximumPostBalanceWad: post.balance,
          minimumPostEntryNotionalWad: post.entryNotional,
          maximumPostEntryNotionalWad: post.entryNotional,
          expectedReserveBeforeAtoms: adapter.reserveAtoms,
          minimumReserveAfterAtoms: 0n,
          maximumReserveAfterAtoms: 0n,
          collateralInAtoms: collateralIn,
          collateralOutAtoms: 0n,
          withdrawAll: !opening,
          minimumCollateralOutAtoms: payout,
          maximumCollateralOutAtoms: payout,
        }),
      });
    };
    const [nearExecution, farExecution] = await Promise.all([
      makeBounds(nearAdapter, nearSnapshot, nearTarget),
      makeBounds(farAdapter, farSnapshot, farTarget),
    ]);
    const materializer = (
      adapter: AdapterState,
      bounds: EvmExactPerpLegBounds,
    ) => createEvmExactFutureMaterializer({
      binding: {
        domain: lane.pricing.domain,
        adapter: adapter.market.adapter,
        venue: adapter.market.venue,
        market: adapter.market.market,
        legFamily: adapter.role === 'near-future' ? nearLeg.legFamily : farLeg.legFamily,
        materializationClassId: FUTURE_MATERIALIZATION_CLASS,
        adapterAddress: adapter.address,
        expectedAdapterCodeHash: adapter.codeHash,
        maximumGasLimit: adapter.factory.maximumGasLimit,
      },
      bounds: [bounds],
    });
    const nextStateHash = opening ? strategyStateHash({
      packageId: checkedPackageId,
      account,
      nearAdapter: nearAdapter.address,
      nearPosition: nearExecution.post,
      farAdapter: farAdapter.address,
      farPosition: farExecution.post,
    }) : undefined;
    if (nextStateHash !== undefined) await lane.packageIds.rememberPackageId?.(nextStateHash, checkedPackageId);
    const policy = (
      adapter: AdapterState,
      economics: NonNullable<(typeof documents.quote.legEconomics)[number]>,
      collateralIn: bigint,
    ): EvmStrategyCallPolicy => Object.freeze({
      legId: adapter.role,
      adapter: Object.freeze({
        subjectId: keccak256(stringToHex(adapter.market.adapter.adapterId)),
        manifestVersion: adapter.market.adapter.adapterManifestVersion,
        manifestHash: toHex(adapter.market.adapter.adapterManifestHash),
      }),
      expectedAdapterAddress: adapter.address,
      expectedAdapterCodeHash: adapter.codeHash,
      riskIncreasing: opening,
      ...(opening ? { approvalToken: getAddress(lane.pricing.quoteToken.address) } : {}),
      approvalAtoms: collateralIn,
      grossNotionalAtoms: economics.grossNotional.atoms,
    });
    const nearEconomics = documents.quote.legEconomics.find((leg) => leg.legId === 'near-future');
    const farEconomics = documents.quote.legEconomics.find((leg) => leg.legId === 'far-future');
    requireCondition(nearEconomics !== undefined && farEconomics !== undefined, 'quote lacks calendar leg economics');
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
          materializer(nearAdapter, nearExecution.bounds),
          materializer(farAdapter, farExecution.bounds),
        ]),
      })]),
      bindings: Object.freeze([{
        kind: 'EVM_MULTI_STRATEGY_ACCOUNT' as const,
        domain: lane.pricing.domain,
        account,
        chainId: Number(lane.pricing.chainId),
        solver: getAddress(lane.solver),
        totalGrossNotionalAtoms: nearEconomics.grossNotional.atoms + farEconomics.grossNotional.atoms,
        feePolicyVersion: documents.quote.feePolicyVersion,
        feePolicyManifestHash: toHex(documents.quote.feePolicyManifestHash),
        feeToken: getAddress(lane.pricing.quoteToken.address),
        protocolFeeAtoms: charge(documents, 'PROTOCOL'),
        solverFeeAtoms: charge(documents, 'SOLVER'),
        nonce: natural(nonceValue, 'account nonce'),
        deadline,
        callPolicies: Object.freeze([
          policy(nearAdapter, nearEconomics, nearExecution.collateralIn),
          policy(farAdapter, farEconomics, farExecution.collateralIn),
        ]),
      }]),
    });
  }
}
