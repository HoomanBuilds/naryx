import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  fromProtocolJson,
  packageQuoteShard,
  packageQuoteShardHash,
  prepareShardBatch,
  prepareShardKillSwitch,
  solverRequestDigest,
  toHex,
  toProtocolJson,
  type PackageQuoteShard,
  type PackageQuoteShardInput,
} from '@naryx/protocol-types';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHARD_ID = /^[A-Za-z0-9._:-]{1,257}$/;
const HASH = /^[0-9a-f]{64}$/;
const UNSIGNED = /^(?:0|[1-9]\d*)$/;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_BODY_BYTES = 4_096;
const MAX_RESPONSE_CHARS = 1_048_576;

export type MakerControlAction = 'CANCEL_ALL' | 'ACTIVATE_KILL_SWITCH';

export interface MakerControlRequest {
  readonly shardId: string;
  readonly expectedShardHash: string;
  readonly expectedShardSequence: bigint;
}

export interface MakerControlResult {
  readonly version: 1;
  readonly action: MakerControlAction;
  readonly shardId: string;
  readonly previousShardHash: string;
  readonly shardHash: string;
  readonly previousShardSequence: bigint;
  readonly shardSequence: bigint;
  readonly changed: boolean;
}

export class MakerControlError extends Error {
  readonly code:
    | 'INVALID_REQUEST'
    | 'SHARD_NOT_FOUND'
    | 'STALE_SHARD'
    | 'REMOTE_REJECTED'
    | 'INVALID_RESPONSE';

  constructor(code: MakerControlError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'MakerControlError';
    this.code = code;
  }
}

export interface MakerShardGateway {
  getShard(shardId: string): Promise<Readonly<{ shard: PackageQuoteShard; shardHash: string }>>;
  cancelAll(shardId: string, shard: PackageQuoteShardInput): Promise<Readonly<{
    shardHash: string;
    shardSequence: bigint;
  }>>;
  activateKillSwitch(shardId: string, shard: PackageQuoteShardInput): Promise<Readonly<{
    shardHash: string;
    shardSequence: bigint;
  }>>;
}

export interface MakerControlSigner {
  signDigest(digest: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MakerControlError('INVALID_REQUEST', 'maker solver API origin is invalid');
  }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== ''
    || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]')
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new MakerControlError('INVALID_REQUEST', 'maker solver API must use a loopback HTTP origin');
  }
  return url.origin;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MakerControlError('INVALID_RESPONSE', `${context} is malformed`);
  }
  return value as Record<string, unknown>;
}

function exactShardId(value: string): string {
  if (!SHARD_ID.test(value)) throw new MakerControlError('INVALID_REQUEST', 'shardId is invalid');
  return value;
}

function servedShard(value: unknown, expectedShardId: string): Readonly<{
  shard: PackageQuoteShard;
  shardHash: string;
}> {
  const payload = record(value, 'shard response');
  let shard: PackageQuoteShard;
  try {
    shard = packageQuoteShard(payload.shard as PackageQuoteShardInput);
  } catch {
    throw new MakerControlError('INVALID_RESPONSE', 'served shard is invalid');
  }
  const shardId = `${shard.templateId}.${shard.marketGroupId}`;
  const shardHash = toHex(packageQuoteShardHash(shard));
  if (shard.templateId.includes('.') || shardId !== expectedShardId || payload.shardHash !== shardHash) {
    throw new MakerControlError('INVALID_RESPONSE', 'served shard identity or hash is invalid');
  }
  return Object.freeze({ shard, shardHash });
}

function admittedShard(value: unknown, expectedHash: string, expectedSequence: bigint): Readonly<{
  shardHash: string;
  shardSequence: bigint;
}> {
  const payload = record(value, 'shard update response');
  if (payload.accepted !== true || typeof payload.duplicate !== 'boolean'
    || payload.shardHash !== expectedHash || payload.shardSequence !== expectedSequence) {
    throw new MakerControlError('INVALID_RESPONSE', 'shard update response does not match the signed state');
  }
  return Object.freeze({ shardHash: expectedHash, shardSequence: expectedSequence });
}

async function boundedProtocolJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new MakerControlError('INVALID_RESPONSE', 'maker solver API response is too large');
  }
  try {
    return record(fromProtocolJson(JSON.parse(text)), 'maker solver API response');
  } catch (error) {
    if (error instanceof MakerControlError) throw error;
    throw new MakerControlError('INVALID_RESPONSE', 'maker solver API response is not protocol JSON');
  }
}

export class HttpMakerShardGateway implements MakerShardGateway {
  readonly #origin: string;
  readonly #solverId: string;
  readonly #keyId: string;
  readonly #signer: MakerControlSigner;
  readonly #fetch: typeof fetch;
  readonly #clockMs: () => number;

  constructor(input: Readonly<{
    origin: string;
    solverId: string;
    keyId: string;
    signer: MakerControlSigner;
    fetch?: typeof fetch;
    clockMs?: () => number;
  }>) {
    this.#origin = loopbackOrigin(input.origin);
    if (!IDENTIFIER.test(input.solverId) || !IDENTIFIER.test(input.keyId)) {
      throw new MakerControlError('INVALID_REQUEST', 'maker solver and key identifiers are invalid');
    }
    this.#solverId = input.solverId;
    this.#keyId = input.keyId;
    this.#signer = input.signer;
    this.#fetch = input.fetch ?? fetch;
    this.#clockMs = input.clockMs ?? Date.now;
  }

  async #call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    const text = body === undefined ? '' : JSON.stringify(toProtocolJson(body));
    const timestampMs = BigInt(Math.floor(this.#clockMs()));
    const nonce = randomBytes(32).toString('hex');
    const digest = solverRequestDigest({
      method,
      pathAndQuery: path,
      bodySha256: new Uint8Array(createHash('sha256').update(text).digest()),
      solverId: this.#solverId,
      keyId: this.#keyId,
      timestampMs,
      nonce,
    });
    const signature = await this.#signer.signDigest(digest);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) {
      throw new MakerControlError('INVALID_REQUEST', 'maker signer must return a 64-byte signature');
    }
    const response = await this.#fetch(`${this.#origin}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
      headers: {
        Accept: 'application/json',
        ...(text === '' ? {} : { 'Content-Type': 'application/json' }),
        'X-Naryx-Solver': this.#solverId,
        'X-Naryx-Key': this.#keyId,
        'X-Naryx-Timestamp': timestampMs.toString(),
        'X-Naryx-Nonce': nonce,
        'X-Naryx-Signature': toHex(signature),
      },
      ...(text === '' ? {} : { body: text }),
    });
    const payload = await boundedProtocolJson(response);
    if (!response.ok) {
      const error = typeof payload.error === 'object' && payload.error !== null
        ? payload.error as Record<string, unknown>
        : {};
      const code = response.status === 404 && error.code === 'SHARD_NOT_FOUND'
        ? 'SHARD_NOT_FOUND'
        : 'REMOTE_REJECTED';
      throw new MakerControlError(code, String(error.message ?? 'maker solver API rejected the request'));
    }
    return payload;
  }

  async getShard(shardId: string) {
    const id = exactShardId(shardId);
    return servedShard(await this.#call('GET', `/v1/solver/quote-shards/${id}`), id);
  }

  async cancelAll(shardId: string, shard: PackageQuoteShardInput) {
    const id = exactShardId(shardId);
    const hash = toHex(packageQuoteShardHash(shard));
    return admittedShard(
      await this.#call('POST', `/v1/solver/quote-shards/${id}/cancel-all`, { shard }),
      hash,
      shard.shardSequence,
    );
  }

  async activateKillSwitch(shardId: string, shard: PackageQuoteShardInput) {
    const id = exactShardId(shardId);
    const hash = toHex(packageQuoteShardHash(shard));
    return admittedShard(
      await this.#call('POST', '/v1/solver/kill-switch', { shardId: id, shard }),
      hash,
      shard.shardSequence,
    );
  }
}

export class MakerControlService {
  readonly #gateway: MakerShardGateway;
  readonly #signer: MakerControlSigner;

  constructor(input: Readonly<{ gateway: MakerShardGateway; signer: MakerControlSigner }>) {
    this.#gateway = input.gateway;
    this.#signer = input.signer;
  }

  async cancelAll(input: MakerControlRequest): Promise<MakerControlResult> {
    return this.#apply('CANCEL_ALL', input);
  }

  async activateKillSwitch(input: MakerControlRequest): Promise<MakerControlResult> {
    return this.#apply('ACTIVATE_KILL_SWITCH', input);
  }

  async #apply(action: MakerControlAction, input: MakerControlRequest): Promise<MakerControlResult> {
    const shardId = exactShardId(input.shardId);
    if (!HASH.test(input.expectedShardHash)
      || input.expectedShardSequence < 0n || input.expectedShardSequence > MAX_U64) {
      throw new MakerControlError('INVALID_REQUEST', 'expected shard state is invalid');
    }
    const current = await this.#gateway.getShard(shardId);
    if (current.shardHash !== input.expectedShardHash
      || current.shard.shardSequence !== input.expectedShardSequence) {
      throw new MakerControlError('STALE_SHARD', 'the shard changed after the operator observed it');
    }
    const noChange = action === 'CANCEL_ALL'
      ? current.shard.quoteLevels.length === 0
      : current.shard.killSwitchState === 'ACTIVE';
    if (noChange) {
      return Object.freeze({
        version: 1,
        action,
        shardId,
        previousShardHash: current.shardHash,
        shardHash: current.shardHash,
        previousShardSequence: current.shard.shardSequence,
        shardSequence: current.shard.shardSequence,
        changed: false,
      });
    }
    const unsigned = action === 'CANCEL_ALL'
      ? prepareShardBatch(current.shard, [{ op: 'CANCEL_ALL' }])
      : prepareShardKillSwitch(current.shard, 'ACTIVE');
    const hash = packageQuoteShardHash(unsigned);
    const signature = await this.#signer.signDigest(hash);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) {
      throw new MakerControlError('INVALID_REQUEST', 'maker signer must return a 64-byte signature');
    }
    const signed = packageQuoteShard({ ...unsigned, signature });
    const admitted = action === 'CANCEL_ALL'
      ? await this.#gateway.cancelAll(shardId, signed)
      : await this.#gateway.activateKillSwitch(shardId, signed);
    const shardHash = toHex(hash);
    if (admitted.shardHash !== shardHash || admitted.shardSequence !== signed.shardSequence) {
      throw new MakerControlError('INVALID_RESPONSE', 'admitted shard does not match the signed control state');
    }
    return Object.freeze({
      version: 1,
      action,
      shardId,
      previousShardHash: current.shardHash,
      shardHash,
      previousShardSequence: current.shard.shardSequence,
      shardSequence: signed.shardSequence,
      changed: true,
    });
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(toProtocolJson(body)));
}

async function readControlRequest(request: IncomingMessage, shardId: string): Promise<MakerControlRequest> {
  if (request.headers.origin !== undefined) {
    throw new MakerControlError('INVALID_REQUEST', 'browser-originated maker controls are forbidden');
  }
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new MakerControlError('INVALID_REQUEST', 'Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) throw new MakerControlError('INVALID_REQUEST', 'request body is too large');
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MakerControlError('INVALID_REQUEST', 'request body must contain valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MakerControlError('INVALID_REQUEST', 'request body must be an object');
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(',') !== 'expectedShardHash,expectedShardSequence'
    || typeof body.expectedShardHash !== 'string' || !HASH.test(body.expectedShardHash)
    || typeof body.expectedShardSequence !== 'string' || !UNSIGNED.test(body.expectedShardSequence)) {
    throw new MakerControlError('INVALID_REQUEST', 'expected shard hash and sequence are required');
  }
  const expectedShardSequence = BigInt(body.expectedShardSequence);
  if (expectedShardSequence > MAX_U64) {
    throw new MakerControlError('INVALID_REQUEST', 'expected shard sequence exceeds u64');
  }
  return Object.freeze({
    shardId: exactShardId(shardId),
    expectedShardHash: body.expectedShardHash,
    expectedShardSequence,
  });
}

export function createMakerControlInternalHandler(service: MakerControlService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    if (!url.pathname.startsWith('/internal/maker/')) return false;
    const match = /^\/internal\/maker\/shards\/([^/]+)\/(cancel-all|kill-switch)$/.exec(url.pathname);
    if (match === null || url.search !== '') {
      send(response, 404, { error: { code: 'NOT_FOUND', message: 'maker control route was not found' } });
      return true;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      send(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'only POST is allowed' } });
      return true;
    }
    try {
      const input = await readControlRequest(request, match[1] as string);
      const result = match[2] === 'cancel-all'
        ? await service.cancelAll(input)
        : await service.activateKillSwitch(input);
      send(response, 200, result);
    } catch (error) {
      if (error instanceof MakerControlError) {
        const status = error.code === 'SHARD_NOT_FOUND' ? 404
          : error.code === 'STALE_SHARD' ? 409
            : error.code === 'REMOTE_REJECTED' || error.code === 'INVALID_RESPONSE' ? 502 : 400;
        send(response, status, { error: { code: error.code, message: error.message } });
      } else {
        send(response, 502, { error: { code: 'CONTROL_FAILED', message: 'maker control failed closed' } });
      }
    }
    return true;
  };
}
