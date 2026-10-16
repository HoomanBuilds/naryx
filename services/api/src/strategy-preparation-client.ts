import {
  bytesEqual,
  commitmentHash,
  fromProtocolJson,
  toHex,
  type Hash32,
} from '@naryx/protocol-types';
import { getAddress } from 'viem';

const MAX_RESPONSE_BYTES = 2_097_152;
const TIMEOUT_MS = 30_000;

export interface EvmStrategyFundingRequirement {
  readonly version: 1;
  readonly quoteHash: string;
  readonly chainId: number;
  readonly strategyAccount: string;
  readonly token: string;
  readonly balanceAtoms: string;
  readonly requiredAtoms: string;
  readonly deficitAtoms: string;
}

function fundingRequirement(value: unknown, quoteHash: string): EvmStrategyFundingRequirement {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StrategyPreparationClientError('INVALID_RESPONSE', 'funding requirement is invalid');
  }
  const f = value as Record<string, unknown>;
  const atoms = (value: unknown): bigint => {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= (1n << 256n)) {
      throw new StrategyPreparationClientError('INVALID_RESPONSE', 'funding amount is invalid');
    }
    return BigInt(value);
  };
  try {
    if (Object.keys(f).sort().join(',') !== 'balanceAtoms,chainId,deficitAtoms,quoteHash,requiredAtoms,strategyAccount,token,version'
      || f.version !== 1 || f.quoteHash !== quoteHash || (f.chainId !== 84_532 && f.chainId !== 421_614)
      || typeof f.strategyAccount !== 'string' || typeof f.token !== 'string'
      || !/^0x(?!0{40}$)[0-9a-f]{40}$/i.test(f.strategyAccount) || !/^0x(?!0{40}$)[0-9a-f]{40}$/i.test(f.token)
      || atoms(f.requiredAtoms) <= atoms(f.balanceAtoms) || atoms(f.deficitAtoms) !== atoms(f.requiredAtoms) - atoms(f.balanceAtoms)) {
      throw new Error('invalid binding');
    }
    getAddress(f.strategyAccount);
    getAddress(f.token);
  } catch {
    throw new StrategyPreparationClientError('INVALID_RESPONSE', 'funding requirement does not bind the testnet quote');
  }
  return Object.freeze({ ...f }) as unknown as EvmStrategyFundingRequirement;
}

export interface GeneralizedStrategyPreparation {
  readonly version: 1;
  readonly prepared: Readonly<{
    version: 1;
    quoteHash: Hash32;
    domains: readonly unknown[];
  }> & Readonly<Record<string, unknown>>;
}

export interface GeneralizedStrategyPreparationPort {
  prepare(quoteHashHex: string): Promise<GeneralizedStrategyPreparation>;
}

export class StrategyPreparationClientError extends Error {
  readonly code: 'INVALID_ENDPOINT' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_REJECTED' | 'INVALID_RESPONSE'
    | 'ACCOUNT_FUNDING_REQUIRED' | 'MINIMUM_MARGIN_REQUIRED' | 'QUOTE_EXPIRED';
  readonly funding: EvmStrategyFundingRequirement | undefined;

  constructor(code: StrategyPreparationClientError['code'], message: string, funding?: EvmStrategyFundingRequirement) {
    super(message);
    this.name = 'StrategyPreparationClientError';
    this.code = code;
    this.funding = funding;
  }
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new StrategyPreparationClientError('INVALID_ENDPOINT', 'strategy preparation endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new StrategyPreparationClientError('INVALID_ENDPOINT', 'strategy preparation endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json' || response.body === null) {
    throw new StrategyPreparationClientError('INVALID_RESPONSE', 'strategy preparation response must be JSON');
  }
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > MAX_RESPONSE_BYTES)) {
    throw new StrategyPreparationClientError('INVALID_RESPONSE', 'strategy preparation response is too large');
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
      throw new StrategyPreparationClientError('INVALID_RESPONSE', 'strategy preparation response is too large');
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
    throw new StrategyPreparationClientError('INVALID_RESPONSE', 'strategy preparation response is malformed');
  }
}

function validateResponse(value: unknown, expectedQuoteHash: Hash32): GeneralizedStrategyPreparation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new StrategyPreparationClientError('INVALID_RESPONSE', 'strategy preparation response must be an object');
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(',') !== 'prepared,version' || root.version !== 1
    || typeof root.prepared !== 'object' || root.prepared === null || Array.isArray(root.prepared)) {
    throw new StrategyPreparationClientError('INVALID_RESPONSE', 'strategy preparation response fields are invalid');
  }
  const prepared = root.prepared as Record<string, unknown>;
  if (prepared.version !== 1 || !(prepared.quoteHash instanceof Uint8Array)
    || !bytesEqual(prepared.quoteHash, expectedQuoteHash) || !Array.isArray(prepared.domains)
    || prepared.domains.length === 0) {
    throw new StrategyPreparationClientError('INVALID_RESPONSE', 'prepared execution does not bind the requested quote');
  }
  return value as GeneralizedStrategyPreparation;
}

export class HttpStrategyPreparationClient implements GeneralizedStrategyPreparationPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  async prepare(quoteHashHex: string): Promise<GeneralizedStrategyPreparation> {
    let quoteHash: Hash32;
    try {
      quoteHash = commitmentHash(quoteHashHex, 'quoteHash');
    } catch {
      throw new StrategyPreparationClientError('INVALID_REQUEST', 'quoteHash must be 32 bytes of lowercase hex');
    }
    if (toHex(quoteHash) !== quoteHashHex) throw new StrategyPreparationClientError('INVALID_REQUEST', 'quoteHash must be lowercase hex');
    const response = await this.#fetch(`${this.#origin}/internal/strategy-executions/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteHash: quoteHashHex }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) throw new StrategyPreparationClientError('NOT_FOUND', 'No admitted strategy package exists for this quote');
    if (response.status === 400) {
      const body = await boundedJson(response) as { error?: { code?: unknown; message?: unknown; funding?: unknown } };
      if (body?.error?.code === 'ACCOUNT_FUNDING_REQUIRED') {
        throw new StrategyPreparationClientError('ACCOUNT_FUNDING_REQUIRED',
          'Fund the isolated strategy account with the exact test-token shortfall, then request a fresh quote.',
          fundingRequirement(body.error.funding, quoteHashHex));
      }
      if (body?.error?.code === 'PREPARATION_REJECTED') {
        if (body.error.message === 'strategy account lacks quote balance after maximum spend for recovery') {
          throw new StrategyPreparationClientError('ACCOUNT_FUNDING_REQUIRED',
            'Fund the isolated strategy account with the required test quote tokens plus its recovery reserve, then request a fresh quote.');
        }
        if (body.error.message === 'quoted margin is below the risk-policy floor') {
          throw new StrategyPreparationClientError('MINIMUM_MARGIN_REQUIRED',
            'Increase the package size until its quoted margin is at least 1 test USDC. Nothing was signed or submitted.');
        }
        if (body.error.message === 'EVM calendar spread preparation refused: order, quote, or route expired') {
          throw new StrategyPreparationClientError('QUOTE_EXPIRED', 'This quote expired. Request a fresh quote before preparing the package.');
        }
      }
    }
    if (!response.ok) throw new StrategyPreparationClientError('UPSTREAM_REJECTED', `strategy preparation failed with HTTP ${response.status}`);
    return validateResponse(await boundedJson(response), quoteHash);
  }
}
