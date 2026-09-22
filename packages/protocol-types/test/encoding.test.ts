import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  assetAmount,
  encodeAssetAmount,
  fromHex,
  toHex,
} from '../src/index.js';
import { loadFixture, type EncodingFixture, type EncodingVector } from './fixtures.js';

const fixture = loadFixture<EncodingFixture>('encoding.json');

function stringFromCodeUnits(codeUnits: string[]): string {
  return codeUnits.map((unit) => String.fromCharCode(Number.parseInt(unit, 16))).join('');
}

function encodeVector(vector: EncodingVector): Uint8Array {
  const writer = new CanonicalWriter();
  switch (vector.kind) {
    case 'fixedBytes':
      writer.writeFixedBytes(fromHex(vector.valueHex as string), vector.length as number);
      break;
    case 'unsigned':
      writer.writeUnsigned(BigInt(vector.value as string), vector.bits as number);
      break;
    case 'signed':
      writer.writeSigned(BigInt(vector.value as string), vector.bits as number);
      break;
    case 'bool':
      writer.writeBool(vector.value as boolean);
      break;
    case 'byteString':
      writer.writeByteString(fromHex(vector.valueHex as string));
      break;
    case 'string':
      writer.writeString(stringFromCodeUnits(vector.valueCodeUnits as string[]));
      break;
    case 'optionalAbsentU32':
      writer.writeOptional(undefined, (target, value: bigint) => target.writeU32(value));
      break;
    case 'optionalPresentU32':
      writer.writeOptional(BigInt(vector.value as string), (target, value) => target.writeU32(value));
      break;
    case 'arrayU8':
      writer.writeArray(vector.values as string[], (target, value) => target.writeU8(BigInt(value)));
      break;
    case 'setU8':
      writer.writeSet(vector.values as string[], (target, value) => target.writeU8(BigInt(value)));
      break;
    case 'setString':
      writer.writeSet(vector.values as string[], (target, value) => target.writeString(value));
      break;
    case 'assetAmount':
      encodeAssetAmount(
        writer,
        assetAmount(vector.asset as string, vector.decimals as number, BigInt(vector.atoms as string)),
      );
      break;
    default:
      throw new Error(`unknown fixture kind ${vector.kind}`);
  }
  return writer.bytes();
}

describe('canonical encoding golden vectors', () => {
  for (const vector of fixture.vectors) {
    test(vector.name, () => {
      assert.equal(toHex(encodeVector(vector)), vector.hex);
    });
  }

  test('string fixtures declare unambiguous utf-16 input', () => {
    for (const vector of fixture.vectors) {
      if (vector.kind !== 'string') continue;
      assert.equal(stringFromCodeUnits(vector.valueCodeUnits as string[]), vector.value);
    }
  });
});

describe('unicode is never normalized before encoding', () => {
  const precomposed = '\u00e9';
  const decomposed = 'e\u0301';

  test('canonically equivalent strings stay byte-distinct', () => {
    assert.equal(precomposed.normalize('NFD'), decomposed);
    assert.equal(decomposed.normalize('NFC'), precomposed);
    assert.notEqual(precomposed, decomposed);

    const left = toHex(new CanonicalWriter().writeString(precomposed).bytes());
    const right = toHex(new CanonicalWriter().writeString(decomposed).bytes());
    assert.equal(left, '00000002c3a9');
    assert.equal(right, '0000000365cc81');
    assert.notEqual(left, right);
  });

  test('set membership uses canonical bytes, not visual equality', () => {
    const encoded = new CanonicalWriter()
      .writeSet([precomposed, decomposed], (target, value) => target.writeString(value))
      .bytes();
    assert.equal(toHex(encoded), '0000000200000002c3a90000000365cc81');
  });
});

describe('integer bounds fail closed', () => {
  test('u8 rejects one step above the maximum', () => {
    assert.throws(() => new CanonicalWriter().writeU8(256), RangeViolationError);
  });

  test('u8 rejects one step below zero', () => {
    assert.throws(() => new CanonicalWriter().writeU8(-1), RangeViolationError);
  });

  test('u64 rejects one step above the maximum', () => {
    assert.throws(() => new CanonicalWriter().writeU64(1n << 64n), RangeViolationError);
  });

  test('u64 accepts zero and the maximum', () => {
    assert.equal(toHex(new CanonicalWriter().writeU64(0n).bytes()), '0000000000000000');
    assert.equal(
      toHex(new CanonicalWriter().writeU64((1n << 64n) - 1n).bytes()),
      'ffffffffffffffff',
    );
  });

  test('i64 accepts both boundaries and rejects one step past each', () => {
    const min = -(1n << 63n);
    const max = (1n << 63n) - 1n;
    assert.equal(toHex(new CanonicalWriter().writeI64(min).bytes()), '8000000000000000');
    assert.equal(toHex(new CanonicalWriter().writeI64(max).bytes()), '7fffffffffffffff');
    assert.throws(() => new CanonicalWriter().writeI64(min - 1n), RangeViolationError);
    assert.throws(() => new CanonicalWriter().writeI64(max + 1n), RangeViolationError);
  });

  test('i256 accepts both boundaries and rejects one step past each', () => {
    const min = -(1n << 255n);
    const max = (1n << 255n) - 1n;
    assert.equal(new CanonicalWriter().writeI256(min).bytes().length, 32);
    assert.equal(new CanonicalWriter().writeI256(max).bytes().length, 32);
    assert.throws(() => new CanonicalWriter().writeI256(min - 1n), RangeViolationError);
    assert.throws(() => new CanonicalWriter().writeI256(max + 1n), RangeViolationError);
  });

  test('numbers beyond the safe integer range are rejected as a range failure', () => {
    assert.throws(
      () => new CanonicalWriter().writeU64(2 ** 53),
      (error: unknown) =>
        error instanceof RangeViolationError && error.detail.includes('safe integer'),
    );
  });

  test('non-integer and non-finite numbers are malformed', () => {
    assert.throws(() => new CanonicalWriter().writeU32(1.5), MalformedInputError);
    assert.throws(() => new CanonicalWriter().writeU32(Number.NaN), MalformedInputError);
    assert.throws(() => new CanonicalWriter().writeU32(Number.POSITIVE_INFINITY), MalformedInputError);
  });
});

describe('fixed byte fields validate their exact length', () => {
  test('one byte short is rejected', () => {
    assert.throws(
      () => new CanonicalWriter().writeFixedBytes(new Uint8Array(31), 32),
      MalformedInputError,
    );
  });

  test('one byte long is rejected', () => {
    assert.throws(
      () => new CanonicalWriter().writeFixedBytes(new Uint8Array(33), 32),
      MalformedInputError,
    );
  });

  test('a non-byte-array is rejected', () => {
    assert.throws(
      () => new CanonicalWriter().writeFixedBytes([0] as unknown as Uint8Array, 1),
      MalformedInputError,
    );
  });
});

describe('hex parsing fails closed', () => {
  test('odd length is rejected', () => {
    assert.throws(() => fromHex('abc'), MalformedInputError);
  });

  test('non-hex characters are rejected', () => {
    assert.throws(() => fromHex('zz'), MalformedInputError);
    assert.throws(() => fromHex('00ag'), MalformedInputError);
  });

  test('an optional 0x prefix is accepted and round-trips lowercase', () => {
    assert.equal(toHex(fromHex('0xDEADBEEF')), 'deadbeef');
    assert.equal(toHex(fromHex('deadbeef')), 'deadbeef');
  });
});

describe('strings reject ill-formed utf-16 input', () => {
  test('an unpaired high surrogate is rejected', () => {
    assert.throws(() => new CanonicalWriter().writeString('\ud83d'), MalformedInputError);
  });

  test('an unpaired low surrogate is rejected', () => {
    assert.throws(() => new CanonicalWriter().writeString('\ude80'), MalformedInputError);
  });

  test('a high surrogate followed by a non-surrogate is rejected', () => {
    assert.throws(() => new CanonicalWriter().writeString('a\ud83dz'), MalformedInputError);
  });

  test('a reversed surrogate pair is rejected', () => {
    assert.throws(() => new CanonicalWriter().writeString('\ude80\ud83d'), MalformedInputError);
  });
});

describe('optional presence tags are exactly 0 or 1', () => {
  test('any other tag is rejected', () => {
    assert.throws(() => new CanonicalWriter().writeOptionalTag(2), MalformedInputError);
    assert.throws(() => new CanonicalWriter().writeOptionalTag(-1), MalformedInputError);
  });

  test('null is not a canonical absent value', () => {
    assert.throws(
      () =>
        new CanonicalWriter().writeOptional(null as unknown as bigint, (target, value) =>
          target.writeU32(value),
        ),
      MalformedInputError,
    );
  });
});

describe('canonical sets reject duplicates', () => {
  test('duplicate u8 elements are rejected', () => {
    assert.throws(
      () => new CanonicalWriter().writeSet(['1', '2', '1'], (target, value) => target.writeU8(BigInt(value))),
      DuplicateElementError,
    );
  });

  test('duplicate string elements are rejected', () => {
    assert.throws(
      () => new CanonicalWriter().writeSet(['naryx', 'naryx'], (target, value) => target.writeString(value)),
      DuplicateElementError,
    );
  });

  test('an empty set encodes as a zero count', () => {
    assert.equal(
      toHex(new CanonicalWriter().writeSet([], (target, value: bigint) => target.writeU8(value)).bytes()),
      '00000000',
    );
  });
});

describe('booleans encode exactly 0 and 1', () => {
  test('a non-boolean is rejected', () => {
    assert.throws(() => new CanonicalWriter().writeBool(1 as unknown as boolean), MalformedInputError);
    assert.throws(() => new CanonicalWriter().writeBool('true' as unknown as boolean), MalformedInputError);
  });
});

describe('writer composition', () => {
  test('chained fields concatenate in call order', () => {
    const bytes = new CanonicalWriter()
      .writeU8(1)
      .writeBool(true)
      .writeString('naryx')
      .writeOptional(undefined, (target, value: bigint) => target.writeU64(value))
      .bytes();
    assert.equal(toHex(bytes), '0101000000056e6172797800');
  });

  test('bytes() is repeatable and returns an independent copy', () => {
    const writer = new CanonicalWriter().writeU32(7);
    const first = writer.bytes();
    const second = writer.bytes();
    assert.equal(toHex(first), toHex(second));
    first[0] = 0xff;
    assert.equal(toHex(writer.bytes()), '00000007');
  });
});
