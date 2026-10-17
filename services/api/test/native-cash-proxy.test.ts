import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createNativeCashProxy } from '../src/native-cash-proxy.js';

test('native cash proxy forwards bounded owner requests without forwarding browser identity headers', async () => {
  const calls: { url: string; body: unknown; headers: unknown }[] = [];
  const handler = createNativeCashProxy('http://127.0.0.1:8820', async (url, init) => {
    calls.push({ url: String(url), body: init?.body, headers: init?.headers });
    return new Response('{"version":1,"markets":[]}', { status: 200 });
  }, 'https://naryx.xyz');
  const server = createServer((req, res) => { if (!handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${origin}/v1/native-cash/markets`, { headers: { Origin: 'https://naryx.xyz' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://naryx.xyz');
    assert.equal(calls.length, 1);
    assert.equal((calls[0]!.headers as Record<string, string>).Origin, undefined);
    assert.equal((await fetch(`${origin}/v1/native-cash/quotes`, { method: 'OPTIONS', headers: { Origin: 'https://naryx.xyz' } })).status, 204);
    assert.equal((await fetch(`${origin}/v1/native-cash/markets`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await fetch(`${origin}/v1/native-cash/markets?origin=https://untrusted.example`)).status, 404);
    assert.equal((await fetch(`${origin}/v1/native-cash/quotes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(4097) })).status, 413);
    assert.equal(calls.length, 1);
    await fetch(`${origin}/v1/native-cash/quotes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(calls.length, 2);
    assert.equal((await fetch(`${origin}/v1/native-cash/markets/cash-range/trades`)).status, 200);
    assert.equal(calls.length, 3);
    assert.equal((await fetch(`${origin}/v1/native-cash/markets/cash-range/trades`, { method: 'POST' })).status, 404);
    assert.equal(calls.length, 3);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.throws(() => createNativeCashProxy('https://untrusted.example'), /loopback/);
});
