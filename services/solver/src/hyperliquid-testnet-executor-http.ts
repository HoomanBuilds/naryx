import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
  type HyperliquidExecutionPlan,
} from '@naryx/adapter-hyperliquid';
import { parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import type {
  HyperliquidPackageSubmissionResult,
} from './index.js';
import type {
  HyperliquidTestnetRuntimeCoordinator,
  HyperliquidTestnetRuntimeCoordinatorInput,
  HyperliquidTestnetRuntimeCoordinatorResult,
  HyperliquidTestnetRuntimeRawCommitment,
} from './hyperliquid-testnet-runtime.js';

export const SOLVER_TESTNET_EXECUTE_PATH = '/internal/solver/hyperliquid-testnet/execute';

const MAX_BODY_BYTES = 4_096;
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const INTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const CLOID = /^0x[0-9a-f]{32}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_REASONS = 8;
const MAX_EVIDENCE = 64;
const SPOT_ASSET_OFFSET = 10_000;

export type HyperliquidTestnetExecutorRequest = Readonly<{
  attemptId: string;
  idempotencyKey: string;
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
  resolve(attemptId: string): HyperliquidTestnetRuntimeCoordinatorInput | undefined |
    Promise<HyperliquidTestnetRuntimeCoordinatorInput | undefined>;
}

export interface HyperliquidTestnetExecutorPort {
  execute(request: HyperliquidTestnetExecutorRequest): Promise<HyperliquidTestnetExecutorResult>;
}

export type HyperliquidTestnetExecutorRuntime = Readonly<{
  attempts: HyperliquidTestnetTrustedAttemptProvider;
  coordinator: HyperliquidTestnetRuntimeCoordinator<unknown, unknown>;
}>;

export type HyperliquidTestnetExecutorRuntimeFactory = () => HyperliquidTestnetExecutorRuntime;

export class HyperliquidTestnetExecutorError extends Error {
  readonly code: 'INVALID_REQUEST' | 'ATTEMPT_NOT_FOUND' | 'ATTEMPT_IDENTITY_MISMATCH' |
    'INVALID_ATTEMPT' | 'INVALID_RESULT';

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

function safeInteger(value: unknown, name: string, positive = false): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value)
    && (positive ? value > 0 : value >= 0), 'INVALID_ATTEMPT', `${name} is invalid`);
  return value;
}

function safeBigint(value: unknown, name: string, positive = false): bigint {
  requireCondition(typeof value === 'bigint' && (positive ? value > 0n : value >= 0n)
    && value <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_ATTEMPT', `${name} is invalid`);
  return value;
}

function nonzeroBytes32(value: unknown, name: string): void {
  requireCondition(value instanceof Uint8Array && value.length === 32
    && value.some((byte) => byte !== 0), 'INVALID_ATTEMPT', `${name} is invalid`);
}

function validateWindow(value: unknown, name: string, endEqualsNow: boolean): void {
  requireCondition(isRecord(value), 'INVALID_ATTEMPT', `${name} is invalid`);
  const start = safeInteger(value.startTimeMs, `${name}.startTimeMs`);
  const end = safeInteger(value.endTimeMs, `${name}.endTimeMs`);
  const now = safeInteger(value.nowMs, `${name}.nowMs`);
  safeInteger(value.maxEvidenceAgeMs, `${name}.maxEvidenceAgeMs`, true);
  safeInteger(value.maxSnapshotSkewMs, `${name}.maxSnapshotSkewMs`, true);
  requireCondition(start <= end && (endEqualsNow ? end === now : end <= now),
    'INVALID_ATTEMPT', `${name} range is invalid`);
  if (value.maxFillPages !== undefined) {
    safeInteger(value.maxFillPages, `${name}.maxFillPages`, true);
  }
}

function validateAccount(value: unknown): void {
  requireCondition(isRecord(value), 'INVALID_ATTEMPT', 'account is invalid');
  requireCondition(typeof value.masterAccount === 'string' && ADDRESS.test(value.masterAccount)
    && !/^0x0+$/.test(value.masterAccount), 'INVALID_ATTEMPT', 'master account is invalid');
  requireCondition(typeof value.tradingAccount === 'string' && ADDRESS.test(value.tradingAccount)
    && !/^0x0+$/.test(value.tradingAccount), 'INVALID_ATTEMPT', 'trading account is invalid');
  requireCondition(value.accountKind === 'MASTER' || value.accountKind === 'SUBACCOUNT',
    'INVALID_ATTEMPT', 'account kind is invalid');
  requireCondition(value.accountKind === 'MASTER'
    ? value.masterAccount === value.tradingAccount
    : value.masterAccount !== value.tradingAccount,
  'INVALID_ATTEMPT', 'account relation is invalid');
}

function validatePlan(plan: HyperliquidExecutionPlan, input: HyperliquidTestnetRuntimeCoordinatorInput): void {
  requireCondition(plan.version === 1 && plan.guarantee === HYPERCORE_EXECUTION_GUARANTEE,
    'INVALID_ATTEMPT', 'plan version or guarantee is invalid');
  requireCondition(plan.domain.domainId === 'hypercore:testnet'
    && Number.isSafeInteger(plan.domain.domainManifestVersion)
    && plan.domain.domainManifestVersion > 0, 'INVALID_ATTEMPT', 'plan domain is invalid');
  nonzeroBytes32(plan.domain.domainManifestHash, 'domainManifestHash');
  for (const [name, value] of Object.entries(plan.commitments)) {
    nonzeroBytes32(value, `commitments.${name}`);
  }
  const expiry = safeBigint(plan.requestExpiryMs, 'requestExpiryMs', true);
  requireCondition(expiry > input.nowMs && plan.unsignedRequestFields.expiresAfter === Number(expiry),
    'INVALID_ATTEMPT', 'plan expiry is invalid');
  const action = plan.unsignedRequestFields.action;
  requireCondition(action.type === 'order' && action.grouping === 'na'
    && action.orders.length === 2 && plan.legs.length === 2,
  'INVALID_ATTEMPT', 'plan must contain exactly two ungrouped IOC orders');
  const spot = plan.legs.find((leg) => leg.role === 'SPOT');
  const perpetual = plan.legs.find((leg) => leg.role === 'PERPETUAL');
  requireCondition(spot !== undefined && perpetual !== undefined && spot !== perpetual,
    'INVALID_ATTEMPT', 'plan leg roles are invalid');
  requireCondition(spot.order === action.orders[spot.legIndex]
    || JSON.stringify(spot.order) === JSON.stringify(action.orders[spot.legIndex]),
  'INVALID_ATTEMPT', 'spot leg is not bound to the action');
  requireCondition(perpetual.order === action.orders[perpetual.legIndex]
    || JSON.stringify(perpetual.order) === JSON.stringify(action.orders[perpetual.legIndex]),
  'INVALID_ATTEMPT', 'perpetual leg is not bound to the action');
  for (const leg of [spot, perpetual]) {
    requireCondition(leg.order.t.limit.tif === 'Ioc' && CLOID.test(leg.order.c)
      && leg.order.c === leg.clientOrderId, 'INVALID_ATTEMPT', 'plan IOC identity is invalid');
  }
  requireCondition(spot.clientOrderId !== perpetual.clientOrderId,
    'INVALID_ATTEMPT', 'client order IDs must differ');
  requireCondition(spot.order.a === SPOT_ASSET_OFFSET + input.binding.spotUniverseIndex
    && perpetual.order.a === input.binding.perpetualAssetIndex,
  'INVALID_ATTEMPT', 'market binding does not match plan assets');
}

export function validateHyperliquidTestnetRuntimeAttempt(
  expectedAttemptId: string,
  value: unknown,
): HyperliquidTestnetRuntimeCoordinatorInput {
  requireCondition(isRecord(value), 'INVALID_ATTEMPT', 'attempt provider returned an invalid attempt');
  requireCondition(hasExactKeys(value, [
    'account', 'agentWallet', 'attemptId', 'binding', 'checkpointWindow', 'expectedVersion',
    'nonce', 'nowMs', 'plan', 'reconciliationWindow', 'signerLeaseId', 'vaultAddress',
  ]), 'INVALID_ATTEMPT', 'attempt provider fields are invalid');
  const input = value as unknown as HyperliquidTestnetRuntimeCoordinatorInput;
  requireCondition(input.attemptId === expectedAttemptId, 'ATTEMPT_IDENTITY_MISMATCH',
    'resolved attempt identity does not match the request');
  safeBigint(input.expectedVersion, 'expectedVersion');
  safeBigint(input.nonce, 'nonce', true);
  safeBigint(input.nowMs, 'nowMs', true);
  requireCondition(typeof input.signerLeaseId === 'string' && INTERNAL_ID.test(input.signerLeaseId),
    'INVALID_ATTEMPT', 'signer lease ID is invalid');
  requireCondition(typeof input.agentWallet === 'string' && ADDRESS.test(input.agentWallet)
    && !/^0x0+$/.test(input.agentWallet), 'INVALID_ATTEMPT', 'agent wallet is invalid');
  validateAccount(input.account);
  requireCondition(input.agentWallet !== input.account.masterAccount
    && input.agentWallet !== input.account.tradingAccount,
  'INVALID_ATTEMPT', 'agent wallet must differ from account identities');
  requireCondition(input.vaultAddress === (input.account.accountKind === 'SUBACCOUNT'
    ? input.account.tradingAccount : null), 'INVALID_ATTEMPT', 'vault binding is invalid');
  for (const field of ['spotUniverseIndex', 'spotTokenIndex', 'perpetualAssetIndex',
    'quoteTokenIndex'] as const) {
    safeInteger(input.binding[field], `binding.${field}`);
  }
  validateWindow(input.checkpointWindow, 'checkpointWindow', false);
  validateWindow(input.reconciliationWindow, 'reconciliationWindow', true);
  validatePlan(input.plan, input);
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
  return Object.freeze({
    ...base(request), status: 'RECONCILED' as const,
    submissionStatus: status, packageStatus,
    reasons: reasons(reconciliation.attempt.reasons,
      packageStatus === 'NO_EFFECT' || packageStatus === 'COMPLETED_EXACT'
        || packageStatus === 'COMPLETED_BOUNDED'),
    actionCommitment, requestCommitment, rawEvidenceCommitments,
  });
}

export function createHyperliquidTestnetExecutor(
  factory?: HyperliquidTestnetExecutorRuntimeFactory,
): HyperliquidTestnetExecutorPort | undefined {
  if (factory === undefined) return undefined;
  const runtime = factory();
  requireCondition(runtime !== null && typeof runtime === 'object'
    && typeof runtime.attempts?.resolve === 'function'
    && typeof runtime.coordinator?.execute === 'function', 'INVALID_ATTEMPT',
  'executor runtime factory returned incomplete ports');
  return Object.freeze({
    async execute(rawRequest: HyperliquidTestnetExecutorRequest): Promise<HyperliquidTestnetExecutorResult> {
      const request = parseRequest(rawRequest);
      const resolved = await runtime.attempts.resolve(request.attemptId);
      if (resolved === undefined) {
        throw new HyperliquidTestnetExecutorError('ATTEMPT_NOT_FOUND', 'attempt was not found');
      }
      const input = validateHyperliquidTestnetRuntimeAttempt(request.attemptId, resolved);
      return sanitizeResult(request, await runtime.coordinator.execute(input));
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

async function readRequest(request: IncomingMessage): Promise<HyperliquidTestnetExecutorRequest> {
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
    return parseRequest(parseProtocolJson(
      Buffer.concat(chunks).toString('utf8'),
      'solver.hyperliquidTestnet.executeRequest',
    ));
  } catch (error) {
    if (error instanceof HyperliquidTestnetExecutorError) throw error;
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

export function createHyperliquidTestnetExecutorRequestHandler(
  executor?: HyperliquidTestnetExecutorPort,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      reject(response, 403, 'LOOPBACK_REQUIRED', 'Hyperliquid Testnet execution is loopback-only');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    if (url.pathname !== SOLVER_TESTNET_EXECUTE_PATH || url.search !== '') {
      reject(response, 404, 'NOT_FOUND', 'internal route was not found');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      reject(response, 405, 'METHOD_NOT_ALLOWED', 'only POST is allowed');
      return;
    }
    if (executor === undefined) {
      reject(response, 503, 'EXECUTION_UNAVAILABLE', 'Hyperliquid Testnet execution is unavailable');
      return;
    }
    try {
      sendJson(response, 200, await executor.execute(await readRequest(request)));
    } catch (error) {
      if (error instanceof HyperliquidTestnetExecutorError) {
        const status = error.code === 'ATTEMPT_NOT_FOUND' ? 404
          : error.code === 'ATTEMPT_IDENTITY_MISMATCH' ? 409
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
) {
  const handler = createHyperliquidTestnetExecutorRequestHandler(
    createHyperliquidTestnetExecutor(factory),
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
