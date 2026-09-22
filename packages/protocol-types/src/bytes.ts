import { MalformedInputError } from './errors.js';

const HEX_DIGITS = '0123456789abcdef';

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  return -1;
}

export function toHex(value: Uint8Array): string {
  let out = '';
  for (const byte of value) {
    out += HEX_DIGITS[byte >> 4];
    out += HEX_DIGITS[byte & 0x0f];
  }
  return out;
}

export function fromHex(value: string, context = 'hex'): Uint8Array {
  if (typeof value !== 'string') {
    throw new MalformedInputError(context, 'expected a string');
  }
  const body = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (body.length % 2 !== 0) {
    throw new MalformedInputError(context, `odd hex length ${body.length}`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const high = hexValue(body.charCodeAt(i * 2));
    const low = hexValue(body.charCodeAt(i * 2 + 1));
    if (high < 0 || low < 0) {
      throw new MalformedInputError(context, `non-hex character at offset ${i * 2}`);
    }
    out[i] = (high << 4) | low;
  }
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const limit = Math.min(left.length, right.length);
  for (let i = 0; i < limit; i += 1) {
    const a = left[i] as number;
    const b = right[i] as number;
    if (a !== b) return a < b ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return compareBytes(left, right) === 0;
}

export function assertUint8Array(value: unknown, context: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new MalformedInputError(context, 'expected a Uint8Array');
  }
  return value;
}
