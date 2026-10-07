import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  assetRef,
  domainRef,
  hash32,
  versionedManifestRef,
} from '@naryx/protocol-types';
import { PublicKey } from '@solana/web3.js';
import {
  createSolanaOrcaSpotMaterializer,
  createSolanaTestPerpExactShortMaterializer,
  type SolanaStrategyLegMaterializationContext,
  type SolanaTypedAdapterMaterializerBinding,
} from '../src/index.js';

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);
const address = (value: number): PublicKey => new PublicKey(bytes(value));
const domain = domainRef('svm:local-venue', 1, bytes(1));
const adapter = adapterRef({ adapterId: 'venue-adapter', adapterManifestVersion: 1, adapterManifestHash: bytes(2) });
const venue = versionedManifestRef('venue', 1, bytes(3));
const market = versionedManifestRef('market', 1, bytes(4));
const base = assetRef('base', hash32(bytes(5)), 9);
const quote = assetRef('quote', hash32(bytes(6)), 6);

function binding(legFamily: SolanaTypedAdapterMaterializerBinding['legFamily'], classId: string): SolanaTypedAdapterMaterializerBinding {
  return {
    domain,
    adapter,
    venue,
    market,
    legFamily,
    materializationClassId: classId,
    programId: address(7),
    expectedProgramDataHash: bytes(8),
    maximumComputeUnitLimit: 250_000,
  };
}

function context(input: Readonly<{
  legFamily: SolanaTypedAdapterMaterializerBinding['legFamily'];
  side: 'BUY' | 'SELL';
  quantityAtoms: bigint;
}>): SolanaStrategyLegMaterializationContext {
  return {
    packageId: bytes(9),
    orderHash: bytes(10),
    quoteHash: bytes(11),
    routeHash: bytes(12),
    routeLeg: { legId: 'leg' },
    graph: {
      legs: [{
        legId: 'leg',
        legFamily: input.legFamily,
        side: input.side,
        quantityAsset: base,
        quantityAtoms: input.quantityAtoms,
        limitPrice: { baseAsset: base, quoteAsset: quote, baseAtoms: 2n, quoteAtoms: 5n },
      }],
    },
  } as unknown as SolanaStrategyLegMaterializationContext;
}

test('materializes exact Orca spot directions with adverse rounding', () => {
  const materializer = createSolanaOrcaSpotMaterializer({
    binding: binding('SPOT_SWAP', 'naryx.solana.spot-exact'),
    baseAsset: base,
    quoteAsset: quote,
    baseIsTokenA: true,
    accounts: {
      strategyAccount: address(13),
      tokenOwnerAccountA: address(14),
      tokenOwnerAccountB: address(15),
      tokenVaultA: address(16),
      tokenVaultB: address(17),
      whirlpool: address(18),
      tickArray0: address(19),
      tickArray1: address(20),
      tickArray2: address(21),
      oracle: address(22),
      tokenProgram: address(23),
      whirlpoolProgram: address(24),
    },
    bounds: [{ legId: 'leg', sqrtPriceLimit: 1n }],
  });
  const buy = materializer.materialize(context({ legFamily: 'SPOT_SWAP', side: 'BUY', quantityAtoms: 3n }));
  assert.equal(buy.instruction.data.subarray(12, 20).toString('hex'), '2d634cf2df70a8a2');
  assert.equal(buy.instruction.data.readBigUInt64LE(28), 8n);
  assert.equal(buy.instruction.data.readUInt8(52), 0);
  assert.equal(buy.instruction.data.readUInt8(53), 0);
});

test('materializes exact short lifecycle actions', () => {
  const create = (legFamily: SolanaTypedAdapterMaterializerBinding['legFamily']) => createSolanaTestPerpExactShortMaterializer({
    binding: binding(legFamily, 'naryx.solana.perp-exact'),
    baseAsset: base,
    quoteAsset: quote,
    baseLotAtoms: 10n,
    quoteAtomsPerTickPerBaseLot: 5n,
    accounts: {
      strategy: address(25),
      controller: address(26),
      testPerpProgram: address(27),
      market: address(28),
      position: address(29),
      oracle: address(30),
      collateralVault: address(31),
      feeVault: address(32),
      insuranceVault: address(33),
      tokenProgram: address(34),
    },
    bounds: [{
      legId: 'leg',
      lastValidSlot: 500n,
      minimumPostCollateralQuoteLots: 1n,
      clientOrderId: 9n,
    }],
  });
  const materializer = create('PERP_OPEN');
  const result = materializer.materialize(context({ legFamily: 'PERP_OPEN', side: 'SELL', quantityAtoms: 20n }));
  assert.equal(result.instruction.data.subarray(12, 20).toString('hex'), '69b83373ed514e70');
  assert.equal(result.instruction.data.readBigUInt64LE(20), 2n);
  assert.equal(result.instruction.data.readBigUInt64LE(28), 5n);
  assert.throws(
    () => materializer.materialize(context({ legFamily: 'PERP_OPEN', side: 'BUY', quantityAtoms: 20n })),
    /supported exact short lifecycle action/,
  );
  const increase = create('PERP_INCREASE').materialize(
    context({ legFamily: 'PERP_INCREASE', side: 'SELL', quantityAtoms: 10n }),
  );
  const decrease = create('PERP_DECREASE').materialize(
    context({ legFamily: 'PERP_DECREASE', side: 'BUY', quantityAtoms: 10n }),
  );
  assert.equal(increase.instruction.data.subarray(12, 20).toString('hex'), 'c51df14bfbb37adb');
  assert.equal(decrease.instruction.data.subarray(12, 20).toString('hex'), '3d99b8fd9f138c6d');
});
