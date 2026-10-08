import type { EvmNettingAllocationObservationBinding } from '@naryx/adapter-evm';
import type { SolanaNettingAllocationObservationBinding } from '@naryx/adapter-solana';
import {
  fromProtocolJson,
  toProtocolJson,
  type NettingExternalExecutionEvidence,
  type NettingExternalExecutionIntent,
  type NettingAllocationExecutionAuthorization,
  type NettingFinalAllocationReceipt,
  type NettingPolicyManifest,
  type NettingResult,
  type PackageSettlementCommitment,
} from '@naryx/protocol-types';

export type NettingAllocationObservationBinding =
  | Readonly<{ runtimeClass: 'EVM'; binding: EvmNettingAllocationObservationBinding }>
  | Readonly<{ runtimeClass: 'SVM'; binding: SolanaNettingAllocationObservationBinding }>;

export interface RegisteredNettingAllocationAttempt {
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly authorizationHashHex: string;
  readonly observation: NettingAllocationObservationBinding;
  readonly executionReference?: string;
  readonly recordedAtMs: number;
}

export interface NettingAllocationPreparation {
  readonly version: 1;
  readonly proofHashHex: string;
  readonly policy: NettingPolicyManifest;
  readonly result: NettingResult;
  readonly externalExecutions: readonly Readonly<{
    intent: NettingExternalExecutionIntent;
    evidence?: NettingExternalExecutionEvidence;
  }>[];
  readonly finalAllocationReceipt: NettingFinalAllocationReceipt;
  readonly allocations: readonly Readonly<{
    allocationReceiptHashHex: string;
    settlement: PackageSettlementCommitment;
  }>[];
}

export class NettingAllocationAdminClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NettingAllocationAdminClientError';
    this.code = code;
  }
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NettingAllocationAdminClientError('INVALID_ORIGIN', 'netting allocation API origin is invalid');
  }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== ''
    || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]')
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new NettingAllocationAdminClientError('INVALID_ORIGIN', 'netting allocation API must use a loopback HTTP origin');
  }
  return url.origin;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NettingAllocationAdminClientError('INVALID_RESPONSE', `${context} is malformed`);
  }
  return value as Record<string, unknown>;
}

export class HttpNettingAllocationAdminClient {
  readonly #origin: string;

  constructor(origin: string) {
    this.#origin = loopbackOrigin(origin);
  }

  async preparation(proofHash: string): Promise<NettingAllocationPreparation> {
    if (!/^[0-9a-f]{64}$/.test(proofHash)) {
      throw new NettingAllocationAdminClientError('INVALID_PROOF_HASH', 'netting proof hash must be lowercase hex');
    }
    const payload = record(await this.#request(
      'GET',
      `/internal/netting/batches/${proofHash}/preparation`,
    ), 'preparation response');
    if (payload.version !== 1 || payload.proofHashHex !== proofHash
      || typeof payload.policy !== 'object' || payload.policy === null || Array.isArray(payload.policy)
      || typeof payload.result !== 'object' || payload.result === null || Array.isArray(payload.result)
      || typeof payload.finalAllocationReceipt !== 'object' || payload.finalAllocationReceipt === null
      || Array.isArray(payload.finalAllocationReceipt)
      || !Array.isArray(payload.externalExecutions) || !Array.isArray(payload.allocations)
      || payload.allocations.some((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return true;
        const allocation = value as Record<string, unknown>;
        return typeof allocation.allocationReceiptHashHex !== 'string'
          || !/^[0-9a-f]{64}$/.test(allocation.allocationReceiptHashHex)
          || typeof allocation.settlement !== 'object' || allocation.settlement === null
          || Array.isArray(allocation.settlement);
      })) {
      throw new NettingAllocationAdminClientError('INVALID_RESPONSE', 'netting preparation response is malformed');
    }
    return payload as unknown as NettingAllocationPreparation;
  }

  async register(input: Readonly<{
    attemptId: string;
    idempotencyKey: string;
    authorization: NettingAllocationExecutionAuthorization;
    observation: NettingAllocationObservationBinding;
  }>): Promise<RegisteredNettingAllocationAttempt> {
    const response = record(await this.#post('/internal/netting/allocation-attempts', input), 'registration response');
    const attempt = record(response.attempt, 'registration attempt');
    if (response.version !== 1 || typeof response.authorizationReplayed !== 'boolean'
      || typeof attempt.attemptId !== 'string' || typeof attempt.idempotencyKey !== 'string'
      || typeof attempt.authorizationHashHex !== 'string' || typeof attempt.recordedAtMs !== 'number'
      || typeof attempt.observation !== 'object' || attempt.observation === null) {
      throw new NettingAllocationAdminClientError('INVALID_RESPONSE', 'registration response fields are malformed');
    }
    return attempt as unknown as RegisteredNettingAllocationAttempt;
  }

  async bindExecutionReference(input: Readonly<{
    attemptId: string;
    authorizationHash: string;
    executionReference: string;
  }>): Promise<RegisteredNettingAllocationAttempt> {
    const response = record(await this.#post(
      `/internal/netting/allocation-attempts/${encodeURIComponent(input.attemptId)}/reference`,
      { authorizationHash: input.authorizationHash, executionReference: input.executionReference },
    ), 'reference response');
    const attempt = record(response.attempt, 'reference attempt');
    if (response.version !== 1 || attempt.executionReference !== input.executionReference
      || attempt.attemptId !== input.attemptId) {
      throw new NettingAllocationAdminClientError('INVALID_RESPONSE', 'execution reference response is malformed');
    }
    return attempt as unknown as RegisteredNettingAllocationAttempt;
  }

  async settle(proofHash: string): Promise<unknown> {
    return this.#post(`/internal/netting/batches/${proofHash}/settle`, {});
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    return this.#request('POST', path, body);
  }

  async #request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.#origin}${path}`, {
        method,
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(toProtocolJson(body)),
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new NettingAllocationAdminClientError('UNAVAILABLE', 'netting allocation API request failed');
    }
    let payload: unknown;
    try {
      payload = fromProtocolJson(await response.json());
    } catch {
      throw new NettingAllocationAdminClientError('INVALID_RESPONSE', 'netting allocation API returned invalid protocol JSON');
    }
    if (!response.ok) {
      const failure = record(payload, 'error response');
      const error = record(failure.error, 'error');
      throw new NettingAllocationAdminClientError(
        typeof error.code === 'string' ? error.code : 'REJECTED',
        typeof error.message === 'string' ? error.message : `netting allocation API rejected HTTP ${response.status}`,
      );
    }
    return payload;
  }
}
