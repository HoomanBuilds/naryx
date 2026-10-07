import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  STRATEGY_TEMPLATE_ID,
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
  type AdapterRef,
  type AssetRef,
  type DomainRef,
  type PackageGraph,
  type StrategyMetricLimitInput,
  type StrategyPackageOrder,
  type VersionedManifestRef,
} from "@naryx/protocol-types";
import type { StrategyOrderIntakePort, StrategyOrderIntakeResult } from "./strategy-order-intake.js";

const MAX_CONFIG_BYTES = 1_048_576;
const U256_MAX = (1n << 256n) - 1n;
const ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const TEST_CHAIN_IDS = new Set([84_532, 421_614, 31_337, 31_338]);

type CalendarRole = "near-future" | "far-future";
type SupportedAction = "ENTRY" | "INCREASE" | "DECREASE" | "EXIT" | "EMERGENCY_UNWIND";

export class EvmCalendarSpreadOrderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EvmCalendarSpreadOrderError";
    this.code = code;
  }
}

export interface EvmCalendarSpreadMarketProfile {
  readonly role: CalendarRole;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly maturity: bigint;
}

export interface EvmCalendarSpreadBounds {
  readonly minimumQuantityAtoms: bigint;
  readonly maximumQuantityAtoms: bigint;
  readonly maximumServiceFeeQuoteAtoms: bigint;
  readonly maximumVenueFeeQuoteAtoms: bigint;
  readonly maximumNetworkFeeQuoteAtoms: bigint;
  readonly maximumMarginIncreaseQuoteAtoms: bigint;
  readonly maximumExpiryTtlSeconds: bigint;
}

export interface EvmCalendarSpreadProfile {
  readonly profileId: string;
  readonly displayName: string;
  readonly templateId: typeof STRATEGY_TEMPLATE_ID.CALENDAR_SPREAD;
  readonly templateVersion: 1;
  readonly packageTemplateManifestHash: Uint8Array;
  readonly seriesId: string;
  readonly seriesVersion: number;
  readonly seriesManifestHash: Uint8Array;
  readonly executionClassId: string;
  readonly executionClassVersion: number;
  readonly executionClassManifestHash: Uint8Array;
  readonly chainId: number;
  readonly domain: DomainRef;
  readonly accountFactory: string;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly markets: readonly [EvmCalendarSpreadMarketProfile, EvmCalendarSpreadMarketProfile];
  readonly metricLimits: readonly StrategyMetricLimitInput[];
  readonly bounds: EvmCalendarSpreadBounds;
}

export interface EvmCalendarSpreadOrderRequest {
  readonly profileId: string;
  readonly owner: string;
  readonly settlementAccount: string;
  readonly lifecycleAction: SupportedAction;
  readonly quantityAtoms: string;
  readonly limitPrices: readonly Readonly<{
    legId: CalendarRole;
    quoteAtoms: string;
    baseAtoms: string;
  }>[];
  readonly expiryValue: string;
  readonly nonce: string;
  readonly expectedStrategyStateHash?: string;
}

export interface CreatedEvmCalendarSpreadOrder {
  readonly profileId: string;
  readonly order: StrategyPackageOrder;
  readonly graph: PackageGraph;
  readonly intake: StrategyOrderIntakeResult;
}

export interface EvmCalendarSpreadOrderPort {
  profiles(): readonly EvmCalendarSpreadProfile[];
  create(request: unknown): CreatedEvmCalendarSpreadOrder;
}

function fail(code: string, message: string): never {
  throw new EvmCalendarSpreadOrderError(code, message);
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

function positive(value: unknown, context: string): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > U256_MAX) {
    fail("INVALID_CONFIGURATION", `${context} must be a positive u256.`);
  }
  return value;
}

function natural(value: unknown, context: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U256_MAX) {
    fail("INVALID_CONFIGURATION", `${context} must be a nonnegative u256.`);
  }
  return value;
}

function version(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 0xffff_ffff) {
    fail("INVALID_CONFIGURATION", `${context} must be a positive u32.`);
  }
  return Number(value);
}

function manifestRef(value: unknown, context: string): VersionedManifestRef {
  const input = record(value, context);
  exactKeys(input, ["subjectId", "manifestVersion", "manifestHash"], context);
  return versionedManifestRef(
    input.subjectId as string,
    input.manifestVersion as number,
    input.manifestHash as Uint8Array,
    context,
  );
}

function checkedMarket(value: unknown, context: string): EvmCalendarSpreadMarketProfile {
  const input = record(value, context);
  exactKeys(input, ["role", "adapter", "venue", "market", "maturity"], context);
  if (input.role !== "near-future" && input.role !== "far-future") {
    fail("INVALID_CONFIGURATION", `${context}.role is invalid.`);
  }
  return Object.freeze({
    role: input.role,
    adapter: adapterRef(input.adapter as never, `${context}.adapter`),
    venue: manifestRef(input.venue, `${context}.venue`),
    market: manifestRef(input.market, `${context}.market`),
    maturity: positive(input.maturity, `${context}.maturity`),
  });
}

function checkedProfile(value: unknown, index: number): EvmCalendarSpreadProfile {
  const context = `EVM calendar spread profile ${index}`;
  const input = record(value, context);
  exactKeys(input, [
    "profileId", "displayName", "templateId", "templateVersion", "packageTemplateManifestHash",
    "seriesId", "seriesVersion", "seriesManifestHash", "executionClassId", "executionClassVersion",
    "executionClassManifestHash", "chainId", "domain", "accountFactory", "baseAsset", "quoteAsset",
    "markets", "metricLimits", "bounds",
  ], context);
  if (typeof input.profileId !== "string" || typeof input.displayName !== "string"
    || typeof input.seriesId !== "string" || typeof input.executionClassId !== "string"
    || typeof input.accountFactory !== "string" || !ADDRESS.test(input.accountFactory)
    || input.templateId !== STRATEGY_TEMPLATE_ID.CALENDAR_SPREAD || input.templateVersion !== 1) {
    fail("INVALID_CONFIGURATION", `${context} identity or template is invalid.`);
  }
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 80 || !Number.isSafeInteger(input.chainId)
    || !TEST_CHAIN_IDS.has(Number(input.chainId))) {
    fail("INVALID_CONFIGURATION", `${context} display name or chain is invalid.`);
  }
  const chainId = Number(input.chainId);
  const domainValue = input.domain as DomainRef;
  const domain = domainRef(domainValue.domainId, domainValue.domainManifestVersion, domainValue.domainManifestHash);
  if (domain.domainId !== `eip155:${chainId}`) fail("INVALID_CONFIGURATION", `${context} domain and chain differ.`);
  const baseValue = input.baseAsset as AssetRef;
  const quoteValue = input.quoteAsset as AssetRef;
  const baseAsset = assetRef(baseValue.assetId, baseValue.assetManifestHash, baseValue.decimals);
  const quoteAsset = assetRef(quoteValue.assetId, quoteValue.assetManifestHash, quoteValue.decimals);
  if (baseAsset.assetId === quoteAsset.assetId || baseAsset.decimals !== 18 || quoteAsset.decimals > 18) {
    fail("INVALID_CONFIGURATION", `${context} assets are invalid.`);
  }
  if (!Array.isArray(input.markets) || input.markets.length !== 2) {
    fail("INVALID_CONFIGURATION", `${context}.markets must contain near and far futures.`);
  }
  const markets = input.markets.map((market, marketIndex) => checkedMarket(market, `${context}.markets[${marketIndex}]`));
  const near = markets.find((market) => market.role === "near-future");
  const far = markets.find((market) => market.role === "far-future");
  if (near === undefined || far === undefined || near.maturity >= far.maturity) {
    fail("INVALID_CONFIGURATION", `${context}.markets must define ordered near and far maturities.`);
  }
  const boundsValue = record(input.bounds, `${context}.bounds`);
  exactKeys(boundsValue, [
    "minimumQuantityAtoms", "maximumQuantityAtoms", "maximumServiceFeeQuoteAtoms",
    "maximumVenueFeeQuoteAtoms", "maximumNetworkFeeQuoteAtoms", "maximumMarginIncreaseQuoteAtoms",
    "maximumExpiryTtlSeconds",
  ], `${context}.bounds`);
  const bounds = Object.freeze({
    minimumQuantityAtoms: positive(boundsValue.minimumQuantityAtoms, `${context}.bounds.minimumQuantityAtoms`),
    maximumQuantityAtoms: positive(boundsValue.maximumQuantityAtoms, `${context}.bounds.maximumQuantityAtoms`),
    maximumServiceFeeQuoteAtoms: natural(boundsValue.maximumServiceFeeQuoteAtoms, `${context}.bounds.maximumServiceFeeQuoteAtoms`),
    maximumVenueFeeQuoteAtoms: natural(boundsValue.maximumVenueFeeQuoteAtoms, `${context}.bounds.maximumVenueFeeQuoteAtoms`),
    maximumNetworkFeeQuoteAtoms: natural(boundsValue.maximumNetworkFeeQuoteAtoms, `${context}.bounds.maximumNetworkFeeQuoteAtoms`),
    maximumMarginIncreaseQuoteAtoms: positive(boundsValue.maximumMarginIncreaseQuoteAtoms, `${context}.bounds.maximumMarginIncreaseQuoteAtoms`),
    maximumExpiryTtlSeconds: positive(boundsValue.maximumExpiryTtlSeconds, `${context}.bounds.maximumExpiryTtlSeconds`),
  });
  if (bounds.minimumQuantityAtoms > bounds.maximumQuantityAtoms || bounds.maximumExpiryTtlSeconds < 30n
    || bounds.maximumExpiryTtlSeconds > 86_400n || !Array.isArray(input.metricLimits)) {
    fail("INVALID_CONFIGURATION", `${context} bounds or metric limits are invalid.`);
  }
  const profile = Object.freeze({
    profileId: protocolId(input.profileId, `${context}.profileId`),
    displayName,
    templateId: STRATEGY_TEMPLATE_ID.CALENDAR_SPREAD,
    templateVersion: 1 as const,
    packageTemplateManifestHash: manifestHash(input.packageTemplateManifestHash as Uint8Array),
    seriesId: protocolId(input.seriesId, `${context}.seriesId`),
    seriesVersion: version(input.seriesVersion, `${context}.seriesVersion`),
    seriesManifestHash: manifestHash(input.seriesManifestHash as Uint8Array),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    executionClassVersion: version(input.executionClassVersion, `${context}.executionClassVersion`),
    executionClassManifestHash: manifestHash(input.executionClassManifestHash as Uint8Array),
    chainId,
    domain,
    accountFactory: input.accountFactory,
    baseAsset,
    quoteAsset,
    markets: Object.freeze([near, far] as const),
    metricLimits: Object.freeze(input.metricLimits as StrategyMetricLimitInput[]),
    bounds,
  });
  const definition = requireStrategyTemplateDefinition(profile.templateId);
  try {
    strategyPackageOrder({
      version: 1,
      environment: "testnet",
      templateId: profile.templateId,
      templateVersion: 1,
      packageTemplateManifestHash: profile.packageTemplateManifestHash,
      graphHash: "01".repeat(32),
      seriesId: profile.seriesId,
      seriesVersion: profile.seriesVersion,
      seriesManifestHash: profile.seriesManifestHash,
      executionClassId: profile.executionClassId,
      executionClassVersion: profile.executionClassVersion,
      executionClassManifestHash: profile.executionClassManifestHash,
      quoteConventionId: definition.quoteConventionId,
      riskClassId: definition.riskClassId,
      owner: "0x1111111111111111111111111111111111111111",
      settlementAccount: "0x2222222222222222222222222222222222222222",
      lifecycleAction: "ENTRY",
      settlementClass: "ATOMIC_POSTCONDITION",
      packageOrderType: "MARKETABLE_LIMIT",
      packageTimeInForce: "IOC",
      economicQuantity: assetAmount(profile.baseAsset, bounds.minimumQuantityAtoms),
      quoteAsset: profile.quoteAsset,
      metricLimits: profile.metricLimits,
      maximumServiceFeesByAsset: [],
      maximumVenueFeesByAsset: [],
      maximumNetworkFeesByAsset: [],
      maximumRecoveryCostByAsset: [],
      maximumMarginIncrease: assetAmount(profile.quoteAsset, bounds.maximumMarginIncreaseQuoteAtoms),
      maximumResidualValue: assetAmount(profile.quoteAsset, 0n),
      expiryUnit: "EVM_UNIX_SECONDS",
      expiryValue: 2n,
      nonce: 1n,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown validation error";
    fail("INVALID_CONFIGURATION", `${context} cannot produce a valid order: ${reason}`);
  }
  return profile;
}

export function loadEvmCalendarSpreadProfiles(path: string): readonly EvmCalendarSpreadProfile[] {
  if (!isAbsolute(path)) fail("INVALID_CONFIGURATION", "EVM calendar spread profile path must be absolute.");
  const resolved = resolve(path);
  if (statSync(resolved).size > MAX_CONFIG_BYTES) fail("INVALID_CONFIGURATION", "EVM calendar spread profile file is too large.");
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(readFileSync(resolved, "utf8"), "evmCalendarSpreadProfiles");
  } catch {
    fail("INVALID_CONFIGURATION", "EVM calendar spread profile file is not valid protocol JSON.");
  }
  const root = record(parsed, "EVM calendar spread profile file");
  exactKeys(root, ["version", "environment", "profiles"], "EVM calendar spread profile file");
  if (root.version !== 1 || root.environment !== "testnet" || !Array.isArray(root.profiles)
    || root.profiles.length === 0 || root.profiles.length > 16) {
    fail("INVALID_CONFIGURATION", "EVM calendar spread profile file must contain one to sixteen Testnet profiles.");
  }
  const profiles = root.profiles.map(checkedProfile);
  if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length) {
    fail("INVALID_CONFIGURATION", "EVM calendar spread profile IDs must be unique.");
  }
  return Object.freeze(profiles);
}

function requestAtoms(value: string, context: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    fail("INVALID_REQUEST", `${context} must be positive decimal atoms.`);
  }
  const atoms = BigInt(value);
  if (atoms > U256_MAX) fail("INVALID_REQUEST", `${context} is out of range.`);
  return atoms;
}

function policyHash(profile: EvmCalendarSpreadProfile, request: EvmCalendarSpreadOrderRequest, name: string): string {
  return createHash("sha256").update([
    "NARYX/evm-calendar-spread-policy/v1",
    profile.profileId,
    request.owner,
    request.settlementAccount,
    request.lifecycleAction,
    request.nonce,
    request.expectedStrategyStateHash ?? "",
    name,
  ].join("\0"), "utf8").digest("hex");
}

function increasing(action: SupportedAction): boolean {
  return action === "ENTRY" || action === "INCREASE";
}

export function createEvmCalendarSpreadOrderPort(input: Readonly<{
  profiles: readonly EvmCalendarSpreadProfile[];
  intake: StrategyOrderIntakePort;
  currentTimeSeconds?: () => number;
}>): EvmCalendarSpreadOrderPort {
  if (input.profiles.length === 0) fail("INVALID_CONFIGURATION", "At least one EVM calendar spread profile is required.");
  const profiles = new Map(input.profiles.map((profile) => [profile.profileId, profile]));
  if (profiles.size !== input.profiles.length) fail("INVALID_CONFIGURATION", "EVM calendar spread profile IDs repeat.");
  const currentTimeSeconds = input.currentTimeSeconds ?? (() => Math.floor(Date.now() / 1_000));
  return Object.freeze({
    profiles: () => Object.freeze([...profiles.values()]),
    create(requestValue: unknown): CreatedEvmCalendarSpreadOrder {
      if (typeof requestValue !== "object" || requestValue === null || Array.isArray(requestValue)) {
        fail("INVALID_REQUEST", "EVM calendar spread order request must be an object.");
      }
      const fields = requestValue as Record<string, unknown>;
      const allowed = new Set([
        "profileId", "owner", "settlementAccount", "lifecycleAction", "quantityAtoms", "limitPrices",
        "expiryValue", "nonce", "expectedStrategyStateHash",
      ]);
      const required = [...allowed].filter((name) => name !== "expectedStrategyStateHash");
      if (Object.keys(fields).some((name) => !allowed.has(name)) || required.some((name) => !(name in fields))
        || typeof fields.profileId !== "string" || typeof fields.owner !== "string"
        || typeof fields.settlementAccount !== "string" || typeof fields.quantityAtoms !== "string"
        || typeof fields.expiryValue !== "string" || typeof fields.nonce !== "string"
        || !Array.isArray(fields.limitPrices)
        || (fields.lifecycleAction !== "ENTRY" && fields.lifecycleAction !== "INCREASE"
          && fields.lifecycleAction !== "DECREASE" && fields.lifecycleAction !== "EXIT"
          && fields.lifecycleAction !== "EMERGENCY_UNWIND")
        || (fields.expectedStrategyStateHash !== undefined && typeof fields.expectedStrategyStateHash !== "string")) {
        fail("INVALID_REQUEST", "EVM calendar spread order request fields are invalid.");
      }
      const request = fields as unknown as EvmCalendarSpreadOrderRequest;
      const profile = profiles.get(request.profileId);
      if (profile === undefined) fail("PROFILE_NOT_FOUND", "EVM calendar spread profile was not found.");
      if (!ADDRESS.test(request.owner) || !ADDRESS.test(request.settlementAccount)) {
        fail("INVALID_REQUEST", "Owner and settlement account must be lowercase nonzero EVM addresses.");
      }
      if (request.lifecycleAction === "ENTRY" && request.expectedStrategyStateHash !== undefined) {
        fail("INVALID_REQUEST", "Entry cannot bind an existing strategy state.");
      }
      if (request.lifecycleAction !== "ENTRY"
        && (request.expectedStrategyStateHash === undefined || !/^[0-9a-f]{64}$/.test(request.expectedStrategyStateHash))) {
        fail("INVALID_REQUEST", "A lifecycle transition requires the exact expected strategy state hash.");
      }
      const quantity = requestAtoms(request.quantityAtoms, "quantityAtoms");
      const expiryValue = requestAtoms(request.expiryValue, "expiryValue");
      const nonce = requestAtoms(request.nonce, "nonce");
      const now = currentTimeSeconds();
      if (!Number.isSafeInteger(now) || now <= 0) fail("INVALID_CONFIGURATION", "EVM calendar spread clock is invalid.");
      if (quantity < profile.bounds.minimumQuantityAtoms || quantity > profile.bounds.maximumQuantityAtoms
        || expiryValue <= BigInt(now) + 15n || expiryValue > BigInt(now) + profile.bounds.maximumExpiryTtlSeconds
        || expiryValue >= profile.markets[0].maturity) {
        fail("LIMIT_EXCEEDED", "EVM calendar spread quantity or expiry is outside the reviewed profile bounds.");
      }
      if (request.limitPrices.length !== 2 || request.limitPrices.some((limit) =>
        typeof limit !== "object" || limit === null || Array.isArray(limit)
        || Object.keys(limit).sort().join(",") !== "baseAtoms,legId,quoteAtoms"
        || (limit.legId !== "near-future" && limit.legId !== "far-future")
        || typeof limit.quoteAtoms !== "string" || typeof limit.baseAtoms !== "string")) {
        fail("INVALID_REQUEST", "Both future legs require exact limit price fields.");
      }
      const limits = new Map(request.limitPrices.map((limit) => [limit.legId, limit]));
      if (limits.size !== 2) fail("INVALID_REQUEST", "Calendar spread price limits repeat a leg.");
      const opening = increasing(request.lifecycleAction);
      const legs = profile.markets.map((market) => {
        const side = opening
          ? market.role === "near-future" ? "BUY" as const : "SELL" as const
          : market.role === "near-future" ? "SELL" as const : "BUY" as const;
        const limit = limits.get(market.role)!;
        return Object.freeze({
          legId: market.role,
          legFamily: opening ? "FUTURE_OPEN" as const : "FUTURE_CLOSE" as const,
          legTypeId: market.role,
          domain: profile.domain,
          adapter: market.adapter,
          venue: market.venue,
          market: market.market,
          assets: Object.freeze([profile.baseAsset, profile.quoteAsset]),
          side,
          quantityAsset: profile.baseAsset,
          quantityAtoms: quantity,
          minimumQuantityAtoms: quantity,
          limitPrice: exactPrice({
            baseAsset: profile.baseAsset,
            quoteAsset: profile.quoteAsset,
            quoteAtoms: requestAtoms(limit.quoteAtoms, `${market.role}.quoteAtoms`),
            baseAtoms: requestAtoms(limit.baseAtoms, `${market.role}.baseAtoms`),
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
        strategyAccountRefs: [request.settlementAccount],
        legs,
        dependencyEdges: [],
        executionGroups: [{ groupId: "evm-calendar-spread", kind: "ALL_OR_NONE", legIds: legs.map((leg) => leg.legId) }],
        settlementClass: "ATOMIC_POSTCONDITION",
        policyHashes: {
          netting: policyHash(profile, request, "netting"),
          privacy: policyHash(profile, request, "privacy"),
          solver: policyHash(profile, request, "solver"),
          delivery: policyHash(profile, request, "delivery"),
          resource: policyHash(profile, request, "resource"),
          portfolioRiskLimits: policyHash(profile, request, "portfolio-risk-limits"),
        },
        recoverySlots: [],
        maximumRecoveryCostQuoteAtoms: 0n,
        expiryUnit: "EVM_UNIX_SECONDS",
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
        settlementAccount: request.settlementAccount,
        lifecycleAction: request.lifecycleAction,
        settlementClass: "ATOMIC_POSTCONDITION",
        packageOrderType: "MARKETABLE_LIMIT",
        packageTimeInForce: "IOC",
        economicQuantity: assetAmount(profile.baseAsset, quantity),
        quoteAsset: profile.quoteAsset,
        metricLimits: profile.metricLimits,
        maximumServiceFeesByAsset: cap(profile.bounds.maximumServiceFeeQuoteAtoms),
        maximumVenueFeesByAsset: cap(profile.bounds.maximumVenueFeeQuoteAtoms),
        maximumNetworkFeesByAsset: cap(profile.bounds.maximumNetworkFeeQuoteAtoms),
        maximumRecoveryCostByAsset: [],
        maximumMarginIncrease: assetAmount(profile.quoteAsset, opening ? profile.bounds.maximumMarginIncreaseQuoteAtoms : 0n),
        maximumResidualValue: assetAmount(profile.quoteAsset, 0n),
        ...(request.expectedStrategyStateHash === undefined ? {} : { expectedStrategyStateHash: request.expectedStrategyStateHash }),
        expiryUnit: "EVM_UNIX_SECONDS",
        expiryValue,
        nonce,
      });
      const intake = input.intake.store(order, graph);
      if (intake.orderHashHex !== toHex(strategyPackageOrderHash(order))
        || intake.graphHashHex !== toHex(packageGraphHash(graph))) {
        fail("INTAKE_MISMATCH", "EVM calendar spread intake returned an invalid identity.");
      }
      return Object.freeze({ profileId: profile.profileId, order, graph, intake });
    },
  });
}
