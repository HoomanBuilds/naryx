import type { IncomingMessage, ServerResponse } from 'node:http';
import { HyperliquidEnrollmentError, type HyperliquidTestnetEnrollmentService } from './hyperliquid-testnet-enrollment.js';

const PREFIX = '/internal/hyperliquid-testnet/enrollment/';

export function createHyperliquidEnrollmentHandler(service: HyperliquidTestnetEnrollmentService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(PREFIX)) return false;
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(body));
    };
    try {
      const action = url.pathname.slice(PREFIX.length);
      if (request.method === 'GET' && action === 'status') {
        if ([...url.searchParams.keys()].join(',') !== 'owner') throw new Error('invalid query');
        send(200, service.status(url.searchParams.get('owner') ?? '')); return true;
      }
      if (request.method !== 'POST' || !['challenge', 'prepare', 'confirm'].includes(action) || url.search !== '') {
        send(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Unsupported enrollment action.' } }); return true;
      }
      if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new Error('invalid content type');
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 4096) throw new Error('body too large');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (body === null || Array.isArray(body) || typeof body !== 'object' || typeof body.owner !== 'string'
        || Object.keys(body).some(key => key !== 'owner' && key !== 'signature')
        || body.signature !== undefined && (typeof body.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(body.signature))) throw new Error('invalid fields');
      const signature = body.signature as `0x${string}` | undefined;
      const result = action === 'challenge' ? service.challenge(body.owner)
        : action === 'prepare' ? await service.prepare(body.owner, signature ?? '0x')
          : await service.confirm(body.owner, signature);
      send(200, result);
    } catch (error) {
      if (error instanceof HyperliquidEnrollmentError) send(409, { error: { code: error.code, message: error.message } });
      else send(400, { error: { code: 'ENROLLMENT_FAILED', message: 'Account setup could not be verified. Check your testnet settings and retry.' } });
    }
    return true;
  };
}
