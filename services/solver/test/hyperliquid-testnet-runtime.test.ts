import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import type { HyperliquidExecutionPlan } from '@naryx/adapter-hyperliquid';
import {
  HyperliquidTestnetRuntimeCoordinator,
  type HyperliquidTestnetRuntimeCoordinatorInput,
  type HyperliquidTestnetRuntimeEvidenceWindow,
  type HyperliquidTestnetRuntimeMarketBinding,
  type HyperliquidTestnetRuntimePrepareResult,
  type HyperliquidTestnetStructuralEvidencePort,
  type HyperliquidTestnetPackageSubmissionPort,
} from '../src/hyperliquid-testnet-runtime.js';
import type {
  HyperliquidPackageSubmissionInput,
  HyperliquidPackageSubmissionResult,
  HyperliquidReconciliationHandoff,
} from '../src/index.js';

const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;
const spotCloid = `0x${'51'.repeat(16)}` as const;
const perpetualCloid = `0x${'52'.repeat(16)}` as const;
const actionHash = `0x${'a1'.repeat(32)}` as const;
const recordHash = `0x${'a2'.repeat(32)}` as const;

type PreparedStub = Readonly<{ id: string }>;
type ReconStub = Readonly<{ marker: string }>;

const bindingValue: HyperliquidTestnetRuntimeMarketBinding = {
  spotUniverseIndex: 0,
  spotTokenIndex: 1,
  perpetualAssetIndex: 2,
  quoteTokenIndex: 3,
};

const checkpointValue: HyperliquidTestnetRuntimeEvidenceWindow = {
  startTimeMs: 900_000,
  endTimeMs: 950_000,
  nowMs: 1_000_000,
  maxEvidenceAgeMs: 200_000,
  maxSnapshotSkewMs: 5_000,
};

const reconciliationValue: HyperliquidTestnetRuntimeEvidenceWindow = {
  startTimeMs: 950_000,
  endTimeMs: 1_000_000,
  nowMs: 1_000_000,
  maxEvidenceAgeMs: 200_000,
  maxSnapshotSkewMs: 5_000,
};

function planStub(): HyperliquidExecutionPlan {
  return { version: 1 } as unknown as HyperliquidExecutionPlan;
}

function coordinatorInput(): HyperliquidTestnetRuntimeCoordinatorInput {
  return {
    expectedVersion: 0n,
    attemptId: 'attempt-1',
    agentWallet,
    signerLeaseId: 'solver-process-1',
    plan: planStub(),
    account: { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' },
    nonce: 1_000_001n,
    nowMs: 1_000_000n,
    vaultAddress: tradingAccount,
    binding: { ...bindingValue },
    checkpointWindow: { ...checkpointValue },
    reconciliationWindow: { ...reconciliationValue },
  };
}

function handoffStub(): HyperliquidReconciliationHandoff {
  return Object.freeze({
    collector: 'HYPERLIQUID_TESTNET_AUTHORITATIVE_EVIDENCE',
    attemptId: 'attempt-1',
    account: { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' },
    actionHash,
    actionCommitmentScheme: 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1',
    requestCommitment: recordHash,
    durableRevision: 'durable-revision-7',
    spotClientOrderId: spotCloid,
    perpetualClientOrderId: perpetualCloid,
  }) as HyperliquidReconciliationHandoff;
}

function notSubmitted(): HyperliquidPackageSubmissionResult {
  return Object.freeze({
    attemptId: 'attempt-1',
    actionCommitmentScheme: null,
    actionCommitment: null,
    requestCommitment: null,
    status: 'NOT_SUBMITTED',
    evidenceStatus: 'PRECONDITION_REJECTED',
    settlementStatus: 'NOT_APPLICABLE',
    errorCommitment: `0x${'00'.repeat(32)}`,
    reconciliation: null,
  }) as HyperliquidPackageSubmissionResult;
}

function acknowledged(
  handoff: HyperliquidReconciliationHandoff,
): HyperliquidPackageSubmissionResult {
  return Object.freeze({
    attemptId: 'attempt-1',
    actionCommitmentScheme: 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1',
    actionCommitment: actionHash,
    requestCommitment: recordHash,
    status: 'SUBMISSION_ACKNOWLEDGED',
    evidenceStatus: 'SUBMISSION_EVIDENCE_ONLY',
    settlementStatus: 'RECONCILIATION_REQUIRED',
    responseCommitment: `0x${'aa'.repeat(32)}`,
    reconciliation: handoff,
  }) as HyperliquidPackageSubmissionResult;
}

function rejected(
  handoff: HyperliquidReconciliationHandoff,
): HyperliquidPackageSubmissionResult {
  return Object.freeze({
    attemptId: 'attempt-1',
    actionCommitmentScheme: 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1',
    actionCommitment: actionHash,
    requestCommitment: recordHash,
    status: 'SUBMISSION_REJECTED',
    evidenceStatus: 'VENUE_REJECTED',
    settlementStatus: 'RECONCILIATION_REQUIRED',
    errorCommitment: `0x${'ab'.repeat(32)}`,
    reconciliation: handoff,
  }) as HyperliquidPackageSubmissionResult;
}

function ambiguous(
  handoff: HyperliquidReconciliationHandoff,
): HyperliquidPackageSubmissionResult {
  return Object.freeze({
    attemptId: 'attempt-1',
    actionCommitmentScheme: 'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1',
    actionCommitment: actionHash,
    requestCommitment: recordHash,
    status: 'SUBMISSION_AMBIGUOUS',
    evidenceStatus: 'RESPONSE_UNKNOWN',
    settlementStatus: 'RECONCILIATION_REQUIRED',
    errorCommitment: `0x${'ac'.repeat(32)}`,
    reconciliation: handoff,
  }) as HyperliquidPackageSubmissionResult;
}

function errorCommitmentFor(message: string): `0x${string}` {
  return `0x${createHash('sha256')
    .update(JSON.stringify({ name: 'Error', message })).digest('hex')}`;
}

class FakeEvidence implements HyperliquidTestnetStructuralEvidencePort<PreparedStub, ReconStub> {
  readonly events: string[] = [];
  prepareImpl: (input: unknown) => Promise<HyperliquidTestnetRuntimePrepareResult<PreparedStub>>;
  reconcileImpl: (
    prepared: PreparedStub,
    handoff: HyperliquidReconciliationHandoff,
    binding: HyperliquidTestnetRuntimeMarketBinding,
    window: HyperliquidTestnetRuntimeEvidenceWindow,
  ) => Promise<ReconStub>;
  lastPrepareInput: {
    attemptId: string;
    plan: unknown;
    account: unknown;
    binding: HyperliquidTestnetRuntimeMarketBinding;
    window: HyperliquidTestnetRuntimeEvidenceWindow;
  } | null = null;
  lastReconcile: {
    prepared: PreparedStub;
    handoff: HyperliquidReconciliationHandoff;
    binding: HyperliquidTestnetRuntimeMarketBinding;
    window: HyperliquidTestnetRuntimeEvidenceWindow;
  } | null = null;

  constructor(
    prepareImpl: (input: unknown) => Promise<HyperliquidTestnetRuntimePrepareResult<PreparedStub>>,
    reconcileImpl: (
      prepared: PreparedStub,
      handoff: HyperliquidReconciliationHandoff,
      binding: HyperliquidTestnetRuntimeMarketBinding,
      window: HyperliquidTestnetRuntimeEvidenceWindow,
    ) => Promise<ReconStub>,
  ) {
    this.prepareImpl = prepareImpl;
    this.reconcileImpl = reconcileImpl;
  }

  async prepare(input: {
    attemptId: string;
    plan: HyperliquidExecutionPlan;
    account: { masterAccount: string; tradingAccount: string; accountKind: string };
    binding: HyperliquidTestnetRuntimeMarketBinding;
    window: HyperliquidTestnetRuntimeEvidenceWindow;
  }): Promise<HyperliquidTestnetRuntimePrepareResult<PreparedStub>> {
    this.events.push('prepare');
    this.lastPrepareInput = input as typeof this.lastPrepareInput & object;
    return this.prepareImpl(input);
  }

  async reconcile(
    prepared: PreparedStub,
    handoff: HyperliquidReconciliationHandoff,
    binding: HyperliquidTestnetRuntimeMarketBinding,
    window: HyperliquidTestnetRuntimeEvidenceWindow,
  ): Promise<ReconStub> {
    this.events.push('reconcile');
    this.lastReconcile = { prepared, handoff, binding, window };
    return this.reconcileImpl(prepared, handoff, binding, window);
  }
}

class FakeSubmission implements HyperliquidTestnetPackageSubmissionPort {
  readonly events: string[] = [];
  calls = 0;
  lastInput: HyperliquidPackageSubmissionInput | null = null;
  impl: (input: HyperliquidPackageSubmissionInput) => Promise<HyperliquidPackageSubmissionResult>;

  constructor(
    impl: (input: HyperliquidPackageSubmissionInput) => Promise<HyperliquidPackageSubmissionResult>,
  ) {
    this.impl = impl;
  }

  async submitPackage(
    input: HyperliquidPackageSubmissionInput,
  ): Promise<HyperliquidPackageSubmissionResult> {
    this.calls += 1;
    this.events.push('submit');
    this.lastInput = input;
    return this.impl(input);
  }
}

test('orders prepare, submit, and reconcile with exact forwarding', async () => {
  const input = coordinatorInput();
  const preparedState: PreparedStub = Object.freeze({ id: 'prepared-1' });
  const handoff = handoffStub();
  const submission = acknowledged(handoff);
  const recon: ReconStub = Object.freeze({ marker: 'recon-1' });
  const order: string[] = [];
  const evidence = new FakeEvidence(
    async () => {
      order.push('prepare');
      return Object.freeze({ status: 'PREPARED' as const, state: preparedState });
    },
    async () => {
      order.push('reconcile');
      return recon;
    },
  );
  const submitter = new FakeSubmission(async () => {
    order.push('submit');
    return submission;
  });
  const result = await new HyperliquidTestnetRuntimeCoordinator(evidence, submitter)
    .execute(input);

  assert.deepEqual(order, ['prepare', 'submit', 'reconcile']);
  assert.equal(result.status, 'RECONCILIATION_OBSERVED');
  assert.equal(result.submission, submission);
  assert.equal(result.reconciliation, recon);
  assert.ok(evidence.lastPrepareInput);
  assert.equal(evidence.lastPrepareInput.attemptId, 'attempt-1');
  assert.equal(evidence.lastPrepareInput.plan, input.plan);
  assert.equal(evidence.lastPrepareInput.account, input.account);
  assert.deepEqual(evidence.lastPrepareInput.binding, bindingValue);
  assert.deepEqual(evidence.lastPrepareInput.window, checkpointValue);
  assert.ok(submitter.lastInput);
  assert.equal(submitter.lastInput.plan, input.plan);
  assert.equal(submitter.lastInput.account, input.account);
  assert.ok(!('binding' in (submitter.lastInput as unknown as Record<string, unknown>)));
  assert.ok(!('checkpointWindow' in (submitter.lastInput as unknown as Record<string, unknown>)));
  assert.ok(evidence.lastReconcile);
  assert.equal(evidence.lastReconcile.prepared, preparedState);
  assert.equal(evidence.lastReconcile.handoff, handoff);
  assert.equal(evidence.lastReconcile.binding, evidence.lastPrepareInput.binding);
  assert.deepEqual(evidence.lastReconcile.window, reconciliationValue);
  assert.deepEqual(input.binding, bindingValue);
  assert.deepEqual(input.checkpointWindow, checkpointValue);
});

test('incomplete and thrown checkpoints never submit', async () => {
  const incompleteReasons = ['READ_FAILED'] as const;
  const raw = [{
    operation: 'meta',
    request: {},
    requestedAtMs: 1,
    receivedAtMs: 2,
    sha256: `0x${'bb'.repeat(32)}`,
  }] as const;
  const incompleteEvidence = new FakeEvidence(
    async () => Object.freeze({
      status: 'CHECKPOINT_INCOMPLETE' as const,
      reasons: [...incompleteReasons],
      rawResponseCommitments: [...raw],
    }),
    async () => { throw new Error('must not reconcile'); },
  );
  const incompleteSubmitter = new FakeSubmission(async () => { throw new Error('must not submit'); });
  const incomplete = await new HyperliquidTestnetRuntimeCoordinator(
    incompleteEvidence, incompleteSubmitter,
  ).execute(coordinatorInput());
  assert.equal(incomplete.status, 'CHECKPOINT_INCOMPLETE');
  assert.deepEqual([...incomplete.reasons], [...incompleteReasons]);
  assert.deepEqual(incomplete.rawResponseCommitments, [...raw]);
  assert.equal(incompleteSubmitter.calls, 0);
  assert.deepEqual(incompleteEvidence.events, ['prepare']);

  const thrownEvidence = new FakeEvidence(
    async () => { throw new Error('collector unavailable'); },
    async () => { throw new Error('must not reconcile'); },
  );
  const thrownSubmitter = new FakeSubmission(async () => { throw new Error('must not submit'); });
  const thrown = await new HyperliquidTestnetRuntimeCoordinator(thrownEvidence, thrownSubmitter)
    .execute(coordinatorInput());
  assert.equal(thrown.status, 'CHECKPOINT_FAILED');
  assert.equal(thrown.errorCommitment, errorCommitmentFor('collector unavailable'));
  assert.equal(thrownSubmitter.calls, 0);
  assert.deepEqual(thrownEvidence.events, ['prepare']);
});

test('no-handoff submission returns not-submitted without reconcile', async () => {
  const preparedState: PreparedStub = Object.freeze({ id: 'prepared-1' });
  const submission = notSubmitted();
  const evidence = new FakeEvidence(
    async () => Object.freeze({ status: 'PREPARED' as const, state: preparedState }),
    async () => { throw new Error('must not reconcile'); },
  );
  const submitter = new FakeSubmission(async () => submission);
  const result = await new HyperliquidTestnetRuntimeCoordinator(evidence, submitter)
    .execute(coordinatorInput());
  assert.equal(result.status, 'NOT_SUBMITTED');
  assert.equal(result.submission, submission);
  assert.deepEqual(evidence.events, ['prepare']);
  assert.equal(submitter.calls, 1);
});

test('handoff-bearing submissions reconcile exactly once and stay reconciliation-required', async () => {
  const cases = [
    { name: 'acknowledged', build: acknowledged },
    { name: 'rejected', build: rejected },
    { name: 'ambiguous', build: ambiguous },
  ] as const;
  for (const entry of cases) {
    const preparedState: PreparedStub = Object.freeze({ id: `prepared-${entry.name}` });
    const handoff = handoffStub();
    const submission = entry.build(handoff);
    const recon: ReconStub = Object.freeze({ marker: `recon-${entry.name}` });
    let reconcileCalls = 0;
    const evidence = new FakeEvidence(
      async () => Object.freeze({ status: 'PREPARED' as const, state: preparedState }),
      async (prepared, nextHandoff, binding, window) => {
        reconcileCalls += 1;
        assert.equal(prepared, preparedState);
        assert.equal(nextHandoff, handoff);
        assert.deepEqual(binding, bindingValue);
        assert.deepEqual(window, reconciliationValue);
        return recon;
      },
    );
    const submitter = new FakeSubmission(async () => submission);
    const result = await new HyperliquidTestnetRuntimeCoordinator(evidence, submitter)
      .execute(coordinatorInput());
    assert.equal(result.status, 'RECONCILIATION_OBSERVED', entry.name);
    assert.equal(result.submission, submission, entry.name);
    assert.equal(result.submission.settlementStatus, 'RECONCILIATION_REQUIRED', entry.name);
    assert.equal(result.reconciliation, recon, entry.name);
    assert.equal(submitter.calls, 1, entry.name);
    assert.equal(reconcileCalls, 1, entry.name);
    assert.deepEqual(evidence.events, ['prepare', 'reconcile'], entry.name);
  }
});

test('thrown reconciliation defers without resubmission', async () => {
  const preparedState: PreparedStub = Object.freeze({ id: 'prepared-1' });
  const handoff = handoffStub();
  const submission = acknowledged(handoff);
  const evidence = new FakeEvidence(
    async () => Object.freeze({ status: 'PREPARED' as const, state: preparedState }),
    async () => { throw new Error('evidence read failed'); },
  );
  const submitter = new FakeSubmission(async () => submission);
  const result = await new HyperliquidTestnetRuntimeCoordinator(evidence, submitter)
    .execute(coordinatorInput());
  assert.equal(result.status, 'RECONCILIATION_DEFERRED');
  assert.equal(result.submission, submission);
  assert.equal(result.handoff, handoff);
  assert.equal(result.errorCommitment, errorCommitmentFor('evidence read failed'));
  assert.equal(submitter.calls, 1);
  assert.deepEqual(evidence.events, ['prepare', 'reconcile']);
  assert.ok(!('stack' in (result as Record<string, unknown>)));
});

test('thrown submission is not retried and never reconciles', async () => {
  const preparedState: PreparedStub = Object.freeze({ id: 'prepared-1' });
  const evidence = new FakeEvidence(
    async () => Object.freeze({ status: 'PREPARED' as const, state: preparedState }),
    async () => { throw new Error('must not reconcile'); },
  );
  const submitter = new FakeSubmission(async () => { throw new Error('transport lost'); });
  const result = await new HyperliquidTestnetRuntimeCoordinator(evidence, submitter)
    .execute(coordinatorInput());
  assert.equal(result.status, 'SUBMISSION_CALL_FAILED');
  assert.equal(result.errorCommitment, errorCommitmentFor('transport lost'));
  assert.equal(result.prepared, preparedState);
  assert.equal(result.attemptId, 'attempt-1');
  assert.equal(submitter.calls, 1);
  assert.deepEqual(evidence.events, ['prepare']);
});

test('invalid binding and window fail closed before prepare', async () => {
  const preparedState: PreparedStub = Object.freeze({ id: 'prepared-1' });
  const evidence = new FakeEvidence(
    async () => Object.freeze({ status: 'PREPARED' as const, state: preparedState }),
    async () => Object.freeze({ marker: 'never' }),
  );
  const submitter = new FakeSubmission(async () => notSubmitted());
  const badBinding = coordinatorInput();
  (badBinding as { binding: unknown }).binding = { ...bindingValue, spotTokenIndex: -1 };
  const badBindingResult = await new HyperliquidTestnetRuntimeCoordinator(evidence, submitter)
    .execute(badBinding);
  assert.equal(badBindingResult.status, 'CHECKPOINT_FAILED');
  assert.equal(evidence.events.length, 0);
  assert.equal(submitter.calls, 0);

  evidence.events.length = 0;
  const badWindow = coordinatorInput();
  (badWindow as { reconciliationWindow: unknown }).reconciliationWindow = {
    ...reconciliationValue, endTimeMs: 999_999,
  };
  const badWindowResult = await new HyperliquidTestnetRuntimeCoordinator(evidence, submitter)
    .execute(badWindow);
  assert.equal(badWindowResult.status, 'CHECKPOINT_FAILED');
  assert.equal(evidence.events.length, 0);
  assert.equal(submitter.calls, 0);
});

test('malformed submission shapes fail closed without reconcile', async () => {
  const handoff = handoffStub();
  const cases = [
    {
      name: 'not-submitted with handoff',
      build: () => ({
        ...notSubmitted(),
        reconciliation: handoff,
      } as unknown as HyperliquidPackageSubmissionResult),
    },
    {
      name: 'acknowledged with null handoff',
      build: () => ({
        ...acknowledged(handoff),
        reconciliation: null,
      } as unknown as HyperliquidPackageSubmissionResult),
    },
  ] as const;
  for (const entry of cases) {
    const preparedState: PreparedStub = Object.freeze({ id: `prepared-${entry.name}` });
    const submission = entry.build();
    const evidence = new FakeEvidence(
      async () => Object.freeze({ status: 'PREPARED' as const, state: preparedState }),
      async () => { throw new Error('must not reconcile'); },
    );
    const submitter = new FakeSubmission(async () => submission);
    const result = await new HyperliquidTestnetRuntimeCoordinator(evidence, submitter)
      .execute(coordinatorInput());
    assert.equal(result.status, 'SUBMISSION_RESULT_INVALID', entry.name);
    assert.equal(result.attemptId, 'attempt-1', entry.name);
    assert.equal(result.errorCommitment, errorCommitmentFor('submission result is invalid'), entry.name);
    assert.equal(result.prepared, preparedState, entry.name);
    assert.equal(submitter.calls, 1, entry.name);
    assert.deepEqual(evidence.events, ['prepare'], entry.name);
  }
});
