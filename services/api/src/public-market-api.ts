import type { IncomingMessage, ServerResponse } from "node:http";
import { packageBookLevels, toHex, toProtocolJson } from "@naryx/protocol-types";
import { MAX_TAPE_PAGE, PackageExchangeStoreError, type SqlitePackageExchangeStore } from "./package-exchange-store.js";

const CLASS_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const CURSOR = /^(0|[1-9]\d{0,15})$/;
const LIMIT = /^[1-9]\d{0,2}$/;

export type PublicMarketStore = Pick<
  SqlitePackageExchangeStore,
  "getBook" | "getMatchingPolicy" | "getAllocation" | "allocationTape"
>;

export interface PublicMarketApiOptions {
  readonly store: PublicMarketStore;
  /** Current time in the book's expiry unit, so expired entries never appear as depth. */
  readonly nowValue: () => bigint;
  readonly rateLimit: { readonly windowMs: number; readonly maxRequests: number };
  readonly clockMs?: () => number;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.end(JSON.stringify(toProtocolJson(body)));
}

function fail(response: ServerResponse, status: number, code: string, message: string): void {
  send(response, status, { error: { code, message } });
}

function onlyParams(url: URL, allowed: readonly string[]): boolean {
  const keys = [...url.searchParams.keys()];
  return keys.every((key) => allowed.includes(key)) && new Set(keys).size === keys.length;
}

/**
 * Read-only public market data over the package exchange. It serves depth with direct and implied
 * quantity kept apart, a trade tape that omits participant and taker order identities, and full
 * allocation evidence only to a caller that already holds the taker order id. It holds no signer,
 * accepts no writes, and never reports implied quantity as direct liquidity.
 */
export function createPublicMarketRequestHandler(options: PublicMarketApiOptions) {
  const { store, nowValue } = options;
  const { windowMs, maxRequests } = options.rateLimit;
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error("Public market rate limit must be positive.");
  }
  const clockMs = options.clockMs ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();

  function limited(request: IncomingMessage): boolean {
    const key = request.socket.remoteAddress ?? "unknown";
    const now = clockMs();
    const window = windows.get(key);
    if (window === undefined || now - window.start >= windowMs) {
      if (windows.size >= 10_000) windows.clear();
      windows.set(key, { start: now, count: 1 });
      return false;
    }
    window.count += 1;
    return window.count > maxRequests;
  }

  /** Returns false when the path is not a public market route, so the caller can continue routing. */
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const url = new URL(request.url ?? "/", "http://public-market.local");
    if (!url.pathname.startsWith("/v1/market/")) return false;
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      fail(response, 405, "METHOD_NOT_ALLOWED", "Public market data is read-only.");
      return true;
    }
    if (limited(request)) {
      fail(response, 429, "RATE_LIMITED", "Too many requests.");
      return true;
    }
    try {
      const book = /^\/v1\/market\/books\/([^/]+)$/.exec(url.pathname);
      if (book !== null) {
        const classId = book[1] as string;
        if (!CLASS_ID.test(classId) || !onlyParams(url, [])) {
          fail(response, 400, "INVALID_REQUEST", "Book request is malformed.");
          return true;
        }
        const state = store.getBook(classId);
        if (state === undefined) {
          fail(response, 404, "BOOK_NOT_FOUND", "Package book is not open.");
          return true;
        }
        const now = nowValue();
        send(response, 200, {
          executionClassId: state.executionClassId,
          matchingPolicyHash: toHex(state.matchingPolicyHash),
          halted: state.halted,
          asOfValue: now,
          bids: packageBookLevels(state, "BID", now),
          asks: packageBookLevels(state, "ASK", now),
        });
        return true;
      }
      const tape = /^\/v1\/market\/books\/([^/]+)\/tape$/.exec(url.pathname);
      if (tape !== null) {
        const classId = tape[1] as string;
        const after = url.searchParams.get("after") ?? "0";
        const limit = url.searchParams.get("limit") ?? "50";
        if (!CLASS_ID.test(classId) || !onlyParams(url, ["after", "limit"]) || !CURSOR.test(after) || !LIMIT.test(limit) ||
            Number(limit) > MAX_TAPE_PAGE) {
          fail(response, 400, "INVALID_REQUEST", "Tape request is malformed.");
          return true;
        }
        const records = store.allocationTape(classId, Number(after), Number(limit));
        send(response, 200, {
          executionClassId: classId,
          trades: records.map((record) => ({
            cursor: record.cursor,
            allocationHash: record.allocationHashHex,
            takerSide: record.allocation.takerSide,
            recordedAtMs: record.recordedAtMs,
            fills: record.allocation.fills.map((fill) => ({
              fillSequence: fill.fillSequence,
              priceTicks: fill.priceTicks,
              quantity: fill.quantity,
              makerSource: fill.makerSource,
            })),
          })),
          nextCursor: records.length === 0 ? Number(after) : (records[records.length - 1] as { cursor: number }).cursor,
        });
        return true;
      }
      const allocation = /^\/v1\/market\/allocations\/([^/]+)$/.exec(url.pathname);
      if (allocation !== null) {
        const orderId = allocation[1] as string;
        if (!HASH_HEX.test(orderId) || !onlyParams(url, [])) {
          fail(response, 400, "INVALID_REQUEST", "Allocation request is malformed.");
          return true;
        }
        const record = store.getAllocation(orderId);
        const policy = record === undefined ? undefined : store.getMatchingPolicy(record.matchingPolicyHash);
        if (record === undefined || policy === undefined) {
          fail(response, 404, "ALLOCATION_NOT_FOUND", "No allocation exists for this order.");
          return true;
        }
        send(response, 200, { allocation: record, matchingPolicy: policy });
        return true;
      }
      fail(response, 404, "NOT_FOUND", "Unknown public market route.");
      return true;
    } catch (error) {
      if (error instanceof PackageExchangeStoreError && error.code === "BOOK_NOT_FOUND") {
        fail(response, 404, "BOOK_NOT_FOUND", "Package book is not open.");
      } else {
        fail(response, 500, "INTERNAL_ERROR", "Public market request failed.");
      }
      return true;
    }
  };
}
