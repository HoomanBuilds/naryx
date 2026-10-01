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
} from '@naryx/protocol-types';
import { hashTypedData, type Address, type Hex } from 'viem';
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

function readPort(chainId = 421_614n): ArbitrumSepoliaReadPort {
  return {
    chainId: async () => chainId,
    codeHash: async (target) => target === priceFeed.address ? priceFeed.expectedCodeHash
      : target === dataStore.address ? dataStore.expectedCodeHash : undefined,
    latestBlockTimestamp: async () => NOW,
    gasPrice: async () => 100_000_000n,
    readContract: async ({ functionName, args }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return [7n, ANSWER, NOW - 10n, NOW - 10n, 7n];
      if (functionName === 'getUint') {
        const key = args?.[0];
        if (key === gmxPositionFeeFactorKey(market, true)) return 3n * 10n ** 26n;
        if (key === gmxPositionFeeFactorKey(market, false)) return 5n * 10n ** 26n;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
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

function quoteRuntime() {
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
    gmxDataStore: dataStore, gmxMarket: market,
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
    chain: readPort(),
    nonceSource: { next: () => 9n },
  });
}

test('quotes Arbitrum entry from the live reference price and GMX fee factor, rounding against the trader', async () => {
  const order = validatePackageOrderProfile(orderInput());
  const orderHash = packageOrderHash(order);
  const runtime = quoteRuntime();
  const candidates = await runtime.candidates({ order, orderHash });
  const decision = planAtomicEntryRoute({ order, orderHash }, () => candidates);
  const terms = await runtime.terms({ order, decision });
  // 0.01 ETH at 2500.12345678 is 25.0012345678 USDC: spot cost rounds up, perpetual proceeds down.
  assert.equal(terms.expectedSpotNotional.atoms, 25_001_235n);
  assert.equal(terms.expectedPerpNotional.atoms, 25_001_234n);
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
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const signed = await signAtomicEntryQuote({
    order, decision, terms,
    signer: {
      verificationKey: Uint8Array.from(der.subarray(der.length - 32)),
      signDigest: (digest) => Uint8Array.from(sign(null, Buffer.from(digest), privateKey)),
    },
  });
  assert.equal(signed.quote.quoteMode, 'EXECUTION_COMMITMENT');
  // GMX GasUtils: 600000 + 3 * 10000 + (1000000 + 800000) * 1.0 gas at 0.1 gwei with a 20% buffer.
  assert.equal(gmxIncreaseExecutionFeeWei({
    baseAmount: 600_000n, perOraclePrice: 10_000n, multiplierFactor: 10n ** 30n, increaseOrderGasLimit: 1_000_000n,
  }, 800_000n, 100_000_000n, 2_000n), 291_600_000_000_000n);
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
    gmxDataStore: dataStore, gmxMarket: market, quoteAssetDecimals: 6,
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
  const limit = { quoteAtoms: 2_475n, baseAtoms: 10n ** 15n };
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
    quote: { expectedPerpNotional: { atoms: 25_001_234n }, expectedMarginDelta: { atoms: 2_500_124n } },
  } as unknown as ArbitrumSepoliaExecutionAttempt;
}

function fakeChain(journal: () => SqliteArbitrumSepoliaExecutionJournal, chainId = 421_614n) {
  const config = executorConfig();
  const codes = new Map<string, Hex>([
    config.coordinator, config.adapter, config.accountFactory, config.accountImplementation, config.collateralToken,
    config.spotPort, config.spotBaseToken, config.gmxDataStore,
  ].map((identity) => [identity.address, identity.expectedCodeHash]));
  codes.set(executorAccount, arbitrumSepoliaAccountCodeHash(accountImplementation));
  const writes: string[] = [];
  const reserveArgs: Hex[] = [];
  const allowances = new Map<string, bigint>();
  const state = { fundedHash: hex('0') };
  let packageRecord: { terms: unknown; state: number; stateVersion: bigint; requestKey: Hex } = {
    terms: undefined, state: 0, stateVersion: 0n, requestKey: hex('0'),
  };
  const advanceState = (state: number, requestKey = packageRecord.requestKey) => {
    packageRecord = { ...packageRecord, state, stateVersion: packageRecord.stateVersion + 1n, requestKey };
  };
  const port: ArbitrumSepoliaWritePort = {
    account: solverAccount,
    chainId: async () => chainId,
    codeHash: async (target) => codes.get(target),
    latestBlockTimestamp: async () => NOW,
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
        case 'packageId': return arbitrumAsyncPackageId(terms as never, coordinator);
        case 'reserveDigest': return hashTypedData(arbitrumAsyncReserveTypedData(terms as never, coordinator) as never);
        case 'bondCommitment': return terms.bondHash;
        case 'reservationCommitment': return terms.reservationHash;
        case 'recoveryPolicyCommitment': return terms.recoveryPolicyHash;
        case 'allowance': return allowances.get(String(args?.[1])) ?? 0n;
        case 'funding': return [executorAccount, state.fundedHash, 0n, 0n, 0n, 0n, false];
        case 'packageState': return packageRecord;
        case 'requestEvidence': return [1, hex('0'), 0n, 0n, 1n];
        default: throw new Error(`unexpected read ${functionName}`);
      }
    },
    writeContract: async ({ functionName, args }) => {
      writes.push(functionName);
      if (functionName === 'approve') allowances.set(String(args?.[0]), args?.[1] as bigint);
      if (functionName === 'reserve') reserveArgs.push(args?.[1] as Hex);
      if (functionName === 'reserve') {
        packageRecord = { ...packageRecord, terms: args?.[0] };
        advanceState(1);
      }
      if (functionName === 'submitRequest') advanceState(2, hex('e'));
      if (functionName === 'markVenuePending') advanceState(3);
      return `0x${writes.length.toString(16).padStart(64, '0')}` as Hex;
    },
    receipt: async () => 'success',
  };
  // The owner's own wallet funds the request; the executor never sends that transaction.
  const ownerFunds = () => { state.fundedHash = journal().plan(ATTEMPT_ID)!.terms.requestPayloadHash; };
  return { port, writes, reserveArgs, ownerFunds };
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
