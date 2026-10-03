import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createBoundedSolanaConnection } from '../src/bounded-connection.js';

test('a Solana RPC that never answers fails the request within the bound instead of holding it', async (t) => {
  // Accepts the request and never responds, like a stalled endpoint.
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const connection = createBoundedSolanaConnection(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'finalized', 200);
  const started = Date.now();
  await assert.rejects(connection.getSlot('finalized'));
  assert.ok(Date.now() - started < 5_000, 'the stalled request was not bounded');
  assert.throws(() => createBoundedSolanaConnection('http://127.0.0.1:1', 'finalized', 0), /positive integer/);
});
