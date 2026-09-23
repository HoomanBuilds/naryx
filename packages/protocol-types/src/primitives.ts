import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { fromHex } from './bytes.js';
import { CanonicalWriter } from './encoding.js';
import {
  DURATION_UNIT,
  EXPIRY_UNIT,
  type DurationUnit,
  type ExpiryUnit,
} from './enums.js';
import { IncompatibleUnitError, MalformedInputError, RangeViolationError } from './errors.js';
import { encodeAscii } from './text.js';

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

// A manifest hash additionally rejects the all-zero value so a zeroed account, an
// uninitialized struct, or an omitted field can never pass as a registered manifest.
// Generic Hash32 keeps accepting it, because zero is a legitimate digest input elsewhere.
export type ManifestHash = Hash32 & { readonly __manifestHash: true };

export function manifestHash(value: Uint8Array | string, context = 'manifestHash'): ManifestHash {
  const bytes = hash32(value, context);
  if (bytes.every((byte) => byte === 0)) {
    throw new MalformedInputError(context, 'manifest hash is all zero');
  }
  return bytes as ManifestHash;
}

// The constructors take a hex string for ergonomics, but the wire representation is bytes. A
// string reaching an encoder means the value never passed a constructor, so it is refused rather
// than parsed a second time.
function checkedManifestHash(value: ManifestHash, context: string): ManifestHash {
  if (!(value instanceof Uint8Array)) {
    throw new MalformedInputError(context, `expected ${HASH_BYTE_LENGTH} canonical bytes`);
  }
  return manifestHash(value, context);
}

export function encodeManifestHash(
  writer: CanonicalWriter,
  value: ManifestHash,
  context = 'manifestHash',
): void {
  writer.writeFixedBytes(checkedManifestHash(value, context), HASH_BYTE_LENGTH, context);
}

export const PROTOCOL_ID_MAX_BYTES = 128;

// A protocol identifier names a registered subject on the wire: a domain, an asset, an
// economic asset, a venue, a market, an adapter, a price source, or a template. It is not a
// user-visible name, so it is bounded ASCII and is never Unicode-normalized.
export type ProtocolId = string & { readonly __protocolId: true };

export function protocolId(value: string, context = 'protocolId'): ProtocolId {
  const encoded = encodeAscii(value, context);
  if (encoded.length === 0) {
    throw new MalformedInputError(context, 'identifier is empty');
  }
  if (encoded.length > PROTOCOL_ID_MAX_BYTES) {
    throw new RangeViolationError(
      context,
      `identifier is ${encoded.length} bytes, above ${PROTOCOL_ID_MAX_BYTES}`,
    );
  }
  return value as ProtocolId;
}

export function encodeProtocolId(
  writer: CanonicalWriter,
  value: ProtocolId,
  context = 'protocolId',
): void {
  writer.writeString(protocolId(value, context), context);
}

export type DomainId = ProtocolId & { readonly __domainId: true };

export function domainId(value: string, context = 'domainId'): DomainId {
  return protocolId(value, context) as DomainId;
}

export type AssetId = ProtocolId & { readonly __assetId: true };

export function assetId(value: string, context = 'assetId'): AssetId {
  return protocolId(value, context) as AssetId;
}

export const MANIFEST_VERSION_BITS = 32;

export interface VersionedManifestRef {
  readonly subjectId: ProtocolId;
  readonly manifestVersion: number;
  readonly manifestHash: ManifestHash;
}

function checkedManifestVersion(value: number, context: string): number {
  const version = checkedUnsigned(value, MANIFEST_VERSION_BITS, context);
  if (version === 0n) {
    throw new MalformedInputError(context, 'manifest version is zero');
  }
  return Number(version);
}

// A ManifestHash is a Uint8Array, so freezing the reference leaves its bytes writable. The
// reference keeps the only copy and hands back a fresh one on every read, which is what makes
// its canonical bytes stable for the lifetime of the value.
function frozenVersionedManifestRef(
  subjectId: ProtocolId,
  manifestVersion: number,
  captured: ManifestHash,
): VersionedManifestRef {
  return Object.freeze({
    subjectId,
    manifestVersion,
    get manifestHash(): ManifestHash {
      return Uint8Array.from(captured) as ManifestHash;
    },
  });
}

export function versionedManifestRef(
  subjectId: string,
  manifestVersion: number,
  hash: Uint8Array | string,
  context = 'versionedManifestRef',
): VersionedManifestRef {
  return frozenVersionedManifestRef(
    protocolId(subjectId, `${context}.subjectId`),
    checkedManifestVersion(manifestVersion, `${context}.manifestVersion`),
    manifestHash(hash, `${context}.manifestHash`),
  );
}

// A runtime value reaching a public encoder is untrusted: it can be a plain object that never
// passed through the constructor, so every invariant is checked again, under the encoder's
// stricter hash rule, before a byte is written.
function checkedVersionedManifestRef(
  value: VersionedManifestRef,
  context: string,
): VersionedManifestRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a versioned manifest reference object');
  }
  return frozenVersionedManifestRef(
    protocolId(value.subjectId, `${context}.subjectId`),
    checkedManifestVersion(value.manifestVersion, `${context}.manifestVersion`),
    checkedManifestHash(value.manifestHash, `${context}.manifestHash`),
  );
}

export function encodeVersionedManifestRef(
  writer: CanonicalWriter,
  value: VersionedManifestRef,
): void {
  const checked = checkedVersionedManifestRef(value, 'versionedManifestRef');
  encodeProtocolId(writer, checked.subjectId, 'versionedManifestRef.subjectId');
  writer.writeU32(checked.manifestVersion, 'versionedManifestRef.manifestVersion');
  encodeManifestHash(writer, checked.manifestHash, 'versionedManifestRef.manifestHash');
}

// A domain is a chain deployment plus the executable semantics its runtime class implements.
// Binding the exact domain manifest version and hash into a signed object is what stops a later
// domain registration from reinterpreting an order, quote, route, or receipt signed under an
// earlier one. The domain identifier alone would not, because it outlives its manifest versions.
export interface DomainRef {
  readonly domainId: DomainId;
  readonly domainManifestVersion: number;
  readonly domainManifestHash: ManifestHash;
}

function frozenDomainRef(
  id: DomainId,
  domainManifestVersion: number,
  captured: ManifestHash,
): DomainRef {
  return Object.freeze({
    domainId: id,
    domainManifestVersion,
    get domainManifestHash(): ManifestHash {
      return Uint8Array.from(captured) as ManifestHash;
    },
  });
}

export function domainRef(
  id: string,
  domainManifestVersion: number,
  hash: Uint8Array | string,
  context = 'domainRef',
): DomainRef {
  return frozenDomainRef(
    domainId(id, `${context}.domainId`),
    checkedManifestVersion(domainManifestVersion, `${context}.domainManifestVersion`),
    manifestHash(hash, `${context}.domainManifestHash`),
  );
}

function checkedDomainRef(value: DomainRef, context: string): DomainRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a domain reference object');
  }
  return frozenDomainRef(
    domainId(value.domainId, `${context}.domainId`),
    checkedManifestVersion(value.domainManifestVersion, `${context}.domainManifestVersion`),
    checkedManifestHash(value.domainManifestHash, `${context}.domainManifestHash`),
  );
}

export function encodeDomainRef(writer: CanonicalWriter, value: DomainRef): void {
  const checked = checkedDomainRef(value, 'domainRef');
  encodeProtocolId(writer, checked.domainId, 'domainRef.domainId');
  writer.writeU32(checked.domainManifestVersion, 'domainRef.domainManifestVersion');
  encodeManifestHash(writer, checked.domainManifestHash, 'domainRef.domainManifestHash');
}

export interface AssetRef {
  readonly assetId: AssetId;
  readonly assetManifestHash: ManifestHash;
  readonly decimals: number;
}

function frozenAssetRef(id: AssetId, captured: ManifestHash, decimals: number): AssetRef {
  return Object.freeze({
    assetId: id,
    get assetManifestHash(): ManifestHash {
      return Uint8Array.from(captured) as ManifestHash;
    },
    decimals,
  });
}

export function assetRef(
  id: string,
  hash: Uint8Array | string,
  decimals: number,
  context = 'assetRef',
): AssetRef {
  return frozenAssetRef(
    assetId(id, `${context}.assetId`),
    manifestHash(hash, `${context}.assetManifestHash`),
    Number(checkedUnsigned(decimals, 8, `${context}.decimals`)),
  );
}

function checkedAssetRef(value: AssetRef, context: string): AssetRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an asset reference object');
  }
  return frozenAssetRef(
    assetId(value.assetId, `${context}.assetId`),
    checkedManifestHash(value.assetManifestHash, `${context}.assetManifestHash`),
    Number(checkedUnsigned(value.decimals, 8, `${context}.decimals`)),
  );
}

export function encodeAssetRef(writer: CanonicalWriter, value: AssetRef): void {
  const checked = checkedAssetRef(value, 'assetRef');
  encodeProtocolId(writer, checked.assetId, 'assetRef.assetId');
  encodeManifestHash(writer, checked.assetManifestHash, 'assetRef.assetManifestHash');
  writer.writeU8(checked.decimals, 'assetRef.decimals');
}

export const ASSET_ATOM_BITS = 128;

export interface AssetAmount {
  readonly asset: AssetRef;
  readonly atoms: bigint;
}

export function assetAmount(
  asset: AssetRef,
  atoms: bigint,
  context = 'assetAmount',
): AssetAmount {
  if (typeof atoms !== 'bigint') {
    throw new MalformedInputError(`${context}.atoms`, 'expected a bigint atom amount');
  }
  return Object.freeze({
    asset: checkedAssetRef(asset, `${context}.asset`),
    atoms: checkedSigned(atoms, ASSET_ATOM_BITS, `${context}.atoms`),
  });
}

function checkedAssetAmount(value: AssetAmount, context: string): AssetAmount {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an asset amount object');
  }
  return assetAmount(value.asset, value.atoms, context);
}

export function encodeAssetAmount(writer: CanonicalWriter, value: AssetAmount): void {
  const checked = checkedAssetAmount(value, 'assetAmount');
  encodeAssetRef(writer, checked.asset);
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

export const DURATION_VALUE_BITS = 64;

export interface Duration {
  readonly unit: DurationUnit;
  readonly value: bigint;
}

export function duration(unit: DurationUnit, value: bigint, context = 'duration'): Duration {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(`${context}.value`, 'expected a bigint duration value');
  }
  if (!Object.prototype.hasOwnProperty.call(DURATION_UNIT, unit)) {
    throw new MalformedInputError(`${context}.unit`, `unknown duration unit ${String(unit)}`);
  }
  const checked = checkedUnsigned(value, DURATION_VALUE_BITS, `${context}.value`);
  if (checked === 0n) {
    throw new MalformedInputError(`${context}.value`, 'duration is zero');
  }
  return Object.freeze({ unit, value: checked });
}

function checkedDuration(value: Duration, context: string): Duration {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a duration object');
  }
  return duration(value.unit, value.value, context);
}

export function encodeDuration(writer: CanonicalWriter, value: Duration): void {
  const checked = checkedDuration(value, 'duration');
  writer.writeEnum(DURATION_UNIT, checked.unit, 'duration.unit');
  writer.writeU64(checked.value, 'duration.value');
}
