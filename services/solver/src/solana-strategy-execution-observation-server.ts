import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitmentHash,
  parseProtocolJson,
  stringifyProtocolJson,
} from '@naryx/protocol-types';
import type { SolanaStrategyExecutionObservationService } from './solana-strategy-execution-observation.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY_BYTES = 4_096;

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

export function createSolanaStrategyExecutionObservationInternalHandler(
  service: Pick<SolanaStrategyExecutionObservationService, 'observe'>,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    if (url.pathname !== '/internal/strategy-executions/observe-solana' || url.search !== '') return false;
    if (!internal(request)) {
      return send(response, 403, {
        error: { code: 'FORBIDDEN', message: 'Solana execution observation answers direct loopback callers only.' },
      });
    }
    if (request.method !== 'POST') {
      return send(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is allowed.' } });
    }
    try {
      const input = await body(request);
      if (Object.keys(input).sort().join(',') !== 'quoteHash,signature'
        || typeof input.quoteHash !== 'string' || typeof input.signature !== 'string') {
        throw new Error('request must contain only quoteHash and signature');
      }
      const observation = await service.observe({
        quoteHash: commitmentHash(input.quoteHash, 'quoteHash'),
        signature: input.signature,
      });
      if (observation === undefined) {
        return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Admitted strategy package was not found.' } });
      }
      return send(response, observation.status === 'PENDING' ? 202 : 200, { version: 1, observation });
    } catch (error) {
      return send(response, 400, {
        error: {
          code: 'OBSERVATION_REJECTED',
          message: error instanceof Error ? error.message : 'Solana execution observation failed closed.',
        },
      });
    }
  };
}
