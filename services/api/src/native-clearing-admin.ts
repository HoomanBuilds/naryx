import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ExpiryUnit,
  NativeClearingAccountInput,
  NativeClearingCollateralAuthorizationInput,
  NativeClearingDefaultBidInput,
  NativeClearingDomainStateInput,
  NativeClearingMarkObservationInput,
  NativeClearingMatchAuthorizationInput,
  NativeClearingPolicyInput,
} from '@naryx/protocol-types';
import { internalCaller, readInternalBody, sendError, sendJson } from './internal-http.js';
import {
  NativeClearingStoreError,
  type SqliteNativeClearingStore,
} from './native-clearing-store.js';
import type { NativeClearingControlSignature } from './native-clearing-authorization.js';

export interface NativeClearingAdminOptions {
  readonly clearing: Pick<
    SqliteNativeClearingStore,
    'registerDomain' | 'openAccount' | 'adjustReserve' | 'recordMark' | 'adjustAuthorizedCollateral'
      | 'settleAuthorizedMatch' | 'openDefaultAuction' | 'submitDefaultBid' | 'settleDefaultAuction'
  >;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function rejected(response: ServerResponse, error: unknown): true {
  if (error instanceof NativeClearingStoreError) {
    const status = error.code.endsWith('NOT_FOUND') ? 404
      : error.code === 'CORRUPT_ROW' ? 500
        : error.code === 'INVALID_SIGNATURE' ? 403
          : error.code.startsWith('STALE_') || error.code.endsWith('CONFLICT') || error.code === 'AUCTION_CLOSED'
            ? 409 : 400;
    return sendError(response, status, error.code, error.message);
  }
  return sendError(
    response,
    400,
    'NATIVE_CLEARING_REJECTED',
    error instanceof Error ? error.message : 'Native clearing request was rejected.',
  );
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function createNativeClearingAdminHandler(
  options: NativeClearingAdminOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? '/', 'http://internal.local');
    const action = new Map<string, readonly string[]>([
      ['/internal/native-clearing/domains', ['policy', 'state']],
      ['/internal/native-clearing/accounts', ['clearingDomainId', 'account']],
      ['/internal/native-clearing/reserve', ['clearingDomainId', 'expectedStateHash', 'reserveDeltaQuoteAtoms']],
      ['/internal/native-clearing/marks', ['clearingDomainId', 'observation', 'authorization']],
      ['/internal/native-clearing/collateral', ['authorization', 'ownerSignature', 'currentExpiryUnit', 'currentExpiryValue', 'nowMs']],
      ['/internal/native-clearing/matches', ['authorization', 'expectedStateHash', 'expectedLongAccountHash', 'expectedShortAccountHash', 'nowMs']],
      ['/internal/native-clearing/auctions', ['clearingDomainId', 'defaultedAccountId', 'expectedDefaultedAccountHash', 'auctionId', 'bidsCloseAtMs', 'nowMs']],
      ['/internal/native-clearing/auction-bids', ['auctionId', 'bid', 'ownerSignature', 'nowMs']],
      ['/internal/native-clearing/auction-settlements', ['auctionId', 'expectedStateHash', 'nowMs']],
    ]).get(url.pathname);
    if (action === undefined) return false;
    if (!internalCaller(request)) {
      return sendError(response, 403, 'FORBIDDEN', 'Native clearing controls answer loopback callers only.');
    }
    if (request.method !== 'POST') return sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
    if (url.search !== '') return sendError(response, 400, 'INVALID_REQUEST', 'Query parameters are not accepted.');
    if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
      return sendError(response, 415, 'INVALID_CONTENT_TYPE', 'Content-Type must be application/json.');
    }
    readInternalBody(request, response, (body) => {
      if (!exactKeys(body, action)) {
        sendError(response, 400, 'INVALID_REQUEST', 'Native clearing request fields are invalid.');
        return;
      }
      const run = async (): Promise<unknown> => {
        switch (url.pathname) {
          case '/internal/native-clearing/domains':
            if (object(body.policy) === undefined || object(body.state) === undefined) throw new TypeError('Policy and state must be objects.');
            return options.clearing.registerDomain(
              body.policy as unknown as NativeClearingPolicyInput,
              body.state as unknown as NativeClearingDomainStateInput,
            );
          case '/internal/native-clearing/accounts':
            if (typeof body.clearingDomainId !== 'string' || object(body.account) === undefined) throw new TypeError('Domain and account are required.');
            return options.clearing.openAccount(
              body.clearingDomainId,
              body.account as unknown as NativeClearingAccountInput,
            );
          case '/internal/native-clearing/reserve':
            return options.clearing.adjustReserve(body as unknown as Parameters<SqliteNativeClearingStore['adjustReserve']>[0]);
          case '/internal/native-clearing/marks':
            if (typeof body.clearingDomainId !== 'string' || object(body.observation) === undefined || object(body.authorization) === undefined) {
              throw new TypeError('Domain, observation, and authorization are required.');
            }
            return options.clearing.recordMark({
              clearingDomainId: body.clearingDomainId,
              observation: body.observation as unknown as NativeClearingMarkObservationInput,
              authorization: body.authorization as unknown as NativeClearingControlSignature,
            });
          case '/internal/native-clearing/collateral':
            return options.clearing.adjustAuthorizedCollateral({
              authorization: body.authorization as unknown as NativeClearingCollateralAuthorizationInput,
              ownerSignature: body.ownerSignature as unknown as NativeClearingControlSignature,
              currentExpiryUnit: body.currentExpiryUnit as ExpiryUnit,
              currentExpiryValue: body.currentExpiryValue as bigint,
              nowMs: body.nowMs as bigint,
            });
          case '/internal/native-clearing/matches':
            return options.clearing.settleAuthorizedMatch({
              authorization: body.authorization as unknown as NativeClearingMatchAuthorizationInput,
              expectedStateHash: body.expectedStateHash as string,
              expectedLongAccountHash: body.expectedLongAccountHash as string,
              expectedShortAccountHash: body.expectedShortAccountHash as string,
              nowMs: body.nowMs as bigint,
            });
          case '/internal/native-clearing/auctions':
            return options.clearing.openDefaultAuction(body as unknown as Parameters<SqliteNativeClearingStore['openDefaultAuction']>[0]);
          case '/internal/native-clearing/auction-bids':
            return options.clearing.submitDefaultBid({
              auctionId: body.auctionId as string,
              bid: body.bid as unknown as NativeClearingDefaultBidInput,
              ownerSignature: body.ownerSignature as unknown as NativeClearingControlSignature,
              nowMs: body.nowMs as bigint,
            });
          case '/internal/native-clearing/auction-settlements':
            return options.clearing.settleDefaultAuction(body as unknown as Parameters<SqliteNativeClearingStore['settleDefaultAuction']>[0]);
          default:
            throw new TypeError('Unknown native clearing operation.');
        }
      };
      void run().then(
        (result) => sendJson(response, 200, { version: 1, result }),
        (error: unknown) => rejected(response, error),
      );
    });
    return true;
  };
}
