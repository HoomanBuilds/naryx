import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { deriveSolanaMultiStrategyAccount } from "@naryx/adapter-solana";
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
import { PublicKey } from "@solana/web3.js";
import type { StrategyOrderIntakePort, StrategyOrderIntakeResult } from "./strategy-order-intake.js";

const MAX_CONFIG_BYTES = 1_048_576;
const U256_MAX = (1n << 256n) - 1n;

type SupportedAction = "ENTRY" | "EXIT" | "EMERGENCY_UNWIND";

export class SolanaTreasuryHedgeOrderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SolanaTreasuryHedgeOrderError";
    this.code = code;
  }
}

export interface SolanaTreasuryHedgeLegProfile {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
}

export interface SolanaTreasuryHedgeBounds {
  readonly minimumQuantityAtoms: bigint;
  readonly maximumQuantityAtoms: bigint;
  readonly maximumServiceFeeQuoteAtoms: bigint;
  readonly maximumVenueFeeQuoteAtoms: bigint;
  readonly maximumNetworkFeeQuoteAtoms: bigint;
  readonly maximumMarginIncreaseQuoteAtoms: bigint;
  readonly maximumExpiryTtlSlots: bigint;
}

export interface SolanaTreasuryHedgeProfile {
  readonly profileId: string;
  readonly displayName: string;
  readonly templateId: typeof STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE;
  readonly templateVersion: 1;
  readonly packageTemplateManifestHash: Uint8Array;
  readonly seriesId: string;
  readonly seriesVersion: number;
  readonly seriesManifestHash: Uint8Array;
  readonly executionClassId: string;
  readonly executionClassVersion: number;
  readonly executionClassManifestHash: Uint8Array;
  readonly domain: DomainRef;
  readonly multiStrategyProgramId: string;
  readonly inventoryAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly inventory: SolanaTreasuryHedgeLegProfile;
  readonly hedge: SolanaTreasuryHedgeLegProfile;
  readonly metricLimits: readonly StrategyMetricLimitInput[];
  readonly bounds: SolanaTreasuryHedgeBounds;
}

export interface SolanaTreasuryHedgeOrderRequest {
  readonly profileId: string;
  readonly owner: string;
  readonly lifecycleAction: SupportedAction;
  readonly quantityAtoms: string;
  readonly limitHedgePrice: Readonly<{ quoteAtoms: string; baseAtoms: string }>;
  readonly expiryValue: string;
  readonly nonce: string;
  readonly expectedStrategyStateHash?: string;
}

export interface CreatedSolanaTreasuryHedgeOrder {
  readonly profileId: string;
  readonly settlementAccount: string;
  readonly order: StrategyPackageOrder;
  readonly graph: PackageGraph;
  readonly intake: StrategyOrderIntakeResult;
}

export interface SolanaTreasuryHedgeOrderPort {
  profiles(): readonly SolanaTreasuryHedgeProfile[];
  create(request: unknown): Promise<CreatedSolanaTreasuryHedgeOrder>;
}

function fail(code: string, message: string): never {
  throw new SolanaTreasuryHedgeOrderError(code, message);
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

function publicKey(value: unknown, context: string): string {
  if (typeof value !== "string") fail("INVALID_CONFIGURATION", `${context} must be a Solana public key.`);
  try {
    const checked = new PublicKey(value);
    if (checked.equals(PublicKey.default) || checked.toBase58() !== value) throw new Error("noncanonical");
    return value;
  } catch {
    fail("INVALID_CONFIGURATION", `${context} must be a canonical nonzero Solana public key.`);
  }
}

function legProfile(value: unknown, context: string): SolanaTreasuryHedgeLegProfile {
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

function checkedProfile(value: unknown, index: number): SolanaTreasuryHedgeProfile {
  const context = `Solana treasury hedge profile ${index}`;
  const input = record(value, context);
  exactKeys(input, [
    "profileId", "displayName", "templateId", "templateVersion", "packageTemplateManifestHash",
    "seriesId", "seriesVersion", "seriesManifestHash", "executionClassId", "executionClassVersion",
    "executionClassManifestHash", "domain", "multiStrategyProgramId", "inventoryAsset", "quoteAsset",
    "inventory", "hedge", "metricLimits", "bounds",
  ], context);
  if (typeof input.profileId !== "string" || typeof input.displayName !== "string"
    || typeof input.seriesId !== "string" || typeof input.executionClassId !== "string"
    || input.templateId !== STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE || input.templateVersion !== 1) {
    fail("INVALID_CONFIGURATION", `${context} identity or template is invalid.`);
  }
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 80) {
    fail("INVALID_CONFIGURATION", `${context} display name is invalid.`);
  }
  const domainValue = input.domain as DomainRef;
  const domain = domainRef(domainValue.domainId, domainValue.domainManifestVersion, domainValue.domainManifestHash);
  if (domain.domainId !== "svm:devnet") fail("INVALID_CONFIGURATION", `${context} domain must be Solana Devnet.`);
  const inventoryValue = input.inventoryAsset as AssetRef;
  const quoteValue = input.quoteAsset as AssetRef;
  const inventoryAsset = assetRef(inventoryValue.assetId, inventoryValue.assetManifestHash, inventoryValue.decimals);
  const quoteAsset = assetRef(quoteValue.assetId, quoteValue.assetManifestHash, quoteValue.decimals);
  if (inventoryAsset.assetId === quoteAsset.assetId) {
    fail("INVALID_CONFIGURATION", `${context} inventory and quote assets must differ.`);
  }
  const boundsValue = record(input.bounds, `${context}.bounds`);
  exactKeys(boundsValue, [
    "minimumQuantityAtoms", "maximumQuantityAtoms", "maximumServiceFeeQuoteAtoms",
    "maximumVenueFeeQuoteAtoms", "maximumNetworkFeeQuoteAtoms", "maximumMarginIncreaseQuoteAtoms",
    "maximumExpiryTtlSlots",
  ], `${context}.bounds`);
  const bounds = Object.freeze({
    minimumQuantityAtoms: positive(boundsValue.minimumQuantityAtoms, `${context}.bounds.minimumQuantityAtoms`),
    maximumQuantityAtoms: positive(boundsValue.maximumQuantityAtoms, `${context}.bounds.maximumQuantityAtoms`),
    maximumServiceFeeQuoteAtoms: natural(boundsValue.maximumServiceFeeQuoteAtoms, `${context}.bounds.maximumServiceFeeQuoteAtoms`),
    maximumVenueFeeQuoteAtoms: natural(boundsValue.maximumVenueFeeQuoteAtoms, `${context}.bounds.maximumVenueFeeQuoteAtoms`),
    maximumNetworkFeeQuoteAtoms: natural(boundsValue.maximumNetworkFeeQuoteAtoms, `${context}.bounds.maximumNetworkFeeQuoteAtoms`),
    maximumMarginIncreaseQuoteAtoms: natural(boundsValue.maximumMarginIncreaseQuoteAtoms, `${context}.bounds.maximumMarginIncreaseQuoteAtoms`),
    maximumExpiryTtlSlots: positive(boundsValue.maximumExpiryTtlSlots, `${context}.bounds.maximumExpiryTtlSlots`),
  });
  if (bounds.minimumQuantityAtoms > bounds.maximumQuantityAtoms || bounds.maximumExpiryTtlSlots < 10n
    || bounds.maximumExpiryTtlSlots > 100_000n || !Array.isArray(input.metricLimits)) {
    fail("INVALID_CONFIGURATION", `${context} bounds or metric limits are invalid.`);
  }
  const profile = Object.freeze({
    profileId: protocolId(input.profileId, `${context}.profileId`),
    displayName,
    templateId: STRATEGY_TEMPLATE_ID.TREASURY_INVENTORY_HEDGE,
    templateVersion: 1 as const,
    packageTemplateManifestHash: manifestHash(input.packageTemplateManifestHash as Uint8Array),
    seriesId: protocolId(input.seriesId, `${context}.seriesId`),
    seriesVersion: version(input.seriesVersion, `${context}.seriesVersion`),
    seriesManifestHash: manifestHash(input.seriesManifestHash as Uint8Array),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    executionClassVersion: version(input.executionClassVersion, `${context}.executionClassVersion`),
    executionClassManifestHash: manifestHash(input.executionClassManifestHash as Uint8Array),
    domain,
    multiStrategyProgramId: publicKey(input.multiStrategyProgramId, `${context}.multiStrategyProgramId`),
    inventoryAsset,
    quoteAsset,
    inventory: legProfile(input.inventory, `${context}.inventory`),
    hedge: legProfile(input.hedge, `${context}.hedge`),
    metricLimits: Object.freeze(input.metricLimits as StrategyMetricLimitInput[]),
    bounds,
  });
  const definition = requireStrategyTemplateDefinition(profile.templateId);
  const sampleOwner = new PublicKey(new Uint8Array(32).fill(1));
  const sampleSettlement = deriveSolanaMultiStrategyAccount({
    programId: profile.multiStrategyProgramId,
    owner: sampleOwner,
  }).toBase58();
  try {
    strategyPackageOrder({
      version: 1,
      environment: "devnet",
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
      owner: sampleOwner.toBase58(),
      settlementAccount: sampleSettlement,
      lifecycleAction: "ENTRY",
      settlementClass: "ATOMIC_POSTCONDITION",
      packageOrderType: "MARKETABLE_LIMIT",
      packageTimeInForce: "IOC",
      economicQuantity: assetAmount(profile.inventoryAsset, bounds.minimumQuantityAtoms),
      quoteAsset: profile.quoteAsset,
      metricLimits: profile.metricLimits,
      maximumServiceFeesByAsset: [],
      maximumVenueFeesByAsset: [],
      maximumNetworkFeesByAsset: [],
      maximumRecoveryCostByAsset: [],
      maximumMarginIncrease: assetAmount(profile.quoteAsset, bounds.maximumMarginIncreaseQuoteAtoms),
      maximumResidualValue: assetAmount(profile.quoteAsset, 0n),
      expiryUnit: "SOLANA_SLOT",
      expiryValue: 2n,
      nonce: 1n,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown validation error";
    fail("INVALID_CONFIGURATION", `${context} cannot produce a valid order: ${reason}`);
  }
  return profile;
}

export function loadSolanaTreasuryHedgeProfiles(path: string): readonly SolanaTreasuryHedgeProfile[] {
  if (!isAbsolute(path)) fail("INVALID_CONFIGURATION", "Solana treasury hedge profile path must be absolute.");
  const resolved = resolve(path);
  if (statSync(resolved).size > MAX_CONFIG_BYTES) fail("INVALID_CONFIGURATION", "Solana treasury hedge profile file is too large.");
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(readFileSync(resolved, "utf8"), "solanaTreasuryHedgeProfiles");
  } catch {
    fail("INVALID_CONFIGURATION", "Solana treasury hedge profile file is not valid protocol JSON.");
  }
  const root = record(parsed, "Solana treasury hedge profile file");
  exactKeys(root, ["version", "environment", "profiles"], "Solana treasury hedge profile file");
  if (root.version !== 1 || root.environment !== "devnet" || !Array.isArray(root.profiles)
    || root.profiles.length === 0 || root.profiles.length > 16) {
    fail("INVALID_CONFIGURATION", "Solana treasury hedge profile file must contain one to sixteen Devnet profiles.");
  }
  const profiles = root.profiles.map(checkedProfile);
  if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length) {
    fail("INVALID_CONFIGURATION", "Solana treasury hedge profile IDs must be unique.");
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

function requestOwner(value: string): PublicKey {
  try {
    const owner = new PublicKey(value);
    if (owner.equals(PublicKey.default) || owner.toBase58() !== value) throw new Error("noncanonical");
    return owner;
  } catch {
    fail("INVALID_REQUEST", "Owner must be a canonical nonzero Solana public key.");
  }
}

function policyHash(
  profile: SolanaTreasuryHedgeProfile,
  request: SolanaTreasuryHedgeOrderRequest,
  settlementAccount: string,
  name: string,
): string {
  return createHash("sha256").update([
    "NARYX/solana-treasury-hedge-policy/v1",
    profile.profileId,
    request.owner,
    settlementAccount,
    request.lifecycleAction,
    request.nonce,
    request.expectedStrategyStateHash ?? "",
    name,
  ].join("\0"), "utf8").digest("hex");
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function createSolanaTreasuryHedgeOrderPort(input: Readonly<{
  profiles: readonly SolanaTreasuryHedgeProfile[];
  intake: StrategyOrderIntakePort;
  currentSlot: () => Promise<bigint>;
}>): SolanaTreasuryHedgeOrderPort {
  if (input.profiles.length === 0) fail("INVALID_CONFIGURATION", "At least one Solana treasury hedge profile is required.");
  const profiles = new Map(input.profiles.map((profile) => [profile.profileId, profile]));
  if (profiles.size !== input.profiles.length) fail("INVALID_CONFIGURATION", "Solana treasury hedge profile IDs repeat.");
  return Object.freeze({
    profiles: () => Object.freeze([...profiles.values()]),
    async create(requestValue: unknown): Promise<CreatedSolanaTreasuryHedgeOrder> {
      if (typeof requestValue !== "object" || requestValue === null || Array.isArray(requestValue)) {
        fail("INVALID_REQUEST", "Solana treasury hedge order request must be an object.");
      }
      const fields = requestValue as Record<string, unknown>;
      const allowed = new Set([
        "profileId", "owner", "lifecycleAction", "quantityAtoms", "limitHedgePrice",
        "expiryValue", "nonce", "expectedStrategyStateHash",
      ]);
      const required = [...allowed].filter((name) => name !== "expectedStrategyStateHash");
      if (Object.keys(fields).some((name) => !allowed.has(name)) || required.some((name) => !(name in fields))
        || typeof fields.profileId !== "string" || typeof fields.owner !== "string"
        || typeof fields.quantityAtoms !== "string" || typeof fields.expiryValue !== "string"
        || typeof fields.nonce !== "string"
        || (fields.lifecycleAction !== "ENTRY" && fields.lifecycleAction !== "EXIT"
          && fields.lifecycleAction !== "EMERGENCY_UNWIND")
        || (fields.expectedStrategyStateHash !== undefined && typeof fields.expectedStrategyStateHash !== "string")) {
        fail("INVALID_REQUEST", "Solana treasury hedge order request fields are invalid.");
      }
      const request = fields as unknown as SolanaTreasuryHedgeOrderRequest;
      const price = record(request.limitHedgePrice, "limitHedgePrice");
      exactKeys(price, ["quoteAtoms", "baseAtoms"], "limitHedgePrice");
      if (typeof price.quoteAtoms !== "string" || typeof price.baseAtoms !== "string") {
        fail("INVALID_REQUEST", "Hedge price fields must be decimal atoms.");
      }
      const profile = profiles.get(request.profileId);
      if (profile === undefined) fail("PROFILE_NOT_FOUND", "Solana treasury hedge profile was not found.");
      const owner = requestOwner(request.owner);
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
      const currentSlot = await input.currentSlot();
      if (currentSlot <= 0n || currentSlot > U256_MAX) fail("INVALID_CONFIGURATION", "Solana treasury hedge clock is invalid.");
      if (quantity < profile.bounds.minimumQuantityAtoms || quantity > profile.bounds.maximumQuantityAtoms
        || expiryValue <= currentSlot + 2n || expiryValue > currentSlot + profile.bounds.maximumExpiryTtlSlots) {
        fail("LIMIT_EXCEEDED", "Solana treasury hedge quantity or expiry is outside the reviewed profile bounds.");
      }
      const settlementAccount = deriveSolanaMultiStrategyAccount({
        programId: profile.multiStrategyProgramId,
        owner,
      }).toBase58();
      const opening = request.lifecycleAction === "ENTRY";
      const inventoryLeg = Object.freeze({
        legId: "inventory-position",
        legFamily: "INVENTORY_TRANSFER" as const,
        legTypeId: "inventory-position",
        domain: profile.domain,
        adapter: profile.inventory.adapter,
        venue: profile.inventory.venue,
        market: profile.inventory.market,
        assets: Object.freeze([profile.inventoryAsset, profile.quoteAsset]),
        side: "NONE" as const,
        quantityAsset: profile.inventoryAsset,
        quantityAtoms: quantity,
        minimumQuantityAtoms: quantity,
        maximumFeeQuoteAtoms: 0n,
        preconditionHashes: Object.freeze([]),
        postconditionHashes: Object.freeze([]),
        timeInForce: "IOC" as const,
        legExpiryValue: expiryValue,
      });
      const hedgeSide = opening ? "SELL" as const : "BUY" as const;
      const hedgeQuoteAtoms = requestAtoms(price.quoteAtoms, "limitHedgePrice.quoteAtoms");
      const hedgeBaseAtoms = requestAtoms(price.baseAtoms, "limitHedgePrice.baseAtoms");
      const priceDivisor = gcd(hedgeQuoteAtoms, hedgeBaseAtoms);
      const hedgeLeg = Object.freeze({
        legId: "treasury-hedge",
        legFamily: opening ? "PERP_OPEN" as const : "PERP_CLOSE" as const,
        legTypeId: "treasury-hedge",
        domain: profile.domain,
        adapter: profile.hedge.adapter,
        venue: profile.hedge.venue,
        market: profile.hedge.market,
        assets: Object.freeze([profile.inventoryAsset, profile.quoteAsset]),
        side: hedgeSide,
        quantityAsset: profile.inventoryAsset,
        quantityAtoms: quantity,
        minimumQuantityAtoms: quantity,
        limitPrice: exactPrice({
          baseAsset: profile.inventoryAsset,
          quoteAsset: profile.quoteAsset,
          quoteAtoms: hedgeQuoteAtoms / priceDivisor,
          baseAtoms: hedgeBaseAtoms / priceDivisor,
          roundingDirection: hedgeSide === "BUY" ? "FLOOR" : "CEIL",
        }),
        maximumFeeQuoteAtoms: profile.bounds.maximumVenueFeeQuoteAtoms,
        preconditionHashes: Object.freeze([]),
        postconditionHashes: Object.freeze([]),
        timeInForce: "IOC" as const,
        legExpiryValue: expiryValue,
      });
      const legs = Object.freeze(opening ? [inventoryLeg, hedgeLeg] : [hedgeLeg, inventoryLeg]);
      const graph = packageGraph({
        graphVersion: 1,
        environment: "devnet",
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
        strategyAccountRefs: [settlementAccount],
        legs,
        dependencyEdges: [opening
          ? { fromLegId: "inventory-position", toLegId: "treasury-hedge" }
          : { fromLegId: "treasury-hedge", toLegId: "inventory-position" }],
        executionGroups: [{
          groupId: "solana-treasury-hedge",
          kind: "ALL_OR_NONE",
          legIds: legs.map((leg) => leg.legId),
        }],
        settlementClass: "ATOMIC_POSTCONDITION",
        policyHashes: {
          netting: policyHash(profile, request, settlementAccount, "netting"),
          privacy: policyHash(profile, request, settlementAccount, "privacy"),
          solver: policyHash(profile, request, settlementAccount, "solver"),
          delivery: policyHash(profile, request, settlementAccount, "delivery"),
          resource: policyHash(profile, request, settlementAccount, "resource"),
          portfolioRiskLimits: policyHash(profile, request, settlementAccount, "portfolio-risk-limits"),
        },
        recoverySlots: [],
        maximumRecoveryCostQuoteAtoms: 0n,
        expiryUnit: "SOLANA_SLOT",
        packageExpiryValue: expiryValue,
        nonce,
      });
      const definition = requireStrategyTemplateDefinition(profile.templateId);
      const cap = (atoms: bigint) => atoms === 0n ? [] : [{ asset: profile.quoteAsset, maxAtoms: atoms }];
      const order = strategyPackageOrder({
        version: 1,
        environment: "devnet",
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
        settlementAccount,
        lifecycleAction: request.lifecycleAction,
        settlementClass: "ATOMIC_POSTCONDITION",
        packageOrderType: "MARKETABLE_LIMIT",
        packageTimeInForce: "IOC",
        economicQuantity: assetAmount(profile.inventoryAsset, quantity),
        quoteAsset: profile.quoteAsset,
        metricLimits: profile.metricLimits,
        maximumServiceFeesByAsset: cap(profile.bounds.maximumServiceFeeQuoteAtoms),
        maximumVenueFeesByAsset: cap(profile.bounds.maximumVenueFeeQuoteAtoms),
        maximumNetworkFeesByAsset: cap(profile.bounds.maximumNetworkFeeQuoteAtoms),
        maximumRecoveryCostByAsset: [],
        maximumMarginIncrease: assetAmount(
          profile.quoteAsset,
          opening ? profile.bounds.maximumMarginIncreaseQuoteAtoms : 0n,
        ),
        maximumResidualValue: assetAmount(profile.quoteAsset, 0n),
        ...(request.expectedStrategyStateHash === undefined
          ? {}
          : { expectedStrategyStateHash: request.expectedStrategyStateHash }),
        expiryUnit: "SOLANA_SLOT",
        expiryValue,
        nonce,
      });
      const intake = input.intake.store(order, graph, currentSlot);
      if (intake.orderHashHex !== toHex(strategyPackageOrderHash(order))
        || intake.graphHashHex !== toHex(packageGraphHash(graph))) {
        fail("INTAKE_MISMATCH", "Solana treasury hedge intake returned an invalid identity.");
      }
      return Object.freeze({ profileId: profile.profileId, settlementAccount, order, graph, intake });
    },
  });
}
