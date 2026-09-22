import { assertU32Length, checkedSigned, checkedUnsigned } from './arithmetic.js';
import { assertUint8Array, compareBytes, concatBytes } from './bytes.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { enumDiscriminant, type EnumTable } from './enums.js';
import { encodeUtf8 } from './text.js';

export type ElementEncoder<T> = (writer: CanonicalWriter, value: T) => void;

export const OPTIONAL_ABSENT = 0;
export const OPTIONAL_PRESENT = 1;

function unsignedBytes(value: bigint, bits: number): Uint8Array {
  const out = new Uint8Array(bits / 8);
  let remaining = value;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

export class CanonicalWriter {
  #chunks: Uint8Array[] = [];

  #push(chunk: Uint8Array): this {
    this.#chunks.push(chunk);
    return this;
  }

  writeFixedBytes(value: Uint8Array, length: number, context = 'fixedBytes'): this {
    assertUint8Array(value, context);
    assertU32Length(length, `${context}.length`);
    if (value.length !== length) {
      throw new MalformedInputError(context, `expected ${length} bytes, received ${value.length}`);
    }
    return this.#push(Uint8Array.from(value));
  }

  writeUnsigned(value: bigint | number, bits: number, context = `u${bits}`): this {
    return this.#push(unsignedBytes(checkedUnsigned(value, bits, context), bits));
  }

  writeSigned(value: bigint | number, bits: number, context = `i${bits}`): this {
    const checked = checkedSigned(value, bits, context);
    const encoded = checked < 0n ? checked + (1n << BigInt(bits)) : checked;
    return this.#push(unsignedBytes(encoded, bits));
  }

  writeU8(value: bigint | number, context = 'u8'): this {
    return this.writeUnsigned(value, 8, context);
  }

  writeU16(value: bigint | number, context = 'u16'): this {
    return this.writeUnsigned(value, 16, context);
  }

  writeU32(value: bigint | number, context = 'u32'): this {
    return this.writeUnsigned(value, 32, context);
  }

  writeU64(value: bigint | number, context = 'u64'): this {
    return this.writeUnsigned(value, 64, context);
  }

  writeU128(value: bigint | number, context = 'u128'): this {
    return this.writeUnsigned(value, 128, context);
  }

  writeU256(value: bigint | number, context = 'u256'): this {
    return this.writeUnsigned(value, 256, context);
  }

  writeI64(value: bigint | number, context = 'i64'): this {
    return this.writeSigned(value, 64, context);
  }

  writeI128(value: bigint | number, context = 'i128'): this {
    return this.writeSigned(value, 128, context);
  }

  writeI256(value: bigint | number, context = 'i256'): this {
    return this.writeSigned(value, 256, context);
  }

  writeBool(value: boolean, context = 'bool'): this {
    if (typeof value !== 'boolean') {
      throw new MalformedInputError(context, 'expected a boolean');
    }
    return this.writeU8(value ? 1 : 0, context);
  }

  writeEnum<Name extends string>(
    table: EnumTable<Name>,
    name: Name,
    context = 'enum',
  ): this {
    return this.writeU8(enumDiscriminant(table, name, context), context);
  }

  writeByteString(value: Uint8Array, context = 'byteString'): this {
    assertUint8Array(value, context);
    assertU32Length(value.length, `${context}.length`);
    this.writeU32(value.length, `${context}.length`);
    return this.#push(Uint8Array.from(value));
  }

  writeString(value: string, context = 'string'): this {
    const encoded = encodeUtf8(value, context);
    assertU32Length(encoded.length, `${context}.length`);
    this.writeU32(encoded.length, `${context}.length`);
    return this.#push(encoded);
  }

  writeOptionalTag(tag: number, context = 'optionalTag'): this {
    if (tag !== OPTIONAL_ABSENT && tag !== OPTIONAL_PRESENT) {
      throw new MalformedInputError(context, `optional tag ${String(tag)} is neither 0 nor 1`);
    }
    return this.writeU8(tag, context);
  }

  writeOptional<T>(
    value: T | undefined,
    encode: ElementEncoder<T>,
    context = 'optional',
  ): this {
    if (value === undefined) {
      return this.writeOptionalTag(OPTIONAL_ABSENT, context);
    }
    if (value === null) {
      throw new MalformedInputError(context, 'null is not a canonical absent value');
    }
    this.writeOptionalTag(OPTIONAL_PRESENT, context);
    encode(this, value);
    return this;
  }

  writeArray<T>(
    items: readonly T[],
    encode: ElementEncoder<T>,
    context = 'array',
  ): this {
    if (!Array.isArray(items)) {
      throw new MalformedInputError(context, 'expected an array');
    }
    assertU32Length(items.length, `${context}.count`);
    this.writeU32(items.length, `${context}.count`);
    for (const item of items) encode(this, item);
    return this;
  }

  writeSet<T>(
    items: readonly T[],
    encode: ElementEncoder<T>,
    context = 'set',
  ): this {
    if (!Array.isArray(items)) {
      throw new MalformedInputError(context, 'expected an array');
    }
    assertU32Length(items.length, `${context}.count`);
    const encoded = items.map((item) => {
      const element = new CanonicalWriter();
      encode(element, item);
      return element.bytes();
    });
    encoded.sort(compareBytes);
    for (let i = 1; i < encoded.length; i += 1) {
      if (compareBytes(encoded[i - 1] as Uint8Array, encoded[i] as Uint8Array) === 0) {
        throw new DuplicateElementError(context, `duplicate canonical element at sorted index ${i}`);
      }
    }
    this.writeU32(encoded.length, `${context}.count`);
    return this.#push(concatBytes(encoded));
  }

  bytes(): Uint8Array {
    return concatBytes(this.#chunks);
  }
}

export function canonicalBytes(encode: (writer: CanonicalWriter) => void): Uint8Array {
  const writer = new CanonicalWriter();
  encode(writer);
  return writer.bytes();
}
