import type { IncomingMessage, ServerResponse } from 'node:http';
import { HyperliquidOwnerCohorts, OwnerCohortError } from './hyperliquid-owner-cohort.js';
import { internalCaller, readInternalBody, sendError, sendJson } from './internal-http.js';
import type { HyperliquidTestnetTerminalExecutionRequest } from './hyperliquid-testnet-terminal.js';

export function createHyperliquidOwnerCohortHandler(cohorts: HyperliquidOwnerCohorts) {
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const url = new URL(request.url ?? '/', 'http://internal.local');
    const root = '/internal/hyperliquid-testnet/owner-cohorts';
    if (url.pathname !== root && !url.pathname.startsWith(`${root}/`)) return false;
    if (!internalCaller(request)) return sendError(response, 403, 'FORBIDDEN', 'Owner cohorts accept direct loopback requests only.');
    if (url.search !== '') return sendError(response, 400, 'INVALID_REQUEST', 'Query parameters are not accepted.');
    const fail = (error: unknown) => error instanceof OwnerCohortError
      ? sendError(response, error.code === 'NOT_FOUND' ? 404 : 409, error.code, error.message)
      : sendError(response, 400, 'COHORT_FAILED', 'Cohort request failed; inspect the durable state before retrying.');
    const match = /^\/internal\/hyperliquid-testnet\/owner-cohorts\/([A-Za-z0-9][A-Za-z0-9._:-]{15,127})(\/execute)?$/.exec(url.pathname);
    if (request.method === 'GET' && match !== null && match[2] === undefined) {
      const cohort = cohorts.get(match[1]!);
      return cohort === undefined ? sendError(response, 404, 'NOT_FOUND', 'Cohort does not exist.') : sendJson(response, 200, cohort);
    }
    if (request.method !== 'POST') return sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Use GET for status or POST to prepare or execute.');
    if (url.pathname !== root && (match === null || match[2] !== '/execute')) return sendError(response, 404, 'NOT_FOUND', 'Unknown cohort route.');
    readInternalBody(request, response, (body) => {
      if (match !== null) {
        if (Object.keys(body).length !== 0) { sendError(response, 400, 'INVALID_REQUEST', 'Execution body must be empty.'); return; }
        void cohorts.execute(match[1]!).then((cohort) => sendJson(response, 200, cohort)).catch(fail);
      } else {
        if (Object.keys(body).sort().join(',') !== 'cohortId,requests' || typeof body.cohortId !== 'string' || !Array.isArray(body.requests)) {
          sendError(response, 400, 'INVALID_REQUEST', 'Provide only cohortId and requests.'); return;
        }
        try { sendJson(response, 200, cohorts.prepare(body.cohortId, body.requests as HyperliquidTestnetTerminalExecutionRequest[])); }
        catch (error) { fail(error); }
      }
    });
    return true;
  };
}
