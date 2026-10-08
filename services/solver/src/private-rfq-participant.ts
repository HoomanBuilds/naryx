import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import bs58 from 'bs58';
import {
  NARYX_RFQ_HPKE_PRIVATE_KEY_BYTES,
  NARYX_RFQ_HPKE_SUITE_ID,
  decodePrivateRfqQuoteRequest,
  decryptPrivateRfqRequest,
  encodePrivateRfqQuoteResponse,
  encryptPrivateRfqResponse,
  fromProtocolJson,
  privateRfqEnvelope,
  privateRfqEnvelopeHash,
  solverRequestDigest,
  toHex,
  toProtocolJson,
  type PrivateRfqEnvelope,
  type PrivateRfqEnvelopeInput,
} from '@naryx/protocol-types';
import type { GeneralizedStrategyQuoteResponse } from './strategy-quote-service.js';

const HASH = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_KEY_FILE_BYTES = 512;

export interface PendingPrivateRfq {
  readonly envelopeHash: string;
  readonly envelope: PrivateRfqEnvelope;
  readonly ciphertext: Uint8Array;
  readonly senderSignature: Uint8Array;
}

export interface PrivateRfqRelayPort {
  pending(): Promise<readonly PendingPrivateRfq[]>;
  respond(envelopeHash: string, input: Readonly<{
    quoteHash: string;
    quoteOrderHash: string;
    responseEncryptionKey: Uint8Array;
    responseCiphertext: Uint8Array;
  }>): Promise<void>;
}

export interface PrivateRfqQuotePort {
  quote(input: Readonly<{ orderHash: string; idempotencyKey: string }>): Promise<GeneralizedStrategyQuoteResponse>;
}

export interface PrivateRfqSigner {
  signDigest(digest: Uint8Array): Uint8Array;
}

export class PrivateRfqRelayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PrivateRfqRelayError';
    this.status = status;
    this.code = code;
  }
}

function loopbackOrigin(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('private RFQ relay origin must be loopback HTTP');
  }
  return url.origin;
}

async function boundedProtocolJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('private RFQ relay response is too large');
  let value: unknown;
  try {
    value = fromProtocolJson(JSON.parse(text));
  } catch {
    throw new Error('private RFQ relay response is malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('private RFQ relay response must be an object');
  }
  return value as Record<string, unknown>;
}

export class HttpPrivateRfqRelay implements PrivateRfqRelayPort {
  readonly #origin: string;
  readonly #solverId: string;
  readonly #keyId: string;
  readonly #signer: PrivateRfqSigner;
  readonly #fetch: typeof fetch;
  readonly #clockMs: () => number;

  constructor(input: Readonly<{
    origin: string;
    solverId: string;
    keyId: string;
    signer: PrivateRfqSigner;
    fetch?: typeof fetch;
    clockMs?: () => number;
  }>) {
    this.#origin = loopbackOrigin(input.origin);
    if (!IDENTIFIER.test(input.solverId) || !IDENTIFIER.test(input.keyId)) {
      throw new Error('private RFQ solver and key identifiers are invalid');
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
    const signature = this.#signer.signDigest(digest);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) {
      throw new Error('private RFQ signer must return a 64-byte signature');
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
    const parsed = await boundedProtocolJson(response);
    if (!response.ok) {
      const error = typeof parsed.error === 'object' && parsed.error !== null
        ? parsed.error as Record<string, unknown>
        : {};
      throw new PrivateRfqRelayError(
        response.status,
        String(error.code ?? 'RELAY_ERROR'),
        String(error.message ?? 'private RFQ relay rejected the request'),
      );
    }
    return parsed;
  }

  async pending(): Promise<readonly PendingPrivateRfq[]> {
    const body = await this.#call('GET', '/v1/solver/private-rfqs');
    if (!Array.isArray(body.envelopes)) throw new Error('private RFQ relay did not return envelopes');
    return Object.freeze(body.envelopes.map((value, index) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`private RFQ ${index} is invalid`);
      }
      const entry = value as Record<string, unknown>;
      const envelope = privateRfqEnvelope(entry.envelope as PrivateRfqEnvelopeInput);
      const envelopeHash = toHex(privateRfqEnvelopeHash(envelope));
      if (entry.envelopeHash !== envelopeHash
        || !(entry.ciphertext instanceof Uint8Array)
        || !(entry.senderSignature instanceof Uint8Array)
        || entry.senderSignature.length !== 64) {
        throw new Error(`private RFQ ${index} binding is invalid`);
      }
      return Object.freeze({
        envelopeHash,
        envelope,
        ciphertext: Uint8Array.from(entry.ciphertext),
        senderSignature: Uint8Array.from(entry.senderSignature),
      });
    }));
  }

  async respond(envelopeHash: string, input: Readonly<{
    quoteHash: string;
    quoteOrderHash: string;
    responseEncryptionKey: Uint8Array;
    responseCiphertext: Uint8Array;
  }>): Promise<void> {
    if (!HASH.test(envelopeHash) || !HASH.test(input.quoteHash) || !HASH.test(input.quoteOrderHash)) {
      throw new Error('private RFQ response binding is invalid');
    }
    await this.#call('POST', `/v1/solver/private-rfqs/${envelopeHash}/response`, input);
  }
}

function verifySender(envelope: PrivateRfqEnvelope, signature: Uint8Array): boolean {
  let raw: Uint8Array;
  try {
    raw = bs58.decode(envelope.senderKeyId);
  } catch {
    return false;
  }
  if (raw.length !== 32 || bs58.encode(raw) !== envelope.senderKeyId || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, privateRfqEnvelopeHash(envelope), key, signature);
  } catch {
    return false;
  }
}

export function loadPrivateRfqEncryptionKey(
  path: string,
  expectedKeyId: string,
): Uint8Array {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_KEY_FILE_BYTES) {
    throw new Error('private RFQ encryption key must be a bounded regular file');
  }
  if ((stat.mode & 0o077) !== 0) throw new Error('private RFQ encryption key file must not grant group or other access');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('private RFQ encryption key file must be owned by the solver user');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('private RFQ encryption key file must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('private RFQ encryption key file must be an object');
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 4 || keys[0] !== 'keyId' || keys[1] !== 'privateKey'
    || keys[2] !== 'suiteId' || keys[3] !== 'version'
    || record.version !== 1 || record.suiteId !== NARYX_RFQ_HPKE_SUITE_ID
    || record.keyId !== expectedKeyId || typeof record.privateKey !== 'string'
    || !/^[0-9a-f]{64}$/.test(record.privateKey)) {
    throw new Error('private RFQ encryption key file fields are invalid');
  }
  const key = Uint8Array.from(Buffer.from(record.privateKey, 'hex'));
  if (key.length !== NARYX_RFQ_HPKE_PRIVATE_KEY_BYTES) throw new Error('private RFQ encryption key is invalid');
  return key;
}

export class PrivateRfqParticipant {
  readonly #solverId: string;
  readonly #encryptionKeyId: string;
  readonly #privateKey: Uint8Array;
  readonly #relay: PrivateRfqRelayPort;
  readonly #quotes: PrivateRfqQuotePort;
  #running = false;

  constructor(input: Readonly<{
    solverId: string;
    encryptionKeyId: string;
    privateKey: Uint8Array;
    relay: PrivateRfqRelayPort;
    quotes: PrivateRfqQuotePort;
  }>) {
    if (!IDENTIFIER.test(input.solverId) || !IDENTIFIER.test(input.encryptionKeyId)) {
      throw new Error('private RFQ participant identifiers are invalid');
    }
    if (!(input.privateKey instanceof Uint8Array) || input.privateKey.length !== NARYX_RFQ_HPKE_PRIVATE_KEY_BYTES) {
      throw new Error('private RFQ participant private key is invalid');
    }
    this.#solverId = input.solverId;
    this.#encryptionKeyId = input.encryptionKeyId;
    this.#privateKey = Uint8Array.from(input.privateKey);
    this.#relay = input.relay;
    this.#quotes = input.quotes;
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const pending of await this.#relay.pending()) await this.#process(pending);
    } finally {
      this.#running = false;
    }
  }

  async #process(pending: PendingPrivateRfq): Promise<void> {
    const envelope = pending.envelope;
    if (envelope.recipientSolverId !== this.#solverId
      || envelope.recipientEncryptionKeyId !== this.#encryptionKeyId
      || envelope.encryptionSuiteId !== NARYX_RFQ_HPKE_SUITE_ID) {
      throw new Error('private RFQ is addressed to another participant key');
    }
    if (!verifySender(envelope, pending.senderSignature)) {
      throw new Error('private RFQ sender signature is invalid');
    }
    const request = decodePrivateRfqQuoteRequest(await decryptPrivateRfqRequest({
      envelope,
      ciphertext: pending.ciphertext,
      recipientPrivateKey: this.#privateKey,
    }));
    const orderHash = toHex(request.orderHash);
    if (orderHash !== toHex(envelope.orderHash)) throw new Error('private RFQ plaintext names another order');
    const quote = await this.#quotes.quote({
      orderHash,
      idempotencyKey: `private-rfq.${pending.envelopeHash}`,
    });
    if (quote.orderHash !== orderHash
      || !HASH.test(quote.quoteHash)
      || quote.quote.environment !== envelope.environment
      || quote.quote.solverId !== this.#solverId) {
      throw new Error('private RFQ quote does not match its envelope');
    }
    const encrypted = await encryptPrivateRfqResponse({
      envelope,
      solverId: this.#solverId,
      quoteHash: quote.quoteHash,
      quoteOrderHash: quote.orderHash,
      plaintext: encodePrivateRfqQuoteResponse(quote),
    });
    await this.#relay.respond(pending.envelopeHash, {
      quoteHash: quote.quoteHash,
      quoteOrderHash: quote.orderHash,
      responseEncryptionKey: encrypted.response.responseEncryptionKey,
      responseCiphertext: encrypted.ciphertext,
    });
  }

  start(intervalMs: number, onError: (error: unknown) => void): () => void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) {
      throw new Error('private RFQ poll interval must be at least 100 ms');
    }
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      void this.tick().catch(onError);
    }, intervalMs);
    timer.unref();
    void this.tick().catch(onError);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}
