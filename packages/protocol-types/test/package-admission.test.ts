import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  adapterRef,
  assetAmount,
  assetRef,
  domainRefFromManifest,
  feePolicyManifestHash,
  packageOrderHash,
  packageTemplateManifestHash,
  packageTemplateRegistryRecordHash,
  payloadTemplateHash,
  routeHash,
  validatePackageAdmission,
  versionedManifestRef,
  type AdapterRef,
  type AssetRef,
  type DomainManifestInput,
  type DomainRegistryRecordInput,
  type FeePolicyManifestInput,
  type PackageAdmissionInput,
  type PackageOrderInput,
  type PackageTemplateManifestInput,
  type PackageTemplateRegistryRecordInput,
  type RoutePayloadInput,
  type SolverQuoteInput,
  type VersionedManifestRef,
} from '../src/index.js';

const hash = (byte: string): string => byte.repeat(64);

interface AdmissionParts {
  readonly domainManifest: DomainManifestInput;
  readonly templateManifest: PackageTemplateManifestInput;
  readonly templateRegistryRecord: PackageTemplateRegistryRecordInput;
  readonly feePolicyManifest: FeePolicyManifestInput;
  readonly order: PackageOrderInput;
  readonly route: RoutePayloadInput;
  readonly quote: SolverQuoteInput;
  readonly activeRegistryRecords: readonly DomainRegistryRecordInput[];
}

function activeRecord(
  domainManifest: DomainManifestInput,
  templateManifest: PackageTemplateManifestInput,
  kind: 'ASSET' | 'ADAPTER' | 'VENUE' | 'MARKET',
  reference: AssetRef | AdapterRef | VersionedManifestRef,
): DomainRegistryRecordInput {
  const adapter = 'adapterId' in reference;
  const asset = 'assetId' in reference;
  return {
    recordVersion: 1,
    environment: 'devnet',
    domain: domainRefFromManifest(domainManifest),
    recordKind: kind,
    subjectId: adapter
      ? reference.adapterId
      : asset
        ? reference.assetId
        : reference.subjectId,
    subjectManifestVersion: asset
      ? 1
      : adapter
      ? reference.adapterManifestVersion
      : reference.manifestVersion,
    subjectManifestHash: asset
      ? reference.assetManifestHash
      : adapter
      ? reference.adapterManifestHash
      : reference.manifestHash,
    registryState: 'ACTIVE',
    riskLimits: [],
    allowedTemplates: [{
      templateId: templateManifest.templateId,
      templateVersion: templateManifest.templateVersion,
      packageTemplateManifestHash: packageTemplateManifestHash(templateManifest),
    }],
    allowedSettlementClasses: ['ATOMIC_POSTCONDITION'],
    activationUnit: 'SOLANA_SLOT',
    activationValue: 900n,
    governanceReference: 'governance-devnet-v1',
  };
}

function admissionParts(): AdmissionParts {
  const domainManifest: DomainManifestInput = {
    manifestVersion: 1,
    environment: 'devnet',
    domainId: 'svm:devnet',
    runtimeClassId: 'svm-program-v1',
    runtimeClassVersion: 1,
    chainNamespace: 'svm',
    chainReference: 'devnet',
    executionVerifierId: 'package-verifier-v1',
    executionVerifierCodeHash: hash('1'),
    clockModelId: 'solana-slot-v1',
    finalityPolicyHash: hash('2'),
    addressCodecId: 'solana-pubkey-32',
    supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
  };
  const domain = domainRefFromManifest(domainManifest);
  const sol = assetRef('sol', hash('3'), 9);
  const usdc = assetRef('usdc', hash('4'), 6);
  const spotAdapter = adapterRef({
    adapterId: 'spot-adapter-v1',
    adapterManifestVersion: 1,
    adapterManifestHash: hash('5'),
  });
  const perpAdapter = adapterRef({
    adapterId: 'perp-adapter-v1',
    adapterManifestVersion: 1,
    adapterManifestHash: hash('6'),
  });
  const spotVenue = versionedManifestRef('spot-venue', 1, hash('7'));
  const perpVenue = versionedManifestRef('perp-venue', 1, hash('8'));
  const spotMarket = versionedManifestRef('sol-usdc-spot', 1, hash('9'));
  const perpMarket = versionedManifestRef('sol-usdc-perp', 1, hash('a'));
  const templateManifest: PackageTemplateManifestInput = {
    manifestVersion: 1,
    environment: 'devnet',
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    supportedDomains: [domain],
    orderSchemaHash: hash('b'),
    quoteSchemaHash: hash('c'),
    routeSchemaHash: hash('d'),
    receiptSchemaHash: hash('e'),
    entryCompilerVersion: 1,
    exitCompilerVersion: 1,
    legCount: 2,
    legTypes: ['spot-purchase', 'perp-sale'],
    supportedDirections: ['LONG_SPOT_SHORT_PERP'],
    supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
    allowedSpotAdapterIds: [spotAdapter.adapterId],
    allowedPerpAdapterIds: [perpAdapter.adapterId],
    riskPolicyHash: hash('f'),
  };
  const templateHash = packageTemplateManifestHash(templateManifest);
  const templateRegistryRecord: PackageTemplateRegistryRecordInput = {
    recordVersion: 1,
    environment: 'devnet',
    domain,
    templateId: templateManifest.templateId,
    templateVersion: templateManifest.templateVersion,
    packageTemplateManifestHash: templateHash,
    registryState: 'ACTIVE',
    activationUnit: 'SOLANA_SLOT',
    activationValue: 900n,
    governanceReference: 'governance-devnet-v1',
  };
  const order: PackageOrderInput = {
    version: 1,
    environment: 'devnet',
    domain,
    templateId: templateManifest.templateId,
    templateVersion: templateManifest.templateVersion,
    packageTemplateManifestHash: templateHash,
    owner: 'trader-wallet',
    settlementAccount: 'strategy-account',
    nonce: 1n,
    expiryUnit: 'SOLANA_SLOT',
    expiryValue: 2_000n,
    direction: 'LONG_SPOT_SHORT_PERP',
    action: 'ENTRY',
    packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'FOK',
    partialFillPolicy: 'EXACT_ALL_LEGS',
    quantity: assetAmount(sol, 1_000n),
    exitOutcomeSchemaVersion: 0,
    expectedPrePositionSize: assetAmount(sol, 0n),
    expectedPrePositionEntryNotional: assetAmount(usdc, 0n),
    maxEntrySpread: {
      baseAsset: sol,
      quoteAsset: usdc,
      quoteAtoms: 5n,
      baseAtoms: 1_001n,
      roundingDirection: 'CEIL',
    },
    maxSpotQuoteIn: assetAmount(usdc, 1_100n),
    maxMarginAdded: assetAmount(usdc, 100n),
    minVenueReserveReturned: assetAmount(usdc, 0n),
    minWalletQuoteBalanceDelta: assetAmount(usdc, 0n),
    maxVenueFeeAtomsByAsset: [
      { asset: sol, maxAtoms: 10n },
      { asset: usdc, maxAtoms: 100n },
    ],
    maxProtocolFee: assetAmount(usdc, 10n),
    maxSolverFee: assetAmount(usdc, 10n),
    maxPriorityFee: assetAmount(usdc, 10n),
    maxRecoveryCostAtomsByAsset: [],
    permittedSpotAdapters: [spotAdapter],
    permittedPerpAdapters: [perpAdapter],
    settlementClass: 'ATOMIC_POSTCONDITION',
    maxAggregateRecoveryLossQuote: assetAmount(usdc, 0n),
    maxResidualBaseQuantity: assetAmount(sol, 0n),
    allowedRecoveryActions: [],
  };
  const feePolicyManifest: FeePolicyManifestInput = {
    schemaVersion: 1,
    manifestVersion: 1,
    environment: 'devnet',
    domain,
    scopeDirection: 'LONG_SPOT_SHORT_PERP',
    scopeQuantityPolicyClass: 'EXACT_ATOMIC',
    scopeSettlementClass: 'ATOMIC_POSTCONDITION',
    scopeAccountModeClass: 'user-owned-v1',
    feePolicyVersion: 1,
    activationUnit: 'SOLANA_SLOT',
    activationValue: 900n,
    serviceFeeRules: [
      {
        feeCategory: 'PROTOCOL',
        feeAssetId: usdc.assetId,
        feeAssetManifestHash: usdc.assetManifestHash,
        feeAssetDecimals: usdc.decimals,
        rateBase: 'MATCHED_PACKAGE_NOTIONAL',
        rateScale: 1n,
        fixedAtoms: 5n,
        roundingDirection: 'TOWARD_ZERO',
        hardMaximumReference: 'protocol-hard-max-v1',
        recipientIdentity: 'protocol-treasury',
        collectionAuthority: 'fee-controller',
      },
      {
        feeCategory: 'SOLVER',
        feeAssetId: usdc.assetId,
        feeAssetManifestHash: usdc.assetManifestHash,
        feeAssetDecimals: usdc.decimals,
        rateBase: 'MATCHED_PACKAGE_NOTIONAL',
        rateScale: 1n,
        fixedAtoms: 7n,
        roundingDirection: 'TOWARD_ZERO',
        hardMaximumReference: 'solver-hard-max-v1',
        recipientIdentity: 'solver-treasury',
        collectionAuthority: 'fee-controller',
      },
    ],
    passThroughCostRules: [
      {
        costCategory: 'VENUE',
        costAssetId: usdc.assetId,
        costAssetManifestHash: usdc.assetManifestHash,
        costAssetDecimals: usdc.decimals,
        maxAtoms: 100n,
        roundingDirection: 'TOWARD_ZERO',
        refundRule: 'REFUND_UNUSED_PREPAID_TO_OWNER',
      },
      {
        costCategory: 'NETWORK',
        costAssetId: usdc.assetId,
        costAssetManifestHash: usdc.assetManifestHash,
        costAssetDecimals: usdc.decimals,
        maxAtoms: 10n,
        roundingDirection: 'TOWARD_ZERO',
        refundRule: 'REFUND_UNUSED_PREPAID_TO_OWNER',
      },
    ],
    refundPolicyVersion: 1,
    expiryUnit: 'SOLANA_SLOT',
    expiryValue: 3_000n,
  };
  const price = {
    baseAsset: sol,
    quoteAsset: usdc,
    quoteAtoms: 1n,
    baseAtoms: 1n,
    roundingDirection: 'CEIL' as const,
  };
  const templateRegistryHash = packageTemplateRegistryRecordHash(templateRegistryRecord);
  const firstPayload = Uint8Array.from([1, 2, 3]);
  const secondPayload = Uint8Array.from([4, 5, 6]);
  const route: RoutePayloadInput = {
    version: 1,
    environment: 'devnet',
    domain,
    orderHash: packageOrderHash(order),
    templateId: order.templateId,
    templateVersion: order.templateVersion,
    packageTemplateManifestHash: templateHash,
    templateRegistryRecordHash: templateRegistryHash,
    owner: order.owner,
    settlementAccount: order.settlementAccount,
    solver: 'solver-alpha',
    direction: order.direction,
    action: order.action,
    quantityPolicyClass: 'EXACT_ATOMIC',
    partialFillPolicy: order.partialFillPolicy,
    settlementClass: order.settlementClass,
    executionPlanKind: 'SVM_ATOMIC_CPI',
    routeExpiryUnit: 'SOLANA_SLOT',
    routeExpiryValue: 1_800n,
    feePolicyVersion: 1,
    feePolicyManifestHash: feePolicyManifestHash(feePolicyManifest),
    accountBindings: [
      {
        routeBindingId: 'fee-vault',
        accountIdentity: 'fee-vault-account',
        ownerIdentity: 'fee-controller',
      },
      {
        routeBindingId: 'perp-program',
        adapter: perpAdapter,
        adapterBindingId: 'market-program',
        accountIdentity: 'perp-program-account',
        codeIdentity: 'perp-code-v1',
      },
      {
        routeBindingId: 'spot-program',
        adapter: spotAdapter,
        adapterBindingId: 'market-program',
        accountIdentity: 'spot-program-account',
        codeIdentity: 'spot-code-v1',
      },
      {
        routeBindingId: 'trader-authority',
        accountIdentity: order.owner,
        authorityIdentity: order.owner,
      },
    ],
    serviceCharges: [
      {
        feeCategory: 'PROTOCOL',
        asset: usdc,
        atoms: 5n,
        recipientIdentity: 'protocol-treasury',
        collectionAuthority: 'fee-controller',
        collectionModeId: 'success-only-v1',
      },
      {
        feeCategory: 'SOLVER',
        asset: usdc,
        atoms: 7n,
        recipientIdentity: 'solver-treasury',
        collectionAuthority: 'fee-controller',
        collectionModeId: 'success-only-v1',
      },
    ],
    preconditions: [{
      constraintId: 'pre-authority',
      ruleId: 'authority-equals-owner-v1',
      accountBindingId: 'trader-authority',
      componentId: 'authorized',
      comparator: 'EQ',
      value: { kind: 'BOOLEAN', value: true },
      evidenceRequirementId: 'authority-state',
    }],
    legs: [
      {
        legIndex: 0,
        legRole: 'SPOT',
        actionSequence: 0,
        adapter: spotAdapter,
        venue: spotVenue,
        market: spotMarket,
        baseAsset: sol,
        quoteAsset: usdc,
        side: 'BUY',
        quantity: { asset: sol, atoms: 1_000n },
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
        baseAsset: sol,
        quoteAsset: usdc,
        side: 'SELL',
        quantity: { asset: sol, atoms: 1_000n },
        limitPrice: price,
        timeInForce: 'FOK',
        reduceOnly: false,
      },
    ],
    actions: [
      {
        sequence: 0,
        actionClassId: 'svm-cpi-spot-v1',
        legIndex: 0,
        adapter: spotAdapter,
        targetBindingId: 'spot-program',
        authorityBindingId: 'trader-authority',
        accountMetas: [
          { routeBindingId: 'spot-program', isSigner: false, isWritable: false },
          { routeBindingId: 'trader-authority', isSigner: true, isWritable: true },
        ],
        payload: {
          codecId: 'svm-instruction-v1',
          templateLength: firstPayload.length,
          templateHash: payloadTemplateHash(firstPayload, []),
          lateBoundFields: [],
        },
        feeRecipientBindingId: 'fee-vault',
      },
      {
        sequence: 1,
        actionClassId: 'svm-cpi-perp-v1',
        legIndex: 1,
        adapter: perpAdapter,
        targetBindingId: 'perp-program',
        authorityBindingId: 'trader-authority',
        accountMetas: [
          { routeBindingId: 'perp-program', isSigner: false, isWritable: false },
          { routeBindingId: 'trader-authority', isSigner: true, isWritable: true },
        ],
        payload: {
          codecId: 'svm-instruction-v1',
          templateLength: secondPayload.length,
          templateHash: payloadTemplateHash(secondPayload, []),
          lateBoundFields: [],
        },
      },
    ],
    postconditions: [
      {
        constraintId: 'post-perp',
        ruleId: 'position-delta-v1',
        accountBindingId: 'perp-program',
        componentId: 'base-position-delta',
        comparator: 'EQ',
        value: { kind: 'SIGNED_ASSET_AMOUNT', value: assetAmount(sol, -1_000n) },
        evidenceRequirementId: 'perp-state',
      },
      {
        constraintId: 'post-spot',
        ruleId: 'balance-delta-v1',
        accountBindingId: 'spot-program',
        componentId: 'base-balance-delta',
        comparator: 'GTE',
        value: { kind: 'SIGNED_ASSET_AMOUNT', value: assetAmount(sol, 1_000n) },
        evidenceRequirementId: 'spot-state',
      },
    ],
    evidenceRequirements: {
      schemaVersion: 1,
      profileId: 'svm-atomic-evidence-v1',
      requiredPreStateComponentIds: ['authority-state'],
      requiredPostStateComponentIds: ['perp-state', 'spot-state'],
      requiredActionEvidenceTypeIds: ['cpi-result', 'transaction-signature'],
      stateReferenceSchemaHash: hash('b'),
      receiptSchemaHash: hash('c'),
      outcomeSchemaHash: hash('d'),
    },
  };
  const quote: SolverQuoteInput = {
    version: 1,
    environment: 'devnet',
    domain,
    orderHash: packageOrderHash(order),
    solverId: route.solver,
    solverCapabilityManifestHash: hash('e'),
    solverSignatureScheme: 'ED25519',
    solverVerificationKey: new Uint8Array(32).fill(1),
    quoteMode: 'FIRM_ONCHAIN',
    routeHash: routeHash(route),
    quotedOutcome: {
      kind: 'ENTRY_SPREAD',
      entrySpread: {
        baseAsset: sol,
        quoteAsset: usdc,
        quoteAtoms: 4n,
        baseAtoms: 1_001n,
        roundingDirection: 'CEIL',
      },
    },
    expectedSpotNotional: assetAmount(usdc, 1_000n),
    expectedPerpNotional: assetAmount(usdc, 1_000n),
    expectedGrossSpotQuantity: assetAmount(sol, 1_000n),
    expectedNetSpotQuantity: assetAmount(sol, 1_000n),
    expectedBaseAssetFee: assetAmount(sol, 0n),
    expectedMarginDelta: assetAmount(usdc, 50n),
    expectedRawFillFeesByAsset: [
      assetAmount(sol, 0n),
      assetAmount(usdc, 0n),
    ],
    expectedBuilderFeesByAsset: [
      assetAmount(sol, 0n),
      assetAmount(usdc, 0n),
    ],
    expectedNormalizedVenueFeesByAsset: [
      assetAmount(sol, 0n),
      assetAmount(usdc, 0n),
    ],
    solverFee: assetAmount(usdc, 7n),
    protocolFee: assetAmount(usdc, 5n),
    expectedPriorityFee: assetAmount(usdc, 3n),
    maxRecoveryCostAtomsByAsset: [],
    feePolicyVersion: 1,
    feePolicyManifestHash: feePolicyManifestHash(feePolicyManifest),
    validUntilUnit: 'SOLANA_SLOT',
    validUntilValue: 1_900n,
    reservationId: hash('f'),
    quoteNonce: 1n,
    signature: new Uint8Array(64).fill(2),
  };
  const activeRegistryRecords = [
    activeRecord(domainManifest, templateManifest, 'ASSET', sol),
    activeRecord(domainManifest, templateManifest, 'ASSET', usdc),
    activeRecord(domainManifest, templateManifest, 'ADAPTER', spotAdapter),
    activeRecord(domainManifest, templateManifest, 'ADAPTER', perpAdapter),
    activeRecord(domainManifest, templateManifest, 'VENUE', spotVenue),
    activeRecord(domainManifest, templateManifest, 'VENUE', perpVenue),
    activeRecord(domainManifest, templateManifest, 'MARKET', spotMarket),
    activeRecord(domainManifest, templateManifest, 'MARKET', perpMarket),
  ];
  return {
    domainManifest,
    templateManifest,
    templateRegistryRecord,
    feePolicyManifest,
    order,
    route,
    quote,
    activeRegistryRecords,
  };
}

function admissionInput(parts = admissionParts()): PackageAdmissionInput {
  return {
    ...parts,
    currentTime: { unit: 'SOLANA_SLOT', value: 1_000n },
    accountModeClass: 'user-owned-v1',
  };
}

function withRoute(
  input: PackageAdmissionInput,
  route: RoutePayloadInput,
  quote: Partial<SolverQuoteInput> = {},
): PackageAdmissionInput {
  return {
    ...input,
    route,
    quote: {
      ...input.quote,
      routeHash: routeHash(route),
      ...quote,
    },
  };
}

describe('package admission', () => {
  test('admits one fully linked atomic package and returns defensive identities', () => {
    const admitted = validatePackageAdmission(admissionInput());
    const expected = admitted.orderHash[0];
    admitted.orderHash[0] = expected === 0xff ? 0 : 0xff;
    assert.equal(admitted.orderHash[0], expected);
    assert.equal(admitted.route.quantityPolicyClass, 'EXACT_ATOMIC');
    assert.equal(admitted.quote.quoteMode, 'FIRM_ONCHAIN');
  });

  test('rejects environment, semantic, and active-record mismatches', () => {
    const base = admissionInput();
    assert.throws(
      () => validatePackageAdmission({
        ...base,
        quote: { ...base.quote, environment: 'testnet' },
      }),
      /environment mismatch/,
    );
    const wrongAction = { ...base.route, action: 'EXIT' as const };
    assert.throws(
      () => validatePackageAdmission(withRoute(base, wrongAction)),
      /action mismatch/,
    );
    assert.throws(
      () => validatePackageAdmission({
        ...base,
        activeRegistryRecords: base.activeRegistryRecords.map((record, index) =>
          index === 0 ? { ...record, registryState: 'ALL_PAUSED' } : record),
      }),
      /record state forbids the action/,
    );
    assert.throws(
      () => validatePackageAdmission({
        ...base,
        activeRegistryRecords: base.activeRegistryRecords.filter(
          (record) => !(record.recordKind === 'ASSET' && record.subjectId === 'sol'),
        ),
      }),
      /active record is missing/,
    );
  });

  test('rejects expiry equality, nonce substitution, and route hash mismatch', () => {
    const base = admissionInput();
    assert.throws(
      () => validatePackageAdmission({
        ...base,
        currentTime: { unit: 'SOLANA_SLOT', value: base.route.routeExpiryValue },
      }),
      /route is expired/,
    );
    assert.throws(
      () => validatePackageAdmission({
        ...base,
        order: { ...base.order, nonce: base.order.nonce + 1n },
      }),
      /hash mismatch/,
    );
    assert.throws(
      () => validatePackageAdmission({
        ...base,
        quote: { ...base.quote, routeHash: hash('0') },
      }),
      MalformedInputError,
    );
  });

  test('rejects the nearest exact quantity and outcome boundaries', () => {
    const base = admissionInput();
    const baseAsset = base.quote.expectedGrossSpotQuantity.asset;
    assert.throws(
      () => validatePackageAdmission({
        ...base,
        quote: {
          ...base.quote,
          expectedGrossSpotQuantity: assetAmount(baseAsset, 999n),
        },
      }),
      /amount mismatch/,
    );
    assert.throws(
      () => validatePackageAdmission({
        ...base,
        quote: {
          ...base.quote,
          quotedOutcome: {
            kind: 'ENTRY_SPREAD',
            entrySpread: {
              ...(base.quote.quotedOutcome.kind === 'ENTRY_SPREAD'
                ? base.quote.quotedOutcome.entrySpread
                : assert.fail('entry spread expected')),
              quoteAtoms: 6n,
            },
          },
        },
      }),
      /entry spread exceeds the signed maximum/,
    );
  });

  test('rejects route service-fee mismatch after preserving route identity linkage', () => {
    const base = admissionInput();
    const charges = base.route.serviceCharges.map((charge, index) =>
      index === 0 ? { ...charge, atoms: charge.atoms + 1n } : charge);
    const changedRoute = { ...base.route, serviceCharges: charges };
    assert.throws(
      () => validatePackageAdmission(withRoute(base, changedRoute)),
      /service charge does not equal accepted quote/,
    );
    assert.throws(
      () => validatePackageAdmission({
        ...base,
        quote: {
          ...base.quote,
          protocolFee: assetAmount(base.quote.protocolFee.asset, 11n),
        },
      }),
      /service fee exceeds policy/,
    );
  });

  test('rejects adapter and account reference substitution', () => {
    const base = admissionInput();
    const actions = base.route.actions.map((action, index) =>
      index === 0
        ? { ...action, adapter: base.route.legs[1]!.adapter }
        : action);
    const changedRoute = { ...base.route, actions };
    assert.throws(
      () => validatePackageAdmission(withRoute(base, changedRoute)),
      /action adapter mismatch/,
    );
  });
});
