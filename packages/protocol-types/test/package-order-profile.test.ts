import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  assetAmount,
  assetRef,
  domainRef,
  packageOrderBytes,
  packageOrderHash,
  toHex,
  validatePackageOrderProfile,
  type AdapterRefInput,
  type AssetAmount,
  type Direction,
  type ExactPriceInput,
  type ExpiryUnit,
  type PackageAction,
  type PackageOrderInput,
  type PackageOrderType,
  type PackageTimeInForce,
  type PartialFillPolicy,
  type QuantityPolicyClass,
  type RecoveryAction,
  type RoundingDirection,
  type SettlementClass,
} from '../src/index.js';
import {
  loadFixture,
  type FixtureAdapterRef,
  type FixtureAssetAmount,
  type FixtureExactPrice,
  type FixtureFeeCap,
  type HyperliquidExitPackageOrderFixture,
} from './fixtures.js';

const DOMAIN_HASH = '11'.repeat(32);
const BASE_HASH = '22'.repeat(32);
const QUOTE_HASH = '33'.repeat(32);
const TEMPLATE_HASH = '44'.repeat(32);
const SPOT_ADAPTER_HASH = '55'.repeat(32);
const PERP_ADAPTER_HASH = '66'.repeat(32);

function fixtureAsset(value: FixtureAssetAmount | FixtureFeeCap) {
  return assetRef(value.assetId, value.assetManifestHash, value.decimals);
}

function fixtureAmount(value: FixtureAssetAmount): AssetAmount {
  return assetAmount(fixtureAsset(value), BigInt(value.atoms));
}

function fixturePrice(value: FixtureExactPrice): ExactPriceInput {
  return {
    baseAsset: assetRef(
      value.baseAssetId,
      value.baseAssetManifestHash,
      value.baseDecimals,
    ),
    quoteAsset: assetRef(
      value.quoteAssetId,
      value.quoteAssetManifestHash,
      value.quoteDecimals,
    ),
    quoteAtoms: BigInt(value.quoteAtoms),
    baseAtoms: BigInt(value.baseAtoms),
    roundingDirection: value.roundingDirection as RoundingDirection,
  };
}

function fixtureAdapter(value: FixtureAdapterRef): AdapterRefInput {
  return {
    adapterId: value.adapterId,
    adapterManifestVersion: Number(value.adapterManifestVersion),
    adapterManifestHash: value.adapterManifestHash,
  };
}

function hyperliquidInput(
  fixture = loadFixture<HyperliquidExitPackageOrderFixture>(
    'package-order-hyperliquid-exit.json',
  ),
): PackageOrderInput {
  return {
    version: Number(fixture.version),
    environment: fixture.environment,
    domain: domainRef(
      fixture.domain.domainId,
      Number(fixture.domain.domainManifestVersion),
      fixture.domain.domainManifestHash,
    ),
    templateId: fixture.templateId,
    templateVersion: Number(fixture.templateVersion),
    packageTemplateManifestHash: fixture.packageTemplateManifestHash,
    owner: fixture.owner,
    settlementAccount: fixture.settlementAccount,
    nonce: BigInt(fixture.nonce),
    expiryUnit: fixture.expiryUnit as ExpiryUnit,
    expiryValue: BigInt(fixture.expiryValue),
    direction: fixture.direction as Direction,
    action: fixture.action as PackageAction,
    packageOrderType: fixture.packageOrderType as PackageOrderType,
    packageTimeInForce: fixture.packageTimeInForce as PackageTimeInForce,
    partialFillPolicy: fixture.partialFillPolicy as PartialFillPolicy,
    quantity: fixtureAmount(fixture.quantity),
    hyperliquidQuantityPolicy:
      fixture.hyperliquidQuantityPolicy as QuantityPolicyClass,
    hyperliquidGrossSpotQuantity: fixtureAmount(
      fixture.hyperliquidGrossSpotQuantity,
    ),
    hyperliquidMinNetSpotDelta: fixtureAmount(
      fixture.hyperliquidMinNetSpotDelta,
    ),
    hyperliquidMaxNetSpotDelta: fixtureAmount(
      fixture.hyperliquidMaxNetSpotDelta,
    ),
    hyperliquidMaxTerminalResidualBaseQuantity: fixtureAmount(
      fixture.hyperliquidMaxTerminalResidualBaseQuantity,
    ),
    hyperliquidResidualValuationSchemaVersion: Number(
      fixture.hyperliquidResidualValuationSchemaVersion,
    ),
    hyperliquidResidualValuationReferencePrice: fixturePrice(
      fixture.hyperliquidResidualValuationReferencePrice,
    ),
    hyperliquidMaxTerminalResidualQuoteValue: fixtureAmount(
      fixture.hyperliquidMaxTerminalResidualQuoteValue,
    ),
    expectedPreStrategySpotQuantity: fixtureAmount(
      fixture.expectedPreStrategySpotQuantity,
    ),
    hyperliquidRecoveryExpiryUnit:
      fixture.hyperliquidRecoveryExpiryUnit as ExpiryUnit,
    hyperliquidMaxRecoveryActionExpiryValue: BigInt(
      fixture.hyperliquidMaxRecoveryActionExpiryValue,
    ),
    hyperliquidRecoveryDeadlineValue: BigInt(
      fixture.hyperliquidRecoveryDeadlineValue,
    ),
    hyperliquidMinRecoveryWindowMs: BigInt(
      fixture.hyperliquidMinRecoveryWindowMs,
    ),
    exitOutcomeSchemaVersion: Number(fixture.exitOutcomeSchemaVersion),
    entryReceiptHash: fixture.entryReceiptHash,
    expectedPrePositionSize: fixtureAmount(fixture.expectedPrePositionSize),
    expectedPrePositionEntryNotional: fixtureAmount(
      fixture.expectedPrePositionEntryNotional,
    ),
    minExitQuoteOutcome: fixtureAmount(fixture.minExitQuoteOutcome),
    minSpotQuoteOut: fixtureAmount(fixture.minSpotQuoteOut),
    hyperliquidMaxPerpBuyPrice: fixturePrice(
      fixture.hyperliquidMaxPerpBuyPrice,
    ),
    maxMarginAdded: fixtureAmount(fixture.maxMarginAdded),
    minVenueReserveReturned: fixtureAmount(fixture.minVenueReserveReturned),
    minWalletQuoteBalanceDelta: fixtureAmount(
      fixture.minWalletQuoteBalanceDelta,
    ),
    maxVenueFeeAtomsByAsset: fixture.maxVenueFeeAtomsByAsset.map((value) => ({
      asset: fixtureAsset(value),
      maxAtoms: BigInt(value.maxAtoms),
    })),
    maxProtocolFee: fixtureAmount(fixture.maxProtocolFee),
    maxSolverFee: fixtureAmount(fixture.maxSolverFee),
    maxPriorityFee: fixtureAmount(fixture.maxPriorityFee),
    maxRecoveryCostAtomsByAsset: fixture.maxRecoveryCostAtomsByAsset.map((value) => ({
      asset: fixtureAsset(value),
      maxAtoms: BigInt(value.maxAtoms),
    })),
    permittedSpotAdapters: fixture.permittedSpotAdapters.map(fixtureAdapter),
    permittedPerpAdapters: fixture.permittedPerpAdapters.map(fixtureAdapter),
    settlementClass: fixture.settlementClass as SettlementClass,
    maxRecoverySpotBuyPrice: fixturePrice(fixture.maxRecoverySpotBuyPrice),
    minRecoverySpotSellPrice: fixturePrice(fixture.minRecoverySpotSellPrice),
    minRecoveryPerpSellPrice: fixturePrice(fixture.minRecoveryPerpSellPrice),
    maxRecoveryPerpBuyPrice: fixturePrice(fixture.maxRecoveryPerpBuyPrice),
    maxAggregateRecoveryLossQuote: fixtureAmount(
      fixture.maxAggregateRecoveryLossQuote,
    ),
    maxResidualBaseQuantity: fixtureAmount(fixture.maxResidualBaseQuantity),
    allowedRecoveryActions: fixture.allowedRecoveryActions as RecoveryAction[],
  };
}

function atomicInput(overrides: Partial<PackageOrderInput> = {}): PackageOrderInput {
  const base = assetRef('svm:testnet:sol', BASE_HASH, 9);
  const quote = assetRef('svm:testnet:usdc', QUOTE_HASH, 6);
  const amount = (asset: typeof base, atoms: bigint) => assetAmount(asset, atoms);
  return {
    version: 1,
    environment: 'testnet',
    domain: domainRef('svm:testnet', 1, DOMAIN_HASH),
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    packageTemplateManifestHash: TEMPLATE_HASH,
    owner: 'owner-1',
    settlementAccount: 'strategy-account-1',
    nonce: 1n,
    expiryUnit: 'SOLANA_SLOT',
    expiryValue: 500_000_000n,
    direction: 'LONG_SPOT_SHORT_PERP',
    action: 'ENTRY',
    packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'FOK',
    partialFillPolicy: 'EXACT_ALL_LEGS',
    quantity: amount(base, 1_000_000_000n),
    exitOutcomeSchemaVersion: 0,
    expectedPrePositionSize: amount(base, 0n),
    expectedPrePositionEntryNotional: amount(quote, 0n),
    maxEntrySpread: {
      baseAsset: base,
      quoteAsset: quote,
      quoteAtoms: 1n,
      baseAtoms: 400n,
      roundingDirection: 'CEIL',
    },
    maxSpotQuoteIn: amount(quote, 150_000_000n),
    maxMarginAdded: amount(quote, 20_000_000n),
    minVenueReserveReturned: amount(quote, 0n),
    minWalletQuoteBalanceDelta: amount(quote, 0n),
    maxVenueFeeAtomsByAsset: [],
    maxProtocolFee: amount(quote, 100_000n),
    maxSolverFee: amount(quote, 100_000n),
    maxPriorityFee: amount(base, 100_000n),
    maxRecoveryCostAtomsByAsset: [],
    permittedSpotAdapters: [
      {
        adapterId: 'spot-adapter-v1',
        adapterManifestVersion: 1,
        adapterManifestHash: SPOT_ADAPTER_HASH,
      },
    ],
    permittedPerpAdapters: [
      {
        adapterId: 'perp-adapter-v1',
        adapterManifestVersion: 1,
        adapterManifestHash: PERP_ADAPTER_HASH,
      },
    ],
    settlementClass: 'ATOMIC_POSTCONDITION',
    maxAggregateRecoveryLossQuote: amount(quote, 0n),
    maxResidualBaseQuantity: amount(base, 0n),
    allowedRecoveryActions: [],
    ...overrides,
  };
}

function exactNetExitInput(): PackageOrderInput {
  const bounded = hyperliquidInput();
  const {
    hyperliquidResidualValuationSchemaVersion: _schemaVersion,
    hyperliquidResidualValuationReferencePrice: _referencePrice,
    ...common
  } = bounded;
  return {
    ...common,
    hyperliquidQuantityPolicy: 'EXACT_NET',
    hyperliquidMinNetSpotDelta: assetAmount(
      bounded.quantity.asset,
      -bounded.quantity.atoms,
    ),
    hyperliquidMaxNetSpotDelta: assetAmount(
      bounded.quantity.asset,
      -bounded.quantity.atoms,
    ),
    hyperliquidMaxTerminalResidualBaseQuantity: assetAmount(
      bounded.quantity.asset,
      0n,
    ),
    hyperliquidMaxTerminalResidualQuoteValue: assetAmount(
      bounded.minSpotQuoteOut!.asset,
      0n,
    ),
  };
}

describe('package order semantic profiles', () => {
  test('accepts activated Solana and Base atomic entry profiles', () => {
    assert.equal(
      validatePackageOrderProfile(atomicInput()).settlementClass,
      'ATOMIC_POSTCONDITION',
    );
    assert.doesNotThrow(() =>
      validatePackageOrderProfile(
        atomicInput({ expiryUnit: 'EVM_UNIX_SECONDS', expiryValue: 2_000_000_000n }),
      ),
    );
  });

  test('accepts the Hyperliquid bounded exit fixture and matches its wire vector', () => {
    const fixture = loadFixture<HyperliquidExitPackageOrderFixture>(
      'package-order-hyperliquid-exit.json',
    );
    const input = hyperliquidInput(fixture);
    assert.equal(
      validatePackageOrderProfile(input).hyperliquidQuantityPolicy,
      'BOUNDED_NET',
    );
    assert.equal(toHex(packageOrderBytes(input)), fixture.canonicalHex);
    assert.equal(toHex(packageOrderHash(input)), fixture.digestHex);
  });

  test('enforces ENTRY and EXIT field shapes and pre-position state', () => {
    const entry = atomicInput();
    const { maxEntrySpread: _maxEntrySpread, ...missingEntrySpread } = entry;
    assert.throws(
      () => validatePackageOrderProfile(missingEntrySpread as PackageOrderInput),
      MalformedInputError,
    );
    assert.throws(
      () =>
        validatePackageOrderProfile(
          atomicInput({ expectedPrePositionSize: assetAmount(entry.quantity.asset, -1n) }),
        ),
      MalformedInputError,
    );
    const exit = hyperliquidInput();
    assert.throws(
      () => validatePackageOrderProfile({ ...exit, exitOutcomeSchemaVersion: 0 }),
      MalformedInputError,
    );
  });

  test('binds base, quote, price, margin, service-fee, and outcome assets', () => {
    const input = atomicInput();
    const wrong = assetRef('svm:testnet:wrong', '77'.repeat(32), 6);
    assert.throws(
      () =>
        validatePackageOrderProfile({
          ...input,
          maxMarginAdded: assetAmount(wrong, 1n),
        }),
      MalformedInputError,
    );
    assert.throws(
      () =>
        validatePackageOrderProfile({
          ...input,
          maxProtocolFee: assetAmount(input.quantity.asset, 1n),
        }),
      MalformedInputError,
    );
    const hyper = hyperliquidInput();
    assert.throws(
      () =>
        validatePackageOrderProfile({
          ...hyper,
          minExitQuoteOutcome: assetAmount(hyper.quantity.asset, 1n),
        }),
      MalformedInputError,
    );
  });

  test('enforces initial atomic and Hyperliquid activation combinations', () => {
    assert.throws(
      () => validatePackageOrderProfile(atomicInput({ packageTimeInForce: 'IOC' })),
      MalformedInputError,
    );
    assert.throws(
      () =>
        validatePackageOrderProfile({
          ...hyperliquidInput(),
          packageOrderType: 'LIMIT',
        }),
      MalformedInputError,
    );
  });

  test('separates atomic fields from the Hyperliquid recovery profile', () => {
    assert.throws(
      () =>
        validatePackageOrderProfile(
          atomicInput({ hyperliquidQuantityPolicy: 'EXACT_NET' }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        validatePackageOrderProfile({
          ...hyperliquidInput(),
          maxRecoverySpotBuyPrice: undefined,
        } as unknown as PackageOrderInput),
      MalformedInputError,
    );
  });

  test('enforces Hyperliquid recovery timing and nonnegative recovery cost', () => {
    const input = hyperliquidInput();
    assert.throws(
      () =>
        validatePackageOrderProfile({
          ...input,
          hyperliquidRecoveryDeadlineValue: input.expiryValue + 99_999n,
        }),
      MalformedInputError,
    );
    assert.throws(
      () =>
        validatePackageOrderProfile({
          ...input,
          hyperliquidMaxRecoveryActionExpiryValue:
            input.hyperliquidRecoveryDeadlineValue!,
        }),
      MalformedInputError,
    );
    assert.throws(
      () =>
        validatePackageOrderProfile({
          ...input,
          maxRecoveryCostAtomsByAsset: [
            { asset: input.maxPriorityFee.asset, maxAtoms: -1n },
          ],
        }),
      MalformedInputError,
    );
  });

  test('enforces exact-net equality and bounded-net interval boundaries', () => {
    const exact = exactNetExitInput();
    assert.equal(
      validatePackageOrderProfile(exact).hyperliquidQuantityPolicy,
      'EXACT_NET',
    );
    assert.throws(
      () =>
        validatePackageOrderProfile({
          ...exact,
          hyperliquidMaxNetSpotDelta: assetAmount(
            exact.quantity.asset,
            -exact.quantity.atoms + 1n,
          ),
        }),
      MalformedInputError,
    );

    const bounded = hyperliquidInput();
    assert.throws(
      () =>
        validatePackageOrderProfile({
          ...bounded,
          hyperliquidMinNetSpotDelta: bounded.hyperliquidMaxNetSpotDelta!,
          hyperliquidMaxNetSpotDelta: bounded.hyperliquidMinNetSpotDelta!,
        }),
      MalformedInputError,
    );
  });
});
