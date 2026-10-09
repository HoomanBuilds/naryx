import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { assetRef, parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import {
  HyperliquidNettingResidualTestnetHttpEvidence,
  HyperliquidRecoveryTestnetHttpExecution,
  HyperliquidRecoveryTestnetHttpReconciliation,
  HyperliquidStrategyTestnetHttpEvidence,
  HyperliquidTestnetHttpStructuralEvidence,
  SOLVER_TESTNET_EVIDENCE_PREPARE_PATH,
  SOLVER_TESTNET_EVIDENCE_RECONCILE_PATH,
  SOLVER_TESTNET_NETTING_RESIDUAL_EVIDENCE_RECONCILE_PATH,
  SOLVER_TESTNET_RECOVERY_CONTINUE_PATH,
  SOLVER_TESTNET_RECOVERY_EXECUTE_PATH,
  SOLVER_TESTNET_RECOVERY_RECONCILE_PATH,
  SOLVER_TESTNET_STRATEGY_EVIDENCE_RECONCILE_PATH,
  createHyperliquidTestnetLoopbackCoordinator,
} from '../src/hyperliquid-testnet-evidence-http.js';

const masterAccount = `0x${'11'.repeat(20)}`;
const tradingAccount = `0x${'22'.repeat(20)}`;
const account = { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' };
const binding = {
  spotUniverseIndex: 0,
  spotTokenIndex: 1,
  perpetualAssetIndex: 2,
  quoteTokenIndex: 3,
};
const window = {
  startTimeMs: 900_000,
  endTimeMs: 950_000,
  nowMs: 1_000_000,
  maxEvidenceAgeMs: 200_000,
  maxSnapshotSkewMs: 5_000,
};

function planFixture(): Record<string, unknown> {
  return {
    version: 1,
    requestExpiryMs: 1_005_000n,
    commitments: { orderHash: new Uint8Array(32).fill(7) },
  };
}

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
  rawBody: string;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startServer(
  handler: (captured: CapturedRequest, request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; captured: CapturedRequest[]; close: () => Promise<void> }> {
  const captured: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void readBody(request).then((rawBody) => {
      const entry: CapturedRequest = {
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        rawBody,
      };
      captured.push(entry);
      handler(entry, request, response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    captured,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    }),
  };
}

function jsonResponse(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

test('prepare success posts exact keys over protocol JSON', async () => {
  const server = await startServer((captured, request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, SOLVER_TESTNET_EVIDENCE_PREPARE_PATH);
    assert.equal(captured.contentType, 'application/json');
    const decoded = parseProtocolJson(captured.rawBody, 'test.prepare.request') as Record<string, unknown>;
    assert.deepEqual(Object.keys(decoded).sort(), ['account', 'attemptId', 'binding', 'plan', 'window']);
    assert.equal(decoded.attemptId, 'attempt-1');
    const body = stringifyProtocolJson(
      {
        status: 'PREPARED',
        state: {
          attemptId: 'attempt-1',
          actionHash: `0x${'aa'.repeat(32)}`,
          attempt: { marker: 'opaque' },
          checkpoint: { baseSpotBalanceAtoms: 42n },
          binding,
        },
      },
      'test.prepare.response',
    );
    jsonResponse(response, 200, body);
  });
  try {
    const client = new HyperliquidTestnetHttpStructuralEvidence({ keeperOrigin: server.origin });
    const result = await client.prepare({
      attemptId: 'attempt-1',
      plan: planFixture() as never,
      account: account as never,
      binding: { ...binding },
      window: { ...window },
    });
    assert.equal(result.status, 'PREPARED');
    assert.equal((result as { state: { attemptId: string } }).state.attemptId, 'attempt-1');
    const checkpoint = (result as {
      state: { checkpoint: { baseSpotBalanceAtoms: unknown } };
    }).state.checkpoint;
    assert.equal(checkpoint.baseSpotBalanceAtoms, 42n);
    assert.equal(server.captured.length, 1);
  } finally {
    await server.close();
  }
});

test('malformed tagged response and oversize response fail sanitized', async () => {
  const malformed = await startServer((_captured, _request, response) => {
    jsonResponse(response, 200, JSON.stringify({
      status: 'PREPARED',
      state: { checkpoint: { baseSpotBalanceAtoms: { $naryxType: 'bigint', value: 'not-decimal' } } },
    }));
  });
  try {
    const client = new HyperliquidTestnetHttpStructuralEvidence({ keeperOrigin: malformed.origin });
    await assert.rejects(
      () => client.prepare({
        attemptId: 'attempt-1',
        plan: planFixture() as never,
        account: account as never,
        binding: { ...binding },
        window: { ...window },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /keeper evidence request failed/);
        assert.ok(!error.message.includes('not-decimal'));
        return true;
      },
    );
  } finally {
    await malformed.close();
  }

  const oversize = await startServer((_captured, _request, response) => {
    const big = stringifyProtocolJson(
      { status: 'PREPARED', state: { attemptId: 'attempt-1', pad: 'x'.repeat(70_000) } },
      'test.oversize.response',
    );
    jsonResponse(response, 200, big);
  });
  try {
    const client = new HyperliquidTestnetHttpStructuralEvidence({ keeperOrigin: oversize.origin });
    await assert.rejects(
      () => client.prepare({
        attemptId: 'attempt-1',
        plan: planFixture() as never,
        account: account as never,
        binding: { ...binding },
        window: { ...window },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /keeper evidence request failed/);
        return true;
      },
    );
  } finally {
    await oversize.close();
  }
});

test('non-loopback keeper origin is rejected', () => {
  for (const origin of [
    'https://api.hyperliquid-testnet.xyz/',
    'http://example.com/',
    'http://192.168.1.10:8789/',
    'http://127.0.0.1:8789/extra-path',
    'http://127.0.0.1:8789/?q=1',
  ]) {
    assert.throws(
      () => new HyperliquidTestnetHttpStructuralEvidence({ keeperOrigin: origin }),
      /loopback HTTP origin/,
      origin,
    );
  }
});

test('timeout and failure stay sanitized without resubmission shape', async () => {
  const failingFetch = (() => Promise.reject(new Error('boom'))) as typeof fetch;
  const client = new HyperliquidTestnetHttpStructuralEvidence({
    keeperOrigin: 'http://127.0.0.1:8789',
    fetchImplementation: failingFetch,
  });
  await assert.rejects(
    () => client.prepare({
      attemptId: 'attempt-1',
      plan: planFixture() as never,
      account: account as never,
      binding: { ...binding },
      window: { ...window },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'keeper evidence request failed');
      assert.ok(!('status' in error));
      return true;
    },
  );

  const delayed = await startServer((_captured, _request, response) => {
    setTimeout(() => {
      try {
        jsonResponse(response, 200, stringifyProtocolJson(
          { status: 'PREPARED', state: { attemptId: 'attempt-1' } },
          'test.delayed.response',
        ));
      } catch {
        // Client already timed out; late response is ignored.
      }
    }, 500);
  });
  try {
    const timeoutClient = new HyperliquidTestnetHttpStructuralEvidence({
      keeperOrigin: delayed.origin,
      timeoutMs: 50,
    });
    await assert.rejects(
      () => timeoutClient.prepare({
        attemptId: 'attempt-1',
        plan: planFixture() as never,
        account: account as never,
        binding: { ...binding },
        window: { ...window },
      }),
      /keeper evidence request failed/,
    );
  } finally {
    await delayed.close();
  }

  const httpError = await startServer((_captured, _request, response) => {
    jsonResponse(response, 500, JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }));
  });
  try {
    const errorClient = new HyperliquidTestnetHttpStructuralEvidence({
      keeperOrigin: httpError.origin,
    });
    await assert.rejects(
      () => errorClient.prepare({
        attemptId: 'attempt-1',
        plan: planFixture() as never,
        account: account as never,
        binding: { ...binding },
        window: { ...window },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 500/);
        assert.ok(!error.message.includes('INTERNAL_ERROR') || error.message.includes('HTTP 500'));
        return true;
      },
    );
  } finally {
    await httpError.close();
  }
});

test('reconcile binds prepared, handoff, binding, and window with exact keys', async () => {
  const prepared = { attemptId: 'attempt-1', actionHash: `0x${'aa'.repeat(32)}` };
  const handoff = {
    collector: 'HYPERLIQUID_TESTNET_AUTHORITATIVE_EVIDENCE',
    attemptId: 'attempt-1',
    account,
    actionHash: `0x${'aa'.repeat(32)}`,
    actionCommitmentScheme: 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1',
    requestCommitment: `0x${'cc'.repeat(32)}`,
    durableRevision: 'rev-1',
    spotClientOrderId: `0x${'21'.repeat(16)}`,
    perpetualClientOrderId: `0x${'22'.repeat(16)}`,
  };
  const server = await startServer((captured, request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, SOLVER_TESTNET_EVIDENCE_RECONCILE_PATH);
    const decoded = parseProtocolJson(captured.rawBody, 'test.reconcile.request') as Record<string, unknown>;
    assert.deepEqual(Object.keys(decoded).sort(), ['binding', 'handoff', 'prepared', 'window']);
    assert.deepEqual(decoded.binding, binding);
    assert.deepEqual(
      (decoded.handoff as Record<string, unknown>).attemptId,
      'attempt-1',
    );
    assert.deepEqual(
      (decoded.prepared as Record<string, unknown>).attemptId,
      'attempt-1',
    );
    assert.deepEqual(decoded.window, window);
    const body = stringifyProtocolJson(
      { status: 'HANDOFF_REJECTED', reason: 'ACTION_HASH_MISMATCH' },
      'test.reconcile.response',
    );
    jsonResponse(response, 200, body);
  });
  try {
    const client = new HyperliquidTestnetHttpStructuralEvidence({ keeperOrigin: server.origin });
    const result = await client.reconcile(
      prepared,
      handoff as never,
      { ...binding },
      { ...window },
    ) as Record<string, unknown>;
    assert.equal(result.status, 'HANDOFF_REJECTED');
    assert.equal(result.reason, 'ACTION_HASH_MISMATCH');
    assert.equal(server.captured.length, 1);
  } finally {
    await server.close();
  }
});

test('recovery execution forwards a reconciled source attempt and validates the keeper result', async () => {
  const sourceAttempt = { version: 1, status: 'RECOVERY_REQUIRED' };
  const asset = assetRef('usdc', new Uint8Array(32).fill(9), 6);
  const server = await startServer((captured, request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, SOLVER_TESTNET_RECOVERY_EXECUTE_PATH);
    const decoded = parseProtocolJson(captured.rawBody,
      'test.recovery.execute.request') as Record<string, unknown>;
    assert.deepEqual(Object.keys(decoded).sort(), [
      'projectedAggregateLoss', 'projectedRecoveryCosts', 'recoveryAttemptId',
      'recoverySequence', 'sourceAttempt',
    ]);
    assert.deepEqual(decoded.sourceAttempt, sourceAttempt);
    assert.equal(decoded.recoverySequence, 0);
    jsonResponse(response, 200, stringifyProtocolJson({
      plan: {
        version: 1,
        guarantee: 'NARYX_UNSIGNED_HYPERCORE_RECOVERY_V1',
        domain: {
          domainId: 'hypercore:testnet',
          domainManifestVersion: 1,
          domainManifestHash: new Uint8Array(32).fill(1),
        },
        recoverySequence: 0,
        actionExpiryMs: 1_001_000n,
        recoveryDeadlineMs: 1_010_000n,
        orders: [{ action: 'COMPLETE_MISSING_LEG' }],
      },
      submission: {
        status: 'ACKNOWLEDGED',
        handoff: { recoveryAttemptId: 'recovery-attempt-0001', recoverySequence: 0 },
        errorCommitment: null,
      },
    }, 'test.recovery.execute.response'));
  });
  try {
    const client = new HyperliquidRecoveryTestnetHttpExecution({ keeperOrigin: server.origin });
    const result = await client.execute({
      recoveryAttemptId: 'recovery-attempt-0001',
      sourceAttempt,
      recoverySequence: 0,
      projectedRecoveryCosts: [{ asset, atoms: 10n }],
      projectedAggregateLoss: { asset, atoms: 100n },
    });
    assert.equal(result.plan.recoverySequence, 0);
    assert.equal(result.submission.status, 'ACKNOWLEDGED');
  } finally {
    await server.close();
  }
});

test('recovery continuation forwards only durable lineage coordinates and remaining bounds', async () => {
  const asset = assetRef('usdc', new Uint8Array(32).fill(9), 6);
  const server = await startServer((captured, request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, SOLVER_TESTNET_RECOVERY_CONTINUE_PATH);
    const decoded = parseProtocolJson(captured.rawBody,
      'test.recovery.continue.request') as Record<string, unknown>;
    assert.deepEqual(Object.keys(decoded).sort(), [
      'previousRecoveryAttemptId', 'projectedAggregateLoss', 'projectedRecoveryCosts',
      'recoveryAttemptId', 'recoverySequence',
    ]);
    assert.equal(decoded.previousRecoveryAttemptId, 'recovery-attempt-0001');
    assert.equal(decoded.recoverySequence, 1);
    jsonResponse(response, 200, stringifyProtocolJson({
      plan: {
        version: 1,
        guarantee: 'NARYX_UNSIGNED_HYPERCORE_RECOVERY_V1',
        domain: {
          domainId: 'hypercore:testnet',
          domainManifestVersion: 1,
          domainManifestHash: new Uint8Array(32).fill(1),
        },
        recoverySequence: 1,
        actionExpiryMs: 1_001_000n,
        recoveryDeadlineMs: 1_010_000n,
        orders: [{ action: 'COMPLETE_MISSING_LEG' }],
      },
      submission: {
        status: 'ACKNOWLEDGED',
        handoff: { recoveryAttemptId: 'recovery-attempt-0002', recoverySequence: 1 },
        errorCommitment: null,
      },
    }, 'test.recovery.continue.response'));
  });
  try {
    const client = new HyperliquidRecoveryTestnetHttpExecution({ keeperOrigin: server.origin });
    const result = await client.continue({
      recoveryAttemptId: 'recovery-attempt-0002',
      previousRecoveryAttemptId: 'recovery-attempt-0001',
      recoverySequence: 1,
      projectedRecoveryCosts: [{ asset, atoms: 7n }],
      projectedAggregateLoss: { asset, atoms: 80n },
    });
    assert.equal(result.plan.recoverySequence, 1);
    assert.equal(result.submission.handoff.recoveryAttemptId, 'recovery-attempt-0002');
  } finally {
    await server.close();
  }
});

test('recovery reconciliation forwards only stored evidence coordinates and validates the outcome', async () => {
  const checkpoint = {
    version: 1,
    attemptCommitment: `0x${'aa'.repeat(32)}`,
    account,
    baseSpotBalanceAtoms: 0n,
    perpetualPositionAtoms: 0n,
    observedAtMs: window.startTimeMs,
    rawResponseCommitments: [],
  };
  const server = await startServer((captured, request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, SOLVER_TESTNET_RECOVERY_RECONCILE_PATH);
    const decoded = parseProtocolJson(captured.rawBody,
      'test.recovery.reconcile.request') as Record<string, unknown>;
    assert.deepEqual(Object.keys(decoded).sort(), [
      'binding', 'checkpoint', 'recoveryAttemptId', 'window',
    ]);
    assert.deepEqual(decoded.checkpoint, checkpoint);
    jsonResponse(response, 200, stringifyProtocolJson({
      status: 'RECONCILED',
      attempt: {
        version: 1,
        status: 'RECOVERED_FLAT',
        reasons: [],
        plan: {
          version: 1,
          guarantee: 'NARYX_UNSIGNED_HYPERCORE_RECOVERY_V1',
          domain: {
            domainId: 'hypercore:testnet',
            domainManifestVersion: 1,
            domainManifestHash: new Uint8Array(32).fill(1),
          },
          recoverySequence: 0,
        },
        acceptedEvidence: { evidenceVersion: 11n, observedAtMs: 1_000_000n },
        lockEvidence: null,
      },
      accountObservation: { orders: [] },
      observedFills: [],
      rawResponseCommitments: [{
        operation: 'clearinghouseState',
        request: { operation: 'clearinghouseState', user: tradingAccount },
        requestedAtMs: 999_900,
        receivedAtMs: 1_000_000,
        sha256: `0x${'bb'.repeat(32)}`,
      }],
    }, 'test.recovery.reconcile.response'));
  });
  try {
    const client = new HyperliquidRecoveryTestnetHttpReconciliation({
      keeperOrigin: server.origin,
    });
    const result = await client.reconcile({
      recoveryAttemptId: 'recovery-attempt-0001',
      checkpoint,
      binding,
      window,
    });
    assert.equal(result.status, 'RECONCILED');
    assert.equal(result.attempt.status, 'RECOVERED_FLAT');
    assert.equal(result.rawResponseCommitments[0]!.sha256, `0x${'bb'.repeat(32)}`);
  } finally {
    await server.close();
  }
});

test('loopback coordinator factory stays disabled unless explicitly enabled', async () => {
  const submission = {
    submitPackage: async () => {
      throw new Error('must not submit');
    },
  };
  const disabled = createHyperliquidTestnetLoopbackCoordinator(submission as never, {
    keeperOrigin: 'http://127.0.0.1:8789',
    enabled: false,
  });
  assert.equal(disabled, null);

  const enabled = createHyperliquidTestnetLoopbackCoordinator(submission as never, {
    keeperOrigin: 'http://127.0.0.1:8789',
    enabled: true,
  });
  assert.ok(enabled !== null);
});

test('generalized strategy evidence preserves canonical leg fill atoms', async () => {
  const server = await startServer((captured, request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, SOLVER_TESTNET_STRATEGY_EVIDENCE_RECONCILE_PATH);
    const decoded = parseProtocolJson(captured.rawBody,
      'test.strategy.reconcile.request') as Record<string, unknown>;
    assert.deepEqual(Object.keys(decoded).sort(), [
      'account', 'actionHash', 'attemptId', 'batchStage', 'binding',
      'clientOrderIds', 'durableRevision', 'legIds', 'plan', 'requestCommitment', 'window',
    ]);
    jsonResponse(response, 200, stringifyProtocolJson({
      status: 'COMPLETE',
      outcome: 'COMPLETED',
      reasons: [],
      observedAtMs: 949_999,
      legs: [{
        legId: 'leg-1',
        clientOrderId: `0x${'21'.repeat(16)}`,
        plannedSignedBaseAtoms: 100n,
        filledSignedBaseAtoms: 100n,
        terminalStatus: 'FILLED',
        openOrderStatus: 'NONE',
        orderId: 1,
        fillCount: 1,
        grossQuoteAtoms: 600n,
        feeAssetId: 'base',
        feeAssetDecimals: 8,
        feeAtoms: 1n,
        venueFeeQuoteAtoms: 6n,
        observedAtMs: 949_998,
      }],
      rawResponseCommitments: [],
    }, 'test.strategy.reconcile.response'));
  });
  try {
    const client = new HyperliquidStrategyTestnetHttpEvidence({ keeperOrigin: server.origin });
    const result = await client.collect({
      handoff: {
        collector: 'HYPERLIQUID_TESTNET_AUTHORITATIVE_EVIDENCE',
        attemptId: 'strategy-attempt-1',
        batchStage: 0,
        account: account as never,
        actionHash: `0x${'aa'.repeat(32)}`,
        actionCommitmentScheme: 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1',
        requestCommitment: `0x${'bb'.repeat(32)}`,
        durableRevision: 'sqlite-strategy-v1:1',
        legIds: ['leg-1'],
        clientOrderIds: [`0x${'21'.repeat(16)}`],
      },
      binding: {
        spotAssetId: 10_007,
        perpetualAssetId: 3,
        baseFeeToken: 'BASE',
        quoteFeeToken: 'USDC',
      },
      plan: planFixture() as never,
      window,
    });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.legs[0]?.filledSignedBaseAtoms, 100n);
    assert.equal(result.legs[0]?.venueFeeQuoteAtoms, 6n);
  } finally {
    await server.close();
  }
});

test('netting residual evidence preserves terminal quantity and fee atoms', async () => {
  const server = await startServer((captured, request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, SOLVER_TESTNET_NETTING_RESIDUAL_EVIDENCE_RECONCILE_PATH);
    const decoded = parseProtocolJson(captured.rawBody,
      'test.netting-residual.reconcile.request') as Record<string, unknown>;
    assert.deepEqual(Object.keys(decoded).sort(), [
      'account', 'actionHash', 'attemptId', 'binding', 'clientOrderId',
      'durableRevision', 'instrumentHash', 'intentHash', 'plan',
      'requestCommitment', 'window',
    ]);
    jsonResponse(response, 200, stringifyProtocolJson({
      status: 'COMPLETE',
      observation: {
        clientOrderId: `0x${'31'.repeat(16)}`,
        terminalStatus: 'FILLED',
        filledSignedQuantityAtoms: 100n,
        grossQuoteAtoms: 600n,
        feeQuoteAtoms: 2n,
        submittedAtMs: 949_900n,
        observedAtMs: 949_999n,
        executionReferenceHash: `0x${'41'.repeat(32)}`,
        authoritativeEvidenceHash: `0x${'42'.repeat(32)}`,
      },
      rawResponseCommitments: [],
    }, 'test.netting-residual.reconcile.response'));
  });
  try {
    const client = new HyperliquidNettingResidualTestnetHttpEvidence({
      keeperOrigin: server.origin,
    });
    const result = await client.collect({
      handoff: {
        collector: 'HYPERLIQUID_TESTNET_AUTHORITATIVE_EVIDENCE',
        attemptId: 'net-residual-attempt-1',
        account: account as never,
        actionHash: `0x${'aa'.repeat(32)}`,
        actionCommitmentScheme: 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1',
        requestCommitment: `0x${'bb'.repeat(32)}`,
        durableRevision: 'sqlite-net-residual-v1:1',
        clientOrderId: `0x${'31'.repeat(16)}`,
        intentHash: new Uint8Array(32).fill(2) as never,
        instrumentHash: new Uint8Array(32).fill(3) as never,
      },
      binding: {
        assetId: 3,
        marketKind: 'PERPETUAL',
        baseFeeToken: 'SOL',
        quoteFeeToken: 'USDC',
      },
      plan: planFixture() as never,
      window,
    });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.observation.filledSignedQuantityAtoms, 100n);
    assert.equal(result.observation.feeQuoteAtoms, 2n);
  } finally {
    await server.close();
  }
});
