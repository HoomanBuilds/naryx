import { createHash } from 'node:crypto';
import type { HyperliquidExecutionPlan } from '@naryx/adapter-hyperliquid';
import type {
  HyperliquidPackageSubmissionInput,
  HyperliquidPackageSubmissionResult,
  HyperliquidReconciliationHandoff,
  HyperliquidSubmissionAccount,
} from './index.js';

export interface HyperliquidTestnetRuntimeMarketBinding {
  readonly spotUniverseIndex: number;
  readonly spotTokenIndex: number;
  readonly perpetualAssetIndex: number;
  readonly quoteTokenIndex: number;
}

export interface HyperliquidTestnetRuntimeEvidenceWindow {
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly nowMs: number;
  readonly maxEvidenceAgeMs: number;
  readonly maxSnapshotSkewMs: number;
  readonly maxFillPages?: number;
}

export interface HyperliquidTestnetRuntimeRawCommitment {
  readonly operation: string;
  readonly request: unknown;
  readonly requestedAtMs: number;
  readonly receivedAtMs: number;
  readonly sha256: `0x${string}`;
}

export interface HyperliquidTestnetRuntimePrepareInput {
  readonly attemptId: string;
  readonly plan: HyperliquidExecutionPlan;
  readonly account: HyperliquidSubmissionAccount;
  readonly binding: HyperliquidTestnetRuntimeMarketBinding;
  readonly window: HyperliquidTestnetRuntimeEvidenceWindow;
}

export type HyperliquidTestnetRuntimePrepareResult<TPrepared> =
  | Readonly<{ status: 'PREPARED'; state: TPrepared }>
  | Readonly<{
      status: 'CHECKPOINT_INCOMPLETE';
      reasons: readonly string[];
      rawResponseCommitments: readonly HyperliquidTestnetRuntimeRawCommitment[];
    }>;

export interface HyperliquidTestnetStructuralEvidencePort<TPrepared, TReconciliation> {
  prepare(input: HyperliquidTestnetRuntimePrepareInput):
    Promise<HyperliquidTestnetRuntimePrepareResult<TPrepared>>;
  reconcile(
    prepared: TPrepared,
    handoff: HyperliquidReconciliationHandoff,
    binding: HyperliquidTestnetRuntimeMarketBinding,
    window: HyperliquidTestnetRuntimeEvidenceWindow,
  ): Promise<TReconciliation>;
}

export interface HyperliquidTestnetPackageSubmissionPort {
  submitPackage(input: HyperliquidPackageSubmissionInput):
    Promise<HyperliquidPackageSubmissionResult>;
}

export interface HyperliquidTestnetRuntimeCoordinatorInput
  extends HyperliquidPackageSubmissionInput {
  readonly binding: HyperliquidTestnetRuntimeMarketBinding;
  readonly checkpointWindow: HyperliquidTestnetRuntimeEvidenceWindow;
  readonly reconciliationWindow: HyperliquidTestnetRuntimeEvidenceWindow;
}

export type HandoffBearingSubmission = Exclude<
  HyperliquidPackageSubmissionResult, { status: 'NOT_SUBMITTED' }
>;
export type NotSubmittedSubmission = Extract<
  HyperliquidPackageSubmissionResult, { status: 'NOT_SUBMITTED' }
>;

export type HyperliquidTestnetRuntimeCoordinatorResult<TPrepared, TReconciliation> =
  | Readonly<{
      status: 'CHECKPOINT_INCOMPLETE';
      attemptId: string;
      reasons: readonly string[];
      rawResponseCommitments: readonly HyperliquidTestnetRuntimeRawCommitment[];
    }>
  | Readonly<{
      status: 'CHECKPOINT_FAILED';
      attemptId: string;
      errorCommitment: `0x${string}`;
    }>
  | Readonly<{ status: 'NOT_SUBMITTED'; submission: NotSubmittedSubmission }>
  | Readonly<{
      status: 'RECONCILIATION_OBSERVED';
      submission: HandoffBearingSubmission;
      reconciliation: TReconciliation;
    }>
  | Readonly<{
      status: 'RECONCILIATION_DEFERRED';
      submission: HandoffBearingSubmission;
      handoff: HyperliquidReconciliationHandoff;
      errorCommitment: `0x${string}`;
    }>
  | Readonly<{
      status: 'SUBMISSION_CALL_FAILED';
      attemptId: string;
      errorCommitment: `0x${string}`;
      prepared: TPrepared;
    }>
  | Readonly<{
      status: 'SUBMISSION_RESULT_INVALID';
      attemptId: string;
      errorCommitment: `0x${string}`;
      prepared: TPrepared;
    }>;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function stableErrorCommitment(error: unknown): `0x${string}` {
  const normalized = error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'UnknownError', message: 'unknown' };
  return `0x${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

function isNotSubmittedSubmission(
  submission: HyperliquidPackageSubmissionResult,
): submission is NotSubmittedSubmission {
  return submission.status === 'NOT_SUBMITTED'
    && submission.reconciliation === null
    && submission.settlementStatus === 'NOT_APPLICABLE'
    && (submission.evidenceStatus === 'PRECONDITION_REJECTED'
      || submission.evidenceStatus === 'JOURNAL_REJECTED');
}

function isHandoffBearingSubmission(
  submission: HyperliquidPackageSubmissionResult,
): submission is HandoffBearingSubmission {
  return (submission.status === 'SUBMISSION_ACKNOWLEDGED'
    || submission.status === 'SUBMISSION_REJECTED'
    || submission.status === 'SUBMISSION_AMBIGUOUS')
    && submission.reconciliation !== null
    && typeof submission.reconciliation === 'object'
    && submission.settlementStatus === 'RECONCILIATION_REQUIRED';
}

function checkedBinding(
  value: unknown,
): HyperliquidTestnetRuntimeMarketBinding {
  if (value === null || typeof value !== 'object') {
    throw new Error('market binding is invalid');
  }
  const candidate = value as Record<string, unknown>;
  const fields = ['spotUniverseIndex', 'spotTokenIndex', 'perpetualAssetIndex',
    'quoteTokenIndex'] as const;
  for (const field of fields) {
    if (!isNonNegativeSafeInteger(candidate[field])) {
      throw new Error(`market binding ${field} must be a nonnegative safe integer`);
    }
  }
  return Object.freeze({
    spotUniverseIndex: candidate.spotUniverseIndex as number,
    spotTokenIndex: candidate.spotTokenIndex as number,
    perpetualAssetIndex: candidate.perpetualAssetIndex as number,
    quoteTokenIndex: candidate.quoteTokenIndex as number,
  });
}

function checkedWindow(
  value: unknown,
  name: string,
  requireEndEqualsNow: boolean,
): HyperliquidTestnetRuntimeEvidenceWindow {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${name} is invalid`);
  }
  const candidate = value as Record<string, unknown>;
  const startTimeMs = candidate.startTimeMs;
  const endTimeMs = candidate.endTimeMs;
  const nowMs = candidate.nowMs;
  const maxEvidenceAgeMs = candidate.maxEvidenceAgeMs;
  const maxSnapshotSkewMs = candidate.maxSnapshotSkewMs;
  const maxFillPages = candidate.maxFillPages;
  if (!isNonNegativeSafeInteger(startTimeMs)
    || !isNonNegativeSafeInteger(endTimeMs)
    || !isNonNegativeSafeInteger(nowMs)
    || !isNonNegativeSafeInteger(maxEvidenceAgeMs)
    || !isNonNegativeSafeInteger(maxSnapshotSkewMs)
    || maxEvidenceAgeMs === 0
    || maxSnapshotSkewMs === 0) {
    throw new Error(`${name} numbers must be nonnegative safe integers with positive age limits`);
  }
  if ((startTimeMs as number) > (endTimeMs as number)) {
    throw new Error(`${name} start must not exceed end`);
  }
  if (requireEndEqualsNow) {
    if ((endTimeMs as number) !== (nowMs as number)) {
      throw new Error(`${name} end must equal now`);
    }
  } else if ((endTimeMs as number) > (nowMs as number)) {
    throw new Error(`${name} end must not exceed now`);
  }
  if (maxFillPages !== undefined
    && (!isNonNegativeSafeInteger(maxFillPages) || (maxFillPages as number) < 1)) {
    throw new Error(`${name} maxFillPages must be a positive safe integer when present`);
  }
  const base = {
    startTimeMs: startTimeMs as number,
    endTimeMs: endTimeMs as number,
    nowMs: nowMs as number,
    maxEvidenceAgeMs: maxEvidenceAgeMs as number,
    maxSnapshotSkewMs: maxSnapshotSkewMs as number,
  };
  if (maxFillPages === undefined) return Object.freeze(base);
  return Object.freeze({ ...base, maxFillPages: maxFillPages as number });
}

export class HyperliquidTestnetRuntimeCoordinator<TPrepared, TReconciliation> {
  readonly #evidence: HyperliquidTestnetStructuralEvidencePort<TPrepared, TReconciliation>;
  readonly #submission: HyperliquidTestnetPackageSubmissionPort;

  constructor(
    evidence: HyperliquidTestnetStructuralEvidencePort<TPrepared, TReconciliation>,
    submission: HyperliquidTestnetPackageSubmissionPort,
  ) {
    if (evidence === null || typeof evidence !== 'object'
      || typeof evidence.prepare !== 'function'
      || typeof evidence.reconcile !== 'function') {
      throw new Error('a structural evidence runtime port is required');
    }
    if (submission === null || typeof submission !== 'object'
      || typeof submission.submitPackage !== 'function') {
      throw new Error('a durable package submission port is required');
    }
    this.#evidence = evidence;
    this.#submission = submission;
  }

  async execute(
    input: HyperliquidTestnetRuntimeCoordinatorInput,
  ): Promise<HyperliquidTestnetRuntimeCoordinatorResult<TPrepared, TReconciliation>> {
    const fallbackAttemptId = typeof (input as { attemptId?: unknown } | null)?.attemptId === 'string'
      ? (input as { attemptId: string }).attemptId
      : 'unknown';
    let binding: HyperliquidTestnetRuntimeMarketBinding;
    let checkpointWindow: HyperliquidTestnetRuntimeEvidenceWindow;
    let reconciliationWindow: HyperliquidTestnetRuntimeEvidenceWindow;
    try {
      if (input === null || typeof input !== 'object') {
        throw new Error('coordinator input is invalid');
      }
      if (typeof input.attemptId !== 'string' || input.attemptId.length === 0) {
        throw new Error('attempt identity is invalid');
      }
      if (input.plan === null || typeof input.plan !== 'object'
        || input.account === null || typeof input.account !== 'object') {
        throw new Error('plan and account are required');
      }
      binding = checkedBinding(input.binding);
      checkpointWindow = checkedWindow(input.checkpointWindow, 'checkpointWindow', false);
      reconciliationWindow = checkedWindow(
        input.reconciliationWindow, 'reconciliationWindow', true,
      );
      // The prepared state is an opaque generic, so the coordinator cannot know
      // the checkpoint observed timestamp. It preserves both windows exactly and
      // leaves start alignment to the injected evidence port.
    } catch (error) {
      return Object.freeze({
        status: 'CHECKPOINT_FAILED' as const,
        attemptId: fallbackAttemptId,
        errorCommitment: stableErrorCommitment(error),
      });
    }

    let preparedResult: HyperliquidTestnetRuntimePrepareResult<TPrepared>;
    try {
      preparedResult = await this.#evidence.prepare({
        attemptId: input.attemptId,
        plan: input.plan,
        account: input.account,
        binding,
        window: checkpointWindow,
      });
    } catch (error) {
      return Object.freeze({
        status: 'CHECKPOINT_FAILED' as const,
        attemptId: input.attemptId,
        errorCommitment: stableErrorCommitment(error),
      });
    }

    if (preparedResult.status === 'CHECKPOINT_INCOMPLETE') {
      return Object.freeze({
        status: 'CHECKPOINT_INCOMPLETE' as const,
        attemptId: input.attemptId,
        reasons: Object.freeze([...preparedResult.reasons]),
        rawResponseCommitments: Object.freeze([...preparedResult.rawResponseCommitments]),
      });
    }
    if (preparedResult.status !== 'PREPARED') {
      return Object.freeze({
        status: 'CHECKPOINT_FAILED' as const,
        attemptId: input.attemptId,
        errorCommitment: stableErrorCommitment(new Error('evidence prepare result is invalid')),
      });
    }
    const prepared = preparedResult.state;

    const submissionInput: HyperliquidPackageSubmissionInput = {
      expectedVersion: input.expectedVersion,
      attemptId: input.attemptId,
      agentWallet: input.agentWallet,
      signerLeaseId: input.signerLeaseId,
      plan: input.plan,
      account: input.account,
      nonce: input.nonce,
      nowMs: input.nowMs,
      vaultAddress: input.vaultAddress,
    };

    let submission: HyperliquidPackageSubmissionResult;
    try {
      submission = await this.#submission.submitPackage(submissionInput);
    } catch (error) {
      return Object.freeze({
        status: 'SUBMISSION_CALL_FAILED' as const,
        attemptId: input.attemptId,
        errorCommitment: stableErrorCommitment(error),
        prepared,
      });
    }

    if (isNotSubmittedSubmission(submission)) {
      return Object.freeze({
        status: 'NOT_SUBMITTED' as const,
        submission,
      });
    }
    if (!isHandoffBearingSubmission(submission)) {
      return Object.freeze({
        status: 'SUBMISSION_RESULT_INVALID' as const,
        attemptId: input.attemptId,
        errorCommitment: stableErrorCommitment(new Error('submission result is invalid')),
        prepared,
      });
    }

    const handoff = submission.reconciliation;
    try {
      const reconciliation = await this.#evidence.reconcile(
        prepared, handoff, binding, reconciliationWindow,
      );
      return Object.freeze({
        status: 'RECONCILIATION_OBSERVED' as const,
        submission,
        reconciliation,
      });
    } catch (error) {
      return Object.freeze({
        status: 'RECONCILIATION_DEFERRED' as const,
        submission,
        handoff,
        errorCommitment: stableErrorCommitment(error),
      });
    }
  }
}
