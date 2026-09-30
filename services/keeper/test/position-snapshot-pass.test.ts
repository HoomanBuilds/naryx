import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { assetRef, domainRef, positionSnapshotRecord, positionSnapshotRecordHash, type PositionSnapshotRecordInput } from '@naryx/protocol-types';
import { ed25519HashSigner, httpSnapshotPublisher, loadPositionSnapshotConfig, runPositionSnapshotPass, type WatchedPositionAccount } from '../src/index.js';

const btc = assetRef('btc', '22'.repeat(32), 8);
const usdc = assetRef('usdc', '33'.repeat(32), 6);
const binding = {
  coin: 'BTC',
  venueId: 'hypercore',
  marketId: 'btc-perp',
  underlyingId: 'btc',
  baseAsset: btc,
  riskDomainId: 'btc-carry',
  dependencyIds: ['venue:hypercore'],
  closeRoutes: [],
};
const account = (strategyAccount: string, user: `0x${string}`): WatchedPositionAccount => ({
  strategyAccount,
  user,
  sourceId: 'hypercore-testnet-info',
  snapshotPrefix: `hl-${strategyAccount}`,
  domain: domainRef('hypercore:testnet', 1, '11'.repeat(32)),
  quoteAsset: usdc,
  perpBindings: [binding],
  spotBindings: [{ ...binding, marketId: 'btc-spot' }],
});

test('each account is read, normalized, signed over its hash, and published; one failure spares the rest', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signHash = ed25519HashSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  const published: PositionSnapshotRecordInput[] = [];
  const reader = {
    clearinghouseState: async (user: `0x${string}`) => {
      if (user.endsWith('02')) throw new Error('rate limited');
      return { time: 1_790_000_000_000, assetPositions: [{ position: { coin: 'BTC', szi: '-0.5', positionValue: '30000', liquidationPx: null, marginUsed: '3000' } }] };
    },
    spotClearinghouseState: async () => ({ balances: [{ coin: 'BTC', total: '0.5' }, { coin: 'PURR', total: '10' }] }),
    allMids: async () => ({ BTC: '60000' }),
  };
  const results = await runPositionSnapshotPass({
    environment: 'testnet',
    accounts: [account('strategy-1', `0x${'00'.repeat(19)}01`), account('strategy-2', `0x${'00'.repeat(19)}02`)],
    reader,
    authority: 'position-key-1',
    signHash,
    publish: async (record) => {
      published.push(record);
    },
    nowMs: () => 1_790_000_000_500,
  });
  assert.deepEqual(results.map((entry) => [entry.strategyAccount, entry.status, entry.positionCount]), [
    ['strategy-1', 'PUBLISHED', 2],
    ['strategy-2', 'FAILED', undefined],
  ]);
  assert.match(results[1]?.detail ?? '', /rate limited/);
  const record = positionSnapshotRecord(published[0]!);
  assert.deepEqual(record.unmappedInstruments, ['PURR']);
  assert.equal(record.observedAtMs, 1_790_000_000_500n);
  assert.equal(verify(null, positionSnapshotRecordHash(record), publicKey, record.signature), true);
});

test('the publisher posts protocol JSON and surfaces a refusal, and the watchlist stays off unless configured', async () => {
  const calls: { url: string; body: string }[] = [];
  const publisher = httpSnapshotPublisher('http://127.0.0.1:8080/', async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok: false, status: 403, text: async () => '{"error":{"code":"UNKNOWN_AUTHORITY"}}' };
  });
  await assert.rejects(publisher({ recordVersion: 1 } as never), /403/);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:8080/v1/position-snapshots');
  assert.equal(loadPositionSnapshotConfig({}, () => '', JSON.parse), undefined);
  const file = { intervalMs: 60_000, environment: 'testnet', apiBaseUrl: 'http://127.0.0.1:8080', authority: 'position-key-1', accounts: [account('strategy-1', `0x${'00'.repeat(19)}01`)] };
  const env = { NARYX_POSITION_WATCHLIST: '/etc/naryx/positions.json', NARYX_POSITION_AUTHORITY_KEY_FILE: '/etc/naryx/position-key.pem' };
  assert.equal(loadPositionSnapshotConfig(env, () => '', () => file)?.accounts.length, 1);
  assert.throws(() => loadPositionSnapshotConfig(env, () => '', () => ({ ...file, environment: 'mainnet' })), /non-mainnet/);
  assert.throws(() => loadPositionSnapshotConfig({ ...env, NARYX_POSITION_AUTHORITY_KEY_FILE: 'key.pem' }, () => '', () => file), /absolute path/);
  assert.throws(() => loadPositionSnapshotConfig(env, () => '', () => ({ ...file, apiBaseUrl: 'http://example.com' })), /https or a loopback/);
});
