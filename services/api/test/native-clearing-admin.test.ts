import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  fromProtocolJson,
  packageSettlementCommitmentHash,
  toHex,
  toProtocolJson,
} from '@naryx/protocol-types';
import { createNativeClearingAdminHandler, type NativeClearingAdminOptions } from '../src/native-clearing-admin.js';
import type { SqliteNativeClearingStore } from '../src/native-clearing-store.js';
import { NativeClearingStoreError } from '../src/native-clearing-store.js';
import { authorization } from './native-clearing-fixtures.js';

async function serve(options: NativeClearingAdminOptions) {
  const handler = createNativeClearingAdminHandler(options);
  const server = createServer((request, response) => {
    if (!handler(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    request: async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/internal/native-clearing/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toProtocolJson(body)),
      });
      const text = await response.text();
      return { status: response.status, body: fromProtocolJson(JSON.parse(text)) };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const noExchange = {
  getAllocation: () => undefined,
  settlementHandoff: () => undefined,
  settlementAuthorization: () => undefined,
} as NativeClearingAdminOptions['exchange'];

test('native clearing cannot mutate balances when onchain backing is unavailable', async () => {
  let mutated = false;
  const server = await serve({
    clearing: { adjustReserve: () => { mutated = true; } } as unknown as SqliteNativeClearingStore,
    exchange: noExchange,
    verifyBacking: async () => { throw new NativeClearingStoreError('BACKING_UNAVAILABLE', 'No reviewed backing.'); },
  });
  try {
    const response = await server.request('reserve', { clearingDomainId: 'test-clearing', expectedStateHash: '11'.repeat(32), reserveDeltaQuoteAtoms: 10n });
    assert.equal(response.status, 503);
    assert.equal(mutated, false);
  } finally {
    await server.close();
  }
});

test('native clearing controls are loopback-only exact protocol operations', async () => {
  const calls: unknown[][] = [];
  const clearing = {
    registerDomain: (...args: unknown[]) => {
      calls.push(args);
      return { policy: args[0], state: args[1] };
    },
  } as unknown as SqliteNativeClearingStore;
  const server = await serve({ clearing, exchange: noExchange });
  try {
    const accepted = await server.request('domains', { policy: { version: 1 }, state: { version: 1 } });
    assert.equal(accepted.status, 200);
    assert.equal(calls.length, 1);
    const rejected = await server.request('domains', { policy: {}, state: {}, extra: true });
    assert.equal(rejected.status, 400);
    assert.equal(calls.length, 1);
  } finally {
    await server.close();
  }
});

test('a native clearing match settles only the exchange-stored allocation both participants authorized', async () => {
  const match = authorization();
  let settled = 0;
  const clearing = {
    settleAuthorizedMatch: () => {
      settled += 1;
      return { settled: true };
    },
  } as unknown as SqliteNativeClearingStore;
  const authorized = new Map([match.takerSettlementCommitment, match.makerSettlementCommitment].map((commitment) => [
    toHex(commitment.packageOrderId),
    { settlementCommitmentHashHex: toHex(packageSettlementCommitmentHash(commitment)) },
  ]));
  const exchange = (makerAuthorized: boolean) => ({
    getAllocation: () => match.allocation,
    settlementHandoff: () => match.handoff,
    settlementAuthorization: (orderId: Uint8Array | string) => {
      const hex = typeof orderId === 'string' ? orderId : toHex(orderId);
      return makerAuthorized || hex === toHex(match.takerSettlementCommitment.packageOrderId) ? authorized.get(hex) : undefined;
    },
  }) as unknown as NativeClearingAdminOptions['exchange'];
  const body = { authorization: match, expectedStateHash: '00', expectedLongAccountHash: '00', expectedShortAccountHash: '00' };
  for (const [options, status] of [
    [{ clearing, exchange: noExchange }, 403],
    [{ clearing, exchange: exchange(false) }, 403],
    [{ clearing, exchange: exchange(true) }, 200],
  ] as const) {
    const server = await serve(options);
    try {
      const response = await server.request('matches', body);
      assert.equal(response.status, status);
      const clocked = await server.request('matches', { ...body, authorization: { ...match, currentExpiryUnit: 'SOLANA_SLOT', currentExpiryValue: 1n } });
      assert.equal(clocked.status, 400);
    } finally {
      await server.close();
    }
  }
  assert.equal(settled, 1);
});

test('contract observations require stored exchange consent and cannot supply the execution clock', async () => {
  const match = authorization();
  const calls: unknown[] = [];
  const authorized = new Map([match.takerSettlementCommitment, match.makerSettlementCommitment].map((commitment) => [
    toHex(commitment.packageOrderId), { settlementCommitmentHashHex: toHex(packageSettlementCommitmentHash(commitment)) },
  ]));
  const exchange = { getAllocation: () => match.allocation, settlementHandoff: () => match.handoff,
    settlementAuthorization: (id: Uint8Array | string) => authorized.get(typeof id === 'string' ? id : toHex(id)),
  } as unknown as NativeClearingAdminOptions['exchange'];
  const options = { clearing: {} as SqliteNativeClearingStore, exchange,
    observe: async (kind: 'MATCH' | 'DEFAULT', body: Record<string, unknown>) => { calls.push({ kind, body }); return { recorded: true }; },
  };
  const server = await serve(options);
  try {
    const body = { clearingDomainId: 'test-clearing', transactionHash: `0x${'aa'.repeat(32)}`, authorization: match };
    assert.equal((await server.request('match-observations', body)).status, 200);
    assert.equal((await server.request('match-observations', { ...body, authorization: { ...match, currentExpiryValue: 1n } })).status, 400);
    assert.equal((await server.request('recovery-observations', { clearingDomainId: 'test-clearing', transactionHash: body.transactionHash, auctionId: 'recovery-1' })).status, 200);
    assert.equal(calls.length, 2);
    const unauthorized = await serve({ ...options, exchange: noExchange });
    try { assert.equal((await unauthorized.request('match-observations', body)).status, 403); }
    finally { await unauthorized.close(); }
    assert.equal(calls.length, 2);
  } finally { await server.close(); }
});
