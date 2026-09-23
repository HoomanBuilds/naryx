import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import {
  DIRECTION,
  enumDiscriminant,
  EXPIRY_UNIT,
  PACKAGE_ACTION,
  PACKAGE_ORDER_TYPE,
  PACKAGE_TIME_IN_FORCE,
  PARTIAL_FILL_POLICY,
  QUANTITY_POLICY_CLASS,
  RECOVERY_ACTION,
  SETTLEMENT_CLASS,
  type Direction,
  type ExpiryUnit,
  type PackageAction,
  type PackageOrderType,
  type PackageTimeInForce,
  type PartialFillPolicy,
  type QuantityPolicyClass,
  type RecoveryAction,
  type SettlementClass,
} from './enums.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  adapterRef,
  canonicalAdapterRefs,
  canonicalFeeCaps,
  commitmentHash,
  encodeAdapterRef,
  encodeCommitmentHash,
  encodeExactPrice,
  encodeExactSignedRate,
  encodeFeeCap,
  exactPrice,
  exactSignedRate,
  feeCap,
  type AdapterRef,
  type AdapterRefInput,
  type CommitmentHash,
  type ExactPrice,
  type ExactPriceInput,
  type ExactSignedRate,
  type ExactSignedRateInput,
  type FeeCap,
  type FeeCapInput,
} from './package-order-primitives.js';
import {
  assetAmount,
  domainRef,
  encodeAssetAmount,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  expiry,
  manifestHash,
  protocolId,
  type AssetAmount,
  type DomainRef,
  type Hash32,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const U32_BITS = 32;
const U64_BITS = 64;
const U256_BITS = 256;

export interface PackageOrderInput {
  readonly version: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly owner: string;
  readonly settlementAccount: string;
  readonly nonce: bigint;
  readonly expiryUnit: ExpiryUnit;
  readonly expiryValue: bigint;
  readonly direction: Direction;
  readonly action: PackageAction;
  readonly packageOrderType: PackageOrderType;
  readonly packageTimeInForce: PackageTimeInForce;
  readonly partialFillPolicy: PartialFillPolicy;
  readonly activationConditionHash?: Uint8Array | string;
  readonly executionScheduleHash?: Uint8Array | string;
  readonly quantity: AssetAmount;
  readonly hyperliquidQuantityPolicy?: QuantityPolicyClass;
  readonly hyperliquidGrossSpotQuantity?: AssetAmount;
  readonly hyperliquidMinNetSpotDelta?: AssetAmount;
  readonly hyperliquidMaxNetSpotDelta?: AssetAmount;
  readonly hyperliquidMaxTerminalResidualBaseQuantity?: AssetAmount;
  readonly hyperliquidResidualValuationSchemaVersion?: number;
  readonly hyperliquidResidualValuationReferencePrice?: ExactPriceInput;
  readonly hyperliquidMaxTerminalResidualQuoteValue?: AssetAmount;
  readonly expectedPreStrategySpotQuantity?: AssetAmount;
  readonly hyperliquidRecoveryExpiryUnit?: ExpiryUnit;
  readonly hyperliquidMaxRecoveryActionExpiryValue?: bigint;
  readonly hyperliquidRecoveryDeadlineValue?: bigint;
  readonly hyperliquidMinRecoveryWindowMs?: bigint;
  readonly exitOutcomeSchemaVersion: number;
  readonly entryReceiptHash?: Uint8Array | string;
  readonly expectedPrePositionSize: AssetAmount;
  readonly expectedPrePositionEntryNotional: AssetAmount;
  readonly maxEntrySpread?: ExactSignedRateInput;
  readonly minExitQuoteOutcome?: AssetAmount;
  readonly maxSpotQuoteIn?: AssetAmount;
  readonly minSpotQuoteOut?: AssetAmount;
  readonly hyperliquidMinPerpSellPrice?: ExactPriceInput;
  readonly hyperliquidMaxPerpBuyPrice?: ExactPriceInput;
  readonly maxMarginAdded: AssetAmount;
  readonly minVenueReserveReturned: AssetAmount;
  readonly minWalletQuoteBalanceDelta: AssetAmount;
  readonly maxVenueFeeAtomsByAsset: readonly FeeCapInput[];
  readonly maxProtocolFee: AssetAmount;
  readonly maxSolverFee: AssetAmount;
  readonly maxPriorityFee: AssetAmount;
  readonly maxRecoveryCostAtomsByAsset: readonly FeeCapInput[];
  readonly permittedSpotAdapters: readonly AdapterRefInput[];
  readonly permittedPerpAdapters: readonly AdapterRefInput[];
  readonly settlementClass: SettlementClass;
  readonly maxRecoverySpotBuyPrice?: ExactPriceInput;
  readonly minRecoverySpotSellPrice?: ExactPriceInput;
  readonly minRecoveryPerpSellPrice?: ExactPriceInput;
  readonly maxRecoveryPerpBuyPrice?: ExactPriceInput;
  readonly maxAggregateRecoveryLossQuote: AssetAmount;
  readonly maxResidualBaseQuantity: AssetAmount;
  readonly allowedRecoveryActions: readonly RecoveryAction[];
}

export interface PackageOrder {
  readonly version: number;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly templateId: ProtocolId;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: ManifestHash;
  readonly owner: ProtocolId;
  readonly settlementAccount: ProtocolId;
  readonly nonce: bigint;
  readonly expiryUnit: ExpiryUnit;
  readonly expiryValue: bigint;
  readonly direction: Direction;
  readonly action: PackageAction;
  readonly packageOrderType: PackageOrderType;
  readonly packageTimeInForce: PackageTimeInForce;
  readonly partialFillPolicy: PartialFillPolicy;
  readonly activationConditionHash?: CommitmentHash;
  readonly executionScheduleHash?: CommitmentHash;
  readonly quantity: AssetAmount;
  readonly hyperliquidQuantityPolicy?: QuantityPolicyClass;
  readonly hyperliquidGrossSpotQuantity?: AssetAmount;
  readonly hyperliquidMinNetSpotDelta?: AssetAmount;
  readonly hyperliquidMaxNetSpotDelta?: AssetAmount;
  readonly hyperliquidMaxTerminalResidualBaseQuantity?: AssetAmount;
  readonly hyperliquidResidualValuationSchemaVersion?: number;
  readonly hyperliquidResidualValuationReferencePrice?: ExactPrice;
  readonly hyperliquidMaxTerminalResidualQuoteValue?: AssetAmount;
  readonly expectedPreStrategySpotQuantity?: AssetAmount;
  readonly hyperliquidRecoveryExpiryUnit?: ExpiryUnit;
  readonly hyperliquidMaxRecoveryActionExpiryValue?: bigint;
  readonly hyperliquidRecoveryDeadlineValue?: bigint;
  readonly hyperliquidMinRecoveryWindowMs?: bigint;
  readonly exitOutcomeSchemaVersion: number;
  readonly entryReceiptHash?: CommitmentHash;
  readonly expectedPrePositionSize: AssetAmount;
  readonly expectedPrePositionEntryNotional: AssetAmount;
  readonly maxEntrySpread?: ExactSignedRate;
  readonly minExitQuoteOutcome?: AssetAmount;
  readonly maxSpotQuoteIn?: AssetAmount;
  readonly minSpotQuoteOut?: AssetAmount;
  readonly hyperliquidMinPerpSellPrice?: ExactPrice;
  readonly hyperliquidMaxPerpBuyPrice?: ExactPrice;
  readonly maxMarginAdded: AssetAmount;
  readonly minVenueReserveReturned: AssetAmount;
  readonly minWalletQuoteBalanceDelta: AssetAmount;
  readonly maxVenueFeeAtomsByAsset: readonly FeeCap[];
  readonly maxProtocolFee: AssetAmount;
  readonly maxSolverFee: AssetAmount;
  readonly maxPriorityFee: AssetAmount;
  readonly maxRecoveryCostAtomsByAsset: readonly FeeCap[];
  readonly permittedSpotAdapters: readonly AdapterRef[];
  readonly permittedPerpAdapters: readonly AdapterRef[];
  readonly settlementClass: SettlementClass;
  readonly maxRecoverySpotBuyPrice?: ExactPrice;
  readonly minRecoverySpotSellPrice?: ExactPrice;
  readonly minRecoveryPerpSellPrice?: ExactPrice;
  readonly maxRecoveryPerpBuyPrice?: ExactPrice;
  readonly maxAggregateRecoveryLossQuote: AssetAmount;
  readonly maxResidualBaseQuantity: AssetAmount;
  readonly allowedRecoveryActions: readonly RecoveryAction[];
}

function checkedNumber(value: number, context: string): number {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  return value;
}

function nonzeroU32(value: number, context: string): number {
  const checked = checkedUnsigned(checkedNumber(value, context), U32_BITS, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'version is zero');
  }
  return Number(checked);
}

function u32(value: number, context: string): number {
  return Number(checkedUnsigned(checkedNumber(value, context), U32_BITS, context));
}

function checkedBigInt(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  return value;
}

function u64(value: bigint, context: string): bigint {
  return checkedUnsigned(checkedBigInt(value, context), U64_BITS, context);
}

function positiveU64(value: bigint, context: string): bigint {
  const checked = u64(value, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'value is zero');
  }
  return checked;
}

function u256(value: bigint, context: string): bigint {
  return checkedUnsigned(checkedBigInt(value, context), U256_BITS, context);
}

function checkedDomain(value: DomainRef, context: string): DomainRef {
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

function amount(value: AssetAmount, context: string): AssetAmount {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an asset amount object');
  }
  return assetAmount(value.asset, value.atoms, context);
}

function optionalAmount(
  value: AssetAmount | undefined,
  context: string,
): AssetAmount | undefined {
  return value === undefined ? undefined : amount(value, context);
}

function optionalPrice(
  value: ExactPriceInput | undefined,
  context: string,
): ExactPrice | undefined {
  return value === undefined ? undefined : exactPrice(value, context);
}

function optionalRate(
  value: ExactSignedRateInput | undefined,
  context: string,
): ExactSignedRate | undefined {
  return value === undefined ? undefined : exactSignedRate(value, context);
}

function optionalCommitment(
  value: Uint8Array | string | undefined,
  context: string,
): CommitmentHash | undefined {
  return value === undefined ? undefined : commitmentHash(value, context);
}

function optionalEnum<Name extends string>(
  table: Readonly<Record<Name, number>>,
  value: Name | undefined,
  context: string,
): Name | undefined {
  if (value === undefined) return undefined;
  enumDiscriminant(table, value, context);
  return value;
}

function optionalNonzeroU32(
  value: number | undefined,
  context: string,
): number | undefined {
  return value === undefined ? undefined : nonzeroU32(value, context);
}

function optionalU64(value: bigint | undefined, context: string): bigint | undefined {
  return value === undefined ? undefined : u64(value, context);
}

function optionalPositiveU64(
  value: bigint | undefined,
  context: string,
): bigint | undefined {
  return value === undefined ? undefined : positiveU64(value, context);
}

function orderedRecoveryActions(
  values: readonly RecoveryAction[],
  context: string,
): readonly RecoveryAction[] {
  if (!Array.isArray(values)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  return Object.freeze(
    values.map((value, index) => {
      enumDiscriminant(RECOVERY_ACTION, value, `${context}[${index}]`);
      return value;
    }),
  );
}

function canonicalFeeCapInputs(
  values: readonly FeeCapInput[],
  context: string,
): readonly FeeCap[] {
  if (!Array.isArray(values)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  return canonicalFeeCaps(
    values.map((value, index) => feeCap(value, `${context}[${index}]`)),
    context,
  );
}

function canonicalAdapterInputs(
  values: readonly AdapterRefInput[],
  context: string,
): readonly AdapterRef[] {
  if (!Array.isArray(values)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  return canonicalAdapterRefs(
    values.map((value, index) => adapterRef(value, `${context}[${index}]`)),
    context,
  );
}

function defineOptionalHash(
  target: Record<string, unknown>,
  property: string,
  value: CommitmentHash | undefined,
): void {
  if (value === undefined) return;
  Object.defineProperty(target, property, {
    enumerable: true,
    get(): CommitmentHash {
      return Uint8Array.from(value) as CommitmentHash;
    },
  });
}

export function packageOrder(
  input: PackageOrderInput,
  context = 'packageOrder',
): PackageOrder {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a package order object');
  }

  enumDiscriminant(DIRECTION, input.direction, `${context}.direction`);
  enumDiscriminant(PACKAGE_ACTION, input.action, `${context}.action`);
  enumDiscriminant(
    PACKAGE_ORDER_TYPE,
    input.packageOrderType,
    `${context}.packageOrderType`,
  );
  enumDiscriminant(
    PACKAGE_TIME_IN_FORCE,
    input.packageTimeInForce,
    `${context}.packageTimeInForce`,
  );
  enumDiscriminant(
    PARTIAL_FILL_POLICY,
    input.partialFillPolicy,
    `${context}.partialFillPolicy`,
  );
  enumDiscriminant(
    SETTLEMENT_CLASS,
    input.settlementClass,
    `${context}.settlementClass`,
  );

  const orderExpiry = expiry(
    input.expiryUnit,
    input.expiryValue,
    `${context}.expiry`,
  );
  const packageTemplateHash = manifestHash(
    input.packageTemplateManifestHash,
    `${context}.packageTemplateManifestHash`,
  );
  const activationConditionHash = optionalCommitment(
    input.activationConditionHash,
    `${context}.activationConditionHash`,
  );
  const executionScheduleHash = optionalCommitment(
    input.executionScheduleHash,
    `${context}.executionScheduleHash`,
  );
  const entryReceiptHash = optionalCommitment(
    input.entryReceiptHash,
    `${context}.entryReceiptHash`,
  );

  const value: Record<string, unknown> = {
    version: nonzeroU32(input.version, `${context}.version`),
    environment: protocolId(input.environment, `${context}.environment`),
    domain: checkedDomain(input.domain, `${context}.domain`),
    templateId: protocolId(input.templateId, `${context}.templateId`),
    templateVersion: nonzeroU32(input.templateVersion, `${context}.templateVersion`),
    get packageTemplateManifestHash(): ManifestHash {
      return Uint8Array.from(packageTemplateHash) as ManifestHash;
    },
    owner: protocolId(input.owner, `${context}.owner`),
    settlementAccount: protocolId(input.settlementAccount, `${context}.settlementAccount`),
    nonce: u256(input.nonce, `${context}.nonce`),
    expiryUnit: orderExpiry.unit,
    expiryValue: orderExpiry.value,
    direction: input.direction,
    action: input.action,
    packageOrderType: input.packageOrderType,
    packageTimeInForce: input.packageTimeInForce,
    partialFillPolicy: input.partialFillPolicy,
    quantity: amount(input.quantity, `${context}.quantity`),
    ...(input.hyperliquidQuantityPolicy === undefined
      ? {}
      : {
          hyperliquidQuantityPolicy: optionalEnum(
            QUANTITY_POLICY_CLASS,
            input.hyperliquidQuantityPolicy,
            `${context}.hyperliquidQuantityPolicy`,
          ),
        }),
    ...(input.hyperliquidGrossSpotQuantity === undefined
      ? {}
      : {
          hyperliquidGrossSpotQuantity: optionalAmount(
            input.hyperliquidGrossSpotQuantity,
            `${context}.hyperliquidGrossSpotQuantity`,
          ),
        }),
    ...(input.hyperliquidMinNetSpotDelta === undefined
      ? {}
      : {
          hyperliquidMinNetSpotDelta: optionalAmount(
            input.hyperliquidMinNetSpotDelta,
            `${context}.hyperliquidMinNetSpotDelta`,
          ),
        }),
    ...(input.hyperliquidMaxNetSpotDelta === undefined
      ? {}
      : {
          hyperliquidMaxNetSpotDelta: optionalAmount(
            input.hyperliquidMaxNetSpotDelta,
            `${context}.hyperliquidMaxNetSpotDelta`,
          ),
        }),
    ...(input.hyperliquidMaxTerminalResidualBaseQuantity === undefined
      ? {}
      : {
          hyperliquidMaxTerminalResidualBaseQuantity: optionalAmount(
            input.hyperliquidMaxTerminalResidualBaseQuantity,
            `${context}.hyperliquidMaxTerminalResidualBaseQuantity`,
          ),
        }),
    ...(input.hyperliquidResidualValuationSchemaVersion === undefined
      ? {}
      : {
          hyperliquidResidualValuationSchemaVersion: optionalNonzeroU32(
            input.hyperliquidResidualValuationSchemaVersion,
            `${context}.hyperliquidResidualValuationSchemaVersion`,
          ),
        }),
    ...(input.hyperliquidResidualValuationReferencePrice === undefined
      ? {}
      : {
          hyperliquidResidualValuationReferencePrice: optionalPrice(
            input.hyperliquidResidualValuationReferencePrice,
            `${context}.hyperliquidResidualValuationReferencePrice`,
          ),
        }),
    ...(input.hyperliquidMaxTerminalResidualQuoteValue === undefined
      ? {}
      : {
          hyperliquidMaxTerminalResidualQuoteValue: optionalAmount(
            input.hyperliquidMaxTerminalResidualQuoteValue,
            `${context}.hyperliquidMaxTerminalResidualQuoteValue`,
          ),
        }),
    ...(input.expectedPreStrategySpotQuantity === undefined
      ? {}
      : {
          expectedPreStrategySpotQuantity: optionalAmount(
            input.expectedPreStrategySpotQuantity,
            `${context}.expectedPreStrategySpotQuantity`,
          ),
        }),
    ...(input.hyperliquidRecoveryExpiryUnit === undefined
      ? {}
      : {
          hyperliquidRecoveryExpiryUnit: optionalEnum(
            EXPIRY_UNIT,
            input.hyperliquidRecoveryExpiryUnit,
            `${context}.hyperliquidRecoveryExpiryUnit`,
          ),
        }),
    ...(input.hyperliquidMaxRecoveryActionExpiryValue === undefined
      ? {}
      : {
          hyperliquidMaxRecoveryActionExpiryValue: optionalU64(
            input.hyperliquidMaxRecoveryActionExpiryValue,
            `${context}.hyperliquidMaxRecoveryActionExpiryValue`,
          ),
        }),
    ...(input.hyperliquidRecoveryDeadlineValue === undefined
      ? {}
      : {
          hyperliquidRecoveryDeadlineValue: optionalU64(
            input.hyperliquidRecoveryDeadlineValue,
            `${context}.hyperliquidRecoveryDeadlineValue`,
          ),
        }),
    ...(input.hyperliquidMinRecoveryWindowMs === undefined
      ? {}
      : {
          hyperliquidMinRecoveryWindowMs: optionalPositiveU64(
            input.hyperliquidMinRecoveryWindowMs,
            `${context}.hyperliquidMinRecoveryWindowMs`,
          ),
        }),
    exitOutcomeSchemaVersion: u32(
      input.exitOutcomeSchemaVersion,
      `${context}.exitOutcomeSchemaVersion`,
    ),
    expectedPrePositionSize: amount(
      input.expectedPrePositionSize,
      `${context}.expectedPrePositionSize`,
    ),
    expectedPrePositionEntryNotional: amount(
      input.expectedPrePositionEntryNotional,
      `${context}.expectedPrePositionEntryNotional`,
    ),
    ...(input.maxEntrySpread === undefined
      ? {}
      : { maxEntrySpread: optionalRate(input.maxEntrySpread, `${context}.maxEntrySpread`) }),
    ...(input.minExitQuoteOutcome === undefined
      ? {}
      : {
          minExitQuoteOutcome: optionalAmount(
            input.minExitQuoteOutcome,
            `${context}.minExitQuoteOutcome`,
          ),
        }),
    ...(input.maxSpotQuoteIn === undefined
      ? {}
      : { maxSpotQuoteIn: optionalAmount(input.maxSpotQuoteIn, `${context}.maxSpotQuoteIn`) }),
    ...(input.minSpotQuoteOut === undefined
      ? {}
      : {
          minSpotQuoteOut: optionalAmount(input.minSpotQuoteOut, `${context}.minSpotQuoteOut`),
        }),
    ...(input.hyperliquidMinPerpSellPrice === undefined
      ? {}
      : {
          hyperliquidMinPerpSellPrice: optionalPrice(
            input.hyperliquidMinPerpSellPrice,
            `${context}.hyperliquidMinPerpSellPrice`,
          ),
        }),
    ...(input.hyperliquidMaxPerpBuyPrice === undefined
      ? {}
      : {
          hyperliquidMaxPerpBuyPrice: optionalPrice(
            input.hyperliquidMaxPerpBuyPrice,
            `${context}.hyperliquidMaxPerpBuyPrice`,
          ),
        }),
    maxMarginAdded: amount(input.maxMarginAdded, `${context}.maxMarginAdded`),
    minVenueReserveReturned: amount(
      input.minVenueReserveReturned,
      `${context}.minVenueReserveReturned`,
    ),
    minWalletQuoteBalanceDelta: amount(
      input.minWalletQuoteBalanceDelta,
      `${context}.minWalletQuoteBalanceDelta`,
    ),
    maxVenueFeeAtomsByAsset: canonicalFeeCapInputs(
      input.maxVenueFeeAtomsByAsset,
      `${context}.maxVenueFeeAtomsByAsset`,
    ),
    maxProtocolFee: amount(input.maxProtocolFee, `${context}.maxProtocolFee`),
    maxSolverFee: amount(input.maxSolverFee, `${context}.maxSolverFee`),
    maxPriorityFee: amount(input.maxPriorityFee, `${context}.maxPriorityFee`),
    maxRecoveryCostAtomsByAsset: canonicalFeeCapInputs(
      input.maxRecoveryCostAtomsByAsset,
      `${context}.maxRecoveryCostAtomsByAsset`,
    ),
    permittedSpotAdapters: canonicalAdapterInputs(
      input.permittedSpotAdapters,
      `${context}.permittedSpotAdapters`,
    ),
    permittedPerpAdapters: canonicalAdapterInputs(
      input.permittedPerpAdapters,
      `${context}.permittedPerpAdapters`,
    ),
    settlementClass: input.settlementClass,
    ...(input.maxRecoverySpotBuyPrice === undefined
      ? {}
      : {
          maxRecoverySpotBuyPrice: optionalPrice(
            input.maxRecoverySpotBuyPrice,
            `${context}.maxRecoverySpotBuyPrice`,
          ),
        }),
    ...(input.minRecoverySpotSellPrice === undefined
      ? {}
      : {
          minRecoverySpotSellPrice: optionalPrice(
            input.minRecoverySpotSellPrice,
            `${context}.minRecoverySpotSellPrice`,
          ),
        }),
    ...(input.minRecoveryPerpSellPrice === undefined
      ? {}
      : {
          minRecoveryPerpSellPrice: optionalPrice(
            input.minRecoveryPerpSellPrice,
            `${context}.minRecoveryPerpSellPrice`,
          ),
        }),
    ...(input.maxRecoveryPerpBuyPrice === undefined
      ? {}
      : {
          maxRecoveryPerpBuyPrice: optionalPrice(
            input.maxRecoveryPerpBuyPrice,
            `${context}.maxRecoveryPerpBuyPrice`,
          ),
        }),
    maxAggregateRecoveryLossQuote: amount(
      input.maxAggregateRecoveryLossQuote,
      `${context}.maxAggregateRecoveryLossQuote`,
    ),
    maxResidualBaseQuantity: amount(
      input.maxResidualBaseQuantity,
      `${context}.maxResidualBaseQuantity`,
    ),
    allowedRecoveryActions: orderedRecoveryActions(
      input.allowedRecoveryActions,
      `${context}.allowedRecoveryActions`,
    ),
  };

  defineOptionalHash(value, 'activationConditionHash', activationConditionHash);
  defineOptionalHash(value, 'executionScheduleHash', executionScheduleHash);
  defineOptionalHash(value, 'entryReceiptHash', entryReceiptHash);
  return Object.freeze(value) as unknown as PackageOrder;
}

function requireCanonicalHash(value: unknown, context: string): void {
  if (!(value instanceof Uint8Array)) {
    throw new MalformedInputError(context, 'expected 32 canonical bytes');
  }
}

function checkedPackageOrder(value: PackageOrder, context: string): PackageOrder {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a package order object');
  }
  requireCanonicalHash(
    value.packageTemplateManifestHash,
    `${context}.packageTemplateManifestHash`,
  );
  if (value.activationConditionHash !== undefined) {
    requireCanonicalHash(value.activationConditionHash, `${context}.activationConditionHash`);
  }
  if (value.executionScheduleHash !== undefined) {
    requireCanonicalHash(value.executionScheduleHash, `${context}.executionScheduleHash`);
  }
  if (value.entryReceiptHash !== undefined) {
    requireCanonicalHash(value.entryReceiptHash, `${context}.entryReceiptHash`);
  }
  if (!Array.isArray(value.permittedSpotAdapters)) {
    throw new MalformedInputError(`${context}.permittedSpotAdapters`, 'expected an array');
  }
  if (!Array.isArray(value.permittedPerpAdapters)) {
    throw new MalformedInputError(`${context}.permittedPerpAdapters`, 'expected an array');
  }
  for (const [index, reference] of value.permittedSpotAdapters.entries()) {
    if (typeof reference !== 'object' || reference === null) {
      throw new MalformedInputError(
        `${context}.permittedSpotAdapters[${index}]`,
        'expected an adapter reference object',
      );
    }
    requireCanonicalHash(
      reference.adapterManifestHash,
      `${context}.permittedSpotAdapters[${index}].adapterManifestHash`,
    );
  }
  for (const [index, reference] of value.permittedPerpAdapters.entries()) {
    if (typeof reference !== 'object' || reference === null) {
      throw new MalformedInputError(
        `${context}.permittedPerpAdapters[${index}]`,
        'expected an adapter reference object',
      );
    }
    requireCanonicalHash(
      reference.adapterManifestHash,
      `${context}.permittedPerpAdapters[${index}].adapterManifestHash`,
    );
  }
  return packageOrder(value, context);
}

function writeOptionalAmount(
  writer: CanonicalWriter,
  value: AssetAmount | undefined,
  context: string,
): void {
  writer.writeOptional(value, encodeAssetAmount, context);
}

function writeOptionalPrice(
  writer: CanonicalWriter,
  value: ExactPrice | undefined,
  context: string,
): void {
  writer.writeOptional(value, encodeExactPrice, context);
}

export function encodePackageOrder(
  writer: CanonicalWriter,
  value: PackageOrder,
): void {
  const checked = checkedPackageOrder(value, 'packageOrder');
  writer.writeU32(checked.version, 'packageOrder.version');
  encodeProtocolId(writer, checked.environment, 'packageOrder.environment');
  encodeDomainRef(writer, checked.domain);
  encodeProtocolId(writer, checked.templateId, 'packageOrder.templateId');
  writer.writeU32(checked.templateVersion, 'packageOrder.templateVersion');
  encodeManifestHash(
    writer,
    checked.packageTemplateManifestHash,
    'packageOrder.packageTemplateManifestHash',
  );
  encodeProtocolId(writer, checked.owner, 'packageOrder.owner');
  encodeProtocolId(writer, checked.settlementAccount, 'packageOrder.settlementAccount');
  writer.writeU256(checked.nonce, 'packageOrder.nonce');
  writer.writeEnum(EXPIRY_UNIT, checked.expiryUnit, 'packageOrder.expiryUnit');
  writer.writeU64(checked.expiryValue, 'packageOrder.expiryValue');
  writer.writeEnum(DIRECTION, checked.direction, 'packageOrder.direction');
  writer.writeEnum(PACKAGE_ACTION, checked.action, 'packageOrder.action');
  writer.writeEnum(PACKAGE_ORDER_TYPE, checked.packageOrderType, 'packageOrder.packageOrderType');
  writer.writeEnum(
    PACKAGE_TIME_IN_FORCE,
    checked.packageTimeInForce,
    'packageOrder.packageTimeInForce',
  );
  writer.writeEnum(
    PARTIAL_FILL_POLICY,
    checked.partialFillPolicy,
    'packageOrder.partialFillPolicy',
  );
  writer.writeOptional(
    checked.activationConditionHash,
    encodeCommitmentHash,
    'packageOrder.activationConditionHash',
  );
  writer.writeOptional(
    checked.executionScheduleHash,
    encodeCommitmentHash,
    'packageOrder.executionScheduleHash',
  );
  encodeAssetAmount(writer, checked.quantity);
  writer.writeOptional(
    checked.hyperliquidQuantityPolicy,
    (target, item) =>
      target.writeEnum(
        QUANTITY_POLICY_CLASS,
        item,
        'packageOrder.hyperliquidQuantityPolicy.value',
      ),
    'packageOrder.hyperliquidQuantityPolicy',
  );
  writeOptionalAmount(
    writer,
    checked.hyperliquidGrossSpotQuantity,
    'packageOrder.hyperliquidGrossSpotQuantity',
  );
  writeOptionalAmount(
    writer,
    checked.hyperliquidMinNetSpotDelta,
    'packageOrder.hyperliquidMinNetSpotDelta',
  );
  writeOptionalAmount(
    writer,
    checked.hyperliquidMaxNetSpotDelta,
    'packageOrder.hyperliquidMaxNetSpotDelta',
  );
  writeOptionalAmount(
    writer,
    checked.hyperliquidMaxTerminalResidualBaseQuantity,
    'packageOrder.hyperliquidMaxTerminalResidualBaseQuantity',
  );
  writer.writeOptional(
    checked.hyperliquidResidualValuationSchemaVersion,
    (target, item) =>
      target.writeU32(item, 'packageOrder.hyperliquidResidualValuationSchemaVersion.value'),
    'packageOrder.hyperliquidResidualValuationSchemaVersion',
  );
  writeOptionalPrice(
    writer,
    checked.hyperliquidResidualValuationReferencePrice,
    'packageOrder.hyperliquidResidualValuationReferencePrice',
  );
  writeOptionalAmount(
    writer,
    checked.hyperliquidMaxTerminalResidualQuoteValue,
    'packageOrder.hyperliquidMaxTerminalResidualQuoteValue',
  );
  writeOptionalAmount(
    writer,
    checked.expectedPreStrategySpotQuantity,
    'packageOrder.expectedPreStrategySpotQuantity',
  );
  writer.writeOptional(
    checked.hyperliquidRecoveryExpiryUnit,
    (target, item) =>
      target.writeEnum(EXPIRY_UNIT, item, 'packageOrder.hyperliquidRecoveryExpiryUnit.value'),
    'packageOrder.hyperliquidRecoveryExpiryUnit',
  );
  writer.writeOptional(
    checked.hyperliquidMaxRecoveryActionExpiryValue,
    (target, item) =>
      target.writeU64(item, 'packageOrder.hyperliquidMaxRecoveryActionExpiryValue.value'),
    'packageOrder.hyperliquidMaxRecoveryActionExpiryValue',
  );
  writer.writeOptional(
    checked.hyperliquidRecoveryDeadlineValue,
    (target, item) =>
      target.writeU64(item, 'packageOrder.hyperliquidRecoveryDeadlineValue.value'),
    'packageOrder.hyperliquidRecoveryDeadlineValue',
  );
  writer.writeOptional(
    checked.hyperliquidMinRecoveryWindowMs,
    (target, item) =>
      target.writeU64(item, 'packageOrder.hyperliquidMinRecoveryWindowMs.value'),
    'packageOrder.hyperliquidMinRecoveryWindowMs',
  );
  writer.writeU32(
    checked.exitOutcomeSchemaVersion,
    'packageOrder.exitOutcomeSchemaVersion',
  );
  writer.writeOptional(
    checked.entryReceiptHash,
    encodeCommitmentHash,
    'packageOrder.entryReceiptHash',
  );
  encodeAssetAmount(writer, checked.expectedPrePositionSize);
  encodeAssetAmount(writer, checked.expectedPrePositionEntryNotional);
  writer.writeOptional(checked.maxEntrySpread, encodeExactSignedRate, 'packageOrder.maxEntrySpread');
  writeOptionalAmount(writer, checked.minExitQuoteOutcome, 'packageOrder.minExitQuoteOutcome');
  writeOptionalAmount(writer, checked.maxSpotQuoteIn, 'packageOrder.maxSpotQuoteIn');
  writeOptionalAmount(writer, checked.minSpotQuoteOut, 'packageOrder.minSpotQuoteOut');
  writeOptionalPrice(
    writer,
    checked.hyperliquidMinPerpSellPrice,
    'packageOrder.hyperliquidMinPerpSellPrice',
  );
  writeOptionalPrice(
    writer,
    checked.hyperliquidMaxPerpBuyPrice,
    'packageOrder.hyperliquidMaxPerpBuyPrice',
  );
  encodeAssetAmount(writer, checked.maxMarginAdded);
  encodeAssetAmount(writer, checked.minVenueReserveReturned);
  encodeAssetAmount(writer, checked.minWalletQuoteBalanceDelta);
  writer.writeArray(
    checked.maxVenueFeeAtomsByAsset,
    encodeFeeCap,
    'packageOrder.maxVenueFeeAtomsByAsset',
  );
  encodeAssetAmount(writer, checked.maxProtocolFee);
  encodeAssetAmount(writer, checked.maxSolverFee);
  encodeAssetAmount(writer, checked.maxPriorityFee);
  writer.writeArray(
    checked.maxRecoveryCostAtomsByAsset,
    encodeFeeCap,
    'packageOrder.maxRecoveryCostAtomsByAsset',
  );
  writer.writeArray(
    checked.permittedSpotAdapters,
    encodeAdapterRef,
    'packageOrder.permittedSpotAdapters',
  );
  writer.writeArray(
    checked.permittedPerpAdapters,
    encodeAdapterRef,
    'packageOrder.permittedPerpAdapters',
  );
  writer.writeEnum(SETTLEMENT_CLASS, checked.settlementClass, 'packageOrder.settlementClass');
  writeOptionalPrice(
    writer,
    checked.maxRecoverySpotBuyPrice,
    'packageOrder.maxRecoverySpotBuyPrice',
  );
  writeOptionalPrice(
    writer,
    checked.minRecoverySpotSellPrice,
    'packageOrder.minRecoverySpotSellPrice',
  );
  writeOptionalPrice(
    writer,
    checked.minRecoveryPerpSellPrice,
    'packageOrder.minRecoveryPerpSellPrice',
  );
  writeOptionalPrice(
    writer,
    checked.maxRecoveryPerpBuyPrice,
    'packageOrder.maxRecoveryPerpBuyPrice',
  );
  encodeAssetAmount(writer, checked.maxAggregateRecoveryLossQuote);
  encodeAssetAmount(writer, checked.maxResidualBaseQuantity);
  writer.writeArray(
    checked.allowedRecoveryActions,
    (target, item) =>
      target.writeEnum(RECOVERY_ACTION, item, 'packageOrder.allowedRecoveryActions.value'),
    'packageOrder.allowedRecoveryActions',
  );
}

export function packageOrderBytes(value: PackageOrderInput): Uint8Array {
  const checked = packageOrder(value, 'packageOrder');
  return canonicalBytes((writer) => encodePackageOrder(writer, checked));
}

export function packageOrderHash(value: PackageOrderInput): Hash32 {
  return domainHash(HASH_DOMAIN.ORDER, packageOrderBytes(value), 'packageOrderHash');
}
