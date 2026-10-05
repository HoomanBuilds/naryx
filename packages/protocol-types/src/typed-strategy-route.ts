import { checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  EXECUTION_PLAN_KIND,
  EXPIRY_UNIT,
  SETTLEMENT_CLASS,
  type ExecutionPlanKind,
  type ExpiryUnit,
  type SettlementClass,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  compilePackageGraph,
  packageGraph,
  packageGraphHash,
  type CompiledPackageGraph,
  type LegFamily,
  type PackageGraphCompileContext,
  type PackageGraphInput,
} from './package-graph.js';
import {
  adapterRef,
  commitmentHash,
  encodeAdapterRef,
  encodeCommitmentHash,
  type AdapterRef,
  type AdapterRefInput,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  domainRef,
  encodeDomainRef,
  encodeProtocolId,
  protocolId,
  type DomainRef,
  type ProtocolId,
} from './primitives.js';
import { validateStrategyTemplateGraph } from './strategy-template-program.js';

export const TYPED_STRATEGY_ROUTE_VERSION = 1;
export const TYPED_ROUTE_MAX_ADAPTER_SUPPORT = 256;
const U64_BITS = 64;

export interface TypedAdapterActionSupportInput {
  readonly domain: DomainRef;
  readonly adapter: AdapterRefInput;
  readonly legFamily: LegFamily;
  readonly materializationClassId: string;
  readonly executionPlanKind: ExecutionPlanKind;
  readonly supportedSettlementClasses: readonly SettlementClass[];
}

export interface TypedAdapterActionSupport {
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly legFamily: LegFamily;
  readonly materializationClassId: ProtocolId;
  readonly executionPlanKind: ExecutionPlanKind;
  readonly supportedSettlementClasses: readonly SettlementClass[];
}

export interface TypedStrategyRouteLeg {
  readonly legId: ProtocolId;
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly legFamily: LegFamily;
  readonly materializationClassId: ProtocolId;
  readonly executionPlanKind: ExecutionPlanKind;
  readonly stage: number;
  readonly groupId?: ProtocolId;
}

export interface TypedStrategyDomainPlan {
  readonly domain: DomainRef;
  readonly executionPlanKind: ExecutionPlanKind;
  readonly legIds: readonly ProtocolId[];
  readonly stageCount: number;
}

export interface TypedStrategyRoute {
  readonly version: 1;
  readonly environment: ProtocolId;
  readonly orderHash: CommitmentHash;
  readonly graphHash: CommitmentHash;
  readonly solverId: ProtocolId;
  readonly settlementClass: SettlementClass;
  readonly legs: readonly TypedStrategyRouteLeg[];
  readonly domainPlans: readonly TypedStrategyDomainPlan[];
  readonly routeExpiryUnit: ExpiryUnit;
  readonly routeExpiryValue: bigint;
}

export type TypedStrategyRouteRejection =
  | 'GRAPH_INVALID'
  | 'GRAPH_COMPILE_FAILED'
  | 'ADAPTER_ACTION_UNSUPPORTED'
  | 'SETTLEMENT_CLASS_UNSUPPORTED'
  | 'MIXED_PLAN_KIND_IN_DOMAIN';

export type TypedStrategyRouteCompileResult =
  | Readonly<{ compiled: true; graph: CompiledPackageGraph; route: TypedStrategyRoute; routeHash: CommitmentHash }>
  | Readonly<{ compiled: false; reasons: readonly TypedStrategyRouteRejection[] }>;

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && compareBytes(left.domainManifestHash, right.domainManifestHash) === 0;
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && compareBytes(left.adapterManifestHash, right.adapterManifestHash) === 0;
}

function checkedSupport(values: readonly TypedAdapterActionSupportInput[]): readonly TypedAdapterActionSupport[] {
  if (!Array.isArray(values) || values.length > TYPED_ROUTE_MAX_ADAPTER_SUPPORT) {
    throw new MalformedInputError('compileTypedStrategyRoute.adapterSupport', `expected at most ${TYPED_ROUTE_MAX_ADAPTER_SUPPORT} records`);
  }
  const checked = values.map((value, index) => {
    const context = `compileTypedStrategyRoute.adapterSupport[${index}]`;
    object(value, context);
    object(value.domain, `${context}.domain`);
    if (!Array.isArray(value.supportedSettlementClasses) || value.supportedSettlementClasses.length === 0) {
      throw new MalformedInputError(`${context}.supportedSettlementClasses`, 'expected a nonempty array');
    }
    const settlement = [...value.supportedSettlementClasses].sort();
    for (let settlementIndex = 0; settlementIndex < settlement.length; settlementIndex += 1) {
      enumDiscriminant(SETTLEMENT_CLASS, settlement[settlementIndex]!, `${context}.supportedSettlementClasses[${settlementIndex}]`);
      if (settlementIndex > 0 && settlement[settlementIndex - 1] === settlement[settlementIndex]) {
        throw new DuplicateElementError(`${context}.supportedSettlementClasses`, 'settlement class repeats');
      }
    }
    enumDiscriminant(EXECUTION_PLAN_KIND, value.executionPlanKind, `${context}.executionPlanKind`);
    return Object.freeze({
      domain: domainRef(value.domain.domainId, value.domain.domainManifestVersion, value.domain.domainManifestHash, `${context}.domain`),
      adapter: adapterRef(value.adapter, `${context}.adapter`),
      legFamily: value.legFamily,
      materializationClassId: protocolId(value.materializationClassId, `${context}.materializationClassId`),
      executionPlanKind: value.executionPlanKind,
      supportedSettlementClasses: Object.freeze(settlement),
    });
  });
  return Object.freeze(checked);
}

function encodeRouteLeg(writer: CanonicalWriter, value: TypedStrategyRouteLeg): void {
  encodeProtocolId(writer, value.legId, 'legId');
  encodeDomainRef(writer, value.domain);
  encodeAdapterRef(writer, value.adapter);
  writer.writeString(value.legFamily, 'legFamily');
  encodeProtocolId(writer, value.materializationClassId, 'materializationClassId');
  writer.writeEnum(EXECUTION_PLAN_KIND, value.executionPlanKind, 'executionPlanKind');
  writer.writeU32(value.stage, 'stage');
  writer.writeOptional(value.groupId, (element, groupId) => encodeProtocolId(element, groupId, 'groupId'), 'groupId');
}

function encodeDomainPlan(writer: CanonicalWriter, value: TypedStrategyDomainPlan): void {
  encodeDomainRef(writer, value.domain);
  writer.writeEnum(EXECUTION_PLAN_KIND, value.executionPlanKind, 'executionPlanKind');
  writer.writeArray(value.legIds, (element, legId) => encodeProtocolId(element, legId, 'legId'), 'legIds');
  writer.writeU32(value.stageCount, 'stageCount');
}

export function typedStrategyRouteBytes(value: TypedStrategyRoute): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(value.version, 'version');
    encodeProtocolId(writer, value.environment, 'environment');
    encodeCommitmentHash(writer, value.orderHash, 'orderHash');
    encodeCommitmentHash(writer, value.graphHash, 'graphHash');
    encodeProtocolId(writer, value.solverId, 'solverId');
    writer.writeEnum(SETTLEMENT_CLASS, value.settlementClass, 'settlementClass');
    writer.writeArray(value.legs, encodeRouteLeg, 'legs');
    writer.writeArray(value.domainPlans, encodeDomainPlan, 'domainPlans');
    writer.writeEnum(EXPIRY_UNIT, value.routeExpiryUnit, 'routeExpiryUnit');
    writer.writeU64(value.routeExpiryValue, 'routeExpiryValue');
  });
}

export function typedStrategyRouteHash(value: TypedStrategyRoute): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.STRATEGY_ROUTE, typedStrategyRouteBytes(value)), 'typedStrategyRouteHash');
}

export function compileTypedStrategyRoute(input: Readonly<{
  graph: PackageGraphInput;
  compileContext: PackageGraphCompileContext;
  adapterSupport: readonly TypedAdapterActionSupportInput[];
  orderHash: Uint8Array | string;
  solverId: string;
  routeExpiryUnit: ExpiryUnit;
  routeExpiryValue: bigint;
}>): TypedStrategyRouteCompileResult {
  const graph = packageGraph(input.graph, 'compileTypedStrategyRoute.graph');
  const reasons = new Set<TypedStrategyRouteRejection>();
  const template = validateStrategyTemplateGraph(input.graph);
  if (!template.valid) reasons.add('GRAPH_INVALID');
  const compiled = compilePackageGraph(input.graph, input.compileContext);
  if (!compiled.compiled) reasons.add('GRAPH_COMPILE_FAILED');
  const support = checkedSupport(input.adapterSupport);
  const routeExpiryValue = checkedUnsigned(input.routeExpiryValue, U64_BITS, 'compileTypedStrategyRoute.routeExpiryValue');
  if (input.routeExpiryUnit !== graph.expiryUnit || routeExpiryValue === 0n || routeExpiryValue > graph.packageExpiryValue) {
    throw new MalformedInputError('compileTypedStrategyRoute.routeExpiryValue', 'route expiry must use the graph clock and not outlive the graph');
  }
  const legs: TypedStrategyRouteLeg[] = [];
  for (const leg of graph.legs) {
    const found = support.find((candidate) =>
      sameDomain(candidate.domain, leg.domain)
      && sameAdapter(candidate.adapter, leg.adapter)
      && candidate.legFamily === leg.legFamily,
    );
    if (found === undefined) {
      reasons.add('ADAPTER_ACTION_UNSUPPORTED');
      continue;
    }
    if (!found.supportedSettlementClasses.includes(graph.settlementClass)) reasons.add('SETTLEMENT_CLASS_UNSUPPORTED');
    const stage = graph.stages.findIndex((values) => values.includes(leg.legId));
    const group = graph.executionGroups.find((value) => value.legIds.includes(leg.legId));
    legs.push(Object.freeze({
      legId: leg.legId,
      domain: leg.domain,
      adapter: leg.adapter,
      legFamily: leg.legFamily,
      materializationClassId: found.materializationClassId,
      executionPlanKind: found.executionPlanKind,
      stage,
      ...(group === undefined ? {} : { groupId: group.groupId }),
    }));
  }
  const domainPlans: TypedStrategyDomainPlan[] = [];
  for (const domain of [...new Map(graph.legs.map((leg) => [leg.domain.domainId, leg.domain])).values()].sort((left, right) => left.domainId.localeCompare(right.domainId))) {
    const domainLegs = legs.filter((leg) => sameDomain(leg.domain, domain));
    const kinds = [...new Set(domainLegs.map((leg) => leg.executionPlanKind))];
    if (kinds.length !== 1) {
      reasons.add('MIXED_PLAN_KIND_IN_DOMAIN');
      continue;
    }
    domainPlans.push(Object.freeze({
      domain,
      executionPlanKind: kinds[0]!,
      legIds: Object.freeze(domainLegs.map((leg) => leg.legId).sort()),
      stageCount: new Set(domainLegs.map((leg) => leg.stage)).size,
    }));
  }
  if (!compiled.compiled || reasons.size > 0) return Object.freeze({ compiled: false as const, reasons: Object.freeze([...reasons].sort()) });
  const route: TypedStrategyRoute = Object.freeze({
    version: TYPED_STRATEGY_ROUTE_VERSION,
    environment: graph.environment,
    orderHash: commitmentHash(input.orderHash, 'compileTypedStrategyRoute.orderHash'),
    graphHash: packageGraphHash(input.graph),
    solverId: protocolId(input.solverId, 'compileTypedStrategyRoute.solverId'),
    settlementClass: graph.settlementClass,
    legs: Object.freeze(legs.sort((left, right) => left.legId.localeCompare(right.legId))),
    domainPlans: Object.freeze(domainPlans),
    routeExpiryUnit: input.routeExpiryUnit,
    routeExpiryValue,
  });
  return Object.freeze({ compiled: true as const, graph: compiled, route, routeHash: typedStrategyRouteHash(route) });
}
