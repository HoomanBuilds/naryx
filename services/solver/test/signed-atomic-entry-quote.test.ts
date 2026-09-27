import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import {
  adapterRef,
  assetRef,
  bytesEqual,
  domainRef,
  packageOrderHash,
  payloadTemplateHash,
  quoteHash,
  routePayloadBytes,
  solverQuoteBytes,
  solverSignatureDigest,
  validatePackageOrderProfile,
  versionedManifestRef,
} from '@naryx/protocol-types';
import type { PackageOrderInput, RoutePayloadInput } from '@naryx/protocol-types';
import {
  SignedAtomicEntryQuoteError,
  planAtomicEntryRoute,
  signAtomicEntryQuote,
} from '../src/index.js';
import type { AtomicEntryQuoteTerms } from '../src/index.js';

const BASE_MANIFEST = '11'.repeat(32);
const QUOTE_MANIFEST = '22'.repeat(32);
const DOMAIN_MANIFEST = '33'.repeat(32);
const TEMPLATE_MANIFEST = '44'.repeat(32);
const SPOT_ADAPTER_MANIFEST = '55'.repeat(32);
const PERP_ADAPTER_MANIFEST = '66'.repeat(32);
const FEE_POLICY_MANIFEST = 'c1'.repeat(32);
const CAPABILITY_MANIFEST = 'e1'.repeat(32);

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
    maxVenueFeeAtomsByAsset: [{ asset: base, maxAtoms: 1_000n }],
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

function routeInput(orderHash: Uint8Array | string): RoutePayloadInput {
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
  const price = {
    baseAsset: base,
    quoteAsset: quote,
    quoteAtoms: 3n,
    baseAtoms: 2n,
    roundingDirection: 'CEIL' as const,
  };
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
    feePolicyManifestHash: FEE_POLICY_MANIFEST,
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
        quantity: { asset: base, atoms: 1_000_000n },
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
        quantity: { asset: base, atoms: 1_000_000n },
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
  };
}

function quoteTerms(): AtomicEntryQuoteTerms {
  const base = assetRef('test-base', BASE_MANIFEST, 9);
  const quote = assetRef('test-quote', QUOTE_MANIFEST, 6);
  return {
    solverId: 'solver-alpha',
    solverCapabilityManifestHash: CAPABILITY_MANIFEST,
    quotedOutcome: {
      kind: 'ENTRY_SPREAD',
      entrySpread: {
        baseAsset: base,
        quoteAsset: quote,
        quoteAtoms: 1n,
        baseAtoms: 400n,
        roundingDirection: 'CEIL',
      },
    },
    expectedSpotNotional: { asset: quote, atoms: 2_000_000n },
    expectedPerpNotional: { asset: quote, atoms: 2_000_000n },
    expectedGrossSpotQuantity: { asset: base, atoms: 1_000_000n },
    expectedNetSpotQuantity: { asset: base, atoms: 1_000_000n },
    expectedBaseAssetFee: { asset: base, atoms: 0n },
    expectedMarginDelta: { asset: quote, atoms: 50_000n },
    expectedRawFillFeesByAsset: [{ asset: base, atoms: 0n }],
    expectedBuilderFeesByAsset: [{ asset: base, atoms: 0n }],
    expectedNormalizedVenueFeesByAsset: [{ asset: base, atoms: 0n }],
    solverFee: { asset: quote, atoms: 0n },
    protocolFee: { asset: quote, atoms: 0n },
    expectedPriorityFee: { asset: quote, atoms: 0n },
    maxRecoveryCostAtomsByAsset: [],
    feePolicyVersion: 1,
    feePolicyManifestHash: FEE_POLICY_MANIFEST,
    validUntilUnit: 'SOLANA_SLOT',
    validUntilValue: 300_000n,
    quoteNonce: 7n,
  };
}

test('signs a canonical atomic ENTRY quote and rejects fee-cap and wrong-digest signatures', async () => {
  const input = orderInput();
  const order = validatePackageOrderProfile(input);
  const orderHash = packageOrderHash(input);
  const route = routeInput(orderHash);
  const decision = planAtomicEntryRoute({ order, orderHash }, () => [
    {
      candidateId: 'candidate-a',
      active: true,
      capacityBaseAtoms: 1_000_000n,
      expectedNetPackageOutcomeQuoteAtoms: 1_000n,
      expectedTotalFeesQuoteAtoms: 100n,
      evidenceGrade: 'SIMULATED',
      route,
    },
  ]);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawKey = Uint8Array.from(spki.subarray(spki.length - 32));
  assert.equal(rawKey.length, 32);
  const signer = {
    verificationKey: rawKey,
    signDigest: (digest: Uint8Array) => Uint8Array.from(sign(null, Buffer.from(digest), privateKey)),
  };
  const terms = quoteTerms();
  const signed = await signAtomicEntryQuote({ order, decision, terms, signer });
  assert.equal(signed.quote.quoteMode, 'EXECUTION_COMMITMENT');
  assert.equal(signed.quote.reservationId, undefined);
  assert.equal(signed.quote.solverSignatureScheme, 'ED25519');
  assert.equal(signed.quote.signature.length, 64);
  assert.ok(bytesEqual(signed.quote.orderHash, orderHash));
  assert.ok(bytesEqual(signed.quote.routeHash, decision.routeHash));
  assert.deepEqual(signed.solverQuoteBytes, solverQuoteBytes(signed.quote));
  assert.deepEqual(routePayloadBytes(decision.route), decision.routeBytes);
  assert.ok(bytesEqual(signed.quoteHash, quoteHash(signed.quote)));
  assert.ok(bytesEqual(signed.solverSignatureDigest, solverSignatureDigest(signed.quote)));
  const spkiCheck = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(rawKey),
  ]);
  const keyObject = createPublicKey({ key: spkiCheck, format: 'der', type: 'spki' });
  assert.equal(
    verify(null, Buffer.from(signed.solverSignatureDigest), keyObject, Buffer.from(signed.quote.signature)),
    true,
  );
  await assert.rejects(
    signAtomicEntryQuote({
      order,
      decision,
      terms: { ...terms, solverFee: { asset: terms.solverFee.asset, atoms: 2_000n } },
      signer,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SignedAtomicEntryQuoteError);
      assert.equal(error.code, 'FEE_CAP_EXCEEDED');
      return true;
    },
  );
  const wrongDigestSigner = {
    verificationKey: rawKey,
    signDigest: (digest: Uint8Array) => {
      const wrong = Uint8Array.from(digest);
      wrong[0] = (wrong[0] as number) ^ 1;
      return Uint8Array.from(sign(null, Buffer.from(wrong), privateKey));
    },
  };
  await assert.rejects(
    signAtomicEntryQuote({ order, decision, terms, signer: wrongDigestSigner }),
    (error: unknown) => {
      assert.ok(error instanceof SignedAtomicEntryQuoteError);
      assert.equal(error.code, 'INVALID_SIGNATURE');
      return true;
    },
  );
});
