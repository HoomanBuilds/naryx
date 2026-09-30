import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createMarketStream } from "./market-stream.js";
import { parseProtocolJson } from "@naryx/protocol-types";
import type {
  EconomicStrategySeriesSupportInput,
  SeriesExecutionClassSupportInput,
  DomainRegistryRecordInput,
  DomainResourceLimit,
} from "@naryx/protocol-types";
import { SqlitePackageExchangeStore } from "./package-exchange-store.js";
import { createPublicApiHandler } from "./public-api.js";
import { SqliteRegistryStore } from "./registry-store.js";
import { createSolverApiHandler, createSolverStream, type AdmissionContext } from "./solver-api.js";
import { SqliteSolverApiStore } from "./solver-api-store.js";
import { SqlitePrivateDeliveryStore } from "./private-delivery-store.js";
import { SqliteEvidenceStore } from "./evidence-store.js";
import { SqliteQualificationStore } from "./qualification-store.js";
import { SqlitePositionSnapshotStore } from "./position-snapshot-store.js";
import { createCatalogueIssuer } from "./market-catalogue-issuer.js";
import { SqliteStrategyBookStore } from "./strategy-book-store.js";
import { createEvmBondReader } from "./evm-bond-reader.js";
import bs58 from "bs58";

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
} {
  if (statSync(path).size > MAX_SUPPORT_MANIFEST_BYTES) throw new PublicMarketConfigError("Support manifest is too large.");
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(readFileSync(path, "utf8"));
  } catch {
    throw new PublicMarketConfigError("Support manifest is not valid protocol JSON.");
  }
  const manifest = object(parsed, "root");
  const keys = Object.keys(manifest).sort();
  if (keys.join(",") !== "clockUnit,executionClassSupport,seriesSupport,version" || manifest.version !== 1) {
    throw new PublicMarketConfigError("Support manifest must be version 1 with exactly clockUnit, seriesSupport, and executionClassSupport.");
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
 * NARYX_BOND_READER_CONFIG names an absolute JSON file: `rpcUrl`, `vault`, `solvers` (address to
 * solver id), and `assets` (address to asset reference). FIRM_BONDED quotes are refused without it.
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
  if (typeof raw.rpcUrl !== "string" || typeof raw.vault !== "string") throw new PublicMarketConfigError("NARYX_BOND_READER_CONFIG needs rpcUrl and vault.");
  return createEvmBondReader({
    rpcUrl: raw.rpcUrl,
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

/**
 * Loads the public v1 API. It is off unless NARYX_PUBLIC_MARKET_ENABLED is exactly "true", and
 * then requires an absolute exchange database path and support manifest; NARYX_REGISTRY_DB, when
 * set, enables the registry routes, and NARYX_SOLVER_API_DB (which requires the registry) enables
 * the authenticated solver API. Public routes serve reads and side-effect-free computation only.
 */
export function loadPublicMarketRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  clockMs: () => number = Date.now,
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
    const strategyPath = optional(environment.NARYX_STRATEGY_DB);
    if (strategyPath !== undefined && evidence === undefined) {
      throw new PublicMarketConfigError("NARYX_STRATEGY_DB requires NARYX_EVIDENCE_DB, whose settled receipts found strategies.");
    }
    const publicEnvironment = environment.NARYX_PUBLIC_ENVIRONMENT;
    if (strategyPath !== undefined && (publicEnvironment === undefined || !/^[A-Za-z0-9._:-]{1,64}$/.test(publicEnvironment) || publicEnvironment.toLowerCase().includes("mainnet"))) {
      throw new PublicMarketConfigError("NARYX_STRATEGY_DB requires NARYX_PUBLIC_ENVIRONMENT, a non-mainnet environment id.");
    }
    const strategies = strategyPath === undefined || evidence === undefined
      ? undefined
      : new SqliteStrategyBookStore(absolute(strategyPath, "NARYX_STRATEGY_DB"), {
        environment: publicEnvironment as string,
        originReceipt: (receiptHashHex) => evidence.outcomeByReceipt(receiptHashHex)?.receipt,
        clock: clockMs,
      });
    if (strategies !== undefined) opened.push(strategies);
    const pinnedSuiteIds = (environment.NARYX_RFQ_PINNED_SUITES ?? "").split(",").map((value) => value.trim()).filter((value) => value !== "");
    const nowValue = support.clockUnit === "UNIX_SECONDS"
      ? () => BigInt(Math.floor(clockMs() / 1_000))
      : () => BigInt(Math.floor(clockMs()));
    const rateLimit = { windowMs: 60_000, maxRequests: requestsPerMinute };
    const graphContextPath = optional(environment.NARYX_GRAPH_COMPILE_CONTEXT);
    const graphContext = graphContextPath === undefined ? undefined : loadGraphContext(absolute(graphContextPath, "NARYX_GRAPH_COMPILE_CONTEXT"));
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
      ...(graphContext === undefined ? {} : { graphContext }),
      ...(catalogue === undefined ? {} : { catalogue }),
      ...(strategies === undefined ? {} : { strategies }),
      nowValue,
      rateLimit,
      clockMs,
    });
    const admissionPath = optional(environment.NARYX_ADMISSION_CONTEXTS);
    const admission = admissionPath === undefined ? undefined : loadAdmissionContexts(absolute(admissionPath, "NARYX_ADMISSION_CONTEXTS"));
    const bondConfigPath = optional(environment.NARYX_BOND_READER_CONFIG);
    const bonds = bondConfigPath === undefined ? undefined : loadBondReader(absolute(bondConfigPath, "NARYX_BOND_READER_CONFIG"));
    const solverHandler = solverState === undefined || registry === undefined
      ? undefined
      : createSolverApiHandler({
        store: solverState,
        registry,
        exchange: store,
        ...(delivery === undefined ? {} : { delivery }),
        ...(evidence === undefined ? {} : { evidence }),
        ...(admission === undefined ? {} : { admission }),
        ...(bonds === undefined ? {} : { bonds }),
        nowValue,
        clockMs,
        rateLimit,
      });
    const stream = createMarketStream({ exchange: store, nowValue });
    opened.push(stream);
    const solverStream = solverState === undefined || registry === undefined
      ? undefined
      : createSolverStream({
        store: solverState,
        registry,
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
      clockUnit: support.clockUnit,
      requestsPerMinute,
      solverApiEnabled: solverHandler !== undefined,
      close: () => {
        for (const resource of opened.reverse()) resource.close();
      },
    });
  } catch (error) {
    for (const resource of opened.reverse()) resource.close();
    throw error;
  }
}
