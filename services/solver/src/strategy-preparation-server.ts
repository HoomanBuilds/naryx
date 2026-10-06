import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitmentHash,
  parseProtocolJson,
  stringifyProtocolJson,
} from '@naryx/protocol-types';
import type { StrategyPreparationService } from './strategy-preparation-service.js';

const MAX_BODY_BYTES = 4_096;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function send(response: ServerResponse, status: number, body: unknown): true {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(stringifyProtocolJson(body));
  return true;
}

function reject(response: ServerResponse, status: number, code: string, message: string): true {
  return send(response, status, { error: { code, message } });
}

function isInternal(request: IncomingMessage): boolean {
  return LOOPBACK.has(request.socket.remoteAddress ?? '')
    && request.headers.origin === undefined
    && request.headers.forwarded === undefined
    && request.headers['x-forwarded-for'] === undefined
    && request.headers['x-real-ip'] === undefined;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') throw new Error('Content-Type must be application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(bytes);
  }
  const parsed = parseProtocolJson(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('request body must be an object');
  return parsed as Record<string, unknown>;
}

export function createStrategyPreparationInternalHandler(
  service: Pick<StrategyPreparationService, 'prepareByQuote'>,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    if (url.pathname !== '/internal/strategy-executions/prepare' || url.search !== '') return false;
    if (!isInternal(request)) return reject(response, 403, 'FORBIDDEN', 'Strategy preparation answers direct loopback callers only.');
    if (request.method !== 'POST') return reject(response, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
    try {
      const body = await readBody(request);
      if (Object.keys(body).length !== 1 || typeof body.quoteHash !== 'string') throw new Error('request must contain only quoteHash');
      const quoteHash = commitmentHash(body.quoteHash, 'quoteHash');
      const prepared = await service.prepareByQuote(quoteHash);
      if (prepared === undefined) return reject(response, 404, 'NOT_FOUND', 'No admitted strategy package exists for this quote.');
      return send(response, 200, { version: 1, prepared });
    } catch (error) {
      return reject(response, 400, 'PREPARATION_REJECTED', error instanceof Error ? error.message : 'Strategy preparation failed closed.');
    }
  };
}
