import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { fromProtocolJson, toProtocolJson } from '@naryx/protocol-types';
import { createNativeClearingAdminHandler } from '../src/native-clearing-admin.js';
import type { SqliteNativeClearingStore } from '../src/native-clearing-store.js';

test('native clearing controls are loopback-only exact protocol operations', async () => {
  const calls: unknown[][] = [];
  const clearing = {
    registerDomain: (...args: unknown[]) => {
      calls.push(args);
      return { policy: args[0], state: args[1] };
    },
  } as unknown as SqliteNativeClearingStore;
  const handler = createNativeClearingAdminHandler({ clearing });
  const server = createServer((request, response) => {
    if (!handler(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const request = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/native-clearing/domains`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toProtocolJson(body)),
    });
    const text = await response.text();
    return { status: response.status, body: fromProtocolJson(JSON.parse(text)) };
  };
  try {
    const accepted = await request({ policy: { version: 1 }, state: { version: 1 } });
    assert.equal(accepted.status, 200);
    assert.equal(calls.length, 1);
    const rejected = await request({ policy: {}, state: {}, extra: true });
    assert.equal(rejected.status, 400);
    assert.equal(calls.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
