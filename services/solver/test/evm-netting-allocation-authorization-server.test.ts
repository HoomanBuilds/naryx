import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  fromProtocolJson,
  toHex,
  type Hash32,
} from '@naryx/protocol-types';
import {
  createEvmNettingAllocationAuthorizationInternalHandler,
  type NettingAllocationExecutionRequest,
} from '../src/index.js';

test('serves the exact EVM allocation challenge to loopback callers', async () => {
  let received: NettingAllocationExecutionRequest | undefined;
  const handler = createEvmNettingAllocationAuthorizationInternalHandler({
    challenge: async (input) => {
      received = input;
      return {
        version: 1,
        attemptId: input.attemptId,
        authorizationHash: `0x${'44'.repeat(32)}`,
        chainId: 84_532,
        owner: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        ownerTypedData: {},
      } as never;
    },
    authorize: async () => { throw new Error('not called'); },
  });
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/netting/allocation-executions/evm/challenge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proofHash: '11'.repeat(32),
          allocationReceiptHash: '22'.repeat(32),
          quoteHash: '33'.repeat(32),
          domainId: 'eip155:84532',
          attemptId: 'allocation-attempt-0001',
        }),
      },
    );
    assert.equal(response.status, 200);
    const payload = fromProtocolJson(await response.json()) as Record<string, unknown>;
    assert.equal(payload.version, 1);
    assert.equal((payload.challenge as Record<string, unknown>).attemptId, 'allocation-attempt-0001');
    assert.equal(received?.domainId, 'eip155:84532');
    assert.equal(toHex(received?.quoteHash as Hash32), '33'.repeat(32));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});
