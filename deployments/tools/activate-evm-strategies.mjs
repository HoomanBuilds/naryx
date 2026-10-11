#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const protocol = await import(pathToFileURL(join(repository, 'packages/protocol-types/dist/index.js')).href);
const requireFromApi = createRequire(join(repository, 'services/api/package.json'));
const { createPublicClient, getAddress, http, keccak256 } = requireFromApi('viem');
const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    output: { type: 'string' },
  },
});
if (values.source === undefined || values.output === undefined) {
  throw new Error('usage: activate-evm-strategies.mjs --source <release> --output <directory>');
}

const networkInputs = Object.freeze([
  Object.freeze({
    network: 'base-sepolia',
    chainId: 84_532,
    rpcUrl: process.env.NARYX_BASE_SEPOLIA_RPC_URL,
    solver: process.env.NARYX_BASE_SEPOLIA_SOLVER_ADDRESS,
  }),
  Object.freeze({
    network: 'arbitrum-sepolia',
    chainId: 421_614,
    rpcUrl: process.env.NARYX_ARBITRUM_SEPOLIA_RPC_URL,
    solver: process.env.NARYX_ARBITRUM_SEPOLIA_SOLVER_ADDRESS,
  }),
]);
for (const input of networkInputs) {
  if (input.rpcUrl === undefined || !/^https?:\/\//.test(input.rpcUrl)) {
    throw new Error(`${input.network} RPC URL is missing`);
  }
  if (input.solver === undefined) throw new Error(`${input.network} solver address is missing`);
  getAddress(input.solver);
}

const source = resolve(values.source);
const output = resolve(values.output);
const readProtocol = (path) => protocol.parseProtocolJson(readFileSync(join(source, path), 'utf8'));
const writeProtocol = (path, value) => {
  const target = join(output, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, protocol.stringifyProtocolJson(value));
};
const digest = (label) => createHash('sha256').update(`NARYX/evm-testnet-activation/v1/${label}`).digest();
const hex = (value) => Buffer.from(value).toString('hex');
const contract = async (client, address) => {
  const checked = getAddress(address);
  const code = await client.getCode({ address: checked });
  if (code === undefined || code === '0x') throw new Error(`${checked} has no code`);
  return Object.freeze({ address: checked, expectedCodeHash: keccak256(code) });
};

const optionPoolAbi = Object.freeze([{
  type: 'function', name: 'getPoolSettings', stateMutability: 'view', inputs: [], outputs: [
    { name: 'base', type: 'address' }, { name: 'quote', type: 'address' }, { name: 'oracle', type: 'address' },
    { name: 'strike', type: 'uint256' }, { name: 'maturity', type: 'uint256' }, { name: 'isCall', type: 'bool' },
  ],
}]);
const marketAbi = Object.freeze([{
  type: 'function', name: 'oracle', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}, {
  type: 'function', name: 'expiry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint32' }],
}]);
const accountFactoryAbi = Object.freeze([{
  type: 'function', name: 'accountCodeHash', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }],
}]);

async function inspectNetwork(input) {
  const release = JSON.parse(readFileSync(join(repository, 'deployments/evm', input.network, 'multi-strategy-release.json'), 'utf8'));
  const releaseRecord = readProtocol(`release-records/${input.network}.json`);
  const domainManifest = protocol.domainManifest(release.domainManifest);
  const domainManifestHash = `0x${protocol.toHex(protocol.domainManifestHash(domainManifest))}`;
  if (domainManifest.manifestVersion !== release.domain.manifestVersion
    || domainManifestHash !== release.domain.manifestHash) {
    throw new Error(`${input.network} multi-strategy domain manifest differs from its active reference`);
  }
  const client = createPublicClient({ transport: http(input.rpcUrl) });
  if (await client.getChainId() !== input.chainId) throw new Error(`${input.network} RPC chain differs`);
  const addresses = release.conformance;
  const contracts = release.contracts;
  const [baseToken, quoteToken, lowerPool, upperPool, oracleAddress, perpMarket, nearMarket, farMarket] = await Promise.all([
    contract(client, addresses.baseAsset),
    contract(client, addresses.quoteAsset),
    contract(client, addresses.lowerOptionPool),
    contract(client, addresses.upperOptionPool),
    client.readContract({ address: getAddress(addresses.perpetualMarket), abi: marketAbi, functionName: 'oracle' }),
    contract(client, addresses.perpetualMarket),
    contract(client, addresses.nearFutureMarket),
    contract(client, addresses.farFutureMarket),
  ]);
  const oracle = await contract(client, oracleAddress);
  const [lowerSettings, upperSettings, perpetualExpiry, nearExpiry, farExpiry, accountCodeHash] = await Promise.all([
    client.readContract({ address: lowerPool.address, abi: optionPoolAbi, functionName: 'getPoolSettings' }),
    client.readContract({ address: upperPool.address, abi: optionPoolAbi, functionName: 'getPoolSettings' }),
    client.readContract({ address: perpMarket.address, abi: marketAbi, functionName: 'expiry' }),
    client.readContract({ address: nearMarket.address, abi: marketAbi, functionName: 'expiry' }),
    client.readContract({ address: farMarket.address, abi: marketAbi, functionName: 'expiry' }),
    client.readContract({ address: getAddress(contracts.accountFactory.address), abi: accountFactoryAbi, functionName: 'accountCodeHash' }),
  ]);
  if (getAddress(lowerSettings[0]) !== baseToken.address || getAddress(lowerSettings[1]) !== quoteToken.address
    || getAddress(upperSettings[0]) !== baseToken.address || getAddress(upperSettings[1]) !== quoteToken.address
    || getAddress(lowerSettings[2]) !== oracle.address || getAddress(upperSettings[2]) !== oracle.address
    || lowerSettings[4] !== upperSettings[4] || lowerSettings[3] >= upperSettings[3]
    || lowerSettings[5] !== true || upperSettings[5] !== true || nearExpiry >= farExpiry) {
    throw new Error(`${input.network} conformance market identities differ`);
  }
  const domain = protocol.domainRef(`eip155:${input.chainId}`, release.domain.manifestVersion, release.domain.manifestHash);
  const baseAsset = protocol.assetRef(`asset:naryx-test-base:${input.network}`, digest(`${input.network}/asset/base`), 18);
  const quoteAsset = protocol.assetRef(`asset:naryx-test-usdc:${input.network}`, digest(`${input.network}/asset/quote`), 6);
  const factory = (name) => Object.freeze({
    address: getAddress(contracts[name].address),
    expectedCodeHash: contracts[name].runtimeCodeHash,
  });
  return Object.freeze({
    ...input,
    release,
    releaseRecord,
    domain,
    domainManifest,
    baseAsset,
    quoteAsset,
    baseToken,
    quoteToken,
    oracle,
    lower: Object.freeze({ contract: lowerPool, strike: lowerSettings[3], maturity: lowerSettings[4] }),
    upper: Object.freeze({ contract: upperPool, strike: upperSettings[3], maturity: upperSettings[4] }),
    perp: Object.freeze({ contract: perpMarket, expiry: BigInt(perpetualExpiry) }),
    near: Object.freeze({ contract: nearMarket, expiry: BigInt(nearExpiry) }),
    far: Object.freeze({ contract: farMarket, expiry: BigInt(farExpiry) }),
    accountFactory: factory('accountFactory'),
    accountCodeHash,
    lowerOptionFactory: factory('lowerOptionFactory'),
    upperOptionFactory: factory('upperOptionFactory'),
    inventoryFactory: factory('inventoryFactory'),
    perpetualFactory: factory('perpetualFactory'),
    nearFutureFactory: factory('nearFutureFactory'),
    farFutureFactory: factory('farFutureFactory'),
    feePolicyManifestHash: release.policy.feePolicyManifestHash,
  });
}

const networks = await Promise.all(networkInputs.map(inspectNetwork));
const refs = (network) => Object.freeze({
  optionLong: protocol.adapterRef({ adapterId: `adapter:${network.network}:option-long`, adapterManifestVersion: 1, adapterManifestHash: digest(`${network.network}/adapter/option-long`) }),
  optionShort: protocol.adapterRef({ adapterId: `adapter:${network.network}:option-short`, adapterManifestVersion: 1, adapterManifestHash: digest(`${network.network}/adapter/option-short`) }),
  futureNear: protocol.adapterRef({ adapterId: `adapter:${network.network}:future-near`, adapterManifestVersion: 1, adapterManifestHash: digest(`${network.network}/adapter/future-near`) }),
  futureFar: protocol.adapterRef({ adapterId: `adapter:${network.network}:future-far`, adapterManifestVersion: 1, adapterManifestHash: digest(`${network.network}/adapter/future-far`) }),
  inventory: protocol.adapterRef({ adapterId: `adapter:${network.network}:inventory`, adapterManifestVersion: 1, adapterManifestHash: digest(`${network.network}/adapter/inventory`) }),
  perp: protocol.adapterRef({ adapterId: `adapter:${network.network}:perpetual`, adapterManifestVersion: 1, adapterManifestHash: digest(`${network.network}/adapter/perpetual`) }),
  optionVenue: protocol.versionedManifestRef(`venue:${network.network}:options`, 1, digest(`${network.network}/venue/options`)),
  futureVenue: protocol.versionedManifestRef(`venue:${network.network}:futures`, 1, digest(`${network.network}/venue/futures`)),
  treasuryVenue: protocol.versionedManifestRef(`venue:${network.network}:treasury`, 1, digest(`${network.network}/venue/treasury`)),
  optionLongMarket: protocol.versionedManifestRef(`market:${network.network}:call-lower`, 1, digest(`${network.network}/market/call-lower`)),
  optionShortMarket: protocol.versionedManifestRef(`market:${network.network}:call-upper`, 1, digest(`${network.network}/market/call-upper`)),
  futureNearMarket: protocol.versionedManifestRef(`market:${network.network}:future-near`, 1, digest(`${network.network}/market/future-near`)),
  futureFarMarket: protocol.versionedManifestRef(`market:${network.network}:future-far`, 1, digest(`${network.network}/market/future-far`)),
  inventoryMarket: protocol.versionedManifestRef(`market:${network.network}:inventory`, 1, digest(`${network.network}/market/inventory`)),
  perpMarket: protocol.versionedManifestRef(`market:${network.network}:perpetual`, 1, digest(`${network.network}/market/perpetual`)),
});
const bindings = new Map(networks.map((network) => [network.network, refs(network)]));

const templateSpecifications = Object.freeze([
  Object.freeze({
    templateId: 'option-spread-v1', legTypes: ['option-long', 'option-short'],
    adapters: networks.flatMap((network) => [bindings.get(network.network).optionLong, bindings.get(network.network).optionShort]),
  }),
  Object.freeze({
    templateId: 'calendar-spread-v1', legTypes: ['near-future', 'far-future'],
    adapters: networks.flatMap((network) => [bindings.get(network.network).futureNear, bindings.get(network.network).futureFar]),
  }),
  Object.freeze({
    templateId: 'treasury-inventory-hedge-v1', legTypes: ['inventory-position', 'treasury-hedge'],
    adapters: networks.flatMap((network) => [bindings.get(network.network).inventory, bindings.get(network.network).perp]),
  }),
]);
const templates = new Map(templateSpecifications.map((specification) => {
  const manifest = protocol.packageTemplateManifest({
    manifestVersion: 2,
    environment: 'testnet',
    templateId: specification.templateId,
    templateVersion: 1,
    supportedDomains: networks.map((network) => network.domain),
    orderSchemaHash: digest(`${specification.templateId}/order`),
    quoteSchemaHash: digest(`${specification.templateId}/quote`),
    routeSchemaHash: digest(`${specification.templateId}/route`),
    receiptSchemaHash: digest(`${specification.templateId}/receipt`),
    entryCompilerVersion: 1,
    exitCompilerVersion: 1,
    legCount: 2,
    legTypes: specification.legTypes,
    supportedDirections: ['LONG_SPOT_SHORT_PERP'],
    supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
    allowedSpotAdapterIds: [],
    allowedPerpAdapterIds: specification.adapters.map((adapter) => adapter.adapterId),
    allowedAdapterIds: specification.adapters.map((adapter) => adapter.adapterId),
    riskPolicyHash: digest(`${specification.templateId}/risk`),
  });
  return [specification.templateId, manifest];
}));

const seriesSupport = {
  supportedTemplateIds: templateSpecifications.map((value) => value.templateId),
  supportedQuoteConventionIds: templateSpecifications.map((value) => protocol.requireStrategyTemplateDefinition(value.templateId).quoteConventionId),
  supportedRiskClassIds: templateSpecifications.map((value) => protocol.requireStrategyTemplateDefinition(value.templateId).riskClassId),
  supportedLifecycleConventionIds: templateSpecifications.map((value) => protocol.requireStrategyTemplateDefinition(value.templateId).lifecycleConventionId),
};
const executionClassSupport = {
  supportedVenueClassIds: ['naryx-evm-option-v1', 'naryx-evm-future-v1', 'naryx-evm-treasury-v1'],
  supportedCollateralModeIds: ['evm-user-owned-strategy-account-v1'],
  supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
  supportedFirmnessClassIds: ['factory-validated-testnet-v1'],
};
const profiles = { option: [], calendar: [], treasury: [] };
const runtimes = { option: [], calendar: [], treasury: [] };
const series = [];
const executionClasses = [];
const matchingPolicies = [];
const registryGroups = new Map();

function addRegistry(network, template, kind, ref) {
  const subjectId = kind === 'ASSET' ? ref.assetId : kind === 'ADAPTER' ? ref.adapterId : ref.subjectId;
  const subjectManifestVersion = kind === 'ASSET' ? 1 : kind === 'ADAPTER' ? ref.adapterManifestVersion : ref.manifestVersion;
  const subjectManifestHash = kind === 'ASSET' ? ref.assetManifestHash : kind === 'ADAPTER' ? ref.adapterManifestHash : ref.manifestHash;
  const key = `${network.domain.domainId}:${kind}:${subjectId}:${hex(subjectManifestHash)}`;
  const templateReference = {
    templateId: template.templateId,
    templateVersion: template.templateVersion,
    packageTemplateManifestHash: protocol.packageTemplateManifestHash(template),
  };
  const existing = registryGroups.get(key);
  if (existing !== undefined) {
    existing.allowedTemplates.push(templateReference);
    return;
  }
  registryGroups.set(key, {
    network,
    kind,
    subjectId,
    subjectManifestVersion,
    subjectManifestHash,
    allowedTemplates: [templateReference],
  });
}

function economicDocuments(network, templateId, instrumentRefs, ratios, venueClass, profileId) {
  const definition = protocol.requireStrategyTemplateDefinition(templateId);
  const template = templates.get(templateId);
  const seriesDocument = {
    seriesVersion: 2,
    seriesId: `${profileId}-series`,
    templateId,
    templateVersion: 1,
    templateManifestHash: protocol.packageTemplateManifestHash(template),
    underlyingRefs: instrumentRefs.map(() => network.baseAsset.assetId),
    quoteAsset: network.quoteAsset.assetId,
    economicLegRatios: ratios.map((numerator) => ({ numerator, denominator: 1n })),
    instrumentRefs,
    quoteComposition: 'LINEAR',
    maturityOrEvaluationWindow: protocol.duration('MILLISECONDS', 86_400_000n),
    quoteConvention: definition.quoteConventionId,
    riskClass: definition.riskClassId,
    lifecycleConvention: definition.lifecycleConventionId,
  };
  const matchingPolicy = protocol.packageMatchingPolicy({
    matchingPolicyVersion: 1,
    environment: 'testnet',
    executionClassId: `${profileId}-atomic`,
    allocationRule: 'PRICE_TIME',
    directVersusImpliedPriority: 'DIRECT_FIRST',
    selfMatchPolicy: 'CANCEL_INCOMING',
    commonControlAsSelf: true,
    amendmentPriorityRule: 'RETAIN_ON_SIZE_REDUCTION',
    quantityIncrement: 1_000n,
    minimumExecutionQuantity: 1_000n,
    maximumImplicationDepth: 2,
  });
  const classDocument = {
    executionClassVersion: 1,
    executionClassId: matchingPolicy.executionClassId,
    seriesId: seriesDocument.seriesId,
    seriesVersion: 2,
    seriesManifestHash: protocol.economicStrategySeriesHash(seriesDocument, seriesSupport),
    domains: [network.domain],
    venueClasses: [venueClass],
    collateralMode: 'evm-user-owned-strategy-account-v1',
    settlementClass: 'ATOMIC_POSTCONDITION',
    firmnessClass: 'factory-validated-testnet-v1',
    deliveryPolicyHash: digest(`${profileId}/delivery`),
    recoveryPolicyHash: digest(`${profileId}/recovery`),
    matchingPolicyHash: protocol.packageMatchingPolicyHash(matchingPolicy),
  };
  const executionClassHash = protocol.seriesExecutionClassHash(classDocument, executionClassSupport);
  series.push(seriesDocument);
  executionClasses.push(classDocument);
  matchingPolicies.push(matchingPolicy);
  return Object.freeze({ template, seriesDocument, classDocument, executionClassHash });
}

const support = (domain, adapter, legFamily, supportedSides, materializationClassId) => ({
  domain,
  adapter,
  legFamily,
  supportedSides,
  materializationClassId,
  executionPlanKind: 'EVM_ATOMIC_BATCH',
  supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
});
const commonBounds = Object.freeze({
  minimumQuantityAtoms: 1_000n,
  maximumQuantityAtoms: 1_000_000_000_000_000_000n,
  maximumServiceFeeQuoteAtoms: 0n,
  maximumVenueFeeQuoteAtoms: 100_000_000n,
  maximumNetworkFeeQuoteAtoms: 10_000_000n,
  maximumMarginIncreaseQuoteAtoms: 10_000_000_000n,
  maximumExpiryTtlSeconds: 3_600n,
});

for (const network of networks) {
  const ref = bindings.get(network.network);
  const optionId = `${network.network}-option-spread`;
  const optionDocuments = economicDocuments(
    network,
    'option-spread-v1',
    [ref.optionLongMarket.subjectId, ref.optionShortMarket.subjectId],
    [1n, -1n],
    'naryx-evm-option-v1',
    optionId,
  );
  profiles.option.push({
    profileId: optionId,
    displayName: `${network.network} bull call spread`,
    templateId: 'option-spread-v1',
    templateVersion: 1,
    packageTemplateManifestHash: protocol.packageTemplateManifestHash(optionDocuments.template),
    seriesId: optionDocuments.seriesDocument.seriesId,
    seriesVersion: 2,
    seriesManifestHash: optionDocuments.classDocument.seriesManifestHash,
    executionClassId: optionDocuments.classDocument.executionClassId,
    executionClassVersion: 1,
    executionClassManifestHash: optionDocuments.executionClassHash,
    chainId: network.chainId,
    domain: network.domain,
    accountFactory: network.accountFactory.address.toLowerCase(),
    baseAsset: network.baseAsset,
    quoteAsset: network.quoteAsset,
    markets: [
      { role: 'option-long', adapter: ref.optionLong, venue: ref.optionVenue, market: ref.optionLongMarket, strike: network.lower.strike, maturity: network.lower.maturity },
      { role: 'option-short', adapter: ref.optionShort, venue: ref.optionVenue, market: ref.optionShortMarket, strike: network.upper.strike, maturity: network.upper.maturity },
    ],
    metricLimits: [],
    bounds: commonBounds,
  });

  const calendarId = `${network.network}-calendar-spread`;
  const calendarDocuments = economicDocuments(
    network,
    'calendar-spread-v1',
    [ref.futureNearMarket.subjectId, ref.futureFarMarket.subjectId],
    [1n, -1n],
    'naryx-evm-future-v1',
    calendarId,
  );
  profiles.calendar.push({
    profileId: calendarId,
    displayName: `${network.network} calendar spread`,
    templateId: 'calendar-spread-v1',
    templateVersion: 1,
    packageTemplateManifestHash: protocol.packageTemplateManifestHash(calendarDocuments.template),
    seriesId: calendarDocuments.seriesDocument.seriesId,
    seriesVersion: 2,
    seriesManifestHash: calendarDocuments.classDocument.seriesManifestHash,
    executionClassId: calendarDocuments.classDocument.executionClassId,
    executionClassVersion: 1,
    executionClassManifestHash: calendarDocuments.executionClassHash,
    chainId: network.chainId,
    domain: network.domain,
    accountFactory: network.accountFactory.address.toLowerCase(),
    baseAsset: network.baseAsset,
    quoteAsset: network.quoteAsset,
    markets: [
      { role: 'near-future', adapter: ref.futureNear, venue: ref.futureVenue, market: ref.futureNearMarket, maturity: network.near.expiry },
      { role: 'far-future', adapter: ref.futureFar, venue: ref.futureVenue, market: ref.futureFarMarket, maturity: network.far.expiry },
    ],
    metricLimits: [],
    bounds: commonBounds,
  });

  const treasuryId = `${network.network}-treasury-hedge`;
  const treasuryDocuments = economicDocuments(
    network,
    'treasury-inventory-hedge-v1',
    [ref.inventoryMarket.subjectId, ref.perpMarket.subjectId],
    [1n, -1n],
    'naryx-evm-treasury-v1',
    treasuryId,
  );
  profiles.treasury.push({
    profileId: treasuryId,
    displayName: `${network.network} treasury hedge`,
    templateId: 'treasury-inventory-hedge-v1',
    templateVersion: 1,
    packageTemplateManifestHash: protocol.packageTemplateManifestHash(treasuryDocuments.template),
    seriesId: treasuryDocuments.seriesDocument.seriesId,
    seriesVersion: 2,
    seriesManifestHash: treasuryDocuments.classDocument.seriesManifestHash,
    executionClassId: treasuryDocuments.classDocument.executionClassId,
    executionClassVersion: 1,
    executionClassManifestHash: treasuryDocuments.executionClassHash,
    chainId: network.chainId,
    domain: network.domain,
    accountFactory: network.accountFactory.address.toLowerCase(),
    inventoryAsset: network.baseAsset,
    quoteAsset: network.quoteAsset,
    inventory: { adapter: ref.inventory, venue: ref.treasuryVenue, market: ref.inventoryMarket },
    hedge: { adapter: ref.perp, venue: ref.treasuryVenue, market: ref.perpMarket },
    metricLimits: [],
    bounds: commonBounds,
  });

  const resources = [
    ['ASSET', network.baseAsset], ['ASSET', network.quoteAsset],
    ['ADAPTER', ref.optionLong], ['ADAPTER', ref.optionShort], ['VENUE', ref.optionVenue],
    ['MARKET', ref.optionLongMarket], ['MARKET', ref.optionShortMarket],
    ['ADAPTER', ref.futureNear], ['ADAPTER', ref.futureFar], ['VENUE', ref.futureVenue],
    ['MARKET', ref.futureNearMarket], ['MARKET', ref.futureFarMarket],
    ['ADAPTER', ref.inventory], ['ADAPTER', ref.perp], ['VENUE', ref.treasuryVenue],
    ['MARKET', ref.inventoryMarket], ['MARKET', ref.perpMarket],
  ];
  for (const [kind, resource] of resources) {
    const relevant = kind === 'ASSET'
      ? [...templates.values()]
      : [
          ...(kind === 'ADAPTER' && [ref.optionLong.adapterId, ref.optionShort.adapterId].includes(resource.adapterId)
            || kind === 'VENUE' && resource.subjectId === ref.optionVenue.subjectId
            || kind === 'MARKET' && [ref.optionLongMarket.subjectId, ref.optionShortMarket.subjectId].includes(resource.subjectId)
            ? [templates.get('option-spread-v1')] : []),
          ...(kind === 'ADAPTER' && [ref.futureNear.adapterId, ref.futureFar.adapterId].includes(resource.adapterId)
            || kind === 'VENUE' && resource.subjectId === ref.futureVenue.subjectId
            || kind === 'MARKET' && [ref.futureNearMarket.subjectId, ref.futureFarMarket.subjectId].includes(resource.subjectId)
            ? [templates.get('calendar-spread-v1')] : []),
          ...(kind === 'ADAPTER' && [ref.inventory.adapterId, ref.perp.adapterId].includes(resource.adapterId)
            || kind === 'VENUE' && resource.subjectId === ref.treasuryVenue.subjectId
            || kind === 'MARKET' && [ref.inventoryMarket.subjectId, ref.perpMarket.subjectId].includes(resource.subjectId)
            ? [templates.get('treasury-inventory-hedge-v1')] : []),
        ];
    for (const template of relevant) addRegistry(network, template, kind, resource);
  }

  const recordsFor = (templateId) => [...registryGroups.values()]
    .filter((group) => group.network.network === network.network
      && group.allowedTemplates.some((template) => template.templateId === templateId))
    .map((group) => protocol.domainRegistryRecord({
      recordVersion: 1,
      environment: 'testnet',
      domain: network.domain,
      recordKind: group.kind,
      subjectId: group.subjectId,
      subjectManifestVersion: group.subjectManifestVersion,
      subjectManifestHash: group.subjectManifestHash,
      registryState: 'ACTIVE',
      riskLimits: [],
      allowedTemplates: group.allowedTemplates,
      allowedSettlementClasses: ['ATOMIC_POSTCONDITION'],
      activationUnit: 'EVM_UNIX_SECONDS',
      activationValue: 1n,
      governanceReference: 'testnet-activation',
    }));
  const laneCommon = (documents, templateId, adapterSupport) => ({
    rpcUrl: network.rpcUrl,
    templateManifest: documents.template,
    activeRegistryRecords: recordsFor(templateId),
    resourceLimits: [{ domainId: network.domain.domainId, maximumActionsPerTransaction: 8 }],
    adapterSupport,
    chainId: BigInt(network.chainId),
    domain: network.domain,
    baseAsset: network.baseAsset,
    quoteAsset: network.quoteAsset,
    baseToken: network.baseToken,
    quoteToken: network.quoteToken,
    oracle: network.oracle,
    protocolFeeBps: 0,
    solverFeeBps: 0,
    networkFeeQuoteAtoms: 10_000n,
    feePolicyVersion: 1,
    feePolicyManifestHash: network.feePolicyManifestHash,
    routeTtlSeconds: 90n,
    quoteTtlSeconds: 120n,
    accountFactory: network.accountFactory,
    expectedStrategyAccountCodeHash: network.accountCodeHash,
    solver: network.solver,
    solverId: `${network.network}-multi-strategy-solver`,
    solverCapabilityManifestHash: digest(`${network.network}/${templateId}/solver-capability`),
    executionClassId: documents.classDocument.executionClassId,
    executionClassVersion: 1,
    executionClassManifestHash: documents.executionClassHash,
  });
  runtimes.option.push({
    laneId: optionId,
    ...laneCommon(optionDocuments, 'option-spread-v1', [
      support(network.domain, ref.optionLong, 'OPTION_BUY', ['BUY'], 'naryx.evm.premia-v3-option-exact'),
      support(network.domain, ref.optionLong, 'OPTION_SELL', ['SELL'], 'naryx.evm.premia-v3-option-exact'),
      support(network.domain, ref.optionShort, 'OPTION_MINT', ['SELL'], 'naryx.evm.premia-v3-option-exact'),
      support(network.domain, ref.optionShort, 'OPTION_BUY', ['BUY'], 'naryx.evm.premia-v3-option-exact'),
    ]),
    maximumOracleAgeSeconds: 86_400n,
    pools: [
      { role: 'option-long', adapter: ref.optionLong, venue: ref.optionVenue, market: ref.optionLongMarket, pool: network.lower.contract, expectedStrike: network.lower.strike, expectedMaturity: network.lower.maturity },
      { role: 'option-short', adapter: ref.optionShort, venue: ref.optionVenue, market: ref.optionShortMarket, pool: network.upper.contract, expectedStrike: network.upper.strike, expectedMaturity: network.upper.maturity },
    ],
    strikeDecimals: 18,
    adapters: [
      { role: 'option-long', factory: network.lowerOptionFactory, maximumGasLimit: 800_000n },
      { role: 'option-short', factory: network.upperOptionFactory, maximumGasLimit: 800_000n },
    ],
  });
  runtimes.calendar.push({
    laneId: calendarId,
    ...laneCommon(calendarDocuments, 'calendar-spread-v1', [
      support(network.domain, ref.futureNear, 'FUTURE_OPEN', ['BUY', 'SELL'], 'naryx.evm.future-exact'),
      support(network.domain, ref.futureNear, 'FUTURE_CLOSE', ['BUY', 'SELL'], 'naryx.evm.future-exact'),
      support(network.domain, ref.futureFar, 'FUTURE_OPEN', ['BUY', 'SELL'], 'naryx.evm.future-exact'),
      support(network.domain, ref.futureFar, 'FUTURE_CLOSE', ['BUY', 'SELL'], 'naryx.evm.future-exact'),
    ]),
    markets: [
      { role: 'near-future', adapter: ref.futureNear, venue: ref.futureVenue, market: ref.futureNearMarket, contract: network.near.contract },
      { role: 'far-future', adapter: ref.futureFar, venue: ref.futureVenue, market: ref.futureFarMarket, contract: network.far.contract },
    ],
    adapters: [
      { role: 'near-future', factory: network.nearFutureFactory, maximumGasLimit: 800_000n },
      { role: 'far-future', factory: network.farFutureFactory, maximumGasLimit: 800_000n },
    ],
  });
  const treasuryCommon = laneCommon(treasuryDocuments, 'treasury-inventory-hedge-v1', [
    support(network.domain, ref.inventory, 'INVENTORY_TRANSFER', ['NONE'], 'naryx.evm.inventory-custody-exact'),
    support(network.domain, ref.perp, 'PERP_OPEN', ['SELL'], 'naryx.evm.perp-exact'),
    support(network.domain, ref.perp, 'PERP_INCREASE', ['SELL'], 'naryx.evm.perp-exact'),
    support(network.domain, ref.perp, 'PERP_DECREASE', ['BUY'], 'naryx.evm.perp-exact'),
    support(network.domain, ref.perp, 'PERP_CLOSE', ['BUY'], 'naryx.evm.perp-exact'),
  ]);
  delete treasuryCommon.baseAsset;
  delete treasuryCommon.baseToken;
  runtimes.treasury.push({
    laneId: treasuryId,
    ...treasuryCommon,
    inventoryAsset: network.baseAsset,
    inventoryToken: network.baseToken,
    market: network.perp.contract,
    inventory: { adapter: ref.inventory, venue: ref.treasuryVenue, market: ref.inventoryMarket },
    hedge: { adapter: ref.perp, venue: ref.treasuryVenue, market: ref.perpMarket },
    adapters: [
      { role: 'inventory-position', factory: network.inventoryFactory, maximumGasLimit: 500_000n },
      { role: 'treasury-hedge', factory: network.perpetualFactory, maximumGasLimit: 800_000n },
    ],
  });
}

const activeRegistryRecords = [...registryGroups.values()].map((group) => protocol.domainRegistryRecord({
  recordVersion: 1,
  environment: 'testnet',
  domain: group.network.domain,
  recordKind: group.kind,
  subjectId: group.subjectId,
  subjectManifestVersion: group.subjectManifestVersion,
  subjectManifestHash: group.subjectManifestHash,
  registryState: 'ACTIVE',
  riskLimits: [],
  allowedTemplates: group.allowedTemplates,
  allowedSettlementClasses: ['ATOMIC_POSTCONDITION'],
  activationUnit: 'EVM_UNIX_SECONDS',
  activationValue: 1n,
  governanceReference: 'testnet-activation',
}));

writeProtocol('api/evm-option-spread-order-profiles.json', { version: 1, environment: 'testnet', profiles: profiles.option });
writeProtocol('api/evm-calendar-spread-order-profiles.json', { version: 1, environment: 'testnet', profiles: profiles.calendar });
writeProtocol('api/evm-treasury-hedge-order-profiles.json', { version: 1, environment: 'testnet', profiles: profiles.treasury });
writeProtocol('solver/evm-option-spread-runtime.json', { version: 1, environment: 'testnet', rpcUrl: networks[0].rpcUrl, lanes: runtimes.option });
writeProtocol('solver/evm-calendar-spread-runtime.json', { version: 1, environment: 'testnet', rpcUrl: networks[0].rpcUrl, lanes: runtimes.calendar });
writeProtocol('solver/evm-treasury-hedge-runtime.json', { version: 1, environment: 'testnet', rpcUrl: networks[0].rpcUrl, lanes: runtimes.treasury });

const bootstrap = readProtocol('api/hyperliquid-public-market-bootstrap.json');
const marketSupport = readProtocol('api/hyperliquid-public-market-support.json');
const graphContext = readProtocol('api/hyperliquid-public-graph-context.json');
writeProtocol('api/public-market-bootstrap.json', {
  ...bootstrap,
  domainManifests: [...bootstrap.domainManifests, ...networks.map((network) => network.domainManifest)],
  packageTemplateManifests: [...bootstrap.packageTemplateManifests, ...templates.values()],
  matchingPolicies: [...bootstrap.matchingPolicies, ...matchingPolicies],
  series: [...bootstrap.series, ...series],
  executionClasses: [...bootstrap.executionClasses, ...executionClasses],
  books: [...bootstrap.books, ...executionClasses.map((value) => ({
    executionClassId: value.executionClassId,
    executionClassVersion: value.executionClassVersion,
  }))],
});
writeProtocol('api/public-market-support.json', {
  ...marketSupport,
  seriesSupport: {
    supportedTemplateIds: [...new Set([...marketSupport.seriesSupport.supportedTemplateIds, ...seriesSupport.supportedTemplateIds])],
    supportedQuoteConventionIds: [...new Set([...marketSupport.seriesSupport.supportedQuoteConventionIds, ...seriesSupport.supportedQuoteConventionIds])],
    supportedRiskClassIds: [...new Set([...marketSupport.seriesSupport.supportedRiskClassIds, ...seriesSupport.supportedRiskClassIds])],
    supportedLifecycleConventionIds: [...new Set([...marketSupport.seriesSupport.supportedLifecycleConventionIds, ...seriesSupport.supportedLifecycleConventionIds])],
  },
  executionClassSupport: {
    supportedVenueClassIds: [...new Set([...marketSupport.executionClassSupport.supportedVenueClassIds, ...executionClassSupport.supportedVenueClassIds])],
    supportedCollateralModeIds: [...new Set([...marketSupport.executionClassSupport.supportedCollateralModeIds, ...executionClassSupport.supportedCollateralModeIds])],
    supportedSettlementClasses: [...new Set([...marketSupport.executionClassSupport.supportedSettlementClasses, ...executionClassSupport.supportedSettlementClasses])],
    supportedFirmnessClassIds: [...new Set([...marketSupport.executionClassSupport.supportedFirmnessClassIds, ...executionClassSupport.supportedFirmnessClassIds])],
  },
});
writeProtocol('api/public-graph-context.json', {
  ...graphContext,
  activeRegistryRecords: [...graphContext.activeRegistryRecords, ...activeRegistryRecords],
  resourceLimits: [
    ...graphContext.resourceLimits,
    ...networks.map((network) => ({ domainId: network.domain.domainId, maximumActionsPerTransaction: 8 })),
  ],
});
writeFileSync(join(output, 'evm-activation.json'), `${JSON.stringify({
  version: 1,
  profiles: Object.fromEntries(Object.entries(profiles).map(([key, value]) => [key, value.length])),
  quoteLanes: Object.fromEntries(Object.entries(runtimes).map(([key, value]) => [key, value.length])),
}, null, 2)}\n`);
