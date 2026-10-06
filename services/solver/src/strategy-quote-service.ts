import {
  bytesEqual,
  compileTypedStrategyRoute,
  commitmentHash,
  strategyPackageOrderHash,
  strategyPackageQuoteHash,
  toHex,
  typedStrategyRouteHash,
  validateStrategyPackageRouteAdmission,
  type Hash32,
  type DomainRef,
  type PackageGraphCompileContext,
  type StrategyEconomicsInput,
  type StrategyLegEconomicsInput,
  type StrategyPackageQuote,
  type StrategyPassThroughCostInput,
  type StrategyServiceChargeInput,
  type TypedAdapterActionSupportInput,
  type TypedStrategyRoute,
} from '@naryx/protocol-types';
import type {
  StoredStrategyPackageOrderDocuments,
  StrategyPackageOrderProvider,
} from './http-strategy-package-provider.js';
import {
  buildSignedStrategyPackageQuote,
  type StrategyQuoteSigner,
} from './strategy-quote-builder.js';

const HASH_HEX = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export interface GeneralizedStrategyQuoteRequest {
  readonly orderHash: string;
  readonly idempotencyKey: string;
}

export interface GeneralizedStrategyQuoteResponse {
  readonly version: 1;
  readonly status: 'SIGNED';
  readonly idempotencyKey: string;
  readonly orderHash: string;
  readonly graphHash: string;
  readonly routeHash: string;
  readonly quoteHash: string;
  readonly route: TypedStrategyRoute;
  readonly quote: StrategyPackageQuote;
}

export interface GeneralizedStrategyQuoteTerms {
  readonly quoteMode: 'EXECUTION_COMMITMENT' | 'FIRM_SIMULATED' | 'FIRM_ONCHAIN' | 'FIRM_BONDED';
  readonly economics: StrategyEconomicsInput;
  readonly legEconomics: readonly StrategyLegEconomicsInput[];
  readonly netPackageOutcomeAtoms: bigint;
  readonly serviceCharges: readonly StrategyServiceChargeInput[];
  readonly passThroughCosts: readonly StrategyPassThroughCostInput[];
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Uint8Array | string;
  readonly routeExpiryValue: bigint;
  readonly validUntilValue: bigint;
  readonly quoteNonce: bigint;
  readonly reservationId?: Uint8Array | string;
  readonly performanceBondId?: Uint8Array | string;
}

export interface GeneralizedStrategyPricingPort {
  quote(input: Readonly<{
    documents: StoredStrategyPackageOrderDocuments;
    currentTime: PackageGraphCompileContext['currentTime'];
  }>): Promise<GeneralizedStrategyQuoteTerms>;
}

export interface GeneralizedStrategyQuoteContext {
  readonly compileContext: PackageGraphCompileContext;
  readonly adapterSupport: readonly TypedAdapterActionSupportInput[];
  readonly solverId: string;
  readonly solverCapabilityManifestHash: Uint8Array | string;
  readonly pricing: GeneralizedStrategyPricingPort;
}

export interface GeneralizedStrategyQuoteContextResolver {
  resolve(documents: StoredStrategyPackageOrderDocuments): Promise<GeneralizedStrategyQuoteContext>;
}

export interface StoredGeneralizedStrategyQuote {
  readonly orderHash: string;
  readonly response: GeneralizedStrategyQuoteResponse;
}

export interface GeneralizedStrategyQuoteStore {
  get(idempotencyKey: string): StoredGeneralizedStrategyQuote | undefined;
  save(record: StoredGeneralizedStrategyQuote): StoredGeneralizedStrategyQuote;
}

export class GeneralizedStrategyQuoteError extends Error {
  readonly code: 'INVALID_REQUEST' | 'ORDER_NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'QUOTE_DECLINED';

  constructor(code: GeneralizedStrategyQuoteError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'GeneralizedStrategyQuoteError';
    this.code = code;
  }
}

export class InMemoryGeneralizedStrategyQuoteStore implements GeneralizedStrategyQuoteStore {
  readonly #records = new Map<string, StoredGeneralizedStrategyQuote>();

  get(idempotencyKey: string): StoredGeneralizedStrategyQuote | undefined {
    return this.#records.get(idempotencyKey);
  }

  save(record: StoredGeneralizedStrategyQuote): StoredGeneralizedStrategyQuote {
    const key = record.response.idempotencyKey;
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (existing.orderHash !== record.orderHash
        || existing.response.quoteHash !== record.response.quoteHash
        || existing.response.routeHash !== record.response.routeHash) {
        throw new GeneralizedStrategyQuoteError('IDEMPOTENCY_CONFLICT', 'idempotency key is already bound to another quote');
      }
      return existing;
    }
    const stored = Object.freeze({ orderHash: record.orderHash, response: record.response });
    this.#records.set(key, stored);
    return stored;
  }
}

function parseRequest(value: GeneralizedStrategyQuoteRequest): GeneralizedStrategyQuoteRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GeneralizedStrategyQuoteError('INVALID_REQUEST', 'request must be an object');
  }
  const record = value as unknown as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'idempotencyKey' || keys[1] !== 'orderHash'
    || typeof record.orderHash !== 'string' || !HASH_HEX.test(record.orderHash)
    || typeof record.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(record.idempotencyKey)) {
    throw new GeneralizedStrategyQuoteError('INVALID_REQUEST', 'request must contain a valid orderHash and idempotencyKey');
  }
  return Object.freeze({ orderHash: record.orderHash, idempotencyKey: record.idempotencyKey });
}

function hashBytes(value: string): Hash32 {
  return commitmentHash(value, 'generalizedStrategyQuote.orderHash');
}

function sameRequest(existing: StoredGeneralizedStrategyQuote, request: GeneralizedStrategyQuoteRequest): GeneralizedStrategyQuoteResponse {
  if (existing.orderHash !== request.orderHash) {
    throw new GeneralizedStrategyQuoteError('IDEMPOTENCY_CONFLICT', 'idempotency key is already bound to another order');
  }
  return existing.response;
}

export class GeneralizedStrategyQuoteService {
  readonly #packages: StrategyPackageOrderProvider;
  readonly #contexts: GeneralizedStrategyQuoteContextResolver;
  readonly #signer: StrategyQuoteSigner;
  readonly #store: GeneralizedStrategyQuoteStore;
  readonly #pending = new Map<string, Readonly<{ orderHash: string; response: Promise<GeneralizedStrategyQuoteResponse> }>>();

  constructor(input: Readonly<{
    packages: StrategyPackageOrderProvider;
    contexts: GeneralizedStrategyQuoteContextResolver;
    signer: StrategyQuoteSigner;
    store?: GeneralizedStrategyQuoteStore;
  }>) {
    this.#packages = input.packages;
    this.#contexts = input.contexts;
    this.#signer = input.signer;
    this.#store = input.store ?? new InMemoryGeneralizedStrategyQuoteStore();
  }

  async quote(rawRequest: GeneralizedStrategyQuoteRequest): Promise<GeneralizedStrategyQuoteResponse> {
    const request = parseRequest(rawRequest);
    const stored = this.#store.get(request.idempotencyKey);
    if (stored !== undefined) return sameRequest(stored, request);
    const pending = this.#pending.get(request.idempotencyKey);
    if (pending !== undefined) {
      if (pending.orderHash !== request.orderHash) {
        throw new GeneralizedStrategyQuoteError('IDEMPOTENCY_CONFLICT', 'idempotency key is already bound to another order');
      }
      return pending.response;
    }
    const task = this.#quote(request);
    this.#pending.set(request.idempotencyKey, { orderHash: request.orderHash, response: task });
    try {
      const response = await task;
      return this.#store.save({ orderHash: request.orderHash, response }).response;
    } finally {
      this.#pending.delete(request.idempotencyKey);
    }
  }

  async #quote(request: GeneralizedStrategyQuoteRequest): Promise<GeneralizedStrategyQuoteResponse> {
    const requestedHash = hashBytes(request.orderHash);
    const documents = await this.#packages.getByOrder(requestedHash);
    if (documents === undefined) throw new GeneralizedStrategyQuoteError('ORDER_NOT_FOUND', 'strategy package order was not found');
    if (documents.orderHashHex !== request.orderHash
      || !bytesEqual(strategyPackageOrderHash(documents.order), requestedHash)) {
      throw new GeneralizedStrategyQuoteError('QUOTE_DECLINED', 'stored order commitment mismatch');
    }
    const context = await this.#contexts.resolve(documents);
    const terms = await context.pricing.quote({ documents, currentTime: context.compileContext.currentTime });
    if (terms.validUntilValue <= context.compileContext.currentTime.value
      || terms.validUntilValue > documents.order.expiryValue
      || terms.routeExpiryValue <= context.compileContext.currentTime.value
      || terms.routeExpiryValue > terms.validUntilValue) {
      throw new GeneralizedStrategyQuoteError('QUOTE_DECLINED', 'pricing provider returned invalid quote validity');
    }
    const compiled = compileTypedStrategyRoute({
      graph: documents.graph,
      compileContext: context.compileContext,
      adapterSupport: context.adapterSupport,
      orderHash: requestedHash,
      solverId: context.solverId,
      routeExpiryUnit: documents.order.expiryUnit,
      routeExpiryValue: terms.routeExpiryValue,
    });
    if (!compiled.compiled) {
      throw new GeneralizedStrategyQuoteError('QUOTE_DECLINED', `route compilation failed: ${compiled.reasons.join(',')}`);
    }
    const domains = documents.graph.legs.reduce<DomainRef[]>((values, leg) => {
      if (!values.some((domain) => domain.domainId === leg.domain.domainId
        && domain.domainManifestVersion === leg.domain.domainManifestVersion
        && bytesEqual(domain.domainManifestHash, leg.domain.domainManifestHash))) values.push(leg.domain);
      return values;
    }, []).sort((left, right) => left.domainId.localeCompare(right.domainId));
    const quote = buildSignedStrategyPackageQuote({
      version: 1,
      environment: documents.order.environment,
      domains,
      orderHash: requestedHash,
      graphHash: compiled.graph.graphHash,
      routeHash: compiled.routeHash,
      templateId: documents.order.templateId,
      templateVersion: documents.order.templateVersion,
      packageTemplateManifestHash: documents.order.packageTemplateManifestHash,
      seriesId: documents.order.seriesId,
      seriesVersion: documents.order.seriesVersion,
      seriesManifestHash: documents.order.seriesManifestHash,
      executionClassId: documents.order.executionClassId,
      executionClassVersion: documents.order.executionClassVersion,
      executionClassManifestHash: documents.order.executionClassManifestHash,
      quoteConventionId: documents.order.quoteConventionId,
      riskClassId: documents.order.riskClassId,
      solverId: context.solverId,
      solverCapabilityManifestHash: context.solverCapabilityManifestHash,
      quoteMode: terms.quoteMode,
      settlementClass: documents.order.settlementClass,
      quoteAsset: documents.order.quoteAsset,
      economics: terms.economics,
      legEconomics: terms.legEconomics,
      netPackageOutcomeAtoms: terms.netPackageOutcomeAtoms,
      serviceCharges: terms.serviceCharges,
      passThroughCosts: terms.passThroughCosts,
      feePolicyVersion: terms.feePolicyVersion,
      feePolicyManifestHash: terms.feePolicyManifestHash,
      validUntilUnit: documents.order.expiryUnit,
      validUntilValue: terms.validUntilValue,
      ...(terms.reservationId === undefined ? {} : { reservationId: terms.reservationId }),
      ...(terms.performanceBondId === undefined ? {} : { performanceBondId: terms.performanceBondId }),
      quoteNonce: terms.quoteNonce,
    }, this.#signer);
    validateStrategyPackageRouteAdmission(
      documents.order,
      documents.graph,
      quote,
      compiled.route,
      context.compileContext,
    );
    return Object.freeze({
      version: 1,
      status: 'SIGNED',
      idempotencyKey: request.idempotencyKey,
      orderHash: request.orderHash,
      graphHash: toHex(compiled.graph.graphHash),
      routeHash: toHex(typedStrategyRouteHash(compiled.route)),
      quoteHash: toHex(strategyPackageQuoteHash(quote)),
      route: compiled.route,
      quote,
    });
  }
}
