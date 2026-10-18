import assert from 'node:assert/strict';
import test from 'node:test';
import { CrossDomainApprovalClient } from '../src/cross-domain-approval-client.js';

test('cross-chain approval proxy only forwards bounded signatures and fixed loopback routes', async () => {
  assert.throws(() => new CrossDomainApprovalClient('https://example.com'), /loopback/);
  assert.throws(() => new CrossDomainApprovalClient('http://127.0.0.1:8806/jobs'), /loopback/);
  const requests: string[] = [];
  const client = new CrossDomainApprovalClient('http://127.0.0.1:8806', async (url, init) => {
    requests.push(String(url));
    assert.equal(init?.redirect, 'error');
    return new Response('{"state":"RESERVING"}', { status: 202 });
  });
  const draftId = 'ab'.repeat(32), signature = `0x${'11'.repeat(65)}`;
  await assert.rejects(client.get('../jobs'), /identifier/);
  await assert.rejects(client.authorize({ draftId, signatures: [], job: {} }), /identifier/);
  assert.equal(requests.length, 0);
  const signatures = ['eip155:84532', 'eip155:421614'].map(domainId => ({ domainId, entry: signature, recovery: signature }));
  await assert.rejects(client.authorize({ draftId, signatures: [signatures[0], signatures[0]] }), /Each chain/);
  assert.equal((await client.authorize({ draftId, signatures })).status, 202);
  assert.deepEqual(requests, ['http://127.0.0.1:8806/wallet/authorize']);
});
