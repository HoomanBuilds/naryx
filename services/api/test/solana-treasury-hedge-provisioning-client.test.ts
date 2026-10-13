import assert from 'node:assert/strict';
import test from 'node:test';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { HttpSolanaTreasuryHedgeProvisioningClient } from '../src/solana-treasury-hedge-provisioning-client.js';

const orderHash = '11'.repeat(32);
const owner = Keypair.generate().publicKey.toBase58();
const strategyAccount = Keypair.generate().publicKey.toBase58();

function responseFor(packageId: string) {
  return new Response(stringifyProtocolJson({
    version: 1,
    orderHash,
    provisioning: {
      version: 1,
      domainId: 'svm:devnet',
      owner,
      packageId,
      strategyAccount,
      ready: false,
      inventoryFundingRequiredAtoms: 1_000_000n,
      quoteFundingRequiredAtoms: 2_000_000n,
      steps: [{
        kind: 'CREATE_STRATEGY_ACCOUNT',
        label: 'Create the strategy account.',
        instructions: [{
          programId: SystemProgram.programId.toBase58(),
          accounts: [{ pubkey: owner, isSigner: true, isWritable: true }],
          dataBase64: 'AQ==',
        }],
      }],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('accepts an unsigned Solana provisioning plan bound to the order', async () => {
  const client = new HttpSolanaTreasuryHedgeProvisioningClient('http://127.0.0.1:8788', async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:8788/internal/strategy-executions/solana-provision');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { orderHash });
    return responseFor(orderHash);
  });

  const result = await client.provision(orderHash);
  assert.equal(result.packageId, orderHash);
  assert.equal(result.inventoryFundingRequiredAtoms, 1_000_000n);
  assert.equal(result.steps[0]?.instructions[0]?.programId, SystemProgram.programId.toBase58());
});

test('accepts a lifecycle Solana provisioning plan with a distinct package id', async () => {
  const client = new HttpSolanaTreasuryHedgeProvisioningClient(
    'http://127.0.0.1:8788',
    async () => responseFor('22'.repeat(32)),
  );

  assert.equal((await client.provision(orderHash)).packageId, '22'.repeat(32));
});

test('binds quote-aware provisioning to its order and rejects invalid quote hashes', async () => {
  const quoteHash = '33'.repeat(32);
  const client = new HttpSolanaTreasuryHedgeProvisioningClient('http://127.0.0.1:8788', async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { orderHash, quoteHash });
    return responseFor(orderHash);
  });
  assert.equal((await client.provision(orderHash, quoteHash)).packageId, orderHash);
  await assert.rejects(() => client.provision(orderHash, 'BAD'), /quoteHash must be 32 bytes/);
});

test('rejects a Solana provisioning response for a different order', async () => {
  const client = new HttpSolanaTreasuryHedgeProvisioningClient(
    'http://127.0.0.1:8788',
    async () => new Response(stringifyProtocolJson({
      version: 1,
      orderHash: '22'.repeat(32),
      provisioning: { packageId: '22'.repeat(32) },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );

  await assert.rejects(() => client.provision(orderHash), /provisioning response fields are invalid/);
});
