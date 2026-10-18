import { createServer } from 'node:http';
import { parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import type { CrossDomainJob } from './cross-domain-job-store.js';
import type { CrossDomainWalletAdmission, CrossDomainWalletSignatures } from './cross-domain-wallet-admission.js';

export function createCrossDomainServer(runtime: {
  admit(job: CrossDomainJob): Promise<{ planHash: string; admittedPlanHash: string }>;
  status(hash: string): unknown;
  walletApprovals?: CrossDomainWalletAdmission | undefined;
}) {
  let admitting = false;
  return createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(stringifyProtocolJson(value));
    };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')
      || request.headers.origin !== undefined) {
      reply(403, { error: 'Loopback service requests only.' }); return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      reply(200, { status: 'ok', environment: 'testnet', admissionInProgress: admitting,
        walletApprovalsAvailable: runtime.walletApprovals !== undefined }); return;
    }
    const draftMatch = /^\/wallet\/drafts\/([0-9a-f]{64})$/.exec(request.url ?? '');
    if (request.method === 'GET' && draftMatch !== null) {
      try {
        if (runtime.walletApprovals === undefined) { reply(503, { error: 'Wallet approval is disabled.' }); return; }
        const draft = runtime.walletApprovals.get(draftMatch[1]!);
        reply(draft === undefined ? 404 : 200, draft ?? { error: 'Preparation not found.' });
      } catch { reply(503, { error: 'Wallet approval is unavailable.' }); }
      return;
    }
    const match = /^\/jobs\/([0-9a-f]{64})$/.exec(request.url ?? '');
    if (request.method === 'GET' && match !== null) {
      const status = runtime.status(match[1]!);
      reply(status === undefined ? 404 : 200, status ?? { error: 'Job not found.' }); return;
    }
    if (request.method !== 'POST' || !['/jobs', '/wallet/drafts', '/wallet/authorize'].includes(request.url ?? '')) {
      reply(404, { error: 'Route not found.' }); return;
    }
    if (admitting) { reply(429, { error: 'Admission busy. Retry the same signed job.' }); return; }
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
      reply(415, { error: 'JSON required.' }); return;
    }
    if (Number(request.headers['content-length'] ?? 0) > 1_048_576) {
      reply(413, { error: 'Job exceeds size limit.' }); return;
    }
    admitting = true;
    request.setTimeout(10_000, () => request.destroy());
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 1_048_576) { reply(413, { error: 'Job exceeds size limit.' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      request.setTimeout(0);
      const value = parseProtocolJson(Buffer.concat(chunks).toString('utf8'));
      if (request.url === '/jobs') reply(202, await runtime.admit(value as CrossDomainJob));
      else if (runtime.walletApprovals === undefined) reply(503, { error: 'Wallet approval is disabled.' });
      else if (request.url === '/wallet/drafts') reply(201, await runtime.walletApprovals.prepare(value));
      else reply(202, await runtime.walletApprovals.authorize(value as CrossDomainWalletSignatures));
    } catch {
      reply(409, { error: 'Job admission refused. Check signatures, account ownership, reservation funding and deadlines.' });
    } finally { admitting = false; }
  });
}
