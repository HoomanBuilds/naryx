import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  ROUNDING_DIRECTION,
  type RoundingDirection,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import {
  assetRef,
  encodeAssetRef,
  encodeManifestHash,
  encodeProtocolId,
  hash32,
  manifestHash,
  protocolId,
  type AssetRef,
  type Hash32,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const U32_BITS = 32;
const U128_BITS = 128;
const I128_BITS = 128;

export type CommitmentHash = Hash32 & { readonly __commitmentHash: true };

export interface ExactPriceInput {
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly quoteAtoms: bigint;
  readonly baseAtoms: bigint;
  readonly roundingDirection: RoundingDirection;
}

export interface ExactPrice {
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly quoteAtoms: bigint;
  readonly baseAtoms: bigint;
  readonly roundingDirection: RoundingDirection;
}

export interface ExactSignedRateInput {
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly quoteAtoms: bigint;
  readonly baseAtoms: bigint;
  readonly roundingDirection: RoundingDirection;
}

export interface ExactSignedRate {
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly quoteAtoms: bigint;
  readonly baseAtoms: bigint;
  readonly roundingDirection: RoundingDirection;
}

export interface AdapterRefInput {
  readonly adapterId: string;
  readonly adapterManifestVersion: number;
  readonly adapterManifestHash: Uint8Array | string;
}

export interface AdapterRef {
  readonly adapterId: ProtocolId;
  readonly adapterManifestVersion: number;
  readonly adapterManifestHash: ManifestHash;
}

export interface FeeCapInput {
  readonly asset: AssetRef;
  readonly maxAtoms: bigint;
}

export interface FeeCap {
  readonly asset: AssetRef;
  readonly maxAtoms: bigint;
}

interface CanonicalEntry<T> {
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

function checkedBigInt(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  return value;
}

function positiveU128(value: bigint, context: string): bigint {
  const checked = checkedUnsigned(checkedBigInt(value, context), U128_BITS, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'value is zero');
  }
  return checked;
}

function signedI128(value: bigint, context: string): bigint {
  return checkedSigned(checkedBigInt(value, context), I128_BITS, context);
}

function checkedRounding(
  value: RoundingDirection,
  context: string,
): RoundingDirection {
  enumDiscriminant(ROUNDING_DIRECTION, value, context);
  return value;
}

function encodeRounding(
  writer: CanonicalWriter,
  value: RoundingDirection,
  context: string,
): void {
  const checked = checkedRounding(value, context);
  writer.writeEnum(ROUNDING_DIRECTION, checked, context);
}

function checkedAssetRef(value: AssetRef, context: string): AssetRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an asset reference object');
  }
  if (!(value.assetManifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(
      `${context}.assetManifestHash`,
      'expected 32 canonical bytes',
    );
  }
  if (typeof value.decimals !== 'number') {
    throw new MalformedInputError(`${context}.decimals`, 'expected a number');
  }
  return assetRef(
    value.assetId,
    value.assetManifestHash,
    value.decimals,
    context,
  );
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let first = left < 0n ? -left : left;
  let second = right;
  while (second !== 0n) {
    const remainder = first % second;
    first = second;
    second = remainder;
  }
  return first;
}

function requireReduced(numerator: bigint, denominator: bigint, context: string): void {
  if (greatestCommonDivisor(numerator, denominator) !== 1n) {
    throw new MalformedInputError(context, 'fraction is not in lowest terms');
  }
}

export function commitmentHash(
  value: Uint8Array | string,
  context = 'commitmentHash',
): CommitmentHash {
  const checked = hash32(value, context);
  if (checked.every((byte) => byte === 0)) {
    throw new MalformedInputError(context, 'commitment hash is all zero');
  }
  return checked as CommitmentHash;
}

function checkedCommitmentHash(value: CommitmentHash, context: string): CommitmentHash {
  if (!(value instanceof Uint8Array)) {
    throw new MalformedInputError(context, 'expected 32 canonical bytes');
  }
  return commitmentHash(value, context);
}

export function encodeCommitmentHash(
  writer: CanonicalWriter,
  value: CommitmentHash,
  context = 'commitmentHash',
): void {
  writer.writeFixedBytes(checkedCommitmentHash(value, context), 32, context);
}

export function exactPrice(
  input: ExactPriceInput,
  context = 'exactPrice',
): ExactPrice {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an exact price object');
  }
  const quoteAtoms = positiveU128(input.quoteAtoms, `${context}.quoteAtoms`);
  const baseAtoms = positiveU128(input.baseAtoms, `${context}.baseAtoms`);
  requireReduced(quoteAtoms, baseAtoms, context);
  return Object.freeze({
    baseAsset: checkedAssetRef(input.baseAsset, `${context}.baseAsset`),
    quoteAsset: checkedAssetRef(input.quoteAsset, `${context}.quoteAsset`),
    quoteAtoms,
    baseAtoms,
    roundingDirection: checkedRounding(
      input.roundingDirection,
      `${context}.roundingDirection`,
    ),
  });
}

function checkedExactPrice(value: ExactPrice, context: string): ExactPrice {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an exact price object');
  }
  return exactPrice(value, context);
}

export function encodeExactPrice(writer: CanonicalWriter, value: ExactPrice): void {
  const checked = checkedExactPrice(value, 'exactPrice');
  encodeAssetRef(writer, checked.baseAsset);
  encodeAssetRef(writer, checked.quoteAsset);
  writer.writeU128(checked.quoteAtoms, 'exactPrice.quoteAtoms');
  writer.writeU128(checked.baseAtoms, 'exactPrice.baseAtoms');
  encodeRounding(writer, checked.roundingDirection, 'exactPrice.roundingDirection');
}

export function exactSignedRate(
  input: ExactSignedRateInput,
  context = 'exactSignedRate',
): ExactSignedRate {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an exact signed rate object');
  }
  const quoteAtoms = signedI128(input.quoteAtoms, `${context}.quoteAtoms`);
  const baseAtoms = positiveU128(input.baseAtoms, `${context}.baseAtoms`);
  if (quoteAtoms === 0n && baseAtoms !== 1n) {
    throw new MalformedInputError(context, 'zero rate must use denominator one');
  }
  requireReduced(quoteAtoms, baseAtoms, context);
  return Object.freeze({
    baseAsset: checkedAssetRef(input.baseAsset, `${context}.baseAsset`),
    quoteAsset: checkedAssetRef(input.quoteAsset, `${context}.quoteAsset`),
    quoteAtoms,
    baseAtoms,
    roundingDirection: checkedRounding(
      input.roundingDirection,
      `${context}.roundingDirection`,
    ),
  });
}

function checkedExactSignedRate(
  value: ExactSignedRate,
  context: string,
): ExactSignedRate {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an exact signed rate object');
  }
  return exactSignedRate(value, context);
}

export function encodeExactSignedRate(
  writer: CanonicalWriter,
  value: ExactSignedRate,
): void {
  const checked = checkedExactSignedRate(value, 'exactSignedRate');
  encodeAssetRef(writer, checked.baseAsset);
  encodeAssetRef(writer, checked.quoteAsset);
  writer.writeI128(checked.quoteAtoms, 'exactSignedRate.quoteAtoms');
  writer.writeU128(checked.baseAtoms, 'exactSignedRate.baseAtoms');
  encodeRounding(
    writer,
    checked.roundingDirection,
    'exactSignedRate.roundingDirection',
  );
}

function frozenAdapterRef(
  id: ProtocolId,
  version: number,
  capturedHash: ManifestHash,
): AdapterRef {
  return Object.freeze({
    adapterId: id,
    adapterManifestVersion: version,
    get adapterManifestHash(): ManifestHash {
      return Uint8Array.from(capturedHash) as ManifestHash;
    },
  });
}

export function adapterRef(
  input: AdapterRefInput,
  context = 'adapterRef',
): AdapterRef {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an adapter reference object');
  }
  return frozenAdapterRef(
    protocolId(input.adapterId, `${context}.adapterId`),
    nonzeroU32(input.adapterManifestVersion, `${context}.adapterManifestVersion`),
    manifestHash(input.adapterManifestHash, `${context}.adapterManifestHash`),
  );
}

function checkedAdapterRef(value: AdapterRef, context: string): AdapterRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an adapter reference object');
  }
  if (!(value.adapterManifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(
      `${context}.adapterManifestHash`,
      'expected 32 canonical bytes',
    );
  }
  return adapterRef(
    {
      adapterId: value.adapterId,
      adapterManifestVersion: value.adapterManifestVersion,
      adapterManifestHash: value.adapterManifestHash,
    },
    context,
  );
}

export function encodeAdapterRef(writer: CanonicalWriter, value: AdapterRef): void {
  const checked = checkedAdapterRef(value, 'adapterRef');
  encodeProtocolId(writer, checked.adapterId, 'adapterRef.adapterId');
  writer.writeU32(checked.adapterManifestVersion, 'adapterRef.adapterManifestVersion');
  encodeManifestHash(
    writer,
    checked.adapterManifestHash,
    'adapterRef.adapterManifestHash',
  );
}

export function feeCap(input: FeeCapInput, context = 'feeCap'): FeeCap {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a fee cap object');
  }
  return Object.freeze({
    asset: checkedAssetRef(input.asset, `${context}.asset`),
    maxAtoms: signedI128(input.maxAtoms, `${context}.maxAtoms`),
  });
}

function checkedFeeCap(value: FeeCap, context: string): FeeCap {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a fee cap object');
  }
  return feeCap(value, context);
}

export function encodeFeeCap(writer: CanonicalWriter, value: FeeCap): void {
  const checked = checkedFeeCap(value, 'feeCap');
  encodeAssetRef(writer, checked.asset);
  writer.writeI128(checked.maxAtoms, 'feeCap.maxAtoms');
}

function canonicalOrdered<T>(
  values: readonly T[],
  validate: (value: T, context: string) => T,
  keyBytes: (value: T) => Uint8Array,
  context: string,
  requireNonempty: boolean,
): readonly T[] {
  if (!Array.isArray(values)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  if (requireNonempty && values.length === 0) {
    throw new MalformedInputError(context, 'set is empty');
  }
  const entries: CanonicalEntry<T>[] = values.map((value, index) => {
    const checked = validate(value, `${context}[${index}]`);
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

function assetRefKeyBytes(value: AssetRef): Uint8Array {
  const checked = checkedAssetRef(value, 'assetRef');
  return canonicalBytes((writer) => encodeAssetRef(writer, checked));
}

function adapterRefKeyBytes(value: AdapterRef): Uint8Array {
  const checked = checkedAdapterRef(value, 'adapterRef');
  return canonicalBytes((writer) => encodeAdapterRef(writer, checked));
}

export function canonicalFeeCaps(
  values: readonly FeeCap[],
  context = 'feeCaps',
): readonly FeeCap[] {
  return canonicalOrdered(
    values,
    checkedFeeCap,
    (value) => assetRefKeyBytes(value.asset),
    context,
    false,
  );
}

export function canonicalAdapterRefs(
  values: readonly AdapterRef[],
  context = 'adapterRefs',
): readonly AdapterRef[] {
  return canonicalOrdered(
    values,
    checkedAdapterRef,
    adapterRefKeyBytes,
    context,
    true,
  );
}
