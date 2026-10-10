import type { IncomingMessage, ServerResponse } from "node:http";
import type { MetricObservation } from "@naryx/protocol-types";
import { internalCaller, readInternalBody, sendError, sendJson } from "./internal-http.js";
import { OrderActivationStoreError, type SqliteOrderActivationStore } from "./order-activation-store.js";
import type { SqliteMetricObservationStore } from "./metric-observation-store.js";

function failure(response: ServerResponse, error: unknown): true {
  if (error instanceof OrderActivationStoreError) {
    const status = error.code.endsWith("NOT_FOUND") ? 404
      : error.code === "CORRUPT_ROW" ? 500
        : error.code.endsWith("CONFLICT") || error.code === "ATTEMPT_OUTSTANDING" || error.code === "ORDER_TERMINAL" ? 409 : 400;
    return sendError(response, status, error.code, error.message);
  }
  return sendError(response, 400, "INVALID_REQUEST", error instanceof Error ? error.message : "Activation request was rejected.");
}

export function createOrderActivationAdminHandler(options: {
  readonly activations: Pick<SqliteOrderActivationStore, "reserve" | "complete" | "cancel">;
  readonly observations?: Pick<SqliteMetricObservationStore, "observations">;
}): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://internal.local");
    if (!url.pathname.startsWith("/internal/order-activations/")) return false;
    if (!internalCaller(request)) return sendError(response, 403, "FORBIDDEN", "Order activation controls answer loopback callers only.");
    if (request.method !== "POST") return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
    if (url.search !== "") return sendError(response, 400, "INVALID_REQUEST", "Query parameters are not accepted.");
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
      return sendError(response, 415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
    }
    if (url.pathname !== "/internal/order-activations/reserve"
      && url.pathname !== "/internal/order-activations/complete"
      && url.pathname !== "/internal/order-activations/cancel") {
      return sendError(response, 404, "NOT_FOUND", "Unknown order activation route.");
    }
    readInternalBody(request, response, (body) => {
      try {
        if (url.pathname === "/internal/order-activations/reserve") {
          if (typeof body.orderHash !== "string"
            || (options.observations === undefined ? !Array.isArray(body.observations) : body.observations !== undefined)
            || typeof body.atValue !== "bigint" || (body.side !== "BID" && body.side !== "ASK")
            || typeof body.limitPriceTicks !== "bigint") {
            throw new TypeError("Reserve requires orderHash, observations, atValue, side, and limitPriceTicks.");
          }
          return sendJson(response, 200, options.activations.reserve({
            orderHashHex: body.orderHash,
            observations: options.observations?.observations(body.orderHash, body.atValue)
              ?? body.observations as readonly MetricObservation[],
            atValue: body.atValue,
            side: body.side,
            limitPriceTicks: body.limitPriceTicks,
          }));
        }
        if (url.pathname === "/internal/order-activations/complete") {
          if (typeof body.attemptId !== "string" || (body.outcome !== "SUCCEEDED" && body.outcome !== "FAILED")
            || typeof body.executedQuantityAtoms !== "bigint") {
            throw new TypeError("Completion requires attemptId, outcome, and executedQuantityAtoms.");
          }
          return sendJson(response, 200, options.activations.complete({
            attemptId: body.attemptId,
            outcome: body.outcome,
            executedQuantityAtoms: body.executedQuantityAtoms,
            ...(body.executionPriceTicks === undefined ? {} : { executionPriceTicks: body.executionPriceTicks as bigint }),
            ...(body.failureReason === undefined ? {} : { failureReason: String(body.failureReason) }),
          }));
        }
        if (typeof body.orderHash !== "string") throw new TypeError("Cancellation requires orderHash.");
        return sendJson(response, 200, options.activations.cancel(body.orderHash));
      } catch (error) {
        return failure(response, error);
      }
    });
    return true;
  };
}
