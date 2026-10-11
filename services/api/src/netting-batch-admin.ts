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
import { BaseSepoliaNettingResidualExecutionClientError } from "./base-sepolia-netting-residual-execution-client.js";
import { HyperliquidNettingResidualExecutionClientError } from "./hyperliquid-netting-residual-execution-client.js";
import { internalCaller, readInternalBody, sendError, sendJson } from "./internal-http.js";
import type { NettingExecutionCoordinator } from "./netting-execution-coordinator.js";
import { PackageExchangeStoreError, type PreparedNettingBatch } from "./package-exchange-store.js";
import { SolanaDevnetNettingResidualExecutionClientError } from "./solana-devnet-netting-residual-execution-client.js";

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

/**
 * POST /internal/netting/batches/:proofHash/execute, loopback only. Executing claims each residual
 * intent, which removes it from cross-batch pooling and spends the operator's venue capacity, so
 * the operator or its keeper chooses when; an outside caller could otherwise pre-empt pooling or
 * time execution against the signed limits.
 */
export function createNettingBatchExecutionHandler(options: Readonly<{
  exchange: Readonly<{ nettingBatch(proofHash: Uint8Array | string): PreparedNettingBatch | undefined }>;
  execution: Pick<NettingExecutionCoordinator, "execute">;
}>): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://internal.local");
    const match = /^\/internal\/netting\/batches\/([0-9a-f]{64})\/execute$/.exec(url.pathname);
    if (match === null) return false;
    if (!internalCaller(request)) {
      return sendError(response, 403, "FORBIDDEN", "Netting batch execution answers loopback callers only.");
    }
    if (request.method !== "POST") return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
    if (url.search !== "") return sendError(response, 400, "INVALID_REQUEST", "Query parameters are not accepted.");
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
      return sendError(response, 415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
    }
    readInternalBody(request, response, (body) => {
      if (!exactKeys(body, [])) {
        sendError(response, 400, "INVALID_REQUEST", "A netting execution request has no caller-selected fields.");
        return;
      }
      const proofHash = match[1]!;
      void Promise.resolve().then(() => {
        if (options.exchange.nettingBatch(proofHash) === undefined) {
          throw new PackageExchangeStoreError("NETTING_BATCH_NOT_FOUND", "No prepared netting batch exists for this proof hash.");
        }
        return options.execution.execute(proofHash);
      }).then(
        (result) => sendJson(response, 200, { version: 1, ...result }),
        (error: unknown) => {
          if (error instanceof HyperliquidNettingResidualExecutionClientError
            || error instanceof BaseSepoliaNettingResidualExecutionClientError
            || error instanceof SolanaDevnetNettingResidualExecutionClientError) {
            return error.code === "EVIDENCE_PENDING"
              ? sendError(response, 409, "NETTING_EVIDENCE_PENDING", error.message)
              : sendError(response, 502, "NETTING_EXECUTION_FAILED", error.message);
          }
          if (error instanceof PackageExchangeStoreError && error.code === "NETTING_INTENT_POOLED") {
            return sendError(response, 409, error.code, error.message);
          }
          return rejected(response, error);
        },
      );
    });
    return true;
  };
}
