import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HYPERCORE_IOC_ORDER_ACTION_CLASS_ID } from '@naryx/adapter-hyperliquid';
import {
  adapterRef,
  assetAmount,
  assetRef,
  domainRef,
  exactPrice,
  packageOrderHash,
  payloadTemplateHash,
  validatePackageOrderProfile,
  versionedManifestRef,
  type PackageOrderInput,
} from '@naryx/protocol-types';
import {
  SqliteAtomicQuoteNonceSource,
  SqliteInternalAtomicQuoteStore,
  composeQuoteProviders,
  createHyperliquidTestnetQuoteRuntime,
  planAtomicEntryRoute,
  signAtomicEntryQuote,
  type HyperliquidTestnetQuoteRuntimeInput,
} from '../src/index.js';

const hash = (byte: string) => byte.repeat(64);
const domain = domainRef('hypercore:testnet', 1, hash('1'));
const base = assetRef('hypercore:testnet:btc', hash('2'), 8);
const quote = assetRef('hypercore:testnet:usdc', hash('3'), 6);
const spotAdapter = adapterRef({
  adapterId: 'hypercore-spot-v1', adapterManifestVersion: 1, adapterManifestHash: hash('4'),
});
const perpetualAdapter = adapterRef({
  adapterId: 'hypercore-perp-v1', adapterManifestVersion: 1, adapterManifestHash: hash('5'),
});
const venue = versionedManifestRef('hypercore-testnet', 1, hash('6'));
const spotMarket = versionedManifestRef('btc-usdc-spot', 1, hash('7'));
const perpetualMarket = versionedManifestRef('btc-usdc-perp', 1, hash('8'));

function price(atoms: bigint) {
  return exactPrice({
    baseAsset: base, quoteAsset: quote, quoteAtoms: atoms, baseAtoms: 1n,
    roundingDirection: 'CEIL',
  });
}

function orderInput(): PackageOrderInput {
  return {
    version: 1,
    environment: 'testnet',
    domain,
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    packageTemplateManifestHash: hash('9'),
    owner: 'testnet-master-account',
    settlementAccount: 'testnet-strategy-account',
    nonce: 11n,
    expiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    expiryValue: 2_000n,
    direction: 'LONG_SPOT_SHORT_PERP',
    action: 'ENTRY',
    packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'IOC',
    partialFillPolicy: 'EXACT_ALL_LEGS',
    quantity: assetAmount(base, 10_000n),
    hyperliquidQuantityPolicy: 'EXACT_NET',
    hyperliquidGrossSpotQuantity: assetAmount(base, 10_000n),
    hyperliquidMinNetSpotDelta: assetAmount(base, 10_000n),
    hyperliquidMaxNetSpotDelta: assetAmount(base, 10_000n),
    hyperliquidMaxTerminalResidualBaseQuantity: assetAmount(base, 0n),
    hyperliquidMaxTerminalResidualQuoteValue: assetAmount(quote, 0n),
    expectedPreStrategySpotQuantity: assetAmount(base, 0n),
    hyperliquidRecoveryExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    hyperliquidMaxRecoveryActionExpiryValue: 2_000n,
    hyperliquidRecoveryDeadlineValue: 2_100n,
    hyperliquidMinRecoveryWindowMs: 100n,
    exitOutcomeSchemaVersion: 0,
    expectedPrePositionSize: assetAmount(base, 0n),
    expectedPrePositionEntryNotional: assetAmount(quote, 0n),
    maxEntrySpread: {
      baseAsset: base, quoteAsset: quote, quoteAtoms: 10n, baseAtoms: 1n,
      roundingDirection: 'CEIL',
    },
    maxSpotQuoteIn: assetAmount(quote, 6_000_000n),
    hyperliquidMinPerpSellPrice: price(610n),
    maxMarginAdded: assetAmount(quote, 100_000n),
    minVenueReserveReturned: assetAmount(quote, 0n),
    minWalletQuoteBalanceDelta: assetAmount(quote, 0n),
    maxVenueFeeAtomsByAsset: [{ asset: base, maxAtoms: 0n }],
    maxProtocolFee: assetAmount(quote, 0n),
    maxSolverFee: assetAmount(quote, 0n),
    maxPriorityFee: assetAmount(quote, 0n),
    maxRecoveryCostAtomsByAsset: [{ asset: quote, maxAtoms: 100_000n }],
    permittedSpotAdapters: [spotAdapter],
    permittedPerpAdapters: [perpetualAdapter],
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    maxRecoverySpotBuyPrice: price(620n),
    minRecoverySpotSellPrice: price(580n),
    minRecoveryPerpSellPrice: price(580n),
    maxRecoveryPerpBuyPrice: price(620n),
    maxAggregateRecoveryLossQuote: assetAmount(quote, 500_000n),
    maxResidualBaseQuantity: assetAmount(base, 0n),
    allowedRecoveryActions: [
      'COMPLETE_SPOT', 'COMPLETE_PERP', 'ROLLBACK_SPOT', 'ROLLBACK_PERP',
    ],
  };
}

function runtimeInput(nonceSource: { next(): bigint }): HyperliquidTestnetQuoteRuntimeInput {
  const action = (sequence: number, adapter: typeof spotAdapter) => ({
    sequence,
    actionClassId: HYPERCORE_IOC_ORDER_ACTION_CLASS_ID,
    legIndex: sequence,
    adapter,
    targetBindingId: 'hypercore-exchange',
    authorityBindingId: 'testnet-agent',
    accountMetas: [],
    payload: {
      codecId: 'hypercore-order-wire-v1',
      templateLength: 0,
      templateHash: payloadTemplateHash(new Uint8Array(), []),
      lateBoundFields: [],
    },
  });
  return {
    enabled: true,
    domain,
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    packageTemplateManifestHash: hash('9'),
    templateRegistryRecordHash: hash('a'),
    candidateId: 'hypercore-testnet-btc-carry',
    capacityBaseAtoms: 20_000n,
    solverId: 'testnet-reference-solver',
    solverCapabilityManifestHash: hash('b'),
    feePolicyVersion: 1,
    feePolicyManifestHash: hash('c'),
    routeTtlMs: 500n,
    quoteTtlMs: 400n,
    marginBps: 100,
    currentTimeMs: () => 1_000n,
    nonceSource,
    spot: {
      adapter: spotAdapter, venue, market: spotMarket, limitPrice: price(600n),
      action: action(0, spotAdapter),
    },
    perpetual: {
      adapter: perpetualAdapter, venue, market: perpetualMarket, limitPrice: price(610n),
      action: action(1, perpetualAdapter),
    },
    entrySpread: {
      baseAsset: base, quoteAsset: quote, quoteAtoms: 10n, baseAtoms: 1n,
      roundingDirection: 'CEIL',
    },
    accountBindings: [
      { routeBindingId: 'hypercore-exchange', accountIdentity: 'hypercore:testnet' },
      { routeBindingId: 'testnet-agent', accountIdentity: 'configured-testnet-agent' },
    ],
    preconditions: [],
    postconditions: [],
    evidenceRequirements: {
      schemaVersion: 1,
      profileId: 'hypercore-testnet-evidence-v1',
      requiredPreStateComponentIds: ['clearinghouse-state'],
      requiredPostStateComponentIds: ['clearinghouse-state'],
      requiredActionEvidenceTypeIds: ['hypercore-fill'],
      stateReferenceSchemaHash: hash('d'),
      receiptSchemaHash: hash('e'),
      outcomeSchemaHash: hash('f'),
    },
    recovery: {
      policyVersion: 1,
      controllerId: 'hypercore-testnet-recovery-v1',
      controllerCodeHash: hash('1'),
      authorityModeId: 'exclusive-agent-v1',
      reconciledStateSchemaHash: hash('2'),
      actionBuilderCodeHash: hash('3'),
    },
  };
}

test('builds and signs an explicit-residual Hyperliquid Testnet quote without venue execution', async () => {
  const order = validatePackageOrderProfile(orderInput());
  const orderHash = packageOrderHash(order);
  const runtime = createHyperliquidTestnetQuoteRuntime(runtimeInput({ next: () => 41n }));
  const decision = planAtomicEntryRoute({ order, orderHash }, runtime.providers.candidates);
  const terms = await runtime.providers.terms({ order, decision });

  assert.equal(decision.route.executionPlanKind, 'HYPERCORE_BATCHED_IOC');
  assert.equal(decision.route.settlementClass, 'BATCHED_IOC_WITH_RECOVERY');
  assert.equal(decision.route.quantityPolicyClass, 'EXACT_NET');
  assert.equal(decision.route.routeExpiryUnit, 'HYPERLIQUID_UNIX_MILLISECONDS');
  assert.equal(decision.route.routeExpiryValue, 1_400n);
  assert.equal(decision.route.legs.every((leg) => leg.timeInForce === 'IOC'), true);
  assert.equal(terms.protocolFee.atoms, 0n);
  assert.equal(terms.solverFee.atoms, 0n);
  assert.equal(terms.quoteNonce, 41n);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const signed = await signAtomicEntryQuote({
    order,
    decision,
    terms,
    signer: {
      verificationKey: Uint8Array.from(publicDer.subarray(publicDer.length - 32)),
      signDigest: (digest) => Uint8Array.from(sign(null, Buffer.from(digest), privateKey)),
    },
  });
  assert.equal(signed.quote.expectedTerminalResidualBaseQuantity?.atoms, 0n);
  assert.equal(signed.quote.maxRecoveryCostAtomsByAsset[0]?.maxAtoms, 100_000n);
});

test('fails closed when disabled and dispatches only explicitly configured domains', () => {
  assert.throws(
    () => createHyperliquidTestnetQuoteRuntime({ ...runtimeInput({ next: () => 1n }), enabled: false }),
    /disabled/,
  );
  const order = validatePackageOrderProfile(orderInput());
  const orderHash = packageOrderHash(order);
  let localCalls = 0;
  const local = {
    candidates: () => { localCalls += 1; return []; },
    terms: () => { throw new Error('unused'); },
  };
  const dispatch = composeQuoteProviders(local);
  assert.throws(() => dispatch.candidates({ order, orderHash }), /no quote runtime is configured/);
  assert.equal(localCalls, 0);
});

test('persists quote nonces across SQLite store restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-hyperliquid-quote-'));
  const dbPath = join(directory, 'quotes.sqlite');
  try {
    const firstStore = new SqliteInternalAtomicQuoteStore(dbPath);
    const first = new SqliteAtomicQuoteNonceSource(firstStore, 'hypercore:testnet');
    assert.equal(first.next(), 1n);
    assert.equal(first.next(), 2n);
    firstStore.close();

    const secondStore = new SqliteInternalAtomicQuoteStore(dbPath);
    const second = new SqliteAtomicQuoteNonceSource(secondStore, 'hypercore:testnet');
    assert.equal(second.next(), 3n);
    secondStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
