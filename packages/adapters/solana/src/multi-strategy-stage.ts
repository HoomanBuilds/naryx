import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import type { SolanaMultiStrategyEnvelope } from './multi-strategy-account.js';

const STAGE_SEED = Buffer.from('strategy-stage');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MAX_STAGE_BYTES = 4096;
const STAGE_CHUNK_BYTES = 512;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`, 'ascii').digest().subarray(0, 8);
}

function u64(value: bigint): Buffer {
  requireCondition(value >= 0n && value <= (1n << 64n) - 1n, 'stage nonce or deadline exceeds u64');
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function u16(value: number): Buffer {
  requireCondition(Number.isInteger(value) && value >= 0 && value <= 0xffff, 'stage offset exceeds u16');
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function vector(bytes: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, Buffer.from(bytes)]);
}

export interface SolanaMultiStrategyStagePlan {
  readonly address: PublicKey;
  readonly payloadHash: Uint8Array;
  readonly payloadLength: number;
  readonly instructions: readonly TransactionInstruction[];
  readonly cancelInstruction: TransactionInstruction;
  readonly finalEnvelope: SolanaMultiStrategyEnvelope;
}

export function compileSolanaMultiStrategyStagePlan(envelope: SolanaMultiStrategyEnvelope): SolanaMultiStrategyStagePlan {
  const program = envelope.instruction.programId;
  requireCondition(envelope.instruction.data.length >= 9 && envelope.instruction.data.length - 8 <= MAX_STAGE_BYTES,
    'multi-strategy execution payload exceeds the staging limit');
  requireCondition(envelope.instruction.data.subarray(0, 8).equals(discriminator('execute_multi_strategy')),
    'only a normal multi-strategy execution can be staged');
  requireCondition(envelope.requiredSignerPubkeys.length === 2
    && envelope.instruction.keys[0]?.pubkey.equals(envelope.owner) === true
    && envelope.instruction.keys[1]?.pubkey.equals(envelope.solver) === true,
  'staged execution requires distinct owner and solver signers');
  requireCondition(envelope.instruction.keys[14]?.pubkey.equals(TOKEN_PROGRAM_ID) === true
    && envelope.instruction.keys[15]?.pubkey.equals(SystemProgram.programId) === true,
  'multi-strategy base account layout is unsupported');
  const payload = envelope.instruction.data.subarray(8);
  const payloadHash = createHash('sha256').update(payload).digest();
  const address = PublicKey.findProgramAddressSync([
    STAGE_SEED, envelope.strategyAccount.toBuffer(), u64(envelope.nonce).reverse(),
  ], program)[0];
  const owner = { pubkey: envelope.owner, isSigner: true, isWritable: true };
  const strategyAccount = { pubkey: envelope.strategyAccount, isSigner: false, isWritable: false };
  const stage = { pubkey: address, isSigner: false, isWritable: true };
  const initialize = new TransactionInstruction({
    programId: program,
    keys: [owner, strategyAccount, stage, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
    data: Buffer.concat([
      discriminator('initialize_execution_stage'),
      u64(envelope.nonce), envelope.solver.toBuffer(), payloadHash,
      u16(payload.length), u64(envelope.deadlineSlot),
    ]),
  });
  const writes = Array.from({ length: Math.ceil(payload.length / STAGE_CHUNK_BYTES) }, (_, index) => {
    const offset = index * STAGE_CHUNK_BYTES;
    return new TransactionInstruction({
      programId: program,
      keys: [owner, strategyAccount, stage],
      data: Buffer.concat([
        discriminator('write_execution_stage'),
        u16(offset), vector(payload.subarray(offset, offset + STAGE_CHUNK_BYTES)),
      ]),
    });
  });
  const seal = new TransactionInstruction({
    programId: program,
    keys: [owner, strategyAccount, stage],
    data: discriminator('seal_execution_stage'),
  });
  const cancelInstruction = new TransactionInstruction({
    programId: program,
    keys: [owner, strategyAccount, stage],
    data: discriminator('cancel_execution_stage'),
  });
  const finalInstruction = new TransactionInstruction({
    programId: program,
    keys: [
      ...envelope.instruction.keys.slice(0, 14),
      stage,
      ...envelope.instruction.keys.slice(14),
    ],
    data: Buffer.concat([
      discriminator('execute_staged_multi_strategy'),
      Buffer.from(envelope.packageId),
      u64(envelope.nonce),
    ]),
  });
  return Object.freeze({
    address,
    payloadHash: Uint8Array.from(payloadHash),
    payloadLength: payload.length,
    instructions: Object.freeze([initialize, ...writes, seal]),
    cancelInstruction,
    finalEnvelope: Object.freeze({ ...envelope, instruction: finalInstruction }),
  });
}
