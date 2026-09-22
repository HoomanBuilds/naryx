import { MalformedInputError } from './errors.js';

export function encodeUtf8(value: string, context = 'string'): Uint8Array {
  if (typeof value !== 'string') {
    throw new MalformedInputError(context, 'expected a string');
  }
  const out: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    let point = value.charCodeAt(i);
    if (point >= 0xd800 && point <= 0xdbff) {
      const low = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (low < 0xdc00 || low > 0xdfff) {
        throw new MalformedInputError(context, `unpaired high surrogate at index ${i}`);
      }
      point = 0x10000 + ((point - 0xd800) << 10) + (low - 0xdc00);
      i += 1;
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      throw new MalformedInputError(context, `unpaired low surrogate at index ${i}`);
    }
    if (point < 0x80) {
      out.push(point);
    } else if (point < 0x800) {
      out.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point < 0x10000) {
      out.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      out.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

export function encodeAscii(value: string, context = 'ascii'): Uint8Array {
  if (typeof value !== 'string') {
    throw new MalformedInputError(context, 'expected a string');
  }
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 0x7f) {
      throw new MalformedInputError(context, `non-ascii character at index ${i}`);
    }
    out[i] = code;
  }
  return out;
}
