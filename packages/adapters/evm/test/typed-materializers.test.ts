import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  assetRef,
  domainRef,
  hash32,
  versionedManifestRef,
  type AssetRef,
} from '@naryx/protocol-types';
import { decodeAbiParameters, hexToBytes, type Address, type Hex } from 'viem';
import {
  createEvmAaveV3LendingMaterializer,
  createEvmExactPerpMaterializer,
  createEvmExactSpotMaterializer,
  createEvmExactVaultMaterializer,
  type EvmStrategyLegMaterializationContext,
  type EvmTypedAdapterMaterializerBinding,
} from '../src/index.js';

const HASH_A = `0x${'11'.repeat(32)}` as Hex;
const HASH_B = `0x${'22'.repeat(32)}` as Hex;
const HASH_C = `0x${'33'.repeat(32)}` as Hex;
const HASH_D = `0x${'44'.repeat(32)}` as Hex;
const HASH_E = `0x${'55'.repeat(32)}` as Hex;
const HASH_F = `0x${'66'.repeat(32)}` as Hex;
const ADAPTER = '0x1111111111111111111111111111111111111111' as Address;

const bytes = (value: Hex) => hash32(hexToBytes(value));
const domain = domainRef('eip155:84532', 1, HASH_A);
const adapter = adapterRef({ adapterId: 'typed-adapter', adapterManifestVersion: 1, adapterManifestHash: HASH_B });
const venue = versionedManifestRef('venue', 1, HASH_C);
const market = versionedManifestRef('market', 1, HASH_D);
const base = assetRef('base', bytes(HASH_E), 18);
const quote = assetRef('quote', bytes(HASH_F), 6);

function binding(
  legFamily: EvmTypedAdapterMaterializerBinding['legFamily'],
  materializationClassId: string,
): EvmTypedAdapterMaterializerBinding {
  return {
    domain,
    adapter,
    venue,
    market,
    legFamily,
    materializationClassId,
    adapterAddress: ADAPTER,
    expectedAdapterCodeHash: HASH_E,
    maximumGasLimit: 400_000n,
  };
}

function context(input: Readonly<{
  legFamily: EvmTypedAdapterMaterializerBinding['legFamily'];
  side: 'BUY' | 'SELL' | 'NONE';
  quantityAtoms: bigint;
  marginDeltaAtoms: bigint;
  quantityAsset?: AssetRef;
  limitPrice?: Readonly<{ baseAsset: AssetRef; quoteAsset: AssetRef; baseAtoms: bigint; quoteAtoms: bigint }>;
}>): EvmStrategyLegMaterializationContext {
  return {
    packageId: HASH_A,
    orderHash: HASH_B,
    quoteHash: HASH_C,
    routeHash: HASH_D,
    routeLeg: { legId: 'leg' },
    graph: {
      legs: [{
        legId: 'leg',
        legFamily: input.legFamily,
        side: input.side,
        quantityAsset: input.quantityAsset ?? base,
        quantityAtoms: input.quantityAtoms,
        ...(input.limitPrice === undefined ? {} : { limitPrice: input.limitPrice }),
      }],
    },
    admission: {
      quote: {
        legEconomics: [{ legId: 'leg', marginDelta: { asset: quote, atoms: input.marginDeltaAtoms } }],
      },
    },
  } as unknown as EvmStrategyLegMaterializationContext;
}

test('materializes a signed spot limit into the exact typed adapter payload', () => {
  const materializer = createEvmExactSpotMaterializer({
    binding: binding('SPOT_SWAP', 'naryx.evm.spot-exact'),
    baseAsset: base,
    quoteAsset: quote,
  });
  const result = materializer.materialize(context({
    legFamily: 'SPOT_SWAP',
    side: 'BUY',
    quantityAtoms: 3n,
    marginDeltaAtoms: 0n,
    limitPrice: { baseAsset: base, quoteAsset: quote, baseAtoms: 1n, quoteAtoms: 2n },
  }));
  const [decoded] = decodeAbiParameters(
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
    result.data,
  );
  assert.equal(decoded.packageId, HASH_A);
  assert.equal(decoded.action, 1);
  assert.equal(decoded.baseAtoms, 3n);
  assert.equal(decoded.quoteBoundAtoms, 6n);
});

test('materializes exact ERC-4626 deposit and redemption bounds', () => {
  const lend = createEvmExactVaultMaterializer({
    binding: binding('LEND', 'naryx.evm.erc4626-exact'),
    asset: base,
    shares: quote,
    bounds: [{ legId: 'leg', minimumOutputAtoms: 90n, maximumOutputAtoms: 100n }],
  });
  const materialized = lend.materialize(context({
    legFamily: 'LEND',
    side: 'NONE',
    quantityAtoms: 100n,
    marginDeltaAtoms: 0n,
  }));
  const [deposit] = decodeAbiParameters(
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
    materialized.data,
  );
  assert.equal(deposit.action, 1);
  assert.equal(deposit.inputAtoms, 100n);
  assert.equal(deposit.minimumOutputAtoms, 90n);

  const redeem = createEvmExactVaultMaterializer({
    binding: binding('WITHDRAW', 'naryx.evm.erc4626-exact'),
    asset: base,
    shares: quote,
    bounds: [{ legId: 'leg', minimumOutputAtoms: 80n, maximumOutputAtoms: 110n }],
  });
  const redeemed = redeem.materialize(context({
    legFamily: 'WITHDRAW',
    side: 'NONE',
    quantityAtoms: 100n,
    quantityAsset: quote,
    marginDeltaAtoms: 0n,
  }));
  const [withdrawal] = decodeAbiParameters(
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
    redeemed.data,
  );
  assert.equal(withdrawal.action, 2);
  assert.equal(withdrawal.inputAtoms, 100n);
});

test('materializes package-isolated Aave V3 lending actions', () => {
  const materializer = createEvmAaveV3LendingMaterializer({
    binding: binding('BORROW', 'naryx.evm.aave-v3-lending-exact'),
    collateralAsset: base,
    debtAsset: quote,
    bounds: [{
      legId: 'leg',
      expectedPreAccountDataHash: HASH_E,
      minimumOutputAtoms: 100n,
      maximumOutputAtoms: 100n,
      minimumPostCollateralBase: 1_000n,
      maximumPostCollateralBase: 1_000n,
      minimumPostDebtBase: 100n,
      maximumPostDebtBase: 100n,
      minimumPostHealthFactor: 2_000n,
    }],
  });
  const materialized = materializer.materialize(context({
    legFamily: 'BORROW',
    side: 'NONE',
    quantityAtoms: 100n,
    quantityAsset: quote,
    marginDeltaAtoms: 0n,
  }));
  const [decoded] = decodeAbiParameters(
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
    materialized.data,
  );
  assert.equal(decoded.action, 3);
  assert.equal(decoded.inputAtoms, 100n);
  assert.equal(decoded.minimumPostHealthFactor, 2_000n);
});

test('materializes exact perpetual observations and enforces the quoted margin input', () => {
  const materializer = createEvmExactPerpMaterializer({
    binding: binding('PERP_OPEN', 'naryx.evm.perp-exact'),
    bounds: [{
      legId: 'leg',
      expectedPrePositionHash: HASH_E,
      tradeArgs: [HASH_A, HASH_B],
      expectedPostSizeWad: -10n,
      minimumPostBalanceWad: 50n,
      maximumPostBalanceWad: 60n,
      minimumPostEntryNotionalWad: 100n,
      maximumPostEntryNotionalWad: 110n,
      expectedReserveBeforeAtoms: 0n,
      minimumReserveAfterAtoms: 40n,
      maximumReserveAfterAtoms: 50n,
      collateralInAtoms: 100n,
      collateralOutAtoms: 0n,
      withdrawAll: false,
      minimumCollateralOutAtoms: 0n,
      maximumCollateralOutAtoms: 0n,
    }],
  });
  const materialized = materializer.materialize(context({
    legFamily: 'PERP_OPEN',
    side: 'SELL',
    quantityAtoms: 10n,
    marginDeltaAtoms: 100n,
  }));
  const [decoded] = decodeAbiParameters(
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
    materialized.data,
  );
  assert.equal(decoded.packageId, HASH_A);
  assert.equal(decoded.expectedPrePositionHash, HASH_E);
  assert.equal(decoded.expectedPostSizeWad, -10n);
  assert.equal(decoded.collateralInAtoms, 100n);

  assert.throws(
    () => materializer.materialize(context({
      legFamily: 'PERP_OPEN',
      side: 'SELL',
      quantityAtoms: 10n,
      marginDeltaAtoms: 99n,
    })),
    /collateral input differs from quoted margin/,
  );
});
