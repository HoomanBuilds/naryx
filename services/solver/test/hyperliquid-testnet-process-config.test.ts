import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { getWalletAddress } from '@nktkas/hyperliquid/signing';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import {
  API_HYPERLIQUID_TESTNET_ATTEMPT_PATH,
  HYPERLIQUID_SERVER_SIGNER_SCOPE,
  HttpHyperliquidTestnetTrustedAttemptProvider,
  loadHyperliquidTestnetAgentSigner,
  type HyperliquidTestnetAttemptHandoff,
} from '../src/index.js';

const attemptId = 'attempt-process-0001';
const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;

function attempt(): HyperliquidTestnetAttemptHandoff {
  return {
    attemptId,
    admission: {} as HyperliquidTestnetAttemptHandoff['admission'],
    seriesManifestHash: '02'.repeat(32),
    executionClassManifestHash: '03'.repeat(32),
    market: {
      spot: { assetId: 7, sizeDecimals: 3, universeIndex: 7, tokenIndex: 1 },
      perpetual: { assetId: 3, sizeDecimals: 3, assetIndex: 3 },
      quoteTokenIndex: 0,
    },
    limits: { maxEvidenceAgeMs: 200_000, maxSnapshotSkewMs: 5_000, maxFillPages: 4 },
    selectedAtMs: 900_000,
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
  assert.equal(resolved?.attemptId, attemptId);
  assert.equal('plan' in (resolved as unknown as Record<string, unknown>), false);
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
