import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import { createCrossBatchClearingAdminHandler } from '../src/index.js';

const planHash = '11'.repeat(32);
const sourceIntentHashes = ['22'.repeat(32), '33'.repeat(32)];

test('loopback cross-batch controls prepare, inspect, and execute one durable plan', async () => {
  const clearing = {
    status: 'PENDING',
    policy: { policyHash: new Uint8Array(32).fill(0x55) },
    sourceIntents: sourceIntentHashes.map((hash) => ({ intentHash: Buffer.from(hash, 'hex') })),
    plan: { planHash: new Uint8Array(32).fill(0x11) },
    intent: { intentHash: new Uint8Array(32).fill(0x44) },
  } as never;
  let prepared = 0;
  let preparedNext = 0;
  let executed = 0;
  const handler = createCrossBatchClearingAdminHandler({
    exchange: {
      recordPreparedCrossBatchClearing(input) {
        prepared += 1;
        assert.deepEqual(input.sourceIntentHashes, sourceIntentHashes);
        return { clearing, replayed: false };
      },
      crossBatchClearing(hash) {
        assert.equal(hash, planHash);
        return clearing;
      },
    },
    prepareNext() {
      preparedNext += 1;
      return { status: 'PREPARED', clearing, replayed: false };
    },
    execution: {
      async execute(hash) {
        executed += 1;
        assert.equal(hash, planHash);
        return { clearing, executedIntentHash: '44'.repeat(32) };
      },
    },
  });
  const server = createServer((request, response) => {
    if (!handler(request, response)) response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server address is unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const preparedResponse = await fetch(`${origin}/internal/netting/cross-batch/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringifyProtocolJson({
        policy: { version: 1 },
        sourceIntentHashes,
      }),
    });
    assert.equal(preparedResponse.status, 200);
    assert.equal((parseProtocolJson(await preparedResponse.text()) as { replayed: boolean }).replayed, false);

    const nextResponse = await fetch(`${origin}/internal/netting/cross-batch/prepare-next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringifyProtocolJson({ policy: { version: 1 } }),
    });
    assert.equal(nextResponse.status, 200);
    const next = parseProtocolJson(await nextResponse.text()) as {
      status: string;
      planHashHex: string;
      executionRequired: boolean;
    };
    assert.deepEqual(next, {
      version: 1,
      status: 'PREPARED',
      planHashHex: planHash,
      policyHashHex: '55'.repeat(32),
      sourceIntentHashes,
      clearingStatus: 'PENDING',
      executionRequired: true,
      replayed: false,
    });

    const inspected = await fetch(`${origin}/internal/netting/cross-batch/${planHash}`);
    assert.equal(inspected.status, 200);
    assert.equal((parseProtocolJson(await inspected.text()) as { clearing: { status: string } }).clearing.status, 'PENDING');

    const executedResponse = await fetch(`${origin}/internal/netting/cross-batch/${planHash}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(executedResponse.status, 200);
    assert.equal(
      (parseProtocolJson(await executedResponse.text()) as { executedIntentHash: string }).executedIntentHash,
      '44'.repeat(32),
    );
    assert.equal(prepared, 1);
    assert.equal(preparedNext, 1);
    assert.equal(executed, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});
