import {
  bytesEqual,
  fromProtocolJson,
  packageOrderHash,
  validatePackageOrderProfile,
} from '@naryx/protocol-types';
import type { Hash32, PackageOrder, PackageOrderInput } from '@naryx/protocol-types';
import type { InternalAtomicQuoteOrderProvider } from './internal-atomic-quote-server.js';

const MAX_RESPONSE_BYTES = 1_048_576;

function requireLoopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('internal order endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('internal order endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json' || response.body === null) {
    throw new Error('internal order response must be JSON');
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null && (!/^\d+$/.test(statedLength) || Number(statedLength) > MAX_RESPONSE_BYTES)) {
    throw new Error('internal order response is too large');
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
      throw new Error('internal order response is too large');
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('internal order response is malformed');
  }
}

function decodeResponse(value: unknown, expectedHash: Hash32): PackageOrder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('internal order response must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== 'order' || keys[1] !== 'orderHash' || keys[2] !== 'version'
    || record.version !== 1 || typeof record.orderHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(record.orderHash)) {
    throw new Error('internal order response fields are invalid');
  }
  if (record.orderHash !== Buffer.from(expectedHash).toString('hex')) {
    throw new Error('internal order response hash is mismatched');
  }
  let order: PackageOrder;
  try {
    order = validatePackageOrderProfile(
      fromProtocolJson(record.order, 'internalOrder') as PackageOrderInput,
      'internalOrder',
    );
  } catch {
    throw new Error('internal order document is invalid');
  }
  if (!bytesEqual(packageOrderHash(order), expectedHash)) {
    throw new Error('internal order document hash is mismatched');
  }
  return order;
}

export class HttpInternalOrderProvider {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = requireLoopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  readonly get: InternalAtomicQuoteOrderProvider = async (orderHash) => {
    if (!(orderHash instanceof Uint8Array) || orderHash.length !== 32) {
      throw new Error('order hash must be 32 bytes');
    }
    const response = await this.#fetch(
      `${this.#origin}/internal/solver/orders/${Buffer.from(orderHash).toString('hex')}`,
      {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`internal order retrieval failed with HTTP ${response.status}`);
    return decodeResponse(await readBoundedJson(response), orderHash);
  };
}
