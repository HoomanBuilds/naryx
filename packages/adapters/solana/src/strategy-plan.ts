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
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

export interface SolanaStrategyInstructionRecord {
  readonly legId: string;
  readonly stage: number;
  readonly materializationClassId: string;
  readonly programId: string;
  readonly expectedProgramDataHash: Uint8Array;
  readonly computeUnitLimit: number;
  readonly instruction: TransactionInstruction;
}

export interface SolanaStrategyInstructionPlan {
  readonly version: 1;
  readonly planKind: 'SVM_ATOMIC_CPI';
  readonly guarantee: 'ATOMIC_POSTCONDITION';
  readonly domain: DomainRef;
  readonly packageId: Uint8Array;
  readonly feePayer: string;
  readonly requiredSignerPubkeys: readonly string[];
  readonly instructions: readonly SolanaStrategyInstructionRecord[];
  readonly totalComputeUnitLimit: number;
}

export interface SolanaStrategyLegMaterializationContext {
  readonly admission: AdmittedStrategyPackage;
  readonly route: TypedStrategyRoute;
  readonly graph: PackageGraph;
  readonly routeLeg: TypedStrategyRouteLeg;
  readonly packageId: Uint8Array;
  readonly orderHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
}

export interface SolanaStrategyLegMaterializer {
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly legFamily: PackageGraph['legs'][number]['legFamily'];
  readonly materializationClassId: string;
  readonly programId: PublicKey | string;
  readonly expectedProgramDataHash: Uint8Array;
  readonly maximumComputeUnitLimit: number;
  materialize(context: SolanaStrategyLegMaterializationContext): Readonly<{
    instruction: TransactionInstruction;
    computeUnitLimit: number;
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

function key(value: PublicKey | string, context: string): PublicKey {
  try {
    return value instanceof PublicKey ? value : new PublicKey(value);
  } catch {
    throw new Error(`${context} must be a Solana public key`);
  }
}

function materializerFor(
  leg: PackageGraph['legs'][number],
  routeLeg: TypedStrategyRouteLeg,
  values: readonly SolanaStrategyLegMaterializer[],
): SolanaStrategyLegMaterializer {
  const matches = values.filter((candidate) =>
    sameDomain(candidate.domain, leg.domain) &&
    sameAdapter(candidate.adapter, leg.adapter) &&
    sameManifest(candidate.venue, leg.venue) &&
    sameManifest(candidate.market, leg.market) &&
    candidate.legFamily === leg.legFamily &&
    candidate.materializationClassId === routeLeg.materializationClassId,
  );
  requireCondition(matches.length === 1, `leg ${leg.legId} must resolve to exactly one Solana materializer`);
  return matches[0]!;
}

export function compileSolanaStrategyPlan(input: Readonly<{
  admission: AdmittedStrategyPackage;
  route: TypedStrategyRoute;
  domainPlan?: TypedStrategyDomainPlan;
  packageId: Uint8Array;
  feePayer: PublicKey | string;
  allowedSignerPubkeys: readonly (PublicKey | string)[];
  maximumTransactionComputeUnits: number;
  materializers: readonly SolanaStrategyLegMaterializer[];
}>): CompiledStrategyExecution<SolanaStrategyInstructionPlan> {
  const { admission, route } = input;
  const { graph } = admission;
  const domainPlan = input.domainPlan ?? route.domainPlans[0];
  requireCondition(domainPlan !== undefined, 'Solana strategy execution requires a domain plan');
  requireCondition(route.domainPlans.some((candidate) => sameDomain(candidate.domain, domainPlan.domain)
    && candidate.executionPlanKind === domainPlan.executionPlanKind), 'Solana domain plan is not part of the route');
  if (input.domainPlan === undefined) requireCondition(route.domainPlans.length === 1, 'Solana strategy execution requires an explicit domain plan for a cross-domain route');
  requireCondition(domainPlan.executionPlanKind === 'SVM_ATOMIC_CPI', 'route is not an SVM atomic plan');
  requireCondition(route.settlementClass === 'ATOMIC_POSTCONDITION' || route.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED', 'SVM atomic execution requires atomic or cross-domain prepositioned settlement');
  const selectedLegIds = new Set(domainPlan.legIds);
  const domainLegs = graph.legs.filter((leg) => selectedLegIds.has(leg.legId));
  requireCondition(domainLegs.length > 0 && domainLegs.length === selectedLegIds.size, 'Solana domain plan does not cover known graph legs exactly once');
  requireCondition(domainLegs.every((leg) => sameDomain(leg.domain, domainPlan.domain)), 'Solana domain plan contains a leg from another domain');
  requireCondition(route.legs.filter((leg) => selectedLegIds.has(leg.legId)).length === domainLegs.length, 'route does not cover every Solana domain leg');
  requireCondition(Number.isInteger(input.maximumTransactionComputeUnits) && input.maximumTransactionComputeUnits > 0, 'transaction compute limit is invalid');
  requireCondition(input.packageId.length === 32 && input.packageId.some((byte) => byte !== 0), 'package id must be a nonzero 32-byte value');
  const packageId = Uint8Array.from(input.packageId);
  const orderHash = strategyPackageOrderHash(admission.order);
  const quoteHash = strategyPackageQuoteHash(admission.quote);
  const routeHash = typedStrategyRouteHash(route);
  const feePayer = key(input.feePayer, 'feePayer');
  const allowedSigners = new Set(input.allowedSignerPubkeys.map((value, index) => key(value, `allowedSignerPubkeys[${index}]`).toBase58()));
  allowedSigners.add(feePayer.toBase58());
  const records = domainLegs.map((leg): SolanaStrategyInstructionRecord => {
    const routeLeg = route.legs.find((candidate) => candidate.legId === leg.legId);
    requireCondition(routeLeg !== undefined, `route is missing leg ${leg.legId}`);
    requireCondition(routeLeg.executionPlanKind === 'SVM_ATOMIC_CPI', `leg ${leg.legId} plan kind mismatch`);
    const materializer = materializerFor(leg, routeLeg, input.materializers);
    const programId = key(materializer.programId, `materializer ${materializer.materializationClassId} programId`);
    requireCondition(materializer.expectedProgramDataHash.length === 32 && materializer.expectedProgramDataHash.some((byte) => byte !== 0), `leg ${leg.legId} program data hash is invalid`);
    requireCondition(Number.isInteger(materializer.maximumComputeUnitLimit) && materializer.maximumComputeUnitLimit > 0, `leg ${leg.legId} maximum compute limit is invalid`);
    const materialized = materializer.materialize({ admission, route, graph, routeLeg, packageId, orderHash, quoteHash, routeHash });
    requireCondition(materialized.instruction.programId.equals(programId), `leg ${leg.legId} program id differs from its registered materializer`);
    requireCondition(Number.isInteger(materialized.computeUnitLimit) && materialized.computeUnitLimit > 0 && materialized.computeUnitLimit <= materializer.maximumComputeUnitLimit, `leg ${leg.legId} compute limit exceeds its registered bound`);
    for (const account of materialized.instruction.keys) {
      requireCondition(!account.isSigner || allowedSigners.has(account.pubkey.toBase58()), `leg ${leg.legId} introduces an unauthorized signer`);
    }
    return Object.freeze({
      legId: leg.legId,
      stage: routeLeg.stage,
      materializationClassId: routeLeg.materializationClassId,
      programId: programId.toBase58(),
      expectedProgramDataHash: Uint8Array.from(materializer.expectedProgramDataHash),
      computeUnitLimit: materialized.computeUnitLimit,
      instruction: materialized.instruction,
    });
  }).sort((left, right) => left.stage - right.stage || left.legId.localeCompare(right.legId));
  const totalComputeUnitLimit = records.reduce((sum, value) => sum + value.computeUnitLimit, 0);
  requireCondition(totalComputeUnitLimit <= input.maximumTransactionComputeUnits, 'strategy instruction plan exceeds the transaction compute limit');
  const stageIds = [...new Set(records.map((record) => record.stage))];
  if (route.settlementClass !== 'CROSS_DOMAIN_PREPOSITIONED') requireCondition(stageIds.every((stage, index) => stage === index), 'Solana route stages must be contiguous from zero');
  const requiredSignerPubkeys = Object.freeze([...new Set(records.flatMap((record) => record.instruction.keys.filter((account) => account.isSigner).map((account) => account.pubkey.toBase58())).concat(feePayer.toBase58()))].sort());
  return Object.freeze({
    domains: Object.freeze([domainPlan.domain]),
    orderHash,
    graphHash: route.graphHash,
    quoteHash,
    routeHash,
    payload: Object.freeze({
      version: 1 as const,
      planKind: 'SVM_ATOMIC_CPI' as const,
      guarantee: 'ATOMIC_POSTCONDITION' as const,
      domain: domainPlan.domain,
      packageId,
      feePayer: feePayer.toBase58(),
      requiredSignerPubkeys,
      instructions: Object.freeze(records),
      totalComputeUnitLimit,
    }),
  });
}
