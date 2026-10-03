import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  assetAmount,
  assetRef,
  canonicalBytes,
  compareBytes,
  domainManifest,
  encodeAssetRef,
  domainRefFromManifest,
  packageOrderHash,
  payloadTemplateHash,
  validatePackageOrderProfile,
  versionedManifestRef,
  type PackageOrder,
  type PackageOrderInput,
} from '@naryx/protocol-types';
import { getAddress, type Address, type Hex } from 'viem';
import { planAtomicEntryRoute } from '../src/atomic-route-decision.js';
import {
  baseSepoliaFeesByAsset,
  createBaseSepoliaQuoteRuntime,
  priceBaseSepoliaEntry,
  type BaseSepoliaReadPort,
  type BaseSepoliaSolverDeployment,
} from '../src/base-sepolia-quote-runtime.js';
import { parseBaseSepoliaAuthorizationBounds } from '../src/base-sepolia-solver-authorization.js';

const hash = (byte: string) => byte.repeat(64);
const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const SCALE = 1_000_000_000_000n;
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
const owner = address('1');
const account = address('2');
const deployment = {
  domainManifest: manifest,
  deploymentChainReference: 84_532n,
  strategyAccountFactory: { address: address('a'), expectedCodeHash: `0x${hash('a')}` as Hex },
  spot: { market: { address: address('b') } },
  perpetual: { market: { address: address('c') } },
  baseAsset: { address: address('d'), decimals: 18 },
  quoteAsset: { address: address('9'), decimals: 6 },
} as unknown as BaseSepoliaSolverDeployment['deployment'];
const spotQuoter = { address: address('6'), expectedCodeHash: `0x${hash('6')}` as Hex };

type QuoterCall = Readonly<{ functionName: string; args?: readonly unknown[] }>;

function chain(options: Readonly<{ quoteIn?: bigint; perpNotionalWad?: bigint; calls?: QuoterCall[] }> = {}): BaseSepoliaReadPort {
  return {
    chainId: async () => 84_532n,
    codeHash: async (target) => target === spotQuoter.address ? spotQuoter.expectedCodeHash : undefined,
    latestBlockTimestamp: async () => 1_000n,
    readContract: async ({ functionName, args }) => {
      switch (functionName) {
        case 'fee': return 3_000;
        case 'oracle': return address('e');
        case 'collateralScale': return SCALE;
        case 'previewOpen': return [0n, options.perpNotionalWad ?? 2_000_000n * SCALE + 123n, SCALE, 0n];
        case 'decimals': return 8;
        case 'latestRoundData': return [1n, 300_000_000_000n, 0n, 990n, 1n];
        case 'accountOf': return account;
        // The quoter and the spot pool share one Uniswap factory.
        case 'factory': return address('7');
        case 'quoteExactOutputSingle':
          options.calls?.push({ functionName, ...(args === undefined ? {} : { args }) });
          return [options.quoteIn ?? 1_005n, 0n, 0, 0n];
        default: throw new Error(`unexpected read ${functionName}`);
      }
    },
  };
}

function quoteRuntime(port: BaseSepoliaReadPort) {
  const action = (sequence: number, adapter: typeof spotAdapter) => ({
    sequence, actionClassId: 'evm-call', legIndex: sequence, adapter, targetBindingId: 'executor',
    authorityBindingId: 'strategy-account', accountMetas: [],
    payload: { codecId: 'evm-abi-v1', templateLength: 0, templateHash: payloadTemplateHash(new Uint8Array(), []), lateBoundFields: [] },
  });
  return createBaseSepoliaQuoteRuntime({
    deployment: {
      deployment,
      admission: { templateManifest: { templateId: 'cash-and-carry-v1', templateVersion: 1 } },
      executionPolicy: { solver: address('f'), oracleMoveAllowanceBps: 100 },
    } as unknown as BaseSepoliaSolverDeployment,
    chain: port,
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
    spotQuoter,
    spot: { adapter: spotAdapter, venue: versionedManifestRef('uni', 1, hash('6')), market: versionedManifestRef('pool', 1, hash('6')), action: action(0, spotAdapter) },
    perpetual: { adapter: perpAdapter, venue: versionedManifestRef('perp', 1, hash('6')), market: versionedManifestRef('perp-m', 1, hash('6')), action: action(1, perpAdapter) },
    strategyAccountBindingId: 'strategy-account',
    accountBindings: [
      { routeBindingId: 'executor', accountIdentity: 'eip155:84532:executor' },
      { routeBindingId: 'strategy-account', accountIdentity: account },
    ],
    preconditions: [],
    postconditions: [],
    evidenceRequirements: {
      schemaVersion: 1, profileId: 'package-verifier-atomic-v1',
      requiredPreStateComponentIds: ['strategy-account'], requiredPostStateComponentIds: ['strategy-account'],
      requiredActionEvidenceTypeIds: ['evm-receipt'],
      stateReferenceSchemaHash: hash('d'), receiptSchemaHash: hash('e'), outcomeSchemaHash: hash('f'),
    },
  });
}

function entryOrder(): PackageOrderInput {
  return {
    version: 1, environment: 'testnet', domain: domainRefFromManifest(manifest),
    templateId: 'cash-and-carry-v1', templateVersion: 1, packageTemplateManifestHash: hash('9'),
    owner, settlementAccount: account, nonce: 3n,
    expiryUnit: 'EVM_UNIX_SECONDS', expiryValue: 2_000n,
    direction: 'LONG_SPOT_SHORT_PERP', action: 'ENTRY', packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'FOK', partialFillPolicy: 'EXACT_ALL_LEGS',
    quantity: assetAmount(base, 1_001n), exitOutcomeSchemaVersion: 0,
    expectedPrePositionSize: assetAmount(base, 0n), expectedPrePositionEntryNotional: assetAmount(quote, 0n),
    maxEntrySpread: { baseAsset: base, quoteAsset: quote, quoteAtoms: 1n, baseAtoms: 1n, roundingDirection: 'CEIL' },
    maxSpotQuoteIn: assetAmount(quote, 1_200n),
    maxMarginAdded: assetAmount(quote, 1_000n),
    minVenueReserveReturned: assetAmount(quote, 0n), minWalletQuoteBalanceDelta: assetAmount(quote, 0n),
    maxVenueFeeAtomsByAsset: [{ asset: quote, maxAtoms: 100n }, { asset: base, maxAtoms: 0n }],
    maxProtocolFee: assetAmount(quote, 0n), maxSolverFee: assetAmount(quote, 0n), maxPriorityFee: assetAmount(quote, 0n),
    maxRecoveryCostAtomsByAsset: [],
    permittedSpotAdapters: [spotAdapter], permittedPerpAdapters: [perpAdapter],
    settlementClass: 'ATOMIC_POSTCONDITION',
    maxAggregateRecoveryLossQuote: assetAmount(quote, 0n), maxResidualBaseQuantity: assetAmount(base, 0n),
    allowedRecoveryActions: [],
  };
}

test('prices the exact-output spot buy at the quoter cost and margins the perp from previewOpen', async () => {
  const pricing = await priceBaseSepoliaEntry(chain(), deployment, 1_001n, 1_500n, spotQuoter);
  // 1001 base atoms at 1 quote atom each through a 0.3% pool cost 1005; its fee share 3.015 rounds up.
  assert.equal(pricing.spotNotionalAtoms, 1_005n);
  assert.equal(pricing.spotFeeAtoms, 4n);
  assert.equal(pricing.perpNotionalAtoms, 2_000_000n);
  assert.equal(pricing.perpFeeAtoms, 1n);
  assert.equal(pricing.marginAtoms, 300_001n);
});

test('a thin Base pool prices its impact into the quoted spot notional and spread', async () => {
  // The hedge sells 1001 base atoms for 1001 quote atoms. Without impact the pool would charge 1005;
  // this pool charges 1105, and the quote carries that cost rather than the pool mid.
  const calls: QuoterCall[] = [];
  const runtime = quoteRuntime(chain({ quoteIn: 1_105n, perpNotionalWad: 1_001n * SCALE + 123n, calls }));
  const order = validatePackageOrderProfile(entryOrder());
  const orderHash = packageOrderHash(order);
  const candidates = await runtime.candidates({ order, orderHash });
  const decision = planAtomicEntryRoute({ order, orderHash }, () => candidates);
  const terms = await runtime.terms({ order, decision });
  assert.equal(terms.expectedSpotNotional.atoms, 1_105n);
  assert.equal(terms.expectedPerpNotional.atoms, 1_001n);
  // (1105 - 1001) / 1001 is 8 / 77 quote atoms per base atom.
  const outcome = terms.quotedOutcome;
  assert.ok(outcome.kind === 'ENTRY_SPREAD');
  assert.deepEqual([outcome.entrySpread.quoteAtoms, outcome.entrySpread.baseAtoms], [8n, 77n]);
  // The pool fee is 0.3% of the 1105 paid (3.315, rounded up) plus the 1-atom perp fee.
  assert.equal(terms.expectedNormalizedVenueFeesByAsset.find((fee) => fee.asset.assetId === 'usdc')?.atoms, 5n);
  assert.equal(decision.expectedNetPackageOutcomeQuoteAtoms, 1_001n - 1_105n - 1n);
  assert.deepEqual(calls, [{
    functionName: 'quoteExactOutputSingle',
    args: [{ tokenIn: address('9'), tokenOut: getAddress(address('d')), amount: 1_001n, fee: 3_000, sqrtPriceLimitX96: 0n }],
  }]);
});

test('refuses to quote an order whose settlement account is not the owner factory account', async () => {
  const runtime = quoteRuntime(chain());
  const order = {
    environment: 'testnet',
    settlementClass: 'ATOMIC_POSTCONDITION',
    expiryUnit: 'EVM_UNIX_SECONDS',
    expiryValue: 2_000n,
    action: 'ENTRY',
    domain: domainRefFromManifest(manifest),
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    permittedSpotAdapters: [spotAdapter],
    permittedPerpAdapters: [perpAdapter],
    maxSpotQuoteIn: { asset: quote, atoms: 10n ** 12n },
    quantity: { asset: base, atoms: 1_001n },
    owner,
    settlementAccount: address('9'),
  } as unknown as PackageOrder;
  await assert.rejects(
    async () => runtime.candidates({ order, orderHash: new Uint8Array(32).fill(1) as never }),
    /not the owner factory account/,
  );
});

test('accepts only the exact signed-bounds wire shape for co-signing', () => {
  const wire = {
    currentUnixSeconds: '1000',
    strategyAccount: account,
    solver: address('f'),
    spotFillCommitment: `0x${hash('1')}`,
    packageNonce: '4',
    expectedPrePerpEntryNotionalWad: '0',
    expectedPrePerpBalanceWad: '0',
    minimumPostPerpBalanceWad: '1',
    maximumPostPerpBalanceWad: '2',
    maximumPostPerpEntryNotionalWad: '3',
    perpExpiry: 4_294_967_295,
    perpArgs: [`0x${hash('2')}`, `0x${hash('3')}`],
  };
  const parsed = parseBaseSepoliaAuthorizationBounds(wire);
  assert.equal(parsed.maximumPostPerpEntryNotionalWad, 3n);
  assert.equal(parsed.packageNonce, 4n);
  assert.throws(() => parseBaseSepoliaAuthorizationBounds({ ...wire, extra: 1 }), /malformed/);
  assert.throws(() => parseBaseSepoliaAuthorizationBounds({ ...wire, minimumPostPerpBalanceWad: '1.5' }), /decimal/);
});

test('lists the base asset fee as zero beside the quote fee, in canonical asset order', () => {
  // The protocol refuses a quote whose fee lists have no base-asset entry or are out of order.
  const fees = baseSepoliaFeesByAsset(base, quote, 2_680n);
  const key = (asset: typeof base) => canonicalBytes((writer) => encodeAssetRef(writer, asset));
  assert.equal(fees.length, 2);
  assert.ok(compareBytes(key(fees[0]!.asset), key(fees[1]!.asset)) < 0);
  assert.equal(fees.find((fee) => fee.asset.assetId === 'weth')?.atoms, 0n);
  assert.equal(fees.find((fee) => fee.asset.assetId === 'usdc')?.atoms, 2_680n);
});
