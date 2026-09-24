import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  economicStrategySeries,
  economicStrategySeriesBytes,
  economicStrategySeriesHash,
  encodeEconomicStrategySeries,
  fromHex,
  seriesExecutionClass,
  seriesExecutionClassBytes,
  seriesExecutionClassHash,
  toHex,
  type DomainRef,
  type DurationUnit,
  type EconomicStrategySeriesInput,
  type EconomicStrategySeriesSupportInput,
  type SeriesExecutionClassInput,
  type SeriesExecutionClassSupportInput,
  type SettlementClass,
} from '../src/index.js';
import {
  loadFixture,
  type EconomicStrategySeriesFixture,
  type SeriesExecutionClassFixture,
} from './fixtures.js';

const seriesFixture = loadFixture<EconomicStrategySeriesFixture>(
  'economic-strategy-series.json',
);
const executionFixture = loadFixture<SeriesExecutionClassFixture>(
  'series-execution-class.json',
);

const seriesSupport: EconomicStrategySeriesSupportInput = {
  supportedTemplateIds: ['cash-and-carry-v1'],
  supportedQuoteConventionIds: ['annualized-net-yield-v1'],
  supportedRiskClassIds: ['delta-neutral-basis-v1'],
  supportedLifecycleConventionIds: ['rolling-evaluation-window-v1'],
};

const executionSupport: SeriesExecutionClassSupportInput = {
  supportedVenueClassIds: ['svm-spot-amm-v1', 'svm-perp-clob-v1'],
  supportedCollateralModeIds: ['isolated-prefunded-v1'],
  supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
  supportedFirmnessClassIds: ['firm-inventory-reservation-v1'],
};

function seriesInput(
  overrides: Partial<EconomicStrategySeriesInput> = {},
): EconomicStrategySeriesInput {
  return {
    seriesVersion: Number(seriesFixture.seriesVersion),
    seriesId: seriesFixture.seriesId,
    templateId: seriesFixture.templateId,
    templateVersion: Number(seriesFixture.templateVersion),
    templateManifestHash: seriesFixture.templateManifestHash,
    underlyingRefs: seriesFixture.underlyingRefs,
    quoteAsset: seriesFixture.quoteAsset,
    economicLegRatios: seriesFixture.economicLegRatios.map((ratio) => ({
      numerator: BigInt(ratio.numerator),
      denominator: BigInt(ratio.denominator),
    })),
    maturityOrEvaluationWindow: {
      unit: seriesFixture.maturityOrEvaluationWindow.unit as DurationUnit,
      value: BigInt(seriesFixture.maturityOrEvaluationWindow.value),
    },
    quoteConvention: seriesFixture.quoteConvention,
    riskClass: seriesFixture.riskClass,
    lifecycleConvention: seriesFixture.lifecycleConvention,
    ...overrides,
  };
}

function domain(value: SeriesExecutionClassFixture['domains'][number]): DomainRef {
  return {
    domainId: value.domainId,
    domainManifestVersion: Number(value.domainManifestVersion),
    domainManifestHash: fromHex(value.domainManifestHash),
  } as unknown as DomainRef;
}

function executionInput(
  overrides: Partial<SeriesExecutionClassInput> = {},
): SeriesExecutionClassInput {
  return {
    executionClassVersion: Number(executionFixture.executionClassVersion),
    executionClassId: executionFixture.executionClassId,
    seriesId: executionFixture.seriesId,
    seriesVersion: Number(executionFixture.seriesVersion),
    seriesManifestHash: executionFixture.seriesManifestHash,
    domains: executionFixture.domains.map(domain),
    venueClasses: executionFixture.venueClasses,
    collateralMode: executionFixture.collateralMode,
    settlementClass: executionFixture.settlementClass as SettlementClass,
    firmnessClass: executionFixture.firmnessClass,
    deliveryPolicyHash: executionFixture.deliveryPolicyHash,
    recoveryPolicyHash: executionFixture.recoveryPolicyHash,
    matchingPolicyHash: executionFixture.matchingPolicyHash,
    ...overrides,
  };
}

describe('economic strategy series', () => {
  test('canonical bytes and domain-separated hash match the golden vector', () => {
    const series = economicStrategySeries(seriesInput(), seriesSupport);

    assert.deepEqual(series.underlyingRefs, ['sol', 'sol']);
    assert.deepEqual(
      series.economicLegRatios.map((ratio) => [ratio.numerator, ratio.denominator]),
      [
        [1n, 1n],
        [-1n, 1n],
      ],
    );
    assert.equal(
      toHex(economicStrategySeriesBytes(seriesInput(), seriesSupport)),
      seriesFixture.canonicalHex,
    );
    assert.equal(
      toHex(economicStrategySeriesHash(seriesInput(), seriesSupport)),
      seriesFixture.digestHex,
    );
  });

  test('unknown semantics and noncanonical ratios fail closed', () => {
    assert.throws(
      () =>
        economicStrategySeries(
          seriesInput({ quoteConvention: 'unknown-quote-v1' }),
          seriesSupport,
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        economicStrategySeries(
          seriesInput({ economicLegRatios: [{ numerator: 2n, denominator: 2n }] }),
          seriesSupport,
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        economicStrategySeries(
          seriesInput({ underlyingRefs: ['sol'] }),
          seriesSupport,
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        economicStrategySeries(
          seriesInput({ underlyingRefs: Array.from({ length: 17 }, () => 'sol') }),
          seriesSupport,
        ),
      RangeViolationError,
    );
  });

  test('captured hashes remain immutable and forged encoder hashes are rejected', () => {
    const templateHash = fromHex(seriesFixture.templateManifestHash);
    const series = economicStrategySeries(
      seriesInput({ templateManifestHash: templateHash }),
      seriesSupport,
    );
    const before = toHex(
      economicStrategySeriesBytes(
        { ...seriesInput(), templateManifestHash: series.templateManifestHash },
        seriesSupport,
      ),
    );
    templateHash[0] = 0xff;
    series.templateManifestHash[0] = 0xff;
    assert.equal(
      toHex(
        economicStrategySeriesBytes(
          { ...seriesInput(), templateManifestHash: series.templateManifestHash },
          seriesSupport,
        ),
      ),
      before,
    );

    const writer = new CanonicalWriter();
    const forged = {
      ...series,
      templateManifestHash: seriesFixture.templateManifestHash,
    };
    assert.throws(
      () => encodeEconomicStrategySeries(writer, forged as never, seriesSupport),
      MalformedInputError,
    );
    assert.equal(writer.bytes().length, 0);
  });
});

describe('series execution class', () => {
  test('canonical sets, bytes, and domain-separated hash match the golden vector', () => {
    const executionClass = seriesExecutionClass(executionInput(), executionSupport);

    assert.deepEqual(executionClass.venueClasses, [
      'svm-spot-amm-v1',
      'svm-perp-clob-v1',
    ]);
    assert.equal(
      toHex(seriesExecutionClassBytes(executionInput(), executionSupport)),
      executionFixture.canonicalHex,
    );
    assert.equal(
      toHex(seriesExecutionClassHash(executionInput(), executionSupport)),
      executionFixture.digestHex,
    );
    assert.equal(
      toHex(
        seriesExecutionClassBytes(
          executionInput({ venueClasses: [...executionFixture.venueClasses].reverse() }),
          executionSupport,
        ),
      ),
      executionFixture.canonicalHex,
    );
  });

  test('duplicate sets and unsupported execution semantics fail closed', () => {
    const firstDomain = executionInput().domains[0] as DomainRef;
    assert.throws(
      () =>
        seriesExecutionClass(
          executionInput({ venueClasses: ['svm-spot-amm-v1', 'svm-spot-amm-v1'] }),
          executionSupport,
        ),
      DuplicateElementError,
    );
    assert.throws(
      () =>
        seriesExecutionClass(
          executionInput({ domains: [firstDomain, firstDomain] }),
          executionSupport,
        ),
      DuplicateElementError,
    );
    assert.throws(
      () =>
        seriesExecutionClass(
          executionInput({ collateralMode: 'unknown-collateral-v1' }),
          executionSupport,
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        seriesExecutionClass(
          executionInput({ settlementClass: 'BATCHED_IOC_WITH_RECOVERY' }),
          executionSupport,
        ),
      MalformedInputError,
    );
  });
});
