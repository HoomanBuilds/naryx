import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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
  requireCondition(hasExactKeys(value, [
    'admission', 'attemptId', 'executionClassManifestHash', 'limits', 'market',
    'selectedAtMs', 'seriesManifestHash',
  ]), 'INVALID_ATTEMPT', 'attempt provider fields are invalid');
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
