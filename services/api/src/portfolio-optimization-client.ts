import {
  optimizePortfolio,
  parseProtocolJson,
  ProtocolError,
  stringifyProtocolJson,
  type PortfolioCandidateDecision,
  type PortfolioOptimizationCandidateInput,
  type PortfolioOptimizationDecision,
  type PortfolioOptimizationPolicyInput,
} from '@naryx/protocol-types';

const PATH = '/internal/portfolio-optimization';
const MAX_RESPONSE_BYTES = 1_048_576;
const TIMEOUT_MS = 10_000;

export interface PortfolioOptimizationRequest {
  readonly policy: PortfolioOptimizationPolicyInput;
  readonly decisionAtMs: bigint;
  readonly candidates: readonly PortfolioOptimizationCandidateInput[];
}

export interface PortfolioOptimizationResult {
  readonly decision: PortfolioOptimizationDecision;
  readonly selectedCandidate: PortfolioCandidateDecision;
}

export interface PortfolioOptimizationPort {
  optimize(request: PortfolioOptimizationRequest): Promise<PortfolioOptimizationResult>;
}

export type PortfolioDecisionVerifier = (
  policy: PortfolioOptimizationPolicyInput,
  decisionAtMs: bigint,
  candidates: readonly PortfolioOptimizationCandidateInput[],
) => PortfolioOptimizationDecision;

export class PortfolioOptimizationClientError extends Error {
  readonly code: 'INVALID_ENDPOINT' | 'INVALID_REQUEST' | 'NO_ELIGIBLE_CANDIDATE' | 'OPTIMIZATION_REJECTED' | 'INVALID_RESPONSE';

  constructor(code: PortfolioOptimizationClientError['code'], message: string) {
    super(message);
    this.name = 'PortfolioOptimizationClientError';
    this.code = code;
  }
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PortfolioOptimizationClientError('INVALID_ENDPOINT', 'portfolio optimization endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new PortfolioOptimizationClientError('INVALID_ENDPOINT', 'portfolio optimization endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

async function boundedProtocolJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json'
    || response.body === null) {
    throw new PortfolioOptimizationClientError('INVALID_RESPONSE', 'portfolio optimization response must be JSON');
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null && (!/^\d+$/.test(statedLength) || Number(statedLength) > MAX_RESPONSE_BYTES)) {
    throw new PortfolioOptimizationClientError('INVALID_RESPONSE', 'portfolio optimization response is too large');
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
      throw new PortfolioOptimizationClientError('INVALID_RESPONSE', 'portfolio optimization response is too large');
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
    throw new PortfolioOptimizationClientError('INVALID_RESPONSE', 'portfolio optimization response is malformed');
  }
}

function checkedResult(value: unknown, expected: PortfolioOptimizationDecision): PortfolioOptimizationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PortfolioOptimizationClientError('INVALID_RESPONSE', 'portfolio optimization response must be an object');
  }
  const root = value as Record<string, unknown>;
  const keys = Object.keys(root).sort();
  if (keys.length !== 2 || keys[0] !== 'decision' || keys[1] !== 'selectedCandidate') {
    throw new PortfolioOptimizationClientError('INVALID_RESPONSE', 'portfolio optimization response fields are invalid');
  }
  const expectedCandidate = expected.candidates.find((candidate) => candidate.candidateId === expected.selectedCandidateId);
  if (expectedCandidate === undefined || !expectedCandidate.eligible
    || stringifyProtocolJson(root.decision) !== stringifyProtocolJson(expected)
    || stringifyProtocolJson(root.selectedCandidate) !== stringifyProtocolJson(expectedCandidate)) {
    throw new PortfolioOptimizationClientError('INVALID_RESPONSE', 'portfolio optimization response does not match the verified decision');
  }
  return Object.freeze({
    decision: root.decision as PortfolioOptimizationDecision,
    selectedCandidate: root.selectedCandidate as PortfolioCandidateDecision,
  });
}

export class HttpPortfolioOptimizationClient implements PortfolioOptimizationPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #verify: PortfolioDecisionVerifier;

  constructor(
    endpoint: string,
    fetchImplementation: typeof fetch = fetch,
    verifier: PortfolioDecisionVerifier = optimizePortfolio,
  ) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
    this.#verify = verifier;
  }

  async optimize(request: PortfolioOptimizationRequest): Promise<PortfolioOptimizationResult> {
    let expected: PortfolioOptimizationDecision;
    try {
      expected = this.#verify(request.policy, request.decisionAtMs, request.candidates);
    } catch (error) {
      if (error instanceof ProtocolError || error instanceof TypeError) {
        throw new PortfolioOptimizationClientError('INVALID_REQUEST', 'portfolio optimization request is invalid');
      }
      throw error;
    }
    if (expected.selectedCandidateId === undefined) {
      throw new PortfolioOptimizationClientError('NO_ELIGIBLE_CANDIDATE', 'portfolio optimization found no eligible candidate');
    }
    let body: string;
    try {
      body = stringifyProtocolJson(request);
    } catch {
      throw new PortfolioOptimizationClientError('INVALID_REQUEST', 'portfolio optimization request is invalid');
    }
    const response = await this.#fetch(`${this.#origin}${PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new PortfolioOptimizationClientError(
        response.status === 409 ? 'OPTIMIZATION_REJECTED' : 'INVALID_RESPONSE',
        `portfolio optimization failed with HTTP ${response.status}`,
      );
    }
    return checkedResult(await boundedProtocolJson(response), expected);
  }
}
