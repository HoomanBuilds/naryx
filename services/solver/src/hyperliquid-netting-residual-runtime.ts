import {
  compileHyperliquidNettingResidualPlan,
  hyperliquidNettingResidualEvidence,
  type HyperliquidNettingResidualMarketBinding,
  type HyperliquidNettingResidualPlan,
  type HyperliquidNettingResidualIntent,
  type HyperliquidNettingResidualEvidence,
} from '@naryx/adapter-hyperliquid';
import {
  crossBatchExternalExecutionIntentHash,
  nettingExternalExecutionIntentHash,
  toHex,
  type CrossBatchExternalExecutionEvidence,
  type CrossBatchExternalExecutionIntent,
  type NettingExternalExecutionEvidence,
  type NettingExternalExecutionIntent,
  type NettingInstrumentPolicy,
} from '@naryx/protocol-types';
import type {
  HyperliquidNettingResidualDurableJournalPort,
  HyperliquidNettingResidualJournalReceipt,
} from './hyperliquid-netting-residual-sqlite-journal.js';
import type {
  HyperliquidNettingResidualEvidenceBinding,
  HyperliquidNettingResidualEvidenceCollectInput,
  HyperliquidNettingResidualEvidenceResult,
} from './hyperliquid-testnet-evidence-http.js';
import type {
  HyperliquidNettingResidualSubmissionInput,
  HyperliquidNettingResidualSubmissionResult,
  HyperliquidNettingResidualTestnetSubmissionService,
} from './hyperliquid-netting-residual-testnet-submission.js';
import type { HyperliquidSubmissionAccount } from './index.js';
import type { HyperliquidTrustedTimePort } from './hyperliquid-trusted-time.js';

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export type HyperliquidNettingResidualRuntimeErrorCode =
  | 'IDEMPOTENCY_MISMATCH'
  | 'UNSUPPORTED_DOMAIN'
  | 'INTENT_EXPIRED'
  | 'SUBMISSION_FAILED'
  | 'EVIDENCE_PENDING'
  | 'JOURNAL_STATE_INVALID';

export class HyperliquidNettingResidualRuntimeError extends Error {
  readonly code: HyperliquidNettingResidualRuntimeErrorCode;

  constructor(code: HyperliquidNettingResidualRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'HyperliquidNettingResidualRuntimeError';
    this.code = code;
  }
}

export interface HyperliquidNettingResidualRuntimeLane {
  readonly instrument: NettingInstrumentPolicy;
  readonly marketBinding: HyperliquidNettingResidualMarketBinding;
  readonly evidenceBinding: HyperliquidNettingResidualEvidenceBinding;
}

export interface HyperliquidNettingResidualRuntimeLaneResolver {
  resolve(intent: HyperliquidNettingResidualIntent): HyperliquidNettingResidualRuntimeLane;
}

export interface HyperliquidNettingResidualRuntimeEvidencePort {
  collect(input: HyperliquidNettingResidualEvidenceCollectInput):
  Promise<HyperliquidNettingResidualEvidenceResult>;
}

export interface HyperliquidNettingResidualRuntimeJournalPort
extends HyperliquidNettingResidualDurableJournalPort {
  readAttempt(attemptId: string): Promise<HyperliquidNettingResidualJournalReceipt | null>;
}

export interface HyperliquidNettingResidualRuntimeOptions {
  readonly account: HyperliquidSubmissionAccount;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly vaultAddress: `0x${string}` | null;
  readonly maximumEvidenceAgeMs: number;
  readonly maximumSnapshotSkewMs: number;
  readonly maximumFillPages?: number;
  readonly trustedTime: HyperliquidTrustedTimePort;
  readonly clock?: () => number;
}

function requireBoundedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a bounded positive integer`);
  }
  return value;
}

function attemptId(intent: HyperliquidNettingResidualIntent): string {
  return `net-residual-${toHex(intent.intentHash)}`;
}

function checkedNow(clock: () => number): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('runtime clock is invalid');
  return now;
}

function submissionHandoff(
  result: HyperliquidNettingResidualSubmissionResult,
): NonNullable<HyperliquidNettingResidualSubmissionResult['reconciliation']> {
  if (result.reconciliation === null) {
    throw new HyperliquidNettingResidualRuntimeError(
      'SUBMISSION_FAILED',
      `residual submission did not reach reconciliation: ${result.evidenceStatus}`,
    );
  }
  return result.reconciliation;
}

function evidenceWindow(
  journal: HyperliquidNettingResidualJournalReceipt,
  observedAtMs: number,
  options: Readonly<{
    maximumEvidenceAgeMs: number;
    maximumSnapshotSkewMs: number;
    maximumFillPages?: number;
  }>,
): HyperliquidNettingResidualEvidenceCollectInput['window'] {
  if (journal.record.nonce > MAX_SAFE_INTEGER) {
    throw new HyperliquidNettingResidualRuntimeError(
      'JOURNAL_STATE_INVALID', 'residual submission nonce cannot form an evidence window',
    );
  }
  const startTimeMs = Number(journal.record.nonce);
  if (startTimeMs > observedAtMs
    || observedAtMs - startTimeMs > options.maximumEvidenceAgeMs) {
    throw new HyperliquidNettingResidualRuntimeError(
      'EVIDENCE_PENDING', 'residual evidence window is unavailable or stale',
    );
  }
  return Object.freeze({
    startTimeMs,
    endTimeMs: observedAtMs,
    nowMs: observedAtMs,
    maxEvidenceAgeMs: options.maximumEvidenceAgeMs,
    maxSnapshotSkewMs: options.maximumSnapshotSkewMs,
    ...(options.maximumFillPages === undefined
      ? {} : { maxFillPages: options.maximumFillPages }),
  });
}

export class HyperliquidNettingResidualTestnetRuntime {
  readonly #resolver: HyperliquidNettingResidualRuntimeLaneResolver;
  readonly #journal: HyperliquidNettingResidualRuntimeJournalPort;
  readonly #submission: Pick<HyperliquidNettingResidualTestnetSubmissionService, 'submitResidual'>;
  readonly #evidence: HyperliquidNettingResidualRuntimeEvidencePort;
  readonly #options: Readonly<Required<Pick<HyperliquidNettingResidualRuntimeOptions,
  'account' | 'agentWallet' | 'signerLeaseId' | 'vaultAddress'
  | 'maximumEvidenceAgeMs' | 'maximumSnapshotSkewMs'>> &
  Pick<HyperliquidNettingResidualRuntimeOptions, 'maximumFillPages'>>;
  readonly #clock: () => number;
  readonly #trustedTime: HyperliquidTrustedTimePort;

  constructor(
    resolver: HyperliquidNettingResidualRuntimeLaneResolver,
    journal: HyperliquidNettingResidualRuntimeJournalPort,
    submission: Pick<HyperliquidNettingResidualTestnetSubmissionService, 'submitResidual'>,
    evidence: HyperliquidNettingResidualRuntimeEvidencePort,
    options: HyperliquidNettingResidualRuntimeOptions,
  ) {
    if (typeof resolver?.resolve !== 'function' || typeof journal?.submissionContext !== 'function'
      || typeof journal?.readAttempt !== 'function' || typeof submission?.submitResidual !== 'function'
      || typeof evidence?.collect !== 'function') {
      throw new Error('complete Hyperliquid residual runtime ports are required');
    }
    if (typeof options.trustedTime?.decide !== 'function'
      || typeof journal.recordTrustedTimeDecision !== 'function') {
      throw new Error('Hyperliquid residual runtime requires trusted time and durable evidence');
    }
    const maximumEvidenceAgeMs = requireBoundedPositiveInteger(
      options.maximumEvidenceAgeMs, 'maximumEvidenceAgeMs', 86_400_000,
    );
    const maximumSnapshotSkewMs = requireBoundedPositiveInteger(
      options.maximumSnapshotSkewMs, 'maximumSnapshotSkewMs', 60_000,
    );
    const maximumFillPages = options.maximumFillPages === undefined
      ? undefined : requireBoundedPositiveInteger(options.maximumFillPages, 'maximumFillPages', 64);
    this.#resolver = resolver;
    this.#journal = journal;
    this.#submission = submission;
    this.#evidence = evidence;
    this.#options = Object.freeze({
      account: options.account,
      agentWallet: options.agentWallet,
      signerLeaseId: options.signerLeaseId,
      vaultAddress: options.vaultAddress,
      maximumEvidenceAgeMs,
      maximumSnapshotSkewMs,
      ...(maximumFillPages === undefined ? {} : { maximumFillPages }),
    });
    this.#clock = options.clock ?? Date.now;
    this.#trustedTime = options.trustedTime;
  }

  async execute(input: Readonly<{
    intent: NettingExternalExecutionIntent;
    idempotencyKey: string;
  }>): Promise<NettingExternalExecutionEvidence>;
  async execute(input: Readonly<{
    intent: CrossBatchExternalExecutionIntent;
    idempotencyKey: string;
  }>): Promise<CrossBatchExternalExecutionEvidence>;
  async execute(input: Readonly<{
    intent: HyperliquidNettingResidualIntent;
    idempotencyKey: string;
  }>): Promise<HyperliquidNettingResidualEvidence> {
    const expectedKey = toHex(input.intent.intentHash);
    const actualHash = 'clearingPlanHash' in input.intent
      ? crossBatchExternalExecutionIntentHash(input.intent)
      : nettingExternalExecutionIntentHash(input.intent);
    if (input.idempotencyKey !== expectedKey
      || toHex(actualHash) !== expectedKey) {
      throw new HyperliquidNettingResidualRuntimeError(
        'IDEMPOTENCY_MISMATCH', 'residual execution idempotency differs from the intent',
      );
    }
    if (input.intent.domain.domainId !== 'hypercore:testnet'
      || input.intent.validUntilUnit !== 'HYPERLIQUID_UNIX_MILLISECONDS') {
      throw new HyperliquidNettingResidualRuntimeError(
        'UNSUPPORTED_DOMAIN', 'only Hyperliquid Testnet residual intents are executable',
      );
    }
    const id = attemptId(input.intent);
    const lane = this.#resolver.resolve(input.intent);
    const plan: HyperliquidNettingResidualPlan = compileHyperliquidNettingResidualPlan({
      intent: input.intent,
      instrument: lane.instrument,
      binding: lane.marketBinding,
    });
    const existing = await this.#journal.readAttempt(id);
    const timeDecision = existing === null ? await this.#trustedTime.decide(id) : null;
    const nowMs = timeDecision?.selectedTimeMs ?? checkedNow(this.#clock);
    if (existing === null && input.intent.validUntilValue <= BigInt(nowMs)) {
      throw new HyperliquidNettingResidualRuntimeError(
        'INTENT_EXPIRED', 'residual intent expired before durable submission',
      );
    }
    if (timeDecision !== null) {
      this.#journal.recordTrustedTimeDecision(id, timeDecision);
    }
    const context = existing === null
      ? this.#journal.submissionContext({
          account: this.#options.account,
          agentWallet: this.#options.agentWallet,
          signerLeaseId: this.#options.signerLeaseId,
          nowMs: BigInt(nowMs),
          timeDecisionHash: timeDecision!.decisionHash,
        })
      : { expectedVersion: existing.journalVersion, nonce: existing.record.nonce };
    const submissionInput: HyperliquidNettingResidualSubmissionInput = {
      expectedVersion: context.expectedVersion,
      attemptId: id,
      agentWallet: this.#options.agentWallet,
      signerLeaseId: this.#options.signerLeaseId,
      plan,
      account: this.#options.account,
      nonce: context.nonce,
      nowMs: BigInt(nowMs),
      vaultAddress: this.#options.vaultAddress,
    };
    const submission = await this.#submission.submitResidual(submissionInput);
    const handoff = submissionHandoff(submission);
    const persisted = await this.#journal.readAttempt(id);
    if (persisted === null || persisted.record.status !== 'RECONCILING') {
      throw new HyperliquidNettingResidualRuntimeError(
        'JOURNAL_STATE_INVALID', 'residual submission lacks a reconciling journal record',
      );
    }
    const evidenceNowMs = checkedNow(this.#clock);
    const collected = await this.#evidence.collect({
      handoff,
      binding: lane.evidenceBinding,
      plan,
      window: evidenceWindow(persisted, evidenceNowMs, this.#options),
    });
    if (collected.status !== 'COMPLETE') {
      throw new HyperliquidNettingResidualRuntimeError(
        'EVIDENCE_PENDING', `residual terminal evidence is incomplete: ${collected.reasons.join(',')}`,
      );
    }
    return 'clearingPlanHash' in input.intent
      ? hyperliquidNettingResidualEvidence({
          intent: input.intent,
          plan,
          observation: collected.observation,
        })
      : hyperliquidNettingResidualEvidence({
          intent: input.intent,
          plan,
          observation: collected.observation,
        });
  }
}
