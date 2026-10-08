import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  RangeViolationError,
  assetRef,
  bytesEqual,
  domainRef,
  riskDomainManifest,
  riskDomainManifestBytes,
  riskDomainManifestHash,
  versionedManifestRef,
  type RiskDomainManifestInput,
} from '../src/index.js';

const SOLANA = domainRef('solana-devnet', 1, '11'.repeat(32));
const BASE = domainRef('base-sepolia', 1, '22'.repeat(32));
const USDC = assetRef('usdc', '33'.repeat(32), 6);
const CARRY = versionedManifestRef('sol-carry', 2, '44'.repeat(32));
const FUNDING = versionedManifestRef('sol-funding-spread', 1, '55'.repeat(32));

function input(overrides: Partial<RiskDomainManifestInput> = {}): RiskDomainManifestInput {
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    environment: 'testnet',
    riskDomainId: 'sol-relative-value',
    accountingAsset: USDC,
    eligibleDomains: [SOLANA, BASE],
    eligibleSeries: [CARRY, FUNDING],
    settlementClasses: ['ATOMIC_POSTCONDITION', 'BATCHED_IOC_WITH_RECOVERY'],
    grossCapQuoteAtoms: 10_000_000_000n,
    netCapQuoteAtoms: 2_000_000_000n,
    minimumMarginFloorQuoteAtoms: 500_000_000n,
    maximumLeverageBps: 50_000n,
    maximumStalenessMs: 5_000n,
    maximumTimeToUnwindMs: 60_000n,
    requiredRecoveryReserveQuoteAtoms: 100_000_000n,
    haircutsBps: {
      basis: 500n,
      liquidity: 750n,
      latency: 250n,
      oracle: 250n,
      venue: 500n,
      bridge: 250n,
      issuer: 0n,
      recovery: 500n,
    },
    dependencyLimits: [
      { dependencyId: 'venue:phoenix', maximumGrossQuoteAtoms: 4_000_000_000n },
      { dependencyId: 'venue:hypercore', maximumGrossQuoteAtoms: 5_000_000_000n },
    ],
    ...overrides,
  };
}

describe('risk domain manifest', () => {
  test('canonicalizes sets and binds every clearing limit', () => {
    const first = input();
    const reordered = input({
      eligibleDomains: [...first.eligibleDomains].reverse(),
      eligibleSeries: [...first.eligibleSeries].reverse(),
      settlementClasses: [...first.settlementClasses].reverse(),
      dependencyLimits: [...first.dependencyLimits].reverse(),
    });
    assert.ok(bytesEqual(riskDomainManifestBytes(first), riskDomainManifestBytes(reordered)));
    assert.ok(bytesEqual(riskDomainManifestHash(first), riskDomainManifestHash(reordered)));
    assert.equal(riskDomainManifest(first).dependencyLimits[0]?.dependencyId, 'venue:phoenix');
    assert.equal(bytesEqual(riskDomainManifestHash(first), riskDomainManifestHash(input({ netCapQuoteAtoms: 1_999_999_999n }))), false);
  });

  test('fails closed on ambiguous membership and unsafe limits', () => {
    assert.throws(() => riskDomainManifest(input({ eligibleDomains: [SOLANA, SOLANA] })), /duplicate element/);
    assert.throws(() => riskDomainManifest(input({ eligibleSeries: [] })), MalformedInputError);
    assert.throws(() => riskDomainManifest(input({ netCapQuoteAtoms: 10_000_000_001n })), /net cap exceeds gross cap/);
    assert.throws(() => riskDomainManifest(input({ maximumLeverageBps: 1_000_001n })), RangeViolationError);
    assert.throws(() => riskDomainManifest(input({ haircutsBps: { ...input().haircutsBps, basis: 8_000n } })), /haircuts exceed/);
    assert.throws(() => riskDomainManifest(input({ dependencyLimits: [{ dependencyId: 'venue:phoenix', maximumGrossQuoteAtoms: 10_000_000_001n }] })), /dependency cap exceeds/);
  });
});
