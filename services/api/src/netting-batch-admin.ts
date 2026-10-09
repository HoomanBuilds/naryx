import type { IncomingMessage, ServerResponse } from "node:http";
import {
  nettingPolicyManifestHash,
  toHex,
  type NettingPolicyManifestInput,
} from "@naryx/protocol-types";
import {
  AuthoritativeNettingError,
  type PrepareNextAuthoritativeNettingBatchResult,
} from "./authoritative-netting.js";
import { internalCaller, readInternalBody, sendError, sendJson } from "./internal-http.js";
import { PackageExchangeStoreError } from "./package-exchange-store.js";

export interface NettingBatchAdminOptions {
  readonly prepareNext: (
    policy: NettingPolicyManifestInput,
  ) => Promise<PrepareNextAuthoritativeNettingBatchResult>;
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
    if (url.pathname !== "/internal/netting/batches/prepare-next") return false;
    if (!internalCaller(request)) {
      return sendError(response, 403, "FORBIDDEN", "Netting batch preparation answers loopback callers only.");
    }
    if (request.method !== "POST") return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
    if (url.search !== "") return sendError(response, 400, "INVALID_REQUEST", "Query parameters are not accepted.");
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
      return sendError(response, 415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
    }
    readInternalBody(request, response, (body) => {
      if (!exactKeys(body, ["policy"])
        || typeof body.policy !== "object" || body.policy === null || Array.isArray(body.policy)) {
        sendError(response, 400, "INVALID_REQUEST", "Preparation requires one netting policy.");
        return;
      }
      void options.prepareNext(body.policy as NettingPolicyManifestInput).then(
        (result) => result.status === "IDLE"
          ? sendJson(response, 200, { version: 1, status: "IDLE" })
          : sendJson(response, 200, {
              version: 1,
              status: "PREPARED",
              proofHashHex: result.batch.proofHashHex,
              policyHashHex: toHex(nettingPolicyManifestHash(result.batch.policy)),
              packageOrderIds: result.batch.packages.map((entry) => entry.packageOrderIdHex),
              replayed: result.replayed,
            }),
        (error: unknown) => rejected(response, error),
      );
    });
    return true;
  };
}
