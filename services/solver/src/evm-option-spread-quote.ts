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
import type {
  GeneralizedStrategyPricingPort,
  GeneralizedStrategyQuoteTerms,
} from './strategy-quote-service.js';
import { callSpreadAnalytics } from './option-analytics.js';

const BPS = 10_000n;
const ORACLE_ABI = [{
  type: 'function',
  name: 'decimals',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint8' }],
}, {
  type: 'function',
  name: 'latestRoundData',
  stateMutability: 'view',
  inputs: [],
  outputs: [
    { name: 'roundId', type: 'uint80' },
    { name: 'answer', type: 'int256' },
    { name: 'startedAt', type: 'uint256' },
    { name: 'updatedAt', type: 'uint256' },
    { name: 'answeredInRound', type: 'uint80' },
  ],
}] as const satisfies Abi;
const OPTION_POOL_ABI = [{
  type: 'function',
  name: 'getPoolSettings',
  stateMutability: 'view',
  inputs: [],
  outputs: [
    { name: 'base', type: 'address' },
    { name: 'quote', type: 'address' },
    { name: 'oracle', type: 'address' },
    { name: 'strike', type: 'uint256' },
    { name: 'maturity', type: 'uint256' },
    { name: 'isCall', type: 'bool' },
  ],
}, {
  type: 'function',
  name: 'poolToken',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function',
  name: 'premiumBps',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint16' }],
}] as const satisfies Abi;

export type EvmOptionSpreadRole = 'option-long' | 'option-short';

export interface EvmOptionSpreadReadPort {
  chainId(): Promise<bigint>;
  latestBlockTimestamp(): Promise<bigint>;
  codeHash(address: Address): Promise<Hex | undefined>;
  readContract(request: Readonly<{
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }>): Promise<unknown>;
}

export interface EvmOptionSpreadContractIdentity {
  readonly address: Address;
  readonly expectedCodeHash: Hex;
}

export interface EvmOptionSpreadPoolBinding {
  readonly role: EvmOptionSpreadRole;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly pool: EvmOptionSpreadContractIdentity;
  readonly expectedStrike: bigint;
  readonly expectedMaturity: bigint;
}

export interface EvmOptionSpreadQuoteNonceSource {
  nextNonce(): bigint;
}

export interface EvmOptionSpreadPricingInput {
  readonly chainId: bigint;
  readonly domain: DomainRef;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly baseToken: EvmOptionSpreadContractIdentity;
  readonly quoteToken: EvmOptionSpreadContractIdentity;
  readonly oracle: EvmOptionSpreadContractIdentity;
  readonly maximumOracleAgeSeconds: bigint;
  readonly pools: readonly [EvmOptionSpreadPoolBinding, EvmOptionSpreadPoolBinding];
  readonly strikeDecimals: number;
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

export interface EvmOptionPoolSnapshot {
  readonly role: EvmOptionSpreadRole;
  readonly pool: Address;
  readonly strike: bigint;
  readonly maturity: bigint;
  readonly premiumBps: bigint;
}

export interface EvmOptionReferencePrice {
  readonly answer: bigint;
  readonly decimals: number;
  readonly observedAt: bigint;
  readonly updatedAt: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM option spread quote refused: ${message}`);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameManifest(left: VersionedManifestRef, right: VersionedManifestRef): boolean {
  return left.subjectId === right.subjectId
    && left.manifestVersion === right.manifestVersion
    && bytesEqual(left.manifestHash, right.manifestHash);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
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

function premiumPrice(
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  quoteAtoms: bigint,
  baseAtoms: bigint,
  roundingDirection: 'FLOOR' | 'CEIL',
) {
  const divisor = gcd(quoteAtoms, baseAtoms);
  return exactPrice({
    baseAsset,
    quoteAsset,
    quoteAtoms: quoteAtoms / divisor,
    baseAtoms: baseAtoms / divisor,
    roundingDirection,
  });
}

function pow10(decimals: number, context: string): bigint {
  requireCondition(Number.isInteger(decimals) && decimals >= 0 && decimals <= 38, `${context} decimals are invalid`);
  return 10n ** BigInt(decimals);
}

function decimal(value: bigint, decimals: number, context: string): number {
  const converted = Number(value) / 10 ** decimals;
  requireCondition(Number.isFinite(converted) && converted > 0, `${context} is outside the analytics range`);
  return converted;
}

function checkedHash(value: Hex, context: string): Hex {
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/.test(value), `${context} code hash is invalid`);
  return value.toLowerCase() as Hex;
}

async function assertCode(
  chain: EvmOptionSpreadReadPort,
  identity: EvmOptionSpreadContractIdentity,
  context: string,
): Promise<void> {
  const actual = await chain.codeHash(getAddress(identity.address));
  requireCondition(actual !== undefined && checkedHash(actual, context) === checkedHash(identity.expectedCodeHash, context), `${context} code changed`);
}

function tuple(value: unknown, context: string, minimumLength = 6): readonly unknown[] {
  requireCondition(Array.isArray(value) && value.length >= minimumLength, `${context} settings are invalid`);
  return value;
}

export async function readEvmOptionReferencePrice(
  input: EvmOptionSpreadPricingInput,
  observedAt: bigint,
): Promise<EvmOptionReferencePrice> {
  const oracle = getAddress(input.oracle.address);
  const read = (functionName: string) => input.chain.readContract({
    address: oracle,
    abi: ORACLE_ABI,
    functionName,
  });
  const [decimalsValue, roundValue] = await Promise.all([
    read('decimals'),
    read('latestRoundData'),
    assertCode(input.chain, input.oracle, 'oracle'),
  ]);
  const round = tuple(roundValue, 'oracle round', 5);
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  const decimals = Number(decimalsValue);
  requireCondition(Number.isInteger(decimals) && decimals >= 0 && decimals <= 38, 'oracle decimals are invalid');
  requireCondition(typeof roundId === 'bigint' && roundId > 0n
    && typeof answer === 'bigint' && answer > 0n
    && typeof updatedAt === 'bigint' && updatedAt > 0n
    && typeof answeredInRound === 'bigint' && answeredInRound >= roundId,
  'oracle round is invalid');
  requireCondition(observedAt >= updatedAt && observedAt - updatedAt <= input.maximumOracleAgeSeconds,
    'oracle round is stale or from the future');
  return Object.freeze({ answer, decimals, observedAt, updatedAt });
}

export async function readEvmOptionPoolSnapshot(
  input: EvmOptionSpreadPricingInput,
  binding: EvmOptionSpreadPoolBinding,
): Promise<EvmOptionPoolSnapshot> {
  const pool = getAddress(binding.pool.address);
  const read = (functionName: string) => input.chain.readContract({
    address: pool,
    abi: OPTION_POOL_ABI,
    functionName,
  });
  const [settingsValue, poolTokenValue, premiumBpsValue] = await Promise.all([
    read('getPoolSettings'),
    read('poolToken'),
    read('premiumBps'),
    assertCode(input.chain, binding.pool, `${binding.role} pool`),
  ]);
  const settings = tuple(settingsValue, `${binding.role} pool`);
  const [baseValue, quoteValue, oracleValue, strikeValue, maturityValue, isCallValue] = settings;
  const base = getAddress(String(baseValue));
  const quote = getAddress(String(quoteValue));
  const oracle = getAddress(String(oracleValue));
  const poolToken = getAddress(String(poolTokenValue));
  requireCondition(
    base === getAddress(input.baseToken.address)
      && quote === getAddress(input.quoteToken.address)
      && oracle === getAddress(input.oracle.address)
      && poolToken === getAddress(input.baseToken.address),
    `${binding.role} pool assets or oracle differ from the reviewed binding`,
  );
  requireCondition(typeof strikeValue === 'bigint' && strikeValue === binding.expectedStrike, `${binding.role} strike changed`);
  requireCondition(typeof maturityValue === 'bigint' && maturityValue === binding.expectedMaturity, `${binding.role} maturity changed`);
  requireCondition(isCallValue === true, `${binding.role} must be a call pool`);
  const premiumBps = typeof premiumBpsValue === 'bigint'
    ? premiumBpsValue
    : BigInt(Number(premiumBpsValue));
  requireCondition(premiumBps > 0n && premiumBps < BPS, `${binding.role} premium rate is invalid`);
  return Object.freeze({ role: binding.role, pool, strike: strikeValue, maturity: maturityValue, premiumBps });
}

function validateConfiguration(input: EvmOptionSpreadPricingInput): void {
  requireCondition(input.chainId > 0n && input.domain.domainId === `eip155:${input.chainId}`, 'chain and domain differ');
  requireCondition(input.baseAsset.decimals > 0 && input.quoteAsset.decimals > 0
    && !sameAsset(input.baseAsset, input.quoteAsset), 'base and quote assets are invalid');
  requireCondition(input.maximumOracleAgeSeconds > 0n, 'oracle age limit is invalid');
  requireCondition(Number.isInteger(input.protocolFeeBps) && input.protocolFeeBps >= 0 && input.protocolFeeBps < 1_000
    && Number.isInteger(input.solverFeeBps) && input.solverFeeBps >= 0 && input.solverFeeBps < 1_000,
  'service fee rates are invalid');
  requireCondition(input.networkFeeQuoteAtoms >= 0n && input.feePolicyVersion > 0
    && input.routeTtlSeconds > 0n && input.quoteTtlSeconds >= input.routeTtlSeconds,
  'fee policy or validity is invalid');
  manifestHash(input.feePolicyManifestHash, 'evmOptionSpread.feePolicyManifestHash');
  checkedHash(input.baseToken.expectedCodeHash, 'base token');
  checkedHash(input.quoteToken.expectedCodeHash, 'quote token');
  checkedHash(input.oracle.expectedCodeHash, 'oracle');
  const roles = new Set(input.pools.map((pool) => pool.role));
  requireCondition(roles.size === 2 && roles.has('option-long') && roles.has('option-short'), 'both option pool roles are required');
  const long = input.pools.find((pool) => pool.role === 'option-long')!;
  const short = input.pools.find((pool) => pool.role === 'option-short')!;
  requireCondition(long.expectedMaturity === short.expectedMaturity && long.expectedStrike < short.expectedStrike,
    'pool bindings do not describe a defined-risk call spread');
}

function matchLeg(
  documents: StoredStrategyPackageOrderDocuments,
  binding: EvmOptionSpreadPoolBinding,
) {
  const matches = documents.graph.legs.filter((leg) => leg.legId === binding.role);
  requireCondition(matches.length === 1, `${binding.role} graph leg is missing`);
  const leg = matches[0]!;
  requireCondition(sameAdapter(leg.adapter, binding.adapter)
    && sameManifest(leg.venue, binding.venue)
    && sameManifest(leg.market, binding.market), `${binding.role} graph identity differs from the reviewed binding`);
  return leg;
}

function quoteAtomsFromBase(
  baseAtoms: bigint,
  input: EvmOptionSpreadPricingInput,
  reference: EvmOptionReferencePrice,
  rounding: 'FLOOR' | 'CEIL',
): bigint {
  const numerator = baseAtoms * reference.answer * pow10(input.quoteAsset.decimals, 'quote asset');
  const denominator = pow10(input.baseAsset.decimals, 'base asset') * pow10(reference.decimals, 'oracle');
  return rounding === 'CEIL' ? ceilDiv(numerator, denominator) : numerator / denominator;
}

function strikeWidthQuoteAtoms(
  quantityAtoms: bigint,
  longStrike: bigint,
  shortStrike: bigint,
  input: EvmOptionSpreadPricingInput,
): bigint {
  const numerator = quantityAtoms * (shortStrike - longStrike) * pow10(input.quoteAsset.decimals, 'quote asset');
  return numerator / (pow10(input.baseAsset.decimals, 'base asset') * pow10(input.strikeDecimals, 'strike'));
}

function serviceCharge(
  category: 'PROTOCOL' | 'SOLVER',
  quoteAsset: AssetRef,
  atoms: bigint,
) {
  return Object.freeze({ category, amount: assetAmount(quoteAsset, atoms) });
}

export function createEvmOptionSpreadGeneralizedPricing(
  input: EvmOptionSpreadPricingInput,
): GeneralizedStrategyPricingPort {
  validateConfiguration(input);
  return Object.freeze({
    async quote({ documents, currentTime }: Readonly<{
      documents: StoredStrategyPackageOrderDocuments;
      currentTime: PackageGraphCompileContext['currentTime'];
    }>): Promise<GeneralizedStrategyQuoteTerms> {
      const { order, graph } = documents;
      requireCondition(order.environment === 'testnet' && graph.environment === 'testnet'
        && order.templateId === STRATEGY_TEMPLATE_ID.OPTION_SPREAD
        && graph.templateId === STRATEGY_TEMPLATE_ID.OPTION_SPREAD
        && order.settlementClass === 'ATOMIC_POSTCONDITION'
        && graph.settlementClass === 'ATOMIC_POSTCONDITION'
        && order.expiryUnit === 'EVM_UNIX_SECONDS' && graph.expiryUnit === 'EVM_UNIX_SECONDS',
      'package is not a testnet atomic EVM option spread');
      requireCondition(graph.legs.length === 2 && graph.legs.every((leg) => sameDomain(leg.domain, input.domain)),
        'package domain is unsupported');
      requireCondition(sameAsset(order.economicQuantity.asset, input.baseAsset)
        && sameAsset(order.quoteAsset, input.quoteAsset), 'package assets are unsupported');
      requireCondition(currentTime.unit === 'EVM_UNIX_SECONDS', 'quote clock is invalid');
      const [chainId, observedAt] = await Promise.all([
        input.chain.chainId(),
        input.chain.latestBlockTimestamp(),
      ]);
      requireCondition(chainId === input.chainId, 'RPC chain identity differs from the reviewed chain');
      requireCondition(observedAt >= currentTime.value && observedAt - currentTime.value <= 30n, 'quote clock is stale or from another head');
      const [reference, longPool, shortPool] = await Promise.all([
        readEvmOptionReferencePrice(input, observedAt),
        readEvmOptionPoolSnapshot(input, input.pools.find((pool) => pool.role === 'option-long')!),
        readEvmOptionPoolSnapshot(input, input.pools.find((pool) => pool.role === 'option-short')!),
        assertCode(input.chain, input.baseToken, 'base token'),
        assertCode(input.chain, input.quoteToken, 'quote token'),
      ]);
      requireCondition(longPool.maturity === shortPool.maturity && observedAt < longPool.maturity, 'option pools are matured or mismatched');

      const longLeg = matchLeg(documents, input.pools.find((pool) => pool.role === 'option-long')!);
      const shortLeg = matchLeg(documents, input.pools.find((pool) => pool.role === 'option-short')!);
      const opening = order.lifecycleAction === 'ENTRY' || order.lifecycleAction === 'INCREASE';
      const closing = order.lifecycleAction === 'DECREASE' || order.lifecycleAction === 'EXIT'
        || order.lifecycleAction === 'EMERGENCY_UNWIND';
      requireCondition(opening || closing, 'lifecycle action is unsupported');
      requireCondition(longLeg.quantityAtoms === order.economicQuantity.atoms
        && shortLeg.quantityAtoms === order.economicQuantity.atoms, 'option leg quantities differ from the package quantity');
      requireCondition(
        opening
          ? longLeg.legFamily === 'OPTION_BUY' && longLeg.side === 'BUY'
            && shortLeg.legFamily === 'OPTION_MINT' && shortLeg.side === 'SELL'
          : longLeg.legFamily === 'OPTION_SELL' && longLeg.side === 'SELL'
            && shortLeg.legFamily === 'OPTION_BUY' && shortLeg.side === 'BUY',
        'option legs do not match the lifecycle action',
      );
      const quantity = order.economicQuantity.atoms;
      const longPremiumBase = ceilDiv(quantity * longPool.premiumBps, BPS);
      const shortPremiumBase = ceilDiv(quantity * shortPool.premiumBps, BPS);
      const longPremiumQuote = quoteAtomsFromBase(longPremiumBase, input, reference, opening ? 'CEIL' : 'FLOOR');
      const shortPremiumQuote = quoteAtomsFromBase(shortPremiumBase, input, reference, opening ? 'FLOOR' : 'CEIL');
      requireCondition(longPremiumQuote > 0n && shortPremiumQuote > 0n, 'premium conversion rounds to zero');
      const notional = quoteAtomsFromBase(quantity, input, reference, 'CEIL');
      const protocolFee = ceilDiv(notional * 2n * BigInt(input.protocolFeeBps), BPS);
      const solverFee = ceilDiv(notional * 2n * BigInt(input.solverFeeBps), BPS);
      const serviceFees = protocolFee + solverFee;
      const totalCosts = serviceFees + input.networkFeeQuoteAtoms;
      const netPremium = opening
        ? shortPremiumQuote - longPremiumQuote
        : longPremiumQuote - shortPremiumQuote;
      const width = strikeWidthQuoteAtoms(quantity, longPool.strike, shortPool.strike, input);
      const maximumLoss = opening && totalCosts > netPremium ? totalCosts - netPremium : 0n;
      const maximumProfit = opening && width + netPremium > totalCosts ? width + netPremium - totalCosts : 0n;
      const analyticsSpot = decimal(reference.answer, reference.decimals, 'reference price');
      const analytics = callSpreadAnalytics({
        spot: analyticsSpot,
        longStrike: decimal(longPool.strike, input.strikeDecimals, 'long strike'),
        shortStrike: decimal(shortPool.strike, input.strikeDecimals, 'short strike'),
        longPremium: analyticsSpot * Number(longPool.premiumBps) / Number(BPS),
        shortPremium: analyticsSpot * Number(shortPool.premiumBps) / Number(BPS),
        secondsToMaturity: Number(longPool.maturity - observedAt),
        direction: opening ? 1 : -1,
      });
      const legEconomics: readonly StrategyLegEconomicsInput[] = Object.freeze([
        Object.freeze({
          legId: longLeg.legId,
          quantity: assetAmount(input.baseAsset, quantity),
          executionPrice: premiumPrice(
            input.baseAsset,
            input.quoteAsset,
            longPremiumQuote,
            quantity,
            longLeg.side === 'BUY' ? 'CEIL' : 'FLOOR',
          ),
          grossNotional: assetAmount(input.quoteAsset, notional),
          marginDelta: assetAmount(input.quoteAsset, 0n),
          venueFee: assetAmount(input.quoteAsset, 0n),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
        Object.freeze({
          legId: shortLeg.legId,
          quantity: assetAmount(input.baseAsset, quantity),
          executionPrice: premiumPrice(
            input.baseAsset,
            input.quoteAsset,
            shortPremiumQuote,
            quantity,
            shortLeg.side === 'BUY' ? 'CEIL' : 'FLOOR',
          ),
          grossNotional: assetAmount(input.quoteAsset, notional),
          marginDelta: assetAmount(input.quoteAsset, opening ? notional : 0n),
          venueFee: assetAmount(input.quoteAsset, 0n),
          builderFee: assetAmount(input.quoteAsset, 0n),
          residualValue: assetAmount(input.quoteAsset, 0n),
        }),
      ]);
      const validUntilValue = [observedAt + input.quoteTtlSeconds, order.expiryValue, longPool.maturity - 1n]
        .reduce((minimum, value) => value < minimum ? value : minimum);
      const routeExpiryValue = [observedAt + input.routeTtlSeconds, validUntilValue]
        .reduce((minimum, value) => value < minimum ? value : minimum);
      requireCondition(routeExpiryValue > observedAt && validUntilValue > observedAt, 'no executable validity remains');
      const quoteNonce = input.nonceSource.nextNonce();
      requireCondition(quoteNonce > 0n, 'quote nonce is invalid');
      return Object.freeze({
        quoteMode: 'EXECUTION_COMMITMENT' as const,
        economics: Object.freeze({
          templateId: STRATEGY_TEMPLATE_ID.OPTION_SPREAD,
          values: Object.freeze({
            netPremiumAtoms: netPremium,
            deltaPpm: analytics.deltaPpm,
            gammaPpm: analytics.gammaPpm,
            vegaPpm: analytics.vegaPpm,
            thetaPpm: analytics.thetaPpm,
            maximumProfitAtoms: maximumProfit,
            maximumLossAtoms: maximumLoss,
            impliedVolatilityPpm: analytics.impliedVolatilityPpm,
            volatilitySpreadPpm: analytics.volatilitySpreadPpm,
          }),
        }),
        legEconomics,
        netPackageOutcomeAtoms: netPremium - totalCosts,
        serviceCharges: Object.freeze([
          ...(protocolFee === 0n ? [] : [serviceCharge('PROTOCOL', input.quoteAsset, protocolFee)]),
          ...(solverFee === 0n ? [] : [serviceCharge('SOLVER', input.quoteAsset, solverFee)]),
        ]),
        passThroughCosts: Object.freeze(input.networkFeeQuoteAtoms === 0n ? [] : [{
          category: 'NETWORK' as const,
          amount: assetAmount(input.quoteAsset, input.networkFeeQuoteAtoms),
        }]),
        feePolicyVersion: input.feePolicyVersion,
        feePolicyManifestHash: input.feePolicyManifestHash,
        routeExpiryValue,
        validUntilValue,
        quoteNonce,
      });
    },
  });
}
