import {
  bytesEqual,
  fromProtocolJson,
  packageGraph,
  packageGraphHash,
  packageQuoteExecutionBinding,
  packageQuoteExecutionBindingHash,
  packageSettlementReadiness,
  packageSettlementReadinessHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  strategyPackageQuote,
  strategyPackageQuoteHash,
  toHex,
  typedStrategyRouteHash,
  validatePackageQuoteExecutionBinding,
  type Hash32,
  type PackageGraph,
  type PackageGraphInput,
  type PackageQuoteExecutionBinding,
  type PackageQuoteExecutionBindingInput,
  type PackageSettlementReadiness,
  type PackageSettlementReadinessInput,
  type StrategyPackageOrder,
  type StrategyPackageOrderInput,
  type StrategyPackageQuote,
  type StrategyPackageQuoteInput,
  type TypedStrategyRoute,
} from '@naryx/protocol-types';

const MAX_RESPONSE_BYTES = 1_048_576;

export interface StoredStrategyPackageDocuments {
  readonly orderHashHex: string;
  readonly graphHashHex: string;
  readonly quoteHashHex: string;
  readonly routeHashHex: string;
  readonly order: StrategyPackageOrder;
  readonly graph: PackageGraph;
  readonly quote: StrategyPackageQuote;
  readonly route: TypedStrategyRoute;
  readonly recordedAtMs: number;
  readonly packageExecutionLock?: Readonly<{ packageOrderIdHex: string; recordedAtMs: number }>;
  readonly packageExecution?: StoredStrategyPackageExecution;
}

export interface StoredStrategyPackageExecution {
  readonly readinessHashHex: string;
  readonly readiness: PackageSettlementReadiness;
  readonly recordedAtMs: number;
  readonly bindingHashHex?: string;
  readonly binding?: PackageQuoteExecutionBinding;
  readonly bindingRecordedAtMs?: number;
}

export interface StoredStrategyPackageOrderDocuments {
  readonly orderHashHex: string;
  readonly graphHashHex: string;
  readonly order: StrategyPackageOrder;
  readonly graph: PackageGraph;
  readonly recordedAtMs: number;
}

export interface StrategyPackageProvider {
  getByQuote(quoteHash: Hash32): Promise<StoredStrategyPackageDocuments | undefined>;
}

export interface StrategyPackageOrderProvider {
  getByOrder(orderHash: Hash32): Promise<StoredStrategyPackageOrderDocuments | undefined>;
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('strategy package endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('strategy package endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

async function boundedProtocolJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json' || response.body === null) throw new Error('strategy package response must be JSON');
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null && (!/^\d+$/.test(statedLength) || Number(statedLength) > MAX_RESPONSE_BYTES)) {
    throw new Error('strategy package response is too large');
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
      throw new Error('strategy package response is too large');
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
    throw new Error('strategy package response is malformed');
  }
}

function decodeDocuments(value: unknown, expectedQuoteHash: Hash32): StoredStrategyPackageDocuments {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('strategy package response must be an object');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const hasPackageExecution = Object.hasOwn(record, 'packageExecution');
  const hasPackageExecutionLock = Object.hasOwn(record, 'packageExecutionLock');
  const expectedKeys = [
    'graph', 'graphHashHex', 'order', 'orderHashHex', ...(hasPackageExecutionLock ? ['packageExecutionLock'] : []),
    ...(hasPackageExecution ? ['packageExecution'] : []),
    'quote', 'quoteHashHex', 'recordedAtMs', 'route', 'routeHashHex', 'version',
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) || record.version !== 1) {
    throw new Error('strategy package response fields are invalid');
  }
  for (const field of ['graphHashHex', 'orderHashHex', 'quoteHashHex', 'routeHashHex'] as const) {
    if (typeof record[field] !== 'string' || !/^[0-9a-f]{64}$/.test(record[field])) throw new Error('strategy package response hash is invalid');
  }
  if (!Number.isSafeInteger(record.recordedAtMs) || Number(record.recordedAtMs) < 0) throw new Error('strategy package response time is invalid');
  let order: StrategyPackageOrder;
  let graph: PackageGraph;
  let quote: StrategyPackageQuote;
  let route: TypedStrategyRoute;
  try {
    order = strategyPackageOrder(record.order as StrategyPackageOrderInput);
    graph = packageGraph(record.graph as PackageGraphInput);
    quote = strategyPackageQuote(record.quote as StrategyPackageQuoteInput);
    route = record.route as TypedStrategyRoute;
  } catch {
    throw new Error('strategy package documents are invalid');
  }
  const orderHashHex = toHex(strategyPackageOrderHash(order));
  const graphHashHex = toHex(packageGraphHash(graph));
  const quoteHashHex = toHex(strategyPackageQuoteHash(quote));
  let routeHashHex: string;
  try {
    routeHashHex = toHex(typedStrategyRouteHash(route));
  } catch {
    throw new Error('strategy package route is invalid');
  }
  if (orderHashHex !== record.orderHashHex || graphHashHex !== record.graphHashHex
    || quoteHashHex !== record.quoteHashHex || routeHashHex !== record.routeHashHex
    || !bytesEqual(expectedQuoteHash, strategyPackageQuoteHash(quote))
    || !bytesEqual(order.graphHash, packageGraphHash(graph))
    || !bytesEqual(quote.orderHash, strategyPackageOrderHash(order))
    || !bytesEqual(quote.routeHash, typedStrategyRouteHash(route))) {
    throw new Error('strategy package response commitments are mismatched');
  }
  let packageExecution: StoredStrategyPackageExecution | undefined;
  let packageExecutionLock: StoredStrategyPackageDocuments['packageExecutionLock'];
  if (hasPackageExecutionLock) {
    if (typeof record.packageExecutionLock !== 'object' || record.packageExecutionLock === null
      || Array.isArray(record.packageExecutionLock)) {
      throw new Error('strategy package execution lock is invalid');
    }
    const lock = record.packageExecutionLock as Record<string, unknown>;
    if (Object.keys(lock).sort().join(',') !== 'packageOrderIdHex,recordedAtMs'
      || typeof lock.packageOrderIdHex !== 'string' || !/^[0-9a-f]{64}$/.test(lock.packageOrderIdHex)
      || !Number.isSafeInteger(lock.recordedAtMs) || Number(lock.recordedAtMs) < 0) {
      throw new Error('strategy package execution lock fields are invalid');
    }
    packageExecutionLock = Object.freeze({
      packageOrderIdHex: lock.packageOrderIdHex,
      recordedAtMs: Number(lock.recordedAtMs),
    });
  }
  if (hasPackageExecution) {
    if (typeof record.packageExecution !== 'object' || record.packageExecution === null
      || Array.isArray(record.packageExecution)) {
      throw new Error('strategy package execution requirement is invalid');
    }
    const execution = record.packageExecution as Record<string, unknown>;
    const hasBinding = Object.hasOwn(execution, 'binding');
    const executionKeys = Object.keys(execution).sort();
    const expectedExecutionKeys = [
      ...(hasBinding ? ['binding', 'bindingHashHex', 'bindingRecordedAtMs'] : []),
      'readiness', 'readinessHashHex', 'recordedAtMs',
    ].sort();
    if (executionKeys.length !== expectedExecutionKeys.length
      || executionKeys.some((key, index) => key !== expectedExecutionKeys[index])
      || typeof execution.readinessHashHex !== 'string' || !/^[0-9a-f]{64}$/.test(execution.readinessHashHex)
      || !Number.isSafeInteger(execution.recordedAtMs) || Number(execution.recordedAtMs) < 0) {
      throw new Error('strategy package execution requirement fields are invalid');
    }
    let readiness: PackageSettlementReadiness;
    try {
      readiness = packageSettlementReadiness(execution.readiness as PackageSettlementReadinessInput);
    } catch {
      throw new Error('strategy package settlement readiness is invalid');
    }
    if (toHex(packageSettlementReadinessHash(readiness)) !== execution.readinessHashHex
      || !bytesEqual(readiness.strategyOrderHash, strategyPackageOrderHash(order))) {
      throw new Error('strategy package execution requirement commitments are mismatched');
    }
    if (hasBinding) {
      if (typeof execution.bindingHashHex !== 'string' || !/^[0-9a-f]{64}$/.test(execution.bindingHashHex)
        || !Number.isSafeInteger(execution.bindingRecordedAtMs) || Number(execution.bindingRecordedAtMs) < 0) {
        throw new Error('strategy package execution binding fields are invalid');
      }
      let binding: PackageQuoteExecutionBinding;
      try {
        binding = packageQuoteExecutionBinding(execution.binding as PackageQuoteExecutionBindingInput);
        validatePackageQuoteExecutionBinding(binding, readiness, quote);
      } catch {
        throw new Error('strategy package execution binding is invalid');
      }
      if (toHex(packageQuoteExecutionBindingHash(binding)) !== execution.bindingHashHex) {
        throw new Error('strategy package execution binding commitment is mismatched');
      }
      packageExecution = Object.freeze({
        readinessHashHex: execution.readinessHashHex,
        readiness,
        recordedAtMs: Number(execution.recordedAtMs),
        bindingHashHex: execution.bindingHashHex,
        binding,
        bindingRecordedAtMs: Number(execution.bindingRecordedAtMs),
      });
    } else {
      packageExecution = Object.freeze({
        readinessHashHex: execution.readinessHashHex,
        readiness,
        recordedAtMs: Number(execution.recordedAtMs),
      });
    }
  }
  return Object.freeze({
    orderHashHex,
    graphHashHex,
    quoteHashHex,
    routeHashHex,
    order,
    graph,
    quote,
    route,
    recordedAtMs: Number(record.recordedAtMs),
    ...(packageExecutionLock === undefined ? {} : { packageExecutionLock }),
    ...(packageExecution === undefined ? {} : { packageExecution }),
  });
}

function decodeOrderDocuments(value: unknown, expectedOrderHash: Hash32): StoredStrategyPackageOrderDocuments {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('strategy package order response must be an object');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ['graph', 'graphHashHex', 'order', 'orderHashHex', 'recordedAtMs', 'version'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) || record.version !== 1) {
    throw new Error('strategy package order response fields are invalid');
  }
  if (typeof record.graphHashHex !== 'string' || !/^[0-9a-f]{64}$/.test(record.graphHashHex)
    || typeof record.orderHashHex !== 'string' || !/^[0-9a-f]{64}$/.test(record.orderHashHex)
    || !Number.isSafeInteger(record.recordedAtMs) || Number(record.recordedAtMs) < 0) {
    throw new Error('strategy package order response identity is invalid');
  }
  let order: StrategyPackageOrder;
  let graph: PackageGraph;
  try {
    order = strategyPackageOrder(record.order as StrategyPackageOrderInput);
    graph = packageGraph(record.graph as PackageGraphInput);
  } catch {
    throw new Error('strategy package order documents are invalid');
  }
  const orderHashHex = toHex(strategyPackageOrderHash(order));
  const graphHashHex = toHex(packageGraphHash(graph));
  if (orderHashHex !== record.orderHashHex || graphHashHex !== record.graphHashHex
    || !bytesEqual(expectedOrderHash, strategyPackageOrderHash(order))
    || !bytesEqual(order.graphHash, packageGraphHash(graph))) {
    throw new Error('strategy package order commitments are mismatched');
  }
  return Object.freeze({
    orderHashHex,
    graphHashHex,
    order,
    graph,
    recordedAtMs: Number(record.recordedAtMs),
  });
}

export class HttpStrategyPackageProvider implements StrategyPackageProvider, StrategyPackageOrderProvider {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  async getByQuote(quoteHash: Hash32): Promise<StoredStrategyPackageDocuments | undefined> {
    if (!(quoteHash instanceof Uint8Array) || quoteHash.length !== 32) throw new Error('quote hash must be 32 bytes');
    const hashHex = toHex(quoteHash);
    const response = await this.#fetch(`${this.#origin}/internal/strategy-packages/quotes/${hashHex}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`strategy package retrieval failed with HTTP ${response.status}`);
    return decodeDocuments(await boundedProtocolJson(response), quoteHash);
  }

  async getByOrder(orderHash: Hash32): Promise<StoredStrategyPackageOrderDocuments | undefined> {
    if (!(orderHash instanceof Uint8Array) || orderHash.length !== 32) throw new Error('order hash must be 32 bytes');
    const hashHex = toHex(orderHash);
    const response = await this.#fetch(`${this.#origin}/internal/strategy-packages/orders/${hashHex}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`strategy package order retrieval failed with HTTP ${response.status}`);
    return decodeOrderDocuments(await boundedProtocolJson(response), orderHash);
  }
}
