import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ADAPTER_ACCESS_MODE,
  ADAPTER_IDENTITY_SOURCE,
  ADAPTER_SIGNER_MODE,
  CanonicalWriter,
  DIRECTION,
  EXPIRY_UNIT,
  FEE_CATEGORY,
  MalformedInputError,
  PACKAGE_ACTION,
  PACKAGE_ORDER_TYPE,
  PACKAGE_TIME_IN_FORCE,
  PARTIAL_FILL_POLICY,
  PASS_THROUGH_COST_CATEGORY,
  QUANTITY_POLICY_CLASS,
  RECOVERY_ACTION,
  REGISTRY_RECORD_KIND,
  REGISTRY_STATE,
  RISK_LIMIT_KIND,
  SETTLEMENT_CLASS,
  enumDiscriminant,
  toHex,
} from '../src/index.js';

const TABLES = {
  ADAPTER_IDENTITY_SOURCE,
  ADAPTER_ACCESS_MODE,
  ADAPTER_SIGNER_MODE,
  EXPIRY_UNIT,
  DIRECTION,
  PACKAGE_ACTION,
  PACKAGE_ORDER_TYPE,
  PACKAGE_TIME_IN_FORCE,
  RECOVERY_ACTION,
  SETTLEMENT_CLASS,
  QUANTITY_POLICY_CLASS,
  PARTIAL_FILL_POLICY,
  REGISTRY_STATE,
  REGISTRY_RECORD_KIND,
  RISK_LIMIT_KIND,
  FEE_CATEGORY,
  PASS_THROUGH_COST_CATEGORY,
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
      SOLANA_SLOT: 1,
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
    assert.deepEqual(REGISTRY_STATE, {
      ACTIVE: 1,
      ENTRY_PAUSED: 2,
      EXIT_ONLY: 3,
      ALL_PAUSED: 4,
      DEPRECATED: 5,
    });
    assert.deepEqual(REGISTRY_RECORD_KIND, {
      ASSET: 1,
      VENUE: 2,
      MARKET: 3,
      ADAPTER: 4,
      PRICE_SOURCE: 5,
      PACKAGE_TEMPLATE: 6,
    });
    assert.deepEqual(RISK_LIMIT_KIND, {
      MAX_PACKAGE_NOTIONAL: 1,
      MAX_OPEN_NOTIONAL: 2,
      OUTFLOW_RATE: 3,
    });
    assert.deepEqual(FEE_CATEGORY, { PROTOCOL: 1, SOLVER: 2, BUILDER: 3 });
    assert.deepEqual(PASS_THROUGH_COST_CATEGORY, { VENUE: 1, NETWORK: 2, RECOVERY: 3 });
    assert.deepEqual(ADAPTER_IDENTITY_SOURCE, {
      EXACT: 1,
      DOMAIN_CONFIGURATION: 2,
      SIGNED_ORDER: 3,
      SIGNED_ROUTE: 4,
      CLASS_DERIVED: 5,
    });
    assert.deepEqual(ADAPTER_ACCESS_MODE, {
      OBSERVE: 1,
      MUTATE: 2,
      INVOKE: 3,
      ASSET_DEBIT: 4,
      ASSET_CREDIT: 5,
    });
    assert.deepEqual(ADAPTER_SIGNER_MODE, {
      NONE: 1,
      RUNTIME_SIGNATURE: 2,
      VERIFIED_AUTHORIZATION: 3,
      PROGRAM_DERIVED: 4,
    });
    assert.deepEqual(DIRECTION, { LONG_SPOT_SHORT_PERP: 1 });
    assert.deepEqual(PACKAGE_ACTION, { ENTRY: 1, EXIT: 2 });
    assert.deepEqual(PACKAGE_ORDER_TYPE, {
      LIMIT: 1,
      MARKETABLE_LIMIT: 2,
      POST_ONLY: 3,
      CONDITIONAL: 4,
      SCHEDULED: 5,
      PACKAGE_TWAP: 6,
    });
    assert.deepEqual(PACKAGE_TIME_IN_FORCE, {
      IOC: 1,
      FOK: 2,
      GTC: 3,
      GTD: 4,
    });
    assert.deepEqual(RECOVERY_ACTION, {
      CANCEL_OPEN_ORDERS: 1,
      COMPLETE_SPOT: 2,
      COMPLETE_PERP: 3,
      ROLLBACK_SPOT: 4,
      ROLLBACK_PERP: 5,
    });
    assert.deepEqual(PARTIAL_FILL_POLICY, { EXACT_ALL_LEGS: 1 });
  });

  test('no closed package-kind discriminant is exported', async () => {
    const exported = await import('../src/index.js');
    assert.equal('PACKAGE_KIND' in exported, false);
  });
});

describe('enum encoding', () => {
  test('writes a single discriminant byte', () => {
    assert.equal(
      toHex(new CanonicalWriter().writeEnum(REGISTRY_STATE, 'DEPRECATED').bytes()),
      '05',
    );
    assert.equal(
      toHex(new CanonicalWriter().writeEnum(SETTLEMENT_CLASS, 'BATCHED_IOC_WITH_RECOVERY').bytes()),
      '02',
    );
    assert.equal(
      toHex(new CanonicalWriter().writeEnum(REGISTRY_RECORD_KIND, 'PACKAGE_TEMPLATE').bytes()),
      '06',
    );
    assert.equal(
      toHex(new CanonicalWriter().writeEnum(RISK_LIMIT_KIND, 'OUTFLOW_RATE').bytes()),
      '03',
    );
    assert.equal(toHex(new CanonicalWriter().writeEnum(FEE_CATEGORY, 'BUILDER').bytes()), '03');
    assert.equal(
      toHex(new CanonicalWriter().writeEnum(PASS_THROUGH_COST_CATEGORY, 'RECOVERY').bytes()),
      '03',
    );
  });

  test('rejects an unknown variant', () => {
    assert.throws(
      () => enumDiscriminant(SETTLEMENT_CLASS, 'ATOMIC' as unknown as 'ATOMIC_POSTCONDITION'),
      MalformedInputError,
    );
    assert.throws(
      () => enumDiscriminant(REGISTRY_RECORD_KIND, 'ORACLE' as unknown as 'PRICE_SOURCE'),
      MalformedInputError,
    );
    assert.throws(
      () => enumDiscriminant(RISK_LIMIT_KIND, 'INFLOW_RATE' as unknown as 'OUTFLOW_RATE'),
      MalformedInputError,
    );
    assert.throws(
      () => enumDiscriminant(FEE_CATEGORY, 'VENUE' as unknown as 'PROTOCOL'),
      MalformedInputError,
    );
    assert.throws(
      () => enumDiscriminant(PASS_THROUGH_COST_CATEGORY, 'SOLVER' as unknown as 'VENUE'),
      MalformedInputError,
    );
  });

  test('rejects an inherited property name', () => {
    assert.throws(
      () => enumDiscriminant(REGISTRY_RECORD_KIND, 'toString' as unknown as 'ASSET'),
      MalformedInputError,
    );
    assert.throws(
      () => enumDiscriminant(FEE_CATEGORY, 'constructor' as unknown as 'PROTOCOL'),
      MalformedInputError,
    );
  });
});
