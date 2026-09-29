import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { getWalletAddress } from '@nktkas/hyperliquid/signing';
import { HYPERCORE_EXECUTION_GUARANTEE } from '@naryx/adapter-hyperliquid';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import {
  API_HYPERLIQUID_TESTNET_ATTEMPT_PATH,
  HYPERLIQUID_SERVER_SIGNER_SCOPE,
  HttpHyperliquidTestnetTrustedAttemptProvider,
  loadHyperliquidTestnetAgentSigner,
  type HyperliquidTestnetRuntimeCoordinatorInput,
} from '../src/index.js';

const attemptId = 'attempt-process-0001';
const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;

function hash(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function attempt(): HyperliquidTestnetRuntimeCoordinatorInput {
  const spot = {
    a: 10_007, b: true, p: '60000', s: '0.001', r: false,
    t: { limit: { tif: 'Ioc' as const } }, c: `0x${'51'.repeat(16)}` as const,
  };
  const perpetual = {
    a: 3, b: false, p: '60000', s: '0.001', r: false,
    t: { limit: { tif: 'Ioc' as const } }, c: `0x${'52'.repeat(16)}` as const,
  };
  return {
    expectedVersion: 0n,
    attemptId,
    agentWallet,
    signerLeaseId: 'solver-process-1',
    plan: {
      version: 1,
      guarantee: HYPERCORE_EXECUTION_GUARANTEE,
      domain: {
        domainId: 'hypercore:testnet', domainManifestVersion: 1, domainManifestHash: hash(1),
      },
      commitments: {
        seriesManifestHash: hash(2), executionClassManifestHash: hash(3),
        orderHash: hash(4), quoteHash: hash(5), routeHash: hash(6),
      },
      requestExpiryMs: 1_005_000n,
      unsignedRequestFields: {
        action: { type: 'order', grouping: 'na', orders: [spot, perpetual] },
        expiresAfter: 1_005_000,
      },
      legs: [
        { role: 'SPOT', legIndex: 0, clientOrderId: spot.c, order: spot },
        { role: 'PERPETUAL', legIndex: 1, clientOrderId: perpetual.c, order: perpetual },
      ],
    } as unknown as HyperliquidTestnetRuntimeCoordinatorInput['plan'],
    account: { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' },
    nonce: 1_000_001n,
    nowMs: 1_000_000n,
    vaultAddress: tradingAccount,
    binding: {
      spotUniverseIndex: 7, spotTokenIndex: 1, perpetualAssetIndex: 3, quoteTokenIndex: 0,
    },
    checkpointWindow: {
      startTimeMs: 900_000, endTimeMs: 950_000, nowMs: 1_000_000,
      maxEvidenceAgeMs: 200_000, maxSnapshotSkewMs: 5_000,
    },
    reconciliationWindow: {
      startTimeMs: 950_000, endTimeMs: 1_000_000, nowMs: 1_000_000,
      maxEvidenceAgeMs: 200_000, maxSnapshotSkewMs: 5_000, maxFillPages: 4,
    },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(stringifyProtocolJson(value, 'test.attempt'), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('fetches one exact attempt from the loopback API contract', async () => {
  let observedUrl = '';
  const provider = new HttpHyperliquidTestnetTrustedAttemptProvider({
    apiOrigin: 'http://127.0.0.1:8787',
    timeoutMs: 2_000,
    fetchImplementation: async (input, init) => {
      observedUrl = String(input);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal instanceof AbortSignal);
      return jsonResponse({ version: 1, attempt: attempt() });
    },
  });

  const resolved = await provider.resolve(attemptId);
  assert.equal(observedUrl,
    `http://127.0.0.1:8787${API_HYPERLIQUID_TESTNET_ATTEMPT_PATH}${attemptId}`);
  assert.equal(resolved?.attemptId, attemptId);
  assert.equal(resolved?.plan.domain.domainId, 'hypercore:testnet');
});

test('rejects non-loopback origins, malformed envelopes, and oversized responses', async () => {
  assert.throws(() => new HttpHyperliquidTestnetTrustedAttemptProvider({
    apiOrigin: 'https://api.example.com',
  }), /loopback HTTP origin/);

  const malformed = new HttpHyperliquidTestnetTrustedAttemptProvider({
    apiOrigin: 'http://localhost:8787',
    fetchImplementation: async () => jsonResponse({ version: 1, attempt: attempt(), extra: true }),
  });
  await assert.rejects(malformed.resolve(attemptId), /response fields are invalid/);

  const oversized = new HttpHyperliquidTestnetTrustedAttemptProvider({
    apiOrigin: 'http://[::1]:8787',
    fetchImplementation: async () => new Response('{}', {
      headers: { 'content-type': 'application/json', 'content-length': '262145' },
    }),
  });
  await assert.rejects(oversized.resolve(attemptId), /response is too large/);
});

test('loads only an external permission-restricted Testnet key matching the expected agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-hyperliquid-agent-'));
  const keyPath = join(directory, 'agent.json');
  const privateKey = `0x${randomBytes(32).toString('hex')}` as const;
  const account = privateKeyToAccount(privateKey);
  writeFileSync(keyPath, JSON.stringify({
    version: 1,
    environment: 'TESTNET',
    privateKey,
  }), { mode: 0o600 });
  try {
    const signer = loadHyperliquidTestnetAgentSigner(keyPath, account.address.toLowerCase());
    assert.equal(signer.signerScope, HYPERLIQUID_SERVER_SIGNER_SCOPE);
    assert.equal(await getWalletAddress(signer), account.address.toLowerCase());

    chmodSync(keyPath, 0o644);
    assert.throws(() => loadHyperliquidTestnetAgentSigner(
      keyPath, account.address.toLowerCase(),
    ), /permissions must be 0400 or 0600/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
