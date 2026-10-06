import assert from 'node:assert/strict';
import test from 'node:test';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import { HttpEvmStrategyExecutionAuthorizationClient } from '../src/evm-strategy-execution-authorization-client.js';

const quoteHash = '11'.repeat(32);
const ownerSignature = `0x${'22'.repeat(65)}`;

test('accepts one exact testnet strategy authorization transaction', async () => {
  const client = new HttpEvmStrategyExecutionAuthorizationClient('http://127.0.0.1:8788', async (_input, init) => {
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { quoteHash, ownerSignature });
    return new Response(stringifyProtocolJson({
      version: 1,
      authorization: {
        version: 1,
        chainId: 84_532,
        to: '0x1111111111111111111111111111111111111111',
        value: 0n,
        data: '0x12345678',
        ownerSignature,
        solverSignature: `0x${'33'.repeat(65)}`,
        packageId: `0x${'44'.repeat(32)}`,
        orderHash: `0x${'55'.repeat(32)}`,
        quoteHash: `0x${quoteHash}`,
        routeHash: `0x${'66'.repeat(32)}`,
        expectedNextStateHash: `0x${'77'.repeat(32)}`,
        deadline: 1_000n,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await client.authorize(quoteHash, ownerSignature);
  assert.equal(result.chainId, 84_532);
  assert.equal(result.quoteHash, `0x${quoteHash}`);
  assert.equal(result.ownerSignature, ownerSignature);
});

test('rejects malformed authorization input before calling the solver', async () => {
  const client = new HttpEvmStrategyExecutionAuthorizationClient('http://127.0.0.1:8788', async () => {
    throw new Error('unexpected fetch');
  });
  await assert.rejects(() => client.authorize('AA'.repeat(32), ownerSignature), /quoteHash or ownerSignature is invalid/);
});
