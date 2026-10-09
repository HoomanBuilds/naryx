import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseProtocolJson,
  stringifyProtocolJson,
  type CrossBatchExternalExecutionIntent,
  type NettingExternalExecutionIntent,
} from '@naryx/protocol-types';
import {
  SolanaNettingResidualRuntimeError,
  type SolanaTestPerpNettingResidualRuntime,
} from './solana-netting-residual-runtime.js';

export const SOLANA_DEVNET_NETTING_RESIDUAL_EXECUTION_PATH =
  '/internal/netting/solana-devnet/execute-residual';
export const SOLANA_DEVNET_CROSS_BATCH_RESIDUAL_EXECUTION_PATH =
  '/internal/netting/solana-devnet/execute-cross-batch-residual';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY_BYTES = 65_536;

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

export function createSolanaDevnetNettingResidualExecutionInternalHandler(
  runtime: Pick<SolanaTestPerpNettingResidualRuntime, 'execute'>,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  if (runtime === null || typeof runtime !== 'object' || typeof runtime.execute !== 'function') {
    throw new Error('Solana residual execution runtime is required');
  }
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    const direct = url.pathname === SOLANA_DEVNET_NETTING_RESIDUAL_EXECUTION_PATH;
    const crossBatch = url.pathname === SOLANA_DEVNET_CROSS_BATCH_RESIDUAL_EXECUTION_PATH;
    if ((!direct && !crossBatch) || url.search !== '') {
      return false;
    }
    if (!internal(request)) {
      return send(response, 403, {
        error: { code: 'FORBIDDEN', message: 'Solana residual execution answers direct loopback callers only.' },
      });
    }
    if (request.method !== 'POST') {
      return send(response, 405, {
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is allowed.' },
      });
    }
    try {
      const input = await body(request);
      if (Object.keys(input).sort().join(',') !== 'idempotencyKey,intent'
        || typeof input.idempotencyKey !== 'string'
        || typeof input.intent !== 'object' || input.intent === null
        || Array.isArray(input.intent)) {
        throw new Error('request must contain only intent and idempotencyKey');
      }
      const intent = input.intent as NettingExternalExecutionIntent | CrossBatchExternalExecutionIntent;
      if (crossBatch !== ('clearingPlanHash' in intent)) {
        throw new Error('residual intent kind does not match the execution route');
      }
      const evidence = 'clearingPlanHash' in intent
        ? await runtime.execute({ intent, idempotencyKey: input.idempotencyKey })
        : await runtime.execute({ intent, idempotencyKey: input.idempotencyKey });
      return send(response, 200, { version: 1, evidence });
    } catch (error) {
      if (error instanceof SolanaNettingResidualRuntimeError) {
        return send(response, error.code === 'EVIDENCE_PENDING' ? 409 : 400, {
          error: { code: error.code, message: error.message },
        });
      }
      return send(response, 400, {
        error: {
          code: 'EXECUTION_REJECTED',
          message: error instanceof Error ? error.message : 'Residual execution failed closed.',
        },
      });
    }
  };
}
