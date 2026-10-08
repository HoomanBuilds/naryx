import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitmentHash,
  domainRef,
  hash32,
  toHex,
} from '@naryx/protocol-types';
import { NettingAllocationLifecycleService } from '../src/index.js';

test('loads, prepares, registers, binds, and reconciles one exact allocation', async () => {
  const proofHash = commitmentHash(hash32(new Uint8Array(32).fill(1)));
  const allocationReceiptHash = commitmentHash(hash32(new Uint8Array(32).fill(2)));
  const authorizationHash = commitmentHash(hash32(new Uint8Array(32).fill(3)));
  const quoteHash = hash32(new Uint8Array(32).fill(4));
  const domain = domainRef('eip155:84532', 1, hash32(new Uint8Array(32).fill(5)));
  const attemptId = 'allocation-attempt-0001';
  const calls: string[] = [];
  const prepared = {
    authorization: { authorizationHash },
    observation: { runtimeClass: 'EVM', binding: {} },
  } as never;
  const attempt = {
    attemptId,
    idempotencyKey: toHex(authorizationHash),
    authorizationHashHex: toHex(authorizationHash),
    observation: { runtimeClass: 'EVM', binding: {} },
    recordedAtMs: 1,
  } as const;
  const service = new NettingAllocationLifecycleService({
    preparation: async (value) => {
      calls.push(`prepare:${value}`);
      return {
        version: 1,
        proofHashHex: toHex(proofHash),
        policy: {},
        result: {},
        externalExecutions: [],
        finalAllocationReceipt: {},
        allocations: [{
          allocationReceiptHashHex: toHex(allocationReceiptHash),
          settlement: {},
        }],
      } as never;
    },
    register: async (input) => {
      calls.push(`register:${input.idempotencyKey}`);
      assert.equal(input.attemptId, attemptId);
      return attempt as never;
    },
    bindExecutionReference: async (input) => {
      calls.push(`bind:${input.executionReference}`);
      return { ...attempt, executionReference: input.executionReference } as never;
    },
    settle: async (value) => {
      calls.push(`settle:${value}`);
      return { version: 1 };
    },
  }, {
    prepareNativeByQuote: async (value) => {
      assert.deepEqual(value, quoteHash);
      return { domains: [{ domain }] } as never;
    },
  }, () => prepared);

  const registered = await service.prepareAndRegister({
    proofHash,
    allocationReceiptHash,
    quoteHash,
    domainId: domain.domainId,
    attemptId,
  });
  assert.equal(registered.prepared, prepared);
  assert.equal(registered.attempt, attempt);
  await service.bindExecutionReference({
    attemptId,
    authorizationHash,
    executionReference: `0x${'06'.repeat(32)}`,
  });
  await service.reconcile(proofHash);
  assert.deepEqual(calls, [
    `prepare:${toHex(proofHash)}`,
    `register:${toHex(authorizationHash)}`,
    `bind:0x${'06'.repeat(32)}`,
    `settle:${toHex(proofHash)}`,
  ]);
});
