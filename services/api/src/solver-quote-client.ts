const HASH_HEX = /^[0-9a-f]{64}$/;
const BYTE_HEX = /^(?:[0-9a-f]{2})+$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export interface SolverAtomicQuoteRequest {
  readonly orderHash: string;
  readonly idempotencyKey: string;
}

export interface SolverAtomicQuoteResponse {
  readonly version: 1;
  readonly status: "SIGNED";
  readonly idempotencyKey: string;
  readonly orderHash: string;
  readonly routeHash: string;
  readonly quoteHash: string;
  readonly solverSignatureDigest: string;
  readonly routeBytes: string;
  readonly solverQuoteBytes: string;
  readonly route: Readonly<Record<string, unknown>>;
  readonly quote: Readonly<Record<string, unknown>>;
}

export interface SolverAtomicQuotePort {
  quote(request: SolverAtomicQuoteRequest): Promise<SolverAtomicQuoteResponse>;
  verify?(
    response: SolverAtomicQuoteResponse,
    order: PackageOrder,
    currentClock: bigint,
  ): VerifiedSolverAtomicQuote;
}

export interface VerifiedSolverAtomicQuote {
  readonly route: RoutePayload;
  readonly quote: SolverQuote;
}

export class SolverQuoteClientError extends Error {
  readonly code: "INVALID_REQUEST" | "INVALID_ENDPOINT" | "UPSTREAM_REJECTED" | "INVALID_RESPONSE";

  constructor(code: SolverQuoteClientError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "SolverQuoteClientError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSolverAtomicQuoteRequest(value: unknown): SolverAtomicQuoteRequest {
  if (!isRecord(value)) {
    throw new SolverQuoteClientError("INVALID_REQUEST", "quote request must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "idempotencyKey" || keys[1] !== "orderHash") {
    throw new SolverQuoteClientError(
      "INVALID_REQUEST",
      "quote request must contain only idempotencyKey and orderHash",
    );
  }
  if (typeof value.orderHash !== "string" || !HASH_HEX.test(value.orderHash)) {
    throw new SolverQuoteClientError("INVALID_REQUEST", "orderHash must be 32 lowercase hex bytes");
  }
  if (typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(value.idempotencyKey)) {
    throw new SolverQuoteClientError("INVALID_REQUEST", "idempotencyKey is invalid");
  }
  return Object.freeze({ orderHash: value.orderHash, idempotencyKey: value.idempotencyKey });
}

export function validateSolverAtomicQuoteResponse(
  value: unknown,
  request: SolverAtomicQuoteRequest,
): SolverAtomicQuoteResponse {
  if (!isRecord(value)) {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver response must be an object");
  }
  const required = [
    "idempotencyKey",
    "orderHash",
    "quote",
    "quoteHash",
    "route",
    "routeBytes",
    "routeHash",
    "solverQuoteBytes",
    "solverSignatureDigest",
    "status",
    "version",
  ].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== required.length || !required.every((key, index) => keys[index] === key)) {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver response fields are invalid");
  }
  if (value.version !== 1 || value.status !== "SIGNED"
    || typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(value.idempotencyKey)
    || value.idempotencyKey !== request.idempotencyKey || value.orderHash !== request.orderHash) {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver response binding is invalid");
  }
  if (typeof value.routeHash !== "string" || !HASH_HEX.test(value.routeHash)
    || typeof value.quoteHash !== "string" || !HASH_HEX.test(value.quoteHash)
    || typeof value.solverSignatureDigest !== "string" || !HASH_HEX.test(value.solverSignatureDigest)
    || typeof value.routeBytes !== "string" || !BYTE_HEX.test(value.routeBytes)
    || typeof value.solverQuoteBytes !== "string" || !BYTE_HEX.test(value.solverQuoteBytes)
    || !isRecord(value.route) || !isRecord(value.quote)) {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver response evidence is invalid");
  }
  return value as unknown as SolverAtomicQuoteResponse;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

export function verifySolverAtomicQuoteResponse(
  response: SolverAtomicQuoteResponse,
  order: PackageOrder,
  currentClock: bigint,
): VerifiedSolverAtomicQuote {
  let route: RoutePayload;
  let quote: SolverQuote;
  try {
    route = routePayload(fromProtocolJson(response.route, "solver.route") as RoutePayloadInput);
    quote = solverQuote(fromProtocolJson(response.quote, "solver.quote") as SolverQuoteInput);
  } catch {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver route or quote is malformed");
  }
  const orderHash = packageOrderHash(order);
  const computedRouteHash = routeHash(route);
  const computedQuoteHash = quoteHash(quote);
  const digest = solverSignatureDigest(quote);
  if (response.orderHash !== hex(orderHash)
    || response.routeHash !== hex(computedRouteHash)
    || response.quoteHash !== hex(computedQuoteHash)
    || response.solverSignatureDigest !== hex(digest)
    || response.routeBytes !== hex(routePayloadBytes(route))
    || response.solverQuoteBytes !== hex(solverQuoteBytes(quote))
    || !bytesEqual(route.orderHash, orderHash)
    || !bytesEqual(quote.orderHash, orderHash)
    || !bytesEqual(quote.routeHash, computedRouteHash)) {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver evidence does not match canonical bytes");
  }
  if (route.environment !== order.environment
    || quote.environment !== order.environment
    || route.routeExpiryUnit !== order.expiryUnit
    || quote.validUntilUnit !== order.expiryUnit
    // A batched HyperCore route's expiry is its initial action's expiresAfter, which must end
    // strictly before the quote validity; every other route ends with its quote.
    || (order.settlementClass === "BATCHED_IOC_WITH_RECOVERY"
      ? route.routeExpiryValue >= quote.validUntilValue || quote.validUntilValue > order.expiryValue
      : route.routeExpiryValue !== quote.validUntilValue)
    || route.routeExpiryValue > order.expiryValue
    || typeof currentClock !== "bigint"
    || currentClock <= 0n
    || currentClock >= quote.validUntilValue) {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver quote freshness or environment is invalid");
  }
  if (quote.solverSignatureScheme !== "ED25519"
    || quote.quoteMode !== "EXECUTION_COMMITMENT"
    || quote.solverVerificationKey.length !== 32
    || quote.signature.length !== 64) {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver signature shape is invalid");
  }
  let signatureValid = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(quote.solverVerificationKey)]),
      format: "der",
      type: "spki",
    });
    signatureValid = verify(null, Buffer.from(digest), publicKey, Buffer.from(quote.signature));
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver signature verification failed");
  }
  return Object.freeze({ route, quote });
}

function requireLoopbackEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new SolverQuoteClientError("INVALID_ENDPOINT", "solver endpoint must be an absolute URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]"
    || url.hostname.startsWith("127.");
  if (url.protocol !== "http:" || !loopback || url.username !== "" || url.password !== ""
    || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new SolverQuoteClientError("INVALID_ENDPOINT", "solver endpoint must be a loopback HTTP origin");
  }
  return url.origin;
}

export class HttpInternalSolverQuoteClient implements SolverAtomicQuotePort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = requireLoopbackEndpoint(endpoint);
    this.#fetch = fetchImplementation;
  }

  async quote(rawRequest: SolverAtomicQuoteRequest): Promise<SolverAtomicQuoteResponse> {
    const request = parseSolverAtomicQuoteRequest(rawRequest);
    const response = await this.#fetch(`${this.#origin}/internal/quotes/atomic-entry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new SolverQuoteClientError(
        "UPSTREAM_REJECTED",
        `solver rejected quote request with HTTP ${response.status}`,
      );
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      throw new SolverQuoteClientError("INVALID_RESPONSE", "solver response must be JSON");
    }
    return validateSolverAtomicQuoteResponse(await response.json(), request);
  }

  verify(
    response: SolverAtomicQuoteResponse,
    order: PackageOrder,
    currentClock: bigint,
  ): VerifiedSolverAtomicQuote {
    return verifySolverAtomicQuoteResponse(response, order, currentClock);
  }
}
import { createPublicKey, verify } from "node:crypto";
import {
  bytesEqual,
  fromProtocolJson,
  packageOrderHash,
  quoteHash,
  routeHash,
  routePayload,
  routePayloadBytes,
  solverQuote,
  solverQuoteBytes,
  solverSignatureDigest,
  type PackageOrder,
  type RoutePayload,
  type RoutePayloadInput,
  type SolverQuote,
  type SolverQuoteInput,
} from "@naryx/protocol-types";
