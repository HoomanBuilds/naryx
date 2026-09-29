import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  deriveImpliedPackageQuote,
  fromHex,
  fromProtocolJson,
  packageQuoteShard,
  packageQuoteShardHash,
  ProtocolError,
  solverRequestDigest,
  toHex,
  toProtocolJson,
  verifyPrivateRfqResponse,
} from "@naryx/protocol-types";
import type {
  AssetRef,
  DomainRef,
  ImpliedPackageQuoteInput,
  PackageQuoteShard,
  PackageQuoteShardInput,
  SolverCapabilityManifestInput,
  SolverCapacityCommitmentInput,
  SolverCapacityRecordInput,
  SolverRequestMethod,
} from "@naryx/protocol-types";
import { verifyEd25519 } from "./ed25519.js";
import { PackageExchangeStoreError, type SqlitePackageExchangeStore } from "./package-exchange-store.js";
import { RegistryStoreError, type SqliteRegistryStore } from "./registry-store.js";
import { shardIdOf, SolverApiStoreError, type SqliteSolverApiStore } from "./solver-api-store.js";
import { PrivateDeliveryStoreError, type SqlitePrivateDeliveryStore } from "./private-delivery-store.js";

const MAX_BODY_BYTES = 65_536;
const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;
const MILLIS = /^[1-9]\d{0,15}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHARD_ID = /^[A-Za-z0-9._:-]{1,257}$/;

export interface SolverApiOptions {
  readonly store: Pick<SqliteSolverApiStore, "outstandingCommitments" | "consumeNonce" | "admitShard" | "getShard" | "putCapacity" | "commitCapacity" | "releaseCapacity">;
  readonly registry: Pick<SqliteRegistryStore, "latest" | "registerSolverManifest">;
  /** Optional: book quote routes answer 503 without an exchange store. */
  readonly exchange?: Pick<SqlitePackageExchangeStore, "getBook" | "getMatchingPolicy" | "addImpliedLiquidity" | "cancelEntry">;
  /** Optional: private RFQ and sealed auction routes answer 503 without it. */
  readonly delivery?: Pick<SqlitePrivateDeliveryStore, "pendingFor" | "getEnvelope" | "acknowledge" | "storeResponse" | "appendAuctionEvent" | "auctionDefinition">;
  /** Current time in the books' expiry unit. */
  readonly nowValue: () => bigint;
  readonly clockMs?: () => number;
  /** Largest accepted difference between a request timestamp and server time. */
  readonly maxClockSkewMs?: number;
  readonly rateLimit: { readonly windowMs: number; readonly maxRequests: number };
}

class SolverRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(toProtocolJson(body)));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new SolverRequestError(413, "BODY_TOO_LARGE", "Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodeBody(raw: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = fromProtocolJson(JSON.parse(raw.toString("utf8")));
  } catch {
    throw new SolverRequestError(400, "INVALID_JSON", "Request body must be protocol JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SolverRequestError(400, "INVALID_REQUEST", "Request body must be an object.");
  return parsed as Record<string, unknown>;
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length === 0) throw new SolverRequestError(401, "UNAUTHENTICATED", `Missing ${name} header.`);
  return value;
}

/** Converts server time to a manifest's validity unit; slot-timed manifests cannot authenticate wall-clock requests. */
function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SolverRequestError(400, "INVALID_REQUEST", `${name} must be an object.`);
  return value as Record<string, unknown>;
}

function manifestNow(manifest: SolverCapabilityManifestInput, nowMs: number): bigint {
  if (manifest.validityUnit === "EVM_UNIX_SECONDS") return BigInt(Math.floor(nowMs / 1_000));
  if (manifest.validityUnit === "HYPERLIQUID_UNIX_MILLISECONDS") return BigInt(nowMs);
  throw new SolverRequestError(401, "VALIDITY_UNIT_UNSUPPORTED", "Slot-timed manifests cannot authenticate API requests.");
}

function validQuoteKeys(manifest: SolverCapabilityManifestInput, now: bigint) {
  return manifest.quoteVerificationKeys.filter((key) => key.scheme === "ED25519" && now >= key.validFromValue && now < key.validUntilValue);
}

/**
 * The authenticated solver API. Every request except manifest registration is signed by one of
 * the solver's registered, currently valid Ed25519 quote keys over `solverRequestDigest`, inside a
 * bounded clock skew, with a single-use nonce. A solver can change only its own shards, capacity,
 * and book entries. Shard contents must also be signed by a valid quote key over the shard hash.
 */
export function createSolverApiHandler(options: SolverApiOptions) {
  const { store, registry, exchange, delivery, nowValue } = options;
  const clockMs = options.clockMs ?? Date.now;
  const maxSkew = options.maxClockSkewMs ?? 30_000;
  const { windowMs, maxRequests } = options.rateLimit;
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error("Solver API rate limit must be positive.");
  }
  const windows = new Map<string, { start: number; count: number }>();

  function limited(key: string): boolean {
    const now = clockMs();
    const window = windows.get(key);
    if (window === undefined || now - window.start >= windowMs) {
      if (window === undefined && windows.size >= 10_000) {
        for (const [entryKey, entry] of windows) if (now - entry.start >= windowMs) windows.delete(entryKey);
        if (windows.size >= 10_000) return true;
      }
      windows.set(key, { start: now, count: 1 });
      return false;
    }
    window.count += 1;
    return window.count > maxRequests;
  }

  function manifestOf(solverId: string): SolverCapabilityManifestInput {
    const entry = registry.latest<SolverCapabilityManifestInput>("SOLVER_CAPABILITY", solverId);
    if (entry === undefined) throw new SolverRequestError(401, "UNKNOWN_SOLVER", "No capability manifest is registered for this solver.");
    return entry.document;
  }

  function authenticate(request: IncomingMessage, raw: Buffer): { solverId: string; manifest: SolverCapabilityManifestInput } {
    const solverId = header(request, "x-naryx-solver");
    const keyId = header(request, "x-naryx-key");
    const timestamp = header(request, "x-naryx-timestamp");
    const nonce = header(request, "x-naryx-nonce");
    const signature = header(request, "x-naryx-signature");
    if (!ID.test(solverId) || !ID.test(keyId) || !MILLIS.test(timestamp) || !HEX32.test(nonce) || !HEX64.test(signature)) {
      throw new SolverRequestError(401, "UNAUTHENTICATED", "Authentication headers are malformed.");
    }
    const nowMs = clockMs();
    if (Math.abs(Number(timestamp) - nowMs) > maxSkew) throw new SolverRequestError(401, "STALE_REQUEST", "Request timestamp is outside the accepted clock skew.");
    const manifest = manifestOf(solverId);
    const now = manifestNow(manifest, nowMs);
    if (now >= manifest.validUntilValue) throw new SolverRequestError(401, "MANIFEST_EXPIRED", "The solver's capability manifest has expired.");
    const key = validQuoteKeys(manifest, now).find((entry) => entry.keyId === keyId);
    if (key === undefined) throw new SolverRequestError(401, "KEY_NOT_VALID", "The key is unknown, not Ed25519, or outside its validity.");
    const digest = solverRequestDigest({
      method: request.method as SolverRequestMethod,
      pathAndQuery: request.url ?? "",
      bodySha256: new Uint8Array(createHash("sha256").update(raw).digest()),
      solverId,
      keyId,
      timestampMs: BigInt(timestamp),
      nonce,
    });
    if (!verifyEd25519(key.verificationKey, digest, fromHex(signature))) throw new SolverRequestError(401, "INVALID_SIGNATURE", "Request signature does not verify.");
    if (!store.consumeNonce(solverId, fromHex(nonce), maxSkew * 2)) throw new SolverRequestError(401, "REPLAYED_REQUEST", "This request nonce was already used.");
    return { solverId, manifest };
  }

  /** A shard's own signature must come from one of the solver's currently valid quote keys. */
  function verifiedShard(manifest: SolverCapabilityManifestInput, input: unknown, shardId: string): PackageQuoteShardInput {
    const shard = packageQuoteShard(input as PackageQuoteShardInput);
    if (shard.templateId.includes(".")) throw new SolverRequestError(400, "INVALID_REQUEST", "A quoted template id may not contain a dot.");
    if (shardIdOf(shard) !== shardId) throw new SolverRequestError(400, "SHARD_ID_MISMATCH", "The shard id must equal templateId.marketGroupId.");
    const hash = packageQuoteShardHash(shard);
    const keys = validQuoteKeys(manifest, manifestNow(manifest, clockMs()));
    if (!keys.some((key) => verifyEd25519(key.verificationKey, hash, shard.signature))) {
      throw new SolverRequestError(400, "INVALID_SHARD_SIGNATURE", "The shard is not signed by a valid quote key.");
    }
    return shard;
  }

  function admit(solverId: string, shard: PackageQuoteShardInput) {
    const result = store.admitShard(solverId, shard);
    if (!result.accepted) throw new SolverRequestError(409, result.reason, "The shard update was not admitted.");
    return { accepted: true, duplicate: result.duplicate, shardHash: result.shardHashHex, shardSequence: result.shard.shardSequence };
  }

  /** Every field except the named ones and the sequence must be unchanged from the current shard. */
  function onlyChanged(current: PackageQuoteShard | undefined, next: PackageQuoteShardInput, fields: readonly (keyof PackageQuoteShardInput)[]): void {
    if (current === undefined) throw new SolverRequestError(404, "SHARD_NOT_FOUND", "No current shard exists to change.");
    const strip = (shard: PackageQuoteShardInput) => {
      const copy: Record<string, unknown> = { ...shard, shardSequence: 0n, signature: new Uint8Array(0) };
      for (const field of fields) delete copy[field];
      return JSON.stringify(toProtocolJson(copy));
    };
    if (strip(current) !== strip(packageQuoteShard(next))) {
      throw new SolverRequestError(400, "UNEXPECTED_CHANGE", `This operation may change only: ${fields.join(", ") || "nothing"}.`);
    }
  }

  function requireDelivery() {
    if (delivery === undefined) throw new SolverRequestError(503, "PRIVATE_DELIVERY_UNAVAILABLE", "No private delivery relay is configured on this server.");
    return delivery;
  }

  /** Server time in an object's own unit; slot-timed objects cannot be judged against wall-clock time. */
  function wallClockIn(unit: string): bigint {
    if (unit === "EVM_UNIX_SECONDS") return BigInt(Math.floor(clockMs() / 1_000));
    if (unit === "HYPERLIQUID_UNIX_MILLISECONDS") return BigInt(clockMs());
    throw new SolverRequestError(400, "TIME_UNIT_UNSUPPORTED", "Slot-timed objects cannot be judged against wall-clock time here.");
  }

  function requireExchange() {
    if (exchange === undefined) throw new SolverRequestError(503, "EXCHANGE_UNAVAILABLE", "No package exchange is configured on this server.");
    return exchange;
  }

  async function route(request: IncomingMessage, url: URL): Promise<unknown> {
    const method = request.method ?? "GET";
    const path = url.pathname;
    const raw = await readBody(request);
    if (raw.length > 0 && request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
      throw new SolverRequestError(415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
    }

    // Registration is authenticated by the operator signature inside the manifest itself.
    if ((method === "PUT" && path === "/v1/solver/capability-manifest") || (method === "POST" && path === "/v1/solver/register")) {
      const body = decodeBody(raw);
      const registered = registry.registerSolverManifest(body.manifest as SolverCapabilityManifestInput);
      return { created: registered.created, manifestHash: registered.documentHashHex };
    }

    const { solverId, manifest } = authenticate(request, raw);
    let match: RegExpExecArray | null;
    if ((match = /^\/v1\/solver\/quote-shards\/([^/]+)(?:\/(replace|cancel-all|heartbeat))?$/.exec(path)) !== null) {
      const shardId = match[1] as string;
      if (!SHARD_ID.test(shardId)) throw new SolverRequestError(400, "INVALID_REQUEST", "Shard id is malformed.");
      const operation = match[2];
      if (method === "GET" && operation === undefined) {
        const shard = store.getShard(solverId, shardId);
        if (shard === undefined) throw new SolverRequestError(404, "SHARD_NOT_FOUND", "No such shard.");
        return { shard, shardHash: toHex(packageQuoteShardHash(shard)) };
      }
      const expected = operation === undefined ? "PUT" : "POST";
      if (method !== expected) throw new SolverRequestError(405, "METHOD_NOT_ALLOWED", `Use ${expected} for this shard operation.`);
      const shard = verifiedShard(manifest, decodeBody(raw).shard, shardId);
      const current = store.getShard(solverId, shardId);
      if (operation === "heartbeat") onlyChanged(current, shard, ["heartbeatExpiry"]);
      if (operation === "cancel-all") {
        onlyChanged(current, shard, ["quoteLevels"]);
        if (shard.quoteLevels.length !== 0) throw new SolverRequestError(400, "UNEXPECTED_CHANGE", "Cancel-all must leave no levels.");
      }
      if (operation === "replace") onlyChanged(current, shard, ["quoteLevels", "referenceStateHash", "referenceSequence", "heartbeatExpiry"]);
      return admit(solverId, shard);
    }
    if (method === "POST" && path === "/v1/solver/kill-switch") {
      const body = decodeBody(raw);
      const shardId = typeof body.shardId === "string" ? body.shardId : "";
      const shard = verifiedShard(manifest, body.shard, shardId);
      onlyChanged(store.getShard(solverId, shardId), shard, ["killSwitchState"]);
      if (shard.killSwitchState !== "ACTIVE") throw new SolverRequestError(400, "UNEXPECTED_CHANGE", "The kill switch route only activates the kill switch.");
      return admit(solverId, shard);
    }
    if (method === "PUT" && path === "/v1/solver/capacity") {
      store.putCapacity(solverId, decodeBody(raw).record as SolverCapacityRecordInput);
      return { accepted: true };
    }
    if (method === "POST" && path === "/v1/solver/reservations") {
      const body = decodeBody(raw);
      const scope = { domain: requireObject(body.domain, "domain") as unknown as DomainRef, asset: requireObject(body.asset, "asset") as unknown as AssetRef };
      // The commitment time is the server's, so a solver cannot backdate past expired evidence.
      const commitment = { ...requireObject(body.commitment, "commitment"), atValue: nowValue() } as unknown as SolverCapacityCommitmentInput;
      const result = store.commitCapacity(solverId, scope, commitment);
      if (!result.accepted) throw new SolverRequestError(409, result.rejection, "The capacity commitment was rejected.");
      return result;
    }
    if (method === "POST" && path === "/v1/solver/reservations/release") {
      const body = decodeBody(raw);
      store.releaseCapacity(solverId, { domain: requireObject(body.domain, "domain") as unknown as DomainRef, asset: requireObject(body.asset, "asset") as unknown as AssetRef }, body.commitmentId as string);
      return { released: true };
    }
    if (method === "POST" && path === "/v1/solver/quotes") {
      const body = decodeBody(raw);
      const classId = typeof body.packageMarketId === "string" && ID.test(body.packageMarketId) ? body.packageMarketId : undefined;
      if (classId === undefined) throw new SolverRequestError(400, "INVALID_REQUEST", "packageMarketId is malformed.");
      const books = requireExchange();
      const book = books.getBook(classId);
      const policy = book === undefined ? undefined : books.getMatchingPolicy(book.matchingPolicyHash);
      if (book === undefined || policy === undefined) throw new SolverRequestError(404, "BOOK_NOT_FOUND", "Package market is not open.");
      // The quote is derived here from its sources, so a solver cannot post a price its sources do not imply.
      const quote = deriveImpliedPackageQuote(policy, body.quote as ImpliedPackageQuoteInput);
      const now = nowValue();
      if (typeof body.expiresAtValue !== "bigint" || body.expiresAtValue <= now) {
        throw new SolverRequestError(400, "INVALID_REQUEST", "Executable implied liquidity needs a future expiresAtValue.");
      }
      // Executable depth must be backed by what this solver actually holds: every source
      // reservation, or the solver commitment, must be outstanding in a healthy capacity ledger,
      // and none may already back another live entry in this book.
      const outstanding = store.outstandingCommitments(solverId, now);
      const backing = quote.evidence === "SOLVER_BACKED_IMPLIED"
        ? [quote.solverCommitment]
        : quote.sources.map((source) => source.reservationId);
      for (const id of backing) {
        const held = id === undefined ? undefined : outstanding.get(toHex(id));
        if (held === undefined) throw new SolverRequestError(409, "BACKING_NOT_OUTSTANDING", "A reservation or commitment is not outstanding for this solver.");
        if (quote.evidence === "SOLVER_BACKED_IMPLIED" && !held.firm) throw new SolverRequestError(409, "BACKING_NOT_FIRM", "Solver-backed implication needs a firm commitment.");
      }
      const inUse = new Set(
        book.entries
          .filter((entry) => entry.implied !== undefined && (entry.expiresAtValue === undefined || entry.expiresAtValue > now))
          .flatMap((entry) => [
            ...(entry.implied?.solverCommitment === undefined ? [] : [toHex(entry.implied.solverCommitment)]),
            ...(entry.implied?.sources ?? []).flatMap((source) => (source.reservationId === undefined ? [] : [toHex(source.reservationId)])),
          ]),
      );
      if (backing.some((id) => id !== undefined && inUse.has(toHex(id)))) {
        throw new SolverRequestError(409, "BACKING_IN_USE", "A reservation or commitment already backs live liquidity in this book.");
      }
      const entry = books.addImpliedLiquidity(classId, {
        quote,
        participantId: solverId,
        commonControlGroupId: manifest.commonControlGroupId,
        expiresAtValue: body.expiresAtValue,
        nowValue: now,
      });
      return { entryId: toHex(entry.entryId), priceTicks: entry.priceTicks, quantity: entry.quantity };
    }
    if (method === "POST" && path === "/v1/solver/quotes/cancel") {
      const body = decodeBody(raw);
      const classId = typeof body.packageMarketId === "string" && ID.test(body.packageMarketId) ? body.packageMarketId : undefined;
      if (classId === undefined || typeof body.entryId !== "string" || !HEX32.test(body.entryId)) {
        throw new SolverRequestError(400, "INVALID_REQUEST", "packageMarketId and entryId are required.");
      }
      requireExchange().cancelEntry(classId, body.entryId, solverId);
      return { cancelled: true };
    }
    if (method === "GET" && path === "/v1/solver/private-rfqs") {
      const pending = requireDelivery().pendingFor(solverId, clockMs());
      return { envelopes: pending.map((entry) => ({ envelopeHash: entry.envelopeHashHex, envelope: entry.envelope, ciphertext: entry.ciphertext })) };
    }
    if ((match = /^\/v1\/solver\/private-rfqs\/([0-9a-f]{64})\/(ack|response)$/.exec(path)) !== null && method === "POST") {
      const relay = requireDelivery();
      const envelopeHash = match[1] as string;
      if (match[2] === "ack") {
        relay.acknowledge(envelopeHash, solverId);
        return { acknowledged: true };
      }
      const stored = relay.getEnvelope(envelopeHash);
      if (stored === undefined || stored.envelope.recipientSolverId !== solverId) throw new SolverRequestError(404, "NOT_FOUND", "No such envelope for this solver.");
      const body = decodeBody(raw);
      if (!(body.responseCiphertext instanceof Uint8Array) || body.responseCiphertext.length === 0) {
        throw new SolverRequestError(400, "INVALID_REQUEST", "responseCiphertext must be bytes.");
      }
      const verified = verifyPrivateRfqResponse(stored.envelope, {
        envelopeHash,
        solverId,
        quoteHash: body.quoteHash as string,
        quoteOrderHash: body.quoteOrderHash as string,
        responseEncryptionKey: body.responseEncryptionKey as Uint8Array,
        responseCiphertextHash: new Uint8Array(createHash("sha256").update(body.responseCiphertext).digest()),
      });
      if (!verified.valid) throw new SolverRequestError(409, verified.reason, "The encrypted response does not bind to this envelope.");
      relay.storeResponse(envelopeHash, verified.responseHash, { quoteHash: body.quoteHash, quoteOrderHash: body.quoteOrderHash }, body.responseCiphertext);
      return { responseHash: toHex(verified.responseHash) };
    }
    if ((match = /^\/v1\/solver\/auctions\/([0-9a-f]{64})\/(commit|reveal)$/.exec(path)) !== null && method === "POST") {
      const relay = requireDelivery();
      const auctionHash = match[1] as string;
      const atValue = wallClockIn(relay.auctionDefinition(auctionHash).timeUnit);
      const body = decodeBody(raw);
      const event = match[2] === "commit"
        ? { kind: "COMMIT" as const, solverId, commitment: body.commitment as string, atValue }
        : { kind: "REVEAL" as const, solverId, quoteHash: body.quoteHash as string, netOutcomeAtoms: body.netOutcomeAtoms as bigint, salt: body.salt as Uint8Array, atValue };
      const result = relay.appendAuctionEvent(auctionHash, event);
      if (!result.accepted) throw new SolverRequestError(409, result.reason, "The auction event was rejected.");
      return { accepted: true };
    }
    throw new SolverRequestError(404, "NOT_FOUND", "Unknown solver route.");
  }

  /** Returns false for paths outside /v1/solver/. */
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const url = new URL(request.url ?? "/", "http://solver-api.local");
    if (!url.pathname.startsWith("/v1/solver/")) return false;
    if (limited(request.socket.remoteAddress ?? "unknown")) {
      send(response, 429, { error: { code: "RATE_LIMITED", message: "Too many requests." } });
      return true;
    }
    route(request, url)
      .then((body) => send(response, 200, body))
      .catch((error: unknown) => {
        if (response.headersSent) return response.destroy();
        const reply = (status: number, code: string, message: string) => send(response, status, { error: { code, message } });
        if (error instanceof SolverRequestError) return reply(error.status, error.code, error.message);
        if (error instanceof ProtocolError) return reply(400, "INVALID_REQUEST", `${error.context}: ${error.detail}`);
        if (error instanceof RegistryStoreError) return reply(error.code === "DOCUMENT_CONFLICT" ? 409 : 400, error.code, error.message);
        if (error instanceof SolverApiStoreError) return reply(error.code === "NOT_OWNER" ? 403 : 400, error.code, error.message);
        if (error instanceof PackageExchangeStoreError) return reply(error.code === "BOOK_NOT_FOUND" ? 404 : 409, error.code, error.message);
        if (error instanceof PrivateDeliveryStoreError) return reply(error.code === "NOT_FOUND" ? 404 : 409, error.code, error.message);
        return reply(500, "INTERNAL_ERROR", "Solver request failed.");
      });
    return true;
  };
}
