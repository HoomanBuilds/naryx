import {
  bytesEqual,
  strategyPackageQuoteHash,
  validateStrategyPackageRouteAdmission,
  type CrossDomainPlanInput,
  type Hash32,
  type PackageGraphCompileContext,
} from '@naryx/protocol-types';
import {
  prepareCompiledStrategyExecution,
  type StrategyExecutionDomainBinding,
  type StrategyExecutionIdentity,
} from './strategy-execution-preparer.js';
import {
  compileStrategyRouteExecution,
  type StrategyDomainCompiler,
} from './strategy-execution-router.js';
import {
  preparedStrategyExecutionTransport,
  type PreparedStrategyExecutionTransport,
} from './strategy-execution-transport.js';
import type {
  StoredStrategyPackageDocuments,
  StrategyPackageProvider,
} from './http-strategy-package-provider.js';

export interface StrategyPreparationContext {
  readonly compileContext: PackageGraphCompileContext;
  readonly identity: StrategyExecutionIdentity;
  readonly compilers: readonly StrategyDomainCompiler[];
  readonly bindings: readonly StrategyExecutionDomainBinding[];
  readonly crossDomainPlan?: CrossDomainPlanInput;
}

export interface StrategyPreparationContextResolver {
  resolve(documents: StoredStrategyPackageDocuments): Promise<StrategyPreparationContext>;
}

export class StrategyPreparationService {
  readonly #packages: StrategyPackageProvider;
  readonly #contexts: StrategyPreparationContextResolver;

  constructor(packages: StrategyPackageProvider, contexts: StrategyPreparationContextResolver) {
    this.#packages = packages;
    this.#contexts = contexts;
  }

  async prepareByQuote(quoteHash: Hash32): Promise<PreparedStrategyExecutionTransport | undefined> {
    const documents = await this.#packages.getByQuote(quoteHash);
    if (documents === undefined) return undefined;
    if (!bytesEqual(strategyPackageQuoteHash(documents.quote), quoteHash)) {
      throw new Error('strategy package provider returned another quote');
    }
    const context = await this.#contexts.resolve(documents);
    const admission = validateStrategyPackageRouteAdmission(
      documents.order,
      documents.graph,
      documents.quote,
      documents.route,
      context.compileContext,
    );
    if (!bytesEqual(context.identity.templateManifestHash, admission.order.packageTemplateManifestHash)
      || context.identity.templateId !== admission.order.templateId
      || context.identity.templateVersion !== admission.order.templateVersion
      || context.identity.operation !== admission.order.lifecycleAction) {
      throw new Error('strategy execution identity does not match the admitted order');
    }
    const compiled = await compileStrategyRouteExecution({
      admission,
      route: documents.route,
      packageId: context.identity.packageId,
      compilers: context.compilers,
      ...(context.crossDomainPlan === undefined ? {} : { crossDomainPlan: context.crossDomainPlan }),
    });
    return preparedStrategyExecutionTransport(prepareCompiledStrategyExecution({
      compiled,
      identity: context.identity,
      bindings: context.bindings,
    }));
  }
}
