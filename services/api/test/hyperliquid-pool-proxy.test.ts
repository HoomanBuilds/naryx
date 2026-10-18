import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createHyperliquidPoolProxy } from '../src/hyperliquid-pool-proxy.js';

test('pool proxy forwards only signed browser surfaces, never operator routes or browser credentials', async () => {
  const token = 'ab'.repeat(32);
  const calls: { url: string; headers: unknown }[] = [];
  const handler = createHyperliquidPoolProxy('http://127.0.0.1:8821', token, 'https://naryx.xyz', async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers });
    return new Response('{"environment":"TESTNET"}');
  });
  const server = createServer((req, res) => { if (!handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/hyperliquid-pool`;
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://naryx.xyz', Authorization: 'not-the-operator' }, body: '{}' };
  try {
    const response = await fetch(`${origin}/config`, options);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://naryx.xyz');
    assert.equal(calls[0]?.url, 'http://127.0.0.1:8821/v1/pool/browser/config');
    assert.deepEqual(calls[0]?.headers, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
    for (const path of ['state', 'epoch', 'advance', 'close', 'withdrawal/submit', 'config?upstream=bad']) {
      assert.equal((await fetch(`${origin}/${path}`, options)).status, 404);
    }
    assert.equal((await fetch(`${origin}/execute`, { ...options, body: 'x'.repeat(16_385) })).status, 413);
    assert.equal((await fetch(`${origin}/config`, { ...options, headers: { ...options.headers, Origin: 'https://other.example' } })).status, 403);
    assert.equal(calls.length, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.throws(() => createHyperliquidPoolProxy('https://public.example', token, null), /loopback/);
});
