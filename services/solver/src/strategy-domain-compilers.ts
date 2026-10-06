import type { CompiledStrategyExecution } from '@naryx/adapter-core';
import {
  compileEvmStrategyPlan,
  type EvmStrategyExecutionPlan,
  type EvmStrategyLegMaterializer,
} from '@naryx/adapter-evm';
import {
  compileHyperliquidStrategyPlan,
  type HyperliquidStrategyExecutionPlan,
  type HyperliquidStrategyMarketBindingInput,
} from '@naryx/adapter-hyperliquid';
import {
  compileSolanaStrategyPlan,
  type SolanaStrategyInstructionPlan,
  type SolanaStrategyLegMaterializer,
} from '@naryx/adapter-solana';
import {
  bytesEqual,
  strategyPackageOrderHash,
  strategyPackageQuoteHash,
  typedStrategyRouteHash,
  type AdmittedStrategyPackage,
  type DomainRef,
  type Hash32,
  type TypedStrategyDomainPlan,
  type TypedStrategyRoute,
} from '@naryx/protocol-types';
import type { PublicKey } from '@solana/web3.js';
import { toHex, type Address } from 'viem';
import type { StrategyDomainCompiler } from './strategy-execution-router.js';

type StrategyDomainCompileRequest = Readonly<{
  admission: AdmittedStrategyPackage;
  route: TypedStrategyRoute;
  domainPlan: TypedStrategyDomainPlan;
  packageId: Hash32;
}>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function assertMaterializerDomains(
  domain: DomainRef,
  materializers: readonly { readonly domain: DomainRef }[],
  context: string,
): void {
  requireCondition(materializers.length > 0, `${context} requires at least one materializer`);
  requireCondition(materializers.every((value) => sameDomain(value.domain, domain)), `${context} materializer domain mismatch`);
}

export function createSolanaStrategyDomainCompiler(input: Readonly<{
  domain: DomainRef;
  feePayer: PublicKey | string;
  allowedSignerPubkeys: readonly (PublicKey | string)[];
  maximumTransactionComputeUnits: number;
  materializers: readonly SolanaStrategyLegMaterializer[];
}>): StrategyDomainCompiler<SolanaStrategyInstructionPlan> {
  assertMaterializerDomains(input.domain, input.materializers, 'Solana strategy compiler');
  const materializers = Object.freeze([...input.materializers]);
  const allowedSignerPubkeys = Object.freeze([...input.allowedSignerPubkeys]);
  return Object.freeze({
    domain: input.domain,
    executionPlanKind: 'SVM_ATOMIC_CPI' as const,
    async compile({ admission, route, domainPlan, packageId }: StrategyDomainCompileRequest) {
      return compileSolanaStrategyPlan({
        admission,
        route,
        domainPlan,
        packageId,
        feePayer: input.feePayer,
        allowedSignerPubkeys,
        maximumTransactionComputeUnits: input.maximumTransactionComputeUnits,
        materializers,
      });
    },
  });
}

export function createEvmStrategyDomainCompiler(input: Readonly<{
  domain: DomainRef;
  executionPlanKind: 'EVM_ATOMIC_BATCH' | 'EVM_ASYNC_REQUEST';
  strategyAccount: Address;
  materializers: readonly EvmStrategyLegMaterializer[];
}>): StrategyDomainCompiler<EvmStrategyExecutionPlan> {
  assertMaterializerDomains(input.domain, input.materializers, 'EVM strategy compiler');
  const materializers = Object.freeze([...input.materializers]);
  return Object.freeze({
    domain: input.domain,
    executionPlanKind: input.executionPlanKind,
    async compile({ admission, route, domainPlan, packageId }: StrategyDomainCompileRequest): Promise<CompiledStrategyExecution<EvmStrategyExecutionPlan>> {
      return compileEvmStrategyPlan({
        admission,
        route,
        domainPlan,
        strategyAccount: input.strategyAccount,
        packageId: toHex(packageId),
        materializers,
      });
    },
  });
}

export function createHyperliquidStrategyDomainCompiler(input: Readonly<{
  domain: DomainRef;
  bindings: readonly HyperliquidStrategyMarketBindingInput[];
}>): StrategyDomainCompiler<HyperliquidStrategyExecutionPlan> {
  requireCondition(input.bindings.length > 0, 'HyperCore strategy compiler requires at least one market binding');
  const bindings = Object.freeze([...input.bindings]);
  return Object.freeze({
    domain: input.domain,
    executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
    async compile({ admission, route, domainPlan }: StrategyDomainCompileRequest) {
      return Object.freeze({
        domains: Object.freeze([input.domain]),
        orderHash: strategyPackageOrderHash(admission.order),
        graphHash: route.graphHash,
        quoteHash: strategyPackageQuoteHash(admission.quote),
        routeHash: typedStrategyRouteHash(route),
        payload: compileHyperliquidStrategyPlan({
          admission,
          route,
          domainPlan,
          bindings,
        }),
      });
    },
  });
}
