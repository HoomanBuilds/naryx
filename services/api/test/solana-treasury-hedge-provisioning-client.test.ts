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

test('rejects a Solana provisioning plan bound to another order', async () => {
  const client = new HttpSolanaTreasuryHedgeProvisioningClient(
    'http://127.0.0.1:8788',
    async () => responseFor('22'.repeat(32)),
  );

  await assert.rejects(() => client.provision(orderHash), /provisioning plan identity is invalid/);
});
