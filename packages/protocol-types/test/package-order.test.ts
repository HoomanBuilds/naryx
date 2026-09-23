import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  assetAmount,
  assetRef,
  domainRef,
  encodePackageOrder,
  fromHex,
  packageOrder,
  packageOrderBytes,
  packageOrderHash,
  toHex,
  type AdapterRefInput,
  type AssetAmount,
  type Direction,
  type ExpiryUnit,
  type PackageAction,
  type PackageOrder,
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

const U32_MAX = (1n << 32n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const U256_MAX = (1n << 256n) - 1n;
const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);

function fixtureAsset(value: FixtureAssetAmount | FixtureFeeCap) {
  return assetRef(value.assetId, value.assetManifestHash, value.decimals);
}

function fixtureAmount(value: FixtureAssetAmount): AssetAmount {
  return assetAmount(fixtureAsset(value), BigInt(value.atoms));
}

function fixtureAdapter(value: FixtureAdapterRef): AdapterRefInput {
  return {
    adapterId: value.adapterId,
    adapterManifestVersion: Number(value.adapterManifestVersion),
    adapterManifestHash: value.adapterManifestHash,
  };
}

function fixtureInput(fixture: PackageOrderFixture): PackageOrderInput {
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

function atomicInput(overrides: Partial<PackageOrderInput> = {}): PackageOrderInput {
  return {
    ...fixtureInput(loadFixture<PackageOrderFixture>('package-order-atomic.json')),
    ...overrides,
  };
}

describe('package order canonical wire', () => {
  test('matches the committed atomic golden vector', () => {
    const fixture = loadFixture<PackageOrderFixture>('package-order-atomic.json');
    const input = fixtureInput(fixture);
    assert.equal(toHex(packageOrderBytes(input)), fixture.canonicalHex);
    assert.equal(toHex(packageOrderHash(input)), fixture.digestHex);
  });

  test('enforces integer widths and nonzero versions', () => {
    assert.equal(packageOrder(atomicInput({ nonce: U256_MAX })).nonce, U256_MAX);
    assert.equal(
      packageOrder(atomicInput({ expiryValue: U64_MAX })).expiryValue,
      U64_MAX,
    );
    assert.equal(
      packageOrder(atomicInput({ exitOutcomeSchemaVersion: Number(U32_MAX) }))
        .exitOutcomeSchemaVersion,
      Number(U32_MAX),
    );
    assert.throws(() => packageOrder(atomicInput({ version: 0 })), MalformedInputError);
    assert.throws(() => packageOrder(atomicInput({ templateVersion: 0 })), MalformedInputError);
    assert.throws(() => packageOrder(atomicInput({ version: 2 ** 32 })), RangeViolationError);
    assert.throws(() => packageOrder(atomicInput({ nonce: U256_MAX + 1n })), RangeViolationError);
    assert.throws(() => packageOrder(atomicInput({ nonce: -1n })), RangeViolationError);
    assert.throws(
      () => packageOrder(atomicInput({ expiryValue: U64_MAX + 1n })),
      RangeViolationError,
    );
    assert.throws(
      () =>
        packageOrder(
          atomicInput({ hyperliquidResidualValuationSchemaVersion: 0 }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () => packageOrder(atomicInput({ hyperliquidMinRecoveryWindowMs: 0n })),
      MalformedInputError,
    );
  });

  test('rejects unknown variants in every enum field', () => {
    const invalid = 'UNKNOWN' as never;
    const cases: Partial<PackageOrderInput>[] = [
      { expiryUnit: invalid },
      { direction: invalid },
      { action: invalid },
      { packageOrderType: invalid },
      { packageTimeInForce: invalid },
      { partialFillPolicy: invalid },
      { hyperliquidQuantityPolicy: invalid },
      { hyperliquidRecoveryExpiryUnit: invalid },
      { settlementClass: invalid },
      { allowedRecoveryActions: [invalid] },
    ];
    for (const value of cases) {
      assert.throws(() => packageOrder(atomicInput(value)), MalformedInputError);
    }
  });

  test('requires canonical fee-cap and adapter collections', () => {
    const firstCap = {
      asset: assetRef('asset-a', HASH_A, 6),
      maxAtoms: 1n,
    };
    const secondCap = {
      asset: assetRef('asset-b', HASH_B, 6),
      maxAtoms: 2n,
    };
    assert.throws(
      () =>
        packageOrder(
          atomicInput({ maxVenueFeeAtomsByAsset: [secondCap, firstCap] }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        packageOrder(
          atomicInput({ maxVenueFeeAtomsByAsset: [firstCap, { ...firstCap }] }),
        ),
      DuplicateElementError,
    );

    const firstAdapter = {
      adapterId: 'adapter-a',
      adapterManifestVersion: 1,
      adapterManifestHash: HASH_A,
    };
    const secondAdapter = {
      adapterId: 'adapter-b',
      adapterManifestVersion: 1,
      adapterManifestHash: HASH_B,
    };
    assert.throws(
      () =>
        packageOrder(
          atomicInput({ permittedSpotAdapters: [secondAdapter, firstAdapter] }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () => packageOrder(atomicInput({ permittedPerpAdapters: [] })),
      MalformedInputError,
    );
  });

  test('preserves ordered recovery actions including repeated slots', () => {
    const actions: RecoveryAction[] = [
      'CANCEL_OPEN_ORDERS',
      'COMPLETE_SPOT',
      'CANCEL_OPEN_ORDERS',
    ];
    const order = packageOrder(atomicInput({ allowedRecoveryActions: actions }));
    assert.deepEqual(order.allowedRecoveryActions, actions);
    assert.equal(Object.isFrozen(order.allowedRecoveryActions), true);
  });

  test('defensively copies exposed hashes and freezes canonical collections', () => {
    const order = packageOrder(
      atomicInput({ activationConditionHash: HASH_A, entryReceiptHash: HASH_B }),
    );
    const before = new CanonicalWriter();
    encodePackageOrder(before, order);
    order.packageTemplateManifestHash.fill(0);
    order.activationConditionHash?.fill(0);
    order.entryReceiptHash?.fill(0);
    const after = new CanonicalWriter();
    encodePackageOrder(after, order);
    assert.equal(toHex(after.bytes()), toHex(before.bytes()));
    assert.equal(Object.isFrozen(order), true);
    assert.equal(Object.isFrozen(order.maxVenueFeeAtomsByAsset), true);
    assert.equal(Object.isFrozen(order.permittedSpotAdapters), true);
  });

  test('encoder revalidates forged top-level and nested hashes before writing', () => {
    const order = packageOrder(atomicInput());
    const forgedTop = {
      ...order,
      packageTemplateManifestHash: HASH_A,
    } as unknown as PackageOrder;
    const topWriter = new CanonicalWriter();
    assert.throws(
      () => encodePackageOrder(topWriter, forgedTop),
      MalformedInputError,
    );
    assert.equal(topWriter.bytes().length, 0);

    const forgedAdapter = {
      ...order,
      permittedSpotAdapters: [
        {
          ...order.permittedSpotAdapters[0],
          adapterManifestHash: HASH_A,
        },
      ],
    } as unknown as PackageOrder;
    const adapterWriter = new CanonicalWriter();
    assert.throws(
      () => encodePackageOrder(adapterWriter, forgedAdapter),
      MalformedInputError,
    );
    assert.equal(adapterWriter.bytes().length, 0);
  });

  test('optional presence is part of canonical identity without applying profiles', () => {
    const absent = packageOrderBytes(atomicInput());
    const present = packageOrderBytes(
      atomicInput({
        activationConditionHash: HASH_A,
        hyperliquidMinRecoveryWindowMs: 1n,
      }),
    );
    assert.notEqual(toHex(absent), toHex(present));
  });
});
