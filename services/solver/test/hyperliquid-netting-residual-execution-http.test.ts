import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import {
  HYPERLIQUID_NETTING_RESIDUAL_EXECUTION_PATH,
  HYPERLIQUID_CROSS_BATCH_RESIDUAL_EXECUTION_PATH,
  HyperliquidNettingResidualRuntimeError,
  createHyperliquidNettingResidualExecutionInternalHandler,
} from '../src/index.js';

test('residual execution handler is loopback-only and preserves pending evidence', async () => {
  let pending = false;
  const handler = createHyperliquidNettingResidualExecutionInternalHandler({
    async execute() {
      if (pending) {
        throw new HyperliquidNettingResidualRuntimeError(
          'EVIDENCE_PENDING', 'terminal evidence is incomplete',
        );
      }
      return { version: 1, grossQuoteAtoms: 250n } as never;
    },
  });
  const server = createServer(async (request, response) => {
    if (!(await handler(request, response))) response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server address is unavailable');
  }
  const url = `http://127.0.0.1:${address.port}${HYPERLIQUID_NETTING_RESIDUAL_EXECUTION_PATH}`;
  const request = {
    intent: { domain: { domainId: 'hypercore:testnet' } },
    idempotencyKey: '11'.repeat(32),
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringifyProtocolJson(request),
    });
    assert.equal(response.status, 200);
    assert.equal(
      (parseProtocolJson(await response.text()) as { evidence: { grossQuoteAtoms: bigint } })
        .evidence.grossQuoteAtoms,
      250n,
    );
    assert.equal((await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://terminal.example' },
      body: stringifyProtocolJson(request),
    })).status, 403);
    assert.equal((await fetch(
      `http://127.0.0.1:${address.port}${HYPERLIQUID_CROSS_BATCH_RESIDUAL_EXECUTION_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifyProtocolJson(request),
      },
    )).status, 200);
    pending = true;
    assert.equal((await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringifyProtocolJson(request),
    })).status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});
