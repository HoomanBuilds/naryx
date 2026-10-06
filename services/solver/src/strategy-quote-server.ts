import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseProtocolJson,
  stringifyProtocolJson,
} from '@naryx/protocol-types';
import {
  GeneralizedStrategyQuoteError,
  type GeneralizedStrategyQuoteRequest,
  type GeneralizedStrategyQuoteService,
} from './strategy-quote-service.js';

const MAX_BODY_BYTES = 4_096;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function send(response: ServerResponse, status: number, body: unknown): true {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
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

async function readBody(request: IncomingMessage): Promise<GeneralizedStrategyQuoteRequest> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new GeneralizedStrategyQuoteError('INVALID_REQUEST', 'Content-Type must be application/json');
  }
  const statedLength = request.headers['content-length'];
  if (statedLength !== undefined && (!/^\d+$/.test(statedLength) || Number(statedLength) > MAX_BODY_BYTES)) {
    throw new GeneralizedStrategyQuoteError('INVALID_REQUEST', 'request body is too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new GeneralizedStrategyQuoteError('INVALID_REQUEST', 'request body is too large');
    chunks.push(bytes);
  }
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GeneralizedStrategyQuoteError('INVALID_REQUEST', 'request body must contain valid protocol JSON');
  }
  return parsed as GeneralizedStrategyQuoteRequest;
}

export function createGeneralizedStrategyQuoteInternalHandler(
  service: Pick<GeneralizedStrategyQuoteService, 'quote'>,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    if (url.pathname !== '/internal/strategy-quotes' || url.search !== '') return false;
    if (!isInternal(request)) return reject(response, 403, 'FORBIDDEN', 'Strategy quotes answer direct loopback callers only.');
    if (request.method !== 'POST') return reject(response, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
    try {
      return send(response, 200, await service.quote(await readBody(request)));
    } catch (error) {
      if (error instanceof GeneralizedStrategyQuoteError) {
        const status = error.code === 'ORDER_NOT_FOUND'
          ? 404
          : error.code === 'IDEMPOTENCY_CONFLICT' || error.code === 'QUOTE_DECLINED' ? 409 : 400;
        return reject(response, status, error.code, error.message);
      }
      return reject(response, 502, 'QUOTE_FAILED', 'Strategy quote failed closed.');
    }
  };
}
