import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  adapterRef,
  assetAmount,
  assetRef,
  domainRef,
  packageGraph,
  packageGraphHash,
  packageTemplateManifest,
  packageTemplateManifestHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  toHex as protocolHex,
  versionedManifestRef,
  type DomainRegistryRecordInput,
  type Hash32,
  type PackageTemplateManifestInput,
} from '@naryx/protocol-types';
import { hexToBytes, type Abi, type Address, type Hex } from 'viem';
import {
  EvmOptionSpreadPreparationContextResolver,
  EvmOptionSpreadProvisioningResolver,
  EvmOptionSpreadProvisioningService,
  GeneralizedStrategyQuoteContextRegistry,
  GeneralizedStrategyQuoteService,
  StrategyPreparationService,
  createEvmOptionSpreadGeneralizedPricing,
  type EvmOptionSpreadPricingInput,
  type EvmOptionSpreadReadPort,
  type StoredStrategyPackageDocuments,
  type StoredStrategyPackageOrderDocuments,
} from '../src/index.js';

const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const codeHash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const hash = (byte: string) => byte.repeat(64);
const evmHash = (byte: string) => `0x${hash(byte)}` as Hex;
const NOW = 1_000n;
const MATURITY = 2_000n;
const QUANTITY = 10n ** 18n;
const OWNER = address('1');
const ACCOUNT = address('2');
const SOLVER = address('3');
const ACCOUNT_FACTORY = address('4');
const LONG_POOL = address('5');
const SHORT_POOL = address('6');
const BASE_TOKEN = address('7');
const QUOTE_TOKEN = address('8');
const ORACLE = address('9');
const LONG_FACTORY = address('a');
const SHORT_FACTORY = address('b');
const LONG_ADAPTER = address('c');
const SHORT_ADAPTER = address('d');

const domain = domainRef('eip155:84532', 1, hash('1'));
const baseAsset = assetRef('base-sepolia:ntbase', hash('2'), 18);
const quoteAsset = assetRef('base-sepolia:ntquote', hash('3'), 6);
const longAdapterRef = adapterRef({ adapterId: 'base-option-long', adapterManifestVersion: 1, adapterManifestHash: hash('4') });
const shortAdapterRef = adapterRef({ adapterId: 'base-option-short', adapterManifestVersion: 1, adapterManifestHash: hash('5') });
const venue = versionedManifestRef('naryx-conformance-options', 1, hash('6'));
const longMarket = versionedManifestRef('ntbase-call-2000', 1, hash('7'));
const shortMarket = versionedManifestRef('ntbase-call-2500', 1, hash('8'));
const templateInput: PackageTemplateManifestInput = {
  manifestVersion: 2,
  environment: 'testnet',
  templateId: 'option-spread-v1',
  templateVersion: 1,
  supportedDomains: [domain],
  orderSchemaHash: hash('9'),
  quoteSchemaHash: hash('a'),
  routeSchemaHash: hash('b'),
  receiptSchemaHash: hash('c'),
  entryCompilerVersion: 1,
  exitCompilerVersion: 1,
  legCount: 2,
  legTypes: ['option-long', 'option-short'],
  supportedDirections: ['LONG_SPOT_SHORT_PERP'],
  supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
  allowedSpotAdapterIds: [],
  allowedPerpAdapterIds: [],
  allowedAdapterIds: [longAdapterRef.adapterId, shortAdapterRef.adapterId],
  riskPolicyHash: hash('d'),
};
const template = packageTemplateManifest(templateInput);
const templateHash = packageTemplateManifestHash(template);

function registry(
  recordKind: DomainRegistryRecordInput['recordKind'],
  subjectId: string,
  subjectManifestHash: Uint8Array | string,
): DomainRegistryRecordInput {
  return {
    recordVersion: 1,
    environment: 'testnet',
    domain,
    recordKind,
    subjectId,
    subjectManifestVersion: 1,
    subjectManifestHash,
    registryState: 'ACTIVE',
    riskLimits: [],
    allowedTemplates: [{ templateId: template.templateId, templateVersion: 1, packageTemplateManifestHash: templateHash }],
    allowedSettlementClasses: ['ATOMIC_POSTCONDITION'],
    activationUnit: 'EVM_UNIX_SECONDS',
    activationValue: 1n,
    governanceReference: 'testnet-governance',
  };
}

const activeRegistryRecords = [
  registry('ASSET', baseAsset.assetId, baseAsset.assetManifestHash),
  registry('ASSET', quoteAsset.assetId, quoteAsset.assetManifestHash),
  registry('ADAPTER', longAdapterRef.adapterId, longAdapterRef.adapterManifestHash),
  registry('ADAPTER', shortAdapterRef.adapterId, shortAdapterRef.adapterManifestHash),
  registry('VENUE', venue.subjectId, venue.manifestHash),
  registry('MARKET', longMarket.subjectId, longMarket.manifestHash),
  registry('MARKET', shortMarket.subjectId, shortMarket.manifestHash),
];

const graph = packageGraph({
  graphVersion: 1,
  environment: 'testnet',
  templateId: template.templateId,
  templateVersion: 1,
  packageTemplateManifestHash: templateHash,
  seriesId: 'ntbase-bull-call',
  seriesVersion: 1,
  seriesManifestHash: hash('e'),
  executionClassId: 'base-option-atomic',
  executionClassVersion: 1,
  executionClassManifestHash: hash('f'),
  lifecycleAction: 'ENTRY',
  owner: OWNER.toLowerCase(),
  strategyAccountRefs: [ACCOUNT.toLowerCase()],
  legs: [{
    legId: 'option-long',
    legFamily: 'OPTION_BUY',
    legTypeId: 'option-long',
    domain,
    adapter: longAdapterRef,
    venue,
    market: longMarket,
    assets: [baseAsset, quoteAsset],
    side: 'BUY',
    quantityAsset: baseAsset,
    quantityAtoms: QUANTITY,
    minimumQuantityAtoms: QUANTITY,
    limitPrice: { baseAsset, quoteAsset, quoteAtoms: 21n, baseAtoms: 100_000_000_000n, roundingDirection: 'CEIL' },
    maximumFeeQuoteAtoms: 0n,
    preconditionHashes: [],
    postconditionHashes: [],
    timeInForce: 'IOC',
    legExpiryValue: 1_200n,
  }, {
    legId: 'option-short',
    legFamily: 'OPTION_MINT',
    legTypeId: 'option-short',
    domain,
    adapter: shortAdapterRef,
    venue,
    market: shortMarket,
    assets: [baseAsset, quoteAsset],
    side: 'SELL',
    quantityAsset: baseAsset,
    quantityAtoms: QUANTITY,
    minimumQuantityAtoms: QUANTITY,
    limitPrice: { baseAsset, quoteAsset, quoteAtoms: 9n, baseAtoms: 100_000_000_000n, roundingDirection: 'FLOOR' },
    maximumFeeQuoteAtoms: 0n,
    preconditionHashes: [],
    postconditionHashes: [],
    timeInForce: 'IOC',
    legExpiryValue: 1_200n,
  }],
  dependencyEdges: [],
  executionGroups: [{ groupId: 'option-spread', kind: 'ALL_OR_NONE', legIds: ['option-long', 'option-short'] }],
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
  quoteConventionId: 'net-premium-greeks-v1',
  riskClassId: 'options-defined-risk-v1',
  owner: OWNER.toLowerCase(),
  settlementAccount: ACCOUNT.toLowerCase(),
  lifecycleAction: 'ENTRY',
  settlementClass: 'ATOMIC_POSTCONDITION',
  packageOrderType: 'MARKETABLE_LIMIT',
  packageTimeInForce: 'IOC',
  economicQuantity: assetAmount(baseAsset, QUANTITY),
  quoteAsset,
  metricLimits: [],
  maximumServiceFeesByAsset: [{ asset: quoteAsset, maxAtoms: 20_000_000n }],
  maximumVenueFeesByAsset: [],
  maximumNetworkFeesByAsset: [{ asset: quoteAsset, maxAtoms: 10_000n }],
  maximumRecoveryCostByAsset: [],
  maximumMarginIncrease: assetAmount(quoteAsset, 2_100_000_000n),
  maximumResidualValue: assetAmount(quoteAsset, 0n),
  expiryUnit: 'EVM_UNIX_SECONDS',
  expiryValue: 1_200n,
  nonce: 1n,
});
const orderHash = strategyPackageOrderHash(order);

class Chain implements EvmOptionSpreadReadPort {
  readonly codes = new Map<string, Hex>([
    [BASE_TOKEN, codeHash('1')], [QUOTE_TOKEN, codeHash('2')], [ORACLE, codeHash('3')],
    [LONG_POOL, codeHash('4')], [SHORT_POOL, codeHash('5')], [ACCOUNT_FACTORY, codeHash('6')],
    [ACCOUNT, codeHash('7')], [LONG_FACTORY, codeHash('8')], [SHORT_FACTORY, codeHash('9')],
    [LONG_ADAPTER, codeHash('a')], [SHORT_ADAPTER, codeHash('b')],
  ]);

  async chainId() { return 84_532n; }
  async latestBlockTimestamp() { return NOW; }
  async codeHash(value: Address) { return this.codes.get(value.toLowerCase()); }

  async readContract(request: Readonly<{ address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }>): Promise<unknown> {
    const target = request.address.toLowerCase();
    if (target === LONG_POOL.toLowerCase() || target === SHORT_POOL.toLowerCase()) {
      const lower = target === LONG_POOL.toLowerCase();
      if (request.functionName === 'getPoolSettings') {
        return [BASE_TOKEN, QUOTE_TOKEN, ORACLE, lower ? 2_000n * 10n ** 18n : 2_500n * 10n ** 18n, MATURITY, true];
      }
      if (request.functionName === 'poolToken') return BASE_TOKEN;
      if (request.functionName === 'premiumBps') return lower ? 1_000n : 500n;
      if (request.functionName === 'balanceOf') return 0n;
    }
    if (target === ACCOUNT_FACTORY.toLowerCase()) {
      if (request.functionName === 'accountOf') return ACCOUNT;
      if (request.functionName === 'isAccount') return true;
      if (request.functionName === 'accountCodeHash') return codeHash('7');
    }
    if (target === ACCOUNT.toLowerCase()) {
      if (request.functionName === 'owner') return OWNER;
      if (request.functionName === 'nextNonce') return 0n;
      if (request.functionName === 'packageState') return [[zeroBytes(), 0, zeroBytes()], zeroBytes(), zeroBytes(), false];
    }
    if (target === LONG_FACTORY.toLowerCase() || target === SHORT_FACTORY.toLowerCase()) {
      if (request.functionName === 'adapterOf') return target === LONG_FACTORY.toLowerCase() ? LONG_ADAPTER : SHORT_ADAPTER;
      if (request.functionName === 'validateInstance') return true;
    }
    throw new Error(`unexpected read ${request.functionName} at ${request.address}`);
  }
}

class ReplayedEntryChain extends Chain {
  override async readContract(
    request: Readonly<{ address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }>,
  ): Promise<unknown> {
    if (request.address.toLowerCase() === ACCOUNT.toLowerCase() && request.functionName === 'packageState') {
      return [[evmHash('1'), 1, evmHash('2')], evmHash('3'), evmHash('4'), true];
    }
    return super.readContract(request);
  }
}

class UndeployedEntryChain extends Chain {
  override async codeHash(value: Address) {
    if ([ACCOUNT, LONG_ADAPTER, SHORT_ADAPTER].some((address) => address.toLowerCase() === value.toLowerCase())) return undefined;
    return super.codeHash(value);
  }

  override async readContract(
    request: Readonly<{ address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }>,
  ): Promise<unknown> {
    if (request.address.toLowerCase() === ACCOUNT_FACTORY.toLowerCase() && request.functionName === 'isAccount') return false;
    if ((request.address.toLowerCase() === LONG_FACTORY.toLowerCase()
      || request.address.toLowerCase() === SHORT_FACTORY.toLowerCase())
      && request.functionName === 'validateInstance') return false;
    return super.readContract(request);
  }
}

function zeroBytes(): Hex {
  return `0x${'00'.repeat(32)}`;
}

function pricing(chain: Chain): EvmOptionSpreadPricingInput {
  return {
    chainId: 84_532n,
    domain,
    baseAsset,
    quoteAsset,
    baseToken: { address: BASE_TOKEN, expectedCodeHash: codeHash('1') },
    quoteToken: { address: QUOTE_TOKEN, expectedCodeHash: codeHash('2') },
    oracle: { address: ORACLE, expectedCodeHash: codeHash('3') },
    pools: [{
      role: 'option-long', adapter: longAdapterRef, venue, market: longMarket,
      pool: { address: LONG_POOL, expectedCodeHash: codeHash('4') },
      expectedStrike: 2_000n * 10n ** 18n, expectedMaturity: MATURITY,
    }, {
      role: 'option-short', adapter: shortAdapterRef, venue, market: shortMarket,
      pool: { address: SHORT_POOL, expectedCodeHash: codeHash('5') },
      expectedStrike: 2_500n * 10n ** 18n, expectedMaturity: MATURITY,
    }],
    referencePriceQuoteAtomsPerWholeBase: 2_000_000_000n,
    strikeDecimals: 18,
    protocolFeeBps: 10,
    solverFeeBps: 5,
    networkFeeQuoteAtoms: 1_000n,
    feePolicyVersion: 1,
    feePolicyManifestHash: hash('7'),
    routeTtlSeconds: 30n,
    quoteTtlSeconds: 60n,
    chain,
    nonceSource: { nextNonce: () => 1n },
  };
}

test('quotes and prepares an exact atomic EVM bull call spread', async () => {
  const chain = new Chain();
  const quotePricing = pricing(chain);
  const orderDocuments: StoredStrategyPackageOrderDocuments = {
    orderHashHex: protocolHex(orderHash),
    graphHashHex: protocolHex(packageGraphHash(graph)),
    order,
    graph,
    recordedAtMs: 1,
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const quoteService = new GeneralizedStrategyQuoteService({
    packages: { getByOrder: async (requested) => protocolHex(requested) === protocolHex(orderHash) ? orderDocuments : undefined },
    contexts: new GeneralizedStrategyQuoteContextRegistry([{
      laneId: 'base-option-spread',
      environment: 'testnet',
      templateManifest: template,
      executionClassId: order.executionClassId,
      executionClassVersion: order.executionClassVersion,
      executionClassManifestHash: order.executionClassManifestHash,
      activeRegistryRecords,
      resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 4 }],
      adapterSupport: [{
        domain, adapter: longAdapterRef, legFamily: 'OPTION_BUY', supportedSides: ['BUY'],
        materializationClassId: 'naryx.evm.premia-v3-option-exact', executionPlanKind: 'EVM_ATOMIC_BATCH',
        supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
      }, {
        domain, adapter: shortAdapterRef, legFamily: 'OPTION_MINT', supportedSides: ['SELL'],
        materializationClassId: 'naryx.evm.premia-v3-option-exact', executionPlanKind: 'EVM_ATOMIC_BATCH',
        supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
      }],
      solverId: 'base-option-solver',
      solverCapabilityManifestHash: hash('8'),
      pricing: createEvmOptionSpreadGeneralizedPricing(quotePricing),
      currentTime: async () => ({ unit: 'EVM_UNIX_SECONDS', value: NOW }),
    }]),
    signer: {
      scheme: 'ED25519',
      verificationKey: Uint8Array.from(spki.subarray(spki.length - 32)),
      signDigest: (digest) => Uint8Array.from(sign(null, digest, privateKey)),
    },
  });
  const quoted = await quoteService.quote({
    orderHash: protocolHex(orderHash),
    idempotencyKey: 'evm-option-spread-quote-0001',
  });
  assert.equal(quoted.quote.metrics.find((metric) => metric.metricId === 'net-premium-atoms')?.value, -100_000_000n);
  assert.equal(quoted.quote.totalMarginDelta.atoms, 2_000_000_000n);
  assert.equal(quoted.quote.netPackageOutcome.atoms, -106_001_000n);

  const documents: StoredStrategyPackageDocuments = {
    ...orderDocuments,
    quoteHashHex: quoted.quoteHash,
    routeHashHex: quoted.routeHash,
    quote: quoted.quote,
    route: quoted.route,
  };
  const quoteHash = hexToBytes(`0x${quoted.quoteHash}`) as Hash32;
  const preparation = new StrategyPreparationService(
    { getByQuote: async (requested) => protocolHex(requested) === quoted.quoteHash ? documents : undefined },
    new EvmOptionSpreadPreparationContextResolver([{
      environment: 'testnet',
      templateManifest: template,
      activeRegistryRecords,
      resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 4 }],
      pricing: quotePricing,
      accountFactory: { address: ACCOUNT_FACTORY, expectedCodeHash: codeHash('6') },
      expectedStrategyAccountCodeHash: codeHash('7'),
      adapters: [{
        role: 'option-long', factory: { address: LONG_FACTORY, expectedCodeHash: codeHash('8') },
        expectedAdapterCodeHash: codeHash('a'), maximumGasLimit: 600_000n,
      }, {
        role: 'option-short', factory: { address: SHORT_FACTORY, expectedCodeHash: codeHash('9') },
        expectedAdapterCodeHash: codeHash('b'), maximumGasLimit: 600_000n,
      }],
      solver: SOLVER,
      packageIds: { resolvePackageId: async () => undefined },
    }]),
  );
  const prepared = await preparation.prepareByQuote(quoteHash);
  assert.equal(prepared?.domains[0]?.kind, 'EVM_MULTI_STRATEGY_ACCOUNT');
  if (prepared?.domains[0]?.kind !== 'EVM_MULTI_STRATEGY_ACCOUNT') throw new Error('missing EVM preparation');
  assert.deepEqual(prepared.domains[0].envelope.calls.map((call) => call.approvalAtoms), [QUANTITY / 10n, QUANTITY]);
  assert.equal(prepared.domains[0].envelope.execution.fees.protocolFeeAtoms, 4_000_000n);
  assert.equal(prepared.domains[0].envelope.execution.fees.solverFeeAtoms, 2_000_000n);
  assert.notEqual(prepared.domains[0].envelope.execution.nextStateHash, zeroBytes());

  const replayChain = new ReplayedEntryChain();
  const replayPricing = pricing(replayChain);
  const replayPreparation = new StrategyPreparationService(
    { getByQuote: async () => documents },
    new EvmOptionSpreadPreparationContextResolver([{
      environment: 'testnet',
      templateManifest: template,
      activeRegistryRecords,
      resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 4 }],
      pricing: replayPricing,
      accountFactory: { address: ACCOUNT_FACTORY, expectedCodeHash: codeHash('6') },
      expectedStrategyAccountCodeHash: codeHash('7'),
      adapters: [{
        role: 'option-long', factory: { address: LONG_FACTORY, expectedCodeHash: codeHash('8') },
        expectedAdapterCodeHash: codeHash('a'), maximumGasLimit: 600_000n,
      }, {
        role: 'option-short', factory: { address: SHORT_FACTORY, expectedCodeHash: codeHash('9') },
        expectedAdapterCodeHash: codeHash('b'), maximumGasLimit: 600_000n,
      }],
      solver: SOLVER,
      packageIds: { resolvePackageId: async () => undefined },
    }]),
  );
  await assert.rejects(
    () => replayPreparation.prepareDocuments(documents),
    /entry package identity is already active/,
  );
});

test('prepares account and package adapter creation before option entry', async () => {
  const chain = new UndeployedEntryChain();
  const lane = {
    environment: 'testnet' as const,
    templateManifest: template,
    activeRegistryRecords,
    resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 4 }],
    pricing: pricing(chain),
    accountFactory: { address: ACCOUNT_FACTORY, expectedCodeHash: codeHash('6') },
    expectedStrategyAccountCodeHash: codeHash('7'),
    adapters: [{
      role: 'option-long' as const,
      factory: { address: LONG_FACTORY, expectedCodeHash: codeHash('8') },
      expectedAdapterCodeHash: codeHash('a'),
      maximumGasLimit: 600_000n,
    }, {
      role: 'option-short' as const,
      factory: { address: SHORT_FACTORY, expectedCodeHash: codeHash('9') },
      expectedAdapterCodeHash: codeHash('b'),
      maximumGasLimit: 600_000n,
    }] as const,
    solver: SOLVER,
    packageIds: { resolvePackageId: async () => undefined },
  };
  const documents: StoredStrategyPackageOrderDocuments = {
    orderHashHex: protocolHex(orderHash),
    graphHashHex: protocolHex(packageGraphHash(graph)),
    order,
    graph,
    recordedAtMs: 1,
  };
  const resolver = new EvmOptionSpreadProvisioningResolver([lane]);
  const resolved = await resolver.resolveAccount({ chainId: 84_532, factory: ACCOUNT_FACTORY, owner: OWNER });
  assert.equal(resolved.account, ACCOUNT);
  assert.equal(resolved.deployed, false);
  const service = new EvmOptionSpreadProvisioningService(
    { getByOrder: async (requested) => protocolHex(requested) === protocolHex(orderHash) ? documents : undefined },
    resolver,
  );
  const plan = await service.provisionByOrder(orderHash);
  assert.equal(plan?.packageId, `0x${protocolHex(orderHash)}`);
  assert.deepEqual(plan?.transactions.map((transaction) => transaction.kind), [
    'CREATE_STRATEGY_ACCOUNT',
    'CREATE_PACKAGE_ADAPTER',
    'CREATE_PACKAGE_ADAPTER',
  ]);
  assert.equal(plan?.ready, false);
});
