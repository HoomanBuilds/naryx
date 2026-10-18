import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createCrossDomainServer } from '../src/cross-domain-server.js';

test('loopback job intake rejects browser callers and invalid jobs without admitting them', async () => {
  const hash = 'ab'.repeat(32);
  let calls = 0;
  const server = createCrossDomainServer({
    admit: async job => { calls++; if (job.version !== 1) throw new Error('invalid'); return { planHash: hash, admittedPlanHash: hash }; },
    status: value => value === hash ? { planHash: hash, status: 'ACTIVE' } : undefined,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    assert.equal((await fetch(`${origin}/wallet/drafts/${hash}`)).status, 503);
    const post = (body: string, headers = {}) => fetch(`${origin}/jobs`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
    assert.equal((await post('{"version":1}', { origin: 'https://example.com' })).status, 403);
    assert.equal(calls, 0);
    assert.equal((await post('invalid')).status, 409);
    assert.equal(calls, 0);
    assert.equal((await post('{"version":2}')).status, 409);
    const accepted = await post('{"version":1}');
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json() as { planHash: string }).planHash, hash);
    assert.equal((await fetch(`${origin}/jobs/${hash}`)).status, 200);
    assert.equal((await fetch(`${origin}/jobs/${'cd'.repeat(32)}`)).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
