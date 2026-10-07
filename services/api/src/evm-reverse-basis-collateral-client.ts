import { fromProtocolJson } from '@naryx/protocol-types';
import type { EvmPackageCollateralAction, EvmPackageCollateralManagementPlan } from '@naryx/adapter-evm';

const MAX_RESPONSE_BYTES = 262_144;
const ADDRESS = /^0x(?!0{40}$)[0-9a-fA-F]{40}$/;
const HASH = /^0x(?!0{64}$)[0-9a-fA-F]{64}$/;
const CALLDATA = /^0x(?:[0-9a-fA-F]{2})+$/;

export interface EvmReverseBasisCollateralPort {
  plan(quoteHash: string, action: EvmPackageCollateralAction): Promise<EvmPackageCollateralManagementPlan>;
}

export class EvmReverseBasisCollateralClientError extends Error {
  readonly code: 'INVALID_ENDPOINT' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_REJECTED' | 'INVALID_RESPONSE';

  constructor(code: EvmReverseBasisCollateralClientError['code'], message: string) {
    super(message);
    this.name = 'EvmReverseBasisCollateralClientError';
    this.code = code;
  }
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EvmReverseBasisCollateralClientError('INVALID_ENDPOINT', 'collateral endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new EvmReverseBasisCollateralClientError('INVALID_ENDPOINT', 'collateral endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json' || response.body === null) {
    throw new EvmReverseBasisCollateralClientError('INVALID_RESPONSE', 'collateral response must be JSON');
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
      throw new EvmReverseBasisCollateralClientError('INVALID_RESPONSE', 'collateral response is too large');
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
    throw new EvmReverseBasisCollateralClientError('INVALID_RESPONSE', 'collateral response is malformed');
  }
}

function plan(value: unknown, quoteHash: string, action: EvmPackageCollateralAction): EvmPackageCollateralManagementPlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EvmReverseBasisCollateralClientError('INVALID_RESPONSE', 'collateral response must be an object');
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(',') !== 'collateral,version' || root.version !== 1
    || typeof root.collateral !== 'object' || root.collateral === null || Array.isArray(root.collateral)) {
    throw new EvmReverseBasisCollateralClientError('INVALID_RESPONSE', 'collateral response fields are invalid');
  }
  const candidate = root.collateral as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.action !== action || !Number.isSafeInteger(candidate.chainId)
    || Number(candidate.chainId) <= 0 || typeof candidate.owner !== 'string'
    || typeof candidate.strategyAccount !== 'string' || typeof candidate.quoteHash !== 'string'
    || candidate.quoteHash.toLowerCase() !== `0x${quoteHash}` || typeof candidate.packageId !== 'string'
    || typeof candidate.intentHash !== 'string' || typeof candidate.assetToken !== 'string'
    || typeof candidate.inputAtoms !== 'bigint' || candidate.inputAtoms <= 0n
    || typeof candidate.minimumOutputAtoms !== 'bigint' || candidate.minimumOutputAtoms <= 0n
    || typeof candidate.maximumOutputAtoms !== 'bigint'
    || candidate.maximumOutputAtoms < candidate.minimumOutputAtoms
    || !ADDRESS.test(candidate.owner) || !ADDRESS.test(candidate.strategyAccount) || !ADDRESS.test(candidate.assetToken)
    || !HASH.test(String(candidate.packageId)) || !HASH.test(String(candidate.intentHash))
    || !Array.isArray(candidate.transactions) || candidate.transactions.length === 0 || !/^[0-9a-f]{64}$/.test(quoteHash)) {
    throw new EvmReverseBasisCollateralClientError('INVALID_RESPONSE', 'collateral plan identity is invalid');
  }
  for (const transaction of candidate.transactions) {
    if (typeof transaction !== 'object' || transaction === null || Array.isArray(transaction)) {
      throw new EvmReverseBasisCollateralClientError('INVALID_RESPONSE', 'collateral transaction is invalid');
    }
    const item = transaction as Record<string, unknown>;
    if ((item.kind !== 'RESET_COLLATERAL_ALLOWANCE' && item.kind !== 'APPROVE_COLLATERAL'
      && item.kind !== 'MANAGE_PACKAGE_COLLATERAL') || typeof item.to !== 'string'
      || !ADDRESS.test(item.to) || typeof item.data !== 'string' || !CALLDATA.test(item.data) || item.value !== 0n) {
      throw new EvmReverseBasisCollateralClientError('INVALID_RESPONSE', 'collateral transaction fields are invalid');
    }
  }
  return root.collateral as unknown as EvmPackageCollateralManagementPlan;
}

export class HttpEvmReverseBasisCollateralClient implements EvmReverseBasisCollateralPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  async plan(quoteHash: string, action: EvmPackageCollateralAction): Promise<EvmPackageCollateralManagementPlan> {
    if (!/^[0-9a-f]{64}$/.test(quoteHash) || (action !== 'SUPPLY' && action !== 'WITHDRAW')) {
      throw new EvmReverseBasisCollateralClientError('INVALID_REQUEST', 'quoteHash or collateral action is invalid');
    }
    const response = await this.#fetch(`${this.#origin}/internal/strategy-executions/reverse-basis-collateral`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteHash, action }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) throw new EvmReverseBasisCollateralClientError('NOT_FOUND', 'strategy quote was not found');
    if (!response.ok) throw new EvmReverseBasisCollateralClientError('UPSTREAM_REJECTED', `collateral planning failed with HTTP ${response.status}`);
    return plan(await responseJson(response), quoteHash, action);
  }
}
