import {
  assetAmount,
  assetRef,
  domainRef,
  fromHex,
  type AdapterRefInput,
  type AssetAmount,
  type Direction,
  type ExpiryUnit,
  type PackageAction,
  type PackageOrderInput,
  type PackageOrderType,
  type PackageTimeInForce,
  type PartialFillPolicy,
  type RecoveryAction,
  type RoundingDirection,
  type SettlementClass,
} from '../src/index.js';
import {
  loadFixture,
  type FixtureAdapterRef,
  type FixtureAssetAmount,
  type FixtureFeeCap,
  type PackageOrderFixture,
} from './fixtures.js';

export function fixtureAsset(value: FixtureAssetAmount | FixtureFeeCap) {
  return assetRef(value.assetId, value.assetManifestHash, value.decimals);
}

export function fixtureAmount(value: FixtureAssetAmount): AssetAmount {
  return assetAmount(fixtureAsset(value), BigInt(value.atoms));
}

export function fixtureAdapter(value: FixtureAdapterRef): AdapterRefInput {
  return {
    adapterId: value.adapterId,
    adapterManifestVersion: Number(value.adapterManifestVersion),
    adapterManifestHash: value.adapterManifestHash,
  };
}

export function fixtureInput(fixture: PackageOrderFixture): PackageOrderInput {
  return {
    version: Number(fixture.version),
    environment: fixture.environment,
    domain: domainRef(
      fixture.domain.domainId,
      Number(fixture.domain.domainManifestVersion),
      fromHex(fixture.domain.domainManifestHash),
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
    exitOutcomeSchemaVersion: Number(fixture.exitOutcomeSchemaVersion),
    expectedPrePositionSize: fixtureAmount(fixture.expectedPrePositionSize),
    expectedPrePositionEntryNotional: fixtureAmount(
      fixture.expectedPrePositionEntryNotional,
    ),
    maxEntrySpread: {
      baseAsset: assetRef(
        fixture.maxEntrySpread.baseAssetId,
        fixture.maxEntrySpread.baseAssetManifestHash,
        fixture.maxEntrySpread.baseDecimals,
      ),
      quoteAsset: assetRef(
        fixture.maxEntrySpread.quoteAssetId,
        fixture.maxEntrySpread.quoteAssetManifestHash,
        fixture.maxEntrySpread.quoteDecimals,
      ),
      quoteAtoms: BigInt(fixture.maxEntrySpread.quoteAtoms),
      baseAtoms: BigInt(fixture.maxEntrySpread.baseAtoms),
      roundingDirection: fixture.maxEntrySpread.roundingDirection as RoundingDirection,
    },
    maxSpotQuoteIn: fixtureAmount(fixture.maxSpotQuoteIn),
    maxMarginAdded: fixtureAmount(fixture.maxMarginAdded),
    minVenueReserveReturned: fixtureAmount(fixture.minVenueReserveReturned),
    minWalletQuoteBalanceDelta: fixtureAmount(fixture.minWalletQuoteBalanceDelta),
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
    maxAggregateRecoveryLossQuote: fixtureAmount(
      fixture.maxAggregateRecoveryLossQuote,
    ),
    maxResidualBaseQuantity: fixtureAmount(fixture.maxResidualBaseQuantity),
    allowedRecoveryActions: fixture.allowedRecoveryActions as RecoveryAction[],
  };
}

export function atomicInput(overrides: Partial<PackageOrderInput> = {}): PackageOrderInput {
  return {
    ...fixtureInput(loadFixture<PackageOrderFixture>('package-order-atomic.json')),
    ...overrides,
  };
}
