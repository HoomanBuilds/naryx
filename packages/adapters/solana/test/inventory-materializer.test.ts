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
  createInitializeSolanaPackageInventoryInstruction,
  createSolanaExactInventoryMaterializer,
  type SolanaStrategyLegMaterializationContext,
  type SolanaTypedAdapterMaterializerBinding,
} from '../src/index.js';

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);
const address = (value: number): PublicKey => new PublicKey(bytes(value));
const domain = domainRef('svm:local-inventory', 1, bytes(1));
const adapter = adapterRef({ adapterId: 'inventory-adapter', adapterManifestVersion: 1, adapterManifestHash: bytes(2) });
const venue = versionedManifestRef('inventory-venue', 1, bytes(3));
const market = versionedManifestRef('inventory-market', 1, bytes(4));
const asset = assetRef('inventory-asset', hash32(bytes(5)), 6);
const programId = address(6);
const strategyAccount = address(7);
const strategyToken = address(8);
const mint = address(9);
const packageId = bytes(10);

const binding: SolanaTypedAdapterMaterializerBinding = {
  domain,
  adapter,
  venue,
  market,
  legFamily: 'INVENTORY_TRANSFER',
  materializationClassId: 'naryx.solana.inventory-transfer',
  programId,
  expectedProgramDataHash: bytes(11),
  maximumComputeUnitLimit: 90_000,
};

function context(quantityAtoms = 25n): SolanaStrategyLegMaterializationContext {
  return {
    packageId,
    orderHash: bytes(12),
    quoteHash: bytes(13),
    routeHash: bytes(14),
    routeLeg: { legId: 'inventory-leg' },
    graph: {
      legs: [{
        legId: 'inventory-leg',
        legFamily: 'INVENTORY_TRANSFER',
        quantityAsset: asset,
        quantityAtoms,
      }],
    },
  } as unknown as SolanaStrategyLegMaterializationContext;
}

test('materializes exact package inventory custody and matching provisioning addresses', () => {
  const materializer = createSolanaExactInventoryMaterializer({
    binding,
    inventoryAsset: asset,
    strategyAccount,
    strategyToken,
    mint,
    bounds: [{
      legId: 'inventory-leg',
      action: 'LOCK',
      expectedPreInventoryAtoms: 10n,
      expectedPostInventoryAtoms: 35n,
    }],
  });
  const result = materializer.materialize(context());
  const provision = createInitializeSolanaPackageInventoryInstruction({
    programId,
    payer: address(15),
    strategyAccount,
    packageId,
    mint,
  });
  assert.equal(result.instruction.data.subarray(0, 8).toString('hex'), '88c3a5ee7e09042c');
  assert.equal(result.instruction.data.readUInt32LE(8), 153);
  assert.equal(result.instruction.data.readUInt8(8 + 4 + 128), 1);
  assert.equal(result.instruction.data.readBigUInt64LE(8 + 4 + 129), 25n);
  assert.equal(result.instruction.keys[1]?.pubkey.toBase58(), provision.inventory.toBase58());
  assert.equal(result.instruction.keys[3]?.pubkey.toBase58(), provision.vault.toBase58());
  assert.equal(result.instruction.keys[0]?.isSigner, true);
  assert.equal(provision.instruction.data.subarray(0, 8).toString('hex'), '98dae2553638ea20');
});

test('rejects an inventory bound that differs from the graph quantity', () => {
  const materializer = createSolanaExactInventoryMaterializer({
    binding,
    inventoryAsset: asset,
    strategyAccount,
    strategyToken,
    mint,
    bounds: [{
      legId: 'inventory-leg',
      action: 'RELEASE',
      expectedPreInventoryAtoms: 35n,
      expectedPostInventoryAtoms: 11n,
    }],
  });
  assert.throws(() => materializer.materialize(context()), /inventory change differs from quantity/);
});
