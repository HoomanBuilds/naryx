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

type SupportedAction = "ENTRY" | "INCREASE" | "DECREASE" | "EXIT" | "EMERGENCY_UNWIND";
type LegRole = "collateral-swap" | "collateral-transfer" | "conversion-hedge";

export class EvmCollateralConversionOrderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EvmCollateralConversionOrderError";
    this.code = code;
  }
}

export interface EvmCollateralConversionLegProfile {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
}

export interface EvmCollateralConversionBounds {
  readonly minimumQuantityAtoms: bigint;
  readonly maximumQuantityAtoms: bigint;
  readonly maximumServiceFeeQuoteAtoms: bigint;
  readonly maximumVenueFeeQuoteAtoms: bigint;
  readonly maximumNetworkFeeQuoteAtoms: bigint;
  readonly maximumMarginIncreaseQuoteAtoms: bigint;
  readonly maximumExpiryTtlSeconds: bigint;
}

export interface EvmCollateralConversionProfile {
  readonly profileId: string;
  readonly displayName: string;
  readonly templateId: typeof STRATEGY_TEMPLATE_ID.COLLATERAL_CONVERSION_HEDGE;
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
  readonly collateralAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly swap: EvmCollateralConversionLegProfile;
  readonly collateralTransfer: EvmCollateralConversionLegProfile;
  readonly hedge: EvmCollateralConversionLegProfile;
  readonly metricLimits: readonly StrategyMetricLimitInput[];
  readonly bounds: EvmCollateralConversionBounds;
}

export interface EvmCollateralConversionOrderRequest {
  readonly profileId: string;
  readonly owner: string;
  readonly settlementAccount: string;
  readonly lifecycleAction: SupportedAction;
  readonly quantityAtoms: string;
  readonly limitSwapPrice: Readonly<{ quoteAtoms: string; baseAtoms: string }>;
  readonly limitHedgePrice: Readonly<{ quoteAtoms: string; baseAtoms: string }>;
  readonly expiryValue: string;
  readonly nonce: string;
  readonly expectedStrategyStateHash?: string;
}

export interface CreatedEvmCollateralConversionOrder {
  readonly profileId: string;
  readonly order: StrategyPackageOrder;
  readonly graph: PackageGraph;
  readonly intake: StrategyOrderIntakeResult;
}

export interface EvmCollateralConversionOrderPort {
  profiles(): readonly EvmCollateralConversionProfile[];
  create(request: unknown): CreatedEvmCollateralConversionOrder;
}

function fail(code: string, message: string): never {
  throw new EvmCollateralConversionOrderError(code, message);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("INVALID_CONFIGURATION", `${context} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("INVALID_CONFIGURATION", `${context} fields are invalid.`);
  }
}

function natural(value: unknown, context: string, positive = false): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U256_MAX || (positive && value === 0n)) {
    fail("INVALID_CONFIGURATION", `${context} is outside its allowed u256 range.`);
  }
  return value;
}

function version(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 0xffff_ffff) {
    fail("INVALID_CONFIGURATION", `${context} must be a positive u32.`);
  }
  return Number(value);
}

function legProfile(value: unknown, context: string): EvmCollateralConversionLegProfile {
  const input = record(value, context);
  exactKeys(input, ["adapter", "venue", "market"], context);
  const venue = input.venue as VersionedManifestRef;
  const market = input.market as VersionedManifestRef;
  return Object.freeze({
    adapter: adapterRef(input.adapter as never, `${context}.adapter`),
    venue: versionedManifestRef(venue.subjectId, venue.manifestVersion, venue.manifestHash, `${context}.venue`),
    market: versionedManifestRef(market.subjectId, market.manifestVersion, market.manifestHash, `${context}.market`),
  });
}

function checkedProfile(value: unknown, index: number): EvmCollateralConversionProfile {
  const context = `EVM collateral conversion profile ${index}`;
  const input = record(value, context);
  exactKeys(input, [
    "profileId", "displayName", "templateId", "templateVersion", "packageTemplateManifestHash",
    "seriesId", "seriesVersion", "seriesManifestHash", "executionClassId", "executionClassVersion",
    "executionClassManifestHash", "chainId", "domain", "accountFactory", "collateralAsset", "quoteAsset",
    "swap", "collateralTransfer", "hedge", "metricLimits", "bounds",
  ], context);
  if (typeof input.profileId !== "string" || typeof input.displayName !== "string"
    || typeof input.seriesId !== "string" || typeof input.executionClassId !== "string"
    || typeof input.accountFactory !== "string" || !ADDRESS.test(input.accountFactory)
    || input.templateId !== STRATEGY_TEMPLATE_ID.COLLATERAL_CONVERSION_HEDGE || input.templateVersion !== 1
    || !Number.isSafeInteger(input.chainId) || !TEST_CHAIN_IDS.has(Number(input.chainId))) {
    fail("INVALID_CONFIGURATION", `${context} identity, template, or chain is invalid.`);
  }
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 80 || !Array.isArray(input.metricLimits)) {
    fail("INVALID_CONFIGURATION", `${context} display name or metrics are invalid.`);
  }
  const chainId = Number(input.chainId);
  const domainValue = input.domain as DomainRef;
  const domain = domainRef(domainValue.domainId, domainValue.domainManifestVersion, domainValue.domainManifestHash);
  if (domain.domainId !== `eip155:${chainId}`) fail("INVALID_CONFIGURATION", `${context} domain and chain differ.`);
  const collateralValue = input.collateralAsset as AssetRef;
  const quoteValue = input.quoteAsset as AssetRef;
  const collateralAsset = assetRef(collateralValue.assetId, collateralValue.assetManifestHash, collateralValue.decimals);
  const quoteAsset = assetRef(quoteValue.assetId, quoteValue.assetManifestHash, quoteValue.decimals);
  if (collateralAsset.assetId === quoteAsset.assetId || collateralAsset.decimals > 18 || quoteAsset.decimals > 18) {
    fail("INVALID_CONFIGURATION", `${context} assets are invalid.`);
  }
  const boundsValue = record(input.bounds, `${context}.bounds`);
  exactKeys(boundsValue, [
    "minimumQuantityAtoms", "maximumQuantityAtoms", "maximumServiceFeeQuoteAtoms",
    "maximumVenueFeeQuoteAtoms", "maximumNetworkFeeQuoteAtoms", "maximumMarginIncreaseQuoteAtoms",
    "maximumExpiryTtlSeconds",
  ], `${context}.bounds`);
  const bounds = Object.freeze({
    minimumQuantityAtoms: natural(boundsValue.minimumQuantityAtoms, `${context}.bounds.minimumQuantityAtoms`, true),
    maximumQuantityAtoms: natural(boundsValue.maximumQuantityAtoms, `${context}.bounds.maximumQuantityAtoms`, true),
    maximumServiceFeeQuoteAtoms: natural(boundsValue.maximumServiceFeeQuoteAtoms, `${context}.bounds.maximumServiceFeeQuoteAtoms`),
    maximumVenueFeeQuoteAtoms: natural(boundsValue.maximumVenueFeeQuoteAtoms, `${context}.bounds.maximumVenueFeeQuoteAtoms`),
    maximumNetworkFeeQuoteAtoms: natural(boundsValue.maximumNetworkFeeQuoteAtoms, `${context}.bounds.maximumNetworkFeeQuoteAtoms`),
    maximumMarginIncreaseQuoteAtoms: natural(boundsValue.maximumMarginIncreaseQuoteAtoms, `${context}.bounds.maximumMarginIncreaseQuoteAtoms`, true),
    maximumExpiryTtlSeconds: natural(boundsValue.maximumExpiryTtlSeconds, `${context}.bounds.maximumExpiryTtlSeconds`, true),
  });
  if (bounds.minimumQuantityAtoms > bounds.maximumQuantityAtoms || bounds.maximumExpiryTtlSeconds < 30n
    || bounds.maximumExpiryTtlSeconds > 86_400n) fail("INVALID_CONFIGURATION", `${context} bounds are invalid.`);
  const profile = Object.freeze({
    profileId: protocolId(input.profileId, `${context}.profileId`),
    displayName,
    templateId: STRATEGY_TEMPLATE_ID.COLLATERAL_CONVERSION_HEDGE,
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
    collateralAsset,
    quoteAsset,
    swap: legProfile(input.swap, `${context}.swap`),
    collateralTransfer: legProfile(input.collateralTransfer, `${context}.collateralTransfer`),
    hedge: legProfile(input.hedge, `${context}.hedge`),
    metricLimits: Object.freeze(input.metricLimits as StrategyMetricLimitInput[]),
    bounds,
  });
  requireStrategyTemplateDefinition(profile.templateId);
  return profile;
}

export function loadEvmCollateralConversionProfiles(path: string): readonly EvmCollateralConversionProfile[] {
  if (!isAbsolute(path)) fail("INVALID_CONFIGURATION", "EVM collateral conversion profile path must be absolute.");
  const resolved = resolve(path);
  if (statSync(resolved).size > MAX_CONFIG_BYTES) fail("INVALID_CONFIGURATION", "EVM collateral conversion profile file is too large.");
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(readFileSync(resolved, "utf8"), "evmCollateralConversionProfiles");
  } catch {
    fail("INVALID_CONFIGURATION", "EVM collateral conversion profile file is not valid protocol JSON.");
  }
  const root = record(parsed, "EVM collateral conversion profile file");
  exactKeys(root, ["version", "environment", "profiles"], "EVM collateral conversion profile file");
  if (root.version !== 1 || root.environment !== "testnet" || !Array.isArray(root.profiles)
    || root.profiles.length === 0 || root.profiles.length > 16) {
    fail("INVALID_CONFIGURATION", "EVM collateral conversion profile file must contain one to sixteen Testnet profiles.");
  }
  const profiles = root.profiles.map(checkedProfile);
  if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length) {
    fail("INVALID_CONFIGURATION", "EVM collateral conversion profile IDs must be unique.");
  }
  return Object.freeze(profiles);
}

function requestAtoms(value: string, context: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) fail("INVALID_REQUEST", `${context} must be positive decimal atoms.`);
  const atoms = BigInt(value);
  if (atoms > U256_MAX) fail("INVALID_REQUEST", `${context} is out of range.`);
  return atoms;
}

function reducedPrice(value: unknown, baseAsset: AssetRef, quoteAsset: AssetRef, side: "BUY" | "SELL", context: string) {
  const input = record(value, context);
  exactKeys(input, ["quoteAtoms", "baseAtoms"], context);
  if (typeof input.quoteAtoms !== "string" || typeof input.baseAtoms !== "string") {
    fail("INVALID_REQUEST", `${context} fields must be decimal atoms.`);
  }
  const quoteAtoms = requestAtoms(input.quoteAtoms, `${context}.quoteAtoms`);
  const baseAtoms = requestAtoms(input.baseAtoms, `${context}.baseAtoms`);
  let a = quoteAtoms;
  let b = baseAtoms;
  while (b !== 0n) [a, b] = [b, a % b];
  return exactPrice({
    baseAsset,
    quoteAsset,
    quoteAtoms: quoteAtoms / a,
    baseAtoms: baseAtoms / a,
    roundingDirection: side === "BUY" ? "FLOOR" : "CEIL",
  });
}

function policyHash(profileId: string, request: EvmCollateralConversionOrderRequest, name: string): string {
  return createHash("sha256").update([
    "NARYX/evm-collateral-conversion-policy/v1", profileId, request.owner, request.settlementAccount,
    request.lifecycleAction, request.nonce, request.expectedStrategyStateHash ?? "", name,
  ].join("\0"), "utf8").digest("hex");
}

export function createEvmCollateralConversionOrderPort(input: Readonly<{
  profiles: readonly EvmCollateralConversionProfile[];
  intake: StrategyOrderIntakePort;
  currentTimeSeconds?: () => number;
}>): EvmCollateralConversionOrderPort {
  if (input.profiles.length === 0) fail("INVALID_CONFIGURATION", "At least one EVM collateral conversion profile is required.");
  const profiles = new Map(input.profiles.map((profile) => [profile.profileId, profile]));
  if (profiles.size !== input.profiles.length) fail("INVALID_CONFIGURATION", "EVM collateral conversion profile IDs repeat.");
  const currentTimeSeconds = input.currentTimeSeconds ?? (() => Math.floor(Date.now() / 1_000));
  return Object.freeze({
    profiles: () => Object.freeze([...profiles.values()]),
    create(requestValue: unknown): CreatedEvmCollateralConversionOrder {
      if (typeof requestValue !== "object" || requestValue === null || Array.isArray(requestValue)) {
        fail("INVALID_REQUEST", "EVM collateral conversion order request must be an object.");
      }
      const fields = requestValue as Record<string, unknown>;
      const allowed = new Set([
        "profileId", "owner", "settlementAccount", "lifecycleAction", "quantityAtoms", "limitSwapPrice",
        "limitHedgePrice", "expiryValue", "nonce", "expectedStrategyStateHash",
      ]);
      const required = [...allowed].filter((name) => name !== "expectedStrategyStateHash");
      if (Object.keys(fields).some((name) => !allowed.has(name)) || required.some((name) => !(name in fields))
        || typeof fields.profileId !== "string" || typeof fields.owner !== "string"
        || typeof fields.settlementAccount !== "string" || typeof fields.quantityAtoms !== "string"
        || typeof fields.expiryValue !== "string" || typeof fields.nonce !== "string"
        || (fields.lifecycleAction !== "ENTRY" && fields.lifecycleAction !== "INCREASE"
          && fields.lifecycleAction !== "DECREASE" && fields.lifecycleAction !== "EXIT"
          && fields.lifecycleAction !== "EMERGENCY_UNWIND")
        || (fields.expectedStrategyStateHash !== undefined && typeof fields.expectedStrategyStateHash !== "string")) {
        fail("INVALID_REQUEST", "EVM collateral conversion order request fields are invalid.");
      }
      const request = fields as unknown as EvmCollateralConversionOrderRequest;
      const profile = profiles.get(request.profileId);
      if (profile === undefined) fail("PROFILE_NOT_FOUND", "EVM collateral conversion profile was not found.");
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
      if (!Number.isSafeInteger(now) || now <= 0) fail("INVALID_CONFIGURATION", "EVM collateral conversion clock is invalid.");
      if (quantity < profile.bounds.minimumQuantityAtoms || quantity > profile.bounds.maximumQuantityAtoms
        || expiryValue <= BigInt(now) + 15n || expiryValue > BigInt(now) + profile.bounds.maximumExpiryTtlSeconds) {
        fail("LIMIT_EXCEEDED", "EVM collateral conversion quantity or expiry is outside the reviewed profile bounds.");
      }
      const increasing = request.lifecycleAction === "ENTRY" || request.lifecycleAction === "INCREASE";
      const swapSide = increasing ? "BUY" as const : "SELL" as const;
      const hedgeSide = increasing ? "SELL" as const : "BUY" as const;
      const leg = (role: LegRole, legFamily: "SPOT_SWAP" | "MARGIN_DEPOSIT" | "MARGIN_RELEASE"
        | "PERP_OPEN" | "PERP_INCREASE" | "PERP_DECREASE" | "PERP_CLOSE") => {
        const binding = role === "collateral-swap" ? profile.swap
          : role === "collateral-transfer" ? profile.collateralTransfer : profile.hedge;
        const side = role === "collateral-swap" ? swapSide : role === "conversion-hedge" ? hedgeSide : "NONE" as const;
        const limitPrice = role === "collateral-swap"
          ? reducedPrice(request.limitSwapPrice, profile.collateralAsset, profile.quoteAsset, swapSide, "limitSwapPrice")
          : role === "conversion-hedge"
            ? reducedPrice(request.limitHedgePrice, profile.collateralAsset, profile.quoteAsset, hedgeSide, "limitHedgePrice")
            : undefined;
        return Object.freeze({
          legId: role,
          legFamily,
          legTypeId: role,
          domain: profile.domain,
          adapter: binding.adapter,
          venue: binding.venue,
          market: binding.market,
          assets: Object.freeze([profile.collateralAsset, profile.quoteAsset]),
          side,
          quantityAsset: profile.collateralAsset,
          quantityAtoms: quantity,
          minimumQuantityAtoms: quantity,
          ...(limitPrice === undefined ? {} : { limitPrice }),
          maximumFeeQuoteAtoms: role === "collateral-transfer" ? 0n : profile.bounds.maximumVenueFeeQuoteAtoms,
          preconditionHashes: Object.freeze([]),
          postconditionHashes: Object.freeze([]),
          timeInForce: "IOC" as const,
          legExpiryValue: expiryValue,
        });
      };
      const swapLeg = leg("collateral-swap", "SPOT_SWAP");
      const transferLeg = leg("collateral-transfer", increasing ? "MARGIN_DEPOSIT" : "MARGIN_RELEASE");
      const hedgeLeg = leg("conversion-hedge", request.lifecycleAction === "ENTRY" ? "PERP_OPEN"
        : request.lifecycleAction === "INCREASE" ? "PERP_INCREASE"
          : request.lifecycleAction === "DECREASE" ? "PERP_DECREASE" : "PERP_CLOSE");
      const legs = Object.freeze(increasing ? [swapLeg, transferLeg, hedgeLeg] : [hedgeLeg, transferLeg, swapLeg]);
      const graph = packageGraph({
        graphVersion: 1,
        environment: "testnet",
        templateId: profile.templateId,
        templateVersion: 1,
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
        dependencyEdges: increasing
          ? [{ fromLegId: "collateral-swap", toLegId: "collateral-transfer" }, { fromLegId: "collateral-transfer", toLegId: "conversion-hedge" }]
          : [{ fromLegId: "conversion-hedge", toLegId: "collateral-transfer" }, { fromLegId: "collateral-transfer", toLegId: "collateral-swap" }],
        executionGroups: [{ groupId: "evm-collateral-conversion", kind: "ALL_OR_NONE", legIds: legs.map((item) => item.legId) }],
        settlementClass: "ATOMIC_POSTCONDITION",
        policyHashes: {
          netting: policyHash(profile.profileId, request, "netting"),
          privacy: policyHash(profile.profileId, request, "privacy"),
          solver: policyHash(profile.profileId, request, "solver"),
          delivery: policyHash(profile.profileId, request, "delivery"),
          resource: policyHash(profile.profileId, request, "resource"),
          portfolioRiskLimits: policyHash(profile.profileId, request, "portfolio-risk-limits"),
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
        templateVersion: 1,
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
        economicQuantity: assetAmount(profile.collateralAsset, quantity),
        quoteAsset: profile.quoteAsset,
        metricLimits: profile.metricLimits,
        maximumServiceFeesByAsset: cap(profile.bounds.maximumServiceFeeQuoteAtoms),
        maximumVenueFeesByAsset: cap(profile.bounds.maximumVenueFeeQuoteAtoms),
        maximumNetworkFeesByAsset: cap(profile.bounds.maximumNetworkFeeQuoteAtoms),
        maximumRecoveryCostByAsset: [],
        maximumMarginIncrease: assetAmount(profile.quoteAsset, increasing ? profile.bounds.maximumMarginIncreaseQuoteAtoms : 0n),
        maximumResidualValue: assetAmount(profile.quoteAsset, 0n),
        ...(request.expectedStrategyStateHash === undefined ? {} : { expectedStrategyStateHash: request.expectedStrategyStateHash }),
        expiryUnit: "EVM_UNIX_SECONDS",
        expiryValue,
        nonce,
      });
      const intake = input.intake.store(order, graph);
      if (intake.orderHashHex !== toHex(strategyPackageOrderHash(order)) || intake.graphHashHex !== toHex(packageGraphHash(graph))) {
        fail("INTAKE_MISMATCH", "EVM collateral conversion intake returned an invalid identity.");
      }
      return Object.freeze({ profileId: profile.profileId, order, graph, intake });
    },
  });
}
