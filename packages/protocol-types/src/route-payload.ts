import { sha256 } from '@noble/hashes/sha2.js';
import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import {
  COMPARATOR,
  DIRECTION,
  enumDiscriminant,
  EXECUTION_PLAN_KIND,
  EXPIRY_UNIT,
  FEE_CATEGORY,
  LATE_BOUND_FIELD_KIND,
  LEG_ROLE,
  PACKAGE_ACTION,
  PACKAGE_TIME_IN_FORCE,
  PARTIAL_FILL_POLICY,
  QUANTITY_POLICY_CLASS,
  RECOVERY_ACTION,
  SETTLEMENT_CLASS,
  STATE_VALUE_KIND,
  TRADE_SIDE,
  type Comparator,
  type Direction,
  type ExecutionPlanKind,
  type ExpiryUnit,
  type FeeCategory,
  type LateBoundFieldKind,
  type LegRole,
  type PackageAction,
  type PackageTimeInForce,
  type PartialFillPolicy,
  type QuantityPolicyClass,
  type RecoveryAction,
  type SettlementClass,
  type TradeSide,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  adapterRef,
  commitmentHash,
  encodeAdapterRef,
  encodeCommitmentHash,
  encodeExactPrice,
  encodeFeeCap,
  exactPrice,
  feeCap,
  type AdapterRef,
  type CommitmentHash,
  type ExactPrice,
  type FeeCap,
} from './package-order-primitives.js';
import {
  assetAmount,
  assetRef,
  domainRef,
  encodeAssetAmount,
  encodeAssetRef,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  encodeVersionedManifestRef,
  manifestHash,
  protocolId,
  versionedManifestRef,
  type AssetAmount,
  type AssetRef,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
  type VersionedManifestRef,
} from './primitives.js';

const ROUTE_VERSION = 1;
const U8_BITS = 8;
const U32_BITS = 32;
const U64_BITS = 64;
const U128_BITS = 128;
const U256_BITS = 256;
const I128_BITS = 128;

export interface PositiveAssetAmountInput {
  readonly asset: AssetRef;
  readonly atoms: bigint;
}

export interface PositiveAssetAmount {
  readonly asset: AssetRef;
  readonly atoms: bigint;
}

export interface UnsignedAssetAmountInput {
  readonly asset: AssetRef;
  readonly atoms: bigint;
}

export interface UnsignedAssetAmount {
  readonly asset: AssetRef;
  readonly atoms: bigint;
}

export interface NativeAssetValueInput {
  readonly asset: AssetRef;
  readonly atoms: bigint;
}

export interface NativeAssetValue {
  readonly asset: AssetRef;
  readonly atoms: bigint;
}

export interface RouteAccountBindingInput {
  readonly routeBindingId: string;
  readonly adapter?: AdapterRef;
  readonly adapterBindingId?: string;
  readonly accountIdentity: string;
  readonly ownerIdentity?: string;
  readonly authorityIdentity?: string;
  readonly codeIdentity?: string;
}

export interface RouteAccountBinding {
  readonly routeBindingId: ProtocolId;
  readonly adapter?: AdapterRef;
  readonly adapterBindingId?: ProtocolId;
  readonly accountIdentity: ProtocolId;
  readonly ownerIdentity?: ProtocolId;
  readonly authorityIdentity?: ProtocolId;
  readonly codeIdentity?: ProtocolId;
}

export interface RouteServiceChargeInput {
  readonly feeCategory: FeeCategory;
  readonly asset: AssetRef;
  readonly atoms: bigint;
  readonly recipientIdentity: string;
  readonly collectionAuthority: string;
  readonly collectionModeId: string;
  readonly collectionActionSequence?: number;
}

export interface RouteServiceCharge {
  readonly feeCategory: FeeCategory;
  readonly asset: AssetRef;
  readonly atoms: bigint;
  readonly recipientIdentity: ProtocolId;
  readonly collectionAuthority: ProtocolId;
  readonly collectionModeId: ProtocolId;
  readonly collectionActionSequence?: number;
}

export interface LegExecutionInput {
  readonly legIndex: number;
  readonly legRole: LegRole;
  readonly actionSequence: number;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly side: TradeSide;
  readonly quantity: PositiveAssetAmountInput;
  readonly limitPrice: ExactPrice;
  readonly timeInForce: PackageTimeInForce;
  readonly reduceOnly: boolean;
}

export interface LegExecution {
  readonly legIndex: number;
  readonly legRole: LegRole;
  readonly actionSequence: number;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly side: TradeSide;
  readonly quantity: PositiveAssetAmount;
  readonly limitPrice: ExactPrice;
  readonly timeInForce: PackageTimeInForce;
  readonly reduceOnly: boolean;
}

export interface ActionAccountMetaInput {
  readonly routeBindingId: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface ActionAccountMeta {
  readonly routeBindingId: ProtocolId;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface LateBoundFieldInput {
  readonly kind: LateBoundFieldKind;
  readonly offset: number;
  readonly length: number;
}

export interface LateBoundField {
  readonly kind: LateBoundFieldKind;
  readonly offset: number;
  readonly length: number;
}

export interface PayloadTemplateCommitmentInput {
  readonly codecId: string;
  readonly templateLength: number;
  readonly templateHash: Uint8Array | string;
  readonly lateBoundFields: readonly LateBoundFieldInput[];
}

export interface PayloadTemplateCommitment {
  readonly codecId: ProtocolId;
  readonly templateLength: number;
  readonly templateHash: CommitmentHash;
  readonly lateBoundFields: readonly LateBoundField[];
}

export interface ActionCommitmentInput {
  readonly sequence: number;
  readonly actionClassId: string;
  readonly legIndex?: number;
  readonly adapter?: AdapterRef;
  readonly targetBindingId: string;
  readonly authorityBindingId: string;
  readonly accountMetas: readonly ActionAccountMetaInput[];
  readonly nativeValue?: NativeAssetValueInput;
  readonly payload: PayloadTemplateCommitmentInput;
  readonly feeRecipientBindingId?: string;
}

export interface ActionCommitment {
  readonly sequence: number;
  readonly actionClassId: ProtocolId;
  readonly legIndex?: number;
  readonly adapter?: AdapterRef;
  readonly targetBindingId: ProtocolId;
  readonly authorityBindingId: ProtocolId;
  readonly accountMetas: readonly ActionAccountMeta[];
  readonly nativeValue?: NativeAssetValue;
  readonly payload: PayloadTemplateCommitment;
  readonly feeRecipientBindingId?: ProtocolId;
}

export type StateValueInput =
  | { readonly kind: 'SIGNED_ASSET_AMOUNT'; readonly value: AssetAmount }
  | { readonly kind: 'UNSIGNED_U256'; readonly value: bigint }
  | { readonly kind: 'COMMITMENT_HASH'; readonly value: Uint8Array | string }
  | { readonly kind: 'PROTOCOL_ID'; readonly value: string }
  | { readonly kind: 'BOOLEAN'; readonly value: boolean };

export type StateValue =
  | { readonly kind: 'SIGNED_ASSET_AMOUNT'; readonly value: AssetAmount }
  | { readonly kind: 'UNSIGNED_U256'; readonly value: bigint }
  | { readonly kind: 'COMMITMENT_HASH'; readonly value: CommitmentHash }
  | { readonly kind: 'PROTOCOL_ID'; readonly value: ProtocolId }
  | { readonly kind: 'BOOLEAN'; readonly value: boolean };

export interface StateConstraintInput {
  readonly constraintId: string;
  readonly ruleId: string;
  readonly accountBindingId: string;
  readonly componentId: string;
  readonly comparator: Comparator;
  readonly value: StateValueInput;
  readonly evidenceRequirementId: string;
}

export interface StateConstraint {
  readonly constraintId: ProtocolId;
  readonly ruleId: ProtocolId;
  readonly accountBindingId: ProtocolId;
  readonly componentId: ProtocolId;
  readonly comparator: Comparator;
  readonly value: StateValue;
  readonly evidenceRequirementId: ProtocolId;
}

export interface EvidenceRequirementsInput {
  readonly schemaVersion: number;
  readonly profileId: string;
  readonly requiredPreStateComponentIds: readonly string[];
  readonly requiredPostStateComponentIds: readonly string[];
  readonly requiredActionEvidenceTypeIds: readonly string[];
  readonly stateReferenceSchemaHash: Uint8Array | string;
  readonly receiptSchemaHash: Uint8Array | string;
  readonly outcomeSchemaHash: Uint8Array | string;
}

export interface EvidenceRequirements {
  readonly schemaVersion: number;
  readonly profileId: ProtocolId;
  readonly requiredPreStateComponentIds: readonly ProtocolId[];
  readonly requiredPostStateComponentIds: readonly ProtocolId[];
  readonly requiredActionEvidenceTypeIds: readonly ProtocolId[];
  readonly stateReferenceSchemaHash: ManifestHash;
  readonly receiptSchemaHash: ManifestHash;
  readonly outcomeSchemaHash: ManifestHash;
}

export interface RecoveryActionSlotInput {
  readonly sequence: number;
  readonly action: RecoveryAction;
  readonly targetLeg: number;
  readonly adapter: AdapterRef;
  readonly markets: readonly VersionedManifestRef[];
  readonly maxQuantity?: PositiveAssetAmountInput;
  readonly limitPrice?: ExactPrice;
  readonly reduceOnly?: boolean;
  readonly timeInForce?: PackageTimeInForce;
}

export interface RecoveryActionSlot {
  readonly sequence: number;
  readonly action: RecoveryAction;
  readonly targetLeg: number;
  readonly adapter: AdapterRef;
  readonly markets: readonly VersionedManifestRef[];
  readonly maxQuantity?: PositiveAssetAmount;
  readonly limitPrice?: ExactPrice;
  readonly reduceOnly?: boolean;
  readonly timeInForce?: PackageTimeInForce;
}

export interface RecoveryPlanInput {
  readonly policyVersion: number;
  readonly controllerId: string;
  readonly controllerCodeHash: Uint8Array | string;
  readonly authorityModeId: string;
  readonly recoveryExpiryUnit: ExpiryUnit;
  readonly maxActionExpiryValue: bigint;
  readonly deadlineValue: bigint;
  readonly minRecoveryWindowMs: bigint;
  readonly maxRecoveryCostCaps: readonly FeeCap[];
  readonly maxAggregateRecoveryLoss: UnsignedAssetAmountInput;
  readonly maxIntermediateResidual: UnsignedAssetAmountInput;
  readonly maxTerminalResidual: UnsignedAssetAmountInput;
  readonly reconciledStateSchemaHash: Uint8Array | string;
  readonly actionBuilderCodeHash: Uint8Array | string;
  readonly actionSlots: readonly RecoveryActionSlotInput[];
}

export interface RecoveryPlan {
  readonly policyVersion: number;
  readonly controllerId: ProtocolId;
  readonly controllerCodeHash: ManifestHash;
  readonly authorityModeId: ProtocolId;
  readonly recoveryExpiryUnit: ExpiryUnit;
  readonly maxActionExpiryValue: bigint;
  readonly deadlineValue: bigint;
  readonly minRecoveryWindowMs: bigint;
  readonly maxRecoveryCostCaps: readonly FeeCap[];
  readonly maxAggregateRecoveryLoss: UnsignedAssetAmount;
  readonly maxIntermediateResidual: UnsignedAssetAmount;
  readonly maxTerminalResidual: UnsignedAssetAmount;
  readonly reconciledStateSchemaHash: ManifestHash;
  readonly actionBuilderCodeHash: ManifestHash;
  readonly actionSlots: readonly RecoveryActionSlot[];
}

export interface RoutePayloadInput {
  readonly version: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly orderHash: Uint8Array | string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly templateRegistryRecordHash: Uint8Array | string;
  readonly owner: string;
  readonly settlementAccount: string;
  readonly solver: string;
  readonly direction: Direction;
  readonly action: PackageAction;
  readonly quantityPolicyClass: QuantityPolicyClass;
  readonly partialFillPolicy: PartialFillPolicy;
  readonly settlementClass: SettlementClass;
  readonly executionPlanKind: ExecutionPlanKind;
  readonly routeExpiryUnit: ExpiryUnit;
  readonly routeExpiryValue: bigint;
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Uint8Array | string;
  readonly accountBindings: readonly RouteAccountBindingInput[];
  readonly serviceCharges: readonly RouteServiceChargeInput[];
  readonly preconditions: readonly StateConstraintInput[];
  readonly legs: readonly LegExecutionInput[];
  readonly actions: readonly ActionCommitmentInput[];
  readonly postconditions: readonly StateConstraintInput[];
  readonly evidenceRequirements: EvidenceRequirementsInput;
  readonly recoveryPlan?: RecoveryPlanInput;
}

export interface RoutePayload {
  readonly version: 1;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly orderHash: CommitmentHash;
  readonly templateId: ProtocolId;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: ManifestHash;
  readonly templateRegistryRecordHash: CommitmentHash;
  readonly owner: ProtocolId;
  readonly settlementAccount: ProtocolId;
  readonly solver: ProtocolId;
  readonly direction: Direction;
  readonly action: PackageAction;
  readonly quantityPolicyClass: QuantityPolicyClass;
  readonly partialFillPolicy: PartialFillPolicy;
  readonly settlementClass: SettlementClass;
  readonly executionPlanKind: ExecutionPlanKind;
  readonly routeExpiryUnit: ExpiryUnit;
  readonly routeExpiryValue: bigint;
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: ManifestHash;
  readonly accountBindings: readonly RouteAccountBinding[];
  readonly serviceCharges: readonly RouteServiceCharge[];
  readonly preconditions: readonly StateConstraint[];
  readonly legs: readonly LegExecution[];
  readonly actions: readonly ActionCommitment[];
  readonly postconditions: readonly StateConstraint[];
  readonly evidenceRequirements: EvidenceRequirements;
  readonly recoveryPlan?: RecoveryPlan;
}

function object(value: unknown, context: string): asserts value is object {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an object');
  }
}

function numberValue(value: number, bits: 8 | 32, context: string): number {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  return Number(checkedUnsigned(value, bits, context));
}

function nonzeroU32(value: number, context: string): number {
  const checked = numberValue(value, U32_BITS, context);
  if (checked === 0) throw new MalformedInputError(context, 'value is zero');
  return checked;
}

function bigintValue(value: bigint, bits: 64 | 128 | 256, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  return checkedUnsigned(value, bits, context);
}

function signedI128(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  return checkedSigned(value, I128_BITS, context);
}

function booleanValue(value: boolean, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new MalformedInputError(context, 'expected a boolean');
  }
  return value;
}

function requireCanonicalHash(value: unknown, context: string): void {
  if (!(value instanceof Uint8Array)) {
    throw new MalformedInputError(context, 'expected 32 canonical bytes');
  }
}

function requireCanonicalAsset(value: AssetRef, context: string): void {
  object(value, context);
  requireCanonicalHash(value.assetManifestHash, `${context}.assetManifestHash`);
}

function requireCanonicalAdapter(value: AdapterRef, context: string): void {
  object(value, context);
  requireCanonicalHash(value.adapterManifestHash, `${context}.adapterManifestHash`);
}

function requireCanonicalVersionedRef(value: VersionedManifestRef, context: string): void {
  object(value, context);
  requireCanonicalHash(value.manifestHash, `${context}.manifestHash`);
}

function requireCanonicalPrice(value: ExactPrice, context: string): void {
  object(value, context);
  requireCanonicalAsset(value.baseAsset, `${context}.baseAsset`);
  requireCanonicalAsset(value.quoteAsset, `${context}.quoteAsset`);
}

function checkedAssetRef(value: AssetRef, context: string): AssetRef {
  object(value, context);
  if (!(value.assetManifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(`${context}.assetManifestHash`, 'expected 32 canonical bytes');
  }
  return assetRef(value.assetId, value.assetManifestHash, value.decimals, context);
}

function checkedDomainRef(value: DomainRef, context: string): DomainRef {
  object(value, context);
  if (!(value.domainManifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(`${context}.domainManifestHash`, 'expected 32 canonical bytes');
  }
  return domainRef(value.domainId, value.domainManifestVersion, value.domainManifestHash, context);
}

function checkedAdapterRef(value: AdapterRef, context: string): AdapterRef {
  object(value, context);
  if (!(value.adapterManifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(`${context}.adapterManifestHash`, 'expected 32 canonical bytes');
  }
  return adapterRef(value, context);
}

function checkedVersionedRef(value: VersionedManifestRef, context: string): VersionedManifestRef {
  object(value, context);
  if (!(value.manifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(`${context}.manifestHash`, 'expected 32 canonical bytes');
  }
  return versionedManifestRef(value.subjectId, value.manifestVersion, value.manifestHash, context);
}

function checkedExactPrice(value: ExactPrice, context: string): ExactPrice {
  object(value, context);
  return exactPrice(value, context);
}

function checkedAssetAmount(value: AssetAmount, context: string, nonnegative = false): AssetAmount {
  object(value, context);
  const checked = assetAmount(value.asset, value.atoms, context);
  if (nonnegative && checked.atoms < 0n) {
    throw new MalformedInputError(`${context}.atoms`, 'expected a nonnegative amount');
  }
  return checked;
}

function positiveAssetAmount(
  input: PositiveAssetAmountInput,
  context = 'positiveAssetAmount',
): PositiveAssetAmount {
  object(input, context);
  const atoms = bigintValue(input.atoms, U128_BITS, `${context}.atoms`);
  if (atoms === 0n) throw new MalformedInputError(`${context}.atoms`, 'value is zero');
  return Object.freeze({ asset: checkedAssetRef(input.asset, `${context}.asset`), atoms });
}

function encodePositiveAssetAmount(writer: CanonicalWriter, value: PositiveAssetAmount): void {
  const checked = positiveAssetAmount(value, 'positiveAssetAmount');
  encodeAssetRef(writer, checked.asset);
  writer.writeU128(checked.atoms, 'positiveAssetAmount.atoms');
}

function unsignedAssetAmount(
  input: UnsignedAssetAmountInput,
  context = 'unsignedAssetAmount',
): UnsignedAssetAmount {
  object(input, context);
  return Object.freeze({
    asset: checkedAssetRef(input.asset, `${context}.asset`),
    atoms: bigintValue(input.atoms, U128_BITS, `${context}.atoms`),
  });
}

function encodeUnsignedAssetAmount(writer: CanonicalWriter, value: UnsignedAssetAmount): void {
  const checked = unsignedAssetAmount(value, 'unsignedAssetAmount');
  encodeAssetRef(writer, checked.asset);
  writer.writeU128(checked.atoms, 'unsignedAssetAmount.atoms');
}

function nativeAssetValue(input: NativeAssetValueInput, context = 'nativeAssetValue'): NativeAssetValue {
  object(input, context);
  return Object.freeze({
    asset: checkedAssetRef(input.asset, `${context}.asset`),
    atoms: bigintValue(input.atoms, U256_BITS, `${context}.atoms`),
  });
}

function encodeNativeAssetValue(writer: CanonicalWriter, value: NativeAssetValue): void {
  const checked = nativeAssetValue(value, 'nativeAssetValue');
  encodeAssetRef(writer, checked.asset);
  writer.writeU256(checked.atoms, 'nativeAssetValue.atoms');
}

interface Keyed<T> {
  readonly value: T;
  readonly key: Uint8Array;
}

function canonicalSet<Input, Output>(
  values: readonly Input[],
  validate: (value: Input, context: string) => Output,
  key: (value: Output) => Uint8Array,
  context: string,
  nonempty: boolean,
): readonly Output[] {
  if (!Array.isArray(values)) throw new MalformedInputError(context, 'expected an array');
  if (nonempty && values.length === 0) throw new MalformedInputError(context, 'set is empty');
  const entries: Keyed<Output>[] = values.map((value, index) => {
    const checked = validate(value, `${context}[${index}]`);
    return { value: checked, key: key(checked) };
  });
  entries.sort((left, right) => compareBytes(left.key, right.key));
  for (let index = 1; index < entries.length; index += 1) {
    if (compareBytes(entries[index - 1]!.key, entries[index]!.key) === 0) {
      throw new DuplicateElementError(context, `duplicate canonical key at sorted index ${index}`);
    }
  }
  return Object.freeze(entries.map((entry) => entry.value));
}

function protocolIdKey(value: ProtocolId): Uint8Array {
  return canonicalBytes((writer) => encodeProtocolId(writer, value));
}

function assetRefKey(value: AssetRef): Uint8Array {
  return canonicalBytes((writer) => encodeAssetRef(writer, value));
}

function versionedRefKey(value: VersionedManifestRef): Uint8Array {
  return canonicalBytes((writer) => encodeVersionedManifestRef(writer, value));
}

export function routeAccountBinding(
  input: RouteAccountBindingInput,
  context = 'routeAccountBinding',
): RouteAccountBinding {
  object(input, context);
  const hasAdapter = input.adapter !== undefined;
  const hasBinding = input.adapterBindingId !== undefined;
  if (hasAdapter !== hasBinding) {
    throw new MalformedInputError(context, 'adapter and adapterBindingId must both be present or absent');
  }
  return Object.freeze({
    routeBindingId: protocolId(input.routeBindingId, `${context}.routeBindingId`),
    ...(hasAdapter ? { adapter: checkedAdapterRef(input.adapter as AdapterRef, `${context}.adapter`) } : {}),
    ...(hasBinding ? { adapterBindingId: protocolId(input.adapterBindingId as string, `${context}.adapterBindingId`) } : {}),
    accountIdentity: protocolId(input.accountIdentity, `${context}.accountIdentity`),
    ...(input.ownerIdentity === undefined ? {} : { ownerIdentity: protocolId(input.ownerIdentity, `${context}.ownerIdentity`) }),
    ...(input.authorityIdentity === undefined ? {} : { authorityIdentity: protocolId(input.authorityIdentity, `${context}.authorityIdentity`) }),
    ...(input.codeIdentity === undefined ? {} : { codeIdentity: protocolId(input.codeIdentity, `${context}.codeIdentity`) }),
  });
}

export function encodeRouteAccountBinding(writer: CanonicalWriter, value: RouteAccountBinding): void {
  const checked = routeAccountBinding(value, 'routeAccountBinding');
  encodeProtocolId(writer, checked.routeBindingId, 'routeAccountBinding.routeBindingId');
  writer.writeOptional(checked.adapter, encodeAdapterRef, 'routeAccountBinding.adapter');
  writer.writeOptional(checked.adapterBindingId, (target, id) => encodeProtocolId(target, id), 'routeAccountBinding.adapterBindingId');
  encodeProtocolId(writer, checked.accountIdentity, 'routeAccountBinding.accountIdentity');
  writer.writeOptional(checked.ownerIdentity, (target, id) => encodeProtocolId(target, id), 'routeAccountBinding.ownerIdentity');
  writer.writeOptional(checked.authorityIdentity, (target, id) => encodeProtocolId(target, id), 'routeAccountBinding.authorityIdentity');
  writer.writeOptional(checked.codeIdentity, (target, id) => encodeProtocolId(target, id), 'routeAccountBinding.codeIdentity');
}

function canonicalAccountBindings(values: readonly RouteAccountBindingInput[], context: string): readonly RouteAccountBinding[] {
  return canonicalSet(values, routeAccountBinding, (value) => protocolIdKey(value.routeBindingId), context, true);
}

export function routeServiceCharge(
  input: RouteServiceChargeInput,
  context = 'routeServiceCharge',
): RouteServiceCharge {
  object(input, context);
  enumDiscriminant(FEE_CATEGORY, input.feeCategory, `${context}.feeCategory`);
  const atoms = signedI128(input.atoms, `${context}.atoms`);
  if (atoms === 0n) throw new MalformedInputError(`${context}.atoms`, 'charge is zero');
  return Object.freeze({
    feeCategory: input.feeCategory,
    asset: checkedAssetRef(input.asset, `${context}.asset`),
    atoms,
    recipientIdentity: protocolId(input.recipientIdentity, `${context}.recipientIdentity`),
    collectionAuthority: protocolId(input.collectionAuthority, `${context}.collectionAuthority`),
    collectionModeId: protocolId(input.collectionModeId, `${context}.collectionModeId`),
    ...(input.collectionActionSequence === undefined ? {} : { collectionActionSequence: numberValue(input.collectionActionSequence, U32_BITS, `${context}.collectionActionSequence`) }),
  });
}

export function encodeRouteServiceCharge(writer: CanonicalWriter, value: RouteServiceCharge): void {
  const checked = routeServiceCharge(value, 'routeServiceCharge');
  writer.writeEnum(FEE_CATEGORY, checked.feeCategory, 'routeServiceCharge.feeCategory');
  encodeAssetRef(writer, checked.asset);
  writer.writeI128(checked.atoms, 'routeServiceCharge.atoms');
  encodeProtocolId(writer, checked.recipientIdentity, 'routeServiceCharge.recipientIdentity');
  encodeProtocolId(writer, checked.collectionAuthority, 'routeServiceCharge.collectionAuthority');
  encodeProtocolId(writer, checked.collectionModeId, 'routeServiceCharge.collectionModeId');
  writer.writeOptional(checked.collectionActionSequence, (target, sequence) => target.writeU32(sequence), 'routeServiceCharge.collectionActionSequence');
}

function serviceChargeKey(value: RouteServiceCharge): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeEnum(FEE_CATEGORY, value.feeCategory);
    encodeAssetRef(writer, value.asset);
  });
}

function canonicalServiceCharges(values: readonly RouteServiceChargeInput[], context: string): readonly RouteServiceCharge[] {
  return canonicalSet(values, routeServiceCharge, serviceChargeKey, context, false);
}

export function legExecution(input: LegExecutionInput, context = 'legExecution'): LegExecution {
  object(input, context);
  enumDiscriminant(LEG_ROLE, input.legRole, `${context}.legRole`);
  enumDiscriminant(TRADE_SIDE, input.side, `${context}.side`);
  enumDiscriminant(PACKAGE_TIME_IN_FORCE, input.timeInForce, `${context}.timeInForce`);
  const baseAsset = checkedAssetRef(input.baseAsset, `${context}.baseAsset`);
  const quoteAsset = checkedAssetRef(input.quoteAsset, `${context}.quoteAsset`);
  const quantity = positiveAssetAmount(input.quantity, `${context}.quantity`);
  const limitPrice = checkedExactPrice(input.limitPrice, `${context}.limitPrice`);
  if (compareBytes(assetRefKey(quantity.asset), assetRefKey(baseAsset)) !== 0) {
    throw new MalformedInputError(`${context}.quantity.asset`, 'quantity asset must equal base asset');
  }
  if (
    compareBytes(assetRefKey(limitPrice.baseAsset), assetRefKey(baseAsset)) !== 0 ||
    compareBytes(assetRefKey(limitPrice.quoteAsset), assetRefKey(quoteAsset)) !== 0
  ) {
    throw new MalformedInputError(`${context}.limitPrice`, 'price assets must equal leg assets');
  }
  return Object.freeze({
    legIndex: numberValue(input.legIndex, U8_BITS, `${context}.legIndex`),
    legRole: input.legRole,
    actionSequence: numberValue(input.actionSequence, U32_BITS, `${context}.actionSequence`),
    adapter: checkedAdapterRef(input.adapter, `${context}.adapter`),
    venue: checkedVersionedRef(input.venue, `${context}.venue`),
    market: checkedVersionedRef(input.market, `${context}.market`),
    baseAsset,
    quoteAsset,
    side: input.side,
    quantity,
    limitPrice,
    timeInForce: input.timeInForce,
    reduceOnly: booleanValue(input.reduceOnly, `${context}.reduceOnly`),
  });
}

export function encodeLegExecution(writer: CanonicalWriter, value: LegExecution): void {
  const checked = legExecution(value, 'legExecution');
  writer.writeU8(checked.legIndex, 'legExecution.legIndex');
  writer.writeEnum(LEG_ROLE, checked.legRole, 'legExecution.legRole');
  writer.writeU32(checked.actionSequence, 'legExecution.actionSequence');
  encodeAdapterRef(writer, checked.adapter);
  encodeVersionedManifestRef(writer, checked.venue);
  encodeVersionedManifestRef(writer, checked.market);
  encodeAssetRef(writer, checked.baseAsset);
  encodeAssetRef(writer, checked.quoteAsset);
  writer.writeEnum(TRADE_SIDE, checked.side, 'legExecution.side');
  encodePositiveAssetAmount(writer, checked.quantity);
  encodeExactPrice(writer, checked.limitPrice);
  writer.writeEnum(PACKAGE_TIME_IN_FORCE, checked.timeInForce, 'legExecution.timeInForce');
  writer.writeBool(checked.reduceOnly, 'legExecution.reduceOnly');
}

export function actionAccountMeta(input: ActionAccountMetaInput, context = 'actionAccountMeta'): ActionAccountMeta {
  object(input, context);
  return Object.freeze({
    routeBindingId: protocolId(input.routeBindingId, `${context}.routeBindingId`),
    isSigner: booleanValue(input.isSigner, `${context}.isSigner`),
    isWritable: booleanValue(input.isWritable, `${context}.isWritable`),
  });
}

export function encodeActionAccountMeta(writer: CanonicalWriter, value: ActionAccountMeta): void {
  const checked = actionAccountMeta(value, 'actionAccountMeta');
  encodeProtocolId(writer, checked.routeBindingId, 'actionAccountMeta.routeBindingId');
  writer.writeBool(checked.isSigner, 'actionAccountMeta.isSigner');
  writer.writeBool(checked.isWritable, 'actionAccountMeta.isWritable');
}

function orderedAccountMetas(values: readonly ActionAccountMetaInput[], context: string): readonly ActionAccountMeta[] {
  if (!Array.isArray(values)) throw new MalformedInputError(context, 'expected an array');
  const seen = new Set<string>();
  return Object.freeze(values.map((value, index) => {
    const checked = actionAccountMeta(value, `${context}[${index}]`);
    if (seen.has(checked.routeBindingId)) {
      throw new DuplicateElementError(context, `duplicate route binding ${checked.routeBindingId}`);
    }
    seen.add(checked.routeBindingId);
    return checked;
  }));
}

export function lateBoundField(input: LateBoundFieldInput, context = 'lateBoundField'): LateBoundField {
  object(input, context);
  enumDiscriminant(LATE_BOUND_FIELD_KIND, input.kind, `${context}.kind`);
  const length = numberValue(input.length, U32_BITS, `${context}.length`);
  if (length === 0) throw new MalformedInputError(`${context}.length`, 'value is zero');
  return Object.freeze({
    kind: input.kind,
    offset: numberValue(input.offset, U32_BITS, `${context}.offset`),
    length,
  });
}

export function encodeLateBoundField(writer: CanonicalWriter, value: LateBoundField): void {
  const checked = lateBoundField(value, 'lateBoundField');
  writer.writeEnum(LATE_BOUND_FIELD_KIND, checked.kind, 'lateBoundField.kind');
  writer.writeU32(checked.offset, 'lateBoundField.offset');
  writer.writeU32(checked.length, 'lateBoundField.length');
}

function orderedLateBoundFields(
  values: readonly LateBoundFieldInput[],
  templateLength: number,
  context: string,
): readonly LateBoundField[] {
  if (!Array.isArray(values)) throw new MalformedInputError(context, 'expected an array');
  const checked = values.map((value, index) => lateBoundField(value, `${context}[${index}]`));
  checked.sort((left, right) => left.offset - right.offset);
  let end = 0;
  for (const field of checked) {
    if (field.offset < end) throw new MalformedInputError(context, 'late-bound ranges overlap');
    const fieldEnd = field.offset + field.length;
    if (!Number.isSafeInteger(fieldEnd) || fieldEnd > templateLength) {
      throw new MalformedInputError(context, 'late-bound range is outside template');
    }
    end = fieldEnd;
  }
  return Object.freeze(checked);
}

export function payloadTemplateHash(
  payload: Uint8Array,
  lateBoundFields: readonly LateBoundFieldInput[],
): CommitmentHash {
  if (!(payload instanceof Uint8Array)) {
    throw new MalformedInputError('payloadTemplateHash.payload', 'expected canonical bytes');
  }
  const templateLength = numberValue(payload.length, U32_BITS, 'payloadTemplateHash.payload.length');
  const fields = orderedLateBoundFields(lateBoundFields, templateLength, 'payloadTemplateHash.lateBoundFields');
  const template = Uint8Array.from(payload);
  for (const field of fields) template.fill(0, field.offset, field.offset + field.length);
  return commitmentHash(sha256(template), 'payloadTemplateHash');
}

export function payloadTemplateCommitment(
  input: PayloadTemplateCommitmentInput,
  context = 'payloadTemplateCommitment',
): PayloadTemplateCommitment {
  object(input, context);
  const templateLength = numberValue(input.templateLength, U32_BITS, `${context}.templateLength`);
  const templateHash = commitmentHash(input.templateHash, `${context}.templateHash`);
  return Object.freeze({
    codecId: protocolId(input.codecId, `${context}.codecId`),
    templateLength,
    get templateHash(): CommitmentHash {
      return commitmentHash(templateHash, `${context}.templateHash`);
    },
    lateBoundFields: orderedLateBoundFields(input.lateBoundFields, templateLength, `${context}.lateBoundFields`),
  });
}

export function encodePayloadTemplateCommitment(writer: CanonicalWriter, value: PayloadTemplateCommitment): void {
  requireCanonicalHash(value.templateHash, 'payloadTemplateCommitment.templateHash');
  const checked = payloadTemplateCommitment(value, 'payloadTemplateCommitment');
  encodeProtocolId(writer, checked.codecId, 'payloadTemplateCommitment.codecId');
  writer.writeU32(checked.templateLength, 'payloadTemplateCommitment.templateLength');
  encodeCommitmentHash(writer, checked.templateHash, 'payloadTemplateCommitment.templateHash');
  writer.writeArray(checked.lateBoundFields, encodeLateBoundField, 'payloadTemplateCommitment.lateBoundFields');
}

export function actionCommitment(input: ActionCommitmentInput, context = 'actionCommitment'): ActionCommitment {
  object(input, context);
  return Object.freeze({
    sequence: numberValue(input.sequence, U32_BITS, `${context}.sequence`),
    actionClassId: protocolId(input.actionClassId, `${context}.actionClassId`),
    ...(input.legIndex === undefined ? {} : { legIndex: numberValue(input.legIndex, U8_BITS, `${context}.legIndex`) }),
    ...(input.adapter === undefined ? {} : { adapter: checkedAdapterRef(input.adapter, `${context}.adapter`) }),
    targetBindingId: protocolId(input.targetBindingId, `${context}.targetBindingId`),
    authorityBindingId: protocolId(input.authorityBindingId, `${context}.authorityBindingId`),
    accountMetas: orderedAccountMetas(input.accountMetas, `${context}.accountMetas`),
    ...(input.nativeValue === undefined ? {} : { nativeValue: nativeAssetValue(input.nativeValue, `${context}.nativeValue`) }),
    payload: payloadTemplateCommitment(input.payload, `${context}.payload`),
    ...(input.feeRecipientBindingId === undefined ? {} : { feeRecipientBindingId: protocolId(input.feeRecipientBindingId, `${context}.feeRecipientBindingId`) }),
  });
}

export function encodeActionCommitment(writer: CanonicalWriter, value: ActionCommitment): void {
  const checked = actionCommitment(value, 'actionCommitment');
  writer.writeU32(checked.sequence, 'actionCommitment.sequence');
  encodeProtocolId(writer, checked.actionClassId, 'actionCommitment.actionClassId');
  writer.writeOptional(checked.legIndex, (target, index) => target.writeU8(index), 'actionCommitment.legIndex');
  writer.writeOptional(checked.adapter, encodeAdapterRef, 'actionCommitment.adapter');
  encodeProtocolId(writer, checked.targetBindingId, 'actionCommitment.targetBindingId');
  encodeProtocolId(writer, checked.authorityBindingId, 'actionCommitment.authorityBindingId');
  writer.writeArray(checked.accountMetas, encodeActionAccountMeta, 'actionCommitment.accountMetas');
  writer.writeOptional(checked.nativeValue, encodeNativeAssetValue, 'actionCommitment.nativeValue');
  encodePayloadTemplateCommitment(writer, checked.payload);
  writer.writeOptional(checked.feeRecipientBindingId, (target, id) => encodeProtocolId(target, id), 'actionCommitment.feeRecipientBindingId');
}

export function stateValue(input: StateValueInput, context = 'stateValue'): StateValue {
  object(input, context);
  enumDiscriminant(STATE_VALUE_KIND, input.kind, `${context}.kind`);
  switch (input.kind) {
    case 'SIGNED_ASSET_AMOUNT':
      return Object.freeze({ kind: input.kind, value: checkedAssetAmount(input.value, `${context}.value`) });
    case 'UNSIGNED_U256':
      return Object.freeze({ kind: input.kind, value: bigintValue(input.value, U256_BITS, `${context}.value`) });
    case 'COMMITMENT_HASH': {
      const value = commitmentHash(input.value, `${context}.value`);
      return Object.freeze({ kind: input.kind, get value(): CommitmentHash { return commitmentHash(value, `${context}.value`); } });
    }
    case 'PROTOCOL_ID':
      return Object.freeze({ kind: input.kind, value: protocolId(input.value, `${context}.value`) });
    case 'BOOLEAN':
      return Object.freeze({ kind: input.kind, value: booleanValue(input.value, `${context}.value`) });
  }
}

export function encodeStateValue(writer: CanonicalWriter, value: StateValue): void {
  if (value.kind === 'COMMITMENT_HASH') requireCanonicalHash(value.value, 'stateValue.value');
  if (value.kind === 'SIGNED_ASSET_AMOUNT') requireCanonicalAsset(value.value.asset, 'stateValue.value.asset');
  const checked = stateValue(value, 'stateValue');
  writer.writeEnum(STATE_VALUE_KIND, checked.kind, 'stateValue.kind');
  switch (checked.kind) {
    case 'SIGNED_ASSET_AMOUNT': encodeAssetAmount(writer, checked.value); break;
    case 'UNSIGNED_U256': writer.writeU256(checked.value, 'stateValue.value'); break;
    case 'COMMITMENT_HASH': encodeCommitmentHash(writer, checked.value, 'stateValue.value'); break;
    case 'PROTOCOL_ID': encodeProtocolId(writer, checked.value, 'stateValue.value'); break;
    case 'BOOLEAN': writer.writeBool(checked.value, 'stateValue.value'); break;
  }
}

export function stateConstraint(input: StateConstraintInput, context = 'stateConstraint'): StateConstraint {
  object(input, context);
  enumDiscriminant(COMPARATOR, input.comparator, `${context}.comparator`);
  return Object.freeze({
    constraintId: protocolId(input.constraintId, `${context}.constraintId`),
    ruleId: protocolId(input.ruleId, `${context}.ruleId`),
    accountBindingId: protocolId(input.accountBindingId, `${context}.accountBindingId`),
    componentId: protocolId(input.componentId, `${context}.componentId`),
    comparator: input.comparator,
    value: stateValue(input.value, `${context}.value`),
    evidenceRequirementId: protocolId(input.evidenceRequirementId, `${context}.evidenceRequirementId`),
  });
}

export function encodeStateConstraint(writer: CanonicalWriter, value: StateConstraint): void {
  const checked = stateConstraint(value, 'stateConstraint');
  encodeProtocolId(writer, checked.constraintId, 'stateConstraint.constraintId');
  encodeProtocolId(writer, checked.ruleId, 'stateConstraint.ruleId');
  encodeProtocolId(writer, checked.accountBindingId, 'stateConstraint.accountBindingId');
  encodeProtocolId(writer, checked.componentId, 'stateConstraint.componentId');
  writer.writeEnum(COMPARATOR, checked.comparator, 'stateConstraint.comparator');
  encodeStateValue(writer, checked.value);
  encodeProtocolId(writer, checked.evidenceRequirementId, 'stateConstraint.evidenceRequirementId');
}

function canonicalConstraints(values: readonly StateConstraintInput[], context: string): readonly StateConstraint[] {
  return canonicalSet(values, stateConstraint, (value) => protocolIdKey(value.constraintId), context, false);
}

function canonicalProtocolIds(values: readonly string[], context: string): readonly ProtocolId[] {
  return canonicalSet(values, (value, inner) => protocolId(value, inner), protocolIdKey, context, true);
}

export function evidenceRequirements(input: EvidenceRequirementsInput, context = 'evidenceRequirements'): EvidenceRequirements {
  object(input, context);
  const stateReferenceSchemaHash = manifestHash(input.stateReferenceSchemaHash, `${context}.stateReferenceSchemaHash`);
  const receiptSchemaHash = manifestHash(input.receiptSchemaHash, `${context}.receiptSchemaHash`);
  const outcomeSchemaHash = manifestHash(input.outcomeSchemaHash, `${context}.outcomeSchemaHash`);
  return Object.freeze({
    schemaVersion: nonzeroU32(input.schemaVersion, `${context}.schemaVersion`),
    profileId: protocolId(input.profileId, `${context}.profileId`),
    requiredPreStateComponentIds: canonicalProtocolIds(input.requiredPreStateComponentIds, `${context}.requiredPreStateComponentIds`),
    requiredPostStateComponentIds: canonicalProtocolIds(input.requiredPostStateComponentIds, `${context}.requiredPostStateComponentIds`),
    requiredActionEvidenceTypeIds: canonicalProtocolIds(input.requiredActionEvidenceTypeIds, `${context}.requiredActionEvidenceTypeIds`),
    get stateReferenceSchemaHash(): ManifestHash { return manifestHash(stateReferenceSchemaHash, `${context}.stateReferenceSchemaHash`); },
    get receiptSchemaHash(): ManifestHash { return manifestHash(receiptSchemaHash, `${context}.receiptSchemaHash`); },
    get outcomeSchemaHash(): ManifestHash { return manifestHash(outcomeSchemaHash, `${context}.outcomeSchemaHash`); },
  });
}

export function encodeEvidenceRequirements(writer: CanonicalWriter, value: EvidenceRequirements): void {
  requireCanonicalHash(value.stateReferenceSchemaHash, 'evidenceRequirements.stateReferenceSchemaHash');
  requireCanonicalHash(value.receiptSchemaHash, 'evidenceRequirements.receiptSchemaHash');
  requireCanonicalHash(value.outcomeSchemaHash, 'evidenceRequirements.outcomeSchemaHash');
  const checked = evidenceRequirements(value, 'evidenceRequirements');
  writer.writeU32(checked.schemaVersion, 'evidenceRequirements.schemaVersion');
  encodeProtocolId(writer, checked.profileId, 'evidenceRequirements.profileId');
  writer.writeArray(checked.requiredPreStateComponentIds, (target, id) => encodeProtocolId(target, id), 'evidenceRequirements.requiredPreStateComponentIds');
  writer.writeArray(checked.requiredPostStateComponentIds, (target, id) => encodeProtocolId(target, id), 'evidenceRequirements.requiredPostStateComponentIds');
  writer.writeArray(checked.requiredActionEvidenceTypeIds, (target, id) => encodeProtocolId(target, id), 'evidenceRequirements.requiredActionEvidenceTypeIds');
  encodeManifestHash(writer, checked.stateReferenceSchemaHash, 'evidenceRequirements.stateReferenceSchemaHash');
  encodeManifestHash(writer, checked.receiptSchemaHash, 'evidenceRequirements.receiptSchemaHash');
  encodeManifestHash(writer, checked.outcomeSchemaHash, 'evidenceRequirements.outcomeSchemaHash');
}

function canonicalMarketRefs(values: readonly VersionedManifestRef[], context: string): readonly VersionedManifestRef[] {
  return canonicalSet(values, checkedVersionedRef, versionedRefKey, context, true);
}

export function recoveryActionSlot(input: RecoveryActionSlotInput, context = 'recoveryActionSlot'): RecoveryActionSlot {
  object(input, context);
  enumDiscriminant(RECOVERY_ACTION, input.action, `${context}.action`);
  const cancel = input.action === 'CANCEL_OPEN_ORDERS';
  const hasTradeFields = input.maxQuantity !== undefined && input.limitPrice !== undefined && input.reduceOnly !== undefined && input.timeInForce !== undefined;
  if (cancel && (input.maxQuantity !== undefined || input.limitPrice !== undefined || input.reduceOnly !== undefined || input.timeInForce !== undefined)) {
    throw new MalformedInputError(context, 'cancel slot carries trade fields');
  }
  if (!cancel && !hasTradeFields) {
    throw new MalformedInputError(context, 'trade slot requires quantity, price, reduceOnly, and timeInForce');
  }
  if (!cancel && input.timeInForce !== 'IOC') {
    throw new MalformedInputError(`${context}.timeInForce`, 'recovery trade must use IOC');
  }
  return Object.freeze({
    sequence: numberValue(input.sequence, U32_BITS, `${context}.sequence`),
    action: input.action,
    targetLeg: numberValue(input.targetLeg, U8_BITS, `${context}.targetLeg`),
    adapter: checkedAdapterRef(input.adapter, `${context}.adapter`),
    markets: canonicalMarketRefs(input.markets, `${context}.markets`),
    ...(input.maxQuantity === undefined ? {} : { maxQuantity: positiveAssetAmount(input.maxQuantity, `${context}.maxQuantity`) }),
    ...(input.limitPrice === undefined ? {} : { limitPrice: checkedExactPrice(input.limitPrice, `${context}.limitPrice`) }),
    ...(input.reduceOnly === undefined ? {} : { reduceOnly: booleanValue(input.reduceOnly, `${context}.reduceOnly`) }),
    ...(input.timeInForce === undefined ? {} : { timeInForce: input.timeInForce }),
  });
}

export function encodeRecoveryActionSlot(writer: CanonicalWriter, value: RecoveryActionSlot): void {
  const checked = recoveryActionSlot(value, 'recoveryActionSlot');
  writer.writeU32(checked.sequence, 'recoveryActionSlot.sequence');
  writer.writeEnum(RECOVERY_ACTION, checked.action, 'recoveryActionSlot.action');
  writer.writeU8(checked.targetLeg, 'recoveryActionSlot.targetLeg');
  encodeAdapterRef(writer, checked.adapter);
  writer.writeArray(checked.markets, encodeVersionedManifestRef, 'recoveryActionSlot.markets');
  writer.writeOptional(checked.maxQuantity, encodePositiveAssetAmount, 'recoveryActionSlot.maxQuantity');
  writer.writeOptional(checked.limitPrice, encodeExactPrice, 'recoveryActionSlot.limitPrice');
  writer.writeOptional(checked.reduceOnly, (target, flag) => target.writeBool(flag), 'recoveryActionSlot.reduceOnly');
  writer.writeOptional(checked.timeInForce, (target, tif) => target.writeEnum(PACKAGE_TIME_IN_FORCE, tif), 'recoveryActionSlot.timeInForce');
}

function checkedFeeCap(value: FeeCap, context: string): FeeCap {
  object(value, context);
  const checked = feeCap(value, context);
  if (checked.maxAtoms < 0n) throw new MalformedInputError(`${context}.maxAtoms`, 'expected a nonnegative cap');
  return checked;
}

function canonicalRecoveryCaps(values: readonly FeeCap[], context: string): readonly FeeCap[] {
  return canonicalSet(values, checkedFeeCap, (value) => assetRefKey(value.asset), context, true);
}

export function recoveryPlan(input: RecoveryPlanInput, context = 'recoveryPlan'): RecoveryPlan {
  object(input, context);
  enumDiscriminant(EXPIRY_UNIT, input.recoveryExpiryUnit, `${context}.recoveryExpiryUnit`);
  const maxActionExpiryValue = bigintValue(input.maxActionExpiryValue, U64_BITS, `${context}.maxActionExpiryValue`);
  const deadlineValue = bigintValue(input.deadlineValue, U64_BITS, `${context}.deadlineValue`);
  const minRecoveryWindowMs = bigintValue(input.minRecoveryWindowMs, U64_BITS, `${context}.minRecoveryWindowMs`);
  if (minRecoveryWindowMs === 0n) throw new MalformedInputError(`${context}.minRecoveryWindowMs`, 'value is zero');
  const minRecoveryWindow = recoveryWindowInExpiryUnits(
    input.recoveryExpiryUnit,
    minRecoveryWindowMs,
  );
  if (maxActionExpiryValue >= deadlineValue || deadlineValue - maxActionExpiryValue < minRecoveryWindow) {
    throw new MalformedInputError(context, 'recovery timing window is too short');
  }
  if (!Array.isArray(input.actionSlots) || input.actionSlots.length === 0) {
    throw new MalformedInputError(`${context}.actionSlots`, 'array is empty');
  }
  const slots = Object.freeze(input.actionSlots.map((value, index) => {
    const checked = recoveryActionSlot(value, `${context}.actionSlots[${index}]`);
    if (checked.sequence !== index) throw new MalformedInputError(`${context}.actionSlots[${index}].sequence`, 'sequence must equal array position');
    return checked;
  }));
  const controllerCodeHash = manifestHash(input.controllerCodeHash, `${context}.controllerCodeHash`);
  const reconciledStateSchemaHash = manifestHash(input.reconciledStateSchemaHash, `${context}.reconciledStateSchemaHash`);
  const actionBuilderCodeHash = manifestHash(input.actionBuilderCodeHash, `${context}.actionBuilderCodeHash`);
  return Object.freeze({
    policyVersion: nonzeroU32(input.policyVersion, `${context}.policyVersion`),
    controllerId: protocolId(input.controllerId, `${context}.controllerId`),
    get controllerCodeHash(): ManifestHash { return manifestHash(controllerCodeHash, `${context}.controllerCodeHash`); },
    authorityModeId: protocolId(input.authorityModeId, `${context}.authorityModeId`),
    recoveryExpiryUnit: input.recoveryExpiryUnit,
    maxActionExpiryValue,
    deadlineValue,
    minRecoveryWindowMs,
    maxRecoveryCostCaps: canonicalRecoveryCaps(input.maxRecoveryCostCaps, `${context}.maxRecoveryCostCaps`),
    maxAggregateRecoveryLoss: unsignedAssetAmount(input.maxAggregateRecoveryLoss, `${context}.maxAggregateRecoveryLoss`),
    maxIntermediateResidual: unsignedAssetAmount(input.maxIntermediateResidual, `${context}.maxIntermediateResidual`),
    maxTerminalResidual: unsignedAssetAmount(input.maxTerminalResidual, `${context}.maxTerminalResidual`),
    get reconciledStateSchemaHash(): ManifestHash { return manifestHash(reconciledStateSchemaHash, `${context}.reconciledStateSchemaHash`); },
    get actionBuilderCodeHash(): ManifestHash { return manifestHash(actionBuilderCodeHash, `${context}.actionBuilderCodeHash`); },
    actionSlots: slots,
  });
}

export function encodeRecoveryPlan(writer: CanonicalWriter, value: RecoveryPlan): void {
  requireCanonicalHash(value.controllerCodeHash, 'recoveryPlan.controllerCodeHash');
  requireCanonicalHash(value.reconciledStateSchemaHash, 'recoveryPlan.reconciledStateSchemaHash');
  requireCanonicalHash(value.actionBuilderCodeHash, 'recoveryPlan.actionBuilderCodeHash');
  const checked = recoveryPlan(value, 'recoveryPlan');
  writer.writeU32(checked.policyVersion, 'recoveryPlan.policyVersion');
  encodeProtocolId(writer, checked.controllerId, 'recoveryPlan.controllerId');
  encodeManifestHash(writer, checked.controllerCodeHash, 'recoveryPlan.controllerCodeHash');
  encodeProtocolId(writer, checked.authorityModeId, 'recoveryPlan.authorityModeId');
  writer.writeEnum(EXPIRY_UNIT, checked.recoveryExpiryUnit, 'recoveryPlan.recoveryExpiryUnit');
  writer.writeU64(checked.maxActionExpiryValue, 'recoveryPlan.maxActionExpiryValue');
  writer.writeU64(checked.deadlineValue, 'recoveryPlan.deadlineValue');
  writer.writeU64(checked.minRecoveryWindowMs, 'recoveryPlan.minRecoveryWindowMs');
  writer.writeArray(checked.maxRecoveryCostCaps, encodeFeeCap, 'recoveryPlan.maxRecoveryCostCaps');
  encodeUnsignedAssetAmount(writer, checked.maxAggregateRecoveryLoss);
  encodeUnsignedAssetAmount(writer, checked.maxIntermediateResidual);
  encodeUnsignedAssetAmount(writer, checked.maxTerminalResidual);
  encodeManifestHash(writer, checked.reconciledStateSchemaHash, 'recoveryPlan.reconciledStateSchemaHash');
  encodeManifestHash(writer, checked.actionBuilderCodeHash, 'recoveryPlan.actionBuilderCodeHash');
  writer.writeArray(checked.actionSlots, encodeRecoveryActionSlot, 'recoveryPlan.actionSlots');
}

function orderedLegs(values: readonly LegExecutionInput[], context: string): readonly LegExecution[] {
  if (!Array.isArray(values) || values.length !== 2) throw new MalformedInputError(context, 'v1 requires exactly two legs');
  const checked = values.map((value, index) => {
    const leg = legExecution(value, `${context}[${index}]`);
    if (leg.legIndex !== index) throw new MalformedInputError(`${context}[${index}].legIndex`, 'leg index must equal array position');
    return leg;
  });
  if (checked.filter((leg) => leg.legRole === 'SPOT').length !== 1 || checked.filter((leg) => leg.legRole === 'PERPETUAL').length !== 1) {
    throw new MalformedInputError(context, 'v1 requires one spot and one perpetual leg');
  }
  return Object.freeze(checked);
}

function orderedActions(values: readonly ActionCommitmentInput[], context: string): readonly ActionCommitment[] {
  if (!Array.isArray(values) || values.length === 0) throw new MalformedInputError(context, 'array is empty');
  return Object.freeze(values.map((value, index) => {
    const action = actionCommitment(value, `${context}[${index}]`);
    if (action.sequence !== index) throw new MalformedInputError(`${context}[${index}].sequence`, 'sequence must equal array position');
    return action;
  }));
}

function validatePlanShape(input: RoutePayloadInput, context: string): void {
  const expectedClock = input.executionPlanKind === 'SVM_ATOMIC_CPI'
    ? 'SOLANA_SLOT'
    : input.executionPlanKind === 'EVM_ATOMIC_BATCH' || input.executionPlanKind === 'EVM_ASYNC_REQUEST'
      ? 'EVM_UNIX_SECONDS'
      : 'HYPERLIQUID_UNIX_MILLISECONDS';
  if (input.routeExpiryUnit !== expectedClock) {
    throw new MalformedInputError(
      `${context}.routeExpiryUnit`,
      `execution plan requires ${expectedClock}`,
    );
  }
  if (input.executionPlanKind === 'SVM_ATOMIC_CPI' || input.executionPlanKind === 'EVM_ATOMIC_BATCH') {
    if (input.settlementClass !== 'ATOMIC_POSTCONDITION' || input.quantityPolicyClass !== 'EXACT_ATOMIC' || input.recoveryPlan !== undefined) {
      throw new MalformedInputError(context, 'atomic plan shape is inconsistent');
    }
    return;
  }
  if (input.executionPlanKind === 'HYPERCORE_BATCHED_IOC') {
    if (input.settlementClass !== 'BATCHED_IOC_WITH_RECOVERY' || input.quantityPolicyClass === 'EXACT_ATOMIC' || input.recoveryPlan === undefined) {
      throw new MalformedInputError(context, 'HyperCore plan shape is inconsistent');
    }
    return;
  }
  if (input.settlementClass !== 'ASYNC_BONDED_SOLVER' || input.quantityPolicyClass === 'EXACT_ATOMIC' || input.recoveryPlan === undefined) {
    throw new MalformedInputError(context, 'EVM asynchronous plan shape is inconsistent');
  }
}

function recoveryWindowInExpiryUnits(
  recoveryExpiryUnit: ExpiryUnit,
  minRecoveryWindowMs: bigint,
): bigint {
  if (recoveryExpiryUnit === 'HYPERLIQUID_UNIX_MILLISECONDS') return minRecoveryWindowMs;
  if (recoveryExpiryUnit === 'EVM_UNIX_SECONDS') {
    if (minRecoveryWindowMs % 1_000n !== 0n) {
      throw new MalformedInputError(
        'routePayload.recoveryPlan.minRecoveryWindowMs',
        'EVM recovery window must be an exact number of seconds',
      );
    }
    return minRecoveryWindowMs / 1_000n;
  }
  throw new MalformedInputError(
    'routePayload.recoveryPlan.recoveryExpiryUnit',
    'unsupported recovery expiry unit',
  );
}

function validateRecoveryClock(route: RoutePayload): void {
  if (route.recoveryPlan === undefined) return;
  const expectedUnit = route.executionPlanKind === 'EVM_ASYNC_REQUEST'
    ? 'EVM_UNIX_SECONDS'
    : 'HYPERLIQUID_UNIX_MILLISECONDS';
  if (route.recoveryPlan.recoveryExpiryUnit !== expectedUnit) {
    throw new MalformedInputError(
      'routePayload.recoveryPlan.recoveryExpiryUnit',
      `execution plan requires ${expectedUnit}`,
    );
  }
  const recoveryWindow = recoveryWindowInExpiryUnits(
    route.recoveryPlan.recoveryExpiryUnit,
    route.recoveryPlan.minRecoveryWindowMs,
  );
  if (route.routeExpiryValue + recoveryWindow > route.recoveryPlan.deadlineValue) {
    throw new MalformedInputError(
      'routePayload.recoveryPlan',
      'route expiry leaves insufficient recovery window',
    );
  }
}

function validateReferences(route: RoutePayload): void {
  const bindingIds = new Set(route.accountBindings.map((binding) => binding.routeBindingId));
  const used = new Set<string>();
  const requireBinding = (id: ProtocolId, context: string): void => {
    if (!bindingIds.has(id)) throw new MalformedInputError(context, `unknown route binding ${id}`);
    used.add(id);
  };
  for (const action of route.actions) {
    requireBinding(action.targetBindingId, 'routePayload.actions.targetBindingId');
    requireBinding(action.authorityBindingId, 'routePayload.actions.authorityBindingId');
    if (action.feeRecipientBindingId !== undefined) requireBinding(action.feeRecipientBindingId, 'routePayload.actions.feeRecipientBindingId');
    for (const meta of action.accountMetas) requireBinding(meta.routeBindingId, 'routePayload.actions.accountMetas.routeBindingId');
    if (action.legIndex !== undefined && action.legIndex >= route.legs.length) throw new MalformedInputError('routePayload.actions.legIndex', 'unknown leg index');
  }
  for (const constraint of [...route.preconditions, ...route.postconditions]) requireBinding(constraint.accountBindingId, 'routePayload.constraints.accountBindingId');
  for (const binding of route.accountBindings) {
    if (!used.has(binding.routeBindingId)) throw new MalformedInputError('routePayload.accountBindings', `unused route binding ${binding.routeBindingId}`);
  }
  for (const leg of route.legs) {
    if (leg.actionSequence >= route.actions.length) throw new MalformedInputError('routePayload.legs.actionSequence', 'unknown action sequence');
  }
  for (const charge of route.serviceCharges) {
    if (charge.collectionActionSequence !== undefined && charge.collectionActionSequence >= route.actions.length) throw new MalformedInputError('routePayload.serviceCharges.collectionActionSequence', 'unknown action sequence');
  }
  if (route.recoveryPlan !== undefined) {
    validateRecoveryClock(route);
    for (const slot of route.recoveryPlan.actionSlots) {
      if (slot.targetLeg >= route.legs.length) throw new MalformedInputError('routePayload.recoveryPlan.actionSlots.targetLeg', 'unknown leg index');
      const target = route.legs[slot.targetLeg] as LegExecution;
      if (slot.maxQuantity !== undefined && compareBytes(assetRefKey(slot.maxQuantity.asset), assetRefKey(target.baseAsset)) !== 0) {
        throw new MalformedInputError('routePayload.recoveryPlan.actionSlots.maxQuantity.asset', 'quantity asset must equal target leg base asset');
      }
      if (slot.limitPrice !== undefined && (
        compareBytes(assetRefKey(slot.limitPrice.baseAsset), assetRefKey(target.baseAsset)) !== 0 ||
        compareBytes(assetRefKey(slot.limitPrice.quoteAsset), assetRefKey(target.quoteAsset)) !== 0
      )) {
        throw new MalformedInputError('routePayload.recoveryPlan.actionSlots.limitPrice', 'price assets must equal target leg assets');
      }
    }
  }
}

export function routePayload(input: RoutePayloadInput, context = 'routePayload'): RoutePayload {
  object(input, context);
  if (numberValue(input.version, U32_BITS, `${context}.version`) !== ROUTE_VERSION) throw new MalformedInputError(`${context}.version`, 'version must equal 1');
  enumDiscriminant(DIRECTION, input.direction, `${context}.direction`);
  enumDiscriminant(PACKAGE_ACTION, input.action, `${context}.action`);
  enumDiscriminant(QUANTITY_POLICY_CLASS, input.quantityPolicyClass, `${context}.quantityPolicyClass`);
  enumDiscriminant(PARTIAL_FILL_POLICY, input.partialFillPolicy, `${context}.partialFillPolicy`);
  enumDiscriminant(SETTLEMENT_CLASS, input.settlementClass, `${context}.settlementClass`);
  enumDiscriminant(EXECUTION_PLAN_KIND, input.executionPlanKind, `${context}.executionPlanKind`);
  enumDiscriminant(EXPIRY_UNIT, input.routeExpiryUnit, `${context}.routeExpiryUnit`);
  validatePlanShape(input, context);
  const orderHash = commitmentHash(input.orderHash, `${context}.orderHash`);
  const packageTemplateManifestHash = manifestHash(input.packageTemplateManifestHash, `${context}.packageTemplateManifestHash`);
  const templateRegistryRecordHash = commitmentHash(input.templateRegistryRecordHash, `${context}.templateRegistryRecordHash`);
  const feePolicyManifestHash = manifestHash(input.feePolicyManifestHash, `${context}.feePolicyManifestHash`);
  const route = Object.freeze({
    version: 1 as const,
    environment: protocolId(input.environment, `${context}.environment`),
    domain: checkedDomainRef(input.domain, `${context}.domain`),
    get orderHash(): CommitmentHash { return commitmentHash(orderHash, `${context}.orderHash`); },
    templateId: protocolId(input.templateId, `${context}.templateId`),
    templateVersion: nonzeroU32(input.templateVersion, `${context}.templateVersion`),
    get packageTemplateManifestHash(): ManifestHash { return manifestHash(packageTemplateManifestHash, `${context}.packageTemplateManifestHash`); },
    get templateRegistryRecordHash(): CommitmentHash { return commitmentHash(templateRegistryRecordHash, `${context}.templateRegistryRecordHash`); },
    owner: protocolId(input.owner, `${context}.owner`),
    settlementAccount: protocolId(input.settlementAccount, `${context}.settlementAccount`),
    solver: protocolId(input.solver, `${context}.solver`),
    direction: input.direction,
    action: input.action,
    quantityPolicyClass: input.quantityPolicyClass,
    partialFillPolicy: input.partialFillPolicy,
    settlementClass: input.settlementClass,
    executionPlanKind: input.executionPlanKind,
    routeExpiryUnit: input.routeExpiryUnit,
    routeExpiryValue: bigintValue(input.routeExpiryValue, U64_BITS, `${context}.routeExpiryValue`),
    feePolicyVersion: nonzeroU32(input.feePolicyVersion, `${context}.feePolicyVersion`),
    get feePolicyManifestHash(): ManifestHash { return manifestHash(feePolicyManifestHash, `${context}.feePolicyManifestHash`); },
    accountBindings: canonicalAccountBindings(input.accountBindings, `${context}.accountBindings`),
    serviceCharges: canonicalServiceCharges(input.serviceCharges, `${context}.serviceCharges`),
    preconditions: canonicalConstraints(input.preconditions, `${context}.preconditions`),
    legs: orderedLegs(input.legs, `${context}.legs`),
    actions: orderedActions(input.actions, `${context}.actions`),
    postconditions: canonicalConstraints(input.postconditions, `${context}.postconditions`),
    evidenceRequirements: evidenceRequirements(input.evidenceRequirements, `${context}.evidenceRequirements`),
    ...(input.recoveryPlan === undefined ? {} : { recoveryPlan: recoveryPlan(input.recoveryPlan, `${context}.recoveryPlan`) }),
  });
  if (route.executionPlanKind === 'HYPERCORE_BATCHED_IOC' && route.legs.some((leg) => leg.timeInForce !== 'IOC')) {
    throw new MalformedInputError(`${context}.legs`, 'HyperCore legs must use IOC');
  }
  validateReferences(route);
  return route;
}

function assertCanonicalRoutePayload(value: RoutePayload): void {
  object(value, 'routePayload');
  requireCanonicalHash(value.domain.domainManifestHash, 'routePayload.domain.domainManifestHash');
  requireCanonicalHash(value.orderHash, 'routePayload.orderHash');
  requireCanonicalHash(value.packageTemplateManifestHash, 'routePayload.packageTemplateManifestHash');
  requireCanonicalHash(value.templateRegistryRecordHash, 'routePayload.templateRegistryRecordHash');
  requireCanonicalHash(value.feePolicyManifestHash, 'routePayload.feePolicyManifestHash');
  value.accountBindings.forEach((binding, index) => {
    if (binding.adapter !== undefined) requireCanonicalAdapter(binding.adapter, `routePayload.accountBindings[${index}].adapter`);
  });
  value.serviceCharges.forEach((charge, index) => requireCanonicalAsset(charge.asset, `routePayload.serviceCharges[${index}].asset`));
  value.legs.forEach((leg, index) => {
    requireCanonicalAdapter(leg.adapter, `routePayload.legs[${index}].adapter`);
    requireCanonicalVersionedRef(leg.venue, `routePayload.legs[${index}].venue`);
    requireCanonicalVersionedRef(leg.market, `routePayload.legs[${index}].market`);
    requireCanonicalAsset(leg.baseAsset, `routePayload.legs[${index}].baseAsset`);
    requireCanonicalAsset(leg.quoteAsset, `routePayload.legs[${index}].quoteAsset`);
    requireCanonicalAsset(leg.quantity.asset, `routePayload.legs[${index}].quantity.asset`);
    requireCanonicalPrice(leg.limitPrice, `routePayload.legs[${index}].limitPrice`);
  });
  value.actions.forEach((action, index) => {
    if (action.adapter !== undefined) requireCanonicalAdapter(action.adapter, `routePayload.actions[${index}].adapter`);
    if (action.nativeValue !== undefined) requireCanonicalAsset(action.nativeValue.asset, `routePayload.actions[${index}].nativeValue.asset`);
    requireCanonicalHash(action.payload.templateHash, `routePayload.actions[${index}].payload.templateHash`);
  });
  for (const [index, constraint] of [...value.preconditions, ...value.postconditions].entries()) {
    if (constraint.value.kind === 'COMMITMENT_HASH') requireCanonicalHash(constraint.value.value, `routePayload.constraints[${index}].value`);
    if (constraint.value.kind === 'SIGNED_ASSET_AMOUNT') requireCanonicalAsset(constraint.value.value.asset, `routePayload.constraints[${index}].value.asset`);
  }
  requireCanonicalHash(value.evidenceRequirements.stateReferenceSchemaHash, 'routePayload.evidenceRequirements.stateReferenceSchemaHash');
  requireCanonicalHash(value.evidenceRequirements.receiptSchemaHash, 'routePayload.evidenceRequirements.receiptSchemaHash');
  requireCanonicalHash(value.evidenceRequirements.outcomeSchemaHash, 'routePayload.evidenceRequirements.outcomeSchemaHash');
  if (value.recoveryPlan !== undefined) {
    const recovery = value.recoveryPlan;
    requireCanonicalHash(recovery.controllerCodeHash, 'routePayload.recoveryPlan.controllerCodeHash');
    requireCanonicalHash(recovery.reconciledStateSchemaHash, 'routePayload.recoveryPlan.reconciledStateSchemaHash');
    requireCanonicalHash(recovery.actionBuilderCodeHash, 'routePayload.recoveryPlan.actionBuilderCodeHash');
    recovery.maxRecoveryCostCaps.forEach((cap, index) => requireCanonicalAsset(cap.asset, `routePayload.recoveryPlan.maxRecoveryCostCaps[${index}].asset`));
    requireCanonicalAsset(recovery.maxAggregateRecoveryLoss.asset, 'routePayload.recoveryPlan.maxAggregateRecoveryLoss.asset');
    requireCanonicalAsset(recovery.maxIntermediateResidual.asset, 'routePayload.recoveryPlan.maxIntermediateResidual.asset');
    requireCanonicalAsset(recovery.maxTerminalResidual.asset, 'routePayload.recoveryPlan.maxTerminalResidual.asset');
    recovery.actionSlots.forEach((slot, index) => {
      requireCanonicalAdapter(slot.adapter, `routePayload.recoveryPlan.actionSlots[${index}].adapter`);
      slot.markets.forEach((market, marketIndex) => requireCanonicalVersionedRef(market, `routePayload.recoveryPlan.actionSlots[${index}].markets[${marketIndex}]`));
      if (slot.maxQuantity !== undefined) requireCanonicalAsset(slot.maxQuantity.asset, `routePayload.recoveryPlan.actionSlots[${index}].maxQuantity.asset`);
      if (slot.limitPrice !== undefined) requireCanonicalPrice(slot.limitPrice, `routePayload.recoveryPlan.actionSlots[${index}].limitPrice`);
    });
  }
}

export function encodeRoutePayload(writer: CanonicalWriter, value: RoutePayload): void {
  assertCanonicalRoutePayload(value);
  const checked = routePayload(value, 'routePayload');
  writer.writeU32(checked.version, 'routePayload.version');
  encodeProtocolId(writer, checked.environment, 'routePayload.environment');
  encodeDomainRef(writer, checked.domain);
  encodeCommitmentHash(writer, checked.orderHash, 'routePayload.orderHash');
  encodeProtocolId(writer, checked.templateId, 'routePayload.templateId');
  writer.writeU32(checked.templateVersion, 'routePayload.templateVersion');
  encodeManifestHash(writer, checked.packageTemplateManifestHash, 'routePayload.packageTemplateManifestHash');
  encodeCommitmentHash(writer, checked.templateRegistryRecordHash, 'routePayload.templateRegistryRecordHash');
  encodeProtocolId(writer, checked.owner, 'routePayload.owner');
  encodeProtocolId(writer, checked.settlementAccount, 'routePayload.settlementAccount');
  encodeProtocolId(writer, checked.solver, 'routePayload.solver');
  writer.writeEnum(DIRECTION, checked.direction, 'routePayload.direction');
  writer.writeEnum(PACKAGE_ACTION, checked.action, 'routePayload.action');
  writer.writeEnum(QUANTITY_POLICY_CLASS, checked.quantityPolicyClass, 'routePayload.quantityPolicyClass');
  writer.writeEnum(PARTIAL_FILL_POLICY, checked.partialFillPolicy, 'routePayload.partialFillPolicy');
  writer.writeEnum(SETTLEMENT_CLASS, checked.settlementClass, 'routePayload.settlementClass');
  writer.writeEnum(EXECUTION_PLAN_KIND, checked.executionPlanKind, 'routePayload.executionPlanKind');
  writer.writeEnum(EXPIRY_UNIT, checked.routeExpiryUnit, 'routePayload.routeExpiryUnit');
  writer.writeU64(checked.routeExpiryValue, 'routePayload.routeExpiryValue');
  writer.writeU32(checked.feePolicyVersion, 'routePayload.feePolicyVersion');
  encodeManifestHash(writer, checked.feePolicyManifestHash, 'routePayload.feePolicyManifestHash');
  writer.writeArray(checked.accountBindings, encodeRouteAccountBinding, 'routePayload.accountBindings');
  writer.writeArray(checked.serviceCharges, encodeRouteServiceCharge, 'routePayload.serviceCharges');
  writer.writeArray(checked.preconditions, encodeStateConstraint, 'routePayload.preconditions');
  writer.writeArray(checked.legs, encodeLegExecution, 'routePayload.legs');
  writer.writeArray(checked.actions, encodeActionCommitment, 'routePayload.actions');
  writer.writeArray(checked.postconditions, encodeStateConstraint, 'routePayload.postconditions');
  encodeEvidenceRequirements(writer, checked.evidenceRequirements);
  writer.writeOptional(checked.recoveryPlan, encodeRecoveryPlan, 'routePayload.recoveryPlan');
}

export function routePayloadBytes(value: RoutePayloadInput): Uint8Array {
  const checked = routePayload(value);
  return canonicalBytes((writer) => encodeRoutePayload(writer, checked));
}

export function routeHash(value: RoutePayloadInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.ROUTE, routePayloadBytes(value), 'routeHash'), 'routeHash');
}

export function routeAccountsHash(value: RoutePayloadInput): CommitmentHash {
  const checked = routePayload(value);
  const payload = canonicalBytes((writer) => writer.writeArray(checked.accountBindings, encodeRouteAccountBinding, 'routePayload.accountBindings'));
  return commitmentHash(domainHash(HASH_DOMAIN.ROUTE_ACCOUNTS, payload, 'routeAccountsHash'), 'routeAccountsHash');
}
