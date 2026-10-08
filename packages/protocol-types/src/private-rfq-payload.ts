import { commitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { parseProtocolJson, stringifyProtocolJson } from './protocol-json.js';

export const PRIVATE_RFQ_QUOTE_REQUEST_VERSION = 1;

export interface PrivateRfqQuoteRequestInput {
  readonly version: number;
  readonly orderHash: Uint8Array | string;
}

export interface PrivateRfqQuoteRequest {
  readonly version: 1;
  readonly orderHash: CommitmentHash;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function privateRfqQuoteRequest(
  input: PrivateRfqQuoteRequestInput,
  context = 'privateRfqQuoteRequest',
): PrivateRfqQuoteRequest {
  const value = record(input, context);
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'orderHash' || keys[1] !== 'version') {
    throw new TypeError(`${context} must contain only version and orderHash`);
  }
  if (input.version !== PRIVATE_RFQ_QUOTE_REQUEST_VERSION) {
    throw new TypeError(`${context}.version must equal ${PRIVATE_RFQ_QUOTE_REQUEST_VERSION}`);
  }
  return Object.freeze({
    version: PRIVATE_RFQ_QUOTE_REQUEST_VERSION,
    orderHash: commitmentHash(input.orderHash, `${context}.orderHash`),
  });
}

export function encodePrivateRfqQuoteRequest(input: PrivateRfqQuoteRequestInput): Uint8Array {
  return new TextEncoder().encode(stringifyProtocolJson(privateRfqQuoteRequest(input), 'privateRfqQuoteRequest'));
}

export function decodePrivateRfqQuoteRequest(value: Uint8Array): PrivateRfqQuoteRequest {
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new TypeError('private RFQ request plaintext must be non-empty bytes');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new TypeError('private RFQ request plaintext must be UTF-8');
  }
  return privateRfqQuoteRequest(
    parseProtocolJson(text, 'privateRfqQuoteRequest') as PrivateRfqQuoteRequestInput,
  );
}

export function encodePrivateRfqQuoteResponse(value: unknown): Uint8Array {
  return new TextEncoder().encode(stringifyProtocolJson(value, 'privateRfqQuoteResponse'));
}

export function decodePrivateRfqQuoteResponse(value: Uint8Array): unknown {
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new TypeError('private RFQ response plaintext must be non-empty bytes');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new TypeError('private RFQ response plaintext must be UTF-8');
  }
  return parseProtocolJson(text, 'privateRfqQuoteResponse');
}
