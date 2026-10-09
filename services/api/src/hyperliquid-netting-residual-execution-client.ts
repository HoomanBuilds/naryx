import {
  parseProtocolJson,
  stringifyProtocolJson,
  verifyCrossBatchExternalExecutionEvidence,
  verifyNettingExternalExecutionEvidence,
  type CrossBatchExternalExecutionEvidence,
  type CrossBatchExternalExecutionIntent,
  type NettingExternalExecutionEvidence,
  type NettingExternalExecutionIntent,
} from '@naryx/protocol-types';
import type { RoutedCrossBatchExternalExecutionPort } from './cross-batch-clearing-coordinator.js';
import type { RoutedNettingExternalExecutionPort } from './netting-execution-coordinator.js';

export const API_HYPERLIQUID_NETTING_RESIDUAL_EXECUTION_PATH =
  '/internal/netting/hyperliquid-testnet/execute-residual';
export const API_HYPERLIQUID_CROSS_BATCH_RESIDUAL_EXECUTION_PATH =
  '/internal/netting/hyperliquid-testnet/execute-cross-batch-residual';

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

export type HyperliquidNettingResidualExecutionClientErrorCode =
  | 'INVALID_ENDPOINT'
  | 'INVALID_REQUEST'
  | 'EVIDENCE_PENDING'
  | 'UPSTREAM_REJECTED'
  | 'INVALID_RESPONSE';

export class HyperliquidNettingResidualExecutionClientError extends Error {
  readonly code: HyperliquidNettingResidualExecutionClientErrorCode;

  constructor(code: HyperliquidNettingResidualExecutionClientErrorCode, message: string) {
    super(message);
    this.name = 'HyperliquidNettingResidualExecutionClientError';
    this.code = code;
  }
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_ENDPOINT', 'solver endpoint must be an absolute URL',
    );
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_ENDPOINT', 'solver endpoint must be a loopback HTTP origin',
    );
  }
  return url.origin;
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json'
    || response.body === null) {
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution response must be JSON',
    );
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null
    && (!/^\d+$/.test(statedLength) || Number(statedLength) > MAX_RESPONSE_BYTES)) {
    throw new HyperliquidNettingResidualExecutionClientError(
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
      throw new HyperliquidNettingResidualExecutionClientError(
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
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution response is malformed',
    );
  }
}

function decodedEvidence(
  value: unknown,
  intent: NettingExternalExecutionIntent,
): NettingExternalExecutionEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution result must be an object',
    );
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(',') !== 'evidence,version' || root.version !== 1
    || typeof root.evidence !== 'object' || root.evidence === null
    || Array.isArray(root.evidence)) {
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution result fields are invalid',
    );
  }
  const evidence = root.evidence as Record<string, unknown>;
  if (Object.keys(evidence).sort().join(',') !== EVIDENCE_KEYS) {
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution evidence fields are invalid',
    );
  }
  try {
    verifyNettingExternalExecutionEvidence(
      evidence as unknown as NettingExternalExecutionEvidence,
      intent,
    );
  } catch {
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution evidence is invalid',
    );
  }
  return Object.freeze(evidence) as unknown as NettingExternalExecutionEvidence;
}

function decodedCrossBatchEvidence(
  value: unknown,
  intent: CrossBatchExternalExecutionIntent,
): CrossBatchExternalExecutionEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution result must be an object',
    );
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(',') !== 'evidence,version' || root.version !== 1
    || typeof root.evidence !== 'object' || root.evidence === null
    || Array.isArray(root.evidence)) {
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution result fields are invalid',
    );
  }
  const evidence = root.evidence as Record<string, unknown>;
  if (Object.keys(evidence).sort().join(',') !== EVIDENCE_KEYS) {
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution evidence fields are invalid',
    );
  }
  try {
    verifyCrossBatchExternalExecutionEvidence(
      evidence as unknown as CrossBatchExternalExecutionEvidence,
      intent,
    );
  } catch {
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_RESPONSE', 'solver execution evidence is invalid',
    );
  }
  return Object.freeze(evidence) as unknown as CrossBatchExternalExecutionEvidence;
}

async function executeRequest(
  fetchImplementation: typeof fetch,
  origin: string,
  path: string,
  input: Readonly<{ intent: unknown; idempotencyKey: string }>,
): Promise<unknown> {
  if (!/^[0-9a-f]{64}$/.test(input.idempotencyKey)) {
    throw new HyperliquidNettingResidualExecutionClientError(
      'INVALID_REQUEST', 'idempotencyKey must be lowercase 32-byte hex without a prefix',
    );
  }
  const response = await fetchImplementation(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stringifyProtocolJson(input),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 409) {
    throw new HyperliquidNettingResidualExecutionClientError(
      'EVIDENCE_PENDING', 'Hyperliquid residual evidence is not terminal yet',
    );
  }
  if (!response.ok) {
    throw new HyperliquidNettingResidualExecutionClientError(
      'UPSTREAM_REJECTED', `Hyperliquid residual execution failed with HTTP ${response.status}`,
    );
  }
  return responseJson(response);
}

export class HttpHyperliquidNettingResidualExecutionClient
implements RoutedNettingExternalExecutionPort {
  readonly routeId = 'hypercore:testnet';
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  supports(intent: NettingExternalExecutionIntent): boolean {
    return intent.domain.domainId === 'hypercore:testnet'
      && intent.validUntilUnit === 'HYPERLIQUID_UNIX_MILLISECONDS';
  }

  async execute(input: Readonly<{
    intent: NettingExternalExecutionIntent;
    idempotencyKey: string;
  }>): Promise<NettingExternalExecutionEvidence> {
    return decodedEvidence(
      await executeRequest(
        this.#fetch,
        this.#origin,
        API_HYPERLIQUID_NETTING_RESIDUAL_EXECUTION_PATH,
        input,
      ),
      input.intent,
    );
  }
}

export class HttpHyperliquidCrossBatchResidualExecutionClient
implements RoutedCrossBatchExternalExecutionPort {
  readonly routeId = 'hypercore:testnet';
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  supports(intent: CrossBatchExternalExecutionIntent): boolean {
    return intent.domain.domainId === 'hypercore:testnet'
      && intent.validUntilUnit === 'HYPERLIQUID_UNIX_MILLISECONDS';
  }

  async execute(input: Readonly<{
    intent: CrossBatchExternalExecutionIntent;
    idempotencyKey: string;
  }>): Promise<CrossBatchExternalExecutionEvidence> {
    return decodedCrossBatchEvidence(
      await executeRequest(
        this.#fetch,
        this.#origin,
        API_HYPERLIQUID_CROSS_BATCH_RESIDUAL_EXECUTION_PATH,
        input,
      ),
      input.intent,
    );
  }
}
