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
import { getAddress, type Abi } from 'viem';
import {
  readEvmCollateralConversionSpotSnapshot,
  type EvmCollateralConversionPricingInput,
} from './evm-collateral-conversion-quote.js';
import type { StoredStrategyPackageOrderDocuments } from './http-strategy-package-provider.js';
import type {
  EvmOptionSpreadContractIdentity,
  EvmOptionSpreadQuoteNonceSource,
  EvmOptionSpreadReadPort,
} from './evm-option-spread-quote.js';
import {
  readEvmTreasuryHedgeMarketSnapshot,
  type EvmTreasuryHedgePricingInput,
} from './evm-treasury-hedge-quote.js';
import type { GeneralizedStrategyPricingPort, GeneralizedStrategyQuoteTerms } from './strategy-quote-service.js';

const BPS = 10_000n;
const PPM = 1_000_000n;
const WAD = 10n ** 18n;
const YEAR_SECONDS = 31_536_000n;
const UNISWAP_FEE_DENOMINATOR = 1_000_000n;
const FUNDING_ABI = [{
  type: 'function', name: 'fundingRatePerSecond', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'int256' }],
}] as const satisfies Abi;

export interface EvmReverseBasisLegBinding {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
}

export interface EvmReverseBasisPricingInput {
  readonly chainId: bigint;
  readonly domain: DomainRef;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly baseToken: EvmOptionSpreadContractIdentity;
  readonly quoteToken: EvmOptionSpreadContractIdentity;
  readonly spotFactory: EvmOptionSpreadContractIdentity;
  readonly spotPool: EvmOptionSpreadContractIdentity;
  readonly spotQuoter: EvmOptionSpreadContractIdentity;
  readonly spotPoolFee: number;
  readonly lendingPool: EvmOptionSpreadContractIdentity;
  readonly oracle: EvmOptionSpreadContractIdentity;
  readonly perpetualMarket: EvmOptionSpreadContractIdentity;
  readonly lending: EvmReverseBasisLegBinding;
  readonly spot: EvmReverseBasisLegBinding;
  readonly hedge: EvmReverseBasisLegBinding;
  readonly minimumPostHealthFactor: bigint;
  readonly borrowCollateralRatioBps: bigint;
  readonly annualBorrowRatePpm: bigint;
  readonly holdingDurationSeconds: bigint;
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
  if (!condition) throw new Error(`EVM reverse basis quote refused: ${message}`);
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

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  requireCondition(numerator >= 0n && denominator > 0n, 'division inputs are invalid');
  return (numerator + denominator - 1n) / denominator;
}

function signedWadToAtoms(value: bigint, scale: bigint): bigint {
  requireCondition(scale > 0n, 'collateral scale is invalid');
  return value >= 0n ? value / scale : -ceilDiv(-value, scale);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function matchLeg(
  documents: StoredStrategyPackageOrderDocuments,
  role: 'base-borrow' | 'spot-sale' | 'perp-purchase',
  binding: EvmReverseBasisLegBinding,
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

function validateConfiguration(input: EvmReverseBasisPricingInput): void {
  requireCondition(input.chainId > 0n && input.domain.domainId === `eip155:${input.chainId}`, 'chain and domain differ');
  requireCondition(!sameAsset(input.baseAsset, input.quoteAsset)
    && input.baseAsset.decimals <= 18 && input.quoteAsset.decimals <= 18, 'assets are invalid');
  requireCondition(Number.isInteger(input.spotPoolFee) && input.spotPoolFee > 0 && input.spotPoolFee < 1_000_000,
    'spot pool fee is invalid');
  requireCondition(input.minimumPostHealthFactor > 0n && input.borrowCollateralRatioBps >= BPS
    && input.borrowCollateralRatioBps <= 100_000n && input.annualBorrowRatePpm <= PPM
    && input.holdingDurationSeconds > 0n && input.holdingDurationSeconds <= YEAR_SECONDS,
  'borrow risk or horizon is invalid');
  requireCondition(Number.isInteger(input.protocolFeeBps) && input.protocolFeeBps >= 0 && input.protocolFeeBps < 1_000
    && Number.isInteger(input.solverFeeBps) && input.solverFeeBps >= 0 && input.solverFeeBps < 1_000,
  'service fee rates are invalid');
  requireCondition(input.networkFeeQuoteAtoms >= 0n && input.feePolicyVersion > 0
    && input.routeTtlSeconds > 0n && input.quoteTtlSeconds >= input.routeTtlSeconds,
  'fee policy or validity is invalid');
  manifestHash(input.feePolicyManifestHash, 'evmReverseBasis.feePolicyManifestHash');
}

function collateralPricing(input: EvmReverseBasisPricingInput): EvmCollateralConversionPricingInput {
  return Object.freeze({
    chainId: input.chainId,
    domain: input.domain,
    collateralAsset: input.baseAsset,
    quoteAsset: input.quoteAsset,
    collateralToken: input.baseToken,
    quoteToken: input.quoteToken,
    spotFactory: input.spotFactory,
    spotPool: input.spotPool,
    spotQuoter: input.spotQuoter,
    spotPoolFee: input.spotPoolFee,
    lendingPool: input.lendingPool,
    oracle: input.oracle,
    perpetualMarket: input.perpetualMarket,
    swap: input.spot,
    collateralTransfer: input.lending,
    hedge: input.hedge,
    minimumPostHealthFactor: input.minimumPostHealthFactor,
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
}

function perpPricing(input: EvmReverseBasisPricingInput): EvmTreasuryHedgePricingInput {
  return Object.freeze({
    chainId: input.chainId,
    domain: input.domain,
    inventoryAsset: input.baseAsset,
    quoteAsset: input.quoteAsset,
    inventoryToken: input.baseToken,
    quoteToken: input.quoteToken,
    oracle: input.oracle,
    market: input.perpetualMarket,
    inventory: input.spot,
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
}

export function createEvmReverseBasisGeneralizedPricing(
  input: EvmReverseBasisPricingInput,
): GeneralizedStrategyPricingPort {
  validateConfiguration(input);
  const spotInput = collateralPricing(input);
  const derivativeInput = perpPricing(input);
  return Object.freeze({
    async quote({ documents, currentTime }: Readonly<{
      documents: StoredStrategyPackageOrderDocuments;
      currentTime: PackageGraphCompileContext['currentTime'];
    }>): Promise<GeneralizedStrategyQuoteTerms> {
      const { order, graph } = documents;
      requireCondition(order.environment === 'testnet' && graph.environment === 'testnet'
        && order.templateId === STRATEGY_TEMPLATE_ID.REVERSE_CASH_AND_CARRY
        && graph.templateId === STRATEGY_TEMPLATE_ID.REVERSE_CASH_AND_CARRY
        && order.settlementClass === 'ATOMIC_POSTCONDITION' && graph.settlementClass === 'ATOMIC_POSTCONDITION'
        && order.expiryUnit === 'EVM_UNIX_SECONDS' && graph.expiryUnit === 'EVM_UNIX_SECONDS',
      'package is not a testnet atomic EVM reverse basis strategy');
      requireCondition(order.lifecycleAction === 'ENTRY' || order.lifecycleAction === 'EXIT'
        || order.lifecycleAction === 'EMERGENCY_UNWIND', 'lifecycle action is unsupported');
      requireCondition(graph.legs.length === 3 && graph.legs.every((leg) => sameDomain(leg.domain, input.domain))
        && sameAsset(order.economicQuantity.asset, input.baseAsset)
        && sameAsset(order.quoteAsset, input.quoteAsset), 'package domain or assets are unsupported');
      requireCondition(currentTime.unit === 'EVM_UNIX_SECONDS', 'quote clock is invalid');
      const lending = matchLeg(documents, 'base-borrow', input.lending);
      const spot = matchLeg(documents, 'spot-sale', input.spot);
      const hedge = matchLeg(documents, 'perp-purchase', input.hedge);
      const opening = order.lifecycleAction === 'ENTRY';
      const quantity = order.economicQuantity.atoms;
      requireCondition(quantity > 0n && [lending, spot, hedge].every((leg) => leg.quantityAtoms === quantity),
        'leg quantities differ from the package quantity');
      requireCondition(lending.legFamily === (opening ? 'BORROW' : 'REPAY') && lending.side === 'NONE'
        && spot.legFamily === 'SPOT_SWAP' && spot.side === (opening ? 'SELL' : 'BUY')
        && hedge.legFamily === (opening ? 'PERP_OPEN' : 'PERP_CLOSE')
        && hedge.side === (opening ? 'BUY' : 'SELL'), 'legs do not match the lifecycle action');
      const [chainId, observedAt, spotSnapshot, derivative, fundingRateValue] = await Promise.all([
        input.chain.chainId(),
        input.chain.latestBlockTimestamp(),
        readEvmCollateralConversionSpotSnapshot(spotInput, quantity, !opening),
        readEvmTreasuryHedgeMarketSnapshot(derivativeInput, opening ? quantity : -quantity),
        input.chain.readContract({
          address: getAddress(input.perpetualMarket.address),
          abi: FUNDING_ABI,
          functionName: 'fundingRatePerSecond',
        }),
      ]);
      requireCondition(chainId === input.chainId && observedAt >= currentTime.value && observedAt - currentTime.value <= 30n,
        'RPC identity or quote clock is invalid');
      requireCondition(observedAt < derivative.expiry && typeof fundingRateValue === 'bigint',
        'perpetual market expiry or funding state is invalid');
      const spotLimit = spot.limitPrice;
      const hedgeLimit = hedge.limitPrice;
      requireCondition(spotLimit !== undefined && hedgeLimit !== undefined, 'signed price limits are missing');
      const spotBound = quoteBound(quantity, spotLimit.quoteAtoms, spotLimit.baseAtoms, !opening);
      requireCondition(opening ? spotSnapshot.quoteAtoms >= spotBound : spotSnapshot.quoteAtoms <= spotBound,
        'executable spot price violates the signed limit');
      const baseScale = 10n ** BigInt(input.baseAsset.decimals);
      const quoteScale = 10n ** BigInt(input.quoteAsset.decimals);
      const hedgeAtLimitScale = derivative.fillPriceWad * hedgeLimit.baseAtoms * quoteScale;
      const signedHedgeAtWadScale = hedgeLimit.quoteAtoms * baseScale * WAD;
      requireCondition(opening ? hedgeAtLimitScale <= signedHedgeAtWadScale : hedgeAtLimitScale >= signedHedgeAtWadScale,
        'executable hedge price violates the signed limit');
      const oracleNotionalWad = quantity * derivative.oraclePriceWad / baseScale;
      const oracleNotionalAtoms = ceilDiv(oracleNotionalWad, derivative.collateralScale);
      const spotDeviation = opening
        ? (oracleNotionalAtoms > spotSnapshot.quoteAtoms ? oracleNotionalAtoms - spotSnapshot.quoteAtoms : 0n)
        : (spotSnapshot.quoteAtoms > oracleNotionalAtoms ? spotSnapshot.quoteAtoms - oracleNotionalAtoms : 0n);
      const estimatedSpotFee = ceilDiv((opening ? oracleNotionalAtoms : spotSnapshot.quoteAtoms)
        * BigInt(input.spotPoolFee), UNISWAP_FEE_DENOMINATOR);
      const spotFee = estimatedSpotFee < spotDeviation ? estimatedSpotFee : spotDeviation;
      const hedgeNotionalAtoms = ceilDiv(derivative.notionalWad, derivative.collateralScale);
      const perpFee = ceilDiv(derivative.feeWad, derivative.collateralScale);
      const requiredMarginWad = opening
        ? ceilDiv(derivative.notionalWad * derivative.initialMarginBps, BPS) + derivative.feeWad
        : 0n;
      const requiredMarginAtoms = opening ? ceilDiv(requiredMarginWad, derivative.collateralScale) : 0n;
      const projectedBorrowCost = opening
        ? ceilDiv(oracleNotionalAtoms * input.annualBorrowRatePpm * input.holdingDurationSeconds,
          PPM * YEAR_SECONDS)
        : 0n;
      const expectedFundingWad = opening
        ? -quantity * fundingRateValue * input.holdingDurationSeconds / WAD
        : 0n;
      const expectedFundingAtoms = signedWadToAtoms(expectedFundingWad, derivative.collateralScale);
      const protocolFee = ceilDiv(hedgeNotionalAtoms * BigInt(input.protocolFeeBps), BPS);
      const solverFee = ceilDiv(hedgeNotionalAtoms * BigInt(input.solverFeeBps), BPS);
      const totalFees = spotFee + perpFee + protocolFee + solverFee + input.networkFeeQuoteAtoms;
      const borrowCollateralAtoms = ceilDiv(oracleNotionalAtoms * input.borrowCollateralRatioBps, BPS);
      const capitalRequiredAtoms = borrowCollateralAtoms + requiredMarginAtoms;
      const spotPrice = exactPrice({
        baseAsset: input.baseAsset,
        quoteAsset: input.quoteAsset,
        quoteAtoms: spotSnapshot.priceQuoteAtoms,
        baseAtoms: spotSnapshot.priceBaseAtoms,
        roundingDirection: opening ? 'FLOOR' : 'CEIL',
      });
      const hedgeNumerator = derivative.fillPriceWad * quoteScale;
      const hedgeDenominator = WAD * baseScale;
      const hedgeDivisor = gcd(hedgeNumerator, hedgeDenominator);
      const legEconomics: readonly StrategyLegEconomicsInput[] = Object.freeze([
        Object.freeze({
          legId: lending.legId,
          quantity: assetAmount(input.baseAsset, quantity),
          grossNotional: assetAmount(input.quoteAsset, oracleNotionalAtoms),
          marginDelta: assetAmount(input.quoteAsset, 0n),
          venueFee: assetAmount(input.quoteAsset, 0n),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
        Object.freeze({
          legId: spot.legId,
          quantity: assetAmount(input.baseAsset, quantity),
          executionPrice: spotPrice,
          grossNotional: assetAmount(input.quoteAsset, spotSnapshot.quoteAtoms),
          marginDelta: assetAmount(input.quoteAsset, 0n),
          venueFee: assetAmount(input.quoteAsset, spotFee),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
        Object.freeze({
          legId: hedge.legId,
          quantity: assetAmount(input.baseAsset, quantity),
          executionPrice: exactPrice({
            baseAsset: input.baseAsset,
            quoteAsset: input.quoteAsset,
            quoteAtoms: hedgeNumerator / hedgeDivisor,
            baseAtoms: hedgeDenominator / hedgeDivisor,
            roundingDirection: opening ? 'FLOOR' : 'CEIL',
          }),
          grossNotional: assetAmount(input.quoteAsset, hedgeNotionalAtoms),
          marginDelta: assetAmount(input.quoteAsset, requiredMarginAtoms),
          venueFee: assetAmount(input.quoteAsset, perpFee),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
      ]);
      const validUntilValue = [observedAt + input.quoteTtlSeconds, order.expiryValue, derivative.expiry - 1n]
        .reduce((minimum, value) => value < minimum ? value : minimum);
      const routeExpiryValue = [observedAt + input.routeTtlSeconds, validUntilValue]
        .reduce((minimum, value) => value < minimum ? value : minimum);
      requireCondition(routeExpiryValue > observedAt && validUntilValue > observedAt, 'no executable validity remains');
      const quoteNonce = input.nonceSource.nextNonce();
      requireCondition(quoteNonce > 0n, 'quote nonce is invalid');
      const basis = spotSnapshot.quoteAtoms - hedgeNotionalAtoms;
      const netOutcome = basis + expectedFundingAtoms - projectedBorrowCost - totalFees;
      const exitBasisBps = basis * BPS / spotSnapshot.quoteAtoms;
      return Object.freeze({
        quoteMode: 'EXECUTION_COMMITMENT' as const,
        economics: Object.freeze({
          templateId: STRATEGY_TEMPLATE_ID.REVERSE_CASH_AND_CARRY,
          spotNotionalAtoms: spotSnapshot.quoteAtoms,
          derivativeNotionalAtoms: hedgeNotionalAtoms,
          expectedFundingAtoms,
          borrowCostAtoms: projectedBorrowCost,
          totalFeesAtoms: totalFees,
          capitalRequiredAtoms,
          holdingDurationMs: input.holdingDurationSeconds * 1_000n,
          exitBasisBps,
        }),
        legEconomics,
        netPackageOutcomeAtoms: netOutcome,
        serviceCharges: Object.freeze([
          ...(protocolFee === 0n ? [] : [{ category: 'PROTOCOL' as const, amount: assetAmount(input.quoteAsset, protocolFee) }]),
          ...(solverFee === 0n ? [] : [{ category: 'SOLVER' as const, amount: assetAmount(input.quoteAsset, solverFee) }]),
        ]),
        passThroughCosts: Object.freeze([
          ...(spotFee + perpFee === 0n ? [] : [{ category: 'VENUE' as const, amount: assetAmount(input.quoteAsset, spotFee + perpFee) }]),
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
