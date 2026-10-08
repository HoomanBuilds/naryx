import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitmentHash,
  parseProtocolJson,
  stringifyProtocolJson,
} from '@naryx/protocol-types';
import type { NettingAllocationLifecycleService } from './netting-allocation-lifecycle.js';

const REFERENCE_PATH = '/internal/netting/allocation-executions/reference';
const RECONCILE_PATH = '/internal/netting/allocation-executions/reconcile';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY_BYTES = 8_192;

function send(response: ServerResponse, status: number, value: unknown): true {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(stringifyProtocolJson(value));
  return true;
}

function internal(request: IncomingMessage): boolean {
  return LOOPBACK.has(request.socket.remoteAddress ?? '')
    && request.headers.origin === undefined
    && request.headers.forwarded === undefined
    && request.headers['x-forwarded-for'] === undefined
    && request.headers['x-real-ip'] === undefined;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new Error('Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(bytes);
  }
  const value = parseProtocolJson(Buffer.concat(chunks).toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be an object');
  }
  return value as Record<string, unknown>;
}

export function createNettingAllocationLifecycleInternalHandler(
  service: Pick<NettingAllocationLifecycleService, 'bindExecutionReference' | 'reconcile'>,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    if ((url.pathname !== REFERENCE_PATH && url.pathname !== RECONCILE_PATH) || url.search !== '') return false;
    if (!internal(request)) {
      return send(response, 403, {
        error: { code: 'FORBIDDEN', message: 'Netting allocation lifecycle answers direct loopback callers only.' },
      });
    }
    if (request.method !== 'POST') {
      return send(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is allowed.' } });
    }
    try {
      const input = await body(request);
      if (url.pathname === REFERENCE_PATH) {
        if (Object.keys(input).sort().join(',') !== 'attemptId,authorizationHash,executionReference'
          || typeof input.attemptId !== 'string'
          || typeof input.authorizationHash !== 'string'
          || typeof input.executionReference !== 'string') {
          throw new Error('request must contain exactly attemptId, authorizationHash, and executionReference');
        }
        return send(response, 200, {
          version: 1,
          attempt: await service.bindExecutionReference({
            attemptId: input.attemptId,
            authorizationHash: commitmentHash(input.authorizationHash, 'authorizationHash'),
            executionReference: input.executionReference,
          }),
        });
      }
      if (Object.keys(input).join(',') !== 'proofHash' || typeof input.proofHash !== 'string') {
        throw new Error('request must contain only proofHash');
      }
      return send(response, 200, {
        version: 1,
        reconciliation: await service.reconcile(commitmentHash(input.proofHash, 'proofHash')),
      });
    } catch (error) {
      return send(response, 400, {
        error: {
          code: 'LIFECYCLE_REJECTED',
          message: error instanceof Error ? error.message : 'Netting allocation lifecycle failed closed.',
        },
      });
    }
  };
}
