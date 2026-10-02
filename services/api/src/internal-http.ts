import type { IncomingMessage, ServerResponse } from "node:http";
import { parseProtocolJson, stringifyProtocolJson } from "@naryx/protocol-types";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const MAX_INTERNAL_BODY_BYTES = 262_144;

/**
 * A request a reverse proxy forwarded carries its forwarding headers. Behind a same-host proxy every
 * peer is loopback, so such a request is never an internal caller, whatever path it names.
 */
export function forwardedByProxy(request: IncomingMessage): boolean {
  const headers = request.headers;
  return headers["x-forwarded-for"] !== undefined || headers.forwarded !== undefined || headers["x-real-ip"] !== undefined;
}

/**
 * Internal routes answer direct loopback callers only: a browser request always carries an Origin
 * and a proxied one carries forwarding headers, and both are refused.
 */
export function internalCaller(request: IncomingMessage): boolean {
  return LOOPBACK.has(request.socket.remoteAddress ?? "") && request.headers.origin === undefined && !forwardedByProxy(request);
}

export function sendJson(response: ServerResponse, status: number, body: unknown): true {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(stringifyProtocolJson(body));
  return true;
}

export function sendError(response: ServerResponse, status: number, code: string, message: string): true {
  return sendJson(response, status, { error: { code, message } });
}

/** Reads a protocol JSON object body of at most 256 KiB and hands it to `handle`; failures answer 400 or 413. */
export function readInternalBody(request: IncomingMessage, response: ServerResponse, handle: (body: Record<string, unknown>) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_INTERNAL_BODY_BYTES) chunks.push(chunk);
  });
  request.on("end", () => {
    if (size > MAX_INTERNAL_BODY_BYTES) {
      sendError(response, 413, "TOO_LARGE", "Internal requests are at most 256 KiB.");
      return;
    }
    let body: unknown;
    try {
      body = parseProtocolJson(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      sendError(response, 400, "INVALID_PROTOCOL_JSON", (error as Error).message);
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      sendError(response, 400, "INVALID_REQUEST", "The body must be an object.");
      return;
    }
    handle(body as Record<string, unknown>);
  });
}
