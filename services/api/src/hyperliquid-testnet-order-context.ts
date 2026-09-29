import type { ActiveOrderContext, ActiveOrderContextProvider } from "./canonical-entry-order.js";
import type { HyperliquidTestnetRuntimeConfig } from "./hyperliquid-testnet-runtime-client.js";
import type { InternalOrderClockPort } from "./terminal-orders.js";

export type HyperliquidTestnetOrderRuntime = Readonly<{
  contexts: ActiveOrderContextProvider;
  clock: InternalOrderClockPort;
  terminalContext: HyperliquidTestnetTerminalContext;
}>;

export type HyperliquidTestnetTerminalContext = Readonly<{
  contextId: string;
  tradingAccount: string;
  domain: Readonly<{
    domainId: string;
    domainManifestVersion: number;
    domainManifestHash: string;
  }>;
  environment: "TESTNET";
  authorizationMode: "CONFIGURED_DEDICATED_TESTNET_ACCOUNT_GATE";
}>;

export function createHyperliquidTestnetOrderRuntime(
  config: HyperliquidTestnetRuntimeConfig,
  currentTimeMs: () => number = Date.now,
): HyperliquidTestnetOrderRuntime {
  const order = config.orderContext;
  if (order === undefined) throw new Error("Hyperliquid Testnet order context is missing.");
  const readClock = (): bigint => {
    const value = currentTimeMs();
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Hyperliquid Testnet millisecond clock is invalid.");
    }
    return BigInt(value);
  };
  const contexts: ActiveOrderContextProvider = (contextId) => {
    if (contextId !== order.contextId) return undefined;
    const context: ActiveOrderContext = Object.freeze({
      contextId: order.contextId,
      state: "ACTIVE",
      capturedAtClock: readClock(),
      maxStaleness: order.maxStalenessMs,
      domain: config.domain,
      environment: "testnet",
      orderVersion: order.orderVersion,
      templateId: order.templateId,
      templateVersion: order.templateVersion,
      packageTemplateManifestHash: order.packageTemplateManifestHash,
      baseAsset: order.baseAsset,
      quoteAsset: order.quoteAsset,
      spotAdapters: [order.spotAdapter],
      perpAdapters: [order.perpetualAdapter],
      settlementClass: "BATCHED_IOC_WITH_RECOVERY",
      expiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
      expiryTtl: order.expiryTtlMs,
      spotReferencePrice: order.spotReferencePrice,
      maxEntrySpread: order.maxEntrySpread,
      maximumQuantityAtoms: order.maximumQuantityAtoms,
      maxSlippageBps: order.maxSlippageBps,
      maxVenueFeeAtomsByAsset: order.maxVenueFeeAtomsByAsset,
      maxMarginAddedAtoms: order.maxMarginAddedAtoms,
      maxProtocolFeeAtoms: order.maxProtocolFeeAtoms,
      maxSolverFeeAtoms: order.maxSolverFeeAtoms,
      maxPriorityFeeAtoms: order.maxPriorityFeeAtoms,
      minVenueReserveReturnedAtoms: order.minVenueReserveReturnedAtoms,
      minWalletQuoteBalanceDeltaAtoms: order.minWalletQuoteBalanceDeltaAtoms,
      maxResidualBaseQuantityAtoms: order.maxResidualBaseQuantityAtoms,
      requiredOwner: order.tradingAccount,
      requiredSettlementAccount: order.tradingAccount,
      hyperliquidQuantityPolicy: "BOUNDED_NET",
      hyperliquidMaxNetSpotShortfallAtoms: order.maxNetSpotShortfallAtoms,
      hyperliquidMaxNetSpotExcessAtoms: order.maxNetSpotExcessAtoms,
      hyperliquidMaxTerminalResidualBaseQuantityAtoms:
        order.maxTerminalResidualBaseQuantityAtoms,
      hyperliquidMaxTerminalResidualQuoteValueAtoms:
        order.maxTerminalResidualQuoteValueAtoms,
      hyperliquidResidualValuationReferencePrice: order.residualValuationReferencePrice,
      hyperliquidMinPerpSellPrice: order.minPerpSellPrice,
      hyperliquidRecoveryExpiryTtl: order.recoveryActionExpiryTtlMs,
      hyperliquidRecoveryDeadlineTtl: order.recoveryDeadlineTtlMs,
      hyperliquidMinRecoveryWindowMs: order.minRecoveryWindowMs,
      maxRecoverySpotBuyPrice: order.maxRecoverySpotBuyPrice,
      minRecoverySpotSellPrice: order.minRecoverySpotSellPrice,
      minRecoveryPerpSellPrice: order.minRecoveryPerpSellPrice,
      maxRecoveryPerpBuyPrice: order.maxRecoveryPerpBuyPrice,
      maxRecoveryCostAtomsByAsset: order.maxRecoveryCostAtomsByAsset,
      maxAggregateRecoveryLossQuoteAtoms: order.maxAggregateRecoveryLossQuoteAtoms,
      allowedRecoveryActions: Object.freeze([
        "CANCEL_OPEN_ORDERS",
        "COMPLETE_SPOT",
        "COMPLETE_PERP",
        "ROLLBACK_SPOT",
        "ROLLBACK_PERP",
      ] as const),
    });
    return context;
  };
  const clock: InternalOrderClockPort = Object.freeze({
    currentClock: async (context: ActiveOrderContext) => {
      if (context.contextId !== order.contextId) {
        throw new Error("Hyperliquid Testnet order context is unknown.");
      }
      return readClock();
    },
  });
  const terminalContext: HyperliquidTestnetTerminalContext = Object.freeze({
    contextId: order.contextId,
    tradingAccount: order.tradingAccount,
    domain: Object.freeze({
      domainId: config.domain.domainId,
      domainManifestVersion: config.domain.domainManifestVersion,
      domainManifestHash: Buffer.from(config.domain.domainManifestHash).toString("hex"),
    }),
    environment: "TESTNET",
    authorizationMode: "CONFIGURED_DEDICATED_TESTNET_ACCOUNT_GATE",
  });
  return Object.freeze({ contexts, clock, terminalContext });
}
