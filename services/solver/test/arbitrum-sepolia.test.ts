import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  adapterRef,
  assetAmount,
  assetRef,
  domainRef,
  packageOrderHash,
  payloadTemplateHash,
  validatePackageOrderProfile,
  versionedManifestRef,
  type PackageOrderInput,
  type QuotedOutcomeInput,
} from '@naryx/protocol-types';
import { ContractFunctionRevertedError, encodeAbiParameters, hashTypedData, keccak256, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  ArbitrumSepoliaExecutor,
  GMX_DATA_STORE_KEYS,
  SqliteArbitrumSepoliaExecutionJournal,
  arbitrumAsyncPackageId,
  arbitrumAsyncReserveTypedData,
  arbitrumSepoliaAccountCodeHash,
  arbitrumSepoliaAccountOf,
  createArbitrumSepoliaQuoteRuntime,
  gmxIncreaseExecutionFeeWei,
  gmxPositionFeeFactorKey,
  planAtomicEntryRoute,
  signAtomicEntryQuote,
  type ArbitrumSepoliaExecutionAttempt,
  type ArbitrumSepoliaExecutorConfig,
  type ArbitrumSepoliaReadPort,
  type ArbitrumSepoliaWritePort,
} from '../src/index.js';
import { UNISWAP_V3_QUOTER_V2_ABI } from '../src/uniswap-v3-quoter.js';

const hash = (byte: string) => byte.repeat(64);
const hex = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const domain = domainRef('eip155:421614', 1, hash('1'));
const base = assetRef('eip155:421614:weth', hash('2'), 18);
const quote = assetRef('eip155:421614:usdc', hash('3'), 6);
const spotAdapter = adapterRef({ adapterId: 'uniswap-v3-spot', adapterManifestVersion: 1, adapterManifestHash: hash('4') });
const perpetualAdapter = adapterRef({ adapterId: 'gmx-v2-arbitrum', adapterManifestVersion: 1, adapterManifestHash: hash('5') });
const owner = address('3');
const accountFactory = address('4');
const accountImplementation = address('8');
const ownerAccountAddress = arbitrumSepoliaAccountOf(accountFactory, accountImplementation, owner);
const priceFeed = { address: address('5'), expectedCodeHash: hex('5') };
const dataStore = { address: address('6'), expectedCodeHash: hex('6') };
const market = address('7');
const NOW = 1_000_000n;
// ETH at 2500.12345678 USD with 8 feed decimals; 0.01 ETH is 10^16 base atoms.
const ANSWER = 250_012_345_678n;
const QUANTITY = 10n ** 16n;
// The factory's spot port swaps WETH ('f') against USDC ('c') through a 0.05% pool.
const spotPort = address('e');
const spotPool = address('9');
const uniswapFactory = address('1');
const spotQuoter = { address: address('2'), expectedCodeHash: hex('2') };
const gmxReader = { address: address('a'), expectedCodeHash: hex('a') };
// GMX prices are 30-decimal USD per base atom: the reference is 2500.12345678 USD per 10^18 atoms.
const REFERENCE_PRICE = 2_500_123_456_780_000n;
const marketKey = (name: string) => keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'address' }],
  [keccak256(encodeAbiParameters([{ type: 'string' }], [name])), market],
));

type QuoterCall = Readonly<{ address: Address; functionName: string; args?: readonly unknown[] }>;

function readPort(options: Readonly<{
  quoteIn?: bigint | Error;
  quoterCodeHash?: Hex;
  poolFactory?: Address;
  calls?: QuoterCall[];
  /** GMX's execution price for the short and its price impact; no impact by default. */
  gmx?: Readonly<{ executionPrice: bigint; priceImpactUsd: bigint }>;
  minCollateralUsd?: bigint;
  readerCodeHash?: Hex;
}> = {}): ArbitrumSepoliaReadPort {
  const codes = new Map<string, Hex>([
    [priceFeed.address, priceFeed.expectedCodeHash], [dataStore.address, dataStore.expectedCodeHash],
    [spotPort, hex('e')], [spotQuoter.address, options.quoterCodeHash ?? spotQuoter.expectedCodeHash],
    [gmxReader.address, options.readerCodeHash ?? gmxReader.expectedCodeHash],
  ]);
  const uints = new Map<string, bigint>([
    [gmxPositionFeeFactorKey(market, true), 3n * 10n ** 26n],
    [gmxPositionFeeFactorKey(market, false), 5n * 10n ** 26n],
    [GMX_DATA_STORE_KEYS.minCollateralUsd, options.minCollateralUsd ?? 10n ** 30n],
    [GMX_DATA_STORE_KEYS.minPositionSizeUsd, 10n ** 30n],
    [marketKey('MIN_COLLATERAL_FACTOR'), 5n * 10n ** 27n],
  ]);
  return {
    chainId: async () => 421_614n,
    codeHash: async (target) => codes.get(target),
    latestBlockTimestamp: async () => NOW,
    gasPrice: async () => 100_000_000n,
    readContract: async ({ address: target, functionName, args }) => {
      switch (functionName) {
        case 'decimals': return 8;
        case 'latestRoundData': return [7n, ANSWER, NOW - 10n, NOW - 10n, 7n];
        case 'getUint':
          if (uints.has(String(args?.[0]))) return uints.get(String(args?.[0]));
          break;
        case 'getExecutionPrice': {
          options.calls?.push({ address: target, functionName, ...(args === undefined ? {} : { args }) });
          const gmx = options.gmx ?? { executionPrice: REFERENCE_PRICE, priceImpactUsd: 0n };
          return { ...gmx, balanceWasImproved: false, proportionalPendingImpactUsd: 0n, totalImpactUsd: 0n, priceImpactDiffUsd: 0n };
        }
        case 'spotPort': return spotPort;
        case 'spotPortCodeHash': return hex('e');
        case 'pool': return spotPool;
        case 'poolFee': return 500;
        case 'baseToken': return address('f');
        case 'quoteToken': return address('c');
        case 'factory': return target === spotPool ? options.poolFactory ?? uniswapFactory : uniswapFactory;
        case 'quoteExactOutputSingle': {
          options.calls?.push({ address: target, functionName, ...(args === undefined ? {} : { args }) });
          const quoteIn = options.quoteIn ?? 25_001_300n;
          if (quoteIn instanceof Error) throw quoteIn;
          return [quoteIn, 0n, 1, 0n];
        }
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  };
}

function spreadOf(outcome: QuotedOutcomeInput): readonly unknown[] {
  if (outcome.kind !== 'ENTRY_SPREAD') throw new Error('not an entry spread outcome');
  return [outcome.entrySpread.quoteAtoms, outcome.entrySpread.baseAtoms];
}

function ed25519Signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    verificationKey: Uint8Array.from(der.subarray(der.length - 32)),
    signDigest: (digest: Uint8Array) => Uint8Array.from(sign(null, Buffer.from(digest), privateKey)),
  };
}

function orderInput(): PackageOrderInput {
  return {
    version: 1, environment: 'testnet', domain,
    templateId: 'cash-and-carry-v1', templateVersion: 1, packageTemplateManifestHash: hash('9'),
    owner, settlementAccount: ownerAccountAddress, nonce: 3n,
    expiryUnit: 'EVM_UNIX_SECONDS', expiryValue: NOW + 600n,
    direction: 'LONG_SPOT_SHORT_PERP', action: 'ENTRY', packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'FOK', partialFillPolicy: 'EXACT_ALL_LEGS',
    quantity: assetAmount(base, QUANTITY), exitOutcomeSchemaVersion: 0,
    expectedPrePositionSize: assetAmount(base, 0n), expectedPrePositionEntryNotional: assetAmount(quote, 0n),
    maxEntrySpread: { baseAsset: base, quoteAsset: quote, quoteAtoms: 1n, baseAtoms: 10n ** 12n, roundingDirection: 'CEIL' },
    maxSpotQuoteIn: assetAmount(quote, 26_000_000n),
    maxMarginAdded: assetAmount(quote, 3_000_000n),
    minVenueReserveReturned: assetAmount(quote, 0n), minWalletQuoteBalanceDelta: assetAmount(quote, 0n),
    maxVenueFeeAtomsByAsset: [{ asset: quote, maxAtoms: 20_000n }, { asset: base, maxAtoms: 0n }],
    maxProtocolFee: assetAmount(quote, 0n), maxSolverFee: assetAmount(quote, 0n), maxPriorityFee: assetAmount(quote, 0n),
    maxRecoveryCostAtomsByAsset: [],
    permittedSpotAdapters: [spotAdapter], permittedPerpAdapters: [perpetualAdapter],
    settlementClass: 'ASYNC_BONDED_SOLVER',
    maxAggregateRecoveryLossQuote: assetAmount(quote, 0n), maxResidualBaseQuantity: assetAmount(base, 0n),
    allowedRecoveryActions: [],
  };
}

function quoteRuntime(chain: ArbitrumSepoliaReadPort = readPort()) {
  const action = (sequence: number, adapter: typeof spotAdapter) => ({
    sequence, actionClassId: 'evm-async-request-v1', legIndex: sequence, adapter,
    targetBindingId: 'coordinator', authorityBindingId: 'solver', accountMetas: [],
    payload: { codecId: 'evm-abi-v1', templateLength: 0, templateHash: payloadTemplateHash(new Uint8Array(), []), lateBoundFields: [] },
  });
  const venue = versionedManifestRef('gmx-v2', 1, hash('6'));
  return createArbitrumSepoliaQuoteRuntime({
    domain, templateId: 'cash-and-carry-v1', templateVersion: 1,
    packageTemplateManifestHash: hash('9'), templateRegistryRecordHash: hash('a'),
    candidateId: 'arbitrum-sepolia-gmx-eth', capacityBaseAtoms: 10n ** 18n,
    solverId: 'arbitrum-reference-solver', solverCapabilityManifestHash: hash('b'),
    feePolicyVersion: 1, feePolicyManifestHash: hash('c'),
    routeTtlSeconds: 120n, venueWindowSeconds: 600n, recoveryWindowSeconds: 600n,
    marginBps: 1_000, perpSlippageBps: 100, rollbackSlippageBps: 200,
    baseAsset: base, quoteAsset: quote, accountFactory, accountImplementation,
    priceFeed, priceFeedDecimals: 8, maxPriceAgeSeconds: 60n,
    gmxDataStore: dataStore, gmxReader, gmxMarket: market, spotQuoter,
    spot: { adapter: spotAdapter, venue, market: versionedManifestRef('weth-usdc-spot', 1, hash('7')), action: action(0, spotAdapter) },
    perpetual: { adapter: perpetualAdapter, venue, market: versionedManifestRef('gmx-eth-usd', 1, hash('8')), action: action(1, perpetualAdapter) },
    accountBindings: [
      { routeBindingId: 'coordinator', accountIdentity: 'eip155:421614:coordinator' },
      { routeBindingId: 'solver', accountIdentity: 'eip155:421614:solver' },
    ],
    preconditions: [], postconditions: [],
    evidenceRequirements: {
      schemaVersion: 1, profileId: 'gmx-v2-callback-v1',
      requiredPreStateComponentIds: ['coordinator-package'], requiredPostStateComponentIds: ['coordinator-package'],
      requiredActionEvidenceTypeIds: ['gmx-callback'],
      stateReferenceSchemaHash: hash('d'), receiptSchemaHash: hash('e'), outcomeSchemaHash: hash('f'),
    },
    recovery: {
      policyVersion: 1, controllerId: 'arbitrum-async-recovery-v1', controllerCodeHash: hash('1'),
      authorityModeId: 'bonded-solver-v1', reconciledStateSchemaHash: hash('2'), actionBuilderCodeHash: hash('3'),
    },
    chain,
    nonceSource: { next: () => 9n },
  });
}

test('quotes the Arbitrum spot leg at the pool cost for the exact size and the hedge at the reference', async () => {
  const order = validatePackageOrderProfile(orderInput());
  const orderHash = packageOrderHash(order);
  const calls: QuoterCall[] = [];
  const runtime = quoteRuntime(readPort({ calls }));
  const candidates = await runtime.candidates({ order, orderHash });
  const decision = planAtomicEntryRoute({ order, orderHash }, () => candidates);
  const terms = await runtime.terms({ order, decision });
  // The pool charges 25.0013 USDC for exactly 0.01 ETH; the hedge at 2500.12345678 rounds down.
  assert.equal(terms.expectedSpotNotional.atoms, 25_001_300n);
  assert.equal(terms.expectedPerpNotional.atoms, 25_001_234n);
  // The signed spread is the true one: 66 quote atoms over 10^16 base atoms, in lowest terms.
  assert.deepEqual(spreadOf(terms.quotedOutcome), [33n, 5_000_000_000_000_000n]);
  assert.deepEqual(calls.filter((call) => call.functionName === 'quoteExactOutputSingle'), [{
    address: spotQuoter.address,
    functionName: 'quoteExactOutputSingle',
    args: [{ tokenIn: address('c'), tokenOut: address('f'), amount: QUANTITY, fee: 500, sqrtPriceLimitX96: 0n }],
  }]);
  // The larger GMX position fee factor (0.05%) applies: 12500.617 rounds up.
  assert.deepEqual(
    Object.fromEntries(terms.expectedNormalizedVenueFeesByAsset.map((fee) => [fee.asset.assetId, fee.atoms])),
    { 'eip155:421614:weth': 0n, 'eip155:421614:usdc': 12_501n },
  );
  // 10% margin of 25001234 is 2500123.4, rounded up.
  assert.equal(terms.expectedMarginDelta.atoms, 2_500_124n);
  assert.equal(terms.expectedNetSpotQuantity.atoms, QUANTITY);
  assert.equal(decision.route.executionPlanKind, 'EVM_ASYNC_REQUEST');
  assert.equal(decision.route.routeExpiryValue, NOW + 120n);
  assert.equal(terms.validUntilValue, NOW + 120n);
  // Same vector as the Solidity factory test: the clone CREATE2 address and shared code hash.
  assert.equal(arbitrumSepoliaAccountOf(address('1'), address('2'), address('3')), '0x0d50ef2e4dbd10cbcc4c7dcd30844c4ccfbd7007');
  assert.equal(arbitrumSepoliaAccountCodeHash(address('2')),
    '0xe6af2b4f1b2990d958cc03616b93f13224b27afa9f6dec6780bb2ba5a295fa80');
  // A settlement account other than the owner's factory account is never quoted.
  const foreign = validatePackageOrderProfile({ ...orderInput(), settlementAccount: address('9') });
  await assert.rejects(async () => runtime.candidates({ order: foreign, orderHash: packageOrderHash(foreign) }), /factory account/);
  const signed = await signAtomicEntryQuote({ order, decision, terms, signer: ed25519Signer() });
  assert.equal(signed.quote.quoteMode, 'EXECUTION_COMMITMENT');
  // GMX GasUtils: 600000 + 3 * 10000 + (1000000 + 800000) * 1.0 gas at 0.1 gwei with a 20% buffer.
  assert.equal(gmxIncreaseExecutionFeeWei({
    baseAmount: 600_000n, perOraclePrice: 10_000n, multiplierFactor: 10n ** 30n, increaseOrderGasLimit: 1_000_000n,
  }, 800_000n, 100_000_000n, 2_000n), 291_600_000_000_000n);
});

test('quotes an Arbitrum short at GMX\'s execution price for the exact size and refuses it when impact breaks the spread cap', async () => {
  // GMX fills the short 0.2% under the reference (negative price impact on an imbalanced market).
  const executionPrice = (REFERENCE_PRICE * 998n) / 1_000n;
  const gmx = { executionPrice, priceImpactUsd: -(25_001_234n * 10n ** 24n) / 500n };
  // A 10 USDC per WETH cap admits it; the quote carries the impact.
  const order = validatePackageOrderProfile({
    ...orderInput(),
    maxEntrySpread: { baseAsset: base, quoteAsset: quote, quoteAtoms: 1n, baseAtoms: 10n ** 11n, roundingDirection: 'CEIL' },
  });
  const orderHash = packageOrderHash(order);
  const calls: QuoterCall[] = [];
  const runtime = quoteRuntime(readPort({ gmx, calls }));
  const candidates = await runtime.candidates({ order, orderHash });
  const decision = planAtomicEntryRoute({ order, orderHash }, () => candidates);
  const terms = await runtime.terms({ order, decision });
  // GMX is asked for exactly the hedge size, 0.01 ETH at the reference in whole USDC atoms.
  const reader = calls.find((call) => call.functionName === 'getExecutionPrice');
  assert.equal(reader?.address, gmxReader.address);
  assert.equal(reader?.args?.[5], 25_001_234n * 10n ** 24n);
  assert.equal(reader?.args?.[7], false);
  // Proceeds are the quantity at GMX's fill, rounded down: 24951232.09 USDC atoms.
  assert.equal(terms.expectedPerpNotional.atoms, 24_951_232n);
  // 25001300 - 24951232 = 50068 quote atoms over 10^16 base atoms: 5.0068 USDC per WETH.
  assert.deepEqual(spreadOf(terms.quotedOutcome), [12_517n, 2_500_000_000_000_000n]);
  // GMX sizes the short, its fee, and the margin at the reference size, unchanged by the impact.
  assert.equal(terms.expectedMarginDelta.atoms, 2_500_124n);
  assert.equal(terms.expectedNormalizedVenueFeesByAsset.find((fee) => fee.asset.assetId === quote.assetId)?.atoms, 12_501n);
  // The acceptable price is GMX's execution price less the 1% perp slippage, never the reference.
  const perpetual = decision.route.legs.find((leg) => leg.legRole === 'PERPETUAL')!;
  const usdScale = 10n ** 24n;
  const acceptable = (perpetual.limitPrice!.quoteAtoms * usdScale + perpetual.limitPrice!.baseAtoms - 1n) / perpetual.limitPrice!.baseAtoms;
  assert.equal(acceptable, (executionPrice * 9_900n + 9_999n) / 10_000n);
  assert.ok(acceptable < (REFERENCE_PRICE * 9_900n) / 10_000n);
  await signAtomicEntryQuote({ order, decision, terms, signer: ed25519Signer() });

  // Under a 1 USDC cap the same impact is refused before anything is signed, naming GMX's fill.
  const capped = validatePackageOrderProfile(orderInput());
  await assert.rejects(
    async () => quoteRuntime(readPort({ gmx })).candidates({ order: capped, orderHash: packageOrderHash(capped) }),
    (error: Error & { code?: string }) => error.code === 'QUOTE_DECLINED'
      && /entry spread is 5\.00 per unit \(spot cost 2500\.13, GMX short fill 2495\.12 impact included, reference 2500\.12\), above your signed maximum of 1\.00; nothing was signed\.$/.test(error.message)
      && error.message.length <= 'QUOTE_DECLINED: '.length + 240,
  );
  // A Reader that is not the pinned GMX Reader is never trusted.
  await assert.rejects(
    async () => quoteRuntime(readPort({ readerCodeHash: hex('b') })).candidates({ order, orderHash }),
    /GMX reader code hash does not match/,
  );
});

test('refuses an Arbitrum entry below GMX\'s minimum collateral as read from the data store', async () => {
  // 0.001 ETH: 2.500123 USDC short with a 10% margin of 0.250013 leaves about 0.2475 USD after both fees.
  const small = validatePackageOrderProfile({
    ...orderInput(), quantity: assetAmount(base, 10n ** 15n), maxSpotQuoteIn: assetAmount(quote, 2_600_000n),
  });
  const orderHash = packageOrderHash(small);
  await assert.rejects(
    async () => quoteRuntime(readPort({ quoteIn: 2_500_130n })).candidates({ order: small, orderHash }),
    (error: Error & { code?: string }) => error.code === 'QUOTE_DECLINED'
      && /GMX would hold 0\.24 USD of collateral for this short after fees, below its minimum of 1\.00 USD; nothing was signed\. Increase the size\.$/.test(error.message),
  );
  // The minimum is GMX's live MIN_COLLATERAL_USD, not a constant: at 0.10 USD the same entry quotes.
  const candidates = await quoteRuntime(readPort({ quoteIn: 2_500_130n, minCollateralUsd: 10n ** 29n }))
    .candidates({ order: small, orderHash });
  assert.equal(candidates.length, 1);
  // GMX V2.2 charges the short's pending impact when it closes: a 15% impact (3.7502 USD) on 0.01 ETH
  // exceeds its 2.5 USD margin, so even a spread cap that allows it cannot make the package closable.
  const wide = validatePackageOrderProfile({
    ...orderInput(),
    maxEntrySpread: { baseAsset: base, quoteAsset: quote, quoteAtoms: 1n, baseAtoms: 10n ** 9n, roundingDirection: 'CEIL' },
  });
  await assert.rejects(
    async () => quoteRuntime(readPort({
      gmx: { executionPrice: (REFERENCE_PRICE * 85n) / 100n, priceImpactUsd: -(25_001_234n * 10n ** 24n * 15n) / 100n },
    })).candidates({ order: wide, orderHash: packageOrderHash(wide) }),
    /GMX's price impact of 3\.76 USD on this short, charged when it closes, leaves -1\.27 USD of collateral after fees, below its minimum of 1\.00 USD; nothing was signed\.$/,
  );
});

test('refuses to sign an Arbitrum entry whose pool cost puts the real spread above the signed cap', async () => {
  // The pool 20% above the reference: the API's spot bound (quoter cost plus slippage) admits the
  // buy, but the trader would pay about 500 USDC per WETH over the hedge against a 1 USDC cap.
  const order = validatePackageOrderProfile({ ...orderInput(), maxSpotQuoteIn: assetAmount(quote, 30_300_000n) });
  const orderHash = packageOrderHash(order);
  const runtime = quoteRuntime(readPort({ quoteIn: 30_001_482n }));
  // 30001482 - 25001234 = 5000248 quote atoms over 10^16 base atoms: 500.0248 USDC per WETH.
  await assert.rejects(
    async () => runtime.candidates({ order, orderHash }),
    /entry spread is 500\.02 per unit \(spot cost 3000\.14, GMX short fill 2500\.12/,
  );
});

test('refuses an Arbitrum entry cleanly when the quoter reverts or is not the pinned quoter of the spot pool', async () => {
  const order = validatePackageOrderProfile(orderInput());
  const orderHash = packageOrderHash(order);
  const reverted = new ContractFunctionRevertedError({
    abi: UNISWAP_V3_QUOTER_V2_ABI, functionName: 'quoteExactOutputSingle', message: 'Unexpected error',
  });
  for (const [chain, refusal] of [
    [readPort({ quoteIn: reverted }), /spot pool cannot fill this size within its liquidity; nothing was signed/],
    [readPort({ quoterCodeHash: hex('3') }), /quoter code does not match the reviewed identity/],
    [readPort({ poolFactory: address('a') }), /quoter does not quote the spot pool factory/],
  ] as const) {
    const runtime = quoteRuntime(chain);
    await assert.rejects(async () => runtime.candidates({ order, orderHash }), refusal);
    assert.throws(() => runtime.terms({ order, decision: { orderHash } as never }), /no live Arbitrum Sepolia quote/);
  }
});

const coordinator = address('a');
const adapter = address('b');
const collateral = address('c');
const solverAccount = address('d');

function executorConfig(): ArbitrumSepoliaExecutorConfig {
  const identity = (target: Address, byte: string) => ({ address: target, expectedCodeHash: hex(byte) });
  return {
    domain, coordinator: identity(coordinator, 'a'), adapter: identity(adapter, 'b'),
    accountFactory: identity(accountFactory, '4'), accountImplementation: identity(accountImplementation, '8'),
    collateralToken: identity(collateral, 'c'),
    spotPort: identity(address('e'), 'e'), spotBaseToken: identity(address('f'), 'f'),
    gmxDataStore: dataStore, gmxReader, gmxMarket: market, quoteAssetDecimals: 6,
    priceFeed, priceFeedDecimals: 8, maxPriceAgeSeconds: 60n,
    executionClassManifestHash: hex('8'), seriesIdentityKey: hex('9'), seriesBindingVersion: 1, seriesBindingHash: hex('7'),
    bondAtoms: 5_000_000n, recoveryReserveAtoms: 5_000_000n, maxAggregateLossAtoms: 1_000_000n,
    maxIntermediateResidualAtoms: 3_000_000n, maxTerminalResidualAtoms: 1_000n, slashRecipient: address('2'),
    callbackGasLimit: 800_000n, executionFeeBufferBps: 2_000, maxExecutionFeeWei: 10n ** 15n,
    maxCollateralAtoms: 3_000_000n, maxSpotQuoteAtoms: 30_000_000n, receiptWaitMs: 10,
  };
}

const ATTEMPT_ID = `arbitrum-async-${'1'.repeat(48)}`;
const ownerAccount = privateKeyToAccount(generatePrivateKey());
const executorOwner = ownerAccount.address.toLowerCase() as Address;
const executorAccount = arbitrumSepoliaAccountOf(accountFactory, accountImplementation, executorOwner);

function attempt(): ArbitrumSepoliaExecutionAttempt {
  // 2475 USDC per ETH: 2475 quote atoms per 10^12 base atoms.
  const limit = { quoteAtoms: 2_475n, baseAtoms: 10n ** 12n };
  return {
    attemptId: ATTEMPT_ID, orderHash: hex('1'), quoteHash: hex('2'), routeHash: hex('3'),
    order: {
      domain, settlementClass: 'ASYNC_BONDED_SOLVER', action: 'ENTRY', owner: executorOwner,
      settlementAccount: executorAccount,
      quantity: { asset: base, atoms: QUANTITY }, maxSpotQuoteIn: { asset: quote, atoms: 26_000_000n },
    },
    route: {
      executionPlanKind: 'EVM_ASYNC_REQUEST', settlementAccount: executorAccount, routeExpiryValue: NOW + 120n,
      legs: [{ legRole: 'PERPETUAL', limitPrice: limit }],
      recoveryPlan: {
        maxActionExpiryValue: NOW + 720n, deadlineValue: NOW + 1_320n,
        actionSlots: [{ action: 'ROLLBACK_SPOT', limitPrice: limit }],
      },
    },
    // The quoted proceeds carry GMX's price impact; the GMX short is still sized at the reference.
    quote: { expectedPerpNotional: { atoms: 24_951_232n }, expectedMarginDelta: { atoms: 2_500_124n } },
  } as unknown as ArbitrumSepoliaExecutionAttempt;
}

function fakeChain(journal: () => SqliteArbitrumSepoliaExecutionJournal, chainId = 421_614n) {
  const config = executorConfig();
  const codes = new Map<string, Hex>([
    config.coordinator, config.adapter, config.accountFactory, config.accountImplementation, config.collateralToken,
    config.spotPort, config.spotBaseToken, config.gmxDataStore, config.gmxReader, config.priceFeed,
  ].map((identity) => [identity.address, identity.expectedCodeHash]));
  codes.set(executorAccount, arbitrumSepoliaAccountCodeHash(accountImplementation));
  const writes: string[] = [];
  const reserveArgs: Hex[] = [];
  const allowances = new Map<string, bigint>();
  const state = { fundedHash: hex('0') };
  let packageRecord: {
    terms: unknown; state: number; stateVersion: bigint; requestKey: Hex; recoveryActionSubmitted?: boolean;
    recoveryDutyActive?: boolean; bondSlashed?: boolean;
  } = {
    terms: undefined, state: 0, stateVersion: 0n, requestKey: hex('0'),
  };
  // The GMX request's adapter status, whether the account still holds the spot leg, chain time, whether
  // the RPC drops the next submitRecovery (the service missing its recovery window), whether the spot
  // is worth less than the signed rollback floor (the sale fails gas estimation), and GMX's execution
  // price for the short.
  const venue = {
    status: 1, holdsSpot: true, now: NOW, dropSubmitRecovery: false, belowRollbackFloor: false,
    executionPrice: REFERENCE_PRICE,
  };
  const recoveryDeadline = () => journal().plan(ATTEMPT_ID)!.terms.recoveryDeadline;
  const advanceState = (state: number, requestKey = packageRecord.requestKey) => {
    packageRecord = { ...packageRecord, state, stateVersion: packageRecord.stateVersion + 1n, requestKey };
  };
  const port: ArbitrumSepoliaWritePort = {
    account: solverAccount,
    chainId: async () => chainId,
    codeHash: async (target) => codes.get(target),
    latestBlockTimestamp: async () => venue.now,
    gasPrice: async () => 100_000_000n,
    readContract: async ({ functionName, args }) => {
      const terms = args?.[0] as Record<string, Hex>;
      switch (functionName) {
        case 'owner': return executorOwner;
        case 'accountOf': return executorAccount;
        case 'ownerOf': return executorOwner;
        case 'implementation': return accountImplementation;
        case 'accountCodeHash': return arbitrumSepoliaAccountCodeHash(accountImplementation);
        case 'adapter': return adapter;
        case 'spotPort': return config.spotPort.address;
        case 'spotBaseToken': return config.spotBaseToken.address;
        case 'getUint':
          if (args?.[0] === GMX_DATA_STORE_KEYS.requestExpirationTime) return 300n;
          if (args?.[0] === GMX_DATA_STORE_KEYS.estimatedGasFeeMultiplierFactor) return 10n ** 30n;
          if (args?.[0] === GMX_DATA_STORE_KEYS.increaseOrderGasLimit) return 1_000_000n;
          return 10_000n;
        case 'nextNonce': return 0n;
        case 'decimals': return 8;
        case 'latestRoundData': return [7n, ANSWER, venue.now - 10n, venue.now - 10n, 7n];
        case 'getExecutionPrice':
          return { executionPrice: venue.executionPrice, priceImpactUsd: 0n, totalImpactUsd: 0n, priceImpactDiffUsd: 0n };
        case 'packageId': return arbitrumAsyncPackageId(terms as never, coordinator);
        case 'reserveDigest': return hashTypedData(arbitrumAsyncReserveTypedData(terms as never, coordinator) as never);
        case 'bondCommitment': return terms.bondHash;
        case 'reservationCommitment': return terms.reservationHash;
        case 'recoveryPolicyCommitment': return terms.recoveryPolicyHash;
        case 'allowance': return allowances.get(String(args?.[1])) ?? 0n;
        case 'funding': return [executorAccount, state.fundedHash, 0n, 0n, 0n, 0n, false];
        case 'packageState': return packageRecord;
        case 'requestEvidence': return [venue.status, hex('0'), 0n, 0n, 1n];
        case 'activePackageOf': return venue.holdsSpot ? journal().plan(ATTEMPT_ID)!.packageId : hex('0');
        default: throw new Error(`unexpected read ${functionName}`);
      }
    },
    writeContract: async ({ functionName, args }) => {
      if (functionName === 'submitRecovery' && venue.dropSubmitRecovery) {
        venue.dropSubmitRecovery = false;
        throw new Error('RPC unavailable');
      }
      if (functionName === 'finalizeUnfilledRequest' && venue.belowRollbackFloor) throw new Error('PostconditionFailed');
      writes.push(functionName);
      if (functionName === 'approve') allowances.set(String(args?.[0]), args?.[1] as bigint);
      if (functionName === 'reserve') reserveArgs.push(args?.[1] as Hex);
      if (functionName === 'reserve') {
        packageRecord = { ...packageRecord, terms: args?.[0] };
        advanceState(1);
      }
      if (functionName === 'submitRequest') advanceState(2, hex('e'));
      if (functionName === 'markVenuePending') advanceState(3);
      if (functionName === 'finalizeUnfilledRequest') {
        assert.ok(venue.status === 3 || venue.status === 5, 'the spot is rolled back only for an unfilled request');
        venue.holdsSpot = false;
      }
      // The adapter relays a cancellation only once the spot is sold back, like assertSpotCleared.
      if (functionName === 'relayEvidence') {
        if ((venue.status === 3 || venue.status === 5) && venue.holdsSpot) throw new Error('spot not cleared');
        advanceState(venue.status === 3 ? 5 : venue.status === 5 ? 8 : 4);
      }
      // The coordinator's recovery deadline rules: a late beginRecovery parks the package in
      // MANUAL_INTERVENTION, a begun recovery of a cancelled request is a slashable duty, and the overdue
      // recovery runs only after the deadline and after a missed duty was slashed.
      if (functionName === 'beginRecovery') {
        if (venue.now >= recoveryDeadline()) {
          advanceState(9);
        } else {
          packageRecord = { ...packageRecord, recoveryDutyActive: packageRecord.state === 5 };
          advanceState(7);
        }
      }
      if (functionName === 'slashMissedRecovery') {
        assert.ok(packageRecord.state === 7 && packageRecord.recoveryDutyActive === true
          && packageRecord.recoveryActionSubmitted !== true && venue.now > recoveryDeadline());
        packageRecord = { ...packageRecord, bondSlashed: true };
        advanceState(9);
      }
      if (functionName === 'submitRecovery' || functionName === 'submitOverdueRecovery') {
        assert.ok(packageRecord.recoveryActionSubmitted !== true);
        if (functionName === 'submitRecovery') assert.ok(venue.now < recoveryDeadline());
        else {
          assert.ok(venue.now >= recoveryDeadline());
          assert.ok(packageRecord.state === 9 || (packageRecord.state === 7 && packageRecord.recoveryDutyActive !== true));
        }
        // The adapter cancels a still-pending GMX request; either way it records the request RECOVERED.
        packageRecord = { ...packageRecord, recoveryActionSubmitted: true };
        advanceState(7);
        venue.status = 5;
      }
      if (functionName === 'close') advanceState(10);
      return `0x${writes.length.toString(16).padStart(64, '0')}` as Hex;
    },
    receipt: async () => 'success',
    receiptLogs: async () => [],
  };
  // The owner's own wallet funds the request; the executor never sends that transaction.
  const ownerFunds = () => { state.fundedHash = journal().plan(ATTEMPT_ID)!.terms.requestPayloadHash; };
  return { port, writes, reserveArgs, ownerFunds, venue, slashed: () => packageRecord.bondSlashed === true };
}

function executor(port: ArbitrumSepoliaWritePort, journal: SqliteArbitrumSepoliaExecutionJournal) {
  let resolved = 0;
  const instance = new ArbitrumSepoliaExecutor({
    config: executorConfig(),
    attempts: { resolve: async () => { resolved += 1; return attempt(); } },
    chain: port,
    journal,
  });
  return { instance, resolved: () => resolved };
}

test('Arbitrum executor refuses to plan or write when eth_chainId is not 421614', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-arbitrum-executor-'));
  const journal = new SqliteArbitrumSepoliaExecutionJournal(join(directory, 'journal.db'));
  try {
    const { port, writes } = fakeChain(() => journal, 42_161n);
    const { instance, resolved } = executor(port, journal);
    await assert.rejects(instance.advance(ATTEMPT_ID), (error: Error & { code?: string }) => error.code === 'WRONG_CHAIN');
    assert.deepEqual(writes, []);
    assert.equal(resolved(), 0);
    assert.equal(journal.plan(ATTEMPT_ID), undefined);
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Arbitrum executor sizes the GMX short at the reference and refuses before signing a short GMX would fill under the acceptable price', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-arbitrum-executor-'));
  const journal = new SqliteArbitrumSepoliaExecutionJournal(join(directory, 'journal.db'));
  try {
    const { port, writes, venue } = fakeChain(() => journal);
    // The signed acceptable price is 2475 USD per ETH; GMX would now fill at 2474.99.
    venue.executionPrice = 2_474_990_000_000_000n;
    await assert.rejects(
      executor(port, journal).instance.prepare(ATTEMPT_ID),
      (error: Error & { code?: string }) => error.code === 'PRICE_MOVED'
        && /^GMX would now fill this short at 2474\.99, under the signed acceptable price of 2475\.00; nothing was signed\./.test(error.message),
    );
    assert.equal(journal.plan(ATTEMPT_ID), undefined);
    assert.deepEqual(writes, []);
    venue.executionPrice = 2_475_000_000_000_000n;
    await executor(port, journal).instance.prepare(ATTEMPT_ID);
    const request = journal.plan(ATTEMPT_ID)!.request;
    // Quantity tokens at the reference (25.001234 USDC), not the impact-reduced quoted proceeds.
    assert.equal(request.sizeDelta, -25_001_234n * 10n ** 24n);
    assert.equal(request.acceptablePrice, 2_475_000_000_000_000n);
    assert.equal(request.collateralAtoms, 2_500_124n);
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Arbitrum executor joins concurrent advances of one attempt instead of queueing each poll', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-arbitrum-executor-'));
  const journal = new SqliteArbitrumSepoliaExecutionJournal(join(directory, 'journal.db'));
  try {
    const { port, writes } = fakeChain(() => journal);
    const { instance } = executor(port, journal);
    const polls = await Promise.all([instance.advance(ATTEMPT_ID), instance.advance(ATTEMPT_ID), instance.advance(ATTEMPT_ID)]);
    assert.deepEqual(polls.map((poll) => poll.status), Array(3).fill('AWAITING_OWNER_SIGNATURE'));
    // The joined polls share the one advance's result object.
    assert.equal(polls[1], polls[0]);
    assert.equal(polls[2], polls[0]);
    assert.deepEqual(writes, []);
    // Once settled, the next poll runs afresh.
    const later = await instance.advance(ATTEMPT_ID);
    assert.notEqual(later, polls[0]);
    assert.equal(later.status, 'AWAITING_OWNER_SIGNATURE');
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Arbitrum executor reserves only with the owner wallet signature and owner funding, once, across restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-arbitrum-executor-'));
  const path = join(directory, 'journal.db');
  let journal = new SqliteArbitrumSepoliaExecutionJournal(path);
  try {
    const { port, writes, reserveArgs, ownerFunds } = fakeChain(() => journal);
    const unsigned = await executor(port, journal).instance.advance(ATTEMPT_ID);
    assert.equal(unsigned.status, 'AWAITING_OWNER_SIGNATURE');
    assert.deepEqual(writes, []);

    const prepared = await executor(port, journal).instance.prepare(ATTEMPT_ID);
    assert.equal(prepared.owner, executorOwner);
    assert.equal(prepared.account, executorAccount);
    assert.equal(prepared.signed, false);
    assert.equal(prepared.funding.spender, adapter);
    assert.equal(prepared.funding.fundRequest.to, adapter);
    assert.equal(journal.plan(ATTEMPT_ID)?.request.spot.fundingOwner, executorOwner);
    assert.equal(prepared.digest, hashTypedData(prepared.typedData as never));

    const stranger = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(
      executor(port, journal).instance.authorize(ATTEMPT_ID, await stranger.signTypedData(prepared.typedData as never)),
      (error: Error & { code?: string }) => error.code === 'INVALID_SIGNATURE',
    );
    const signature = await ownerAccount.signTypedData(prepared.typedData as never);
    assert.equal((await executor(port, journal).instance.authorize(ATTEMPT_ID, signature)).signed, true);

    const unfunded = await executor(port, journal).instance.advance(ATTEMPT_ID);
    assert.equal(unfunded.status, 'AWAITING_OWNER_FUNDING');
    assert.deepEqual(writes, []);

    ownerFunds();
    const first = await executor(port, journal).instance.advance(ATTEMPT_ID);
    assert.equal(first.status, 'VENUE_PENDING');
    assert.equal(first.coordinatorState, 'VENUE_PENDING');
    assert.deepEqual(writes, ['approve', 'reserve', 'submitRequest', 'markVenuePending']);
    assert.deepEqual(reserveArgs, [signature]);
    assert.deepEqual(first.transactions.map((entry) => entry.step),
      ['APPROVE_COORDINATOR', 'RESERVE', 'SUBMIT', 'MARK_PENDING']);
    // The bond and recovery reserve are approved exactly, in collateral atoms.
    assert.equal(journal.plan(ATTEMPT_ID)?.terms.bondAtoms, 5_000_000n);

    journal.close();
    journal = new SqliteArbitrumSepoliaExecutionJournal(path);
    const { instance, resolved } = executor(port, journal);
    const restarted = await instance.advance(ATTEMPT_ID);
    assert.equal(writes.length, 4);
    assert.equal(resolved(), 0);
    assert.equal(restarted.packageId, first.packageId);
    assert.equal(restarted.status, 'VENUE_PENDING');
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Arbitrum executor recovers a GMX-cancelled or overdue entry through the bonded coordinator path, once', async () => {
  for (const scenario of ['cancelled', 'overdue'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'naryx-arbitrum-executor-'));
    const journal = new SqliteArbitrumSepoliaExecutionJournal(join(directory, 'journal.db'));
    try {
      const { port, writes, ownerFunds, venue } = fakeChain(() => journal);
      const prepared = await executor(port, journal).instance.prepare(ATTEMPT_ID);
      await executor(port, journal).instance.authorize(ATTEMPT_ID, await ownerAccount.signTypedData(prepared.typedData as never));
      ownerFunds();
      assert.equal((await executor(port, journal).instance.advance(ATTEMPT_ID)).status, 'VENUE_PENDING');
      const before = writes.length;
      const sent = () => writes.slice(before);
      if (scenario === 'cancelled') {
        venue.status = 3;
      } else {
        // Still pending on GMX: nothing happens until the venue deadline passes.
        assert.equal((await executor(port, journal).instance.advance(ATTEMPT_ID)).status, 'VENUE_PENDING');
        assert.deepEqual(sent(), []);
        venue.now = journal.plan(ATTEMPT_ID)!.terms.venueDeadline + 1n;
      }
      const recovered = await executor(port, journal).instance.advance(ATTEMPT_ID);
      assert.equal(recovered.status, 'SETTLED');
      assert.equal(recovered.coordinatorState, 'CLOSED');
      assert.deepEqual(sent(), scenario === 'cancelled'
        ? ['finalizeUnfilledRequest', 'relayEvidence', 'beginRecovery', 'submitRecovery', 'relayEvidence', 'close']
        : ['beginRecovery', 'submitRecovery', 'finalizeUnfilledRequest', 'relayEvidence', 'close']);
      assert.equal(venue.holdsSpot, false);
      const again = await executor(port, journal).instance.advance(ATTEMPT_ID);
      assert.equal(again.status, 'SETTLED');
      assert.equal(sent().length, scenario === 'cancelled' ? 6 : 5);
    } finally {
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('Arbitrum executor closes a below-floor cancelled entry once the owner takes the spot in kind, never forcing the sale', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-arbitrum-executor-'));
  const journal = new SqliteArbitrumSepoliaExecutionJournal(join(directory, 'journal.db'));
  try {
    const { port, writes, ownerFunds, venue, slashed } = fakeChain(() => journal);
    const prepared = await executor(port, journal).instance.prepare(ATTEMPT_ID);
    await executor(port, journal).instance.authorize(ATTEMPT_ID, await ownerAccount.signTypedData(prepared.typedData as never));
    ownerFunds();
    assert.equal((await executor(port, journal).instance.advance(ATTEMPT_ID)).status, 'VENUE_PENDING');
    const before = writes.length;
    const sent = () => writes.slice(before);
    venue.status = 3;
    venue.belowRollbackFloor = true;
    await assert.rejects(executor(port, journal).instance.advance(ATTEMPT_ID), /PostconditionFailed/);
    assert.deepEqual(sent(), []);

    // Past the recovery deadline the owner's wallet takes the spot leg in kind through the adapter.
    venue.now = journal.plan(ATTEMPT_ID)!.terms.recoveryDeadline;
    venue.holdsSpot = false;
    const closed = await executor(port, journal).instance.advance(ATTEMPT_ID);
    assert.equal(closed.status, 'SETTLED');
    assert.equal(closed.coordinatorState, 'CLOSED');
    assert.deepEqual(sent(), ['relayEvidence', 'beginRecovery', 'submitOverdueRecovery', 'relayEvidence', 'close']);
    assert.equal(slashed(), false);
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Arbitrum executor recovers an entry GMX still holds after the recovery deadline, slashing a missed duty first', async () => {
  for (const scenario of ['expired', 'missed duty'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'naryx-arbitrum-executor-'));
    const journal = new SqliteArbitrumSepoliaExecutionJournal(join(directory, 'journal.db'));
    try {
      const { port, writes, ownerFunds, venue, slashed } = fakeChain(() => journal);
      const prepared = await executor(port, journal).instance.prepare(ATTEMPT_ID);
      await executor(port, journal).instance.authorize(ATTEMPT_ID, await ownerAccount.signTypedData(prepared.typedData as never));
      ownerFunds();
      assert.equal((await executor(port, journal).instance.advance(ATTEMPT_ID)).status, 'VENUE_PENDING');
      const before = writes.length;
      const sent = () => writes.slice(before);
      if (scenario === 'expired') {
        // The service polled nothing between the venue window and the recovery deadline.
        venue.now = journal.plan(ATTEMPT_ID)!.terms.recoveryDeadline;
      } else {
        // GMX cancels, the service rolls back and begins recovery, then misses the recovery window.
        venue.status = 3;
        venue.dropSubmitRecovery = true;
        await assert.rejects(executor(port, journal).instance.advance(ATTEMPT_ID), /RPC unavailable/);
        venue.now = journal.plan(ATTEMPT_ID)!.terms.recoveryDeadline + 1n;
      }
      const recovered = await executor(port, journal).instance.advance(ATTEMPT_ID);
      assert.equal(recovered.status, 'SETTLED');
      assert.equal(recovered.coordinatorState, 'CLOSED');
      assert.deepEqual(sent(), scenario === 'expired'
        ? ['beginRecovery', 'submitOverdueRecovery', 'finalizeUnfilledRequest', 'relayEvidence', 'close']
        : ['finalizeUnfilledRequest', 'relayEvidence', 'beginRecovery', 'slashMissedRecovery', 'submitOverdueRecovery',
          'relayEvidence', 'close']);
      assert.equal(slashed(), scenario === 'missed duty');
      assert.equal(venue.holdsSpot, false);
      const again = await executor(port, journal).instance.advance(ATTEMPT_ID);
      assert.equal(again.status, 'SETTLED');
      assert.equal(sent().length, scenario === 'expired' ? 5 : 7);
    } finally {
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
