import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HttpNettingAllocationAuthorizationClient,
  NettingAllocationAuthorizationClientError,
} from '../src/index.js';

const request = {
  proofHash: '11'.repeat(32),
  allocationReceiptHash: '22'.repeat(32),
  quoteHash: '33'.repeat(32),
  domainId: 'eip155:84532',
  attemptId: 'allocation-attempt-0001',
} as const;
const authorizationHash = `0x${'44'.repeat(32)}`;
const executionHash = `0x${'55'.repeat(32)}`;
const callsHash = `0x${'66'.repeat(32)}`;
const owner = '0x1111111111111111111111111111111111111111';
const account = '0x2222222222222222222222222222222222222222';

test('validates an exact EVM netting owner challenge from the loopback solver', async () => {
  const client = new HttpNettingAllocationAuthorizationClient('http://127.0.0.1:8788', async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:8788/internal/netting/allocation-executions/evm/challenge');
    assert.equal(init?.method, 'POST');
    return new Response(JSON.stringify({
      version: 1,
      challenge: {
        version: 1,
        attemptId: request.attemptId,
        authorizationHash,
        chainId: 84_532,
        owner,
        to: account,
        ownerTypedData: {
          domain: {
            name: 'Naryx Multi Strategy Account',
            version: '1',
            chainId: 84_532,
            verifyingContract: account,
          },
          primaryType: 'NettingOwnerExecution',
          types: {
            NettingOwnerExecution: [
              { name: 'authorizationHash', type: 'bytes32' },
              { name: 'executionHash', type: 'bytes32' },
              { name: 'callsHash', type: 'bytes32' },
            ],
          },
          message: { authorizationHash, executionHash, callsHash },
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const challenge = await client.challengeEvm(request);
  assert.equal(challenge.authorizationHash, authorizationHash);
  assert.equal(challenge.owner, owner);
  assert.equal(challenge.ownerTypedData.message.executionHash, executionHash);
});

test('refuses mainnet and malformed allocation authorization requests before network access', async () => {
  const client = new HttpNettingAllocationAuthorizationClient('http://127.0.0.1:8788', async () => {
    throw new Error('not called');
  });
  assert.throws(
    () => client.challengeEvm({ ...request, domainId: 'eip155:1' }),
    (error: unknown) => error instanceof NettingAllocationAuthorizationClientError
      && error.code === 'INVALID_REQUEST',
  );
});
