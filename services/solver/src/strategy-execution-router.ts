import type { CompiledStrategyExecution } from '@naryx/adapter-core';
import {
  bytesEqual,
  crossDomainPlan,
  crossDomainPlanHash,
  strategyPackageOrderHash,
  strategyPackageQuoteHash,
  typedStrategyRouteHash,
  type AdmittedStrategyPackage,
  type CrossDomainPlan,
  type CrossDomainPlanInput,
  type DomainRef,
  type TypedStrategyDomainPlan,
  type TypedStrategyRoute,
} from '@naryx/protocol-types';

export interface StrategyDomainCompiler<TPayload = unknown> {
  readonly domain: DomainRef;
  readonly executionPlanKind: TypedStrategyDomainPlan['executionPlanKind'];
  compile(input: Readonly<{
    admission: AdmittedStrategyPackage;
    route: TypedStrategyRoute;
    domainPlan: TypedStrategyDomainPlan;
  }>): Promise<CompiledStrategyExecution<TPayload>>;
}

export interface CompiledStrategyDomainExecution {
  readonly domainPlan: TypedStrategyDomainPlan;
  readonly execution: CompiledStrategyExecution<unknown>;
}

export interface CompiledStrategyRouteExecution {
  readonly version: 1;
  readonly settlementClass: TypedStrategyRoute['settlementClass'];
  readonly orderHash: Uint8Array;
  readonly graphHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
  readonly domains: readonly CompiledStrategyDomainExecution[];
  readonly coordination:
    | 'SINGLE_DOMAIN_ATOMIC'
    | 'SINGLE_DOMAIN_BOUNDED_RECOVERY'
    | 'SINGLE_DOMAIN_BONDED_ASYNC'
    | 'CROSS_DOMAIN_PREPOSITIONED';
  readonly crossDomainPlan?: CrossDomainPlan;
  readonly crossDomainPlanHash?: Uint8Array;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId &&
    left.domainManifestVersion === right.domainManifestVersion &&
    bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function coordination(route: TypedStrategyRoute): CompiledStrategyRouteExecution['coordination'] {
  if (route.settlementClass === 'ATOMIC_POSTCONDITION') return 'SINGLE_DOMAIN_ATOMIC';
  if (route.settlementClass === 'BATCHED_IOC_WITH_RECOVERY') return 'SINGLE_DOMAIN_BOUNDED_RECOVERY';
  if (route.settlementClass === 'ASYNC_BONDED_SOLVER') return 'SINGLE_DOMAIN_BONDED_ASYNC';
  if (route.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED') return 'CROSS_DOMAIN_PREPOSITIONED';
  throw new Error('manual controlled recovery cannot compile as a new execution route');
}

function verifiedCrossDomainPlan(
  input: CrossDomainPlanInput | undefined,
  admission: AdmittedStrategyPackage,
  route: TypedStrategyRoute,
  orderHash: Uint8Array,
): CrossDomainPlan | undefined {
  if (route.settlementClass !== 'CROSS_DOMAIN_PREPOSITIONED') {
    requireCondition(input === undefined, 'a single-domain execution cannot carry a cross-domain plan');
    return undefined;
  }
  requireCondition(input !== undefined, 'cross-domain prepositioned settlement requires its coordination plan');
  const plan = crossDomainPlan(input);
  requireCondition(plan.environment === admission.order.environment, 'cross-domain plan environment mismatch');
  requireCondition(bytesEqual(plan.orderHash, orderHash), 'cross-domain plan does not bind the admitted order');
  requireCondition(plan.timeUnit === route.routeExpiryUnit && plan.commitDeadline <= route.routeExpiryValue, 'cross-domain plan outlives the selected route');
  requireCondition(plan.legs.length === route.domainPlans.length, 'cross-domain plan does not cover every route domain');
  for (const domainPlan of route.domainPlans) {
    const planned = plan.legs.find((candidate) => sameDomain(candidate.domain, domainPlan.domain));
    requireCondition(planned !== undefined, `cross-domain plan is missing ${domainPlan.domain.domainId}`);
    requireCondition(planned.legIds.length === domainPlan.legIds.length
      && planned.legIds.every((legId, index) => legId === domainPlan.legIds[index]), `cross-domain plan leg set differs for ${domainPlan.domain.domainId}`);
  }
  return plan;
}

export async function compileStrategyRouteExecution(input: Readonly<{
  admission: AdmittedStrategyPackage;
  route: TypedStrategyRoute;
  compilers: readonly StrategyDomainCompiler[];
  crossDomainPlan?: CrossDomainPlanInput;
}>): Promise<CompiledStrategyRouteExecution> {
  const { admission, route } = input;
  const orderHash = strategyPackageOrderHash(admission.order);
  const quoteHash = strategyPackageQuoteHash(admission.quote);
  const routeHash = typedStrategyRouteHash(route);
  requireCondition(bytesEqual(route.orderHash, orderHash), 'route does not bind the admitted order');
  requireCondition(bytesEqual(route.graphHash, admission.compiledGraph.graphHash), 'route does not bind the admitted graph');
  requireCondition(bytesEqual(admission.quote.routeHash, routeHash), 'quote does not bind the selected route');
  requireCondition(route.domainPlans.length > 0, 'route contains no domain plans');
  if (route.settlementClass !== 'CROSS_DOMAIN_PREPOSITIONED') {
    requireCondition(route.domainPlans.length === 1, 'only cross-domain prepositioned settlement may span consensus domains');
  }
  const coordinationPlan = verifiedCrossDomainPlan(input.crossDomainPlan, admission, route, orderHash);
  const executions = await Promise.all(route.domainPlans.map(async (domainPlan): Promise<CompiledStrategyDomainExecution> => {
    const matches = input.compilers.filter((compiler) =>
      compiler.executionPlanKind === domainPlan.executionPlanKind && sameDomain(compiler.domain, domainPlan.domain),
    );
    requireCondition(matches.length === 1, `domain ${domainPlan.domain.domainId} must resolve to exactly one strategy compiler`);
    const execution = await matches[0]!.compile({ admission, route, domainPlan });
    requireCondition(execution.domains.length === 1 && sameDomain(execution.domains[0]!, domainPlan.domain), `domain ${domainPlan.domain.domainId} compiler returned another domain`);
    requireCondition(bytesEqual(execution.orderHash, orderHash), `domain ${domainPlan.domain.domainId} order hash mismatch`);
    requireCondition(bytesEqual(execution.graphHash, route.graphHash), `domain ${domainPlan.domain.domainId} graph hash mismatch`);
    requireCondition(bytesEqual(execution.quoteHash, quoteHash), `domain ${domainPlan.domain.domainId} quote hash mismatch`);
    requireCondition(bytesEqual(execution.routeHash, routeHash), `domain ${domainPlan.domain.domainId} route hash mismatch`);
    return Object.freeze({ domainPlan, execution });
  }));
  return Object.freeze({
    version: 1 as const,
    settlementClass: route.settlementClass,
    orderHash,
    graphHash: route.graphHash,
    quoteHash,
    routeHash,
    domains: Object.freeze(executions.sort((left, right) => left.domainPlan.domain.domainId.localeCompare(right.domainPlan.domain.domainId))),
    coordination: coordination(route),
    ...(coordinationPlan === undefined ? {} : {
      crossDomainPlan: coordinationPlan,
      crossDomainPlanHash: crossDomainPlanHash(input.crossDomainPlan!),
    }),
  });
}
