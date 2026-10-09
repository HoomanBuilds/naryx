import assert from 'node:assert/strict';
import test from 'node:test';
import {
  stringifyProtocolJson,
  type CrossBatchExternalExecutionIntent,
  type NettingExternalExecutionIntent,
} from '@naryx/protocol-types';
import {
  API_SOLANA_DEVNET_CROSS_BATCH_RESIDUAL_EXECUTION_PATH,
  API_SOLANA_DEVNET_NETTING_RESIDUAL_EXECUTION_PATH,
  HttpSolanaDevnetCrossBatchResidualExecutionClient,
  HttpSolanaDevnetNettingResidualExecutionClient,
  SolanaDevnetNettingResidualExecutionClientError,
} from '../src/index.js';

const intent = {
  domain: { domainId: 'svm:devnet' },
  validUntilUnit: 'SOLANA_SLOT',
} as NettingExternalExecutionIntent;

test('routes Solana Devnet residual execution and preserves a pending evidence state', async () => {
  const client = new HttpSolanaDevnetNettingResidualExecutionClient(
    'http://127.0.0.1:8788',
    async (request, init) => {
      assert.equal(String(request),
        `http://127.0.0.1:8788${API_SOLANA_DEVNET_NETTING_RESIDUAL_EXECUTION_PATH}`);
      assert.equal(init?.method, 'POST');
      return new Response(stringifyProtocolJson({
        error: { code: 'EVIDENCE_PENDING', message: 'pending' },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    },
  );
  assert.equal(client.supports(intent), true);
  await assert.rejects(
    client.execute({ intent, idempotencyKey: '00'.repeat(32) }),
    (error: unknown) => error instanceof SolanaDevnetNettingResidualExecutionClientError
      && error.code === 'EVIDENCE_PENDING',
  );
});

test('routes Solana Devnet pooled residual execution through its distinct path', async () => {
  const pooled = {
    ...intent,
    clearingPlanHash: new Uint8Array(32).fill(1),
  } as unknown as CrossBatchExternalExecutionIntent;
  const client = new HttpSolanaDevnetCrossBatchResidualExecutionClient(
    'http://127.0.0.1:8788',
    async (request) => {
      assert.equal(String(request),
        `http://127.0.0.1:8788${API_SOLANA_DEVNET_CROSS_BATCH_RESIDUAL_EXECUTION_PATH}`);
      return new Response(stringifyProtocolJson({ error: { code: 'EVIDENCE_PENDING' } }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
  assert.equal(client.supports(pooled), true);
  await assert.rejects(
    client.execute({ intent: pooled, idempotencyKey: '00'.repeat(32) }),
    (error: unknown) => error instanceof SolanaDevnetNettingResidualExecutionClientError
      && error.code === 'EVIDENCE_PENDING',
  );
});
