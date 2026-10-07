import {
  STRATEGY_TEMPLATE_ID,
  assetAmount,
  bytesEqual,
  exactPrice,
  manifestHash,
  type AdapterRef,
  type AssetRef,
  type DomainRef,
  type PackageGraphCompileContext,
  type StrategyLegEconomicsInput,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import { getAddress, type Abi, type Address } from 'viem';
import type { StoredStrategyPackageOrderDocuments } from './http-strategy-package-provider.js';
import type { GeneralizedStrategyPricingPort, GeneralizedStrategyQuoteTerms } from './strategy-quote-service.js';
import {
  readEvmTreasuryHedgeMarketSnapshot,
  type EvmTreasuryHedgePricingInput,
} from './evm-treasury-hedge-quote.js';
import type {
  EvmOptionSpreadContractIdentity,
  EvmOptionSpreadQuoteNonceSource,
  EvmOptionSpreadReadPort,
} from './evm-option-spread-quote.js';

const BPS = 10_000n;
const WAD = 10n ** 18n;
const UNISWAP_FEE_DENOMINATOR = 1_000_000n;
const FACTORY_ABI = [{
  type: 'function', name: 'getPool', stateMutability: 'view',
  inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }],
  outputs: [{ name: '', type: 'address' }],
}] as const satisfies Abi;
const POOL_ABI = [{
  type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint24' }],
}] as const satisfies Abi;
const QUOTER_ABI = [{
  type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'quoteExactOutputSingle', stateMutability: 'view', inputs: [{
    name: 'params', type: 'tuple', components: [
      { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
      { name: 'amount', type: 'uint256' }, { name: 'fee', type: 'uint24' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
  }], outputs: [
    { name: 'amountIn', type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32' }, { name: 'gasEstimate', type: 'uint256' },
  ],
}, {
  type: 'function', name: 'quoteExactInputSingle', stateMutability: 'view', inputs: [{
    name: 'params', type: 'tuple', components: [
      { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
  }], outputs: [
    { name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32' }, { name: 'gasEstimate', type: 'uint256' },
  ],
}] as const satisfies Abi;

export interface EvmCollateralConversionLegBinding {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
}

export interface EvmCollateralConversionPricingInput {
  readonly chainId: bigint;
  readonly domain: DomainRef;
  readonly collateralAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly collateralToken: EvmOptionSpreadContractIdentity;
  readonly quoteToken: EvmOptionSpreadContractIdentity;
  readonly spotFactory: EvmOptionSpreadContractIdentity;
  readonly spotPool: EvmOptionSpreadContractIdentity;
  readonly spotQuoter: EvmOptionSpreadContractIdentity;
  readonly spotPoolFee: number;
  readonly lendingPool: EvmOptionSpreadContractIdentity;
  readonly oracle: EvmOptionSpreadContractIdentity;
  readonly perpetualMarket: EvmOptionSpreadContractIdentity;
  readonly swap: EvmCollateralConversionLegBinding;
  readonly collateralTransfer: EvmCollateralConversionLegBinding;
  readonly hedge: EvmCollateralConversionLegBinding;
  readonly minimumPostHealthFactor: bigint;
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

export interface EvmCollateralConversionSpotSnapshot {
  readonly quoteAtoms: bigint;
  readonly priceQuoteAtoms: bigint;
  readonly priceBaseAtoms: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM collateral conversion quote refused: ${message}`);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
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

function natural(value: unknown, context: string): bigint {
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

async function code(input: EvmCollateralConversionPricingInput, identity: EvmOptionSpreadContractIdentity, context: string) {
  const actual = await input.chain.codeHash(getAddress(identity.address));
  requireCondition(actual?.toLowerCase() === identity.expectedCodeHash.toLowerCase(), `${context} code changed`);
}

function matchLeg(
  documents: StoredStrategyPackageOrderDocuments,
  role: 'collateral-swap' | 'collateral-transfer' | 'conversion-hedge',
  binding: EvmCollateralConversionLegBinding,
) {
  const matches = documents.graph.legs.filter((leg) => leg.legId === role);
  requireCondition(matches.length === 1, `${role} graph leg is missing`);
  const leg = matches[0]!;
  requireCondition(sameAdapter(leg.adapter, binding.adapter) && sameManifest(leg.venue, binding.venue)
    && sameManifest(leg.market, binding.market), `${role} identity differs from the reviewed binding`);
  return leg;
}

function quoteBound(quantity: bigint, quoteAtoms: bigint, baseAtoms: bigint, buys: boolean): bigint {
  const product = quantity * quoteAtoms;
  return buys ? ceilDiv(product, baseAtoms) : product / baseAtoms;
}

async function readSpot(
  input: EvmCollateralConversionPricingInput,
  quantity: bigint,
  opening: boolean,
): Promise<EvmCollateralConversionSpotSnapshot> {
  const factory = getAddress(input.spotFactory.address);
  const pool = getAddress(input.spotPool.address);
  const quoter = getAddress(input.spotQuoter.address);
  const collateral = getAddress(input.collateralToken.address);
  const quote = getAddress(input.quoteToken.address);
  const [factoryPool, poolFactory, token0, token1, feeValue, quoterFactory, quoted] = await Promise.all([
    input.chain.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'getPool', args: [collateral, quote, input.spotPoolFee] }),
    input.chain.readContract({ address: pool, abi: POOL_ABI, functionName: 'factory' }),
    input.chain.readContract({ address: pool, abi: POOL_ABI, functionName: 'token0' }),
    input.chain.readContract({ address: pool, abi: POOL_ABI, functionName: 'token1' }),
    input.chain.readContract({ address: pool, abi: POOL_ABI, functionName: 'fee' }),
    input.chain.readContract({ address: quoter, abi: QUOTER_ABI, functionName: 'factory' }),
    input.chain.readContract({
      address: quoter,
      abi: QUOTER_ABI,
      functionName: opening ? 'quoteExactOutputSingle' : 'quoteExactInputSingle',
      args: [opening
        ? { tokenIn: quote, tokenOut: collateral, amount: quantity, fee: input.spotPoolFee, sqrtPriceLimitX96: 0n }
        : { tokenIn: collateral, tokenOut: quote, amountIn: quantity, fee: input.spotPoolFee, sqrtPriceLimitX96: 0n }],
    }),
    code(input, input.collateralToken, 'collateral token'),
    code(input, input.quoteToken, 'quote token'),
    code(input, input.spotFactory, 'spot factory'),
    code(input, input.spotPool, 'spot pool'),
    code(input, input.spotQuoter, 'spot quoter'),
    code(input, input.lendingPool, 'lending pool'),
  ]);
  const tokens = new Set([getAddress(String(token0)), getAddress(String(token1))]);
  requireCondition(getAddress(String(factoryPool)) === pool && getAddress(String(poolFactory)) === factory
    && getAddress(String(quoterFactory)) === factory && tokens.has(collateral) && tokens.has(quote)
    && natural(feeValue, 'pool fee') === BigInt(input.spotPoolFee), 'spot venue identity changed');
  const amount = natural(tuple(quoted, 4, 'spot quote')[0], 'spot quote amount');
  requireCondition(amount > 0n, 'spot quote is empty');
  const priceNumerator = opening ? amount : amount;
  const priceDenominator = quantity;
  const divisor = gcd(priceNumerator, priceDenominator);
  return Object.freeze({
    quoteAtoms: amount,
    priceQuoteAtoms: priceNumerator / divisor,
    priceBaseAtoms: priceDenominator / divisor,
  });
}

export function readEvmCollateralConversionSpotSnapshot(
  input: EvmCollateralConversionPricingInput,
  quantity: bigint,
  opening: boolean,
): Promise<EvmCollateralConversionSpotSnapshot> {
  requireCondition(quantity > 0n, 'spot quantity is invalid');
  return readSpot(input, quantity, opening);
}

function validateConfiguration(input: EvmCollateralConversionPricingInput): void {
  requireCondition(input.chainId > 0n && input.domain.domainId === `eip155:${input.chainId}`, 'chain and domain differ');
  requireCondition(!sameAsset(input.collateralAsset, input.quoteAsset)
    && input.collateralAsset.decimals <= 18 && input.quoteAsset.decimals <= 18, 'assets are invalid');
  requireCondition(Number.isInteger(input.spotPoolFee) && input.spotPoolFee > 0 && input.spotPoolFee < 1_000_000,
    'spot pool fee is invalid');
  requireCondition(input.minimumPostHealthFactor > 0n
    && Number.isInteger(input.protocolFeeBps) && input.protocolFeeBps >= 0 && input.protocolFeeBps < 1_000
    && Number.isInteger(input.solverFeeBps) && input.solverFeeBps >= 0 && input.solverFeeBps < 1_000,
  'risk or service fee configuration is invalid');
  requireCondition(input.networkFeeQuoteAtoms >= 0n && input.feePolicyVersion > 0
    && input.routeTtlSeconds > 0n && input.quoteTtlSeconds >= input.routeTtlSeconds,
  'fee policy or validity is invalid');
  manifestHash(input.feePolicyManifestHash, 'evmCollateralConversion.feePolicyManifestHash');
}

export function createEvmCollateralConversionGeneralizedPricing(
  input: EvmCollateralConversionPricingInput,
): GeneralizedStrategyPricingPort {
  validateConfiguration(input);
  const perpPricing: EvmTreasuryHedgePricingInput = Object.freeze({
    chainId: input.chainId,
    domain: input.domain,
    inventoryAsset: input.collateralAsset,
    quoteAsset: input.quoteAsset,
    inventoryToken: input.collateralToken,
    quoteToken: input.quoteToken,
    oracle: input.oracle,
    market: input.perpetualMarket,
    inventory: input.swap,
    hedge: input.hedge,
    protocolFeeBps: input.protocolFeeBps,
    solverFeeBps: input.solverFeeBps,
    networkFeeQuoteAtoms: input.networkFeeQuoteAtoms,
    feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash,
    routeTtlSeconds: input.routeTtlSeconds,
    quoteTtlSeconds: input.quoteTtlSeconds,
    chain: input.chain,
    nonceSource: input.nonceSource,
  });
  return Object.freeze({
    async quote({ documents, currentTime }: Readonly<{
      documents: StoredStrategyPackageOrderDocuments;
      currentTime: PackageGraphCompileContext['currentTime'];
    }>): Promise<GeneralizedStrategyQuoteTerms> {
      const { order, graph } = documents;
      requireCondition(order.environment === 'testnet' && graph.environment === 'testnet'
        && order.templateId === STRATEGY_TEMPLATE_ID.COLLATERAL_CONVERSION_HEDGE
        && graph.templateId === STRATEGY_TEMPLATE_ID.COLLATERAL_CONVERSION_HEDGE
        && order.settlementClass === 'ATOMIC_POSTCONDITION' && graph.settlementClass === 'ATOMIC_POSTCONDITION'
        && order.expiryUnit === 'EVM_UNIX_SECONDS' && graph.expiryUnit === 'EVM_UNIX_SECONDS',
      'package is not a testnet atomic EVM collateral conversion');
      requireCondition(order.lifecycleAction === 'ENTRY' || order.lifecycleAction === 'INCREASE'
        || order.lifecycleAction === 'DECREASE' || order.lifecycleAction === 'EXIT'
        || order.lifecycleAction === 'EMERGENCY_UNWIND', 'lifecycle action is unsupported');
      requireCondition(graph.legs.length === 3 && graph.legs.every((leg) => sameDomain(leg.domain, input.domain))
        && sameAsset(order.economicQuantity.asset, input.collateralAsset)
        && sameAsset(order.quoteAsset, input.quoteAsset), 'package domain or assets are unsupported');
      requireCondition(currentTime.unit === 'EVM_UNIX_SECONDS', 'quote clock is invalid');
      const swap = matchLeg(documents, 'collateral-swap', input.swap);
      const transfer = matchLeg(documents, 'collateral-transfer', input.collateralTransfer);
      const hedge = matchLeg(documents, 'conversion-hedge', input.hedge);
      const increasing = order.lifecycleAction === 'ENTRY' || order.lifecycleAction === 'INCREASE';
      const quantity = order.economicQuantity.atoms;
      requireCondition(quantity > 0n && [swap, transfer, hedge].every((leg) => leg.quantityAtoms === quantity),
        'leg quantities differ from the package quantity');
      requireCondition(swap.legFamily === 'SPOT_SWAP' && swap.side === (increasing ? 'BUY' : 'SELL')
        && transfer.legFamily === (increasing ? 'MARGIN_DEPOSIT' : 'MARGIN_RELEASE') && transfer.side === 'NONE'
        && hedge.legFamily === (order.lifecycleAction === 'ENTRY' ? 'PERP_OPEN'
          : order.lifecycleAction === 'INCREASE' ? 'PERP_INCREASE'
            : order.lifecycleAction === 'DECREASE' ? 'PERP_DECREASE' : 'PERP_CLOSE')
        && hedge.side === (increasing ? 'SELL' : 'BUY'),
      'legs do not match the lifecycle action');
      const [chainId, observedAt, spot, perp] = await Promise.all([
        input.chain.chainId(), input.chain.latestBlockTimestamp(), readSpot(input, quantity, increasing),
        readEvmTreasuryHedgeMarketSnapshot(perpPricing, increasing ? -quantity : quantity),
      ]);
      requireCondition(chainId === input.chainId && observedAt >= currentTime.value && observedAt - currentTime.value <= 30n,
        'RPC identity or quote clock is invalid');
      requireCondition(observedAt < perp.expiry, 'perpetual market expired');
      const swapLimit = swap.limitPrice;
      const hedgeLimit = hedge.limitPrice;
      requireCondition(swapLimit !== undefined && hedgeLimit !== undefined, 'signed price limits are missing');
      const swapBound = quoteBound(quantity, swapLimit.quoteAtoms, swapLimit.baseAtoms, increasing);
      requireCondition(increasing ? spot.quoteAtoms <= swapBound : spot.quoteAtoms >= swapBound,
        'executable collateral price violates the signed limit');
      const baseScale = 10n ** BigInt(input.collateralAsset.decimals);
      const quoteScale = 10n ** BigInt(input.quoteAsset.decimals);
      const hedgeAtLimitScale = perp.fillPriceWad * hedgeLimit.baseAtoms * quoteScale;
      const signedHedgeAtWadScale = hedgeLimit.quoteAtoms * baseScale * WAD;
      requireCondition(increasing ? hedgeAtLimitScale >= signedHedgeAtWadScale : hedgeAtLimitScale <= signedHedgeAtWadScale,
        'executable hedge price violates the signed limit');
      const oracleNotionalWad = quantity * perp.oraclePriceWad / baseScale;
      const oracleNotionalAtoms = ceilDiv(oracleNotionalWad, perp.collateralScale);
      const conversionDeviation = increasing
        ? (spot.quoteAtoms > oracleNotionalAtoms ? spot.quoteAtoms - oracleNotionalAtoms : 0n)
        : (oracleNotionalAtoms > spot.quoteAtoms ? oracleNotionalAtoms - spot.quoteAtoms : 0n);
      const estimatedSpotFee = ceilDiv((increasing ? spot.quoteAtoms : oracleNotionalAtoms) * BigInt(input.spotPoolFee), UNISWAP_FEE_DENOMINATOR);
      const spotFee = estimatedSpotFee < conversionDeviation ? estimatedSpotFee : conversionDeviation;
      const conversionImpact = conversionDeviation - spotFee;
      const hedgeNotionalAtoms = ceilDiv(perp.notionalWad, perp.collateralScale);
      const hedgeDeviation = perp.notionalWad > oracleNotionalWad
        ? ceilDiv(perp.notionalWad - oracleNotionalWad, perp.collateralScale)
        : ceilDiv(oracleNotionalWad - perp.notionalWad, perp.collateralScale);
      const perpFee = ceilDiv(perp.feeWad, perp.collateralScale);
      const requiredMarginWad = increasing
        ? ceilDiv(perp.notionalWad * perp.initialMarginBps, BPS) + perp.feeWad : 0n;
      const requiredMarginAtoms = increasing ? ceilDiv(requiredMarginWad, perp.collateralScale) : 0n;
      const protocolFee = ceilDiv(hedgeNotionalAtoms * BigInt(input.protocolFeeBps), BPS);
      const solverFee = ceilDiv(hedgeNotionalAtoms * BigInt(input.solverFeeBps), BPS);
      const totalCost = conversionImpact + spotFee + hedgeDeviation + perpFee
        + protocolFee + solverFee + input.networkFeeQuoteAtoms;
      const postHealthBps = input.minimumPostHealthFactor * BPS / WAD;
      const spotPrice = exactPrice({
        baseAsset: input.collateralAsset,
        quoteAsset: input.quoteAsset,
        quoteAtoms: spot.priceQuoteAtoms,
        baseAtoms: spot.priceBaseAtoms,
        roundingDirection: increasing ? 'CEIL' : 'FLOOR',
      });
      const hedgeNumerator = perp.fillPriceWad * quoteScale;
      const hedgeDenominator = WAD * baseScale;
      const hedgeDivisor = gcd(hedgeNumerator, hedgeDenominator);
      const legEconomics: readonly StrategyLegEconomicsInput[] = Object.freeze([
        Object.freeze({
          legId: swap.legId,
          quantity: assetAmount(input.collateralAsset, quantity),
          executionPrice: spotPrice,
          grossNotional: assetAmount(input.quoteAsset, increasing ? spot.quoteAtoms : oracleNotionalAtoms),
          marginDelta: assetAmount(input.quoteAsset, 0n),
          venueFee: assetAmount(input.quoteAsset, spotFee),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
        Object.freeze({
          legId: transfer.legId,
          quantity: assetAmount(input.collateralAsset, quantity),
          grossNotional: assetAmount(input.quoteAsset, oracleNotionalAtoms),
          marginDelta: assetAmount(input.quoteAsset, 0n),
          venueFee: assetAmount(input.quoteAsset, 0n),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
        Object.freeze({
          legId: hedge.legId,
          quantity: assetAmount(input.collateralAsset, quantity),
          executionPrice: exactPrice({
            baseAsset: input.collateralAsset,
            quoteAsset: input.quoteAsset,
            quoteAtoms: hedgeNumerator / hedgeDivisor,
            baseAtoms: hedgeDenominator / hedgeDivisor,
            roundingDirection: increasing ? 'FLOOR' : 'CEIL',
          }),
          grossNotional: assetAmount(input.quoteAsset, hedgeNotionalAtoms),
          marginDelta: assetAmount(input.quoteAsset, requiredMarginAtoms),
          venueFee: assetAmount(input.quoteAsset, perpFee),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
      ]);
      const validUntilValue = [observedAt + input.quoteTtlSeconds, order.expiryValue, perp.expiry - 1n]
        .reduce((minimum, value) => value < minimum ? value : minimum);
      const routeExpiryValue = [observedAt + input.routeTtlSeconds, validUntilValue]
        .reduce((minimum, value) => value < minimum ? value : minimum);
      requireCondition(routeExpiryValue > observedAt && validUntilValue > observedAt, 'no executable validity remains');
      const quoteNonce = input.nonceSource.nextNonce();
      requireCondition(quoteNonce > 0n, 'quote nonce is invalid');
      const serviceCharges = Object.freeze([
        ...(protocolFee === 0n ? [] : [{ category: 'PROTOCOL' as const, amount: assetAmount(input.quoteAsset, protocolFee) }]),
        ...(solverFee === 0n ? [] : [{ category: 'SOLVER' as const, amount: assetAmount(input.quoteAsset, solverFee) }]),
      ]);
      const venueFee = spotFee + perpFee;
      return Object.freeze({
        quoteMode: 'EXECUTION_COMMITMENT' as const,
        economics: Object.freeze({
          templateId: STRATEGY_TEMPLATE_ID.COLLATERAL_CONVERSION_HEDGE,
          values: Object.freeze({
            conversionOutputAtoms: increasing ? quantity : spot.quoteAtoms,
            hedgeNotionalAtoms,
            conversionCostAtoms: conversionImpact + spotFee,
            hedgeCostAtoms: hedgeDeviation + perpFee,
            postMarginHealthBps: postHealthBps,
            maximumInterimDeltaAtoms: quantity,
          }),
        }),
        legEconomics,
        netPackageOutcomeAtoms: -totalCost,
        serviceCharges,
        passThroughCosts: Object.freeze([
          ...(venueFee === 0n ? [] : [{ category: 'VENUE' as const, amount: assetAmount(input.quoteAsset, venueFee) }]),
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
