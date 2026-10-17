import type { IncomingMessage, ServerResponse } from 'node:http';

export function createHyperliquidEnrollmentProxy(origin: string, fetchImplementation: typeof fetch = fetch) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('enrollment origin must be loopback');
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const action = /^\/internal\/terminal\/hyperliquid-testnet\/enrollment\/(status|challenge|prepare|confirm)$/.exec(url.pathname)?.[1];
    if (action === undefined) return false;
    void (async () => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(JSON.stringify(body));
      };
      if (action === 'status' ? request.method !== 'GET' : request.method !== 'POST') {
        send(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Unsupported enrollment action.' } }); return;
      }
      let body: string | undefined;
      if (request.method === 'POST') {
        if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
          send(400, { error: { code: 'INVALID_REQUEST', message: 'A JSON enrollment request is required.' } }); return;
        }
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 4096) throw new Error('body too large');
          chunks.push(Buffer.from(chunk));
        }
        body = Buffer.concat(chunks).toString('utf8');
      }
      const upstream = await fetchImplementation(`${parsed.origin}/internal/hyperliquid-testnet/enrollment/${action}${url.search}`, {
        method: request.method!, ...(body === undefined ? {} : { body }), headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      const reader = upstream.body?.getReader();
      if (reader === undefined) throw new Error('empty response');
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const result = await reader.read(); if (result.done) break;
        size += result.value.length; if (size > 16384) { await reader.cancel(); throw new Error('response too large'); }
        chunks.push(result.value); }
      send(upstream.status, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    })().catch(() => {
      if (!response.headersSent) { response.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: { code: 'ENROLLMENT_UNAVAILABLE', message: 'Account setup is temporarily unavailable. Retry verification before signing again.' } })); }
      else response.destroy();
    });
    return true;
  };
}
