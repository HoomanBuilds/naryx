import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createHyperliquidEnrollmentProxy } from '../src/hyperliquid-testnet-enrollment-proxy.js';

test('enrollment proxy forwards only its fixed loopback route and preserves verified error responses', async () => {
  assert.throws(() => createHyperliquidEnrollmentProxy('https://example.com'), /loopback/);
  let seen = '', calls = 0;
  const handler = createHyperliquidEnrollmentProxy('http://127.0.0.1:8812', async (url, init) => {
    seen = String(url); calls++;
    assert.equal(init?.redirect, 'error');
    return Response.json({ error: { code: 'MARGIN_MODE', message: 'Use isolated margin.' } }, { status: 409 });
  });
  const server = createServer((request, response) => { if (!handler(request, response)) { response.statusCode = 404; response.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = '/internal/terminal/hyperliquid-testnet/enrollment';
  try {
    const reply = await fetch(`${origin}${path}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: `0x${'11'.repeat(20)}` }) });
    assert.equal(reply.status, 409); assert.equal((await reply.json() as { error: { code: string } }).error.code, 'MARGIN_MODE');
    assert.equal(seen, 'http://127.0.0.1:8812/internal/hyperliquid-testnet/enrollment/confirm');
    assert.equal((await fetch(`${origin}${path}/confirm`)).status, 405);
    assert.equal((await fetch(`${origin}${path}/arbitrary`)).status, 404);
    assert.equal((await fetch(`${origin}${path}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(4097) })).status, 502);
    assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
