import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  crossBatchClearingPolicy,
  fromProtocolJson,
  parseProtocolJson,
  toHex,
  toProtocolJson,
  type CrossBatchClearingPolicy,
  type CrossBatchClearingPolicyInput,
} from '@naryx/protocol-types';

const HASH = /^[0-9a-f]{64}$/;
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;

export type CrossBatchClearingPreparationResult =
  | Readonly<{ status: 'IDLE' }>
  | Readonly<{
      status: 'PREPARED';
      planHashHex: string;
      policyHashHex: string;
      sourceIntentHashes: readonly string[];
      clearingStatus: 'PENDING' | 'EXACT_FILLED' | 'RECOVERY_REQUIRED';
      executionRequired: boolean;
      replayed: boolean;
    }>;

export interface CrossBatchClearingControlPort {
  prepareNext(policy: CrossBatchClearingPolicy): Promise<CrossBatchClearingPreparationResult>;
  execute(planHashHex: string): Promise<void>;
}

export class CrossBatchClearingParticipantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CrossBatchClearingParticipantError';
    this.code = code;
  }
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CrossBatchClearingParticipantError('INVALID_ORIGIN', 'cross-batch API origin is invalid');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new CrossBatchClearingParticipantError('INVALID_ORIGIN', 'cross-batch API must use a loopback HTTP origin');
  }
  return url.origin;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CrossBatchClearingParticipantError('INVALID_RESPONSE', `${context} is malformed`);
  }
  return value as Record<string, unknown>;
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new CrossBatchClearingParticipantError('INVALID_RESPONSE', 'cross-batch API response is too large');
  }
  try {
    return record(fromProtocolJson(JSON.parse(text)), 'cross-batch API response');
  } catch (error) {
    if (error instanceof CrossBatchClearingParticipantError) throw error;
    throw new CrossBatchClearingParticipantError('INVALID_RESPONSE', 'cross-batch API returned invalid protocol JSON');
  }
}

export class HttpCrossBatchClearingControlClient implements CrossBatchClearingControlPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(origin: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(origin);
    this.#fetch = fetchImplementation;
  }

  async #post(path: string, input: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(toProtocolJson(input)),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new CrossBatchClearingParticipantError('UNAVAILABLE', 'cross-batch API request failed');
    }
    const body = await responseBody(response);
    if (!response.ok) {
      const error = record(body.error, 'cross-batch API error');
      throw new CrossBatchClearingParticipantError(
        typeof error.code === 'string' ? error.code : 'REJECTED',
        typeof error.message === 'string' ? error.message : `cross-batch API rejected HTTP ${response.status}`,
      );
    }
    return body;
  }

  async prepareNext(policyInput: CrossBatchClearingPolicy): Promise<CrossBatchClearingPreparationResult> {
    const policy = crossBatchClearingPolicy(policyInput);
    const body = await this.#post('/internal/netting/cross-batch/prepare-next', { policy });
    if (body.version !== 1 || (body.status !== 'IDLE' && body.status !== 'PREPARED')) {
      throw new CrossBatchClearingParticipantError('INVALID_RESPONSE', 'cross-batch preparation response is malformed');
    }
    if (body.status === 'IDLE') return Object.freeze({ status: 'IDLE' });
    const validStatus = body.clearingStatus === 'PENDING'
      || body.clearingStatus === 'EXACT_FILLED'
      || body.clearingStatus === 'RECOVERY_REQUIRED';
    if (typeof body.planHashHex !== 'string' || !HASH.test(body.planHashHex)
      || body.policyHashHex !== toHex(policy.policyHash)
      || !Array.isArray(body.sourceIntentHashes) || body.sourceIntentHashes.length < 2
      || body.sourceIntentHashes.some((value) => typeof value !== 'string' || !HASH.test(value))
      || new Set(body.sourceIntentHashes).size !== body.sourceIntentHashes.length
      || !validStatus || typeof body.executionRequired !== 'boolean'
      || typeof body.replayed !== 'boolean'
      || (body.executionRequired && body.clearingStatus !== 'PENDING')) {
      throw new CrossBatchClearingParticipantError('INVALID_RESPONSE', 'prepared cross-batch response is malformed');
    }
    return Object.freeze({
      status: 'PREPARED',
      planHashHex: body.planHashHex,
      policyHashHex: body.policyHashHex as string,
      sourceIntentHashes: Object.freeze(body.sourceIntentHashes as string[]),
      clearingStatus: body.clearingStatus as 'PENDING' | 'EXACT_FILLED' | 'RECOVERY_REQUIRED',
      executionRequired: body.executionRequired,
      replayed: body.replayed,
    });
  }

  async execute(planHashHex: string): Promise<void> {
    if (!HASH.test(planHashHex)) {
      throw new CrossBatchClearingParticipantError('INVALID_PLAN', 'cross-batch plan hash is invalid');
    }
    const body = await this.#post(`/internal/netting/cross-batch/${planHashHex}/execute`, {});
    if (body.version !== 1) {
      throw new CrossBatchClearingParticipantError('INVALID_RESPONSE', 'cross-batch execution response is malformed');
    }
    const clearing = record(body.clearing, 'cross-batch execution clearing');
    const plan = record(clearing.plan, 'cross-batch execution plan');
    if (!(plan.planHash instanceof Uint8Array) || toHex(plan.planHash) !== planHashHex
      || (clearing.status !== 'EXACT_FILLED' && clearing.status !== 'RECOVERY_REQUIRED')) {
      throw new CrossBatchClearingParticipantError('INVALID_RESPONSE', 'cross-batch execution result is malformed');
    }
  }
}

export function loadCrossBatchClearingPolicies(paths: readonly string[]): readonly CrossBatchClearingPolicy[] {
  if (paths.length === 0) throw new Error('cross-batch clearing requires at least one policy path');
  const policies = paths.map((path, index) => {
    if (!isAbsolute(path)) throw new Error(`cross-batch policy path ${index} must be absolute`);
    const resolved = resolve(path);
    const stat = lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_CONFIG_BYTES) {
      throw new Error(`cross-batch policy path ${index} must be a bounded regular file`);
    }
    let parsed: unknown;
    try {
      parsed = parseProtocolJson(readFileSync(resolved, 'utf8'));
    } catch {
      throw new Error(`cross-batch policy path ${index} is not valid protocol JSON`);
    }
    return crossBatchClearingPolicy(parsed as CrossBatchClearingPolicyInput);
  });
  const hashes = policies.map((policy) => toHex(policy.policyHash));
  if (new Set(hashes).size !== hashes.length) throw new Error('cross-batch clearing policies repeat');
  return Object.freeze(policies);
}

export class CrossBatchClearingParticipant {
  readonly #policies: readonly CrossBatchClearingPolicy[];
  readonly #controls: CrossBatchClearingControlPort;
  #running = false;

  constructor(input: Readonly<{
    policies: readonly CrossBatchClearingPolicy[];
    controls: CrossBatchClearingControlPort;
  }>) {
    if (input.policies.length === 0) throw new Error('cross-batch participant requires at least one policy');
    this.#policies = Object.freeze(input.policies.map((policy) => crossBatchClearingPolicy(policy)));
    this.#controls = input.controls;
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const policy of this.#policies) {
        for (let plan = 0; plan < 10; plan += 1) {
          const prepared = await this.#controls.prepareNext(policy);
          if (prepared.status === 'IDLE') break;
          if (prepared.executionRequired) await this.#controls.execute(prepared.planHashHex);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  start(intervalMs: number, onError: (error: unknown) => void): () => void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) {
      throw new Error('cross-batch clearing poll interval must be at least 100 ms');
    }
    const run = () => { void this.tick().catch(onError); };
    run();
    const timer = setInterval(run, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
