import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DIRECTION,
  EXPIRY_UNIT,
  MalformedInputError,
  PACKAGE_ACTION,
  PACKAGE_KIND,
  PARTIAL_FILL_POLICY,
  QUANTITY_POLICY_CLASS,
  SETTLEMENT_CLASS,
  TEMPLATE_REGISTRY_STATE,
  enumDiscriminant,
  toHex,
} from '../src/index.js';

const TABLES = {
  EXPIRY_UNIT,
  PACKAGE_KIND,
  DIRECTION,
  PACKAGE_ACTION,
  SETTLEMENT_CLASS,
  QUANTITY_POLICY_CLASS,
  PARTIAL_FILL_POLICY,
  TEMPLATE_REGISTRY_STATE,
};

describe('frozen enum discriminants', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    test(`${name} reserves zero and stays inside u8`, () => {
      const values = Object.values(table) as number[];
      for (const value of values) {
        assert.equal(Number.isInteger(value), true);
        assert.equal(value >= 1 && value <= 255, true);
      }
      assert.equal(new Set(values).size, values.length);
    });

    test(`${name} is frozen`, () => {
      assert.equal(Object.isFrozen(table), true);
    });
  }

  test('the v1 discriminants are unchanged', () => {
    assert.deepEqual(EXPIRY_UNIT, {
      SOLANA_LAST_VALID_BLOCK_HEIGHT: 1,
      EVM_UNIX_SECONDS: 2,
      HYPERLIQUID_UNIX_MILLISECONDS: 3,
    });
    assert.deepEqual(SETTLEMENT_CLASS, {
      ATOMIC_POSTCONDITION: 1,
      BATCHED_IOC_WITH_RECOVERY: 2,
    });
    assert.deepEqual(QUANTITY_POLICY_CLASS, {
      EXACT_ATOMIC: 1,
      EXACT_NET: 2,
      BOUNDED_NET: 3,
    });
    assert.deepEqual(TEMPLATE_REGISTRY_STATE, {
      ACTIVE: 1,
      ENTRY_PAUSED: 2,
      EXIT_ONLY: 3,
      ALL_PAUSED: 4,
      DEPRECATED: 5,
    });
    assert.deepEqual(PACKAGE_KIND, { CASH_AND_CARRY_V1: 1 });
    assert.deepEqual(DIRECTION, { LONG_SPOT_SHORT_PERP: 1 });
    assert.deepEqual(PACKAGE_ACTION, { ENTRY: 1, EXIT: 2 });
    assert.deepEqual(PARTIAL_FILL_POLICY, { EXACT_ALL_LEGS: 1 });
  });
});

describe('enum encoding', () => {
  test('writes a single discriminant byte', () => {
    assert.equal(
      toHex(new CanonicalWriter().writeEnum(TEMPLATE_REGISTRY_STATE, 'DEPRECATED').bytes()),
      '05',
    );
    assert.equal(
      toHex(new CanonicalWriter().writeEnum(SETTLEMENT_CLASS, 'BATCHED_IOC_WITH_RECOVERY').bytes()),
      '02',
    );
  });

  test('rejects an unknown variant', () => {
    assert.throws(
      () => enumDiscriminant(SETTLEMENT_CLASS, 'ATOMIC' as unknown as 'ATOMIC_POSTCONDITION'),
      MalformedInputError,
    );
    assert.throws(
      () =>
        new CanonicalWriter().writeEnum(
          PACKAGE_KIND,
          'CASH_AND_CARRY_V2' as unknown as 'CASH_AND_CARRY_V1',
        ),
      MalformedInputError,
    );
  });

  test('rejects an inherited property name', () => {
    assert.throws(
      () => enumDiscriminant(PACKAGE_KIND, 'toString' as unknown as 'CASH_AND_CARRY_V1'),
      MalformedInputError,
    );
  });
});
