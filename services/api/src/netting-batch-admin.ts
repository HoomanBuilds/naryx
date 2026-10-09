import type { IncomingMessage, ServerResponse } from "node:http";
import type { NettingPolicyManifestInput } from "@naryx/protocol-types";
import {
  AuthoritativeNettingError,
  type PrepareAuthoritativeNettingBatchInput,
  type PrepareAuthoritativeNettingBatchResult,
} from "./authoritative-netting.js";
import { internalCaller, readInternalBody, sendError, sendJson } from "./internal-http.js";
import { PackageExchangeStoreError } from "./package-exchange-store.js";

const HASH = /^[0-9a-f]{64}$/;

export interface NettingBatchAdminOptions {
  readonly prepare: (
    input: PrepareAuthoritativeNettingBatchInput,
  ) => Promise<PrepareAuthoritativeNettingBatchResult>;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function rejected(response: ServerResponse, error: unknown): true {
  if (error instanceof AuthoritativeNettingError) {
    const status = error.code.endsWith("NOT_FOUND") ? 404
      : error.code === "INVALID_BATCH" ? 400 : 409;
    return sendError(response, status, error.code, error.message);
  }
  if (error instanceof PackageExchangeStoreError) {
    const status = error.code === "CORRUPT_ROW" ? 500
      : error.code.includes("NOT_FOUND") ? 404
        : error.code.includes("CONFLICT") ? 409 : 400;
    return sendError(response, status, error.code, error.message);
  }
  return sendError(
    response,
    400,
    "NETTING_BATCH_REJECTED",
    error instanceof Error ? error.message : "Netting batch preparation was rejected.",
  );
}

export function createNettingBatchAdminHandler(
  options: NettingBatchAdminOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://internal.local");
    if (url.pathname !== "/internal/netting/batches/prepare") return false;
    if (!internalCaller(request)) {
      return sendError(response, 403, "FORBIDDEN", "Netting batch preparation answers loopback callers only.");
    }
    if (request.method !== "POST") return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
    if (url.search !== "") return sendError(response, 400, "INVALID_REQUEST", "Query parameters are not accepted.");
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
      return sendError(response, 415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
    }
    readInternalBody(request, response, (body) => {
      if (!exactKeys(body, ["packageOrderIds", "policy"])
        || !Array.isArray(body.packageOrderIds) || body.packageOrderIds.length === 0
        || body.packageOrderIds.some((value) => typeof value !== "string" || !HASH.test(value))
        || typeof body.policy !== "object" || body.policy === null || Array.isArray(body.policy)) {
        sendError(response, 400, "INVALID_REQUEST", "Preparation requires package order ids and one netting policy.");
        return;
      }
      void options.prepare({
        packageOrderIds: body.packageOrderIds as string[],
        policy: body.policy as NettingPolicyManifestInput,
      }).then(
        (result) => sendJson(response, 200, { version: 1, ...result }),
        (error: unknown) => rejected(response, error),
      );
    });
    return true;
  };
}
