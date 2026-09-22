import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DivisionByZeroError,
  MalformedInputError,
  RangeViolationError,
  ROUNDING,
  U32_MAX,
  absBigInt,
  assertU32Length,
  checkedSigned,
  checkedUnsigned,
  mulDiv,
  scaleDecimals,
  toBigInt,
  type Rounding,
} from '../src/index.js';
import { loadFixture, type ArithmeticFixture } from './fixtures.js';

const fixture = loadFixture<ArithmeticFixture>('arithmetic.json');

describe('mulDiv golden vectors', () => {
  for (const vector of fixture.mulDiv) {
    for (const mode of fixture.roundingModes) {
      test(`${vector.name} ${mode}`, () => {
        const actual = mulDiv(
          BigInt(vector.left),
          BigInt(vector.right),
          BigInt(vector.divisor),
          mode as Rounding,
        );
        assert.equal(actual.toString(), vector.expected[mode]);
      });
    }
  }
});

describe('scaleDecimals golden vectors', () => {
  for (const vector of fixture.scaleDecimals) {
    for (const mode of fixture.roundingModes) {
      test(`${vector.name} ${mode}`, () => {
        const actual = scaleDecimals(
          BigInt(vector.value),
          vector.fromDecimals,
          vector.toDecimals,
          mode as Rounding,
        );
        assert.equal(actual.toString(), vector.expected[mode]);
      });
    }
  }
});

describe('rounding direction is decided, never defaulted', () => {
  test('one adverse unit separates floor from ceiling on a fee', () => {
    const feeFloor = mulDiv(1000001n, 1n, 1000000n, ROUNDING.FLOOR);
    const feeCeil = mulDiv(1000001n, 1n, 1000000n, ROUNDING.CEIL);
    assert.equal(feeFloor, 1n);
    assert.equal(feeCeil, 2n);
    assert.equal(feeCeil - feeFloor, 1n);
  });

  test('an unknown rounding mode is rejected', () => {
    assert.throws(
      () => mulDiv(1n, 1n, 3n, 'HALF_UP' as unknown as Rounding),
      MalformedInputError,
    );
    assert.throws(
      () => scaleDecimals(1n, 18, 6, 'HALF_UP' as unknown as Rounding),
      MalformedInputError,
    );
  });

  test('exact division ignores the rounding mode', () => {
    for (const mode of Object.values(ROUNDING)) {
      assert.equal(mulDiv(10n, 2n, 5n, mode), 4n);
    }
  });
});

describe('the rounding mode is validated on every path', () => {
  const invalid = 'INVALID' as unknown as Rounding;

  test('an exact mulDiv rejects an unknown rounding mode', () => {
    assert.throws(() => mulDiv(6n, 1n, 2n, invalid), MalformedInputError);
    assert.throws(() => mulDiv(10n, 2n, 5n, invalid), MalformedInputError);
  });

  test('a zero-result mulDiv rejects an unknown rounding mode', () => {
    assert.throws(() => mulDiv(0n, 5n, 3n, invalid), MalformedInputError);
    assert.throws(() => mulDiv(0n, 0n, 1n, invalid), MalformedInputError);
  });

  test('equal decimals reject an unknown rounding mode', () => {
    assert.throws(() => scaleDecimals(1n, 6, 6, invalid), MalformedInputError);
    assert.throws(() => scaleDecimals(0n, 18, 18, invalid), MalformedInputError);
  });

  test('scaling up rejects an unknown rounding mode', () => {
    assert.throws(() => scaleDecimals(1n, 6, 18, invalid), MalformedInputError);
  });

  test('an exact scale down rejects an unknown rounding mode', () => {
    assert.throws(() => scaleDecimals(1000000000000n, 18, 6, invalid), MalformedInputError);
    assert.throws(() => scaleDecimals(1000001n, 18, 6, invalid), MalformedInputError);
  });

  test('a missing or inherited rounding mode is rejected', () => {
    assert.throws(() => mulDiv(1n, 1n, 2n, undefined as unknown as Rounding), MalformedInputError);
    assert.throws(() => mulDiv(1n, 1n, 2n, 'toString' as unknown as Rounding), MalformedInputError);
    assert.throws(
      () => scaleDecimals(1n, 6, 18, undefined as unknown as Rounding),
      MalformedInputError,
    );
    assert.throws(
      () => scaleDecimals(1n, 6, 18, 'constructor' as unknown as Rounding),
      MalformedInputError,
    );
  });
});

describe('division by zero is its own failure', () => {
  test('a zero divisor is rejected', () => {
    assert.throws(() => mulDiv(1n, 1n, 0n, ROUNDING.FLOOR), DivisionByZeroError);
  });

  test('a zero numerator over a zero divisor is still rejected', () => {
    assert.throws(() => mulDiv(0n, 0n, 0n, ROUNDING.FLOOR), DivisionByZeroError);
  });
});

describe('checked fixed-width bounds', () => {
  test('unsigned accepts zero and the maximum', () => {
    assert.equal(checkedUnsigned(0n, 64), 0n);
    assert.equal(checkedUnsigned((1n << 64n) - 1n, 64), (1n << 64n) - 1n);
  });

  test('unsigned rejects one step past each boundary', () => {
    assert.throws(() => checkedUnsigned(-1n, 64), RangeViolationError);
    assert.throws(() => checkedUnsigned(1n << 64n, 64), RangeViolationError);
  });

  test('signed accepts both boundaries and rejects one step past each', () => {
    const min = -(1n << 127n);
    const max = (1n << 127n) - 1n;
    assert.equal(checkedSigned(min, 128), min);
    assert.equal(checkedSigned(max, 128), max);
    assert.throws(() => checkedSigned(min - 1n, 128), RangeViolationError);
    assert.throws(() => checkedSigned(max + 1n, 128), RangeViolationError);
  });

  test('an unsupported width is rejected', () => {
    assert.throws(() => checkedUnsigned(1n, 0), MalformedInputError);
    assert.throws(() => checkedUnsigned(1n, 257), MalformedInputError);
    assert.throws(() => checkedSigned(1n, 1.5), MalformedInputError);
  });
});

describe('number inputs must be safe integers', () => {
  test('a safe integer is accepted', () => {
    assert.equal(toBigInt(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER));
  });

  test('one step past the safe integer range is a range failure', () => {
    assert.throws(() => toBigInt(2 ** 53), RangeViolationError);
    assert.throws(() => toBigInt(-(2 ** 53)), RangeViolationError);
  });

  test('non-integers and non-numbers are malformed', () => {
    assert.throws(() => toBigInt(0.1), MalformedInputError);
    assert.throws(() => toBigInt(Number.NaN), MalformedInputError);
    assert.throws(() => toBigInt(Number.NEGATIVE_INFINITY), MalformedInputError);
    assert.throws(() => toBigInt('7' as unknown as number), MalformedInputError);
  });
});

describe('absolute value stays in bigint', () => {
  test('the i256 minimum keeps full magnitude', () => {
    const min = -(1n << 255n);
    assert.equal(absBigInt(min), 1n << 255n);
    assert.equal(absBigInt(min) > BigInt(Number.MAX_SAFE_INTEGER), true);
  });

  test('zero and positive values are unchanged', () => {
    assert.equal(absBigInt(0n), 0n);
    assert.equal(absBigInt(42n), 42n);
    assert.equal(absBigInt(-42n), 42n);
  });

  test('a non-bigint is rejected', () => {
    assert.throws(() => absBigInt(42 as unknown as bigint), MalformedInputError);
  });
});

describe('u32 collection lengths', () => {
  test('zero and the maximum are accepted', () => {
    assert.equal(assertU32Length(0), 0);
    assert.equal(assertU32Length(U32_MAX), U32_MAX);
  });

  test('one step past the maximum is rejected', () => {
    assert.throws(() => assertU32Length(U32_MAX + 1), RangeViolationError);
  });

  test('a negative or fractional length is rejected', () => {
    assert.throws(() => assertU32Length(-1), RangeViolationError);
    assert.throws(() => assertU32Length(1.5), MalformedInputError);
  });
});

describe('decimal scaling bounds', () => {
  test('decimals outside u8 are rejected', () => {
    assert.throws(() => scaleDecimals(1n, 256, 6, ROUNDING.FLOOR), RangeViolationError);
    assert.throws(() => scaleDecimals(1n, 6, -1, ROUNDING.FLOOR), RangeViolationError);
  });

  test('a non-bigint value is rejected', () => {
    assert.throws(
      () => scaleDecimals(1 as unknown as bigint, 6, 2, ROUNDING.FLOOR),
      MalformedInputError,
    );
  });

  test('scaling up then down with truncation loses the remainder', () => {
    const up = scaleDecimals(1234567n, 6, 18, ROUNDING.FLOOR);
    assert.equal(scaleDecimals(up, 18, 6, ROUNDING.FLOOR), 1234567n);
    assert.equal(scaleDecimals(up + 1n, 18, 6, ROUNDING.FLOOR), 1234567n);
    assert.equal(scaleDecimals(up + 1n, 18, 6, ROUNDING.CEIL), 1234568n);
  });
});
