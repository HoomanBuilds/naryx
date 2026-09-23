import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  REGISTRY_CHANGE_CLASS,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  canonicalPackageTemplateRefs,
  canonicalRiskLimits,
  classifyRiskLimitChange,
  encodeRiskLimit,
  packageTemplateRef,
  riskLimit,
  riskLimitKeyBytes,
  toHex,
  type PackageTemplateRefInput,
  type RiskLimitInput,
  type RiskLimit,
} from '../src/index.js';

const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);
const U128_MAX = (1n << 128n) - 1n;

function limit(overrides: Partial<RiskLimitInput> = {}) {
  return riskLimit({
    limitKind: 'MAX_PACKAGE_NOTIONAL',
    assetId: 'usdc-solana-devnet',
    assetManifestHash: HASH_A,
    decimals: 6,
    maxAtoms: 1_000_000n,
    ...overrides,
  });
}

function outflow(maxAtoms: bigint, windowValue: bigint) {
  return limit({
    limitKind: 'OUTFLOW_RATE',
    maxAtoms,
    windowUnit: 'MILLISECONDS',
    windowValue,
  });
}

function template(overrides: Partial<PackageTemplateRefInput> = {}) {
  return packageTemplateRef({
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    packageTemplateManifestHash: HASH_A,
    ...overrides,
  });
}

describe('registry primitive validation', () => {
  test('risk limits require exact window shape and unsigned integer widths', () => {
    assert.throws(
      () => limit({ limitKind: 'OUTFLOW_RATE' }),
      MalformedInputError,
    );
    assert.throws(
      () => limit({ windowUnit: 'MILLISECONDS', windowValue: 1n }),
      MalformedInputError,
    );
    assert.throws(() => outflow(1n, 0n), MalformedInputError);
    assert.throws(() => limit({ maxAtoms: -1n }), RangeViolationError);
    assert.throws(() => limit({ maxAtoms: 1n << 128n }), RangeViolationError);
    assert.throws(
      () => limit({ decimals: 6n as unknown as number }),
      MalformedInputError,
    );
    assert.equal(limit({ maxAtoms: 0n }).maxAtoms, 0n);
  });

  test('the encoder rejects forged partial window state', () => {
    const base = limit();
    const forged = {
      ...base,
      windowValue: 1n,
    } as unknown as RiskLimit;
    assert.throws(
      () => encodeRiskLimit(new CanonicalWriter(), forged),
      MalformedInputError,
    );
  });

  test('ordered risk keys reject descending input and key duplicates', () => {
    const first = limit({ maxAtoms: 10n });
    const second = limit({
      limitKind: 'MAX_OPEN_NOTIONAL',
      maxAtoms: 20n,
    });
    assert.equal(canonicalRiskLimits([first, second]).length, 2);
    assert.throws(() => canonicalRiskLimits([second, first]), MalformedInputError);
    assert.throws(
      () => canonicalRiskLimits([first, limit({ maxAtoms: 999n })]),
      DuplicateElementError,
    );
    assert.notEqual(toHex(riskLimitKeyBytes(first)), toHex(riskLimitKeyBytes(second)));
  });

  test('template references bind version and hash and require canonical order', () => {
    const first = template();
    const second = template({ templateVersion: 2, packageTemplateManifestHash: HASH_B });
    assert.equal(canonicalPackageTemplateRefs([first, second]).length, 2);
    assert.throws(
      () => canonicalPackageTemplateRefs([second, first]),
      MalformedInputError,
    );
    assert.throws(
      () => canonicalPackageTemplateRefs([first, template()]),
      DuplicateElementError,
    );
    assert.throws(() => template({ templateVersion: 0 }), MalformedInputError);
  });
});

describe('risk limit change classification', () => {
  test('addition, removal, identity changes, and equal absence fail conservatively', () => {
    const current = limit();
    assert.equal(
      classifyRiskLimitChange(undefined, undefined),
      REGISTRY_CHANGE_CLASS.UNCHANGED,
    );
    assert.equal(
      classifyRiskLimitChange(undefined, current),
      REGISTRY_CHANGE_CLASS.RELAXATION,
    );
    assert.equal(
      classifyRiskLimitChange(current, undefined),
      REGISTRY_CHANGE_CLASS.TIGHTENING,
    );
    assert.equal(
      classifyRiskLimitChange(current, limit({ assetManifestHash: HASH_B })),
      REGISTRY_CHANGE_CLASS.RELAXATION,
    );
  });

  test('non-windowed capacity compares exact atoms', () => {
    const current = limit({ maxAtoms: 10n });
    assert.equal(
      classifyRiskLimitChange(current, limit({ maxAtoms: 9n })),
      REGISTRY_CHANGE_CLASS.TIGHTENING,
    );
    assert.equal(
      classifyRiskLimitChange(current, limit({ maxAtoms: 10n })),
      REGISTRY_CHANGE_CLASS.UNCHANGED,
    );
    assert.equal(
      classifyRiskLimitChange(current, limit({ maxAtoms: 11n })),
      REGISTRY_CHANGE_CLASS.RELAXATION,
    );
  });

  test('outflow throughput uses exact cross multiplication', () => {
    const current = outflow(10n, 10n);
    assert.equal(
      classifyRiskLimitChange(current, outflow(10n, 20n)),
      REGISTRY_CHANGE_CLASS.TIGHTENING,
    );
    assert.equal(
      classifyRiskLimitChange(current, outflow(10n, 5n)),
      REGISTRY_CHANGE_CLASS.RELAXATION,
    );
    assert.equal(
      classifyRiskLimitChange(current, outflow(5n, 5n)),
      REGISTRY_CHANGE_CLASS.UNCHANGED,
    );
    assert.equal(
      classifyRiskLimitChange(outflow(9_007_199_254_740_993n, 3n), outflow(18_014_398_509_481_986n, 6n)),
      REGISTRY_CHANGE_CLASS.UNCHANGED,
    );
  });

  test('u128 cross-product boundary is exact and overflow is a relaxation', () => {
    assert.equal(
      classifyRiskLimitChange(outflow(U128_MAX, 1n), outflow(U128_MAX, 1n)),
      REGISTRY_CHANGE_CLASS.UNCHANGED,
    );
    assert.equal(
      classifyRiskLimitChange(outflow(U128_MAX, 2n), outflow(U128_MAX - 1n, 2n)),
      REGISTRY_CHANGE_CLASS.RELAXATION,
    );
  });
});
