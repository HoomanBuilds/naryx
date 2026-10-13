import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { domainRef } from '@naryx/protocol-types';
import { compileSolanaMultiStrategyStagePlan, type SolanaMultiStrategyEnvelope } from '../src/index.js';

const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const owner = key(1);
const solver = key(2);
const program = key(3);
const strategyAccount = key(4);
const executeDiscriminator = createHash('sha256').update('global:execute_multi_strategy').digest().subarray(0, 8);

function envelope(): SolanaMultiStrategyEnvelope {
  const base = Array.from({ length: 16 }, (_, index) => ({
    pubkey: index === 0 ? owner : index === 1 ? solver : index === 14 ? tokenProgram
      : index === 15 ? SystemProgram.programId : key(index + 10),
    isSigner: index < 2,
    isWritable: index === 0,
  }));
  return {
    instruction: new TransactionInstruction({
      programId: program,
      keys: [...base, { pubkey: key(40), isSigner: false, isWritable: true }],
      data: Buffer.concat([executeDiscriminator, Buffer.alloc(935, 7)]),
    }),
    executionHash: new Uint8Array(32).fill(5),
    callsHash: new Uint8Array(32).fill(6),
    domain: domainRef('svm:devnet', 1, '11'.repeat(32)),
    owner,
    solver,
    packageId: new Uint8Array(32).fill(7),
    orderHash: new Uint8Array(32).fill(8),
    graphHash: new Uint8Array(32).fill(9),
    quoteHash: new Uint8Array(32).fill(10),
    routeHash: new Uint8Array(32).fill(11),
    operation: 'ENTRY',
    previousStateHash: new Uint8Array(32),
    nextStateHash: new Uint8Array(32).fill(12),
    nonce: 7n,
    deadlineSlot: 500n,
    strategyAccount,
    position: key(5),
    receipt: key(6),
    requiredSignerPubkeys: [owner.toBase58(), solver.toBase58()].sort(),
  };
}

test('stages the exact execution bytes and leaves one compact atomic final instruction', () => {
  const original = envelope();
  const plan = compileSolanaMultiStrategyStagePlan(original);
  const nonce = Buffer.alloc(8);
  nonce.writeBigUInt64BE(7n);
  const expected = PublicKey.findProgramAddressSync([
    Buffer.from('strategy-stage'), strategyAccount.toBuffer(), nonce,
  ], program)[0];
  assert(plan.address.equals(expected));
  assert.equal(plan.payloadLength, 935);
  assert.equal(plan.instructions.length, 4);
  assert.equal(plan.instructions[1]?.data.readUInt16LE(8), 0);
  assert.equal(plan.instructions[2]?.data.readUInt16LE(8), 512);
  assert.equal(plan.finalEnvelope.instruction.data.length, 48);
  assert(plan.finalEnvelope.instruction.keys[14]?.pubkey.equals(expected));
  assert.equal(plan.finalEnvelope.instruction.keys.length, original.instruction.keys.length + 1);
  assert.deepEqual(Buffer.from(plan.payloadHash), createHash('sha256').update(original.instruction.data.subarray(8)).digest());
});

test('refuses unsupported and overlong execution payloads', () => {
  const original = envelope();
  assert.throws(() => compileSolanaMultiStrategyStagePlan({
    ...original,
    instruction: new TransactionInstruction({
      programId: program, keys: original.instruction.keys, data: Buffer.alloc(16),
    }),
  }), /only a normal multi-strategy execution can be staged/);
  assert.throws(() => compileSolanaMultiStrategyStagePlan({
    ...original,
    instruction: new TransactionInstruction({
      programId: program, keys: original.instruction.keys,
      data: Buffer.concat([executeDiscriminator, Buffer.alloc(4097)]),
    }),
  }), /exceeds the staging limit/);
});
