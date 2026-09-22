import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { fromHex } from './bytes.js';
import { CanonicalWriter } from './encoding.js';
import { EXPIRY_UNIT, type ExpiryUnit } from './enums.js';
import { IncompatibleUnitError, MalformedInputError } from './errors.js';
import { encodeUtf8 } from './text.js';

export const HASH_BYTE_LENGTH = 32;

export type Hash32 = Uint8Array & { readonly __brand: 'Hash32' };

export function hash32(value: Uint8Array | string, context = 'hash32'): Hash32 {
  const bytes = typeof value === 'string' ? fromHex(value, context) : value;
  if (!(bytes instanceof Uint8Array)) {
    throw new MalformedInputError(context, 'expected a Uint8Array or a hex string');
  }
  if (bytes.length !== HASH_BYTE_LENGTH) {
    throw new MalformedInputError(
      context,
      `expected ${HASH_BYTE_LENGTH} bytes, received ${bytes.length}`,
    );
  }
  return Uint8Array.from(bytes) as Hash32;
}

export function encodeHash32(writer: CanonicalWriter, value: Hash32): void {
  writer.writeFixedBytes(value, HASH_BYTE_LENGTH, 'hash32');
}

export type AssetId = string & { readonly __brand: 'AssetId' };

export function assetId(value: string, context = 'assetId'): AssetId {
  const encoded = encodeUtf8(value, context);
  if (encoded.length === 0) {
    throw new MalformedInputError(context, 'asset identifier is empty');
  }
  return value as AssetId;
}

export const ASSET_ATOM_BITS = 128;

export interface AssetAmount {
  readonly asset: AssetId;
  readonly decimals: number;
  readonly atoms: bigint;
}

export function assetAmount(
  asset: string,
  decimals: number,
  atoms: bigint,
  context = 'assetAmount',
): AssetAmount {
  if (typeof atoms !== 'bigint') {
    throw new MalformedInputError(`${context}.atoms`, 'expected a bigint atom amount');
  }
  return Object.freeze({
    asset: assetId(asset, `${context}.asset`),
    decimals: Number(checkedUnsigned(decimals, 8, `${context}.decimals`)),
    atoms: checkedSigned(atoms, ASSET_ATOM_BITS, `${context}.atoms`),
  });
}

// A runtime value reaching a public encoder is untrusted: it can be a plain object that never
// passed through the constructor, so every invariant is checked again before a byte is written.
function checkedAssetAmount(value: AssetAmount, context: string): AssetAmount {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an asset amount object');
  }
  return assetAmount(value.asset, value.decimals, value.atoms, context);
}

export function encodeAssetAmount(writer: CanonicalWriter, value: AssetAmount): void {
  const checked = checkedAssetAmount(value, 'assetAmount');
  writer.writeString(checked.asset, 'assetAmount.asset');
  writer.writeU8(checked.decimals, 'assetAmount.decimals');
  writer.writeI128(checked.atoms, 'assetAmount.atoms');
}

export const EXPIRY_VALUE_BITS = 64;

export interface Expiry {
  readonly unit: ExpiryUnit;
  readonly value: bigint;
}

export function expiry(unit: ExpiryUnit, value: bigint, context = 'expiry'): Expiry {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(`${context}.value`, 'expected a bigint expiry value');
  }
  if (!Object.prototype.hasOwnProperty.call(EXPIRY_UNIT, unit)) {
    throw new MalformedInputError(`${context}.unit`, `unknown expiry unit ${String(unit)}`);
  }
  return Object.freeze({
    unit,
    value: checkedUnsigned(value, EXPIRY_VALUE_BITS, `${context}.value`),
  });
}

function checkedExpiry(value: Expiry, context: string): Expiry {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an expiry object');
  }
  return expiry(value.unit, value.value, context);
}

export function encodeExpiry(writer: CanonicalWriter, value: Expiry): void {
  const checked = checkedExpiry(value, 'expiry');
  writer.writeEnum(EXPIRY_UNIT, checked.unit, 'expiry.unit');
  writer.writeU64(checked.value, 'expiry.value');
}

export function compareExpiry(left: Expiry, right: Expiry, context = 'compareExpiry'): number {
  const first = checkedExpiry(left, `${context}.left`);
  const second = checkedExpiry(right, `${context}.right`);
  if (first.unit !== second.unit) {
    throw new IncompatibleUnitError(
      context,
      `${first.unit} cannot be compared with ${second.unit}`,
    );
  }
  if (first.value === second.value) return 0;
  return first.value < second.value ? -1 : 1;
}
