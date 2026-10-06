import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitmentHash,
  parseProtocolJson,
  stringifyProtocolJson,
} from '@naryx/protocol-types';
import type { EvmOptionSpreadProvisioningService } from './evm-option-spread-provisioning.js';

const MAX_BODY_BYTES = 4_096;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function send(response: ServerResponse, status: number, body: unknown): true {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(stringifyProtocolJson(body));
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

export function createEvmOptionSpreadProvisioningInternalHandler(
  service: Pick<EvmOptionSpreadProvisioningService, 'provisionByOrder'>,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    if (url.pathname !== '/internal/strategy-executions/provision' || url.search !== '') return false;
    if (!internal(request)) return send(response, 403, { error: { code: 'FORBIDDEN', message: 'Provisioning answers direct loopback callers only.' } });
    if (request.method !== 'POST') return send(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is allowed.' } });
    try {
      const requestBody = await body(request);
      if (Object.keys(requestBody).length !== 1 || typeof requestBody.orderHash !== 'string') throw new Error('request must contain only orderHash');
      const plan = await service.provisionByOrder(commitmentHash(requestBody.orderHash, 'orderHash'));
      if (plan === undefined) return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Strategy order was not found.' } });
      return send(response, 200, { version: 1, provisioning: plan });
    } catch (error) {
      return send(response, 400, {
        error: {
          code: 'PROVISIONING_REJECTED',
          message: error instanceof Error ? error.message : 'Provisioning failed closed.',
        },
      });
    }
  };
}
