import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAllowedTerminalOrigin, type TerminalOrigins } from './terminal-origin.js';

const COMMANDS = new Set(['config', 'consent', 'enroll', 'challenge', 'execute', 'withdrawal-challenge', 'withdrawal']);

export function loadPoolProxyToken(path: string): string {
  if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) throw new Error('Pool token requires an absolute regular path');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 128 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error('Pool token must be an owner-only regular file');
  }
  const token = readFileSync(path, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid pool proxy token');
  return token;
}

export function createHyperliquidPoolProxy(origin: string, token: string,
  allowedOrigins: TerminalOrigins, requestFetch: typeof fetch = fetch) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.pathname !== '/' || parsed.username || parsed.password || parsed.search || parsed.hash
    || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Pool browser proxy requires a loopback origin and operator token');
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/v1/hyperliquid-pool/')) return false;
    const send = (status: number, body: string) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(body);
    };
    if (request.headers.origin !== undefined) {
      if (!isAllowedTerminalOrigin(allowedOrigins, request.headers.origin)) {
        send(403, '{"error":"Browser origin is not allowed."}'); return true;
      }
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Vary', 'Origin');
    }
    const command = url.pathname.slice('/v1/hyperliquid-pool/'.length);
    if (url.search || !COMMANDS.has(command)) { send(404, '{"error":"Unknown pool browser route."}'); return true; }
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return true; }
    if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
      send(405, '{"error":"JSON POST is required."}'); return true;
    }
    void (async () => {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 16_384) { send(413, '{"error":"Pool request exceeds its bound."}'); return; }
        chunks.push(Buffer.from(chunk));
      }
      const upstream = await requestFetch(`${parsed.origin}/v1/pool/browser/${command}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, redirect: 'error',
        body: Buffer.concat(chunks).toString('utf8'), signal: AbortSignal.timeout(40_000) });
      if (!upstream.body) throw new Error('Pool response is empty');
      const reader = upstream.body.getReader(); const received: Uint8Array[] = []; let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          total += value.length; if (total > 65_536) throw new Error('Pool response exceeds its bound'); received.push(value);
        }
      } finally { await reader.cancel(); }
      const text = Buffer.concat(received).toString('utf8'); JSON.parse(text);
      send(upstream.status, text);
    })().catch(() => {
      if (!response.headersSent) send(502, '{"error":"Pool service unavailable. Check status before resubmitting."}');
      else response.destroy();
    });
    return true;
  };
}
