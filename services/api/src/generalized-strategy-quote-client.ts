import {
  bytesEqual,
  fromProtocolJson,
  packageQuoteExecutionBinding,
  packageQuoteExecutionBindingHash,
  strategyPackageQuote,
  strategyPackageQuoteHash,
  toHex,
  typedStrategyRouteHash,
  type StrategyPackageQuote,
  type StrategyPackageQuoteInput,
  type PackageQuoteExecutionBinding,
  type PackageQuoteExecutionBindingInput,
  type TypedStrategyRoute,
} from '@naryx/protocol-types';
import { verifyEd25519 } from './ed25519.js';

const HASH = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const MAX_RESPONSE_BYTES = 2_097_152;
const TIMEOUT_MS = 10_000;

export interface GeneralizedStrategyQuoteResult {
  readonly version: 1;
  readonly status: 'SIGNED';
  readonly idempotencyKey: string;
  readonly orderHash: string;
  readonly graphHash: string;
  readonly routeHash: string;
  readonly quoteHash: string;
  readonly route: TypedStrategyRoute;
  readonly quote: StrategyPackageQuote;
  readonly executionBinding?: PackageQuoteExecutionBinding;
}

export interface GeneralizedStrategyPackageExecutionContext {
  readonly packageOrderId: string;
  readonly settlementReadinessHash: string;
}

export interface GeneralizedStrategyQuotePort {
  quote(
    orderHash: string,
    idempotencyKey: string,
    packageExecution?: GeneralizedStrategyPackageExecutionContext,
  ): Promise<GeneralizedStrategyQuoteResult>;
}

export class GeneralizedStrategyQuoteClientError extends Error {
  readonly code: 'INVALID_ENDPOINT' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'QUOTE_DECLINED' | 'INVALID_RESPONSE';

  constructor(code: GeneralizedStrategyQuoteClientError['code'], message: string) {
    super(message);
    this.name = 'GeneralizedStrategyQuoteClientError';
    this.code = code;
  }
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new GeneralizedStrategyQuoteClientError('INVALID_ENDPOINT', 'strategy quote endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new GeneralizedStrategyQuoteClientError('INVALID_ENDPOINT', 'strategy quote endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

async function boundedProtocolJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json'
    || response.body === null) {
    throw new GeneralizedStrategyQuoteClientError('INVALID_RESPONSE', 'strategy quote response must be JSON');
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null && (!/^\d+$/.test(statedLength) || Number(statedLength) > MAX_RESPONSE_BYTES)) {
    throw new GeneralizedStrategyQuoteClientError('INVALID_RESPONSE', 'strategy quote response is too large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GeneralizedStrategyQuoteClientError('INVALID_RESPONSE', 'strategy quote response is too large');
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return fromProtocolJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    throw new GeneralizedStrategyQuoteClientError('INVALID_RESPONSE', 'strategy quote response is malformed');
  }
}

function checkedResponse(
  value: unknown,
  expectedOrderHash: string,
  expectedIdempotencyKey: string,
  expectedPackageExecution?: GeneralizedStrategyPackageExecutionContext,
): GeneralizedStrategyQuoteResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GeneralizedStrategyQuoteClientError('INVALID_RESPONSE', 'strategy quote response must be an object');
  }
  const root = value as Record<string, unknown>;
  const keys = Object.keys(root).sort();
  const expectedKeys = [
    'graphHash', 'idempotencyKey', 'orderHash', 'quote', 'quoteHash', 'route', 'routeHash',
    'status', 'version', ...(expectedPackageExecution === undefined ? [] : ['executionBinding']),
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
    || root.version !== 1 || root.status !== 'SIGNED'
    || root.orderHash !== expectedOrderHash || root.idempotencyKey !== expectedIdempotencyKey
    || typeof root.graphHash !== 'string' || !HASH.test(root.graphHash)
    || typeof root.routeHash !== 'string' || !HASH.test(root.routeHash)
    || typeof root.quoteHash !== 'string' || !HASH.test(root.quoteHash)
    || typeof root.route !== 'object' || root.route === null || Array.isArray(root.route)
    || typeof root.quote !== 'object' || root.quote === null || Array.isArray(root.quote)) {
    throw new GeneralizedStrategyQuoteClientError('INVALID_RESPONSE', 'strategy quote response fields are invalid');
  }
  const route = root.route as unknown as TypedStrategyRoute;
  let quote: StrategyPackageQuote;
  let routeHash: string;
  try {
    quote = strategyPackageQuote(root.quote as StrategyPackageQuoteInput);
    routeHash = toHex(typedStrategyRouteHash(route));
  } catch {
    throw new GeneralizedStrategyQuoteClientError('INVALID_RESPONSE', 'strategy quote payload is invalid');
  }
  const quoteHash = toHex(strategyPackageQuoteHash(quote));
  let executionBinding: PackageQuoteExecutionBinding | undefined;
  if (expectedPackageExecution !== undefined) {
    try {
      executionBinding = packageQuoteExecutionBinding(root.executionBinding as PackageQuoteExecutionBindingInput);
    } catch {
      throw new GeneralizedStrategyQuoteClientError('INVALID_RESPONSE', 'strategy quote execution binding is invalid');
    }
  }
  if (routeHash !== root.routeHash || quoteHash !== root.quoteHash
    || toHex(route.orderHash) !== expectedOrderHash || toHex(quote.orderHash) !== expectedOrderHash
    || toHex(route.graphHash) !== root.graphHash || toHex(quote.graphHash) !== root.graphHash
    || !bytesEqual(quote.routeHash, typedStrategyRouteHash(route))
    || (executionBinding !== undefined && (
      toHex(executionBinding.packageOrderId) !== expectedPackageExecution!.packageOrderId
      || toHex(executionBinding.settlementReadinessHash) !== expectedPackageExecution!.settlementReadinessHash
      || toHex(executionBinding.strategyOrderHash) !== expectedOrderHash
      || toHex(executionBinding.strategyQuoteHash) !== quoteHash
      || toHex(executionBinding.routeHash) !== routeHash
      || executionBinding.executionClassId !== quote.executionClassId
      || executionBinding.solverId !== quote.solverId
      || executionBinding.validUntilUnit !== quote.validUntilUnit
      || executionBinding.validUntilValue > quote.validUntilValue
      || executionBinding.solverSignatureScheme !== 'ED25519'
      || !bytesEqual(executionBinding.solverVerificationKey, quote.solverVerificationKey)
      || !verifyEd25519(
        executionBinding.solverVerificationKey,
        packageQuoteExecutionBindingHash(executionBinding),
        executionBinding.signature,
      )
    ))) {
    throw new GeneralizedStrategyQuoteClientError('INVALID_RESPONSE', 'strategy quote commitments are mismatched');
  }
  return Object.freeze({
    version: 1,
    status: 'SIGNED',
    idempotencyKey: expectedIdempotencyKey,
    orderHash: expectedOrderHash,
    graphHash: root.graphHash,
    routeHash,
    quoteHash,
    route,
    quote,
    ...(executionBinding === undefined ? {} : { executionBinding }),
  });
}

export class HttpGeneralizedStrategyQuoteClient implements GeneralizedStrategyQuotePort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  async quote(
    orderHash: string,
    idempotencyKey: string,
    packageExecution?: GeneralizedStrategyPackageExecutionContext,
  ): Promise<GeneralizedStrategyQuoteResult> {
    if (!HASH.test(orderHash) || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new GeneralizedStrategyQuoteClientError('INVALID_REQUEST', 'order hash or idempotency key is invalid');
    }
    if (packageExecution !== undefined && (!HASH.test(packageExecution.packageOrderId)
      || !HASH.test(packageExecution.settlementReadinessHash))) {
      throw new GeneralizedStrategyQuoteClientError('INVALID_REQUEST', 'package execution context is invalid');
    }
    const response = await this.#fetch(`${this.#origin}/internal/strategy-quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderHash, idempotencyKey, ...(packageExecution === undefined ? {} : { packageExecution }) }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) {
      throw new GeneralizedStrategyQuoteClientError('NOT_FOUND', 'stored strategy order was not found');
    }
    if (!response.ok) {
      throw new GeneralizedStrategyQuoteClientError('QUOTE_DECLINED', `strategy quote failed with HTTP ${response.status}`);
    }
    return checkedResponse(await boundedProtocolJson(response), orderHash, idempotencyKey, packageExecution);
  }
}
