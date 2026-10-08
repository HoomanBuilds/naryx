import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { fromProtocolJson } from '@naryx/protocol-types';
import {
  HyperliquidNettingResidualExecutionClientError,
  createPublicApiHandler,
  type PublicApiOptions,
} from '../src/index.js';

const proofHash = '11'.repeat(32);

test('public API triggers only an existing authorized netting batch', async () => {
  const batch = { proofHashHex: proofHash, externalExecutionStatus: 'PENDING' } as never;
  let pending = false;
  const handler = createPublicApiHandler({
    exchange: {
      nettingBatch: (value: Uint8Array | string) => value === proofHash ? batch : undefined,
    } as never,
    nettingExecution: {
      async execute(value) {
        assert.equal(value, proofHash);
        if (pending) {
          throw new HyperliquidNettingResidualExecutionClientError(
            'EVIDENCE_PENDING', 'terminal evidence is pending',
          );
        }
        return { batch, executedIntentHashes: ['22'.repeat(32)] };
      },
    },
    nowValue: () => 1n,
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
  } satisfies PublicApiOptions);
  const server = createServer((request, response) => {
    if (!handler(request, response)) response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const execute = () => fetch(
    `http://127.0.0.1:${port}/v1/netting/batches/${proofHash}/execute`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  try {
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
