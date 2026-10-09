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
  type HyperliquidAuthorityClearancePort,
  type HyperliquidSubmissionAccount,
  type HyperliquidTestnetAuthorityConfig,
  type HyperliquidTestnetAuthorityReadPort,
  type HyperliquidTestnetAuthoritySnapshot,
} from '../src/index.js';

const nowMs = 1_800_000_000_000;
const agent = `0x${'11'.repeat(20)}` as const;
const master = `0x${'22'.repeat(20)}` as const;
const trading = `0x${'33'.repeat(20)}` as const;

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
  maxClearanceAgeMs: 5_000,
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
    perpetualDexStates: [{
      dex: '',
      state: {
        assetPositions: [{
          type: 'oneWay',
          position: { coin: 'BTC', szi: '0.01', leverage: { type: 'cross', value: 1 } },
        }],
      } as HyperliquidTestnetAuthoritySnapshot['perpetualState'],
    }],
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
    abstraction: 'disabled',
    dexAbstraction: false,
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

const reconciliationCommitment = `0x${'aa'.repeat(32)}` as const;
const evidenceCommitment = `0x${'bb'.repeat(32)}` as const;
const firstReviewerRoleCommitment = `0x${'cc'.repeat(32)}` as const;
const secondReviewerRoleCommitment = `0x${'dd'.repeat(32)}` as const;

function clearance(requestedAtMs = nowMs - 10): HyperliquidAuthorityClearancePort {
  return {
    environment: 'testnet',
    apiUrl: TESTNET_API_URL,
    async read() {
      return {
        environment: 'testnet',
        apiUrl: TESTNET_API_URL,
        requestedAtMs,
        receivedAtMs: nowMs,
        unexpectedOpenOrders: 0,
        unexpectedPositions: 0,
        reconciliationCommitment,
        evidenceCommitment,
      };
    },
  };
}

const clearanceInput = Object.freeze({
  reconciliationCommitment,
  evidenceCommitment,
  firstReviewerRoleCommitment,
  secondReviewerRoleCommitment,
});

test('activates INITIALIZING only for the exact authority inventory', async () => {
  await withStore(async (store) => {
    assert.equal(store.state(), 'INITIALIZING');
    const preflight = new HyperliquidTestnetAuthorityPreflight(
      reader(snapshot()), store, config, () => nowMs,
    );
    await preflight.qualify(admission());
    assert.equal(store.state(), 'ACTIVE');
  });
});

test('accepts the Testnet default Standard account label', async () => {
  await withStore(async (store) => {
    const standardSnapshot = snapshot();
    const { portfolioMarginEnabled: _portfolioMarginEnabled, ...spotState } =
      standardSnapshot.spotState;
    const preflight = new HyperliquidTestnetAuthorityPreflight(
      reader({
        ...standardSnapshot,
        abstraction: 'default',
        spotState,
      }), store, config, () => nowMs,
    );
    await preflight.qualify(admission());
    assert.equal(store.state(), 'ACTIVE');
  });
});

test('samples trusted time after the authority inventory read', async () => {
  await withStore(async (store) => {
    let currentTime = nowMs - 20;
    const liveShapedReader: HyperliquidTestnetAuthorityReadPort = {
      environment: 'testnet',
      apiUrl: TESTNET_API_URL,
      async read() {
        currentTime = nowMs;
        return snapshot();
      },
    };
    const preflight = new HyperliquidTestnetAuthorityPreflight(
      liveShapedReader, store, config, () => currentTime,
    );
    await preflight.qualify(admission());
    assert.equal(store.state(), 'ACTIVE');
  });
});

test('a unified or portfolio-margin account never qualifies as Standard', async () => {
  for (const abstraction of ['unifiedAccount', 'portfolioMargin'] as const) {
    await withStore(async (store) => {
      await assert.rejects(
        new HyperliquidTestnetAuthorityPreflight(reader({ ...snapshot(), abstraction }), store, config, () => nowMs).qualify(admission()),
        /is not the configured account mode/,
      );
    });
  }
});

test('qualifies every approved HIP-3 clearinghouse and rejects legacy DEX abstraction', async () => {
  const hip3Config = {
    ...config,
    allowedPerpetualCoins: Object.freeze(['BTC', 'xyz:BTC']),
  };
  const hip3Snapshot = snapshot();
  const value: HyperliquidTestnetAuthoritySnapshot = {
    ...hip3Snapshot,
    perpetualDexStates: [...hip3Snapshot.perpetualDexStates, {
      dex: 'xyz',
      state: {
        assetPositions: [{
          type: 'oneWay',
          position: { coin: 'xyz:BTC', szi: '-0.01', leverage: { type: 'cross', value: 1 } },
        }],
      } as HyperliquidTestnetAuthoritySnapshot['perpetualState'],
    }],
    assetModes: [...hip3Snapshot.assetModes, {
      user: trading,
      coin: 'xyz:BTC',
      leverage: { type: 'cross', value: 1 },
      maxTradeSzs: ['0', '1'],
      availableToTrade: ['0', '1'],
      markPx: '100000',
    }],
  };
  await withStore(async (store) => {
    await new HyperliquidTestnetAuthorityPreflight(
      reader(value), store, hip3Config, () => nowMs,
    ).qualify(admission());
    assert.equal(store.state(), 'ACTIVE');
  });
  await withStore(async (store) => {
    await assert.rejects(
      new HyperliquidTestnetAuthorityPreflight(
        reader({ ...value, dexAbstraction: true }), store, hip3Config, () => nowMs,
      ).qualify(admission()),
      /legacy HIP-3 DEX abstraction/,
    );
  });
});

test('incident lock cannot auto-reopen after a later exact inventory', async () => {
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
    assert.equal(store.state(), 'INCIDENT_LOCKED');
    await assert.rejects(valid.qualify(admission()), /durable authority fence blocks/);
    assert.equal(store.state(), 'INCIDENT_LOCKED');
  });
});

test('rejects the same incident reviewer commitment twice', async () => {
  await withStore(async (store) => {
    store.incidentLock();
    const preflight = new HyperliquidTestnetAuthorityPreflight(
      reader(snapshot()), store, config, () => nowMs, clearance(),
    );
    await assert.rejects(
      preflight.clearIncident({
        ...clearanceInput,
        secondReviewerRoleCommitment: firstReviewerRoleCommitment,
      }),
      /reviewers must be distinct/,
    );
    assert.equal(store.state(), 'INCIDENT_LOCKED');
  });
});

test('rejects stale signerless clearance evidence', async () => {
  await withStore(async (store) => {
    store.incidentLock();
    const preflight = new HyperliquidTestnetAuthorityPreflight(
      reader(snapshot()), store, config, () => nowMs, clearance(nowMs - 5_001),
    );
    await assert.rejects(preflight.clearIncident(clearanceInput), /clearance observation is stale/);
    assert.equal(store.state(), 'INCIDENT_LOCKED');
  });
});

test('valid fresh evidence and dual review explicitly clear an incident lock', async () => {
  await withStore(async (store) => {
    store.incidentLock();
    const preflight = new HyperliquidTestnetAuthorityPreflight(
      reader(snapshot()), store, config, () => nowMs, clearance(),
    );
    await preflight.clearIncident(clearanceInput);
    assert.equal(store.state(), 'ACTIVE');
    assert.deepEqual(store.clearanceRecord(), { ...clearanceInput, clearedAtMs: nowMs });
  });
});

test('persists incident lock and clearance record across restart', async () => {
  await withStore(async (store, databasePath) => {
    assert.equal(store.incidentLock(), 'INCIDENT_LOCKED');
    store.close();
    const restarted = new HyperliquidAuthorityFenceStore(databasePath);
    assert.equal(restarted.state(), 'INCIDENT_LOCKED');
    assert.equal(restarted.activate(), 'INCIDENT_LOCKED');
    restarted.clearIncident({ ...clearanceInput, clearedAtMs: nowMs });
    restarted.close();
    const cleared = new HyperliquidAuthorityFenceStore(databasePath);
    try {
      assert.equal(cleared.state(), 'ACTIVE');
      assert.deepEqual(cleared.clearanceRecord(), { ...clearanceInput, clearedAtMs: nowMs });
    } finally {
      cleared.close();
    }
  });
});
