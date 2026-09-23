import { checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import {
  DURATION_UNIT,
  enumDiscriminant,
  RISK_LIMIT_KIND,
  type DurationUnit,
  type RiskLimitKind,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import {
  assetId,
  duration,
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type AssetId,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const U32_BITS = 32;
const U128_BITS = 128;

export const RISK_LIMIT_COMPARISON_BITS = 128;

export const REGISTRY_CHANGE_CLASS = Object.freeze({
  TIGHTENING: 'TIGHTENING',
  UNCHANGED: 'UNCHANGED',
  RELAXATION: 'RELAXATION',
} as const);
export type RegistryChangeClass =
  (typeof REGISTRY_CHANGE_CLASS)[keyof typeof REGISTRY_CHANGE_CLASS];

export interface PackageTemplateRefInput {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
}

export interface PackageTemplateRef {
  readonly templateId: ProtocolId;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: ManifestHash;
}

export interface RiskLimitInput {
  readonly limitKind: RiskLimitKind;
  readonly assetId: string;
  readonly assetManifestHash: Uint8Array | string;
  readonly decimals: number;
  readonly maxAtoms: bigint;
  readonly windowUnit?: DurationUnit;
  readonly windowValue?: bigint;
}

export interface RiskLimit {
  readonly limitKind: RiskLimitKind;
  readonly assetId: AssetId;
  readonly assetManifestHash: ManifestHash;
  readonly decimals: number;
  readonly maxAtoms: bigint;
  readonly windowUnit?: DurationUnit;
  readonly windowValue?: bigint;
}

interface CanonicalKeyed<T> {
  readonly value: T;
  readonly key: Uint8Array;
}

function nonzeroU32(value: number, context: string): number {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  const checked = checkedUnsigned(value, U32_BITS, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'version is zero');
  }
  return Number(checked);
}

function canonicalManifestHash(value: ManifestHash, context: string): ManifestHash {
  if (!(value instanceof Uint8Array)) {
    throw new MalformedInputError(context, 'expected 32 canonical bytes');
  }
  return manifestHash(value, context);
}

function frozenPackageTemplateRef(
  templateId: ProtocolId,
  templateVersion: number,
  capturedHash: ManifestHash,
): PackageTemplateRef {
  return Object.freeze({
    templateId,
    templateVersion,
    get packageTemplateManifestHash(): ManifestHash {
      return Uint8Array.from(capturedHash) as ManifestHash;
    },
  });
}

export function packageTemplateRef(
  input: PackageTemplateRefInput,
  context = 'packageTemplateRef',
): PackageTemplateRef {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a package template reference object');
  }
  return frozenPackageTemplateRef(
    protocolId(input.templateId, `${context}.templateId`),
    nonzeroU32(input.templateVersion, `${context}.templateVersion`),
    manifestHash(
      input.packageTemplateManifestHash,
      `${context}.packageTemplateManifestHash`,
    ),
  );
}

function checkedPackageTemplateRef(
  value: PackageTemplateRef,
  context: string,
): PackageTemplateRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a package template reference object');
  }
  return frozenPackageTemplateRef(
    protocolId(value.templateId, `${context}.templateId`),
    nonzeroU32(value.templateVersion, `${context}.templateVersion`),
    canonicalManifestHash(
      value.packageTemplateManifestHash,
      `${context}.packageTemplateManifestHash`,
    ),
  );
}

export function encodePackageTemplateRef(
  writer: CanonicalWriter,
  value: PackageTemplateRef,
): void {
  const checked = checkedPackageTemplateRef(value, 'packageTemplateRef');
  encodeProtocolId(writer, checked.templateId, 'packageTemplateRef.templateId');
  writer.writeU32(checked.templateVersion, 'packageTemplateRef.templateVersion');
  encodeManifestHash(
    writer,
    checked.packageTemplateManifestHash,
    'packageTemplateRef.packageTemplateManifestHash',
  );
}

export function packageTemplateRefKeyBytes(value: PackageTemplateRef): Uint8Array {
  const checked = checkedPackageTemplateRef(value, 'packageTemplateRef');
  return canonicalBytes((writer) => encodePackageTemplateRef(writer, checked));
}

function frozenRiskLimit(
  limitKind: RiskLimitKind,
  id: AssetId,
  capturedHash: ManifestHash,
  decimals: number,
  maxAtoms: bigint,
  windowUnit?: DurationUnit,
  windowValue?: bigint,
): RiskLimit {
  if (windowUnit === undefined || windowValue === undefined) {
    return Object.freeze({
      limitKind,
      assetId: id,
      get assetManifestHash(): ManifestHash {
        return Uint8Array.from(capturedHash) as ManifestHash;
      },
      decimals,
      maxAtoms,
    });
  }
  return Object.freeze({
    limitKind,
    assetId: id,
    get assetManifestHash(): ManifestHash {
      return Uint8Array.from(capturedHash) as ManifestHash;
    },
    decimals,
    maxAtoms,
    windowUnit,
    windowValue,
  });
}

export function riskLimit(input: RiskLimitInput, context = 'riskLimit'): RiskLimit {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a risk limit object');
  }
  enumDiscriminant(RISK_LIMIT_KIND, input.limitKind, `${context}.limitKind`);
  if (typeof input.maxAtoms !== 'bigint') {
    throw new MalformedInputError(`${context}.maxAtoms`, 'expected a bigint atom limit');
  }
  if (typeof input.decimals !== 'number') {
    throw new MalformedInputError(`${context}.decimals`, 'expected a number');
  }

  const hasWindowUnit = input.windowUnit !== undefined;
  const hasWindowValue = input.windowValue !== undefined;
  const isWindowed = input.limitKind === 'OUTFLOW_RATE';
  if (hasWindowUnit !== hasWindowValue || hasWindowUnit !== isWindowed) {
    throw new MalformedInputError(
      context,
      isWindowed
        ? 'OUTFLOW_RATE requires both window fields'
        : 'non-windowed risk limit forbids window fields',
    );
  }

  let windowUnit: DurationUnit | undefined;
  let windowValue: bigint | undefined;
  if (isWindowed) {
    const checkedWindow = duration(
      input.windowUnit as DurationUnit,
      input.windowValue as bigint,
      `${context}.window`,
    );
    windowUnit = checkedWindow.unit;
    windowValue = checkedWindow.value;
  }

  return frozenRiskLimit(
    input.limitKind,
    assetId(input.assetId, `${context}.assetId`),
    manifestHash(input.assetManifestHash, `${context}.assetManifestHash`),
    Number(checkedUnsigned(input.decimals, 8, `${context}.decimals`)),
    checkedUnsigned(input.maxAtoms, U128_BITS, `${context}.maxAtoms`),
    windowUnit,
    windowValue,
  );
}

function checkedRiskLimit(value: RiskLimit, context: string): RiskLimit {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a risk limit object');
  }
  return riskLimit(
    {
      limitKind: value.limitKind,
      assetId: value.assetId,
      assetManifestHash: canonicalManifestHash(
        value.assetManifestHash,
        `${context}.assetManifestHash`,
      ),
      decimals: value.decimals,
      maxAtoms: value.maxAtoms,
      ...(value.windowUnit === undefined ? {} : { windowUnit: value.windowUnit }),
      ...(value.windowValue === undefined ? {} : { windowValue: value.windowValue }),
    },
    context,
  );
}

export function encodeRiskLimit(writer: CanonicalWriter, value: RiskLimit): void {
  const checked = checkedRiskLimit(value, 'riskLimit');
  writer.writeEnum(RISK_LIMIT_KIND, checked.limitKind, 'riskLimit.limitKind');
  encodeProtocolId(writer, checked.assetId, 'riskLimit.assetId');
  encodeManifestHash(writer, checked.assetManifestHash, 'riskLimit.assetManifestHash');
  writer.writeU8(checked.decimals, 'riskLimit.decimals');
  writer.writeU128(checked.maxAtoms, 'riskLimit.maxAtoms');
  writer.writeOptional(
    checked.windowUnit,
    (target, unit) => target.writeEnum(DURATION_UNIT, unit, 'riskLimit.windowUnit.value'),
    'riskLimit.windowUnit',
  );
  writer.writeOptional(
    checked.windowValue,
    (target, value_) => target.writeU64(value_, 'riskLimit.windowValue.value'),
    'riskLimit.windowValue',
  );
}

export function riskLimitKeyBytes(value: RiskLimit): Uint8Array {
  const checked = checkedRiskLimit(value, 'riskLimit');
  return canonicalBytes((writer) => {
    writer.writeEnum(RISK_LIMIT_KIND, checked.limitKind, 'riskLimitKey.limitKind');
    encodeProtocolId(writer, checked.assetId, 'riskLimitKey.assetId');
    writer.writeOptional(
      checked.windowUnit,
      (target, unit) => target.writeEnum(DURATION_UNIT, unit, 'riskLimitKey.windowUnit.value'),
      'riskLimitKey.windowUnit',
    );
    writer.writeOptional(
      checked.windowValue,
      (target, value_) => target.writeU64(value_, 'riskLimitKey.windowValue.value'),
      'riskLimitKey.windowValue',
    );
  });
}

function canonicalOrdered<T>(
  values: readonly T[],
  canonicalize: (value: T, context: string) => T,
  keyBytes: (value: T) => Uint8Array,
  context: string,
): readonly T[] {
  if (!Array.isArray(values)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  const entries: CanonicalKeyed<T>[] = values.map((value, index) => {
    const checked = canonicalize(value, `${context}[${index}]`);
    return { value: checked, key: keyBytes(checked) };
  });
  for (let index = 1; index < entries.length; index += 1) {
    const relation = compareBytes(entries[index - 1]!.key, entries[index]!.key);
    if (relation === 0) {
      throw new DuplicateElementError(context, `duplicate canonical key at index ${index}`);
    }
    if (relation > 0) {
      throw new MalformedInputError(context, `noncanonical ordering at index ${index}`);
    }
  }
  return Object.freeze(entries.map((entry) => entry.value));
}

export function canonicalRiskLimits(
  values: readonly RiskLimit[],
  context = 'riskLimits',
): readonly RiskLimit[] {
  return canonicalOrdered(values, checkedRiskLimit, riskLimitKeyBytes, context);
}

export function canonicalPackageTemplateRefs(
  values: readonly PackageTemplateRef[],
  context = 'packageTemplateRefs',
): readonly PackageTemplateRef[] {
  return canonicalOrdered(
    values,
    checkedPackageTemplateRef,
    packageTemplateRefKeyBytes,
    context,
  );
}

function sameRiskIdentity(left: RiskLimit, right: RiskLimit): boolean {
  return (
    left.limitKind === right.limitKind &&
    left.assetId === right.assetId &&
    compareBytes(left.assetManifestHash, right.assetManifestHash) === 0 &&
    left.decimals === right.decimals
  );
}

export function classifyRiskLimitChange(
  previous: RiskLimit | undefined,
  next: RiskLimit | undefined,
): RegistryChangeClass {
  if (previous === undefined && next === undefined) {
    return REGISTRY_CHANGE_CLASS.UNCHANGED;
  }
  if (previous === undefined) {
    checkedRiskLimit(next as RiskLimit, 'classifyRiskLimitChange.next');
    return REGISTRY_CHANGE_CLASS.RELAXATION;
  }
  if (next === undefined) {
    checkedRiskLimit(previous, 'classifyRiskLimitChange.previous');
    return REGISTRY_CHANGE_CLASS.TIGHTENING;
  }

  const oldLimit = checkedRiskLimit(previous, 'classifyRiskLimitChange.previous');
  const newLimit = checkedRiskLimit(next, 'classifyRiskLimitChange.next');
  if (!sameRiskIdentity(oldLimit, newLimit)) {
    return REGISTRY_CHANGE_CLASS.RELAXATION;
  }

  if (oldLimit.limitKind !== 'OUTFLOW_RATE') {
    if (newLimit.maxAtoms === oldLimit.maxAtoms) return REGISTRY_CHANGE_CLASS.UNCHANGED;
    return newLimit.maxAtoms < oldLimit.maxAtoms
      ? REGISTRY_CHANGE_CLASS.TIGHTENING
      : REGISTRY_CHANGE_CLASS.RELAXATION;
  }

  if (oldLimit.windowUnit !== newLimit.windowUnit) {
    return REGISTRY_CHANGE_CLASS.RELAXATION;
  }

  try {
    const newCapacity = checkedUnsigned(
      newLimit.maxAtoms * (oldLimit.windowValue as bigint),
      RISK_LIMIT_COMPARISON_BITS,
      'classifyRiskLimitChange.newCapacity',
    );
    const oldCapacity = checkedUnsigned(
      oldLimit.maxAtoms * (newLimit.windowValue as bigint),
      RISK_LIMIT_COMPARISON_BITS,
      'classifyRiskLimitChange.oldCapacity',
    );
    if (newCapacity === oldCapacity) return REGISTRY_CHANGE_CLASS.UNCHANGED;
    return newCapacity < oldCapacity
      ? REGISTRY_CHANGE_CLASS.TIGHTENING
      : REGISTRY_CHANGE_CLASS.RELAXATION;
  } catch {
    return REGISTRY_CHANGE_CLASS.RELAXATION;
  }
}
