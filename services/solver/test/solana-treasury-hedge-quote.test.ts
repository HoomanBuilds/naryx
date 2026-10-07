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
import { PublicKey } from '@solana/web3.js';
import {
  createSolanaTreasuryHedgeGeneralizedPricing,
  type SolanaTreasuryHedgePricingInput,
  type StoredStrategyPackageOrderDocuments,
} from '../src/index.js';
import type { TestPerpMarketState } from '../src/solana-devnet-wire.js';

const hash = (byte: string) => byte.repeat(64);
const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const SLOT = 1_000n;
const QUANTITY = 2_000_000_000n;
const INVENTORY_MINT = key(1);
const QUOTE_MINT = key(2);
const MARKET_ADDRESS = key(3);
const ORACLE_ADDRESS = key(4);

const domain = domainRef('svm:devnet', 1, hash('1'));
const inventoryAsset = assetRef(INVENTORY_MINT, hash('2'), 9);
const quoteAsset = assetRef(QUOTE_MINT, hash('3'), 6);
const inventoryAdapter = adapterRef({
  adapterId: 'solana-inventory-position',
  adapterManifestVersion: 1,
  adapterManifestHash: hash('4'),
});
const hedgeAdapter = adapterRef({
  adapterId: 'solana-treasury-hedge',
  adapterManifestVersion: 1,
  adapterManifestHash: hash('5'),
});
const venue = versionedManifestRef('naryx-solana-conformance', 1, hash('6'));
const inventoryMarket = versionedManifestRef('sol-inventory', 1, hash('7'));
const hedgeMarket = versionedManifestRef('sol-test-perpetual', 1, hash('8'));
const market: TestPerpMarketState = Object.freeze({
  oracle: ORACLE_ADDRESS,
  feedIdHex: hash('9'),
  collateralMint: QUOTE_MINT,
  collateralVault: key(5),
  feeVault: key(6),
  insuranceVault: key(7),
  collateralDecimals: 6,
  baseDecimals: 9,
  maxPriceAgeSeconds: 60,
  maxConfidenceBps: 50,
  takerFeeBps: 5,
  halfSpreadBps: 2,
  impactBpsPerUnit: 1,
  maxSlippageBps: 100,
  initialMarginBps: 1_000,
  maintenanceMarginBps: 500,
  impactUnitLots: 10_000n,
  baseLotAtoms: 1_000_000n,
  quoteTickAtomsPerBaseLot: 1n,
  maxPositionLots: 1_000_000n,
  pauseOpens: false,
});

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function documents(
  limitQuoteAtoms: bigint,
  lifecycleAction: 'ENTRY' | 'EXIT' = 'ENTRY',
): StoredStrategyPackageOrderDocuments {
  const priceDivisor = gcd(limitQuoteAtoms, 1_000_000n);
  const opening = lifecycleAction === 'ENTRY';
  const inventoryLeg = {
    legId: 'inventory-position',
    legFamily: 'INVENTORY_TRANSFER' as const,
    legTypeId: 'inventory-position',
    domain,
    adapter: inventoryAdapter,
    venue,
    market: inventoryMarket,
    assets: [inventoryAsset, quoteAsset],
    side: 'NONE' as const,
    quantityAsset: inventoryAsset,
    quantityAtoms: QUANTITY,
    minimumQuantityAtoms: QUANTITY,
    maximumFeeQuoteAtoms: 0n,
    preconditionHashes: [],
    postconditionHashes: [],
    timeInForce: 'IOC' as const,
    legExpiryValue: 1_200n,
  };
  const hedgeLeg = {
    legId: 'treasury-hedge',
    legFamily: opening ? 'PERP_OPEN' as const : 'PERP_CLOSE' as const,
    legTypeId: 'treasury-hedge',
    domain,
    adapter: hedgeAdapter,
    venue,
    market: hedgeMarket,
    assets: [inventoryAsset, quoteAsset],
    side: opening ? 'SELL' as const : 'BUY' as const,
    quantityAsset: inventoryAsset,
    quantityAtoms: QUANTITY,
    minimumQuantityAtoms: QUANTITY,
    limitPrice: {
      baseAsset: inventoryAsset,
      quoteAsset,
      quoteAtoms: limitQuoteAtoms / priceDivisor,
      baseAtoms: 1_000_000n / priceDivisor,
      roundingDirection: opening ? 'CEIL' as const : 'FLOOR' as const,
    },
    maximumFeeQuoteAtoms: 200_000n,
    preconditionHashes: [],
    postconditionHashes: [],
    timeInForce: 'IOC' as const,
    legExpiryValue: 1_200n,
  };
  const legs = opening ? [inventoryLeg, hedgeLeg] : [hedgeLeg, inventoryLeg];
  const graph = packageGraph({
    graphVersion: 1,
    environment: 'devnet',
    templateId: 'treasury-inventory-hedge-v1',
    templateVersion: 1,
    packageTemplateManifestHash: hash('a'),
    seriesId: 'sol-treasury-hedge',
    seriesVersion: 1,
    seriesManifestHash: hash('b'),
    executionClassId: 'solana-atomic-treasury-hedge',
    executionClassVersion: 1,
    executionClassManifestHash: hash('c'),
    lifecycleAction,
    owner: key(8),
    strategyAccountRefs: [key(9)],
    legs,
    dependencyEdges: [opening
      ? { fromLegId: 'inventory-position', toLegId: 'treasury-hedge' }
      : { fromLegId: 'treasury-hedge', toLegId: 'inventory-position' }],
    executionGroups: [{ groupId: 'treasury-hedge', kind: 'ALL_OR_NONE', legIds: legs.map((leg) => leg.legId) }],
    settlementClass: 'ATOMIC_POSTCONDITION',
    policyHashes: {
      netting: hash('1'), privacy: hash('2'), solver: hash('3'), delivery: hash('4'),
      resource: hash('5'), portfolioRiskLimits: hash('6'),
    },
    recoverySlots: [],
    maximumRecoveryCostQuoteAtoms: 0n,
    expiryUnit: 'SOLANA_SLOT',
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
    settlementAccount: key(9),
    lifecycleAction,
    settlementClass: 'ATOMIC_POSTCONDITION',
    packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'IOC',
    economicQuantity: assetAmount(inventoryAsset, QUANTITY),
    quoteAsset,
    metricLimits: [],
    maximumServiceFeesByAsset: [{ asset: quoteAsset, maxAtoms: 400_000n }],
    maximumVenueFeesByAsset: [{ asset: quoteAsset, maxAtoms: 200_000n }],
    maximumNetworkFeesByAsset: [{ asset: quoteAsset, maxAtoms: 1_000n }],
    maximumRecoveryCostByAsset: [],
    maximumMarginIncrease: assetAmount(quoteAsset, opening ? 31_000_000n : 0n),
    maximumResidualValue: assetAmount(quoteAsset, 0n),
    ...(opening ? {} : { expectedStrategyStateHash: hash('e') }),
    expiryUnit: 'SOLANA_SLOT',
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

function pricing(): SolanaTreasuryHedgePricingInput {
  return {
    domain,
    inventoryAsset,
    quoteAsset,
    inventoryMint: INVENTORY_MINT,
    quoteMint: QUOTE_MINT,
    marketAddress: MARKET_ADDRESS,
    oracleAddress: ORACLE_ADDRESS,
    inventory: { adapter: inventoryAdapter, venue, market: inventoryMarket },
    hedge: { adapter: hedgeAdapter, venue, market: hedgeMarket },
    protocolFeeBps: 5,
    solverFeeBps: 5,
    networkFeeQuoteAtoms: 1_000n,
    feePolicyVersion: 1,
    feePolicyManifestHash: hash('d'),
    routeTtlSlots: 30n,
    quoteTtlSlots: 60n,
    maximumStateAdvanceSlots: 2n,
    readState: async () => ({
      slot: SLOT,
      marketAddress: MARKET_ADDRESS,
      market,
      oraclePricePerLot: 150_000n,
    }),
    nonceSource: { nextNonce: () => 7n },
  };
}

test('prices an exact Solana treasury hedge and enforces the signed sell limit', async () => {
  const port = createSolanaTreasuryHedgeGeneralizedPricing(pricing());
  const terms = await port.quote({
    documents: documents(149_900n),
    currentTime: { unit: 'SOLANA_SLOT', value: SLOT },
  });
  assert.equal(terms.legEconomics[1]?.grossNotional.atoms, 299_910_000n);
  assert.equal(terms.legEconomics[1]?.marginDelta.atoms, 30_149_955n);
  assert.equal(terms.legEconomics[1]?.venueFee.atoms, 149_955n);
  assert.equal(terms.netPackageOutcomeAtoms, -540_865n);
  assert.equal(terms.quoteNonce, 7n);

  await assert.rejects(
    port.quote({
      documents: documents(150_000n),
      currentTime: { unit: 'SOLANA_SLOT', value: SLOT },
    }),
    /executable hedge price violates the signed limit/,
  );
});

test('prices an exact Solana treasury hedge exit without new margin', async () => {
  const terms = await createSolanaTreasuryHedgeGeneralizedPricing(pricing()).quote({
    documents: documents(150_100n, 'EXIT'),
    currentTime: { unit: 'SOLANA_SLOT', value: SLOT },
  });
  assert.equal(terms.legEconomics[1]?.legId, 'treasury-hedge');
  assert.equal(terms.legEconomics[1]?.grossNotional.atoms, 300_090_000n);
  assert.equal(terms.legEconomics[1]?.marginDelta.atoms, 0n);
  assert.equal(terms.legEconomics[1]?.venueFee.atoms, 150_045n);
  assert.equal(terms.netPackageOutcomeAtoms, -541_135n);
});
