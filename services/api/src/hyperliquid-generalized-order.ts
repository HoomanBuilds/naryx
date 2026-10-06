import { createHash } from "node:crypto";
import {
  bytesEqual,
  exactPrice,
  packageGraph,
  packageGraphHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  toHex,
  versionedManifestRef,
  type AssetRef,
  type FeeCap,
  type PackageGraph,
  type PackageGraphInput,
  type PackageOrder,
  type StrategyPackageOrder,
  type StrategyPackageOrderInput,
} from "@naryx/protocol-types";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { HyperliquidTestnetRuntimeConfig } from "./hyperliquid-testnet-runtime-client.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import type {
  StrategyOrderIntakePort,
  StrategyOrderIntakeResult,
} from "./strategy-order-intake.js";

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const U256_MAX = (1n << 256n) - 1n;

export class HyperliquidGeneralizedOrderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HyperliquidGeneralizedOrderError";
    this.code = code;
  }
}

export type HyperliquidGeneralizedOrderProfile = Readonly<{
  seriesId: string;
  seriesVersion: number;
  executionClassId: string;
  executionClassVersion: number;
}>;

export type StagedHyperliquidGeneralizedOrder = Readonly<{
  sourceOrderHash: string;
  order: StrategyPackageOrder;
  graph: PackageGraph;
  intake: StrategyOrderIntakeResult;
}>;

export interface HyperliquidGeneralizedOrderPort {
  stage(sourceOrderHash: string): StagedHyperliquidGeneralizedOrder;
}

function positiveVersion(value: string | undefined, name: string): number {
  if (value === undefined || !/^[1-9][0-9]{0,9}$/.test(value)) {
    throw new HyperliquidGeneralizedOrderError("INVALID_CONFIGURATION", `${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 0xffff_ffff) {
    throw new HyperliquidGeneralizedOrderError("INVALID_CONFIGURATION", `${name} is too large.`);
  }
  return parsed;
}

function identifier(value: string | undefined, name: string): string {
  if (value === undefined || !ID.test(value)) {
    throw new HyperliquidGeneralizedOrderError("INVALID_CONFIGURATION", `${name} is invalid.`);
  }
  return value;
}

export function loadHyperliquidGeneralizedOrderProfile(
  environment: NodeJS.ProcessEnv = process.env,
): HyperliquidGeneralizedOrderProfile | undefined {
  const enabled = environment.NARYX_HYPERLIQUID_GENERALIZED_ORDER_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") {
    throw new HyperliquidGeneralizedOrderError(
      "INVALID_CONFIGURATION",
      "NARYX_HYPERLIQUID_GENERALIZED_ORDER_ENABLED must be true or false.",
    );
  }
  if (enabled === "false") return undefined;
  return Object.freeze({
    seriesId: identifier(
      environment.NARYX_HYPERLIQUID_GENERALIZED_SERIES_ID,
      "NARYX_HYPERLIQUID_GENERALIZED_SERIES_ID",
    ),
    seriesVersion: positiveVersion(
      environment.NARYX_HYPERLIQUID_GENERALIZED_SERIES_VERSION,
      "NARYX_HYPERLIQUID_GENERALIZED_SERIES_VERSION",
    ),
    executionClassId: identifier(
      environment.NARYX_HYPERLIQUID_GENERALIZED_EXECUTION_CLASS_ID,
      "NARYX_HYPERLIQUID_GENERALIZED_EXECUTION_CLASS_ID",
    ),
    executionClassVersion: positiveVersion(
      environment.NARYX_HYPERLIQUID_GENERALIZED_EXECUTION_CLASS_VERSION,
      "NARYX_HYPERLIQUID_GENERALIZED_EXECUTION_CLASS_VERSION",
    ),
  });
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function capFor(caps: readonly FeeCap[], asset: AssetRef): bigint {
  return caps.find((cap) => sameAsset(cap.asset, asset))?.maxAtoms ?? 0n;
}

function checkedSum(left: bigint, right: bigint, context: string): bigint {
  const sum = left + right;
  if (sum < 0n || sum > U256_MAX) {
    throw new HyperliquidGeneralizedOrderError("INVALID_SOURCE_ORDER", `${context} is outside u256.`);
  }
  return sum;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function policyHash(sourceOrderHash: string, policy: string): string {
  return createHash("sha256")
    .update("NARYX/generalized-order-policy/v1", "ascii")
    .update(policy, "ascii")
    .update(Buffer.from(sourceOrderHash, "hex"))
    .digest("hex");
}

function requireSourceOrder(order: PackageOrder, config: HyperliquidTestnetRuntimeConfig): void {
  const context = config.orderContext;
  if (context === undefined
    || order.environment !== "testnet"
    || order.domain.domainId !== "hypercore:testnet"
    || order.templateId !== "cash-and-carry-v1"
    || order.action !== "ENTRY"
    || order.direction !== "LONG_SPOT_SHORT_PERP"
    || order.settlementClass !== "BATCHED_IOC_WITH_RECOVERY"
    || order.packageOrderType !== "MARKETABLE_LIMIT"
    || order.packageTimeInForce !== "IOC"
    || order.expiryUnit !== "HYPERLIQUID_UNIX_MILLISECONDS"
    || !sameAsset(order.quantity.asset, context.baseAsset)
    || order.maxSpotQuoteIn === undefined
    || !sameAsset(order.maxSpotQuoteIn.asset, context.quoteAsset)
    || order.hyperliquidGrossSpotQuantity === undefined
    || !sameAsset(order.hyperliquidGrossSpotQuantity.asset, context.baseAsset)
    || order.hyperliquidMinNetSpotDelta === undefined
    || order.hyperliquidMinPerpSellPrice === undefined
    || !sameAsset(order.maxAggregateRecoveryLossQuote.asset, context.quoteAsset)
    || order.hyperliquidGrossSpotQuantity.atoms < order.quantity.atoms) {
    throw new HyperliquidGeneralizedOrderError(
      "UNSUPPORTED_SOURCE_ORDER",
      "The source order is not an active Hyperliquid Testnet cash-and-carry entry.",
    );
  }
  if (order.domain.domainManifestVersion !== config.domain.domainManifestVersion
    || !bytesEqual(order.domain.domainManifestHash, config.domain.domainManifestHash)
    || order.settlementAccount !== context.tradingAccount
    || toHex(order.packageTemplateManifestHash) !== context.packageTemplateManifestHash) {
    throw new HyperliquidGeneralizedOrderError(
      "SOURCE_ORDER_MISMATCH",
      "The source order does not bind the configured Hyperliquid lane.",
    );
  }
}

function buildDocuments(
  order: PackageOrder,
  sourceOrderHash: string,
  config: HyperliquidTestnetRuntimeConfig,
  profile: HyperliquidGeneralizedOrderProfile,
): Readonly<{ order: StrategyPackageOrder; graph: PackageGraph }> {
  requireSourceOrder(order, config);
  const context = config.orderContext!;
  const base = context.baseAsset;
  const quote = context.quoteAsset;
  const grossSpot = order.hyperliquidGrossSpotQuantity!;
  const spotPriceDivisor = gcd(order.maxSpotQuoteIn!.atoms, grossSpot.atoms);
  const spotLimit = exactPrice({
    baseAsset: base,
    quoteAsset: quote,
    quoteAtoms: order.maxSpotQuoteIn!.atoms / spotPriceDivisor,
    baseAtoms: grossSpot.atoms / spotPriceDivisor,
    roundingDirection: "FLOOR",
  });
  const perpetualLimit = order.hyperliquidMinPerpSellPrice!;
  const quoteVenueFee = capFor(order.maxVenueFeeAtomsByAsset, quote);
  const maximumRecoveryCost = capFor(order.maxRecoveryCostAtomsByAsset, quote);
  const maximumAggregateRecoveryLoss = order.maxAggregateRecoveryLossQuote.atoms;
  const spotVenue = versionedManifestRef(
    config.market.spot.venueId,
    config.market.spot.venueManifestVersion,
    config.market.spot.venueManifestHash,
  );
  const spotMarket = versionedManifestRef(
    config.market.spot.marketId,
    config.market.spot.marketManifestVersion,
    config.market.spot.marketManifestHash,
  );
  const perpetualVenue = versionedManifestRef(
    config.market.perpetual.venueId,
    config.market.perpetual.venueManifestVersion,
    config.market.perpetual.venueManifestHash,
  );
  const perpetualMarket = versionedManifestRef(
    config.market.perpetual.marketId,
    config.market.perpetual.marketManifestVersion,
    config.market.perpetual.marketManifestHash,
  );
  const graphInput: PackageGraphInput = {
    graphVersion: 1,
    environment: order.environment,
    templateId: order.templateId,
    templateVersion: order.templateVersion,
    packageTemplateManifestHash: order.packageTemplateManifestHash,
    seriesId: profile.seriesId,
    seriesVersion: profile.seriesVersion,
    seriesManifestHash: config.seriesManifestHash,
    executionClassId: profile.executionClassId,
    executionClassVersion: profile.executionClassVersion,
    executionClassManifestHash: config.executionClassManifestHash,
    lifecycleAction: "ENTRY",
    owner: order.owner,
    strategyAccountRefs: [order.settlementAccount],
    legs: [{
      legId: "spot",
      legFamily: "SPOT_SWAP",
      legTypeId: "spot-purchase",
      domain: order.domain,
      adapter: context.spotAdapter,
      venue: spotVenue,
      market: spotMarket,
      assets: [base, quote],
      side: "BUY",
      quantityAsset: base,
      quantityAtoms: grossSpot.atoms,
      minimumQuantityAtoms: order.hyperliquidMinNetSpotDelta!.atoms,
      limitPrice: spotLimit,
      maximumFeeQuoteAtoms: quoteVenueFee,
      preconditionHashes: [],
      postconditionHashes: [],
      timeInForce: "IOC",
      legExpiryValue: order.expiryValue,
    }, {
      legId: "perp",
      legFamily: "PERP_OPEN",
      legTypeId: "perp-sale",
      domain: order.domain,
      adapter: context.perpetualAdapter,
      venue: perpetualVenue,
      market: perpetualMarket,
      assets: [base, quote],
      side: "SELL",
      quantityAsset: base,
      quantityAtoms: order.quantity.atoms,
      minimumQuantityAtoms: order.quantity.atoms,
      limitPrice: perpetualLimit,
      maximumFeeQuoteAtoms: quoteVenueFee,
      preconditionHashes: [],
      postconditionHashes: [],
      timeInForce: "IOC",
      legExpiryValue: order.expiryValue,
    }],
    dependencyEdges: [],
    executionGroups: [{
      groupId: "batched",
      kind: "BOUNDED_PARTIAL",
      legIds: ["spot", "perp"],
      maximumResidualQuoteAtoms: order.hyperliquidMaxTerminalResidualQuoteValue?.atoms ?? 0n,
    }],
    settlementClass: "BATCHED_IOC_WITH_RECOVERY",
    policyHashes: {
      netting: policyHash(sourceOrderHash, "netting"),
      privacy: policyHash(sourceOrderHash, "privacy"),
      solver: policyHash(sourceOrderHash, "solver"),
      delivery: policyHash(sourceOrderHash, "delivery"),
      resource: policyHash(sourceOrderHash, "resource"),
      portfolioRiskLimits: policyHash(sourceOrderHash, "portfolio-risk-limits"),
    },
    recoverySlots: [{
      legId: "spot",
      action: "COMPLETE",
      maximumQuantityAtoms: grossSpot.atoms,
      maximumCostQuoteAtoms: maximumRecoveryCost,
    }, {
      legId: "perp",
      action: "COMPLETE",
      maximumQuantityAtoms: order.quantity.atoms,
      maximumCostQuoteAtoms: maximumRecoveryCost,
    }],
    maximumRecoveryCostQuoteAtoms: maximumAggregateRecoveryLoss,
    expiryUnit: order.expiryUnit,
    packageExpiryValue: order.expiryValue,
    nonce: order.nonce,
  };
  const graph = packageGraph(graphInput);
  const serviceFee = checkedSum(order.maxProtocolFee.atoms, order.maxSolverFee.atoms, "service fee cap");
  const orderInput: StrategyPackageOrderInput = {
    version: 1,
    environment: order.environment,
    templateId: order.templateId,
    templateVersion: order.templateVersion,
    packageTemplateManifestHash: order.packageTemplateManifestHash,
    graphHash: packageGraphHash(graph),
    seriesId: profile.seriesId,
    seriesVersion: profile.seriesVersion,
    seriesManifestHash: config.seriesManifestHash,
    executionClassId: profile.executionClassId,
    executionClassVersion: profile.executionClassVersion,
    executionClassManifestHash: config.executionClassManifestHash,
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.ANNUALIZED_NET_YIELD,
    riskClassId: STRATEGY_RISK_CLASS_ID.DELTA_NEUTRAL_BASIS,
    owner: order.owner,
    settlementAccount: order.settlementAccount,
    lifecycleAction: "ENTRY",
    settlementClass: "BATCHED_IOC_WITH_RECOVERY",
    packageOrderType: "MARKETABLE_LIMIT",
    packageTimeInForce: "IOC",
    economicQuantity: order.quantity,
    quoteAsset: quote,
    metricLimits: [],
    maximumServiceFeesByAsset: serviceFee === 0n ? [] : [{ asset: quote, maxAtoms: serviceFee }],
    maximumVenueFeesByAsset: order.maxVenueFeeAtomsByAsset,
    maximumNetworkFeesByAsset: order.maxPriorityFee.atoms === 0n
      ? []
      : [{ asset: quote, maxAtoms: order.maxPriorityFee.atoms }],
    maximumRecoveryCostByAsset: order.maxRecoveryCostAtomsByAsset,
    maximumMarginIncrease: order.maxMarginAdded,
    maximumResidualValue: order.hyperliquidMaxTerminalResidualQuoteValue
      ?? { asset: quote, atoms: 0n },
    expiryUnit: order.expiryUnit,
    expiryValue: order.expiryValue,
    nonce: order.nonce,
  };
  return Object.freeze({ graph, order: strategyPackageOrder(orderInput) });
}

export function createHyperliquidGeneralizedOrderPort(input: Readonly<{
  config: HyperliquidTestnetRuntimeConfig;
  profile: HyperliquidGeneralizedOrderProfile;
  orders: Pick<InternalOrderStore, "getCanonicalOrderByHash">;
  intents: Pick<ExecutionIntentStore, "getAttemptForOrder" | "getAuthorization">;
  intake: StrategyOrderIntakePort;
}>): HyperliquidGeneralizedOrderPort {
  if (input.config.orderContext === undefined) {
    throw new HyperliquidGeneralizedOrderError("INVALID_CONFIGURATION", "Hyperliquid order context is missing.");
  }
  return Object.freeze({
    stage(sourceOrderHash: string): StagedHyperliquidGeneralizedOrder {
      if (!HASH.test(sourceOrderHash)) {
        throw new HyperliquidGeneralizedOrderError("INVALID_REQUEST", "Source order hash must be 32 lowercase hex bytes.");
      }
      const source = input.orders.getCanonicalOrderByHash(sourceOrderHash);
      if (source === undefined) {
        throw new HyperliquidGeneralizedOrderError("ORDER_NOT_FOUND", "The source order was not found.");
      }
      const selected = input.intents.getAttemptForOrder(sourceOrderHash);
      if (selected === undefined && input.intents.getAuthorization(sourceOrderHash) === undefined) {
        throw new HyperliquidGeneralizedOrderError(
          "SOURCE_ORDER_NOT_REVIEWED",
          "Review and select the canonical package quote before staging its typed strategy order.",
        );
      }
      const documents = buildDocuments(source, sourceOrderHash, input.config, input.profile);
      const intake = input.intake.store(documents.order, documents.graph);
      if (intake.orderHashHex !== toHex(strategyPackageOrderHash(documents.order))
        || intake.graphHashHex !== toHex(packageGraphHash(documents.graph))) {
        throw new HyperliquidGeneralizedOrderError("INTAKE_MISMATCH", "Strategy order intake returned an invalid identity.");
      }
      return Object.freeze({ sourceOrderHash, ...documents, intake });
    },
  });
}
