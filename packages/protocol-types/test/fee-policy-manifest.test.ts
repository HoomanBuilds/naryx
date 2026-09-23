import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  domainRef,
  feePolicyManifest,
  encodeFeePolicyManifest,
  feePolicyManifestBytes,
  feePolicyManifestHash,
  fromHex,
  toHex,
  type Direction,
  type ExpiryUnit,
  type FeeCategory,
  type FeePolicyManifest,
  type FeePolicyManifestInput,
  type PassThroughCostCategory,
  type QuantityPolicyClass,
  type RefundRule,
  type RoundingDirection,
  type ServiceFeeRateBase,
  type SettlementClass,
} from '../src/index.js';
import { loadFixture, type FeePolicyManifestFixture } from './fixtures.js';

const DOMAIN_HASH = '39'.repeat(32);
const ASSET_HASH = '7c'.repeat(32);

function scopedInput(
  overrides: Partial<FeePolicyManifestInput> = {},
): FeePolicyManifestInput {
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    environment: 'testnet',
    domain: domainRef('svm:test-domain-1', 1, fromHex(DOMAIN_HASH)),
    scopeDirection: 'LONG_SPOT_SHORT_PERP',
    scopeQuantityPolicyClass: 'EXACT_ATOMIC',
    scopeSettlementClass: 'ATOMIC_POSTCONDITION',
    scopeAccountModeClass: 'user-owned-v1',
    feePolicyVersion: 1,
    activationUnit: 'SOLANA_SLOT',
    activationValue: 1000n,
    serviceFeeRules: [
      {
        feeCategory: 'PROTOCOL',
        feeAssetId: 'svm:test-domain-1:usdc',
        feeAssetManifestHash: ASSET_HASH,
        feeAssetDecimals: 6,
        rateBase: 'MATCHED_PACKAGE_NOTIONAL',
        rateScale: 10_000n,
        rateValue: 5n,
        roundingDirection: 'FLOOR',
        hardMaximumReference: 'protocol-fee-hard-max-v1',
        recipientIdentity: 'protocol-treasury',
        collectionAuthority: 'solana-fee-controller',
      },
    ],
    passThroughCostRules: [
      {
        costCategory: 'NETWORK',
        costAssetId: 'svm:test-domain-1:usdc',
        costAssetManifestHash: ASSET_HASH,
        costAssetDecimals: 6,
        maxAtoms: 500_000n,
        roundingDirection: 'TOWARD_ZERO',
        refundRule: 'REFUND_UNUSED_PREPAID_TO_OWNER',
      },
    ],
    refundPolicyVersion: 1,
    expiryUnit: 'SOLANA_SLOT',
    expiryValue: 2000n,
    ...overrides,
  };
}

function unscopedZeroInput(
  overrides: Partial<FeePolicyManifestInput> = {},
): FeePolicyManifestInput {
  const scoped = scopedInput();
  return {
    schemaVersion: scoped.schemaVersion,
    manifestVersion: scoped.manifestVersion,
    environment: scoped.environment,
    domain: scoped.domain,
    scopeDirection: scoped.scopeDirection,
    feePolicyVersion: scoped.feePolicyVersion,
    activationUnit: scoped.activationUnit,
    activationValue: scoped.activationValue,
    serviceFeeRules: [],
    passThroughCostRules: [],
    refundPolicyVersion: scoped.refundPolicyVersion,
    ...overrides,
  };
}

function fixtureInput(fixture: FeePolicyManifestFixture): FeePolicyManifestInput {
  return {
    schemaVersion: Number(fixture.schemaVersion),
    manifestVersion: Number(fixture.manifestVersion),
    environment: fixture.environment,
    domain: domainRef(
      fixture.domain.domainId,
      Number(fixture.domain.domainManifestVersion),
      fromHex(fixture.domain.domainManifestHash),
    ),
    scopeDirection: fixture.scopeDirection as Direction,
    scopeQuantityPolicyClass:
      fixture.scopeQuantityPolicyClass as QuantityPolicyClass,
    scopeSettlementClass: fixture.scopeSettlementClass as SettlementClass,
    scopeAccountModeClass: fixture.scopeAccountModeClass,
    feePolicyVersion: Number(fixture.feePolicyVersion),
    activationUnit: fixture.activationUnit as ExpiryUnit,
    activationValue: BigInt(fixture.activationValue),
    serviceFeeRules: fixture.serviceFeeRules.map((rule) => ({
      feeCategory: rule.feeCategory as FeeCategory,
      feeAssetId: rule.feeAssetId,
      feeAssetManifestHash: rule.feeAssetManifestHash,
      feeAssetDecimals: rule.feeAssetDecimals,
      rateBase: rule.rateBase as ServiceFeeRateBase,
      rateScale: BigInt(rule.rateScale),
      ...(rule.rateValue === undefined ? {} : { rateValue: BigInt(rule.rateValue) }),
      ...(rule.fixedAtoms === undefined ? {} : { fixedAtoms: BigInt(rule.fixedAtoms) }),
      roundingDirection: rule.roundingDirection as RoundingDirection,
      hardMaximumReference: rule.hardMaximumReference,
      recipientIdentity: rule.recipientIdentity,
      collectionAuthority: rule.collectionAuthority,
    })),
    passThroughCostRules: fixture.passThroughCostRules.map((rule) => ({
      costCategory: rule.costCategory as PassThroughCostCategory,
      costAssetId: rule.costAssetId,
      costAssetManifestHash: rule.costAssetManifestHash,
      costAssetDecimals: rule.costAssetDecimals,
      maxAtoms: BigInt(rule.maxAtoms),
      roundingDirection: rule.roundingDirection as RoundingDirection,
      refundRule: rule.refundRule as RefundRule,
    })),
    refundPolicyVersion: Number(fixture.refundPolicyVersion),
    expiryUnit: fixture.expiryUnit as ExpiryUnit,
    expiryValue: BigInt(fixture.expiryValue),
  };
}

describe('fee policy manifest', () => {
  test('matches the committed canonical vector', () => {
    const fixture = loadFixture<FeePolicyManifestFixture>('fee-policy-manifest.json');
    const input = fixtureInput(fixture);
    const manifest = feePolicyManifest(input);

    assert.equal(manifest.serviceFeeRules.length, 1);
    assert.equal(manifest.passThroughCostRules.length, 1);
    assert.equal(toHex(feePolicyManifestBytes(input)), fixture.canonicalHex);
    assert.equal(toHex(feePolicyManifestHash(input)), fixture.digestHex);
  });

  test('enforces fixed and nonzero versions', () => {
    assert.throws(() => feePolicyManifest(scopedInput({ schemaVersion: 2 })), MalformedInputError);
    assert.throws(() => feePolicyManifest(scopedInput({ refundPolicyVersion: 2 })), MalformedInputError);
    assert.throws(() => feePolicyManifest(scopedInput({ manifestVersion: 0 })), MalformedInputError);
    assert.throws(() => feePolicyManifest(scopedInput({ feePolicyVersion: 0 })), MalformedInputError);
  });

  test('requires scope fields to be all present or all absent', () => {
    assert.throws(
      () => feePolicyManifest(unscopedZeroInput({ scopeQuantityPolicyClass: 'EXACT_ATOMIC' })),
      MalformedInputError,
    );
    assert.throws(
      () => feePolicyManifest(unscopedZeroInput({ scopeSettlementClass: 'ATOMIC_POSTCONDITION' })),
      MalformedInputError,
    );
    assert.throws(
      () => feePolicyManifest(unscopedZeroInput({ scopeAccountModeClass: 'user-owned-v1' })),
      MalformedInputError,
    );
    assert.doesNotThrow(() => feePolicyManifest(unscopedZeroInput()));
  });

  test('allows absent scope only when both rule arrays are empty', () => {
    assert.throws(
      () =>
        feePolicyManifest(
          unscopedZeroInput({ serviceFeeRules: scopedInput().serviceFeeRules }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        feePolicyManifest(
          unscopedZeroInput({ passThroughCostRules: scopedInput().passThroughCostRules }),
        ),
      MalformedInputError,
    );
  });

  test('requires a complete, same-unit, strictly increasing expiry', () => {
    assert.throws(
      () => feePolicyManifest({ ...scopedInput(), expiryValue: undefined } as unknown as FeePolicyManifestInput),
      MalformedInputError,
    );
    assert.throws(
      () => feePolicyManifest({ ...scopedInput(), expiryUnit: undefined } as unknown as FeePolicyManifestInput),
      MalformedInputError,
    );
    assert.throws(
      () => feePolicyManifest(scopedInput({ expiryUnit: 'EVM_UNIX_SECONDS' })),
      MalformedInputError,
    );
    assert.throws(
      () => feePolicyManifest(scopedInput({ expiryValue: 1000n })),
      MalformedInputError,
    );
    assert.throws(
      () => feePolicyManifest(scopedInput({ expiryValue: 999n })),
      MalformedInputError,
    );
  });

  test('rejects duplicate and descending rule arrays without sorting them', () => {
    const service = scopedInput().serviceFeeRules[0]!;
    assert.throws(
      () => feePolicyManifest(scopedInput({ serviceFeeRules: [service, service] })),
      DuplicateElementError,
    );
    const venue = { ...scopedInput().passThroughCostRules[0]!, costCategory: 'VENUE' as const };
    const recovery = { ...venue, costCategory: 'RECOVERY' as const };
    assert.throws(
      () => feePolicyManifest(scopedInput({ passThroughCostRules: [recovery, venue] })),
      MalformedInputError,
    );
  });

  test('defensively copies nested hashes and rejects forged runtime objects', () => {
    const manifest = feePolicyManifest(scopedInput());
    const exposedDomainHash = manifest.domain.domainManifestHash;
    const exposedAssetHash = manifest.serviceFeeRules[0]!.feeAssetManifestHash;
    exposedDomainHash.fill(0);
    exposedAssetHash.fill(0);
    assert.notEqual(manifest.domain.domainManifestHash[0], 0);
    assert.notEqual(manifest.serviceFeeRules[0]!.feeAssetManifestHash[0], 0);

    const forged = {
      ...manifest,
      domain: { ...manifest.domain, domainManifestHash: DOMAIN_HASH },
    } as unknown as FeePolicyManifest;
    assert.throws(
      () => encodeFeePolicyManifest(new CanonicalWriter(), forged),
      MalformedInputError,
    );
  });

  test('validates protocol identifiers in the scope', () => {
    assert.throws(
      () => feePolicyManifest(scopedInput({ scopeAccountModeClass: '' })),
      MalformedInputError,
    );
  });
});
