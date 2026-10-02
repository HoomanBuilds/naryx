import { bytesEqual } from './bytes.js';
import { MalformedInputError } from './errors.js';
import { type PackageOrder, type PackageOrderInput, packageOrder } from './package-order.js';
import type { ExactPrice, ExactSignedRate, FeeCap } from './package-order-primitives.js';
import type { AssetAmount, AssetRef } from './primitives.js';

function requireCondition(
  condition: boolean,
  context: string,
  message: string,
): asserts condition {
  if (!condition) {
    throw new MalformedInputError(context, message);
  }
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function requireAsset(
  actual: AssetRef,
  expected: AssetRef,
  context: string,
): void {
  requireCondition(
    sameAsset(actual, expected),
    context,
    `asset must equal ${expected.assetId}`,
  );
}

function requireAmountAsset(
  value: AssetAmount,
  expected: AssetRef,
  context: string,
): void {
  requireAsset(value.asset, expected, `${context}.asset`);
}

function requirePriceAssets(
  value: ExactPrice,
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  context: string,
): void {
  requireAsset(value.baseAsset, baseAsset, `${context}.baseAsset`);
  requireAsset(value.quoteAsset, quoteAsset, `${context}.quoteAsset`);
}

function requireRateAssets(
  value: ExactSignedRate,
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  context: string,
): void {
  requireAsset(value.baseAsset, baseAsset, `${context}.baseAsset`);
  requireAsset(value.quoteAsset, quoteAsset, `${context}.quoteAsset`);
}

function requirePresent<T>(
  value: T | undefined,
  context: string,
): asserts value is T {
  requireCondition(value !== undefined, context, 'field is required');
}

function requireAbsent(value: unknown, context: string): void {
  requireCondition(value === undefined, context, 'field must be absent');
}

function validateInitialActivation(order: PackageOrder, context: string): void {
  requireCondition(
    order.packageOrderType === 'MARKETABLE_LIMIT',
    `${context}.packageOrderType`,
    'initial activation requires MARKETABLE_LIMIT',
  );
  requireCondition(
    order.partialFillPolicy === 'EXACT_ALL_LEGS',
    `${context}.partialFillPolicy`,
    'initial activation requires EXACT_ALL_LEGS',
  );
  // Only the batched Hyperliquid class fills immediate-or-cancel; atomic and asynchronous bonded
  // packages fill every leg exactly or not at all.
  const expectedTimeInForce = order.settlementClass === 'BATCHED_IOC_WITH_RECOVERY'
    ? 'IOC'
    : 'FOK';
  requireCondition(
    order.packageTimeInForce === expectedTimeInForce,
    `${context}.packageTimeInForce`,
    `initial activation requires ${expectedTimeInForce}`,
  );
}

function validateActionShape(order: PackageOrder, context: string): AssetRef {
  if (order.action === 'ENTRY') {
    requirePresent(order.maxEntrySpread, `${context}.maxEntrySpread`);
    requirePresent(order.maxSpotQuoteIn, `${context}.maxSpotQuoteIn`);
    requireAbsent(order.minExitQuoteOutcome, `${context}.minExitQuoteOutcome`);
    requireAbsent(order.minSpotQuoteOut, `${context}.minSpotQuoteOut`);
    requireAbsent(order.entryReceiptHash, `${context}.entryReceiptHash`);
    requireCondition(
      order.exitOutcomeSchemaVersion === 0,
      `${context}.exitOutcomeSchemaVersion`,
      'entry requires the NONE schema version',
    );
    requireCondition(
      order.expectedPrePositionSize.atoms === 0n,
      `${context}.expectedPrePositionSize.atoms`,
      'entry requires zero pre-position size',
    );
    requireCondition(
      order.expectedPrePositionEntryNotional.atoms === 0n,
      `${context}.expectedPrePositionEntryNotional.atoms`,
      'entry requires zero pre-position entry notional',
    );
    requireCondition(
      order.maxSpotQuoteIn.atoms > 0n,
      `${context}.maxSpotQuoteIn.atoms`,
      'entry quote cap must be positive',
    );
    return order.maxSpotQuoteIn.asset;
  }

  requirePresent(order.minExitQuoteOutcome, `${context}.minExitQuoteOutcome`);
  requirePresent(order.minSpotQuoteOut, `${context}.minSpotQuoteOut`);
  requireAbsent(order.maxEntrySpread, `${context}.maxEntrySpread`);
  requireAbsent(order.maxSpotQuoteIn, `${context}.maxSpotQuoteIn`);
  requireCondition(
    order.exitOutcomeSchemaVersion > 0,
    `${context}.exitOutcomeSchemaVersion`,
    'exit requires a nonzero outcome schema version',
  );
  requireCondition(
    order.expectedPrePositionSize.atoms < 0n,
    `${context}.expectedPrePositionSize.atoms`,
    'long-spot short-perp exit requires a negative pre-position size',
  );
  requireCondition(
    order.expectedPrePositionEntryNotional.atoms > 0n,
    `${context}.expectedPrePositionEntryNotional.atoms`,
    'exit requires a positive pre-position entry notional',
  );
  requireCondition(
    order.minSpotQuoteOut.atoms >= 0n,
    `${context}.minSpotQuoteOut.atoms`,
    'exit quote floor must be nonnegative',
  );
  return order.minSpotQuoteOut.asset;
}

function validateAmountAssets(
  order: PackageOrder,
  baseAsset: AssetRef,
  quoteAsset: AssetRef,
  context: string,
): void {
  requireAmountAsset(order.quantity, baseAsset, `${context}.quantity`);
  requireAmountAsset(
    order.expectedPrePositionSize,
    baseAsset,
    `${context}.expectedPrePositionSize`,
  );
  requireAmountAsset(
    order.expectedPrePositionEntryNotional,
    quoteAsset,
    `${context}.expectedPrePositionEntryNotional`,
  );
  requireAmountAsset(order.maxMarginAdded, quoteAsset, `${context}.maxMarginAdded`);
  requireAmountAsset(
    order.minVenueReserveReturned,
    quoteAsset,
    `${context}.minVenueReserveReturned`,
  );
  requireAmountAsset(
    order.minWalletQuoteBalanceDelta,
    quoteAsset,
    `${context}.minWalletQuoteBalanceDelta`,
  );
  requireAmountAsset(order.maxProtocolFee, quoteAsset, `${context}.maxProtocolFee`);
  requireAmountAsset(order.maxSolverFee, quoteAsset, `${context}.maxSolverFee`);
  requireAmountAsset(
    order.maxAggregateRecoveryLossQuote,
    quoteAsset,
    `${context}.maxAggregateRecoveryLossQuote`,
  );
  requireAmountAsset(
    order.maxResidualBaseQuantity,
    baseAsset,
    `${context}.maxResidualBaseQuantity`,
  );

  const baseAmounts: readonly [string, AssetAmount | undefined][] = [
    ['hyperliquidGrossSpotQuantity', order.hyperliquidGrossSpotQuantity],
    ['hyperliquidMinNetSpotDelta', order.hyperliquidMinNetSpotDelta],
    ['hyperliquidMaxNetSpotDelta', order.hyperliquidMaxNetSpotDelta],
    [
      'hyperliquidMaxTerminalResidualBaseQuantity',
      order.hyperliquidMaxTerminalResidualBaseQuantity,
    ],
    ['expectedPreStrategySpotQuantity', order.expectedPreStrategySpotQuantity],
  ];
  for (const [name, value] of baseAmounts) {
    if (value !== undefined) {
      requireAmountAsset(value, baseAsset, `${context}.${name}`);
    }
  }

  const quoteAmounts: readonly [string, AssetAmount | undefined][] = [
    [
      'hyperliquidMaxTerminalResidualQuoteValue',
      order.hyperliquidMaxTerminalResidualQuoteValue,
    ],
    ['minExitQuoteOutcome', order.minExitQuoteOutcome],
    ['maxSpotQuoteIn', order.maxSpotQuoteIn],
    ['minSpotQuoteOut', order.minSpotQuoteOut],
  ];
  for (const [name, value] of quoteAmounts) {
    if (value !== undefined) {
      requireAmountAsset(value, quoteAsset, `${context}.${name}`);
    }
  }

  if (order.maxEntrySpread !== undefined) {
    requireRateAssets(order.maxEntrySpread, baseAsset, quoteAsset, `${context}.maxEntrySpread`);
  }

  const prices: readonly [string, ExactPrice | undefined][] = [
    [
      'hyperliquidResidualValuationReferencePrice',
      order.hyperliquidResidualValuationReferencePrice,
    ],
    ['hyperliquidMinPerpSellPrice', order.hyperliquidMinPerpSellPrice],
    ['hyperliquidMaxPerpBuyPrice', order.hyperliquidMaxPerpBuyPrice],
    ['maxRecoverySpotBuyPrice', order.maxRecoverySpotBuyPrice],
    ['minRecoverySpotSellPrice', order.minRecoverySpotSellPrice],
    ['minRecoveryPerpSellPrice', order.minRecoveryPerpSellPrice],
    ['maxRecoveryPerpBuyPrice', order.maxRecoveryPerpBuyPrice],
  ];
  for (const [name, value] of prices) {
    if (value !== undefined) {
      requirePriceAssets(value, baseAsset, quoteAsset, `${context}.${name}`);
    }
  }
}

function validateCommonBounds(order: PackageOrder, context: string): void {
  requireCondition(
    order.quantity.atoms > 0n,
    `${context}.quantity.atoms`,
    'quantity must be positive',
  );
  requireCondition(
    order.maxMarginAdded.atoms >= 0n,
    `${context}.maxMarginAdded.atoms`,
    'margin cap must be nonnegative',
  );
  requireCondition(
    order.maxPriorityFee.atoms >= 0n,
    `${context}.maxPriorityFee.atoms`,
    'priority fee cap must be nonnegative',
  );
  requireCondition(
    order.maxAggregateRecoveryLossQuote.atoms >= 0n,
    `${context}.maxAggregateRecoveryLossQuote.atoms`,
    'aggregate recovery loss cap must be nonnegative',
  );
  requireCondition(
    order.maxResidualBaseQuantity.atoms >= 0n,
    `${context}.maxResidualBaseQuantity.atoms`,
    'residual cap must be nonnegative',
  );
}

function requireEmptyRecoveryCaps(values: readonly FeeCap[], context: string): void {
  requireCondition(values.length === 0, context, 'recovery cost caps must be empty');
}

function validateAtomicProfile(order: PackageOrder, context: string): void {
  requireCondition(
    order.expiryUnit === 'SOLANA_SLOT' || order.expiryUnit === 'EVM_UNIX_SECONDS',
    `${context}.expiryUnit`,
    'atomic profile requires a Solana or EVM clock',
  );
  requireNoHyperliquidOrRecoveryTerms(order, context, 'atomic');
}

/**
 * Asynchronous bonded entry and full-close exit (Arbitrum GMX) on the EVM clock. Entry opens both
 * legs under a solver performance bond; exit closes the whole short and then sells the exact spot
 * inventory under the owner's own exit authorization. The trader signs no recovery terms.
 */
function validateAsyncBondedProfile(order: PackageOrder, context: string): void {
  requireCondition(
    order.expiryUnit === 'EVM_UNIX_SECONDS',
    `${context}.expiryUnit`,
    'asynchronous bonded profile requires the EVM clock',
  );
  requireNoHyperliquidOrRecoveryTerms(order, context, 'asynchronous bonded');
}

function requireNoHyperliquidOrRecoveryTerms(order: PackageOrder, context: string, profile: string): void {
  const forbidden: readonly [string, unknown][] = [
    ['hyperliquidQuantityPolicy', order.hyperliquidQuantityPolicy],
    ['hyperliquidGrossSpotQuantity', order.hyperliquidGrossSpotQuantity],
    ['hyperliquidMinNetSpotDelta', order.hyperliquidMinNetSpotDelta],
    ['hyperliquidMaxNetSpotDelta', order.hyperliquidMaxNetSpotDelta],
    [
      'hyperliquidMaxTerminalResidualBaseQuantity',
      order.hyperliquidMaxTerminalResidualBaseQuantity,
    ],
    [
      'hyperliquidResidualValuationSchemaVersion',
      order.hyperliquidResidualValuationSchemaVersion,
    ],
    [
      'hyperliquidResidualValuationReferencePrice',
      order.hyperliquidResidualValuationReferencePrice,
    ],
    [
      'hyperliquidMaxTerminalResidualQuoteValue',
      order.hyperliquidMaxTerminalResidualQuoteValue,
    ],
    ['expectedPreStrategySpotQuantity', order.expectedPreStrategySpotQuantity],
    ['hyperliquidRecoveryExpiryUnit', order.hyperliquidRecoveryExpiryUnit],
    [
      'hyperliquidMaxRecoveryActionExpiryValue',
      order.hyperliquidMaxRecoveryActionExpiryValue,
    ],
    ['hyperliquidRecoveryDeadlineValue', order.hyperliquidRecoveryDeadlineValue],
    ['hyperliquidMinRecoveryWindowMs', order.hyperliquidMinRecoveryWindowMs],
    ['hyperliquidMinPerpSellPrice', order.hyperliquidMinPerpSellPrice],
    ['hyperliquidMaxPerpBuyPrice', order.hyperliquidMaxPerpBuyPrice],
    ['maxRecoverySpotBuyPrice', order.maxRecoverySpotBuyPrice],
    ['minRecoverySpotSellPrice', order.minRecoverySpotSellPrice],
    ['minRecoveryPerpSellPrice', order.minRecoveryPerpSellPrice],
    ['maxRecoveryPerpBuyPrice', order.maxRecoveryPerpBuyPrice],
  ];
  for (const [name, value] of forbidden) {
    requireAbsent(value, `${context}.${name}`);
  }
  requireEmptyRecoveryCaps(
    order.maxRecoveryCostAtomsByAsset,
    `${context}.maxRecoveryCostAtomsByAsset`,
  );
  requireCondition(
    order.allowedRecoveryActions.length === 0,
    `${context}.allowedRecoveryActions`,
    `${profile} profile forbids recovery actions`,
  );
  requireCondition(
    order.maxAggregateRecoveryLossQuote.atoms === 0n,
    `${context}.maxAggregateRecoveryLossQuote.atoms`,
    `${profile} profile requires zero recovery loss`,
  );
}

function validateHyperliquidActionFields(order: PackageOrder, context: string): void {
  if (order.action === 'ENTRY') {
    requirePresent(
      order.hyperliquidMinPerpSellPrice,
      `${context}.hyperliquidMinPerpSellPrice`,
    );
    requireAbsent(
      order.hyperliquidMaxPerpBuyPrice,
      `${context}.hyperliquidMaxPerpBuyPrice`,
    );
    return;
  }
  requirePresent(
    order.hyperliquidMaxPerpBuyPrice,
    `${context}.hyperliquidMaxPerpBuyPrice`,
  );
  requireAbsent(
    order.hyperliquidMinPerpSellPrice,
    `${context}.hyperliquidMinPerpSellPrice`,
  );
  requirePresent(
    order.expectedPreStrategySpotQuantity,
    `${context}.expectedPreStrategySpotQuantity`,
  );
  requireCondition(
    order.expectedPreStrategySpotQuantity.atoms > 0n,
    `${context}.expectedPreStrategySpotQuantity.atoms`,
    'Hyperliquid exit requires positive eligible spot inventory',
  );
}

function validateHyperliquidTiming(order: PackageOrder, context: string): void {
  requireCondition(
    order.expiryUnit === 'HYPERLIQUID_UNIX_MILLISECONDS',
    `${context}.expiryUnit`,
    'Hyperliquid profile requires the Hyperliquid millisecond clock',
  );
  requireCondition(
    order.hyperliquidRecoveryExpiryUnit === 'HYPERLIQUID_UNIX_MILLISECONDS',
    `${context}.hyperliquidRecoveryExpiryUnit`,
    'recovery expiry unit must be HYPERLIQUID_UNIX_MILLISECONDS',
  );
  requirePresent(
    order.hyperliquidMaxRecoveryActionExpiryValue,
    `${context}.hyperliquidMaxRecoveryActionExpiryValue`,
  );
  requirePresent(
    order.hyperliquidRecoveryDeadlineValue,
    `${context}.hyperliquidRecoveryDeadlineValue`,
  );
  requirePresent(
    order.hyperliquidMinRecoveryWindowMs,
    `${context}.hyperliquidMinRecoveryWindowMs`,
  );
  requireCondition(
    order.hyperliquidMaxRecoveryActionExpiryValue
      < order.hyperliquidRecoveryDeadlineValue,
    `${context}.hyperliquidMaxRecoveryActionExpiryValue`,
    'maximum recovery action expiry must be before the recovery deadline',
  );
  requireCondition(
    order.expiryValue + order.hyperliquidMinRecoveryWindowMs
      <= order.hyperliquidRecoveryDeadlineValue,
    `${context}.hyperliquidRecoveryDeadlineValue`,
    'recovery deadline does not preserve the minimum recovery window',
  );
}

function validateHyperliquidRecovery(order: PackageOrder, context: string): void {
  const prices: readonly [string, ExactPrice | undefined][] = [
    ['maxRecoverySpotBuyPrice', order.maxRecoverySpotBuyPrice],
    ['minRecoverySpotSellPrice', order.minRecoverySpotSellPrice],
    ['minRecoveryPerpSellPrice', order.minRecoveryPerpSellPrice],
    ['maxRecoveryPerpBuyPrice', order.maxRecoveryPerpBuyPrice],
  ];
  for (const [name, value] of prices) {
    requirePresent(value, `${context}.${name}`);
  }
  requireCondition(
    order.maxRecoveryCostAtomsByAsset.length > 0,
    `${context}.maxRecoveryCostAtomsByAsset`,
    'Hyperliquid profile requires recovery cost caps',
  );
  for (const [index, cap] of order.maxRecoveryCostAtomsByAsset.entries()) {
    requireCondition(
      cap.maxAtoms >= 0n,
      `${context}.maxRecoveryCostAtomsByAsset[${index}].maxAtoms`,
      'recovery cost cap must be nonnegative',
    );
  }
  requireCondition(
    order.allowedRecoveryActions.length > 0,
    `${context}.allowedRecoveryActions`,
    'Hyperliquid profile requires recovery actions',
  );
}

function validateExactNet(order: PackageOrder, context: string): void {
  requirePresent(
    order.hyperliquidMinNetSpotDelta,
    `${context}.hyperliquidMinNetSpotDelta`,
  );
  requirePresent(
    order.hyperliquidMaxNetSpotDelta,
    `${context}.hyperliquidMaxNetSpotDelta`,
  );
  requirePresent(
    order.hyperliquidMaxTerminalResidualBaseQuantity,
    `${context}.hyperliquidMaxTerminalResidualBaseQuantity`,
  );
  requirePresent(
    order.hyperliquidMaxTerminalResidualQuoteValue,
    `${context}.hyperliquidMaxTerminalResidualQuoteValue`,
  );
  const expectedSpotDelta = order.action === 'ENTRY'
    ? order.quantity.atoms
    : -order.quantity.atoms;
  requireCondition(
    order.hyperliquidMinNetSpotDelta.atoms === expectedSpotDelta
      && order.hyperliquidMaxNetSpotDelta.atoms === expectedSpotDelta,
    `${context}.hyperliquidMinNetSpotDelta`,
    'EXACT_NET requires one net spot delta opposite the perpetual delta',
  );
  requireCondition(
    order.hyperliquidMaxTerminalResidualBaseQuantity.atoms === 0n,
    `${context}.hyperliquidMaxTerminalResidualBaseQuantity.atoms`,
    'EXACT_NET requires zero terminal residual quantity',
  );
  requireCondition(
    order.hyperliquidMaxTerminalResidualQuoteValue.atoms === 0n,
    `${context}.hyperliquidMaxTerminalResidualQuoteValue.atoms`,
    'EXACT_NET requires zero terminal residual value',
  );
  requireAbsent(
    order.hyperliquidResidualValuationSchemaVersion,
    `${context}.hyperliquidResidualValuationSchemaVersion`,
  );
  requireAbsent(
    order.hyperliquidResidualValuationReferencePrice,
    `${context}.hyperliquidResidualValuationReferencePrice`,
  );
}

function validateBoundedNet(order: PackageOrder, context: string): void {
  requirePresent(
    order.hyperliquidMinNetSpotDelta,
    `${context}.hyperliquidMinNetSpotDelta`,
  );
  requirePresent(
    order.hyperliquidMaxNetSpotDelta,
    `${context}.hyperliquidMaxNetSpotDelta`,
  );
  requirePresent(
    order.hyperliquidMaxTerminalResidualBaseQuantity,
    `${context}.hyperliquidMaxTerminalResidualBaseQuantity`,
  );
  requirePresent(
    order.hyperliquidResidualValuationSchemaVersion,
    `${context}.hyperliquidResidualValuationSchemaVersion`,
  );
  requirePresent(
    order.hyperliquidResidualValuationReferencePrice,
    `${context}.hyperliquidResidualValuationReferencePrice`,
  );
  requirePresent(
    order.hyperliquidMaxTerminalResidualQuoteValue,
    `${context}.hyperliquidMaxTerminalResidualQuoteValue`,
  );
  requireCondition(
    order.hyperliquidMinNetSpotDelta.atoms
      <= order.hyperliquidMaxNetSpotDelta.atoms,
    `${context}.hyperliquidMinNetSpotDelta.atoms`,
    'BOUNDED_NET net spot interval is descending',
  );
  requireCondition(
    order.hyperliquidMaxTerminalResidualBaseQuantity.atoms >= 0n,
    `${context}.hyperliquidMaxTerminalResidualBaseQuantity.atoms`,
    'terminal residual quantity cap must be nonnegative',
  );
  requireCondition(
    order.hyperliquidMaxTerminalResidualQuoteValue.atoms >= 0n,
    `${context}.hyperliquidMaxTerminalResidualQuoteValue.atoms`,
    'terminal residual value cap must be nonnegative',
  );
}

function validateHyperliquidProfile(order: PackageOrder, context: string): void {
  requireCondition(
    order.hyperliquidQuantityPolicy === 'EXACT_NET'
      || order.hyperliquidQuantityPolicy === 'BOUNDED_NET',
    `${context}.hyperliquidQuantityPolicy`,
    'Hyperliquid profile requires EXACT_NET or BOUNDED_NET',
  );
  requirePresent(
    order.hyperliquidGrossSpotQuantity,
    `${context}.hyperliquidGrossSpotQuantity`,
  );
  requireCondition(
    order.hyperliquidGrossSpotQuantity.atoms > 0n,
    `${context}.hyperliquidGrossSpotQuantity.atoms`,
    'gross spot quantity must be positive',
  );
  requirePresent(
    order.expectedPreStrategySpotQuantity,
    `${context}.expectedPreStrategySpotQuantity`,
  );
  validateHyperliquidActionFields(order, context);
  validateHyperliquidTiming(order, context);
  validateHyperliquidRecovery(order, context);
  if (order.hyperliquidQuantityPolicy === 'EXACT_NET') {
    validateExactNet(order, context);
  } else {
    validateBoundedNet(order, context);
  }
}

export function validatePackageOrderProfile(
  input: PackageOrderInput,
  context = 'packageOrder',
): PackageOrder {
  const order = packageOrder(input, context);
  requireCondition(
    order.direction === 'LONG_SPOT_SHORT_PERP',
    `${context}.direction`,
    'unsupported direction',
  );
  validateInitialActivation(order, context);
  validateCommonBounds(order, context);
  const quoteAsset = validateActionShape(order, context);
  const baseAsset = order.quantity.asset;
  validateAmountAssets(order, baseAsset, quoteAsset, context);

  if (order.settlementClass === 'ATOMIC_POSTCONDITION') {
    validateAtomicProfile(order, context);
  } else if (order.settlementClass === 'ASYNC_BONDED_SOLVER') {
    validateAsyncBondedProfile(order, context);
  } else {
    validateHyperliquidProfile(order, context);
  }
  return order;
}
