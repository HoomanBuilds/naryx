import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import bs58 from "bs58";
import {
  admitPrivateRfqEnvelope,
  aggregateCandles,
  CANDLE_INTERVAL_MS,
  decideRfq,
  executablePackageIndex,
  fromProtocolJson,
  MARKET_DATA_METHODOLOGY_VERSION,
  QUALIFICATION_OBJECT_TYPE,
  matchPackageOrder,
  packageBookLevels,
  packageOrderHash,
  planCoordinatedDeRisk,
  compilePackageGraph,
  packageGraph,
  packageGraphHash,
  simulatePackageGraphFailures,
  privateRfqEnvelopeHash,
  ProtocolError,
  replayRouteDecision,
  toHex,
  builderManifestHash,
  toProtocolJson,
  validatePackageOrderProfile,
} from "@naryx/protocol-types";
import type {
  QualificationObjectType,
  CandleInterval,
  DeRiskPolicy,
  NormalizedPositionInput,
  PositionSnapshotRecordInput,
  DomainRegistryRecordInput,
  DomainResourceLimit,
  PackageGraphInput,
  PackageTemplateManifestInput,
  PackageOrderInput,
  StrategyCommandInput,
  StrategyHealthSnapshotInput,
  BuilderManifestInput,
  BuilderAttributionInput,
  PackageTakerOrderInput,
  PrivateRfqEnvelopeInput,
  SealedAuctionDefinitionInput,
  RfqRequest,
  RfqResponse,
  RfqSolverCapacity,
  RouteDecisionInput,
  SolverCapabilityManifestInput,
} from "@naryx/protocol-types";
import { MAX_TAPE_PAGE, PackageExchangeStoreError, type SqlitePackageExchangeStore } from "./package-exchange-store.js";
import { RegistryStoreError, type SqliteRegistryStore } from "./registry-store.js";
import type { SqliteSolverApiStore } from "./solver-api-store.js";
import { PrivateDeliveryStoreError, type SqlitePrivateDeliveryStore } from "./private-delivery-store.js";
import { clientKey, createRateLimiter } from "./rate-limit.js";
import { EvidenceStoreError, type SqliteEvidenceStore } from "./evidence-store.js";
import type { SqliteQualificationStore } from "./qualification-store.js";
import { PositionSnapshotStoreError, type SqlitePositionSnapshotStore } from "./position-snapshot-store.js";
import { StrategyBookError, type SqliteStrategyBookStore } from "./strategy-book-store.js";
import { BuilderStoreError, type SqliteBuilderStore } from "./builder-store.js";
import { KeeperExecutorError, type SqliteKeeperExecutor } from "./keeper-executor.js";
import { positionsView, RISK_METHODOLOGY, riskView } from "./position-risk-view.js";
import { verifyEd25519 } from "./ed25519.js";

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The raw key of a sender key id that is a canonical base58 Ed25519 public key, else undefined. */
function senderPublicKey(senderKeyId: unknown): Uint8Array | undefined {
  if (typeof senderKeyId !== "string") return undefined;
  try {
    const bytes = bs58.decode(senderKeyId);
    return bytes.length === 32 && bs58.encode(bytes) === senderKeyId ? bytes : undefined;
  } catch {
    return undefined;
  }
}
const HASH_HEX = /^[0-9a-f]{64}$/;
/** Executable package depth of one book, as the HTTP route and the stream both serve it. */
export function packageDepthView(state: NonNullable<ReturnType<SqlitePackageExchangeStore["getBook"]>>, now: bigint) {
  return {
    packageMarketId: state.executionClassId,
    matchingPolicyHash: toHex(state.matchingPolicyHash),
    halted: state.halted,
    asOfValue: now,
    bids: packageBookLevels(state, "BID", now),
    asks: packageBookLevels(state, "ASK", now),
  };
}

/** One page of the observed package tape, as the HTTP route and the stream both serve it. */
export function packageTapeView(classId: string, records: ReturnType<SqlitePackageExchangeStore["allocationTape"]>, after: number) {
  return {
    packageMarketId: classId,
    trades: records.map((record) => ({
      cursor: record.cursor,
      allocationHash: record.allocationHashHex,
      takerSide: record.allocation.takerSide,
      recordedAtMs: record.recordedAtMs,
      fills: record.allocation.fills.map((fill) => ({ fillSequence: fill.fillSequence, priceTicks: fill.priceTicks, quantity: fill.quantity, makerSource: fill.makerSource })),
    })),
    nextCursor: records.length === 0 ? after : (records[records.length - 1] as { cursor: number }).cursor,
  };
}

const CURSOR = /^(0|[1-9]\d{0,15})$/;
const LIMIT = /^[1-9]\d{0,2}$/;
const MILLIS = /^(0|[1-9]\d{0,15})$/;
const VERSION = /^[1-9]\d{0,9}$/;
const MAX_BODY_BYTES = 65_536;
const MAX_CANDLE_TRADES = 50_000;
const MAX_CANDLES_PER_REQUEST = 1_000;

export type PublicExchangeStore = Pick<
  SqlitePackageExchangeStore,
  | "getBook"
  | "getMatchingPolicy"
  | "getAllocation"
  | "allocationTape"
  | "allocationsBetween"
  | "listBooks"
  | "listSeries"
  | "listExecutionClasses"
  | "latestTrade"
>;

export type PublicRegistryStore = Pick<SqliteRegistryStore, "list" | "latest" | "byHash">;

export type PublicSolverState = Pick<SqliteSolverApiStore, "shardsForMarket" | "capacityStatus">;

export interface PublicApiOptions {
  readonly exchange: PublicExchangeStore;
  /** Optional: registry routes answer 503 when no registry is configured. */
  readonly registry?: PublicRegistryStore;
  /** Optional: solver quote and capacity routes answer 503 without it. */
  readonly solverState?: PublicSolverState;
  /** Optional: private RFQ relay and sealed auction routes answer 503 without it. */
  readonly delivery?: Pick<SqlitePrivateDeliveryStore, "nonceSeen" | "storeEnvelopes" | "getEnvelope" | "createAuction" | "auctionView" | "auctionDefinition">;
  /** Encryption suites a reviewed release has pinned; with none, private RFQ fails closed. */
  readonly pinnedSuiteIds?: readonly string[];
  /** Optional: order intake, order and receipt reads, and execution analytics answer 503 without it. */
  readonly evidence?: Pick<SqliteEvidenceStore, "submitOrder" | "getOrder" | "getOutcome" | "executionQuality" | "quotesFor" | "routeDecisionsFor" | "solverPerformance">;
  /** Optional: qualification reads answer 503 without it. Records are appended by operators, never here. */
  readonly qualification?: Pick<SqliteQualificationStore, "history" | "current">;
  /** Optional: graph compilation answers 503 without the active registry records and resource limits it runs against. */
  readonly graphContext?: { readonly activeRegistryRecords: readonly DomainRegistryRecordInput[]; readonly resourceLimits: readonly DomainResourceLimit[] };
  /** Optional: the signed market catalogue answers 503 without an issuer. */
  readonly catalogue?: { current(): { readonly catalogue: unknown; readonly catalogueHash: string } };
  /** Optional: position and risk reads answer 503 without it. Snapshots are accepted only when signed by a configured authority. */
  readonly positions?: Pick<SqlitePositionSnapshotStore, "append" | "latest" | "riskDomain" | "now">;
  /** The signed strategy book; without it the strategy routes answer 503. */
  readonly strategies?: Pick<SqliteStrategyBookStore, "submit" | "strategy" | "history" | "ownerStrategies">;
  /** Builder manifests and attributions; without it the builder routes answer 503. */
  readonly builders?: Pick<SqliteBuilderStore, "registerManifest" | "latest" | "attribute" | "attributions" | "revenue">;
  /** Authority-signed strategy health; without it the health routes answer 503. */
  readonly health?: Pick<SqliteKeeperExecutor, "publishHealth" | "health">;
  /** Current time in the books' expiry unit, so expired entries never appear as depth. */
  readonly nowValue: () => bigint;
  readonly rateLimit: { readonly windowMs: number; readonly maxRequests: number };
  readonly clockMs?: () => number;
}

class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  // A response that cannot be encoded is a server fault, never the caller's bad request.
  let text: string;
  try {
    text = JSON.stringify(toProtocolJson(body));
  } catch {
    status = 500;
    text = JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "The response could not be encoded." } });
  }
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.end(text);
}

function fail(response: ServerResponse, status: number, code: string, message: string): void {
  send(response, status, { error: { code, message } });
}

function onlyParams(url: URL, allowed: readonly string[]): void {
  const keys = [...url.searchParams.keys()];
  if (!keys.every((key) => allowed.includes(key)) || new Set(keys).size !== keys.length) {
    throw new RequestError(400, "INVALID_REQUEST", `Only these query parameters are accepted: ${allowed.join(", ") || "none"}.`);
  }
}

function id(value: string | undefined, name: string): string {
  if (value === undefined || !ID.test(value)) throw new RequestError(400, "INVALID_REQUEST", `${name} is malformed.`);
  return value;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RequestError(400, "INVALID_REQUEST", `${name} must be an object.`);
  return value as Record<string, unknown>;
}

async function readProtocolBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new RequestError(415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new RequestError(413, "BODY_TOO_LARGE", "Request body is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, "BODY_TOO_LARGE", "Request body is too large.");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  try {
    return fromProtocolJson(parsed);
  } catch (error) {
    throw new RequestError(400, "INVALID_PROTOCOL_JSON", error instanceof Error ? error.message : "Request body is not protocol JSON.");
  }
}

/** Public solver fields only; the manifest signature and operator key stay verifiable but are not reshaped. */
function solverSummary(entry: { documentHashHex: string; subjectVersion: number; document: unknown }) {
  const manifest = entry.document as SolverCapabilityManifestInput;
  return {
    solverId: manifest.solverId,
    commonControlGroupId: manifest.commonControlGroupId,
    environment: manifest.environment,
    manifestHash: entry.documentHashHex,
    manifestNonce: entry.subjectVersion,
    supportedDomains: manifest.supportedDomains,
    supportedTemplateIds: manifest.supportedTemplateIds,
    supportedQuoteModes: manifest.supportedQuoteModes,
    maximumNotionalByMarket: manifest.maximumNotionalByMarket,
    quoteVerificationKeys: manifest.quoteVerificationKeys,
    rfqEncryptionKeys: manifest.rfqEncryptionKeys,
    rfqEndpoints: manifest.rfqEndpoints,
    validityUnit: manifest.validityUnit,
    validUntilValue: manifest.validUntilValue,
  };
}

/**
 * The public, read-only v1 API: registries, strategy series, package markets with depth, tape,
 * candles, and an executable index, allocation evidence by capability, and side-effect-free
 * compute routes. It holds no signer, persists nothing on POST, keeps direct and implied
 * liquidity apart, omits taker and participant identities from the tape, and labels every
 * derived market number. It returns false for paths it does not own, including /v1/solver/.
 */
export function createPublicApiHandler(options: PublicApiOptions) {
  const { exchange, registry, solverState, delivery, nowValue } = options;
  const pinnedSuiteIds = options.pinnedSuiteIds ?? [];
  const { windowMs, maxRequests } = options.rateLimit;
  const clockMs = options.clockMs ?? Date.now;
  const limiter = createRateLimiter({ windowMs, maxRequests, clockMs });

  function limited(request: IncomingMessage): boolean {
    return limiter(clientKey(request.socket.remoteAddress));
  }

  function requireEvidence(): NonNullable<PublicApiOptions["evidence"]> {
    if (options.evidence === undefined) throw new RequestError(503, "EVIDENCE_UNAVAILABLE", "No evidence store is configured on this server.");
    return options.evidence;
  }

  function requireRegistry(): PublicRegistryStore {
    if (registry === undefined) throw new RequestError(503, "REGISTRY_UNAVAILABLE", "No registry is configured on this server.");
    return registry;
  }

  function requireSolverState(): PublicSolverState {
    if (solverState === undefined) throw new RequestError(503, "SOLVER_STATE_UNAVAILABLE", "No solver state is configured on this server.");
    return solverState;
  }

  /** Server time in a quote's own unit; slot-timed quotes cannot be judged against wall-clock time. */
  function nowIn(unit: string): bigint | undefined {
    if (unit === "EVM_UNIX_SECONDS") return BigInt(Math.floor(clockMs() / 1_000));
    if (unit === "HYPERLIQUID_UNIX_MILLISECONDS") return BigInt(clockMs());
    return undefined;
  }

  function requirePositions() {
    if (options.positions === undefined) throw new RequestError(503, "POSITIONS_UNAVAILABLE", "No position snapshot store is configured on this server.");
    return options.positions;
  }

  function requireDelivery() {
    if (delivery === undefined) throw new RequestError(503, "PRIVATE_DELIVERY_UNAVAILABLE", "No private delivery relay is configured on this server.");
    return delivery;
  }

  function wallClockIn(unit: string): bigint {
    const now = nowIn(unit);
    if (now === undefined) throw new RequestError(400, "TIME_UNIT_UNSUPPORTED", "Slot-timed objects cannot be judged against wall-clock time here.");
    return now;
  }

  function book(classId: string) {
    const state = exchange.getBook(classId);
    if (state === undefined) throw new RequestError(404, "BOOK_NOT_FOUND", "Package market is not open.");
    return state;
  }

  function sizesParam(url: URL, name = "sizes"): bigint[] {
    const parts = (url.searchParams.get(name) ?? "1").split(",");
    if (parts.length > 16 || parts.some((part) => !/^[1-9]\d{0,30}$/.test(part))) throw new RequestError(400, "INVALID_REQUEST", `${name} must be up to 16 positive integers.`);
    return parts.map((part) => BigInt(part));
  }

  function seriesOf(seriesId: string) {
    const series = exchange.listSeries().find((entry) => entry.seriesId === seriesId);
    if (series === undefined) throw new RequestError(404, "SERIES_NOT_FOUND", "No such strategy series.");
    return series;
  }

  /** The last recorded trade of a book, labeled OBSERVED: the final fill price and the traded quantity. */
  function lastTrade(classId: string) {
    const record = exchange.latestTrade(classId);
    const fills = record?.allocation.fills ?? [];
    const last = fills[fills.length - 1];
    if (record === undefined || last === undefined) return undefined;
    return {
      priceTicks: last.priceTicks,
      quantity: fills.reduce((total, fill) => total + fill.quantity, 0n),
      recordedAtMs: record.recordedAtMs,
      allocationHash: record.allocationHashHex,
      label: "OBSERVED" as const,
    };
  }

  /** The executable index of every open book of a series, with each class's settlement terms. */
  function seriesBooks(seriesId: string, sizes: readonly bigint[]) {
    const now = nowValue();
    return {
      now,
      classes: exchange.listExecutionClasses(seriesId).map((executionClass) => {
        const state = exchange.getBook(executionClass.executionClassId);
        const terms = {
          executionClassId: executionClass.executionClassId,
          settlementClass: executionClass.settlementClass,
          firmnessClass: executionClass.firmnessClass,
          domains: executionClass.domains.map((domain) => domain.domainId),
        };
        if (state === undefined) return { ...terms, open: false as const };
        return {
          ...terms,
          open: true as const,
          halted: state.halted,
          index: executablePackageIndex(packageBookLevels(state, "BID", now), packageBookLevels(state, "ASK", now), sizes),
        };
      }),
    };
  }

  function readRoutes(url: URL): unknown {
    const path = url.pathname;
    let match: RegExpExecArray | null;
    if (path === "/v1/domains") {
      onlyParams(url, []);
      return { domains: requireRegistry().list("DOMAIN") };
    }
    if (path === "/v1/catalogue") {
      // The whole signed catalogue of markets and solvers, the same for every reader, so a client
      // can search locally without revealing what it looks for.
      onlyParams(url, []);
      if (options.catalogue === undefined) throw new RequestError(503, "CATALOGUE_UNAVAILABLE", "No catalogue authority is configured on this server.");
      return options.catalogue.current();
    }
    if ((match = /^\/v1\/builders\/([^/]+)(\/attribution|\/revenue)?$/.exec(path)) !== null) {
      onlyParams(url, []);
      if (options.builders === undefined) throw new RequestError(503, "BUILDERS_UNAVAILABLE", "No builder registry is configured on this server.");
      const builderId = id(match[1], "Builder id");
      if (match[2] === "/attribution") {
        return {
          builderId,
          attributions: options.builders.attributions(builderId).map((view) => ({ ...view, label: "OBSERVED" })),
        };
      }
      if (match[2] === "/revenue") return { builderId, label: "OBSERVED", payableByAsset: options.builders.revenue(builderId) };
      const manifest = options.builders.latest(builderId);
      if (manifest === undefined) throw new RequestError(404, "NOT_FOUND", "No such builder.");
      return { builderId, manifest, manifestHash: toHex(builderManifestHash(manifest)) };
    }
    if ((match = /^\/v1\/strategies\/([^/]+)\/health$/.exec(path)) !== null) {
      onlyParams(url, []);
      if (options.health === undefined) throw new RequestError(503, "HEALTH_UNAVAILABLE", "No strategy health store is configured on this server.");
      // Only a snapshot that describes the strategy's current state hash is ever served as health.
      const health = options.health.health(id(match[1], "Strategy id"));
      if (health === undefined) throw new RequestError(404, "HEALTH_NOT_FOUND", "No signed health snapshot describes this strategy's current state.");
      return { snapshot: health.before, stateHash: health.stateHash, manualTakeover: health.manualTakeover };
    }
    if ((match = /^\/v1\/strategies\/([^/]+)(\/history)?$/.exec(path)) !== null) {
      onlyParams(url, []);
      if (options.strategies === undefined) throw new RequestError(503, "STRATEGIES_UNAVAILABLE", "No strategy book is configured on this server.");
      const strategyId = id(match[1], "Strategy id");
      if (match[2] !== undefined) {
        // Every signed command that touched the strategy, with its signature and transition receipt,
        // so a client can re-hash, re-verify, and chain them itself.
        return {
          strategyId,
          commands: options.strategies.history(strategyId).map((entry) => ({
            command: entry.command,
            commandHash: entry.commandHashHex,
            authorization: { scheme: "ED25519", signature: entry.signatureBase58 },
            consents: entry.consents.map((consent) => ({ scheme: "ED25519", signerId: consent.signerId, signature: consent.signatureBase58 })),
            ...(entry.receipt === undefined ? {} : { receipt: entry.receipt }),
            recordedAtMs: entry.recordedAtMs,
          })),
        };
      }
      const stored = options.strategies.strategy(strategyId);
      if (stored === undefined) throw new RequestError(404, "STRATEGY_NOT_FOUND", "No such strategy.");
      return {
        state: stored.state,
        stateHash: stored.stateHashHex,
        ...(stored.originReceiptHashHex === undefined ? {} : { originReceiptHash: stored.originReceiptHashHex }),
        ...(stored.retiredByCommandHashHex === undefined ? {} : { retiredByCommandHash: stored.retiredByCommandHashHex }),
      };
    }
    if ((match = /^\/v1\/owners\/([^/]+)\/strategies$/.exec(path)) !== null) {
      onlyParams(url, []);
      if (options.strategies === undefined) throw new RequestError(503, "STRATEGIES_UNAVAILABLE", "No strategy book is configured on this server.");
      const ownerId = id(match[1], "Owner id");
      return {
        ownerId,
        strategies: options.strategies.ownerStrategies(ownerId).map((stored) => ({
          strategyId: stored.state.strategyId,
          stateVersion: stored.state.stateVersion,
          stateHash: stored.stateHashHex,
          open: stored.state.open,
          retired: stored.retiredByCommandHashHex !== undefined,
        })),
      };
    }
    if ((match = /^\/v1\/(positions|risk)\/([^/]+)$/.exec(path)) !== null) {
      // The latest signed read-only snapshot of each source for one strategy account, and the
      // exact exposure, close cost, and modeled stress over those positions.
      onlyParams(url, []);
      const store = requirePositions();
      const strategyAccount = id(match[2], "Strategy account");
      const snapshots = store.latest(strategyAccount);
      if (snapshots.length === 0) throw new RequestError(404, "POSITIONS_NOT_FOUND", "No position snapshot exists for this account.");
      const view = positionsView(strategyAccount, snapshots, store.now());
      if (match[1] === "positions") return view;
      return { strategyAccount, sources: view.sources, methodology: RISK_METHODOLOGY, byAccountingAsset: riskView(view.positions.map((entry) => entry.position)) };
    }
    if ((match = /^\/v1\/risk-domains\/([^/]+)$/.exec(path)) !== null) {
      // Every account's latest positions in one risk domain; positions in other domains are left out.
      onlyParams(url, []);
      const store = requirePositions();
      const riskDomainId = id(match[1], "Risk domain");
      const snapshots = store.riskDomain(riskDomainId);
      if (snapshots.length === 0) throw new RequestError(404, "RISK_DOMAIN_NOT_FOUND", "No position snapshot has held this risk domain.");
      const now = store.now();
      const inDomain = snapshots.flatMap((entry) => entry.record.positions.filter((position) => position.riskDomainId === riskDomainId));
      return {
        riskDomainId,
        label: "OBSERVED" as const,
        accounts: snapshots.map((entry) => ({
          strategyAccount: entry.record.strategyAccount,
          ...positionsView(entry.record.strategyAccount, [entry], now).sources[0],
          positionsInDomain: entry.record.positions.filter((position) => position.riskDomainId === riskDomainId).length,
        })),
        methodology: RISK_METHODOLOGY,
        byAccountingAsset: riskView(inDomain),
      };
    }
    if ((match = /^\/v1\/orders\/([0-9a-f]{64})\/route-decisions$/.exec(path)) !== null) {
      // Every solver route decision recorded for a public order, each replayed from its bounded
      // evidence on read. A replay proves the declared selection, never global optimality.
      onlyParams(url, []);
      const hash = match[1] as string;
      const store = requireEvidence();
      if (store.getOrder(hash) === undefined) throw new RequestError(404, "ORDER_NOT_FOUND", "No such order.");
      return {
        orderHash: hash,
        decisions: store.routeDecisionsFor(hash).map((entry) => ({
          decisionHash: entry.decisionHashHex,
          solverId: entry.solverId,
          decision: entry.decision,
          replay: entry.replay,
          receivedAtMs: entry.receivedAtMs,
        })),
      };
    }
    if ((match = /^\/v1\/orders\/([0-9a-f]{64})\/quotes$/.exec(path)) !== null) {
      // Signed solver quotes for a public order that are still valid, each with the route it binds
      // and its quote mode, so a taker can verify and compare them before authorizing one.
      onlyParams(url, []);
      const hash = match[1] as string;
      const store = requireEvidence();
      if (store.getOrder(hash) === undefined) throw new RequestError(404, "ORDER_NOT_FOUND", "No such order.");
      const quotes = store.quotesFor(hash, nowIn);
      return {
        orderHash: hash,
        quotes: quotes.map((entry) => ({
          quoteHash: entry.quoteHashHex,
          routeHash: entry.routeHashHex,
          quoteMode: entry.quote.quoteMode,
          solverId: entry.quote.solverId,
          quote: entry.quote,
          route: entry.route,
          receivedAtMs: entry.receivedAtMs,
        })),
      };
    }
    if ((match = /^\/v1\/orders\/([^/]+)$/.exec(path)) !== null && match[1] !== "validate") {
      onlyParams(url, []);
      const hash = match[1] as string;
      if (!HASH_HEX.test(hash)) throw new RequestError(400, "INVALID_REQUEST", "Order hash must be 64 lowercase hex characters.");
      const store = requireEvidence();
      const stored = store.getOrder(hash);
      const outcome = store.getOutcome(hash);
      if (stored === undefined && outcome === undefined) throw new RequestError(404, "ORDER_NOT_FOUND", "No such order.");
      return {
        orderHash: hash,
        ...(stored === undefined ? {} : { order: stored.order, owner: stored.owner, authorizationSignature: stored.signature, receivedAtMs: stored.receivedAtMs }),
        // Open means no terminal outcome is recorded yet; it is not a claim about execution.
        status: outcome?.terminalState ?? "OPEN",
        ...(outcome === undefined ? {} : { outcomeHash: outcome.outcomeHashHex, ...(outcome.receiptHashHex === undefined ? {} : { receiptHash: outcome.receiptHashHex }) }),
      };
    }
    if ((match = /^\/v1\/outcomes\/([^/]+)$/.exec(path)) !== null) {
      onlyParams(url, []);
      const hash = match[1] as string;
      if (!HASH_HEX.test(hash)) throw new RequestError(400, "INVALID_REQUEST", "Order hash must be 64 lowercase hex characters.");
      const outcome = requireEvidence().getOutcome(hash);
      if (outcome === undefined) throw new RequestError(404, "OUTCOME_NOT_FOUND", "No terminal outcome is recorded for this order.");
      return {
        orderHash: hash,
        terminalState: outcome.terminalState,
        evidenceManifest: outcome.evidenceManifest,
        evidenceManifestHash: outcome.evidenceManifestHashHex,
        outcome: outcome.outcome,
        outcomeHash: outcome.outcomeHashHex,
        ...(outcome.receiptHashHex === undefined ? {} : { receiptHash: outcome.receiptHashHex }),
        recordedAtMs: outcome.recordedAtMs,
      };
    }
    if ((match = /^\/v1\/receipts\/([^/]+)$/.exec(path)) !== null) {
      onlyParams(url, []);
      const hash = match[1] as string;
      if (!HASH_HEX.test(hash)) throw new RequestError(400, "INVALID_REQUEST", "Order hash must be 64 lowercase hex characters.");
      const outcome = requireEvidence().getOutcome(hash);
      if (outcome === undefined) throw new RequestError(404, "OUTCOME_NOT_FOUND", "No terminal outcome is recorded for this order.");
      // Every record is served with its hash so a client can recompute and link them itself.
      return {
        orderHash: hash,
        terminalState: outcome.terminalState,
        evidenceManifest: outcome.evidenceManifest,
        evidenceManifestHash: outcome.evidenceManifestHashHex,
        outcome: outcome.outcome,
        outcomeHash: outcome.outcomeHashHex,
        ...(outcome.receipt === undefined ? {} : { receipt: outcome.receipt, receiptHash: outcome.receiptHashHex }),
        recordedAtMs: outcome.recordedAtMs,
      };
    }
    if (path === "/v1/analytics/execution-quality") {
      onlyParams(url, ["solverId"]);
      const solverId = url.searchParams.get("solverId");
      return requireEvidence().executionQuality(solverId === null ? {} : { solverId: id(solverId, "Solver id") });
    }
    if ((match = /^\/v1\/qualification\/([A-Z_]{1,32})\/([^/]+)(\/history)?$/.exec(path)) !== null) {
      onlyParams(url, []);
      const objectType = match[1] as QualificationObjectType;
      if (!Object.hasOwn(QUALIFICATION_OBJECT_TYPE, objectType)) throw new RequestError(400, "INVALID_REQUEST", "Unknown qualification object type.");
      const objectId = id(match[2], "Object id");
      if (options.qualification === undefined) throw new RequestError(503, "QUALIFICATION_UNAVAILABLE", "No qualification store is configured on this server.");
      if (match[3] !== undefined) {
        return {
          objectType,
          objectId,
          records: options.qualification.history(objectType, objectId).map((entry) => ({ record: entry.record, recordHash: entry.recordHashHex, recordedAtMs: entry.recordedAtMs })),
        };
      }
      const verdict = options.qualification.current(objectType, objectId, nowIn);
      if ("unavailable" in verdict) {
        if (verdict.unavailable === "NO_RECORD") throw new RequestError(404, "QUALIFICATION_NOT_FOUND", "No qualification record exists for this object.");
        // An expired or not yet effective record governs nothing; execution treats the object as unqualified.
        return { objectType, objectId, unavailable: verdict.unavailable };
      }
      return { objectType, objectId, asOfValue: verdict.asOfValue, record: verdict.current.record, recordHash: verdict.current.recordHashHex };
    }
    if (path === "/v1/instruments") {
      onlyParams(url, []);
      return { instruments: requireRegistry().list("MARKET") };
    }
    if ((match = /^\/v1\/instruments\/([^/]+)$/.exec(path)) !== null) {
      onlyParams(url, []);
      const instrument = requireRegistry().latest("MARKET", id(match[1], "Instrument id"));
      if (instrument === undefined) throw new RequestError(404, "NOT_FOUND", "No such instrument.");
      return instrument;
    }
    if (path === "/v1/package-templates") {
      onlyParams(url, []);
      return { templates: requireRegistry().list("PACKAGE_TEMPLATE") };
    }
    if ((match = /^\/v1\/package-templates\/([^/]+)\/([^/]+)$/.exec(path)) !== null) {
      onlyParams(url, []);
      if (match[2] === undefined || !VERSION.test(match[2])) throw new RequestError(400, "INVALID_REQUEST", "Template version is malformed.");
      const template = requireRegistry().latest("PACKAGE_TEMPLATE", id(match[1], "Template id"), Number(match[2]));
      if (template === undefined) throw new RequestError(404, "NOT_FOUND", "No such template version.");
      return template;
    }
    if (path === "/v1/solvers") {
      onlyParams(url, []);
      return { solvers: requireRegistry().list("SOLVER_CAPABILITY").map(solverSummary) };
    }
    if ((match = /^\/v1\/solvers\/([^/]+)\/manifests\/([0-9a-f]{64})$/.exec(path)) !== null) {
      // The exact operator-signed manifest a quote binds, so a taker can check that the quote key
      // belongs to the named solver without trusting this server.
      onlyParams(url, []);
      const solverId = id(match[1], "Solver id");
      const entry = requireRegistry().byHash<SolverCapabilityManifestInput>("SOLVER_CAPABILITY", solverId, match[2] as string);
      if (entry === undefined) throw new RequestError(404, "NOT_FOUND", "No such solver manifest.");
      return { solverId, manifestHash: entry.documentHashHex, manifestNonce: entry.subjectVersion, manifest: entry.document };
    }
    if ((match = /^\/v1\/solvers\/([^/]+)\/performance$/.exec(path)) !== null) {
      // Raw, record-derived performance dimensions for one solver; eligibility follows the domains
      // its latest signed manifest supports. There is no composite score.
      onlyParams(url, []);
      const solverId = id(match[1], "Solver id");
      const manifest = requireRegistry().latest<SolverCapabilityManifestInput>("SOLVER_CAPABILITY", solverId);
      if (manifest === undefined) throw new RequestError(404, "NOT_FOUND", "No such solver.");
      return requireEvidence().solverPerformance(solverId, manifest.document.supportedDomains.map((domain) => domain.domainId));
    }
    if ((match = /^\/v1\/solvers\/([^/]+)$/.exec(path)) !== null) {
      onlyParams(url, []);
      const solver = requireRegistry().latest("SOLVER_CAPABILITY", id(match[1], "Solver id"));
      if (solver === undefined) throw new RequestError(404, "NOT_FOUND", "No such solver.");
      return solverSummary(solver);
    }
    if (path === "/v1/strategy-series") {
      onlyParams(url, []);
      return { series: exchange.listSeries() };
    }
    if ((match = /^\/v1\/strategy-series\/([^/]+)\/execution-classes$/.exec(path)) !== null) {
      onlyParams(url, []);
      return { executionClasses: exchange.listExecutionClasses(id(match[1], "Series id")) };
    }
    if (path === "/v1/markets" || path === "/v1/package-book") {
      onlyParams(url, []);
      const now = nowValue();
      const markets = exchange.listBooks().map((entry) => {
        const state = book(entry.executionClassId);
        const index = executablePackageIndex(packageBookLevels(state, "BID", now), packageBookLevels(state, "ASK", now), [1n]);
        return {
          packageMarketId: entry.executionClassId,
          halted: entry.halted,
          matchingPolicyHash: toHex(state.matchingPolicyHash),
          bestBidTicks: index.bestBidTicks,
          bestAskTicks: index.bestAskTicks,
          spreadTicks: index.spreadTicks,
          label: "EXECUTABLE",
        };
      });
      return { asOfValue: now, markets };
    }
    if ((match = /^\/v1\/package-book\/([^/]+)\/implied-provenance$/.exec(path)) !== null) {
      onlyParams(url, []);
      const state = book(id(match[1], "Package market id"));
      const now = nowValue();
      return {
        packageMarketId: state.executionClassId,
        asOfValue: now,
        implied: state.entries
          .filter((entry) => entry.source === "IMPLIED" && (entry.expiresAtValue === undefined || entry.expiresAtValue > now))
          .map((entry) => ({
            entryId: toHex(entry.entryId),
            side: entry.side,
            priceTicks: entry.priceTicks,
            quantity: entry.quantity,
            solverId: entry.participantId,
            evidence: entry.implied?.evidence,
            derivationDepth: entry.implied?.derivationDepth,
            sources: entry.implied?.sources,
            label: entry.implied?.evidence === "SOLVER_BACKED_IMPLIED" || entry.implied?.evidence === "RESERVATION_BACKED_IMPLIED" ? "EXECUTABLE" : "INDICATIVE",
          })),
      };
    }
    if ((match = /^\/v1\/markets\/([^/]+)\/quotes$/.exec(path)) !== null) {
      onlyParams(url, []);
      const classId = id(match[1], "Package market id");
      // Offsets are relative to each shard's signed reference state; only live levels are listed.
      // A shard is listed only while its solver's manifest is live and still holds a valid quote key.
      const quotable = (solverId: string) => {
        const manifest = registry?.latest<SolverCapabilityManifestInput>("SOLVER_CAPABILITY", solverId)?.document;
        if (manifest === undefined) return false;
        const now = nowIn(manifest.validityUnit);
        return now !== undefined && now < manifest.validUntilValue &&
          manifest.quoteVerificationKeys.some((key) => now >= key.validFromValue && now < key.validUntilValue);
      };
      const quotes = requireSolverState()
        .shardsForMarket(classId)
        .filter(({ shard }) => shard.killSwitchState === "INACTIVE" && quotable(shard.solverId))
        .flatMap(({ shard, shardHashHex }) =>
          shard.quoteLevels.flatMap((level) => {
            const now = nowIn(level.validUntilUnit);
            if (now === undefined || now >= level.validUntilValue || now >= shard.heartbeatExpiry) return [];
            return [{
              solverId: shard.solverId,
              shardHash: shardHashHex,
              shardSequence: shard.shardSequence,
              referenceStateHash: toHex(shard.referenceStateHash),
              referenceSequence: shard.referenceSequence,
              levelId: level.levelId,
              direction: level.direction,
              size: level.size,
              referenceOffset: level.referenceOffset,
              maximumFee: level.maximumFee,
              quoteMode: level.quoteMode,
              settlementClass: level.settlementClass,
              reservationPolicy: level.reservationPolicy,
              validUntilUnit: level.validUntilUnit,
              validUntilValue: level.validUntilValue,
            }];
          }),
        );
      return { packageMarketId: classId, quotes };
    }
    if ((match = /^\/v1\/solvers\/([^/]+)\/capacity$/.exec(path)) !== null) {
      onlyParams(url, []);
      const solverId = id(match[1], "Solver id");
      const manifest = requireRegistry().latest<SolverCapabilityManifestInput>("SOLVER_CAPABILITY", solverId);
      if (manifest === undefined) throw new RequestError(404, "NOT_FOUND", "No such solver.");
      const now = nowIn(manifest.document.validityUnit);
      if (now === undefined) throw new RequestError(409, "VALIDITY_UNIT_UNSUPPORTED", "Slot-timed capacity cannot be judged against wall-clock time.");
      return { solverId, asOfValue: now, scopes: requireSolverState().capacityStatus(solverId, now) };
    }
    if ((match = /^\/v1\/markets\/([^/]+)\/package-depth$/.exec(path)) !== null) {
      onlyParams(url, []);
      return packageDepthView(book(id(match[1], "Package market id")), nowValue());
    }
    if ((match = /^\/v1\/markets\/([^/]+)\/package-tape$/.exec(path)) !== null) {
      onlyParams(url, ["after", "limit"]);
      const classId = id(match[1], "Package market id");
      const after = url.searchParams.get("after") ?? "0";
      const limit = url.searchParams.get("limit") ?? "50";
      if (!CURSOR.test(after) || !LIMIT.test(limit) || Number(limit) > MAX_TAPE_PAGE) throw new RequestError(400, "INVALID_REQUEST", "Tape cursor or limit is malformed.");
      return packageTapeView(classId, exchange.allocationTape(classId, Number(after), Number(limit)), Number(after));
    }
    if ((match = /^\/v1\/markets\/([^/]+)\/candles$/.exec(path)) !== null) {
      onlyParams(url, ["interval", "from", "to"]);
      const classId = id(match[1], "Package market id");
      const interval = (url.searchParams.get("interval") ?? "1h") as CandleInterval;
      if (!Object.hasOwn(CANDLE_INTERVAL_MS, interval)) throw new RequestError(400, "INVALID_REQUEST", "Unknown candle interval.");
      const width = CANDLE_INTERVAL_MS[interval];
      const toText = url.searchParams.get("to");
      const fromText = url.searchParams.get("from");
      if ((toText !== null && !MILLIS.test(toText)) || (fromText !== null && !MILLIS.test(fromText))) {
        throw new RequestError(400, "INVALID_REQUEST", "from and to must be millisecond timestamps.");
      }
      // Windows snap to candle boundaries so the first and last candles hold every trade in them.
      const to = Math.ceil((toText === null ? clockMs() + 1 : Number(toText)) / width) * width;
      const from = Math.floor((fromText === null ? Math.max(0, to - width * 300) : Number(fromText)) / width) * width;
      if (to <= from || (to - from) / width > MAX_CANDLES_PER_REQUEST) {
        throw new RequestError(400, "INVALID_REQUEST", `The window must be nonempty and span at most ${MAX_CANDLES_PER_REQUEST} candles.`);
      }
      const records = exchange.allocationsBetween(classId, from, to, MAX_CANDLE_TRADES);
      const trades = records.flatMap((record) => record.allocation.fills.map((fill) => ({ timeMs: record.recordedAtMs, priceTicks: fill.priceTicks, quantity: fill.quantity })));
      const series = aggregateCandles(trades, interval, "OBSERVED", { fromMs: from, toMs: to });
      return { packageMarketId: classId, fromMs: from, toMs: to, truncated: records.length === MAX_CANDLE_TRADES, ...series };
    }
    if ((match = /^\/v1\/markets\/([^/]+)\/index$/.exec(path)) !== null) {
      onlyParams(url, ["sizes"]);
      const state = book(id(match[1], "Package market id"));
      const sizes = sizesParam(url);
      const now = nowValue();
      return {
        packageMarketId: state.executionClassId,
        asOfValue: now,
        ...executablePackageIndex(packageBookLevels(state, "BID", now), packageBookLevels(state, "ASK", now), sizes),
      };
    }
    if ((match = /^\/v1\/indices\/([^/]+)$/.exec(path)) !== null) {
      // Every execution class of the series: direct liquidity is EXECUTABLE, adding implied
      // liquidity gives a separate INDICATIVE series, and an unopened class says so.
      onlyParams(url, ["sizes"]);
      const series = seriesOf(id(match[1], "Series id"));
      const { now, classes } = seriesBooks(series.seriesId, sizesParam(url));
      return { seriesId: series.seriesId, quoteAsset: series.quoteAsset, asOfValue: now, executionClasses: classes };
    }
    if ((match = /^\/v1\/curves\/([^/]+)$/.exec(path)) !== null) {
      // The series curve across execution classes: executable prices at each size and the last
      // observed trade. Nothing is interpolated or modeled; a class without depth has no point.
      onlyParams(url, ["sizes"]);
      const series = seriesOf(id(match[1], "Series id"));
      const { now, classes } = seriesBooks(series.seriesId, sizesParam(url));
      return {
        seriesId: series.seriesId,
        quoteAsset: series.quoteAsset,
        quoteConvention: series.quoteConvention,
        asOfValue: now,
        methodologyVersion: MARKET_DATA_METHODOLOGY_VERSION,
        points: classes.map((entry) => {
          const trade = entry.open ? lastTrade(entry.executionClassId) : undefined;
          return {
            executionClassId: entry.executionClassId,
            settlementClass: entry.settlementClass,
            domains: entry.domains,
            open: entry.open,
            ...(entry.open ? { halted: entry.halted, executable: entry.index.executable } : {}),
            ...(trade === undefined ? {} : { lastTrade: trade }),
          };
        }),
      };
    }
    if (path === "/v1/opportunities") {
      // Open, unhalted package markets with executable depth at the requested size on at least
      // one side, tightest executable spread first. Only direct resting liquidity counts.
      onlyParams(url, ["size"]);
      const [size] = sizesParam(url, "size");
      const now = nowValue();
      const seriesByClass = new Map<string, string>();
      for (const series of exchange.listSeries()) {
        for (const executionClass of exchange.listExecutionClasses(series.seriesId)) seriesByClass.set(executionClass.executionClassId, series.seriesId);
      }
      const opportunities = exchange.listBooks()
        .filter((entry) => !entry.halted)
        .flatMap((entry) => {
          const state = book(entry.executionClassId);
          const index = executablePackageIndex(packageBookLevels(state, "BID", now), packageBookLevels(state, "ASK", now), [size as bigint]);
          const bid = index.executable.bids[0];
          const ask = index.executable.asks[0];
          const bidFillable = bid?.averagePriceTicks !== undefined;
          const askFillable = ask?.averagePriceTicks !== undefined;
          if (!bidFillable && !askFillable) return [];
          const trade = lastTrade(entry.executionClassId);
          return [{
            packageMarketId: entry.executionClassId,
            ...(seriesByClass.has(entry.executionClassId) ? { seriesId: seriesByClass.get(entry.executionClassId) } : {}),
            ...(bidFillable ? { bid } : {}),
            ...(askFillable ? { ask } : {}),
            ...(bidFillable && askFillable ? { spreadAtSizeTicks: (ask?.averagePriceTicks as bigint) - (bid?.averagePriceTicks as bigint) } : {}),
            ...(trade === undefined ? {} : { lastTrade: trade }),
          }];
        })
        .sort((left, right) => {
          const a = left.spreadAtSizeTicks;
          const b = right.spreadAtSizeTicks;
          if (a !== undefined && b !== undefined && a !== b) return a < b ? -1 : 1;
          if ((a === undefined) !== (b === undefined)) return a === undefined ? 1 : -1;
          return left.packageMarketId < right.packageMarketId ? -1 : left.packageMarketId > right.packageMarketId ? 1 : 0;
        });
      return { asOfValue: now, size, label: "EXECUTABLE", opportunities };
    }
    if ((match = /^\/v1\/rfqs\/private\/([0-9a-f]{64})$/.exec(path)) !== null) {
      onlyParams(url, []);
      const stored = requireDelivery().getEnvelope(match[1] as string);
      if (stored === undefined) throw new RequestError(404, "NOT_FOUND", "No such envelope.");
      return {
        envelopeHash: stored.envelopeHashHex,
        recipientSolverId: stored.envelope.recipientSolverId,
        acknowledged: stored.acknowledged,
        // The response is ciphertext encrypted to the taker's response key; the relay cannot read it.
        response: stored.response,
      };
    }
    if ((match = /^\/v1\/auctions\/sealed\/([0-9a-f]{64})$/.exec(path)) !== null) {
      onlyParams(url, []);
      const store = requireDelivery();
      const hash = match[1] as string;
      return store.auctionView(hash, wallClockIn(store.auctionDefinition(hash).timeUnit));
    }
    if ((match = /^\/v1\/allocations\/([^/]+)$/.exec(path)) !== null) {
      onlyParams(url, []);
      const orderId = match[1];
      if (orderId === undefined || !HASH_HEX.test(orderId)) throw new RequestError(400, "INVALID_REQUEST", "Order id must be 32 bytes of lowercase hex.");
      const allocation = exchange.getAllocation(orderId);
      const policy = allocation === undefined ? undefined : exchange.getMatchingPolicy(allocation.matchingPolicyHash);
      if (allocation === undefined || policy === undefined) throw new RequestError(404, "ALLOCATION_NOT_FOUND", "No allocation exists for this order.");
      return { allocation, matchingPolicy: policy };
    }
    throw new RequestError(404, "NOT_FOUND", "Unknown public route.");
  }

  async function computeRoutes(request: IncomingMessage, url: URL): Promise<unknown> {
    onlyParams(url, []);
    const path = url.pathname;
    if (![
      "/v1/orders/validate",
      "/v1/routes/replay-decision",
      "/v1/routes/compare",
      "/v1/clearing/simulate",
      "/v1/de-risk/validate",
      "/v1/packages/compile",
      "/v1/packages/simulate",
      "/v1/rfqs/private",
      "/v1/auctions/sealed",
      "/v1/orders",
      "/v1/position-snapshots",
      "/v1/health-snapshots",
      "/v1/strategies/commands",
      "/v1/builders",
      "/v1/builders/attributions",
    ].includes(path)) {
      throw new RequestError(404, "NOT_FOUND", "Unknown public route.");
    }
    const body = object(await readProtocolBody(request), "Request body");
    if (path === "/v1/orders") {
      // Intake only: the order is validated and its owner's signature over the exact canonical
      // bytes is verified. Nothing is quoted, reserved, signed, or submitted to any network here.
      const authorization = object(body.authorization, "authorization");
      if (authorization.scheme !== "ED25519") throw new RequestError(400, "UNSUPPORTED_AUTHORIZATION", "Only ED25519 order authorization is accepted here.");
      const order = object(body.order, "order") as unknown as PackageOrderInput;
      const result = requireEvidence().submitOrder(order, authorization.signature as string);
      return { ...result, status: "ACCEPTED_FOR_QUOTING" };
    }
    if (path === "/v1/strategies/commands") {
      // An owner or delegate's signed strategy command, applied through the kernel lifecycle rules
      // against the exact stored state. A position move is accepted only with the settled receipts
      // that executed it; a novation also needs the new owner's consent over the same hash.
      const authorization = object(body.authorization, "authorization");
      if (authorization.scheme !== "ED25519" || typeof authorization.signature !== "string") {
        throw new RequestError(400, "UNSUPPORTED_AUTHORIZATION", "Strategy commands carry an ED25519 signature in base58.");
      }
      if (options.strategies === undefined) throw new RequestError(503, "STRATEGIES_UNAVAILABLE", "No strategy book is configured on this server.");
      const rawConsents = body.consents ?? [];
      if (!Array.isArray(rawConsents) || rawConsents.length > 3) throw new RequestError(400, "INVALID_REQUEST", "consents lists at most three ED25519 signatures.");
      const consents = rawConsents.map((entry) => {
        const consent = object(entry, "consent");
        if (consent.scheme !== "ED25519" || typeof consent.signerId !== "string" || typeof consent.signature !== "string") {
          throw new RequestError(400, "UNSUPPORTED_AUTHORIZATION", "A consent carries an ED25519 signer id and base58 signature.");
        }
        return { signerId: consent.signerId, signatureBase58: consent.signature };
      });
      const result = options.strategies.submit(object(body.command, "command") as unknown as StrategyCommandInput, authorization.signature, consents);
      if (!result.accepted) throw new RequestError(409, result.rejection, `The strategy command was rejected${result.remedy === undefined ? "" : `; remedy: ${result.remedy}`}.`);
      return result;
    }
    if (path === "/v1/builders" || path === "/v1/builders/attributions") {
      if (options.builders === undefined) throw new RequestError(503, "BUILDERS_UNAVAILABLE", "No builder registry is configured on this server.");
      if (path === "/v1/builders") return options.builders.registerManifest(object(body.manifest, "manifest") as unknown as BuilderManifestInput);
      // Only the order's owner attributes it, over the attribution hash; a builder gains no authority.
      const authorization = object(body.authorization, "authorization");
      if (authorization.scheme !== "ED25519" || typeof authorization.signature !== "string") throw new RequestError(400, "UNSUPPORTED_AUTHORIZATION", "Attributions carry an ED25519 signature in base58.");
      return options.builders.attribute(object(body.attribution, "attribution") as unknown as BuilderAttributionInput, authorization.signature);
    }
    if (path === "/v1/orders/validate") {
      try {
        const order = validatePackageOrderProfile(body.order as PackageOrderInput);
        return { valid: true, orderHash: toHex(packageOrderHash(order)) };
      } catch (error) {
        if (error instanceof ProtocolError) return { valid: false, error: { code: error.code, context: error.context, detail: error.detail } };
        throw error;
      }
    }
    if (path === "/v1/routes/replay-decision") return replayRouteDecision(body.decision as RouteDecisionInput);
    if (path === "/v1/routes/compare") {
      const responses = body.responses as readonly RfqResponse[];
      if (!Array.isArray(responses)) throw new RequestError(400, "INVALID_REQUEST", "responses must be an array.");
      // Solver scope comes from the registry, never from the caller.
      const manifests = [...new Set(responses.map((response) => String((response as { solverId?: unknown }).solverId)))]
        .map((solverId) => (ID.test(solverId) ? requireRegistry().latest<SolverCapabilityManifestInput>("SOLVER_CAPABILITY", solverId)?.document : undefined))
        .filter((manifest): manifest is SolverCapabilityManifestInput => manifest !== undefined);
      return decideRfq(body.request as RfqRequest, responses, manifests, (body.capacities ?? []) as readonly RfqSolverCapacity[]);
    }
    if (path === "/v1/clearing/simulate") {
      const classId = id(typeof body.packageMarketId === "string" ? body.packageMarketId : undefined, "packageMarketId");
      const state = book(classId);
      const policy = exchange.getMatchingPolicy(state.matchingPolicyHash);
      if (policy === undefined) throw new RequestError(500, "INTERNAL_ERROR", "Book policy is unavailable.");
      // Runs against the current book in memory only; nothing is persisted or reserved.
      const result = matchPackageOrder(policy, state, body.order as PackageTakerOrderInput, nowValue());
      return result.accepted ? { accepted: true, simulated: true, allocation: result.allocation } : { accepted: false, simulated: true, rejection: result.rejection };
    }
    if (path === "/v1/rfqs/private") {
      const relay = requireDelivery();
      if (pinnedSuiteIds.length === 0) {
        throw new RequestError(503, "PRIVATE_PATH_UNAVAILABLE", "No encryption suite is pinned; use a visibly labeled public RFQ instead.");
      }
      const entries = body.envelopes;
      if (!Array.isArray(entries) || entries.length === 0 || entries.length > 16) throw new RequestError(400, "INVALID_REQUEST", "envelopes must hold 1 to 16 entries.");
      // Every entry is validated before anything is stored, so a rejected batch delivers nothing.
      const decided = entries.map((entry: unknown) => {
        const item = object(entry, "envelope entry");
        const envelope = object(item.envelope, "envelope") as unknown as PrivateRfqEnvelopeInput;
        if (!(item.ciphertext instanceof Uint8Array) || item.ciphertext.length === 0) throw new RequestError(400, "INVALID_REQUEST", "ciphertext must be bytes.");
        // The sender key id is a self-certifying Ed25519 key, and the sender signs the envelope
        // hash with it, so nobody else can spend that sender's nonces or learn whether one is used.
        const senderKey = senderPublicKey((envelope as { senderKeyId?: unknown }).senderKeyId);
        const senderSignature = item.senderSignature;
        if (
          senderKey === undefined ||
          !(senderSignature instanceof Uint8Array) ||
          !verifyEd25519(senderKey, privateRfqEnvelopeHash(envelope), senderSignature)
        ) {
          return { admission: { admitted: false as const, reason: "SENDER_UNAUTHENTICATED" } };
        }
        const recipient = requireRegistry().latest<SolverCapabilityManifestInput>("SOLVER_CAPABILITY", String((envelope as { recipientSolverId?: unknown }).recipientSolverId));
        if (recipient === undefined) return { admission: { admitted: false as const, reason: "RECIPIENT_MISMATCH" } };
        const admission = admitPrivateRfqEnvelope(envelope, {
          environment: recipient.document.environment,
          pinnedSuiteIds,
          recipientManifest: recipient.document,
          atValue: wallClockIn(envelope.createdAtUnit),
          nonceSeen: relay.nonceSeen(envelope),
          receivedCiphertextHash: new Uint8Array(createHash("sha256").update(item.ciphertext).digest()),
        });
        if (!admission.admitted) return { admission };
        const expiresAtMs = envelope.expiresAtUnit === "EVM_UNIX_SECONDS"
          ? Number(envelope.expiresAtValue) * 1_000
          : Number(envelope.expiresAtValue);
        if (!Number.isSafeInteger(expiresAtMs)) throw new RequestError(400, "INVALID_REQUEST", "Envelope expiry is out of range.");
        return { admission, store: { envelope, ciphertext: item.ciphertext, expiresAtMs, senderSignature } };
      });
      const toStore = decided.flatMap((entry) => (entry.store === undefined ? [] : [entry.store]));
      const stored = toStore.length === 0 ? [] : [...relay.storeEnvelopes(toStore)];
      const results = decided.map((entry) => (entry.store === undefined ? entry.admission : { admitted: true, ...stored.shift() }));
      // Stored is not delivered: private success is reported only after a recipient acknowledges.
      return { results, deliveryStatusRoute: "/v1/rfqs/private/{envelopeHash}" };
    }
    if (path === "/v1/packages/simulate") {
      // The graph's structure, its dependency stages, and every point at which it can stop part
      // way, with the signed recovery that applies. Nothing is compiled against live state.
      const input = object(body.graph, "graph") as unknown as PackageGraphInput;
      const graph = packageGraph(input);
      return { label: "SIMULATED", graphHash: toHex(packageGraphHash(input)), stages: graph.stages, failurePoints: simulatePackageGraphFailures(input) };
    }
    if (path === "/v1/packages/compile") {
      // Compiles a graph against the registered template it binds, this server's active registry
      // records, and each domain's resource limits. Wall-clock graphs compile at server time; a
      // slot-timed graph at the caller's atSlot, and the response says which.
      const context = options.graphContext;
      if (context === undefined) throw new RequestError(503, "GRAPH_CONTEXT_UNAVAILABLE", "No graph compilation context is configured on this server.");
      const input = object(body.graph, "graph") as unknown as PackageGraphInput;
      const graph = packageGraph(input);
      const template = requireRegistry().latest<PackageTemplateManifestInput>("PACKAGE_TEMPLATE", graph.templateId, graph.templateVersion);
      if (template === undefined) throw new RequestError(404, "TEMPLATE_NOT_FOUND", "The graph binds no registered package template.");
      const serverNow = nowIn(graph.expiryUnit);
      let currentTime: { unit: typeof graph.expiryUnit; value: bigint };
      let timeSource: "SERVER" | "CALLER";
      if (serverNow !== undefined) {
        currentTime = { unit: graph.expiryUnit, value: serverNow };
        timeSource = "SERVER";
      } else {
        if (typeof body.atSlot !== "bigint" || body.atSlot <= 0n) throw new RequestError(400, "TIME_REQUIRED", "A slot-timed graph compiles at an explicit positive atSlot.");
        currentTime = { unit: graph.expiryUnit, value: body.atSlot };
        timeSource = "CALLER";
      }
      const result = compilePackageGraph(input, { templateManifest: template.document, activeRegistryRecords: context.activeRegistryRecords, resourceLimits: context.resourceLimits, currentTime });
      return { ...result, currentTime, timeSource };
    }
    if (path === "/v1/position-snapshots") {
      // A signed read-only observation from a position source. The store verifies the authority
      // signature, the observation time, and ordering; nothing here grants authority over positions.
      return requirePositions().append(object(body.record, "record") as unknown as PositionSnapshotRecordInput);
    }
    if (path === "/v1/health-snapshots") {
      // A health observation signed by a configured authority over the snapshot hash. It feeds the
      // keeper gate only; nothing here grants authority over a strategy or its positions.
      if (options.health === undefined) throw new RequestError(503, "HEALTH_UNAVAILABLE", "No strategy health store is configured on this server.");
      if (typeof body.authority !== "string" || !(body.signature instanceof Uint8Array)) throw new RequestError(400, "INVALID_REQUEST", "authority is a string and signature is bytes.");
      return options.health.publishHealth(object(body.snapshot, "snapshot") as unknown as StrategyHealthSnapshotInput, body.authority, body.signature);
    }
    if (path === "/v1/auctions/sealed") {
      const definition = object(body.definition, "definition") as unknown as SealedAuctionDefinitionInput;
      wallClockIn(String((definition as { timeUnit?: unknown }).timeUnit));
      const eligible = (definition as { eligibleSolverIds?: unknown }).eligibleSolverIds;
      if (!Array.isArray(eligible) || eligible.some((solverId) => typeof solverId !== "string" || requireRegistry().latest("SOLVER_CAPABILITY", solverId) === undefined)) {
        throw new RequestError(400, "INVALID_REQUEST", "Every eligible solver must be registered.");
      }
      return requireDelivery().createAuction(definition);
    }
    const positions = body.positions as readonly NormalizedPositionInput[];
    const openOrders = (body.openRiskIncreasingOrderIds ?? []) as readonly string[];
    if (typeof body.stateCertain !== "boolean") throw new RequestError(400, "INVALID_REQUEST", "stateCertain must be a boolean.");
    return { actions: planCoordinatedDeRisk(positions, body.policy as DeRiskPolicy, body.stateCertain, openOrders) };
  }

  /** Returns false when the path is not a public v1 route, so the host server continues routing. */
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const url = new URL(request.url ?? "/", "http://public-api.local");
    if (!url.pathname.startsWith("/v1/") || url.pathname.startsWith("/v1/solver/")) return false;
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Access-Control-Max-Age", "600");
      response.end();
      return true;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      response.setHeader("Allow", "GET, POST, OPTIONS");
      fail(response, 405, "METHOD_NOT_ALLOWED", "Only GET and POST are supported.");
      return true;
    }
    if (limited(request)) {
      fail(response, 429, "RATE_LIMITED", "Too many requests.");
      return true;
    }
    const run = async () => (request.method === "GET" ? readRoutes(url) : computeRoutes(request, url));
    run()
      .then((body) => send(response, 200, body))
      .catch((error: unknown) => {
        if (response.headersSent) return response.destroy();
        if (error instanceof RequestError) return fail(response, error.status, error.code, error.message);
        if (error instanceof ProtocolError) return fail(response, 400, "INVALID_REQUEST", `${error.context}: ${error.detail}`);
        if (error instanceof PackageExchangeStoreError && error.code === "BOOK_NOT_FOUND") return fail(response, 404, "BOOK_NOT_FOUND", "Package market is not open.");
        if (error instanceof PackageExchangeStoreError && error.code === "INVALID_INPUT") return fail(response, 400, "INVALID_REQUEST", error.message);
        if (error instanceof RegistryStoreError && error.code === "INVALID_INPUT") return fail(response, 400, "INVALID_REQUEST", error.message);
        if (error instanceof PrivateDeliveryStoreError) return fail(response, error.code === "NOT_FOUND" ? 404 : error.code === "INBOX_FULL" ? 429 : 409, error.code, error.message);
        if (error instanceof EvidenceStoreError) {
          const status = ["INVALID_ORDER", "INVALID_SIGNATURE", "UNSUPPORTED_AUTHORIZATION"].includes(error.code) ? 400 : error.code === "CORRUPT_ROW" ? 500 : 409;
          return fail(response, status, error.code, error.message);
        }
        if (error instanceof BuilderStoreError) {
          const status = ["INVALID_MANIFEST", "INVALID_ATTRIBUTION", "INVALID_SIGNATURE", "WRONG_ENVIRONMENT"].includes(error.code) ? 400 : error.code.endsWith("NOT_FOUND") ? 404 : 409;
          return fail(response, status, error.code, error.message);
        }
        if (error instanceof StrategyBookError) {
          const status = ["INVALID_COMMAND", "INVALID_SIGNATURE", "WRONG_ENVIRONMENT", "STALE_COMMAND"].includes(error.code) ? 400 : ["STRATEGY_NOT_FOUND", "ORIGIN_NOT_FOUND", "RECEIPT_NOT_FOUND"].includes(error.code) ? 404 : error.code === "CORRUPT_ROW" ? 500 : 409;
          return fail(response, status, error.code, error.message);
        }
        if (error instanceof KeeperExecutorError) {
          const status = error.code === "UNKNOWN_AUTHORITY" ? 403 : error.code === "CORRUPT_ROW" ? 500 : 400;
          return fail(response, status, error.code, error.message);
        }
        if (error instanceof PositionSnapshotStoreError) {
          const status = ["INVALID_RECORD", "INVALID_SIGNATURE"].includes(error.code) ? 400 : error.code === "UNKNOWN_AUTHORITY" ? 403 : error.code === "CORRUPT_ROW" ? 500 : 409;
          return fail(response, status, error.code, error.message);
        }
        return fail(response, 500, "INTERNAL_ERROR", "Public request failed.");
      });
    return true;
  };
}
