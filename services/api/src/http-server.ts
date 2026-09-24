import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createTerminalPreview, parsePreviewRequest, PreviewValidationError } from "./terminal-preview.js";
import { createTerminalSnapshot } from "./terminal-snapshot.js";
import { isDomainId } from "./terminal-types.js";

const MAX_BODY_BYTES = 4_096;

export type PrivateTerminalServerConfig = {
  host: string;
  port: number;
  terminalOrigin: string | null;
};

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8_787;
  if (!/^\d{1,5}$/.test(value)) throw new Error("NARYX_API_PORT must be a valid TCP port.");
  const port = Number(value);
  if (port < 1 || port > 65_535) throw new Error("NARYX_API_PORT must be a valid TCP port.");
  return port;
}

function parseOrigin(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  const origin = new URL(value);
  if ((origin.protocol !== "http:" && origin.protocol !== "https:") ||
      origin.origin !== value || origin.username !== "" || origin.password !== "") {
    throw new Error("NARYX_TERMINAL_ORIGIN must be an exact HTTP or HTTPS origin.");
  }
  return origin.origin;
}

export function loadPrivateTerminalServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PrivateTerminalServerConfig {
  const host = environment.NARYX_API_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host) && environment.NARYX_ALLOW_UNSAFE_DEVELOPMENT_BIND !== "true") {
    throw new Error(
      "Non-loopback binding requires NARYX_ALLOW_UNSAFE_DEVELOPMENT_BIND=true.",
    );
  }
  return {
    host,
    port: parsePort(environment.NARYX_API_PORT),
    terminalOrigin: parseOrigin(environment.NARYX_TERMINAL_ORIGIN),
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

function reject(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  configuredOrigin: string | null,
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (configuredOrigin === null || origin !== configuredOrigin) {
    reject(response, 403, "ORIGIN_NOT_ALLOWED", "Browser origin is not allowed.");
    return false;
  }
  response.setHeader("Access-Control-Allow-Origin", configuredOrigin);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Vary", "Origin");
  return true;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new PreviewValidationError("INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_BODY_BYTES) {
      throw new PreviewValidationError("BODY_TOO_LARGE", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new PreviewValidationError("INVALID_JSON", "Request body must contain valid JSON.");
  }
}

export function createPrivateTerminalRequestHandler(config: PrivateTerminalServerConfig) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!applyCors(request, response, config.terminalOrigin)) return;
    const url = new URL(request.url ?? "/", "http://private-terminal.local");

    if (request.method === "OPTIONS") {
      if (request.headers.origin === undefined) {
        reject(response, 403, "ORIGIN_REQUIRED", "Preflight requires an allowed browser origin.");
        return;
      }
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/internal/healthz") {
      sendJson(response, 200, {
        status: "ready",
        scope: "private_terminal_preview",
        environment: "LOCAL_CONFORMANCE",
        executionAvailable: false,
      });
      return;
    }

    if (url.pathname === "/internal/terminal/snapshot") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      const domains = url.searchParams.getAll("domain");
      if (domains.length !== 1 || [...url.searchParams.keys()].some((key) => key !== "domain") ||
          !isDomainId(domains[0])) {
        reject(response, 400, "INVALID_DOMAIN", "Exactly one supported domain is required.");
        return;
      }
      sendJson(response, 200, createTerminalSnapshot(domains[0]));
      return;
    }

    if (url.pathname === "/internal/terminal/preview") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      try {
        const previewRequest = parsePreviewRequest(await readJson(request));
        sendJson(response, 200, createTerminalPreview(previewRequest));
      } catch (error) {
        if (error instanceof PreviewValidationError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 500, "INTERNAL_ERROR", "Preview calculation failed.");
      }
      return;
    }

    reject(response, 404, "NOT_FOUND", "Route not found.");
  };
}

export function createPrivateTerminalServer(config: PrivateTerminalServerConfig) {
  const handler = createPrivateTerminalRequestHandler(config);
  return createServer((request, response) => {
    handler(request, response).catch(() => {
      if (!response.headersSent) {
        reject(response, 500, "INTERNAL_ERROR", "Request handling failed.");
      } else {
        response.destroy();
      }
    });
  });
}
