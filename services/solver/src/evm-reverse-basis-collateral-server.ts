import type { IncomingMessage, ServerResponse } from 'node:http';
import { commitmentHash, parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import type { EvmPackageCollateralAction } from '@naryx/adapter-evm';
import type { EvmReverseBasisCollateralService } from './evm-reverse-basis-collateral.js';

const MAX_BODY_BYTES = 4_096;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function send(response: ServerResponse, status: number, body: unknown): true {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(stringifyProtocolJson(body));
  return true;
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
  const parsed = parseProtocolJson(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('request body must be an object');
  return parsed as Record<string, unknown>;
}

export function createEvmReverseBasisCollateralInternalHandler(
  service: Pick<EvmReverseBasisCollateralService, 'planByQuote'>,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    if (url.pathname !== '/internal/strategy-executions/reverse-basis-collateral' || url.search !== '') return false;
    if (!LOOPBACK.has(request.socket.remoteAddress ?? '') || request.headers.origin !== undefined
      || request.headers.forwarded !== undefined || request.headers['x-forwarded-for'] !== undefined
      || request.headers['x-real-ip'] !== undefined) {
      return send(response, 403, { error: { code: 'FORBIDDEN', message: 'Collateral planning answers direct loopback callers only.' } });
    }
    if (request.method !== 'POST') {
      return send(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is allowed.' } });
    }
    try {
      const input = await body(request);
      if (Object.keys(input).sort().join(',') !== 'action,quoteHash'
        || (input.action !== 'SUPPLY' && input.action !== 'WITHDRAW') || typeof input.quoteHash !== 'string') {
        throw new Error('request must contain quoteHash and SUPPLY or WITHDRAW action');
      }
      const plan = await service.planByQuote(
        commitmentHash(input.quoteHash, 'quoteHash'),
        input.action as EvmPackageCollateralAction,
      );
      if (plan === undefined) return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Strategy quote was not found.' } });
      return send(response, 200, { version: 1, collateral: plan });
    } catch (error) {
      return send(response, 400, { error: {
        code: 'COLLATERAL_PLAN_REJECTED',
        message: error instanceof Error ? error.message : 'Collateral planning failed closed.',
      } });
    }
  };
}
