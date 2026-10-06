import { bytesEqual, type AssetRef } from '@naryx/protocol-types';
import { encodeAbiParameters, getAddress, type Hex } from 'viem';
import type {
  EvmStrategyLegMaterializationContext,
  EvmStrategyLegMaterializer,
} from './strategy-plan.js';

const SPOT_CLASS_ID = 'naryx.evm.spot-exact';
const PERP_CLASS_ID = 'naryx.evm.perp-exact';
const FUTURE_CLASS_ID = 'naryx.evm.future-exact';
const ERC4626_CLASS_ID = 'naryx.evm.erc4626-exact';
const AAVE_V3_LENDING_CLASS_ID = 'naryx.evm.aave-v3-lending-exact';
const PREMIA_V3_OPTION_CLASS_ID = 'naryx.evm.premia-v3-option-exact';
const INVENTORY_CUSTODY_CLASS_ID = 'naryx.evm.inventory-custody-exact';
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const INT128_MIN = -(1n << 127n);
const INT128_MAX = (1n << 127n) - 1n;

export type EvmTypedAdapterMaterializerBinding = Omit<EvmStrategyLegMaterializer, 'materialize'>;

export interface EvmExactPerpLegBounds {
  readonly legId: string;
  readonly expectedPrePositionHash: Hex;
  readonly tradeArgs: readonly [Hex, Hex];
  readonly expectedPostSizeWad: bigint;
  readonly minimumPostBalanceWad: bigint;
  readonly maximumPostBalanceWad: bigint;
  readonly minimumPostEntryNotionalWad: bigint;
  readonly maximumPostEntryNotionalWad: bigint;
  readonly expectedReserveBeforeAtoms: bigint;
  readonly minimumReserveAfterAtoms: bigint;
  readonly maximumReserveAfterAtoms: bigint;
  readonly collateralInAtoms: bigint;
  readonly collateralOutAtoms: bigint;
  readonly withdrawAll: boolean;
  readonly minimumCollateralOutAtoms: bigint;
  readonly maximumCollateralOutAtoms: bigint;
}

export interface EvmExactVaultLegBounds {
  readonly legId: string;
  readonly minimumOutputAtoms: bigint;
  readonly maximumOutputAtoms: bigint;
}

export interface EvmAaveV3LendingLegBounds {
  readonly legId: string;
  readonly expectedPreAccountDataHash: Hex;
  readonly minimumOutputAtoms: bigint;
  readonly maximumOutputAtoms: bigint;
  readonly minimumPostCollateralBase: bigint;
  readonly maximumPostCollateralBase: bigint;
  readonly minimumPostDebtBase: bigint;
  readonly maximumPostDebtBase: bigint;
  readonly minimumPostHealthFactor: bigint;
}

export interface EvmPremiaV3OptionLegBounds {
  readonly legId: string;
  readonly premiumLimit: bigint;
  readonly maximumInputAtoms: bigint;
  readonly expectedPreLongs: bigint;
  readonly expectedPreShorts: bigint;
  readonly expectedPostLongs: bigint;
  readonly expectedPostShorts: bigint;
  readonly minimumAccountTokenDelta: bigint;
  readonly maximumAccountTokenDelta: bigint;
}

export interface EvmExactInventoryLegBounds {
  readonly legId: string;
  readonly action: 'LOCK' | 'RELEASE';
  readonly expectedPreInventoryAtoms: bigint;
  readonly expectedPostInventoryAtoms: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hash(value: Hex, context: string): Hex {
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(value), `${context} must be bytes32`);
  return value.toLowerCase() as Hex;
}

function nonzeroHash(value: Hex, context: string): Hex {
  const checked = hash(value, context);
  requireCondition(!/^0x0{64}$/.test(checked), `${context} must be nonzero`);
  return checked;
}

function unsigned(value: bigint, maximum: bigint, context: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= 0n && value <= maximum, `${context} is outside its unsigned range`);
  return value;
}

function signed128(value: bigint, context: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= INT128_MIN && value <= INT128_MAX, `${context} is outside int128`);
  return value;
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function graphLeg(context: EvmStrategyLegMaterializationContext) {
  const matches = context.graph.legs.filter((value) => value.legId === context.routeLeg.legId);
  requireCondition(matches.length === 1, `leg ${context.routeLeg.legId} is missing from the graph`);
  return matches[0]!;
}

function legEconomics(context: EvmStrategyLegMaterializationContext) {
  const matches = context.admission.quote.legEconomics.filter((value) => value.legId === context.routeLeg.legId);
  requireCondition(matches.length === 1, `leg ${context.routeLeg.legId} is missing quoted economics`);
  return matches[0]!;
}

function quoteBound(context: EvmStrategyLegMaterializationContext, baseAsset: AssetRef, quoteAsset: AssetRef): bigint {
  const leg = graphLeg(context);
  const limit = leg.limitPrice;
  requireCondition(limit !== undefined, `spot leg ${leg.legId} requires a limit price`);
  requireCondition(sameAsset(leg.quantityAsset, baseAsset), `spot leg ${leg.legId} quantity must use the base asset`);
  requireCondition(
    sameAsset(limit.baseAsset, baseAsset) && sameAsset(limit.quoteAsset, quoteAsset),
    `spot leg ${leg.legId} limit assets mismatch`,
  );
  const product = leg.quantityAtoms * limit.quoteAtoms;
  requireCondition(product <= UINT256_MAX, `spot leg ${leg.legId} quote product overflows uint256`);
  return leg.side === 'BUY'
    ? (product + limit.baseAtoms - 1n) / limit.baseAtoms
    : product / limit.baseAtoms;
}

export function createEvmExactSpotMaterializer(input: Readonly<{
  binding: EvmTypedAdapterMaterializerBinding;
  baseAsset: AssetRef;
  quoteAsset: AssetRef;
}>): EvmStrategyLegMaterializer {
  requireCondition(input.binding.materializationClassId === SPOT_CLASS_ID, 'spot materializer class mismatch');
  return Object.freeze({
    ...input.binding,
    adapterAddress: getAddress(input.binding.adapterAddress),
    materialize(context: EvmStrategyLegMaterializationContext) {
      const leg = graphLeg(context);
      requireCondition(leg.legFamily === 'SPOT_SWAP', `leg ${leg.legId} is not a spot swap`);
      requireCondition(leg.side === 'BUY' || leg.side === 'SELL', `spot leg ${leg.legId} must buy or sell`);
      const bound = quoteBound(context, input.baseAsset, input.quoteAsset);
      return Object.freeze({
        data: encodeAbiParameters(
          [{
            type: 'tuple',
            components: [
              { name: 'packageId', type: 'bytes32' },
              { name: 'orderHash', type: 'bytes32' },
              { name: 'quoteHash', type: 'bytes32' },
              { name: 'routeHash', type: 'bytes32' },
              { name: 'action', type: 'uint8' },
              { name: 'baseAtoms', type: 'uint256' },
              { name: 'quoteBoundAtoms', type: 'uint256' },
            ],
          }],
          [{
            packageId: context.packageId,
            orderHash: context.orderHash,
            quoteHash: context.quoteHash,
            routeHash: context.routeHash,
            action: leg.side === 'BUY' ? 1 : 2,
            baseAtoms: leg.quantityAtoms,
            quoteBoundAtoms: bound,
          }],
        ),
        gasLimit: input.binding.maximumGasLimit,
      });
    },
  });
}

function checkedPerpBounds(value: EvmExactPerpLegBounds): EvmExactPerpLegBounds {
  nonzeroHash(value.expectedPrePositionHash, 'expected pre-position hash');
  hash(value.tradeArgs[0], 'trade argument 0');
  hash(value.tradeArgs[1], 'trade argument 1');
  signed128(value.expectedPostSizeWad, 'expected post size');
  signed128(value.minimumPostBalanceWad, 'minimum post balance');
  signed128(value.maximumPostBalanceWad, 'maximum post balance');
  requireCondition(value.minimumPostBalanceWad <= value.maximumPostBalanceWad, 'post balance range is inverted');
  unsigned(value.minimumPostEntryNotionalWad, UINT128_MAX, 'minimum post entry notional');
  unsigned(value.maximumPostEntryNotionalWad, UINT128_MAX, 'maximum post entry notional');
  requireCondition(
    value.minimumPostEntryNotionalWad <= value.maximumPostEntryNotionalWad,
    'post entry notional range is inverted',
  );
  unsigned(value.expectedReserveBeforeAtoms, UINT256_MAX, 'expected reserve before');
  unsigned(value.minimumReserveAfterAtoms, UINT256_MAX, 'minimum reserve after');
  unsigned(value.maximumReserveAfterAtoms, UINT256_MAX, 'maximum reserve after');
  requireCondition(value.minimumReserveAfterAtoms <= value.maximumReserveAfterAtoms, 'reserve range is inverted');
  unsigned(value.collateralInAtoms, UINT256_MAX, 'collateral input');
  unsigned(value.collateralOutAtoms, UINT256_MAX, 'collateral output');
  unsigned(value.minimumCollateralOutAtoms, UINT256_MAX, 'minimum collateral output');
  unsigned(value.maximumCollateralOutAtoms, UINT256_MAX, 'maximum collateral output');
  requireCondition(
    value.minimumCollateralOutAtoms <= value.maximumCollateralOutAtoms,
    'collateral output range is inverted',
  );
  requireCondition(
    !(value.collateralInAtoms !== 0n && (value.collateralOutAtoms !== 0n || value.withdrawAll)),
    'one leg cannot deposit and withdraw collateral',
  );
  requireCondition(!(value.withdrawAll && value.collateralOutAtoms !== 0n), 'withdraw-all cannot carry an exact output');
  return value;
}

function createEvmExactDerivativeMaterializer(input: Readonly<{
  binding: EvmTypedAdapterMaterializerBinding;
  bounds: readonly EvmExactPerpLegBounds[];
}>, classId: string, familyPrefix: 'PERP_' | 'FUTURE_'): EvmStrategyLegMaterializer {
  requireCondition(input.binding.materializationClassId === classId, 'derivative materializer class mismatch');
  const checked = input.bounds.map(checkedPerpBounds);
  requireCondition(new Set(checked.map((value) => value.legId)).size === checked.length, 'derivative leg bounds repeat');
  return Object.freeze({
    ...input.binding,
    adapterAddress: getAddress(input.binding.adapterAddress),
    materialize(context: EvmStrategyLegMaterializationContext) {
      const leg = graphLeg(context);
      requireCondition(leg.legFamily.startsWith(familyPrefix), `leg ${leg.legId} is not a supported derivative action`);
      const matches = checked.filter((value) => value.legId === leg.legId);
      requireCondition(matches.length === 1, `leg ${leg.legId} must have exact derivative bounds`);
      const bounds = matches[0]!;
      const economics = legEconomics(context);
      const requiredInput = economics.marginDelta.atoms > 0n ? economics.marginDelta.atoms : 0n;
      requireCondition(
        bounds.collateralInAtoms === requiredInput,
        `leg ${leg.legId} collateral input differs from quoted margin`,
      );
      return Object.freeze({
        data: encodeAbiParameters(
          [{
            type: 'tuple',
            components: [
              { name: 'packageId', type: 'bytes32' },
              { name: 'orderHash', type: 'bytes32' },
              { name: 'quoteHash', type: 'bytes32' },
              { name: 'routeHash', type: 'bytes32' },
              { name: 'expectedPrePositionHash', type: 'bytes32' },
              { name: 'tradeArgs', type: 'bytes32[2]' },
              { name: 'expectedPostSizeWad', type: 'int128' },
              { name: 'minimumPostBalanceWad', type: 'int128' },
              { name: 'maximumPostBalanceWad', type: 'int128' },
              { name: 'minimumPostEntryNotionalWad', type: 'uint128' },
              { name: 'maximumPostEntryNotionalWad', type: 'uint128' },
              { name: 'expectedReserveBeforeAtoms', type: 'uint256' },
              { name: 'minimumReserveAfterAtoms', type: 'uint256' },
              { name: 'maximumReserveAfterAtoms', type: 'uint256' },
              { name: 'collateralInAtoms', type: 'uint256' },
              { name: 'collateralOutAtoms', type: 'uint256' },
              { name: 'withdrawAll', type: 'bool' },
              { name: 'minimumCollateralOutAtoms', type: 'uint256' },
              { name: 'maximumCollateralOutAtoms', type: 'uint256' },
            ],
          }],
          [{
            packageId: context.packageId,
            orderHash: context.orderHash,
            quoteHash: context.quoteHash,
            routeHash: context.routeHash,
            expectedPrePositionHash: bounds.expectedPrePositionHash,
            tradeArgs: [...bounds.tradeArgs],
            expectedPostSizeWad: bounds.expectedPostSizeWad,
            minimumPostBalanceWad: bounds.minimumPostBalanceWad,
            maximumPostBalanceWad: bounds.maximumPostBalanceWad,
            minimumPostEntryNotionalWad: bounds.minimumPostEntryNotionalWad,
            maximumPostEntryNotionalWad: bounds.maximumPostEntryNotionalWad,
            expectedReserveBeforeAtoms: bounds.expectedReserveBeforeAtoms,
            minimumReserveAfterAtoms: bounds.minimumReserveAfterAtoms,
            maximumReserveAfterAtoms: bounds.maximumReserveAfterAtoms,
            collateralInAtoms: bounds.collateralInAtoms,
            collateralOutAtoms: bounds.collateralOutAtoms,
            withdrawAll: bounds.withdrawAll,
            minimumCollateralOutAtoms: bounds.minimumCollateralOutAtoms,
            maximumCollateralOutAtoms: bounds.maximumCollateralOutAtoms,
          }],
        ),
        gasLimit: input.binding.maximumGasLimit,
      });
    },
  });
}

export function createEvmExactPerpMaterializer(input: Readonly<{
  binding: EvmTypedAdapterMaterializerBinding;
  bounds: readonly EvmExactPerpLegBounds[];
}>): EvmStrategyLegMaterializer {
  return createEvmExactDerivativeMaterializer(input, PERP_CLASS_ID, 'PERP_');
}

export function createEvmExactFutureMaterializer(input: Readonly<{
  binding: EvmTypedAdapterMaterializerBinding;
  bounds: readonly EvmExactPerpLegBounds[];
}>): EvmStrategyLegMaterializer {
  return createEvmExactDerivativeMaterializer(input, FUTURE_CLASS_ID, 'FUTURE_');
}

export function createEvmExactVaultMaterializer(input: Readonly<{
  binding: EvmTypedAdapterMaterializerBinding;
  asset: AssetRef;
  shares: AssetRef;
  bounds: readonly EvmExactVaultLegBounds[];
}>): EvmStrategyLegMaterializer {
  requireCondition(input.binding.materializationClassId === ERC4626_CLASS_ID, 'ERC-4626 materializer class mismatch');
  requireCondition(!sameAsset(input.asset, input.shares), 'ERC-4626 asset and share identities must differ');
  const checked = input.bounds.map((value) => {
    unsigned(value.minimumOutputAtoms, UINT256_MAX, `leg ${value.legId} minimum output`);
    unsigned(value.maximumOutputAtoms, UINT256_MAX, `leg ${value.legId} maximum output`);
    requireCondition(value.minimumOutputAtoms > 0n, `leg ${value.legId} minimum output must be positive`);
    requireCondition(value.minimumOutputAtoms <= value.maximumOutputAtoms, `leg ${value.legId} output range is inverted`);
    return value;
  });
  requireCondition(new Set(checked.map((value) => value.legId)).size === checked.length, 'ERC-4626 leg bounds repeat');
  return Object.freeze({
    ...input.binding,
    adapterAddress: getAddress(input.binding.adapterAddress),
    materialize(context: EvmStrategyLegMaterializationContext) {
      const leg = graphLeg(context);
      requireCondition(leg.legFamily === 'LEND' || leg.legFamily === 'WITHDRAW', `leg ${leg.legId} is not an ERC-4626 action`);
      requireCondition(leg.side === 'NONE', `ERC-4626 leg ${leg.legId} must not carry a trading side`);
      const expectedInput = leg.legFamily === 'LEND' ? input.asset : input.shares;
      requireCondition(sameAsset(leg.quantityAsset, expectedInput), `ERC-4626 leg ${leg.legId} input asset mismatch`);
      const matches = checked.filter((value) => value.legId === leg.legId);
      requireCondition(matches.length === 1, `leg ${leg.legId} must have exact ERC-4626 output bounds`);
      const bounds = matches[0]!;
      return Object.freeze({
        data: encodeAbiParameters(
          [{
            type: 'tuple',
            components: [
              { name: 'packageId', type: 'bytes32' },
              { name: 'orderHash', type: 'bytes32' },
              { name: 'quoteHash', type: 'bytes32' },
              { name: 'routeHash', type: 'bytes32' },
              { name: 'action', type: 'uint8' },
              { name: 'inputAtoms', type: 'uint256' },
              { name: 'minimumOutputAtoms', type: 'uint256' },
              { name: 'maximumOutputAtoms', type: 'uint256' },
            ],
          }],
          [{
            packageId: context.packageId,
            orderHash: context.orderHash,
            quoteHash: context.quoteHash,
            routeHash: context.routeHash,
            action: leg.legFamily === 'LEND' ? 1 : 2,
            inputAtoms: leg.quantityAtoms,
            minimumOutputAtoms: bounds.minimumOutputAtoms,
            maximumOutputAtoms: bounds.maximumOutputAtoms,
          }],
        ),
        gasLimit: input.binding.maximumGasLimit,
      });
    },
  });
}

export function createEvmAaveV3LendingMaterializer(input: Readonly<{
  binding: EvmTypedAdapterMaterializerBinding;
  collateralAsset: AssetRef;
  debtAsset: AssetRef;
  bounds: readonly EvmAaveV3LendingLegBounds[];
}>): EvmStrategyLegMaterializer {
  requireCondition(input.binding.materializationClassId === AAVE_V3_LENDING_CLASS_ID, 'Aave V3 materializer class mismatch');
  requireCondition(!sameAsset(input.collateralAsset, input.debtAsset), 'Aave V3 collateral and debt identities must differ');
  const checked = input.bounds.map((value) => {
    nonzeroHash(value.expectedPreAccountDataHash, `leg ${value.legId} pre-account data hash`);
    unsigned(value.minimumOutputAtoms, UINT256_MAX, `leg ${value.legId} minimum output`);
    unsigned(value.maximumOutputAtoms, UINT256_MAX, `leg ${value.legId} maximum output`);
    unsigned(value.minimumPostCollateralBase, UINT256_MAX, `leg ${value.legId} minimum collateral`);
    unsigned(value.maximumPostCollateralBase, UINT256_MAX, `leg ${value.legId} maximum collateral`);
    unsigned(value.minimumPostDebtBase, UINT256_MAX, `leg ${value.legId} minimum debt`);
    unsigned(value.maximumPostDebtBase, UINT256_MAX, `leg ${value.legId} maximum debt`);
    unsigned(value.minimumPostHealthFactor, UINT256_MAX, `leg ${value.legId} minimum health factor`);
    requireCondition(value.minimumOutputAtoms > 0n, `leg ${value.legId} minimum output must be positive`);
    requireCondition(value.minimumOutputAtoms <= value.maximumOutputAtoms, `leg ${value.legId} output range is inverted`);
    requireCondition(value.minimumPostCollateralBase <= value.maximumPostCollateralBase, `leg ${value.legId} collateral range is inverted`);
    requireCondition(value.minimumPostDebtBase <= value.maximumPostDebtBase, `leg ${value.legId} debt range is inverted`);
    return value;
  });
  requireCondition(new Set(checked.map((value) => value.legId)).size === checked.length, 'Aave V3 leg bounds repeat');
  return Object.freeze({
    ...input.binding,
    adapterAddress: getAddress(input.binding.adapterAddress),
    materialize(context: EvmStrategyLegMaterializationContext) {
      const leg = graphLeg(context);
      const actions = Object.freeze({
        LEND: 1,
        MARGIN_DEPOSIT: 1,
        WITHDRAW: 2,
        MARGIN_RELEASE: 2,
        BORROW: 3,
        REPAY: 4,
      } as const);
      const action = actions[leg.legFamily as keyof typeof actions];
      requireCondition(action !== undefined, `leg ${leg.legId} is not an Aave V3 lending action`);
      requireCondition(leg.side === 'NONE', `Aave V3 leg ${leg.legId} must not carry a trading side`);
      const expectedInput = action === 1 || action === 2 ? input.collateralAsset : input.debtAsset;
      requireCondition(sameAsset(leg.quantityAsset, expectedInput), `Aave V3 leg ${leg.legId} input asset mismatch`);
      const matches = checked.filter((value) => value.legId === leg.legId);
      requireCondition(matches.length === 1, `leg ${leg.legId} must have exact Aave V3 bounds`);
      const bounds = matches[0]!;
      return Object.freeze({
        data: encodeAbiParameters(
          [{
            type: 'tuple',
            components: [
              { name: 'packageId', type: 'bytes32' },
              { name: 'orderHash', type: 'bytes32' },
              { name: 'quoteHash', type: 'bytes32' },
              { name: 'routeHash', type: 'bytes32' },
              { name: 'expectedPreAccountDataHash', type: 'bytes32' },
              { name: 'action', type: 'uint8' },
              { name: 'inputAtoms', type: 'uint256' },
              { name: 'minimumOutputAtoms', type: 'uint256' },
              { name: 'maximumOutputAtoms', type: 'uint256' },
              { name: 'minimumPostCollateralBase', type: 'uint256' },
              { name: 'maximumPostCollateralBase', type: 'uint256' },
              { name: 'minimumPostDebtBase', type: 'uint256' },
              { name: 'maximumPostDebtBase', type: 'uint256' },
              { name: 'minimumPostHealthFactor', type: 'uint256' },
            ],
          }],
          [{
            packageId: context.packageId,
            orderHash: context.orderHash,
            quoteHash: context.quoteHash,
            routeHash: context.routeHash,
            expectedPreAccountDataHash: bounds.expectedPreAccountDataHash,
            action,
            inputAtoms: leg.quantityAtoms,
            minimumOutputAtoms: bounds.minimumOutputAtoms,
            maximumOutputAtoms: bounds.maximumOutputAtoms,
            minimumPostCollateralBase: bounds.minimumPostCollateralBase,
            maximumPostCollateralBase: bounds.maximumPostCollateralBase,
            minimumPostDebtBase: bounds.minimumPostDebtBase,
            maximumPostDebtBase: bounds.maximumPostDebtBase,
            minimumPostHealthFactor: bounds.minimumPostHealthFactor,
          }],
        ),
        gasLimit: input.binding.maximumGasLimit,
      });
    },
  });
}

export function createEvmPremiaV3OptionMaterializer(input: Readonly<{
  binding: EvmTypedAdapterMaterializerBinding;
  bounds: readonly EvmPremiaV3OptionLegBounds[];
}>): EvmStrategyLegMaterializer {
  requireCondition(input.binding.materializationClassId === PREMIA_V3_OPTION_CLASS_ID, 'Premia V3 materializer class mismatch');
  const checked = input.bounds.map((value) => {
    unsigned(value.premiumLimit, UINT256_MAX, `leg ${value.legId} premium limit`);
    unsigned(value.maximumInputAtoms, UINT256_MAX, `leg ${value.legId} maximum input`);
    unsigned(value.expectedPreLongs, UINT256_MAX, `leg ${value.legId} pre longs`);
    unsigned(value.expectedPreShorts, UINT256_MAX, `leg ${value.legId} pre shorts`);
    unsigned(value.expectedPostLongs, UINT256_MAX, `leg ${value.legId} post longs`);
    unsigned(value.expectedPostShorts, UINT256_MAX, `leg ${value.legId} post shorts`);
    requireCondition(value.minimumAccountTokenDelta <= value.maximumAccountTokenDelta, `leg ${value.legId} account delta range is inverted`);
    return value;
  });
  requireCondition(new Set(checked.map((value) => value.legId)).size === checked.length, 'Premia V3 option leg bounds repeat');
  return Object.freeze({
    ...input.binding,
    adapterAddress: getAddress(input.binding.adapterAddress),
    materialize(context: EvmStrategyLegMaterializationContext) {
      const leg = graphLeg(context);
      const trade = leg.legFamily === 'OPTION_BUY' || leg.legFamily === 'OPTION_SELL' || leg.legFamily === 'OPTION_MINT';
      const action = trade ? 1 : leg.legFamily === 'OPTION_EXERCISE' ? 2 : leg.legFamily === 'OPTION_CASH_SETTLE' ? 3 : 0;
      requireCondition(action !== 0, `leg ${leg.legId} is not a Premia V3 option action`);
      if (trade) requireCondition(leg.side === 'BUY' || leg.side === 'SELL', `Premia V3 trade leg ${leg.legId} requires a side`);
      const matches = checked.filter((value) => value.legId === leg.legId);
      requireCondition(matches.length === 1, `leg ${leg.legId} must have exact Premia V3 bounds`);
      const bounds = matches[0]!;
      if (trade) requireCondition(bounds.premiumLimit > 0n, `leg ${leg.legId} premium limit must be positive`);
      else requireCondition(bounds.premiumLimit === 0n && bounds.maximumInputAtoms === 0n, `leg ${leg.legId} settlement cannot carry trade funding`);
      return Object.freeze({
        data: encodeAbiParameters(
          [{
            type: 'tuple',
            components: [
              { name: 'packageId', type: 'bytes32' },
              { name: 'orderHash', type: 'bytes32' },
              { name: 'quoteHash', type: 'bytes32' },
              { name: 'routeHash', type: 'bytes32' },
              { name: 'action', type: 'uint8' },
              { name: 'isBuy', type: 'bool' },
              { name: 'size', type: 'uint256' },
              { name: 'premiumLimit', type: 'uint256' },
              { name: 'maximumInputAtoms', type: 'uint256' },
              { name: 'expectedPreLongs', type: 'uint256' },
              { name: 'expectedPreShorts', type: 'uint256' },
              { name: 'expectedPostLongs', type: 'uint256' },
              { name: 'expectedPostShorts', type: 'uint256' },
              { name: 'minimumAccountTokenDelta', type: 'int256' },
              { name: 'maximumAccountTokenDelta', type: 'int256' },
            ],
          }],
          [{
            packageId: context.packageId,
            orderHash: context.orderHash,
            quoteHash: context.quoteHash,
            routeHash: context.routeHash,
            action,
            isBuy: trade && leg.side === 'BUY',
            size: trade ? leg.quantityAtoms : 0n,
            premiumLimit: bounds.premiumLimit,
            maximumInputAtoms: bounds.maximumInputAtoms,
            expectedPreLongs: bounds.expectedPreLongs,
            expectedPreShorts: bounds.expectedPreShorts,
            expectedPostLongs: bounds.expectedPostLongs,
            expectedPostShorts: bounds.expectedPostShorts,
            minimumAccountTokenDelta: bounds.minimumAccountTokenDelta,
            maximumAccountTokenDelta: bounds.maximumAccountTokenDelta,
          }],
        ),
        gasLimit: input.binding.maximumGasLimit,
      });
    },
  });
}

export function createEvmExactInventoryMaterializer(input: Readonly<{
  binding: EvmTypedAdapterMaterializerBinding;
  inventoryAsset: AssetRef;
  bounds: readonly EvmExactInventoryLegBounds[];
}>): EvmStrategyLegMaterializer {
  requireCondition(input.binding.materializationClassId === INVENTORY_CUSTODY_CLASS_ID, 'inventory materializer class mismatch');
  const checked = input.bounds.map((value) => {
    unsigned(value.expectedPreInventoryAtoms, UINT256_MAX, `leg ${value.legId} pre inventory`);
    unsigned(value.expectedPostInventoryAtoms, UINT256_MAX, `leg ${value.legId} post inventory`);
    return value;
  });
  requireCondition(new Set(checked.map((value) => value.legId)).size === checked.length, 'inventory leg bounds repeat');
  return Object.freeze({
    ...input.binding,
    adapterAddress: getAddress(input.binding.adapterAddress),
    materialize(context: EvmStrategyLegMaterializationContext) {
      const leg = graphLeg(context);
      requireCondition(leg.legFamily === 'INVENTORY_TRANSFER', `leg ${leg.legId} is not an inventory transfer`);
      requireCondition(sameAsset(leg.quantityAsset, input.inventoryAsset), `inventory leg ${leg.legId} asset mismatch`);
      const matches = checked.filter((value) => value.legId === leg.legId);
      requireCondition(matches.length === 1, `leg ${leg.legId} must have exact inventory bounds`);
      const bounds = matches[0]!;
      const expectedDifference = bounds.action === 'LOCK'
        ? bounds.expectedPostInventoryAtoms - bounds.expectedPreInventoryAtoms
        : bounds.expectedPreInventoryAtoms - bounds.expectedPostInventoryAtoms;
      requireCondition(expectedDifference === leg.quantityAtoms, `leg ${leg.legId} inventory change differs from quantity`);
      return Object.freeze({
        data: encodeAbiParameters(
          [{
            type: 'tuple',
            components: [
              { name: 'packageId', type: 'bytes32' },
              { name: 'orderHash', type: 'bytes32' },
              { name: 'quoteHash', type: 'bytes32' },
              { name: 'routeHash', type: 'bytes32' },
              { name: 'action', type: 'uint8' },
              { name: 'inputAtoms', type: 'uint256' },
              { name: 'expectedPreInventoryAtoms', type: 'uint256' },
              { name: 'expectedPostInventoryAtoms', type: 'uint256' },
            ],
          }],
          [{
            packageId: context.packageId,
            orderHash: context.orderHash,
            quoteHash: context.quoteHash,
            routeHash: context.routeHash,
            action: bounds.action === 'LOCK' ? 1 : 2,
            inputAtoms: leg.quantityAtoms,
            expectedPreInventoryAtoms: bounds.expectedPreInventoryAtoms,
            expectedPostInventoryAtoms: bounds.expectedPostInventoryAtoms,
          }],
        ),
        gasLimit: input.binding.maximumGasLimit,
      });
    },
  });
}
