import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  REFUND_RULE,
  ROUNDING_DIRECTION,
  SERVICE_FEE_RATE_BASE,
  canonicalPassThroughCostRules,
  canonicalServiceFeeRules,
  encodePassThroughCostRule,
  encodeServiceFeeRule,
  passThroughCostRule,
  serviceFeeRule,
  type PassThroughCostRule,
  type PassThroughCostRuleInput,
  type ServiceFeeRule,
  type ServiceFeeRuleInput,
} from '../src/index.js';

const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

function rateRule(overrides: Partial<ServiceFeeRuleInput> = {}) {
  return serviceFeeRule({
    feeCategory: 'PROTOCOL',
    feeAssetId: 'usdc-solana-devnet',
    feeAssetManifestHash: HASH_A,
    feeAssetDecimals: 6,
    rateBase: 'MATCHED_PACKAGE_NOTIONAL',
    rateScale: 10_000n,
    rateValue: 5n,
    roundingDirection: 'FLOOR',
    hardMaximumReference: 'protocol-fee-hard-max-v1',
    recipientIdentity: 'protocol-treasury',
    collectionAuthority: 'solana-fee-controller',
    ...overrides,
  });
}

function fixedRule(fixedAtoms = 100n) {
  return serviceFeeRule({
    feeCategory: 'SOLVER',
    feeAssetId: 'usdc-solana-devnet',
    feeAssetManifestHash: HASH_A,
    feeAssetDecimals: 6,
    rateBase: 'MATCHED_PACKAGE_NOTIONAL',
    rateScale: 1n,
    fixedAtoms,
    roundingDirection: 'TOWARD_ZERO',
    hardMaximumReference: 'solver-fee-hard-max-v1',
    recipientIdentity: 'solver-recipient',
    collectionAuthority: 'solana-fee-controller',
  });
}

function passThrough(overrides: Partial<PassThroughCostRuleInput> = {}) {
  return passThroughCostRule({
    costCategory: 'VENUE',
    costAssetId: 'usdc-solana-devnet',
    costAssetManifestHash: HASH_A,
    costAssetDecimals: 6,
    maxAtoms: 1_000n,
    roundingDirection: 'TOWARD_ZERO',
    refundRule: 'REFUND_UNUSED_PREPAID_TO_OWNER',
    ...overrides,
  });
}

describe('fee policy enums', () => {
  test('use the fixed version 1 discriminants', () => {
    assert.deepEqual(SERVICE_FEE_RATE_BASE, { MATCHED_PACKAGE_NOTIONAL: 1 });
    assert.deepEqual(ROUNDING_DIRECTION, {
      FLOOR: 1,
      CEIL: 2,
      TOWARD_ZERO: 3,
      AWAY_FROM_ZERO: 4,
    });
    assert.deepEqual(REFUND_RULE, { REFUND_UNUSED_PREPAID_TO_OWNER: 1 });
  });
});

describe('service fee rule validation', () => {
  test('requires exactly one signed service value', () => {
    assert.throws(
      () =>
        serviceFeeRule({
          feeCategory: 'PROTOCOL',
          feeAssetId: 'usdc-solana-devnet',
          feeAssetManifestHash: HASH_A,
          feeAssetDecimals: 6,
          rateBase: 'MATCHED_PACKAGE_NOTIONAL',
          rateScale: 10_000n,
          roundingDirection: 'FLOOR',
          hardMaximumReference: 'protocol-fee-hard-max-v1',
          recipientIdentity: 'protocol-treasury',
          collectionAuthority: 'solana-fee-controller',
        }),
      MalformedInputError,
    );
    assert.throws(() => rateRule({ fixedAtoms: 1n }), MalformedInputError);
  });

  test('accepts signed i128 boundaries and rejects values beyond them', () => {
    assert.equal(rateRule({ rateValue: I128_MIN }).rateValue, I128_MIN);
    assert.equal(rateRule({ rateValue: I128_MAX }).rateValue, I128_MAX);
    assert.equal(fixedRule(I128_MIN).fixedAtoms, I128_MIN);
    assert.equal(fixedRule(I128_MAX).fixedAtoms, I128_MAX);
    assert.throws(() => rateRule({ rateValue: I128_MIN - 1n }), RangeViolationError);
    assert.throws(() => rateRule({ rateValue: I128_MAX + 1n }), RangeViolationError);
    assert.throws(() => fixedRule(I128_MAX + 1n), RangeViolationError);
  });

  test('requires a positive rate scale and fixed-rule sentinels', () => {
    assert.throws(() => rateRule({ rateScale: 0n }), MalformedInputError);
    assert.throws(() => rateRule({ rateScale: 1n << 128n }), RangeViolationError);
    assert.throws(
      () => serviceFeeRule({ ...fixedRule(), rateScale: 2n }),
      MalformedInputError,
    );
    assert.throws(
      () => serviceFeeRule({ ...fixedRule(), roundingDirection: 'CEIL' }),
      MalformedInputError,
    );
  });

  test('defensively copies its asset hash', () => {
    const rule = rateRule();
    const exposed = rule.feeAssetManifestHash;
    exposed.fill(0);
    assert.equal(rule.feeAssetManifestHash[0], 0x11);
  });
});

describe('pass-through cost rule validation', () => {
  test('requires unsigned u128 caps and the version 1 sentinels', () => {
    assert.equal(passThrough({ maxAtoms: 0n }).maxAtoms, 0n);
    assert.equal(passThrough({ maxAtoms: U128_MAX }).maxAtoms, U128_MAX);
    assert.throws(() => passThrough({ maxAtoms: -1n }), RangeViolationError);
    assert.throws(() => passThrough({ maxAtoms: 1n << 128n }), RangeViolationError);
    assert.throws(
      () => passThrough({ roundingDirection: 'AWAY_FROM_ZERO' }),
      MalformedInputError,
    );
    assert.throws(
      () =>
        passThrough({
          refundRule: 'KEEP_PREPAID' as unknown as 'REFUND_UNUSED_PREPAID_TO_OWNER',
        }),
      MalformedInputError,
    );
  });
});

describe('fee rule canonical lists', () => {
  test('service rules reject descending keys and duplicates by category and asset only', () => {
    const first = rateRule();
    const second = fixedRule();
    assert.equal(canonicalServiceFeeRules([first, second]).length, 2);
    assert.throws(
      () => canonicalServiceFeeRules([second, first]),
      MalformedInputError,
    );
    assert.throws(
      () =>
        canonicalServiceFeeRules([
          first,
          rateRule({ feeAssetManifestHash: HASH_B, rateValue: 50n }),
        ]),
      DuplicateElementError,
    );
  });

  test('pass-through rules reject descending keys and duplicates by category and asset only', () => {
    const first = passThrough();
    const second = passThrough({ costCategory: 'NETWORK' });
    assert.equal(canonicalPassThroughCostRules([first, second]).length, 2);
    assert.throws(
      () => canonicalPassThroughCostRules([second, first]),
      MalformedInputError,
    );
    assert.throws(
      () =>
        canonicalPassThroughCostRules([
          first,
          passThrough({ costAssetManifestHash: HASH_B, maxAtoms: 999n }),
        ]),
      DuplicateElementError,
    );
  });

  test('encoders and list validators reject forged noncanonical hashes', () => {
    const forgedService = {
      ...rateRule(),
      feeAssetManifestHash: HASH_A,
    } as unknown as ServiceFeeRule;
    const forgedPassThrough = {
      ...passThrough(),
      costAssetManifestHash: HASH_A,
    } as unknown as PassThroughCostRule;

    assert.throws(
      () => encodeServiceFeeRule(new CanonicalWriter(), forgedService),
      MalformedInputError,
    );
    assert.throws(
      () => canonicalServiceFeeRules([forgedService]),
      MalformedInputError,
    );
    assert.throws(
      () => encodePassThroughCostRule(new CanonicalWriter(), forgedPassThrough),
      MalformedInputError,
    );
    assert.throws(
      () => canonicalPassThroughCostRules([forgedPassThrough]),
      MalformedInputError,
    );
  });
});
