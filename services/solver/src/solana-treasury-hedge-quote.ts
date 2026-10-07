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
import type { StoredStrategyPackageOrderDocuments } from './http-strategy-package-provider.js';
import {
  priceTestPerpCloseShort,
  priceTestPerpShort,
  type TestPerpMarketState,
} from './solana-devnet-wire.js';
import type { GeneralizedStrategyPricingPort, GeneralizedStrategyQuoteTerms } from './strategy-quote-service.js';

const BPS = 10_000n;

export interface SolanaTreasuryHedgeLegBinding {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
}

export interface SolanaTreasuryHedgeQuoteState {
  readonly slot: bigint;
  readonly marketAddress: string;
  readonly market: TestPerpMarketState;
  readonly oraclePricePerLot: bigint;
}

export interface SolanaTreasuryHedgePricingInput {
  readonly domain: DomainRef;
  readonly inventoryAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly inventoryMint: string;
  readonly quoteMint: string;
  readonly marketAddress: string;
  readonly oracleAddress: string;
  readonly inventory: SolanaTreasuryHedgeLegBinding;
  readonly hedge: SolanaTreasuryHedgeLegBinding;
  readonly protocolFeeBps: number;
  readonly solverFeeBps: number;
  readonly networkFeeQuoteAtoms: bigint;
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Uint8Array | string;
  readonly routeTtlSlots: bigint;
  readonly quoteTtlSlots: bigint;
  readonly maximumStateAdvanceSlots: bigint;
  readonly readState: () => Promise<SolanaTreasuryHedgeQuoteState>;
  readonly nonceSource: Readonly<{ nextNonce(): bigint }>;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Solana treasury hedge quote refused: ${message}`);
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

function matchLeg(
  documents: StoredStrategyPackageOrderDocuments,
  role: 'inventory-position' | 'treasury-hedge',
  binding: SolanaTreasuryHedgeLegBinding,
) {
  const matches = documents.graph.legs.filter((leg) => leg.legId === role);
  requireCondition(matches.length === 1, `${role} graph leg is missing`);
  const leg = matches[0]!;
  requireCondition(sameAdapter(leg.adapter, binding.adapter) && sameManifest(leg.venue, binding.venue)
    && sameManifest(leg.market, binding.market), `${role} identity differs from the reviewed binding`);
  return leg;
}

function serviceCharge(category: 'PROTOCOL' | 'SOLVER', asset: AssetRef, atoms: bigint) {
  return Object.freeze({ category, amount: assetAmount(asset, atoms) });
}

function validateConfiguration(input: SolanaTreasuryHedgePricingInput): void {
  requireCondition(input.domain.domainId === 'svm:devnet', 'domain must be Solana Devnet');
  requireCondition(input.inventoryAsset.assetId === input.inventoryMint
    && input.quoteAsset.assetId === input.quoteMint && !sameAsset(input.inventoryAsset, input.quoteAsset),
  'asset and mint identities are invalid');
  requireCondition(Number.isInteger(input.protocolFeeBps) && input.protocolFeeBps >= 0 && input.protocolFeeBps < 1_000
    && Number.isInteger(input.solverFeeBps) && input.solverFeeBps >= 0 && input.solverFeeBps < 1_000,
  'service fee rates are invalid');
  requireCondition(input.networkFeeQuoteAtoms >= 0n && input.feePolicyVersion > 0
    && input.routeTtlSlots > 0n && input.quoteTtlSlots >= input.routeTtlSlots
    && input.maximumStateAdvanceSlots >= 0n,
  'fee policy or validity is invalid');
  requireCondition(typeof input.readState === 'function' && typeof input.nonceSource?.nextNonce === 'function',
    'state reader or nonce source is invalid');
  manifestHash(input.feePolicyManifestHash, 'solanaTreasuryHedge.feePolicyManifestHash');
}

export function createSolanaTreasuryHedgeGeneralizedPricing(
  input: SolanaTreasuryHedgePricingInput,
): GeneralizedStrategyPricingPort {
  validateConfiguration(input);
  return Object.freeze({
    async quote({ documents, currentTime }: Readonly<{
      documents: StoredStrategyPackageOrderDocuments;
      currentTime: PackageGraphCompileContext['currentTime'];
    }>): Promise<GeneralizedStrategyQuoteTerms> {
      const { order, graph } = documents;
      requireCondition(order.environment === 'devnet' && graph.environment === 'devnet'
        && order.templateId === STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE
        && graph.templateId === STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE
        && order.settlementClass === 'ATOMIC_POSTCONDITION' && graph.settlementClass === 'ATOMIC_POSTCONDITION'
        && order.expiryUnit === 'SOLANA_SLOT' && graph.expiryUnit === 'SOLANA_SLOT',
      'package is not a Devnet atomic Solana treasury hedge');
      requireCondition(order.lifecycleAction === 'ENTRY' || order.lifecycleAction === 'EXIT'
        || order.lifecycleAction === 'EMERGENCY_UNWIND', 'lifecycle action is unsupported');
      requireCondition(graph.legs.length === 2 && graph.legs.every((leg) => sameDomain(leg.domain, input.domain)),
        'package domain is unsupported');
      requireCondition(sameAsset(order.economicQuantity.asset, input.inventoryAsset)
        && sameAsset(order.quoteAsset, input.quoteAsset), 'package assets are unsupported');
      requireCondition(currentTime.unit === 'SOLANA_SLOT', 'quote clock is invalid');
      const inventoryLeg = matchLeg(documents, 'inventory-position', input.inventory);
      const hedgeLeg = matchLeg(documents, 'treasury-hedge', input.hedge);
      const opening = order.lifecycleAction === 'ENTRY';
      const quantity = order.economicQuantity.atoms;
      requireCondition(quantity > 0n && quantity === inventoryLeg.quantityAtoms && quantity === hedgeLeg.quantityAtoms,
        'leg quantities differ from the package quantity');
      requireCondition(inventoryLeg.legFamily === 'INVENTORY_TRANSFER' && inventoryLeg.side === 'NONE'
        && hedgeLeg.legFamily === (opening ? 'PERP_OPEN' : 'PERP_CLOSE')
        && hedgeLeg.side === (opening ? 'SELL' : 'BUY'), 'legs do not match the lifecycle action');
      const state = await input.readState();
      requireCondition(state.slot >= currentTime.value
        && state.slot - currentTime.value <= input.maximumStateAdvanceSlots, 'quote clock is stale or from another head');
      requireCondition(state.marketAddress === input.marketAddress && state.market.oracle === input.oracleAddress
        && state.market.collateralMint === input.quoteMint, 'market identity differs from the reviewed binding');
      requireCondition(state.market.baseDecimals === input.inventoryAsset.decimals
        && state.market.collateralDecimals === input.quoteAsset.decimals
        && state.market.initialMarginBps > state.market.maintenanceMarginBps
        && state.market.initialMarginBps < Number(BPS), 'market units or margin parameters are invalid');
      requireCondition(!opening || !state.market.pauseOpens, 'market opens are paused');
      const limitPrice = hedgeLeg.limitPrice;
      requireCondition(limitPrice !== undefined && sameAsset(limitPrice.baseAsset, input.inventoryAsset)
        && sameAsset(limitPrice.quoteAsset, input.quoteAsset), 'hedge limit price is invalid');
      const entryPricing = opening
        ? priceTestPerpShort(state.market, state.oraclePricePerLot, quantity)
        : undefined;
      const exitPricing = opening
        ? undefined
        : priceTestPerpCloseShort(state.market, state.oraclePricePerLot, quantity);
      const priced = entryPricing ?? exitPricing!;
      const executableAgainstLimit = priced.fillPricePerLot * limitPrice.baseAtoms;
      const signedLimitAgainstLot = limitPrice.quoteAtoms * state.market.baseLotAtoms;
      requireCondition(opening ? executableAgainstLimit >= signedLimitAgainstLot
        : executableAgainstLimit <= signedLimitAgainstLot, 'executable hedge price violates the signed limit');
      const oracleNotionalAtoms = state.oraclePricePerLot * priced.baseLots;
      const adverseExecutionAtoms = priced.notionalAtoms >= oracleNotionalAtoms
        ? priced.notionalAtoms - oracleNotionalAtoms
        : oracleNotionalAtoms - priced.notionalAtoms;
      const initialMarginAtoms = entryPricing?.initialMarginAtoms ?? 0n;
      const requiredMarginAtoms = opening ? initialMarginAtoms + priced.feeAtoms : 0n;
      const protocolFee = ceilDiv(priced.notionalAtoms * BigInt(input.protocolFeeBps), BPS);
      const solverFee = ceilDiv(priced.notionalAtoms * BigInt(input.solverFeeBps), BPS);
      const totalCost = adverseExecutionAtoms + priced.feeAtoms + protocolFee + solverFee + input.networkFeeQuoteAtoms;
      const liquidationDistanceBps = opening
        ? BigInt(state.market.initialMarginBps - state.market.maintenanceMarginBps)
        : 0n;
      const priceDivisor = gcd(priced.fillPricePerLot, state.market.baseLotAtoms);
      const legEconomics: readonly StrategyLegEconomicsInput[] = Object.freeze([
        Object.freeze({
          legId: inventoryLeg.legId,
          quantity: assetAmount(input.inventoryAsset, quantity),
          grossNotional: assetAmount(input.quoteAsset, oracleNotionalAtoms),
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
            quoteAtoms: priced.fillPricePerLot / priceDivisor,
            baseAtoms: state.market.baseLotAtoms / priceDivisor,
            roundingDirection: opening ? 'FLOOR' : 'CEIL',
          }),
          grossNotional: assetAmount(input.quoteAsset, priced.notionalAtoms),
          marginDelta: assetAmount(input.quoteAsset, requiredMarginAtoms),
          venueFee: assetAmount(input.quoteAsset, priced.feeAtoms),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
      ]);
      const validUntilValue = state.slot + input.quoteTtlSlots < order.expiryValue
        ? state.slot + input.quoteTtlSlots
        : order.expiryValue;
      const routeExpiryValue = state.slot + input.routeTtlSlots < validUntilValue
        ? state.slot + input.routeTtlSlots
        : validUntilValue;
      requireCondition(routeExpiryValue > state.slot && validUntilValue > state.slot, 'no executable validity remains');
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
          ...(priced.feeAtoms === 0n ? [] : [{ category: 'VENUE' as const, amount: assetAmount(input.quoteAsset, priced.feeAtoms) }]),
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
