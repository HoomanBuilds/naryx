import type { IncomingMessage, ServerResponse } from 'node:http';
import { toHex, type CrossBatchClearingPolicyInput } from '@naryx/protocol-types';
import type { PrepareNextAuthoritativeCrossBatchClearingResult } from './authoritative-cross-batch-clearing.js';
import { internalCaller, readInternalBody, sendError, sendJson } from './internal-http.js';
import {
  PackageExchangeStoreError,
  type PreparedCrossBatchClearing,
} from './package-exchange-store.js';
import type { CrossBatchClearingCoordinatorResult } from './cross-batch-clearing-coordinator.js';

const HASH = /^[0-9a-f]{64}$/;

export interface CrossBatchClearingAdminOptions {
  readonly exchange: Readonly<{
    recordPreparedCrossBatchClearing(input: Readonly<{
      policy: CrossBatchClearingPolicyInput;
      sourceIntentHashes: readonly string[];
    }>): { readonly clearing: PreparedCrossBatchClearing; readonly replayed: boolean };
    crossBatchClearing(planHash: Uint8Array | string): PreparedCrossBatchClearing | undefined;
  }>;
  readonly execution?: Readonly<{
    execute(planHash: Uint8Array | string): Promise<CrossBatchClearingCoordinatorResult>;
  }>;
  readonly prepareNext?: (
    policy: CrossBatchClearingPolicyInput,
  ) => PrepareNextAuthoritativeCrossBatchClearingResult | Promise<PrepareNextAuthoritativeCrossBatchClearingResult>;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function rejected(response: ServerResponse, error: unknown): true {
  if (error instanceof PackageExchangeStoreError) {
    const status = error.code === 'CORRUPT_ROW' ? 500
      : error.code.includes('NOT_FOUND') ? 404
        : error.code.includes('CONFLICT') || error.code.includes('EXECUTED')
          || error.code === 'NETTING_INTENT_POOLED' ? 409 : 400;
    return sendError(response, status, error.code, error.message);
  }
  return sendError(
    response,
    400,
    'CROSS_BATCH_CLEARING_REJECTED',
    error instanceof Error ? error.message : 'Cross-batch clearing request was rejected.',
  );
}

export function createCrossBatchClearingAdminHandler(
  options: CrossBatchClearingAdminOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? '/', 'http://internal.local');
    const prepare = url.pathname === '/internal/netting/cross-batch/prepare';
    const prepareNext = url.pathname === '/internal/netting/cross-batch/prepare-next';
    const inspect = /^\/internal\/netting\/cross-batch\/([0-9a-f]{64})$/.exec(url.pathname);
    const execute = /^\/internal\/netting\/cross-batch\/([0-9a-f]{64})\/execute$/.exec(url.pathname);
    if (!prepare && !prepareNext && inspect === null && execute === null) return false;
    if (!internalCaller(request)) {
      return sendError(response, 403, 'FORBIDDEN', 'Cross-batch controls answer loopback callers only.');
    }
    if (url.search !== '') return sendError(response, 400, 'INVALID_REQUEST', 'Query parameters are not accepted.');
    if (inspect !== null) {
      if (request.method !== 'GET') return sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Only GET is allowed.');
      try {
        const clearing = options.exchange.crossBatchClearing(inspect[1]!);
        return clearing === undefined
          ? sendError(response, 404, 'CROSS_BATCH_PLAN_NOT_FOUND', 'Cross-batch clearing plan was not found.')
          : sendJson(response, 200, { version: 1, clearing });
      } catch (error) {
        return rejected(response, error);
      }
    }
    if (request.method !== 'POST') return sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
    if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
      return sendError(response, 415, 'INVALID_CONTENT_TYPE', 'Content-Type must be application/json.');
    }
    readInternalBody(request, response, (body) => {
      if (prepareNext) {
        if (!exactKeys(body, ['policy'])
          || typeof body.policy !== 'object' || body.policy === null || Array.isArray(body.policy)) {
          sendError(response, 400, 'INVALID_REQUEST', 'Preparation requires one cross-batch clearing policy.');
          return;
        }
        if (options.prepareNext === undefined) {
          sendError(response, 503, 'CROSS_BATCH_PREPARATION_UNAVAILABLE', 'Authoritative cross-batch preparation is disabled.');
          return;
        }
        void Promise.resolve().then(
          () => options.prepareNext!(body.policy as CrossBatchClearingPolicyInput),
        ).then(
          (result) => result.status === 'IDLE'
            ? sendJson(response, 200, { version: 1, status: 'IDLE' })
            : sendJson(response, 200, {
                version: 1,
                status: 'PREPARED',
                planHashHex: toHex(result.clearing.plan.planHash),
                policyHashHex: toHex(result.clearing.policy.policyHash),
                sourceIntentHashes: result.clearing.sourceIntents.map((intent) => toHex(intent.intentHash)),
                clearingStatus: result.clearing.status,
                executionRequired: result.clearing.status === 'PENDING' && result.clearing.intent !== undefined,
                replayed: result.replayed,
              }),
          (error: unknown) => rejected(response, error),
        );
        return;
      }
      if (prepare) {
        try {
          if (!exactKeys(body, ['policy', 'sourceIntentHashes'])
            || typeof body.policy !== 'object' || body.policy === null || Array.isArray(body.policy)
            || !Array.isArray(body.sourceIntentHashes) || body.sourceIntentHashes.length < 2
            || body.sourceIntentHashes.some((value) => typeof value !== 'string' || !HASH.test(value))) {
            sendError(response, 400, 'INVALID_REQUEST', 'Preparation requires one policy and at least two source intent hashes.');
            return;
          }
          sendJson(response, 200, {
            version: 1,
            ...options.exchange.recordPreparedCrossBatchClearing({
              policy: body.policy as CrossBatchClearingPolicyInput,
              sourceIntentHashes: body.sourceIntentHashes as string[],
            }),
          });
        } catch (error) {
          rejected(response, error);
        }
        return;
      }
      if (!exactKeys(body, []) || execute === null) {
        sendError(response, 400, 'INVALID_REQUEST', 'Execution has no caller-selected fields.');
        return;
      }
      if (options.execution === undefined) {
        sendError(response, 503, 'CROSS_BATCH_EXECUTION_UNAVAILABLE', 'Cross-batch execution is disabled.');
        return;
      }
      void options.execution.execute(execute[1]!).then(
        (result) => sendJson(response, 200, { version: 1, ...result }),
        (error: unknown) => rejected(response, error),
      );
    });
    return true;
  };
}
