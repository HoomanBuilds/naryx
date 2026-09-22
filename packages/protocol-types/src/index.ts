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
  PACKAGE_KIND,
  DIRECTION,
  PACKAGE_ACTION,
  SETTLEMENT_CLASS,
  QUANTITY_POLICY_CLASS,
  PARTIAL_FILL_POLICY,
  TEMPLATE_REGISTRY_STATE,
  enumDiscriminant,
  type EnumTable,
  type ExpiryUnit,
  type PackageKind,
  type Direction,
  type PackageAction,
  type SettlementClass,
  type QuantityPolicyClass,
  type PartialFillPolicy,
  type TemplateRegistryState,
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
  ASSET_ATOM_BITS,
  EXPIRY_VALUE_BITS,
  hash32,
  encodeHash32,
  assetId,
  assetAmount,
  encodeAssetAmount,
  expiry,
  encodeExpiry,
  compareExpiry,
  type Hash32,
  type AssetId,
  type AssetAmount,
  type Expiry,
} from './primitives.js';

export { HASH_DOMAIN, domainBytes, domainHash, type HashDomain } from './hashing.js';
