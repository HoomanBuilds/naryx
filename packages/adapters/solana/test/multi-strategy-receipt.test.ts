import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  decodeSolanaMultiStrategyReceipt,
  decodeSolanaStrategyAdapterLegEvent,
  solanaMultiStrategyEvidenceRoot,
  solanaMultiStrategyReceiptHash,
} from '../src/index.js';

const bytes = (value: number) => new Uint8Array(32).fill(value);

test('decodes the exact Anchor strategy receipt layout and verifies its hash', () => {
  const executionHash = bytes(20);
  const callsHash = bytes(10);
  const evidenceRoot = bytes(11);
  const receiptHash = solanaMultiStrategyReceiptHash({ executionHash, callsHash, evidenceRoot });
  const data = Buffer.alloc(532);
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
  const nettingAuthorizationHash = bytes(15);
  Buffer.from(nettingAuthorizationHash).copy(data, offset);
  offset += 32;
  data[offset++] = 0;
  Buffer.from(bytes(16)).copy(data, offset);
  offset += 32;
  data.writeUInt32LE(2, offset);
  offset += 4;
  Buffer.from(bytes(17)).copy(data, offset);
  offset += 32;
  data.writeUInt32LE(3, offset);
  offset += 4;
  Buffer.from(bytes(18)).copy(data, offset);
  offset += 32;
  data.writeBigUInt64LE(19n, offset);
  offset += 8;
  data.writeBigUInt64LE(20n, offset);
  offset += 8;
  data.writeBigUInt64LE(12n, offset);
  offset += 8;
  const solver = new PublicKey(bytes(13));
  solver.toBuffer().copy(data, offset);
  offset += 32;
  data.writeBigUInt64LE(14n, offset);
  offset += 8;
  data[offset++] = 16;

  const receipt = decodeSolanaMultiStrategyReceipt(data);
  assert.equal(offset, data.length);
  assert.equal(receipt.operation, 'ENTRY');
  assert.equal(receipt.nonce, 12n);
  assert.equal(receipt.executionSlot, 14n);
  assert.equal(receipt.solver.toBase58(), solver.toBase58());
  assert.deepEqual(receipt.receiptHash, receiptHash);
  assert.deepEqual(receipt.nettingAuthorizationHash, nettingAuthorizationHash);
  assert.equal(receipt.fees.direction, 'ENTRY');
  assert.equal(receipt.fees.quoteAssetManifestVersion, 2);
  assert.equal(receipt.fees.policyVersion, 3);
  assert.equal(receipt.fees.protocolFeeAtoms, 19n);
  assert.equal(receipt.fees.solverFeeAtoms, 20n);
});

test('rejects another account type and an unsupported operation', () => {
  assert.throws(() => decodeSolanaMultiStrategyReceipt(new Uint8Array(532)), /discriminator/);
  const data = Buffer.alloc(532);
  createHash('sha256').update('account:StrategyReceipt', 'ascii').digest().copy(data, 0, 0, 8);
  data[8] = 1;
  data[8 + 1 + (32 * 5)] = 8;
  assert.throws(() => decodeSolanaMultiStrategyReceipt(data), /operation/);
});

test('decodes adapter evidence events and preserves their ordered root', () => {
  const first = bytes(21);
  const second = bytes(22);
  const data = Buffer.alloc(106);
  createHash('sha256').update('event:StrategyAdapterLegExecuted', 'ascii').digest().copy(data, 0, 0, 8);
  const receipt = new PublicKey(bytes(23));
  receipt.toBuffer().copy(data, 8);
  data[40] = 1;
  Buffer.from(bytes(24)).copy(data, 41);
  data[73] = 2;
  Buffer.from(second).copy(data, 74);
  const event = decodeSolanaStrategyAdapterLegEvent(data);
  assert(event !== undefined);
  assert.equal(event.receipt.toBase58(), receipt.toBase58());
  assert.equal(event.callIndex, 1);
  assert.equal(event.stage, 2);
  assert.deepEqual(event.evidenceHash, second);
  const expected = createHash('sha256')
    .update('naryx.solana.multi-strategy.evidence.v1', 'ascii')
    .update(first)
    .update(second)
    .digest();
  assert.deepEqual(solanaMultiStrategyEvidenceRoot([first, second]), Uint8Array.from(expected));
});
