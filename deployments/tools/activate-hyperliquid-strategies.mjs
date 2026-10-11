#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const protocol = await import(pathToFileURL(join(repository, 'packages/protocol-types/dist/index.js')).href);
const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    output: { type: 'string' },
  },
});
if (values.source === undefined || values.output === undefined) {
  throw new Error('usage: activate-hyperliquid-strategies.mjs --source <release> --output <directory>');
}

const source = resolve(values.source);
const output = resolve(values.output);
const readProtocol = (path) => protocol.parseProtocolJson(readFileSync(join(source, path), 'utf8'));
const writeProtocol = (path, value) => {
  const target = join(output, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, protocol.stringifyProtocolJson(value));
};
const digest = (label) => createHash('sha256').update(`NARYX/testnet-activation/v1/${label}`).digest('hex');
const hex = (value) => Buffer.from(value).toString('hex');

const runtime = readProtocol('api/hyperliquid-testnet-runtime.json');
const cashQuote = readProtocol('solver/hyperliquid-testnet-quote.json');
const release = JSON.parse(readFileSync(join(source, 'release-records/hyperliquid-testnet.json'), 'utf8'));
const domainManifest = protocol.parseProtocolJson(JSON.stringify(release.domainManifest));
const domain = protocol.domainRef(
  runtime.domain.domainId,
  runtime.domain.domainManifestVersion,
  runtime.domain.domainManifestHash,
);
const baseAsset = protocol.assetRef(
  cashQuote.market.baseAsset.assetId,
  cashQuote.market.baseAsset.assetManifestHash,
  cashQuote.market.baseAsset.decimals,
);
const quoteAsset = protocol.assetRef(
  cashQuote.market.quoteAsset.assetId,
  cashQuote.market.quoteAsset.assetManifestHash,
  cashQuote.market.quoteAsset.decimals,
);
const tradingAccount = runtime.orderContext.tradingAccount;
const spot = Object.freeze({
  adapter: protocol.adapterRef(cashQuote.market.spot.adapter),
  venue: protocol.versionedManifestRef(
    cashQuote.market.spot.venue.subjectId,
    cashQuote.market.spot.venue.manifestVersion,
    cashQuote.market.spot.venue.manifestHash,
  ),
  market: protocol.versionedManifestRef(
    cashQuote.market.spot.market.subjectId,
    cashQuote.market.spot.market.manifestVersion,
    cashQuote.market.spot.market.manifestHash,
  ),
  coin: cashQuote.market.spot.coin,
  assetId: runtime.market.spot.assetId,
  sizeDecimals: cashQuote.market.spot.sizeDecimals,
  maximumPriceDecimals: 8,
  venueClassId: 'hypercore-spot-v1',
  marketKind: 'SPOT',
});
const primary = Object.freeze({
  adapter: protocol.adapterRef(cashQuote.market.perpetual.adapter),
  venue: protocol.versionedManifestRef(
    cashQuote.market.perpetual.venue.subjectId,
    cashQuote.market.perpetual.venue.manifestVersion,
    cashQuote.market.perpetual.venue.manifestHash,
  ),
  market: protocol.versionedManifestRef(
    cashQuote.market.perpetual.market.subjectId,
    cashQuote.market.perpetual.market.manifestVersion,
    cashQuote.market.perpetual.market.manifestHash,
  ),
  coin: 'BTC',
  assetId: 3,
  sizeDecimals: 5,
  maximumPriceDecimals: 6,
  venueClassId: 'hypercore-perpetual-v1',
  marketKind: 'PERPETUAL',
});
const secondary = Object.freeze({
  adapter: cashQuote.market.perpetual.adapter,
  venue: protocol.versionedManifestRef('hypercore-testnet-sekaw', 1, digest('venue/sekaw')),
  market: protocol.versionedManifestRef('sekaw-btc-perpetual', 1, digest('market/sekaw-btc')),
  coin: 'sekaw:BTC',
  assetId: 390000,
  sizeDecimals: 4,
  maximumPriceDecimals: 6,
  venueClassId: 'hypercore-perpetual-v1',
  marketKind: 'PERPETUAL',
});
const definitions = Object.freeze([
  Object.freeze({
    profileId: 'btc-cash-carry-testnet',
    displayName: 'BTC cash and carry',
    templateId: 'cash-and-carry-v1',
    legTypes: ['spot-purchase', 'perp-sale'],
    ratios: [1n, -1n],
    markets: [
      { role: 'spot-purchase', entrySide: 'BUY', nettingFamilies: ['SPOT_SWAP'], binding: spot },
      {
        role: 'perp-sale',
        entrySide: 'SELL',
        nettingFamilies: ['PERP_OPEN', 'PERP_INCREASE', 'PERP_DECREASE', 'PERP_CLOSE'],
        binding: primary,
      },
    ],
  }),
  Object.freeze({
    profileId: 'btc-treasury-hedge-testnet',
    displayName: 'BTC treasury hedge',
    templateId: 'external-inventory-hedge-v1',
    legTypes: ['treasury-hedge'],
    ratios: [-1n],
    nettingFamilies: ['PERP_OPEN', 'PERP_INCREASE', 'PERP_DECREASE', 'PERP_CLOSE'],
    markets: [{ role: 'treasury-hedge', entrySide: 'SELL', binding: primary }],
  }),
  Object.freeze({
    profileId: 'btc-funding-spread-testnet',
    displayName: 'BTC funding spread',
    templateId: 'perpetual-funding-spread-v1',
    legTypes: ['funding-long', 'funding-short'],
    ratios: [1n, -1n],
    nettingFamilies: ['PERP_OPEN', 'PERP_INCREASE', 'PERP_DECREASE', 'PERP_CLOSE'],
    markets: [
      { role: 'funding-long', entrySide: 'BUY', binding: primary },
      { role: 'funding-short', entrySide: 'SELL', binding: secondary },
    ],
  }),
  Object.freeze({
    profileId: 'btc-hedge-migration-testnet',
    displayName: 'BTC hedge migration',
    templateId: 'hedge-migration-v1',
    legTypes: ['source-hedge', 'destination-hedge'],
    ratios: [-1n, -1n],
    nettingFamilies: ['PERP_OPEN', 'PERP_CLOSE'],
    markets: [
      { role: 'source-hedge', entrySide: 'SELL', binding: primary },
      { role: 'destination-hedge', entrySide: 'SELL', binding: secondary },
    ],
  }),
  Object.freeze({
    profileId: 'btc-delta-rebalance-testnet',
    displayName: 'BTC delta-neutral rebalance',
    templateId: 'delta-neutral-rebalance-v1',
    legTypes: ['perp-adjustment'],
    ratios: [-1n],
    nettingFamilies: ['PERP_INCREASE', 'PERP_DECREASE'],
    markets: [{ role: 'perp-adjustment', entrySide: 'SELL', binding: primary }],
  }),
]);

const templateManifests = new Map();
const series = [];
const executionClasses = [];
const matchingPolicies = [];
const profiles = [];
const preparationFiles = [];
const quoteFiles = [];
const graphRecords = [];
const nettingPolicies = new Map();
const nettingPolicyFiles = [];

const record = (kind, ref, template) => protocol.domainRegistryRecord({
  recordVersion: 1,
  environment: 'testnet',
  domain,
  recordKind: kind,
  subjectId: kind === 'ASSET' ? ref.assetId : kind === 'ADAPTER' ? ref.adapterId : ref.subjectId,
  subjectManifestVersion: kind === 'ASSET' ? 1 : kind === 'ADAPTER' ? ref.adapterManifestVersion : ref.manifestVersion,
  subjectManifestHash: kind === 'ASSET' ? ref.assetManifestHash : kind === 'ADAPTER' ? ref.adapterManifestHash : ref.manifestHash,
  registryState: 'ACTIVE',
  riskLimits: [],
  allowedTemplates: [{
    templateId: template.templateId,
    templateVersion: template.templateVersion,
    packageTemplateManifestHash: protocol.packageTemplateManifestHash(template),
  }],
  allowedSettlementClasses: ['BATCHED_IOC_WITH_RECOVERY'],
  activationUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
  activationValue: 1n,
  governanceReference: 'testnet-activation',
});

for (const definition of definitions) {
  const strategyDefinition = protocol.requireStrategyTemplateDefinition(definition.templateId);
  const spotAdapterIds = [...new Set(definition.markets
    .filter((market) => market.binding.marketKind === 'SPOT')
    .map((market) => market.binding.adapter.adapterId))];
  const perpetualAdapterIds = [...new Set(definition.markets
    .filter((market) => market.binding.marketKind === 'PERPETUAL')
    .map((market) => market.binding.adapter.adapterId))];
  const allowedAdapterIds = [...new Set([...spotAdapterIds, ...perpetualAdapterIds])];
  const venueClassIds = [...new Set(definition.markets.map((market) => market.binding.venueClassId))];
  const template = protocol.packageTemplateManifest({
    manifestVersion: 2,
    environment: 'testnet',
    templateId: definition.templateId,
    templateVersion: 1,
    supportedDomains: [domain],
    orderSchemaHash: digest(`${definition.templateId}/order`),
    quoteSchemaHash: digest(`${definition.templateId}/quote`),
    routeSchemaHash: digest(`${definition.templateId}/route`),
    receiptSchemaHash: digest(`${definition.templateId}/receipt`),
    entryCompilerVersion: 1,
    exitCompilerVersion: 1,
    legCount: definition.legTypes.length,
    legTypes: definition.legTypes,
    supportedDirections: ['LONG_SPOT_SHORT_PERP'],
    supportedSettlementClasses: ['BATCHED_IOC_WITH_RECOVERY'],
    allowedSpotAdapterIds: spotAdapterIds,
    allowedPerpAdapterIds: perpetualAdapterIds,
    allowedAdapterIds,
    riskPolicyHash: digest(`${definition.templateId}/risk`),
  });
  templateManifests.set(definition.templateId, template);
  const templateHash = protocol.packageTemplateManifestHash(template);
  const seriesId = `${definition.profileId}-series`;
  const seriesDocument = {
    seriesVersion: 2,
    seriesId,
    templateId: definition.templateId,
    templateVersion: 1,
    templateManifestHash: templateHash,
    underlyingRefs: definition.markets.map(() => baseAsset.assetId),
    quoteAsset: quoteAsset.assetId,
    economicLegRatios: definition.ratios.map((numerator) => ({ numerator, denominator: 1n })),
    instrumentRefs: definition.markets.map((market) => market.binding.market.subjectId),
    quoteComposition: 'LINEAR',
    maturityOrEvaluationWindow: protocol.duration('MILLISECONDS', 86_400_000n),
    quoteConvention: strategyDefinition.quoteConventionId,
    riskClass: strategyDefinition.riskClassId,
    lifecycleConvention: strategyDefinition.lifecycleConventionId,
  };
  const policy = protocol.packageMatchingPolicy({
    matchingPolicyVersion: 1,
    environment: 'testnet',
    executionClassId: `${definition.profileId}-ioc`,
    allocationRule: 'PRICE_TIME',
    directVersusImpliedPriority: 'DIRECT_FIRST',
    selfMatchPolicy: 'CANCEL_INCOMING',
    commonControlAsSelf: true,
    amendmentPriorityRule: 'RETAIN_ON_SIZE_REDUCTION',
    quantityIncrement: 1_000_000n,
    minimumExecutionQuantity: 1_000_000n,
    maximumImplicationDepth: 2,
  });
  const classDocument = {
    executionClassVersion: 1,
    executionClassId: policy.executionClassId,
    seriesId,
    seriesVersion: seriesDocument.seriesVersion,
    seriesManifestHash: protocol.economicStrategySeriesHash(seriesDocument, {
      supportedTemplateIds: definitions.map((value) => value.templateId),
      supportedQuoteConventionIds: definitions.map((value) => protocol.requireStrategyTemplateDefinition(value.templateId).quoteConventionId),
      supportedRiskClassIds: definitions.map((value) => protocol.requireStrategyTemplateDefinition(value.templateId).riskClassId),
      supportedLifecycleConventionIds: definitions.map((value) => protocol.requireStrategyTemplateDefinition(value.templateId).lifecycleConventionId),
    }),
    domains: [domain],
    venueClasses: venueClassIds,
    collateralMode: 'hypercore-omnibus-testnet-v1',
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    firmnessClass: 'firm-testnet-capacity-v1',
    deliveryPolicyHash: digest(`${definition.templateId}/delivery`),
    recoveryPolicyHash: digest(`${definition.templateId}/recovery`),
    matchingPolicyHash: protocol.packageMatchingPolicyHash(policy),
  };
  const classSupport = {
    supportedVenueClassIds: venueClassIds,
    supportedCollateralModeIds: ['hypercore-omnibus-testnet-v1'],
    supportedSettlementClasses: ['BATCHED_IOC_WITH_RECOVERY'],
    supportedFirmnessClassIds: ['firm-testnet-capacity-v1'],
  };
  const executionClassHash = protocol.seriesExecutionClassHash(classDocument, classSupport);
  const nettingPolicy = protocol.nettingPolicyManifest({
    schemaVersion: 1,
    manifestVersion: 1,
    nettingPolicyVersion: 2,
    environment: 'testnet',
    executionClassId: classDocument.executionClassId,
    executionClassVersion: classDocument.executionClassVersion,
    executionClassManifestHash: executionClassHash,
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    allocationRule: 'PRO_RATA_SEQUENCE',
    externalExecutionMode: 'EXACT_NET_ONLY',
    clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
    maximumObligations: 32,
    maximumBatchWindowMilliseconds: 1_000n,
    instruments: definition.markets.flatMap((market) => (market.nettingFamilies ?? definition.nettingFamilies).map((family) => ({
      instrumentId: `${market.role}-${family.toLowerCase().replaceAll('_', '-')}`,
      domain,
      adapter: market.binding.adapter,
      venue: market.binding.venue,
      market: market.binding.market,
      quantityAsset: baseAsset,
      quoteAsset,
      legFamily: family,
      quantityIncrementAtoms: 1_000_000n,
      priceTickQuoteAtoms: 1n,
    }))),
  });
  nettingPolicies.set(definition.profileId, nettingPolicy);
  const nettingPolicyPath = `solver/${definition.profileId}-netting-policy.json`;
  writeProtocol(nettingPolicyPath, nettingPolicy);
  nettingPolicyFiles.push(nettingPolicyPath);
  const activeRecords = [
    record('ASSET', baseAsset, template),
    record('ASSET', quoteAsset, template),
    ...definition.markets.map((market) => record('ADAPTER', market.binding.adapter, template)),
    ...definition.markets.flatMap((market) => [
      record('VENUE', market.binding.venue, template),
      record('MARKET', market.binding.market, template),
    ]),
  ];
  const uniqueRecords = [...new Map(activeRecords.map((value) => [
    `${value.recordKind}:${value.subjectId}:${hex(value.subjectManifestHash)}`,
    value,
  ])).values()];
  graphRecords.push(...uniqueRecords);
  const profile = {
    profileId: definition.profileId,
    displayName: definition.displayName,
    templateId: definition.templateId,
    templateVersion: 1,
    packageTemplateManifestHash: templateHash,
    seriesId,
    seriesVersion: seriesDocument.seriesVersion,
    seriesManifestHash: classDocument.seriesManifestHash,
    executionClassId: classDocument.executionClassId,
    executionClassVersion: classDocument.executionClassVersion,
    executionClassManifestHash: executionClassHash,
    nettingPolicyHash: protocol.nettingPolicyManifestHash(nettingPolicy),
    domain,
    settlementAccount: tradingAccount,
    baseAsset,
    quoteAsset,
    markets: definition.markets.map((market) => ({
      role: market.role,
      entrySide: market.entrySide,
      adapter: market.binding.adapter,
      venue: market.binding.venue,
      market: market.binding.market,
      coin: market.binding.coin,
      assetId: market.binding.assetId,
      sizeDecimals: market.binding.sizeDecimals,
      maximumPriceDecimals: market.binding.maximumPriceDecimals,
    })),
    metricLimits: [],
    bounds: {
      minimumQuantityAtoms: 1_000_000n,
      maximumQuantityAtoms: 10_000_000n,
      maximumEconomicQuantityAtoms: 20_000_000n,
      maximumServiceFeeQuoteAtoms: 0n,
      maximumVenueFeeQuoteAtoms: 1_000_000_000n,
      maximumRecoveryCostQuoteAtoms: 10_000_000_000n,
      maximumAggregateRecoveryLossQuoteAtoms: 20_000_000_000n,
      maximumMarginIncreaseQuoteAtoms: 25_000_000_000n,
      maximumResidualValueQuoteAtoms: 200_000_000n,
      maximumExpiryTtlMs: 300_000n,
    },
  };
  if (definition.templateId !== 'cash-and-carry-v1') profiles.push(profile);
  series.push(seriesDocument);
  executionClasses.push(classDocument);
  matchingPolicies.push(policy);

  const preparation = {
    version: 1,
    environment: 'testnet',
    domain,
    templateManifest: template,
    activeRegistryRecords: uniqueRecords,
    resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 8 }],
    marketBindings: definition.markets.map((market) => ({
      adapter: market.binding.adapter,
      venue: market.binding.venue,
      market: market.binding.market,
      assetId: market.binding.assetId,
      sizeDecimals: market.binding.sizeDecimals,
      maximumPriceDecimals: market.binding.maximumPriceDecimals,
    })),
  };
  const preparationPath = `solver/${definition.profileId}-preparation.json`;
  writeProtocol(preparationPath, preparation);
  preparationFiles.push(preparationPath);

  const quote = structuredClone(cashQuote);
  quote.generalized = {
    laneId: definition.profileId,
    executionClassId: classDocument.executionClassId,
    executionClassVersion: 1,
    executionClassManifestHash: executionClassHash,
    holdingDurationMs: 86_400_000n,
    expectedExitBasisBps: 0n,
    reversalThresholdPpm: 10n,
  };
  quote.market.templateId = definition.templateId;
  quote.market.packageTemplateManifestHash = templateHash;
  quote.market.templateRegistryRecordHash = digest(`${definition.templateId}/registry`);
  quote.market.candidateId = `${definition.profileId}-solver`;
  quote.market.capacityBaseAtoms = 10_000_000n;
  quote.market.maxBookSpreadBps = definition.markets.some((market) => market.binding === secondary) ? 3_000 : 200;
  const spotMarket = definition.markets.find((market) => market.binding.marketKind === 'SPOT');
  const perpetualMarkets = definition.markets.filter((market) => market.binding.marketKind === 'PERPETUAL');
  const quotedPerpetual = perpetualMarkets[0];
  if (quotedPerpetual === undefined) throw new Error(`${definition.profileId} has no perpetual quote market`);
  if (spotMarket !== undefined) {
    quote.market.spot = {
      ...quote.market.spot,
      adapter: spotMarket.binding.adapter,
      venue: spotMarket.binding.venue,
      market: spotMarket.binding.market,
      coin: spotMarket.binding.coin,
      sizeDecimals: spotMarket.binding.sizeDecimals,
    };
  }
  quote.market.perpetual = {
    ...quote.market.perpetual,
    adapter: quotedPerpetual.binding.adapter,
    venue: quotedPerpetual.binding.venue,
    market: quotedPerpetual.binding.market,
    coin: quotedPerpetual.binding.coin,
    sizeDecimals: quotedPerpetual.binding.sizeDecimals,
  };
  if (perpetualMarkets.length === 2) {
    quote.market.counterPerpetual = {
      ...quote.market.perpetual,
      adapter: perpetualMarkets[1].binding.adapter,
      venue: perpetualMarkets[1].binding.venue,
      market: perpetualMarkets[1].binding.market,
      coin: perpetualMarkets[1].binding.coin,
      sizeDecimals: perpetualMarkets[1].binding.sizeDecimals,
      action: { ...quote.market.perpetual.action, legIndex: 1, sequence: 1 },
    };
  }
  const quotePath = `solver/${definition.profileId}-quote.json`;
  writeProtocol(quotePath, quote);
  quoteFiles.push(quotePath);
}

const crossBatchPolicy = protocol.crossBatchClearingPolicy({
  version: 1,
  policyId: 'hypercore-testnet-cross-batch-v1',
  domain,
  adapter: primary.adapter,
  expiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
  maximumSourceIntents: 32,
  maximumSourceBatches: 16,
  maximumExpirySpread: 30_000n,
});
const crossBatchPolicyPath = 'solver/hyperliquid-testnet-cross-batch-policy.json';
writeProtocol(crossBatchPolicyPath, crossBatchPolicy);

const fundingDefinition = definitions.find((value) => value.profileId === 'btc-funding-spread-testnet');
const fundingNettingPolicy = nettingPolicies.get('btc-funding-spread-testnet');
if (fundingDefinition === undefined || fundingNettingPolicy === undefined) {
  throw new Error('funding-spread netting activation is unavailable');
}
const fundingMarkets = new Map(fundingDefinition.markets.map((market) => [market.role, market.binding]));
const fundingResidualPath = 'solver/btc-funding-spread-testnet-netting-residual.json';
writeProtocol(fundingResidualPath, {
  version: 1,
  environment: 'TESTNET',
  policy: fundingNettingPolicy,
  bindings: fundingNettingPolicy.instruments.map((instrument) => {
    const role = instrument.instrumentId.startsWith('funding-long-') ? 'funding-long' : 'funding-short';
    const binding = fundingMarkets.get(role);
    if (binding === undefined) throw new Error(`funding residual binding is missing: ${role}`);
    return {
      instrumentId: instrument.instrumentId,
      marketBinding: {
        adapter: binding.adapter,
        venue: binding.venue,
        market: binding.market,
        assetId: binding.assetId,
        sizeDecimals: binding.sizeDecimals,
        maximumPriceDecimals: binding.maximumPriceDecimals,
      },
      evidenceBinding: {
        assetId: binding.assetId,
        marketKind: 'PERPETUAL',
        baseFeeToken: 'BTC',
        quoteFeeToken: 'USDC',
      },
    };
  }),
});

const seriesSupport = {
  supportedTemplateIds: definitions.map((value) => value.templateId),
  supportedQuoteConventionIds: definitions.map((value) => protocol.requireStrategyTemplateDefinition(value.templateId).quoteConventionId),
  supportedRiskClassIds: definitions.map((value) => protocol.requireStrategyTemplateDefinition(value.templateId).riskClassId),
  supportedLifecycleConventionIds: definitions.map((value) => protocol.requireStrategyTemplateDefinition(value.templateId).lifecycleConventionId),
};
const executionClassSupport = {
  supportedVenueClassIds: [...new Set(definitions.flatMap((definition) =>
    definition.markets.map((market) => market.binding.venueClassId)))],
  supportedCollateralModeIds: ['hypercore-omnibus-testnet-v1'],
  supportedSettlementClasses: ['BATCHED_IOC_WITH_RECOVERY'],
  supportedFirmnessClassIds: ['firm-testnet-capacity-v1'],
};
writeProtocol('api/hyperliquid-native-strategy-order-profiles.json', {
  version: 1,
  environment: 'testnet',
  profiles,
});
writeProtocol('api/hyperliquid-public-market-support.json', {
  version: 1,
  clockUnit: 'UNIX_MILLISECONDS',
  seriesSupport,
  executionClassSupport,
});
writeProtocol('api/hyperliquid-public-market-bootstrap.json', {
  version: 1,
  environment: 'testnet',
  domainManifests: [domainManifest],
  packageTemplateManifests: [...templateManifests.values()],
  matchingPolicies,
  series,
  executionClasses,
  books: executionClasses.map((value) => ({
    executionClassId: value.executionClassId,
    executionClassVersion: value.executionClassVersion,
  })),
});
writeProtocol('api/hyperliquid-public-graph-context.json', {
  version: 1,
  activeRegistryRecords: [...new Map(graphRecords.map((value) => [
    `${value.recordKind}:${value.subjectId}:${hex(value.subjectManifestHash)}:${value.allowedTemplates[0].templateId}`,
    value,
  ])).values()],
  resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 8 }],
});

const combinedPaths = [
  'api/public-market-bootstrap.json',
  'api/public-market-support.json',
  'api/public-graph-context.json',
];
if (combinedPaths.every((path) => existsSync(join(source, path)))) {
  const combinedBootstrap = readProtocol(combinedPaths[0]);
  const combinedSupport = readProtocol(combinedPaths[1]);
  const combinedGraph = readProtocol(combinedPaths[2]);
  const templateIds = new Set(definitions.map((value) => value.templateId));
  const seriesIds = new Set(series.map((value) => value.seriesId));
  const executionClassIds = new Set(executionClasses.map((value) => value.executionClassId));
  const unique = (values) => [...new Set(values)];
  writeProtocol(combinedPaths[0], {
    ...combinedBootstrap,
    domainManifests: [
      ...combinedBootstrap.domainManifests.filter((value) => value.domainId !== domain.domainId),
      domainManifest,
    ],
    packageTemplateManifests: [
      ...combinedBootstrap.packageTemplateManifests.filter((value) => !templateIds.has(value.templateId)),
      ...templateManifests.values(),
    ],
    matchingPolicies: [
      ...combinedBootstrap.matchingPolicies.filter((value) => !executionClassIds.has(value.executionClassId)),
      ...matchingPolicies,
    ],
    series: [...combinedBootstrap.series.filter((value) => !seriesIds.has(value.seriesId)), ...series],
    executionClasses: [
      ...combinedBootstrap.executionClasses.filter((value) => !executionClassIds.has(value.executionClassId)),
      ...executionClasses,
    ],
    books: [
      ...combinedBootstrap.books.filter((value) => !executionClassIds.has(value.executionClassId)),
      ...executionClasses.map((value) => ({
        executionClassId: value.executionClassId,
        executionClassVersion: value.executionClassVersion,
      })),
    ],
  });
  writeProtocol(combinedPaths[1], {
    ...combinedSupport,
    seriesSupport: {
      supportedTemplateIds: unique([
        ...combinedSupport.seriesSupport.supportedTemplateIds,
        ...seriesSupport.supportedTemplateIds,
      ]),
      supportedQuoteConventionIds: unique([
        ...combinedSupport.seriesSupport.supportedQuoteConventionIds,
        ...seriesSupport.supportedQuoteConventionIds,
      ]),
      supportedRiskClassIds: unique([
        ...combinedSupport.seriesSupport.supportedRiskClassIds,
        ...seriesSupport.supportedRiskClassIds,
      ]),
      supportedLifecycleConventionIds: unique([
        ...combinedSupport.seriesSupport.supportedLifecycleConventionIds,
        ...seriesSupport.supportedLifecycleConventionIds,
      ]),
    },
    executionClassSupport: {
      supportedVenueClassIds: unique([
        ...combinedSupport.executionClassSupport.supportedVenueClassIds,
        ...executionClassSupport.supportedVenueClassIds,
      ]),
      supportedCollateralModeIds: unique([
        ...combinedSupport.executionClassSupport.supportedCollateralModeIds,
        ...executionClassSupport.supportedCollateralModeIds,
      ]),
      supportedSettlementClasses: unique([
        ...combinedSupport.executionClassSupport.supportedSettlementClasses,
        ...executionClassSupport.supportedSettlementClasses,
      ]),
      supportedFirmnessClassIds: unique([
        ...combinedSupport.executionClassSupport.supportedFirmnessClassIds,
        ...executionClassSupport.supportedFirmnessClassIds,
      ]),
    },
  });
  writeProtocol(combinedPaths[2], {
    ...combinedGraph,
    activeRegistryRecords: [
      ...combinedGraph.activeRegistryRecords.filter((value) => value.domain.domainId !== domain.domainId),
      ...new Map(graphRecords.map((value) => [
        `${value.recordKind}:${value.subjectId}:${hex(value.subjectManifestHash)}:${value.allowedTemplates[0].templateId}`,
        value,
      ])).values(),
    ],
    resourceLimits: [
      ...combinedGraph.resourceLimits.filter((value) => value.domainId !== domain.domainId),
      { domainId: domain.domainId, maximumActionsPerTransaction: 8 },
    ],
  });
}
writeFileSync(join(output, 'activation.json'), `${JSON.stringify({
  version: 1,
  preparationFiles,
  quoteFiles,
  nettingPolicyFiles,
  crossBatchPolicyFile: crossBatchPolicyPath,
  residualExecutionFile: fundingResidualPath,
  allowedPerpetualCoins: ['BTC', 'sekaw:BTC'],
}, null, 2)}\n`);
