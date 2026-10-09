import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
  type HyperliquidExecutionPlan,
  type HyperliquidStrategyExecutionPlan,
} from '@naryx/adapter-hyperliquid';
import { parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import {
  SOLVER_TESTNET_EXECUTE_PATH,
  HyperliquidTestnetRuntimeCoordinator,
  createHyperliquidTestnetExecutorServer,
  type HyperliquidPackageSubmissionResult,
  type HyperliquidStrategyRuntimeResult,
  type HyperliquidTestnetExecutorRequest,
  type HyperliquidTestnetRuntimeCoordinatorInput,
  type HyperliquidTestnetAttemptHandoff,
} from '../src/index.js';

const ATTEMPT_ID = 'attempt-0123456789AB';
const IDEMPOTENCY_KEY = 'idem-0123456789ABCD';
const MASTER = `0x${'11'.repeat(20)}` as const;
const TRADING = `0x${'22'.repeat(20)}` as const;
const AGENT = `0x${'33'.repeat(20)}` as const;
const ACTION = `0x${'aa'.repeat(32)}` as const;
const REQUEST = `0x${'bb'.repeat(32)}` as const;
const ERROR = `0x${'cc'.repeat(32)}` as const;
const EVIDENCE = `0x${'dd'.repeat(32)}` as const;
const SPOT_CLOID = `0x${'51'.repeat(16)}` as const;
const PERP_CLOID = `0x${'52'.repeat(16)}` as const;
const BASE_ASSET = Object.freeze({ assetId: 'btc', assetManifestHash: hash(7), decimals: 3 });
const QUOTE_ASSET = Object.freeze({ assetId: 'usdc', assetManifestHash: hash(8), decimals: 2 });

function hash(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function wire(asset: number, clientOrderId: `0x${string}`) {
  return {
    a: asset,
    b: true,
    p: '60000',
    s: '0.001',
    r: false,
    t: { limit: { tif: 'Ioc' as const } },
    c: clientOrderId,
  };
}

function plan(): HyperliquidExecutionPlan {
  const spot = wire(10_007, SPOT_CLOID);
  const perpetual = wire(3, PERP_CLOID);
  return {
    version: 1,
    guarantee: HYPERCORE_EXECUTION_GUARANTEE,
    domain: {
      domainId: 'hypercore:testnet',
      domainManifestVersion: 1,
      domainManifestHash: hash(1),
    },
    commitments: {
      seriesManifestHash: hash(2),
      executionClassManifestHash: hash(3),
      orderHash: hash(4),
      quoteHash: hash(5),
      routeHash: hash(6),
    },
    requestExpiryMs: 1_005_000n,
    unsignedRequestFields: {
      action: { type: 'order', grouping: 'na', orders: [spot, perpetual] },
      expiresAfter: 1_005_000,
    },
    legs: [
      { legId: 'spot', role: 'SPOT', legIndex: 0, clientOrderId: SPOT_CLOID, order: spot,
        baseAsset: BASE_ASSET, quoteAsset: QUOTE_ASSET, signedBaseDeltaAtoms: 1_000n },
      { legId: 'perp', role: 'PERPETUAL', legIndex: 1, clientOrderId: PERP_CLOID, order: perpetual,
        baseAsset: BASE_ASSET, quoteAsset: QUOTE_ASSET, signedBaseDeltaAtoms: -999n },
    ],
    terminalResidualPolicy: {
      kind: 'EXACT_NET', netSpotDeltaAtoms: 999n,
      maxTerminalResidualBaseAtoms: 0n, maxTerminalResidualQuoteAtoms: 0n,
    },
  } as unknown as HyperliquidExecutionPlan;
}

function attempt(attemptId = ATTEMPT_ID): HyperliquidTestnetRuntimeCoordinatorInput {
  return {
    expectedVersion: 0n,
    attemptId,
    agentWallet: AGENT,
    signerLeaseId: 'solver-process-1',
    plan: plan(),
    account: { masterAccount: MASTER, tradingAccount: TRADING, accountKind: 'SUBACCOUNT' },
    nonce: 1_000_001n,
    nowMs: 1_000_000n,
    vaultAddress: TRADING,
    binding: {
      spotUniverseIndex: 7,
      spotTokenIndex: 1,
      perpetualAssetIndex: 3,
      quoteTokenIndex: 0,
    },
    checkpointWindow: {
      startTimeMs: 900_000,
      endTimeMs: 950_000,
      nowMs: 1_000_000,
      maxEvidenceAgeMs: 200_000,
      maxSnapshotSkewMs: 5_000,
    },
    reconciliationWindow: {
      startTimeMs: 950_000,
      endTimeMs: 1_000_000,
      nowMs: 1_000_000,
      maxEvidenceAgeMs: 200_000,
      maxSnapshotSkewMs: 5_000,
      maxFillPages: 4,
    },
  };
}

function submission(status: 'SUBMISSION_ACKNOWLEDGED' | 'SUBMISSION_AMBIGUOUS'):
HyperliquidPackageSubmissionResult {
  const handoff = {
    collector: 'HYPERLIQUID_TESTNET_AUTHORITATIVE_EVIDENCE' as const,
    attemptId: ATTEMPT_ID,
    account: { masterAccount: MASTER, tradingAccount: TRADING, accountKind: 'SUBACCOUNT' as const },
    actionHash: ACTION,
    actionCommitmentScheme: 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1' as const,
    requestCommitment: REQUEST,
    durableRevision: 'durable-7',
    spotClientOrderId: SPOT_CLOID,
    perpetualClientOrderId: PERP_CLOID,
  };
  if (status === 'SUBMISSION_ACKNOWLEDGED') {
    return {
      attemptId: ATTEMPT_ID,
      actionCommitmentScheme: handoff.actionCommitmentScheme,
      actionCommitment: ACTION,
      requestCommitment: REQUEST,
      status,
      evidenceStatus: 'SUBMISSION_EVIDENCE_ONLY',
      settlementStatus: 'RECONCILIATION_REQUIRED',
      responseCommitment: `0x${'ee'.repeat(32)}`,
      reconciliation: handoff,
    };
  }
  return {
    attemptId: ATTEMPT_ID,
    actionCommitmentScheme: handoff.actionCommitmentScheme,
    actionCommitment: ACTION,
    requestCommitment: REQUEST,
    status,
    evidenceStatus: 'RESPONSE_UNKNOWN',
    settlementStatus: 'RECONCILIATION_REQUIRED',
    errorCommitment: ERROR,
    reconciliation: handoff,
  };
}

async function start(
  injected: HyperliquidTestnetRuntimeCoordinator<unknown, unknown>,
  resolved: HyperliquidTestnetRuntimeCoordinatorInput | undefined = attempt(),
) {
  const handoff = resolved === undefined ? undefined : {
    attemptId: resolved.attemptId,
    admission: {},
    seriesManifestHash: '11'.repeat(32),
    executionClassManifestHash: '12'.repeat(32),
    market: {},
    limits: { maxEvidenceAgeMs: 1, maxSnapshotSkewMs: 1, maxFillPages: 1 },
    selectedAtMs: 1,
  } as unknown as HyperliquidTestnetAttemptHandoff;
  let calls = 0;
  const coordinator = {
    execute: async (input: HyperliquidTestnetRuntimeCoordinatorInput) => {
      calls += 1;
      assert.equal(input, resolved);
      return injected.execute(input);
    },
  } as unknown as HyperliquidTestnetRuntimeCoordinator<unknown, unknown>;
  const server = createHyperliquidTestnetExecutorServer(() => ({
    attempts: { resolve: () => handoff },
    preflight: async () => {},
    prepareAttempt: async () => resolved as HyperliquidTestnetRuntimeCoordinatorInput,
    coordinator,
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}${SOLVER_TESTNET_EXECUTE_PATH}`,
    calls: () => calls,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}

async function execute(url: string, body: HyperliquidTestnetExecutorRequest = {
  attemptId: ATTEMPT_ID,
  idempotencyKey: IDEMPOTENCY_KEY,
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stringifyProtocolJson(body, 'test.execute.request'),
  });
  return {
    status: response.status,
    body: parseProtocolJson(await response.text(), 'test.execute.response') as Record<string, unknown>,
  };
}

test('executor returns sanitized authoritative reconciled evidence', async () => {
  const expectedSubmission = submission('SUBMISSION_ACKNOWLEDGED');
  const coordinator = new HyperliquidTestnetRuntimeCoordinator(
    {
      prepare: async () => ({ status: 'PREPARED' as const, state: { checkpoint: 'prepared' } }),
      reconcile: async () => ({
      status: 'RECONCILED',
      attempt: { status: 'COMPLETED_EXACT', reasons: [] },
      rawResponseCommitments: [{ sha256: EVIDENCE }],
      observedFills: [{ private: 'omitted' }],
      accountObservation: { private: 'omitted' },
      }),
    },
    { submitPackage: async () => expectedSubmission },
  );
  const server = await start(coordinator);
  try {
    const response = await execute(server.url);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      attemptId: ATTEMPT_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      domain: 'hypercore:testnet',
      environment: 'TESTNET',
      status: 'RECONCILED',
      submissionStatus: 'ACKNOWLEDGED',
      packageStatus: 'COMPLETED_EXACT',
      reasons: [],
      actionCommitment: ACTION,
      requestCommitment: REQUEST,
      rawEvidenceCommitments: [EVIDENCE],
    });
    assert.equal(server.calls(), 1);
  } finally {
    await server.close();
  }
});

test('executor exposes generalized strategy stages without using the cash coordinator', async () => {
  const strategyPlan = {
    version: 1,
    guarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY',
    domain: { domainId: 'hypercore:testnet', domainManifestVersion: 1, domainManifestHash: hash(1) },
    batches: [{ stage: 0 }],
  } as unknown as HyperliquidStrategyExecutionPlan;
  const handoff = {
    attemptId: ATTEMPT_ID,
    admission: {},
    seriesManifestHash: '11'.repeat(32),
    executionClassManifestHash: '12'.repeat(32),
    market: {},
    limits: { maxEvidenceAgeMs: 1, maxSnapshotSkewMs: 1, maxFillPages: 1 },
    selectedAtMs: 1,
    strategy: {
      sourceAttemptId: `hyperliquid-testnet-${'ab'.repeat(24)}`,
      graphHash: hash(9),
      plan: strategyPlan,
    },
  } as unknown as HyperliquidTestnetAttemptHandoff;
  const runtimeResult: HyperliquidStrategyRuntimeResult = {
    attemptId: ATTEMPT_ID,
    status: 'COMPLETED',
    completedStages: [0],
    stages: [{
      batchStage: 0,
      submission: {
        attemptId: ATTEMPT_ID,
        batchStage: 0,
        actionCommitment: ACTION,
        requestCommitment: REQUEST,
        status: 'SUBMISSION_ACKNOWLEDGED',
        evidenceStatus: 'SUBMISSION_EVIDENCE_ONLY',
        settlementStatus: 'RECONCILIATION_REQUIRED',
        responseCommitment: `0x${'ee'.repeat(32)}`,
        reconciliation: {
          collector: 'HYPERLIQUID_TESTNET_AUTHORITATIVE_EVIDENCE',
          attemptId: ATTEMPT_ID,
          batchStage: 0,
          account: { masterAccount: MASTER, tradingAccount: TRADING, accountKind: 'SUBACCOUNT' },
          actionHash: ACTION,
          actionCommitmentScheme: 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1',
          requestCommitment: REQUEST,
          durableRevision: 'strategy-revision-1',
          legIds: ['leg-0'],
          clientOrderIds: [SPOT_CLOID],
        },
      },
      evidence: {
        status: 'COMPLETE',
        outcome: 'COMPLETED',
        reasons: [],
        observedAtMs: 1_000_100,
        legs: [{
          legId: 'leg-0',
          clientOrderId: SPOT_CLOID,
          plannedSignedBaseAtoms: 100n,
          filledSignedBaseAtoms: 100n,
          terminalStatus: 'FILLED',
          openOrderStatus: 'NONE',
          orderId: 7,
          fillCount: 1,
          grossQuoteAtoms: 600n,
          feeAssetId: 'btc',
          feeAssetDecimals: 3,
          feeAtoms: 1n,
          venueFeeQuoteAtoms: 60n,
          observedAtMs: 1_000_050,
        }],
        rawResponseCommitments: [{ sha256: EVIDENCE }],
      },
    }],
  };
  let cashCalls = 0;
  let strategyCalls = 0;
  const server = createHyperliquidTestnetExecutorServer(() => ({
    attempts: { resolve: () => handoff },
    preflight: async () => {},
    prepareAttempt: async () => { throw new Error('cash preparation must not run'); },
    coordinator: {
      execute: async () => {
        cashCalls += 1;
        throw new Error('cash coordinator must not run');
      },
    } as unknown as HyperliquidTestnetRuntimeCoordinator<unknown, unknown>,
    executeStrategy: async () => {
      strategyCalls += 1;
      return runtimeResult;
    },
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await execute(
      `http://127.0.0.1:${address.port}${SOLVER_TESTNET_EXECUTE_PATH}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'STRATEGY_EXECUTION');
    assert.equal(response.body.packageStatus, 'COMPLETED');
    assert.deepEqual(response.body.completedStages, [0]);
    const stages = response.body.stages as Array<Record<string, unknown>>;
    assert.equal(stages[0]?.submissionStatus, 'ACKNOWLEDGED');
    assert.equal(((stages[0]?.evidence as Record<string, unknown>).legs as Array<Record<string, unknown>>)[0]
      ?.filledSignedBaseAtoms, '100');
    assert.equal(cashCalls, 0);
    assert.equal(strategyCalls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});

test('executor exposes commitment-bound normalized fills and fees', async () => {
  const expectedSubmission = submission('SUBMISSION_ACKNOWLEDGED');
  const sourcePlan = plan();
  const acceptedEvidence = {
    evidenceVersion: 1_000_100n,
    observedAtMs: 1_000_100n,
    spot: { clientOrderId: SPOT_CLOID, filledSignedBaseAtoms: 1_000n },
    perpetual: { clientOrderId: PERP_CLOID, filledSignedBaseAtoms: -999n },
    netSpotDeltaAtoms: 999n,
    perpetualPositionDeltaAtoms: -999n,
    fees: [
      { assetId: 'btc', assetDecimals: 3, amountAtoms: 1n, evidenceStatus: 'CONFIRMED' },
      { assetId: 'usdc', assetDecimals: 2, amountAtoms: 3n, evidenceStatus: 'CONFIRMED' },
    ],
  };
  const coordinator = new HyperliquidTestnetRuntimeCoordinator(
    {
      prepare: async () => ({ status: 'PREPARED' as const, state: { checkpoint: 'prepared' } }),
      reconcile: async () => ({
        status: 'RECONCILED',
        attempt: {
          status: 'COMPLETED_EXACT', reasons: [], plan: sourcePlan,
          acceptedEvidence,
        },
        rawResponseCommitments: [{ sha256: EVIDENCE }],
        observedFills: [
          { clientOrderId: SPOT_CLOID, signedBaseAtoms: 1_000n,
            price: { coefficient: 60n, scale: 0 }, feeToken: 'BTC', feeAtoms: 1n,
            observedAtMs: 1_000_050 },
          { clientOrderId: PERP_CLOID, signedBaseAtoms: -999n,
            price: { coefficient: 60n, scale: 0 }, feeToken: 'USDC', feeAtoms: 3n,
            observedAtMs: 1_000_051 },
        ],
        accountObservation: {},
      }),
    },
    { submitPackage: async () => expectedSubmission },
  );
  const server = await start(coordinator);
  try {
    const response = await execute(server.url);
    assert.equal(response.status, 200);
    const evidence = response.body.executionEvidence as {
      evidenceVersion: string;
      observedAtMs: string;
      terminalResidualBaseAtoms: string;
      terminalResidualQuoteAtoms: string;
      legs: Array<Record<string, unknown>>;
    };
    assert.equal(evidence.evidenceVersion, '1000100');
    assert.equal(evidence.observedAtMs, '1000100');
    assert.equal(evidence.terminalResidualBaseAtoms, '0');
    assert.equal(evidence.terminalResidualQuoteAtoms, '0');
    assert.deepEqual(evidence.legs.map((leg) => ({
      legId: leg.legId,
      role: leg.role,
      requested: leg.requestedSignedBaseAtoms,
      filled: leg.filledSignedBaseAtoms,
      gross: leg.grossQuoteAtoms,
      feeAsset: leg.feeAssetId,
      fee: leg.feeAtoms,
      quoteFee: leg.venueFeeQuoteAtoms,
    })), [
      { legId: 'spot', role: 'SPOT', requested: '1000', filled: '1000', gross: '6000',
        feeAsset: 'btc', fee: '1', quoteFee: '6' },
      { legId: 'perp', role: 'PERPETUAL', requested: '-999', filled: '-999', gross: '5994',
        feeAsset: 'usdc', fee: '3', quoteFee: '3' },
    ]);
    assert.ok(evidence.legs.every((leg) =>
      typeof leg.evidenceCommitment === 'string'
      && /^0x[0-9a-f]{64}$/.test(leg.evidenceCommitment)));
  } finally {
    await server.close();
  }
});

test('executor preserves checkpoint rejection without submission evidence', async () => {
  let submissions = 0;
  const coordinator = new HyperliquidTestnetRuntimeCoordinator(
    {
      prepare: async () => ({
        status: 'CHECKPOINT_INCOMPLETE' as const,
        reasons: ['READ_FAILED'],
        rawResponseCommitments: [{
          operation: 'meta', request: {}, requestedAtMs: 1, receivedAtMs: 2, sha256: EVIDENCE,
        }],
      }),
      reconcile: async () => { throw new Error('must not reconcile'); },
    },
    {
      submitPackage: async () => {
        submissions += 1;
        throw new Error('must not submit');
      },
    },
  );
  const server = await start(coordinator);
  try {
    const response = await execute(server.url);
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'CHECKPOINT_INCOMPLETE');
    assert.deepEqual(response.body.reasons, ['READ_FAILED']);
    assert.deepEqual(response.body.rawEvidenceCommitments, [EVIDENCE]);
    assert.equal(submissions, 0);
  } finally {
    await server.close();
  }
});

test('executor preserves ambiguous submission as incomplete reconciliation', async () => {
  const coordinator = new HyperliquidTestnetRuntimeCoordinator(
    {
      prepare: async () => ({ status: 'PREPARED' as const, state: { checkpoint: 'prepared' } }),
      reconcile: async () => ({
        status: 'EVIDENCE_INCOMPLETE',
        attempt: { status: 'RECONCILING' },
        reasons: ['FILL_HISTORY_INCOMPLETE'],
        rawResponseCommitments: [{ sha256: EVIDENCE }],
      }),
    },
    { submitPackage: async () => submission('SUBMISSION_AMBIGUOUS') },
  );
  const server = await start(coordinator);
  try {
    const response = await execute(server.url);
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'RECONCILIATION_INCOMPLETE');
    assert.equal(response.body.submissionStatus, 'AMBIGUOUS');
    assert.equal(response.body.packageStatus, 'RECONCILING');
  } finally {
    await server.close();
  }
});

test('executor rejects provider identity mismatch and stays disabled without a factory', async () => {
  const mismatch = await start({
    execute: async () => ({
      status: 'CHECKPOINT_FAILED', attemptId: ATTEMPT_ID, errorCommitment: ERROR,
    }),
  } as unknown as HyperliquidTestnetRuntimeCoordinator<unknown, unknown>,
  attempt('attempt-ABCDEFGHIJKL'));
  try {
    const response = await execute(mismatch.url);
    assert.equal(response.status, 409);
    assert.equal((response.body.error as { code: string }).code, 'ATTEMPT_IDENTITY_MISMATCH');
    assert.equal(mismatch.calls(), 0);
  } finally {
    await mismatch.close();
  }

  const disabled = createHyperliquidTestnetExecutorServer();
  await new Promise<void>((resolve, reject) => {
    disabled.once('error', reject);
    disabled.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = disabled.address() as AddressInfo;
    const response = await execute(
      `http://127.0.0.1:${address.port}${SOLVER_TESTNET_EXECUTE_PATH}`,
    );
    assert.equal(response.status, 503);
    assert.equal((response.body.error as { code: string }).code, 'EXECUTION_UNAVAILABLE');
  } finally {
    await new Promise<void>((resolve, reject) => {
      disabled.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});
