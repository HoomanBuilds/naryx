import assert from 'node:assert/strict';
import test from 'node:test';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import { HttpEvmReverseBasisCollateralClient } from '../src/evm-reverse-basis-collateral-client.js';

const quoteHash = '11'.repeat(32);

test('accepts only a quote-bound reverse basis collateral transaction plan', async () => {
  const client = new HttpEvmReverseBasisCollateralClient('http://127.0.0.1:8788', async (_input, init) => {
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { quoteHash, action: 'SUPPLY' });
    return new Response(stringifyProtocolJson({
      version: 1,
      collateral: {
        version: 1,
        chainId: 84_532,
        owner: '0x1111111111111111111111111111111111111111',
        strategyAccount: '0x2222222222222222222222222222222222222222',
        quoteHash: `0x${quoteHash}`,
        packageId: `0x${'33'.repeat(32)}`,
        intentHash: `0x${'44'.repeat(32)}`,
        action: 'SUPPLY',
        assetToken: '0x5555555555555555555555555555555555555555',
        inputAtoms: 150_000_000n,
        minimumOutputAtoms: 150_000_000n,
        maximumOutputAtoms: 150_000_000n,
        transactions: [{
          kind: 'MANAGE_PACKAGE_COLLATERAL',
          to: '0x2222222222222222222222222222222222222222',
          data: '0x12345678',
          value: 0n,
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await client.plan(quoteHash, 'SUPPLY');
  assert.equal(result.quoteHash, `0x${quoteHash}`);
  assert.equal(result.inputAtoms, 150_000_000n);
});

test('rejects a collateral plan bound to another quote', async () => {
  const client = new HttpEvmReverseBasisCollateralClient('http://127.0.0.1:8788', async () => new Response(
    stringifyProtocolJson({
      version: 1,
      collateral: {
        version: 1,
        chainId: 84_532,
        owner: '0x1111111111111111111111111111111111111111',
        strategyAccount: '0x2222222222222222222222222222222222222222',
        quoteHash: `0x${'99'.repeat(32)}`,
        packageId: `0x${'33'.repeat(32)}`,
        intentHash: `0x${'44'.repeat(32)}`,
        action: 'WITHDRAW',
        assetToken: '0x5555555555555555555555555555555555555555',
        inputAtoms: 1n,
        minimumOutputAtoms: 1n,
        maximumOutputAtoms: 1n,
        transactions: [],
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
  await assert.rejects(() => client.plan(quoteHash, 'WITHDRAW'), /collateral plan identity is invalid/);
});
