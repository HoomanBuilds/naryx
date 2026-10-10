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
  netObligations,
  packageBookLevels,
  packageAllocationHash,
  packageOrderHash,
  planCoordinatedDeRisk,
  compilePackageGraph,
  packageGraph,
  packageGraphHash,
  compileTypedStrategyRoute,
  validateStrategyPackageRouteAdmission,
  authorizeSolverQuote,
  bytesEqual,
  commitmentHash,
  packageTakerOrderHash,
  packageBookAmendment,
  packageBookAmendmentBytes,
  packageBookAmendmentHash,
  packageBookHaltHash,
  packageBookCancellation,
  packageBookCancellationBytes,
  packageBookCancellationHash,
  packageSettlementCommitment,
  packageSettlementCommitmentBytes,
  packageSettlementCommitmentHash,
  packageSettlementHandoffHash,
  packageSettlementReadinessHash,
  packageReopeningResultHash,
  packageReopeningSettlementHandoffHash,
  packageQuoteExecutionBindingHash,
  solverCapabilityManifestHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  strategyPackageReceipt,
  strategyCommandAuthorizationTypedData,
  strategyCommandHash,
  isEvmStrategyActor,
  strategyPackageQuoteHash,
  strategyTemplateDefinitions,
  simulatePackageGraphFailures,
  privateRfqEnvelopeHash,
  ProtocolError,
  replayRouteDecision,
  toHex,
  builderManifestHash,
  toProtocolJson,
  validatePackageOrderProfile,
  validatePackageQuoteExecutionBinding,
  verifyPackageSettlementHandoff,
  verifyPackageReopeningSettlementHandoff,
} from "@naryx/protocol-types";
import type {
  QualificationObjectType,
  CandleInterval,
  DeRiskPolicy,
  NormalizedPositionInput,
  PositionSnapshotRecordInput,
  DomainRegistryRecordInput,
  DomainResourceLimit,
  DomainRef,
  PackageGraphInput,
  NettingObligationInput,
  NettingPolicyManifestInput,
  PackageTemplateManifestInput,
  PackageOrderInput,
  PackageBookAmendmentInput,
  PackageBookCancellationInput,
  PackageSettlementCommitmentInput,
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
  StrategyPackageOrderInput,
  StrategyPackageQuoteInput,
  TypedAdapterActionSupportInput,
  TypedStrategyRoute,
  CollateralSnapshotInput,
} from "@naryx/protocol-types";
import { MAX_TAPE_PAGE, PackageExchangeStoreError, type SqlitePackageExchangeStore } from "./package-exchange-store.js";
import { RegistryStoreError, type SqliteRegistryStore } from "./registry-store.js";
import type { SqliteSolverApiStore } from "./solver-api-store.js";
import { PrivateDeliveryStoreError, type SqlitePrivateDeliveryStore } from "./private-delivery-store.js";
import { requestClientKey, createRateLimiter } from "./rate-limit.js";
import { EvidenceStoreError, type SqliteEvidenceStore } from "./evidence-store.js";
import type { SqliteQualificationStore } from "./qualification-store.js";
import { PositionSnapshotStoreError, type SqlitePositionSnapshotStore } from "./position-snapshot-store.js";
import { CollateralSnapshotStoreError, type SqliteCollateralSnapshotStore } from "./collateral-snapshot-store.js";
import { StrategyBookError, type SqliteStrategyBookStore } from "./strategy-book-store.js";
import { prepareStrategyOpen, prepareStrategyTransition, StrategyOpenPreparationError } from "./strategy-open-preparation.js";
import type { StrategyCommandAuthorization } from "./strategy-command-authorization.js";
import { BuilderStoreError, type SqliteBuilderStore } from "./builder-store.js";
import { KeeperExecutorError, type SqliteKeeperExecutor } from "./keeper-executor.js";
import { CoordinationStoreError, type SqliteCoordinationStore } from "./coordination-store.js";
import { positionsView, RISK_METHODOLOGY, riskView } from "./position-risk-view.js";
import { verifyEd25519 } from "./ed25519.js";
import { StrategyPackageStoreError, type SqliteStrategyPackageStore } from "./strategy-package-store.js";
import { NativeClearingStoreError, type SqliteNativeClearingStore } from './native-clearing-store.js';
import {
  GeneralizedStrategyQuoteClientError,
  type GeneralizedStrategyQuotePort,
} from "./generalized-strategy-quote-client.js";
import {
  PortfolioOptimizationClientError,
} from './portfolio-optimization-client.js';
import {
  AuthoritativePortfolioOptimizationError,
  type AuthoritativePortfolioOptimizationPort,
  type AuthoritativePortfolioOptimizationRequest,
} from "./authoritative-portfolio-optimization.js";
import {
  createStrategyOrderIntake,
  StrategyOrderIntakeError,
  type StrategyOrderIntakePort,
} from "./strategy-order-intake.js";
import {
  HyperliquidNettingResidualExecutionClientError,
} from "./hyperliquid-netting-residual-execution-client.js";
import { BaseSepoliaNettingResidualExecutionClientError } from "./base-sepolia-netting-residual-execution-client.js";
import { SolanaDevnetNettingResidualExecutionClientError } from "./solana-devnet-netting-residual-execution-client.js";
import type { NettingExecutionCoordinator } from "./netting-execution-coordinator.js";
import {
  isEvmPackageBookParticipant,
  packageAmendmentAuthorizationTypedData,
  packageCancellationAuthorizationTypedData,
  packageSettlementAuthorizationTypedData,
  verifyEvmPackageAmendmentAuthorization,
  verifyEvmPackageCancellationAuthorization,
  verifyEvmPackageSettlementAuthorization,
} from "./package-book-authorization.js";

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

function ed25519Signature(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const bytes = bs58.decode(value);
    return bytes.length === 64 && bs58.encode(bytes) === value ? bytes : undefined;
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
const MAX_PORTFOLIO_OPTIMIZATION_BODY_BYTES = 1_048_576;
const MAX_CANDLE_TRADES = 50_000;
const MAX_CANDLES_PER_REQUEST = 1_000;

export type PublicExchangeStore = Pick<
  SqlitePackageExchangeStore,
  | "getBook"
  | "getMatchingPolicy"
  | "getAllocation"
  | "settlementCommitment"
  | "settlementAuthorization"
  | "settlementHandoff"
  | "settlementProgress"
  | "reopeningResult"
  | "reopeningSettlementHandoff"
  | "haltRecord"
  | "allocationTape"
  | "allocationsBetween"
  | "listBooks"
  | "listSeries"
  | "listExecutionClasses"
  | "getSeriesRecord"
  | "getExecutionClassRecord"
  | "latestTrade"
  | "submitOrder"
  | "queueReopeningOrder"
  | "recordPreparedNettingBatch"
  | "nettingBatch"
  | "nettingBatchForPackage"
  | "crossBatchClearing"
  | "recentCrossBatchClearings"
  | "amendEntry"
  | "cancelEntry"
>;

export type PublicRegistryStore = Pick<SqliteRegistryStore, "list" | "latest" | "byHash">;

export type PublicSolverState = Pick<SqliteSolverApiStore, "shardsForMarket" | "capacityStatus">;

export function sealedAuctionAwardMatchesQuote(
  quote: Readonly<{
    environment: string;
    solverId: string;
    quoteHash: string;
    netOutcomeAtoms: bigint;
    validUntilUnit: string;
    validUntilValue: bigint;
  }>,
  award: Readonly<{
    environment: string;
    solverId: string;
    quoteHash: string;
    netOutcomeAtoms: bigint;
    timeUnit: string;
    settlementDeadlineValue: bigint;
  }>,
): boolean {
  return quote.environment === award.environment
    && quote.solverId === award.solverId
    && quote.quoteHash === award.quoteHash
    && quote.netOutcomeAtoms === award.netOutcomeAtoms
    && quote.validUntilUnit === award.timeUnit
    && quote.validUntilValue >= award.settlementDeadlineValue;
}

export function privateRfqResponseMatchesQuote(
  quote: Readonly<{
    environment: string;
    orderHash: string;
    solverId: string;
    quoteHash: string;
  }>,
  response: Readonly<{
    environment: string;
    orderHash: string;
    solverId: string;
    quoteHash: string;
  }>,
): boolean {
  return quote.environment === response.environment
    && quote.orderHash === response.orderHash
    && quote.solverId === response.solverId
    && quote.quoteHash === response.quoteHash;
}

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
  /** Optional: collateral reads answer 503 without it. Snapshots are accepted only from configured authorities. */
  readonly collateral?: Pick<SqliteCollateralSnapshotStore, "append" | "latest" | "now">;
  /** The signed strategy book; without it the strategy routes answer 503. */
  readonly strategies?: Pick<SqliteStrategyBookStore, "submit" | "strategy" | "history" | "ownerStrategies" | "environmentName">;
  /** Durable admitted package intake; without it submission answers 503 while validation remains available. */
  readonly strategyPackages?: Pick<SqliteStrategyPackageStore, "registerOrder" | "registerQuote" | "recentAdmissions" | "receipt" | "receiptByQuote">
    & Partial<Pick<SqliteStrategyPackageStore, "order" | "admissionByQuote" | "registerBoundQuote" | "lockPackageExecution" | "ownerReceipts" | "executionIntelligence">>;
  /** Shared canonical strategy-order admission used by both the public API and the private terminal. */
  readonly strategyOrderIntake?: StrategyOrderIntakePort;
  /** Optional: requests a signed quote from the loopback reference solver for a stored order. */
  readonly strategyQuotes?: GeneralizedStrategyQuotePort;
  /** Optional: computes an advisory portfolio selection and independently verifies the solver response. */
  readonly portfolioOptimization?: AuthoritativePortfolioOptimizationPort;
  /** Optional: executes already authorized Testnet residual intents through the loopback solver. */
  readonly nettingExecution?: Pick<NettingExecutionCoordinator, "execute">;
  /** Builder manifests and attributions; without it the builder routes answer 503. */
  readonly builders?: Pick<SqliteBuilderStore, "registerManifest" | "latest" | "attribute" | "attributions" | "revenue">;
  /** Cross-domain coordinations and manual recovery incidents; without it those routes answer 503. */
  readonly coordination?: Pick<SqliteCoordinationStore, "coordination" | "incident" | "approve">;
  /** Authority-signed strategy health; without it the health routes answer 503. */
  readonly health?: Pick<SqliteKeeperExecutor, "publishHealth" | "health">;
  /** Native package clearing state and evidence; mutation remains on the loopback control boundary. */
  readonly nativeClearing?: Pick<
    SqliteNativeClearingStore,
    'domains' | 'domain' | 'accounts' | 'account' | 'latestMark' | 'defaultAuction' | 'events'
  >;
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

function strategyCommandAuthorization(value: unknown, name: string): StrategyCommandAuthorization {
  const authorization = object(value, name);
  if (authorization.scheme !== "ED25519" && authorization.scheme !== "EIP712_SECP256K1") {
    throw new RequestError(400, "UNSUPPORTED_AUTHORIZATION", `${name} has an unsupported signature scheme.`);
  }
  if (typeof authorization.signature !== "string") {
    throw new RequestError(400, "UNSUPPORTED_AUTHORIZATION", `${name} has no signature.`);
  }
  return { scheme: authorization.scheme, signature: authorization.signature };
}

async function readProtocolBody(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new RequestError(415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestError(413, "BODY_TOO_LARGE", "Request body is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new RequestError(413, "BODY_TOO_LARGE", "Request body is too large.");
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
 * candles, and an executable index, allocation evidence by capability, and computation routes.
 * It holds no signer, keeps direct and implied liquidity apart, omits participant identities from
 * the tape, and labels every derived market number. Only the explicit strategy package submission
 * route persists an already admitted tuple. It returns false for paths it does not own, including
 * /v1/solver/.
 */
export function createPublicApiHandler(options: PublicApiOptions) {
  const { exchange, registry, solverState, delivery, nowValue } = options;
  const pinnedSuiteIds = options.pinnedSuiteIds ?? [];
  const { windowMs, maxRequests } = options.rateLimit;
  const clockMs = options.clockMs ?? Date.now;
  const limiter = createRateLimiter({ windowMs, maxRequests, clockMs });
  const strategyOrderIntake = options.strategyOrderIntake ?? (
    registry !== undefined && options.graphContext !== undefined && options.strategyPackages !== undefined
      ? createStrategyOrderIntake({
        exchange,
        registry,
        graphContext: options.graphContext,
        store: options.strategyPackages,
        clockMs,
      })
      : undefined
  );

  function limited(request: IncomingMessage): boolean {
    return limiter(requestClientKey(request));
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

  function requireCoordination() {
    if (options.coordination === undefined) throw new RequestError(503, "COORDINATION_UNAVAILABLE", "No coordination store is configured on this server.");
    return options.coordination;
  }

  function requirePositions() {
    if (options.positions === undefined) throw new RequestError(503, "POSITIONS_UNAVAILABLE", "No position snapshot store is configured on this server.");
    return options.positions;
  }

  function requireCollateral() {
    if (options.collateral === undefined) {
      throw new RequestError(503, "COLLATERAL_UNAVAILABLE", "No collateral snapshot store is configured on this server.");
    }
    return options.collateral;
  }

  function requireDelivery() {
    if (delivery === undefined) throw new RequestError(503, "PRIVATE_DELIVERY_UNAVAILABLE", "No private delivery relay is configured on this server.");
    return delivery;
  }

  function requireStrategyPackages() {
    if (options.strategyPackages === undefined) throw new RequestError(503, "STRATEGY_PACKAGE_STORE_UNAVAILABLE", "No strategy package store is configured on this server.");
    return options.strategyPackages;
  }

  function requireStrategyQuotes(): GeneralizedStrategyQuotePort {
    if (options.strategyQuotes === undefined) throw new RequestError(503, "STRATEGY_QUOTES_UNAVAILABLE", "No generalized strategy quote service is configured on this server.");
    return options.strategyQuotes;
  }

  function requirePortfolioOptimization(): AuthoritativePortfolioOptimizationPort {
    if (options.portfolioOptimization === undefined) {
      throw new RequestError(503, "PORTFOLIO_OPTIMIZATION_UNAVAILABLE", "Portfolio optimization is disabled on this server.");
    }
    return options.portfolioOptimization;
  }

  function requireNettingExecution(): Pick<NettingExecutionCoordinator, "execute"> {
    if (options.nettingExecution === undefined) {
      throw new RequestError(503, "NETTING_EXECUTION_UNAVAILABLE", "Netting residual execution is disabled.");
    }
    return options.nettingExecution;
  }

  function requireNativeClearing(): NonNullable<PublicApiOptions['nativeClearing']> {
    if (options.nativeClearing === undefined) {
      throw new RequestError(503, 'NATIVE_CLEARING_UNAVAILABLE', 'No native clearing state is configured on this server.');
    }
    return options.nativeClearing;
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

  function requireStrategyMarket(graph: ReturnType<typeof packageGraph>) {
    const series = exchange.getSeriesRecord(graph.seriesId, graph.seriesVersion);
    if (series === undefined || series.documentHashHex !== toHex(graph.seriesManifestHash)) {
      throw new RequestError(404, "SERIES_NOT_FOUND", "The graph binds no registered strategy series.");
    }
    if (
      series.document.templateId !== graph.templateId
      || series.document.templateVersion !== graph.templateVersion
      || !bytesEqual(series.document.templateManifestHash, graph.packageTemplateManifestHash)
    ) {
      throw new RequestError(400, "SERIES_MISMATCH", "The strategy series does not bind the graph template.");
    }
    const definition = strategyTemplateDefinitions().find((template) => template.templateId === graph.templateId);
    if (
      definition === undefined
      || series.document.quoteConvention !== definition.quoteConventionId
      || series.document.riskClass !== definition.riskClassId
      || series.document.lifecycleConvention !== definition.lifecycleConventionId
    ) {
      throw new RequestError(400, "SERIES_MISMATCH", "The strategy series carries unsupported economics or lifecycle semantics.");
    }
    const executionClass = exchange.getExecutionClassRecord(graph.executionClassId, graph.executionClassVersion);
    if (executionClass === undefined || executionClass.documentHashHex !== toHex(graph.executionClassManifestHash)) {
      throw new RequestError(404, "EXECUTION_CLASS_NOT_FOUND", "The graph binds no registered execution class.");
    }
    if (
      executionClass.document.seriesId !== graph.seriesId
      || executionClass.document.seriesVersion !== graph.seriesVersion
      || !bytesEqual(executionClass.document.seriesManifestHash, graph.seriesManifestHash)
      || executionClass.document.settlementClass !== graph.settlementClass
    ) {
      throw new RequestError(400, "EXECUTION_CLASS_MISMATCH", "The execution class does not bind the graph series and settlement class.");
    }
    const graphDomains = graph.legs.reduce<DomainRef[]>((domains, leg) => {
      if (!domains.some((domain) => domain.domainId === leg.domain.domainId
        && domain.domainManifestVersion === leg.domain.domainManifestVersion
        && bytesEqual(domain.domainManifestHash, leg.domain.domainManifestHash))) domains.push(leg.domain);
      return domains;
    }, []).sort((left, right) => left.domainId.localeCompare(right.domainId));
    if (
      graphDomains.length !== executionClass.document.domains.length
      || graphDomains.some((domain, index) => {
        const expected = executionClass.document.domains[index];
        return expected === undefined || domain.domainId !== expected.domainId
          || domain.domainManifestVersion !== expected.domainManifestVersion
          || !bytesEqual(domain.domainManifestHash, expected.domainManifestHash);
      })
    ) {
      throw new RequestError(400, "EXECUTION_CLASS_MISMATCH", "The execution class domains do not match the graph.");
    }
    return series.document;
  }

  async function requestAndStoreStrategyQuote(
    orderHash: string,
    idempotencyKey: string,
    packageExecution?: Readonly<{
      packageOrderId: string;
      settlement: ReturnType<SqlitePackageExchangeStore["settlementProgress"]> & {};
    }>,
    expectedAuctionAward?: Readonly<{
      environment: string;
      solverId: string;
      quoteHash: string;
      netOutcomeAtoms: bigint;
      timeUnit: string;
      settlementDeadlineValue: bigint;
    }>,
    expectedPrivateRfqResponse?: Readonly<{
      environment: string;
      orderHash: string;
      solverId: string;
      quoteHash: string;
    }>,
  ) {
    const store = requireStrategyPackages();
    if (store.order === undefined) throw new RequestError(503, "STRATEGY_QUOTES_UNAVAILABLE", "Stored strategy order lookup is unavailable.");
    const stored = store.order(orderHash);
    if (stored === undefined) throw new RequestError(404, "ORDER_NOT_FOUND", "The strategy order is not stored for quoting.");
    const result = await requireStrategyQuotes().quote(
      orderHash,
      idempotencyKey,
      packageExecution === undefined ? undefined : {
        packageOrderId: packageExecution.packageOrderId,
        settlementReadinessHash: packageExecution.settlement.readinessHashHex,
      },
    );
    const graph = packageGraph(stored.graph);
    const series = requireStrategyMarket(graph);
    const template = requireRegistry().latest<PackageTemplateManifestInput>("PACKAGE_TEMPLATE", graph.templateId, graph.templateVersion);
    if (template === undefined) throw new RequestError(404, "TEMPLATE_NOT_FOUND", "The graph binds no registered package template.");
    const currentValue = nowIn(graph.expiryUnit);
    if (currentValue === undefined) throw new RequestError(400, "TIME_UNIT_UNSUPPORTED", "The server cannot judge this strategy quote clock.");
    const currentTime = { unit: graph.expiryUnit, value: currentValue };
    const graphContext = options.graphContext;
    if (graphContext === undefined) {
      throw new RequestError(503, "GRAPH_CONTEXT_UNAVAILABLE", "No graph compilation context is configured on this server.");
    }
    const admitted = validateStrategyPackageRouteAdmission(
      stored.order,
      stored.graph,
      result.quote,
      result.route,
      {
        templateManifest: template.document,
        activeRegistryRecords: graphContext.activeRegistryRecords,
        resourceLimits: graphContext.resourceLimits,
        currentTime,
      },
    );
    if (admitted.order.quoteAsset.assetId !== series.quoteAsset) {
      throw new RequestError(400, "SERIES_MISMATCH", "The order quote asset differs from the registered strategy series.");
    }
    if (currentTime.value >= admitted.quote.validUntilValue) throw new RequestError(409, "QUOTE_EXPIRED", "The strategy quote has expired.");
    const capability = requireRegistry().latest<SolverCapabilityManifestInput>("SOLVER_CAPABILITY", admitted.quote.solverId);
    if (capability === undefined || !bytesEqual(solverCapabilityManifestHash(capability.document), admitted.quote.solverCapabilityManifestHash)
      || capability.document.validityUnit !== admitted.quote.validUntilUnit) {
      throw new RequestError(400, "SOLVER_CAPABILITY_MISMATCH", "The quote does not bind the registered solver capability.");
    }
    for (const domain of admitted.quote.domains) {
      const authorization = authorizeSolverQuote(capability.document, {
        environment: admitted.quote.environment,
        domain,
        templateId: admitted.quote.templateId,
        quoteMode: admitted.quote.quoteMode,
        marketId: admitted.quote.executionClassId,
        notionalAtoms: admitted.quote.totalGrossNotional.atoms,
        scheme: admitted.quote.solverSignatureScheme,
        verificationKey: admitted.quote.solverVerificationKey,
        atValue: currentTime.value,
      });
      if (!authorization.authorized) throw new RequestError(400, "SOLVER_NOT_AUTHORIZED", `The solver capability rejects this quote: ${authorization.reason}.`);
    }
    if (admitted.quote.solverSignatureScheme !== "ED25519"
      || !verifyEd25519(admitted.quote.solverVerificationKey, strategyPackageQuoteHash(admitted.quote), admitted.quote.signature)) {
      throw new RequestError(400, "INVALID_SIGNATURE", "The strategy quote signature is invalid.");
    }
    if (expectedAuctionAward !== undefined) {
      const admittedQuoteHash = toHex(strategyPackageQuoteHash(admitted.quote));
      if (!sealedAuctionAwardMatchesQuote({
        environment: admitted.quote.environment,
        solverId: admitted.quote.solverId,
        quoteHash: admittedQuoteHash,
        netOutcomeAtoms: admitted.quote.netPackageOutcome.atoms,
        validUntilUnit: admitted.quote.validUntilUnit,
        validUntilValue: admitted.quote.validUntilValue,
      }, expectedAuctionAward)) {
        throw new RequestError(409, "AUCTION_AWARD_MISMATCH", "The signed quote does not match the sealed auction award.");
      }
    }
    if (expectedPrivateRfqResponse !== undefined) {
      const admittedQuoteHash = toHex(strategyPackageQuoteHash(admitted.quote));
      if (!privateRfqResponseMatchesQuote({
        environment: admitted.quote.environment,
        orderHash: result.orderHash,
        solverId: admitted.quote.solverId,
        quoteHash: admittedQuoteHash,
      }, expectedPrivateRfqResponse)) {
        throw new RequestError(409, "PRIVATE_RFQ_RESPONSE_MISMATCH", "The signed quote does not match the encrypted RFQ response.");
      }
    }
    if (packageExecution !== undefined) {
      if (result.executionBinding === undefined) {
        throw new RequestError(400, "EXECUTION_BINDING_MISSING", "The solver omitted the package execution binding.");
      }
      try {
        validatePackageQuoteExecutionBinding(
          result.executionBinding,
          packageExecution.settlement.readiness,
          admitted.quote,
        );
      } catch {
        throw new RequestError(400, "EXECUTION_BINDING_MISMATCH", "The package execution binding does not match final settlement readiness and quote.");
      }
      if (!bytesEqual(
        result.executionBinding.settlementReadinessHash,
        packageSettlementReadinessHash(packageExecution.settlement.readiness),
      ) || !verifyEd25519(
        result.executionBinding.solverVerificationKey,
        packageQuoteExecutionBindingHash(result.executionBinding),
        result.executionBinding.signature,
      )) {
        throw new RequestError(400, "INVALID_EXECUTION_BINDING_SIGNATURE", "The package execution binding signature is invalid.");
      }
    } else if (result.executionBinding !== undefined) {
      throw new RequestError(400, "UNEXPECTED_EXECUTION_BINDING", "A direct strategy quote cannot carry a package execution binding.");
    }
    const storedQuote = packageExecution === undefined
      ? store.registerQuote(admitted)
      : (() => {
        if (result.executionBinding === undefined) {
          throw new RequestError(400, "EXECUTION_BINDING_MISSING", "The solver omitted the package execution binding.");
        }
        if (store.registerBoundQuote === undefined) {
          throw new RequestError(503, "EXECUTION_BINDING_STORE_UNAVAILABLE", "Durable package execution binding storage is unavailable.");
        }
        return store.registerBoundQuote(admitted, packageExecution.settlement.readiness, result.executionBinding);
      })();
    return Object.freeze({
      version: 1 as const,
      status: "SIGNED_AND_STORED" as const,
      orderHash: result.orderHash,
      graphHash: result.graphHash,
      routeHash: storedQuote.routeHashHex,
      quoteHash: storedQuote.quoteHashHex,
      route: admitted.route,
      quote: admitted.quote,
      ...(result.executionBinding === undefined ? {} : {
        executionBinding: result.executionBinding,
        executionBindingHash: toHex(packageQuoteExecutionBindingHash(result.executionBinding)),
      }),
    });
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
    if (path === '/v1/native-clearing/domains') {
      onlyParams(url, []);
      return { version: 1, domains: requireNativeClearing().domains() };
    }
    if ((match = /^\/v1\/native-clearing\/domains\/([^/]+)(\/accounts|\/events|\/mark)?$/.exec(path)) !== null) {
      const clearingDomainId = id(match[1], 'Native clearing domain id');
      const clearing = requireNativeClearing();
      if (match[2] === '/events') {
        onlyParams(url, ['after', 'limit']);
        const rawAfter = url.searchParams.get('after') ?? '0';
        const rawLimit = url.searchParams.get('limit') ?? '100';
        if (!/^\d{1,15}$/.test(rawAfter) || !/^(?:[1-9]|[1-9]\d|[1-4]\d{2}|500)$/.test(rawLimit)) {
          throw new RequestError(400, 'INVALID_REQUEST', 'after must be nonnegative and limit must be between 1 and 500.');
        }
        return {
          version: 1,
          clearingDomainId,
          events: clearing.events(clearingDomainId, Number(rawAfter), Number(rawLimit)),
        };
      }
      onlyParams(url, []);
      const domain = clearing.domain(clearingDomainId);
      if (domain === undefined) throw new RequestError(404, 'DOMAIN_NOT_FOUND', 'Native clearing domain was not found.');
      if (match[2] === '/accounts') return { version: 1, clearingDomainId, accounts: clearing.accounts(clearingDomainId) };
      if (match[2] === '/mark') {
        const observation = clearing.latestMark(clearingDomainId);
        if (observation === undefined) throw new RequestError(404, 'MARK_UNAVAILABLE', 'Native clearing mark is unavailable.');
        return { version: 1, clearingDomainId, observation };
      }
      return { version: 1, ...domain };
    }
    if ((match = /^\/v1\/native-clearing\/accounts\/([^/]+)$/.exec(path)) !== null) {
      onlyParams(url, []);
      const accountId = id(match[1], 'Native clearing account id');
      const account = requireNativeClearing().account(accountId);
      if (account === undefined) throw new RequestError(404, 'ACCOUNT_NOT_FOUND', 'Native clearing account was not found.');
      return { version: 1, account };
    }
    if ((match = /^\/v1\/native-clearing\/auctions\/([^/]+)$/.exec(path)) !== null) {
      onlyParams(url, []);
      return { version: 1, ...requireNativeClearing().defaultAuction(id(match[1], 'Native clearing auction id')) };
    }
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
    if ((match = /^\/v1\/coordinations\/([0-9a-fA-F]{64})$/.exec(path)) !== null) {
      onlyParams(url, []);
      // The plan, every piece of per-domain evidence, and the kernel replay of phase, next actions,
      // and violations; a client re-runs replayCrossDomainCoordination to check it.
      const view = requireCoordination().coordination(match[1] as string, nowIn);
      if (view === undefined) throw new RequestError(404, "PLAN_NOT_FOUND", "No such coordination.");
      return { planHash: (match[1] as string).toLowerCase(), ...view };
    }
    if ((match = /^\/v1\/recovery\/incidents\/([^/]+)$/.exec(path)) !== null) {
      onlyParams(url, []);
      const view = requireCoordination().incident(id(match[1], "Incident id"));
      if (view === undefined) throw new RequestError(404, "INCIDENT_NOT_FOUND", "No such incident.");
      return view;
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
            authorization: entry.authorization,
            consents: entry.consents.map((consent) => ({ signerId: consent.signerId, ...consent.authorization })),
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
        environment: options.strategies.environmentName(),
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
    if ((match = /^\/v1\/owners\/([^/]+)\/strategy-receipts$/.exec(path)) !== null) {
      onlyParams(url, ["limit"]);
      if (options.strategyPackages?.ownerReceipts === undefined) {
        throw new RequestError(503, "STRATEGY_PACKAGES_UNAVAILABLE", "No strategy package evidence store is configured on this server.");
      }
      const requestedOwnerId = id(match[1], "Owner id");
      const ownerId = requestedOwnerId.startsWith("0x") ? requestedOwnerId.toLowerCase() : requestedOwnerId;
      const rawLimit = url.searchParams.get("limit") ?? "50";
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)) {
        throw new RequestError(400, "INVALID_REQUEST", "limit must be an integer between 1 and 50.");
      }
      return {
        version: 1,
        ownerId,
        receipts: options.strategyPackages.ownerReceipts(ownerId, Number(rawLimit)),
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
    if ((match = /^\/v1\/collateral\/([^/]+)$/.exec(path)) !== null) {
      onlyParams(url, []);
      const store = requireCollateral();
      const strategyAccount = id(match[1], "Strategy account");
      const snapshots = store.latest(strategyAccount);
      if (snapshots.length === 0) {
        throw new RequestError(404, "COLLATERAL_NOT_FOUND", "No collateral snapshot exists for this account.");
      }
      const now = BigInt(Math.floor(store.now()));
      return {
        strategyAccount,
        label: "OBSERVED" as const,
        sources: snapshots.map((entry) => ({
          recordHash: entry.recordHashHex,
          ageMs: now >= entry.record.observedAtMs ? now - entry.record.observedAtMs : 0n,
          record: entry.record,
        })),
      };
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
    if (path === "/v1/strategy-program") {
      onlyParams(url, []);
      return {
        programVersion: 1,
        templates: strategyTemplateDefinitions().map((template) => ({
          templateId: template.templateId,
          templateVersion: template.templateVersion,
          displayName: template.displayName,
          quoteConventionId: template.quoteConventionId,
          riskClassId: template.riskClassId,
          lifecycleConventionId: template.lifecycleConventionId,
          metricIds: template.metricIds,
          actions: template.actionSpecs.map((action) => ({
            action: action.action,
            minimumLegs: action.minimumLegs,
            maximumLegs: action.maximumLegs,
            settlementClasses: action.allowedSettlementClasses,
            legRoles: action.legRules.map((leg) => ({
              legTypeId: leg.legTypeId,
              allowedFamilies: leg.allowedFamilies,
              allowedSides: leg.allowedSides,
              minimumCount: leg.minimumCount,
              maximumCount: leg.maximumCount,
            })),
          })),
        })),
      };
    }
    if (path === "/v1/strategy-packages/recent") {
      onlyParams(url, ["limit"]);
      const rawLimit = url.searchParams.get("limit") ?? "20";
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)) {
        throw new RequestError(400, "INVALID_REQUEST", "limit must be an integer between 1 and 50.");
      }
      return { version: 1, admissions: requireStrategyPackages().recentAdmissions(Number(rawLimit)) };
    }
    if ((match = /^\/v1\/strategy-quotes\/([0-9a-f]{64})\/proof$/.exec(path)) !== null) {
      onlyParams(url, []);
      const store = requireStrategyPackages();
      if (store.admissionByQuote === undefined) {
        throw new RequestError(503, "STRATEGY_PROOF_UNAVAILABLE", "Strategy quote proof lookup is unavailable on this server.");
      }
      const requestedQuoteHash = match[1] as string;
      const admission = store.admissionByQuote(requestedQuoteHash);
      if (admission === undefined) throw new RequestError(404, "STRATEGY_QUOTE_NOT_FOUND", "No such admitted strategy quote.");
      return {
        version: 1,
        orderHash: admission.orderHashHex,
        graphHash: admission.graphHashHex,
        quoteHash: admission.quoteHashHex,
        routeHash: admission.routeHashHex,
        order: admission.order,
        graph: admission.graph,
        quote: admission.quote,
        route: admission.route,
        recordedAtMs: admission.recordedAtMs,
      };
    }
    if ((match = /^\/v1\/strategy-receipts\/by-quote\/([0-9a-f]{64})$/.exec(path)) !== null) {
      onlyParams(url, []);
      const quoteHash = match[1] as string;
      const stored = requireStrategyPackages().receiptByQuote(quoteHash);
      if (stored === undefined) throw new RequestError(404, "RECEIPT_NOT_FOUND", "This quote has no terminal strategy package receipt.");
      return { version: 1, quoteHash, ...stored };
    }
    if ((match = /^\/v1\/strategy-receipts\/([0-9a-f]{64})\/proof$/.exec(path)) !== null) {
      onlyParams(url, []);
      const store = requireStrategyPackages();
      if (store.admissionByQuote === undefined) {
        throw new RequestError(503, "STRATEGY_PROOF_UNAVAILABLE", "Strategy receipt proof lookup is unavailable on this server.");
      }
      const receiptHash = match[1] as string;
      const receipt = store.receipt(receiptHash);
      if (receipt === undefined) throw new RequestError(404, "RECEIPT_NOT_FOUND", "No such strategy package receipt.");
      const quoteHash = toHex(commitmentHash(receipt.quoteHash, "strategy receipt quote hash"));
      const stored = store.receiptByQuote(quoteHash);
      if (stored === undefined || stored.receiptHashHex !== receiptHash) {
        throw new RequestError(500, "CORRUPT_RECEIPT", "The terminal receipt does not match its quote index.");
      }
      const admission = store.admissionByQuote(quoteHash);
      if (admission === undefined) throw new RequestError(500, "CORRUPT_RECEIPT", "The terminal receipt has no admitted quote proof.");
      const intelligence = store.executionIntelligence?.(receiptHash);
      return {
        version: 1,
        receiptHash,
        receipt,
        recordedAtMs: stored.recordedAtMs,
        quoteProof: {
          version: 1,
          orderHash: admission.orderHashHex,
          graphHash: admission.graphHashHex,
          quoteHash: admission.quoteHashHex,
          routeHash: admission.routeHashHex,
          order: admission.order,
          graph: admission.graph,
          quote: admission.quote,
          route: admission.route,
          recordedAtMs: admission.recordedAtMs,
        },
        ...(intelligence === undefined ? {} : {
          executionIntelligence: {
            intelligence: intelligence.intelligence,
            recordedAtMs: intelligence.recordedAtMs,
          },
        }),
      };
    }
    if ((match = /^\/v1\/strategy-receipts\/([0-9a-f]{64})$/.exec(path)) !== null) {
      onlyParams(url, []);
      const receiptHash = match[1] as string;
      const receipt = requireStrategyPackages().receipt(receiptHash);
      if (receipt === undefined) throw new RequestError(404, "RECEIPT_NOT_FOUND", "No such strategy package receipt.");
      return { version: 1, receiptHash, receipt };
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
            ...(entry.open ? {
              halted: entry.halted,
              executable: entry.index.executable,
              indicativeWithImplied: entry.index.withImplied,
            } : {}),
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
    if ((match = /^\/v1\/package-book\/orders\/([0-9a-f]{64})\/settlement-readiness$/.exec(path)) !== null) {
      onlyParams(url, []);
      const orderId = match[1] as string;
      const progress = exchange.settlementProgress(orderId);
      if (progress === undefined) {
        throw new RequestError(404, "SETTLEMENT_NOT_FOUND", "No settlement commitment exists for this package order.");
      }
      const state = exchange.getBook(progress.readiness.executionClassId);
      if (state === undefined) {
        throw new RequestError(500, "INTERNAL_ERROR", "The settlement commitment refers to a missing package book.");
      }
      const restingEntry = state.entries.find((entry) => bytesEqual(entry.entryId, progress.readiness.packageOrderId));
      if ((restingEntry !== undefined) !== progress.readiness.acceptsFurtherMatches
        || (restingEntry !== undefined && restingEntry.source !== "DIRECT")) {
        throw new RequestError(500, "INTERNAL_ERROR", "Package settlement readiness and resting state disagree.");
      }
      return {
        ...progress,
        restingOrder: restingEntry === undefined
          ? null
          : { quantity: restingEntry.quantity, priceTicks: restingEntry.priceTicks },
      };
    }
    if ((match = /^\/v1\/netting\/batches\/([0-9a-f]{64})$/.exec(path)) !== null) {
      onlyParams(url, []);
      const batch = exchange.nettingBatch(match[1] as string);
      if (batch === undefined) throw new RequestError(404, "NETTING_BATCH_NOT_FOUND", "No prepared netting batch exists for this proof hash.");
      return batch;
    }
    if ((match = /^\/v1\/netting\/packages\/([0-9a-f]{64})$/.exec(path)) !== null) {
      onlyParams(url, []);
      const batch = exchange.nettingBatchForPackage(match[1] as string);
      if (batch === undefined) throw new RequestError(404, "NETTING_BATCH_NOT_FOUND", "No prepared netting batch exists for this package order.");
      return batch;
    }
    if (path === "/v1/netting/cross-batch") {
      onlyParams(url, ["limit"]);
      const rawLimit = url.searchParams.get("limit") ?? "20";
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)) {
        throw new RequestError(400, "INVALID_REQUEST", "limit must be an integer between 1 and 50.");
      }
      return {
        version: 1,
        clearings: exchange.recentCrossBatchClearings(Number(rawLimit)),
      };
    }
    if ((match = /^\/v1\/netting\/cross-batch\/([0-9a-f]{64})$/.exec(path)) !== null) {
      onlyParams(url, []);
      const clearing = exchange.crossBatchClearing(match[1] as string);
      if (clearing === undefined) throw new RequestError(404, "CROSS_BATCH_CLEARING_NOT_FOUND", "No cross-batch clearing evidence exists for this plan hash.");
      return clearing;
    }
    if ((match = /^\/v1\/package-book\/reopenings\/([0-9a-f]{64})$/.exec(path)) !== null) {
      onlyParams(url, []);
      const resultHash = match[1] as string;
      const result = exchange.reopeningResult(resultHash);
      if (result === undefined) {
        throw new RequestError(404, "REOPENING_NOT_FOUND", "No reopening result exists for this hash.");
      }
      if (toHex(packageReopeningResultHash(result)) !== resultHash) {
        throw new RequestError(500, "INTERNAL_ERROR", "Reopening result identity is inconsistent.");
      }
      const settlementHandoff = exchange.reopeningSettlementHandoff(resultHash);
      if ((result.fills.length > 0) !== (settlementHandoff !== undefined)) {
        throw new RequestError(500, "INTERNAL_ERROR", "Reopening settlement handoff presence is inconsistent.");
      }
      if (settlementHandoff !== undefined) verifyPackageReopeningSettlementHandoff(result, settlementHandoff);
      return {
        result,
        resultHash,
        ...(settlementHandoff === undefined ? {} : {
          settlementHandoff,
          settlementHandoffHash: toHex(packageReopeningSettlementHandoffHash(settlementHandoff)),
        }),
      };
    }
    if ((match = /^\/v1\/package-book\/halts\/([0-9a-f]{64})$/.exec(path)) !== null) {
      onlyParams(url, []);
      const haltHash = match[1] as string;
      const record = exchange.haltRecord(haltHash);
      if (record === undefined) {
        throw new RequestError(404, "HALT_NOT_FOUND", "No package book halt exists for this hash.");
      }
      if (record.haltHashHex !== haltHash || toHex(packageBookHaltHash(record.halt)) !== haltHash) {
        throw new RequestError(500, "INTERNAL_ERROR", "Package book halt identity is inconsistent.");
      }
      return record;
    }
    if ((match = /^\/v1\/allocations\/([^/]+)$/.exec(path)) !== null) {
      onlyParams(url, []);
      const orderId = match[1];
      if (orderId === undefined || !HASH_HEX.test(orderId)) throw new RequestError(400, "INVALID_REQUEST", "Order id must be 32 bytes of lowercase hex.");
      const allocation = exchange.getAllocation(orderId);
      const policy = allocation === undefined ? undefined : exchange.getMatchingPolicy(allocation.matchingPolicyHash);
      if (allocation === undefined || policy === undefined) throw new RequestError(404, "ALLOCATION_NOT_FOUND", "No allocation exists for this order.");
      const settlementCommitment = exchange.settlementCommitment(orderId);
      if (settlementCommitment === undefined) {
        throw new RequestError(500, "INTERNAL_ERROR", "Allocation settlement commitment is unavailable.");
      }
      const allocationHash = packageAllocationHash(allocation);
      const settlementHandoff = exchange.settlementHandoff(allocationHash);
      if ((allocation.fills.length > 0) !== (settlementHandoff !== undefined)) {
        throw new RequestError(500, "INTERNAL_ERROR", "Allocation settlement handoff is inconsistent.");
      }
      if (settlementHandoff !== undefined) verifyPackageSettlementHandoff(allocation, settlementHandoff);
      return {
        allocation,
        allocationHash: toHex(allocationHash),
        matchingPolicy: policy,
        settlementCommitment,
        settlementCommitmentHash: toHex(packageSettlementCommitmentHash(settlementCommitment)),
        ...(settlementHandoff === undefined ? {} : {
          settlementHandoff,
          settlementHandoffHash: toHex(packageSettlementHandoffHash(settlementHandoff)),
        }),
      };
    }
    throw new RequestError(404, "NOT_FOUND", "Unknown public route.");
  }

  async function computeRoutes(request: IncomingMessage, url: URL): Promise<unknown> {
    onlyParams(url, []);
    const path = url.pathname;
    const privateRfqAcceptanceMatch = /^\/v1\/rfqs\/private\/([0-9a-f]{64})\/accept$/.exec(path);
    const sealedAuctionAwardMatch = /^\/v1\/auctions\/sealed\/([0-9a-f]{64})\/award$/.exec(path);
    const nettingExecutionMatch = /^\/v1\/netting\/batches\/([0-9a-f]{64})\/execute$/.exec(path);
    if (![
      "/v1/orders/validate",
      "/v1/routes/replay-decision",
      "/v1/routes/compare",
      "/v1/portfolio/optimize",
      "/v1/clearing/simulate",
      "/v1/netting/simulate",
      "/v1/package-book/orders/prepare",
      "/v1/package-book/orders",
      "/v1/package-book/orders/authorization",
      "/v1/package-book/reopening/orders",
      "/v1/package-book/reopening/orders/authorization",
      "/v1/package-book/amendments",
      "/v1/package-book/amendments/authorization",
      "/v1/package-book/cancellations",
      "/v1/package-book/cancellations/authorization",
      "/v1/de-risk/validate",
      "/v1/packages/compile",
      "/v1/packages/simulate",
      "/v1/strategy-orders/validate",
      "/v1/strategy-orders",
      "/v1/strategy-quotes/request",
      "/v1/package-book/settlement-quotes/request",
      "/v1/strategy-routes/compile",
      "/v1/strategy-quotes/admit",
      "/v1/strategy-packages/submit",
      "/v1/rfqs/private",
      "/v1/auctions/sealed",
      "/v1/orders",
      "/v1/position-snapshots",
      "/v1/collateral-snapshots",
      "/v1/health-snapshots",
      "/v1/recovery/approvals",
      "/v1/strategies/commands",
      "/v1/strategies/commands/authorization",
      "/v1/strategies/open/prepare",
      "/v1/strategies/transitions/prepare",
      "/v1/builders",
      "/v1/builders/attributions",
    ].includes(path) && sealedAuctionAwardMatch === null && privateRfqAcceptanceMatch === null
      && nettingExecutionMatch === null) {
      throw new RequestError(404, "NOT_FOUND", "Unknown public route.");
    }
    const body = object(await readProtocolBody(
      request,
      path === '/v1/portfolio/optimize' ? MAX_PORTFOLIO_OPTIMIZATION_BODY_BYTES : MAX_BODY_BYTES,
    ), "Request body");
    if (path === '/v1/portfolio/optimize') {
      const keys = Object.keys(body).sort();
      if (keys.length !== 3 || keys[0] !== 'candidates' || keys[1] !== 'policy' || keys[2] !== 'strategyAccount') {
        throw new RequestError(400, 'INVALID_REQUEST', 'Request must contain only candidates, policy, and strategyAccount.');
      }
      try {
        return await requirePortfolioOptimization().optimize(body as unknown as AuthoritativePortfolioOptimizationRequest);
      } catch (error) {
        if (error instanceof AuthoritativePortfolioOptimizationError) {
          const status = error.code === "INVALID_REQUEST" ? 400 : 409;
          throw new RequestError(status, error.code, error.message);
        }
        if (error instanceof PortfolioOptimizationClientError) {
          const status = error.code === 'INVALID_REQUEST' ? 400
            : error.code === 'NO_ELIGIBLE_CANDIDATE' ? 409 : 502;
          throw new RequestError(status, error.code, error.message);
        }
        throw error;
      }
    }
    if (nettingExecutionMatch !== null) {
      if (Object.keys(body).length !== 0) {
        throw new RequestError(400, "INVALID_REQUEST", "A netting execution request has no caller-selected fields.");
      }
      const proofHash = nettingExecutionMatch[1] as string;
      if (exchange.nettingBatch(proofHash) === undefined) {
        throw new RequestError(404, "NETTING_BATCH_NOT_FOUND", "No prepared netting batch exists for this proof hash.");
      }
      try {
        return await requireNettingExecution().execute(proofHash);
      } catch (error) {
        if (error instanceof HyperliquidNettingResidualExecutionClientError
          || error instanceof BaseSepoliaNettingResidualExecutionClientError
          || error instanceof SolanaDevnetNettingResidualExecutionClientError) {
          if (error.code === "EVIDENCE_PENDING") {
            throw new RequestError(409, "NETTING_EVIDENCE_PENDING", error.message);
          }
          throw new RequestError(502, "NETTING_EXECUTION_FAILED", error.message);
        }
        throw error;
      }
    }
    if (privateRfqAcceptanceMatch !== null) {
      if (Object.keys(body).length !== 0) {
        throw new RequestError(400, "INVALID_REQUEST", "A private RFQ acceptance request has no caller-selected fields.");
      }
      const envelopeHash = privateRfqAcceptanceMatch[1] as string;
      const stored = requireDelivery().getEnvelope(envelopeHash);
      if (stored === undefined) throw new RequestError(404, "PRIVATE_RFQ_NOT_FOUND", "No such private RFQ envelope.");
      if (stored.response === undefined) {
        throw new RequestError(409, "PRIVATE_RFQ_RESPONSE_PENDING", "The addressed solver has not returned an encrypted quote.");
      }
      const responseMetadata = object(stored.response.response, "Private RFQ response metadata");
      const quoteHash = toHex(commitmentHash(responseMetadata.quoteHash as Uint8Array | string, "privateRfq.response.quoteHash"));
      const orderHash = toHex(commitmentHash(responseMetadata.quoteOrderHash as Uint8Array | string, "privateRfq.response.quoteOrderHash"));
      const envelopeOrderHash = toHex(stored.envelope.orderHash);
      if (orderHash !== envelopeOrderHash) {
        throw new RequestError(409, "PRIVATE_RFQ_RESPONSE_MISMATCH", "The encrypted response names another strategy order.");
      }
      const quote = await requestAndStoreStrategyQuote(
        orderHash,
        `private-rfq.${envelopeHash}`,
        undefined,
        undefined,
        {
          environment: stored.envelope.environment,
          orderHash,
          solverId: stored.envelope.recipientSolverId,
          quoteHash,
        },
      );
      return Object.freeze({
        ...quote,
        envelopeHash,
        privateRfqResponseHash: stored.response.responseHashHex,
        responseSolverId: stored.envelope.recipientSolverId,
      });
    }
    if (sealedAuctionAwardMatch !== null) {
      if (Object.keys(body).length !== 0) {
        throw new RequestError(400, "INVALID_REQUEST", "A sealed auction award request has no caller-selected fields.");
      }
      const auctionHash = sealedAuctionAwardMatch[1] as string;
      const deliveryStore = requireDelivery();
      const definition = deliveryStore.auctionDefinition(auctionHash);
      const now = wallClockIn(definition.timeUnit);
      const view = deliveryStore.auctionView(auctionHash, now);
      if (view.phase !== "CLOSED") {
        throw new RequestError(409, "AUCTION_NOT_CLOSED", "The sealed auction has not closed.");
      }
      if (view.result.outcome !== "AWARDED" || view.result.winner === undefined) {
        throw new RequestError(409, "AUCTION_NO_FILL", "The sealed auction produced no executable award.");
      }
      if (now >= definition.settlementDeadlineValue) {
        throw new RequestError(409, "AUCTION_SETTLEMENT_CLOSED", "The sealed auction settlement window has closed.");
      }
      const winner = view.result.winner;
      const quote = await requestAndStoreStrategyQuote(
        toHex(definition.orderHash),
        `sealed-auction.${auctionHash}`,
        undefined,
        {
          environment: definition.environment,
          solverId: winner.solverId,
          quoteHash: toHex(winner.quoteHash),
          netOutcomeAtoms: winner.netOutcomeAtoms,
          timeUnit: definition.timeUnit,
          settlementDeadlineValue: definition.settlementDeadlineValue,
        },
      );
      return Object.freeze({
        ...quote,
        auctionHash,
        auctionResultHash: toHex(view.result.resultHash),
        awardSolverId: winner.solverId,
      });
    }
    if (path === "/v1/package-book/orders/prepare") {
      const keys = Object.keys(body).sort();
      if (keys.length !== 3 || keys[0] !== "limitPriceTicks" || keys[1] !== "side" || keys[2] !== "strategyOrderHash"
        || typeof body.strategyOrderHash !== "string" || !HASH_HEX.test(body.strategyOrderHash)
        || (body.side !== "BID" && body.side !== "ASK")
        || typeof body.limitPriceTicks !== "string" || !/^-?(?:0|[1-9][0-9]{0,38})$/.test(body.limitPriceTicks)) {
        throw new RequestError(400, "INVALID_REQUEST", "Request must contain a strategyOrderHash, BID or ASK side, and signed integer limitPriceTicks.");
      }
      const strategyStore = requireStrategyPackages();
      if (strategyStore.order === undefined) {
        throw new RequestError(503, "SETTLEMENT_UNAVAILABLE", "Stored strategy order lookup is unavailable.");
      }
      const storedStrategy = strategyStore.order(body.strategyOrderHash);
      if (storedStrategy === undefined) {
        throw new RequestError(404, "STRATEGY_ORDER_NOT_FOUND", "No admitted strategy order has this hash.");
      }
      const strategy = storedStrategy.order;
      if (strategy.environment !== "local" && strategy.environment !== "testnet") {
        throw new RequestError(409, "UNSUPPORTED_ENVIRONMENT", "Package-book order preparation is limited to local and testnet strategy orders.");
      }
      const draft: PackageTakerOrderInput = {
        orderId: "00".repeat(32),
        executionClassId: strategy.executionClassId,
        side: body.side,
        orderType: strategy.packageOrderType,
        timeInForce: strategy.packageTimeInForce,
        limitPriceTicks: BigInt(body.limitPriceTicks),
        quantity: strategy.economicQuantity.atoms,
        minimumQuantity: strategy.economicQuantity.atoms,
        participantId: strategy.owner,
        commonControlGroupId: strategy.owner,
        ...(strategy.packageTimeInForce === "GTD" ? { expiresAtValue: strategy.expiryValue } : {}),
        ...(strategy.packageTimeInForce === "GTC" ? { settlementLeaseUntilValue: strategy.expiryValue } : {}),
      };
      const packageOrderId = toHex(packageTakerOrderHash(draft));
      const order = { ...draft, orderId: packageOrderId };
      const settlementCommitment = packageSettlementCommitment({
        version: 1,
        environment: strategy.environment,
        executionClassId: strategy.executionClassId,
        packageOrderId,
        strategyOrderHash: body.strategyOrderHash,
        graphHash: strategy.graphHash,
        participantId: strategy.owner,
        settlementAccount: strategy.settlementAccount,
        quantity: strategy.economicQuantity.atoms,
        validUntilUnit: strategy.expiryUnit,
        validUntilValue: strategy.expiryValue,
      });
      return {
        version: 1,
        status: "READY_FOR_OWNER_AUTHORIZATION",
        strategyOrderHash: body.strategyOrderHash,
        packageOrderId,
        order,
        settlementCommitment,
        settlementCommitmentHash: toHex(packageSettlementCommitmentHash(settlementCommitment)),
      };
    }
    if (path === "/v1/package-book/amendments" || path === "/v1/package-book/amendments/authorization") {
      const amendment = packageBookAmendment(
        object(body.amendment, "amendment") as unknown as PackageBookAmendmentInput,
      );
      const amendmentHash = toHex(packageBookAmendmentHash(amendment));
      const participantKey = senderPublicKey(amendment.participantId);
      if (path.endsWith("/authorization")) {
        if (isEvmPackageBookParticipant(amendment.participantId)) {
          return {
            version: 1,
            scheme: "EIP712_SECP256K1",
            participantId: amendment.participantId,
            amendmentHash,
            typedData: packageAmendmentAuthorizationTypedData(amendment),
          };
        }
        if (participantKey === undefined) {
          throw new RequestError(400, "UNSUPPORTED_AUTHORIZATION", "The package participant has no supported wallet authorization.");
        }
        return {
          version: 1,
          scheme: "ED25519",
          participantId: amendment.participantId,
          amendmentHash,
          messageHex: toHex(packageBookAmendmentBytes(amendment)),
        };
      }
      const authorization = object(body.authorization, "authorization");
      const ed25519Authorization = ed25519Signature(authorization.signature);
      const valid = authorization.scheme === "ED25519"
        ? participantKey !== undefined
          && ed25519Authorization !== undefined
          && verifyEd25519(participantKey, packageBookAmendmentBytes(amendment), ed25519Authorization)
        : authorization.scheme === "EIP712_SECP256K1"
          && await verifyEvmPackageAmendmentAuthorization(amendment, authorization.signature);
      if (!valid) {
        throw new RequestError(400, "INVALID_SIGNATURE", "The signature does not authorize this package book amendment.");
      }
      const result = exchange.amendEntry(amendment);
      if (result.amendmentHashHex !== amendmentHash) {
        throw new RequestError(500, "INTERNAL_ERROR", "Stored amendment identity is inconsistent.");
      }
      return {
        amended: true,
        packageMarketId: amendment.executionClassId,
        entryId: toHex(amendment.entryId),
        amendmentHash,
        replayed: result.replayed,
        entry: result.entry,
      };
    }
    if (path === "/v1/package-book/cancellations" || path === "/v1/package-book/cancellations/authorization") {
      const cancellation = packageBookCancellation(
        object(body.cancellation, "cancellation") as unknown as PackageBookCancellationInput,
      );
      if (path.endsWith("/authorization")) {
        const participantKey = senderPublicKey(cancellation.participantId);
        if (isEvmPackageBookParticipant(cancellation.participantId)) {
          return {
            version: 1,
            scheme: "EIP712_SECP256K1",
            participantId: cancellation.participantId,
            cancellationHash: toHex(packageBookCancellationHash(cancellation)),
            typedData: packageCancellationAuthorizationTypedData(cancellation),
          };
        }
        if (participantKey === undefined) {
          throw new RequestError(400, "UNSUPPORTED_AUTHORIZATION", "The package participant has no supported wallet authorization.");
        }
        return {
          version: 1,
          scheme: "ED25519",
          participantId: cancellation.participantId,
          cancellationHash: toHex(packageBookCancellationHash(cancellation)),
          messageHex: toHex(packageBookCancellationBytes(cancellation)),
        };
      }
      const authorization = object(body.authorization, "authorization");
      const participantKey = senderPublicKey(cancellation.participantId);
      const ed25519Authorization = ed25519Signature(authorization.signature);
      const valid = authorization.scheme === "ED25519"
        ? participantKey !== undefined
          && ed25519Authorization !== undefined
          && verifyEd25519(participantKey, packageBookCancellationBytes(cancellation), ed25519Authorization)
        : authorization.scheme === "EIP712_SECP256K1"
          && await verifyEvmPackageCancellationAuthorization(cancellation, authorization.signature);
      if (!valid) {
        throw new RequestError(400, "INVALID_SIGNATURE", "The signature does not authorize this package book cancellation.");
      }
      const result = exchange.cancelEntry(
        cancellation.executionClassId,
        cancellation.entryId,
        cancellation.participantId,
      );
      const cancellationHash = toHex(packageBookCancellationHash(cancellation));
      if (result.cancellationHashHex !== cancellationHash) {
        throw new RequestError(500, "INTERNAL_ERROR", "Stored cancellation identity is inconsistent.");
      }
      return {
        cancelled: true,
        packageMarketId: cancellation.executionClassId,
        entryId: toHex(cancellation.entryId),
        cancellationHash,
        replayed: result.replayed,
      };
    }
    const reopeningOrderPath = path === "/v1/package-book/reopening/orders"
      || path === "/v1/package-book/reopening/orders/authorization";
    if (reopeningOrderPath || path === "/v1/package-book/orders" || path === "/v1/package-book/orders/authorization") {
      const order = object(body.order, "order") as unknown as PackageTakerOrderInput;
      const orderHash = packageTakerOrderHash(order);
      if (!bytesEqual(commitmentHash(order.orderId, "order.orderId"), orderHash)) {
        throw new RequestError(400, "INVALID_ORDER_ID", "Package book order id must equal its canonical order hash.");
      }
      const participantKey = senderPublicKey(order.participantId);
      const evmParticipant = isEvmPackageBookParticipant(order.participantId);
      if ((!evmParticipant && participantKey === undefined) || order.commonControlGroupId !== order.participantId) {
        throw new RequestError(
          400,
          "UNSUPPORTED_AUTHORIZATION",
          "Public package book participants use their canonical wallet identity as both participant and control-group id.",
        );
      }
      const commitment = packageSettlementCommitment(
        object(body.settlementCommitment, "settlementCommitment") as unknown as PackageSettlementCommitmentInput,
      );
      if (
        commitment.executionClassId !== order.executionClassId
        || !bytesEqual(commitment.packageOrderId, orderHash)
        || commitment.participantId !== order.participantId
        || commitment.quantity !== order.quantity
      ) {
        throw new RequestError(
          400,
          "SETTLEMENT_MISMATCH",
          "The settlement commitment does not bind the canonical package-book order.",
        );
      }
      const strategyStore = requireStrategyPackages();
      if (strategyStore.order === undefined) {
        throw new RequestError(503, "SETTLEMENT_UNAVAILABLE", "Stored strategy order lookup is unavailable.");
      }
      const storedStrategy = strategyStore.order(toHex(commitment.strategyOrderHash));
      if (storedStrategy === undefined) {
        throw new RequestError(404, "STRATEGY_ORDER_NOT_FOUND", "The settlement commitment binds no admitted strategy order.");
      }
      const strategy = storedStrategy.order;
      if (
        strategy.environment !== commitment.environment
        || strategy.executionClassId !== commitment.executionClassId
        || !bytesEqual(strategy.graphHash, commitment.graphHash)
        || strategy.owner !== commitment.participantId
        || strategy.settlementAccount !== commitment.settlementAccount
        || strategy.economicQuantity.atoms !== commitment.quantity
        || strategy.packageOrderType !== order.orderType
        || strategy.packageTimeInForce !== order.timeInForce
        || strategy.expiryUnit !== commitment.validUntilUnit
        || strategy.expiryValue !== commitment.validUntilValue
      ) {
        throw new RequestError(
          400,
          "SETTLEMENT_MISMATCH",
          "The package-book settlement commitment differs from its admitted strategy order.",
        );
      }
      if (path.endsWith("/authorization")) {
        if (evmParticipant) {
          return {
            version: 1,
            scheme: "EIP712_SECP256K1",
            participantId: commitment.participantId,
            packageOrderId: toHex(orderHash),
            settlementCommitmentHash: toHex(packageSettlementCommitmentHash(commitment)),
            typedData: packageSettlementAuthorizationTypedData(commitment),
          };
        }
        if (participantKey === undefined) {
          throw new RequestError(400, "UNSUPPORTED_AUTHORIZATION", "The package participant has no supported wallet authorization.");
        }
        return {
          version: 1,
          scheme: "ED25519",
          participantId: commitment.participantId,
          packageOrderId: toHex(orderHash),
          settlementCommitmentHash: toHex(packageSettlementCommitmentHash(commitment)),
          messageHex: toHex(packageSettlementCommitmentBytes(commitment)),
        };
      }
      const authorization = object(body.authorization, "authorization");
      const signature = ed25519Signature(authorization.signature);
      const valid = authorization.scheme === "ED25519"
        ? participantKey !== undefined
          && signature !== undefined
          && verifyEd25519(participantKey, packageSettlementCommitmentBytes(commitment), signature)
        : authorization.scheme === "EIP712_SECP256K1"
          && await verifyEvmPackageSettlementAuthorization(commitment, authorization.signature);
      if (!valid) {
        throw new RequestError(400, "INVALID_SIGNATURE", "The signature does not authorize the package settlement commitment.");
      }
      const settlementAuthorization = authorization.scheme === "ED25519"
        ? { scheme: "ED25519" as const, signature: authorization.signature as string }
        : { scheme: "EIP712_SECP256K1" as const, signature: (authorization.signature as string).toLowerCase() };
      const executionClassId = id(order.executionClassId, "executionClassId");
      if (strategyStore.lockPackageExecution === undefined) {
        throw new RequestError(503, "EXECUTION_BINDING_STORE_UNAVAILABLE", "Durable package execution locking is unavailable.");
      }
      strategyStore.lockPackageExecution(toHex(commitment.strategyOrderHash), orderHash);
      if (reopeningOrderPath) {
        const result = exchange.queueReopeningOrder(executionClassId, order, nowValue(), commitment, settlementAuthorization);
        return {
          accepted: true,
          queuedForReopening: true,
          packageMarketId: executionClassId,
          orderId: toHex(orderHash),
          replayed: result.replayed,
          entry: result.entry,
          settlementCommitmentHash: result.settlementCommitmentHashHex,
        };
      }
      const result = exchange.submitOrder(executionClassId, order, nowValue(), commitment, settlementAuthorization);
      if (!result.accepted) return { accepted: false, packageMarketId: executionClassId, orderId: toHex(orderHash), rejection: result.rejection };
      const matchingPolicy = exchange.getMatchingPolicy(result.allocation.matchingPolicyHash);
      if (matchingPolicy === undefined) throw new RequestError(500, "INTERNAL_ERROR", "Book policy is unavailable.");
      return {
        accepted: true,
        packageMarketId: executionClassId,
        orderId: toHex(orderHash),
        replayed: result.replayed,
        allocation: result.allocation,
        allocationHash: result.allocationHashHex,
        settlementCommitmentHash: result.settlementCommitmentHashHex,
        ...(result.settlementHandoff === undefined ? {} : {
          settlementHandoff: result.settlementHandoff,
          settlementHandoffHash: result.settlementHandoffHashHex,
        }),
        matchingPolicy,
      };
    }
    if (path === "/v1/orders") {
      // Intake only: the order is validated and its owner's signature over the exact canonical
      // bytes is verified. Nothing is quoted, reserved, signed, or submitted to any network here.
      const authorization = object(body.authorization, "authorization");
      if (authorization.scheme !== "ED25519") throw new RequestError(400, "UNSUPPORTED_AUTHORIZATION", "Only ED25519 order authorization is accepted here.");
      const order = object(body.order, "order") as unknown as PackageOrderInput;
      const result = requireEvidence().submitOrder(order, authorization.signature as string);
      return { ...result, status: "ACCEPTED_FOR_QUOTING" };
    }
    if (path === "/v1/strategies/open/prepare") {
      if (Object.keys(body).length !== 1 || typeof body.receiptHash !== "string" || !HASH_HEX.test(body.receiptHash)) {
        throw new RequestError(400, "INVALID_REQUEST", "The request must contain one lowercase receiptHash.");
      }
      if (options.strategies === undefined || options.strategyPackages?.order === undefined) {
        throw new RequestError(503, "STRATEGIES_UNAVAILABLE", "Strategy preparation requires the strategy book and package evidence store.");
      }
      const receipt = options.strategyPackages.receipt(body.receiptHash);
      if (receipt === undefined) throw new RequestError(404, "RECEIPT_NOT_FOUND", "No settled strategy receipt has this hash.");
      const checkedReceipt = strategyPackageReceipt(receipt);
      const stored = options.strategyPackages.order(toHex(checkedReceipt.orderHash));
      if (stored === undefined) throw new RequestError(404, "ORDER_NOT_FOUND", "The receipt's committed order is unavailable.");
      return prepareStrategyOpen({
        environment: options.strategies.environmentName(),
        atValue: BigInt(clockMs()),
        receiptHashHex: body.receiptHash,
        order: stored.order,
        graph: stored.graph,
        receipt: checkedReceipt,
      });
    }
    if (path === "/v1/strategies/transitions/prepare") {
      const keys = Object.keys(body).sort();
      if (keys.length !== 2 || keys[0] !== "receiptHash" || keys[1] !== "strategyId"
        || typeof body.receiptHash !== "string" || !HASH_HEX.test(body.receiptHash)
        || typeof body.strategyId !== "string" || !ID.test(body.strategyId)) {
        throw new RequestError(400, "INVALID_REQUEST", "The request must contain one strategyId and one lowercase receiptHash.");
      }
      if (options.strategies === undefined || options.strategyPackages?.order === undefined) {
        throw new RequestError(503, "STRATEGIES_UNAVAILABLE", "Strategy transition preparation requires the strategy book and package evidence store.");
      }
      const storedStrategy = options.strategies.strategy(body.strategyId);
      if (storedStrategy === undefined) throw new RequestError(404, "STRATEGY_NOT_FOUND", "No such strategy exists.");
      if (storedStrategy.retiredByCommandHashHex !== undefined) throw new RequestError(409, "STRATEGY_RETIRED", "The strategy was split or merged away.");
      const receipt = options.strategyPackages.receipt(body.receiptHash);
      if (receipt === undefined) throw new RequestError(404, "RECEIPT_NOT_FOUND", "No settled strategy receipt has this hash.");
      const checkedReceipt = strategyPackageReceipt(receipt);
      const storedOrder = options.strategyPackages.order(toHex(checkedReceipt.orderHash));
      if (storedOrder === undefined) throw new RequestError(404, "ORDER_NOT_FOUND", "The receipt's committed order is unavailable.");
      return prepareStrategyTransition({
        environment: options.strategies.environmentName(),
        atValue: BigInt(clockMs()),
        receiptHashHex: body.receiptHash,
        current: storedStrategy.state,
        order: storedOrder.order,
        graph: storedOrder.graph,
        receipt: checkedReceipt,
      });
    }
    if (path === "/v1/strategies/commands/authorization") {
      const command = object(body.command, "command") as unknown as StrategyCommandInput;
      const commandHash = strategyCommandHash(command);
      if (isEvmStrategyActor(command.actorId)) {
        return {
          version: 1,
          scheme: "EIP712_SECP256K1",
          signerId: command.actorId,
          commandHash: toHex(commandHash),
          typedData: strategyCommandAuthorizationTypedData(command, command.actorId),
        };
      }
      if (senderPublicKey(command.actorId) === undefined) {
        throw new RequestError(400, "UNSUPPORTED_AUTHORIZATION", "The strategy actor has no supported wallet authorization.");
      }
      return {
        version: 1,
        scheme: "ED25519",
        signerId: command.actorId,
        commandHash: toHex(commandHash),
        messageHex: toHex(commandHash),
      };
    }
    if (path === "/v1/strategies/commands") {
      // An owner or delegate's signed strategy command, applied through the kernel lifecycle rules
      // against the exact stored state. A position move is accepted only with the settled receipts
      // that executed it; a novation also needs the new owner's consent over the same hash.
      const authorization = strategyCommandAuthorization(body.authorization, "authorization");
      if (options.strategies === undefined) throw new RequestError(503, "STRATEGIES_UNAVAILABLE", "No strategy book is configured on this server.");
      const rawConsents = body.consents ?? [];
      if (!Array.isArray(rawConsents) || rawConsents.length > 3) throw new RequestError(400, "INVALID_REQUEST", "consents lists at most three wallet signatures.");
      const consents = rawConsents.map((entry) => {
        const consent = object(entry, "consent");
        if (typeof consent.signerId !== "string") throw new RequestError(400, "INVALID_REQUEST", "A consent must name its signer id.");
        return { signerId: consent.signerId, authorization: strategyCommandAuthorization(consent, "consent") };
      });
      const result = await options.strategies.submit(object(body.command, "command") as unknown as StrategyCommandInput, authorization, consents);
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
    if (path === "/v1/strategy-orders/validate") {
      try {
        const order = strategyPackageOrder(object(body.order, "order") as unknown as StrategyPackageOrderInput);
        return { valid: true, order, orderHash: toHex(strategyPackageOrderHash(order)) };
      } catch (error) {
        if (error instanceof ProtocolError) return { valid: false, error: { code: error.code, context: error.context, detail: error.detail } };
        throw error;
      }
    }
    if (path === "/v1/strategy-orders") {
      if (strategyOrderIntake === undefined) {
        throw new RequestError(503, "STRATEGY_ORDER_INTAKE_UNAVAILABLE", "Strategy order intake is not configured on this server.");
      }
      return strategyOrderIntake.store(
        object(body.order, "order") as unknown as StrategyPackageOrderInput,
        object(body.graph, "graph") as unknown as PackageGraphInput,
        body.atSlot as bigint | undefined,
      );
    }
    if (path === "/v1/package-book/settlement-quotes/request") {
      const keys = Object.keys(body).sort();
      if (keys.length !== 2 || keys[0] !== "idempotencyKey" || keys[1] !== "packageOrderId"
        || typeof body.packageOrderId !== "string" || !HASH_HEX.test(body.packageOrderId)
        || typeof body.idempotencyKey !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(body.idempotencyKey)) {
        throw new RequestError(400, "INVALID_REQUEST", "Request must contain a valid packageOrderId and idempotencyKey.");
      }
      const settlement = exchange.settlementProgress(body.packageOrderId);
      if (settlement === undefined) {
        throw new RequestError(404, "SETTLEMENT_NOT_FOUND", "No settlement commitment exists for this package order.");
      }
      if (settlement.readiness.status !== "READY_FOR_OWNER_AUTHORIZATION") {
        throw new RequestError(
          409,
          "SETTLEMENT_NOT_READY",
          `Package settlement status is ${settlement.readiness.status}.`,
        );
      }
      const strategyOrderHash = toHex(settlement.readiness.strategyOrderHash);
      return {
        version: 1,
        packageOrderId: body.packageOrderId,
        settlement,
        strategyQuote: await requestAndStoreStrategyQuote(strategyOrderHash, body.idempotencyKey, {
          packageOrderId: body.packageOrderId,
          settlement,
        }),
      };
    }
    if (path === "/v1/strategy-quotes/request") {
      const keys = Object.keys(body).sort();
      if (keys.length !== 2 || keys[0] !== "idempotencyKey" || keys[1] !== "orderHash"
        || typeof body.orderHash !== "string" || !HASH_HEX.test(body.orderHash)
        || typeof body.idempotencyKey !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(body.idempotencyKey)) {
        throw new RequestError(400, "INVALID_REQUEST", "Request must contain a valid orderHash and idempotencyKey.");
      }
      return requestAndStoreStrategyQuote(body.orderHash, body.idempotencyKey);
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
    if (path === "/v1/netting/simulate") {
      const obligations = body.obligations;
      const policy = body.policy;
      if (!Array.isArray(obligations) || typeof policy !== "object" || policy === null) {
        throw new RequestError(400, "INVALID_REQUEST", "obligations must be an array and policy must be an object.");
      }
      return {
        simulated: true,
        result: netObligations(
          obligations as readonly NettingObligationInput[],
          policy as NettingPolicyManifestInput,
        ),
      };
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
    if (path === "/v1/strategy-routes/compile") {
      const context = options.graphContext;
      if (context === undefined) throw new RequestError(503, "GRAPH_CONTEXT_UNAVAILABLE", "No graph compilation context is configured on this server.");
      const input = object(body.graph, "graph") as unknown as PackageGraphInput;
      const graph = packageGraph(input);
      requireStrategyMarket(graph);
      const template = requireRegistry().latest<PackageTemplateManifestInput>("PACKAGE_TEMPLATE", graph.templateId, graph.templateVersion);
      if (template === undefined) throw new RequestError(404, "TEMPLATE_NOT_FOUND", "The graph binds no registered package template.");
      const current = nowIn(graph.expiryUnit);
      const currentTime = current === undefined
        ? { unit: graph.expiryUnit, value: body.atSlot as bigint }
        : { unit: graph.expiryUnit, value: current };
      if (typeof currentTime.value !== "bigint" || currentTime.value <= 0n) {
        throw new RequestError(400, "TIME_REQUIRED", "A slot-timed strategy route compiles at an explicit positive atSlot.");
      }
      const result = compileTypedStrategyRoute({
        graph: input,
        compileContext: {
          templateManifest: template.document,
          activeRegistryRecords: context.activeRegistryRecords,
          resourceLimits: context.resourceLimits,
          currentTime,
        },
        adapterSupport: body.adapterSupport as readonly TypedAdapterActionSupportInput[],
        orderHash: body.orderHash as Uint8Array | string,
        solverId: body.solverId as string,
        routeExpiryUnit: graph.expiryUnit,
        routeExpiryValue: body.routeExpiryValue as bigint,
      });
      return { ...result, currentTime, timeSource: current === undefined ? "CALLER" : "SERVER" };
    }
    if (path === "/v1/strategy-quotes/admit" || path === "/v1/strategy-packages/submit") {
      const context = options.graphContext;
      if (context === undefined) throw new RequestError(503, "GRAPH_CONTEXT_UNAVAILABLE", "No graph compilation context is configured on this server.");
      const graphInput = object(body.graph, "graph") as unknown as PackageGraphInput;
      const graph = packageGraph(graphInput);
      const series = requireStrategyMarket(graph);
      const template = requireRegistry().latest<PackageTemplateManifestInput>("PACKAGE_TEMPLATE", graph.templateId, graph.templateVersion);
      if (template === undefined) throw new RequestError(404, "TEMPLATE_NOT_FOUND", "The graph binds no registered package template.");
      const current = nowIn(graph.expiryUnit);
      const currentTime = current === undefined
        ? { unit: graph.expiryUnit, value: body.atSlot as bigint }
        : { unit: graph.expiryUnit, value: current };
      if (typeof currentTime.value !== "bigint" || currentTime.value <= 0n) {
        throw new RequestError(400, "TIME_REQUIRED", "A slot-timed strategy quote is admitted at an explicit positive atSlot.");
      }
      const admitted = validateStrategyPackageRouteAdmission(
        object(body.order, "order") as unknown as StrategyPackageOrderInput,
        graphInput,
        object(body.quote, "quote") as unknown as StrategyPackageQuoteInput,
        object(body.route, "route") as unknown as TypedStrategyRoute,
        {
          templateManifest: template.document,
          activeRegistryRecords: context.activeRegistryRecords,
          resourceLimits: context.resourceLimits,
          currentTime,
        },
      );
      if (admitted.order.quoteAsset.assetId !== series.quoteAsset) {
        throw new RequestError(400, "SERIES_MISMATCH", "The order quote asset differs from the registered strategy series.");
      }
      if (currentTime.value >= admitted.quote.validUntilValue) throw new RequestError(400, "QUOTE_EXPIRED", "The strategy quote has expired.");
      const capability = requireRegistry().latest<SolverCapabilityManifestInput>("SOLVER_CAPABILITY", admitted.quote.solverId);
      if (capability === undefined || !bytesEqual(solverCapabilityManifestHash(capability.document), admitted.quote.solverCapabilityManifestHash)) {
        throw new RequestError(400, "SOLVER_CAPABILITY_MISMATCH", "The quote does not bind the registered solver capability.");
      }
      if (capability.document.validityUnit !== admitted.quote.validUntilUnit) {
        throw new RequestError(400, "SOLVER_CAPABILITY_MISMATCH", "The solver capability and strategy quote use different clocks.");
      }
      for (const domain of admitted.quote.domains) {
        const authorization = authorizeSolverQuote(capability.document, {
          environment: admitted.quote.environment,
          domain,
          templateId: admitted.quote.templateId,
          quoteMode: admitted.quote.quoteMode,
          marketId: admitted.quote.executionClassId,
          notionalAtoms: admitted.quote.totalGrossNotional.atoms,
          scheme: admitted.quote.solverSignatureScheme,
          verificationKey: admitted.quote.solverVerificationKey,
          atValue: currentTime.value,
        });
        if (!authorization.authorized) throw new RequestError(400, "SOLVER_NOT_AUTHORIZED", `The solver capability rejects this quote: ${authorization.reason}.`);
      }
      if (admitted.quote.solverSignatureScheme !== "ED25519" || !verifyEd25519(admitted.quote.solverVerificationKey, strategyPackageQuoteHash(admitted.quote), admitted.quote.signature)) {
        throw new RequestError(400, "INVALID_SIGNATURE", "The strategy quote signature is invalid.");
      }
      if (path === "/v1/strategy-packages/submit") {
        const store = requireStrategyPackages();
        const storedOrder = store.registerOrder(admitted.order, admitted.graph);
        const storedQuote = store.registerQuote(admitted);
        return {
          admitted,
          storage: {
            orderCreated: storedOrder.created,
            quoteCreated: storedQuote.created,
            orderHashHex: storedOrder.orderHashHex,
            graphHashHex: storedOrder.graphHashHex,
            quoteHashHex: storedQuote.quoteHashHex,
            routeHashHex: storedQuote.routeHashHex,
          },
        };
      }
      return admitted;
    }
    if (path === "/v1/position-snapshots") {
      // A signed read-only observation from a position source. The store verifies the authority
      // signature, the observation time, and ordering; nothing here grants authority over positions.
      return requirePositions().append(object(body.record, "record") as unknown as PositionSnapshotRecordInput);
    }
    if (path === "/v1/collateral-snapshots") {
      return requireCollateral().append(object(body.record, "record") as unknown as CollateralSnapshotInput);
    }
    if (path === "/v1/recovery/approvals") {
      // A named approver's Ed25519 signature over the approval hash; nothing else counts toward quorum.
      const authorization = object(body.authorization, "authorization");
      if (authorization.scheme !== "ED25519" || typeof authorization.signature !== "string") {
        throw new RequestError(400, "UNSUPPORTED_AUTHORIZATION", "Approvals carry an ED25519 signature in base58.");
      }
      let signature: Uint8Array;
      try {
        signature = bs58.decode(authorization.signature);
      } catch {
        throw new RequestError(400, "INVALID_SIGNATURE", "The signature must be base58.");
      }
      const approval = object(body.approval, "approval") as unknown as { actionHash: string; approverId: string; atValue: bigint };
      return requireCoordination().approve(id(typeof body.incidentId === "string" ? body.incidentId : undefined, "Incident id"), approval, signature);
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
        if (error instanceof PackageExchangeStoreError) {
          const status = error.code === "BOOK_NOT_FOUND" ? 404
            : error.code === "INVALID_INPUT" ? 400
              : error.code === "CORRUPT_ROW" ? 500 : 409;
          return fail(response, status, error.code === "INVALID_INPUT" ? "INVALID_REQUEST" : error.code, error.message);
        }
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
        if (error instanceof StrategyOpenPreparationError) {
          const status = error.code.endsWith("NOT_FOUND") ? 404 : error.code === "RECEIPT_NOT_FINAL" ? 409 : 400;
          return fail(response, status, error.code, error.message);
        }
        if (error instanceof CoordinationStoreError) {
          const status = error.code.endsWith("NOT_FOUND") ? 404 : error.code.startsWith("INVALID") || error.code === "NOT_AN_APPROVER" ? 400 : 409;
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
        if (error instanceof CollateralSnapshotStoreError) {
          const status = ["INVALID_RECORD", "INVALID_SIGNATURE", "WRONG_ENVIRONMENT"].includes(error.code) ? 400
            : error.code === "UNKNOWN_AUTHORITY" ? 403
              : error.code === "CORRUPT_ROW" ? 500 : 409;
          return fail(response, status, error.code, error.message);
        }
        if (error instanceof StrategyPackageStoreError) {
          const status = error.code === "CORRUPT_ROW" ? 500 : error.code.endsWith("NOT_FOUND") ? 404 : error.code === "HASH_CONFLICT" ? 409 : 400;
          return fail(response, status, error.code, error.message);
        }
        if (error instanceof NativeClearingStoreError) {
          const status = error.code.endsWith('NOT_FOUND') || error.code === 'MARK_UNAVAILABLE' ? 404
            : error.code === 'CORRUPT_ROW' ? 500
              : error.code === 'INVALID_INPUT' ? 400 : 409;
          return fail(response, status, error.code, error.message);
        }
        if (error instanceof GeneralizedStrategyQuoteClientError) {
          const status = error.code === "INVALID_REQUEST" ? 400
            : error.code === "NOT_FOUND" ? 404
              : error.code === "QUOTE_DECLINED" ? 409 : 502;
          return fail(response, status, error.code, error.message);
        }
        if (error instanceof StrategyOrderIntakeError) {
          return fail(response, error.status, error.code, error.message);
        }
        return fail(response, 500, "INTERNAL_ERROR", "Public request failed.");
      });
    return true;
  };
}
