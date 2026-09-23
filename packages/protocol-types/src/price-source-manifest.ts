import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  domainRef,
  duration,
  encodeDomainRef,
  encodeDuration,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type DomainRef,
  type Duration,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const VERSION_BITS = 32;
const DECIMALS_BITS = 8;

export interface PriceSourceManifestInput {
  readonly manifestVersion: number;
  readonly environment: string;
  readonly priceSourceId: string;
  readonly domain: DomainRef;
  readonly sourceKind: string;
  readonly feedIdentity: string;
  readonly priceDecimals: number;
  readonly priceConvention: string;
  readonly maxStaleness: Duration;
  readonly fallbackRule: string;
}

export interface PriceSourceManifest {
  readonly manifestVersion: number;
  readonly environment: ProtocolId;
  readonly priceSourceId: ProtocolId;
  readonly domain: DomainRef;
  readonly sourceKind: ProtocolId;
  readonly feedIdentity: ProtocolId;
  readonly priceDecimals: number;
  readonly priceConvention: ProtocolId;
  readonly maxStaleness: Duration;
  readonly fallbackRule: ProtocolId;
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

function checkedDomainRef(value: DomainRef, context: string): DomainRef {
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

function checkedDuration(value: Duration, context: string): Duration {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a duration object');
  }
  return duration(value.unit, value.value, context);
}

export function priceSourceManifest(
  input: PriceSourceManifestInput,
  context = 'priceSourceManifest',
): PriceSourceManifest {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a price source manifest object');
  }

  return Object.freeze({
    manifestVersion: nonzeroU32(input.manifestVersion, `${context}.manifestVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    priceSourceId: protocolId(input.priceSourceId, `${context}.priceSourceId`),
    domain: checkedDomainRef(input.domain, `${context}.domain`),
    sourceKind: protocolId(input.sourceKind, `${context}.sourceKind`),
    feedIdentity: protocolId(input.feedIdentity, `${context}.feedIdentity`),
    priceDecimals: checkedNumber(
      input.priceDecimals,
      DECIMALS_BITS,
      `${context}.priceDecimals`,
    ),
    priceConvention: protocolId(input.priceConvention, `${context}.priceConvention`),
    maxStaleness: checkedDuration(input.maxStaleness, `${context}.maxStaleness`),
    fallbackRule: protocolId(input.fallbackRule, `${context}.fallbackRule`),
  });
}

export function encodePriceSourceManifest(
  writer: CanonicalWriter,
  value: PriceSourceManifest,
): void {
  const checked = priceSourceManifest(value, 'priceSourceManifest');
  writer.writeU32(checked.manifestVersion, 'priceSourceManifest.manifestVersion');
  encodeProtocolId(writer, checked.environment, 'priceSourceManifest.environment');
  encodeProtocolId(writer, checked.priceSourceId, 'priceSourceManifest.priceSourceId');
  encodeDomainRef(writer, checked.domain);
  encodeProtocolId(writer, checked.sourceKind, 'priceSourceManifest.sourceKind');
  encodeProtocolId(writer, checked.feedIdentity, 'priceSourceManifest.feedIdentity');
  writer.writeU8(checked.priceDecimals, 'priceSourceManifest.priceDecimals');
  encodeProtocolId(writer, checked.priceConvention, 'priceSourceManifest.priceConvention');
  encodeDuration(writer, checked.maxStaleness);
  encodeProtocolId(writer, checked.fallbackRule, 'priceSourceManifest.fallbackRule');
}

export function priceSourceManifestBytes(value: PriceSourceManifestInput): Uint8Array {
  const checked = priceSourceManifest(value, 'priceSourceManifest');
  return canonicalBytes((writer) => encodePriceSourceManifest(writer, checked));
}

export function priceSourceManifestHash(value: PriceSourceManifestInput): ManifestHash {
  return manifestHash(
    domainHash(
      HASH_DOMAIN.PRICE_SOURCE_MANIFEST,
      priceSourceManifestBytes(value),
      'priceSourceManifestHash',
    ),
    'priceSourceManifestHash',
  );
}
