import { absBigInt, checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  SETTLEMENT_CLASS,
  type SettlementClass,
} from './enums.js';
import { DuplicateElementError, MalformedInputError, RangeViolationError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  domainRef,
  duration,
  encodeDomainRef,
  encodeDuration,
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type DomainRef,
  type Duration,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const VERSION_BITS = 32;
const RATIO_BITS = 128;

export const ECONOMIC_STRATEGY_SERIES_MAX_LEGS = 16;
export const SERIES_EXECUTION_CLASS_MAX_DOMAINS = 16;
export const SERIES_EXECUTION_CLASS_MAX_VENUE_CLASSES = 32;
export const STRATEGY_SERIES_MAX_SUPPORTED_SEMANTICS = 64;

export interface ExactSignedRatioInput {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface ExactSignedRatio {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface EconomicStrategySeriesSupportInput {
  readonly supportedTemplateIds: readonly string[];
  readonly supportedQuoteConventionIds: readonly string[];
  readonly supportedRiskClassIds: readonly string[];
  readonly supportedLifecycleConventionIds: readonly string[];
}

export interface EconomicStrategySeriesInput {
  readonly seriesVersion: number;
  readonly seriesId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateManifestHash: Uint8Array | string;
  readonly underlyingRefs: readonly string[];
  readonly quoteAsset: string;
  readonly economicLegRatios: readonly ExactSignedRatioInput[];
  readonly instrumentRefs?: readonly string[];
  readonly maturityOrEvaluationWindow: Duration;
  readonly quoteConvention: string;
  readonly riskClass: string;
  readonly lifecycleConvention: string;
}

export interface EconomicStrategySeries {
  readonly seriesVersion: number;
  readonly seriesId: ProtocolId;
  readonly templateId: ProtocolId;
  readonly templateVersion: number;
  readonly templateManifestHash: ManifestHash;
  readonly underlyingRefs: readonly ProtocolId[];
  readonly quoteAsset: ProtocolId;
  readonly economicLegRatios: readonly ExactSignedRatio[];
  readonly instrumentRefs?: readonly ProtocolId[];
  readonly maturityOrEvaluationWindow: Duration;
  readonly quoteConvention: ProtocolId;
  readonly riskClass: ProtocolId;
  readonly lifecycleConvention: ProtocolId;
}

export interface SeriesExecutionClassSupportInput {
  readonly supportedVenueClassIds: readonly string[];
  readonly supportedCollateralModeIds: readonly string[];
  readonly supportedSettlementClasses: readonly SettlementClass[];
  readonly supportedFirmnessClassIds: readonly string[];
}

export interface SeriesExecutionClassInput {
  readonly executionClassVersion: number;
  readonly executionClassId: string;
  readonly seriesId: string;
  readonly seriesVersion: number;
  readonly seriesManifestHash: Uint8Array | string;
  readonly domains: readonly DomainRef[];
  readonly venueClasses: readonly string[];
  readonly collateralMode: string;
  readonly settlementClass: SettlementClass;
  readonly firmnessClass: string;
  readonly deliveryPolicyHash: Uint8Array | string;
  readonly recoveryPolicyHash: Uint8Array | string;
  readonly matchingPolicyHash: Uint8Array | string;
}

export interface SeriesExecutionClass {
  readonly executionClassVersion: number;
  readonly executionClassId: ProtocolId;
  readonly seriesId: ProtocolId;
  readonly seriesVersion: number;
  readonly seriesManifestHash: ManifestHash;
  readonly domains: readonly DomainRef[];
  readonly venueClasses: readonly ProtocolId[];
  readonly collateralMode: ProtocolId;
  readonly settlementClass: SettlementClass;
  readonly firmnessClass: ProtocolId;
  readonly deliveryPolicyHash: ManifestHash;
  readonly recoveryPolicyHash: ManifestHash;
  readonly matchingPolicyHash: ManifestHash;
}

interface CanonicalEntry<T> {
  readonly value: T;
  readonly bytes: Uint8Array;
}

function nonzeroU32(value: number, context: string): number {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  const checked = checkedUnsigned(value, VERSION_BITS, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'version is zero');
  }
  return Number(checked);
}

function boundedNonemptyArray<T>(
  value: readonly T[],
  maximum: number,
  context: string,
): readonly T[] {
  if (!Array.isArray(value)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  if (value.length === 0) {
    throw new MalformedInputError(context, 'array is empty');
  }
  if (value.length > maximum) {
    throw new RangeViolationError(context, `count ${value.length} exceeds ${maximum}`);
  }
  return value;
}

function rejectDuplicateEntries<T>(
  entries: readonly CanonicalEntry<T>[],
  context: string,
): void {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1] as CanonicalEntry<T>;
    const current = entries[index] as CanonicalEntry<T>;
    if (compareBytes(previous.bytes, current.bytes) === 0) {
      throw new DuplicateElementError(context, `duplicate canonical element at sorted index ${index}`);
    }
  }
}

function canonicalProtocolIdSet(
  values: readonly string[],
  maximum: number,
  context: string,
): readonly ProtocolId[] {
  const entries = boundedNonemptyArray(values, maximum, context)
    .map((value, index) => {
      const checked = protocolId(value, `${context}[${index}]`);
      return {
        value: checked,
        bytes: canonicalBytes((writer) => encodeProtocolId(writer, checked, context)),
      };
    })
    .sort((left, right) => compareBytes(left.bytes, right.bytes));
  rejectDuplicateEntries(entries, context);
  return Object.freeze(entries.map((entry) => entry.value));
}

function canonicalSettlementClassSet(
  values: readonly SettlementClass[],
  context: string,
): readonly SettlementClass[] {
  const entries = boundedNonemptyArray(
    values,
    Object.keys(SETTLEMENT_CLASS).length,
    context,
  )
    .map((value, index) => {
      enumDiscriminant(SETTLEMENT_CLASS, value, `${context}[${index}]`);
      return {
        value,
        bytes: canonicalBytes((writer) => writer.writeEnum(SETTLEMENT_CLASS, value, context)),
      };
    })
    .sort((left, right) => compareBytes(left.bytes, right.bytes));
  rejectDuplicateEntries(entries, context);
  return Object.freeze(entries.map((entry) => entry.value));
}

function checkedSemanticId(
  value: string,
  supported: readonly ProtocolId[],
  context: string,
): ProtocolId {
  const checked = protocolId(value, context);
  if (!supported.includes(checked)) {
    throw new MalformedInputError(context, `unsupported semantic identifier ${checked}`);
  }
  return checked;
}

function checkedDuration(value: Duration, context: string): Duration {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a duration object');
  }
  return duration(value.unit, value.value, context);
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let first = left;
  let second = right;
  while (second !== 0n) {
    const remainder = first % second;
    first = second;
    second = remainder;
  }
  return first;
}

export function exactSignedRatio(
  input: ExactSignedRatioInput,
  context = 'exactSignedRatio',
): ExactSignedRatio {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an exact signed ratio object');
  }
  if (typeof input.numerator !== 'bigint' || typeof input.denominator !== 'bigint') {
    throw new MalformedInputError(context, 'expected bigint ratio components');
  }
  const numerator = checkedSigned(input.numerator, RATIO_BITS, `${context}.numerator`);
  const denominator = checkedUnsigned(
    input.denominator,
    RATIO_BITS,
    `${context}.denominator`,
  );
  if (numerator === 0n) {
    throw new MalformedInputError(`${context}.numerator`, 'ratio numerator is zero');
  }
  if (denominator === 0n) {
    throw new MalformedInputError(`${context}.denominator`, 'ratio denominator is zero');
  }
  if (greatestCommonDivisor(absBigInt(numerator), denominator) !== 1n) {
    throw new MalformedInputError(context, 'ratio is not in lowest terms');
  }
  return Object.freeze({ numerator, denominator });
}

export function encodeExactSignedRatio(
  writer: CanonicalWriter,
  value: ExactSignedRatio,
): void {
  const checked = exactSignedRatio(value);
  writer.writeI128(checked.numerator, 'exactSignedRatio.numerator');
  writer.writeU128(checked.denominator, 'exactSignedRatio.denominator');
}

function economicSupport(input: EconomicStrategySeriesSupportInput, context: string) {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an economic semantics support object');
  }
  return {
    templates: canonicalProtocolIdSet(
      input.supportedTemplateIds,
      STRATEGY_SERIES_MAX_SUPPORTED_SEMANTICS,
      `${context}.supportedTemplateIds`,
    ),
    quoteConventions: canonicalProtocolIdSet(
      input.supportedQuoteConventionIds,
      STRATEGY_SERIES_MAX_SUPPORTED_SEMANTICS,
      `${context}.supportedQuoteConventionIds`,
    ),
    riskClasses: canonicalProtocolIdSet(
      input.supportedRiskClassIds,
      STRATEGY_SERIES_MAX_SUPPORTED_SEMANTICS,
      `${context}.supportedRiskClassIds`,
    ),
    lifecycleConventions: canonicalProtocolIdSet(
      input.supportedLifecycleConventionIds,
      STRATEGY_SERIES_MAX_SUPPORTED_SEMANTICS,
      `${context}.supportedLifecycleConventionIds`,
    ),
  };
}

function copiedManifestHash(value: ManifestHash): ManifestHash {
  return Uint8Array.from(value) as ManifestHash;
}

export function economicStrategySeries(
  input: EconomicStrategySeriesInput,
  supportInput: EconomicStrategySeriesSupportInput,
  context = 'economicStrategySeries',
): EconomicStrategySeries {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an economic strategy series object');
  }
  const support = economicSupport(supportInput, `${context}.support`);
  const underlyingRefs = boundedNonemptyArray(
    input.underlyingRefs,
    ECONOMIC_STRATEGY_SERIES_MAX_LEGS,
    `${context}.underlyingRefs`,
  ).map((value, index) => protocolId(value, `${context}.underlyingRefs[${index}]`));
  const ratios = boundedNonemptyArray(
    input.economicLegRatios,
    ECONOMIC_STRATEGY_SERIES_MAX_LEGS,
    `${context}.economicLegRatios`,
  ).map((value, index) => exactSignedRatio(value, `${context}.economicLegRatios[${index}]`));
  if (underlyingRefs.length !== ratios.length) {
    throw new MalformedInputError(
      context,
      `underlying count ${underlyingRefs.length} differs from ratio count ${ratios.length}`,
    );
  }
  const seriesVersion = nonzeroU32(input.seriesVersion, `${context}.seriesVersion`);
  let instrumentRefs: readonly ProtocolId[] | undefined;
  if (seriesVersion === 1) {
    if (input.instrumentRefs !== undefined) {
      throw new MalformedInputError(`${context}.instrumentRefs`, 'instrument references require series version 2 or later');
    }
  } else {
    if (!Array.isArray(input.instrumentRefs) || input.instrumentRefs.length !== ratios.length) {
      throw new MalformedInputError(`${context}.instrumentRefs`, 'versioned instrument references must match the economic leg count');
    }
    const seen = new Set<string>();
    instrumentRefs = Object.freeze(input.instrumentRefs.map((value, index) => {
      const checked = protocolId(value, `${context}.instrumentRefs[${index}]`);
      if (seen.has(checked)) throw new DuplicateElementError(`${context}.instrumentRefs`, 'instrument reference repeats');
      seen.add(checked);
      return checked;
    }));
  }
  const templateManifestHash = manifestHash(
    input.templateManifestHash,
    `${context}.templateManifestHash`,
  );
  return Object.freeze({
    seriesVersion,
    seriesId: protocolId(input.seriesId, `${context}.seriesId`),
    templateId: checkedSemanticId(
      input.templateId,
      support.templates,
      `${context}.templateId`,
    ),
    templateVersion: nonzeroU32(input.templateVersion, `${context}.templateVersion`),
    get templateManifestHash(): ManifestHash {
      return copiedManifestHash(templateManifestHash);
    },
    underlyingRefs: Object.freeze(underlyingRefs),
    quoteAsset: protocolId(input.quoteAsset, `${context}.quoteAsset`),
    economicLegRatios: Object.freeze(ratios),
    ...(instrumentRefs === undefined ? {} : { instrumentRefs }),
    maturityOrEvaluationWindow: checkedDuration(
      input.maturityOrEvaluationWindow,
      `${context}.maturityOrEvaluationWindow`,
    ),
    quoteConvention: checkedSemanticId(
      input.quoteConvention,
      support.quoteConventions,
      `${context}.quoteConvention`,
    ),
    riskClass: checkedSemanticId(
      input.riskClass,
      support.riskClasses,
      `${context}.riskClass`,
    ),
    lifecycleConvention: checkedSemanticId(
      input.lifecycleConvention,
      support.lifecycleConventions,
      `${context}.lifecycleConvention`,
    ),
  });
}

function checkedEconomicStrategySeries(
  value: EconomicStrategySeries,
  support: EconomicStrategySeriesSupportInput,
): EconomicStrategySeries {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(
      'economicStrategySeries',
      'expected an economic strategy series object',
    );
  }
  if (!(value.templateManifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(
      'economicStrategySeries.templateManifestHash',
      'expected 32 canonical bytes',
    );
  }
  return economicStrategySeries(
    {
      seriesVersion: value.seriesVersion,
      seriesId: value.seriesId,
      templateId: value.templateId,
      templateVersion: value.templateVersion,
      templateManifestHash: value.templateManifestHash,
      underlyingRefs: value.underlyingRefs,
      quoteAsset: value.quoteAsset,
      economicLegRatios: value.economicLegRatios,
      ...(value.instrumentRefs === undefined ? {} : { instrumentRefs: value.instrumentRefs }),
      maturityOrEvaluationWindow: value.maturityOrEvaluationWindow,
      quoteConvention: value.quoteConvention,
      riskClass: value.riskClass,
      lifecycleConvention: value.lifecycleConvention,
    },
    support,
  );
}

export function encodeEconomicStrategySeries(
  writer: CanonicalWriter,
  value: EconomicStrategySeries,
  support: EconomicStrategySeriesSupportInput,
): void {
  const checked = checkedEconomicStrategySeries(value, support);
  writer.writeU32(checked.seriesVersion, 'economicStrategySeries.seriesVersion');
  encodeProtocolId(writer, checked.seriesId, 'economicStrategySeries.seriesId');
  encodeProtocolId(writer, checked.templateId, 'economicStrategySeries.templateId');
  writer.writeU32(checked.templateVersion, 'economicStrategySeries.templateVersion');
  encodeManifestHash(
    writer,
    checked.templateManifestHash,
    'economicStrategySeries.templateManifestHash',
  );
  writer.writeArray(
    checked.underlyingRefs,
    (target, value_) => encodeProtocolId(target, value_, 'economicStrategySeries.underlyingRefs.element'),
    'economicStrategySeries.underlyingRefs',
  );
  encodeProtocolId(writer, checked.quoteAsset, 'economicStrategySeries.quoteAsset');
  writer.writeArray(
    checked.economicLegRatios,
    encodeExactSignedRatio,
    'economicStrategySeries.economicLegRatios',
  );
  if (checked.seriesVersion >= 2) {
    writer.writeArray(
      checked.instrumentRefs!,
      (target, value_) => encodeProtocolId(target, value_, 'economicStrategySeries.instrumentRefs.element'),
      'economicStrategySeries.instrumentRefs',
    );
  }
  encodeDuration(writer, checked.maturityOrEvaluationWindow);
  encodeProtocolId(writer, checked.quoteConvention, 'economicStrategySeries.quoteConvention');
  encodeProtocolId(writer, checked.riskClass, 'economicStrategySeries.riskClass');
  encodeProtocolId(
    writer,
    checked.lifecycleConvention,
    'economicStrategySeries.lifecycleConvention',
  );
}

export function economicStrategySeriesBytes(
  input: EconomicStrategySeriesInput,
  support: EconomicStrategySeriesSupportInput,
): Uint8Array {
  const checked = economicStrategySeries(input, support);
  return canonicalBytes((writer) => encodeEconomicStrategySeries(writer, checked, support));
}

export function economicStrategySeriesHash(
  input: EconomicStrategySeriesInput,
  support: EconomicStrategySeriesSupportInput,
): ManifestHash {
  return manifestHash(
    domainHash(
      HASH_DOMAIN.ECONOMIC_STRATEGY_SERIES,
      economicStrategySeriesBytes(input, support),
      'economicStrategySeriesHash',
    ),
    'economicStrategySeriesHash',
  );
}

function canonicalDomainSet(values: readonly DomainRef[], context: string): readonly DomainRef[] {
  const entries = boundedNonemptyArray(
    values,
    SERIES_EXECUTION_CLASS_MAX_DOMAINS,
    context,
  )
    .map((value, index) => {
      if (typeof value !== 'object' || value === null) {
        throw new MalformedInputError(`${context}[${index}]`, 'expected a domain reference object');
      }
      if (!(value.domainManifestHash instanceof Uint8Array)) {
        throw new MalformedInputError(
          `${context}[${index}].domainManifestHash`,
          'expected 32 canonical bytes',
        );
      }
      const checked = domainRef(
        value.domainId,
        value.domainManifestVersion,
        value.domainManifestHash,
        `${context}[${index}]`,
      );
      return {
        value: checked,
        bytes: canonicalBytes((writer) => encodeDomainRef(writer, checked)),
      };
    })
    .sort((left, right) => compareBytes(left.bytes, right.bytes));
  rejectDuplicateEntries(entries, context);
  return Object.freeze(entries.map((entry) => entry.value));
}

function executionSupport(input: SeriesExecutionClassSupportInput, context: string) {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an execution semantics support object');
  }
  return {
    venueClasses: canonicalProtocolIdSet(
      input.supportedVenueClassIds,
      STRATEGY_SERIES_MAX_SUPPORTED_SEMANTICS,
      `${context}.supportedVenueClassIds`,
    ),
    collateralModes: canonicalProtocolIdSet(
      input.supportedCollateralModeIds,
      STRATEGY_SERIES_MAX_SUPPORTED_SEMANTICS,
      `${context}.supportedCollateralModeIds`,
    ),
    settlementClasses: canonicalSettlementClassSet(
      input.supportedSettlementClasses,
      `${context}.supportedSettlementClasses`,
    ),
    firmnessClasses: canonicalProtocolIdSet(
      input.supportedFirmnessClassIds,
      STRATEGY_SERIES_MAX_SUPPORTED_SEMANTICS,
      `${context}.supportedFirmnessClassIds`,
    ),
  };
}

export function seriesExecutionClass(
  input: SeriesExecutionClassInput,
  supportInput: SeriesExecutionClassSupportInput,
  context = 'seriesExecutionClass',
): SeriesExecutionClass {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a series execution class object');
  }
  const support = executionSupport(supportInput, `${context}.support`);
  const settlementClass = input.settlementClass;
  enumDiscriminant(SETTLEMENT_CLASS, settlementClass, `${context}.settlementClass`);
  if (!support.settlementClasses.includes(settlementClass)) {
    throw new MalformedInputError(
      `${context}.settlementClass`,
      `unsupported settlement class ${settlementClass}`,
    );
  }
  const seriesManifestHash = manifestHash(
    input.seriesManifestHash,
    `${context}.seriesManifestHash`,
  );
  const deliveryPolicyHash = manifestHash(
    input.deliveryPolicyHash,
    `${context}.deliveryPolicyHash`,
  );
  const recoveryPolicyHash = manifestHash(
    input.recoveryPolicyHash,
    `${context}.recoveryPolicyHash`,
  );
  const matchingPolicyHash = manifestHash(
    input.matchingPolicyHash,
    `${context}.matchingPolicyHash`,
  );
  const venueClasses = canonicalProtocolIdSet(
    input.venueClasses,
    SERIES_EXECUTION_CLASS_MAX_VENUE_CLASSES,
    `${context}.venueClasses`,
  );
  for (const venueClass of venueClasses) {
    checkedSemanticId(venueClass, support.venueClasses, `${context}.venueClasses`);
  }
  return Object.freeze({
    executionClassVersion: nonzeroU32(
      input.executionClassVersion,
      `${context}.executionClassVersion`,
    ),
    executionClassId: protocolId(input.executionClassId, `${context}.executionClassId`),
    seriesId: protocolId(input.seriesId, `${context}.seriesId`),
    seriesVersion: nonzeroU32(input.seriesVersion, `${context}.seriesVersion`),
    get seriesManifestHash(): ManifestHash {
      return copiedManifestHash(seriesManifestHash);
    },
    domains: canonicalDomainSet(input.domains, `${context}.domains`),
    venueClasses,
    collateralMode: checkedSemanticId(
      input.collateralMode,
      support.collateralModes,
      `${context}.collateralMode`,
    ),
    settlementClass,
    firmnessClass: checkedSemanticId(
      input.firmnessClass,
      support.firmnessClasses,
      `${context}.firmnessClass`,
    ),
    get deliveryPolicyHash(): ManifestHash {
      return copiedManifestHash(deliveryPolicyHash);
    },
    get recoveryPolicyHash(): ManifestHash {
      return copiedManifestHash(recoveryPolicyHash);
    },
    get matchingPolicyHash(): ManifestHash {
      return copiedManifestHash(matchingPolicyHash);
    },
  });
}

function checkedSeriesExecutionClass(
  value: SeriesExecutionClass,
  support: SeriesExecutionClassSupportInput,
): SeriesExecutionClass {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(
      'seriesExecutionClass',
      'expected a series execution class object',
    );
  }
  for (const field of [
    value.seriesManifestHash,
    value.deliveryPolicyHash,
    value.recoveryPolicyHash,
    value.matchingPolicyHash,
  ]) {
    if (!(field instanceof Uint8Array)) {
      throw new MalformedInputError('seriesExecutionClass', 'expected canonical hash bytes');
    }
  }
  return seriesExecutionClass(
    {
      executionClassVersion: value.executionClassVersion,
      executionClassId: value.executionClassId,
      seriesId: value.seriesId,
      seriesVersion: value.seriesVersion,
      seriesManifestHash: value.seriesManifestHash,
      domains: value.domains,
      venueClasses: value.venueClasses,
      collateralMode: value.collateralMode,
      settlementClass: value.settlementClass,
      firmnessClass: value.firmnessClass,
      deliveryPolicyHash: value.deliveryPolicyHash,
      recoveryPolicyHash: value.recoveryPolicyHash,
      matchingPolicyHash: value.matchingPolicyHash,
    },
    support,
  );
}

export function encodeSeriesExecutionClass(
  writer: CanonicalWriter,
  value: SeriesExecutionClass,
  support: SeriesExecutionClassSupportInput,
): void {
  const checked = checkedSeriesExecutionClass(value, support);
  writer.writeU32(checked.executionClassVersion, 'seriesExecutionClass.executionClassVersion');
  encodeProtocolId(writer, checked.executionClassId, 'seriesExecutionClass.executionClassId');
  encodeProtocolId(writer, checked.seriesId, 'seriesExecutionClass.seriesId');
  writer.writeU32(checked.seriesVersion, 'seriesExecutionClass.seriesVersion');
  encodeManifestHash(
    writer,
    checked.seriesManifestHash,
    'seriesExecutionClass.seriesManifestHash',
  );
  writer.writeSet(
    checked.domains,
    (target, value_) => encodeDomainRef(target, value_),
    'seriesExecutionClass.domains',
  );
  writer.writeSet(
    checked.venueClasses,
    (target, value_) => encodeProtocolId(target, value_, 'seriesExecutionClass.venueClasses.element'),
    'seriesExecutionClass.venueClasses',
  );
  encodeProtocolId(writer, checked.collateralMode, 'seriesExecutionClass.collateralMode');
  writer.writeEnum(
    SETTLEMENT_CLASS,
    checked.settlementClass,
    'seriesExecutionClass.settlementClass',
  );
  encodeProtocolId(writer, checked.firmnessClass, 'seriesExecutionClass.firmnessClass');
  encodeManifestHash(
    writer,
    checked.deliveryPolicyHash,
    'seriesExecutionClass.deliveryPolicyHash',
  );
  encodeManifestHash(
    writer,
    checked.recoveryPolicyHash,
    'seriesExecutionClass.recoveryPolicyHash',
  );
  encodeManifestHash(
    writer,
    checked.matchingPolicyHash,
    'seriesExecutionClass.matchingPolicyHash',
  );
}

export function seriesExecutionClassBytes(
  input: SeriesExecutionClassInput,
  support: SeriesExecutionClassSupportInput,
): Uint8Array {
  const checked = seriesExecutionClass(input, support);
  return canonicalBytes((writer) => encodeSeriesExecutionClass(writer, checked, support));
}

export function seriesExecutionClassHash(
  input: SeriesExecutionClassInput,
  support: SeriesExecutionClassSupportInput,
): ManifestHash {
  return manifestHash(
    domainHash(
      HASH_DOMAIN.SERIES_EXECUTION_CLASS,
      seriesExecutionClassBytes(input, support),
      'seriesExecutionClassHash',
    ),
    'seriesExecutionClassHash',
  );
}
