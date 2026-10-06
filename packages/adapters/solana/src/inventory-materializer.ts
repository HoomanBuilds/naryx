import {
  bytesEqual,
  type AssetRef,
} from '@naryx/protocol-types';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import type {
  SolanaStrategyLegMaterializationContext,
  SolanaStrategyLegMaterializer,
} from './strategy-plan.js';

const INVENTORY_CLASS_ID = 'naryx.solana.inventory-transfer';
const EXECUTE_DISCRIMINATOR = Buffer.from('88c3a5ee7e09042c', 'hex');
const INITIALIZE_DISCRIMINATOR = Buffer.from('98dae2553638ea20', 'hex');
const INVENTORY_SEED = Buffer.from('package-inventory', 'ascii');
const VAULT_SEED = Buffer.from('package-inventory-vault', 'ascii');
const LEGACY_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const U64_MAX = (1n << 64n) - 1n;

export type SolanaTypedAdapterMaterializerBinding = Omit<SolanaStrategyLegMaterializer, 'materialize'>;

export interface SolanaExactInventoryLegBounds {
  readonly legId: string;
  readonly action: 'LOCK' | 'RELEASE';
  readonly expectedPreInventoryAtoms: bigint;
  readonly expectedPostInventoryAtoms: bigint;
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

function hash32(value: Uint8Array, context: string): Uint8Array {
  requireCondition(value.length === 32 && value.some((byte) => byte !== 0), `${context} must be a nonzero 32-byte value`);
  return Uint8Array.from(value);
}

function u64(value: bigint, context: string): Buffer {
  requireCondition(typeof value === 'bigint' && value >= 0n && value <= U64_MAX, `${context} must fit u64`);
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64LE(value);
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

export function deriveSolanaPackageInventoryAddresses(input: Readonly<{
  programId: PublicKey | string;
  strategyAccount: PublicKey | string;
  packageId: Uint8Array;
  mint: PublicKey | string;
}>): Readonly<{ inventory: PublicKey; vault: PublicKey }> {
  const programId = key(input.programId, 'inventory adapter program');
  const strategyAccount = key(input.strategyAccount, 'strategy account');
  const mint = key(input.mint, 'inventory mint');
  const packageId = hash32(input.packageId, 'package id');
  const inventory = PublicKey.findProgramAddressSync(
    [INVENTORY_SEED, strategyAccount.toBuffer(), Buffer.from(packageId), mint.toBuffer()],
    programId,
  )[0];
  const vault = PublicKey.findProgramAddressSync([VAULT_SEED, inventory.toBuffer()], programId)[0];
  return Object.freeze({ inventory, vault });
}

export function createInitializeSolanaPackageInventoryInstruction(input: Readonly<{
  programId: PublicKey | string;
  payer: PublicKey | string;
  strategyAccount: PublicKey | string;
  packageId: Uint8Array;
  mint: PublicKey | string;
}>): Readonly<{ instruction: TransactionInstruction; inventory: PublicKey; vault: PublicKey }> {
  const programId = key(input.programId, 'inventory adapter program');
  const payer = key(input.payer, 'inventory payer');
  const strategyAccount = key(input.strategyAccount, 'strategy account');
  const mint = key(input.mint, 'inventory mint');
  const packageId = hash32(input.packageId, 'package id');
  const { inventory, vault } = deriveSolanaPackageInventoryAddresses({ programId, strategyAccount, packageId, mint });
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: strategyAccount, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: inventory, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: LEGACY_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([INITIALIZE_DISCRIMINATOR, Buffer.from(packageId)]),
  });
  return Object.freeze({ instruction, inventory, vault });
}

export function createSolanaExactInventoryMaterializer(input: Readonly<{
  binding: SolanaTypedAdapterMaterializerBinding;
  inventoryAsset: AssetRef;
  strategyAccount: PublicKey | string;
  strategyToken: PublicKey | string;
  mint: PublicKey | string;
  bounds: readonly SolanaExactInventoryLegBounds[];
}>): SolanaStrategyLegMaterializer {
  requireCondition(input.binding.materializationClassId === INVENTORY_CLASS_ID, 'inventory materializer class mismatch');
  requireCondition(input.binding.legFamily === 'INVENTORY_TRANSFER', 'inventory materializer family mismatch');
  const programId = key(input.binding.programId, 'inventory adapter program');
  const strategyAccount = key(input.strategyAccount, 'strategy account');
  const strategyToken = key(input.strategyToken, 'strategy token account');
  const mint = key(input.mint, 'inventory mint');
  const checked = input.bounds.map((value) => {
    u64(value.expectedPreInventoryAtoms, `leg ${value.legId} pre inventory`);
    u64(value.expectedPostInventoryAtoms, `leg ${value.legId} post inventory`);
    return value;
  });
  requireCondition(new Set(checked.map((value) => value.legId)).size === checked.length, 'inventory leg bounds repeat');
  return Object.freeze({
    ...input.binding,
    programId,
    materialize(context: SolanaStrategyLegMaterializationContext) {
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
      u64(leg.quantityAtoms, `leg ${leg.legId} quantity`);
      const packageId = hash32(context.packageId, 'package id');
      const { inventory, vault } = deriveSolanaPackageInventoryAddresses({ programId, strategyAccount, packageId, mint });
      const payload = Buffer.concat([
        Buffer.from(packageId),
        Buffer.from(hash32(context.orderHash, 'order hash')),
        Buffer.from(hash32(context.quoteHash, 'quote hash')),
        Buffer.from(hash32(context.routeHash, 'route hash')),
        Buffer.from([bounds.action === 'LOCK' ? 1 : 2]),
        u64(leg.quantityAtoms, `leg ${leg.legId} quantity`),
        u64(bounds.expectedPreInventoryAtoms, `leg ${leg.legId} pre inventory`),
        u64(bounds.expectedPostInventoryAtoms, `leg ${leg.legId} post inventory`),
      ]);
      return Object.freeze({
        computeUnitLimit: input.binding.maximumComputeUnitLimit,
        instruction: new TransactionInstruction({
          programId,
          keys: [
            { pubkey: strategyAccount, isSigner: true, isWritable: false },
            { pubkey: inventory, isSigner: false, isWritable: false },
            { pubkey: strategyToken, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: LEGACY_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([EXECUTE_DISCRIMINATOR, vec(payload)]),
        }),
      });
    },
  });
}
