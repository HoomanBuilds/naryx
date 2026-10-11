#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const protocol = await import(pathToFileURL(join(repository, 'packages/protocol-types/dist/index.js')).href);
const requireFromSolver = createRequire(join(repository, 'services/solver/package.json'));
const { Connection, PublicKey } = requireFromSolver('@solana/web3.js');
const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' } } });
if (values.source === undefined || values.output === undefined) {
  throw new Error('usage: activate-solana-strategies.mjs --source <release> --output <directory>');
}
const rpcUrl = process.env.NARYX_SOLANA_DEVNET_RPC_URL;
if (rpcUrl === undefined || !/^https?:\/\//.test(rpcUrl)) throw new Error('Solana Devnet RPC URL is missing');

const source = resolve(values.source);
const output = resolve(values.output);
const readProtocol = (path) => protocol.parseProtocolJson(readFileSync(join(source, path), 'utf8'));
const writeProtocol = (path, value) => {
  const target = join(output, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, protocol.stringifyProtocolJson(value));
};
const digest = (label) => createHash('sha256').update(`NARYX/evm-testnet-activation/v1/${label}`).digest();
const resourceSubjectId = (kind, id) => createHash('sha256')
  .update('NARYX/solana-devnet/resource-subject/v1', 'ascii')
  .update(kind, 'ascii')
  .update(Buffer.of(0))
  .update(id, 'ascii')
  .digest();
const bytes = (value) => Buffer.from(value, 'hex');

const release = JSON.parse(readFileSync(join(repository, 'deployments/solana/devnet/multi-strategy-release.json'), 'utf8'));
const releaseRecord = readProtocol('release-records/solana-devnet.json');
const legacyRuntime = readProtocol('api/solana-devnet-runtime.json');
const legacyOrderContext = readProtocol('api/solana-devnet-order-context.json');
const legacySolver = readProtocol('solver/solana-devnet-solver.json');
const bootstrap = readProtocol('api/public-market-bootstrap.json');
const marketSupport = readProtocol('api/public-market-support.json');
const graphContext = readProtocol('api/public-graph-context.json');
const domainManifest = protocol.domainManifest(releaseRecord.domainManifest);
const domain = protocol.domainRef(
  domainManifest.domainId,
  domainManifest.manifestVersion,
  protocol.domainManifestHash(domainManifest),
);
const inventoryAsset = protocol.assetRef(
  legacySolver.resources.baseAsset.subjectAddress,
  legacySolver.resources.baseAsset.manifestHash,
  9,
);
const quoteAsset = protocol.assetRef(
  release.testUsdcMint,
  legacySolver.resources.quoteAsset.manifestHash,
  6,
);
const inventoryAdapter = protocol.adapterRef({
  adapterId: 'adapter:solana-devnet:inventory',
  adapterManifestVersion: 1,
  adapterManifestHash: digest('solana-devnet/adapter/inventory'),
});
const hedgeAdapter = protocol.adapterRef({
  adapterId: 'adapter:solana-devnet:perpetual',
  adapterManifestVersion: 1,
  adapterManifestHash: digest('solana-devnet/adapter/perpetual'),
});
const template = bootstrap.packageTemplateManifests.find((value) =>
  value.templateId === 'treasury-inventory-hedge-v1'
  && value.supportedDomains.some((candidate) => candidate.domainId === domain.domainId));
if (template === undefined) throw new Error('combined treasury hedge template does not support Solana Devnet');
const templateHash = protocol.packageTemplateManifestHash(template);
const venue = protocol.versionedManifestRef('venue:solana-devnet:treasury', 1, digest('solana-devnet/venue/treasury'));
const inventoryMarket = protocol.versionedManifestRef('market:solana-devnet:inventory', 1, digest('solana-devnet/market/inventory'));
const hedgeMarket = protocol.versionedManifestRef('market:solana-devnet:perpetual', 1, digest('solana-devnet/market/perpetual'));
const definition = protocol.requireStrategyTemplateDefinition('treasury-inventory-hedge-v1');
const series = {
  seriesVersion: 2,
  seriesId: 'solana-devnet-treasury-hedge-series',
  templateId: 'treasury-inventory-hedge-v1',
  templateVersion: 1,
  templateManifestHash: templateHash,
  underlyingRefs: [inventoryAsset.assetId, inventoryAsset.assetId],
  quoteAsset: quoteAsset.assetId,
  economicLegRatios: [{ numerator: 1n, denominator: 1n }, { numerator: -1n, denominator: 1n }],
  instrumentRefs: [inventoryMarket.subjectId, hedgeMarket.subjectId],
  quoteComposition: 'LINEAR',
  maturityOrEvaluationWindow: protocol.duration('MILLISECONDS', 86_400_000n),
  quoteConvention: definition.quoteConventionId,
  riskClass: definition.riskClassId,
  lifecycleConvention: definition.lifecycleConventionId,
};
const seriesSupport = {
  supportedTemplateIds: [...new Set([...marketSupport.seriesSupport.supportedTemplateIds, 'treasury-inventory-hedge-v1'])],
  supportedQuoteConventionIds: [...new Set([...marketSupport.seriesSupport.supportedQuoteConventionIds, definition.quoteConventionId])],
  supportedRiskClassIds: [...new Set([...marketSupport.seriesSupport.supportedRiskClassIds, definition.riskClassId])],
  supportedLifecycleConventionIds: [...new Set([...marketSupport.seriesSupport.supportedLifecycleConventionIds, definition.lifecycleConventionId])],
};
const matchingPolicy = protocol.packageMatchingPolicy({
  matchingPolicyVersion: 1,
  environment: 'testnet',
  executionClassId: 'solana-devnet-treasury-hedge-atomic',
  allocationRule: 'PRICE_TIME',
  directVersusImpliedPriority: 'DIRECT_FIRST',
  selfMatchPolicy: 'CANCEL_INCOMING',
  commonControlAsSelf: true,
  amendmentPriorityRule: 'RETAIN_ON_SIZE_REDUCTION',
  quantityIncrement: 1_000_000n,
  minimumExecutionQuantity: 1_000_000n,
  maximumImplicationDepth: 2,
});
const executionClassSupport = {
  supportedVenueClassIds: [...new Set([...marketSupport.executionClassSupport.supportedVenueClassIds, 'naryx-solana-treasury-v1'])],
  supportedCollateralModeIds: [...new Set([...marketSupport.executionClassSupport.supportedCollateralModeIds, 'solana-user-owned-strategy-account-v1'])],
  supportedSettlementClasses: [...new Set([...marketSupport.executionClassSupport.supportedSettlementClasses, 'ATOMIC_POSTCONDITION'])],
  supportedFirmnessClassIds: [...new Set([...marketSupport.executionClassSupport.supportedFirmnessClassIds, 'program-validated-devnet-v1'])],
};
const seriesManifestHash = protocol.economicStrategySeriesHash(series, seriesSupport);
const executionClass = {
  executionClassVersion: 1,
  executionClassId: matchingPolicy.executionClassId,
  seriesId: series.seriesId,
  seriesVersion: 2,
  seriesManifestHash,
  domains: [domain],
  venueClasses: ['naryx-solana-treasury-v1'],
  collateralMode: 'solana-user-owned-strategy-account-v1',
  settlementClass: 'ATOMIC_POSTCONDITION',
  firmnessClass: 'program-validated-devnet-v1',
  deliveryPolicyHash: digest('solana-devnet/treasury-hedge/delivery'),
  recoveryPolicyHash: digest('solana-devnet/treasury-hedge/recovery'),
  matchingPolicyHash: protocol.packageMatchingPolicyHash(matchingPolicy),
};
const executionClassManifestHash = protocol.seriesExecutionClassHash(executionClass, executionClassSupport);
const templateReference = {
  templateId: template.templateId,
  templateVersion: template.templateVersion,
  packageTemplateManifestHash: templateHash,
};
const resources = [
  ['ASSET', inventoryAsset.assetId, 1, inventoryAsset.assetManifestHash],
  ['ASSET', quoteAsset.assetId, 1, quoteAsset.assetManifestHash],
  ['ADAPTER', inventoryAdapter.adapterId, 1, inventoryAdapter.adapterManifestHash],
  ['ADAPTER', hedgeAdapter.adapterId, 1, hedgeAdapter.adapterManifestHash],
  ['VENUE', venue.subjectId, venue.manifestVersion, venue.manifestHash],
  ['MARKET', inventoryMarket.subjectId, inventoryMarket.manifestVersion, inventoryMarket.manifestHash],
  ['MARKET', hedgeMarket.subjectId, hedgeMarket.manifestVersion, hedgeMarket.manifestHash],
];
const activeRegistryRecords = resources.map(([recordKind, subjectId, subjectManifestVersion, subjectManifestHash]) =>
  protocol.domainRegistryRecord({
    recordVersion: 1,
    environment: 'testnet',
    domain,
    recordKind,
    subjectId,
    subjectManifestVersion,
    subjectManifestHash,
    registryState: 'ACTIVE',
    riskLimits: [],
    allowedTemplates: [templateReference],
    allowedSettlementClasses: ['ATOMIC_POSTCONDITION'],
    activationUnit: 'SOLANA_SLOT',
    activationValue: 1n,
    governanceReference: 'solana-devnet-multi-strategy-release-v1',
  }));
const adapterSupport = [
  ['INVENTORY_TRANSFER', inventoryAdapter, ['NONE'], 'naryx.solana.inventory-transfer'],
  ['PERP_OPEN', hedgeAdapter, ['SELL'], 'naryx.solana.perp-exact'],
  ['PERP_INCREASE', hedgeAdapter, ['SELL'], 'naryx.solana.perp-exact'],
  ['PERP_DECREASE', hedgeAdapter, ['BUY'], 'naryx.solana.perp-exact'],
  ['PERP_CLOSE', hedgeAdapter, ['BUY'], 'naryx.solana.perp-exact'],
].map(([legFamily, adapter, supportedSides, materializationClassId]) => ({
  domain,
  adapter,
  legFamily,
  supportedSides,
  materializationClassId,
  executionPlanKind: 'SVM_ATOMIC_CPI',
  supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
}));

const connection = new Connection(rpcUrl, 'finalized');
if (await connection.getGenesisHash() !== release.genesisHash) throw new Error('Solana RPC is not Devnet');
const lookupAddress = new PublicKey(release.lookupTable.address);
const lookup = await connection.getAddressLookupTable(lookupAddress, { commitment: 'finalized' });
if (lookup.value === null || lookup.value.state.addresses.length !== release.lookupTable.addressCount) {
  throw new Error('Solana lookup table differs from the active release');
}
const lookupTables = [{
  address: lookupAddress.toBase58(),
  expectedAddresses: lookup.value.state.addresses.map((address) => address.toBase58()),
}];
const programRecord = (name) => {
  const value = releaseRecord.programs[name];
  if (value === undefined) throw new Error(`Solana release program ${name} is missing`);
  return value;
};
const profile = {
  profileId: 'solana-devnet-treasury-hedge',
  displayName: 'Solana Devnet treasury hedge',
  templateId: 'treasury-inventory-hedge-v1',
  templateVersion: 1,
  packageTemplateManifestHash: templateHash,
  seriesId: series.seriesId,
  seriesVersion: 2,
  seriesManifestHash,
  executionClassId: executionClass.executionClassId,
  executionClassVersion: 1,
  executionClassManifestHash,
  domain,
  multiStrategyProgramId: release.programs.multiStrategy.programId,
  inventoryAsset,
  quoteAsset,
  inventory: { adapter: inventoryAdapter, venue, market: inventoryMarket },
  hedge: { adapter: hedgeAdapter, venue, market: hedgeMarket },
  metricLimits: [],
  bounds: {
    minimumQuantityAtoms: 1_000_000n,
    maximumQuantityAtoms: 10_000_000_000n,
    maximumServiceFeeQuoteAtoms: 0n,
    maximumVenueFeeQuoteAtoms: 10_000_000n,
    maximumNetworkFeeQuoteAtoms: 1_000_000n,
    maximumMarginIncreaseQuoteAtoms: 5_000_000_000n,
    maximumExpiryTtlSlots: 3_000n,
  },
};
const lane = {
  laneId: profile.profileId,
  templateManifest: template,
  activeRegistryRecords,
  resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 8 }],
  adapterSupport,
  domain,
  inventoryAsset,
  quoteAsset,
  inventoryMint: inventoryAsset.assetId,
  quoteMint: quoteAsset.assetId,
  marketAddress: legacyRuntime.testPerp.market,
  oracleAddress: legacyRuntime.testPerp.oracle,
  testPerpProgramId: release.programs.testPerp.programId,
  inventory: profile.inventory,
  hedge: profile.hedge,
  protocolFeeBps: 0,
  solverFeeBps: 0,
  networkFeeQuoteAtoms: 10_000n,
  feePolicyVersion: legacySolver.feePolicyVersion,
  feePolicyManifestHash: legacySolver.feePolicyManifestHash,
  routeTtlSlots: 300n,
  quoteTtlSlots: 300n,
  maximumStateAdvanceSlots: 150n,
  coreProgramId: release.programs.core.programId,
  multiStrategyProgramId: release.programs.multiStrategy.programId,
  settlementManifestHash: legacySolver.series.settlementClassIdentityHash,
  solver: legacySolver.solverId,
  protocolFeeRecipient: release.upgradeAuthority,
  quoteAssetSubjectId: resourceSubjectId('ASSET', quoteAsset.assetId),
  adapters: [{
    role: 'inventory-position',
    programId: release.programs.inventoryAdapter.programId,
    programDataAddress: release.programs.inventoryAdapter.programDataAddress,
    expectedProgramDataHash: bytes(programRecord('inventory_adapter').programDataHeaderIdentity),
    adapterSubjectId: resourceSubjectId('ADAPTER', inventoryAdapter.adapterId),
    maximumComputeUnitLimit: 400_000,
  }, {
    role: 'treasury-hedge',
    programId: release.programs.testPerpAdapter.programId,
    programDataAddress: release.programs.testPerpAdapter.programDataAddress,
    expectedProgramDataHash: bytes(programRecord('perp_adapter').programDataHeaderIdentity),
    adapterSubjectId: resourceSubjectId('ADAPTER', hedgeAdapter.adapterId),
    maximumComputeUnitLimit: 600_000,
  }],
  testPerpStrategyId: bytes(legacyRuntime.testPerp.strategyIdHex),
  testPerpMaximumBaseLots: legacyOrderContext.strategyMaxBaseLots,
  maximumTransactionComputeUnits: 1_260_000,
  lookupTables,
  executionClassId: executionClass.executionClassId,
  executionClassVersion: 1,
  executionClassManifestHash,
  solverId: 'solana-devnet-multi-strategy-solver',
  solverCapabilityManifestHash: digest('solana-devnet/treasury-hedge/solver-capability'),
};

writeProtocol('api/solana-treasury-hedge-order-profiles.json', { version: 1, environment: 'testnet', profiles: [profile] });
writeProtocol('solver/solana-treasury-hedge-runtime.json', { version: 1, environment: 'testnet', rpcUrl, lanes: [lane] });
writeProtocol('api/public-market-bootstrap.json', {
  ...bootstrap,
  matchingPolicies: [...bootstrap.matchingPolicies, matchingPolicy],
  series: [...bootstrap.series, series],
  executionClasses: [...bootstrap.executionClasses, executionClass],
  books: [...bootstrap.books, { executionClassId: executionClass.executionClassId, executionClassVersion: 1 }],
});
writeProtocol('api/public-market-support.json', { ...marketSupport, seriesSupport, executionClassSupport });
writeProtocol('api/public-graph-context.json', {
  ...graphContext,
  activeRegistryRecords: [...graphContext.activeRegistryRecords, ...activeRegistryRecords],
  resourceLimits: [...graphContext.resourceLimits, { domainId: domain.domainId, maximumActionsPerTransaction: 8 }],
});
writeFileSync(join(output, 'solana-strategy-activation.json'), `${JSON.stringify({
  version: 1,
  profiles: 1,
  quoteLanes: 1,
  lookupTableAddresses: lookup.value.state.addresses.length,
}, null, 2)}\n`);
