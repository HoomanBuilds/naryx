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
  createEvmTreasuryHedgeGeneralizedPricing,
  type EvmOptionSpreadReadPort,
  type EvmTreasuryHedgePricingInput,
  type StoredStrategyPackageOrderDocuments,
} from '../src/index.js';
import { matchesEvmTreasuryHedgePrice } from '../src/evm-treasury-hedge-preparation.js';

const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const codeHash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const hash = (byte: string) => byte.repeat(64);
const NOW = 1_000n;
const QUANTITY = 10n ** 18n;
const INVENTORY_TOKEN = address('1');
const QUOTE_TOKEN = address('2');
const ORACLE = address('3');
const MARKET = address('4');

const domain = domainRef('eip155:84532', 1, hash('1'));
const inventoryAsset = assetRef('base-sepolia:ntbase', hash('2'), 18);
const quoteAsset = assetRef('base-sepolia:ntquote', hash('3'), 6);
const inventoryAdapter = adapterRef({
  adapterId: 'base-inventory-position',
  adapterManifestVersion: 1,
  adapterManifestHash: hash('4'),
});
const hedgeAdapter = adapterRef({
  adapterId: 'base-treasury-hedge',
  adapterManifestVersion: 1,
  adapterManifestHash: hash('5'),
});
const venue = versionedManifestRef('naryx-evm-conformance', 1, hash('6'));
const inventoryMarket = versionedManifestRef('ntbase-inventory', 1, hash('7'));
const hedgeMarket = versionedManifestRef('ntbase-perpetual', 1, hash('8'));

class Chain implements EvmOptionSpreadReadPort {
  readonly codes = new Map<string, Hex>([
    [INVENTORY_TOKEN, codeHash('1')],
    [QUOTE_TOKEN, codeHash('2')],
    [ORACLE, codeHash('3')],
    [MARKET, codeHash('4')],
  ]);

  async chainId() { return 84_532n; }
  async latestBlockTimestamp() { return NOW; }
  async codeHash(value: Address) { return this.codes.get(value.toLowerCase()); }

  async readContract(request: Readonly<{
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }>): Promise<unknown> {
    assert.equal(request.address, MARKET);
    switch (request.functionName) {
      case 'collateral': return QUOTE_TOKEN;
      case 'oracle': return ORACLE;
      case 'expiry': return 2_000n;
      case 'takerFeeBps': return 10n;
      case 'initialMarginBps': return 2_000n;
      case 'maintenanceMarginBps': return 1_000n;
      case 'collateralScale': return 10n ** 12n;
      case 'oraclePriceWad': return 100n * 10n ** 18n;
      case 'currentFundingIndex': return -50n;
      case 'previewOpen':
        assert.deepEqual(request.args, [-QUANTITY, 0n]);
        return [100n * 10n ** 18n, 100n * 10n ** 18n, 10n ** 17n, 0n];
      default: throw new Error(`unexpected read ${request.functionName}`);
    }
  }
}

function documents(limitQuoteAtoms: bigint): StoredStrategyPackageOrderDocuments {
  const graph = packageGraph({
    graphVersion: 1,
    environment: 'testnet',
    templateId: 'treasury-inventory-hedge-v1',
    templateVersion: 1,
    packageTemplateManifestHash: hash('9'),
    seriesId: 'ntbase-treasury-hedge',
    seriesVersion: 1,
    seriesManifestHash: hash('a'),
    executionClassId: 'evm-atomic-treasury-hedge',
    executionClassVersion: 1,
    executionClassManifestHash: hash('b'),
    lifecycleAction: 'ENTRY',
    owner: address('5').toLowerCase(),
    strategyAccountRefs: [address('6').toLowerCase()],
    legs: [{
      legId: 'inventory-position',
      legFamily: 'INVENTORY_TRANSFER',
      legTypeId: 'inventory-position',
      domain,
      adapter: inventoryAdapter,
      venue,
      market: inventoryMarket,
      assets: [inventoryAsset, quoteAsset],
      side: 'NONE',
      quantityAsset: inventoryAsset,
      quantityAtoms: QUANTITY,
      minimumQuantityAtoms: QUANTITY,
      maximumFeeQuoteAtoms: 0n,
      preconditionHashes: [],
      postconditionHashes: [],
      timeInForce: 'IOC',
      legExpiryValue: 1_200n,
    }, {
      legId: 'treasury-hedge',
      legFamily: 'PERP_OPEN',
      legTypeId: 'treasury-hedge',
      domain,
      adapter: hedgeAdapter,
      venue,
      market: hedgeMarket,
      assets: [inventoryAsset, quoteAsset],
      side: 'SELL',
      quantityAsset: inventoryAsset,
      quantityAtoms: QUANTITY,
      minimumQuantityAtoms: QUANTITY,
      limitPrice: {
        baseAsset: inventoryAsset,
        quoteAsset,
        quoteAtoms: limitQuoteAtoms,
        baseAtoms: 10n ** 12n,
        roundingDirection: 'CEIL',
      },
      maximumFeeQuoteAtoms: 200_000n,
      preconditionHashes: [],
      postconditionHashes: [],
      timeInForce: 'IOC',
      legExpiryValue: 1_200n,
    }],
    dependencyEdges: [{ fromLegId: 'inventory-position', toLegId: 'treasury-hedge' }],
    executionGroups: [{ groupId: 'treasury-hedge', kind: 'ALL_OR_NONE', legIds: ['inventory-position', 'treasury-hedge'] }],
    settlementClass: 'ATOMIC_POSTCONDITION',
    policyHashes: {
      netting: hash('1'), privacy: hash('2'), solver: hash('3'), delivery: hash('4'),
      resource: hash('5'), portfolioRiskLimits: hash('6'),
    },
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
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.HEDGE_COST,
    riskClassId: STRATEGY_RISK_CLASS_ID.TREASURY_HEDGE,
    owner: graph.owner,
    settlementAccount: address('6').toLowerCase(),
    lifecycleAction: 'ENTRY',
    settlementClass: 'ATOMIC_POSTCONDITION',
    packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'IOC',
    economicQuantity: assetAmount(inventoryAsset, QUANTITY),
    quoteAsset,
    metricLimits: [],
    maximumServiceFeesByAsset: [{ asset: quoteAsset, maxAtoms: 200_000n }],
    maximumVenueFeesByAsset: [{ asset: quoteAsset, maxAtoms: 200_000n }],
    maximumNetworkFeesByAsset: [{ asset: quoteAsset, maxAtoms: 1_000n }],
    maximumRecoveryCostByAsset: [],
    maximumMarginIncrease: assetAmount(quoteAsset, 21_000_000n),
    maximumResidualValue: assetAmount(quoteAsset, 0n),
    expiryUnit: 'EVM_UNIX_SECONDS',
    expiryValue: 1_200n,
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

function pricing(chain: Chain): EvmTreasuryHedgePricingInput {
  return {
    chainId: 84_532n,
    domain,
    inventoryAsset,
    quoteAsset,
    inventoryToken: { address: INVENTORY_TOKEN, expectedCodeHash: codeHash('1') },
    quoteToken: { address: QUOTE_TOKEN, expectedCodeHash: codeHash('2') },
    oracle: { address: ORACLE, expectedCodeHash: codeHash('3') },
    market: { address: MARKET, expectedCodeHash: codeHash('4') },
    inventory: { adapter: inventoryAdapter, venue, market: inventoryMarket },
    hedge: { adapter: hedgeAdapter, venue, market: hedgeMarket },
    protocolFeeBps: 5,
    solverFeeBps: 5,
    networkFeeQuoteAtoms: 1_000n,
    feePolicyVersion: 1,
    feePolicyManifestHash: hash('c'),
    routeTtlSeconds: 30n,
    quoteTtlSeconds: 60n,
    chain,
    nonceSource: { nextNonce: () => 7n },
  };
}

test('prices an exact EVM treasury hedge and rejects a fill below the signed sell limit', async () => {
  const port = createEvmTreasuryHedgeGeneralizedPricing(pricing(new Chain()));
  const terms = await port.quote({
    documents: documents(99n),
    currentTime: { unit: 'EVM_UNIX_SECONDS', value: NOW },
  });
  assert.equal(terms.legEconomics[1]?.grossNotional.atoms, 100_000_000n);
  assert.equal(terms.legEconomics[1]?.marginDelta.atoms, 20_100_000n);
  assert.equal(terms.legEconomics[1]?.venueFee.atoms, 100_000n);
  assert.equal(terms.netPackageOutcomeAtoms, -201_000n);
  assert.equal(terms.quoteNonce, 7n);

  await assert.rejects(
    port.quote({
      documents: documents(101n),
      currentTime: { unit: 'EVM_UNIX_SECONDS', value: NOW },
    }),
    /executable hedge price violates the signed limit/,
  );
});

test('matches quoted atomic prices to WAD prices across asset decimals', () => {
  assert.equal(matchesEvmTreasuryHedgePrice({
    quoteAtoms: 100n,
    baseAtoms: 1_000_000_000_000n,
    fillPriceWad: 100n * 10n ** 18n,
    baseDecimals: 18,
    quoteDecimals: 6,
  }), true);
  assert.equal(matchesEvmTreasuryHedgePrice({
    quoteAtoms: 101n,
    baseAtoms: 1_000_000_000_000n,
    fillPriceWad: 100n * 10n ** 18n,
    baseDecimals: 18,
    quoteDecimals: 6,
  }), false);
});
