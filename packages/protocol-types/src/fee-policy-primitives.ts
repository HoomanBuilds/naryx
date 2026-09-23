import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  FEE_CATEGORY,
  PASS_THROUGH_COST_CATEGORY,
  REFUND_RULE,
  ROUNDING_DIRECTION,
  SERVICE_FEE_RATE_BASE,
  type FeeCategory,
  type PassThroughCostCategory,
  type RefundRule,
  type RoundingDirection,
  type ServiceFeeRateBase,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import {
  assetId,
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type AssetId,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const U8_BITS = 8;
const U128_BITS = 128;
const I128_BITS = 128;

export interface ServiceFeeRuleInput {
  readonly feeCategory: FeeCategory;
  readonly feeAssetId: string;
  readonly feeAssetManifestHash: Uint8Array | string;
  readonly feeAssetDecimals: number;
  readonly rateBase: ServiceFeeRateBase;
  readonly rateScale: bigint;
  readonly rateValue?: bigint;
  readonly fixedAtoms?: bigint;
  readonly roundingDirection: RoundingDirection;
  readonly hardMaximumReference: string;
  readonly recipientIdentity: string;
  readonly collectionAuthority: string;
}

export interface ServiceFeeRule {
  readonly feeCategory: FeeCategory;
  readonly feeAssetId: AssetId;
  readonly feeAssetManifestHash: ManifestHash;
  readonly feeAssetDecimals: number;
  readonly rateBase: ServiceFeeRateBase;
  readonly rateScale: bigint;
  readonly rateValue?: bigint;
  readonly fixedAtoms?: bigint;
  readonly roundingDirection: RoundingDirection;
  readonly hardMaximumReference: ProtocolId;
  readonly recipientIdentity: ProtocolId;
  readonly collectionAuthority: ProtocolId;
}

export interface PassThroughCostRuleInput {
  readonly costCategory: PassThroughCostCategory;
  readonly costAssetId: string;
  readonly costAssetManifestHash: Uint8Array | string;
  readonly costAssetDecimals: number;
  readonly maxAtoms: bigint;
  readonly roundingDirection: RoundingDirection;
  readonly refundRule: RefundRule;
}

export interface PassThroughCostRule {
  readonly costCategory: PassThroughCostCategory;
  readonly costAssetId: AssetId;
  readonly costAssetManifestHash: ManifestHash;
  readonly costAssetDecimals: number;
  readonly maxAtoms: bigint;
  readonly roundingDirection: RoundingDirection;
  readonly refundRule: RefundRule;
}

interface CanonicalKeyed<T> {
  readonly value: T;
  readonly key: Uint8Array;
}

function u8(value: number, context: string): number {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  return Number(checkedUnsigned(value, U8_BITS, context));
}

function u128(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  return checkedUnsigned(value, U128_BITS, context);
}

function positiveU128(value: bigint, context: string): bigint {
  const checked = u128(value, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'expected a positive integer');
  }
  return checked;
}

function i128(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  return checkedSigned(value, I128_BITS, context);
}

function canonicalManifestHash(value: ManifestHash, context: string): ManifestHash {
  if (!(value instanceof Uint8Array)) {
    throw new MalformedInputError(context, 'expected 32 canonical bytes');
  }
  return manifestHash(value, context);
}

function frozenServiceFeeRule(
  feeCategory: FeeCategory,
  feeAssetId: AssetId,
  capturedHash: ManifestHash,
  feeAssetDecimals: number,
  rateBase: ServiceFeeRateBase,
  rateScale: bigint,
  rateValue: bigint | undefined,
  fixedAtoms: bigint | undefined,
  roundingDirection: RoundingDirection,
  hardMaximumReference: ProtocolId,
  recipientIdentity: ProtocolId,
  collectionAuthority: ProtocolId,
): ServiceFeeRule {
  if (rateValue === undefined) {
    return Object.freeze({
      feeCategory,
      feeAssetId,
      get feeAssetManifestHash(): ManifestHash {
        return Uint8Array.from(capturedHash) as ManifestHash;
      },
      feeAssetDecimals,
      rateBase,
      rateScale,
      fixedAtoms: fixedAtoms as bigint,
      roundingDirection,
      hardMaximumReference,
      recipientIdentity,
      collectionAuthority,
    });
  }
  return Object.freeze({
    feeCategory,
    feeAssetId,
    get feeAssetManifestHash(): ManifestHash {
      return Uint8Array.from(capturedHash) as ManifestHash;
    },
    feeAssetDecimals,
    rateBase,
    rateScale,
    rateValue,
    roundingDirection,
    hardMaximumReference,
    recipientIdentity,
    collectionAuthority,
  });
}

export function serviceFeeRule(
  input: ServiceFeeRuleInput,
  context = 'serviceFeeRule',
): ServiceFeeRule {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a service fee rule object');
  }
  enumDiscriminant(FEE_CATEGORY, input.feeCategory, `${context}.feeCategory`);
  enumDiscriminant(SERVICE_FEE_RATE_BASE, input.rateBase, `${context}.rateBase`);
  enumDiscriminant(
    ROUNDING_DIRECTION,
    input.roundingDirection,
    `${context}.roundingDirection`,
  );

  const hasRate = input.rateValue !== undefined;
  const hasFixed = input.fixedAtoms !== undefined;
  if (hasRate === hasFixed) {
    throw new MalformedInputError(
      context,
      'exactly one of rateValue or fixedAtoms is required',
    );
  }

  const rateScale = positiveU128(input.rateScale, `${context}.rateScale`);
  const rateValue = hasRate
    ? i128(input.rateValue as bigint, `${context}.rateValue`)
    : undefined;
  const fixedAtoms = hasFixed
    ? i128(input.fixedAtoms as bigint, `${context}.fixedAtoms`)
    : undefined;

  if (
    hasFixed &&
    (rateScale !== 1n || input.roundingDirection !== 'TOWARD_ZERO')
  ) {
    throw new MalformedInputError(
      context,
      'fixed fee requires rateScale 1 and TOWARD_ZERO rounding',
    );
  }

  return frozenServiceFeeRule(
    input.feeCategory,
    assetId(input.feeAssetId, `${context}.feeAssetId`),
    manifestHash(input.feeAssetManifestHash, `${context}.feeAssetManifestHash`),
    u8(input.feeAssetDecimals, `${context}.feeAssetDecimals`),
    input.rateBase,
    rateScale,
    rateValue,
    fixedAtoms,
    input.roundingDirection,
    protocolId(input.hardMaximumReference, `${context}.hardMaximumReference`),
    protocolId(input.recipientIdentity, `${context}.recipientIdentity`),
    protocolId(input.collectionAuthority, `${context}.collectionAuthority`),
  );
}

function checkedServiceFeeRule(
  value: ServiceFeeRule,
  context: string,
): ServiceFeeRule {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a service fee rule object');
  }
  return serviceFeeRule(
    {
      feeCategory: value.feeCategory,
      feeAssetId: value.feeAssetId,
      feeAssetManifestHash: canonicalManifestHash(
        value.feeAssetManifestHash,
        `${context}.feeAssetManifestHash`,
      ),
      feeAssetDecimals: value.feeAssetDecimals,
      rateBase: value.rateBase,
      rateScale: value.rateScale,
      ...(value.rateValue === undefined ? {} : { rateValue: value.rateValue }),
      ...(value.fixedAtoms === undefined ? {} : { fixedAtoms: value.fixedAtoms }),
      roundingDirection: value.roundingDirection,
      hardMaximumReference: value.hardMaximumReference,
      recipientIdentity: value.recipientIdentity,
      collectionAuthority: value.collectionAuthority,
    },
    context,
  );
}

export function encodeServiceFeeRule(
  writer: CanonicalWriter,
  value: ServiceFeeRule,
): void {
  const checked = checkedServiceFeeRule(value, 'serviceFeeRule');
  writer.writeEnum(FEE_CATEGORY, checked.feeCategory, 'serviceFeeRule.feeCategory');
  encodeProtocolId(writer, checked.feeAssetId, 'serviceFeeRule.feeAssetId');
  encodeManifestHash(
    writer,
    checked.feeAssetManifestHash,
    'serviceFeeRule.feeAssetManifestHash',
  );
  writer.writeU8(checked.feeAssetDecimals, 'serviceFeeRule.feeAssetDecimals');
  writer.writeEnum(SERVICE_FEE_RATE_BASE, checked.rateBase, 'serviceFeeRule.rateBase');
  writer.writeU128(checked.rateScale, 'serviceFeeRule.rateScale');
  writer.writeOptional(
    checked.rateValue,
    (target, value_) => target.writeI128(value_, 'serviceFeeRule.rateValue.value'),
    'serviceFeeRule.rateValue',
  );
  writer.writeOptional(
    checked.fixedAtoms,
    (target, value_) => target.writeI128(value_, 'serviceFeeRule.fixedAtoms.value'),
    'serviceFeeRule.fixedAtoms',
  );
  writer.writeEnum(
    ROUNDING_DIRECTION,
    checked.roundingDirection,
    'serviceFeeRule.roundingDirection',
  );
  encodeProtocolId(
    writer,
    checked.hardMaximumReference,
    'serviceFeeRule.hardMaximumReference',
  );
  encodeProtocolId(
    writer,
    checked.recipientIdentity,
    'serviceFeeRule.recipientIdentity',
  );
  encodeProtocolId(
    writer,
    checked.collectionAuthority,
    'serviceFeeRule.collectionAuthority',
  );
}

export function serviceFeeRuleKeyBytes(value: ServiceFeeRule): Uint8Array {
  const checked = checkedServiceFeeRule(value, 'serviceFeeRule');
  return canonicalBytes((writer) => {
    writer.writeEnum(FEE_CATEGORY, checked.feeCategory, 'serviceFeeRuleKey.feeCategory');
    encodeProtocolId(writer, checked.feeAssetId, 'serviceFeeRuleKey.feeAssetId');
  });
}

function frozenPassThroughCostRule(
  costCategory: PassThroughCostCategory,
  costAssetId: AssetId,
  capturedHash: ManifestHash,
  costAssetDecimals: number,
  maxAtoms: bigint,
  roundingDirection: RoundingDirection,
  refundRule: RefundRule,
): PassThroughCostRule {
  return Object.freeze({
    costCategory,
    costAssetId,
    get costAssetManifestHash(): ManifestHash {
      return Uint8Array.from(capturedHash) as ManifestHash;
    },
    costAssetDecimals,
    maxAtoms,
    roundingDirection,
    refundRule,
  });
}

export function passThroughCostRule(
  input: PassThroughCostRuleInput,
  context = 'passThroughCostRule',
): PassThroughCostRule {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a pass-through cost rule object');
  }
  enumDiscriminant(
    PASS_THROUGH_COST_CATEGORY,
    input.costCategory,
    `${context}.costCategory`,
  );
  enumDiscriminant(
    ROUNDING_DIRECTION,
    input.roundingDirection,
    `${context}.roundingDirection`,
  );
  enumDiscriminant(REFUND_RULE, input.refundRule, `${context}.refundRule`);
  if (input.roundingDirection !== 'TOWARD_ZERO') {
    throw new MalformedInputError(
      `${context}.roundingDirection`,
      'pass-through cost requires TOWARD_ZERO rounding',
    );
  }

  return frozenPassThroughCostRule(
    input.costCategory,
    assetId(input.costAssetId, `${context}.costAssetId`),
    manifestHash(input.costAssetManifestHash, `${context}.costAssetManifestHash`),
    u8(input.costAssetDecimals, `${context}.costAssetDecimals`),
    u128(input.maxAtoms, `${context}.maxAtoms`),
    input.roundingDirection,
    input.refundRule,
  );
}

function checkedPassThroughCostRule(
  value: PassThroughCostRule,
  context: string,
): PassThroughCostRule {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a pass-through cost rule object');
  }
  return passThroughCostRule(
    {
      costCategory: value.costCategory,
      costAssetId: value.costAssetId,
      costAssetManifestHash: canonicalManifestHash(
        value.costAssetManifestHash,
        `${context}.costAssetManifestHash`,
      ),
      costAssetDecimals: value.costAssetDecimals,
      maxAtoms: value.maxAtoms,
      roundingDirection: value.roundingDirection,
      refundRule: value.refundRule,
    },
    context,
  );
}

export function encodePassThroughCostRule(
  writer: CanonicalWriter,
  value: PassThroughCostRule,
): void {
  const checked = checkedPassThroughCostRule(value, 'passThroughCostRule');
  writer.writeEnum(
    PASS_THROUGH_COST_CATEGORY,
    checked.costCategory,
    'passThroughCostRule.costCategory',
  );
  encodeProtocolId(writer, checked.costAssetId, 'passThroughCostRule.costAssetId');
  encodeManifestHash(
    writer,
    checked.costAssetManifestHash,
    'passThroughCostRule.costAssetManifestHash',
  );
  writer.writeU8(checked.costAssetDecimals, 'passThroughCostRule.costAssetDecimals');
  writer.writeU128(checked.maxAtoms, 'passThroughCostRule.maxAtoms');
  writer.writeEnum(
    ROUNDING_DIRECTION,
    checked.roundingDirection,
    'passThroughCostRule.roundingDirection',
  );
  writer.writeEnum(REFUND_RULE, checked.refundRule, 'passThroughCostRule.refundRule');
}

export function passThroughCostRuleKeyBytes(
  value: PassThroughCostRule,
): Uint8Array {
  const checked = checkedPassThroughCostRule(value, 'passThroughCostRule');
  return canonicalBytes((writer) => {
    writer.writeEnum(
      PASS_THROUGH_COST_CATEGORY,
      checked.costCategory,
      'passThroughCostRuleKey.costCategory',
    );
    encodeProtocolId(writer, checked.costAssetId, 'passThroughCostRuleKey.costAssetId');
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

export function canonicalServiceFeeRules(
  values: readonly ServiceFeeRule[],
  context = 'serviceFeeRules',
): readonly ServiceFeeRule[] {
  return canonicalOrdered(values, checkedServiceFeeRule, serviceFeeRuleKeyBytes, context);
}

export function canonicalPassThroughCostRules(
  values: readonly PassThroughCostRule[],
  context = 'passThroughCostRules',
): readonly PassThroughCostRule[] {
  return canonicalOrdered(
    values,
    checkedPassThroughCostRule,
    passThroughCostRuleKeyBytes,
    context,
  );
}
