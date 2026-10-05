import type { CompiledStrategyExecution } from '@naryx/adapter-core';
import {
  bytesEqual,
  strategyPackageOrderHash,
  strategyPackageQuoteHash,
  typedStrategyRouteHash,
  type AdapterRef,
  type AdmittedStrategyPackage,
  type DomainRef,
  type PackageGraph,
  type TypedStrategyDomainPlan,
  type TypedStrategyRoute,
  type TypedStrategyRouteLeg,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import { getAddress, keccak256, type Address, type Hex } from 'viem';

export interface EvmStrategyLegCall {
  readonly legId: string;
  readonly stage: number;
  readonly materializationClassId: string;
  readonly adapter: Address;
  readonly adapterCodeHash: Hex;
  readonly gasLimit: bigint;
  readonly value: 0n;
  readonly data: Hex;
  readonly dataHash: Hex;
}

export interface EvmStrategyStage {
  readonly stage: number;
  readonly calls: readonly EvmStrategyLegCall[];
}

export interface EvmStrategyExecutionPlan {
  readonly version: 1;
  readonly planKind: 'EVM_ATOMIC_BATCH' | 'EVM_ASYNC_REQUEST';
  readonly guarantee: 'ATOMIC_POSTCONDITION' | 'BONDED_ASYNCHRONOUS';
  readonly domain: DomainRef;
  readonly strategyAccount: Address;
  readonly stages: readonly EvmStrategyStage[];
  readonly totalGasLimit: bigint;
}

export interface EvmStrategyLegMaterializationContext {
  readonly admission: AdmittedStrategyPackage;
  readonly route: TypedStrategyRoute;
  readonly graph: PackageGraph;
  readonly routeLeg: TypedStrategyRouteLeg;
}

export interface EvmStrategyLegMaterializer {
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly legFamily: PackageGraph['legs'][number]['legFamily'];
  readonly materializationClassId: string;
  readonly adapterAddress: Address;
  readonly expectedAdapterCodeHash: Hex;
  readonly maximumGasLimit: bigint;
  materialize(context: EvmStrategyLegMaterializationContext): Readonly<{
    data: Hex;
    gasLimit: bigint;
  }>;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId &&
    left.domainManifestVersion === right.domainManifestVersion &&
    bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId &&
    left.adapterManifestVersion === right.adapterManifestVersion &&
    bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameManifest(left: VersionedManifestRef, right: VersionedManifestRef): boolean {
  return left.subjectId === right.subjectId &&
    left.manifestVersion === right.manifestVersion &&
    bytesEqual(left.manifestHash, right.manifestHash);
}

function bindingFor(
  leg: PackageGraph['legs'][number],
  routeLeg: TypedStrategyRouteLeg,
  values: readonly EvmStrategyLegMaterializer[],
): EvmStrategyLegMaterializer {
  const matches = values.filter((candidate) =>
    sameDomain(candidate.domain, leg.domain) &&
    sameAdapter(candidate.adapter, leg.adapter) &&
    sameManifest(candidate.venue, leg.venue) &&
    sameManifest(candidate.market, leg.market) &&
    candidate.legFamily === leg.legFamily &&
    candidate.materializationClassId === routeLeg.materializationClassId,
  );
  requireCondition(matches.length === 1, `leg ${leg.legId} must resolve to exactly one EVM materializer`);
  return matches[0]!;
}

export function compileEvmStrategyPlan(input: Readonly<{
  admission: AdmittedStrategyPackage;
  route: TypedStrategyRoute;
  domainPlan?: TypedStrategyDomainPlan;
  strategyAccount: Address;
  materializers: readonly EvmStrategyLegMaterializer[];
}>): CompiledStrategyExecution<EvmStrategyExecutionPlan> {
  const { admission, route } = input;
  const { graph } = admission;
  const domainPlan = input.domainPlan ?? route.domainPlans[0];
  requireCondition(domainPlan !== undefined, 'EVM strategy execution requires a domain plan');
  requireCondition(route.domainPlans.some((candidate) => sameDomain(candidate.domain, domainPlan.domain)
    && candidate.executionPlanKind === domainPlan.executionPlanKind), 'EVM domain plan is not part of the route');
  if (input.domainPlan === undefined) requireCondition(route.domainPlans.length === 1, 'EVM strategy execution requires an explicit domain plan for a cross-domain route');
  requireCondition(domainPlan.executionPlanKind === 'EVM_ATOMIC_BATCH' || domainPlan.executionPlanKind === 'EVM_ASYNC_REQUEST', 'route is not an EVM strategy plan');
  const selectedLegIds = new Set(domainPlan.legIds);
  const domainLegs = graph.legs.filter((leg) => selectedLegIds.has(leg.legId));
  requireCondition(domainLegs.length > 0 && domainLegs.length === selectedLegIds.size, 'EVM domain plan does not cover known graph legs exactly once');
  requireCondition(domainLegs.every((leg) => sameDomain(leg.domain, domainPlan.domain)), 'EVM domain plan contains a leg from another domain');
  requireCondition(route.legs.filter((leg) => selectedLegIds.has(leg.legId)).length === domainLegs.length, 'route does not cover every EVM domain leg');
  if (domainPlan.executionPlanKind === 'EVM_ATOMIC_BATCH') {
    requireCondition(route.settlementClass === 'ATOMIC_POSTCONDITION' || route.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED', 'atomic EVM batches require atomic or cross-domain prepositioned settlement');
  } else {
    requireCondition(route.settlementClass === 'ASYNC_BONDED_SOLVER' || route.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED', 'asynchronous EVM requests require bonded or cross-domain prepositioned settlement');
  }
  const calls = domainLegs.map((leg): EvmStrategyLegCall => {
    const routeLeg = route.legs.find((candidate) => candidate.legId === leg.legId);
    requireCondition(routeLeg !== undefined, `route is missing leg ${leg.legId}`);
    requireCondition(routeLeg.executionPlanKind === domainPlan.executionPlanKind, `leg ${leg.legId} plan kind mismatch`);
    const materializer = bindingFor(leg, routeLeg, input.materializers);
    requireCondition(materializer.maximumGasLimit > 0n, `leg ${leg.legId} maximum gas limit is invalid`);
    const materialized = materializer.materialize({ admission, route, graph, routeLeg });
    requireCondition(materialized.gasLimit > 0n && materialized.gasLimit <= materializer.maximumGasLimit, `leg ${leg.legId} gas limit exceeds its registered bound`);
    requireCondition(/^0x[0-9a-fA-F]{8,}$/.test(materialized.data), `leg ${leg.legId} calldata is malformed`);
    return Object.freeze({
      legId: leg.legId,
      stage: routeLeg.stage,
      materializationClassId: routeLeg.materializationClassId,
      adapter: getAddress(materializer.adapterAddress),
      adapterCodeHash: materializer.expectedAdapterCodeHash,
      gasLimit: materialized.gasLimit,
      value: 0n,
      data: materialized.data,
      dataHash: keccak256(materialized.data),
    });
  });
  const stageIds = [...new Set(calls.map((call) => call.stage))].sort((left, right) => left - right);
  if (route.settlementClass !== 'CROSS_DOMAIN_PREPOSITIONED') requireCondition(stageIds.every((stage, index) => stage === index), 'EVM route stages must be contiguous from zero');
  const stages = Object.freeze(stageIds.map((stage) => Object.freeze({
    stage,
    calls: Object.freeze(calls.filter((call) => call.stage === stage).sort((left, right) => left.legId.localeCompare(right.legId))),
  })));
  const orderHash = strategyPackageOrderHash(admission.order);
  const quoteHash = strategyPackageQuoteHash(admission.quote);
  const routeHash = typedStrategyRouteHash(route);
  return Object.freeze({
    domains: Object.freeze([domainPlan.domain]),
    orderHash,
    graphHash: route.graphHash,
    quoteHash,
    routeHash,
    payload: Object.freeze({
      version: 1 as const,
      planKind: domainPlan.executionPlanKind,
      guarantee: domainPlan.executionPlanKind === 'EVM_ATOMIC_BATCH' ? 'ATOMIC_POSTCONDITION' as const : 'BONDED_ASYNCHRONOUS' as const,
      domain: domainPlan.domain,
      strategyAccount: getAddress(input.strategyAccount),
      stages,
      totalGasLimit: calls.reduce((sum, call) => sum + call.gasLimit, 0n),
    }),
  });
}
