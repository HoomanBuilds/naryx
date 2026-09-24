import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  RangeViolationError,
  domainRef,
  firmReservationId,
  firmReservationIdentityBytes,
  toHex,
  type FirmReservationIdentityInput,
} from '../src/index.js';

function identity(
  overrides: Partial<FirmReservationIdentityInput> = {},
): FirmReservationIdentityInput {
  return {
    domain: domainRef('eip155:8453', 7, '11'.repeat(32)),
    solverId: 'solver-alpha',
    orderHash: '22'.repeat(32),
    reservationNonce: 42n,
    ...overrides,
  };
}

describe('firm reservation identity', () => {
  test('matches the canonical cross-runtime vector and rejects invalid identity fields', () => {
    assert.equal(
      toHex(firmReservationIdentityBytes(identity())),
      '0000000b6569703135353a3834353300000007' +
        '1111111111111111111111111111111111111111111111111111111111111111' +
        '0000000c736f6c7665722d616c706861' +
        '2222222222222222222222222222222222222222222222222222222222222222' +
        '000000000000000000000000000000000000000000000000000000000000002a',
    );
    assert.equal(
      toHex(firmReservationId(identity())),
      '8241728852cb440e70ea75801894dd275ad2061076ceeec96bb4e66b788d99d1',
    );
    assert.throws(
      () => firmReservationId(identity({ reservationNonce: 0n })),
      MalformedInputError,
    );
    assert.throws(
      () => firmReservationId(identity({ reservationNonce: 1n << 256n })),
      RangeViolationError,
    );
    assert.throws(
      () => firmReservationId(identity({ orderHash: '00'.repeat(32) })),
      MalformedInputError,
    );
  });
});
