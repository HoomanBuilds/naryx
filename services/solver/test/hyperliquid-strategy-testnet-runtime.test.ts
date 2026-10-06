import assert from 'node:assert/strict';
import test from 'node:test';
import type { HyperliquidStrategyExecutionPlan } from '@naryx/adapter-hyperliquid';
import {
  HyperliquidStrategyTestnetRuntime,
  type HyperliquidStrategyEvidenceResult,
  type HyperliquidStrategyRuntimeEvidencePort,
  type HyperliquidStrategyRuntimeJournalPort,
  type HyperliquidStrategyRuntimeSubmissionPort,
  type HyperliquidStrategySubmissionInput,
  type HyperliquidStrategySubmissionResult,
} from '../src/index.js';

const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;
const account = { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' as const };

function hash(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function plan(): HyperliquidStrategyExecutionPlan {
  return {
    version: 1,
    guarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY',
    domain: {
      domainId: 'hypercore:testnet',
      domainManifestVersion: 1,
      domainManifestHash: hash(1),
    },
    orderHash: hash(2),
    graphHash: hash(3),
    quoteHash: hash(4),
    routeHash: hash(5),
    requestExpiryMs: 2_000_000n,
    orders: [],
    batches: [
      { stage: 0, action: { type: 'order', grouping: 'na', orders: [{}] }, legIds: ['leg-0'] },
      { stage: 1, action: { type: 'order', grouping: 'na', orders: [{}] }, legIds: ['leg-1'] },
    ],
    recoveryAuthorizations: [],
    maximumRecoveryCostQuoteAtoms: 0n,
  } as unknown as HyperliquidStrategyExecutionPlan;
}

function submission(input: HyperliquidStrategySubmissionInput): HyperliquidStrategySubmissionResult {
  return {
    attemptId: input.attemptId,
    batchStage: input.batchStage,
    actionCommitment: `0x${'aa'.repeat(32)}`,
    requestCommitment: `0x${'bb'.repeat(32)}`,
    status: 'SUBMISSION_ACKNOWLEDGED',
    evidenceStatus: 'SUBMISSION_EVIDENCE_ONLY',
    settlementStatus: 'RECONCILIATION_REQUIRED',
    responseCommitment: `0x${'cc'.repeat(32)}`,
    reconciliation: {
      collector: 'HYPERLIQUID_TESTNET_AUTHORITATIVE_EVIDENCE',
      attemptId: input.attemptId,
      batchStage: input.batchStage,
      account,
      actionHash: `0x${'aa'.repeat(32)}`,
      actionCommitmentScheme: 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1',
      requestCommitment: `0x${'bb'.repeat(32)}`,
      durableRevision: `strategy-revision-${input.batchStage}`,
      legIds: [`leg-${input.batchStage}`],
      clientOrderIds: [`0x${(0x51 + input.batchStage).toString(16).repeat(16)}`],
    },
  };
}

function evidence(outcome: 'COMPLETED' | 'NO_EFFECT' | 'RECOVERY_REQUIRED', stage: number):
HyperliquidStrategyEvidenceResult {
  return {
    status: 'COMPLETE',
    outcome,
    reasons: outcome === 'COMPLETED' ? []
      : outcome === 'NO_EFFECT' ? ['PACKAGE_UNFILLED'] : ['PARTIAL_PACKAGE_FILL'],
    observedAtMs: 1_000_100 + stage,
    legs: [{
      legId: `leg-${stage}`,
      clientOrderId: `0x${(0x51 + stage).toString(16).repeat(16)}`,
      plannedSignedBaseAtoms: 100n,
      filledSignedBaseAtoms: outcome === 'COMPLETED' ? 100n
        : outcome === 'NO_EFFECT' ? 0n : 50n,
      terminalStatus: outcome === 'COMPLETED' ? 'FILLED'
        : outcome === 'NO_EFFECT' ? 'UNFILLED_IOC_CANCELLED' : 'PARTIALLY_FILLED_IOC_CANCELLED',
      openOrderStatus: 'NONE',
      orderId: stage + 1,
      fillCount: outcome === 'NO_EFFECT' ? 0 : 1,
      grossQuoteAtoms: outcome === 'COMPLETED' ? 600n
        : outcome === 'NO_EFFECT' ? 0n : 300n,
      feeAssetId: 'base',
      feeAssetDecimals: 8,
      feeAtoms: outcome === 'NO_EFFECT' ? 0n : 1n,
      venueFeeQuoteAtoms: outcome === 'NO_EFFECT' ? 0n : 6n,
      observedAtMs: outcome === 'NO_EFFECT' ? null : 1_000_090 + stage,
    }],
    rawResponseCommitments: [],
  };
}

function runtime(outcomes: readonly ('COMPLETED' | 'NO_EFFECT' | 'RECOVERY_REQUIRED')[]): Readonly<{
  runtime: HyperliquidStrategyTestnetRuntime;
  submittedStages: number[];
  evidencedStages: number[];
}> {
  let context = 0;
  const journal: HyperliquidStrategyRuntimeJournalPort = {
    submissionContext: () => ({ expectedVersion: BigInt(context++), nonce: 1_000_001n + BigInt(context) }),
  };
  const submittedStages: number[] = [];
  const submissionPort: HyperliquidStrategyRuntimeSubmissionPort = {
    submitBatch: async (input) => {
      submittedStages.push(input.batchStage);
      return submission(input);
    },
  };
  const evidencedStages: number[] = [];
  const evidencePort: HyperliquidStrategyRuntimeEvidencePort = {
    collect: async (input) => {
      const stage = input.handoff.batchStage;
      evidencedStages.push(stage);
      return evidence(outcomes[stage]!, stage);
    },
  };
  let time = 1_000_000;
  return Object.freeze({
    runtime: new HyperliquidStrategyTestnetRuntime(journal, submissionPort, evidencePort, {
      account,
      agentWallet,
      signerLeaseId: 'solver-process-1',
      maxEvidenceAgeMs: 30_000,
      maxSnapshotSkewMs: 5_000,
      maxFillPages: 4,
      evidenceBinding: {
        spotAssetId: 10_007,
        perpetualAssetId: 3,
        baseFeeToken: 'BASE',
        quoteFeeToken: 'USDC',
      },
      currentTimeMs: () => time++,
    }),
    submittedStages,
    evidencedStages,
  });
}

test('reconciles each generalized stage before submitting the next stage', async () => {
  const fixture = runtime(['COMPLETED', 'COMPLETED']);
  const result = await fixture.runtime.execute('strategy-attempt-1', plan());
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.completedStages, [0, 1]);
  assert.deepEqual(fixture.submittedStages, [0, 1]);
  assert.deepEqual(fixture.evidencedStages, [0, 1]);
});

test('stops the package before a later stage when recovery is required', async () => {
  const fixture = runtime(['RECOVERY_REQUIRED', 'COMPLETED']);
  const result = await fixture.runtime.execute('strategy-attempt-1', plan());
  assert.equal(result.status, 'RECOVERY_REQUIRED');
  assert.deepEqual(result.completedStages, []);
  assert.deepEqual(fixture.submittedStages, [0]);
  assert.deepEqual(fixture.evidencedStages, [0]);
});

test('treats a later no-effect stage as package recovery required', async () => {
  const fixture = runtime(['COMPLETED', 'NO_EFFECT']);
  const result = await fixture.runtime.execute('strategy-attempt-1', plan());
  assert.equal(result.status, 'RECOVERY_REQUIRED');
  assert.deepEqual(result.completedStages, [0]);
  assert.deepEqual(fixture.submittedStages, [0, 1]);
  assert.deepEqual(fixture.evidencedStages, [0, 1]);
});
