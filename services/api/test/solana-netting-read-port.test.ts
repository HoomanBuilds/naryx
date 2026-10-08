import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { HttpSolanaDevnetReadOnlyRpc } from '../src/solana-devnet-runtime-ports.js';

test('reads finalized netting instructions and receipt state through signerless Solana RPC', async () => {
  const program = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
  const receipt = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
  const signature = bs58.encode(new Uint8Array(64).fill(3));
  const instructionData = new Uint8Array([4, 5, 6]);
  const receiptData = new Uint8Array([7, 8, 9]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    const result = request.method === 'getGenesisHash'
      ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
      : request.method === 'getTransaction'
        ? {
            slot: 123,
            transaction: {
              message: {
                accountKeys: [program, receipt],
                instructions: [{ programIdIndex: 0, accounts: [1], data: bs58.encode(instructionData) }],
              },
            },
            meta: { err: null, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [] },
          }
        : {
            context: { slot: 123 },
            value: { owner: program, data: [Buffer.from(receiptData).toString('base64'), 'base64'] },
          };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const rpc = new HttpSolanaDevnetReadOnlyRpc('https://solana-devnet.invalid');
    assert.equal(await rpc.genesisHash(), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
    const transaction = await rpc.finalizedTransaction(signature);
    assert.equal(transaction?.slot, 123n);
    assert.equal(transaction?.successful, true);
    assert.equal(transaction?.instructions[0]?.programId, program);
    assert.deepEqual(transaction?.instructions[0]?.accounts, [receipt]);
    assert.deepEqual(transaction?.instructions[0]?.data, instructionData);
    const account = await rpc.finalizedAccount(receipt);
    assert.equal(account?.address, receipt);
    assert.equal(account?.owner, program);
    assert.deepEqual(account?.data, receiptData);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
