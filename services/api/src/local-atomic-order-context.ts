import {
  LOCAL_ATOMIC_MARKET_CATALOG_V1,
  localConformanceSlot,
  type LocalAtomicMarketCatalog,
} from '@naryx/adapter-core';
import type { ActiveOrderContext, ActiveOrderContextProvider } from './canonical-entry-order.js';
import type { InternalOrderClockPort } from './terminal-orders.js';

export interface LocalAtomicOrderRuntime {
  readonly catalog: LocalAtomicMarketCatalog;
  readonly contexts: ActiveOrderContextProvider;
  readonly clock: InternalOrderClockPort;
}

export function createLocalAtomicOrderRuntime(
  catalog: LocalAtomicMarketCatalog = LOCAL_ATOMIC_MARKET_CATALOG_V1,
  currentClock: () => bigint = () => localConformanceSlot(),
  readClock: () => Promise<bigint> = async () => currentClock(),
): LocalAtomicOrderRuntime {
  const contexts: ActiveOrderContextProvider = (contextId) => {
    if (contextId !== catalog.contextId) return undefined;
    const clock = currentClock();
    const context: ActiveOrderContext = Object.freeze({
      contextId: catalog.contextId,
      state: 'ACTIVE',
      capturedAtClock: clock,
      maxStaleness: 1n,
      domain: catalog.domain,
      environment: 'local',
      orderVersion: 1,
      templateId: catalog.template.templateId,
      templateVersion: catalog.template.templateVersion,
      packageTemplateManifestHash: catalog.template.packageTemplateManifestHash,
      baseAsset: catalog.baseAsset,
      quoteAsset: catalog.quoteAsset,
      spotAdapters: [catalog.adapter],
      perpAdapters: [catalog.adapter],
      settlementClass: 'ATOMIC_POSTCONDITION',
      expiryUnit: 'SOLANA_SLOT',
      expiryTtl: catalog.orderLimits.expiryTtlSlots,
      spotReferencePrice: catalog.pricing.spot,
      maxEntrySpread: catalog.pricing.maximumEntrySpread,
      maximumQuantityAtoms: catalog.orderLimits.maximumQuantityAtoms,
      maxSlippageBps: catalog.orderLimits.maximumSlippageBps,
      maxVenueFeeAtomsByAsset: [
        { asset: catalog.baseAsset, maxAtoms: 0n },
        { asset: catalog.quoteAsset, maxAtoms: 0n },
      ],
      maxMarginAddedAtoms: catalog.orderLimits.maxMarginAddedAtoms,
      maxProtocolFeeAtoms: catalog.orderLimits.maxProtocolFeeAtoms,
      maxSolverFeeAtoms: catalog.orderLimits.maxSolverFeeAtoms,
      maxPriorityFeeAtoms: catalog.orderLimits.maxPriorityFeeAtoms,
      minVenueReserveReturnedAtoms: 0n,
      minWalletQuoteBalanceDeltaAtoms: 0n,
      maxResidualBaseQuantityAtoms: 0n,
    });
    return context;
  };
  const clock: InternalOrderClockPort = Object.freeze({
    currentClock: async (context: ActiveOrderContext) => {
      if (context.contextId !== catalog.contextId) throw new Error('local order context is unknown');
      return readClock();
    },
  });
  return Object.freeze({ catalog, contexts, clock });
}
