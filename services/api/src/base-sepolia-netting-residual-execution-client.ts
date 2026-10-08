import {
  parseProtocolJson,
  stringifyProtocolJson,
  verifyNettingExternalExecutionEvidence,
  type NettingExternalExecutionEvidence,
  type NettingExternalExecutionIntent,
} from '@naryx/protocol-types';
import type { RoutedNettingExternalExecutionPort } from './netting-execution-coordinator.js';

export const API_BASE_SEPOLIA_NETTING_RESIDUAL_EXECUTION_PATH =
  '/internal/netting/base-sepolia/execute-residual';

const MAX_RESPONSE_BYTES = 65_536;
const EVIDENCE_KEYS = [
  'authoritativeEvidenceHash',
  'evidenceHash',
  'executionReferenceHash',
  'feeQuoteAtoms',
  'filledSignedQuantityAtoms',
  'grossQuoteAtoms',
  'intentHash',
  'observedAtUnit',
  'observedAtValue',
  'outcome',
  'submittedAtUnit',
  'submittedAtValue',
  'version',
].join(',');

export type BaseSepoliaNettingResidualExecutionClientErrorCode =
  | 'INVALID_ENDPOINT'
  | 'INVALID_REQUEST'
  | 'EVIDENCE_PENDING'
  | 'UPSTREAM_REJECTED'
  | 'INVALID_RESPONSE';

export class BaseSepoliaNettingResidualExecutionClientError extends Error {
  readonly code: BaseSepoliaNettingResidualExecutionClientErrorCode;

  constructor(code: BaseSepoliaNettingResidualExecutionClientErrorCode, message: string) {
    super(message);
    this.name = 'BaseSepoliaNettingResidualExecutionClientError';
    this.code = code;
  }
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new BaseSepoliaNettingResidualExecutionClientError(
      'INVALID_ENDPOINT', 'solver endpoint must be an absolute URL',
    );
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new BaseSepoliaNettingResidualExecutionClientError(
      'INVALID_ENDPOINT', 'solver endpoint must be a loopback HTTP origin',
    );
  }
  return url.origin;
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json'
    || response.body === null) {
    throw new BaseSepoliaNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution response must be JSON',
    );
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null
    && (!/^\d+$/.test(statedLength) || Number(statedLength) > MAX_RESPONSE_BYTES)) {
    throw new BaseSepoliaNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution response is too large',
    );
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
      throw new BaseSepoliaNettingResidualExecutionClientError(
        'INVALID_RESPONSE', 'solver execution response is too large',
      );
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
    return parseProtocolJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new BaseSepoliaNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution response is malformed',
    );
  }
}

function decodedEvidence(
  value: unknown,
  intent: NettingExternalExecutionIntent,
): NettingExternalExecutionEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BaseSepoliaNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution result must be an object',
    );
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(',') !== 'evidence,version' || root.version !== 1
    || typeof root.evidence !== 'object' || root.evidence === null
    || Array.isArray(root.evidence)) {
    throw new BaseSepoliaNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution result fields are invalid',
    );
  }
  const evidence = root.evidence as Record<string, unknown>;
  if (Object.keys(evidence).sort().join(',') !== EVIDENCE_KEYS) {
    throw new BaseSepoliaNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution evidence fields are invalid',
    );
  }
  try {
    verifyNettingExternalExecutionEvidence(
      evidence as unknown as NettingExternalExecutionEvidence,
      intent,
    );
  } catch {
    throw new BaseSepoliaNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution evidence is invalid',
    );
  }
  return Object.freeze(evidence) as unknown as NettingExternalExecutionEvidence;
}

export class HttpBaseSepoliaNettingResidualExecutionClient
implements RoutedNettingExternalExecutionPort {
  readonly routeId = 'eip155:84532';
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  supports(intent: NettingExternalExecutionIntent): boolean {
    return intent.domain.domainId === 'eip155:84532'
      && intent.validUntilUnit === 'EVM_UNIX_SECONDS';
  }

  async execute(input: Readonly<{
    intent: NettingExternalExecutionIntent;
    idempotencyKey: string;
  }>): Promise<NettingExternalExecutionEvidence> {
    if (!/^[0-9a-f]{64}$/.test(input.idempotencyKey)) {
      throw new BaseSepoliaNettingResidualExecutionClientError(
        'INVALID_REQUEST', 'idempotencyKey must be lowercase 32-byte hex without a prefix',
      );
    }
    const response = await this.#fetch(
      `${this.#origin}${API_BASE_SEPOLIA_NETTING_RESIDUAL_EXECUTION_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifyProtocolJson(input),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status === 409) {
      throw new BaseSepoliaNettingResidualExecutionClientError(
        'EVIDENCE_PENDING', 'Base residual evidence is not terminal yet',
      );
    }
    if (!response.ok) {
      throw new BaseSepoliaNettingResidualExecutionClientError(
        'UPSTREAM_REJECTED', `Base residual execution failed with HTTP ${response.status}`,
      );
    }
    return decodedEvidence(await responseJson(response), input.intent);
  }
}
