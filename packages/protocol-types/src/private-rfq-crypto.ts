import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { bytesEqual } from './bytes.js';
import {
  privateRfqAssociatedData,
  privateRfqEnvelope,
  privateRfqEnvelopeHash,
  privateRfqResponseAssociatedData,
  verifyPrivateRfqResponse,
  type PrivateRfqEnvelope,
  type PrivateRfqEnvelopeInput,
  type PrivateRfqResponseInput,
} from './private-delivery.js';

export const NARYX_RFQ_HPKE_SUITE_ID = 'hpke-x25519-sha256-aes256gcm';
export const NARYX_RFQ_HPKE_PUBLIC_KEY_BYTES = 32;
export const NARYX_RFQ_HPKE_PRIVATE_KEY_BYTES = 32;
export const NARYX_RFQ_HPKE_ENCAPSULATED_KEY_BYTES = 32;
export const NARYX_RFQ_MAX_PLAINTEXT_BYTES = 65_536;

const REQUEST_INFO = new TextEncoder().encode('Naryx private RFQ request v1');
const RESPONSE_INFO = new TextEncoder().encode('Naryx private RFQ response v1');
const ASSOCIATED_DATA_HASH_PLACEHOLDER = new Uint8Array(32).fill(1);
const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

export type PrivateRfqEnvelopeHeaderInput = Omit<PrivateRfqEnvelopeInput, 'ciphertextHash'>;

export type NaryxRfqHpkeKeyPair = Readonly<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}>;

export class NaryxPrivateRfqCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NaryxPrivateRfqCryptoError';
  }
}

function bytes(value: Uint8Array, length: number | undefined, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length === 0 || (length !== undefined && value.length !== length)) {
    throw new TypeError(length === undefined ? `${name} must be non-empty bytes` : `${name} must be ${length} bytes`);
  }
  return Uint8Array.from(value);
}

function plaintext(value: Uint8Array): Uint8Array {
  const checked = bytes(value, undefined, 'plaintext');
  if (checked.length > NARYX_RFQ_MAX_PLAINTEXT_BYTES) {
    throw new TypeError(`plaintext exceeds ${NARYX_RFQ_MAX_PLAINTEXT_BYTES} bytes`);
  }
  return checked;
}

function requireSuite(id: string): void {
  if (id !== NARYX_RFQ_HPKE_SUITE_ID) {
    throw new TypeError(`unsupported private RFQ encryption suite: ${id}`);
  }
}

function wireCiphertext(encapsulatedKey: ArrayBuffer, sealed: ArrayBuffer): Uint8Array {
  const enc = new Uint8Array(encapsulatedKey);
  if (enc.length !== NARYX_RFQ_HPKE_ENCAPSULATED_KEY_BYTES) {
    throw new NaryxPrivateRfqCryptoError('HPKE produced an invalid encapsulated key');
  }
  const ciphertext = new Uint8Array(sealed);
  const wire = new Uint8Array(enc.length + ciphertext.length);
  wire.set(enc);
  wire.set(ciphertext, enc.length);
  return wire;
}

function splitCiphertext(value: Uint8Array): { readonly enc: Uint8Array; readonly ciphertext: Uint8Array } {
  const wire = bytes(value, undefined, 'ciphertext');
  if (wire.length <= NARYX_RFQ_HPKE_ENCAPSULATED_KEY_BYTES + 16) {
    throw new NaryxPrivateRfqCryptoError('private RFQ ciphertext is malformed');
  }
  return Object.freeze({
    enc: wire.slice(0, NARYX_RFQ_HPKE_ENCAPSULATED_KEY_BYTES),
    ciphertext: wire.slice(NARYX_RFQ_HPKE_ENCAPSULATED_KEY_BYTES),
  });
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(value.length);
  input.set(value);
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
}

async function seal(
  recipientPublicKeyBytes: Uint8Array,
  message: Uint8Array,
  associatedData: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  try {
    const recipientPublicKey = await suite.kem.deserializePublicKey(
      bytes(recipientPublicKeyBytes, NARYX_RFQ_HPKE_PUBLIC_KEY_BYTES, 'recipient public key'),
    );
    const context = await suite.createSenderContext({ recipientPublicKey, info });
    return wireCiphertext(context.enc, await context.seal(message, associatedData));
  } catch {
    throw new NaryxPrivateRfqCryptoError('private RFQ encryption failed');
  }
}

async function open(
  recipientPrivateKeyBytes: Uint8Array,
  wire: Uint8Array,
  associatedData: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  const split = splitCiphertext(wire);
  try {
    const recipientKey = await suite.kem.deserializePrivateKey(
      bytes(recipientPrivateKeyBytes, NARYX_RFQ_HPKE_PRIVATE_KEY_BYTES, 'recipient private key'),
    );
    const context = await suite.createRecipientContext({ recipientKey, enc: split.enc, info });
    return new Uint8Array(await context.open(split.ciphertext, associatedData));
  } catch {
    throw new NaryxPrivateRfqCryptoError('private RFQ decryption failed');
  }
}

export async function generateNaryxRfqHpkeKeyPair(): Promise<NaryxRfqHpkeKeyPair> {
  const pair = await suite.kem.generateKeyPair();
  return Object.freeze({
    publicKey: new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey)),
    privateKey: new Uint8Array(await suite.kem.serializePrivateKey(pair.privateKey)),
  });
}

export async function encryptPrivateRfqRequest(input: Readonly<{
  header: PrivateRfqEnvelopeHeaderInput;
  recipientPublicKey: Uint8Array;
  plaintext: Uint8Array;
}>): Promise<Readonly<{ envelope: PrivateRfqEnvelope; ciphertext: Uint8Array }>> {
  requireSuite(input.header.encryptionSuiteId);
  const provisional = { ...input.header, ciphertextHash: ASSOCIATED_DATA_HASH_PLACEHOLDER };
  const ciphertext = await seal(
    input.recipientPublicKey,
    plaintext(input.plaintext),
    privateRfqAssociatedData(provisional),
    REQUEST_INFO,
  );
  const envelope = privateRfqEnvelope({ ...input.header, ciphertextHash: await sha256(ciphertext) });
  return Object.freeze({ envelope, ciphertext });
}

export async function decryptPrivateRfqRequest(input: Readonly<{
  envelope: PrivateRfqEnvelopeInput;
  ciphertext: Uint8Array;
  recipientPrivateKey: Uint8Array;
}>): Promise<Uint8Array> {
  const envelope = privateRfqEnvelope(input.envelope);
  requireSuite(envelope.encryptionSuiteId);
  const ciphertext = bytes(input.ciphertext, undefined, 'ciphertext');
  if (!bytesEqual(await sha256(ciphertext), envelope.ciphertextHash)) {
    throw new NaryxPrivateRfqCryptoError('private RFQ ciphertext hash mismatch');
  }
  return open(input.recipientPrivateKey, ciphertext, privateRfqAssociatedData(envelope), REQUEST_INFO);
}

export async function encryptPrivateRfqResponse(input: Readonly<{
  envelope: PrivateRfqEnvelopeInput;
  solverId: string;
  quoteHash: Uint8Array | string;
  quoteOrderHash: Uint8Array | string;
  plaintext: Uint8Array;
}>): Promise<Readonly<{ response: PrivateRfqResponseInput; ciphertext: Uint8Array }>> {
  const envelope = privateRfqEnvelope(input.envelope);
  requireSuite(envelope.encryptionSuiteId);
  const metadata = {
    envelopeHash: privateRfqEnvelopeHash(envelope),
    solverId: input.solverId,
    quoteHash: input.quoteHash,
    quoteOrderHash: input.quoteOrderHash,
    responseEncryptionKey: envelope.responseEncryptionKey,
  };
  const ciphertext = await seal(
    envelope.responseEncryptionKey,
    plaintext(input.plaintext),
    privateRfqResponseAssociatedData(metadata),
    RESPONSE_INFO,
  );
  const response = Object.freeze({ ...metadata, responseCiphertextHash: await sha256(ciphertext) });
  const verified = verifyPrivateRfqResponse(envelope, response);
  if (!verified.valid) {
    throw new NaryxPrivateRfqCryptoError(`private RFQ response is invalid: ${verified.reason}`);
  }
  return Object.freeze({ response, ciphertext });
}

export async function decryptPrivateRfqResponse(input: Readonly<{
  envelope: PrivateRfqEnvelopeInput;
  solverId: string;
  quoteHash: Uint8Array | string;
  quoteOrderHash: Uint8Array | string;
  ciphertext: Uint8Array;
  responsePrivateKey: Uint8Array;
}>): Promise<Uint8Array> {
  const envelope = privateRfqEnvelope(input.envelope);
  requireSuite(envelope.encryptionSuiteId);
  const ciphertext = bytes(input.ciphertext, undefined, 'ciphertext');
  const metadata = {
    envelopeHash: privateRfqEnvelopeHash(envelope),
    solverId: input.solverId,
    quoteHash: input.quoteHash,
    quoteOrderHash: input.quoteOrderHash,
    responseEncryptionKey: envelope.responseEncryptionKey,
  };
  const response = { ...metadata, responseCiphertextHash: await sha256(ciphertext) };
  const verified = verifyPrivateRfqResponse(envelope, response);
  if (!verified.valid) {
    throw new NaryxPrivateRfqCryptoError(`private RFQ response is invalid: ${verified.reason}`);
  }
  return open(input.responsePrivateKey, ciphertext, privateRfqResponseAssociatedData(metadata), RESPONSE_INFO);
}
