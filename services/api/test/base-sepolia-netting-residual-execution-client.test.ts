import assert from 'node:assert/strict';
import test from 'node:test';
import { stringifyProtocolJson, type NettingExternalExecutionIntent } from '@naryx/protocol-types';
import {
  API_BASE_SEPOLIA_NETTING_RESIDUAL_EXECUTION_PATH,
  BaseSepoliaNettingResidualExecutionClientError,
  HttpBaseSepoliaNettingResidualExecutionClient,
} from '../src/index.js';

const intent = {
  domain: { domainId: 'eip155:84532' },
  validUntilUnit: 'EVM_UNIX_SECONDS',
} as NettingExternalExecutionIntent;

test('routes Base Sepolia residual execution and preserves a pending evidence state', async () => {
  const client = new HttpBaseSepoliaNettingResidualExecutionClient(
    'http://127.0.0.1:8788',
    async (request, init) => {
      assert.equal(String(request),
        `http://127.0.0.1:8788${API_BASE_SEPOLIA_NETTING_RESIDUAL_EXECUTION_PATH}`);
      assert.equal(init?.method, 'POST');
      return new Response(stringifyProtocolJson({
        error: { code: 'EVIDENCE_PENDING', message: 'pending' },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    },
  );
  assert.equal(client.supports(intent), true);
  await assert.rejects(
    client.execute({ intent, idempotencyKey: '00'.repeat(32) }),
    (error: unknown) => error instanceof BaseSepoliaNettingResidualExecutionClientError
      && error.code === 'EVIDENCE_PENDING',
  );
});
