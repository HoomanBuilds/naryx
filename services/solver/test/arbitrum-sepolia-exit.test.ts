import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { domainRef } from '@naryx/protocol-types';
import { encodeAbiParameters, encodeEventTopics, hashTypedData, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  ARBITRUM_EXIT_CONTROLLER_ABI,
  ArbitrumSepoliaExecutor,
  GMX_DATA_STORE_KEYS,
  SqliteArbitrumSepoliaExecutionJournal,
  arbitrumExitTypedData,
  arbitrumSepoliaAccountCodeHash,
  arbitrumSepoliaAccountOf,
  gmxPositionFieldKey,
  priceArbitrumExit,
  type ArbitrumExitAuthorization,
  type ArbitrumSepoliaExecutionAttempt,
  type ArbitrumSepoliaExecutorConfig,
  type ArbitrumSepoliaWritePort,
} from '../src/index.js';

const hex = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const domain = domainRef('eip155:421614', 1, '1'.repeat(64));
const NOW = 1_000_000n;
const QUANTITY = 10n ** 16n;
const SIZE_USD = 25_001_234n * 10n ** 24n;
const COLLATERAL = 2_500_124n;
const ATTEMPT_ID = `arbitrum-async-${'2'.repeat(48)}`;
const PACKAGE_ID = hex('5');
const ENTRY_KEY = hex('6');
const EXIT_KEY = hex('e');
const factory = address('4');
const implementation = address('8');
const adapter = address('b');
const collateral = address('c');
const exitController = address('9');
const market = address('7');
const dataStore = address('6');
const spotPort = address('e');
const solver = address('d');
const ownerWallet = privateKeyToAccount(generatePrivateKey());
const owner = ownerWallet.address.toLowerCase() as Address;
const account = arbitrumSepoliaAccountOf(factory, implementation, owner);

function config(): ArbitrumSepoliaExecutorConfig {
  const identity = (target: Address, byte: string) => ({ address: target, expectedCodeHash: hex(byte) });
  return {
    domain, coordinator: identity(address('a'), 'a'), adapter: identity(adapter, 'b'),
    accountFactory: identity(factory, '4'), accountImplementation: identity(implementation, '8'),
    collateralToken: identity(collateral, 'c'), spotPort: identity(spotPort, 'e'), spotBaseToken: identity(address('f'), 'f'),
    gmxDataStore: identity(dataStore, '6'), gmxMarket: market, quoteAssetDecimals: 6,
    executionClassManifestHash: hex('8'), seriesIdentityKey: hex('9'), seriesBindingVersion: 1, seriesBindingHash: hex('7'),
    bondAtoms: 5_000_000n, recoveryReserveAtoms: 5_000_000n, maxAggregateLossAtoms: 1_000_000n,
    maxIntermediateResidualAtoms: 3_000_000n, maxTerminalResidualAtoms: 1_000n, slashRecipient: address('2'),
    callbackGasLimit: 800_000n, executionFeeBufferBps: 2_000, maxExecutionFeeWei: 10n ** 15n,
    maxCollateralAtoms: 3_000_000n, maxSpotQuoteAtoms: 30_000_000n, receiptWaitMs: 10,
    exitController: identity(exitController, '9'), exitCallbackGasLimit: 2_000_000n,
  };
}

function exitAttempt(): ArbitrumSepoliaExecutionAttempt {
  return {
    attemptId: ATTEMPT_ID, orderHash: hex('1'), quoteHash: hex('2'), routeHash: hex('3'),
    order: {
      domain, settlementClass: 'ASYNC_BONDED_SOLVER', action: 'EXIT', owner, settlementAccount: account,
      quantity: { atoms: QUANTITY }, entryReceiptHash: Uint8Array.from(Buffer.from(PACKAGE_ID.slice(2), 'hex')),
      expectedPrePositionSize: { atoms: -QUANTITY }, expectedPrePositionEntryNotional: { atoms: 25_001_234n },
      minSpotQuoteOut: { atoms: 24_000_000n }, minExitQuoteOutcome: { atoms: 26_000_000n },
    },
    route: {
      executionPlanKind: 'EVM_ASYNC_REQUEST', settlementAccount: account, routeExpiryValue: NOW + 120n,
      legs: [{ legRole: 'PERPETUAL', side: 'BUY', reduceOnly: true, limitPrice: { quoteAtoms: 2_550_000_000n, baseAtoms: 10n ** 18n } }],
      recoveryPlan: { maxActionExpiryValue: NOW + 720n, deadlineValue: NOW + 1_320n, actionSlots: [] },
    },
    quote: {},
  } as unknown as ArbitrumSepoliaExecutionAttempt;
}

function fakeChain() {
  const settings = config();
  const codes = new Map<string, Hex>([
    settings.adapter, settings.accountFactory, settings.accountImplementation, settings.collateralToken,
    settings.spotPort, settings.gmxDataStore, settings.exitController!,
  ].map((identity) => [identity.address, identity.expectedCodeHash]));
  codes.set(account, arbitrumSepoliaAccountCodeHash(implementation));
  const state = {
    now: NOW, nonce: 0n, activeExit: hex('0'), status: 0, reconciling: false, released: false,
    writes: [] as { functionName: string; value?: bigint }[], submitHash: undefined as Hex | undefined, digest: hex('0'),
  };
  const registration = {
    packageId: PACKAGE_ID, requestPayloadHash: hex('a'), fundingOwner: owner, port: spotPort, portCodeHash: hex('e'),
    baseToken: address('f'), quoteToken: collateral, packageNonce: 4n, orderHash: hex('b'), quoteHash: hex('c'),
    routeHash: hex('d'), entryFillCommitment: hex('7'), rollbackFillCommitment: hex('8'), baseAtoms: QUANTITY,
    maxQuoteAtoms: 26_000_000n, rollbackMinQuoteAtoms: 24_000_000n,
  };
  const uints = new Map<string, bigint>([
    [GMX_DATA_STORE_KEYS.requestExpirationTime, 300n],
    [GMX_DATA_STORE_KEYS.estimatedGasFeeMultiplierFactor, 10n ** 30n],
    [GMX_DATA_STORE_KEYS.increaseOrderGasLimit, 1_000_000n],
    [GMX_DATA_STORE_KEYS.decreaseOrderGasLimit, 1_500_000n],
    [gmxPositionFieldKey(account, market, collateral, false, 'SIZE_IN_TOKENS'), QUANTITY],
    [gmxPositionFieldKey(account, market, collateral, false, 'COLLATERAL_AMOUNT'), COLLATERAL],
  ]);
  const port: ArbitrumSepoliaWritePort = {
    account: solver,
    chainId: async () => 421_614n,
    codeHash: async (target) => codes.get(target),
    latestBlockTimestamp: async () => state.now,
    gasPrice: async () => 100_000_000n,
    readContract: async ({ functionName, args }) => {
      switch (functionName) {
        case 'owner': case 'ownerOf': return owner;
        case 'accountCodeHash': return arbitrumSepoliaAccountCodeHash(implementation);
        case 'adapter': return adapter;
        case 'exitController': return exitController;
        case 'activePackageOf': return PACKAGE_ID;
        case 'activeRequestKeyOf': case 'activeSpotRequestKey': return ENTRY_KEY;
        case 'requestEvidence': return [2, hex('3'), 0n, SIZE_USD, 2n];
        case 'positionSize': return args?.[0] === false && !state.released ? SIZE_USD : 0n;
        case 'hasActiveSpotInventory': return true;
        case 'activeSpotRegistration': return registration;
        case 'activeExitRequestKey': return state.activeExit;
        case 'nextNonce': return state.nonce;
        case 'getUint': return uints.get(String(args?.[0])) ?? 10_000n;
        case 'exitDigest':
          return hashTypedData(arbitrumExitTypedData(args?.[0] as ArbitrumExitAuthorization, exitController) as never);
        case 'exitEvidence': return [state.status, state.status === 0 ? hex('0') : hex('4'), 1n, state.reconciling, state.released];
        case 'finalPackageReceipt': return { commitment: hex('f'), exitRequestKey: EXIT_KEY, recipient: owner };
        default: throw new Error(`unexpected read ${functionName}`);
      }
    },
    writeContract: async ({ functionName, value }) => {
      state.writes.push({ functionName, ...(value === undefined ? {} : { value }) });
      const txHash = `0x${state.writes.length.toString(16).padStart(64, '0')}` as Hex;
      if (functionName === 'submitFullClose') {
        state.submitHash = txHash;
        state.nonce += 1n;
        state.activeExit = EXIT_KEY;
        state.status = 1;
      }
      return txHash;
    },
    receipt: async () => 'success',
    receiptLogs: async (hash) => hash !== state.submitHash ? [] : [{
      address: exitController,
      topics: encodeEventTopics({
        abi: ARBITRUM_EXIT_CONTROLLER_ABI, eventName: 'ExitSubmitted', args: { packageId: PACKAGE_ID, requestKey: EXIT_KEY },
      }) as Hex[],
      data: encodeAbiParameters([{ type: 'bytes32' }], [state.digest]),
    }],
  };
  return { port, state };
}

function executor(port: ArbitrumSepoliaWritePort, journal: SqliteArbitrumSepoliaExecutionJournal) {
  let resolved = 0;
  const instance = new ArbitrumSepoliaExecutor({
    config: config(),
    attempts: { resolve: async () => { resolved += 1; return exitAttempt(); } },
    chain: port,
    journal,
  });
  return { instance, resolved: () => resolved };
}

async function signedExit(port: ArbitrumSepoliaWritePort, journal: SqliteArbitrumSepoliaExecutionJournal, state: { digest: Hex }) {
  const prepared = await executor(port, journal).instance.prepareExit(ATTEMPT_ID);
  state.digest = prepared.digest;
  await executor(port, journal).instance.authorizeExit(ATTEMPT_ID, await ownerWallet.signTypedData(prepared.typedData as never));
  return prepared;
}

test('Arbitrum exit submits the owner-signed full close once, pays the GMX fee, and finalizes to the receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-arbitrum-exit-'));
  const path = join(directory, 'journal.db');
  let journal = new SqliteArbitrumSepoliaExecutionJournal(path);
  try {
    const { port, state } = fakeChain();
    const unsigned = await executor(port, journal).instance.advance(ATTEMPT_ID);
    assert.equal(unsigned.status, 'AWAITING_OWNER_SIGNATURE');
    assert.equal(state.writes.length, 0);

    const prepared = await executor(port, journal).instance.prepareExit(ATTEMPT_ID);
    const message = prepared.typedData.message;
    assert.equal(prepared.signed, false);
    assert.equal(prepared.exitController, exitController);
    assert.equal(prepared.digest, hashTypedData(prepared.typedData as never));
    assert.deepEqual([message.owner, message.receiver, message.spotProceedsRecipient, message.feePayer], [owner, owner, owner, solver]);
    assert.equal(message.fullCloseSizeUsd, SIZE_USD.toString());
    // The decrease floor is the signed exit outcome less the signed spot floor, at par in 30-decimal USD.
    assert.equal(message.minOutputAmount, (2_000_000n * 10n ** 24n).toString());
    // 2550 USDC per ETH as a 30-decimal USD price per wei, rounded down for a short close.
    assert.equal(message.acceptablePrice, '2550000000000000');
    // GMX GasUtils for a decrease: (10000 + 3 * 10000 + 1500000 + 2000000) gas at 0.1 gwei plus 20%.
    assert.equal(message.executionFeeWei, '424800000000000');
    assert.deepEqual([message.authorizationExpiry, message.cancelAfter, message.nonce], [(NOW + 120n).toString(), (NOW + 720n).toString(), '0']);

    const stranger = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(
      executor(port, journal).instance.authorizeExit(ATTEMPT_ID, await stranger.signTypedData(prepared.typedData as never)),
      (error: Error & { code?: string }) => error.code === 'INVALID_SIGNATURE',
    );
    await signedExit(port, journal, state);

    const submitted = await executor(port, journal).instance.advance(ATTEMPT_ID);
    assert.equal(submitted.status, 'VENUE_PENDING');
    assert.equal(submitted.requestKey, EXIT_KEY);
    assert.deepEqual(state.writes, [{ functionName: 'submitFullClose', value: 424_800_000_000_000n }]);
    assert.equal((await executor(port, journal).instance.advance(ATTEMPT_ID)).status, 'VENUE_PENDING');

    // GMX executed the close but the callback could not sell the spot leg: finalize once.
    state.status = 2;
    journal.close();
    journal = new SqliteArbitrumSepoliaExecutionJournal(path);
    const { instance, resolved } = executor(port, journal);
    const unreleased = await instance.advance(ATTEMPT_ID);
    assert.equal(resolved(), 0);
    assert.equal(unreleased.status, 'RECOVERY_REQUIRED');
    assert.deepEqual(state.writes.map((write) => write.functionName), ['submitFullClose', 'finalizeExecutedExit']);
    assert.equal((await instance.advance(ATTEMPT_ID)).status, 'RECOVERY_REQUIRED');
    assert.equal(state.writes.length, 2);

    state.released = true;
    const settled = await instance.advance(ATTEMPT_ID);
    assert.equal(settled.status, 'SETTLED');
    assert.equal(settled.coordinatorState, 'EXIT_EXECUTED');
    assert.equal(journal.exitFinalReceipt(ATTEMPT_ID), hex('f'));
    assert.deepEqual(settled.transactions.map((entry) => entry.step), ['SUBMIT_EXIT', 'FINALIZE_EXIT']);
    assert.equal(state.writes.length, 2);
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Arbitrum exit cancels a close still pending after cancelAfter once and refuses an expired authorization', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-arbitrum-exit-'));
  const journal = new SqliteArbitrumSepoliaExecutionJournal(join(directory, 'journal.db'));
  try {
    const { port, state } = fakeChain();
    await signedExit(port, journal, state);
    assert.equal((await executor(port, journal).instance.advance(ATTEMPT_ID)).status, 'VENUE_PENDING');

    state.now = NOW + 720n;
    const send = port.writeContract;
    port.writeContract = async (request) => {
      const txHash = await send(request);
      if (request.functionName === 'requestCancellationOrReconciliation') {
        state.status = 5;
        state.reconciling = true;
        state.activeExit = hex('0');
      }
      return txHash;
    };
    const cancelled = await executor(port, journal).instance.advance(ATTEMPT_ID);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.coordinatorState, 'EXIT_RECOVERED');
    assert.deepEqual(state.writes.map((write) => write.functionName), ['submitFullClose', 'requestCancellationOrReconciliation']);
    assert.equal((await executor(port, journal).instance.advance(ATTEMPT_ID)).status, 'CANCELLED');
    assert.equal(state.writes.length, 2);
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }

  const expiredDirectory = mkdtempSync(join(tmpdir(), 'naryx-arbitrum-exit-'));
  const expiredJournal = new SqliteArbitrumSepoliaExecutionJournal(join(expiredDirectory, 'journal.db'));
  try {
    const { port, state } = fakeChain();
    await signedExit(port, expiredJournal, state);
    state.now = NOW + 120n;
    const expired = await executor(port, expiredJournal).instance.advance(ATTEMPT_ID);
    assert.equal(expired.status, 'FAILED');
    assert.match(expiredJournal.exitFailed(ATTEMPT_ID) ?? '', /expired before submission/);
    assert.equal(state.writes.length, 0);
  } finally {
    expiredJournal.close();
    rmSync(expiredDirectory, { recursive: true, force: true });
  }
});

test('Arbitrum exit quote prices the close at the lower of pool, reference, and quoter, rounding against the trader', () => {
  // ETH at 2500.12345678 USD; the pool mid (10000 USD) is above it, so the reference prices the spot sale.
  const input = {
    quantityAtoms: QUANTITY, baseDecimals: 18, quoteDecimals: 6,
    reference: { answer: 250_012_345_678n, decimals: 8 },
    pool: { sqrtPriceX96: 2n ** 96n / 10_000n, baseIsToken0: true, poolFee: 3_000n },
    spotQuoteOutAtoms: 24_926_231n,
    positionFeeFactor: 5n * 10n ** 26n,
    position: { sizeInUsd: SIZE_USD, sizeInTokens: QUANTITY, collateralAtoms: COLLATERAL },
  };
  const pricing = priceArbitrumExit(input);
  // Spot proceeds less the 0.3% pool fee round down; the buy-back and the 0.05% GMX fee round up.
  assert.deepEqual(
    [pricing.expectedSpotNotionalAtoms, pricing.closeNotionalAtoms, pricing.positionFeeAtoms, pricing.expectedPerpOutputAtoms],
    [24_926_230n, 25_001_235n, 12_501n, 2_487_622n],
  );
  assert.equal(pricing.exitOutcomeAtoms, 27_413_852n);
  // A thin pool's price impact: the quoted proceeds never exceed what the quoter says the sale returns.
  const thin = priceArbitrumExit({ ...input, spotQuoteOutAtoms: 24_000_000n });
  assert.deepEqual([thin.expectedSpotNotionalAtoms, thin.exitOutcomeAtoms], [24_000_000n, 26_487_622n]);
  assert.throws(() => priceArbitrumExit({
    ...input, position: { sizeInUsd: SIZE_USD, sizeInTokens: QUANTITY * 2n, collateralAtoms: COLLATERAL },
  }), /not positive/);
});
