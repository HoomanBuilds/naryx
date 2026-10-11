import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { fromProtocolJson } from '@naryx/protocol-types';
import {
  HyperliquidNettingResidualExecutionClientError,
  createNettingBatchExecutionHandler,
  createPublicApiHandler,
  type PublicApiOptions,
} from '../src/index.js';

const proofHash = '11'.repeat(32);
const crossBatchPlanHash = '33'.repeat(32);

test('only a loopback operator triggers an existing authorized netting batch; the public API cannot', async () => {
  const batch = { proofHashHex: proofHash, externalExecutionStatus: 'PENDING' } as never;
  let pending = false;
  const handler = createPublicApiHandler({
    exchange: {
      nettingBatch: (value: Uint8Array | string) => value === proofHash ? batch : undefined,
      nettingBatchForPackage: (value: Uint8Array | string) => value === proofHash ? batch : undefined,
      crossBatchClearing: (value: Uint8Array | string) => value === crossBatchPlanHash
        ? { status: 'PENDING', plan: { planHash: crossBatchPlanHash } }
        : undefined,
      recentCrossBatchClearings: (limit: number) => limit === 2
        ? [{ status: 'PENDING', plan: { planHash: crossBatchPlanHash } }]
        : [],
    } as never,
    nowValue: () => 1n,
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
  } satisfies PublicApiOptions);
  let executions = 0;
  const internal = createNettingBatchExecutionHandler({
    exchange: { nettingBatch: (value: Uint8Array | string) => value === proofHash ? batch : undefined },
    execution: {
      async execute(value) {
        executions += 1;
        assert.equal(value, proofHash);
        if (pending) {
          throw new HyperliquidNettingResidualExecutionClientError(
            'EVIDENCE_PENDING', 'terminal evidence is pending',
          );
        }
        return { batch, executedIntentHashes: ['22'.repeat(32)] };
      },
    },
  });
  const server = createServer((request, response) => {
    if (!internal(request, response) && !handler(request, response)) response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const execute = (path = `/internal/netting/batches/${proofHash}/execute`, headers: Record<string, string> = {}) => fetch(
    `http://127.0.0.1:${port}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}',
    },
  );
  try {
    const publicPreparation = await fetch(`http://127.0.0.1:${port}/v1/netting/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(publicPreparation.status, 404);
    const discovered = await fetch(`http://127.0.0.1:${port}/v1/netting/packages/${proofHash}`);
    assert.equal(discovered.status, 200);
    assert.equal((fromProtocolJson(await discovered.json()) as { proofHashHex: string }).proofHashHex, proofHash);
    const clearing = await fetch(`http://127.0.0.1:${port}/v1/netting/cross-batch/${crossBatchPlanHash}`);
    assert.equal(clearing.status, 200);
    assert.equal((fromProtocolJson(await clearing.json()) as { status: string }).status, 'PENDING');
    const recent = await fetch(`http://127.0.0.1:${port}/v1/netting/cross-batch?limit=2`);
    assert.equal(recent.status, 200);
    assert.equal((fromProtocolJson(await recent.json()) as { clearings: readonly unknown[] }).clearings.length, 1);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/netting/cross-batch?limit=0`)).status, 400);
    assert.equal((await execute(`/v1/netting/batches/${proofHash}/execute`)).status, 404);
    // A request a reverse proxy forwarded, or a browser sent, never reaches the executor.
    assert.equal((await execute(undefined, { 'X-Forwarded-For': '203.0.113.7' })).status, 403);
    assert.equal((await execute(undefined, { Origin: 'https://terminal.example' })).status, 403);
    assert.equal((await execute(`/internal/netting/batches/${'44'.repeat(32)}/execute`)).status, 404);
    assert.equal(executions, 0);
    const completed = await execute();
    assert.equal(completed.status, 200);
    const body = fromProtocolJson(await completed.json()) as {
      executedIntentHashes: readonly string[];
    };
    assert.deepEqual(body.executedIntentHashes, ['22'.repeat(32)]);
    pending = true;
    const waiting = await execute();
    assert.equal(waiting.status, 409);
    assert.equal((await waiting.json() as { error: { code: string } }).error.code,
      'NETTING_EVIDENCE_PENDING');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});
