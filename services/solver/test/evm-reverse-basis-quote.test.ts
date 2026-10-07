import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  adapterRef,
  assetAmount,
  assetRef,
  domainRef,
  packageGraph,
  packageGraphHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  versionedManifestRef,
} from '@naryx/protocol-types';
import type { Abi, Address, Hex } from 'viem';
import {
  createEvmReverseBasisGeneralizedPricing,
  type EvmOptionSpreadReadPort,
  type EvmReverseBasisPricingInput,
  type StoredStrategyPackageOrderDocuments,
} from '../src/index.js';

const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const codeHash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const hash = (byte: string) => byte.repeat(64);
const NOW = 1_000n;
const QUANTITY = 10n ** 18n;
const BASE = address('1');
const QUOTE = address('2');
const SPOT_FACTORY = address('3');
const SPOT_POOL = address('4');
const SPOT_QUOTER = address('5');
const LENDING_POOL = address('6');
const ORACLE = address('7');
const PERP_MARKET = address('8');
const domain = domainRef('eip155:84532', 1, hash('1'));
const baseAsset = assetRef('base-sepolia:ntbase', hash('2'), 18);
const quoteAsset = assetRef('base-sepolia:ntquote', hash('3'), 6);
const lendingAdapter = adapterRef({ adapterId: 'base-borrow', adapterManifestVersion: 1, adapterManifestHash: hash('4') });
const spotAdapter = adapterRef({ adapterId: 'base-spot-sale', adapterManifestVersion: 1, adapterManifestHash: hash('5') });
const hedgeAdapter = adapterRef({ adapterId: 'base-perp-purchase', adapterManifestVersion: 1, adapterManifestHash: hash('6') });
const venue = versionedManifestRef('naryx-evm-conformance', 1, hash('7'));
const lendingMarket = versionedManifestRef('ntbase-lending', 1, hash('8'));
const spotMarket = versionedManifestRef('ntbase-spot', 1, hash('9'));
const hedgeMarket = versionedManifestRef('ntbase-perpetual', 1, hash('a'));

class Chain implements EvmOptionSpreadReadPort {
  readonly codes = new Map<string, Hex>([
    [BASE, codeHash('1')], [QUOTE, codeHash('2')], [SPOT_FACTORY, codeHash('3')],
    [SPOT_POOL, codeHash('4')], [SPOT_QUOTER, codeHash('5')], [LENDING_POOL, codeHash('6')],
    [ORACLE, codeHash('7')], [PERP_MARKET, codeHash('8')],
  ]);

  async chainId() { return 84_532n; }
  async latestBlockTimestamp() { return NOW; }
  async codeHash(value: Address) { return this.codes.get(value.toLowerCase()); }

  async readContract(request: Readonly<{ address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }>): Promise<unknown> {
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
      switch (request.functionName) {
        case 'collateral': return QUOTE;
        case 'oracle': return ORACLE;
        case 'expiry': return 2_000n;
        case 'takerFeeBps': return 10n;
        case 'initialMarginBps': return 2_000n;
        case 'maintenanceMarginBps': return 1_000n;
        case 'collateralScale': return 10n ** 12n;
        case 'oraclePriceWad': return 100n * 10n ** 18n;
        case 'currentFundingIndex': return 0n;
        case 'fundingRatePerSecond': return 10n ** 10n;
        case 'previewOpen':
          assert.deepEqual(request.args, [QUANTITY, 0n]);
          return [101n * 10n ** 18n, 101n * 10n ** 18n, 10n ** 17n, 0n];
      }
    }
    throw new Error(`unexpected read ${request.address}:${request.functionName}`);
  }
}

function documents(minimumSpotQuoteAtoms: bigint): StoredStrategyPackageOrderDocuments {
  const expiry = 1_200n;
  const reducedPrice = (quoteAtoms: bigint) => {
    let divisor = quoteAtoms;
    let remainder = QUANTITY;
    while (remainder !== 0n) [divisor, remainder] = [remainder, divisor % remainder];
    return { quoteAtoms: quoteAtoms / divisor, baseAtoms: QUANTITY / divisor };
  };
  const leg = (input: Readonly<{
    id: 'base-borrow' | 'spot-sale' | 'perp-purchase';
    family: 'BORROW' | 'SPOT_SWAP' | 'PERP_OPEN';
    side: 'NONE' | 'SELL' | 'BUY';
    adapter: typeof lendingAdapter;
    market: typeof lendingMarket;
    limitQuoteAtoms?: bigint;
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
    ...(input.limitQuoteAtoms === undefined ? {} : {
      limitPrice: {
        baseAsset,
        quoteAsset,
        ...reducedPrice(input.limitQuoteAtoms),
        roundingDirection: input.side === 'BUY' ? 'FLOOR' as const : 'CEIL' as const,
      },
    }),
    maximumFeeQuoteAtoms: 2_000_000n,
    preconditionHashes: [],
    postconditionHashes: [],
    timeInForce: 'IOC' as const,
    legExpiryValue: expiry,
  });
  const graph = packageGraph({
    graphVersion: 1,
    environment: 'testnet',
    templateId: 'reverse-cash-and-carry-v1',
    templateVersion: 1,
    packageTemplateManifestHash: hash('b'),
    seriesId: 'ntbase-reverse-basis',
    seriesVersion: 1,
    seriesManifestHash: hash('c'),
    executionClassId: 'evm-atomic-reverse-basis',
    executionClassVersion: 1,
    executionClassManifestHash: hash('d'),
    lifecycleAction: 'ENTRY',
    owner: address('9').toLowerCase(),
    strategyAccountRefs: [address('a').toLowerCase()],
    legs: [
      leg({ id: 'base-borrow', family: 'BORROW', side: 'NONE', adapter: lendingAdapter, market: lendingMarket }),
      leg({ id: 'spot-sale', family: 'SPOT_SWAP', side: 'SELL', adapter: spotAdapter, market: spotMarket,
        limitQuoteAtoms: minimumSpotQuoteAtoms }),
      leg({ id: 'perp-purchase', family: 'PERP_OPEN', side: 'BUY', adapter: hedgeAdapter, market: hedgeMarket,
        limitQuoteAtoms: 102_000_000n }),
    ],
    dependencyEdges: [{ fromLegId: 'base-borrow', toLegId: 'spot-sale' },
      { fromLegId: 'spot-sale', toLegId: 'perp-purchase' }],
    executionGroups: [{ groupId: 'reverse-basis', kind: 'ALL_OR_NONE',
      legIds: ['base-borrow', 'spot-sale', 'perp-purchase'] }],
    settlementClass: 'ATOMIC_POSTCONDITION',
    policyHashes: { netting: hash('1'), privacy: hash('2'), solver: hash('3'), delivery: hash('4'),
      resource: hash('5'), portfolioRiskLimits: hash('6') },
    recoverySlots: [],
    maximumRecoveryCostQuoteAtoms: 0n,
    expiryUnit: 'EVM_UNIX_SECONDS',
    packageExpiryValue: expiry,
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
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.ANNUALIZED_NET_YIELD,
    riskClassId: STRATEGY_RISK_CLASS_ID.BORROWED_BASIS,
    owner: graph.owner,
    settlementAccount: address('a').toLowerCase(),
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
    expiryValue: expiry,
    nonce: 1n,
  });
  return {
    orderHashHex: Buffer.from(strategyPackageOrderHash(order)).toString('hex'),
    graphHashHex: Buffer.from(packageGraphHash(graph)).toString('hex'),
    order,
    graph,
    recordedAtMs: 1,
  };
}

function pricing(chain: Chain): EvmReverseBasisPricingInput {
  const contract = (addressValue: Address, byte: string) => ({ address: addressValue, expectedCodeHash: codeHash(byte) });
  return {
    chainId: 84_532n,
    domain,
    baseAsset,
    quoteAsset,
    baseToken: contract(BASE, '1'),
    quoteToken: contract(QUOTE, '2'),
    spotFactory: contract(SPOT_FACTORY, '3'),
    spotPool: contract(SPOT_POOL, '4'),
    spotQuoter: contract(SPOT_QUOTER, '5'),
    spotPoolFee: 3_000,
    lendingPool: contract(LENDING_POOL, '6'),
    oracle: contract(ORACLE, '7'),
    perpetualMarket: contract(PERP_MARKET, '8'),
    lending: { adapter: lendingAdapter, venue, market: lendingMarket },
    spot: { adapter: spotAdapter, venue, market: spotMarket },
    hedge: { adapter: hedgeAdapter, venue, market: hedgeMarket },
    minimumPostHealthFactor: 2n * 10n ** 18n,
    borrowCollateralRatioBps: 15_000n,
    annualBorrowRatePpm: 100_000n,
    holdingDurationSeconds: 3_600n,
    protocolFeeBps: 5,
    solverFeeBps: 5,
    networkFeeQuoteAtoms: 1_000n,
    feePolicyVersion: 1,
    feePolicyManifestHash: hash('e'),
    routeTtlSeconds: 30n,
    quoteTtlSeconds: 60n,
    chain,
    nonceSource: { nextNonce: () => 9n },
  };
}

test('prices atomic reverse basis carry and rejects a spot sale below the signed limit', async () => {
  const port = createEvmReverseBasisGeneralizedPricing(pricing(new Chain()));
  const terms = await port.quote({ documents: documents(98_000_000n), currentTime: { unit: 'EVM_UNIX_SECONDS', value: NOW } });
  assert.equal(terms.legEconomics.length, 3);
  assert.equal(terms.legEconomics.find((leg) => leg.legId === 'spot-sale')?.grossNotional.atoms, 99_000_000n);
  assert.equal(terms.legEconomics.find((leg) => leg.legId === 'perp-purchase')?.marginDelta.atoms, 20_300_000n);
  assert.equal(terms.netPackageOutcomeAtoms, -2_503_178n);
  assert.equal(terms.quoteNonce, 9n);
  await assert.rejects(
    port.quote({ documents: documents(100_000_000n), currentTime: { unit: 'EVM_UNIX_SECONDS', value: NOW } }),
    /executable spot price violates the signed limit/,
  );
});
