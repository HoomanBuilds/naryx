import bs58 from 'bs58';
import {
  commitmentHash,
  domainRef,
  fromProtocolJson,
  toHex,
  type DomainRef,
} from '@naryx/protocol-types';
import { PublicKey } from '@solana/web3.js';

const MAX_RESPONSE_BYTES = 131_072;
const HASH = /^[0-9a-f]{64}$/;
const FINALIZED_FIELDS = [
  'callsHash',
  'domain',
  'evidenceRoot',
  'graphHash',
  'nextStateHash',
  'nonce',
  'onchainReceiptHash',
  'operation',
  'orderHash',
  'packageId',
  'position',
  'previousStateHash',
  'quoteHash',
  'receiptAccount',
  'routeHash',
  'signature',
  'slot',
  'solver',
  'status',
  'strategyAccount',
  'version',
].sort().join(',');

export type ObservedSolanaStrategyExecution = Readonly<
  | { version: 1; status: 'PENDING' | 'FAILED'; signature: string }
  | {
      version: 1;
      status: 'FINALIZED';
      signature: string;
      domain: DomainRef;
      slot: bigint;
      strategyAccount: string;
      position: string;
      receiptAccount: string;
      packageId: string;
      orderHash: string;
      graphHash: string;
      quoteHash: string;
      routeHash: string;
      operation: string;
      previousStateHash: string;
      nextStateHash: string;
      callsHash: string;
      evidenceRoot: string;
      onchainReceiptHash: string;
      solver: string;
      nonce: bigint;
    }
>;

export interface SolanaStrategyExecutionObservationPort {
  observe(quoteHash: string, signature: string): Promise<ObservedSolanaStrategyExecution>;
}

export class SolanaStrategyExecutionObservationClientError extends Error {
  readonly code: 'INVALID_ENDPOINT' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_REJECTED' | 'INVALID_RESPONSE';

  constructor(code: SolanaStrategyExecutionObservationClientError['code'], message: string) {
    super(message);
    this.name = 'SolanaStrategyExecutionObservationClientError';
    this.code = code;
  }
}

function fail(message: string): never {
  throw new SolanaStrategyExecutionObservationClientError('INVALID_RESPONSE', message);
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new SolanaStrategyExecutionObservationClientError('INVALID_ENDPOINT', 'observation endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new SolanaStrategyExecutionObservationClientError('INVALID_ENDPOINT',
      'observation endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

function signature(value: unknown): string {
  if (typeof value !== 'string') return fail('signature is invalid');
  try {
    const decoded = bs58.decode(value);
    if (decoded.length !== 64 || bs58.encode(decoded) !== value) return fail('signature is invalid');
    return value;
  } catch {
    return fail('signature is invalid');
  }
}

function address(value: unknown, context: string): string {
  try {
    const checked = new PublicKey(String(value));
    if (checked.toBase58() !== value) throw new Error();
    return checked.toBase58();
  } catch {
    return fail(`${context} is invalid`);
  }
}

function hash(value: unknown, context: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) return fail(`${context} is invalid`);
  return value;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(`${context} is invalid`);
  return value as Record<string, unknown>;
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json' || response.body === null) {
    throw new SolanaStrategyExecutionObservationClientError('INVALID_RESPONSE', 'observation response must be JSON');
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
      throw new SolanaStrategyExecutionObservationClientError('INVALID_RESPONSE', 'observation response is too large');
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
    throw new SolanaStrategyExecutionObservationClientError('INVALID_RESPONSE', 'observation response is malformed');
  }
}

function observation(value: unknown, quoteHash: string, expectedSignature: string): ObservedSolanaStrategyExecution {
  const root = record(value, 'observation response');
  if (Object.keys(root).sort().join(',') !== 'observation,version' || root.version !== 1) {
    return fail('observation response fields are invalid');
  }
  const result = record(root.observation, 'observation');
  if (result.version !== 1 || signature(result.signature) !== expectedSignature
    || (result.status !== 'PENDING' && result.status !== 'FAILED' && result.status !== 'FINALIZED')) {
    return fail('observation identity or status is invalid');
  }
  if (result.status !== 'FINALIZED') {
    if (Object.keys(result).sort().join(',') !== 'signature,status,version') {
      return fail('non-finalized observation carries unsupported fields');
    }
    return Object.freeze({ version: 1, status: result.status, signature: expectedSignature });
  }
  if (Object.keys(result).sort().join(',') !== FINALIZED_FIELDS
    || typeof result.slot !== 'bigint' || result.slot <= 0n
    || typeof result.nonce !== 'bigint'
    || typeof result.operation !== 'string' || result.operation.length === 0) {
    return fail('finalized observation fields are invalid');
  }
  const domainInput = record(result.domain, 'observation domain');
  let domain: DomainRef;
  try {
    domain = domainRef(
      String(domainInput.domainId),
      Number(domainInput.domainManifestVersion),
      domainInput.domainManifestHash as Uint8Array,
    );
  } catch {
    return fail('observation domain is invalid');
  }
  const observedQuoteHash = hash(result.quoteHash, 'quote hash');
  if (observedQuoteHash !== quoteHash) return fail('finalized observation changed the requested quote');
  return Object.freeze({
    version: 1,
    status: 'FINALIZED',
    signature: expectedSignature,
    domain,
    slot: result.slot,
    strategyAccount: address(result.strategyAccount, 'strategy account'),
    position: address(result.position, 'strategy position'),
    receiptAccount: address(result.receiptAccount, 'receipt account'),
    packageId: hash(result.packageId, 'package ID'),
    orderHash: hash(result.orderHash, 'order hash'),
    graphHash: hash(result.graphHash, 'graph hash'),
    quoteHash: observedQuoteHash,
    routeHash: hash(result.routeHash, 'route hash'),
    operation: result.operation,
    previousStateHash: hash(result.previousStateHash, 'previous state hash'),
    nextStateHash: hash(result.nextStateHash, 'next state hash'),
    callsHash: hash(result.callsHash, 'calls hash'),
    evidenceRoot: hash(result.evidenceRoot, 'evidence root'),
    onchainReceiptHash: hash(result.onchainReceiptHash, 'onchain receipt hash'),
    solver: address(result.solver, 'solver'),
    nonce: result.nonce,
  });
}

export class HttpSolanaStrategyExecutionObservationClient implements SolanaStrategyExecutionObservationPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  async observe(quoteHashValue: string, signatureValue: string): Promise<ObservedSolanaStrategyExecution> {
    let normalizedQuoteHash: string;
    try {
      normalizedQuoteHash = toHex(commitmentHash(quoteHashValue, 'quoteHash'));
    } catch {
      throw new SolanaStrategyExecutionObservationClientError('INVALID_REQUEST', 'quoteHash must be lowercase hex');
    }
    if (normalizedQuoteHash !== quoteHashValue) {
      throw new SolanaStrategyExecutionObservationClientError('INVALID_REQUEST', 'quoteHash must be lowercase hex');
    }
    let normalizedSignature: string;
    try {
      normalizedSignature = signature(signatureValue);
    } catch {
      throw new SolanaStrategyExecutionObservationClientError('INVALID_REQUEST', 'signature must be canonical base58');
    }
    const response = await this.#fetch(`${this.#origin}/internal/strategy-executions/observe-solana`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteHash: normalizedQuoteHash, signature: normalizedSignature }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) {
      throw new SolanaStrategyExecutionObservationClientError('NOT_FOUND', 'Strategy package was not found');
    }
    if (response.status !== 200 && response.status !== 202) {
      throw new SolanaStrategyExecutionObservationClientError('UPSTREAM_REJECTED',
        `observation failed with HTTP ${response.status}`);
    }
    const result = observation(await responseJson(response), normalizedQuoteHash, normalizedSignature);
    if ((response.status === 202) !== (result.status === 'PENDING')) {
      throw new SolanaStrategyExecutionObservationClientError('INVALID_RESPONSE',
        'observation HTTP status differs from its finality state');
    }
    return result;
  }
}
