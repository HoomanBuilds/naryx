import {
  adapterRef,
  assetRef,
  domainRef,
  exactPrice,
  exactSignedRate,
  feeCap,
  fromProtocolJson,
  fromHex,
  parseProtocolJson,
  stringifyProtocolJson,
  toHex,
  type DomainRef,
  type ExactPrice,
  type ExactSignedRate,
  type FeeCap,
  type AssetRef,
  type AdapterRef,
  type PackageAdmission,
  type RoutePayload,
} from "@naryx/protocol-types";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import { verifySolverAtomicQuoteResponse } from "./solver-quote-client.js";

export const HYPERLIQUID_TESTNET_PREPARE_PATH =
  "/internal/solver/hyperliquid-testnet/prepare";
export const HYPERLIQUID_TESTNET_RECONCILE_PATH =
  "/internal/solver/hyperliquid-testnet/reconcile";

const HASH = /^[0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

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
  admission: PackageAdmission;
  seriesManifestHash: string;
  executionClassManifestHash: string;
  market: HyperliquidTestnetMarketMetadata;
  limits: HyperliquidTestnetExecutionBounds;
  selectedAtMs: number;
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
  seriesManifestHash: string;
  executionClassManifestHash: string;
  solverId: string;
  solverVerificationKey: string;
  market: HyperliquidTestnetMarketMetadata;
  bounds: HyperliquidTestnetExecutionBounds;
  currentTimeMs: () => number;
}>;

export type HyperliquidTestnetEvidenceHttpOptions = Readonly<{
  solverOrigin: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}>;

export type HyperliquidTestnetRuntimeConfig = Readonly<{
  domain: DomainRef;
  seriesManifestHash: string;
  executionClassManifestHash: string;
  solverId: string;
  solverVerificationKey: string;
  market: HyperliquidTestnetMarketMetadata;
  bounds: HyperliquidTestnetExecutionBounds;
  orderContext?: HyperliquidTestnetOrderContextConfig;
}>;

export type HyperliquidTestnetOrderContextConfig = Readonly<{
  contextId: string;
  tradingAccount: string;
  orderVersion: number;
  templateId: string;
  templateVersion: number;
  packageTemplateManifestHash: string;
  baseAsset: AssetRef;
  quoteAsset: AssetRef;
  spotAdapter: AdapterRef;
  perpetualAdapter: AdapterRef;
  maxStalenessMs: bigint;
  expiryTtlMs: bigint;
  recoveryActionExpiryTtlMs: bigint;
  recoveryDeadlineTtlMs: bigint;
  minRecoveryWindowMs: bigint;
  spotReferencePrice: ExactPrice;
  maxEntrySpread: ExactSignedRate;
  minPerpSellPrice: ExactPrice;
  maxRecoverySpotBuyPrice: ExactPrice;
  minRecoverySpotSellPrice: ExactPrice;
  minRecoveryPerpSellPrice: ExactPrice;
  maxRecoveryPerpBuyPrice: ExactPrice;
  maximumQuantityAtoms: bigint;
  maxSlippageBps: number;
  maxNetSpotShortfallAtoms: bigint;
  maxNetSpotExcessAtoms: bigint;
  maxTerminalResidualBaseQuantityAtoms: bigint;
  maxTerminalResidualQuoteValueAtoms: bigint;
  residualValuationReferencePrice: ExactPrice;
  maxVenueFeeAtomsByAsset: readonly FeeCap[];
  maxMarginAddedAtoms: bigint;
  maxProtocolFeeAtoms: bigint;
  maxSolverFeeAtoms: bigint;
  maxPriorityFeeAtoms: bigint;
  minVenueReserveReturnedAtoms: bigint;
  minWalletQuoteBalanceDeltaAtoms: bigint;
  maxResidualBaseQuantityAtoms: bigint;
  maxRecoveryCostAtomsByAsset: readonly FeeCap[];
  maxAggregateRecoveryLossQuoteAtoms: bigint;
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

function domainBinding(value: DomainRef) {
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

function exactObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("INVALID_CONFIGURATION", `${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) {
    fail("INVALID_CONFIGURATION", `${name} fields are invalid`);
  }
  return record;
}

function orderContext(value: unknown): HyperliquidTestnetOrderContextConfig {
  const keys = [
    "baseAsset", "contextId", "expiryTtlMs", "maxAggregateRecoveryLossQuoteAtoms",
    "maxEntrySpread", "maxMarginAddedAtoms", "maxNetSpotExcessAtoms",
    "maxPriorityFeeAtoms", "maxProtocolFeeAtoms", "maxRecoveryCostAtomsByAsset",
    "maxRecoveryPerpBuyPrice", "maxRecoverySpotBuyPrice", "maxResidualBaseQuantityAtoms",
    "maxSlippageBps", "maxSolverFeeAtoms", "maxStalenessMs",
    "maxTerminalResidualBaseQuantityAtoms", "maxTerminalResidualQuoteValueAtoms",
    "maxVenueFeeAtomsByAsset", "maximumQuantityAtoms", "maxNetSpotShortfallAtoms",
    "minPerpSellPrice", "minRecoveryPerpSellPrice", "minRecoverySpotSellPrice",
    "minRecoveryWindowMs", "minVenueReserveReturnedAtoms", "minWalletQuoteBalanceDeltaAtoms",
    "orderVersion", "packageTemplateManifestHash", "perpetualAdapter", "quoteAsset",
    "recoveryActionExpiryTtlMs", "recoveryDeadlineTtlMs", "residualValuationReferencePrice",
    "spotAdapter", "spotReferencePrice", "templateId", "templateVersion", "tradingAccount",
  ];
  const raw = exactObject(value, keys, "orderContext");
  const bounded = (candidate: unknown, name: string): string => {
    if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 128) {
      fail("INVALID_CONFIGURATION", `${name} is invalid`);
    }
    return candidate;
  };
  const atom = (candidate: unknown, name: string, positive = false): bigint => {
    if (typeof candidate !== "bigint" || candidate < 0n || (positive && candidate === 0n)) {
      fail("INVALID_CONFIGURATION", `${name} is invalid`);
    }
    return candidate;
  };
  const asset = (candidate: unknown, name: string): AssetRef => {
    const entry = exactObject(candidate, ["assetId", "assetManifestHash", "decimals"], name);
    try {
      return assetRef(entry.assetId as string, entry.assetManifestHash as string, entry.decimals as number);
    } catch {
      fail("INVALID_CONFIGURATION", `${name} is invalid`);
    }
  };
  const adapter = (candidate: unknown, name: string): AdapterRef => {
    const entry = exactObject(candidate, ["adapterId", "adapterManifestHash", "adapterManifestVersion"], name);
    try {
      return adapterRef(entry as never, name);
    } catch {
      fail("INVALID_CONFIGURATION", `${name} is invalid`);
    }
  };
  const price = (candidate: unknown, name: string): ExactPrice => {
    const entry = exactObject(
      candidate,
      ["baseAsset", "baseAtoms", "quoteAsset", "quoteAtoms", "roundingDirection"],
      name,
    );
    try {
      return exactPrice({
        ...entry,
        baseAsset: asset(entry.baseAsset, `${name}.baseAsset`),
        quoteAsset: asset(entry.quoteAsset, `${name}.quoteAsset`),
      } as never, name);
    } catch { fail("INVALID_CONFIGURATION", `${name} is invalid`); }
  };
  const rate = (candidate: unknown, name: string): ExactSignedRate => {
    const entry = exactObject(
      candidate,
      ["baseAsset", "baseAtoms", "quoteAsset", "quoteAtoms", "roundingDirection"],
      name,
    );
    try {
      return exactSignedRate({
        ...entry,
        baseAsset: asset(entry.baseAsset, `${name}.baseAsset`),
        quoteAsset: asset(entry.quoteAsset, `${name}.quoteAsset`),
      } as never, name);
    } catch { fail("INVALID_CONFIGURATION", `${name} is invalid`); }
  };
  const fees = (candidate: unknown, name: string): readonly FeeCap[] => {
    if (!Array.isArray(candidate) || candidate.length === 0) fail("INVALID_CONFIGURATION", `${name} is invalid`);
    try {
      return Object.freeze(candidate.map((entry, index) => {
        const checked = exactObject(entry, ["asset", "maxAtoms"], `${name}[${index}]`);
        return feeCap({
          asset: asset(checked.asset, `${name}[${index}].asset`),
          maxAtoms: checked.maxAtoms,
        } as never, `${name}[${index}]`);
      }));
    }
    catch { fail("INVALID_CONFIGURATION", `${name} is invalid`); }
  };
  const baseAsset = asset(raw.baseAsset, "orderContext.baseAsset");
  const quoteAsset = asset(raw.quoteAsset, "orderContext.quoteAsset");
  const context = Object.freeze({
    contextId: bounded(raw.contextId, "orderContext.contextId"),
    tradingAccount: bounded(raw.tradingAccount, "orderContext.tradingAccount"),
    orderVersion: requirePositiveInteger(raw.orderVersion, "orderContext.orderVersion"),
    templateId: bounded(raw.templateId, "orderContext.templateId"),
    templateVersion: requirePositiveInteger(raw.templateVersion, "orderContext.templateVersion"),
    packageTemplateManifestHash: checkedSolverKey(raw.packageTemplateManifestHash as string),
    baseAsset,
    quoteAsset,
    spotAdapter: adapter(raw.spotAdapter, "orderContext.spotAdapter"),
    perpetualAdapter: adapter(raw.perpetualAdapter, "orderContext.perpetualAdapter"),
    maxStalenessMs: atom(raw.maxStalenessMs, "orderContext.maxStalenessMs"),
    expiryTtlMs: atom(raw.expiryTtlMs, "orderContext.expiryTtlMs", true),
    recoveryActionExpiryTtlMs: atom(raw.recoveryActionExpiryTtlMs, "orderContext.recoveryActionExpiryTtlMs", true),
    recoveryDeadlineTtlMs: atom(raw.recoveryDeadlineTtlMs, "orderContext.recoveryDeadlineTtlMs", true),
    minRecoveryWindowMs: atom(raw.minRecoveryWindowMs, "orderContext.minRecoveryWindowMs", true),
    spotReferencePrice: price(raw.spotReferencePrice, "orderContext.spotReferencePrice"),
    maxEntrySpread: rate(raw.maxEntrySpread, "orderContext.maxEntrySpread"),
    minPerpSellPrice: price(raw.minPerpSellPrice, "orderContext.minPerpSellPrice"),
    maxRecoverySpotBuyPrice: price(raw.maxRecoverySpotBuyPrice, "orderContext.maxRecoverySpotBuyPrice"),
    minRecoverySpotSellPrice: price(raw.minRecoverySpotSellPrice, "orderContext.minRecoverySpotSellPrice"),
    minRecoveryPerpSellPrice: price(raw.minRecoveryPerpSellPrice, "orderContext.minRecoveryPerpSellPrice"),
    maxRecoveryPerpBuyPrice: price(raw.maxRecoveryPerpBuyPrice, "orderContext.maxRecoveryPerpBuyPrice"),
    maximumQuantityAtoms: atom(raw.maximumQuantityAtoms, "orderContext.maximumQuantityAtoms", true),
    maxSlippageBps: requirePositiveInteger(raw.maxSlippageBps, "orderContext.maxSlippageBps"),
    maxNetSpotShortfallAtoms: atom(raw.maxNetSpotShortfallAtoms, "orderContext.maxNetSpotShortfallAtoms"),
    maxNetSpotExcessAtoms: atom(raw.maxNetSpotExcessAtoms, "orderContext.maxNetSpotExcessAtoms"),
    maxTerminalResidualBaseQuantityAtoms: atom(raw.maxTerminalResidualBaseQuantityAtoms, "orderContext.maxTerminalResidualBaseQuantityAtoms"),
    maxTerminalResidualQuoteValueAtoms: atom(raw.maxTerminalResidualQuoteValueAtoms, "orderContext.maxTerminalResidualQuoteValueAtoms"),
    residualValuationReferencePrice: price(raw.residualValuationReferencePrice, "orderContext.residualValuationReferencePrice"),
    maxVenueFeeAtomsByAsset: fees(raw.maxVenueFeeAtomsByAsset, "orderContext.maxVenueFeeAtomsByAsset"),
    maxMarginAddedAtoms: atom(raw.maxMarginAddedAtoms, "orderContext.maxMarginAddedAtoms"),
    maxProtocolFeeAtoms: atom(raw.maxProtocolFeeAtoms, "orderContext.maxProtocolFeeAtoms"),
    maxSolverFeeAtoms: atom(raw.maxSolverFeeAtoms, "orderContext.maxSolverFeeAtoms"),
    maxPriorityFeeAtoms: atom(raw.maxPriorityFeeAtoms, "orderContext.maxPriorityFeeAtoms"),
    minVenueReserveReturnedAtoms: atom(raw.minVenueReserveReturnedAtoms, "orderContext.minVenueReserveReturnedAtoms"),
    minWalletQuoteBalanceDeltaAtoms: atom(raw.minWalletQuoteBalanceDeltaAtoms, "orderContext.minWalletQuoteBalanceDeltaAtoms"),
    maxResidualBaseQuantityAtoms: atom(raw.maxResidualBaseQuantityAtoms, "orderContext.maxResidualBaseQuantityAtoms"),
    maxRecoveryCostAtomsByAsset: fees(raw.maxRecoveryCostAtomsByAsset, "orderContext.maxRecoveryCostAtomsByAsset"),
    maxAggregateRecoveryLossQuoteAtoms: atom(raw.maxAggregateRecoveryLossQuoteAtoms, "orderContext.maxAggregateRecoveryLossQuoteAtoms"),
  });
  if (context.maxSlippageBps > 10_000
      || !/^0x[0-9a-f]{40}$/.test(context.tradingAccount)
      || context.recoveryActionExpiryTtlMs >= context.recoveryDeadlineTtlMs
      || context.expiryTtlMs + context.minRecoveryWindowMs > context.recoveryDeadlineTtlMs
      || context.maxNetSpotShortfallAtoms > context.maximumQuantityAtoms) {
    fail("INVALID_CONFIGURATION", "Hyperliquid order bounds are inconsistent");
  }
  return context;
}

export function loadHyperliquidTestnetRuntimeConfig(path: string): HyperliquidTestnetRuntimeConfig {
  if (!isAbsolute(path)) {
    fail("INVALID_CONFIGURATION", "Hyperliquid runtime config path must be absolute");
  }
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(
      readFileSync(resolve(path), "utf8"),
      "hyperliquidTestnet.runtimeConfig",
    );
  } catch {
    fail("INVALID_CONFIGURATION", "Hyperliquid runtime config is not strict protocol JSON");
  }
  const rootRecord = parsed as Record<string, unknown>;
  const rootKeys = [
    "bounds", "domain", "environment", "executionClassManifestHash", "market",
    "seriesManifestHash", "solverId", "solverVerificationKey", "version",
    ...(typeof rootRecord === "object" && rootRecord !== null && "orderContext" in rootRecord
      ? ["orderContext"] : []),
  ];
  const root = exactObject(parsed, rootKeys, "runtime config");
  if (root.version !== 1 || root.environment !== "TESTNET") {
    fail("INVALID_CONFIGURATION", "Hyperliquid runtime config must be version 1 TESTNET");
  }
  const domain = exactObject(
    root.domain,
    ["domainId", "domainManifestHash", "domainManifestVersion"],
    "domain",
  );
  if (typeof domain.domainId !== "string" || typeof domain.domainManifestVersion !== "number"
    || typeof domain.domainManifestHash !== "string") {
    fail("INVALID_CONFIGURATION", "Hyperliquid runtime domain is invalid");
  }
  let checkedDomain: DomainRef;
  try {
    checkedDomain = domainRef(
      domain.domainId,
      domain.domainManifestVersion,
      domain.domainManifestHash,
    );
  } catch {
    fail("INVALID_CONFIGURATION", "Hyperliquid runtime domain is invalid");
  }
  domainBinding(checkedDomain);
  if (typeof root.seriesManifestHash !== "string"
    || typeof root.executionClassManifestHash !== "string"
    || typeof root.solverId !== "string"
    || typeof root.solverVerificationKey !== "string") {
    fail("INVALID_CONFIGURATION", "Hyperliquid runtime identities are invalid");
  }
  if (root.solverId.length < 1 || root.solverId.length > 128) {
    fail("INVALID_CONFIGURATION", "solver ID is invalid");
  }
  const market = exactObject(root.market, ["perpetual", "quoteTokenIndex", "spot"], "market");
  const commonMarketFields = [
    "adapterId", "adapterManifestHash", "adapterManifestVersion", "assetId", "marketId",
    "marketManifestHash", "marketManifestVersion", "sizeDecimals", "venueId",
    "venueManifestHash", "venueManifestVersion",
  ];
  const spot = exactObject(
    market.spot,
    [...commonMarketFields, "tokenIndex", "universeIndex"],
    "market.spot",
  );
  const perpetual = exactObject(
    market.perpetual,
    [...commonMarketFields, "assetIndex"],
    "market.perpetual",
  );
  const bounds = exactObject(
    root.bounds,
    ["maxEvidenceAgeMs", "maxFillPages", "maxSnapshotSkewMs"],
    "bounds",
  );
  const checkedMarket = marketMetadata({
    spot,
    perpetual,
    quoteTokenIndex: market.quoteTokenIndex,
  } as HyperliquidTestnetMarketMetadata);
  const checkedOrderContext = root.orderContext === undefined ? undefined : orderContext(root.orderContext);
  if (checkedOrderContext !== undefined
      && (checkedOrderContext.spotAdapter.adapterId !== checkedMarket.spot.adapterId
        || checkedOrderContext.spotAdapter.adapterManifestVersion !== checkedMarket.spot.adapterManifestVersion
        || toHex(checkedOrderContext.spotAdapter.adapterManifestHash) !== checkedMarket.spot.adapterManifestHash
        || checkedOrderContext.perpetualAdapter.adapterId !== checkedMarket.perpetual.adapterId
        || checkedOrderContext.perpetualAdapter.adapterManifestVersion !== checkedMarket.perpetual.adapterManifestVersion
        || toHex(checkedOrderContext.perpetualAdapter.adapterManifestHash) !== checkedMarket.perpetual.adapterManifestHash
        || checkedOrderContext.baseAsset.decimals !== checkedMarket.spot.sizeDecimals
        || checkedOrderContext.baseAsset.decimals !== checkedMarket.perpetual.sizeDecimals)) {
    fail("INVALID_CONFIGURATION", "Hyperliquid order context does not match configured market metadata");
  }
  return Object.freeze({
    domain: checkedDomain,
    seriesManifestHash: checkedSolverKey(root.seriesManifestHash),
    executionClassManifestHash: checkedSolverKey(root.executionClassManifestHash),
    solverId: root.solverId,
    solverVerificationKey: checkedSolverKey(root.solverVerificationKey),
    market: checkedMarket,
    bounds: executionBounds(bounds as HyperliquidTestnetExecutionBounds),
    ...(checkedOrderContext === undefined ? {} : { orderContext: checkedOrderContext }),
  });
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
  const seriesManifestHash = checkedSolverKey(options.seriesManifestHash);
  const executionClassManifestHash = checkedSolverKey(options.executionClassManifestHash);
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
        admission: Object.freeze({
          order,
          route: verified.route,
          quote: verified.quote,
          orderHash: fromHex(attempt.orderHash, "orderHash"),
          routeHash: fromHex(attempt.routeHash, "routeHash"),
          quoteHash: fromHex(attempt.quoteHash, "quoteHash"),
        }) as PackageAdmission,
        seriesManifestHash,
        executionClassManifestHash,
        market,
        limits: bounds,
        selectedAtMs: attempt.selectedAtMs,
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
