import { MalformedInputError } from './errors.js';
import { fromHex, toHex } from './bytes.js';
import { encodeUtf8 } from './text.js';

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_JSON_BYTES = 1_048_576;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)$/;
const HEX = /^(?:[0-9a-f]{2})*$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ProtocolJsonObject {
  readonly [key: string]: ProtocolJsonValue;
}

export interface ProtocolJsonArray extends ReadonlyArray<ProtocolJsonValue> {}

export type ProtocolJsonValue = null | boolean | string | number | ProtocolJsonArray | ProtocolJsonObject;

type TraversalState = { nodes: number };

function visit(state: TraversalState, depth: number, context: string): void {
  state.nodes += 1;
  if (depth > MAX_DEPTH) throw new MalformedInputError(context, 'maximum depth exceeded');
  if (state.nodes > MAX_NODES) throw new MalformedInputError(context, 'maximum node count exceeded');
}

function encode(value: unknown, state: TraversalState, depth: number, context: string): ProtocolJsonValue {
  visit(state, depth, context);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new MalformedInputError(context, 'expected a safe integer');
    return value;
  }
  if (typeof value === 'bigint') {
    return Object.freeze({ $naryxType: 'bigint', value: value.toString(10) });
  }
  if (value instanceof Uint8Array) {
    return Object.freeze({ $naryxType: 'bytes', value: toHex(value) });
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => encode(entry, state, depth + 1, `${context}[${index}]`)));
  }
  if (typeof value !== 'object') throw new MalformedInputError(context, 'unsupported JSON value');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MalformedInputError(context, 'expected a plain object');
  }
  const output: Record<string, ProtocolJsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    if (FORBIDDEN_KEYS.has(key)) throw new MalformedInputError(context, 'forbidden object key');
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) continue;
    output[key] = encode(entry, state, depth + 1, `${context}.${key}`);
  }
  return Object.freeze(output);
}

function decode(value: unknown, state: TraversalState, depth: number, context: string): unknown {
  visit(state, depth, context);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new MalformedInputError(context, 'expected a safe integer');
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => decode(entry, state, depth + 1, `${context}[${index}]`)));
  }
  if (typeof value !== 'object') throw new MalformedInputError(context, 'unsupported JSON value');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.includes('$naryxType')) {
    if (keys.length !== 2 || keys[0] !== '$naryxType' || keys[1] !== 'value'
      || typeof record.value !== 'string') {
      throw new MalformedInputError(context, 'invalid tagged scalar');
    }
    if (record.$naryxType === 'bigint') {
      if (!DECIMAL.test(record.value)) throw new MalformedInputError(context, 'invalid bigint tag');
      return BigInt(record.value);
    }
    if (record.$naryxType === 'bytes') {
      if (!HEX.test(record.value)) throw new MalformedInputError(context, 'invalid bytes tag');
      return fromHex(record.value, context);
    }
    throw new MalformedInputError(context, 'unknown tagged scalar');
  }
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) throw new MalformedInputError(context, 'forbidden object key');
    output[key] = decode(record[key], state, depth + 1, `${context}.${key}`);
  }
  return Object.freeze(output);
}

export function toProtocolJson(value: unknown, context = 'protocolJson'): ProtocolJsonValue {
  return encode(value, { nodes: 0 }, 0, context);
}

export function fromProtocolJson(value: unknown, context = 'protocolJson'): unknown {
  return decode(value, { nodes: 0 }, 0, context);
}

export function stringifyProtocolJson(value: unknown, context = 'protocolJson'): string {
  const text = JSON.stringify(toProtocolJson(value, context));
  if (encodeUtf8(text).length > MAX_JSON_BYTES) {
    throw new MalformedInputError(context, 'encoded JSON is too large');
  }
  return text;
}

export function parseProtocolJson(text: string, context = 'protocolJson'): unknown {
  if (typeof text !== 'string' || encodeUtf8(text).length > MAX_JSON_BYTES) {
    throw new MalformedInputError(context, 'encoded JSON is invalid or too large');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new MalformedInputError(context, 'encoded JSON is malformed');
  }
  return fromProtocolJson(value, context);
}
