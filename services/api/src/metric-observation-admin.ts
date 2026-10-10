import type { IncomingMessage, ServerResponse } from "node:http";
import type { MetricObservationAttestationInput } from "@naryx/protocol-types";
import { internalCaller, readInternalBody, sendError, sendJson } from "./internal-http.js";
import { MetricObservationStoreError, type SqliteMetricObservationStore } from "./metric-observation-store.js";

export function createMetricObservationAdminHandler(options: {
  readonly observations: Pick<SqliteMetricObservationStore, "publish">;
}): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://internal.local");
    if (url.pathname !== "/internal/order-activations/observations") return false;
    if (!internalCaller(request)) return sendError(response, 403, "FORBIDDEN", "Metric observation intake answers loopback callers only.");
    if (request.method !== "POST") return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
    if (url.search !== "") return sendError(response, 400, "INVALID_REQUEST", "Query parameters are not accepted.");
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
      return sendError(response, 415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
    }
    readInternalBody(request, response, (body) => {
      try {
        if (typeof body.attestation !== "object" || body.attestation === null || !(body.signature instanceof Uint8Array)) {
          throw new TypeError("Observation intake requires an attestation and binary signature.");
        }
        return sendJson(response, 200, options.observations.publish(
          body.attestation as unknown as MetricObservationAttestationInput,
          body.signature,
        ));
      } catch (error) {
        if (error instanceof MetricObservationStoreError) {
          const status = error.code === "ORDER_NOT_FOUND" ? 404 : error.code.endsWith("CONFLICT") || error.code === "SEQUENCE_REPLAY" ? 409 : 400;
          return sendError(response, status, error.code, error.message);
        }
        return sendError(response, 400, "INVALID_REQUEST", error instanceof Error ? error.message : "Observation was rejected.");
      }
    });
    return true;
  };
}
