import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  commitmentHash,
  fromProtocolJson,
  hash32,
  packageSettlementCommitment,
  toHex,
  toProtocolJson,
  type NettingAllocationExecutionAuthorization,
} from '@naryx/protocol-types';
import { createNettingAllocationAdminHandler } from '../src/netting-allocation-admin.js';
import type {
  NettingAllocationExecutionAttempt,
  NettingAllocationObservationBinding,
} from '../src/netting-allocation-attempt-store.js';

test('registers, binds, and reconciles a netting allocation through loopback controls', async () => {
  const authorization = {
    authorizationHash: commitmentHash(hash32(new Uint8Array(32).fill(1))),
  } as NettingAllocationExecutionAuthorization;
  const observation = { runtimeClass: 'EVM', binding: {} } as NettingAllocationObservationBinding;
  const attemptId = 'allocation-attempt-0001';
  const attempt = {
    attemptId,
    idempotencyKey: 'allocation-idempotency-0001',
    authorizationHashHex: toHex(authorization.authorizationHash),
    observation,
    recordedAtMs: 1,
  } as NettingAllocationExecutionAttempt;
  let storedAuthorization: NettingAllocationExecutionAuthorization | undefined;
  let storedAttempt = attempt;
  let settled = false;
  const packageOrderId = commitmentHash(hash32(new Uint8Array(32).fill(4)));
  const allocationReceiptHash = commitmentHash(hash32(new Uint8Array(32).fill(5)));
  const settlementCommitment = packageSettlementCommitment({
    version: 1,
    environment: 'testnet',
    executionClassId: 'atomic-strategy-netting',
    packageOrderId,
    strategyOrderHash: hash32(new Uint8Array(32).fill(6)),
    graphHash: hash32(new Uint8Array(32).fill(7)),
    participantId: 'participant',
    settlementAccount: 'settlement-account',
    quantity: 1n,
    validUntilUnit: 'EVM_UNIX_SECONDS',
    validUntilValue: 1_000n,
  });
  const handler = createNettingAllocationAdminHandler({
    exchange: {
      nettingBatch: () => ({
        proofHashHex: '03'.repeat(32),
        policy: {},
        result: {},
        externalExecutions: [],
        finalAllocationReceipt: { allocations: [{ allocationReceiptHash, packageOrderId }] },
      }) as never,
      settlementCommitment: () => settlementCommitment,
      recordNettingAllocationExecutionAuthorization: (value) => {
        storedAuthorization = value;
        return { replayed: false };
      },
      nettingAllocationExecutionAuthorization: () => storedAuthorization,
    },
    attempts: {
      save: () => storedAttempt,
      bindExecutionReference: (_id, _authorization, executionReference) => {
        storedAttempt = { ...storedAttempt, executionReference };
        return storedAttempt;
      },
    },
    settlement: {
      settle: async () => {
        settled = true;
        return {
          batch: {},
          observedAuthorizationHashes: [toHex(authorization.authorizationHash)],
          pendingAllocationReceiptHashes: [],
        } as never;
      },
    },
  });
  const server = createServer((request, response) => {
    if (!handler(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toProtocolJson(body)),
    });
    return { status: response.status, body: fromProtocolJson(await response.json()) as Record<string, unknown> };
  };
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: fromProtocolJson(await response.json()) as Record<string, unknown> };
  };
  try {
    const created = await post('/internal/netting/allocation-attempts', {
      attemptId,
      idempotencyKey: attempt.idempotencyKey,
      authorization,
      observation,
    });
    assert.equal(created.status, 200);
    assert.equal(toHex(storedAuthorization!.authorizationHash), toHex(authorization.authorizationHash));
    const referenced = await post(`/internal/netting/allocation-attempts/${attemptId}/reference`, {
      authorizationHash: toHex(authorization.authorizationHash),
      executionReference: `0x${'02'.repeat(32)}`,
    });
    assert.equal(referenced.status, 200);
    assert.equal(storedAttempt.executionReference, `0x${'02'.repeat(32)}`);
    const reconciled = await post(`/internal/netting/batches/${'03'.repeat(32)}/settle`, {});
    assert.equal(reconciled.status, 200);
    assert.equal(settled, true);
    const preparation = await get(`/internal/netting/batches/${'03'.repeat(32)}/preparation`);
    assert.equal(preparation.status, 200);
    const allocations = preparation.body.allocations as Record<string, unknown>[];
    assert.equal(allocations[0]?.allocationReceiptHashHex, toHex(allocationReceiptHash));
    assert.deepEqual(allocations[0]?.settlement, settlementCommitment);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
