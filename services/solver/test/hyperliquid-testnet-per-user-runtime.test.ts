import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hyperliquidTestnetAccountMode,
  requireHyperliquidTestnetAccountBinding,
} from '../src/hyperliquid-testnet-account-binding.js';
import {
  loadHyperliquidTestnetPerUserRuntime,
  parseHyperliquidTestnetUserAccounts,
  type HyperliquidTestnetUserAccount,
} from '../src/hyperliquid-testnet-per-user-runtime.js';
import type { HyperliquidTestnetAttemptHandoff } from '../src/hyperliquid-testnet-executor-http.js';
import type { LoadedHyperliquidTestnetExecutorRuntime } from '../src/hyperliquid-testnet-executor-runtime.js';

const ownerA = `0x${'11'.repeat(20)}` as const;
const ownerB = `0x${'22'.repeat(20)}` as const;
const attemptA = `strategy-hl-${'aa'.repeat(24)}`;
const attemptB = `strategy-hl-${'bb'.repeat(24)}`;

function account(owner: `0x${string}`, suffix: string): HyperliquidTestnetUserAccount {
  return {
    owner, agentAddress: `0x${suffix.repeat(40)}`, agentKeyPath: `/keys/agent-${suffix}.json`,
    journalPath: `/data/user-${suffix}.db`, signerLeaseId: `user-${suffix}`,
  };
}

function handoff(attemptId: string, owner: string): HyperliquidTestnetAttemptHandoff {
  return {
    attemptId, accountBinding: { owner, settlementAccount: owner },
    authority: { baseAssetDecimals: 5, requiredUntilMs: 200n },
    strategy: { graphHash: new Uint8Array(32).fill(1), plan: {
      version: 1, guarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY',
    } as never },
    market: {} as never, limits: { maxEvidenceAgeMs: 1, maxSnapshotSkewMs: 1, maxFillPages: 1 },
    selectedAtMs: 100, seriesManifestHash: '12'.repeat(32), executionClassManifestHash: '13'.repeat(32),
  };
}

test('per-user mode is the default and duplicate authority or journal identities fail closed', () => {
  assert.equal(hyperliquidTestnetAccountMode({}), 'PER_USER');
  assert.throws(() => hyperliquidTestnetAccountMode({ NARYX_HYPERLIQUID_TESTNET_ACCOUNT_MODE: 'shared' }));
  const accounts = [account(ownerA, '3'), account(ownerB, '4')];
  const parse = (rows: unknown, environment = 'TESTNET') => parseHyperliquidTestnetUserAccounts({
    version: 1, environment, accounts: rows,
  });
  assert.equal(parse(accounts).length, 2);
  assert.throws(() => parse(accounts, 'MAINNET'), /configuration is invalid/);
  for (const field of ['owner', 'agentAddress', 'agentKeyPath', 'journalPath', 'signerLeaseId'] as const) {
    assert.throws(() => parse([accounts[0], { ...accounts[1], [field]: accounts[0]![field] }]), /unique/);
  }
  assert.throws(() => parse([{ ...accounts[0], owner: `0x${'00'.repeat(20)}` }]), /fields are invalid/);
  assert.throws(() => parse([{ ...accounts[0], agentKeyPath: '/keys/../keys/agent.json' }]), /fields are invalid/);
  assert.throws(() => parse([{ ...accounts[0], privateKey: 'not-accepted' }]), /fields are invalid/);
});

test('signed account binding rejects shared-account substitution and absent native ownership', () => {
  const expected = { masterAccount: ownerA, tradingAccount: ownerA, accountKind: 'MASTER' as const };
  requireHyperliquidTestnetAccountBinding(handoff(attemptA, ownerA), expected);
  assert.throws(() => requireHyperliquidTestnetAccountBinding(handoff(attemptA, ownerB), expected), /do not match/);
  const { accountBinding: _binding, ...unbound } = handoff(attemptA, ownerA);
  assert.throws(() => requireHyperliquidTestnetAccountBinding(unbound, expected), /requires the signed owner/);
  assert.throws(() => requireHyperliquidTestnetAccountBinding({
    ...handoff(attemptA, ownerA), accountBinding: { owner: ownerA, settlementAccount: ownerB },
  }, expected), /do not match/);
});

test('isolates user lanes and rechecks ownership before preflight with no fallback', async () => {
  const configurations: NodeJS.ProcessEnv[] = [];
  const preflights: string[] = [];
  const closed: string[] = [];
  let changeBetweenReads = false;
  let changedReads = 0;
  const unconfiguredAttempt = `strategy-hl-${'dd'.repeat(24)}`;
  const pool = await loadHyperliquidTestnetPerUserRuntime({
    environment: { NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT: `0x${'99'.repeat(20)}` },
    accounts: [account(ownerA, '3'), account(ownerB, '4')],
    attempts: { resolve: async (id) => id === attemptA
      ? handoff(id, changeBetweenReads && changedReads++ > 0 ? ownerB : ownerA)
      : id === attemptB ? handoff(id, ownerB)
        : id === unconfiguredAttempt ? handoff(id, `0x${'55'.repeat(20)}`) : undefined },
    loadSigner: () => ({}) as never,
    loadRuntime: async (environment, dependencies) => {
      configurations.push(environment);
      const owner = environment.NARYX_HYPERLIQUID_TESTNET_MASTER_ACCOUNT!;
      return {
        status: {} as never,
        clearAuthorityIncident: async () => { throw new Error('unused'); },
        runtimeFactory: () => ({
          attempts: dependencies.attempts!,
          preflight: async () => { preflights.push(owner); throw new Error(`preflight-${owner}`); },
          prepareAttempt: async () => { throw new Error('unexpected submission'); },
          coordinator: { execute: async () => { throw new Error('unexpected submission'); } } as never,
        }),
        close: () => { closed.push(owner); },
        releaseLane: async () => { throw new Error(`release-${owner}`); },
        recover: async () => { throw new Error(`recover-${owner}`); },
        reconcileRecovery: async () => { throw new Error(`reconcile-${owner}`); },
      } as LoadedHyperliquidTestnetExecutorRuntime;
    },
  });
  try {
    assert.deepEqual(configurations.map((env) => env.NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT), [ownerA, ownerB]);
    assert.equal(new Set(configurations.map((env) => env.NARYX_HYPERLIQUID_TESTNET_JOURNAL_DB)).size, 2);
    for (const [attemptId, owner] of [[attemptA, ownerA], [attemptB, ownerB]]) {
      const request = { attemptId: attemptId!, idempotencyKey: 'user-execution-0001' };
      assert.equal((await pool.executor.status({ ...request, resolve: false })).state, 'UNKNOWN');
      await assert.rejects(pool.executor.execute(request), new RegExp(`preflight-${owner}`));
    }
    assert.deepEqual(preflights, [ownerA, ownerB]);
    const hotAccount = account(`0x${'66'.repeat(20)}`, '7');
    await Promise.all([pool.registerAccount(hotAccount), pool.registerAccount(hotAccount)]);
    assert.equal(pool.hasAccount(hotAccount.owner), true);
    assert.equal(configurations.length, 3);
    await assert.rejects(pool.registerAccount({ ...hotAccount, agentAddress: account(ownerA, '8').agentAddress }), /identity cannot change/);
    await assert.rejects(pool.operator.releaseLane({ attemptId: attemptB, disposition: 'FINAL', reason: 'TEST' }),
      new RegExp(`release-${ownerB}`));
    const unknown = `strategy-hl-${'cc'.repeat(24)}`;
    await assert.rejects(pool.executor.execute({ attemptId: unknown, idempotencyKey: 'user-execution-0002' }), /not found/);
    await assert.rejects(pool.executor.execute({ attemptId: unconfiguredAttempt, idempotencyKey: 'user-execution-0003' }),
      /shared-account fallback is disabled/);
    changeBetweenReads = true;
    await assert.rejects(pool.executor.execute({ attemptId: attemptA, idempotencyKey: 'user-execution-0002' }),
      /do not match/);
    assert.deepEqual(preflights, [ownerA, ownerB]);
  } finally { pool.close(); }
  assert.deepEqual(closed, [ownerA, ownerB, `0x${'66'.repeat(20)}`]);
});

test('closes previously loaded accounts if a later account fails to initialize', async () => {
  let closed = 0;
  let loads = 0;
  await assert.rejects(loadHyperliquidTestnetPerUserRuntime({
    environment: {}, accounts: [account(ownerA, '3'), account(ownerB, '4')],
    attempts: { resolve: async () => undefined }, loadSigner: () => ({}) as never,
    loadRuntime: async () => {
      if (++loads === 2) throw new Error('approval unavailable');
      return { status: {} as never,
        clearAuthorityIncident: async () => { throw new Error('unused'); },
        releaseLane: async () => { throw new Error('unused'); },
        recover: async () => { throw new Error('unused'); },
        reconcileRecovery: async () => { throw new Error('unused'); },
        runtimeFactory: () => ({
        attempts: { resolve: async () => undefined }, preflight: async () => {},
        prepareAttempt: async () => { throw new Error('unused'); }, coordinator: { execute() {} } as never,
      }), close: () => { closed++; } } as LoadedHyperliquidTestnetExecutorRuntime;
    },
  }), /approval unavailable/);
  assert.equal(closed, 1);
});

test('expired attempt status resolves only its owner lane without preparing a new trade', async () => {
  let preparationCalls = 0;
  const pool = await loadHyperliquidTestnetPerUserRuntime({
    environment: {}, accounts: [account(ownerA, '3'), account(ownerB, '4')],
    attempts: {
      resolve: async () => { preparationCalls++; throw new Error('EXPIRED'); },
      resolveAccountBinding: async id => id === attemptA
        ? { owner: ownerA, settlementAccount: ownerA }
        : id === attemptB ? { owner: ownerB, settlementAccount: ownerA } : undefined,
    },
    loadSigner: () => ({}) as never,
    loadRuntime: async (_environment, dependencies) => ({
      status: {} as never,
      clearAuthorityIncident: async () => { throw new Error('unused'); },
      releaseLane: async () => { throw new Error('unused'); },
      recover: async () => { throw new Error('unused'); },
      reconcileRecovery: async () => { throw new Error('unused'); },
      runtimeFactory: () => ({
        attempts: dependencies.attempts!, preflight: async () => {},
        prepareAttempt: async () => { throw new Error('unused'); }, coordinator: { execute() {} } as never,
      }),
      close() {},
    }) as LoadedHyperliquidTestnetExecutorRuntime,
  });
  const request = { attemptId: attemptA, idempotencyKey: 'expired-attempt-status' };
  try {
    const status = await pool.executor.status({ ...request, resolve: true });
    assert.equal(status.state, 'COMPLETED');
    assert.equal(status.result?.status, 'NOT_SUBMITTED');
    await assert.rejects(pool.executor.status({ ...request, attemptId: attemptB, resolve: true }), /fallback is disabled/);
    assert.equal(preparationCalls, 0);
    await assert.rejects(pool.executor.execute(request), /EXPIRED/);
    assert.equal(preparationCalls, 1);
  } finally { pool.close(); }
});

test('rejects mainnet configuration before loading any signer', async () => {
  await assert.rejects(loadHyperliquidTestnetPerUserRuntime({
    environment: { NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT: 'MAINNET' },
    accounts: [account(ownerA, '3')], attempts: { resolve: async () => undefined },
    loadSigner: () => { throw new Error('signer must not load'); },
  }), /environment must be TESTNET/);
});
