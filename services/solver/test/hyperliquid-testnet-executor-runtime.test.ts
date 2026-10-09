import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import {
  HYPERLIQUID_SERVER_SIGNER_SCOPE,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  loadHyperliquidTestnetExecutorRuntime,
  type HyperliquidServerSigner,
  type HyperliquidTestnetMarketReadPort,
  type HyperliquidTestnetExchangeTransport,
  type HyperliquidTestnetRuntimeCoordinatorInput,
  type HyperliquidTestnetAttemptHandoff,
  type HyperliquidTestnetExecutorResult,
  type HyperliquidTestnetTrustedAttemptProvider,
} from '../src/index.js';
import { trustedTimePort } from './hyperliquid-trusted-time-fixture.js';

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
      admission: { agent, trading },
      seriesManifestHash: '11'.repeat(32),
      executionClassManifestHash: '12'.repeat(32),
      market: {}, limits: {}, selectedAtMs: 1,
    }) as unknown as HyperliquidTestnetAttemptHandoff,
  };
}

function enabledEnvironment(databasePath: string): NodeJS.ProcessEnv {
  return {
    NARYX_HYPERLIQUID_TESTNET_EXECUTION_ENABLED: 'true',
    NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT: 'TESTNET',
    NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS: agentWallet,
    NARYX_HYPERLIQUID_TESTNET_SIGNER_LEASE_ID: 'solver-process-1',
    NARYX_HYPERLIQUID_TESTNET_MASTER_ACCOUNT: masterAccount,
    NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT: tradingAccount,
    NARYX_HYPERLIQUID_TESTNET_ACCOUNT_KIND: 'SUBACCOUNT',
    NARYX_HYPERLIQUID_TESTNET_JOURNAL_DB: databasePath,
    NARYX_HYPERLIQUID_TESTNET_KEEPER_ORIGIN: 'http://127.0.0.1:8791',
    NARYX_HYPERLIQUID_TESTNET_SPOT_UNIVERSE_NAME: '@7',
    NARYX_HYPERLIQUID_TESTNET_SPOT_TOKEN_NAME: 'BTC',
    NARYX_HYPERLIQUID_TESTNET_QUOTE_TOKEN_NAME: 'USDC',
    NARYX_HYPERLIQUID_TESTNET_PERPETUAL_NAME: 'BTC',
    NARYX_HYPERLIQUID_TESTNET_SPOT_UNIVERSE_CANONICAL: 'true',
    NARYX_HYPERLIQUID_TESTNET_SPOT_TOKEN_CANONICAL: 'true',
    NARYX_HYPERLIQUID_TESTNET_QUOTE_TOKEN_CANONICAL: 'true',
    NARYX_HYPERLIQUID_TESTNET_SPOT_TOKEN_ID: `0x${'11'.repeat(16)}`,
    NARYX_HYPERLIQUID_TESTNET_QUOTE_TOKEN_ID: `0x${'00'.repeat(16)}`,
    NARYX_HYPERLIQUID_TESTNET_SPOT_SIZE_DECIMALS: '5',
    NARYX_HYPERLIQUID_TESTNET_PERPETUAL_SIZE_DECIMALS: '5',
    NARYX_HYPERLIQUID_TESTNET_MAX_BOOK_AGE_MS: '5000',
    NARYX_HYPERLIQUID_TESTNET_MAX_BOOK_SNAPSHOT_SKEW_MS: '1000',
    NARYX_HYPERLIQUID_TESTNET_MAX_REFERENCE_DIVERGENCE_BPS: '100',
    NARYX_HYPERLIQUID_TESTNET_MINIMUM_SPOT_DEPTH: '0.001',
    NARYX_HYPERLIQUID_TESTNET_MINIMUM_PERPETUAL_DEPTH: '0.001',
    NARYX_HYPERLIQUID_TESTNET_AUTHORITY_INCIDENT_BUFFER_MS: '60000',
    NARYX_HYPERLIQUID_TESTNET_EXPECTED_PORTFOLIO_MARGIN_ENABLED: 'false',
    NARYX_HYPERLIQUID_TESTNET_EXPECTED_LEVERAGE_MODE: 'cross',
    NARYX_HYPERLIQUID_TESTNET_ALLOWED_SPOT_TOKEN_INDICES: '0,7',
    NARYX_HYPERLIQUID_TESTNET_ALLOWED_PERPETUAL_COINS: 'BTC',
    NARYX_HYPERLIQUID_TESTNET_MAX_AUTHORITY_SNAPSHOT_AGE_MS: '5000',
    NARYX_HYPERLIQUID_TESTNET_MAX_AUTHORITY_CLEARANCE_AGE_MS: '5000',
  };
}

function marketReader(): HyperliquidTestnetMarketReadPort {
  return {
    environment: 'testnet',
    apiUrl: 'https://api.hyperliquid-testnet.xyz',
    async read() {
      throw new Error('composition tests must not read market data');
    },
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
    marketReader: marketReader(),
    trustedTime: trustedTimePort(1_000_000),
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
    assert.ok(resolved && 'admission' in resolved);
    assert.equal((resolved.admission as unknown as { agent: string }).agent, agentWallet);
    assert.equal((resolved.admission as unknown as { trading: string }).trading, tradingAccount);
  } finally {
    loaded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reconciles a submitted recovery from stored source evidence and releases only a terminal lane', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-hyperliquid-runtime-recovery-'));
  const databasePath = join(directory, 'submission.sqlite');
  const nowMs = 1_000_000;
  const holder = 'attempt-runtime-0002';
  const recoveryAttemptId = 'recovery-attempt-0002';
  const key = 'idem-runtime-000002';
  const source: HyperliquidTestnetExecutorResult = {
    attemptId: holder,
    idempotencyKey: key,
    domain: 'hypercore:testnet',
    environment: 'TESTNET',
    status: 'RECONCILED',
    submissionStatus: 'ACKNOWLEDGED',
    packageStatus: 'RECOVERY_REQUIRED',
    reasons: ['ONE_LEG_FILLED'],
    actionCommitment: `0x${'44'.repeat(32)}`,
    requestCommitment: `0x${'45'.repeat(32)}`,
    rawEvidenceCommitments: [],
  };
  const loaded = await loadHyperliquidTestnetExecutorRuntime(enabledEnvironment(databasePath), {
    attempts: attempts(),
    signer: signer(),
    marketReader: marketReader(),
    trustedTime: trustedTimePort(nowMs),
    currentTimeMs: () => nowMs,
    transportFactory: transport,
    fetchImplementation: async (input, init) => {
      assert.equal(String(input),
        'http://127.0.0.1:8791/internal/keeper/hyperliquid-testnet/recovery/reconcile');
      assert.equal(init?.method, 'POST');
      return new Response(stringifyProtocolJson({
        status: 'RECONCILED',
        attempt: {
          version: 1,
          status: 'RECOVERED_FLAT',
          reasons: [],
          plan: {
            version: 1,
            guarantee: 'NARYX_UNSIGNED_HYPERCORE_RECOVERY_V1',
            domain: {
              domainId: 'hypercore:testnet',
              domainManifestVersion: 1,
              domainManifestHash: new Uint8Array(32).fill(1),
            },
            recoverySequence: 0,
          },
          acceptedEvidence: { evidenceVersion: 2n, observedAtMs: BigInt(nowMs) },
          lockEvidence: null,
        },
        accountObservation: { orders: [] },
        observedFills: [],
        rawResponseCommitments: [{
          operation: 'clearinghouseState',
          request: { operation: 'clearinghouseState', user: tradingAccount },
          requestedAtMs: nowMs - 10,
          receivedAtMs: nowMs,
          sha256: `0x${'46'.repeat(32)}`,
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  try {
    const lane = loaded.runtimeFactory?.().lane;
    assert.ok(lane);
    await lane.run(holder, key, async () => source);
    lane.recordReconcileContext(holder, stringifyProtocolJson({
      prepared: {
        attemptId: holder,
        checkpoint: {
          version: 1,
          observedAtMs: nowMs - 100,
          baseSpotBalanceAtoms: 0n,
          perpetualPositionAtoms: 0n,
        },
      },
      handoff: {},
      binding: {
        spotUniverseIndex: 0,
        spotTokenIndex: 1,
        perpetualAssetIndex: 2,
        quoteTokenIndex: 0,
      },
      window: {
        startTimeMs: nowMs - 100,
        endTimeMs: nowMs,
        nowMs,
        maxEvidenceAgeMs: 5_000,
        maxSnapshotSkewMs: 500,
        maxFillPages: 2,
      },
    }));
    const result = await loaded.reconcileRecovery({ attemptId: holder, recoveryAttemptId });
    assert.equal(result.status, 'RECONCILED');
    assert.equal(result.release?.resultStatus, 'RECOVERED_FLAT');
    assert.equal(lane.laneState().state, 'FREE');
  } finally {
    loaded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('automatically submits and reconciles deterministic recovery from signed source caps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-hyperliquid-runtime-auto-recovery-'));
  const databasePath = join(directory, 'submission.sqlite');
  const nowMs = 1_000_000;
  const holder = 'attempt-runtime-automatic-0003';
  const key = 'idem-runtime-automatic-0003';
  const source: HyperliquidTestnetExecutorResult = {
    attemptId: holder,
    idempotencyKey: key,
    domain: 'hypercore:testnet',
    environment: 'TESTNET',
    status: 'RECONCILED',
    submissionStatus: 'ACKNOWLEDGED',
    packageStatus: 'RECOVERY_REQUIRED',
    reasons: ['ONE_LEG_FILLED'],
    actionCommitment: `0x${'47'.repeat(32)}`,
    requestCommitment: `0x${'48'.repeat(32)}`,
    rawEvidenceCommitments: [],
  };
  const recoveryAsset = {
    assetId: 'hypercore:testnet:USDC',
    assetManifestHash: new Uint8Array(32).fill(9),
    decimals: 6,
  };
  const sourceAttempt = {
    version: 1,
    status: 'RECOVERY_REQUIRED',
    plan: {
      recoveryPolicy: {
        maxRecoveryCostCaps: [{ asset: recoveryAsset, maxAtoms: 25n }],
        maxAggregateRecoveryLoss: { asset: recoveryAsset, atoms: 1_000n },
      },
    },
  };
  const executionInputs: Record<string, unknown>[] = [];
  const reconciliationInputs: Record<string, unknown>[] = [];
  const loaded = await loadHyperliquidTestnetExecutorRuntime(enabledEnvironment(databasePath), {
    attempts: attempts(),
    signer: signer(),
    marketReader: marketReader(),
    trustedTime: trustedTimePort(nowMs),
    currentTimeMs: () => nowMs,
    transportFactory: transport,
    laneReconcileIntervalMs: 5,
    recoveryObservation: async () => ({
      reconciliation: { status: 'RECONCILED', attempt: sourceAttempt },
      result: source,
    }),
    recoveryExecution: {
      async execute(input) {
        executionInputs.push(input as unknown as Record<string, unknown>);
        return {
          plan: { recoverySequence: input.recoverySequence },
          submission: {
            status: 'ACKNOWLEDGED',
            handoff: {
              recoveryAttemptId: input.recoveryAttemptId,
              recoverySequence: input.recoverySequence,
            },
            errorCommitment: null,
          },
        };
      },
      async continue() {
        throw new Error('continuation must not be called');
      },
    },
    recoveryReconciliation: {
      async reconcile(input) {
        if (executionInputs.length === 0) throw new Error('recovery attempt is unknown');
        reconciliationInputs.push(input as unknown as Record<string, unknown>);
        return {
          status: 'RECONCILED',
          attempt: {
            version: 1,
            status: 'RECOVERED_FLAT',
            reasons: [],
            acceptedEvidence: { evidenceVersion: 2n, observedAtMs: BigInt(nowMs) },
            lockEvidence: null,
          },
          accountObservation: { orders: [] },
          observedFills: [],
          rawResponseCommitments: [],
        };
      },
    },
  });
  try {
    const lane = loaded.runtimeFactory?.().lane;
    assert.ok(lane);
    await lane.run(holder, key, async () => source);
    lane.recordReconcileContext(holder, stringifyProtocolJson({
      prepared: {
        attemptId: holder,
        checkpoint: {
          version: 1,
          observedAtMs: nowMs - 100,
          baseSpotBalanceAtoms: 0n,
          perpetualPositionAtoms: 0n,
        },
      },
      handoff: {},
      binding: {
        spotUniverseIndex: 0,
        spotTokenIndex: 1,
        perpetualAssetIndex: 2,
        quoteTokenIndex: 0,
      },
      window: {
        startTimeMs: nowMs - 100,
        endTimeMs: nowMs,
        nowMs,
        maxEvidenceAgeMs: 5_000,
        maxSnapshotSkewMs: 500,
        maxFillPages: 2,
      },
    }));
    for (let poll = 0; poll < 100 && lane.laneState().state !== 'FREE'; poll += 1) {
      await delay(5);
    }
    assert.equal(lane.laneState().state, 'FREE');
    assert.equal(executionInputs.length, 1);
    assert.equal(reconciliationInputs.length, 1);
    assert.match(String(executionInputs[0]!.recoveryAttemptId), /^recovery_[0-9a-f]{32}$/);
    assert.equal(executionInputs[0]!.recoverySequence, 0);
    assert.deepEqual(executionInputs[0]!.projectedRecoveryCosts, [{
      asset: recoveryAsset,
      atoms: 25n,
    }]);
    assert.deepEqual(executionInputs[0]!.projectedAggregateLoss, {
      asset: recoveryAsset,
      atoms: 1_000n,
    });
    assert.equal(
      reconciliationInputs[0]!.recoveryAttemptId,
      executionInputs[0]!.recoveryAttemptId,
    );
  } finally {
    loaded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('automatically continues partial recovery with the keeper remaining caps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-hyperliquid-runtime-continuation-'));
  const databasePath = join(directory, 'submission.sqlite');
  const nowMs = 1_000_000;
  const holder = 'attempt-runtime-continuation-0004';
  const key = 'idem-runtime-continuation-0004';
  const source: HyperliquidTestnetExecutorResult = {
    attemptId: holder,
    idempotencyKey: key,
    domain: 'hypercore:testnet',
    environment: 'TESTNET',
    status: 'RECONCILED',
    submissionStatus: 'ACKNOWLEDGED',
    packageStatus: 'RECOVERY_REQUIRED',
    reasons: ['ONE_LEG_FILLED'],
    actionCommitment: `0x${'51'.repeat(32)}`,
    requestCommitment: `0x${'52'.repeat(32)}`,
    rawEvidenceCommitments: [],
  };
  const recoveryAsset = {
    assetId: 'hypercore:testnet:USDC',
    assetManifestHash: new Uint8Array(32).fill(9),
    decimals: 6,
  };
  const sourceAttempt = {
    version: 1,
    status: 'RECOVERY_REQUIRED',
    plan: {
      recoveryPolicy: {
        maxRecoveryCostCaps: [{ asset: recoveryAsset, maxAtoms: 25n }],
        maxAggregateRecoveryLoss: { asset: recoveryAsset, atoms: 1_000n },
      },
    },
  };
  const initialInputs: Record<string, unknown>[] = [];
  const continuationInputs: Record<string, unknown>[] = [];
  const reconciliationInputs: Record<string, unknown>[] = [];
  const loaded = await loadHyperliquidTestnetExecutorRuntime(enabledEnvironment(databasePath), {
    attempts: attempts(),
    signer: signer(),
    marketReader: marketReader(),
    trustedTime: trustedTimePort(nowMs),
    currentTimeMs: () => nowMs,
    transportFactory: transport,
    laneReconcileIntervalMs: 5,
    recoveryObservation: async () => ({
      reconciliation: { status: 'RECONCILED', attempt: sourceAttempt },
      result: source,
    }),
    recoveryExecution: {
      async execute(input) {
        initialInputs.push(input as unknown as Record<string, unknown>);
        return {
          plan: { recoverySequence: 0 },
          submission: {
            status: 'ACKNOWLEDGED',
            handoff: { recoveryAttemptId: input.recoveryAttemptId, recoverySequence: 0 },
            errorCommitment: null,
          },
        };
      },
      async continue(input) {
        continuationInputs.push(input as unknown as Record<string, unknown>);
        return {
          plan: { recoverySequence: input.recoverySequence },
          submission: {
            status: 'ACKNOWLEDGED',
            handoff: {
              recoveryAttemptId: input.recoveryAttemptId,
              recoverySequence: input.recoverySequence,
            },
            errorCommitment: null,
          },
        };
      },
    },
    recoveryReconciliation: {
      async reconcile(input) {
        if (initialInputs.length === 0) throw new Error('recovery attempt is unknown');
        reconciliationInputs.push(input as unknown as Record<string, unknown>);
        const initialRecoveryAttemptId = String(initialInputs[0]!.recoveryAttemptId);
        if (input.recoveryAttemptId === initialRecoveryAttemptId) {
          return {
            status: 'RECONCILED',
            attempt: {
              version: 1,
              status: 'RECOVERY_REQUIRED',
              reasons: ['INCOMPLETE_RECOVERY'],
              acceptedEvidence: { evidenceVersion: 2n, observedAtMs: BigInt(nowMs) },
              lockEvidence: null,
              nextRecoveryObligation: {
                recoverySequence: 1,
                remainingRecoveryCostCaps: [{ asset: recoveryAsset, atoms: 7n }],
                remainingAggregateLoss: { asset: recoveryAsset, atoms: 800n },
              },
            },
            accountObservation: { orders: [] },
            observedFills: [],
            rawResponseCommitments: [],
          };
        }
        if (continuationInputs.length === 0
          || input.recoveryAttemptId !== continuationInputs[0]!.recoveryAttemptId) {
          throw new Error('continuation attempt is unknown');
        }
        return {
          status: 'RECONCILED',
          attempt: {
            version: 1,
            status: 'RECOVERED_FLAT',
            reasons: [],
            acceptedEvidence: { evidenceVersion: 3n, observedAtMs: BigInt(nowMs) },
            lockEvidence: null,
            nextRecoveryObligation: null,
          },
          accountObservation: { orders: [] },
          observedFills: [],
          rawResponseCommitments: [],
        };
      },
    },
  });
  try {
    const lane = loaded.runtimeFactory?.().lane;
    assert.ok(lane);
    await lane.run(holder, key, async () => source);
    lane.recordReconcileContext(holder, stringifyProtocolJson({
      prepared: {
        attemptId: holder,
        checkpoint: {
          version: 1,
          observedAtMs: nowMs - 100,
          baseSpotBalanceAtoms: 0n,
          perpetualPositionAtoms: 0n,
        },
      },
      handoff: {},
      binding: {
        spotUniverseIndex: 0,
        spotTokenIndex: 1,
        perpetualAssetIndex: 2,
        quoteTokenIndex: 0,
      },
      window: {
        startTimeMs: nowMs - 100,
        endTimeMs: nowMs,
        nowMs,
        maxEvidenceAgeMs: 5_000,
        maxSnapshotSkewMs: 500,
        maxFillPages: 2,
      },
    }));
    for (let poll = 0; poll < 100 && lane.laneState().state !== 'FREE'; poll += 1) {
      await delay(5);
    }
    assert.equal(lane.laneState().state, 'FREE');
    assert.equal(initialInputs.length, 1);
    assert.equal(continuationInputs.length, 1);
    assert.equal(continuationInputs[0]!.previousRecoveryAttemptId,
      initialInputs[0]!.recoveryAttemptId);
    assert.equal(continuationInputs[0]!.recoverySequence, 1);
    assert.deepEqual(continuationInputs[0]!.projectedRecoveryCosts, [{
      asset: recoveryAsset,
      atoms: 7n,
    }]);
    assert.deepEqual(continuationInputs[0]!.projectedAggregateLoss, {
      asset: recoveryAsset,
      atoms: 800n,
    });
    assert.equal(reconciliationInputs.length, 2);
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
    marketReader: marketReader(),
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

test('does not accept account identity from the API attempt handoff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-hyperliquid-runtime-binding-'));
  const databasePath = join(directory, 'submission.sqlite');
  const loaded = await loadHyperliquidTestnetExecutorRuntime(enabledEnvironment(databasePath), {
    attempts: attempts(agentWallet, `0x${'55'.repeat(20)}`),
    signer: signer(),
    marketReader: marketReader(),
    trustedTime: trustedTimePort(1_000_000),
    transportFactory: transport,
  });
  try {
    const runtime = loaded.runtimeFactory?.();
    assert.ok(runtime);
    const resolved = await runtime.attempts.resolve('attempt-runtime-0002');
    assert.ok(resolved && 'admission' in resolved);
    assert.equal((resolved.admission as unknown as { trading: string }).trading,
      `0x${'55'.repeat(20)}`);
    assert.equal('account' in (resolved as unknown as Record<string, unknown>), false);
  } finally {
    loaded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
