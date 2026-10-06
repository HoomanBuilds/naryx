import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HYPERCORE_IOC_ORDER_ACTION_CLASS_ID, HyperliquidExecutionPlanner } from '@naryx/adapter-hyperliquid';
import {
  adapterRef,
  assetAmount,
  assetRef,
  domainRef,
  exactPrice,
  fromHex,
  fromProtocolJson,
  hash32,
  packageGraph,
  packageGraphHash,
  packageOrderHash,
  packageTemplateManifest,
  packageTemplateManifestHash,
  routeHash,
  routePayload,
  solverQuote,
  strategyPackageOrder,
  strategyPackageOrderHash,
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  stringifyProtocolJson,
  type PackageAdmission,
  type PackageGraphInput,
  type PackageTemplateManifestInput,
  type RoutePayloadInput,
  type SolverQuoteInput,
  payloadTemplateHash,
  validatePackageOrderProfile,
  versionedManifestRef,
  type PackageOrderInput,
} from '@naryx/protocol-types';
import {
  HYPERLIQUID_TESTNET_MARKET_INFO_URL,
  InternalAtomicQuoteError,
  SqliteAtomicQuoteNonceSource,
  SqliteInternalAtomicQuoteStore,
  composeQuoteProviders,
  createHyperliquidTestnetGeneralizedCashCarryPricing,
  createHyperliquidTestnetQuoteRuntime,
  GeneralizedStrategyQuoteError,
  loadHyperliquidTestnetGeneralizedCashCarryQuoteLane,
  loadHyperliquidTestnetQuoteRuntime,
  planAtomicEntryRoute,
  signAtomicEntryQuote,
  type HyperliquidTestnetQuoteMarketReadPort,
  type HyperliquidTestnetGeneralizedMarketReadPort,
  type HyperliquidTestnetQuoteRuntimeInput,
  type HyperliquidStrategyPreparationLane,
  type HyperliquidTestnetUserFeeRates,
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

const tradingAccount = `0x${'22'.repeat(20)}` as const;
type Level = readonly [px: string, sz: string];
type BookShape = Awaited<ReturnType<HyperliquidTestnetQuoteMarketReadPort['l2Book']>>;

function book(coin: string, time: number, bids: readonly Level[], asks: readonly Level[]): BookShape {
  const levels = (side: readonly Level[]) => side.map(([px, sz]) => ({ px, sz, n: 1 }));
  return { coin, time, levels: [levels(bids), levels(asks)] };
}

// 0.01001 BTC of asks fills 0.006 at 60000 and 0.00401 at 60010.55; 0.01 BTC of bids fills 0.004
// at 60100 and 0.006 at 60089.9. Base atoms have 8 decimals and USDC atoms have 6.
const liveSpotBook = book('@1', 900, [['59990', '1']], [['60000', '0.006'], ['60010.55', '0.01']]);
const livePerpBook = book('BTC', 950, [['60100', '0.004'], ['60089.9', '0.02']], [['60110', '1']]);
const liveFees: HyperliquidTestnetUserFeeRates = { userCrossRate: '0.00045', userSpotCrossRate: '0.0007' };

function fakeMarket(overrides: Partial<{
  spotBook: BookShape;
  perpBook: BookShape;
  fees: () => Promise<HyperliquidTestnetUserFeeRates>;
  requests: string[];
}> = {}): HyperliquidTestnetQuoteMarketReadPort {
  return {
    environment: 'testnet',
    apiUrl: HYPERLIQUID_TESTNET_MARKET_INFO_URL,
    l2Book: async (coin) => {
      overrides.requests?.push(`l2Book:${coin}`);
      return coin === '@1' ? overrides.spotBook ?? liveSpotBook : overrides.perpBook ?? livePerpBook;
    },
    userFees: async (user) => {
      overrides.requests?.push(`userFees:${user}`);
      return overrides.fees === undefined ? liveFees : overrides.fees();
    },
  };
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
    quantity: assetAmount(base, 1_000_000n),
    hyperliquidQuantityPolicy: 'BOUNDED_NET',
    hyperliquidGrossSpotQuantity: assetAmount(base, 1_001_000n),
    hyperliquidMinNetSpotDelta: assetAmount(base, 999_000n),
    hyperliquidMaxNetSpotDelta: assetAmount(base, 1_001_000n),
    hyperliquidMaxTerminalResidualBaseQuantity: assetAmount(base, 1_000n),
    hyperliquidResidualValuationSchemaVersion: 1,
    hyperliquidResidualValuationReferencePrice: price(600n),
    hyperliquidMaxTerminalResidualQuoteValue: assetAmount(quote, 600_000n),
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
    maxSpotQuoteIn: assetAmount(quote, 700_000_000n),
    hyperliquidMinPerpSellPrice: price(600n),
    maxMarginAdded: assetAmount(quote, 100_000_000n),
    minVenueReserveReturned: assetAmount(quote, 0n),
    minWalletQuoteBalanceDelta: assetAmount(quote, 0n),
    maxVenueFeeAtomsByAsset: [{ asset: base, maxAtoms: 1_000n }, { asset: quote, maxAtoms: 1_000_000n }],
    maxProtocolFee: assetAmount(quote, 0n),
    maxSolverFee: assetAmount(quote, 0n),
    maxPriorityFee: assetAmount(quote, 0n),
    maxRecoveryCostAtomsByAsset: [{ asset: quote, maxAtoms: 100_000n }],
    permittedSpotAdapters: [spotAdapter],
    permittedPerpAdapters: [perpetualAdapter],
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    maxRecoverySpotBuyPrice: price(720n),
    minRecoverySpotSellPrice: price(580n),
    minRecoveryPerpSellPrice: price(580n),
    maxRecoveryPerpBuyPrice: price(620n),
    maxAggregateRecoveryLossQuote: assetAmount(quote, 500_000n),
    maxResidualBaseQuantity: assetAmount(base, 1_000n),
    allowedRecoveryActions: [
      'COMPLETE_SPOT', 'COMPLETE_PERP', 'ROLLBACK_SPOT', 'ROLLBACK_PERP',
    ],
  };
}

function exactNetOrderInput(grossAtoms: bigint): PackageOrderInput {
  const {
    hyperliquidResidualValuationSchemaVersion: _version,
    hyperliquidResidualValuationReferencePrice: _price,
    ...rest
  } = orderInput();
  return {
    ...rest,
    hyperliquidQuantityPolicy: 'EXACT_NET',
    hyperliquidGrossSpotQuantity: assetAmount(base, grossAtoms),
    hyperliquidMinNetSpotDelta: assetAmount(base, 1_000_000n),
    hyperliquidMaxNetSpotDelta: assetAmount(base, 1_000_000n),
    hyperliquidMaxTerminalResidualBaseQuantity: assetAmount(base, 0n),
    hyperliquidMaxTerminalResidualQuoteValue: assetAmount(quote, 0n),
    maxResidualBaseQuantity: assetAmount(base, 0n),
  };
}

function runtimeInput(
  nonceSource: { next(): bigint },
  market: HyperliquidTestnetQuoteMarketReadPort = fakeMarket(),
): HyperliquidTestnetQuoteRuntimeInput {
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
    capacityBaseAtoms: 2_000_000n,
    solverId: 'testnet-reference-solver',
    solverCapabilityManifestHash: hash('b'),
    feePolicyVersion: 1,
    feePolicyManifestHash: hash('c'),
    routeTtlMs: 500n,
    quoteTtlMs: 400n,
    marginBps: 100,
    baseAsset: base,
    quoteAsset: quote,
    maxBookAgeMs: 500,
    maxBookSpreadBps: 50,
    tradingAccount,
    market,
    currentTimeMs: () => 1_000n,
    nonceSource,
    spot: {
      adapter: spotAdapter, venue, market: spotMarket, coin: '@1', sizeDecimals: 5,
      action: action(0, spotAdapter),
    },
    perpetual: {
      adapter: perpetualAdapter, venue, market: perpetualMarket, coin: 'BTC', sizeDecimals: 5,
      action: action(1, perpetualAdapter),
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

function quoteSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    verificationKey: Uint8Array.from(publicDer.subarray(publicDer.length - 32)),
    signDigest: (digest: Uint8Array) => Uint8Array.from(sign(null, Buffer.from(digest), privateKey)),
  };
}

async function quoteFor(input: PackageOrderInput, market = fakeMarket()) {
  const order = validatePackageOrderProfile(input);
  const orderHash = packageOrderHash(order);
  const runtime = createHyperliquidTestnetQuoteRuntime(runtimeInput({ next: () => 41n }, market));
  const candidates = await runtime.providers.candidates({ order, orderHash });
  const decision = planAtomicEntryRoute({ order, orderHash }, () => candidates);
  const terms = await runtime.providers.terms({ order, decision });
  return { order, decision, terms, runtime };
}

function feeAtoms(fees: readonly { asset: { assetId: string }; atoms: bigint }[]) {
  return Object.fromEntries(fees.map((fee) => [fee.asset.assetId, fee.atoms]));
}

test('prices an entry from live Testnet books and the account fee schedule, rounding against the trader', async () => {
  const requests: string[] = [];
  const { order, decision, terms, runtime } = await quoteFor(orderInput(), fakeMarket({ requests }));

  assert.deepEqual(requests, ['l2Book:@1', 'l2Book:BTC', `userFees:${tradingAccount}`]);
  assert.equal(decision.route.executionPlanKind, 'HYPERCORE_BATCHED_IOC');
  assert.equal(decision.route.quantityPolicyClass, 'BOUNDED_NET');
  // G-051: the initial action (route) expiry ends strictly before the quote validity.
  assert.equal(decision.route.routeExpiryValue, 1_399n);
  assert.equal(terms.validUntilValue, 1_400n);
  // Spot IOC limit is the signed cap per gross unit at HyperCore wire precision (69930 USDC/BTC);
  // the perpetual limit is the exact signed minimum sell price.
  const [spotLeg, perpLeg] = decision.route.legs;
  assert.deepEqual([spotLeg?.limitPrice.quoteAtoms, spotLeg?.limitPrice.baseAtoms], [6_993n, 10n]);
  assert.deepEqual([perpLeg?.limitPrice.quoteAtoms, perpLeg?.limitPrice.baseAtoms], [600n, 1n]);
  // Spot cost 600642305.5 rounds up; perpetual proceeds 600939400 are exact.
  assert.equal(terms.expectedSpotNotional.atoms, 600_642_306n);
  assert.equal(terms.expectedPerpNotional.atoms, 600_939_400n);
  // Spot taker fee 0.07% of 1001000 base atoms is 700.7, charged in base and rounded up.
  assert.equal(terms.expectedBaseAssetFee.atoms, 701n);
  assert.equal(terms.expectedGrossSpotQuantity.atoms, 1_001_000n);
  assert.equal(terms.expectedNetSpotQuantity.atoms, 1_000_299n);
  // Perpetual taker fee 0.045% of 600939400 is 270422.73, rounded up.
  assert.deepEqual(feeAtoms(terms.expectedNormalizedVenueFeesByAsset), {
    'hypercore:testnet:btc': 701n, 'hypercore:testnet:usdc': 270_423n,
  });
  assert.deepEqual(terms.expectedRawFillFeesByAsset, terms.expectedNormalizedVenueFeesByAsset);
  assert.ok(terms.expectedBuilderFeesByAsset.every((fee) => fee.atoms === 0n));
  assert.equal(terms.expectedTerminalResidualBaseQuantity?.atoms, 299n);
  assert.equal(terms.expectedTerminalResidualQuoteValue?.atoms, 179_400n);
  assert.equal(terms.expectedMarginDelta.atoms, 6_009_394n);
  const spread = terms.quotedOutcome.kind === 'ENTRY_SPREAD' ? terms.quotedOutcome.entrySpread : undefined;
  assert.deepEqual([spread?.quoteAtoms, spread?.baseAtoms], [-408_197n, 455_000n]);
  assert.equal(decision.expectedNetPackageOutcomeQuoteAtoms, 26_671n);
  assert.equal(decision.expectedTotalFeesQuoteAtoms, 691_053n);
  assert.equal(terms.quoteNonce, 41n);

  const signer = quoteSigner();
  const signed = await signAtomicEntryQuote({ order, decision, terms, signer });
  assert.equal(signed.quote.expectedNetSpotQuantity.atoms, 1_000_299n);
  await assert.rejects(signAtomicEntryQuote({
    order, decision, signer,
    terms: { ...terms, expectedTerminalResidualBaseQuantity: assetAmount(base, 1_000n) },
  }), /residuals must remain within signed bounds/);
  await assert.rejects(signAtomicEntryQuote({
    order, decision, signer,
    terms: { ...terms, expectedNetSpotQuantity: assetAmount(base, 1_001_000n) },
  }), /gross minus base fee/);
  // Terms are taken once from the snapshot that produced the decision; nothing is re-read.
  assert.throws(() => runtime.providers.terms({ order, decision }), /no live Hyperliquid Testnet quote/);
});

test('fails closed when the book cannot fill within the signed limit or is stale or crossed', async () => {
  const input = orderInput();
  const reject = (market: HyperliquidTestnetQuoteMarketReadPort, pattern: RegExp) =>
    assert.rejects(quoteFor(input, market), pattern);

  await reject(fakeMarket({ spotBook: book('@1', 900, [['59990', '1']], [['60000', '0.006']]) }),
    /spot book cannot fill the requested size/);
  // A market that cannot price the order declines it with the reason the trader is shown.
  await assert.rejects(quoteFor(input, fakeMarket({ spotBook: book('@1', 900, [['59990', '1']], [['60000', '0.006']]) })),
    (error: unknown) => error instanceof InternalAtomicQuoteError && error.code === 'QUOTE_DECLINED'
      && error.message === 'QUOTE_DECLINED: Hyperliquid testnet quote declined: spot book cannot fill the requested size within the signed limit');
  await reject(fakeMarket({
    spotBook: book('@1', 900, [['59990', '1']], [['60000', '0.006'], ['69931', '1']]),
  }), /spot book cannot fill the requested size within the signed limit/);
  await reject(fakeMarket({
    perpBook: book('BTC', 950, [['60100', '0.004'], ['59999', '1']], [['60110', '1']]),
  }), /perpetual book cannot fill the requested size within the signed limit/);
  await reject(fakeMarket({ spotBook: { ...liveSpotBook!, time: 499 } }), /spot book is stale/);
  await reject(fakeMarket({
    perpBook: book('BTC', 950, [['60100', '1']], [['60100', '1']]),
  }), /perpetual book is crossed or locked/);
  await reject(fakeMarket({
    spotBook: book('@1', 900, [['59000', '1']], [['60000', '1']]),
  }), /spot book bid-ask spread exceeds the configured cap/);

  // The wire limit itself is executable.
  const boundary = await quoteFor(input, fakeMarket({
    spotBook: book('@1', 900, [['59990', '1']], [['60000', '0.006'], ['69930', '1']]),
  }));
  assert.equal(boundary.terms.expectedSpotNotional.atoms, 640_419_300n);
});

test('fails closed without a real fee schedule and when the base fee breaks the signed net quantity', async () => {
  const input = orderInput();
  await assert.rejects(quoteFor(input, fakeMarket({
    fees: async () => { throw new Error('userFees request failed'); },
  })), /userFees request failed/);
  await assert.rejects(quoteFor(input, fakeMarket({
    fees: async () => ({ userCrossRate: '0.00045' }) as HyperliquidTestnetUserFeeRates,
  })), /userSpotCrossRate is unavailable/);
  await assert.rejects(quoteFor(input, fakeMarket({
    fees: async () => ({ userCrossRate: '1', userSpotCrossRate: '0.0007' }),
  })), /userCrossRate must be below one/);

  // EXACT_NET with gross equal to the perpetual quantity cannot absorb a nonzero base fee.
  await assert.rejects(quoteFor(exactNetOrderInput(1_000_000n)),
    /net spot quantity after the base-asset fee is outside the signed interval/);
  const exact = await quoteFor(exactNetOrderInput(1_000_000n), fakeMarket({
    fees: async () => ({ userCrossRate: '0.00045', userSpotCrossRate: '0' }),
  }));
  assert.equal(exact.terms.expectedNetSpotQuantity.atoms, 1_000_000n);
  assert.equal(exact.terms.expectedTerminalResidualBaseQuantity?.atoms, 0n);
  await signAtomicEntryQuote({ ...exact, signer: quoteSigner() });
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

test('loads only a version 2 config without prices for the configured trading account', () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-hyperliquid-quote-config-'));
  const configPath = join(directory, 'quote.json');
  const env = {
    NARYX_HYPERLIQUID_TESTNET_QUOTE_ENABLED: 'true',
    NARYX_HYPERLIQUID_TESTNET_QUOTE_CONFIG: configPath,
    NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT: tradingAccount,
  };
  const dependencies = { nonceSource: { next: () => 1n }, market: fakeMarket() };
  try {
    writeFileSync(configPath, JSON.stringify({ version: 1, market: {} }));
    assert.throws(() => loadHyperliquidTestnetQuoteRuntime(env, dependencies), /version 2/);
    assert.throws(() => loadHyperliquidTestnetQuoteRuntime(
      { ...env, NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT: undefined }, dependencies,
    ), /NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT/);
    assert.equal(loadHyperliquidTestnetQuoteRuntime({}, dependencies), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('loads a reviewed config whose identity hashes are hex strings and quotes the same route from it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-hyperliquid-quote-config-'));
  const configPath = join(directory, 'quote.json');
  const {
    enabled: _enabled, tradingAccount: _account, market: _market, currentTimeMs: _clock, nonceSource: _nonce,
    ...reviewed
  } = runtimeInput({ next: () => 41n });
  // The release generator writes leg and asset hashes as plain hex; an operator may 0x-prefix one.
  const plain = (value: Uint8Array) => Buffer.from(value).toString('hex');
  const hexLeg = (leg: typeof reviewed.spot) => ({
    ...leg,
    adapter: { ...leg.adapter, adapterManifestHash: plain(leg.adapter.adapterManifestHash) },
    venue: { ...leg.venue, manifestHash: plain(leg.venue.manifestHash) },
    market: { ...leg.market, manifestHash: plain(leg.market.manifestHash) },
    action: { ...leg.action, adapter: { ...leg.adapter, adapterManifestHash: `0x${plain(leg.adapter.adapterManifestHash)}` } },
  });
  const market = {
    ...reviewed,
    baseAsset: { ...base, assetManifestHash: plain(base.assetManifestHash) },
    quoteAsset: { ...quote, assetManifestHash: plain(quote.assetManifestHash) },
    spot: hexLeg(reviewed.spot),
    perpetual: hexLeg(reviewed.perpetual),
  };
  const env = {
    NARYX_HYPERLIQUID_TESTNET_QUOTE_ENABLED: 'true',
    NARYX_HYPERLIQUID_TESTNET_QUOTE_CONFIG: configPath,
    NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT: tradingAccount,
  };
  const dependencies = { nonceSource: { next: () => 41n }, market: fakeMarket(), currentTimeMs: () => 1_000n };
  try {
    writeFileSync(configPath, stringifyProtocolJson({ version: 2, market }, 'quote'));
    const runtime = loadHyperliquidTestnetQuoteRuntime(env, dependencies)!;
    const order = validatePackageOrderProfile(orderInput());
    const orderHash = packageOrderHash(order);
    const [candidate] = await runtime.providers.candidates({ order, orderHash });
    const { decision } = await quoteFor(orderInput());
    assert.deepEqual(routeHash(candidate!.route), decision.routeHash);

    const { baseAsset: _base, ...withoutBase } = market;
    writeFileSync(configPath, stringifyProtocolJson({ version: 2, market: withoutBase }, 'quote'));
    assert.throws(() => loadHyperliquidTestnetQuoteRuntime(env, dependencies), /market\.baseAsset is missing or malformed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test('quotes a complete-package exit that sells the package spot and buys back its short', async () => {
  const {
    maxEntrySpread: _spread,
    maxSpotQuoteIn: _cap,
    hyperliquidMinPerpSellPrice: _floor,
    ...entry
  } = orderInput();
  const order = validatePackageOrderProfile({
    ...entry,
    action: 'EXIT',
    hyperliquidGrossSpotQuantity: assetAmount(base, 1_000_000n),
    hyperliquidMinNetSpotDelta: assetAmount(base, -1_000_000n),
    hyperliquidMaxNetSpotDelta: assetAmount(base, -1_000_000n),
    expectedPreStrategySpotQuantity: assetAmount(base, 1_000_000n),
    exitOutcomeSchemaVersion: 1,
    entryReceiptHash: hash32('ab'.repeat(32)),
    expectedPrePositionSize: assetAmount(base, -1_000_000n),
    expectedPrePositionEntryNotional: assetAmount(quote, 600_939_400n),
    minSpotQuoteOut: assetAmount(quote, 590_000_000n),
    minExitQuoteOutcome: assetAmount(quote, 500_000_000n),
    hyperliquidMaxPerpBuyPrice: price(615n),
    maxMarginAdded: assetAmount(quote, 0n),
  });
  const orderHash = packageOrderHash(order);
  const runtime = createHyperliquidTestnetQuoteRuntime(runtimeInput({ next: () => 42n }));
  const signed = await runtime.exit({ order, orderHash, signer: quoteSigner() });
  const route = routePayload(fromProtocolJson(signed.route, 'route') as RoutePayloadInput);
  const signedQuote = solverQuote(fromProtocolJson(signed.quote, 'quote') as SolverQuoteInput);

  const [spotLeg, perpLeg] = route.legs;
  assert.deepEqual([spotLeg?.side, spotLeg?.reduceOnly, spotLeg?.quantity.atoms], ['SELL', false, 1_000_000n]);
  assert.deepEqual([perpLeg?.side, perpLeg?.reduceOnly, perpLeg?.quantity.atoms], ['BUY', true, 1_000_000n]);
  assert.ok(route.routeExpiryValue < signedQuote.validUntilValue);
  // 0.01 BTC sold at the 59990 bid and bought back at the 60110 ask; fees in USDC round up.
  assert.equal(signedQuote.expectedSpotNotional.atoms, 599_900_000n);
  assert.equal(signedQuote.expectedPerpNotional.atoms, 601_100_000n);
  assert.equal(signedQuote.expectedNetSpotQuantity.atoms, -1_000_000n);
  assert.deepEqual(feeAtoms(signedQuote.expectedNormalizedVenueFeesByAsset), {
    'hypercore:testnet:btc': 0n, 'hypercore:testnet:usdc': 690_425n,
  });
  assert.deepEqual(signedQuote.quotedOutcome, {
    kind: 'EXIT_QUOTE_OUTCOME',
    exitQuoteOutcome: { asset: quote, atoms: 599_048_975n },
  });
  const slots = Object.fromEntries(route.recoveryPlan!.actionSlots.map((slot) => [slot.action, slot]));
  assert.equal(slots.COMPLETE_SPOT?.limitPrice?.quoteAtoms, 580n);
  assert.deepEqual([slots.COMPLETE_PERP?.reduceOnly, slots.COMPLETE_PERP?.limitPrice?.quoteAtoms], [true, 620n]);
  assert.deepEqual([slots.ROLLBACK_PERP?.reduceOnly, slots.ROLLBACK_PERP?.limitPrice?.quoteAtoms], [false, 580n]);

  // The adapter compiles the signed exit against the omnibus account's aggregate short.
  const plan = new HyperliquidExecutionPlanner({
    environment: 'testnet',
    seriesIdentity: { domain, seriesManifestHash: hash('4'), executionClassManifestHash: hash('5') },
    spot: { adapter: spotAdapter, venue, market: spotMarket, assetId: 10_001, sizeDecimals: 5 },
    perpetual: { adapter: perpetualAdapter, venue, market: perpetualMarket, assetId: 3, sizeDecimals: 5 },
  }).compile({
    order, route, quote: signedQuote, orderHash,
    routeHash: fromHex(signed.routeHash), quoteHash: fromHex(signed.quoteHash),
  } as unknown as PackageAdmission, { accountPrePerpPositionAtoms: -3_000_000n });
  assert.equal(plan.signedPerpTargetAtoms, -2_000_000n);
  assert.deepEqual(plan.legs.map((leg) => [leg.order.b, leg.order.r, leg.order.p]), [
    [false, false, '59000'], [true, true, '61500'],
  ]);
  await assert.rejects(runtime.exit({
    order: validatePackageOrderProfile(orderInput()), orderHash, signer: quoteSigner(),
  }), /outside the configured Hyperliquid Testnet quote domain/);
});

test('prices a generalized Hyperliquid cash-and-carry package from live fee and funding state', async () => {
  const template: PackageTemplateManifestInput = {
    manifestVersion: 1,
    environment: 'testnet',
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    supportedDomains: [domain],
    orderSchemaHash: hash('1'),
    quoteSchemaHash: hash('2'),
    routeSchemaHash: hash('3'),
    receiptSchemaHash: hash('4'),
    entryCompilerVersion: 1,
    exitCompilerVersion: 1,
    legCount: 2,
    legTypes: ['spot-purchase', 'perp-sale'],
    supportedDirections: ['LONG_SPOT_SHORT_PERP'],
    supportedSettlementClasses: ['BATCHED_IOC_WITH_RECOVERY'],
    allowedSpotAdapterIds: [spotAdapter.adapterId],
    allowedPerpAdapterIds: [perpetualAdapter.adapterId],
    riskPolicyHash: hash('5'),
  };
  const templateHash = packageTemplateManifestHash(template);
  const graphInput: PackageGraphInput = {
    graphVersion: 1,
    environment: 'testnet',
    templateId: template.templateId,
    templateVersion: 1,
    packageTemplateManifestHash: templateHash,
    seriesId: 'btc-carry-testnet',
    seriesVersion: 1,
    seriesManifestHash: hash('6'),
    executionClassId: 'hypercore-batched-ioc-v1',
    executionClassVersion: 1,
    executionClassManifestHash: hash('7'),
    lifecycleAction: 'ENTRY',
    owner: 'testnet-trader',
    strategyAccountRefs: ['testnet-strategy-account'],
    legs: [{
      legId: 'spot',
      legFamily: 'SPOT_SWAP',
      legTypeId: 'spot-purchase',
      domain,
      adapter: spotAdapter,
      venue,
      market: spotMarket,
      assets: [base, quote],
      side: 'BUY',
      quantityAsset: base,
      quantityAtoms: 1_001_000n,
      minimumQuantityAtoms: 1_001_000n,
      limitPrice: exactPrice({
        baseAsset: base, quoteAsset: quote, quoteAtoms: 700n, baseAtoms: 1n,
        roundingDirection: 'FLOOR',
      }),
      maximumFeeQuoteAtoms: 1_000_000n,
      preconditionHashes: [],
      postconditionHashes: [],
      timeInForce: 'IOC',
      legExpiryValue: 1_500n,
    }, {
      legId: 'perp',
      legFamily: 'PERP_OPEN',
      legTypeId: 'perp-sale',
      domain,
      adapter: perpetualAdapter,
      venue,
      market: perpetualMarket,
      assets: [base, quote],
      side: 'SELL',
      quantityAsset: base,
      quantityAtoms: 1_000_000n,
      minimumQuantityAtoms: 1_000_000n,
      limitPrice: exactPrice({
        baseAsset: base, quoteAsset: quote, quoteAtoms: 600n, baseAtoms: 1n,
        roundingDirection: 'CEIL',
      }),
      maximumFeeQuoteAtoms: 1_000_000n,
      preconditionHashes: [],
      postconditionHashes: [],
      timeInForce: 'IOC',
      legExpiryValue: 1_500n,
    }],
    dependencyEdges: [],
    executionGroups: [{ groupId: 'batched', kind: 'EXACT_FILL', legIds: ['spot', 'perp'] }],
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    policyHashes: {
      netting: hash('8'),
      privacy: hash('9'),
      solver: hash('a'),
      delivery: hash('b'),
      resource: hash('c'),
      portfolioRiskLimits: hash('d'),
    },
    recoverySlots: [{
      legId: 'spot', action: 'ROLLBACK', maximumQuantityAtoms: 1_001_000n,
      maximumCostQuoteAtoms: 1_000_000n,
    }, {
      legId: 'perp', action: 'COMPLETE', maximumQuantityAtoms: 1_000_000n,
      maximumCostQuoteAtoms: 1_000_000n,
    }],
    maximumRecoveryCostQuoteAtoms: 2_000_000n,
    expiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    packageExpiryValue: 2_000n,
    nonce: 1n,
  };
  const graph = packageGraph(graphInput);
  const order = strategyPackageOrder({
    version: 1,
    environment: graph.environment,
    templateId: graph.templateId,
    templateVersion: graph.templateVersion,
    packageTemplateManifestHash: graph.packageTemplateManifestHash,
    graphHash: packageGraphHash(graph),
    seriesId: graph.seriesId,
    seriesVersion: graph.seriesVersion,
    seriesManifestHash: graph.seriesManifestHash,
    executionClassId: graph.executionClassId,
    executionClassVersion: graph.executionClassVersion,
    executionClassManifestHash: graph.executionClassManifestHash,
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.ANNUALIZED_NET_YIELD,
    riskClassId: STRATEGY_RISK_CLASS_ID.DELTA_NEUTRAL_BASIS,
    owner: graph.owner,
    settlementAccount: 'testnet-strategy-account',
    lifecycleAction: 'ENTRY',
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'IOC',
    economicQuantity: assetAmount(base, 1_000_000n),
    quoteAsset: quote,
    metricLimits: [],
    maximumServiceFeesByAsset: [],
    maximumVenueFeesByAsset: [{ asset: quote, maxAtoms: 1_000_000n }],
    maximumNetworkFeesByAsset: [],
    maximumRecoveryCostByAsset: [{ asset: quote, maxAtoms: 2_000_000n }],
    maximumMarginIncrease: assetAmount(quote, 100_000_000n),
    maximumResidualValue: assetAmount(quote, 1_000_000n),
    expiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    expiryValue: 2_000n,
    nonce: 1n,
  });
  const documents = {
    orderHashHex: Buffer.from(strategyPackageOrderHash(order)).toString('hex'),
    graphHashHex: Buffer.from(packageGraphHash(graph)).toString('hex'),
    order,
    graph,
    recordedAtMs: 1,
  };
  const requests: string[] = [];
  const market: HyperliquidTestnetGeneralizedMarketReadPort = {
    ...fakeMarket({ requests }),
    perpetualContext: async (coin) => {
      requests.push(`perpetualContext:${coin}`);
      return { funding: '0.0000125' };
    },
  };
  const pricingInput = {
    domain,
    baseAsset: base,
    quoteAsset: quote,
    tradingAccount,
    market,
    maxBookAgeMs: 500,
    maxBookSpreadBps: 50,
    marginBps: 1_000,
    holdingDurationMs: 3_600_000n,
    expectedExitBasisBps: 0n,
    routeTtlMs: 100n,
    quoteTtlMs: 200n,
    feePolicyVersion: 1,
    feePolicyManifestHash: hash('e'),
    nonceSource: { next: () => 1n },
    spot: { adapter: spotAdapter, venue, market: spotMarket, coin: '@1', sizeDecimals: 5 },
    perpetual: {
      adapter: perpetualAdapter, venue, market: perpetualMarket, coin: 'BTC', sizeDecimals: 5,
    },
  } as const;
  const terms = await createHyperliquidTestnetGeneralizedCashCarryPricing(pricingInput).quote({
    documents,
    currentTime: { unit: 'HYPERLIQUID_UNIX_MILLISECONDS', value: 1_000n },
  });

  assert.deepEqual(requests, [
    'l2Book:@1', `l2Book:BTC`, `userFees:${tradingAccount}`, 'perpetualContext:BTC',
  ]);
  assert.equal(terms.quoteMode, 'EXECUTION_COMMITMENT');
  assert.equal(terms.economics.templateId, 'cash-and-carry-v1');
  assert.equal(terms.economics.expectedFundingAtoms, 7_511n);
  assert.equal(terms.economics.totalFeesAtoms, 691_053n);
  assert.equal(terms.economics.capitalRequiredAtoms, 660_736_246n);
  assert.equal(terms.legEconomics.length, 2);
  assert.deepEqual(terms.passThroughCosts, [{
    category: 'VENUE', amount: assetAmount(quote, 691_053n),
  }]);
  assert.equal(terms.routeExpiryValue, 1_100n);
  assert.equal(terms.validUntilValue, 1_200n);
  assert.equal(terms.quoteNonce, 1n);

  const directory = mkdtempSync(join(tmpdir(), 'naryx-generalized-hyperliquid-'));
  const configPath = join(directory, 'quote.json');
  const {
    enabled: _enabled,
    tradingAccount: _tradingAccount,
    market: _market,
    currentTimeMs: _currentTime,
    nonceSource: _nonce,
    ...reviewedMarket
  } = runtimeInput({ next: () => 2n });
  const preparationLane: HyperliquidStrategyPreparationLane = {
    environment: 'testnet',
    domain,
    templateManifest: packageTemplateManifest(template),
    activeRegistryRecords: [],
    resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 4 }],
    marketBindings: [{
      adapter: spotAdapter,
      venue,
      market: spotMarket,
      assetId: 10_001,
      sizeDecimals: 5,
      maximumPriceDecimals: 3,
    }, {
      adapter: perpetualAdapter,
      venue,
      market: perpetualMarket,
      assetId: 3,
      sizeDecimals: 5,
      maximumPriceDecimals: 3,
    }],
  };
  const laneEnvironment = {
    NARYX_HYPERLIQUID_TESTNET_GENERALIZED_QUOTE_ENABLED: 'true',
    NARYX_HYPERLIQUID_TESTNET_QUOTE_CONFIG: configPath,
    NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT: tradingAccount,
    NARYX_HYPERLIQUID_GENERALIZED_LANE_ID: 'hypercore-testnet-btc-carry-v1',
    NARYX_HYPERLIQUID_GENERALIZED_EXECUTION_CLASS_ID: graph.executionClassId,
    NARYX_HYPERLIQUID_GENERALIZED_EXECUTION_CLASS_VERSION: '1',
    NARYX_HYPERLIQUID_GENERALIZED_EXECUTION_CLASS_MANIFEST_HASH:
      Buffer.from(graph.executionClassManifestHash).toString('hex'),
    NARYX_HYPERLIQUID_GENERALIZED_HOLDING_DURATION_MS: '3600000',
    NARYX_HYPERLIQUID_GENERALIZED_EXPECTED_EXIT_BASIS_BPS: '0',
  };
  try {
    writeFileSync(configPath, stringifyProtocolJson({
      version: 2,
      market: {
        ...reviewedMarket,
        packageTemplateManifestHash: templateHash,
        routeTtlMs: 100n,
        quoteTtlMs: 200n,
        marginBps: 1_000,
      },
    }));
    const loaded = loadHyperliquidTestnetGeneralizedCashCarryQuoteLane(
      laneEnvironment,
      [preparationLane],
      { nonceSource: { next: () => 2n }, market, currentTimeMs: () => 1_000n },
    );
    assert.equal(loaded?.laneId, 'hypercore-testnet-btc-carry-v1');
    assert.deepEqual(loaded?.adapterSupport.map((support) => support.legFamily), [
      'SPOT_SWAP', 'PERP_OPEN',
    ]);
    assert.equal(loadHyperliquidTestnetGeneralizedCashCarryQuoteLane(
      {},
      [preparationLane],
      { nonceSource: { next: () => 2n }, market },
    ), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const staleMarket: HyperliquidTestnetGeneralizedMarketReadPort = {
    ...market,
    l2Book: async (coin) => {
      const value = await market.l2Book(coin);
      assert.ok(value !== null);
      return {
        coin: value.coin,
        levels: value.levels,
        ...(value.spread === undefined ? {} : { spread: value.spread }),
        time: 499,
      };
    },
  };
  await assert.rejects(
    createHyperliquidTestnetGeneralizedCashCarryPricing({ ...pricingInput, market: staleMarket }).quote({
      documents,
      currentTime: { unit: 'HYPERLIQUID_UNIX_MILLISECONDS', value: 1_000n },
    }),
    (error) => error instanceof GeneralizedStrategyQuoteError
      && error.code === 'QUOTE_DECLINED'
      && /stale or future-dated/.test(error.message),
  );
});
