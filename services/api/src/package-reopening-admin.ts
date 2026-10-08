import type { IncomingMessage, ServerResponse } from "node:http";
import { packageReopeningSnapshotHash, toHex, type PackageBookHaltInput } from "@naryx/protocol-types";
import type { SqlitePackageExchangeStore } from "./package-exchange-store.js";
import { PackageExchangeStoreError } from "./package-exchange-store.js";
import { internalCaller, readInternalBody, sendError, sendJson } from "./internal-http.js";

export interface PackageReopeningAdminOptions {
  readonly exchange: Pick<
    SqlitePackageExchangeStore,
    "getBook" | "getMatchingPolicy" | "haltBook" | "clearReopeningAuction"
  >;
  readonly nowValue: () => bigint;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(body).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

export function createPackageReopeningAdminHandler(
  options: PackageReopeningAdminOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  const snapshotPath = "/internal/package-book/reopening/snapshot";
  const haltPath = "/internal/package-book/reopening/halt";
  const clearPath = "/internal/package-book/reopening/clear";
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://internal.local");
    if (url.pathname !== snapshotPath && url.pathname !== haltPath && url.pathname !== clearPath) return false;
    if (!internalCaller(request)) {
      return sendError(response, 403, "FORBIDDEN", "Package reopening controls answer loopback callers only.");
    }
    if (url.search !== "") return sendError(response, 400, "INVALID_REQUEST", "Query parameters are not accepted.");
    if (request.method !== "POST") return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
      return sendError(response, 415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
    }
    readInternalBody(request, response, (body) => {
      try {
        if (snapshotPath === url.pathname) {
          if (!exactKeys(body, ["executionClassId"]) || typeof body.executionClassId !== "string") {
            sendError(response, 400, "INVALID_REQUEST", "The body must contain only executionClassId.");
            return;
          }
          const book = options.exchange.getBook(body.executionClassId);
          if (book === undefined) {
            sendError(response, 404, "BOOK_NOT_FOUND", "Package market is not open.");
            return;
          }
          const policy = options.exchange.getMatchingPolicy(book.matchingPolicyHash);
          if (policy === undefined) throw new PackageExchangeStoreError("CORRUPT_ROW", "Book policy is unavailable.");
          sendJson(response, 200, {
            version: 1,
            executionClassId: book.executionClassId,
            halted: book.halted,
            openingSnapshotHash: toHex(packageReopeningSnapshotHash(policy, book)),
            queuedEntryCount: book.entries.length,
            asOfValue: options.nowValue(),
          });
          return;
        }
        if (haltPath === url.pathname) {
          if (!exactKeys(body, ["halt"]) || typeof body.halt !== "object" || body.halt === null || Array.isArray(body.halt)) {
            sendError(response, 400, "INVALID_REQUEST", "The body must contain only a halt object.");
            return;
          }
          sendJson(response, 200, {
            version: 1,
            ...options.exchange.haltBook(body.halt as PackageBookHaltInput),
          });
          return;
        }
        const expected = [
          "auctionId",
          "executionClassId",
          "openingSnapshotHash",
          "qualificationSnapshotHash",
          "referencePriceTicks",
        ];
        if (
          !exactKeys(body, expected)
          || typeof body.auctionId !== "string"
          || typeof body.executionClassId !== "string"
          || typeof body.openingSnapshotHash !== "string"
          || typeof body.qualificationSnapshotHash !== "string"
          || typeof body.referencePriceTicks !== "bigint"
        ) {
          sendError(response, 400, "INVALID_REQUEST", `The body must contain only ${expected.join(", ")}.`);
          return;
        }
        sendJson(response, 200, {
          version: 1,
          ...options.exchange.clearReopeningAuction(
            body.executionClassId,
            body.auctionId,
            body.openingSnapshotHash,
            body.qualificationSnapshotHash,
            body.referencePriceTicks,
            options.nowValue(),
          ),
        });
      } catch (error) {
        if (error instanceof PackageExchangeStoreError) {
          const status = error.code === "BOOK_NOT_FOUND" ? 404
            : error.code === "INVALID_INPUT" ? 400
              : error.code === "CORRUPT_ROW" ? 500 : 409;
          sendError(response, status, error.code, error.message);
          return;
        }
        sendError(response, 400, "INVALID_REQUEST", "Package reopening request was rejected.");
      }
    });
    return true;
  };
}
