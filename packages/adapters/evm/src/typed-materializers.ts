import { bytesEqual, type AssetRef } from '@naryx/protocol-types';
import { encodeAbiParameters, getAddress, type Hex } from 'viem';
import type {
  EvmStrategyLegMaterializationContext,
  EvmStrategyLegMaterializer,
} from './strategy-plan.js';

const SPOT_CLASS_ID = 'naryx.evm.spot-exact';
const PERP_CLASS_ID = 'naryx.evm.perp-exact';
const ERC4626_CLASS_ID = 'naryx.evm.erc4626-exact';
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

export function createEvmExactPerpMaterializer(input: Readonly<{
  binding: EvmTypedAdapterMaterializerBinding;
  bounds: readonly EvmExactPerpLegBounds[];
}>): EvmStrategyLegMaterializer {
  requireCondition(input.binding.materializationClassId === PERP_CLASS_ID, 'perpetual materializer class mismatch');
  const checked = input.bounds.map(checkedPerpBounds);
  requireCondition(new Set(checked.map((value) => value.legId)).size === checked.length, 'perpetual leg bounds repeat');
  return Object.freeze({
    ...input.binding,
    adapterAddress: getAddress(input.binding.adapterAddress),
    materialize(context: EvmStrategyLegMaterializationContext) {
      const leg = graphLeg(context);
      requireCondition(leg.legFamily.startsWith('PERP_'), `leg ${leg.legId} is not a perpetual action`);
      const matches = checked.filter((value) => value.legId === leg.legId);
      requireCondition(matches.length === 1, `leg ${leg.legId} must have exact perpetual bounds`);
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
