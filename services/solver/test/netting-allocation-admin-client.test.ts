import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitmentHash,
  hash32,
  toHex,
  toProtocolJson,
} from '@naryx/protocol-types';
import { HttpNettingAllocationAdminClient } from '../src/netting-allocation-admin-client.js';

test('registers and binds an exact netting allocation attempt through loopback', async () => {
  const authorizationHash = commitmentHash(hash32(new Uint8Array(32).fill(1)));
  const attempt = {
    attemptId: 'allocation-attempt-0001',
    idempotencyKey: 'allocation-idempotency-0001',
    authorizationHashHex: toHex(authorizationHash),
    observation: { runtimeClass: 'EVM', binding: {} },
    recordedAtMs: 1,
  } as const;
  const paths: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const payload = url.pathname.endsWith('/reference')
      ? { version: 1, attempt: { ...attempt, executionReference: body.executionReference } }
      : { version: 1, authorizationReplayed: false, attempt };
    return new Response(JSON.stringify(toProtocolJson(payload)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const client = new HttpNettingAllocationAdminClient('http://127.0.0.1:8787');
    const registered = await client.register({
      attemptId: attempt.attemptId,
      idempotencyKey: attempt.idempotencyKey,
      authorization: { authorizationHash } as never,
      observation: attempt.observation as never,
    });
    assert.equal(registered.authorizationHashHex, attempt.authorizationHashHex);
    const referenced = await client.bindExecutionReference({
      attemptId: attempt.attemptId,
      authorizationHash: attempt.authorizationHashHex,
      executionReference: `0x${'02'.repeat(32)}`,
    });
    assert.equal(referenced.executionReference, `0x${'02'.repeat(32)}`);
    assert.deepEqual(paths, [
      '/internal/netting/allocation-attempts',
      `/internal/netting/allocation-attempts/${attempt.attemptId}/reference`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
