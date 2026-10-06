import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { HyperliquidStrategyExecutionPlan } from '@naryx/adapter-hyperliquid';
import { parseProtocolJson, stringifyProtocolJson, type PackageAdmission } from '@naryx/protocol-types';
import type {
  HyperliquidPackageSubmissionResult,
} from './index.js';
import type {
  HyperliquidTestnetRuntimeCoordinator,
  HyperliquidTestnetRuntimeCoordinatorInput,
  HyperliquidTestnetRuntimeCoordinatorResult,
  HyperliquidTestnetRuntimeRawCommitment,
} from './hyperliquid-testnet-runtime.js';
import type {
  HyperliquidStrategyRuntimeResult,
} from './hyperliquid-strategy-testnet-runtime.js';
import {
  HYPERLIQUID_LANE_RELEASE_REASON,
  HyperliquidTestnetLane,
  HyperliquidTestnetLaneError,
  type HyperliquidLaneNotSubmittedReason,
  type HyperliquidLaneRelease,
  type HyperliquidLaneReleaseDisposition,
  type HyperliquidLaneState,
} from './hyperliquid-testnet-lane.js';

export const SOLVER_TESTNET_EXECUTE_PATH = '/internal/solver/hyperliquid-testnet/execute';
export const SOLVER_TESTNET_ATTEMPT_STATUS_PATH = '/internal/solver/hyperliquid-testnet/attempt-status';
/** Operator-only: direct loopback callers, never a proxied or browser request. */
export const SOLVER_TESTNET_RELEASE_LANE_PATH = '/internal/solver/hyperliquid-testnet/release-lane';

const MAX_BODY_BYTES = 4_096;
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_REASONS = 8;
const MAX_EVIDENCE = 64;

export type HyperliquidTestnetExecutorRequest = Readonly<{
  attemptId: string;
  idempotencyKey: string;
}>;

/** `resolve` fences an attempt the lane never received; plain polling only reads. */
export type HyperliquidTestnetAttemptStatusRequest = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  resolve: boolean;
}>;

export type HyperliquidTestnetLaneReleaseRequest = Readonly<{
  attemptId: string;
  disposition: HyperliquidLaneReleaseDisposition;
  reason: string;
}>;

export type HyperliquidTestnetLegExecutionEvidence = Readonly<{
  legId: string;
  role: 'SPOT' | 'PERPETUAL';
  clientOrderId: `0x${string}`;
  requestedSignedBaseAtoms: string;
  filledSignedBaseAtoms: string;
  grossQuoteAtoms: string;
  feeAssetId: string;
  feeAssetDecimals: number;
  feeAtoms: string;
  venueFeeQuoteAtoms: string;
  evidenceCommitment: string;
}>;

export type HyperliquidTestnetExecutionEvidence = Readonly<{
  evidenceVersion: string;
  observedAtMs: string;
  terminalResidualBaseAtoms: string;
  terminalResidualQuoteAtoms: string;
  legs: readonly [HyperliquidTestnetLegExecutionEvidence, HyperliquidTestnetLegExecutionEvidence];
}>;

export type HyperliquidTestnetStrategyLegEvidence = Readonly<{
  legId: string;
  clientOrderId: `0x${string}`;
  plannedSignedBaseAtoms: string;
  filledSignedBaseAtoms: string;
  terminalStatus: 'FILLED' | 'UNFILLED_IOC_CANCELLED'
    | 'PARTIALLY_FILLED_IOC_CANCELLED' | 'REJECTED' | 'UNKNOWN';
  openOrderStatus: 'NONE' | 'OPEN' | 'UNKNOWN';
  orderId: number | null;
  fillCount: number;
  grossQuoteAtoms: string;
  feeAssetId: string;
  feeAssetDecimals: number;
  feeAtoms: string;
  venueFeeQuoteAtoms: string;
  observedAtMs: string | null;
  evidenceCommitment: string;
}>;

export type HyperliquidTestnetStrategyStageEvidence = Readonly<{
  batchStage: number;
  submissionStatus: 'NOT_SUBMITTED' | 'ACKNOWLEDGED' | 'REJECTED' | 'AMBIGUOUS';
  actionCommitment: string | null;
  requestCommitment: string | null;
  evidence: null | Readonly<{
    status: 'COMPLETE' | 'INCOMPLETE';
    outcome: 'COMPLETED' | 'NO_EFFECT' | 'RECOVERY_REQUIRED' | 'MANUAL_INTERVENTION' | null;
    reasons: readonly string[];
    observedAtMs: string | null;
    legs: readonly HyperliquidTestnetStrategyLegEvidence[];
    rawEvidenceCommitments: readonly string[];
  }>;
}>;

/** The operator actions of a loaded executor runtime that the loopback route exposes. */
export interface HyperliquidTestnetLaneOperator {
  releaseLane(request: HyperliquidTestnetLaneReleaseRequest): Promise<HyperliquidLaneRelease>;
}

export type HyperliquidTestnetAttemptStatusResponse = Readonly<{
  attemptId: string;
  idempotencyKey: string;
  domain: 'hypercore:testnet';
  environment: 'TESTNET';
  state: 'QUEUED' | 'EXECUTING' | 'COMPLETED' | 'INTERRUPTED' | 'UNKNOWN';
  queuePosition: number | null;
  lane: HyperliquidLaneState;
  result: HyperliquidTestnetExecutorResult | null;
}>;

export type HyperliquidTestnetExecutorResult =
  | Readonly<{
      attemptId: string;
      idempotencyKey: string;
      domain: 'hypercore:testnet';
      environment: 'TESTNET';
      status: 'CHECKPOINT_INCOMPLETE';
      reasons: readonly string[];
      rawEvidenceCommitments: readonly string[];
    }>
  | Readonly<{
      attemptId: string;
      idempotencyKey: string;
      domain: 'hypercore:testnet';
      environment: 'TESTNET';
      status: 'CHECKPOINT_FAILED' | 'SUBMISSION_CALL_FAILED' | 'SUBMISSION_RESULT_INVALID';
      errorCommitment: string;
    }>
  | Readonly<{
      attemptId: string;
      idempotencyKey: string;
      domain: 'hypercore:testnet';
      environment: 'TESTNET';
      status: 'NOT_SUBMITTED';
      evidenceStatus: 'PRECONDITION_REJECTED' | 'JOURNAL_REJECTED';
      actionCommitment: string | null;
      requestCommitment: string | null;
      errorCommitment: string;
    }>
  | Readonly<{
      attemptId: string;
      idempotencyKey: string;
      domain: 'hypercore:testnet';
      environment: 'TESTNET';
      status: 'RECONCILIATION_DEFERRED';
      submissionStatus: SubmissionStatus;
      actionCommitment: string;
      requestCommitment: string;
      errorCommitment: string;
    }>
  | Readonly<{
      attemptId: string;
      idempotencyKey: string;
      domain: 'hypercore:testnet';
      environment: 'TESTNET';
      status: 'RECONCILIATION_INCOMPLETE';
      submissionStatus: SubmissionStatus;
      packageStatus: 'RECONCILING';
      reasons: readonly string[];
      actionCommitment: string;
      requestCommitment: string;
      rawEvidenceCommitments: readonly string[];
    }>
  | Readonly<{
      attemptId: string;
      idempotencyKey: string;
      domain: 'hypercore:testnet';
      environment: 'TESTNET';
      status: 'RECONCILED';
      submissionStatus: SubmissionStatus;
      packageStatus: FinalPackageStatus;
      reasons: readonly string[];
      actionCommitment: string;
      requestCommitment: string;
      rawEvidenceCommitments: readonly string[];
      /** Account-wide deltas over the serialized window, so exactly this package's fills. */
      observedNetSpotDeltaAtoms?: string;
      observedPerpetualDeltaAtoms?: string;
      executionEvidence?: HyperliquidTestnetExecutionEvidence;
    }>
  | Readonly<{
      attemptId: string;
      idempotencyKey: string;
      domain: 'hypercore:testnet';
      environment: 'TESTNET';
      status: 'HANDOFF_REJECTED';
      reason: string;
      actionCommitment: string | null;
      requestCommitment: string | null;
    }>
  | Readonly<{
      attemptId: string;
      idempotencyKey: string;
      domain: 'hypercore:testnet';
      environment: 'TESTNET';
      status: 'STRATEGY_EXECUTION';
      packageStatus: HyperliquidStrategyRuntimeResult['status'];
      completedStages: readonly number[];
      stages: readonly HyperliquidTestnetStrategyStageEvidence[];
    }>;

type SubmissionStatus = 'ACKNOWLEDGED' | 'REJECTED' | 'AMBIGUOUS';
type FinalPackageStatus = 'NO_EFFECT' | 'COMPLETED_EXACT' | 'COMPLETED_BOUNDED' |
  'RECOVERY_REQUIRED' | 'MANUAL_INTERVENTION';

export interface HyperliquidTestnetTrustedAttemptProvider {
  resolve(attemptId: string): HyperliquidTestnetAttemptHandoff | undefined |
    Promise<HyperliquidTestnetAttemptHandoff | undefined>;
}

export interface HyperliquidTestnetAttemptHandoff {
  readonly attemptId: string;
  readonly admission: PackageAdmission;
  readonly seriesManifestHash: string;
  readonly executionClassManifestHash: string;
  readonly market: Readonly<{
    spot: Readonly<Record<string, unknown> & { assetId: number; sizeDecimals: number; universeIndex: number; tokenIndex: number }>;
    perpetual: Readonly<Record<string, unknown> & { assetId: number; sizeDecimals: number; assetIndex: number }>;
    quoteTokenIndex: number;
  }>;
  readonly limits: Readonly<{
    maxEvidenceAgeMs: number;
    maxSnapshotSkewMs: number;
    maxFillPages: number;
  }>;
  readonly selectedAtMs: number;
  readonly strategy?: Readonly<{
    sourceAttemptId: string;
    graphHash: Uint8Array;
    plan: HyperliquidStrategyExecutionPlan;
  }>;
}

export interface HyperliquidTestnetExecutorPort {
  execute(request: HyperliquidTestnetExecutorRequest): Promise<HyperliquidTestnetExecutorResult>;
  status(request: HyperliquidTestnetAttemptStatusRequest): Promise<HyperliquidTestnetAttemptStatusResponse>;
}

/** The omnibus trading account's live inventory, read under the lane lock. */
export type HyperliquidTestnetAccountInventory = Readonly<{
  perpetualPositionAtoms: bigint;
  spotBalanceAtoms: bigint;
}>;

export type HyperliquidTestnetExecutorRuntime = Readonly<{
  attempts: HyperliquidTestnetTrustedAttemptProvider;
  preflight(attempt: HyperliquidTestnetAttemptHandoff): Promise<HyperliquidTestnetAccountInventory | void>;
  prepareAttempt(
    attempt: HyperliquidTestnetAttemptHandoff,
    inventory?: HyperliquidTestnetAccountInventory,
  ): HyperliquidTestnetRuntimeCoordinatorInput;
  coordinator: HyperliquidTestnetRuntimeCoordinator<unknown, unknown>;
  executeStrategy?(attempt: HyperliquidTestnetAttemptHandoff): Promise<HyperliquidStrategyRuntimeResult>;
  /** The durable lane; absent, the executor serializes in memory for this process only. */
  lane?: HyperliquidTestnetLane;
}>;

export type HyperliquidTestnetExecutorRuntimeFactory = () => HyperliquidTestnetExecutorRuntime;

export class HyperliquidTestnetExecutorError extends Error {
  readonly code: 'INVALID_REQUEST' | 'ATTEMPT_NOT_FOUND' | 'ATTEMPT_IDENTITY_MISMATCH' |
    'INVALID_ATTEMPT' | 'INVALID_RESULT' | 'ATTEMPT_INTERRUPTED';

  constructor(code: HyperliquidTestnetExecutorError['code'], message: string) {
    super(message);
    this.name = 'HyperliquidTestnetExecutorError';
    this.code = code;
  }
}

function requireCondition(condition: boolean, code: HyperliquidTestnetExecutorError['code'], message: string):
asserts condition {
  if (!condition) throw new HyperliquidTestnetExecutorError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function parseRequest(value: unknown): HyperliquidTestnetExecutorRequest {
  requireCondition(isRecord(value), 'INVALID_REQUEST', 'request must be an object');
  requireCondition(hasExactKeys(value, ['attemptId', 'idempotencyKey']), 'INVALID_REQUEST',
    'request must contain only attemptId and idempotencyKey');
  requireCondition(typeof value.attemptId === 'string' && ID.test(value.attemptId),
    'INVALID_REQUEST', 'attemptId is invalid');
  requireCondition(typeof value.idempotencyKey === 'string' && ID.test(value.idempotencyKey),
    'INVALID_REQUEST', 'idempotencyKey is invalid');
  return Object.freeze({ attemptId: value.attemptId, idempotencyKey: value.idempotencyKey });
}

function parseStatusRequest(value: unknown): HyperliquidTestnetAttemptStatusRequest {
  requireCondition(isRecord(value), 'INVALID_REQUEST', 'request must be an object');
  requireCondition(hasExactKeys(value, ['attemptId', 'idempotencyKey', 'resolve']), 'INVALID_REQUEST',
    'request must contain only attemptId, idempotencyKey, and resolve');
  requireCondition(typeof value.resolve === 'boolean', 'INVALID_REQUEST', 'resolve must be a boolean');
  const identity = parseRequest({ attemptId: value.attemptId, idempotencyKey: value.idempotencyKey });
  return Object.freeze({ ...identity, resolve: value.resolve });
}

export function parseHyperliquidTestnetLaneReleaseRequest(value: unknown): HyperliquidTestnetLaneReleaseRequest {
  requireCondition(isRecord(value), 'INVALID_REQUEST', 'request must be an object');
  requireCondition(hasExactKeys(value, ['attemptId', 'disposition', 'reason']), 'INVALID_REQUEST',
    'request must contain only attemptId, disposition, and reason');
  requireCondition(typeof value.attemptId === 'string' && ID.test(value.attemptId),
    'INVALID_REQUEST', 'attemptId is invalid');
  requireCondition(value.disposition === 'FINAL' || value.disposition === 'ABANDONED',
    'INVALID_REQUEST', 'disposition must be FINAL or ABANDONED');
  requireCondition(typeof value.reason === 'string' && HYPERLIQUID_LANE_RELEASE_REASON.test(value.reason)
    && value.reason.trim().length >= 8, 'INVALID_REQUEST',
  'reason must be 8 to 280 printable ASCII characters');
  return Object.freeze({ attemptId: value.attemptId, disposition: value.disposition, reason: value.reason });
}

/** A lane refusal: nothing was signed or sent, and the reason is committed rather than echoed. */
export function hyperliquidLaneNotSubmitted(
  attemptId: string,
  idempotencyKey: string,
  reason: HyperliquidLaneNotSubmittedReason,
): HyperliquidTestnetExecutorResult {
  return Object.freeze({
    attemptId,
    idempotencyKey,
    domain: 'hypercore:testnet' as const,
    environment: 'TESTNET' as const,
    status: 'NOT_SUBMITTED' as const,
    evidenceStatus: 'PRECONDITION_REJECTED' as const,
    actionCommitment: null,
    requestCommitment: null,
    errorCommitment: `0x${createHash('sha256')
      .update(JSON.stringify({ name: 'HyperliquidTestnetLane', reason })).digest('hex')}`,
  });
}

function signedAtoms(value: unknown): string | undefined {
  return typeof value === 'bigint' ? value.toString() : undefined;
}

function safeInteger(value: unknown, name: string, positive = false): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value)
    && (positive ? value > 0 : value >= 0), 'INVALID_ATTEMPT', `${name} is invalid`);
  return value;
}

export function validateHyperliquidTestnetRuntimeAttempt(
  expectedAttemptId: string,
  value: unknown,
): HyperliquidTestnetAttemptHandoff {
  requireCondition(isRecord(value), 'INVALID_ATTEMPT', 'attempt provider returned an invalid attempt');
  const baseKeys = [
    'admission', 'attemptId', 'executionClassManifestHash', 'limits', 'market',
    'selectedAtMs', 'seriesManifestHash',
  ];
  const strategyShape = 'strategy' in value;
  requireCondition(hasExactKeys(value, strategyShape ? [...baseKeys, 'strategy'] : baseKeys),
    'INVALID_ATTEMPT', 'attempt provider fields are invalid');
  const input = value as unknown as HyperliquidTestnetAttemptHandoff;
  requireCondition(input.attemptId === expectedAttemptId, 'ATTEMPT_IDENTITY_MISMATCH',
    'resolved attempt identity does not match the request');
  requireCondition(isRecord(input.admission) && isRecord(input.market) && isRecord(input.limits),
    'INVALID_ATTEMPT', 'attempt admission, market, or limits are invalid');
  requireCondition(typeof input.seriesManifestHash === 'string' && /^[0-9a-f]{64}$/.test(input.seriesManifestHash)
    && !/^0+$/.test(input.seriesManifestHash), 'INVALID_ATTEMPT', 'series manifest hash is invalid');
  requireCondition(typeof input.executionClassManifestHash === 'string'
    && /^[0-9a-f]{64}$/.test(input.executionClassManifestHash)
    && !/^0+$/.test(input.executionClassManifestHash), 'INVALID_ATTEMPT', 'execution class manifest hash is invalid');
  safeInteger(input.selectedAtMs, 'selectedAtMs', true);
  for (const field of ['maxEvidenceAgeMs', 'maxSnapshotSkewMs', 'maxFillPages'] as const) {
    safeInteger(input.limits[field], `limits.${field}`, true);
  }
  if (strategyShape) {
    requireCondition(isRecord(input.strategy)
      && hasExactKeys(input.strategy, ['graphHash', 'plan', 'sourceAttemptId']),
    'INVALID_ATTEMPT', 'strategy attempt fields are invalid');
    requireCondition(/^hyperliquid-testnet-[0-9a-f]{48}$/.test(input.strategy.sourceAttemptId),
      'INVALID_ATTEMPT', 'strategy source attempt identity is invalid');
    requireCondition(input.strategy.graphHash instanceof Uint8Array
      && input.strategy.graphHash.length === 32
      && input.strategy.graphHash.some((byte) => byte !== 0),
    'INVALID_ATTEMPT', 'strategy graph hash is invalid');
    requireCondition(isRecord(input.strategy.plan)
      && input.strategy.plan.version === 1
      && input.strategy.plan.guarantee === 'BATCHED_IOC_WITH_BOUNDED_RECOVERY',
    'INVALID_ATTEMPT', 'strategy plan is invalid');
  }
  return input;
}

function commitment(value: unknown, name: string): string {
  requireCondition(typeof value === 'string' && HASH.test(value) && !/^0x0+$/.test(value),
    'INVALID_RESULT', `${name} is invalid`);
  return value;
}

function nullableCommitment(value: unknown, name: string): string | null {
  return value === null ? null : commitment(value, name);
}

function reasons(value: unknown, allowEmpty: boolean): readonly string[] {
  requireCondition(Array.isArray(value) && value.length <= MAX_REASONS
    && (allowEmpty || value.length > 0), 'INVALID_RESULT', 'reasons are invalid');
  const unique = new Set<string>();
  const result = value.map((reason, index) => {
    requireCondition(typeof reason === 'string' && REASON.test(reason),
      'INVALID_RESULT', `reasons[${index}] is invalid`);
    requireCondition(!unique.has(reason), 'INVALID_RESULT', 'reasons must not repeat');
    unique.add(reason);
    return reason;
  });
  return Object.freeze(result);
}

function evidenceCommitments(value: unknown): readonly string[] {
  requireCondition(Array.isArray(value) && value.length <= MAX_EVIDENCE,
    'INVALID_RESULT', 'evidence commitments are invalid');
  return Object.freeze(value.map((entry, index) => {
    requireCondition(isRecord(entry), 'INVALID_RESULT', `evidence[${index}] is invalid`);
    return commitment(entry.sha256, `evidence[${index}].sha256`);
  }));
}

function submissionStatus(submission: HyperliquidPackageSubmissionResult): SubmissionStatus {
  if (submission.status === 'SUBMISSION_ACKNOWLEDGED') return 'ACKNOWLEDGED';
  if (submission.status === 'SUBMISSION_REJECTED') return 'REJECTED';
  if (submission.status === 'SUBMISSION_AMBIGUOUS') return 'AMBIGUOUS';
  throw new HyperliquidTestnetExecutorError('INVALID_RESULT', 'submission status is invalid');
}

function unsignedInteger(value: unknown, name: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= 0n, 'INVALID_RESULT', `${name} is invalid`);
  return value;
}

function signedInteger(value: unknown, name: string): bigint {
  requireCondition(typeof value === 'bigint', 'INVALID_RESULT', `${name} is invalid`);
  return value;
}

function positiveSafeInteger(value: unknown, name: string): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    'INVALID_RESULT', `${name} is invalid`);
  return value;
}

function nonnegativeSafeInteger(value: unknown, name: string): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'INVALID_RESULT', `${name} is invalid`);
  return value;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

function divideUp(numerator: bigint, denominator: bigint): bigint {
  requireCondition(numerator >= 0n && denominator > 0n, 'INVALID_RESULT',
    'execution evidence division is invalid');
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function quoteAtomsForFill(
  fill: Record<string, unknown>,
  baseDecimals: number,
  quoteDecimals: number,
  baseAtoms: bigint,
  roundUp: boolean,
): bigint {
  requireCondition(isRecord(fill.price), 'INVALID_RESULT', 'execution fill price is invalid');
  const coefficient = unsignedInteger(fill.price.coefficient, 'execution fill price coefficient');
  const scale = nonnegativeSafeInteger(fill.price.scale, 'execution fill price scale');
  requireCondition(coefficient > 0n && scale <= 30, 'INVALID_RESULT',
    'execution fill price is invalid');
  const numerator = coefficient * absolute(baseAtoms) * pow10(quoteDecimals);
  const denominator = pow10(scale + baseDecimals);
  return roundUp ? divideUp(numerator, denominator) : numerator / denominator;
}

function executionEvidenceCommitment(
  actionCommitment: string,
  requestCommitment: string,
  rawEvidenceCommitments: readonly string[],
  evidence: Omit<HyperliquidTestnetLegExecutionEvidence, 'evidenceCommitment'>,
): string {
  return `0x${createHash('sha256')
    .update('NARYX/hyperliquid-testnet/leg-execution-evidence/v1', 'ascii')
    .update(stringifyProtocolJson({
      actionCommitment,
      requestCommitment,
      rawEvidenceCommitments,
      evidence,
    }, 'solver.hyperliquidTestnet.legExecutionEvidence'))
    .digest('hex')}`;
}

function executionEvidence(
  reconciliation: Record<string, unknown>,
  actionCommitment: string,
  requestCommitment: string,
  rawEvidenceCommitments: readonly string[],
): HyperliquidTestnetExecutionEvidence | undefined {
  const attempt = reconciliation.attempt;
  if (!isRecord(attempt) || attempt.acceptedEvidence === null
    || attempt.acceptedEvidence === undefined) return undefined;
  requireCondition(isRecord(attempt.acceptedEvidence) && isRecord(attempt.plan),
    'INVALID_RESULT', 'accepted execution evidence is invalid');
  const accepted = attempt.acceptedEvidence;
  const plan = attempt.plan;
  requireCondition(Array.isArray(plan.legs) && plan.legs.length === 2
    && Array.isArray(reconciliation.observedFills), 'INVALID_RESULT',
  'accepted execution evidence is invalid');
  const plannedLegs = plan.legs as unknown[];
  const observedFills = reconciliation.observedFills as unknown[];
  const evidenceVersion = unsignedInteger(accepted.evidenceVersion, 'evidenceVersion');
  const observedAtMs = unsignedInteger(accepted.observedAtMs, 'observedAtMs');
  requireCondition(evidenceVersion > 0n && observedAtMs > 0n, 'INVALID_RESULT',
    'accepted execution evidence is stale');
  requireCondition(isRecord(accepted.spot) && isRecord(accepted.perpetual)
    && Array.isArray(accepted.fees), 'INVALID_RESULT', 'accepted execution evidence is invalid');

  const normalizedFees = new Map<string, bigint>();
  for (const [index, rawFee] of accepted.fees.entries()) {
    requireCondition(isRecord(rawFee) && typeof rawFee.assetId === 'string'
      && rawFee.assetId.length > 0 && rawFee.assetId.length <= 128,
    'INVALID_RESULT', `accepted fee ${index} is invalid`);
    const decimals = nonnegativeSafeInteger(rawFee.assetDecimals, `accepted fee ${index} decimals`);
    requireCondition(decimals <= 30 && rawFee.evidenceStatus === 'CONFIRMED',
      'INVALID_RESULT', `accepted fee ${index} is invalid`);
    const amount = unsignedInteger(rawFee.amountAtoms, `accepted fee ${index} amount`);
    const key = `${rawFee.assetId}\u0000${decimals}`;
    normalizedFees.set(key, (normalizedFees.get(key) ?? 0n) + amount);
  }

  const roles = ['SPOT', 'PERPETUAL'] as const;
  const legs = roles.map((role): HyperliquidTestnetLegExecutionEvidence => {
    const leg = plannedLegs.find((candidate) => isRecord(candidate) && candidate.role === role);
    const acceptedLeg = role === 'SPOT' ? accepted.spot : accepted.perpetual;
    requireCondition(isRecord(acceptedLeg), 'INVALID_RESULT', `${role} accepted evidence is invalid`);
    requireCondition(isRecord(leg) && isRecord(leg.baseAsset) && isRecord(leg.quoteAsset)
      && typeof leg.legId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(leg.legId)
      && typeof leg.clientOrderId === 'string' && /^0x[0-9a-f]{32}$/.test(leg.clientOrderId),
    'INVALID_RESULT', `${role} execution plan evidence is invalid`);
    const baseAsset = leg.baseAsset;
    const quoteAsset = leg.quoteAsset;
    requireCondition(typeof baseAsset.assetId === 'string' && baseAsset.assetId.length > 0
      && typeof quoteAsset.assetId === 'string' && quoteAsset.assetId.length > 0,
    'INVALID_RESULT', `${role} execution assets are invalid`);
    const baseDecimals = nonnegativeSafeInteger(baseAsset.decimals, `${role} base decimals`);
    const quoteDecimals = nonnegativeSafeInteger(quoteAsset.decimals, `${role} quote decimals`);
    requireCondition(baseDecimals <= 30 && quoteDecimals <= 30,
      'INVALID_RESULT', `${role} execution asset decimals are invalid`);
    const requested = signedInteger(leg.signedBaseDeltaAtoms, `${role} requested quantity`);
    const filled = signedInteger(acceptedLeg.filledSignedBaseAtoms, `${role} filled quantity`);
    requireCondition(acceptedLeg.clientOrderId === leg.clientOrderId,
      'INVALID_RESULT', `${role} client order identity is invalid`);
    const fills = observedFills.filter((candidate) => isRecord(candidate)
      && candidate.clientOrderId === leg.clientOrderId) as Record<string, unknown>[];
    requireCondition(fills.reduce((sum, fill) => sum
      + signedInteger(fill.signedBaseAtoms, `${role} fill quantity`), 0n) === filled,
    'INVALID_RESULT', `${role} observed fills do not reconcile`);
    let grossQuoteAtoms = 0n;
    let feeAtoms = 0n;
    let venueFeeQuoteAtoms = 0n;
    for (const fill of fills) {
      const fillAtoms = signedInteger(fill.signedBaseAtoms, `${role} fill quantity`);
      const fillFeeAtoms = unsignedInteger(fill.feeAtoms, `${role} fill fee`);
      positiveSafeInteger(fill.observedAtMs, `${role} fill observation time`);
      requireCondition(typeof fill.feeToken === 'string' && fill.feeToken.length > 0,
        'INVALID_RESULT', `${role} fill fee token is invalid`);
      const quoteValue = quoteAtomsForFill(
        fill, baseDecimals, quoteDecimals, fillAtoms, fillAtoms > 0n,
      );
      grossQuoteAtoms += quoteValue;
      feeAtoms += fillFeeAtoms;
      venueFeeQuoteAtoms += role === 'SPOT' && requested > 0n
        ? quoteAtomsForFill(fill, baseDecimals, quoteDecimals, fillFeeAtoms, true)
        : fillFeeAtoms;
    }
    const feeAsset = role === 'SPOT' && requested > 0n ? baseAsset : quoteAsset;
    const feeAssetId = feeAsset.assetId as string;
    const feeAssetDecimals = role === 'SPOT' && requested > 0n ? baseDecimals : quoteDecimals;
    const key = `${feeAssetId}\u0000${feeAssetDecimals}`;
    normalizedFees.set(key, (normalizedFees.get(key) ?? 0n) - feeAtoms);
    const normalized = Object.freeze({
      legId: leg.legId as string,
      role,
      clientOrderId: leg.clientOrderId as `0x${string}`,
      requestedSignedBaseAtoms: requested.toString(),
      filledSignedBaseAtoms: filled.toString(),
      grossQuoteAtoms: grossQuoteAtoms.toString(),
      feeAssetId,
      feeAssetDecimals,
      feeAtoms: feeAtoms.toString(),
      venueFeeQuoteAtoms: venueFeeQuoteAtoms.toString(),
    });
    return Object.freeze({
      ...normalized,
      evidenceCommitment: executionEvidenceCommitment(
        actionCommitment, requestCommitment, rawEvidenceCommitments, normalized,
      ),
    });
  }) as [HyperliquidTestnetLegExecutionEvidence, HyperliquidTestnetLegExecutionEvidence];
  requireCondition([...normalizedFees.values()].every((amount) => amount === 0n),
    'INVALID_RESULT', 'accepted fees do not reconcile with observed fills');
  const netSpot = signedInteger(accepted.netSpotDeltaAtoms, 'net spot delta');
  const perpetual = signedInteger(accepted.perpetualPositionDeltaAtoms, 'perpetual delta');
  const residualBase = absolute(netSpot + perpetual);
  let residualQuote = 0n;
  requireCondition(isRecord(plan.terminalResidualPolicy), 'INVALID_RESULT',
    'terminal residual policy is invalid');
  if (plan.terminalResidualPolicy.kind === 'EXACT_NET') {
    requireCondition(residualBase === 0n, 'INVALID_RESULT',
      'exact execution evidence contains a residual');
  } else {
    requireCondition(plan.terminalResidualPolicy.kind === 'BOUNDED_NET'
      && isRecord(plan.terminalResidualPolicy.residualValuationReferencePrice),
    'INVALID_RESULT', 'terminal residual policy is invalid');
    const price = plan.terminalResidualPolicy.residualValuationReferencePrice;
    const quoteAtoms = unsignedInteger(price.quoteAtoms, 'residual valuation quote atoms');
    const baseAtoms = unsignedInteger(price.baseAtoms, 'residual valuation base atoms');
    requireCondition(quoteAtoms > 0n && baseAtoms > 0n, 'INVALID_RESULT',
      'terminal residual valuation is invalid');
    residualQuote = divideUp(residualBase * quoteAtoms, baseAtoms);
  }
  return Object.freeze({
    evidenceVersion: evidenceVersion.toString(),
    observedAtMs: observedAtMs.toString(),
    terminalResidualBaseAtoms: residualBase.toString(),
    terminalResidualQuoteAtoms: residualQuote.toString(),
    legs: Object.freeze(legs),
  });
}

function base(request: HyperliquidTestnetExecutorRequest) {
  return {
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    domain: 'hypercore:testnet' as const,
    environment: 'TESTNET' as const,
  };
}

function sanitizeResult(
  request: HyperliquidTestnetExecutorRequest,
  result: HyperliquidTestnetRuntimeCoordinatorResult<unknown, unknown>,
): HyperliquidTestnetExecutorResult {
  if (result.status === 'CHECKPOINT_INCOMPLETE') {
    requireCondition(result.attemptId === request.attemptId, 'INVALID_RESULT',
      'checkpoint attempt identity is invalid');
    return Object.freeze({
      ...base(request), status: result.status,
      reasons: reasons(result.reasons, false),
      rawEvidenceCommitments: evidenceCommitments(result.rawResponseCommitments),
    });
  }
  if (result.status === 'CHECKPOINT_FAILED' || result.status === 'SUBMISSION_CALL_FAILED'
    || result.status === 'SUBMISSION_RESULT_INVALID') {
    requireCondition(result.attemptId === request.attemptId, 'INVALID_RESULT',
      'result attempt identity is invalid');
    return Object.freeze({
      ...base(request), status: result.status,
      errorCommitment: commitment(result.errorCommitment, 'errorCommitment'),
    });
  }
  if (result.status === 'NOT_SUBMITTED') {
    const submission = result.submission;
    requireCondition(submission.attemptId === request.attemptId, 'INVALID_RESULT',
      'submission attempt identity is invalid');
    return Object.freeze({
      ...base(request), status: result.status,
      evidenceStatus: submission.evidenceStatus,
      actionCommitment: nullableCommitment(submission.actionCommitment, 'actionCommitment'),
      requestCommitment: nullableCommitment(submission.requestCommitment, 'requestCommitment'),
      errorCommitment: commitment(submission.errorCommitment, 'errorCommitment'),
    });
  }
  const submission = result.submission;
  requireCondition(submission.attemptId === request.attemptId, 'INVALID_RESULT',
    'submission attempt identity is invalid');
  const status = submissionStatus(submission);
  const actionCommitment = commitment(submission.actionCommitment, 'actionCommitment');
  const requestCommitment = commitment(submission.requestCommitment, 'requestCommitment');
  if (result.status === 'RECONCILIATION_DEFERRED') {
    return Object.freeze({
      ...base(request), status: result.status, submissionStatus: status,
      actionCommitment, requestCommitment,
      errorCommitment: commitment(result.errorCommitment, 'errorCommitment'),
    });
  }
  requireCondition(isRecord(result.reconciliation), 'INVALID_RESULT',
    'reconciliation result is invalid');
  const reconciliation = result.reconciliation;
  if (reconciliation.status === 'HANDOFF_REJECTED') {
    requireCondition(typeof reconciliation.reason === 'string' && REASON.test(reconciliation.reason),
      'INVALID_RESULT', 'handoff rejection reason is invalid');
    return Object.freeze({
      ...base(request), status: 'HANDOFF_REJECTED' as const,
      reason: reconciliation.reason,
      actionCommitment,
      requestCommitment,
    });
  }
  requireCondition(reconciliation.status === 'EVIDENCE_INCOMPLETE'
    || reconciliation.status === 'RECONCILED', 'INVALID_RESULT',
  'reconciliation status is invalid');
  requireCondition(isRecord(reconciliation.attempt), 'INVALID_RESULT',
    'reconciled attempt is invalid');
  const packageStatus = reconciliation.attempt.status;
  const rawEvidenceCommitments = evidenceCommitments(reconciliation.rawResponseCommitments);
  if (reconciliation.status === 'EVIDENCE_INCOMPLETE') {
    requireCondition(packageStatus === 'RECONCILING', 'INVALID_RESULT',
      'incomplete evidence must remain reconciling');
    return Object.freeze({
      ...base(request), status: 'RECONCILIATION_INCOMPLETE' as const,
      submissionStatus: status, packageStatus,
      reasons: reasons(reconciliation.reasons, false),
      actionCommitment, requestCommitment, rawEvidenceCommitments,
    });
  }
  requireCondition(packageStatus === 'NO_EFFECT' || packageStatus === 'COMPLETED_EXACT'
    || packageStatus === 'COMPLETED_BOUNDED' || packageStatus === 'RECOVERY_REQUIRED'
    || packageStatus === 'MANUAL_INTERVENTION', 'INVALID_RESULT',
  'final package status is invalid');
  const evidence = isRecord(reconciliation.attempt.acceptedEvidence)
    ? reconciliation.attempt.acceptedEvidence : undefined;
  const netSpot = signedAtoms(evidence?.netSpotDeltaAtoms);
  const perpetual = signedAtoms(evidence?.perpetualPositionDeltaAtoms);
  const normalizedExecutionEvidence = packageStatus === 'MANUAL_INTERVENTION'
    ? undefined
    : executionEvidence(
      reconciliation, actionCommitment, requestCommitment, rawEvidenceCommitments,
    );
  return Object.freeze({
    ...base(request), status: 'RECONCILED' as const,
    submissionStatus: status, packageStatus,
    reasons: reasons(reconciliation.attempt.reasons,
      packageStatus === 'NO_EFFECT' || packageStatus === 'COMPLETED_EXACT'
        || packageStatus === 'COMPLETED_BOUNDED'),
    actionCommitment, requestCommitment, rawEvidenceCommitments,
    ...(netSpot === undefined || perpetual === undefined ? {} : {
      observedNetSpotDeltaAtoms: netSpot,
      observedPerpetualDeltaAtoms: perpetual,
    }),
    ...(normalizedExecutionEvidence === undefined ? {} : {
      executionEvidence: normalizedExecutionEvidence,
    }),
  });
}

const STRATEGY_PACKAGE_STATUSES = new Set<HyperliquidStrategyRuntimeResult['status']>([
  'COMPLETED',
  'NO_EFFECT',
  'RECOVERY_REQUIRED',
  'MANUAL_INTERVENTION',
  'EVIDENCE_INCOMPLETE',
  'SUBMISSION_FAILED',
]);

function strategySubmissionStatus(value: unknown):
HyperliquidTestnetStrategyStageEvidence['submissionStatus'] {
  if (value === 'NOT_SUBMITTED') return 'NOT_SUBMITTED';
  if (value === 'SUBMISSION_ACKNOWLEDGED') return 'ACKNOWLEDGED';
  if (value === 'SUBMISSION_REJECTED') return 'REJECTED';
  if (value === 'SUBMISSION_AMBIGUOUS') return 'AMBIGUOUS';
  throw new HyperliquidTestnetExecutorError('INVALID_RESULT', 'strategy submission status is invalid');
}

function strategyStageEvidence(value: HyperliquidStrategyRuntimeResult['stages'][number]):
HyperliquidTestnetStrategyStageEvidence {
  const submission = value.submission;
  requireCondition(submission.batchStage === value.batchStage,
    'INVALID_RESULT', 'strategy submission stage is invalid');
  const actionCommitment = nullableCommitment(submission.actionCommitment, 'strategy actionCommitment');
  const requestCommitment = nullableCommitment(submission.requestCommitment, 'strategy requestCommitment');
  const submissionState = strategySubmissionStatus(submission.status);
  if (value.evidence === null) {
    requireCondition(submissionState === 'NOT_SUBMITTED' && submission.reconciliation === null,
      'INVALID_RESULT', 'strategy submission without evidence is invalid');
    return Object.freeze({
      batchStage: value.batchStage,
      submissionStatus: submissionState,
      actionCommitment,
      requestCommitment,
      evidence: null,
    });
  }
  const evidence = value.evidence;
  const reconciliation = submission.reconciliation;
  requireCondition(submission.reconciliation !== null && evidence.legs.length > 0
    && evidence.legs.length <= 16, 'INVALID_RESULT', 'strategy evidence legs are invalid');
  requireCondition(reconciliation !== null
    && reconciliation.batchStage === value.batchStage
    && reconciliation.actionHash === actionCommitment
    && reconciliation.requestCommitment === requestCommitment
    && reconciliation.legIds.length === evidence.legs.length
    && reconciliation.clientOrderIds.length === evidence.legs.length,
  'INVALID_RESULT', 'strategy reconciliation handoff is invalid');
  requireCondition((evidence.status === 'COMPLETE' && evidence.outcome !== null)
    || (evidence.status === 'INCOMPLETE' && evidence.outcome === null),
  'INVALID_RESULT', 'strategy evidence status is invalid');
  requireCondition((evidence.status === 'COMPLETE' && Number.isSafeInteger(evidence.observedAtMs)
      && evidence.observedAtMs > 0)
    || (evidence.status === 'INCOMPLETE' && (evidence.observedAtMs === null
      || Number.isSafeInteger(evidence.observedAtMs) && evidence.observedAtMs > 0)),
  'INVALID_RESULT', 'strategy evidence observation time is invalid');
  const rawEvidenceCommitments = evidenceCommitments(evidence.rawResponseCommitments);
  const legIds = new Set<string>();
  const clientOrderIds = new Set<string>();
  const legs = evidence.legs.map((leg, index): HyperliquidTestnetStrategyLegEvidence => {
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(leg.legId)
      && /^0x[0-9a-f]{32}$/.test(leg.clientOrderId)
      && !legIds.has(leg.legId) && !clientOrderIds.has(leg.clientOrderId),
    'INVALID_RESULT', `strategy evidence leg ${index} identity is invalid`);
    requireCondition(reconciliation.legIds[index] === leg.legId
      && reconciliation.clientOrderIds[index] === leg.clientOrderId,
    'INVALID_RESULT', `strategy evidence leg ${index} does not match its handoff`);
    requireCondition(typeof leg.plannedSignedBaseAtoms === 'bigint'
      && typeof leg.filledSignedBaseAtoms === 'bigint'
      && (leg.terminalStatus === 'FILLED' || leg.terminalStatus === 'UNFILLED_IOC_CANCELLED'
        || leg.terminalStatus === 'PARTIALLY_FILLED_IOC_CANCELLED'
        || leg.terminalStatus === 'REJECTED' || leg.terminalStatus === 'UNKNOWN')
      && (leg.openOrderStatus === 'NONE' || leg.openOrderStatus === 'OPEN'
        || leg.openOrderStatus === 'UNKNOWN')
      && (leg.orderId === null || Number.isSafeInteger(leg.orderId) && leg.orderId > 0)
      && Number.isSafeInteger(leg.fillCount) && leg.fillCount >= 0
      && typeof leg.grossQuoteAtoms === 'bigint' && leg.grossQuoteAtoms >= 0n
      && typeof leg.feeAssetId === 'string' && leg.feeAssetId.length > 0
      && leg.feeAssetId.length <= 128
      && Number.isSafeInteger(leg.feeAssetDecimals) && leg.feeAssetDecimals >= 0
      && leg.feeAssetDecimals <= 30
      && typeof leg.feeAtoms === 'bigint' && leg.feeAtoms >= 0n
      && typeof leg.venueFeeQuoteAtoms === 'bigint' && leg.venueFeeQuoteAtoms >= 0n
      && (leg.observedAtMs === null
        || Number.isSafeInteger(leg.observedAtMs) && leg.observedAtMs > 0),
    'INVALID_RESULT', `strategy evidence leg ${index} is invalid`);
    requireCondition((leg.fillCount === 0 && leg.observedAtMs === null
        && leg.grossQuoteAtoms === 0n && leg.feeAtoms === 0n
        && leg.venueFeeQuoteAtoms === 0n)
      || (leg.fillCount > 0 && leg.observedAtMs !== null),
    'INVALID_RESULT', `strategy evidence leg ${index} economics are inconsistent`);
    legIds.add(leg.legId);
    clientOrderIds.add(leg.clientOrderId);
    const normalized = Object.freeze({
      legId: leg.legId,
      clientOrderId: leg.clientOrderId,
      plannedSignedBaseAtoms: leg.plannedSignedBaseAtoms.toString(),
      filledSignedBaseAtoms: leg.filledSignedBaseAtoms.toString(),
      terminalStatus: leg.terminalStatus,
      openOrderStatus: leg.openOrderStatus,
      orderId: leg.orderId,
      fillCount: leg.fillCount,
      grossQuoteAtoms: leg.grossQuoteAtoms.toString(),
      feeAssetId: leg.feeAssetId,
      feeAssetDecimals: leg.feeAssetDecimals,
      feeAtoms: leg.feeAtoms.toString(),
      venueFeeQuoteAtoms: leg.venueFeeQuoteAtoms.toString(),
      observedAtMs: leg.observedAtMs === null ? null : leg.observedAtMs.toString(),
    });
    return Object.freeze({
      ...normalized,
      evidenceCommitment: `0x${createHash('sha256')
        .update('NARYX/hyperliquid-testnet/strategy-leg-evidence/v1', 'ascii')
        .update(stringifyProtocolJson({
          actionCommitment,
          requestCommitment,
          rawEvidenceCommitments,
          evidence: normalized,
        }, 'solver.hyperliquidTestnet.strategyLegEvidence'))
        .digest('hex')}`,
    });
  });
  return Object.freeze({
    batchStage: value.batchStage,
    submissionStatus: submissionState,
    actionCommitment,
    requestCommitment,
    evidence: Object.freeze({
      status: evidence.status,
      outcome: evidence.outcome,
      reasons: reasons(evidence.reasons, evidence.status === 'COMPLETE'
        && (evidence.outcome === 'COMPLETED' || evidence.outcome === 'NO_EFFECT')),
      observedAtMs: evidence.observedAtMs === null ? null : evidence.observedAtMs.toString(),
      legs: Object.freeze(legs),
      rawEvidenceCommitments,
    }),
  });
}

function sanitizeStrategyResult(
  request: HyperliquidTestnetExecutorRequest,
  result: HyperliquidStrategyRuntimeResult,
): HyperliquidTestnetExecutorResult {
  requireCondition(result.attemptId === request.attemptId
    && STRATEGY_PACKAGE_STATUSES.has(result.status)
    && result.stages.length > 0
    && result.stages.every((stage) => stage.submission.attemptId === request.attemptId),
  'INVALID_RESULT', 'strategy result is invalid');
  const completedStages = result.completedStages.map((stage) =>
    nonnegativeSafeInteger(stage, 'completed strategy stage'));
  requireCondition(new Set(completedStages).size === completedStages.length,
    'INVALID_RESULT', 'completed strategy stages repeat');
  const stages = result.stages.map((stage) => strategyStageEvidence(stage));
  requireCondition(new Set(stages.map((stage) => stage.batchStage)).size === stages.length,
    'INVALID_RESULT', 'strategy result stages repeat');
  requireCondition(stages.every((stage, index) => index === 0
    || stages[index - 1]!.batchStage < stage.batchStage)
    && completedStages.every((stage, index) => stage === stages[index]?.batchStage
      && stages[index]?.evidence?.outcome === 'COMPLETED'),
  'INVALID_RESULT', 'strategy result stage progression is invalid');
  if (result.status === 'COMPLETED') {
    requireCondition(completedStages.length === stages.length
      && stages.every((stage) => stage.evidence?.outcome === 'COMPLETED'),
    'INVALID_RESULT', 'completed strategy result is inconsistent');
  }
  if (result.status === 'NO_EFFECT') {
    requireCondition(completedStages.length === 0 && stages.length === 1
      && stages.at(-1)?.evidence?.outcome === 'NO_EFFECT',
    'INVALID_RESULT', 'no-effect strategy result is inconsistent');
  }
  if (result.status === 'SUBMISSION_FAILED') {
    requireCondition(completedStages.length === 0 && stages.length === 1
      && stages[0]?.submissionStatus === 'NOT_SUBMITTED' && stages[0].evidence === null,
    'INVALID_RESULT', 'failed strategy submission is inconsistent');
  }
  return Object.freeze({
    ...base(request),
    status: 'STRATEGY_EXECUTION' as const,
    packageStatus: result.status,
    completedStages: Object.freeze(completedStages),
    stages: Object.freeze(stages),
  });
}

const SUBMISSION_STATUS_NAMES: Readonly<Record<SubmissionStatus, HyperliquidPackageSubmissionResult['status']>> = {
  ACKNOWLEDGED: 'SUBMISSION_ACKNOWLEDGED',
  REJECTED: 'SUBMISSION_REJECTED',
  AMBIGUOUS: 'SUBMISSION_AMBIGUOUS',
};

/**
 * The executor result of a fresh keeper reconciliation of an attempt whose submission outcome the
 * lane already stored; undefined when the stored result records no submission to reconcile.
 */
export function hyperliquidReconciledExecutorResult(
  stored: HyperliquidTestnetExecutorResult,
  reconciliation: unknown,
): HyperliquidTestnetExecutorResult | undefined {
  if (stored.status !== 'RECONCILIATION_INCOMPLETE' && stored.status !== 'RECONCILIATION_DEFERRED'
    && stored.status !== 'RECONCILED') return undefined;
  const submission = {
    attemptId: stored.attemptId,
    status: SUBMISSION_STATUS_NAMES[stored.submissionStatus],
    actionCommitment: stored.actionCommitment,
    requestCommitment: stored.requestCommitment,
  } as unknown as HandoffSubmission;
  return sanitizeResult(
    { attemptId: stored.attemptId, idempotencyKey: stored.idempotencyKey },
    { status: 'RECONCILIATION_OBSERVED', submission, reconciliation },
  );
}

type HandoffSubmission = Extract<
  HyperliquidTestnetRuntimeCoordinatorResult<unknown, unknown>,
  { status: 'RECONCILIATION_OBSERVED' }
>['submission'];

export function createHyperliquidTestnetExecutor(
  factory?: HyperliquidTestnetExecutorRuntimeFactory,
): HyperliquidTestnetExecutorPort | undefined {
  if (factory === undefined) return undefined;
  const runtime = factory();
  requireCondition(runtime !== null && typeof runtime === 'object'
    && typeof runtime.attempts?.resolve === 'function'
    && typeof runtime.preflight === 'function'
    && typeof runtime.prepareAttempt === 'function'
    && typeof runtime.coordinator?.execute === 'function', 'INVALID_ATTEMPT',
  'executor runtime factory returned incomplete ports');
  const lane = runtime.lane ?? new HyperliquidTestnetLane({ notSubmitted: hyperliquidLaneNotSubmitted });
  const laneError = (error: unknown): unknown =>
    error instanceof HyperliquidTestnetLaneError
      && (error.code === 'ATTEMPT_IDENTITY_MISMATCH' || error.code === 'ATTEMPT_INTERRUPTED')
      ? new HyperliquidTestnetExecutorError(error.code, error.message)
      : error;
  return Object.freeze({
    async execute(rawRequest: HyperliquidTestnetExecutorRequest): Promise<HyperliquidTestnetExecutorResult> {
      const request = parseRequest(rawRequest);
      try {
        // Everything from the authority read to the last reconciliation runs inside the lane, so
        // the inventory read here and the deltas measured later belong to this attempt only.
        return await lane.run(request.attemptId, request.idempotencyKey, async (enterSubmission) => {
          const resolved = await runtime.attempts.resolve(request.attemptId);
          if (resolved === undefined) {
            throw new HyperliquidTestnetExecutorError('ATTEMPT_NOT_FOUND', 'attempt was not found');
          }
          const handoff = validateHyperliquidTestnetRuntimeAttempt(request.attemptId, resolved);
          const inventory = await runtime.preflight(handoff);
          if (handoff.strategy !== undefined) {
            requireCondition(typeof runtime.executeStrategy === 'function', 'INVALID_ATTEMPT',
              'executor runtime does not support generalized strategy plans');
            enterSubmission();
            return sanitizeStrategyResult(request, await runtime.executeStrategy(handoff));
          }
          const input = runtime.prepareAttempt(handoff, inventory ?? undefined);
          enterSubmission();
          return sanitizeResult(request, await runtime.coordinator.execute(input));
        });
      } catch (error) {
        throw laneError(error);
      }
    },
    async status(rawRequest: HyperliquidTestnetAttemptStatusRequest): Promise<HyperliquidTestnetAttemptStatusResponse> {
      const request = parseStatusRequest(rawRequest);
      let status;
      try {
        status = request.resolve
          ? lane.resolve(request.attemptId, request.idempotencyKey)
          : lane.status(request.attemptId, request.idempotencyKey);
      } catch (error) {
        throw laneError(error);
      }
      return Object.freeze({
        ...base(request),
        state: status.state,
        queuePosition: status.state === 'QUEUED' ? status.queuePosition : null,
        lane: lane.laneState().state,
        result: status.state === 'COMPLETED' ? status.result : null,
      });
    },
  });
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === '::1') return true;
  const value = address?.startsWith('::ffff:') === true ? address.slice(7) : address;
  if (value === undefined) return false;
  const octets = value.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const parsed = Number(octet);
    return parsed >= 0 && parsed <= 255;
  });
}

// A same-host reverse proxy forwards with these headers; an operator action never arrives that way.
function directLoopbackRequest(request: IncomingMessage): boolean {
  return isLoopbackAddress(request.socket.remoteAddress)
    && request.headers.origin === undefined
    && request.headers['x-forwarded-for'] === undefined
    && request.headers.forwarded === undefined
    && request.headers['x-real-ip'] === undefined;
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
  requireCondition(contentType === 'application/json', 'INVALID_REQUEST',
    'Content-Type must be application/json');
  const statedLength = request.headers['content-length'];
  requireCondition(statedLength === undefined || /^\d+$/.test(statedLength)
    && Number(statedLength) <= MAX_BODY_BYTES, 'INVALID_REQUEST', 'request body is too large');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    requireCondition(length <= MAX_BODY_BYTES, 'INVALID_REQUEST', 'request body is too large');
    chunks.push(bytes);
  }
  try {
    return parseProtocolJson(
      Buffer.concat(chunks).toString('utf8'),
      'solver.hyperliquidTestnet.executeRequest',
    );
  } catch {
    throw new HyperliquidTestnetExecutorError('INVALID_REQUEST', 'request body is invalid');
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(stringifyProtocolJson(body, 'solver.hyperliquidTestnet.executeResponse'));
}

function reject(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

const RELEASE_ERROR_STATUS: Readonly<Record<HyperliquidTestnetLaneError['code'], number>> = {
  INVALID_RELEASE: 400,
  LANE_NOT_BLOCKED_BY_ATTEMPT: 409,
  HOLDER_NOT_FINAL: 409,
  ATTEMPT_IDENTITY_MISMATCH: 409,
  ATTEMPT_INTERRUPTED: 409,
  LANE_CORRUPT: 500,
};

async function releaseLane(
  request: IncomingMessage,
  response: ServerResponse,
  operator: HyperliquidTestnetLaneOperator | undefined,
): Promise<void> {
  if (!directLoopbackRequest(request)) {
    reject(response, 403, 'DIRECT_LOOPBACK_REQUIRED', 'lane release is a direct loopback operator action');
    return;
  }
  if (operator === undefined) {
    reject(response, 503, 'EXECUTION_UNAVAILABLE', 'Hyperliquid Testnet execution is unavailable');
    return;
  }
  try {
    const body = parseHyperliquidTestnetLaneReleaseRequest(await readRequest(request));
    sendJson(response, 200, await operator.releaseLane(body));
  } catch (error) {
    if (error instanceof HyperliquidTestnetExecutorError) {
      reject(response, 400, error.code, error.message);
    } else if (error instanceof HyperliquidTestnetLaneError) {
      reject(response, RELEASE_ERROR_STATUS[error.code], error.code, error.message);
    } else {
      reject(response, 502, 'RELEASE_FAILED', 'Hyperliquid lane release failed closed');
    }
  }
}

export function createHyperliquidTestnetExecutorRequestHandler(
  executor?: HyperliquidTestnetExecutorPort,
  operator?: HyperliquidTestnetLaneOperator,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      reject(response, 403, 'LOOPBACK_REQUIRED', 'Hyperliquid Testnet execution is loopback-only');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    if ((url.pathname !== SOLVER_TESTNET_EXECUTE_PATH
      && url.pathname !== SOLVER_TESTNET_ATTEMPT_STATUS_PATH
      && url.pathname !== SOLVER_TESTNET_RELEASE_LANE_PATH) || url.search !== '') {
      reject(response, 404, 'NOT_FOUND', 'internal route was not found');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      reject(response, 405, 'METHOD_NOT_ALLOWED', 'only POST is allowed');
      return;
    }
    if (url.pathname === SOLVER_TESTNET_RELEASE_LANE_PATH) {
      await releaseLane(request, response, operator);
      return;
    }
    if (executor === undefined) {
      reject(response, 503, 'EXECUTION_UNAVAILABLE', 'Hyperliquid Testnet execution is unavailable');
      return;
    }
    try {
      const body = await readRequest(request);
      sendJson(response, 200, url.pathname === SOLVER_TESTNET_EXECUTE_PATH
        ? await executor.execute(parseRequest(body))
        : await executor.status(parseStatusRequest(body)));
    } catch (error) {
      if (error instanceof HyperliquidTestnetExecutorError) {
        const status = error.code === 'ATTEMPT_NOT_FOUND' ? 404
          : error.code === 'ATTEMPT_IDENTITY_MISMATCH' || error.code === 'ATTEMPT_INTERRUPTED' ? 409
            : error.code === 'INVALID_REQUEST' || error.code === 'INVALID_ATTEMPT' ? 400 : 502;
        reject(response, status, error.code, error.message);
        return;
      }
      reject(response, 502, 'EXECUTION_FAILED', 'Hyperliquid Testnet execution failed closed');
    }
  };
}

export function createHyperliquidTestnetExecutorServer(
  factory?: HyperliquidTestnetExecutorRuntimeFactory,
  operator?: HyperliquidTestnetLaneOperator,
) {
  const handler = createHyperliquidTestnetExecutorRequestHandler(
    createHyperliquidTestnetExecutor(factory),
    operator,
  );
  return createServer((request, response) => {
    handler(request, response).catch(() => {
      if (!response.headersSent) {
        reject(response, 500, 'INTERNAL_ERROR', 'request handling failed');
      } else {
        response.destroy();
      }
    });
  });
}
