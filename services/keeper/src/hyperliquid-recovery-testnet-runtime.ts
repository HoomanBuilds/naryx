import { createHash } from 'node:crypto';
import { AbstractWalletError, TESTNET_API_URL, ValidationError } from '@nktkas/hyperliquid';
import { ApiRequestError } from '@nktkas/hyperliquid/api/exchange';
import type {
  HypercoreBatchedOrderAction,
  HyperliquidTrustedTimeDecision,
} from '@naryx/adapter-hyperliquid';
import type { HyperliquidPackageAttempt } from './index.js';
import type { HyperliquidRecoveryExecutionPlan } from './hyperliquid-recovery-compiler.js';
import {
  acknowledgeHyperliquidRecoverySubmission,
  confirmHyperliquidRecoveryDurableRecord,
  createHyperliquidRecoverySubmissionJournal,
  hyperliquidRecoveryReconciliationHandoff,
  markHyperliquidRecoverySubmittedUnknown,
  prepareHyperliquidRecoverySubmission,
  rejectHyperliquidRecoverySubmission,
  registerHyperliquidRecoveryAgent,
  type HyperliquidRecoveryReconciliationHandoff,
  type HyperliquidRecoverySubmissionJournal,
  type HyperliquidRecoverySubmissionRecord,
} from './hyperliquid-recovery-submission-journal.js';
import {
  HyperliquidRecoverySqliteStore,
  type HyperliquidRecoveryJournalSnapshot,
} from './hyperliquid-recovery-store.js';
import type { HyperliquidRecoveryVerifierIdentity } from './hyperliquid-recovery-validation.js';

export const HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL =
  TESTNET_API_URL;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export interface HyperliquidRecoveryTrustedTimePort {
  decide(scope: string): Promise<HyperliquidTrustedTimeDecision>;
}

export interface HyperliquidRecoveryTestnetSubmitter {
  readonly environment: 'testnet';
  readonly apiUrl: typeof HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL;
  signerAddress(): Promise<`0x${string}`>;
  submit(input: Readonly<{
    action: HypercoreBatchedOrderAction;
    nonce: bigint;
    expiresAfterMs: bigint;
    vaultAddress: `0x${string}` | null;
  }>): Promise<Readonly<{ acknowledgementId: string }>>;
}

export type HyperliquidRecoveryRuntimeResult = Readonly<{
  status: 'ACKNOWLEDGED' | 'SUBMISSION_REJECTED'
    | 'SUBMISSION_AMBIGUOUS' | 'RECONCILIATION_REQUIRED';
  handoff: HyperliquidRecoveryReconciliationHandoff;
  errorCommitment: `0x${string}` | null;
}>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Hyperliquid recovery runtime failed: ${message}`);
}

function address(value: string, name: string): `0x${string}` {
  const normalized = value.toLowerCase();
  requireCondition(ADDRESS.test(normalized), `${name} is invalid`);
  return normalized as `0x${string}`;
}

function errorCommitment(error: unknown): `0x${string}` {
  const value = error instanceof Error
    ? [error.name, error.message]
    : ['UnknownError', String(error)];
  return `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function record(
  journal: HyperliquidRecoverySubmissionJournal,
  recoveryAttemptId: string,
): HyperliquidRecoverySubmissionRecord | undefined {
  return journal.agents.flatMap((agent) => agent.attempts)
    .find((attempt) => attempt.recoveryAttemptId === recoveryAttemptId);
}

function persist(
  store: HyperliquidRecoverySqliteStore,
  current: HyperliquidRecoveryJournalSnapshot,
  next: HyperliquidRecoverySubmissionJournal,
): HyperliquidRecoveryJournalSnapshot {
  return store.persist(current.revision, next);
}

export function initializeHyperliquidRecoveryJournal(input: Readonly<{
  store: HyperliquidRecoverySqliteStore;
  verifierIdentity: HyperliquidRecoveryVerifierIdentity;
  agentWallet: `0x${string}`;
  signerLeaseId: string;
}>): HyperliquidRecoveryJournalSnapshot {
  const agentWallet = address(input.agentWallet, 'agentWallet');
  const expected = createHyperliquidRecoverySubmissionJournal(input.verifierIdentity);
  const current = input.store.read();
  if (current === null) {
    const initialized = registerHyperliquidRecoveryAgent(expected, {
      expectedVersion: expected.version,
      agentWallet,
      signerLeaseId: input.signerLeaseId,
    });
    return input.store.persist(null, initialized);
  }
  requireCondition(current.journal.verifierIdentityHash === expected.verifierIdentityHash,
    'stored verifier identity differs');
  const agent = current.journal.agents.find((entry) => entry.agentWallet === agentWallet);
  if (agent !== undefined) {
    requireCondition(agent.signerLeaseId === input.signerLeaseId,
      'stored signer lease differs');
    return current;
  }
  const registered = registerHyperliquidRecoveryAgent(current.journal, {
    expectedVersion: current.journal.version,
    agentWallet,
    signerLeaseId: input.signerLeaseId,
  });
  return persist(input.store, current, registered);
}

export class HyperliquidRecoveryTestnetRuntime {
  readonly #store: HyperliquidRecoverySqliteStore;
  readonly #trustedTime: HyperliquidRecoveryTrustedTimePort;
  readonly #submitter: HyperliquidRecoveryTestnetSubmitter;
  readonly #agentWallet: `0x${string}`;
  readonly #signerLeaseId: string;
  readonly #vaultAddress: `0x${string}` | null;

  constructor(input: Readonly<{
    store: HyperliquidRecoverySqliteStore;
    trustedTime: HyperliquidRecoveryTrustedTimePort;
    submitter: HyperliquidRecoveryTestnetSubmitter;
    agentWallet: `0x${string}`;
    signerLeaseId: string;
    vaultAddress: `0x${string}` | null;
  }>) {
    requireCondition(typeof input.trustedTime?.decide === 'function', 'trusted time is required');
    requireCondition(typeof input.submitter?.signerAddress === 'function'
      && typeof input.submitter.submit === 'function'
      && input.submitter.environment === 'testnet'
      && input.submitter.apiUrl === HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL,
    'exact Hyperliquid Testnet submitter is required');
    requireCondition(typeof input.signerLeaseId === 'string'
      && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.signerLeaseId),
    'signer lease is invalid');
    this.#store = input.store;
    this.#trustedTime = input.trustedTime;
    this.#submitter = input.submitter;
    this.#agentWallet = address(input.agentWallet, 'agentWallet');
    this.#signerLeaseId = input.signerLeaseId;
    this.#vaultAddress = input.vaultAddress === null
      ? null
      : address(input.vaultAddress, 'vaultAddress');
  }

  async execute(input: Readonly<{
    recoveryAttemptId: string;
    sourceAttempt: HyperliquidPackageAttempt;
    plan: HyperliquidRecoveryExecutionPlan;
  }>): Promise<HyperliquidRecoveryRuntimeResult> {
    const signerAddress = address(await this.#submitter.signerAddress(), 'submitter signer');
    requireCondition(signerAddress === this.#agentWallet, 'submitter signer differs from the recovery agent');
    let snapshot = this.#store.read();
    requireCondition(snapshot !== null, 'recovery journal is not initialized');
    let attempt = record(snapshot.journal, input.recoveryAttemptId);
    if (attempt === undefined) {
      const decision = await this.#trustedTime.decide(input.recoveryAttemptId);
      const prepared = prepareHyperliquidRecoverySubmission(snapshot.journal, {
        expectedVersion: snapshot.journal.version,
        recoveryAttemptId: input.recoveryAttemptId,
        agentWallet: this.#agentWallet,
        signerLeaseId: this.#signerLeaseId,
        sourceAttempt: input.sourceAttempt,
        plan: input.plan,
        trustedTimeDecision: decision,
        vaultAddress: this.#vaultAddress,
      });
      snapshot = persist(this.#store, snapshot, prepared);
      attempt = record(snapshot.journal, input.recoveryAttemptId)!;
    }
    if (attempt.status === 'PREPARED') {
      const confirmed = confirmHyperliquidRecoveryDurableRecord(snapshot.journal, {
        expectedVersion: snapshot.journal.version,
        recoveryAttemptId: attempt.recoveryAttemptId,
        recordHash: attempt.recordHash,
        durableRevision: snapshot.revision,
      });
      snapshot = persist(this.#store, snapshot, confirmed);
      attempt = record(snapshot.journal, input.recoveryAttemptId)!;
    }
    if (attempt.status !== 'DURABLE_RECORD_CONFIRMED') {
      return Object.freeze({
        status: 'RECONCILIATION_REQUIRED',
        handoff: hyperliquidRecoveryReconciliationHandoff(
          snapshot.journal,
          input.recoveryAttemptId,
        ),
        errorCommitment: null,
      });
    }
    const submissionDecision = await this.#trustedTime.decide(`${input.recoveryAttemptId}:submit`);
    const marked = markHyperliquidRecoverySubmittedUnknown(snapshot.journal, {
      expectedVersion: snapshot.journal.version,
      recoveryAttemptId: input.recoveryAttemptId,
      trustedTimeDecision: submissionDecision,
    });
    snapshot = persist(this.#store, snapshot, marked);
    attempt = record(snapshot.journal, input.recoveryAttemptId)!;
    try {
      const response = await this.#submitter.submit({
        action: attempt.action,
        nonce: attempt.nonce,
        expiresAfterMs: attempt.expiresAfterMs,
        vaultAddress: attempt.vaultAddress,
      });
      const acknowledged = acknowledgeHyperliquidRecoverySubmission(snapshot.journal, {
        expectedVersion: snapshot.journal.version,
        recoveryAttemptId: attempt.recoveryAttemptId,
        acknowledgementId: response.acknowledgementId,
      });
      snapshot = persist(this.#store, snapshot, acknowledged);
      return Object.freeze({
        status: 'ACKNOWLEDGED',
        handoff: hyperliquidRecoveryReconciliationHandoff(snapshot.journal, input.recoveryAttemptId),
        errorCommitment: null,
      });
    } catch (error) {
      if (error instanceof ApiRequestError
        || error instanceof AbstractWalletError
        || error instanceof ValidationError) {
        const rejectionId = errorCommitment(error);
        try {
          const rejected = rejectHyperliquidRecoverySubmission(snapshot.journal, {
            expectedVersion: snapshot.journal.version,
            recoveryAttemptId: attempt.recoveryAttemptId,
            rejectionId,
          });
          snapshot = persist(this.#store, snapshot, rejected);
          return Object.freeze({
            status: 'SUBMISSION_REJECTED',
            handoff: hyperliquidRecoveryReconciliationHandoff(
              snapshot.journal,
              input.recoveryAttemptId,
            ),
            errorCommitment: rejectionId,
          });
        } catch (journalError) {
          return Object.freeze({
            status: 'SUBMISSION_AMBIGUOUS',
            handoff: hyperliquidRecoveryReconciliationHandoff(
              snapshot.journal,
              input.recoveryAttemptId,
            ),
            errorCommitment: errorCommitment([
              rejectionId,
              errorCommitment(journalError),
            ]),
          });
        }
      }
      return Object.freeze({
        status: 'SUBMISSION_AMBIGUOUS',
        handoff: hyperliquidRecoveryReconciliationHandoff(snapshot.journal, input.recoveryAttemptId),
        errorCommitment: errorCommitment(error),
      });
    }
  }
}
