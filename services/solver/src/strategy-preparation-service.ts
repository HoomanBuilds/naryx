import { createPublicKey, verify } from 'node:crypto';
import {
  bytesEqual,
  packageQuoteExecutionBindingHash,
  packageSettlementReadinessHash,
  strategyPackageQuoteHash,
  toHex,
  validatePackageQuoteExecutionBinding,
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

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyExecutionBindingSignature(key: Uint8Array, digest: Uint8Array, signature: Uint8Array): boolean {
  if (key.length !== 32 || signature.length !== 64) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key)]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(digest), publicKey, Buffer.from(signature));
  } catch {
    return false;
  }
}

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
    return this.prepareDocuments(documents);
  }

  async prepareDocuments(
    documents: StoredStrategyPackageDocuments,
  ): Promise<PreparedStrategyExecutionTransport> {
    if (documents.packageExecutionLock !== undefined
      && (documents.packageExecution?.binding === undefined
        || toHex(documents.packageExecution.readiness.packageOrderId) !== documents.packageExecutionLock.packageOrderIdHex)) {
      throw new Error('package-market execution requires a quote bound to the locked package order');
    }
    if (documents.packageExecution !== undefined) {
      const { readiness, readinessHashHex, binding, bindingHashHex } = documents.packageExecution;
      if (binding === undefined || bindingHashHex === undefined) {
        throw new Error('final package settlement requires a signed quote execution binding');
      }
      try {
        validatePackageQuoteExecutionBinding(binding, readiness, documents.quote);
      } catch {
        throw new Error('package quote execution binding does not match final settlement readiness');
      }
      const bindingHash = packageQuoteExecutionBindingHash(binding);
      if (toHex(packageSettlementReadinessHash(readiness)) !== readinessHashHex
        || toHex(bindingHash) !== bindingHashHex
        || binding.solverSignatureScheme !== 'ED25519'
        || !verifyExecutionBindingSignature(binding.solverVerificationKey, bindingHash, binding.signature)) {
        throw new Error('package quote execution binding evidence is invalid');
      }
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
