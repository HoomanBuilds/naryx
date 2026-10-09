import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import {
  BASE_SEPOLIA_CROSS_BATCH_RESIDUAL_EXECUTION_PATH,
  BASE_SEPOLIA_NETTING_RESIDUAL_EXECUTION_PATH,
  EvmNettingResidualRuntimeError,
  createBaseSepoliaNettingResidualExecutionInternalHandler,
} from '../src/index.js';

test('Base residual handler separates direct and pooled execution paths', async () => {
  const handler = createBaseSepoliaNettingResidualExecutionInternalHandler({
    async execute() {
      throw new EvmNettingResidualRuntimeError('EVIDENCE_PENDING', 'pending');
    },
  });
  const server = createServer(async (request, response) => {
    if (!(await handler(request, response))) response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server is unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  const direct = stringifyProtocolJson({
    intent: { domain: { domainId: 'eip155:84532' } },
    idempotencyKey: '11'.repeat(32),
  });
  const pooled = stringifyProtocolJson({
    intent: { domain: { domainId: 'eip155:84532' }, clearingPlanHash: '22'.repeat(32) },
    idempotencyKey: '11'.repeat(32),
  });
  try {
    assert.equal((await fetch(`${origin}${BASE_SEPOLIA_NETTING_RESIDUAL_EXECUTION_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: direct,
    })).status, 409);
    assert.equal((await fetch(`${origin}${BASE_SEPOLIA_CROSS_BATCH_RESIDUAL_EXECUTION_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pooled,
    })).status, 409);
    assert.equal((await fetch(`${origin}${BASE_SEPOLIA_NETTING_RESIDUAL_EXECUTION_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pooled,
    })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});
