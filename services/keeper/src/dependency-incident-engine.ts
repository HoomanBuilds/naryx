import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  domainRef,
  manifestHash,
  protocolId,
  QUOTE_MODE,
  SETTLEMENT_CLASS,
  toHex,
  versionedManifestRef,
  type AuthorityRole,
  type DomainRef,
  type ManifestHash,
  type QuoteMode,
  type ReadinessDecision,
  type SettlementClass,
  type VersionedManifestRef,
} from '@naryx/protocol-types';

const HEX_32 = /^0x[0-9a-f]{64}$/;

export const DEPENDENCY_STATE = Object.freeze({
  ACTIVE: 'ACTIVE',
  ENTRY_PAUSED: 'ENTRY_PAUSED',
  EXIT_ONLY: 'EXIT_ONLY',
  ALL_PAUSED: 'ALL_PAUSED',
  QUARANTINED: 'QUARANTINED',
  INCIDENT_REVIEW: 'INCIDENT_REVIEW',
} as const);
export type DependencyState = keyof typeof DEPENDENCY_STATE;

export const DEPENDENCY_TRIGGER = Object.freeze({
  CODE_DRIFT: 'CODE_DRIFT',
  AUTHORITY_DRIFT: 'AUTHORITY_DRIFT',
  STALE_EVIDENCE: 'STALE_EVIDENCE',
  ORACLE_DIVERGENCE: 'ORACLE_DIVERGENCE',
  LIQUIDITY_LOSS: 'LIQUIDITY_LOSS',
  RECOVERY_UNAVAILABLE: 'RECOVERY_UNAVAILABLE',
  SIGNER_FENCING: 'SIGNER_FENCING',
  CAP_EXHAUSTION: 'CAP_EXHAUSTION',
  RESTORATION: 'RESTORATION',
} as const);
export type DependencyTrigger = keyof typeof DEPENDENCY_TRIGGER;

export interface DependencyScopeInput {
  readonly scopeId: string;
  readonly domain: DomainRef;
  readonly template: VersionedManifestRef;
  readonly settlementClass: SettlementClass;
  readonly quoteMode: QuoteMode;
  readonly sizeCohort: string;
}

export interface DependencyScope {
  readonly scopeId: string;
  readonly domain: DomainRef;
  readonly template: VersionedManifestRef;
  readonly settlementClass: SettlementClass;
  readonly quoteMode: QuoteMode;
  readonly sizeCohort: string;
}

export interface QualificationEvidenceInput {
  readonly scopeHash: `0x${string}`;
  readonly readinessDecision: ReadinessDecision;
  readonly readinessDecisionCommitment: Uint8Array | string;
  readonly evidenceCommitment: Uint8Array | string;
  readonly observedAtMs: bigint;
  readonly validUntilMs: bigint;
  readonly exitSafe: boolean;
}

export interface QualificationEvidence {
  readonly scopeHash: `0x${string}`;
  readonly readinessDecisionCommitment: `0x${string}`;
  readonly evidenceCommitment: `0x${string}`;
  readonly readinessDecisionVersion: number;
  readonly readinessEnvironment: string;
  readonly observedAtMs: bigint;
  readonly validUntilMs: bigint;
  readonly exitSafe: boolean;
}

export interface ReviewerApprovalInput {
  readonly role: AuthorityRole;
  readonly approvedAtMs: bigint;
}

export interface ReviewerApproval {
  readonly roleId: string;
  readonly authorityClass: 'RISK_ADMIN' | 'INCIDENT_OWNER';
  readonly reviewerRoleCommitment: `0x${string}`;
  readonly approvedAtMs: bigint;
}

export interface IncidentDrillReceipt {
  readonly sequence: number;
  readonly previousReceiptHash: `0x${string}` | null;
  readonly scopeHash: `0x${string}`;
  readonly beforeState: DependencyState;
  readonly afterState: DependencyState;
  readonly beforeEntryAllowed: boolean;
  readonly afterEntryAllowed: boolean;
  readonly beforeExitAllowed: boolean;
  readonly afterExitAllowed: boolean;
  readonly trigger: DependencyTrigger;
  readonly evidence: QualificationEvidence;
  readonly approvers: readonly ReviewerApproval[];
  readonly occurredAtMs: bigint;
  readonly receiptHash: `0x${string}`;
}

export interface DependencyIncidentJournal {
  readonly schemaVersion: 1;
  readonly revision: bigint;
  readonly scope: DependencyScope;
  readonly scopeHash: `0x${string}`;
  readonly state: DependencyState;
  readonly entryAllowed: boolean;
  readonly exitAllowed: boolean;
  readonly latestEvidence: QualificationEvidence;
  readonly receipts: readonly IncidentDrillReceipt[];
}

interface PersistedJournal extends DependencyIncidentJournal {
  readonly snapshotHash: `0x${string}`;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hex32(value: Uint8Array | string, name: string): `0x${string}` {
  const bytes = manifestHash(value, name);
  return `0x${toHex(bytes)}`;
}

function stableValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof Uint8Array) return { $bytes: toHex(value) };
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'snapshotHash' && key !== 'receiptHash')
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function sha256(value: unknown): `0x${string}` {
  return `0x${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function normalizedScope(input: DependencyScopeInput): DependencyScope {
  requireCondition(typeof input === 'object' && input !== null, 'scope is required');
  requireCondition(input.settlementClass in SETTLEMENT_CLASS, 'scope settlement class is unsupported');
  requireCondition(input.quoteMode in QUOTE_MODE, 'scope quote mode is unsupported');
  return Object.freeze({
    scopeId: protocolId(input.scopeId, 'scope.scopeId'),
    domain: domainRef(
      input.domain.domainId,
      input.domain.domainManifestVersion,
      input.domain.domainManifestHash,
      'scope.domain',
    ),
    template: versionedManifestRef(
      input.template.subjectId,
      input.template.manifestVersion,
      input.template.manifestHash,
      'scope.template',
    ),
    settlementClass: input.settlementClass,
    quoteMode: input.quoteMode,
    sizeCohort: protocolId(input.sizeCohort, 'scope.sizeCohort'),
  });
}

export function dependencyScopeHash(scope: DependencyScopeInput): `0x${string}` {
  return sha256(['naryx/dependency-scope/v1', normalizedScope(scope)]);
}

function qualificationEvidence(
  input: QualificationEvidenceInput,
  expectedScopeHash: `0x${string}`,
): QualificationEvidence {
  requireCondition(HEX_32.test(input.scopeHash), 'evidence scope hash is invalid');
  requireCondition(input.scopeHash === expectedScopeHash, 'evidence is bound to a different scope');
  requireCondition(input.readinessDecision.status === 'READY', 'readiness decision is not ready');
  requireCondition(input.observedAtMs >= 0n, 'evidence observation time is negative');
  requireCondition(input.validUntilMs > input.observedAtMs, 'evidence validity window must increase');
  return Object.freeze({
    scopeHash: input.scopeHash,
    readinessDecisionCommitment: hex32(
      input.readinessDecisionCommitment,
      'evidence.readinessDecisionCommitment',
    ),
    evidenceCommitment: hex32(input.evidenceCommitment, 'evidence.evidenceCommitment'),
    readinessDecisionVersion: input.readinessDecision.decisionVersion,
    readinessEnvironment: input.readinessDecision.environment,
    observedAtMs: input.observedAtMs,
    validUntilMs: input.validUntilMs,
    exitSafe: input.exitSafe,
  });
}

function permissions(state: DependencyState, exitSafe: boolean): Readonly<{
  entryAllowed: boolean;
  exitAllowed: boolean;
}> {
  return Object.freeze({
    entryAllowed: state === 'ACTIVE',
    exitAllowed: state === 'ACTIVE' || exitSafe,
  });
}

function reducedState(trigger: Exclude<DependencyTrigger, 'RESTORATION'>, exitSafe: boolean): DependencyState {
  if (trigger === 'CODE_DRIFT' || trigger === 'AUTHORITY_DRIFT' || trigger === 'SIGNER_FENCING') {
    return 'QUARANTINED';
  }
  if (!exitSafe) return 'ALL_PAUSED';
  if (trigger === 'ORACLE_DIVERGENCE') return 'EXIT_ONLY';
  if (trigger === 'LIQUIDITY_LOSS' || trigger === 'CAP_EXHAUSTION') return 'ENTRY_PAUSED';
  return 'INCIDENT_REVIEW';
}

function approval(input: ReviewerApprovalInput): ReviewerApproval {
  requireCondition(
    input.role.authorityClass === 'RISK_ADMIN' || input.role.authorityClass === 'INCIDENT_OWNER',
    'reviewer role is not authorized for incident restoration',
  );
  requireCondition(input.approvedAtMs >= 0n, 'approval time is negative');
  return Object.freeze({
    roleId: protocolId(input.role.roleId, 'approval.roleId'),
    authorityClass: input.role.authorityClass,
    reviewerRoleCommitment: hex32(
      input.role.publicIdentityCommitment,
      'approval.reviewerRoleCommitment',
    ),
    approvedAtMs: input.approvedAtMs,
  });
}

function receiptCore(receipt: Omit<IncidentDrillReceipt, 'receiptHash'>): Omit<IncidentDrillReceipt, 'receiptHash'> {
  return receipt;
}

function makeReceipt(input: Omit<IncidentDrillReceipt, 'receiptHash'>): IncidentDrillReceipt {
  return Object.freeze({ ...input, receiptHash: sha256(['naryx/incident-drill-receipt/v1', receiptCore(input)]) });
}

function transition(
  journal: DependencyIncidentJournal,
  afterState: DependencyState,
  trigger: DependencyTrigger,
  evidence: QualificationEvidence,
  approvers: readonly ReviewerApproval[],
  occurredAtMs: bigint,
): DependencyIncidentJournal {
  requireCondition(occurredAtMs >= journal.latestEvidence.observedAtMs, 'transition time predates current evidence');
  requireCondition(evidence.observedAtMs >= journal.latestEvidence.observedAtMs, 'evidence regressed');
  const after = permissions(afterState, evidence.exitSafe);
  if (trigger !== 'RESTORATION') {
    requireCondition(!after.entryAllowed || journal.entryAllowed, 'automatic transition increased entry permission');
    requireCondition(!after.exitAllowed || journal.exitAllowed, 'automatic transition increased exit permission');
  }
  const previous = journal.receipts.at(-1)?.receiptHash ?? null;
  const receipt = makeReceipt({
    sequence: journal.receipts.length + 1,
    previousReceiptHash: previous,
    scopeHash: journal.scopeHash,
    beforeState: journal.state,
    afterState,
    beforeEntryAllowed: journal.entryAllowed,
    afterEntryAllowed: after.entryAllowed,
    beforeExitAllowed: journal.exitAllowed,
    afterExitAllowed: after.exitAllowed,
    trigger,
    evidence,
    approvers,
    occurredAtMs,
  });
  return Object.freeze({
    ...journal,
    revision: journal.revision + 1n,
    state: afterState,
    entryAllowed: after.entryAllowed,
    exitAllowed: after.exitAllowed,
    latestEvidence: evidence,
    receipts: Object.freeze([...journal.receipts, receipt]),
  });
}

export function createDependencyIncidentJournal(
  scopeInput: DependencyScopeInput,
  evidenceInput: QualificationEvidenceInput,
  nowMs: bigint,
): DependencyIncidentJournal {
  const scope = normalizedScope(scopeInput);
  const scopeHash = dependencyScopeHash(scope);
  const evidence = qualificationEvidence(evidenceInput, scopeHash);
  requireCondition(nowMs >= evidence.observedAtMs && nowMs < evidence.validUntilMs, 'initial evidence is not fresh');
  const initial: DependencyIncidentJournal = Object.freeze({
    schemaVersion: 1,
    revision: 0n,
    scope,
    scopeHash,
    state: 'ACTIVE',
    entryAllowed: true,
    exitAllowed: true,
    latestEvidence: evidence,
    receipts: Object.freeze([]),
  });
  return initial;
}

export function applyDependencyTrigger(
  journal: DependencyIncidentJournal,
  input: Readonly<{
    expectedRevision: bigint;
    trigger: Exclude<DependencyTrigger, 'RESTORATION'>;
    evidence: QualificationEvidenceInput;
    occurredAtMs: bigint;
  }>,
): DependencyIncidentJournal {
  requireCondition(input.expectedRevision === journal.revision, 'incident journal compare-and-set failed');
  const evidence = qualificationEvidence(input.evidence, journal.scopeHash);
  const state = reducedState(input.trigger, evidence.exitSafe);
  return transition(journal, state, input.trigger, evidence, Object.freeze([]), input.occurredAtMs);
}

export function restoreDependencyScope(
  journal: DependencyIncidentJournal,
  input: Readonly<{
    expectedRevision: bigint;
    evidence: QualificationEvidenceInput;
    reviewers: readonly [ReviewerApprovalInput, ReviewerApprovalInput];
    occurredAtMs: bigint;
  }>,
): DependencyIncidentJournal {
  requireCondition(input.expectedRevision === journal.revision, 'incident journal compare-and-set failed');
  requireCondition(journal.state !== 'ACTIVE', 'active scope does not require restoration');
  const evidence = qualificationEvidence(input.evidence, journal.scopeHash);
  requireCondition(input.occurredAtMs >= evidence.observedAtMs, 'restoration predates evidence');
  requireCondition(input.occurredAtMs < evidence.validUntilMs, 'restoration evidence is stale');
  requireCondition(evidence.exitSafe, 'restoration evidence does not establish safe exits');
  const reviewers = input.reviewers.map(approval);
  requireCondition(reviewers[0]!.roleId !== reviewers[1]!.roleId, 'self-approval is forbidden');
  requireCondition(
    reviewers[0]!.reviewerRoleCommitment !== reviewers[1]!.reviewerRoleCommitment,
    'reviewer role commitments must be distinct',
  );
  requireCondition(
    reviewers.every((reviewer) => reviewer.approvedAtMs >= evidence.observedAtMs &&
      reviewer.approvedAtMs <= input.occurredAtMs),
    'review approval is outside the restoration evidence window',
  );
  return transition(
    journal,
    'ACTIVE',
    'RESTORATION',
    evidence,
    Object.freeze(reviewers),
    input.occurredAtMs,
  );
}

function snapshotHash(journal: DependencyIncidentJournal): `0x${string}` {
  return sha256(['naryx/dependency-incident-snapshot/v1', journal]);
}

function serializable(value: unknown): unknown {
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof Uint8Array) return { $bytes: toHex(value) };
  if (Array.isArray(value)) return value.map(serializable);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item)]));
  }
  return value;
}

function revive(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && typeof record.$bigint === 'string') {
    return BigInt(record.$bigint);
  }
  if (Object.keys(record).length === 1 && typeof record.$bytes === 'string') {
    return Uint8Array.from(Buffer.from(record.$bytes, 'hex'));
  }
  return value;
}

function validateLoadedJournal(value: PersistedJournal): DependencyIncidentJournal {
  requireCondition(value.schemaVersion === 1, 'unsupported incident journal schema');
  requireCondition(value.scopeHash === dependencyScopeHash(value.scope), 'incident scope hash mismatch');
  requireCondition(value.snapshotHash === snapshotHash(value), 'incident snapshot hash mismatch');
  requireCondition(value.revision === BigInt(value.receipts.length), 'incident journal revision mismatch');
  let previous: `0x${string}` | null = null;
  for (const [index, receipt] of value.receipts.entries()) {
    requireCondition(receipt.sequence === index + 1, 'incident receipt sequence mismatch');
    requireCondition(receipt.previousReceiptHash === previous, 'incident receipt chain mismatch');
    const { receiptHash, ...core } = receipt;
    requireCondition(receiptHash === makeReceipt(core).receiptHash, 'incident receipt hash mismatch');
    previous = receipt.receiptHash;
  }
  const last = value.receipts.at(-1);
  if (last !== undefined) {
    requireCondition(last.afterState === value.state, 'incident state does not match receipt chain');
    requireCondition(last.afterEntryAllowed === value.entryAllowed, 'entry permission does not match receipt chain');
    requireCondition(last.afterExitAllowed === value.exitAllowed, 'exit permission does not match receipt chain');
    requireCondition(last.evidence.evidenceCommitment === value.latestEvidence.evidenceCommitment,
      'latest evidence does not match receipt chain');
  }
  const { snapshotHash: _snapshotHash, ...journal } = value;
  return Object.freeze(journal);
}

export class DependencyIncidentFileStore {
  readonly #path: string;

  constructor(path: string) {
    requireCondition(path.length > 0, 'incident journal path is empty');
    this.#path = path;
  }

  async load(): Promise<DependencyIncidentJournal> {
    const raw = await readFile(this.#path, 'utf8');
    return validateLoadedJournal(JSON.parse(raw, revive) as PersistedJournal);
  }

  async save(journal: DependencyIncidentJournal): Promise<void> {
    const persisted: PersistedJournal = Object.freeze({ ...journal, snapshotHash: snapshotHash(journal) });
    const temporary = `${this.#path}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(serializable(persisted))}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.#path);
  }
}
