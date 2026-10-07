import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  assetAmount,
  assetRef,
  domainRef,
  manifestHash,
  packageGraph,
  packageGraphHash,
  packageTemplateManifest,
  packageTemplateManifestHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  versionedManifestRef,
  type PackageTemplateManifestInput,
} from '@naryx/protocol-types';
import { getAddress, zeroHash, type Abi, type Address, type Hex } from 'viem';
import {
  EvmReverseBasisPreparationContextResolver,
  EvmOptionSpreadProvisioningResolver,
  type EvmOptionSpreadReadPort,
  type EvmReverseBasisPricingInput,
  type StoredStrategyPackageDocuments,
} from '../src/index.js';

const address = (pattern: string) => getAddress(`0x${pattern.repeat(Math.ceil(40 / pattern.length)).slice(0, 40)}`);
const codeHash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const hash = (byte: string) => byte.repeat(64);
const NOW = 1_000n;
const QUANTITY = 10n ** 18n;
const OWNER = address('1');
const ACCOUNT = address('2');
const ACCOUNT_FACTORY = address('3');
const BASE = address('4');
const QUOTE = address('5');
const SPOT_FACTORY = address('6');
const SPOT_POOL = address('7');
const SPOT_QUOTER = address('8');
const LENDING_POOL = address('9');
const ORACLE = address('a');
const PERP_MARKET = address('b');
const LENDING_FACTORY = address('c');
const SPOT_ADAPTER_FACTORY = address('d');
const HEDGE_FACTORY = address('e');
const LENDING_ADAPTER = address('f');
const SPOT_ADAPTER = address('12');
const HEDGE_ADAPTER = address('13');
const SOLVER = address('14');
const domain = domainRef('eip155:84532', 1, hash('1'));
const baseAsset = assetRef('base-sepolia:ntbase', hash('2'), 18);
const quoteAsset = assetRef('base-sepolia:ntquote', hash('3'), 6);
const lendingRef = adapterRef({ adapterId: 'base-borrow', adapterManifestVersion: 1, adapterManifestHash: hash('4') });
const spotRef = adapterRef({ adapterId: 'base-spot-sale', adapterManifestVersion: 1, adapterManifestHash: hash('5') });
const hedgeRef = adapterRef({ adapterId: 'base-perp-purchase', adapterManifestVersion: 1, adapterManifestHash: hash('6') });
const venue = versionedManifestRef('naryx-evm-conformance', 1, hash('7'));
const lendingMarket = versionedManifestRef('ntbase-lending', 1, hash('8'));
const spotMarket = versionedManifestRef('ntbase-spot', 1, hash('9'));
const hedgeMarket = versionedManifestRef('ntbase-perpetual', 1, hash('a'));
const templateInput: PackageTemplateManifestInput = {
  manifestVersion: 2,
  environment: 'testnet',
  templateId: 'reverse-cash-and-carry-v1',
  templateVersion: 1,
  supportedDomains: [domain],
  orderSchemaHash: hash('b'),
  quoteSchemaHash: hash('c'),
  routeSchemaHash: hash('d'),
  receiptSchemaHash: hash('e'),
  entryCompilerVersion: 1,
  exitCompilerVersion: 1,
  legCount: 3,
  legTypes: ['base-borrow', 'spot-sale', 'perp-purchase'],
  supportedDirections: ['LONG_SPOT_SHORT_PERP'],
  supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
  allowedSpotAdapterIds: [spotRef.adapterId],
  allowedPerpAdapterIds: [hedgeRef.adapterId],
  allowedAdapterIds: [lendingRef.adapterId, spotRef.adapterId, hedgeRef.adapterId],
  riskPolicyHash: hash('f'),
};
const template = packageTemplateManifest(templateInput);
const templateHash = packageTemplateManifestHash(template);

class Chain implements EvmOptionSpreadReadPort {
  readonly codes = new Map<string, Hex>([
    [ACCOUNT_FACTORY, codeHash('1')], [ACCOUNT, codeHash('2')], [BASE, codeHash('3')], [QUOTE, codeHash('4')],
    [SPOT_FACTORY, codeHash('5')], [SPOT_POOL, codeHash('6')], [SPOT_QUOTER, codeHash('7')],
    [LENDING_POOL, codeHash('8')], [ORACLE, codeHash('9')], [PERP_MARKET, codeHash('a')],
    [LENDING_FACTORY, codeHash('b')], [SPOT_ADAPTER_FACTORY, codeHash('c')], [HEDGE_FACTORY, codeHash('d')],
    [LENDING_ADAPTER, codeHash('e')], [SPOT_ADAPTER, codeHash('f')], [HEDGE_ADAPTER, codeHash('1')],
  ]);

  async chainId() { return 84_532n; }
  async latestBlockTimestamp() { return NOW; }
  async codeHash(value: Address) { return this.codes.get(getAddress(value)); }

  async readContract(request: Readonly<{
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }>): Promise<unknown> {
    if (request.address === ACCOUNT_FACTORY) {
      if (request.functionName === 'accountOf') return ACCOUNT;
      if (request.functionName === 'isAccount') return true;
      if (request.functionName === 'accountCodeHash') return codeHash('2');
    }
    if (request.address === ACCOUNT) {
      if (request.functionName === 'owner') return OWNER;
      if (request.functionName === 'nextNonce') return 7n;
      if (request.functionName === 'packageState') {
        return [[zeroHash, 0n, zeroHash], zeroHash, zeroHash, false];
      }
    }
    const factories = new Map<Address, Address>([
      [LENDING_FACTORY, LENDING_ADAPTER], [SPOT_ADAPTER_FACTORY, SPOT_ADAPTER], [HEDGE_FACTORY, HEDGE_ADAPTER],
    ]);
    if (factories.has(request.address)) {
      if (request.functionName === 'adapterOf') return factories.get(request.address)!;
      if (request.functionName === 'validateInstance') return true;
    }
    if (request.address === LENDING_ADAPTER && request.functionName === 'accountData') {
      return [300_000_000n, 0n, 200_000_000n, 8_000n, 7_500n, 3n * 10n ** 18n];
    }
    if (request.address === HEDGE_ADAPTER && request.functionName === 'position') return [0n, 0n, 0n, 0n, 0n];
    if (request.address === SPOT_FACTORY && request.functionName === 'getPool') return SPOT_POOL;
    if (request.address === SPOT_POOL) {
      if (request.functionName === 'factory') return SPOT_FACTORY;
      if (request.functionName === 'token0') return BASE;
      if (request.functionName === 'token1') return QUOTE;
      if (request.functionName === 'fee') return 3_000n;
    }
    if (request.address === SPOT_QUOTER) {
      if (request.functionName === 'factory') return SPOT_FACTORY;
      if (request.functionName === 'quoteExactInputSingle') return [99_000_000n, 0n, 0n, 0n];
    }
    if (request.address === PERP_MARKET) {
      if (request.functionName === 'reserveOf') return 0n;
      if (request.functionName === 'collateral') return QUOTE;
      if (request.functionName === 'oracle') return ORACLE;
      if (request.functionName === 'expiry') return 2_000n;
      if (request.functionName === 'takerFeeBps') return 10n;
      if (request.functionName === 'initialMarginBps') return 2_000n;
      if (request.functionName === 'maintenanceMarginBps') return 1_000n;
      if (request.functionName === 'collateralScale') return 10n ** 12n;
      if (request.functionName === 'oraclePriceWad') return 100n * 10n ** 18n;
      if (request.functionName === 'currentFundingIndex') return 0n;
      if (request.functionName === 'previewOpen') return [101n * 10n ** 18n, 101n * 10n ** 18n, 10n ** 17n, 0n];
    }
    throw new Error(`unexpected read ${request.address}:${request.functionName}`);
  }
}

function pricing(chain: Chain): EvmReverseBasisPricingInput {
  const contract = (addressValue: Address, byte: string) => ({ address: addressValue, expectedCodeHash: codeHash(byte) });
  return {
    chainId: 84_532n,
    domain,
    baseAsset,
    quoteAsset,
    baseToken: contract(BASE, '3'),
    quoteToken: contract(QUOTE, '4'),
    spotFactory: contract(SPOT_FACTORY, '5'),
    spotPool: contract(SPOT_POOL, '6'),
    spotQuoter: contract(SPOT_QUOTER, '7'),
    spotPoolFee: 3_000,
    lendingPool: contract(LENDING_POOL, '8'),
    oracle: contract(ORACLE, '9'),
    perpetualMarket: contract(PERP_MARKET, 'a'),
    lending: { adapter: lendingRef, venue, market: lendingMarket },
    spot: { adapter: spotRef, venue, market: spotMarket },
    hedge: { adapter: hedgeRef, venue, market: hedgeMarket },
    minimumPostHealthFactor: 2n * 10n ** 18n,
    borrowCollateralRatioBps: 15_000n,
    annualBorrowRatePpm: 100_000n,
    holdingDurationSeconds: 3_600n,
    protocolFeeBps: 5,
    solverFeeBps: 5,
    networkFeeQuoteAtoms: 1_000n,
    feePolicyVersion: 1,
    feePolicyManifestHash: hash('1'),
    routeTtlSeconds: 30n,
    quoteTtlSeconds: 60n,
    chain,
    nonceSource: { nextNonce: () => 9n },
  };
}

function documents(): StoredStrategyPackageDocuments {
  const reducedPrice = (quoteAtoms: bigint) => {
    let divisor = quoteAtoms;
    let remainder = 10n ** 12n;
    while (remainder !== 0n) [divisor, remainder] = [remainder, divisor % remainder];
    return { quoteAtoms: quoteAtoms / divisor, baseAtoms: 10n ** 12n / divisor };
  };
  const leg = (input: Readonly<{
    id: 'base-borrow' | 'spot-sale' | 'perp-purchase';
    family: 'BORROW' | 'SPOT_SWAP' | 'PERP_OPEN';
    side: 'NONE' | 'SELL' | 'BUY';
    adapter: typeof lendingRef;
    market: typeof lendingMarket;
    quoteAtoms?: bigint;
  }>) => ({
    legId: input.id,
    legFamily: input.family,
    legTypeId: input.id,
    domain,
    adapter: input.adapter,
    venue,
    market: input.market,
    assets: [baseAsset, quoteAsset],
    side: input.side,
    quantityAsset: baseAsset,
    quantityAtoms: QUANTITY,
    minimumQuantityAtoms: QUANTITY,
    ...(input.quoteAtoms === undefined ? {} : { limitPrice: { baseAsset, quoteAsset, ...reducedPrice(input.quoteAtoms),
      roundingDirection: input.side === 'BUY' ? 'FLOOR' as const : 'CEIL' as const } }),
    maximumFeeQuoteAtoms: 2_000_000n,
    preconditionHashes: [],
    postconditionHashes: [],
    timeInForce: 'IOC' as const,
    legExpiryValue: 1_200n,
  });
  const graph = packageGraph({
    graphVersion: 1,
    environment: 'testnet',
    templateId: template.templateId,
    templateVersion: 1,
    packageTemplateManifestHash: templateHash,
    seriesId: 'ntbase-reverse-basis',
    seriesVersion: 1,
    seriesManifestHash: hash('2'),
    executionClassId: 'evm-atomic-reverse-basis',
    executionClassVersion: 1,
    executionClassManifestHash: hash('3'),
    lifecycleAction: 'ENTRY',
    owner: OWNER.toLowerCase(),
    strategyAccountRefs: [ACCOUNT.toLowerCase()],
    legs: [
      leg({ id: 'base-borrow', family: 'BORROW', side: 'NONE', adapter: lendingRef, market: lendingMarket }),
      leg({ id: 'spot-sale', family: 'SPOT_SWAP', side: 'SELL', adapter: spotRef, market: spotMarket, quoteAtoms: 98n }),
      leg({ id: 'perp-purchase', family: 'PERP_OPEN', side: 'BUY', adapter: hedgeRef, market: hedgeMarket, quoteAtoms: 102n }),
    ],
    dependencyEdges: [{ fromLegId: 'base-borrow', toLegId: 'spot-sale' },
      { fromLegId: 'spot-sale', toLegId: 'perp-purchase' }],
    executionGroups: [{ groupId: 'reverse-basis', kind: 'ALL_OR_NONE',
      legIds: ['base-borrow', 'spot-sale', 'perp-purchase'] }],
    settlementClass: 'ATOMIC_POSTCONDITION',
    policyHashes: { netting: hash('4'), privacy: hash('5'), solver: hash('6'), delivery: hash('7'),
      resource: hash('8'), portfolioRiskLimits: hash('9') },
    recoverySlots: [],
    maximumRecoveryCostQuoteAtoms: 0n,
    expiryUnit: 'EVM_UNIX_SECONDS',
    packageExpiryValue: 1_200n,
    nonce: 1n,
  });
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
    quoteConventionId: 'annualized-net-yield-v1',
    riskClassId: 'borrowed-basis-v1',
    owner: graph.owner,
    settlementAccount: ACCOUNT.toLowerCase(),
    lifecycleAction: 'ENTRY',
    settlementClass: 'ATOMIC_POSTCONDITION',
    packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'IOC',
    economicQuantity: assetAmount(baseAsset, QUANTITY),
    quoteAsset,
    metricLimits: [],
    maximumServiceFeesByAsset: [{ asset: quoteAsset, maxAtoms: 200_000n }],
    maximumVenueFeesByAsset: [{ asset: quoteAsset, maxAtoms: 2_000_000n }],
    maximumNetworkFeesByAsset: [{ asset: quoteAsset, maxAtoms: 1_000n }],
    maximumRecoveryCostByAsset: [],
    maximumMarginIncrease: assetAmount(quoteAsset, 25_000_000n),
    maximumResidualValue: assetAmount(quoteAsset, 0n),
    expiryUnit: 'EVM_UNIX_SECONDS',
    expiryValue: 1_200n,
    nonce: 1n,
  });
  const amount = (atoms: bigint) => assetAmount(quoteAsset, atoms);
  return {
    orderHashHex: Buffer.from(strategyPackageOrderHash(order)).toString('hex'),
    graphHashHex: Buffer.from(packageGraphHash(graph)).toString('hex'),
    quoteHashHex: hash('a'),
    routeHashHex: hash('b'),
    order,
    graph,
    quote: {
      serviceCharges: [{ category: 'PROTOCOL', amount: amount(49_500n) }, { category: 'SOLVER', amount: amount(49_500n) }],
      legEconomics: [
        { legId: 'base-borrow', grossNotional: amount(100_000_000n), marginDelta: amount(0n) },
        { legId: 'spot-sale', grossNotional: amount(99_000_000n), marginDelta: amount(0n),
          executionPrice: { baseAsset, quoteAsset, quoteAtoms: 99n, baseAtoms: 10n ** 12n, roundingDirection: 'FLOOR' } },
        { legId: 'perp-purchase', grossNotional: amount(101_000_000n), marginDelta: amount(20_300_000n),
          executionPrice: { baseAsset, quoteAsset, quoteAtoms: 101n, baseAtoms: 10n ** 12n, roundingDirection: 'CEIL' } },
      ],
      feePolicyVersion: 1,
      feePolicyManifestHash: manifestHash(hash('c')),
      validUntilValue: 1_100n,
    },
    route: {
      domainPlans: [{ executionPlanKind: 'EVM_ATOMIC_BATCH', domain }],
      routeExpiryValue: 1_100n,
    },
    recordedAtMs: 1,
  } as unknown as StoredStrategyPackageDocuments;
}

test('binds reverse basis entry to reviewed package adapters and exact approvals', async () => {
  const chain = new Chain();
  const lane = {
    environment: 'testnet' as const,
    templateManifest: template,
    activeRegistryRecords: [],
    resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 6 }],
    pricing: pricing(chain),
    accountFactory: { address: ACCOUNT_FACTORY, expectedCodeHash: codeHash('1') },
    expectedStrategyAccountCodeHash: codeHash('2'),
    adapters: [
      { role: 'base-borrow', factory: { address: LENDING_FACTORY, expectedCodeHash: codeHash('b') },
        expectedAdapterCodeHash: codeHash('e'), maximumGasLimit: 600_000n },
      { role: 'spot-sale', factory: { address: SPOT_ADAPTER_FACTORY, expectedCodeHash: codeHash('c') },
        expectedAdapterCodeHash: codeHash('f'), maximumGasLimit: 600_000n },
      { role: 'perp-purchase', factory: { address: HEDGE_FACTORY, expectedCodeHash: codeHash('d') },
        expectedAdapterCodeHash: codeHash('1'), maximumGasLimit: 600_000n },
    ] as const,
    debtBaseAtomsPerWholeBaseToken: 100_000_000n,
    debtBaseToleranceBps: 100n,
    solver: SOLVER,
    packageIds: { resolvePackageId: async () => undefined },
  };
  const packageDocuments = documents();
  const context = await new EvmReverseBasisPreparationContextResolver([lane]).resolve(packageDocuments);
  assert.equal(context.identity.operation, 'ENTRY');
  assert.equal(context.identity.nextStateHash?.length, 32);
  assert.equal(context.compilers.length, 1);
  const binding = context.bindings[0];
  assert.equal(binding?.kind, 'EVM_MULTI_STRATEGY_ACCOUNT');
  if (binding?.kind !== 'EVM_MULTI_STRATEGY_ACCOUNT') throw new Error('missing EVM strategy binding');
  assert.deepEqual(binding.callPolicies.map((policy) => [policy.legId, policy.approvalAtoms]), [
    ['base-borrow', 0n],
    ['spot-sale', QUANTITY],
    ['perp-purchase', 20_300_000n],
  ]);
  assert.deepEqual(binding.callPolicies.map((policy) => policy.expectedAdapterAddress),
    [LENDING_ADAPTER, SPOT_ADAPTER, HEDGE_ADAPTER]);
  assert.equal(binding.nonce, 7n);
  const provisioning = await new EvmOptionSpreadProvisioningResolver([lane]).resolve(packageDocuments);
  assert.equal(provisioning.ready, true);
  assert.equal(provisioning.strategyAccount, ACCOUNT);
});
