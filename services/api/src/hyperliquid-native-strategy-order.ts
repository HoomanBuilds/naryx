import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  adapterRef,
  assetAmount,
  assetRef,
  domainRef,
  exactPrice,
  manifestHash,
  packageGraph,
  packageGraphHash,
  parseProtocolJson,
  protocolId,
  requireStrategyTemplateDefinition,
  strategyPackageOrder,
  strategyPackageOrderHash,
  toHex,
  versionedManifestRef,
  STRATEGY_TEMPLATE_ID,
  type AdapterRef,
  type AssetRef,
  type DomainRef,
  type GraphLegSide,
  type GraphLifecycleAction,
  type PackageGraph,
  type StrategyMetricLimitInput,
  type StrategyPackageOrder,
  type VersionedManifestRef,
} from "@naryx/protocol-types";
import type {
  StrategyOrderIntakePort,
  StrategyOrderIntakeResult,
} from "./strategy-order-intake.js";

const MAX_CONFIG_BYTES = 1_048_576;
const U256_MAX = (1n << 256n) - 1n;
const OWNER = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const COIN = /^[A-Za-z0-9@._:/-]{1,64}$/;

type NativeRole = "treasury-hedge" | "funding-long" | "funding-short"
  | "source-hedge" | "destination-hedge";

export class HyperliquidNativeStrategyOrderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HyperliquidNativeStrategyOrderError";
    this.code = code;
  }
}

export interface HyperliquidNativeStrategyMarketProfile {
  readonly role: NativeRole;
  readonly entrySide: Exclude<GraphLegSide, "NONE">;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly coin: string;
  readonly assetId: number;
  readonly sizeDecimals: number;
  readonly maximumPriceDecimals: number;
}

export interface HyperliquidNativeStrategyBounds {
  readonly minimumQuantityAtoms: bigint;
  readonly maximumQuantityAtoms: bigint;
  readonly maximumEconomicQuantityAtoms: bigint;
  readonly maximumServiceFeeQuoteAtoms: bigint;
  readonly maximumVenueFeeQuoteAtoms: bigint;
  readonly maximumRecoveryCostQuoteAtoms: bigint;
  readonly maximumAggregateRecoveryLossQuoteAtoms: bigint;
  readonly maximumMarginIncreaseQuoteAtoms: bigint;
  readonly maximumResidualValueQuoteAtoms: bigint;
  readonly maximumExpiryTtlMs: bigint;
}

export interface HyperliquidNativeStrategyProfile {
  readonly profileId: string;
  readonly displayName: string;
  readonly templateId:
    | typeof STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE
    | typeof STRATEGY_TEMPLATE_ID.PERPETUAL_FUNDING_SPREAD
    | typeof STRATEGY_TEMPLATE_ID.HEDGE_MIGRATION;
  readonly templateVersion: 1;
  readonly packageTemplateManifestHash: Uint8Array;
  readonly seriesId: string;
  readonly seriesVersion: number;
  readonly seriesManifestHash: Uint8Array;
  readonly executionClassId: string;
  readonly executionClassVersion: number;
  readonly executionClassManifestHash: Uint8Array;
  readonly domain: DomainRef;
  readonly settlementAccount: string;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly markets: readonly HyperliquidNativeStrategyMarketProfile[];
  readonly metricLimits: readonly StrategyMetricLimitInput[];
  readonly bounds: HyperliquidNativeStrategyBounds;
}

export interface HyperliquidNativeStrategyOrderRequest {
  readonly profileId: string;
  readonly owner: string;
  readonly lifecycleAction: "ENTRY" | "INCREASE" | "DECREASE" | "EXIT" | "MIGRATE" | "EMERGENCY_UNWIND";
  readonly quantityAtoms: string;
  readonly economicQuantityAtoms: string;
  readonly limitPrices: readonly Readonly<{
    legId: NativeRole;
    quoteAtoms: string;
    baseAtoms: string;
  }>[];
  readonly expiryValue: string;
  readonly nonce: string;
  readonly expectedStrategyStateHash?: string;
}

export interface CreatedHyperliquidNativeStrategyOrder {
  readonly profileId: string;
  readonly order: StrategyPackageOrder;
  readonly graph: PackageGraph;
  readonly intake: StrategyOrderIntakeResult;
}

export interface HyperliquidNativeStrategyOrderPort {
  profiles(): readonly HyperliquidNativeStrategyProfile[];
  create(request: unknown): CreatedHyperliquidNativeStrategyOrder;
}

function fail(code: string, message: string): never {
  throw new HyperliquidNativeStrategyOrderError(code, message);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("INVALID_CONFIGURATION", `${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("INVALID_CONFIGURATION", `${context} fields are invalid.`);
  }
}

function positiveU256(value: unknown, context: string): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > U256_MAX) {
    fail("INVALID_CONFIGURATION", `${context} must be a positive u256.`);
  }
  return value;
}

function nonnegativeU256(value: unknown, context: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U256_MAX) {
    fail("INVALID_CONFIGURATION", `${context} must be a nonnegative u256.`);
  }
  return value;
}

function positiveVersion(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 0xffff_ffff) {
    fail("INVALID_CONFIGURATION", `${context} must be a positive u32.`);
  }
  return value as number;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail("INVALID_CONFIGURATION", `${context} is out of range.`);
  }
  return value as number;
}

function checkedProfile(value: unknown, index: number): HyperliquidNativeStrategyProfile {
  const context = `native strategy profile ${index}`;
  const profile = record(value, context);
  exactKeys(profile, [
    "profileId", "displayName", "templateId", "templateVersion",
    "packageTemplateManifestHash", "seriesId", "seriesVersion", "seriesManifestHash",
    "executionClassId", "executionClassVersion", "executionClassManifestHash", "domain",
    "settlementAccount", "baseAsset", "quoteAsset", "markets", "metricLimits", "bounds",
  ], context);
  if (typeof profile.profileId !== "string" || typeof profile.displayName !== "string"
    || typeof profile.seriesId !== "string" || typeof profile.executionClassId !== "string"
    || typeof profile.settlementAccount !== "string") {
    fail("INVALID_CONFIGURATION", `${context} identities are invalid.`);
  }
  const profileId = protocolId(profile.profileId, `${context}.profileId`);
  const displayName = profile.displayName.trim();
  if (displayName.length === 0 || displayName.length > 80) {
    fail("INVALID_CONFIGURATION", `${context}.displayName is invalid.`);
  }
  const templateId = profile.templateId;
  if (templateId !== STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE
    && templateId !== STRATEGY_TEMPLATE_ID.PERPETUAL_FUNDING_SPREAD
    && templateId !== STRATEGY_TEMPLATE_ID.HEDGE_MIGRATION) {
    fail("INVALID_CONFIGURATION", `${context}.templateId is unsupported.`);
  }
  const templateVersion = positiveVersion(profile.templateVersion, `${context}.templateVersion`);
  if (templateVersion !== 1) fail("INVALID_CONFIGURATION", `${context}.templateVersion is unsupported.`);
  const domainValue = profile.domain as DomainRef;
  const domain = domainRef(
    domainValue.domainId,
    domainValue.domainManifestVersion,
    domainValue.domainManifestHash,
  );
  if (domain.domainId !== "hypercore:testnet") {
    fail("INVALID_CONFIGURATION", `${context}.domain must be HyperCore Testnet.`);
  }
  const baseValue = profile.baseAsset as AssetRef;
  const quoteValue = profile.quoteAsset as AssetRef;
  const baseAsset = assetRef(baseValue.assetId, baseValue.assetManifestHash, baseValue.decimals);
  const quoteAsset = assetRef(quoteValue.assetId, quoteValue.assetManifestHash, quoteValue.decimals);
  if (baseAsset.assetId === quoteAsset.assetId) {
    fail("INVALID_CONFIGURATION", `${context} base and quote assets must differ.`);
  }
  if (!Array.isArray(profile.markets)) fail("INVALID_CONFIGURATION", `${context}.markets must be an array.`);
  const markets = profile.markets.map((candidate, marketIndex): HyperliquidNativeStrategyMarketProfile => {
    const marketContext = `${context}.markets[${marketIndex}]`;
    const market = record(candidate, marketContext);
    exactKeys(market, [
      "role", "entrySide", "adapter", "venue", "market", "coin", "assetId",
      "sizeDecimals", "maximumPriceDecimals",
    ], marketContext);
    if ((market.role !== "treasury-hedge" && market.role !== "funding-long" && market.role !== "funding-short"
      && market.role !== "source-hedge" && market.role !== "destination-hedge")
      || (market.entrySide !== "BUY" && market.entrySide !== "SELL")
      || typeof market.coin !== "string" || !COIN.test(market.coin)) {
      fail("INVALID_CONFIGURATION", `${marketContext} role, side, or coin is invalid.`);
    }
    return Object.freeze({
      role: market.role,
      entrySide: market.entrySide,
      adapter: adapterRef(market.adapter as never, `${marketContext}.adapter`),
      venue: versionedManifestRef(
        (market.venue as VersionedManifestRef).subjectId,
        (market.venue as VersionedManifestRef).manifestVersion,
        (market.venue as VersionedManifestRef).manifestHash,
        `${marketContext}.venue`,
      ),
      market: versionedManifestRef(
        (market.market as VersionedManifestRef).subjectId,
        (market.market as VersionedManifestRef).manifestVersion,
        (market.market as VersionedManifestRef).manifestHash,
        `${marketContext}.market`,
      ),
      coin: market.coin,
      assetId: boundedInteger(market.assetId, 0, 0xffff_ffff, `${marketContext}.assetId`),
      sizeDecimals: boundedInteger(market.sizeDecimals, 0, 8, `${marketContext}.sizeDecimals`),
      maximumPriceDecimals: boundedInteger(
        market.maximumPriceDecimals, 0, 8, `${marketContext}.maximumPriceDecimals`,
      ),
    });
  });
  const roles = markets.map((market) => market.role).sort().join(",");
  const templateMarketsValid = templateId === STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE
    ? roles === "treasury-hedge"
    : templateId === STRATEGY_TEMPLATE_ID.PERPETUAL_FUNDING_SPREAD
      ? roles === "funding-long,funding-short"
        && markets.find((market) => market.role === "funding-long")?.entrySide === "BUY"
        && markets.find((market) => market.role === "funding-short")?.entrySide === "SELL"
      : roles === "destination-hedge,source-hedge"
        && markets.find((market) => market.role === "source-hedge")?.entrySide
          === markets.find((market) => market.role === "destination-hedge")?.entrySide;
  if (!templateMarketsValid) {
    fail("INVALID_CONFIGURATION", `${context}.markets do not match the strategy template.`);
  }
  if (new Set(markets.map((market) => market.assetId)).size !== markets.length) {
    fail("INVALID_CONFIGURATION", `${context}.markets repeat a HyperCore asset ID.`);
  }
  const boundsValue = record(profile.bounds, `${context}.bounds`);
  exactKeys(boundsValue, [
    "minimumQuantityAtoms", "maximumQuantityAtoms", "maximumEconomicQuantityAtoms",
    "maximumServiceFeeQuoteAtoms", "maximumVenueFeeQuoteAtoms", "maximumRecoveryCostQuoteAtoms",
    "maximumAggregateRecoveryLossQuoteAtoms", "maximumMarginIncreaseQuoteAtoms",
    "maximumResidualValueQuoteAtoms", "maximumExpiryTtlMs",
  ], `${context}.bounds`);
  const bounds: HyperliquidNativeStrategyBounds = Object.freeze({
    minimumQuantityAtoms: positiveU256(boundsValue.minimumQuantityAtoms, `${context}.bounds.minimumQuantityAtoms`),
    maximumQuantityAtoms: positiveU256(boundsValue.maximumQuantityAtoms, `${context}.bounds.maximumQuantityAtoms`),
    maximumEconomicQuantityAtoms: positiveU256(
      boundsValue.maximumEconomicQuantityAtoms, `${context}.bounds.maximumEconomicQuantityAtoms`,
    ),
    maximumServiceFeeQuoteAtoms: nonnegativeU256(
      boundsValue.maximumServiceFeeQuoteAtoms, `${context}.bounds.maximumServiceFeeQuoteAtoms`,
    ),
    maximumVenueFeeQuoteAtoms: nonnegativeU256(
      boundsValue.maximumVenueFeeQuoteAtoms, `${context}.bounds.maximumVenueFeeQuoteAtoms`,
    ),
    maximumRecoveryCostQuoteAtoms: nonnegativeU256(
      boundsValue.maximumRecoveryCostQuoteAtoms, `${context}.bounds.maximumRecoveryCostQuoteAtoms`,
    ),
    maximumAggregateRecoveryLossQuoteAtoms: nonnegativeU256(
      boundsValue.maximumAggregateRecoveryLossQuoteAtoms,
      `${context}.bounds.maximumAggregateRecoveryLossQuoteAtoms`,
    ),
    maximumMarginIncreaseQuoteAtoms: nonnegativeU256(
      boundsValue.maximumMarginIncreaseQuoteAtoms, `${context}.bounds.maximumMarginIncreaseQuoteAtoms`,
    ),
    maximumResidualValueQuoteAtoms: nonnegativeU256(
      boundsValue.maximumResidualValueQuoteAtoms, `${context}.bounds.maximumResidualValueQuoteAtoms`,
    ),
    maximumExpiryTtlMs: positiveU256(boundsValue.maximumExpiryTtlMs, `${context}.bounds.maximumExpiryTtlMs`),
  });
  if (bounds.minimumQuantityAtoms > bounds.maximumQuantityAtoms
    || bounds.maximumQuantityAtoms > bounds.maximumEconomicQuantityAtoms
    || bounds.maximumAggregateRecoveryLossQuoteAtoms
      < bounds.maximumRecoveryCostQuoteAtoms * BigInt(markets.length)
    || bounds.maximumExpiryTtlMs < 10_000n
    || bounds.maximumExpiryTtlMs > 86_400_000n) {
    fail("INVALID_CONFIGURATION", `${context}.bounds are inconsistent.`);
  }
  if (!Array.isArray(profile.metricLimits)) {
    fail("INVALID_CONFIGURATION", `${context}.metricLimits must be an array.`);
  }
  const definition = requireStrategyTemplateDefinition(templateId);
  const metricLimits = Object.freeze(profile.metricLimits as StrategyMetricLimitInput[]);
  const settlementAccount = protocolId(profile.settlementAccount, `${context}.settlementAccount`);
  const seriesId = protocolId(profile.seriesId, `${context}.seriesId`);
  const executionClassId = protocolId(profile.executionClassId, `${context}.executionClassId`);
  const packageTemplateManifestHash = manifestHash(
    profile.packageTemplateManifestHash as Uint8Array,
    `${context}.packageTemplateManifestHash`,
  );
  const seriesManifestHash = manifestHash(profile.seriesManifestHash as Uint8Array, `${context}.seriesManifestHash`);
  const executionClassManifestHash = manifestHash(
    profile.executionClassManifestHash as Uint8Array,
    `${context}.executionClassManifestHash`,
  );
  const lifecycleAction = templateId === STRATEGY_TEMPLATE_ID.HEDGE_MIGRATION ? "MIGRATE" : "ENTRY";
  try {
    strategyPackageOrder({
      version: 1,
      environment: "testnet",
      templateId,
      templateVersion: 1,
      packageTemplateManifestHash,
      graphHash: "01".repeat(32),
      seriesId,
      seriesVersion: positiveVersion(profile.seriesVersion, `${context}.seriesVersion`),
      seriesManifestHash,
      executionClassId,
      executionClassVersion: positiveVersion(profile.executionClassVersion, `${context}.executionClassVersion`),
      executionClassManifestHash,
      quoteConventionId: definition.quoteConventionId,
      riskClassId: definition.riskClassId,
      owner: "0x1111111111111111111111111111111111111111",
      settlementAccount,
      lifecycleAction,
      settlementClass: "BATCHED_IOC_WITH_RECOVERY",
      packageOrderType: "MARKETABLE_LIMIT",
      packageTimeInForce: "IOC",
      economicQuantity: assetAmount(baseAsset, bounds.minimumQuantityAtoms),
      quoteAsset,
      metricLimits,
      maximumServiceFeesByAsset: [],
      maximumVenueFeesByAsset: [],
      maximumNetworkFeesByAsset: [],
      maximumRecoveryCostByAsset: [],
      maximumMarginIncrease: assetAmount(quoteAsset, 0n),
      maximumResidualValue: assetAmount(quoteAsset, 0n),
      ...(lifecycleAction === "MIGRATE" ? { expectedStrategyStateHash: "02".repeat(32) } : {}),
      expiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
      expiryValue: 2n,
      nonce: 1n,
    });
  } catch {
    fail("INVALID_CONFIGURATION", `${context}.metricLimits or identities are invalid.`);
  }
  return Object.freeze({
    profileId,
    displayName,
    templateId,
    templateVersion: 1,
    packageTemplateManifestHash,
    seriesId,
    seriesVersion: positiveVersion(profile.seriesVersion, `${context}.seriesVersion`),
    seriesManifestHash,
    executionClassId,
    executionClassVersion: positiveVersion(profile.executionClassVersion, `${context}.executionClassVersion`),
    executionClassManifestHash,
    domain,
    settlementAccount,
    baseAsset,
    quoteAsset,
    markets: Object.freeze(markets),
    metricLimits,
    bounds,
  });
}

export function loadHyperliquidNativeStrategyProfiles(path: string): readonly HyperliquidNativeStrategyProfile[] {
  if (!isAbsolute(path)) fail("INVALID_CONFIGURATION", "Native strategy profile path must be absolute.");
  const resolved = resolve(path);
  if (statSync(resolved).size > MAX_CONFIG_BYTES) {
    fail("INVALID_CONFIGURATION", "Native strategy profile file is too large.");
  }
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(readFileSync(resolved, "utf8"), "hyperliquidNativeStrategyProfiles");
  } catch {
    fail("INVALID_CONFIGURATION", "Native strategy profile file is not valid protocol JSON.");
  }
  const root = record(parsed, "native strategy profile file");
  exactKeys(root, ["version", "environment", "profiles"], "native strategy profile file");
  if (root.version !== 1 || root.environment !== "testnet" || !Array.isArray(root.profiles)
    || root.profiles.length === 0 || root.profiles.length > 16) {
    fail("INVALID_CONFIGURATION", "Native strategy profile file must contain one to sixteen Testnet profiles.");
  }
  const profiles = root.profiles.map(checkedProfile);
  if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length) {
    fail("INVALID_CONFIGURATION", "Native strategy profile IDs must be unique.");
  }
  return Object.freeze(profiles);
}

function requestAtoms(value: string, name: string, allowZero = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    fail("INVALID_REQUEST", `${name} must be decimal atoms.`);
  }
  const atoms = BigInt(value);
  if (atoms > U256_MAX || (!allowZero && atoms === 0n)) fail("INVALID_REQUEST", `${name} is out of range.`);
  return atoms;
}

function policyHash(profile: HyperliquidNativeStrategyProfile, request: HyperliquidNativeStrategyOrderRequest, name: string): string {
  return createHash("sha256").update([
    "NARYX/native-strategy-policy/v1",
    profile.profileId,
    request.owner,
    request.lifecycleAction,
    request.nonce,
    request.expectedStrategyStateHash ?? "",
    name,
  ].join("\0"), "utf8").digest("hex");
}

function reverse(side: Exclude<GraphLegSide, "NONE">): Exclude<GraphLegSide, "NONE"> {
  return side === "BUY" ? "SELL" : "BUY";
}

function alignedQuantity(atoms: bigint, assetDecimals: number, sizeDecimals: number): boolean {
  return atoms * (10n ** BigInt(sizeDecimals)) % (10n ** BigInt(assetDecimals)) === 0n;
}

export function createHyperliquidNativeStrategyOrderPort(input: Readonly<{
  profiles: readonly HyperliquidNativeStrategyProfile[];
  intake: StrategyOrderIntakePort;
  currentTimeMs?: () => number;
}>): HyperliquidNativeStrategyOrderPort {
  if (input.profiles.length === 0) fail("INVALID_CONFIGURATION", "At least one native strategy profile is required.");
  const profiles = new Map(input.profiles.map((profile) => [profile.profileId, profile]));
  if (profiles.size !== input.profiles.length) fail("INVALID_CONFIGURATION", "Native strategy profile IDs repeat.");
  const currentTimeMs = input.currentTimeMs ?? Date.now;
  return Object.freeze({
    profiles: () => Object.freeze([...profiles.values()]),
    create(requestValue: unknown): CreatedHyperliquidNativeStrategyOrder {
      if (typeof requestValue !== "object" || requestValue === null || Array.isArray(requestValue)) {
        fail("INVALID_REQUEST", "Native strategy order request must be an object.");
      }
      const fields = requestValue as Record<string, unknown>;
      const allowed = new Set([
        "profileId", "owner", "lifecycleAction", "quantityAtoms", "economicQuantityAtoms",
        "limitPrices", "expiryValue", "nonce", "expectedStrategyStateHash",
      ]);
      const required = [...allowed].filter((name) => name !== "expectedStrategyStateHash");
      if (Object.keys(fields).some((name) => !allowed.has(name))
        || required.some((name) => !(name in fields))
        || typeof fields.profileId !== "string"
        || typeof fields.owner !== "string"
        || (fields.lifecycleAction !== "ENTRY" && fields.lifecycleAction !== "INCREASE"
          && fields.lifecycleAction !== "DECREASE" && fields.lifecycleAction !== "EXIT"
          && fields.lifecycleAction !== "MIGRATE"
          && fields.lifecycleAction !== "EMERGENCY_UNWIND")
        || typeof fields.quantityAtoms !== "string"
        || typeof fields.economicQuantityAtoms !== "string"
        || typeof fields.expiryValue !== "string"
        || typeof fields.nonce !== "string"
        || (fields.expectedStrategyStateHash !== undefined
          && typeof fields.expectedStrategyStateHash !== "string")
        || !Array.isArray(fields.limitPrices)) {
        fail("INVALID_REQUEST", "Native strategy order request fields are invalid.");
      }
      const request = fields as unknown as HyperliquidNativeStrategyOrderRequest;
      const profile = profiles.get(request.profileId);
      if (profile === undefined) fail("PROFILE_NOT_FOUND", "Native strategy profile was not found.");
      if (!OWNER.test(request.owner) || (request.lifecycleAction !== "ENTRY"
        && request.lifecycleAction !== "INCREASE" && request.lifecycleAction !== "DECREASE"
        && request.lifecycleAction !== "MIGRATE"
        && request.lifecycleAction !== "EXIT" && request.lifecycleAction !== "EMERGENCY_UNWIND")) {
        fail("INVALID_REQUEST", "Owner or lifecycle action is invalid.");
      }
      if (request.lifecycleAction === "ENTRY" && request.expectedStrategyStateHash !== undefined) {
        fail("INVALID_REQUEST", "Entry cannot bind an existing strategy state.");
      }
      if (request.lifecycleAction !== "ENTRY"
        && (request.expectedStrategyStateHash === undefined
          || !/^[0-9a-f]{64}$/.test(request.expectedStrategyStateHash))) {
        fail("INVALID_REQUEST", "A lifecycle transition requires the exact expected strategy state hash.");
      }
      if ((profile.templateId === STRATEGY_TEMPLATE_ID.HEDGE_MIGRATION) !== (request.lifecycleAction === "MIGRATE")) {
        fail("INVALID_REQUEST", "The selected native strategy profile does not support this lifecycle action.");
      }
      const quantityAtoms = requestAtoms(request.quantityAtoms, "quantityAtoms");
      const economicQuantityAtoms = requestAtoms(request.economicQuantityAtoms, "economicQuantityAtoms");
      const expiryValue = requestAtoms(request.expiryValue, "expiryValue");
      const nonce = requestAtoms(request.nonce, "nonce");
      const now = currentTimeMs();
      if (!Number.isSafeInteger(now) || now <= 0) fail("INVALID_CONFIGURATION", "Native strategy clock is invalid.");
      if (quantityAtoms < profile.bounds.minimumQuantityAtoms
        || quantityAtoms > profile.bounds.maximumQuantityAtoms
        || economicQuantityAtoms > profile.bounds.maximumEconomicQuantityAtoms
        || expiryValue <= BigInt(now) + 5_000n
        || expiryValue > BigInt(now) + profile.bounds.maximumExpiryTtlMs) {
        fail("LIMIT_EXCEEDED", "Native strategy quantity or expiry is outside the reviewed profile bounds.");
      }
      if ((profile.templateId === STRATEGY_TEMPLATE_ID.PERPETUAL_FUNDING_SPREAD
        || profile.templateId === STRATEGY_TEMPLATE_ID.HEDGE_MIGRATION)
        ? economicQuantityAtoms !== quantityAtoms
        : economicQuantityAtoms < quantityAtoms) {
        fail("INVALID_REQUEST", "Economic and executable quantities do not match the strategy template.");
      }
      if (!profile.markets.every((market) =>
        alignedQuantity(quantityAtoms, profile.baseAsset.decimals, market.sizeDecimals))) {
        fail("INVALID_REQUEST", "Quantity is not aligned to every HyperCore market lot.");
      }
      if (!Array.isArray(request.limitPrices) || request.limitPrices.length !== profile.markets.length) {
        fail("INVALID_REQUEST", "Every strategy leg requires one exact limit price.");
      }
      if (request.limitPrices.some((limit) => typeof limit !== "object" || limit === null
        || Array.isArray(limit)
        || Object.keys(limit).sort().join(",") !== "baseAtoms,legId,quoteAtoms"
        || typeof limit.legId !== "string"
        || typeof limit.quoteAtoms !== "string"
        || typeof limit.baseAtoms !== "string")) {
        fail("INVALID_REQUEST", "Strategy limit price fields are invalid.");
      }
      const limits = new Map(request.limitPrices.map((limit) => [limit.legId, limit]));
      if (limits.size !== request.limitPrices.length
        || profile.markets.some((market) => !limits.has(market.role))) {
        fail("INVALID_REQUEST", "Strategy limit prices are missing or duplicated.");
      }
      const graphLegs = profile.markets.map((market) => {
        const limit = limits.get(market.role)!;
        const migration = request.lifecycleAction === "MIGRATE";
        const increasing = request.lifecycleAction === "ENTRY" || request.lifecycleAction === "INCREASE";
        const side = migration
          ? market.role === "source-hedge" ? reverse(market.entrySide) : market.entrySide
          : increasing ? market.entrySide : reverse(market.entrySide);
        const family = migration
          ? market.role === "source-hedge" ? "PERP_CLOSE" as const : "PERP_OPEN" as const
          : request.lifecycleAction === "ENTRY" ? "PERP_OPEN" as const
          : request.lifecycleAction === "INCREASE" ? "PERP_INCREASE" as const
            : request.lifecycleAction === "DECREASE" ? "PERP_DECREASE" as const
              : "PERP_CLOSE" as const;
        const quoteAtoms = requestAtoms(limit.quoteAtoms, `${market.role}.quoteAtoms`);
        const baseAtoms = requestAtoms(limit.baseAtoms, `${market.role}.baseAtoms`);
        return Object.freeze({
          legId: market.role,
          legFamily: family,
          legTypeId: market.role,
          domain: profile.domain,
          adapter: market.adapter,
          venue: market.venue,
          market: market.market,
          assets: Object.freeze([profile.baseAsset, profile.quoteAsset]),
          side,
          quantityAsset: profile.baseAsset,
          quantityAtoms,
          minimumQuantityAtoms: quantityAtoms,
          limitPrice: exactPrice({
            baseAsset: profile.baseAsset,
            quoteAsset: profile.quoteAsset,
            quoteAtoms,
            baseAtoms,
            roundingDirection: side === "BUY" ? "FLOOR" : "CEIL",
          }),
          maximumFeeQuoteAtoms: profile.bounds.maximumVenueFeeQuoteAtoms,
          preconditionHashes: Object.freeze([]),
          postconditionHashes: Object.freeze([]),
          timeInForce: "IOC" as const,
          legExpiryValue: expiryValue,
        });
      });
      const graph = packageGraph({
        graphVersion: 1,
        environment: "testnet",
        templateId: profile.templateId,
        templateVersion: profile.templateVersion,
        packageTemplateManifestHash: profile.packageTemplateManifestHash,
        seriesId: profile.seriesId,
        seriesVersion: profile.seriesVersion,
        seriesManifestHash: profile.seriesManifestHash,
        executionClassId: profile.executionClassId,
        executionClassVersion: profile.executionClassVersion,
        executionClassManifestHash: profile.executionClassManifestHash,
        lifecycleAction: request.lifecycleAction,
        owner: request.owner,
        strategyAccountRefs: [profile.settlementAccount],
        legs: graphLegs,
        dependencyEdges: [],
        executionGroups: [{
          groupId: "hypercore-ioc",
          kind: graphLegs.length === 1 ? "EXACT_FILL" : "BOUNDED_PARTIAL",
          legIds: graphLegs.map((leg) => leg.legId),
          ...(graphLegs.length === 1 ? {} : {
            maximumResidualQuoteAtoms: profile.bounds.maximumResidualValueQuoteAtoms,
          }),
        }],
        settlementClass: "BATCHED_IOC_WITH_RECOVERY",
        policyHashes: {
          netting: policyHash(profile, request, "netting"),
          privacy: policyHash(profile, request, "privacy"),
          solver: policyHash(profile, request, "solver"),
          delivery: policyHash(profile, request, "delivery"),
          resource: policyHash(profile, request, "resource"),
          portfolioRiskLimits: policyHash(profile, request, "portfolio-risk-limits"),
        },
        recoverySlots: graphLegs.map((leg) => ({
          legId: leg.legId,
          action: "COMPLETE" as const,
          maximumQuantityAtoms: quantityAtoms,
          maximumCostQuoteAtoms: profile.bounds.maximumRecoveryCostQuoteAtoms,
        })),
        maximumRecoveryCostQuoteAtoms: profile.bounds.maximumAggregateRecoveryLossQuoteAtoms,
        expiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
        packageExpiryValue: expiryValue,
        nonce,
      });
      const definition = requireStrategyTemplateDefinition(profile.templateId);
      const cap = (atoms: bigint) => atoms === 0n ? [] : [{ asset: profile.quoteAsset, maxAtoms: atoms }];
      const order = strategyPackageOrder({
        version: 1,
        environment: "testnet",
        templateId: profile.templateId,
        templateVersion: profile.templateVersion,
        packageTemplateManifestHash: profile.packageTemplateManifestHash,
        graphHash: packageGraphHash(graph),
        seriesId: profile.seriesId,
        seriesVersion: profile.seriesVersion,
        seriesManifestHash: profile.seriesManifestHash,
        executionClassId: profile.executionClassId,
        executionClassVersion: profile.executionClassVersion,
        executionClassManifestHash: profile.executionClassManifestHash,
        quoteConventionId: definition.quoteConventionId,
        riskClassId: definition.riskClassId,
        owner: request.owner,
        settlementAccount: profile.settlementAccount,
        lifecycleAction: request.lifecycleAction,
        settlementClass: "BATCHED_IOC_WITH_RECOVERY",
        packageOrderType: "MARKETABLE_LIMIT",
        packageTimeInForce: "IOC",
        economicQuantity: assetAmount(profile.baseAsset, economicQuantityAtoms),
        quoteAsset: profile.quoteAsset,
        metricLimits: profile.metricLimits,
        maximumServiceFeesByAsset: cap(profile.bounds.maximumServiceFeeQuoteAtoms),
        maximumVenueFeesByAsset: cap(profile.bounds.maximumVenueFeeQuoteAtoms),
        maximumNetworkFeesByAsset: [],
        maximumRecoveryCostByAsset: cap(profile.bounds.maximumAggregateRecoveryLossQuoteAtoms),
        maximumMarginIncrease: assetAmount(profile.quoteAsset, profile.bounds.maximumMarginIncreaseQuoteAtoms),
        maximumResidualValue: assetAmount(profile.quoteAsset, profile.bounds.maximumResidualValueQuoteAtoms),
        ...(request.expectedStrategyStateHash === undefined ? {} : {
          expectedStrategyStateHash: request.expectedStrategyStateHash,
        }),
        expiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
        expiryValue,
        nonce,
      });
      const intake = input.intake.store(order, graph);
      if (intake.orderHashHex !== toHex(strategyPackageOrderHash(order))
        || intake.graphHashHex !== toHex(packageGraphHash(graph))) {
        fail("INTAKE_MISMATCH", "Native strategy intake returned an invalid identity.");
      }
      return Object.freeze({ profileId: profile.profileId, order, graph, intake });
    },
  });
}
