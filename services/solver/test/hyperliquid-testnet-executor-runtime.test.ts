import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HYPERLIQUID_SERVER_SIGNER_SCOPE,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  loadHyperliquidTestnetExecutorRuntime,
  type HyperliquidServerSigner,
  type HyperliquidTestnetExchangeTransport,
  type HyperliquidTestnetRuntimeCoordinatorInput,
  type HyperliquidTestnetTrustedAttemptProvider,
} from '../src/index.js';

const agentWallet = `0x${'11'.repeat(20)}` as const;
const masterAccount = `0x${'22'.repeat(20)}` as const;
const tradingAccount = `0x${'33'.repeat(20)}` as const;

function signer(address = agentWallet): HyperliquidServerSigner {
  return {
    signerScope: HYPERLIQUID_SERVER_SIGNER_SCOPE,
    async getAddress() {
      return address;
    },
    async signTypedData(_domain: unknown, _types: unknown, _value: unknown) {
      throw new Error('composition tests must not sign');
    },
  } as HyperliquidServerSigner;
}

function transport(): HyperliquidTestnetExchangeTransport {
  return {
    isTestnet: true,
    apiUrl: HYPERLIQUID_TESTNET_EXCHANGE_URL,
    async request() {
      throw new Error('composition tests must not reach the exchange');
    },
  } as HyperliquidTestnetExchangeTransport;
}

function attempts(
  agent = agentWallet,
  trading = tradingAccount,
): HyperliquidTestnetTrustedAttemptProvider {
  return {
    resolve: async (attemptId) => ({
      attemptId,
      agentWallet: agent,
      account: { masterAccount, tradingAccount: trading, accountKind: 'SUBACCOUNT' },
    }) as unknown as HyperliquidTestnetRuntimeCoordinatorInput,
  };
}

function enabledEnvironment(databasePath: string): NodeJS.ProcessEnv {
  return {
    NARYX_HYPERLIQUID_TESTNET_EXECUTION_ENABLED: 'true',
    NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT: 'TESTNET',
    NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS: agentWallet,
    NARYX_HYPERLIQUID_TESTNET_MASTER_ACCOUNT: masterAccount,
    NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT: tradingAccount,
    NARYX_HYPERLIQUID_TESTNET_ACCOUNT_KIND: 'SUBACCOUNT',
    NARYX_HYPERLIQUID_TESTNET_JOURNAL_DB: databasePath,
    NARYX_HYPERLIQUID_TESTNET_KEEPER_ORIGIN: 'http://127.0.0.1:8791',
  };
}

test('is disabled by default without constructing execution dependencies', async () => {
  let transportCalls = 0;
  const loaded = await loadHyperliquidTestnetExecutorRuntime({}, {
    transportFactory: () => {
      transportCalls += 1;
      return transport();
    },
  });

  assert.deepEqual(loaded.status, {
    enabled: false,
    environment: null,
    exchangeUrl: null,
    agentWallet: null,
    account: null,
  });
  assert.equal(loaded.runtimeFactory, undefined);
  assert.equal(transportCalls, 0);
  loaded.close();
});

test('composes the pinned transport, durable journal, evidence client, and bound provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-hyperliquid-runtime-'));
  const databasePath = join(directory, 'submission.sqlite');
  let transportCalls = 0;
  const loaded = await loadHyperliquidTestnetExecutorRuntime(enabledEnvironment(databasePath), {
    attempts: attempts(),
    signer: signer(),
    transportFactory: () => {
      transportCalls += 1;
      return transport();
    },
    fetchImplementation: async () => {
      throw new Error('composition tests must not reach the keeper');
    },
  });
  try {
    assert.equal(loaded.status.enabled, true);
    assert.equal(loaded.status.environment, 'TESTNET');
    assert.equal(loaded.status.exchangeUrl, HYPERLIQUID_TESTNET_EXCHANGE_URL);
    assert.deepEqual(loaded.status.account, {
      masterAccount, tradingAccount, accountKind: 'SUBACCOUNT',
    });
    assert.equal(transportCalls, 1);
    assert.equal(existsSync(databasePath), true);
    const runtime = loaded.runtimeFactory?.();
    assert.ok(runtime);
    const resolved = await runtime.attempts.resolve('attempt-runtime-0001');
    assert.equal(resolved?.agentWallet, agentWallet);
    assert.equal(resolved?.account.tradingAccount, tradingAccount);
  } finally {
    loaded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects environment and signer mismatches before transport creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-hyperliquid-runtime-reject-'));
  const databasePath = join(directory, 'submission.sqlite');
  let transportCalls = 0;
  const dependencies = {
    attempts: attempts(),
    signer: signer(`0x${'44'.repeat(20)}`),
    transportFactory: () => {
      transportCalls += 1;
      return transport();
    },
  };
  try {
    await assert.rejects(loadHyperliquidTestnetExecutorRuntime({
      ...enabledEnvironment(databasePath),
      NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT: 'MAINNET',
    }, dependencies), /must be TESTNET/);
    await assert.rejects(loadHyperliquidTestnetExecutorRuntime(
      enabledEnvironment(databasePath), dependencies,
    ), /does not match the configured Testnet agent/);
    assert.equal(transportCalls, 0);
    assert.equal(existsSync(databasePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a trusted attempt with a different configured account identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-hyperliquid-runtime-binding-'));
  const databasePath = join(directory, 'submission.sqlite');
  const loaded = await loadHyperliquidTestnetExecutorRuntime(enabledEnvironment(databasePath), {
    attempts: attempts(agentWallet, `0x${'55'.repeat(20)}`),
    signer: signer(),
    transportFactory: transport,
  });
  try {
    const runtime = loaded.runtimeFactory?.();
    assert.ok(runtime);
    await assert.rejects(async () => runtime.attempts.resolve('attempt-runtime-0002'),
      /does not match configured Testnet agent and account/);
  } finally {
    loaded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
