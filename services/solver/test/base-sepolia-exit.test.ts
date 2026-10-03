import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  assetRef,
  domainManifest,
  domainRefFromManifest,
  packageOrderHash,
  versionedManifestRef,
  type PackageOrderInput,
} from '@naryx/protocol-types';
import type { Address, Hex } from 'viem';
import { baseSepoliaExitQuoteMath, createBaseSepoliaExitQuotePort } from '../src/base-sepolia-exit-quote.js';
import type { BaseSepoliaQuoteRuntimeInput, BaseSepoliaSolverDeployment } from '../src/base-sepolia-quote-runtime.js';
import { InMemoryInternalAtomicQuoteStore } from '../src/internal-atomic-quote-server.js';
import { quoteUniswapV3Sell } from '../src/uniswap-v3-quoter.js';

const Q96 = 1n << 96n;
const SCALE = 1_000_000_000_000n;
const hash = (byte: string) => byte.repeat(64);
const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const position = { balanceWad: 300_000n * SCALE, sizeWad: -1_001n, entryNotionalWad: 2_100_000n * SCALE + 5n, entryFundingIndex: 0n };
const mathInput = {
  quantityAtoms: 1_001n,
  // Base is token0 at exactly one quote atom per base atom; the pool fee is 0.3%.
  sqrtPriceX96: Q96,
  baseIsToken0: true,
  poolFee: 3_000n,
  spotQuoteOutAtoms: 998n,
  position,
  previewCloseNotionalWad: 2_000_000n * SCALE + 123n,
  previewCloseFeeWad: SCALE,
  currentFundingIndex: 0n,
  collateralScale: SCALE,
};

test('prices the exit from the pool bid and the market close of the exact short', () => {
  const math = baseSepoliaExitQuoteMath(mathInput);
  // 1001 base atoms less 0.3% is 997.997, rounded down; the mid is 1001.
  assert.equal(math.spotProceedsAtoms, 997n);
  assert.equal(math.spotFeeAtoms, 4n);
  assert.equal(math.closeNotionalAtoms, 2_000_001n);
  assert.equal(math.closeFeeAtoms, 1n);
  // Equity 400,000 atoms less 118 wei floors to 399,999; less the 1-atom fee it pays out 399,998.
  assert.equal(math.payoutAtoms, 399_998n);
  assert.equal(math.outcomeAtoms, 997n + 399_998n - 300_000n);
  // A thin pool returns less than the mid less its fee: the quote takes the quoter's proceeds.
  const thin = baseSepoliaExitQuoteMath({ ...mathInput, spotQuoteOutAtoms: 950n });
  assert.deepEqual([thin.spotProceedsAtoms, thin.spotFeeAtoms, thin.outcomeAtoms], [950n, 4n, 950n + 399_998n - 300_000n]);
});

test('prices an exit sale with the quoter and refuses one the pool cannot absorb whole', async () => {
  // Base sorts below quote, so the sale is zeroForOne and its price limit is MIN_SQRT_RATIO + 1.
  const target = {
    chainId: 84_532n, quoter: { address: address('6'), expectedCodeHash: `0x${hash('6')}` as Hex },
    pool: address('c'), baseToken: address('1'), quoteToken: address('9'), poolFee: 3_000n,
  };
  const port = (result: readonly unknown[]) => ({
    chainId: async () => 84_532n,
    codeHash: async () => target.quoter.expectedCodeHash,
    readContract: async ({ functionName }: { functionName: string }) => functionName === 'factory' ? address('7') : result,
  });
  assert.equal(await quoteUniswapV3Sell(port([998n, Q96, 1, 0n]), target, 1_001n), 998n);
  await assert.rejects(quoteUniswapV3Sell(port([500n, 4_295_128_740n, 3, 0n]), target, 1_001n), /cannot absorb this spot sale/);
});

test('refuses to price a position that is not the exact package short', () => {
  assert.throws(() => baseSepoliaExitQuoteMath({ ...mathInput, position: { ...position, sizeWad: -1_000n } }), /exact package short/);
  assert.throws(() => baseSepoliaExitQuoteMath({ ...mathInput, position: { ...position, sizeWad: 1_001n } }), /exact package short/);
});

const manifest = domainManifest({
  manifestVersion: 1,
  environment: 'testnet',
  domainId: 'eip155:84532',
  runtimeClassId: 'naryx-evm',
  runtimeClassVersion: 1,
  chainNamespace: 'eip155',
  chainReference: '84532',
  executionVerifierId: 'package-verifier-v1',
  executionVerifierCodeHash: hash('7'),
  clockModelId: 'evm-unix-seconds',
  finalityPolicyHash: hash('8'),
  addressCodecId: 'evm-address-20',
  supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
});
const base = assetRef('weth', hash('2'), 18);
const quote = assetRef('usdc', hash('3'), 6);
const spotAdapter = adapterRef({ adapterId: 'uniswap-v3-spot', adapterManifestVersion: 1, adapterManifestHash: hash('4') });
const perpAdapter = adapterRef({ adapterId: 'base-perp-port', adapterManifestVersion: 1, adapterManifestHash: hash('5') });
const account = address('2');
const entryReceipt = `0x${'5e'.repeat(32)}` as Hex;
const receiptBytes = (byte: string) => Uint8Array.from(Buffer.from(byte.repeat(32), 'hex'));

function exitOrder(quantity: bigint): PackageOrderInput {
  const amount = (asset: typeof quote, atoms: bigint) => ({ asset, atoms });
  return {
    version: 1,
    environment: 'testnet',
    domain: domainRefFromManifest(manifest),
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    packageTemplateManifestHash: hash('6'),
    owner: address('1'),
    settlementAccount: account,
    nonce: 7n,
    expiryUnit: 'EVM_UNIX_SECONDS',
    expiryValue: 2_000n,
    direction: 'LONG_SPOT_SHORT_PERP',
    action: 'EXIT',
    packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'FOK',
    partialFillPolicy: 'EXACT_ALL_LEGS',
    quantity: amount(base, quantity),
    exitOutcomeSchemaVersion: 1,
    entryReceiptHash: receiptBytes('5e'),
    expectedPrePositionSize: amount(base, -quantity),
    expectedPrePositionEntryNotional: amount(quote, 2_100_000n),
    minExitQuoteOutcome: amount(quote, 1n),
    minSpotQuoteOut: amount(quote, 1n),
    maxMarginAdded: amount(quote, 0n),
    minVenueReserveReturned: amount(quote, 0n),
    minWalletQuoteBalanceDelta: amount(quote, 0n),
    maxVenueFeeAtomsByAsset: [{ asset: quote, maxAtoms: 1_000n }],
    maxProtocolFee: amount(quote, 0n),
    maxSolverFee: amount(quote, 0n),
    maxPriorityFee: amount(quote, 0n),
    maxRecoveryCostAtomsByAsset: [],
    permittedSpotAdapters: [spotAdapter],
    permittedPerpAdapters: [perpAdapter],
    settlementClass: 'ATOMIC_POSTCONDITION',
    maxAggregateRecoveryLossQuote: amount(quote, 0n),
    maxResidualBaseQuantity: amount(base, 0n),
    allowedRecoveryActions: [],
  };
}

function port(order: PackageOrderInput, openQuantity: bigint, fallbackCalls: string[]) {
  const action = (sequence: number, adapter: typeof spotAdapter) => ({
    sequence, actionClassId: 'evm-call', adapter, targetBindingId: 't', authorityBindingId: 'strategy-account',
    accountMetas: [], payload: { codecId: 'evm', templateLength: 0, templateHash: hash('9'), lateBoundFields: [] },
  });
  const input = {
    deployment: {
      deployment: {
        domainManifest: manifest,
        strategyAccountFactory: { address: address('a') },
        packageVerifier: { address: address('b') },
        spot: { market: { address: address('c') } },
        perpetual: { market: { address: address('d') } },
        baseAsset: { address: address('e'), decimals: 18 },
      },
      admission: { templateManifest: { templateId: 'cash-and-carry-v1', templateVersion: 1 } },
      executionPolicy: { solver: address('f'), oracleMoveAllowanceBps: 100 },
    } as unknown as BaseSepoliaSolverDeployment,
    chain: {
      chainId: async () => 84_532n,
      codeHash: async () => undefined,
      latestBlockTimestamp: async () => 1_000n,
      readContract: async ({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case 'accountOf': return account;
          case 'expiry': return 4_294_967_295;
          case 'openPackage': return {
            entryReceiptHash: entryReceipt, routeHash: `0x${hash('7')}`, perpInstrument: address('d'), perpExpiry: 4_294_967_295,
            baseToken: address('e'), quoteToken: address('9'), baseQuantityAtoms: openQuantity, perpQuantityWad: openQuantity,
            packageSizeUnits: 1n, entryPerpNotionalWad: 2_100_000n * SCALE + 5n,
          };
          default: throw new Error(`unexpected read ${functionName}`);
        }
      },
    },
    nonceSource: { next: () => 1n },
    templateRegistryRecordHash: hash('6'),
    candidateId: 'base-sepolia-uniswap',
    capacityBaseAtoms: 10n ** 20n,
    solverId: 'base-solver',
    solverCapabilityManifestHash: hash('6'),
    feePolicyVersion: 1,
    feePolicyManifestHash: hash('6'),
    routeTtlSeconds: 60n,
    marginBps: 1_500,
    perpSlippageBps: 50,
    spot: { adapter: spotAdapter, venue: versionedManifestRef('uni', 1, hash('6')), market: versionedManifestRef('pool', 1, hash('6')), action: action(0, spotAdapter) },
    perpetual: { adapter: perpAdapter, venue: versionedManifestRef('perp', 1, hash('6')), market: versionedManifestRef('perp-m', 1, hash('6')), action: action(1, perpAdapter) },
    strategyAccountBindingId: 'strategy-account',
    accountBindings: [{ routeBindingId: 'strategy-account', accountIdentity: account }],
    preconditions: [],
    postconditions: [],
    evidenceRequirements: {} as never,
  } as unknown as BaseSepoliaQuoteRuntimeInput;
  return createBaseSepoliaExitQuotePort({
    input,
    orders: async () => order as never,
    signer: { verificationKey: new Uint8Array(32), signDigest: () => new Uint8Array(64) },
    store: new InMemoryInternalAtomicQuoteStore(),
  }, {
    quote: async (request) => {
      fallbackCalls.push(request.orderHash);
      throw new Error('fallback');
    },
  });
}

test('refuses an exit order whose quantity is not the open package record, and routes entries onward', async () => {
  const calls: string[] = [];
  const hashOf = (value: PackageOrderInput) => Buffer.from(packageOrderHash(value)).toString('hex');
  const order = exitOrder(1_001n);
  const orderHash = hashOf(order);
  await assert.rejects(
    port(order, 1_000n, calls).quote({ orderHash, idempotencyKey: 'base-exit-quote-0001' }),
    /quantities do not match the open package/,
  );
  const otherReceipt = { ...order, entryReceiptHash: receiptBytes('5f') };
  await assert.rejects(
    port(otherReceipt, 1_001n, calls).quote({ orderHash: hashOf(otherReceipt), idempotencyKey: 'base-exit-quote-0002' }),
    /no open package for the order entry receipt/,
  );
  const entry = { ...order, action: 'ENTRY' } as PackageOrderInput;
  await assert.rejects(port(entry, 1_001n, calls).quote({ orderHash, idempotencyKey: 'base-exit-quote-0003' }), /fallback/);
  assert.deepEqual(calls, [orderHash]);
});
