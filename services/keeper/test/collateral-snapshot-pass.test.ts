import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import {
  assetRef,
  collateralSnapshot,
  collateralSnapshotHash,
  type CollateralSnapshotInput,
} from '@naryx/protocol-types';
import {
  ed25519HashSigner,
  httpCollateralSnapshotPublisher,
  loadCollateralSnapshotConfig,
  runCollateralSnapshotPass,
  type WatchedCollateralAccount,
} from '../src/index.js';

const usdc = assetRef('usdc', '33'.repeat(32), 6);

function account(strategyAccount: string, user: `0x${string}`): WatchedCollateralAccount {
  return {
    strategyAccount,
    user,
    owner: 'owner-1',
    sourceId: 'hypercore-testnet-clearinghouse',
    snapshotPrefix: `hl-collateral-${strategyAccount}`,
    asset: usdc,
    riskDomainId: 'hypercore-cross-margin',
    haircutBps: 100n,
    withdrawalDelayMs: 0n,
  };
}

test('publishes only venue-reported withdrawable collateral and signs the exact observation', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signHash = ed25519HashSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  const published: CollateralSnapshotInput[] = [];
  const results = await runCollateralSnapshotPass({
    environment: 'testnet',
    accounts: [
      account('strategy-1', `0x${'00'.repeat(19)}01`),
      account('strategy-2', `0x${'00'.repeat(19)}02`),
    ],
    reader: {
      clearinghouseState: async (user) => user.endsWith('01')
        ? { time: 1_790_000_000_000, withdrawable: '12.345678' }
        : { time: 1_790_000_000_000, withdrawable: '-1' },
    },
    authority: 'collateral-key-1',
    signHash,
    publish: async (record) => {
      published.push(record);
    },
    nowMs: () => 1_790_000_000_500,
  });

  assert.deepEqual(results.map((entry) => [entry.strategyAccount, entry.status, entry.availableQuoteAtoms]), [
    ['strategy-1', 'PUBLISHED', 12_345_678n],
    ['strategy-2', 'FAILED', undefined],
  ]);
  assert.match(results[1]?.detail ?? '', /negative/);
  const record = collateralSnapshot(published[0]!);
  assert.equal(record.mode, 'CROSS');
  assert.equal(record.ownAvailableQuoteAtoms, 12_345_678n);
  assert.equal(record.borrowAvailableQuoteAtoms, 0n);
  assert.equal(record.requestedBorrowQuoteAtoms, 0n);
  assert.equal(record.borrowCostQuoteAtoms, 0n);
  assert.equal(record.inventoryEligible, true);
  assert.equal(record.withdrawalAllowed, true);
  assert.equal(record.observedAtMs, 1_790_000_000_500n);
  assert.equal(verify(null, collateralSnapshotHash(record), publicKey, record.signature), true);
});

test('publisher uses the collateral endpoint and configuration rejects unsafe inputs', async () => {
  const calls: { url: string; body: string }[] = [];
  const publisher = httpCollateralSnapshotPublisher('http://127.0.0.1:8080/', async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok: false, status: 403, text: async () => '{"error":{"code":"UNKNOWN_AUTHORITY"}}' };
  });
  await assert.rejects(publisher({ version: 2 } as never), /403/);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:8080/v1/collateral-snapshots');
  assert.equal(loadCollateralSnapshotConfig({}, () => '', JSON.parse), undefined);

  const file = {
    intervalMs: 60_000,
    environment: 'testnet',
    apiBaseUrl: 'http://127.0.0.1:8080',
    authority: 'collateral-key-1',
    accounts: [account('strategy-1', `0x${'00'.repeat(19)}01`)],
  };
  const env = {
    NARYX_COLLATERAL_WATCHLIST: '/etc/naryx/collateral.json',
    NARYX_COLLATERAL_AUTHORITY_KEY_FILE: '/etc/naryx/collateral-key.pem',
  };
  assert.equal(loadCollateralSnapshotConfig(env, () => '', () => file)?.accounts.length, 1);
  assert.throws(() => loadCollateralSnapshotConfig(env, () => '', () => ({ ...file, environment: 'shadow-mainnet' })), /non-mainnet/);
  assert.throws(() => loadCollateralSnapshotConfig({ ...env, NARYX_COLLATERAL_AUTHORITY_KEY_FILE: 'key.pem' }, () => '', () => file), /absolute path/);
  assert.throws(() => loadCollateralSnapshotConfig(env, () => '', () => ({ ...file, accounts: [{ ...file.accounts[0], haircutBps: 10_001n }] })), /haircutBps/);
  assert.throws(() => loadCollateralSnapshotConfig(env, () => '', () => ({ ...file, accounts: [file.accounts[0], file.accounts[0]] })), /duplicates/);
});
