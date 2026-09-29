import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TESTNET_API_URL } from '@nktkas/hyperliquid';
import type { PackageAdmission } from '@naryx/protocol-types';
import {
  HyperliquidAuthorityFenceStore,
  HyperliquidTestnetAuthorityPreflight,
  type HyperliquidSubmissionAccount,
  type HyperliquidTestnetAuthorityConfig,
  type HyperliquidTestnetAuthorityReadPort,
  type HyperliquidTestnetAuthoritySnapshot,
} from '../src/index.js';

const nowMs = 1_800_000_000_000;
const agent = `0x${'11'.repeat(20)}` as const;
const master = `0x${'22'.repeat(20)}` as const;
const trading = `0x${'33'.repeat(20)}` as const;
const unexpected = `0x${'44'.repeat(20)}` as const;

const account: HyperliquidSubmissionAccount = Object.freeze({
  masterAccount: master,
  tradingAccount: trading,
  accountKind: 'SUBACCOUNT',
});

const config: HyperliquidTestnetAuthorityConfig = Object.freeze({
  account,
  approvedAgent: agent,
  incidentBufferMs: 60_000,
  expectedPortfolioMarginEnabled: false,
  expectedPerpetualLeverageMode: 'cross',
  allowedSpotTokenIndices: Object.freeze([0, 7]),
  allowedPerpetualCoins: Object.freeze(['BTC']),
  maxSnapshotAgeMs: 5_000,
});

function admission(recoveryDeadline = nowMs + 120_000): PackageAdmission {
  return {
    order: {
      expiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
      expiryValue: BigInt(nowMs + 30_000),
      hyperliquidRecoveryExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
      hyperliquidRecoveryDeadlineValue: BigInt(recoveryDeadline),
    },
  } as PackageAdmission;
}

function snapshot(
  agents: HyperliquidTestnetAuthoritySnapshot['agents'] = [{
    address: agent,
    name: 'naryx-testnet',
    validUntil: nowMs + 300_000,
  }],
): HyperliquidTestnetAuthoritySnapshot {
  return {
    environment: 'testnet',
    apiUrl: TESTNET_API_URL,
    requestedAtMs: nowMs - 10,
    receivedAtMs: nowMs,
    agents,
    agentRole: { role: 'agent', data: { user: master } },
    masterRole: { role: 'user' },
    tradingRole: { role: 'subAccount', data: { master } },
    subAccounts: [{
      name: 'naryx-testnet',
      subAccountUser: trading,
      master,
      clearinghouseState: {},
      spotState: {},
    }] as HyperliquidTestnetAuthoritySnapshot['subAccounts'],
    perpetualState: {
      assetPositions: [{
        type: 'oneWay',
        position: { coin: 'BTC', szi: '0.01', leverage: { type: 'cross', value: 1 } },
      }],
    } as HyperliquidTestnetAuthoritySnapshot['perpetualState'],
    spotState: {
      portfolioMarginEnabled: false,
      balances: [
        { coin: 'USDC', token: 0, total: '100', hold: '0', entryNtl: '0' },
        { coin: 'BTC', token: 7, total: '0.01', hold: '0', entryNtl: '0' },
      ],
    },
    assetModes: [{
      user: trading,
      coin: 'BTC',
      leverage: { type: 'cross', value: 1 },
      maxTradeSzs: ['0', '1'],
      availableToTrade: ['0', '1'],
      markPx: '100000',
    }],
  };
}

function reader(
  value: HyperliquidTestnetAuthoritySnapshot,
  onRead?: () => void,
): HyperliquidTestnetAuthorityReadPort {
  return {
    environment: 'testnet',
    apiUrl: TESTNET_API_URL,
    async read() {
      onRead?.();
      return value;
    },
  };
}

async function withStore(
  run: (store: HyperliquidAuthorityFenceStore, databasePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-hyperliquid-authority-'));
  const databasePath = join(directory, 'authority.sqlite');
  const store = new HyperliquidAuthorityFenceStore(databasePath);
  try {
    await run(store, databasePath);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('activates only for the exact authority and account inventory', async () => {
  await withStore(async (store) => {
    const preflight = new HyperliquidTestnetAuthorityPreflight(
      reader(snapshot()), store, config, () => nowMs,
    );
    await preflight.qualify(admission());
    assert.equal(store.state(), 'ACTIVE');
  });
});

test('moves active authority to fence-pending when approval misses recovery horizon', async () => {
  await withStore(async (store) => {
    const valid = new HyperliquidTestnetAuthorityPreflight(
      reader(snapshot()), store, config, () => nowMs,
    );
    await valid.qualify(admission());
    const expiring = snapshot([{
      address: agent,
      name: 'naryx-testnet',
      validUntil: nowMs + 150_000,
    }]);
    await assert.rejects(
      new HyperliquidTestnetAuthorityPreflight(
        reader(expiring), store, config, () => nowMs,
      ).qualify(admission()),
      /expires before package recovery and incident horizon/,
    );
    assert.equal(store.state(), 'FENCE_PENDING');
  });
});

test('rejects an unexpected active agent and fences submissions', async () => {
  await withStore(async (store) => {
    const inventory = snapshot([
      { address: agent, name: 'naryx-testnet', validUntil: nowMs + 300_000 },
      { address: unexpected, name: 'unknown', validUntil: null },
    ]);
    await assert.rejects(
      new HyperliquidTestnetAuthorityPreflight(
        reader(inventory), store, config, () => nowMs,
      ).qualify(admission()),
      /unexpected active agent approval/,
    );
    assert.equal(store.state(), 'FENCE_PENDING');
  });
});

test('persists terminal authority fencing across restart', async () => {
  await withStore(async (store, databasePath) => {
    assert.equal(store.fenced(), 'FENCED');
    store.close();
    const restarted = new HyperliquidAuthorityFenceStore(databasePath);
    try {
      assert.equal(restarted.state(), 'FENCED');
      assert.equal(restarted.activate(), 'FENCED');
      assert.equal(restarted.manualTakeover(), 'MANUAL_TAKEOVER');
      assert.equal(restarted.manualTakeover(), 'MANUAL_TAKEOVER');
    } finally {
      restarted.close();
    }
  });
});

test('blocks submission preflight without reading inventory after durable fence', async () => {
  await withStore(async (store) => {
    store.fenced();
    let reads = 0;
    const preflight = new HyperliquidTestnetAuthorityPreflight(
      reader(snapshot(), () => { reads += 1; }), store, config, () => nowMs,
    );
    await assert.rejects(preflight.qualify(admission()), /durable authority fence blocks/);
    assert.equal(reads, 0);
    assert.equal(store.state(), 'FENCED');
  });
});
