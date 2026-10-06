import { createHash } from 'node:crypto';
import {
  bytesEqual,
  strategyPackageOrderHash,
  strategyPackageQuoteHash,
  typedStrategyRouteHash,
  versionedManifestRef,
  adapterRef,
  type AdapterRef,
  type AdmittedStrategyPackage,
  type AssetRef,
  type CommitmentHash,
  type DomainRef,
  type ExactPrice,
  type GraphRecoveryAction,
  type ManifestHash,
  type TypedStrategyDomainPlan,
  type TypedStrategyRoute,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import type { HypercoreOrderWire } from './index.js';
import { formatHypercorePrice, formatHypercoreSize } from './wire-format.js';

const CLIENT_ORDER_ID_DOMAIN = 'naryx/hypercore/strategy-client-order-id/v1';
const MAX_BATCH_ORDERS = 16;

export interface HyperliquidStrategyMarketBindingInput {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly assetId: number;
  readonly sizeDecimals: number;
  readonly maximumPriceDecimals: number;
}

export interface HyperliquidStrategyMarketBinding {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly assetId: number;
  readonly sizeDecimals: number;
  readonly maximumPriceDecimals: number;
}

export interface HypercoreStrategyPlannedOrder {
  readonly legId: string;
  readonly stage: number;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly signedBaseDeltaAtoms: bigint;
  readonly limitPrice: ExactPrice;
  readonly clientOrderId: `0x${string}`;
  readonly wire: HypercoreOrderWire;
}

export interface HypercoreStrategyBatch {
  readonly stage: number;
  readonly action: Readonly<{
    type: 'order';
    orders: readonly HypercoreOrderWire[];
    grouping: 'na';
  }>;
  readonly legIds: readonly string[];
}

export interface HypercoreStrategyRecoveryAuthorization {
  readonly legId: string;
  readonly action: GraphRecoveryAction;
  readonly maximumQuantityAtoms: bigint;
  readonly maximumCostQuoteAtoms: bigint;
}

export interface HyperliquidStrategyExecutionPlan {
  readonly version: 1;
  readonly guarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY';
  readonly domain: DomainRef;
  readonly orderHash: CommitmentHash;
  readonly graphHash: CommitmentHash;
  readonly quoteHash: CommitmentHash;
  readonly routeHash: CommitmentHash;
  readonly requestExpiryMs: bigint;
  readonly orders: readonly HypercoreStrategyPlannedOrder[];
  readonly batches: readonly HypercoreStrategyBatch[];
  readonly recoveryAuthorizations: readonly HypercoreStrategyRecoveryAuthorization[];
  readonly maximumRecoveryCostQuoteAtoms: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameManifest(left: VersionedManifestRef, right: VersionedManifestRef): boolean {
  return left.subjectId === right.subjectId
    && left.manifestVersion === right.manifestVersion
    && bytesEqual(left.manifestHash, right.manifestHash);
}

function checkedBinding(input: HyperliquidStrategyMarketBindingInput, index: number): HyperliquidStrategyMarketBinding {
  const context = `hyperliquidStrategy.bindings[${index}]`;
  requireCondition(Number.isInteger(input.assetId) && input.assetId >= 0 && input.assetId <= 0xffff_ffff, `${context}.assetId must fit u32`);
  requireCondition(Number.isInteger(input.sizeDecimals) && input.sizeDecimals >= 0 && input.sizeDecimals <= 8, `${context}.sizeDecimals is invalid`);
  requireCondition(Number.isInteger(input.maximumPriceDecimals) && input.maximumPriceDecimals >= 0 && input.maximumPriceDecimals <= 8, `${context}.maximumPriceDecimals is invalid`);
  return Object.freeze({
    adapter: adapterRef(input.adapter, `${context}.adapter`),
    venue: versionedManifestRef(input.venue.subjectId, input.venue.manifestVersion, input.venue.manifestHash, `${context}.venue`),
    market: versionedManifestRef(input.market.subjectId, input.market.manifestVersion, input.market.manifestHash, `${context}.market`),
    assetId: input.assetId,
    sizeDecimals: input.sizeDecimals,
    maximumPriceDecimals: input.maximumPriceDecimals,
  });
}

function encodedPart(value: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function clientOrderId(
  domain: DomainRef,
  orderHash: CommitmentHash,
  quoteHash: CommitmentHash,
  routeHash: CommitmentHash,
  legId: string,
  assetId: number,
): `0x${string}` {
  const asset = Buffer.allocUnsafe(4);
  asset.writeUInt32BE(assetId);
  const version = Buffer.allocUnsafe(4);
  version.writeUInt32BE(domain.domainManifestVersion);
  const digest = createHash('sha256');
  for (const part of [
    Buffer.from(CLIENT_ORDER_ID_DOMAIN, 'ascii'),
    Buffer.from(domain.domainId, 'ascii'),
    version,
    Buffer.from(domain.domainManifestHash),
    Buffer.from(orderHash),
    Buffer.from(quoteHash),
    Buffer.from(routeHash),
    Buffer.from(legId, 'ascii'),
    asset,
  ]) digest.update(encodedPart(part));
  return `0x${digest.digest().subarray(0, 16).toString('hex')}`;
}

function signedDelta(side: 'BUY' | 'SELL' | 'NONE', atoms: bigint): bigint {
  requireCondition(side !== 'NONE', 'HyperCore order leg requires a buy or sell side');
  return side === 'BUY' ? atoms : -atoms;
}

function reduceOnly(family: string): boolean {
  return family === 'PERP_CLOSE' || family === 'PERP_DECREASE';
}

export function compileHyperliquidStrategyPlan(input: Readonly<{
  admission: AdmittedStrategyPackage;
  route: TypedStrategyRoute;
  domainPlan?: TypedStrategyDomainPlan;
  bindings: readonly HyperliquidStrategyMarketBindingInput[];
}>): HyperliquidStrategyExecutionPlan {
  const { admission, route } = input;
  const { graph, order, quote } = admission;
  requireCondition(route.settlementClass === 'BATCHED_IOC_WITH_RECOVERY' || route.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED', 'HyperCore strategy route requires batched IOC or cross-domain prepositioned settlement');
  requireCondition(graph.settlementClass === route.settlementClass && order.settlementClass === route.settlementClass && quote.settlementClass === route.settlementClass, 'settlement class mismatch');
  const domainPlan = input.domainPlan ?? route.domainPlans[0];
  requireCondition(domainPlan?.executionPlanKind === 'HYPERCORE_BATCHED_IOC', 'route must contain a HyperCore domain plan');
  requireCondition(route.domainPlans.some((candidate) => sameDomain(candidate.domain, domainPlan.domain)
    && candidate.executionPlanKind === domainPlan.executionPlanKind), 'HyperCore domain plan is not part of the route');
  if (input.domainPlan === undefined) requireCondition(route.domainPlans.length === 1, 'HyperCore strategy execution requires an explicit domain plan for a cross-domain route');
  const domain = domainPlan.domain;
  const selectedLegIds = new Set(domainPlan.legIds);
  const domainLegs = graph.legs.filter((leg) => selectedLegIds.has(leg.legId));
  requireCondition(domainLegs.length > 0 && domainLegs.length === selectedLegIds.size && domainLegs.length <= MAX_BATCH_ORDERS, `HyperCore strategy supports 1 to ${MAX_BATCH_ORDERS} bound domain legs`);
  requireCondition(domainLegs.every((leg) => sameDomain(leg.domain, domain)), 'HyperCore domain plan contains a leg from another domain');
  requireCondition(order.expiryUnit === 'HYPERLIQUID_UNIX_MILLISECONDS' && quote.validUntilUnit === order.expiryUnit && route.routeExpiryUnit === order.expiryUnit, 'HyperCore strategy requires millisecond expiries');
  requireCondition(route.routeExpiryValue <= order.expiryValue && route.routeExpiryValue <= quote.validUntilValue, 'route expiry exceeds signed validity');
  const bindings = input.bindings.map(checkedBinding);
  const orderHash = strategyPackageOrderHash(order);
  const quoteHash = strategyPackageQuoteHash(quote);
  const routeHash = typedStrategyRouteHash(route);
  const planned = domainLegs.map((leg): HypercoreStrategyPlannedOrder => {
    requireCondition(
      leg.legFamily === 'SPOT_SWAP'
        || leg.legFamily === 'PERP_OPEN'
        || leg.legFamily === 'PERP_CLOSE'
        || leg.legFamily === 'PERP_INCREASE'
        || leg.legFamily === 'PERP_DECREASE',
      `HyperCore cannot materialize ${leg.legFamily}`,
    );
    const matchingBindings = bindings.filter((candidate) =>
      sameAdapter(candidate.adapter, leg.adapter)
      && sameManifest(candidate.venue, leg.venue)
      && sameManifest(candidate.market, leg.market),
    );
    requireCondition(matchingBindings.length === 1, `leg ${leg.legId} must resolve to exactly one HyperCore binding`);
    const binding = matchingBindings[0]!;
    requireCondition(leg.limitPrice !== undefined, `HyperCore leg ${leg.legId} requires an exact limit price`);
    requireCondition(leg.timeInForce === 'IOC', `HyperCore leg ${leg.legId} requires IOC`);
    const routeLeg = route.legs.find((value) => value.legId === leg.legId);
    requireCondition(routeLeg?.executionPlanKind === 'HYPERCORE_BATCHED_IOC', `route leg ${leg.legId} is not HyperCore IOC`);
    const formattedPrice = formatHypercorePrice(leg.limitPrice, binding.maximumPriceDecimals);
    const size = formatHypercoreSize(leg.quantityAtoms, leg.quantityAsset.decimals, binding.sizeDecimals);
    const clientId = clientOrderId(domain, orderHash, quoteHash, routeHash, leg.legId, binding.assetId);
    const stage = graph.stages.findIndex((values) => values.includes(leg.legId));
    return Object.freeze({
      legId: leg.legId,
      stage,
      baseAsset: leg.limitPrice.baseAsset,
      quoteAsset: leg.limitPrice.quoteAsset,
      signedBaseDeltaAtoms: signedDelta(leg.side, leg.quantityAtoms),
      limitPrice: leg.limitPrice,
      clientOrderId: clientId,
      wire: Object.freeze({
        a: binding.assetId,
        b: leg.side === 'BUY',
        p: formattedPrice.value,
        s: size,
        r: reduceOnly(leg.legFamily),
        t: Object.freeze({ limit: Object.freeze({ tif: 'Ioc' as const }) }),
        c: clientId,
      }),
    });
  });
  const batchStages = [...new Set(planned.map((value) => value.stage))].sort((left, right) => left - right);
  const batches = batchStages.map((stage) => {
    const orders = planned.filter((value) => value.stage === stage);
    requireCondition(orders.length > 0 && orders.length <= MAX_BATCH_ORDERS, `stage ${stage} has an invalid order count`);
    return Object.freeze({
      stage,
      action: Object.freeze({ type: 'order' as const, orders: Object.freeze(orders.map((value) => value.wire)), grouping: 'na' as const }),
      legIds: Object.freeze(orders.map((value) => value.legId)),
    });
  });
  return Object.freeze({
    version: 1,
    guarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY',
    domain,
    orderHash,
    graphHash: admission.compiledGraph.graphHash,
    quoteHash,
    routeHash,
    requestExpiryMs: route.routeExpiryValue,
    orders: Object.freeze(planned),
    batches: Object.freeze(batches),
    recoveryAuthorizations: Object.freeze(graph.recoverySlots.filter((slot) => selectedLegIds.has(slot.legId)).map((slot) => Object.freeze({
      legId: slot.legId,
      action: slot.action,
      maximumQuantityAtoms: slot.maximumQuantityAtoms,
      maximumCostQuoteAtoms: slot.maximumCostQuoteAtoms,
    }))),
    maximumRecoveryCostQuoteAtoms: graph.maximumRecoveryCostQuoteAtoms,
  });
}
