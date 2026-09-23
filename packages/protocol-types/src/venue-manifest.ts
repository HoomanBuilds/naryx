import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  domainRef,
  encodeDomainRef,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const VERSION_BITS = 32;

export interface VenueManifestInput {
  readonly manifestVersion: number;
  readonly environment: string;
  readonly venueId: string;
  readonly domain: DomainRef;
  readonly venueKind: string;
  readonly protocolIdentity: string;
  readonly codeIdentity: string;
  readonly authorityIdentity: string;
}

export interface VenueManifest {
  readonly manifestVersion: number;
  readonly environment: ProtocolId;
  readonly venueId: ProtocolId;
  readonly domain: DomainRef;
  readonly venueKind: ProtocolId;
  readonly protocolIdentity: ProtocolId;
  readonly codeIdentity: ProtocolId;
  readonly authorityIdentity: ProtocolId;
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

function checkedDomainRef(value: DomainRef, context: string): DomainRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a domain reference object');
  }
  if (!(value.domainManifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(
      `${context}.domainManifestHash`,
      'expected 32 canonical bytes',
    );
  }
  return domainRef(
    value.domainId,
    value.domainManifestVersion,
    value.domainManifestHash,
    context,
  );
}

export function venueManifest(
  input: VenueManifestInput,
  context = 'venueManifest',
): VenueManifest {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a venue manifest object');
  }

  return Object.freeze({
    manifestVersion: nonzeroU32(input.manifestVersion, `${context}.manifestVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    venueId: protocolId(input.venueId, `${context}.venueId`),
    domain: checkedDomainRef(input.domain, `${context}.domain`),
    venueKind: protocolId(input.venueKind, `${context}.venueKind`),
    protocolIdentity: protocolId(input.protocolIdentity, `${context}.protocolIdentity`),
    codeIdentity: protocolId(input.codeIdentity, `${context}.codeIdentity`),
    authorityIdentity: protocolId(input.authorityIdentity, `${context}.authorityIdentity`),
  });
}

export function encodeVenueManifest(writer: CanonicalWriter, value: VenueManifest): void {
  const checked = venueManifest(value, 'venueManifest');
  writer.writeU32(checked.manifestVersion, 'venueManifest.manifestVersion');
  encodeProtocolId(writer, checked.environment, 'venueManifest.environment');
  encodeProtocolId(writer, checked.venueId, 'venueManifest.venueId');
  encodeDomainRef(writer, checked.domain);
  encodeProtocolId(writer, checked.venueKind, 'venueManifest.venueKind');
  encodeProtocolId(writer, checked.protocolIdentity, 'venueManifest.protocolIdentity');
  encodeProtocolId(writer, checked.codeIdentity, 'venueManifest.codeIdentity');
  encodeProtocolId(writer, checked.authorityIdentity, 'venueManifest.authorityIdentity');
}

export function venueManifestBytes(value: VenueManifestInput): Uint8Array {
  const checked = venueManifest(value, 'venueManifest');
  return canonicalBytes((writer) => encodeVenueManifest(writer, checked));
}

export function venueManifestHash(value: VenueManifestInput): ManifestHash {
  return manifestHash(
    domainHash(HASH_DOMAIN.VENUE_MANIFEST, venueManifestBytes(value), 'venueManifestHash'),
    'venueManifestHash',
  );
}
