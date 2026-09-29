import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import {
  HyperliquidTestnetHttpStructuralEvidence,
  SOLVER_TESTNET_EVIDENCE_PREPARE_PATH,
  SOLVER_TESTNET_EVIDENCE_RECONCILE_PATH,
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
