import {
  compileEvmTestPerpNettingResidualPlan,
  evmTestPerpNettingResidualEvidence,
  type EvmTestPerpNettingResidualBinding,
  type EvmTestPerpNettingResidualObservation,
  type EvmTestPerpNettingResidualPlan,
} from '@naryx/adapter-evm';
import {
  bytesEqual,
  nettingExternalExecutionIntentHash,
  toHex,
  verifyNettingExternalExecutionEvidence,
  type NettingExternalExecutionEvidence,
  type NettingExternalExecutionIntent,
  type NettingInstrumentPolicy,
} from '@naryx/protocol-types';
import type { Hex } from 'viem';

export type EvmNettingResidualAttemptStatus = 'PREPARED' | 'SIGNED' | 'SUBMITTED' | 'TERMINAL';

export interface EvmNettingResidualAttempt {
  readonly intentHash: string;
  readonly status: EvmNettingResidualAttemptStatus;
  readonly plan: EvmTestPerpNettingResidualPlan;
  readonly rawTransaction?: Hex;
  readonly transactionHash?: Hex;
  readonly transactionNonce?: bigint;
  readonly signedAtSeconds?: bigint;
  readonly submittedAtSeconds?: bigint;
  readonly evidence?: NettingExternalExecutionEvidence;
}

export interface EvmNettingResidualJournalPort {
  read(intentHash: string): Promise<EvmNettingResidualAttempt | null>;
  prepare(input: Readonly<{
    intentHash: string;
    plan: EvmTestPerpNettingResidualPlan;
  }>): Promise<EvmNettingResidualAttempt>;
  recordSigned(input: Readonly<{
    intentHash: string;
    rawTransaction: Hex;
    transactionHash: Hex;
    transactionNonce: bigint;
    signedAtSeconds: bigint;
  }>): Promise<EvmNettingResidualAttempt>;
  recordSubmitted(input: Readonly<{
    intentHash: string;
    transactionHash: Hex;
    submittedAtSeconds: bigint;
  }>): Promise<EvmNettingResidualAttempt>;
  recordTerminal(input: Readonly<{
    intentHash: string;
    evidence: NettingExternalExecutionEvidence;
  }>): Promise<EvmNettingResidualAttempt>;
}

export interface EvmNettingResidualChainPort {
  readonly account: `0x${string}`;
  chainId(): Promise<number>;
  currentTimeSeconds(): Promise<bigint>;
  sign(input: Readonly<{
    plan: EvmTestPerpNettingResidualPlan;
  }>): Promise<Readonly<{
    rawTransaction: Hex;
    transactionHash: Hex;
    transactionNonce: bigint;
    signedAtSeconds: bigint;
  }>>;
  broadcast(rawTransaction: Hex, expectedTransactionHash: Hex): Promise<Hex>;
  observe(input: Readonly<{
    plan: EvmTestPerpNettingResidualPlan;
    transactionHash: Hex;
    submittedAtSeconds: bigint;
  }>): Promise<EvmTestPerpNettingResidualObservation | null>;
}

export interface EvmNettingResidualRuntimeLane {
  readonly instrument: NettingInstrumentPolicy;
  readonly binding: EvmTestPerpNettingResidualBinding;
  readonly marginQuoteAtoms: bigint;
}

export interface EvmNettingResidualRuntimeLaneResolver {
  resolve(intent: NettingExternalExecutionIntent): EvmNettingResidualRuntimeLane;
}

export type EvmNettingResidualRuntimeErrorCode =
  | 'IDEMPOTENCY_MISMATCH'
  | 'UNSUPPORTED_DOMAIN'
  | 'INTENT_EXPIRED'
  | 'CHAIN_IDENTITY_MISMATCH'
  | 'EXECUTION_ACCOUNT_MISMATCH'
  | 'JOURNAL_STATE_INVALID'
  | 'EVIDENCE_PENDING';

export class EvmNettingResidualRuntimeError extends Error {
  readonly code: EvmNettingResidualRuntimeErrorCode;

  constructor(code: EvmNettingResidualRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'EvmNettingResidualRuntimeError';
    this.code = code;
  }
}

function requireCondition(condition: boolean, code: EvmNettingResidualRuntimeErrorCode, message: string): asserts condition {
  if (!condition) throw new EvmNettingResidualRuntimeError(code, message);
}

function samePlan(left: EvmTestPerpNettingResidualPlan, right: EvmTestPerpNettingResidualPlan): boolean {
  return left.version === right.version
    && left.guarantee === right.guarantee
    && bytesEqual(left.intentHash, right.intentHash)
    && bytesEqual(left.instrumentHash, right.instrumentHash)
    && left.executionId.toLowerCase() === right.executionId.toLowerCase()
    && left.executionAccount.toLowerCase() === right.executionAccount.toLowerCase()
    && left.transaction.chainId === right.transaction.chainId
    && left.transaction.to.toLowerCase() === right.transaction.to.toLowerCase()
    && left.transaction.data.toLowerCase() === right.transaction.data.toLowerCase()
    && left.requestExpirySeconds === right.requestExpirySeconds;
}

export class EvmTestPerpNettingResidualRuntime {
  readonly #resolver: EvmNettingResidualRuntimeLaneResolver;
  readonly #journal: EvmNettingResidualJournalPort;
  readonly #chain: EvmNettingResidualChainPort;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    resolver: EvmNettingResidualRuntimeLaneResolver,
    journal: EvmNettingResidualJournalPort,
    chain: EvmNettingResidualChainPort,
  ) {
    if (typeof resolver?.resolve !== 'function' || typeof journal?.read !== 'function'
      || typeof journal?.prepare !== 'function' || typeof journal?.recordSigned !== 'function'
      || typeof journal?.recordSubmitted !== 'function' || typeof journal?.recordTerminal !== 'function'
      || typeof chain?.chainId !== 'function' || typeof chain?.currentTimeSeconds !== 'function'
      || typeof chain?.sign !== 'function' || typeof chain?.broadcast !== 'function'
      || typeof chain?.observe !== 'function') {
      throw new Error('complete EVM residual runtime ports are required');
    }
    this.#resolver = resolver;
    this.#journal = journal;
    this.#chain = chain;
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
    'IDEMPOTENCY_MISMATCH', 'Base residual idempotency differs from the canonical intent');
    requireCondition(input.intent.domain.domainId === 'eip155:84532'
      && input.intent.validUntilUnit === 'EVM_UNIX_SECONDS',
    'UNSUPPORTED_DOMAIN', 'only Base Sepolia EVM residual intents are executable');
    const lane = this.#resolver.resolve(input.intent);
    const plan = compileEvmTestPerpNettingResidualPlan({
      intent: input.intent,
      instrument: lane.instrument,
      binding: lane.binding,
      marginQuoteAtoms: lane.marginQuoteAtoms,
    });
    requireCondition(this.#chain.account.toLowerCase() === plan.executionAccount.toLowerCase(),
      'EXECUTION_ACCOUNT_MISMATCH', 'Base residual signer differs from the bound execution account');
    requireCondition(await this.#chain.chainId() === plan.transaction.chainId,
      'CHAIN_IDENTITY_MISMATCH', 'Base residual RPC reports another chain');

    let attempt = await this.#journal.read(expectedKey);
    if (attempt === null) {
      requireCondition(await this.#chain.currentTimeSeconds() < input.intent.validUntilValue,
        'INTENT_EXPIRED', 'Base residual intent expired before durable preparation');
      attempt = await this.#journal.prepare({ intentHash: expectedKey, plan });
    }
    requireCondition(samePlan(attempt.plan, plan), 'JOURNAL_STATE_INVALID',
      'Base residual replay changed its immutable plan');
    if (attempt.status === 'TERMINAL') {
      requireCondition(attempt.evidence !== undefined, 'JOURNAL_STATE_INVALID',
        'terminal Base residual lacks evidence');
      verifyNettingExternalExecutionEvidence(attempt.evidence, input.intent);
      return attempt.evidence;
    }
    if (attempt.status === 'PREPARED') {
      const signed = await this.#chain.sign({ plan });
      requireCondition(signed.signedAtSeconds < plan.requestExpirySeconds,
        'INTENT_EXPIRED', 'Base residual expired before transaction signing');
      attempt = await this.#journal.recordSigned({ intentHash: expectedKey, ...signed });
    }
    requireCondition(attempt.rawTransaction !== undefined && attempt.transactionHash !== undefined
      && attempt.signedAtSeconds !== undefined, 'JOURNAL_STATE_INVALID',
    'Base residual signed transaction is incomplete');
    if (attempt.status === 'SIGNED') {
      const broadcastHash = await this.#chain.broadcast(attempt.rawTransaction, attempt.transactionHash);
      requireCondition(broadcastHash.toLowerCase() === attempt.transactionHash.toLowerCase(),
        'JOURNAL_STATE_INVALID', 'Base RPC returned another transaction hash');
      attempt = await this.#journal.recordSubmitted({
        intentHash: expectedKey,
        transactionHash: attempt.transactionHash,
        submittedAtSeconds: attempt.signedAtSeconds,
      });
    }
    requireCondition(attempt.status === 'SUBMITTED' && attempt.transactionHash !== undefined
      && attempt.submittedAtSeconds !== undefined, 'JOURNAL_STATE_INVALID',
    'Base residual is not ready for receipt reconciliation');
    const observation = await this.#chain.observe({
      plan,
      transactionHash: attempt.transactionHash,
      submittedAtSeconds: attempt.submittedAtSeconds,
    });
    requireCondition(observation !== null, 'EVIDENCE_PENDING',
      'Base residual transaction is not final yet');
    const evidence = evmTestPerpNettingResidualEvidence({ intent: input.intent, plan, observation });
    verifyNettingExternalExecutionEvidence(evidence, input.intent);
    attempt = await this.#journal.recordTerminal({ intentHash: expectedKey, evidence });
    requireCondition(attempt.status === 'TERMINAL' && attempt.evidence !== undefined,
      'JOURNAL_STATE_INVALID', 'Base residual terminal evidence was not persisted');
    return attempt.evidence;
  }
}
