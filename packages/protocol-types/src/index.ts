export {
  ProtocolError,
  RangeViolationError,
  MalformedInputError,
  DuplicateElementError,
  IncompatibleUnitError,
  DivisionByZeroError,
  type ProtocolErrorCode,
} from './errors.js';

export {
  toHex,
  fromHex,
  concatBytes,
  compareBytes,
  bytesEqual,
  assertUint8Array,
} from './bytes.js';

export { encodeUtf8, encodeAscii } from './text.js';

export {
  EXPIRY_UNIT,
  DURATION_UNIT,
  DIRECTION,
  PACKAGE_ACTION,
  SETTLEMENT_CLASS,
  QUANTITY_POLICY_CLASS,
  PARTIAL_FILL_POLICY,
  REGISTRY_STATE,
  REGISTRY_RECORD_KIND,
  RISK_LIMIT_KIND,
  FEE_CATEGORY,
  PASS_THROUGH_COST_CATEGORY,
  enumDiscriminant,
  type EnumTable,
  type ExpiryUnit,
  type DurationUnit,
  type Direction,
  type PackageAction,
  type SettlementClass,
  type QuantityPolicyClass,
  type PartialFillPolicy,
  type RegistryState,
  type RegistryRecordKind,
  type RiskLimitKind,
  type FeeCategory,
  type PassThroughCostCategory,
} from './enums.js';

export {
  ROUNDING,
  U32_MAX,
  toBigInt,
  checkedUnsigned,
  checkedSigned,
  absBigInt,
  assertU32Length,
  mulDiv,
  scaleDecimals,
  type Rounding,
} from './arithmetic.js';

export {
  CanonicalWriter,
  canonicalBytes,
  OPTIONAL_ABSENT,
  OPTIONAL_PRESENT,
  UNSIGNED_WIDTHS,
  SIGNED_WIDTHS,
  type ElementEncoder,
  type UnsignedWidth,
  type SignedWidth,
} from './encoding.js';

export {
  HASH_BYTE_LENGTH,
  PROTOCOL_ID_MAX_BYTES,
  MANIFEST_VERSION_BITS,
  ASSET_ATOM_BITS,
  EXPIRY_VALUE_BITS,
  DURATION_VALUE_BITS,
  hash32,
  encodeHash32,
  manifestHash,
  encodeManifestHash,
  protocolId,
  encodeProtocolId,
  domainId,
  assetId,
  versionedManifestRef,
  encodeVersionedManifestRef,
  domainRef,
  encodeDomainRef,
  assetRef,
  encodeAssetRef,
  assetAmount,
  encodeAssetAmount,
  expiry,
  encodeExpiry,
  compareExpiry,
  duration,
  encodeDuration,
  type Hash32,
  type ManifestHash,
  type ProtocolId,
  type DomainId,
  type AssetId,
  type VersionedManifestRef,
  type DomainRef,
  type AssetRef,
  type AssetAmount,
  type Expiry,
  type Duration,
} from './primitives.js';

export { HASH_DOMAIN, domainBytes, domainHash, type HashDomain } from './hashing.js';

export {
  domainManifest,
  encodeDomainManifest,
  domainManifestBytes,
  domainManifestHash,
  domainRefFromManifest,
  type DomainManifestInput,
  type DomainManifest,
} from './domain-manifest.js';

export {
  assetManifest,
  encodeAssetManifest,
  assetManifestBytes,
  assetManifestHash,
  assetRefFromManifest,
  type AssetManifestInput,
  type AssetManifest,
} from './asset-manifest.js';

export {
  venueManifest,
  encodeVenueManifest,
  venueManifestBytes,
  venueManifestHash,
  type VenueManifestInput,
  type VenueManifest,
} from './venue-manifest.js';

export {
  marketManifest,
  encodeMarketManifest,
  marketManifestBytes,
  marketManifestHash,
  type BaseLotSizeInput,
  type BaseLotSize,
  type PriceTickInput,
  type PriceTick,
  type MinimumNotionalInput,
  type MinimumNotional,
  type ContractMultiplierInput,
  type ContractMultiplier,
  type PermittedPriceSourceInput,
  type PermittedPriceSource,
  type MarketManifestInput,
  type MarketManifest,
} from './market-manifest.js';

export {
  packageTemplateManifest,
  encodePackageTemplateManifest,
  packageTemplateManifestBytes,
  packageTemplateManifestHash,
  type PackageTemplateManifestInput,
  type PackageTemplateManifest,
} from './package-template-manifest.js';

export {
  priceSourceManifest,
  encodePriceSourceManifest,
  priceSourceManifestBytes,
  priceSourceManifestHash,
  type PriceSourceManifestInput,
  type PriceSourceManifest,
} from './price-source-manifest.js';

export {
  packageTemplateRegistryRecord,
  encodePackageTemplateRegistryRecord,
  packageTemplateRegistryRecordBytes,
  packageTemplateRegistryRecordHash,
  type PackageTemplateRegistryRecordInput,
  type PackageTemplateRegistryRecord,
} from './package-template-registry-record.js';
