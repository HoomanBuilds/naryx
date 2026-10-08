import {
  commitmentHash,
  fromProtocolJson,
  toHex,
} from '@naryx/protocol-types';
import {
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  validateAuthorizedEvmStrategyExecution,
  type AuthorizedEvmStrategyExecution,
} from './evm-strategy-execution-authorization-client.js';
import {
  validateAuthorizedSolanaStrategyExecution,
  type AuthorizedSolanaStrategyExecution,
} from './solana-strategy-execution-authorization-client.js';

const MAX_RESPONSE_BYTES = 262_144;
const ATTEMPT_ID = /^[A-Za-z0-9_-]{16,96}$/;
const HASH = /^[0-9a-f]{64}$/;
const HEX_HASH = /^0x[0-9a-f]{64}$/;
const EVM_TEST_CHAIN_IDS = new Set([84_532, 421_614, 31_337, 31_338]);

export interface NettingAllocationAuthorizationRequest {
  readonly proofHash: string;
  readonly allocationReceiptHash: string;
  readonly quoteHash: string;
  readonly domainId: string;
  readonly attemptId: string;
}

export interface EvmNettingAllocationChallenge {
  readonly version: 1;
  readonly attemptId: string;
  readonly authorizationHash: Hex;
  readonly chainId: number;
  readonly owner: Address;
  readonly to: Address;
  readonly ownerTypedData: Readonly<{
    domain: Readonly<{
      name: 'Naryx Multi Strategy Account';
      version: '1';
      chainId: number;
      verifyingContract: Address;
    }>;
    primaryType: 'NettingOwnerExecution';
    types: Readonly<{
      NettingOwnerExecution: readonly Readonly<{ name: string; type: string }>[];
    }>;
    message: Readonly<{
      authorizationHash: Hex;
      executionHash: Hex;
      callsHash: Hex;
    }>;
  }>;
}

export type AuthorizedEvmNettingAllocation = AuthorizedEvmStrategyExecution & Readonly<{
  attemptId: string;
  authorizationHash: Hex;
  owner: Address;
  ownerTypedData: EvmNettingAllocationChallenge['ownerTypedData'];
}>;

export type AuthorizedSolanaNettingAllocation = AuthorizedSolanaStrategyExecution & Readonly<{
  attemptId: string;
  authorizationHash: string;
}>;

export interface BoundNettingAllocationReference {
  readonly attemptId: string;
  readonly authorizationHash: string;
  readonly executionReference: string;
}

export interface NettingAllocationReconciliation {
  readonly observedAuthorizationHashes: readonly string[];
  readonly pendingAllocationReceiptHashes: readonly string[];
}

export interface NettingAllocationAuthorizationPort {
  challengeEvm(request: NettingAllocationAuthorizationRequest): Promise<EvmNettingAllocationChallenge>;
  authorizeEvm(
    request: NettingAllocationAuthorizationRequest,
    ownerSignature: string,
  ): Promise<AuthorizedEvmNettingAllocation>;
  authorizeSolana(
    request: NettingAllocationAuthorizationRequest,
  ): Promise<AuthorizedSolanaNettingAllocation>;
  bindReference(input: BoundNettingAllocationReference): Promise<BoundNettingAllocationReference>;
  reconcile(proofHash: string): Promise<NettingAllocationReconciliation>;
}

export class NettingAllocationAuthorizationClientError extends Error {
  readonly code: 'INVALID_ENDPOINT' | 'INVALID_REQUEST' | 'UPSTREAM_REJECTED' | 'INVALID_RESPONSE';

  constructor(code: NettingAllocationAuthorizationClientError['code'], message: string) {
    super(message);
    this.name = 'NettingAllocationAuthorizationClientError';
    this.code = code;
  }
}

function fail(message: string): never {
  throw new NettingAllocationAuthorizationClientError('INVALID_RESPONSE', message);
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new NettingAllocationAuthorizationClientError('INVALID_ENDPOINT', 'authorization endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new NettingAllocationAuthorizationClientError(
      'INVALID_ENDPOINT',
      'authorization endpoint must be a loopback HTTP origin',
    );
  }
  return url.origin;
}

function normalizedRequest(input: NettingAllocationAuthorizationRequest): NettingAllocationAuthorizationRequest {
  const values = [input.proofHash, input.allocationReceiptHash, input.quoteHash];
  let normalized: string[];
  try {
    normalized = values.map((value) => toHex(commitmentHash(value)));
  } catch {
    throw new NettingAllocationAuthorizationClientError('INVALID_REQUEST', 'allocation hashes must be 32-byte hex');
  }
  if (!values.every((value, index) => value === normalized[index])
    || !ATTEMPT_ID.test(input.attemptId)
    || (input.domainId !== 'svm:devnet' && !/^eip155:(84532|421614|31337|31338)$/.test(input.domainId))) {
    throw new NettingAllocationAuthorizationClientError('INVALID_REQUEST', 'allocation authorization request is invalid');
  }
  return Object.freeze({ ...input });
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json' || response.body === null) {
    throw new NettingAllocationAuthorizationClientError('INVALID_RESPONSE', 'authorization response must be JSON');
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
      throw new NettingAllocationAuthorizationClientError('INVALID_RESPONSE', 'authorization response is too large');
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
    throw new NettingAllocationAuthorizationClientError('INVALID_RESPONSE', 'authorization response is malformed');
  }
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(`${context} is invalid`);
  return value as Record<string, unknown>;
}

function address(value: unknown, context: string): Address {
  try {
    return getAddress(String(value));
  } catch {
    return fail(`${context} is invalid`);
  }
}

function hexHash(value: unknown, context: string): Hex {
  if (typeof value !== 'string' || !HEX_HASH.test(value)) return fail(`${context} is invalid`);
  return value as Hex;
}

function typedData(value: unknown, chainId: number, to: Address, authorizationHash: Hex) {
  const root = record(value, 'owner typed data');
  const domain = record(root.domain, 'owner typed data domain');
  const types = record(root.types, 'owner typed data types');
  const message = record(root.message, 'owner typed data message');
  const fields = types.NettingOwnerExecution;
  if (Object.keys(root).sort().join(',') !== 'domain,message,primaryType,types'
    || root.primaryType !== 'NettingOwnerExecution'
    || domain.name !== 'Naryx Multi Strategy Account' || domain.version !== '1'
    || domain.chainId !== chainId || address(domain.verifyingContract, 'typed data verifier') !== to
    || !Array.isArray(fields) || fields.length !== 3
    || JSON.stringify(fields) !== JSON.stringify([
      { name: 'authorizationHash', type: 'bytes32' },
      { name: 'executionHash', type: 'bytes32' },
      { name: 'callsHash', type: 'bytes32' },
    ])) {
    return fail('owner typed data schema is invalid');
  }
  const boundAuthorizationHash = hexHash(message.authorizationHash, 'typed data authorization hash');
  if (boundAuthorizationHash !== authorizationHash) return fail('owner typed data authorization hash differs');
  return Object.freeze({
    domain: Object.freeze({
      name: 'Naryx Multi Strategy Account' as const,
      version: '1' as const,
      chainId,
      verifyingContract: to,
    }),
    primaryType: 'NettingOwnerExecution' as const,
    types: Object.freeze({ NettingOwnerExecution: Object.freeze(fields.map((field) => Object.freeze({ ...record(field, 'typed data field') }))) }),
    message: Object.freeze({
      authorizationHash: boundAuthorizationHash,
      executionHash: hexHash(message.executionHash, 'typed data execution hash'),
      callsHash: hexHash(message.callsHash, 'typed data calls hash'),
    }),
  }) as EvmNettingAllocationChallenge['ownerTypedData'];
}

function challenge(value: unknown, expected: NettingAllocationAuthorizationRequest): EvmNettingAllocationChallenge {
  const root = record(value, 'challenge response');
  const result = record(root.challenge, 'challenge');
  if (Object.keys(root).sort().join(',') !== 'challenge,version' || root.version !== 1
    || result.version !== 1 || result.attemptId !== expected.attemptId
    || !Number.isSafeInteger(result.chainId) || !EVM_TEST_CHAIN_IDS.has(Number(result.chainId))) {
    return fail('challenge response fields are invalid');
  }
  const chainId = Number(result.chainId);
  if (expected.domainId !== `eip155:${chainId}`) return fail('challenge domain differs from the request');
  const authorizationHash = hexHash(result.authorizationHash, 'challenge authorization hash');
  const owner = address(result.owner, 'challenge owner');
  const to = address(result.to, 'challenge target');
  return Object.freeze({
    version: 1,
    attemptId: expected.attemptId,
    authorizationHash,
    chainId,
    owner,
    to,
    ownerTypedData: typedData(result.ownerTypedData, chainId, to, authorizationHash),
  });
}

function evmAuthorization(
  value: unknown,
  expected: NettingAllocationAuthorizationRequest,
  ownerSignature: string,
): AuthorizedEvmNettingAllocation {
  const root = record(value, 'authorization response');
  const result = record(root.authorization, 'authorization');
  const base = validateAuthorizedEvmStrategyExecution(value, expected.quoteHash, ownerSignature);
  if (result.attemptId !== expected.attemptId || typeof result.chainId !== 'number'
    || expected.domainId !== `eip155:${result.chainId}`) {
    return fail('EVM netting authorization identity differs from the request');
  }
  const authorizationHash = hexHash(result.authorizationHash, 'authorization hash');
  const owner = address(result.owner, 'authorization owner');
  return Object.freeze({
    ...base,
    attemptId: expected.attemptId,
    authorizationHash,
    owner,
    ownerTypedData: typedData(result.ownerTypedData, base.chainId, base.to, authorizationHash),
  });
}

function solanaAuthorization(
  value: unknown,
  expected: NettingAllocationAuthorizationRequest,
): AuthorizedSolanaNettingAllocation {
  const root = record(value, 'authorization response');
  const result = record(root.authorization, 'authorization');
  const base = validateAuthorizedSolanaStrategyExecution(value, expected.quoteHash);
  if (result.attemptId !== expected.attemptId || expected.domainId !== base.domain.domainId
    || typeof result.authorizationHash !== 'string' || !HASH.test(result.authorizationHash)) {
    return fail('Solana netting authorization identity differs from the request');
  }
  return Object.freeze({
    ...base,
    attemptId: expected.attemptId,
    authorizationHash: result.authorizationHash,
  });
}

export class HttpNettingAllocationAuthorizationClient implements NettingAllocationAuthorizationPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  challengeEvm(input: NettingAllocationAuthorizationRequest): Promise<EvmNettingAllocationChallenge> {
    const request = normalizedRequest(input);
    if (!request.domainId.startsWith('eip155:')) {
      throw new NettingAllocationAuthorizationClientError('INVALID_REQUEST', 'EVM challenge requires an EVM domain');
    }
    return this.#request('/internal/netting/allocation-executions/evm/challenge', request)
      .then((value) => challenge(value, request));
  }

  authorizeEvm(
    input: NettingAllocationAuthorizationRequest,
    ownerSignature: string,
  ): Promise<AuthorizedEvmNettingAllocation> {
    const request = normalizedRequest(input);
    if (!request.domainId.startsWith('eip155:') || !/^0x[0-9a-fA-F]{130}$/.test(ownerSignature)) {
      throw new NettingAllocationAuthorizationClientError('INVALID_REQUEST', 'EVM authorization request is invalid');
    }
    return this.#request('/internal/netting/allocation-executions/evm/authorize', { ...request, ownerSignature })
      .then((value) => evmAuthorization(value, request, ownerSignature));
  }

  authorizeSolana(input: NettingAllocationAuthorizationRequest): Promise<AuthorizedSolanaNettingAllocation> {
    const request = normalizedRequest(input);
    if (request.domainId !== 'svm:devnet') {
      throw new NettingAllocationAuthorizationClientError('INVALID_REQUEST', 'Solana authorization requires svm:devnet');
    }
    return this.#request('/internal/netting/allocation-executions/solana/authorize', request)
      .then((value) => solanaAuthorization(value, request));
  }

  bindReference(input: BoundNettingAllocationReference): Promise<BoundNettingAllocationReference> {
    if (!ATTEMPT_ID.test(input.attemptId) || !HASH.test(input.authorizationHash)
      || (!/^0x[0-9a-f]{64}$/.test(input.executionReference)
        && !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(input.executionReference))) {
      throw new NettingAllocationAuthorizationClientError('INVALID_REQUEST', 'allocation execution reference is invalid');
    }
    return this.#request('/internal/netting/allocation-executions/reference', input).then((value) => {
      const root = record(value, 'reference response');
      const attempt = record(root.attempt, 'reference attempt');
      if (root.version !== 1 || attempt.attemptId !== input.attemptId
        || attempt.authorizationHashHex !== input.authorizationHash
        || attempt.executionReference !== input.executionReference) {
        return fail('bound execution reference differs from the request');
      }
      return Object.freeze({ ...input });
    });
  }

  reconcile(proofHash: string): Promise<NettingAllocationReconciliation> {
    let normalized: string;
    try {
      normalized = toHex(commitmentHash(proofHash));
    } catch {
      throw new NettingAllocationAuthorizationClientError('INVALID_REQUEST', 'proofHash must be 32-byte hex');
    }
    if (normalized !== proofHash) {
      throw new NettingAllocationAuthorizationClientError('INVALID_REQUEST', 'proofHash must be lowercase hex');
    }
    return this.#request('/internal/netting/allocation-executions/reconcile', { proofHash }).then((value) => {
      const root = record(value, 'reconciliation response');
      const reconciliation = record(root.reconciliation, 'reconciliation');
      if (root.version !== 1 || reconciliation.version !== 1
        || !Array.isArray(reconciliation.observedAuthorizationHashes)
        || !Array.isArray(reconciliation.pendingAllocationReceiptHashes)
        || [...reconciliation.observedAuthorizationHashes, ...reconciliation.pendingAllocationReceiptHashes]
          .some((item) => typeof item !== 'string' || !HASH.test(item))) {
        return fail('reconciliation response is invalid');
      }
      return Object.freeze({
        observedAuthorizationHashes: Object.freeze([...reconciliation.observedAuthorizationHashes] as string[]),
        pendingAllocationReceiptHashes: Object.freeze([...reconciliation.pendingAllocationReceiptHashes] as string[]),
      });
    });
  }

  async #request(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new NettingAllocationAuthorizationClientError('UPSTREAM_REJECTED', 'allocation authorization service is unavailable');
    }
    if (!response.ok) {
      throw new NettingAllocationAuthorizationClientError(
        'UPSTREAM_REJECTED',
        `allocation authorization failed with HTTP ${response.status}`,
      );
    }
    return responseJson(response);
  }
}
