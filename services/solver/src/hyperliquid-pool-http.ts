import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import type { HyperliquidPooledCollateralStore } from './hyperliquid-pooled-collateral-store.js';
import type { HyperliquidPoolFundingService, PoolWithdrawalRequest } from './hyperliquid-pool-funding.js';
import type { HyperliquidPoolEpochService, HyperliquidPoolEpochPlan } from './hyperliquid-pool-epoch.js';
import type { HyperliquidPoolWithdrawalService } from './hyperliquid-pool-withdrawal.js';
import { createPoolBrowserCommands } from './hyperliquid-pool-browser.js';

interface PoolServices {
  readonly store: HyperliquidPooledCollateralStore;
  readonly funding: HyperliquidPoolFundingService;
  readonly epochs: HyperliquidPoolEpochService;
  readonly withdrawals: HyperliquidPoolWithdrawalService;
}

export function createHyperliquidPoolController(services: PoolServices, operatorToken: string) {
  if (!/^[a-f0-9]{64}$/.test(operatorToken)) throw new Error('A dedicated pool operator token is required');
  let busy = false;
  const browser = createPoolBrowserCommands(services);
  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (busy) throw new Error('Pool operation is already running');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  const advance = () => exclusive(() => services.epochs.advance());
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(stringifyProtocolJson(body));
    };
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health' && !url.search) {
      send(200, { environment: 'TESTNET', custody: 'DEDICATED_TEST_ACCOUNTS_ONLY', busy }); return;
    }
    const expected = Buffer.from(`Bearer ${operatorToken}`);
    const received = Buffer.from(request.headers.authorization ?? '');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)
      || request.headers.origin !== undefined || request.headers['x-forwarded-for'] !== undefined) {
      send(403, { error: 'POOL_OPERATOR_REQUIRED' }); return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/pool/state' && !url.search) {
      send(200, { binding: services.store.binding, members: services.store.members(), pending: services.store.pending() ?? null }); return;
    }
    if (request.method !== 'POST' || url.search || request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
      send(405, { error: 'METHOD_NOT_ALLOWED' }); return;
    }
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 1_048_576) throw new Error('Pool command exceeds body bound');
        chunks.push(Buffer.from(chunk));
      }
      const body = parseProtocolJson(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid pool command');
      const keys = (...allowed: string[]) => {
        if (Object.keys(body).sort().join(',') !== allowed.sort().join(',')) throw new Error('Invalid command fields');
      };
      const result = await exclusive(async () => {
        const browserCommand = /^\/v1\/pool\/browser\/([a-z-]+)$/.exec(url.pathname);
        if (browserCommand) return browser(browserCommand[1]!, body);
        switch (url.pathname) {
          case '/v1/pool/enroll':
            keys('owner', 'signature');
            await services.funding.enroll(body.owner as `0x${string}`, body.signature as `0x${string}`); break;
          case '/v1/pool/deposit':
            keys('id', 'owner', 'transferHash', 'transferTimeMs');
            await services.funding.creditDeposit(body as unknown as Parameters<HyperliquidPoolFundingService['creditDeposit']>[0]); break;
          case '/v1/pool/epoch':
            keys('plan', 'authorizations');
            await services.epochs.prepare(body.plan as HyperliquidPoolEpochPlan,
              body.authorizations as Parameters<HyperliquidPoolEpochService['prepare']>[1]); break;
          case '/v1/pool/advance':
            keys(); return { status: await services.epochs.advance() };
          case '/v1/pool/close':
            keys('id'); await services.epochs.close(String(body.id));
            return { status: await services.epochs.reconcile(String(body.id)) };
          case '/v1/pool/recover':
            keys('id'); return { status: await services.epochs.recover(String(body.id)) };
          case '/v1/pool/withdrawal':
            keys('request', 'signature');
            return services.funding.prepareWithdrawal(body.request as PoolWithdrawalRequest, body.signature as `0x${string}`);
          case '/v1/pool/withdrawal/submit':
            keys('id'); return { status: await services.withdrawals.submit(String(body.id)) };
          case '/v1/pool/withdrawal/complete':
            keys('id', 'transferHash', 'transferTimeMs');
            await services.funding.completeWithdrawal(body as unknown as Parameters<HyperliquidPoolFundingService['completeWithdrawal']>[0]); break;
          case '/v1/pool/withdrawal/release':
            keys('id'); await services.funding.releaseExpiredUnsubmittedWithdrawal(String(body.id)); break;
          default: throw new Error('Unknown pool command');
        }
        return { status: 'ACCEPTED' };
      });
      send(200, result);
    } catch {
      send(409, { error: 'POOL_COMMAND_REFUSED', message: 'No completion is implied. Reconcile the pending operation before retrying.' });
    }
  };
  return { handle, advance, busy: () => busy };
}
