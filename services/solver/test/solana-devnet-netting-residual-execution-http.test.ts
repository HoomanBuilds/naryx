import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import {
  SOLANA_DEVNET_CROSS_BATCH_RESIDUAL_EXECUTION_PATH,
  SOLANA_DEVNET_NETTING_RESIDUAL_EXECUTION_PATH,
  SolanaNettingResidualRuntimeError,
  createSolanaDevnetNettingResidualExecutionInternalHandler,
} from '../src/index.js';

test('Solana residual handler is loopback-only and preserves pending evidence', async () => {
  const handler = createSolanaDevnetNettingResidualExecutionInternalHandler({
    async execute() {
      throw new SolanaNettingResidualRuntimeError('EVIDENCE_PENDING', 'pending');
    },
  });
  const server = createServer(async (request, response) => {
    if (!(await handler(request, response))) response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server is unavailable');
  const url = `http://127.0.0.1:${address.port}${SOLANA_DEVNET_NETTING_RESIDUAL_EXECUTION_PATH}`;
  const request = stringifyProtocolJson({
    intent: { domain: { domainId: 'svm:devnet' } },
    idempotencyKey: '11'.repeat(32),
  });
  const pooled = stringifyProtocolJson({
    intent: { domain: { domainId: 'svm:devnet' }, clearingPlanHash: '22'.repeat(32) },
    idempotencyKey: '11'.repeat(32),
  });
  try {
    const pending = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request,
    });
    assert.equal(pending.status, 409);
    const forbidden = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: request,
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await fetch(
      `http://127.0.0.1:${address.port}${SOLANA_DEVNET_CROSS_BATCH_RESIDUAL_EXECUTION_PATH}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pooled },
    )).status, 409);
    assert.equal((await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pooled,
    })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});
