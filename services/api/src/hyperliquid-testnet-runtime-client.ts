import {
  fromProtocolJson,
  stringifyProtocolJson,
  toHex,
  type DomainRef,
  type PackageOrder,
  type RoutePayload,
  type SolverQuote,
} from "@naryx/protocol-types";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import { verifySolverAtomicQuoteResponse } from "./solver-quote-client.js";

export const HYPERLIQUID_TESTNET_PREPARE_PATH =
  "/internal/solver/hyperliquid-testnet/prepare";
export const HYPERLIQUID_TESTNET_RECONCILE_PATH =
  "/internal/solver/hyperliquid-testnet/reconcile";

const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

export type HyperliquidTestnetAccountBinding = Readonly<{
  masterAccount: `0x${string}`;
  tradingAccount: `0x${string}`;
  accountKind: "MASTER" | "SUBACCOUNT";
}>;

export type HyperliquidTestnetMarketMetadata = Readonly<{
  spot: HyperliquidTestnetMarketLegMetadata & Readonly<{
    universeIndex: number;
    tokenIndex: number;
  }>;
  perpetual: HyperliquidTestnetMarketLegMetadata & Readonly<{
    assetIndex: number;
  }>;
  quoteTokenIndex: number;
}>;

export type HyperliquidTestnetMarketLegMetadata = Readonly<{
  adapterId: string;
  adapterManifestVersion: number;
  adapterManifestHash: string;
  venueId: string;
  venueManifestVersion: number;
  venueManifestHash: string;
  marketId: string;
  marketManifestVersion: number;
  marketManifestHash: string;
  assetId: number;
  sizeDecimals: number;
}>;

export type HyperliquidTestnetExecutionBounds = Readonly<{
  maxEvidenceAgeMs: number;
  maxSnapshotSkewMs: number;
  maxFillPages: number;
}>;

export type HyperliquidTestnetAttemptPreparation = Readonly<{
  attemptId: string;
  orderHash: string;
  quoteHash: string;
  routeHash: string;
  solverId: string;
  solverVerificationKey: string;
  domain: Readonly<{
    domainId: "hypercore:testnet";
    domainManifestVersion: number;
    domainManifestHash: string;
  }>;
  account: HyperliquidTestnetAccountBinding;
  market: HyperliquidTestnetMarketMetadata;
  bounds: HyperliquidTestnetExecutionBounds;
  selectedAtMs: number;
  expiresAtMs: number;
  order: PackageOrder;
  route: RoutePayload;
  quote: SolverQuote;
}>;

export interface HyperliquidTestnetPreparationPort {
  prepare(attemptId: string): HyperliquidTestnetAttemptPreparation;
}

export interface HyperliquidTestnetEvidencePort {
  prepare(input: HyperliquidTestnetAttemptPreparation): Promise<unknown>;
  reconcile(input: unknown): Promise<unknown>;
}

export type HyperliquidTestnetEvidenceRuntime = Readonly<{
  preparation: HyperliquidTestnetPreparationPort;
  evidence: HyperliquidTestnetEvidencePort;
  readiness: Readonly<{
    preparationAvailable: true;
    evidenceReconciliationAvailable: true;
    executionSubmissionAvailable: false;
    executionSubmissionReason: "SOLVER_EXECUTOR_BOUNDARY_NOT_AVAILABLE";
  }>;
}>;

export type HyperliquidTestnetAttemptPreparationOptions = Readonly<{
  intents: Pick<ExecutionIntentStore, "getAttempt" | "getSelectedQuote">;
  orders: Pick<InternalOrderStore, "getByOrderHash" | "getCanonicalOrderByHash">;
  domain: DomainRef;
  solverId: string;
  solverVerificationKey: string;
  account: HyperliquidTestnetAccountBinding;
  market: HyperliquidTestnetMarketMetadata;
  bounds: HyperliquidTestnetExecutionBounds;
  currentTimeMs: () => number;
}>;

export type HyperliquidTestnetEvidenceHttpOptions = Readonly<{
  solverOrigin: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}>;

export class HyperliquidTestnetRuntimeClientError extends Error {
  readonly code: "INVALID_CONFIGURATION" | "ATTEMPT_NOT_FOUND" |
    "ATTEMPT_EVIDENCE_MISSING" | "ATTEMPT_EVIDENCE_MISMATCH" |
    "ATTEMPT_EXPIRED" | "UPSTREAM_REJECTED" | "INVALID_RESPONSE";

  constructor(code: HyperliquidTestnetRuntimeClientError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "HyperliquidTestnetRuntimeClientError";
    this.code = code;
  }
}

function fail(
  code: HyperliquidTestnetRuntimeClientError["code"],
  message: string,
): never {
  throw new HyperliquidTestnetRuntimeClientError(code, message);
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("INVALID_CONFIGURATION", `${name} must be a nonnegative safe integer`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  const checked = requireNonNegativeInteger(value, name);
  if (checked === 0) fail("INVALID_CONFIGURATION", `${name} must be positive`);
  return checked;
}

function accountBinding(value: HyperliquidTestnetAccountBinding): HyperliquidTestnetAccountBinding {
  if (!ADDRESS.test(value.masterAccount) || /^0x0+$/.test(value.masterAccount)
    || !ADDRESS.test(value.tradingAccount) || /^0x0+$/.test(value.tradingAccount)
    || (value.accountKind !== "MASTER" && value.accountKind !== "SUBACCOUNT")
    || (value.accountKind === "MASTER" && value.masterAccount !== value.tradingAccount)
    || (value.accountKind === "SUBACCOUNT" && value.masterAccount === value.tradingAccount)) {
    fail("INVALID_CONFIGURATION", "Hyperliquid account binding is invalid");
  }
  return Object.freeze({ ...value });
}

function marketMetadata(value: HyperliquidTestnetMarketMetadata): HyperliquidTestnetMarketMetadata {
  const leg = (
    candidate: HyperliquidTestnetMarketLegMetadata,
    name: string,
  ): HyperliquidTestnetMarketLegMetadata => {
    const boundedId = (id: unknown, field: string): string => {
      if (typeof id !== "string" || id.length < 1 || id.length > 128) {
        fail("INVALID_CONFIGURATION", `${field} is invalid`);
      }
      return id;
    };
    const hash = (candidateHash: unknown, field: string): string => {
      if (typeof candidateHash !== "string" || !HASH.test(candidateHash) || /^0+$/.test(candidateHash)) {
        fail("INVALID_CONFIGURATION", `${field} must be a nonzero lowercase hash`);
      }
      return candidateHash;
    };
    return Object.freeze({
      adapterId: boundedId(candidate.adapterId, `${name}.adapterId`),
      adapterManifestVersion: requirePositiveInteger(
        candidate.adapterManifestVersion,
        `${name}.adapterManifestVersion`,
      ),
      adapterManifestHash: hash(candidate.adapterManifestHash, `${name}.adapterManifestHash`),
      venueId: boundedId(candidate.venueId, `${name}.venueId`),
      venueManifestVersion: requirePositiveInteger(
        candidate.venueManifestVersion,
        `${name}.venueManifestVersion`,
      ),
      venueManifestHash: hash(candidate.venueManifestHash, `${name}.venueManifestHash`),
      marketId: boundedId(candidate.marketId, `${name}.marketId`),
      marketManifestVersion: requirePositiveInteger(
        candidate.marketManifestVersion,
        `${name}.marketManifestVersion`,
      ),
      marketManifestHash: hash(candidate.marketManifestHash, `${name}.marketManifestHash`),
      assetId: requireNonNegativeInteger(candidate.assetId, `${name}.assetId`),
      sizeDecimals: requireNonNegativeInteger(candidate.sizeDecimals, `${name}.sizeDecimals`),
    });
  };
  const spot = leg(value.spot, "spot");
  const perpetual = leg(value.perpetual, "perpetual");
  if (spot.assetId === perpetual.assetId) {
    fail("INVALID_CONFIGURATION", "spot and perpetual asset indexes must differ");
  }
  return Object.freeze({
    spot: Object.freeze({
      ...spot,
      universeIndex: requireNonNegativeInteger(value.spot.universeIndex, "spot.universeIndex"),
      tokenIndex: requireNonNegativeInteger(value.spot.tokenIndex, "spot.tokenIndex"),
    }),
    perpetual: Object.freeze({
      ...perpetual,
      assetIndex: requireNonNegativeInteger(value.perpetual.assetIndex, "perpetual.assetIndex"),
    }),
    quoteTokenIndex: requireNonNegativeInteger(value.quoteTokenIndex, "quoteTokenIndex"),
  });
}

function executionBounds(value: HyperliquidTestnetExecutionBounds): HyperliquidTestnetExecutionBounds {
  return Object.freeze({
    maxEvidenceAgeMs: requirePositiveInteger(value.maxEvidenceAgeMs, "maxEvidenceAgeMs"),
    maxSnapshotSkewMs: requirePositiveInteger(value.maxSnapshotSkewMs, "maxSnapshotSkewMs"),
    maxFillPages: requirePositiveInteger(value.maxFillPages, "maxFillPages"),
  });
}

function domainBinding(value: DomainRef): HyperliquidTestnetAttemptPreparation["domain"] {
  const hash = toHex(value.domainManifestHash);
  if (value.domainId !== "hypercore:testnet"
    || !Number.isSafeInteger(value.domainManifestVersion) || value.domainManifestVersion < 1
    || !HASH.test(hash) || /^0+$/.test(hash)) {
    fail("INVALID_CONFIGURATION", "domain must be an exact Hyperliquid Testnet manifest reference");
  }
  return Object.freeze({
    domainId: "hypercore:testnet",
    domainManifestVersion: value.domainManifestVersion,
    domainManifestHash: hash,
  });
}

function checkedSolverKey(value: string): string {
  if (!HASH.test(value) || /^0+$/.test(value)) {
    fail("INVALID_CONFIGURATION", "solver verification key must be 32 lowercase hex bytes");
  }
  return value;
}

function matchesLeg(
  leg: RoutePayload["legs"][number] | undefined,
  expected: HyperliquidTestnetMarketLegMetadata,
): boolean {
  return leg !== undefined
    && leg.adapter.adapterId === expected.adapterId
    && leg.adapter.adapterManifestVersion === expected.adapterManifestVersion
    && toHex(leg.adapter.adapterManifestHash) === expected.adapterManifestHash
    && leg.venue.subjectId === expected.venueId
    && leg.venue.manifestVersion === expected.venueManifestVersion
    && toHex(leg.venue.manifestHash) === expected.venueManifestHash
    && leg.market.subjectId === expected.marketId
    && leg.market.manifestVersion === expected.marketManifestVersion
    && toHex(leg.market.manifestHash) === expected.marketManifestHash;
}

export function createHyperliquidTestnetAttemptPreparationPort(
  options: HyperliquidTestnetAttemptPreparationOptions,
): HyperliquidTestnetPreparationPort {
  if (typeof options.currentTimeMs !== "function") {
    fail("INVALID_CONFIGURATION", "a trusted millisecond clock is required");
  }
  const expectedDomain = domainBinding(options.domain);
  if (typeof options.solverId !== "string" || options.solverId.length < 1
    || options.solverId.length > 128) {
    fail("INVALID_CONFIGURATION", "solver ID is invalid");
  }
  const expectedSolverId = options.solverId;
  const expectedSolver = checkedSolverKey(options.solverVerificationKey);
  const account = accountBinding(options.account);
  const market = marketMetadata(options.market);
  const bounds = executionBounds(options.bounds);

  return Object.freeze({
    prepare(attemptId: string): HyperliquidTestnetAttemptPreparation {
      let attempt;
      try {
        attempt = options.intents.getAttempt(attemptId);
      } catch {
        fail("ATTEMPT_NOT_FOUND", "selected execution attempt was not found");
      }
      if (attempt === undefined) {
        fail("ATTEMPT_NOT_FOUND", "selected execution attempt was not found");
      }
      const record = options.orders.getByOrderHash(attempt.orderHash);
      const order = options.orders.getCanonicalOrderByHash(attempt.orderHash);
      const selected = options.intents.getSelectedQuote(attemptId);
      if (record === undefined || order === undefined || selected === undefined) {
        fail("ATTEMPT_EVIDENCE_MISSING", "selected order or quote evidence is missing");
      }
      const currentTimeMs = requirePositiveInteger(options.currentTimeMs(), "currentTimeMs");
      let verified;
      try {
        verified = verifySolverAtomicQuoteResponse(selected, order, BigInt(currentTimeMs));
      } catch {
        fail("ATTEMPT_EVIDENCE_MISMATCH", "selected solver evidence failed verification");
      }
      const orderDomainHash = toHex(order.domain.domainManifestHash);
      const solverKey = toHex(verified.quote.solverVerificationKey);
      const spotLeg = verified.route.legs.find((leg) => leg.legRole === "SPOT");
      const perpetualLeg = verified.route.legs.find((leg) => leg.legRole === "PERPETUAL");
      if (selected.orderHash !== attempt.orderHash
        || selected.quoteHash !== attempt.quoteHash
        || selected.routeHash !== attempt.routeHash
        || record.orderHashHex !== attempt.orderHash
        || record.domainId !== expectedDomain.domainId
        || record.domainManifestVersion !== expectedDomain.domainManifestVersion
        || record.domainManifestHashHex !== expectedDomain.domainManifestHash
        || order.domain.domainId !== expectedDomain.domainId
        || order.domain.domainManifestVersion !== expectedDomain.domainManifestVersion
        || orderDomainHash !== expectedDomain.domainManifestHash
        || verified.route.solver !== expectedSolverId
        || solverKey !== expectedSolver
        || !matchesLeg(spotLeg, market.spot)
        || !matchesLeg(perpetualLeg, market.perpetual)) {
        fail("ATTEMPT_EVIDENCE_MISMATCH", "selected attempt bindings are inconsistent");
      }
      const expiresAt = verified.quote.validUntilValue;
      if (expiresAt > BigInt(Number.MAX_SAFE_INTEGER) || expiresAt <= BigInt(currentTimeMs)) {
        fail("ATTEMPT_EXPIRED", "selected Hyperliquid quote is expired or has an unsafe expiry");
      }
      return Object.freeze({
        attemptId,
        orderHash: attempt.orderHash,
        quoteHash: attempt.quoteHash,
        routeHash: attempt.routeHash,
        solverId: expectedSolverId,
        solverVerificationKey: expectedSolver,
        domain: expectedDomain,
        account,
        market,
        bounds,
        selectedAtMs: attempt.selectedAtMs,
        expiresAtMs: Number(expiresAt),
        order,
        route: verified.route,
        quote: verified.quote,
      });
    },
  });
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const parsed = Number(octet);
    return parsed >= 0 && parsed <= 255;
  });
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("INVALID_CONFIGURATION", "solver origin must be an absolute URL");
  }
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)
    || url.username !== "" || url.password !== "" || url.pathname !== "/"
    || url.search !== "" || url.hash !== "") {
    fail("INVALID_CONFIGURATION", "solver origin must be a loopback HTTP origin");
  }
  return url.origin;
}

function timeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    fail("INVALID_CONFIGURATION", "solver timeout must be a bounded positive integer");
  }
  return timeoutMs;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const lengthHeader = response.headers.get("content-length");
  if (contentType !== "application/json" || response.body === null
    || (lengthHeader !== null && (!/^\d+$/.test(lengthHeader)
      || Number(lengthHeader) > MAX_RESPONSE_BYTES))) {
    fail("INVALID_RESPONSE", "solver response is invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail("INVALID_RESPONSE", "solver response is too large");
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return fromProtocolJson(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      "hyperliquidTestnet.solverResponse",
    );
  } catch {
    fail("INVALID_RESPONSE", "solver response is not strict protocol JSON");
  }
}

export class HttpHyperliquidTestnetEvidenceClient implements HyperliquidTestnetEvidencePort {
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HyperliquidTestnetEvidenceHttpOptions) {
    this.#origin = loopbackOrigin(options.solverOrigin);
    this.#timeoutMs = timeout(options.timeoutMs);
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async #post(path: string, value: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stringifyProtocolJson(value, "hyperliquidTestnet.solverRequest"),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      fail("UPSTREAM_REJECTED", "solver evidence request failed");
    }
    if (!response.ok) {
      fail("UPSTREAM_REJECTED", `solver evidence request failed with HTTP ${response.status}`);
    }
    return readBoundedJson(response);
  }

  prepare(input: HyperliquidTestnetAttemptPreparation): Promise<unknown> {
    return this.#post(HYPERLIQUID_TESTNET_PREPARE_PATH, input);
  }

  reconcile(input: unknown): Promise<unknown> {
    return this.#post(HYPERLIQUID_TESTNET_RECONCILE_PATH, input);
  }
}

export function createHyperliquidTestnetEvidenceRuntime(
  preparationOptions: HyperliquidTestnetAttemptPreparationOptions,
  httpOptions: HyperliquidTestnetEvidenceHttpOptions,
): HyperliquidTestnetEvidenceRuntime {
  return Object.freeze({
    preparation: createHyperliquidTestnetAttemptPreparationPort(preparationOptions),
    evidence: new HttpHyperliquidTestnetEvidenceClient(httpOptions),
    readiness: Object.freeze({
      preparationAvailable: true as const,
      evidenceReconciliationAvailable: true as const,
      executionSubmissionAvailable: false as const,
      executionSubmissionReason: "SOLVER_EXECUTOR_BOUNDARY_NOT_AVAILABLE" as const,
    }),
  });
}
