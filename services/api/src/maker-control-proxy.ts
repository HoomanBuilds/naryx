import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const HASH = /^[0-9a-f]{64}$/;
const SHARD_ID = /^[A-Za-z0-9._:-]{1,257}$/;
const UNSIGNED = /^(?:0|[1-9][0-9]*)$/;
const MAX_BODY_BYTES = 1_024;
const MAX_RESPONSE_BYTES = 16_384;

function loopbackOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username !== "" || url.password !== ""
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]")
    || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("NARYX_SOLVER_INTERNAL_ORIGIN must be a loopback HTTP origin for maker controls.");
  }
  return url.origin;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new Error("Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object.");
  return value as Record<string, unknown>;
}

function authorized(token: unknown, expectedHash: Buffer): boolean {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) return false;
  return timingSafeEqual(createHash("sha256").update(token, "utf8").digest(), expectedHash);
}

export function createMakerControlProxy(options: Readonly<{
  solverOrigin: string;
  operatorTokenSha256: string;
  fetch?: typeof fetch;
}>): (request: IncomingMessage, response: ServerResponse) => boolean {
  const solverOrigin = loopbackOrigin(options.solverOrigin);
  if (!HASH.test(options.operatorTokenSha256)) throw new Error("NARYX_MAKER_OPERATOR_TOKEN_SHA256 must be 32 lowercase hex bytes.");
  const expectedHash = Buffer.from(options.operatorTokenSha256, "hex");
  const requestFetch = options.fetch ?? fetch;

  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://private-terminal.local");
    const match = /^\/internal\/terminal\/maker\/shards\/([^/]+)\/(cancel-all|kill-switch)$/.exec(url.pathname);
    if (match === null) return false;
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST, OPTIONS");
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is allowed." } });
      return true;
    }
    const shardId = match[1] as string;
    const action = match[2] as string;
    if (url.search !== "" || !SHARD_ID.test(shardId)) {
      send(response, 400, { error: { code: "INVALID_REQUEST", message: "Maker control path is invalid." } });
      return true;
    }
    void readBody(request).then(async (body) => {
      if (!authorized(body.operatorToken, expectedHash)) {
        send(response, 403, { error: { code: "OPERATOR_AUTHORIZATION_FAILED", message: "Operator authorization failed." } });
        return;
      }
      if (typeof body.expectedShardHash !== "string" || !HASH.test(body.expectedShardHash)
        || typeof body.expectedShardSequence !== "string" || !UNSIGNED.test(body.expectedShardSequence)) {
        send(response, 400, { error: { code: "INVALID_REQUEST", message: "Expected shard hash and sequence are required." } });
        return;
      }
      const upstream = await requestFetch(`${solverOrigin}/internal/maker/shards/${shardId}/${action}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedShardHash: body.expectedShardHash,
          expectedShardSequence: body.expectedShardSequence,
        }),
      });
      const text = await upstream.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Maker control response is too large.");
      const payload: unknown = JSON.parse(text);
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Maker control response is malformed.");
      send(response, upstream.status, payload);
    }).catch(() => {
      if (!response.headersSent) send(response, 502, { error: { code: "MAKER_CONTROL_FAILED", message: "Maker control failed closed." } });
      else response.destroy();
    });
    return true;
  };
}

export function loadMakerControlProxy(environment: NodeJS.ProcessEnv, solverOrigin: string) {
  const hash = environment.NARYX_MAKER_OPERATOR_TOKEN_SHA256;
  return hash === undefined ? undefined : createMakerControlProxy({ solverOrigin, operatorTokenSha256: hash });
}
