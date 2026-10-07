import {
  fromProtocolJson,
  strategyPackageReceipt,
  toHex,
  type StrategyPackageReceipt,
  type StrategyPackageReceiptInput,
} from '@naryx/protocol-types';
import type { Hex } from 'viem';

const MAX_RESPONSE_BYTES = 1_048_576;

export type ObservedEvmStrategyExecution = Readonly<
  | { version: 1; status: 'PENDING' | 'PENDING_FINALITY'; transactionHash: Hex }
  | {
      version: 1;
      status: 'FINALIZED';
      transactionHash: Hex;
      chainId: number;
      account: Hex;
      packageId: Hex;
      previousStateHash: Hex;
      nextStateHash: Hex;
      onchainReceiptHash: Hex;
      receipt: StrategyPackageReceipt;
    }
>;

export interface EvmStrategyExecutionObservationPort {
  observe(quoteHash: string, transactionHash: string): Promise<ObservedEvmStrategyExecution>;
}

export class EvmStrategyExecutionObservationClientError extends Error {
  readonly code: 'INVALID_ENDPOINT' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_REJECTED' | 'INVALID_RESPONSE';

  constructor(code: EvmStrategyExecutionObservationClientError['code'], message: string) {
    super(message);
    this.name = 'EvmStrategyExecutionObservationClientError';
    this.code = code;
  }
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EvmStrategyExecutionObservationClientError('INVALID_ENDPOINT', 'observation endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new EvmStrategyExecutionObservationClientError('INVALID_ENDPOINT', 'observation endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json' || response.body === null) {
    throw new EvmStrategyExecutionObservationClientError('INVALID_RESPONSE', 'observation response must be JSON');
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
      throw new EvmStrategyExecutionObservationClientError('INVALID_RESPONSE', 'observation response is too large');
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
    throw new EvmStrategyExecutionObservationClientError('INVALID_RESPONSE', 'observation response is malformed');
  }
}

function validateObservation(value: unknown, quoteHash: string, transactionHash: string): ObservedEvmStrategyExecution {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EvmStrategyExecutionObservationClientError('INVALID_RESPONSE', 'observation response must be an object');
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(',') !== 'observation,version' || root.version !== 1
    || typeof root.observation !== 'object' || root.observation === null || Array.isArray(root.observation)) {
    throw new EvmStrategyExecutionObservationClientError('INVALID_RESPONSE', 'observation response fields are invalid');
  }
  const observation = root.observation as Record<string, unknown>;
  if (observation.version !== 1 || observation.transactionHash !== transactionHash
    || (observation.status !== 'PENDING' && observation.status !== 'PENDING_FINALITY' && observation.status !== 'FINALIZED')) {
    throw new EvmStrategyExecutionObservationClientError('INVALID_RESPONSE', 'observation identity or status is invalid');
  }
  if (observation.status !== 'FINALIZED') {
    if (Object.keys(observation).sort().join(',') !== 'status,transactionHash,version') {
      throw new EvmStrategyExecutionObservationClientError('INVALID_RESPONSE', 'pending observation carries unsupported fields');
    }
    return observation as ObservedEvmStrategyExecution;
  }
  if (Object.keys(observation).sort().join(',') !== 'account,chainId,nextStateHash,onchainReceiptHash,packageId,previousStateHash,receipt,status,transactionHash,version'
    || typeof observation.chainId !== 'number' || !Number.isSafeInteger(observation.chainId) || observation.chainId < 1
    || typeof observation.account !== 'string' || !/^0x(?!0{40}$)[0-9a-f]{40}$/.test(observation.account)
    || typeof observation.packageId !== 'string' || !/^0x[0-9a-f]{64}$/.test(observation.packageId)
    || typeof observation.previousStateHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(observation.previousStateHash)
    || typeof observation.nextStateHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(observation.nextStateHash)
    || typeof observation.onchainReceiptHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(observation.onchainReceiptHash)) {
    throw new EvmStrategyExecutionObservationClientError('INVALID_RESPONSE', 'finalized observation fields are invalid');
  }
  const receipt = strategyPackageReceipt(observation.receipt as StrategyPackageReceiptInput);
  if (toHex(receipt.quoteHash) !== quoteHash || receipt.finalityStatus !== 'FINALIZED') {
    throw new EvmStrategyExecutionObservationClientError('INVALID_RESPONSE', 'canonical receipt does not bind the requested finalized quote');
  }
  return Object.freeze({
    version: 1,
    status: 'FINALIZED',
    transactionHash: transactionHash as Hex,
    chainId: observation.chainId,
    account: observation.account as Hex,
    packageId: observation.packageId as Hex,
    previousStateHash: observation.previousStateHash as Hex,
    nextStateHash: observation.nextStateHash as Hex,
    onchainReceiptHash: observation.onchainReceiptHash as Hex,
    receipt,
  });
}

export class HttpEvmStrategyExecutionObservationClient implements EvmStrategyExecutionObservationPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  async observe(quoteHash: string, transactionHash: string): Promise<ObservedEvmStrategyExecution> {
    if (!/^[0-9a-f]{64}$/.test(quoteHash) || !/^0x[0-9a-f]{64}$/.test(transactionHash)) {
      throw new EvmStrategyExecutionObservationClientError('INVALID_REQUEST', 'quoteHash and transactionHash must be lowercase bytes32 values');
    }
    const response = await this.#fetch(`${this.#origin}/internal/strategy-executions/observe-evm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteHash, transactionHash }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) throw new EvmStrategyExecutionObservationClientError('NOT_FOUND', 'No admitted strategy package exists for this quote');
    if (response.status !== 200 && response.status !== 202) {
      throw new EvmStrategyExecutionObservationClientError('UPSTREAM_REJECTED', `strategy observation failed with HTTP ${response.status}`);
    }
    const observation = validateObservation(await responseJson(response), quoteHash, transactionHash);
    if ((response.status === 200) !== (observation.status === 'FINALIZED')) {
      throw new EvmStrategyExecutionObservationClientError('INVALID_RESPONSE', 'observation HTTP status differs from its finality state');
    }
    return observation;
  }
}
