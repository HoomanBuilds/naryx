import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import {
  createHyperliquidTestnetEvidenceServer,
  KEEPER_TESTNET_PREPARE_PATH,
  KEEPER_TESTNET_RECONCILE_PATH,
  KEEPER_TESTNET_STRATEGY_RECONCILE_PATH,
  type HyperliquidTestnetPrepareResult,
} from '../src/index.js';

async function listen(server: ReturnType<typeof createHyperliquidTestnetEvidenceServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createHyperliquidTestnetEvidenceServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

const account = {
  masterAccount: `0x${'11'.repeat(20)}`,
  tradingAccount: `0x${'12'.repeat(20)}`,
  accountKind: 'SUBACCOUNT',
};
const binding = { spotUniverseIndex: 7, spotTokenIndex: 1, perpetualAssetIndex: 3, quoteTokenIndex: 0 };
const window = { startTimeMs: 900, endTimeMs: 1000, nowMs: 1000, maxEvidenceAgeMs: 500, maxSnapshotSkewMs: 100 };

function planFixture(): Record<string, unknown> {
  return {
    version: 1,
    requestExpiryMs: 5000n,
    commitments: { orderHash: new Uint8Array(32).fill(7) },
  };
}

test('prepare success decodes strict protocol JSON and returns a sanitized typed response', async () => {
  let seenPlan: Record<string, unknown> | null = null;
  const server = createHyperliquidTestnetEvidenceServer({
    runtime: {
      prepare: async (input) => {
        seenPlan = input.plan as unknown as Record<string, unknown>;
        return Object.freeze({
          status: 'PREPARED' as const,
          state: Object.freeze({
            attemptId: input.attemptId,
            actionHash: `0x${'aa'.repeat(32)}`,
            attempt: Object.freeze({ status: 'PLANNED', observedAtMs: 1000n }),
            checkpoint: Object.freeze({ version: 1, baseSpotBalanceAtoms: 42n }),
            binding: input.binding,
          }),
        }) as unknown as HyperliquidTestnetPrepareResult;
      },
      reconcile: async () => {
        throw new Error('reconcile must not be called');
      },
    },
  });
  const url = await listen(server);
  try {
    const body = stringifyProtocolJson(
      { attemptId: 'attempt-1', plan: planFixture(), account, binding, window },
      'keeper.test.prepare',
    );
    const response = await fetch(`${url}${KEEPER_TESTNET_PREPARE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const decoded = (await response.json()) as {
      status: string;
      state: { attemptId: string; checkpoint: { baseSpotBalanceAtoms: unknown } };
    };
    assert.equal(decoded.status, 'PREPARED');
    assert.equal(decoded.state.attemptId, 'attempt-1');
    assert.deepEqual(decoded.state.checkpoint.baseSpotBalanceAtoms, {
      $naryxType: 'bigint',
      value: '42',
    });
    assert.equal(typeof (seenPlan as Record<string, unknown> | null)?.requestExpiryMs, 'bigint');
    assert.ok((seenPlan as unknown as { commitments: { orderHash: unknown } })
      .commitments.orderHash instanceof Uint8Array);
  } finally {
    await close(server);
  }
});

test('prepare malformed body fails closed', async () => {
  const server = createHyperliquidTestnetEvidenceServer({
    runtime: {
      prepare: async () => {
        throw new Error('must not be called');
      },
      reconcile: async () => {
        throw new Error('must not be called');
      },
    },
  });
  const url = await listen(server);
  try {
    const malformed = await fetch(`${url}${KEEPER_TESTNET_PREPARE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(malformed.status, 400);
    const malformedBody = (await malformed.json()) as { error: { code: string } };
    assert.equal(malformedBody.error.code, 'INVALID_JSON');

    const wrongKeys = await fetch(`${url}${KEEPER_TESTNET_PREPARE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-1', extra: true }),
    });
    assert.equal(wrongKeys.status, 400);
    const wrongKeysBody = (await wrongKeys.json()) as { error: { code: string } };
    assert.equal(wrongKeysBody.error.code, 'INVALID_REQUEST');
  } finally {
    await close(server);
  }
});

test('prepare wrong method is rejected', async () => {
  const server = createHyperliquidTestnetEvidenceServer({
    runtime: {
      prepare: async () => {
        throw new Error('must not be called');
      },
      reconcile: async () => {
        throw new Error('must not be called');
      },
    },
  });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}${KEEPER_TESTNET_PREPARE_PATH}`, { method: 'GET' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
  } finally {
    await close(server);
  }
});

test('reconcile handoff rejection is returned without an evidence read', async () => {
  let reconcileCalls = 0;
  const server = createHyperliquidTestnetEvidenceServer({
    runtime: {
      prepare: async () => {
        throw new Error('must not be called');
      },
      reconcile: async () => {
        reconcileCalls += 1;
        return Object.freeze({ status: 'HANDOFF_REJECTED' as const, reason: 'ACTION_HASH_MISMATCH' });
      },
    },
  });
  const url = await listen(server);
  try {
    const prepared = { attemptId: 'attempt-1', actionHash: `0x${'aa'.repeat(32)}`, observedAtMs: 1000n };
    const handoff = {
      collector: 'HYPERLIQUID_TESTNET_AUTHORITATIVE_EVIDENCE',
      attemptId: 'attempt-1',
      account,
      actionHash: `0x${'bb'.repeat(32)}`,
      actionCommitmentScheme: 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1',
      requestCommitment: `0x${'cc'.repeat(32)}`,
      durableRevision: 'rev-1',
      spotClientOrderId: `0x${'21'.repeat(16)}`,
      perpetualClientOrderId: `0x${'22'.repeat(16)}`,
    };
    const body = stringifyProtocolJson(
      { prepared, handoff, binding, window },
      'keeper.test.reconcile',
    );
    const response = await fetch(`${url}${KEEPER_TESTNET_RECONCILE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(response.status, 200);
    const decoded = (await response.json()) as { status: string; reason: string };
    assert.equal(decoded.status, 'HANDOFF_REJECTED');
    assert.equal(decoded.reason, 'ACTION_HASH_MISMATCH');
    assert.equal(reconcileCalls, 1);
  } finally {
    await close(server);
  }
});

test('strategy reconcile forwards the exact generalized evidence request', async () => {
  let seenAttempt = '';
  const server = createHyperliquidTestnetEvidenceServer({
    runtime: {
      prepare: async () => { throw new Error('must not be called'); },
      reconcile: async () => { throw new Error('must not be called'); },
    },
    strategy: {
      collect: async (input) => {
        seenAttempt = input.attemptId;
        return {
          status: 'COMPLETE', outcome: 'COMPLETED', reasons: [],
          legs: [{
            legId: 'leg-1', clientOrderId: `0x${'21'.repeat(16)}`,
            plannedSignedBaseAtoms: 100n, filledSignedBaseAtoms: 100n,
            terminalStatus: 'FILLED', openOrderStatus: 'NONE', orderId: 1, fillCount: 1,
          }],
          rawResponseCommitments: [],
        };
      },
    },
  });
  const url = await listen(server);
  try {
    const body = stringifyProtocolJson({
      account,
      actionHash: `0x${'aa'.repeat(32)}`,
      attemptId: 'strategy-attempt-1',
      batchStage: 0,
      clientOrderIds: [`0x${'21'.repeat(16)}`],
      durableRevision: 'sqlite-strategy-v1:1',
      legIds: ['leg-1'],
      plan: planFixture(),
      requestCommitment: `0x${'bb'.repeat(32)}`,
      window,
    }, 'keeper.test.strategy.reconcile');
    const response = await fetch(`${url}${KEEPER_TESTNET_STRATEGY_RECONCILE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(response.status, 200);
    const decoded = (await response.json()) as {
      status: string;
      legs: readonly [{ filledSignedBaseAtoms: unknown }];
    };
    assert.equal(decoded.status, 'COMPLETE');
    assert.equal(seenAttempt, 'strategy-attempt-1');
    assert.deepEqual(decoded.legs[0].filledSignedBaseAtoms, {
      $naryxType: 'bigint', value: '100',
    });
  } finally {
    await close(server);
  }
});
