import assert from 'node:assert/strict';
import test from 'node:test';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import { HttpEvmStrategyExecutionObservationClient } from '../src/evm-strategy-execution-observation-client.js';

const quoteHash = '11'.repeat(32);
const transactionHash = `0x${'22'.repeat(32)}`;

test('preserves pending EVM strategy finality without inventing a receipt', async () => {
  const client = new HttpEvmStrategyExecutionObservationClient('http://127.0.0.1:8788', async (_input, init) => {
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { quoteHash, transactionHash });
    return new Response(stringifyProtocolJson({
      version: 1,
      observation: { version: 1, status: 'PENDING_FINALITY', transactionHash },
    }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  });

  assert.deepEqual(await client.observe(quoteHash, transactionHash), {
    version: 1,
    status: 'PENDING_FINALITY',
    transactionHash,
  });
});

test('rejects malformed EVM observation identity before calling the solver', async () => {
  const client = new HttpEvmStrategyExecutionObservationClient('http://127.0.0.1:8788', async () => {
    throw new Error('unexpected fetch');
  });
  await assert.rejects(() => client.observe('AA'.repeat(32), transactionHash), /lowercase bytes32/);
});
