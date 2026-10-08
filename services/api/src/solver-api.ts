import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  deriveImpliedPackageQuote,
  derivePackageImplicationProof,
  packageSeriesExposureFromEconomicSeries,
  verifyQuoteBond,
  type PerformanceBondLedger,
  fromHex,
  fromProtocolJson,
  packageQuoteShard,
  packageQuoteShardHash,
  ProtocolError,
  bytesEqual,
  solverQuote,
  solverRequestDigest,
  solverSignatureDigest,
  toHex,
  toProtocolJson,
  validatePackageAdmission,
  verifyPrivateRfqResponse,
} from "@naryx/protocol-types";
import type {
  AssetRef,
  DomainRef,
  ImpliedPackageQuoteInput,
  PackageImplicationSourceInput,
  PackageAdmissionInput,
  PackageOrderInput,
  PackageQuoteShard,
  PackageQuoteShardInput,
  RouteDecisionInput,
  RoutePayloadInput,
  SolverCapabilityManifestInput,
  SolverQuote,
  SolverQuoteInput,
  SolverCapacityCommitmentInput,
  SolverCapacityRecordInput,
  SolverRequestMethod,
} from "@naryx/protocol-types";
import { verifyEd25519 } from "./ed25519.js";
import { MAX_IMPLIED_BATCH, PackageExchangeStoreError, type SqlitePackageExchangeStore } from "./package-exchange-store.js";
import { RegistryStoreError, type SqliteRegistryStore } from "./registry-store.js";
import { shardIdOf, SolverApiStoreError, type SqliteSolverApiStore } from "./solver-api-store.js";
import { requestClientKey, createRateLimiter } from "./rate-limit.js";
import { EvidenceStoreError, type SqliteEvidenceStore } from "./evidence-store.js";
import { PrivateDeliveryStoreError, type SqlitePrivateDeliveryStore } from "./private-delivery-store.js";
import { acceptWebSocket, type WebSocketConnection } from "./websocket.js";

const MAX_BODY_BYTES = 65_536;
const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;
const MILLIS = /^[1-9]\d{0,15}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHARD_ID = /^[A-Za-z0-9._:-]{1,257}$/;

/** The registry state a domain's packages are admitted against: everything but the package and the time. */
export type AdmissionContext = Omit<PackageAdmissionInput, "order" | "quote" | "route" | "currentTime">;

export interface SolverApiOptions {
  readonly store: Pick<SqliteSolverApiStore, "outstandingCommitments" | "consumeNonce" | "admitShard" | "getShard" | "putCapacity" | "commitCapacity" | "releaseCapacity" | "shardFills">;
  readonly registry: Pick<SqliteRegistryStore, "latest" | "registerSolverManifest">;
  /** Optional: book quote routes answer 503 without an exchange store. */
  readonly exchange?: Pick<SqlitePackageExchangeStore, "getBook" | "getMatchingPolicy" | "getOpenExecutionClass" | "getSeriesRecord" | "addImpliedLiquidityBatch" | "addMultiPackageImpliedLiquidity" | "observeSourceVersion" | "cancelEntry">;
  /** Optional: the open order feed answers 503 without it. */
  readonly evidence?: Pick<SqliteEvidenceStore, "openOrders" | "settlementsForQuote" | "recordQuote" | "recordRouteDecision">;
  /** Optional: route simulation answers 503 without the admission context of the package's domain. */
  readonly admission?: ReadonlyMap<string, AdmissionContext>;
  /**
   * Optional: the observed ledger of a performance bond by id. FIRM_BONDED quotes are refused
   * without it, and accepted only when the kernel confirms the bond backs the quote.
   */
  readonly bonds?: (bondIdHex: string) => PerformanceBondLedger | undefined | Promise<PerformanceBondLedger | undefined>;
  /**
   * Committed atoms each package unit of implied liquidity consumes, per execution class: from the
   * solver commitment, and from each leg's reservation in leg order. Executable implied quantity
   * is bounded by what its backing actually holds; a class without an entry takes no implied liquidity.
   */
  readonly backingAtomsPerPackageUnit?: ReadonlyMap<string, { readonly commitment: bigint; readonly legs: readonly bigint[] }>;
  readonly packageSourceBackingAtomsPerUnit?: ReadonlyMap<string, bigint>;
  /** Optional: private RFQ and sealed auction routes answer 503 without it. */
  readonly delivery?: Pick<SqlitePrivateDeliveryStore, "pendingFor" | "getEnvelope" | "acknowledge" | "storeResponse" | "eligibleAuctions" | "appendAuctionEvent" | "auctionDefinition">;
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

interface SignedSolverRequest {
  readonly method: SolverRequestMethod;
  readonly pathAndQuery: string;
  readonly body: Buffer;
  readonly solverId: string;
  readonly keyId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}

/**
 * Verifies one signed solver request: a registered, unexpired manifest; a currently valid Ed25519
 * quote key; a timestamp inside the skew; a signature over `solverRequestDigest`; and a nonce used
 * for the first time. The HTTP API and the solver stream both authenticate through it.
 */
function verifySolverRequest(
  options: Pick<SolverApiOptions, "store" | "registry">,
  request: SignedSolverRequest,
  nowMs: number,
  maxSkew: number,
): { solverId: string; manifest: SolverCapabilityManifestInput } {
  const { solverId, keyId, timestamp, nonce, signature } = request;
  if (!ID.test(solverId) || !ID.test(keyId) || !MILLIS.test(timestamp) || !HEX32.test(nonce) || !HEX64.test(signature)) {
    throw new SolverRequestError(401, "UNAUTHENTICATED", "Authentication fields are malformed.");
  }
  if (Math.abs(Number(timestamp) - nowMs) > maxSkew) throw new SolverRequestError(401, "STALE_REQUEST", "Request timestamp is outside the accepted clock skew.");
  const entry = options.registry.latest<SolverCapabilityManifestInput>("SOLVER_CAPABILITY", solverId);
  if (entry === undefined) throw new SolverRequestError(401, "UNKNOWN_SOLVER", "No capability manifest is registered for this solver.");
  const manifest = entry.document;
  const now = manifestNow(manifest, nowMs);
  if (now >= manifest.validUntilValue) throw new SolverRequestError(401, "MANIFEST_EXPIRED", "The solver's capability manifest has expired.");
  const key = validQuoteKeys(manifest, now).find((candidate) => candidate.keyId === keyId);
  if (key === undefined) throw new SolverRequestError(401, "KEY_NOT_VALID", "The key is unknown, not Ed25519, or outside its validity.");
  const digest = solverRequestDigest({
    method: request.method,
    pathAndQuery: request.pathAndQuery,
    bodySha256: new Uint8Array(createHash("sha256").update(request.body).digest()),
    solverId,
    keyId,
    timestampMs: BigInt(timestamp),
    nonce,
  });
  if (!verifyEd25519(key.verificationKey, digest, fromHex(signature))) throw new SolverRequestError(401, "INVALID_SIGNATURE", "Request signature does not verify.");
  if (!options.store.consumeNonce(solverId, fromHex(nonce), maxSkew * 2)) throw new SolverRequestError(401, "REPLAYED_REQUEST", "This request nonce was already used.");
  return { solverId, manifest };
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
  const limited = createRateLimiter({ windowMs, maxRequests, clockMs });

  function authenticate(request: IncomingMessage, raw: Buffer): { solverId: string; manifest: SolverCapabilityManifestInput } {
    return verifySolverRequest(
      options,
      {
        method: request.method as SolverRequestMethod,
        pathAndQuery: request.url ?? "",
        body: raw,
        solverId: header(request, "x-naryx-solver"),
        keyId: header(request, "x-naryx-key"),
        timestamp: header(request, "x-naryx-timestamp"),
        nonce: header(request, "x-naryx-nonce"),
        signature: header(request, "x-naryx-signature"),
      },
      clockMs(),
      maxSkew,
    );
  }

  function ownedSourceId(solverId: string, value: unknown): string {
    if (typeof value !== "string" || !ID.test(value) || !value.startsWith(`${solverId}:`)) {
      throw new SolverRequestError(403, "SOURCE_NOT_OWNED", "An implied source id must be namespaced to the authenticated solver.");
    }
    return value;
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

  /** Server time in an object's own unit, or undefined for slot-timed objects. */
  function nowIn(unit: string): bigint | undefined {
    if (unit === "EVM_UNIX_SECONDS") return BigInt(Math.floor(clockMs() / 1_000));
    if (unit === "HYPERLIQUID_UNIX_MILLISECONDS") return BigInt(clockMs());
    return undefined;
  }

  /** Server time in an object's own unit; slot-timed objects cannot be judged against wall-clock time. */
  function wallClockIn(unit: string): bigint {
    const now = nowIn(unit);
    if (now === undefined) throw new SolverRequestError(400, "TIME_UNIT_UNSUPPORTED", "Slot-timed objects cannot be judged against wall-clock time here.");
    return now;
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
    if ((match = /^\/v1\/solver\/quote-shards\/([^/]+)\/fills$/.exec(path)) !== null) {
      // The fills the controller settled against this solver's shard, so a maker can reconcile
      // inventory and re-sign its reserved capacity.
      const shardId = match[1] as string;
      if (!SHARD_ID.test(shardId)) throw new SolverRequestError(400, "INVALID_REQUEST", "Shard id is malformed.");
      if (method !== "GET") throw new SolverRequestError(405, "METHOD_NOT_ALLOWED", "Use GET for shard fills.");
      return { shardId, fills: store.shardFills(solverId, shardId) };
    }
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
    if (method === "PUT" && (match = /^\/v1\/solver\/sources\/([^/]+)\/version$/.exec(path)) !== null) {
      const sourceId = ownedSourceId(solverId, match[1]);
      const sourceVersion = decodeBody(raw).sourceVersion;
      if (typeof sourceVersion !== "bigint" || sourceVersion < 0n || sourceVersion > 18_446_744_073_709_551_615n) {
        throw new SolverRequestError(400, "INVALID_REQUEST", "sourceVersion must be an unsigned 64-bit integer.");
      }
      const invalidated = requireExchange().observeSourceVersion(sourceId, sourceVersion);
      return { sourceId, sourceVersion, invalidatedEntryIds: invalidated.map(toHex) };
    }
    if (method === "POST" && path === "/v1/solver/quotes/package-implication") {
      const body = decodeBody(raw);
      const classId = typeof body.packageMarketId === "string" && ID.test(body.packageMarketId)
        ? body.packageMarketId
        : undefined;
      if (classId === undefined) throw new SolverRequestError(400, "INVALID_REQUEST", "packageMarketId is malformed.");
      const books = requireExchange();
      const book = books.getBook(classId);
      const policy = book === undefined ? undefined : books.getMatchingPolicy(book.matchingPolicyHash);
      const executionClass = books.getOpenExecutionClass(classId);
      if (book === undefined || policy === undefined || executionClass === undefined) {
        throw new SolverRequestError(404, "BOOK_NOT_FOUND", "Package market is not open.");
      }
      const targetRecord = books.getSeriesRecord(executionClass.seriesId, executionClass.seriesVersion);
      if (targetRecord === undefined
        || !bytesEqual(fromHex(targetRecord.documentHashHex), executionClass.seriesManifestHash)) {
        throw new SolverRequestError(409, "SERIES_BINDING_INVALID", "The open market has no matching registered strategy series.");
      }
      if (!Array.isArray(body.sources)) {
        throw new SolverRequestError(400, "INVALID_REQUEST", "sources must be an array.");
      }
      const sources = body.sources.map((value, index): PackageImplicationSourceInput => {
        const source = requireObject(value, `sources[${index}]`);
        const seriesId = typeof source.seriesId === "string" && ID.test(source.seriesId) ? source.seriesId : undefined;
        const seriesVersion = typeof source.seriesVersion === "number" && Number.isSafeInteger(source.seriesVersion)
          ? source.seriesVersion
          : undefined;
        if (seriesId === undefined || seriesVersion === undefined) {
          throw new SolverRequestError(400, "INVALID_REQUEST", `sources[${index}] has a malformed series reference.`);
        }
        const record = books.getSeriesRecord(seriesId, seriesVersion);
        if (record === undefined) {
          throw new SolverRequestError(409, "SERIES_UNKNOWN", `sources[${index}] references an unregistered strategy series.`);
        }
        return {
          entryId: source.entryId as Uint8Array | string,
          sourceVersion: source.sourceVersion as bigint,
          side: source.side as PackageImplicationSourceInput["side"],
          priceTicks: source.priceTicks as bigint,
          quantity: source.quantity as bigint,
          derivationDepth: source.derivationDepth as number,
          series: packageSeriesExposureFromEconomicSeries(record.document, record.documentHashHex),
          unitsPerTarget: requireObject(source.unitsPerTarget, `sources[${index}].unitsPerTarget`) as unknown as PackageImplicationSourceInput["unitsPerTarget"],
          reservationId: source.reservationId as Uint8Array | string,
          ancestorEntryIds: source.ancestorEntryIds as readonly (Uint8Array | string)[],
        };
      });
      const expiresAtValue = body.expiresAtValue;
      const now = nowValue();
      if (typeof expiresAtValue !== "bigint" || expiresAtValue <= now) {
        throw new SolverRequestError(400, "INVALID_REQUEST", "Executable implied liquidity needs a future expiresAtValue.");
      }
      const proof = derivePackageImplicationProof(policy, {
        version: 1,
        targetExecutionClassId: classId,
        targetSide: body.targetSide as PackageImplicationSourceInput["side"],
        targetSeries: packageSeriesExposureFromEconomicSeries(targetRecord.document, targetRecord.documentHashHex),
        sources,
      });
      const outstanding = store.outstandingCommitments(solverId, now);
      const inUse = new Set(
        book.entries
          .filter((entry) => entry.implied !== undefined && (entry.expiresAtValue === undefined || entry.expiresAtValue > now))
          .flatMap((entry) => entry.implied?.sources.flatMap((source) =>
            source.reservationId === undefined ? [] : [toHex(source.reservationId)]) ?? []),
      );
      for (const source of proof.sources) {
        const reservationId = toHex(source.reservationId);
        const held = outstanding.get(reservationId);
        if (held === undefined) {
          throw new SolverRequestError(409, "BACKING_NOT_OUTSTANDING", "A package source reservation is not outstanding for this solver.");
        }
        if (!held.firm) {
          throw new SolverRequestError(409, "BACKING_NOT_FIRM", "Package implication requires firm source reservations.");
        }
        const atomsPerUnit = options.packageSourceBackingAtomsPerUnit?.get(source.series.seriesId);
        if (atomsPerUnit === undefined || atomsPerUnit <= 0n) {
          throw new SolverRequestError(409, "BACKING_UNIT_UNKNOWN", `Series ${source.series.seriesId} has no configured backing unit.`);
        }
        if (source.quantity * atomsPerUnit > held.atoms) {
          throw new SolverRequestError(409, "BACKING_INSUFFICIENT", "A package source reservation is smaller than its quoted quantity.");
        }
        if (inUse.has(reservationId)) {
          throw new SolverRequestError(409, "BACKING_IN_USE", "A package source reservation already backs live liquidity in this book.");
        }
        inUse.add(reservationId);
      }
      const entry = books.addMultiPackageImpliedLiquidity(classId, {
        proof,
        participantId: solverId,
        commonControlGroupId: manifest.commonControlGroupId,
        expiresAtValue,
        nowValue: now,
      });
      return {
        entryId: toHex(entry.entryId),
        proofHash: toHex(proof.proofHash),
        priceTicks: entry.priceTicks,
        quantity: entry.quantity,
        derivationDepth: entry.implied?.derivationDepth,
      };
    }
    if (method === "POST" && (path === "/v1/solver/quotes" || path === "/v1/solver/quotes/batch")) {
      const body = decodeBody(raw);
      const classId = typeof body.packageMarketId === "string" && ID.test(body.packageMarketId) ? body.packageMarketId : undefined;
      if (classId === undefined) throw new SolverRequestError(400, "INVALID_REQUEST", "packageMarketId is malformed.");
      const batch = path === "/v1/solver/quotes/batch";
      const items = batch ? body.quotes : [{ quote: body.quote, expiresAtValue: body.expiresAtValue }];
      if (!Array.isArray(items) || items.length === 0 || items.length > MAX_IMPLIED_BATCH) {
        throw new SolverRequestError(400, "INVALID_REQUEST", `quotes must hold 1 to ${MAX_IMPLIED_BATCH} entries.`);
      }
      const books = requireExchange();
      const book = books.getBook(classId);
      const policy = book === undefined ? undefined : books.getMatchingPolicy(book.matchingPolicyHash);
      if (book === undefined || policy === undefined) throw new SolverRequestError(404, "BOOK_NOT_FOUND", "Package market is not open.");
      const now = nowValue();
      // Executable depth must be backed by what this solver actually holds: every source
      // reservation, or the solver commitment, must be outstanding in a healthy capacity ledger,
      // and none may already back another live entry in this book or another quote in the batch.
      const outstanding = store.outstandingCommitments(solverId, now);
      const inUse = new Set(
        book.entries
          .filter((entry) => entry.implied !== undefined && (entry.expiresAtValue === undefined || entry.expiresAtValue > now))
          .flatMap((entry) => [
            ...(entry.implied?.solverCommitment === undefined ? [] : [toHex(entry.implied.solverCommitment)]),
            ...(entry.implied?.sources ?? []).flatMap((source) => (source.reservationId === undefined ? [] : [toHex(source.reservationId)])),
          ]),
      );
      const inputs = items.map((item: unknown) => {
        const entry = requireObject(item, "quote entry");
        const quoteInput = requireObject(entry.quote, "quote");
        if (!Array.isArray(quoteInput.legSources)) {
          throw new SolverRequestError(400, "INVALID_REQUEST", "quote.legSources must be an array.");
        }
        for (const source of quoteInput.legSources) {
          ownedSourceId(solverId, requireObject(source, "quote leg source").sourceId);
        }
        // The quote is derived here from its sources, so a solver cannot post a price its sources do not imply.
        const quote = deriveImpliedPackageQuote(policy, quoteInput as unknown as ImpliedPackageQuoteInput);
        if (typeof entry.expiresAtValue !== "bigint" || entry.expiresAtValue <= now) {
          throw new SolverRequestError(400, "INVALID_REQUEST", "Executable implied liquidity needs a future expiresAtValue.");
        }
        const backing = quote.evidence === "SOLVER_BACKED_IMPLIED"
          ? [quote.solverCommitment]
          : quote.sources.map((source) => source.reservationId);
        const units = options.backingAtomsPerPackageUnit?.get(classId);
        if (units === undefined || (quote.evidence !== "SOLVER_BACKED_IMPLIED" && units.legs.length !== backing.length)) {
          throw new SolverRequestError(409, "BACKING_UNIT_UNKNOWN", "This market has no backing unit, so its implied liquidity cannot be bounded.");
        }
        for (const [index, id] of backing.entries()) {
          const held = id === undefined ? undefined : outstanding.get(toHex(id));
          if (held === undefined) throw new SolverRequestError(409, "BACKING_NOT_OUTSTANDING", "A reservation or commitment is not outstanding for this solver.");
          const perUnit = quote.evidence === "SOLVER_BACKED_IMPLIED" ? units.commitment : (units.legs[index] as bigint);
          if (quote.quantity * perUnit > held.atoms) {
            throw new SolverRequestError(409, "BACKING_INSUFFICIENT", "The implied quantity needs more than its reservation or commitment holds.");
          }
          if (quote.evidence === "SOLVER_BACKED_IMPLIED" && !held.firm) throw new SolverRequestError(409, "BACKING_NOT_FIRM", "Solver-backed implication needs a firm commitment.");
          if (inUse.has(toHex(id as Uint8Array))) {
            throw new SolverRequestError(409, "BACKING_IN_USE", "A reservation or commitment already backs live liquidity in this book.");
          }
          inUse.add(toHex(id as Uint8Array));
        }
        return { quote, participantId: solverId, commonControlGroupId: manifest.commonControlGroupId, expiresAtValue: entry.expiresAtValue, nowValue: now };
      });
      const entries = books.addImpliedLiquidityBatch(classId, inputs);
      const posted = entries.map((entry) => ({ entryId: toHex(entry.entryId), priceTicks: entry.priceTicks, quantity: entry.quantity }));
      return batch ? { entries: posted } : posted[0];
    }
    if (method === "POST" && path === "/v1/solver/quotes/cancel") {
      const body = decodeBody(raw);
      const classId = typeof body.packageMarketId === "string" && ID.test(body.packageMarketId) ? body.packageMarketId : undefined;
      if (classId === undefined || typeof body.entryId !== "string" || !HEX32.test(body.entryId)) {
        throw new SolverRequestError(400, "INVALID_REQUEST", "packageMarketId and entryId are required.");
      }
      const result = requireExchange().cancelEntry(classId, body.entryId, solverId);
      return { cancelled: true, ...result };
    }
    if (method === "GET" && (match = /^\/v1\/solver\/settlements\/([0-9a-f]{64})$/.exec(path)) !== null) {
      // Only this solver's own settled receipts for the quote are visible to it.
      if (options.evidence === undefined) throw new SolverRequestError(503, "EVIDENCE_UNAVAILABLE", "No evidence store is configured on this server.");
      const quoteHash = match[1] as string;
      const settlements = options.evidence.settlementsForQuote(quoteHash, solverId);
      if (settlements.length === 0) throw new SolverRequestError(404, "SETTLEMENT_NOT_FOUND", "No settled receipt names this quote for this solver.");
      return {
        quoteHash,
        settlements: settlements.map((entry) => ({
          orderHash: entry.orderHashHex,
          terminalState: entry.terminalState,
          outcomeHash: entry.outcomeHashHex,
          receiptHash: entry.receiptHashHex,
          recordedAtMs: entry.recordedAtMs,
        })),
      };
    }
    if (method === "POST" && path === "/v1/solver/order-quotes") {
      // A signed quote answering a public order. Only the authenticated solver's own quote, signed
      // by one of its valid registered keys under its current manifest, is accepted, and a quote is
      // stored with the exact route it binds.
      if (options.evidence === undefined) throw new SolverRequestError(503, "EVIDENCE_UNAVAILABLE", "No evidence store is configured on this server.");
      const body = decodeBody(raw);
      const quoteInput = requireObject(body.quote, "quote") as unknown as SolverQuoteInput;
      const routeInput = requireObject(body.route, "route") as unknown as RoutePayloadInput;
      let quote: SolverQuote;
      try {
        quote = solverQuote(quoteInput);
      } catch (error) {
        throw new SolverRequestError(400, "INVALID_QUOTE", `The quote failed validation: ${(error as Error).message}`);
      }
      if (quote.solverId !== solverId) throw new SolverRequestError(403, "SOLVER_MISMATCH", "A solver can submit only its own quotes.");
      const registered = registry.latest<SolverCapabilityManifestInput>("SOLVER_CAPABILITY", solverId);
      if (registered === undefined || registered.documentHashHex !== toHex(quote.solverCapabilityManifestHash)) {
        throw new SolverRequestError(409, "MANIFEST_MISMATCH", "The quote does not bind the solver's current capability manifest.");
      }
      if (quote.solverSignatureScheme !== "ED25519") throw new SolverRequestError(400, "UNSUPPORTED_SIGNATURE_SCHEME", "Public quotes are signed with Ed25519.");
      const keys = validQuoteKeys(manifest, manifestNow(manifest, clockMs()));
      if (!keys.some((key) => bytesEqual(key.verificationKey, quote.solverVerificationKey))) {
        throw new SolverRequestError(400, "KEY_NOT_VALID", "The quote key is not a currently valid registered quote key.");
      }
      if (!verifyEd25519(quote.solverVerificationKey, solverSignatureDigest(quoteInput), quote.signature)) {
        throw new SolverRequestError(400, "INVALID_QUOTE_SIGNATURE", "The quote signature does not verify.");
      }
      // Firmness labels are honest: the kernel already requires a firm quote to name its
      // reservation, and outside production no quote may claim onchain firmness.
      if (quote.quoteMode === "FIRM_ONCHAIN" && quote.environment !== "mainnet") {
        throw new SolverRequestError(400, "QUOTE_MODE_MISLABELED", "Outside production a reserved quote is FIRM_SIMULATED, never FIRM_ONCHAIN.");
      }
      if (wallClockIn(quote.validUntilUnit) >= quote.validUntilValue) throw new SolverRequestError(400, "QUOTE_EXPIRED", "The quote has already expired.");
      if (quote.quoteMode === "FIRM_BONDED") {
        const ledger = await options.bonds?.(toHex(quote.performanceBondId as Uint8Array));
        if (ledger === undefined) throw new SolverRequestError(409, "BOND_UNVERIFIED", "No observed performance bond backs this quote.");
        // The only bond vault is the EVM PerformanceBondVault, whose terms are in block seconds.
        const backing = verifyQuoteBond(quote, ledger, "EVM_UNIX_SECONDS");
        if (!backing.backed) throw new SolverRequestError(409, "BOND_INSUFFICIENT", `The bond does not back the quote: ${backing.violations.join(", ")}.`);
      }
      return { ...options.evidence.recordQuote(quoteInput, routeInput, nowIn), quoteMode: quote.quoteMode };
    }
    if (method === "POST" && path === "/v1/solver/routes/decision") {
      // The solver's route decision for a public order it quoted, replayed from its bounded
      // evidence and kept on the record whatever the replay finds.
      if (options.evidence === undefined) throw new SolverRequestError(503, "EVIDENCE_UNAVAILABLE", "No evidence store is configured on this server.");
      const body = decodeBody(raw);
      const decision = requireObject(body.decision, "decision") as unknown as RouteDecisionInput;
      if (decision.solverId !== solverId) throw new SolverRequestError(403, "SOLVER_MISMATCH", "A solver can record only its own route decisions.");
      return options.evidence.recordRouteDecision(decision);
    }
    if (method === "POST" && path === "/v1/solver/routes/simulate") {
      // A dry run of package admission for an order, quote, and route against this server's
      // registry state for the domain. Nothing is stored, reserved, or signed.
      const body = decodeBody(raw);
      const order = requireObject(body.order, "order") as unknown as PackageOrderInput;
      const quoteInput = requireObject(body.quote, "quote") as unknown as SolverQuoteInput;
      const routeInput = requireObject(body.route, "route") as unknown as RoutePayloadInput;
      if ((quoteInput as { solverId?: unknown }).solverId !== solverId) throw new SolverRequestError(403, "SOLVER_MISMATCH", "A solver can simulate only its own quotes.");
      const domainId = String((order as { domain?: { domainId?: unknown } }).domain?.domainId);
      const context = options.admission?.get(domainId);
      if (context === undefined) throw new SolverRequestError(503, "ADMISSION_UNAVAILABLE", "This server holds no admission context for the order's domain.");
      // Wall-clock domains are judged on server time; a slot-timed domain on the slot the caller names.
      const unit = String((order as { expiryUnit?: unknown }).expiryUnit);
      const serverNow = nowIn(unit);
      let currentTime: { unit: "SOLANA_SLOT" | "EVM_UNIX_SECONDS" | "HYPERLIQUID_UNIX_MILLISECONDS"; value: bigint };
      let timeSource: "SERVER" | "CALLER";
      if (serverNow !== undefined) {
        currentTime = { unit: unit as "EVM_UNIX_SECONDS" | "HYPERLIQUID_UNIX_MILLISECONDS", value: serverNow };
        timeSource = "SERVER";
      } else {
        if (unit !== "SOLANA_SLOT" || typeof body.atSlot !== "bigint" || body.atSlot <= 0n) {
          throw new SolverRequestError(400, "TIME_REQUIRED", "A slot-timed order is simulated at an explicit positive atSlot.");
        }
        currentTime = { unit: "SOLANA_SLOT", value: body.atSlot };
        timeSource = "CALLER";
      }
      let signatureValid = false;
      try {
        const quote = solverQuote(quoteInput);
        signatureValid = quote.solverSignatureScheme === "ED25519" && verifyEd25519(quote.solverVerificationKey, solverSignatureDigest(quoteInput), quote.signature);
      } catch {
        signatureValid = false;
      }
      try {
        const admission = validatePackageAdmission({ ...context, order, quote: quoteInput, route: routeInput, currentTime });
        return {
          simulated: true,
          admitted: true,
          orderHash: toHex(admission.orderHash),
          quoteHash: toHex(admission.quoteHash),
          routeHash: toHex(admission.routeHash),
          signatureValid,
          currentTime,
          timeSource,
        };
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        return { simulated: true, admitted: false, error: { code: error.code, context: error.context, detail: error.detail }, signatureValid, currentTime, timeSource };
      }
    }
    if (method === "GET" && path === "/v1/solver/orders") {
      // Signed public orders without a terminal outcome, oldest first, paged by cursor.
      if (options.evidence === undefined) throw new SolverRequestError(503, "EVIDENCE_UNAVAILABLE", "No evidence store is configured on this server.");
      const after = url.searchParams.get("after") ?? "0";
      if (!/^(0|[1-9]\d{0,15})$/.test(after)) throw new SolverRequestError(400, "INVALID_REQUEST", "after must be a non-negative cursor.");
      const page = options.evidence.openOrders(Number(after), 100, nowIn);
      return {
        orders: page.orders.map((entry) => ({ cursor: entry.cursor, orderHash: entry.orderHashHex, order: entry.order, receivedAtMs: entry.receivedAtMs })),
        nextCursor: page.nextCursor,
      };
    }
    if (method === "GET" && path === "/v1/solver/private-rfqs") {
      const pending = requireDelivery().pendingFor(solverId, clockMs());
      // The sender signature travels with the envelope so the recipient can authenticate the sender itself.
      return {
        envelopes: pending.map((entry) => ({
          envelopeHash: entry.envelopeHashHex,
          envelope: entry.envelope,
          ciphertext: entry.ciphertext,
          ...(entry.senderSignature === undefined ? {} : { senderSignature: entry.senderSignature }),
        })),
      };
    }
    if (method === "GET" && path === "/v1/solver/auctions") {
      const after = url.searchParams.get("after") ?? "0";
      if (!/^(0|[1-9]\d{0,15})$/.test(after)) {
        throw new SolverRequestError(400, "INVALID_REQUEST", "after must be a non-negative cursor.");
      }
      const page = requireDelivery().eligibleAuctions(solverId, Number(after), 100);
      return {
        auctions: page.auctions.map((entry) => ({
          cursor: entry.cursor,
          auctionHash: entry.auctionHashHex,
          definition: entry.definition,
          createdAtMs: entry.createdAtMs,
        })),
        nextCursor: page.nextCursor,
      };
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
    if (limited(requestClientKey(request))) {
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
        if (error instanceof EvidenceStoreError) {
          const status = ["INVALID_QUOTE", "INVALID_ROUTE", "ROUTE_MISMATCH", "INVALID_DECISION"].includes(error.code) ? 400 : error.code === "ORDER_NOT_FOUND" ? 404 : error.code === "CORRUPT_ROW" ? 500 : 409;
          return reply(status, error.code, error.message);
        }
        return reply(500, "INTERNAL_ERROR", "Solver request failed.");
      });
    return true;
  };
}

export interface SolverStreamOptions extends Pick<SolverApiOptions, "store" | "registry" | "evidence" | "delivery" | "clockMs" | "maxClockSkewMs"> {
  readonly pollIntervalMs?: number;
  readonly maximumConnectionsPerSolver?: number;
}

/** The request a solver signs to open its stream: `GET /v1/solver/stream` with an empty body. */
export const SOLVER_STREAM_PATH = "/v1/solver/stream";

/**
 * The authenticated solver stream at `/v1/solver/stream`. The first message must be an `auth`
 * message carrying the fields of a signed `GET /v1/solver/stream` request with an empty body; it
 * is verified exactly as an HTTP request is, nonce included, and anything else first closes the
 * connection. Then `orders` pushes open public orders after a cursor, as `GET /v1/solver/orders`
 * pages them, `private-rfqs` pushes each pending envelope addressed to this solver once per
 * connection, and `auctions` pushes immutable eligible auction definitions after a cursor.
 * Acknowledgements, responses, commits, and reveals stay on the signed HTTP routes.
 */
export function createSolverStream(options: SolverStreamOptions): {
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
} {
  const clockMs = options.clockMs ?? Date.now;
  const maxSkew = options.maxClockSkewMs ?? 30_000;
  const perSolver = options.maximumConnectionsPerSolver ?? 4;
  interface StreamClient {
    readonly connection: WebSocketConnection;
    solverId?: string;
    orders?: { cursor: number };
    privateRfqs?: Set<string>;
    auctions?: { cursor: number };
    readonly authTimer: ReturnType<typeof setTimeout>;
    readonly key: string;
  }
  const clients = new Set<StreamClient>();
  const send = (client: StreamClient, message: Record<string, unknown>) => client.connection.send(JSON.stringify(toProtocolJson(message)));
  const nowIn = (unit: string): bigint | undefined => {
    if (unit === "EVM_UNIX_SECONDS") return BigInt(Math.floor(clockMs() / 1_000));
    if (unit === "HYPERLIQUID_UNIX_MILLISECONDS") return BigInt(clockMs());
    return undefined;
  };

  const pushOrders = (client: StreamClient) => {
    if (client.orders === undefined || options.evidence === undefined) return;
    const page = options.evidence.openOrders(client.orders.cursor, 100, nowIn);
    if (page.nextCursor === client.orders.cursor) return;
    client.orders.cursor = page.nextCursor;
    if (page.orders.length === 0) return;
    send(client, {
      type: "orders",
      orders: page.orders.map((entry) => ({ cursor: entry.cursor, orderHash: entry.orderHashHex, order: entry.order, receivedAtMs: entry.receivedAtMs })),
      nextCursor: page.nextCursor,
    });
  };

  const pushPrivateRfqs = (client: StreamClient) => {
    if (client.privateRfqs === undefined || client.solverId === undefined || options.delivery === undefined) return;
    const fresh = options.delivery.pendingFor(client.solverId, clockMs()).filter((entry) => !client.privateRfqs?.has(entry.envelopeHashHex));
    if (fresh.length === 0) return;
    for (const entry of fresh) client.privateRfqs.add(entry.envelopeHashHex);
    send(client, {
      type: "private-rfqs",
      envelopes: fresh.map((entry) => ({ envelopeHash: entry.envelopeHashHex, envelope: entry.envelope, ciphertext: entry.ciphertext, senderSignature: entry.senderSignature })),
    });
  };

  const pushAuctions = (client: StreamClient) => {
    if (client.auctions === undefined || client.solverId === undefined || options.delivery === undefined) return;
    const page = options.delivery.eligibleAuctions(client.solverId, client.auctions.cursor, 100);
    if (page.nextCursor === client.auctions.cursor) return;
    client.auctions.cursor = page.nextCursor;
    if (page.auctions.length === 0) return;
    send(client, {
      type: "auctions",
      auctions: page.auctions.map((entry) => ({
        cursor: entry.cursor,
        auctionHash: entry.auctionHashHex,
        definition: entry.definition,
        createdAtMs: entry.createdAtMs,
      })),
      nextCursor: page.nextCursor,
    });
  };

  const timer = setInterval(() => {
    for (const client of clients) {
      try {
        pushOrders(client);
        pushPrivateRfqs(client);
        pushAuctions(client);
      } catch {
        send(client, { type: "error", code: "STREAM_READ_FAILED", message: "A subscribed feed could not be read." });
      }
    }
  }, options.pollIntervalMs ?? 1_000);

  const onText = (client: StreamClient, text: string) => {
    let message: Record<string, unknown>;
    try {
      message = fromProtocolJson(JSON.parse(text)) as Record<string, unknown>;
      if (typeof message !== "object" || message === null) throw new Error("not an object");
    } catch {
      send(client, { type: "error", code: "INVALID_MESSAGE", message: "Messages are protocol JSON objects." });
      return;
    }
    if (client.solverId === undefined) {
      if (message.op !== "auth") {
        client.connection.close(4401);
        return;
      }
      try {
        const { solverId } = verifySolverRequest(
          options,
          {
            method: "GET",
            pathAndQuery: SOLVER_STREAM_PATH,
            body: Buffer.alloc(0),
            solverId: String(message.solverId),
            keyId: String(message.keyId),
            timestamp: String(message.timestampMs),
            nonce: String(message.nonce),
            signature: String(message.signature),
          },
          clockMs(),
          maxSkew,
        );
        if ([...clients].filter((other) => other.solverId === solverId).length >= perSolver) {
          send(client, { type: "error", code: "TOO_MANY_CONNECTIONS", message: `A solver holds at most ${perSolver} streams.` });
          client.connection.close(4429);
          return;
        }
        client.solverId = solverId;
        clearTimeout(client.authTimer);
        send(client, { type: "authenticated", solverId });
      } catch (error) {
        send(client, { type: "error", code: error instanceof SolverRequestError ? error.code : "UNAUTHENTICATED", message: "Authentication failed." });
        client.connection.close(4401);
      }
      return;
    }
    if (message.op !== "subscribe" || (message.channel !== "orders" && message.channel !== "private-rfqs" && message.channel !== "auctions")) {
      send(client, { type: "error", code: "INVALID_SUBSCRIPTION", message: "Subscribe to orders, private-rfqs, or auctions." });
      return;
    }
    if (message.channel === "orders") {
      if (options.evidence === undefined) {
        send(client, { type: "error", code: "EVIDENCE_UNAVAILABLE", message: "No evidence store is configured on this server." });
        return;
      }
      const after = message.after ?? 0;
      if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
        send(client, { type: "error", code: "INVALID_SUBSCRIPTION", message: "after must be a nonnegative order cursor." });
        return;
      }
      client.orders = { cursor: after };
      send(client, { type: "subscribed", channel: "orders", after });
      pushOrders(client);
      return;
    }
    if (options.delivery === undefined) {
      send(client, { type: "error", code: "PRIVATE_DELIVERY_UNAVAILABLE", message: "No private delivery relay is configured on this server." });
      return;
    }
    if (message.channel === "private-rfqs") {
      client.privateRfqs = new Set();
      send(client, { type: "subscribed", channel: "private-rfqs" });
      pushPrivateRfqs(client);
      return;
    }
    const after = message.after ?? 0;
    if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
      send(client, { type: "error", code: "INVALID_SUBSCRIPTION", message: "after must be a nonnegative auction cursor." });
      return;
    }
    client.auctions = { cursor: after };
    send(client, { type: "subscribed", channel: "auctions", after });
    pushAuctions(client);
  };

  return {
    upgrade(request, socket) {
      const url = new URL(request.url ?? "/", "http://solver-api.local");
      if (url.pathname !== SOLVER_STREAM_PATH) return false;
      // Unauthenticated sockets are capped like the market stream, before any solver has signed in.
      const key = requestClientKey(request);
      const fromClient = [...clients].filter((client) => client.key === key).length;
      if (clients.size >= 512 || fromClient >= 8) {
        socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return true;
      }
      acceptWebSocket(
        request,
        socket,
        (connection) => {
          const client: StreamClient = { connection, key, authTimer: setTimeout(() => connection.close(4408), 10_000) };
          clients.add(client);
          return {
            onText: (text) => onText(client, text),
            onClose: () => {
              clearTimeout(client.authTimer);
              clients.delete(client);
            },
          };
        },
        { maximumMessageBytes: 2_048, pingIntervalMs: 30_000 },
      );
      return true;
    },
    close() {
      clearInterval(timer);
      for (const client of clients) {
        clearTimeout(client.authTimer);
        client.connection.close(1001);
      }
      clients.clear();
    },
  };
}
