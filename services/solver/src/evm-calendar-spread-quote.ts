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
const FUTURE_ABI = [{
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
  type: 'function', name: 'insuranceWad', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }],
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

export type EvmCalendarSpreadRole = 'near-future' | 'far-future';

export interface EvmCalendarSpreadLegBinding {
  readonly role: EvmCalendarSpreadRole;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly contract: EvmOptionSpreadContractIdentity;
}

export interface EvmCalendarFutureSnapshot {
  readonly role: EvmCalendarSpreadRole;
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
  readonly insuranceWad: bigint;
}

export interface EvmCalendarSpreadPricingInput {
  readonly chainId: bigint;
  readonly domain: DomainRef;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly baseToken: EvmOptionSpreadContractIdentity;
  readonly quoteToken: EvmOptionSpreadContractIdentity;
  readonly oracle: EvmOptionSpreadContractIdentity;
  readonly markets: readonly [EvmCalendarSpreadLegBinding, EvmCalendarSpreadLegBinding];
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
  if (!condition) throw new Error(`EVM calendar spread quote refused: ${message}`);
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

function tuple(value: unknown, context: string): readonly unknown[] {
  requireCondition(Array.isArray(value) && value.length >= 4, `${context} is invalid`);
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

function role<T extends { readonly role: EvmCalendarSpreadRole }>(
  values: readonly T[],
  expected: EvmCalendarSpreadRole,
): T {
  const matches = values.filter((value) => value.role === expected);
  requireCondition(matches.length === 1, `${expected} binding must appear exactly once`);
  return matches[0]!;
}

async function assertCode(
  chain: EvmOptionSpreadReadPort,
  identity: EvmOptionSpreadContractIdentity,
  context: string,
): Promise<void> {
  const actual = await chain.codeHash(getAddress(identity.address));
  requireCondition(actual !== undefined && checkedHash(actual, context) === checkedHash(identity.expectedCodeHash, context), `${context} code changed`);
}

export async function readEvmCalendarFutureSnapshot(
  input: EvmCalendarSpreadPricingInput,
  binding: EvmCalendarSpreadLegBinding,
  sizeDelta: bigint,
): Promise<EvmCalendarFutureSnapshot> {
  requireCondition(sizeDelta !== 0n && sizeDelta >= -(1n << 127n) && sizeDelta < (1n << 127n), `${binding.role} size is outside int128`);
  const market = getAddress(binding.contract.address);
  const read = (functionName: string, args?: readonly unknown[]) => input.chain.readContract({
    address: market,
    abi: FUTURE_ABI,
    functionName,
    ...(args === undefined ? {} : { args }),
  });
  const [collateralValue, oracleValue, expiryValue, takerFeeValue, initialMarginValue,
    maintenanceMarginValue, collateralScaleValue, oraclePriceValue, fundingIndexValue, insuranceValue,
    previewValue] = await Promise.all([
    read('collateral'),
    read('oracle'),
    read('expiry'),
    read('takerFeeBps'),
    read('initialMarginBps'),
    read('maintenanceMarginBps'),
    read('collateralScale'),
    read('oraclePriceWad'),
    read('currentFundingIndex'),
    read('insuranceWad'),
    read('previewOpen', [sizeDelta, 0n]),
    assertCode(input.chain, binding.contract, `${binding.role} market`),
  ]);
  requireCondition(getAddress(String(collateralValue)) === getAddress(input.quoteToken.address)
    && getAddress(String(oracleValue)) === getAddress(input.oracle.address), `${binding.role} collateral or oracle changed`);
  const preview = tuple(previewValue, `${binding.role} preview`);
  const expiry = checkedBigInt(expiryValue, `${binding.role} expiry`);
  const oraclePriceWad = checkedBigInt(oraclePriceValue, `${binding.role} oracle price`);
  const fillPriceWad = checkedBigInt(preview[0], `${binding.role} fill price`);
  const notionalWad = checkedBigInt(preview[1], `${binding.role} notional`);
  const feeWad = checkedBigInt(preview[2], `${binding.role} venue fee`);
  const collateralScale = checkedBigInt(collateralScaleValue, `${binding.role} collateral scale`);
  const takerFeeBps = checkedBigInt(takerFeeValue, `${binding.role} taker fee`);
  const initialMarginBps = checkedBigInt(initialMarginValue, `${binding.role} initial margin`);
  const maintenanceMarginBps = checkedBigInt(maintenanceMarginValue, `${binding.role} maintenance margin`);
  const insuranceWad = checkedBigInt(insuranceValue, `${binding.role} insurance`);
  requireCondition(typeof fundingIndexValue === 'bigint', `${binding.role} funding index is invalid`);
  requireCondition(expiry > 0n && oraclePriceWad > 0n && fillPriceWad > 0n && notionalWad > 0n
    && collateralScale > 0n && takerFeeBps < BPS && initialMarginBps > maintenanceMarginBps,
  `${binding.role} economics are invalid`);
  return Object.freeze({
    role: binding.role,
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
    insuranceWad,
  });
}

function validateConfiguration(input: EvmCalendarSpreadPricingInput): void {
  requireCondition(input.chainId > 0n && input.domain.domainId === `eip155:${input.chainId}`, 'chain and domain differ');
  requireCondition(input.baseAsset.decimals === 18 && input.quoteAsset.decimals <= 18
    && !sameAsset(input.baseAsset, input.quoteAsset), 'assets are invalid');
  requireCondition(Number.isInteger(input.protocolFeeBps) && input.protocolFeeBps >= 0 && input.protocolFeeBps < 1_000
    && Number.isInteger(input.solverFeeBps) && input.solverFeeBps >= 0 && input.solverFeeBps < 1_000,
  'service fee rates are invalid');
  requireCondition(input.networkFeeQuoteAtoms >= 0n && input.feePolicyVersion > 0
    && input.routeTtlSeconds > 0n && input.quoteTtlSeconds >= input.routeTtlSeconds,
  'fee policy or validity is invalid');
  manifestHash(input.feePolicyManifestHash, 'evmCalendarSpread.feePolicyManifestHash');
  checkedHash(input.baseToken.expectedCodeHash, 'base token');
  checkedHash(input.quoteToken.expectedCodeHash, 'quote token');
  checkedHash(input.oracle.expectedCodeHash, 'oracle');
  const near = role(input.markets, 'near-future');
  const far = role(input.markets, 'far-future');
  checkedHash(near.contract.expectedCodeHash, 'near future market');
  checkedHash(far.contract.expectedCodeHash, 'far future market');
  requireCondition(getAddress(near.contract.address) !== getAddress(far.contract.address), 'future markets must be distinct');
}

function matchLeg(documents: StoredStrategyPackageOrderDocuments, binding: EvmCalendarSpreadLegBinding) {
  const matches = documents.graph.legs.filter((leg) => leg.legId === binding.role);
  requireCondition(matches.length === 1, `${binding.role} graph leg is missing`);
  const leg = matches[0]!;
  requireCondition(sameAdapter(leg.adapter, binding.adapter) && sameManifest(leg.venue, binding.venue)
    && sameManifest(leg.market, binding.market), `${binding.role} identity differs from the reviewed binding`);
  return leg;
}

function executionPrice(input: EvmCalendarSpreadPricingInput, snapshot: EvmCalendarFutureSnapshot, side: 'BUY' | 'SELL') {
  const quoteScale = 10n ** BigInt(input.quoteAsset.decimals);
  const baseScale = 10n ** BigInt(input.baseAsset.decimals);
  const numerator = snapshot.fillPriceWad * quoteScale;
  const denominator = WAD * baseScale;
  const divisor = gcd(numerator, denominator);
  return exactPrice({
    baseAsset: input.baseAsset,
    quoteAsset: input.quoteAsset,
    quoteAtoms: numerator / divisor,
    baseAtoms: denominator / divisor,
    roundingDirection: side === 'BUY' ? 'CEIL' : 'FLOOR',
  });
}

function requireLimit(
  input: EvmCalendarSpreadPricingInput,
  snapshot: EvmCalendarFutureSnapshot,
  leg: ReturnType<typeof matchLeg>,
): void {
  const limit = leg.limitPrice;
  requireCondition(limit !== undefined && sameAsset(limit.baseAsset, input.baseAsset)
    && sameAsset(limit.quoteAsset, input.quoteAsset), `${leg.legId} limit price is invalid`);
  const quoteScale = 10n ** BigInt(input.quoteAsset.decimals);
  const baseScale = 10n ** BigInt(input.baseAsset.decimals);
  const fillAtLimitScale = snapshot.fillPriceWad * limit.baseAtoms * quoteScale;
  const signedLimitAtWadScale = limit.quoteAtoms * baseScale * WAD;
  requireCondition(leg.side === 'BUY' ? fillAtLimitScale <= signedLimitAtWadScale : fillAtLimitScale >= signedLimitAtWadScale,
    `${leg.legId} executable price violates the signed limit`);
}

function serviceCharge(category: 'PROTOCOL' | 'SOLVER', asset: AssetRef, atoms: bigint) {
  return Object.freeze({ category, amount: assetAmount(asset, atoms) });
}

export function createEvmCalendarSpreadGeneralizedPricing(
  input: EvmCalendarSpreadPricingInput,
): GeneralizedStrategyPricingPort {
  validateConfiguration(input);
  return Object.freeze({
    async quote({ documents, currentTime }: Readonly<{
      documents: StoredStrategyPackageOrderDocuments;
      currentTime: PackageGraphCompileContext['currentTime'];
    }>): Promise<GeneralizedStrategyQuoteTerms> {
      const { order, graph } = documents;
      requireCondition(order.environment === 'testnet' && graph.environment === 'testnet'
        && order.templateId === STRATEGY_TEMPLATE_ID.CALENDAR_SPREAD
        && graph.templateId === STRATEGY_TEMPLATE_ID.CALENDAR_SPREAD
        && order.settlementClass === 'ATOMIC_POSTCONDITION' && graph.settlementClass === 'ATOMIC_POSTCONDITION'
        && order.expiryUnit === 'EVM_UNIX_SECONDS' && graph.expiryUnit === 'EVM_UNIX_SECONDS',
      'package is not a testnet atomic EVM calendar spread');
      const opening = order.lifecycleAction === 'ENTRY' || order.lifecycleAction === 'INCREASE';
      const closing = order.lifecycleAction === 'DECREASE'
        || order.lifecycleAction === 'EXIT' || order.lifecycleAction === 'EMERGENCY_UNWIND';
      requireCondition(opening || closing, 'lifecycle action is unsupported');
      requireCondition(graph.legs.length === 2 && graph.legs.every((leg) => sameDomain(leg.domain, input.domain)),
        'package domain is unsupported');
      requireCondition(sameAsset(order.economicQuantity.asset, input.baseAsset)
        && sameAsset(order.quoteAsset, input.quoteAsset), 'package assets are unsupported');
      requireCondition(currentTime.unit === 'EVM_UNIX_SECONDS', 'quote clock is invalid');
      const nearBinding = role(input.markets, 'near-future');
      const farBinding = role(input.markets, 'far-future');
      const nearLeg = matchLeg(documents, nearBinding);
      const farLeg = matchLeg(documents, farBinding);
      const quantity = order.economicQuantity.atoms;
      requireCondition(quantity > 0n && nearLeg.quantityAtoms === quantity && farLeg.quantityAtoms === quantity,
        'future leg quantities differ from the package quantity');
      requireCondition(nearLeg.side !== 'NONE' && farLeg.side !== 'NONE' && nearLeg.side !== farLeg.side,
        'calendar legs must have opposing sides');
      requireCondition(nearLeg.legFamily === (opening ? 'FUTURE_OPEN' : 'FUTURE_CLOSE')
        && farLeg.legFamily === (opening ? 'FUTURE_OPEN' : 'FUTURE_CLOSE'), 'future legs do not match the lifecycle action');
      const nearDelta = nearLeg.side === 'BUY' ? quantity : -quantity;
      const farDelta = farLeg.side === 'BUY' ? quantity : -quantity;
      const [chainId, observedAt, near, far] = await Promise.all([
        input.chain.chainId(),
        input.chain.latestBlockTimestamp(),
        readEvmCalendarFutureSnapshot(input, nearBinding, nearDelta),
        readEvmCalendarFutureSnapshot(input, farBinding, farDelta),
        assertCode(input.chain, input.baseToken, 'base token'),
        assertCode(input.chain, input.quoteToken, 'quote token'),
        assertCode(input.chain, input.oracle, 'oracle'),
      ]);
      requireCondition(chainId === input.chainId, 'RPC chain identity differs from the reviewed chain');
      requireCondition(observedAt >= currentTime.value && observedAt - currentTime.value <= 30n,
        'quote clock is stale or from another head');
      requireCondition(near.expiry < far.expiry && observedAt < near.expiry, 'future maturities are invalid or already expired');
      requireLimit(input, near, nearLeg);
      requireLimit(input, far, farLeg);
      const nearNotionalAtoms = ceilDiv(near.notionalWad, near.collateralScale);
      const farNotionalAtoms = ceilDiv(far.notionalWad, far.collateralScale);
      const nearFeeAtoms = ceilDiv(near.feeWad, near.collateralScale);
      const farFeeAtoms = ceilDiv(far.feeWad, far.collateralScale);
      const nearMarginAtoms = opening
        ? ceilDiv(ceilDiv(near.notionalWad * near.initialMarginBps, BPS) + near.feeWad, near.collateralScale)
        : 0n;
      const farMarginAtoms = opening
        ? ceilDiv(ceilDiv(far.notionalWad * far.initialMarginBps, BPS) + far.feeWad, far.collateralScale)
        : 0n;
      const matchedNotional = nearNotionalAtoms < farNotionalAtoms ? nearNotionalAtoms : farNotionalAtoms;
      const protocolFee = ceilDiv(matchedNotional * BigInt(input.protocolFeeBps), BPS);
      const solverFee = ceilDiv(matchedNotional * BigInt(input.solverFeeBps), BPS);
      const venueFees = nearFeeAtoms + farFeeAtoms;
      const totalCost = venueFees + protocolFee + solverFee + input.networkFeeQuoteAtoms;
      const signedSpread = far.fillPriceWad - near.fillPriceWad;
      const orientedSpread = nearLeg.side === 'BUY' ? signedSpread : -signedSpread;
      const annualizedRollYield = orientedSpread * 1_000_000n * 31_536_000n
        / near.oraclePriceWad / (far.expiry - near.expiry);
      const legEconomics: readonly StrategyLegEconomicsInput[] = Object.freeze([
        Object.freeze({
          legId: nearLeg.legId,
          quantity: assetAmount(input.baseAsset, quantity),
          executionPrice: executionPrice(input, near, nearLeg.side as 'BUY' | 'SELL'),
          grossNotional: assetAmount(input.quoteAsset, nearNotionalAtoms),
          marginDelta: assetAmount(input.quoteAsset, nearMarginAtoms),
          venueFee: assetAmount(input.quoteAsset, nearFeeAtoms),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
        Object.freeze({
          legId: farLeg.legId,
          quantity: assetAmount(input.baseAsset, quantity),
          executionPrice: executionPrice(input, far, farLeg.side as 'BUY' | 'SELL'),
          grossNotional: assetAmount(input.quoteAsset, farNotionalAtoms),
          marginDelta: assetAmount(input.quoteAsset, farMarginAtoms),
          venueFee: assetAmount(input.quoteAsset, farFeeAtoms),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
      ]);
      const validUntilValue = [observedAt + input.quoteTtlSeconds, order.expiryValue, near.expiry - 1n]
        .reduce((minimum, value) => value < minimum ? value : minimum);
      const routeExpiryValue = [observedAt + input.routeTtlSeconds, validUntilValue]
        .reduce((minimum, value) => value < minimum ? value : minimum);
      requireCondition(routeExpiryValue > observedAt && validUntilValue > observedAt, 'no executable validity remains');
      const quoteNonce = input.nonceSource.nextNonce();
      requireCondition(quoteNonce > 0n, 'quote nonce is invalid');
      return Object.freeze({
        quoteMode: 'EXECUTION_COMMITMENT' as const,
        economics: Object.freeze({
          templateId: STRATEGY_TEMPLATE_ID.CALENDAR_SPREAD,
          values: Object.freeze({
            nearPriceTicks: near.fillPriceWad,
            farPriceTicks: far.fillPriceWad,
            nearMaturityMs: near.expiry * 1_000n,
            farMaturityMs: far.expiry * 1_000n,
            netMarginAtoms: nearMarginAtoms + farMarginAtoms,
          }),
        }),
        legEconomics,
        netPackageOutcomeAtoms: -totalCost,
        serviceCharges: Object.freeze([
          ...(protocolFee === 0n ? [] : [serviceCharge('PROTOCOL', input.quoteAsset, protocolFee)]),
          ...(solverFee === 0n ? [] : [serviceCharge('SOLVER', input.quoteAsset, solverFee)]),
        ]),
        passThroughCosts: Object.freeze([
          ...(venueFees === 0n ? [] : [{ category: 'VENUE' as const, amount: assetAmount(input.quoteAsset, venueFees) }]),
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
