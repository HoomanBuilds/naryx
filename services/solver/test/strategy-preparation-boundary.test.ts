import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  commitmentHash,
  parseProtocolJson,
  stringifyProtocolJson,
} from '@naryx/protocol-types';
import {
  createStrategyPreparationInternalHandler,
  HttpStrategyPackageProvider,
  StrategyPreparationService,
} from '../src/index.js';

const QUOTE_HASH = '11'.repeat(32);

test('strategy package provider accepts only loopback and rejects mismatched documents', async () => {
  assert.throws(() => new HttpStrategyPackageProvider('https://api.example'), /loopback/);
  const fetchImplementation = async () => new Response(stringifyProtocolJson({
    version: 1,
    orderHashHex: '22'.repeat(32),
    graphHashHex: '33'.repeat(32),
    quoteHashHex: QUOTE_HASH,
    routeHashHex: '44'.repeat(32),
    order: {},
    graph: {},
    quote: {},
    route: {},
    recordedAtMs: 1,
  }), { headers: { 'Content-Type': 'application/json' } });
  const provider = new HttpStrategyPackageProvider('http://127.0.0.1:8787', fetchImplementation as typeof fetch);
  await assert.rejects(() => provider.getByQuote(commitmentHash(QUOTE_HASH)), /documents are invalid/);
});

test('preparation service does not resolve context for an unknown quote', async () => {
  const service = new StrategyPreparationService(
    { getByQuote: async () => undefined },
    { resolve: async () => { throw new Error('must not resolve'); } },
  );
  assert.equal(await service.prepareByQuote(commitmentHash(QUOTE_HASH)), undefined);
});

test('strategy preparation handler is loopback-only and protocol-serializes the prepared result', async () => {
  const handler = createStrategyPreparationInternalHandler({
    prepareByQuote: async (quoteHash) => ({ version: 1, quoteHash } as never),
  });
  const server = createServer(async (request, response) => {
    if (!(await handler(request, response))) response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server address is unavailable');
  const url = `http://127.0.0.1:${address.port}/internal/strategy-executions/prepare`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteHash: QUOTE_HASH }),
    });
    assert.equal(response.status, 200);
    const result = parseProtocolJson(await response.text()) as { prepared: { quoteHash: Uint8Array } };
    assert.deepEqual(result.prepared.quoteHash, commitmentHash(QUOTE_HASH));
    assert.equal((await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://terminal.example' },
      body: JSON.stringify({ quoteHash: QUOTE_HASH }),
    })).status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});
