import assert from 'node:assert/strict';
import test from 'node:test';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import {
  Keypair,
  PACKET_DATA_SIZE,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { HttpSolanaStrategyExecutionAuthorizationClient } from '../src/solana-strategy-execution-authorization-client.js';

const quoteHash = '11'.repeat(32);
const owner = Keypair.generate();
const solver = Keypair.generate();
const recentBlockhash = Keypair.generate().publicKey.toBase58();

function responseFor(signOwner = false): Response {
  const message = new TransactionMessage({
    payerKey: owner.publicKey,
    recentBlockhash,
    instructions: [new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: solver.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([1]),
    })],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign(signOwner ? [owner, solver] : [solver]);
  const transactionBytes = transaction.serialize();
  const messageBytes = message.serialize();
  const requiredSignerPubkeys = message.staticAccountKeys
    .slice(0, message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
  return new Response(stringifyProtocolJson({
    version: 1,
    authorization: {
      version: 1,
      domain: {
        domainId: 'svm:devnet',
        domainManifestVersion: 1,
        domainManifestHash: new Uint8Array(32).fill(2),
      },
      owner: owner.publicKey.toBase58(),
      solver: solver.publicKey.toBase58(),
      transactionBase64: Buffer.from(transactionBytes).toString('base64'),
      messageBase64: Buffer.from(messageBytes).toString('base64'),
      requiredSignerPubkeys,
      recentBlockhash,
      blockhashContextSlot: 100,
      lastValidBlockHeight: 500,
      strategyAccount: Keypair.generate().publicKey.toBase58(),
      position: Keypair.generate().publicKey.toBase58(),
      receipt: Keypair.generate().publicKey.toBase58(),
      packageId: '22'.repeat(32),
      orderHash: '33'.repeat(32),
      quoteHash,
      routeHash: '44'.repeat(32),
      executionHash: '55'.repeat(32),
      callsHash: '66'.repeat(32),
      materializationCommitment: '77'.repeat(32),
      lookupTables: [],
      evidence: {
        resolvedAddressCount: message.staticAccountKeys.length,
        serializedMessageBytes: messageBytes.length,
        serializedTransactionBytes: transactionBytes.length,
        packetDataLimit: PACKET_DATA_SIZE,
        computeUnitLimit: 600_000,
      },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('accepts an exact solver-partially-signed Solana Devnet transaction', async () => {
  const client = new HttpSolanaStrategyExecutionAuthorizationClient('http://127.0.0.1:8788', async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:8788/internal/strategy-executions/authorize-solana');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { quoteHash });
    return responseFor();
  });

  const result = await client.authorize(quoteHash);
  assert.equal(result.quoteHash, quoteHash);
  assert.equal(result.owner, owner.publicKey.toBase58());
  assert.equal(result.solver, solver.publicKey.toBase58());
});

test('rejects a transaction that already contains the owner signature', async () => {
  const client = new HttpSolanaStrategyExecutionAuthorizationClient(
    'http://127.0.0.1:8788',
    async () => responseFor(true),
  );
  await assert.rejects(client.authorize(quoteHash), /authorization transaction signatures are invalid/);
});
