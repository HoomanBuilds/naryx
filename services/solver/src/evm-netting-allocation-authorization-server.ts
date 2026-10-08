import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitmentHash,
  parseProtocolJson,
  stringifyProtocolJson,
} from '@naryx/protocol-types';
import type { Hex } from 'viem';
import type { EvmNettingAllocationAuthorizationService } from './evm-netting-allocation-authorization.js';

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

function request(value: Record<string, unknown>, includesSignature: boolean) {
  const expected = includesSignature
    ? 'allocationReceiptHash,attemptId,domainId,ownerSignature,proofHash,quoteHash'
    : 'allocationReceiptHash,attemptId,domainId,proofHash,quoteHash';
  if (Object.keys(value).sort().join(',') !== expected
    || typeof value.proofHash !== 'string'
    || typeof value.allocationReceiptHash !== 'string'
    || typeof value.quoteHash !== 'string'
    || typeof value.domainId !== 'string'
    || typeof value.attemptId !== 'string'
    || (includesSignature && typeof value.ownerSignature !== 'string')) {
    throw new Error(`request must contain exactly ${expected}`);
  }
  return {
    proofHash: commitmentHash(value.proofHash, 'proofHash'),
    allocationReceiptHash: commitmentHash(value.allocationReceiptHash, 'allocationReceiptHash'),
    quoteHash: commitmentHash(value.quoteHash, 'quoteHash'),
    domainId: value.domainId,
    attemptId: value.attemptId,
    ...(includesSignature ? { ownerSignature: value.ownerSignature as Hex } : {}),
  };
}

export function createEvmNettingAllocationAuthorizationInternalHandler(
  service: Pick<EvmNettingAllocationAuthorizationService, 'challenge' | 'authorize'>,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://solver.internal');
    const challenge = url.pathname === '/internal/netting/allocation-executions/evm/challenge';
    const authorize = url.pathname === '/internal/netting/allocation-executions/evm/authorize';
    if ((!challenge && !authorize) || url.search !== '') return false;
    if (!internal(incoming)) {
      return send(response, 403, {
        error: { code: 'FORBIDDEN', message: 'EVM netting authorization answers direct loopback callers only.' },
      });
    }
    if (incoming.method !== 'POST') {
      return send(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is allowed.' } });
    }
    try {
      const input = await body(incoming);
      if (challenge) {
        return send(response, 200, { version: 1, challenge: await service.challenge(request(input, false)) });
      }
      return send(response, 200, { version: 1, authorization: await service.authorize(request(input, true) as never) });
    } catch (error) {
      return send(response, 400, {
        error: {
          code: 'AUTHORIZATION_REJECTED',
          message: error instanceof Error ? error.message : 'EVM netting authorization failed closed.',
        },
      });
    }
  };
}
