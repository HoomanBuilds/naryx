import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { getWalletAddress } from '@nktkas/hyperliquid/signing';
import { commitmentHash, stringifyProtocolJson } from '@naryx/protocol-types';
import {
  API_HYPERLIQUID_TESTNET_ATTEMPT_PATH,
  API_HYPERLIQUID_TESTNET_SOURCE_ATTEMPT_PATH,
  HYPERLIQUID_SERVER_SIGNER_SCOPE,
  HttpHyperliquidTestnetCompositeAttemptProvider,
  HttpHyperliquidTestnetSelectedSourceProvider,
  HttpHyperliquidTestnetTrustedAttemptProvider,
  loadHyperliquidTestnetAgentSigner,
  type HyperliquidTestnetAttemptHandoff,
} from '../src/index.js';

const attemptId = 'attempt-process-0001';
const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;

type LegacyAttempt = Extract<HyperliquidTestnetAttemptHandoff, { readonly admission: unknown }>;

function attempt(): LegacyAttempt {
  return {
    attemptId,
    admission: {} as LegacyAttempt['admission'],
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

test('fetches selected source evidence from its non-live loopback route', async () => {
  let observedUrl = '';
  const provider = new HttpHyperliquidTestnetSelectedSourceProvider({
    apiOrigin: 'http://127.0.0.1:8787',
    fetchImplementation: async (input) => {
      observedUrl = String(input);
      return jsonResponse({ version: 1, attempt: attempt() });
    },
  });
  assert.equal((await provider.resolve(attemptId))?.attemptId, attemptId);
  assert.equal(observedUrl,
    `http://127.0.0.1:8787${API_HYPERLIQUID_TESTNET_SOURCE_ATTEMPT_PATH}${attemptId}`);
});

test('composes a generalized strategy attempt from exact package and source commitments', async () => {
  const strategyAttemptId = `strategy-hl-${'10'.repeat(24)}`;
  const sourceAttemptId = `hyperliquid-testnet-${'20'.repeat(24)}`;
  const orderHash = '31'.repeat(32);
  const graphHash = '32'.repeat(32);
  const quoteHash = '33'.repeat(32);
  const routeHash = '34'.repeat(32);
  const sourceOrderHash = '35'.repeat(32);
  const source = {
    ...attempt(),
    attemptId: sourceAttemptId,
    admission: { orderHash: commitmentHash(sourceOrderHash) },
  } as unknown as HyperliquidTestnetAttemptHandoff;
  const strategyPlan = {
    version: 1,
    guarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY',
  } as const;
  const provider = new HttpHyperliquidTestnetCompositeAttemptProvider({
    apiOrigin: 'http://127.0.0.1:8787',
    fetchImplementation: async () => jsonResponse({
      version: 1,
      attempt: {
        attemptId: strategyAttemptId,
        idempotencyKey: 'strategy-attempt-test-0001',
        orderHashHex: orderHash,
        graphHashHex: graphHash,
        quoteHashHex: quoteHash,
        routeHashHex: routeHash,
        sourceOrderHashHex: sourceOrderHash,
        status: 'HYPERLIQUID_TESTNET_QUOTE_SELECTED',
        selectedAtMs: 901_000,
      },
      sourceAttemptId,
    }),
    sourceAttempts: { resolve: async (requested) => requested === sourceAttemptId ? source : undefined },
    liveAttempts: { resolve: async () => undefined },
    packages: {
      getByQuote: async (requested) => {
        assert.deepEqual(requested, commitmentHash(quoteHash));
        return {
          orderHashHex: orderHash,
          graphHashHex: graphHash,
          quoteHashHex: quoteHash,
          routeHashHex: routeHash,
        } as never;
      },
    },
    preparations: {
      prepareDocuments: async () => ({
        orderHash: commitmentHash(orderHash),
        graphHash: commitmentHash(graphHash),
        quoteHash: commitmentHash(quoteHash),
        routeHash: commitmentHash(routeHash),
        domains: [{ kind: 'HYPERCORE_EXECUTOR', plan: strategyPlan }],
      }) as never,
    },
  });

  const resolved = await provider.resolve(strategyAttemptId);
  assert.equal(resolved?.attemptId, strategyAttemptId);
  assert.ok(resolved?.strategy && 'sourceAttemptId' in resolved.strategy);
  assert.equal(resolved.strategy.sourceAttemptId, sourceAttemptId);
  assert.equal(resolved?.strategy?.plan, strategyPlan);
  assert.deepEqual(resolved?.strategy?.graphHash, commitmentHash(graphHash));
});

test('composes a native generalized attempt only for the trusted market assets', async () => {
  const strategyAttemptId = `strategy-hl-${'40'.repeat(24)}`;
  const orderHash = '41'.repeat(32);
  const graphHash = '42'.repeat(32);
  const quoteHash = '43'.repeat(32);
  const routeHash = '44'.repeat(32);
  const domainHash = '45'.repeat(32);
  const seriesHash = '46'.repeat(32);
  const executionHash = '47'.repeat(32);
  const baseHash = '48'.repeat(32);
  const quoteAssetHash = '49'.repeat(32);
  const market = {
    spot: {
      adapterId: 'hypercore-spot-v1', adapterManifestVersion: 1,
      adapterManifestHash: '51'.repeat(32), venueId: 'hypercore', venueManifestVersion: 1,
      venueManifestHash: '52'.repeat(32), marketId: 'spot-btc-usdc', marketManifestVersion: 1,
      marketManifestHash: '53'.repeat(32), assetId: 7, sizeDecimals: 5,
      universeIndex: 7, tokenIndex: 1,
    },
    perpetual: {
      adapterId: 'hypercore-perpetual-v1', adapterManifestVersion: 1,
      adapterManifestHash: '54'.repeat(32), venueId: 'hypercore', venueManifestVersion: 1,
      venueManifestHash: '55'.repeat(32), marketId: 'perp-btc-usdc', marketManifestVersion: 1,
      marketManifestHash: '56'.repeat(32), assetId: 3, sizeDecimals: 5, assetIndex: 3,
    },
    quoteTokenIndex: 0,
  } as const;
  const strategyPlan = {
    version: 1,
    guarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY',
    domain: {
      domainId: 'hypercore:testnet', domainManifestVersion: 1,
      domainManifestHash: commitmentHash(domainHash),
    },
    requestExpiryMs: 950_000n,
    orders: [{
      baseAsset: { assetId: 'btc', decimals: 5, assetManifestHash: commitmentHash(baseHash) },
      quoteAsset: { assetId: 'usdc', decimals: 6, assetManifestHash: commitmentHash(quoteAssetHash) },
    }],
  } as const;
  const provider = new HttpHyperliquidTestnetCompositeAttemptProvider({
    apiOrigin: 'http://127.0.0.1:8787',
    fetchImplementation: async () => jsonResponse({
      version: 2,
      attempt: {
        attemptId: strategyAttemptId,
        idempotencyKey: 'strategy-attempt-test-0002',
        orderHashHex: orderHash,
        graphHashHex: graphHash,
        quoteHashHex: quoteHash,
        routeHashHex: routeHash,
        status: 'HYPERLIQUID_TESTNET_QUOTE_SELECTED',
        selectedAtMs: 901_000,
      },
      runtime: {
        domainId: 'hypercore:testnet', domainManifestVersion: 1, domainManifestHashHex: domainHash,
        seriesManifestHash: seriesHash, executionClassManifestHash: executionHash,
        baseAsset: { assetId: 'btc', decimals: 5, assetManifestHashHex: baseHash },
        quoteAsset: { assetId: 'usdc', decimals: 6, assetManifestHashHex: quoteAssetHash },
        market,
        limits: { maxEvidenceAgeMs: 200_000, maxSnapshotSkewMs: 5_000, maxFillPages: 4 },
      },
    }),
    liveAttempts: { resolve: async () => undefined },
    sourceAttempts: { resolve: async () => { throw new Error('native attempts have no source attempt'); } },
    packages: {
      getByQuote: async () => ({
        orderHashHex: orderHash, graphHashHex: graphHash, quoteHashHex: quoteHash, routeHashHex: routeHash,
        order: {
          expiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS', expiryValue: 950_000n,
          seriesManifestHash: commitmentHash(seriesHash),
          executionClassManifestHash: commitmentHash(executionHash),
        },
        quote: { validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS', validUntilValue: 940_000n },
        route: { routeExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS', routeExpiryValue: 930_000n },
      }) as never,
    },
    preparations: {
      prepareDocuments: async () => ({
        orderHash: commitmentHash(orderHash), graphHash: commitmentHash(graphHash),
        quoteHash: commitmentHash(quoteHash), routeHash: commitmentHash(routeHash),
        domains: [{ kind: 'HYPERCORE_EXECUTOR', plan: strategyPlan }],
      }) as never,
    },
  });

  const resolved = await provider.resolve(strategyAttemptId);
  assert.ok(resolved && 'authority' in resolved);
  assert.equal(resolved.authority.baseAssetDecimals, 5);
  assert.equal(resolved.authority.requiredUntilMs, 950_000n);
  assert.equal(resolved.strategy.plan, strategyPlan);
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
