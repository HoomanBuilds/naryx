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
const ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const SUPPORTED_CHAIN_IDS = new Set([84_532, 421_614, 31_337, 31_338]);

type OptionRole = "option-long" | "option-short";
type SupportedAction = "ENTRY" | "INCREASE" | "DECREASE" | "EXIT" | "EMERGENCY_UNWIND";

export class EvmOptionSpreadOrderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EvmOptionSpreadOrderError";
    this.code = code;
  }
}

export interface EvmOptionSpreadMarketProfile {
  readonly role: OptionRole;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly strike: bigint;
  readonly maturity: bigint;
}

export interface EvmOptionSpreadBounds {
  readonly minimumQuantityAtoms: bigint;
  readonly maximumQuantityAtoms: bigint;
  readonly maximumServiceFeeQuoteAtoms: bigint;
  readonly maximumVenueFeeQuoteAtoms: bigint;
  readonly maximumNetworkFeeQuoteAtoms: bigint;
  readonly maximumMarginIncreaseQuoteAtoms: bigint;
  readonly maximumExpiryTtlSeconds: bigint;
}

export interface EvmOptionSpreadProfile {
  readonly profileId: string;
  readonly displayName: string;
  readonly templateId: typeof STRATEGY_TEMPLATE_ID.OPTION_SPREAD;
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
  readonly markets: readonly [EvmOptionSpreadMarketProfile, EvmOptionSpreadMarketProfile];
  readonly metricLimits: readonly StrategyMetricLimitInput[];
  readonly bounds: EvmOptionSpreadBounds;
}

export interface EvmOptionSpreadOrderRequest {
  readonly profileId: string;
  readonly owner: string;
  readonly settlementAccount: string;
  readonly lifecycleAction: SupportedAction;
  readonly quantityAtoms: string;
  readonly limitPremiums: readonly Readonly<{
    legId: OptionRole;
    quoteAtoms: string;
    baseAtoms: string;
  }>[];
  readonly expiryValue: string;
  readonly nonce: string;
  readonly expectedStrategyStateHash?: string;
}

export interface CreatedEvmOptionSpreadOrder {
  readonly profileId: string;
  readonly order: StrategyPackageOrder;
  readonly graph: PackageGraph;
  readonly intake: StrategyOrderIntakeResult;
}

export interface EvmOptionSpreadOrderPort {
  profiles(): readonly EvmOptionSpreadProfile[];
  create(request: unknown): CreatedEvmOptionSpreadOrder;
}

function fail(code: string, message: string): never {
  throw new EvmOptionSpreadOrderError(code, message);
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

function checkedProfile(value: unknown, index: number): EvmOptionSpreadProfile {
  const context = `EVM option spread profile ${index}`;
  const profile = record(value, context);
  exactKeys(profile, [
    "profileId", "displayName", "templateId", "templateVersion", "packageTemplateManifestHash",
    "seriesId", "seriesVersion", "seriesManifestHash", "executionClassId", "executionClassVersion",
    "executionClassManifestHash", "chainId", "domain", "accountFactory", "baseAsset", "quoteAsset",
    "markets", "metricLimits", "bounds",
  ], context);
  if (typeof profile.profileId !== "string" || typeof profile.displayName !== "string"
    || typeof profile.seriesId !== "string" || typeof profile.executionClassId !== "string"
    || typeof profile.accountFactory !== "string" || !ADDRESS.test(profile.accountFactory)) {
    fail("INVALID_CONFIGURATION", `${context} identities are invalid.`);
  }
  const profileId = protocolId(profile.profileId, `${context}.profileId`);
  const displayName = profile.displayName.trim();
  if (displayName.length === 0 || displayName.length > 80
    || profile.templateId !== STRATEGY_TEMPLATE_ID.OPTION_SPREAD || profile.templateVersion !== 1) {
    fail("INVALID_CONFIGURATION", `${context} display or template is invalid.`);
  }
  if (!Number.isSafeInteger(profile.chainId) || !SUPPORTED_CHAIN_IDS.has(profile.chainId as number)) {
    fail("INVALID_CONFIGURATION", `${context}.chainId must be a supported EVM test chain.`);
  }
  const chainId = profile.chainId as number;
  const rawDomain = profile.domain as DomainRef;
  const domain = domainRef(rawDomain.domainId, rawDomain.domainManifestVersion, rawDomain.domainManifestHash);
  if (domain.domainId !== `eip155:${chainId}`) {
    fail("INVALID_CONFIGURATION", `${context}.domain does not match chainId.`);
  }
  const baseValue = profile.baseAsset as AssetRef;
  const quoteValue = profile.quoteAsset as AssetRef;
  const baseAsset = assetRef(baseValue.assetId, baseValue.assetManifestHash, baseValue.decimals);
  const quoteAsset = assetRef(quoteValue.assetId, quoteValue.assetManifestHash, quoteValue.decimals);
  if (baseAsset.assetId === quoteAsset.assetId) fail("INVALID_CONFIGURATION", `${context} base and quote assets must differ.`);
  if (!Array.isArray(profile.markets) || profile.markets.length !== 2) {
    fail("INVALID_CONFIGURATION", `${context}.markets must contain the long and short calls.`);
  }
  const markets = profile.markets.map((candidate, marketIndex): EvmOptionSpreadMarketProfile => {
    const marketContext = `${context}.markets[${marketIndex}]`;
    const market = record(candidate, marketContext);
    exactKeys(market, ["role", "adapter", "venue", "market", "strike", "maturity"], marketContext);
    if (market.role !== "option-long" && market.role !== "option-short") {
      fail("INVALID_CONFIGURATION", `${marketContext}.role is invalid.`);
    }
    return Object.freeze({
      role: market.role,
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
      strike: positiveU256(market.strike, `${marketContext}.strike`),
      maturity: positiveU256(market.maturity, `${marketContext}.maturity`),
    });
  });
  const long = markets.find((market) => market.role === "option-long");
  const short = markets.find((market) => market.role === "option-short");
  if (long === undefined || short === undefined || long.maturity !== short.maturity || long.strike >= short.strike) {
    fail("INVALID_CONFIGURATION", `${context}.markets must define a common-maturity lower-strike long and upper-strike short.`);
  }
  const boundsValue = record(profile.bounds, `${context}.bounds`);
  exactKeys(boundsValue, [
    "minimumQuantityAtoms", "maximumQuantityAtoms", "maximumServiceFeeQuoteAtoms",
    "maximumVenueFeeQuoteAtoms", "maximumNetworkFeeQuoteAtoms", "maximumMarginIncreaseQuoteAtoms",
    "maximumExpiryTtlSeconds",
  ], `${context}.bounds`);
  const bounds = Object.freeze({
    minimumQuantityAtoms: positiveU256(boundsValue.minimumQuantityAtoms, `${context}.bounds.minimumQuantityAtoms`),
    maximumQuantityAtoms: positiveU256(boundsValue.maximumQuantityAtoms, `${context}.bounds.maximumQuantityAtoms`),
    maximumServiceFeeQuoteAtoms: nonnegativeU256(boundsValue.maximumServiceFeeQuoteAtoms, `${context}.bounds.maximumServiceFeeQuoteAtoms`),
    maximumVenueFeeQuoteAtoms: nonnegativeU256(boundsValue.maximumVenueFeeQuoteAtoms, `${context}.bounds.maximumVenueFeeQuoteAtoms`),
    maximumNetworkFeeQuoteAtoms: nonnegativeU256(boundsValue.maximumNetworkFeeQuoteAtoms, `${context}.bounds.maximumNetworkFeeQuoteAtoms`),
    maximumMarginIncreaseQuoteAtoms: positiveU256(boundsValue.maximumMarginIncreaseQuoteAtoms, `${context}.bounds.maximumMarginIncreaseQuoteAtoms`),
    maximumExpiryTtlSeconds: positiveU256(boundsValue.maximumExpiryTtlSeconds, `${context}.bounds.maximumExpiryTtlSeconds`),
  });
  if (bounds.minimumQuantityAtoms > bounds.maximumQuantityAtoms
    || bounds.maximumExpiryTtlSeconds < 30n || bounds.maximumExpiryTtlSeconds > 86_400n) {
    fail("INVALID_CONFIGURATION", `${context}.bounds are inconsistent.`);
  }
  if (!Array.isArray(profile.metricLimits)) fail("INVALID_CONFIGURATION", `${context}.metricLimits must be an array.`);
  const metricLimits = Object.freeze(profile.metricLimits as StrategyMetricLimitInput[]);
  const packageTemplateManifestHash = manifestHash(profile.packageTemplateManifestHash as Uint8Array);
  const seriesId = protocolId(profile.seriesId, `${context}.seriesId`);
  const seriesVersion = positiveVersion(profile.seriesVersion, `${context}.seriesVersion`);
  const seriesManifestHash = manifestHash(profile.seriesManifestHash as Uint8Array);
  const executionClassId = protocolId(profile.executionClassId, `${context}.executionClassId`);
  const executionClassVersion = positiveVersion(profile.executionClassVersion, `${context}.executionClassVersion`);
  const executionClassManifestHash = manifestHash(profile.executionClassManifestHash as Uint8Array);
  try {
    const definition = requireStrategyTemplateDefinition(STRATEGY_TEMPLATE_ID.OPTION_SPREAD);
    strategyPackageOrder({
      version: 1,
      environment: "testnet",
      templateId: STRATEGY_TEMPLATE_ID.OPTION_SPREAD,
      templateVersion: 1,
      packageTemplateManifestHash,
      graphHash: "01".repeat(32),
      seriesId,
      seriesVersion,
      seriesManifestHash,
      executionClassId,
      executionClassVersion,
      executionClassManifestHash,
      quoteConventionId: definition.quoteConventionId,
      riskClassId: definition.riskClassId,
      owner: "0x1111111111111111111111111111111111111111",
      settlementAccount: "0x2222222222222222222222222222222222222222",
      lifecycleAction: "ENTRY",
      settlementClass: "ATOMIC_POSTCONDITION",
      packageOrderType: "MARKETABLE_LIMIT",
      packageTimeInForce: "IOC",
      economicQuantity: assetAmount(baseAsset, bounds.minimumQuantityAtoms),
      quoteAsset,
      metricLimits,
      maximumServiceFeesByAsset: [],
      maximumVenueFeesByAsset: [],
      maximumNetworkFeesByAsset: [],
      maximumRecoveryCostByAsset: [],
      maximumMarginIncrease: assetAmount(quoteAsset, bounds.maximumMarginIncreaseQuoteAtoms),
      maximumResidualValue: assetAmount(quoteAsset, 0n),
      expiryUnit: "EVM_UNIX_SECONDS",
      expiryValue: 2n,
      nonce: 1n,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown validation error";
    fail("INVALID_CONFIGURATION", `${context}.metricLimits or identities are invalid: ${reason}`);
  }
  return Object.freeze({
    profileId,
    displayName,
    templateId: STRATEGY_TEMPLATE_ID.OPTION_SPREAD,
    templateVersion: 1,
    packageTemplateManifestHash,
    seriesId,
    seriesVersion,
    seriesManifestHash,
    executionClassId,
    executionClassVersion,
    executionClassManifestHash,
    chainId,
    domain,
    accountFactory: profile.accountFactory,
    baseAsset,
    quoteAsset,
    markets: Object.freeze([long, short] as const),
    metricLimits,
    bounds,
  });
}

export function loadEvmOptionSpreadProfiles(path: string): readonly EvmOptionSpreadProfile[] {
  if (!isAbsolute(path)) fail("INVALID_CONFIGURATION", "EVM option spread profile path must be absolute.");
  const resolved = resolve(path);
  if (statSync(resolved).size > MAX_CONFIG_BYTES) fail("INVALID_CONFIGURATION", "EVM option spread profile file is too large.");
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(readFileSync(resolved, "utf8"), "evmOptionSpreadProfiles");
  } catch {
    fail("INVALID_CONFIGURATION", "EVM option spread profile file is not valid protocol JSON.");
  }
  const root = record(parsed, "EVM option spread profile file");
  exactKeys(root, ["version", "environment", "profiles"], "EVM option spread profile file");
  if (root.version !== 1 || root.environment !== "testnet" || !Array.isArray(root.profiles)
    || root.profiles.length === 0 || root.profiles.length > 16) {
    fail("INVALID_CONFIGURATION", "EVM option spread profile file must contain one to sixteen Testnet profiles.");
  }
  const profiles = root.profiles.map(checkedProfile);
  if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length) {
    fail("INVALID_CONFIGURATION", "EVM option spread profile IDs must be unique.");
  }
  return Object.freeze(profiles);
}

function requestAtoms(value: string, name: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) fail("INVALID_REQUEST", `${name} must be positive decimal atoms.`);
  const atoms = BigInt(value);
  if (atoms > U256_MAX) fail("INVALID_REQUEST", `${name} is out of range.`);
  return atoms;
}

function policyHash(profile: EvmOptionSpreadProfile, request: EvmOptionSpreadOrderRequest, name: string): string {
  return createHash("sha256").update([
    "NARYX/evm-option-spread-policy/v1",
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

export function createEvmOptionSpreadOrderPort(input: Readonly<{
  profiles: readonly EvmOptionSpreadProfile[];
  intake: StrategyOrderIntakePort;
  currentTimeSeconds?: () => number;
}>): EvmOptionSpreadOrderPort {
  if (input.profiles.length === 0) fail("INVALID_CONFIGURATION", "At least one EVM option spread profile is required.");
  const profiles = new Map(input.profiles.map((profile) => [profile.profileId, profile]));
  if (profiles.size !== input.profiles.length) fail("INVALID_CONFIGURATION", "EVM option spread profile IDs repeat.");
  const currentTimeSeconds = input.currentTimeSeconds ?? (() => Math.floor(Date.now() / 1_000));
  return Object.freeze({
    profiles: () => Object.freeze([...profiles.values()]),
    create(requestValue: unknown): CreatedEvmOptionSpreadOrder {
      if (typeof requestValue !== "object" || requestValue === null || Array.isArray(requestValue)) {
        fail("INVALID_REQUEST", "EVM option spread order request must be an object.");
      }
      const fields = requestValue as Record<string, unknown>;
      const allowed = new Set([
        "profileId", "owner", "settlementAccount", "lifecycleAction", "quantityAtoms", "limitPremiums",
        "expiryValue", "nonce", "expectedStrategyStateHash",
      ]);
      const required = [...allowed].filter((name) => name !== "expectedStrategyStateHash");
      if (Object.keys(fields).some((name) => !allowed.has(name)) || required.some((name) => !(name in fields))
        || typeof fields.profileId !== "string" || typeof fields.owner !== "string"
        || typeof fields.settlementAccount !== "string" || typeof fields.quantityAtoms !== "string"
        || typeof fields.expiryValue !== "string" || typeof fields.nonce !== "string"
        || !Array.isArray(fields.limitPremiums)
        || (fields.expectedStrategyStateHash !== undefined && typeof fields.expectedStrategyStateHash !== "string")
        || (fields.lifecycleAction !== "ENTRY" && fields.lifecycleAction !== "INCREASE"
          && fields.lifecycleAction !== "DECREASE" && fields.lifecycleAction !== "EXIT"
          && fields.lifecycleAction !== "EMERGENCY_UNWIND")) {
        fail("INVALID_REQUEST", "EVM option spread order request fields are invalid.");
      }
      const request = fields as unknown as EvmOptionSpreadOrderRequest;
      const profile = profiles.get(request.profileId);
      if (profile === undefined) fail("PROFILE_NOT_FOUND", "EVM option spread profile was not found.");
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
      const quantityAtoms = requestAtoms(request.quantityAtoms, "quantityAtoms");
      const expiryValue = requestAtoms(request.expiryValue, "expiryValue");
      const nonce = requestAtoms(request.nonce, "nonce");
      const now = currentTimeSeconds();
      if (!Number.isSafeInteger(now) || now <= 0) fail("INVALID_CONFIGURATION", "EVM option spread clock is invalid.");
      if (quantityAtoms < profile.bounds.minimumQuantityAtoms || quantityAtoms > profile.bounds.maximumQuantityAtoms
        || expiryValue <= BigInt(now) + 15n || expiryValue > BigInt(now) + profile.bounds.maximumExpiryTtlSeconds
        || expiryValue >= profile.markets[0].maturity) {
        fail("LIMIT_EXCEEDED", "EVM option spread quantity or expiry is outside the reviewed profile bounds.");
      }
      if (request.limitPremiums.length !== 2 || request.limitPremiums.some((limit) =>
        typeof limit !== "object" || limit === null || Array.isArray(limit)
        || Object.keys(limit).sort().join(",") !== "baseAtoms,legId,quoteAtoms"
        || (limit.legId !== "option-long" && limit.legId !== "option-short")
        || typeof limit.quoteAtoms !== "string" || typeof limit.baseAtoms !== "string")) {
        fail("INVALID_REQUEST", "Both option legs require exact premium limit fields.");
      }
      const limits = new Map(request.limitPremiums.map((limit) => [limit.legId, limit]));
      if (limits.size !== 2) fail("INVALID_REQUEST", "Option premium limits repeat a leg.");
      const isIncreasing = increasing(request.lifecycleAction);
      const legs = profile.markets.map((market) => {
        const limit = limits.get(market.role)!;
        const side = isIncreasing
          ? market.role === "option-long" ? "BUY" as const : "SELL" as const
          : market.role === "option-long" ? "SELL" as const : "BUY" as const;
        const legFamily = isIncreasing
          ? market.role === "option-long" ? "OPTION_BUY" as const : "OPTION_MINT" as const
          : market.role === "option-long" ? "OPTION_SELL" as const : "OPTION_BUY" as const;
        return Object.freeze({
          legId: market.role,
          legFamily,
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
        executionGroups: [{ groupId: "evm-option-spread", kind: "ALL_OR_NONE", legIds: legs.map((leg) => leg.legId) }],
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
        economicQuantity: assetAmount(profile.baseAsset, quantityAtoms),
        quoteAsset: profile.quoteAsset,
        metricLimits: profile.metricLimits,
        maximumServiceFeesByAsset: cap(profile.bounds.maximumServiceFeeQuoteAtoms),
        maximumVenueFeesByAsset: cap(profile.bounds.maximumVenueFeeQuoteAtoms),
        maximumNetworkFeesByAsset: cap(profile.bounds.maximumNetworkFeeQuoteAtoms),
        maximumRecoveryCostByAsset: [],
        maximumMarginIncrease: assetAmount(profile.quoteAsset, isIncreasing ? profile.bounds.maximumMarginIncreaseQuoteAtoms : 0n),
        maximumResidualValue: assetAmount(profile.quoteAsset, 0n),
        ...(request.expectedStrategyStateHash === undefined ? {} : { expectedStrategyStateHash: request.expectedStrategyStateHash }),
        expiryUnit: "EVM_UNIX_SECONDS",
        expiryValue,
        nonce,
      });
      const intake = input.intake.store(order, graph);
      if (intake.orderHashHex !== toHex(strategyPackageOrderHash(order))
        || intake.graphHashHex !== toHex(packageGraphHash(graph))) {
        fail("INTAKE_MISMATCH", "EVM option spread intake returned an invalid identity.");
      }
      return Object.freeze({ profileId: profile.profileId, order, graph, intake });
    },
  });
}
