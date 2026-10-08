import { createHash } from 'node:crypto';
import {
  compileSolanaTestPerpNettingResidualPlan,
  solanaTestPerpNettingResidualEvidence,
  type SolanaTestPerpNettingResidualBinding,
  type SolanaTestPerpNettingResidualObservation,
  type SolanaTestPerpNettingResidualPlan,
} from '@naryx/adapter-solana';
import {
  bytesEqual,
  nettingExternalExecutionIntentHash,
  toHex,
  verifyNettingExternalExecutionEvidence,
  type NettingExternalExecutionEvidence,
  type NettingExternalExecutionIntent,
  type NettingInstrumentPolicy,
} from '@naryx/protocol-types';

export type SolanaNettingResidualIntentStatus = 'PREPARED' | 'ACTIVE' | 'TERMINAL';
export type SolanaNettingResidualSubmissionStatus = 'SIGNED' | 'SUBMITTED' | 'EXPIRED';

export interface SolanaNettingResidualSubmission {
  readonly attemptNumber: number;
  readonly status: SolanaNettingResidualSubmissionStatus;
  readonly rawTransactionBase64: string;
  readonly signature: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly signedAtSlot: bigint;
  readonly submittedAtSlot?: bigint;
  readonly expiredAtBlockHeight?: bigint;
}

export interface SolanaNettingResidualAttempt {
  readonly intentHash: string;
  readonly status: SolanaNettingResidualIntentStatus;
  readonly plan: SolanaTestPerpNettingResidualPlan;
  readonly submissions: readonly SolanaNettingResidualSubmission[];
  readonly evidence?: NettingExternalExecutionEvidence;
}

export interface SolanaNettingResidualJournalPort {
  read(intentHash: string): Promise<SolanaNettingResidualAttempt | null>;
  prepare(input: Readonly<{
    intentHash: string;
    plan: SolanaTestPerpNettingResidualPlan;
  }>): Promise<SolanaNettingResidualAttempt>;
  recordSigned(input: Readonly<{
    intentHash: string;
    rawTransactionBase64: string;
    signature: string;
    recentBlockhash: string;
    lastValidBlockHeight: bigint;
    signedAtSlot: bigint;
  }>): Promise<SolanaNettingResidualAttempt>;
  recordSubmitted(input: Readonly<{
    intentHash: string;
    signature: string;
    submittedAtSlot: bigint;
  }>): Promise<SolanaNettingResidualAttempt>;
  recordExpired(input: Readonly<{
    intentHash: string;
    signature: string;
    expiredAtBlockHeight: bigint;
  }>): Promise<SolanaNettingResidualAttempt>;
  recordTerminal(input: Readonly<{
    intentHash: string;
    evidence: NettingExternalExecutionEvidence;
  }>): Promise<SolanaNettingResidualAttempt>;
}

export type SolanaNettingResidualChainObservation = Readonly<
  | { status: 'PENDING'; currentBlockHeight: bigint }
  | { status: 'EXPIRED_UNSEEN'; currentBlockHeight: bigint; observation: SolanaTestPerpNettingResidualObservation }
  | { status: 'TERMINAL'; observation: SolanaTestPerpNettingResidualObservation }
>;

export interface SolanaNettingResidualChainPort {
  readonly account: string;
  genesisHash(): Promise<string>;
  currentSlot(): Promise<bigint>;
  sign(input: Readonly<{
    plan: SolanaTestPerpNettingResidualPlan;
  }>): Promise<Readonly<{
    rawTransactionBase64: string;
    signature: string;
    recentBlockhash: string;
    lastValidBlockHeight: bigint;
    signedAtSlot: bigint;
  }>>;
  broadcast(rawTransactionBase64: string, expectedSignature: string): Promise<string>;
  observe(input: Readonly<{
    plan: SolanaTestPerpNettingResidualPlan;
    submission: SolanaNettingResidualSubmission;
  }>): Promise<SolanaNettingResidualChainObservation>;
}

export interface SolanaNettingResidualRuntimeLane {
  readonly instrument: NettingInstrumentPolicy;
  readonly binding: SolanaTestPerpNettingResidualBinding;
}

export interface SolanaNettingResidualRuntimeLaneResolver {
  resolve(intent: NettingExternalExecutionIntent): SolanaNettingResidualRuntimeLane;
}

export type SolanaNettingResidualRuntimeErrorCode =
  | 'IDEMPOTENCY_MISMATCH'
  | 'UNSUPPORTED_DOMAIN'
  | 'INTENT_EXPIRED'
  | 'CHAIN_IDENTITY_MISMATCH'
  | 'EXECUTION_ACCOUNT_MISMATCH'
  | 'JOURNAL_STATE_INVALID'
  | 'EVIDENCE_PENDING';

export class SolanaNettingResidualRuntimeError extends Error {
  readonly code: SolanaNettingResidualRuntimeErrorCode;

  constructor(code: SolanaNettingResidualRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'SolanaNettingResidualRuntimeError';
    this.code = code;
  }
}

const SOLANA_DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

function u64be(value: bigint): Buffer {
  if (value < 0n || value > (1n << 64n) - 1n) {
    throw new Error('Solana residual evidence integer exceeds u64');
  }
  const result = Buffer.allocUnsafe(8);
  result.writeBigUInt64BE(value);
  return result;
}

function digest(domain: string, values: readonly Uint8Array[]): Uint8Array {
  const hash = createHash('sha256').update(domain, 'ascii');
  for (const value of values) hash.update(value);
  return new Uint8Array(hash.digest());
}

function requireCondition(
  condition: boolean,
  code: SolanaNettingResidualRuntimeErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new SolanaNettingResidualRuntimeError(code, message);
}

function samePlan(left: SolanaTestPerpNettingResidualPlan, right: SolanaTestPerpNettingResidualPlan): boolean {
  return left.version === right.version
    && left.guarantee === right.guarantee
    && bytesEqual(left.intentHash, right.intentHash)
    && bytesEqual(left.instrumentHash, right.instrumentHash)
    && left.executionAccount === right.executionAccount
    && left.receiptAddress === right.receiptAddress
    && left.requestedSignedQuantityAtoms === right.requestedSignedQuantityAtoms
    && left.baseLots === right.baseLots
    && left.limitPriceTicks === right.limitPriceTicks
    && left.reduceOnly === right.reduceOnly
    && left.maximumFeeQuoteAtoms === right.maximumFeeQuoteAtoms
    && left.requestExpirySlot === right.requestExpirySlot
    && left.instruction.programId.equals(right.instruction.programId)
    && left.instruction.data.equals(right.instruction.data)
    && left.instruction.keys.length === right.instruction.keys.length
    && left.instruction.keys.every((account, index) => {
      const expected = right.instruction.keys[index]!;
      return account.pubkey.equals(expected.pubkey)
        && account.isSigner === expected.isSigner
        && account.isWritable === expected.isWritable;
    });
}

function activeSubmission(attempt: SolanaNettingResidualAttempt): SolanaNettingResidualSubmission | undefined {
  const active = attempt.submissions.filter((submission) => submission.status !== 'EXPIRED');
  requireCondition(active.length <= 1, 'JOURNAL_STATE_INVALID',
    'Solana residual has multiple active submissions');
  return active[0];
}

export class SolanaTestPerpNettingResidualRuntime {
  readonly #resolver: SolanaNettingResidualRuntimeLaneResolver;
  readonly #journal: SolanaNettingResidualJournalPort;
  readonly #chain: SolanaNettingResidualChainPort;
  readonly #maximumSubmissionAttempts: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    resolver: SolanaNettingResidualRuntimeLaneResolver,
    journal: SolanaNettingResidualJournalPort,
    chain: SolanaNettingResidualChainPort,
    maximumSubmissionAttempts = 3,
  ) {
    if (typeof resolver?.resolve !== 'function' || typeof journal?.read !== 'function'
      || typeof journal?.prepare !== 'function' || typeof journal?.recordSigned !== 'function'
      || typeof journal?.recordSubmitted !== 'function' || typeof journal?.recordExpired !== 'function'
      || typeof journal?.recordTerminal !== 'function' || typeof chain?.genesisHash !== 'function'
      || typeof chain?.currentSlot !== 'function' || typeof chain?.sign !== 'function'
      || typeof chain?.broadcast !== 'function' || typeof chain?.observe !== 'function') {
      throw new Error('complete Solana residual runtime ports are required');
    }
    if (!Number.isSafeInteger(maximumSubmissionAttempts)
      || maximumSubmissionAttempts < 1 || maximumSubmissionAttempts > 16) {
      throw new Error('Solana residual submission-attempt limit must be between 1 and 16');
    }
    this.#resolver = resolver;
    this.#journal = journal;
    this.#chain = chain;
    this.#maximumSubmissionAttempts = maximumSubmissionAttempts;
  }

  async execute(input: Readonly<{
    intent: NettingExternalExecutionIntent;
    idempotencyKey: string;
  }>): Promise<NettingExternalExecutionEvidence> {
    const preceding = this.#queue;
    let release = (): void => undefined;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await preceding;
    try {
      return await this.#execute(input);
    } finally {
      release();
    }
  }

  async #execute(input: Readonly<{
    intent: NettingExternalExecutionIntent;
    idempotencyKey: string;
  }>): Promise<NettingExternalExecutionEvidence> {
    const expectedKey = toHex(input.intent.intentHash);
    requireCondition(input.idempotencyKey === expectedKey
      && toHex(nettingExternalExecutionIntentHash(input.intent)) === expectedKey,
    'IDEMPOTENCY_MISMATCH', 'Solana residual idempotency differs from the canonical intent');
    requireCondition(input.intent.domain.domainId === 'svm:devnet'
      && input.intent.validUntilUnit === 'SOLANA_SLOT',
    'UNSUPPORTED_DOMAIN', 'only Solana Devnet residual intents are executable');
    const lane = this.#resolver.resolve(input.intent);
    const plan = compileSolanaTestPerpNettingResidualPlan({
      intent: input.intent,
      instrument: lane.instrument,
      binding: lane.binding,
    });
    requireCondition(this.#chain.account === plan.executionAccount,
      'EXECUTION_ACCOUNT_MISMATCH', 'Solana residual signer differs from the bound execution account');
    requireCondition(await this.#chain.genesisHash() === SOLANA_DEVNET_GENESIS_HASH,
      'CHAIN_IDENTITY_MISMATCH', 'Solana residual RPC reports another chain');

    let attempt = await this.#journal.read(expectedKey);
    if (attempt === null) {
      requireCondition(await this.#chain.currentSlot() < input.intent.validUntilValue,
        'INTENT_EXPIRED', 'Solana residual intent expired before durable preparation');
      attempt = await this.#journal.prepare({ intentHash: expectedKey, plan });
    }
    requireCondition(samePlan(attempt.plan, plan), 'JOURNAL_STATE_INVALID',
      'Solana residual replay changed its immutable plan');
    if (attempt.status === 'TERMINAL') {
      requireCondition(attempt.evidence !== undefined, 'JOURNAL_STATE_INVALID',
        'terminal Solana residual lacks evidence');
      verifyNettingExternalExecutionEvidence(attempt.evidence, input.intent);
      return attempt.evidence;
    }

    for (;;) {
      let submission = activeSubmission(attempt);
      if (submission === undefined) {
        requireCondition(attempt.status === 'PREPARED', 'JOURNAL_STATE_INVALID',
          'Solana residual without an active submission is not prepared');
        const slot = await this.#chain.currentSlot();
        if (slot >= input.intent.validUntilValue) {
          const latest = attempt.submissions.at(-1);
          requireCondition(latest !== undefined && latest.status === 'EXPIRED',
            'INTENT_EXPIRED', 'Solana residual expired before any submission could be signed');
          return await this.#recordTerminal(input.intent, attempt, expiredObservation(plan, latest, slot));
        }
        requireCondition(attempt.submissions.length < this.#maximumSubmissionAttempts,
          'EVIDENCE_PENDING', 'Solana residual exhausted its bounded submission attempts');
        const signed = await this.#chain.sign({ plan });
        requireCondition(signed.signedAtSlot < plan.requestExpirySlot,
          'INTENT_EXPIRED', 'Solana residual expired before transaction signing');
        attempt = await this.#journal.recordSigned({ intentHash: expectedKey, ...signed });
        submission = activeSubmission(attempt);
      }
      requireCondition(submission !== undefined, 'JOURNAL_STATE_INVALID',
        'Solana residual signed submission is absent');
      if (submission.status === 'SIGNED') {
        const signature = await this.#chain.broadcast(
          submission.rawTransactionBase64,
          submission.signature,
        );
        requireCondition(signature === submission.signature, 'JOURNAL_STATE_INVALID',
          'Solana RPC returned another transaction signature');
        attempt = await this.#journal.recordSubmitted({
          intentHash: expectedKey,
          signature,
          submittedAtSlot: submission.signedAtSlot,
        });
        submission = activeSubmission(attempt);
      }
      requireCondition(submission?.status === 'SUBMITTED', 'JOURNAL_STATE_INVALID',
        'Solana residual is not ready for receipt reconciliation');
      const observed = await this.#chain.observe({ plan, submission });
      if (observed.status === 'TERMINAL') {
        return await this.#recordTerminal(input.intent, attempt, observed.observation);
      }
      if (observed.status === 'EXPIRED_UNSEEN') {
        attempt = await this.#journal.recordExpired({
          intentHash: expectedKey,
          signature: submission.signature,
          expiredAtBlockHeight: observed.currentBlockHeight,
        });
        if (observed.observation.observedAtSlot >= input.intent.validUntilValue) {
          return await this.#recordTerminal(input.intent, attempt, observed.observation);
        }
        continue;
      }
      await this.#chain.broadcast(submission.rawTransactionBase64, submission.signature);
      throw new SolanaNettingResidualRuntimeError(
        'EVIDENCE_PENDING',
        'Solana residual transaction is not final yet',
      );
    }
  }

  async #recordTerminal(
    intent: NettingExternalExecutionIntent,
    attempt: SolanaNettingResidualAttempt,
    observation: SolanaTestPerpNettingResidualObservation,
  ): Promise<NettingExternalExecutionEvidence> {
    const evidence = solanaTestPerpNettingResidualEvidence({ intent, plan: attempt.plan, observation });
    verifyNettingExternalExecutionEvidence(evidence, intent);
    const stored = await this.#journal.recordTerminal({
      intentHash: attempt.intentHash,
      evidence,
    });
    requireCondition(stored.status === 'TERMINAL' && stored.evidence !== undefined,
      'JOURNAL_STATE_INVALID', 'Solana residual terminal evidence was not persisted');
    return stored.evidence;
  }
}

function expiredObservation(
  plan: SolanaTestPerpNettingResidualPlan,
  submission: SolanaNettingResidualSubmission,
  observedAtSlot: bigint,
): SolanaTestPerpNettingResidualObservation {
  requireCondition(submission.expiredAtBlockHeight !== undefined,
    'JOURNAL_STATE_INVALID', 'expired Solana submission lacks its observed block height');
  const signature = Buffer.from(submission.signature, 'ascii');
  const executionReferenceHash = digest('NARYX/solana-netting-residual/signature-text/v1', [signature]);
  const authoritativeEvidenceHash = digest('NARYX/solana-netting-residual/expired-intent/v1', [
    signature,
    u64be(submission.lastValidBlockHeight),
    u64be(submission.expiredAtBlockHeight),
    u64be(observedAtSlot),
  ]);
  return Object.freeze({
    intentHash: plan.intentHash,
    authority: plan.executionAccount,
    market: plan.instruction.keys[1]!.pubkey,
    position: plan.instruction.keys[2]!.pubkey,
    terminalStatus: 'REJECTED' as const,
    side: plan.side,
    baseLots: 0n,
    fillPricePerLot: 0n,
    grossQuoteAtoms: 0n,
    feeQuoteAtoms: 0n,
    executionSlot: 0n,
    submittedAtSlot: submission.submittedAtSlot ?? submission.signedAtSlot,
    observedAtSlot,
    executionReferenceHash,
    authoritativeEvidenceHash,
  });
}
