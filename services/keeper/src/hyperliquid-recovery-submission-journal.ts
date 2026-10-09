import { createHash } from 'node:crypto';
import {
  allocateHyperliquidTrustedNonce,
  requireHyperliquidTrustedTimeDecision,
  type HyperliquidTrustedTimeDecision,
} from '@naryx/adapter-hyperliquid';
import { manifestHash, protocolId } from '@naryx/protocol-types';
import type { HyperliquidPackageAttempt } from './index.js';
import type {
  HypercoreRecoveryOrderAction,
  HyperliquidRecoveryExecutionPlan,
} from './hyperliquid-recovery-compiler.js';
import type { HyperliquidRecoveryAttempt } from './hyperliquid-recovery-reconciliation.js';
import {
  validateHyperliquidRecoveryContinuationExecutionPlan,
  validateHyperliquidRecoveryExecutionPlan,
  type HyperliquidRecoveryVerifierIdentity,
} from './hyperliquid-recovery-validation.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TWO_DAYS_MS = 172_800n * 1_000n;
const ONE_DAY_MS = 86_400n * 1_000n;

export const NARYX_HYPERCORE_RECOVERY_ACTION_COMMITMENT_SCHEME =
  'NARYX_CANONICAL_HYPERCORE_RECOVERY_ACTION_SHA256_V1';
export const HYPERLIQUID_RECOVERY_NONCE_POLICY =
  'STRICTLY_INCREASING_PER_RECOVERY_AGENT_WALLET';
export const HYPERLIQUID_RECOVERY_SEQUENCE_POLICY =
  'STRICTLY_INCREASING_PER_RECOVERY_AGENT_WALLET';

export type HyperliquidRecoverySubmissionStatus =
  | 'PREPARED'
  | 'DURABLE_RECORD_CONFIRMED'
  | 'SUBMITTED_UNKNOWN'
  | 'ACKNOWLEDGED'
  | 'REJECTED'
  | 'RECONCILING'
  | 'RECONCILED'
  | 'FENCED';

export interface HyperliquidRecoverySubmissionRecord {
  readonly recoveryAttemptId: string;
  readonly recoveryLineageKey: `0x${string}`;
  readonly recoveryKey: `0x${string}`;
  readonly status: HyperliquidRecoverySubmissionStatus;
  readonly account: HyperliquidRecoveryExecutionPlan['account'];
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly nonce: bigint;
  readonly trustedTimeDecision: HyperliquidTrustedTimeDecision;
  readonly submissionTimeDecision: HyperliquidTrustedTimeDecision | null;
  readonly recoverySequence: number;
  readonly expiresAfterMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
  readonly action: HypercoreRecoveryOrderAction;
  readonly actionCommitmentScheme: typeof NARYX_HYPERCORE_RECOVERY_ACTION_COMMITMENT_SCHEME;
  readonly actionHash: `0x${string}`;
  readonly recordHash: `0x${string}`;
  readonly verifierIdentityHash: `0x${string}`;
  readonly clientOrderIds: readonly `0x${string}`[];
  readonly sourceAttempt: HyperliquidPackageAttempt;
  readonly parentReconciledAttemptHash: `0x${string}` | null;
  readonly plan: HyperliquidRecoveryExecutionPlan;
  readonly durableRevision: string | null;
  readonly acknowledgementId: string | null;
  readonly rejectionId: string | null;
  /** Evidence version and outcome recorded when this attempt's reconciliation completed. */
  readonly reconciledEvidenceVersion: bigint | null;
  readonly reconciledOutcome: HyperliquidRecoveryAttempt['status'] | null;
  readonly reconciledAttemptHash: `0x${string}` | null;
  readonly reconciledAttempt: HyperliquidRecoveryAttempt | null;
}

export interface HyperliquidRecoveryAgentJournal {
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly status: 'ACTIVE' | 'FENCED' | 'RETIRED';
  readonly highestReservedNonce: bigint | null;
  readonly recoveryLineages: readonly Readonly<{
    recoveryLineageKey: `0x${string}`;
    highestReservedRecoverySequence: number;
  }>[];
  readonly attempts: readonly HyperliquidRecoverySubmissionRecord[];
}

interface NormalizedVerifierIdentity {
  readonly environment: 'testnet';
  readonly controllerId: string;
  readonly controllerCodeHash: Uint8Array;
  readonly authorityModeId: string;
  readonly actionBuilderCodeHash: Uint8Array;
}

export interface HyperliquidRecoverySubmissionJournal {
  readonly version: bigint;
  readonly verifierIdentity: NormalizedVerifierIdentity;
  readonly verifierIdentityHash: `0x${string}`;
  readonly agents: readonly HyperliquidRecoveryAgentJournal[];
}

export interface HyperliquidRecoveryPrepareInput {
  readonly expectedVersion: bigint;
  readonly recoveryAttemptId: string;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly sourceAttempt: HyperliquidPackageAttempt;
  readonly parentRecoveryAttempt?: HyperliquidRecoveryAttempt;
  readonly plan: HyperliquidRecoveryExecutionPlan;
  readonly trustedTimeDecision: HyperliquidTrustedTimeDecision;
  readonly vaultAddress: `0x${string}` | null;
}

export interface HyperliquidRecoveryReconciliationHandoff {
  readonly recoveryAttemptId: string;
  readonly recoveryKey: `0x${string}`;
  readonly agentWallet: `0x${string}`;
  readonly account: HyperliquidRecoveryExecutionPlan['account'];
  readonly nonce: bigint;
  readonly trustedTimeDecisionHash: `0x${string}`;
  readonly submissionTimeDecisionHash: `0x${string}` | null;
  readonly recoverySequence: number;
  readonly expiresAfterMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
  readonly actionHash: `0x${string}`;
  readonly actionCommitmentScheme: typeof NARYX_HYPERCORE_RECOVERY_ACTION_COMMITMENT_SCHEME;
  readonly clientOrderIds: readonly `0x${string}`[];
  readonly attempt: HyperliquidRecoveryAttempt;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function identifier(value: string, name: string): string {
  requireCondition(IDENTIFIER.test(value), `${name} is invalid`);
  return value;
}

function address(value: string, name: string): `0x${string}` {
  requireCondition(ADDRESS.test(value), `${name} must be a 20-byte address`);
  return value.toLowerCase() as `0x${string}`;
}

function stableValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function sha256(value: unknown): `0x${string}` {
  return `0x${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function normalizedIdentity(
  input: HyperliquidRecoveryVerifierIdentity,
): NormalizedVerifierIdentity {
  requireCondition(input.environment === 'testnet', 'only HyperCore testnet recovery is enabled');
  return Object.freeze({
    environment: 'testnet',
    controllerId: protocolId(input.controllerId, 'controllerId'),
    controllerCodeHash: manifestHash(input.controllerCodeHash, 'controllerCodeHash'),
    authorityModeId: protocolId(input.authorityModeId, 'authorityModeId'),
    actionBuilderCodeHash: manifestHash(input.actionBuilderCodeHash, 'actionBuilderCodeHash'),
  });
}

function actionHash(action: HypercoreRecoveryOrderAction): `0x${string}` {
  return sha256([NARYX_HYPERCORE_RECOVERY_ACTION_COMMITMENT_SCHEME, action]);
}

function recoveryKey(plan: HyperliquidRecoveryExecutionPlan): `0x${string}` {
  return sha256([
    'naryx/hypercore/recovery-key/v1',
    plan.domain,
    plan.commitments,
    plan.account,
    plan.sourceEvidenceVersion,
    plan.recoverySequence,
    plan.orders.map((order) => order.clientOrderId.toLowerCase()),
  ]);
}

function recoveryLineageKey(plan: HyperliquidRecoveryExecutionPlan): `0x${string}` {
  return sha256([
    'naryx/hypercore/recovery-lineage/v1',
    plan.domain,
    plan.commitments,
    plan.account,
  ]);
}

type RecordCore = Omit<HyperliquidRecoverySubmissionRecord,
  | 'status' | 'recordHash' | 'durableRevision' | 'acknowledgementId' | 'rejectionId'
  | 'submissionTimeDecision' | 'reconciledEvidenceVersion' | 'reconciledOutcome'
  | 'reconciledAttemptHash' | 'reconciledAttempt'>;

function immutableRecord(
  record: RecordCore | HyperliquidRecoverySubmissionRecord,
): RecordCore {
  return {
    recoveryAttemptId: record.recoveryAttemptId,
    recoveryLineageKey: record.recoveryLineageKey,
    recoveryKey: record.recoveryKey,
    account: record.account,
    agentWallet: record.agentWallet,
    signerLeaseId: record.signerLeaseId,
    nonce: record.nonce,
    trustedTimeDecision: record.trustedTimeDecision,
    recoverySequence: record.recoverySequence,
    expiresAfterMs: record.expiresAfterMs,
    vaultAddress: record.vaultAddress,
    action: record.action,
    actionCommitmentScheme: record.actionCommitmentScheme,
    actionHash: record.actionHash,
    verifierIdentityHash: record.verifierIdentityHash,
    clientOrderIds: record.clientOrderIds,
    sourceAttempt: record.sourceAttempt,
    parentReconciledAttemptHash: record.parentReconciledAttemptHash,
    plan: record.plan,
  };
}

function recordHash(record: RecordCore | HyperliquidRecoverySubmissionRecord): `0x${string}` {
  return sha256(['naryx/hypercore/recovery-submission-record/v1', immutableRecord(record)]);
}

function reconciledAttemptHash(attempt: HyperliquidRecoveryAttempt): `0x${string}` {
  return sha256(['naryx/hypercore/reconciled-recovery-attempt/v1', attempt]);
}

function isSameRecoverySource(
  left: HyperliquidPackageAttempt,
  right: HyperliquidPackageAttempt,
): boolean {
  return sha256(['naryx/hypercore/recovery-package-source/v1', left])
    === sha256(['naryx/hypercore/recovery-package-source/v1', right]);
}

function agentAt(journal: HyperliquidRecoverySubmissionJournal, agentWallet: string): number {
  return journal.agents.findIndex((agent) => agent.agentWallet === agentWallet);
}

function locate(
  journal: HyperliquidRecoverySubmissionJournal,
  recoveryAttemptId: string,
): Readonly<{
  agentIndex: number;
  recordIndex: number;
  agent: HyperliquidRecoveryAgentJournal;
  record: HyperliquidRecoverySubmissionRecord;
}> {
  requireCondition(journal.verifierIdentityHash
    === sha256(['naryx/hypercore/recovery-verifier-identity/v1', journal.verifierIdentity]),
  'journal verifier identity was modified');
  for (const [agentIndex, agent] of journal.agents.entries()) {
    const recordIndex = agent.attempts.findIndex(
      (record) => record.recoveryAttemptId === recoveryAttemptId,
    );
    if (recordIndex < 0) continue;
    const record = agent.attempts[recordIndex]!;
    requireCondition(record.verifierIdentityHash === journal.verifierIdentityHash,
      'journal verifier identity was modified');
    requireCondition(record.actionCommitmentScheme
      === NARYX_HYPERCORE_RECOVERY_ACTION_COMMITMENT_SCHEME,
    'journal recovery action commitment scheme is unsupported');
    requireCondition(record.actionHash === actionHash(record.action),
      'journal recovery action was modified');
    requireCondition(record.recoveryKey === recoveryKey(record.plan),
      'journal recovery key was modified');
    requireCondition(record.recoveryLineageKey === recoveryLineageKey(record.plan),
      'journal recovery lineage was modified');
    requireCondition(record.recordHash === recordHash(record),
      'journal recovery record was modified');
    if (record.reconciledAttempt === null) {
      requireCondition(record.reconciledAttemptHash === null,
        'journal reconciled attempt hash has no attempt');
    } else {
      requireCondition(record.reconciledAttemptHash === reconciledAttemptHash(record.reconciledAttempt),
        'journal reconciled attempt was modified');
      const evidence = record.reconciledAttempt.acceptedEvidence
        ?? record.reconciledAttempt.lockEvidence;
      requireCondition(record.status === 'RECONCILED'
        && evidence !== null
        && record.reconciledEvidenceVersion === evidence.evidenceVersion
        && record.reconciledOutcome === record.reconciledAttempt.status,
      'journal reconciled attempt metadata differs');
    }
    if (record.submissionTimeDecision !== null) {
      requireHyperliquidTrustedTimeDecision(
        record.submissionTimeDecision,
        `${record.recoveryAttemptId}:submit`,
      );
    }
    return Object.freeze({ agentIndex, recordIndex, agent, record });
  }
  throw new Error('recovery attempt ID is unknown');
}

function checkVersion(journal: HyperliquidRecoverySubmissionJournal, expectedVersion: bigint): void {
  requireCondition(journal.verifierIdentityHash
    === sha256(['naryx/hypercore/recovery-verifier-identity/v1', journal.verifierIdentity]),
  'journal verifier identity was modified');
  requireCondition(journal.version === expectedVersion,
    'recovery journal compare-and-set version mismatch');
}

function replaceAgent(
  journal: HyperliquidRecoverySubmissionJournal,
  index: number,
  agent: HyperliquidRecoveryAgentJournal,
): HyperliquidRecoverySubmissionJournal {
  const agents = [...journal.agents];
  agents[index] = Object.freeze(agent);
  return Object.freeze({
    ...journal,
    version: journal.version + 1n,
    agents: Object.freeze(agents),
  });
}

function replaceRecord(
  journal: HyperliquidRecoverySubmissionJournal,
  agentIndex: number,
  recordIndex: number,
  record: HyperliquidRecoverySubmissionRecord,
): HyperliquidRecoverySubmissionJournal {
  const agent = journal.agents[agentIndex]!;
  const attempts = [...agent.attempts];
  attempts[recordIndex] = Object.freeze(record);
  return replaceAgent(journal, agentIndex, { ...agent, attempts: Object.freeze(attempts) });
}

export function createHyperliquidRecoverySubmissionJournal(
  identity: HyperliquidRecoveryVerifierIdentity,
): HyperliquidRecoverySubmissionJournal {
  const verifierIdentity = normalizedIdentity(identity);
  return Object.freeze({
    version: 0n,
    verifierIdentity,
    verifierIdentityHash: sha256(['naryx/hypercore/recovery-verifier-identity/v1', verifierIdentity]),
    agents: Object.freeze([]),
  });
}

export function registerHyperliquidRecoveryAgent(
  journal: HyperliquidRecoverySubmissionJournal,
  input: Readonly<{
    expectedVersion: bigint;
    agentWallet: `0x${string}`;
    signerLeaseId: string;
  }>,
): HyperliquidRecoverySubmissionJournal {
  const agentWallet = address(input.agentWallet, 'agentWallet');
  const signerLeaseId = identifier(input.signerLeaseId, 'signerLeaseId');
  requireCondition(agentAt(journal, agentWallet) < 0,
    'recovery agent wallet is already registered, fenced, or retired');
  requireCondition(journal.agents.every((agent) => agent.signerLeaseId !== signerLeaseId),
    'recovery signer lease is already assigned');
  checkVersion(journal, input.expectedVersion);
  return Object.freeze({
    ...journal,
    version: journal.version + 1n,
    agents: Object.freeze([...journal.agents, Object.freeze({
      agentWallet,
      signerLeaseId,
      status: 'ACTIVE' as const,
      highestReservedNonce: null,
      recoveryLineages: Object.freeze([]),
      attempts: Object.freeze([]),
    })]),
  });
}

export function prepareHyperliquidRecoverySubmission(
  journal: HyperliquidRecoverySubmissionJournal,
  input: HyperliquidRecoveryPrepareInput,
): HyperliquidRecoverySubmissionJournal {
  const recoveryAttemptId = identifier(input.recoveryAttemptId, 'recoveryAttemptId');
  const agentWallet = address(input.agentWallet, 'agentWallet');
  const signerLeaseId = identifier(input.signerLeaseId, 'signerLeaseId');
  requireCondition(journal.verifierIdentityHash
    === sha256(['naryx/hypercore/recovery-verifier-identity/v1', journal.verifierIdentity]),
  'journal verifier identity was modified');
  const agentIndex = agentAt(journal, agentWallet);
  requireCondition(agentIndex >= 0, 'recovery agent wallet is not registered');
  const agent = journal.agents[agentIndex]!;
  requireCondition(agent.signerLeaseId === signerLeaseId, 'recovery signer lease mismatch');
  const trustedTimeDecision = structuredClone(requireHyperliquidTrustedTimeDecision(
    input.trustedTimeDecision,
    recoveryAttemptId,
  ));
  const nowMs = BigInt(trustedTimeDecision.selectedTimeMs);
  if (input.parentRecoveryAttempt === undefined) {
    validateHyperliquidRecoveryExecutionPlan(
      input.sourceAttempt,
      input.plan,
      journal.verifierIdentity,
      nowMs,
    );
  } else {
    requireCondition(isSameRecoverySource(
      input.parentRecoveryAttempt.sourceAttempt,
      input.sourceAttempt,
    ), 'continuation package source differs');
    validateHyperliquidRecoveryContinuationExecutionPlan(
      input.parentRecoveryAttempt,
      input.plan,
      journal.verifierIdentity,
      nowMs,
    );
  }
  requireCondition(input.plan.actionExpiryMs > nowMs,
  'recovery expiresAfter is stale');
  requireCondition(agentWallet !== input.plan.account.masterAccount
    && agentWallet !== input.plan.account.tradingAccount,
  'recovery agent wallet must be distinct from the account query identity');
  const vaultAddress = input.vaultAddress === null
    ? null
    : address(input.vaultAddress, 'vaultAddress');
  requireCondition(input.plan.account.accountKind === 'MASTER'
    ? vaultAddress === null
    : vaultAddress === input.plan.account.tradingAccount,
  'recovery vault context must match the trading account identity');
  const plan = structuredClone(input.plan);
  const sourceAttempt = structuredClone(input.sourceAttempt);
  const action = structuredClone(plan.unsignedRequestFields.action);
  const key = recoveryKey(plan);
  const lineageKey = recoveryLineageKey(plan);
  const existing = journal.agents.flatMap((entry) => entry.attempts)
    .find((record) => record.recoveryAttemptId === recoveryAttemptId);
  const nonce = existing?.nonce ?? allocateHyperliquidTrustedNonce(
    nowMs,
    agent.highestReservedNonce ?? 0n,
    BigInt(trustedTimeDecision.policy.maximumFutureNonceLeadMs),
  );
  requireCondition(nonce >= nowMs - TWO_DAYS_MS && nonce <= nowMs + ONE_DAY_MS,
    'recovery nonce is outside the HyperCore time window');
  requireCondition(input.plan.actionExpiryMs > nonce, 'recovery expiresAfter is stale');
  const core: RecordCore = {
    recoveryAttemptId,
    recoveryLineageKey: lineageKey,
    recoveryKey: key,
    account: plan.account,
    agentWallet,
    signerLeaseId,
    nonce,
    trustedTimeDecision,
    recoverySequence: plan.recoverySequence,
    expiresAfterMs: plan.actionExpiryMs,
    vaultAddress,
    action,
    actionCommitmentScheme: NARYX_HYPERCORE_RECOVERY_ACTION_COMMITMENT_SCHEME,
    actionHash: actionHash(action),
    verifierIdentityHash: journal.verifierIdentityHash,
    clientOrderIds: Object.freeze(plan.orders.map(
      (order) => order.clientOrderId.toLowerCase() as `0x${string}`,
    )),
    sourceAttempt,
    parentReconciledAttemptHash: input.parentRecoveryAttempt === undefined
      ? null
      : reconciledAttemptHash(input.parentRecoveryAttempt),
    plan,
  };
  const commitment = recordHash(core);
  if (existing !== undefined) {
    requireCondition(existing.recordHash === recordHash(existing),
      'journal recovery record was modified');
    requireCondition(existing.recordHash === commitment,
      'recovery attempt replay changed its binding');
    return journal;
  }
  requireCondition(!journal.agents.flatMap((entry) => entry.attempts)
    .some((record) => record.recoveryKey === key),
  'recovery sequence or client order IDs are already reserved');
  requireCondition(agent.status === 'ACTIVE', 'recovery agent wallet is fenced or retired');
  checkVersion(journal, input.expectedVersion);
  requireCondition(agent.highestReservedNonce === null || nonce > agent.highestReservedNonce,
    'recovery nonce must strictly increase for the agent wallet');
  const lineage = agent.recoveryLineages.find(
    (entry) => entry.recoveryLineageKey === lineageKey,
  );
  requireCondition(lineage === undefined
    || plan.recoverySequence > lineage.highestReservedRecoverySequence,
  'recovery sequence must strictly increase for the package lineage');
  // A lost or unresolved recovery order may still fill, so no new recovery action for the same
  // package may be prepared under any agent wallet until every earlier one is reconciled or was
  // fenced before submission, and the follow-up must be compiled from the latest evidence.
  const lineageRecords = journal.agents.flatMap((entry) => entry.attempts)
    .filter((record) => record.recoveryLineageKey === lineageKey);
  requireCondition(lineageRecords.every((record) => record.status === 'RECONCILED' || record.status === 'FENCED'),
    'an earlier recovery attempt for this package is not yet reconciled');
  requireCondition(lineageRecords.every((record) => record.reconciledOutcome === null
    || record.reconciledOutcome === 'RECOVERY_REQUIRED'),
  'the package recovery already reached a terminal or manual outcome');
  const latestReconciledVersion = lineageRecords.reduce<bigint | null>(
    (latest, record) => record.reconciledEvidenceVersion !== null
      && (latest === null || record.reconciledEvidenceVersion > latest)
      ? record.reconciledEvidenceVersion
      : latest,
    null,
  );
  requireCondition(latestReconciledVersion === null || plan.sourceEvidenceVersion >= latestReconciledVersion,
    'a follow-up recovery must be compiled from the latest reconciled evidence');
  requireCondition(lineageRecords.every((record) => plan.recoverySequence > record.recoverySequence),
    'recovery sequence must strictly increase for the package across agent wallets');
  if (input.parentRecoveryAttempt === undefined) {
    requireCondition(lineageRecords.length === 0,
      'an initial recovery cannot continue an existing package lineage');
  } else {
    const latest = lineageRecords.reduce<HyperliquidRecoverySubmissionRecord | null>(
      (selected, record) => selected === null || record.recoverySequence > selected.recoverySequence
        ? record
        : selected,
      null,
    );
    requireCondition(latest !== null
      && latest.status === 'RECONCILED'
      && latest.reconciledOutcome === 'RECOVERY_REQUIRED'
      && latest.reconciledAttemptHash === core.parentReconciledAttemptHash,
    'continuation does not extend the latest reconciled recovery attempt');
  }
  const record: HyperliquidRecoverySubmissionRecord = Object.freeze({
    ...core,
    recordHash: commitment,
    status: 'PREPARED',
    submissionTimeDecision: null,
    durableRevision: null,
    acknowledgementId: null,
    rejectionId: null,
    reconciledEvidenceVersion: null,
    reconciledOutcome: null,
    reconciledAttemptHash: null,
    reconciledAttempt: null,
  });
  return replaceAgent(journal, agentIndex, {
    ...agent,
    highestReservedNonce: nonce,
    recoveryLineages: Object.freeze([
      ...agent.recoveryLineages.filter((entry) => entry.recoveryLineageKey !== lineageKey),
      Object.freeze({
        recoveryLineageKey: lineageKey,
        highestReservedRecoverySequence: plan.recoverySequence,
      }),
    ]),
    attempts: Object.freeze([...agent.attempts, record]),
  });
}

export function confirmHyperliquidRecoveryDurableRecord(
  journal: HyperliquidRecoverySubmissionJournal,
  input: Readonly<{
    expectedVersion: bigint;
    recoveryAttemptId: string;
    recordHash: `0x${string}`;
    durableRevision: string;
  }>,
): HyperliquidRecoverySubmissionJournal {
  const located = locate(journal, input.recoveryAttemptId);
  const durableRevision = identifier(input.durableRevision, 'durableRevision');
  requireCondition(input.recordHash === located.record.recordHash,
    'durable recovery record hash mismatch');
  if (located.record.status !== 'PREPARED'
    && located.record.durableRevision === durableRevision) return journal;
  checkVersion(journal, input.expectedVersion);
  requireCondition(located.record.status === 'PREPARED',
    'durable recovery confirmation requires PREPARED');
  return replaceRecord(journal, located.agentIndex, located.recordIndex, {
    ...located.record,
    status: 'DURABLE_RECORD_CONFIRMED',
    durableRevision,
  });
}

function transition(
  journal: HyperliquidRecoverySubmissionJournal,
  input: Readonly<{ expectedVersion: bigint; recoveryAttemptId: string }>,
  from: readonly HyperliquidRecoverySubmissionStatus[],
  to: HyperliquidRecoverySubmissionStatus,
): HyperliquidRecoverySubmissionJournal {
  const located = locate(journal, input.recoveryAttemptId);
  if (located.record.status === to) return journal;
  checkVersion(journal, input.expectedVersion);
  requireCondition(located.agent.status === 'ACTIVE',
    'recovery agent wallet is fenced or retired');
  requireCondition(from.includes(located.record.status),
    `${to} cannot follow ${located.record.status}`);
  return replaceRecord(journal, located.agentIndex, located.recordIndex,
    { ...located.record, status: to });
}

export function markHyperliquidRecoverySubmittedUnknown(
  journal: HyperliquidRecoverySubmissionJournal,
  input: Readonly<{
    expectedVersion: bigint;
    recoveryAttemptId: string;
    trustedTimeDecision: HyperliquidTrustedTimeDecision;
  }>,
): HyperliquidRecoverySubmissionJournal {
  const located = locate(journal, input.recoveryAttemptId);
  const decision = structuredClone(requireHyperliquidTrustedTimeDecision(
    input.trustedTimeDecision,
    `${located.record.recoveryAttemptId}:submit`,
  ));
  if (located.record.status === 'SUBMITTED_UNKNOWN') {
    requireCondition(located.record.submissionTimeDecision?.decisionHash === decision.decisionHash,
      'recovery submission replay changed its trusted time decision');
    return journal;
  }
  const nowMs = BigInt(decision.selectedTimeMs);
  requireCondition(sha256(decision.policy) === sha256(located.record.trustedTimeDecision.policy),
    'recovery trusted time policy changed before submission');
  requireCondition(located.record.nonce <= nowMs
    + BigInt(located.record.trustedTimeDecision.policy.maximumFutureNonceLeadMs),
  'durable nonce is beyond trusted time policy; fresh agent replacement is required');
  requireCondition(nowMs < located.record.expiresAfterMs,
    'recovery expiresAfter is stale before submission');
  requireCondition(located.record.nonce >= nowMs - TWO_DAYS_MS
    && located.record.nonce <= nowMs + ONE_DAY_MS,
  'recovery nonce is outside the HyperCore time window before submission');
  checkVersion(journal, input.expectedVersion);
  requireCondition(located.agent.status === 'ACTIVE'
    && located.record.status === 'DURABLE_RECORD_CONFIRMED',
  `SUBMITTED_UNKNOWN cannot follow ${located.record.status}`);
  return replaceRecord(journal, located.agentIndex, located.recordIndex, {
    ...located.record,
    status: 'SUBMITTED_UNKNOWN',
    submissionTimeDecision: decision,
  });
}

export function acknowledgeHyperliquidRecoverySubmission(
  journal: HyperliquidRecoverySubmissionJournal,
  input: Readonly<{
    expectedVersion: bigint;
    recoveryAttemptId: string;
    acknowledgementId: string;
  }>,
): HyperliquidRecoverySubmissionJournal {
  const located = locate(journal, input.recoveryAttemptId);
  const acknowledgementId = identifier(input.acknowledgementId, 'acknowledgementId');
  if (located.record.acknowledgementId === acknowledgementId) return journal;
  checkVersion(journal, input.expectedVersion);
  requireCondition(located.agent.status === 'ACTIVE'
    && located.record.status === 'SUBMITTED_UNKNOWN',
  'recovery acknowledgement requires submitted-unknown state');
  return replaceRecord(journal, located.agentIndex, located.recordIndex, {
    ...located.record,
    status: 'ACKNOWLEDGED',
    acknowledgementId,
  });
}

export function rejectHyperliquidRecoverySubmission(
  journal: HyperliquidRecoverySubmissionJournal,
  input: Readonly<{
    expectedVersion: bigint;
    recoveryAttemptId: string;
    rejectionId: string;
  }>,
): HyperliquidRecoverySubmissionJournal {
  const located = locate(journal, input.recoveryAttemptId);
  const rejectionId = identifier(input.rejectionId, 'rejectionId');
  if (located.record.rejectionId === rejectionId) return journal;
  checkVersion(journal, input.expectedVersion);
  requireCondition(located.agent.status === 'ACTIVE'
    && located.record.status === 'SUBMITTED_UNKNOWN',
  'recovery rejection requires submitted-unknown state');
  return replaceRecord(journal, located.agentIndex, located.recordIndex, {
    ...located.record,
    status: 'REJECTED',
    rejectionId,
  });
}

export function beginHyperliquidRecoverySubmissionReconciliation(
  journal: HyperliquidRecoverySubmissionJournal,
  input: Readonly<{ expectedVersion: bigint; recoveryAttemptId: string }>,
): HyperliquidRecoverySubmissionJournal {
  return transition(journal, input,
    ['DURABLE_RECORD_CONFIRMED', 'SUBMITTED_UNKNOWN', 'ACKNOWLEDGED', 'REJECTED'],
    'RECONCILING');
}

/**
 * Records the completed reconciliation of a recovery attempt. The reconciled attempt must be the
 * one handed off for this record and must carry the evidence it was decided on; only then can a
 * follow-up recovery for the same package be prepared.
 */
export function completeHyperliquidRecoverySubmissionReconciliation(
  journal: HyperliquidRecoverySubmissionJournal,
  input: Readonly<{
    expectedVersion: bigint;
    recoveryAttemptId: string;
    reconciledAttempt: HyperliquidRecoveryAttempt;
  }>,
): HyperliquidRecoverySubmissionJournal {
  const located = locate(journal, input.recoveryAttemptId);
  const reconciled = input.reconciledAttempt;
  requireCondition(reconciled.status !== 'RECONCILING', 'recovery reconciliation has not decided an outcome');
  requireCondition(recoveryKey(reconciled.plan) === located.record.recoveryKey,
    'reconciled attempt does not belong to this recovery record');
  const evidence = reconciled.acceptedEvidence ?? reconciled.lockEvidence;
  requireCondition(evidence !== null, 'recovery reconciliation carries no evidence');
  const attemptHash = reconciledAttemptHash(reconciled);
  if (located.record.status === 'RECONCILED') {
    requireCondition(located.record.reconciledEvidenceVersion === evidence.evidenceVersion
      && located.record.reconciledOutcome === reconciled.status
      && located.record.reconciledAttemptHash === attemptHash,
    'recovery attempt was already reconciled with different evidence');
    return journal;
  }
  checkVersion(journal, input.expectedVersion);
  requireCondition(located.record.status === 'RECONCILING',
    `RECONCILED cannot follow ${located.record.status}`);
  return replaceRecord(journal, located.agentIndex, located.recordIndex, {
    ...located.record,
    status: 'RECONCILED',
    reconciledEvidenceVersion: evidence.evidenceVersion,
    reconciledOutcome: reconciled.status,
    reconciledAttemptHash: attemptHash,
    reconciledAttempt: structuredClone(reconciled),
  });
}

export function hyperliquidRecoveryContinuationSource(
  journal: HyperliquidRecoverySubmissionJournal,
  recoveryAttemptId: string,
): HyperliquidRecoveryAttempt {
  const { record } = locate(journal, recoveryAttemptId);
  requireCondition(record.status === 'RECONCILED'
    && record.reconciledOutcome === 'RECOVERY_REQUIRED'
    && record.reconciledAttempt !== null
    && record.reconciledAttempt.nextRecoveryObligation !== null,
  'recovery attempt has no trusted continuation obligation');
  return structuredClone(record.reconciledAttempt);
}

export function fenceHyperliquidRecoveryAgent(
  journal: HyperliquidRecoverySubmissionJournal,
  input: Readonly<{
    expectedVersion: bigint;
    agentWallet: `0x${string}`;
    signerLeaseId: string;
    disposition: 'FENCED' | 'RETIRED';
  }>,
): HyperliquidRecoverySubmissionJournal {
  requireCondition(input.disposition === 'FENCED' || input.disposition === 'RETIRED',
    'recovery agent disposition is unsupported');
  const agentIndex = agentAt(journal, address(input.agentWallet, 'agentWallet'));
  requireCondition(agentIndex >= 0, 'recovery agent wallet is not registered');
  const agent = journal.agents[agentIndex]!;
  requireCondition(agent.signerLeaseId === input.signerLeaseId,
    'recovery signer lease mismatch');
  if (agent.status === input.disposition) return journal;
  checkVersion(journal, input.expectedVersion);
  requireCondition(agent.status === 'ACTIVE',
    'fenced or retired recovery agent cannot be reactivated');
  return replaceAgent(journal, agentIndex, {
    ...agent,
    status: input.disposition,
    attempts: Object.freeze(agent.attempts.map((record) => Object.freeze({
      ...record,
      status: record.status === 'PREPARED' || record.status === 'DURABLE_RECORD_CONFIRMED'
        ? 'FENCED' as const
        : record.status,
    }))),
  });
}

export function hyperliquidRecoveryReconciliationHandoff(
  journal: HyperliquidRecoverySubmissionJournal,
  recoveryAttemptId: string,
): HyperliquidRecoveryReconciliationHandoff {
  const { record } = locate(journal, recoveryAttemptId);
  requireCondition(record.durableRevision !== null,
    'unconfirmed recovery record cannot be reconciled');
  return Object.freeze({
    recoveryAttemptId: record.recoveryAttemptId,
    recoveryKey: record.recoveryKey,
    agentWallet: record.agentWallet,
    account: record.account,
    nonce: record.nonce,
    trustedTimeDecisionHash: record.trustedTimeDecision.decisionHash,
    submissionTimeDecisionHash: record.submissionTimeDecision?.decisionHash ?? null,
    recoverySequence: record.recoverySequence,
    expiresAfterMs: record.expiresAfterMs,
    vaultAddress: record.vaultAddress,
    actionHash: record.actionHash,
    actionCommitmentScheme: record.actionCommitmentScheme,
    clientOrderIds: Object.freeze([...record.clientOrderIds]),
    attempt: Object.freeze({
      version: 1,
      status: 'RECONCILING',
      sourceAttempt: structuredClone(record.sourceAttempt),
      plan: structuredClone(record.plan),
      reasons: Object.freeze([]),
      acceptedEvidence: null,
      lockEvidence: null,
      nextRecoveryObligation: null,
    }),
  });
}
