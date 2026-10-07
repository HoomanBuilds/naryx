import {
  assetAmount,
  bytesEqual,
  exactPrice,
  manifestHash,
  STRATEGY_TEMPLATE_ID,
  type AdapterRef,
  type AssetRef,
  type DomainRef,
  type PackageGraphCompileContext,
  type StrategyLegEconomicsInput,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import { getAddress, type Abi, type Address, type Hex } from 'viem';
import type { StoredStrategyPackageOrderDocuments } from './http-strategy-package-provider.js';
import type { GeneralizedStrategyPricingPort, GeneralizedStrategyQuoteTerms } from './strategy-quote-service.js';
import type {
  EvmOptionSpreadContractIdentity,
  EvmOptionSpreadQuoteNonceSource,
  EvmOptionSpreadReadPort,
} from './evm-option-spread-quote.js';

const BPS = 10_000n;
const WAD = 1_000_000_000_000_000_000n;
const PERP_ABI = [{
  type: 'function', name: 'collateral', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'oracle', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'expiry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint32' }],
}, {
  type: 'function', name: 'takerFeeBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }],
}, {
  type: 'function', name: 'initialMarginBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }],
}, {
  type: 'function', name: 'maintenanceMarginBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }],
}, {
  type: 'function', name: 'collateralScale', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }],
}, {
  type: 'function', name: 'oraclePriceWad', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }],
}, {
  type: 'function', name: 'currentFundingIndex', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'int256' }],
}, {
  type: 'function', name: 'previewOpen', stateMutability: 'view',
  inputs: [{ name: 'sizeDelta', type: 'int128' }, { name: 'balanceWad', type: 'uint256' }],
  outputs: [
    { name: 'fillPriceWad', type: 'uint256' },
    { name: 'entryNotionalWad', type: 'uint256' },
    { name: 'feeWad', type: 'uint256' },
    { name: 'marginWad', type: 'uint256' },
  ],
}] as const satisfies Abi;

export interface EvmTreasuryHedgeLegBinding {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
}

export interface EvmTreasuryHedgeMarketSnapshot {
  readonly market: Address;
  readonly expiry: bigint;
  readonly oraclePriceWad: bigint;
  readonly fillPriceWad: bigint;
  readonly notionalWad: bigint;
  readonly feeWad: bigint;
  readonly collateralScale: bigint;
  readonly initialMarginBps: bigint;
  readonly maintenanceMarginBps: bigint;
  readonly currentFundingIndex: bigint;
}

export interface EvmTreasuryHedgePricingInput {
  readonly chainId: bigint;
  readonly domain: DomainRef;
  readonly inventoryAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly inventoryToken: EvmOptionSpreadContractIdentity;
  readonly quoteToken: EvmOptionSpreadContractIdentity;
  readonly oracle: EvmOptionSpreadContractIdentity;
  readonly market: EvmOptionSpreadContractIdentity;
  readonly inventory: EvmTreasuryHedgeLegBinding;
  readonly hedge: EvmTreasuryHedgeLegBinding;
  readonly protocolFeeBps: number;
  readonly solverFeeBps: number;
  readonly networkFeeQuoteAtoms: bigint;
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Uint8Array | string;
  readonly routeTtlSeconds: bigint;
  readonly quoteTtlSeconds: bigint;
  readonly chain: EvmOptionSpreadReadPort;
  readonly nonceSource: EvmOptionSpreadQuoteNonceSource;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM treasury hedge quote refused: ${message}`);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameManifest(left: VersionedManifestRef, right: VersionedManifestRef): boolean {
  return left.subjectId === right.subjectId && left.manifestVersion === right.manifestVersion
    && bytesEqual(left.manifestHash, right.manifestHash);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function checkedHash(value: Hex, context: string): Hex {
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/.test(value), `${context} code hash is invalid`);
  return value.toLowerCase() as Hex;
}

function checkedBigInt(value: unknown, context: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= 0n, `${context} is invalid`);
  return value;
}

function tuple(value: unknown, length: number, context: string): readonly unknown[] {
  requireCondition(Array.isArray(value) && value.length >= length, `${context} is invalid`);
  return value;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  requireCondition(numerator >= 0n && denominator > 0n, 'division inputs are invalid');
  return (numerator + denominator - 1n) / denominator;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

async function assertCode(
  chain: EvmOptionSpreadReadPort,
  identity: EvmOptionSpreadContractIdentity,
  context: string,
): Promise<void> {
  const actual = await chain.codeHash(getAddress(identity.address));
  requireCondition(actual !== undefined && checkedHash(actual, context) === checkedHash(identity.expectedCodeHash, context), `${context} code changed`);
}

function matchLeg(documents: StoredStrategyPackageOrderDocuments, role: 'inventory-position' | 'treasury-hedge', binding: EvmTreasuryHedgeLegBinding) {
  const matches = documents.graph.legs.filter((leg) => leg.legId === role);
  requireCondition(matches.length === 1, `${role} graph leg is missing`);
  const leg = matches[0]!;
  requireCondition(sameAdapter(leg.adapter, binding.adapter) && sameManifest(leg.venue, binding.venue)
    && sameManifest(leg.market, binding.market), `${role} identity differs from the reviewed binding`);
  return leg;
}

export async function readEvmTreasuryHedgeMarketSnapshot(
  input: EvmTreasuryHedgePricingInput,
  sizeDelta: bigint,
): Promise<EvmTreasuryHedgeMarketSnapshot> {
  requireCondition(sizeDelta !== 0n && sizeDelta >= -(1n << 127n) && sizeDelta < (1n << 127n), 'hedge size is outside int128');
  const market = getAddress(input.market.address);
  const read = (functionName: string, args?: readonly unknown[]) => input.chain.readContract({
    address: market,
    abi: PERP_ABI,
    functionName,
    ...(args === undefined ? {} : { args }),
  });
  const [collateralValue, oracleValue, expiryValue, takerFeeValue, initialMarginValue,
    maintenanceMarginValue, collateralScaleValue, oraclePriceValue, fundingIndexValue, previewValue] = await Promise.all([
    read('collateral'),
    read('oracle'),
    read('expiry'),
    read('takerFeeBps'),
    read('initialMarginBps'),
    read('maintenanceMarginBps'),
    read('collateralScale'),
    read('oraclePriceWad'),
    read('currentFundingIndex'),
    read('previewOpen', [sizeDelta, 0n]),
    assertCode(input.chain, input.market, 'perpetual market'),
    assertCode(input.chain, input.inventoryToken, 'inventory token'),
    assertCode(input.chain, input.quoteToken, 'quote token'),
    assertCode(input.chain, input.oracle, 'oracle'),
  ]);
  requireCondition(getAddress(String(collateralValue)) === getAddress(input.quoteToken.address)
    && getAddress(String(oracleValue)) === getAddress(input.oracle.address), 'market collateral or oracle changed');
  const preview = tuple(previewValue, 4, 'perpetual preview');
  const expiry = checkedBigInt(expiryValue, 'market expiry');
  const oraclePriceWad = checkedBigInt(oraclePriceValue, 'oracle price');
  const fillPriceWad = checkedBigInt(preview[0], 'fill price');
  const notionalWad = checkedBigInt(preview[1], 'notional');
  const feeWad = checkedBigInt(preview[2], 'venue fee');
  const collateralScale = checkedBigInt(collateralScaleValue, 'collateral scale');
  const takerFeeBps = checkedBigInt(takerFeeValue, 'taker fee');
  const initialMarginBps = checkedBigInt(initialMarginValue, 'initial margin');
  const maintenanceMarginBps = checkedBigInt(maintenanceMarginValue, 'maintenance margin');
  requireCondition(typeof fundingIndexValue === 'bigint', 'funding index is invalid');
  requireCondition(expiry > 0n && oraclePriceWad > 0n && fillPriceWad > 0n && notionalWad > 0n
    && collateralScale > 0n && takerFeeBps < BPS && initialMarginBps > maintenanceMarginBps,
  'market economics are invalid');
  return Object.freeze({
    market,
    expiry,
    oraclePriceWad,
    fillPriceWad,
    notionalWad,
    feeWad,
    collateralScale,
    initialMarginBps,
    maintenanceMarginBps,
    currentFundingIndex: fundingIndexValue,
  });
}

function validateConfiguration(input: EvmTreasuryHedgePricingInput): void {
  requireCondition(input.chainId > 0n && input.domain.domainId === `eip155:${input.chainId}`, 'chain and domain differ');
  requireCondition(input.inventoryAsset.decimals === 18 && input.quoteAsset.decimals <= 18
    && !sameAsset(input.inventoryAsset, input.quoteAsset), 'assets are invalid');
  requireCondition(Number.isInteger(input.protocolFeeBps) && input.protocolFeeBps >= 0 && input.protocolFeeBps < 1_000
    && Number.isInteger(input.solverFeeBps) && input.solverFeeBps >= 0 && input.solverFeeBps < 1_000,
  'service fee rates are invalid');
  requireCondition(input.networkFeeQuoteAtoms >= 0n && input.feePolicyVersion > 0
    && input.routeTtlSeconds > 0n && input.quoteTtlSeconds >= input.routeTtlSeconds,
  'fee policy or validity is invalid');
  manifestHash(input.feePolicyManifestHash, 'evmTreasuryHedge.feePolicyManifestHash');
  checkedHash(input.inventoryToken.expectedCodeHash, 'inventory token');
  checkedHash(input.quoteToken.expectedCodeHash, 'quote token');
  checkedHash(input.oracle.expectedCodeHash, 'oracle');
  checkedHash(input.market.expectedCodeHash, 'perpetual market');
}

function serviceCharge(category: 'PROTOCOL' | 'SOLVER', asset: AssetRef, atoms: bigint) {
  return Object.freeze({ category, amount: assetAmount(asset, atoms) });
}

export function createEvmTreasuryHedgeGeneralizedPricing(
  input: EvmTreasuryHedgePricingInput,
): GeneralizedStrategyPricingPort {
  validateConfiguration(input);
  return Object.freeze({
    async quote({ documents, currentTime }: Readonly<{
      documents: StoredStrategyPackageOrderDocuments;
      currentTime: PackageGraphCompileContext['currentTime'];
    }>): Promise<GeneralizedStrategyQuoteTerms> {
      const { order, graph } = documents;
      requireCondition(order.environment === 'testnet' && graph.environment === 'testnet'
        && order.templateId === STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE
        && graph.templateId === STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE
        && order.settlementClass === 'ATOMIC_POSTCONDITION' && graph.settlementClass === 'ATOMIC_POSTCONDITION'
        && order.expiryUnit === 'EVM_UNIX_SECONDS' && graph.expiryUnit === 'EVM_UNIX_SECONDS',
      'package is not a testnet atomic EVM treasury hedge');
      requireCondition(order.lifecycleAction === 'ENTRY' || order.lifecycleAction === 'EXIT'
        || order.lifecycleAction === 'EMERGENCY_UNWIND', 'lifecycle action is unsupported');
      requireCondition(graph.legs.length === 2 && graph.legs.every((leg) => sameDomain(leg.domain, input.domain)),
        'package domain is unsupported');
      requireCondition(sameAsset(order.economicQuantity.asset, input.inventoryAsset)
        && sameAsset(order.quoteAsset, input.quoteAsset), 'package assets are unsupported');
      requireCondition(currentTime.unit === 'EVM_UNIX_SECONDS', 'quote clock is invalid');
      const inventoryLeg = matchLeg(documents, 'inventory-position', input.inventory);
      const hedgeLeg = matchLeg(documents, 'treasury-hedge', input.hedge);
      const opening = order.lifecycleAction === 'ENTRY';
      const quantity = order.economicQuantity.atoms;
      requireCondition(quantity > 0n && quantity === inventoryLeg.quantityAtoms && quantity === hedgeLeg.quantityAtoms,
        'leg quantities differ from the package quantity');
      requireCondition(inventoryLeg.legFamily === 'INVENTORY_TRANSFER' && inventoryLeg.side === 'NONE'
        && hedgeLeg.legFamily === (opening ? 'PERP_OPEN' : 'PERP_CLOSE')
        && hedgeLeg.side === (opening ? 'SELL' : 'BUY'), 'legs do not match the lifecycle action');
      const sizeDelta = opening ? -quantity : quantity;
      const [chainId, observedAt, snapshot] = await Promise.all([
        input.chain.chainId(),
        input.chain.latestBlockTimestamp(),
        readEvmTreasuryHedgeMarketSnapshot(input, sizeDelta),
      ]);
      requireCondition(chainId === input.chainId, 'RPC chain identity differs from the reviewed chain');
      requireCondition(observedAt >= currentTime.value && observedAt - currentTime.value <= 30n,
        'quote clock is stale or from another head');
      requireCondition(observedAt < snapshot.expiry, 'perpetual market expired');
      const limitPrice = hedgeLeg.limitPrice;
      requireCondition(limitPrice !== undefined
        && sameAsset(limitPrice.baseAsset, input.inventoryAsset)
        && sameAsset(limitPrice.quoteAsset, input.quoteAsset), 'hedge limit price is invalid');
      const baseScale = 10n ** BigInt(input.inventoryAsset.decimals);
      const quoteScale = 10n ** BigInt(input.quoteAsset.decimals);
      const fillAtLimitScale = snapshot.fillPriceWad * limitPrice.baseAtoms * quoteScale;
      const signedLimitAtWadScale = limitPrice.quoteAtoms * baseScale * WAD;
      requireCondition(opening ? fillAtLimitScale >= signedLimitAtWadScale : fillAtLimitScale <= signedLimitAtWadScale,
        'executable hedge price violates the signed limit');
      const notionalAtoms = ceilDiv(snapshot.notionalWad, snapshot.collateralScale);
      const oracleNotionalWad = quantity * snapshot.oraclePriceWad / WAD;
      const adverseExecutionWad = snapshot.notionalWad > oracleNotionalWad
        ? snapshot.notionalWad - oracleNotionalWad
        : oracleNotionalWad - snapshot.notionalWad;
      const adverseExecutionAtoms = ceilDiv(adverseExecutionWad, snapshot.collateralScale);
      const venueFeeAtoms = ceilDiv(snapshot.feeWad, snapshot.collateralScale);
      const requiredMarginWad = opening
        ? ceilDiv(snapshot.notionalWad * snapshot.initialMarginBps, BPS) + snapshot.feeWad
        : 0n;
      const requiredMarginAtoms = opening ? ceilDiv(requiredMarginWad, snapshot.collateralScale) : 0n;
      const protocolFee = ceilDiv(notionalAtoms * BigInt(input.protocolFeeBps), BPS);
      const solverFee = ceilDiv(notionalAtoms * BigInt(input.solverFeeBps), BPS);
      const totalCost = adverseExecutionAtoms + venueFeeAtoms + protocolFee + solverFee + input.networkFeeQuoteAtoms;
      const maintenanceWad = ceilDiv(snapshot.notionalWad * snapshot.maintenanceMarginBps, BPS);
      const postMarginWad = requiredMarginAtoms * snapshot.collateralScale - snapshot.feeWad;
      const liquidationDistanceBps = opening && postMarginWad > maintenanceWad
        ? (postMarginWad - maintenanceWad) * BPS / snapshot.notionalWad
        : 0n;
      const priceNumerator = snapshot.fillPriceWad * quoteScale;
      const priceDenominator = WAD * baseScale;
      const priceDivisor = gcd(priceNumerator, priceDenominator);
      const legEconomics: readonly StrategyLegEconomicsInput[] = Object.freeze([
        Object.freeze({
          legId: inventoryLeg.legId,
          quantity: assetAmount(input.inventoryAsset, quantity),
          grossNotional: assetAmount(input.quoteAsset, ceilDiv(oracleNotionalWad, snapshot.collateralScale)),
          marginDelta: assetAmount(input.quoteAsset, 0n),
          venueFee: assetAmount(input.quoteAsset, 0n),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
        Object.freeze({
          legId: hedgeLeg.legId,
          quantity: assetAmount(input.inventoryAsset, quantity),
          executionPrice: exactPrice({
            baseAsset: input.inventoryAsset,
            quoteAsset: input.quoteAsset,
            quoteAtoms: priceNumerator / priceDivisor,
            baseAtoms: priceDenominator / priceDivisor,
            roundingDirection: opening ? 'FLOOR' : 'CEIL',
          }),
          grossNotional: assetAmount(input.quoteAsset, notionalAtoms),
          marginDelta: assetAmount(input.quoteAsset, requiredMarginAtoms),
          venueFee: assetAmount(input.quoteAsset, venueFeeAtoms),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
      ]);
      const validUntilValue = [observedAt + input.quoteTtlSeconds, order.expiryValue, snapshot.expiry - 1n]
        .reduce((minimum, value) => value < minimum ? value : minimum);
      const routeExpiryValue = [observedAt + input.routeTtlSeconds, validUntilValue]
        .reduce((minimum, value) => value < minimum ? value : minimum);
      requireCondition(routeExpiryValue > observedAt && validUntilValue > observedAt, 'no executable validity remains');
      const quoteNonce = input.nonceSource.nextNonce();
      requireCondition(quoteNonce > 0n, 'quote nonce is invalid');
      return Object.freeze({
        quoteMode: 'EXECUTION_COMMITMENT' as const,
        economics: Object.freeze({
          templateId: STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE,
          values: Object.freeze({
            inventoryAtoms: quantity,
            hedgeAtoms: opening ? -quantity : quantity,
            hedgeCostAtoms: totalCost,
            maximumLossAtoms: requiredMarginAtoms,
            liquidationDistanceBps,
          }),
        }),
        legEconomics,
        netPackageOutcomeAtoms: -totalCost,
        serviceCharges: Object.freeze([
          ...(protocolFee === 0n ? [] : [serviceCharge('PROTOCOL', input.quoteAsset, protocolFee)]),
          ...(solverFee === 0n ? [] : [serviceCharge('SOLVER', input.quoteAsset, solverFee)]),
        ]),
        passThroughCosts: Object.freeze([
          ...(venueFeeAtoms === 0n ? [] : [{ category: 'VENUE' as const, amount: assetAmount(input.quoteAsset, venueFeeAtoms) }]),
          ...(input.networkFeeQuoteAtoms === 0n ? [] : [{ category: 'NETWORK' as const, amount: assetAmount(input.quoteAsset, input.networkFeeQuoteAtoms) }]),
        ]),
        feePolicyVersion: input.feePolicyVersion,
        feePolicyManifestHash: input.feePolicyManifestHash,
        routeExpiryValue,
        validUntilValue,
        quoteNonce,
      });
    },
  });
}
