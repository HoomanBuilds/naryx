import { checkedUnsigned } from './arithmetic.js';
import { bytesEqual, compareBytes } from './bytes.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  assetId,
  domainRef,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type AssetId,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const VERSION_BITS = 32;
const DECIMALS_BITS = 8;
const UNIT_BITS = 128;

export interface BaseLotSizeInput {
  readonly baseAssetId: string;
  readonly baseAssetManifestHash: Uint8Array | string;
  readonly baseDecimals: number;
  readonly atoms: bigint;
}

export interface BaseLotSize {
  readonly baseAssetId: AssetId;
  readonly baseAssetManifestHash: ManifestHash;
  readonly baseDecimals: number;
  readonly atoms: bigint;
}

export interface PriceTickInput {
  readonly quoteAssetId: string;
  readonly quoteAssetManifestHash: Uint8Array | string;
  readonly quoteDecimals: number;
  readonly quoteAtoms: bigint;
  readonly baseLotCount: bigint;
}

export interface PriceTick {
  readonly quoteAssetId: AssetId;
  readonly quoteAssetManifestHash: ManifestHash;
  readonly quoteDecimals: number;
  readonly quoteAtoms: bigint;
  readonly baseLotCount: bigint;
}

export interface MinimumNotionalInput {
  readonly quoteAssetId: string;
  readonly quoteAssetManifestHash: Uint8Array | string;
  readonly quoteDecimals: number;
  readonly atoms: bigint;
}

export interface MinimumNotional {
  readonly quoteAssetId: AssetId;
  readonly quoteAssetManifestHash: ManifestHash;
  readonly quoteDecimals: number;
  readonly atoms: bigint;
}

export interface ContractMultiplierInput {
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly unitConvention: string;
}

export interface ContractMultiplier {
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly unitConvention: ProtocolId;
}

export interface PermittedPriceSourceInput {
  readonly priceSourceId: string;
  readonly priceSourceManifestHash: Uint8Array | string;
}

export interface PermittedPriceSource {
  readonly priceSourceId: ProtocolId;
  readonly priceSourceManifestHash: ManifestHash;
}

export interface MarketManifestInput {
  readonly manifestVersion: number;
  readonly environment: string;
  readonly marketId: string;
  readonly domain: DomainRef;
  readonly venueId: string;
  readonly venueManifestHash: Uint8Array | string;
  readonly marketIdentity: string;
  readonly instrumentKind: string;
  readonly baseAssetId: string;
  readonly baseAssetManifestHash: Uint8Array | string;
  readonly quoteAssetId: string;
  readonly quoteAssetManifestHash: Uint8Array | string;
  readonly baseLotSize: BaseLotSizeInput;
  readonly priceTick: PriceTickInput;
  readonly minimumNotional: MinimumNotionalInput;
  readonly contractMultiplier: ContractMultiplierInput;
  readonly permittedPriceSources: readonly PermittedPriceSourceInput[];
}

export interface MarketManifest {
  readonly manifestVersion: number;
  readonly environment: ProtocolId;
  readonly marketId: ProtocolId;
  readonly domain: DomainRef;
  readonly venueId: ProtocolId;
  readonly venueManifestHash: ManifestHash;
  readonly marketIdentity: ProtocolId;
  readonly instrumentKind: ProtocolId;
  readonly baseAssetId: AssetId;
  readonly baseAssetManifestHash: ManifestHash;
  readonly quoteAssetId: AssetId;
  readonly quoteAssetManifestHash: ManifestHash;
  readonly baseLotSize: BaseLotSize;
  readonly priceTick: PriceTick;
  readonly minimumNotional: MinimumNotional;
  readonly contractMultiplier: ContractMultiplier;
  readonly permittedPriceSources: readonly PermittedPriceSource[];
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

function u128(value: bigint, context: string, positive: boolean): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  const checked = checkedUnsigned(value, UNIT_BITS, context);
  if (positive && checked === 0n) {
    throw new MalformedInputError(context, 'value is zero');
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

function frozenBaseLotSize(
  baseAssetIdValue: AssetId,
  capturedHash: ManifestHash,
  baseDecimals: number,
  atoms: bigint,
): BaseLotSize {
  return Object.freeze({
    baseAssetId: baseAssetIdValue,
    get baseAssetManifestHash(): ManifestHash {
      return Uint8Array.from(capturedHash) as ManifestHash;
    },
    baseDecimals,
    atoms,
  });
}

function baseLotSize(input: BaseLotSizeInput, context: string): BaseLotSize {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a base lot size object');
  }
  return frozenBaseLotSize(
    assetId(input.baseAssetId, `${context}.baseAssetId`),
    manifestHash(input.baseAssetManifestHash, `${context}.baseAssetManifestHash`),
    checkedNumber(input.baseDecimals, DECIMALS_BITS, `${context}.baseDecimals`),
    u128(input.atoms, `${context}.atoms`, true),
  );
}

function frozenPriceTick(
  quoteAssetIdValue: AssetId,
  capturedHash: ManifestHash,
  quoteDecimals: number,
  quoteAtoms: bigint,
  baseLotCount: bigint,
): PriceTick {
  return Object.freeze({
    quoteAssetId: quoteAssetIdValue,
    get quoteAssetManifestHash(): ManifestHash {
      return Uint8Array.from(capturedHash) as ManifestHash;
    },
    quoteDecimals,
    quoteAtoms,
    baseLotCount,
  });
}

function priceTick(input: PriceTickInput, context: string): PriceTick {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a price tick object');
  }
  return frozenPriceTick(
    assetId(input.quoteAssetId, `${context}.quoteAssetId`),
    manifestHash(input.quoteAssetManifestHash, `${context}.quoteAssetManifestHash`),
    checkedNumber(input.quoteDecimals, DECIMALS_BITS, `${context}.quoteDecimals`),
    u128(input.quoteAtoms, `${context}.quoteAtoms`, true),
    u128(input.baseLotCount, `${context}.baseLotCount`, true),
  );
}

function frozenMinimumNotional(
  quoteAssetIdValue: AssetId,
  capturedHash: ManifestHash,
  quoteDecimals: number,
  atoms: bigint,
): MinimumNotional {
  return Object.freeze({
    quoteAssetId: quoteAssetIdValue,
    get quoteAssetManifestHash(): ManifestHash {
      return Uint8Array.from(capturedHash) as ManifestHash;
    },
    quoteDecimals,
    atoms,
  });
}

function minimumNotional(input: MinimumNotionalInput, context: string): MinimumNotional {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a minimum notional object');
  }
  return frozenMinimumNotional(
    assetId(input.quoteAssetId, `${context}.quoteAssetId`),
    manifestHash(input.quoteAssetManifestHash, `${context}.quoteAssetManifestHash`),
    checkedNumber(input.quoteDecimals, DECIMALS_BITS, `${context}.quoteDecimals`),
    u128(input.atoms, `${context}.atoms`, false),
  );
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

function contractMultiplier(
  input: ContractMultiplierInput,
  context: string,
): ContractMultiplier {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a contract multiplier object');
  }
  const numerator = u128(input.numerator, `${context}.numerator`, true);
  const denominator = u128(input.denominator, `${context}.denominator`, true);
  if (greatestCommonDivisor(numerator, denominator) !== 1n) {
    throw new MalformedInputError(context, 'multiplier is not in lowest terms');
  }
  return Object.freeze({
    numerator,
    denominator,
    unitConvention: protocolId(input.unitConvention, `${context}.unitConvention`),
  });
}

function frozenPriceSource(
  priceSourceIdValue: ProtocolId,
  capturedHash: ManifestHash,
): PermittedPriceSource {
  return Object.freeze({
    priceSourceId: priceSourceIdValue,
    get priceSourceManifestHash(): ManifestHash {
      return Uint8Array.from(capturedHash) as ManifestHash;
    },
  });
}

function priceSource(
  input: PermittedPriceSourceInput,
  context: string,
): PermittedPriceSource {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a price source object');
  }
  return frozenPriceSource(
    protocolId(input.priceSourceId, `${context}.priceSourceId`),
    manifestHash(input.priceSourceManifestHash, `${context}.priceSourceManifestHash`),
  );
}

function encodePriceSource(
  writer: CanonicalWriter,
  value: PermittedPriceSource,
  context: string,
): void {
  encodeProtocolId(writer, value.priceSourceId, `${context}.priceSourceId`);
  encodeManifestHash(
    writer,
    value.priceSourceManifestHash,
    `${context}.priceSourceManifestHash`,
  );
}

function priceSourceBytes(value: PermittedPriceSource): Uint8Array {
  return canonicalBytes((writer) => encodePriceSource(writer, value, 'priceSource'));
}

function canonicalPriceSources(
  inputs: readonly PermittedPriceSourceInput[],
  context: string,
): readonly PermittedPriceSource[] {
  if (!Array.isArray(inputs)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  if (inputs.length === 0) {
    throw new MalformedInputError(context, 'price source set is empty');
  }

  const entries = inputs
    .map((input, index) => {
      const value = priceSource(input, `${context}[${index}]`);
      return { value, bytes: priceSourceBytes(value) };
    })
    .sort((left, right) => compareBytes(left.bytes, right.bytes));

  for (let index = 1; index < entries.length; index += 1) {
    if (compareBytes(entries[index - 1]!.bytes, entries[index]!.bytes) === 0) {
      throw new DuplicateElementError(context, `duplicate price source at sorted index ${index}`);
    }
  }

  return Object.freeze(entries.map((entry) => entry.value));
}

function assertAssetIdentity(
  expectedId: AssetId,
  expectedHash: ManifestHash,
  actualId: AssetId,
  actualHash: ManifestHash,
  context: string,
): void {
  if (actualId !== expectedId || !bytesEqual(actualHash, expectedHash)) {
    throw new MalformedInputError(context, 'asset identity does not match the market asset');
  }
}

export function marketManifest(
  input: MarketManifestInput,
  context = 'marketManifest',
): MarketManifest {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a market manifest object');
  }

  const venueManifestHashValue = manifestHash(
    input.venueManifestHash,
    `${context}.venueManifestHash`,
  );
  const baseAssetIdValue = assetId(input.baseAssetId, `${context}.baseAssetId`);
  const baseAssetManifestHashValue = manifestHash(
    input.baseAssetManifestHash,
    `${context}.baseAssetManifestHash`,
  );
  const quoteAssetIdValue = assetId(input.quoteAssetId, `${context}.quoteAssetId`);
  const quoteAssetManifestHashValue = manifestHash(
    input.quoteAssetManifestHash,
    `${context}.quoteAssetManifestHash`,
  );
  const baseLotSizeValue = baseLotSize(input.baseLotSize, `${context}.baseLotSize`);
  const priceTickValue = priceTick(input.priceTick, `${context}.priceTick`);
  const minimumNotionalValue = minimumNotional(
    input.minimumNotional,
    `${context}.minimumNotional`,
  );

  assertAssetIdentity(
    baseAssetIdValue,
    baseAssetManifestHashValue,
    baseLotSizeValue.baseAssetId,
    baseLotSizeValue.baseAssetManifestHash,
    `${context}.baseLotSize`,
  );
  assertAssetIdentity(
    quoteAssetIdValue,
    quoteAssetManifestHashValue,
    priceTickValue.quoteAssetId,
    priceTickValue.quoteAssetManifestHash,
    `${context}.priceTick`,
  );
  assertAssetIdentity(
    quoteAssetIdValue,
    quoteAssetManifestHashValue,
    minimumNotionalValue.quoteAssetId,
    minimumNotionalValue.quoteAssetManifestHash,
    `${context}.minimumNotional`,
  );
  if (priceTickValue.quoteDecimals !== minimumNotionalValue.quoteDecimals) {
    throw new MalformedInputError(
      `${context}.minimumNotional.quoteDecimals`,
      'quote decimals do not match price tick decimals',
    );
  }

  return Object.freeze({
    manifestVersion: nonzeroU32(input.manifestVersion, `${context}.manifestVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    marketId: protocolId(input.marketId, `${context}.marketId`),
    domain: checkedDomainRef(input.domain, `${context}.domain`),
    venueId: protocolId(input.venueId, `${context}.venueId`),
    get venueManifestHash(): ManifestHash {
      return Uint8Array.from(venueManifestHashValue) as ManifestHash;
    },
    marketIdentity: protocolId(input.marketIdentity, `${context}.marketIdentity`),
    instrumentKind: protocolId(input.instrumentKind, `${context}.instrumentKind`),
    baseAssetId: baseAssetIdValue,
    get baseAssetManifestHash(): ManifestHash {
      return Uint8Array.from(baseAssetManifestHashValue) as ManifestHash;
    },
    quoteAssetId: quoteAssetIdValue,
    get quoteAssetManifestHash(): ManifestHash {
      return Uint8Array.from(quoteAssetManifestHashValue) as ManifestHash;
    },
    baseLotSize: baseLotSizeValue,
    priceTick: priceTickValue,
    minimumNotional: minimumNotionalValue,
    contractMultiplier: contractMultiplier(
      input.contractMultiplier,
      `${context}.contractMultiplier`,
    ),
    permittedPriceSources: canonicalPriceSources(
      input.permittedPriceSources,
      `${context}.permittedPriceSources`,
    ),
  });
}

function canonicalHash(value: ManifestHash, context: string): ManifestHash {
  if (!(value instanceof Uint8Array)) {
    throw new MalformedInputError(context, 'expected 32 canonical bytes');
  }
  return manifestHash(value, context);
}

function checkedNestedObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function checkedMarketManifest(value: MarketManifest, context: string): MarketManifest {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a market manifest object');
  }
  const baseLotValue = checkedNestedObject(value.baseLotSize, `${context}.baseLotSize`);
  const priceTickValue = checkedNestedObject(value.priceTick, `${context}.priceTick`);
  const minimumNotionalValue = checkedNestedObject(
    value.minimumNotional,
    `${context}.minimumNotional`,
  );
  if (!Array.isArray(value.permittedPriceSources)) {
    throw new MalformedInputError(`${context}.permittedPriceSources`, 'expected an array');
  }

  return marketManifest(
    {
      ...value,
      venueManifestHash: canonicalHash(value.venueManifestHash, `${context}.venueManifestHash`),
      baseAssetManifestHash: canonicalHash(
        value.baseAssetManifestHash,
        `${context}.baseAssetManifestHash`,
      ),
      quoteAssetManifestHash: canonicalHash(
        value.quoteAssetManifestHash,
        `${context}.quoteAssetManifestHash`,
      ),
      baseLotSize: {
        ...(baseLotValue as unknown as BaseLotSize),
        baseAssetManifestHash: canonicalHash(
          baseLotValue.baseAssetManifestHash as ManifestHash,
          `${context}.baseLotSize.baseAssetManifestHash`,
        ),
      },
      priceTick: {
        ...(priceTickValue as unknown as PriceTick),
        quoteAssetManifestHash: canonicalHash(
          priceTickValue.quoteAssetManifestHash as ManifestHash,
          `${context}.priceTick.quoteAssetManifestHash`,
        ),
      },
      minimumNotional: {
        ...(minimumNotionalValue as unknown as MinimumNotional),
        quoteAssetManifestHash: canonicalHash(
          minimumNotionalValue.quoteAssetManifestHash as ManifestHash,
          `${context}.minimumNotional.quoteAssetManifestHash`,
        ),
      },
      permittedPriceSources: value.permittedPriceSources.map((source, index) => {
        const checked = checkedNestedObject(
          source,
          `${context}.permittedPriceSources[${index}]`,
        );
        return {
          ...(checked as unknown as PermittedPriceSource),
          priceSourceManifestHash: canonicalHash(
            checked.priceSourceManifestHash as ManifestHash,
            `${context}.permittedPriceSources[${index}].priceSourceManifestHash`,
          ),
        };
      }),
    },
    context,
  );
}

export function encodeMarketManifest(writer: CanonicalWriter, value: MarketManifest): void {
  const checked = checkedMarketManifest(value, 'marketManifest');
  writer.writeU32(checked.manifestVersion, 'marketManifest.manifestVersion');
  encodeProtocolId(writer, checked.environment, 'marketManifest.environment');
  encodeProtocolId(writer, checked.marketId, 'marketManifest.marketId');
  encodeDomainRef(writer, checked.domain);
  encodeProtocolId(writer, checked.venueId, 'marketManifest.venueId');
  encodeManifestHash(writer, checked.venueManifestHash, 'marketManifest.venueManifestHash');
  encodeProtocolId(writer, checked.marketIdentity, 'marketManifest.marketIdentity');
  encodeProtocolId(writer, checked.instrumentKind, 'marketManifest.instrumentKind');
  encodeProtocolId(writer, checked.baseAssetId, 'marketManifest.baseAssetId');
  encodeManifestHash(
    writer,
    checked.baseAssetManifestHash,
    'marketManifest.baseAssetManifestHash',
  );
  encodeProtocolId(writer, checked.quoteAssetId, 'marketManifest.quoteAssetId');
  encodeManifestHash(
    writer,
    checked.quoteAssetManifestHash,
    'marketManifest.quoteAssetManifestHash',
  );
  encodeProtocolId(
    writer,
    checked.baseLotSize.baseAssetId,
    'marketManifest.baseLotSize.baseAssetId',
  );
  encodeManifestHash(
    writer,
    checked.baseLotSize.baseAssetManifestHash,
    'marketManifest.baseLotSize.baseAssetManifestHash',
  );
  writer.writeU8(checked.baseLotSize.baseDecimals, 'marketManifest.baseLotSize.baseDecimals');
  writer.writeU128(checked.baseLotSize.atoms, 'marketManifest.baseLotSize.atoms');
  encodeProtocolId(
    writer,
    checked.priceTick.quoteAssetId,
    'marketManifest.priceTick.quoteAssetId',
  );
  encodeManifestHash(
    writer,
    checked.priceTick.quoteAssetManifestHash,
    'marketManifest.priceTick.quoteAssetManifestHash',
  );
  writer.writeU8(checked.priceTick.quoteDecimals, 'marketManifest.priceTick.quoteDecimals');
  writer.writeU128(checked.priceTick.quoteAtoms, 'marketManifest.priceTick.quoteAtoms');
  writer.writeU128(checked.priceTick.baseLotCount, 'marketManifest.priceTick.baseLotCount');
  encodeProtocolId(
    writer,
    checked.minimumNotional.quoteAssetId,
    'marketManifest.minimumNotional.quoteAssetId',
  );
  encodeManifestHash(
    writer,
    checked.minimumNotional.quoteAssetManifestHash,
    'marketManifest.minimumNotional.quoteAssetManifestHash',
  );
  writer.writeU8(
    checked.minimumNotional.quoteDecimals,
    'marketManifest.minimumNotional.quoteDecimals',
  );
  writer.writeU128(checked.minimumNotional.atoms, 'marketManifest.minimumNotional.atoms');
  writer.writeU128(
    checked.contractMultiplier.numerator,
    'marketManifest.contractMultiplier.numerator',
  );
  writer.writeU128(
    checked.contractMultiplier.denominator,
    'marketManifest.contractMultiplier.denominator',
  );
  encodeProtocolId(
    writer,
    checked.contractMultiplier.unitConvention,
    'marketManifest.contractMultiplier.unitConvention',
  );
  writer.writeArray(
    checked.permittedPriceSources,
    (entryWriter, entry) => encodePriceSource(entryWriter, entry, 'marketManifest.priceSource'),
    'marketManifest.permittedPriceSources',
  );
}

export function marketManifestBytes(value: MarketManifestInput): Uint8Array {
  const checked = marketManifest(value, 'marketManifest');
  return canonicalBytes((writer) => encodeMarketManifest(writer, checked));
}

export function marketManifestHash(value: MarketManifestInput): ManifestHash {
  return manifestHash(
    domainHash(HASH_DOMAIN.MARKET_MANIFEST, marketManifestBytes(value), 'marketManifestHash'),
    'marketManifestHash',
  );
}
