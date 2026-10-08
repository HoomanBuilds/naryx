import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  toHex,
  type NettingAllocationExecutionAuthorization,
} from '@naryx/protocol-types';
import {
  NettingAllocationAttemptStoreError,
  type NettingAllocationExecutionAttempt,
  type NettingAllocationObservationBinding,
} from './netting-allocation-attempt-store.js';
import { internalCaller, readInternalBody, sendError, sendJson } from './internal-http.js';
import { PackageExchangeStoreError } from './package-exchange-store.js';
import type { NettingAllocationSettlementResult } from './netting-allocation-settlement-coordinator.js';

const HASH = /^[0-9a-f]{64}$/;
const ATTEMPT = /^[A-Za-z0-9_-]{16,96}$/;

export interface NettingAllocationAdminOptions {
  readonly exchange: Readonly<{
    recordNettingAllocationExecutionAuthorization(
      authorization: NettingAllocationExecutionAuthorization,
    ): { readonly replayed: boolean };
    nettingAllocationExecutionAuthorization(
      authorizationHash: Uint8Array | string,
    ): NettingAllocationExecutionAuthorization | undefined;
  }>;
  readonly attempts: Readonly<{
    save(input: Readonly<{
      attemptId: string;
      idempotencyKey: string;
      authorization: NettingAllocationExecutionAuthorization;
      observation: NettingAllocationObservationBinding;
    }>): NettingAllocationExecutionAttempt;
    bindExecutionReference(
      attemptId: string,
      authorization: NettingAllocationExecutionAuthorization,
      executionReference: string,
    ): NettingAllocationExecutionAttempt;
  }>;
  readonly settlement: Readonly<{
    settle(proofHash: Uint8Array | string): Promise<NettingAllocationSettlementResult>;
  }>;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function errorResponse(response: ServerResponse, error: unknown): true {
  if (error instanceof NettingAllocationAttemptStoreError || error instanceof PackageExchangeStoreError) {
    const status = error.code === 'CORRUPT_ROW' ? 500
      : error.code.includes('NOT_FOUND') ? 404
        : error.code.includes('CONFLICT') ? 409 : 400;
    return sendError(response, status, error.code, error.message);
  }
  return sendError(
    response,
    400,
    'NETTING_ALLOCATION_REJECTED',
    error instanceof Error ? error.message : 'Netting allocation request was rejected.',
  );
}

export function createNettingAllocationAdminHandler(
  options: NettingAllocationAdminOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? '/', 'http://internal.local');
    const createAttempt = url.pathname === '/internal/netting/allocation-attempts';
    const referenceMatch = /^\/internal\/netting\/allocation-attempts\/([A-Za-z0-9_-]{16,96})\/reference$/.exec(url.pathname);
    const settlementMatch = /^\/internal\/netting\/batches\/([0-9a-f]{64})\/settle$/.exec(url.pathname);
    if (!createAttempt && referenceMatch === null && settlementMatch === null) return false;
    if (!internalCaller(request)) {
      return sendError(response, 403, 'FORBIDDEN', 'Netting allocation controls answer loopback callers only.');
    }
    if (url.search !== '') return sendError(response, 400, 'INVALID_REQUEST', 'Query parameters are not accepted.');
    if (request.method !== 'POST') return sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
    if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
      return sendError(response, 415, 'INVALID_CONTENT_TYPE', 'Content-Type must be application/json.');
    }
    readInternalBody(request, response, (body) => {
      if (createAttempt) {
        try {
          if (!exactKeys(body, ['attemptId', 'idempotencyKey', 'authorization', 'observation'])
            || typeof body.attemptId !== 'string' || !ATTEMPT.test(body.attemptId)
            || typeof body.idempotencyKey !== 'string' || !ATTEMPT.test(body.idempotencyKey)
            || typeof body.authorization !== 'object' || body.authorization === null || Array.isArray(body.authorization)
            || typeof body.observation !== 'object' || body.observation === null || Array.isArray(body.observation)) {
            sendError(response, 400, 'INVALID_REQUEST', 'The allocation attempt body is malformed.');
            return;
          }
          const authorization = body.authorization as NettingAllocationExecutionAuthorization;
          const recorded = options.exchange.recordNettingAllocationExecutionAuthorization(authorization);
          const attempt = options.attempts.save({
            attemptId: body.attemptId,
            idempotencyKey: body.idempotencyKey,
            authorization,
            observation: body.observation as NettingAllocationObservationBinding,
          });
          sendJson(response, 200, { version: 1, authorizationReplayed: recorded.replayed, attempt });
        } catch (error) {
          errorResponse(response, error);
        }
        return;
      }
      if (referenceMatch !== null) {
        try {
          if (!exactKeys(body, ['authorizationHash', 'executionReference'])
            || typeof body.authorizationHash !== 'string' || !HASH.test(body.authorizationHash)
            || typeof body.executionReference !== 'string') {
            sendError(response, 400, 'INVALID_REQUEST', 'The execution reference body is malformed.');
            return;
          }
          const authorization = options.exchange.nettingAllocationExecutionAuthorization(body.authorizationHash);
          if (authorization === undefined || toHex(authorization.authorizationHash) !== body.authorizationHash) {
            sendError(response, 404, 'AUTHORIZATION_NOT_FOUND', 'Netting allocation authorization was not found.');
            return;
          }
          sendJson(response, 200, {
            version: 1,
            attempt: options.attempts.bindExecutionReference(
              referenceMatch[1]!,
              authorization,
              body.executionReference,
            ),
          });
        } catch (error) {
          errorResponse(response, error);
        }
        return;
      }
      if (!exactKeys(body, []) || settlementMatch === null) {
        sendError(response, 400, 'INVALID_REQUEST', 'A netting settlement request has no caller-selected fields.');
        return;
      }
      void options.settlement.settle(settlementMatch[1]!).then(
        (result) => sendJson(response, 200, { version: 1, ...result }),
        (error: unknown) => errorResponse(response, error),
      );
    });
    return true;
  };
}
