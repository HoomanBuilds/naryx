import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createMarketStream } from "./market-stream.js";
import { domainRefFromManifest, parseProtocolJson, protocolId, toHex } from "@naryx/protocol-types";
import { prepareBaseAccountExit, prepareBoundCashCarryOpen } from "./strategy-open-preparation.js";
import { createBaseAccountReceiptResolver } from "./base-account-receipt.js";
import type { SqlitePreparedEvmTestnetAtomicStore } from "./evm-testnet-prepared-store.js";
import type {
  EconomicStrategySeriesSupportInput,
  SeriesExecutionClassSupportInput,
  DomainRegistryRecordInput,
  DomainResourceLimit,
  SolverCapabilityManifestInput,
  PackageOrder,
} from "@naryx/protocol-types";
import { SqlitePackageExchangeStore } from "./package-exchange-store.js";
import { createPackageBookClock, createPublicApiHandler } from "./public-api.js";
import { SqliteRegistryStore } from "./registry-store.js";
import { createSolverApiHandler, createSolverStream, type AdmissionContext } from "./solver-api.js";
import { SqliteSolverApiStore } from "./solver-api-store.js";
import { SqlitePrivateDeliveryStore } from "./private-delivery-store.js";
import { SqliteEvidenceStore } from "./evidence-store.js";
import { SqliteQualificationStore } from "./qualification-store.js";
import { SqlitePositionSnapshotStore } from "./position-snapshot-store.js";
import { SqliteCollateralSnapshotStore } from "./collateral-snapshot-store.js";
import { createCatalogueIssuer } from "./market-catalogue-issuer.js";
import { SqliteStrategyBookStore } from "./strategy-book-store.js";
import { ThresholdAuctionBackend } from './threshold-auction.js';
import { createEvmBondReader } from "./evm-bond-reader.js";
import { SqliteBuilderStore } from "./builder-store.js";
import { createKeeperExecutorHandler, keeperClock, SqliteKeeperExecutor } from "./keeper-executor.js";
import { createCoordinationInternalHandler, SqliteCoordinationStore } from "./coordination-store.js";
import { createStrategyPackageInternalHandler, SqliteStrategyPackageStore } from "./strategy-package-store.js";
import { SqliteOrderActivationStore } from "./order-activation-store.js";
import { createOrderActivationAdminHandler } from "./order-activation-admin.js";
import { createOrderActivationOwnerHandler } from "./order-activation-owner-routes.js";
import { AdvancedOrderFactory } from "./advanced-order-factory.js";
import { AdvancedOrderExecutionFactory } from "./advanced-order-execution-factory.js";
import { AdvancedOrderReconciliation, reconcilePendingAdvancedOrders } from "./advanced-order-reconciliation.js";
import { loadMetricObservationSources, SqliteMetricObservationStore } from "./metric-observation-store.js";
import { createMetricObservationAdminHandler } from "./metric-observation-admin.js";
import { createPackageReopeningAdminHandler } from "./package-reopening-admin.js";
import { HttpGeneralizedStrategyQuoteClient } from "./generalized-strategy-quote-client.js";
import { HttpPortfolioOptimizationClient } from './portfolio-optimization-client.js';
import { AuthoritativePortfolioOptimization } from "./authoritative-portfolio-optimization.js";
import {
  HttpHyperliquidCrossBatchResidualExecutionClient,
  HttpHyperliquidNettingResidualExecutionClient,
} from "./hyperliquid-netting-residual-execution-client.js";
import {
  HttpBaseSepoliaCrossBatchResidualExecutionClient,
  HttpBaseSepoliaNettingResidualExecutionClient,
} from "./base-sepolia-netting-residual-execution-client.js";
import {
  HttpSolanaDevnetCrossBatchResidualExecutionClient,
  HttpSolanaDevnetNettingResidualExecutionClient,
} from "./solana-devnet-netting-residual-execution-client.js";
import {
  NettingExecutionCoordinator,
  NettingExternalExecutionRouter,
} from "./netting-execution-coordinator.js";
import {
  CrossBatchClearingCoordinator,
  CrossBatchExternalExecutionRouter,
} from "./cross-batch-clearing-coordinator.js";
import { createCrossBatchClearingAdminHandler } from "./cross-batch-clearing-admin.js";
import { createNativeClearingAdminHandler } from './native-clearing-admin.js';
import { SqliteNativeClearingStore } from './native-clearing-store.js';
import { loadNativeClearingBacking } from './native-clearing-backing.js';
import { SqliteNettingAllocationAttemptStore } from "./netting-allocation-attempt-store.js";
import {
  EvmNettingAllocationObservationRoute,
  SolanaNettingAllocationObservationRoute,
} from "./netting-allocation-observation-routes.js";
import {
  NettingAllocationObservationRouter,
  NettingAllocationSettlementCoordinator,
} from "./netting-allocation-settlement-coordinator.js";
import { createNettingAllocationAdminHandler } from "./netting-allocation-admin.js";
import { createNettingBatchAdminHandler, createNettingBatchExecutionHandler } from "./netting-batch-admin.js";
import { prepareNextAuthoritativeNettingBatch } from "./authoritative-netting.js";
import { prepareNextAuthoritativeCrossBatchClearing } from './authoritative-cross-batch-clearing.js';
import {
  createViemBaseSepoliaReadClient,
  loadBaseSepoliaRuntimeManifest,
} from "./base-sepolia-runtime.js";
import {
  loadSolanaDevnetRuntimeManifest,
} from "./solana-devnet-runtime.js";
import { HttpSolanaDevnetReadOnlyRpc } from "./solana-devnet-runtime-ports.js";
import { applyPublicMarketBootstrap, loadPublicMarketBootstrap } from "./public-market-bootstrap.js";
import { createMakerOperationsHandler } from "./maker-operations.js";
import {
  createStrategyOrderIntake,
  type StrategyOrderIntakePort,
} from "./strategy-order-intake.js";
import bs58 from "bs58";
import { createBaseStrategyTransferContext, createBaseStrategyTransferVerifier } from "./base-strategy-transfer-verifier.js";

const MAX_SUPPORT_MANIFEST_BYTES = 65_536;
const MAX_ADMISSION_CONTEXT_BYTES = 1_048_576;
const DEFAULT_REQUESTS_PER_MINUTE = 120;

export type PublicMarketClockUnit = "UNIX_SECONDS" | "UNIX_MILLISECONDS";

export interface PublicMarketRuntime {
  readonly handler: (request: IncomingMessage, response: ServerResponse) => boolean;
  /**
   * When set, the public and solver APIs run on their own listener that never serves the private
   * terminal routes, so exposing them does not expose `/internal`.
   */
  readonly listener?: { readonly host: string; readonly port: number };
  /** Takes WebSocket upgrades for `/v1/stream` and, with the solver API, `/v1/solver/stream`; false for any other path. */
  readonly upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  readonly clockUnit: PublicMarketClockUnit;
  readonly requestsPerMinute: number;
  readonly solverApiEnabled: boolean;
  /** Canonical strategy-order admission shared with the private terminal when configured. */
  readonly strategyOrderIntake?: StrategyOrderIntakePort;
  /** Immutable provenance for strategy orders derived from an owner-authorized canonical order. */
  readonly strategyPackageSources?: Pick<SqliteStrategyPackageStore, "bindSourceOrder" | "sourceBinding">;
  /** Durable selection and lookup for generalized Hyperliquid Testnet execution attempts. */
  readonly strategyPackageExecutions?: Pick<
    SqliteStrategyPackageStore,
    "selectHyperliquidExecution" | "selectNativeHyperliquidExecution"
      | "strategyExecutionAttempt" | "nativeStrategyExecutionAttempt" | "anyStrategyExecutionAttempt" | "admissionByQuote"
      | "ownerAuthorization" | "recordReceipt" | "nativeStrategyPositionByStateHash" | "nativeStrategyPositionsByOwner" | "quotes"
      | "nativeStrategyExposures" | "onNativeStrategyReduction" | "receiptByQuote" | "nativeStrategyReduction"
      | "sourceBackedStrategyAttempts"
      | "recordEvmStrategyPosition" | "queueEvmStrategyObservation" | "pendingEvmStrategyObservations"
      | "touchEvmStrategyObservation" | "completeEvmStrategyObservation"
  >;
  /** Immutable owner approval for an exact generalized strategy order. */
  readonly strategyPackageAuthorizations?: Pick<SqliteStrategyPackageStore, "order" | "ownerAuthorization" | "recordOwnerAuthorization">;
  /** Loopback keeper executor and coordinator routes under `/internal/`; mount only on the private server. */
  readonly internalHandler?: (request: IncomingMessage, response: ServerResponse) => boolean;
  readonly reconcileAdvancedOrders?: () => { completed: number; pending: number; failed: number; expired: number };
  closeStreams?(): void;
  close(): void;
}

export class PublicMarketConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicMarketConfigError";
  }
}

function absolute(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new PublicMarketConfigError(`${name} is required when the public market API is enabled.`);
  if (!isAbsolute(value)) throw new PublicMarketConfigError(`${name} must be an absolute path.`);
  return resolve(value);
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new PublicMarketConfigError(`Support manifest field ${field} must be a nonempty list of identifiers.`);
  }
  return value as readonly string[];
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PublicMarketConfigError(`Support manifest field ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * `{ "version": 1, "contexts": { "<domainId>": AdmissionContext } }` in protocol JSON: the domain
 * manifest, template manifest and registry record, fee policy, and active registry records each
 * domain's packages are admitted against. Each context must be keyed by its own domain.
 */
function loadAdmissionContexts(path: string): ReadonlyMap<string, AdmissionContext> {
  if (statSync(path).size > MAX_ADMISSION_CONTEXT_BYTES) throw new PublicMarketConfigError("Admission contexts file is too large.");
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(readFileSync(path, "utf8"));
  } catch {
    throw new PublicMarketConfigError("Admission contexts file is not valid protocol JSON.");
  }
  const root = object(parsed, "root");
  if (Object.keys(root).sort().join(",") !== "contexts,version" || root.version !== 1) {
    throw new PublicMarketConfigError("Admission contexts file must be version 1 with exactly version and contexts.");
  }
  const contexts = new Map<string, AdmissionContext>();
  for (const [domainId, value] of Object.entries(object(root.contexts, "contexts"))) {
    const context = object(value, `contexts.${domainId}`);
    const domainManifest = object(context.domainManifest, `contexts.${domainId}.domainManifest`);
    if (domainManifest.domainId !== domainId) throw new PublicMarketConfigError(`Admission context ${domainId} carries another domain's manifest.`);
    for (const field of ["templateManifest", "templateRegistryRecord", "feePolicyManifest"]) object(context[field], `contexts.${domainId}.${field}`);
    if (!Array.isArray(context.activeRegistryRecords)) throw new PublicMarketConfigError(`Admission context ${domainId} needs activeRegistryRecords.`);
    contexts.set(domainId, context as unknown as AdmissionContext);
  }
  if (contexts.size === 0) throw new PublicMarketConfigError("Admission contexts file names no domain.");
  return contexts;
}

/** `{ "version": 1, "activeRegistryRecords": [...], "resourceLimits": [...] }` in protocol JSON, for graph compilation. */
function loadGraphContext(path: string): { activeRegistryRecords: readonly DomainRegistryRecordInput[]; resourceLimits: readonly DomainResourceLimit[] } {
  if (statSync(path).size > MAX_ADMISSION_CONTEXT_BYTES) throw new PublicMarketConfigError("Graph compilation context file is too large.");
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(readFileSync(path, "utf8"));
  } catch {
    throw new PublicMarketConfigError("Graph compilation context file is not valid protocol JSON.");
  }
  const root = object(parsed, "root");
  if (Object.keys(root).sort().join(",") !== "activeRegistryRecords,resourceLimits,version" || root.version !== 1) {
    throw new PublicMarketConfigError("Graph compilation context must be version 1 with exactly activeRegistryRecords and resourceLimits.");
  }
  if (!Array.isArray(root.activeRegistryRecords) || !Array.isArray(root.resourceLimits) || root.resourceLimits.length === 0) {
    throw new PublicMarketConfigError("Graph compilation context needs registry records and at least one domain resource limit.");
  }
  return { activeRegistryRecords: root.activeRegistryRecords as DomainRegistryRecordInput[], resourceLimits: root.resourceLimits as DomainResourceLimit[] };
}

function loadSupport(path: string): {
  clockUnit: PublicMarketClockUnit;
  seriesSupport: EconomicStrategySeriesSupportInput;
  executionClassSupport: SeriesExecutionClassSupportInput;
  backingAtomsPerPackageUnit: ReadonlyMap<string, { readonly commitment: bigint; readonly legs: readonly bigint[]; readonly quantityScale?: bigint }>;
  packageSourceBackingAtomsPerUnit: ReadonlyMap<string, bigint>;
} {
  if (statSync(path).size > MAX_SUPPORT_MANIFEST_BYTES) throw new PublicMarketConfigError("Support manifest is too large.");
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(readFileSync(path, "utf8"));
  } catch {
    throw new PublicMarketConfigError("Support manifest is not valid protocol JSON.");
  }
  const manifest = object(parsed, "root");
  const keys = Object.keys(manifest)
    .filter((key) => key !== "backingAtomsPerPackageUnit" && key !== "packageSourceBackingAtomsPerUnit")
    .sort();
  if (keys.join(",") !== "clockUnit,executionClassSupport,seriesSupport,version" || manifest.version !== 1) {
    throw new PublicMarketConfigError("Support manifest must be version 1 with clockUnit, seriesSupport, executionClassSupport, and optional backing unit maps.");
  }
  // Committed atoms per package unit of implied liquidity, by execution class; classes without one take none.
  const units = new Map<string, { commitment: bigint; legs: bigint[]; quantityScale?: bigint }>();
  for (const [classId, value] of Object.entries(manifest.backingAtomsPerPackageUnit === undefined ? {} : object(manifest.backingAtomsPerPackageUnit, "backingAtomsPerPackageUnit"))) {
    const entry = object(value, `backingAtomsPerPackageUnit.${classId}`);
    const positive = (atoms: unknown) => typeof atoms === "bigint" && atoms > 0n && atoms < (1n << 128n);
    if (Object.keys(entry).some(key => !["commitment", "legs", "quantityScale"].includes(key))
      || !positive(entry.commitment) || !Array.isArray(entry.legs) || entry.legs.length === 0 || !entry.legs.every(positive)
      || (entry.quantityScale !== undefined && !positive(entry.quantityScale))) {
      throw new PublicMarketConfigError(`backingAtomsPerPackageUnit.${classId} needs a positive commitment and positive per-leg atoms.`);
    }
    units.set(classId, { commitment: entry.commitment as bigint, legs: entry.legs as bigint[],
      ...(entry.quantityScale === undefined ? {} : { quantityScale: entry.quantityScale as bigint }) });
  }
  const packageSourceUnits = new Map<string, bigint>();
  for (const [seriesId, atoms] of Object.entries(
    manifest.packageSourceBackingAtomsPerUnit === undefined
      ? {}
      : object(manifest.packageSourceBackingAtomsPerUnit, "packageSourceBackingAtomsPerUnit"),
  )) {
    if (typeof atoms !== "bigint" || atoms <= 0n) {
      throw new PublicMarketConfigError(`packageSourceBackingAtomsPerUnit.${seriesId} must be positive atoms.`);
    }
    packageSourceUnits.set(seriesId, atoms);
  }
  if (manifest.clockUnit !== "UNIX_SECONDS" && manifest.clockUnit !== "UNIX_MILLISECONDS") {
    throw new PublicMarketConfigError("Support manifest clockUnit must be UNIX_SECONDS or UNIX_MILLISECONDS; slot-timed books need a slot source.");
  }
  const series = object(manifest.seriesSupport, "seriesSupport");
  const classes = object(manifest.executionClassSupport, "executionClassSupport");
  return {
    clockUnit: manifest.clockUnit,
    seriesSupport: {
      supportedTemplateIds: stringList(series.supportedTemplateIds, "seriesSupport.supportedTemplateIds"),
      supportedQuoteConventionIds: stringList(series.supportedQuoteConventionIds, "seriesSupport.supportedQuoteConventionIds"),
      supportedRiskClassIds: stringList(series.supportedRiskClassIds, "seriesSupport.supportedRiskClassIds"),
      supportedLifecycleConventionIds: stringList(series.supportedLifecycleConventionIds, "seriesSupport.supportedLifecycleConventionIds"),
    },
    executionClassSupport: {
      supportedVenueClassIds: stringList(classes.supportedVenueClassIds, "executionClassSupport.supportedVenueClassIds"),
      supportedCollateralModeIds: stringList(classes.supportedCollateralModeIds, "executionClassSupport.supportedCollateralModeIds"),
      supportedSettlementClasses: stringList(
        classes.supportedSettlementClasses,
        "executionClassSupport.supportedSettlementClasses",
      ) as SeriesExecutionClassSupportInput["supportedSettlementClasses"],
      supportedFirmnessClassIds: stringList(classes.supportedFirmnessClassIds, "executionClassSupport.supportedFirmnessClassIds"),
    },
    backingAtomsPerPackageUnit: units,
    packageSourceBackingAtomsPerUnit: packageSourceUnits,
  };
}

/** `keyId:base58Ed25519Key` pairs, comma separated: the keys allowed to sign qualification records. */
function qualificationAuthorities(value: string | undefined): ReadonlyMap<string, Uint8Array> {
  return authorityKeys(value, "NARYX_QUALIFICATION_DB", "NARYX_QUALIFICATION_AUTHORITIES");
}

/** `keyId:base58Ed25519Key` pairs, comma separated. */
function authorityKeys(value: string | undefined, database: string, variable: string): ReadonlyMap<string, Uint8Array> {
  if (value === undefined || value.trim() === "") {
    throw new PublicMarketConfigError(`${database} requires ${variable}.`);
  }
  const authorities = new Map<string, Uint8Array>();
  for (const entry of value.split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    const [keyId, encoded, extra] = entry.split(":");
    let key: Uint8Array | undefined;
    try {
      key = encoded === undefined ? undefined : bs58.decode(encoded);
    } catch {
      key = undefined;
    }
    if (extra !== undefined || keyId === undefined || !/^[A-Za-z0-9._-]{1,128}$/.test(keyId) || key?.length !== 32 || authorities.has(keyId)) {
      throw new PublicMarketConfigError(`${variable} must list distinct keyId:base58 Ed25519 keys.`);
    }
    authorities.set(keyId, key);
  }
  return authorities;
}

/**
 * The catalogue authority's Ed25519 PKCS#8 PEM key, which signs the market catalogue on the
 * server. NARYX_CATALOGUE_AUTHORITY names it and NARYX_PUBLIC_ENVIRONMENT names the environment.
 */
function loadCatalogueSigner(environment: NodeJS.ProcessEnv): { authority: string; environment: string; signHash: (hash: Uint8Array) => Uint8Array } | undefined {
  const keyPath = environment.NARYX_CATALOGUE_KEY_FILE;
  if (keyPath === undefined || keyPath === "") return undefined;
  const authority = environment.NARYX_CATALOGUE_AUTHORITY;
  if (authority === undefined || !/^[A-Za-z0-9._-]{1,128}$/.test(authority)) {
    throw new PublicMarketConfigError("NARYX_CATALOGUE_KEY_FILE requires NARYX_CATALOGUE_AUTHORITY, the signing key id.");
  }
  const publicEnvironment = environment.NARYX_PUBLIC_ENVIRONMENT;
  if (publicEnvironment === undefined || !/^[A-Za-z0-9._:-]{1,64}$/.test(publicEnvironment) || publicEnvironment.toLowerCase().includes("mainnet")) {
    throw new PublicMarketConfigError("NARYX_CATALOGUE_KEY_FILE requires NARYX_PUBLIC_ENVIRONMENT, a non-mainnet environment id.");
  }
  const path = absolute(keyPath, "NARYX_CATALOGUE_KEY_FILE");
  if (statSync(path).size > 4_096) throw new PublicMarketConfigError("NARYX_CATALOGUE_KEY_FILE is too large to be a key.");
  let key;
  try {
    key = createPrivateKey(readFileSync(path, "utf8"));
  } catch {
    throw new PublicMarketConfigError("NARYX_CATALOGUE_KEY_FILE must hold a PKCS#8 PEM private key.");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new PublicMarketConfigError("NARYX_CATALOGUE_KEY_FILE must hold an Ed25519 key.");
  return { authority, environment: publicEnvironment, signHash: (hash) => new Uint8Array(sign(null, hash, key)) };
}

/**
 * NARYX_BOND_READER_CONFIG names an absolute JSON file: `rpcUrl`, `chainId`, `vault`, `solvers`
 * (address to solver id), and `assets` (address to asset reference). FIRM_BONDED quotes are refused without it.
 */
function loadBondReader(path: string) {
  let raw: Record<string, unknown>;
  try {
    raw = parseProtocolJson(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new PublicMarketConfigError("NARYX_BOND_READER_CONFIG must be protocol JSON.");
  }
  const solvers = object(raw.solvers, "solvers");
  const assets = object(raw.assets, "assets");
  if (typeof raw.rpcUrl !== "string" || typeof raw.vault !== "string"
    || typeof raw.chainId !== "number" || !Number.isSafeInteger(raw.chainId) || raw.chainId <= 0) {
    throw new PublicMarketConfigError("NARYX_BOND_READER_CONFIG needs rpcUrl, a positive integer chainId, and vault.");
  }
  return createEvmBondReader({
    rpcUrl: raw.rpcUrl,
    chainId: BigInt(raw.chainId),
    vault: raw.vault,
    solverByAddress: new Map(Object.entries(solvers).map(([address, id]) => [address.toLowerCase(), String(id)])),
    assetByAddress: new Map(Object.entries(assets).map(([address, asset]) => [address.toLowerCase(), asset as never])),
  });
}

function activationDelay(value: string | undefined): bigint {
  if (value === undefined || !/^(0|[1-9]\d{0,18})$/.test(value)) {
    throw new PublicMarketConfigError("NARYX_QUALIFICATION_DB requires NARYX_QUALIFICATION_ACTIVATION_DELAY in the records' time unit.");
  }
  return BigInt(value);
}

function loadSolverCapabilityManifests(path: string): readonly SolverCapabilityManifestInput[] {
  let value: unknown;
  try {
    value = parseProtocolJson(readFileSync(path, "utf8"), "solverCapabilityManifests");
  } catch (error) {
    throw new PublicMarketConfigError(
      `NARYX_SOLVER_CAPABILITY_MANIFESTS is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "manifests,version") {
    throw new PublicMarketConfigError("NARYX_SOLVER_CAPABILITY_MANIFESTS must contain only version and manifests.");
  }
  const document = value as { version?: unknown; manifests?: unknown };
  if (document.version !== 1 || !Array.isArray(document.manifests) || document.manifests.length === 0) {
    throw new PublicMarketConfigError("NARYX_SOLVER_CAPABILITY_MANIFESTS must contain at least one version 1 manifest.");
  }
  return document.manifests as readonly SolverCapabilityManifestInput[];
}

/**
 * Loads the public v1 API. It is off unless NARYX_PUBLIC_MARKET_ENABLED is exactly "true", and
 * then requires an absolute exchange database path and support manifest; NARYX_REGISTRY_DB, when
 * set, enables the registry routes, and NARYX_SOLVER_API_DB (which requires the registry) enables
 * the authenticated solver API. Public routes serve reads, computation, and the explicit durable
 * strategy package submission route when its store is configured.
 */
export function loadPublicMarketRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  clockMs: () => number = Date.now,
  unitClock?: (unit: string) => bigint | undefined,
  canonicalOrder?: (hash: string) => PackageOrder | undefined,
  baseReceipts?: SqlitePreparedEvmTestnetAtomicStore,
): PublicMarketRuntime | undefined {
  const enabled = environment.NARYX_PUBLIC_MARKET_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") throw new PublicMarketConfigError("NARYX_PUBLIC_MARKET_ENABLED must be true or false.");
  if (enabled === "false") return undefined;
  const databasePath = absolute(environment.NARYX_EXCHANGE_DB, "NARYX_EXCHANGE_DB");
  const support = loadSupport(absolute(environment.NARYX_EXCHANGE_SUPPORT_MANIFEST, "NARYX_EXCHANGE_SUPPORT_MANIFEST"));
  const rawRate = environment.NARYX_PUBLIC_MARKET_REQUESTS_PER_MINUTE ?? String(DEFAULT_REQUESTS_PER_MINUTE);
  if (!/^[1-9]\d{0,4}$/.test(rawRate) || Number(rawRate) > 10_000) {
    throw new PublicMarketConfigError("NARYX_PUBLIC_MARKET_REQUESTS_PER_MINUTE must be between 1 and 10000.");
  }
  const requestsPerMinute = Number(rawRate);
  const rawSolverRate = environment.NARYX_SOLVER_REQUESTS_PER_MINUTE ?? rawRate;
  if (!/^[1-9]\d{0,4}$/.test(rawSolverRate) || Number(rawSolverRate) > 10_000) {
    throw new PublicMarketConfigError("NARYX_SOLVER_REQUESTS_PER_MINUTE must be between 1 and 10000.");
  }
  const rawPort = environment.NARYX_PUBLIC_API_PORT;
  let listener: { host: string; port: number } | undefined;
  if (rawPort !== undefined && rawPort !== "") {
    if (!/^[1-9]\d{0,4}$/.test(rawPort) || Number(rawPort) > 65_535) {
      throw new PublicMarketConfigError("NARYX_PUBLIC_API_PORT must be a port between 1 and 65535.");
    }
    const host = environment.NARYX_PUBLIC_API_HOST ?? "127.0.0.1";
    if (!/^[0-9A-Fa-f.:]{2,45}$/.test(host)) throw new PublicMarketConfigError("NARYX_PUBLIC_API_HOST must be an IP address.");
    listener = { host, port: Number(rawPort) };
  } else if (environment.NARYX_PUBLIC_API_HOST !== undefined) {
    throw new PublicMarketConfigError("NARYX_PUBLIC_API_HOST requires NARYX_PUBLIC_API_PORT.");
  }
  const registryPath = environment.NARYX_REGISTRY_DB;
  const solverPath = environment.NARYX_SOLVER_API_DB;
  const optional = (value: string | undefined) => (value === undefined || value === "" ? undefined : value);
  if (optional(solverPath) !== undefined && optional(registryPath) === undefined) {
    throw new PublicMarketConfigError("NARYX_SOLVER_API_DB requires NARYX_REGISTRY_DB, which authenticates solvers.");
  }
  const opened: { close(): void }[] = [];
  try {
    const store = new SqlitePackageExchangeStore(databasePath, {
      seriesSupport: support.seriesSupport,
      executionClassSupport: support.executionClassSupport,
    });
    opened.push(store);
    const registry = optional(registryPath) === undefined ? undefined : new SqliteRegistryStore(absolute(registryPath, "NARYX_REGISTRY_DB"));
    if (registry !== undefined) opened.push(registry);
    const bootstrapPath = optional(environment.NARYX_PUBLIC_MARKET_BOOTSTRAP);
    if (bootstrapPath !== undefined) {
      if (registry === undefined) {
        throw new PublicMarketConfigError("NARYX_PUBLIC_MARKET_BOOTSTRAP requires NARYX_REGISTRY_DB.");
      }
      const publicEnvironment = environment.NARYX_PUBLIC_ENVIRONMENT;
      if (publicEnvironment === undefined || !/^[A-Za-z0-9._:-]{1,64}$/.test(publicEnvironment)) {
        throw new PublicMarketConfigError("NARYX_PUBLIC_MARKET_BOOTSTRAP requires NARYX_PUBLIC_ENVIRONMENT.");
      }
      applyPublicMarketBootstrap(
        loadPublicMarketBootstrap(absolute(bootstrapPath, "NARYX_PUBLIC_MARKET_BOOTSTRAP"), publicEnvironment),
        store,
        registry,
      );
    }
    const solverCapabilityPath = optional(environment.NARYX_SOLVER_CAPABILITY_MANIFESTS);
    if (solverCapabilityPath !== undefined) {
      if (registry === undefined) {
        throw new PublicMarketConfigError("NARYX_SOLVER_CAPABILITY_MANIFESTS requires NARYX_REGISTRY_DB.");
      }
      for (const manifest of loadSolverCapabilityManifests(
        absolute(solverCapabilityPath, "NARYX_SOLVER_CAPABILITY_MANIFESTS"),
      )) {
        registry.registerSolverManifest(manifest);
      }
    }
    const solverState = optional(solverPath) === undefined ? undefined : new SqliteSolverApiStore(absolute(solverPath, "NARYX_SOLVER_API_DB"));
    if (solverState !== undefined) opened.push(solverState);
    const deliveryPath = optional(environment.NARYX_PRIVATE_DELIVERY_DB);
    if (deliveryPath !== undefined && solverState === undefined) {
      throw new PublicMarketConfigError("NARYX_PRIVATE_DELIVERY_DB requires the solver API, which authenticates recipients.");
    }
    const delivery = deliveryPath === undefined ? undefined : new SqlitePrivateDeliveryStore(absolute(deliveryPath, "NARYX_PRIVATE_DELIVERY_DB"));
    if (delivery !== undefined) opened.push(delivery);
    const evidencePath = optional(environment.NARYX_EVIDENCE_DB);
    const evidence = evidencePath === undefined ? undefined : new SqliteEvidenceStore(absolute(evidencePath, "NARYX_EVIDENCE_DB"));
    if (evidence !== undefined) opened.push(evidence);
    const qualificationPath = optional(environment.NARYX_QUALIFICATION_DB);
    const qualification = qualificationPath === undefined
      ? undefined
      : new SqliteQualificationStore(absolute(qualificationPath, "NARYX_QUALIFICATION_DB"), {
        authorities: qualificationAuthorities(environment.NARYX_QUALIFICATION_AUTHORITIES),
        minimumActivationDelay: activationDelay(environment.NARYX_QUALIFICATION_ACTIVATION_DELAY),
      });
    if (qualification !== undefined) opened.push(qualification);
    const positionPath = optional(environment.NARYX_POSITION_DB);
    const positions = positionPath === undefined
      ? undefined
      : new SqlitePositionSnapshotStore(absolute(positionPath, "NARYX_POSITION_DB"), {
        authorities: authorityKeys(environment.NARYX_POSITION_AUTHORITIES, "NARYX_POSITION_DB", "NARYX_POSITION_AUTHORITIES"),
        clock: clockMs,
      });
    if (positions !== undefined) opened.push(positions);
    const collateralPath = optional(environment.NARYX_COLLATERAL_DB);
    const collateralEnvironment = environment.NARYX_PUBLIC_ENVIRONMENT;
    if (collateralPath !== undefined && (
      collateralEnvironment === undefined
      || !/^[A-Za-z0-9._:-]{1,64}$/.test(collateralEnvironment)
      || collateralEnvironment.toLowerCase().includes("mainnet")
    )) {
      throw new PublicMarketConfigError("NARYX_COLLATERAL_DB requires NARYX_PUBLIC_ENVIRONMENT, a non-mainnet environment id.");
    }
    const collateral = collateralPath === undefined
      ? undefined
      : new SqliteCollateralSnapshotStore(absolute(collateralPath, "NARYX_COLLATERAL_DB"), {
        environment: collateralEnvironment as string,
        authorities: authorityKeys(environment.NARYX_COLLATERAL_AUTHORITIES, "NARYX_COLLATERAL_DB", "NARYX_COLLATERAL_AUTHORITIES"),
        clock: clockMs,
      });
    if (collateral !== undefined) opened.push(collateral);
    const graphContextPath = optional(environment.NARYX_GRAPH_COMPILE_CONTEXT);
    const graphContext = graphContextPath === undefined ? undefined : loadGraphContext(absolute(graphContextPath, "NARYX_GRAPH_COMPILE_CONTEXT"));
    const strategyPackagePath = optional(environment.NARYX_STRATEGY_PACKAGE_DB);
    if (strategyPackagePath !== undefined && (graphContext === undefined || registry === undefined)) {
      throw new PublicMarketConfigError("NARYX_STRATEGY_PACKAGE_DB requires NARYX_GRAPH_COMPILE_CONTEXT and NARYX_REGISTRY_DB for admission.");
    }
    const strategyPackages = strategyPackagePath === undefined
      ? undefined
      : new SqliteStrategyPackageStore(absolute(strategyPackagePath, "NARYX_STRATEGY_PACKAGE_DB"), { clock: clockMs });
    if (strategyPackages !== undefined) opened.push(strategyPackages);
    const publicEnvironment = environment.NARYX_PUBLIC_ENVIRONMENT;
    const metricObservationPath = optional(environment.NARYX_METRIC_OBSERVATION_DB);
    const metricSourcePath = optional(environment.NARYX_METRIC_OBSERVATION_SOURCES);
    if ((metricObservationPath === undefined) !== (metricSourcePath === undefined)
      || (metricObservationPath !== undefined && (strategyPackages === undefined || publicEnvironment === undefined))) {
      throw new PublicMarketConfigError("Metric observations require both database and source config, strategy packages, and NARYX_PUBLIC_ENVIRONMENT.");
    }
    const metricSources = metricSourcePath === undefined
      ? undefined
      : loadMetricObservationSources(absolute(metricSourcePath, "NARYX_METRIC_OBSERVATION_SOURCES"));
    const orderActivationPath = optional(environment.NARYX_ORDER_ACTIVATION_DB);
    if (orderActivationPath !== undefined && strategyPackages === undefined) {
      throw new PublicMarketConfigError("NARYX_ORDER_ACTIVATION_DB requires NARYX_STRATEGY_PACKAGE_DB.");
    }
    const orderActivations = orderActivationPath === undefined || strategyPackages === undefined
      ? undefined
      : new SqliteOrderActivationStore(absolute(orderActivationPath, "NARYX_ORDER_ACTIVATION_DB"), {
        orders: strategyPackages,
        clock: clockMs,
        enabledMetrics: new Set(["TIME" as const, ...(metricSources?.keys() ?? [])]),
      });
    if (orderActivations !== undefined) opened.push(orderActivations);
    const metricObservations = metricObservationPath === undefined || metricSourcePath === undefined
      || strategyPackages === undefined || publicEnvironment === undefined
      ? undefined
      : new SqliteMetricObservationStore(absolute(metricObservationPath, "NARYX_METRIC_OBSERVATION_DB"), {
        environment: publicEnvironment,
        orders: strategyPackages,
        sourcesByMetric: metricSources!,
        clock: clockMs,
      });
    if (metricObservations !== undefined) opened.push(metricObservations);
    const strategyPath = optional(environment.NARYX_STRATEGY_DB);
    if (strategyPath !== undefined && evidence === undefined) {
      throw new PublicMarketConfigError("NARYX_STRATEGY_DB requires NARYX_EVIDENCE_DB, whose settled receipts found strategies.");
    }
    if (strategyPath !== undefined && (publicEnvironment === undefined || !/^[A-Za-z0-9._:-]{1,64}$/.test(publicEnvironment) || publicEnvironment.toLowerCase().includes("mainnet"))) {
      throw new PublicMarketConfigError("NARYX_STRATEGY_DB requires NARYX_PUBLIC_ENVIRONMENT, a non-mainnet environment id.");
    }
    const transfersSetting = environment.NARYX_BASE_STRATEGY_TRANSFERS_ENABLED;
    if (transfersSetting !== undefined && transfersSetting !== "true" && transfersSetting !== "false") {
      throw new PublicMarketConfigError("NARYX_BASE_STRATEGY_TRANSFERS_ENABLED must be true or false.");
    }
    const originReceipt = (receiptHashHex: string) => baseReceipts?.accountReceipt(receiptHashHex) ?? strategyPackages?.receipt(receiptHashHex) ?? evidence?.outcomeByReceipt(receiptHashHex)?.receipt;
    if (transfersSetting === "true" && (publicEnvironment !== "testnet" || strategyPath === undefined || evidence === undefined
      || baseReceipts === undefined || canonicalOrder === undefined)) {
      throw new PublicMarketConfigError("Base strategy transfers require a testnet strategy book, canonical orders and finalized account receipts.");
    }
    const transferRuntime = transfersSetting !== "true" ? undefined : loadBaseSepoliaRuntimeManifest(absolute(environment.NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST,
      "NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST")).deployment;
    const transferConfig = transferRuntime === undefined ? undefined : {
      rpcUrl: environment.NARYX_BASE_SEPOLIA_RPC_URL ?? "",
      deployment: transferRuntime.deployment,
      originReceipt,
      originOrder: (hash: string) => canonicalOrder?.(hash) ?? evidence?.getOrder(hash)?.order,
    };
    const transferEvidence = transferConfig === undefined ? undefined : createBaseStrategyTransferVerifier(transferConfig);
    const resolveAccountReceipt = transferConfig === undefined || transferRuntime === undefined || baseReceipts === undefined ? undefined
      : createBaseAccountReceiptResolver({ rpcUrl: transferConfig.rpcUrl, configuration: transferRuntime, store: baseReceipts, order: transferConfig.originOrder });
    const prepareCanonicalStrategy = (receiptHash: string, atValue: bigint) => {
      const receipt = originReceipt(receiptHash);
      if (transferRuntime === undefined || receipt === undefined || "legOutcomes" in receipt || receipt.domain.domainId !== "eip155:84532") return undefined;
      if (!("kind" in receipt)) throw new PublicMarketConfigError("Base account strategies require the finalized onchain account receipt.");
      const order = transferConfig!.originOrder(toHex(receipt.orderHash));
      if (order === undefined) throw new PublicMarketConfigError("The originating signed order is unavailable.");
      return prepareBoundCashCarryOpen({ environment: "testnet", atValue, receiptHashHex: receiptHash, receipt, order,
        binding: transferRuntime.seriesBindingInput, spotInstrument: transferRuntime.deployment.spot.market.address.toLowerCase(),
        perpInstrument: transferRuntime.deployment.perpetual.market.address.toLowerCase(), transferable: true });
    };
    const strategies = strategyPath === undefined || evidence === undefined
      ? undefined
      : new SqliteStrategyBookStore(absolute(strategyPath, "NARYX_STRATEGY_DB"), {
        environment: publicEnvironment as string,
        originReceipt,
        ...(transferEvidence === undefined ? {} : { transferEvidence }),
        ...(resolveAccountReceipt === undefined ? {} : { resolveReceipt: resolveAccountReceipt }),
        ...(transferRuntime === undefined ? {} : { canonicalOriginState: (hash: string) => {
          const command = prepareCanonicalStrategy(hash, 1n)?.command;
          return command?.parameters.kind === "OPEN" ? command.parameters.state : undefined;
        } }),
        packageOrder: (orderHashHex) => strategyPackages?.order(orderHashHex)?.order,
        clock: clockMs,
      });
    if (strategies !== undefined) opened.push(strategies);
    const builderPath = optional(environment.NARYX_BUILDER_DB);
    if (builderPath !== undefined && (evidence === undefined || publicEnvironment === undefined || publicEnvironment.toLowerCase().includes("mainnet"))) {
      throw new PublicMarketConfigError("NARYX_BUILDER_DB requires NARYX_EVIDENCE_DB and a non-mainnet NARYX_PUBLIC_ENVIRONMENT.");
    }
    const builders = builderPath === undefined || evidence === undefined
      ? undefined
      : new SqliteBuilderStore(absolute(builderPath, "NARYX_BUILDER_DB"), { environment: publicEnvironment as string, evidence, clock: clockMs });
    if (builders !== undefined) opened.push(builders);
    const keeperPath = optional(environment.NARYX_KEEPER_EXECUTOR_DB);
    if (keeperPath !== undefined && strategies === undefined) {
      throw new PublicMarketConfigError("NARYX_KEEPER_EXECUTOR_DB requires NARYX_STRATEGY_DB, whose current state hashes gate every keeper action.");
    }
    const keeper = keeperPath === undefined || strategies === undefined
      ? undefined
      : new SqliteKeeperExecutor(absolute(keeperPath, "NARYX_KEEPER_EXECUTOR_DB"), {
        authorities: authorityKeys(environment.NARYX_HEALTH_AUTHORITIES, "NARYX_KEEPER_EXECUTOR_DB", "NARYX_HEALTH_AUTHORITIES"),
        strategies,
        ...(positions === undefined ? {} : { positions }),
        clock: clockMs,
      });
    if (keeper !== undefined) opened.push(keeper);
    const coordinationPath = optional(environment.NARYX_COORDINATION_DB);
    if (coordinationPath !== undefined && (publicEnvironment === undefined || !/^[A-Za-z0-9._:-]{1,64}$/.test(publicEnvironment) || publicEnvironment.toLowerCase().includes("mainnet"))) {
      throw new PublicMarketConfigError("NARYX_COORDINATION_DB requires NARYX_PUBLIC_ENVIRONMENT, a non-mainnet environment id.");
    }
    const coordination = coordinationPath === undefined
      ? undefined
      : new SqliteCoordinationStore(absolute(coordinationPath, "NARYX_COORDINATION_DB"), { environment: publicEnvironment as string, clock: clockMs });
    if (coordination !== undefined) opened.push(coordination);
    const nativeClearingPath = optional(environment.NARYX_NATIVE_CLEARING_DB);
    if (nativeClearingPath !== undefined && (
      publicEnvironment === undefined
      || !/^[A-Za-z0-9._:-]{1,64}$/.test(publicEnvironment)
      || publicEnvironment.toLowerCase().includes('mainnet')
    )) {
      throw new PublicMarketConfigError('NARYX_NATIVE_CLEARING_DB requires NARYX_PUBLIC_ENVIRONMENT, a non-mainnet environment id.');
    }
    const nativeClearing = nativeClearingPath === undefined
      ? undefined
      : new SqliteNativeClearingStore(absolute(nativeClearingPath, 'NARYX_NATIVE_CLEARING_DB'), clockMs);
    if (nativeClearing !== undefined) opened.push(nativeClearing);
    const nativeClearingBackingPath = optional(environment.NARYX_NATIVE_CLEARING_BACKING_CONFIG);
    if (nativeClearingBackingPath !== undefined && nativeClearing === undefined) {
      throw new PublicMarketConfigError('Native clearing backing requires NARYX_NATIVE_CLEARING_DB.');
    }
    const nativeClearingBacking = nativeClearing === undefined ? undefined
      : loadNativeClearingBacking(nativeClearingBackingPath === undefined ? undefined : absolute(nativeClearingBackingPath, 'NARYX_NATIVE_CLEARING_BACKING_CONFIG'), nativeClearing, environment, clockMs);
    const strategyOrderIntake = strategyPackages === undefined || graphContext === undefined || registry === undefined
      ? undefined
      : createStrategyOrderIntake({
        exchange: store,
        registry,
        graphContext,
        store: strategyPackages,
        clockMs,
      });
    const advancedOrders = strategyPackages === undefined || strategyOrderIntake === undefined || orderActivations === undefined
      ? undefined
      : new AdvancedOrderFactory({ orders: strategyPackages, intake: strategyOrderIntake, activations: orderActivations });
    const advancedOrderExecutions = strategyPackages === undefined || strategyOrderIntake === undefined || orderActivations === undefined
      ? undefined
      : new AdvancedOrderExecutionFactory({ orders: strategyPackages, intake: strategyOrderIntake, activations: orderActivations });
    const advancedOrderReconciliation = strategyPackages === undefined || orderActivations === undefined
      ? undefined
      : new AdvancedOrderReconciliation({ activations: orderActivations, strategies: strategyPackages, exchange: store });
    const advancedOrderCursor: { afterAttemptId?: string } = {};
    const generalizedQuoteSetting = environment.NARYX_GENERALIZED_STRATEGY_QUOTE_ENABLED ?? "false";
    if (generalizedQuoteSetting !== "true" && generalizedQuoteSetting !== "false") {
      throw new PublicMarketConfigError("NARYX_GENERALIZED_STRATEGY_QUOTE_ENABLED must be true or false.");
    }
    if (generalizedQuoteSetting === "true" && strategyPackages === undefined) {
      throw new PublicMarketConfigError("NARYX_GENERALIZED_STRATEGY_QUOTE_ENABLED requires NARYX_STRATEGY_PACKAGE_DB.");
    }
    const strategyQuotes = generalizedQuoteSetting === "true"
      ? new HttpGeneralizedStrategyQuoteClient(
        environment.NARYX_SOLVER_INTERNAL_ORIGIN ?? "http://127.0.0.1:8788",
      )
      : undefined;
    const portfolioOptimizationSetting = environment.NARYX_PORTFOLIO_OPTIMIZATION_ENABLED ?? 'false';
    if (portfolioOptimizationSetting !== 'true' && portfolioOptimizationSetting !== 'false') {
      throw new PublicMarketConfigError('NARYX_PORTFOLIO_OPTIMIZATION_ENABLED must be true or false.');
    }
    if (portfolioOptimizationSetting === "true" && (positions === undefined || collateral === undefined)) {
      throw new PublicMarketConfigError(
        "NARYX_PORTFOLIO_OPTIMIZATION_ENABLED requires NARYX_POSITION_DB and NARYX_COLLATERAL_DB.",
      );
    }
    const portfolioOptimization = portfolioOptimizationSetting === "true" && positions !== undefined && collateral !== undefined
      ? new AuthoritativePortfolioOptimization({
        positions,
        collateral,
        optimizer: new HttpPortfolioOptimizationClient(
          environment.NARYX_SOLVER_INTERNAL_ORIGIN ?? 'http://127.0.0.1:8788',
        ),
        clock: clockMs,
      })
      : undefined;
    const hyperliquidNettingExecutionSetting = environment.NARYX_HYPERLIQUID_TESTNET_NETTING_EXECUTION_ENABLED
      ?? "false";
    if (hyperliquidNettingExecutionSetting !== "true" && hyperliquidNettingExecutionSetting !== "false") {
      throw new PublicMarketConfigError(
        "NARYX_HYPERLIQUID_TESTNET_NETTING_EXECUTION_ENABLED must be true or false.",
      );
    }
    if (hyperliquidNettingExecutionSetting === "true"
      && environment.NARYX_HYPERLIQUID_TESTNET_ACCOUNT_MODE !== "SHARED_TEST_FIXTURE") {
      throw new PublicMarketConfigError(
        "Shared-account Hyperliquid netting is restricted to SHARED_TEST_FIXTURE; per-user accounts cannot share residual settlement.",
      );
    }
    const baseNettingExecutionSetting = environment.NARYX_BASE_SEPOLIA_NETTING_EXECUTION_ENABLED
      ?? "false";
    if (baseNettingExecutionSetting !== "true" && baseNettingExecutionSetting !== "false") {
      throw new PublicMarketConfigError(
        "NARYX_BASE_SEPOLIA_NETTING_EXECUTION_ENABLED must be true or false.",
      );
    }
    const solanaNettingExecutionSetting = environment.NARYX_SOLANA_DEVNET_NETTING_EXECUTION_ENABLED
      ?? "false";
    if (solanaNettingExecutionSetting !== "true" && solanaNettingExecutionSetting !== "false") {
      throw new PublicMarketConfigError(
        "NARYX_SOLANA_DEVNET_NETTING_EXECUTION_ENABLED must be true or false.",
      );
    }
    if ((hyperliquidNettingExecutionSetting === "true" || baseNettingExecutionSetting === "true"
      || solanaNettingExecutionSetting === "true")
      && publicEnvironment !== "testnet") {
      throw new PublicMarketConfigError(
        "Testnet netting execution requires NARYX_PUBLIC_ENVIRONMENT=testnet.",
      );
    }
    const nettingExecutionRoutes = [
      ...(hyperliquidNettingExecutionSetting === "true"
        ? [new HttpHyperliquidNettingResidualExecutionClient(
          environment.NARYX_SOLVER_INTERNAL_ORIGIN ?? "http://127.0.0.1:8788",
        )] : []),
      ...(baseNettingExecutionSetting === "true"
        ? [new HttpBaseSepoliaNettingResidualExecutionClient(
          environment.NARYX_SOLVER_INTERNAL_ORIGIN ?? "http://127.0.0.1:8788",
        )] : []),
      ...(solanaNettingExecutionSetting === "true"
        ? [new HttpSolanaDevnetNettingResidualExecutionClient(
          environment.NARYX_SOLVER_INTERNAL_ORIGIN ?? "http://127.0.0.1:8788",
        )] : []),
    ];
    const nettingExecution = nettingExecutionRoutes.length > 0
      ? new NettingExecutionCoordinator(
        store,
        new NettingExternalExecutionRouter(nettingExecutionRoutes),
      )
      : undefined;
    const crossBatchExecutionRoutes = [
      ...(hyperliquidNettingExecutionSetting === "true"
        ? [new HttpHyperliquidCrossBatchResidualExecutionClient(
          environment.NARYX_SOLVER_INTERNAL_ORIGIN ?? "http://127.0.0.1:8788",
        )] : []),
      ...(baseNettingExecutionSetting === "true"
        ? [new HttpBaseSepoliaCrossBatchResidualExecutionClient(
          environment.NARYX_SOLVER_INTERNAL_ORIGIN ?? "http://127.0.0.1:8788",
        )] : []),
      ...(solanaNettingExecutionSetting === "true"
        ? [new HttpSolanaDevnetCrossBatchResidualExecutionClient(
          environment.NARYX_SOLVER_INTERNAL_ORIGIN ?? "http://127.0.0.1:8788",
        )] : []),
    ];
    const crossBatchExecution = crossBatchExecutionRoutes.length > 0
      ? new CrossBatchClearingCoordinator(
        store,
        new CrossBatchExternalExecutionRouter(crossBatchExecutionRoutes),
      )
      : undefined;
    const allocationSettlementSetting = environment.NARYX_NETTING_ALLOCATION_SETTLEMENT_ENABLED ?? "false";
    if (allocationSettlementSetting !== "true" && allocationSettlementSetting !== "false") {
      throw new PublicMarketConfigError("NARYX_NETTING_ALLOCATION_SETTLEMENT_ENABLED must be true or false.");
    }
    const baseAllocationSettlementSetting = environment.NARYX_BASE_SEPOLIA_NETTING_SETTLEMENT_ENABLED ?? "false";
    const solanaAllocationSettlementSetting = environment.NARYX_SOLANA_DEVNET_NETTING_SETTLEMENT_ENABLED ?? "false";
    for (const [name, value] of [
      ["NARYX_BASE_SEPOLIA_NETTING_SETTLEMENT_ENABLED", baseAllocationSettlementSetting],
      ["NARYX_SOLANA_DEVNET_NETTING_SETTLEMENT_ENABLED", solanaAllocationSettlementSetting],
    ] as const) {
      if (value !== "true" && value !== "false") throw new PublicMarketConfigError(`${name} must be true or false.`);
    }
    if (allocationSettlementSetting === "false"
      && (baseAllocationSettlementSetting === "true" || solanaAllocationSettlementSetting === "true")) {
      throw new PublicMarketConfigError(
        "Domain netting settlement routes require NARYX_NETTING_ALLOCATION_SETTLEMENT_ENABLED=true.",
      );
    }
    let nettingAllocationAdmin: ReturnType<typeof createNettingAllocationAdminHandler> | undefined;
    if (allocationSettlementSetting === "true") {
      if (publicEnvironment !== "testnet") {
        throw new PublicMarketConfigError("Netting allocation settlement is restricted to NARYX_PUBLIC_ENVIRONMENT=testnet.");
      }
      const attempts = new SqliteNettingAllocationAttemptStore(absolute(
        environment.NARYX_NETTING_ALLOCATION_ATTEMPT_DB,
        "NARYX_NETTING_ALLOCATION_ATTEMPT_DB",
      ));
      opened.push(attempts);
      const routes = [];
      if (baseAllocationSettlementSetting === "true") {
        const manifest = loadBaseSepoliaRuntimeManifest(absolute(
          environment.NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST,
          "NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST",
        ));
        const reads = createViemBaseSepoliaReadClient(
          environment.NARYX_BASE_SEPOLIA_RPC_URL ?? "",
        );
        if (reads.blockTimestamp === undefined) {
          throw new PublicMarketConfigError("Base Sepolia netting settlement requires historical block timestamps.");
        }
        routes.push(new EvmNettingAllocationObservationRoute({
          routeId: "base-sepolia-netting-settlement",
          domain: domainRefFromManifest(manifest.deployment.deployment.domainManifest),
          attempts,
          reads,
          finality: manifest.deployment.finality.policy,
          blockTimestamp: reads.blockTimestamp,
        }));
      }
      if (solanaAllocationSettlementSetting === "true") {
        const manifest = loadSolanaDevnetRuntimeManifest(absolute(
          environment.NARYX_SOLANA_DEVNET_RUNTIME_MANIFEST,
          "NARYX_SOLANA_DEVNET_RUNTIME_MANIFEST",
        ));
        const reads = new HttpSolanaDevnetReadOnlyRpc(environment.NARYX_SOLANA_DEVNET_RPC_URL ?? "");
        routes.push(new SolanaNettingAllocationObservationRoute({
          routeId: "solana-devnet-netting-settlement",
          domain: manifest.domain,
          expectedGenesisHash: manifest.expectedGenesisHash,
          attempts,
          reads,
        }));
      }
      if (routes.length === 0) {
        throw new PublicMarketConfigError("Netting allocation settlement requires at least one enabled domain route.");
      }
      const settlement = new NettingAllocationSettlementCoordinator(
        store,
        new NettingAllocationObservationRouter(routes),
      );
      nettingAllocationAdmin = createNettingAllocationAdminHandler({ exchange: store, attempts, settlement });
    }
    const pinnedSuiteIds = (environment.NARYX_RFQ_PINNED_SUITES ?? "").split(",").map((value) => value.trim()).filter((value) => value !== "");
    const nowValue = support.clockUnit === "UNIX_SECONDS"
      ? () => BigInt(Math.floor(clockMs() / 1_000))
      : () => BigInt(Math.floor(clockMs()));
    const makerSolverIdValue = optional(environment.NARYX_MAKER_SOLVER_ID);
    if (makerSolverIdValue !== undefined && solverState === undefined) {
      throw new PublicMarketConfigError("NARYX_MAKER_SOLVER_ID requires NARYX_SOLVER_API_DB.");
    }
    let makerSolverId: string | undefined;
    try {
      makerSolverId = makerSolverIdValue === undefined
        ? undefined
        : protocolId(makerSolverIdValue, "NARYX_MAKER_SOLVER_ID");
    } catch {
      throw new PublicMarketConfigError("NARYX_MAKER_SOLVER_ID must be a valid protocol identifier.");
    }
    const internalHandlers = [
      createPackageReopeningAdminHandler({ exchange: store, nowValue }),
      ...(strategyPackages === undefined ? [] : [createNettingBatchAdminHandler({
        prepareNext: (policy) => prepareNextAuthoritativeNettingBatch(
          store,
          strategyPackages,
          policy,
          clockMs(),
        ),
      })]),
      ...(nettingExecution === undefined ? [] : [createNettingBatchExecutionHandler({ exchange: store, execution: nettingExecution })]),
      createCrossBatchClearingAdminHandler({
        exchange: store,
        prepareNext: (policy) => prepareNextAuthoritativeCrossBatchClearing(store, policy),
        ...(crossBatchExecution === undefined ? {} : { execution: crossBatchExecution }),
      }),
      ...(keeper === undefined ? [] : [createKeeperExecutorHandler({ executor: keeper, nowIn: keeperClock(clockMs) })]),
      ...(coordination === undefined ? [] : [createCoordinationInternalHandler(coordination)]),
      ...(nativeClearing === undefined ? [] : [createNativeClearingAdminHandler({
        clearing: nativeClearing,
        exchange: store,
        verifyBacking: (path, body) => nativeClearingBacking!.verifyMutation(path, body),
        observe: (kind, body) => nativeClearingBacking!.observe(kind, body),
      })]),
      ...(orderActivations === undefined ? [] : [createOrderActivationAdminHandler({
        activations: orderActivations,
        ...(metricObservations === undefined ? {} : { observations: metricObservations }),
        ...(advancedOrderReconciliation === undefined ? {} : { reconciliation: advancedOrderReconciliation }),
      })]),
      // Owner list and signed cancel under /internal/terminal/, which the terminal origin reaches.
      ...(orderActivations === undefined ? [] : [createOrderActivationOwnerHandler({ activations: orderActivations, clock: clockMs })]),
      ...(metricObservations === undefined ? [] : [createMetricObservationAdminHandler({ observations: metricObservations })]),
      ...(strategyPackages === undefined ? [] : [createStrategyPackageInternalHandler(strategyPackages)]),
      ...(nettingAllocationAdmin === undefined ? [] : [nettingAllocationAdmin]),
      ...(solverState === undefined || makerSolverId === undefined ? [] : [createMakerOperationsHandler({
        store: solverState,
        solverId: makerSolverId,
        nowValue,
      })]),
    ];
    const rateLimit = { windowMs: 60_000, maxRequests: requestsPerMinute };
    const catalogueSigner = loadCatalogueSigner(environment);
    const catalogue = catalogueSigner === undefined
      ? undefined
      : createCatalogueIssuer({ exchange: store, ...(registry === undefined ? {} : { registry }), ...catalogueSigner, clockMs });
    const publicHandler = createPublicApiHandler({
      exchange: store,
      ...(registry === undefined ? {} : { registry }),
      ...(solverState === undefined ? {} : { solverState }),
      ...(delivery === undefined ? {} : { delivery, pinnedSuiteIds }),
      ...(evidence === undefined ? {} : { evidence }),
      ...(qualification === undefined ? {} : { qualification }),
      ...(positions === undefined ? {} : { positions }),
      ...(collateral === undefined ? {} : { collateral }),
      ...(graphContext === undefined ? {} : { graphContext }),
      ...(catalogue === undefined ? {} : { catalogue }),
      ...(strategies === undefined ? {} : { strategies }),
      baseStrategyTransfersEnabled: transferEvidence !== undefined,
      ...(transferConfig === undefined ? {} : { strategyTransferContext: createBaseStrategyTransferContext(transferConfig) }),
      ...(transferRuntime === undefined ? {} : {
        prepareCanonicalStrategy: async (hash: string, atValue: bigint) => {
          await resolveAccountReceipt?.(hash);
          return prepareCanonicalStrategy(hash, atValue);
        },
        prepareCanonicalTransition: async (strategyId: string, hash: string, atValue: bigint) => {
          const receipt = await resolveAccountReceipt?.(hash), stored = strategies?.strategy(strategyId);
          if (receipt === undefined || stored === undefined) return undefined;
          const origin = stored.originReceiptHashHex === undefined ? undefined : originReceipt(stored.originReceiptHashHex);
          if (origin === undefined || !("kind" in origin) || receipt.action !== "EXIT" || receipt.entryReceiptHashHex !== origin.receiptHashHex
            || receipt.strategyAccount !== origin.strategyAccount || receipt.owner !== stored.state.ownerId) {
            throw new PublicMarketConfigError("The exit does not belong to this account and originating entry.");
          }
          return prepareBaseAccountExit({ environment: "testnet", atValue, current: stored.state, receipt });
        },
      }),
      ...(evidence === undefined ? {} : { canonicalStrategyReceipt: (hash: string) => evidence.outcomeByReceipt(hash)?.receipt }),
      ...(strategyPackages === undefined ? {} : { strategyPackages }),
      ...(strategyOrderIntake === undefined ? {} : { strategyOrderIntake }),
      ...(strategyPackages === undefined ? {} : { strategyPackageSources: strategyPackages }),
      ...(strategyPackages === undefined ? {} : { strategyPackageExecutions: strategyPackages }),
      ...(strategyQuotes === undefined ? {} : { strategyQuotes }),
      ...(portfolioOptimization === undefined ? {} : { portfolioOptimization }),
      ...(builders === undefined ? {} : { builders }),
      ...(keeper === undefined ? {} : { health: keeper }),
      ...(coordination === undefined ? {} : { coordination }),
      ...(nativeClearing === undefined ? {} : { nativeClearing }),
      ...(nativeClearingBacking === undefined ? {} : { nativeClearingBacking: (id: string) => nativeClearingBacking.current(id) }),
      ...(orderActivations === undefined ? {} : { orderActivations }),
      ...(advancedOrders === undefined ? {} : { advancedOrders }),
      ...(advancedOrderExecutions === undefined ? {} : { advancedOrderExecutions }),
      nowValue,
      clockUnit: support.clockUnit,
      ...(unitClock === undefined ? {} : { unitClock }),
      rateLimit,
      clockMs,
    });
    const admissionPath = optional(environment.NARYX_ADMISSION_CONTEXTS);
    const admission = admissionPath === undefined ? undefined : loadAdmissionContexts(absolute(admissionPath, "NARYX_ADMISSION_CONTEXTS"));
    const bondConfigPath = optional(environment.NARYX_BOND_READER_CONFIG);
    const bonds = bondConfigPath === undefined ? undefined : loadBondReader(absolute(bondConfigPath, "NARYX_BOND_READER_CONFIG"));
    if (environment.NARYX_THRESHOLD_AUCTIONS_ENABLED === 'true' && delivery === undefined) {
      throw new PublicMarketConfigError('Threshold auctions require a durable private delivery store.');
    }
    const thresholdAuctions = environment.NARYX_THRESHOLD_AUCTIONS_ENABLED === 'true' && delivery !== undefined
      ? new ThresholdAuctionBackend(delivery, clockMs) : undefined;
    if (thresholdAuctions) opened.push(thresholdAuctions);
    const bookClock = createPackageBookClock({ exchange: store, clockMs, ...(unitClock === undefined ? {} : { unitClock }) });
    const solverHandler = solverState === undefined || registry === undefined
      ? undefined
      : createSolverApiHandler({
        store: solverState,
        registry,
        exchange: store,
        ...(delivery === undefined ? {} : { delivery }),
        ...(thresholdAuctions === undefined ? {} : { thresholdAuctions }),
        ...(evidence === undefined ? {} : { evidence }),
        ...(admission === undefined ? {} : { admission }),
        ...(bonds === undefined ? {} : { bonds }),
        backingAtomsPerPackageUnit: support.backingAtomsPerPackageUnit,
        packageSourceBackingAtomsPerUnit: support.packageSourceBackingAtomsPerUnit,
        nowValue,
        bookNowValue: classId => bookClock(classId).value,
        ...(unitClock === undefined ? {} : { unitClock }),
        isStrategyExecutionSettled: orderHash => {
          const receipt = strategyPackages?.receiptByOrder(orderHash)?.receipt;
          return receipt !== undefined && receipt.environment === 'testnet'
            && receipt.finalityStatus === 'FINALIZED' && receipt.terminalResidualValue.atoms === 0n
            && receipt.terminalState !== 'MANUAL_INTERVENTION'
            && receipt.legOutcomes.every(leg => leg.onchainEnforced);
        },
        clockMs,
        rateLimit: { windowMs: rateLimit.windowMs, maxRequests: Number(rawSolverRate) },
      });
    const stream = createMarketStream({ exchange: store, nowValue: (marketId) => bookClock(marketId).value });
    opened.push(stream);
    const solverStream = solverState === undefined || registry === undefined
      ? undefined
      : createSolverStream({
        store: solverState,
        registry,
        ...(unitClock === undefined ? {} : { unitClock }),
        ...(delivery === undefined ? {} : { delivery }),
        ...(evidence === undefined ? {} : { evidence }),
        clockMs,
      });
    if (solverStream !== undefined) opened.push(solverStream);
    return Object.freeze({
      handler: (request: IncomingMessage, response: ServerResponse) =>
        (solverHandler?.(request, response) ?? false) || publicHandler(request, response),
      ...(listener === undefined ? {} : { listener: Object.freeze(listener) }),
      upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) =>
        stream.upgrade(request, socket, head) || (solverStream?.upgrade(request, socket, head) ?? false),
      closeStreams: () => { stream.close(); solverStream?.close(); },
      clockUnit: support.clockUnit,
      requestsPerMinute,
      solverApiEnabled: solverHandler !== undefined,
      ...(orderActivations === undefined || advancedOrderReconciliation === undefined ? {} : {
        reconcileAdvancedOrders: () => ({
          ...reconcilePendingAdvancedOrders(orderActivations, advancedOrderReconciliation, advancedOrderCursor),
          expired: orderActivations.expireWaitingOrders(),
        }),
      }),
      ...(strategyOrderIntake === undefined ? {} : { strategyOrderIntake }),
      ...(strategyPackages === undefined ? {} : {
        strategyPackageSources: strategyPackages,
        strategyPackageExecutions: strategyPackages,
        strategyPackageAuthorizations: strategyPackages,
      }),
      ...(internalHandlers.length === 0 ? {} : {
        internalHandler: (request: IncomingMessage, response: ServerResponse) => internalHandlers.some((handler) => handler(request, response)),
      }),
      close: () => {
        for (const resource of opened.reverse()) resource.close();
      },
    });
  } catch (error) {
    for (const resource of opened.reverse()) resource.close();
    throw error;
  }
}
