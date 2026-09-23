import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  assetId,
  assetRef,
  domainRef,
  encodeDomainRef,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type AssetId,
  type AssetRef,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const VERSION_BITS = 32;
const DECIMALS_BITS = 8;
const MINIMUM_TRANSFER_BITS = 128;

export interface AssetManifestInput {
  readonly manifestVersion: number;
  readonly environment: string;
  readonly assetId: string;
  readonly economicAssetId: string;
  readonly domain: DomainRef;
  readonly tokenIdentity: string;
  readonly decimals: number;
  readonly atomUnitName: string;
  readonly minimumTransferAtoms: bigint;
  readonly transferSemantics: string;
}

export interface AssetManifest {
  readonly manifestVersion: number;
  readonly environment: ProtocolId;
  readonly assetId: AssetId;
  readonly economicAssetId: ProtocolId;
  readonly domain: DomainRef;
  readonly tokenIdentity: ProtocolId;
  readonly decimals: number;
  readonly atomUnitName: ProtocolId;
  readonly minimumTransferAtoms: bigint;
  readonly transferSemantics: ProtocolId;
}

function checkedNumber(value: number, bits: number, context: string): number {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  return Number(checkedUnsigned(value, bits, context));
}

function nonzeroU32(value: number, context: string): number {
  const checked = checkedNumber(value, VERSION_BITS, context);
  if (checked === 0) {
    throw new MalformedInputError(context, 'version is zero');
  }
  return checked;
}

function u128BigInt(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  return checkedUnsigned(value, MINIMUM_TRANSFER_BITS, context);
}

function canonicalDomainRef(value: DomainRef, context: string): DomainRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a domain reference object');
  }
  if (!(value.domainManifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(`${context}.domainManifestHash`, 'expected 32 canonical bytes');
  }
  return domainRef(
    value.domainId,
    value.domainManifestVersion,
    value.domainManifestHash,
    context,
  );
}

export function assetManifest(
  input: AssetManifestInput,
  context = 'assetManifest',
): AssetManifest {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an asset manifest object');
  }

  return Object.freeze({
    manifestVersion: nonzeroU32(input.manifestVersion, `${context}.manifestVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    assetId: assetId(input.assetId, `${context}.assetId`),
    economicAssetId: protocolId(input.economicAssetId, `${context}.economicAssetId`),
    domain: canonicalDomainRef(input.domain, `${context}.domain`),
    tokenIdentity: protocolId(input.tokenIdentity, `${context}.tokenIdentity`),
    decimals: checkedNumber(input.decimals, DECIMALS_BITS, `${context}.decimals`),
    atomUnitName: protocolId(input.atomUnitName, `${context}.atomUnitName`),
    minimumTransferAtoms: u128BigInt(
      input.minimumTransferAtoms,
      `${context}.minimumTransferAtoms`,
    ),
    transferSemantics: protocolId(
      input.transferSemantics,
      `${context}.transferSemantics`,
    ),
  });
}

function checkedAssetManifest(value: AssetManifest, context: string): AssetManifest {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an asset manifest object');
  }
  return assetManifest(value, context);
}

export function encodeAssetManifest(writer: CanonicalWriter, value: AssetManifest): void {
  const checked = checkedAssetManifest(value, 'assetManifest');
  writer.writeU32(checked.manifestVersion, 'assetManifest.manifestVersion');
  encodeProtocolId(writer, checked.environment, 'assetManifest.environment');
  encodeProtocolId(writer, checked.assetId, 'assetManifest.assetId');
  encodeProtocolId(writer, checked.economicAssetId, 'assetManifest.economicAssetId');
  encodeDomainRef(writer, checked.domain);
  encodeProtocolId(writer, checked.tokenIdentity, 'assetManifest.tokenIdentity');
  writer.writeU8(checked.decimals, 'assetManifest.decimals');
  encodeProtocolId(writer, checked.atomUnitName, 'assetManifest.atomUnitName');
  writer.writeU128(checked.minimumTransferAtoms, 'assetManifest.minimumTransferAtoms');
  encodeProtocolId(writer, checked.transferSemantics, 'assetManifest.transferSemantics');
}

export function assetManifestBytes(value: AssetManifestInput): Uint8Array {
  const checked = assetManifest(value, 'assetManifest');
  return canonicalBytes((writer) => encodeAssetManifest(writer, checked));
}

export function assetManifestHash(value: AssetManifestInput): ManifestHash {
  return manifestHash(
    domainHash(HASH_DOMAIN.ASSET_MANIFEST, assetManifestBytes(value), 'assetManifestHash'),
    'assetManifestHash',
  );
}

export function assetRefFromManifest(value: AssetManifestInput): AssetRef {
  const checked = assetManifest(value, 'assetManifest');
  return assetRef(
    checked.assetId,
    assetManifestHash(checked),
    checked.decimals,
    'assetManifestRef',
  );
}
