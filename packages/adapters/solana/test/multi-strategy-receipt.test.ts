import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  decodeSolanaMultiStrategyReceipt,
  solanaMultiStrategyReceiptHash,
} from '../src/index.js';

const bytes = (value: number) => new Uint8Array(32).fill(value);

test('decodes the exact Anchor strategy receipt layout and verifies its hash', () => {
  const executionHash = bytes(20);
  const callsHash = bytes(10);
  const evidenceRoot = bytes(11);
  const receiptHash = solanaMultiStrategyReceiptHash({ executionHash, callsHash, evidenceRoot });
  const data = Buffer.alloc(379);
  createHash('sha256').update('account:StrategyReceipt', 'ascii').digest().copy(data, 0, 0, 8);
  let offset = 8;
  data[offset++] = 1;
  for (const value of [bytes(1), bytes(2), bytes(3), bytes(4), bytes(5)]) {
    Buffer.from(value).copy(data, offset);
    offset += 32;
  }
  data[offset++] = 0;
  for (const value of [bytes(8), bytes(9), callsHash, evidenceRoot, receiptHash]) {
    Buffer.from(value).copy(data, offset);
    offset += 32;
  }
  data.writeBigUInt64LE(12n, offset);
  offset += 8;
  const solver = new PublicKey(bytes(13));
  solver.toBuffer().copy(data, offset);
  offset += 32;
  data.writeBigUInt64LE(14n, offset);
  offset += 8;
  data[offset++] = 15;

  const receipt = decodeSolanaMultiStrategyReceipt(data);
  assert.equal(offset, data.length);
  assert.equal(receipt.operation, 'ENTRY');
  assert.equal(receipt.nonce, 12n);
  assert.equal(receipt.executionSlot, 14n);
  assert.equal(receipt.solver.toBase58(), solver.toBase58());
  assert.deepEqual(receipt.receiptHash, receiptHash);
});

test('rejects another account type and an unsupported operation', () => {
  assert.throws(() => decodeSolanaMultiStrategyReceipt(new Uint8Array(379)), /discriminator/);
  const data = Buffer.alloc(379);
  createHash('sha256').update('account:StrategyReceipt', 'ascii').digest().copy(data, 0, 0, 8);
  data[8] = 1;
  data[8 + 1 + (32 * 5)] = 8;
  assert.throws(() => decodeSolanaMultiStrategyReceipt(data), /operation/);
});
