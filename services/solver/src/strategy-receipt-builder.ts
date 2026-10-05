import {
  bytesEqual,
  strategyPackageOrderHash,
  strategyPackageQuoteHash,
  strategyPackageReceipt,
  typedStrategyRouteHash,
  type AdmittedStrategyRoute,
  type AssetAmount,
  type FinalityStatus,
  type StrategyLegOutcomeInput,
  type StrategyPackageReceipt,
  type TerminalState,
} from '@naryx/protocol-types';

export interface StrategyReceiptBuildInput {
  readonly admission: AdmittedStrategyRoute;
  readonly terminalState: TerminalState;
  readonly legOutcomes: readonly StrategyLegOutcomeInput[];
  readonly serviceFee: AssetAmount;
  readonly solverFee: AssetAmount;
  readonly venueFees: AssetAmount;
  readonly networkCost: AssetAmount;
  readonly recoveryCost: AssetAmount;
  readonly terminalResidualValue: AssetAmount;
  readonly finalityStatus: FinalityStatus;
  readonly executedAtValue: bigint;
  readonly receiptNonce: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameDomain(left: StrategyLegOutcomeInput['domain'], right: StrategyLegOutcomeInput['domain']): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function quotedServiceCharge(admission: AdmittedStrategyRoute, categories: readonly ('PROTOCOL' | 'SOLVER' | 'BUILDER')[]): bigint {
  return admission.quote.serviceCharges
    .filter((charge) => categories.includes(charge.category))
    .reduce((sum, charge) => sum + charge.amount.atoms, 0n);
}

function quotedPassThroughCost(admission: AdmittedStrategyRoute, category: 'VENUE' | 'NETWORK' | 'RECOVERY'): bigint {
  return admission.quote.passThroughCosts.find((cost) => cost.category === category)?.amount.atoms ?? 0n;
}

/** Builds the canonical package receipt from the admitted order, quote, route, and reconciled leg evidence. */
export function buildStrategyPackageReceipt(input: StrategyReceiptBuildInput): StrategyPackageReceipt {
  const { admission } = input;
  const routeHash = typedStrategyRouteHash(admission.route);
  requireCondition(bytesEqual(admission.quote.routeHash, routeHash), 'the selected quote does not bind the admitted route');
  const graphLegs = [...admission.graph.legs].sort((left, right) => left.legId.localeCompare(right.legId));
  const outcomes = [...input.legOutcomes].sort((left, right) => left.legId.localeCompare(right.legId));
  requireCondition(outcomes.length === graphLegs.length, 'execution evidence must report every graph leg');
  for (let index = 0; index < graphLegs.length; index += 1) {
    const graphLeg = graphLegs[index]!;
    const outcome = outcomes[index]!;
    requireCondition(outcome.legId === graphLeg.legId, `execution evidence is missing graph leg ${graphLeg.legId}`);
    requireCondition(sameDomain(outcome.domain, graphLeg.domain), `execution evidence for ${graphLeg.legId} uses another domain`);
    requireCondition(
      outcome.requestedQuantity.asset.assetId === graphLeg.quantityAsset.assetId
        && outcome.requestedQuantity.asset.decimals === graphLeg.quantityAsset.decimals
        && bytesEqual(outcome.requestedQuantity.asset.assetManifestHash, graphLeg.quantityAsset.assetManifestHash)
        && outcome.requestedQuantity.atoms === graphLeg.quantityAtoms,
      `execution evidence for ${graphLeg.legId} does not bind the requested quantity`,
    );
  }
  requireCondition(input.serviceFee.atoms <= quotedServiceCharge(admission, ['PROTOCOL', 'BUILDER']), 'service fee exceeds the signed quote');
  requireCondition(input.solverFee.atoms <= quotedServiceCharge(admission, ['SOLVER']), 'solver fee exceeds the signed quote');
  requireCondition(input.venueFees.atoms <= quotedPassThroughCost(admission, 'VENUE'), 'venue fees exceed the signed quote');
  requireCondition(input.networkCost.atoms <= quotedPassThroughCost(admission, 'NETWORK'), 'network cost exceeds the signed quote');
  requireCondition(input.recoveryCost.atoms <= quotedPassThroughCost(admission, 'RECOVERY'), 'recovery cost exceeds the signed quote');
  return strategyPackageReceipt({
    version: 1,
    environment: admission.order.environment,
    domains: admission.route.domainPlans.map((plan) => plan.domain),
    orderHash: strategyPackageOrderHash(admission.order),
    graphHash: admission.compiledGraph.graphHash,
    quoteHash: strategyPackageQuoteHash(admission.quote),
    routeHash,
    templateId: admission.order.templateId,
    templateVersion: admission.order.templateVersion,
    packageTemplateManifestHash: admission.order.packageTemplateManifestHash,
    seriesId: admission.order.seriesId,
    seriesVersion: admission.order.seriesVersion,
    seriesManifestHash: admission.order.seriesManifestHash,
    executionClassId: admission.order.executionClassId,
    executionClassVersion: admission.order.executionClassVersion,
    executionClassManifestHash: admission.order.executionClassManifestHash,
    lifecycleAction: admission.order.lifecycleAction,
    owner: admission.order.owner,
    solverId: admission.quote.solverId,
    settlementClass: admission.order.settlementClass,
    terminalState: input.terminalState,
    quoteAsset: admission.order.quoteAsset,
    legOutcomes: outcomes,
    serviceFee: input.serviceFee,
    solverFee: input.solverFee,
    venueFees: input.venueFees,
    networkCost: input.networkCost,
    recoveryCost: input.recoveryCost,
    terminalResidualValue: input.terminalResidualValue,
    finalityStatus: input.finalityStatus,
    executedAtValue: input.executedAtValue,
    receiptNonce: input.receiptNonce,
  });
}
