import type { CompiledStrategyExecution } from '@naryx/adapter-core';
import {
  compileEvmMultiStrategyAccountEnvelope,
  type EvmMultiStrategyAccountEnvelope,
  type EvmStrategyCallPolicy,
  type EvmStrategyExecutionPlan,
} from '@naryx/adapter-evm';
import type {
  HyperliquidStrategyExecutionPlan,
} from '@naryx/adapter-hyperliquid';
import {
  compileSolanaMultiStrategyAccountEnvelope,
  type SolanaMultiStrategyEnvelope,
  type SolanaStrategyAdapterPolicy,
  type SolanaStrategyFeeTerms,
  type SolanaStrategyInstructionPlan,
} from '@naryx/adapter-solana';
import {
  bytesEqual,
  type DomainRef,
  type GraphLifecycleAction,
  type Hash32,
} from '@naryx/protocol-types';
import type { PublicKey } from '@solana/web3.js';
import type { Address, Hex } from 'viem';
import type {
  CompiledStrategyDomainExecution,
  CompiledStrategyRouteExecution,
} from './strategy-execution-router.js';

export interface StrategyExecutionIdentity {
  readonly packageId: Hash32;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateManifestHash: Uint8Array;
  readonly operation: GraphLifecycleAction;
  readonly previousStateHash?: Hash32;
  readonly nextStateHash?: Hash32;
}

export interface SolanaStrategyAccountBinding {
  readonly kind: 'SOLANA_MULTI_STRATEGY_ACCOUNT';
  readonly domain: DomainRef;
  readonly coreProgramId: PublicKey | string;
  readonly multiStrategyProgramId: PublicKey | string;
  readonly owner: PublicKey | string;
  readonly solver?: PublicKey | string;
  readonly settlementManifestHash: Uint8Array;
  readonly totalGrossNotionalAtoms: bigint;
  readonly fees?: SolanaStrategyFeeTerms;
  readonly nonce: bigint;
  readonly deadlineSlot: bigint;
  readonly policies: readonly SolanaStrategyAdapterPolicy[];
}

export interface EvmStrategyAccountBinding {
  readonly kind: 'EVM_MULTI_STRATEGY_ACCOUNT';
  readonly domain: DomainRef;
  readonly account: Address;
  readonly chainId: number;
  readonly solver: Address;
  readonly totalGrossNotionalAtoms: bigint;
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Hex;
  readonly feeToken: Address;
  readonly protocolFeeAtoms: bigint;
  readonly solverFeeAtoms: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly callPolicies: readonly EvmStrategyCallPolicy[];
}

export interface EvmAsyncExecutorBinding {
  readonly kind: 'EVM_ASYNC_EXECUTOR';
  readonly domain: DomainRef;
}

export interface HypercoreExecutorBinding {
  readonly kind: 'HYPERCORE_EXECUTOR';
  readonly domain: DomainRef;
}

export type StrategyExecutionDomainBinding =
  | SolanaStrategyAccountBinding
  | EvmStrategyAccountBinding
  | EvmAsyncExecutorBinding
  | HypercoreExecutorBinding;

export type PreparedStrategyDomainExecution =
  | Readonly<{
      kind: 'SOLANA_MULTI_STRATEGY_ACCOUNT';
      domain: DomainRef;
      routeSettlementClass: CompiledStrategyRouteExecution['settlementClass'];
      localGuarantee: 'ATOMIC_POSTCONDITION';
      legIds: readonly string[];
      envelope: SolanaMultiStrategyEnvelope;
    }>
  | Readonly<{
      kind: 'EVM_MULTI_STRATEGY_ACCOUNT';
      domain: DomainRef;
      routeSettlementClass: CompiledStrategyRouteExecution['settlementClass'];
      localGuarantee: 'ATOMIC_POSTCONDITION';
      legIds: readonly string[];
      envelope: EvmMultiStrategyAccountEnvelope;
    }>
  | Readonly<{
      kind: 'EVM_ASYNC_EXECUTOR';
      domain: DomainRef;
      routeSettlementClass: CompiledStrategyRouteExecution['settlementClass'];
      localGuarantee: 'BONDED_ASYNCHRONOUS';
      plan: EvmStrategyExecutionPlan;
    }>
  | Readonly<{
      kind: 'HYPERCORE_EXECUTOR';
      domain: DomainRef;
      routeSettlementClass: CompiledStrategyRouteExecution['settlementClass'];
      localGuarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY';
      plan: HyperliquidStrategyExecutionPlan;
    }>;

export interface PreparedStrategyExecution {
  readonly version: 1;
  readonly identity: StrategyExecutionIdentity;
  readonly settlementClass: CompiledStrategyRouteExecution['settlementClass'];
  readonly coordination: CompiledStrategyRouteExecution['coordination'];
  readonly orderHash: Uint8Array;
  readonly graphHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
  readonly crossDomainPlanHash?: Uint8Array;
  readonly domains: readonly PreparedStrategyDomainExecution[];
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function nonzeroHash(value: Uint8Array, context: string): Hash32 {
  requireCondition(value.length === 32 && value.some((byte) => byte !== 0), `${context} must be a nonzero 32-byte hash`);
  return Uint8Array.from(value) as Hash32;
}

function hexHash(value: Uint8Array, context: string): Hex {
  return `0x${Buffer.from(nonzeroHash(value, context)).toString('hex')}`;
}

function bindingFor(
  execution: CompiledStrategyDomainExecution,
  bindings: readonly StrategyExecutionDomainBinding[],
): StrategyExecutionDomainBinding {
  const matches = bindings.filter((binding) => sameDomain(binding.domain, execution.domainPlan.domain));
  requireCondition(matches.length === 1, `domain ${execution.domainPlan.domain.domainId} must resolve to exactly one execution binding`);
  return matches[0]!;
}

function payloadPlanKind(execution: CompiledStrategyDomainExecution): string {
  const payload = execution.execution.payload;
  requireCondition(typeof payload === 'object' && payload !== null && 'version' in payload && payload.version === 1, `domain ${execution.domainPlan.domain.domainId} payload version is unsupported`);
  requireCondition('planKind' in payload && typeof payload.planKind === 'string', `domain ${execution.domainPlan.domain.domainId} payload plan kind is missing`);
  return payload.planKind;
}

function prepareSolana(
  compiled: CompiledStrategyRouteExecution,
  execution: CompiledStrategyDomainExecution,
  binding: SolanaStrategyAccountBinding,
  identity: StrategyExecutionIdentity,
): PreparedStrategyDomainExecution {
  requireCondition(execution.domainPlan.executionPlanKind === 'SVM_ATOMIC_CPI' && payloadPlanKind(execution) === 'SVM_ATOMIC_CPI', 'Solana execution binding requires an SVM atomic plan');
  requireCondition(compiled.settlementClass === 'ATOMIC_POSTCONDITION' || compiled.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED', 'Solana strategy account cannot enforce this route settlement class');
  const plan = execution.execution.payload as SolanaStrategyInstructionPlan;
  const legIds = Object.freeze(plan.instructions.map((instruction) => instruction.legId));
  const envelope = compileSolanaMultiStrategyAccountEnvelope({
    compiled: execution.execution as CompiledStrategyExecution<SolanaStrategyInstructionPlan>,
    coreProgramId: binding.coreProgramId,
    multiStrategyProgramId: binding.multiStrategyProgramId,
    owner: binding.owner,
    ...(binding.solver === undefined ? {} : { solver: binding.solver }),
    operation: identity.operation,
    packageId: nonzeroHash(identity.packageId, 'package id'),
    templateId: identity.templateId,
    templateVersion: identity.templateVersion,
    templateManifestHash: nonzeroHash(identity.templateManifestHash, 'template manifest hash'),
    settlementManifestHash: nonzeroHash(binding.settlementManifestHash, 'settlement manifest hash'),
    ...(identity.previousStateHash === undefined ? {} : { previousStateHash: identity.previousStateHash }),
    ...(identity.nextStateHash === undefined ? {} : { nextStateHash: identity.nextStateHash }),
    totalGrossNotionalAtoms: binding.totalGrossNotionalAtoms,
    ...(binding.fees === undefined ? {} : { fees: binding.fees }),
    nonce: binding.nonce,
    deadlineSlot: binding.deadlineSlot,
    policies: binding.policies,
  });
  return Object.freeze({
    kind: binding.kind,
    domain: execution.domainPlan.domain,
    routeSettlementClass: compiled.settlementClass,
    localGuarantee: 'ATOMIC_POSTCONDITION',
    legIds,
    envelope,
  });
}

function prepareEvmAccount(
  compiled: CompiledStrategyRouteExecution,
  execution: CompiledStrategyDomainExecution,
  binding: EvmStrategyAccountBinding,
  identity: StrategyExecutionIdentity,
): PreparedStrategyDomainExecution {
  requireCondition(execution.domainPlan.executionPlanKind === 'EVM_ATOMIC_BATCH' && payloadPlanKind(execution) === 'EVM_ATOMIC_BATCH', 'EVM strategy account requires an atomic batch plan');
  requireCondition(compiled.settlementClass === 'ATOMIC_POSTCONDITION' || compiled.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED', 'EVM strategy account cannot enforce this route settlement class');
  const plan = execution.execution.payload as EvmStrategyExecutionPlan;
  const legIds = Object.freeze(plan.stages.flatMap((stage) => stage.calls.map((call) => call.legId)));
  const envelope = compileEvmMultiStrategyAccountEnvelope({
    compiled: execution.execution as CompiledStrategyExecution<EvmStrategyExecutionPlan>,
    account: binding.account,
    chainId: binding.chainId,
    operation: identity.operation,
    packageId: hexHash(identity.packageId, 'package id'),
    templateId: identity.templateId,
    templateVersion: identity.templateVersion,
    templateManifestHash: hexHash(identity.templateManifestHash, 'template manifest hash'),
    ...(identity.previousStateHash === undefined ? {} : { previousStateHash: hexHash(identity.previousStateHash, 'previous state hash') }),
    ...(identity.nextStateHash === undefined ? {} : { nextStateHash: hexHash(identity.nextStateHash, 'next state hash') }),
    totalGrossNotionalAtoms: binding.totalGrossNotionalAtoms,
    fees: {
      policyVersion: binding.feePolicyVersion,
      policyManifestHash: binding.feePolicyManifestHash,
      token: binding.feeToken,
      protocolFeeAtoms: binding.protocolFeeAtoms,
      solverFeeAtoms: binding.solverFeeAtoms,
    },
    solver: binding.solver,
    nonce: binding.nonce,
    deadline: binding.deadline,
    callPolicies: binding.callPolicies,
  });
  return Object.freeze({
    kind: binding.kind,
    domain: execution.domainPlan.domain,
    routeSettlementClass: compiled.settlementClass,
    localGuarantee: 'ATOMIC_POSTCONDITION',
    legIds,
    envelope,
  });
}

function prepareEvmAsync(
  compiled: CompiledStrategyRouteExecution,
  execution: CompiledStrategyDomainExecution,
  binding: EvmAsyncExecutorBinding,
): PreparedStrategyDomainExecution {
  requireCondition(execution.domainPlan.executionPlanKind === 'EVM_ASYNC_REQUEST' && payloadPlanKind(execution) === 'EVM_ASYNC_REQUEST', 'EVM asynchronous binding requires an asynchronous request plan');
  requireCondition(compiled.settlementClass === 'ASYNC_BONDED_SOLVER' || compiled.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED', 'EVM asynchronous executor cannot enforce this route settlement class');
  const plan = execution.execution.payload as EvmStrategyExecutionPlan;
  requireCondition(plan.guarantee === 'BONDED_ASYNCHRONOUS', 'EVM asynchronous plan guarantee is invalid');
  return Object.freeze({
    kind: binding.kind,
    domain: execution.domainPlan.domain,
    routeSettlementClass: compiled.settlementClass,
    localGuarantee: 'BONDED_ASYNCHRONOUS',
    plan,
  });
}

function prepareHypercore(
  compiled: CompiledStrategyRouteExecution,
  execution: CompiledStrategyDomainExecution,
  binding: HypercoreExecutorBinding,
): PreparedStrategyDomainExecution {
  requireCondition(execution.domainPlan.executionPlanKind === 'HYPERCORE_BATCHED_IOC', 'HyperCore binding requires a batched IOC domain plan');
  requireCondition(compiled.settlementClass === 'BATCHED_IOC_WITH_RECOVERY' || compiled.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED', 'HyperCore executor cannot enforce this route settlement class');
  const plan = execution.execution.payload as HyperliquidStrategyExecutionPlan;
  requireCondition(plan.version === 1 && plan.guarantee === 'BATCHED_IOC_WITH_BOUNDED_RECOVERY', 'HyperCore execution plan guarantee is invalid');
  return Object.freeze({
    kind: binding.kind,
    domain: execution.domainPlan.domain,
    routeSettlementClass: compiled.settlementClass,
    localGuarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY',
    plan,
  });
}

export function prepareCompiledStrategyExecution(input: Readonly<{
  compiled: CompiledStrategyRouteExecution;
  identity: StrategyExecutionIdentity;
  bindings: readonly StrategyExecutionDomainBinding[];
}>): PreparedStrategyExecution {
  const { compiled, identity } = input;
  nonzeroHash(identity.packageId, 'package id');
  requireCondition(bytesEqual(compiled.packageId, identity.packageId), 'execution identity package id differs from the compiled route');
  nonzeroHash(identity.templateManifestHash, 'template manifest hash');
  requireCondition(identity.templateId.length > 0 && Number.isInteger(identity.templateVersion) && identity.templateVersion > 0, 'template identity is invalid');
  if (identity.operation === 'ENTRY') {
    requireCondition(identity.previousStateHash === undefined, 'entry cannot carry a previous state hash');
  } else {
    requireCondition(identity.previousStateHash !== undefined, 'non-entry execution requires a previous state hash');
    nonzeroHash(identity.previousStateHash, 'previous state hash');
  }
  if (identity.operation === 'EXIT' || identity.operation === 'EMERGENCY_UNWIND') {
    requireCondition(identity.nextStateHash === undefined, 'terminal execution cannot carry a next state hash');
  } else if (identity.nextStateHash !== undefined) {
    nonzeroHash(identity.nextStateHash, 'next state hash');
  }
  requireCondition(input.bindings.length === compiled.domains.length, 'execution bindings must cover the compiled domains exactly');
  const domains = compiled.domains.map((execution): PreparedStrategyDomainExecution => {
    const binding = bindingFor(execution, input.bindings);
    if (binding.kind === 'SOLANA_MULTI_STRATEGY_ACCOUNT') return prepareSolana(compiled, execution, binding, identity);
    if (binding.kind === 'EVM_MULTI_STRATEGY_ACCOUNT') return prepareEvmAccount(compiled, execution, binding, identity);
    if (binding.kind === 'EVM_ASYNC_EXECUTOR') return prepareEvmAsync(compiled, execution, binding);
    return prepareHypercore(compiled, execution, binding);
  });
  return Object.freeze({
    version: 1,
    identity: Object.freeze({
      packageId: Uint8Array.from(identity.packageId) as Hash32,
      templateId: identity.templateId,
      templateVersion: identity.templateVersion,
      templateManifestHash: Uint8Array.from(identity.templateManifestHash),
      operation: identity.operation,
      ...(identity.previousStateHash === undefined ? {} : { previousStateHash: Uint8Array.from(identity.previousStateHash) as Hash32 }),
      ...(identity.nextStateHash === undefined ? {} : { nextStateHash: Uint8Array.from(identity.nextStateHash) as Hash32 }),
    }),
    settlementClass: compiled.settlementClass,
    coordination: compiled.coordination,
    orderHash: compiled.orderHash,
    graphHash: compiled.graphHash,
    quoteHash: compiled.quoteHash,
    routeHash: compiled.routeHash,
    ...(compiled.crossDomainPlanHash === undefined ? {} : { crossDomainPlanHash: compiled.crossDomainPlanHash }),
    domains: Object.freeze(domains),
  });
}
