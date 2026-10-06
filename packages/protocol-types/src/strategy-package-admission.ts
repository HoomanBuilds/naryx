import { compareBytes } from './bytes.js';
import { MalformedInputError } from './errors.js';
import {
  compilePackageGraph,
  packageGraph,
  type CompiledPackageGraph,
  type PackageGraph,
  type PackageGraphCompileContext,
  type PackageGraphInput,
} from './package-graph.js';
import type { FeeCap } from './package-order-primitives.js';
import type { AssetRef, DomainRef } from './primitives.js';
import {
  strategyPackageOrder,
  strategyPackageOrderHash,
  type StrategyMetricLimit,
  type StrategyPackageOrder,
  type StrategyPackageOrderInput,
} from './strategy-package-order.js';
import {
  strategyPackageQuote,
  type StrategyPackageQuote,
  type StrategyPackageQuoteInput,
  type StrategyQuoteMetric,
} from './strategy-package-quote.js';
import { validateStrategyTemplateGraph } from './strategy-template-program.js';
import {
  typedStrategyRouteHash,
  type TypedStrategyRoute,
} from './typed-strategy-route.js';

export interface AdmittedStrategyPackage {
  readonly order: StrategyPackageOrder;
  readonly quote: StrategyPackageQuote;
  readonly graph: PackageGraph;
  readonly compiledGraph: CompiledPackageGraph;
}

export interface ValidatedStrategyPackageOrder {
  readonly order: StrategyPackageOrder;
  readonly graph: PackageGraph;
  readonly compiledGraph: CompiledPackageGraph;
}

export interface AdmittedStrategyRoute extends AdmittedStrategyPackage {
  readonly route: TypedStrategyRoute;
}

function requireCondition(condition: boolean, context: string, message: string): asserts condition {
  if (!condition) throw new MalformedInputError(context, message);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && compareBytes(left.assetManifestHash, right.assetManifestHash) === 0;
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && compareBytes(left.domainManifestHash, right.domainManifestHash) === 0;
}

function executionPriceSatisfiesLimit(
  side: 'BUY' | 'SELL' | 'NONE',
  execution: NonNullable<StrategyPackageQuote['legEconomics'][number]['executionPrice']>,
  limit: NonNullable<PackageGraph['legs'][number]['limitPrice']>,
): boolean {
  if (!sameAsset(execution.baseAsset, limit.baseAsset) || !sameAsset(execution.quoteAsset, limit.quoteAsset)) return false;
  const left = execution.quoteAtoms * limit.baseAtoms;
  const right = limit.quoteAtoms * execution.baseAtoms;
  return side === 'BUY' ? left <= right : side === 'SELL' ? left >= right : left === right;
}

function capFor(caps: readonly FeeCap[], asset: AssetRef): bigint {
  return caps.find((value) => sameAsset(value.asset, asset))?.maxAtoms ?? 0n;
}

function metricSatisfies(limit: StrategyMetricLimit, metric: StrategyQuoteMetric): boolean {
  if (limit.scale !== metric.scale || limit.unitId !== metric.unitId) return false;
  if (limit.comparator === 'EQ') return metric.value === limit.value;
  if (limit.comparator === 'LTE') return metric.value <= limit.value;
  return metric.value >= limit.value;
}

export function validateStrategyPackageAdmission(
  orderInput: StrategyPackageOrderInput,
  graphInput: PackageGraphInput,
  quoteInput: StrategyPackageQuoteInput,
  compileContext: PackageGraphCompileContext,
): AdmittedStrategyPackage {
  const context = 'validateStrategyPackageAdmission';
  const validated = validateStrategyPackageOrderGraph(orderInput, graphInput, compileContext, context);
  const { order, graph, compiledGraph: compiled } = validated;
  const quote = strategyPackageQuote(quoteInput, `${context}.quote`);
  requireCondition(compareBytes(quote.graphHash, compiled.graphHash) === 0, `${context}.quote.graphHash`, 'quote does not bind the compiled graph');
  requireCondition(compareBytes(quote.orderHash, strategyPackageOrderHash(orderInput)) === 0, `${context}.quote.orderHash`, 'quote does not bind the order');
  requireCondition(order.environment === graph.environment && quote.environment === graph.environment, `${context}.environment`, 'environment mismatch');
  requireCondition(order.templateId === graph.templateId && quote.templateId === graph.templateId, `${context}.templateId`, 'template mismatch');
  requireCondition(order.templateVersion === graph.templateVersion && quote.templateVersion === graph.templateVersion, `${context}.templateVersion`, 'template version mismatch');
  requireCondition(compareBytes(order.packageTemplateManifestHash, graph.packageTemplateManifestHash) === 0, `${context}.order.packageTemplateManifestHash`, 'order template manifest mismatch');
  requireCondition(compareBytes(quote.packageTemplateManifestHash, graph.packageTemplateManifestHash) === 0, `${context}.quote.packageTemplateManifestHash`, 'quote template manifest mismatch');
  requireCondition(order.seriesId === graph.seriesId && quote.seriesId === graph.seriesId, `${context}.seriesId`, 'series mismatch');
  requireCondition(order.seriesVersion === graph.seriesVersion && quote.seriesVersion === graph.seriesVersion, `${context}.seriesVersion`, 'series version mismatch');
  requireCondition(compareBytes(order.seriesManifestHash, graph.seriesManifestHash) === 0 && compareBytes(quote.seriesManifestHash, graph.seriesManifestHash) === 0, `${context}.seriesManifestHash`, 'series manifest mismatch');
  requireCondition(order.executionClassId === graph.executionClassId && quote.executionClassId === graph.executionClassId, `${context}.executionClassId`, 'execution class mismatch');
  requireCondition(order.executionClassVersion === graph.executionClassVersion && quote.executionClassVersion === graph.executionClassVersion, `${context}.executionClassVersion`, 'execution class version mismatch');
  requireCondition(compareBytes(order.executionClassManifestHash, graph.executionClassManifestHash) === 0 && compareBytes(quote.executionClassManifestHash, graph.executionClassManifestHash) === 0, `${context}.executionClassManifestHash`, 'execution class manifest mismatch');
  requireCondition(order.lifecycleAction === graph.lifecycleAction, `${context}.order.lifecycleAction`, 'lifecycle action mismatch');
  requireCondition(order.settlementClass === graph.settlementClass && quote.settlementClass === graph.settlementClass, `${context}.settlementClass`, 'settlement class mismatch');
  requireCondition(order.quoteConventionId === quote.quoteConventionId, `${context}.quote.quoteConventionId`, 'quote convention mismatch');
  requireCondition(order.riskClassId === quote.riskClassId, `${context}.quote.riskClassId`, 'risk class mismatch');
  requireCondition(sameAsset(order.quoteAsset, quote.quoteAsset), `${context}.quote.quoteAsset`, 'quote asset mismatch');
  requireCondition(order.expiryUnit === quote.validUntilUnit, `${context}.quote.validUntilUnit`, 'quote and order clocks differ');
  requireCondition(quote.validUntilValue <= order.expiryValue, `${context}.quote.validUntilValue`, 'quote outlives the order');
  const graphDomains = graph.legs.reduce<DomainRef[]>((domains, leg) => {
    if (!domains.some((domain) => sameDomain(domain, leg.domain))) domains.push(leg.domain);
    return domains;
  }, []).sort((left, right) => left.domainId.localeCompare(right.domainId));
  requireCondition(graphDomains.length === quote.domains.length && graphDomains.every((value, index) => sameDomain(value, quote.domains[index]!)), `${context}.quote.domains`, 'quote domains do not match the graph');
  const graphLegIds = graph.legs.map((leg) => leg.legId).sort();
  const quoteLegIds = quote.legEconomics.map((leg) => leg.legId);
  requireCondition(graphLegIds.length === quoteLegIds.length && graphLegIds.every((value, index) => value === quoteLegIds[index]), `${context}.quote.legEconomics`, 'quote must price every graph leg exactly once');
  for (const graphLeg of graph.legs) {
    const economics = quote.legEconomics.find((leg) => leg.legId === graphLeg.legId)!;
    requireCondition(sameAsset(economics.quantity.asset, graphLeg.quantityAsset) && economics.quantity.atoms === graphLeg.quantityAtoms, `${context}.quote.legEconomics`, `quoted quantity differs for ${graphLeg.legId}`);
    if (graphLeg.limitPrice !== undefined) {
      requireCondition(economics.executionPrice !== undefined && executionPriceSatisfiesLimit(graphLeg.side, economics.executionPrice, graphLeg.limitPrice), `${context}.quote.legEconomics`, `quoted execution price violates the limit for ${graphLeg.legId}`);
    }
  }
  for (const limit of order.metricLimits) {
    const metric = quote.metrics.find((value) => value.metricId === limit.metricId);
    requireCondition(metric !== undefined && metricSatisfies(limit, metric), `${context}.quote.metrics`, `metric ${limit.metricId} violates the signed limit`);
  }
  const gross = quote.legEconomics.reduce((sum, value) => sum + value.grossNotional.atoms, 0n);
  const margin = quote.legEconomics.reduce((sum, value) => sum + value.marginDelta.atoms, 0n);
  const residual = quote.legEconomics.reduce((sum, value) => sum + value.residualValue.atoms, 0n);
  requireCondition(gross === quote.totalGrossNotional.atoms, `${context}.quote.totalGrossNotional`, 'total does not equal leg gross notionals');
  requireCondition(margin === quote.totalMarginDelta.atoms, `${context}.quote.totalMarginDelta`, 'total does not equal leg margin deltas');
  requireCondition(residual === quote.totalResidualValue.atoms, `${context}.quote.totalResidualValue`, 'total does not equal leg residual values');
  requireCondition(quote.totalMarginDelta.atoms <= order.maximumMarginIncrease.atoms, `${context}.quote.totalMarginDelta`, 'margin increase exceeds the signed cap');
  requireCondition(quote.totalResidualValue.atoms <= order.maximumResidualValue.atoms, `${context}.quote.totalResidualValue`, 'residual exceeds the signed cap');
  const service = quote.serviceCharges.reduce((sum, value) => sum + value.amount.atoms, 0n);
  requireCondition(service <= capFor(order.maximumServiceFeesByAsset, quote.quoteAsset), `${context}.quote.serviceCharges`, 'service charges exceed the signed cap');
  const quotedBuilderFee = quote.serviceCharges.find((charge) => charge.category === 'BUILDER')?.amount.atoms ?? 0n;
  const legBuilderFee = quote.legEconomics.reduce((sum, leg) => sum + leg.builderFee.atoms, 0n);
  requireCondition(legBuilderFee === quotedBuilderFee, `${context}.quote.serviceCharges`, 'builder charge does not equal the leg builder fees');
  const quotedVenueFee = quote.passThroughCosts.find((cost) => cost.category === 'VENUE')?.amount.atoms ?? 0n;
  const legVenueFee = quote.legEconomics.reduce((sum, leg) => sum + leg.venueFee.atoms, 0n);
  requireCondition(legVenueFee === quotedVenueFee, `${context}.quote.passThroughCosts`, 'venue cost does not equal the leg venue fees');
  for (const cost of quote.passThroughCosts) {
    const caps = cost.category === 'VENUE'
      ? order.maximumVenueFeesByAsset
      : cost.category === 'NETWORK'
        ? order.maximumNetworkFeesByAsset
        : order.maximumRecoveryCostByAsset;
    requireCondition(cost.amount.atoms <= capFor(caps, quote.quoteAsset), `${context}.quote.passThroughCosts`, `${cost.category} cost exceeds the signed cap`);
  }
  return Object.freeze({ order, quote, graph, compiledGraph: compiled });
}

export function validateStrategyPackageOrderGraph(
  orderInput: StrategyPackageOrderInput,
  graphInput: PackageGraphInput,
  compileContext: PackageGraphCompileContext,
  context = 'validateStrategyPackageOrderGraph',
): ValidatedStrategyPackageOrder {
  const order = strategyPackageOrder(orderInput, `${context}.order`);
  const graph = packageGraph(graphInput, `${context}.graph`);
  const templateValidation = validateStrategyTemplateGraph(graphInput);
  requireCondition(templateValidation.valid, `${context}.graph`, `template graph is invalid: ${templateValidation.valid ? '' : templateValidation.reasons.join(',')}`);
  const compiled = compilePackageGraph(graphInput, compileContext);
  requireCondition(compiled.compiled, `${context}.graph`, `graph compilation failed: ${compiled.compiled ? '' : compiled.reasons.join(',')}`);
  requireCondition(compareBytes(order.graphHash, compiled.graphHash) === 0, `${context}.order.graphHash`, 'order does not bind the compiled graph');
  requireCondition(order.environment === graph.environment, `${context}.environment`, 'environment mismatch');
  requireCondition(order.templateId === graph.templateId && order.templateVersion === graph.templateVersion, `${context}.templateId`, 'template mismatch');
  requireCondition(compareBytes(order.packageTemplateManifestHash, graph.packageTemplateManifestHash) === 0, `${context}.order.packageTemplateManifestHash`, 'template manifest mismatch');
  requireCondition(order.seriesId === graph.seriesId && order.seriesVersion === graph.seriesVersion, `${context}.seriesId`, 'series mismatch');
  requireCondition(compareBytes(order.seriesManifestHash, graph.seriesManifestHash) === 0, `${context}.order.seriesManifestHash`, 'series manifest mismatch');
  requireCondition(order.executionClassId === graph.executionClassId && order.executionClassVersion === graph.executionClassVersion, `${context}.executionClassId`, 'execution class mismatch');
  requireCondition(compareBytes(order.executionClassManifestHash, graph.executionClassManifestHash) === 0, `${context}.order.executionClassManifestHash`, 'execution class manifest mismatch');
  requireCondition(order.owner === graph.owner, `${context}.owner`, 'owner mismatch');
  requireCondition(order.lifecycleAction === graph.lifecycleAction, `${context}.lifecycleAction`, 'lifecycle action mismatch');
  requireCondition(order.settlementClass === graph.settlementClass, `${context}.settlementClass`, 'settlement class mismatch');
  requireCondition(order.expiryUnit === graph.expiryUnit && order.expiryValue <= graph.packageExpiryValue, `${context}.expiryValue`, 'order expiry is outside the graph expiry');
  return Object.freeze({ order, graph, compiledGraph: compiled });
}

export function validateStrategyPackageRouteAdmission(
  orderInput: StrategyPackageOrderInput,
  graphInput: PackageGraphInput,
  quoteInput: StrategyPackageQuoteInput,
  route: TypedStrategyRoute,
  compileContext: PackageGraphCompileContext,
): AdmittedStrategyRoute {
  const context = 'validateStrategyPackageRouteAdmission';
  const admitted = validateStrategyPackageAdmission(orderInput, graphInput, quoteInput, compileContext);
  requireCondition(route.version === 1, `${context}.route.version`, 'unsupported route version');
  requireCondition(route.environment === admitted.graph.environment, `${context}.route.environment`, 'route environment mismatch');
  requireCondition(compareBytes(route.orderHash, strategyPackageOrderHash(admitted.order)) === 0, `${context}.route.orderHash`, 'route does not bind the order');
  requireCondition(compareBytes(route.graphHash, admitted.compiledGraph.graphHash) === 0, `${context}.route.graphHash`, 'route does not bind the compiled graph');
  requireCondition(compareBytes(admitted.quote.routeHash, typedStrategyRouteHash(route)) === 0, `${context}.quote.routeHash`, 'quote does not bind the route');
  requireCondition(route.solverId === admitted.quote.solverId, `${context}.route.solverId`, 'route solver mismatch');
  requireCondition(route.settlementClass === admitted.graph.settlementClass, `${context}.route.settlementClass`, 'route settlement class mismatch');
  requireCondition(route.routeExpiryUnit === admitted.order.expiryUnit, `${context}.route.routeExpiryUnit`, 'route and order clocks differ');
  requireCondition(route.routeExpiryValue <= admitted.order.expiryValue && route.routeExpiryValue <= admitted.quote.validUntilValue, `${context}.route.routeExpiryValue`, 'route outlives the signed order or quote');
  const graphLegs = [...admitted.graph.legs].sort((left, right) => left.legId.localeCompare(right.legId));
  const routeLegs = [...route.legs].sort((left, right) => left.legId.localeCompare(right.legId));
  requireCondition(graphLegs.length === routeLegs.length, `${context}.route.legs`, 'route leg count mismatch');
  for (let index = 0; index < graphLegs.length; index += 1) {
    const graphLeg = graphLegs[index]!;
    const routeLeg = routeLegs[index]!;
    requireCondition(routeLeg.legId === graphLeg.legId, `${context}.route.legs[${index}]`, 'route leg identity mismatch');
    requireCondition(routeLeg.legFamily === graphLeg.legFamily, `${context}.route.legs[${index}]`, 'route leg family mismatch');
    requireCondition(sameDomain(routeLeg.domain, graphLeg.domain), `${context}.route.legs[${index}]`, 'route leg domain mismatch');
    requireCondition(routeLeg.adapter.adapterId === graphLeg.adapter.adapterId
      && routeLeg.adapter.adapterManifestVersion === graphLeg.adapter.adapterManifestVersion
      && compareBytes(routeLeg.adapter.adapterManifestHash, graphLeg.adapter.adapterManifestHash) === 0, `${context}.route.legs[${index}]`, 'route leg adapter mismatch');
  }
  return Object.freeze({ ...admitted, route });
}
