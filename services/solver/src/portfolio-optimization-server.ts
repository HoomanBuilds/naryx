import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseProtocolJson,
  ProtocolError,
  stringifyProtocolJson,
} from '@naryx/protocol-types';
import {
  PortfolioOptimizationServiceError,
  type PortfolioOptimizationRequest,
  type PortfolioOptimizationService,
} from './portfolio-optimization-service.js';

export const PORTFOLIO_OPTIMIZATION_PATH = '/internal/portfolio-optimization';

const MAX_BODY_BYTES = 1_048_576;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

class InvalidRequestError extends Error {}

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

async function readBody(request: IncomingMessage): Promise<PortfolioOptimizationRequest> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new InvalidRequestError('Content-Type must be application/json');
  }
  const statedLength = request.headers['content-length'];
  if (statedLength !== undefined && (!/^\d+$/.test(statedLength) || Number(statedLength) > MAX_BODY_BYTES)) {
    throw new InvalidRequestError('request body is too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new InvalidRequestError('request body is too large');
    chunks.push(bytes);
  }
  const parsed = parseProtocolJson(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidRequestError('request body must be an object');
  }
  const body = parsed as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.length !== 3 || keys[0] !== 'candidates' || keys[1] !== 'decisionAtMs' || keys[2] !== 'policy') {
    throw new InvalidRequestError('request must contain only candidates, decisionAtMs, and policy');
  }
  return body as unknown as PortfolioOptimizationRequest;
}

export function createPortfolioOptimizationInternalHandler(
  service: Pick<PortfolioOptimizationService, 'decide'>,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    if (url.pathname !== PORTFOLIO_OPTIMIZATION_PATH || url.search !== '') return false;
    if (!isInternal(request)) return reject(response, 403, 'FORBIDDEN', 'Portfolio optimization answers direct loopback callers only.');
    if (request.method !== 'POST') return reject(response, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
    try {
      return send(response, 200, service.decide(await readBody(request)));
    } catch (error) {
      if (error instanceof PortfolioOptimizationServiceError) {
        return send(response, 409, {
          error: { code: error.code, message: error.message },
          decision: error.decision,
        });
      }
      if (error instanceof InvalidRequestError || error instanceof ProtocolError || error instanceof SyntaxError) {
        return reject(response, 400, 'INVALID_REQUEST', 'Portfolio optimization request is invalid.');
      }
      return reject(response, 500, 'OPTIMIZATION_FAILED', 'Portfolio optimization failed closed.');
    }
  };
}
