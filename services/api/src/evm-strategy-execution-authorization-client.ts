import {
  commitmentHash,
  fromProtocolJson,
  toHex,
} from '@naryx/protocol-types';
import {
  getAddress,
  isHex,
  type Address,
  type Hex,
} from 'viem';

const MAX_RESPONSE_BYTES = 262_144;
const TEST_CHAIN_IDS = new Set([84_532, 421_614, 31_337, 31_338]);

export interface AuthorizedEvmStrategyExecution {
  readonly version: 1;
  readonly chainId: number;
  readonly to: Address;
  readonly value: 0n;
  readonly data: Hex;
  readonly ownerSignature: Hex;
  readonly solverSignature: Hex;
  readonly packageId: Hex;
  readonly orderHash: Hex;
  readonly quoteHash: Hex;
  readonly routeHash: Hex;
  readonly expectedNextStateHash: Hex;
  readonly deadline: bigint;
}

export interface EvmStrategyExecutionAuthorizationPort {
  authorize(quoteHash: string, ownerSignature: string): Promise<AuthorizedEvmStrategyExecution>;
}

export class EvmStrategyExecutionAuthorizationClientError extends Error {
  readonly code: 'INVALID_ENDPOINT' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_REJECTED' | 'INVALID_RESPONSE';

  constructor(code: EvmStrategyExecutionAuthorizationClientError['code'], message: string) {
    super(message);
    this.name = 'EvmStrategyExecutionAuthorizationClientError';
    this.code = code;
  }
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EvmStrategyExecutionAuthorizationClientError('INVALID_ENDPOINT', 'authorization endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new EvmStrategyExecutionAuthorizationClientError('INVALID_ENDPOINT', 'authorization endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json' || response.body === null) {
    throw new EvmStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', 'authorization response must be JSON');
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
      throw new EvmStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', 'authorization response is too large');
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
    throw new EvmStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', 'authorization response is malformed');
  }
}

function hash(value: unknown, name: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new EvmStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', `${name} is invalid`);
  }
  return value as Hex;
}

function signature(value: unknown, name: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{130}$/.test(value)) {
    throw new EvmStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', `${name} is invalid`);
  }
  return value as Hex;
}

export function validateAuthorizedEvmStrategyExecution(
  value: unknown,
  expectedQuoteHash: string,
  expectedOwnerSignature: string,
): AuthorizedEvmStrategyExecution {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EvmStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', 'authorization response must be an object');
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(',') !== 'authorization,version' || root.version !== 1
    || typeof root.authorization !== 'object' || root.authorization === null || Array.isArray(root.authorization)) {
    throw new EvmStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', 'authorization response fields are invalid');
  }
  const result = root.authorization as Record<string, unknown>;
  if (result.version !== 1 || !Number.isSafeInteger(result.chainId) || !TEST_CHAIN_IDS.has(Number(result.chainId))
    || result.value !== 0n || typeof result.deadline !== 'bigint' || result.deadline <= 0n
    || typeof result.data !== 'string' || !isHex(result.data) || result.data.length < 10) {
    throw new EvmStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', 'authorization transaction is invalid');
  }
  let to: Address;
  try {
    to = getAddress(String(result.to));
  } catch {
    throw new EvmStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', 'authorization target is invalid');
  }
  const ownerSignature = signature(result.ownerSignature, 'ownerSignature');
  if (ownerSignature.toLowerCase() !== expectedOwnerSignature.toLowerCase()) {
    throw new EvmStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', 'authorization owner signature differs from the request');
  }
  const quoteHash = hash(result.quoteHash, 'quoteHash');
  if (quoteHash !== `0x${expectedQuoteHash}`) {
    throw new EvmStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', 'authorization quote differs from the request');
  }
  return Object.freeze({
    version: 1,
    chainId: Number(result.chainId),
    to,
    value: 0n,
    data: result.data as Hex,
    ownerSignature,
    solverSignature: signature(result.solverSignature, 'solverSignature'),
    packageId: hash(result.packageId, 'packageId'),
    orderHash: hash(result.orderHash, 'orderHash'),
    quoteHash,
    routeHash: hash(result.routeHash, 'routeHash'),
    expectedNextStateHash: hash(result.expectedNextStateHash, 'expectedNextStateHash'),
    deadline: result.deadline,
  });
}

export class HttpEvmStrategyExecutionAuthorizationClient implements EvmStrategyExecutionAuthorizationPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  async authorize(quoteHashValue: string, ownerSignature: string): Promise<AuthorizedEvmStrategyExecution> {
    let normalized: string;
    try {
      normalized = toHex(commitmentHash(quoteHashValue, 'quoteHash'));
    } catch {
      throw new EvmStrategyExecutionAuthorizationClientError('INVALID_REQUEST', 'quoteHash must be 32 bytes of lowercase hex');
    }
    if (normalized !== quoteHashValue || !/^0x[0-9a-f]{130}$/.test(ownerSignature)) {
      throw new EvmStrategyExecutionAuthorizationClientError('INVALID_REQUEST', 'quoteHash or ownerSignature is invalid');
    }
    const response = await this.#fetch(`${this.#origin}/internal/strategy-executions/authorize-evm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteHash: quoteHashValue, ownerSignature }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) throw new EvmStrategyExecutionAuthorizationClientError('NOT_FOUND', 'Strategy package was not found');
    if (!response.ok) throw new EvmStrategyExecutionAuthorizationClientError('UPSTREAM_REJECTED', `authorization failed with HTTP ${response.status}`);
    return validateAuthorizedEvmStrategyExecution(await responseJson(response), quoteHashValue, ownerSignature);
  }
}
