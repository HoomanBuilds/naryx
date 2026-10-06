import {
  listOwnerPackages,
  OwnerPackageQueryError,
  parseOwnerPackageQuery,
  type OwnerPackageOutcomeReader,
} from "./terminal-packages.js";
import { forwardedByProxy } from "./internal-http.js";
import { isAllowedTerminalOrigin, parseTerminalOrigins, type TerminalOrigins } from "./terminal-origin.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { toProtocolJson } from "@naryx/protocol-types";
import { EntryOrderValidationError } from "./canonical-entry-order.js";
import { InternalOrderConflictError } from "./internal-order-store.js";
import {
  executionSelectionKind,
  ExecutionIntentStoreError,
  type ExecutionIntentStore,
} from "./execution-intent-store.js";
import {
  LocalExecutionCoordinatorError,
  type LocalExecutionCoordinator,
} from "./local-execution-coordinator.js";
import {
  HyperliquidTestnetTerminalValidationError,
  parseHyperliquidTestnetTerminalExecutionRequest,
  validateHyperliquidTestnetTerminalExecutionResult,
  type HyperliquidTestnetTerminalExecutionPort,
} from "./hyperliquid-testnet-terminal.js";
import {
  EvmTestnetTerminalValidationError,
  parseEvmTestnetPrepareAtomicAuthorizationRequest,
  parseEvmTestnetObserveAsyncRequest,
  parseEvmTestnetObserveAtomicRequest,
  parseEvmTestnetPrepareAtomicRequest,
  validateEvmTestnetAsyncObservation,
  validateEvmTestnetAtomicAuthorization,
  validateEvmTestnetAtomicObservation,
  validateEvmTestnetAtomicPreparation,
  type EvmTestnetTerminalPorts,
} from "./evm-testnet-runtime-ports.js";
import {
  ExecutionValidationError,
  parseExecutionObservationRequest,
  parseExecutionPreparationRequest,
  validateExecutionObservation,
  validateUnsignedSolanaDevnetMaterialization,
  type PrivateTerminalExecutionPorts,
} from "./terminal-execution.js";
import {
  InternalOrderCoordinator,
  TerminalOrderValidationError,
  type InternalOrderPorts,
} from "./terminal-orders.js";
import {
  LifecycleQueryValidationError,
  parseLifecycleQuery,
  serializeLifecycleResponse,
} from "./package-lifecycle-read.js";
import type { PackageLifecycleStore } from "./package-lifecycle-store.js";
import {
  createTerminalPreview,
  observedMarket,
  parsePreviewRequest,
  PreviewValidationError,
  TerminalMarketUnavailableError,
  type TerminalMarketContext,
} from "./terminal-preview.js";
import { createTerminalSnapshot } from "./terminal-snapshot.js";
import type { TerminalMarketSources } from "./private-terminal-manifest.js";
import { isDomainId, type DomainId } from "./terminal-types.js";
import {
  parseSolverAtomicQuoteRequest,
  SolverQuoteClientError,
  type SolverAtomicQuotePort,
} from "./solver-quote-client.js";
import type { LocalAtomicRuntimeMode, PrivateTerminalRuntimeHealth } from "./runtime-composition.js";
import type { SolanaLocalExecutionService } from "./solana-local-execution.js";
import {
  HyperliquidTestnetRuntimeClientError,
  type HyperliquidTestnetPreparationPort,
  type HyperliquidTestnetRuntimeConfig,
} from "./hyperliquid-testnet-runtime-client.js";
import type { HyperliquidTestnetTerminalContext } from "./hyperliquid-testnet-order-context.js";
import {
  ExecutionReadinessError,
  type ExecutionHandoff,
  type ExecutionReadinessGate,
  type ExecutionReadinessScopeIdentity,
  type ExecutionReadinessScopeResolver,
} from "./execution-readiness-gate.js";
import {
  strategyProgramView,
  type StrategyExecutionLaneCapability,
} from "./strategy-program-view.js";
import {
  StrategyPreparationClientError,
  type GeneralizedStrategyPreparationPort,
} from "./strategy-preparation-client.js";
import {
  HyperliquidGeneralizedOrderError,
  type HyperliquidGeneralizedOrderPort,
} from "./hyperliquid-generalized-order.js";
import {
  StrategyPackageStoreError,
  type AnySelectedStrategyPackageAttempt,
  type SelectedNativeStrategyPackageAttempt,
  type SelectedStrategyPackageAttempt,
  type SelectNativeHyperliquidStrategyExecutionRequest,
  type SelectHyperliquidStrategyExecutionRequest,
  type StoredNativeStrategyPosition,
} from "./strategy-package-store.js";
import { StrategyOrderIntakeError } from "./strategy-order-intake.js";
import {
  StrategyPackageAuthorizationError,
  type StrategyPackageAuthorizationPort,
} from "./strategy-package-authorization.js";
import {
  HyperliquidNativeStrategyOrderError,
  type HyperliquidNativeStrategyOrderPort,
} from "./hyperliquid-native-strategy-order.js";
import {
  EvmOptionSpreadOrderError,
  type EvmOptionSpreadOrderPort,
} from "./evm-option-spread-order.js";

const MAX_BODY_BYTES = 4_096;

export type PrivateTerminalServerConfig = {
  host: string;
  port: number;
  terminalOrigin: TerminalOrigins;
};

interface GeneralizedStrategyExecutionPort {
  selectHyperliquidExecution(request: SelectHyperliquidStrategyExecutionRequest): SelectedStrategyPackageAttempt;
  selectNativeHyperliquidExecution(request: SelectNativeHyperliquidStrategyExecutionRequest): SelectedNativeStrategyPackageAttempt;
  strategyExecutionAttempt(attemptId: string): SelectedStrategyPackageAttempt | undefined;
  nativeStrategyExecutionAttempt(attemptId: string): SelectedNativeStrategyPackageAttempt | undefined;
  anyStrategyExecutionAttempt(attemptId: string): AnySelectedStrategyPackageAttempt | undefined;
  nativeStrategyPositionsByOwner?(owner: string): readonly StoredNativeStrategyPosition[];
}

type NativeHyperliquidStrategyRuntime = Pick<
  HyperliquidTestnetRuntimeConfig,
  "domain" | "seriesManifestHash" | "executionClassManifestHash" | "market" | "bounds"
> & Readonly<{
  baseAsset: NonNullable<HyperliquidTestnetRuntimeConfig["orderContext"]>["baseAsset"];
  quoteAsset: NonNullable<HyperliquidTestnetRuntimeConfig["orderContext"]>["quoteAsset"];
}>;

export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function isLoopbackPeer(address: string | undefined): boolean {
  if (address === "::1") return true;
  const host = address?.startsWith("::ffff:") === true ? address.slice(7) : address;
  return host !== undefined && isLoopbackHost(host);
}

/** A direct loopback caller: a loopback peer whose request no reverse proxy forwarded. */
function isDirectLoopbackRequest(request: IncomingMessage): boolean {
  return isLoopbackPeer(request.socket.remoteAddress) && !forwardedByProxy(request);
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8_787;
  if (!/^\d{1,5}$/.test(value)) throw new Error("NARYX_API_PORT must be a valid TCP port.");
  const port = Number(value);
  if (port < 1 || port > 65_535) throw new Error("NARYX_API_PORT must be a valid TCP port.");
  return port;
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
    terminalOrigin: parseTerminalOrigins(environment.NARYX_TERMINAL_ORIGIN),
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
  configuredOrigin: TerminalOrigins,
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (!isAllowedTerminalOrigin(configuredOrigin, origin)) {
    reject(response, 403, "ORIGIN_NOT_ALLOWED", "Browser origin is not allowed.");
    return false;
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Max-Age", "600");
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

export type PrivateTerminalHealthEnvironment = "TESTNET" | "LOCAL_CONFORMANCE" | "LOCAL_VALIDATOR" | "UNCONFIGURED";
export type PrivateTerminalHealthStatus = "ready" | "degraded" | "unconfigured";

/**
 * Derives the reported environment from what the process actually composed: any enabled public
 * testnet boundary or configured live testnet market makes it TESTNET, and LOCAL_CONFORMANCE is
 * reported only for the fixture opt-in. Any enabled boundary that failed to compose, or any
 * configured market without a fresh observation, makes the service degraded.
 */
export function privateTerminalHealthSummary(
  runtimeHealth: PrivateTerminalRuntimeHealth | undefined,
  localAtomicRuntimeMode: LocalAtomicRuntimeMode,
  marketsLive: readonly boolean[] = [],
): Readonly<{ status: PrivateTerminalHealthStatus; environment: PrivateTerminalHealthEnvironment }> {
  const boundaries = runtimeHealth === undefined ? [] : [
    runtimeHealth.solanaDevnet,
    runtimeHealth.baseTestnetAtomic,
    runtimeHealth.arbitrumTestnetAsync,
    runtimeHealth.hyperliquidTestnet,
  ];
  const enabled = boundaries.filter((boundary) => boundary.reason !== "DISABLED_BY_CONFIGURATION");
  const environment: PrivateTerminalHealthEnvironment = enabled.length > 0 || marketsLive.length > 0 ? "TESTNET"
    : localAtomicRuntimeMode === "PHASE4_FIXTURE" ? "LOCAL_CONFORMANCE"
      : localAtomicRuntimeMode === "MANIFEST_VALIDATED" ? "LOCAL_VALIDATOR"
        : "UNCONFIGURED";
  const status: PrivateTerminalHealthStatus =
    enabled.some((boundary) => !boundary.available) || marketsLive.includes(false) ? "degraded"
      : environment === "UNCONFIGURED" ? "unconfigured"
        : "ready";
  return Object.freeze({ status, environment });
}

function hasOrderPorts(ports: InternalOrderPorts | undefined): ports is InternalOrderPorts {
  return ports !== undefined &&
    typeof ports.contexts === "function" &&
    ports.store !== undefined &&
    ports.clock !== undefined;
}

export function createPrivateTerminalRequestHandler(
  config: PrivateTerminalServerConfig,
  executionPorts: PrivateTerminalExecutionPorts = {},
  orderPorts?: InternalOrderPorts,
  hyperliquidTestnetExecutionPort?: HyperliquidTestnetTerminalExecutionPort,
  evmTestnetPorts: EvmTestnetTerminalPorts = {},
  lifecycleStore?: PackageLifecycleStore,
  solverQuotePort?: SolverAtomicQuotePort,
  executionIntentStore?: ExecutionIntentStore,
  localExecutionCoordinator?: LocalExecutionCoordinator,
  runtimeHealth?: PrivateTerminalRuntimeHealth,
  localAtomicRuntimeMode: LocalAtomicRuntimeMode = "DISABLED",
  solanaLocalExecution?: SolanaLocalExecutionService,
  hyperliquidTestnetPreparationPort?: HyperliquidTestnetPreparationPort,
  hyperliquidTestnetContext?: HyperliquidTestnetTerminalContext,
  executionReadinessGate?: ExecutionReadinessGate<ExecutionReadinessScopeIdentity>,
  executionReadinessScopes?: ExecutionReadinessScopeResolver<ExecutionReadinessScopeIdentity>,
  terminalMarkets: TerminalMarketSources = {},
  currentTimeMs: () => number = Date.now,
  attemptOutcomes?: OwnerPackageOutcomeReader,
  strategyExecutionCapabilities: () => readonly StrategyExecutionLaneCapability[] = () => [],
  generalizedStrategyPreparation?: GeneralizedStrategyPreparationPort,
  hyperliquidGeneralizedOrder?: HyperliquidGeneralizedOrderPort,
  generalizedStrategyExecutions?: GeneralizedStrategyExecutionPort,
  strategyPackageAuthorization?: StrategyPackageAuthorizationPort,
  nativeHyperliquidStrategyRuntime?: NativeHyperliquidStrategyRuntime,
  hyperliquidNativeStrategyOrders?: HyperliquidNativeStrategyOrderPort,
  evmOptionSpreadOrders?: EvmOptionSpreadOrderPort,
) {
  /**
   * `commit` records the approval and counts it against the caps; it runs only where the owner's
   * own signature is proven. `check` runs before the owner has signed and records nothing, so an
   * unsigned request can never consume a domain's or a wallet's daily caps.
   */
  async function requireExecutionReadiness(
    handoff: ExecutionHandoff,
    request: Readonly<{ attemptId?: string; idempotencyKey: string }>,
    mode: "check" | "commit" = "commit",
  ): Promise<void> {
    if (executionReadinessGate === undefined || executionReadinessScopes === undefined) {
      throw new ExecutionReadinessError("READINESS_UNAVAILABLE", "Execution readiness is not configured.");
    }
    const scope = await executionReadinessScopes.resolve(handoff, request);
    if (scope.handoff !== handoff || scope.idempotencyKey !== request.idempotencyKey ||
        (request.attemptId !== undefined && scope.attemptId !== request.attemptId)) {
      throw new ExecutionReadinessError("READINESS_REJECTED", "Resolved execution scope does not match the handoff request.");
    }
    if (mode === "check" && executionReadinessGate.check !== undefined) {
      executionReadinessGate.check(scope);
      return;
    }
    executionReadinessGate.authorize(scope);
  }

  function rejectReadiness(response: ServerResponse, error: unknown): boolean {
    if (!(error instanceof ExecutionReadinessError)) return false;
    reject(response, error.code === "READINESS_UNAVAILABLE" ? 503 : 409, error.code, error.message);
    return true;
  }

  const executionReadinessAvailable = executionReadinessGate !== undefined && executionReadinessScopes !== undefined;

  // A domain reports execution only when its composed runtime and the readiness gate are both up.
  function terminalExecutionAvailable(domain: DomainId): boolean {
    if (!executionReadinessAvailable || runtimeHealth === undefined) return false;
    switch (domain) {
      case "solana":
        return executionPorts.preparation !== undefined && runtimeHealth.solanaDevnet.available;
      case "base":
        return evmTestnetPorts.preparation !== undefined && runtimeHealth.baseTestnetAtomic.available;
      case "arbitrum":
        return evmTestnetPorts.asyncObservation !== undefined && runtimeHealth.arbitrumTestnetAsync.available;
      case "hyperliquid":
        return hyperliquidTestnetExecutionPort !== undefined && runtimeHealth.hyperliquidTestnet.available;
    }
  }

  function terminalMarketContext(): TerminalMarketContext {
    return { sources: terminalMarkets, nowMs: currentTimeMs(), executionAvailable: terminalExecutionAvailable };
  }

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

    const solverOrderMatch = url.search === ""
      ? /^\/internal\/solver\/orders\/([0-9a-f]{64})$/.exec(url.pathname)
      : null;
    if (solverOrderMatch !== null) {
      if (!isDirectLoopbackRequest(request)) {
        reject(response, 403, "LOOPBACK_REQUIRED", "Internal solver order access is loopback-only.");
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (!hasOrderPorts(orderPorts)) {
        reject(response, 503, "ORDER_RETRIEVAL_UNAVAILABLE", "Order retrieval is unavailable.");
        return;
      }
      const orderHash = solverOrderMatch[1] as string;
      try {
        const order = orderPorts.store.getCanonicalOrderByHash(orderHash);
        if (order === undefined) {
          reject(response, 404, "ORDER_NOT_FOUND", "Order was not found.");
          return;
        }
        sendJson(response, 200, {
          version: 1,
          orderHash,
          order: toProtocolJson(order, "order"),
        });
      } catch {
        reject(response, 502, "ORDER_RETRIEVAL_FAILED", "Canonical order retrieval failed closed.");
      }
      return;
    }

    const solverAttemptMatch = url.search === ""
      ? /^\/internal\/solver\/attempts\/((?:local-atomic-[0-9a-f]{64})|(?:base-atomic-[0-9a-f]{52})|(?:arbitrum-async-[0-9a-f]{48}))$/.exec(url.pathname)
      : null;
    if (solverAttemptMatch !== null) {
      if (!isDirectLoopbackRequest(request)) {
        reject(response, 403, "LOOPBACK_REQUIRED", "Internal solver attempt access is loopback-only.");
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (!hasOrderPorts(orderPorts) || executionIntentStore === undefined) {
        reject(response, 503, "ATTEMPT_RETRIEVAL_UNAVAILABLE", "Selected attempt retrieval is unavailable.");
        return;
      }
      const attemptId = solverAttemptMatch[1] as string;
      try {
        const attempt = executionIntentStore.getAttempt(attemptId);
        const selected = executionIntentStore.getSelectedQuote(attemptId);
        const order = attempt === undefined
          ? undefined
          : orderPorts.store.getCanonicalOrderByHash(attempt.orderHash);
        if (attempt === undefined || selected === undefined || order === undefined) {
          reject(response, 404, "ATTEMPT_NOT_FOUND", "Selected execution attempt was not found.");
          return;
        }
        sendJson(response, 200, {
          version: 1,
          attemptId,
          orderHash: attempt.orderHash,
          routeHash: attempt.routeHash,
          quoteHash: attempt.quoteHash,
          order: toProtocolJson(order, "selectedAttempt.order"),
          route: selected.route,
          quote: selected.quote,
        });
      } catch {
        reject(response, 502, "ATTEMPT_RETRIEVAL_FAILED", "Selected attempt retrieval failed closed.");
      }
      return;
    }

    const hyperliquidAttemptMatch = url.search === ""
      ? /^\/internal\/solver\/hyperliquid-testnet\/attempts\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname)
      : null;
    if (hyperliquidAttemptMatch !== null) {
      if (!isDirectLoopbackRequest(request)) {
        reject(response, 403, "LOOPBACK_REQUIRED", "Hyperliquid attempt access is loopback-only.");
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (hyperliquidTestnetPreparationPort === undefined) {
        reject(response, 503, "ATTEMPT_RETRIEVAL_UNAVAILABLE", "Hyperliquid attempt retrieval is unavailable.");
        return;
      }
      const attemptId = hyperliquidAttemptMatch[1] as string;
      try {
        const attempt = hyperliquidTestnetPreparationPort.prepare(attemptId);
        sendJson(response, 200, {
          version: 1,
          attempt: toProtocolJson(attempt, "hyperliquidTestnet.attempt"),
        });
      } catch (error) {
        if (error instanceof HyperliquidTestnetRuntimeClientError
          && error.code === "ATTEMPT_NOT_FOUND") {
          reject(response, 404, "ATTEMPT_NOT_FOUND", "Hyperliquid attempt was not found.");
          return;
        }
        reject(response, 502, "ATTEMPT_RETRIEVAL_FAILED", "Hyperliquid attempt retrieval failed closed.");
      }
      return;
    }

    const hyperliquidSourceAttemptMatch = url.search === ""
      ? /^\/internal\/solver\/hyperliquid-testnet\/source-attempts\/(hyperliquid-testnet-[0-9a-f]{48})$/.exec(url.pathname)
      : null;
    if (hyperliquidSourceAttemptMatch !== null) {
      if (!isDirectLoopbackRequest(request)) {
        reject(response, 403, "LOOPBACK_REQUIRED", "Hyperliquid source attempt access is loopback-only.");
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (hyperliquidTestnetPreparationPort === undefined) {
        reject(response, 503, "ATTEMPT_RETRIEVAL_UNAVAILABLE", "Hyperliquid source attempt retrieval is unavailable.");
        return;
      }
      try {
        const attempt = hyperliquidTestnetPreparationPort.prepareSelectedSource(hyperliquidSourceAttemptMatch[1]!);
        sendJson(response, 200, {
          version: 1,
          attempt: toProtocolJson(attempt, "hyperliquidTestnet.sourceAttempt"),
        });
      } catch (error) {
        if (error instanceof HyperliquidTestnetRuntimeClientError
          && error.code === "ATTEMPT_NOT_FOUND") {
          reject(response, 404, "ATTEMPT_NOT_FOUND", "Hyperliquid source attempt was not found.");
          return;
        }
        reject(response, 502, "ATTEMPT_RETRIEVAL_FAILED", "Hyperliquid source attempt retrieval failed closed.");
      }
      return;
    }

    const generalizedHyperliquidAttemptMatch = url.search === ""
      ? /^\/internal\/solver\/hyperliquid-testnet\/strategy-attempts\/(strategy-hl-[0-9a-f]{48})$/.exec(url.pathname)
      : null;
    if (generalizedHyperliquidAttemptMatch !== null) {
      if (!isDirectLoopbackRequest(request)) {
        reject(response, 403, "LOOPBACK_REQUIRED", "Generalized Hyperliquid attempt access is loopback-only.");
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (generalizedStrategyExecutions === undefined) {
        reject(response, 503, "ATTEMPT_RETRIEVAL_UNAVAILABLE", "Generalized Hyperliquid attempt retrieval is unavailable.");
        return;
      }
      try {
        const attemptId = generalizedHyperliquidAttemptMatch[1]!;
        const nativeAttempt = generalizedStrategyExecutions.nativeStrategyExecutionAttempt(attemptId);
        if (nativeAttempt !== undefined) {
          if (nativeHyperliquidStrategyRuntime === undefined) {
            reject(response, 503, "ATTEMPT_RETRIEVAL_UNAVAILABLE", "Native Hyperliquid runtime binding is unavailable.");
            return;
          }
          const runtime = nativeHyperliquidStrategyRuntime;
          sendJson(response, 200, {
            version: 2,
            attempt: nativeAttempt,
            runtime: {
              domainId: runtime.domain.domainId,
              domainManifestVersion: runtime.domain.domainManifestVersion,
              domainManifestHashHex: Buffer.from(runtime.domain.domainManifestHash).toString("hex"),
              seriesManifestHash: runtime.seriesManifestHash,
              executionClassManifestHash: runtime.executionClassManifestHash,
              baseAsset: {
                assetId: runtime.baseAsset.assetId,
                decimals: runtime.baseAsset.decimals,
                assetManifestHashHex: Buffer.from(runtime.baseAsset.assetManifestHash).toString("hex"),
              },
              quoteAsset: {
                assetId: runtime.quoteAsset.assetId,
                decimals: runtime.quoteAsset.decimals,
                assetManifestHashHex: Buffer.from(runtime.quoteAsset.assetManifestHash).toString("hex"),
              },
              market: runtime.market,
              limits: runtime.bounds,
            },
          });
          return;
        }
        if (executionIntentStore === undefined) {
          reject(response, 503, "ATTEMPT_RETRIEVAL_UNAVAILABLE", "Source-backed Hyperliquid attempt retrieval is unavailable.");
          return;
        }
        const attempt = generalizedStrategyExecutions.strategyExecutionAttempt(attemptId);
        const sourceAttempt = attempt === undefined
          ? undefined
          : executionIntentStore.getAttemptForOrder(attempt.sourceOrderHashHex);
        if (attempt === undefined || sourceAttempt?.status !== "HYPERLIQUID_TESTNET_QUOTE_SELECTED"
          || sourceAttempt.domainId !== "hypercore:testnet") {
          reject(response, 404, "ATTEMPT_NOT_FOUND", "Generalized Hyperliquid attempt or its canonical source was not found.");
          return;
        }
        sendJson(response, 200, {
          version: 1,
          attempt,
          sourceAttemptId: sourceAttempt.attemptId,
        });
      } catch {
        reject(response, 502, "ATTEMPT_RETRIEVAL_FAILED", "Generalized Hyperliquid attempt retrieval failed closed.");
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/internal/healthz") {
      // Each configured lane's market answers quotes and previews only while its observation is fresh.
      const nowMs = currentTimeMs();
      const markets = Object.fromEntries(Object.entries(terminalMarkets).flatMap(([domain, source]) =>
        source === undefined ? [] : [[domain, observedMarket(source.descriptor, source.latest(), nowMs) === undefined
          ? "UNAVAILABLE" : "LIVE"]]));
      const summary = privateTerminalHealthSummary(
        runtimeHealth,
        localAtomicRuntimeMode,
        Object.values(markets).map((state) => state === "LIVE"),
      );
      sendJson(response, 200, {
        status: summary.status,
        scope: "private_terminal",
        environment: summary.environment,
        markets,
        localAtomicRuntimeMode,
        executionPreparationAvailable: executionPorts.preparation !== undefined && executionReadinessAvailable,
        executionObservationAvailable: executionPorts.observation !== undefined,
        hyperliquidTestnetExecutionAvailable: hyperliquidTestnetExecutionPort !== undefined && executionReadinessAvailable,
        evmTestnetAtomicAuthorizationAvailable: evmTestnetPorts.authorization !== undefined && executionReadinessAvailable,
        evmTestnetAtomicPreparationAvailable: evmTestnetPorts.preparation !== undefined && executionReadinessAvailable,
        evmTestnetAtomicObservationAvailable: evmTestnetPorts.atomicObservation !== undefined,
        evmTestnetAsyncObservationAvailable: evmTestnetPorts.asyncObservation !== undefined && executionReadinessAvailable,
        executionReadinessAvailable,
        lifecycleReadAvailable: lifecycleStore !== undefined,
        solverQuotingAvailable: solverQuotePort !== undefined,
        executionIntentAvailable: executionIntentStore !== undefined,
        localExecutionAvailable: localExecutionCoordinator !== undefined,
        solanaLocalExecutionAvailable: solanaLocalExecution !== undefined,
        generalizedStrategyPreparationAvailable: generalizedStrategyPreparation !== undefined,
        hyperliquidGeneralizedOrderAvailable: hyperliquidGeneralizedOrder !== undefined,
        hyperliquidNativeStrategyOrderAvailable: hyperliquidNativeStrategyOrders !== undefined,
        evmOptionSpreadOrderAvailable: evmOptionSpreadOrders !== undefined,
        strategyPackageAuthorizationAvailable: strategyPackageAuthorization !== undefined,
        ...(runtimeHealth === undefined ? {} : { runtime: runtimeHealth }),
      });
      return;
    }

    if (url.pathname === "/internal/terminal/hyperliquid-testnet/context") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (hyperliquidTestnetContext === undefined) {
        reject(response, 503, "CONTEXT_UNAVAILABLE", "Hyperliquid Testnet order context is unavailable.");
        return;
      }
      sendJson(response, 200, hyperliquidTestnetContext);
      return;
    }

    if (url.pathname === "/internal/terminal/strategy-program") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      try {
        sendJson(response, 200, strategyProgramView(strategyExecutionCapabilities()));
      } catch {
        reject(response, 503, "STRATEGY_CAPABILITY_UNAVAILABLE", "Strategy execution capability is unavailable.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/strategy-orders/stage") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (hyperliquidGeneralizedOrder === undefined) {
        reject(response, 503, "STRATEGY_ORDER_STAGING_UNAVAILABLE", "Strategy order staging is unavailable.");
        return;
      }
      try {
        const body = await readJson(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).length !== 1 || typeof (body as { sourceOrderHash?: unknown }).sourceOrderHash !== "string") {
          throw new HyperliquidGeneralizedOrderError("INVALID_REQUEST", "Request must contain only sourceOrderHash.");
        }
        const staged = hyperliquidGeneralizedOrder.stage((body as { sourceOrderHash: string }).sourceOrderHash);
        sendJson(response, 200, {
          version: 1,
          status: staged.intake.status,
          created: staged.intake.created,
          sourceOrderHash: staged.sourceOrderHash,
          orderHash: staged.intake.orderHashHex,
          graphHash: staged.intake.graphHashHex,
          templateId: staged.order.templateId,
          lifecycleAction: staged.order.lifecycleAction,
          seriesId: staged.order.seriesId,
          executionClassId: staged.order.executionClassId,
        });
      } catch (error) {
        if (error instanceof HyperliquidGeneralizedOrderError) {
          const status = error.code === "ORDER_NOT_FOUND" ? 404
            : error.code === "SOURCE_ORDER_NOT_REVIEWED" || error.code === "SOURCE_ORDER_MISMATCH" ? 409
              : error.code === "INVALID_CONFIGURATION" ? 503
                : error.code === "INTAKE_MISMATCH" ? 500
                  : 400;
          reject(response, status, error.code, error.message);
          return;
        }
        if (error instanceof StrategyOrderIntakeError) {
          reject(response, error.status, error.code, error.message);
          return;
        }
        reject(response, 502, "STRATEGY_ORDER_STAGING_FAILED", "Strategy order staging failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/strategy-order-profiles") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (hyperliquidNativeStrategyOrders === undefined) {
        reject(response, 503, "STRATEGY_ORDER_CREATION_UNAVAILABLE", "Native strategy order creation is unavailable.");
        return;
      }
      sendJson(response, 200, {
        version: 1,
        profiles: hyperliquidNativeStrategyOrders.profiles().map((profile) => ({
          profileId: profile.profileId,
          displayName: profile.displayName,
          templateId: profile.templateId,
          templateVersion: profile.templateVersion,
          seriesId: profile.seriesId,
          executionClassId: profile.executionClassId,
          settlementAccount: profile.settlementAccount,
          baseAsset: {
            assetId: profile.baseAsset.assetId,
            decimals: profile.baseAsset.decimals,
          },
          quoteAsset: {
            assetId: profile.quoteAsset.assetId,
            decimals: profile.quoteAsset.decimals,
          },
          markets: profile.markets.map((market) => ({
            role: market.role,
            entrySide: market.entrySide,
            coin: market.coin,
            assetId: market.assetId,
            sizeDecimals: market.sizeDecimals,
            maximumPriceDecimals: market.maximumPriceDecimals,
          })),
          bounds: Object.fromEntries(Object.entries(profile.bounds).map(([name, value]) => [name, value.toString()])),
        })),
      });
      return;
    }

    if (url.pathname === "/internal/terminal/strategy-orders/create") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (hyperliquidNativeStrategyOrders === undefined) {
        reject(response, 503, "STRATEGY_ORDER_CREATION_UNAVAILABLE", "Native strategy order creation is unavailable.");
        return;
      }
      try {
        const created = hyperliquidNativeStrategyOrders.create(await readJson(request));
        sendJson(response, 200, {
          version: 1,
          status: created.intake.status,
          created: created.intake.created,
          profileId: created.profileId,
          orderHash: created.intake.orderHashHex,
          graphHash: created.intake.graphHashHex,
          templateId: created.order.templateId,
          lifecycleAction: created.order.lifecycleAction,
          seriesId: created.order.seriesId,
          executionClassId: created.order.executionClassId,
        });
      } catch (error) {
        if (error instanceof HyperliquidNativeStrategyOrderError) {
          const status = error.code === "PROFILE_NOT_FOUND" ? 404
            : error.code === "LIMIT_EXCEEDED" ? 409
              : error.code === "INVALID_CONFIGURATION" ? 503
                : error.code === "INTAKE_MISMATCH" ? 500
                  : 400;
          reject(response, status, error.code, error.message);
          return;
        }
        if (error instanceof StrategyOrderIntakeError) {
          reject(response, error.status, error.code, error.message);
          return;
        }
        reject(response, 502, "STRATEGY_ORDER_CREATION_FAILED", "Native strategy order creation failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/evm-option-spread-profiles") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (evmOptionSpreadOrders === undefined) {
        reject(response, 503, "EVM_OPTION_SPREAD_UNAVAILABLE", "EVM option spread order creation is unavailable.");
        return;
      }
      sendJson(response, 200, {
        version: 1,
        profiles: evmOptionSpreadOrders.profiles().map((profile) => ({
          profileId: profile.profileId,
          displayName: profile.displayName,
          templateId: profile.templateId,
          templateVersion: profile.templateVersion,
          seriesId: profile.seriesId,
          executionClassId: profile.executionClassId,
          chainId: profile.chainId,
          domainId: profile.domain.domainId,
          accountFactory: profile.accountFactory,
          baseAsset: { assetId: profile.baseAsset.assetId, decimals: profile.baseAsset.decimals },
          quoteAsset: { assetId: profile.quoteAsset.assetId, decimals: profile.quoteAsset.decimals },
          markets: profile.markets.map((market) => ({
            role: market.role,
            strike: market.strike.toString(),
            maturity: market.maturity.toString(),
          })),
          bounds: Object.fromEntries(Object.entries(profile.bounds).map(([name, value]) => [name, value.toString()])),
        })),
      });
      return;
    }

    if (url.pathname === "/internal/terminal/evm-option-spread-orders/create") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (evmOptionSpreadOrders === undefined) {
        reject(response, 503, "EVM_OPTION_SPREAD_UNAVAILABLE", "EVM option spread order creation is unavailable.");
        return;
      }
      try {
        const created = evmOptionSpreadOrders.create(await readJson(request));
        sendJson(response, 200, {
          version: 1,
          status: created.intake.status,
          created: created.intake.created,
          profileId: created.profileId,
          orderHash: created.intake.orderHashHex,
          graphHash: created.intake.graphHashHex,
          templateId: created.order.templateId,
          lifecycleAction: created.order.lifecycleAction,
          seriesId: created.order.seriesId,
          executionClassId: created.order.executionClassId,
        });
      } catch (error) {
        if (error instanceof EvmOptionSpreadOrderError) {
          const status = error.code === "PROFILE_NOT_FOUND" ? 404
            : error.code === "LIMIT_EXCEEDED" ? 409
              : error.code === "INVALID_CONFIGURATION" ? 503
                : error.code === "INTAKE_MISMATCH" ? 500
                  : 400;
          reject(response, status, error.code, error.message);
          return;
        }
        if (error instanceof StrategyOrderIntakeError) {
          reject(response, error.status, error.code, error.message);
          return;
        }
        reject(response, 502, "EVM_OPTION_SPREAD_CREATION_FAILED", "EVM option spread order creation failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/strategy-orders/authorization"
      || url.pathname === "/internal/terminal/strategy-orders/authorize") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (strategyPackageAuthorization === undefined) {
        reject(response, 503, "STRATEGY_AUTHORIZATION_UNAVAILABLE", "Strategy package authorization is unavailable.");
        return;
      }
      try {
        const body = await readJson(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          reject(response, 400, "INVALID_REQUEST", "Request body must be an object.");
          return;
        }
        const values = body as { orderHash?: unknown; signature?: unknown };
        if (url.pathname.endsWith("/authorization")) {
          if (Object.keys(body).join(",") !== "orderHash" || typeof values.orderHash !== "string") {
            reject(response, 400, "INVALID_REQUEST", "Request must contain only orderHash.");
            return;
          }
          sendJson(response, 200, strategyPackageAuthorization.prepare(values.orderHash));
          return;
        }
        if (Object.keys(body).sort().join(",") !== "orderHash,signature"
          || typeof values.orderHash !== "string" || typeof values.signature !== "string") {
          reject(response, 400, "INVALID_REQUEST", "Request must contain only orderHash and signature.");
          return;
        }
        sendJson(response, 200, await strategyPackageAuthorization.authorize(values.orderHash, values.signature));
      } catch (error) {
        if (error instanceof StrategyPackageAuthorizationError) {
          const status = error.code === "ORDER_NOT_FOUND" ? 404
            : error.code === "ORDER_EXPIRED" || error.code === "UNSUPPORTED_ENVIRONMENT" ? 409
              : 400;
          reject(response, status, error.code, error.message);
          return;
        }
        reject(response, 502, "STRATEGY_AUTHORIZATION_FAILED", "Strategy package authorization failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/strategy-executions/prepare") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (generalizedStrategyPreparation === undefined) {
        reject(response, 503, "STRATEGY_PREPARATION_UNAVAILABLE", "Generalized strategy preparation is unavailable.");
        return;
      }
      try {
        const body = await readJson(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).length !== 1 || typeof (body as { quoteHash?: unknown }).quoteHash !== "string") {
          throw new StrategyPreparationClientError("INVALID_REQUEST", "Request must contain only quoteHash.");
        }
        const prepared = await generalizedStrategyPreparation.prepare((body as { quoteHash: string }).quoteHash);
        sendJson(response, 200, {
          status: "UNSIGNED_REVIEW_REQUIRED",
          preparation: toProtocolJson(prepared),
        });
      } catch (error) {
        if (error instanceof StrategyPreparationClientError) {
          const status = error.code === "NOT_FOUND" ? 404 : error.code === "INVALID_REQUEST" ? 400 : 502;
          reject(response, status, error.code, error.message);
          return;
        }
        reject(response, 502, "STRATEGY_PREPARATION_FAILED", "Generalized strategy preparation failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/native-strategies") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (generalizedStrategyExecutions?.nativeStrategyPositionsByOwner === undefined) {
        reject(response, 503, "NATIVE_STRATEGIES_UNAVAILABLE", "Native strategy positions are unavailable.");
        return;
      }
      const keys = [...url.searchParams.keys()];
      const owner = url.searchParams.get("owner");
      if (keys.length !== 1 || keys[0] !== "owner"
        || owner === null || !/^0x(?!0{40}$)[0-9a-f]{40}$/.test(owner)) {
        reject(response, 400, "INVALID_REQUEST", "Request must contain one lowercase EVM owner.");
        return;
      }
      try {
        const positions = generalizedStrategyExecutions.nativeStrategyPositionsByOwner(owner);
        sendJson(response, 200, toProtocolJson({ version: 1, owner, positions }, "nativeStrategies"));
      } catch (error) {
        if (error instanceof StrategyPackageStoreError) {
          reject(response, error.code === "CORRUPT_ROW" ? 500 : 400, error.code, error.message);
          return;
        }
        reject(response, 502, "NATIVE_STRATEGIES_FAILED", "Native strategy retrieval failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/strategy-executions/select") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (generalizedStrategyExecutions === undefined) {
        reject(response, 503, "STRATEGY_SELECTION_UNAVAILABLE", "Generalized strategy selection is unavailable.");
        return;
      }
      try {
        const body = await readJson(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || typeof (body as { quoteHash?: unknown }).quoteHash !== "string"
          || typeof (body as { orderHash?: unknown }).orderHash !== "string"
          || typeof (body as { routeHash?: unknown }).routeHash !== "string"
          || typeof (body as { idempotencyKey?: unknown }).idempotencyKey !== "string") {
          reject(response, 400, "INVALID_REQUEST", "Request must contain the reviewed order, quote, route, and idempotency key.");
          return;
        }
        const values = body as { quoteHash: string; orderHash: string; routeHash: string; sourceOrderHash?: unknown; idempotencyKey: string };
        const keys = Object.keys(body).sort().join(",");
        if (keys === "idempotencyKey,orderHash,quoteHash,routeHash") {
          const selected = generalizedStrategyExecutions.selectNativeHyperliquidExecution({
            quoteHashHex: values.quoteHash,
            orderHashHex: values.orderHash,
            routeHashHex: values.routeHash,
            idempotencyKey: values.idempotencyKey,
          });
          sendJson(response, 200, { version: 2, ...selected });
          return;
        }
        if (keys !== "idempotencyKey,orderHash,quoteHash,routeHash,sourceOrderHash"
          || typeof values.sourceOrderHash !== "string") {
          reject(response, 400, "INVALID_REQUEST", "Request contains unsupported strategy selection fields.");
          return;
        }
        if (executionIntentStore === undefined) {
          reject(response, 503, "STRATEGY_SELECTION_UNAVAILABLE", "Canonical Hyperliquid source selection is unavailable.");
          return;
        }
        const sourceAttempt = executionIntentStore.getAttemptForOrder(values.sourceOrderHash);
        if (sourceAttempt?.status !== "HYPERLIQUID_TESTNET_QUOTE_SELECTED"
          || sourceAttempt.domainId !== "hypercore:testnet") {
          reject(response, 409, "SOURCE_ATTEMPT_REQUIRED", "The canonical source order must have a selected Hyperliquid Testnet attempt.");
          return;
        }
        const selected = generalizedStrategyExecutions.selectHyperliquidExecution({
          quoteHashHex: values.quoteHash,
          orderHashHex: values.orderHash,
          routeHashHex: values.routeHash,
          sourceOrderHashHex: values.sourceOrderHash,
          idempotencyKey: values.idempotencyKey,
        });
        sendJson(response, 200, { version: 1, ...selected });
      } catch (error) {
        if (error instanceof StrategyPackageStoreError) {
          const status = error.code === "QUOTE_NOT_FOUND" ? 404
            : error.code === "CORRUPT_ROW" ? 500
              : error.code === "IDEMPOTENCY_CONFLICT" || error.code === "QUOTE_ALREADY_SELECTED" ? 409
                : 400;
          reject(response, status, error.code, error.message);
          return;
        }
        reject(response, 502, "STRATEGY_SELECTION_FAILED", "Generalized strategy selection failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/packages") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (!hasOrderPorts(orderPorts)) {
        reject(response, 503, "ORDER_CREATION_UNAVAILABLE", "Package listing is unavailable.");
        return;
      }
      try {
        const owner = parseOwnerPackageQuery(url.searchParams);
        sendJson(response, 200, {
          owner,
          packages: listOwnerPackages(owner, {
            orders: orderPorts.store,
            ...(executionIntentStore === undefined ? {} : { intents: executionIntentStore }),
            ...(lifecycleStore === undefined ? {} : { lifecycle: lifecycleStore }),
            ...(attemptOutcomes === undefined ? {} : { outcomes: attemptOutcomes }),
          }),
        });
      } catch (error) {
        if (error instanceof OwnerPackageQueryError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 502, "PACKAGE_LISTING_FAILED", "Package listing failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/lifecycle") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (lifecycleStore === undefined) {
        reject(response, 503, "LIFECYCLE_UNAVAILABLE", "Package lifecycle reading is unavailable.");
        return;
      }
      let query;
      try {
        query = parseLifecycleQuery(url.searchParams);
      } catch (error) {
        if (error instanceof LifecycleQueryValidationError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 400, "INVALID_QUERY", "Lifecycle query is invalid.");
        return;
      }
      try {
        const attempt = lifecycleStore.getAttempt(query.attemptId);
        if (attempt === undefined) {
          reject(response, 404, "ATTEMPT_NOT_FOUND", "Attempt was not found.");
          return;
        }
        let anchorPage: unknown;
        if (query.afterRevision > 0n) {
          const rawRevision = (attempt as { revision?: unknown }).revision;
          if (typeof rawRevision === "bigint" && query.afterRevision < rawRevision) {
            anchorPage = lifecycleStore.listReceipts(query.attemptId, query.afterRevision - 1n, 1);
          }
        }
        const receipts = lifecycleStore.listReceipts(query.attemptId, query.afterRevision, query.limit);
        sendJson(response, 200, serializeLifecycleResponse(attempt, receipts, query, anchorPage));
      } catch {
        reject(response, 502, "LIFECYCLE_READ_FAILED", "Package lifecycle reading failed closed.");
      }
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
      try {
        sendJson(response, 200, createTerminalSnapshot(domains[0], terminalMarketContext()));
      } catch (error) {
        if (error instanceof TerminalMarketUnavailableError) {
          reject(response, 503, error.code, error.message);
          return;
        }
        reject(response, 500, "INTERNAL_ERROR", "Snapshot calculation failed.");
      }
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
        sendJson(response, 200, createTerminalPreview(previewRequest, terminalMarketContext()));
      } catch (error) {
        if (error instanceof TerminalMarketUnavailableError) {
          reject(response, 503, error.code, error.message);
          return;
        }
        if (error instanceof PreviewValidationError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 500, "INTERNAL_ERROR", "Preview calculation failed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/execution/prepare") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (executionPorts.preparation === undefined) {
        reject(response, 503, "EXECUTION_UNAVAILABLE", "Devnet execution preparation is unavailable.");
        return;
      }
      try {
        const preparationRequest = parseExecutionPreparationRequest(await readJson(request));
        await requireExecutionReadiness("SOLANA_DEVNET_PREPARE", {
          idempotencyKey: preparationRequest.idempotencyKey,
        });
        const prepared = validateUnsignedSolanaDevnetMaterialization(
          await executionPorts.preparation.prepare(preparationRequest),
          preparationRequest,
        );
        sendJson(response, 200, {
          status: "DEVNET_UNSIGNED_REVIEW_REQUIRED",
          environment: "DEVNET",
          idempotencyKey: preparationRequest.idempotencyKey,
          ...prepared,
        });
      } catch (error) {
        if (rejectReadiness(response, error)) return;
        if (error instanceof ExecutionValidationError || error instanceof PreviewValidationError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 502, "EXECUTION_PREPARATION_FAILED", "Devnet preparation failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/execution/observe") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (executionPorts.observation === undefined) {
        reject(response, 503, "EXECUTION_UNAVAILABLE", "Devnet execution observation is unavailable.");
        return;
      }
      try {
        const observationRequest = parseExecutionObservationRequest(await readJson(request));
        const observation = validateExecutionObservation(
          await executionPorts.observation.observe(observationRequest),
          observationRequest,
        );
        sendJson(response, 200, {
          environment: "DEVNET",
          domain: "svm:devnet",
          idempotencyKey: observationRequest.idempotencyKey,
          ...observation,
        });
      } catch (error) {
        if (error instanceof ExecutionValidationError || error instanceof PreviewValidationError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 502, "EXECUTION_OBSERVATION_FAILED", "Devnet observation failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/hyperliquid-testnet/execute") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (hyperliquidTestnetExecutionPort === undefined) {
        reject(response, 503, "EXECUTION_UNAVAILABLE", "Hyperliquid Testnet execution is unavailable.");
        return;
      }
      try {
        const terminalRequest = parseHyperliquidTestnetTerminalExecutionRequest(await readJson(request));
        // The caps count only once the package owner's own signature is proven.
        await requireExecutionReadiness("HYPERLIQUID_TESTNET_EXECUTE", terminalRequest, "check");
        hyperliquidTestnetExecutionPort.requireOwnerAuthorization?.(terminalRequest);
        await requireExecutionReadiness("HYPERLIQUID_TESTNET_EXECUTE", terminalRequest, "commit");
        const sanitized = validateHyperliquidTestnetTerminalExecutionResult(
          await hyperliquidTestnetExecutionPort.execute(terminalRequest),
          terminalRequest,
        );
        sendJson(response, 200, sanitized);
      } catch (error) {
        if (rejectReadiness(response, error)) return;
        if (error instanceof HyperliquidTestnetTerminalValidationError ||
            error instanceof PreviewValidationError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 502, "HYPERLIQUID_EXECUTION_FAILED", "Hyperliquid Testnet execution failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/evm-testnet/prepare-atomic-authorization") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (evmTestnetPorts.authorization === undefined) {
        reject(response, 503, "EXECUTION_UNAVAILABLE", "EVM Testnet atomic authorization is unavailable.");
        return;
      }
      try {
        const terminalRequest = parseEvmTestnetPrepareAtomicAuthorizationRequest(await readJson(request));
        // Before the owner signs the permit: checked, not counted.
        await requireExecutionReadiness("BASE_TESTNET_ATOMIC_AUTHORIZE", terminalRequest, "check");
        const sanitized = validateEvmTestnetAtomicAuthorization(
          await evmTestnetPorts.authorization.prepare(terminalRequest),
          terminalRequest,
        );
        sendJson(response, 200, sanitized);
      } catch (error) {
        if (rejectReadiness(response, error)) return;
        if (error instanceof EvmTestnetTerminalValidationError ||
            error instanceof PreviewValidationError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 502, "EVM_ATOMIC_AUTHORIZATION_FAILED", "EVM Testnet authorization failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/evm-testnet/prepare-atomic") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (evmTestnetPorts.preparation === undefined) {
        reject(response, 503, "EXECUTION_UNAVAILABLE", "EVM Testnet atomic preparation is unavailable.");
        return;
      }
      try {
        const terminalRequest = parseEvmTestnetPrepareAtomicRequest(await readJson(request));
        await requireExecutionReadiness("BASE_TESTNET_ATOMIC_PREPARE", terminalRequest, "check");
        const sanitized = validateEvmTestnetAtomicPreparation(
          await evmTestnetPorts.preparation.prepare(terminalRequest),
          terminalRequest,
        );
        // Preparation recovered the owner's permit signature, so the approval now counts.
        await requireExecutionReadiness("BASE_TESTNET_ATOMIC_PREPARE", terminalRequest, "commit");
        sendJson(response, 200, sanitized);
      } catch (error) {
        if (rejectReadiness(response, error)) return;
        if (error instanceof EvmTestnetTerminalValidationError ||
            error instanceof PreviewValidationError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 502, "EVM_ATOMIC_PREPARATION_FAILED", "EVM Testnet preparation failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/evm-testnet/observe-atomic") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (evmTestnetPorts.atomicObservation === undefined) {
        reject(response, 503, "EXECUTION_UNAVAILABLE", "EVM Testnet atomic observation is unavailable.");
        return;
      }
      try {
        const terminalRequest = parseEvmTestnetObserveAtomicRequest(await readJson(request));
        const sanitized = validateEvmTestnetAtomicObservation(
          await evmTestnetPorts.atomicObservation.observe(terminalRequest),
          terminalRequest,
        );
        sendJson(response, 200, sanitized);
      } catch (error) {
        if (error instanceof EvmTestnetTerminalValidationError ||
            error instanceof PreviewValidationError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 502, "EVM_ATOMIC_OBSERVATION_FAILED", "EVM Testnet observation failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/evm-testnet/observe-async") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (evmTestnetPorts.asyncObservation === undefined) {
        reject(response, 503, "EXECUTION_UNAVAILABLE", "EVM Testnet async observation is unavailable.");
        return;
      }
      try {
        const terminalRequest = parseEvmTestnetObserveAsyncRequest(await readJson(request));
        await requireExecutionReadiness("ARBITRUM_TESTNET_ASYNC_HANDOFF", terminalRequest, "check");
        const sanitized = validateEvmTestnetAsyncObservation(
          await evmTestnetPorts.asyncObservation.observe(terminalRequest),
          terminalRequest,
        );
        // The coordinator records a reservation only after the owner signed it, so from then on
        // the approval counts (once; later polls reuse it).
        if (sanitized.lifecycle !== "NOT_FOUND") {
          await requireExecutionReadiness("ARBITRUM_TESTNET_ASYNC_HANDOFF", terminalRequest, "commit");
        }
        sendJson(response, 200, sanitized);
      } catch (error) {
        if (rejectReadiness(response, error)) return;
        if (error instanceof EvmTestnetTerminalValidationError ||
            error instanceof PreviewValidationError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 502, "EVM_ASYNC_OBSERVATION_FAILED", "EVM Testnet observation failed closed.");
      }
      return;
    }

    // Base Sepolia owner account: status plus the unsigned setup transactions the wallet still needs.
    if (url.pathname === "/internal/terminal/base-sepolia/account") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (evmTestnetPorts.account === undefined) {
        reject(response, 503, "ACCOUNT_STATUS_UNAVAILABLE", "Base Sepolia account status is unavailable.");
        return;
      }
      const owner = url.searchParams.get("owner") ?? "";
      const orderHash = url.searchParams.get("orderHash") ?? undefined;
      const margin = url.searchParams.get("marginAtoms") ?? "0";
      if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || !/^(?:0|[1-9][0-9]{0,30})$/.test(margin)
        || (orderHash !== undefined && !/^[0-9a-f]{64}$/.test(orderHash))) {
        reject(response, 400, "INVALID_REQUEST", "owner must be an EVM address, orderHash a hash, and margin integer atoms.");
        return;
      }
      try {
        sendJson(response, 200, await evmTestnetPorts.account.status({
          owner,
          ...(orderHash === undefined ? {} : { orderHash }),
          marginAtoms: BigInt(margin),
        }));
      } catch (error) {
        if (error instanceof EvmTestnetTerminalValidationError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 502, "ACCOUNT_STATUS_FAILED", "Base Sepolia account status failed closed.");
      }
      return;
    }

    if (url.pathname === "/internal/terminal/orders") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (!hasOrderPorts(orderPorts)) {
        reject(response, 503, "ORDER_CREATION_UNAVAILABLE", "Order creation is unavailable.");
        return;
      }
      try {
        const coordinator = new InternalOrderCoordinator(orderPorts);
        const result = await coordinator.createOrder(await readJson(request));
        const selectionKind = executionSelectionKind(
          result.record,
          orderPorts.contexts(result.record.contextId)!.domain,
        );
        sendJson(response, result.created ? 201 : 200, {
          status: "UNSIGNED_CREATED",
          created: result.created,
          order: result.record,
          traderAuthorization: selectionKind === "HYPERLIQUID_TESTNET"
            ? "OWNER_EVM_SIGNATURE_REQUIRED"
            : "REQUIRED",
          solverQuoting: "REQUIRED",
          note: "Unsigned order stored. Trader authorization and solver quoting are still required. No signing, quoting, or submission was performed.",
        });
      } catch (error) {
        if (error instanceof TerminalOrderValidationError || error instanceof EntryOrderValidationError) {
          reject(response, error.code === "INSUFFICIENT_LIQUIDITY" ? 409 : 400, error.code, error.message);
          return;
        }
        if (error instanceof InternalOrderConflictError) {
          reject(response, 409, error.code, error.message);
          return;
        }
        reject(response, 502, "ORDER_CREATION_FAILED", "Order creation failed closed.");
      }
      return;
    }

    const authorizeMatch = /^\/internal\/terminal\/orders\/([0-9a-f]{64})\/authorize$/.exec(url.pathname);
    if (authorizeMatch !== null) {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (!hasOrderPorts(orderPorts) || executionIntentStore === undefined) {
        reject(response, 503, "AUTHORIZATION_UNAVAILABLE", "Order authorization is unavailable.");
        return;
      }
      try {
        const order = orderPorts.store.getByOrderHash(authorizeMatch[1] as string);
        if (order === undefined) {
          reject(response, 404, "ORDER_NOT_FOUND", "Order was not found.");
          return;
        }
        const context = orderPorts.contexts(order.contextId);
        if (context === undefined) {
          reject(response, 409, "ORDER_CONTEXT_UNAVAILABLE", "Canonical order context is unavailable.");
          return;
        }
        if (executionSelectionKind(order, context.domain) === "HYPERLIQUID_TESTNET") {
          reject(
            response,
            409,
            "EXTERNAL_ACCOUNT_AUTHORIZATION_REQUIRED",
            "Hyperliquid Testnet packages are authorized by the owner wallet at /internal/terminal/hyperliquid-testnet/authorize.",
          );
          return;
        }
        const body = await readJson(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).length !== 1 || typeof (body as Record<string, unknown>).signature !== "string") {
          reject(response, 400, "INVALID_REQUEST", "Request must contain only signature.");
          return;
        }
        sendJson(response, 200, {
          status: "TRADER_AUTHORIZED",
          authorization: executionIntentStore.authorize(
            order,
            (body as Record<string, unknown>).signature as string,
          ),
        });
      } catch (error) {
        if (error instanceof ExecutionIntentStoreError) {
          reject(response, error.code.endsWith("CONFLICT") ? 409 : 400, error.code, error.message);
          return;
        }
        reject(response, 502, "AUTHORIZATION_FAILED", "Order authorization failed closed.");
      }
      return;
    }

    const quoteMatch = /^\/internal\/terminal\/orders\/([0-9a-f]{64})\/quote$/.exec(url.pathname);
    if (quoteMatch !== null) {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (!hasOrderPorts(orderPorts) || solverQuotePort === undefined) {
        reject(response, 503, "SOLVER_QUOTING_UNAVAILABLE", "Solver quoting is unavailable.");
        return;
      }
      const orderHash = quoteMatch[1] as string;
      try {
        const coordinator = new InternalOrderCoordinator(orderPorts);
        const orderRecord = coordinator.getOrder(orderHash);
        if (orderRecord === undefined) {
          reject(response, 404, "ORDER_NOT_FOUND", "Order was not found.");
          return;
        }
        const canonicalOrder = orderPorts.store.getCanonicalOrderByHash(orderHash);
        const context = orderPorts.contexts(orderRecord.contextId);
        if (canonicalOrder === undefined || context === undefined) {
          reject(response, 409, "ORDER_CONTEXT_UNAVAILABLE", "Canonical order context is unavailable.");
          return;
        }
        if (executionIntentStore !== undefined
          && executionSelectionKind(orderRecord, context.domain) === "SOLANA_AUTHORIZED"
          && executionIntentStore.getAuthorization(orderHash) === undefined) {
          reject(response, 409, "AUTHORIZATION_REQUIRED", "Trader authorization is required before quoting.");
          return;
        }
        const raw = await readJson(request);
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)
          || Object.keys(raw).length !== 1 || typeof (raw as Record<string, unknown>).idempotencyKey !== "string") {
          reject(response, 400, "INVALID_REQUEST", "Request must contain only idempotencyKey.");
          return;
        }
        const quoteRequest = parseSolverAtomicQuoteRequest({
          orderHash,
          idempotencyKey: (raw as Record<string, unknown>).idempotencyKey,
        });
        const currentClock = await orderPorts.clock.currentClock(context);
        const quoteResponse = await solverQuotePort.quote(quoteRequest);
        solverQuotePort.verify?.(quoteResponse, canonicalOrder, currentClock);
        executionIntentStore?.recordQuote(quoteResponse);
        sendJson(response, 200, quoteResponse);
      } catch (error) {
        if (error instanceof ExecutionIntentStoreError) {
          reject(response, 409, error.code, error.message);
          return;
        }
        if (error instanceof SolverQuoteClientError) {
          if (error.code === "QUOTE_DECLINED") {
            reject(response, 409, error.code, `${error.detail ?? "The solver declined this quote."} Nothing was signed; try again or a smaller size.`);
            return;
          }
          reject(response, error.code === "INVALID_REQUEST" ? 400 : 502, error.code, error.message);
          return;
        }
        reject(response, 502, "SOLVER_QUOTE_FAILED", "Solver quoting failed closed.");
      }
      return;
    }

    const selectMatch = /^\/internal\/terminal\/orders\/([0-9a-f]{64})\/select$/.exec(url.pathname);
    if (selectMatch !== null) {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (!hasOrderPorts(orderPorts) || executionIntentStore === undefined) {
        reject(response, 503, "SELECTION_UNAVAILABLE", "Quote selection is unavailable.");
        return;
      }
      try {
        const orderHash = selectMatch[1] as string;
        const order = orderPorts.store.getByOrderHash(orderHash);
        const context = order === undefined ? undefined : orderPorts.contexts(order.contextId);
        if (order === undefined) {
          reject(response, 404, "ORDER_NOT_FOUND", "Order was not found.");
          return;
        }
        if (context === undefined) {
          reject(response, 409, "ORDER_CONTEXT_UNAVAILABLE", "Canonical order context is unavailable.");
          return;
        }
        const body = await readJson(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).length !== 1 || typeof (body as Record<string, unknown>).quoteHash !== "string") {
          reject(response, 400, "INVALID_REQUEST", "Request must contain only quoteHash.");
          return;
        }
        const attempt = executionIntentStore.selectQuoteForOrder(
          order,
          context.domain,
          (body as Record<string, unknown>).quoteHash as string,
        );
        sendJson(response, 201, { status: attempt.status, attempt });
      } catch (error) {
        if (error instanceof ExecutionIntentStoreError) {
          const status = error.code === "QUOTE_NOT_FOUND" ? 404
            : error.code.endsWith("CONFLICT") || error.code === "AUTHORIZATION_REQUIRED" ? 409 : 400;
          reject(response, status, error.code, error.message);
          return;
        }
        reject(response, 502, "SELECTION_FAILED", "Quote selection failed closed.");
      }
      return;
    }

    const attemptMatch = /^\/internal\/terminal\/attempts\/((?:local-atomic-[0-9a-f]{64})|(?:base-atomic-[0-9a-f]{52})|(?:arbitrum-async-[0-9a-f]{48})|(?:hyperliquid-testnet-[0-9a-f]{48}))$/.exec(url.pathname);
    if (attemptMatch !== null) {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (executionIntentStore === undefined) {
        reject(response, 503, "ATTEMPT_UNAVAILABLE", "Execution attempt reading is unavailable.");
        return;
      }
      try {
        const attempt = executionIntentStore.getAttempt(attemptMatch[1] as string);
        if (attempt === undefined) {
          reject(response, 404, "ATTEMPT_NOT_FOUND", "Execution attempt was not found.");
          return;
        }
        sendJson(response, 200, { attempt, quote: executionIntentStore.getSelectedQuote(attempt.attemptId) });
      } catch {
        reject(response, 502, "ATTEMPT_READ_FAILED", "Execution attempt reading failed closed.");
      }
      return;
    }

    const attemptActionMatch = url.search === ""
      ? /^\/internal\/terminal\/attempts\/(local-atomic-[0-9a-f]{64})\/(prepare|open|observation-ambiguity|controller-recovery|close)$/.exec(url.pathname)
      : null;
    if (attemptActionMatch !== null) {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (localAtomicRuntimeMode !== "PHASE4_FIXTURE") {
        reject(response, 409, "FIXTURE_MODE_DISABLED", "Fixture lifecycle actions are disabled unless local fixture mode is explicitly enabled.");
        return;
      }
      if (localExecutionCoordinator === undefined) {
        reject(response, 503, "LOCAL_EXECUTION_UNAVAILABLE", "Local execution coordination is unavailable.");
        return;
      }
      const attemptId = attemptActionMatch[1] as string;
      const action = attemptActionMatch[2] as string;
      try {
        const result = action === "prepare" ? localExecutionCoordinator.prepare(attemptId)
          : action === "open" ? localExecutionCoordinator.open(attemptId)
          : action === "observation-ambiguity"
            ? localExecutionCoordinator.recordObservationAmbiguity(attemptId)
            : action === "controller-recovery"
              ? localExecutionCoordinator.recoverController(attemptId)
              : localExecutionCoordinator.close(attemptId);
        sendJson(response, 200, toProtocolJson(result, "localExecutionResult"));
      } catch (error) {
        if (error instanceof LocalExecutionCoordinatorError) {
          const status = error.code === "ATTEMPT_NOT_FOUND" ? 404
            : error.code === "ATTEMPT_STATE_CONFLICT" || error.code === "ATTEMPT_BINDING_MISMATCH" ? 409
              : 400;
          reject(response, status, error.code, error.message);
          return;
        }
        reject(response, 502, "LOCAL_EXECUTION_FAILED", "Local execution coordination failed closed.");
      }
      return;
    }

    const solanaLocalActionMatch = url.search === ""
      ? /^\/internal\/terminal\/attempts\/(local-atomic-[0-9a-f]{64})\/solana-local\/(prepare|submit|reconcile)$/.exec(url.pathname)
      : null;
    if (solanaLocalActionMatch !== null) {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
        return;
      }
      if (solanaLocalExecution === undefined) {
        reject(response, 503, "SOLANA_LOCAL_EXECUTION_UNAVAILABLE", "Manifest-validated local Solana execution is unavailable.");
        return;
      }
      const attemptId = solanaLocalActionMatch[1] as string;
      const action = solanaLocalActionMatch[2] as string;
      try {
        const submission = action === "submit" ? await readJson(request) as {
          signedTransactionBase64?: string;
          signature?: string;
        } : undefined;
        if (action === "submit") {
          await requireExecutionReadiness("SOLANA_LOCAL_SUBMIT", {
            attemptId,
            idempotencyKey: attemptId,
          });
        }
        const result = action === "prepare"
          ? await solanaLocalExecution.prepare(attemptId)
          : action === "reconcile"
            ? await solanaLocalExecution.reconcile(attemptId)
            : await solanaLocalExecution.submit(attemptId, submission!);
        sendJson(response, 200, result);
      } catch (error) {
        if (rejectReadiness(response, error)) return;
        reject(response, 409, "SOLANA_LOCAL_EXECUTION_FAILED", "Manifest-validated local Solana execution failed closed.");
      }
      return;
    }

    if (url.pathname.startsWith("/internal/terminal/orders/")) {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        reject(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
        return;
      }
      if (!hasOrderPorts(orderPorts)) {
        reject(response, 503, "ORDER_CREATION_UNAVAILABLE", "Order creation is unavailable.");
        return;
      }
      const orderHash = url.pathname.slice("/internal/terminal/orders/".length);
      try {
        const coordinator = new InternalOrderCoordinator(orderPorts);
        const record = coordinator.getOrder(orderHash);
        if (record === undefined) {
          reject(response, 404, "ORDER_NOT_FOUND", "Order was not found.");
          return;
        }
        sendJson(response, 200, record);
      } catch (error) {
        if (error instanceof TerminalOrderValidationError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 502, "ORDER_RETRIEVAL_FAILED", "Order retrieval failed closed.");
      }
      return;
    }

    reject(response, 404, "NOT_FOUND", "Route not found.");
  };
}

export function createPrivateTerminalServer(
  config: PrivateTerminalServerConfig,
  executionPorts: PrivateTerminalExecutionPorts = {},
  orderPorts?: InternalOrderPorts,
  hyperliquidTestnetExecutionPort?: HyperliquidTestnetTerminalExecutionPort,
  evmTestnetPorts: EvmTestnetTerminalPorts = {},
  lifecycleStore?: PackageLifecycleStore,
  solverQuotePort?: SolverAtomicQuotePort,
  executionIntentStore?: ExecutionIntentStore,
  localExecutionCoordinator?: LocalExecutionCoordinator,
  runtimeHealth?: PrivateTerminalRuntimeHealth,
  localAtomicRuntimeMode: LocalAtomicRuntimeMode = "DISABLED",
  solanaLocalExecution?: SolanaLocalExecutionService,
  hyperliquidTestnetPreparationPort?: HyperliquidTestnetPreparationPort,
  hyperliquidTestnetContext?: HyperliquidTestnetTerminalContext,
  executionReadinessGate?: ExecutionReadinessGate<ExecutionReadinessScopeIdentity>,
  executionReadinessScopes?: ExecutionReadinessScopeResolver<ExecutionReadinessScopeIdentity>,
  publicRoutes?: (request: IncomingMessage, response: ServerResponse) => boolean,
  terminalMarkets: TerminalMarketSources = {},
  attemptOutcomes?: OwnerPackageOutcomeReader,
  strategyExecutionCapabilities: () => readonly StrategyExecutionLaneCapability[] = () => [],
  generalizedStrategyPreparation?: GeneralizedStrategyPreparationPort,
  hyperliquidGeneralizedOrder?: HyperliquidGeneralizedOrderPort,
  generalizedStrategyExecutions?: GeneralizedStrategyExecutionPort,
  strategyPackageAuthorization?: StrategyPackageAuthorizationPort,
  nativeHyperliquidStrategyRuntime?: NativeHyperliquidStrategyRuntime,
  hyperliquidNativeStrategyOrders?: HyperliquidNativeStrategyOrderPort,
  evmOptionSpreadOrders?: EvmOptionSpreadOrderPort,
) {
  const handler = createPrivateTerminalRequestHandler(
    config,
    executionPorts,
    orderPorts,
    hyperliquidTestnetExecutionPort,
    evmTestnetPorts,
    lifecycleStore,
    solverQuotePort,
    executionIntentStore,
    localExecutionCoordinator,
    runtimeHealth,
    localAtomicRuntimeMode,
    solanaLocalExecution,
    hyperliquidTestnetPreparationPort,
    hyperliquidTestnetContext,
    executionReadinessGate,
    executionReadinessScopes,
    terminalMarkets,
    Date.now,
    attemptOutcomes,
    strategyExecutionCapabilities,
    generalizedStrategyPreparation,
    hyperliquidGeneralizedOrder,
    generalizedStrategyExecutions,
    strategyPackageAuthorization,
    nativeHyperliquidStrategyRuntime,
    hyperliquidNativeStrategyOrders,
    evmOptionSpreadOrders,
  );
  return createServer((request, response) => {
    // WHATWG URL parsing turns a backslash into a path separator, so a raw path a proxy matched as
    // one route could resolve to another here. No route uses one; refuse it before any routing.
    if ((request.url ?? "").includes("\\")) {
      reject(response, 400, "INVALID_PATH", "Request path is invalid.");
      return;
    }
    // Every browser route, including the lane routes mounted ahead of the private handler (Solana
    // account, faucet, and exit order; Arbitrum owner routes), answers under the one origin policy,
    // and its preflight is answered here.
    if ((request.url ?? "").startsWith("/internal/terminal/")) {
      if (!applyCors(request, response, config.terminalOrigin)) return;
      if (request.method === "OPTIONS") {
        if (request.headers.origin === undefined) {
          reject(response, 403, "ORIGIN_REQUIRED", "Preflight requires an allowed browser origin.");
        } else {
          response.statusCode = 204;
          response.end();
        }
        return;
      }
    }
    // Public read-only routes answer before the private terminal's origin policy; every other
    // path falls through to the private handler unchanged.
    let handledPublicly = false;
    try {
      handledPublicly = publicRoutes?.(request, response) ?? false;
    } catch {
      reject(response, 500, "INTERNAL_ERROR", "Request handling failed.");
      return;
    }
    if (handledPublicly) return;
    handler(request, response).catch(() => {
      if (!response.headersSent) {
        reject(response, 500, "INTERNAL_ERROR", "Request handling failed.");
      } else {
        response.destroy();
      }
    });
  });
}
