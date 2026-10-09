import type { HyperliquidStrategyExecutionPlan } from '@naryx/adapter-hyperliquid';
import type {
  HyperliquidStrategyDurableSubmissionJournalPort,
} from './hyperliquid-strategy-sqlite-journal.js';
import type {
  HyperliquidStrategyEvidenceResult,
  HyperliquidStrategyTestnetHttpEvidence,
} from './hyperliquid-testnet-evidence-http.js';
import type {
  HyperliquidStrategyReconciliationHandoff,
  HyperliquidStrategySubmissionInput,
  HyperliquidStrategySubmissionResult,
  HyperliquidStrategyTestnetSubmissionService,
  HyperliquidSubmissionAccount,
} from './index.js';
import type {
  HyperliquidTrustedTimeDecision,
  HyperliquidTrustedTimePort,
} from './hyperliquid-trusted-time.js';

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export interface HyperliquidStrategyRuntimeJournalPort {
  submissionContext(input: Readonly<{
    account: HyperliquidSubmissionAccount;
    agentWallet: `0x${string}`;
    signerLeaseId: string;
    nowMs: bigint;
    timeDecisionHash: `0x${string}`;
  }>): Readonly<{ expectedVersion: bigint; nonce: bigint }>;
  recordTrustedTimeDecision(scope: string, decision: HyperliquidTrustedTimeDecision): void;
}

export interface HyperliquidStrategyRuntimeSubmissionPort {
  submitBatch(input: HyperliquidStrategySubmissionInput): Promise<HyperliquidStrategySubmissionResult>;
}

export interface HyperliquidStrategyRuntimeEvidencePort {
  collect(input: Readonly<{
    handoff: HyperliquidStrategyReconciliationHandoff;
    binding: HyperliquidStrategyEvidenceBinding;
    plan: HyperliquidStrategyExecutionPlan;
    window: Readonly<{
      startTimeMs: number;
      endTimeMs: number;
      nowMs: number;
      maxEvidenceAgeMs: number;
      maxSnapshotSkewMs: number;
      maxFillPages: number;
    }>;
  }>): Promise<HyperliquidStrategyEvidenceResult>;
}

export interface HyperliquidStrategyEvidenceBinding {
  readonly spotAssetId: number;
  readonly perpetualAssetId: number;
  readonly additionalPerpetualAssetIds?: readonly number[];
  readonly baseFeeToken: string;
  readonly quoteFeeToken: string;
}

export interface HyperliquidStrategyTestnetRuntimeOptions {
  readonly account: HyperliquidSubmissionAccount;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly maxEvidenceAgeMs: number;
  readonly maxSnapshotSkewMs: number;
  readonly maxFillPages: number;
  readonly evidenceBinding: HyperliquidStrategyEvidenceBinding;
  readonly trustedTime: HyperliquidTrustedTimePort;
  readonly evidenceReadBudgetMs?: number;
  readonly currentTimeMs?: () => number;
}

export interface HyperliquidStrategyStageRuntimeResult {
  readonly batchStage: number;
  readonly submission: HyperliquidStrategySubmissionResult;
  readonly evidence: HyperliquidStrategyEvidenceResult | null;
}

export type HyperliquidStrategyRuntimeResult = Readonly<{
  attemptId: string;
  status: 'COMPLETED' | 'NO_EFFECT' | 'RECOVERY_REQUIRED'
    | 'MANUAL_INTERVENTION' | 'EVIDENCE_INCOMPLETE' | 'SUBMISSION_FAILED';
  completedStages: readonly number[];
  stages: readonly HyperliquidStrategyStageRuntimeResult[];
}>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function positiveInteger(value: number, name: string, maximum: number): number {
  requireCondition(Number.isSafeInteger(value) && value > 0 && value <= maximum,
    `${name} must be a bounded positive integer`);
  return value;
}

function clockValue(clock: () => number): number {
  const value = clock();
  requireCondition(Number.isSafeInteger(value) && value > 0, 'trusted clock is invalid');
  return value;
}

export class HyperliquidStrategyTestnetRuntime {
  readonly #journal: HyperliquidStrategyRuntimeJournalPort;
  readonly #submission: HyperliquidStrategyRuntimeSubmissionPort;
  readonly #evidence: HyperliquidStrategyRuntimeEvidencePort;
  readonly #options: Required<HyperliquidStrategyTestnetRuntimeOptions>;

  constructor(
    journal: HyperliquidStrategyRuntimeJournalPort,
    submission: HyperliquidStrategyRuntimeSubmissionPort,
    evidence: HyperliquidStrategyRuntimeEvidencePort,
    options: HyperliquidStrategyTestnetRuntimeOptions,
  ) {
    requireCondition(typeof journal?.submissionContext === 'function'
      && typeof journal.recordTrustedTimeDecision === 'function',
      'strategy runtime requires a durable nonce journal');
    requireCondition(typeof submission?.submitBatch === 'function',
      'strategy runtime requires a submission port');
    requireCondition(typeof evidence?.collect === 'function',
      'strategy runtime requires an evidence port');
    requireCondition(typeof options.trustedTime?.decide === 'function',
      'strategy runtime requires trusted time');
    requireCondition(options.account.accountKind === 'MASTER' || options.account.accountKind === 'SUBACCOUNT',
      'strategy runtime account kind is invalid');
    requireCondition(/^0x[0-9a-f]{40}$/.test(options.agentWallet)
      && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(options.signerLeaseId),
    'strategy runtime signer identity is invalid');
    this.#journal = journal;
    this.#submission = submission;
    this.#evidence = evidence;
    this.#options = Object.freeze({
      ...options,
      maxEvidenceAgeMs: positiveInteger(options.maxEvidenceAgeMs, 'maxEvidenceAgeMs', 300_000),
      maxSnapshotSkewMs: positiveInteger(options.maxSnapshotSkewMs, 'maxSnapshotSkewMs', 60_000),
      maxFillPages: positiveInteger(options.maxFillPages, 'maxFillPages', 64),
      evidenceReadBudgetMs: positiveInteger(
        options.evidenceReadBudgetMs ?? 5_000,
        'evidenceReadBudgetMs',
        30_000,
      ),
      currentTimeMs: options.currentTimeMs ?? Date.now,
    });
  }

  async execute(attemptId: string, plan: HyperliquidStrategyExecutionPlan):
  Promise<HyperliquidStrategyRuntimeResult> {
    requireCondition(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(attemptId),
      'strategy attempt identity is invalid');
    requireCondition(plan.version === 1
      && plan.guarantee === 'BATCHED_IOC_WITH_BOUNDED_RECOVERY'
      && plan.domain.domainId === 'hypercore:testnet'
      && plan.batches.length > 0, 'strategy plan is unsupported');
    const stages = [...plan.batches].sort((left, right) => left.stage - right.stage);
    requireCondition(new Set(stages.map((batch) => batch.stage)).size === stages.length,
      'strategy plan stages must be unique');
    const results: HyperliquidStrategyStageRuntimeResult[] = [];
    const completedStages: number[] = [];
    for (const batch of stages) {
      const decisionScope = `${attemptId}:stage-${batch.stage}`;
      const timeDecision = await this.#options.trustedTime.decide(decisionScope);
      const startedAtMs = timeDecision.selectedTimeMs;
      requireCondition(plan.requestExpiryMs > BigInt(startedAtMs)
        && plan.requestExpiryMs <= MAX_SAFE_INTEGER, 'strategy plan is expired');
      this.#journal.recordTrustedTimeDecision(
        decisionScope,
        timeDecision,
      );
      const context = this.#journal.submissionContext({
        account: this.#options.account,
        agentWallet: this.#options.agentWallet,
        signerLeaseId: this.#options.signerLeaseId,
        nowMs: BigInt(startedAtMs),
        timeDecisionHash: timeDecision.decisionHash,
      });
      const submission = await this.#submission.submitBatch({
        expectedVersion: context.expectedVersion,
        attemptId,
        batchStage: batch.stage,
        agentWallet: this.#options.agentWallet,
        signerLeaseId: this.#options.signerLeaseId,
        plan,
        account: this.#options.account,
        nonce: context.nonce,
        nowMs: BigInt(startedAtMs),
        vaultAddress: this.#options.account.accountKind === 'MASTER'
          ? null : this.#options.account.tradingAccount,
      });
      if (submission.reconciliation === null) {
        results.push(Object.freeze({ batchStage: batch.stage, submission, evidence: null }));
        return this.#result(
          attemptId,
          completedStages.length === 0 ? 'SUBMISSION_FAILED' : 'RECOVERY_REQUIRED',
          completedStages,
          results,
        );
      }
      const deadline = Math.min(
        startedAtMs + this.#options.maxEvidenceAgeMs,
        clockValue(this.#options.currentTimeMs) + this.#options.evidenceReadBudgetMs,
      );
      const evidence = await this.#evidence.collect({
        handoff: submission.reconciliation,
        binding: this.#options.evidenceBinding,
        plan,
        window: {
          startTimeMs: startedAtMs,
          endTimeMs: deadline,
          nowMs: deadline,
          maxEvidenceAgeMs: this.#options.maxEvidenceAgeMs,
          maxSnapshotSkewMs: this.#options.maxSnapshotSkewMs,
          maxFillPages: this.#options.maxFillPages,
        },
      });
      results.push(Object.freeze({ batchStage: batch.stage, submission, evidence }));
      if (evidence.status === 'INCOMPLETE') {
        return this.#result(attemptId, 'EVIDENCE_INCOMPLETE', completedStages, results);
      }
      if (evidence.outcome !== 'COMPLETED') {
        return this.#result(
          attemptId,
          evidence.outcome === 'NO_EFFECT' && completedStages.length > 0
            ? 'RECOVERY_REQUIRED'
            : evidence.outcome,
          completedStages,
          results,
        );
      }
      completedStages.push(batch.stage);
    }
    return this.#result(attemptId, 'COMPLETED', completedStages, results);
  }

  #result(
    attemptId: string,
    status: HyperliquidStrategyRuntimeResult['status'],
    completedStages: readonly number[],
    stages: readonly HyperliquidStrategyStageRuntimeResult[],
  ): HyperliquidStrategyRuntimeResult {
    return Object.freeze({
      attemptId,
      status,
      completedStages: Object.freeze([...completedStages]),
      stages: Object.freeze([...stages]),
    });
  }
}

export function createHyperliquidStrategyTestnetRuntime(input: Readonly<{
  journal: HyperliquidStrategyDurableSubmissionJournalPort;
  submission: HyperliquidStrategyTestnetSubmissionService;
  evidence: HyperliquidStrategyTestnetHttpEvidence;
  options: HyperliquidStrategyTestnetRuntimeOptions;
}>): HyperliquidStrategyTestnetRuntime {
  return new HyperliquidStrategyTestnetRuntime(
    input.journal,
    input.submission,
    input.evidence,
    input.options,
  );
}
