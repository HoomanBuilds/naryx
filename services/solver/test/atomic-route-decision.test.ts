import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  assetRef,
  bytesEqual,
  domainRef,
  exactPrice,
  packageOrderHash,
  payloadTemplateHash,
  routeHash,
  routePayloadBytes,
  validatePackageOrderProfile,
  versionedManifestRef,
} from '@naryx/protocol-types';
import type {
  PackageOrderInput,
  RoutePayloadInput,
} from '@naryx/protocol-types';
import {
  AtomicRouteDecisionError,
  planAtomicEntryRoute,
} from '../src/index.js';

const BASE_MANIFEST = '11'.repeat(32);
const QUOTE_MANIFEST = '22'.repeat(32);
const DOMAIN_MANIFEST = '33'.repeat(32);
const TEMPLATE_MANIFEST = '44'.repeat(32);
const SPOT_ADAPTER_MANIFEST = '55'.repeat(32);
const PERP_ADAPTER_MANIFEST = '66'.repeat(32);

function orderInput(): PackageOrderInput {
  const base = assetRef('test-base', BASE_MANIFEST, 9);
  const quote = assetRef('test-quote', QUOTE_MANIFEST, 6);
  return {
    version: 1,
    environment: 'testnet',
    domain: domainRef('test-domain', 1, DOMAIN_MANIFEST),
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    packageTemplateManifestHash: TEMPLATE_MANIFEST,
    owner: 'owner-1',
    settlementAccount: 'strategy-account-1',
    nonce: 1n,
    expiryUnit: 'SOLANA_SLOT',
    expiryValue: 500_000n,
    direction: 'LONG_SPOT_SHORT_PERP',
    action: 'ENTRY',
    packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'FOK',
    partialFillPolicy: 'EXACT_ALL_LEGS',
    quantity: { asset: base, atoms: 1_000_000n },
    exitOutcomeSchemaVersion: 0,
    expectedPrePositionSize: { asset: base, atoms: 0n },
    expectedPrePositionEntryNotional: { asset: quote, atoms: 0n },
    maxEntrySpread: {
      baseAsset: base,
      quoteAsset: quote,
      quoteAtoms: 1n,
      baseAtoms: 400n,
      roundingDirection: 'CEIL',
    },
    maxSpotQuoteIn: { asset: quote, atoms: 5_000_000n },
    maxMarginAdded: { asset: quote, atoms: 100_000n },
    minVenueReserveReturned: { asset: quote, atoms: 0n },
    minWalletQuoteBalanceDelta: { asset: quote, atoms: 0n },
    maxVenueFeeAtomsByAsset: [],
    maxProtocolFee: { asset: quote, atoms: 1_000n },
    maxSolverFee: { asset: quote, atoms: 1_000n },
    maxPriorityFee: { asset: quote, atoms: 500n },
    maxRecoveryCostAtomsByAsset: [],
    permittedSpotAdapters: [
      { adapterId: 'test-spot-adapter', adapterManifestVersion: 1, adapterManifestHash: SPOT_ADAPTER_MANIFEST },
    ],
    permittedPerpAdapters: [
      { adapterId: 'test-perp-adapter', adapterManifestVersion: 1, adapterManifestHash: PERP_ADAPTER_MANIFEST },
    ],
    settlementClass: 'ATOMIC_POSTCONDITION',
    maxAggregateRecoveryLossQuote: { asset: quote, atoms: 0n },
    maxResidualBaseQuantity: { asset: base, atoms: 0n },
    allowedRecoveryActions: [],
  };
}

function routeInput(
  order: PackageOrderInput,
  orderHash: Uint8Array | string,
  overrides: Partial<RoutePayloadInput> = {},
): RoutePayloadInput {
  const base = assetRef('test-base', BASE_MANIFEST, 9);
  const quote = assetRef('test-quote', QUOTE_MANIFEST, 6);
  const domain = domainRef('test-domain', 1, DOMAIN_MANIFEST);
  const spotAdapter = adapterRef({
    adapterId: 'test-spot-adapter',
    adapterManifestVersion: 1,
    adapterManifestHash: SPOT_ADAPTER_MANIFEST,
  });
  const perpAdapter = adapterRef({
    adapterId: 'test-perp-adapter',
    adapterManifestVersion: 1,
    adapterManifestHash: PERP_ADAPTER_MANIFEST,
  });
  const spotVenue = versionedManifestRef('test-spot-venue', 1, 'a1'.repeat(32));
  const perpVenue = versionedManifestRef('test-perp-venue', 1, 'a2'.repeat(32));
  const spotMarket = versionedManifestRef('test-spot-market', 1, 'a3'.repeat(32));
  const perpMarket = versionedManifestRef('test-perp-market', 1, 'a4'.repeat(32));
  const price = exactPrice({
    baseAsset: base,
    quoteAsset: quote,
    quoteAtoms: 3n,
    baseAtoms: 2n,
    roundingDirection: 'CEIL',
  });
  const quantityAtoms = 1_000_000n;
  return {
    version: 1,
    environment: 'testnet',
    domain,
    orderHash,
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    packageTemplateManifestHash: TEMPLATE_MANIFEST,
    templateRegistryRecordHash: 'b1'.repeat(32),
    owner: 'owner-1',
    settlementAccount: 'strategy-account-1',
    solver: 'solver-alpha',
    direction: 'LONG_SPOT_SHORT_PERP',
    action: 'ENTRY',
    quantityPolicyClass: 'EXACT_ATOMIC',
    partialFillPolicy: 'EXACT_ALL_LEGS',
    settlementClass: 'ATOMIC_POSTCONDITION',
    executionPlanKind: 'SVM_ATOMIC_CPI',
    routeExpiryUnit: 'SOLANA_SLOT',
    routeExpiryValue: 400_000n,
    feePolicyVersion: 1,
    feePolicyManifestHash: 'c1'.repeat(32),
    accountBindings: [
      {
        routeBindingId: 'trader-authority',
        accountIdentity: 'owner-1',
        authorityIdentity: 'owner-1',
      },
      {
        routeBindingId: 'spot-program',
        adapter: spotAdapter,
        adapterBindingId: 'market-program',
        accountIdentity: 'spot-program-account',
        codeIdentity: 'spot-code-v1',
      },
      {
        routeBindingId: 'perp-program',
        adapter: perpAdapter,
        adapterBindingId: 'market-program',
        accountIdentity: 'perp-program-account',
        codeIdentity: 'perp-code-v1',
      },
    ],
    serviceCharges: [],
    preconditions: [],
    legs: [
      {
        legIndex: 0,
        legRole: 'SPOT',
        actionSequence: 0,
        adapter: spotAdapter,
        venue: spotVenue,
        market: spotMarket,
        baseAsset: base,
        quoteAsset: quote,
        side: 'BUY',
        quantity: { asset: base, atoms: quantityAtoms },
        limitPrice: price,
        timeInForce: 'FOK',
        reduceOnly: false,
      },
      {
        legIndex: 1,
        legRole: 'PERPETUAL',
        actionSequence: 1,
        adapter: perpAdapter,
        venue: perpVenue,
        market: perpMarket,
        baseAsset: base,
        quoteAsset: quote,
        side: 'SELL',
        quantity: { asset: base, atoms: quantityAtoms },
        limitPrice: price,
        timeInForce: 'FOK',
        reduceOnly: false,
      },
    ],
    actions: [
      {
        sequence: 0,
        actionClassId: 'test-spot-action',
        legIndex: 0,
        adapter: spotAdapter,
        targetBindingId: 'spot-program',
        authorityBindingId: 'trader-authority',
        accountMetas: [
          { routeBindingId: 'spot-program', isSigner: false, isWritable: true },
          { routeBindingId: 'trader-authority', isSigner: true, isWritable: true },
        ],
        payload: {
          codecId: 'test-codec',
          templateLength: 3,
          templateHash: payloadTemplateHash(Uint8Array.from([9, 8, 7]), []),
          lateBoundFields: [],
        },
      },
      {
        sequence: 1,
        actionClassId: 'test-perp-action',
        legIndex: 1,
        adapter: perpAdapter,
        targetBindingId: 'perp-program',
        authorityBindingId: 'trader-authority',
        accountMetas: [
          { routeBindingId: 'perp-program', isSigner: false, isWritable: true },
          { routeBindingId: 'trader-authority', isSigner: true, isWritable: true },
          { routeBindingId: 'spot-program', isSigner: false, isWritable: false },
        ],
        payload: {
          codecId: 'test-codec',
          templateLength: 3,
          templateHash: payloadTemplateHash(Uint8Array.from([7, 8, 9]), []),
          lateBoundFields: [],
        },
      },
    ],
    postconditions: [],
    evidenceRequirements: {
      schemaVersion: 1,
      profileId: 'test-evidence-v1',
      requiredPreStateComponentIds: ['authority-state'],
      requiredPostStateComponentIds: ['position-state'],
      requiredActionEvidenceTypeIds: ['execution-result'],
      stateReferenceSchemaHash: 'd1'.repeat(32),
      receiptSchemaHash: 'd2'.repeat(32),
      outcomeSchemaHash: '01'.concat('0'.repeat(62)),
    },
    ...overrides,
  };
}

test('selects the deterministic best atomic route and reports rejections plus no-eligible failure', () => {
  const input = orderInput();
  const order = validatePackageOrderProfile(input);
  const orderHash = packageOrderHash(input);
  const baseRoute = routeInput(input, orderHash);
  const betterRoute = routeInput(input, orderHash, { solver: 'solver-beta' });
  assert.notDeepEqual(routeHash(betterRoute), routeHash(baseRoute));
  const incompatibleRoute = routeInput(input, orderHash, {
    solver: 'solver-gamma',
    legs: [
      { ...baseRoute.legs[0]!, quantity: { asset: baseRoute.legs[0]!.quantity.asset, atoms: 500_000n } },
      baseRoute.legs[1]!,
    ],
  });
  const wrongQuote = assetRef('test-quote-other', QUOTE_MANIFEST, 6);
  const wrongQuotePrice = exactPrice({
    baseAsset: baseRoute.legs[0]!.baseAsset,
    quoteAsset: wrongQuote,
    quoteAtoms: 3n,
    baseAtoms: 2n,
    roundingDirection: 'CEIL',
  });
  const wrongQuoteRoute = routeInput(input, orderHash, {
    solver: 'solver-delta',
    legs: [
      { ...baseRoute.legs[0]!, quoteAsset: wrongQuote, limitPrice: wrongQuotePrice },
      { ...baseRoute.legs[1]!, quoteAsset: wrongQuote, limitPrice: wrongQuotePrice },
    ],
  });
  const decision = planAtomicEntryRoute({ order, orderHash }, () => [
    {
      candidateId: 'candidate-a',
      active: true,
      capacityBaseAtoms: 1_000_000n,
      expectedNetPackageOutcomeQuoteAtoms: 1_000n,
      expectedTotalFeesQuoteAtoms: 100n,
      evidenceGrade: 'SIMULATED',
      route: baseRoute,
    },
    {
      candidateId: 'candidate-b',
      active: true,
      capacityBaseAtoms: 2_000_000n,
      expectedNetPackageOutcomeQuoteAtoms: 2_000n,
      expectedTotalFeesQuoteAtoms: 200n,
      evidenceGrade: 'SIMULATED',
      route: betterRoute,
    },
    {
      candidateId: 'candidate-c',
      active: true,
      capacityBaseAtoms: 2_000_000n,
      expectedNetPackageOutcomeQuoteAtoms: 9_000n,
      expectedTotalFeesQuoteAtoms: 10n,
      evidenceGrade: 'SIMULATED',
      route: incompatibleRoute,
    },
    {
      candidateId: 'candidate-d',
      active: true,
      capacityBaseAtoms: 2_000_000n,
      expectedNetPackageOutcomeQuoteAtoms: 8_000n,
      expectedTotalFeesQuoteAtoms: 10n,
      evidenceGrade: 'SIMULATED',
      route: wrongQuoteRoute,
    },
  ]);
  assert.equal(decision.candidateId, 'candidate-b');
  assert.equal(decision.expectedNetPackageOutcomeQuoteAtoms, 2_000n);
  assert.equal(decision.expectedTotalFeesQuoteAtoms, 200n);
  assert.ok(bytesEqual(decision.orderHash, orderHash));
  assert.ok(bytesEqual(decision.routeHash, routeHash(betterRoute)));
  assert.deepEqual(decision.routeBytes, routePayloadBytes(betterRoute));
  assert.equal(decision.decisions.length, 4);
  const rejected = decision.decisions.find((entry) => entry.candidateId === 'candidate-c');
  assert.equal(rejected?.status, 'REJECTED');
  assert.equal((rejected as { reason: string }).reason, 'QUANTITY_MISMATCH');
  const wrongQuoteRejected = decision.decisions.find((entry) => entry.candidateId === 'candidate-d');
  assert.equal(wrongQuoteRejected?.status, 'REJECTED');
  assert.equal((wrongQuoteRejected as { reason: string }).reason, 'QUANTITY_MISMATCH');
  assert.equal(decision.decisions.filter((entry) => entry.status === 'ELIGIBLE').length, 2);
  assert.throws(
    () => planAtomicEntryRoute({ order, orderHash }, () => [
      {
        candidateId: 'candidate-c',
        active: true,
        capacityBaseAtoms: 2_000_000n,
        expectedNetPackageOutcomeQuoteAtoms: 9_000n,
        expectedTotalFeesQuoteAtoms: 10n,
        evidenceGrade: 'SIMULATED',
        route: incompatibleRoute,
      },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof AtomicRouteDecisionError);
      assert.equal(error.code, 'NO_ELIGIBLE_ROUTE');
      assert.equal(error.decisions.length, 1);
      assert.equal(error.decisions[0]?.status, 'REJECTED');
      return true;
    },
  );
});
