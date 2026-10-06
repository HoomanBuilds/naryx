import {
  commitmentHash,
  fromProtocolJson,
  toHex,
} from '@naryx/protocol-types';
import type { EvmStrategyProvisioningPlan } from '@naryx/adapter-evm';
import { getAddress, type Address } from 'viem';

const MAX_RESPONSE_BYTES = 262_144;

export interface EvmOptionSpreadProvisioningPort {
  provision(orderHashHex: string): Promise<EvmStrategyProvisioningPlan>;
  resolveAccount(input: Readonly<{ chainId: number; factory: string; owner: string }>): Promise<Readonly<{
    chainId: number;
    factory: Address;
    owner: Address;
    account: Address;
    deployed: boolean;
  }>>;
}

export class EvmOptionSpreadProvisioningClientError extends Error {
  readonly code: 'INVALID_ENDPOINT' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_REJECTED' | 'INVALID_RESPONSE';

  constructor(code: EvmOptionSpreadProvisioningClientError['code'], message: string) {
    super(message);
    this.name = 'EvmOptionSpreadProvisioningClientError';
    this.code = code;
  }
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EvmOptionSpreadProvisioningClientError('INVALID_ENDPOINT', 'provisioning endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new EvmOptionSpreadProvisioningClientError('INVALID_ENDPOINT', 'provisioning endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json' || response.body === null) {
    throw new EvmOptionSpreadProvisioningClientError('INVALID_RESPONSE', 'provisioning response must be JSON');
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
      throw new EvmOptionSpreadProvisioningClientError('INVALID_RESPONSE', 'provisioning response is too large');
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
    throw new EvmOptionSpreadProvisioningClientError('INVALID_RESPONSE', 'provisioning response is malformed');
  }
}

function plan(value: unknown, expectedOrderHash: string): EvmStrategyProvisioningPlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EvmOptionSpreadProvisioningClientError('INVALID_RESPONSE', 'provisioning response must be an object');
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(',') !== 'provisioning,version' || root.version !== 1
    || typeof root.provisioning !== 'object' || root.provisioning === null || Array.isArray(root.provisioning)) {
    throw new EvmOptionSpreadProvisioningClientError('INVALID_RESPONSE', 'provisioning response fields are invalid');
  }
  const candidate = root.provisioning as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.packageId !== `0x${expectedOrderHash}`
    || !Number.isSafeInteger(candidate.chainId) || Number(candidate.chainId) <= 0
    || typeof candidate.owner !== 'string' || typeof candidate.strategyAccount !== 'string'
    || typeof candidate.ready !== 'boolean' || !Array.isArray(candidate.transactions)
    || candidate.ready !== (candidate.transactions.length === 0)) {
    throw new EvmOptionSpreadProvisioningClientError('INVALID_RESPONSE', 'provisioning plan identity is invalid');
  }
  for (const transaction of candidate.transactions) {
    if (typeof transaction !== 'object' || transaction === null || Array.isArray(transaction)) {
      throw new EvmOptionSpreadProvisioningClientError('INVALID_RESPONSE', 'provisioning transaction is invalid');
    }
    const item = transaction as Record<string, unknown>;
    if ((item.kind !== 'CREATE_STRATEGY_ACCOUNT' && item.kind !== 'CREATE_PACKAGE_ADAPTER')
      || typeof item.to !== 'string' || typeof item.data !== 'string' || item.value !== 0n
      || typeof item.expectedAddress !== 'string' || typeof item.expectedCodeHash !== 'string') {
      throw new EvmOptionSpreadProvisioningClientError('INVALID_RESPONSE', 'provisioning transaction fields are invalid');
    }
  }
  return root.provisioning as unknown as EvmStrategyProvisioningPlan;
}

export class HttpEvmOptionSpreadProvisioningClient implements EvmOptionSpreadProvisioningPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  async provision(orderHashHex: string): Promise<EvmStrategyProvisioningPlan> {
    let normalized: string;
    try {
      normalized = toHex(commitmentHash(orderHashHex, 'orderHash'));
    } catch {
      throw new EvmOptionSpreadProvisioningClientError('INVALID_REQUEST', 'orderHash must be 32 bytes of lowercase hex');
    }
    if (normalized !== orderHashHex) {
      throw new EvmOptionSpreadProvisioningClientError('INVALID_REQUEST', 'orderHash must be lowercase hex');
    }
    const response = await this.#fetch(`${this.#origin}/internal/strategy-executions/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderHash: orderHashHex }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) throw new EvmOptionSpreadProvisioningClientError('NOT_FOUND', 'Strategy order was not found');
    if (!response.ok) throw new EvmOptionSpreadProvisioningClientError('UPSTREAM_REJECTED', `provisioning failed with HTTP ${response.status}`);
    return plan(await responseJson(response), orderHashHex);
  }

  async resolveAccount(input: Readonly<{ chainId: number; factory: string; owner: string }>) {
    if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
      throw new EvmOptionSpreadProvisioningClientError('INVALID_REQUEST', 'chainId is invalid');
    }
    let factory: Address;
    let owner: Address;
    try {
      factory = getAddress(input.factory);
      owner = getAddress(input.owner);
    } catch {
      throw new EvmOptionSpreadProvisioningClientError('INVALID_REQUEST', 'factory or owner is invalid');
    }
    const response = await this.#fetch(`${this.#origin}/internal/strategy-accounts/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId: input.chainId, factory, owner }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new EvmOptionSpreadProvisioningClientError('UPSTREAM_REJECTED', `account resolution failed with HTTP ${response.status}`);
    const value = await responseJson(response);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new EvmOptionSpreadProvisioningClientError('INVALID_RESPONSE', 'account response must be an object');
    }
    const root = value as Record<string, unknown>;
    if (Object.keys(root).sort().join(',') !== 'account,version' || root.version !== 1
      || typeof root.account !== 'object' || root.account === null || Array.isArray(root.account)) {
      throw new EvmOptionSpreadProvisioningClientError('INVALID_RESPONSE', 'account response fields are invalid');
    }
    const accountValue = root.account as Record<string, unknown>;
    let account: Address;
    try {
      account = getAddress(String(accountValue.account));
    } catch {
      throw new EvmOptionSpreadProvisioningClientError('INVALID_RESPONSE', 'resolved strategy account is invalid');
    }
    if (accountValue.chainId !== input.chainId || getAddress(String(accountValue.factory)) !== factory
      || getAddress(String(accountValue.owner)) !== owner || typeof accountValue.deployed !== 'boolean') {
      throw new EvmOptionSpreadProvisioningClientError('INVALID_RESPONSE', 'account response identity differs from the request');
    }
    return Object.freeze({ chainId: input.chainId, factory, owner, account, deployed: accountValue.deployed });
  }
}
