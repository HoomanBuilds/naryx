import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  fromProtocolJson,
  nettingPolicyManifest,
  nettingPolicyManifestHash,
  parseProtocolJson,
  toHex,
  toProtocolJson,
  type NettingPolicyManifest,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';

const HASH = /^[0-9a-f]{64}$/;
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;

export type NettingBatchPreparationResult =
  | Readonly<{ status: 'IDLE' }>
  | Readonly<{
      status: 'PREPARED';
      proofHashHex: string;
      policyHashHex: string;
      packageOrderIds: readonly string[];
      replayed: boolean;
    }>;

export interface NettingBatchPreparationPort {
  prepareNext(policy: NettingPolicyManifest): Promise<NettingBatchPreparationResult>;
}

export class NettingBatchParticipantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NettingBatchParticipantError';
    this.code = code;
  }
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NettingBatchParticipantError('INVALID_ORIGIN', 'netting batch API origin is invalid');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new NettingBatchParticipantError('INVALID_ORIGIN', 'netting batch API must use a loopback HTTP origin');
  }
  return url.origin;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NettingBatchParticipantError('INVALID_RESPONSE', `${context} is malformed`);
  }
  return value as Record<string, unknown>;
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new NettingBatchParticipantError('INVALID_RESPONSE', 'netting batch API response is too large');
  }
  try {
    return record(fromProtocolJson(JSON.parse(text)), 'netting batch API response');
  } catch (error) {
    if (error instanceof NettingBatchParticipantError) throw error;
    throw new NettingBatchParticipantError('INVALID_RESPONSE', 'netting batch API returned invalid protocol JSON');
  }
}

export class HttpNettingBatchPreparationClient implements NettingBatchPreparationPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(origin: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(origin);
    this.#fetch = fetchImplementation;
  }

  async prepareNext(policyInput: NettingPolicyManifest): Promise<NettingBatchPreparationResult> {
    const policy = nettingPolicyManifest(policyInput);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}/internal/netting/batches/prepare-next`, {
        method: 'POST',
        redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(toProtocolJson({ policy })),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new NettingBatchParticipantError('UNAVAILABLE', 'netting batch API request failed');
    }
    const body = await responseBody(response);
    if (!response.ok) {
      const error = record(body.error, 'netting batch API error');
      throw new NettingBatchParticipantError(
        typeof error.code === 'string' ? error.code : 'REJECTED',
        typeof error.message === 'string' ? error.message : `netting batch API rejected HTTP ${response.status}`,
      );
    }
    if (body.version !== 1 || (body.status !== 'IDLE' && body.status !== 'PREPARED')) {
      throw new NettingBatchParticipantError('INVALID_RESPONSE', 'netting batch API response fields are malformed');
    }
    if (body.status === 'IDLE') return Object.freeze({ status: 'IDLE' });
    const expectedPolicyHash = toHex(nettingPolicyManifestHash(policy));
    if (typeof body.proofHashHex !== 'string' || !HASH.test(body.proofHashHex)
      || body.policyHashHex !== expectedPolicyHash
      || !Array.isArray(body.packageOrderIds) || body.packageOrderIds.length === 0
      || body.packageOrderIds.some((value) => typeof value !== 'string' || !HASH.test(value))
      || new Set(body.packageOrderIds).size !== body.packageOrderIds.length
      || typeof body.replayed !== 'boolean') {
      throw new NettingBatchParticipantError('INVALID_RESPONSE', 'prepared netting batch response is malformed');
    }
    return Object.freeze({
      status: 'PREPARED',
      proofHashHex: body.proofHashHex,
      policyHashHex: expectedPolicyHash,
      packageOrderIds: Object.freeze(body.packageOrderIds as string[]),
      replayed: body.replayed,
    });
  }
}

export function loadNettingBatchPolicies(paths: readonly string[]): readonly NettingPolicyManifest[] {
  if (paths.length === 0) throw new Error('netting batch preparation requires at least one policy path');
  const policies = paths.map((path, index) => {
    if (!isAbsolute(path)) throw new Error(`netting batch policy path ${index} must be absolute`);
    const resolved = resolve(path);
    const stat = lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_CONFIG_BYTES) {
      throw new Error(`netting batch policy path ${index} must be a bounded regular file`);
    }
    let parsed: unknown;
    try {
      parsed = parseProtocolJson(readFileSync(resolved, 'utf8'));
    } catch {
      throw new Error(`netting batch policy path ${index} is not valid protocol JSON`);
    }
    return nettingPolicyManifest(parsed as NettingPolicyManifestInput, `nettingBatchPolicies[${index}]`);
  });
  const hashes = policies.map((policy) => toHex(nettingPolicyManifestHash(policy)));
  if (new Set(hashes).size !== hashes.length) throw new Error('netting batch policies repeat');
  return Object.freeze(policies);
}

export class NettingBatchParticipant {
  readonly #policies: readonly NettingPolicyManifest[];
  readonly #preparation: NettingBatchPreparationPort;
  #running = false;

  constructor(input: Readonly<{
    policies: readonly NettingPolicyManifest[];
    preparation: NettingBatchPreparationPort;
  }>) {
    if (input.policies.length === 0) throw new Error('netting batch participant requires at least one policy');
    this.#policies = Object.freeze(input.policies.map((policy) => nettingPolicyManifest(policy)));
    this.#preparation = input.preparation;
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const policy of this.#policies) {
        for (let batch = 0; batch < 10; batch += 1) {
          if ((await this.#preparation.prepareNext(policy)).status === 'IDLE') break;
        }
      }
    } finally {
      this.#running = false;
    }
  }

  start(intervalMs: number, onError: (error: unknown) => void): () => void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) {
      throw new Error('netting batch poll interval must be at least 100 ms');
    }
    const run = () => { void this.tick().catch(onError); };
    run();
    const timer = setInterval(run, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
