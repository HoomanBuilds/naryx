import {
  bytesEqual,
  type AssetRef,
} from '@naryx/protocol-types';
import {
  PublicKey,
  type AccountMeta,
  TransactionInstruction,
} from '@solana/web3.js';
import type {
  SolanaStrategyLegMaterializationContext,
  SolanaStrategyLegMaterializer,
} from './strategy-plan.js';
import type { SolanaTypedAdapterMaterializerBinding } from './inventory-materializer.js';

const SPOT_CLASS_ID = 'naryx.solana.spot-exact';
const PERP_CLASS_ID = 'naryx.solana.perp-exact';
const EXECUTE_DISCRIMINATOR = Buffer.from('88c3a5ee7e09042c', 'hex');
const ORCA_EXACT_OUTPUT_DISCRIMINATOR = Buffer.from('2d634cf2df70a8a2', 'hex');
const ORCA_EXACT_INPUT_DISCRIMINATOR = Buffer.from('c2cb8e96896e515e', 'hex');
const RISE_ENTER_SHORT_DISCRIMINATOR = Buffer.from('e730f1a3df678c6f', 'hex');
const RISE_CLOSE_SHORT_DISCRIMINATOR = Buffer.from('1f6936c17cd9cc39', 'hex');
const TEST_PERP_ENTER_SHORT_DISCRIMINATOR = Buffer.from('69b83373ed514e70', 'hex');
const TEST_PERP_INCREASE_SHORT_DISCRIMINATOR = Buffer.from('c51df14bfbb37adb', 'hex');
const TEST_PERP_DECREASE_SHORT_DISCRIMINATOR = Buffer.from('3d99b8fd9f138c6d', 'hex');
const TEST_PERP_CLOSE_SHORT_DISCRIMINATOR = Buffer.from('d49610a3d8de26e6', 'hex');
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export interface SolanaOrcaSpotAccounts {
  readonly strategyAccount: PublicKey | string;
  readonly tokenOwnerAccountA: PublicKey | string;
  readonly tokenOwnerAccountB: PublicKey | string;
  readonly tokenVaultA: PublicKey | string;
  readonly tokenVaultB: PublicKey | string;
  readonly whirlpool: PublicKey | string;
  readonly tickArray0: PublicKey | string;
  readonly tickArray1: PublicKey | string;
  readonly tickArray2: PublicKey | string;
  readonly oracle: PublicKey | string;
  readonly tokenProgram: PublicKey | string;
  readonly whirlpoolProgram: PublicKey | string;
}

export interface SolanaOrcaSpotLegBounds {
  readonly legId: string;
  readonly sqrtPriceLimit: bigint;
}

export interface SolanaExactShortPerpBounds {
  readonly legId: string;
  readonly lastValidSlot: bigint;
  readonly minimumPostCollateralQuoteLots: bigint;
  readonly clientOrderId: bigint;
}

export interface SolanaRisePerpAccounts {
  readonly strategy: PublicKey | string;
  readonly controller: PublicKey | string;
  readonly phoenixProgram: PublicKey | string;
  readonly logAuthority: PublicKey | string;
  readonly globalConfig: PublicKey | string;
  readonly permissionAccount: PublicKey | string;
  readonly traderAccount: PublicKey | string;
  readonly perpAssetMap: PublicKey | string;
  readonly globalTraderIndexHeader: PublicKey | string;
  readonly activeTraderBufferHeader: PublicKey | string;
  readonly orderbook: PublicKey | string;
  readonly splineCollection: PublicKey | string;
  readonly remainingAccounts: readonly Readonly<{
    address: PublicKey | string;
    isWritable: boolean;
  }>[];
}

export interface SolanaTestPerpAccounts {
  readonly strategy: PublicKey | string;
  readonly controller: PublicKey | string;
  readonly testPerpProgram: PublicKey | string;
  readonly market: PublicKey | string;
  readonly position: PublicKey | string;
  readonly oracle: PublicKey | string;
  readonly collateralVault: PublicKey | string;
  readonly feeVault: PublicKey | string;
  readonly insuranceVault: PublicKey | string;
  readonly tokenProgram: PublicKey | string;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function key(value: PublicKey | string, context: string): PublicKey {
  try {
    return value instanceof PublicKey ? value : new PublicKey(value);
  } catch {
    throw new Error(`${context} must be a Solana public key`);
  }
}

function u64(value: bigint, context: string): Buffer {
  requireCondition(typeof value === 'bigint' && value >= 0n && value <= U64_MAX, `${context} must fit u64`);
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64LE(value);
  return encoded;
}

function i64(value: bigint, context: string): Buffer {
  requireCondition(typeof value === 'bigint' && value >= -(1n << 63n) && value < (1n << 63n), `${context} must fit i64`);
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigInt64LE(value);
  return encoded;
}

function u128(value: bigint, context: string): Buffer {
  requireCondition(typeof value === 'bigint' && value >= 0n && value <= U128_MAX, `${context} must fit u128`);
  const encoded = Buffer.alloc(16);
  encoded.writeBigUInt64LE(value & U64_MAX, 0);
  encoded.writeBigUInt64LE(value >> 64n, 8);
  return encoded;
}

function vec(value: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32LE(value.length);
  return Buffer.concat([length, Buffer.from(value)]);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function graphLeg(context: SolanaStrategyLegMaterializationContext) {
  const matches = context.graph.legs.filter((value) => value.legId === context.routeLeg.legId);
  requireCondition(matches.length === 1, `leg ${context.routeLeg.legId} is missing from the graph`);
  return matches[0]!;
}

function checkedBounds<T extends { readonly legId: string }>(values: readonly T[], context: string): readonly T[] {
  requireCondition(new Set(values.map((value) => value.legId)).size === values.length, `${context} leg bounds repeat`);
  return values;
}

function quoteBound(context: SolanaStrategyLegMaterializationContext, baseAsset: AssetRef, quoteAsset: AssetRef): bigint {
  const leg = graphLeg(context);
  const limit = leg.limitPrice;
  requireCondition(limit !== undefined, `leg ${leg.legId} requires a limit price`);
  requireCondition(sameAsset(leg.quantityAsset, baseAsset), `leg ${leg.legId} quantity must use the base asset`);
  requireCondition(
    sameAsset(limit.baseAsset, baseAsset) && sameAsset(limit.quoteAsset, quoteAsset),
    `leg ${leg.legId} limit assets mismatch`,
  );
  const product = leg.quantityAtoms * limit.quoteAtoms;
  return leg.side === 'BUY' ? (product + limit.baseAtoms - 1n) / limit.baseAtoms : product / limit.baseAtoms;
}

function instruction(binding: SolanaTypedAdapterMaterializerBinding, keys: readonly AccountMeta[], payload: Uint8Array) {
  return new TransactionInstruction({
    programId: key(binding.programId, 'typed adapter program'),
    keys: [...keys],
    data: Buffer.concat([EXECUTE_DISCRIMINATOR, vec(payload)]),
  });
}

export function createSolanaOrcaSpotMaterializer(input: Readonly<{
  binding: SolanaTypedAdapterMaterializerBinding;
  baseAsset: AssetRef;
  quoteAsset: AssetRef;
  baseIsTokenA: boolean;
  accounts: SolanaOrcaSpotAccounts;
  bounds: readonly SolanaOrcaSpotLegBounds[];
}>): SolanaStrategyLegMaterializer {
  requireCondition(input.binding.materializationClassId === SPOT_CLASS_ID, 'Orca spot materializer class mismatch');
  requireCondition(input.binding.legFamily === 'SPOT_SWAP', 'Orca spot materializer family mismatch');
  const bounds = checkedBounds(input.bounds, 'Orca spot');
  const accounts = input.accounts;
  const keys: readonly AccountMeta[] = [
    { pubkey: key(accounts.strategyAccount, 'strategy account'), isSigner: true, isWritable: false },
    { pubkey: key(accounts.tokenOwnerAccountA, 'token owner account A'), isSigner: false, isWritable: true },
    { pubkey: key(accounts.tokenOwnerAccountB, 'token owner account B'), isSigner: false, isWritable: true },
    { pubkey: key(accounts.tokenVaultA, 'token vault A'), isSigner: false, isWritable: true },
    { pubkey: key(accounts.tokenVaultB, 'token vault B'), isSigner: false, isWritable: true },
    { pubkey: key(accounts.whirlpool, 'Whirlpool'), isSigner: false, isWritable: true },
    { pubkey: key(accounts.tickArray0, 'tick array 0'), isSigner: false, isWritable: true },
    { pubkey: key(accounts.tickArray1, 'tick array 1'), isSigner: false, isWritable: true },
    { pubkey: key(accounts.tickArray2, 'tick array 2'), isSigner: false, isWritable: true },
    { pubkey: key(accounts.oracle, 'Whirlpool oracle'), isSigner: false, isWritable: true },
    { pubkey: key(accounts.tokenProgram, 'token program'), isSigner: false, isWritable: false },
    { pubkey: key(accounts.whirlpoolProgram, 'Whirlpool program'), isSigner: false, isWritable: false },
  ];
  return Object.freeze({
    ...input.binding,
    programId: key(input.binding.programId, 'Orca adapter program'),
    materialize(context: SolanaStrategyLegMaterializationContext) {
      const leg = graphLeg(context);
      requireCondition(leg.legFamily === 'SPOT_SWAP' && (leg.side === 'BUY' || leg.side === 'SELL'), `leg ${leg.legId} is not a directional spot swap`);
      const matches = bounds.filter((value) => value.legId === leg.legId);
      requireCondition(matches.length === 1, `leg ${leg.legId} must have exact Orca bounds`);
      const bound = matches[0]!;
      const quoteAtoms = quoteBound(context, input.baseAsset, input.quoteAsset);
      requireCondition(leg.quantityAtoms > 0n && quoteAtoms > 0n, `leg ${leg.legId} spot quantity and quote bound must be positive`);
      const exactInput = leg.side === 'SELL';
      const aToB = exactInput ? input.baseIsTokenA : !input.baseIsTokenA;
      const payload = Buffer.concat([
        exactInput ? ORCA_EXACT_INPUT_DISCRIMINATOR : ORCA_EXACT_OUTPUT_DISCRIMINATOR,
        u64(leg.quantityAtoms, `leg ${leg.legId} quantity`),
        u64(quoteAtoms, `leg ${leg.legId} quote bound`),
        u128(bound.sqrtPriceLimit, `leg ${leg.legId} sqrt price limit`),
        Buffer.from([exactInput ? 1 : 0, aToB ? 1 : 0]),
      ]);
      return Object.freeze({
        instruction: instruction(input.binding, keys, payload),
        computeUnitLimit: input.binding.maximumComputeUnitLimit,
      });
    },
  });
}

function perpLimitTicks(
  context: SolanaStrategyLegMaterializationContext,
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  baseLotAtoms: bigint,
  quoteAtomsPerTickPerBaseLot: bigint,
): bigint {
  const leg = graphLeg(context);
  const limit = leg.limitPrice;
  requireCondition(limit !== undefined, `leg ${leg.legId} requires a limit price`);
  requireCondition(sameAsset(leg.quantityAsset, baseAsset), `leg ${leg.legId} quantity must use the base asset`);
  requireCondition(sameAsset(limit.baseAsset, baseAsset) && sameAsset(limit.quoteAsset, quoteAsset), `leg ${leg.legId} limit assets mismatch`);
  const numerator = limit.quoteAtoms * baseLotAtoms;
  const denominator = limit.baseAtoms * quoteAtomsPerTickPerBaseLot;
  requireCondition(denominator > 0n, 'perp tick denominator is zero');
  return leg.side === 'BUY' ? numerator / denominator : (numerator + denominator - 1n) / denominator;
}

function exactShortPayload(input: Readonly<{
  context: SolanaStrategyLegMaterializationContext;
  bound: SolanaExactShortPerpBounds;
  baseAsset: AssetRef;
  quoteAsset: AssetRef;
  baseLotAtoms: bigint;
  quoteAtomsPerTickPerBaseLot: bigint;
  enterDiscriminator: Buffer;
  increaseDiscriminator?: Buffer;
  decreaseDiscriminator?: Buffer;
  closeDiscriminator: Buffer;
}>): Buffer {
  const leg = graphLeg(input.context);
  const discriminator = leg.legFamily === 'PERP_OPEN' && leg.side === 'SELL'
    ? input.enterDiscriminator
    : leg.legFamily === 'PERP_INCREASE' && leg.side === 'SELL'
      ? input.increaseDiscriminator
      : leg.legFamily === 'PERP_DECREASE' && leg.side === 'BUY'
        ? input.decreaseDiscriminator
        : leg.legFamily === 'PERP_CLOSE' && leg.side === 'BUY'
          ? input.closeDiscriminator
          : undefined;
  requireCondition(discriminator !== undefined, `leg ${leg.legId} is not a supported exact short lifecycle action`);
  requireCondition(input.baseLotAtoms > 0n && leg.quantityAtoms % input.baseLotAtoms === 0n, `leg ${leg.legId} quantity is not aligned to the base lot`);
  const baseLots = leg.quantityAtoms / input.baseLotAtoms;
  const limitTicks = perpLimitTicks(
    input.context,
    input.baseAsset,
    input.quoteAsset,
    input.baseLotAtoms,
    input.quoteAtomsPerTickPerBaseLot,
  );
  requireCondition(baseLots > 0n && limitTicks > 0n, `leg ${leg.legId} perp size and limit must be positive`);
  return Buffer.concat([
    discriminator,
    u64(baseLots, `leg ${leg.legId} base lots`),
    u64(limitTicks, `leg ${leg.legId} limit ticks`),
    u64(input.bound.lastValidSlot, `leg ${leg.legId} last valid slot`),
    i64(input.bound.minimumPostCollateralQuoteLots, `leg ${leg.legId} collateral bound`),
    u128(input.bound.clientOrderId, `leg ${leg.legId} client order id`),
  ]);
}

function exactShortMaterializer(input: Readonly<{
  binding: SolanaTypedAdapterMaterializerBinding;
  baseAsset: AssetRef;
  quoteAsset: AssetRef;
  baseLotAtoms: bigint;
  quoteAtomsPerTickPerBaseLot: bigint;
  bounds: readonly SolanaExactShortPerpBounds[];
  keys: readonly AccountMeta[];
  enterDiscriminator: Buffer;
  increaseDiscriminator?: Buffer;
  decreaseDiscriminator?: Buffer;
  closeDiscriminator: Buffer;
}>): SolanaStrategyLegMaterializer {
  requireCondition(input.binding.materializationClassId === PERP_CLASS_ID, 'perp materializer class mismatch');
  requireCondition(input.binding.legFamily === 'PERP_OPEN' || input.binding.legFamily === 'PERP_INCREASE'
    || input.binding.legFamily === 'PERP_DECREASE' || input.binding.legFamily === 'PERP_CLOSE',
  'perp materializer family is not implemented');
  requireCondition(input.baseLotAtoms > 0n && input.quoteAtomsPerTickPerBaseLot > 0n, 'perp lot and tick sizes must be positive');
  const bounds = checkedBounds(input.bounds, 'perp');
  return Object.freeze({
    ...input.binding,
    programId: key(input.binding.programId, 'perp adapter program'),
    materialize(context: SolanaStrategyLegMaterializationContext) {
      const leg = graphLeg(context);
      requireCondition(leg.legFamily === input.binding.legFamily, `leg ${leg.legId} perp family mismatch`);
      const matches = bounds.filter((value) => value.legId === leg.legId);
      requireCondition(matches.length === 1, `leg ${leg.legId} must have exact perp bounds`);
      const payload = exactShortPayload({
        context,
        bound: matches[0]!,
        baseAsset: input.baseAsset,
        quoteAsset: input.quoteAsset,
        baseLotAtoms: input.baseLotAtoms,
        quoteAtomsPerTickPerBaseLot: input.quoteAtomsPerTickPerBaseLot,
        enterDiscriminator: input.enterDiscriminator,
        ...(input.increaseDiscriminator === undefined ? {} : { increaseDiscriminator: input.increaseDiscriminator }),
        ...(input.decreaseDiscriminator === undefined ? {} : { decreaseDiscriminator: input.decreaseDiscriminator }),
        closeDiscriminator: input.closeDiscriminator,
      });
      return Object.freeze({
        instruction: instruction(input.binding, input.keys, payload),
        computeUnitLimit: input.binding.maximumComputeUnitLimit,
      });
    },
  });
}

export function createSolanaRiseExactShortMaterializer(input: Readonly<{
  binding: SolanaTypedAdapterMaterializerBinding;
  baseAsset: AssetRef;
  quoteAsset: AssetRef;
  baseLotAtoms: bigint;
  quoteAtomsPerTickPerBaseLot: bigint;
  accounts: SolanaRisePerpAccounts;
  bounds: readonly SolanaExactShortPerpBounds[];
}>): SolanaStrategyLegMaterializer {
  const accounts = input.accounts;
  const strategy = key(accounts.strategy, 'Rise strategy');
  requireCondition(key(accounts.permissionAccount, 'Rise permission account').equals(strategy), 'Rise permission account must equal the strategy PDA');
  const remaining = accounts.remainingAccounts.map((account, index): AccountMeta => ({
    pubkey: key(account.address, `Rise remaining account ${index}`),
    isSigner: false,
    isWritable: account.isWritable,
  }));
  requireCondition(remaining.length <= 5, 'Rise supports at most five dynamic accounts');
  return exactShortMaterializer({
    ...input,
    keys: [
      { pubkey: strategy, isSigner: false, isWritable: true },
      { pubkey: key(accounts.controller, 'Rise controller'), isSigner: true, isWritable: false },
      { pubkey: key(accounts.phoenixProgram, 'Rise program'), isSigner: false, isWritable: false },
      { pubkey: key(accounts.logAuthority, 'Rise log authority'), isSigner: false, isWritable: false },
      { pubkey: key(accounts.globalConfig, 'Rise global config'), isSigner: false, isWritable: true },
      { pubkey: strategy, isSigner: false, isWritable: true },
      { pubkey: key(accounts.traderAccount, 'Rise trader account'), isSigner: false, isWritable: true },
      { pubkey: key(accounts.perpAssetMap, 'Rise perp asset map'), isSigner: false, isWritable: true },
      { pubkey: key(accounts.globalTraderIndexHeader, 'Rise global trader index'), isSigner: false, isWritable: true },
      { pubkey: key(accounts.activeTraderBufferHeader, 'Rise active trader buffer'), isSigner: false, isWritable: true },
      { pubkey: key(accounts.orderbook, 'Rise orderbook'), isSigner: false, isWritable: true },
      { pubkey: key(accounts.splineCollection, 'Rise spline collection'), isSigner: false, isWritable: true },
      ...remaining,
    ],
    enterDiscriminator: RISE_ENTER_SHORT_DISCRIMINATOR,
    closeDiscriminator: RISE_CLOSE_SHORT_DISCRIMINATOR,
  });
}

export function createSolanaTestPerpExactShortMaterializer(input: Readonly<{
  binding: SolanaTypedAdapterMaterializerBinding;
  baseAsset: AssetRef;
  quoteAsset: AssetRef;
  baseLotAtoms: bigint;
  quoteAtomsPerTickPerBaseLot: bigint;
  accounts: SolanaTestPerpAccounts;
  bounds: readonly SolanaExactShortPerpBounds[];
}>): SolanaStrategyLegMaterializer {
  const accounts = input.accounts;
  return exactShortMaterializer({
    ...input,
    keys: [
      { pubkey: key(accounts.strategy, 'test perp strategy'), isSigner: false, isWritable: false },
      { pubkey: key(accounts.controller, 'test perp controller'), isSigner: true, isWritable: false },
      { pubkey: key(accounts.testPerpProgram, 'test perp program'), isSigner: false, isWritable: false },
      { pubkey: key(accounts.market, 'test perp market'), isSigner: false, isWritable: true },
      { pubkey: key(accounts.position, 'test perp position'), isSigner: false, isWritable: true },
      { pubkey: key(accounts.oracle, 'test perp oracle'), isSigner: false, isWritable: false },
      { pubkey: key(accounts.collateralVault, 'test perp collateral vault'), isSigner: false, isWritable: true },
      { pubkey: key(accounts.feeVault, 'test perp fee vault'), isSigner: false, isWritable: true },
      { pubkey: key(accounts.insuranceVault, 'test perp insurance vault'), isSigner: false, isWritable: true },
      { pubkey: key(accounts.tokenProgram, 'token program'), isSigner: false, isWritable: false },
    ],
    enterDiscriminator: TEST_PERP_ENTER_SHORT_DISCRIMINATOR,
    increaseDiscriminator: TEST_PERP_INCREASE_SHORT_DISCRIMINATOR,
    decreaseDiscriminator: TEST_PERP_DECREASE_SHORT_DISCRIMINATOR,
    closeDiscriminator: TEST_PERP_CLOSE_SHORT_DISCRIMINATOR,
  });
}
