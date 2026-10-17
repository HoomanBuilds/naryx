import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAllowedTerminalOrigin, type TerminalOrigins } from './terminal-origin.js';

export function createNativeCashProxy(origin: string, requestFetch: typeof fetch = fetch, allowedOrigins: TerminalOrigins = null) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.pathname !== '/' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Native cash upstream must be a loopback HTTP origin.');
  }
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/v1/native-cash/')) return false;
    const send = (status: number, body: string) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(body);
    };
    if (request.headers.origin !== undefined) {
      if (!isAllowedTerminalOrigin(allowedOrigins, request.headers.origin)) {
        send(403, '{"error":"Browser origin is not allowed."}'); return true;
      }
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return true; }
    const quote = /^\/v1\/native-cash\/quotes\/[A-Za-z0-9._:-]{1,257}(\/settlement)?$/.exec(url.pathname);
    if (url.search || !(request.method === 'GET' && (url.pathname === '/v1/native-cash/markets' || quote)
      || request.method === 'POST' && (url.pathname === '/v1/native-cash/quotes' || quote?.[1]))) {
      send(404, '{"error":"Unknown native cash route."}'); return true;
    }
    void (async () => {
      let body: string | undefined;
      if (request.method === 'POST') {
        if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
          send(400, '{"error":"JSON is required."}'); return;
        }
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 4096) { send(413, '{"error":"Request exceeds 4096 bytes."}'); return; }
          chunks.push(Buffer.from(chunk));
        }
        body = Buffer.concat(chunks).toString('utf8');
      }
      const upstream = await requestFetch(`${parsed.origin}${url.pathname}`, { method: request.method ?? 'GET',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, redirect: 'error',
        signal: AbortSignal.timeout(15_000), ...(body === undefined ? {} : { body }) });
      if (upstream.body === null) throw new Error('Native cash response is empty.');
      const reader = upstream.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.length; if (length > 131_072) throw new Error('Native cash response exceeds its bound.'); chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const text = Buffer.concat(chunks).toString('utf8'); JSON.parse(text);
      send(upstream.status, text);
    })().catch(() => {
      if (!response.headersSent) send(502, '{"error":"Native cash testnet service is unavailable."}');
      else response.destroy();
    });
    return true;
  };
}
