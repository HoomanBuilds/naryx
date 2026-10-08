import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  RangeViolationError,
  addMultiPackageImpliedLiquidity,
  derivePackageImplicationProof,
  emptyPackageBook,
  packageMatchingPolicy,
  verifyPackageImplicationProof,
  type PackageImplicationProofInput,
  type PackageMatchingPolicyInput,
  type PackageSeriesExposureInput,
} from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');

const POLICY: PackageMatchingPolicyInput = {
  matchingPolicyVersion: 1,
  environment: 'local',
  executionClassId: 'sol-basis-package-v1',
  allocationRule: 'PRICE_TIME',
  directVersusImpliedPriority: 'DIRECT_FIRST',
  selfMatchPolicy: 'CANCEL_INCOMING',
  commonControlAsSelf: true,
  amendmentPriorityRule: 'RETAIN_ON_SIZE_REDUCTION',
  quantityIncrement: 10n,
  minimumExecutionQuantity: 10n,
  maximumImplicationDepth: 2,
};

function series(
  seriesId: string,
  manifest: number,
  components: PackageSeriesExposureInput['components'],
): PackageSeriesExposureInput {
  return {
    seriesId,
    seriesVersion: 1,
    seriesManifestHash: id(manifest),
    quoteAssetId: 'usdc',
    quoteConventionId: 'package-price-ticks-v1',
    quoteComposition: 'LINEAR',
    components,
  };
}

const TARGET = series('spot-december-basis', 10, [
  { instrumentId: 'sol-spot', ratio: { numerator: 1n, denominator: 1n } },
  { instrumentId: 'sol-december-perp', ratio: { numerator: -1n, denominator: 1n } },
]);

const NEAR_BASIS = series('spot-near-basis', 11, [
  { instrumentId: 'sol-spot', ratio: { numerator: 1n, denominator: 1n } },
  { instrumentId: 'sol-near-perp', ratio: { numerator: -1n, denominator: 1n } },
]);

const CALENDAR = series('near-december-calendar', 12, [
  { instrumentId: 'sol-near-perp', ratio: { numerator: 1n, denominator: 1n } },
  { instrumentId: 'sol-december-perp', ratio: { numerator: -1n, denominator: 1n } },
]);

function proofInput(): PackageImplicationProofInput {
  return {
    version: 1,
    targetExecutionClassId: POLICY.executionClassId,
    targetSide: 'ASK',
    targetSeries: TARGET,
    sources: [
      {
        entryId: id(21),
        sourceVersion: 4n,
        side: 'ASK',
        priceTicks: 80n,
        quantity: 30n,
        derivationDepth: 0,
        series: NEAR_BASIS,
        unitsPerTarget: { numerator: 1n, denominator: 1n },
        reservationId: id(31),
        ancestorEntryIds: [],
      },
      {
        entryId: id(22),
        sourceVersion: 7n,
        side: 'ASK',
        priceTicks: 20n,
        quantity: 20n,
        derivationDepth: 0,
        series: CALENDAR,
        unitsPerTarget: { numerator: 1n, denominator: 1n },
        reservationId: id(32),
        ancestorEntryIds: [],
      },
    ],
  };
}

describe('bounded multi-package implication', () => {
  test('conserves exposures and derives executable price, size, and depth', () => {
    const policy = packageMatchingPolicy(POLICY);
    const proof = derivePackageImplicationProof(policy, proofInput());
    assert.equal(proof.quote.priceTicks, 100n);
    assert.equal(proof.quote.quantity, 20n);
    assert.equal(proof.quote.derivationDepth, 1);
    assert.equal(proof.quote.sources.length, 2);
    assert.deepEqual(verifyPackageImplicationProof(policy, proof), proof);

    const admitted = addMultiPackageImpliedLiquidity(policy, emptyPackageBook(policy), {
      proof,
      participantId: 'solver-a',
      commonControlGroupId: 'solver-group',
      expiresAtValue: 2_000n,
      nowValue: 1_000n,
    });
    assert.equal(admitted.entry.priceTicks, 100n);
    assert.equal(admitted.entry.minimumFillQuantity, 20n);
  });

  test('rejects non-conserving exposure and mismatched source direction', () => {
    const policy = packageMatchingPolicy(POLICY);
    const input = proofInput();
    const [first, second] = input.sources;
    assert.throws(
      () => derivePackageImplicationProof(policy, {
        ...input,
        sources: [first!, { ...second!, unitsPerTarget: { numerator: 2n, denominator: 1n } }],
      }),
      MalformedInputError,
    );
    assert.throws(
      () => derivePackageImplicationProof(policy, {
        ...input,
        sources: [{ ...first!, side: 'BID' }, second!],
      }),
      /source side/,
    );
  });

  test('enforces depth, ancestry, and single-use source identity', () => {
    const shallow = packageMatchingPolicy({ ...POLICY, maximumImplicationDepth: 1 });
    const input = proofInput();
    const [first, second] = input.sources;
    const derived = {
      ...first!,
      derivationDepth: 1,
      ancestorEntryIds: [id(99)],
    };
    assert.throws(
      () => derivePackageImplicationProof(shallow, { ...input, sources: [derived, second!] }),
      RangeViolationError,
    );
    assert.throws(
      () => derivePackageImplicationProof(packageMatchingPolicy(POLICY), {
        ...input,
        sources: [first!, { ...second!, reservationId: first!.reservationId }],
      }),
      /source reservation repeats/,
    );
    assert.throws(
      () => derivePackageImplicationProof(packageMatchingPolicy(POLICY), {
        ...input,
        sources: [{ ...first!, ancestorEntryIds: [first!.entryId] }, second!],
      }),
      /contains itself/,
    );
  });

  test('verification rejects proof and quote tampering', () => {
    const policy = packageMatchingPolicy(POLICY);
    const proof = derivePackageImplicationProof(policy, proofInput());
    assert.throws(
      () => verifyPackageImplicationProof(policy, { ...proof, proofHash: id(88) as never }),
      /proof hash/,
    );
    assert.throws(
      () => verifyPackageImplicationProof(policy, {
        ...proof,
        quote: { ...proof.quote, priceTicks: proof.quote.priceTicks + 1n },
      }),
      /entry id does not bind|quote does not match/,
    );
  });
});
